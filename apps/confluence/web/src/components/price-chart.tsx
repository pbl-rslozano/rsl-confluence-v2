"use client";

import { useMemo, useState } from "react";
import type { Kline } from "@/lib/indicators";
import { ema, macdHistogram, sma, rollingStdDev } from "@/lib/indicators";

/**
 * PriceChart — custom SVG candlestick chart with indicator overlays.
 *
 * Renders the last `visible` candles as candlesticks, with:
 *   • SMA(200)  — blue-grey line
 *   • EMA(20)   — amber line
 *   • EMA(50)  — violet line
 *   • Bollinger Bands(20,2) — faint emerald area + edges
 *   • VWAP     — dashed cyan line
 *   • Volume bars below (coloured by candle direction)
 *
 * Includes a hover crosshair with an OHLCV tooltip. Built with raw SVG so it
 * stays dependency-free and crisp at any DPR.
 */

const VIEW_W = 760; // logical viewBox width
const PRICE_H = 360; // price panel height
const HIST_H = 86; // MACD histogram panel height
const VOL_H = 78; // volume panel height
const PAD_L = 8;
const PAD_R = 64; // room for price axis labels
const PAD_T = 12;
const PAD_B = 24; // room for time axis labels
const CHART_W = VIEW_W - PAD_L - PAD_R;

interface Props {
  klines: Kline[];
  visible?: number;
}

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

interface Series {
  id: Layer;
  values: number[];
  color: string;
  label: string;
  dashed?: boolean;
}

export function PriceChart({ klines, visible = 60 }: Props) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const [settings, setSettings] = useState(readSettings);
  const [menuOpen, setMenuOpen] = useState(false);
  const { hidden, periods } = settings;
  const showBollinger = !hidden.includes("bollinger");
  const showMacd = !hidden.includes("macd");
  const showVolume = !hidden.includes("volume");

  function updateSettings(next: ChartSettings) {
    setSettings(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // The controls still work for this chart if browser storage is unavailable.
    }
  }

  const model = useMemo(() => {
    const slice = klines.slice(-visible);
    if (slice.length < 2) return null;
    const closes = slice.map((c) => c.close);
    const allCloses = klines.map((c) => c.close);
    const mid = sma(closes, 20);
    const sd = rollingStdDev(closes, 20);
    const bbUpper = mid.map((m, i) => m + 2 * sd[i]);
    const bbLower = mid.map((m, i) => m - 2 * sd[i]);
    // VWAP across the visible window (intraday reset analogue).
    let cumPV = 0,
      cumV = 0;
    const vwap: number[] = [];
    for (const c of slice) {
      const tp = (c.high + c.low + c.close) / 3;
      cumPV += tp * c.volume;
      cumV += c.volume;
      vwap.push(cumV === 0 ? c.close : cumPV / cumV);
    }

    const series: Series[] = [];
    for (const [id, color] of [
      ["ema-fast", "#f59e0b"], ["ema-slow", "#a78bfa"], ["sma-long", "#94a3b8"],
    ] as const) {
      const period = periods[id];
      if (hidden.includes(id) || period > klines.length) continue;
      const isSma = id === "sma-long";
      const values = (isSma ? sma : ema)(allCloses, period).slice(-visible);
      series.push({ id, values, color, label: `${isSma ? "SMA" : "EMA"} ${period}` });
    }
    if (!hidden.includes("vwap")) {
      series.push({ id: "vwap", values: vwap, color: "#22d3ee", label: "VWAP", dashed: true });
    }

    // Scale to the candles and visible price overlays.
    let lo = Infinity,
      hi = -Infinity;
    for (const c of slice) {
      if (c.low < lo) lo = c.low;
      if (c.high > hi) hi = c.high;
    }
    for (const v of [...(showBollinger ? [...bbUpper, ...bbLower] : []), ...series.flatMap((s) => s.values)]) {
      if (!isNaN(v)) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    const pad = (hi - lo) * 0.06 || hi * 0.06;
    lo -= pad;
    hi += pad;
    const y = (price: number) =>
      PAD_T + (1 - (price - lo) / (hi - lo)) * PRICE_H;

    // X scale — each candle gets an equal slot.
    const step = CHART_W / slice.length;
    const x = (i: number) => PAD_L + i * step + step / 2;
    const bodyW = Math.max(1.5, step * 0.62);

    // MACD histogram scale.
    const histogram = macdHistogram(klines).slice(-visible);
    const histTop = PAD_T + PRICE_H;
    const histZero = histTop + HIST_H / 2;
    const maxHist = Math.max(...histogram.map((p) => Math.abs(p.histogram)).filter((v) => !isNaN(v)), 1e-9);
    const histY = (v: number) => histZero - (v / maxHist) * (HIST_H * 0.42);

    // Volume scale.
    const maxVol = Math.max(...slice.map((c) => c.volume), 1);
    const volTop = histTop + (showMacd ? HIST_H : 0);
    const volY = (v: number) =>
      volTop + VOL_H - (v / maxVol) * (VOL_H - 8);

    // Price axis ticks (5 lines).
    const ticks: { y: number; label: string }[] = [];
    for (let i = 0; i <= 4; i++) {
      const price = lo + ((hi - lo) * i) / 4;
      ticks.push({ y: y(price), label: fmtAxis(price) });
    }

    // Time axis ticks (5 evenly spaced).
    const timeTicks: { x: number; label: string }[] = [];
    for (let i = 0; i < 5; i++) {
      const idx = Math.floor((i / 4) * (slice.length - 1));
      timeTicks.push({ x: x(idx), label: fmtTime(slice[idx].time) });
    }



    return {
      slice,
      x,
      y,
      bodyW,
      step,
      bbUpper,
      bbLower,
      histogram,
      histTop,
      histZero,
      histY,
      volY,
      volTop,
      ticks,
      timeTicks,
      series,
      lo,
      hi,
      maxVol,
    };
  }, [klines, visible, hidden, periods, showBollinger, showMacd]);

  if (!model) {
    return (
      <div className="flex h-48 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950/50 text-sm text-zinc-500">
        Not enough candle data to render chart
      </div>
    );
  }

  const { slice, x, y, bodyW, step, bbUpper, bbLower, histogram, histTop, histZero, histY, volY, volTop, ticks, timeTicks, series } = model;
  const plotBottom = volTop + (showVolume ? VOL_H : 0);
  const VIEW_H = plotBottom + PAD_B;

  // Build the Bollinger band area path (upper forward, lower reversed).
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

  const activeIdx = hoverIdx ?? slice.length - 1;
  const hover = slice[activeIdx];

  return (
    <div data-testid="price-chart" className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2">
      <button type="button" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}
        className="mb-2 rounded border border-zinc-600 px-3 py-1 text-sm text-zinc-200">
        Indicators
      </button>
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
          <button type="button" className="justify-self-start rounded border border-zinc-600 px-2 py-1"
            onClick={() => updateSettings(DEFAULT_SETTINGS)}>Reset to defaults</button>
        </fieldset>
      )}
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="w-full"
        style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}` }}
        role="img"
        tabIndex={0}
        aria-label={`Interactive candlestick chart with ${slice.length} candles. Use left and right arrow keys to inspect candles.`}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") { event.preventDefault(); setHoverIdx(Math.max(0, activeIdx - 1)); }
          else if (event.key === "ArrowRight") { event.preventDefault(); setHoverIdx(Math.min(slice.length - 1, activeIdx + 1)); }
          else if (event.key === "Home") { event.preventDefault(); setHoverIdx(0); }
          else if (event.key === "End") { event.preventDefault(); setHoverIdx(slice.length - 1); }
        }}
        onMouseLeave={() => setHoverIdx(null)}
        onPointerMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const relX = ((e.clientX - rect.left) / rect.width) * VIEW_W;
          const idx = Math.floor((relX - PAD_L) / step);
          if (idx >= 0 && idx < slice.length) setHoverIdx(idx);
          else setHoverIdx(null);
        }}
      >
        {/* gridlines */}
        {ticks.map((t, i) => (
          <g key={`g${i}`}>
            <line x1={PAD_L} y1={t.y} x2={PAD_L + CHART_W} y2={t.y} stroke="var(--color-zinc-800)" strokeWidth={1} />
            <text x={VIEW_W - PAD_R + 6} y={t.y + 3} fill="var(--color-zinc-500)" fontSize={10} fontFamily="ui-monospace, monospace">
              {t.label}
            </text>
          </g>
        ))}

        {/* Bollinger band area */}
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

        {/* overlay series */}
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
        <line x1={PAD_L} y1={histTop} x2={PAD_L + CHART_W} y2={histTop} stroke="var(--color-zinc-700)" strokeWidth={1} />
        <line x1={PAD_L} y1={histZero} x2={PAD_L + CHART_W} y2={histZero} stroke="var(--color-zinc-800)" strokeWidth={1} strokeDasharray="3 3" />
        <text x={PAD_L + 4} y={histTop + 12} fill="var(--color-zinc-500)" fontSize={10} fontFamily="ui-monospace, monospace">
          MACD histogram
        </text>
        {histogram.map((p, i) => {
          if (isNaN(p.histogram)) return null;
          const top = Math.min(histZero, histY(p.histogram));
          const h = Math.abs(histY(p.histogram) - histZero);
          return (
            <rect
              key={`h${i}`}
              x={x(i) - bodyW / 2}
              y={top}
              width={bodyW}
              height={Math.max(0.5, h)}
              fill={p.histogram >= 0 ? "#34d399" : "#fb7185"}
              opacity={hoverIdx === i ? 0.9 : 0.55}
            />
          );
        })}

        </g>}
        {showVolume && <g data-indicator="volume">
        {slice.map((c, i) => {
          const h = (volTop + VOL_H) - volY(c.volume);
          const up = c.close >= c.open;
          return (
            <rect
              key={`v${i}`}
              x={x(i) - bodyW / 2}
              y={volY(c.volume)}
              width={bodyW}
              height={Math.max(0.5, h)}
              fill={up ? "#34d399" : "#fb7185"}
              opacity={0.35}
            />
          );
        })}
        {/* divider between price and volume */}
        <line x1={PAD_L} y1={volTop} x2={PAD_L + CHART_W} y2={volTop} stroke="var(--color-zinc-700)" strokeWidth={1} />
        <text x={PAD_L + 4} y={volTop + 12} fill="var(--color-zinc-500)" fontSize={10} fontFamily="ui-monospace, monospace">
          Volume
        </text>

        </g>}
        <g data-testid="price-candles">
        {slice.map((c, i) => {
          const up = c.close >= c.open;
          const color = up ? "#34d399" : "#fb7185";
          const wickX = x(i);
          const bodyTop = y(Math.max(c.open, c.close));
          const bodyBot = y(Math.min(c.open, c.close));
          const bodyH = Math.max(1, bodyBot - bodyTop);
          return (
            <g key={`c${i}`}>
              <line x1={wickX} y1={y(c.high)} x2={wickX} y2={y(c.low)} stroke={color} strokeWidth={1} />
              <rect
                x={wickX - bodyW / 2}
                y={bodyTop}
                width={bodyW}
                height={bodyH}
                fill={color}
                opacity={hoverIdx === i ? 1 : 0.85}
              />
            </g>
          );
        })}

        </g>
        {/* time axis */}
        {timeTicks.map((t, i) => (
          <text key={`t${i}`} x={t.x} y={VIEW_H - 6} fill="var(--color-zinc-500)" fontSize={10} fontFamily="ui-monospace, monospace" textAnchor="middle">
            {t.label}
          </text>
        ))}

        {/* hover crosshair + tooltip */}
        {hover && (
          <g>
            <line x1={x(activeIdx)} y1={PAD_T} x2={x(activeIdx)} y2={plotBottom} stroke="var(--color-zinc-600)" strokeWidth={1} strokeDasharray="3 3" />
            <line x1={PAD_L} y1={y(hover.close)} x2={PAD_L + CHART_W} y2={y(hover.close)} stroke="var(--color-zinc-600)" strokeWidth={1} strokeDasharray="3 3" />
          </g>
        )}
      </svg>

      {/* legend + hover OHLCV readout */}
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
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-zinc-300" aria-live="polite">
            <span className="text-zinc-500">{fmtTime(hover.time)}</span>
            <span className="text-zinc-500">O</span><span>{fmtNum(hover.open)}</span>
            <span className="text-zinc-500">H</span><span className="text-emerald-400">{fmtNum(hover.high)}</span>
            <span className="text-zinc-500">L</span><span className="text-rose-400">{fmtNum(hover.low)}</span>
            <span className="text-zinc-500">C</span><span>{fmtNum(hover.close)}</span>
            <span className="text-zinc-500">V</span><span>{fmtVol(hover.volume)}</span>
            {showMacd && <><span className="text-zinc-500">H</span><span className={(histogram[activeIdx]?.histogram ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}>{fmtSigned(histogram[activeIdx]?.histogram)}</span></>}
          </div>
      </div>
      <p className="mt-1 px-1 text-[10px] text-zinc-600">Hover, tap, or focus the chart and use arrow keys to inspect OHLCV candles.</p>
    </div>
  );
}

/* ---- tiny formatters ---- */
function fmtAxis(p: number): string {
  if (p >= 1000) return (p / 1000).toFixed(1) + "k";
  if (p >= 1) return p.toFixed(2);
  if (p >= 0.01) return p.toFixed(4);
  return p.toExponential(2);
}
function fmtNum(p: number): string {
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



