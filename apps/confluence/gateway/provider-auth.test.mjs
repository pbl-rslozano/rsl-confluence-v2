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
  assert.deepEqual([...PROVIDER_IDS], ["whale-alert", "coinglass", "b2", "r2"]);
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

// WP28 Task 8: backup-bucket keys (Backblaze B2, Cloudflare R2). The key pair is AWS's public documentation example.
const BK_ACCESS = "AKIAIOSFODNN7EXAMPLE";
const BK_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const B2_PAYLOAD = { provider: "b2", accessKeyId: BK_ACCESS, secretAccessKey: BK_SECRET, bucket: "rsl-backup-test", region: "us-west-004", label: "My bucket" };
const R2_PAYLOAD = { provider: "r2", accessKeyId: BK_ACCESS, secretAccessKey: BK_SECRET, bucket: "rsl-backup-test", accountId: "0123456789abcdef0123456789abcdef" };
const s3Fetcher = ({ head = 200, list = 403, buckets = ["rsl-backup-test"] } = {}) => async (url, init) => {
  if (init.method === "HEAD") return new Response(null, { status: head });
  if (list !== 200) return new Response(`<Error>${BK_SECRET}</Error>`, { status: list });
  return new Response(`<ListAllMyBucketsResult>${buckets.map((b) => `<Bucket><Name>${b}</Name></Bucket>`).join("")}</ListAllMyBucketsResult>`, { status: 200 });
};

test("bucket keys: a restricted key (ListBuckets 403, HEAD 200) is accepted, and so is ListBuckets naming only the bucket", async () => {
  const creds = validateProviderCredentials(B2_PAYLOAD);
  assert.deepEqual(await verifyProvider(creds, { fetcher: s3Fetcher() }), { ok: true });
  assert.deepEqual(await verifyProvider(validateProviderCredentials(R2_PAYLOAD), { fetcher: s3Fetcher({ list: 200 }) }), { ok: true });
});

test("bucket keys: a key that can list another bucket is refused with the 'other buckets' message, secret never echoed", async () => {
  const creds = validateProviderCredentials(B2_PAYLOAD);
  await assert.rejects(
    verifyProvider(creds, { fetcher: s3Fetcher({ list: 200, buckets: ["rsl-backup-test", "someone-elses"] }) }),
    (error) => error.message === "This key can reach other buckets. Create a key restricted to one bucket.",
  );
  for (const fetcher of [s3Fetcher({ head: 403 }), s3Fetcher({ list: 500 }), async () => { throw new Error(`${BK_SECRET} <Error/>`); }]) {
    await assert.rejects(verifyProvider(creds, { fetcher }), (error) => error.message === "The provider rejected the key test." && !error.message.includes(BK_SECRET));
  }
});

test("bucket keys: the profile is kind provider, carries the bucket and a masked key id, never the secret", () => {
  for (const payload of [B2_PAYLOAD, R2_PAYLOAD]) {
    const creds = validateProviderCredentials(payload);
    const profile = createProviderProfile(creds);
    assert.equal(profile.kind, "provider");
    assert.equal(profile.provider, payload.provider);
    assert.equal(profile.bucket, "rsl-backup-test");
    assert.ok(!profile.maskedKey.includes(BK_ACCESS) && profile.maskedKey.startsWith("AKIA"));
    const text = JSON.stringify(profile);
    for (const secret of [BK_SECRET, BK_ACCESS, payload.region, payload.accountId].filter(Boolean)) assert.ok(!text.includes(secret), secret);
  }
  assert.equal(createProviderProfile(validateProviderCredentials(B2_PAYLOAD)).label, "My bucket");
  assert.equal(createProviderProfile(validateProviderCredentials(R2_PAYLOAD)).label, "r2 key");
});

test("bucket keys: payload validation (key id, secret, bucket, region / account id)", () => {
  const bad = "Invalid bucket key payload.";
  assert.doesNotThrow(() => validateProviderCredentials(B2_PAYLOAD));
  const cases = [
    { ...B2_PAYLOAD, accessKeyId: "short" }, { ...B2_PAYLOAD, accessKeyId: "AKIA IOSFODNN7EXAMPLE" }, { ...B2_PAYLOAD, accessKeyId: undefined },
    { ...B2_PAYLOAD, secretAccessKey: "x".repeat(15) }, { ...B2_PAYLOAD, secretAccessKey: "x".repeat(129) }, { ...B2_PAYLOAD, secretAccessKey: 5 },
    { ...B2_PAYLOAD, bucket: "short" }, { ...B2_PAYLOAD, bucket: "has_underscore" }, { ...B2_PAYLOAD, bucket: "../etc/passwd" }, { ...B2_PAYLOAD, bucket: "a".repeat(64) },
    { ...B2_PAYLOAD, region: "evil.example" }, { ...B2_PAYLOAD, region: "US-west-004" }, { ...B2_PAYLOAD, region: undefined },
    { ...R2_PAYLOAD, bucket: "Upper-Case" }, { ...R2_PAYLOAD, bucket: "-leading" }, { ...R2_PAYLOAD, bucket: "trailing-" }, { ...R2_PAYLOAD, bucket: "a" },
    { ...R2_PAYLOAD, accountId: "0123456789ABCDEF0123456789ABCDEF" }, { ...R2_PAYLOAD, accountId: "abc" }, { ...R2_PAYLOAD, accountId: undefined },
  ];
  for (const c of cases) assert.throws(() => validateProviderCredentials(c), (e) => e.message === bad && !e.message.includes(BK_SECRET), JSON.stringify(c));
  assert.doesNotThrow(() => validateProviderCredentials({ ...R2_PAYLOAD, bucket: "abc" }));
});

test("bucket keys do not weaken the WP19 rule: an exchange key with write permission is refused, a bucket key is accepted", async () => {
  assert.equal(profileAllowed({ provider: "binance", environment: "mainnet" }, { readOnly: false }).ok, false);
  assert.equal(profileAllowed({ provider: "bybit", environment: "mainnet" }, { readOnly: false }).ok, false);
  assert.deepEqual(await verifyProvider(validateProviderCredentials(B2_PAYLOAD), { fetcher: s3Fetcher() }), { ok: true });
});
