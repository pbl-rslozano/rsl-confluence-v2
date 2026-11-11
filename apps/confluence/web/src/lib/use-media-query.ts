"use client";
import { useSyncExternalStore } from "react";

/**
 * v2.5 — live `matchMedia` result. Server/prerender snapshot is `false`, so the static
 * export renders the desktop layout and phones switch on hydration.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => (typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(query).matches),
    () => false,
  );
}

/** Phones: below Tailwind's `sm` breakpoint (640 px). */
export const PHONE_QUERY = "(max-width: 639.98px)";
