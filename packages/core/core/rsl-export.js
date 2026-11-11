/**
 * rsl-export.js — rsL Core Kit · v1.0 2026
 * Export helpers shared by every app: injection-safe CSV, file naming, GS1 check digits.
 * XLSX (SheetJS CE 0.20.3, vendored tarball — the npm "xlsx" 0.18.5 is stale) and DOCX (docx)
 * stay in each app; this module gives them the same safe cell values and names.
 */

/* ───────────── CSV ───────────── */
/** Neutralise spreadsheet formula injection: cells starting with = + - @ TAB CR (or other control chars) get a leading apostrophe. */
export function safeCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  const s = String(v);
  return /^[=+\-@\u0000-\u001F]/.test(s) ? `'${s}` : s;
}

const quote = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/**
 * @param {Array<object>|Array<Array>} rows
 * @param {{ columns?: string[], headers?: string[], bom?: boolean, notice?: string }} opt
 *   notice: first line, e.g. the license watermark "FREE USAGE DUE — LICENSE REQUIRED"
 * Numbers keep their sign: -5 is written as -5 (only strings are neutralised).
 */
export function toCSV(rows, { columns, headers, bom = true, notice } = {}) {
  const cols = columns || (rows.length && !Array.isArray(rows[0]) ? Object.keys(rows[0]) : null);
  const lines = [];
  if (notice) lines.push(quote(safeCell(notice)));
  if (cols) lines.push((headers || cols).map((h) => quote(safeCell(h))).join(','));
  for (const r of rows) {
    const vals = Array.isArray(r) ? r : cols.map((c) => r[c]);
    lines.push(vals.map((v) => quote(safeCell(v))).join(','));
  }
  return (bom ? '﻿' : '') + lines.join('\r\n') + '\r\n';
}

/* ───────────── File names ───────────── */
/** "PackOS_IBK_SPEC-0042_20261029.pdf" — app, customer code, document id, local date. */
export function exportFileName({ app, customerCode, docId, date = new Date(), ext }) {
  const part = (s) => String(s).normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  return [part(app), part(customerCode), part(docId), ymd].filter(Boolean).join('_') + '.' + part(ext).toLowerCase();
}

/* ───────────── GS1 (GTIN-8/12/13/14, SSCC-18, GLN) ───────────── */
/** GS1 mod-10: weights 3,1,3,1… from the rightmost data digit. Returns the check digit for `data` (no check digit). */
export function gs1CheckDigit(data) {
  if (!/^\d+$/.test(data)) return null;
  let sum = 0;
  for (let i = data.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(data[i]) * w;
  return (10 - (sum % 10)) % 10;
}
export function isValidGS1(code, lengths = [8, 12, 13, 14, 18]) {
  const s = String(code).replace(/\s/g, '');
  if (!/^\d+$/.test(s) || !lengths.includes(s.length)) return false;
  return gs1CheckDigit(s.slice(0, -1)) === Number(s.at(-1));
}
export const isValidGTIN = (c) => isValidGS1(c, [8, 12, 13, 14]);
export const isValidSSCC = (c) => isValidGS1(c, [18]);
/** Normalise any GTIN to GTIN-14 (left-pad with zeros) for SAP/GS1 matching. */
export const toGTIN14 = (c) => (isValidGTIN(c) ? String(c).padStart(14, '0') : null);
