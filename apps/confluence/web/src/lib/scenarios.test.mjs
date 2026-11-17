// Scenarios (WP22) — candle block-bootstrap simulation, Task 1.
// Run: npm run test:scenarios   (node scripts/run-engine-tests.mjs scenarios.test.mjs)
import assert from "node:assert/strict";
import { rng } from "./ledger-metrics.ts";
import {
  SC_PATHS, SC_STEPS, SC_BLOCK, SC_MIN_BARS,
  scenarioSeed, quantile7, simulate, eligibleStartsForTests,
} from "./scenarios.ts";

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log("  ok   - " + name); }
  catch (e) { failed++; console.log("  FAIL - " + name + "  [" + (e && e.message ? e.message.replace(/\n/g, " ") : e) + "]"); }
};

const H = 3_600_000;
/** Deterministic GBM-like candles. volAt(i) overrides the per-bar volatility. */
function series(n, { drift = 0, vol = 0.01, seed = 7, t0 = 1_700_000_000_000, intervalMs = H, volAt, times } = {}) {
  const r = rng(seed);
  const z = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  const out = [];
  let c = 100;
  for (let i = 0; i < n; i++) {
    const v = volAt ? volAt(i) : vol;
    const o = c;
    const cl = o * Math.exp(drift + v * z());
    const hi = Math.max(o, cl) * (1 + Math.abs(v * z()) * 0.5);
    const lo = Math.min(o, cl) * (1 - Math.abs(v * z()) * 0.5);
    out.push({ time: times ? times[i] : t0 + i * intervalMs, open: o, high: hi, low: lo, close: cl, volume: 1 });
    c = cl;
  }
  return out;
}

test("seed is FNV-1a of pair|tf|time", () => {
  const s = "BTCUSDT|1h|1700000000000";
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  assert.equal(scenarioSeed("BTCUSDT", "1h", 1700000000000), h >>> 0);
  assert.notEqual(scenarioSeed("BTCUSDT", "1h", 1700003600000), h >>> 0);
});

test("299 bars -> null, 300 bars -> simulation", () => {
  assert.equal(SC_MIN_BARS, 300);
  assert.equal(simulate(series(299), H, 1), null);
  const sim = simulate(series(300), H, 1);
  assert.ok(sim);
  assert.equal(sim.paths.length, SC_PATHS);
  assert.ok(sim.paths.every((p) => p.length === SC_STEPS));
  assert.equal(sim.bands.length, 24);
});

test("same bars and seed -> identical simulation; other seed differs", () => {
  const b = series(500);
  assert.deepEqual(simulate(b, H, 5), simulate(structuredClone(b), H, 5));
  assert.notDeepEqual(simulate(b, H, 5).paths[0], simulate(b, H, 6).paths[0]);
});

test("quantiles are type 7 and bands are ordered", () => {
  assert.ok(Math.abs(quantile7([1, 2, 3, 4], 0.16) - 1.48) < 1e-12);
  assert.equal(quantile7([5], 0.5), 5);
  const sim = simulate(series(500), H, 3);
  for (const b of sim.bands) assert.ok(b.p025 <= b.p16 && b.p16 <= b.p50 && b.p50 <= b.p84 && b.p84 <= b.p975);
});

test("direction-neutral: a strong uptrend gives a centred fan", () => {
  const bars = series(600, { drift: 0.01, vol: 0.01 });
  const last = bars[bars.length - 1].close;
  const sim = simulate(bars, H, 11);
  const logs = sim.paths.map((p) => Math.log(p[p.length - 1].close / last));
  const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
  const sd = Math.sqrt(logs.reduce((a, b) => a + (b - mean) ** 2, 0) / (logs.length - 1));
  assert.ok(Math.abs(mean) < 0.25 * sd, `mean ${mean} sd ${sd}`);
  assert.ok(Math.abs(sim.bands[23].p50 / last - 1) < 0.02);
});

test("candles stay consistent and path 0 step 1 matches the drawn relative candle", () => {
  const bars = series(500, { seed: 21 });
  const seed = 99;
  const sim = simulate(bars, H, seed);
  for (const p of sim.paths) for (const c of p) {
    assert.ok(c.low <= Math.min(c.open, c.close) + 1e-12);
    assert.ok(c.high >= Math.max(c.open, c.close) - 1e-12);
  }
  const starts = eligibleStartsForTests(bars, H, sim.widened);
  assert.equal(starts.length, sim.blocks);
  const j = starts[Math.floor(rng(seed)() * starts.length)];
  const lastClose = bars[bars.length - 1].close;
  const expectOpen = (bars[j].open / bars[j - 1].close) * Math.exp(-sim.mu);
  assert.ok(Math.abs(sim.paths[0][0].open / lastClose - expectOpen) < 1e-12);
  const expectClose = (bars[j].close / bars[j - 1].close) * Math.exp(-sim.mu);
  assert.ok(Math.abs(sim.paths[0][0].close / lastClose - expectClose) < 1e-12);
});

test("a gap is never bridged", () => {
  const bars = series(600, { times: Array.from({ length: 600 }, (_, i) => 1_700_000_000_000 + (i >= 400 ? i + 1 : i) * H) });
  for (const band of [15, 30, "all"]) {
    const starts = eligibleStartsForTests(bars, H, band);
    assert.ok(starts.length > 0);
    assert.ok(!starts.some((j) => j <= 400 && 400 <= j + SC_BLOCK - 1), `band ${band}`);
  }
  assert.ok(simulate(bars, H, 1));
});

test("too few bars in today's band widens to 30, then all; uniform stays 15", () => {
  // Percentile bands are rank-based, so a thin band needs ties or broken contiguity (a gap every 7th bar
  // leaves one valid block start per 7 bars: ±15 is thin, ±30 is enough).
  const sparse = (n) => Array.from({ length: n }, (_, i) => 1_700_000_000_000 + (i + Math.floor(i / 7)) * H);
  const mid = simulate(series(320, { times: sparse(320) }), H, 1);
  assert.equal(mid.widened, 30, `widened=${mid.widened} blocks=${mid.blocks}`);
  assert.ok(mid.blocks >= 20);
  // Flat candles (zero range, exact ATR ties) for 290 bars, then 10 wild bars: only 4 starts sit near today's percentile.
  const flat = series(300, { volAt: (i) => (i >= 290 ? 0.1 : 0) });
  for (let i = 0; i < 290; i++) { const c = flat[0].open; Object.assign(flat[i], { open: c, high: c, low: c, close: c }); }
  const calmThenWild = simulate(flat, H, 1);
  assert.ok(calmThenWild, "simulates");
  assert.equal(calmThenWild.widened, "all", `widened=${calmThenWild.widened}`);
  assert.equal(simulate(series(600, { vol: 0.01 }), H, 1).widened, 15);
});

test("1M bars of 28-31 days are contiguous", () => {
  const times = Array.from({ length: 400 }, (_, m) => Date.UTC(1990, m, 1));
  const sim = simulate(series(400, { times }), 30 * 86_400_000, 1);
  assert.ok(sim);
});

console.log(`\nscenarios: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
