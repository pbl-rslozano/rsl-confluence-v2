// v2.1 — origin policy for the localhost gateway (Tauri origins allowed; null/foreign refused).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const PORT = 18787 + Math.floor(Math.random() * 500);
const TOKEN = "test-token-0123456789abcdef";

async function withServer(fn, recorderDir = "", nodeArgs = []) {
  const child = spawn(process.execPath, [...nodeArgs, fileURLToPath(new URL("./server.mjs", import.meta.url))], {
    env: { ...process.env, CONFLUENCE_GATEWAY_PORT: String(PORT), CONFLUENCE_GATEWAY_TOKEN: TOKEN, CONFLUENCE_RECORDER_DIR: recorderDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(`http://127.0.0.1:${PORT}/profiles`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    await fn();
  } finally {
    child.kill();
  }
}

const get = (origin) => fetch(`http://127.0.0.1:${PORT}/profiles`, {
  headers: { ...(origin ? { Origin: origin } : {}), Authorization: `Bearer ${TOKEN}` },
});

test("gateway origin policy", async () => {
  await withServer(async () => {
    for (const ok of ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://127.0.0.1:8770"]) {
      const r = await get(ok);
      assert.equal(r.status, 200, `${ok} should be allowed`);
      assert.equal(r.headers.get("access-control-allow-origin"), ok);
    }
    for (const bad of ["null", "https://evil.example", "http://tauri.localhost.evil.example", "capacitor://localhost"]) {
      const r = await get(bad);
      assert.equal(r.status, 403, `${bad} should be refused`);
    }
    assert.equal((await get(null)).status, 403, "missing Origin is refused");
  });
});

test("recorder sync is opt-in, authenticated and uses fixed filenames", async () => {
  const dir = mkdtempSync(join(tmpdir(), "confluence-gateway-"));
  const headers = { Origin: "http://127.0.0.1:8770", Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" };
  const url = "http://127.0.0.1:" + PORT + "/recorder/";
  const rule = { id: "fixture", source: "binance", timeframe: "4h", symbols: ["BTCUSDT"], threshold: 70 };
  try {
    await withServer(async () => {
      assert.equal((await fetch(url + "inbox", { headers })).status, 404);
    });
    await withServer(async () => {
      assert.equal((await fetch(url + "inbox", { headers: { Origin: headers.Origin } })).status, 401);
      const bad = await fetch(url + "rules", { method: "POST", headers, body: JSON.stringify({ version: 1, rules: [{ ...rule, symbols: ["../x"] }] }) });
      assert.equal(bad.status, 400);
      const deployed = await fetch(url + "rules", { method: "POST", headers, body: JSON.stringify({ version: 1, rules: [rule] }) });
      assert.equal(deployed.status, 200);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "workspace-rules.json"), "utf8")).rules, [rule]);
      const second = { ...rule, id: "second", threshold: 55 };
      const updated = await fetch(url + "rules", { method: "POST", headers, body: JSON.stringify({ version: 1, rules: [second] }) });
      assert.equal(updated.status, 200);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "workspace-rules.json"), "utf8")).rules, [rule, second]);
      const inbox = { version: 1, events: [{ id: "fixture" }] };
      writeFileSync(join(dir, "workspace-inbox.json"), JSON.stringify(inbox));
      assert.deepEqual(await (await fetch(url + "inbox", { headers })).json(), inbox);
    }, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provider data routes answer 409 while no provider is connected", async () => {
  const headers = { Origin: "http://127.0.0.1:8770", Authorization: "Bearer " + TOKEN };
  const base = "http://127.0.0.1:" + PORT + "/providers/";
  await withServer(async () => {
    const etf = await fetch(base + "etf-flows", { headers });
    assert.equal(etf.status, 409);
    assert.deepEqual(await etf.json(), { error: "No ETF-flow provider key is connected." });
    const whale = await fetch(base + "whale-alerts?min=5000000", { headers });
    assert.equal(whale.status, 409);
    assert.equal((await fetch(base + "etf-flows", { headers: { Origin: headers.Origin } })).status, 401);
  });
});

const authHeaders = { Origin: "http://127.0.0.1:8770", Authorization: "Bearer " + TOKEN };
const MB20 = 20 * 1024 * 1024;
const NAME = "confluence-backup-20261117T080000Z.json";

test("backup upload has its own 20 MB limit; every other route keeps 32 KB; /backup/* needs the token", async () => {
  const base = "http://127.0.0.1:" + PORT;
  await withServer(async () => {
    const big = await fetch(`${base}/backup/upload?profile=none&name=${NAME}`, { method: "POST", headers: authHeaders, body: Buffer.alloc(MB20 + 1, 0x61) });
    assert.equal(big.status, 413);
    assert.deepEqual(await big.json(), { error: "Backup is larger than 20 MB." });
    const exact = await fetch(`${base}/backup/upload?name=${NAME}`, { method: "POST", headers: authHeaders, body: Buffer.alloc(MB20, 0x61) });
    assert.equal(exact.status, 409, "exactly 20 MB is accepted for reading; no profile -> 409");
    assert.deepEqual(await exact.json(), { error: "No backup bucket key is connected." });
    const json = { ...authHeaders, "Content-Type": "application/json" };
    const tooBig = await fetch(`${base}/providers/connect`, { method: "POST", headers: json, body: JSON.stringify({ provider: "coinglass", apiKey: "x".repeat(33 * 1024) }) });
    assert.equal(tooBig.status, 400);
    assert.deepEqual(await tooBig.json(), { error: "Request is too large." });
    assert.equal((await fetch(`${base}/backup/list?profile=none`, { headers: { Origin: authHeaders.Origin } })).status, 401);
    assert.equal((await fetch(`${base}/backup/list?profile=none`, { headers: { Authorization: authHeaders.Authorization } })).status, 403, "origin check applies");
    for (const [method, path] of [["GET", "/backup/list?profile=00000000-0000-0000-0000-000000000000"], ["GET", `/backup/download?profile=x&name=${NAME}`]]) {
      assert.equal((await fetch(base + path, { method, headers: authHeaders })).status, 409, path);
    }
    assert.equal((await fetch(`${base}/backup/nope`, { headers: authHeaders })).status, 404);
    assert.equal((await fetch(`${base}/backup/list`, { method: "POST", headers: authHeaders, body: "{}" })).status, 404);
    const options = await fetch(`${base}/backup/upload`, { method: "OPTIONS", headers: authHeaders });
    assert.equal(options.headers.get("access-control-allow-methods"), "GET,POST,DELETE,OPTIONS", "CORS methods are unchanged");
  });
});

test("backup routes end to end against a fake S3 (no network): connect, upload, list, download, errors, disconnect", async () => {
  const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  const dir = mkdtempSync(join(tmpdir(), "confluence-gateway-s3-"));
  const preload = join(dir, "fake-s3.mjs");
  // Replaces fetch inside the spawned gateway only. Same hosts and paths as the real S3 API; keeps objects in memory.
  writeFileSync(preload, `
    const objects = new Map();
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      if (u.protocol !== "https:" || u.host !== "s3.us-west-004.backblazeb2.com" || init.redirect !== "manual") return new Response("no", { status: 599 });
      if (!/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\\//.test(init.headers.authorization) || JSON.stringify(init).includes(${JSON.stringify(SECRET)})) return new Response("unsigned", { status: 598 });
      const bucket = u.pathname.split("/")[1];
      if (init.method === "HEAD") return new Response(null, { status: 200 });
      if (init.method === "GET" && u.pathname === "/") {
        return process.env.FAKE_OTHER_BUCKETS === "1"
          ? new Response("<ListAllMyBucketsResult><Bucket><Name>rsl-backup-test</Name></Bucket><Bucket><Name>other</Name></Bucket></ListAllMyBucketsResult>", { status: 200 })
          : new Response("denied", { status: 403 });
      }
      const key = u.pathname.slice(1 + bucket.length + 1);
      if (init.method === "PUT") {
        if (key.includes("20261231")) return new Response("boom ${SECRET}", { status: 500 });
        objects.set(key, Buffer.from(init.body));
        return new Response(null, { status: 200 });
      }
      if (init.method === "GET" && u.pathname === "/" + bucket) {
        return new Response("<ListBucketResult>" + [...objects].map(([k, v]) => "<Contents><Key>" + k + "</Key><LastModified>2026-11-17T08:00:00.000Z</LastModified><Size>" + v.length + "</Size></Contents>").join("") + "</ListBucketResult>", { status: 200 });
      }
      if (init.method === "GET") return objects.has(key) ? new Response(objects.get(key), { status: 200 }) : new Response("missing", { status: 404 });
      return new Response("no", { status: 400 });
    };
  `);
  const base = "http://127.0.0.1:" + PORT;
  const json = { ...authHeaders, "Content-Type": "application/json" };
  const payload = { provider: "b2", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: SECRET, bucket: "rsl-backup-test", region: "us-west-004" };
  try {
    await withServer(async () => {
      const connected = await fetch(`${base}/providers/connect`, { method: "POST", headers: json, body: JSON.stringify(payload) });
      assert.equal(connected.status, 200);
      const { profile } = await connected.json();
      assert.equal(profile.bucket, "rsl-backup-test");
      assert.ok(!JSON.stringify(profile).includes(SECRET));
      const listing = await (await fetch(`${base}/providers`, { headers: authHeaders })).text();
      assert.ok(!listing.includes(SECRET) && !listing.includes("AKIAIOSFODNN7EXAMPLE"));
      const q = (name) => `profile=${profile.id}&name=${name}`;
      const text = JSON.stringify({ v: 1, data: "ünï" });
      const up = await fetch(`${base}/backup/upload?${q(NAME)}`, { method: "POST", headers: authHeaders, body: text });
      assert.equal(up.status, 200);
      const uploaded = await up.json();
      assert.deepEqual({ name: uploaded.name, size: uploaded.size }, { name: NAME, size: Buffer.byteLength(text) });
      assert.ok(!Number.isNaN(Date.parse(uploaded.modifiedAt)));
      const list = await (await fetch(`${base}/backup/list?profile=${profile.id}`, { headers: authHeaders })).json();
      assert.deepEqual(list.files.map((f) => f.name), [NAME]);
      const down = await fetch(`${base}/backup/download?${q(NAME)}`, { headers: authHeaders });
      assert.equal(down.status, 200);
      assert.equal(down.headers.get("content-type"), "application/json; charset=utf-8");
      assert.equal(await down.text(), text);
      for (const bad of ["../x.json", "x.json", "rsl-confluence%2F" + NAME, ""]) {
        assert.equal((await fetch(`${base}/backup/upload?${q(bad)}`, { method: "POST", headers: authHeaders, body: "{}" })).status, 400, bad);
        assert.equal((await fetch(`${base}/backup/download?${q(bad)}`, { headers: authHeaders })).status, 400, bad);
      }
      // Early refusals do not wait for the body; a chunked body (no Content-Length) is counted as it streams.
      assert.equal((await fetch(`${base}/backup/upload?${q("bad.json")}`, { method: "POST", headers: authHeaders, body: Buffer.alloc(2 * 1024 * 1024, 0x61) })).status, 400);
      assert.equal((await fetch(`${base}/backup/upload?profile=00000000-0000-0000-0000-000000000000&name=${NAME}`, { method: "POST", headers: authHeaders, body: Buffer.alloc(2 * 1024 * 1024, 0x61) })).status, 409);
      let sent = 0;
      const chunked = new ReadableStream({ pull(c) { if (sent > MB20) c.close(); else { sent += 1024 * 1024; c.enqueue(new Uint8Array(1024 * 1024)); } } });
      const streamed = await fetch(`${base}/backup/upload?${q(NAME)}`, { method: "POST", headers: authHeaders, body: chunked, duplex: "half" });
      assert.equal(streamed.status, 413);
      assert.deepEqual(await streamed.json(), { error: "Backup is larger than 20 MB." });
      const failed = await fetch(`${base}/backup/upload?${q("confluence-backup-20261231T000000Z.json")}`, { method: "POST", headers: authHeaders, body: "{}" });
      assert.equal(failed.status, 502);
      const failedText = await failed.text();
      assert.equal(failedText, JSON.stringify({ error: "The bucket did not accept the request." }));
      assert.equal((await fetch(`${base}/backup/download?${q("confluence-backup-20200101T000000Z.json")}`, { headers: authHeaders })).status, 502);
      assert.equal((await fetch(`${base}/providers/${profile.id}`, { method: "DELETE", headers: authHeaders })).status, 200);
      assert.equal((await fetch(`${base}/backup/list?profile=${profile.id}`, { headers: authHeaders })).status, 409, "disconnected key is gone");
    }, "", ["--import", pathToFileURL(preload).href]);
    // A key that can list another bucket is refused at connect, with the fixed message and no secret.
    process.env.FAKE_OTHER_BUCKETS = "1";
    await withServer(async () => {
      const refused = await fetch(`${base}/providers/connect`, { method: "POST", headers: json, body: JSON.stringify(payload) });
      assert.equal(refused.status, 400);
      const text = await refused.text();
      assert.equal(text, JSON.stringify({ error: "This key can reach other buckets. Create a key restricted to one bucket." }));
    }, "", ["--import", pathToFileURL(preload).href]);
  } finally {
    delete process.env.FAKE_OTHER_BUCKETS;
    rmSync(dir, { recursive: true, force: true });
  }
});
