// Stablecoin quote pairing — v2.7 (plan WP12, acceptance SQ-1…SQ-7).
// Run: node scripts/run-engine-tests.mjs quotes.test.mjs
// Response shapes follow the live probe of 11 Nov 2026 (docs/research/evidence/fx-quotes-probe-2026-11-11.md).
// No test touches the network.
import {
  splitPair, baseOf, baseFromInput, selectPairs, resetBestPicksForTests, depegLevel, quoteModesFor, normalizeQuoteMode,
  priceCurrencyOfQuote, rememberPairs, forgetPairsForTests, BEST,
} from "./quotes.ts";
import { classifySymbol } from "./asset-classes.ts";
import { baseOf as riskBaseOf, clusterOf } from "./risk-engine.ts";
import { fetchDirectMarketData, resetRateLimitForTests, bitgetProductOf } from "./market-client.ts";

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log("  ok   - " + name); }
  else { failed++; console.log("  FAIL - " + name + (extra ? "  [" + extra + "]" : "")); }
};
const realFetch = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/* ---- SQ-2 splitPair golden ---- */
const cases = [
  ["BTCFDUSD", undefined, "BTC", "FDUSD"], ["ETHUSD1", undefined, "ETH", "USD1"], ["BTCPERP", "bybit-perp", "BTC", "USDC"],
  ["1000PEPEPERP", "bitget-perp", "1000PEPE", "USDC"], ["SOLEURI", undefined, "SOL", "EURI"], ["USDCUSDT", undefined, "USDC", "USDT"],
  ["XUSDT", undefined, "X", "USDT"], ["AXSUSDT", undefined, "AXS", "USDT"], ["BTCPHP", undefined, "BTC", "PHP"],
  ["BTCUSDC", undefined, "BTC", "USDC"], ["TRXTUSD", undefined, "TRX", "TUSD"], ["XUSDUSDT", undefined, "XUSD", "USDT"],
];
for (const [sym, src, b, q] of cases) {
  const p = splitPair(sym, src);
  ok(`SQ-2 splitPair ${sym} → ${b}/${q}`, p.base === b && p.quote === q, JSON.stringify(p));
}
ok("SQ-2 PERP on a spot source is not a USDC perp", splitPair("BTCPERP", "binance").quote !== "USDC");
rememberPairs("binance", [["PUMPU", { base: "PUMP", quote: "U" }]]);
ok("SQ-2 the short 'U' quote is recognised from venue metadata only", splitPair("PUMPU", "binance").quote === "U" && splitPair("PUMPU").quote === "");
forgetPairsForTests();
ok("SQ-2 user input with a quote → base", baseFromInput("btc/usdc") === "BTC" && baseFromInput("ETH-FDUSD") === "ETH" && baseFromInput("SOL") === "SOL" && baseFromInput("DAI") === "DAI");
ok("SQ-2 baseOf", baseOf("BTCFDUSD") === "BTC" && baseOf("ETHPERP", "bybit-perp") === "ETH");

/* ---- SQ-6 risk clusters ---- */
ok("SQ-6 risk baseOf(BTCFDUSD) = BTC (v2.6 gave BTCFD)", riskBaseOf("BTCFDUSD") === "BTC");
ok("SQ-6 BTCFDUSD sits in the BTC/ETH majors cluster", clusterOf("crypto", "BTCFDUSD") === clusterOf("crypto", "BTCUSDT"));
ok("SQ-6 ETHPERP (USDC perp) → ETH", riskBaseOf("ETHPERP") === "ETH");

/* ---- classification of non-USDT pairs ---- */
ok("classify: BTCUSDC = crypto", classifySymbol("binance", "BTCUSDC") === "crypto");
ok("classify: PAXGUSDC = commodity (USDT twin)", classifySymbol("binance", "PAXGUSDC") === "commodity");
ok("classify: FDUSDUSDC excluded (stable on stable)", classifySymbol("binance", "FDUSDUSDC") === "excluded");
ok("classify: EURIUSDC = fx", classifySymbol("binance", "EURIUSDC") === "fx");
ok("classify: BTCPERP on bybit-perp = crypto", classifySymbol("bybit-perp", "BTCPERP") === "crypto");
ok("classify: USDT pairs unchanged", classifySymbol("binance", "USDCUSDT") === "excluded" && classifySymbol("binance", "PAXGUSDT") === "commodity");

/* ---- modes ---- */
ok("modes: Binance offers USDT…EURI + Best", JSON.stringify(quoteModesFor("binance")) === JSON.stringify(["USDT", "USDC", "FDUSD", "USD1", "U", "EURI", BEST]));
ok("modes: perps offer USDT/USDC/Best", JSON.stringify(quoteModesFor("bybit-perp")) === JSON.stringify(["USDT", "USDC", BEST]));
ok("modes: Coins.ph is PHP only", JSON.stringify(quoteModesFor("coinsph")) === JSON.stringify(["PHP"]) && normalizeQuoteMode("coinsph", "USDC") === "PHP");
ok("modes: unknown/unsupported → USDT", normalizeQuoteMode("binance", "XYZ") === "USDT" && normalizeQuoteMode("bitget-perp", "FDUSD") === "USDT");
ok("modes: EUR stablecoin scan prices in EUR", priceCurrencyOfQuote("binance", "EURI") === "EUR" && priceCurrencyOfQuote("binance", BEST) === "USD");

/* ---- SQ-4 Best with hysteresis ---- */
resetBestPicksForTests();
const rowsA = [
  { symbol: "BTCUSDT", base: "BTC", quote: "USDT", qvUsd: 100 }, { symbol: "BTCUSDC", base: "BTC", quote: "USDC", qvUsd: 110 },
  { symbol: "SOLEURI", base: "SOL", quote: "EURI", qvUsd: 999 }, { symbol: "SOLUSDT", base: "SOL", quote: "USDT", qvUsd: 10 },
];
let pick = selectPairs("binance", rowsA, BEST).map((r) => r.symbol).sort();
ok("SQ-4 Best picks the deepest USD-pegged pair (never EUR)", JSON.stringify(pick) === JSON.stringify(["BTCUSDC", "SOLUSDT"]), pick.join());
const rowsB = rowsA.map((r) => (r.symbol === "BTCUSDT" ? { ...r, qvUsd: 130 } : r)); // USDT now 18 % deeper: below 25 %
pick = selectPairs("binance", rowsB, BEST).map((r) => r.symbol);
ok("SQ-4 hysteresis keeps the previous pick under +25 %", pick.includes("BTCUSDC"), pick.join());
const rowsC = rowsA.map((r) => (r.symbol === "BTCUSDT" ? { ...r, qvUsd: 140 } : r)); // 27 % deeper
pick = selectPairs("binance", rowsC, BEST).map((r) => r.symbol);
ok("SQ-4 switches when another quote is ≥ 25 % deeper", pick.includes("BTCUSDT"), pick.join());
ok("SQ-4 single-quote mode keeps only that quote", selectPairs("binance", rowsA, "USDC").every((r) => r.quote === "USDC"));

/* ---- SQ-7 depeg tiers ---- */
ok("SQ-7 depeg tiers 0.5 / 1 / 2 %", depegLevel(0.4) === null && depegLevel(-0.5) === "watch" && depegLevel(1.2) === "warning" && depegLevel(-9) === "severe" && depegLevel(NaN) === null);

/* ---- venue fixtures ---- */
const now = Date.now();
const H = 3_600_000;
const klineRows = (n = 300) => Array.from({ length: n }, (_, i) => {
  const t = Math.floor(now / H) * H - (n - i) * H;
  const p = 100 + Math.sin(i / 7) * 3 + i * 0.01;
  return [t, String(p), String(p + 1), String(p - 1), String(p + 0.2), "1000", t + H - 1, "100000", 10, "500", "50000"];
});
const binanceTickers = [
  { symbol: "BTCUSDT", openPrice: "100", lastPrice: "101", quoteVolume: "9000000000" },
  { symbol: "ETHUSDT", openPrice: "10", lastPrice: "10", quoteVolume: "5000000000" },
  { symbol: "BTCUSDC", openPrice: "100", lastPrice: "101", quoteVolume: "2000000000" },
  { symbol: "ETHUSDC", openPrice: "10", lastPrice: "10", quoteVolume: "6000000000" },
  { symbol: "BTCFDUSD", openPrice: "100", lastPrice: "101", quoteVolume: "1000000000" },
  { symbol: "USDCUSDT", openPrice: "1", lastPrice: "0.9990", quoteVolume: "3000000000" },
  { symbol: "FDUSDUSDT", openPrice: "1", lastPrice: "0.9850", quoteVolume: "300000000" },
  { symbol: "SOLEURI", openPrice: "100", lastPrice: "100", quoteVolume: "1000000" },
  { symbol: "EURIUSDT", openPrice: "1.12", lastPrice: "1.12", quoteVolume: "50000000" },
];
const binanceInfo = { symbols: binanceTickers.map((t) => ({ symbol: t.symbol, status: "TRADING", ...splitPair(t.symbol) })).map((x) => ({ symbol: x.symbol, status: x.status, baseAsset: x.base, quoteAsset: x.quote })) };
const calls = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  calls.push(u);
  if (u.includes("/api/v3/ticker/24hr")) return json(binanceTickers);
  if (u.includes("/api/v3/exchangeInfo")) return json(binanceInfo);
  if (u.includes("/api/v3/klines")) return json(klineRows());
  if (u.includes("bybit.com/v5/market/instruments-info")) {
    const linear = u.includes("category=linear");
    return json({ retCode: 0, result: { list: linear
      ? [{ symbol: "BTCUSDT", status: "Trading", baseCoin: "BTC", quoteCoin: "USDT", settleCoin: "USDT", symbolType: "" },
         { symbol: "BTCPERP", status: "Trading", baseCoin: "BTC", quoteCoin: "USD", settleCoin: "USDC", symbolType: "" }]
      : [], nextPageCursor: "" } });
  }
  if (u.includes("bybit.com/v5/market/tickers")) return json({ retCode: 0, result: { list: [
    { symbol: "BTCUSDT", lastPrice: "101", price24hPcnt: "0.01", turnover24h: "5000000000", markPrice: "101", indexPrice: "101" },
    { symbol: "BTCPERP", lastPrice: "101", price24hPcnt: "0.01", turnover24h: "800000000", markPrice: "101", indexPrice: "101" },
  ] } });
  if (u.includes("bybit.com/v5/market/kline")) return json({ retCode: 0, result: { list: klineRows().map((r) => r.slice(0, 7)).reverse() } });
  if (u.includes("bitget.com/api/v2/mix/market/tickers")) {
    const usdc = u.includes("USDC-FUTURES");
    return json({ code: "00000", data: [usdc
      ? { symbol: "BTCPERP", lastPr: "101", change24h: "0.01", quoteVolume: "69606250", usdtVolume: "69606250", markPrice: "101", indexPrice: "101" }
      : { symbol: "BTCUSDT", lastPr: "101", change24h: "0.01", quoteVolume: "900000000", usdtVolume: "900000000", markPrice: "101", indexPrice: "101" }] });
  }
  if (u.includes("bitget.com/api/v2/mix/market/candles")) return json({ code: "00000", data: klineRows().map((r) => r.slice(0, 7)) });
  return json({ error: "unexpected " + u }, 404);
};

resetRateLimitForTests();
/* SQ-1: USDT mode — v2.6 behaviour: no metadata call, USDT pairs by raw volume, raw quoteVolume strings. */
calls.length = 0;
let r = await fetchDirectMarketData("1h", "binance", [], 10, undefined, () => 200, "crypto");
ok("SQ-1 USDT mode makes no exchangeInfo request", !calls.some((u) => u.includes("exchangeInfo")), calls.join(" "));
ok("SQ-1 USDT mode returns only USDT pairs, by volume", JSON.stringify(r.tickers.map((t) => t.symbol)) === JSON.stringify(["BTCUSDT", "ETHUSDT"]), r.tickers.map((t) => t.symbol).join());
ok("SQ-1 USDT mode keeps the raw quoteVolume strings", r.tickers[0].quoteVolume === "9000000000");
ok("SQ-1 USDT mode reports quote USDT and USD prices", r.quote === "USDT" && r.priceCurrency === "USD" && r.quoteBySymbol?.BTCUSDT === "USDT");

/* SQ-3: USDC mode — only USDC pairs, volume converted at USDCUSDT (0.999). */
calls.length = 0;
r = await fetchDirectMarketData("1h", "binance", [], 10, undefined, () => 200, "crypto", "USDC");
ok("SQ-3 USDC mode reads venue metadata once", calls.filter((u) => u.includes("exchangeInfo")).length === 1);
ok("SQ-3 USDC mode returns only USDC pairs", r.tickers.every((t) => t.symbol.endsWith("USDC")) && r.tickers.length === 2, r.tickers.map((t) => t.symbol).join());
ok("SQ-3 ranking by USD volume (ETHUSDC first)", r.tickers[0].symbol === "ETHUSDC");
ok("SQ-3 volume converted at USDCUSDT", Math.abs(parseFloat(r.tickers[0].quoteVolume) - 6e9 * 0.999) < 1, r.tickers[0].quoteVolume);
ok("SQ-3 candles fetched for USDC pairs", Object.keys(r.klines).sort().join() === "BTCUSDC,ETHUSDC");

/* SQ-4 on the venue: Best = deepest USD pair per coin; FDUSD depeg reported. */
resetBestPicksForTests();
r = await fetchDirectMarketData("1h", "binance", [], 10, undefined, () => 200, "crypto", BEST);
const syms = r.tickers.map((t) => t.symbol).sort().join();
ok("SQ-4 Best on Binance → BTCUSDT + ETHUSDC", syms === "BTCUSDT,ETHUSDC", syms);
ok("SQ-4 Best records each row's quote", r.quoteBySymbol?.ETHUSDC === "USDC" && r.quoteBySymbol?.BTCUSDT === "USDT");
ok("SQ-7 FDUSD at 0.985 → warning in this Best scan", r.depeg?.some((d) => d.coin === "FDUSD" && d.level === "warning"), JSON.stringify(r.depeg));
ok("SQ-7 USDC at 0.999 is not flagged", !r.depeg?.some((d) => d.coin === "USDC"));

/* EUR stablecoin scan prices in EUR, volume via EURIUSDT. */
r = await fetchDirectMarketData("1h", "binance", [], 10, undefined, () => 200, "all", "EURI");
ok("EURI mode: SOLEURI priced in EUR", r.priceCurrency === "EUR" && r.tickers.some((t) => t.symbol === "SOLEURI"));
ok("EURI mode: volume valued with EURIUSDT", Math.abs(parseFloat(r.tickers.find((t) => t.symbol === "SOLEURI")?.quoteVolume ?? "0") - 1.12e6) < 1);

/* Watch list with a quote suffix finds the base. */
r = await fetchDirectMarketData("1h", "binance", ["eth/usdc"], 10, undefined, () => 200, "crypto", "USDC");
ok("watch field 'eth/usdc' in USDC mode → ETHUSDC", r.tickers.length === 1 && r.tickers[0].symbol === "ETHUSDC");

/* SQ-5: USDC perps. */
r = await fetchDirectMarketData("1h", "bybit-perp", [], 10, undefined, () => 200, "crypto", "USDC");
ok("SQ-5 Bybit linear USDC → BTCPERP only", r.tickers.map((t) => t.symbol).join() === "BTCPERP", r.tickers.map((t) => t.symbol).join());
r = await fetchDirectMarketData("1h", "bybit-perp", [], 10, undefined, () => 200, "crypto");
ok("SQ-5 Bybit linear USDT mode excludes BTCPERP", r.tickers.map((t) => t.symbol).join() === "BTCUSDT");
calls.length = 0;
r = await fetchDirectMarketData("1h", "bitget-perp", [], 10, undefined, () => 200, "crypto", "USDC");
ok("SQ-5 Bitget USDC-FUTURES tickers", calls.some((u) => u.includes("productType=USDC-FUTURES")) && r.tickers.map((t) => t.symbol).join() === "BTCPERP");
ok("SQ-5 Bitget USDC perp candles use USDC-FUTURES", calls.some((u) => u.includes("candles?symbol=BTCPERP") && u.includes("productType=USDC-FUTURES")));
ok("SQ-5 Bitget USDC perp volume not converted twice", r.tickers[0].quoteVolume === "69606250");
ok("SQ-5 bitgetProductOf", bitgetProductOf("BTCPERP") === "USDC-FUTURES" && bitgetProductOf("BTCUSDT") === "USDT-FUTURES");

globalThis.fetch = realFetch;
console.log(`\nQuote suite: ${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
