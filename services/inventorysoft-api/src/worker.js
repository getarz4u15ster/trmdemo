const { pool } = require("./db");
const { evaluateSale, evaluateFailedSale } = require("./risk");
const { publish } = require("./bus");

// Background worker that drains the async sale queue.
//
// This is the local stand-in for what would be an SQS consumer / Lambda in the
// customer's AWS environment. POST /item/:id only *enqueues* a PENDING event;
// this loop processes them with a small artificial delay so the async behaviour
// (and the brief inventory lag the customer asked about) is observable.

const PROCESS_DELAY_MS = 500; // only touch events older than this — simulates work
const POLL_INTERVAL_MS = 250;

async function processOnce() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Claim a single PENDING event old enough to process. SKIP LOCKED lets us
    // safely run multiple worker replicas without double-processing.
    const claimed = await client.query(
      `SELECT event_id, item_id, organization_id
         FROM sale_events
        WHERE status = 'PENDING'
          AND created_at <= now() - ($1 || ' milliseconds')::interval
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      [PROCESS_DELAY_MS]
    );

    if (claimed.rowCount === 0) {
      await client.query("ROLLBACK");
      return false;
    }

    const { event_id, item_id, organization_id } = claimed.rows[0];

    const inv = await client.query(
      `SELECT stock FROM inventory WHERE item_id = $1 AND organization_id = $2 FOR UPDATE`,
      [item_id, organization_id]
    );

    if (inv.rowCount === 0 || inv.rows[0].stock <= 0) {
      await client.query(
        `UPDATE sale_events
            SET status = 'FAILED', reason = 'INSUFFICIENT_STOCK', processed_at = now()
          WHERE event_id = $1`,
        [event_id]
      );
      await client.query("COMMIT");
      console.log(`[worker] event ${event_id} FAILED (insufficient stock)`);
      publish({ type: "sale", status: "FAILED", itemId: item_id, organizationId: organization_id, eventId: event_id });
      // Risk monitoring runs after commit so it never blocks sale processing.
      evaluateFailedSale({ itemId: item_id, organizationId: organization_id, eventId: event_id });
      return true;
    }

    const newStock = inv.rows[0].stock - 1;
    await client.query(
      `UPDATE inventory SET stock = $1 WHERE item_id = $2 AND organization_id = $3`,
      [newStock, item_id, organization_id]
    );
    await client.query(
      `INSERT INTO inventory_ledger (item_id, organization_id, delta, reason, balance)
       VALUES ($1, $2, -1, 'SALE', $3)`,
      [item_id, organization_id, newStock]
    );
    await client.query(
      `UPDATE sale_events SET status = 'COMPLETED', processed_at = now() WHERE event_id = $1`,
      [event_id]
    );

    await client.query("COMMIT");
    console.log(`[worker] event ${event_id} COMPLETED (item ${item_id} → ${newStock})`);
    publish({ type: "sale", status: "COMPLETED", itemId: item_id, organizationId: organization_id, eventId: event_id, newStock });
    // Risk monitoring runs after commit so it never blocks sale processing.
    evaluateSale({ itemId: item_id, organizationId: organization_id, eventId: event_id });
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[worker] error", err.message);
    return false;
  } finally {
    client.release();
  }
}

function startWorker() {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      // Drain a burst per tick so we keep up with checkout spikes.
      for (let i = 0; i < 25; i++) {
        const did = await processOnce();
        if (!did) break;
      }
    } finally {
      running = false;
    }
  }, POLL_INTERVAL_MS);
  console.log("[worker] async sale processor started");
}

module.exports = { startWorker };
