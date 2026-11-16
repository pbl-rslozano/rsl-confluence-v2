// Regional demand and buyer pressure — v2.8 Step 4a (WP25, Task 2).
// Run: npm run test:radar-reg   (node scripts/run-engine-tests.mjs radar-regional.test.mjs)
//
// Fixtures follow the documented layouts: Coinbase /products/{id}/ticker (price is a string), Upbit /v1/ticker rows
// (trade_price is a number), Coins.ph ticker/price ({symbol, price}), Binance spot ticker/price and klines rows.
import {
  usPremiumPct, koreaPremiumPct, takerShareSeries, sessionVolumes, standingPremiumMedian, fetchRegionalDemand,
  fetchBuyerPressure, setRegionalClockForTests,
} from "./radar/regional.ts";
import { fetchCoinbaseTicker, resetCoinbaseForTests } from "./coinbase.ts";
import { fetchUpbitTickerPrices, resetUpbitForTests } from "./upbit.ts";
import { resetCoinsphForTests, setCoinsphTimingForTests } from "./coinsph.ts";
import { RateLimitError, noteVenueRateLimit, resetRateLimitForTests, venueCooldown } from "./market-client.ts";
import { phPremiumPct } from "./coinsph.ts";

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} ${extra}`); }
};
const near = (a, b, tol = 1e-9) => typeof a === "number" && Math.abs(a - b) <= tol;
const realFetch = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 16, 12, 30, 0);

/** Stub fetch: routes by "host path"; a value is a body, a number (HTTP status) or a function. Logs every URL. */
function stub(routes) {
  const seen = [];
  globalThis.fetch = async (input) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    seen.push(u);
    const key = `${u.host}${u.pathname}`;
    const r = routes[key] ?? routes[`${u.host}${u.pathname}?${u.searchParams.get("symbol") ?? ""}`];
    if (r === undefined) return json({ code: -1, msg: "unrouted" }, 404);
    if (typeof r === "number") return json({ code: -1, msg: "stub" }, r);
    return json(typeof r === "function" ? r(u) : r);
  };
  return seen;
}
const fresh = () => {
  resetRateLimitForTests(); resetCoinbaseForTests(); resetUpbitForTests(); resetCoinsphForTests();
  setCoinsphTimingForTests({ spacingMs: 0 }); setRegionalClockForTests(() => NOW);
};
const happy = () => ({
  "data-api.binance.vision/api/v3/ticker/price": { symbol: "BTCUSDT", price: "65000.00" },
  "api.exchange.coinbase.com/products/BTC-USD/ticker": { trade_id: 1, price: "65650.00", size: "0.01", time: "2026-11-16T12:29:59Z", bid: "65649", ask: "65651", volume: "1" },
  "api.upbit.com/v1/ticker": [
    { market: "KRW-BTC", trade_price: 100_000_000, timestamp: NOW },
    { market: "KRW-USDT", trade_price: 1450, timestamp: NOW },
  ],
  "api.pro.coins.ph/openapi/quote/v1/ticker/price?BTCPHP": { symbol: "BTCPHP", price: "3800000" },
  "api.pro.coins.ph/openapi/quote/v1/ticker/price?USDTPHP": { symbol: "USDTPHP", price: "58" },
});
const hostsOf = (seen) => seen.map((u) => u.host);

try {
  // ---- pure formulas ----
  console.log("formulas");
  ok("korea premium formula", near(koreaPremiumPct(100_000_000, 1450, 65000), (100e6 / (1450 * 65000) - 1) * 100, 1e-9));
  ok("korea premium bad input is null", koreaPremiumPct(0, 1450, 65000) === null && koreaPremiumPct(1, NaN, 65000) === null && koreaPremiumPct(1, 1, -1) === null);
  ok("us premium", near(usPremiumPct(65650, 65000), 1.0, 1e-9));
  ok("us premium bad input is null", usPremiumPct(0, 65000) === null && usPremiumPct(65000, 0) === null && usPremiumPct(NaN, 1) === null);

  console.log("taker share");
  const bar = (i, o = {}) => ({ time: i * H, open: 1, high: 1, low: 1, close: 1, volume: 100, takerBuy: 60, qv: 100, ...o });
  const ts = takerShareSeries([bar(0), bar(1, { volume: 0 }), bar(2, { takerBuy: undefined }), bar(3, { takerBuy: NaN }), bar(4, { takerBuy: 150 })]);
  ok("taker share 60/100 is 0.6", near(ts[0], 0.6));
  ok("taker share zero volume is null", ts[1] === null);
  ok("taker share missing takerBuy is null", ts[2] === null && ts[3] === null);
  ok("taker share above 1 is null", ts[4] === null);
  ok("taker share keeps length", ts.length === 5);

  console.log("sessions");
  const week = Array.from({ length: 168 }, (_, i) => bar(i + 24 * 100, { qv: 10 })); // starts at a UTC midnight
  const s = sessionVolumes(week);
  ok("session buckets 11/6/7 of 24", near(s.asia, 11 / 24) && near(s.europe, 6 / 24) && near(s.us, 7 / 24), JSON.stringify(s));
  ok("session shares sum to 1", near(s.asia + s.europe + s.us, 1));
  const us = sessionVolumes([bar(14, { qv: 5 }), bar(20, { qv: 5 }), bar(21, { qv: 10 })]);
  ok("14:00-20:59 is US, 21:00 is Asia", near(us.us, 0.5) && near(us.asia, 0.5) && us.europe === 0, JSON.stringify(us));
  ok("session boundaries 07/08 and 13/14", (() => { const r = sessionVolumes([bar(7, { qv: 1 }), bar(8, { qv: 1 }), bar(13, { qv: 1 }), bar(14, { qv: 1 })]); return near(r.asia, 0.25) && near(r.europe, 0.5) && near(r.us, 0.25); })());
  const only7 = sessionVolumes([...Array.from({ length: 10 }, (_, i) => bar(i + 24 * 100 - 10, { qv: 1000 })), ...week]);
  ok("only the last 7 days count", near(only7.asia, 11 / 24) && near(only7.europe, 6 / 24));
  ok("quote volume falls back to close x volume", near(sessionVolumes([bar(1, { qv: undefined, close: 2, volume: 3 }), bar(9, { qv: undefined, close: 2, volume: 3 })]).asia, 0.5));
  const none = sessionVolumes([]);
  ok("no volume gives zeros, not NaN", none.asia === 0 && none.europe === 0 && none.us === 0);

  console.log("standing premium");
  ok("standing premium needs 20 days: 19 gives null", standingPremiumMedian(Array.from({ length: 19 }, (_, i) => i)) === null);
  ok("standing premium: 30 numbers give the median", standingPremiumMedian(Array.from({ length: 30 }, (_, i) => i + 1)) === 15.5);
  ok("standing premium uses only the last 30", standingPremiumMedian([...Array.from({ length: 10 }, () => 1000), ...Array.from({ length: 30 }, (_, i) => i + 1)]) === 15.5);
  ok("standing premium skips nulls but counts them in the window", standingPremiumMedian([...Array.from({ length: 10 }, () => null), ...Array.from({ length: 20 }, (_, i) => i + 1)]) === 10.5);
  ok("standing premium: nulls leave fewer than 20", standingPremiumMedian([...Array.from({ length: 11 }, () => null), ...Array.from({ length: 19 }, (_, i) => i + 1)]) === null);

  // ---- venue helpers ----
  console.log("venue helpers");
  fresh();
  let seen = stub(happy());
  ok("coinbase ticker price", (await fetchCoinbaseTicker("BTC-USD")) === 65650 && seen[0].pathname === "/products/BTC-USD/ticker");
  ok("coinbase ticker rejects a bad id", await fetchCoinbaseTicker("../x").then(() => false, () => true));
  stub({ "api.exchange.coinbase.com/products/BTC-USD/ticker": { price: "0" } });
  ok("coinbase ticker rejects a zero price", await fetchCoinbaseTicker("BTC-USD").then(() => false, () => true));
  fresh();
  seen = stub(happy());
  const m = await fetchUpbitTickerPrices(["KRW-BTC", "KRW-USDT"]);
  ok("upbit ticker prices", m.get("KRW-BTC") === 100_000_000 && m.get("KRW-USDT") === 1450 && m.size === 2);
  ok("upbit ticker uses /v1/ticker?markets=", seen[0].pathname === "/v1/ticker" && seen[0].searchParams.get("markets") === "KRW-BTC,KRW-USDT");
  ok("upbit ticker rejects a bad market", await fetchUpbitTickerPrices(["KRW-BTC&x=1"]).then(() => false, () => true));
  fresh();
  noteVenueRateLimit("upbit", new RateLimitError("x", 60_000));
  seen = stub(happy());
  ok("upbit helper makes no request while cooling", await fetchUpbitTickerPrices(["KRW-BTC"]).then(() => false, (e) => e instanceof RateLimitError) && seen.length === 0);
  fresh();
  noteVenueRateLimit("coinbase", new RateLimitError("x", 60_000));
  seen = stub(happy());
  ok("coinbase helper makes no request while cooling", await fetchCoinbaseTicker("BTC-USD").then(() => false, (e) => e instanceof RateLimitError) && seen.length === 0);

  // ---- fetchRegionalDemand ----
  console.log("regional demand");
  fresh();
  seen = stub(happy());
  let d = await fetchRegionalDemand();
  ok("regional all sources: premiums filled", near(d.usPct, 1.0, 1e-9) && near(d.krPct, (100e6 / (1450 * 65000) - 1) * 100, 1e-9) && near(d.phPct, phPremiumPct(3_800_000, 65000, 58), 1e-9), JSON.stringify(d));
  ok("regional all sources: nothing unavailable, asOf from the clock", d.unavailable.length === 0 && d.asOf === NOW);
  ok("regional makes one Binance spot request, price endpoint only", seen.filter((u) => u.host === "data-api.binance.vision").length === 1 && seen.find((u) => u.host === "data-api.binance.vision").searchParams.get("symbol") === "BTCUSDT");

  fresh();
  stub({ ...happy(), "api.upbit.com/v1/ticker": 503 });
  d = await fetchRegionalDemand();
  ok("regional with a failing source: krPct null, unavailable = [upbit]", d.krPct === null && d.unavailable.length === 1 && d.unavailable[0] === "upbit", JSON.stringify(d));
  ok("regional with a failing source: the others are filled", near(d.usPct, 1.0, 1e-9) && typeof d.phPct === "number");

  fresh();
  noteVenueRateLimit("upbit", new RateLimitError("x", 60_000));
  seen = stub(happy());
  d = await fetchRegionalDemand();
  ok("cooldown skips the request", !hostsOf(seen).includes("api.upbit.com") && d.krPct === null && d.unavailable.includes("upbit"));
  ok("cooldown on upbit leaves us and ph", typeof d.usPct === "number" && typeof d.phPct === "number");

  fresh();
  noteVenueRateLimit("coinbase", new RateLimitError("x", 60_000));
  seen = stub(happy());
  d = await fetchRegionalDemand();
  ok("coinbase cooldown: no request, usPct null", !hostsOf(seen).includes("api.exchange.coinbase.com") && d.usPct === null && d.unavailable.join() === "coinbase");

  fresh();
  noteVenueRateLimit("binance", new RateLimitError("x", 60_000));
  seen = stub(happy());
  d = await fetchRegionalDemand();
  ok("binance cooldown: no Binance request, every premium null, binance unavailable", !hostsOf(seen).includes("data-api.binance.vision") && d.usPct === null && d.krPct === null && d.phPct === null && d.unavailable.includes("binance"));

  fresh();
  stub({ ...happy(), "data-api.binance.vision/api/v3/ticker/price": 500 });
  d = await fetchRegionalDemand();
  ok("binance failure: premiums null, never throws", d.usPct === null && d.krPct === null && d.phPct === null && d.unavailable.includes("binance"));

  fresh();
  stub({ ...happy(), "api.pro.coins.ph/openapi/quote/v1/ticker/price?USDTPHP": 500, "api.pro.coins.ph/openapi/quote/v1/ticker/price?USDCPHP": { symbol: "USDCPHP", price: "58.5" } });
  d = await fetchRegionalDemand();
  ok("coins.ph falls back to USDCPHP", near(d.phPct, phPremiumPct(3_800_000, 65000, 58.5), 1e-9) && d.unavailable.length === 0, JSON.stringify(d));

  fresh();
  stub({ ...happy(), "api.pro.coins.ph/openapi/quote/v1/ticker/price?BTCPHP": 500 });
  d = await fetchRegionalDemand();
  ok("coins.ph failure: phPct null, unavailable = [coinsph]", d.phPct === null && d.unavailable.join() === "coinsph" && typeof d.krPct === "number");

  fresh();
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  d = await fetchRegionalDemand();
  ok("every network failure is swallowed", d.usPct === null && d.krPct === null && d.phPct === null && d.unavailable.includes("binance"));

  fresh();
  const ac = new AbortController();
  ac.abort();
  stub(happy());
  ok("an aborted signal rejects", await fetchRegionalDemand(ac.signal).then(() => false, (e) => e?.name === "AbortError"));

  // ---- fetchBuyerPressure ----
  console.log("buyer pressure");
  const rowsOf = (n, end, over = {}) => Array.from({ length: n }, (_, i) => {
    const t = end - (n - i) * H;
    return [t, "1", "2", "0.5", "1.5", "100", t + H - 1, "150", 10, over.takerBuy ?? "60", "90", "0"];
  });
  fresh();
  const topOfHour = Math.floor(NOW / H) * H;
  seen = stub({ "data-api.binance.vision/api/v3/klines": () => [...rowsOf(168, topOfHour), [topOfHour, "1", "2", "0.5", "1.5", "5", topOfHour + H - 1, "7", 1, "2", "1", "0"]] });
  const bp = await fetchBuyerPressure();
  ok("buyer pressure is one request", seen.length === 1 && seen[0].searchParams.get("symbol") === "BTCUSDT" && seen[0].searchParams.get("interval") === "1h");
  ok("buyer pressure drops the forming bar: 168 closed bars", bp.takerShare.length === 168 && near(bp.takerShare[167], 0.6));
  ok("buyer pressure sessions sum to 1, asOf from the clock", near(bp.sessions.asia + bp.sessions.europe + bp.sessions.us, 1) && bp.asOf === NOW);
  fresh();
  noteVenueRateLimit("binance", new RateLimitError("x", 60_000));
  seen = stub({});
  ok("buyer pressure makes no request while cooling", await fetchBuyerPressure().then(() => false, (e) => e instanceof RateLimitError) && seen.length === 0);
  fresh();
  stub({ "data-api.binance.vision/api/v3/klines": [] });
  ok("buyer pressure with no bars throws", await fetchBuyerPressure().then(() => false, () => true));
  ok("venue cooldown reading still works", venueCooldown("binance") === 0);
} finally {
  globalThis.fetch = realFetch;
  setCoinsphTimingForTests();
  setRegionalClockForTests(null);
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
