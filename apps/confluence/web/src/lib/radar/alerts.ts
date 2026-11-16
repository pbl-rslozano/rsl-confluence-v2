/**
 * alerts.ts — v2.8 Step 4a (plan WP25, Task 4): the radar's alerts. Pure functions over numbers the feeds fetched.
 *
 * Context, never a vote: an alert is information shown in the Radar panel (and logged in `rad`); it never reaches
 * scoring and never blocks or places a trade. The WP19 depeg paper gate (>= 1 %) is separate and unchanged.
 *
 * Thresholds are "starting values", adjustable in the panel and stored per device; `sanitizeThresholds` is the one
 * place a stored or typed object becomes a safe RadarThresholds. Every alert code matches /^[A-Z0-9_]{1,32}$/.
 * `trigger` is an i18n key plus variables; the panel (Task 6) owns the catalog entries:
 *   radar.alert.breakaway  { venue, pct, bars }   pct = signed deviation of the newest bar after the standing premium, %
 *   radar.alert.volume     { z, pct }             z = z-score, pct = the day's volume vs the 30-day mean, %
 *   radar.alert.depeg      { coin, reference, dev, level }   dev = signed % from 1:1, level = watch | warning | severe
 *   radar.alert.supply     { pct, usd, pctl }     pct / usd = SIGNED daily change (% of the previous day's supply / US$): + mint, - redemption
 */
import type { DepegReading } from "../quotes";
import { depegLevel } from "../quotes";
import { PROVIDERS } from "../providers";
import type { SupplyPoint } from "./stablecoins";

export interface RadarThresholds { breakAwayPct: number; breakAwayBars: number; volumeZ: number; supplyPctl: number }
export const DEFAULT_THRESHOLDS: RadarThresholds = { breakAwayPct: 1, breakAwayBars: 2, volumeZ: 3, supplyPctl: 99 };

/** Allowed ranges (inclusive) per threshold; `int` = whole numbers only. */
const RANGES: Record<keyof RadarThresholds, { min: number; max: number; int?: boolean }> = {
  breakAwayPct: { min: 0.2, max: 10 },
  breakAwayBars: { min: 1, max: 6, int: true },
  volumeZ: { min: 1.5, max: 10 },
  supplyPctl: { min: 90, max: 99.9 },
};

/** Anything that is not a finite number inside its range (or not an own property) falls back to the default; unknown keys are dropped. */
export function sanitizeThresholds(x: unknown): RadarThresholds {
  const out: RadarThresholds = { ...DEFAULT_THRESHOLDS };
  if (!x || typeof x !== "object" || Array.isArray(x)) return out;
  for (const key of Object.keys(RANGES) as (keyof RadarThresholds)[]) {
    if (!Object.prototype.hasOwnProperty.call(x, key)) continue;
    const v = (x as Record<string, unknown>)[key];
    const r = RANGES[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= r.min && v <= r.max && (!r.int || Number.isInteger(v))) out[key] = v;
  }
  return out;
}

export type AlertCode = string;
export const ALERT_CODE = /^[A-Z0-9_]{1,32}$/;
export interface RadarAlert {
  code: AlertCode;
  kind: "breakaway" | "volume" | "depeg" | "supply";
  trigger: { key: string; vars: Record<string, string | number> };
  sourceUrl: string;
  /** Close time (ms) of the first bar (or day) of the run that triggered the alert. */
  since: number;
}

const H = 3_600_000;
const DAY = 86_400_000;
const EPS = 1e-9;

let nowFn: () => number = () => Date.now();
/** Test hook: use `fn` (null = the real clock) where a default `since` is derived from the time. */
export function setAlertsClockForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}

/** Public pages for ids that lib/providers.ts has no row for yet (Task 6 adds the radar providers; its row then wins). */
const EXTRA_PAGES: Record<string, string> = { defillama: "https://defillama.com/docs/api" };
/**
 * Provider id of a venue or scan source id: an exact PROVIDERS id, else the part before the first "-"
 * (bybit-spot, bybit-perp, okx-perp, bitget-perp, binance-fut -> bybit, okx, bitget, binance). "" when unknown.
 */
function providerIdOf(id: string): string {
  const key = String(id ?? "").toLowerCase();
  if (PROVIDERS.some((p) => p.id === key) || key in EXTRA_PAGES) return key;
  const head = key.split("-")[0];
  return PROVIDERS.some((p) => p.id === head) ? head : "";
}
function pageOf(id: string): string {
  const pid = providerIdOf(id);
  return PROVIDERS.find((p) => p.id === pid)?.apiDocs ?? EXTRA_PAGES[pid] ?? "";
}
const nameOf = (id: string): string => PROVIDERS.find((p) => p.id === providerIdOf(id))?.name ?? id;

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;
/** Code part: upper case, every run of other characters one "_", none leading or trailing. Same for every alert kind. */
const upper = (s: string) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* ---------------- exchange price break-away ---------------- */

/**
 * A venue alerts when, for each of the last `breakAwayBars` bars, its BTC close (in USD terms, after removing its
 * standing premium) is at least `breakAwayPct` % away from the median of the other venues' adjusted closes. At least
 * two other venues must have data on every one of those bars, and the deviation must keep the same sign on every bar
 * (+1.2 % then -1.2 % is not a break-away). A venue whose key is in `standing` with a null value
 * (fewer than 20 days of history) is left out altogether, as candidate and as comparison.
 *
 * `venueCloses`: venue id → closes, oldest first, aligned from the newest bar backwards (NaN = the venue lacks the
 * bar). `standing`: venue id → standing premium in % (absent = none). `closeTimes`: close time of each aligned bar,
 * oldest first (default: consecutive hours ending at the last whole hour). Code BREAKAWAY_<VENUE>.
 */
export function breakAway(
  venueCloses: Record<string, number[]>,
  standing: Record<string, number | null>,
  thresholds: RadarThresholds,
  closeTimes?: number[],
): RadarAlert[] {
  const th = sanitizeThresholds(thresholds);
  const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  // Adjusted series per usable venue, newest bar first (offset 0).
  const adj = new Map<string, number[]>();
  let depth = 0;
  for (const id of Object.keys(venueCloses)) {
    const closes = venueCloses[id];
    if (!Array.isArray(closes)) continue;
    let prem = 0;
    if (has(standing, id)) {
      const s = standing[id];
      if (!isNum(s) || s <= -100) continue; // standing premium unknown: left out
      prem = s;
    }
    const f = 1 + prem / 100;
    const newestFirst = [...closes].reverse().map((c) => (isNum(c) && c > 0 ? c / f : NaN));
    adj.set(id, newestFirst);
    depth = Math.max(depth, newestFirst.length);
  }
  const lastClose = closeTimes?.length ? closeTimes[closeTimes.length - 1] : Math.floor(nowFn() / H) * H;
  const closeAt = (k: number) => (closeTimes && closeTimes.length > k ? closeTimes[closeTimes.length - 1 - k] : lastClose - k * H);

  const alerts: RadarAlert[] = [];
  for (const [id, mine] of adj) {
    const name = upper(id);
    const code = `BREAKAWAY_${name}`;
    const sourceUrl = pageOf(id);
    if (!name || !ALERT_CODE.test(code) || !sourceUrl) continue; // no code or no source page: no alert
    let run = 0;
    let newestDev = 0;
    for (let k = 0; k < depth; k++) {
      const own = mine[k];
      if (!isNum(own)) break;
      const others: number[] = [];
      for (const [oid, series] of adj) if (oid !== id && isNum(series[k])) others.push(series[k]);
      if (others.length < 2) break;
      const dev = (own / median(others) - 1) * 100;
      if (Math.abs(dev) + EPS < th.breakAwayPct) break;
      if (run === 0) newestDev = dev;
      else if (Math.sign(dev) !== Math.sign(newestDev)) break; // a break-away keeps its side on every bar
      run++;
    }
    if (run < th.breakAwayBars) continue;
    alerts.push({
      code,
      kind: "breakaway",
      trigger: { key: "radar.alert.breakaway", vars: { venue: nameOf(id), pct: round(newestDev, 2), bars: run } },
      sourceUrl,
      since: closeAt(run - 1),
    });
  }
  return alerts;
}

/* ---------------- volume spike ---------------- */

/**
 * z of the last day's summed BTC volume against the previous 30 (sample standard deviation, n - 1). Null with fewer than
 * 31 days, a non-finite value or zero spread; an alert when z >= volumeZ (a spike up only). Code VOL_SPIKE.
 * `lastDayOpen`: open time of the last day (default: the day before today, UTC). Since = that day's close.
 */
export function volumeSpike(dailyVolumes: number[], thresholds: RadarThresholds, lastDayOpen?: number): RadarAlert | null {
  const th = sanitizeThresholds(thresholds);
  if (!Array.isArray(dailyVolumes) || dailyVolumes.length < 31) return null;
  const window = dailyVolumes.slice(-31);
  if (!window.every(isNum)) return null;
  const last = window[30];
  const prev = window.slice(0, 30);
  const mean = prev.reduce((a, b) => a + b, 0) / 30;
  const sd = Math.sqrt(prev.reduce((a, b) => a + (b - mean) ** 2, 0) / 29); // sample sd, the usual z-score convention
  if (!(sd > 0) || !Number.isFinite(sd)) return null;
  const z = (last - mean) / sd;
  if (z + EPS < th.volumeZ) return null;
  const open = isNum(lastDayOpen) ? lastDayOpen : Math.floor(nowFn() / DAY) * DAY - DAY;
  return {
    code: "VOL_SPIKE",
    kind: "volume",
    trigger: { key: "radar.alert.volume", vars: { z: round(z, 1), pct: mean > 0 ? round((last / mean - 1) * 100, 0) : 0 } },
    sourceUrl: pageOf("binance"),
    since: open + DAY,
  };
}

/* ---------------- stablecoin depeg ---------------- */

/**
 * One alert per stablecoin whose reading is at tier "watch" or worse (the existing DEPEG_TIERS: 0.5 / 1 / 2 %), the
 * largest deviation when a coin appears twice. No fetch: the readings come from the scan. Code DEPEG_<COIN>.
 * `providerId` names the exchange the readings came from: a provider id or a scan source id (bybit-spot, okx-perp, ...;
 * default binance, also the fallback for an unknown id, so the link is never empty); `asOf` is the reading time (default now).
 */
export function depegAlerts(readings: DepegReading[], providerId = "binance", asOf?: number): RadarAlert[] {
  const best = new Map<string, DepegReading>();
  for (const r of Array.isArray(readings) ? readings : []) {
    if (!r || typeof r.coin !== "string" || !isNum(r.deviationPct) || depegLevel(r.deviationPct) === null) continue;
    const name = upper(r.coin);
    const code = `DEPEG_${name}`;
    if (!name || !ALERT_CODE.test(code)) continue;
    const cur = best.get(code);
    if (!cur || Math.abs(r.deviationPct) > Math.abs(cur.deviationPct)) best.set(code, r);
  }
  const since = isNum(asOf) ? asOf : nowFn();
  return [...best].map(([code, r]) => ({
    code,
    kind: "depeg" as const,
    trigger: {
      key: "radar.alert.depeg",
      vars: { coin: r.coin, reference: String(r.reference ?? ""), dev: round(r.deviationPct, 2), level: depegLevel(r.deviationPct) as string },
    },
    sourceUrl: pageOf(providerId) || pageOf("binance"),
    since,
  }));
}

/* ---------------- stablecoin supply jump ---------------- */

/** Percentile p (0-100) of `xs` by linear interpolation between ranks. */
function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const pos = ((s.length - 1) * p) / 100;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * Today's |daily change| of the total stablecoin supply against the `supplyPctl` percentile of |change| over the
 * prior 90 days (89 at the minimum); an alert when it is strictly above. Points are sorted by day and only changes
 * between consecutive UTC days count: the newest run of consecutive daily points is used, and with fewer than 91 in
 * that run (a gap, or too little history) the result is null. Code SUPPLY_JUMP. Vars carry the SIGNED change
 * (`usd`, `pct`: + mint, - redemption). Since = the timestamp of today's point.
 */
export function supplyJump(points: SupplyPoint[], thresholds: RadarThresholds): RadarAlert | null {
  const th = sanitizeThresholds(thresholds);
  if (!Array.isArray(points)) return null;
  const sorted = points.filter((p) => p && isNum(p.usd) && isNum(p.day)).sort((a, b) => a.day - b.day);
  let start = sorted.length - 1;
  while (start > 0 && sorted[start].day - sorted[start - 1].day === DAY) start--;
  const run = sorted.slice(Math.max(start, sorted.length - 92)); // today + up to 90 prior daily changes
  if (sorted.length - start < 91) return null;
  const deltas = run.slice(1).map((p, i) => p.usd - run[i].usd); // signed; the last one is today's
  const today = deltas[deltas.length - 1];
  const limit = percentile(deltas.slice(0, -1).map(Math.abs), th.supplyPctl);
  if (!(Math.abs(today) > limit)) return null;
  const base = run[run.length - 2].usd;
  return {
    code: "SUPPLY_JUMP",
    kind: "supply",
    trigger: { key: "radar.alert.supply", vars: { pct: base > 0 ? round((today / base) * 100, 2) : 0, usd: Math.round(today), pctl: th.supplyPctl } },
    sourceUrl: pageOf("defillama"),
    since: run[run.length - 1].day,
  };
}
