// WP28 Task 9: B2/R2 bucket keys through the gateway and the gateway backup target. fetch is mocked; nothing touches
// the network. Run: npm run test:backup-gateway   (node scripts/run-engine-tests.mjs backup-gateway.test.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";
import { BackupError, BACKUP_MAX_FILE_BYTES, sealBackup, openBackup } from "./backup-crypto.ts";
import { connectProvider, nextProviderLink } from "./private-api.ts";
import { gatewayBackupTarget } from "./backup-gateway-client.ts";
import { fetchEtfLive, fetchWhaleAlerts } from "./provider-data-client.ts";

const TOKEN = "FAKE-GATEWAY-TOKEN-0001";
const KEY_ID = "FAKE-KEY-ID-000000001";
const SECRET = "FAKE-SECRET-APPLICATION-KEY-0002";
const PASS = "correct horse battery staple";
const NAME = "confluence-backup-20261117T101500Z.json";
const SESSION = { url: "http://127.0.0.1:8787", token: TOKEN };
const B2_PROFILE = { id: "11111111-1111-4111-8111-111111111111", kind: "provider", provider: "b2", label: "B2", bucket: "my-backups-1", maskedKey: "FAKE…0001", connectedAt: "2026-11-17T00:00:00.000Z" };
const LINK = { session: SESSION, providers: [B2_PROFILE] };
const B2_INPUT = { provider: "b2", label: "B2", accessKeyId: KEY_ID, secretAccessKey: SECRET, bucket: "my-backups-1", region: "eu-central-003" };

const realFetch = globalThis.fetch;
const realLocal = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const realSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
const restoreProp = (name, desc) => { if (desc) Object.defineProperty(globalThis, name, desc); else delete globalThis[name]; };
const reply = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  body: null,
  json: async () => body,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});
const cleanup = () => { globalThis.fetch = realFetch; restoreProp("localStorage", realLocal); restoreProp("sessionStorage", realSessionStorage); };

/** A fake gateway holding one bucket: the three /backup routes with the real query names and answer shapes. */
function fakeGateway(calls) {
  const files = new Map();
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ url: String(url), init });
    assert.equal(init.headers.Authorization, "Bearer " + TOKEN);
    assert.equal(u.searchParams.get("profile"), B2_PROFILE.id);
    if (u.pathname === "/backup/upload") {
      assert.equal(init.method, "POST");
      assert.equal(init.headers["Content-Type"], "application/octet-stream");
      const name = u.searchParams.get("name");
      files.set(name, init.body);
      return reply(200, { name, size: init.body.length, modifiedAt: "2026-11-17T10:15:00.000Z" });
    }
    if (u.pathname === "/backup/list") {
      return reply(200, { files: [...files].map(([name, text]) => ({ name, size: text.length, modifiedAt: "2026-11-17T10:15:00.000Z" })) });
    }
    if (u.pathname === "/backup/download") return reply(200, files.get(u.searchParams.get("name")));
    return reply(404, {});
  };
  return files;
}

test("connectProvider sends exactly the bucket fields", async () => {
  let seen;
  globalThis.fetch = async (url, init) => { seen = { url: String(url), init }; return reply(200, { profile: B2_PROFILE }); };
  try {
    const got = await connectProvider(SESSION, B2_INPUT);
    assert.equal(seen.url, "http://127.0.0.1:8787/providers/connect");
    assert.deepEqual(Object.keys(JSON.parse(seen.init.body)), ["provider", "label", "accessKeyId", "secretAccessKey", "bucket", "region"]);
    assert.equal(got.bucket, "my-backups-1");
    const r2 = { provider: "r2", label: "R2", accessKeyId: KEY_ID, secretAccessKey: SECRET, bucket: "my-backups-2", accountId: "0123456789abcdef0123456789abcdef" };
    await connectProvider(SESSION, r2);
    assert.deepEqual(Object.keys(JSON.parse(seen.init.body)), ["provider", "label", "accessKeyId", "secretAccessKey", "bucket", "accountId"]);
    // the key-only providers are unchanged
    await connectProvider(SESSION, { provider: "coinglass", label: "CG", apiKey: SECRET });
    assert.deepEqual(Object.keys(JSON.parse(seen.init.body)), ["provider", "label", "apiKey"]);
  } finally { cleanup(); }
});

test("a b2 profile without a valid bucket is refused; the secret is not in the error", async () => {
  globalThis.fetch = async () => reply(200, { profile: { ...B2_PROFILE, bucket: "x" } });
  try {
    await assert.rejects(() => connectProvider(SESSION, B2_INPUT), (e) => !String(e.message).includes(SECRET));
    globalThis.fetch = async () => reply(200, { profile: { ...B2_PROFILE, bucket: "bad/bucket" } });
    await assert.rejects(() => connectProvider(SESSION, B2_INPUT));
  } finally { cleanup(); }
});

test("round trip through a fake gateway (spec)", async () => {
  const calls = [];
  const files = fakeGateway(calls);
  try {
    const plain = JSON.stringify({ ledger: [1, 2, 3] });
    const sealed = await sealBackup(plain, PASS, { createdAt: Date.UTC(2026, 10, 17, 10, 15), app: "test", zip: "none" });
    const target = gatewayBackupTarget(LINK, B2_PROFILE);
    assert.equal(target.provider, "b2");
    const info = await target.upload(NAME, sealed);
    assert.equal(info.name, NAME);
    assert.ok(files.has(NAME));
    const list = await target.list();
    assert.equal(list.length, 1);
    assert.equal(typeof list[0].modifiedAt, "number");
    const text = await target.download(list[0]);
    const opened = await openBackup(text, PASS);
    assert.equal(opened.plain, plain);
    assert.ok(calls.every((c) => !c.url.includes(SECRET) && !c.url.includes(TOKEN)));
  } finally { cleanup(); }
});

test("status mapping", async () => {
  const cases = [[401, "gateway", {}], [409, "needs-gateway", {}], [413, "too-large-file", {}], [502, "http", { status: 502 }]];
  try {
    for (const [status, code, detail] of cases) {
      globalThis.fetch = async () => reply(status, { error: `upstream said ${SECRET} ${TOKEN}` });
      const target = gatewayBackupTarget(LINK, B2_PROFILE);
      for (const op of [() => target.list(), () => target.upload(NAME, "x"), () => target.download({ id: NAME, name: NAME, size: 1, modifiedAt: 1 })]) {
        await assert.rejects(op, (e) => {
          assert.ok(e instanceof BackupError);
          assert.equal(e.code, code);
          assert.deepEqual(e.detail, detail);
          const shown = e.message + JSON.stringify(e.detail) + String(e.stack ?? "");
          assert.ok(!shown.includes(SECRET) && !shown.includes(TOKEN) && !shown.includes("upstream"));
          return true;
        });
      }
    }
    globalThis.fetch = async () => { throw new Error(`connect refused ${TOKEN}`); };
    await assert.rejects(() => gatewayBackupTarget(LINK, B2_PROFILE).list(), (e) => e instanceof BackupError && e.code === "network" && !e.message.includes(TOKEN));
  } finally { cleanup(); }
});

test("oversize gateway download is refused", async () => {
  try {
    const f = { id: NAME, name: NAME, size: 10, modifiedAt: 1 };
    globalThis.fetch = async () => reply(200, "x", { "content-length": String(BACKUP_MAX_FILE_BYTES + 1) });
    await assert.rejects(() => gatewayBackupTarget(LINK, B2_PROFILE).download(f), (e) => e.code === "too-large-file");
    globalThis.fetch = async () => reply(200, "x".repeat(BACKUP_MAX_FILE_BYTES + 1));
    await assert.rejects(() => gatewayBackupTarget(LINK, B2_PROFILE).download(f), (e) => e.code === "too-large-file");
    // a streamed body is cut off at the cap and the reader is cancelled
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    globalThis.fetch = async () => ({ ...reply(200, ""), body: { getReader: () => ({ read: async () => ({ done: false, value: chunk }), cancel: async () => { cancelled = true; } }) } });
    await assert.rejects(() => gatewayBackupTarget(LINK, B2_PROFILE).download(f), (e) => e.code === "too-large-file");
    assert.ok(cancelled);
    // an oversize upload never leaves the page
    let called = false;
    globalThis.fetch = async () => { called = true; return reply(200, {}); };
    await assert.rejects(() => gatewayBackupTarget(LINK, B2_PROFILE).upload(NAME, "x".repeat(BACKUP_MAX_FILE_BYTES + 1)), (e) => e.code === "too-large-file");
    assert.equal(called, false);
  } finally { cleanup(); }
});

test("list entries are re-validated", async () => {
  const ok = { name: NAME, size: 5, modifiedAt: "2026-11-17T10:15:00.000Z" };
  globalThis.fetch = async () => reply(200, { files: [ok, { ...ok, name: "../evil.json" }, { ...ok, size: BACKUP_MAX_FILE_BYTES + 1 }, { ...ok, modifiedAt: "nope" }, null, "x"] });
  try {
    const list = await gatewayBackupTarget(LINK, B2_PROFILE).list();
    assert.deepEqual(list.map((f) => f.name), [NAME]);
    globalThis.fetch = async () => reply(200, { files: "no" });
    await assert.rejects(() => gatewayBackupTarget(LINK, B2_PROFILE).list(), (e) => e instanceof BackupError);
  } finally { cleanup(); }
});

test("a non-loopback gateway is refused before any request", async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return reply(200, {}); };
  try {
    const bad = { session: { url: "http://example.com:8787", token: TOKEN }, providers: [B2_PROFILE] };
    assert.throws(() => gatewayBackupTarget(bad, B2_PROFILE), (e) => e instanceof BackupError && e.code === "gateway");
    assert.throws(() => gatewayBackupTarget({ session: { url: SESSION.url, token: " " }, providers: [B2_PROFILE] }, B2_PROFILE), (e) => e.code === "gateway");
    await assert.rejects(() => connectProvider({ url: "http://example.com:8787", token: TOKEN }, B2_INPUT), (e) => !e.message.includes(SECRET));
    assert.equal(called, false);
  } finally { cleanup(); }
});

test("a profile that is not a bucket profile is refused", () => {
  assert.throws(() => gatewayBackupTarget(LINK, { ...B2_PROFILE, provider: "coinglass" }), (e) => e instanceof BackupError);
});

test("radar ignores bucket profiles", async () => {
  const bucketOnly = { session: SESSION, providers: [B2_PROFILE, { ...B2_PROFILE, id: "22222222-2222-4222-8222-222222222222", provider: "r2" }] };
  // the radar decides with `providers.some(p => p.provider === ...)` (snapshot.ts, radar-panel.tsx)
  assert.equal(bucketOnly.providers.some((p) => p.provider === "coinglass"), false);
  assert.equal(bucketOnly.providers.some((p) => p.provider === "whale-alert"), false);
  // and the link transitions keep a bucket profile without turning it into anything else
  const next = nextProviderLink(null, { type: "connected", session: SESSION, profile: B2_PROFILE });
  assert.equal(next.providers[0].provider, "b2");
  // the data client, handed such a link, still asks the gateway (which answers 409) and surfaces a fixed code
  globalThis.fetch = async () => reply(409, { error: "No ETF-flow provider key is connected." });
  try {
    await assert.rejects(() => fetchEtfLive(bucketOnly, new AbortController().signal), (e) => e.message === "gateway:409");
    await assert.rejects(() => fetchWhaleAlerts(bucketOnly, 1_000_000, new AbortController().signal), (e) => e.message === "gateway:409");
  } finally { cleanup(); }
});

test("secrets are never written to storage", async () => {
  const store = new Map();
  const writes = [];
  const fake = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { writes.push(`${k}=${v}`); store.set(k, String(v)); }, removeItem: (k) => store.delete(k), clear: () => store.clear(), key: () => null, length: 0 };
  Object.defineProperty(globalThis, "localStorage", { value: fake, configurable: true, writable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: fake, configurable: true, writable: true });
  globalThis.fetch = async () => reply(200, { profile: B2_PROFILE });
  try {
    const got = await connectProvider(SESSION, B2_INPUT);
    const all = JSON.stringify([...store.values(), ...writes, got]);
    assert.ok(!all.includes(SECRET) && !all.includes(KEY_ID));
    assert.equal(store.size, 0);
  } finally { cleanup(); }
});
