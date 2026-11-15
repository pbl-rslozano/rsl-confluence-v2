// Tests for release check R12 part 1 (tools/checks/order-paths.mjs): the order-endpoint pattern catches every
// venue's private trading/account paths, including the v2.8 (WP26) OKX, Coinbase and Upbit ones, and lets
// the public market-data paths the app uses through.
//   node --test tools/order-paths.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { orderEndpointIn, scanOrderEndpoints } from "./checks/order-paths.mjs";

const FORBIDDEN = {
  // existing venues (kept)
  "Binance order": "fetch(`${BASE}/api/v3/order?symbol=BTCUSDT`)",
  "Bybit order": 'const u = "https://api.bybit.com/v5/order/create";',
  "Bitget v2 order": 'url = BITGET + "/api/v2/spot/trade/place-order";',
  // v2.8 (WP26) OKX
  "OKX place order": 'fetch(`${OKX_BASE}/api/v5/trade/order`, { method: "POST" })',
  "OKX batch orders": 'const p = "/api/v5/trade/batch-orders";',
  "OKX account balance": "fetchJson(`${OKX_BASE}/api/v5/account/balance`)",
  "OKX account positions": 'get("/api/v5/account/positions?instType=SWAP")',
  "OKX funding withdrawal": "fetch(`https://www.okx.com/api/v5/asset/withdrawal`)",
  // v2.8 (WP26) Coinbase
  "Coinbase Exchange orders (host)": 'fetch("https://api.exchange.coinbase.com/orders")',
  "Coinbase Exchange fills (host)": "fetch(`https://api.exchange.coinbase.com/fills?product_id=BTC-USD`)",
  "Coinbase Exchange accounts (host)": 'const u = "https://api.exchange.coinbase.com/accounts";',
  "Coinbase orders (path literal)": "fetch(`${COINBASE_BASE}/orders`)",
  "Coinbase fills (path literal)": 'get("/fills?order_id=1")',
  "Coinbase accounts (path literal)": "fetchJson(COINBASE + '/accounts')",
  "Coinbase Advanced orders": 'fetch("https://api.coinbase.com/api/v3/brokerage/orders")',
  "Coinbase Advanced batch cancel": 'const p = "/api/v3/brokerage/orders/batch_cancel";',
  "Coinbase Advanced accounts": "fetch(`${CB}/api/v3/brokerage/accounts`)",
  "Coinbase Advanced portfolios": 'fetch("/api/v3/brokerage/portfolios")',
  // fix round 1 (review minor 2): OKX order-placing families beyond /trade
  "OKX trading bot": 'fetch(`${OKX_BASE}/api/v5/tradingBot/grid/order-algo`)',
  "OKX spread order": 'post("/api/v5/sprd/order")',
  "OKX block trading (RFQ)": 'post("/api/v5/rfq/create-rfq")',
  "OKX copy trading": 'get("/api/v5/copytrading/current-subpositions")',
  // fix round 1 (review minor 2): Coinbase Exchange funding paths
  "Coinbase withdrawals (host)": 'fetch("https://api.exchange.coinbase.com/withdrawals/crypto")',
  "Coinbase deposits (path literal)": "fetch(`${COINBASE_BASE}/deposits/coinbase-account`)",
  "Coinbase transfers (path literal)": 'get("/transfers")',
  "Coinbase conversions (path literal)": 'post("/conversions")',
  "Coinbase accounts link (path literal)": 'get("/coinbase-accounts")',
  "Coinbase profiles (host)": 'fetch("https://api.exchange.coinbase.com/profiles/transfer")',
  // v2.8 (WP26) Upbit
  "Upbit orders": "relayGet(rule, prefix, `/v1/orders?state=wait`)",
  "Upbit order": 'fetch(`${UPBIT}/v1/order?uuid=x`, { method: "DELETE" })',
  "Upbit orders chance": 'get("/v1/orders/chance?market=KRW-BTC")',
  "Upbit accounts": 'const p = "/v1/accounts";',
  "Upbit withdraws": "fetch(`${UPBIT}/v1/withdraws/krw`)",
  "Upbit withdraw": 'post("/v1/withdraw")',
  "Upbit deposits": 'get("/v1/deposits")',
  "Upbit deposit": 'get("/v1/deposit?uuid=1")',
};

const ALLOWED = {
  "OKX candles": "`${OKX_BASE}/api/v5/market/candles?instId=BTC-USDT&bar=4H&limit=300`",
  "OKX history candles": "`${OKX_BASE}/api/v5/market/history-candles?instId=x&after=1`",
  "OKX tickers": "`${OKX_BASE}/api/v5/market/tickers?instType=SPOT`",
  "OKX instruments": "`${OKX_BASE}/api/v5/public/instruments?instType=SWAP`",
  "OKX books": "`${OKX_BASE}/api/v5/market/books?instId=x&sz=100`",
  "Coinbase products": '"https://api.exchange.coinbase.com/products"',
  "Coinbase candles": "`${COINBASE_BASE}/products/BTC-USD/candles?granularity=3600`",
  "Coinbase stats": "`${COINBASE_BASE}/products/stats`",
  "Coinbase book": "`${COINBASE_BASE}/products/BTC-USD/book?level=2`",
  "Coinbase Advanced public market": '"/api/v3/brokerage/market/products"',
  "Coinbase Advanced time": '"/api/v3/brokerage/time"',
  "Upbit read paths": '["/v1/market/all", "/v1/ticker/all", "/v1/ticker", "/v1/orderbook", "/v1/candles/"]',
  "Upbit candles": "`${UPBIT_PROXY_PREFIX}/v1/candles/minutes/240?market=KRW-BTC&count=200`",
  "Upbit orderbook": '"/v1/orderbook?markets=KRW-BTC"',
  "Binance klines": "`${BINANCE_BASE}/api/v3/klines?symbol=BTCUSDT`",
  "Binance depth": "`${BINANCE_BASE}/api/v3/depth?symbol=BTCUSDT&limit=100`",
  "Binance key restrictions (read-only key check)": "`https://api.binance.com/sapi/v1/account/apiRestrictions?x`",
  "Bybit orderbook": "`${BYBIT_BASE}/v5/market/orderbook?category=spot`",
  "Coins.ph depth": "`/openapi/quote/v1/depth?symbol=BTCPHP`",
  "a word, not a path": "// accounts, orders and fills are never touched",
  "an app route": 'router.push("/ordersheet")',
  "the local gateway's own profile route": 'if (url.pathname === "/profiles") {',
  "OKX public trades": "`${OKX_BASE}/api/v5/market/trades?instId=x`",
};

for (const [name, src] of Object.entries(FORBIDDEN)) {
  test(`R12 catches ${name}`, () => assert.ok(orderEndpointIn(src), src));
}
for (const [name, src] of Object.entries(ALLOWED)) {
  test(`R12 allows ${name}`, () => assert.equal(orderEndpointIn(src), null, src));
}

test("R12 scan flags each fixture in a non-test source file and skips test files", () => {
  const dir = mkdtempSync(join(tmpdir(), "r12-"));
  try {
    const put = (p, s) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), s); };
    const entries = Object.entries(FORBIDDEN);
    entries.forEach(([, src], i) => put(`apps/confluence/web/src/lib/venue${i}.ts`, `export const x = () => ${src};\n`));
    put("apps/confluence/web/src/lib/venue.test.mjs", FORBIDDEN["OKX place order"]);
    put("apps/confluence/web/src/lib/clean.ts", Object.values(ALLOWED).join("\n"));
    const r = scanOrderEndpoints(dir);
    assert.equal(r.bad.length, entries.length, r.bad.join("\n"));
    entries.forEach((_, i) => assert.ok(r.bad.some((b) => b.startsWith(`apps/confluence/web/src/lib/venue${i}.ts:`)), `venue${i}`));
    assert.equal(r.scanned, entries.length + 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R12 passes on the current tree", () => {
  const r = scanOrderEndpoints();
  assert.deepEqual(r.bad, []);
  assert.ok(r.scanned > 100, String(r.scanned));
});
