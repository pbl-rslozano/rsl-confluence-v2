/**
 * scan-record.ts — v2.3
 * ----------------------------------------------------------------------------
 * The ONE place a scan's ledger rows are assembled, shared by the app
 * (page.tsx) and the headless recorder (apps/confluence/recorder), so both
 * write the same row for the same closed bars: rank in the class view, rank
 * in the full unfiltered ranking, rank source, close time, closed-market
 * flag, and the logged context fields (enrichment.ts).
 * Pure: no I/O, no clock reads except the caller-supplied recordedAt.
 * ----------------------------------------------------------------------------
 */
import { baseOf } from "./quotes";
import type { Kline } from "./indicators";
import type { AssetClass, LedgerRow } from "./ledger-metrics";
import type { SeriesScore, RowContext } from "./scan-pipeline";
import { toLedgerRow } from "./scan-pipeline";
import { barWhileClosed } from "./asset-classes";
import { barCloseTime, type UniverseEntry } from "./market-client";
import { enrich, percentiles, ret20 } from "./enrichment";
import { derivativeFields, type DerivativeSnapshot } from "./derivatives-context";
import type { PatternConfidence, PatternDirection } from "./pattern-signal";

export interface ScanSeries {
  symbol: string;
  /** Rank in the scanned (class-filtered) view. */
  rank: number;
  quoteVolume: number;
  ac: AssetClass;
  /** Closed, contiguous bars (oldest first). */
  kl: Kline[];
  /** v2.8 (WP19): the Pattern output computed on these bars (absent = not computed → pd/pc null). */
  pattern?: { direction: PatternDirection; confidence: PatternConfidence } | null;
}

export interface ScanRecordContext {
  src: string;
  tf: string;
  intervalMs: number;
  appVersion: string;
  universe?: UniverseEntry[];
  basisBySymbol?: Record<string, number>;
  recordedAt?: number;
  /** v2.8 (WP19): Bybit linear derivative snapshots (recorder log, or imported in the app) → fr / oiChg. */
  derivatives?: ReadonlyArray<DerivativeSnapshot>;
}

/** Scan-wide inputs: relative-strength percentiles, BTC bars, full-ranking positions. */
export interface ScanShared {
  rs: Map<string, number>;
  btc?: Kline[];
  universeRank: Map<string, number>;
}

export function scanShared(series: ScanSeries[], universe?: UniverseEntry[]): ScanShared {
  return {
    rs: percentiles(new Map(series.map((p) => [p.symbol, ret20(p.kl) ?? NaN]))),
    // v2.7 (review #8): the BTC pair of THIS scan (BTCUSDT, BTCUSDC, BTCPHP on Coins.ph …).
    btc: (series.find((p) => p.symbol === "BTCUSDT") ?? series.find((p) => baseOf(p.symbol) === "BTC"))?.kl,
    universeRank: new Map((universe ?? []).map((u, i) => [u.p, i + 1])),
  };
}

/** The live row for the newest closed bar of one series (null when unusable). */
export function liveRow(p: ScanSeries, score: SeriesScore, ctx: ScanRecordContext, shared: ScanShared): LedgerRow | null {
  if (!score.usable || !p.kl.length) return null;
  const last = p.kl[p.kl.length - 1];
  const closeTime = barCloseTime(last.time, ctx.intervalMs);
  const deriv = ctx.derivatives?.length ? derivativeFields(ctx.derivatives, p.symbol, closeTime) : null;
  const row = toLedgerRow(p.kl, score, {
    src: ctx.src,
    tf: ctx.tf,
    pair: p.symbol,
    ac: p.ac,
    intervalMs: ctx.intervalMs,
    closeTime,
    rank: p.rank,
    quoteVolume: p.quoteVolume,
    appVersion: ctx.appVersion,
    live: true,
    ...(ctx.recordedAt !== undefined ? { recordedAt: ctx.recordedAt } : {}),
    underlyingClosed: barWhileClosed(p.ac, last.time, ctx.intervalMs),
    universeRank: shared.universeRank.get(p.symbol),
    rankSource: "live",
    ...(p.pattern ? { pattern: p.pattern } : {}),
    ...(deriv ? deriv : {}),
  });
  if (!row) return null;
  return Object.assign(row, enrich(row, p.kl, {
    intervalMs: ctx.intervalMs,
    btc: shared.btc,
    basis: ctx.basisBySymbol?.[p.symbol],
    rs: shared.rs.get(p.symbol) ?? null,
    split: !!score.split,
  }));
}

/** Row context for catch-up jobs (rank at catch-up time, labelled "now"). */
export function catchUpContext(p: ScanSeries, ctx: ScanRecordContext, shared: ScanShared): Omit<RowContext, "closeTime" | "underlyingClosed"> {
  return {
    src: ctx.src, tf: ctx.tf, pair: p.symbol, ac: p.ac, intervalMs: ctx.intervalMs,
    rank: p.rank, quoteVolume: p.quoteVolume, appVersion: ctx.appVersion, live: true,
    ...(ctx.recordedAt !== undefined ? { recordedAt: ctx.recordedAt } : {}),
    universeRank: shared.universeRank.get(p.symbol), rankSource: "now",
  };
}

/** Enrich catch-up rows on the bars up to each row (no look-ahead); rs is not cross-sectional for past bars. */
export function enrichCatchUp(rows: LedgerRow[], kl: Kline[], ctx: ScanRecordContext, shared: ScanShared): LedgerRow[] {
  const index = new Map(kl.map((b, i) => [b.time, i]));
  for (const row of rows) {
    const i = index.get(row.t);
    if (i !== undefined) Object.assign(row, enrich(row, kl.slice(0, i + 1), { intervalMs: ctx.intervalMs, btc: shared.btc, rs: null }));
    // v2.8 (WP19): derivative context as of each catch-up bar's own close (never a later snapshot).
    if (ctx.derivatives?.length) Object.assign(row, derivativeFields(ctx.derivatives, row.pair, row.tc));
  }
  return rows;
}
