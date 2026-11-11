/**
 * rsl-license-core.js — rsL Core Kit · v1.0 2026
 * Offline ES256 (ECDSA P-256 / SHA-256) license verification and the license state machine,
 * implementing "rsL Application License System" masterclass v1.0 2026, phases 2–4.
 *
 * Holds PUBLIC keys only. Never import a private key into an app build.
 * Nothing is ever locked: callers use the result only for the watermark, chip, banner and prompt.
 * No DOM, no storage, no network.
 *
 * Key string:  RSL<CODE>1 . base64url(UTF-8 JSON payload) . base64url(64-byte P1363 signature)
 * Signed bytes: UTF-8 of "RSL<CODE>1." + payloadB64, exactly as received.
 */
import { subtle, utf8, fromUtf8, b64urlDecodeStrict } from './rsl-crypto.js';
import { parseISODate, endOfDayUTC, daysLeft } from './rsl-clock.js';

export const MAX_KEY_CHARS = 2048;
export const MAX_PAYLOAD_BYTES = 1024;

/** English source messages; translate by code in the app catalog (codes never change). */
export const LICENSE_MESSAGES = {
  'E-01': 'This is too long to be a license key. Paste only the key.',
  'E-02': 'This is not a {app} license key (it should start with {prefix}.).',
  'E-03': 'The key is damaged (it contains characters that do not belong). Copy it again from the email or .rsllic file.',
  'E-04': "The key's signature has the wrong format. Ask the developer to re-issue it.",
  'E-05': 'The key is damaged and cannot be read.',
  'E-06': 'This key has no signing-key id.',
  'E-07': 'This key belongs to {otherApp}.',
  'E-08': 'This key was signed with a key this version does not know. Update the app or ask for a new key.',
  'E-09': 'The signature does not match. The key was edited or was not issued by the developer.',
  'E-10': 'This browser cannot check signatures here. Open the file in Chrome or Edge.',
  'E-11': 'This key is incomplete or was issued for another app.',
  'E-12': 'The license number has a typo.',
  'E-13': 'License {lic} was withdrawn on {date}. Contact the developer.',
  'E-14': "This key is not valid on '{site}'. It is valid on: {sites}. Copy this site id into your license request.",
  'E-15': 'This license starts on {nbf}.',
  'E-16': 'This license expired on {exp}.',
};

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
const fail = (code, vars = {}) => ({ ok: false, code, reason: fill(LICENSE_MESSAGES[code], vars), payload: null });

/* ───────────── Luhn mod 36 check character (phase 3.4) ───────────── */
const ALPH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const cp = (ch) => ALPH.indexOf(ch);

/** Check character for a license number body such as "RSL-NMRC-2026-0001" (hyphens ignored). */
export function luhn36CheckChar(body) {
  const s = String(body).replace(/-/g, '').toUpperCase();
  let factor = 2, sum = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const v = cp(s[i]);
    if (v < 0) return null;
    const p = v * factor;
    sum += Math.floor(p / 36) + (p % 36);
    factor = factor === 2 ? 1 : 2;
  }
  return ALPH[(36 - (sum % 36)) % 36];
}

/** True when the full license number (including its check character) passes Luhn mod 36. */
export function luhn36Valid(full) {
  const s = String(full).replace(/-/g, '').toUpperCase();
  let factor = 1, sum = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const v = cp(s[i]);
    if (v < 0) return false;
    const p = v * factor;
    sum += Math.floor(p / 36) + (p % 36);
    factor = factor === 2 ? 1 : 2;
  }
  return sum % 36 === 0;
}

/* ───────────── Site id (phase 4.3) ───────────── */
export function siteIdFromLocation(loc = globalThis.location) {
  if (!loc) return 'app';
  const proto = String(loc.protocol || '').toLowerCase();
  if (proto === 'file:') return 'file';
  if (proto === 'http:' || proto === 'https:') {
    const host = String(loc.hostname || '').toLowerCase();
    // Tauri (Windows/Android: http(s)://tauri.localhost) and Capacitor (https://localhost, capacitor://localhost)
    if (host === 'tauri.localhost' || host === 'localhost' && globalThis.Capacitor) return 'app';
    return host;
  }
  return 'app'; // tauri:, capacitor:, app:, custom schemes
}

/* ───────────── Normalisation & safe JSON ───────────── */
const ZW = /[\s​-‍﻿]/g;
const BIDI_CTRL = /[‪-‮⁦-⁩]/;
const CTRL = /[\u0000-\u001F\u007F]/;

export function normaliseKey(raw) { return String(raw ?? '').replace(ZW, ''); }

function hasForbiddenKeys(o) {
  if (o === null || typeof o !== 'object') return false;
  for (const k of Object.keys(o)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') return true;
    if (hasForbiddenKeys(o[k])) return true;
  }
  return false;
}

function safeParse(bytes) {
  let txt;
  try { txt = fromUtf8(bytes); } catch { return null; }
  if (/"(__proto__|constructor|prototype)"\s*:/.test(txt)) return null;
  let obj;
  try { obj = JSON.parse(txt); } catch { return null; }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj) || hasForbiddenKeys(obj)) return null;
  return obj;
}

/* ───────────── Schema (phase 3.3) ───────────── */
const SITE_RE = /^[a-z0-9.-]{1,253}$/;
function validatePayload(p, { appCode, editions, legacyLicenses = [] }) {
  const ok = { schema: false, lic: true };
  if (p.v !== 1) return ok;
  if (p.app !== appCode) return ok;
  if (typeof p.lic !== 'string') return ok;
  const legacy = legacyLicenses.includes(p.lic);
  if (!legacy) {
    if (!new RegExp(`^RSL-[A-Z]{2,6}-\\d{4}-\\d{4}-[0-9A-Z]$`).test(p.lic)) return ok;
    if (!luhn36Valid(p.lic)) { ok.lic = false; return ok; }
  }
  if (typeof p.to !== 'string') return ok;
  const to = p.to.normalize('NFC');
  if (to.length < 1 || to.length > 120 || CTRL.test(to) || BIDI_CTRL.test(to)) return ok;
  if (editions && editions.length && !editions.includes(p.ed)) return ok;
  if (!Array.isArray(p.sites) || p.sites.length < 1 || p.sites.length > 10) return ok;
  if (new Set(p.sites).size !== p.sites.length) return ok;
  if (!p.sites.every((s) => s === 'file' || s === '*' || s === 'app' || (typeof s === 'string' && SITE_RE.test(s)))) return ok;
  for (const f of ['iat', 'nbf']) if (parseISODate(p[f]) === null) return ok;
  if (p.exp !== null && parseISODate(p.exp) === null) return ok;
  if (p.exp !== null && parseISODate(p.nbf) > parseISODate(p.exp)) return ok;
  if (p.note !== undefined && (typeof p.note !== 'string' || p.note.length > 200)) return ok;
  ok.schema = true;
  return ok;
}

function cleanRecord(p) {
  const r = Object.create(null);
  for (const k of ['v', 'kid', 'app', 'lic', 'to', 'ed', 'sites', 'iat', 'nbf', 'exp', 'note']) if (k in p) r[k] = p[k];
  r.to = String(r.to).normalize('NFC');
  r.sites = [...r.sites];
  return Object.freeze(r);
}

const keyCache = new Map();
async function importPublicKey(jwk, kid) {
  if (keyCache.has(kid)) return keyCache.get(kid);
  const k = await subtle().importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  keyCache.set(kid, k);
  return k;
}

/**
 * Ordered, fail-fast verification (phase 4.1). Never throws.
 * @param {string} rawKey
 * @param {object} ctx
 *   appCode       'PKOS' …            appName  'rsL PackOS'
 *   trustedKeys   [{ kid, jwk:{x,y}, issuedUntil:null|'YYYY-MM-DD' }]
 *   knownApps     { PKOS:'rsL PackOS', NMRC:'rsL Reformulation Console', … } (for E-07)
 *   revoked       [{ lic, date, reason }]   site  'file' | hostname | 'app'
 *   now           ms (from guardedNow)      editions ['Site','Department','Enterprise']
 *   legacyLicenses [license numbers issued before check characters]
 * @returns {Promise<{ok:boolean, code:string|null, reason:string, payload:object|null}>}
 */
export async function verifyLicenseKey(rawKey, ctx) {
  const { appCode, appName = `rsL ${ctx.appCode}`, trustedKeys = [], knownApps = {}, revoked = [], site, now } = ctx;
  const prefix = `RSL${appCode}1`;
  const key = normaliseKey(rawKey);                                        // 1
  if (key.length > MAX_KEY_CHARS) return fail('E-01');                     // 2
  const parts = key.split('.');
  if (parts.length !== 3 || !/^RSL[A-Z]{2,6}1$/.test(parts[0])) return fail('E-02', { app: appName, prefix });   // 3
  const [pfx, payloadB64, sigB64] = parts;
  const payloadBytes = b64urlDecodeStrict(payloadB64);                     // 4
  const sig = b64urlDecodeStrict(sigB64);
  if (!payloadBytes || !sig || !payloadB64 || !sigB64) return fail('E-03');
  if (sig.length !== 64) return fail('E-04');                              // 5
  if (payloadBytes.length > MAX_PAYLOAD_BYTES) return fail('E-05');        // 6
  const p = safeParse(payloadBytes);
  if (!p) return fail('E-05');
  if (typeof p.kid !== 'string' || !/^rsl-[a-z]{2,6}-\d{4}-\d+$/.test(p.kid)) return fail('E-06');   // 7
  if (pfx !== prefix) {
    const other = pfx.slice(3, -1);
    return knownApps[other] ? fail('E-07', { otherApp: knownApps[other] }) : fail('E-02', { app: appName, prefix });
  }
  const tk = trustedKeys.find((k) => k.kid === p.kid);
  if (!tk) {
    const other = p.kid.split('-')[1].toUpperCase();
    const named = Object.entries(knownApps).find(([c]) => c.toLowerCase() === p.kid.split('-')[1]);
    return named && named[0] !== appCode ? fail('E-07', { otherApp: named[1] }) : fail('E-08', { other });
  }
  if (!subtle()) return fail('E-10');                                      // 8
  let valid = false;
  try {
    const pub = await importPublicKey(tk.jwk, tk.kid);
    valid = await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, utf8(`${pfx}.${payloadB64}`));
  } catch { return fail('E-10'); }
  if (!valid) return fail('E-09');
  const sch = validatePayload(p, ctx);                                     // 9
  if (!sch.lic) return fail('E-12');
  if (!sch.schema) return fail('E-11');
  if (tk.issuedUntil && parseISODate(p.iat) > parseISODate(tk.issuedUntil)) return fail('E-08', {});
  const rec = cleanRecord(p);
  const rv = revoked.find((r) => r.lic === rec.lic);                        // 10
  if (rv) return { ...fail('E-13', { lic: rec.lic, date: rv.date }), payload: rec };
  if (!(rec.sites.includes('*') || rec.sites.includes(site)))              // 11
    return { ...fail('E-14', { site, sites: rec.sites.join(', ') }), payload: rec };
  if (parseISODate(rec.nbf) > now) return { ...fail('E-15', { nbf: rec.nbf }), payload: rec };     // 12
  if (rec.exp !== null && now > endOfDayUTC(rec.exp)) return { ...fail('E-16', { exp: rec.exp }), payload: rec };
  return { ok: true, code: null, reason: '', payload: rec };
}

/**
 * Pure state machine (phase 2.1). Synchronous; feed it the verification result.
 * @returns {{ status:'trial'|'due'|'licensed', sub:null|'expiring'|'expired'|'invalid'|'revoked',
 *            daysLeft:number|null, remind:boolean, payload:object|null, reason:string, code:string|null,
 *            watermark:string|null, chip:string }}
 */
export function computeLicense({ verification = null, hasKey = false, now, freeUseUntil, remindDays = 60 }) {
  const freeEnd = endOfDayUTC(freeUseUntil);
  if (verification && verification.ok) {
    const p = verification.payload;
    if (p.exp === null) return out('licensed', null, null, false, p);
    const dl = daysLeft(endOfDayUTC(p.exp), now);
    return dl <= remindDays ? out('licensed', 'expiring', dl, true, p) : out('licensed', null, dl, false, p);
  }
  const base = now <= freeEnd ? 'trial' : 'due';
  const dl = base === 'trial' ? daysLeft(freeEnd, now) : null;
  let sub = null;
  if (hasKey && verification) sub = verification.code === 'E-16' ? 'expired' : verification.code === 'E-13' ? 'revoked' : 'invalid';
  return { ...out(base, sub, dl, base === 'due' || (dl !== null && dl <= remindDays), null),
    reason: verification ? verification.reason : '', code: verification ? verification.code : null };

  function out(status, s, d, remind, payload) {
    const watermark = status === 'trial' ? `EARLY BUILD TEST — FREE USE UNTIL ${freeUseUntil}` : status === 'due' ? 'FREE USAGE DUE — LICENSE REQUIRED' : null;
    const chip = status === 'licensed' ? (s === 'expiring' ? 'Licensed · renew' : 'Licensed') : status === 'trial' ? 'Early build · free' : 'License due';
    return { status, sub: s, daysLeft: d, remind, payload, reason: '', code: null, watermark, chip };
  }
}

/** The exact once-per-session prompt text for the "due" state. */
export const DUE_PROMPT = "Free usage is already due as part of its early build test. It's time to license.";
