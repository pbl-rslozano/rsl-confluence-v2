/**
 * etf-csv.ts — v2.8 Step 4a (plan WP25, Task 3): import of daily spot-ETF flows from a user-supplied CSV.
 * No network. The text is untrusted: no cell is trusted, nothing is evaluated, and issuer names stay plain text
 * (they are shown later; the UI must render them as text, never as markup).
 *
 * Format: header `date,issuer,flow_usd` (case-insensitive, exactly three columns), then one row per issuer per day.
 *  - date  YYYY-MM-DD, a real calendar date;
 *  - issuer  [A-Za-z0-9 .&-]{1,40}, not starting with + - = @ ;
 *  - flow_usd  a plain decimal, |value| ≤ 1e11 (US$; negative = outflow).
 * A cell that starts with `=`, `@`, a tab or a carriage return, or with `+` / `-` followed by a non-digit, is
 * rejected (spreadsheet formula injection). There is no quote handling: a cell with a quote fails its own format.
 * Duplicates are (date, issuer): the last row wins and each earlier one counts once in `duplicates`.
 * Context, never a vote: nothing here reaches scoring.
 */
export interface EtfFlow { date: string; issuer: string; flowUsd: number }

export const ETF_MAX_ABS_FLOW = 1e11;
const ISSUER_RE = /^[A-Za-z0-9 .&-]{1,40}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FLOW_RE = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** True for a cell that a spreadsheet could read as a formula. Tests the raw cell, before any trimming. */
export function isFormulaLike(cell: string): boolean {
  if (cell.length === 0) return false;
  const c = cell[0];
  if (c === "=" || c === "@" || c === "\t" || c === "\r") return true;
  if ((c === "+" || c === "-") && !(cell.length > 1 && cell[1] >= "0" && cell[1] <= "9")) return true;
  return false;
}

/** True for a real calendar date written YYYY-MM-DD. */
export function validEtfDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** The issuer rule: [A-Za-z0-9 .&-]{1,40} and not starting with + - = @ . */
export function validEtfIssuer(s: unknown): s is string {
  return typeof s === "string" && ISSUER_RE.test(s) && !/^[+\-=@]/.test(s);
}

/** One row re-checked field by field (calendar date, issuer rule, finite flow within the cap); null when it fails. */
export function normalizeEtfRow(r: unknown): EtfFlow | null {
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const { date, issuer, flowUsd } = r as Record<string, unknown>;
  if (!validEtfDate(date) || !validEtfIssuer(issuer)) return null;
  if (typeof flowUsd !== "number" || !Number.isFinite(flowUsd) || Math.abs(flowUsd) > ETF_MAX_ABS_FLOW) return null;
  return { date, issuer, flowUsd: flowUsd === 0 ? 0 : flowUsd };
}

export function parseEtfCsv(text: string): { rows: EtfFlow[]; rejected: number; duplicates: number } {
  const out = { rows: [] as EtfFlow[], rejected: 0, duplicates: 0 };
  if (typeof text !== "string") return out;
  const lines = text.replace(/^﻿/, "").split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const nonEmpty = lines.map((l, i) => ({ l, i })).filter((x) => x.l.trim() !== "");
  if (!nonEmpty.length) return out;

  const head = nonEmpty[0].l.split(",").map((c) => c.trim().toLowerCase());
  if (head.length !== 3 || head[0] !== "date" || head[1] !== "issuer" || head[2] !== "flow_usd") {
    out.rejected = nonEmpty.length; // no usable header: nothing in the file is trusted
    return out;
  }
  const byKey = new Map<string, EtfFlow>();
  for (const { l } of nonEmpty.slice(1)) {
    const cells = l.split(",");
    if (cells.length !== 3 || cells.some(isFormulaLike)) { out.rejected++; continue; }
    const date = cells[0].trim();
    const issuer = cells[1].trim().replace(/ {2,}/g, " ");
    const flowText = cells[2].trim();
    if (!validEtfDate(date) || !validEtfIssuer(issuer) || !FLOW_RE.test(flowText)) { out.rejected++; continue; }
    const flowUsd = Number(flowText);
    if (!Number.isFinite(flowUsd) || Math.abs(flowUsd) > ETF_MAX_ABS_FLOW) { out.rejected++; continue; }
    const key = `${date}\u0000${issuer}`;
    if (byKey.has(key)) out.duplicates++;
    byKey.set(key, { date, issuer, flowUsd: flowUsd === 0 ? 0 : flowUsd }); // no negative zero
  }
  out.rows = [...byKey.values()];
  return out;
}

/** Totals per day for the newest `days` dates (default 10), oldest first. */
export function etfDailyTotals(rows: EtfFlow[], days = 10): { date: string; total: number; byIssuer: Record<string, number> }[] {
  const byDate = new Map<string, { total: number; byIssuer: Record<string, number> }>();
  for (const r of rows) {
    if (!r || !Number.isFinite(r.flowUsd) || typeof r.date !== "string") continue;
    const d = byDate.get(r.date) ?? { total: 0, byIssuer: {} };
    d.total += r.flowUsd;
    d.byIssuer[r.issuer] = (Object.hasOwn(d.byIssuer, r.issuer) ? d.byIssuer[r.issuer] : 0) + r.flowUsd;
    byDate.set(r.date, d);
  }
  const n = Number.isFinite(days) ? Math.max(0, Math.floor(days)) : 10; // a non-finite count falls back to the default
  if (n === 0) return [];
  return [...byDate.keys()].sort().slice(-n).map((date) => ({ date, ...byDate.get(date)! }));
}
