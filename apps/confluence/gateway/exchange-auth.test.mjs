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
  profileAllowed,
  verifyCredentials,
} from "./exchange-auth.mjs";
import * as auth from "./exchange-auth.mjs";

const BITGET_READ_ONLY_AUTHORITIES = auth.BITGET_READ_ONLY_AUTHORITIES ?? [];

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

const fakeFetch = (payload) => async () => payload;
const bitget = () => ({ provider: "bitget", environment: "mainnet", apiKey: "test-key", apiSecret: "test-secret", passphrase: "test-pass", label: "t" });
const bitgetPayload = (data) => ({ code: "00000", data });

test("bitget empty authorities refused", async () => {
  const c = bitget();
  const v = await verifyCredentials(c, fakeFetch(bitgetPayload({ authorities: [] })));
  assert.equal(v.readOnly, null);
  assert.equal(profileAllowed(c, v).ok, false);
});

test("bitget missing authorities refused", async () => {
  const c = bitget();
  const v = await verifyCredentials(c, fakeFetch(bitgetPayload({})));
  assert.equal(v.readOnly, null);
  assert.equal(profileAllowed(c, v).ok, false);
});

test("bitget read-only list allowed", async () => {
  const c = bitget();
  const v = await verifyCredentials(c, fakeFetch(bitgetPayload({ authorities: ["spot_r", "wallet_r"] })));
  assert.equal(v.readOnly, true);
  assert.equal(profileAllowed(c, v).ok, true);
});

test("bybit readOnly 1 with empty permissions allowed", async () => {
  const c = { provider: "bybit", environment: "mainnet", apiKey: "test-key", apiSecret: "test-secret", label: "t" };
  const v = await verifyCredentials(c, fakeFetch({ retCode: 0, result: { readOnly: 1, permissions: {} } }));
  assert.equal(v.readOnly, true);
  assert.equal(profileAllowed(c, v).ok, true);
});

test("binance testnet null allowed with label", async () => {
  const c = { provider: "binance", environment: "testnet", apiKey: "test-key", apiSecret: "test-secret", label: "t" };
  const v = await verifyCredentials(c, fakeFetch({}));
  assert.equal(v.readOnly, null);
  assert.deepEqual(profileAllowed(c, v), { ok: true, label: "permissions not reported" });
});

test("binance mainnet null refused", async () => {
  const c = { provider: "binance", environment: "mainnet", apiKey: "test-key", apiSecret: "test-secret", label: "t" };
  let n = 0;
  const v = await verifyCredentials(c, async () => { if (n++ === 0) return {}; throw new Error("down"); });
  assert.equal(v.readOnly, null);
  assert.equal(profileAllowed(c, v).ok, false);
});

// Final review I-2: fail closed — read-only only when EVERY entry is a known read-only authority.
test("bitget unknown authority refused", async () => {
  const c = bitget();
  for (const authorities of [["somethingNew"], ["spot_r", "somethingNew"], ["spot_r", 7], ["spot_r", null], ["spot_r", { code: "spot_w" }], ["SPOT_TRADE"]]) {
    const v = await verifyCredentials(c, fakeFetch(bitgetPayload({ authorities })));
    assert.notEqual(v.readOnly, true, JSON.stringify(authorities));
    assert.equal(profileAllowed(c, v).ok, false, JSON.stringify(authorities));
  }
});

test("bitget every known read-only authority accepted", async () => {
  const c = bitget();
  const v = await verifyCredentials(c, fakeFetch(bitgetPayload({ authorities: [...BITGET_READ_ONLY_AUTHORITIES] })));
  assert.equal(v.readOnly, true);
  assert.equal(profileAllowed(c, v).ok, true);
});

test("bitget write authority refused even beside known read-only ones", async () => {
  const c = bitget();
  for (const w of ["spot_w", "contract_w", "wallet_w", "trade", "withdraw", "transfer"]) {
    const v = await verifyCredentials(c, fakeFetch(bitgetPayload({ authorities: ["spot_r", w] })));
    assert.equal(v.readOnly, false, w);
    assert.equal(profileAllowed(c, v).ok, false, w);
  }
});

test("write permission refused", async () => {
  const c = bitget();
  const v = await verifyCredentials(c, fakeFetch(bitgetPayload({ authorities: ["spot_r", "spot_trader_w"] })));
  assert.equal(v.readOnly, false);
  assert.equal(profileAllowed(c, v).ok, false);
});
