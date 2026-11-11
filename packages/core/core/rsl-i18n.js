/**
 * rsl-i18n.js — rsL Core Kit · v1.0 2026
 * The rsL 18-language registry (fixed order from rsL PackOS v21.9) and a dependency-free
 * message formatter covering the ICU MessageFormat 1 subset the apps use:
 *   {name}   {n, number}   {d, date}   {n, plural, =0 {…} one {# item} other {# items}}   {x, select, a {…} other {…}}
 * Swap in FormatJS / i18next-icu behind the same t() if a catalog needs more (MF2 is not yet native).
 *
 * Brand strings (rsL, app name, by rsLozano, build stamp, customer names, license keys, E-codes)
 * are never put in catalogs. Insert them as variables; isolate() wraps them for bidi safety.
 */

export const LANGUAGES = Object.freeze([
  { code: 'en', native: 'English', english: 'English', dir: 'ltr', locale: 'en-GB', flag: 'gb', tier: 1 },
  { code: 'ar', native: 'العربية', english: 'Arabic', dir: 'rtl', locale: 'ar-SA-u-nu-latn', flag: 'sa', tier: 1 },
  { code: 'ja', native: '日本語', english: 'Japanese', dir: 'ltr', locale: 'ja-JP', flag: 'jp', tier: 2 },
  { code: 'fil', native: 'Filipino', english: 'Filipino', dir: 'ltr', locale: 'fil-PH', flag: 'ph', tier: 2 },
  { code: 'bn', native: 'বাংলা', english: 'Bangla', dir: 'ltr', locale: 'bn-BD-u-nu-latn', flag: 'bd', tier: 2 },
  { code: 'ur', native: 'اردو', english: 'Urdu', dir: 'rtl', locale: 'ur-PK-u-nu-latn', flag: 'pk', tier: 2 },
  { code: 'ru', native: 'Русский', english: 'Russian', dir: 'ltr', locale: 'ru-RU', flag: 'ru', tier: 2 },
  { code: 'hi', native: 'हिन्दी', english: 'Hindi', dir: 'ltr', locale: 'hi-IN', flag: 'in', tier: 2 },
  { code: 'zh', native: '中文（简体）', english: 'Chinese (Simplified)', dir: 'ltr', locale: 'zh-CN', flag: 'cn', tier: 2 },
  { code: 'ko', native: '한국어', english: 'Korean', dir: 'ltr', locale: 'ko-KR', flag: 'kr', tier: 2 },
  { code: 'id', native: 'Bahasa Indonesia', english: 'Indonesian', dir: 'ltr', locale: 'id-ID', flag: 'id', tier: 2 },
  { code: 'ms', native: 'Bahasa Melayu', english: 'Malay', dir: 'ltr', locale: 'ms-MY', flag: 'my', tier: 2 },
  { code: 'tr', native: 'Türkçe', english: 'Turkish', dir: 'ltr', locale: 'tr-TR', flag: 'tr', tier: 2 },
  { code: 'fr', native: 'Français', english: 'French', dir: 'ltr', locale: 'fr-FR', flag: 'fr', tier: 2 },
  { code: 'de', native: 'Deutsch', english: 'German', dir: 'ltr', locale: 'de-DE', flag: 'de', tier: 2 },
  { code: 'es', native: 'Español', english: 'Spanish', dir: 'ltr', locale: 'es-ES', flag: 'es', tier: 2 },
  { code: 'pt', native: 'Português', english: 'Portuguese', dir: 'ltr', locale: 'pt-BR', flag: 'br', tier: 2 },
  { code: 'it', native: 'Italiano', english: 'Italian', dir: 'ltr', locale: 'it-IT', flag: 'it', tier: 2 },
]);

const byCode = new Map(LANGUAGES.map((l) => [l.code, l]));
export const getLanguage = (code) => byCode.get(code) || byCode.get('en');

/** Pick the first supported language from navigator.languages (BCP 47), else 'en'. */
export function negotiateLanguage(requested = globalThis.navigator?.languages || [globalThis.navigator?.language || 'en']) {
  for (const tag of requested) {
    const t = String(tag).toLowerCase();
    if (byCode.has(t)) return t;
    const base = t.split('-')[0];
    if (base === 'tl') return 'fil';
    if (byCode.has(base)) return base;
  }
  return 'en';
}

/** First Strong Isolate … Pop Directional Isolate: keeps Latin brand text and codes intact inside RTL sentences. */
export const isolate = (s) => `⁨${s}⁩`;

/* ───────────── message parser (ICU MF1 subset) ───────────── */
function parse(src) {
  let i = 0;
  function text(stopAtClose) {
    const parts = []; let buf = '';
    while (i < src.length) {
      const ch = src[i];
      if (ch === "'" && (src[i + 1] === '{' || src[i + 1] === '}' || src[i + 1] === "'" || src[i + 1] === '#')) {
        if (src[i + 1] === "'") { buf += "'"; i += 2; continue; }
        const end = src.indexOf("'", i + 1);
        buf += src.slice(i + 1, end < 0 ? src.length : end); i = end < 0 ? src.length : end + 1; continue;
      }
      if (ch === '{') { if (buf) parts.push(buf); buf = ''; parts.push(arg()); continue; }
      if (ch === '}' && stopAtClose) break;
      if (ch === '#' && stopAtClose) { if (buf) parts.push(buf); buf = ''; parts.push({ hash: true }); i++; continue; }
      buf += ch; i++;
    }
    if (buf) parts.push(buf);
    return parts;
  }
  function word() { while (src[i] === ' ') i++; let w = ''; while (i < src.length && /[^\s,{}]/.test(src[i])) w += src[i++]; while (src[i] === ' ') i++; return w; }
  function arg() {
    i++; // {
    const name = word();
    if (src[i] === '}') { i++; return { name }; }
    if (src[i] !== ',') throw new Error(`Bad message near "${src.slice(i, i + 12)}"`);
    i++; const type = word();
    if (src[i] === '}') { i++; return { name, type }; }
    if (src[i] === ',' && (type === 'number' || type === 'date' || type === 'time')) {
      i++; const style = word(); if (src[i] !== '}') throw new Error('Bad style'); i++; return { name, type, style };
    }
    if (src[i] !== ',') throw new Error('Bad message'); i++;
    const options = {};
    for (;;) {
      while (/\s/.test(src[i])) i++;
      if (src[i] === '}') { i++; break; }
      const key = word();
      if (src[i] !== '{') throw new Error(`Expected { after "${key}"`);
      i++; options[key] = text(true);
      if (src[i] !== '}') throw new Error('Unclosed option'); i++;
    }
    return { name, type, options };
  }
  const out = text(false);
  return out;
}

/**
 * @param {{ catalogs: Record<string, Record<string,string>>, lang?: string, fallback?: string,
 *           onMissing?: (key, lang) => void }} cfg
 */
export function createI18n({ catalogs, lang = 'en', fallback = 'en', onMissing } = {}) {
  const cache = new Map();
  const listeners = new Set();
  let current = getLanguage(lang).code;

  const nf = () => new Intl.NumberFormat(getLanguage(current).locale);
  const pr = () => new Intl.PluralRules(getLanguage(current).locale);

  function render(parts, vars, hashValue) {
    let s = '';
    for (const p of parts) {
      if (typeof p === 'string') { s += p; continue; }
      if (p.hash) { s += hashValue === undefined ? '#' : nf().format(hashValue); continue; }
      const v = vars[p.name];
      if (!p.type) { s += v === undefined || v === null ? `{${p.name}}` : String(v); continue; }
      if (p.type === 'number') { s += new Intl.NumberFormat(getLanguage(current).locale, p.style === 'percent' ? { style: 'percent' } : p.style === 'integer' ? { maximumFractionDigits: 0 } : {}).format(Number(v)); continue; }
      if (p.type === 'date' || p.type === 'time') {
        const d = v instanceof Date ? v : new Date(v);
        const opt = p.type === 'time' ? { timeStyle: 'short' } : { dateStyle: p.style || 'medium' };
        s += new Intl.DateTimeFormat(getLanguage(current).locale, opt).format(d); continue;
      }
      if (p.type === 'plural' || p.type === 'selectordinal') {
        const n = Number(v);
        const exact = p.options[`=${n}`];
        const rule = p.type === 'plural' ? pr().select(n) : new Intl.PluralRules(getLanguage(current).locale, { type: 'ordinal' }).select(n);
        s += render(exact || p.options[rule] || p.options.other || [], vars, n); continue;
      }
      if (p.type === 'select') { s += render(p.options[String(v)] || p.options.other || [], vars, hashValue); continue; }
      s += String(v);
    }
    return s;
  }

  function lookup(key) {
    const own = catalogs[current]?.[key];
    if (own !== undefined) return { msg: own, lang: current };
    if (onMissing) onMissing(key, current);
    const fb = catalogs[fallback]?.[key];
    return fb !== undefined ? { msg: fb, lang: fallback } : null;
  }

  return {
    get lang() { return current; },
    get dir() { return getLanguage(current).dir; },
    get locale() { return getLanguage(current).locale; },
    /** Translate. Missing keys fall back to English, never to a raw key in production builds. */
    t(key, vars = {}) {
      const hit = lookup(key);
      if (!hit) return `⟦${key}⟧`;
      const ck = hit.lang + '\u0000' + key;
      if (!cache.has(ck)) cache.set(ck, parse(hit.msg));
      return render(cache.get(ck), vars);
    },
    setLang(code) {
      const next = getLanguage(code).code;
      if (next === current) return;
      current = next; listeners.forEach((fn) => fn(current));
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    formatNumber: (n, opt) => new Intl.NumberFormat(getLanguage(current).locale, opt).format(n),
    formatDate: (d, opt = { dateStyle: 'medium' }) => new Intl.DateTimeFormat(getLanguage(current).locale, opt).format(d instanceof Date ? d : new Date(d)),
    /** Catalog status for the About dialog: APPROVED (tier 1 reviewed) or DRAFT. */
    status: (code) => catalogs[code]?.['@status'] || (getLanguage(code).tier === 1 && code === 'en' ? 'APPROVED' : 'DRAFT'),
  };
}

/** Apply lang/dir to the document root (call on every switch). */
export function applyToDocument(i18n, doc = globalThis.document) {
  if (!doc) return;
  doc.documentElement.lang = i18n.lang === 'fil' ? 'fil' : i18n.lang;
  doc.documentElement.dir = i18n.dir;
}
