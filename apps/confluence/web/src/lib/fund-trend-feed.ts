/**
 * fund-trend-feed.ts — daily-bar feed behind the scan (v2.8, WP21 Fund trend).
 *
 * Crypto rows only. One daily request per pair per UTC day at limit 1,000 (a delta request when the
 * stored series already holds the engine window), from the row's own source and hosts, queued behind
 * the scan with concurrency 2 on the existing runTiers and the venue gates. The first RateLimitError
 * halts the feed: the rows left are `{ na: "loading" }` and nothing more is requested.
 *
 * Storage: the on-device series store (history-store, key `source:1d:symbol`) plus a stored
 * "fetched for UTC day" marker next to it; in Node (the recorder) history-store has no backend, so
 * the module-level in-memory cache and marker are what apply. `now` is injected everywhere.
 * Paper trading only; no new hosts; Fund trend is a benchmark, never a vote.
 */
import type { Kline } from "./indicators";
import type { AssetClass } from "./ledger-metrics";
import {
  barCloseTime, contiguousTail, dropUnclosed, fetchSeries, noteVenueRateLimit, RateLimitError, venueOf, type DataSource,
} from "./market-client";
import { loadFetchedDay, loadHistoricalSeries, mergeDelta, saveFetchedDay, saveHistoricalSeries } from "./history-store";
import { FT_MIN_BARS, fundTrend, isFundTrendClass, type FundTrendState } from "./fund-trend";
import { runTiers } from "./progressive-scan";

export const DAY_MS = 86_400_000;
const FEED_CONCURRENCY = 2;
const DAILY_BARS = 1000;
const MAX_DAILY_DELTA = 999;

export interface DailyDeps {
  fetchSeries: typeof fetchSeries;
  load: (source: DataSource, symbol: string) => Promise<Kline[]>;
  save: (source: DataSource, symbol: string, bars: Kline[], replace: boolean) => Promise<unknown>;
  loadDay: (source: DataSource, symbol: string) => Promise<number | null>;
  saveDay: (source: DataSource, symbol: string, day: number) => Promise<void>;
}

const realDeps: DailyDeps = {
  fetchSeries,
  load: (s, sym) => loadHistoricalSeries(s, "1d", sym),
  save: (s, sym, bars, replace) => saveHistoricalSeries(s, "1d", sym, bars, replace),
  loadDay: (s, sym) => loadFetchedDay(s, "1d", sym),
  saveDay: (s, sym, day) => saveFetchedDay(s, "1d", sym, day),
};

/**
 * Delta plan for the daily series. Same rule as history-store's deltaPlan, but the stored run only has
 * to hold FT_MIN_BARS (366) contiguous bars, not the 1,000-bar engine window: the daily request is
 * limit 1,000 minus the still-building bar, so a stored series is usually 999 bars.
 */
function dailyPlan(stored: Kline[], now: number): { limit: number; overlapOpenTime: number } | null {
  if (contiguousTail(stored, DAY_MS).length < FT_MIN_BARS) return null;
  const last = stored[stored.length - 1].time;
  if (!Number.isFinite(last) || barCloseTime(last, DAY_MS) > now) return null;
  let missing = 0;
  for (let t = last + DAY_MS; barCloseTime(t, DAY_MS) <= now; t += DAY_MS) {
    missing++;
    if (missing + 1 > MAX_DAILY_DELTA) return null;
  }
  return { limit: missing + 1, overlapOpenTime: last };
}

const utcDay = (now: number) => Math.floor(now / DAY_MS) * DAY_MS;
const keyOf = (source: DataSource, symbol: string) => `${source}:${symbol.toUpperCase()}`;

/** In-memory cache and marker (the only ones in Node), plus de-duplication of concurrent callers. */
const memory = new Map<string, { day: number; bars: Kline[] }>();
const inflight = new Map<string, Promise<Kline[]>>();

export function resetFundTrendFeedForTests(): void {
  memory.clear();
  inflight.clear();
}

/** Closed daily bars already held in memory for a pair (any UTC day), newest last; [] when none. */
export function cachedDailyBars(source: DataSource, symbol: string): Kline[] {
  return memory.get(keyOf(source, symbol))?.bars ?? [];
}

const abortError = () => new DOMException("Fund trend feed superseded", "AbortError");

/**
 * Closed daily bars of one pair, newest last. At most one request per pair per UTC day: a stored
 * and an in-memory "fetched for UTC day" marker; the next UTC day asks only for the new bars (delta).
 */
export async function loadDailyBars(
  source: DataSource,
  symbol: string,
  now: number,
  signal?: AbortSignal,
  deps: DailyDeps = realDeps,
): Promise<Kline[]> {
  if (signal?.aborted) throw abortError();
  const key = keyOf(source, symbol);
  const day = utcDay(now);
  const mem = memory.get(key);
  if (mem && mem.day === day) return dropUnclosed(mem.bars, DAY_MS, now);
  const running = inflight.get(key);
  if (running) return running;

  const job = (async () => {
    let stored: Kline[] = [];
    try { stored = await deps.load(source, symbol); } catch { /* blocked store: fetch fresh */ }
    let markedDay: number | null = null;
    try { markedDay = await deps.loadDay(source, symbol); } catch { /* no stored marker */ }
    if (markedDay === day && stored.length) {
      const bars = dropUnclosed(stored, DAY_MS, now);
      memory.set(key, { day, bars });
      return bars;
    }
    if (signal?.aborted) throw abortError();
    const plan = dailyPlan(stored, now);
    let revised = false;
    const merge = (fresh: Kline[], overlap: number) => {
      const m = mergeDelta(stored, dropUnclosed(fresh, DAY_MS, now), overlap);
      if (!m) revised = true; // overlap bar missing or revised: fetchSeries falls back to the full window
      return m;
    };
    let fetched: Kline[];
    try {
      fetched = await deps.fetchSeries(source, "1d", symbol, DAILY_BARS, signal, plan, merge);
    } catch (e) {
      // fetchJson already notes the cooldown; this keeps it set for any venue module that did not.
      if (e instanceof RateLimitError && source !== "coinsph") noteVenueRateLimit(venueOf(source), e);
      throw e;
    }
    const bars = dropUnclosed(fetched, DAY_MS, now);
    try { await deps.save(source, symbol, bars, revised); } catch { /* blocked store */ }
    try { await deps.saveDay(source, symbol, day); } catch { /* in-memory marker still applies */ }
    memory.set(key, { day, bars });
    return bars;
  })();
  inflight.set(key, job);
  try { return await job; } finally { inflight.delete(key); }
}

export interface FundTrendFeedOptions {
  signal?: AbortSignal;
  onValue?: (symbol: string, s: FundTrendState) => void;
  deps?: DailyDeps;
}

/**
 * Fund trend per row. Non-crypto rows get `{ na: "class" }` at once, without a request. Crypto rows
 * run through runTiers (concurrency 2); the first RateLimitError halts the feed and the rows left,
 * including the rest of the batch that hit it, are `{ na: "loading" }`. An abort rejects with an
 * AbortError and emits nothing more.
 */
export async function loadFundTrends(
  source: DataSource,
  rows: { symbol: string; ac: AssetClass }[],
  now: number,
  opts: FundTrendFeedOptions = {},
): Promise<Map<string, FundTrendState>> {
  const out = new Map<string, FundTrendState>();
  const emit = (symbol: string, s: FundTrendState) => { out.set(symbol, s); opts.onValue?.(symbol, s); };
  const queue: string[] = [];
  for (const r of rows) {
    if (out.has(r.symbol) || queue.includes(r.symbol)) continue;
    if (isFundTrendClass(r.ac)) queue.push(r.symbol);
    else emit(r.symbol, { na: "class" });
  }
  if (!queue.length) return out;
  if (opts.signal?.aborted) throw abortError();

  let halted = false;
  const run = await runTiers<Kline[]>([queue], (symbol) => loadDailyBars(source, symbol, now, opts.signal, opts.deps), {
    concurrency: FEED_CONCURRENCY,
    signal: opts.signal,
    onResult: (symbol, bars) => {
      if (halted) return; // after a 429 in the same batch: the bars are cached, the value waits for the next run
      emit(symbol, fundTrend(bars, now) ?? { na: "history" });
    },
    onError: (symbol, error) => {
      if (error instanceof Error && error.name === "AbortError") return;
      if (error instanceof Error && error.name === "RateLimitError") { halted = true; return; }
      emit(symbol, { na: "error" });
    },
  });
  if (run.halted || halted) for (const symbol of queue) if (!out.has(symbol)) emit(symbol, { na: "loading" });
  return out;
}
