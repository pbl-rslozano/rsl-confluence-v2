/**
 * rate-gate.ts — v2.8 Step 2 (plan WP26): the shared sliding-window request gate for the venue modules
 * (okx.ts, coinbase.ts). Moved out of okx.ts (Task 3) when Coinbase needed the same gate (Task 4).
 *
 * Pure timing; no network, no venue knowledge. Each venue module owns its gates (one per documented limit)
 * and its own injectable clock for tests.
 */

/** Time source for venue pacing (injectable for tests). `sleep` resolves early when `signal` aborts. */
export interface RateClock { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }

export const realClock: RateClock = {
  now: () => Date.now(),
  sleep: (ms, signal) => {
    if (!(ms > 0) || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(id); signal?.removeEventListener("abort", done); resolve(); };
      const id = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
    });
  },
};

/**
 * A token bucket whose tokens come back exactly `windowMs` after they are spent (a sliding-window log): at
 * most `limit` grants in ANY window of `windowMs`, with no burst above it (a classic bucket of `limit`
 * tokens refilled at `limit`/s could grant 2 × limit within one second). Waiters are served in order.
 * An aborted waiter rejects with AbortError and takes no grant.
 */
export function createRateGate(limit: number, windowMs: number, time: RateClock = realClock) {
  const spent: number[] = [];
  let queue: Promise<void> = Promise.resolve();
  return {
    take(signal?: AbortSignal): Promise<void> {
      const turn = queue.then(async () => {
        for (;;) {
          if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
          const now = time.now();
          while (spent.length && spent[0] <= now - windowMs) spent.shift();
          if (spent.length < limit) { spent.push(now); return; }
          await time.sleep(spent[0] + windowMs - now, signal);
        }
      });
      queue = turn.catch(() => undefined);
      return turn;
    },
  };
}
export type RateGate = ReturnType<typeof createRateGate>;
