/**
 * chart-optin-store.ts — opt-in chart add-ons (v2.8, WP21). Everything is OFF by default.
 *
 * Kept apart from the chart's LAYERS / `hidden` list (design-unchanged rule, spec §3): a layer in
 * LAYERS is on by default and hidden on request; an opt-in is off by default and shown on request.
 * Stored under `ct-chart-optin-v1` as a JSON array of ids. Same-tab updates reach every
 * `useChartOptIn()` user through a tiny subscription; other tabs through the `storage` event.
 */
export const OPTIN_KEY = "ct-chart-optin-v1";
export const OPTIN_IDS = ["fund-ribbon", "fund-panel"] as const;
export type ChartOptIn = (typeof OPTIN_IDS)[number];

const NONE: readonly ChartOptIn[] = Object.freeze([]) as readonly ChartOptIn[];

/** Pure: keeps known ids once, in OPTIN_IDS order; anything else (or a non-array) is dropped. */
export function parseOptIn(raw: unknown): ChartOptIn[] {
  if (!Array.isArray(raw)) return [];
  return OPTIN_IDS.filter((id) => raw.includes(id));
}

let cache: readonly ChartOptIn[] | null = null;
const listeners = new Set<() => void>();

function readStored(): readonly ChartOptIn[] {
  try {
    const parsed = parseOptIn(JSON.parse(localStorage.getItem(OPTIN_KEY) ?? "null"));
    return parsed.length ? parsed : NONE;
  } catch {
    return NONE;
  }
}

export function snapshot(): readonly ChartOptIn[] {
  if (cache === null) cache = readStored();
  return cache;
}

function notify() { for (const l of [...listeners]) l(); }

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== OPTIN_KEY) return;
    cache = null; // re-read the other tab's value
    listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function setChartOptIn(id: ChartOptIn, on: boolean): void {
  const cur = snapshot();
  if (cur.includes(id) === on) return;
  const next = parseOptIn(on ? [...cur, id] : cur.filter((x) => x !== id));
  cache = next.length ? next : NONE;
  try { localStorage.setItem(OPTIN_KEY, JSON.stringify(next)); } catch { /* the toggle still works for this tab */ }
  notify();
}

/** Turns every opt-in off (the chart's "Reset to defaults"). */
export function clearChartOptIn(): void {
  for (const id of OPTIN_IDS) setChartOptIn(id, false);
}

/** Current opt-ins (non-React readers and tests). */
export function getChartOptIn(): readonly ChartOptIn[] { return snapshot(); }

/** Test hook: forget the in-memory copy so the next read goes to storage. */
export function resetChartOptInForTests(): void { cache = null; }

