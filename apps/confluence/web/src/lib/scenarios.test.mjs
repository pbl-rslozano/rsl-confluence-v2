// Scenarios (WP22) — candle block-bootstrap simulation, Task 1.
// Run: npm run test:scenarios   (node scripts/run-engine-tests.mjs scenarios.test.mjs)
import assert from "node:assert/strict";
import { rng } from "./ledger-metrics.ts";
import { wilson, roundFt } from "./ledger-metrics.ts";
import { barCloseTime } from "./market-client.ts";
import { fundTrendSeries } from "./fund-trend.ts";
import { volPercentiles } from "./scenarios.ts";
import {
  SC_PATHS, SC_STEPS, SC_BLOCK, SC_MIN_BARS,
  scenarioSeed, quantile7, simulate, eligibleStartsForTests,
  SC_STATE_TH, SC_SAMPLE_EVERY, SC_MIN_NEFF, SC_BUCKET, SC_OFFICIAL_H,
  ftState, barClose, ftAtBars, bucketOf, scenarioOf, scenarioOrder, BUCKETS,
  scenarioOdds, pickPaths, scenarioKey, runScenarios, scenarioFields, volRegime,
} from "./scenarios.ts";
import { FT_MAX_STALE_MS } from "./fund-trend.ts";
import { applyFundTrend } from "./scan-record.ts";

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


// ---------------------------------------------------------------- Task 2: odds, paths, ledger fields
const DAYMS = 86_400_000;
const firstAtr = (bars) => volPercentiles(bars).atr.findIndex((v) => Number.isFinite(v));
const flatFt = (n, v) => new Array(n).fill(v);

test("constants", () => {
  assert.deepEqual([SC_STATE_TH, SC_SAMPLE_EVERY, SC_MIN_NEFF, SC_BUCKET, SC_OFFICIAL_H], [15, 2, 20, 0.5, 6]);
  assert.equal(FT_MAX_STALE_MS, 36 * 3_600_000);
});

test("ftState thresholds", () => {
  assert.equal(ftState(-15), "down");
  assert.equal(ftState(-14.9), "flat");
  assert.equal(ftState(15), "up");
  assert.equal(ftState(14.9), "flat");
  assert.equal(ftState(0), "flat");
  assert.equal(ftState(null), null);
  assert.equal(ftState(undefined), null);
  assert.equal(ftState(NaN), null);
  assert.equal(ftState(Infinity), null);
});

test("barClose matches market-client for 1h, 1d, 1w and 1M", () => {
  const cases = [
    [Date.UTC(2026, 10, 17, 5), 3_600_000],
    [Date.UTC(2026, 10, 17), DAYMS],
    [Date.UTC(2026, 10, 16), 7 * DAYMS],
    [Date.UTC(2026, 1, 1), 30 * DAYMS],
    [Date.UTC(2026, 11, 1), 30 * DAYMS],
  ];
  for (const [t, ms] of cases) assert.equal(barClose(t, ms), barCloseTime(t, ms), `${t} ${ms}`);
});

/** daily history ending at `dailyEnd` (close of the newest daily bar) + hourly bars whose last close is dailyEnd + gapH hours. */
function ftFixture(nHourly, gapH) {
  const dailyEnd = Date.UTC(2026, 5, 1);
  const nd = 600;
  const daily = series(nd, { vol: 0.02, seed: 3, t0: dailyEnd - nd * DAYMS, intervalMs: DAYMS });
  const t0 = dailyEnd + gapH * H - nHourly * H;
  const bars = series(nHourly, { seed: 9, t0 });
  return { daily, bars };
}

test("ftAtBars has no look-ahead and nulls stale values", () => {
  const { daily, bars } = ftFixture(1000, 72);
  const out = ftAtBars(daily, bars, H);
  assert.equal(out.length, bars.length);
  for (let j = 0; j < 36; j++) assert.equal(out[bars.length - 1 - j], null, `j=${j}`);
  assert.notEqual(out[bars.length - 37], null);
  const raw = fundTrendSeries(daily, bars.map((b) => ({ time: b.time, closeTime: b.time + H })));
  for (let i = 0; i < bars.length; i++) if (out[i] !== null) assert.equal(out[i], roundFt(raw[i]));
  assert.equal(ftAtBars(null, bars, H).every((v) => v === null), true);
  // fresh daily data -> the last bar has a value
  const fresh = ftFixture(1000, 1);
  assert.notEqual(ftAtBars(fresh.daily, fresh.bars, H)[999], null);
});

test("bucketOf / scenarioOf / scenarioOrder", () => {
  assert.equal(bucketOf(0.5), "range");
  assert.equal(bucketOf(0.51), "up");
  assert.equal(bucketOf(-0.5), "range");
  assert.equal(bucketOf(-0.51), "down");
  assert.deepEqual([...BUCKETS], ["up", "range", "down"]);
  assert.equal(scenarioOf("down", "down"), "continue");
  assert.equal(scenarioOf("up", "down"), "reverse");
  assert.equal(scenarioOf("range", "down"), "pause");
  assert.equal(scenarioOf("up", "up"), "continue");
  assert.equal(scenarioOf("down", "up"), "reverse");
  assert.equal(scenarioOf("range", "flat"), "range");
  assert.equal(scenarioOf("up", null), "up");
  assert.deepEqual(scenarioOrder("up"), ["continue", "pause", "reverse"]);
  assert.deepEqual(scenarioOrder("down"), ["continue", "pause", "reverse"]);
  assert.deepEqual(scenarioOrder("flat"), ["up", "range", "down"]);
  assert.deepEqual(scenarioOrder(null), ["up", "range", "down"]);
});

test("sampling starts at the newest bar with a known outcome, every 2 bars", () => {
  const bars = series(400, { seed: 4 });
  const o = scenarioOdds(bars, flatFt(400, 20), 6, H);
  const first = firstAtr(bars);
  assert.equal(o.sampled, Math.floor((399 - 6 - first) / 2) + 1);
});

test("an outcome window over a gap is left out", () => {
  const n = 400;
  const bars = series(n, { seed: 4 });
  const gapped = series(n, { seed: 4, times: Array.from({ length: n }, (_, i) => 1_700_000_000_000 + (i >= 200 ? i + 1 : i) * H) });
  const a = scenarioOdds(bars, flatFt(n, 20), 6, H);
  const b = scenarioOdds(gapped, flatFt(n, 20), 6, H);
  // sampled i are odd (393, 391, ...); i in 194..199 span the gap: 195, 197, 199
  assert.equal(b.sampled, a.sampled - 3);
});

test("n_eff = matches x 2 / H", () => {
  const bars = series(400, { seed: 4 });
  const o = scenarioOdds(bars, flatFt(400, 20), 6, H);
  assert.equal(o.state, "up");
  assert.equal(o.matches, o.sampled);
  assert.equal(o.nEff, (o.sampled * 2) / 6);
  assert.equal(o.fallback, null);
  assert.equal(o.withState, o.sampled);
  assert.ok(o.nEff >= SC_MIN_NEFF);
  const s300 = series(300, { seed: 4 });
  const f = scenarioOdds(s300, flatFt(300, 20), 24, H);
  assert.equal(f.fallback, "fewMatches");
  assert.deepEqual(f.odds.up.p, f.base.up);
  for (const b of BUCKETS) assert.equal(f.odds[b].p, f.base[b]);
  assert.equal(f.nEff, f.baseNEff);
});

test("no state -> overall odds", () => {
  const bars = series(400, { seed: 4 });
  const o = scenarioOdds(bars, flatFt(400, null), 6, H);
  assert.equal(o.fallback, "noState");
  assert.equal(o.state, null);
  assert.equal(o.withState, 0);
  for (const b of BUCKETS) assert.equal(o.odds[b].p, o.base[b]);
  assert.equal(o.nEff, o.baseNEff);
});

test("late daily series: bars without a state are left out of matches", () => {
  const bars = series(1000, { seed: 6 });
  const ft = Array.from({ length: 1000 }, (_, i) => (i < 500 ? null : 20));
  const o = scenarioOdds(bars, ft, 6, H);
  assert.equal(o.fallback, null);
  assert.ok(o.withState < o.sampled);
  assert.ok(o.matches <= o.withState);
  assert.equal(o.matches, o.withState);
  assert.equal(o.nEff, (o.matches * 2) / 6);
  assert.equal(o.baseNEff, (o.sampled * 2) / 6);
  // base uses every candidate
  const all = scenarioOdds(bars, flatFt(1000, 20), 6, H);
  for (const b of BUCKETS) assert.equal(o.base[b], all.base[b]);
});

test("mixed Fund trend states: matches are only the bars in today's state", () => {
  const n = 1000;
  const bars = series(n, { seed: 14 });
  const cyc = [20, -20, 0]; // i % 3: up, down, flat; the last bar (999) is up
  const ft = Array.from({ length: n }, (_, i) => cyc[i % 3]);
  const o = scenarioOdds(bars, ft, 6, H);
  const first = firstAtr(bars);
  let sampled = 0, inState = 0;
  for (let i = 999 - 6; i >= first; i -= 2) { sampled++; if (i % 3 === 0) inState++; }
  assert.equal(o.state, "up");
  assert.equal(o.sampled, sampled);
  assert.equal(o.withState, sampled);
  assert.equal(o.matches, inState);
  assert.ok(o.matches < o.withState);
  assert.equal(o.nEff, (inState * 2) / 6);
  assert.equal(o.fallback, null);
  assert.equal(BUCKETS.reduce((a, b) => a + o.odds[b].cases, 0), o.matches);
  assert.notDeepEqual(BUCKETS.map((b) => o.odds[b].p), BUCKETS.map((b) => o.base[b]));
});

test("ftAtBars[last] equals the ledger row ft (applyFundTrend), fresh and stale", () => {
  for (const gapH of [1, 24, 36, 37, 72]) {
    const { daily, bars } = ftFixture(600, gapH);
    const last = bars[bars.length - 1];
    const row = { ac: "crypto", pair: "BTCUSDT", t: last.time, tc: last.time + H, ft: undefined };
    applyFundTrend([row], () => daily);
    const got = ftAtBars(daily, bars, H)[bars.length - 1];
    assert.equal(got, row.ft, `gap ${gapH}h`);
    if (gapH <= 36) assert.notEqual(got, null); else assert.equal(got, null);
  }
});

test("odds, cases and base shares", () => {
  const bars = series(600, { seed: 8 });
  const o = scenarioOdds(bars, flatFt(600, -30), 6, H);
  assert.equal(o.state, "down");
  const sum = BUCKETS.reduce((a, b) => a + o.odds[b].p, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12);
  assert.equal(BUCKETS.reduce((a, b) => a + o.odds[b].cases, 0), o.matches);
  const sb = BUCKETS.reduce((a, b) => a + o.base[b], 0);
  assert.ok(Math.abs(sb - 1) < 1e-12);
  const last = bars[599];
  const atr = volPercentiles(bars).atr[599];
  assert.ok(Math.abs(o.sigmaH - (atr / last.close) * Math.sqrt(6)) < 1e-15);
});

test("Wilson on n_eff", () => {
  const bars = series(600, { seed: 8 });
  const o = scenarioOdds(bars, flatFt(600, 20), 6, H);
  for (const b of BUCKETS) {
    const [lo, hi] = wilson(o.odds[b].p * o.nEff, o.nEff);
    assert.ok(Math.abs(o.odds[b].lo - lo) < 1e-12 && Math.abs(o.odds[b].hi - hi) < 1e-12);
  }
});

test("nothing sampled -> null; non-finite ATR at the last bar -> null", () => {
  assert.equal(scenarioOdds(series(10), flatFt(10, 20), 6, H), null);
  const bars = series(400, { seed: 4 });
  bars[200].high = NaN; // Wilder ATR is NaN from here on
  assert.equal(scenarioOdds(bars, flatFt(400, 20), 6, H), null);
});

function fakeSim(xs, sigma = 0.1, lastClose = 100) {
  const paths = xs.map((x) => {
    const c = lastClose * Math.exp(x * sigma);
    return Array.from({ length: 24 }, () => ({ open: c, high: c, low: c, close: c }));
  });
  return { paths, bands: [], volPct: 50, widened: 15, blocks: 1, mu: 0 };
}

test("scenario path is the one nearest the bucket median; empty bucket -> null", () => {
  const xs = [];
  for (let p = 0; p <= 60; p++) xs.push(1 + 0.01 * p); // up: 61 paths, median is path 30
  for (let q = 0; q < 9; q++) xs.push(-1 - 0.1 * q); // down: 9 paths (61..69), median is path 65
  while (xs.length < 200) xs.push(0.1); // range: identical -> lowest p (70)
  const got = pickPaths(fakeSim(xs), 6, 0.1, 100);
  assert.deepEqual(got, { up: 30, range: 70, down: 65 });
  const noDown = pickPaths(fakeSim(xs.map((x) => (x < -0.5 ? 0.2 : x))), 6, 0.1, 100);
  assert.equal(noDown.down, null);
  assert.equal(noDown.up, 30);
});

test("runScenarios is identical after structuredClone and twice in a row", () => {
  const { daily, bars } = ftFixture(800, 1);
  const req = { pair: "BTCUSDT", tf: "1h", intervalMs: H, bars, daily, horizon: 24 };
  const a = runScenarios(req);
  const b = runScenarios(structuredClone(req));
  const c = runScenarios(req);
  assert.ok(!("na" in a));
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.equal(a.key, scenarioKey(req, bars[799].time, 800, daily[daily.length - 1].time));
  assert.equal(a.bands.length, 24);
  for (const k of BUCKETS) assert.ok(a.paths[k] === null || a.paths[k].length === 24);
  assert.equal(scenarioKey({ pair: "X", tf: "1h", horizon: 6 }, 5, 7, null), "X|1h|5|7|6|-");
});

test("H = 6 bands are the first 6 steps whatever the horizon", () => {
  const { daily, bars } = ftFixture(800, 1);
  const base = { pair: "ETHUSDT", tf: "1h", intervalMs: H, bars, daily };
  const r6 = runScenarios({ ...base, horizon: 6 });
  const r24 = runScenarios({ ...base, horizon: 24 });
  assert.equal(r6.bands.length, 6);
  assert.deepEqual(r6.bands, r24.bands.slice(0, 6));
  for (const k of BUCKETS) if (r6.paths[k]) assert.equal(r6.paths[k].length, 6);
});

test("runScenarios: not enough history, and NaN volatility is unknown", () => {
  assert.deepEqual(runScenarios({ pair: "A", tf: "1h", intervalMs: H, bars: series(299), daily: null, horizon: 6 }), { na: "history" });
  const bars = series(500, { seed: 2 });
  bars[200].high = NaN;
  const sim = simulate(bars, H, 1);
  assert.ok(Number.isNaN(sim.volPct));
  assert.equal(sim.widened, "all");
  assert.equal(volRegime(sim.volPct), null);
  assert.deepEqual(runScenarios({ pair: "A", tf: "1h", intervalMs: H, bars, daily: null, horizon: 6 }), { na: "history" });
  assert.deepEqual(scenarioFields(bars, flatFt(500, 20), { pair: "A", tf: "1h", intervalMs: H }), { scb: null, scp: null });
});

test("volRegime cuts at the 33/67 percentiles; NaN is unknown", () => {
  assert.equal(volRegime(10), "low");
  assert.equal(volRegime(32.9), "low");
  assert.equal(volRegime(33), "mid");
  assert.equal(volRegime(67), "mid");
  assert.equal(volRegime(67.1), "high");
  assert.equal(volRegime(NaN), null);
  assert.equal(volRegime(undefined), null);
});

test("scenarioFields rounds and orders", () => {
  const bars = series(1000, { seed: 12, drift: -0.002 });
  const ctx = { pair: "BTCUSDT", tf: "1h", intervalMs: H };
  const { scb, scp } = scenarioFields(bars, flatFt(1000, -40), ctx);
  const dec = (v, d) => Math.abs(v * 10 ** d - Math.round(v * 10 ** d)) < 1e-7;
  assert.equal(scb.length, 4);
  for (let i = 1; i < 4; i++) assert.ok(scb[i] >= scb[i - 1]);
  assert.ok(scb.every((v) => dec(v, 5)));
  const sim = simulate(bars, H, scenarioSeed("BTCUSDT", "1h", bars[999].time));
  const lc = bars[999].close;
  assert.equal(scb[0], Math.round(Math.log(sim.bands[5].p025 / lc) * 1e5) / 1e5);
  assert.equal(scb[3], Math.round(Math.log(sim.bands[5].p975 / lc) * 1e5) / 1e5);
  assert.ok(Math.abs(scp.p.reduce((a, b) => a + b, 0) - 1) < 0.002);
  assert.ok(Math.abs(scp.b.reduce((a, b) => a + b, 0) - 1) < 0.002);
  assert.ok(scp.p.every((v) => dec(v, 3)) && scp.b.every((v) => dec(v, 3)) && dec(scp.w, 5));
  assert.ok(scp.w > 0);
  assert.equal(scp.s, -1);
  assert.equal(scp.f, 0);
  const o = scenarioOdds(bars, flatFt(1000, -40), 6, H);
  assert.equal(scp.p[2], Math.round(o.odds.down.p * 1000) / 1000); // Continue share in a down trend
  const nos = scenarioFields(bars, flatFt(1000, null), ctx);
  assert.equal(nos.scp.s, null);
  assert.equal(nos.scp.f, 1);
  assert.deepEqual(nos.scp.p, nos.scp.b);
  assert.equal(scenarioFields(bars, flatFt(1000, 0), ctx).scp.s, 0);
});

test("scenarioFields below 300 bars -> nulls", () => {
  const ctx = { pair: "BTCUSDT", tf: "1h", intervalMs: H };
  assert.deepEqual(scenarioFields(series(299), flatFt(299, 20), ctx), { scb: null, scp: null });
});

console.log(`\nscenarios: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
