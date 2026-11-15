// Funding / open-interest recorder (Bybit V5 linear) through a full bybit-perp cycle — offline.
import test, { beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resetRateLimitForTests } from "../src/engine.mjs";
import { createRecorder } from "../src/recorder-core.mjs";
import { baseConfig, H, mockExchange, quiet, T0, tempDir } from "./fixtures.mjs";

const NEXT_FUNDING = Date.UTC(2026, 9, 31, 16);
const linear = (symbol, turnover, extra = {}) => ({
  symbol, lastPrice: "100", markPrice: "100.02", indexPrice: "100", price24hPcnt: "0.01", turnover24h: String(turnover), volume24h: "1",
  fundingRate: "0.0001", nextFundingTime: String(NEXT_FUNDING), openInterest: "999", ...extra,
});
const LINEAR = [
  linear("BTCUSDT", 9e9),
  linear("ETHUSDT", 5e9, { fundingRate: "-0.00025" }),
  linear("SOLUSDT", 2e9, { fundingRate: "not-a-number" }), // bad record: dropped, cycle continues
  linear("XAUUSDT", 1e9),
];
const INSTRUMENTS = [
  { symbol: "BTCUSDT", status: "Trading", symbolType: "", fundingInterval: 480 },
  { symbol: "ETHUSDT", status: "Trading", symbolType: "", fundingInterval: 240 },
  { symbol: "SOLUSDT", status: "Trading", symbolType: "", fundingInterval: 480 },
  { symbol: "XAUUSDT", status: "Trading", symbolType: "commodity", fundingInterval: 480 },
];
const readJsonl = (p) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

beforeEach(() => {
  resetRateLimitForTests();
  mock.timers.enable({ apis: ["Date"], now: T0 });
});
afterEach(() => mock.timers.reset());

async function cycle(dir, ex, extra = {}) {
  const rec = createRecorder(baseConfig(dir, { source: "bybit-perp", ...extra }), { ...quiet, baseFetch: ex.fetch, env: {} });
  return rec.run(undefined, { once: true });
}

test("records funding rate, next funding time, funding interval and top-N open interest", async (t) => {
  const dir = tempDir(t);
  const ex = mockExchange({
    bybitLinear: LINEAR,
    bybitInstruments: INSTRUMENTS,
    openInterest: (sym) => (sym === "ETHUSDT"
      ? { retCode: 0, result: { list: [{ openInterest: "12x", timestamp: "soon" }] } } // bad shape: oi stays null
      : { retCode: 0, result: { list: [{ openInterest: "54321.5", timestamp: String(T0 - H) }] } }),
  });
  const r = await cycle(dir, ex, { oiTop: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.written, 3, "ledger rows for BTC, ETH, SOL (crypto view; XAU is a commodity)");

  const recs = readJsonl(join(dir, "derivs", "2026-10.jsonl"));
  assert.deepEqual(recs.map((x) => x.pair), ["BTCUSDT", "ETHUSDT"], "SOL dropped (invalid funding), XAU not in the universe");
  const [btc, eth] = recs;
  assert.deepEqual(btc, { t: T0, venue: "bybit", cat: "linear", pair: "BTCUSDT", fr: 0.0001, nft: NEXT_FUNDING, fi: 480, mp: 100.02, oi: 54321.5, oit: T0 - H });
  assert.equal(eth.fr, -0.00025);
  assert.equal(eth.fi, 240);
  assert.equal(eth.oi, null, "invalid open-interest payload is not recorded");

  // One linear ticker request serves the engine's universe AND the funding step (memo).
  assert.equal(ex.calls.filter((c) => c.path === "/v5/market/tickers").length, 1);
  assert.equal(ex.calls.filter((c) => c.path === "/v5/market/open-interest").length, 2, "only --oi-top symbols");
  const hb = JSON.parse(readFileSync(join(dir, "heartbeat.json"), "utf8"));
  assert.ok(hb.errors.some((e) => /SOLUSDT: invalid fundingRate/.test(e.msg)));
  assert.ok(hb.errors.some((e) => /open interest ETHUSDT: invalid payload/.test(e.msg)));
});

test("bad derivatives responses never fail the cycle; an OI rate limit pauses further requests", async (t) => {
  const dir = tempDir(t);
  const ex = mockExchange({
    bybitLinear: LINEAR,
    bybitInstruments: INSTRUMENTS,
    override: (url) => {
      if (url.pathname === "/v5/market/open-interest") return new Response(JSON.stringify({ retCode: 10006, retMsg: "Too many visits" }), { status: 200 });
      return undefined;
    },
  });
  const r = await cycle(dir, ex, { oiTop: 3 });
  assert.equal(r.ok, true, "ledger recorded despite the OI rate limit");
  assert.equal(r.written, 3);
  assert.equal(ex.calls.filter((c) => c.path === "/v5/market/open-interest").length, 1, "stopped at the first rate-limit response");
  assert.ok(r.rateLimitedUntil >= T0 + 60_000);
  assert.equal(readJsonl(join(dir, "derivs", "2026-10.jsonl")).length, 2, "funding still logged; oi null");
});

test("instruments-info failure leaves fi = null; a malformed ticker list fails the cycle cleanly", async (t) => {
  const dir = tempDir(t);
  let brokenTickers = false;
  const ex = mockExchange({
    bybitLinear: LINEAR,
    bybitInstruments: INSTRUMENTS,
    override: (url) => {
      // The engine falls back to symbol patterns without instrument types; the
      // recorder's funding-interval lookup must degrade to fi = null.
      if (url.pathname === "/v5/market/instruments-info") return new Response("<html>bad gateway</html>", { status: 502 });
      if (brokenTickers && url.pathname === "/v5/market/tickers") return new Response(JSON.stringify({ retCode: 0, result: {} }), { status: 200 });
      return undefined;
    },
  });
  const r1 = await cycle(dir, ex, { oiTop: 0 });
  assert.equal(r1.ok, true);
  const recs = readJsonl(join(dir, "derivs", "2026-10.jsonl"));
  assert.ok(recs.length === 2 && recs.every((x) => x.fi === null && x.oi === null));

  // Next bar, ticker list malformed: the engine fails the cycle cleanly (no crash, heartbeat written).
  brokenTickers = true;
  mock.timers.setTime(T0 + 4 * H);
  const r2 = await cycle(dir, ex, { oiTop: 0 });
  assert.equal(r2.ok, false);
  assert.ok(existsSync(join(dir, "heartbeat.json")));
});

test("v2.8 (WP19): rows log fr / oiChg from an earlier snapshot ≤ 2 h before their bar close — never a later one", async (t) => {
  const dir = tempDir(t);
  let oi = { value: "50000", ts: T0 + H / 2 };
  const ex = mockExchange({
    bybitLinear: LINEAR,
    bybitInstruments: INSTRUMENTS,
    openInterest: () => ({ retCode: 0, result: { list: [{ openInterest: oi.value, timestamp: String(oi.ts) }] } }),
  });
  const ledger = () => ["2026-10", "2026-11"].flatMap((m) => readJsonl(join(dir, "ledger", `${m}.jsonl`)));
  // 13:00 — first rows (bar closed 12:00): the only snapshot is taken after that close → null.
  mock.timers.setTime(T0 + H);
  assert.equal((await cycle(dir, ex, { oiTop: 2 })).ok, true);
  const first = ledger();
  assert.ok(first.length === 3 && first.every((r) => r.fr === null && r.oiChg === null), "a snapshot after the bar close is look-ahead");
  // 15:00 — mid-bar: another snapshot (new OI reading); no new bar to record.
  oi = { value: "55000", ts: T0 + 2.5 * H };
  mock.timers.setTime(T0 + 3 * H);
  await cycle(dir, ex, { oiTop: 2 });
  // 16:00 — the 16:00 bar is recorded by a NEW recorder process: snapshots are reloaded from the derivs log.
  mock.timers.setTime(T0 + 4 * H);
  await cycle(dir, ex, { oiTop: 2 });
  const fresh = ledger().filter((r) => r.tc === T0 - 30_000 + 4 * H);
  const btc = fresh.find((r) => r.pair === "BTCUSDT");
  const eth = fresh.find((r) => r.pair === "ETHUSDT");
  const sol = fresh.find((r) => r.pair === "SOLUSDT");
  assert.ok(btc && eth && sol, JSON.stringify(fresh.map((r) => [r.pair, r.tc])));
  assert.equal(btc.fr, 0.0001);
  assert.ok(Math.abs(btc.oiChg - 10) < 1e-9, String(btc.oiChg));
  assert.equal(eth.fr, -0.00025);
  assert.equal(sol.fr, null, "no valid funding print for SOL");
  assert.equal(sol.oiChg, null);
});
