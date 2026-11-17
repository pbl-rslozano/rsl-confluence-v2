/**
 * fund-trend.ts — Fund trend and Fund size maths (v2.8, WP21). Pure module.
 *
 * Closed daily bars, log returns over k = 30, 91 and 365 days. Daily sigma is the
 * EWMA of squared daily log returns (not demeaned, centre of mass 60, delta = 60/61)
 * using returns up to t-1. z_k = ln(C_t / C_{t-k}) / (sigma * sqrt(k)), clipped to +-2.
 * Fund trend = 50 * mean(z_k), in -100..+100. Fund size = min(200 %, 40 % / annualised sigma).
 *
 * A BENCHMARK, never a vote: it does not enter the engine score, config id or ledger score.
 * No look-ahead: only daily bars whose close time <= the asked close time are used.
 */
import type { Kline } from "./indicators";
import type { AssetClass } from "./ledger-metrics";

export const FT_HORIZONS = [30, 91, 365] as const;
export const FT_DELTA = 60 / 61;
export const FT_CLIP = 2;
export const FT_SCALE = 50;
export const FT_TARGET_VOL = 0.4;
export const FT_SIZE_CAP = 2;
export const FT_MIN_BARS = 366;
export const FT_GREY = 15;
export const FT_DISAGREE_SCORE = 55;
export const FT_DISAGREE_FT = 25;

const DAY_MS = 86_400_000;
/** The newest daily bar used for a row must have closed no more than this long before the row's own bar close. */
export const FT_MAX_STALE_MS = 36 * 3_600_000;

/** Newest daily bar whose close is at or before `closeTime` (daily ascending), or null. */
export function newestClosedDaily(daily: Kline[], closeTime: number): Kline | null {
  let lo = 0, hi = daily.length; // first index whose close is after closeTime
  while (lo < hi) { const mid = (lo + hi) >> 1; if (daily[mid].time + DAY_MS <= closeTime) lo = mid + 1; else hi = mid; }
  return lo > 0 ? daily[lo - 1] : null;
}

/**
 * The one staleness rule: a Fund trend value is kept only when the newest closed daily bar used closed no more than
 * FT_MAX_STALE_MS before `closeTime` (a halted feed must not give old values to newer bars). Shared by the ledger
 * catch-up (applyFundTrend) and the Scenarios sheet (ftAtBars), so their values agree.
 */
export function freshFt(v: number | null | undefined, daily: Kline[], closeTime: number): number | null {
  if (typeof v !== "number") return null;
  const newest = newestClosedDaily(daily, closeTime);
  return newest !== null && closeTime - (newest.time + DAY_MS) <= FT_MAX_STALE_MS ? v : null;
}
const SIGMA_FLOOR = 1e-8;
const SEED_RETURNS = 60;

export interface FundTrend {
  /** -100..+100 */
  value: number;
  /** Percent of capital, 0..200 (min(200 %, 40 % / sigmaAnn)). */
  size: number;
  z: [number, number, number];
  sigmaAnn: number;
  /** Close time (ms) of the last daily bar used. */
  asOf: number;
}

export type FundTrendState = FundTrend | { na: "history" | "class" | "loading" | "error" };

/**
 * Newest run of strictly ascending daily bars with no missing day. Mirrors contiguousTail in
 * market-client.ts (gap > 1.5 bars ends the run; not imported because that module pulls in venue
 * and browser code), plus a step <= 0 (duplicate or out-of-order bar) also ends the run, so
 * unsorted or duplicated input fails closed to null.
 */
function dailyTail(bars: Kline[]): Kline[] {
  let start = bars.length - 1;
  if (start < 1) return bars;
  while (start > 0) {
    const step = bars[start].time - bars[start - 1].time;
    if (step <= 0 || step > DAY_MS * 1.5) break;
    start--;
  }
  return start === 0 ? bars : bars.slice(start);
}

export function fundTrend(daily: Kline[], asOfClose: number): FundTrend | null {
  let end = daily.length;
  while (end > 0 && daily[end - 1].time + DAY_MS > asOfClose) end--;
  if (end < FT_MIN_BARS) return null;
  const bars = dailyTail(end === daily.length ? daily : daily.slice(0, end));
  const n = bars.length;
  if (n < FT_MIN_BARS) return null;
  for (const b of bars) if (!(b.close > 0) || !Number.isFinite(b.close)) return null; // zero, negative, NaN, Infinity

  const ret = new Array<number>(n); // ret[i] = ln(C_i / C_{i-1}), i >= 1
  ret[0] = 0;
  for (let i = 1; i < n; i++) ret[i] = Math.log(bars[i].close / bars[i - 1].close);

  // Seed: mean of the first 60 squared returns; then sigma2_t = d*sigma2_{t-1} + (1-d)*r_{t-1}^2.
  let s2 = 0;
  for (let i = 1; i <= SEED_RETURNS; i++) s2 += ret[i] * ret[i];
  s2 /= SEED_RETURNS;
  for (let t = SEED_RETURNS + 1; t < n; t++) s2 = FT_DELTA * s2 + (1 - FT_DELTA) * ret[t - 1] * ret[t - 1];
  const sigma = Math.max(Math.sqrt(s2), SIGMA_FLOOR);

  const last = n - 1;
  const z = FT_HORIZONS.map((k) => {
    const r = Math.log(bars[last].close / bars[last - k].close);
    if (r === 0) return 0;
    return Math.max(-FT_CLIP, Math.min(FT_CLIP, r / (sigma * Math.sqrt(k))));
  }) as [number, number, number];

  const sigmaAnn = sigma * Math.sqrt(365);
  const value = FT_SCALE * ((z[0] + z[1] + z[2]) / 3);
  const size = Math.min(FT_SIZE_CAP, FT_TARGET_VOL / sigmaAnn) * 100;
  return { value, size, z, sigmaAnn, asOf: bars[last].time + DAY_MS };
}

/**
 * Value per bar from daily bars with close <= that bar's close time. Memoised by the last
 * daily bar used, so a few hundred bars cost about one computation per day.
 */
export function fundTrendSeriesFull(daily: Kline[], bars: { time: number; closeTime: number }[]): (FundTrend | null)[] {
  const memo = new Map<number, FundTrend | null>();
  let hi = 0; // number of daily bars with close <= current bar's close (bars assumed ascending)
  let prevClose = -Infinity;
  return bars.map((b) => {
    if (b.closeTime < prevClose) hi = 0;
    prevClose = b.closeTime;
    while (hi < daily.length && daily[hi].time + DAY_MS <= b.closeTime) hi++;
    if (hi === 0) return null;
    const key = daily[hi - 1].time;
    if (!memo.has(key)) memo.set(key, fundTrend(daily, key + DAY_MS));
    return memo.get(key) ?? null;
  });
}

/** Value per bar (see fundTrendSeriesFull for the no-look-ahead rule and memoisation). */
export function fundTrendSeries(daily: Kline[], bars: { time: number; closeTime: number }[]): (number | null)[] {
  return fundTrendSeriesFull(daily, bars).map((f) => f?.value ?? null);
}

export function isFundTrendClass(ac: AssetClass): boolean {
  return ac === "crypto";
}

/** 1 = strongest positive; ties share a rank (competition ranking); non-finite values are excluded. */
export function fundRank(values: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  const finite = [...values].filter(([, v]) => Number.isFinite(v));
  for (const [k, v] of finite) out.set(k, 1 + finite.filter(([, w]) => w > v).length);
  return out;
}

/**
 * Fund rank over the crypto rows of one source (values from the Fund trend feed). `ranks` maps pair -> rank, `n` = ranked rows.
 * Shared by the panel header and the optional list column.
 */
export function fundRanks(
  rows: readonly { src: string; pair: string; assetClass: AssetClass }[],
  states: ReadonlyMap<string, FundTrendState | { value: number }>,
  src: string,
): { ranks: Map<string, number>; n: number } {
  const values = new Map<string, number>();
  for (const r of rows) {
    if (r.src !== src || !isFundTrendClass(r.assetClass)) continue;
    const st = states.get(`${r.src}|${r.pair}`);
    if (st && !("na" in st)) values.set(r.pair, st.value);
  }
  return { ranks: fundRank(values), n: values.size };
}

export function disagreement(score: number, ft: number | null): -1 | 0 | 1 {
  if (ft == null || !Number.isFinite(ft)) return 0;
  if (score >= FT_DISAGREE_SCORE && ft <= -FT_DISAGREE_FT) return 1;
  if (score <= -FT_DISAGREE_SCORE && ft >= FT_DISAGREE_FT) return -1;
  return 0;
}

export function ribbonStyle(x: number | null): { colour: "up" | "down" | "grey" | "none"; alpha: number } {
  if (x == null || !Number.isFinite(x)) return { colour: "none", alpha: 0 };
  const alpha = 0.25 + 0.75 * Math.min(1, Math.abs(x) / 100);
  if (Math.abs(x) < FT_GREY) return { colour: "grey", alpha };
  return { colour: x > 0 ? "up" : "down", alpha };
}
