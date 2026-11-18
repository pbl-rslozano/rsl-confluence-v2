// Confluence v2 (WP23) Task 9 — Classic vs Confluence v2 on the same ledger rows and outcomes.
// Run: npm run test:h2h   (node scripts/run-engine-tests.mjs head-to-head.test.mjs)
import assert from "node:assert/strict";
import { buildReport, sanitizeLedgerRow } from "./ledger-metrics.ts";
import { asV2Row, retargetOutcome, pairedOutcomes, labelChurn, sideOf, splitByV2, headToHeadPrep, headToHeadLoader } from "./head-to-head.ts";

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
  const { classic, v2 } = pairedOutcomes(outs, CFG);
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
  const { classic, v2 } = pairedOutcomes(new Map([[6, [outcome(a), outcome(b), outcome(c)]]]), CFG);
  assert.deepEqual(classic.get(6).map((o) => o.row.id), [a.id]);
  assert.deepEqual(v2.get(6).map((o) => o.row.id), [a.id]);
});

// Final review I2: only rows of the CURRENT v2 config are compared; rows of another v2 version are counted, never pooled.
const OTHER = "0123456789abcdef";
const inputsOf = (rows) => ({ rows, outcomes: new Map([[6, rows.map((r) => outcome(r))]]), costBps: 20, trials: 1, intervalMs: 4 * H, momentum: new Map() });
test("rows with another v2 config id are excluded from both sides and counted", () => {
  const a = row({ t: T0 });
  const b = row({ t: T0 + 4 * H, v2: { cfg: OTHER, s: 70, m: 1, st: 2 } });
  const c = row({ t: T0 + 8 * H, v2: null });
  const d = row({ t: T0 + 12 * H, v2: { cfg: CFG, s: null, m: 0, st: 0 } });
  const e = row({ t: T0 + 16 * H, v2: { cfg: OTHER, s: null, m: 0, st: 0 } });
  const split = splitByV2([a, b, c, d, e], CFG);
  assert.deepEqual(split.compared.map((r) => r.id), [a.id, d.id]);
  assert.equal(split.notCompared, 1, "rows without v2");
  assert.equal(split.otherVersions, 2, "rows of another v2 version, counted separately");
  const { classic, v2 } = pairedOutcomes(new Map([[6, [a, b, c, d, e].map((r) => outcome(r))]]), CFG);
  assert.deepEqual(classic.get(6).map((o) => o.row.id), [a.id, d.id]);
  assert.deepEqual(v2.get(6).map((o) => o.row.id), [a.id, d.id]);
  const prep = headToHeadPrep(inputsOf([a, b, c, d, e]), CFG);
  assert.equal(prep.n, 2); assert.equal(prep.notCompared, 1); assert.equal(prep.otherVersions, 2);
  assert.equal(prep.paired.get(6), 2);
});

// Final review I1: the comparison is built lazily — nothing while the section is closed, once per (inputs, v2 config).
const countingBuilder = () => {
  const calls = [];
  const build = async (x) => { calls.push(x); return buildReport(x.rows, x.outcomes, x.costBps, x.trials, x.intervalMs, { shuffles: 5 }); };
  return { calls, build };
};
const atest = async (name, fn) => {
  try { await fn(); passed++; console.log("  ok   - " + name); }
  catch (e) { failed++; console.log("  FAIL - " + name + "  [" + (e && e.message ? e.message.replace(/\n/g, " ") : e) + "]"); }
};
await atest("closed section → no head-to-head report built; open → built once per inputs and cached", async () => {
  const { calls, build } = countingBuilder();
  const load = headToHeadLoader(build);
  const inputs = inputsOf([0, 1, 2].map((i) => row({ t: T0 + i * 4 * H })));
  assert.equal(load(false, inputs, CFG), null, "closed: no job");
  assert.equal(load(false, inputs, CFG), null);
  await Promise.resolve();
  assert.equal(calls.length, 0, "closed: no report built");
  assert.equal(load(true, null, CFG), null, "no inputs yet (Classic report not rendered): no job");
  const job = load(true, inputs, CFG);
  assert.ok(job, "open: a job");
  assert.equal(job.prep.n, 3);
  const reports = await job.reports;
  assert.equal(calls.length, 2, "Classic side and v2 side");
  assert.ok(reports.classic && reports.v2);
  assert.ok(Number.isFinite(reports.churn.classic) && Number.isFinite(reports.churn.v2));
  assert.equal(load(true, inputs, CFG), job, "re-opened: the cached job");
  assert.equal(load(false, inputs, CFG), null, "closed again: nothing");
  assert.equal(load(true, inputs, CFG), job);
  assert.equal(calls.length, 2, "no rebuild for the same inputs");
  const next = inputsOf([0, 1].map((i) => row({ t: T0 + i * 4 * H })));
  const job2 = load(true, next, CFG);
  assert.notEqual(job2, job, "a new measurement (new inputs) builds again");
  await job2.reports;
  assert.equal(calls.length, 4);
  const job3 = load(true, next, OTHER);
  assert.notEqual(job3, job2, "another v2 config id builds again");
  assert.equal(job3.prep.n, 0);
  assert.equal(await job3.reports, null, "nothing to compare: no report built");
  assert.equal(calls.length, 4);
});

await atest("a failed build is not cached", async () => {
  let fail = true;
  const load = headToHeadLoader(async (x) => { if (fail) throw new Error("worker"); return buildReport(x.rows, x.outcomes, x.costBps, x.trials, x.intervalMs, { shuffles: 5 }); });
  const inputs = inputsOf([row()]);
  const job = load(true, inputs, CFG);
  await assert.rejects(job.reports);
  fail = false;
  const again = load(true, inputs, CFG);
  assert.notEqual(again, job);
  assert.ok((await again.reports).v2);
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

// K-Dense v2 (18 Nov 2026) A-M4: the user guide says Classic labels have no hysteresis and Confluence v2 adds it. On the
// WP23 4h evidence fixture v2's label churn is below Classic's (ADR-0017 table, all eight 1,600-bar 4h walks: 0.48 vs
// 5.18 label changes per 100 bars). To keep the suite fast (controller ruling, round 2) this test scores the FIRST walk
// of that fixture only (W0USDT, every bar j >= 299 on its trailing 1,000 bars, v2 attached: 1,301 rows, ~7 s).
// Measured 18 Nov 2026 on that slice: Classic 4.77, v2 0.31 changes per 100 bars (2 walks: 4.62 vs 0.31, ~15 s).
{
  const { fixtureRows } = await import("./wp23-evidence.mjs");
  const { v2ConfigId } = await import("./confluence-v2.ts");
  const t4 = performance.now();
  const { rows, intervalMs } = fixtureRows("4h", 1);
  const withV2 = rows.filter((r) => r.v2?.cfg === v2ConfigId());
  const classic = labelChurn(withV2, intervalMs).per100;
  const v2 = labelChurn(withV2.map(asV2Row), intervalMs).per100;
  console.log(`    4h evidence fixture, first walk: ${withV2.length} rows with v2; churn per 100 bars Classic ${classic.toFixed(2)}, v2 ${v2.toFixed(2)} (${((performance.now() - t4) / 1000).toFixed(1)} s)`);
  test("A-M4: on the 4h evidence fixture (first walk), labelChurn(v2 rows).per100 < labelChurn(classic rows).per100", () => {
    assert.ok(withV2.length > 1000 && withV2.length === rows.length, `${withV2.length} of ${rows.length}`);
    assert.ok(Number.isFinite(v2) && Number.isFinite(classic));
    assert.ok(v2 < classic, `v2 ${v2} vs classic ${classic}`);
  });
}

console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
