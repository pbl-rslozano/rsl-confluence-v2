/**
 * rsl-identity.js — rsL Core Kit · 1.2.0
 * Customer Name Recall: one identity record (customer, site, operator, recent customers),
 * validated, persisted through a StoragePort, observable. Identity masterclass phase 3.
 */
import { BRAND } from './rsl-brand.js';
import { fnv1a32 } from './rsl-crypto.js';

const CTRL = /[\u0000-\u001F\u007F‪-‮⁦-⁩]/g;
const clean = (s, max) => String(s ?? '').normalize('NFC').replace(CTRL, '').trim().slice(0, max);

export function defaultIdentity() {
  const c = BRAND.defaultCustomer;
  return {
    customer: { legalName: c.legalName, shortName: c.shortName, code: c.code, logo: null, site: '' },
    operator: { id: null, displayName: '', role: '', preferredLang: 'en' },
    recent: [],
    updatedAt: new Date().toISOString(),
  };
}

/** Returns { ok, value, errors[] } — never throws on user input. */
export function validateIdentity(input) {
  const d = defaultIdentity();
  const errors = [];
  const cu = input?.customer || {};
  const customer = {
    legalName: clean(cu.legalName ?? d.customer.legalName, 120),
    shortName: clean(cu.shortName ?? d.customer.shortName, 24),
    code: clean(cu.code ?? d.customer.code, 6).toUpperCase(),
    logo: cu.logo ?? null,
    site: clean(cu.site ?? d.customer.site, 12),
  };
  if (!customer.legalName) errors.push('customer.legalName is required');
  if (!customer.shortName) customer.shortName = customer.legalName.slice(0, 24);
  if (!/^[A-Z]{2,6}$/.test(customer.code)) errors.push('customer.code must be 2–6 letters A–Z');
  if (customer.logo !== null && !isSafeLogo(customer.logo)) { errors.push('customer.logo must be a PNG, JPEG or sanitised SVG data URI'); customer.logo = null; }
  const op = input?.operator || {};
  const operator = {
    id: op.id ? clean(op.id, 64) : null,
    displayName: clean(op.displayName, 60),
    role: clean(op.role ?? '', 40),
    preferredLang: clean(op.preferredLang ?? 'en', 5) || 'en',
  };
  const recent = Array.isArray(input?.recent) ? input.recent.slice(0, 5).map((r) => ({ legalName: clean(r.legalName, 120), shortName: clean(r.shortName, 24), code: clean(r.code, 6).toUpperCase() })) : [];
  return { ok: errors.length === 0, errors, value: { customer, operator, recent, updatedAt: new Date().toISOString() } };
}

/** Logos: only data:image/png|jpeg, or data:image/svg+xml whose markup has no script, handlers or external refs. */
export function isSafeLogo(uri) {
  if (typeof uri !== 'string' || uri.length > 400_000) return false;
  if (/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(uri)) return true;
  const m = /^data:image\/svg\+xml(;base64)?,(.*)$/s.exec(uri);
  if (!m) return false;
  let svg;
  try { svg = m[1] ? atob(m[2]) : decodeURIComponent(m[2]); } catch { return false; }
  return !/<script|on[a-z]+\s*=|javascript:|<foreignObject|xlink:href\s*=\s*["'](?!#)|href\s*=\s*["'](?!#)|<iframe|<!ENTITY/i.test(svg);
}

/** 1–2 grapheme initials (Intl.Segmenter keeps Arabic, emoji and combining marks intact). */
export function initials(name) {
  const words = clean(name, 120).split(/\s+/).filter(Boolean);
  const first = (w) => {
    if (globalThis.Intl?.Segmenter) { const it = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(w)[Symbol.iterator]().next(); return it.done ? '' : it.value.segment; }
    return Array.from(w)[0] || '';
  };
  if (!words.length) return '?';
  return (first(words[0]) + (words.length > 1 ? first(words[words.length - 1]) : '')).toUpperCase();
}

/** Deterministic avatar colour from the customer code (HSL; lightness tuned for white text ≥ 4.5:1). */
export const avatarColor = (code) => `hsl(${fnv1a32(code) % 360} 62% 36%)`;

/** Time-of-day greeting key for the splash ("greet.morning" | "greet.afternoon" | "greet.evening"). */
export const greetingKey = (d = new Date()) => (d.getHours() < 12 ? 'greet.morning' : d.getHours() < 18 ? 'greet.afternoon' : 'greet.evening');

/**
 * Persisted, observable identity. All UI reads names through get()/subscribe() — never hard-code a customer.
 * @param {StoragePort} port
 */
export async function createIdentityStore(port) {
  let value = (await port.get('identity', 'current')) || defaultIdentity();
  const subs = new Set();
  return {
    get: () => value,
    subscribe(fn) { subs.add(fn); fn(value); return () => subs.delete(fn); },
    async set(next) {
      const v = validateIdentity(next);
      if (!v.ok) return v;
      const prev = value.customer;
      if (prev.code !== v.value.customer.code) {
        v.value.recent = [{ legalName: prev.legalName, shortName: prev.shortName, code: prev.code }, ...v.value.recent.filter((r) => r.code !== prev.code && r.code !== v.value.customer.code)].slice(0, 5);
      }
      value = v.value;
      await port.put('identity', 'current', value);
      subs.forEach((fn) => fn(value));
      return v;
    },
    async forgetCustomer(code) {
      value = { ...value, recent: value.recent.filter((r) => r.code !== code) };
      await port.put('identity', 'current', value); subs.forEach((fn) => fn(value));
    },
    exportJSON: () => JSON.stringify({ format: 'rsl-identity', formatVersion: 1, identity: value }, null, 2),
    async importJSON(text) {
      const o = JSON.parse(text);
      if (o?.format !== 'rsl-identity') return { ok: false, errors: ['Not an rsL identity file'] };
      return this.set(o.identity);
    },
  };
}
