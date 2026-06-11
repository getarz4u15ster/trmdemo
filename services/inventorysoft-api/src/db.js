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

module.exports = { pool, query: (text, params) => pool.query(text, params), waitForDb };
