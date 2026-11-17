/**
 * backup-crypto.ts — v2.8 (WP28 Task 1): the encrypted backup envelope. Pure code, WebCrypto only.
 *
 * AES-256-GCM (96-bit IV, 128-bit tag); key from PBKDF2-SHA-256 with 600,000 iterations
 * (OWASP Password Storage Cheat Sheet, "PBKDF2-HMAC-SHA256: 600,000 iterations", read 17 Nov 2026).
 * The header bytes are the GCM additional data, so they are authenticated.
 *
 * Outer text: {"format":"rsl-confluence-backup","v":1,"h":<b64url header>,"iv":<b64url>,"ct":<b64url ct||tag>}.
 * The passphrase is never stored, logged or put in an error. Nothing here evaluates code.
 */

export const BACKUP_FORMAT = "rsl-confluence-backup";
export const BACKUP_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const BACKUP_MAX_PLAIN_BYTES = 160 * 1024 * 1024;
export const PBKDF2_ITERATIONS = 600_000;
export const PBKDF2_MAX_ITERATIONS = 5_000_000;
export const MIN_PASSPHRASE_CHARS = 12;
/**
 * Frozen floor applied when OPENING a file. It must never exceed the lowest minimum any released seal accepted,
 * so raising MIN_PASSPHRASE_CHARS later never locks anyone out of an older backup.
 */
export const OPEN_MIN_PASSPHRASE_CHARS = 12;
export const HEADER_MAX_BYTES = 1024;
export const BACKUP_FILE_RE = /^confluence-backup-\d{8}T\d{6}Z\.json$/;

export type BackupErrorCode =
  | "too-large-backup" | "too-large-file" | "format" | "schema" | "decrypt" | "passphrase" | "unsupported"
  | "not-set-up" | "unavailable" | "sign-in" | "state" | "session" | "network" | "http" | "download-host"
  | "port-busy" | "timeout" | "cancelled" | "gateway" | "needs-gateway" | "partial";

/** The one error vocabulary for backup. `detail` holds only sizes, statuses, provider ids or origins. */
export class BackupError extends Error {
  code: BackupErrorCode;
  detail: Record<string, string | number>;
  constructor(code: BackupErrorCode, detail: Record<string, string | number> = {}) {
    super(code);
    this.name = "BackupError";
    this.code = code;
    this.detail = detail;
  }
}

export interface EnvelopeHeader {
  schema: 1;
  cipher: "AES-256-GCM";
  kdf: "PBKDF2-SHA-256";
  iter: number;
  salt: string;
  zip: "gzip" | "none";
  createdAt: number;
  app: string;
}

const MIN_CREATED_AT = Date.UTC(2026, 0, 1);
const DAY_MS = 86_400_000;
const APP_RE = /^[0-9A-Za-z .()-]{1,40}$/;
const B64URL_RE = /^[A-Za-z0-9_-]*$/;
const HEADER_KEYS = ["schema", "cipher", "kdf", "iter", "salt", "zip", "createdAt", "app"];
const OUTER_KEYS = ["format", "v", "h", "iv", "ct"];

const enc = new TextEncoder();
/** Input is fed to (de)compression in slices this size, so the output cap bounds memory in every engine. */
const PIPE_SLICE_BYTES = 16 * 1024;

export function utf8Bytes(s: string): number {
  return enc.encode(s).length;
}

export function backupFileName(createdAt: number): string {
  const iso = new Date(createdAt).toISOString(); // 2026-11-17T10:15:00.000Z
  return `confluence-backup-${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z.json`;
}

function toB64u(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict, canonical, unpadded base64url; anything else is a "format" error. */
function fromB64u(s: unknown): Uint8Array {
  if (typeof s !== "string" || !B64URL_RE.test(s) || s.length % 4 === 1) throw new BackupError("format");
  let bin: string;
  try {
    bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  } catch {
    throw new BackupError("format");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  if (toB64u(out) !== s) throw new BackupError("format"); // non-zero trailing bits
  return out;
}

function checkPassphrase(passphrase: string, min: number): string {
  const p = typeof passphrase === "string" ? passphrase.normalize("NFC") : "";
  if ([...p].length < min) throw new BackupError("passphrase");
  return p;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iter: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase) as BufferSource, "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: iter },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Runs `bytes` through a (de)compression stream. The input is written in PIPE_SLICE_BYTES slices while the output is read
 * concurrently. Chromium inflates a whole written chunk before it enqueues any output, so a single big write would put the
 * entire decompressed bomb in memory before the cap is ever checked. Aborts as soon as the output passes `cap`.
 */
async function pipeBytes(bytes: Uint8Array, transform: CompressionStream | DecompressionStream, cap: number): Promise<Uint8Array[]> {
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  let stop = false;
  void (async () => {
    try {
      for (let i = 0; i < bytes.length && !stop; i += PIPE_SLICE_BYTES) {
        await writer.write(bytes.subarray(i, i + PIPE_SLICE_BYTES) as BufferSource);
      }
      if (!stop) await writer.close();
    } catch {
      /* surfaced through the reader */
    }
  })();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) throw new BackupError("too-large-file", { size: total });
      chunks.push(value);
    }
  } catch (e) {
    stop = true;
    await reader.cancel().catch(() => {});
    await writer.abort().catch(() => {});
    throw e;
  }
  return chunks;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

export async function sealBackup(
  plain: string,
  passphrase: string,
  opts: { createdAt: number; app: string; zip?: "gzip" | "none" },
): Promise<string> {
  const pass = checkPassphrase(passphrase, MIN_PASSPHRASE_CHARS);
  const zip = opts.zip ?? (typeof globalThis.CompressionStream === "function" ? "gzip" : "none");
  if (zip === "gzip" && typeof globalThis.CompressionStream !== "function") throw new BackupError("unsupported");

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header: EnvelopeHeader = {
    schema: 1, cipher: "AES-256-GCM", kdf: "PBKDF2-SHA-256", iter: PBKDF2_ITERATIONS,
    salt: toB64u(salt), zip, createdAt: opts.createdAt, app: opts.app,
  };
  // Exactly the rules openBackup applies, so seal never writes a backup that open will always refuse.
  validateHeader(header as unknown as Record<string, unknown>, Date.now());
  let body: Uint8Array = enc.encode(plain);
  if (body.length > BACKUP_MAX_PLAIN_BYTES) throw new BackupError("too-large-backup", { size: body.length });
  if (zip === "gzip") body = concat(await pipeBytes(body, new CompressionStream("gzip"), Infinity));

  const headerBytes = enc.encode(JSON.stringify(header));
  let ct: Uint8Array;
  try {
    const key = await deriveKey(pass, salt, PBKDF2_ITERATIONS);
    ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: headerBytes as BufferSource, tagLength: 128 }, key, body as BufferSource));
  } catch {
    throw new BackupError("unsupported");
  }
  const file = JSON.stringify({ format: BACKUP_FORMAT, v: 1, h: toB64u(headerBytes), iv: toB64u(iv), ct: toB64u(ct) });
  const size = utf8Bytes(file);
  if (size > BACKUP_MAX_FILE_BYTES) throw new BackupError("too-large-backup", { size });
  return file;
}

/** The one header rule set, used by seal and open. Returns the decoded salt. Throws "format". */
function validateHeader(r: Record<string, unknown>, now: number): Uint8Array {
  const hk = Object.keys(r);
  if (hk.length !== HEADER_KEYS.length || !HEADER_KEYS.every((k) => hk.includes(k))) throw new BackupError("format");
  const iter = r.iter;
  const created = r.createdAt;
  if (
    r.schema !== 1 || r.cipher !== "AES-256-GCM" || r.kdf !== "PBKDF2-SHA-256" ||
    typeof iter !== "number" || !Number.isInteger(iter) || iter < PBKDF2_ITERATIONS || iter > PBKDF2_MAX_ITERATIONS ||
    (r.zip !== "gzip" && r.zip !== "none") ||
    typeof created !== "number" || !Number.isInteger(created) || created < MIN_CREATED_AT || created > now + DAY_MS ||
    typeof r.app !== "string" || !APP_RE.test(r.app)
  ) throw new BackupError("format");
  const salt = fromB64u(r.salt);
  if (salt.length !== 16) throw new BackupError("format");
  return salt;
}

interface Parsed { header: EnvelopeHeader; headerBytes: Uint8Array; salt: Uint8Array; iv: Uint8Array; ct: Uint8Array }

function parseEnvelope(fileText: string, now: number): Parsed {
  if (typeof fileText !== "string") throw new BackupError("format");
  const size = utf8Bytes(fileText);
  if (size > BACKUP_MAX_FILE_BYTES) throw new BackupError("too-large-file", { size });
  let outer: unknown;
  try { outer = JSON.parse(fileText); } catch { throw new BackupError("format"); }
  if (typeof outer !== "object" || outer === null || Array.isArray(outer)) throw new BackupError("format");
  const o = outer as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== OUTER_KEYS.length || !OUTER_KEYS.every((k) => keys.includes(k))) throw new BackupError("format");
  if (o.format !== BACKUP_FORMAT || o.v !== 1) throw new BackupError("format");

  const headerBytes = fromB64u(o.h);
  const iv = fromB64u(o.iv);
  const ct = fromB64u(o.ct);
  if (headerBytes.length > HEADER_MAX_BYTES) throw new BackupError("format");
  let h: unknown;
  try { h = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(headerBytes)); } catch { throw new BackupError("format"); }
  if (typeof h !== "object" || h === null || Array.isArray(h)) throw new BackupError("format");
  const salt = validateHeader(h as Record<string, unknown>, now);
  if (iv.length !== 12 || ct.length < 16) throw new BackupError("format");
  return { header: h as unknown as EnvelopeHeader, headerBytes, salt, iv, ct };
}

/** Every structural check, no passphrase and no key derivation. */
export function readBackupHeader(fileText: string, now: number = Date.now()): EnvelopeHeader {
  return parseEnvelope(fileText, now).header;
}

export async function openBackup(
  fileText: string,
  passphrase: string,
  now: number = Date.now(),
): Promise<{ header: EnvelopeHeader; plain: string }> {
  const { header, headerBytes, salt, iv, ct } = parseEnvelope(fileText, now);
  const pass = checkPassphrase(passphrase, OPEN_MIN_PASSPHRASE_CHARS);
  let body: Uint8Array;
  try {
    const key = await deriveKey(pass, salt, header.iter);
    body = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: headerBytes as BufferSource, tagLength: 128 }, key, ct as BufferSource));
  } catch {
    throw new BackupError("decrypt");
  }
  if (header.zip === "gzip") {
    if (typeof globalThis.DecompressionStream !== "function") throw new BackupError("unsupported");
    try {
      body = concat(await pipeBytes(body, new DecompressionStream("gzip"), BACKUP_MAX_PLAIN_BYTES));
    } catch (e) {
      if (e instanceof BackupError) throw e;
      throw new BackupError("format");
    }
  } else if (body.length > BACKUP_MAX_PLAIN_BYTES) {
    throw new BackupError("too-large-file", { size: body.length });
  }
  try {
    return { header, plain: new TextDecoder("utf-8", { fatal: true }).decode(body) };
  } catch {
    throw new BackupError("format");
  }
}
