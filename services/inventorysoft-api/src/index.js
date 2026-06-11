const path = require("path");
const express = require("express");
const swaggerUi = require("swagger-ui-express");
const YAML = require("yamljs");
const { v4: uuidv4 } = require("uuid");

const { query, waitForDb } = require("./db");
const { startWorker } = require("./worker");

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
  if (req.path === "/health" || req.path.startsWith("/docs") || req.path === "/openapi.yaml") {
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
  const { operatorDirection, operatorMagnitude, organizationId } = req.body || {};

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

  res.json({
    itemId,
    organizationId,
    previousStock: current,
    newStock,
    operatorDirection,
    operatorMagnitude,
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

  res.json({
    organizationId,
    organizationName: org.rows[0].name,
    bucketMinutes,
    points: rows.rows.map((r) => ({
      t: r.bucket,
      totalStock: Number(r.total_stock),
      unitsSold: Number(r.units_sold),
    })),
  });
});

app.use((_req, res) => res.status(404).json({ error: "Endpoint not found." }));

// ─── Boot ───────────────────────────────────────────────────────────────────
(async () => {
  await waitForDb();
  startWorker();
  app.listen(PORT, () => {
    console.log(`\n✅  InventorySoft API running at http://localhost:${PORT}`);
    console.log(`   Swagger UI:  http://localhost:${PORT}/docs`);
    console.log(`   Health:      http://localhost:${PORT}/health\n`);
  });
})();
