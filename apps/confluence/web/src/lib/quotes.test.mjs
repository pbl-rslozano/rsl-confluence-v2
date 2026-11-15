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
import {
  fetchDirectMarketData, resetRateLimitForTests, bitgetProductOf, fetchHistory, passesLiquidityFloor, paceFromUsedWeight, binancePaceMs,
  DEFAULT_LIQUIDITY_FLOOR_USD, usedWeightReadable, rateLimitCooldown,
} from "./market-client.ts";
import { thinNote, scoreSeries } from "./scan-pipeline.ts";
import { deltaPlan, mergeDelta } from "./history-store.ts";
import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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


/* review v2.7 fixes */
ok("v2.7 #6 typed DOTUSD / DOT/USD → DOT (not DO)", baseFromInput("DOTUSD") === "DOT" && baseFromInput("dot/usd") === "DOT" && baseFromInput("BTCUSDT") === "BTC");
rememberPairs("binance", [["BTCU", { base: "BTC", quote: "U" }]]);
ok("v2.7 #11 paper base uses the venue: BTCU on Binance = BTC cluster", riskBaseOf("BTCU", "binance") === "BTC" && clusterOf("crypto", "BTCU", "binance") === clusterOf("crypto", "BTCUSDT"));
forgetPairsForTests();
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

r = await fetchDirectMarketData("1h", "binance", [], 10, undefined, () => 200, "crypto");
ok("v2.7 #8 USDT scans still report USDC/USDT only when off by ≥ 0.5 % (0.999 → none)", !(r.depeg ?? []).length);
binanceTickers.find((t) => t.symbol === "USDCUSDT").lastPrice = "0.9920";
r = await fetchDirectMarketData("1h", "binance", [], 10, undefined, () => 200, "crypto");
ok("v2.7 #8 USDC/USDT at 0.992 → watch reading in a USDT scan", r.depeg?.[0]?.coin === "USDC" && r.depeg?.[0]?.reference === "USDT" && r.depeg?.[0]?.level === "watch", JSON.stringify(r.depeg));
r = await fetchDirectMarketData("1h", "bitget-perp", [], 10, undefined, () => 200, "crypto", "USDC");
ok("v2.7 #8 USDC perps are not marked ≈ row by row", !(r.approxVolume ?? []).length);

/* ===== v2.8 (WP19) volume hygiene: Binance quote volume and trade count, crypto liquidity floor, used-weight pacing ===== */
r = await fetchDirectMarketData("1h", "binance", [], 10, undefined, () => 200, "crypto");
const k0 = r.klines.BTCUSDT?.[0];
ok("WP19 binance parse keeps r[7] quote volume as qv and r[8] trade count as trades", k0?.qv === 100000 && k0?.trades === 10 && k0?.takerBuy === 500, JSON.stringify(k0));
const hist = await fetchHistory("binance", "BTCUSDT", "1h", 200);
ok("WP19 binance history rows keep r[7]/r[8] too", hist.klines[0]?.qv === 100000 && hist.klines[0]?.trades === 10, JSON.stringify(hist.klines[0]));

ok("WP19 default liquidity floor is US$1,000,000", DEFAULT_LIQUIDITY_FLOOR_USD === 1_000_000);
ok("WP19 passesLiquidityFloor: 900k under a 1M floor fails, 1M passes", !passesLiquidityFloor(900_000, 1_000_000, "binance") && passesLiquidityFloor(1_000_000, 1_000_000, "binance"));
ok("WP19 passesLiquidityFloor: floor 0 turns it off", passesLiquidityFloor(1, 0, "binance") && passesLiquidityFloor(NaN, 0, "bybit-spot"));
ok("WP19 passesLiquidityFloor: unknown USD volume (NaN) never clears an active floor", !passesLiquidityFloor(NaN, 1_000_000, "bitget"));
ok("WP19 passesLiquidityFloor: Coins.ph peso pairs keep their own thin-pair rule", passesLiquidityFloor(1, 1_000_000, "coinsph"));
// R21: the floor is measured on qvUsd only — three inputs (volume, floor, source), no rate table, no display currency.
ok("WP19 floor never reads display FX: passesLiquidityFloor takes exactly (qvUsd, floorUsd, source)", passesLiquidityFloor.length === 3);
const mcSrc = readFileSync(join(process.cwd(), "src", "lib", "market-client.ts"), "utf8");
ok("WP19 floor never reads display FX: market-client imports no fx-rates module", !/from\s+["'][^"']*fx-rates/.test(mcSrc));

const thinTickers = [
  { symbol: "BTCUSDT", openPrice: "100", lastPrice: "101", quoteVolume: "9000000000" },
  { symbol: "THINUSDT", openPrice: "1", lastPrice: "1", quoteVolume: "900000" },
  { symbol: "PAXGUSDT", openPrice: "1", lastPrice: "1", quoteVolume: "900000" },
  { symbol: "ETHUSDC", openPrice: "10", lastPrice: "10", quoteVolume: "1000500" },
  { symbol: "USDCUSDT", openPrice: "1", lastPrice: "0.9990", quoteVolume: "3000000000" },
];
const thinInfo = { symbols: thinTickers.map((t) => ({ symbol: t.symbol, status: "TRADING", baseAsset: splitPair(t.symbol).base, quoteAsset: splitPair(t.symbol).quote })) };
let weightHeader = null;
const binanceJson = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...(weightHeader ? { "x-mbx-used-weight-1m": weightHeader } : {}) } });
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/api/v3/ticker/24hr")) return binanceJson(thinTickers);
  if (u.includes("/api/v3/exchangeInfo")) return binanceJson(thinInfo);
  if (u.includes("/api/v3/klines")) return binanceJson(klineRows());
  return json({ error: "unexpected " + u }, 404);
};
resetRateLimitForTests();
r = await fetchDirectMarketData("1h", "binance", [], 10, undefined, () => 200, "all", "USDT", 1_000_000);
let syms2 = r.tickers.map((t) => t.symbol);
ok("WP19 floor 1,000,000 drops a 900k qvUsd crypto pair", !syms2.includes("THINUSDT") && syms2.includes("BTCUSDT"), syms2.join());
ok("WP19 the dropped pair is listed with a note (thinSymbols + floor)", r.thinSymbols?.includes("THINUSDT") && r.thinFloorUsd === 1_000_000, JSON.stringify([r.thinSymbols, r.thinFloorUsd]));
ok("WP19 the floor is for crypto only: a 900k commodity pair keeps the 250k non-crypto floor", syms2.includes("PAXGUSDT"), syms2.join());
ok("WP19 no candles are fetched for a thin pair", !("THINUSDT" in r.klines));
const note = thinNote(r.thinSymbols, r.thinFloorUsd);
ok("WP19 thin note: count and floor label ($1M)", note?.n === 1 && note?.floor === "$1M", JSON.stringify(note));
ok("WP19 thin note: Coins.ph $250k label, nothing to say without thin pairs", thinNote(["A", "B"], 250_000)?.floor === "$250k" && thinNote([], 1_000_000) === null);
r = await fetchDirectMarketData("1h", "binance", [], 10, undefined, () => 200, "all", "USDT", 0);
syms2 = r.tickers.map((t) => t.symbol);
ok("WP19 floor 0 disables the liquidity floor", syms2.includes("THINUSDT") && !(r.thinSymbols ?? []).length, syms2.join());
r = await fetchDirectMarketData("1h", "binance", [], 10, undefined, () => 200, "crypto", "USDC", 1_000_000);
ok("WP19 floor is measured on qvUsd (USDC quote at its own venue price 0.999): 1,000,500 USDC = 999,500 USD < 1M → dropped",
  !r.tickers.some((t) => t.symbol === "ETHUSDC") && r.thinSymbols?.includes("ETHUSDC"), JSON.stringify([r.tickers.map((t) => t.symbol), r.thinSymbols]));
r = await fetchDirectMarketData("1h", "binance", [], 10, undefined, () => 200, "crypto", "USDT");
ok("WP19 fetchDirectMarketData without a floor argument keeps every pair (callers pass the setting)", r.tickers.some((t) => t.symbol === "THINUSDT"));

/* Used-weight pacing — Node paths only. */
ok("WP19 paceFromUsedWeight('5000') > 0 (above 80% of 6,000)", paceFromUsedWeight("5000") > 0, String(paceFromUsedWeight("5000")));
ok("WP19 paceFromUsedWeight('100') === 0", paceFromUsedWeight("100") === 0);
ok("WP19 paceFromUsedWeight(null) === 0 (header not readable)", paceFromUsedWeight(null) === 0);
ok("WP19 paceFromUsedWeight: 4800 (exactly 80%) = 0; at or over the limit = 60 s; junk = 0",
  paceFromUsedWeight("4800") === 0 && paceFromUsedWeight("6000") === 60_000 && paceFromUsedWeight("9999") === 60_000 && paceFromUsedWeight("abc") === 0 && paceFromUsedWeight("") === 0);
ok("WP19 paceFromUsedWeight honours a custom limit", paceFromUsedWeight("900", 1000) > 0 && paceFromUsedWeight("700", 1000) === 0);
const archive = await import(pathToFileURL(join(process.cwd(), "..", "..", "..", "tools", "fetch-binance-archive.mjs")).href);
ok("WP19 the archive CLI paces with the same rule", ["100", "4800", "4830", "5000", "6000", null, "x"].every((h) => archive.paceFromUsedWeight(h) === paceFromUsedWeight(h)));

/* CORS probe: in Node (recorder, replay CLI, server route) the header is read; in a page/WebView it is not. */
ok("WP19 Node path reads the used-weight header", usedWeightReadable() === true);
resetRateLimitForTests();
weightHeader = "5900"; // ticker request only (no listed asset matches): nothing waits inside this test
await fetchDirectMarketData("1h", "binance", ["ZZZ"], 1, undefined, () => 200, "crypto");
ok("WP19 Node: a 5,900 used-weight reading pauses the next Binance request", binancePaceMs() > 50_000, String(binancePaceMs()));
resetRateLimitForTests();
ok("WP19 resetRateLimitForTests clears the pause", binancePaceMs() === 0);
weightHeader = "4830"; // 30 of 1,200 over the threshold → 1.5 s
await fetchDirectMarketData("1h", "binance", ["ZZZ"], 1, undefined, () => 200, "crypto");
weightHeader = null;
const t0 = Date.now();
await fetchDirectMarketData("1h", "binance", ["BTC"], 1, undefined, () => 200, "crypto");
ok("WP19 Node: the next request waits for the pause (≈1.5 s)", Date.now() - t0 >= 1_400, String(Date.now() - t0));
resetRateLimitForTests();
// WebView / browser: cross-origin fetch hides X-MBX-USED-WEIGHT-1M (not CORS-safelisted, not exposed) — the stub
// omits it, as Response.headers does there — so the app keeps its fixed pacing (and the 429/418 halt).
globalThis.window = { location: { protocol: "https:" } };
try {
  ok("WP19 CORS probe: the header is not readable in an app build", usedWeightReadable() === false);
  weightHeader = null;
  await fetchDirectMarketData("1h", "binance", ["BTC"], 1, undefined, () => 200, "crypto");
  ok("WP19 CORS probe: hidden header → fixed pacing (no used-weight pause)", binancePaceMs() === 0);
  weightHeader = "5900"; // even a stub that exposes it is ignored in the page path
  await fetchDirectMarketData("1h", "binance", ["BTC"], 1, undefined, () => 200, "crypto");
  ok("WP19 CORS probe: app builds never pace on the header, fixed pacing stays", binancePaceMs() === 0);
} finally {
  delete globalThis.window;
  weightHeader = null;
  resetRateLimitForTests();
}

/* ===== v2.8 (WP27) smooth loading: delta fetch, priority tiers, cancel, 429 halt across tiers ===== */
const DH = 3_600_000;
const dNow = Date.now();
const inProgress = Math.floor(dNow / DH) * DH;
// Binance rows, oldest first, the last one still building (as the venue returns them).
const fixtureRows = (count) => Array.from({ length: count }, (_, i) => {
  const t = inProgress - (count - 1 - i) * DH;
  const p = 50 + Math.cos(i / 9) * 4 + i * 0.02;
  return [t, String(p), String(p + 1.5), String(p - 1.5), String(p + 0.3), String(500 + (i % 17)), t + DH - 1, String(1000 + i), 7, "250", "0"];
});
const FULL = fixtureRows(1004); // 1,003 closed bars + the one in progress
// Parsed the way fetchBinanceKlines parses a row.
const parseRow = (r) => ({ time: Number(r[0]), open: parseFloat(r[1]), high: parseFloat(r[2]), low: parseFloat(r[3]), close: parseFloat(r[4]), volume: parseFloat(r[5]), takerBuy: parseFloat(r[9]), qv: Number(r[7]), trades: Number(r[8]) });
const EXPECTED = FULL.slice(0, -1).map(parseRow); // the full closed series
const STORED = EXPECTED.slice(0, 1000);            // on-device history: 1,000 bars, 3 behind
const scoreOf = (k) => scoreSeries(k, { intervalMs: DH, volumeAvailable: true, assetClass: "crypto" });
const sameScore = (a, b) => isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));

let dTickers = [{ symbol: "BTCUSDT", openPrice: "50", lastPrice: "51", quoteVolume: "9000000000" }];
let revise = null; // (row) => row, applied to kline rows served
const klineReqs = [];
let fail429 = null;
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.pathname.endsWith("/ticker/24hr")) return json(dTickers);
  if (u.pathname.endsWith("/klines")) {
    const sym = u.searchParams.get("symbol");
    const limit = Number(u.searchParams.get("limit"));
    klineReqs.push({ sym, limit });
    if (fail429 === sym) return new Response(JSON.stringify({ code: -1003 }), { status: 429, headers: { "retry-after": "45" } });
    const rows = FULL.slice(-limit);
    return json(revise ? rows.map(revise) : rows);
  }
  return json({ error: "unexpected " + u }, 404);
};
resetRateLimitForTests();

/* deltaPlan */
const plan = deltaPlan(STORED, DH, dNow);
ok("WP27 deltaPlan: 3 bars missing → limit 4 (3 + one overlap bar), overlap = newest stored bar",
  plan?.limit === 4 && plan?.overlapOpenTime === STORED.at(-1).time, JSON.stringify(plan));
ok("WP27 deltaPlan: up to date → limit 1 (overlap only)", deltaPlan(EXPECTED, DH, dNow)?.limit === 1, JSON.stringify(deltaPlan(EXPECTED, DH, dNow)));
const gapped = [...STORED.slice(0, 500), ...STORED.slice(501)];
ok("WP27 gap in stored history → deltaPlan null", deltaPlan([...EXPECTED.slice(0, 600), ...EXPECTED.slice(601)], DH, dNow) === null && deltaPlan(gapped, DH, dNow) === null);
ok("WP27 shorter than ENGINE_BARS → deltaPlan null", deltaPlan(STORED.slice(1), DH, dNow) === null && deltaPlan([], DH, dNow) === null);
ok("WP27 an old gap before the newest 1,000 contiguous bars does not block the delta",
  deltaPlan([...EXPECTED.slice(0, 2), ...EXPECTED.slice(3)], DH, dNow)?.limit === 1);
ok("WP27 stored history more than 998 bars behind → full window (deltaPlan null)", deltaPlan(STORED, DH, dNow + 1_000 * DH) === null);

/* mergeDelta (pure) */
const freshTail = FULL.slice(-5).slice(0, -1).map(parseRow); // overlap + 3 new (closed)
const merged = mergeDelta(STORED, freshTail, plan.overlapOpenTime);
ok("WP27 delta-fetched series equal full-fetched series (mergeDelta)", isDeepStrictEqual(merged, EXPECTED), `${merged?.length} vs ${EXPECTED.length}`);
ok("WP27 delta-fetched series equal full-fetched series (scoreSeries outputs identical)", sameScore(scoreOf(merged), scoreOf(EXPECTED)));
const revisedTail = freshTail.map((b) => (b.time === plan.overlapOpenTime ? { ...b, close: b.close + 0.5 } : b));
ok("WP27 mergeDelta: overlap bar differs → null", mergeDelta(STORED, revisedTail, plan.overlapOpenTime) === null);
ok("WP27 mergeDelta: overlap bar missing from the fresh bars → null", mergeDelta(STORED, freshTail.slice(1), plan.overlapOpenTime) === null);

/* The fetch layer: delta request, merge, fallback. */
let discarded = [];
const hooks = (stored) => ({
  delta: (s) => deltaPlan(stored, DH, Date.now()),
  mergeDelta: (s, fresh, ov) => { const m = mergeDelta(stored, fresh, ov); if (!m) discarded.push(s); return m; },
});
klineReqs.length = 0;
const seen = [];
let tickersFirst = -2;
r = await fetchDirectMarketData("1h", "binance", [], 10, undefined, () => 1000, "crypto", "USDT", 0, {
  ...hooks(STORED), onSeries: (s, k) => seen.push([s, k.length]), onTickers: (list) => { tickersFirst = list.length === 1 ? klineReqs.length : -1; },
});
ok("WP27 delta request asks only the missing bars + overlap + the bar in progress (limit=5)", klineReqs.length === 1 && klineReqs[0].limit === 5, JSON.stringify(klineReqs));
ok("WP27 delta-fetched series equal full-fetched series (fetch layer)", isDeepStrictEqual(r.klines.BTCUSDT, EXPECTED), String(r.klines.BTCUSDT?.length));
ok("WP27 onTickers hands the chosen list over before any candle request", tickersFirst === 0, String(tickersFirst));
ok("WP27 onSeries hands each series over as soon as it is fetched", seen.length === 1 && seen[0][0] === "BTCUSDT" && seen[0][1] === EXPECTED.length, JSON.stringify(seen));
klineReqs.length = 0;
r = await fetchDirectMarketData("1h", "binance", [], 10, undefined, () => 1000, "crypto", "USDT", 0, { ...hooks(EXPECTED) });
ok("WP27 up-to-date history: delta request limit=2 (clampLimit minimum 2 with delta)", klineReqs[0]?.limit === 2, JSON.stringify(klineReqs));

// Review focus 3: the exchange revised the overlap bar → stored series discarded, full window fetched.
const fullOnly = await fetchDirectMarketData("1h", "binance", [], 10, undefined, () => 1000, "crypto", "USDT", 0);
const revisedStored = STORED.map((b, i) => (i === STORED.length - 1 ? { ...b, close: b.close + 0.5 } : b));
klineReqs.length = 0; discarded = [];
r = await fetchDirectMarketData("1h", "binance", [], 10, undefined, () => 200, "crypto", "USDT", 0, { ...hooks(revisedStored) });
ok("WP27 delta overlap mismatch falls back to full window (second request limit=1000, not the 200-bar warm start)",
  JSON.stringify(klineReqs.map((x) => x.limit)) === "[5,1000]", JSON.stringify(klineReqs));
ok("WP27 delta overlap mismatch falls back to full window (series = a plain full fetch)", isDeepStrictEqual(r.klines.BTCUSDT, fullOnly.klines.BTCUSDT));
ok("WP27 delta overlap mismatch falls back to full window (scores equal a full fetch)", sameScore(scoreOf(r.klines.BTCUSDT), scoreOf(fullOnly.klines.BTCUSDT)));
ok("WP27 delta overlap mismatch: the caller is told to discard the stored series", JSON.stringify(discarded) === '["BTCUSDT"]');
klineReqs.length = 0; discarded = [];
r = await fetchDirectMarketData("1h", "binance", [], 10, undefined, () => 200, "crypto", "USDT", 0, { ...hooks(gapped) });
ok("WP27 gap in stored history → no delta request (warm-start/full path only)", JSON.stringify(klineReqs.map((x) => x.limit)) === "[200]", JSON.stringify(klineReqs));
klineReqs.length = 0;
await fetchDirectMarketData("2d", "binance", [], 10, undefined, () => 200, "crypto", "USDT", 0, { delta: () => ({ limit: 3, overlapOpenTime: 0 }), mergeDelta: () => null });
ok("WP27 synthetic (aggregated) intervals never use delta requests", klineReqs.length === 1 && klineReqs[0].limit === 1000, JSON.stringify(klineReqs));

/* Priority tiers, cancel, 429 halt. */
const many = Array.from({ length: 40 }, (_, i) => `C${String(i).padStart(2, "0")}USDT`);
dTickers = many.map((symbol, i) => ({ symbol, openPrice: "50", lastPrice: "51", quoteVolume: String(9e9 - i * 1e6) }));
klineReqs.length = 0;
await fetchDirectMarketData("1h", "binance", [], 40, undefined, () => 200, "crypto", "USDT", 0, { priority: ["C33USDT", "C07USDT"] });
ok("WP27 priority: the watched pairs are fetched first", klineReqs[0]?.sym === "C33USDT" && klineReqs[1]?.sym === "C07USDT", klineReqs.slice(0, 3).map((x) => x.sym).join());
ok("WP27 priority: then the rest by volume, every pair once", klineReqs[2]?.sym === "C00USDT" && new Set(klineReqs.map((x) => x.sym)).size === 40 && klineReqs.length === 40);

const ac = new AbortController();
let after = 0;
klineReqs.length = 0;
const aborted = await fetchDirectMarketData("1h", "binance", [], 40, ac.signal, () => 200, "crypto", "USDT", 0, {
  onSeries: () => { after++; if (after === 2) ac.abort(); },
}).then(() => "resolved", (e) => e?.name);
ok("WP27 switching source cancels: the old scan rejects with AbortError", aborted === "AbortError", String(aborted));
ok("WP27 switching source cancels: no onSeries after the abort, no further requests", after === 2 && klineReqs.length === 6, `${after} series, ${klineReqs.length} requests`);

resetRateLimitForTests();
klineReqs.length = 0;
fail429 = "C12USDT"; // tier 2 (top 10, then 20 per tier)
r = await fetchDirectMarketData("1h", "binance", [], 40, undefined, () => 200, "crypto", "USDT", 0, { onSeries: () => {} });
const reqSyms = klineReqs.map((x) => x.sym);
ok("WP27 429 halts all tiers: no request for tier 3+ after a 429 in tier 2", !reqSyms.some((s) => many.indexOf(s) >= 30) && !reqSyms.includes("C16USDT"), reqSyms.join());
ok("WP27 429 halts all tiers: cooldown set, scan flagged rate-limited", rateLimitCooldown("binance") > 40_000 && (r.rateLimitedUntil ?? 0) > Date.now(), String(rateLimitCooldown("binance")));
ok("WP27 429 halts all tiers: skipped pairs reported, fetched ones kept",
  r.errors.filter((e) => e.reason === "RATE_LIMIT").length === 40 - 16 + 1 && Object.keys(r.klines).length === 15, `${r.errors.length} errors, ${Object.keys(r.klines).length} series`);
const blocked = await fetchDirectMarketData("1h", "binance", [], 40, undefined, () => 200, "crypto", "USDT", 0).then(() => "ran", (e) => e?.name);
ok("WP27 429 halts all tiers: the next scan is refused while cooling down", blocked === "RateLimitError", String(blocked));
fail429 = null;
resetRateLimitForTests();
globalThis.fetch = realFetch;
console.log(`\nQuote suite: ${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
