/**
 * progressive-scan.ts — v2.8 (WP27 smooth loading)
 * ----------------------------------------------------------------------------
 * Pure scheduling pieces of the progressive scan. No imports, no network, no
 * storage of its own (the ticker memory takes the storage as an argument), so
 * the suite runs under plain Node (`progressive-scan.test.mjs`).
 *
 *  - priorityOrder: watchlist (or the top 10 by volume) first, then chunks of 20.
 *  - runTiers: fetches tier by tier, `concurrency` at a time, pauses between
 *    batches, stops everything at the first rate-limit error (the global
 *    429/418 halt) and drops every result once the scan is superseded.
 *  - createBatcher: UI updates at most every 250 ms.
 *  - Freshness: "live" (fresh fetch this scan), "updating" (on-device history,
 *    waiting for its fetch) and "stale" (fetch failed: "not updated"). Only
 *    live rows are ever recorded, proposed to the paper simulator or alerted
 *    (v2.2 rule: cached history is never presented or recorded as a live signal).
 * ----------------------------------------------------------------------------
 */

export type Freshness = "live" | "updating" | "stale";

/** First tier without a watch list: the top 10 by volume (scored on every timeframe). */
export const PRIORITY_TOP = 10;
/** Later tiers: the next 20, the next 20 … up to the chosen list size. */
export const PRIORITY_CHUNK = 20;
/** UI updates while a scan runs: at most one every 250 ms. */
export const UI_BATCH_MS = 250;

/**
 * Tiers in fetch order. `symbols` is the chosen list, `watch` the user's
 * watchlist/selection (null or empty → the top 10 by volume), `byVolume` the
 * venue ranking. Every symbol of `symbols` appears exactly once.
 */
export function priorityOrder(symbols: string[], watch: string[] | null, byVolume: string[]): string[][] {
  const inList = new Set(symbols);
  const ranked: string[] = [];
  const seen = new Set<string>();
  for (const s of [...byVolume, ...symbols]) {
    if (inList.has(s) && !seen.has(s)) { seen.add(s); ranked.push(s); }
  }
  const watched = (watch ?? []).filter((s, i, a) => inList.has(s) && a.indexOf(s) === i);
  const first = watched.length ? watched : ranked.slice(0, PRIORITY_TOP);
  const firstSet = new Set(first);
  const rest = ranked.filter((s) => !firstSet.has(s));
  const tiers: string[][] = first.length ? [first] : [];
  for (let i = 0; i < rest.length; i += PRIORITY_CHUNK) tiers.push(rest.slice(i, i + PRIORITY_CHUNK));
  return tiers;
}

export interface TierRunOptions<T> {
  /** Requests in flight at once (6; Coins.ph 1). */
  concurrency: number;
  /** Pause between batches (ms); never after the last batch. */
  pauseMs?: number;
  signal?: AbortSignal;
  onResult: (symbol: string, value: T) => void;
  onError: (symbol: string, error: unknown) => void;
  /** After each batch: symbols settled so far, and the total. */
  onBatch?: (done: number, total: number) => void;
  /** A rate-limit error stops every remaining tier (default: error.name === "RateLimitError"). */
  isHalt?: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export interface TierRun {
  /** True when a rate-limit error stopped the scan. */
  halted: boolean;
  /** Symbols never requested because of the halt, in fetch order. */
  skipped: string[];
}

const isRateLimit = (e: unknown) => e instanceof Error && e.name === "RateLimitError";
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const superseded = () => new DOMException("Scan superseded", "AbortError");

/**
 * Fetch every tier in order. Results of a batch are emitted only while the
 * scan is current: after an abort nothing more is emitted and the promise
 * rejects with an AbortError (a new source or timeframe cancels queued work).
 */
export async function runTiers<T>(tiers: string[][], fetchOne: (symbol: string) => Promise<T>, opts: TierRunOptions<T>): Promise<TierRun> {
  const concurrency = Math.max(1, Math.floor(opts.concurrency));
  const isHalt = opts.isHalt ?? isRateLimit;
  const sleep = opts.sleep ?? defaultSleep;
  const order = tiers.flat();
  const total = order.length;
  let done = 0;
  const batches: string[][] = [];
  for (const tier of tiers) for (let i = 0; i < tier.length; i += concurrency) batches.push(tier.slice(i, i + concurrency));
  for (let b = 0; b < batches.length; b++) {
    if (opts.signal?.aborted) throw superseded();
    const batch = batches[b];
    const settled = await Promise.allSettled(batch.map((s) => fetchOne(s)));
    let halted = false;
    for (let j = 0; j < batch.length; j++) {
      if (opts.signal?.aborted) throw superseded();
      const r = settled[j];
      if (r.status === "fulfilled") opts.onResult(batch[j], r.value);
      else {
        opts.onError(batch[j], r.reason);
        if (isHalt(r.reason)) halted = true;
      }
    }
    if (opts.signal?.aborted) throw superseded();
    done += batch.length;
    opts.onBatch?.(done, total);
    if (halted) return { halted: true, skipped: order.slice(done) };
    if (b + 1 < batches.length && opts.pauseMs && opts.pauseMs > 0) await sleep(opts.pauseMs);
  }
  return { halted: false, skipped: [] };
}

export interface Timers {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
}
const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** Coalesces UI updates: `schedule()` flushes at most once per `intervalMs`. */
export function createBatcher(flush: () => void, intervalMs = UI_BATCH_MS, timers: Timers = realTimers) {
  let timer: unknown = null;
  let last = -Infinity;
  let cancelled = false;
  const run = () => { timer = null; if (cancelled) return; last = timers.now(); flush(); };
  return {
    schedule() {
      if (cancelled || timer !== null) return;
      timer = timers.setTimeout(run, Math.max(0, last + intervalMs - timers.now()));
    },
    flushNow() {
      if (cancelled) return;
      if (timer !== null) { timers.clearTimeout(timer); timer = null; }
      last = timers.now();
      flush();
    },
    cancel() {
      cancelled = true;
      if (timer !== null) { timers.clearTimeout(timer); timer = null; }
    },
  };
}

/** Rows refreshed by a fresh fetch in this scan — the only ones that reach the ledger, paper proposals and alerts. */
export function liveOnly<T extends { freshness?: Freshness }>(rows: readonly T[]): T[] {
  return rows.filter((r) => r.freshness === "live");
}

/** Ledger rows of a scan: `toRow` is called for live rows only. */
export function recordable<T extends { freshness?: Freshness }, L>(rows: readonly T[], toRow: (row: T) => L | null | undefined): L[] {
  const out: L[] = [];
  for (const r of liveOnly(rows)) { const x = toRow(r); if (x) out.push(x); }
  return out;
}

/** Rows a scan starts from: the shown rows on a rescan of the same view, none otherwise (never mix sources/timeframes). */
export function initialRows<R>(shown: { key: string | null; rows: readonly R[] }, key: string): R[] {
  return shown.key === key ? [...shown.rows] : [];
}

/** Row set of one progressive scan, keyed by pair. A history ("updating") row never replaces a fresher one. */
export class ProgressiveRows<R extends { pair: string; freshness?: Freshness }> {
  readonly key: string;
  private readonly byPair = new Map<string, R>();
  constructor(key: string, initial: readonly R[] = []) {
    this.key = key;
    for (const r of initial) this.byPair.set(r.pair, r);
  }
  put(row: R): boolean {
    const cur = this.byPair.get(row.pair);
    if (row.freshness === "updating" && cur && cur.freshness !== "updating") return false;
    this.byPair.set(row.pair, row);
    return true;
  }
  get(pair: string): R | undefined { return this.byPair.get(pair); }
  rows(): R[] { return [...this.byPair.values()]; }
}

/* ---- Ticker list remembered per view, so the first rows can be drawn before any request. ---- */
export interface RememberedTicker { rank: number; symbol: string; lastPrice: string; priceChangePercent: string; quoteVolume: string }
interface KeyValueStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
const LIST_PREFIX = "ct-scan-list-v1:";
const SAFE = /^[A-Z0-9]{2,30}$/;
const MAX_REMEMBERED = 200;
const storageOrNull = (): KeyValueStorage | null => {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
};

export function rememberTickers(key: string, tickers: readonly RememberedTicker[], storage: KeyValueStorage | null = storageOrNull()): void {
  if (!storage) return;
  try {
    const slim = tickers.slice(0, MAX_REMEMBERED).map((t) => ({ rank: t.rank, symbol: t.symbol, lastPrice: t.lastPrice, priceChangePercent: t.priceChangePercent, quoteVolume: t.quoteVolume }));
    storage.setItem(LIST_PREFIX + key, JSON.stringify(slim));
  } catch {
    // Storage full or blocked: the next scan simply starts without instant rows.
  }
}

export function rememberedTickers(key: string, storage: KeyValueStorage | null = storageOrNull()): RememberedTicker[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(LIST_PREFIX + key);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(list)) return [];
    return list.filter((t): t is RememberedTicker => !!t && typeof t === "object" && SAFE.test(String((t as RememberedTicker).symbol))
      && typeof (t as RememberedTicker).rank === "number").slice(0, MAX_REMEMBERED).map((t) => ({
      rank: t.rank, symbol: t.symbol, lastPrice: String(t.lastPrice), priceChangePercent: String(t.priceChangePercent), quoteVolume: String(t.quoteVolume),
    }));
  } catch {
    return [];
  }
}

/**
 * Other-timeframe cache: refetch only once a bar newer than the cached one has
 * closed (`newestOpen` = open time of the newest cached bar; calendar months
 * are treated as 30 days here, so a monthly entry may refetch a day or two off).
 */
export function newBarDue(newestOpen: number | undefined, intervalMs: number, now: number): boolean {
  if (newestOpen === undefined || !Number.isFinite(newestOpen)) return true;
  return now >= newestOpen + 2 * intervalMs;
}
