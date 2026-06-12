// Real-time inventory risk / loss-prevention rule engine.
//
// This is the demo's analog of a transaction-monitoring system: every stock
// movement (async sale or manual admin adjustment) is scored against a small
// set of configurable rules, and anything anomalous is written to risk_alerts
// for triage. The append-only inventory_ledger is the backing audit trail.
//
// In production this logic would run as a stream consumer (e.g. Kinesis/Lambda)
// fed by the same event queue, emitting alerts to SNS/EventBridge.

const { query } = require("./db");
const { publish } = require("./bus");

// ─── Configurable thresholds (env-overridable) ──────────────────────────────
const VELOCITY_WINDOW_SEC = parseInt(process.env.RISK_VELOCITY_WINDOW_SEC || "60", 10);
const VELOCITY_THRESHOLD = parseInt(process.env.RISK_VELOCITY_THRESHOLD || "25", 10);
const SHRINKAGE_MAGNITUDE = parseInt(process.env.RISK_SHRINKAGE_MAGNITUDE || "25", 10);
const DEDUPE_WINDOW_SEC = parseInt(process.env.RISK_DEDUPE_WINDOW_SEC || "30", 10);

async function recentlyAlerted(rule, itemId, organizationId) {
  const r = await query(
    `SELECT 1 FROM risk_alerts
      WHERE rule = $1 AND item_id IS NOT DISTINCT FROM $2
        AND organization_id IS NOT DISTINCT FROM $3
        AND created_at > now() - ($4 || ' seconds')::interval
      LIMIT 1`,
    [rule, itemId, organizationId, DEDUPE_WINDOW_SEC]
  );
  return r.rowCount > 0;
}

async function recordAlert({ itemId, organizationId, eventId, rule, severity, score, detail }) {
  const r = await query(
    `INSERT INTO risk_alerts (item_id, organization_id, event_id, rule, severity, score, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [itemId || null, organizationId || null, eventId || null, rule, severity, score, detail]
  );
  console.log(`[risk] ${severity} ${rule} item=${itemId} org=${organizationId} score=${score}`);
  // Real-time fan-out so dashboards light up the instant an alert fires.
  publish({ type: "alert", id: String(r.rows[0].id), rule, severity, score, itemId, organizationId });
  return String(r.rows[0].id);
}

// Rule 1: sale-velocity spike — an unusual burst of sales for one item/org.
async function evaluateSale({ itemId, organizationId, eventId }) {
  try {
    const r = await query(
      `SELECT COUNT(*)::int AS n FROM sale_events
        WHERE item_id = $1 AND organization_id = $2 AND status = 'COMPLETED'
          AND processed_at > now() - ($3 || ' seconds')::interval`,
      [itemId, organizationId, VELOCITY_WINDOW_SEC]
    );
    const n = r.rows[0].n;
    if (n < VELOCITY_THRESHOLD) return null;
    if (await recentlyAlerted("SALE_VELOCITY", itemId, organizationId)) return null;
    const severity = n >= VELOCITY_THRESHOLD * 2 ? "HIGH" : "MEDIUM";
    const score = Math.min(100, 50 + (n - VELOCITY_THRESHOLD));
    return await recordAlert({
      itemId, organizationId, eventId, rule: "SALE_VELOCITY", severity, score,
      detail: `${n} sales of this item in the last ${VELOCITY_WINDOW_SEC}s (threshold ${VELOCITY_THRESHOLD}) — possible scan abuse or coordinated checkout.`,
    });
  } catch (e) { console.error("[risk] evaluateSale", e.message); return null; }
}

// Rule 2: oversell / phantom-inventory attempt — a sale failed for lack of stock.
async function evaluateFailedSale({ itemId, organizationId, eventId }) {
  try {
    if (await recentlyAlerted("OVERSELL_ATTEMPT", itemId, organizationId)) return null;
    return await recordAlert({
      itemId, organizationId, eventId, rule: "OVERSELL_ATTEMPT", severity: "MEDIUM", score: 60,
      detail: "Sale attempted on out-of-stock item — possible phantom inventory or theft (record exists but stock is gone).",
    });
  } catch (e) { console.error("[risk] evaluateFailedSale", e.message); return null; }
}

// Rule 3: large manual shrinkage — a big admin DECREASE worth reviewing.
async function evaluateAdjustment({ itemId, organizationId, direction, magnitude }) {
  try {
    if (direction !== "DECREASE" || magnitude < SHRINKAGE_MAGNITUDE) return null;
    const severity = magnitude >= SHRINKAGE_MAGNITUDE * 4 ? "HIGH" : "MEDIUM";
    const score = Math.min(100, 40 + magnitude);
    return await recordAlert({
      itemId, organizationId, rule: "LARGE_SHRINKAGE", severity, score,
      detail: `Manual stock DECREASE of ${magnitude} units (threshold ${SHRINKAGE_MAGNITUDE}) — large shrinkage/adjustment flagged for review.`,
    });
  } catch (e) { console.error("[risk] evaluateAdjustment", e.message); return null; }
}

module.exports = { evaluateSale, evaluateFailedSale, evaluateAdjustment };
