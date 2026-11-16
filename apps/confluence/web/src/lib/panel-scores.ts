/**
 * panel-scores.ts — per-bar Confluence score for the Fund trend panel (v2.8, WP21). Pure module.
 *
 * Only the visible bars (at most PANEL_MAX_BARS) whose full ENGINE_BARS window is available are scored. A bar's score comes
 * from, in order: this pair/timeframe/last-bar cache, a ledger row with the same cfg and wb = ENGINE_BARS, or the scan
 * worker (`run`). Bars without a full window are null and never drawn (and never cached, so merged older bars re-score them). Scoring itself is `scoreVisibleBars` (scan-jobs.ts),
 * the production window, so a scored bar equals the list's score.
 */
import { ENGINE_BARS } from "./engine-window";
import type { Kline } from "./indicators";

export const PANEL_MAX_BARS = 300;
/** Contiguous bars needed to score `visible` bars: the first one needs ENGINE_BARS - 1 bars before it. */
export const panelBarsNeeded = (visible: number) => ENGINE_BARS + Math.min(PANEL_MAX_BARS, Math.max(1, visible)) - 1;

export const panelCacheKey = (src: string, tf: string, pair: string, lastBarTime: number, cfg: string) => `${src}|${tf}|${pair}|${lastBarTime}|${cfg}`;

/**
 * The one older-bars request per series (source|tf|pair) per session. `fetchOlder` runs the request; its result (or `[]` after a
 * failed request) is stored under `key` so the series is never asked again. A refusal that sent no request (a venue cooldown or a
 * 429, `reason` "RATE_LIMIT") or an abort is NOT the attempt: nothing is stored, so a later open retries. True when stored.
 */
export async function loadOlderOnce(store: Map<string, Kline[]>, key: string, fetchOlder: () => Promise<Kline[]>, signal: AbortSignal): Promise<boolean> {
  if (store.has(key)) return false;
  let older: Kline[];
  try {
    older = await fetchOlder();
  } catch (error) {
    if (signal.aborted) return false; // closed or switched: not an attempt
    if ((error as { reason?: string } | null)?.reason === "RATE_LIMIT") return false; // refused before any request: retry on a later open
    older = []; // a request was sent and failed: the line is drawn where a full window exists, and the note says so
  }
  if (signal.aborted) return false;
  store.set(key, older);
  return true;
}

/** bar open time -> score (null = no full window / unusable). Bounded: oldest series dropped first. */
export type PanelScoreMap = Map<number, number | null>;
const CACHE_SERIES = 24;
const cache = new Map<string, PanelScoreMap>();
export function panelCacheFor(key: string): PanelScoreMap {
  let m = cache.get(key);
  if (m) { cache.delete(key); cache.set(key, m); return m; }
  m = new Map();
  cache.set(key, m);
  while (cache.size > CACHE_SERIES) cache.delete(cache.keys().next().value as string);
  return m;
}
export function resetPanelCacheForTests() { cache.clear(); }

export interface PanelScoreResult {
  /** Score per bar open time in the asked range (null where no full window). */
  scores: PanelScoreMap;
  /** M: bars in the asked range (the whole view, before the 300-bar cap). N (`scored`): bars of it that carry a score. */
  total: number;
  scored: number;
  /** True when the range was longer than PANEL_MAX_BARS and only its newest bars were taken. */
  capped: boolean;
  /** True when some bar of the (capped) window has no score: no full 1,000-bar window, or not scored yet. */
  shortHistory: boolean;
}

/**
 * Scores klines[from, to) (the newest PANEL_MAX_BARS of it). `klines` must be contiguous, oldest first.
 * `known` holds ledger scores by bar time (already filtered to the same cfg and wb = ENGINE_BARS).
 * `run(end, count, known)` scores the `count` bars ending before index `end`, off the main thread; it may return null
 * (no worker): those bars stay unresolved, and are not cached, so a later call can try again.
 */
export async function resolvePanelScores(opts: {
  klines: Kline[];
  from: number;
  to: number;
  cache: PanelScoreMap;
  known: ReadonlyMap<number, number>;
  run: (end: number, count: number, known: ReadonlyMap<number, number>) => Promise<(number | null)[] | null>;
}): Promise<PanelScoreResult> {
  const { klines, cache: have, known, run } = opts;
  const to = Math.min(klines.length, Math.max(0, opts.to));
  const from = Math.max(0, Math.min(to, opts.from), to - PANEL_MAX_BARS);
  const capped = Math.max(0, opts.to) - Math.max(0, opts.from) > PANEL_MAX_BARS;
  const need: number[] = [];
  for (let j = from; j < to; j++) {
    const t = klines[j].time;
    if (have.has(t)) continue;
    // No full window: NOT cached, so older bars merged later (same series key) re-score these bars.
    if (j + 1 < ENGINE_BARS) continue;
    const k = known.get(t);
    if (k !== undefined) { have.set(t, k); continue; }
    need.push(j);
  }
  if (need.length) {
    const lo = need[0], hi = need[need.length - 1];
    const merged = new Map<number, number>(known);
    for (const [t, v] of have) if (v !== null) merged.set(t, v);
    const got = await run(hi + 1, hi - lo + 1, merged);
    if (got) for (const j of need) { const v = got[j - lo]; if (v !== undefined) have.set(klines[j].time, v); }
  }
  const scores: PanelScoreMap = new Map();
  let scored = 0;
  for (let j = from; j < to; j++) {
    const v = have.get(klines[j].time) ?? null;
    scores.set(klines[j].time, v);
    if (v !== null) scored++;
  }
  return { scores, total: Math.max(0, Math.min(klines.length, opts.to) - Math.max(0, opts.from)), scored, capped, shortHistory: scored < to - from };
}
