/**
 * scan-pipeline.ts — v2.3
 * ----------------------------------------------------------------------------
 * One scoring path for every caller: the live scan (main thread or worker),
 * the signal ledger and the Node replay/backtest. A score produced live and a
 * score produced by replaying the same closed bars are bit-for-bit identical,
 * because both go through `scoreSeries` with the same fixed window.
 * ----------------------------------------------------------------------------
 */
import { normalizeScoringProfile, type ScoringProfile } from "./scoring-profile";
import { runConfluence, type ConfluenceResult, type Kline } from "./indicators";
import { detectReversal, type ReversalResult } from "./reversal";
import { ENGINE_BARS, MIN_ENGINE_BARS } from "./engine-window";
import { ENGINE_VERSION, engineConfigId } from "./engine-config";
import type { AssetClass, LedgerRow } from "./ledger-metrics";
import { barWhileClosed } from "./asset-classes";
import { detectSplit } from "./splits";

export interface ScoreOptions {
  profile?: ScoringProfile | null;
  intervalMs: number;
  /** False when the provider (or the asset class) has no meaningful candle volume. */
  volumeAvailable: boolean;
  /** Asset class profile (v2.1.1): FX turns the low-volatility cap off. */
  assetClass?: AssetClass;
}

export interface SeriesScore {
  profile?: ScoringProfile;
  usable: boolean;
  /** Bars the engine actually saw (≤ ENGINE_BARS). Rows below ENGINE_BARS are flagged "cold" in the ledger. */
  warmBars: number;
  confluence: ConfluenceResult;
  reversal: ReversalResult;
  /** v2.3: stock series scored on regular-session bars only. */
  sessionFiltered?: boolean;
  /** v2.3: a probable stock split in the window muted the signal. */
  split?: boolean;
  /** v2.3: bars the indicators actually saw (after the stock session filter); = warmBars otherwise. */
  engineBars?: number;
}

const DAY_MS = 86_400_000;
/**
 * v2.3 — tokenised stocks trade 24/7, but the reference market does not:
 * intraday and daily stock series are scored on bars that overlap the NYSE
 * regular session only, so overnight/weekend drift on a stale reference does
 * not feed the indicators.
 */
export function sessionBars(k: Kline[], assetClass: AssetClass | undefined, intervalMs: number): Kline[] {
  if (assetClass !== "stock" || intervalMs > DAY_MS) return k;
  return k.filter((b) => !barWhileClosed("stock", b.time, intervalMs));
}

export { detectSplit } from "./splits";
export function suppressedConfluence(reason: string): ConfluenceResult {
  return {
    indicators: [],
    bull: 0,
    bear: 0,
    neutral: 0,
    master: "NEUTRAL",
    strength: "WEAK",
    score: 0,
    validCount: 0,
    excludedCount: 21,
    suppressed: true,
    lowVolatility: false,
    blocs: [],
    warnings: [reason],
  };
}

export function emptyReversal(): ReversalResult {
  return {
    signals: [],
    currentTrend: "RANGING",
    direction: "NONE",
    isReversal: false,
    confidence: "NONE",
    score: 0,
    upCount: 0,
    downCount: 0,
    summary: "Insufficient data",
  };
}

/** True when a series has real, non-zero traded volume on most bars. */
export function hasUsableVolume(k: Kline[]): boolean {
  if (!k.length) return false;
  const tail = k.slice(-200);
  const withVolume = tail.filter((b) => Number.isFinite(b.volume) && b.volume > 0).length;
  return withVolume / tail.length >= 0.8;
}

/**
 * Score the newest closed bar of `k` (already closed-bar-only and contiguous).
 * Always evaluates exactly the last ENGINE_BARS bars when available.
 */
export function scoreSeries(k: Kline[], options: ScoreOptions): SeriesScore {
  // The window is ALWAYS the last ENGINE_BARS raw bars (live, catch-up and
  // replay slice identically); stocks then keep only regular-session bars.
  // warmBars counts the raw window, so "full window" means the same thing for
  // every class.
  const profile = normalizeScoringProfile(options.profile);
  const raw = k.length > ENGINE_BARS ? k.slice(-ENGINE_BARS) : k;
  const engineBars = sessionBars(raw, options.assetClass, options.intervalMs);
  const sessionFiltered = engineBars !== raw;
  if (engineBars.length < MIN_ENGINE_BARS) {
    return {
      ...(profile ? { profile } : {}),
      usable: false,
      warmBars: raw.length,
      confluence: suppressedConfluence("Insufficient candle history for scoring."),
      reversal: emptyReversal(),
      ...(sessionFiltered ? { sessionFiltered } : {}),
    };
  }
  if (options.assetClass === "stock" && detectSplit(engineBars)) {
    return {
      ...(profile ? { profile } : {}),
      usable: true,
      warmBars: raw.length,
      confluence: suppressedConfluence("Possible stock split in the window — signal muted."),
      reversal: emptyReversal(),
      sessionFiltered,
      split: true,
      engineBars: engineBars.length,
    };
  }
  const volumeAvailable = options.volumeAvailable && hasUsableVolume(engineBars);
  return {
    ...(profile ? { profile } : {}),
    usable: true,
    warmBars: raw.length,
    confluence: runConfluence(engineBars, { profile, volumeAvailable, intervalMs: options.intervalMs, lowVolatilityCap: options.assetClass !== "fx" }),
    reversal: detectReversal(engineBars),
    ...(sessionFiltered ? { sessionFiltered, engineBars: engineBars.length } : {}),
  };
}

/* ------------------------------------------------------------------ *
 *  Ledger row construction (v2.1.1)
 * ------------------------------------------------------------------ */
export interface RowContext {
  src: string;
  tf: string;
  pair: string;
  ac: AssetClass;
  intervalMs: number;
  /** Close time of the signal bar (calendar-aware for 1M). */
  closeTime: number;
  rank: number;
  quoteVolume: number;
  appVersion: string;
  live: boolean;
  recordedAt?: number;
  /** Stocks/FX: the underlying market was shut for the whole bar. */
  underlyingClosed?: boolean;
  /** v2.3: rank in the full unfiltered venue ranking, and where the ranks came from. */
  universeRank?: number;
  rankSource?: "live" | "now" | "none";
}

const BLOC_ORDER = ["trend", "meanReversion", "breakout", "flow"] as const;
const REV_CONF: Record<string, 0 | 1 | 2 | 3> = { NONE: 0, LOW: 1, MODERATE: 2, HIGH: 3 };

export function toLedgerRow(k: Kline[], s: SeriesScore, ctx: RowContext): LedgerRow | null {
  const bar = k[k.length - 1];
  if (!bar) return null;
  const c = s.confluence;
  const cfg = engineConfigId(s.profile);
  return {
    id: `${cfg}|${ctx.src}|${ctx.tf}|${ctx.pair}|${bar.time}`,
    cfg,
    ev: ENGINE_VERSION,
    app: ctx.appVersion,
    src: ctx.src,
    tf: ctx.tf,
    pair: ctx.pair,
    ac: ctx.ac,
    t: bar.time,
    tc: ctx.closeTime,
    rec: ctx.recordedAt ?? Date.now(),
    c: bar.close,
    sc: c.score,
    m: c.master === "BULLISH" ? 1 : c.master === "BEARISH" ? -1 : 0,
    st: c.strength === "STRONG" ? 2 : c.strength === "MODERATE" ? 1 : 0,
    sup: c.suppressed ? 1 : 0,
    lv: c.lowVolatility ? 1 : 0,
    v: c.validCount,
    bu: c.bull,
    be: c.bear,
    er: c.er == null ? null : Math.round(c.er * 1000) / 1000,
    bl: BLOC_ORDER.map((name) => Math.round((c.blocs.find((b) => b.bloc === name)?.score ?? 0) * 100)),
    rk: ctx.rank,
    qv: Math.round(ctx.quoteVolume),
    rd: s.reversal.direction === "UP" ? 1 : s.reversal.direction === "DOWN" ? -1 : 0,
    rc: REV_CONF[s.reversal.confidence] ?? 0,
    wb: s.warmBars,
    live: ctx.live ? 1 : 0,
    uc: ctx.underlyingClosed ? 1 : 0,
    rks: ctx.rankSource ?? (ctx.rank > 0 ? "live" : "none"),
    ...(ctx.universeRank ? { rku: ctx.universeRank } : {}),
    ...(s.split ? { spl: 1 as const } : {}),
    ...(s.sessionFiltered && s.engineBars !== undefined ? { eb: s.engineBars } : {}),
  };
}
