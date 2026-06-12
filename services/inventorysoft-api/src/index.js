const path = require("path");
const express = require("express");
const swaggerUi = require("swagger-ui-express");
const YAML = require("yamljs");
const { v4: uuidv4 } = require("uuid");

const { query, waitForDb, ensureSchema } = require("./db");
const { startWorker } = require("./worker");
const { evaluateAdjustment } = require("./risk");
const { runScenario } = require("./scenario");
const { bus, publish } = require("./bus");

const PORT = parseInt(process.env.PORT || "3001", 10);
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT || "25", 10);

const app = express();
app.use(express.json());

// ─── CORS (open, for the storefront / Swagger try-it-out) ───────────────────
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ─── Rate limiting: 25 requests/second across all endpoints (returns 429) ───
// Skips /health and /docs so probes & docs stay reachable under load.
let requestsThisSecond = 0;
setInterval(() => { requestsThisSecond = 0; }, 1000);
app.use((req, res, next) => {
  if (req.path === "/health" || req.path.startsWith("/docs") || req.path === "/openapi.yaml" || req.path === "/stream") {
    return next();
  }
  requestsThisSecond++;
  if (requestsThisSecond > RATE_LIMIT) {
    res.set("Retry-After", "1");
    return res.status(429).json({ error: "Rate limit exceeded. Max 25 requests/second." });
  }
  next();
});

// Request log
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─── Swagger UI ─────────────────────────────────────────────────────────────
const openapiDoc = YAML.load(path.join(__dirname, "..", "openapi.yaml"));
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapiDoc, {
  customSiteTitle: "InventorySoft API Docs",
}));
app.get("/openapi.yaml", (_req, res) => res.sendFile(path.join(__dirname, "..", "openapi.yaml")));

// ─── Health ─────────────────────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  try {
    await query("SELECT 1");
    res.json({ status: "ok", db: "connected" });
  } catch {
    res.status(503).json({ status: "degraded", db: "unavailable" });
  }
});

// ─── GET /item/:id ──────────────────────────────────────────────────────────
app.get("/item/:itemId", async (req, res) => {
  const { itemId } = req.params;
  const item = await query("SELECT id, name, price FROM items WHERE id = $1", [itemId]);
  if (item.rowCount === 0) return res.status(404).json({ error: `Item ${itemId} not found.` });

  const stocks = await query(
    "SELECT organization_id, stock FROM inventory WHERE item_id = $1",
    [itemId]
  );
  const stockByOrg = {};
  let totalStock = 0;
  for (const row of stocks.rows) {
    stockByOrg[row.organization_id] = row.stock;
    totalStock += row.stock;
  }
  res.json({
    itemId,
    name: item.rows[0].name,
    price: Number(item.rows[0].price),
    totalStock,
    stockByOrg,
  });
});

// ─── GET /organization/:id ──────────────────────────────────────────────────
app.get("/organization/:organizationId", async (req, res) => {
  const { organizationId } = req.params;
  const org = await query("SELECT id, name FROM organizations WHERE id = $1", [organizationId]);
  if (org.rowCount === 0) {
    return res.status(404).json({ error: `Organization ${organizationId} not found.` });
  }
  const items = await query(
    `SELECT i.id AS "itemId", i.name, i.price, inv.stock
       FROM inventory inv
       JOIN items i ON i.id = inv.item_id
      WHERE inv.organization_id = $1
      ORDER BY i.id`,
    [organizationId]
  );
  res.json({
    organizationId,
    organizationName: org.rows[0].name,
    items: items.rows.map((r) => ({ ...r, price: Number(r.price) })),
  });
});

// ─── POST /admin/:id  (synchronous restock / shrinkage) ─────────────────────
app.post("/admin/:itemId", async (req, res) => {
  const { itemId } = req.params;
  const { operatorDirection, operatorMagnitude, organizationId, resolveAlertId } = req.body || {};

  if (!["INCREASE", "DECREASE"].includes(operatorDirection)) {
    return res.status(400).json({ error: "operatorDirection must be 'INCREASE' or 'DECREASE'." });
  }
  if (typeof operatorMagnitude !== "number" || operatorMagnitude <= 0 || !Number.isInteger(operatorMagnitude)) {
    return res.status(400).json({ error: "operatorMagnitude must be a positive integer." });
  }
  const org = await query("SELECT id FROM organizations WHERE id = $1", [organizationId]);
  if (org.rowCount === 0) {
    return res.status(400).json({ error: `organizationId '${organizationId}' is invalid.` });
  }
  const item = await query("SELECT id FROM items WHERE id = $1", [itemId]);
  if (item.rowCount === 0) return res.status(404).json({ error: `Item ${itemId} not found.` });

  const inv = await query(
    "SELECT stock FROM inventory WHERE item_id = $1 AND organization_id = $2",
    [itemId, organizationId]
  );
  const current = inv.rowCount ? inv.rows[0].stock : 0;
  const delta = operatorDirection === "INCREASE" ? operatorMagnitude : -operatorMagnitude;
  const newStock = current + delta;

  if (newStock < 0) {
    return res.status(409).json({
      error: `Cannot decrease by ${operatorMagnitude}. Only ${current} in stock.`,
    });
  }

  await query(
    `INSERT INTO inventory (item_id, organization_id, stock)
     VALUES ($1, $2, $3)
     ON CONFLICT (item_id, organization_id) DO UPDATE SET stock = $3`,
    [itemId, organizationId, newStock]
  );
  await query(
    `INSERT INTO inventory_ledger (item_id, organization_id, delta, reason, balance)
     VALUES ($1, $2, $3, $4, $5)`,
    [itemId, organizationId, delta, operatorDirection === "INCREASE" ? "RESTOCK" : "ADJUST", newStock]
  );

  // Risk monitoring: flag large manual decreases (shrinkage) for review.
  evaluateAdjustment({ itemId, organizationId, direction: operatorDirection, magnitude: operatorMagnitude });

  // Restock-driven incident resolution. Two distinct paths, both audit-noted and
  // id-preserving (the row stays on record; only status/resolution change):
  //   1. EXPLICIT — when the operator restocks *from a specific incident card*
  //      (resolveAlertId), that one incident is resolved regardless of rule,
  //      because a human deliberately chose to remediate it.
  //   2. HEURISTIC — for any restock, OVERSELL_ATTEMPT (phantom-inventory /
  //      out-of-stock) alerts for the item/org are auto-resolved, since a restock
  //      genuinely fixes a stock-out. Velocity spikes and shrinkage stay open.
  let resolvedAlerts = [];
  if (operatorDirection === "INCREASE") {
    const seen = new Set();
    if (resolveAlertId !== undefined && resolveAlertId !== null && String(resolveAlertId).trim() !== "") {
      const ex = await query(
        `UPDATE risk_alerts
            SET status = 'RESOLVED', resolved_at = now(),
                resolution = 'Resolved by restock +' || $4 || ' from incident card on ' || to_char(now(), 'YYYY-MM-DD HH24:MI')
          WHERE id = $1 AND item_id = $2 AND organization_id = $3 AND status <> 'RESOLVED'
          RETURNING id`,
        [resolveAlertId, itemId, organizationId, operatorMagnitude]
      );
      for (const x of ex.rows) { seen.add(String(x.id)); }
    }
    const r = await query(
      `UPDATE risk_alerts
          SET status = 'RESOLVED', resolved_at = now(),
              resolution = 'Auto-resolved by restock +' || $3 || ' on ' || to_char(now(), 'YYYY-MM-DD HH24:MI')
        WHERE item_id = $1 AND organization_id = $2
          AND status <> 'RESOLVED' AND rule = 'OVERSELL_ATTEMPT'
        RETURNING id`,
      [itemId, organizationId, operatorMagnitude]
    );
    for (const x of r.rows) { seen.add(String(x.id)); }
    resolvedAlerts = [...seen];
    if (resolvedAlerts.length) {
      console.log(`[risk] restock resolved incident(s) ${resolvedAlerts.join(", ")} for item ${itemId}`);
    }
  }

  // Real-time fan-out: stock changed, and any incidents this restock closed.
  publish({ type: "stock", itemId, organizationId, newStock, operatorDirection });
  if (resolvedAlerts.length) publish({ type: "alert-resolved", ids: resolvedAlerts, itemId, organizationId });

  res.json({
    itemId,
    organizationId,
    previousStock: current,
    newStock,
    operatorDirection,
    operatorMagnitude,
    resolvedAlerts,
  });
});

// ─── POST /item/:id  (asynchronous sale) ────────────────────────────────────
app.post("/item/:itemId", async (req, res) => {
  const { itemId } = req.params;
  const { organizationId } = req.body || {};
  const idempotencyKey = req.get("Idempotency-Key") || null;

  const item = await query("SELECT id FROM items WHERE id = $1", [itemId]);
  if (item.rowCount === 0) return res.status(404).json({ error: `Item ${itemId} not found.` });

  const org = await query("SELECT id FROM organizations WHERE id = $1", [organizationId]);
  if (org.rowCount === 0) {
    return res.status(400).json({ error: `organizationId '${organizationId}' is invalid.` });
  }

  // Idempotency: a retried request with the same key returns the original event.
  if (idempotencyKey) {
    const existing = await query(
      "SELECT event_id FROM sale_events WHERE idempotency_key = $1",
      [idempotencyKey]
    );
    if (existing.rowCount) {
      return res.status(202).json({ eventId: existing.rows[0].event_id, deduplicated: true });
    }
  }

  const eventId = uuidv4();
  await query(
    `INSERT INTO sale_events (event_id, item_id, organization_id, status, idempotency_key)
     VALUES ($1, $2, $3, 'PENDING', $4)`,
    [eventId, itemId, organizationId, idempotencyKey]
  );

  res.status(202).json({ eventId });
});

// ─── GET /events/:eventId ───────────────────────────────────────────────────
app.get("/events/:eventId", async (req, res) => {
  const r = await query(
    `SELECT status, item_id AS "itemId", organization_id AS "organizationId",
            processed_at AS "processedAt", reason
       FROM sale_events WHERE event_id = $1`,
    [req.params.eventId]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: "Event not found." });
  res.json(r.rows[0]);
});

// ─── GET /analytics/organization/:id/timeseries ─────────────────────────────
app.get("/analytics/organization/:organizationId/timeseries", async (req, res) => {
  const { organizationId } = req.params;
  const bucketMinutes = Math.max(1, parseInt(req.query.bucketMinutes || "5", 10));

  const org = await query("SELECT id, name FROM organizations WHERE id = $1", [organizationId]);
  if (org.rowCount === 0) {
    return res.status(404).json({ error: `Organization ${organizationId} not found.` });
  }

  // Aggregate ledger movements into time buckets: running total stock + units sold.
  const rows = await query(
    `WITH bucketed AS (
       SELECT to_timestamp(floor(extract(epoch FROM created_at) / ($2 * 60)) * ($2 * 60)) AS bucket,
              SUM(delta) AS net_delta,
              SUM(CASE WHEN reason = 'SALE' THEN 1 ELSE 0 END) AS units_sold
         FROM inventory_ledger
        WHERE organization_id = $1
        GROUP BY bucket
     )
     SELECT bucket,
            SUM(net_delta) OVER (ORDER BY bucket) AS total_stock,
            units_sold
       FROM bucketed
      ORDER BY bucket`,
    [organizationId, bucketMinutes]
  );

  // Per-item sales per bucket, so the UI can show *which* items sold in each interval.
  const breakdown = await query(
    `SELECT to_timestamp(floor(extract(epoch FROM l.created_at) / ($2 * 60)) * ($2 * 60)) AS bucket,
            i.name AS item_name,
            COUNT(*)::int AS units
       FROM inventory_ledger l
       JOIN items i ON i.id = l.item_id
      WHERE l.organization_id = $1 AND l.reason = 'SALE'
      GROUP BY bucket, i.name
      ORDER BY bucket, units DESC`,
    [organizationId, bucketMinutes]
  );
  const soldByBucket = {};
  for (const r of breakdown.rows) {
    const key = new Date(r.bucket).toISOString();
    (soldByBucket[key] = soldByBucket[key] || []).push({ name: r.item_name, units: Number(r.units) });
  }

  res.json({
    organizationId,
    organizationName: org.rows[0].name,
    bucketMinutes,
    points: rows.rows.map((r) => ({
      t: r.bucket,
      totalStock: Number(r.total_stock),
      unitsSold: Number(r.units_sold),
      soldByItem: soldByBucket[new Date(r.bucket).toISOString()] || [],
    })),
  });
});

// ─── GET /alerts  (real-time risk / loss-prevention feed) ───────────────────
app.get("/alerts", async (req, res) => {
  const { organizationId, status, severity } = req.query;
  // view scopes by lifecycle: active = OPEN+ACK (default queue), resolved, or all.
  const view = ["active", "resolved", "all"].includes(req.query.view) ? req.query.view : "all";
  const viewClause = (alias) =>
    view === "active" ? `${alias}.status <> 'RESOLVED'`
    : view === "resolved" ? `${alias}.status = 'RESOLVED'`
    : null;
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || "50", 10)));
  const where = [];
  const params = [];
  if (organizationId) { params.push(organizationId); where.push(`ra.organization_id = $${params.length}`); }
  if (status) { params.push(status); where.push(`ra.status = $${params.length}`); }
  if (severity) { params.push(severity); where.push(`ra.severity = $${params.length}`); }
  const vc = viewClause("ra");
  if (vc) where.push(vc);
  params.push(limit);
  const rows = await query(
    `SELECT ra.id, ra.item_id AS "itemId", i.name AS "itemName",
            ra.organization_id AS "organizationId", o.name AS "organizationName",
            ra.event_id AS "eventId", ra.rule, ra.severity, ra.score, ra.detail,
            ra.status, ra.resolution, ra.resolved_at AS "resolvedAt", ra.created_at AS "createdAt"
       FROM risk_alerts ra
       LEFT JOIN items i ON i.id = ra.item_id
       LEFT JOIN organizations o ON o.id = ra.organization_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY ra.created_at DESC
      LIMIT $${params.length}`,
    params
  );
  // Summary counts share the org + view scope (but ignore the severity filter,
  // so the pills always show how many of each severity exist in the view).
  const cWhere = [];
  const cParams = [];
  if (organizationId) { cParams.push(organizationId); cWhere.push(`organization_id = $${cParams.length}`); }
  const cvc = viewClause("risk_alerts");
  if (cvc) cWhere.push(cvc);
  const counts = await query(
    `SELECT severity, COUNT(*)::int AS n FROM risk_alerts
      ${cWhere.length ? "WHERE " + cWhere.join(" AND ") : ""}
      GROUP BY severity`,
    cParams
  );
  const summary = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const c of counts.rows) summary[c.severity] = c.n;
  res.json({ summary, alerts: rows.rows });
});

// ─── POST /alerts/:id  (case management: acknowledge / resolve) ─────────────
app.post("/alerts/:id", async (req, res) => {
  const { id } = req.params;
  const { status, resolution } = req.body || {};
  if (!["OPEN", "ACK", "RESOLVED"].includes(status)) {
    return res.status(400).json({ error: "status must be OPEN, ACK, or RESOLVED." });
  }
  const isResolved = status === "RESOLVED";
  const note = isResolved ? (resolution || "Manually resolved") : null;
  const upd = await query(
    `UPDATE risk_alerts
        SET status = $1,
            resolved_at = CASE WHEN $1 = 'RESOLVED' THEN now() ELSE NULL END,
            resolution = CASE WHEN $1 = 'RESOLVED' THEN $3 ELSE NULL END
      WHERE id = $2 RETURNING id`,
    [status, id, note]
  );
  if (upd.rowCount === 0) return res.status(404).json({ error: "Alert not found." });
  const r = await query(
    `SELECT ra.id, ra.item_id AS "itemId", i.name AS "itemName",
            ra.organization_id AS "organizationId", o.name AS "organizationName",
            ra.event_id AS "eventId", ra.rule, ra.severity, ra.score, ra.detail,
            ra.status, ra.resolution, ra.resolved_at AS "resolvedAt", ra.created_at AS "createdAt"
       FROM risk_alerts ra
       LEFT JOIN items i ON i.id = ra.item_id
       LEFT JOIN organizations o ON o.id = ra.organization_id
      WHERE ra.id = $1`,
    [id]
  );
  publish({ type: "alert-update", id: String(id), status });
  res.json(r.rows[0]);
});

// ─── POST /demo/scenario  (deterministic one-click loss-prevention storylines) ─
app.post("/demo/scenario", async (req, res) => {
  const { type, organizationId } = req.body || {};
  try {
    const out = await runScenario(type, organizationId);
    res.json(out);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "Scenario failed." });
  }
});

// ─── GET /alerts/:id/timeline  (case detail: incident + ledger + event trail) ─
app.get("/alerts/:id/timeline", async (req, res) => {
  const { id } = req.params;
  const a = await query(
    `SELECT ra.id, ra.item_id AS "itemId", i.name AS "itemName",
            ra.organization_id AS "organizationId", o.name AS "organizationName",
            ra.event_id AS "eventId", ra.rule, ra.severity, ra.score, ra.detail,
            ra.status, ra.resolution, ra.resolved_at AS "resolvedAt", ra.created_at AS "createdAt"
       FROM risk_alerts ra
       LEFT JOIN items i ON i.id = ra.item_id
       LEFT JOIN organizations o ON o.id = ra.organization_id
      WHERE ra.id = $1`,
    [id]
  );
  if (a.rowCount === 0) return res.status(404).json({ error: "Alert not found." });
  const alert = a.rows[0];

  // Ledger movements for this item/org in a window around the incident — the
  // evidence behind the score (the append-only ledger is the audit trail).
  const ledger = alert.itemId
    ? await query(
        `SELECT id, delta, reason, balance, created_at AS "createdAt"
           FROM inventory_ledger
          WHERE item_id = $1 AND organization_id = $2
            AND created_at BETWEEN $3::timestamptz - interval '5 minutes'
                              AND COALESCE($4::timestamptz, now()) + interval '1 minute'
          ORDER BY created_at DESC, id DESC
          LIMIT 100`,
        [alert.itemId, alert.organizationId, alert.createdAt, alert.resolvedAt]
      )
    : { rows: [] };

  // Reconstructed case timeline from the fields we retain (raised → resolved).
  const timeline = [
    { ts: alert.createdAt, event: "RAISED", detail: `${alert.rule} (${alert.severity}, score ${alert.score}) — ${alert.detail}` },
  ];
  if (alert.status === "ACK") timeline.push({ ts: alert.createdAt, event: "ACKNOWLEDGED", detail: "Analyst acknowledged the incident." });
  if (alert.status === "RESOLVED") {
    timeline.push({ ts: alert.resolvedAt, event: "RESOLVED", detail: alert.resolution || "Resolved." });
  }

  res.json({ alert, timeline, ledger: ledger.rows });
});

// ─── GET /stream  (Server-Sent Events: live sales, stock, and alerts) ───────
app.get("/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  res.write(`event: ready\ndata: {"ok":true}\n\n`);

  const onEvent = (payload) => {
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* client gone */ }
  };
  bus.on("event", onEvent);

  // Heartbeat keeps proxies/load balancers from closing an idle connection.
  const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25000);

  req.on("close", () => {
    clearInterval(hb);
    bus.off("event", onEvent);
  });
});

app.use((_req, res) => res.status(404).json({ error: "Endpoint not found." }));

// ─── Boot ───────────────────────────────────────────────────────────────────
(async () => {
  await waitForDb();
  await ensureSchema();
  startWorker();
  app.listen(PORT, () => {
    console.log(`\n✅  InventorySoft API running at http://localhost:${PORT}`);
    console.log(`   Swagger UI:  http://localhost:${PORT}/docs`);
    console.log(`   Health:      http://localhost:${PORT}/health\n`);
  });
})();
