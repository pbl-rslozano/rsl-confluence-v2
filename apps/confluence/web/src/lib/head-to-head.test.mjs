// Confluence v2 (WP23) Task 9 — Classic vs Confluence v2 on the same ledger rows and outcomes.
// Run: npm run test:h2h   (node scripts/run-engine-tests.mjs head-to-head.test.mjs)
import assert from "node:assert/strict";
import { buildReport, sanitizeLedgerRow } from "./ledger-metrics.ts";
import { asV2Row, retargetOutcome, pairedOutcomes, labelChurn, sideOf } from "./head-to-head.ts";

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log("  ok   - " + name); }
  catch (e) { failed++; console.log("  FAIL - " + name + "  [" + (e && e.message ? e.message.replace(/\n/g, " ") : e) + "]"); }
};

const H = 3_600_000;
const D = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const CFG = "f5c94871f16f6673";
const row = (over = {}) => ({
  id: `c|binance|4h|BTCUSDT|${over.t ?? T0}`, cfg: "c", src: "binance", tf: "4h", pair: "BTCUSDT", ac: "crypto", t: T0, c: 100,
  sc: 60, m: 1, st: 1, sup: 0, v2: { cfg: CFG, s: -62, m: -1, st: 2 }, ...over,
});
const outcome = (r, over = {}) => ({ row: r, horizon: 6, gross: 0.02, net: 0.015, mfe: 0.03, mae: -0.01, fundingLong: 0.0003, cost: 0.002, holdHours: 24, ...over });

test("asV2Row takes v2's label, keeps the bar, and is null without v2", () => {
  const r = row();
  const v = asV2Row(r);
  assert.equal(v.t, r.t); assert.equal(v.c, r.c); assert.equal(v.id, r.id);
  assert.equal(v.sc, -62); assert.equal(v.m, -1); assert.equal(v.st, 2); assert.equal(v.sup, 0);
  assert.equal(asV2Row(row({ v2: null })), null);
  assert.equal(asV2Row(row({ v2: undefined })), null);
  const s = asV2Row(row({ v2: { cfg: CFG, s: null, m: 0, st: 0 } }));
  assert.equal(s.sup, 1); assert.equal(s.sc, 0); assert.equal(s.m, 0);
  assert.equal(r.m, 1, "the Classic row is not modified");
});

test("retargetOutcome flips net with direction and keeps gross, cost and funding", () => {
  const o = outcome(row({ v2: null }));
  const sell = retargetOutcome(o, row({ m: -1 }));
  assert.ok(Math.abs(sell.net - (-o.gross - o.cost + o.fundingLong)) < 1e-15);
  assert.equal(sell.gross, o.gross); assert.equal(sell.cost, o.cost); assert.equal(sell.fundingLong, o.fundingLong);
  const buy = retargetOutcome(o, row({ m: 1 }));
  assert.ok(Math.abs(buy.net - (o.gross - o.cost - o.fundingLong)) < 1e-15);
  const neutral = retargetOutcome(o, row({ m: 0 }));
  assert.equal(neutral.net, buy.net, "m = 0 is measured as long");
  assert.ok(Number.isNaN(sell.mfe) && Number.isNaN(sell.mae));
  assert.equal(o.net, 0.015, "the input outcome is not modified");
});

test("both sides use the same outcomes", () => {
  const rows = [0, 1, 2, 3].map((i) => row({ t: T0 + i * 4 * H, v2: { cfg: CFG, s: i % 2 ? 60 : -60, m: i % 2 ? 1 : -1, st: 1 } }));
  const outs = new Map([[3, rows.map((r, i) => outcome(r, { horizon: 3, gross: 0.001 * (i + 1) }))], [6, rows.map((r, i) => outcome(r, { gross: -0.002 * i }))]]);
  const { classic, v2 } = pairedOutcomes(outs);
  for (const h of [3, 6]) {
    assert.deepEqual(classic.get(h).map((o) => o.row.id), v2.get(h).map((o) => o.row.id));
    assert.deepEqual(classic.get(h).map((o) => o.gross), v2.get(h).map((o) => o.gross));
    assert.equal(classic.get(h).length, 4);
  }
  assert.equal(classic.get(3)[0].row.m, 1, "Classic side keeps Classic's label");
  assert.equal(v2.get(3)[0].row.m, -1, "v2 side carries v2's label");
});

test("rows without v2 are left out of both sides", () => {
  const a = row({ t: T0 }); const b = row({ t: T0 + 4 * H, v2: null }); const c = row({ t: T0 + 8 * H, v2: undefined });
  const { classic, v2 } = pairedOutcomes(new Map([[6, [outcome(a), outcome(b), outcome(c)]]]));
  assert.deepEqual(classic.get(6).map((o) => o.row.id), [a.id]);
  assert.deepEqual(v2.get(6).map((o) => o.row.id), [a.id]);
});

test("labelChurn counts changes over contiguous steps", () => {
  const seq = [1, 1, 0, -1].map((m, i) => row({ t: T0 + i * 4 * H, m }));
  const c = labelChurn(seq, 4 * H);
  assert.equal(c.changes, 2); assert.equal(c.steps, 3); assert.ok(Math.abs(c.per100 - 200 / 3) < 1e-12);
  // bars at 0, 1, 3, 5 (two missing bars): only the first pair is a step
  const gap = [[0, 1], [1, 0], [3, 0], [5, -1]].map(([b, m]) => row({ t: T0 + b * 4 * H, m }));
  const g = labelChurn(gap, 4 * H);
  assert.equal(g.steps, 1); assert.equal(g.changes, 1);
  const two = [...[1, 0].map((m, i) => row({ t: T0 + i * 4 * H, m })), ...[1, 1].map((m, i) => row({ pair: "ETHUSDT", t: T0 + i * 4 * H, m }))];
  const tw = labelChurn(two, 4 * H);
  assert.equal(tw.steps, 2); assert.equal(tw.changes, 1);
  const months = [0, 31, 61, 92].map((d, i) => row({ tf: "1M", t: T0 + d * D, m: i % 2 ? 1 : 0 }));
  const mo = labelChurn(months, 30 * D);
  assert.equal(mo.steps, 3); assert.equal(mo.changes, 3);
  assert.ok(Number.isNaN(labelChurn([row()], 4 * H).per100));
  assert.ok(Number.isNaN(labelChurn([], 4 * H).per100));
});

const fakeReport = (groups, ic = 1.5, psr = 0.7) => ({ horizons: [{ horizon: 6, groups, ic: { mean: 0, tStat: ic, periods: 3 }, sharpe: { psr } }] });
const grp = (label, n, hit, net, edge) => ({ label, n, hitRate: hit, meanNetBps: net, edgeBps: edge });

test("sideOf weights groups by n and is NaN without signals", () => {
  const rep = fakeReport([grp("BUY · all", 30, 0.6, 10, 4), grp("BUY · strong", 99, 0.9, 99, 99), grp("SELL · all", 10, 0.4, -10, 0)]);
  const s = sideOf(rep, 6, 12.5);
  assert.equal(s.n, 40);
  assert.ok(Math.abs(s.hitRate - 0.55) < 1e-12);
  assert.ok(Math.abs(s.meanNetBps - 5) < 1e-12);
  assert.ok(Math.abs(s.edgeBps - 3) < 1e-12);
  assert.equal(s.icT, 1.5); assert.equal(s.psr, 0.7); assert.equal(s.churnPer100, 12.5);
  const none = sideOf(fakeReport([]), 6, NaN);
  assert.equal(none.n, 0); assert.ok(Number.isNaN(none.hitRate) && Number.isNaN(none.meanNetBps) && Number.isNaN(none.edgeBps));
  const noH = sideOf(fakeReport([]), 99, 1);
  assert.equal(noH.n, 0); assert.ok(Number.isNaN(noH.icT));
});

test("the Classic report is unchanged by v2 fields", () => {
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const m = [1, -1, 0, 1][i % 4];
    rows.push(row({ t: T0 + i * 4 * H, pair: `P${i % 6}USDT`, id: `c|binance|4h|P${i % 6}USDT|${T0 + i * 4 * H}`, sc: m * 60, m, st: (i % 3) , v2: { cfg: CFG, s: -m * 50, m: -m, st: 1 } }));
  }
  const outs = new Map([[3, rows.map((r, i) => outcome(r, { horizon: 3, gross: ((i * 7) % 11 - 5) / 500, net: ((i * 7) % 11 - 5) / 500 * (r.m || 1) - 0.002 }))]]);
  const stripRows = rows.map(({ v2, ...rest }) => rest);
  const stripOuts = new Map([[3, outs.get(3).map((o, i) => ({ ...o, row: stripRows[i] }))]]);
  const a = buildReport(rows, outs, 20, 1, 4 * H, { shuffles: 20 });
  const b = buildReport(stripRows, stripOuts, 20, 1, 4 * H, { shuffles: 20 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
