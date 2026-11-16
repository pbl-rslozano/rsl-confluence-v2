"use client";
/** radar-ui.ts — React hook over radar-ui-store.ts (server render and hydration see the default: closed). */
import { useSyncExternalStore } from "react";
import { radarUiSnapshot, subscribeRadarUi, type RadarUi } from "./radar-ui-store";
import { DEFAULT_THRESHOLDS } from "./alerts";

export * from "./radar-ui-store";
const SERVER: RadarUi = { open: false, collapsed: [], thresholds: DEFAULT_THRESHOLDS };
export function useRadarUi(): RadarUi {
  return useSyncExternalStore(subscribeRadarUi, radarUiSnapshot, () => SERVER);
}
