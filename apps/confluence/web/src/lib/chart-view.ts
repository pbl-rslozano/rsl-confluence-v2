/**
 * chart-view.ts — v2.7 (plan WP14.1–14.2): the visible window of the price chart.
 *
 * A view is `{ end, count }` over a series of `total` candles: the bars shown are
 * [end − count, end). Zoom changes `count` around an anchor bar (the bar under the
 * cursor or pinch centre stays where it is on screen); pan moves `end`. Everything is
 * clamped so the window always lies inside the series and holds at least MIN_BARS
 * (or every bar, when the series is shorter). Pure functions: unit-tested in
 * chart-view.test.mjs (acceptance CH-1, CH-3).
 */

export const MIN_BARS = 20;

export interface ChartView {
  /** Exclusive end index into the series (total = newest bar shown). */
  end: number;
  /** Number of bars shown. */
  count: number;
}

/** Clamp a view to a series of `total` bars. */
export function clampView(view: ChartView, total: number): ChartView {
  if (total <= 0) return { end: 0, count: 0 };
  const min = Math.min(MIN_BARS, total);
  const count = Math.max(min, Math.min(total, Math.round(Number.isFinite(view.count) ? view.count : total)));
  const end = Math.max(count, Math.min(total, Math.round(Number.isFinite(view.end) ? view.end : total)));
  return { end, count };
}

/** The default view: the newest `depth` bars (the depth menu: 60 / 250 / 1K / all). */
export function initialView(total: number, depth: number): ChartView {
  return clampView({ end: total, count: depth }, total);
}

/**
 * Zoom by `factor` (> 1 zooms in = fewer bars) keeping the bar at `anchorFrac`
 * (0 = left edge, 1 = right edge of the plot) under the same screen position.
 */
export function zoomView(view: ChartView, total: number, factor: number, anchorFrac = 1): ChartView {
  const v = clampView(view, total);
  if (!(factor > 0) || !Number.isFinite(factor)) return v;
  const a = Math.max(0, Math.min(1, Number.isFinite(anchorFrac) ? anchorFrac : 1));
  const start = v.end - v.count;
  const anchorBar = start + a * v.count;
  const nextCount = clampView({ end: total, count: v.count / factor }, total).count;
  const nextStart = anchorBar - a * nextCount;
  return clampView({ end: nextStart + nextCount, count: nextCount }, total);
}

/** Pan by `bars` (positive = towards newer bars). */
export function panView(view: ChartView, total: number, bars: number): ChartView {
  const v = clampView(view, total);
  if (!Number.isFinite(bars)) return v;
  return clampView({ end: v.end + bars, count: v.count }, total);
}

/** Wheel delta → zoom factor (trackpad pinch arrives as ctrl+wheel with small deltas). */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const clamped = Math.max(-200, Math.min(200, px));
  return Math.exp(-clamped * 0.0025);
}

/** Pinch: ratio of finger distances → zoom factor (spread apart = zoom in). */
export function pinchZoomFactor(startDistance: number, distance: number): number {
  if (!(startDistance > 0) || !(distance > 0)) return 1;
  return distance / startDistance;
}

/** Clamp an inspected candle index to the window (fixes the v2.6 readout crash, CH-1). */
export function clampHover(idx: number | null, count: number): number | null {
  if (idx === null || !Number.isFinite(idx) || count <= 0) return null;
  return Math.max(0, Math.min(count - 1, Math.trunc(idx)));
}
