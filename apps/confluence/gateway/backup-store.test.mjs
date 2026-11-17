// WP28 Task 8: B2/R2 backup store over a fake S3. No test reaches the network. The key pair is AWS's public documentation example.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKUP_FILE_RE, BACKUP_MAX_BYTES, BACKUP_PREFIX, getBackup, listBackups, putBackup, s3Endpoint, verifyBucketKey } from "./backup-store.mjs";

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

test("hostile list XML: 5,000 entries, traversal keys, markup, negative sizes -> at most 20 valid, newest first", async () => {
  const entries = [];
  for (let i = 0; i < 5000; i++) {
    const d = String(20200101 + i).slice(0, 8);
    entries.push(`<Contents><Key>rsl-confluence/confluence-backup-${d}T000000Z.json</Key><LastModified>2026-01-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00.000Z</LastModified><Size>10</Size></Contents>`);
  }
  entries.push(
    "<Contents><Key>rsl-confluence/../confluence-backup-20261117T080000Z.json</Key><LastModified>2026-11-17T08:00:00.000Z</LastModified><Size>5</Size></Contents>",
    "<Contents><Key>other/confluence-backup-20261117T080000Z.json</Key><LastModified>2026-11-17T08:00:00.000Z</LastModified><Size>5</Size></Contents>",
    "<Contents><Key><script>alert(1)</script></Key><LastModified>2026-11-17T08:00:00.000Z</LastModified><Size>5</Size></Contents>",
    `<Contents><Key>rsl-confluence/${N1}</Key><LastModified>2026-11-17T08:00:00.000Z</LastModified><Size>-5</Size></Contents>`,
    `<Contents><Key>rsl-confluence/${N1}</Key><LastModified>not a date</LastModified><Size>5</Size></Contents>`,
  );
  const fetcher = async () => new Response(`<ListBucketResult>${entries.join("")}</ListBucketResult>`, { status: 200 });
  const files = await listBackups(B2, { fetcher, now: NOW });
  assert.ok(files.length <= 20 && files.length > 0);
  for (const f of files) {
    assert.match(f.name, BACKUP_FILE_RE);
    assert.ok(Number.isInteger(f.size) && f.size >= 0);
    assert.ok(!Number.isNaN(Date.parse(f.modifiedAt)));
  }
  assert.ok(files.every((f, i) => i === 0 || files[i - 1].modifiedAt >= f.modifiedAt));
  // Only the first 1,000 <Contents> are even looked at.
  assert.ok(files.every((f) => Number(f.name.slice(18, 26)) < 20200101 + 1000));
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
