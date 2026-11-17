/**
 * scenarios.ts — v2.8 (WP22) direction-neutral candle block bootstrap.
 *
 * Pure module: no I/O, no clock, no scoring. "Possible scenarios from past data — not a forecast."
 * Past candles become relative candles (OHLC / previous close); blocks of 6 are drawn from bars whose
 * volatility (ATR(14)/close percentile) is near today's; the sample's mean log return is removed so the
 * fan is centred. Seeded from pair + timeframe + last closed bar time, so a refresh reproduces it.
 */
import { atr as atrSeries, type Kline } from "./indicators";
import { rng, roundFt, wilson } from "./ledger-metrics";
import { fundTrendSeries, FT_MAX_STALE_MS } from "./fund-trend";

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

// ---------------------------------------------------------------- odds, paths and ledger fields (Task 2)

export const SC_STATE_TH = 15;
export const SC_SAMPLE_EVERY = 2;
export const SC_MIN_NEFF = 20;
export const SC_BUCKET = 0.5;
export const SC_OFFICIAL_H = 6;

export type FtState = "up" | "flat" | "down";

/** Fund trend direction only: down <= -15, up >= 15, otherwise flat. Null and non-finite -> null. */
export function ftState(ft: number | null | undefined): FtState | null {
  if (typeof ft !== "number" || !Number.isFinite(ft)) return null;
  return ft <= -SC_STATE_TH ? "down" : ft >= SC_STATE_TH ? "up" : "flat";
}

/** Volatility regime from today's ATR/close percentile, cut at 33 / 67. NaN (bad data) is unknown, never a number. */
export function volRegime(volPct: number | null | undefined): "low" | "mid" | "high" | null {
  if (typeof volPct !== "number" || !Number.isFinite(volPct)) return null;
  return volPct < 33 ? "low" : volPct > 67 ? "high" : "mid";
}

/** Local copy of market-client.barCloseTime (that module pulls in venue code). Monthly bars close at the next UTC month start. */
export function barClose(openTime: number, intervalMs: number): number {
  if (intervalMs >= 28 * DAY && intervalMs <= 31 * DAY) {
    const d = new Date(openTime);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return openTime + intervalMs;
}

function newestClosedDaily(daily: Kline[], closeTime: number): Kline | null {
  let lo = 0;
  let hi = daily.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (daily[mid].time + DAY <= closeTime) lo = mid + 1; else hi = mid;
  }
  return lo > 0 ? daily[lo - 1] : null;
}

/** Fund trend as of each bar's own close (no look-ahead), rounded like the ledger; null when absent or stale (same rule as applyFundTrend). */
export function ftAtBars(daily: Kline[] | null, bars: Kline[], intervalMs: number): (number | null)[] {
  if (!daily || daily.length === 0) return bars.map(() => null);
  const closes = bars.map((b) => barClose(b.time, intervalMs));
  const values = fundTrendSeries(daily, bars.map((b, i) => ({ time: b.time, closeTime: closes[i] })));
  return values.map((v, i) => {
    const newest = newestClosedDaily(daily, closes[i]);
    return typeof v === "number" && newest !== null && closes[i] - (newest.time + DAY) <= FT_MAX_STALE_MS ? roundFt(v) : null;
  });
}

export type Bucket = "up" | "range" | "down";
export const BUCKETS = ["up", "range", "down"] as const;
export type Scenario = "continue" | "pause" | "reverse" | "up" | "range" | "down";

export function bucketOf(x: number): Bucket {
  return x > SC_BUCKET ? "up" : x < -SC_BUCKET ? "down" : "range";
}

export function scenarioOf(b: Bucket, s: FtState | null): Scenario {
  if (s === "up") return b === "up" ? "continue" : b === "range" ? "pause" : "reverse";
  if (s === "down") return b === "down" ? "continue" : b === "range" ? "pause" : "reverse";
  return b;
}

export function scenarioOrder(s: FtState | null): Scenario[] {
  return s === "up" || s === "down" ? ["continue", "pause", "reverse"] : ["up", "range", "down"];
}

export interface BucketOdds { p: number; lo: number; hi: number; cases: number }
export interface ScenarioOdds {
  state: FtState | null;
  fallback: "noState" | "fewMatches" | null;
  matches: number;
  nEff: number;
  odds: Record<Bucket, BucketOdds>;
  base: Record<Bucket, number>;
  baseNEff: number;
  sigmaH: number;
  withState: number;
  sampled: number;
}

/**
 * Odds of the three outcome buckets after h bars, from past bars sampled every 2 bars newest-first.
 * Outcome x = ln(c[i+h]/c[i]) / (ATR_i/c_i * sqrt(h)). Null when nothing is sampled or today's ATR is not finite.
 */
export function scenarioOdds(bars: Kline[], ftAt: (number | null)[], h: ScHorizon, intervalMs: number): ScenarioOdds | null {
  const n = bars.length;
  const last = n - 1;
  const a = atrSeries(bars, SC_ATR);
  const sigmaH = (a[last] / bars[last]?.close) * Math.sqrt(h);
  if (!(sigmaH > 0) || !Number.isFinite(sigmaH)) return null;

  const xs: number[] = [];
  const sts: (FtState | null)[] = [];
  for (let i = last - h; i >= 0; i -= SC_SAMPLE_EVERY) {
    const ai = a[i];
    if (!Number.isFinite(ai) || !(ai > 0)) continue;
    let ok = true;
    for (let k = i + 1; k <= i + h; k++) if (!stepOk(bars[k - 1].time, bars[k].time, intervalMs)) { ok = false; break; }
    if (!ok) continue;
    const x = Math.log(bars[i + h].close / bars[i].close) / ((ai / bars[i].close) * Math.sqrt(h));
    if (!Number.isFinite(x)) continue;
    xs.push(x);
    sts.push(ftState(ftAt[i]));
  }
  const sampled = xs.length;
  if (sampled === 0) return null;

  const tally = (pick: (idx: number) => boolean): Record<Bucket, number> => {
    const c: Record<Bucket, number> = { up: 0, range: 0, down: 0 };
    for (let q = 0; q < sampled; q++) if (pick(q)) c[bucketOf(xs[q])]++;
    return c;
  };
  const state = ftState(ftAt[last]);
  const withState = sts.filter((s) => s !== null).length;
  const matches = state === null ? 0 : sts.filter((s) => s === state).length;
  const allCounts = tally(() => true);
  const baseNEff = (sampled * 2) / h;
  const base = { up: allCounts.up / sampled, range: allCounts.range / sampled, down: allCounts.down / sampled };

  let fallback: ScenarioOdds["fallback"] = null;
  let counts = allCounts;
  let total = sampled;
  let nEff = baseNEff;
  if (state === null) fallback = "noState";
  else if ((matches * 2) / h < SC_MIN_NEFF) fallback = "fewMatches";
  if (fallback === null) {
    counts = tally((q) => sts[q] === state);
    total = matches;
    nEff = (matches * 2) / h;
  }
  const odds = {} as Record<Bucket, BucketOdds>;
  for (const b of BUCKETS) {
    const p = counts[b] / total;
    const [lo, hi] = wilson(p * nEff, nEff);
    odds[b] = { p, lo, hi, cases: counts[b] };
  }
  return { state, fallback, matches, nEff, odds, base, baseNEff, sigmaH, withState, sampled };
}

/** Per bucket, the simulated path whose end-of-horizon x is nearest the bucket's median x (ties -> lowest index); empty -> null. */
export function pickPaths(sim: Simulation, h: ScHorizon, sigmaH: number, lastClose: number): Record<Bucket, number | null> {
  const groups: Record<Bucket, { p: number; x: number }[]> = { up: [], range: [], down: [] };
  sim.paths.forEach((path, p) => {
    const x = Math.log(path[h - 1].close / lastClose) / sigmaH;
    if (Number.isFinite(x)) groups[bucketOf(x)].push({ p, x });
  });
  const out: Record<Bucket, number | null> = { up: null, range: null, down: null };
  for (const b of BUCKETS) {
    const g = groups[b];
    if (g.length === 0) continue;
    const med = quantile7(g.map((e) => e.x).sort((u, v) => u - v), 0.5);
    let best = g[0];
    for (const e of g) {
      const d = Math.abs(e.x - med);
      const bd = Math.abs(best.x - med);
      if (d < bd || (d === bd && e.p < best.p)) best = e;
    }
    out[b] = best.p;
  }
  return out;
}

export interface ScenarioRequest { pair: string; tf: string; intervalMs: number; bars: Kline[]; daily: Kline[] | null; horizon: ScHorizon }
export interface ScenarioResult {
  key: string;
  horizon: ScHorizon;
  lastClose: number;
  lastTime: number;
  barCount: number;
  bands: Band[];
  paths: Record<Bucket, Ohlc[] | null>;
  odds: ScenarioOdds;
  volPct: number;
  widened: 15 | 30 | "all";
  atr: number;
  ftNow: number | null;
}

export function scenarioKey(req: Pick<ScenarioRequest, "pair" | "tf" | "horizon">, lastTime: number, barCount: number, dailyLast: number | null): string {
  return `${req.pair}|${req.tf}|${lastTime}|${barCount}|${req.horizon}|${dailyLast ?? "-"}`;
}

/** Shared by the sheet and the ledger fields: one 24-step simulation, odds at horizon h. */
function core(bars: Kline[], ftAt: (number | null)[], h: ScHorizon, ctx: { pair: string; tf: string; intervalMs: number }): { sim: Simulation; odds: ScenarioOdds } | null {
  if (bars.length < SC_MIN_BARS) return null;
  const odds = scenarioOdds(bars, ftAt, h, ctx.intervalMs);
  if (!odds) return null;
  const sim = simulate(bars, ctx.intervalMs, scenarioSeed(ctx.pair, ctx.tf, bars[bars.length - 1].time));
  return sim ? { sim, odds } : null;
}

export function runScenarios(req: ScenarioRequest): ScenarioResult | { na: "history" } {
  const { bars, horizon: h } = req;
  if (bars.length < SC_MIN_BARS) return { na: "history" };
  const ftAt = ftAtBars(req.daily, bars, req.intervalMs);
  const c = core(bars, ftAt, h, req);
  if (!c) return { na: "history" };
  const lastBar = bars[bars.length - 1];
  const picked = pickPaths(c.sim, h, c.odds.sigmaH, lastBar.close);
  const paths = {} as Record<Bucket, Ohlc[] | null>;
  for (const b of BUCKETS) paths[b] = picked[b] === null ? null : c.sim.paths[picked[b]!].slice(0, h);
  const dailyLast = req.daily && req.daily.length ? req.daily[req.daily.length - 1].time : null;
  return {
    key: scenarioKey(req, lastBar.time, bars.length, dailyLast),
    horizon: h,
    lastClose: lastBar.close,
    lastTime: lastBar.time,
    barCount: bars.length,
    bands: c.sim.bands.slice(0, h),
    paths,
    odds: c.odds,
    volPct: c.sim.volPct,
    widened: c.sim.widened,
    atr: atrSeries(bars, SC_ATR)[bars.length - 1],
    ftNow: ftAt[ftAt.length - 1] ?? null,
  };
}

export type Scb = [lo95: number, lo68: number, hi68: number, hi95: number];
export interface Scp { s: -1 | 0 | 1 | null; p: [number, number, number]; b: [number, number, number]; w: number; f: 0 | 1 }

const r5 = (v: number): number => Math.round(v * 1e5) / 1e5;
const r3 = (v: number): number => Math.round(v * 1e3) / 1e3;

/** Ledger fields at the official H = 6: band edges at step 6 as ln(band / last close), and the three odds with what scoring needs. */
export function scenarioFields(window: Kline[], ftAt: (number | null)[], ctx: { pair: string; tf: string; intervalMs: number }): { scb: Scb | null; scp: Scp | null } {
  const c = core(window, ftAt, SC_OFFICIAL_H, ctx);
  if (!c) return { scb: null, scp: null };
  const lc = window[window.length - 1].close;
  const b = c.sim.bands[SC_OFFICIAL_H - 1];
  const scb: Scb = [r5(Math.log(b.p025 / lc)), r5(Math.log(b.p16 / lc)), r5(Math.log(b.p84 / lc)), r5(Math.log(b.p975 / lc))];
  const o = c.odds;
  const scp: Scp = {
    s: o.state === "down" ? -1 : o.state === "flat" ? 0 : o.state === "up" ? 1 : null,
    p: [r3(o.odds.up.p), r3(o.odds.range.p), r3(o.odds.down.p)],
    b: [r3(o.base.up), r3(o.base.range), r3(o.base.down)],
    w: r5(o.sigmaH),
    f: o.fallback ? 1 : 0,
  };
  return { scb: scb.every(Number.isFinite) ? scb : null, scp: scp.w > 0 ? scp : null };
}
