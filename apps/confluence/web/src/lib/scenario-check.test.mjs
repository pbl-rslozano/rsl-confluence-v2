// Scenarios (WP22) Task 8 — Scenario check: realised log return, Brier (three outcomes), band coverage.
// Run: npm run test:scenario-check   (node scripts/run-engine-tests.mjs scenario-check.test.mjs)
import assert from "node:assert/strict";
import { wilson, maxHoldSpan } from "./ledger-metrics.ts";
import { realizedLogReturn, brier3, scenarioCheck } from "./scenario-check.ts";

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log("  ok   - " + name); }
  catch (e) { failed++; console.log("  FAIL - " + name + "  [" + (e && e.message ? e.message.replace(/\n/g, " ") : e) + "]"); }
};

const H = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);
const bars = (n, skip = -1) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (i === skip) continue;
    const c = 100 * Math.exp(0.001 * i);
    out.push({ time: T0 + i * H, open: c, high: c, low: c, close: c, volume: 1 });
  }
  return out;
};
const row = (over = {}) => ({ id: "x", src: "binance", tf: "1h", pair: "BTCUSDT", t: T0, c: 100, ...over });

test("realizedLogReturn uses the signal close and the same span rule as measureOutcome", () => {
  const k = bars(20);
  const r = realizedLogReturn(row({ t: T0 + 2 * H, c: k[2].close }), k, 6, H);
  assert.ok(Math.abs(r - Math.log(k[8].close / k[2].close)) < 1e-12);
  assert.equal(realizedLogReturn(row({ t: T0 + 2 * H, c: 100 }), k, 6, H), Math.log(k[8].close / 100));
  const gap = bars(20, 5);
  assert.equal(realizedLogReturn(row({ t: T0 + 2 * H }), gap, 6, H), null);
  assert.equal(realizedLogReturn(row({ t: T0 + 17 * H }), k, 6, H), null);
  assert.equal(realizedLogReturn(row({ t: T0 + 99 * H }), k, 6, H), null);
});

test("maxHoldSpan keeps the half-bar slack and the monthly rule", () => {
  assert.equal(maxHoldSpan(6, H), 6 * H + H / 2);
  assert.equal(maxHoldSpan(3, 30 * 86_400_000), 3 * 31 * 86_400_000);
});

test("brier3 known values", () => {
  assert.equal(brier3([1, 0, 0], "up"), 0);
  assert.ok(Math.abs(brier3([1 / 3, 1 / 3, 1 / 3], "range") - 2 / 3) < 1e-12);
  assert.equal(brier3([0, 0, 1], "up"), 2);
});

const scb = [-0.05, -0.02, 0.02, 0.05];
const mk = (i, over = {}) => ({ id: "r" + i, src: "binance", tf: "1h", pair: "BTCUSDT", t: T0 + i * 6 * H, c: 100, scb, scp: { s: 1, p: [0.5, 0.3, 0.2], b: [0.4, 0.3, 0.3], w: 0.02, f: 0 }, ...over });

test("coverage counts and Wilson range", () => {
  const items = [];
  for (let i = 0; i < 10; i++) items.push({ row: mk(i), r: i < 7 ? 0.01 : 0.03 });
  const c = scenarioCheck(items, H);
  assert.equal(c.n, 10);
  assert.equal(c.cov68.rate, 0.7);
  assert.deepEqual(c.cov68.ci, wilson(7, 10));
  assert.equal(c.cov95.inside, 10);
});

test("windows overlapping within a series count once; series are thinned separately", () => {
  const one = [];
  for (let i = 0; i < 12; i++) one.push({ row: mk(0, { id: "o" + i, t: T0 + i * H }), r: 0.01 });
  assert.equal(scenarioCheck(one, H).n, 2);
  const two = one.concat(one.map((x) => ({ row: { ...x.row, id: "e" + x.row.id, pair: "ETHUSDT" }, r: 0.01 })));
  assert.equal(scenarioCheck(two, H).n, 4);
});

test("fallback rows are left out of Brier, kept in coverage", () => {
  const items = [
    { row: mk(0), r: 0.05 },
    { row: mk(1, { scp: { s: 1, p: [0.5, 0.3, 0.2], b: [0.4, 0.3, 0.3], w: 0.02, f: 1 } }), r: 0.0 },
  ];
  const c = scenarioCheck(items, H);
  assert.equal(c.cov68.n, 2);
  assert.equal(c.brier.n, 1);
  // r/w = 2.5 -> up
  assert.ok(Math.abs(c.brier.scenarios - brier3([0.5, 0.3, 0.2], "up")) < 1e-12);
  assert.ok(Math.abs(c.brier.base - brier3([0.4, 0.3, 0.3], "up")) < 1e-12);
  assert.equal(scenarioCheck([{ row: items[1].row, r: 0 }], H).brier, null);
});

test("empty input gives nulls and n 0; skipped is carried", () => {
  const c = scenarioCheck([], H, 3);
  assert.deepEqual(c, { n: 0, skipped: 3, cov68: null, cov95: null, brier: null });
});

console.log(`\nscenario-check: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
