// Confluence v2 (WP23) Task 6: v2 beside Classic in scan jobs, catch-up and live rows, and the per-row time budget.
// Run: npm run test:v2-scan   (node scripts/run-engine-tests.mjs confluence-v2-scan.test.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";
import { runScanJob, runScanJobSafe, runCatchUp, packKlines, unpackKlines } from "./scan-jobs.ts";
import { scoreSeries, toLedgerRow } from "./scan-pipeline.ts";
import { scoreV2, v2Compact } from "./confluence-v2.ts";
import { liveRow, scanShared, enrichCatchUp, applyFundTrend, applyScenarios } from "./scan-record.ts";
import { sanitizeLedgerRow } from "./ledger-metrics.ts";
import { barCloseTime } from "./market-client.ts";
import { measureWalks } from "./noise-fixtures.mjs";

const H = 3_600_000;
const IV = 4 * H;
const OPT = { intervalMs: IV, volumeAvailable: true, assetClass: "crypto" };
const walk = (n, seed = 99) => measureWalks(1, n, seed)[0];
const ctxOf = (pair = "XUSDT") => ({ src: "binance", tf: "4h", pair, ac: "crypto", intervalMs: IV, rank: 1, quoteVolume: 1, appVersion: "t", live: true, recordedAt: 1_800_000_000_000 });
// A profile that changes Classic's score, so "v2 ignores the profile" is observable.
const PROFILE = { version: 1, enabled: ["sma", "ema", "macd", "adx", "psar", "ichimoku", "supertrend", "cci", "ao", "bollinger"] };
const jobOf = (k, extra = {}) => ({ key: "binance:4h:XUSDT", packed: packKlines(k), intervalMs: IV, volumeAvailable: true, assetClass: "crypto", ...extra });

test("runScanJob returns v2 equal to scoreV2 on the same bars and ignores the profile", () => {
  const k = walk(1000);
  const plain = runScanJob(jobOf(k));
  assert.ok(plain.v2 && plain.v2.usable);
  assert.deepEqual(plain.v2, scoreV2(k, OPT));
  const withProfile = runScanJob(jobOf(k, { profile: PROFILE }));
  assert.deepEqual(withProfile.v2, plain.v2, "v2 never takes the profile");
  assert.deepEqual(withProfile.score, scoreSeries(k, { ...OPT, profile: PROFILE }), "Classic still uses the profile");
  assert.notEqual(withProfile.score.confluence.score, plain.score.confluence.score, "the profile changes Classic");
});

test("worker transfer: packed job v2 equals direct v2", () => {
  const k = walk(1000, 7);
  const round = unpackKlines(packKlines(k));
  assert.deepEqual(runScanJob(jobOf(k)).v2, scoreV2(round, OPT));
});

test("displayOnly jobs carry v2", () => {
  const k = walk(1000, 11);
  const r = runScanJob(jobOf(k, { displayOnly: true, key: "binance:4h:DISPLAYONLY" }));
  assert.deepEqual(r.v2, scoreV2(k, OPT));
});

test("runScanJobSafe error path sets v2 null", () => {
  const r = runScanJobSafe({ ...jobOf(walk(1000)), packed: null });
  assert.ok(r.error);
  assert.equal(r.v2, null);
});

test("catch-up rows carry v2 scored on their own window", () => {
  const k = walk(1100, 5);
  const since = k[1050].time;
  const { rows } = runCatchUp(jobOf(k, { catchUp: { since, max: 48, ctx: ctxOf() } }), k);
  assert.equal(rows.length, 48);
  for (const row of rows) {
    const j = k.findIndex((b) => b.time === row.t);
    const window = k.slice(Math.max(0, j - 999), j + 1);
    assert.deepEqual(row.v2, v2Compact(scoreV2(window, OPT), row.t));
    assert.ok(row.v2 !== null, "a full window scores");
    const { v2, ...classic } = row;
    const s = scoreSeries(window, OPT);
    const expect = toLedgerRow(window, s, { ...ctxOf(), closeTime: row.t + IV, underlyingClosed: false });
    assert.deepEqual(classic, expect, "Classic fields unchanged");
    assert.ok(sanitizeLedgerRow(row), "row passes the strict sanitiser");
  }
});

test("liveRow attaches v2 and leaves Classic fields alone", () => {
  const k = walk(1000, 3);
  const score = scoreSeries(k, OPT);
  const v2 = scoreV2(k, OPT);
  const p = { symbol: "XUSDT", rank: 1, quoteVolume: 1, ac: "crypto", kl: k };
  const rctx = { src: "binance", tf: "4h", intervalMs: IV, appVersion: "t", recordedAt: 1_800_000_000_000 };
  const shared = scanShared([p]);
  const without = liveRow(p, score, rctx, shared);
  const withV2 = liveRow({ ...p, v2 }, score, rctx, shared);
  assert.ok(without && withV2);
  assert.ok(!("v2" in without) || without.v2 === undefined || without.v2 === null, "absent when p.v2 is absent");
  assert.deepEqual(withV2.v2, v2Compact(v2, withV2.t));
  assert.ok(withV2.v2 !== null);
  const { v2: _a, ...a } = withV2;
  const { v2: _b, ...b } = without;
  assert.deepEqual(a, b);
  assert.equal(sanitizeLedgerRow(withV2).v2.cfg, withV2.v2.cfg);
});

test("enrichCatchUp, applyFundTrend and applyScenarios keep v2", () => {
  const k = walk(1100, 5);
  const { rows } = runCatchUp(jobOf(k, { catchUp: { since: k[1090].time, max: 48, ctx: ctxOf() } }), k);
  assert.equal(rows.length, 8);
  const before = rows.map((r) => JSON.stringify(r.v2));
  const p = { symbol: "XUSDT", rank: 1, quoteVolume: 1, ac: "crypto", kl: k };
  const rctx = { src: "binance", tf: "4h", intervalMs: IV, appVersion: "t" };
  enrichCatchUp(rows, k, rctx, scanShared([p]));
  assert.deepEqual(rows.map((r) => JSON.stringify(r.v2)), before);
  applyFundTrend(rows, () => []);
  applyScenarios(rows, () => k, () => [], IV);
  assert.deepEqual(rows.map((r) => JSON.stringify(r.v2)), before);
  assert.ok(rows.every((r) => r.v2 && sanitizeLedgerRow(r)));
});

test("per-row budget (Review Focus 5): 4h, 1,000-bar windows", () => {
  const walks = measureWalks(100, 1000, 99, IV);
  for (let i = 0; i < 5; i++) { scoreV2(walks[i], OPT); scoreSeries(walks[i], OPT); }
  let tV2 = 0, tCl = 0;
  for (const w of walks) {
    // Interleaved in one loop so machine noise hits both sides alike.
    const a = performance.now(); scoreSeries(w, OPT);
    const b = performance.now(); scoreV2(w, OPT);
    const c = performance.now();
    tCl += b - a; tV2 += c - b;
  }
  const mV2 = tV2 / walks.length, mCl = tCl / walks.length;
  console.log(`# budget: scoreV2 ${mV2.toFixed(3)} ms, scoreSeries ${mCl.toFixed(3)} ms, ratio ${(mV2 / mCl).toFixed(2)}x`);
  assert.ok(mV2 <= 5, `scoreV2 mean ${mV2.toFixed(3)} ms must be <= 5 ms`);
  assert.ok(mV2 <= 2 * mCl, `scoreV2 ${mV2.toFixed(3)} ms must be <= 2x scoreSeries ${mCl.toFixed(3)} ms`);
});

test("runCatchUp on 5 series x 48 rows completes; the v2 share of its time is printed", () => {
  const series = measureWalks(5, 1100, 21, IV);
  let total = 0, v2Time = 0, n = 0;
  for (const k of series) {
    const t0 = performance.now();
    const { rows } = runCatchUp(jobOf(k, { catchUp: { since: k[1050].time, max: 48, ctx: ctxOf() } }), k);
    total += performance.now() - t0;
    n += rows.length;
    assert.equal(rows.length, 48);
    // The v2 cost of the same rows, timed on its own.
    const t1 = performance.now();
    for (const r of rows) { const j = k.findIndex((b) => b.time === r.t); v2Compact(scoreV2(k.slice(Math.max(0, j - 999), j + 1), OPT), r.t); }
    v2Time += performance.now() - t1;
  }
  assert.equal(n, 240);
  console.log(`# catch-up: ${n} rows in ${total.toFixed(0)} ms; v2 share ${(100 * v2Time / total).toFixed(0)}%`);
});
