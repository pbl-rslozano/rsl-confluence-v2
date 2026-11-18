/**
 * scan-jobs.ts — v2.1.1
 * One scan job = score one series (fixed engine window) + its analogue pattern.
 * Executed inside the scan worker, or on the main thread as a fallback.
 */
import type { ScoringProfile } from "./scoring-profile";
import type { Kline } from "./indicators";
import type { AssetClass } from "./ledger-metrics";
import { scoreSeries, toLedgerRow, type RowContext, type SeriesScore } from "./scan-pipeline";
import type { LedgerRow } from "./ledger-metrics";
import { barWhileClosed } from "./asset-classes";
import { ENGINE_BARS, engineConfigId } from "./engine-config";
import { scoreV2, v2Compact, type V2Result } from "./confluence-v2";
import { detectHistoricalPattern, emptySignal, type PatternSignal } from "./pattern-signal";

export interface ScanJob {
  profile?: ScoringProfile | null;
  key: string; // source:interval:symbol
  /** Closed, contiguous bars, oldest first, packed [time, o, h, l, c, v] × n (transferable). */
  packed: Float64Array;
  intervalMs: number;
  volumeAvailable: boolean;
  assetClass?: AssetClass;
  /**
   * v2.2 catch-up: score every closed bar after `since` (except the newest,
   * which the live path records) — at most `max` bars — and return ledger rows
   * instead of a live score. Fills the holes left while the app was closed.
   */
  catchUp?: { since: number; max: number; ctx: Omit<RowContext, "closeTime" | "underlyingClosed"> };
  /**
   * v2.8 (WP27): an instant-start row drawn from on-device history (display only, never recorded). Scored the
   * same way; the analogue Pattern (≈100 ms per series) is reused only when it was computed on exactly these bars,
   * otherwise left for the fresh series, so history rows do not delay the fresh ones in the worker.
   */
  displayOnly?: boolean;
}

/** Consecutive slices of at most `n` items, in order (n < 1 is treated as 1). */
export function chunk<T>(xs: readonly T[], n: number): T[][] {
  const size = Math.max(1, Math.floor(n));
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** TEST ONLY: lets a test make v2 throw. Production code never writes it. */
export const v2TestHook: { score: typeof scoreV2 } = { score: scoreV2 };

/** v2 is logged beside Classic and must never take Classic down: a fault gives null (the field is simply not computed). */
export function guardedV2(k: Kline[], o: Parameters<typeof scoreV2>[1]): V2Result | null {
  try { return v2TestHook.score(k, o); } catch { return null; }
}

export function packKlines(k: Kline[]): Float64Array {
  const out = new Float64Array(k.length * 6);
  for (let i = 0; i < k.length; i++) {
    const b = k[i];
    const o = i * 6;
    out[o] = b.time; out[o + 1] = b.open; out[o + 2] = b.high; out[o + 3] = b.low; out[o + 4] = b.close; out[o + 5] = b.volume;
  }
  return out;
}

export function unpackKlines(p: Float64Array): Kline[] {
  const n = Math.floor(p.length / 6);
  const out: Kline[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    out[i] = { time: p[o], open: p[o + 1], high: p[o + 2], low: p[o + 3], close: p[o + 4], volume: p[o + 5] };
  }
  return out;
}

export interface ScanJobResult {
  key: string;
  score: SeriesScore;
  pattern: PatternSignal;
  /**
   * v2.8 (WP23): Confluence v2 on the same bars, beside Classic. Set for every non-catch-up job (displayOnly included),
   * never takes the scoring profile, logged only. Null when the job failed.
   */
  v2?: V2Result | null;
  catchUpRows?: LedgerRow[];
  /** v2.3: bars after `since` that catch-up could not cover (beyond `max` or the window). */
  gap?: { from: number; to: number };
  /** Set when this job failed; the scan carries on with the other series. */
  error?: string;
}

/** Analogue results only change when a new bar closes; reuse them until then. */
const patternMemo = new Map<string, { lastTime: number; length: number; pattern: PatternSignal }>();

export function runCatchUp(job: ScanJob, klines: Kline[]): { rows: LedgerRow[]; gap?: { from: number; to: number } } {
  const cu = job.catchUp!;
  const rows: LedgerRow[] = [];
  const last = klines.length - 1;
  const first = Math.max(0, last - cu.max);
  let firstCovered = Infinity;
  for (let j = first; j < last; j++) {
    const t = klines[j].time;
    if (t <= cu.since) continue;
    // Only full windows: a shorter window would score differently from replay
    // (warm-up bias). Young series are recorded live only.
    if (j + 1 < ENGINE_BARS) continue;
    if (t < firstCovered) firstCovered = t;
    const window = klines.slice(j - ENGINE_BARS + 1, j + 1);
    const s = scoreSeries(window, { intervalMs: job.intervalMs, volumeAvailable: job.volumeAvailable, assetClass: job.assetClass, profile: job.profile });
    if (!s.usable) continue;
    const row = toLedgerRow(window, s, {
      ...cu.ctx,
      // Calendar months close at the next month start; other bars after one interval.
      closeTime: job.intervalMs >= 28 * 86_400_000 ? Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth() + 1, 1) : t + job.intervalMs,
      underlyingClosed: job.assetClass ? barWhileClosed(job.assetClass, t, job.intervalMs) : false,
    });
    if (row) {
      // v2.8 (WP23): v2 on the same window Classic used for this row; logged, never scored.
      row.v2 = v2Compact(guardedV2(window, { intervalMs: job.intervalMs, volumeAvailable: job.volumeAvailable, assetClass: job.assetClass }), row.t);
      rows.push(row);
    }
  }
  // Bars after the cursor that could not be scored (hole longer than `max`,
  // history shorter than a full window) are reported, never silently lost.
  const expectedFrom = cu.since > 0 ? cu.since + job.intervalMs : Infinity;
  const coveredFrom = Number.isFinite(firstCovered) ? firstCovered : last >= 0 ? klines[last].time : Infinity;
  const gap = expectedFrom < coveredFrom ? { from: expectedFrom, to: coveredFrom - job.intervalMs } : undefined;
  return gap ? { rows, gap } : { rows };
}

/**
 * v2.8 (WP21): the Confluence score of each of the last `visible` bars of `klines` (the caller passes the series up to the
 * newest bar it wants scored). Same full-window rule and `scoreSeries` options as `runCatchUp`: a bar is scored on the
 * ENGINE_BARS bars ending at it, and is null when it has no full window (or the window is unusable), so a scored bar
 * carries exactly the number the list shows. `known` (bar open time -> score, e.g. ledger rows with the same cfg and
 * wb = ENGINE_BARS) is used as is and not re-scored. The array has min(visible, klines.length) entries, oldest first.
 */
export function scoreVisibleBars(job: ScanJob, klines: Kline[], visible: number, known?: ReadonlyMap<number, number>): (number | null)[] {
  const last = klines.length - 1;
  const first = Math.max(0, last - Math.max(0, Math.floor(visible)) + 1);
  const out: (number | null)[] = [];
  for (let j = first; j <= last; j++) {
    if (j + 1 < ENGINE_BARS) { out.push(null); continue; }
    const t = klines[j].time;
    const k = known?.get(t);
    if (k !== undefined) { out.push(k); continue; }
    const window = klines.slice(j - ENGINE_BARS + 1, j + 1);
    const s = scoreSeries(window, { intervalMs: job.intervalMs, volumeAvailable: job.volumeAvailable, assetClass: job.assetClass, profile: job.profile });
    out.push(s.usable ? s.confluence.score : null);
  }
  return out;
}

/** Never throws: a failing series returns `error` and an unusable score. */
export function runScanJobSafe(job: ScanJob): ScanJobResult {
  try {
    return runScanJob(job);
  } catch (error) {
    return {
      key: job.key,
      score: scoreSeries([], { intervalMs: job.intervalMs, volumeAvailable: false }),
      pattern: emptySignal("Scoring failed"),
      v2: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function runScanJob(job: ScanJob): ScanJobResult {
  const klines = unpackKlines(job.packed);
  if (job.catchUp) {
    const cu = runCatchUp(job, klines);
    return { key: job.key, score: scoreSeries([], { intervalMs: job.intervalMs, volumeAvailable: false }), pattern: emptySignal("catch-up"), catchUpRows: cu.rows, ...(cu.gap ? { gap: cu.gap } : {}) };
  }
  const score = scoreSeries(klines, { intervalMs: job.intervalMs, volumeAvailable: job.volumeAvailable, assetClass: job.assetClass, profile: job.profile });
  const v2 = guardedV2(klines, { intervalMs: job.intervalMs, volumeAvailable: job.volumeAvailable, assetClass: job.assetClass });
  if (!score.usable) return { key: job.key, score, pattern: emptySignal("Insufficient data"), v2 };
  const lastTime = klines.length ? klines[klines.length - 1].time : 0;
  const patternKey = job.key + (job.profile ? "|" + engineConfigId(job.profile) : "");
  const prior = patternMemo.get(patternKey);
  if (prior && prior.lastTime === lastTime && prior.length === klines.length) {
    return { key: job.key, score, pattern: prior.pattern, v2 };
  }
  if (job.displayOnly) return { key: job.key, score, pattern: emptySignal("Updating"), v2 };
  const pattern = detectHistoricalPattern(klines, {
    volumeAvailable: job.volumeAvailable,
    intervalMs: job.intervalMs,
    currentConfluence: score.confluence,
    currentReversal: score.reversal,
    cacheKey: patternKey,
  });
  patternMemo.set(patternKey, { lastTime, length: klines.length, pattern });
  if (patternMemo.size > 2000) patternMemo.delete(patternMemo.keys().next().value as string);
  return { key: job.key, score, pattern, v2 };
}
