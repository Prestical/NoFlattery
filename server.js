#!/usr/bin/env node
/**
 * NoFlattery: Kill / Fix / Ship  (local web app, no dependencies, Node 18+)
 * Flow: Idea input -> Jev scores the rubric -> rules derive verdict, strengths, weaknesses, unsure answers, path to SHIP
 *       -> local LLM (Ollama) writes the reason, risks, advice and this week's test.
 *
 * Run:  node server.js     then open http://localhost:<PORT>
 * Config comes only from .env: JEV_KEY, JEV_URL, JEV_MODEL, OLLAMA_URL, OLLAMA_MODEL, PORT (see .env.example).
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

// ------------------------------------------------------------------ CONFIG --
function loadEnv(file = path.join(__dirname, ".env")) {
  if (!fs.existsSync(file)) return;
  for (let line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    line = line.trim();
    const i = line.indexOf("=");
    if (!line || line.startsWith("#") || i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv();
const env = (k, d = "") => process.env[k] || d;

// Everything below comes from .env (no keys, URLs or model names are hard-coded). Checked at startup.
const JEV_URL = env("JEV_URL");
const JEV_KEY = env("JEV_KEY");
const JEV_MODEL = env("JEV_MODEL");
const JEV_PRICE_IN = parseFloat(env("JEV_PRICE_PER_M_INPUT", "0.042"));    // optional, USD per 1M tokens
const JEV_PRICE_OUT = parseFloat(env("JEV_PRICE_PER_M_OUTPUT", "0"));
const OLLAMA_URL = env("OLLAMA_URL");
const LLM_MODEL = env("OLLAMA_MODEL");
const PORT = parseInt(env("PORT"), 10);
const HISTORY_DIR = path.join(__dirname, "Reports", "history");
// Only this app's own origin may talk to the API (blocks cross-site requests and DNS rebinding).
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => "http://" + h));

// ---------------------------------------------------------------- RUBRIC ---
// Jev "score" questions, 5 ordered levels (index 0 = worst .. 4 = best). Gate questions can veto SHIP.
const QUESTIONS = [
  // kickoff checklist
  { id: "problem", short: "Problem", w: 3, gate: true, q: "How specific and painful is the problem the idea solves, for a clearly defined person or group?",
    levels: ["No real problem or no defined user", "Vague problem, vague user", "Real problem, but mild or broad user", "Clear, painful problem for a defined user", "Urgent, costly problem for a very specific user"] },
  { id: "why_now", short: "Why now", w: 2, gate: false, q: "How strong is the case for doing this now rather than later (timing, trend, trigger, deadline)?",
    levels: ["No reason to do it now, or timing is bad", "Could just as well be done any time", "Some timing tailwind, not compelling", "Clear trigger or trend that favors acting now", "Strong, time-limited window that will close"] },
  { id: "outcome", short: "Outcome", w: 2, gate: false, q: "How clearly does the idea define measurable outcomes that show it worked?",
    levels: ["No idea what success looks like", "Vague goals such as 'be successful'", "Goals exist but are hard to measure", "Concrete measurable outcomes, some without targets", "Specific metrics with targets and a time frame"] },
  { id: "scope", short: "Scope", w: 2, gate: false, q: "How clearly is it defined what will be delivered and what is explicitly out of scope?",
    levels: ["Undefined, could be anything", "Broad ambition, no boundaries", "Deliverable roughly clear, no exclusions", "Clear deliverable with some exclusions", "Tight deliverable with explicit exclusions"] },
  { id: "stakeholders", short: "Stakeholders", w: 1, gate: false, q: "How well are the key stakeholders, decision makers and likely blockers identified and manageable?",
    levels: ["Unaware of who must agree; likely blockers", "Stakeholders unclear, blockers probable", "Some identified, blockers unaddressed", "Mostly identified, blockers manageable", "All identified, decision path clear, no major blockers"] },
  { id: "feasible", short: "Feasibility", w: 2, gate: false, q: "How realistic is it to deliver with the resources, skills and time actually available?",
    levels: ["Impossible with current resources or technology", "Far beyond current skills, budget or time", "Possible but with big gaps in skills, money or time", "Achievable with minor gaps", "Fully covered by existing resources, skills and time"] },
  { id: "risk", short: "Risk", w: 2, gate: false, q: "How well are the biggest risks understood and controlled (fatal risks avoided, ways to mitigate or spot problems early)?",
    levels: ["Fatal risk likely, and no awareness of it", "Serious risks, no mitigation or early signals", "Risks known, mitigation weak", "Main risks known, mitigation and warning signs exist", "Risks low or fully mitigated, with early warning signals"] },
  { id: "opportunity", short: "Opportunity", w: 2, gate: false, q: "Considering what would be given up (time, money, focus), how likely is this the best use of that effort?",
    levels: ["Clearly a waste compared with alternatives", "Likely worse than other options", "Comparable to other options", "Probably better than most alternatives", "Clearly the best use of that effort"] },
  // extra idea-market checks
  { id: "demand", short: "Demand", w: 3, gate: true, q: "How much evidence is there that people want this (paying, complaining, using workarounds)?",
    levels: ["No evidence, pure assumption", "Only the founder's opinion", "Some anecdotal interest", "Multiple people showing real interest or workarounds", "Existing paying customers or a strong waitlist"] },
  { id: "diff", short: "Difference", w: 2, gate: false, q: "How clearly is this better or different from existing alternatives?",
    levels: ["Identical to existing options", "Slightly different, users would not notice", "Different, but easy to copy", "Clearly better on something users care about", "Unique, hard-to-copy advantage"] },
  { id: "money", short: "Money", w: 2, gate: false, q: "How believable is the way this earns money or creates value above its cost?",
    levels: ["No revenue or value model", "Model unclear or unrealistic", "Plausible, but margins look thin", "Clear model with reasonable margins", "Clear model, strong margins, proven willingness to pay"] },
  { id: "reach", short: "Reach", w: 1, gate: false, q: "How realistic is reaching the first 100 users without a huge budget?",
    levels: ["No idea how to reach users", "Only expensive paid channels", "Some channels, untested", "A clear, cheap channel that likely works", "Existing audience or built-in distribution"] },
];
const SHIP_MIN = 70, KILL_MAX = 40, GATE_MIN = 2.0, LOW_CONF = 0.5;

// Project types: which questions count, and how much. null = question dropped (not sent to Jev either).
const PROFILES = {
  startup: { label: "Startup / product", note: "A product for outside customers: market evidence, revenue and reaching users matter.", override: {} },
  team: { label: "Team / internal tool", note: "An internal tool for a team or organisation. Judge adoption inside that organisation, not outside market or revenue.",
    override: { diff: { w: 1 }, money: { w: 1 }, reach: null } },
  personal: { label: "Personal project", note: "A tool or project for the author's own use. There is no market, revenue or customer acquisition to judge. Judge the value to the author, feasibility and focus.",
    override: { demand: { w: 1, gate: false }, diff: { w: 1 }, money: null, reach: null } },
};

function questionsFor(profile) {
  const ov = (PROFILES[profile] || PROFILES.startup).override;
  return QUESTIONS.filter((q) => ov[q.id] !== null).map((q) => ({ ...q, ...(ov[q.id] || {}) }));
}

function decide(scores, qs = QUESTIONS) {
  const totalW = qs.reduce((a, q) => a + q.w, 0);
  const total = Math.round(qs.reduce((a, q) => a + (q.w * scores[q.id]) / 4, 0) / totalW * 100);
  const gatesOk = qs.filter((q) => q.gate).every((q) => scores[q.id] >= GATE_MIN);
  let verdict = "FIX";
  if (scores.problem < 0.5 || total < KILL_MAX) verdict = "KILL";
  else if (total >= SHIP_MIN && gatesOk) verdict = "SHIP";
  return { verdict, total };
}

// How firm is the verdict? Re-decide with every low-confidence answer moved one level either way.
function verdictRange(scores, conf, qs) {
  const shift = (d) => Object.fromEntries(qs.map((q) => {
    const low = conf[q.id] != null && conf[q.id] < LOW_CONF;
    return [q.id, low ? Math.max(0, Math.min(4, scores[q.id] + d)) : scores[q.id]];
  }));
  const set = new Set([decide(shift(-1), qs).verdict, decide(shift(1), qs).verdict, decide(scores, qs).verdict]);
  return { stable: set.size === 1, possible: [...set] };
}

// Rule-based facts: no LLM involved, so nothing can be hallucinated or misquoted.
function buildFacts(entries, qs, total, verdict) {
  const totalW = qs.reduce((a, q) => a + q.w, 0);
  const rows = qs.map((q) => ({ q, s: entries[q.id].score, label: entries[q.id].label, conf: entries[q.id].confidence }));
  const pick = (r) => ({ id: r.q.id, short: r.q.short, score: r.s, label: r.label, gate: r.q.gate });
  const strengths = rows.filter((r) => r.s >= 2.5).sort((a, b) => b.s - a.s).slice(0, 3).map(pick);
  const weaknesses = rows.filter((r) => r.s < 2.5).sort((a, b) => a.s - b.s).slice(0, 3).map(pick);
  // answers Jev itself was unsure about (distinct from weaknesses, which are low scores)
  const unsure = rows.filter((r) => r.conf != null && r.conf < LOW_CONF).sort((a, b) => a.conf - b.conf).slice(0, 4).map((r) => ({ ...pick(r), conf: r.conf }));
  const path = rows.filter((r) => Math.round(r.s) < 4 && r.s < (verdict === "SHIP" ? 3 : 4))
    .map((r) => {
      const next = Math.min(4, Math.round(r.s) + 1);   // level above the one shown (the label is levels[round(score)])
      return { r, next, gateBlock: r.q.gate && r.s < GATE_MIN, gain: (r.q.w * (next - r.s)) / 4 / totalW * 100 };
    })
    .sort((a, b) => (b.gateBlock - a.gateBlock) || (b.gain - a.gain))
    .slice(0, 3)
    .map((x) => ({ id: x.r.q.id, short: x.r.q.short, now: x.r.label, next: x.r.q.levels[x.next], gain: Math.round(x.gain * 10) / 10, gate: x.gateBlock }));
  return { strengths, weaknesses, unsure, path, to_ship: Math.max(0, SHIP_MIN - total) };
}

// ------------------------------------------------------------ COST TRACKER --
const USAGE_FILE = path.join(__dirname, "usage.json");
let TOTALS = { requests: 0, input_tokens: 0, output_tokens: 0, cost: 0 };
try { TOTALS = { ...TOTALS, ...JSON.parse(fs.readFileSync(USAGE_FILE, "utf8")) }; } catch {}

function recordUsage(i, o) {
  const c = (i / 1e6) * JEV_PRICE_IN + (o / 1e6) * JEV_PRICE_OUT;
  TOTALS.requests += 1; TOTALS.input_tokens += i; TOTALS.output_tokens += o; TOTALS.cost += c;
  try { fs.writeFileSync(USAGE_FILE, JSON.stringify(TOTALS)); } catch {}
  return c;
}
const usageTotals = () => ({ total_cost: TOTALS.cost, total_requests: TOTALS.requests, total_input_tokens: TOTALS.input_tokens });

// ------------------------------------------------------------- HTTP HELPERS -
class ApiError extends Error { constructor(msg, code = 0) { super(msg); this.code = code; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postJson(url, payload, { key = "", headers = {}, timeout = 600000 } = {}) {
  const h = { "Content-Type": "application/json", ...headers };
  if (key) h.Authorization = "Bearer " + key;
  const res = await fetch(url, { method: "POST", headers: h, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeout) });
  const text = await res.text();
  if (!res.ok) throw new ApiError(`HTTP ${res.status} from ${url.split("?")[0]}: ${text.slice(0, 400)}`, res.status);
  return JSON.parse(text);
}

async function llm(system, user, model = LLM_MODEL, attempts = 3) {
  let err;
  for (let i = 0; i < attempts; i++) {
    try {
      const data = await postJson(`${OLLAMA_URL}/api/chat`, {
        model, stream: false, format: "json", keep_alive: "30m", options: { temperature: 0.2, num_ctx: 4096, num_predict: 3000 },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      });
      const text = data.message && data.message.content;
      if (text && text.trim()) return text;
      err = new ApiError("The model returned an empty answer");
    } catch (e) {
      if (e instanceof ApiError && ![0, 429, 500, 502, 503, 504].includes(e.code)) throw e;
      if (e.cause && e.cause.code === "ECONNREFUSED") throw new Error(`Cannot reach Ollama at ${OLLAMA_URL}. Is it running?`);
      err = e instanceof TypeError ? new ApiError("Unexpected model response shape") : e;
    }
    await sleep(2000 * (i + 1));
  }
  throw err;
}

function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Model did not return JSON");
  return JSON.parse(m[0]);
}

// --------------------------------------------------------------------- JEV --
async function jevScore(idea, qs) {
  const questions = {};
  for (const q of qs) questions[q.id] = { type: "score", instructions: q.q, criteria: q.levels };
  const resp = await postJson(JEV_URL, { state: idea, model: JEV_MODEL, questions }, { key: JEV_KEY, timeout: 120000 });
  const out = {};
  for (const q of qs) {
    const a = resp.answers[q.id];
    const sc = Math.max(0, Math.min(4, parseFloat(a.score)));
    out[q.id] = { score: sc, confidence: a.confidence ?? null, label: q.levels[Math.round(sc)] };
  }
  return { scores: out, usage: resp.usage || {} };
}

// ------------------------------------------------------------------- LLM ----
// The LLM only writes prose (reason, risks, advice, test). Strengths/weaknesses/unsure answers are rule-based facts.
function normalizeAnalysis(a) {
  const str = (x) => (typeof x === "string" ? x : x && typeof x === "object" ? Object.values(x).join(" - ") : String(x ?? "")).trim();
  const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []).map(str).filter(Boolean);
  const risks = (Array.isArray(a.top_risks) ? a.top_risks : []).slice(0, 3).map((r) =>
    typeof r === "string" ? { risk: r, mitigation: "", early_signal: "" }
      : { risk: str(r.risk), mitigation: str(r.mitigation), early_signal: str(r.early_signal || r.earlySignal) });
  return { reason: str(a.reason), top_risks: risks, advice: arr(a.advice), next_test: str(a.next_test) };
}

const KEY_HELP = {
  reason: '"reason": str (2-4 sentences; name scores by question name; you MUST mention the single lowest-scoring question and its score, and one top strength)',
  top_risks: '"top_risks": [{"risk": str, "mitigation": str, "early_signal": str}] (exactly 3, specific to this idea)',
  advice: '"advice": [str] (3-5 concrete steps, one short sentence each; address the WEAKEST and TO IMPROVE items first; use only people, tools and numbers that appear in the idea)',
  next_test: '"next_test": str (one cheap experiment the author can run alone this week with what they already have; no new equipment or other people unless the idea names them)',
};

function missingKeys(a) {
  const m = [];
  if (!a.reason) m.push("reason");
  if (a.top_risks.length < 3 || a.top_risks.some((r) => !r.risk || !r.mitigation)) m.push("top_risks");
  if (!a.advice.length) m.push("advice");
  if (!a.next_test) m.push("next_test");
  return m;
}

function explainContext(idea, entries, qs, verdict, total, facts, profile) {
  const fmt = (r) => `${r.short} ${r.score.toFixed(1)}/4 (${r.label})`;
  return `PROJECT TYPE: ${PROFILES[profile].label}. ${PROFILES[profile].note}\n` +
    `IDEA:\n${idea}\n\nVERDICT: ${verdict} (score ${total}/100)\n\n` +
    `SCORES:\n${qs.map((q) => `- ${q.short}: ${entries[q.id].score.toFixed(1)}/4 (${entries[q.id].label})`).join("\n")}\n\n` +
    `STRONGEST: ${facts.strengths.map(fmt).join("; ") || "none"}\nWEAKEST: ${facts.weaknesses.map(fmt).join("; ") || "none"}\n` +
    `TO IMPROVE: ${facts.path.map((p) => `${p.short}: from "${p.now}" to "${p.next}"`).join("; ") || "nothing"}`;
}

async function explain(idea, entries, qs, verdict, total, facts, profile, model) {
  const ctx = explainContext(idea, entries, qs, verdict, total, facts, profile);
  const system = (keys) =>
    "You are a candid project advisor reviewing an idea before any work starts. A scoring system already classified it. " +
    "Do not change the verdict. Stay within the project type: never suggest market, revenue or user-acquisition work for a personal or internal project. " +
    "Only state facts from the idea and scores above. Reply ONLY with JSON containing exactly these keys: " + keys.map((k) => KEY_HELP[k]).join(", ");
  let a = null;
  for (let round = 0; round < 4; round++) {
    const keys = a ? missingKeys(a) : Object.keys(KEY_HELP);
    if (!keys.length) break;
    try {
      const got = normalizeAnalysis(extractJson(await llm(system(keys), ctx + (a ? `\n\nALREADY WRITTEN:\n${JSON.stringify(a)}` : ""), model)));
      if (!a) a = got;
      else for (const k of keys) {
        const v = got[k];
        if (Array.isArray(v) ? v.length : v) a[k] = v;
      }
    } catch (e) {
      if (!a && round >= 1) throw e;
    }
  }
  if (!a) throw new Error("The model returned nothing usable");
  return a;
}

// ----------------------------------------------------------------- HISTORY --
const safeId = (id) => /^[0-9]{8}-[0-9]{6}-[a-z0-9]{3}$/.test(id);
function saveReport(idea, profile, d) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const t = new Date(d.created).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const id = `${t}-${Math.random().toString(36).slice(2, 5).padEnd(3, "0")}`;
  fs.writeFileSync(path.join(HISTORY_DIR, id + ".json"), JSON.stringify({ id, idea, profile, d }));
  return id;
}
function loadReport(id) {
  if (!safeId(id)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, id + ".json"), "utf8")); } catch { return null; }
}
function listReports() {
  if (!fs.existsSync(HISTORY_DIR)) return [];
  return fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json")).map((f) => {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), "utf8"));
      return { id: r.id, title: r.idea.replace(/\s+/g, " ").slice(0, 70), verdict: r.d.verdict, total: r.d.total, created: r.d.created, profile: r.profile };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.created.localeCompare(a.created));
}

// ----------------------------------------------------------------- ANALYZE --
async function analyze(idea, { profile = "startup", model, base } = {}) {
  if (!Object.hasOwn(PROFILES, profile)) profile = "startup";
  const qs = questionsFor(profile);
  const { scores, usage } = await jevScore(idea, qs);
  const tin = parseInt(usage.input_tokens || 0, 10), tout = parseInt(usage.output_tokens || 0, 10);
  const cost = recordUsage(tin, tout);
  const plain = Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v.score]));
  const conf = Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v.confidence]));
  const { verdict, total } = decide(plain, qs);
  const facts = buildFacts(scores, qs, total, verdict);
  const range = verdictRange(plain, conf, qs);
  const usedModel = model || LLM_MODEL;
  let analysis, warning = "";
  try {
    analysis = await explain(idea, scores, qs, verdict, total, facts, profile, usedModel);
  } catch (e) {   // LLM down: still deliver the verdict, scores and rule-based facts
    warning = `The LLM could not write the explanation (${e.message}). Verdict, scores and facts are unaffected; click Categorize again to retry.`;
    analysis = { reason: "Explanation unavailable.", top_risks: [], advice: [], next_test: "" };
  }
  const d = {
    verdict, total, profile, profile_label: PROFILES[profile].label,
    scores: qs.map((q) => ({ id: q.id, short: q.short, question: q.q, gate: q.gate, weight: q.w, max: 4, low_conf: LOW_CONF, ...scores[q.id] })),
    facts, range, analysis, warning,
    usage: { input_tokens: tin, output_tokens: tout, cost, ...usageTotals() },
    source: `Jev (${JEV_MODEL})`,
    model: usedModel,
    created: new Date().toISOString(),
  };
  const prev = base && loadReport(base);   // before/after against an earlier version of this idea
  if (prev) {
    const old = Object.fromEntries(prev.d.scores.map((s) => [s.id, s.score]));
    d.delta = { total: total - prev.d.total, verdict: prev.d.verdict, scores: Object.fromEntries(d.scores.filter((s) => s.id in old).map((s) => [s.id, +(s.score - old[s.id]).toFixed(1)])) };
  }
  try { d.id = saveReport(idea, profile, d); } catch {}
  return d;
}

// ------------------------------------------------------------------ SERVER --
const PUBLIC = path.join(__dirname, "public");
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };

function send(res, code, body, type = "application/json") {
  const b = Buffer.from(body);
  res.writeHead(code, {
    "Content-Type": type + "; charset=utf-8", "Content-Length": b.length,
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
  });
  res.end(b);
}

async function ollamaModels() {
  try {
    const r = await fetch(OLLAMA_URL + "/api/tags", { signal: AbortSignal.timeout(2000) });
    return ((await r.json()).models || []).map((m) => m.name).sort();
  } catch { return []; }
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  try {
    if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 403, JSON.stringify({ error: "Forbidden host" }));
    if (req.method !== "GET") {
      if (req.headers.origin && !ALLOWED_ORIGINS.has(req.headers.origin)) return send(res, 403, JSON.stringify({ error: "Forbidden origin" }));
      if (req.method === "POST" && !/^application\/json\b/i.test(req.headers["content-type"] || "")) return send(res, 415, JSON.stringify({ error: "Content-Type must be application/json" }));
    }
    if (req.method === "GET" && url === "/api/usage") return send(res, 200, JSON.stringify(usageTotals()));
    if (req.method === "GET" && url === "/api/config") {
      return send(res, 200, JSON.stringify({
        defaultModel: LLM_MODEL, models: await ollamaModels(),
        profiles: Object.entries(PROFILES).map(([id, p]) => ({ id, label: p.label, count: questionsFor(id).length })),
      }));
    }
    if (req.method === "GET" && url === "/api/history") return send(res, 200, JSON.stringify(listReports()));
    const m = url.match(/^\/api\/history\/([\w-]+)$/);
    if (m) {
      const r = loadReport(m[1]);
      if (!r) return send(res, 404, JSON.stringify({ error: "Not found" }));
      if (req.method === "GET") return send(res, 200, JSON.stringify(r));
      if (req.method === "DELETE") { fs.unlinkSync(path.join(HISTORY_DIR, m[1] + ".json")); return send(res, 200, "{}"); }
    }
    if (req.method === "POST" && url === "/api/analyze") {
      let raw = "";
      for await (const c of req) { raw += c; if (raw.length > 100000) throw new Error("Request too large"); }
      const body = JSON.parse(raw);
      const idea = String(body.idea || "").trim().slice(0, 6000);
      if (idea.length < 15) throw new Error("Idea is too short");
      const model = typeof body.model === "string" && /^[\w.:\/-]{1,80}$/.test(body.model) ? body.model : undefined;
      return send(res, 200, JSON.stringify({ idea, ...(await analyze(idea, { profile: body.profile, model, base: body.base })) }));
    }
    if (req.method === "GET") {
      const file = path.normalize(path.join(PUBLIC, url === "/" ? "index.html" : url));
      if (file.startsWith(PUBLIC + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile())
        return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || "application/octet-stream");
    }
    send(res, 404, "{}");
  } catch (e) {
    send(res, 500, JSON.stringify({ error: `${e.name}: ${e.message}` }));
  }
});

function checkConfig() {
  const missing = ["JEV_KEY", "JEV_URL", "JEV_MODEL", "OLLAMA_URL", "OLLAMA_MODEL", "PORT"].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing in .env: ${missing.join(", ")} (see .env.example)`);
    process.exit(1);
  }
}

if (require.main === module) {
  checkConfig();
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`NoFlattery running:  http://localhost:${PORT}  (local only)`);
    console.log(`Scorer:    Jev ${JEV_MODEL}`);
    console.log(`Explainer: Ollama ${LLM_MODEL} at ${OLLAMA_URL}`);
  });
}

module.exports = { QUESTIONS, PROFILES, questionsFor, decide, verdictRange, buildFacts, normalizeAnalysis, missingKeys };
