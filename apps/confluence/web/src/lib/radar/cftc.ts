/**
 * cftc.ts — v2.8 Step 4a (plan WP25, Task 3): CFTC Commitments of Traders (Traders in Financial Futures) for CME
 * Bitcoin and Ether futures, for the market radar's Institutions section.
 *
 * Public data only: GET, no key, no credentials (R12, R20). Host publicreporting.cftc.gov answered a cross-origin
 * fetch from the deployed app's own origin (probe RD-PROBE-1), so it is fetched directly and listed in CSP_HOSTS.
 * Socrata dataset gpe5-46if (futures only). Field names verified against a live row on 16 Nov 2026 (probe file).
 *
 * Context, never a vote: nothing here reaches scoring. Positions are as of the report date (a Tuesday), usually
 * published on the Friday after, 3:30 p.m. ET; the caller shows that date.
 *
 * Gate: CFTC publishes no hard public limit for unauthenticated Socrata reads (Socrata throttles anonymous IPs
 * without a stated number), so the gate is a deliberately conservative 2 requests per 10 s for this host, and the
 * app asks at most once per 12 h per asset. A 429 starts a cooldown held in this module (not the venue map in
 * market-client: it is not an exchange and nothing else needs to read it).
 */
import { RateLimitError } from "../market-client";
import { createRateGate, realClock, type RateClock, type RateGate } from "../rate-gate";

export const CFTC_BASE = "https://publicreporting.cftc.gov";
export const CFTC_CODES = { BTC: "133741", ETH: "146021" } as const;
export type CotAsset = keyof typeof CFTC_CODES;

export interface CotGroup { long: number; short: number; net: number; netChg: number | null }
export interface CotReport {
  asset: CotAsset;
  /** YYYY-MM-DD, the Tuesday the positions are as of. */
  reportDate: string;
  assetManagers: CotGroup | null;
  leveragedFunds: CotGroup | null;
  openInterest: number | null;
}

export const CFTC_GATE_LIMIT = 2;
export const CFTC_GATE_WINDOW_MS = 10_000;
const DEFAULT_COOLDOWN_MS = 60_000;

let clock: RateClock = realClock;
let gate: RateGate = createRateGate(CFTC_GATE_LIMIT, CFTC_GATE_WINDOW_MS, clock);
let cooldownUntil = 0;
/** Test hook: use `c` (null = the real clock) for pacing and cooldown, with a fresh gate and no cooldown. */
export function setCftcClockForTests(c: RateClock | null): void {
  clock = c ?? realClock;
  gate = createRateGate(CFTC_GATE_LIMIT, CFTC_GATE_WINDOW_MS, clock);
  cooldownUntil = 0;
}
/** Test hook: a fresh gate and no cooldown on the current clock. */
export function resetCftcForTests(): void {
  setCftcClockForTests(clock === realClock ? null : clock);
}
/** Remaining cooldown of the CFTC host in ms (0 = none). */
export function cftcCooldown(): number {
  return Math.max(0, cooldownUntil - clock.now());
}
function cooling(): RateLimitError {
  const wait = cftcCooldown();
  return new RateLimitError(`CFTC: paused for ${Math.ceil(wait / 1000)} s.`, wait);
}

/** The request path and query. Values are URL-encoded; `$where` holds a quoted contract code. */
export function cotUrl(asset: CotAsset): string {
  const where = `cftc_contract_market_code='${CFTC_CODES[asset]}'`;
  return `${CFTC_BASE}/resource/gpe5-46if.json?$where=${encodeURIComponent(where)}&$order=${encodeURIComponent("report_date_as_yyyy_mm_dd DESC")}&$limit=2`;
}

/* ---------------- parsing ---------------- */

/** A finite number from a number or numeric string, else null. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** "2026-11-03T00:00:00.000" → "2026-11-03"; null for anything that is not a real calendar date. */
function dateOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.0+)?)?$/.exec(v.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** long, short and net of one group from a row; null unless both fields are finite and not negative. */
function groupOf(row: Record<string, unknown>, longKey: string, shortKey: string): { long: number; short: number; net: number } | null {
  const long = num(row[longKey]);
  const short = num(row[shortKey]);
  if (long === null || short === null || long < 0 || short < 0) return null;
  return { long, short, net: long - short };
}

const GROUPS = {
  assetManagers: ["asset_mgr_positions_long", "asset_mgr_positions_short"],
  leveragedFunds: ["lev_money_positions_long", "lev_money_positions_short"],
} as const;

/**
 * The newest report with its change against the prior one. Rows may come in any order; the newest valid date
 * decides the contract, and only rows of that contract count. A group with a missing or non-numeric field is null;
 * `netChg` is null without a prior row (or a prior row whose same group is bad). Unknown contract code → null.
 */
export function parseCotRows(rows: unknown[]): CotReport | null {
  if (!Array.isArray(rows)) return null;
  const parsed = rows
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r))
    .map((r) => ({ r, date: dateOf(r.report_date_as_yyyy_mm_dd), code: typeof r.cftc_contract_market_code === "string" ? r.cftc_contract_market_code.trim() : "" }))
    .filter((x): x is { r: Record<string, unknown>; date: string; code: string } => x.date !== null)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  if (!parsed.length) return null;
  const newest = parsed[0];
  const asset = (Object.keys(CFTC_CODES) as CotAsset[]).find((k) => CFTC_CODES[k] === newest.code);
  if (!asset) return null;
  const prior = parsed.find((x, i) => i > 0 && x.code === newest.code && x.date < newest.date) ?? null;

  const build = (key: keyof typeof GROUPS): CotGroup | null => {
    const [lk, sk] = GROUPS[key];
    const g = groupOf(newest.r, lk, sk);
    if (!g) return null;
    const p = prior ? groupOf(prior.r, lk, sk) : null;
    return { ...g, netChg: p ? g.net - p.net : null };
  };
  const oi = num(newest.r.open_interest_all);
  return {
    asset,
    reportDate: newest.date,
    assetManagers: build("assetManagers"),
    leveragedFunds: build("leveragedFunds"),
    openInterest: oi !== null && oi >= 0 ? oi : null,
  };
}

/* ---------------- fetch ---------------- */

/** The last two reports of one contract (cooldown check, gate, cooldown check, one GET). Null when no valid row came back. */
export async function fetchCot(asset: CotAsset, signal?: AbortSignal): Promise<CotReport | null> {
  if (asset !== "BTC" && asset !== "ETH") throw new Error(`${String(asset)}: not a radar CFTC contract`);
  if (cftcCooldown() > 0) throw cooling();
  await gate.take(signal);
  if (cftcCooldown() > 0) throw cooling();
  const res = await fetch(cotUrl(asset), { cache: "no-store", credentials: "omit", redirect: "error", signal, headers: { accept: "application/json" } });
  if (res.status === 429) {
    const header = Number(res.headers.get("retry-after"));
    const retryAfterMs = Number.isFinite(header) && header > 0 ? header * 1000 : DEFAULT_COOLDOWN_MS;
    cooldownUntil = Math.max(cooldownUntil, clock.now() + retryAfterMs);
    throw new RateLimitError("CFTC: rate limited (429).", retryAfterMs);
  }
  if (!res.ok) throw new Error(`CFTC COT ${asset} ${res.status}`);
  const body = (await res.json()) as unknown;
  const report = parseCotRows(Array.isArray(body) ? body : []);
  return report && report.asset === asset ? report : null;
}
