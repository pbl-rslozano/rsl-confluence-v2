// Recorder cycle tests — offline (globalThis.fetch is never the real one) and on a mocked clock.
import test, { beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  barWhileClosed, classifySymbol, detectHistoricalPattern, ENGINE_BARS, enrich, percentiles, resetRateLimitForTests, rateLimitCooldown, ret20, scoreSeries, toLedgerRow,
} from "../src/engine.mjs";
import { createRecorder, readHeartbeatStatus } from "../src/recorder-core.mjs";
import { nextWake } from "../src/schedule.mjs";
import { baseConfig, bars, currentOpen, mockExchange, quiet, STEP_4H, T0, tempDir } from "./fixtures.mjs";

const IV = STEP_4H;
const readJsonl = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const ledgerRows = (dir, month = "2026-10") => readJsonl(join(dir, "ledger", `${month}.jsonl`));
const allLedger = (dir) => ["2026-10", "2026-11"].flatMap((m) => ledgerRows(dir, m));

async function runOnce(dir, ex, extra = {}, deps = {}) {
  const rec = createRecorder(baseConfig(dir, extra), { ...quiet, baseFetch: ex.fetch, env: {}, ...deps });
  const result = await rec.run(undefined, { once: true });
  return { rec, result };
}

// Universe of the mock (Binance, crypto view, limit 3) and the full ranking (all classes, pegs excluded).
const UNIVERSE = [
  { symbol: "BTCUSDT", rank: 1, qv: 9e9 },
  { symbol: "ETHUSDT", rank: 2, qv: 5e9 },
  { symbol: "SOLUSDT", rank: 3, qv: 2e9 },
];
const FULL_RANK = { BTCUSDT: 1, ETHUSDT: 2, PAXGUSDT: 3, SOLUSDT: 4, EURUSDT: 5, XRPUSDT: 6 };

/** Expected live rows, built straight from the engine functions — the app's page.tsx assembly. */
function expectedLive(klBySym, rec) {
  const rsMap = percentiles(new Map(UNIVERSE.map((u) => [u.symbol, ret20(klBySym[u.symbol]) ?? NaN])));
  return UNIVERSE.map((u) => {
    const kl = klBySym[u.symbol];
    const ac = classifySymbol("binance", u.symbol);
    const score = scoreSeries(kl, { intervalMs: IV, volumeAvailable: true, assetClass: ac });
    const last = kl[kl.length - 1];
    // v2.8 (WP19): the Pattern output, as the app's scan job computes it.
    const p = detectHistoricalPattern(kl, { volumeAvailable: true, intervalMs: IV, currentConfluence: score.confluence, currentReversal: score.reversal });
    const row = toLedgerRow(kl, score, {
      src: "binance", tf: "4h", pair: u.symbol, ac, intervalMs: IV, closeTime: last.time + IV, rank: u.rank, quoteVolume: u.qv,
      appVersion: "recorder-2.5.1", live: true, recordedAt: rec, underlyingClosed: barWhileClosed(ac, last.time, IV),
      universeRank: FULL_RANK[u.symbol], rankSource: "live", pattern: { direction: p.direction, confidence: p.confidence },
    });
    Object.assign(row, enrich(row, kl, { intervalMs: IV, btc: klBySym.BTCUSDT, basis: undefined, rs: rsMap.get(u.symbol) ?? null, split: "split" in score ? Boolean(score.split) : false }));
    return JSON.parse(JSON.stringify(row));
  });
}

beforeEach(() => {
  resetRateLimitForTests();
  mock.timers.enable({ apis: ["Date"], now: T0 });
});
afterEach(() => mock.timers.reset());

test("live rows are identical to scoreSeries + toLedgerRow (+ enrich) on the same closed bars", async (t) => {
  const dir = tempDir(t);
  const ex = mockExchange();
  const { result } = await runOnce(dir, ex);
  assert.equal(result.ok, true);
  assert.equal(result.written, 3);
  // Warm start: no cache yet, so every series asked for the full 1,000-bar window.
  assert.deepEqual(ex.calls.filter((c) => c.path === "/api/v3/klines").map((c) => new URL(c.url).searchParams.get("limit")), ["1000", "1000", "1000"]);

  const cur = currentOpen(T0);
  const klBySym = Object.fromEntries(UNIVERSE.map((u) => [u.symbol, bars(u.symbol, cur - 999 * IV, cur - IV)])); // in-progress bar dropped
  const got = ledgerRows(dir);
  assert.deepEqual(got, expectedLive(klBySym, T0));
  assert.equal(got[0].wb, 999, "engine saw every closed bar it was given");
  assert.equal(got[2].rk, 3, "rank = position in the scanned (class) universe, as in the app");
  assert.equal(got[2].rku, 4, "rku = position in the full unfiltered venue ranking");
  assert.equal(got[0].t, cur - IV, "newest CLOSED bar, never the bar in progress");
  // v2.8 (WP19): every row logs the vote vector and the Pattern output; no derivatives configured → null.
  for (const r of got) {
    assert.ok(Number.isSafeInteger(r.vt) && r.vt >= 0 && r.vt <= 4 ** 18 - 1);
    assert.ok([-1, 0, 1].includes(r.pd) && [0, 1, 2, 3].includes(r.pc));
    assert.equal(r.fr, null);
    assert.equal(r.oiChg, null);
  }
});

test("restarts never record a bar twice; the id index is rebuilt from the ledger and a torn line is cut", async (t) => {
  const dir = tempDir(t);
  const ex = mockExchange();
  const first = await runOnce(dir, ex);
  assert.equal(first.result.written, 3);

  const second = await runOnce(dir, ex); // new process, same bar
  assert.equal(second.result.written, 0);
  assert.equal(second.result.duplicates, 3);

  // Index lost (e.g. deleted by hand): rebuilt from the .jsonl, still no duplicates.
  rmSync(join(dir, "ledger", "2026-10.ids"));
  const third = await runOnce(dir, ex);
  assert.equal(third.result.written, 0);
  assert.equal(readFileSync(join(dir, "ledger", "2026-10.ids"), "utf8").trim().split("\n").length, 3);

  // Crash mid-append: a partial line without newline is cut on the next open.
  appendFileSync(join(dir, "ledger", "2026-10.jsonl"), '{"id":"partial-row","cfg":');
  const fourth = await runOnce(dir, ex);
  assert.equal(fourth.result.written, 0);
  const rows = ledgerRows(dir);
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((r) => r.id)).size, 3);
});

test("catch-up after a gap scores every missed closed bar with the full ENGINE_BARS window", async (t) => {
  const dir = tempDir(t);
  const ex = mockExchange();
  await runOnce(dir, ex);
  const cur1 = currentOpen(T0);

  // Recorder down for 10 bars.
  const t2 = T0 + 10 * IV;
  mock.timers.setTime(t2);
  const { result } = await runOnce(dir, ex);
  const cur2 = currentOpen(t2);
  assert.equal(result.ok, true);
  assert.equal(result.catchUpRows, 27, "9 missed bars × 3 series (the newest bar is the live row)");
  assert.equal(result.written, 30);

  const rows = allLedger(dir);
  const btc = rows.filter((r) => r.pair === "BTCUSDT").sort((a, b) => a.t - b.t);
  const times = btc.map((r) => r.t);
  const expectedTimes = Array.from({ length: 11 }, (_, i) => cur1 - IV + i * IV);
  assert.deepEqual(times, expectedTimes, "no holes: the old live bar, 9 catch-up bars, the new live bar");
  assert.ok(btc.slice(1).every((r) => r.wb === ENGINE_BARS), "every catch-up and new live row saw a full window");

  // Independent rebuild of the catch-up rows from the same bars.
  const merged = Object.fromEntries(UNIVERSE.map((u) => [u.symbol, bars(u.symbol, cur1 - 999 * IV, cur2 - IV)]));
  for (const u of UNIVERSE) {
    const kl = merged[u.symbol];
    const ac = classifySymbol("binance", u.symbol);
    for (const row of rows.filter((r) => r.pair === u.symbol && r.rks === "now")) {
      const j = kl.findIndex((b) => b.time === row.t);
      const window = kl.slice(j - ENGINE_BARS + 1, j + 1);
      const s = scoreSeries(window, { intervalMs: IV, volumeAvailable: true, assetClass: ac });
      const exp = toLedgerRow(window, s, {
        src: "binance", tf: "4h", pair: u.symbol, ac, intervalMs: IV, closeTime: row.t + IV, rank: u.rank, quoteVolume: u.qv,
        appVersion: "recorder-2.5.1", live: true, recordedAt: t2, underlyingClosed: barWhileClosed(ac, row.t, IV),
        universeRank: FULL_RANK[u.symbol], rankSource: "now",
      });
      Object.assign(exp, enrich(exp, kl.slice(0, j + 1), { intervalMs: IV, btc: merged.BTCUSDT, rs: null }));
      assert.deepEqual(row, JSON.parse(JSON.stringify(exp)), `${u.symbol} ${new Date(row.t).toISOString()}`);
    }
  }
  // Second cycle needed only 1,000 bars per series and the cache filled the rest.
  assert.ok(existsSync(join(dir, "candles", "binance", "4h", "BTCUSDT.json")));
});

test("the rankings log holds the full unfiltered venue ranking of every cycle", async (t) => {
  const dir = tempDir(t);
  const ex = mockExchange();
  await runOnce(dir, ex);
  mock.timers.setTime(T0 + IV);
  await runOnce(dir, ex);
  const log = readJsonl(join(dir, "rankings", "2026-10.jsonl"));
  assert.equal(log.length, 2);
  assert.deepEqual(log[0].ranks.map(([s]) => s), ["BTCUSDT", "ETHUSDT", "PAXGUSDT", "SOLUSDT", "EURUSDT", "XRPUSDT"], "all classes, USDC peg excluded, by volume");
  assert.deepEqual(log[0].ranks[0], ["BTCUSDT", 9e9]);
  assert.equal(log[0].src, "binance");
  assert.equal(log[0].tf, "4h");
  assert.equal(log[0].t, T0);
  assert.equal(log[1].t, T0 + IV);
});

test("a rate limit on the ticker list stops the cycle before any candle request and pauses the next one", async (t) => {
  const dir = tempDir(t);
  const ex = mockExchange({
    override: (url) => (url.pathname === "/api/v3/ticker/24hr" ? new Response('{"code":-1003}', { status: 429, headers: { "retry-after": "45" } }) : undefined),
  });
  const rec = createRecorder(baseConfig(dir), { ...quiet, baseFetch: ex.fetch, env: {} });
  const r1 = await rec.run(undefined, { once: true });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /rate limited \(429\)/);
  assert.equal(ex.calls.filter((c) => c.path === "/api/v3/klines").length, 0, "no candle request after the 429");
  assert.ok(r1.rateLimitedUntil >= T0 + 45_000);
  assert.ok(nextWake({ now: Date.now(), tf: "4h", ok: false, consecutiveFailures: 1, cooldownUntil: r1.rateLimitedUntil }) > T0 + 45_000, "sleeps at least the Retry-After");

  // Inside the cooldown: no request at all.
  const before = ex.calls.length;
  const r2 = await rec.run(undefined, { once: true });
  assert.equal(r2.ok, false);
  assert.equal(ex.calls.length, before);
  const hb = JSON.parse(readFileSync(join(dir, "heartbeat.json"), "utf8"));
  assert.equal(hb.consecutiveFailures, 2);
  assert.ok(hb.rateLimitedUntil >= T0 + 45_000);

  // A restart (new process, engine cooldown gone) still honours the persisted cooldown…
  resetRateLimitForTests();
  mock.timers.setTime(T0 + 20_000);
  await runOnce(dir, ex);
  assert.equal(ex.calls.length, before, "no request from a restarted recorder inside the cooldown");
  // …and resumes once it has passed.
  mock.timers.setTime(T0 + 60_000);
  await runOnce(dir, ex);
  assert.ok(ex.calls.length > before);
});

test("a rate limit on one candle series keeps the others, skips derivatives and honours the cooldown", async (t) => {
  const dir = tempDir(t);
  const ex = mockExchange({
    override: (url) => (url.searchParams.get("symbol") === "ETHUSDT" && url.pathname === "/api/v3/klines" ? new Response("{}", { status: 429, headers: { "retry-after": "30" } }) : undefined),
  });
  const { result } = await runOnce(dir, ex, { derivs: "on" });
  assert.equal(result.ok, true, "partial cycle: two series recorded");
  assert.deepEqual(ledgerRows(dir).map((r) => r.pair).sort(), ["BTCUSDT", "SOLUSDT"]);
  assert.ok(result.rateLimitedUntil >= T0 + 30_000);
  assert.equal(ex.calls.filter((c) => c.host === "api.bybit.com").length, 0, "no derivatives requests after a rate limit");
  assert.ok(rateLimitCooldown() >= 29_000);
  // ETH's cursor did not move: the next good cycle catches its bar up.
  const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  assert.equal(Object.keys(state.cursors).filter((k) => k.endsWith("ETHUSDT")).length, 0);
});

test("three failed cycles (across restarts) send one failure alert, a fourth sends none, recovery sends one", async (t) => {
  const dir = tempDir(t);
  let down = true;
  const sent = [];
  const env = { TELEGRAM_BOT_TOKEN: "123456789:AAFakeTokenForTestsOnly_abcdefghijk", TELEGRAM_CHAT_ID: "-100123" };
  const ex = mockExchange({
    override: (url) => (down && url.host === "data-api.binance.vision" ? new Response("upstream", { status: 503 }) : undefined),
    telegram: ({ body }) => {
      sent.push(body.text);
      return new Response('{"ok":true}', { status: 200 });
    },
  });
  for (let i = 0; i < 4; i++) {
    mock.timers.setTime(T0 + i * 60_000);
    await runOnce(dir, ex, {}, { env });
  }
  assert.equal(sent.length, 1);
  assert.match(sent[0], /3 consecutive failed cycles/);
  assert.match(sent[0], /binance 4h/);
  assert.match(sent[0], /analysis only — not financial advice/);
  down = false;
  await runOnce(dir, ex, {}, { env });
  assert.equal(sent.length, 2);
  assert.match(sent[1], /recording again/);
  const files = ["heartbeat.json", "alerts-state.json", "state.json", "recorder.log"].map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  assert.ok(!files.includes(env.TELEGRAM_BOT_TOKEN), "the bot token is never written to disk");
});

test("heartbeat records each cycle; a stale heartbeat triggers one dead-man alert on start-up", async (t) => {
  const dir = tempDir(t);
  const sent = [];
  const env = { ALERT_WEBHOOK_URL: "https://hooks.example.test/T000/secret-path-123456" };
  const ex = mockExchange({ webhook: ({ body }) => { sent.push(body); return new Response(null, { status: 204 }); } });
  await runOnce(dir, ex, {}, { env });
  const hb = readHeartbeatStatus(dir, T0 + 1000);
  assert.equal(hb.stale, false);
  assert.equal(hb.hb.rowsWritten, 3);
  assert.equal(hb.hb.status, "stopped");
  assert.equal(hb.hb.staleAfterMs, 3 * IV + 600_000);

  // Off for a day: stale; the next start sends exactly one dead-man alert.
  mock.timers.setTime(T0 + 24 * 3_600_000);
  assert.equal(readHeartbeatStatus(dir).stale, true);
  await runOnce(dir, ex, {}, { env });
  await runOnce(dir, ex, {}, { env }); // same outage, already reported
  const deadman = sent.filter((b) => b.kind === "deadman");
  assert.equal(deadman.length, 1);
  assert.match(deadman[0].text, /no successful cycle for 1440 min/);
  const disk = readFileSync(join(dir, "recorder.log"), "utf8") + readFileSync(join(dir, "alerts-state.json"), "utf8");
  assert.ok(!disk.includes("secret-path-123456"), "webhook URL never written to disk");
});

test("recorder profiles use separate ledger identity and cursors", async (t) => {
  const dir = tempDir(t);
  const ex = mockExchange();
  const first = await runOnce(dir, ex);
  const defaultRows = allLedger(dir);
  const profile = { version: 1, enabled: ["rsi", "stochastic"] };
  const custom = await runOnce(dir, ex, { profile });
  assert.notEqual(custom.rec.cfg, first.rec.cfg);
  const customRows = allLedger(dir).filter((row) => row.cfg === custom.rec.cfg);
  assert.equal(customRows.length, 3);
  assert.equal(custom.result.catchUpRows, 0);
  assert.ok(defaultRows.every((row) => allLedger(dir).some((saved) => saved.id === row.id)));
  const cur = currentOpen(T0);
  const kl = bars("BTCUSDT", cur, 1000).slice(0, -1);
  const expected = scoreSeries(kl, { intervalMs: IV, volumeAvailable: true, assetClass: "crypto", profile });
  assert.equal(customRows.find((row) => row.pair === "BTCUSDT").sc, expected.confluence.score);
  const repeated = await runOnce(dir, ex, { profile });
  assert.equal(repeated.result.written, 0);
});

test("v2.8 (WP19): a crypto pair under the default US$1,000,000 liquidity floor is left out of the recorded score", async (t) => {
  const dir = tempDir(t);
  const ex = mockExchange({ binanceTickers: [["BTCUSDT", 9e9], ["THINUSDT", 9e5], ["ETHUSDT", 5e9]] });
  const { result } = await runOnce(dir, ex);
  assert.equal(result.ok, true);
  assert.deepEqual(ledgerRows(dir).map((r) => r.pair).sort(), ["BTCUSDT", "ETHUSDT"]);
  assert.equal(ex.calls.filter((c) => c.path === "/api/v3/klines" && c.symbol === "THINUSDT").length, 0, "no candle request for a thin pair");
});

test("v2.8 (WP19): the recorder paces Binance requests on X-MBX-USED-WEIGHT-1M (Node fetch reads it)", async (t) => {
  const dir = tempDir(t);
  const tickers = (header) => mockExchange({
    override: (url) => (url.pathname === "/api/v3/ticker/24hr"
      ? new Response(JSON.stringify([["BTCUSDT", 9e9], ["ETHUSDT", 5e9], ["SOLUSDT", 2e9]].map(([symbol, qv]) => ({ symbol, openPrice: "100", lastPrice: "101", quoteVolume: String(qv) }))),
        { status: 200, headers: { "content-type": "application/json", ...(header ? { "x-mbx-used-weight-1m": header } : {}) } })
      : undefined),
  });
  let t0 = performance.now();
  await runOnce(dir, tickers(null));
  const fixed = performance.now() - t0;
  assert.ok(fixed < 1_200, `no header → fixed pacing only (${Math.round(fixed)} ms)`);
  resetRateLimitForTests();
  mock.timers.setTime(T0 + IV); // next bar: a fresh cycle with candle requests
  t0 = performance.now();
  const { result } = await runOnce(dir, tickers("4830")); // 30 of 1,200 over 80% of 6,000 → 1.5 s
  const paced = performance.now() - t0;
  assert.equal(result.ok, true);
  assert.ok(paced >= 1_400, `candle requests waited for the used-weight pause (${Math.round(paced)} ms)`);
});
