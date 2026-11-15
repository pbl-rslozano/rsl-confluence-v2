"use client";

import type { Kline } from "./indicators";
import { barCloseTime, contiguousTail, INTERVAL_MS, type DataSource } from "./market-client";
import { ENGINE_BARS } from "./engine-window";

const DB_NAME = "confluence-terminal-history";

/**
 * Build 2.02: per-series cap. 2.01 kept every bar forever and re-read/re-wrote
 * the whole array on every refresh, so cost grew without bound (+1,440 bars per
 * asset per day on 1m). 10,000 bars = live window plus two 5K backfills; the
 * newest bars are kept when the cap is reached.
 */
export const MAX_STORED_BARS = 10_000;
const DB_VERSION = 1;
const STORE = "series";

interface StoredSeries {
  key: string;
  source: DataSource;
  interval: string;
  symbol: string;
  updatedAt: number;
  klines: Kline[];
}

function keyOf(source: DataSource, interval: string, symbol: string): string {
  return `${source}:${interval}:${symbol.toUpperCase()}`;
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function mergeKlines(...groups: (Kline[] | undefined)[]): Kline[] {
  const byTime = new Map<number, Kline>();
  groups.flat().forEach((bar) => {
    if (bar && Number.isFinite(bar.time)) byTime.set(bar.time, bar);
  });
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export async function loadHistoricalSeries(
  source: DataSource,
  interval: string,
  symbol: string,
): Promise<Kline[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get(keyOf(source, interval, symbol));
    request.onsuccess = () => resolve((request.result as StoredSeries | undefined)?.klines ?? []);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function saveHistoricalSeries(
  source: DataSource,
  interval: string,
  symbol: string,
  incoming: Kline[],
  /** v2.8 (WP27): true discards the stored series first (the exchange revised the delta overlap bar). */
  replace = false,
): Promise<Kline[]> {
  const db = await openDb();
  if (!db) return incoming;
  const existing = replace ? [] : await new Promise<Kline[]>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get(keyOf(source, interval, symbol));
    request.onsuccess = () => resolve((request.result as StoredSeries | undefined)?.klines ?? []);
    request.onerror = () => reject(request.error);
  });
  const klines = mergeKlines(existing, incoming).slice(-MAX_STORED_BARS);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({
      key: keyOf(source, interval, symbol),
      source,
      interval,
      symbol,
      updatedAt: Date.now(),
      klines,
    } satisfies StoredSeries);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return klines;
}


/* ---------------------------------------------------------------------------
 * v2.8 (WP27) delta fetch. Extends the v2.1.1 warm start: when the stored
 * history already holds the engine window, ask only for the bars that closed
 * after the newest stored bar, plus that bar again (the overlap) to verify
 * continuity. Engine inputs are unchanged: the merged series has the same
 * newest ENGINE_BARS bars as a full fetch.
 * ------------------------------------------------------------------------- */
export interface DeltaPlan {
  /** Closed bars wanted: the missing bars + the overlap bar. The request adds one for the bar still building. */
  limit: number;
  /** Open time of the newest stored bar, fetched again and compared. */
  overlapOpenTime: number;
}
/** Largest delta `limit` (the request asks limit + 1 and venues serve at most 1,000 bars). */
export const MAX_DELTA_LIMIT = 999;

const nextOpen = (openTime: number, intervalMs: number) =>
  intervalMs === INTERVAL_MS["1M"] ? barCloseTime(openTime, intervalMs) : openTime + intervalMs;

/**
 * Null (fetch the full window) when the stored series is not contiguous over
 * its newest ENGINE_BARS bars, is shorter than that, holds a bar that has not
 * closed, or is too far behind for one request.
 */
export function deltaPlan(stored: Kline[], intervalMs: number, now: number): DeltaPlan | null {
  if (!(intervalMs > 0) || stored.length < ENGINE_BARS) return null;
  if (contiguousTail(stored, intervalMs).length < ENGINE_BARS) return null;
  const last = stored[stored.length - 1].time;
  if (!Number.isFinite(last) || barCloseTime(last, intervalMs) > now) return null;
  let missing = 0;
  for (let t = nextOpen(last, intervalMs); barCloseTime(t, intervalMs) <= now; t = nextOpen(t, intervalMs)) {
    missing++;
    if (missing + 1 > MAX_DELTA_LIMIT) return null;
  }
  return { limit: missing + 1, overlapOpenTime: last };
}

const sameBar = (a: Kline, b: Kline) =>
  a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume;

/**
 * Stored bars up to the overlap + fresh bars after it. Null when the overlap
 * bar is missing from either side or its OHLCV differs (the exchange revised
 * it): the caller then fetches the full window and discards the stored series.
 */
export function mergeDelta(stored: Kline[], fresh: Kline[], overlapOpenTime: number): Kline[] | null {
  const s = stored.findLast((b) => b.time === overlapOpenTime);
  const f = fresh.find((b) => b.time === overlapOpenTime);
  if (!s || !f || !sameBar(s, f)) return null;
  return mergeKlines(stored.filter((b) => b.time <= overlapOpenTime), fresh.filter((b) => b.time > overlapOpenTime));
}
