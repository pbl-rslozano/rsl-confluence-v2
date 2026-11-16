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
// A mark that unmounts (scrolled away, ribbon off, row filtered out, disagreement over) ends its pulse, so a remount never replays it.
const pendingEnd = new Map<string, ReturnType<typeof setTimeout>>();

export function FundDisagreeMark({ pairKey, bar, dir, mode, label }: { pairKey: string; bar: number; dir: PulseDir; mode: FundPulse; label: string }) {
  const key = pulseKey(pairKey, bar, dir);
  // Mounted-ness: a keep pulse only counts (and the Stop button only shows) while its mark is on screen. The unmount is deferred one
  // tick so React's development double-mount (cleanup, then effect again) neither cancels a pulse that has just started nor counts twice.
  useEffect(() => {
    const pending = pendingEnd.get(key);
    if (pending !== undefined) { clearTimeout(pending); pendingEnd.delete(key); } else pulseLedger.mount(key);
    return () => { pendingEnd.set(key, setTimeout(() => { pendingEnd.delete(key); pulseLedger.unmount(key); }, 0)); };
  }, [key]);
  useEffect(() => {
    if (mode === "off") { pulseLedger.stopKey(key); return; }
    pulseLedger.claim(pairKey, bar, dir, mode === "keep");
    if (mode !== "keep") pulseLedger.stopKey(key); // mode changed away from keep: that pulse ends
  }, [key, pairKey, bar, dir, mode]);
  const active = useSyncExternalStore(pulseLedger.subscribe, () => pulseLedger.isActive(key), () => false);
  const cls = mode === "off" || !active ? "" : mode === "keep" ? "ft-pulse ft-pulse-keep" : "ft-pulse ft-pulse-three";
  return (
    <span role="img" aria-label={label} title={label} data-testid="fund-disagree" data-dir={dir}
      onAnimationEnd={() => pulseLedger.finish(key)}
      className={`ft-diamond ms-1 inline-block text-[11px] leading-none text-amber-400 ${cls}`}>◆</span>
  );
}

const reducedSubscribe = (fn: () => void) => {
  const mq = typeof window !== "undefined" ? window.matchMedia?.("(prefers-reduced-motion: reduce)") : undefined;
  mq?.addEventListener?.("change", fn);
  return () => mq?.removeEventListener?.("change", fn);
};
const reducedNow = () => (typeof window !== "undefined" ? !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches : false);

/** Stops every keep pulse currently running. Renders nothing unless the mode is "keep", motion is allowed and a marked row is pulsing. */
export function StopPulseButton({ label, mode }: { label: string; mode: FundPulse }) {
  useSyncExternalStore(pulseLedger.subscribe, pulseLedger.snapshot, () => 0);
  const reduced = useSyncExternalStore(reducedSubscribe, reducedNow, () => false);
  if (mode !== "keep" || reduced || pulseLedger.runningCount() === 0) return null;
  return (
    <button type="button" data-testid="stop-pulse" onClick={() => pulseLedger.stopAll()}
      className="rsl-touch h-7 shrink-0 rounded border border-amber-500/50 px-2 text-xs text-amber-300">{label}</button>
  );
}
