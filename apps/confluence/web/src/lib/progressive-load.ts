"use client";
/**
 * progressive-load.ts — v2.8 (WP27 smooth loading)
 * ----------------------------------------------------------------------------
 * Browser-side helpers of the progressive scan, kept out of page.tsx:
 *  - loadStoredSeries: on-device history for the instant-start rows (memory
 *    cache first, then IndexedDB; a blocked store just means no instant rows).
 *  - prefetchOtherTimeframes: the top-10 tier's other timeframes, fetched
 *    after the scan into a bounded memory cache keyed `src:tf:symbol` (and the
 *    history store), so switching timeframe shows rows at once. Display only:
 *    nothing here is scored for the ledger, the paper simulator or alerts —
 *    that happens only when that timeframe is scanned.
 * Pacing and the 429/418 halt: the same per-venue cooldown as scans
 * (assertNotCoolingDown via fetchSeries), gentle concurrency, and the first
 * rate-limit response stops the prefetch.
 * ----------------------------------------------------------------------------
 */
import type { Kline } from "./indicators";
import { deltaPlan, loadHistoricalSeries, mergeDelta, mergeKlines, saveHistoricalSeries } from "./history-store";
import { contiguousTail, deltaSupported, fetchSeries, INTERVAL_MS, rateLimitCooldown, RateLimitError, type DataSource } from "./market-client";
import { newBarDue, runTiers } from "./progressive-scan";
import { ENGINE_BARS } from "./engine-window";

/** Memory cache of series by `src:tf:symbol` (display only; newest entries kept, newest bars only). */
export type SeriesCache = Map<string, Kline[]>;
const CACHE_LIMIT = 400;
/** Bars kept per cached series: the engine window plus a margin (the full history stays in IndexedDB). */
const CACHE_BARS = ENGINE_BARS + 100;

export const seriesKey = (source: string, tf: string, symbol: string) => `${source}:${tf}:${symbol}`;

export function cachePut(cache: SeriesCache, key: string, klines: Kline[]): void {
  cache.delete(key);
  cache.set(key, klines.length > CACHE_BARS ? klines.slice(-CACHE_BARS) : klines);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
}

/**
 * Stored history (IndexedDB) for the given symbols — the scan's merge and
 * delta base, exactly what the scan read before v2.8. Missing or unreadable → absent.
 */
export async function loadStoredSeries(source: DataSource, tf: string, symbols: string[]): Promise<Map<string, Kline[]>> {
  const out = new Map<string, Kline[]>();
  await Promise.all(symbols.map(async (symbol) => {
    try {
      const saved = await loadHistoricalSeries(source, tf, symbol);
      if (saved.length) out.set(symbol, saved);
    } catch {
      // A blocked/private browser store must not break scanning.
    }
  }));
  return out;
}

/** Bars to draw an instant ("updating") row from: the memory cache, else the stored history. */
export function displaySeries(cache: SeriesCache, source: string, tf: string, symbol: string, stored: Map<string, Kline[]>): Kline[] {
  const hit = cache.get(seriesKey(source, tf, symbol));
  const saved = stored.get(symbol);
  if (hit?.length && (!saved?.length || hit[hit.length - 1].time >= saved[saved.length - 1].time)) return hit;
  return saved ?? [];
}

export interface PrefetchOptions {
  source: DataSource;
  /** The top-10 tier of the scan just finished. */
  symbols: string[];
  /** Timeframes to cache (every timeframe except the one just scanned). */
  timeframes: string[];
  cache: SeriesCache;
  signal: AbortSignal;
}

/** Fetch the other timeframes of the priority rows. Resolves quietly; cancelled by `signal`. */
export async function prefetchOtherTimeframes({ source, symbols, timeframes, cache, signal }: PrefetchOptions): Promise<void> {
  if (!symbols.length || rateLimitCooldown(source) > 0) return;
  const jobs = timeframes.flatMap((tf) => symbols.map((symbol) => ({ tf, symbol, id: `${tf}|${symbol}` })));
  const byId = new Map(jobs.map((j) => [j.id, j]));
  try {
    await runTiers([jobs.map((j) => j.id)], async (id) => {
      const { tf, symbol } = byId.get(id)!;
      const intervalMs = INTERVAL_MS[tf];
      const key = seriesKey(source, tf, symbol);
      const cached = cache.get(key);
      if (cached?.length && !newBarDue(cached.at(-1)?.time, intervalMs, Date.now())) return;
      let base: Kline[] = [];
      try { base = await loadHistoricalSeries(source, tf, symbol); } catch { base = cached ?? []; }
      if (base.length && !newBarDue(base.at(-1)?.time, intervalMs, Date.now())) { cachePut(cache, key, contiguousTail(base, intervalMs)); return; }
      let discard = false;
      const plan = deltaSupported(source, tf) ? deltaPlan(base, intervalMs, Date.now()) : null;
      const fresh = await fetchSeries(source, tf, symbol, 1000, signal, plan, (f, ov) => {
        const m = mergeDelta(base, f, ov);
        if (!m) discard = true;
        return m;
      });
      if (signal.aborted) return;
      const merged = contiguousTail(discard ? fresh : mergeKlines(base, fresh), intervalMs);
      cachePut(cache, key, merged);
      void saveHistoricalSeries(source, tf, symbol, fresh, discard).catch(() => undefined);
    }, {
      concurrency: 2,
      pauseMs: source === "bitget" || source === "bitget-perp" ? 500 : 250,
      signal,
      isHalt: (e) => e instanceof RateLimitError,
      onResult: () => {},
      onError: () => {},
    });
  } catch {
    // Superseded by a new scan: queued prefetch work is dropped.
  }
}
