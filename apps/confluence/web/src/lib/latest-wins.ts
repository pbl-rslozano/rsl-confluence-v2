/**
 * latest-wins.ts — one request at a time, newest waiting request wins (v2.8, WP21). Pure module.
 *
 * Used for the panel's scoring requests, which share the scan worker: while one runs, a newer request replaces any
 * request already waiting (that one resolves null), so a burst of pans never queues work the worker would then do for
 * nothing. A request that exceeds `timeoutMs` resolves null and calls `onTimeout`, but never throws and never stops the queue.
 */
export function createLatestWins<A, R>(
  exec: (arg: A) => Promise<R | null>,
  timeoutMs: number,
  onTimeout?: (arg: A) => void,
): (arg: A) => Promise<R | null> {
  let running = false;
  let waiting: { arg: A; resolve: (r: R | null) => void } | null = null;

  async function drain(first: { arg: A; resolve: (r: R | null) => void }) {
    running = true;
    let cur: { arg: A; resolve: (r: R | null) => void } | null = first;
    while (cur) {
      const job: { arg: A; resolve: (r: R | null) => void } = cur;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        exec(job.arg).catch(() => null),
        new Promise<null>((ok) => { timer = setTimeout(() => { onTimeout?.(job.arg); ok(null); }, timeoutMs); }),
      ]);
      clearTimeout(timer);
      job.resolve(result);
      cur = waiting;
      waiting = null;
    }
    running = false;
  }

  return (arg: A) => new Promise<R | null>((resolve) => {
    if (running) {
      waiting?.resolve(null);
      waiting = { arg, resolve };
    } else {
      void drain({ arg, resolve });
    }
  });
}
