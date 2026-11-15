/**
 * pulse-ledger.ts — which disagreement pulses have already been shown this session (v2.8, WP21). Pure, in memory, never persisted.
 *
 * A pulse plays once per (pair incl. source, bar time, direction): remounting a row, scrolling, or turning the ribbon off and on
 * does not replay it. "Keep pulsing" pulses stay running until the coin's detail is opened (stopPair) or the stop button is
 * pressed (stopAll, which ends every keep pulse currently running).
 */
export type PulseDir = 1 | -1;

export function pulseKey(pairKey: string, bar: number, dir: PulseDir): string {
  return `${pairKey}|${bar}|${dir}`;
}

export function createPulseLedger(max = 5000) {
  const shown = new Set<string>(); // insertion-ordered: the oldest go first
  const active = new Map<string, boolean>(); // key -> keep? (pulses playing now)
  const listeners = new Set<() => void>();
  let version = 0;
  const emit = () => { version++; for (const l of [...listeners]) l(); };
  return {
    /** True the first time this (pair, bar, direction) is claimed. `keep` also starts a running keep pulse. */
    claim(pairKey: string, bar: number, dir: PulseDir, keep = false): boolean {
      const k = pulseKey(pairKey, bar, dir);
      if (shown.has(k)) return false;
      shown.add(k);
      if (shown.size > max) { const oldest = shown.values().next().value as string; shown.delete(oldest); active.delete(oldest); }
      active.set(k, keep);
      emit();
      return true;
    },
    /** Playing now: a three-pulse one until finish(), a keep one until stopped. */
    isActive(key: string): boolean { return active.has(key); },
    /** The three-pulse animation ended. */
    finish(key: string): void { if (active.get(key) === false) { active.delete(key); emit(); } },
    /** Keep pulses currently running. */
    runningCount(): number { let n = 0; for (const keep of active.values()) if (keep) n++; return n; },
    stopPair(pairKey: string): number {
      let n = 0;
      for (const [k, keep] of [...active]) if (keep && k.startsWith(`${pairKey}|`) && active.delete(k)) n++;
      if (n) emit();
      return n;
    },
    stopAll(): number {
      let n = 0;
      for (const [k, keep] of [...active]) if (keep) { active.delete(k); n++; }
      if (n) emit();
      return n;
    },
    size(): number { return shown.size; },
    subscribe(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; },
    snapshot(): number { return version; },
  };
}

/** The session's ledger. */
export const pulseLedger = createPulseLedger();
