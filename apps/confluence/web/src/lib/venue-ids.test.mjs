// Venue id mapping + quote rules for OKX, Coinbase, Upbit — v2.8 Step 2 (WP26, Task 1).
// Run: npm run test:venues   (node scripts/run-engine-tests.mjs venue-ids.test.mjs)
import { venueSymbol, venueIdOf, NEW_SOURCES } from "./venue-ids.ts";
import { priceCurrencyOfQuote, normalizeQuoteMode, isPerpSource, VENUE_QUOTES, splitPair, quoteModesFor } from "./quotes.ts";
import { venueOf, priceCurrencyOf } from "./market-client.ts";
import { classifySymbol } from "./asset-classes.ts";

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} ${extra}`); }
};

console.log("venue ids -> app symbols");
const cases = [
  ["coinbase", "BTC-USD", "BTCUSD"],
  ["upbit", "KRW-BTC", "BTCKRW"],
  ["upbit", "USDT-ETH", "ETHUSDT"],
  ["upbit", "BTC-SOL", "SOLBTC"],
  ["okx", "BTC-USDT", "BTCUSDT"],
  ["okx-perp", "BTC-USDT-SWAP", "BTCUSDT"],
];
for (const [s, id, sym] of cases) ok(`${s} ${id} -> ${sym}`, venueSymbol(s, id) === sym, String(venueSymbol(s, id)));
ok("okx-perp inverse swap is not offered", venueSymbol("okx-perp", "BTC-USD-SWAP") === null);
ok("coinbase A.B-USD fails the safe pattern", venueSymbol("coinbase", "A.B-USD") === null);
ok("garbage ids are null", venueSymbol("okx", "") === null && venueSymbol("upbit", "KRW") === null && venueSymbol("okx-perp", "BTC-USDT") === null);
for (const [s, id] of cases) ok(`round-trip ${s} ${id}`, venueIdOf(s, venueSymbol(s, id)) === id, String(venueIdOf(s, venueSymbol(s, id))));
ok("NEW_SOURCES", NEW_SOURCES.join() === "okx,okx-perp,coinbase,upbit");

console.log("price currency per quote");
ok("upbit KRW", priceCurrencyOfQuote("upbit", "KRW") === "KRW");
ok("upbit BTC", priceCurrencyOfQuote("upbit", "BTC") === "BTC");
ok("upbit USDT", priceCurrencyOfQuote("upbit", "USDT") === "USD");
ok("coinbase USD", priceCurrencyOfQuote("coinbase", "USD") === "USD");
ok("coinbase USDT", priceCurrencyOfQuote("coinbase", "USDT") === "USD");
ok("okx USDC", priceCurrencyOfQuote("okx", "USDC") === "USD");
ok("priceCurrencyOf wrapper", priceCurrencyOf("upbit", "BTC") === "BTC" && priceCurrencyOf("upbit", undefined) === "KRW" && priceCurrencyOf("coinsph") === "PHP");

console.log("quote rules");
ok("VENUE_QUOTES", VENUE_QUOTES.okx.join() === "USDT,USDC" && VENUE_QUOTES["okx-perp"].join() === "USDT" && VENUE_QUOTES.coinbase.join() === "USD,USDT" && VENUE_QUOTES.upbit.join() === "KRW,USDT,BTC");
ok("coinbase USDC -> USD", normalizeQuoteMode("coinbase", "USDC") === "USD");
ok("coinbase USDT stays", normalizeQuoteMode("coinbase", "USDT") === "USDT" && normalizeQuoteMode("coinbase", undefined) === "USD" && normalizeQuoteMode("coinbase", "BEST") === "USD");
ok("upbit default KRW", normalizeQuoteMode("upbit", undefined) === "KRW" && normalizeQuoteMode("upbit", "USDC") === "KRW" && normalizeQuoteMode("upbit", "BEST") === "KRW");
ok("upbit USDT / BTC stay", normalizeQuoteMode("upbit", "USDT") === "USDT" && normalizeQuoteMode("upbit", "btc") === "BTC");
ok("okx-perp always USDT", normalizeQuoteMode("okx-perp", "USDC") === "USDT" && normalizeQuoteMode("okx-perp", "BEST") === "USDT" && normalizeQuoteMode("okx-perp", "KRW") === "USDT");
ok("okx spot keeps USDC", normalizeQuoteMode("okx", "USDC") === "USDC" && normalizeQuoteMode("okx", "FDUSD") === "FDUSD");
ok("okx-perp is a perp source", isPerpSource("okx-perp") && !isPerpSource("okx"));
ok("quote menus", quoteModesFor("upbit").join() === "KRW,USDT,BTC" && quoteModesFor("coinbase").join() === "USD,USDT" && quoteModesFor("okx").join() === "USDT,USDC,BEST" && quoteModesFor("okx-perp").join() === "USDT");
ok("splitPair knows KRW and Upbit BTC quotes", splitPair("BTCKRW", "upbit").quote === "KRW" && splitPair("SOLBTC", "upbit").base === "SOL" && splitPair("BTCUSD", "coinbase").quote === "USD");

console.log("venue cooldown mapping");
ok("venueOf", venueOf("okx") === "okx" && venueOf("okx-perp") === "okx" && venueOf("coinbase") === "coinbase" && venueOf("upbit") === "upbit" && venueOf("bitget-perp") === "bitget" && venueOf("binance") === "binance");

console.log("asset classes");
ok("okx-perp FX/commodity perps use the perp lists", classifySymbol("okx-perp", "XAUUSDT") === "commodity");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
