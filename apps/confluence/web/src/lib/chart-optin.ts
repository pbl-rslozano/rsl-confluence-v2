/**
 * chart-optin.ts — React hook over the opt-in store (v2.8, WP21). The store (ids, parsing, storage, subscription) lives in
 * chart-optin-store.ts so it can be tested under plain Node. Everything is OFF by default; see the store for the rules.
 */
import { useCallback, useSyncExternalStore } from "react";
import { snapshot, subscribe, setChartOptIn, type ChartOptIn } from "./chart-optin-store";

export { OPTIN_KEY, OPTIN_IDS, parseOptIn, setChartOptIn, clearChartOptIn, getChartOptIn, resetChartOptInForTests, type ChartOptIn } from "./chart-optin-store";

const NONE: readonly ChartOptIn[] = Object.freeze([]) as readonly ChartOptIn[];

/** Current opt-ins plus a setter. Server render and hydration see "all off". */
export function useChartOptIn(): { optIn: readonly ChartOptIn[]; has: (id: ChartOptIn) => boolean; set: (id: ChartOptIn, on: boolean) => void } {
  const optIn = useSyncExternalStore(subscribe, snapshot, () => NONE);
  const has = useCallback((id: ChartOptIn) => optIn.includes(id), [optIn]);
  return { optIn, has, set: setChartOptIn };
}
