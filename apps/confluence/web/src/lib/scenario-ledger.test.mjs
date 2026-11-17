// Scenarios (WP22) Task 7 — ledger fields scb/scp on the official scan path, catch-up rows, CSV and the sanitiser.
// Run: npm run test:scenario-ledger   (node scripts/run-engine-tests.mjs scenario-ledger.test.mjs)
import assert from "node:assert/strict";
import { rng, sanitizeLedgerRow, parseLedgerCsv, parseLedgerImport, LEDGER_CSV_COLUMNS, ledgerRowValues } from "./ledger-metrics.ts";
import { scenarioFields, runScenarios, ftAtBars, scenarioSeed, SC_MIN_BARS } from "./scenarios.ts";
import { applyScenarios, applyFundTrend, enrichCatchUp, enrichCatchUpAsync } from "./scan-record.ts";
import { writeLiveRows } from "./fund-feed-gate.ts";
import { ENGINE_BARS } from "./engine-config.ts";

let passed = 0;
let failed = 0;
const pending = [];
const test = (name, fn) => {
  pending.push((async () => {
    try { await fn(); passed++; console.log("  ok   - " + name); }
    catch (e) { failed++; console.log("  FAIL - " + name + "  [" + (e && e.message ? e.message.replace(/\n/g, " ") : e) + "]"); }
  }));
};

const H = 3_600_000;
const DAY = 24 * H;
const T0 = Date.UTC(2026, 0, 1);
function series(n, { seed = 7, vol = 0.01, t0 = T0, intervalMs = H } = {}) {
  const r = rng(seed);
  const z = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  const out = [];
  let c = 100;
  for (let i = 0; i < n; i++) {
    const o = c;
    const cl = o * Math.exp(vol * z());
    const hi = Math.max(o, cl) * (1 + Math.abs(vol * z()) * 0.5);
    const lo = Math.min(o, cl) * (1 - Math.abs(vol * z()) * 0.5);
    out.push({ time: t0 + i * intervalMs, open: o, high: hi, low: lo, close: cl, volume: 1 });
    c = cl;
  }
  return out;
}
/** Daily bars from `days` days before the hourly series start to one day after its end, a mild trend with noise. */
function dailyFor(bars, days = 420) {
  const first = Math.floor(bars[0].time / DAY) * DAY - days * DAY;
  const last = Math.floor(bars[bars.length - 1].time / DAY) * DAY + DAY;
  const out = [];
  let i = 0;
  for (let t = first; t <= last; t += DAY, i++) {
    const c = 100 * Math.exp(0.003 * i + 0.05 * Math.sin(i / 5));
    out.push({ time: t, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1 });
  }
  return out;
}
const ctxOf = (pair = "BTCUSDT") => ({ pair, tf: "1h", intervalMs: H });
const rowAt = (bars, i, extra = {}) => ({ pair: "BTCUSDT", tf: "1h", ac: "crypto", t: bars[i].time, tc: bars[i].time + H, ...extra });

const bars1400 = series(1400);
const daily = dailyFor(bars1400);
const ftAll = ftAtBars(daily, bars1400, H);
const seriesWithDaily = (bars) => (pair) => (pair === "BTCUSDT" ? dailyFor(bars) : []);

test("the official fields use the 1,000 bars ending at the row's own bar", () => {
  const live = rowAt(bars1400, 1399, { ft: ftAll[1399] });
  const cu = rowAt(bars1400, 1200, { ft: ftAll[1200] });
  applyScenarios([live, cu], () => bars1400, () => daily, H);
  const wantLive = scenarioFields(bars1400.slice(400), ftAll.slice(400), ctxOf());
  const wantCu = scenarioFields(bars1400.slice(201, 1201), ftAll.slice(201, 1201), ctxOf());
  assert.ok(wantLive.scb && wantLive.scp && wantCu.scb);
  assert.deepEqual({ scb: live.scb, scp: live.scp }, wantLive);
  assert.deepEqual({ scb: cu.scb, scp: cu.scp }, wantCu);
  assert.notDeepEqual(live.scb, cu.scb);
});

test("a longer stored history never changes a recorded row", () => {
  const long = series(3000, { seed: 11 });
  const short = long.slice(2000);
  const dl = dailyFor(long, 600);
  const a = rowAt(short, 999, { ft: ftAtBars(dl, short, H)[999] });
  const b = rowAt(long, 2999, { ft: ftAtBars(dl, long, H)[2999] });
  applyScenarios([a], () => short, () => dl, H);
  applyScenarios([b], () => long, () => dl, H);
  assert.ok(a.scb && a.scp);
  assert.deepEqual([a.scb, a.scp], [b.scb, b.scp]);
});

test("scenarioFields equals runScenarios at H = 6 on the same window", () => {
  const w = bars1400.slice(400);
  const ft = ftAll.slice(400);
  const { scb, scp } = scenarioFields(w, ft, ctxOf());
  const res = runScenarios({ ...ctxOf(), bars: w, daily, horizon: 6 });
  assert.ok(!("na" in res));
  const lc = w[w.length - 1].close;
  const b = res.bands[5];
  const r5 = (v) => Math.round(v * 1e5) / 1e5;
  assert.deepEqual(scb, [r5(Math.log(b.p025 / lc)), r5(Math.log(b.p16 / lc)), r5(Math.log(b.p84 / lc)), r5(Math.log(b.p975 / lc))]);
  const r3 = (v) => Math.round(v * 1e3) / 1e3;
  assert.deepEqual(scp.p, [r3(res.odds.odds.up.p), r3(res.odds.odds.range.p), r3(res.odds.odds.down.p)]);
  assert.deepEqual(scp.b, [r3(res.odds.base.up), r3(res.odds.base.range), r3(res.odds.base.down)]);
});

test("row.ft decides the signal bar's state", () => {
  const up = rowAt(bars1400, 1399, { ft: 15 });
  applyScenarios([up], () => bars1400, () => daily, H);
  assert.equal(up.scp.s, 1);
  const none = rowAt(bars1400, 1399, { ft: null });
  applyScenarios([none], () => bars1400, () => daily, H);
  assert.equal(none.scp.s, null);
  assert.equal(none.scp.f, 1);
  assert.deepEqual(none.scp.p, none.scp.b);
});

test("non-crypto and no daily: overall odds", () => {
  const stock = rowAt(bars1400, 1399, { ac: "stock", pair: "AAPL" });
  applyScenarios([stock], () => bars1400, undefined, H);
  assert.equal(stock.scp.s, null);
  assert.equal(stock.scp.f, 1);
  assert.ok(stock.scb);
});

test("fewer than 300 bars -> scb and scp null; a row whose bar is missing too", () => {
  const few = series(SC_MIN_BARS - 1);
  const r = rowAt(few, few.length - 1, { ft: 20 });
  applyScenarios([r], () => few, () => dailyFor(few), H);
  assert.equal(r.scb, null);
  assert.equal(r.scp, null);
  const gone = rowAt(bars1400, 1399);
  gone.t = bars1400[0].time - H;
  applyScenarios([gone], () => bars1400, () => daily, H);
  assert.equal(gone.scb, null);
  assert.equal(gone.scp, null);
  const nobars = rowAt(bars1400, 1399);
  applyScenarios([nobars], () => undefined, () => daily, H);
  assert.equal(nobars.scb, null);
});

test("ENGINE_BARS is the window the brief names", () => { assert.equal(ENGINE_BARS, 1000); });

const fakeTimers = () => ({ setTimeout: () => 1, clearTimeout: () => {} });
test("writeLiveRows applies scenarios to both groups, crypto after the feed", async () => {
  const writes = [];
  let res;
  const settled = new Promise((r) => { res = r; });
  const crypto = rowAt(bars1400, 1399);
  const stock = { ...rowAt(bars1400, 1399, { ac: "stock", pair: "AAPL" }) };
  const barsOf = () => bars1400;
  const p = writeLiveRows([crypto, stock], {
    write: async (rs) => { writes.push(rs.map((r) => ({ pair: r.pair, scb: r.scb, scp: r.scp }))); return rs.length; },
    settled, dailyOf: () => daily, timers: fakeTimers(), barsOf, intervalMs: H,
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0].pair, "AAPL");
  assert.ok(writes[0][0].scb);
  res();
  await p;
  assert.equal(writes.length, 2);
  assert.equal(writes[1][0].pair, "BTCUSDT");
  assert.ok(writes[1][0].scb);
  assert.notEqual(writes[1][0].scp.s, null, "state from the feed's daily bars");
  const want = scenarioFields(bars1400.slice(400), ftAtBars(daily, bars1400, H).slice(400).map((v, i, a) => (i === a.length - 1 ? crypto.ft ?? null : v)), ctxOf());
  assert.deepEqual(writes[1][0].scp, want.scp);
});

test("writeLiveRows without barsOf leaves rows untouched", async () => {
  const r = rowAt(bars1400, 1399);
  await writeLiveRows([r], { write: async (rs) => rs.length, settled: Promise.resolve(), dailyOf: () => daily, timers: fakeTimers() });
  assert.equal(r.scb, undefined);
});

/* ---------------- CSV and the sanitiser ---------------- */
const t1 = Date.UTC(2026, 9, 1, 8);
const baseRow = { cfg: "c1", ev: "1", app: "t", src: "binance", tf: "4h", ac: "crypto", rec: 0, sc: 0, m: 0, st: 0, sup: 0, lv: 0, v: 18, bu: 0, be: 0, er: null, bl: [0, 0, 0, 0], rk: 1, qv: 1, rd: 0, rc: 0, wb: 1000, live: 1 };
const row = { ...baseRow, id: `c1|binance|4h|BTCUSDT|${t1}`, pair: "BTCUSDT", t: t1, tc: t1 + 4 * H, rec: t1 + 4 * H, c: 61234.5, sc: 47.5, m: 1, st: 1, ft: 22.5,
  rku: 4, rks: "live", rs: 81.2, beta: 1.07, htf: 1, td: -0.12, mev: -6.5, bp: 0.031, pin: 0, spl: 0, earn: 0, vt: 12345, pd: -1, pc: 2, fr: 0.0001, oiChg: -3.25,
  scb: [-0.04123, -0.02011, 0.0199, 0.04188], scp: { s: 1, p: [0.512, 0.301, 0.187], b: [0.4, 0.35, 0.25], w: 0.0245, f: 0 } };
const safe = (v) => { if (v === null || v === undefined) return ""; if (typeof v === "number") return Number.isFinite(v) ? String(v) : ""; const g = /^[=+\-@\u0000-\u001F]/.test(String(v)) ? `'${v}` : String(v); return /[",\r\n]/.test(g) ? `"${g.replace(/"/g, '""')}"` : g; };
const csvOf = (cols, lines) => "﻿" + [cols.join(","), ...lines.map((l) => l.map(safe).join(","))].join("\r\n") + "\r\n";
const at = (c) => LEDGER_CSV_COLUMNS.indexOf(c);

test("CSV: the scenario columns follow radar_alerts and round-trip losslessly", () => {
  const SC_COLS = ["scenario_band_lo95", "scenario_band_lo68", "scenario_band_hi68", "scenario_band_hi95", "scenario_state", "scenario_p_up", "scenario_p_range", "scenario_p_down", "scenario_base_up", "scenario_base_range", "scenario_base_down", "scenario_width", "scenario_fallback"];
  assert.equal(LEDGER_CSV_COLUMNS.slice(at("radar_alerts") + 1).join(), SC_COLS.join());
  assert.equal(LEDGER_CSV_COLUMNS[LEDGER_CSV_COLUMNS.length - 1], "scenario_fallback");
  const vals = ledgerRowValues(row);
  assert.equal(vals.length, LEDGER_CSV_COLUMNS.length);
  assert.equal(vals[at("scenario_band_lo95")], -0.04123);
  assert.equal(vals[at("scenario_p_range")], 0.301);
  assert.equal(vals[at("scenario_width")], 0.0245);
  const out = parseLedgerCsv(csvOf([...LEDGER_CSV_COLUMNS, "net_return_h1"], [[...vals, ""]]));
  assert.equal(out.rejected, 0);
  assert.equal(JSON.stringify(out.rows[0]), JSON.stringify(sanitizeLedgerRow(row)));
  assert.deepEqual(out.rows[0].scb, row.scb);
  assert.deepEqual(out.rows[0].scp, row.scp);
  // a null state exports as an empty cell and returns as null
  const ns = { ...row, scp: { ...row.scp, s: null, f: 1, p: row.scp.b } };
  const o2 = parseLedgerCsv(csvOf(LEDGER_CSV_COLUMNS, [ledgerRowValues(ns)]));
  assert.equal(JSON.stringify(o2.rows[0]), JSON.stringify(sanitizeLedgerRow(ns)));
  assert.equal(o2.rows[0].scp.s, null);
  // null fields export as empty cells
  const nul = ledgerRowValues({ ...row, scb: null, scp: null });
  assert.ok(nul.slice(at("scenario_band_lo95")).every((v) => v === ""));
  assert.equal(parseLedgerCsv(csvOf(LEDGER_CSV_COLUMNS, [nul])).rows[0].scb, null);
});

test("an earlier v2.8 CSV without scenario columns imports with scb and scp null", () => {
  const cols = LEDGER_CSV_COLUMNS.slice(0, at("radar_alerts") + 1);
  const out = parseLedgerCsv(csvOf(cols, [ledgerRowValues(row).slice(0, cols.length)]));
  assert.equal(out.rejected, 0);
  assert.equal(out.rows[0].scb, null);
  assert.equal(out.rows[0].scp, null);
});

test("hostile scenario values reject the whole row", () => {
  const sp = (o) => ({ ...row.scp, ...o });
  const bad = [
    { scb: [0.04, 0.02, -0.02, -0.04] },
    { scb: [-6, -0.02, 0.02, 0.04] },
    { scb: [-0.04, -0.02, 0.02] },
    { scb: [-0.04, -0.02, 0.02, "x"] },
    { scp: sp({ p: [0.5, 0.5, 0.3] }) },
    { scp: sp({ b: [0.5, 0.5, 0.3] }) },
    { scp: sp({ p: [1.2, -0.1, -0.1] }) },
    { scp: sp({ p: [0.5, 0.5] }) },
    { scp: sp({ w: 0 }) },
    { scp: sp({ w: 5.1 }) },
    { scp: sp({ w: NaN }) },
    { scp: sp({ s: 2 }) },
    { scp: sp({ f: 2 }) },
    { scp: "x" },
    { scp: [1] },
    { scb: "x" },
  ];
  for (const b of bad) assert.equal(sanitizeLedgerRow({ ...row, ...b }), null, JSON.stringify(b));
  assert.ok(sanitizeLedgerRow({ ...row, scb: [-5, -1, 1, 5], scp: sp({ w: 5 }) }), "limits are inclusive");
  const cell = (col, v) => { const l = ledgerRowValues(row); l[at(col)] = v; return l; };
  const o = parseLedgerCsv(csvOf(LEDGER_CSV_COLUMNS, [cell("scenario_band_lo68", "abc"), cell("scenario_p_up", "abc"), cell("scenario_fallback", "abc")]));
  assert.equal(o.rows.length, 0);
  assert.equal(o.rejected, 3);
  const partial = ledgerRowValues(row);
  partial[at("scenario_band_hi95")] = "";
  partial[at("scenario_band_hi68")] = "";
  partial[at("scenario_band_lo68")] = "";
  const o2 = parseLedgerCsv(csvOf(LEDGER_CSV_COLUMNS, [partial]));
  assert.equal(o2.rows.length, 0, "three of four band cells filled");
  const partialP = ledgerRowValues(row);
  partialP[at("scenario_p_down")] = "";
  assert.equal(parseLedgerCsv(csvOf(LEDGER_CSV_COLUMNS, [partialP])).rows.length, 0, "a partial scp");
});

test("JSON import keeps scb/scp and drops unknown scp keys", () => {
  const evil = { ...row, scp: { ...row.scp, evil: "<script>" }, scb: row.scb };
  const clean = sanitizeLedgerRow(evil);
  assert.deepEqual(clean.scp, row.scp);
  assert.ok(!("evil" in clean.scp));
  const imp = parseLedgerImport(JSON.stringify(row));
  assert.deepEqual(imp.rows[0].scb, row.scb);
  const old = sanitizeLedgerRow({ ...row, scb: undefined, scp: undefined });
  assert.equal(old.scb, null);
  assert.equal(old.scp, null);
});

/* ---------------- Final review C1: the largest synchronous block, not the per-row average ---------------- */
// The event loop's longest stall while the work runs: a setImmediate heartbeat records the gap between its ticks. Work that never
// yields shows up as one gap the length of the whole run; work that yields shows its longest chunk.
const BLOCK_BUDGET_MS = 100;
function lagMonitor() {
  let last = performance.now();
  let max = 0;
  let on = true;
  const tick = () => {
    const now = performance.now();
    max = Math.max(max, now - last);
    last = now;
    if (on) setImmediate(tick);
  };
  setImmediate(tick);
  return { stop() { on = false; max = Math.max(max, performance.now() - last); return max; } };
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const pickSc = (r) => ({ ft: r.ft, scb: r.scb, scp: r.scp });

test("C1: catch-up of 100 pairs x 48 rows never blocks the main thread for more than 100 ms; values identical", async () => {
  const pairs = [];
  const dailyBy = new Map();
  for (let s = 0; s < 100; s++) {
    const pair = "P" + s + "USDT";
    const kl = series(1100, { seed: 900 + s });
    dailyBy.set(pair, dailyFor(kl));
    const rows = [];
    for (let k = 0; k < 48; k++) rows.push({ ...rowAt(kl, 1052 + k), pair });
    pairs.push({ pair, kl, rows });
  }
  const ctx = { src: "binance", tf: "1h", intervalMs: H, appVersion: "t", dailyOf: (p) => dailyBy.get(p) ?? [] };
  const shared = { rs: new Map(), btc: pairs[0].kl, universeRank: new Map() };
  const want = pairs.slice(0, 5).map((p) => enrichCatchUp(clone(p.rows), p.kl, ctx, shared).map(pickSc));
  const mon = lagMonitor();
  const t0 = performance.now();
  const out = [];
  for (const p of pairs) out.push(...(await enrichCatchUpAsync(p.rows, p.kl, ctx, shared)));
  const total = performance.now() - t0;
  const max = mon.stop();
  console.log(`  (catch-up 100 x 48: total ${total.toFixed(0)} ms, largest synchronous block ${max.toFixed(1)} ms)`);
  assert.equal(out.length, 4800);
  assert.deepEqual(out.map((r) => r.pair + r.t), pairs.flatMap((p) => p.rows.map((r) => r.pair + r.t)), "row order unchanged");
  assert.ok(out.every((r) => r.scb && r.scp), "all computed");
  for (let i = 0; i < 5; i++) assert.deepEqual(pairs[i].rows.map(pickSc), want[i], `bit-identical to the synchronous path (${pairs[i].pair})`);
  assert.ok(max <= BLOCK_BUDGET_MS, `largest synchronous block ${max.toFixed(1)} ms > ${BLOCK_BUDGET_MS} ms`);
});

test("C1: a live write of 200 rows never blocks the main thread for more than 100 ms; others first; values identical", async () => {
  const bars = new Map();
  const dailyBy = new Map();
  const rows = [];
  for (let s = 0; s < 200; s++) {
    const crypto = s < 150;
    const pair = (crypto ? "L" : "S") + s + (crypto ? "USDT" : "");
    const kl = series(1000, { seed: 1500 + s });
    bars.set(pair, kl);
    if (crypto) dailyBy.set(pair, dailyFor(kl));
    rows.push({ ...rowAt(kl, 999), pair, ac: crypto ? "crypto" : "stock" });
  }
  const barsOf = (p) => bars.get(p);
  const dailyOf = (p) => dailyBy.get(p) ?? [];
  const exp = clone(rows);
  const expOthers = exp.filter((r) => r.ac !== "crypto");
  const expCrypto = exp.filter((r) => r.ac === "crypto");
  applyScenarios(expOthers, barsOf, undefined, H);
  applyFundTrend(expCrypto, dailyOf);
  applyScenarios(expCrypto, barsOf, dailyOf, H);
  const writes = [];
  const mon = lagMonitor();
  const n = await writeLiveRows(rows, {
    write: async (rs) => { writes.push(rs.map((r) => r.pair)); return rs.length; },
    settled: Promise.resolve(), dailyOf, barsOf, intervalMs: H, timers: fakeTimers(),
  });
  const max = mon.stop();
  console.log(`  (live 200 rows: largest synchronous block ${max.toFixed(1)} ms)`);
  assert.equal(n, 200);
  assert.deepEqual(writes, [expOthers.map((r) => r.pair), expCrypto.map((r) => r.pair)], "others written first, then crypto, in row order");
  assert.deepEqual(rows.map(pickSc), exp.map(pickSc), "bit-identical to the synchronous path");
  assert.ok(max <= BLOCK_BUDGET_MS, `largest synchronous block ${max.toFixed(1)} ms > ${BLOCK_BUDGET_MS} ms`);
});

/* ---------------- Final review I1: the writer never emits what the strict sanitiser rejects ---------------- */
/** n ordinary bars, then a crash to `left` of the price over three bars. */
function crashSeries(left, seed = 21) {
  const b = series(1000, { seed });
  let c = b[b.length - 1].close;
  const step = Math.pow(left, 1 / 3);
  for (let k = 0; k < 3; k++) {
    const o = c;
    c = o * step;
    const t = b[b.length - 1].time + H;
    b.push({ time: t, open: o, high: o * 1.001, low: c * 0.999, close: c, volume: 1 });
  }
  return b;
}
/** A hyper-volatile series: log returns of about +-2.5 a bar, so 6-step bands pass ln(x) = 5. */
function wildSeries(n = 1000, seed = 33) {
  const r = rng(seed);
  const out = [];
  let c = 1;
  for (let i = 0; i < n; i++) {
    const o = c;
    const cl = o * Math.exp((r() < 0.5 ? -1 : 1) * (2 + r()));
    out.push({ time: T0 + i * H, open: o, high: Math.max(o, cl) * 1.01, low: Math.min(o, cl) * 0.99, close: cl, volume: 1 });
    c = cl;
  }
  return out;
}

test("I1: after a >= 90 % crash (and on hyper-volatile bars) the writer's output always passes sanitizeLedgerRow", () => {
  const fixtures = { crash90: crashSeries(0.1), crash95: crashSeries(0.05), crash99: crashSeries(0.01), wild: wildSeries() };
  let rawW = 0;
  let rawEdge = 0;
  for (const [name, b] of Object.entries(fixtures)) {
    const raw = runScenarios({ ...ctxOf(), bars: b, daily: null, horizon: 6 });
    assert.ok(!("na" in raw), name);
    const lc = b[b.length - 1].close;
    const e = raw.bands[5];
    const edges = [e.p025, e.p16, e.p84, e.p975].map((v) => Math.log(v / lc));
    if (raw.odds.sigmaH > 5) rawW++;
    if (edges.some((x) => Math.abs(x) > 5)) rawEdge++;
    const f = scenarioFields(b, b.map(() => null), ctxOf());
    const clean = sanitizeLedgerRow({ ...row, scb: f.scb, scp: f.scp });
    assert.ok(clean, `${name}: the sanitiser accepts the row (scb ${JSON.stringify(f.scb)}, w ${f.scp?.w})`);
    assert.deepEqual([clean.scb, clean.scp], [f.scb, f.scp], name);
    if (raw.odds.sigmaH > 5) assert.equal(f.scp, null, `${name}: w > 5 -> scp null`);
    if (edges.some((x) => Math.abs(x) > 5)) assert.equal(f.scb, null, `${name}: an edge beyond +-5 -> scb null`);
  }
  assert.ok(rawW >= 1, "a fixture reaches w > 5");
  assert.ok(rawEdge >= 1, "a fixture reaches an edge beyond +-5");
});

/* ---------------- Final review T7.3: a logged-only field never blocks a scored write ---------------- */
test("T7.3: a row whose scenario work throws gets null fields; other rows and the write are unaffected", async () => {
  const bad = bars1400.slice();
  bad[700] = null; // corrupt bar inside the 1,000-bar window
  const barsOf = (p) => (p === "BAD" ? bad : p === "THROW" ? (() => { throw new Error("feed"); })() : bars1400);
  const mk = () => [
    { ...rowAt(bars1400, 1399, { ft: 20 }), pair: "BAD" },
    { ...rowAt(bars1400, 1399, { ft: 20 }), pair: "THROW" },
    rowAt(bars1400, 1399, { ft: 20 }),
  ];
  const rs = mk();
  applyScenarios(rs, barsOf, () => daily, H);
  assert.deepEqual(rs.slice(0, 2).map((r) => [r.scb, r.scp]), [[null, null], [null, null]]);
  assert.ok(rs[2].scb && rs[2].scp, "the good row still computes");
  const written = [];
  const n = await writeLiveRows(mk().map((r) => ({ ...r, ac: "stock" })), {
    write: async (x) => { written.push(...x); return x.length; }, settled: Promise.resolve(), barsOf, intervalMs: H, timers: fakeTimers(),
  });
  assert.equal(n, 3, "every scored row is written");
  assert.deepEqual(written.map((r) => r.scb === null), [true, true, false]);
});

/* ---------------- Final review T7.1: the recorder computes catch-up scb/scp once ---------------- */
test("T7.1: enrichCatchUp with { scenarios: false } leaves scb/scp to the caller; the default computes them", () => {
  const ctx = { src: "binance", tf: "1h", intervalMs: H, appVersion: "t" };
  const shared = { rs: new Map(), btc: bars1400, universeRank: new Map() };
  const off = enrichCatchUp([rowAt(bars1400, 1300)], bars1400, ctx, shared, { scenarios: false });
  assert.ok(!("scb" in off[0]) && !("scp" in off[0]), "not computed");
  const on = enrichCatchUp([rowAt(bars1400, 1300)], bars1400, ctx, shared);
  assert.ok(on[0].scb && on[0].scp, "computed by default");
});

test("applyScenarios cost: at most 10 ms per row on average", () => {
  const rows = [];
  const map = new Map();
  for (let s = 0; s < 100; s++) {
    const pair = "P" + s;
    const b = series(1000, { seed: 100 + s });
    map.set(pair, b);
    rows.push({ ...rowAt(b, 999), pair, ft: s % 2 ? 20 : null });
  }
  for (let s = 0; s < 5; s++) {
    const pair = "C" + s;
    const b = series(1100, { seed: 500 + s });
    map.set(pair, b);
    for (let k = 0; k < 48; k++) rows.push({ ...rowAt(b, 1051 + k), pair, ft: null });
  }
  const t0 = performance.now();
  applyScenarios(rows, (p) => map.get(p), undefined, H);
  const per = (performance.now() - t0) / rows.length;
  console.log(`  (cost ${per.toFixed(2)} ms/row over ${rows.length} rows)`);
  assert.ok(rows.every((r) => r.scb), "all computed");
  assert.ok(per <= 10, `${per} ms/row`);
});

for (const run of pending) await run();
console.log(`\nscenario-ledger: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
