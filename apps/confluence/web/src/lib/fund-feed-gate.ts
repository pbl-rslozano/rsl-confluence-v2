/**
 * fund-feed-gate.ts — v2.8 (WP21). Pure helpers around the post-scan Fund trend feed.
 *
 * Live ledger rows are append-only, so a row written before the daily-bar feed has run would carry ft null
 * for good. `writeLiveRows` therefore holds a scan's crypto rows until that scan's feed settles (or 90 s,
 * or an abort) and then writes with the values available; non-crypto rows write at once and never wait.
 * `createSerialQueue` keeps the post-scan feed and the catch-up daily loading from running together
 * (concurrency stays 2 in total).
 */
import { roundFt } from "./ledger-metrics";

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
  /** The Fund trend known now for a pair (null when loading, unavailable or not yet fetched). */
  fundTrendOf: (symbol: string) => number | null;
  timeoutMs?: number;
  timers?: GateTimers;
}

/** Non-crypto rows write at once; crypto rows wait for the feed (≤ 90 s, or an abort), take ft from it, then write. Never drops a row. */
export async function writeLiveRows<R extends { ac: string; pair: string; ft?: number | null }>(rows: R[], o: LiveWriteOptions<R>): Promise<number> {
  const crypto = rows.filter((r) => r.ac === "crypto");
  const others = rows.filter((r) => r.ac !== "crypto");
  const writes: Promise<number>[] = [];
  if (others.length) writes.push(o.write(others));
  if (crypto.length) {
    writes.push((async () => {
      await waitForFeed(o.settled, { signal: o.signal, timeoutMs: o.timeoutMs, timers: o.timers });
      for (const r of crypto) { const v = o.fundTrendOf(r.pair); r.ft = typeof v === "number" && Number.isFinite(v) ? roundFt(v) : null; }
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
