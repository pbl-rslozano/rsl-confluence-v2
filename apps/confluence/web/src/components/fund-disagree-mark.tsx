"use client";

import { useEffect, useSyncExternalStore } from "react";
import { pulseKey, pulseLedger, type PulseDir } from "@/lib/pulse-ledger";
import type { FundPulse } from "@/lib/preferences-store";

/**
 * v2.8 (WP21): the list's disagreement marker (a diamond). Rendered only when the Fund trend ribbon is on and Confluence and Fund
 * trend disagree. It pulses once per (pair, bar, direction) per session (mode "three" = 3 pulses, "keep" = until the coin is opened
 * or Stop pulsing is pressed, "off" = never). The diamond is the signal; the row outline is only a reinforcement.
 * Mount it with a key of pair|bar|direction so a new bar or a changed direction is a new pulse.
 */
// A three-pulse mark that unmounts (scrolled away, ribbon off) ends its pulse, so a remount never replays it. The end is deferred one
// tick so React's development double-mount (cleanup, then effect again) does not cancel a pulse that has just started.
const pendingEnd = new Map<string, ReturnType<typeof setTimeout>>();

export function FundDisagreeMark({ pairKey, bar, dir, mode, label }: { pairKey: string; bar: number; dir: PulseDir; mode: FundPulse; label: string }) {
  const key = pulseKey(pairKey, bar, dir);
  useEffect(() => {
    const pending = pendingEnd.get(key);
    if (pending !== undefined) { clearTimeout(pending); pendingEnd.delete(key); }
    if (mode !== "off") pulseLedger.claim(pairKey, bar, dir, mode === "keep");
    return () => { pendingEnd.set(key, setTimeout(() => { pendingEnd.delete(key); pulseLedger.finish(key); }, 0)); };
  }, [key, pairKey, bar, dir, mode]);
  const active = useSyncExternalStore(pulseLedger.subscribe, () => pulseLedger.isActive(key), () => false);
  const cls = mode === "off" || !active ? "" : mode === "keep" ? "ft-pulse ft-pulse-keep" : "ft-pulse ft-pulse-three";
  return (
    <span role="img" aria-label={label} title={label} data-testid="fund-disagree" data-dir={dir}
      onAnimationEnd={() => pulseLedger.finish(key)}
      className={`ft-diamond ms-1 inline-block text-[11px] leading-none text-amber-400 ${cls}`}>◆</span>
  );
}

/** Stops every keep pulse currently running. Renders nothing when none is. */
export function StopPulseButton({ label }: { label: string }) {
  useSyncExternalStore(pulseLedger.subscribe, pulseLedger.snapshot, () => 0);
  if (pulseLedger.runningCount() === 0) return null;
  return (
    <button type="button" data-testid="stop-pulse" onClick={() => pulseLedger.stopAll()}
      className="rsl-touch h-7 shrink-0 rounded border border-amber-500/50 px-2 text-xs text-amber-300">{label}</button>
  );
}
