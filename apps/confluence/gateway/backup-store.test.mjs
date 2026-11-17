// WP28 Task 8: B2/R2 backup store over a fake S3. No test reaches the network. The key pair is AWS's public documentation example.
import { test } from "node:test";
import assert from "node:assert/strict";
import { B2_REGION_RE, BACKUP_FILE_RE, BACKUP_MAX_BYTES, BACKUP_PREFIX, R2_ACCOUNT_RE, getBackup, listBackups, putBackup, putDeadlineMs, s3Endpoint, verifyBucketKey } from "./backup-store.mjs";

const ACCESS = "AKIAIOSFODNN7EXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const NOW = () => new Date("2026-11-17T08:00:00Z");
const B2 = { provider: "b2", accessKeyId: ACCESS, secretAccessKey: SECRET, bucket: "rsl-backup-test", region: "us-west-004" };
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const R2 = { provider: "r2", accessKeyId: ACCESS, secretAccessKey: SECRET, bucket: "rsl-backup-test", accountId: ACCOUNT };
const N1 = "confluence-backup-20261117T080000Z.json";
const N2 = "confluence-backup-20261118T080000Z.json";

/** A tiny in-memory S3 (path style). `calls` records every request so tests can check what was signed and sent. */
function fakeS3(creds, { listBuckets = 403, headStatus = 200, buckets = [creds.bucket] } = {}) {
  const store = new Map();
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: String(url), method: init.method, headers: init.headers, redirect: init.redirect });
    assert.match(init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/(auto|us-west-004)\/s3\/aws4_request, SignedHeaders=.*Signature=[0-9a-f]{64}$/);
    const bucketPath = `/${creds.bucket}`;
    if (init.method === "HEAD" && u.pathname === bucketPath) return new Response(null, { status: headStatus });
    if (init.method === "GET" && u.pathname === "/") {
      return listBuckets === 200
        ? new Response(`<?xml version="1.0"?><ListAllMyBucketsResult><Buckets>${buckets.map((b) => `<Bucket><Name>${b}</Name></Bucket>`).join("")}</Buckets></ListAllMyBucketsResult>`, { status: 200 })
        : new Response("<Error><Code>AccessDenied</Code></Error>", { status: listBuckets });
    }
    if (init.method === "PUT" && u.pathname.startsWith(`${bucketPath}/${BACKUP_PREFIX}`)) {
      store.set(u.pathname.slice(bucketPath.length + 1), { text: Buffer.from(init.body).toString("utf8"), at: "2026-11-17T08:00:00.000Z" });
      return new Response(null, { status: 200 });
    }
    if (init.method === "GET" && u.pathname === bucketPath) {
      assert.equal(u.search, "?list-type=2&max-keys=1000&prefix=rsl-confluence%2F");
      const items = [...store].map(([k, v]) => `<Contents><Key>${k}</Key><LastModified>${v.at}</LastModified><Size>${Buffer.byteLength(v.text)}</Size></Contents>`);
      return new Response(`<ListBucketResult>${items.join("")}</ListBucketResult>`, { status: 200 });
    }
    if (init.method === "GET" && u.pathname.startsWith(`${bucketPath}/`)) {
      const hit = store.get(u.pathname.slice(bucketPath.length + 1));
      return hit ? new Response(hit.text, { status: 200 }) : new Response("<Error/>", { status: 404 });
    }
    return new Response("nope", { status: 400 });
  };
  return { fetcher, calls, store };
}

test("endpoints: B2 s3.<region>.backblazeb2.com, R2 <32 hex>.r2.cloudflarestorage.com; bad region or account id refused", () => {
  assert.deepEqual(s3Endpoint(B2), { host: "s3.us-west-004.backblazeb2.com", region: "us-west-004", origin: "https://s3.us-west-004.backblazeb2.com" });
  assert.deepEqual(s3Endpoint(R2), { host: `${ACCOUNT}.r2.cloudflarestorage.com`, region: "auto", origin: `https://${ACCOUNT}.r2.cloudflarestorage.com` });
  for (const bad of ["US-west-004", "us-west-04", "evil.example/x", "us-west-004.evil.example", "", "us-west-004:443"]) {
    assert.throws(() => s3Endpoint({ ...B2, region: bad }), /Invalid bucket key payload\./, bad);
  }
  for (const bad of [ACCOUNT.toUpperCase(), ACCOUNT.slice(1), `${ACCOUNT}.evil.example`, "g".repeat(32)]) {
    assert.throws(() => s3Endpoint({ ...R2, accountId: bad }), /Invalid bucket key payload\./, bad);
  }
  assert.throws(() => s3Endpoint({ provider: "s3" }), /Invalid bucket key payload\./);
});

test("round trip put -> list -> get on B2 and R2; calls are signed, redirect-manual and never carry the secret", async () => {
  for (const creds of [B2, R2]) {
    const { fetcher, calls } = fakeS3(creds);
    const deps = { fetcher, now: NOW };
    const text = JSON.stringify({ hello: "wörld", n: [1, 2, 3] });
    assert.deepEqual(await putBackup(creds, N1, text, deps), { name: N1, size: Buffer.byteLength(text), modifiedAt: "2026-11-17T08:00:00.000Z" });
    await putBackup(creds, N2, "{}", deps);
    const files = await listBackups(creds, deps);
    assert.deepEqual(files.map((f) => f.name), [N2, N1]);
    assert.equal(files[1].size, Buffer.byteLength(text));
    assert.equal(await getBackup(creds, N1, deps), text);
    const host = s3Endpoint(creds).host;
    for (const call of calls) {
      assert.equal(new URL(call.url).host, host);
      assert.equal(call.redirect, "manual");
      assert.ok(!JSON.stringify(call).includes(SECRET));
    }
    const put = calls[0];
    assert.equal(put.method, "PUT");
    assert.equal(new URL(put.url).pathname, `/rsl-backup-test/rsl-confluence/${N1}`);
    assert.equal(put.headers["content-type"], "application/json");
    assert.match(put.headers.authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date,/);
  }
});

test("object names: only BACKUP_PREFIX + a BACKUP_FILE_RE name is ever signed or sent", async () => {
  const { fetcher, calls } = fakeS3(B2);
  const deps = { fetcher, now: NOW };
  for (const bad of ["../x.json", "rsl-confluence/" + N1, N1 + "/..", `${N1}?x=1`, "confluence-backup-20261117T080000Z.json%2f..", "", "a/b", "confluence-backup-2026T0Z.json", null, undefined, 5, "..%2f" + N1]) {
    await assert.rejects(putBackup(B2, bad, "{}", deps), /Invalid backup name\./);
    await assert.rejects(getBackup(B2, bad, deps), /Invalid backup name\./);
  }
  assert.equal(calls.length, 0, "nothing was signed or sent");
  assert.equal(BACKUP_PREFIX, "rsl-confluence/");
  assert.equal(String(BACKUP_FILE_RE), String(/^confluence-backup-\d{8}T\d{6}Z\.json$/));
  assert.equal(BACKUP_MAX_BYTES, 20 * 1024 * 1024);
});

const contents = (key, size = 5, modified = "2026-11-17T08:00:00.000Z") =>
  `<Contents><Key>${key}</Key><LastModified>${modified}</LastModified><Size>${size}</Size></Contents>`;
const listOf = (...items) => async () => new Response(`<ListBucketResult>${items.join("")}</ListBucketResult>`, { status: 200 });

test("hostile list XML next to one valid entry: only that entry comes back, exactly", async () => {
  const hostile = [
    contents(`rsl-confluence/../${N1}`),
    contents(`other/${N1}`),
    contents(N1), // no prefix
    contents(`rsl-confluence/sub/${N1}`),
    contents(`rsl-confluence/${N1}.bak`),
    contents("rsl-confluence/<script>alert(1)</script>"),
    contents(`rsl-confluence/${N2}`, -5),
    contents(`rsl-confluence/${N2}`, "5; DROP"),
    contents(`rsl-confluence/${N2}`, 5, "not a date"),
    contents(`rsl-confluence/${N2}`, BACKUP_MAX_BYTES + 1),
    contents("rsl-confluence/confluence-backup-2026T0Z.json"),
    "<Contents><Key>rsl-confluence/" + N2 + "</Key></Contents>",
    "<Contents></Contents>",
  ];
  const fetcher = listOf(...hostile, contents(`rsl-confluence/${N1}`, 7, "2026-11-17T08:00:00.000Z"));
  assert.deepEqual(await listBackups(B2, { fetcher, now: NOW }), [{ name: N1, size: 7, modifiedAt: "2026-11-17T08:00:00.000Z" }]);
});

test("a listing of 5,000 valid entries is cut at the first 1,000 and returns at most 20, newest first", async () => {
  const entries = [];
  for (let i = 0; i < 5000; i++) {
    entries.push(contents(`rsl-confluence/confluence-backup-${20200101 + i}T000000Z.json`, 10, `2026-01-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00.000Z`));
  }
  const files = await listBackups(B2, { fetcher: listOf(...entries), now: NOW });
  assert.equal(files.length, 20);
  assert.ok(files.every((f, i) => i === 0 || files[i - 1].modifiedAt >= f.modifiedAt));
  assert.ok(files.every((f) => Number(f.name.slice(18, 26)) < 20200101 + 1000), "entries past the 1,000 cap are never read");
});

test("a list response larger than 2 MB is refused", async () => {
  const fetcher = async () => new Response("<ListBucketResult>" + "x".repeat(2 * 1024 * 1024 + 1) + "</ListBucketResult>", { status: 200 });
  await assert.rejects(listBackups(B2, { fetcher, now: NOW }), (e) => e.message === "The bucket did not accept the request.");
});

test("a download of 20 MB + 1 is refused by Content-Length and by the bytes actually read; exactly 20 MB is allowed", async () => {
  const deps = (make) => ({ fetcher: async () => make(), now: NOW });
  const header = new Response("x", { status: 200, headers: { "content-length": String(BACKUP_MAX_BYTES + 1) } });
  await assert.rejects(getBackup(B2, N1, deps(() => header)), (e) => e.message === "The bucket did not accept the request.");
  // No honest Content-Length: the stream is counted and cancelled.
  let cancelled = false;
  const stream = new ReadableStream({
    pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(getBackup(B2, N1, deps(() => new Response(stream, { status: 200 }))), (e) => e.message === "The bucket did not accept the request.");
  assert.ok(cancelled, "oversize stream is cancelled");
  const exact = "a".repeat(BACKUP_MAX_BYTES);
  assert.equal((await getBackup(B2, N1, deps(() => new Response(exact, { status: 200 })))).length, BACKUP_MAX_BYTES);
});

test("putBackup refuses a body over 20 MB before sending, and a non-2xx answer gives only the fixed message", async () => {
  const { fetcher, calls } = fakeS3(B2);
  await assert.rejects(putBackup(B2, N1, "a".repeat(BACKUP_MAX_BYTES + 1), { fetcher, now: NOW }), /Backup is larger than 20 MB\./);
  assert.equal(calls.length, 0);
  const failing = async () => new Response(`<Error><Message>secret ${SECRET} https://s3.us-west-004.backblazeb2.com</Message></Error>`, { status: 500 });
  await assert.rejects(putBackup(B2, N1, "{}", { fetcher: failing, now: NOW }), (e) => e.message === "The bucket did not accept the request.");
  const throwing = async () => { throw new Error(`boom ${SECRET} ${ACCESS} s3.us-west-004.backblazeb2.com`); };
  for (const op of [() => putBackup(B2, N1, "{}", { fetcher: throwing, now: NOW }), () => listBackups(B2, { fetcher: throwing, now: NOW }), () => getBackup(B2, N1, { fetcher: throwing, now: NOW })]) {
    await assert.rejects(op(), (e) => e.message === "The bucket did not accept the request." && !e.message.includes(SECRET) && !e.message.includes(ACCESS));
  }
});

test("verifyBucketKey: restricted key (HEAD 200, ListBuckets 403) and single-bucket ListBuckets are accepted", async () => {
  assert.deepEqual(await verifyBucketKey(B2, { ...fakeS3(B2), now: NOW }), { ok: true });
  assert.deepEqual(await verifyBucketKey(R2, { ...fakeS3(R2, { listBuckets: 200 }), now: NOW }), { ok: true });
});

test("verifyBucketKey refuses a key that can list other buckets, and any failure carries only a fixed message", async () => {
  const other = (e) => e.message === "This key can reach other buckets. Create a key restricted to one bucket.";
  await assert.rejects(verifyBucketKey(B2, { ...fakeS3(B2, { listBuckets: 200, buckets: ["rsl-backup-test", "someone-elses"] }), now: NOW }), other);
  await assert.rejects(verifyBucketKey(B2, { ...fakeS3(B2, { listBuckets: 200, buckets: ["someone-elses"] }), now: NOW }), other);
  await assert.rejects(verifyBucketKey(B2, { ...fakeS3(B2, { listBuckets: 200, buckets: [] }), now: NOW }), other);
  const rejected = (e) => e.message === "The provider rejected the key test." && !e.message.includes(SECRET);
  await assert.rejects(verifyBucketKey(B2, { ...fakeS3(B2, { headStatus: 403 }), now: NOW }), rejected);
  await assert.rejects(verifyBucketKey(B2, { ...fakeS3(B2, { headStatus: 404 }), now: NOW }), rejected);
  await assert.rejects(verifyBucketKey(B2, { ...fakeS3(B2, { listBuckets: 500 }), now: NOW }), rejected);
  await assert.rejects(verifyBucketKey(B2, { fetcher: async () => { throw new Error(`${SECRET} ${ACCESS}`); }, now: NOW }), rejected);
  const timeout = async () => { throw Object.assign(new Error(SECRET), { name: "TimeoutError" }); };
  await assert.rejects(verifyBucketKey(B2, { fetcher: timeout, now: NOW }), (e) => e.message === "The provider did not answer the key test in time.");
});

// Fix round 1: size-aware transfer deadlines. Real values are 10 s + bytes / 128 KiB/s (cap 5 min) for a PUT and 10 s to
// the headers, then 30 s idle, for a GET; the tests scale the same rules down to milliseconds.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hang = (init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted"))));

test("putDeadlineMs: 10 s + bytes / 128 KiB/s, capped at 5 minutes", () => {
  assert.equal(putDeadlineMs(0), 10_000);
  assert.equal(putDeadlineMs(128 * 1024), 11_000);
  assert.equal(putDeadlineMs(BACKUP_MAX_BYTES), 10_000 + 160_000);
  assert.equal(putDeadlineMs(10 * BACKUP_MAX_BYTES), 300_000);
});

test("a PUT slower than the base timeout succeeds when its size earns it more time; a stalled PUT fails with the fixed message", async () => {
  const body = "x".repeat(400);
  const slow = async (_url, init) => { await Promise.race([sleep(150), hang(init)]); return new Response(null, { status: 200 }); }; // base 50 ms + 400 B at 2000 B/s = 250 ms
  assert.equal((await putBackup(B2, N1, body, { fetcher: slow, now: NOW, timeoutMs: 50, bytesPerSecond: 2000 })).size, 400);
  const stalled = async (_url, init) => hang(init);
  const started = Date.now();
  await assert.rejects(putBackup(B2, N1, body, { fetcher: stalled, now: NOW, timeoutMs: 50, bytesPerSecond: 2000 }),
    (e) => e.message === "The bucket did not accept the request." && e.timedOut === true);
  assert.ok(Date.now() - started < 2000);
});

test("a GET whose body takes longer than the header timeout succeeds while chunks keep arriving; a stalled body fails", async () => {
  const chunked = (delays) => async () => new Response(new ReadableStream({
    async start(c) { for (const d of delays) { await sleep(d); c.enqueue(new TextEncoder().encode("ab")); } c.close(); },
  }), { status: 200 });
  // header timeout 40 ms, idle 120 ms: five chunks 60 ms apart take 300 ms in all.
  assert.equal(await getBackup(B2, N1, { fetcher: chunked([60, 60, 60, 60, 60]), now: NOW, timeoutMs: 40, idleMs: 120 }), "ababababab");
  let cancelled = false;
  const stalls = async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode("ab")); },
    cancel() { cancelled = true; },
  }), { status: 200 });
  await assert.rejects(getBackup(B2, N1, { fetcher: stalls, now: NOW, timeoutMs: 40, idleMs: 80 }),
    (e) => e.message === "The bucket did not accept the request." && e.timedOut === true);
  assert.ok(cancelled, "a stalled body is cancelled");
  await assert.rejects(getBackup(B2, N1, { fetcher: async (_u, init) => hang(init), now: NOW, timeoutMs: 40 }), (e) => e.timedOut === true);
});

test("a read error mid-body (socket reset, abort) becomes the fixed message, never the upstream text", async () => {
  const broken = async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode("ab")); },
    pull() { throw Object.assign(new TypeError(`terminated ${SECRET} s3.us-west-004.backblazeb2.com`), { cause: new Error(ACCESS) }); },
  }), { status: 200 });
  const fixed = (e) => e.message === "The bucket did not accept the request." && !e.message.includes(SECRET) && !e.message.includes("terminated");
  await assert.rejects(getBackup(B2, N1, { fetcher: broken, now: NOW }), fixed);
  await assert.rejects(listBackups(B2, { fetcher: broken, now: NOW }), fixed);
  const aborted = async () => new Response(new ReadableStream({ start(c) { c.error(new DOMException("x", "TimeoutError")); } }), { status: 200 });
  await assert.rejects(getBackup(B2, N1, { fetcher: aborted, now: NOW }), (e) => fixed(e) && e.timedOut === true);
});

test("the region and account-id patterns are exported and shared with provider validation", () => {
  assert.equal(String(B2_REGION_RE), String(/^[a-z]{2}-[a-z]+-\d{3}$/));
  assert.equal(String(R2_ACCOUNT_RE), String(/^[0-9a-f]{32}$/));
});
