import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BACKUP_FORMAT, BACKUP_MAX_FILE_BYTES, BACKUP_MAX_PLAIN_BYTES, PBKDF2_ITERATIONS, PBKDF2_MAX_ITERATIONS,
  MIN_PASSPHRASE_CHARS, HEADER_MAX_BYTES, BACKUP_FILE_RE,
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
});

test("decompression bomb is stopped", async () => {
  const bomb = "0".repeat(200 * 1024 * 1024);
  const file = await sealBackup(bomb, PASS, OPTS);
  assert.ok(utf8Bytes(file) < BACKUP_MAX_FILE_BYTES);
  await rejects(openBackup(file, PASS), "too-large-file");
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
