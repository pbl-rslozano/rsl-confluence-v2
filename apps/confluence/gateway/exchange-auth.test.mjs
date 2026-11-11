import test from "node:test";
import assert from "node:assert/strict";
import {
  binanceKeyPermissions,
  buildBinanceAccountRequest,
  buildBinanceApiRestrictionsRequest,
  buildBitgetProfileRequest,
  buildBybitProfileRequest,
  hmacBase64,
  hmacHex,
  maskApiKey,
} from "./exchange-auth.mjs";

test("HMAC helpers are deterministic", () => {
  assert.equal(hmacHex("secret", "payload"), "b82fcb791acec57859b989b430a826488ce2e479fdf92326bd0a2e8375a42ba4");
  assert.equal(hmacBase64("secret", "payload"), "uC/LeRrOxXhZuYm0MKgmSIzi5Hn9+SMmvQoug3WkK6Q=");
});

test("Binance request keeps the signed query unchanged", () => {
  const request = buildBinanceAccountRequest({ apiKey: "key", apiSecret: "secret", environment: "testnet", timestamp: 123 });
  assert.match(request.url, /^https:\/\/testnet\.binance\.vision\/api\/v3\/account\?recvWindow=5000&timestamp=123&signature=[0-9a-f]{64}$/);
  assert.equal(request.options.headers["X-MBX-APIKEY"], "key");
});

test("Bybit request signs timestamp, key, window, and empty query", () => {
  const request = buildBybitProfileRequest({ apiKey: "key", apiSecret: "secret", environment: "testnet", timestamp: 123 });
  assert.equal(request.url, "https://api-testnet.bybit.com/v5/user/query-api");
  assert.equal(request.options.headers["X-BAPI-SIGN"], hmacHex("secret", "123key5000"));
});

test("Bitget request signs timestamp, method, and request path", () => {
  const request = buildBitgetProfileRequest({ apiKey: "key", apiSecret: "secret", passphrase: "pass", timestamp: 123 });
  assert.equal(request.url, "https://api.bitget.com/api/v2/spot/account/info");
  assert.equal(request.options.headers["ACCESS-SIGN"], hmacBase64("secret", "123GET/api/v2/spot/account/info"));
});

test("Bitget includes the query string in the signed payload", () => {
  const request = buildBitgetProfileRequest({
    apiKey: "key", apiSecret: "secret", passphrase: "pass", timestamp: 123, queryString: "coin=USDT",
  });
  assert.equal(request.url, "https://api.bitget.com/api/v2/spot/account/info?coin=USDT");
  assert.equal(
    request.options.headers["ACCESS-SIGN"],
    hmacBase64("secret", "123GET/api/v2/spot/account/info?coin=USDT"),
  );
});

test("API keys are masked before returning to the browser", () => {
  assert.equal(maskApiKey("abcdefghijklmnop"), "abcd••••••mnop");
});


test("Binance key permissions come from apiRestrictions, not account flags (2.02)", () => {
  const request = buildBinanceApiRestrictionsRequest({ apiKey: "key", apiSecret: "secret", timestamp: 123 });
  assert.match(request.url, /^https:\/\/api\.binance\.com\/sapi\/v1\/account\/apiRestrictions\?recvWindow=5000&timestamp=123&signature=[0-9a-f]{64}$/);
  assert.deepEqual(binanceKeyPermissions({ enableReading: true, enableSpotAndMarginTrading: false, enableWithdrawals: false }),
    { readOnly: true, permissions: ["read"] });
  assert.deepEqual(binanceKeyPermissions({ enableReading: true, enableSpotAndMarginTrading: true }),
    { readOnly: false, permissions: ["read", "spot-margin-trade"] });
  assert.equal(binanceKeyPermissions({ enableReading: true, enableWithdrawals: true }).readOnly, false);
});
