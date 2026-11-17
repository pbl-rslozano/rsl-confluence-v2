/**
 * chart-geometry.ts — v2.8 (WP22 Step 5 Task 4). Pure helpers for the price chart: the existing
 * end-aligned bucketing (moved out of price-chart.tsx unchanged), start-aligned buckets for the
 * simulated candles, Heikin-Ashi conversion, projection slots and the Play state machine.
 * Display only: nothing here reaches scoring, rules, alerts or the Radar.
 */
import type { Band, Ohlc, Scenario } from "./scenarios";

export const SC_PLAY_MS = 250;

/**
 * End-aligned buckets of k bars (the chart's "never more than one candle per 1.5 px" rule).
 * Open is the first bar's, high/low the extremes, close the last bar's, volume summed.
 * `ends[i]` is the slice index of bucket i's last bar. k = 1 returns the slice itself.
 */
export function bucketBars<T extends Ohlc & { time: number; volume: number }>(slice: T[], k: number): { bars: T[]; ends: number[] } {
  const ends: number[] = [];
  for (let e = slice.length - 1; e >= 0; e -= k) ends.unshift(e);
  const bars = (k === 1 ? slice : ends.map((e) => {
    const b = slice.slice(Math.max(0, e - k + 1), e + 1);
    let hi2 = -Infinity, lo2 = Infinity, vol2 = 0;
    for (const c of b) { if (c.high > hi2) hi2 = c.high; if (c.low < lo2) lo2 = c.low; vol2 += c.volume; }
    return { time: b[0].time, open: b[0].open, high: hi2, low: lo2, close: b[b.length - 1].close, volume: vol2 };
  })) as T[];
  return { bars, ends };
}

/** Start-aligned buckets of the simulated candles: [1..k], [k+1..2k], ...; the last may be partial. */
export function bucketForward(c: Ohlc[], k: number): Ohlc[] {
  const kk = Math.max(1, Math.floor(k));
  const out: Ohlc[] = [];
  for (let s = 0; s < c.length; s += kk) {
    const b = c.slice(s, s + kk);
    let hi = -Infinity, lo = Infinity;
    for (const x of b) { if (x.high > hi) hi = x.high; if (x.low < lo) lo = x.low; }
    out.push({ open: b[0].open, high: hi, low: lo, close: b[b.length - 1].close });
  }
  return out;
}

/** Heikin-Ashi candles. `prev` is the preceding HA bar's open/close (continuation); else the first open is (O+C)/2. */
export function heikinAshi(bars: Ohlc[], prev?: { open: number; close: number }): Ohlc[] {
  const out: Ohlc[] = [];
  let pOpen = prev?.open, pClose = prev?.close;
  for (const b of bars) {
    const close = (b.open + b.high + b.low + b.close) / 4;
    const open = pOpen !== undefined && pClose !== undefined ? (pOpen + pClose) / 2 : (b.open + b.close) / 2;
    out.push({ open, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close), close });
    pOpen = open;
    pClose = close;
  }
  return out;
}

/** Empty slots the projection adds to the time axis. */
export function projectionSlots(h: number, k: number): number {
  return Math.ceil(h / k);
}

/** The band at each forward bucket's last step (`bands[s - 1]` is step s). */
export function bandsAtSlots(bands: Band[], k: number): Band[] {
  const kk = Math.max(1, Math.floor(k));
  const out: Band[] = [];
  for (let s = kk; ; s += kk) {
    out.push(bands[Math.min(s, bands.length) - 1]);
    if (s >= bands.length) break;
  }
  return bands.length ? out : [];
}

export type PlayState = { count: number; playing: boolean };
export type PlayAction = "play" | "tick" | "pause" | "reset";

/** Play / Pause / Replay state. The initial state is `reset`: all H candles shown. */
export function playReducer(s: PlayState, a: PlayAction, h: number, reduced: boolean): PlayState {
  switch (a) {
    case "play": return reduced ? { count: h, playing: false } : { count: 0, playing: true };
    case "tick": { const count = Math.min(h, s.count + 1); return { count, playing: s.playing && count < h }; }
    case "pause": return { count: s.count, playing: false };
    case "reset": return { count: h, playing: false };
  }
}

/** What the chart draws for a projection (built by the page, Task 5). `paths` are in tab order; empty `candles` = no path. */
export interface ChartProjection {
  horizon: number;
  bands: Band[];
  paths: { id: Scenario; label: string; candles: Ohlc[] }[];
  initial: Scenario;
}
