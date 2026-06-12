const path = require("path");
const express = require("express");
const { RateLimiter } = require("./rateLimiter");
const { chatAnswer, executeAction, llmStatus } = require("./chat");

const PORT = parseInt(process.env.PORT || "3000", 10);
const INVENTORYSOFT_BASE = process.env.INVENTORYSOFT_URL || "http://localhost:3001";
// Stay safely under the upstream 25 req/s cap.
const CLIENT_RATE = parseInt(process.env.CLIENT_RATE || "20", 10);

const app = express();
app.use(express.json());

const limiter = new RateLimiter({ ratePerSec: CLIENT_RATE, burst: CLIENT_RATE });

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
  console.log(`   Client throttle → ${CLIENT_RATE} req/s (upstream cap 25)\n`);
});
