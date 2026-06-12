// Deterministic demo scenarios — one-click loss-prevention storylines.
//
// Each scenario performs the minimal real work needed to reliably trip exactly
// one risk rule, so a live demo never depends on hand-timed bursts. They write
// through the same tables and call the same risk evaluators as organic traffic,
// so what the panel sees is genuine detection — just scripted to fire on cue.

const { v4: uuidv4 } = require("uuid");
const { query } = require("./db");
const { publish } = require("./bus");
const { evaluateSale, evaluateFailedSale, evaluateAdjustment } = require("./risk");

const VELOCITY_BURST = parseInt(process.env.SCENARIO_VELOCITY_BURST || "55", 10); // ≥2× threshold → HIGH
const SHRINKAGE_UNITS = parseInt(process.env.SCENARIO_SHRINKAGE_UNITS || "120", 10); // ≥4× threshold → HIGH

async function itemMeta(itemId) {
  const r = await query("SELECT name FROM items WHERE id = $1", [itemId]);
  return r.rowCount ? r.rows[0].name : `Item ${itemId}`;
}

// Pick an item present in the org. order 'DESC' = most stock (room to sell/adjust),
// 'ASC' = least stock (most plausible to be out for a phantom-inventory story).
async function pickItem(org, order) {
  const dir = order === "ASC" ? "ASC" : "DESC";
  const r = await query(
    `SELECT item_id, stock FROM inventory WHERE organization_id = $1 ORDER BY stock ${dir} LIMIT 1`,
    [org]
  );
  if (!r.rowCount) throw httpError(400, `No inventory found for organization ${org}.`);
  return r.rows[0];
}

function httpError(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

async function ensureRoom(itemId, org, need) {
  const inv = await query(
    "SELECT stock FROM inventory WHERE item_id = $1 AND organization_id = $2",
    [itemId, org]
  );
  const stock = inv.rowCount ? inv.rows[0].stock : 0;
  if (stock >= need) return stock;
  const top = need - stock + 5;
  const after = await query(
    `INSERT INTO inventory (item_id, organization_id, stock) VALUES ($1, $2, $3)
       ON CONFLICT (item_id, organization_id) DO UPDATE SET stock = inventory.stock + $3
     RETURNING stock`,
    [itemId, org, top]
  );
  await query(
    `INSERT INTO inventory_ledger (item_id, organization_id, delta, reason, balance)
     VALUES ($1, $2, $3, 'RESTOCK', $4)`,
    [itemId, org, top, after.rows[0].stock]
  );
  return after.rows[0].stock;
}

// SALE_VELOCITY — a burst of completed sales on one item (scan abuse / coordinated checkout).
async function scenarioVelocity(org) {
  const { item_id: itemId } = await pickItem(org, "DESC");
  await ensureRoom(itemId, org, VELOCITY_BURST);
  const ids = Array.from({ length: VELOCITY_BURST }, () => uuidv4());
  await query(
    `INSERT INTO sale_events (event_id, item_id, organization_id, status, processed_at)
     SELECT u::uuid, $2, $3, 'COMPLETED', now() FROM unnest($1::text[]) AS u`,
    [ids, itemId, org]
  );
  // Reflect the burst in inventory + ledger so the day chart's "units sold" moves too.
  const after = await query(
    `UPDATE inventory SET stock = GREATEST(0, stock - $1)
      WHERE item_id = $2 AND organization_id = $3 RETURNING stock`,
    [VELOCITY_BURST, itemId, org]
  );
  await query(
    `INSERT INTO inventory_ledger (item_id, organization_id, delta, reason, balance)
     SELECT $1, $2, -1, 'SALE', $4 + g FROM generate_series(1, $3) AS g`,
    [itemId, org, VELOCITY_BURST, after.rows[0].stock]
  );
  const alertId = await evaluateSale({ itemId, organizationId: org });
  publish({ type: "stock", itemId, organizationId: org, newStock: after.rows[0].stock });
  return { scenario: "velocity", itemId, itemName: await itemMeta(itemId), organizationId: org, count: VELOCITY_BURST, alertId };
}

// OVERSELL_ATTEMPT — a sale attempted on an out-of-stock item (phantom inventory / theft).
async function scenarioPhantom(org) {
  const { item_id: itemId } = await pickItem(org, "ASC");
  const eventId = uuidv4();
  await query(
    `INSERT INTO sale_events (event_id, item_id, organization_id, status, reason, processed_at)
     VALUES ($1, $2, $3, 'FAILED', 'INSUFFICIENT_STOCK', now())`,
    [eventId, itemId, org]
  );
  publish({ type: "sale", status: "FAILED", itemId, organizationId: org, eventId });
  const alertId = await evaluateFailedSale({ itemId, organizationId: org, eventId });
  return { scenario: "phantom", itemId, itemName: await itemMeta(itemId), organizationId: org, alertId };
}

// LARGE_SHRINKAGE — a big manual write-down (insider shrinkage / adjustment).
async function scenarioShrinkage(org) {
  const { item_id: itemId } = await pickItem(org, "DESC");
  await ensureRoom(itemId, org, SHRINKAGE_UNITS);
  const after = await query(
    `UPDATE inventory SET stock = stock - $1
      WHERE item_id = $2 AND organization_id = $3 RETURNING stock`,
    [SHRINKAGE_UNITS, itemId, org]
  );
  await query(
    `INSERT INTO inventory_ledger (item_id, organization_id, delta, reason, balance)
     VALUES ($1, $2, $3, 'ADJUST', $4)`,
    [itemId, org, -SHRINKAGE_UNITS, after.rows[0].stock]
  );
  const alertId = await evaluateAdjustment({ itemId, organizationId: org, direction: "DECREASE", magnitude: SHRINKAGE_UNITS });
  publish({ type: "stock", itemId, organizationId: org, newStock: after.rows[0].stock });
  return { scenario: "shrinkage", itemId, itemName: await itemMeta(itemId), organizationId: org, magnitude: SHRINKAGE_UNITS, alertId };
}

const SCENARIOS = {
  velocity: scenarioVelocity,
  phantom: scenarioPhantom,
  shrinkage: scenarioShrinkage,
};

async function runScenario(type, organizationId) {
  const fn = SCENARIOS[type];
  if (!fn) throw httpError(400, `Unknown scenario '${type}'. Use one of: ${Object.keys(SCENARIOS).join(", ")}.`);
  if (!organizationId) throw httpError(400, "organizationId is required.");
  const org = await query("SELECT id FROM organizations WHERE id = $1", [organizationId]);
  if (org.rowCount === 0) throw httpError(400, `organizationId '${organizationId}' is invalid.`);
  const result = await fn(String(organizationId));
  return {
    ...result,
    deduped: !result.alertId, // a recent identical alert suppressed a duplicate
  };
}

module.exports = { runScenario };
