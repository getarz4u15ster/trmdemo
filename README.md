# ABC Supermarkets × InventorySoft — SA Integration Demo

A production-shaped, fully **Dockerized** mock integration for the TRM Solutions
Architect assessment. It takes the provided zero-dependency kit and enriches it
into a three-tier stack with a **persistent database**, a **Swagger-documented
API**, **async sale processing**, **rate-limit handling**, **idempotency**, and
an **operations dashboard** that tracks inventory over the working day.

> The original assessment kit is preserved untouched in [`inventorysoft-mock/`](./inventorysoft-mock)
> for reference. Everything below is the enriched solution.

---

## Quick start

```bash
docker compose up --build
```

| Service | URL | Purpose |
|---|---|---|
| Storefront / POS | http://localhost:3000 | ABC Supermarkets web app |
| InventorySoft API | http://localhost:3001 | Inventory service |
| **Swagger UI** | **http://localhost:3001/docs** | Live, try-it-out API docs |
| OpenAPI spec | http://localhost:3001/openapi.yaml | Machine-readable contract |
| Health | http://localhost:3001/health | Liveness/readiness probe |
| Postgres | localhost:5432 | `inventorysoft / inventorysoft` |

Reset to fresh seed data at any time:

```bash
docker compose down -v && docker compose up --build
```

### Helper scripts

Convenience wrappers live in [`scripts/`](./scripts) (all idempotent):

| Script | What it does |
|---|---|
| `./scripts/start.sh` | Build + start the stack, wait for health, print URLs |
| `./scripts/stop.sh` | Stop the stack (data preserved); add `--reset` to wipe the DB |
| `./scripts/reset.sh` | Tear down + rebuild + start with **fresh seed data** (run before a demo) |
| `./scripts/status.sh` | Show container status + probe each endpoint |
| `./scripts/logs.sh [service]` | Tail logs for the stack or one service (`api`, `storefront`, `postgres`) |
| `./scripts/smoke-test.sh` | Run a 16-check end-to-end test of the API contract + proxy |

### Presentation materials

- **Architecture diagram** — [`docs/architecture.drawio`](./docs/architecture.drawio) (open in [draw.io](https://app.diagrams.net); two pages: Local Docker Stack + AWS Target)
- **Demo script** — [`docs/DEMO_SCRIPT.md`](./docs/DEMO_SCRIPT.md) (1-hour interview runbook with talking points)

---

## Architecture

```
┌──────────────────────┐      HTTP (rate-limited client)       ┌───────────────────────┐
│   Storefront / POS    │  ── token-bucket queue ≈20 req/s ──►  │   InventorySoft API    │
│   (Express + static)  │                                       │   (Express)            │
│                       │  ◄── 202 eventId / JSON inventory ──  │                        │
│  • catalog + cart     │                                       │  • 25 req/s rate limit │
│  • async checkout     │                                       │  • async sale worker   │
│  • restock (admin)    │                                       │  • Swagger UI /docs    │
│  • ops dashboard      │                                       │  • analytics endpoint  │
│  • load simulator     │                                       └───────────┬───────────┘
└──────────────────────┘                                                   │ SQL
                                                                ┌──────────▼───────────┐
                                                                │   Postgres            │
                                                                │  (analog of AWS RDS)  │
                                                                │  items / inventory /  │
                                                                │  sale_events / ledger │
                                                                └───────────────────────┘
```

Three containers, one `docker compose up`:

1. **postgres** — inventory database with seed data + healthcheck (the local
   stand-in for the customer's **AWS RDS**).
2. **api** — the InventorySoft API. Express + `pg`, Swagger UI, a global
   25 req/s limiter, and a background worker that drains the async sale queue.
3. **storefront** — the ABC Supermarkets app. Serves the UI and proxies every
   upstream call through a **token-bucket rate limiter** so checkout bursts get
   smoothed instead of tripping 429s.

---

## What was enriched (vs. the provided kit)

| Requirement / discussion point | How it's addressed here |
|---|---|
| **Local database** to persist inventory | Postgres with `items`, `inventory`, `sale_events`, `inventory_ledger`; survives restarts via a named volume |
| **Swagger API** | Full OpenAPI 3 spec served at `/docs` with try-it-out |
| **Async vs sync** | `POST /item/:id` enqueues a `PENDING` event (HTTP 202) drained by a worker; admin + GETs are synchronous |
| **Rate-limit strategy (25 req/s)** | Client-side token-bucket **queue** in the storefront; API still enforces 429. The Ops dashboard has a load simulator to demonstrate it live |
| **Idempotency** | `Idempotency-Key` header dedupes retried sales so a timeout-retry never double-counts |
| **Inventory freshness / lag** | UI re-fetches org inventory after checkout and polls `GET /events/:id` to show eventual consistency |
| **Track inventory over the working day** | Append-only `inventory_ledger` + `GET /analytics/.../timeseries` powering a stock-vs-sold chart |
| **Error handling (409)** | `POST /admin` returns 409 on negative stock; UI surfaces it inline |
| **Extensibility to AWS** | See mapping below — every local component has a 1:1 managed-service target |

---

## Mapping to the customer's AWS environment

The customer runs **EC2** (POS software), **S3** (archive/images), and **RDS**
(inventory data). This local stack mirrors that topology so the migration story
is direct:

| Local (Docker) | AWS target | Notes |
|---|---|---|
| `postgres` container | **RDS (PostgreSQL)** | Same schema; swap connection string |
| `api` container | **ECS Fargate / EC2 + ALB** | Stateless; scale horizontally behind a load balancer |
| Storefront token-bucket queue | **SQS + throttled consumer (Lambda/worker)** | Durable buffering for >25 req/s checkout spikes |
| `worker.js` async loop | **Lambda triggered by SQS** | `FOR UPDATE SKIP LOCKED` already supports multiple consumers |
| API rate limiter (429) | **API Gateway usage plans / WAF rate rules** | Enforce the 25 req/s contract at the edge |
| Product images / day-end archives | **S3** | Ledger + nightly snapshots archived to S3/Glacier |
| Inventory time series | **CloudWatch / Timestream / QuickSight** | Dashboards over the same ledger data |
| Secrets (`PG*`) | **Secrets Manager / SSM Parameter Store** | No plaintext creds in env in prod |

---

## API reference (summary)

Base URL: **`http://localhost:3001`**

| Method | Path | Sync? | Description |
|---|---|---|---|
| GET | `/item/{itemId}` | sync | Total stock for one item across orgs |
| GET | `/organization/{organizationId}` | sync | All items + stock for an org |
| POST | `/admin/{itemId}` | sync | Increment/decrement stock (409 on negative) |
| POST | `/item/{itemId}` | **async** | Register a sale → 202 `{eventId}` |
| GET | `/events/{eventId}` | sync | Poll async sale status |
| GET | `/analytics/organization/{id}/timeseries` | sync | Inventory over the working day |
| GET | `/health` | sync | DB-backed health probe |

### Live endpoint URLs (click to try the GETs)

- API root / docs: http://localhost:3001/docs
- OpenAPI spec: http://localhost:3001/openapi.yaml
- Health: http://localhost:3001/health
- Item (Whole Milk): http://localhost:3001/item/92746661
- Organization (General Goods): http://localhost:3001/organization/351
- Organization (Bakery): http://localhost:3001/organization/352
- Organization (Deli): http://localhost:3001/organization/353
- Analytics time series: http://localhost:3001/analytics/organization/351/timeseries
- Event status: `http://localhost:3001/events/{eventId}` (use an `eventId` from a sale)
- Storefront app: http://localhost:3000
- Storefront limiter stats: http://localhost:3000/limiter-stats

### Example requests for the POST endpoints

```bash
# Restock (synchronous) — increment Whole Milk in General Goods
curl -X POST http://localhost:3001/admin/92746661 \
  -H 'Content-Type: application/json' \
  -d '{"operatorDirection":"INCREASE","operatorMagnitude":50,"organizationId":"351"}'

# Register a sale (asynchronous) — returns 202 { "eventId": "..." }
curl -X POST http://localhost:3001/item/92746661 \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: my-unique-key-001' \
  -d '{"itemId":"92746661","organizationId":"351"}'

# Poll the async sale event
curl http://localhost:3001/events/<eventId-from-above>
```

Full schemas, examples, and try-it-out: **http://localhost:3001/docs**.

---

## Demo script (for the panel)

1. **Storefront** → browse orgs, add to cart, checkout. Open the ⚡ API Monitor to
   watch `POST /item` (202) and `GET /events` polling resolve to COMPLETED.
2. **Restock** → 📦 on any card fires synchronous `POST /admin`; watch stock change.
3. **Operations tab** → stock/sold/value KPIs + the working-day chart.
4. **Rate-limit simulation** → fire a burst of 100+ sales and watch the client
   queue absorb it (peak queue depth climbs, all return 202). Compare with
   hammering `:3001` directly, which returns 429s.
5. **Swagger** → `:3001/docs` to show the contract and run requests live.

---

## Project layout

```
trmdemo/
├── docker-compose.yml            # 3-service orchestration
├── db/init.sql                   # schema + seed (RDS analog)
├── services/
│   ├── inventorysoft-api/        # Express API + Swagger + async worker
│   │   ├── openapi.yaml
│   │   └── src/{index,db,worker}.js
│   └── storefront/               # ABC Supermarkets app + rate-limit proxy
│       ├── src/{index,rateLimiter}.js
│       └── public/index.html
└── inventorysoft-mock/           # original provided kit (reference only)
```

---

## Note on AI usage

This solution was built with AI assistance (Cursor + Claude). AI was used to
scaffold the Docker/Express/Postgres boilerplate, draft the OpenAPI spec, and
generate the dashboard UI. I directed the architecture decisions — choosing a
ledger table for the working-day analytics, a token-bucket queue to honor the
25 req/s limit, `Idempotency-Key` for safe retries, and `FOR UPDATE SKIP LOCKED`
so the async worker is horizontally scalable — and validated every endpoint
end-to-end against the assessment's API contract before finalizing.
```
