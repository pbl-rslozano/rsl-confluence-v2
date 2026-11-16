// Every tool, over an in-memory MCP connection, against the fixture data dir.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureClient, DISCLAIMER } from "../test-support/helpers.mjs";
import { ENGINE_A, ENGINE_B, LAST, T0, H, PAIRS } from "../test-support/fixture.mjs";
import { loadMetricsLib } from "../src/lib-loader.mjs";
import { TOOL_NAMES } from "../src/server.mjs";

let ctx;
before(async () => { ctx = await fixtureClient(); });
after(async () => { await ctx.close(); rmSync(ctx.fx.dir, { recursive: true, force: true }); });

test("tools/list: exactly the seven analyst tools, read-only except log_trial", async () => {
  const { tools } = await ctx.client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [...TOOL_NAMES].sort());
  assert.deepEqual(names, ["latest_signals", "ledger_overview", "list_trials", "log_trial", "performance_report", "query_ledger", "recorder_health"]);
  for (const t of tools) {
    const words = t.name.split("_");
    assert.ok(!words.some((w) => /^(order|orders|trade|buy|sell|withdraw|transfer|delete|remove|edit|update|key|keys|place|cancel)$/.test(w)), t.name);
    assert.equal(t.annotations.openWorldHint, false, `${t.name} must not be open-world`);
    assert.equal(t.annotations.readOnlyHint, t.name !== "log_trial", t.name);
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name} rejects unknown keys`);
  }
  const log = tools.find((t) => t.name === "log_trial");
  assert.equal(log.annotations.destructiveHint, false);
});

test("ledger_overview: counts rows, engines, warm/cold/uc, bad lines and duplicates", async () => {
  const o = await ctx.call("ledger_overview");
  assert.equal(o.rows, ctx.fx.totalRows);
  assert.deepEqual(Object.keys(o.engines).sort(), [ENGINE_A, ENGINE_B]);
  assert.equal(o.engines[ENGINE_B].rows, ctx.fx.rowsB);
  assert.equal(o.warmup.cold, 1);
  assert.equal(o.warmup.thresholdBars, 300);
  assert.equal(o.underlyingClosed, 1);
  assert.equal(o.duplicateIds, 1);
  assert.equal(o.invalidLines, 1);
  assert.deepEqual(Object.keys(o.sources).sort(), ["binance", "bitget", "bybit-perp"]);
  assert.equal(o.barRange.to, new Date(T0 + LAST * 4 * H).toISOString());
  assert.deepEqual(o.files.map((f) => f.file), ["ledger/2026-08.jsonl", "ledger/2026-09.jsonl", "exports/ledger-bitget.json", "exports/ledger-bybit.csv"]);
});

test("query_ledger: filters, ordering, limit and output cap", async () => {
  const b = await ctx.call("query_ledger", { engine_id: ENGINE_B, limit: 500 });
  assert.equal(b.matched, ctx.fx.rowsB);
  assert.ok(b.rows.every((r) => r.engine === ENGINE_B && r.pair === "ETHUSDT"));
  const strongBuys = await ctx.call("query_ledger", { engine_id: ENGINE_A, source: "binance", direction: "BUY", strength: "strong", limit: 500 });
  assert.ok(strongBuys.matched > 0 && strongBuys.rows.every((r) => r.dir === "BUY" && r.strength === "strong" && r.score >= 70));
  const day = await ctx.call("query_ledger", { pair: ["ethusdt"], from: "2026-09-08", to: "2026-09-08", engine_id: ENGINE_A });
  assert.equal(day.matched, 6, "six 4h bars on one day");
  assert.ok(day.rows.every((r) => r.bar.startsWith("2026-09-08")));
  const oldest = await ctx.call("query_ledger", { order: "oldest", limit: 1 });
  assert.equal(oldest.rows[0].bar, new Date(T0).toISOString());
  const tooMany = await ctx.raw("query_ledger", { limit: 501 });
  assert.equal(tooMany.isError, true);
  assert.ok(tooMany.content[0].text.endsWith(DISCLAIMER), "validation errors carry the disclaimer");
  const full = await ctx.call("query_ledger", { limit: 1, full: true });
  assert.ok("id" in full.rows[0] && "cfg" in full.rows[0]);
  const big = await ctx.call("query_ledger", { limit: 500, full: true });
  assert.ok(big._truncated && big._truncated.removedItems > 0, "large responses are trimmed and say so");
  assert.ok(big.rows.length < big.matched);
});

test("query_ledger: CSV and JSON exports round-trip into LedgerRows", async () => {
  const csv = await ctx.call("query_ledger", { file: "exports/ledger-bybit.csv", order: "oldest", full: true });
  assert.equal(csv.matched, 3);
  const [first, second] = csv.rows;
  assert.equal(first.src, "bybit-perp");
  assert.equal(first.m, 1); assert.equal(first.st, 2); assert.equal(first.sc, 72);
  assert.deepEqual(first.bl, [30, -10, 5, 12]);
  assert.deepEqual(first.xnet, { 1: 0.001, 3: 0.003, 6: 0.006, 12: 0.012, 24: 0.024 });
  assert.equal(second.m, -1);
  assert.equal(second.beta, 1.3);
  assert.equal(second.rku, 7, "second universe_rank column = unfiltered rank");
  assert.equal(second.rks, "live");
  assert.deepEqual(first.rad, { t: first.tc, frp: 82.5, oi24: -3.25, ls: 1.8, tk: 0.54, usP: 0.12, krP: -1.4, phP: 0.9, al: ["BREAKAWAY_KR", "DEPEG_USDC"] }, "v2.8 (WP25): the radar columns come back as rad");
  assert.ok(!("rad" in second), "a row with empty radar cells has no rad");
  const json = await ctx.call("query_ledger", { file: "exports/ledger-bitget.json" });
  assert.equal(json.matched, 2);
  assert.ok(json.rows.every((r) => r.src === "bitget" && r.tf === "1d"));
});

test("latest_signals: newest bar per engine × source × timeframe, strong first", async () => {
  const l = await ctx.call("latest_signals", { source: "binance" });
  const a = l.groups.find((g) => g.engine === ENGINE_A);
  assert.equal(a.bar, new Date(T0 + LAST * 4 * H).toISOString());
  assert.equal(a.rowsAtBar, PAIRS.length);
  assert.equal(a.rows[0].pair, "ETHUSDT");
  assert.equal(a.rows[0].score, 88);
  for (let i = 1; i < a.rows.length; i++) {
    const order = ["weak", "moderate", "strong"];
    assert.ok(order.indexOf(a.rows[i - 1].strength) >= order.indexOf(a.rows[i].strength), "strength descending");
  }
  assert.ok(a.rows.every((r) => r.dir !== "NEUTRAL"));
  const withNeutral = await ctx.call("latest_signals", { source: "binance", engine_id: ENGINE_A, directional_only: false });
  assert.equal(withNeutral.groups[0].rows.length, PAIRS.length);
});

test("performance_report: same numbers as the app library, per engine id, never pooled", async () => {
  const rep = await ctx.call("performance_report", { source: "binance", timeframe: "4h" });
  assert.equal(rep.groups.length, 2, "one group per engine");
  for (const g of rep.groups) assert.deepEqual(g.report.configIds, [g.engine]);
  const a = rep.groups.find((g) => g.engine === ENGINE_A);
  assert.deepEqual(a.pairsWithoutCandles, ["ADAUSDT"]);
  assert.equal(a.benchmark, "BTCUSDT");
  assert.equal(a.excluded.coldWarmup, 1);
  assert.equal(a.excluded.underlyingClosed, 1);
  assert.deepEqual(a.costs, { feeBps: 10, slipBps: 5, fundingBpsPer8h: 0, roundTripBps: 30, assumed: "app defaults (costsFor: source + asset-class slippage)" });

  // Independent computation with the library itself (what the app's Ledger dialog does).
  const { lib } = await loadMetricsLib();
  const series = ctx.fx.series;
  // Rows straight from the fixture files (first occurrence of each id wins, as in the server).
  const byId = new Map();
  for (const f of ["ledger/2026-08.jsonl", "ledger/2026-09.jsonl"]) {
    for (const line of readFileSync(join(ctx.fx.dir, f), "utf8").split("\n")) {
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (!byId.has(r.id)) byId.set(r.id, r);
    }
  }
  const rows = [...byId.values()].filter((r) => r.cfg === ENGINE_A && r.src === "binance");
  const usable = rows.filter((r) => r.wb >= lib.WARM_MIN_BARS && !r.uc);
  assert.equal(usable.length, a.usable);
  const outcomes = new Map(lib.DEFAULT_HORIZONS.map((h) => [h, []]));
  for (const r of usable) {
    if (r.pair === "ADAUSDT") continue;
    for (const h of lib.DEFAULT_HORIZONS) { const o = lib.measureOutcome(r, series[r.pair], h, lib.DEFAULT_COSTS.binance, 4 * H); if (o) outcomes.get(h).push(o); }
  }
  const expected = lib.buildReport(usable, outcomes, 30, 1, 4 * H);
  for (const h of expected.horizons) {
    const got = a.report.horizons.find((x) => x.horizon === h.horizon);
    assert.equal(got.scored, h.scored, `scored h=${h.horizon}`);
    assert.equal(got.ic.periods, h.ic.periods);
    for (const g of h.groups) {
      const gg = got.groups.find((x) => x.label === g.label);
      assert.equal(gg.n, g.n, `${g.label} n at h=${h.horizon}`);
      assert.ok(Math.abs(gg.meanNetBps - g.meanNetBps) < 1e-3 * Math.max(1, Math.abs(g.meanNetBps)), `${g.label} mean at h=${h.horizon}`);
      assert.ok(Math.abs(gg.edgeBps - g.edgeBps) < 1e-3 * Math.max(1, Math.abs(g.edgeBps)), `${g.label} edge at h=${h.horizon}`);
    }
    assert.equal(typeof got.gate.pass, "boolean");
    assert.equal(got.gate.checks.measuredDirectional_ge_200.ok, false, "a tiny fixture never passes the gate");
    assert.equal(got.btcExcess.benchmark, "BTCUSDT");
    assert.ok(got.btcExcess.buy.n > 0);
    assert.ok(Array.isArray(got.btcExcess.buy.hitCi95));
  }
  const h1 = a.report.horizons.find((x) => x.horizon === 1);
  assert.ok(h1.btcExcess.betaResidualIc.periods > 0, "beta-residual IC uses recorded betas");
});

test("performance_report: options (class split, horizons, warm-up, costs, trials)", async () => {
  const r = await ctx.call("performance_report", { engine_id: ENGINE_A, source: "binance", horizons: [6], min_warm_bars: 1000, fee_bps: 20, slippage_bps: 10, trials: 7, shuffles: 0 });
  const g = r.groups[0];
  assert.equal(r.groups.length, 1);
  assert.deepEqual(g.report.horizons.map((h) => h.horizon), [6]);
  assert.equal(g.excluded.minWarmBars, 1000);
  assert.equal(g.costs.roundTripBps, 60);
  assert.equal(g.costs.assumed, "overridden");
  assert.deepEqual(r.trialsForDsr, { used: 7, source: "argument" });
  const other = await ctx.call("performance_report", { engine_id: ENGINE_A });
  assert.deepEqual(other.groups.map((x) => `${x.source}|${x.timeframe}`).sort(), ["binance|4h", "bitget|1d", "bybit-perp|1h"]);
  const perp = other.groups.find((x) => x.source === "bybit-perp");
  assert.equal(perp.costs.fundingBpsPer8h, 1, "perp funding from DEFAULT_COSTS");
  assert.equal(perp.benchmark, "none cached (no BTC-excess figures)");
});

test("recorder_health: heartbeat age, status and last errors", async () => {
  const h = await ctx.call("recorder_health");
  assert.equal(h.heartbeat.present, true);
  assert.equal(h.heartbeat.status, "ok");
  assert.equal(h.heartbeat.staleAfterMinutes, 15, "3 × the heartbeat interval");
  assert.ok(h.heartbeat.ageMinutes >= 4.9 && h.heartbeat.ageMinutes < 7);
  assert.match(JSON.stringify(h.heartbeat.lastErrors), /429/);
  assert.equal(h.ledger.files, 2);
  assert.equal(h.ledger.newestRecordTime, new Date(T0 + (LAST * 4 + 4) * H + 5000).toISOString(), "max of the tail, not the last line");
  assert.equal(h.rankings.files, 1);
  assert.equal(h.derivs.files, 1);
  assert.equal(h.candles.files, 7);

  writeFileSync(join(ctx.fx.dir, "heartbeat.json"), JSON.stringify({ at: Date.now() - 3 * 3_600_000 }));
  const stale = await ctx.call("recorder_health", { stale_after_minutes: 60 });
  assert.equal(stale.heartbeat.status, "stale");
  rmSync(join(ctx.fx.dir, "heartbeat.json"));
  const none = await ctx.call("recorder_health");
  assert.equal(none.heartbeat.present, false);
  assert.match(none.overall, /no heartbeat/);
});

test("log_trial + list_trials: hypotheses feed the deflated Sharpe trial count", async () => {
  const first = await ctx.call("log_trial", { hypothesis: "Strong BUY on 4h crypto beats base at h=6", metric: "edge after costs > 0 and Wilson low > base hit", config: { engine: ENGINE_A, tf: "4h", h: 6 } });
  assert.match(first.logged.id, /^T0001-[0-9a-f]{4}$/);
  assert.equal(first.logged.decision, "pending");
  await ctx.call("log_trial", { hypothesis: "Beta-residual IC at h=6 is positive", metric: "IC t ≥ 2", decision: "pending" });
  const verdict = await ctx.call("log_trial", { hypothesis: "Verdict on T0001 after 90 days of data", metric: "edge after costs > 0", decision: "reject", ref: first.logged.id });
  assert.equal(verdict.hypothesesInRegister, 2, "a verdict (ref) is not a new hypothesis");
  const list = await ctx.call("list_trials");
  assert.equal(list.total, 3);
  assert.equal(list.hypotheses, 2);
  assert.deepEqual(list.byDecision, { pending: 2, reject: 1 });
  assert.equal(list.trials[0].ref, first.logged.id, "newest first");
  const rejected = await ctx.call("list_trials", { decision: "reject" });
  assert.equal(rejected.trials.length, 1);
  const rep = await ctx.call("performance_report", { engine_id: ENGINE_B, horizons: [1], shuffles: 0 });
  assert.equal(rep.trialsForDsr.used, 2);
});

test("every response ends with the disclaimer, errors included", async () => {
  const calls = [
    ["ledger_overview", {}], ["query_ledger", { limit: 1 }], ["latest_signals", {}], ["recorder_health", {}], ["list_trials", {}],
    ["performance_report", { horizons: [1], shuffles: 0, max_groups: 1 }],
    ["query_ledger", { nope: true }], ["query_ledger", { file: "../outside.jsonl" }], ["log_trial", { hypothesis: "short", metric: "x" }],
    ["no_such_tool", {}],
  ];
  for (const [name, args] of calls) {
    const res = await ctx.raw(name, args);
    assert.ok(res.content[0].text.endsWith(DISCLAIMER), `${name} ${JSON.stringify(args)}`);
  }
});
