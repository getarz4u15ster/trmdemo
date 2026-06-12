// Conversational layer over the operations dashboard data.
//
// Design: a *grounded, read-only tool-calling agent*. Instead of letting a model
// write arbitrary SQL, we expose a small allow-list of read tools that map to the
// existing InventorySoft API. A deterministic planner decides which tools to call
// (so it always works offline and is fully auditable); the structured findings are
// then phrased into an answer. If an LLM API key is present, the LLM composes the
// final wording grounded ONLY on those findings — otherwise a deterministic
// template is used. Tool execution is identical in both modes, so the data is
// never hallucinated.

const INVENTORYSOFT_BASE = process.env.INVENTORYSOFT_URL || "http://localhost:3001";
const LOW_STOCK = parseInt(process.env.CHAT_LOW_STOCK || "5", 10);

const LLM_PROVIDER =
  process.env.LLM_PROVIDER ||
  (process.env.ANTHROPIC_API_KEY ? "anthropic" : process.env.OPENAI_API_KEY ? "openai" : "");
const LLM_API_KEY =
  process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || "";
const LLM_MODEL =
  process.env.LLM_MODEL ||
  (LLM_PROVIDER === "anthropic" ? "claude-3-5-sonnet-latest" : "gpt-4o-mini");

async function apiGet(p) {
  const r = await fetch(`${INVENTORYSOFT_BASE}${p}`);
  if (!r.ok) throw new Error(`API ${p} -> ${r.status}`);
  return r.json();
}

async function apiPost(p, body) {
  const r = await fetch(`${INVENTORYSOFT_BASE}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

const DEFAULT_RESTOCK = parseInt(process.env.CHAT_DEFAULT_RESTOCK || "50", 10);
const MAX_RESTOCK = parseInt(process.env.CHAT_MAX_RESTOCK || "10000", 10);

// ─── Read-only tool allow-list (maps 1:1 to existing endpoints) ─────────────
const TOOLS = {
  get_inventory: (org) => apiGet(`/organization/${encodeURIComponent(org)}`),
  get_timeseries: (org) => apiGet(`/analytics/organization/${encodeURIComponent(org)}/timeseries`),
  get_alerts: (org, severity) =>
    apiGet(`/alerts?organizationId=${encodeURIComponent(org)}${severity ? `&severity=${severity}` : ""}`),
};

const money = (n) => `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (n) => Number(n).toLocaleString();

function detectSeverity(q) {
  if (/\bhigh\b/i.test(q)) return "HIGH";
  if (/\bmed(ium)?\b/i.test(q)) return "MEDIUM";
  if (/\blow\b/i.test(q)) return "LOW";
  return null;
}

// Aggregate the per-interval soldByItem breakdown into a name -> units map.
function aggregateSold(timeseries) {
  const byItem = {};
  let total = 0;
  for (const p of timeseries.points || []) {
    for (const s of p.soldByItem || []) {
      byItem[s.name] = (byItem[s.name] || 0) + Number(s.units);
      total += Number(s.units);
    }
  }
  const ranked = Object.entries(byItem)
    .map(([name, units]) => ({ name, units }))
    .sort((a, b) => b.units - a.units);
  return { ranked, total };
}

// ─── Deterministic planner: decide which tools the question needs ───────────
function plan(question) {
  const q = question.toLowerCase();
  const flags = {
    alerts: /alert|risk|suspicious|loss|shrink|oversell|phantom|theft|fraud|anomal|flag/.test(q),
    sales: /sold|selling|sales|fastest|top|best.?sell|popular|moving|velocity|unit/.test(q),
    stock: /stock|inventor|on hand|level|low|out of stock|\boos\b|count|remaining|restock/.test(q),
    value: /value|worth|revenue|\$|price|cost|expensive/.test(q),
  };
  // If nothing matched, treat it as a general "give me an overview".
  const overview = !flags.alerts && !flags.sales && !flags.stock && !flags.value;
  return { flags, overview };
}

// ─── Gather findings by calling the needed tools ────────────────────────────
async function gather(question, org) {
  const { flags, overview } = plan(question);
  const used = [];
  const findings = {};

  const needInventory = overview || flags.stock || flags.value || flags.sales;
  const needTimeseries = overview || flags.sales;
  const needAlerts = overview || flags.alerts;
  const severity = detectSeverity(question);

  if (needInventory) {
    const inv = await TOOLS.get_inventory(org);
    used.push({ tool: "get_inventory", endpoint: `/organization/${org}` });
    findings.organizationName = inv.organizationName;
    findings.itemCount = inv.items.length;
    findings.totalStock = inv.items.reduce((s, i) => s + Number(i.stock), 0);
    findings.inventoryValue = inv.items.reduce((s, i) => s + Number(i.stock) * Number(i.price), 0);
    findings.lowOrOut = inv.items
      .filter((i) => Number(i.stock) <= LOW_STOCK)
      .sort((a, b) => a.stock - b.stock)
      .map((i) => ({ name: i.name, stock: Number(i.stock) }));
    // Item-specific match: does the question name an item we carry?
    const match = inv.items.find((i) => q_includes(question, i.name));
    if (match) findings.item = { name: match.name, stock: Number(match.stock), price: Number(match.price) };
  }

  if (needTimeseries) {
    const ts = await TOOLS.get_timeseries(org);
    used.push({ tool: "get_timeseries", endpoint: `/analytics/organization/${org}/timeseries` });
    findings.organizationName = findings.organizationName || ts.organizationName;
    const agg = aggregateSold(ts);
    findings.totalSold = agg.total;
    findings.topSellers = agg.ranked.slice(0, 5);
    if (findings.item) {
      const hit = agg.ranked.find((r) => r.name === findings.item.name);
      findings.item.soldToday = hit ? hit.units : 0;
    }
  }

  if (needAlerts) {
    const al = await TOOLS.get_alerts(org, severity);
    used.push({ tool: "get_alerts", endpoint: `/alerts?organizationId=${org}${severity ? `&severity=${severity}` : ""}` });
    findings.alertSummary = al.summary;
    findings.alertFilter = severity || "ALL";
    findings.openAlerts = (al.alerts || [])
      .filter((a) => a.status !== "RESOLVED")
      .slice(0, 5)
      .map((a) => ({ rule: a.rule, severity: a.severity, score: a.score, item: a.itemName, status: a.status }));
  }

  return { findings, used, flags, overview, severity };
}

function q_includes(question, name) {
  // Match on the distinctive first word(s) of the item name, case-insensitive.
  const key = String(name).toLowerCase().replace(/\(.+?\)/g, "").trim();
  if (!key) return false;
  const head = key.split(/\s+/).slice(0, 2).join(" ");
  return question.toLowerCase().includes(head) || question.toLowerCase().includes(key);
}

const RULE_LABEL = {
  SALE_VELOCITY: "sale-velocity spike",
  OVERSELL_ATTEMPT: "oversell / phantom inventory",
  LARGE_SHRINKAGE: "large manual shrinkage",
};

// ─── Deterministic phrasing (offline fallback / no key) ─────────────────────
function composeDeterministic({ findings, flags, overview, severity }) {
  const f = findings;
  const org = f.organizationName || "this organization";
  const lines = [];

  if (f.item) {
    const it = f.item;
    const soldStr = it.soldToday != null ? `, ${num(it.soldToday)} sold today` : "";
    lines.push(`${it.name}: ${num(it.stock)} in stock${soldStr} (${money(it.price)} each).`);
  }

  if (overview) {
    lines.push(
      `${org} has ${num(f.itemCount)} SKUs with ${num(f.totalStock)} units in stock (value ${money(f.inventoryValue)}).`
    );
    if (f.topSellers && f.topSellers.length)
      lines.push(`Top seller today: ${f.topSellers[0].name} (${num(f.topSellers[0].units)} units).`);
    const a = f.alertSummary || {};
    lines.push(`Open risk alerts — ${a.HIGH || 0} high, ${a.MEDIUM || 0} medium, ${a.LOW || 0} low.`);
    return lines.join(" ");
  }

  if (flags.value && !f.item) {
    lines.push(`Total inventory value in ${org} is ${money(f.inventoryValue)} across ${num(f.itemCount)} SKUs.`);
  }

  if (flags.stock && !f.item) {
    if (f.lowOrOut && f.lowOrOut.length) {
      const list = f.lowOrOut.map((i) => `${i.name} (${i.stock === 0 ? "out" : i.stock})`).join(", ");
      lines.push(`${f.lowOrOut.length} SKU(s) low or out of stock: ${list}.`);
    } else {
      lines.push(`All ${num(f.itemCount)} SKUs in ${org} are above the low-stock threshold of ${LOW_STOCK}.`);
    }
  }

  if (flags.sales && !f.item) {
    if (f.topSellers && f.topSellers.length) {
      const top = f.topSellers
        .slice(0, 3)
        .map((s) => `${s.name} (${num(s.units)})`)
        .join(", ");
      lines.push(`${num(f.totalSold)} units sold today. Top sellers: ${top}.`);
    } else {
      lines.push(`No sales recorded yet today in ${org}.`);
    }
  }

  if (flags.alerts) {
    const a = f.alertSummary || {};
    const scope = severity ? `${severity.toLowerCase()}-severity ` : "";
    if (f.openAlerts && f.openAlerts.length) {
      const top = f.openAlerts
        .slice(0, 3)
        .map((x) => `${RULE_LABEL[x.rule] || x.rule}${x.item ? ` on ${x.item}` : ""} (score ${x.score})`)
        .join("; ");
      lines.push(
        `${f.openAlerts.length} open ${scope}alert(s): ${top}. Totals — ${a.HIGH || 0} high, ${a.MEDIUM || 0} medium, ${a.LOW || 0} low.`
      );
    } else {
      lines.push(`No open ${scope}risk alerts right now — the stream is clean.`);
    }
  }

  return lines.join(" ") || `I can answer questions about stock, sales, inventory value, and risk alerts for ${org}.`;
}

// ─── Low-level LLM call. Returns a structured result (never throws) ─────────
// { ok, text, httpStatus, errType } so callers can distinguish quota/auth/etc.
async function callLLM(system, userMsg, maxTokens) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    if (LLM_PROVIDER === "anthropic") {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", "x-api-key": LLM_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: LLM_MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: userMsg }] }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, httpStatus: r.status, errType: d?.error?.type || "error" };
      return { ok: true, text: d.content?.[0]?.text?.trim() };
    }
    if (LLM_PROVIDER === "openai") {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_API_KEY}` },
        body: JSON.stringify({
          model: LLM_MODEL,
          max_tokens: maxTokens,
          messages: [{ role: "system", content: system }, { role: "user", content: userMsg }],
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, httpStatus: r.status, errType: d?.error?.code || d?.error?.type || "error" };
      return { ok: true, text: d.choices?.[0]?.message?.content?.trim() };
    }
    return { ok: false, errType: "no_provider" };
  } catch (e) {
    return { ok: false, errType: e.name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

function classifyError(res) {
  if (res.httpStatus === 401 || res.httpStatus === 403 || res.errType === "invalid_api_key") return "bad_key";
  if (res.httpStatus === 429 || res.errType === "insufficient_quota" || res.errType === "rate_limit_exceeded")
    return res.errType === "insufficient_quota" ? "no_quota" : "rate_limited";
  return "error";
}

// ─── Cached health probe so the UI badge reflects reality (not just "key set") ─
let _probe = { at: 0, status: null };
const PROBE_TTL_MS = 60000;
async function llmStatus() {
  if (!(LLM_PROVIDER && LLM_API_KEY)) return { configured: false, provider: "", status: "off" };
  const now = Date.now();
  if (_probe.status && now - _probe.at < PROBE_TTL_MS) return { configured: true, provider: LLM_PROVIDER, status: _probe.status };
  const res = await callLLM("You are a health check.", "ping", 1);
  _probe = { at: now, status: res.ok ? "live" : classifyError(res) };
  return { configured: true, provider: LLM_PROVIDER, status: _probe.status };
}

async function composeWithLLM(question, findings) {
  const system =
    "You are an operations-analyst assistant for a grocery inventory dashboard. " +
    "Answer the user's question using ONLY the JSON findings provided — never invent numbers or items. " +
    "Be concise (1-3 sentences), specific with the actual figures, and plain-spoken. " +
    "If the findings don't cover the question, say so briefly and suggest what they could ask.";
  const userMsg = `Question: ${question}\n\nFindings (the only data you may use):\n${JSON.stringify(findings)}`;
  const res = await callLLM(system, userMsg, 300);
  if (!res.ok) {
    _probe = { at: Date.now(), status: classifyError(res) }; // refresh badge from real traffic
    return null;
  }
  _probe = { at: Date.now(), status: "live" };
  return res.text || null;
}

// ─── Write path (human-in-the-loop): chat only *proposes* a restock; the user
// confirms, then executeAction() performs it. INCREASE-only, bounded, validated.
function isRestockIntent(q) {
  return /\b(restock|replenish|refill|top[ -]?up|stock up|order more|bring .*back)\b/i.test(q) ||
    /\b(add|increase)\b.*\bstock\b/i.test(q) ||
    /\bstock\b.*\b(up|more)\b/i.test(q);
}

function parseMagnitude(q) {
  const m = q.match(/\b(\d{1,5})\b/);
  const n = m ? parseInt(m[1], 10) : DEFAULT_RESTOCK;
  return Math.max(1, Math.min(MAX_RESTOCK, n));
}

async function proposeRestock(question, org) {
  const inv = await TOOLS.get_inventory(org);
  const used = [{ tool: "get_inventory", endpoint: `/organization/${org}` }];
  const orgName = inv.organizationName || org;
  const magnitude = parseMagnitude(question);
  const q = question.toLowerCase();

  // Scope: a bulk phrase ("all / everything / out of stock / low") vs a named item.
  let targets = [];
  if (/out of stock|oversell|phantom|sold out/.test(q)) {
    targets = inv.items.filter((i) => Number(i.stock) <= 0);
  } else if (/\b(all|every|everything|each|low)\b/.test(q)) {
    targets = inv.items.filter((i) => Number(i.stock) <= LOW_STOCK);
  } else {
    const match = inv.items.find((i) => q_includes(question, i.name));
    if (match) targets = [match];
  }

  if (!targets.length) {
    const named = /out of stock|all|every|everything|each|low/.test(q);
    const answer = named
      ? `Nothing is currently low or out of stock in ${orgName}, so there's nothing to restock.`
      : `I couldn't tell which item to restock. Try naming it, e.g. "restock Free-Range Eggs by 100", or "restock everything out of stock".`;
    return { answer, actions: [], used, mode: "proposal", findings: {} };
  }

  const actions = targets.map((i) => ({
    type: "restock",
    itemId: i.itemId,
    itemName: i.name,
    organizationId: org,
    magnitude,
    currentStock: Number(i.stock),
  }));

  const answer =
    actions.length === 1
      ? `Ready to restock ${actions[0].itemName} by ${actions[0].magnitude} units in ${orgName} (currently ${actions[0].currentStock}). Confirm to apply.`
      : `Ready to restock ${actions.length} item(s) in ${orgName} by ${magnitude} units each: ${actions
          .map((a) => `${a.itemName} (${a.currentStock})`)
          .join(", ")}. Confirm each below.`;

  return { answer, actions, used, mode: "proposal", findings: {} };
}

// Performs a confirmed restock. Hard-codes INCREASE so chat can never decrement.
function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

async function executeAction(action) {
  if (!action || action.type !== "restock") throw badRequest("Unsupported action (only 'restock' is allowed).");
  const itemId = String(action.itemId || "");
  const organizationId = String(action.organizationId || "");
  const magnitude = parseInt(action.magnitude, 10);
  if (!itemId || !organizationId) throw badRequest("itemId and organizationId are required.");
  if (!Number.isInteger(magnitude) || magnitude < 1 || magnitude > MAX_RESTOCK)
    throw badRequest(`magnitude must be an integer between 1 and ${MAX_RESTOCK}.`);

  const { status, data } = await apiPost(`/admin/${encodeURIComponent(itemId)}`, {
    operatorDirection: "INCREASE",
    operatorMagnitude: magnitude,
    organizationId,
  });
  if (status !== 200) {
    const e = new Error(data.error || `admin returned ${status}`);
    e.status = status;
    throw e;
  }
  return {
    ok: true,
    itemId,
    organizationId,
    magnitude,
    previousStock: data.previousStock,
    newStock: data.newStock,
    resolvedAlerts: data.resolvedAlerts || [],
  };
}

async function chatAnswer(question, organizationId) {
  // A restock request returns a *proposal* (with confirm actions), never a write.
  if (isRestockIntent(question)) return proposeRestock(question, organizationId);

  const gathered = await gather(question, organizationId);
  let mode = "deterministic";
  let answer = composeDeterministic(gathered);

  // Only attempt the LLM when it's configured and not known-unhealthy, to avoid
  // adding latency on every question when the account has no quota / bad key.
  if (LLM_PROVIDER && LLM_API_KEY) {
    const healthy = !_probe.status || _probe.status === "live" || Date.now() - _probe.at > PROBE_TTL_MS;
    if (healthy) {
      const llm = await composeWithLLM(question, gathered.findings);
      if (llm) {
        answer = llm;
        mode = `llm:${LLM_PROVIDER}`;
      }
    }
  }

  return { answer, mode, used: gathered.used, findings: gathered.findings };
}

module.exports = {
  chatAnswer,
  executeAction,
  llmStatus,
  llmEnabled: () => Boolean(LLM_PROVIDER && LLM_API_KEY),
};
