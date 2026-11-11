/**
 * rsl-crypto.js — rsL Core Kit · v1.0 2026
 * Shared primitives: canonical JSON, SHA-256, strict base64url, UTF-8.
 * No DOM, no storage, no network. Runs in WebView2, WKWebView, Android WebView, browsers and Node ≥ 20.
 */

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export const utf8 = (s) => enc.encode(String(s));
export const fromUtf8 = (bytes) => dec.decode(bytes);

/** Web Crypto SubtleCrypto, or null when the context is not secure (e.g. some file:// pages). */
export function subtle() {
  return (globalThis.crypto && globalThis.crypto.subtle) || null;
}

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no whitespace, UTF-8 when hashed.
 * Rejects values that have no stable JSON form (undefined, functions, NaN, Infinity, BigInt).
 */
export function canonicalJSON(value) {
  const walk = (v) => {
    if (v === null) return 'null';
    switch (typeof v) {
      case 'boolean': return v ? 'true' : 'false';
      case 'string': return JSON.stringify(v);
      case 'number':
        if (!Number.isFinite(v)) throw new TypeError('canonicalJSON: non-finite number');
        return JSON.stringify(v);
      case 'object': {
        if (Array.isArray(v)) return '[' + v.map(walk).join(',') + ']';
        const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
        return '{' + keys.map((k) => JSON.stringify(k) + ':' + walk(v[k])).join(',') + '}';
      }
      default: throw new TypeError('canonicalJSON: unsupported type ' + typeof v);
    }
  };
  return walk(value);
}

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

/** SHA-256 of a string (UTF-8) or bytes, as lowercase hex. */
export async function sha256Hex(input) {
  const s = subtle();
  if (!s) throw new Error('E-CRYPTO: Web Crypto is not available in this context');
  const bytes = typeof input === 'string' ? utf8(input) : input;
  return hex(await s.digest('SHA-256', bytes));
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const REV = (() => { const m = new Int16Array(128).fill(-1); for (let i = 0; i < 64; i++) m[B64URL.charCodeAt(i)] = i; return m; })();

/** RFC 4648 §5, no padding. */
export function b64urlEncode(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64URL[n >> 18] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) { const n = bytes[i] << 16; out += B64URL[n >> 18] + B64URL[(n >> 12) & 63]; }
  else if (rem === 2) { const n = (bytes[i] << 16) | (bytes[i + 1] << 8); out += B64URL[n >> 18] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63]; }
  return out;
}

/**
 * Strict base64url decode: only A–Z a–z 0–9 - _, no padding, length % 4 ≠ 1,
 * and the unused low bits of the final character must be zero (canonical encoding).
 * Returns Uint8Array, or null when the input is not canonical base64url.
 */
export function b64urlDecodeStrict(str) {
  if (typeof str !== 'string' || str.length % 4 === 1) return null;
  const vals = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    const v = c < 128 ? REV[c] : -1;
    if (v < 0) return null;
    vals[i] = v;
  }
  const full = Math.floor(str.length / 4) * 4;
  const rem = str.length - full;
  const out = new Uint8Array((full / 4) * 3 + (rem ? rem - 1 : 0));
  let o = 0;
  for (let i = 0; i < full; i += 4) {
    const n = (vals[i] << 18) | (vals[i + 1] << 12) | (vals[i + 2] << 6) | vals[i + 3];
    out[o++] = n >> 16; out[o++] = (n >> 8) & 255; out[o++] = n & 255;
  }
  if (rem === 2) {
    if (vals[full + 1] & 15) return null;
    out[o++] = (vals[full] << 2) | (vals[full + 1] >> 4);
  } else if (rem === 3) {
    if (vals[full + 2] & 3) return null;
    const n = (vals[full] << 10) | (vals[full + 1] << 4) | (vals[full + 2] >> 2);
    out[o++] = n >> 8; out[o++] = n & 255;
  }
  return out;
}

/** Deterministic 32-bit FNV-1a hash (used for seeds and avatar colours, never for security). */
export function fnv1a32(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
