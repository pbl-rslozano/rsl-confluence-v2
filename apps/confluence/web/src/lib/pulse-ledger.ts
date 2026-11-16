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
  const mounted = new Map<string, number>(); // key -> marks mounted now (a keep pulse only counts while its mark is on screen)
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
      // A new bar (or direction) for the same pair replaces that pair's earlier keep pulse: one pulse per coin.
      if (keep) for (const [other, wasKeep] of [...active]) if (wasKeep && other !== k && other.startsWith(`${pairKey}|`)) active.delete(other);
      active.set(k, keep);
      emit();
      return true;
    },
    /** Playing now: a three-pulse one until finish(), a keep one until stopped. */
    isActive(key: string): boolean { return active.has(key); },
    /** The three-pulse animation ended. */
    finish(key: string): void { if (active.get(key) === false) { active.delete(key); emit(); } },
    /** A mark for this key is on screen. */
    mount(key: string): void { mounted.set(key, (mounted.get(key) ?? 0) + 1); emit(); },
    /** The mark left the screen (scrolled or filtered away, ribbon off, mode changed, disagreement ended): its keep pulse ends. */
    unmount(key: string): void {
      const n = (mounted.get(key) ?? 0) - 1;
      if (n > 0) { mounted.set(key, n); return; }
      mounted.delete(key);
      active.delete(key);
      emit();
    },
    /** Keep pulses currently running: only those whose mark is mounted. */
    runningCount(): number { let n = 0; for (const [k, keep] of active) if (keep && mounted.has(k)) n++; return n; },
    /** Ends this key's keep pulse (the mode is no longer "keep"); a three-pulse one is left to finish. */
    stopKey(key: string): void { if (active.get(key) === true) { active.delete(key); emit(); } },
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
