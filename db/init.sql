-- ============================================================================
-- InventorySoft inventory database (local analog of the customer's AWS RDS)
-- Loaded automatically by the Postgres container on first boot.
-- ============================================================================

CREATE TABLE IF NOT EXISTS organizations (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  price NUMERIC(10, 2) NOT NULL
);

-- Stock is tracked per (item, organization) pair. An item can live in
-- multiple organizations (e.g. Cheddar Cheese is in General Goods + Deli).
CREATE TABLE IF NOT EXISTS inventory (
  item_id         TEXT NOT NULL REFERENCES items(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  stock           INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  PRIMARY KEY (item_id, organization_id)
);

-- Async sale events. POST /item/:id inserts a PENDING row and returns
-- immediately; a background worker drains the queue and decrements stock.
CREATE TABLE IF NOT EXISTS sale_events (
  event_id        UUID PRIMARY KEY,
  item_id         TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING',   -- PENDING | COMPLETED | FAILED
  idempotency_key TEXT,                              -- guards client retries
  reason          TEXT,                              -- failure reason, if any
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ
);

-- Idempotency: a client that retries a timed-out sale POST with the same key
-- gets the original event back instead of double-counting.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sale_events_idem
  ON sale_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Append-only ledger of every stock movement. Powers the "inventory over the
-- course of the working day" analytics the customer asked for.
CREATE TABLE IF NOT EXISTS inventory_ledger (
  id              BIGSERIAL PRIMARY KEY,
  item_id         TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  delta           INTEGER NOT NULL,          -- negative = sale/shrinkage
  reason          TEXT NOT NULL,             -- SALE | RESTOCK | ADJUST
  balance         INTEGER NOT NULL,          -- resulting stock after the move
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_org_time
  ON inventory_ledger (organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sale_events_status
  ON sale_events (status, created_at);

-- Real-time risk / loss-prevention alerts. A monitoring layer scores each stock
-- movement against configurable rules (à la transaction monitoring) and records
-- anything anomalous here for triage — the immutable inventory_ledger is the
-- backing audit trail.
CREATE TABLE IF NOT EXISTS risk_alerts (
  id              BIGSERIAL PRIMARY KEY,
  item_id         TEXT,
  organization_id TEXT,
  event_id        UUID,                       -- linked sale event, if any
  rule            TEXT NOT NULL,              -- which rule fired
  severity        TEXT NOT NULL,              -- LOW | MEDIUM | HIGH
  score           INTEGER NOT NULL DEFAULT 0, -- 0-100 risk score
  detail          TEXT NOT NULL,              -- human-readable explanation
  status          TEXT NOT NULL DEFAULT 'OPEN', -- OPEN | ACK | RESOLVED
  resolution      TEXT,                       -- how it was resolved (e.g. auto-resolved by restock)
  resolved_at     TIMESTAMPTZ,                -- when it moved to RESOLVED
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_risk_alerts_org_time
  ON risk_alerts (organization_id, created_at DESC);

-- ─── Seed data (matches the provided assessment kit) ────────────────────────

INSERT INTO organizations (id, name) VALUES
  ('351', 'ABC Supermarkets – General Goods'),
  ('352', 'ABC Supermarkets – Bakery'),
  ('353', 'ABC Supermarkets – Deli')
ON CONFLICT (id) DO NOTHING;

INSERT INTO items (id, name, price) VALUES
  ('92746661', 'Whole Milk (1 Gallon)',     4.99),
  ('92746662', 'Sourdough Bread Loaf',      5.49),
  ('92746663', 'Free-Range Eggs (12 ct)',   6.29),
  ('92746664', 'Cheddar Cheese (8 oz)',     4.49),
  ('92746665', 'Chicken Breast (1 lb)',     7.99),
  ('92746666', 'Pasta Sauce (24 oz)',       3.79),
  ('92746667', 'Orange Juice (52 oz)',      5.99),
  ('92746668', 'Croissants (4-pack)',       4.99),
  ('92746669', 'Sliced Turkey Deli (8 oz)', 6.49),
  ('92746670', 'Sparkling Water (12-pack)', 8.99)
ON CONFLICT (id) DO NOTHING;

INSERT INTO inventory (item_id, organization_id, stock) VALUES
  ('92746661', '351', 120),
  ('92746662', '352', 60),
  ('92746663', '351', 200),
  ('92746664', '351', 85),
  ('92746664', '353', 30),
  ('92746665', '353', 75),
  ('92746666', '351', 150),
  ('92746667', '351', 95),
  ('92746668', '352', 40),
  ('92746669', '353', 55),
  ('92746670', '351', 110)
ON CONFLICT (item_id, organization_id) DO NOTHING;

-- Seed an opening-balance ledger entry per stock row so the analytics chart has
-- a baseline at the start of the working day.
INSERT INTO inventory_ledger (item_id, organization_id, delta, reason, balance, created_at)
SELECT item_id, organization_id, stock, 'OPENING', stock, now()
FROM inventory;
