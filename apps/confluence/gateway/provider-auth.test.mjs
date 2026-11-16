// WP25 part 2, Task 5: provider-key profiles (Whale Alert, CoinGlass). Fakes only; no test reaches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { profileAllowed } from "./exchange-auth.mjs";
import {
  PROVIDER_IDS, buildCoinglassRequest, createProviderProfile, validateProviderCredentials, verifyProvider, whaleAlertUrl,
} from "./provider-auth.mjs";

const KEY = "abcd1234efgh";

/** Fake WebSocket: records what was sent and lets the test drive the events. */
class FakeWs {
  static last = null;
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    FakeWs.last = this;
    queueMicrotask(() => this.onopen?.({}));
  }
  send(data) { this.sent.push(data); }
  close() { this.closed = true; }
  emit(data) { this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) }); }
}

const okFetcher = (payload, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => payload });

test("exchange key with write permission is still refused, provider key is accepted", async () => {
  assert.equal(profileAllowed({ provider: "bybit", environment: "mainnet" }, { readOnly: false }).ok, false);
  const creds = validateProviderCredentials({ provider: "coinglass", apiKey: KEY });
  assert.deepEqual(await verifyProvider(creds, { fetcher: okFetcher({ code: "0", data: [] }) }), { ok: true });
  const profile = createProviderProfile(creds);
  assert.equal(profile.kind, "provider");
  assert.equal(profile.provider, "coinglass");
  assert.equal(profile.label, "coinglass key");
  assert.ok(!profile.maskedKey.includes(KEY));
  assert.ok(!JSON.stringify(profile).includes(KEY));
  assert.deepEqual([...PROVIDER_IDS], ["whale-alert", "coinglass"]);
});

test("coinglass request carries the key header only and the fixed host", () => {
  const { url, options } = buildCoinglassRequest(KEY);
  assert.equal(url, "https://open-api-v4.coinglass.com/api/etf/bitcoin/list");
  assert.equal(options.method, "GET");
  assert.equal(options.headers["CG-API-KEY"], KEY);
});

test("coinglass bad key is rejected without echoing upstream text", async () => {
  const creds = validateProviderCredentials({ provider: "coinglass", apiKey: KEY });
  await assert.rejects(
    verifyProvider(creds, { fetcher: okFetcher({ msg: `invalid key ${KEY}` }, 401) }),
    (error) => error.message === "The provider rejected the key test." && !error.message.includes(KEY),
  );
  // HTTP 200 with a non-zero code is a rejection too.
  await assert.rejects(
    verifyProvider(creds, { fetcher: okFetcher({ code: "40001", msg: `bad ${KEY}` }) }),
    (error) => error.message === "The provider rejected the key test.",
  );
  // A thrown network error never leaks its text.
  await assert.rejects(
    verifyProvider(creds, { fetcher: async () => { throw new Error(`boom ${KEY} https://open-api-v4.coinglass.com`); } }),
    (error) => !error.message.includes(KEY) && !error.message.includes("coinglass"),
  );
});

test("coinglass non-OK response releases the unread body, even if cancel throws", async () => {
  const creds = validateProviderCredentials({ provider: "coinglass", apiKey: KEY });
  let cancelled = 0;
  const fetcher = (cancel) => async () => ({ ok: false, status: 401, body: { cancel }, json: async () => ({}) });
  await assert.rejects(verifyProvider(creds, { fetcher: fetcher(async () => { cancelled += 1; }) }), { message: "The provider rejected the key test." });
  assert.equal(cancelled, 1);
  await assert.rejects(verifyProvider(creds, { fetcher: fetcher(async () => { throw new Error("cancel failed"); }) }), { message: "The provider rejected the key test." });
});

test("whale alert verifies on subscribed_alerts and closes the socket", async () => {
  const creds = validateProviderCredentials({ provider: "whale-alert", apiKey: KEY });
  const pending = verifyProvider(creds, { WebSocketCtor: FakeWs, timeoutMs: 1000 });
  await new Promise((r) => setTimeout(r, 5));
  const ws = FakeWs.last;
  assert.equal(ws.url, "wss://leviathan.whale-alert.io/ws?api_key=" + KEY);
  assert.equal(ws.url, whaleAlertUrl(KEY));
  assert.deepEqual(JSON.parse(ws.sent[0]), { type: "subscribe_alerts", id: "rsl-verify", min_value_usd: 1000000000 });
  ws.emit({ type: "subscribed_alerts", id: "rsl-verify", min_value_usd: 1000000000 });
  assert.deepEqual(await pending, { ok: true });
  assert.equal(ws.closed, true);
});

test("whale alert error frame rejects and the message never contains the key or the URL", async () => {
  const creds = validateProviderCredentials({ provider: "whale-alert", apiKey: KEY });
  const pending = verifyProvider(creds, { WebSocketCtor: FakeWs, timeoutMs: 1000 });
  await new Promise((r) => setTimeout(r, 5));
  const ws = FakeWs.last;
  ws.emit({ error: `not authenticated ${KEY} wss://leviathan.whale-alert.io/ws` });
  await assert.rejects(pending, (error) =>
    error.message === "The provider rejected the key test." && !error.message.includes(KEY) && !error.message.includes("whale-alert.io"));
  assert.equal(ws.closed, true);
});

test("whale alert close before confirmation and a throwing constructor reject without leaking", async () => {
  const creds = validateProviderCredentials({ provider: "whale-alert", apiKey: KEY });
  const pending = verifyProvider(creds, { WebSocketCtor: FakeWs, timeoutMs: 1000 });
  await new Promise((r) => setTimeout(r, 5));
  FakeWs.last.onclose?.({});
  await assert.rejects(pending, { message: "The provider rejected the key test." });
  class Throws { constructor(url) { throw new Error(`cannot open ${url}`); } }
  await assert.rejects(
    verifyProvider(creds, { WebSocketCtor: Throws }),
    (error) => error.message === "The provider rejected the key test." && !error.message.includes(KEY),
  );
});

test("whale alert timeout rejects", async () => {
  const creds = validateProviderCredentials({ provider: "whale-alert", apiKey: KEY });
  await assert.rejects(
    verifyProvider(creds, { WebSocketCtor: FakeWs, timeoutMs: 20 }),
    { message: "The provider did not answer the key test in time." },
  );
  assert.equal(FakeWs.last.closed, true);
});

test("unsupported provider and short key are refused", () => {
  assert.throws(() => validateProviderCredentials({ provider: "binance", apiKey: KEY }), { message: "Unsupported data provider." });
  assert.throws(() => validateProviderCredentials({ provider: "coinglass", apiKey: "short" }), { message: "Invalid apiKey." });
  assert.throws(() => validateProviderCredentials({ provider: "coinglass", apiKey: "has space inside" }), { message: "Invalid apiKey." });
  assert.throws(() => validateProviderCredentials({ provider: "coinglass", apiKey: "a".repeat(257) }), { message: "Invalid apiKey." });
  assert.throws(() => validateProviderCredentials(null), { message: "Invalid provider payload." });
  assert.equal(validateProviderCredentials({ provider: "whale-alert", apiKey: `  ${KEY} `, label: "  Mine " }).apiKey, KEY);
  assert.equal(validateProviderCredentials({ provider: "whale-alert", apiKey: KEY, label: "x".repeat(200) }).label.length, 80);
});

test("POST /providers/connect with a bad payload is 400 and GET /providers lists none", async () => {
  const port = 19787 + Math.floor(Math.random() * 500);
  const token = "test-token-0123456789abcdef";
  const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
    env: { ...process.env, CONFLUENCE_GATEWAY_PORT: String(port), CONFLUENCE_GATEWAY_TOKEN: token, CONFLUENCE_RECORDER_DIR: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const headers = { Origin: "http://127.0.0.1:8770", Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(`${base}/health`, { headers }); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    for (const body of [{ provider: "kraken", apiKey: KEY }, { provider: "coinglass", apiKey: "x" }]) {
      const r = await fetch(`${base}/providers/connect`, { method: "POST", headers, body: JSON.stringify(body) });
      assert.equal(r.status, 400);
      assert.ok(!(await r.text()).includes(KEY));
    }
    const list = await (await fetch(`${base}/providers`, { headers })).json();
    assert.deepEqual(list, { profiles: [] });
    assert.equal((await (await fetch(`${base}/health`, { headers })).json()).providers, 0);
    assert.equal((await fetch(`${base}/providers/00000000-0000-0000-0000-000000000000`, { method: "DELETE", headers })).status, 404);
  } finally {
    child.kill();
  }
});
