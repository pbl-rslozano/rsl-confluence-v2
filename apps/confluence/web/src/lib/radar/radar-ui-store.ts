/**
 * radar-ui-store.ts — v2.8 Step 4a (plan WP25, Task 6): the per-device UI state of the Radar panel.
 *
 * Stored in localStorage `ct-radar-v1` as { open, collapsed, thresholds }. Everything is wrapped in try/catch; the panel
 * works for the session when storage is blocked. Same-tab updates reach every user through a tiny subscription, other
 * tabs through the `storage` event (pattern of chart-optin-store.ts). The thresholds are the "starting values" of the
 * alert editor; they are sanitised on every read and write.
 */
import { DEFAULT_THRESHOLDS, sanitizeThresholds, type RadarThresholds } from "./alerts";

export const RADAR_UI_KEY = "ct-radar-v1";
export const RADAR_SECTIONS = ["positioning", "buyer", "regional", "institutions", "alerts", "sources"] as const;
export type RadarSection = (typeof RADAR_SECTIONS)[number];

export interface RadarUi { open: boolean; collapsed: string[]; thresholds: RadarThresholds }

const DEFAULT_UI: RadarUi = Object.freeze({ open: false, collapsed: [], thresholds: DEFAULT_THRESHOLDS }) as RadarUi;

/** Pure: anything that is not valid falls back to the default (closed, nothing collapsed, starting thresholds). */
export function parseRadarUi(raw: unknown): RadarUi {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_UI;
  const o = raw as Record<string, unknown>;
  const collapsed = Array.isArray(o.collapsed) ? RADAR_SECTIONS.filter((s) => (o.collapsed as unknown[]).includes(s)) : [];
  return { open: o.open === true, collapsed: [...collapsed], thresholds: sanitizeThresholds(o.thresholds) };
}

let cache: RadarUi | null = null;
const listeners = new Set<() => void>();

function readStored(): RadarUi {
  try { return parseRadarUi(JSON.parse(localStorage.getItem(RADAR_UI_KEY) ?? "null")); } catch { return DEFAULT_UI; }
}
export function radarUiSnapshot(): RadarUi {
  if (cache === null) cache = readStored();
  return cache;
}
const notify = () => { for (const l of [...listeners]) l(); };

export function subscribeRadarUi(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== RADAR_UI_KEY) return;
    cache = null; // re-read the other tab's value
    listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

function write(next: RadarUi): void {
  cache = next;
  try { localStorage.setItem(RADAR_UI_KEY, JSON.stringify(next)); } catch { /* this tab keeps it */ }
  notify();
}
export function setRadarOpen(open: boolean): void {
  const cur = radarUiSnapshot();
  if (cur.open !== open) write({ ...cur, open });
}
export function setRadarSectionCollapsed(id: string, collapsed: boolean): void {
  const cur = radarUiSnapshot();
  if (!(RADAR_SECTIONS as readonly string[]).includes(id) || cur.collapsed.includes(id) === collapsed) return;
  write({ ...cur, collapsed: RADAR_SECTIONS.filter((s) => (s === id ? collapsed : cur.collapsed.includes(s))) });
}
export function setRadarThresholds(thresholds: unknown): void {
  write({ ...radarUiSnapshot(), thresholds: sanitizeThresholds(thresholds) });
}
export function resetRadarUiForTests(): void { cache = null; }
