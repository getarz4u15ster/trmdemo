/**
 * InventorySoft Mock API Server
 * Simulates the InventorySoft API for candidate assessment purposes.
 * Run with: node server.js
 */

const http = require("http");
const crypto = require("crypto");

// Inline UUID v4 — no npm dependency needed
function uuidv4() {
  return crypto.randomUUID ? crypto.randomUUID() :
    ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
      (c ^ (crypto.randomBytes(1)[0] & (15 >> (c / 4)))).toString(16));
}

const PORT = 3001;

// ─── Seed Data ────────────────────────────────────────────────────────────────

const inventory = {
  // org "351" = General Goods, "352" = Bakery, "353" = Deli
  "92746661": { name: "Whole Milk (1 Gallon)", price: 4.99, stock: { "351": 120, "352": 0, "353": 0 } },
  "92746662": { name: "Sourdough Bread Loaf", price: 5.49, stock: { "351": 0, "352": 60, "353": 0 } },
  "92746663": { name: "Free-Range Eggs (12 ct)", price: 6.29, stock: { "351": 200, "352": 0, "353": 0 } },
  "92746664": { name: "Cheddar Cheese (8 oz)", price: 4.49, stock: { "351": 85, "352": 0, "353": 30 } },
  "92746665": { name: "Chicken Breast (1 lb)", price: 7.99, stock: { "351": 0, "352": 0, "353": 75 } },
  "92746666": { name: "Pasta Sauce (24 oz)", price: 3.79, stock: { "351": 150, "352": 0, "353": 0 } },
  "92746667": { name: "Orange Juice (52 oz)", price: 5.99, stock: { "351": 95, "352": 0, "353": 0 } },
  "92746668": { name: "Croissants (4-pack)", price: 4.99, stock: { "351": 0, "352": 40, "353": 0 } },
  "92746669": { name: "Sliced Turkey Deli (8 oz)", price: 6.49, stock: { "351": 0, "352": 0, "353": 55 } },
  "92746670": { name: "Sparkling Water (12-pack)", price: 8.99, stock: { "351": 110, "352": 0, "353": 0 } },
};

const organizations = {
  "351": { name: "ABC Supermarkets – General Goods", items: ["92746661","92746663","92746664","92746666","92746667","92746670"] },
  "352": { name: "ABC Supermarkets – Bakery",       items: ["92746662","92746668"] },
  "353": { name: "ABC Supermarkets – Deli",          items: ["92746664","92746665","92746669"] },
};

// ─── Rate Limiting ─────────────────────────────────────────────────────────────
const RATE_LIMIT = 25;
let requestsThisSecond = 0;
setInterval(() => { requestsThisSecond = 0; }, 1000);

// Async sale events log
const saleEvents = {};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(body, null, 2));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error("Invalid JSON")); }
    });
  });
}

function getTotalStock(itemId) {
  const item = inventory[itemId];
  if (!item) return null;
  const totalStock = Object.values(item.stock).reduce((a, b) => a + b, 0);
  return { itemId, name: item.name, price: item.price, totalStock, stockByOrg: item.stock };
}

// ─── Router ───────────────────────────────────────────────────────────────────
async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") { json(res, 204, {}); return; }

  // Rate limit check
  requestsThisSecond++;
  if (requestsThisSecond > RATE_LIMIT) {
    json(res, 429, { error: "Rate limit exceeded. Max 25 requests/second." });
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const segments = path.split("/").filter(Boolean); // e.g. ["item","92746661"]

  console.log(`[${new Date().toISOString()}] ${req.method} ${path}`);

  // GET /item/:id
  if (req.method === "GET" && segments[0] === "item" && segments[1]) {
    const itemId = segments[1];
    const data = getTotalStock(itemId);
    if (!data) { json(res, 404, { error: `Item ${itemId} not found.` }); return; }
    json(res, 200, data);
    return;
  }

  // GET /organization/:id
  if (req.method === "GET" && segments[0] === "organization" && segments[1]) {
    const orgId = segments[1];
    const org = organizations[orgId];
    if (!org) { json(res, 404, { error: `Organization ${orgId} not found.` }); return; }
    const items = org.items.map((id) => {
      const item = inventory[id];
      return {
        itemId: id,
        name: item.name,
        price: item.price,
        stock: item.stock[orgId] ?? 0,
      };
    });
    json(res, 200, { organizationId: orgId, organizationName: org.name, items });
    return;
  }

  // POST /admin/:id  – increment/decrement stock
  if (req.method === "POST" && segments[0] === "admin" && segments[1]) {
    const itemId = segments[1];
    const item = inventory[itemId];
    if (!item) { json(res, 404, { error: `Item ${itemId} not found.` }); return; }

    let body;
    try { body = await parseBody(req); }
    catch { json(res, 400, { error: "Invalid JSON body." }); return; }

    const { operatorDirection, operatorMagnitude, organizationId } = body;

    if (!["INCREASE", "DECREASE"].includes(operatorDirection)) {
      json(res, 400, { error: "operatorDirection must be 'INCREASE' or 'DECREASE'." }); return;
    }
    if (typeof operatorMagnitude !== "number" || operatorMagnitude <= 0) {
      json(res, 400, { error: "operatorMagnitude must be a positive integer." }); return;
    }
    if (!organizationId || !organizations[organizationId]) {
      json(res, 400, { error: `organizationId '${organizationId}' is invalid.` }); return;
    }

    const current = item.stock[organizationId] ?? 0;
    if (operatorDirection === "DECREASE") {
      if (operatorMagnitude > current) {
        json(res, 409, { error: `Cannot decrease by ${operatorMagnitude}. Only ${current} in stock.` }); return;
      }
      item.stock[organizationId] = current - operatorMagnitude;
    } else {
      item.stock[organizationId] = current + operatorMagnitude;
    }

    json(res, 200, {
      itemId,
      organizationId,
      previousStock: current,
      newStock: item.stock[organizationId],
      operatorDirection,
      operatorMagnitude,
    });
    return;
  }

  // POST /item/:id  – register sale (async)
  if (req.method === "POST" && segments[0] === "item" && segments[1]) {
    const itemId = segments[1];
    const item = inventory[itemId];
    if (!item) { json(res, 404, { error: `Item ${itemId} not found.` }); return; }

    let body;
    try { body = await parseBody(req); }
    catch { json(res, 400, { error: "Invalid JSON body." }); return; }

    const { organizationId } = body;
    if (!organizationId || !organizations[organizationId]) {
      json(res, 400, { error: `organizationId '${organizationId}' is invalid.` }); return;
    }

    const eventId = uuidv4();

    // Simulate async processing – decrement stock after a short delay
    setTimeout(() => {
      const current = item.stock[organizationId] ?? 0;
      if (current > 0) item.stock[organizationId] = current - 1;
      saleEvents[eventId] = {
        status: "COMPLETED",
        itemId,
        organizationId,
        processedAt: new Date().toISOString(),
      };
      console.log(`  [ASYNC] Sale event ${eventId} processed for item ${itemId}`);
    }, 500 + Math.random() * 1000);

    saleEvents[eventId] = { status: "PENDING", itemId, organizationId };
    json(res, 202, { eventId });
    return;
  }

  // GET /events/:eventId  – bonus: poll async event status
  if (req.method === "GET" && segments[0] === "events" && segments[1]) {
    const evt = saleEvents[segments[1]];
    if (!evt) { json(res, 404, { error: "Event not found." }); return; }
    json(res, 200, evt);
    return;
  }

  json(res, 404, { error: "Endpoint not found." });
}

http.createServer(handler).listen(PORT, () => {
  console.log(`\n✅  InventorySoft Mock API running at http://localhost:${PORT}`);
  console.log("   Endpoints:");
  console.log("   GET  /item/:id");
  console.log("   GET  /organization/:id  (try 351, 352, 353)");
  console.log("   POST /admin/:id");
  console.log("   POST /item/:id  (async sale)");
  console.log("   GET  /events/:eventId   (poll async sale status)\n");
});
