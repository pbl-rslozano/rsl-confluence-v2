// Upbit spot scan source — v2.8 Step 2 (WP26, Task 5).
// Run: npm run test:upbit   (node scripts/run-engine-tests.mjs upbit.test.mjs)
//
// Fixtures: docs/research/evidence/wp26-venues-probe-2026-11-15.json (results.upbit.samples). Rows the probe did not
// capture (generated candle pages, the market list, tickers — the ticker shape is from Upbit's docs — a book) follow
// the layout the probe and the docs record and are marked.
import {
  UPBIT_CONCURRENCY, UPBIT_MAX_COUNT, UPBIT_MAX_REQUESTS_PER_SERIES, UPBIT_PAUSE_MS, UPBIT_REQUESTS_PER_S, UpbitFeedError,
  closedUpbitBars, fetchUpbitKlines, fetchUpbitTickers, parseUpbitCandles, resetUpbitForTests, setUpbitClockForTests, upbitCandlePath,
  upbitVolumeUsd,
} from "./upbit.ts";
import {
  DATA_SOURCES, INTERVAL_MS, RateLimitError, barCloseTime, contiguousTail, deltaSupported, fetchDirectMarketData, fetchHistory,
  fetchOrderBook, fetchSeries, rateLimitCooldown, resetRateLimitForTests,
} from "./market-client.ts";
import { DEFAULT_COSTS, costsFor } from "./ledger-metrics.ts";
import { forgetPairsForTests, normalizeQuoteMode, priceCurrencyOfQuote, quoteModesFor } from "./quotes.ts";
import { classifySymbol } from "./asset-classes.ts";
import { healthFromError, healthFromScan, slowAfterMs } from "./source-health.ts";
import { convert, priceDisplay } from "./fx-rates.ts";

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} ${extra}`); }
};
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const realFetch = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const M1 = INTERVAL_MS["1m"];
const H1 = INTERVAL_MS["1h"];
const H4 = INTERVAL_MS["4h"];
const D1 = INTERVAL_MS["1d"];
const W1 = INTERVAL_MS["1w"];

// ---- probe sample (verbatim): candles_240_KRW-BTC, newest first; row 0 is the bar still forming ----
const CANDLES_240_KRW_BTC = [
  { market: "KRW-BTC", candle_date_time_utc: "2026-11-15T08:00:00", opening_price: 88245000, high_price: 91119000, low_price: 88033000, trade_price: 90101000, timestamp: 1794743402636, candle_acc_trade_price: 29909626267.25633, candle_acc_trade_volume: 332.31393571, unit: 240 },
  { market: "KRW-BTC", candle_date_time_utc: "2026-11-15T04:00:00", opening_price: 89441000, high_price: 89825000, low_price: 88000000, trade_price: 88236000, timestamp: 1794729599353, candle_acc_trade_price: 30002222487.18378, candle_acc_trade_volume: 336.95088041, unit: 240 },
];

/* ---- generated candle pages (probe row layout) ---- */
const WEEK_ANCHOR = 4 * D1; // Monday 5 Jan 1970
const baseOfPath = (p) => p.endsWith("/days") ? "1d" : p.endsWith("/weeks") ? "1w" : p.endsWith("/months") ? "1M"
  : ({ 1: "1m", 5: "5m", 15: "15m", 60: "1h", 240: "4h" })[Number(p.split("/").pop())];
const bucket = (tf, t) => {
  if (tf === "1M") { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }
  const ms = INTERVAL_MS[tf];
  const off = tf === "1w" ? WEEK_ANCHOR : 0;
  return Math.floor((t - off) / ms) * ms + off;
};
const prevOpen = (tf, t) => { if (tf === "1M") { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1); } return t - INTERVAL_MS[tf]; };
const utcText = (t) => new Date(t).toISOString().slice(0, 19);
const px = (t, tf) => 100 + (Math.floor(t / INTERVAL_MS[tf]) % 50);
const row = (market, tf, t) => ({
  market, candle_date_time_utc: utcText(t), opening_price: px(t, tf), high_price: px(t, tf) + 2, low_price: px(t, tf) - 1,
  trade_price: px(t, tf) + 1, timestamp: t + 1, candle_acc_trade_price: 1000, candle_acc_trade_volume: 10, unit: 1,
});
/**
 * A candle endpoint like Upbit's: `count` rows opening strictly before `to`, newest first. Options: `gap` (an open time
 * with no candle: no trades), `listedAt` (nothing before it), `servesForming` (the venue also returns the bar still
 * forming on top — the open bar a live venue serves when `to` is left out), `overlap` (`to` treated as inclusive).
 */
function candleServer({ gap = null, listedAt = -Infinity, servesForming = false, overlap = false } = {}) {
  return (u) => {
    const tf = baseOfPath(u.pathname);
    const count = Number(u.searchParams.get("count"));
    const to = Date.parse(u.searchParams.get("to"));
    const market = u.searchParams.get("market");
    const forming = bucket(tf, Date.now());
    let t = servesForming && to >= forming ? forming : bucket(tf, overlap ? to : to - 1);
    const rows = [];
    for (; rows.length < count && t >= listedAt; t = prevOpen(tf, t)) {
      if (t === gap) continue;
      rows.push(row(market, tf, t));
    }
    return json(rows);
  };
}

/* ---- tickers (shape from Upbit's docs [not verified by probe]; values made up except where noted) ---- */
const MARKETS = ["KRW-BTC", "KRW-ETH", "KRW-USDT", "KRW-XRP", "USDT-BTC", "USDT-ETH", "BTC-ETH", "BTC-SOL", "KRW-A.B", "KRW-PAXG"]
  .map((market) => ({ market, korean_name: "-", english_name: "-" }));
const tk = (market, trade_price, acc_trade_price_24h, signed_change_rate = 0.01) =>
  ({ market, trade_price, opening_price: trade_price / (1 + signed_change_rate), acc_trade_price_24h, signed_change_rate, timestamp: 1794743402636 });
const TICKERS = [
  tk("KRW-BTC", 90101000, 1.0e12, 0.0123),
  tk("KRW-ETH", 4500000, 2.0e11),
  tk("KRW-USDT", 1450, 5.0e11, 0.0001),
  tk("KRW-XRP", 3000, 1.0e9),
  tk("USDT-BTC", 65000, 2_000_000),
  tk("USDT-ETH", 3300, 500_000),
  tk("BTC-ETH", 0.05, 100),
  tk("BTC-SOL", 0.0023, 1),
  tk("KRW-A.B", 1, 1.0e12),
  tk("KRW-PAXG", 3_800_000, 1.0e8),
];

let calls = [];
let route = () => json({ error: { name: "404", message: "unexpected" } }, 404);
globalThis.fetch = async (url) => {
  const s = String(url);
  const u = new URL(s, "https://page.example");
  calls.push({ s, u });
  return route(u, s);
};
const candleCalls = () => calls.filter((c) => c.u.pathname.includes("/v1/candles/"));
const universeRoute = (tickers = TICKERS) => (u) => {
  const p = u.pathname.replace(/^\/x\/upbit/, "");
  if (p === "/v1/market/all") return json(MARKETS);
  if (p === "/v1/ticker/all") return json(tickers);
  if (p.startsWith("/v1/candles/")) return candleServer()(u);
  return json({ error: { name: "404", message: "Code not found" } }, 404);
};
/** Pacing clock that never waits (sleeps advance virtual time) — keeps the gate in force without slowing the suite. */
const skipClock = () => { let off = 0; return { now: () => Date.now() + off, sleep: async (ms) => { off += Math.max(0, ms); } }; };
const fresh = () => { resetRateLimitForTests(); setUpbitClockForTests(skipClock()); resetUpbitForTests(); forgetPairsForTests(); calls = []; };

/* ---- constants and source registry ---- */
console.log("constants and source entry");
ok("UPBIT_MAX_COUNT = 200, 16 requests per series", UPBIT_MAX_COUNT === 200 && UPBIT_MAX_REQUESTS_PER_SERIES === 16);
ok("UPBIT_PAUSE_MS = 150, UPBIT_CONCURRENCY = 2", UPBIT_PAUSE_MS === 150 && UPBIT_CONCURRENCY === 2);
ok("gates at 80 % of the documented 10 calls/s per IP: 8/s", UPBIT_REQUESTS_PER_S === 8);
const ub = DATA_SOURCES.find((s) => s.value === "upbit");
ok("DATA_SOURCES upbit entry (label, note, maxAssets, keyless)",
  ub?.label === "Upbit (KR)" && ub.note === "Public Korean won (KRW), USDT and BTC spot markets and OHLCV candles." && ub.maxAssets === 100 && !("privateApi" in ub), JSON.stringify(ub));
ok("DEFAULT_COSTS upbit exists, spot (no funding)", DEFAULT_COSTS.upbit?.feeBps > 0 && DEFAULT_COSTS.upbit.fundingBpsPer8h === 0, JSON.stringify(DEFAULT_COSTS.upbit));
// Final wave: per-quote Upbit fees (secondary source): KRW markets 5 bps taker; BTC and USDT markets 25 bps.
ok("Upbit per-quote costs: KRW 5 bps, BTC and USDT 25 bps, no quote → 25 bps; slippage and class extras unchanged",
  costsFor("upbit", "crypto", undefined, "KRW").feeBps === 5 && costsFor("upbit", "crypto", undefined, "BTC").feeBps === 25 &&
  costsFor("upbit", "crypto", undefined, "USDT").feeBps === 25 && costsFor("upbit", "crypto").feeBps === 25 &&
  costsFor("upbit", "crypto", 3, "KRW").slipBps === 3 && costsFor("upbit", "crypto", undefined, "KRW").slipBps === DEFAULT_COSTS.upbit.slipBps &&
  costsFor("upbit", "crypto", undefined, "KRW").fundingBpsPer8h === 0,
  JSON.stringify(["KRW", "BTC", "USDT", undefined].map((q) => costsFor("upbit", "crypto", undefined, q))));
ok("per-quote costs leave every other source unchanged (a KRW/USD quote elsewhere is the source default)",
  Object.keys(DEFAULT_COSTS).filter((s) => s !== "upbit").every((s) => ["KRW", "USD", "USDT", "BTC"].every((q) => costsFor(s, "crypto", undefined, q).feeBps === DEFAULT_COSTS[s].feeBps)));
ok("source health gives a paged Upbit scan 90 s before it is \"slow\"", slowAfterMs("upbit") === 90_000);
ok("quotes: KRW by default, USDT/BTC on request; KRW, USD, BTC prices",
  normalizeQuoteMode("upbit", undefined) === "KRW" && normalizeQuoteMode("upbit", "BTC") === "BTC" && normalizeQuoteMode("upbit", "USDC") === "KRW" &&
  priceCurrencyOfQuote("upbit", "KRW") === "KRW" && priceCurrencyOfQuote("upbit", "USDT") === "USD" && priceCurrencyOfQuote("upbit", "BTC") === "BTC");

/* ---- candle path map ---- */
console.log("candle paths");
for (const [tf, path] of Object.entries({ "1m": "/v1/candles/minutes/1", "5m": "/v1/candles/minutes/5", "15m": "/v1/candles/minutes/15", "1h": "/v1/candles/minutes/60", "4h": "/v1/candles/minutes/240", "1d": "/v1/candles/days", "1w": "/v1/candles/weeks", "1M": "/v1/candles/months" })) {
  const m = upbitCandlePath(tf);
  ok(`upbitCandlePath(${tf}) = ${path}, native`, m?.path === path && m.aggregate === undefined && m.baseMs === INTERVAL_MS[tf] && deltaSupported("upbit", tf), JSON.stringify(m));
}
for (const [tf, path, n, base] of [["6h", "/v1/candles/minutes/60", 6, H1], ["8h", "/v1/candles/minutes/240", 2, H4], ["12h", "/v1/candles/minutes/240", 3, H4], ["2d", "/v1/candles/days", 2, D1], ["4d", "/v1/candles/days", 4, D1]]) {
  const m = upbitCandlePath(tf);
  ok(`upbitCandlePath(${tf}) = ${n} x ${path}, aggregated (no delta)`, m?.path === path && m.aggregate === n && m.baseMs === base && !deltaSupported("upbit", tf), JSON.stringify(m));
}
ok("upbitCandlePath(unknown) = null", upbitCandlePath("3h") === null && upbitCandlePath("") === null);

/* ---- parsing ---- */
console.log("parsing");
{
  const k = parseUpbitCandles(CANDLES_240_KRW_BTC, "4h");
  const b = k.find((x) => x.time === Date.parse("2026-11-15T04:00:00Z"));
  ok("maps Upbit candle rows: ascending, open time = Date.parse(candle_date_time_utc + \"Z\")", k.length === 2 && k[0] === b && k[1].time === Date.parse("2026-11-15T08:00:00Z"));
  ok("maps Upbit candle rows: candles_240_KRW-BTC row 1 = o 89441000, h 89825000, l 88000000, c 88236000, v 336.95088041",
    b && b.open === 89441000 && b.high === 89825000 && b.low === 88000000 && b.close === 88236000 && b.volume === 336.95088041, JSON.stringify(b));
  const closed = closedUpbitBars(CANDLES_240_KRW_BTC, "4h", 1794743402636);
  ok("drops the open bar: row 0 (08:00, still forming at now = 1794743402636) is dropped, row 1 kept",
    closed.length === 1 && closed[0].time === Date.parse("2026-11-15T04:00:00Z"), JSON.stringify(closed.map((x) => x.time)));
  ok("the probe's now is inside the 08:00 bar (it closes at 12:00 UTC)", barCloseTime(Date.parse("2026-11-15T08:00:00Z"), H4) > 1794743402636 && Date.parse("2026-11-15T08:00:00Z") <= 1794743402636);
  const junk = parseUpbitCandles([{ ...CANDLES_240_KRW_BTC[1], high_price: "x" }, "nope", null, CANDLES_240_KRW_BTC[1], { ...CANDLES_240_KRW_BTC[1], candle_date_time_utc: "2026-11-15T05:00:00" }], "4h");
  ok("rows with a non-numeric field, non-objects and rows off the 4h edge are skipped", junk.length === 1 && junk[0].close === 88236000);
  let threw = false;
  try { parseUpbitCandles({ error: { name: "invalid_parameter", message: "x" } }); } catch { threw = true; }
  ok("an error envelope (not a row array) throws (not an empty series)", threw);
  // Weeks and months line up with barCloseTime: Monday 00:00 UTC weeks, 1st-of-month 00:00 UTC months
  // (Upbit's examples "2018-04-16T00:00:00" and "2018-04-01T00:00:00", quoted from its docs by the upbit crate).
  const wk = parseUpbitCandles([{ ...CANDLES_240_KRW_BTC[1], candle_date_time_utc: "2018-04-16T00:00:00" }], "1w");
  ok("weeks: 2018-04-16 is a Monday; the bar closes 7 days later (barCloseTime)", wk.length === 1 && new Date(wk[0].time).getUTCDay() === 1 &&
    barCloseTime(wk[0].time, W1) === Date.parse("2018-04-23T00:00:00Z"));
  const mo = parseUpbitCandles([{ ...CANDLES_240_KRW_BTC[1], candle_date_time_utc: "2018-04-01T00:00:00" }], "1M");
  ok("months: open on the 1st 00:00 UTC; the bar closes at the next calendar month (barCloseTime)", mo.length === 1 &&
    barCloseTime(mo[0].time, INTERVAL_MS["1M"]) === Date.parse("2018-05-01T00:00:00Z"));
  ok("a week not starting Monday 00:00 UTC, or a month not on the 1st, is skipped (no misaligned bars)",
    parseUpbitCandles([{ ...CANDLES_240_KRW_BTC[1], candle_date_time_utc: "2018-04-15T00:00:00" }], "1w").length === 0 &&
    parseUpbitCandles([{ ...CANDLES_240_KRW_BTC[1], candle_date_time_utc: "2018-04-02T00:00:00" }], "1M").length === 0);
}

/* ---- klines ---- */
console.log("klines");
const formingOf = (tf) => bucket(tf, Date.now());
{
  fresh();
  route = candleServer();
  const k = await fetchUpbitKlines("BTCKRW", "1h", undefined, 200);
  const F = formingOf("1h");
  const c = candleCalls()[0];
  ok("candles request: /v1/candles/minutes/60?market=KRW-BTC&count=200&to=<ISO>", c?.u.origin === "https://api.upbit.com" && c.u.pathname === "/v1/candles/minutes/60" &&
    c.u.searchParams.get("market") === "KRW-BTC" && c.u.searchParams.get("count") === "200" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(c.u.searchParams.get("to")), c?.s);
  ok("the first page asks for bars before the one now forming (to = its open)", Date.parse(c.u.searchParams.get("to")) === F, c?.u.searchParams.get("to"));
  ok("200 closed bars in one request, newest = the last closed hour", k.length === 200 && calls.length === 1 && k.at(-1).time === F - H1, `${k.length} ${calls.length}`);
}
{
  fresh();
  route = candleServer({ servesForming: true });
  const k = await fetchUpbitKlines("BTCKRW", "4h", undefined, 200);
  const F = formingOf("4h");
  ok("drops the open bar: the forming 4h bar served by the venue is not returned", !k.some((b) => b.time >= F) && k.at(-1).time === F - H4, `${k.length} ${k.at(-1)?.time} ${F}`);
  ok("drops the open bar: still 200 closed bars (the forming row is not counted)", k.length === 200 && contiguousTail(k, H4).length === 200, String(k.length));
}
{
  fresh();
  route = candleServer();
  const k = await fetchUpbitKlines("BTCKRW", "1h", undefined, 1000);
  const cs = candleCalls();
  ok("pages merge without duplicates: 5 requests of 200 give 1,000 bars", cs.length === 5 && cs.every((c) => c.u.searchParams.get("count") === "200") && k.length === 1000, `${cs.length} ${k.length}`);
  const unique = new Set(k.map((b) => b.time)).size === k.length;
  const asc = k.every((b, i) => i === 0 || b.time - k[i - 1].time === H1);
  ok("pages merge without duplicates: unique, ascending, contiguous", unique && asc);
  // Each page's `to` is the previous page's oldest open (exclusive), as ISO 8601.
  let prevOldest = null;
  let chain = true;
  for (const c of cs) {
    const to = Date.parse(c.u.searchParams.get("to"));
    if (prevOldest !== null && to !== prevOldest) chain = false;
    prevOldest = to - 200 * H1;
  }
  ok("pages merge without duplicates: each to = the previous oldest open (ISO)", chain, cs.map((c) => c.u.searchParams.get("to")).join(" "));
  // A venue that served `to` inclusively would repeat one bar per page: still 1,000 unique bars, no duplicates.
  calls = [];
  route = candleServer({ overlap: true });
  const o = await fetchUpbitKlines("BTCKRW", "1h", undefined, 1000);
  ok("overlapping pages (inclusive to) are de-duplicated", o.length === 1000 && new Set(o.map((b) => b.time)).size === 1000 &&
    o.every((b, i) => i === 0 || b.time - o[i - 1].time === H1), `${o.length} / ${candleCalls().length}`);
}
{
  // Review Focus 2: Upbit publishes no candle for an interval with no trades.
  fresh();
  const F = formingOf("1h");
  route = candleServer({ gap: F - 301 * H1 });
  const k = await fetchUpbitKlines("THINKRW", "1h", undefined, 1000);
  ok("gap keeps newest contiguous run: 300 bars after the missing hour, never padded (scored cold)", k.length === 300 && k[0].time === F - 300 * H1 && contiguousTail(k, H1).length === 300, `${k.length}`);
  ok("gap: paging stops once the run is broken (2 requests, not 5)", candleCalls().length === 2, String(candleCalls().length));
  calls = [];
  route = candleServer({ listedAt: F - 450 * H1 });
  const n = await fetchUpbitKlines("NEWKRW", "1h", undefined, 1000);
  ok("a recently listed pair: a short page ends paging, the short series is returned as-is", n.length === 450 && candleCalls().length === 3, `${n.length} / ${candleCalls().length}`);
}
{
  fresh();
  route = candleServer();
  const H8 = INTERVAL_MS["8h"];
  const k = await fetchUpbitKlines("BTCKRW", "8h", undefined, 1000);
  const cs = candleCalls();
  ok("8h = 2 x 240m: 10 requests, all minutes/240", cs.length === 10 && cs.every((c) => c.u.pathname === "/v1/candles/minutes/240"), String(cs.length));
  ok("8h: 1,000 epoch-aligned bars, newest = the last closed 8h bar", k.length === 1000 && k.every((b, i) => b.time % H8 === 0 && (i === 0 || b.time - k[i - 1].time === H8)) && k.at(-1).time === formingOf("8h") - H8, String(k.length));
  ok("8h: the first page ends at the 8h bucket now forming (base bars aligned to bucket edges)", Date.parse(cs[0].u.searchParams.get("to")) === formingOf("8h"));
  const b = k.at(-1);
  ok("8h bar = open of the first 4h, max high, min low, close of the second, summed volume",
    b.open === px(b.time, "4h") && b.close === px(b.time + H4, "4h") + 1 && b.high === Math.max(px(b.time, "4h"), px(b.time + H4, "4h")) + 2 &&
    b.low === Math.min(px(b.time, "4h"), px(b.time + H4, "4h")) - 1 && b.volume === 20, JSON.stringify(b));
  calls = [];
  const s6 = await fetchUpbitKlines("BTCKRW", "6h", undefined, 1000);
  ok("6h = 6 x 60m stops at the request cap: 16 requests, 533 bars (scored cold)", candleCalls().length === 16 && s6.length === 533 &&
    s6.every((x) => x.time % INTERVAL_MS["6h"] === 0) && s6.at(-1).time === formingOf("6h") - INTERVAL_MS["6h"], `${candleCalls().length} ${s6.length}`);
  calls = [];
  const s12 = await fetchUpbitKlines("BTCKRW", "12h", undefined, 1000);
  ok("12h = 3 x 240m: 15 requests, 1,000 bars", candleCalls().length === 15 && s12.length === 1000 && s12.every((x) => x.time % INTERVAL_MS["12h"] === 0), `${candleCalls().length} ${s12.length}`);
  calls = [];
  const s2d = await fetchUpbitKlines("BTCKRW", "2d", undefined, 200);
  ok("2d from days: epoch-aligned like the other venues' synthetic 2d", candleCalls().every((c) => c.u.pathname === "/v1/candles/days") && s2d.length === 200 && s2d.every((x) => x.time % INTERVAL_MS["2d"] === 0), String(s2d.length));
}
{
  fresh();
  route = candleServer();
  const k = await fetchUpbitKlines("BTCKRW", "1w", undefined, 100);
  const c = candleCalls()[0];
  ok("1w: /v1/candles/weeks, first to = Monday 00:00 UTC of the week now forming", c.u.pathname === "/v1/candles/weeks" && new Date(Date.parse(c.u.searchParams.get("to"))).getUTCDay() === 1 &&
    Date.parse(c.u.searchParams.get("to")) % D1 === 0 && Date.parse(c.u.searchParams.get("to")) === formingOf("1w"), c.u.searchParams.get("to"));
  ok("1w: 100 Monday weeks, contiguous, newest = the last closed week", k.length === 100 && k.every((b, i) => new Date(b.time).getUTCDay() === 1 && (i === 0 || b.time - k[i - 1].time === W1)) &&
    k.at(-1).time === formingOf("1w") - W1, String(k.length));
  calls = [];
  route = candleServer({ servesForming: true });
  const m = await fetchUpbitKlines("BTCKRW", "1M", undefined, 100);
  const cm = candleCalls()[0];
  const now = new Date();
  const thisMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  ok("1M: /v1/candles/months, first to = the 1st of this month 00:00 UTC", cm.u.pathname === "/v1/candles/months" && Date.parse(cm.u.searchParams.get("to")) === thisMonth, cm.u.searchParams.get("to"));
  ok("1M: calendar months, the forming month dropped (closes at the next month), newest = last month",
    m.every((b) => new Date(b.time).getUTCDate() === 1) && m.at(-1).time === Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1) && contiguousTail(m, INTERVAL_MS["1M"]).length === m.length && m.length === 100, `${m.length} ${new Date(m.at(-1)?.time).toISOString()}`);
}
{
  // Delta (WP27) through fetchSeries: one small page of closed bars.
  fresh();
  route = candleServer();
  const d = await fetchSeries("upbit", "1h", "BTCKRW", 200, undefined, { limit: 3, overlapOpenTime: 0 }, (f) => f);
  ok("delta through fetchSeries: one request of limit + 1 bars, closed only", candleCalls().length === 1 && candleCalls()[0].u.searchParams.get("count") === "4" &&
    d.length === 4 && d.at(-1).time === formingOf("1h") - H1, `${candleCalls().length} ${d.length}`);
}

/* ---- rate limits ---- */
console.log("rate limits");
{
  // Review Focus 3: a 429 on page 3 of 5.
  fresh();
  const full = candleServer();
  route = (u) => (candleCalls().length === 3 ? new Response("Too many API requests.", { status: 429 }) : full(u));
  let err = null;
  try { await fetchUpbitKlines("BTCKRW", "1h", undefined, 1000); } catch (e) { err = e; }
  ok("429 mid-paging: RateLimitError, no partial series, no request 4", err instanceof RateLimitError && candleCalls().length === 3, `${err} ${candleCalls().length}`);
  ok("429: the Upbit cooldown is set (60 s default), other venues are not paused", rateLimitCooldown("upbit") > 50_000 && rateLimitCooldown("upbit") <= 60_000 &&
    rateLimitCooldown("coinbase") === 0 && rateLimitCooldown("binance") === 0);
  calls = [];
  let blocked = null;
  try { await fetchUpbitKlines("ETHKRW", "1h"); } catch (e) { blocked = e; }
  ok("while cooling down, the next Upbit series makes no request", blocked instanceof RateLimitError && calls.length === 0);
}
{
  fresh();
  const uni = universeRoute();
  route = (u) => (u.pathname.includes("/v1/candles/") ? new Response("", { status: 418 }) : uni(u));
  const r = await fetchDirectMarketData("1h", "upbit", [], 10, undefined, () => 1000, "crypto", "KRW", 0);
  const before = candleCalls().length;
  ok("418 halts the scan: rateLimitedUntil set, ~10 min Upbit cooldown", r.rateLimitedUntil > Date.now() + 590_000 && rateLimitCooldown("upbit") > 590_000, String(rateLimitCooldown("upbit")));
  ok("418 halts the scan: no further candle requests after the ban (only those already in flight)", before <= UPBIT_CONCURRENCY, String(before));
  ok("418 halts the scan: every series is a RATE_LIMIT error, none scored", Object.keys(r.klines).length === 0 && r.errors.length === r.tickers.length && r.errors.every((e) => e.reason === "RATE_LIMIT"), JSON.stringify(r.errors.slice(0, 2)));
  calls = [];
  let again = null;
  try { await fetchDirectMarketData("1h", "upbit", [], 10); } catch (e) { again = e; }
  ok("418: a new Upbit scan is refused without any request; Coinbase is not paused", again instanceof RateLimitError && calls.length === 0 && rateLimitCooldown("coinbase") === 0);
  resetRateLimitForTests();
}

/* ---- universe ---- */
console.log("universe");
{
  fresh();
  route = universeRoute();
  const set = await fetchUpbitTickers([], 100, undefined, "crypto", "KRW", 0);
  const t = calls.find((c) => c.u.pathname === "/v1/ticker/all");
  ok("ticker call: /v1/ticker/all?quote_currencies=KRW,USDT,BTC (upper case), one /v1/market/all", t?.u.searchParams.get("quote_currencies") === "KRW,USDT,BTC" &&
    calls.filter((c) => c.u.pathname === "/v1/market/all").length === 1 && calls.length === 2, t?.s);
  const btc = set.tickers.find((x) => x.symbol === "BTCKRW");
  ok("KRW volume uses KRW-USDT: 1.0e12 KRW / 1450 = 6.897e8 USD", near(parseFloat(btc?.quoteVolume), 1e12 / 1450) && Math.abs(parseFloat(btc.quoteVolume) - 6.897e8) < 1e5, btc?.quoteVolume);
  ok("KRW prices stay in KRW (trade_price); change = signed_change_rate x 100", btc?.lastPrice === "90101000" && near(parseFloat(btc.priceChangePercent), 1.23, 1e-6), JSON.stringify(btc));
  ok("KRW mode: KRW markets ranked by USD volume; KRW-USDT is FX (not crypto), unsafe ids dropped", set.tickers.map((x) => x.symbol).join() === "BTCKRW,ETHKRW,XRPKRW" &&
    classifySymbol("upbit", "USDTKRW") === "fx" && !set.universe.some((e) => e.p.includes(".")), set.tickers.map((x) => x.symbol).join());
  ok("PAXG in KRW is a commodity; ETH in BTC is crypto", classifySymbol("upbit", "PAXGKRW") === "commodity" && classifySymbol("upbit", "ETHBTC") === "crypto" && classifySymbol("upbit", "BTCKRW") === "crypto");
  ok("quote counts KRW, USDT and BTC (pickQuotes counts stablecoins only)", JSON.stringify(set.quoteCounts) === JSON.stringify({ KRW: 5, USDT: 2, BTC: 2 }), JSON.stringify(set.quoteCounts));
  ok("the Quote menu keeps KRW and BTC once live counts arrive: KRW, USDT, BTC (no Best)",
    JSON.stringify(quoteModesFor("upbit", Object.keys(set.quoteCounts))) === JSON.stringify(["KRW", "USDT", "BTC"]), JSON.stringify(quoteModesFor("upbit", Object.keys(set.quoteCounts))));
  ok("quote menu before any scan: KRW, USDT, BTC", JSON.stringify(quoteModesFor("upbit")) === JSON.stringify(["KRW", "USDT", "BTC"]));
  ok("quoteBySymbol says KRW", set.quoteBySymbol?.BTCKRW === "KRW");

  const bm = await fetchUpbitTickers([], 100, undefined, "crypto", "BTC", 0);
  const eth = bm.tickers.find((x) => x.symbol === "ETHBTC");
  ok("BTC market volume uses USDT-BTC: 100 BTC x 65000 = 6.5e6 USD", near(parseFloat(eth?.quoteVolume), 100 * 65000) && bm.tickers.map((x) => x.symbol).join() === "ETHBTC,SOLBTC", JSON.stringify(bm.tickers));
  ok("BTC mode: prices stay in BTC (0.05)", eth?.lastPrice === "0.05" && bm.quoteBySymbol?.ETHBTC === "BTC");
  const um = await fetchUpbitTickers([], 100, undefined, "crypto", "USDT", 0);
  ok("USDT markets: acc_trade_price_24h as USD volume", um.tickers.map((x) => x.symbol).join() === "BTCUSDT,ETHUSDT" && near(parseFloat(um.tickers[0].quoteVolume), 2_000_000));
  ok("upbitVolumeUsd: KRW ÷ KRW-USDT, BTC × USDT-BTC, USDT as is, unknown → NaN",
    near(upbitVolumeUsd("KRW", 1450, { KRW: 1450 }), 1) && near(upbitVolumeUsd("BTC", 2, { BTC: 65000 }), 130000) && upbitVolumeUsd("USDT", 5, {}) === 5 &&
    Number.isNaN(upbitVolumeUsd("KRW", 1, {})) && Number.isNaN(upbitVolumeUsd("BTC", 1, {})));
  const floored = await fetchUpbitTickers([], 100, undefined, "crypto", "KRW", 100_000_000);
  ok("liquidity floor on the USD volume (XRP 1e9 KRW ≈ $0.69M < $100M)", floored.tickers.map((x) => x.symbol).join() === "BTCKRW,ETHKRW" && floored.thin?.includes("XRPKRW"), JSON.stringify([floored.tickers.map((x) => x.symbol), floored.thin]));
  const only = await fetchUpbitTickers(["ETH"], 100, undefined, "crypto", "KRW", 0);
  ok("watch-list filter by base", only.tickers.map((x) => x.symbol).join() === "ETHKRW");
}
{
  // KRW-USDT missing: KRW volume is unknown — never converted through display FX.
  fresh();
  route = universeRoute(TICKERS.filter((x) => x.market !== "KRW-USDT"));
  const set = await fetchUpbitTickers([], 100, undefined, "crypto", "KRW", 0);
  // Final wave: unknown stays unknown inside the module (NaN ranks last), but no "NaN" string reaches the page.
  ok("KRW-USDT missing: prices still listed; quoteVolume is a finite \"0\" (never \"NaN\")", set.tickers.length === 3 &&
    set.tickers.every((x) => x.quoteVolume === "0" && x.quoteVolume !== "NaN" && Number.isFinite(parseFloat(x.lastPrice))), JSON.stringify(set.tickers));
  ok("KRW-USDT missing, floor off: nothing is called thin or unknown-and-dropped", set.thin.length === 0 && !(set.unknownVolume?.length), JSON.stringify([set.thin, set.unknownVolume]));
  const floored = await fetchUpbitTickers([], 100, undefined, "crypto", "KRW", 1_000_000);
  ok("KRW-USDT missing: an unknown volume never clears an active liquidity floor", floored.tickers.length === 0, JSON.stringify(floored.tickers));
  ok("KRW-USDT missing: the note counts them as unknown volume, not as thin pairs under the floor",
    floored.thin.length === 0 && floored.unknownVolume?.slice().sort().join() === "BTCKRW,ETHKRW,XRPKRW", JSON.stringify([floored.thin, floored.unknownVolume]));
  const r = await fetchDirectMarketData("1h", "upbit", [], 10, undefined, () => 200, "crypto", "KRW", 1_000_000);
  ok("KRW-USDT missing: the scan response carries unknownVolumeSymbols (no thinSymbols)", r.unknownVolumeSymbols?.length === 3 && !r.thinSymbols, JSON.stringify([r.unknownVolumeSymbols, r.thinSymbols]));
  // A real thin pair alongside: thin stays thin (known volume under the floor).
  fresh();
  route = universeRoute();
  const both = await fetchUpbitTickers([], 100, undefined, "crypto", "KRW", 100_000_000);
  ok("KRW-USDT present: thin pairs stay in thin, unknownVolume empty", both.thin.includes("XRPKRW") && !(both.unknownVolume?.length), JSON.stringify([both.thin, both.unknownVolume]));
  const { readFileSync } = await import("node:fs");
  const pageSrc = readFileSync(`${process.cwd()}/src/app/page.tsx`, "utf8");
  const en = JSON.parse(readFileSync(`${process.cwd()}/src/rsl/i18n/en.json`, "utf8"));
  ok("page shows the unknown-volume note from the scan meta (liq.unknown)", /unknownVolume: (data|lm)\.unknownVolumeSymbols/.test(pageSrc) && /t\("liq\.unknown"/.test(pageSrc) && typeof en["liq.unknown"] === "string" && /\{n, number\}/.test(en["liq.unknown"]));
}

/* ---- scan dispatch, Node transport ---- */
console.log("scan dispatch");
{
  fresh();
  route = universeRoute();
  const r = await fetchDirectMarketData("1h", "upbit", [], 10, undefined, () => 200, "crypto", "KRW", 0);
  ok("fetchDirectMarketData upbit: every series scored on closed bars", Object.keys(r.klines).sort().join() === "BTCKRW,ETHKRW,XRPKRW" && r.klines.BTCKRW.length === 200 && r.errors.length === 0, JSON.stringify(r.errors));
  ok("scan meta: label, KRW prices, KRW quote, quote counts with KRW/BTC", r.sourceLabel === "Upbit (KR)" && r.priceCurrency === "KRW" && r.quote === "KRW" && r.quoteCounts?.KRW === 5 && r.quoteCounts?.BTC === 2);
  ok("Node transport: every request goes to https://api.upbit.com on a read path (through relayGet)",
    calls.every((c) => c.u.origin === "https://api.upbit.com" && /^\/v1\/(market\/all|ticker\/all|candles\/minutes\/60)$/.test(c.u.pathname)), calls.map((c) => c.u.pathname).join());
  ok("candle requests use the native market ids", candleCalls().every((c) => /^KRW-(BTC|ETH|XRP)$/.test(c.u.searchParams.get("market"))));
  const b = await fetchDirectMarketData("1h", "upbit", [], 10, undefined, () => 200, "crypto", "BTC", 0);
  ok("BTC-quoted scan: price currency BTC, BTC pairs", b.priceCurrency === "BTC" && Object.keys(b.klines).sort().join() === "ETHBTC,SOLBTC", Object.keys(b.klines).join());
}

/* ---- relay failure (Review Focus 4) ---- */
console.log("relay failure");
{
  // A browser page: relayTransport() is "proxy" — every request must be same-origin /x/upbit/...
  globalThis.location = { protocol: "https:", origin: "https://page.example" };
  try {
    for (const [name, candleReply] of [
      ["missing rewrite (HTTP 404)", () => new Response("<html>Not found</html>", { status: 404 })],
      ["SPA fallback page (unreadable body)", () => new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } })],
      ["network refusal", () => { throw new TypeError("Failed to fetch"); }],
    ]) {
      fresh();
      const uni = universeRoute();
      route = (u) => (u.pathname.startsWith("/x/upbit/v1/candles/") ? candleReply() : uni(u));
      const r = await fetchDirectMarketData("1h", "upbit", [], 10, undefined, () => 200, "crypto", "KRW", 0);
      ok(`relay failure is a feed error, not a direct fetch — ${name}: a FetchError per series, "UNAVAILABLE"`,
        r.tickers.length === 3 && Object.keys(r.klines).length === 0 && r.errors.length === 3 && r.errors.every((e) => e.reason === "UNAVAILABLE" && /feed unavailable/i.test(e.message)), JSON.stringify(r.errors[0]));
      ok(`relay failure is a feed error, not a direct fetch — ${name}: no call to https://api.upbit.com, only /x/upbit/`,
        calls.length > 0 && calls.every((c) => c.s.startsWith("/x/upbit/v1/")) && !calls.some((c) => c.s.includes("api.upbit.com")), calls.map((c) => c.s).join(" "));
      ok(`${name}: not a rate limit (no cooldown, the scan is not halted)`, !r.rateLimitedUntil && rateLimitCooldown("upbit") === 0);
      // WP26 final review: every series "UNAVAILABLE" must not read "ok" — the badge says what the guide/ADR promise.
      ok(`${name}: health "blocked" (Blocked or unreachable) when every series is unavailable; native → "network-blocked"`,
        healthFromScan("upbit", r).state === "blocked" && healthFromScan("upbit", r, Date.now(), true).state === "network-blocked", JSON.stringify(healthFromScan("upbit", r)));
    }
    {
      // Only some series unavailable: the scan is partial, not blocked.
      fresh();
      const uni = universeRoute();
      const good = candleServer();
      route = (u) => (u.pathname.startsWith("/x/upbit/v1/candles/") ? (u.searchParams.get("market") === "KRW-BTC" ? good(u) : new Response("x", { status: 404 })) : uni(u));
      const r = await fetchDirectMarketData("1h", "upbit", [], 10, undefined, () => 200, "crypto", "KRW", 0);
      ok("some series unavailable: health is not \"blocked\"", r.errors.length === 2 && Object.keys(r.klines).join() === "BTCKRW" && healthFromScan("upbit", r).state === "ok",
        JSON.stringify([r.errors.length, Object.keys(r.klines), healthFromScan("upbit", r)]));
    }
    // The list itself unreachable: the scan fails with a feed error; the health badge says blocked/unreachable.
    fresh();
    route = () => new Response("<html>Not found</html>", { status: 404 });
    let err = null;
    try { await fetchDirectMarketData("1h", "upbit", [], 10); } catch (e) { err = e; }
    ok("relay failure on the market list: UpbitFeedError, health \"blocked\", no direct fetch", err instanceof UpbitFeedError && /feed unavailable/i.test(err.message) &&
      healthFromError(err, false)?.state === "blocked" && healthFromError(err, true)?.state === "network-blocked" && calls.every((c) => c.s.startsWith("/x/upbit/")), String(err));
  } finally {
    delete globalThis.location;
  }
}

/* ---- shared Upbit pacing ---- */
console.log("pacing");
function virtualClock(start = Date.now()) {
  let t = start;
  const timers = [];
  return {
    now: () => t,
    sleep(ms, signal) {
      return new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        timers.push({ at: t + Math.max(0, ms), resolve });
      });
    },
    async run(promise) {
      let done = false;
      const settled = promise.then((v) => { done = true; return v; }, (e) => { done = true; throw e; });
      for (let guard = 0; !done && guard < 1_000_000; guard++) {
        await new Promise((r) => setImmediate(r));
        if (done || !timers.length) continue;
        timers.sort((a, b) => a.at - b.at);
        const next = timers.shift();
        t = Math.max(t, next.at);
        next.resolve();
      }
      return settled;
    },
  };
}
const maxPerSecond = (times) => {
  const s = [...times].sort((a, b) => a - b);
  let best = 0;
  for (let i = 0, j = 0; i < s.length; i++) { while (s[i] - s[j] >= 1000) j++; best = Math.max(best, i - j + 1); }
  return best;
};
{
  // Every Upbit caller at once with a zero-latency venue: scan paging (8 series), a backfill, the ticker list
  // (markets + tickers) several times and a book — one IP, one candle gate and one ticker/market gate.
  const clock = virtualClock();
  resetRateLimitForTests(); setUpbitClockForTests(clock); resetUpbitForTests(); forgetPairsForTests(); calls = [];
  const candleTimes = [];
  const quoteTimes = [];
  const uni = universeRoute();
  route = (u) => {
    (u.pathname.includes("/v1/candles/") ? candleTimes : quoteTimes).push(clock.now());
    if (u.pathname === "/v1/orderbook") return json([{ market: "KRW-BTC", orderbook_units: [{ ask_price: 1451, bid_price: 1450, ask_size: 1, bid_size: 1 }] }]);
    return uni(u);
  };
  const jobs = [
    ...Array.from({ length: 8 }, (_, i) => fetchUpbitKlines(`C${i}KRW`, "1h", undefined, 1000)),
    fetchHistory("upbit", "BTCKRW", "1h", 1000),
    ...Array.from({ length: 6 }, () => fetchUpbitTickers([], 100, undefined, "crypto", "KRW", 0)),
  ];
  const out = await clock.run(Promise.all(jobs));
  await clock.run(fetchOrderBook("upbit", "BTCKRW"));
  ok("pacing: every series still completes (1,000 bars each)", out.slice(0, 8).every((k) => k.length === 1000), out.slice(0, 8).map((k) => k.length).join());
  ok(`pacing: never more than ${UPBIT_REQUESTS_PER_S} candle requests in any 1-s window (scan + backfill)`, maxPerSecond(candleTimes) <= UPBIT_REQUESTS_PER_S, String(maxPerSecond(candleTimes)));
  ok("pacing: the candle limit is reached, not undershot", maxPerSecond(candleTimes) === UPBIT_REQUESTS_PER_S && candleTimes.length >= 8 * 5 + 5, `${maxPerSecond(candleTimes)} ${candleTimes.length}`);
  ok(`pacing: never more than ${UPBIT_REQUESTS_PER_S} market/ticker/book requests in any 1-s window`, maxPerSecond(quoteTimes) <= UPBIT_REQUESTS_PER_S && quoteTimes.length === 13, `${maxPerSecond(quoteTimes)} ${quoteTimes.length}`);
  setUpbitClockForTests(null); resetUpbitForTests();
}

/* ---- history and order book ---- */
console.log("history and order book");
{
  fresh();
  route = candleServer({ servesForming: true });
  const h = await fetchHistory("upbit", "BTCKRW", "1h", 700);
  const F = formingOf("1h");
  ok("fetchHistory pages minutes/60 backwards (to before each oldest)", candleCalls().length === 4 && candleCalls().every((c) => c.u.pathname === "/v1/candles/minutes/60"), candleCalls().map((c) => c.u.searchParams.get("to")).join(" "));
  ok("fetchHistory: the first page never asks for the forming bar", Date.parse(candleCalls()[0].u.searchParams.get("to")) <= F);
  ok("fetchHistory: closed bars only, 700 contiguous", h.klines.length === 700 && h.klines.at(-1).time === F - H1 && contiguousTail(h.klines, H1).length === 700, `${h.klines.length} ${h.klines.at(-1)?.time}`);
  calls = [];
  route = candleServer({ listedAt: F - 300 * H1 });
  const short = await fetchHistory("upbit", "NEWKRW", "1h", 1000);
  ok("fetchHistory: a short page is the start of history", short.complete && short.klines.length === 300, `${short.complete} ${short.klines.length}`);
  calls = [];
  route = candleServer();
  const h8 = await fetchHistory("upbit", "BTCKRW", "8h", 200);
  ok("fetchHistory 8h: from minutes/240, epoch-aligned", candleCalls().every((c) => c.u.pathname === "/v1/candles/minutes/240") && h8.klines.length === 200 && h8.klines.every((b) => b.time % INTERVAL_MS["8h"] === 0), String(h8.klines.length));
  calls = [];
  const hw = await fetchHistory("upbit", "BTCKRW", "1w", 200);
  ok("fetchHistory 1w: /v1/candles/weeks, Monday weeks", candleCalls().every((c) => c.u.pathname === "/v1/candles/weeks") && hw.klines.length === 200 && hw.klines.every((b) => new Date(b.time).getUTCDay() === 1));
}
{
  fresh();
  let refused = null;
  try { await fetchOrderBook("upbit", "BTCKRW"); } catch (e) { refused = e; }
  ok("order book before any ticker read: refused (no KRW → USD price from the venue), no request", refused instanceof Error && calls.length === 0);
  const uni = universeRoute();
  route = (u) => u.pathname === "/v1/orderbook"
    ? json([{ market: "KRW-BTC", orderbook_units: [{ ask_price: 90_102_000, bid_price: 90_100_000, ask_size: 0.5, bid_size: 0.7 }, { ask_price: 90_110_000, bid_price: 90_090_000, ask_size: 2, bid_size: 1 }] }])
    : uni(u);
  await fetchUpbitTickers([], 100, undefined, "crypto", "KRW", 0);
  const b = await fetchOrderBook("upbit", "BTCKRW");
  const q = calls.find((c) => c.u.pathname === "/v1/orderbook");
  ok("order book: /v1/orderbook?markets=KRW-BTC", q?.u.searchParams.get("markets") === "KRW-BTC", q?.s);
  ok("order book levels valued in USD at the venue's KRW-USDT (1450), sizes in base", near(b.asks[0][0], 90_102_000 / 1450) && b.asks[0][1] === 0.5 && near(b.bids[0][0], 90_100_000 / 1450) && b.bids.length === 2 && b.asks.length === 2, JSON.stringify(b));
}

/* ---- display currency (page.tsx conversion helper) ---- */
console.log("display currency");
{
  // A rate table that even lists BTC (some rate sources carry crypto): BTC prices must still never pass through it.
  const table = { source: "frankfurter", rates: { EUR: 0.9, KRW: 1450, PHP: 58, BTC: 0.0000154 }, dates: {}, asOf: "2026-11-14", fetchedAt: Date.now() };
  const b = priceDisplay("BTC", "EUR", table);
  ok("BTC-quoted scan skips display FX: currency BTC, value unchanged, pricesInBtc flagged", b.currency === "BTC" && b.pricesInBtc === true && b.convert(0.0123) === 0.0123, JSON.stringify({ ...b, convert: undefined }));
  const bu = priceDisplay("BTC", "USD", table);
  ok("BTC-quoted scan skips display FX even for a USD display", bu.currency === "BTC" && bu.pricesInBtc && bu.convert(0.5) === 0.5);
  const k = priceDisplay("KRW", "EUR", table);
  ok("KRW converts through the display FX path, like PHP", k.currency === "EUR" && !k.pricesInBtc && near(k.convert(1450), 0.9) && near(k.convert(1450), convert(1450, "KRW", "EUR", table)));
  const kr = priceDisplay("KRW", "KRW", table);
  ok("KRW shown in KRW: unchanged", kr.currency === "KRW" && kr.convert(90101000) === 90101000);
  const none = priceDisplay("KRW", "EUR", null);
  ok("no rate yet: KRW shown as KRW", none.currency === "KRW" && none.convert(5) === 5 && !none.pricesInBtc);
}

globalThis.fetch = realFetch;
console.log(`\nUpbit suite: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
