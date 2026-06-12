const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: parseInt(process.env.PGPORT || "5432", 10),
  user: process.env.PGUSER || "inventorysoft",
  password: process.env.PGPASSWORD || "inventorysoft",
  database: process.env.PGDATABASE || "inventorysoft",
  max: 10,
});

pool.on("error", (err) => console.error("[db] unexpected pool error", err));

// Retry-on-boot helper: the API container may start before Postgres is ready
// to accept connections, even with a healthcheck. Poll until we can query.
async function waitForDb(retries = 30, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query("SELECT 1");
      console.log("[db] connected");
      return;
    } catch (err) {
      console.log(`[db] not ready (${i + 1}/${retries})… ${err.code || err.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("Could not connect to Postgres after retries");
}

// Idempotent migration so the risk-monitoring table exists even on an already
// initialized volume (init.sql only runs on a fresh database).
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS risk_alerts (
      id              BIGSERIAL PRIMARY KEY,
      item_id         TEXT,
      organization_id TEXT,
      event_id        UUID,
      rule            TEXT NOT NULL,
      severity        TEXT NOT NULL,
      score           INTEGER NOT NULL DEFAULT 0,
      detail          TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'OPEN',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_risk_alerts_org_time
      ON risk_alerts (organization_id, created_at DESC);
  `);
  console.log("[db] schema ensured (risk_alerts)");
}

module.exports = { pool, query: (text, params) => pool.query(text, params), waitForDb, ensureSchema };
