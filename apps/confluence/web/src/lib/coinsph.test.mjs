// Coins.ph source regression suite — v2.6 (ADR-0013, plan WP7, acceptance PH-2…PH-8).
// Run: npm run test:coinsph   (node scripts/run-engine-tests.mjs coinsph.test.mjs)
//
// Fixtures are copied from the live probe of 7 Nov 2026
// (docs/research/evidence/coinsph-probe-2026-11-07.json). No test touches the network.
import {
  parseCoinsphKlines, parseExchangeInfo, rankPesoMarket, coinsphPassesThinRule, phPremiumPct,
  coinsphGet, coinsphCooldown, CoinsphError, setCoinsphTimingForTests, setCoinsphNativeGet,
  coinsphTransport, COINSPH_WEIGHT_PER_MIN, COINSPH_MIN_USD_TURNOVER, COINSPH_WEIGHTS, COINSPH_MAX_ASSETS,
} from "./coinsph.ts";
import { isAllowedNativeUrl, pathAllowed, COINSPH_READ_PATHS } from "./public-hosts.ts";
import { classifySymbol, inClass } from "./asset-classes.ts";
import {
  fetchDirectMarketData, rateLimitCooldown, resetRateLimitForTests, RateLimitError, dropUnclosed, DATA_SOURCES, priceCurrencyOf,
} from "./market-client.ts";
import { DEFAULT_COSTS } from "./ledger-metrics.ts";

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log("  ok   - " + name); }
  else { failed++; console.log("  FAIL - " + name + (extra ? "  [" + extra + "]" : "")); }
};
const realFetch = globalThis.fetch;
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "text/plain;charset=UTF-8", ...headers } });

/* ---- live fixtures (probe PH-1, 2026-11-07) ---- */
const KLINES_BTCPHP_1H = [
  [1794042000000, "4797056.7", "4798627.8", "4785980.1", "4789170.5", "0.0582002", 1794045599999, "278973.093568", 377, "0.024669", "118253.43419698"],
  [1794045600000, "4788562.7", "4790025", "4780758", "4785508.3", "0.0582364", 1794049199999, "278686.65269561", 369, "0.0355948", "170337.00540445"],
  [1794049200000, "4785670.7", "4792408.3", "4782287.5", "4789627.9", "0.049221", 1794052799999, "235651.84155917", 366, "0.0244181", "116907.8798445"],
  [1794052800000, "4788597.6", "4792938.8", "4775152.5", "4778862.7", "0.0505529", 1794056399999, "241908.52091786", 367, "0.0261352", "125062.2348107"],
  [1794056400000, "4781180.2", "4784414.6", "4775927.2", "4777010.6", "0.012891", 1794059999999, "61628.46170161", 95, "0.0069971", "33454.74512907"],
];
const PROBE_NOW = 1794057310984; // serverTime at the probe
const EXCHANGE_INFO = {
  timezone: "UTC", serverTime: PROBE_NOW, exchangeFilters: [],
  symbols: [
    { symbol: "BTCPHP", status: "trading", baseAsset: "BTC", quoteAsset: "PHP" },
    { symbol: "XRPPHP", status: "trading", baseAsset: "XRP", quoteAsset: "PHP" },
    { symbol: "ETHPHP", status: "trading", baseAsset: "ETH", quoteAsset: "PHP" },
    { symbol: "USDTPHP", status: "trading", baseAsset: "USDT", quoteAsset: "PHP" },
    { symbol: "USDCPHP", status: "trading", baseAsset: "USDC", quoteAsset: "PHP" },
    { symbol: "SOLPHP", status: "break", baseAsset: "SOL", quoteAsset: "PHP" },
    { symbol: "BTCUSDC", status: "trading", baseAsset: "BTC", quoteAsset: "USDC" },
    { symbol: "SHIBPHP", status: "trading", baseAsset: "SHIB", quoteAsset: "USDT" }, // name/assets disagree → dropped
  ],
};
const TICKERS = [
  { symbol: "USDTPHP", lastPrice: "63", openPrice: "63", priceChangePercent: "0", quoteVolume: "617126770.83" },
  { symbol: "USDCPHP", lastPrice: "63.06", openPrice: "63", priceChangePercent: "0.1", quoteVolume: "605320385.2" },
  { symbol: "BTCPHP", lastPrice: "4777360.8", openPrice: "4790000", priceChangePercent: "-0.26", quoteVolume: "18903435.86" },
  { symbol: "XRPPHP", lastPrice: "73.13", openPrice: "73", priceChangePercent: "0.18", quoteVolume: "14398159.23" },
  { symbol: "ETHPHP", lastPrice: "141120", openPrice: "141000", priceChangePercent: "0.09", quoteVolume: "7738459.21" },
  { symbol: "SOLPHP", lastPrice: "5652", openPrice: "5600", priceChangePercent: "0.9", quoteVolume: "4270892.65" },
  { symbol: "BTCUSDC", lastPrice: "75830", openPrice: "75800", priceChangePercent: "0.04", quoteVolume: "100" },
];

console.log("Parsing (PH-2)");
{
  const rows = parseCoinsphKlines(KLINES_BTCPHP_1H);
  ok("11-field rows parse to OHLCV + taker-buy", rows.length === 5 && rows[0].close === 4789170.5 && rows[0].volume === 0.0582002 && rows[0].takerBuy === 0.024669);
  const closed = dropUnclosed(rows, 3600e3, PROBE_NOW);
  ok("the open bar (last row) is dropped as unclosed", closed.length === 4 && closed[3].time === 1794052800000);
  ok("bad rows are dropped, not parsed as zero", parseCoinsphKlines([[1, "x", "1", "1", "1", "1"], ...KLINES_BTCPHP_1H.slice(0, 1)]).length === 1);
  let threw = null;
  try { parseCoinsphKlines({ code: -1121, msg: "Invalid symbol" }); } catch (e) { threw = e; }
  ok("a non-list kline response is a parse error", threw instanceof CoinsphError && threw.kind === "PARSE");
  const info = parseExchangeInfo(EXCHANGE_INFO);
  ok("exchangeInfo: lower-case 'trading' status understood", info.get("BTCPHP")?.trading === true && info.get("SOLPHP")?.trading === false);
  ok("exchangeInfo: symbol must equal base+quote", !info.has("SHIBPHP") && info.get("BTCUSDC")?.quote === "USDC");
}

console.log("Peso market, USD value and thin rule (PH-3)");
{
  const uni = rankPesoMarket(TICKERS, parseExchangeInfo(EXCHANGE_INFO));
  ok("USD/PHP from Coins.ph's own USDT/PHP", uni.usdPhp === 63);
  const btc = uni.ranked.find((r) => r.symbol === "BTCPHP");
  const xrp = uni.ranked.find((r) => r.symbol === "XRPPHP");
  ok("BTCPHP volume converted to USD (≈ $300k)", btc && Math.abs(btc.quoteVolumeUsd - 18903435.86 / 63) < 1);
  ok("BTCPHP clears the $250k floor; XRPPHP (≈ $228k) is thin", coinsphPassesThinRule(btc.quoteVolumeUsd) && !coinsphPassesThinRule(xrp.quoteVolumeUsd));
  ok("only trading PHP pairs are ranked (no USDC-quoted, no 'break')", !uni.ranked.some((r) => r.symbol === "BTCUSDC" || r.symbol === "SOLPHP"));
  const noRate = rankPesoMarket(TICKERS.filter((t) => !/^USD[TC]PHP$/.test(t.symbol)), parseExchangeInfo(EXCHANGE_INFO));
  ok("without a USD/PHP price nothing is valued and every pair is thin", noRate.usdPhp === null && noRate.ranked.every((r) => Number.isNaN(r.quoteVolumeUsd) && !coinsphPassesThinRule(r.quoteVolumeUsd)));
  ok("floor is $250k", COINSPH_MIN_USD_TURNOVER === 250_000);
}

console.log("Classification (PH-6)");
{
  ok("USDT/PHP and USDC/PHP are currencies (FX)", classifySymbol("coinsph", "USDTPHP") === "fx" && classifySymbol("coinsph", "USDCPHP") === "fx");
  ok("BTC/PHP is crypto", classifySymbol("coinsph", "BTCPHP") === "crypto");
  ok("PAXG/PHP keeps its USDT twin's class (commodity)", classifySymbol("coinsph", "PAXGPHP") === "commodity");
  ok("non-peso pairs on Coins.ph are not scanned", classifySymbol("coinsph", "BTCUSDT") === "excluded" && classifySymbol("coinsph", "BTCUSDC") === "excluded");
  ok("the crypto filter leaves USDT/PHP out", !inClass("coinsph", "USDTPHP", "crypto") && inClass("coinsph", "USDTPHP", "fx"));
  ok("other sources unchanged", classifySymbol("binance", "BTCUSDT") === "crypto" && classifySymbol("binance", "EURUSDT") === "fx");
}

console.log("Read-only allowlist (R16/R20)");
{
  ok("klines path allowed", isAllowedNativeUrl("https://api.pro.coins.ph/openapi/quote/v1/klines?symbol=BTCPHP&interval=1h&limit=3"));
  ok("time and exchangeInfo allowed exactly", isAllowedNativeUrl("https://api.pro.coins.ph/openapi/v1/time") && isAllowedNativeUrl("https://api.pro.coins.ph/openapi/v1/exchangeInfo"));
  ok("account / order / wallet paths refused", !isAllowedNativeUrl("https://api.pro.coins.ph/openapi/v1/account") && !isAllowedNativeUrl("https://api.pro.coins.ph/openapi/v1/order") && !isAllowedNativeUrl("https://api.pro.coins.ph/openapi/wallet/v1/deposit/address"));
  ok("traversal and encoded slashes refused", !pathAllowed("/openapi/quote/v1/../../v1/account", COINSPH_READ_PATHS) && !pathAllowed("/openapi/quote/v1/%2e%2e%2fv1", COINSPH_READ_PATHS) && !isAllowedNativeUrl("https://api.pro.coins.ph/openapi/quote/v1/x%2Fy"));
  ok("other hosts, http and credentials refused", !isAllowedNativeUrl("https://api.coins.ph/openapi/quote/v1/klines") && !isAllowedNativeUrl("http://api.pro.coins.ph/openapi/v1/time") && !isAllowedNativeUrl("https://u:p@api.pro.coins.ph/openapi/v1/time"));
  ok("the prefix itself is not a path", !pathAllowed("/openapi/quote/v1/", COINSPH_READ_PATHS));
  let threw = null;
  try { await coinsphGet("/openapi/v1/account", 1); } catch (e) { threw = e; }
  ok("coinsphGet refuses a private path before any request", threw instanceof CoinsphError && /not allowed/.test(threw.message));
}

console.log("Budget: 30 min of 5-minute auto-refresh stays ≤ 100 weight per minute (PH-4)");
{
  resetRateLimitForTests();
  let fake = PROBE_NOW;
  setCoinsphTimingForTests({ now: () => fake, sleep: async (ms) => { fake += ms; } });
  const log = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    const w = u.includes("exchangeInfo") ? COINSPH_WEIGHTS.exchangeInfo : u.includes("ticker/24hr") ? COINSPH_WEIGHTS.ticker24hAll : 1;
    log.push({ t: fake, w });
    if (u.includes("exchangeInfo")) return json(EXCHANGE_INFO);
    if (u.includes("ticker/24hr")) return json(TICKERS);
    return json(KLINES_BTCPHP_1H);
  };
  const end = PROBE_NOW + 30 * 60_000;
  let scans = 0;
  for (let next = PROBE_NOW; next < end; next += 5 * 60_000) {
    if (fake < next) fake = next;
    const { fetchCoinsphUniverse, fetchCoinsphKlineRows } = await import("./coinsph.ts");
    await fetchCoinsphUniverse();
    for (let i = 0; i < COINSPH_MAX_ASSETS; i++) await fetchCoinsphKlineRows("BTCPHP", "1h", 200);
    scans++;
  }
  let worst = 0;
  for (const a of log) worst = Math.max(worst, log.filter((b) => b.t >= a.t && b.t < a.t + 60_000).reduce((s, b) => s + b.w, 0));
  ok(`${scans} scans, worst rolling minute = ${worst} weight (limit ${COINSPH_WEIGHT_PER_MIN})`, scans === 6 && worst <= COINSPH_WEIGHT_PER_MIN, String(worst));
  const gaps = log.slice(1).map((x, i) => x.t - log[i].t);
  ok("requests at least 600 ms apart", gaps.every((g) => g >= 600), String(Math.min(...gaps)));
  setCoinsphTimingForTests();
  resetRateLimitForTests();
}

console.log("Cooldowns are per venue; failures are named honestly (PH-5, PH-8)");
{
  setCoinsphTimingForTests({ spacingMs: 0 });
  resetRateLimitForTests();
  globalThis.fetch = async () => json({ code: -1003, msg: "Too many requests" }, 429, { "retry-after": "120" });
  let threw = null;
  try { await fetchDirectMarketData("1h", "coinsph", [], 10); } catch (e) { threw = e; }
  ok("a Coins.ph 429 is a RateLimitError with the full Retry-After", threw instanceof RateLimitError && coinsphCooldown() > 115_000);
  ok("…and pauses Coins.ph only", rateLimitCooldown("coinsph") > 0 && rateLimitCooldown("binance") === 0 && rateLimitCooldown("bybit-spot") === 0);
  resetRateLimitForTests();
  globalThis.fetch = async (url) => (String(url).includes("binance") ? json({ code: -1003 }, 418, { "retry-after": "86400" }) : json([]));
  try { await fetchDirectMarketData("1h", "binance", [], 5); } catch { /* expected */ }
  ok("a Binance 418 ban does not pause Coins.ph", rateLimitCooldown("binance") > 86_000_000 && rateLimitCooldown("coinsph") === 0);
  ok("no-argument cooldown still reports the longest (back-compat)", rateLimitCooldown() > 86_000_000);
  resetRateLimitForTests();

  // Browser page: same-origin rewrite; an opaque failure is "blocked or unreachable", never a rate limit.
  globalThis.location = { protocol: "https:" };
  let seenUrl = "";
  globalThis.fetch = async (url) => { seenUrl = String(url); throw new TypeError("Failed to fetch"); };
  threw = null;
  try { await coinsphGet("/openapi/v1/time", 1); } catch (e) { threw = e; }
  ok("browser transport uses the /x/coinsph rewrite", coinsphTransport() === "proxy" && seenUrl === "/x/coinsph/openapi/v1/time");
  ok("opaque browser failure → BLOCKED, not RATE_LIMIT", threw instanceof CoinsphError && threw.kind === "BLOCKED" && !/rate/i.test(threw.message));
  globalThis.fetch = async () => new Response("<html>404</html>", { status: 404 });
  threw = null;
  try { await coinsphGet("/openapi/v1/time", 1); } catch (e) { threw = e; }
  ok("missing rewrite on another host → BLOCKED with guidance", threw?.kind === "BLOCKED" && /web host/.test(threw.message));
  delete globalThis.location;

  // Native transport: the adapter's nativeGet sees the absolute allowed URL and real status codes.
  let nativeUrl = "";
  setCoinsphNativeGet(async (url) => { nativeUrl = url; return { status: 403, headers: {}, body: "" }; });
  threw = null;
  try { await coinsphGet("/openapi/v1/time", 1); } catch (e) { threw = e; }
  ok("native transport calls the absolute allowed URL", coinsphTransport() === "native" && nativeUrl === "https://api.pro.coins.ph/openapi/v1/time");
  ok("native 403 → NETWORK_BLOCKED", threw?.kind === "NETWORK_BLOCKED");
  setCoinsphNativeGet(null);
  setCoinsphTimingForTests();
  resetRateLimitForTests();
}

console.log("Scan end-to-end (PH-3, PH-7)");
{
  setCoinsphTimingForTests({ spacingMs: 0 });
  resetRateLimitForTests();
  const realNow = Date.now;
  Date.now = () => PROBE_NOW; // fixtures are from the probe minute
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("exchangeInfo")) return json(EXCHANGE_INFO);
    if (u.includes("ticker/24hr")) return json(TICKERS);
    if (u.includes("data-api.binance.vision/api/v3/ticker/price")) return json([{ symbol: "BTCUSDT", price: "75843.99" }, { symbol: "ETHUSDT", price: "2240" }]);
    if (u.includes("/klines")) return json(KLINES_BTCPHP_1H);
    throw new Error("unexpected " + u);
  };
  const res = await fetchDirectMarketData("1h", "coinsph", [], 40);
  ok("prices are in PHP", res.priceCurrency === "PHP" && priceCurrencyOf("coinsph") === "PHP" && priceCurrencyOf("binance") === "USD");
  ok("only BTCPHP is scored; XRP/ETH listed as thin", res.tickers.length === 1 && res.tickers[0].symbol === "BTCPHP" && res.thinSymbols.includes("XRPPHP") && res.thinSymbols.includes("ETHPHP") && res.belowFloor === 2);
  ok("ticker volume is USD", Math.abs(parseFloat(res.tickers[0].quoteVolume) - 18903435.86 / 63) < 1);
  ok("closed candles only", res.klines.BTCPHP?.length === 4);
  const prem = res.premiumBySymbol?.BTCPHP;
  ok("PH premium vs Binance at Coins.ph's USD/PHP (≈ −0.02 %)", typeof prem === "number" && Math.abs(prem - phPremiumPct(4777360.8, 75843.99, 63)) < 0.001, String(prem));
  ok("premium undefined without a USD/PHP rate", phPremiumPct(1, 1, null) === undefined);
  Date.now = realNow;
  setCoinsphTimingForTests();
  resetRateLimitForTests();
}

console.log("Registration (US-5)");
{
  const src = DATA_SOURCES.find((s) => s.value === "coinsph");
  ok("Coins.ph is a source, capped at 40 pairs", src && src.maxAssets === 40);
  ok("Coins.ph has no private-API profile (never under 🔑)", src && !("privateApi" in src));
  ok("Coins.ph cost model is conservative", DEFAULT_COSTS.coinsph && DEFAULT_COSTS.coinsph.feeBps >= 25);
}

console.log("Source health line (US-1)");
{
  const { healthFromScan, healthFromError } = await import("./source-health.ts");
  const now = 1_000_000;
  ok("normal scan → OK", healthFromScan("binance", { durationMs: 4000, staleCount: 0, tickers: [1, 2] }, now).state === "ok");
  ok("Coins.ph pacing is not 'slow' at 40 s; Binance is", healthFromScan("coinsph", { durationMs: 40_000, staleCount: 0, tickers: [1] }, now).state === "ok" && healthFromScan("binance", { durationMs: 40_000, staleCount: 0, tickers: [1] }, now).state === "slow");
  ok("rate-limited result carries the resume time", healthFromScan("coinsph", { durationMs: 1, rateLimitedUntil: now + 5000, staleCount: 0, tickers: [] }, now).until === now + 5000);
  ok("all series stale → Stale", healthFromScan("binance", { durationMs: 1, staleCount: 2, tickers: [1, 2] }, now).state === "stale");
  ok("all series UNAVAILABLE → blocked (web) / network blocked (native); rate limit still wins", healthFromScan("upbit", { durationMs: 1, staleCount: 0, tickers: [1, 2], errors: [{ reason: "UNAVAILABLE" }, { reason: "UNAVAILABLE" }] }, now).state === "blocked" &&
    healthFromScan("upbit", { durationMs: 1, staleCount: 0, tickers: [1, 2], errors: [{ reason: "UNAVAILABLE" }, { reason: "UNAVAILABLE" }] }, now, true).state === "network-blocked" &&
    healthFromScan("upbit", { durationMs: 1, rateLimitedUntil: now + 5000, staleCount: 0, tickers: [1], errors: [{ reason: "UNAVAILABLE" }] }, now).state === "rate-limited" &&
    healthFromScan("upbit", { durationMs: 1, staleCount: 0, tickers: [1, 2], errors: [{ reason: "UNAVAILABLE" }] }, now).state === "ok");
  ok("web TypeError → blocked or unreachable; native → network blocked", healthFromError(new TypeError("Failed to fetch"), false).state === "blocked" && healthFromError(new TypeError("x"), true).state === "network-blocked");
  ok("Coins.ph kinds map one-to-one", healthFromError(new CoinsphError("BLOCKED", "x"), false).state === "blocked" && healthFromError(new CoinsphError("NETWORK_BLOCKED", "x"), true).state === "network-blocked");
  ok("RateLimitError → rate-limited", healthFromError(new RateLimitError("x", 60_000), false, now).until === now + 60_000);
  ok("an aborted scan changes nothing", healthFromError(new DOMException("x", "AbortError"), false) === null);
}

globalThis.fetch = realFetch;
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
