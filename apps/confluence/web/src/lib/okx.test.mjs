// OKX spot and perpetual scan sources — v2.8 Step 2 (WP26, Task 3).
// Run: npm run test:okx   (node scripts/run-engine-tests.mjs okx.test.mjs)
//
// Fixtures: docs/research/evidence/wp26-venues-probe-2026-11-15.json (results.okx.samples). Rows the probe did not
// capture (generated candle pages, instrument lists, a book) follow the row layout the probe recorded and are marked.
import {
  okxBar, parseOkxCandles, fetchOkxKlines, fetchOkxTickers, OKX_MAX_LIMIT, OKX_PAUSE_MS, OKX_CONCURRENCY, resetOkxForTests,
} from "./okx.ts";
import {
  DATA_SOURCES, INTERVAL_MS, RateLimitError, deltaSupported, fetchDirectMarketData, fetchHistory, fetchOrderBook,
  rateLimitCooldown, resetRateLimitForTests,
} from "./market-client.ts";
import { DEFAULT_COSTS } from "./ledger-metrics.ts";
import { forgetPairsForTests } from "./quotes.ts";
import { slowAfterMs } from "./source-health.ts";

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} ${extra}`); }
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const realFetch = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const okxOk = (data) => json({ code: "0", msg: "", data });

// ---- probe samples (verbatim) ----
const CANDLES_4H_BTC_USDT = [
  ["1794729600000", "64019.7", "66134.2", "63881.6", "65507.2", "2147.83906651", "139905333.726389542", "139905333.726389542", "0"],
  ["1794715200000", "64820.5", "65170.7", "63773.7", "64023", "2182.03909335", "140704512.896905697", "140704512.896905697", "1"],
];
const HISTORY_1DUTC_BTC_USDT_SWAP = [
  ["1794700800000", "64124.7", "66122.7", "61931.1", "65468.7", "9901360.08", "99013.6008", "6359856726.84656", "0"],
  ["1794614400000", "68286.7", "68420.7", "63272.2", "64124.8", "15612387.96", "156123.8796", "10272363144.4924", "1"],
];
const TICKER_SPOT_BTC_USDT = { instId: "BTC-USDT", last: "65507.2", open24h: "67284", vol24h: "20013.62938282", volCcy24h: "1292695447.166809873", ts: "1794743384165" };
const TICKER_SWAP_BTC_USDT_SWAP = { instId: "BTC-USDT-SWAP", last: "65468.7", vol24h: "20773353.93", volCcy24h: "207733.5393", ts: "1794743384362" };

/** Generated candle rows in the probe's layout, newest first. The newest bar (the one now forming) is confirm "0". */
function candleServer(intervalMs, { openTime = Math.floor(Date.now() / intervalMs) * intervalMs, rowsPerPage = OKX_MAX_LIMIT, flagNewestOpen = true } = {}) {
  const row = (t) => {
    const p = 100 + ((t / intervalMs) % 50);
    return [String(t), String(p), String(p + 2), String(p - 1), String(p + 1), "10", "1000", "1000", flagNewestOpen && t === openTime ? "0" : "1"];
  };
  return (u) => {
    const after = u.searchParams.has("after") ? Number(u.searchParams.get("after")) : null;
    // "after=<ts> returns bars strictly older than ts" (probe): the newest row is the last bar opening before `after`.
    const start = after === null ? openTime : Math.ceil(after / intervalMs) * intervalMs - intervalMs;
    const rows = [];
    for (let i = 0; i < rowsPerPage; i++) rows.push(row(start - i * intervalMs));
    return okxOk(rows);
  };
}

/* ---- constants and source registry ---- */
console.log("constants and source entries");
ok("OKX_MAX_LIMIT = 300 (probe: limit=500 capped to 300)", OKX_MAX_LIMIT === 300);
ok("OKX_PAUSE_MS = 120, OKX_CONCURRENCY = 4", OKX_PAUSE_MS === 120 && OKX_CONCURRENCY === 4);
const okxSpot = DATA_SOURCES.find((s) => s.value === "okx");
const okxPerp = DATA_SOURCES.find((s) => s.value === "okx-perp");
ok("DATA_SOURCES okx entry (label, note, maxAssets, keyless)", okxSpot?.label === "OKX Spot" && okxSpot.note === "Public spot tickers and OHLCV candles (USDT, USDC)." && okxSpot.maxAssets === 200 && !("privateApi" in okxSpot), JSON.stringify(okxSpot));
ok("DATA_SOURCES okx-perp entry (label, note, maxAssets, keyless)", okxPerp?.label === "OKX Perpetual" && okxPerp.note === "Public USDT-margined perpetual tickers and OHLCV candles." && okxPerp.maxAssets === 200 && !("privateApi" in okxPerp), JSON.stringify(okxPerp));
ok("source health gives a paged OKX warm start 60 s before it is \"slow\"", slowAfterMs("okx") === 60_000 && slowAfterMs("okx-perp") === 60_000 && slowAfterMs("binance") === 20_000);
ok("DEFAULT_COSTS has okx and okx-perp (perp carries funding)", DEFAULT_COSTS.okx?.feeBps > 0 && DEFAULT_COSTS["okx-perp"]?.feeBps > 0 && DEFAULT_COSTS["okx-perp"].fundingBpsPer8h > 0 && DEFAULT_COSTS.okx.fundingBpsPer8h === 0);

/* ---- bar map ---- */
console.log("bar map");
const bars = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "6h": "6Hutc", "12h": "12Hutc", "1d": "1Dutc", "1w": "1Wutc", "1M": "1Mutc" };
for (const [tf, bar] of Object.entries(bars)) ok(`okxBar(${tf}) = ${bar}, native`, okxBar(tf)?.bar === bar && okxBar(tf).aggregate === undefined && okxBar(tf).baseMs === INTERVAL_MS[tf], JSON.stringify(okxBar(tf)));
ok("okxBar(8h) = 2 x 4H (8H is rejected by OKX, probe)", okxBar("8h")?.bar === "4H" && okxBar("8h").aggregate === 2 && okxBar("8h").baseMs === INTERVAL_MS["4h"]);
ok("okxBar(2d/4d) = synthetic days from 1Dutc", okxBar("2d")?.bar === "1Dutc" && okxBar("2d").aggregate === 2 && okxBar("4d")?.aggregate === 4 && okxBar("4d").baseMs === INTERVAL_MS["1d"]);
ok("okxBar(unknown) = null", okxBar("3h") === null && okxBar("") === null);
ok("delta only on native bars", deltaSupported("okx", "4h") && deltaSupported("okx-perp", "1h") && !deltaSupported("okx", "8h") && !deltaSupported("okx-perp", "2d") && !deltaSupported("okx", "4d"));

/* ---- parsing ---- */
console.log("parsing");
{
  const p = parseOkxCandles({ code: "0", msg: "", data: CANDLES_4H_BTC_USDT });
  const kept = p.k.filter((_, i) => !p.open[i]);
  ok("parses OKX rows and drops the open bar: 2 rows, ascending, newest flagged open", p.k.length === 2 && p.k[0].time < p.k[1].time && p.open[0] === false && p.open[1] === true, JSON.stringify(p.open));
  const b = kept[0];
  ok("parses OKX rows and drops the open bar: 1 kept bar (the confirm \"1\" row)", kept.length === 1 && b.time === 1794715200000, String(kept.length));
  ok("parses OKX rows and drops the open bar: o/h/l/c/v = 64820.5 / 65170.7 / 63773.7 / 64023 / 2182.03909335",
    b.open === 64820.5 && b.high === 65170.7 && b.low === 63773.7 && b.close === 64023 && b.volume === 2182.03909335, JSON.stringify(b));
  const s = parseOkxCandles(HISTORY_1DUTC_BTC_USDT_SWAP, true);
  const ks = s.k.filter((_, i) => !s.open[i]);
  ok("perp volume is volCcy (base coin), not contracts", ks.length === 1 && ks[0].volume === 156123.8796, JSON.stringify(ks[0]));
  const junk = parseOkxCandles({ code: "0", data: [["x", "1", "2", "0", "1", "1", "1", "1", "1"], "nope", ["1794715200000", "1", "2", "0", "1", "1", "1", "1", "1"]] });
  ok("rows with non-numeric fields are skipped", junk.k.length === 1);
  let threw = false;
  try { parseOkxCandles({ code: "0" }); } catch { threw = true; }
  ok("a response without a data array throws (not an empty series)", threw);
}

/* ---- klines through fetchOkxKlines ---- */
console.log("klines");
let calls = [];
let route = () => json({ error: "unexpected" }, 404);
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  calls.push(u);
  return route(u);
};
{
  // Flag beats the clock: the newest row is flagged open although its close time has already passed.
  const H4 = INTERVAL_MS["4h"];
  const newest = Math.floor(Date.now() / H4) * H4 - H4;
  resetRateLimitForTests(); calls = [];
  route = candleServer(H4, { openTime: newest });
  const k = await fetchOkxKlines("okx", "BTCUSDT", "4h", undefined, 200);
  ok("drops the open bar: confirm \"0\" is dropped even when its close time has passed", k.length === 200 && k.at(-1).time === newest - H4 && !k.some((b) => b.time === newest), `${k.length} ${k.at(-1)?.time} vs ${newest}`);
  ok("first request is /api/v5/market/candles with instId and bar", calls[0].pathname === "/api/v5/market/candles" && calls[0].searchParams.get("instId") === "BTC-USDT" && calls[0].searchParams.get("bar") === "4H" && calls[0].searchParams.get("limit") === "201", calls[0]?.href);

  // The forming bar (time not yet closed) flagged "0".
  calls = [];
  route = candleServer(INTERVAL_MS["1h"]);
  const k2 = await fetchOkxKlines("okx-perp", "BTCUSDT", "1h", undefined, 200);
  const nowHour = Math.floor(Date.now() / INTERVAL_MS["1h"]) * INTERVAL_MS["1h"];
  ok("drops the open bar: the forming bar never appears", k2.length === 200 && k2.at(-1).time === nowHour - INTERVAL_MS["1h"], String(k2.at(-1)?.time));
  ok("perp candles use the -SWAP instId", calls[0].searchParams.get("instId") === "BTC-USDT-SWAP");
}
{
  const H1 = INTERVAL_MS["1h"];
  resetRateLimitForTests(); calls = [];
  route = candleServer(H1);
  const k = await fetchOkxKlines("okx", "BTCUSDT", "1h", undefined, 1000);
  const contiguous = k.every((b, i) => i === 0 || b.time - k[i - 1].time === H1);
  ok("pages with after= until 1000 bars: 1,000 ascending contiguous bars", k.length === 1000 && contiguous, `${k.length} ${contiguous}`);
  ok("pages with after= until 1000 bars: 4 requests", calls.length === 4, String(calls.length));
  const pathsOk = calls[0].pathname === "/api/v5/market/candles" && calls.slice(1).every((c) => c.pathname === "/api/v5/market/history-candles");
  ok("pages with after= until 1000 bars: requests 2-4 hit history-candles", pathsOk, calls.map((c) => c.pathname).join());
  const nowHour = Math.floor(Date.now() / H1) * H1;
  const oldestOf = (i) => nowHour - (i + 1) * OKX_MAX_LIMIT * H1 + H1; // page i served 300 rows from its start
  const afterOk = calls.slice(1).every((c, i) => Number(c.searchParams.get("after")) === oldestOf(i));
  ok("pages with after= until 1000 bars: after = the previous page's oldest ts", afterOk, calls.slice(1).map((c) => c.searchParams.get("after")).join());
  ok("pages never ask for more than 300 rows", calls.every((c) => Number(c.searchParams.get("limit")) <= 300));

  // A pair listed recently: an empty page ends the series (scored cold, never padded).
  calls = [];
  let served = 0;
  const full = candleServer(H1);
  route = (u) => (served++ < 2 ? full(u) : okxOk([]));
  const short = await fetchOkxKlines("okx", "NEWUSDT", "1h", undefined, 1000);
  ok("an empty page stops paging: short series returned as-is, not padded", short.length === 599 && calls.length === 3, `${short.length} / ${calls.length}`);
}
{
  const H4 = INTERVAL_MS["4h"];
  resetRateLimitForTests(); calls = [];
  route = candleServer(H4);
  const k = await fetchOkxKlines("okx", "BTCUSDT", "8h", undefined, 200);
  const H8 = INTERVAL_MS["8h"];
  const aligned = k.every((b) => b.time % H8 === 0);
  // Recompute one bucket from the 4H rows the stub served.
  const rows = new Map();
  for (const c of calls) {
    const res = await candleServer(H4)(c).json();
    for (const r of res.data) rows.set(Number(r[0]), r);
  }
  const b = k.at(-1);
  const r0 = rows.get(b.time);
  const r1 = rows.get(b.time + H4);
  const sumOk = r0 && r1 && b.open === Number(r0[1]) && b.close === Number(r1[4]) && b.high === Math.max(Number(r0[2]), Number(r1[2])) && b.volume === Number(r0[5]) + Number(r1[5]);
  ok("8h aggregates two 4H bars: requests ask for bar=4H", calls.every((c) => c.searchParams.get("bar") === "4H"), calls.map((c) => c.searchParams.get("bar")).join());
  ok("8h aggregates two 4H bars: epoch-aligned 8h buckets, 200 of them", k.length === 200 && aligned, `${k.length} ${aligned}`);
  ok("8h aggregates two 4H bars: open/high/close/volume of the pair", !!sumOk, JSON.stringify(b));
  ok("8h aggregates two 4H bars: marked aggregated (okxBar aggregate 2, no delta)", okxBar("8h").aggregate === 2 && !deltaSupported("okx", "8h"));
  ok("8h: a bucket whose second 4H bar is still open is not built", b.time + H8 <= Date.now());
}
{
  // Review Focus 3: a 429 on page 3 of 4.
  resetRateLimitForTests(); calls = [];
  const full = candleServer(INTERVAL_MS["1h"]);
  route = (u) => (calls.length === 3 ? new Response(JSON.stringify({ code: "50011", msg: "Too Many Requests" }), { status: 429 }) : full(u));
  let err = null;
  try { await fetchOkxKlines("okx", "BTCUSDT", "1h", undefined, 1000); } catch (e) { err = e; }
  await new Promise((r) => setTimeout(r, OKX_PAUSE_MS * 3));
  ok("rate limit mid-paging halts the series: rejects with RateLimitError (no partial series)", err instanceof RateLimitError, String(err));
  ok("rate limit mid-paging halts the series: OKX cooldown set", rateLimitCooldown("okx") > 0 && rateLimitCooldown("okx-perp") > 0, String(rateLimitCooldown("okx")));
  ok("rate limit mid-paging halts the series: no request 4", calls.length === 3, String(calls.length));
  ok("the OKX cooldown does not pause other venues", rateLimitCooldown("binance") === 0 && rateLimitCooldown("bybit-spot") === 0);
  let blocked = null;
  calls = [];
  try { await fetchOkxKlines("okx-perp", "ETHUSDT", "1h"); } catch (e) { blocked = e; }
  ok("while cooling down, the next OKX series makes no request", blocked instanceof RateLimitError && calls.length === 0, `${blocked} ${calls.length}`);

  // An HTTP 200 envelope with OKX's rate-limit code is a rate limit too.
  resetRateLimitForTests(); calls = [];
  route = () => json({ code: "50011", msg: "Too Many Requests", data: [] });
  let err2 = null;
  try { await fetchOkxKlines("okx", "BTCUSDT", "1h"); } catch (e) { err2 = e; }
  ok("OKX code 50011 in a 200 envelope raises RateLimitError", err2 instanceof RateLimitError && rateLimitCooldown("okx") > 0, String(err2));
  resetRateLimitForTests();
  route = () => json({ code: "51000", msg: "Parameter bar error", data: [] });
  let err3 = null;
  try { await fetchOkxKlines("okx", "BTCUSDT", "1h"); } catch (e) { err3 = e; }
  ok("any other OKX error code is an error, not an empty series", err3 instanceof Error && !(err3 instanceof RateLimitError) && /51000/.test(err3.message), String(err3));
}

/* ---- universe ---- */
console.log("universe");
const instrumentsFixture = [
  // BTC-USDT-SWAP as recorded by the probe; the other rows are made up to cover the filter.
  { instId: "BTC-USDT-SWAP", ctType: "linear", ctVal: "0.01", ctValCcy: "BTC", settleCcy: "USDT", state: "live" },
  { instId: "BTC-USD-SWAP", ctType: "inverse", ctVal: "100", ctValCcy: "USD", settleCcy: "BTC", state: "live" },
  { instId: "ETH-USDT-SWAP", ctType: "linear", ctVal: "0.1", ctValCcy: "ETH", settleCcy: "USDT", state: "suspend" },
  { instId: "BTC-USDC-SWAP", ctType: "linear", ctVal: "0.0001", ctValCcy: "BTC", settleCcy: "USDC", state: "live" },
  { instId: "SOL-USDT-SWAP", ctType: "linear", ctVal: "1", ctValCcy: "SOL", settleCcy: "USDT", state: "live" },
];
const swapTickers = [
  TICKER_SWAP_BTC_USDT_SWAP,
  { instId: "BTC-USD-SWAP", last: "65470", open24h: "67000", vol24h: "1000000", volCcy24h: "1500" },
  { instId: "ETH-USDT-SWAP", last: "3000", open24h: "3100", vol24h: "1", volCcy24h: "900000" },
  { instId: "BTC-USDC-SWAP", last: "65480", open24h: "67000", vol24h: "1", volCcy24h: "50000" },
  { instId: "SOL-USDT-SWAP", last: "150", open24h: "120", vol24h: "1", volCcy24h: "100000" },
];
const spotTickers = [
  TICKER_SPOT_BTC_USDT,
  { instId: "ETH-USDT", last: "3000", open24h: "3000", volCcy24h: "500000000" },
  { instId: "BTC-USDC", last: "65500", open24h: "67000", volCcy24h: "90000000" },
  { instId: "USDC-USDT", last: "0.9998", open24h: "1", volCcy24h: "800000000" },
  { instId: "BTC-EUR", last: "60000", open24h: "61000", volCcy24h: "1000000" },
  { instId: "A.B-USDT", last: "1", open24h: "1", volCcy24h: "9000000000" },
];
let instrumentCalls = 0;
const universeRoute = (u) => {
  if (u.pathname === "/api/v5/public/instruments") { instrumentCalls++; return okxOk(u.searchParams.get("instType") === "SWAP" ? instrumentsFixture : []); }
  if (u.pathname === "/api/v5/market/tickers") return okxOk(u.searchParams.get("instType") === "SWAP" ? swapTickers : spotTickers);
  if (u.pathname.startsWith("/api/v5/market/")) return candleServer(INTERVAL_MS["1h"])(u);
  return json({ error: "unexpected" }, 404);
};
{
  resetRateLimitForTests(); resetOkxForTests(); forgetPairsForTests(); calls = []; instrumentCalls = 0;
  route = universeRoute;
  const set = await fetchOkxTickers("okx-perp", [], 200, undefined, "crypto", "USDT", 0);
  const syms = set.tickers.map((t) => t.symbol);
  ok("perp universe keeps linear USDT swaps only: BTC-USD-SWAP (inverse), BTC-USDC-SWAP and suspended ETH excluded", syms.join() === "BTCUSDT,SOLUSDT", syms.join());
  const btc = set.tickers.find((t) => t.symbol === "BTCUSDT");
  ok("perp universe keeps linear USDT swaps only: BTC-USDT-SWAP qvUsd = 207733.5393 x 65468.7", near(parseFloat(btc.quoteVolume), 207733.5393 * 65468.7), btc?.quoteVolume);
  ok("tickers use instType=SWAP and instruments are read once", calls.some((c) => c.pathname === "/api/v5/market/tickers" && c.searchParams.get("instType") === "SWAP") && instrumentCalls === 1);
  ok("perp basis stays undefined (never pinned by basis)", Object.keys(set.basis).length === 0);
  const sol = set.tickers.find((t) => t.symbol === "SOLUSDT");
  ok("24 h change = (last - open24h) / open24h x 100", near(parseFloat(sol.priceChangePercent), 25), sol?.priceChangePercent);
  await fetchOkxTickers("okx-perp", [], 200, undefined, "crypto", "USDT", 0);
  ok("instruments are cached (INSTRUMENT_TTL_MS)", instrumentCalls === 1, String(instrumentCalls));
}
{
  resetRateLimitForTests(); forgetPairsForTests(); calls = [];
  route = universeRoute;
  const set = await fetchOkxTickers("okx", [], 200, undefined, "crypto", "USDT", 0);
  const btc = set.tickers.find((t) => t.symbol === "BTCUSDT");
  ok("spot qvUsd is volCcy24h: BTC-USDT gives 1292695447.17", near(parseFloat(btc.quoteVolume), 1292695447.17, 1e-9), btc?.quoteVolume);
  ok("spot 24 h change from the probe sample", near(parseFloat(btc.priceChangePercent), ((65507.2 - 67284) / 67284) * 100, 1e-4), btc?.priceChangePercent);
  ok("spot USDT mode: USDT pairs only, unsafe ids dropped", set.tickers.every((t) => t.symbol.endsWith("USDT")) && !set.tickers.some((t) => t.symbol.includes(".")) && !set.tickers.some((t) => t.symbol === "USDCUSDT"), set.tickers.map((t) => t.symbol).join());
  ok("spot quote counts list USDT and USDC", set.quoteCounts?.USDT >= 2 && set.quoteCounts?.USDC === 1, JSON.stringify(set.quoteCounts));
  ok("spot uses instType=SPOT and reads no instruments", calls.some((c) => c.searchParams.get("instType") === "SPOT") && !calls.some((c) => c.pathname === "/api/v5/public/instruments"));
  const usdc = await fetchOkxTickers("okx", [], 200, undefined, "crypto", "USDC", 0);
  const b2 = usdc.tickers.find((t) => t.symbol === "BTCUSDC");
  ok("spot USDC mode: BTC-USDC volume converted at USDC-USDT", usdc.tickers.length === 1 && near(parseFloat(b2.quoteVolume), 90000000 * 0.9998), JSON.stringify(usdc.tickers));
  const floored = await fetchOkxTickers("okx", [], 200, undefined, "crypto", "USDT", 600_000_000);
  ok("liquidity floor applies to OKX (USD volume)", floored.tickers.map((t) => t.symbol).join() === "BTCUSDT" && floored.thin?.includes("ETHUSDT"), JSON.stringify([floored.tickers.map((t) => t.symbol), floored.thin]));
}

/* ---- scan dispatch ---- */
console.log("scan dispatch");
{
  resetRateLimitForTests(); resetOkxForTests(); forgetPairsForTests(); calls = [];
  route = universeRoute;
  const r = await fetchDirectMarketData("1h", "okx-perp", [], 10, undefined, () => 200, "crypto", "USDT", 0);
  ok("fetchDirectMarketData okx-perp: both series scored on closed bars", Object.keys(r.klines).sort().join() === "BTCUSDT,SOLUSDT" && r.klines.BTCUSDT.length === 200 && r.errors.length === 0, JSON.stringify(r.errors));
  ok("scan meta: label, USD prices, USDT quotes", r.sourceLabel === "OKX Perpetual" && r.priceCurrency === "USD" && r.quote === "USDT" && r.quoteBySymbol?.BTCUSDT === "USDT");
  ok("candle requests use the -SWAP ids", calls.filter((c) => c.pathname === "/api/v5/market/candles").every((c) => /-USDT-SWAP$/.test(c.searchParams.get("instId"))));
}
{
  // A 429 in the middle of one series' pages halts the scan across tiers; no further page is requested.
  resetRateLimitForTests(); resetOkxForTests(); forgetPairsForTests(); calls = [];
  const many = Array.from({ length: 30 }, (_, i) => ({ instId: `C${i}-USDT`, last: "1", open24h: "1", volCcy24h: String(1e9 - i * 1e6) }));
  let hit = -1;
  route = (u) => {
    if (u.pathname === "/api/v5/market/tickers") return okxOk(many);
    if (u.pathname === "/api/v5/market/history-candles" && u.searchParams.get("instId") === "C1-USDT" && hit < 0) {
      hit = calls.length;
      return new Response("{}", { status: 429 });
    }
    return candleServer(INTERVAL_MS["1h"])(u);
  };
  const r = await fetchDirectMarketData("1h", "okx", [], 30, undefined, () => 1000, "crypto", "USDT", 0);
  await new Promise((res) => setTimeout(res, OKX_PAUSE_MS * 3));
  const batch1 = new Set(["C0-USDT", "C1-USDT", "C2-USDT", "C3-USDT"]);
  const perSeries = {};
  for (const c of calls.filter((x) => x.pathname.includes("candles"))) perSeries[c.searchParams.get("instId")] = (perSeries[c.searchParams.get("instId")] ?? 0) + 1;
  ok("scan: a 429 mid-paging flags the scan rate-limited", (r.rateLimitedUntil ?? 0) > Date.now() && rateLimitCooldown("okx") > 0);
  ok("scan: no later batch or tier requests anything after the 429", Object.keys(perSeries).every((id) => batch1.has(id)), JSON.stringify(perSeries));
  ok("scan: series in flight stop at the next page (cooldown checked before every page)", Object.values(perSeries).every((n) => n <= 2), JSON.stringify(perSeries));
  ok("scan: the series that hit the limit is not returned partially", !r.klines["C1USDT"] && r.errors.some((e) => e.symbol === "C1USDT" && e.reason === "RATE_LIMIT"));
  ok("scan: later tiers are skipped and reported", r.errors.filter((e) => e.message.startsWith("Skipped")).length >= 20, String(r.errors.length));
  ok("scan: no partial series anywhere (every kept series has 1,000 bars)", Object.values(r.klines).every((k) => k.length === 1000), Object.values(r.klines).map((k) => k.length).join());
}

/* ---- history and order book ---- */
console.log("history and order book");
{
  resetRateLimitForTests(); forgetPairsForTests(); calls = [];
  route = candleServer(INTERVAL_MS["1h"]);
  const h = await fetchHistory("okx", "BTCUSDT", "1h", 600);
  const nowHour = Math.floor(Date.now() / INTERVAL_MS["1h"]) * INTERVAL_MS["1h"];
  ok("fetchHistory pages history-candles with after=", calls.length >= 2 && calls.every((c) => c.pathname === "/api/v5/market/history-candles" && c.searchParams.has("after")), calls.map((c) => c.pathname).join());
  ok("fetchHistory: closed bars only, 600 of them", h.klines.length === 600 && h.klines.at(-1).time === nowHour - INTERVAL_MS["1h"], `${h.klines.length} ${h.klines.at(-1)?.time}`);
  calls = [];
  route = candleServer(INTERVAL_MS["4h"]);
  const h8 = await fetchHistory("okx-perp", "BTCUSDT", "8h", 200);
  ok("fetchHistory 8h aggregates 4H bars", calls.every((c) => c.searchParams.get("bar") === "4H") && h8.klines.length === 200 && h8.klines.every((b) => b.time % INTERVAL_MS["8h"] === 0));
}
{
  resetRateLimitForTests(); resetOkxForTests(); calls = [];
  // Book rows [price, size, liquidated orders, orders] — layout from OKX's docs [not verified by the probe].
  const book = { asks: [["65000", "10", "0", "3"], ["65010", "5", "0", "1"]], bids: [["64990", "20", "0", "2"]], ts: "1794743384165" };
  route = (u) => (u.pathname === "/api/v5/public/instruments" ? okxOk(instrumentsFixture) : u.pathname === "/api/v5/market/books" ? okxOk([book]) : json({}, 404));
  const spot = await fetchOrderBook("okx", "BTCUSDT");
  const q = calls.find((c) => c.pathname === "/api/v5/market/books");
  ok("order book: /api/v5/market/books?instId=&sz=100", q?.searchParams.get("instId") === "BTC-USDT" && q.searchParams.get("sz") === "100");
  ok("spot book sizes are base coin", spot.asks[0][0] === 65000 && spot.asks[0][1] === 10 && spot.bids[0][1] === 20);
  const perp = await fetchOrderBook("okx-perp", "BTCUSDT");
  ok("perp book sizes are contracts x ctVal (base coin)", near(perp.asks[0][1], 0.1) && near(perp.bids[0][1], 0.2), JSON.stringify(perp.asks));
}

globalThis.fetch = realFetch;
console.log(`\nOKX suite: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
