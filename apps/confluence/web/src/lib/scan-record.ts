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
import type { Kline } from "./indicators";
import type { AssetClass, LedgerRow } from "./ledger-metrics";
import type { SeriesScore, RowContext } from "./scan-pipeline";
import { toLedgerRow } from "./scan-pipeline";
import { barWhileClosed } from "./asset-classes";
import { barCloseTime, type UniverseEntry } from "./market-client";
import { enrich, percentiles, ret20 } from "./enrichment";

export interface ScanSeries {
  symbol: string;
  /** Rank in the scanned (class-filtered) view. */
  rank: number;
  quoteVolume: number;
  ac: AssetClass;
  /** Closed, contiguous bars (oldest first). */
  kl: Kline[];
}

export interface ScanRecordContext {
  src: string;
  tf: string;
  intervalMs: number;
  appVersion: string;
  universe?: UniverseEntry[];
  basisBySymbol?: Record<string, number>;
  recordedAt?: number;
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
    btc: series.find((p) => p.symbol === "BTCUSDT")?.kl,
    universeRank: new Map((universe ?? []).map((u, i) => [u.p, i + 1])),
  };
}

/** The live row for the newest closed bar of one series (null when unusable). */
export function liveRow(p: ScanSeries, score: SeriesScore, ctx: ScanRecordContext, shared: ScanShared): LedgerRow | null {
  if (!score.usable || !p.kl.length) return null;
  const last = p.kl[p.kl.length - 1];
  const row = toLedgerRow(p.kl, score, {
    src: ctx.src,
    tf: ctx.tf,
    pair: p.symbol,
    ac: p.ac,
    intervalMs: ctx.intervalMs,
    closeTime: barCloseTime(last.time, ctx.intervalMs),
    rank: p.rank,
    quoteVolume: p.quoteVolume,
    appVersion: ctx.appVersion,
    live: true,
    ...(ctx.recordedAt !== undefined ? { recordedAt: ctx.recordedAt } : {}),
    underlyingClosed: barWhileClosed(p.ac, last.time, ctx.intervalMs),
    universeRank: shared.universeRank.get(p.symbol),
    rankSource: "live",
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
  }
  return rows;
}
