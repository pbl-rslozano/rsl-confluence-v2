/**
 * yield-main.ts — v2.8 (WP22, final review C1). Gives the event loop a turn between chunks of long main-thread work
 * (the ledger's scenario fields), so input and painting are never held up for long.
 * Prefers scheduler.yield(), then a MessageChannel task (neither is held back like timers in a hidden tab), then setTimeout(0)
 * (Node: the recorder and the unit tests).
 */
export function yieldToMain(): Promise<void> {
  const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (sched && typeof sched.yield === "function") return sched.yield();
  if (typeof window !== "undefined" && typeof MessageChannel !== "undefined") {
    return new Promise<void>((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        resolve();
      };
      ch.port2.postMessage(null);
    });
  }
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}
