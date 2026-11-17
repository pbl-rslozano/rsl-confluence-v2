import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BACKUP_FORMAT, BACKUP_MAX_FILE_BYTES, BACKUP_MAX_PLAIN_BYTES, PBKDF2_ITERATIONS, PBKDF2_MAX_ITERATIONS,
  MIN_PASSPHRASE_CHARS, OPEN_MIN_PASSPHRASE_CHARS, HEADER_MAX_BYTES, BACKUP_FILE_RE,
  BackupError, utf8Bytes, backupFileName, sealBackup, openBackup, readBackupHeader,
} from "./backup-crypto.ts";

const PASS = "correct horse battery staple";
const CREATED = Date.UTC(2026, 10, 17, 10, 15, 0);
const TEXT = JSON.stringify({ rows: [1, 2, 3], note: "café ✓" });
const OPTS = { createdAt: CREATED, app: "2.8.0" };

const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
const unb64u = (s) => new Uint8Array(Buffer.from(s, "base64url"));
const parts = (file) => JSON.parse(file);
const rebuild = (o) => JSON.stringify(o);

async function rejects(p, codes) {
  const list = Array.isArray(codes) ? codes : [codes];
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof BackupError, `expected BackupError, got ${e}`);
    assert.ok(list.includes(e.code), `expected ${list.join("|")}, got ${e.code}`);
    assert.equal(e.message, e.code);
    assert.ok(!JSON.stringify({ m: e.message, d: e.detail }).includes(PASS));
    return e;
  }
  assert.fail("expected a rejection");
}

let cached;
async function sample() {
  cached ??= await sealBackup(TEXT, PASS, OPTS);
  return cached;
}
function withHeader(file, patch) {
  const o = parts(file);
  const h = JSON.parse(new TextDecoder().decode(unb64u(o.h)));
  o.h = b64u(new TextEncoder().encode(JSON.stringify({ ...h, ...patch })));
  return rebuild(o);
}

test("constants", () => {
  assert.equal(BACKUP_FORMAT, "rsl-confluence-backup");
  assert.equal(BACKUP_MAX_FILE_BYTES, 20 * 1024 * 1024);
  assert.equal(BACKUP_MAX_PLAIN_BYTES, 160 * 1024 * 1024);
  assert.equal(PBKDF2_ITERATIONS, 600000);
  assert.equal(PBKDF2_MAX_ITERATIONS, 5000000);
  assert.equal(MIN_PASSPHRASE_CHARS, 12);
  assert.equal(OPEN_MIN_PASSPHRASE_CHARS, 12);
  assert.equal(HEADER_MAX_BYTES, 1024);
});

test("round trip returns the same text and header", async () => {
  const file = await sample();
  const o = parts(file);
  assert.deepEqual(Object.keys(o), ["format", "v", "h", "iv", "ct"]);
  const { plain, header } = await openBackup(file, PASS);
  assert.equal(plain, TEXT);
  assert.equal(header.iter, 600000);
  assert.equal(header.zip, "gzip");
  assert.equal(header.createdAt, CREATED);
  assert.equal(header.app, "2.8.0");
  assert.equal(header.cipher, "AES-256-GCM");
  assert.equal(header.kdf, "PBKDF2-SHA-256");
  assert.equal(unb64u(header.salt).length, 16);
  assert.deepEqual(Object.keys(header), ["schema", "cipher", "kdf", "iter", "salt", "zip", "createdAt", "app"]);
});

test("uncompressed round trip", async () => {
  const file = await sealBackup(TEXT, PASS, { ...OPTS, zip: "none" });
  const { plain, header } = await openBackup(file, PASS);
  assert.equal(plain, TEXT);
  assert.equal(header.zip, "none");
});

test("a flipped byte anywhere fails", async () => {
  const file = await sample();
  const o = parts(file);
  const flip = (field, idx) => {
    const bytes = unb64u(o[field]);
    bytes[idx < 0 ? bytes.length + idx : idx] ^= 0x01;
    return rebuild({ ...o, [field]: b64u(bytes) });
  };
  for (const [field, idx] of [["h", 5], ["iv", 0], ["ct", 0], ["ct", -1]]) {
    await rejects(openBackup(flip(field, idx), PASS), ["decrypt", "format"]);
  }
  // seeded pseudo-random single-character changes inside ct
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < 8; i++) {
    const ct = o.ct;
    const pos = rnd() % ct.length;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let ch = alphabet[rnd() % alphabet.length];
    if (ch === ct[pos]) ch = ch === "A" ? "B" : "A";
    await rejects(openBackup(rebuild({ ...o, ct: ct.slice(0, pos) + ch + ct.slice(pos + 1) }), PASS), ["decrypt", "format"]);
  }
});

test("the header is authenticated", async () => {
  await rejects(openBackup(withHeader(await sample(), { iter: 700000 }), PASS), "decrypt");
});

test("a wrong passphrase fails", async () => {
  await rejects(openBackup(await sample(), "correct horse battery stapler"), "decrypt");
});

test("oversize file is refused before parsing", async () => {
  const big = "a".repeat(BACKUP_MAX_FILE_BYTES + 1);
  const t0 = Date.now();
  await rejects(openBackup(big, PASS), "too-large-file");
  assert.ok(Date.now() - t0 < 200);
});

test("oversize backup is refused before upload", async () => {
  const { randomBytes } = await import("node:crypto");
  const plain = randomBytes(30 * 1024 * 1024).toString("base64"); // ~40 MB, incompressible
  const e = await rejects(sealBackup(plain, PASS, OPTS), "too-large-backup");
  assert.ok(e.detail.size > 20971520);
  assert.equal(e.detail.plain, undefined);
});

/** Test-only: builds a valid envelope straight from WebCrypto, bypassing sealBackup's own limits. */
async function gzipBytes(bytes) {
  const cs = new CompressionStream("gzip");
  const w = cs.writable.getWriter();
  const out = [];
  const reading = (async () => { for await (const c of cs.readable) out.push(c); })();
  for (let i = 0; i < bytes.length; i += 1 << 20) await w.write(bytes.subarray(i, i + (1 << 20)));
  await w.close();
  await reading;
  return new Uint8Array(Buffer.concat(out));
}
async function rawSeal(body, pass, headerPatch = {}) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header = { schema: 1, cipher: "AES-256-GCM", kdf: "PBKDF2-SHA-256", iter: 600000, salt: b64u(salt), zip: "gzip", createdAt: CREATED, app: "2.8.0", ...headerPatch };
  const hb = new TextEncoder().encode(JSON.stringify(header));
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: header.iter }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: hb, tagLength: 128 }, key, body));
  return JSON.stringify({ format: BACKUP_FORMAT, v: 1, h: b64u(hb), iv: b64u(iv), ct: b64u(ct) });
}

test("decompression bomb is stopped", async () => {
  const bomb = new Uint8Array(200 * 1024 * 1024).fill(48);
  const file = await rawSeal(await gzipBytes(bomb), PASS);
  assert.ok(utf8Bytes(file) < BACKUP_MAX_FILE_BYTES);
  await rejects(openBackup(file, PASS), "too-large-file");
});

test("the decompressor is fed in bounded slices and a bomb aborts early (Chromium inflates a whole chunk before the first read)", async () => {
  const bomb = new Uint8Array(400 * 1024 * 1024).fill(48);
  const gz = await gzipBytes(bomb);
  const file = await rawSeal(gz, PASS);
  const stats = { writes: 0, bytes: 0, maxChunk: 0 };
  const Real = globalThis.DecompressionStream;
  globalThis.DecompressionStream = class {
    constructor(fmt) {
      const ds = new Real(fmt);
      const w = ds.writable.getWriter();
      this.readable = ds.readable;
      this.writable = new WritableStream({
        write(chunk) { stats.writes++; stats.bytes += chunk.length; stats.maxChunk = Math.max(stats.maxChunk, chunk.length); return w.write(chunk); },
        close() { return w.close(); },
        abort(r) { return w.abort(r); },
      });
    }
  };
  try {
    await rejects(openBackup(file, PASS), "too-large-file");
  } finally {
    globalThis.DecompressionStream = Real;
  }
  assert.ok(stats.maxChunk <= 64 * 1024, `largest write was ${stats.maxChunk} bytes`);
  assert.ok(stats.writes > 1);
  assert.ok(stats.bytes < gz.length * 0.8, `consumed ${stats.bytes} of ${gz.length} gzip bytes before aborting`);
});

test("a corrupt gzip body still gives format with sliced writes", async () => {
  const gz = await gzipBytes(new TextEncoder().encode("x".repeat(100000)));
  gz[Math.floor(gz.length / 2)] ^= 0xff;
  await rejects(openBackup(await rawSeal(gz, PASS), PASS), "format");
});

test("seal refuses plain text over the 160 MB open limit", async () => {
  const e = await rejects(sealBackup("0".repeat(BACKUP_MAX_PLAIN_BYTES + 1), PASS, OPTS), "too-large-backup");
  assert.equal(e.detail.plain, BACKUP_MAX_PLAIN_BYTES + 1);
});

test("M-2 over the unpacked cap, both sizes are reported: the estimated encrypted file and the unpacked text", async () => {
  const plain = "0".repeat(BACKUP_MAX_PLAIN_BYTES + 1);
  const gz = await rejects(sealBackup(plain, PASS, OPTS), "too-large-backup");
  assert.equal(gz.detail.plain, BACKUP_MAX_PLAIN_BYTES + 1);
  assert.ok(gz.detail.size > 0 && gz.detail.size < 2 * 1024 * 1024, `zeros compress well: the file would be small (${gz.detail.size})`);
  const none = await rejects(sealBackup(plain, PASS, { ...OPTS, zip: "none" }), "too-large-backup");
  const b64 = Math.ceil((BACKUP_MAX_PLAIN_BYTES + 1 + 16) / 3) * 4;
  assert.ok(none.detail.size >= b64 && none.detail.size < b64 + 1024, `uncompressed estimate ${none.detail.size} vs ${b64}`);
  // under the unpacked cap but over 20 MB: the size is the encrypted file's own size, and there is no unpacked size
  const { randomBytes } = await import("node:crypto");
  const noisy = randomBytes(16 * 1024 * 1024).toString("base64");
  const file = await rejects(sealBackup(noisy, PASS, OPTS), "too-large-backup");
  assert.equal(file.detail.plain, undefined);
  assert.ok(file.detail.size > BACKUP_MAX_FILE_BYTES);
});

/** The longest stretch (ms) in which a 5 ms timer could not run while `fn` ran: the longest main-thread task. */
async function maxBlockMs(fn) {
  let max = 0;
  let last = performance.now();
  const iv = setInterval(() => { const n = performance.now(); max = Math.max(max, n - last); last = n; }, 5);
  try { await fn(); } finally { clearInterval(iv); }
  return Math.max(max, performance.now() - last);
}

test("M-1 sealing and opening a large backup never holds the event loop for 200 ms (key derivation and AES run off it)", async () => {
  // About 60 MB of ledger-like JSON with random numbers: it compresses roughly like a real ledger.
  // Built as one flat string (the 300,000 pieces are garbage straight away), so the heap holds what the app would.
  const piece = (i) => `{"id":"c1|binance|4h|P${i % 300}|${1794772800000 - i * 14400000}","c":${(Math.random() * 1000).toFixed(4)},"sc":${(Math.random() * 200 - 100).toFixed(2)},"v":${Math.round(Math.random() * 1e6)},"ft":${(Math.random() * 80 - 40).toFixed(1)},"oi":${(Math.random() * 5).toFixed(3)}}`;
  let plain = "[";
  for (let i = 0; i < 300_000; i++) plain += (i ? "," : "") + piece(i);
  plain = Buffer.from(plain + "]").toString(); // flatten the rope
  let file;
  const seal = await maxBlockMs(async () => { file = await sealBackup(plain, PASS, OPTS); });
  let back;
  const open = await maxBlockMs(async () => { back = await openBackup(file, PASS); });
  assert.equal(back.plain, plain);
  console.log(`# M-1 longest task: seal ${seal.toFixed(0)} ms, open ${open.toFixed(0)} ms (${(plain.length / 1048576).toFixed(1)} MB text, ${(file.length / 1048576).toFixed(1)} MB file)`);
  assert.ok(seal < 200, `seal held the event loop for ${seal.toFixed(0)} ms`);
  assert.ok(open < 200, `open held the event loop for ${open.toFixed(0)} ms`);
});

test("seal refuses a createdAt that open would refuse", async () => {
  for (const createdAt of [Date.UTC(2025, 11, 31), 0, CREATED + 0.5, NaN, Date.now() + 3 * 86400000]) {
    await rejects(sealBackup(TEXT, PASS, { ...OPTS, createdAt, zip: "none" }), "format");
  }
});

test("seal refuses an app string that open would refuse", async () => {
  for (const app of ["2.8.0+build", "v2.8\u00b7x", "x".repeat(41), "", "bad<app>"]) {
    await rejects(sealBackup(TEXT, PASS, { ...OPTS, app, zip: "none" }), "format");
  }
  const ok = await sealBackup(TEXT, PASS, { ...OPTS, app: "2.7.0 (build 20261111)", zip: "none" });
  assert.equal((await openBackup(ok, PASS)).header.app, "2.7.0 (build 20261111)");
});

test("every header field is authenticated: a changed header is refused after re-serialising the file", async () => {
  const file = await sample();
  const h = readBackupHeader(file);
  // fields that do not feed the key: only the GCM additional data can catch these
  await rejects(openBackup(withHeader(file, { createdAt: h.createdAt - 60000 }), PASS), "decrypt");
  await rejects(openBackup(withHeader(file, { createdAt: h.createdAt + 1 }), PASS), "decrypt");
  await rejects(openBackup(withHeader(file, { app: "2.9.0" }), PASS), "decrypt");
  await rejects(openBackup(withHeader(file, { zip: "none" }), PASS), ["decrypt", "format"]);
  // iterations (valid range) change the key as well
  await rejects(openBackup(withHeader(file, { iter: 600001 }), PASS), "decrypt");
  // schema/version: refused before any crypto
  await rejects(openBackup(withHeader(file, { schema: 2 }), PASS), "format");
  await rejects(openBackup(rebuild({ ...parts(file), v: 2 }), PASS), "format");
  // same header content, different JSON bytes (whitespace): the exact bytes are authenticated
  const o = parts(file);
  const hdr = JSON.parse(new TextDecoder().decode(unb64u(o.h)));
  await rejects(openBackup(rebuild({ ...o, h: b64u(new TextEncoder().encode(JSON.stringify(hdr, null, 1))) }), PASS), "decrypt");
});

test("structural rejects", async () => {
  const file = await sample();
  const o = parts(file);
  const cases = [
    "not json",
    '{"appId":"CONF"}',
    "[]",
    "null",
    rebuild({ ...o, extra: 1 }),
    rebuild({ format: o.format, v: o.v, h: o.h, iv: o.iv }),
    rebuild({ ...o, v: 2 }),
    rebuild({ ...o, format: "other" }),
    rebuild({ ...o, ct: o.ct + "=" }),
    rebuild({ ...o, iv: "***" }),
    withHeader(file, { schema: 2 }),
    withHeader(file, { iter: 599999 }),
    withHeader(file, { iter: 5000001 }),
    withHeader(file, { iter: 600000.5 }),
    withHeader(file, { createdAt: Date.now() + 2 * 86400000 }),
    withHeader(file, { createdAt: Date.UTC(2025, 11, 31) }),
    withHeader(file, { cipher: "AES-128-GCM" }),
    withHeader(file, { kdf: "PBKDF2-SHA-1" }),
    withHeader(file, { zip: "bzip" }),
    withHeader(file, { salt: b64u(new Uint8Array(8)) }),
    withHeader(file, { app: "bad<app>" }),
    withHeader(file, { app: "" }),
    rebuild({ ...o, iv: b64u(new Uint8Array(11)) }),
    rebuild({ ...o, ct: b64u(new Uint8Array(15)) }),
    rebuild({ ...o, h: b64u(new Uint8Array(HEADER_MAX_BYTES + 1).fill(32)) }),
    rebuild({ ...o, h: b64u(new TextEncoder().encode("not json")) }),
  ];
  for (const c of cases) {
    await rejects(openBackup(c, PASS), "format");
    assert.throws(() => readBackupHeader(c), (e) => e instanceof BackupError && e.code === "format");
  }
  assert.equal(readBackupHeader(file).iter, 600000);
});

test("short passphrase", async () => {
  await rejects(sealBackup(TEXT, "elevenchars", OPTS), "passphrase");
  await rejects(openBackup(await sample(), "short"), "passphrase");
  const ok = await sealBackup(TEXT, "twelve-chars", { ...OPTS, zip: "none" });
  assert.equal((await openBackup(ok, "twelve-chars")).plain, TEXT);
});

test("NFC: composed and decomposed passphrases open the same file", async () => {
  const composed = "café-passphrase";
  const decomposed = "café-passphrase";
  assert.notEqual(composed, decomposed);
  const file = await sealBackup(TEXT, composed, OPTS);
  assert.equal((await openBackup(file, decomposed)).plain, TEXT);
});

test("no CompressionStream writes zip none; a gzip file without DecompressionStream is unsupported", async () => {
  const gz = await sample();
  const cs = globalThis.CompressionStream;
  const ds = globalThis.DecompressionStream;
  try {
    delete globalThis.CompressionStream;
    delete globalThis.DecompressionStream;
    const file = await sealBackup(TEXT, PASS, OPTS);
    const { plain, header } = await openBackup(file, PASS);
    assert.equal(header.zip, "none");
    assert.equal(plain, TEXT);
    await rejects(openBackup(gz, PASS), "unsupported");
  } finally {
    globalThis.CompressionStream = cs;
    globalThis.DecompressionStream = ds;
  }
});

test("file name", () => {
  assert.equal(backupFileName(CREATED), "confluence-backup-20261117T101500Z.json");
  assert.ok(BACKUP_FILE_RE.test(backupFileName(CREATED)));
  assert.ok(!BACKUP_FILE_RE.test("confluence-backup-20261117.json"));
});

test("errors never carry the passphrase", async () => {
  const secret = "very-secret-passphrase-xyz";
  const file = await sealBackup(TEXT, secret, OPTS);
  const errs = [];
  for (const run of [
    () => openBackup(file, "wrong-secret-passphrase"),
    () => openBackup("not json", secret),
    () => openBackup("a".repeat(BACKUP_MAX_FILE_BYTES + 1), secret),
    () => sealBackup(TEXT, "short", OPTS),
  ]) {
    try { await run(); } catch (e) { errs.push(e); }
  }
  assert.equal(errs.length, 4);
  for (const e of errs) {
    const s = JSON.stringify({ m: e.message, d: e.detail, st: String(e.stack) });
    assert.ok(!s.includes(secret) && !s.includes("wrong-secret-passphrase"));
  }
});

test("the module never evaluates code", () => {
  const src = readFileSync(new URL("./backup-crypto.ts", import.meta.url), "utf8");
  for (const bad of ["eval(", "new Function", "innerHTML"]) assert.ok(!src.includes(bad), bad);
});
