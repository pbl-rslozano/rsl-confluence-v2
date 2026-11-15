// Fund trend panel scores (v2.8 WP21, Task 5). Run: npm run test:panel
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreVisibleBars } from "./scan-jobs.ts";
import { scoreSeries } from "./scan-pipeline.ts";
import { resolvePanelScores, panelCacheKey, panelBarsNeeded, PANEL_MAX_BARS } from "./panel-scores.ts";
import { clearChartOptIn, setChartOptIn, getChartOptIn } from "./chart-optin-store.ts";

const H = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);
/** Deterministic wandering series of n hourly bars. */
function klines(n) {
  let c = 100, seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 - 0.5; };
  return Array.from({ length: n }, (_, i) => {
    const o = c; c = Math.max(1, c * (1 + rnd() * 0.02 + 0.0004));
    return { time: T0 + i * H, open: o, high: Math.max(o, c) * 1.003, low: Math.min(o, c) * 0.997, close: c, volume: 1000 + (i % 17) * 50 };
  });
}
const job = { key: "k", packed: new Float64Array(0), intervalMs: H, volumeAvailable: true, assetClass: "crypto" };
const opts = { intervalMs: H, volumeAvailable: true, assetClass: "crypto", profile: undefined };

test("scoreVisibleBars equals the list score on the last bar", () => {
  const k = klines(1300);
  const out = scoreVisibleBars(job, k, 300);
  assert.equal(out.length, 300);
  const list = scoreSeries(k.slice(-1000), opts);
  assert.equal(out.at(-1), list.confluence.score);
  // a middle bar equals scoring its own 1,000-bar window
  const j = 1200;
  assert.equal(out[j - (1300 - 300)], scoreSeries(k.slice(j - 999, j + 1), opts).confluence.score);
});

test("bars without a full window are null", () => {
  const out = scoreVisibleBars(job, klines(1100), 300);
  assert.equal(out.length, 300);
  assert.equal(out.slice(0, 199).every((v) => v === null), true);
  assert.equal(typeof out[199], "number");
});

test("known (ledger) scores are used and not re-scored", () => {
  const k = klines(1100);
  const known = new Map([[k[1099].time, 12345]]);
  const out = scoreVisibleBars(job, k, 5, known);
  assert.equal(out.at(-1), 12345);
  assert.notEqual(out.at(-2), 12345);
});

test("ledger rows are reused: the worker is not asked for those bars", async () => {
  const k = klines(1300);
  const known = new Map([[k[1299].time, 55], [k[1298].time, -20]]);
  const calls = [];
  const cache = new Map();
  const run = async (end, count, kn) => { calls.push({ end, count, hasKnown: kn.has(k[1299].time) }); return scoreVisibleBars(job, k.slice(0, end), count, kn); };
  const r = await resolvePanelScores({ klines: k, from: 1295, to: 1300, cache, known, run });
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].end, calls[0].count], [1298, 3]); // only bars 1295..1297 went to the worker
  assert.equal(r.scores.get(k[1299].time), 55);
  assert.equal(r.scores.get(k[1298].time), -20);
  assert.equal(r.scored, 5);
  assert.equal(r.total, 5);
  // a second call is answered from the cache
  await resolvePanelScores({ klines: k, from: 1295, to: 1300, cache, known: new Map(), run });
  assert.equal(calls.length, 1);
});

test("cache hit when every bar is known; no worker means unresolved bars stay out", async () => {
  const k = klines(1100);
  const cache = new Map();
  const r = await resolvePanelScores({ klines: k, from: 800, to: 1100, cache, known: new Map(), run: async () => null });
  assert.equal(r.total, 300);
  assert.equal(r.scored, 0);
  assert.equal(r.scores.get(k[800].time), null); // no full window
  assert.equal(r.scores.has(k[1050].time), false); // not scored, not cached
  assert.equal(cache.has(k[1050].time), false);
});

test("a range over 300 bars takes the newest 300", async () => {
  const k = klines(1400);
  const r = await resolvePanelScores({ klines: k, from: 0, to: 1400, cache: new Map(), known: new Map(), run: async (e, c, kn) => scoreVisibleBars(job, k.slice(0, e), c, kn) });
  assert.equal(r.capped, true);
  assert.equal(r.total, PANEL_MAX_BARS);
  assert.equal(r.scored, PANEL_MAX_BARS);
});

test("cache key and bars needed", () => {
  assert.equal(panelCacheKey("okx", "1h", "BTC-USDT", 123, "cfg"), "okx|1h|BTC-USDT|123|cfg");
  assert.equal(panelBarsNeeded(300), 1299);
  assert.equal(panelBarsNeeded(9999), 1299);
});

test("clearChartOptIn turns every opt-in off (Reset to defaults)", () => {
  setChartOptIn("fund-ribbon", true);
  setChartOptIn("fund-panel", true);
  assert.deepEqual([...getChartOptIn()], ["fund-ribbon", "fund-panel"]);
  clearChartOptIn();
  assert.deepEqual([...getChartOptIn()], []);
});
