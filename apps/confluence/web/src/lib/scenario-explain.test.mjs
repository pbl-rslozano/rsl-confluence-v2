// Scenarios (WP22) — rule-based explanation and sheet notes, Task 3.
// Run: npm run test:scenario-explain   (node scripts/run-engine-tests.mjs scenario-explain.test.mjs)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXPLAIN_KEYS, volRegime, invalidation, nextMacroEvent, disagreeingBloc, explainScenarios, sheetNotes,
} from "./scenario-explain.ts";

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log("  ok   - " + name); }
  catch (e) { failed++; console.log("  FAIL - " + name + "\n         " + (e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n         ") : e)); }
};

const H = 3_600_000;
const T0 = 1_700_000_000_000; // open time of the last bar
const CLOSE = T0 + H; // its close

/** 30 bars; the last close is 100 and the lowest low / highest high of the last 20 bars are set by the caller. */
function bars(lo = 97, hi = 103) {
  const out = [];
  for (let i = 0; i < 30; i++) out.push({ time: T0 - (29 - i) * H, open: 100, high: hi - 1, low: lo + 1, close: 100, volume: 1 });
  out[20] = { ...out[20], low: lo, high: hi }; // inside the last 20 bars (index 10..29)
  out[0] = { ...out[0], low: 1, high: 999 }; // outside the window: must be ignored
  return out;
}

function result(over = {}) {
  const odds = {
    state: "up", fallback: null, matches: 300, nEff: 100, sigmaH: 0.02, withState: 300, sampled: 300,
    odds: { up: { p: 0.5, lo: 0.4, hi: 0.6, cases: 150 }, range: { p: 0.3, lo: 0.2, hi: 0.4, cases: 90 }, down: { p: 0.2, lo: 0.1, hi: 0.3, cases: 60 } },
    base: { up: 0.4, range: 0.3, down: 0.3 }, baseNEff: 120, ...(over.odds ?? {}),
  };
  const path = [{ open: 100, high: 101, low: 99, close: 100 }];
  return {
    key: "k", horizon: 6, lastClose: 100, lastTime: T0, barCount: 1000, bands: [], paths: { up: path, range: path, down: path },
    volPct: 50, widened: 15, atr: 2, ftNow: 40, ...over, odds,
  };
}

const confluence = (over = {}) => ({
  master: "BULLISH", strength: "MODERATE",
  blocs: [
    { bloc: "trend", score: 0.4 }, { bloc: "meanReversion", score: 0.1 }, { bloc: "breakout", score: 0.2 }, { bloc: "flow", score: 0.1 },
  ], ...over,
});

const fmt = {
  price: (p) => "$" + p.toFixed(2), pct: (f) => (f * 100).toFixed(3) + " %", time: (ms) => "t" + ms,
  label: (m, s) => `${m}/${s}`, event: (k) => "ev-" + k,
};

const run = (over = {}) => explainScenarios({
  result: result(over.result), confluence: confluence(over.confluence), bars: bars(), intervalMs: H, perp: null, events: [], ...over.x,
}, fmt);
const keys = (parts) => parts.map((p) => p.key);

test("parts come in the fixed order and every key exists in en.json", () => {
  const parts = run();
  assert.deepEqual(keys(parts), ["sc.x.trend.up", "sc.x.conf.agree", "sc.x.vol.normal", "sc.x.inval.below", "sc.x.sample"]);
  const en = JSON.parse(readFileSync(join(process.cwd(), "src", "rsl", "i18n", "en.json"), "utf8"));
  for (const k of EXPLAIN_KEYS) assert.ok(k in en, "en.json lacks " + k);
  const all = [
    ...parts, ...run({ result: { odds: { state: "down" }, widened: 30, volPct: 10 }, x: { perp: { fr: 0.0001, bp: 0.2 }, events: [{ id: "e", label: "x", kind: "cpi", at: CLOSE + 3 * H, verified: true }] } }),
    ...run({ result: { odds: { state: null, fallback: "noState", nEff: 5 }, widened: "all", volPct: NaN }, confluence: { master: "NEUTRAL" } }),
    ...sheetNotes(result({ odds: { fallback: "fewMatches", withState: 100 }, paths: { up: null, range: null, down: null } }), 2000),
  ];
  for (const p of all) assert.ok(EXPLAIN_KEYS.includes(p.key), p.key + " is not in EXPLAIN_KEYS");
});

test("invalidation picks the nearer of 2 x ATR and the 20-bar swing", () => {
  assert.deepEqual(invalidation(bars(97, 103), 2, "up"), { below: 97, above: null });
  assert.deepEqual(invalidation(bars(90, 103), 2, "up"), { below: 96, above: null });
  assert.deepEqual(invalidation(bars(97, 103), 2, "down"), { below: null, above: 103 });
  assert.deepEqual(invalidation(bars(97, 110), 2, "down"), { below: null, above: 104 });
  assert.deepEqual(invalidation(bars(97, 103), 2, "flat"), { below: 97, above: 103 });
  assert.deepEqual(invalidation(bars(90, 110), 2, null), { below: 96, above: 104 });
  assert.deepEqual(invalidation([], 2, "up"), { below: null, above: null });
});

test("volRegime cut-offs", () => {
  assert.equal(volRegime(32.9), "low");
  assert.equal(volRegime(33), "normal");
  assert.equal(volRegime(67), "normal");
  assert.equal(volRegime(67.1), "high");
});

test("disagreeing bloc", () => {
  const blocs = [{ bloc: "trend", score: 0.4 }, { bloc: "meanReversion", score: -0.3 }, { bloc: "flow", score: -0.1 }];
  assert.equal(disagreeingBloc({ master: "BULLISH", blocs }), "meanReversion");
  assert.equal(disagreeingBloc({ master: "BEARISH", blocs }), "trend");
  assert.equal(disagreeingBloc({ master: "NEUTRAL", blocs }), null);
  assert.equal(disagreeingBloc({ master: "BULLISH", blocs: [{ bloc: "trend", score: 0.4 }, { bloc: "flow", score: 0 }] }), null);
});

test("macro event only when verified and inside the horizon", () => {
  const ev = (h, verified) => ({ id: "e" + h, label: "x", kind: "fomc", at: CLOSE + h * H, verified });
  assert.equal(nextMacroEvent(CLOSE, CLOSE + 6 * H, [ev(3, true)]).id, "e3");
  assert.equal(nextMacroEvent(CLOSE, CLOSE + 6 * H, [ev(3, false)]), null);
  assert.equal(nextMacroEvent(CLOSE, CLOSE + 6 * H, [ev(7, true)]), null);
  assert.equal(nextMacroEvent(CLOSE, CLOSE + 6 * H, [ev(0, true)]), null, "after is exclusive");
  assert.equal(nextMacroEvent(CLOSE, CLOSE + 6 * H, [ev(6, true)]).id, "e6", "until is inclusive");
  assert.equal(nextMacroEvent(CLOSE, CLOSE + 6 * H, [ev(5, true), ev(2, true)]).id, "e2", "first by time");
  const inside = run({ x: { events: [ev(3, true)] } });
  const m = inside.find((p) => p.key === "sc.x.macro");
  assert.deepEqual(m.vars, { event: "ev-fomc", when: "t" + (CLOSE + 3 * H) });
  assert.ok(keys(inside).indexOf("sc.x.macro") > keys(inside).indexOf("sc.x.inval.below") && keys(inside).indexOf("sc.x.macro") < keys(inside).indexOf("sc.x.sample"));
  assert.ok(!keys(run({ x: { events: [ev(3, false)] } })).includes("sc.x.macro"));
  assert.ok(!keys(run({ x: { events: [ev(7, true)] } })).includes("sc.x.macro"));
  // H = 24 widens the window: a 7 h event is now inside.
  assert.ok(keys(run({ result: { horizon: 24 }, x: { events: [ev(7, true)] } })).includes("sc.x.macro"));
});

test("perp line only for a perp with values", () => {
  const withPerp = (perp) => run({ x: { perp } });
  assert.ok(!keys(withPerp(null)).some((k) => k.startsWith("sc.x.perp")));
  assert.ok(!keys(withPerp({ fr: null, bp: null })).some((k) => k.startsWith("sc.x.perp")));
  const f = withPerp({ fr: 0.0001, bp: null }).find((p) => p.key.startsWith("sc.x.perp"));
  assert.equal(f.key, "sc.x.perpFunding");
  assert.deepEqual(f.vars, { fr: "0.010 %" });
  const b = withPerp({ fr: null, bp: 0.25 }).find((p) => p.key.startsWith("sc.x.perp"));
  assert.equal(b.key, "sc.x.perpBasis");
  assert.deepEqual(b.vars, { bp: "0.250 %" }, "bp is already a percent");
  const both = withPerp({ fr: 0.0001, bp: 0.25 }).find((p) => p.key.startsWith("sc.x.perp"));
  assert.equal(both.key, "sc.x.perp");
  assert.deepEqual(both.vars, { fr: "0.010 %", bp: "0.250 %" });
  const k = keys(withPerp({ fr: 0.0001, bp: 0.25 }));
  assert.equal(k[k.length - 2], "sc.x.perp");
});

test("widened note", () => {
  const w30 = run({ result: { widened: 30 } });
  assert.deepEqual(w30.find((p) => p.key === "sc.x.widened").vars, { band: 30 });
  const k = keys(w30);
  assert.equal(k[k.indexOf("sc.x.vol.normal") + 1], "sc.x.widened");
  assert.ok(keys(run({ result: { widened: "all" } })).includes("sc.x.widenedAll"));
  const k15 = keys(run());
  assert.ok(!k15.includes("sc.x.widened") && !k15.includes("sc.x.widenedAll"));
});

test("unknown volatility emits no vol part but still the widened note", () => {
  const k = keys(run({ result: { volPct: NaN, widened: "all" } }));
  assert.ok(!k.some((x) => x.startsWith("sc.x.vol.")));
  assert.ok(k.includes("sc.x.widenedAll"));
  assert.ok(!keys(run({ result: { volPct: NaN } })).some((x) => x.startsWith("sc.x.vol.") || x.includes("widened")));
});

test("trend, confluence and sample parts", () => {
  assert.deepEqual(run().slice(0, 2), [
    { key: "sc.x.trend.up", vars: { ft: "+40" } },
    { key: "sc.x.conf.agree", vars: { label: "BULLISH/MODERATE" } },
  ]);
  assert.deepEqual(run({ result: { odds: { state: "down" }, ftNow: -22 } })[0], { key: "sc.x.trend.down", vars: { ft: "-22" } });
  const flat = run({ result: { odds: { state: "flat" }, ftNow: 3 } });
  assert.equal(flat[0].key, "sc.x.trend.flat");
  assert.ok(keys(flat).includes("sc.x.inval.range"));
  assert.deepEqual(flat.find((p) => p.key === "sc.x.inval.range").vars, { hi: "$103.00", lo: "$97.00" });
  const none = run({ result: { odds: { state: null, fallback: "noState" }, ftNow: null } });
  assert.equal(none[0].key, "sc.x.trend.none");
  assert.deepEqual(run({ confluence: { master: "NEUTRAL" } })[1], { key: "sc.x.conf.neutral" });
  const blocs = [{ bloc: "trend", score: 0.4 }, { bloc: "meanReversion", score: -0.3 }];
  assert.deepEqual(run({ confluence: { blocs } })[1], { key: "sc.x.conf.bloc", vars: { label: "BULLISH/MODERATE", bloc: "sc.bloc.meanReversion" } });
  assert.deepEqual(run().at(-1), { key: "sc.x.sample", vars: { neff: 100 } });
  assert.deepEqual(run({ result: { odds: { nEff: 12.34 } } }).at(-1), { key: "sc.x.sampleSmall", vars: { neff: 12.3 } });
  assert.equal(run({ result: { odds: { nEff: 20 } } }).at(-1).key, "sc.x.sample");
  assert.deepEqual(run({ result: { odds: { state: "down" } } }).find((p) => p.key.startsWith("sc.x.inval")), { key: "sc.x.inval.above", vars: { level: "$103.00" } });
});

test("sheetNotes", () => {
  const r = (o = {}, p = {}) => result({ odds: o, ...p });
  assert.deepEqual(sheetNotes(r(), 1000), []);
  assert.ok(!keys(sheetNotes(r(), 1000)).includes("sc.recorded"));
  assert.deepEqual(keys(sheetNotes(r(), 1001)), ["sc.recorded"]);
  assert.equal(sheetNotes(r({ fallback: "fewMatches" }), 1000)[0].key, "sc.fallback.few");
  assert.equal(sheetNotes(r({ fallback: "noState", state: null }), 1000)[0].key, "sc.fallback.noState");
  const cov = sheetNotes(r({ withState: 300, sampled: 488 }), 1000);
  assert.deepEqual(cov, [{ key: "sc.stateCoverage", vars: { n: 300, m: 488 } }]);
  assert.ok(!keys(sheetNotes(r({ withState: 0, sampled: 488 }), 1000)).includes("sc.stateCoverage"));
  assert.ok(!keys(sheetNotes(r({ withState: 488, sampled: 488 }), 1000)).includes("sc.stateCoverage"));
  const np = result({ odds: { fallback: "fewMatches", withState: 10, sampled: 20 } });
  np.paths.range = null;
  assert.deepEqual(keys(sheetNotes(np, 5000)), ["sc.fallback.few", "sc.stateCoverage", "sc.recorded", "sc.noPath"]);
});

test("no text is generated outside the catalog", () => {
  const parts = [
    ...run({ result: { odds: { state: "flat", nEff: 3 }, widened: 30 }, x: { perp: { fr: 0.001, bp: 0.1 }, events: [{ id: "e", label: "free text", kind: "nfp", at: CLOSE + H, verified: true }] } }),
    ...run({ confluence: { blocs: [{ bloc: "trend", score: 0.4 }, { bloc: "flow", score: -0.5 }] } }),
    ...sheetNotes(result({ odds: { fallback: "fewMatches", withState: 1, sampled: 9 } }), 9999),
  ];
  assert.ok(parts.length > 8);
  for (const p of parts) {
    assert.ok(p.key.startsWith("sc."), p.key);
    for (const [name, v] of Object.entries(p.vars ?? {})) {
      assert.ok(["string", "number"].includes(typeof v), name);
      if (name === "bloc") assert.ok(String(v).startsWith("sc.bloc."));
      assert.ok(!/free text/.test(String(v)), "raw event label leaked into " + p.key);
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
