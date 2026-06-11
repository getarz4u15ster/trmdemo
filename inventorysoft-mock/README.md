# InventorySoft × ABC Supermarkets — SA Assessment Kit

This kit contains everything needed to run the Solutions Architect candidate assessment locally.

---

## 📁 Folder Structure

```
inventorysoft-mock/
├── server.js                          ← InventorySoft Mock API (port 3001)
├── package.json
├── InventorySoft_Postman_Collection.json  ← Import into Postman or Bruno
└── abc-supermarkets/
    ├── app.js                         ← ABC Supermarkets Web App (port 3000)
    └── package.json
```

---

## 🚀 Quick Start (two terminals)

### Terminal 1 — Start the InventorySoft Mock API

```bash
cd inventorysoft-mock
node server.js      # no npm install needed — zero dependencies
```

You should see:
```
✅  InventorySoft Mock API running at http://localhost:3001
```

### Terminal 2 — Start the ABC Supermarkets Web App

```bash
cd inventorysoft-mock/abc-supermarkets
node app.js       # no dependencies needed (Node 18+)
```

You should see:
```
✅  ABC Supermarkets app running at http://localhost:3000
```

Then open **http://localhost:3000** in your browser.

---

## 🛒 ABC Supermarkets App Features

| Feature | Description |
|---|---|
| **Org Tabs** | Switch between General Goods, Bakery, and Deli |
| **Live Inventory** | Calls `GET /organization/{id}` on load to show real stock levels |
| **Stock Badges** | Items show In Stock / Low Stock / Out of Stock based on live data |
| **Add to Cart** | Add items (out-of-stock items are disabled) |
| **Checkout Flow** | Review cart → Confirm → fires `POST /item/{id}` per unit |
| **Async Polling** | Automatically polls `GET /events/{eventId}` after sale registration |
| **API Monitor** | Click the ⚡ button (bottom-right) to watch every API call live |
| **Inventory Refresh** | After checkout, org inventory is re-fetched to show updated counts |

---

## 📮 Postman Collection

Import `InventorySoft_Postman_Collection.json` into Postman or [Bruno](https://usebruno.com).

The collection includes:

1. **GET /item/:id** — Retrieve a single item's inventory
2. **GET /organization/:id** — Retrieve all items for an org (try 351, 352, 353)
3. **POST /admin/:id** — Increment or decrement stock (restock / shrinkage)
4. **POST /item/:id** — Register a sale (async — returns eventId)
5. **GET /events/:eventId** — Poll async sale event status *(bonus endpoint)*
6. **Error cases** — 404 not found, 409 insufficient stock, 400 bad input

> **Tip:** The "Register Sale" request has a post-request script that automatically saves the returned `eventId` to a collection variable so you can immediately run the poll request.

---

## 🗂️ Seed Data

### Organizations

| ID | Name |
|---|---|
| 351 | ABC Supermarkets – General Goods |
| 352 | ABC Supermarkets – Bakery |
| 353 | ABC Supermarkets – Deli |

### Items

| Item ID | Name | Price | Org(s) |
|---|---|---|---|
| 92746661 | Whole Milk (1 Gallon) | $4.99 | 351 |
| 92746662 | Sourdough Bread Loaf | $5.49 | 352 |
| 92746663 | Free-Range Eggs (12 ct) | $6.29 | 351 |
| 92746664 | Cheddar Cheese (8 oz) | $4.49 | 351, 353 |
| 92746665 | Chicken Breast (1 lb) | $7.99 | 353 |
| 92746666 | Pasta Sauce (24 oz) | $3.79 | 351 |
| 92746667 | Orange Juice (52 oz) | $5.99 | 351 |
| 92746668 | Croissants (4-pack) | $4.99 | 352 |
| 92746669 | Sliced Turkey Deli (8 oz) | $6.49 | 353 |
| 92746670 | Sparkling Water (12-pack) | $8.99 | 351 |

---

## 🔌 API Reference

### `GET /item/:id`
Returns total stock for a single item across all orgs.

**Response:**
```json
{
  "itemId": "92746661",
  "name": "Whole Milk (1 Gallon)",
  "price": 4.99,
  "totalStock": 120,
  "stockByOrg": { "351": 120 }
}
```

---

### `GET /organization/:id`
Returns all items for an org with their current stock level.

**Response:**
```json
{
  "organizationId": "351",
  "organizationName": "ABC Supermarkets – General Goods",
  "items": [
    { "itemId": "92746661", "name": "Whole Milk (1 Gallon)", "price": 4.99, "stock": 120 }
  ]
}
```

---

### `POST /admin/:id`
Increment or decrement inventory (restocking, shrinkage, corrections).

**Request body:**
```json
{
  "operatorDirection": "INCREASE",
  "operatorMagnitude": 50,
  "organizationId": "351"
}
```

**Response:**
```json
{
  "itemId": "92746661",
  "organizationId": "351",
  "previousStock": 120,
  "newStock": 170,
  "operatorDirection": "INCREASE",
  "operatorMagnitude": 50
}
```

> Returns `409` if a DECREASE would result in negative stock.

---

### `POST /item/:id` *(Async)*
Registers a new sale. Returns immediately with an eventId; inventory is decremented asynchronously (~0.5–1.5 sec).

**Request body:**
```json
{
  "itemId": "92746661",
  "organizationId": "351"
}
```

**Response (HTTP 202):**
```json
{ "eventId": "8f7c3651-9b87-4638-b052-cfdef0d04f94" }
```

---

### `GET /events/:eventId` *(Bonus)*
Poll the status of an async sale event.

**Response:**
```json
{
  "status": "COMPLETED",
  "itemId": "92746661",
  "organizationId": "351",
  "processedAt": "2024-11-01T14:32:10.123Z"
}
```

---

## ⚠️ Rate Limits

All endpoints: **25 requests/second** maximum.

The server will return HTTP `429` if this threshold is exceeded. This is an important constraint candidates should address when designing integrations that process bulk checkout events.

---

## 🎯 Assessment Discussion Points

Good candidates should identify and discuss:

- **Async vs sync**: Why is `POST /item/:id` async while admin and GET endpoints are synchronous? What implications does this have at checkout?
- **Rate limit strategy**: A busy supermarket checkout could easily generate 25+ sale events per second across multiple registers. How would you handle this? (queuing, batching, circuit breakers)
- **Organization model**: ABC has three orgs. How should a client system decide which `organizationId` to pass? What happens if an item exists in multiple orgs?
- **Inventory freshness**: `GET /organization/:id` is synchronous, but async sale events mean stock counts lag briefly. How would you handle UI consistency?
- **Error handling**: What happens on a 409 (insufficient stock)? How should the POS system respond mid-transaction?
- **Idempotency**: What happens if a sale POST request times out and the client retries? Is there a risk of double-counting?

---

## 🌐 Exposing to the Internet (optional)

To test with a public URL (e.g. for webhook testing), use [ngrok](https://ngrok.com):

```bash
# Expose the InventorySoft API
ngrok http 3001

# Or expose the storefront
ngrok http 3000
```

Then update the `INVENTORYSOFT_URL` environment variable in Terminal 2 if pointing the storefront at a remote API:

```bash
INVENTORYSOFT_URL=https://your-ngrok-url.ngrok.io node abc-supermarkets/app.js
```
