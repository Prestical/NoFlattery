const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const usd = (n) => "$" + (n < 0.01 ? n.toFixed(6) : n.toFixed(4));
const list = (a, t = "ul") => (a && a.length ? `<${t}>${a.map((x) => `<li>${x}</li>`).join("")}</${t}>` : '<p class="muted">None.</p>');
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

let last = null;   // current report: the response object, incl. idea

// ---------------------------------------------------------------- setup ----
const showTot = (u) => { $("#tot").textContent = `Jev total: ${usd(u.total_cost)} · ${u.total_requests} analyses`; };
fetch("/api/usage").then((r) => r.json()).then(showTot).catch(() => {});
fetch("/api/config").then((r) => r.json()).then((c) => {
  $("#profile").innerHTML = c.profiles.map((p) => `<option value="${p.id}">${esc(p.label)} (${p.count}q)</option>`).join("");
  $("#profile").value = store.get("profile") || "personal";
  if (!$("#profile").value) $("#profile").value = "startup";
  const models = c.models.length ? c.models : [c.defaultModel];
  if (!models.includes(c.defaultModel)) models.unshift(c.defaultModel);
  $("#model").innerHTML = models.map((m) => `<option>${esc(m)}</option>`).join("");
  $("#model").value = store.get("model") && models.includes(store.get("model")) ? store.get("model") : c.defaultModel;
}).catch(() => {});
$("#profile").onchange = () => store.set("profile", $("#profile").value);
$("#model").onchange = () => store.set("model", $("#model").value);

// ------------------------------------------------------------- analyze -----
const words = (t) => new Set(t.toLowerCase().match(/[a-z0-9]{4,}/g) || []);
function similar(a, b) {   // Jaccard on words: is this a revision of the previous idea?
  const A = words(a), B = words(b); let i = 0;
  A.forEach((w) => B.has(w) && i++);
  return A.size && B.size ? i / (A.size + B.size - i) > 0.4 : false;
}

$("#go").onclick = async () => {
  const idea = $("#idea").value.trim();
  if (idea.length < 15) { $("#msg").textContent = "Write a bit more detail first."; return; }
  $("#go").disabled = true;
  $("#msg").className = "muted";
  $("#msg").textContent = "Jev is scoring, the LLM is explaining… (can take a minute)";
  try {
    const base = last && last.id && similar(idea, last.idea) ? last.id : undefined;
    const r = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idea, profile: $("#profile").value, model: $("#model").value, base }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.status);
    last = d;
    render(d);
    showTot(d.usage);
    $("#msg").textContent = "";
  } catch (e) {
    $("#msg").className = "err";
    $("#msg").textContent = "Error: " + e.message;
  }
  $("#go").disabled = false;
};

// -------------------------------------------------------------- render -----
const sign = (n) => (n > 0 ? "▲ +" : n < 0 ? "▼ " : "= ") + (n === 0 ? "0" : n);
const cls = (n) => (n > 0 ? "up" : n < 0 ? "down" : "same");

function render(d) {
  const a = d.analysis, f = d.facts, delta = d.delta;
  const tiles = d.scores.map((s) => {
    const conf = s.confidence != null ? ` · ${Math.round(s.confidence * 100)}%${s.confidence < s.low_conf ? ' <span class="low">⚠</span>' : ""}` : "";
    const dl = delta && delta.scores[s.id] ? ` <span class="${cls(delta.scores[s.id])}">${delta.scores[s.id] > 0 ? "+" : ""}${delta.scores[s.id]}</span>` : "";
    return `<div class="tile" title="${esc(s.question)}"><div class="t"><span>${esc(s.short)}${s.gate ? " <small>(gate)</small>" : ""}</span><span class="n">${s.score.toFixed(1)}<small>/4${conf}</small>${dl}</span></div>` +
      `<div class="bar"><i style="width:${(s.score / 4) * 100}%"></i></div><div class="l">${esc(s.label)}</div></div>`;
  }).join("");
  const n = d.scores.length, cols = n % 6 === 0 ? 6 : n % 5 === 0 ? 5 : n % 4 === 0 ? 4 : 6;
  const fact = (x) => `<b>${esc(x.short)}</b> ${x.score.toFixed(1)}/4 <small>${esc(x.label)}</small>`;
  const risks = (a.top_risks || []).slice(0, 3).map((x, i) =>
    `<section class="card"><h2>Risk ${i + 1}</h2><div class="risk"><b>${esc(x.risk)}</b><small>Mitigate: ${esc(x.mitigation)}</small><small>Watch for: ${esc(x.early_signal)}</small></div></section>`).join("")
    || `<section class="card"><h2>Top risks</h2><p class="muted">None.</p></section>`;
  const firm = d.range && !d.range.stable
    ? `<span class="warn">⚠ Low-confidence answers: could be ${d.range.possible.filter((v) => v !== d.verdict).join(" / ")}</span>` : `<span class="ok">Verdict firm</span>`;
  const pathTitle = d.verdict === "SHIP" ? "Next improvements" : `Path to SHIP · ${f.to_ship} point${f.to_ship === 1 ? "" : "s"} to go`;
  const path = (f.path || []).map((p) => `<li><b>${esc(p.short)}${p.gate ? " (gate)" : ""}</b> ${esc(p.now)} <span class="arrow">→</span> ${esc(p.next)} <small>(+${p.gain})</small></li>`).join("");

  $("#report").style.setProperty("--cols", cols);
  $("#report").innerHTML =
    `<div class="row r-head"><section class="card head"><div class="verdict"><span class="badge ${d.verdict}">${d.verdict} IT</span><small>${firm}</small></div>` +
      `<div class="why"><p>${esc(a.reason)}</p>${d.warning ? `<p class="err">${esc(d.warning)}</p>` : ""}</div>` +
      `<div class="meta"><b>${d.total}/100</b>${delta ? ` <span class="${cls(delta.total)}">${sign(delta.total)}</span>` : ""}<br>${esc(d.profile_label)}<br>${esc(d.source)}<br>${new Date(d.created).toLocaleString()}</div></section></div>` +
    `<div class="row print-only"><section class="card"><h2>Idea</h2><p class="idea">${esc(d.idea)}</p></section></div>` +
    `<div class="row r-scores"><section class="card"><h2>Scores (${n} questions, Jev)${delta ? ` · change vs previous run (${esc(delta.verdict)})` : ""}</h2><div class="scores">${tiles}</div></section></div>` +
    `<div class="row r3"><section class="card"><h2>Strengths</h2>${list(f.strengths.map(fact))}</section>` +
      `<section class="card"><h2>Weaknesses</h2>${list(f.weaknesses.map(fact))}</section>` +
      `<section class="card"><h2>Unsure answers (low Jev confidence)</h2>${f.unsure.length ? list(f.unsure.map((x) => `${fact(x)} <small>confidence ${Math.round(x.conf * 100)}%</small>`)) : '<p class="muted">Jev was confident on every answer.</p>'}</section></div>` +
    `<div class="row r3">${risks}</div>` +
    `<div class="row r-bottom"><section class="card"><h2>${pathTitle}</h2>${path ? `<ol class="path">${path}</ol>` : '<p class="muted">Nothing major left to improve.</p>'}</section>` +
      `<section class="card"><h2>Advice</h2>${list((a.advice || []).map(esc), "ol")}</section>` +
      `<section class="card"><h2>Test this week</h2><p>${esc(a.next_test) || "—"}</p></section></div>` +
    `<div class="row r-foot"><footer class="card foot"><span>Jev: ${d.usage.input_tokens.toLocaleString()} input tokens · ${usd(d.usage.cost)}</span><span>Explained by ${esc(d.model)}</span></footer></div>`;
  document.body.classList.add("has-report");
  $("#report").hidden = false;
  $("#out-actions").hidden = false;
  scrollTo(0, 0);
}

// ------------------------------------------------------------- history -----
let histData = [], histSort = "date";
async function openHistory() {
  $("#hist").hidden = false;
  $("#hist-list").innerHTML = '<p class="muted">Loading…</p>';
  try { histData = await fetch("/api/history").then((r) => r.json()); } catch { histData = []; }
  drawHistory();
}
function drawHistory() {
  const rows = [...histData].sort((a, b) => histSort === "score" ? b.total - a.total : b.created.localeCompare(a.created));
  $("#hist-list").innerHTML = rows.length ? rows.map((r) =>
    `<div class="h-item" data-id="${esc(r.id)}"><span class="badge-s ${esc(r.verdict)}">${esc(r.verdict)}</span><b>${esc(r.total)}</b>` +
    `<span class="h-title">${esc(r.title)}<small>${esc(r.profile)} · ${new Date(r.created).toLocaleString()}</small></span>` +
    `<button class="ghost del" data-del="${esc(r.id)}" title="Delete">✕</button></div>`).join("") : '<p class="muted">No saved reports yet.</p>';
}
$("#hist-btn").onclick = openHistory;
$("#hist-close").onclick = () => { $("#hist").hidden = true; };
$("#hist").onclick = (e) => { if (e.target.id === "hist") $("#hist").hidden = true; };
$("#sort-date").onclick = () => { histSort = "date"; $("#sort-date").classList.add("on"); $("#sort-score").classList.remove("on"); drawHistory(); };
$("#sort-score").onclick = () => { histSort = "score"; $("#sort-score").classList.add("on"); $("#sort-date").classList.remove("on"); drawHistory(); };
$("#hist-list").onclick = async (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    if (!confirm("Delete this saved report?")) return;
    await fetch("/api/history/" + del.dataset.del, { method: "DELETE" });
    histData = histData.filter((r) => r.id !== del.dataset.del);
    return drawHistory();
  }
  const item = e.target.closest("[data-id]");
  if (!item) return;
  const r = await fetch("/api/history/" + item.dataset.id).then((x) => x.json());
  last = { ...r.d, idea: r.idea, id: r.id };
  $("#idea").value = r.idea;
  if ($("#profile").querySelector(`option[value="${r.profile}"]`)) $("#profile").value = r.profile;
  render(last);
  $("#hist").hidden = true;
};

// -------------------------------------------------------------- export -----
function markdown(d) {
  const a = d.analysis, f = d.facts;
  const ul = (x) => (x || []).map((i) => "- " + i).join("\n") || "- None";
  const fact = (x) => `**${x.short}** ${x.score.toFixed(1)}/4 (${x.label})`;
  return `# Idea Report\n\n**Verdict:** ${d.verdict} (${d.total}/100) · ${d.profile_label} · ${d.source} · ${new Date(d.created).toLocaleString()}\n\n## Idea\n${d.idea}\n\n## Reason\n${a.reason}\n\n## Scores\n` +
    d.scores.map((s) => `- **${s.short}${s.gate ? " (gate)" : ""}** ${s.score.toFixed(1)}/4: ${s.label}`).join("\n") +
    `\n\n## Strengths\n${ul(f.strengths.map(fact))}\n\n## Weaknesses\n${ul(f.weaknesses.map(fact))}\n\n## Unsure answers (low Jev confidence)\n${ul(f.unsure.map((x) => fact(x) + ` confidence ${Math.round(x.conf * 100)}%`))}\n\n## Top 3 risks\n` +
    (a.top_risks || []).map((x) => `- **${x.risk}** | Mitigation: ${x.mitigation} | Early signal: ${x.early_signal}`).join("\n") +
    `\n\n## ${d.verdict === "SHIP" ? "Next improvements" : "Path to SHIP (" + f.to_ship + " points to go)"}\n` + (f.path || []).map((p, i) => `${i + 1}. **${p.short}**: ${p.now} → ${p.next} (+${p.gain})`).join("\n") +
    `\n\n## Advice\n` + (a.advice || []).map((x, i) => `${i + 1}. ${x}`).join("\n") +
    `\n\n## Test this week\n${a.next_test}\n\n---\nJev: ${d.usage.input_tokens} input tokens, ${usd(d.usage.cost)}. Explained by ${d.model}.\n`;
}

function download(name, text, type) {
  const el = document.createElement("a");
  el.href = URL.createObjectURL(new Blob([text], { type }));
  el.download = name;
  el.click();
  URL.revokeObjectURL(el.href);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

// One-page print: apply print layout, measure, then scale (down or a little up) so the report fills one A4 page.
function fitOnePage() {
  const root = document.documentElement, rep = $("#report");
  root.classList.add("pm");
  rep.style.zoom = ""; rep.style.width = "";
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;height:281mm;width:1px";
  document.body.appendChild(probe);
  const page = probe.offsetHeight; probe.remove();
  const target = page * 0.93;   // print renders a bit taller than it measures, so leave headroom
  const h = () => rep.getBoundingClientRect().height;
  let s = 1;
  for (let i = 0; i < 6; i++) {   // re-wrap at the new width, re-measure
    const need = h() > target || (h() < target * 0.95 && s < 1.2);
    if (!need) break;
    s = Math.min(1.2, Math.max(0.4, s * (target / h()) * 0.99));
    rep.style.zoom = s; rep.style.width = 194 / s + "mm";
  }
}
window.addEventListener("beforeprint", () => { if (last) fitOnePage(); });
window.addEventListener("afterprint", () => {
  document.documentElement.classList.remove("pm");
  const rep = $("#report"); rep.style.zoom = ""; rep.style.width = "";
});
$("#print").onclick = () => print();
$("#md").onclick = () => last && download(`idea-report-${stamp()}.md`, markdown(last), "text/markdown");
$("#html").onclick = async () => {
  if (!last) return;
  const css = await fetch("style.css").then((r) => r.text());
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Idea Report</title><style>${css}@media screen{html,body{height:auto}.report{display:block;height:auto;max-width:1000px;margin:0 auto;padding:10px}.row{margin-bottom:10px}.row>.card{overflow:visible}.report>.print-only{display:block}}</style></head><body><article class="report" style="--cols:${$("#report").style.getPropertyValue("--cols")}">${$("#report").innerHTML}</article></body></html>`;
  download(`idea-report-${stamp()}.html`, body, "text/html");
};
