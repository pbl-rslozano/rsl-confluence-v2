/**
 * Encrypted-backup store on the user's own bucket (v2.8 WP28 Task 8): Backblaze B2 and Cloudflare R2 over the S3 API,
 * path style, signed with SigV4 (s3-sign.mjs). The file is already encrypted by the app; this module only moves bytes.
 *
 * Rules held here:
 *   - An object key is BACKUP_PREFIX + a BACKUP_FILE_RE name, checked before anything is signed. No other key exists.
 *   - Nothing thrown from here carries a key, a URL or upstream text: every failure becomes one of a few fixed messages.
 *   - Redirects are never followed (a redirect would carry the signed request elsewhere).
 *   - Bodies are capped (20 MB for a backup, 2 MB for a listing or a ListBuckets answer).
 */
import { encodePath, canonicalQuery, sha256Hex, signS3Request } from "./s3-sign.mjs";

export const BACKUP_PREFIX = "rsl-confluence/";
/** Same literal as the web app (apps/confluence/web/src/lib/backup-crypto.ts). */
export const BACKUP_FILE_RE = /^confluence-backup-\d{8}T\d{6}Z\.json$/;
export const BACKUP_MAX_BYTES = 20 * 1024 * 1024;

const XML_MAX_BYTES = 2 * 1024 * 1024;
const LIST_MAX_ENTRIES = 1000;
const LIST_RETURNED = 20;

const BAD_PAYLOAD = "Invalid bucket key payload.";
const OTHER_BUCKETS = "This key can reach other buckets. Create a key restricted to one bucket.";
const KEY_REJECTED = "The provider rejected the key test.";
const KEY_TIMED_OUT = "The provider did not answer the key test in time.";
export const BUCKET_FAILED = "The bucket did not accept the request.";

const B2_REGION_RE = /^[a-z]{2}-[a-z]+-\d{3}$/;
const R2_ACCOUNT_RE = /^[0-9a-f]{32}$/;

/**
 * The S3 endpoint of a bucket key. The two https literals are the egress templates tools/check-egress.mjs allows for
 * the gateway (`hostTemplates`); keep them exactly as written.
 */
export function s3Endpoint(creds) {
  if (creds?.provider === "b2") {
    const region = creds.region;
    if (typeof region !== "string" || !B2_REGION_RE.test(region)) throw new Error(BAD_PAYLOAD);
    return { host: `s3.${region}.backblazeb2.com`, region, origin: `https://s3.${region}.backblazeb2.com` };
  }
  if (creds?.provider === "r2") {
    const accountId = creds.accountId;
    if (typeof accountId !== "string" || !R2_ACCOUNT_RE.test(accountId)) throw new Error(BAD_PAYLOAD);
    return { host: `${accountId}.r2.cloudflarestorage.com`, region: "auto", origin: `https://${accountId}.r2.cloudflarestorage.com` };
  }
  throw new Error(BAD_PAYLOAD);
}

const validName = (name) => typeof name === "string" && BACKUP_FILE_RE.test(name);
function requireName(name) {
  if (!validName(name)) throw new Error("Invalid backup name.");
  return name;
}

/** Signs and sends one request. Throws only {name: "TimeoutError"} or a fixed-message Error, never upstream text. */
async function s3Call(creds, { method, path, query = {}, body = null, contentType = "" }, { fetcher = fetch, now = () => new Date(), timeoutMs = 10_000 }) {
  const { host, region, origin } = s3Endpoint(creds);
  const payload = body === null ? "" : body;
  const extra = contentType ? { "content-type": contentType } : {};
  const signed = signS3Request({
    method, host, path, query, headers: extra, payloadHash: sha256Hex(payload),
    accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, region, now: now(),
  });
  const { host: _host, ...headers } = signed; // fetch sets Host itself, from the same URL
  const qs = canonicalQuery(query);
  try {
    return await fetcher(origin + encodePath(path) + (qs ? `?${qs}` : ""), {
      method, headers: { ...extra, ...headers }, ...(body === null ? {} : { body }), redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw Object.assign(new Error(BUCKET_FAILED), { timedOut: error?.name === "TimeoutError" || error?.name === "AbortError" });
  }
}

async function release(response) {
  try { await response?.body?.cancel(); } catch { /* already released */ }
}

/** Reads at most `max` bytes; null when the body is larger (Content-Length or bytes read). */
async function readCapped(response, max) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > max) { await release(response); return null; }
  if (!response.body?.getReader) {
    const text = await response.text();
    return Buffer.byteLength(text) > max ? null : Buffer.from(text, "utf8");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { try { await reader.cancel(); } catch { /* closed */ } return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function readXml(response) {
  const bytes = await readCapped(response, XML_MAX_BYTES);
  if (!bytes) throw new Error(BUCKET_FAILED);
  return bytes.toString("utf8");
}

const keyPath = (creds, name) => `/${creds.bucket}/${BACKUP_PREFIX}${requireName(name)}`;

/**
 * Key test: HEAD /<bucket> must be 200, and the key must not be able to list other buckets (ListBuckets 403, or 200
 * naming only this bucket). Everything else is one of two fixed messages.
 */
export async function verifyBucketKey(creds, deps = {}) {
  const failure = (error) => new Error(error?.timedOut ? KEY_TIMED_OUT : KEY_REJECTED);
  let head;
  try { head = await s3Call(creds, { method: "HEAD", path: `/${creds.bucket}` }, deps); } catch (error) { throw failure(error); }
  await release(head);
  if (head?.status !== 200) throw new Error(KEY_REJECTED);
  let list;
  try { list = await s3Call(creds, { method: "GET", path: "/" }, deps); } catch (error) { throw failure(error); }
  if (list?.status === 403) { await release(list); return { ok: true }; }
  if (list?.status !== 200) { await release(list); throw new Error(KEY_REJECTED); }
  let xml;
  try { xml = await readXml(list); } catch { throw new Error(KEY_REJECTED); }
  const names = [...xml.matchAll(/<Name>([^<]*)<\/Name>/g)].map((m) => m[1]);
  if (names.length !== 1 || names[0] !== creds.bucket) throw new Error(OTHER_BUCKETS);
  return { ok: true };
}

export async function putBackup(creds, name, text, deps = {}) {
  const path = keyPath(creds, name);
  const body = Buffer.isBuffer(text) ? text : Buffer.from(String(text), "utf8"); // bytes pass through untouched
  if (body.length > BACKUP_MAX_BYTES) throw new Error("Backup is larger than 20 MB.");
  const response = await s3Call(creds, { method: "PUT", path, body, contentType: "application/json" }, deps);
  await release(response);
  if (!response?.ok) throw new Error(BUCKET_FAILED);
  return { name, size: body.length, modifiedAt: (deps.now ? deps.now() : new Date()).toISOString() };
}

export async function listBackups(creds, deps = {}) {
  const response = await s3Call(creds, {
    method: "GET", path: `/${creds.bucket}`, query: { "list-type": "2", prefix: BACKUP_PREFIX, "max-keys": String(LIST_MAX_ENTRIES) },
  }, deps);
  if (!response?.ok) { await release(response); throw new Error(BUCKET_FAILED); }
  const xml = await readXml(response);
  const files = [];
  let seen = 0;
  for (const block of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    if (++seen > LIST_MAX_ENTRIES) break;
    const key = block[1].match(/<Key>([^<]*)<\/Key>/)?.[1] ?? "";
    const size = block[1].match(/<Size>(\d{1,12})<\/Size>/)?.[1];
    const modified = Date.parse(block[1].match(/<LastModified>([^<]{1,40})<\/LastModified>/)?.[1] ?? "");
    if (!key.startsWith(BACKUP_PREFIX) || !validName(key.slice(BACKUP_PREFIX.length)) || size === undefined || Number.isNaN(modified)) continue;
    if (Number(size) > BACKUP_MAX_BYTES) continue; // could never be restored
    files.push({ name: key.slice(BACKUP_PREFIX.length), size: Number(size), modifiedAt: new Date(modified).toISOString() });
  }
  files.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : a.name < b.name ? 1 : -1));
  return files.slice(0, LIST_RETURNED);
}

export async function getBackup(creds, name, deps = {}) {
  const path = keyPath(creds, name);
  const response = await s3Call(creds, { method: "GET", path }, deps);
  if (!response?.ok) { await release(response); throw new Error(BUCKET_FAILED); }
  const bytes = await readCapped(response, BACKUP_MAX_BYTES);
  if (!bytes) throw new Error(BUCKET_FAILED);
  return bytes.toString("utf8");
}
