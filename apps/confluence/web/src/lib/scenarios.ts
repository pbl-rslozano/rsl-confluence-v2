/**
 * scenarios.ts — v2.8 (WP22) direction-neutral candle block bootstrap.
 *
 * Pure module: no I/O, no clock, no scoring. "Possible scenarios from past data — not a forecast."
 * Past candles become relative candles (OHLC / previous close); blocks of 6 are drawn from bars whose
 * volatility (ATR(14)/close percentile) is near today's; the sample's mean log return is removed so the
 * fan is centred. Seeded from pair + timeframe + last closed bar time, so a refresh reproduces it.
 */
import { atr as atrSeries, type Kline } from "./indicators";
import { rng } from "./ledger-metrics";

export const SC_PATHS = 200;
export const SC_BLOCK = 6;
export const SC_STEPS = 24;
export const SC_HORIZONS = [6, 24] as const;
export type ScHorizon = 6 | 24;
export const SC_MIN_BARS = 300;
export const SC_ATR = 14;
export const SC_VOL_BAND = 15;
export const SC_VOL_WIDE = 30;
export const SC_MIN_BLOCKS = 20;
export const SC_QUANTILES = [0.025, 0.16, 0.5, 0.84, 0.975] as const;

export interface Ohlc { open: number; high: number; low: number; close: number }
export interface Band { p025: number; p16: number; p50: number; p84: number; p975: number }
export interface Simulation {
  paths: Ohlc[][];
  bands: Band[];
  volPct: number;
  widened: 15 | 30 | "all";
  blocks: number;
  mu: number;
}

const DAY = 86_400_000;

/** FNV-1a 32-bit over the UTF-16 code units of `pair|tf|lastBarTime`. */
export function scenarioSeed(pair: string, tf: string, lastBarTime: number): number {
  const s = `${pair}|${tf}|${lastBarTime}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Linear-interpolation quantile (R type 7) of an ascending array. */
export function quantile7(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/** Same contiguity notion as measureOutcome: 0 < Δ ≤ 31 d (monthly) or 1.5 × interval. */
export function stepOk(prevTime: number, time: number, intervalMs: number): boolean {
  const d = time - prevTime;
  const maxSpan = intervalMs >= 28 * DAY ? 31 * DAY : 1.5 * intervalMs;
  return d > 0 && d <= maxSpan;
}

/** Wilder ATR(14) on exactly these bars, and the percentile rank (0–100) of ATR/close among all finite values. */
export function volPercentiles(bars: Kline[]): { atr: number[]; pct: number[] } {
  const a = atrSeries(bars, SC_ATR);
  const ratio = a.map((v, i) => {
    const r = v / bars[i].close;
    return Number.isFinite(r) ? r : NaN;
  });
  const sorted = ratio.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  const n = sorted.length;
  // first index with sorted[i] >= v (below = i) and first with sorted[i] > v (below + equal)
  const lowerBound = (v: number, strict: boolean): number => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (strict ? sorted[mid] <= v : sorted[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const pct = ratio.map((v) => {
    if (!Number.isFinite(v) || n === 0) return NaN;
    const below = lowerBound(v, false);
    const equal = lowerBound(v, true) - below;
    return (100 * (below + 0.5 * equal)) / n;
  });
  return { atr: a, pct };
}

interface Prepared {
  /** rel[i] = [o,h,l,c] / close[i-1], or null when invalid or not contiguous. */
  rel: (readonly [number, number, number, number] | null)[];
  pct: number[];
  allStarts: number[];
}

function prepare(bars: Kline[], intervalMs: number): Prepared {
  const n = bars.length;
  const rel: Prepared["rel"] = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const p = bars[i - 1].close;
    const b = bars[i];
    if (!stepOk(bars[i - 1].time, b.time, intervalMs)) continue;
    const v = [b.open / p, b.high / p, b.low / p, b.close / p] as const;
    if (v.every((x) => Number.isFinite(x) && x > 0)) rel[i] = v;
  }
  const allStarts: number[] = [];
  for (let j = 1; j + SC_BLOCK - 1 < n; j++) {
    let valid = true;
    for (let k = 0; k < SC_BLOCK; k++) if (!rel[j + k]) { valid = false; break; }
    if (valid) allStarts.push(j);
  }
  return { rel, pct: volPercentiles(bars).pct, allStarts };
}

function startsFor(p: Prepared, band: 15 | 30 | "all"): number[] {
  if (band === "all") return p.allStarts;
  const today = p.pct[p.pct.length - 1];
  if (!Number.isFinite(today)) return [];
  return p.allStarts.filter((j) => {
    const v = p.pct[j - 1];
    return Number.isFinite(v) && Math.abs(v - today) <= band;
  });
}

/** Test hook: block starts eligible for a volatility band. */
export function eligibleStartsForTests(bars: Kline[], intervalMs: number, band: 15 | 30 | "all"): number[] {
  return startsFor(prepare(bars, intervalMs), band);
}

export function simulate(bars: Kline[], intervalMs: number, seed: number): Simulation | null {
  if (bars.length < SC_MIN_BARS) return null;
  const p = prepare(bars, intervalMs);
  let widened: 15 | 30 | "all" = SC_VOL_BAND;
  let starts = startsFor(p, SC_VOL_BAND);
  if (starts.length < SC_MIN_BLOCKS) { widened = SC_VOL_WIDE; starts = startsFor(p, SC_VOL_WIDE); }
  if (starts.length < SC_MIN_BLOCKS) { widened = "all"; starts = p.allStarts; }
  if (starts.length === 0) return null;

  // μ: mean ln(rel.close) over the distinct relative candles the eligible blocks cover.
  const covered = new Uint8Array(bars.length);
  for (const j of starts) for (let k = 0; k < SC_BLOCK; k++) covered[j + k] = 1;
  let sum = 0;
  let cnt = 0;
  for (let i = 1; i < bars.length; i++) {
    if (covered[i]) { sum += Math.log(p.rel[i]![3]); cnt++; }
  }
  const mu = sum / cnt;
  const adj = Math.exp(-mu);

  const lastClose = bars[bars.length - 1].close;
  const r = rng(seed);
  const paths: Ohlc[][] = [];
  const closes: Float64Array[] = Array.from({ length: SC_STEPS }, () => new Float64Array(SC_PATHS));
  for (let pi = 0; pi < SC_PATHS; pi++) {
    const path: Ohlc[] = [];
    let P = lastClose;
    let j = 0;
    // Step index k = 0…SC_STEPS-1 is step s = k + 1; a new block is drawn every SC_BLOCK steps.
    for (let k = 0; k < SC_STEPS; k++) {
      if (k % SC_BLOCK === 0) j = starts[Math.floor(r() * starts.length)];
      const q = p.rel[j + (k % SC_BLOCK)]!;
      const c: Ohlc = { open: P * q[0] * adj, high: P * q[1] * adj, low: P * q[2] * adj, close: P * q[3] * adj };
      path.push(c);
      P = c.close;
      closes[k][pi] = P;
    }
    paths.push(path);
  }

  const bands: Band[] = closes.map((arr) => {
    arr.sort();
    const [a, b, c, d, e] = SC_QUANTILES.map((q) => quantile7(arr, q));
    return { p025: a, p16: b, p50: c, p84: d, p975: e };
  });

  return { paths, bands, volPct: p.pct[p.pct.length - 1], widened, blocks: starts.length, mu };
}
