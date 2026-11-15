// "View on [exchange]" links and the provider list — v2.8 Step 2 (WP26, Task 6).
// Run: npm run test:links   (node scripts/run-engine-tests.mjs exchange-links.test.mjs)
import { exchangeUrl } from "./exchange-links.ts";
import { PROVIDERS } from "./providers.ts";

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} ${extra}`); }
};

console.log("exchangeUrl patterns");
const cases = [
  ["binance", "BTCUSDT", "https://www.binance.com/en/trade/BTC_USDT?type=spot"],
  ["binance", "ETHFDUSD", "https://www.binance.com/en/trade/ETH_FDUSD?type=spot"],
  ["bybit-spot", "SOLUSDT", "https://www.bybit.com/en/trade/spot/SOL/USDT"],
  ["bybit-perp", "BTCUSDT", "https://www.bybit.com/trade/usdt/BTCUSDT"],
  ["bitget", "BTCUSDT", "https://www.bitget.com/spot/BTCUSDT"],
  ["bitget-perp", "BTCUSDT", "https://www.bitget.com/futures/usdt/BTCUSDT"],
  ["coinsph", "BTCPHP", "https://pro.coins.ph/trade/BTC-PHP"],
  ["okx", "BTCUSDT", "https://www.okx.com/trade-spot/btc-usdt"],
  ["okx-perp", "BTCUSDT", "https://www.okx.com/trade-swap/btc-usdt-swap"],
  ["coinbase", "BTCUSD", "https://www.coinbase.com/advanced-trade/spot/BTC-USD"],
  ["upbit", "BTCKRW", "https://upbit.com/exchange?code=CRIX.UPBIT.KRW-BTC"],
  ["upbit", "SOLBTC", "https://upbit.com/exchange?code=CRIX.UPBIT.BTC-SOL"],
];
for (const [src, sym, want] of cases) ok(`${src} ${sym}`, exchangeUrl(src, sym) === want, String(exchangeUrl(src, sym)));

console.log("no referral parameters");
const all = cases.map(([s, y]) => exchangeUrl(s, y));
const bad = all.filter((u) => /ref|invite|affiliate|utm_/i.test(u) || (/code=/.test(u) && !u.includes("code=CRIX.UPBIT.")));
ok("no ref/invite/affiliate/utm_/code= (except Upbit's)", bad.length === 0, bad.join(" "));
ok("every URL is https", all.every((u) => u.startsWith("https://")));

console.log("unknown pair returns null");
ok("no quote → null", exchangeUrl("binance", "BTC") === null);
ok("unsafe symbol → null", exchangeUrl("binance", "BTC/USDT") === null && exchangeUrl("binance", "BTCUSDT?x=1") === null);
ok("unknown source → null", exchangeUrl("kraken", "BTCUSDT") === null);
ok("okx-perp non-USDT → null", exchangeUrl("okx-perp", "BTCUSDC") === null);
ok("USDC perpetual name → null", exchangeUrl("bybit-perp", "BTCPERP") === null);

console.log("providers");
const ids = PROVIDERS.map((p) => p.id);
ok("at least 13 providers, unique ids", PROVIDERS.length >= 13 && new Set(ids).size === ids.length, String(PROVIDERS.length));
ok("required providers present", ["binance", "bybit", "bitget", "coinsph", "okx", "coinbase", "upbit", "binance-vision", "frankfurter", "ecb", "erapi", "fawazahmed0", "floatrates"].every((i) => ids.includes(i)));
ok("every provider has https apiDocs and terms", PROVIDERS.every((p) => /^https:\/\/[^\s]+$/.test(p.apiDocs) && /^https:\/\/[^\s]+$/.test(p.terms)));
ok("every provider has a name and an i18n 'uses' key", PROVIDERS.every((p) => p.name.length > 0 && /^about\.uses\./.test(p.uses)));
ok("ExchangeRate-API credit is verbatim", PROVIDERS.find((p) => p.id === "erapi")?.credit === "Rates By Exchange Rate API");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
