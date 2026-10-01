const test = require("node:test");
const assert = require("node:assert");
const { QUESTIONS, questionsFor, decide, verdictRange, buildFacts, normalizeAnalysis, missingKeys } = require("../server.js");

const all = (v) => Object.fromEntries(QUESTIONS.map((q) => [q.id, v]));

test("verdict thresholds", () => {
  assert.strictEqual(decide(all(4)).verdict, "SHIP");
  assert.strictEqual(decide(all(1)).verdict, "KILL");        // total 25 < 40
  assert.strictEqual(decide(all(2.5)).verdict, "FIX");       // total 62 < 70
  assert.strictEqual(decide({ ...all(4), problem: 0.2 }).verdict, "KILL");
});

test("a failing gate blocks SHIP even with a high total", () => {
  const r = decide({ ...all(4), demand: 1 });
  assert.ok(r.total >= 70);
  assert.strictEqual(r.verdict, "FIX");
});

test("personal profile drops market questions and relaxes the demand gate", () => {
  const qs = questionsFor("personal");
  assert.ok(!qs.some((q) => q.id === "money" || q.id === "reach"));
  assert.strictEqual(qs.find((q) => q.id === "demand").gate, false);
  const scores = Object.fromEntries(qs.map((q) => [q.id, 3.5]));
  scores.demand = 0.9;
  assert.strictEqual(decide(scores, qs).verdict, "SHIP");
  assert.strictEqual(questionsFor("startup").length, 12);
});

test("low-confidence answers can make the verdict unstable", () => {
  const qs = questionsFor("startup");
  const scores = all(3.0), conf = all(0.9);
  assert.strictEqual(verdictRange(scores, conf, qs).stable, true);
  const lowConf = Object.fromEntries(qs.map((q) => [q.id, 0.1]));
  assert.strictEqual(verdictRange(all(2.9), lowConf, qs).stable, false);
});

test("facts are rule-based and the path to SHIP puts failing gates first", () => {
  const qs = questionsFor("startup");
  const entries = Object.fromEntries(qs.map((q) => [q.id, { score: 3, label: q.levels[3], confidence: 0.9 }]));
  entries.demand = { score: 0.4, label: qs.find((q) => q.id === "demand").levels[0], confidence: 0.9 };
  const dd = decide(Object.fromEntries(qs.map((q) => [q.id, entries[q.id].score])), qs);
  const f = buildFacts(entries, qs, dd.total, dd.verdict);
  assert.strictEqual(f.path[0].id, "demand");
    assert.ok(f.strengths.length === 3 && f.weaknesses[0].id === "demand");
});

test("model output is coerced to the expected shape and gaps are detected", () => {
  const a = normalizeAnalysis({ reason: "x", top_risks: ["only text"], advice: "single string" });
  assert.deepStrictEqual(a.advice, ["single string"]);
  assert.deepStrictEqual(missingKeys(a).sort(), ["next_test", "top_risks"]);
});

test("path for a SHIP verdict skips polishing items that already score 3+; unsure lists low-confidence answers", () => {
  const qs = questionsFor("personal");
  const entries = Object.fromEntries(qs.map((q) => [q.id, { score: 3.3, label: q.levels[3], confidence: 0.9 }]));
  entries.feasible = { score: 2.4, label: qs.find((q) => q.id === "feasible").levels[2], confidence: 0.3 };
  const f = buildFacts(entries, qs, 80, "SHIP");
  assert.deepStrictEqual(f.path.map((p) => p.id), ["feasible"]);
  assert.deepStrictEqual(f.unsure.map((u) => u.id), ["feasible"]);
});

test("every path step points at a level above the one shown", () => {
  const qs = questionsFor("startup");
  const entries = Object.fromEntries(qs.map((q) => [q.id, { score: 2.7, label: q.levels[3], confidence: 0.9 }]));
  const f = buildFacts(entries, qs, 60, "FIX");
  assert.ok(f.path.length);
  for (const p of f.path) assert.notStrictEqual(p.now, p.next);
});
