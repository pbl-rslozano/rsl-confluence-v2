/**
 * fear-greed.ts — v2.8 WP29 (Task 1): the Crypto Fear & Greed Index from Alternative.me, for the collapsed widget.
 * Context only: nothing here reaches scoring, the ledger, alerts or any paper-trading rule.
 *
 * The widget contacts `api.alternative.me` only while it is open (the UI task enforces the gate; this module just fetches).
 * Alternative.me's terms ask for the source to be named right next to the data (ADR-0003 amendment WP29); the UI does that.
 * The web trusts nothing from the response: every row is re-validated, anything invalid is dropped, and no upstream text
 * (not even a classification) is rendered raw: a label is one of five known strings or the app's own band name.
 * Errors are one fixed code, "fng:unavailable": no upstream text or URL is ever surfaced.
 *
 * Cache: one doc in the existing "meta" collection (no new collection, no IndexedDB version bump), re-validated on read.
 */
import type { RadarPort } from "./radar/store";

/** Verbatim endpoint (probe FNG-PROBE-1, docs/research/evidence/wp29-fng-probe-2026-11-16.json): newest row first. */
export const FNG_URL = "https://api.alternative.me/fng/?limit=31&format=json";

export type FngBand = "extremeFear" | "fear" | "neutral" | "greed" | "extremeGreed";

/** t: ms at 00:00 UTC of the index day. */
export interface FngPoint { t: number; value: number; label: string; band: FngBand }
/** asOf: when the data was fetched (ms); points oldest first, one per UTC day, at most 31. */
export interface FngData { asOf: number; points: FngPoint[] }

/** Band colours ported from the GCMDSI kit (sentimentColor). The UI adjusts lightness for the light theme where contrast needs it. */
export const FNG_COLORS: Record<FngBand, string> = {
  extremeFear: "#fd5b70",
  fear: "#f59b6b",
  neutral: "#eccb77",
  greed: "#79d59e",
  extremeGreed: "#28cdb0",
};

/**
 * Light-theme band colours, precomputed (no CSS colour functions, so an engine without color-mix still draws them). Each has at least
 * 4.5:1 on #f5f7fa (the light page background; more on white) and the hues stay 30+ degrees apart:
 * extremeFear #bf1040 5.83, fear #b83a0a 5.36, neutral #706a00 5.22, greed #1c7a3a 5.02, extremeGreed #0a7a6a 4.89.
 */
export const FNG_COLORS_LIGHT: Record<FngBand, string> = {
  extremeFear: "#bf1040",
  fear: "#b83a0a",
  neutral: "#706a00",
  greed: "#1c7a3a",
  extremeGreed: "#0a7a6a",
};

const BAND_LABEL: Record<FngBand, string> = {
  extremeFear: "Extreme Fear",
  fear: "Fear",
  neutral: "Neutral",
  greed: "Greed",
  extremeGreed: "Extreme Greed",
};
const KNOWN_LABELS: ReadonlySet<string> = new Set(Object.values(BAND_LABEL));

const DAY_MS = 86_400_000;
const MIN_T = Date.UTC(2018, 0, 1);
const MAX_POINTS = 31;
const TIMEOUT_MS = 10_000;
const UNAVAILABLE = "fng:unavailable";

export const FNG_COLLECTION = "meta";
export const FNG_CACHE_ID = "fng-cache";
export const FNG_TTL_MS = 3_600_000;

/** 0-24 Extreme Fear, 25-44 Fear, 45-55 Neutral, 56-75 Greed, 76-100 Extreme Greed. */
export function fngBand(v: number): FngBand {
  if (v < 25) return "extremeFear";
  if (v < 45) return "fear";
  if (v <= 55) return "neutral";
  if (v <= 75) return "greed";
  return "extremeGreed";
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** An integer 0..100 given as a digit string or a number; anything else is null. */
function toValue(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,3}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : null;
}

/** Unix seconds as a digit string or an integer; the day (ms, 00:00 UTC) must be after 2018-01-01 and at most `now` + 1 day. */
function toDayStart(v: unknown, now: number): number | null {
  const sec = typeof v === "number" ? v : typeof v === "string" && /^\d{1,12}$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(sec)) return null;
  const ms = sec * 1000;
  if (ms <= MIN_T || ms > now + DAY_MS) return null;
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** The API's own label when it is one of the five known strings, else the app's band name (never raw provider text). */
function toLabel(raw: unknown, band: FngBand): string {
  return typeof raw === "string" && KNOWN_LABELS.has(raw) ? raw : BAND_LABEL[band];
}

/** Sort oldest first, one point per UTC day (the later entry wins), newest 31 kept. */
function finish(points: FngPoint[], asOf: number): FngData | null {
  const byDay = new Map<number, FngPoint>();
  for (const p of points) {
    byDay.delete(p.t); // the last point for a day wins
    byDay.set(p.t, p);
  }
  const list = [...byDay.values()].sort((a, b) => a.t - b.t).slice(-MAX_POINTS);
  return list.length ? { asOf, points: list } : null;
}

/** Parse the API body. Null when `metadata.error` is a non-empty string or no row is valid. Never throws. */
export function parseFng(json: unknown, now: number): FngData | null {
  try {
    if (!isObj(json) || !Array.isArray(json.data)) return null;
    const meta = json.metadata;
    if (isObj(meta) && typeof meta.error === "string" && meta.error !== "") return null;
    const points: FngPoint[] = [];
    for (const r of json.data) {
      if (!isObj(r)) continue;
      const value = toValue(r.value);
      const t = toDayStart(r.timestamp, now);
      if (value === null || t === null) continue;
      const band = fngBand(value);
      points.push({ t, value, label: toLabel(r.value_classification, band), band });
    }
    return finish(points, now);
  } catch {
    return null;
  }
}

/** The caller's signal plus the timeout. AbortSignal.any is missing on older webviews: fall back to a controller (as provider-data-client.ts). */
function combine(caller: AbortSignal | undefined, timeout: AbortSignal, cleanups: Array<() => void>): AbortSignal {
  if (!caller) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([caller, timeout]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (caller.aborted || timeout.aborted) controller.abort();
  else {
    caller.addEventListener("abort", abort, { once: true });
    timeout.addEventListener("abort", abort, { once: true });
    cleanups.push(() => {
      caller.removeEventListener("abort", abort);
      timeout.removeEventListener("abort", abort);
    });
  }
  return controller.signal;
}

/** One GET of the index. Any failure (network, timeout, abort, HTTP error, bad JSON, no valid row) rejects with Error("fng:unavailable"). */
export async function fetchFng(signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<FngData> {
  const timer = new AbortController();
  const timeoutId = setTimeout(() => timer.abort(), TIMEOUT_MS); // covers the body read too; cleared in finally
  const cleanups: Array<() => void> = [];
  try {
    const res = await fetcher(FNG_URL, { cache: "no-store", credentials: "omit", signal: combine(signal, timer.signal, cleanups) });
    if (!res.ok) throw new Error(UNAVAILABLE);
    const data = parseFng(await res.json(), Date.now());
    if (!data) throw new Error(UNAVAILABLE);
    return data;
  } catch {
    throw new Error(UNAVAILABLE);
  } finally {
    clearTimeout(timeoutId);
    for (const fn of cleanups) fn();
  }
}

/* ---------- per-device cache (meta store) ---------- */

/** The same document port the radar store uses (get/put by collection and id). */
export type FngPort = RadarPort;

/** A stored doc is never trusted: the parse checks run again on every point, label and band are recomputed from the value. */
export async function loadFngCache(port: FngPort, now: number): Promise<FngData | null> {
  try {
    const doc = await port.get(FNG_COLLECTION, FNG_CACHE_ID);
    if (!isObj(doc) || !Array.isArray(doc.points)) return null;
    const asOf = doc.asOf;
    if (typeof asOf !== "number" || !Number.isFinite(asOf) || asOf <= 0 || asOf > now) return null; // a fetch time in the future is not trusted
    const points: FngPoint[] = [];
    for (const p of doc.points) {
      if (!isObj(p)) continue;
      const value = toValue(p.value);
      const t = typeof p.t === "number" && Number.isInteger(p.t) ? toDayStart(p.t / 1000, now) : null;
      if (value === null || t === null || t !== p.t) continue; // t must be a UTC-midnight time in range
      const band = fngBand(value);
      points.push({ t, value, label: toLabel(p.label, band), band });
    }
    return finish(points, asOf);
  } catch {
    return null;
  }
}

export async function saveFngCache(port: FngPort, data: FngData): Promise<void> {
  await port.put(FNG_COLLECTION, FNG_CACHE_ID, { asOf: data.asOf, points: data.points });
}

/** Fresh when fetched at or before `now` and less than an hour ago. */
export function isFngFresh(data: FngData, now: number): boolean {
  return Number.isFinite(data.asOf) && data.asOf <= now && now - data.asOf < FNG_TTL_MS;
}

/**
 * Whether to contact the source. On open: when there is no data or it is not fresh. On the 15-minute re-check: only when the data is
 * stale (or absent) AND no attempt was made in the last hour, so a failing source is tried at most once an hour.
 */
export function shouldFetch(data: FngData | null, lastAttempt: number | null, now: number, initial: boolean): boolean {
  const stale = !data || !isFngFresh(data, now);
  if (initial) return stale;
  return stale && (lastAttempt === null || now - lastAttempt >= FNG_TTL_MS);
}

/** A history needs at least two valid days; one row is only the gauge. */
export const hasHistory = (data: FngData): boolean => data.points.length >= 2;

/** Numbers for the history's text alternative (oldest to newest). */
export function fngHistoryStats(data: FngData): { n: number; first: number; last: number; min: number; max: number } {
  const v = data.points.map((p) => p.value);
  return { n: v.length, first: v[0], last: v[v.length - 1], min: Math.min(...v), max: Math.max(...v) };
}
