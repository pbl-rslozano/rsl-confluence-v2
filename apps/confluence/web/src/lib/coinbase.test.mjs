// Coinbase spot scan source — v2.8 Step 2 (WP26, Task 4).
// Run: npm run test:coinbase   (node scripts/run-engine-tests.mjs coinbase.test.mjs)
//
// Fixtures: docs/research/evidence/wp26-venues-probe-2026-11-15.json (results.coinbase.samples). Rows the probe did not
// capture (generated candle windows, the product list, a book) follow the layout the probe recorded and are marked.
import {
  coinbaseGranularity, parseCoinbaseCandles, fetchCoinbaseKlines, fetchCoinbaseTickers, COINBASE_MAX_LIMIT,
  COINBASE_MAX_REQUESTS_PER_SERIES, COINBASE_PAUSE_MS, COINBASE_CONCURRENCY, COINBASE_REQUESTS_PER_S, resetCoinbaseForTests,
  setCoinbaseClockForTests,
} from "./coinbase.ts";
import {
  DATA_SOURCES, INTERVAL_MS, RateLimitError, contiguousTail, deltaSupported, fetchDirectMarketData, fetchHistory, fetchOrderBook,
  fetchSeries, rateLimitCooldown, resetRateLimitForTests,
} from "./market-client.ts";
import { DEFAULT_COSTS } from "./ledger-metrics.ts";
import { forgetPairsForTests, quoteModesFor, normalizeQuoteMode, priceCurrencyOfQuote } from "./quotes.ts";
import { classifySymbol } from "./asset-classes.ts";
import { slowAfterMs } from "./source-health.ts";

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} ${extra}`); }
};
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const realFetch = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const H1 = INTERVAL_MS["1h"];
const D1 = INTERVAL_MS["1d"];

// ---- probe samples (verbatim) ----
const CANDLES_1H_BTC_USD = [
  [1794625200, 66550, 67698.05, 67623.54, 66689.32, 791.52715948],
  [1794621600, 66789, 68250, 68222.6, 67623.53, 1300.73086088],
];
const STATS_BTC_USD = { stats_24hour: { open: "67214.93", high: "67265.39", low: "61946.17", last: "65456.32", volume: "21563.57459366" } };

/**
 * Generated candle windows in the probe's layout ([time s, low, high, open, close, volume], newest first).
 * The venue serves every bar in [start − overlap, end + overlap] and — like a live venue whose newest row is
 * the bar now forming — the forming bar whenever the window reaches it. Options: `gap` (an open time with no
 * candle: no trades), `listedAt` (no candle before it), `overlap` (bars served past each end of the window).
 */
function candleServer({ overlap = 0, gap = null, listedAt = -Infinity } = {}) {
  return (u) => {
    const g = Number(u.searchParams.get("granularity")) * 1000;
    const start = Date.parse(u.searchParams.get("start"));
    const end = Date.parse(u.searchParams.get("end"));
    const forming = Math.floor(Date.now() / g) * g;
    const rows = [];
    const top = end + g >= forming ? forming : end + overlap * g;
    for (let t = Math.floor(top / g) * g; t >= start - overlap * g; t -= g) {
      if (t === gap || t < listedAt) continue;
      const p = 100 + ((t / g) % 50);
      rows.push([t / 1000, p - 1, p + 2, p, p + 1, 10]);
    }
    return json(rows);
  };
}

/* ---- constants and source registry ---- */
console.log("constants and source entry");
ok("COINBASE_MAX_LIMIT = 300, 16 requests per series", COINBASE_MAX_LIMIT === 300 && COINBASE_MAX_REQUESTS_PER_SERIES === 16);
ok("COINBASE_PAUSE_MS = 150, COINBASE_CONCURRENCY = 3", COINBASE_PAUSE_MS === 150 && COINBASE_CONCURRENCY === 3);
ok("gate at 80 % of the documented 10 requests/s per IP: 8/s", COINBASE_REQUESTS_PER_S === 8);
const cb = DATA_SOURCES.find((s) => s.value === "coinbase");
ok("DATA_SOURCES coinbase entry (label, note, maxAssets, keyless)",
  cb?.label === "Coinbase (US)" && cb.note === "Public USD spot tickers and OHLCV candles; 4h and longer are built from shorter candles." &&
  cb.maxAssets === 100 && !("privateApi" in cb), JSON.stringify(cb));
ok("DEFAULT_COSTS coinbase: base-tier taker 0.60 %, no funding", DEFAULT_COSTS.coinbase?.feeBps === 60 && DEFAULT_COSTS.coinbase.fundingBpsPer8h === 0, JSON.stringify(DEFAULT_COSTS.coinbase));
ok("source health gives a paged Coinbase scan 90 s before it is \"slow\"", slowAfterMs("coinbase") === 90_000);
ok("quotes: USD by default, USDT on request, USD prices", normalizeQuoteMode("coinbase", undefined) === "USD" && normalizeQuoteMode("coinbase", "USDT") === "USDT" && normalizeQuoteMode("coinbase", "USDC") === "USD" && priceCurrencyOfQuote("coinbase", "USD") === "USD");

/* ---- granularity map ---- */
console.log("granularity map");
for (const [tf, g] of Object.entries({ "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "6h": 21600, "1d": 86400 })) {
  const m = coinbaseGranularity(tf);
  ok(`coinbaseGranularity(${tf}) = ${g}, native`, m?.granularity === g && m.aggregate === undefined && m.baseMs === g * 1000 && deltaSupported("coinbase", tf), JSON.stringify(m));
}
for (const [tf, g, n] of [["4h", 3600, 4], ["8h", 3600, 8], ["12h", 21600, 2], ["1w", 86400, 7], ["1M", 86400, 30], ["2d", 86400, 2], ["4d", 86400, 4]]) {
  const m = coinbaseGranularity(tf);
  ok(`coinbaseGranularity(${tf}) = ${n} x ${g}, aggregated (no delta)`, m?.granularity === g && m.aggregate === n && m.baseMs === g * 1000 && !deltaSupported("coinbase", tf), JSON.stringify(m));
}
ok("coinbaseGranularity(unknown) = null", coinbaseGranularity("3h") === null && coinbaseGranularity("") === null);

/* ---- parsing ---- */
console.log("parsing");
{
  const k = parseCoinbaseCandles(CANDLES_1H_BTC_USD);
  const b = k.find((x) => x.time === 1794625200 * 1000);
  ok("maps low/high correctly: ascending bars, time in ms", k.length === 2 && k[0].time < k[1].time && k[1] === b);
  ok("maps low/high correctly: candles_1h_BTC-USD row 0 = o 67623.54, h 67698.05, l 66550, c 66689.32, v 791.52715948",
    b && b.open === 67623.54 && b.high === 67698.05 && b.low === 66550 && b.close === 66689.32 && b.volume === 791.52715948, JSON.stringify(b));
  const junk = parseCoinbaseCandles([[1794625200, "x", 2, 1, 1, 1], "nope", [1794621600, 1, 2, 1, 1, 1], [1794618000, 1, 2]]);
  ok("rows with non-numeric fields or too few columns are skipped", junk.length === 1 && junk[0].time === 1794621600000);
  let threw = false;
  try { parseCoinbaseCandles({ message: "Unsupported granularity" }); } catch { threw = true; }
  ok("a response that is not a row array throws (not an empty series)", threw);
}

/* ---- klines ---- */
console.log("klines");
let calls = [];
let route = () => json({ message: "unexpected" }, 404);
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  calls.push(u);
  return route(u);
};
const candleCalls = () => calls.filter((c) => c.pathname.endsWith("/candles"));
const forming = (g) => Math.floor(Date.now() / g) * g;
{
  resetRateLimitForTests(); resetCoinbaseForTests(); forgetPairsForTests(); calls = [];
  route = candleServer();
  const k = await fetchCoinbaseKlines("BTCUSD", "1h", undefined, 200);
  const F = forming(H1);
  ok("drops the open bar: the bar now forming (served by the venue) is not returned", k.length === 200 && k.at(-1).time === F - H1 && !k.some((b) => b.time >= F), `${k.length} ${k.at(-1)?.time} vs ${F}`);
  const c = calls[0];
  ok("candles request: /products/BTC-USD/candles?granularity=3600&start=&end= (ISO)", c.pathname === "/products/BTC-USD/candles" && c.searchParams.get("granularity") === "3600" && /Z$/.test(c.searchParams.get("start")) && /Z$/.test(c.searchParams.get("end")), c?.href);
  ok("the newest window ends at the last closed bar (never asks for the open one)", Date.parse(c.searchParams.get("end")) === F - H1, c.searchParams.get("end"));
  ok("one request for 200 bars, window spans 199 bars", calls.length === 1 && Date.parse(c.searchParams.get("end")) - Date.parse(c.searchParams.get("start")) === 199 * H1);
}
{
  resetRateLimitForTests(); calls = [];
  route = candleServer({ overlap: 2 });
  const k = await fetchCoinbaseKlines("BTCUSD", "1h", undefined, 1000);
  const unique = new Set(k.map((b) => b.time)).size === k.length;
  const asc = k.every((b, i) => i === 0 || b.time - k[i - 1].time === H1);
  ok("pages merge without duplicates: 1,000 unique ascending contiguous bars from overlapping windows", k.length === 1000 && unique && asc, `${k.length} ${unique} ${asc}`);
  ok("pages merge without duplicates: 4 requests (300 + 300 + 300 + 100)", calls.length === 4, String(calls.length));
  const spans = calls.map((c) => (Date.parse(c.searchParams.get("end")) - Date.parse(c.searchParams.get("start"))) / H1 + 1);
  ok("windows hold at most 300 bars and walk back without holes", spans.join() === "300,300,300,100" &&
    calls.slice(1).every((c, i) => Date.parse(c.searchParams.get("end")) === Date.parse(calls[i].searchParams.get("start")) - H1), spans.join());
  ok("newest bar is the last closed one", k.at(-1).time === forming(H1) - H1);
}
{
  // Review Focus 2: no candle is published for an hour with no trades (probe: "gaps").
  resetRateLimitForTests(); calls = [];
  const F = forming(H1);
  route = candleServer({ gap: F - 201 * H1 });
  const k = await fetchCoinbaseKlines("THINUSD", "1h", undefined, 1000);
  ok("gap keeps newest contiguous run: 200 bars after the missing hour", k.length === 200 && k[0].time === F - 200 * H1 && k.at(-1).time === F - H1, `${k.length} ${k[0]?.time}`);
  ok("gap keeps newest contiguous run: contiguous, never padded (scored cold: 200 < 1,000)", contiguousTail(k, H1).length === k.length && k.length < 1000);
  // A pair listed 450 hours ago: the older windows come back empty, paging stops, the series is returned as it is.
  calls = [];
  route = candleServer({ listedAt: F - 450 * H1 });
  const n = await fetchCoinbaseKlines("NEWUSD", "1h", undefined, 1000);
  ok("a recently listed pair: short series returned as-is, paging stops at the empty window", n.length === 450 && calls.length === 3, `${n.length} / ${calls.length}`);
}
{
  const H4 = INTERVAL_MS["4h"];
  resetRateLimitForTests(); calls = [];
  route = candleServer();
  const k = await fetchCoinbaseKlines("BTCUSD", "4h", undefined, 1000);
  ok("4h builds from 1h within the cap: 14 requests, all granularity=3600", calls.length === 14 && calls.every((c) => c.searchParams.get("granularity") === "3600"), String(calls.length));
  ok("4h builds from 1h within the cap: 1,000 epoch-aligned 4h bars", k.length === 1000 && k.every((b, i) => b.time % H4 === 0 && (i === 0 || b.time - k[i - 1].time === H4)), String(k.length));
  ok("4h builds from 1h within the cap: the newest is the last closed 4h bar", k.at(-1).time === forming(H4) - H4);
  const b = k.at(-1);
  const px = (t) => 100 + ((t / H1) % 50);
  const hs = [0, 1, 2, 3].map((i) => b.time + i * H1);
  ok("4h bar = open of hour 1, max high, min low, close of hour 4, summed volume",
    b.open === px(hs[0]) && b.close === px(hs[3]) + 1 && b.high === Math.max(...hs.map((t) => px(t) + 2)) && b.low === Math.min(...hs.map((t) => px(t) - 1)) && b.volume === 40, JSON.stringify(b));
  ok("4h is marked aggregated", coinbaseGranularity("4h").aggregate === 4 && !deltaSupported("coinbase", "4h"));
}
{
  resetRateLimitForTests(); calls = [];
  route = candleServer();
  const k = await fetchCoinbaseKlines("BTCUSD", "8h", undefined, 1000);
  const H8 = INTERVAL_MS["8h"];
  ok("8h stops at the request cap: 16 requests", calls.length === COINBASE_MAX_REQUESTS_PER_SERIES, String(calls.length));
  ok("8h stops at the request cap: 600 bars (returned as they are, scored cold)", k.length === 600 && k.every((b) => b.time % H8 === 0) && k.at(-1).time === forming(H8) - H8, String(k.length));
}
{
  // 1w: weeks start Monday 00:00 UTC (like the other venues' weekly bars), built from daily candles.
  resetRateLimitForTests(); calls = [];
  route = candleServer();
  const k = await fetchCoinbaseKlines("BTCUSD", "1w", undefined, 100);
  ok("1w: 100 Monday-aligned weeks of 7 daily bars", k.length === 100 && k.every((b) => new Date(b.time).getUTCDay() === 1 && b.time % D1 === 0 && b.volume === 70), `${k.length} ${new Date(k[0]?.time).getUTCDay()}`);
  ok("1w: the newest is the last closed week, 3 daily requests", Date.now() - k.at(-1).time >= 7 * D1 && Date.now() - k.at(-1).time < 14 * D1 && calls.length === 3 && calls.every((c) => c.searchParams.get("granularity") === "86400"), String(calls.length));
  // 1M: calendar months (barCloseTime closes a 1M bar at the next month's start), built from daily candles.
  calls = [];
  const m = await fetchCoinbaseKlines("BTCUSD", "1M", undefined, 100);
  const now = new Date();
  const lastMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  const days = (t) => { const d = new Date(t); return (Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - t) / D1; };
  ok("1M: 100 calendar months, each the sum of its days", m.length === 100 && m.every((b) => new Date(b.time).getUTCDate() === 1 && b.time % D1 === 0 && b.volume === days(b.time) * 10), `${m.length}`);
  ok("1M: the newest is last month, within the request cap", m.at(-1).time === lastMonth && calls.length <= COINBASE_MAX_REQUESTS_PER_SERIES, `${new Date(m.at(-1)?.time).toISOString()} ${calls.length}`);
}
{
  // Delta (WP27) through fetchSeries: one small window of closed bars.
  resetRateLimitForTests(); calls = [];
  route = candleServer();
  const d = await fetchSeries("coinbase", "1h", "BTCUSD", 200, undefined, { limit: 3, overlapOpenTime: 0 }, (fresh) => fresh);
  ok("delta through fetchSeries: one request of limit + 1 bars, closed only", calls.length === 1 && d.length === 4 && d.at(-1).time === forming(H1) - H1, `${calls.length} ${d.length}`);
}
{
  // Review Focus 3 (owned by Task 3, checked here for Coinbase): a 429 on request 3 of 4.
  resetRateLimitForTests(); calls = [];
  const full = candleServer();
  route = (u) => (calls.length === 3 ? json({ message: "Public rate limit exceeded" }, 429) : full(u));
  let err = null;
  try { await fetchCoinbaseKlines("BTCUSD", "1h", undefined, 1000); } catch (e) { err = e; }
  ok("rate limit mid-paging: RateLimitError, no partial series, no request 4", err instanceof RateLimitError && calls.length === 3, `${err} ${calls.length}`);
  ok("rate limit mid-paging: the Coinbase cooldown is set, other venues are not paused", rateLimitCooldown("coinbase") > 0 && rateLimitCooldown("okx") === 0 && rateLimitCooldown("binance") === 0);
  calls = [];
  let blocked = null;
  try { await fetchCoinbaseKlines("ETHUSD", "1h"); } catch (e) { blocked = e; }
  ok("while cooling down, the next Coinbase series makes no request", blocked instanceof RateLimitError && calls.length === 0);
  resetRateLimitForTests();
}

/* ---- universe ---- */
console.log("universe");
// BTC-USD and the two delisted USDC books are as the probe recorded them; the other rows are made up to cover the filter.
const PRODUCTS = [
  { id: "BTC-USD", base_currency: "BTC", quote_currency: "USD", status: "online", trading_disabled: false },
  { id: "BTC-USDC", base_currency: "BTC", quote_currency: "USDC", status: "delisted", trading_disabled: true },
  { id: "ETH-USDC", base_currency: "ETH", quote_currency: "USDC", status: "delisted", trading_disabled: true },
  { id: "ETH-USD", base_currency: "ETH", quote_currency: "USD", status: "online", trading_disabled: false },
  { id: "BTC-USDT", base_currency: "BTC", quote_currency: "USDT", status: "online", trading_disabled: false },
  { id: "SOL-USDT", base_currency: "SOL", quote_currency: "USDT", status: "online", trading_disabled: false },
  { id: "BTC-EUR", base_currency: "BTC", quote_currency: "EUR", status: "online", trading_disabled: false },
  { id: "DOGE-USD", base_currency: "DOGE", quote_currency: "USD", status: "online", trading_disabled: true },
  { id: "OLD-USD", base_currency: "OLD", quote_currency: "USD", status: "offline", trading_disabled: false },
  { id: "USDT-USD", base_currency: "USDT", quote_currency: "USD", status: "online", trading_disabled: false },
  { id: "PAXG-USD", base_currency: "PAXG", quote_currency: "USD", status: "online", trading_disabled: false },
  { id: "NOSTAT-USD", base_currency: "NOSTAT", quote_currency: "USD", status: "online", trading_disabled: false },
  { id: "A.B-USD", base_currency: "A.B", quote_currency: "USD", status: "online", trading_disabled: false },
];
const s24 = (open, last, volume) => ({ stats_24hour: { open, high: last, low: open, last, volume } });
const STATS = {
  "BTC-USD": STATS_BTC_USD,
  "BTC-USDC": s24("67000", "65400", "99999"),
  "ETH-USD": s24("3000", "3300", "100000"),
  "BTC-USDT": s24("67000", "65450", "100"),
  "SOL-USDT": s24("150", "150", "1000"),
  "BTC-EUR": s24("60000", "61000", "99999"),
  "DOGE-USD": s24("0.1", "0.1", "1e12"),
  "OLD-USD": s24("1", "1", "1e12"),
  "USDT-USD": s24("1", "1.0001", "500000000"),
  "PAXG-USD": s24("2600", "2650", "1000"),
  "A.B-USD": s24("1", "1", "1e12"),
};
const universeRoute = (u) => {
  if (u.pathname === "/products") return json(PRODUCTS);
  if (u.pathname === "/products/stats") return json(STATS);
  if (u.pathname.endsWith("/candles")) return candleServer()(u);
  return json({ message: "NotFound" }, 404);
};
{
  resetRateLimitForTests(); resetCoinbaseForTests(); forgetPairsForTests(); calls = [];
  route = universeRoute;
  const set = await fetchCoinbaseTickers([], 100, undefined, "crypto", "USD", 0);
  const syms = set.tickers.map((t) => t.symbol);
  ok("delisted USDC books are not in the universe: BTC-USDC excluded, BTC-USD kept", !syms.includes("BTCUSDC") && syms.includes("BTCUSD") && !set.universe.some((e) => e.p === "BTCUSDC"), syms.join());
  const btc = set.tickers.find((t) => t.symbol === "BTCUSD");
  ok("delisted USDC books are not in the universe: BTC-USD qvUsd = 21563.57459366 x 65456.32", near(parseFloat(btc.quoteVolume), 21563.57459366 * 65456.32), btc?.quoteVolume);
  ok("24 h change = (last - open) / open x 100 (probe sample)", near(parseFloat(btc.priceChangePercent), ((65456.32 - 67214.93) / 67214.93) * 100, 1e-4), btc?.priceChangePercent);
  ok("USD mode: online, tradable USD books only, ranked by USD volume (crypto class)", syms.join() === "BTCUSD,ETHUSD", syms.join());
  ok("trading-disabled, offline, EUR, stat-less and unsafe ids are left out", !set.universe.some((e) => ["DOGEUSD", "OLDUSD", "BTCEUR", "NOSTATUSD"].includes(e.p) || e.p.includes(".")), JSON.stringify(set.universe));
  ok("a stablecoin against USD is excluded; PAXG-USD is a commodity", classifySymbol("coinbase", "USDTUSD") === "excluded" && !set.universe.some((e) => e.p === "USDTUSD") &&
    classifySymbol("coinbase", "PAXGUSD") === "commodity" && classifySymbol("coinbase", "BTCUSD") === "crypto");
  ok("quote counts include plain USD (pickQuotes counts stablecoins only)", set.quoteCounts?.USD === 4 && set.quoteCounts?.USDT === 2 && set.quoteCounts.USDC === undefined, JSON.stringify(set.quoteCounts));
  ok("the quote menu keeps USD once live counts arrive: USD, USDT (no Best, no USDC)", JSON.stringify(quoteModesFor("coinbase", Object.keys(set.quoteCounts))) === JSON.stringify(["USD", "USDT"]), JSON.stringify(quoteModesFor("coinbase", Object.keys(set.quoteCounts))));
  ok("one /products and one /products/stats call", calls.filter((c) => c.pathname === "/products").length === 1 && calls.filter((c) => c.pathname === "/products/stats").length === 1);
  ok("quoteBySymbol says USD", set.quoteBySymbol?.BTCUSD === "USD");
  const all = await fetchCoinbaseTickers([], 100, undefined, "all", "USD", 0);
  ok("all classes: PAXG-USD included, USDT-USD still excluded", all.tickers.some((t) => t.symbol === "PAXGUSD") && !all.tickers.some((t) => t.symbol === "USDTUSD"));
  const usdt = await fetchCoinbaseTickers([], 100, undefined, "crypto", "USDT", 0);
  ok("USDT mode: the USDT books, USD volume = volume x last", usdt.tickers.map((t) => t.symbol).join() === "BTCUSDT,SOLUSDT" && near(parseFloat(usdt.tickers[0].quoteVolume), 100 * 65450), JSON.stringify(usdt.tickers));
  const floored = await fetchCoinbaseTickers([], 100, undefined, "crypto", "USD", 1_000_000_000);
  ok("liquidity floor applies (USD volume)", floored.tickers.map((t) => t.symbol).join() === "BTCUSD" && floored.thin?.includes("ETHUSD"), JSON.stringify([floored.tickers.map((t) => t.symbol), floored.thin]));
  const only = await fetchCoinbaseTickers(["ETH"], 100, undefined, "crypto", "USD", 0);
  ok("watch-list filter by base", only.tickers.map((t) => t.symbol).join() === "ETHUSD");
}

/* ---- scan dispatch ---- */
console.log("scan dispatch");
{
  resetRateLimitForTests(); resetCoinbaseForTests(); forgetPairsForTests(); calls = [];
  route = universeRoute;
  const r = await fetchDirectMarketData("1h", "coinbase", [], 10, undefined, () => 200, "crypto", "USD", 0);
  ok("fetchDirectMarketData coinbase: both series scored on closed bars", Object.keys(r.klines).sort().join() === "BTCUSD,ETHUSD" && r.klines.BTCUSD.length === 200 && r.errors.length === 0, JSON.stringify(r.errors));
  ok("scan meta: label, USD prices, USD quote, quote counts with USD", r.sourceLabel === "Coinbase (US)" && r.priceCurrency === "USD" && r.quote === "USD" && r.quoteBySymbol?.BTCUSD === "USD" && r.quoteCounts?.USD === 4);
  ok("candle requests use the native product ids", candleCalls().every((c) => /^\/products\/(BTC|ETH)-USD\/candles$/.test(c.pathname)), candleCalls().map((c) => c.pathname).join());
}

/* ---- shared Coinbase pacing ---- */
console.log("pacing");
/** Discrete-event clock: sleeps resolve in virtual-time order whenever the program is otherwise idle. */
function virtualClock(start = Date.now()) {
  let t = start;
  const timers = [];
  return {
    now: () => t,
    sleep(ms, signal) {
      return new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const tm = { at: t + Math.max(0, ms), resolve };
        timers.push(tm);
        signal?.addEventListener("abort", () => { const i = timers.indexOf(tm); if (i >= 0) timers.splice(i, 1); resolve(); }, { once: true });
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
  // Every Coinbase caller at once with a zero-latency venue: scan paging (12 series), a backfill, the ticker
  // list (products + stats) and an order book — one IP, one limit.
  const clock = virtualClock();
  resetRateLimitForTests(); resetCoinbaseForTests(); setCoinbaseClockForTests(clock); forgetPairsForTests(); calls = [];
  const times = [];
  route = (u) => {
    times.push(clock.now());
    if (u.pathname.endsWith("/book")) return json({ bids: [["1", "1", 1]], asks: [["1.1", "1", 1]], sequence: 1 });
    return universeRoute(u);
  };
  const jobs = [
    ...Array.from({ length: 12 }, (_, i) => fetchCoinbaseKlines(`C${i}USD`, "1h", undefined, 1000)),
    fetchHistory("coinbase", "BTCUSD", "1h", 1200),
    fetchCoinbaseTickers([], 100, undefined, "crypto", "USD", 0),
    fetchOrderBook("coinbase", "BTCUSD"),
  ];
  const out = await clock.run(Promise.all(jobs));
  ok("pacing: every series still completes (1,000 bars each)", out.slice(0, 12).every((k) => k.length === 1000), out.slice(0, 12).map((k) => k.length).join());
  ok(`pacing: never more than ${COINBASE_REQUESTS_PER_S} Coinbase requests in any 1-s window (candles, history, products, stats, book)`, maxPerSecond(times) <= COINBASE_REQUESTS_PER_S, String(maxPerSecond(times)));
  ok("pacing: the limit is reached, not undershot (the gate is the only brake)", maxPerSecond(times) === COINBASE_REQUESTS_PER_S && times.length >= 12 * 4 + 4 + 3, `${maxPerSecond(times)} ${times.length}`);
  setCoinbaseClockForTests(null); resetCoinbaseForTests();
}

/* ---- history and order book ---- */
console.log("history and order book");
{
  resetRateLimitForTests(); forgetPairsForTests(); calls = [];
  route = candleServer();
  const h = await fetchHistory("coinbase", "BTCUSD", "1h", 700);
  const F = forming(H1);
  ok("fetchHistory pages candle windows backwards", calls.length >= 3 && calls.every((c) => c.pathname === "/products/BTC-USD/candles" && c.searchParams.get("granularity") === "3600"), calls.map((c) => c.search).join(" "));
  ok("fetchHistory: closed bars only, 700 contiguous", h.klines.length === 700 && h.klines.at(-1).time === F - H1 && contiguousTail(h.klines, H1).length === 700, `${h.klines.length} ${h.klines.at(-1)?.time}`);
  calls = [];
  route = candleServer({ listedAt: F - 400 * H1 });
  const short = await fetchHistory("coinbase", "NEWUSD", "1h", 1000);
  ok("fetchHistory: an empty window is the end of history", short.complete && short.klines.length === 400, `${short.complete} ${short.klines.length}`);
  calls = [];
  route = candleServer();
  const w = await fetchHistory("coinbase", "BTCUSD", "1w", 200);
  ok("fetchHistory 1w: Monday weeks from daily candles", calls.every((c) => c.searchParams.get("granularity") === "86400") && w.klines.length === 200 && w.klines.every((b) => new Date(b.time).getUTCDay() === 1), String(w.klines.length));
  calls = [];
  const m4 = await fetchHistory("coinbase", "BTCUSD", "4h", 200);
  ok("fetchHistory 4h: from 1h candles, epoch-aligned", calls.every((c) => c.searchParams.get("granularity") === "3600") && m4.klines.length === 200 && m4.klines.every((b) => b.time % INTERVAL_MS["4h"] === 0));
}
{
  resetRateLimitForTests(); resetCoinbaseForTests(); calls = [];
  // Level-2 rows [price, size, num-orders] — layout from Coinbase's docs [not verified by the probe].
  const book = { bids: [["64990", "20", 2]], asks: [["65000", "10", 3], ["65010", "5", 1]], sequence: 1 };
  route = (u) => (u.pathname === "/products/BTC-USD/book" ? json(book) : json({}, 404));
  const b = await fetchOrderBook("coinbase", "BTCUSD");
  const q = calls.find((c) => c.pathname === "/products/BTC-USD/book");
  ok("order book: /products/BTC-USD/book?level=2", q?.searchParams.get("level") === "2");
  ok("order book levels: price and base size", b.asks[0][0] === 65000 && b.asks[0][1] === 10 && b.bids[0][1] === 20 && b.asks.length === 2);
}

globalThis.fetch = realFetch;
console.log(`\nCoinbase suite: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
