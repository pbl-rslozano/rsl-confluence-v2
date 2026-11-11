"use client";

import type { Kline } from "./indicators";
import type { DataSource } from "./market-client";

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
): Promise<Kline[]> {
  const db = await openDb();
  if (!db) return incoming;
  const existing = await new Promise<Kline[]>((resolve, reject) => {
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

