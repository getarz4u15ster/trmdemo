const path = require("path");
const http = require("http");
const express = require("express");
const { RateLimiter } = require("./rateLimiter");
const { chatAnswer, executeAction, llmStatus } = require("./chat");

const PORT = parseInt(process.env.PORT || "3000", 10);
const INVENTORYSOFT_BASE = process.env.INVENTORYSOFT_URL || "http://localhost:3001";
// Stay safely under the upstream 25 req/s cap. Keep rate + burst <= 25 so even a
// cold-bucket burst lands inside the API's fixed-second window without a 429.
const CLIENT_RATE = parseInt(process.env.CLIENT_RATE || "18", 10);
const CLIENT_BURST = parseInt(process.env.CLIENT_BURST || "5", 10);

const app = express();
app.use(express.json());

const limiter = new RateLimiter({ ratePerSec: CLIENT_RATE, burst: CLIENT_BURST });

async function upstream(targetPath, options = {}) {
  const url = `${INVENTORYSOFT_BASE}${targetPath}`;
  const res = await fetch(url, options);
  const text = await res.text();
  return { status: res.status, body: text, headers: res.headers };
}

// Every upstream call is funneled through the limiter so bursty checkouts get
// smoothed to <25 req/s instead of tripping 429s.
app.all("/proxy/*", async (req, res) => {
  const targetPath = req.url.replace("/proxy", "");
  const options = { method: req.method, headers: { "Content-Type": "application/json" } };
  if (req.get("Idempotency-Key")) options.headers["Idempotency-Key"] = req.get("Idempotency-Key");
  if (req.method !== "GET" && req.body && Object.keys(req.body).length) {
    options.body = JSON.stringify(req.body);
  }

  try {
    const result = await limiter.schedule(() => upstream(targetPath, options));
    res
      .status(result.status)
      .set("Content-Type", "application/json")
      .set("X-RateLimiter-Queue-Depth", String(limiter.stats().queueDepth))
      .send(result.body);
  } catch (e) {
    res.status(502).json({ error: "Could not reach InventorySoft API.", detail: e.message });
  }
});

// Expose limiter stats so the UI can visualise queue depth during load.
app.get("/limiter-stats", (_req, res) => res.json(limiter.stats()));

// ─── Load / rate-limit simulation (server-side so the queue is real) ────────
// Firing the burst from the browser is throttled by the browser's ~6-connection
// cap, so the queue never actually fills. Firing here means all N requests hit
// the limiter at once — the queue depth (and the queue's protection) is genuine.
//   bypass=false → through the token-bucket queue → smoothed, ~0 × 429
//   bypass=true  → straight at the API → spikes past 25/s → lots of 429
app.post("/load-test", async (req, res) => {
  const { itemId, organizationId, bypass } = req.body || {};
  const count = Math.min(1000, Math.max(1, parseInt(req.body && req.body.count, 10) || 100));
  if (!itemId || !organizationId) {
    return res.status(400).json({ error: "itemId and organizationId are required." });
  }
  limiter.resetPeak();
  let accepted = 0, rateLimited = 0, errors = 0;
  const fireOne = (i) => {
    const opts = {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": `lt-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}` },
      body: JSON.stringify({ itemId, organizationId }),
    };
    const call = () => upstream(`/item/${itemId}`, opts);
    const p = bypass ? call() : limiter.schedule(call);
    return p.then((r) => {
      if (r.status === 202) accepted++;
      else if (r.status === 429) rateLimited++;
      else errors++;
    }).catch(() => { errors++; });
  };
  await Promise.all(Array.from({ length: count }, (_v, i) => fireOne(i)));
  res.json({ sent: count, accepted, rateLimited, errors, peakQueueDepth: limiter.stats().maxQueueDepth, bypass: !!bypass });
});

// Real-time event stream. Bypasses the buffering /proxy handler and the rate
// limiter — it's one long-lived connection that pipes the upstream SSE straight
// through to the browser (sales, stock changes, and risk alerts in real time).
app.get("/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  const upstream = http.get(`${INVENTORYSOFT_BASE}/stream`, (up) => up.pipe(res));
  upstream.on("error", () => { try { res.write(`event: error\ndata: {}\n\n`); } catch {} });
  req.on("close", () => upstream.destroy());
});

// ─── Conversational query over the ops data (read-only, grounded) ───────────
app.post("/chat", async (req, res) => {
  const { question, organizationId } = req.body || {};
  if (!question || typeof question !== "string" || !organizationId) {
    return res.status(400).json({ error: "question (string) and organizationId are required." });
  }
  if (question.length > 500) return res.status(400).json({ error: "Question is too long (max 500 chars)." });
  try {
    const out = await chatAnswer(question.trim(), String(organizationId));
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: "Could not answer right now.", detail: e.message });
  }
});

// Executes a user-confirmed chat action (currently: restock / INCREASE only).
// The chat itself only proposes; this is the explicit, validated write step.
app.post("/chat/action", async (req, res) => {
  const { action } = req.body || {};
  if (!action || typeof action !== "object") return res.status(400).json({ error: "action is required." });
  try {
    const out = await limiter.schedule(() => executeAction(action));
    res.json(out);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message || "Action failed." });
  }
});

// Lets the UI badge reflect the real LLM state (live / no-quota / bad-key / off).
app.get("/chat-info", async (_req, res) => {
  try {
    const s = await llmStatus();
    res.json({ llm: s.status === "live", provider: s.provider, status: s.status });
  } catch (e) {
    res.json({ llm: false, status: "error" });
  }
});

app.use(express.static(path.join(__dirname, "..", "public")));

app.listen(PORT, () => {
  console.log(`\n✅  ABC Supermarkets storefront running at http://localhost:${PORT}`);
  console.log(`   Upstream InventorySoft API → ${INVENTORYSOFT_BASE}`);
  console.log(`   Client throttle → ${CLIENT_RATE} req/s, burst ${CLIENT_BURST} (upstream cap 25)\n`);
});
