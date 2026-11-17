/**
 * fund-feed-gate.ts — v2.8 (WP21). Pure helpers around the post-scan Fund trend feed.
 *
 * Live ledger rows are append-only, so a row written before the daily-bar feed has run would carry ft null
 * for good. `writeLiveRows` therefore holds a scan's crypto rows until that scan's feed settles (or 90 s,
 * or an abort) and then writes with the values available; non-crypto rows write at once and never wait.
 * `createSerialQueue` keeps the post-scan feed and the catch-up daily loading from running together
 * (concurrency stays 2 in total).
 */
import type { LedgerRow } from "./ledger-metrics";
import type { Kline } from "./indicators";
import { applyFundTrend, applyScenariosAsync, snapshotDaily } from "./scan-record";
import { yieldToMain } from "./yield-main";

export const FEED_WAIT_MS = 90_000;

export interface GateTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
}
const realTimers: GateTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export type FeedWait = "settled" | "timeout" | "aborted";

/** Resolves with the first of: the feed settled (resolved or rejected), `timeoutMs`, the signal aborted. Never rejects. */
export function waitForFeed(
  settled: Promise<unknown>,
  opts: { signal?: AbortSignal; timeoutMs?: number; timers?: GateTimers } = {},
): Promise<FeedWait> {
  const timers = opts.timers ?? realTimers;
  if (opts.signal?.aborted) return Promise.resolve("aborted");
  return new Promise<FeedWait>((resolve) => {
    let done = false;
    let timer: unknown = null;
    const onAbort = () => finish("aborted");
    const finish = (r: FeedWait) => {
      if (done) return;
      done = true;
      if (timer !== null) timers.clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    timer = timers.setTimeout(() => finish("timeout"), opts.timeoutMs ?? FEED_WAIT_MS);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    settled.then(() => finish("settled"), () => finish("settled"));
  });
}

export interface LiveWriteOptions<R> {
  write: (rows: R[]) => Promise<number>;
  /** Settles when this scan's post-scan feed has finished (or was never started). */
  settled: Promise<unknown>;
  signal?: AbortSignal;
  /**
   * Closed daily bars per pair (the feed's cache). Each crypto row takes ft with the catch-up rule (applyFundTrend): daily bars closed
   * at or before ITS OWN bar close, and a cache whose newest close is more than 36 h older than the row gives null. Absent (no daily
   * data source, e.g. the hosted build) -> ft null.
   */
  dailyOf?: (symbol: string) => Kline[];
  /** v2.8 (WP22): the closed bars of a pair (the scan's own). With `intervalMs`, each row gets scb/scp from the 1,000 bars ending at its bar. */
  barsOf?: (pair: string) => Kline[] | undefined;
  intervalMs?: number;
  timeoutMs?: number;
  timers?: GateTimers;
  /** v2.8 (final review C1): the yield between chunks of scenario work (default yieldToMain; tests may pass their own). */
  pause?: () => Promise<void>;
}

/**
 * Non-crypto rows write at once (after their scenario fields); crypto rows wait for the feed (≤ 90 s, or an abort), take ft from it,
 * then write. Never drops a row. v2.8 (final review C1): the scenario fields run in chunks with a yield between them
 * (applyScenariosAsync), so a scan of 200 pairs is not one long main-thread block; the non-crypto write is still issued before the
 * crypto write, and an abort still writes (the scenario work for rows already scored is finished, not dropped).
 */
export async function writeLiveRows<R extends { ac: string; pair: string; t: number; tc: number; ft?: number | null }>(rows: R[], o: LiveWriteOptions<R>): Promise<number> {
  const crypto = rows.filter((r) => r.ac === "crypto");
  const others = rows.filter((r) => r.ac !== "crypto");
  const writes: Promise<number>[] = [];
  const scenarios = o.barsOf !== undefined && o.intervalMs !== undefined;
  const pause = o.pause ?? yieldToMain;
  // Settles once the non-crypto write has been issued (at once when there is none), so the crypto write never overtakes it.
  let othersIssued: Promise<void> = Promise.resolve();
  if (others.length) {
    let issued!: () => void;
    othersIssued = new Promise<void>((r) => { issued = r; });
    writes.push((async () => {
      try {
        if (scenarios) await applyScenariosAsync(others as unknown as LedgerRow[], o.barsOf!, undefined, o.intervalMs!, pause);
      } catch { /* per-row failures are already nulls; never block the write */ }
      try { return o.write(others); } finally { issued(); }
    })());
  }
  if (crypto.length) {
    writes.push((async () => {
      await waitForFeed(o.settled, { signal: o.signal, timeoutMs: o.timeoutMs, timers: o.timers });
      // One read of each pair's daily bars: ft and the scenario states use the same snapshot across the yields below.
      const dailyOf = o.dailyOf ? snapshotDaily(o.dailyOf) : undefined;
      if (dailyOf) applyFundTrend(crypto as unknown as LedgerRow[], dailyOf);
      else for (const r of crypto) r.ft = null;
      // After ft: the signal bar's state is the row's own ft; earlier bars use the same daily bars.
      try {
        if (scenarios) await applyScenariosAsync(crypto as unknown as LedgerRow[], o.barsOf!, dailyOf, o.intervalMs!, pause);
      } catch { /* as above */ }
      await othersIssued;
      return o.write(crypto);
    })());
  }
  return (await Promise.all(writes)).reduce((a, b) => a + b, 0);
}

/** Runs tasks one after another; a failed task does not block the next; a task whose signal aborted while queued never starts. */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    enqueue<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      const run = tail.then(() => {
        if (signal?.aborted) throw new DOMException("Fund trend feed superseded", "AbortError");
        return task();
      });
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}
