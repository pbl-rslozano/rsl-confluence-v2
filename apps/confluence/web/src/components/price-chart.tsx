"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Kline } from "@/lib/indicators";
import { ema, macdHistogram, sma, rollingStdDev } from "@/lib/indicators";
import {
  type ChartView, clampHover, clampView, initialView, panView, pinchZoomFactor, wheelZoomFactor, zoomView,
} from "@/lib/chart-view";
import { shellFullscreen } from "@/lib/shell-fullscreen";
import { formatAxisTicks } from "@/lib/money";
import { useRsl } from "@/rsl/RslContext";
import { clearChartOptIn, useChartOptIn } from "@/lib/chart-optin";
import { ribbonStyle } from "@/lib/fund-trend";

/**
 * PriceChart — custom SVG candlestick chart with indicator overlays.
 *
 * Overlays: SMA(200) · EMA(20) · EMA(50) · Bollinger(20,2) · VWAP (visible range),
 * plus MACD histogram and volume panels, a crosshair and an OHLCV readout.
 *
 * v2.7 (plan WP14):
 *   - a view window over ALL loaded candles: zoom (buttons, + / −, Ctrl/⌘+wheel,
 *     trackpad pinch, two-finger pinch) anchored at the cursor / pinch centre, pan
 *     (drag, one-finger horizontal drag, Shift+wheel, Shift+←/→), reset (0, double
 *     click / double tap). The depth menu sets the starting window.
 *   - full screen: the Fullscreen API where the platform supports it, otherwise a
 *     Focus view (fixed overlay over the viewport); desktop app also makes the window
 *     full screen, phones hide the status bar (shell-fullscreen.ts).
 *   - indicators are computed on the full series and then sliced, so the first bars
 *     of a view keep their Bollinger band; the inspected candle is clamped to the view
 *     (v2.6 crashed when the depth shrank under it).
 *   - `formatPrice` lets the page show prices in the display currency (WP13).
 */

const BASE_W = 760; // logical viewBox width (normal mode)
const BASE_PRICE_H = 360;
const HIST_H = 86;
const VOL_H = 78;
const PAD_L = 8;
const PAD_R = 64;
const PAD_T = 12;
const PAD_B = 24;

interface Props {
  klines: Kline[];
  visible?: number;
  /** Price formatter (display currency). Defaults to plain numbers. */
  formatPrice?: (p: number) => string;
  /** Short axis-label formatter. When omitted, labels are made distinct on tight ranges (review v2.7 #9). */
  formatAxis?: (p: number) => string;
  /** Display-currency conversion applied to axis labels (WP13); the candles stay in the market's currency. */
  convertPrice?: (p: number) => number;
  /** v2.8 (WP21): Fund trend per candle, aligned to `klines` (null = no value). Drawn only when the opt-in ribbon is on. */
  fundTrend?: (number | null)[];
  /** v2.8 (WP21): short muted line shown with the ribbon when there is nothing to draw (n/a class, not enough history). */
  fundTrendNote?: string;
  /** v2.8 (WP21): Fund size (% of capital, 0..200) per candle, aligned to `klines`. Drawn in the opt-in panel only. */
  fundSize?: (number | null)[];
  /** v2.8 (WP21): Confluence score by candle open time (null = no full engine window). Drawn in the opt-in panel only. */
  panelScores?: ReadonlyMap<number, number | null>;
  /** v2.8 (WP21): short muted note under the panel ("Score shown for N of M bars ..."). */
  panelNote?: string;
  /** v2.8 (WP21): "Fund rank {rank} of {n}", shown in the panel header. */
  fundRankLabel?: string;
  /** v2.8 (WP21): index range [from, to) of the candles in view, reported while the panel is on (the page scores those bars). */
  onPanelRange?: (from: number, to: number) => void;
}

const PANEL_H = 96; // v2.8 (WP21): opt-in Fund trend pane below volume
const PANEL_COLOURS = { score: "#60a5fa", trend: "#f472b6", size: "#a1a1aa" } as const;
const RIBBON_H = 6;
const RIBBON_COLOURS = { up: "#34d399", down: "#fb7185", grey: "#71717a" } as const;

const LAYERS = {
  "ema-fast": "Fast EMA",
  "ema-slow": "Slow EMA",
  "sma-long": "SMA",
  bollinger: "Bollinger Bands",
  vwap: "VWAP",
  macd: "MACD histogram",
  volume: "Volume",
} as const;
const DEFAULT_PERIODS = { "ema-fast": 20, "ema-slow": 50, "sma-long": 200 } as const;
type Layer = keyof typeof LAYERS;
type Average = keyof typeof DEFAULT_PERIODS;
const LAYER_IDS = Object.keys(LAYERS) as Layer[];
const STORAGE_KEY = "ct-chart-indicators-v1";
type ChartSettings = { hidden: Layer[]; periods: Record<Average, number> };
const DEFAULT_SETTINGS: ChartSettings = { hidden: [], periods: DEFAULT_PERIODS };
type FullMode = "off" | "native" | "focus";

function validPeriod(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function readSettings(): ChartSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!saved) return DEFAULT_SETTINGS;
    const periods = { ...DEFAULT_SETTINGS.periods };
    for (const id of Object.keys(DEFAULT_PERIODS) as Average[]) {
      const value = saved.periods?.[id];
      if (validPeriod(value)) periods[id] = value;
    }
    return { periods, hidden: LAYER_IDS.filter((id) => Array.isArray(saved.hidden) && saved.hidden.includes(id)) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Largest/smallest finite value without spreading huge arrays into Math.max (stack limit). */
function extent(values: Iterable<number>): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

interface Series {
  id: Layer;
  values: number[];
  color: string;
  label: string;
  dashed?: boolean;
}

/** Element fullscreen is used only in plain browsers that support it on non-video elements. */
function canUseNativeFullscreen(el: HTMLElement | null): boolean {
  if (!el || typeof document === "undefined") return false;
  if (shellFullscreen()) return false; // Tauri / Capacitor: Focus view + shell help
  return Boolean(document.fullscreenEnabled && typeof el.requestFullscreen === "function");
}

export function PriceChart({ klines, visible = 60, formatPrice = fmtNum, formatAxis, convertPrice, fundTrend, fundTrendNote, fundSize, panelScores, panelNote, fundRankLabel, onPanelRange }: Props) {
  const { t } = useRsl();
  const optIns = useChartOptIn();
  const showRibbon = optIns.has("fund-ribbon");
  const showPanel = optIns.has("fund-panel");
  const total = klines.length;
  const [view, setView] = useState<ChartView>(() => initialView(total, visible));
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [settings, setSettings] = useState(readSettings);
  const [menuOpen, setMenuOpen] = useState(false);
  const [full, setFull] = useState<FullMode>("off");
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const shellFsRef = useRef(false); // true only while THIS chart asked the shell for full screen
  const svgRef = useRef<SVGSVGElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const { hidden, periods } = settings;
  const showBollinger = !hidden.includes("bollinger");
  const showMacd = !hidden.includes("macd");
  const showVolume = !hidden.includes("volume");

  // Depth menu → new starting window; new candles: a view that was following the newest bar keeps
  // following it. Adjusted while rendering (React's "state from props" pattern), not in an effect.
  const firstTime = klines[0]?.time ?? 0;
  const [seen, setSeen] = useState({ visible, total, firstTime });
  if (seen.visible !== visible || seen.total !== total || seen.firstTime !== firstTime) {
    if (seen.visible !== visible) { setView(initialView(total, visible)); setHoverIdx(null); }
    else {
      // Older bars loaded in front (Load 5K older): keep showing the same bars (review v2.7 #4).
      const prepended = seen.total > 0 && firstTime < seen.firstTime ? Math.max(0, total - seen.total) : 0;
      setView((cur) => {
        const showingAll = cur.count >= seen.total;
        if (prepended) return clampView({ end: cur.end + prepended, count: showingAll ? total : cur.count }, total);
        const following = cur.end >= seen.total;
        return clampView(following ? { end: total, count: showingAll ? total : cur.count } : cur, total);
      });
    }
    setSeen({ visible, total, firstTime });
  }

  function updateSettings(next: ChartSettings) {
    setSettings(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // The controls still work for this chart if browser storage is unavailable.
    }
  }

  /* ---------------- full screen ---------------- */
  const exitFull = useCallback(() => {
    setFull((mode) => {
      if (mode === "native" && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      if (mode !== "off" && shellFsRef.current) { shellFsRef.current = false; void shellFullscreen()?.set(false).catch(() => {}); }
      return "off";
    });
  }, []);
  const enterFull = useCallback(async () => {
    const el = frameRef.current;
    if (canUseNativeFullscreen(el)) {
      try {
        await el!.requestFullscreen({ navigationUI: "hide" });
        setFull("native");
        return;
      } catch {
        // fall through to the Focus view (e.g. iPhone Safari, permission refused)
      }
    }
    setFull("focus");
    const shell = shellFullscreen();
    if (shell) { shellFsRef.current = true; void shell.set(true).catch(() => {}); }
  }, []);
  useEffect(() => {
    const onChange = () => { if (!document.fullscreenElement) setFull((m) => (m === "native" ? "off" : m)); };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  // Focus view: Esc (and Android Back, which dispatches Esc) leaves full screen first and
  // must not reach the detail sheet, whose Radix layer closes on Esc. Window capture runs
  // before Radix's document listener.
  useEffect(() => {
    // Native full screen: browsers normally consume Esc themselves; if one is delivered anyway it
    // must leave full screen, not close the sheet underneath.
    if (full === "off") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      e.preventDefault();
      exitFull();
    };
    window.addEventListener("keydown", onKey, true);
    const prevOverflow = document.body.style.overflow;
    if (full === "focus") document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey, true); document.body.style.overflow = prevOverflow; };
  }, [full, exitFull]);
  // Leaving with the sheet: undo only the window full screen this chart turned on (review v2.7 #10).
  useEffect(() => () => { if (shellFsRef.current) { shellFsRef.current = false; void shellFullscreen()?.set(false).catch(() => {}); } }, []);
  // Focus view (review v2.7 #1): a fixed overlay is positioned against the nearest ancestor with a transform,
  // translate, filter or containment — the detail sheet is one. Neutralise them while the view is open.
  useEffect(() => {
    if (full !== "focus") return;
    const saved: { el: HTMLElement; css: string }[] = [];
    for (let el = frameRef.current?.parentElement ?? null; el && el !== document.documentElement; el = el.parentElement) {
      const cs = getComputedStyle(el);
      const contains = cs.transform !== "none" || (cs.translate && cs.translate !== "none") || cs.filter !== "none" ||
        (cs.backdropFilter && cs.backdropFilter !== "none") || /paint|layout|strict|content/.test(cs.contain) || /transform|filter/.test(cs.willChange) || cs.perspective !== "none";
      if (!contains) continue;
      saved.push({ el, css: el.style.cssText });
      el.style.setProperty("transform", "none", "important");
      el.style.setProperty("translate", "none", "important");
      el.style.setProperty("filter", "none", "important");
      el.style.setProperty("backdrop-filter", "none", "important");
      el.style.setProperty("contain", "none", "important");
      el.style.setProperty("will-change", "auto", "important");
      el.style.setProperty("perspective", "none", "important");
    }
    return () => { for (const { el, css } of saved) el.style.cssText = css; };
  }, [full]);
  // Measured plot size in full screen, so candles use the whole screen.
  useEffect(() => {
    const el = plotRef.current;
    if (full === "off" || !el || typeof ResizeObserver === "undefined") { setSize(null); return; }
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ w: Math.round(width), h: Math.round(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [full]);

  /* ---------------- geometry ---------------- */
  const viewW = size ? Math.max(320, size.w) : BASE_W;
  const panelsH = (showMacd ? HIST_H : 0) + (showVolume ? VOL_H : 0) + (showPanel ? PANEL_H : 0) + PAD_T + PAD_B;
  const priceH = size ? Math.max(160, size.h - panelsH) : BASE_PRICE_H;
  const chartW = viewW - PAD_L - PAD_R;

  const v = clampView(view, total);
  const start = v.end - v.count;
  useEffect(() => { if (showPanel) onPanelRange?.(start, v.end); }, [showPanel, start, v.end, onPanelRange]);

  const model = useMemo(() => {
    const slice = klines.slice(start, v.end);
    if (slice.length < 2) return null;
    // Indicators on the full series, then sliced to the view (v2.6 computed bands on the slice only).
    const allCloses = klines.map((c) => c.close);
    const mid = sma(allCloses, 20);
    const sd = rollingStdDev(allCloses, 20);
    const bbUpper = mid.slice(start, v.end).map((m, i) => m + 2 * sd[start + i]);
    const bbLower = mid.slice(start, v.end).map((m, i) => m - 2 * sd[start + i]);
    // VWAP anchored at the first visible bar ("visible range").
    let cumPV = 0, cumV = 0;
    const vwap: number[] = [];
    for (const c of slice) {
      const tp = (c.high + c.low + c.close) / 3;
      cumPV += tp * c.volume;
      cumV += c.volume;
      vwap.push(cumV === 0 ? c.close : cumPV / cumV);
    }

    const series: Series[] = [];
    for (const [id, color] of [["ema-fast", "#f59e0b"], ["ema-slow", "#a78bfa"], ["sma-long", "#94a3b8"]] as const) {
      const period = periods[id];
      if (hidden.includes(id) || period > klines.length) continue;
      const isSma = id === "sma-long";
      const values = (isSma ? sma : ema)(allCloses, period).slice(start, v.end);
      series.push({ id, values, color, label: `${isSma ? "SMA" : "EMA"} ${period}` });
    }
    if (!hidden.includes("vwap")) series.push({ id: "vwap", values: vwap, color: "#22d3ee", label: "VWAP (visible)", dashed: true });

    let [lo, hi] = extent((function* () { for (const c of slice) { yield c.low; yield c.high; } })());
    const [olo, ohi] = extent((function* () {
      if (showBollinger) { yield* bbUpper; yield* bbLower; }
      for (const s of series) yield* s.values;
    })());
    lo = Math.min(lo, olo);
    hi = Math.max(hi, ohi);
    const pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.06 || 1;
    lo -= pad;
    hi += pad;
    const y = (price: number) => PAD_T + (1 - (price - lo) / (hi - lo)) * priceH;

    // Review #6: never draw more than one candle per 1.5 px. Buckets of k bars become one OHLC
    // candle (volume summed); overlays and MACD are sampled at each bucket's last bar.
    const k = Math.max(1, Math.ceil(slice.length / Math.max(40, Math.floor(chartW / 1.5))));
    const fullHist = macdHistogram(klines).slice(start, v.end);
    const bucketEnds: number[] = [];
    for (let e = slice.length - 1; e >= 0; e -= k) bucketEnds.unshift(e);
    const bars = k === 1 ? slice : bucketEnds.map((e) => {
      const b = slice.slice(Math.max(0, e - k + 1), e + 1);
      let hi2 = -Infinity, lo2 = Infinity, vol2 = 0;
      for (const c of b) { if (c.high > hi2) hi2 = c.high; if (c.low < lo2) lo2 = c.low; vol2 += c.volume; }
      return { time: b[0].time, open: b[0].open, high: hi2, low: lo2, close: b[b.length - 1].close, volume: vol2 };
    });
    const sample = (arr: number[]) => (k === 1 ? arr : bucketEnds.map((e) => arr[e]));
    const bbU = sample(bbUpper), bbL = sample(bbLower);
    for (const s2 of series) s2.values = sample(s2.values);
    const histogram = k === 1 ? fullHist : bucketEnds.map((e) => fullHist[e]);
    // v2.8 (WP21): Fund trend at each drawn bar (the bucket's last bar when bars are grouped).
    const ribbon = showRibbon && fundTrend && fundTrend.length === klines.length
      ? bucketEnds.map((e) => fundTrend[start + e] ?? null)
      : null;

    // v2.8 (WP21): panel series at each drawn bar (the bucket's last bar when bars are grouped).
    const panel = showPanel ? {
      trend: bucketEnds.map((e) => (fundTrend && fundTrend.length === klines.length ? fundTrend[start + e] : null) ?? null),
      size: bucketEnds.map((e) => (fundSize && fundSize.length === klines.length ? fundSize[start + e] : null) ?? null),
      score: bucketEnds.map((e) => panelScores?.get(klines[start + e].time) ?? null),
    } : null;

    const step = chartW / bars.length;
    const x = (i: number) => PAD_L + i * step + step / 2;
    const bodyW = Math.max(1, step * 0.62);

    const histTop = PAD_T + priceH;
    const histZero = histTop + HIST_H / 2;
    const [, maxAbs] = extent(histogram.map((p) => Math.abs(p.histogram)));
    const maxHist = Math.max(maxAbs, 1e-9);
    const histY = (val: number) => histZero - (val / maxHist) * (HIST_H * 0.42);

    const [, maxV] = extent(bars.map((c) => c.volume));
    const maxVol = Math.max(maxV, 1);
    const volTop = histTop + (showMacd ? HIST_H : 0);
    const volY = (val: number) => volTop + VOL_H - (val / maxVol) * (VOL_H - 8);

    const tickPrices = [0, 1, 2, 3, 4].map((i) => lo + ((hi - lo) * i) / 4);
    const shown = convertPrice ? tickPrices.map(convertPrice) : tickPrices;
    const tickLabels = formatAxis ? shown.map(formatAxis) : formatAxisTicks(shown);
    const ticks = tickPrices.map((price, i) => ({ y: y(price), label: tickLabels[i] }));
    const nTimeTicks = Math.max(3, Math.min(9, Math.round(chartW / 150)));
    const timeTicks: { x: number; label: string }[] = [];
    for (let i = 0; i < nTimeTicks; i++) {
      const idx = Math.floor((i / (nTimeTicks - 1)) * (bars.length - 1));
      timeTicks.push({ x: x(idx), label: fmtTime(bars[idx].time) });
    }
    return { slice: bars, perBar: k, x, y, bodyW, step, bbUpper: bbU, bbLower: bbL, histogram, histTop, histZero, histY, volY, volTop, ticks, timeTicks, series, ribbon, panel };
  }, [klines, start, v.end, hidden, periods, showBollinger, showMacd, priceH, chartW, formatAxis, convertPrice, showRibbon, fundTrend, showPanel, fundSize, panelScores]);

  /* Static layers are memoised: moving the pointer re-renders only the crosshair and readout (review #6). */
  const layers = useMemo(() => {
    if (!model) return null;
    const { slice, x, y, bodyW, step, bbUpper, bbLower, histogram, histTop, histZero, histY, volY, volTop, ticks, timeTicks, series, ribbon, panel } = model;
    const panelTop = volTop + (showVolume ? VOL_H : 0);
    const viewH = panelTop + (panel ? PANEL_H : 0) + PAD_B;
    let bandPath = "";
    let firstUp = true;
    for (let i = 0; i < slice.length; i++) {
      if (isNaN(bbUpper[i])) continue;
      bandPath += `${firstUp ? "M" : "L"}${x(i).toFixed(1)},${y(bbUpper[i]).toFixed(1)} `;
      firstUp = false;
    }
    for (let i = slice.length - 1; i >= 0; i--) {
      if (isNaN(bbLower[i])) continue;
      bandPath += `L${x(i).toFixed(1)},${y(bbLower[i]).toFixed(1)} `;
    }
    bandPath = firstUp ? "" : bandPath + "Z";
    return (
      <>
          {ticks.map((t, i) => (
            <g key={`g${i}`}>
              <line x1={PAD_L} y1={t.y} x2={PAD_L + chartW} y2={t.y} stroke="var(--color-zinc-800)" strokeWidth={1} />
              <text x={viewW - PAD_R + 6} y={t.y + 3} fill="var(--color-zinc-500)" fontSize={10} fontFamily="ui-monospace, monospace">
                {t.label}
              </text>
            </g>
          ))}

          {showBollinger && bandPath && (
            <g data-indicator="bollinger">
              <path d={bandPath} fill="#10b981" opacity={0.07} />
              <polyline
                points={slice.map((_, i) => isNaN(bbUpper[i]) ? "" : `${x(i).toFixed(1)},${y(bbUpper[i]).toFixed(1)}`).filter(Boolean).join(" ")}
                fill="none" stroke="#10b981" strokeWidth={1} opacity={0.35} strokeDasharray="3 3"
              />
              <polyline
                points={slice.map((_, i) => isNaN(bbLower[i]) ? "" : `${x(i).toFixed(1)},${y(bbLower[i]).toFixed(1)}`).filter(Boolean).join(" ")}
                fill="none" stroke="#10b981" strokeWidth={1} opacity={0.35} strokeDasharray="3 3"
              />
            </g>
          )}

          {series.map((s) => (
            <polyline
              key={s.id}
              data-indicator={s.id}
              points={slice.map((_, i) => isNaN(s.values[i]) ? "" : `${x(i).toFixed(1)},${y(s.values[i]).toFixed(1)}`).filter(Boolean).join(" ")}
              fill="none"
              stroke={s.color}
              strokeWidth={1.5}
              strokeDasharray={s.dashed ? "5 3" : undefined}
              opacity={0.9}
            />
          ))}

          {showMacd && <g data-indicator="macd">
            <line x1={PAD_L} y1={histTop} x2={PAD_L + chartW} y2={histTop} stroke="var(--color-zinc-700)" strokeWidth={1} />
            <line x1={PAD_L} y1={histZero} x2={PAD_L + chartW} y2={histZero} stroke="var(--color-zinc-800)" strokeWidth={1} strokeDasharray="3 3" />
            <text x={PAD_L + 4} y={histTop + 12} fill="var(--color-zinc-500)" fontSize={10} fontFamily="ui-monospace, monospace">
              MACD histogram
            </text>
            {histogram.map((p, i) => {
              if (isNaN(p.histogram)) return null;
              const top = Math.min(histZero, histY(p.histogram));
              const h = Math.abs(histY(p.histogram) - histZero);
              return (
                <rect key={`h${i}`} x={x(i) - bodyW / 2} y={top} width={bodyW} height={Math.max(0.5, h)}
                  fill={p.histogram >= 0 ? "#34d399" : "#fb7185"} opacity={0.55} />
              );
            })}
          </g>}
          {showVolume && <g data-indicator="volume">
            {slice.map((c, i) => {
              const h = (volTop + VOL_H) - volY(c.volume);
              return (
                <rect key={`v${i}`} x={x(i) - bodyW / 2} y={volY(c.volume)} width={bodyW} height={Math.max(0.5, h)}
                  fill={c.close >= c.open ? "#34d399" : "#fb7185"} opacity={0.35} />
              );
            })}
            <line x1={PAD_L} y1={volTop} x2={PAD_L + chartW} y2={volTop} stroke="var(--color-zinc-700)" strokeWidth={1} />
            <text x={PAD_L + 4} y={volTop + 12} fill="var(--color-zinc-500)" fontSize={10} fontFamily="ui-monospace, monospace">
              Volume
            </text>
          </g>}
          <g data-testid="price-candles">
            {slice.map((c, i) => {
              const color = c.close >= c.open ? "#34d399" : "#fb7185";
              const wickX = x(i);
              const bodyTop = y(Math.max(c.open, c.close));
              const bodyBot = y(Math.min(c.open, c.close));
              return (
                <g key={`c${i}`}>
                  <line x1={wickX} y1={y(c.high)} x2={wickX} y2={y(c.low)} stroke={color} strokeWidth={1} />
                  <rect x={wickX - bodyW / 2} y={bodyTop} width={bodyW} height={Math.max(1, bodyBot - bodyTop)}
                    fill={color} opacity={0.85} />
                </g>
              );
            })}
          </g>
          {ribbon && <g data-fund="ribbon">
            {ribbon.map((val, i) => {
              const st = ribbonStyle(val);
              if (st.colour === "none") return null;
              return (
                <rect key={`r${i}`} data-ft={(val as number).toFixed(2)} data-ft-colour={st.colour}
                  x={x(i) - step / 2} y={PAD_T + priceH - RIBBON_H} width={step} height={RIBBON_H}
                  fill={RIBBON_COLOURS[st.colour]} opacity={st.alpha} />
              );
            })}
          </g>}
          {panel && (() => {
            const inTop = panelTop + 18, inBot = panelTop + PANEL_H - 6, span = inBot - inTop;
            const yScore = (val: number) => inBot - ((Math.max(-100, Math.min(100, val)) + 100) / 200) * span;
            const ySize = (val: number) => inBot - (Math.max(0, Math.min(200, val)) / 200) * span;
            // Runs of consecutive non-null values; a lone point is drawn as a dot.
            const runs = (vals: (number | null)[], f: (n: number) => number) => {
              let d = "";
              let open = false;
              let single = false;
              for (let i = 0; i <= vals.length; i++) {
                const val = i < vals.length ? vals[i] : null;
                if (val == null || !Number.isFinite(val)) {
                  if (open && single) d += "h0.01";
                  open = false;
                  continue;
                }
                d += `${open ? "L" : "M"}${x(i).toFixed(1)},${f(val).toFixed(1)}`;
                single = !open;
                open = true;
              }
              return d;
            };
            const lastOf = (vals: (number | null)[]) => { for (let i = vals.length - 1; i >= 0; i--) { const val = vals[i]; if (val != null && Number.isFinite(val)) return val; } return null; };
            const scoreLast = lastOf(panel.score), trendLast = lastOf(panel.trend);
            const scoreD = runs(panel.score, yScore);
            const trendD = runs(panel.trend, yScore);
            let areaD = "";
            for (let i = 0; i <= panel.size.length; i++) {
              const a = i < panel.size.length ? panel.size[i] : null;
              if (a != null && Number.isFinite(a)) {
                let j = i;
                while (j + 1 < panel.size.length && panel.size[j + 1] != null && Number.isFinite(panel.size[j + 1] as number)) j++;
                const x0 = x(i) - step / 2, x1 = x(j) + step / 2;
                areaD += `M${x0.toFixed(1)},${inBot.toFixed(1)}`;
                for (let q = i; q <= j; q++) areaD += `L${(q === i ? x0 : x(q)).toFixed(1)},${ySize(panel.size[q] as number).toFixed(1)}L${(q === j ? x1 : x(q)).toFixed(1)},${ySize(panel.size[q] as number).toFixed(1)}`;
                areaD += `L${x1.toFixed(1)},${inBot.toFixed(1)}Z`;
                i = j;
              }
            }
            const mono = "ui-monospace, monospace";
            return (
              <g data-fund="panel" data-testid="fund-panel">
                <line x1={PAD_L} y1={panelTop} x2={PAD_L + chartW} y2={panelTop} stroke="var(--color-zinc-700)" strokeWidth={1} />
                <line x1={PAD_L} y1={yScore(0)} x2={PAD_L + chartW} y2={yScore(0)} stroke="var(--color-zinc-800)" strokeWidth={1} strokeDasharray="3 3" />
                {areaD && <path data-fund-area="size" d={areaD} fill={PANEL_COLOURS.size} opacity={0.2} />}
                {scoreD && <path data-fund-line="score" data-n={panel.score.filter((q) => q != null).length} data-last={scoreLast ?? undefined} d={scoreD} fill="none" stroke={PANEL_COLOURS.score} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />}
                {trendD && <path data-fund-line="trend" data-last={trendLast?.toFixed(2)} d={trendD} fill="none" stroke={PANEL_COLOURS.trend} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />}
                <text x={PAD_L + 4} y={panelTop + 12} fontSize={10} fontFamily={mono}>
                  <tspan fill={PANEL_COLOURS.score}>{t("ft.panelScore")}</tspan>
                  <tspan fill="var(--color-zinc-500)" dx={8}>·</tspan>
                  <tspan fill={PANEL_COLOURS.trend} dx={8}>{t("ft.panelTrend")}</tspan>
                  <tspan fill="var(--color-zinc-500)" dx={8}>·</tspan>
                  <tspan fill={PANEL_COLOURS.size} dx={8}>{t("ft.panelSize")}</tspan>
                </text>
                {fundRankLabel && (
                  <text data-testid="fund-rank" x={PAD_L + chartW - 4} y={panelTop + 12} textAnchor="end" fill="var(--color-zinc-300)" fontSize={10} fontFamily={mono}>{fundRankLabel}</text>
                )}
                {[100, 0, -100].map((tick) => (
                  <text key={tick} x={viewW - PAD_R + 6} y={yScore(tick) + 3} fill="var(--color-zinc-500)" fontSize={10} fontFamily={mono}>{tick > 0 ? "+" : tick < 0 ? "−" : ""}{Math.abs(tick)}</text>
                ))}
                <text x={PAD_L + 4} y={inTop + 9} fill={PANEL_COLOURS.size} opacity={0.8} fontSize={9} fontFamily={mono}>200 %</text>
                <text x={PAD_L + 4} y={inBot - 2} fill={PANEL_COLOURS.size} opacity={0.8} fontSize={9} fontFamily={mono}>0 %</text>
              </g>
            );
          })()}
          {timeTicks.map((t, i) => (
            <text key={`t${i}`} x={t.x} y={viewH - 6} fill="var(--color-zinc-500)" fontSize={10} fontFamily="ui-monospace, monospace" textAnchor="middle">
              {t.label}
            </text>
          ))}
      </>
    );
  }, [model, showBollinger, showMacd, showVolume, viewW, chartW, t, fundRankLabel]);

  /* ---------------- input ---------------- */
  const viewRef = useRef(v);
  const fullRef = useRef(full);
  useEffect(() => { viewRef.current = v; fullRef.current = full; });
  /** Pointer X → fraction across the plot area (0 left … 1 right). */
  const fracAt = useCallback((clientX: number): number => {
    const svg = svgRef.current;
    if (!svg) return 1;
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / viewW;
    return Math.max(0, Math.min(1, (clientX - rect.left - PAD_L * scale) / (chartW * scale)));
  }, [viewW, chartW]);
  const zoomBy = useCallback((factor: number, frac = 1) => setView((cur) => zoomView(cur, total, factor, frac)), [total]);
  const resetView = useCallback(() => { setView(initialView(total, visible)); setHoverIdx(null); }, [total, visible]);

  // Wheel needs a non-passive listener so Ctrl+wheel / pinch does not zoom the page.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (e.shiftKey || horizontal) {
        e.preventDefault();
        const d = horizontal ? e.deltaX : e.deltaY;
        const cur = viewRef.current;
        setView(panView(cur, total, (d / 100) * Math.max(1, cur.count / 10)));
        return;
      }
      if (e.ctrlKey || e.metaKey || fullRef.current !== "off") {
        e.preventDefault();
        zoomBy(wheelZoomFactor(e.deltaY, e.deltaMode), fracAt(e.clientX));
      }
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [total, zoomBy, fracAt, layers]);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ kind: "none" | "drag" | "pinch"; startX: number; startY?: number; startView: ChartView; startDist: number; frac: number; moved: boolean }>(
    { kind: "none", startX: 0, startView: v, startDist: 0, frac: 1, moved: false },
  );
  const lastTap = useRef(0);

  function hoverAt(clientX: number) {
    const svg = svgRef.current;
    if (!svg || !model) return;
    const rect = svg.getBoundingClientRect();
    const relX = ((clientX - rect.left) / rect.width) * viewW;
    const idx = Math.floor((relX - PAD_L) / model.step);
    setHoverIdx(idx >= 0 && idx < model.slice.length ? idx : null);
  }
  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    const pts = [...pointers.current.values()];
    if (pts.length === 2) {
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      gesture.current = { kind: "pinch", startX: 0, startView: viewRef.current, startDist: dist, frac: fracAt((pts[0].x + pts[1].x) / 2), moved: true };
    } else if (pts.length === 1 && (e.pointerType !== "mouse" || e.button === 0)) {
      gesture.current = { kind: "drag", startX: e.clientX, startY: e.clientY, startView: viewRef.current, startDist: 0, frac: 1, moved: false };
    }
  }
  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (g.kind === "pinch" && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const factor = pinchZoomFactor(g.startDist, Math.hypot(a.x - b.x, a.y - b.y));
      setView(zoomView(g.startView, total, factor, g.frac));
      return;
    }
    if (g.kind === "drag" && pointers.current.has(e.pointerId)) {
      const dx = e.clientX - g.startX;
      if (!g.moved && Math.abs(dx) < 6) { if (e.pointerType === "mouse") hoverAt(e.clientX); return; }
      g.moved = true;
      const svg = svgRef.current;
      const widthPx = svg ? (svg.getBoundingClientRect().width * chartW) / viewW : chartW;
      setView(panView(g.startView, total, -(dx / Math.max(1, widthPx)) * g.startView.count));
      return;
    }
    if (e.pointerType === "mouse") hoverAt(e.clientX);
  }
  function onPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    // A vertical scroll that began on the chart is not a tap (review v2.7 #5).
    if (g.kind === "drag" && !g.moved && Math.abs(e.clientY - (g.startY ?? e.clientY)) < 10) {
      hoverAt(e.clientX); // tap / click inspects a candle
      const now = Date.now();
      if (e.pointerType !== "mouse" && now - lastTap.current < 320) resetView();
      lastTap.current = now;
    }
    if (pointers.current.size === 0) gesture.current = { ...g, kind: "none" };
    else if (g.kind === "pinch") {
      const [rest] = [...pointers.current.values()];
      gesture.current = { kind: "drag", startX: rest.x, startView: viewRef.current, startDist: 0, frac: 1, moved: true };
    }
  }

  if (!model) {
    return (
      <div className="flex h-48 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950/50 text-sm text-zinc-500">
        Not enough candle data to render chart
      </div>
    );
  }

  const { slice, x, y, histogram, volTop, series, perBar } = model;
  const plotBottom = volTop + (showVolume ? VOL_H : 0) + (showPanel ? PANEL_H : 0);
  const viewH = plotBottom + PAD_B;


  const activeIdx = clampHover(hoverIdx, slice.length) ?? slice.length - 1;
  const hover = slice[activeIdx];
  const isFull = full !== "off";
  const zoomedOut = v.count >= total;
  const btn = "inline-flex min-h-8 min-w-8 items-center justify-center rounded border border-zinc-600 px-2 py-1 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 max-sm:min-h-11 max-sm:min-w-11";

  return (
    <div
      ref={frameRef}
      data-testid="price-chart"
      data-fullscreen={full}
      role={full === "focus" ? "dialog" : undefined}
      aria-modal={full === "focus" ? true : undefined}
      aria-label={full === "focus" ? "Chart full screen" : undefined}
      className={
        isFull
          ? "fixed inset-0 z-[200] flex flex-col bg-zinc-950 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-[max(0.5rem,env(safe-area-inset-top))] ps-[max(0.5rem,env(safe-area-inset-left))] pe-[max(0.5rem,env(safe-area-inset-right))]"
          : "rounded-lg border border-zinc-800 bg-zinc-950/60 p-2"
      }
      style={isFull ? { height: "100dvh", width: "100vw" } : undefined}
    >
      <div className="mb-2 flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="Chart controls">
        <button type="button" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)} className={btn}>
          Indicators
        </button>
        <span className="mx-1 h-5 w-px bg-zinc-700" aria-hidden />
        <button type="button" className={btn} aria-label="Zoom in" title="Zoom in (+)" disabled={v.count <= Math.min(20, total)} onClick={() => zoomBy(1.6)}>+</button>
        <button type="button" className={btn} aria-label="Zoom out" title="Zoom out (−)" disabled={zoomedOut} onClick={() => zoomBy(1 / 1.6)}>−</button>
        <button type="button" className={btn} aria-label="Reset view" title="Reset view (0)" onClick={resetView}>Reset</button>
        <button type="button" className={btn} data-testid="chart-fullscreen"
          aria-label={isFull ? "Exit full screen" : "Full screen"} title={isFull ? "Exit full screen (Esc)" : "Full screen (F)"}
          onClick={() => (isFull ? exitFull() : void enterFull())}>
          {isFull ? "Exit full screen" : "Full screen"}
        </button>
        <span className="ms-auto font-mono text-[11px] text-zinc-500" data-testid="chart-bars">{v.count} / {total} bars</span>
      </div>
      {menuOpen && (
        <fieldset className="mb-2 grid gap-2 rounded border border-zinc-700 p-2 text-sm text-zinc-200 sm:grid-cols-2">
          <legend>Chart indicators</legend>
          {LAYER_IDS.map((id) => {
            const average = id in DEFAULT_PERIODS ? id as Average : null;
            const period = average ? periods[average] : null;
            const enabled = !hidden.includes(id);
            const label = average ? (average === "sma-long" ? "SMA " : "EMA ") + period : LAYERS[id];
            return (
              <div key={id} className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={enabled} onChange={(event) => updateSettings({
                    ...settings,
                    hidden: event.target.checked ? hidden.filter((layer) => layer !== id) : [...hidden, id],
                  })} />
                  {label}
                </label>
                {average && (
                  <input key={period} type="number" min={1} step={1} defaultValue={period ?? undefined}
                    aria-label={LAYERS[average] + " period"}
                    className="w-24 rounded border border-zinc-600 bg-zinc-900 px-2 py-1"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                    }}
                    onBlur={(event) => {
                      const value = event.currentTarget.valueAsNumber;
                      if (validPeriod(value)) {
                        updateSettings({ ...settings, periods: { ...periods, [average]: value } });
                      } else {
                        event.currentTarget.value = String(periods[average]);
                      }
                    }} />
                )}
                {enabled && period !== null && period > klines.length && (
                  <span className="text-xs text-amber-300">Insufficient history</span>
                )}
              </div>
            );
          })}
          {(["fund-ribbon", "fund-panel"] as const).map((id) => (
            <div key={id} className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={optIns.has(id)} onChange={(event) => optIns.set(id, event.target.checked)} />
                {t(id === "fund-ribbon" ? "chart.fundRibbon" : "chart.fundPanel")}
              </label>
            </div>
          ))}
          <button type="button" className="justify-self-start rounded border border-zinc-600 px-2 py-1"
            onClick={() => { updateSettings(DEFAULT_SETTINGS); clearChartOptIn(); }}>Reset to defaults</button>
        </fieldset>
      )}
      <div ref={plotRef} className={isFull ? "min-h-0 flex-1" : undefined}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${viewW} ${viewH}`}
        className="w-full select-none"
        style={{
          aspectRatio: size ? undefined : `${viewW} / ${viewH}`,
          height: size ? viewH : undefined,
          touchAction: isFull ? "none" : "pan-y",
        }}
        role="img"
        tabIndex={0}
        aria-label={`Interactive candlestick chart with ${slice.length} of ${total} candles. Arrow keys inspect candles, Shift+arrows pan, plus and minus zoom, 0 resets, F toggles full screen.`}
        onKeyDown={(event) => {
          const k = event.key;
          if (k === "ArrowLeft" && event.shiftKey) { event.preventDefault(); setView(panView(v, total, -Math.max(1, Math.round(v.count / 10)))); }
          else if (k === "ArrowRight" && event.shiftKey) { event.preventDefault(); setView(panView(v, total, Math.max(1, Math.round(v.count / 10)))); }
          else if (k === "ArrowLeft") { event.preventDefault(); setHoverIdx(Math.max(0, activeIdx - 1)); }
          else if (k === "ArrowRight") { event.preventDefault(); setHoverIdx(Math.min(slice.length - 1, activeIdx + 1)); }
          else if (k === "Home") { event.preventDefault(); setHoverIdx(0); }
          else if (k === "End") { event.preventDefault(); setHoverIdx(slice.length - 1); }
          else if (k === "+" || k === "=") { event.preventDefault(); zoomBy(1.25); }
          else if (k === "-" || k === "_") { event.preventDefault(); zoomBy(0.8); }
          else if (k === "0") { event.preventDefault(); resetView(); }
          else if (k === "f" || k === "F") { event.preventDefault(); if (isFull) exitFull(); else void enterFull(); }
        }}
        onMouseLeave={() => { if (gesture.current.kind === "none") setHoverIdx(null); }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={(e) => { pointers.current.delete(e.pointerId); if (pointers.current.size === 0) gesture.current = { ...gesture.current, kind: "none" }; }}
        onDoubleClick={resetView}
      >
        {layers}
        {hover && (
          <g>
            <line x1={x(activeIdx)} y1={PAD_T} x2={x(activeIdx)} y2={plotBottom} stroke="var(--color-zinc-600)" strokeWidth={1} strokeDasharray="3 3" />
            <line x1={PAD_L} y1={y(hover.close)} x2={PAD_L + chartW} y2={y(hover.close)} stroke="var(--color-zinc-600)" strokeWidth={1} strokeDasharray="3 3" />
          </g>
        )}
      </svg>
      </div>
      {(showRibbon || showPanel) && fundTrendNote && <p className="mt-1 px-1 text-[10px] text-zinc-500" data-testid="fund-trend-note">{fundTrendNote}</p>}
      {showPanel && panelNote && <p className="mt-1 px-1 text-[10px] text-zinc-500" data-testid="fund-panel-note">{panelNote}</p>}

      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-[11px]">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {series.map((s, i) => (
            <span key={i} className="flex items-center gap-1.5 text-zinc-400">
              <span className="inline-block h-2 w-3 rounded-sm" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
          {showBollinger && <span className="flex items-center gap-1.5 text-zinc-400">
            <span className="inline-block h-2 w-3 rounded-sm border border-emerald-400/50 bg-emerald-400/10" />
            BB 20/2
          </span>}
          {showMacd && <span className="flex items-center gap-1.5 text-zinc-400">
            <span className="inline-block h-2 w-3 rounded-sm bg-emerald-400/70" />
            MACD hist
          </span>}
        </div>
        {hover && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-zinc-300" aria-live="polite" data-testid="chart-readout">
            <span className="text-zinc-500">{fmtTime(hover.time)}{perBar > 1 ? ` · ${perBar} bars per candle` : ""}</span>
            <span className="text-zinc-500">O</span><span>{formatPrice(hover.open)}</span>
            <span className="text-zinc-500">H</span><span className="text-emerald-400">{formatPrice(hover.high)}</span>
            <span className="text-zinc-500">L</span><span className="text-rose-400">{formatPrice(hover.low)}</span>
            <span className="text-zinc-500">C</span><span>{formatPrice(hover.close)}</span>
            <span className="text-zinc-500">V</span><span>{fmtVol(hover.volume)}</span>
            {showMacd && <><span className="text-zinc-500">H</span><span className={(histogram[activeIdx]?.histogram ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}>{fmtSigned(histogram[activeIdx]?.histogram)}</span></>}
          </div>
        )}
      </div>
      {!isFull && (
        <p className="mt-1 px-1 text-[10px] text-zinc-600">
          Tap or hover to inspect · pinch or Ctrl/⌘ + scroll to zoom · drag to pan · double-tap to reset · F for full screen.
        </p>
      )}
    </div>
  );
}

/* ---- tiny formatters ---- */
export function fmtAxis(p: number): string {
  const a = Math.abs(p);
  if (a >= 1000) return (p / 1000).toFixed(1) + "k";
  if (a >= 1) return p.toFixed(2);
  if (a >= 0.01) return p.toFixed(4);
  return p.toExponential(2);
}
export function fmtNum(p: number): string {
  if (p >= 1000) return p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(5);
  return p.toExponential(3);
}
function fmtSigned(v: number | undefined): string {
  if (v == null || isNaN(v)) return "--";
  const sign = v >= 0 ? "+" : "";
  if (Math.abs(v) >= 1) return sign + v.toFixed(4);
  if (Math.abs(v) >= 0.01) return sign + v.toFixed(5);
  return sign + v.toExponential(2);
}
function fmtVol(v: number): string {
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(2) + "K";
  return v.toFixed(2);
}
function fmtTime(t: number): string {
  const d = new Date(t);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}
