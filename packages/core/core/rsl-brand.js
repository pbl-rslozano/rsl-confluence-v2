/**
 * rsl-brand.js — rsL Core Kit · v1.0 2026
 * The rsL identity layer as data + string builders (no framework). Follows
 * "rsL Application Identity System" masterclass v1.0 2026, phase 2.
 * Brand strings are never translated.
 */

export const BRAND = Object.freeze({
  owner: 'rsLozano',
  byline: 'by rsLozano',
  contactEmail: 'rslozano@gmail.com',
  credit: 'Created by rsLozano from Quality Control & Assurance Department; Department Head: AKSingh',
  confidential: 'Confidential — internal use within Switzgroup only.',
  factories: Object.freeze(['SM3', 'SM4', 'SM5', 'SM6', 'SM7', 'SM9', 'SM10', 'SM11']),
  colors: Object.freeze({ blue: '#0755F5', violet: '#7524F4', cyan: '#00D9F5', bar: '#0B1B33', metaOnBar: '#8EA3BD', metaOnLight: '#5B6B82' }),
  defaultCustomer: Object.freeze({ legalName: 'iBake – Switz Group', shortName: 'iBake', code: 'IBK', colors: ['#FF6B0C', '#FF9E00'],
    logoViewBox: '54.88 39.62 156.5 77.5' }),
});

/** Known rsL app codes (license prefixes, file names, signature-art seeds). */
export const RSL_APPS = Object.freeze({
  PKOS: 'rsL PackOS', NMRC: 'rsL Reformulation Console', GNF: 'rsL GNF-ARCS', MB: 'rsL MassBalance',
  STKL: 'rsL StackLab', IBS: 'rsL Industrial Bakery Specification',
});

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MONO_PATHS = '<path d="M0 250V112C0 69 27 42 70 42H172V85H70C52 85 43 96 43 114V250Z"/><path d="M69 129C69 115 79 107 92 107H124C166 107 193 137 193 179C193 222 167 250 124 250H69V207H122C140 207 150 197 150 179C150 161 140 150 122 150H92C79 150 69 143 69 129Z"/><path d="M199 0H245V160L199 114Z"/><path d="M199 177H245V207H340V250H244C215 250 199 234 199 205Z"/>';
let monoCount = 0;

/** The rsL monogram, exact geometry from the rsLozano vector kit. Each call gets a unique gradient id. */
export function monogramSVG({ className = 'rsl-mono', label = 'rsLozano monogram', background = null, width, height } = {}) {
  const id = `rslg-${++monoCount}-${Math.random().toString(36).slice(2, 7)}`;
  const size = width || height ? ` width="${width ?? ''}" height="${height ?? ''}"` : '';
  const bg = background ? `<rect width="100%" height="100%" fill="${esc(background)}"/>` : '';
  return `<svg class="${esc(className)}" viewBox="0 0 420 330"${size} role="img" aria-label="${esc(label)}"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#0755F5"/><stop offset="1" stop-color="#7524F4"/></linearGradient></defs>${bg}<g transform="translate(40 40)"><g fill="url(#${id})">${MONO_PATHS}</g><path fill="#00D9F5" d="M147 120H190L236 165H193Z"/></g></svg>`;
}

/** "v1.0 2026 · build 20261029" */
export const buildStamp = ({ version, year = new Date().getFullYear(), build }) => `v${version} ${year} · build ${build}`;
/** "Powered by rsL PackOS · v1.0 2026 · build 20261029" */
export const poweredBy = (app) => `Powered by rsL ${app.name} · ${buildStamp(app)}`;
/** mailto for the Contact developer button (shown as selectable text as well; mail links can fail). */
export const contactMailto = (app, subject = app.name) => `mailto:${BRAND.contactEmail}?subject=${encodeURIComponent(subject)}`;

/**
 * Canonical brand block markup. Order is fixed: monogram → rsL + app → byline → build.
 * @param {{ name:string, version:string, year?:number, build:string }} app
 */
export function brandBlockHTML(app) {
  const stamp = buildStamp(app);
  return `<div class="rsl-brand" dir="ltr">${monogramSVG({ className: 'rsl-mono' })}<div class="rsl-brand-text">` +
    `<strong class="rsl-name"><span class="rsl-r">rsL</span> <span class="rsl-app">${esc(app.name)}</span></strong>` +
    `<span class="rsl-meta"><span class="rsl-by">${BRAND.byline}</span><span class="rsl-sep" aria-hidden="true"> · </span>` +
    `<span class="rsl-build" title="${esc(`${app.name} ${stamp}`)}">${esc(stamp)}</span></span></div></div>`;
}

/** Report / page footer lines (credit only on the last page). */
export function footerLines(app, { page, pages, printedAt = new Date(), licenseLine = '', auditRef = '' } = {}) {
  const lines = [
    [`Printed ${printedAt.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`, licenseLine, page ? `Page ${page} of ${pages}` : '', poweredBy(app), auditRef]
      .filter(Boolean).join(' | '),
    BRAND.confidential,
  ];
  if (!page || page === pages) lines.push(BRAND.credit);
  return lines;
}
