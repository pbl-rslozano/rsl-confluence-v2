/**
 * indicators.ts
 * ----------------------------------------------------------------------------
 * Pure-function implementations of the 21 indicators (18 voting, 3
 * informational) used by the
 * Confluence Engine.
 *
 * IMPORTANT — Build 1.9 semantics (still in force in Build 2.02):
 *
 *  1. Every function receives an array of OHLCV klines whose FINAL ELEMENT IS A
 *     CLOSED CANDLE. The data layer (`market-client.ts`) drops the in-progress
 *     bar before these functions ever see it. Prior builds computed on the
 *     forming bar, which caused every threshold-crossing indicator to repaint
 *     within the bar.
 *
 *  2. Validity is a TYPED FIELD (`valid` + `value`), not a regex over the
 *     display string. A formatting change can no longer silently disable the
 *     data-quality gate.
 *
 *  3. Indicators are grouped into BLOCS. The confluence score is the mean of
 *     bloc scores, not a headcount of 20 correlated votes. Seven trend
 *     followers on one close series are one piece of evidence repeated seven
 *     times, and scoring them as seven overstates agreement.
 *
 *  4. ATR and Std Dev are INFORMATIONAL. Both are non-directional by
 *     construction; deriving a direction from them (as prior builds did) just
 *     produced duplicate momentum votes wearing volatility labels. They now act
 *     as a regime filter instead.
 * ----------------------------------------------------------------------------
 */

import { normalizeScoringProfile, type ScoringProfile, type VotingIndicatorId } from "./scoring-profile";
import { detectFVG, fvgModifier, type FvgOptions, type FvgZone } from "./fvg";

/** Engine input is closed-bar only, so the newest element must be kept. */
const FVG_ENGINE_OPTS: FvgOptions = { lastBarClosed: true };

export type SignalState = "BULLISH" | "BEARISH" | "NEUTRAL";

export type BlocName = "trend" | "meanReversion" | "breakout" | "flow" | "volatility";

export interface Kline {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** v2.3: taker-buy base volume when the venue reports it (Binance spot). Never scored. */
  takerBuy?: number;
}

export interface IndicatorResult {
  name: string;
  category: string;
  bloc: BlocName;
  state: SignalState;
  /** Human-readable value / reason. Never used for validity decisions. */
  detail: string;
  /** Primary numeric output. `null` means the indicator could not be computed. */
  value: number | null;
  /** Explicitly set by each indicator. False excludes it from scoring. */
  valid: boolean;
  /** True for indicators that are displayed but deliberately do not vote. */
  informational?: boolean;
  qualityNote?: string;
}

export interface MacdHistogramPoint {
  time: number;
  macd: number;
  signal: number;
  histogram: number;
}

export interface IndicatorContext {
  /** Bar length in ms — required for session anchoring (VWAP). */
  intervalMs: number;
}

const DAY_MS = 86_400_000;
const DEFAULT_CONTEXT: IndicatorContext = { intervalMs: 15 * 60_000 };

/* ========================================================================== *
 *  Tuning constants — every threshold is named, with a stated rationale.
 * ========================================================================== */

/**
 * Minimum share of voting indicators that must be valid before a score is
 * published. Rationale: the denominator is `validCount`, so a thin series can
 * produce an extreme score from very little evidence (4 bull / 1 bear over 5
 * valid indicators renders identically to 15 net votes over 20). 70% of the
 * voting panel is the floor at which the bloc structure still has at least one
 * member in every bloc.
 */
export const MIN_VALID_VOTING_SHARE = 0.7;

/**
 * Dead zone around zero. Below this the engine reports NEUTRAL rather than a
 * weak direction.
 *
 * Build 2.02 — calibrated against a NULL, not chosen by eye. Build 2.01 used 25,
 * which sat below the MEDIAN |score| of a driftless random walk: 63% of pure
 * noise bars were labelled BUY/SELL and 14% STRONG. The values below come from
 * `npm run calibrate` (src/lib/null-calibration.mjs: Gaussian and Student-t(3)
 * random walks at 0.3%/1%/3% bar volatility, 200- and 1,000-bar windows),
 * measured with the efficiency-ratio regime gate in place:
 *
 *   noise |score|  p90 = 47   p95 = 54   p99 = 72
 *
 * NEUTRAL_BAND = 55 → about 5% of noise bars receive a direction.
 * STRONG_BAND  = 70 → about 1.3% of noise bars are STRONG.
 *
 * At that same 5% false-positive rate the gated engine labels 19–70% of bars on
 * synthetic drifting series (per-bar Sharpe 0.2–0.5), versus 11–16% without
 * the gate. The regression suite asserts the noise rates, so a change that
 * inflates scores on noise fails the build. Re-run the calibration after any
 * change to the indicator panel or bloc weights.
 */
export const NEUTRAL_BAND = 55;

/** |score| at or above this is STRONG; at or above NEUTRAL_BAND is MODERATE. */
export const STRONG_BAND = 70;

/**
 * ATR percentile below which the market is treated as compressed and signal
 * strength is capped. Rationale: breakout and trend indicators generate their
 * highest false-positive rates in low-volatility drift, where the move is
 * smaller than the round-trip cost of acting on it.
 */
export const LOW_VOLATILITY_PERCENTILE = 0.10;

/**
 * Trend/mean-reversion regime gate (Build 2.02).
 *
 * Contrarian oscillators (RSI, Stochastic, %R, MFI) sit at "overbought" for the
 * whole of a clean uptrend, so in 2.01 the mean-reversion bloc voted against
 * every strong trend and pulled it toward NEUTRAL. In crypto the published
 * cross-sectional evidence reads these oscillators as CONTINUATION signals
 * (Fieberg et al., JFQA — see the research report), so their contrarian vote is
 * least credible exactly when a trend is strongest.
 *
 * The mean-reversion bloc's weight is therefore scaled by (1 − g), where g is
 * a soft gate on Kaufman's EFFICIENCY RATIO over ER_PERIOD bars:
 *
 *   ER = |close_t − close_{t−n}| / Σ|close_i − close_{i−1}|      (0 … 1)
 *   g  = clamp((ER − ER_GATE_LOW) / (ER_GATE_HIGH − ER_GATE_LOW), 0, 1)
 *
 * ER measures how directly price travelled, not how far, so it separates a
 * persistent trend (ER → 1) from a random walk's chance drift (ER ≈ 0.2).
 * ADX was tried first and rejected: random walks routinely push ADX above 30,
 * which removed the only counterweight to the collinear trend/flow blocs and
 * let pure noise reach |score| = 100. All other blocs keep weight 1; this is a
 * soft gate, not a learned weight.
 */
export const ER_PERIOD = 40;
export const ER_GATE_LOW = 0.30;
export const ER_GATE_HIGH = 0.60;

/** Kaufman efficiency ratio of the last `period` closes (null if unavailable). */
export function efficiencyRatio(k: Kline[], period = ER_PERIOD): number | null {
  const n = k.length;
  if (n < period + 1) return null;
  let path = 0;
  for (let i = n - period; i < n; i++) path += Math.abs(k[i].close - k[i - 1].close);
  const net = Math.abs(k[n - 1].close - k[n - 1 - period].close);
  if (!fin(path) || !fin(net)) return null;
  return path === 0 ? 0 : net / path;
}

/* ========================================================================== *
 *  Primitive helpers
 * ========================================================================== */

/** Simple Moving Average — unweighted mean of the last `period` values. */
export function sma(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  let sum = 0;
  let valid = 0;
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i])) {
      sum += values[i];
      valid++;
    }
    if (i >= period && Number.isFinite(values[i - period])) {
      sum -= values[i - period];
      valid--;
    }
    if (i >= period - 1 && valid === period) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential Moving Average.
 * Seeded with the SMA of the first `period` values, then recursively smoothed:
 *   EMA_t = price_t * k + EMA_{t-1} * (1 - k),  where k = 2 / (period + 1)
 */
export function ema(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  seed /= period;
  out[period - 1] = seed;
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

/** Population standard deviation over a rolling window of `period`. */
export function rollingStdDev(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    const mean = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (values[j] - mean) ** 2;
    out[i] = Math.sqrt(variance / period);
  }
  return out;
}

/** True Range — the greatest of (H-L), |H-prevC|, |L-prevC|. */
function trueRange(k: Kline[], i: number): number {
  if (i === 0) return k[i].high - k[i].low;
  return Math.max(
    k[i].high - k[i].low,
    Math.abs(k[i].high - k[i - 1].close),
    Math.abs(k[i].low - k[i - 1].close),
  );
}

/** Wilder's smoothed ATR (RMA / running moving average). */
export function atr(k: Kline[], period = 14): number[] {
  const n = k.length;
  const out: number[] = new Array(n).fill(NaN);
  if (n < period + 1) return out;
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trueRange(k, i);
  out[period] = sum / period; // seed = simple average of first `period` TRs
  for (let i = period + 1; i < n; i++) {
    // Wilder recursion: ATR_t = (ATR_{t-1}*(p-1) + TR_t) / p
    out[i] = (out[i - 1] * (period - 1) + trueRange(k, i)) / period;
  }
  return out;
}

const last = <T,>(a: T[]): T => a[a.length - 1];
const prev = <T,>(a: T[]): T => a[a.length - 2];
const fin = (v: number | undefined): boolean => typeof v === "number" && Number.isFinite(v);

/** Build an "insufficient data" result without repeating the shape everywhere. */
function unavailable(
  name: string,
  category: string,
  bloc: BlocName,
  note = "Excluded: insufficient or invalid input data.",
): IndicatorResult {
  return {
    name,
    category,
    bloc,
    state: "NEUTRAL",
    detail: "—",
    value: null,
    valid: false,
    qualityNote: note,
  };
}

export function macdHistogram(k: Kline[]): MacdHistogramPoint[] {
  const closes = k.map((c) => c.close);
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const macdLine = closes.map((_, i) => e12[i] - e26[i]);
  const validStart = 25;
  const sigSlice = ema(macdLine.slice(validStart), 9);
  const signalLine: number[] = new Array(closes.length).fill(NaN);
  for (let i = 0; i < sigSlice.length; i++) signalLine[validStart + i] = sigSlice[i];

  return k.map((c, i) => ({
    time: c.time,
    macd: macdLine[i],
    signal: signalLine[i],
    histogram: macdLine[i] - signalLine[i],
  }));
}

/* ========================================================================== *
 *  TREND BLOC  (1–7)
 * ========================================================================== */

/** 1. SMA — 20 vs 50 period crossover. Bullish when SMA(20) > SMA(50). */
export function indSMA(k: Kline[]): IndicatorResult {
  const closes = k.map((c) => c.close);
  const a = last(sma(closes, 20));
  const b = last(sma(closes, 50));
  if (!fin(a) || !fin(b)) return unavailable("SMA 20/50", "Trend", "trend");
  return {
    name: "SMA 20/50",
    category: "Trend",
    bloc: "trend",
    state: a > b ? "BULLISH" : a < b ? "BEARISH" : "NEUTRAL",
    detail: `20=${a.toFixed(4)} · 50=${b.toFixed(4)}`,
    value: a - b,
    valid: true,
  };
}

/** 2. EMA — 9 vs 21 period crossover. */
export function indEMA(k: Kline[]): IndicatorResult {
  const closes = k.map((c) => c.close);
  const a = last(ema(closes, 9));
  const b = last(ema(closes, 21));
  if (!fin(a) || !fin(b)) return unavailable("EMA 9/21", "Trend", "trend");
  return {
    name: "EMA 9/21",
    category: "Trend",
    bloc: "trend",
    state: a > b ? "BULLISH" : a < b ? "BEARISH" : "NEUTRAL",
    detail: `9=${a.toFixed(4)} · 21=${b.toFixed(4)}`,
    value: a - b,
    valid: true,
  };
}

/**
 * 3. MACD (12, 26, 9).
 *   MACD line = EMA(12) − EMA(26); Signal = EMA(9) of MACD; Hist = MACD − Signal
 * Bullish when MACD > Signal AND the histogram is expanding.
 */
export function indMACD(k: Kline[]): IndicatorResult {
  const closes = k.map((c) => c.close);
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const macdLine = closes.map((_, i) => e12[i] - e26[i]);
  const validStart = 25;
  const sigSlice = ema(macdLine.slice(validStart), 9);
  const signalLine: number[] = new Array(closes.length).fill(NaN);
  for (let i = 0; i < sigSlice.length; i++) signalLine[validStart + i] = sigSlice[i];

  const m = last(macdLine);
  const s = last(signalLine);
  const mPrev = prev(macdLine);
  const sPrev = prev(signalLine);
  if (!fin(m) || !fin(s) || !fin(mPrev) || !fin(sPrev)) {
    return unavailable("MACD 12/26/9", "Trend", "trend");
  }
  const hist = m - s;
  const histPrev = mPrev - sPrev;
  let state: SignalState = "NEUTRAL";
  if (m > s && hist > histPrev) state = "BULLISH";
  else if (m < s && hist < histPrev) state = "BEARISH";
  return {
    name: "MACD 12/26/9",
    category: "Trend",
    bloc: "trend",
    state,
    detail: `MACD=${m.toFixed(4)} · Sig=${s.toFixed(4)} · Hist=${hist.toFixed(4)}`,
    value: hist,
    valid: true,
  };
}

/**
 * 4. ADX (14) — trend strength + directional movement.
 * Signal only counted when ADX > 25 (meaningful trend); direction = +DI vs −DI.
 */
export function indADX(k: Kline[]): IndicatorResult {
  const n = k.length;
  const period = 14;
  const plusDM: number[] = new Array(n).fill(0);
  const minusDM: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = k[i].high - k[i - 1].high;
    const down = k[i - 1].low - k[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const atrArr = atr(k, period);
  const plusDI: number[] = new Array(n).fill(NaN);
  const minusDI: number[] = new Array(n).fill(NaN);
  const dx: number[] = new Array(n).fill(NaN);
  if (n > period) {
    let pSum = 0;
    let mSum = 0;
    for (let i = 1; i <= period; i++) {
      pSum += plusDM[i];
      mSum += minusDM[i];
    }
    let pSmooth = pSum;
    let mSmooth = mSum;
    for (let i = period; i < n; i++) {
      if (i > period) {
        pSmooth = pSmooth - pSmooth / period + plusDM[i];
        mSmooth = mSmooth - mSmooth / period + minusDM[i];
      }
      const a = atrArr[i];
      if (fin(a) && a > 0) {
        plusDI[i] = (100 * (pSmooth / period)) / a;
        minusDI[i] = (100 * (mSmooth / period)) / a;
        const denom = plusDI[i] + minusDI[i];
        dx[i] = denom > 0 ? (100 * Math.abs(plusDI[i] - minusDI[i])) / denom : 0;
      }
    }
  }
  const adxArr: number[] = new Array(n).fill(NaN);
  if (n > 2 * period) {
    let dxSum = 0;
    let counted = 0;
    for (let i = period; i < 2 * period; i++) {
      if (fin(dx[i])) {
        dxSum += dx[i];
        counted++;
      }
    }
    if (counted === period) {
      adxArr[2 * period - 1] = dxSum / period;
      for (let i = 2 * period; i < n; i++) {
        if (fin(adxArr[i - 1]) && fin(dx[i])) {
          adxArr[i] = (adxArr[i - 1] * (period - 1) + dx[i]) / period;
        }
      }
    }
  }
  const a = last(adxArr);
  const pdi = last(plusDI);
  const mdi = last(minusDI);
  if (!fin(a) || !fin(pdi) || !fin(mdi)) return unavailable("ADX 14", "Trend", "trend");
  let state: SignalState = "NEUTRAL";
  if (a > 25) {
    if (pdi > mdi) state = "BULLISH";
    else if (mdi > pdi) state = "BEARISH";
  }
  return {
    name: "ADX 14",
    category: "Trend",
    bloc: "trend",
    state,
    detail: `ADX=${a.toFixed(2)} · +DI=${pdi.toFixed(2)} · −DI=${mdi.toFixed(2)}`,
    value: a,
    valid: true,
  };
}

/** 5. Parabolic SAR (0.02, 0.2). */
export function indPSAR(k: Kline[]): IndicatorResult {
  const n = k.length;
  if (n < 5) return unavailable("Parabolic SAR", "Trend", "trend");
  let isBull = true;
  let af = 0.02;
  let ep = k[0].high;
  let s = k[0].low;
  for (let i = 1; i < n; i++) {
    s = s + af * (ep - s);
    if (isBull) {
      if (k[i].low < s) {
        isBull = false;
        s = ep;
        ep = k[i].low;
        af = 0.02;
      } else if (k[i].high > ep) {
        ep = k[i].high;
        af = Math.min(af + 0.02, 0.2);
      }
    } else if (k[i].high > s) {
      isBull = true;
      s = ep;
      ep = k[i].high;
      af = 0.02;
    } else if (k[i].low < ep) {
      ep = k[i].low;
      af = Math.min(af + 0.02, 0.2);
    }
  }
  const cur = last(k).close;
  if (!fin(s)) return unavailable("Parabolic SAR", "Trend", "trend");
  return {
    name: "Parabolic SAR",
    category: "Trend",
    bloc: "trend",
    state: cur > s ? "BULLISH" : cur < s ? "BEARISH" : "NEUTRAL",
    detail: `SAR=${s.toExponential(2)} · ${isBull ? "dot below" : "dot above"}`,
    value: cur - s,
    valid: true,
  };
}

/**
 * 6. Ichimoku Cloud (Kumo) — with correct forward displacement.
 *
 * SpanA and SpanB are plotted 26 periods AHEAD of the bar they are computed
 * from. Prior builds compared price to the spans computed on the current bar,
 * which is a midpoint channel, not the Ichimoku cloud. We therefore compare
 * the current close against the spans computed 26 bars ago.
 */
export function indIchimoku(k: Kline[]): IndicatorResult {
  const n = k.length;
  const displacement = 26;
  const highs = k.map((c) => c.high);
  const lows = k.map((c) => c.low);
  const periodHigh = (p: number, i: number) => Math.max(...highs.slice(Math.max(0, i - p + 1), i + 1));
  const periodLow = (p: number, i: number) => Math.min(...lows.slice(Math.max(0, i - p + 1), i + 1));

  const srcIndex = n - 1 - displacement;
  if (srcIndex < 51) return unavailable("Ichimoku Cloud", "Trend", "trend");

  const tenkan = (periodHigh(9, srcIndex) + periodLow(9, srcIndex)) / 2;
  const kijun = (periodHigh(26, srcIndex) + periodLow(26, srcIndex)) / 2;
  const spanA = (tenkan + kijun) / 2;
  const spanB = (periodHigh(52, srcIndex) + periodLow(52, srcIndex)) / 2;
  if (!fin(spanA) || !fin(spanB)) return unavailable("Ichimoku Cloud", "Trend", "trend");

  const cur = last(k).close;
  const top = Math.max(spanA, spanB);
  const bot = Math.min(spanA, spanB);
  return {
    name: "Ichimoku Cloud",
    category: "Trend",
    bloc: "trend",
    state: cur > top ? "BULLISH" : cur < bot ? "BEARISH" : "NEUTRAL",
    detail: `SpanA=${spanA.toFixed(4)} · SpanB=${spanB.toFixed(4)} (displaced ${displacement})`,
    value: cur - (top + bot) / 2,
    valid: true,
  };
}

/**
 * 7. Supertrend (ATR 10, multiplier 3).
 * Direction is seeded from the first resolvable bar rather than assumed
 * bullish, so a series that never triggers a flip no longer reads bullish by
 * default.
 */
export function indSupertrend(k: Kline[]): IndicatorResult {
  const n = k.length;
  const period = 10;
  const mult = 3;
  const atrArr = atr(k, period);
  const upper: number[] = new Array(n).fill(NaN);
  const lower: number[] = new Array(n).fill(NaN);
  const st: number[] = new Array(n).fill(NaN);
  let dir = 0; // 0 = unseeded, 1 = bull, -1 = bear
  for (let i = 0; i < n; i++) {
    if (!fin(atrArr[i])) continue;
    const basis = (k[i].high + k[i].low) / 2;
    const ub = basis + mult * atrArr[i];
    const lb = basis - mult * atrArr[i];
    upper[i] = i > 0 && fin(upper[i - 1]) ? (ub < upper[i - 1] || k[i - 1].close > upper[i - 1] ? ub : upper[i - 1]) : ub;
    lower[i] = i > 0 && fin(lower[i - 1]) ? (lb > lower[i - 1] || k[i - 1].close < lower[i - 1] ? lb : lower[i - 1]) : lb;
    if (dir === 0) dir = k[i].close >= basis ? 1 : -1; // seed from price, not assumption
    else if (dir === 1 && k[i].close < lower[i]) dir = -1;
    else if (dir === -1 && k[i].close > upper[i]) dir = 1;
    st[i] = dir === 1 ? lower[i] : upper[i];
  }
  const val = last(st);
  if (!fin(val) || dir === 0) return unavailable("Supertrend 10/3", "Trend", "trend");
  const cur = last(k).close;
  return {
    name: "Supertrend 10/3",
    category: "Trend",
    bloc: "trend",
    state: cur > val ? "BULLISH" : "BEARISH",
    detail: `ST=${val.toExponential(2)} · ${dir === 1 ? "uptrend" : "downtrend"}`,
    value: cur - val,
    valid: true,
  };
}

/* ========================================================================== *
 *  MEAN-REVERSION BLOC  (8–13, minus breakout members)
 * ========================================================================== */

/** 8. RSI (14) — Wilder's smoothing. >70 overbought, <30 oversold. */
export function indRSI(k: Kline[]): IndicatorResult {
  const closes = k.map((c) => c.close);
  const period = 14;
  if (closes.length < period + 1) return unavailable("RSI 14", "Momentum", "meanReversion");
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  // Build 2.02: with no gains AND no losses RSI is undefined; report the
  // midpoint (50 → NEUTRAL) instead of 100, which used to cast a BEARISH vote
  // on every flat or pegged series.
  const rsiOf = (g: number, l: number) => (g === 0 && l === 0 ? 50 : l === 0 ? 100 : 100 - 100 / (1 + g / l));
  let r = rsiOf(avgG, avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + (ch >= 0 ? ch : 0)) / period;
    avgL = (avgL * (period - 1) + (ch < 0 ? -ch : 0)) / period;
    r = rsiOf(avgG, avgL);
  }
  if (!fin(r)) return unavailable("RSI 14", "Momentum", "meanReversion");
  return {
    name: "RSI 14",
    category: "Momentum",
    bloc: "meanReversion",
    state: r >= 70 ? "BEARISH" : r <= 30 ? "BULLISH" : "NEUTRAL",
    detail: `RSI=${r.toFixed(2)}`,
    value: r,
    valid: true,
  };
}

/** 9. Stochastic (14, 3). */
export function indStoch(k: Kline[]): IndicatorResult {
  const n = k.length;
  const period = 14;
  if (n < period + 3) return unavailable("Stochastic 14/3", "Momentum", "meanReversion");
  const pk: number[] = new Array(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (k[j].high > hh) hh = k[j].high;
      if (k[j].low < ll) ll = k[j].low;
    }
    pk[i] = hh === ll ? 50 : (100 * (k[i].close - ll)) / (hh - ll);
  }
  const pd = sma(pk, 3);
  const kv = last(pk);
  const dv = last(pd);
  const kvPrev = pk[n - 2];
  const dvPrev = pd[n - 2];
  if (!fin(kv) || !fin(dv) || !fin(kvPrev) || !fin(dvPrev)) {
    return unavailable("Stochastic 14/3", "Momentum", "meanReversion");
  }
  // Zone reading. (Build 2.02 removed the %K/%D crossover branches: they were
  // unreachable because the zone fallbacks produced the same states.)
  const state: SignalState = kv < 20 ? "BULLISH" : kv > 80 ? "BEARISH" : "NEUTRAL";
  return {
    name: "Stochastic 14/3",
    category: "Momentum",
    bloc: "meanReversion",
    state,
    detail: `%K=${kv.toFixed(2)} · %D=${dv.toFixed(2)}`,
    value: kv,
    valid: true,
  };
}

/**
 * 10. CCI (20) — read in the trend direction (> +100 bullish, < −100 bearish).
 *
 * Build 2.02: CCI moved from the mean-reversion bloc to the TREND bloc. Its
 * reading has always been trend-direction, so inside the contrarian bloc it
 * voted against RSI/Stochastic/%R/MFI by construction — the same philosophy
 * conflict Build 1.8 set out to remove.
 */
export function indCCI(k: Kline[]): IndicatorResult {
  const tp = k.map((c) => (c.high + c.low + c.close) / 3);
  const period = 20;
  if (tp.length < period) return unavailable("CCI 20", "Momentum", "trend");
  const smaTp = sma(tp, period);
  const i = tp.length - 1;
  if (!fin(smaTp[i])) return unavailable("CCI 20", "Momentum", "trend");
  let meanDev = 0;
  for (let j = i - period + 1; j <= i; j++) meanDev += Math.abs(tp[j] - smaTp[i]);
  meanDev /= period;
  const c = meanDev === 0 ? 0 : (tp[i] - smaTp[i]) / (0.015 * meanDev);
  if (!fin(c)) return unavailable("CCI 20", "Momentum", "trend");
  return {
    name: "CCI 20",
    category: "Momentum",
    bloc: "trend",
    state: c > 100 ? "BULLISH" : c < -100 ? "BEARISH" : "NEUTRAL",
    detail: `CCI=${c.toFixed(2)}`,
    value: c,
    valid: true,
  };
}

/** 11. Williams %R (14). */
export function indWilliamsR(k: Kline[]): IndicatorResult {
  const n = k.length;
  const period = 14;
  if (n < period) return unavailable("Williams %R 14", "Momentum", "meanReversion");
  let hh = -Infinity;
  let ll = Infinity;
  for (let j = n - period; j < n; j++) {
    if (k[j].high > hh) hh = k[j].high;
    if (k[j].low < ll) ll = k[j].low;
  }
  const w = hh === ll ? -50 : (-100 * (hh - k[n - 1].close)) / (hh - ll);
  if (!fin(w)) return unavailable("Williams %R 14", "Momentum", "meanReversion");
  return {
    name: "Williams %R 14",
    category: "Momentum",
    bloc: "meanReversion",
    state: w <= -80 ? "BULLISH" : w >= -20 ? "BEARISH" : "NEUTRAL",
    detail: `%R=${w.toFixed(2)}`,
    value: w,
    valid: true,
  };
}

/** 12. Awesome Oscillator — SMA5(median) − SMA34(median). */
export function indAO(k: Kline[]): IndicatorResult {
  const med = k.map((c) => (c.high + c.low) / 2);
  const s5 = sma(med, 5);
  const s34 = sma(med, 34);
  const ao = med.map((_, i) => s5[i] - s34[i]);
  const a = last(ao);
  const aPrev = prev(ao);
  if (!fin(a) || !fin(aPrev)) return unavailable("Awesome Osc.", "Momentum", "trend");
  let state: SignalState = "NEUTRAL";
  if (a > 0 && a > aPrev) state = "BULLISH";
  else if (a < 0 && a < aPrev) state = "BEARISH";
  return {
    name: "Awesome Osc.",
    category: "Momentum",
    // AO is a momentum-of-trend measure built from two moving averages: it
    // belongs with the trend bloc, not the contrarian bloc.
    bloc: "trend",
    state,
    detail: `AO=${a.toExponential(2)}`,
    value: a,
    valid: true,
  };
}

/** 13. MFI (14) — volume-weighted RSI. Requires candle volume. */
export function indMFI(k: Kline[]): IndicatorResult {
  const n = k.length;
  const period = 14;
  if (n < period + 1) return unavailable("MFI 14", "Momentum", "meanReversion");
  const tp = k.map((c) => (c.high + c.low + c.close) / 3);
  const mf = tp.map((v, i) => v * k[i].volume);
  let pos = 0;
  let neg = 0;
  for (let i = 1; i <= period; i++) {
    if (tp[i] > tp[i - 1]) pos += mf[i];
    else if (tp[i] < tp[i - 1]) neg += mf[i];
  }
  // Build 2.02: no positive AND no negative flow → undefined → midpoint.
  const mfiOf = (p: number, q: number) => (p === 0 && q === 0 ? 50 : q === 0 ? 100 : 100 - 100 / (1 + p / q));
  let mfi = mfiOf(pos, neg);
  for (let i = period + 1; i < n; i++) {
    const oldPos = tp[i - period] > tp[i - period - 1] ? mf[i - period] : 0;
    const oldNeg = tp[i - period] < tp[i - period - 1] ? mf[i - period] : 0;
    pos = pos - oldPos + (tp[i] > tp[i - 1] ? mf[i] : 0);
    neg = neg - oldNeg + (tp[i] < tp[i - 1] ? mf[i] : 0);
    mfi = mfiOf(pos, neg);
  }
  if (!fin(mfi)) return unavailable("MFI 14", "Momentum", "meanReversion");
  return {
    name: "MFI 14",
    category: "Momentum",
    bloc: "meanReversion",
    state: mfi <= 20 ? "BULLISH" : mfi >= 80 ? "BEARISH" : "NEUTRAL",
    detail: `MFI=${mfi.toFixed(2)}`,
    value: mfi,
    valid: true,
  };
}

/* ========================================================================== *
 *  BREAKOUT + VOLATILITY BLOCS  (14–17)
 * ========================================================================== */

/** 14. Bollinger Bands (20, 2) — breakout interpretation. */
export function indBollinger(k: Kline[]): IndicatorResult {
  const closes = k.map((c) => c.close);
  const i = closes.length - 1;
  const m = sma(closes, 20)[i];
  const s = rollingStdDev(closes, 20)[i];
  if (!fin(m) || !fin(s)) return unavailable("Bollinger 20/2", "Volatility", "breakout");
  const upper = m + 2 * s;
  const lower = m - 2 * s;
  const cur = closes[i];
  return {
    name: "Bollinger 20/2",
    category: "Volatility",
    bloc: "breakout",
    state: cur > upper ? "BULLISH" : cur < lower ? "BEARISH" : "NEUTRAL",
    detail: `U=${upper.toExponential(2)} · L=${lower.toExponential(2)}`,
    value: s === 0 ? 0 : (cur - m) / s,
    valid: true,
  };
}

/**
 * 15. ATR (14) — INFORMATIONAL regime measure, not a directional vote.
 *
 * ATR is non-directional by construction. Prior builds derived a direction
 * from a 15-bar price delta, which made this a duplicate momentum vote wearing
 * a volatility label. It now reports the ATR percentile, which the engine uses
 * to cap signal strength in compressed regimes.
 */
export function indATR(k: Kline[]): IndicatorResult {
  const a = atr(k, 14).filter((v) => fin(v));
  if (a.length < 20) return unavailable("ATR 14", "Volatility", "volatility");
  const cur = a[a.length - 1];
  const sorted = [...a].sort((x, y) => x - y);
  const rank = sorted.findIndex((v) => v >= cur);
  const percentile = rank < 0 ? 1 : rank / (sorted.length - 1);
  return {
    name: "ATR 14",
    category: "Volatility",
    bloc: "volatility",
    state: "NEUTRAL",
    detail: `ATR=${cur.toExponential(2)} · ${(percentile * 100).toFixed(0)}th pct`,
    value: percentile,
    valid: true,
    informational: true,
    qualityNote: "Regime filter — non-directional, does not vote.",
  };
}

/** 16. Keltner Channels (EMA 20, ATR 10, mult 2). */
export function indKeltner(k: Kline[]): IndicatorResult {
  const closes = k.map((c) => c.close);
  const i = closes.length - 1;
  const m = ema(closes, 20)[i];
  const av = atr(k, 10)[i];
  if (!fin(m) || !fin(av)) return unavailable("Keltner 20/10", "Volatility", "breakout");
  const upper = m + 2 * av;
  const lower = m - 2 * av;
  const cur = closes[i];
  return {
    name: "Keltner 20/10",
    category: "Volatility",
    bloc: "breakout",
    state: cur > upper ? "BULLISH" : cur < lower ? "BEARISH" : "NEUTRAL",
    detail: `U=${upper.toExponential(2)} · L=${lower.toExponential(2)}`,
    value: av === 0 ? 0 : (cur - m) / av,
    valid: true,
  };
}

/**
 * 17. Standard Deviation (20) — INFORMATIONAL.
 * Prior builds inferred direction from a SINGLE bar's price change, which is
 * close to a coin flip counted at full weight. Now reports volatility state
 * only.
 */
export function indStdDev(k: Kline[]): IndicatorResult {
  const closes = k.map((c) => c.close);
  const sd = rollingStdDev(closes, 20);
  const cur = last(sd);
  const prevSd = prev(sd);
  if (!fin(cur) || !fin(prevSd)) return unavailable("Std Dev 20", "Volatility", "volatility");
  return {
    name: "Std Dev 20",
    category: "Volatility",
    bloc: "volatility",
    state: "NEUTRAL",
    detail: `σ=${cur.toExponential(2)} · ${cur > prevSd ? "expanding" : "compressing"}`,
    value: cur,
    valid: true,
    informational: true,
    qualityNote: "Regime filter — non-directional, does not vote.",
  };
}

/* ========================================================================== *
 *  FLOW BLOC  (18–20)
 * ========================================================================== */

/**
 * 18. VWAP — session-anchored for intraday intervals.
 *
 * Prior builds accumulated across the entire loaded window, so on 1m this was a
 * 200-minute average and on 1d a 200-day cumulative — neither of which is VWAP,
 * and both of which drift into being slow moving averages correlated with the
 * trend bloc. We now anchor to the UTC session for sub-daily intervals and
 * label the fallback honestly.
 */
export function indVWAP(k: Kline[], ctx: IndicatorContext = DEFAULT_CONTEXT): IndicatorResult {
  let series = k;
  let label = "VWAP (session)";
  if (ctx.intervalMs < DAY_MS) {
    const sessionStart = Math.floor(last(k).time / DAY_MS) * DAY_MS;
    const session = k.filter((c) => c.time >= sessionStart);
    if (session.length >= 3) {
      series = session;
    } else {
      series = k.slice(-20);
      label = "VWAP (20-bar)";
    }
  } else {
    series = k.slice(-20);
    label = "VWAP (20-bar)";
  }

  let cumPV = 0;
  let cumV = 0;
  for (const c of series) {
    cumPV += ((c.high + c.low + c.close) / 3) * c.volume;
    cumV += c.volume;
  }
  if (cumV <= 0) {
    return unavailable(label, "Volume", "flow", "Excluded: this provider does not supply candle volume.");
  }
  const vwap = cumPV / cumV;
  const cur = last(k).close;
  if (!fin(vwap)) return unavailable(label, "Volume", "flow");
  return {
    name: label,
    category: "Volume",
    bloc: "flow",
    state: cur > vwap ? "BULLISH" : cur < vwap ? "BEARISH" : "NEUTRAL",
    detail: `VWAP=${vwap.toExponential(2)} · ${series.length} bars`,
    value: vwap === 0 ? 0 : (cur - vwap) / vwap,
    valid: true,
  };
}

/** 19. OBV — On-Balance Volume vs its own SMA(20). */
export function indOBV(k: Kline[]): IndicatorResult {
  const n = k.length;
  if (n < 21) return unavailable("OBV", "Volume", "flow");
  const obv: number[] = new Array(n).fill(0);
  let totalVolume = 0;
  for (let i = 1; i < n; i++) {
    totalVolume += k[i].volume;
    if (k[i].close > k[i - 1].close) obv[i] = obv[i - 1] + k[i].volume;
    else if (k[i].close < k[i - 1].close) obv[i] = obv[i - 1] - k[i].volume;
    else obv[i] = obv[i - 1];
  }
  if (totalVolume <= 0) {
    return unavailable("OBV", "Volume", "flow", "Excluded: this provider does not supply candle volume.");
  }
  const cur = last(obv);
  const avg = last(sma(obv, 20));
  if (!fin(avg)) return unavailable("OBV", "Volume", "flow");
  return {
    name: "OBV",
    category: "Volume",
    bloc: "flow",
    state: cur > avg ? "BULLISH" : cur < avg ? "BEARISH" : "NEUTRAL",
    detail: `OBV=${cur.toExponential(2)}`,
    value: cur - avg,
    valid: true,
  };
}

/** 20. CMF — Chaikin Money Flow (20). */
export function indCMF(k: Kline[]): IndicatorResult {
  const n = k.length;
  const period = 20;
  if (n < period) return unavailable("CMF 20", "Volume", "flow");
  const mfv = k.map((c) => {
    const range = c.high - c.low;
    if (range === 0) return 0;
    return (((c.close - c.low) - (c.high - c.close)) / range) * c.volume;
  });
  let sumMfv = 0;
  let sumVol = 0;
  for (let i = n - period; i < n; i++) {
    sumMfv += mfv[i];
    sumVol += k[i].volume;
  }
  if (sumVol <= 0) {
    return unavailable("CMF 20", "Volume", "flow", "Excluded: this provider does not supply candle volume.");
  }
  const cmf = sumMfv / sumVol;
  if (!fin(cmf)) return unavailable("CMF 20", "Volume", "flow");
  return {
    name: "CMF 20",
    category: "Volume",
    bloc: "flow",
    state: cmf > 0.05 ? "BULLISH" : cmf < -0.05 ? "BEARISH" : "NEUTRAL",
    detail: `CMF=${cmf.toFixed(4)}`,
    value: cmf,
    valid: true,
  };
}

/* ========================================================================== *
 *  STRUCTURE — Fair Value Gaps (non-voting context)
 *
 *  An FVG is a level/zone (a magnet), not a direction. It is displayed as
 *  context but deliberately does NOT vote (informational: true), so it never
 *  affects the bloc aggregation. Its influence on the read is expressed only via
 *  a bounded confidence modifier applied after scoring (see runConfluence).
 * ========================================================================== */

export function indFVG(k: Kline[]): IndicatorResult {
  // The engine's input is already closed-bar only (market-client drops the
  // forming candle), so the newest element IS closed. Build 2.01 let the FVG
  // module drop it a second time, which ran the detector one bar late.
  const { active } = detectFVG(k, FVG_ENGINE_OPTS);
  const price = k.length ? k[k.length - 1].close : null;

  let nearest: FvgZone | null = null;
  if (price !== null) {
    let best = Infinity;
    for (const z of active) {
      const d =
        price >= z.bottom && price <= z.top
          ? 0
          : Math.min(Math.abs(price - z.top), Math.abs(price - z.bottom));
      if (d < best) {
        best = d;
        nearest = z;
      }
    }
  }

  const detail = nearest
    ? `${active.length} open FVG${active.length === 1 ? "" : "s"}; nearest ${nearest.type} ` +
      `${nearest.bottom.toFixed(2)}–${nearest.top.toFixed(2)} (${Math.round(nearest.mitigation * 100)}% filled)`
    : active.length
      ? `${active.length} open fair-value gap${active.length === 1 ? "" : "s"}`
      : "No open fair-value gaps";

  return {
    name: "FVG (imbalance)",
    category: "Structure",
    bloc: "volatility",
    state: "NEUTRAL",
    detail,
    value: active.length,
    valid: true,
    informational: true,
    qualityNote: "Context only — fair-value gaps are levels, not a direction. Does not vote.",
  };
}

/* ========================================================================== *
 *  CONFLUENCE ENGINE
 * ========================================================================== */

type IndicatorFn = (k: Kline[], ctx: IndicatorContext) => IndicatorResult;

/** Ordered list of all 21 indicator calculators (18 vote; ATR, Std Dev, FVG are informational). */
export const INDICATORS: IndicatorFn[] = [
  indSMA,
  indEMA,
  indMACD,
  indADX,
  indPSAR,
  indIchimoku,
  indSupertrend,
  indRSI,
  indStoch,
  indCCI,
  indWilliamsR,
  indAO,
  indMFI,
  indBollinger,
  indATR,
  indKeltner,
  indStdDev,
  indVWAP,
  indOBV,
  indCMF,
  // Non-voting structural context (informational: true — excluded from the vote).
  indFVG,
];

/** Blocs that participate in the vote, with their nominal membership. */
export const VOTING_BLOCS: BlocName[] = ["trend", "meanReversion", "breakout", "flow"];

export interface BlocScore {
  bloc: BlocName;
  bull: number;
  bear: number;
  neutral: number;
  valid: number;
  /** −1 .. +1 */
  score: number;
  /** Weight in the master score (1, except the ER-gated mean-reversion bloc). */
  weight: number;
}

export interface ConfluenceResult {
  indicators: IndicatorResult[];
  bull: number;
  bear: number;
  neutral: number;
  master: SignalState;
  strength: "STRONG" | "MODERATE" | "WEAK";
  score: number; // −100 (max bear) .. +100 (max bull)
  validCount: number;
  excludedCount: number;
  /** True when too few indicators were valid to publish a score at all. */
  suppressed: boolean;
  /** True when ATR sits in the bottom decile of its own distribution. */
  lowVolatility: boolean;
  blocs: BlocScore[];
  warnings: string[];
  /**
   * Non-voting FVG confidence modifier in [0.85, 1.15]. Scales confidence only —
   * never changes `master`, `score`, or `strength`.
   */
  fvgModifier?: number;
  fvgReason?: string;
  /** |score| scaled by the FVG modifier, for display as a confidence cue. */
  confidence?: number;
  /** Active (unfilled) fair-value gaps, for the chart overlay. */
  fvgZones?: FvgZone[];
  /** v2.1: efficiency ratio (regime) and the derived trend gate 0..1, recorded in the signal ledger. */
  er?: number | null;
  trendGate?: number;
}

export interface ConfluenceOptions {
  profile?: ScoringProfile | null;
  volumeAvailable?: boolean;
  intervalMs?: number;
  /**
   * v2.1.1: cap STRONG to MODERATE in the bottom ATR decile (default true).
   * Off for FX, whose normal volatility sits far below crypto's, so the cap
   * would fire on almost every bar.
   */
  lowVolatilityCap?: boolean;
}

const emptyBlocs = (): BlocScore[] =>
  VOTING_BLOCS.map((bloc) => ({ bloc, bull: 0, bear: 0, neutral: 0, valid: 0, score: 0, weight: 1 }));

/**
 * Run all 21 indicators and aggregate the 18 voters by BLOC rather than by headcount.
 *
 *   blocScore = clamp((bull − bear) / validMembers, −1, +1)
 *   score     = 100 × Σ(w·blocScore) / Σw over blocs with ≥1 valid member
 *   w         = 1 for every bloc except meanReversion, whose weight is
 *               (1 − g) under the efficiency-ratio regime gate (Build 2.02)
 *
 * This prevents seven correlated trend followers from outvoting the rest of the
 * panel simply by being numerous. It is a mitigation, not a replacement for a
 * proper regime-switched engine — that redesign should follow measurement of a
 * recorded signal ledger, not precede it.
 */
export function runConfluence(k: Kline[], options: ConfluenceOptions = {}): ConfluenceResult {
  const profile = normalizeScoringProfile(options.profile);
  const enabled = profile ? new Set(profile.enabled) : null;
  const volumeAvailable = options.volumeAvailable ?? true;
  const ctx: IndicatorContext = { intervalMs: options.intervalMs ?? DEFAULT_CONTEXT.intervalMs };

  const votingIds: (VotingIndicatorId | null)[] = [
    "sma", "ema", "macd", "adx", "psar", "ichimoku", "supertrend", "rsi", "stochastic",
    "cci", "williams", "ao", "mfi", "bollinger", null, "keltner", null, "vwap", "obv", "cmf", null,
  ];
  const indicators: IndicatorResult[] = INDICATORS.map((fn, index) => {
    try {
      const result = fn(k, ctx);
      const id = votingIds[index];
      if (enabled && id && !enabled.has(id)) {
        return { ...result, informational: true, state: "NEUTRAL" as SignalState, detail: "Disabled by scoring profile" };
      }
      // Typed validity — no regex over display strings.
      const numericFailure = result.valid && result.value !== null && !Number.isFinite(result.value);
      const needsVolume = result.category === "Volume" || result.name.startsWith("MFI");
      if (needsVolume && !volumeAvailable) {
        return {
          ...result,
          state: "NEUTRAL" as SignalState,
          valid: false,
          qualityNote: "Excluded: this provider does not supply candle volume.",
        };
      }
      if (numericFailure) {
        return {
          ...result,
          state: "NEUTRAL" as SignalState,
          valid: false,
          qualityNote: "Excluded: computation produced a non-finite value.",
        };
      }
      return result;
    } catch {
      return {
        name: fn.name.replace(/^ind/, "") || "Indicator",
        category: "Data quality",
        bloc: "trend" as BlocName,
        state: "NEUTRAL" as SignalState,
        detail: "Unavailable",
        value: null,
        valid: false,
        qualityNote: "Excluded: calculation failed for this candle series.",
      };
    }
  });

  const voting = indicators.filter((i) => !i.informational);
  const validVoting = voting.filter((i) => i.valid);

  let bull = 0;
  let bear = 0;
  let neutral = 0;
  for (const r of validVoting) {
    if (r.state === "BULLISH") bull++;
    else if (r.state === "BEARISH") bear++;
    else neutral++;
  }

  const validCount = validVoting.length;
  const excludedCount = indicators.filter((i) => !i.valid).length;
  const minValid = Math.ceil(voting.length * MIN_VALID_VOTING_SHARE);

  const atrResult = indicators.find((i) => i.name === "ATR 14");
  const lowVolatility =
    !!atrResult && atrResult.valid && atrResult.value !== null && atrResult.value < LOW_VOLATILITY_PERCENTILE;

  const warnings: string[] = [];

  // --- Evidence floor: refuse to publish a score from too little data. -----
  if (validCount < minValid || (profile && voting.length === 0)) {
    warnings.push(
      `Only ${validCount}/${voting.length} voting indicators had sufficient data ` +
        `(minimum ${minValid}). Scoring suppressed — this is missing information, not a neutral market.`,
    );
    return {
      indicators,
      bull,
      bear,
      neutral,
      master: "NEUTRAL",
      strength: "WEAK",
      score: 0,
      validCount,
      excludedCount,
      suppressed: true,
      lowVolatility,
      blocs: emptyBlocs(),
      warnings,
    };
  }

  // --- Regime gate (Build 2.02) --------------------------------------------
  const er = efficiencyRatio(k);
  const trendGate =
    er === null ? 0 : Math.max(0, Math.min(1, (er - ER_GATE_LOW) / (ER_GATE_HIGH - ER_GATE_LOW)));

  // --- Bloc-weighted score -------------------------------------------------
  const blocs: BlocScore[] = VOTING_BLOCS.map((bloc) => {
    const members = validVoting.filter((i) => i.bloc === bloc);
    const b = members.filter((i) => i.state === "BULLISH").length;
    const s = members.filter((i) => i.state === "BEARISH").length;
    const nu = members.filter((i) => i.state === "NEUTRAL").length;
    const raw = members.length ? (b - s) / members.length : 0;
    const weight = profile && members.length === 0 ? 0 : bloc === "meanReversion" ? 1 - trendGate : 1;
    return { bloc, bull: b, bear: s, neutral: nu, valid: members.length, score: Math.max(-1, Math.min(1, raw)), weight };
  });

  const active = blocs.filter((b) => b.valid > 0 && b.weight > 0);
  const totalWeight = active.reduce((acc, b) => acc + b.weight, 0);
  if (profile && totalWeight === 0) {
    return {
      indicators, bull, bear, neutral, master: "NEUTRAL", strength: "WEAK", score: 0,
      validCount, excludedCount, suppressed: true, lowVolatility, blocs,
      warnings: [...warnings, "No enabled voting group has usable weight. Scoring suppressed."],
    };
  }
  const meanBloc = totalWeight > 0 ? active.reduce((acc, b) => acc + b.weight * b.score, 0) / totalWeight : 0;
  const score = Math.round(100 * meanBloc);

  // --- Direction with a dead zone -----------------------------------------
  let master: SignalState = "NEUTRAL";
  let strength: ConfluenceResult["strength"] = "WEAK";
  if (Math.abs(score) >= NEUTRAL_BAND) {
    master = score > 0 ? "BULLISH" : "BEARISH";
    strength = Math.abs(score) >= STRONG_BAND ? "STRONG" : "MODERATE";
  }

  // --- Volatility regime filter -------------------------------------------
  if (lowVolatility && strength === "STRONG" && (options.lowVolatilityCap ?? true)) {
    strength = "MODERATE";
    warnings.push(
      "Compressed volatility (ATR in the bottom decile of its own range): signal strength capped. " +
        "Breakout and trend readings are least reliable here, and the move may be smaller than the round-trip cost of acting on it.",
    );
  }

  if (trendGate > 0) {
    warnings.push(
      trendGate >= 1
        ? `Persistent trend (efficiency ratio ${er!.toFixed(2)}): contrarian oscillators are excluded from the score.`
        : `Trending (efficiency ratio ${er!.toFixed(2)}): contrarian oscillators weighted ${Math.round((1 - trendGate) * 100)}%.`,
    );
  }

  if (excludedCount > 0) {
    warnings.push(
      `${excludedCount} indicator${excludedCount === 1 ? "" : "s"} excluded from scoring because required data was unavailable.`,
    );
  }

  const disagreement = blocs.filter((b) => b.valid > 0 && Math.abs(b.score) > 0.4);
  if (disagreement.some((b) => b.score > 0) && disagreement.some((b) => b.score < 0)) {
    warnings.push(
      "Blocs disagree: trend-following and mean-reversion readings point in opposite directions. " +
        "This is common at trend extremes and the aggregate score understates both.",
    );
  }

  // --- Non-voting FVG confidence modifier ----------------------------------
  // Applied AFTER scoring. It scales a display-only confidence and never touches
  // master / score / strength. Bounded to [0.85, 1.15] inside fvgModifier().
  const dir = master === "BULLISH" ? "buy" : master === "BEARISH" ? "sell" : "neutral";
  const price = k.length ? k[k.length - 1].close : undefined;
  const fvg = fvgModifier(k, dir, price, FVG_ENGINE_OPTS);
  const confidence = Math.round(Math.abs(score) * fvg.modifier);

  return {
    indicators,
    bull,
    bear,
    neutral,
    master,
    strength,
    score,
    validCount,
    excludedCount,
    suppressed: false,
    lowVolatility,
    blocs,
    warnings,
    fvgModifier: fvg.modifier,
    fvgReason: fvg.reason,
    confidence,
    fvgZones: fvg.zones,
    er,
    trendGate,
  };
}
