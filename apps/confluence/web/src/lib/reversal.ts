/**
 * reversal.ts
 * ----------------------------------------------------------------------------
 * Trend-Reversal Detection Engine.
 *
 * A reversal is most meaningful in the context of an *existing* trend: an
 * uptrend that begins exhausting signals a potential bearish (top) reversal;
 * a downtrend that begins exhausting signals a potential bullish (bottom)
 * reversal.
 *
 * We detect the current trend from price structure, then scan for exhaustion
 * / flip signals across multiple indicator families:
 *
 *   1. RSI divergence        — price vs RSI slope disagreement
 *   2. MACD momentum loss    — histogram shrinking against the trend
 *   3. Bollinger reversion   — piercing a band then closing back inside
 *   4. Stochastic zone cross — %K/%D cross back through 80/20
 *   5. Parabolic SAR flip    — dots switching sides
 *   6. Supertrend flip       — active band direction changed
 *   7. RSI zone exit         — leaving overbought/oversold
 *   8. Engulfing candle      — body engulfs prior body at an extreme
 *   9. Hammer / Shooting star — wick dominance at an extreme
 *
 * Each signal votes UP (bullish reversal) or DOWN (bearish reversal). The net
 * tally determines direction + confidence. A "genuine reversal" requires the
 * signal direction to oppose the current trend.
 *
 * Build 1.9: the final element of `k` is a CLOSED bar (the data layer drops the
 * forming candle). This matters most here — candlestick patterns such as
 * engulfing, hammer, and shooting star are geometry claims about a finished
 * candle, and evaluating them on a bar still being built is pure noise.
 * ----------------------------------------------------------------------------
 */
import {
  atr,
  ema,
  sma,
  rollingStdDev,
} from "./indicators";
import type { Kline } from "./indicators";

export interface ReversalSignal {
  name: string;
  direction: "UP" | "DOWN";
  detail: string;
}

export type TrendDir = "UPTREND" | "DOWNTREND" | "RANGING";
export type ReversalDir = "UP" | "DOWN" | "NONE";
export type Confidence = "HIGH" | "MODERATE" | "LOW" | "NONE";

export interface ReversalResult {
  signals: ReversalSignal[];
  currentTrend: TrendDir;
  direction: ReversalDir;
  isReversal: boolean; // true only when direction opposes the current trend
  confidence: Confidence;
  score: number; // upCount − downCount  (range roughly −9..+9)
  upCount: number;
  downCount: number;
  summary: string;
}

/* ------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------ */

/** Linear-regression slope of a numeric series (per bar). */
function slope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xs = Array.from({ length: n }, (_, i) => i);
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0,
    den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (values[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/** RSI (14) via Wilder smoothing — needed locally for divergence + zone exit. */
function rsi(closes: number[], period = 14): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return out;
  let gain = 0,
    loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  // v2.1: same rule as the confluence engine (Build 2.02) — no gains AND no
  // losses is undefined RSI, reported as the midpoint, not 100. A flat or pegged
  // series used to read "overbought" here and fire RSI zone-exit reversals.
  const rsiOf = (g: number, l: number) => (g === 0 && l === 0 ? 50 : l === 0 ? 100 : 100 - 100 / (1 + g / l));
  out[period] = rsiOf(avgG, avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch >= 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out[i] = rsiOf(avgG, avgL);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  Core detection
 * ------------------------------------------------------------------ */

export function detectReversal(k: Kline[]): ReversalResult {
  const closes = k.map((c) => c.close);
  const n = closes.length;
  const empty: ReversalResult = {
    signals: [],
    currentTrend: "RANGING",
    direction: "NONE",
    isReversal: false,
    confidence: "NONE",
    score: 0,
    upCount: 0,
    downCount: 0,
    summary: "Insufficient data",
  };
  if (n < 55) return empty;

  const signals: ReversalSignal[] = [];
  const last = k[n - 1];
  const prev = k[n - 2];

  /* --- 0. Determine the current trend ---------------------------------- *
   * Trend = direction of the SMA(50) slope + price position vs SMA(50).
   * A genuine uptrend: price > SMA50 AND SMA50 sloping up over last 10 bars.
   */
  const s50 = sma(closes, 50);
  const s20 = sma(closes, 20);
  const s50Now = s50[n - 1];
  const s50Prev10 = s50[n - 11];
  let currentTrend: TrendDir = "RANGING";
  if (!isNaN(s50Now) && !isNaN(s50Prev10)) {
    const slope50 = (s50Now - s50Prev10) / 10;
    if (last.close > s50Now && slope50 > 0) currentTrend = "UPTREND";
    else if (last.close < s50Now && slope50 < 0) currentTrend = "DOWNTREND";
  }

  /* --- 1. RSI divergence (last 20-bar regression) ---------------------- *
   * Bearish divergence: price slope ↑ but RSI slope ↓ (momentum fading).
   * Bullish divergence: price slope ↓ but RSI slope ↑ (selling exhausting).
   */
  const rsiArr = rsi(closes, 14);
  const win = 20;
  const priceSlice = closes.slice(n - win);
  const rsiSlice = rsiArr.slice(n - win);
  if (rsiSlice.every((v) => !isNaN(v))) {
    const ps = slope(priceSlice);
    const rs = slope(rsiSlice);
    // Normalise slopes relative to their mean so magnitudes are comparable.
    const psN = ps / (priceSlice.reduce((a, b) => a + b, 0) / win);
    const rsN = rs / 50;
    if (psN > 0.002 && rsN < -0.005) {
      signals.push({
        name: "RSI Divergence",
        direction: "DOWN",
        detail: "price ↑ while RSI ↓ (bearish divergence)",
      });
    } else if (psN < -0.002 && rsN > 0.005) {
      signals.push({
        name: "RSI Divergence",
        direction: "UP",
        detail: "price ↓ while RSI ↑ (bullish divergence)",
      });
    }
  }

  /* --- 2. MACD momentum loss ------------------------------------------- *
   * If MACD is bullish (line > signal) but histogram has shrunk 3 bars in a
   * row, the uptrend is losing momentum → potential bearish reversal.
   */
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const macdLine = closes.map((_, i) => e12[i] - e26[i]);
  const validStart = 25;
  const sigSlice = ema(macdLine.slice(validStart), 9);
  const signalLine: number[] = new Array(n).fill(NaN);
  for (let i = 0; i < sigSlice.length; i++) signalLine[validStart + i] = sigSlice[i];
  const hist = macdLine.map((m, i) => m - signalLine[i]);
  const h = hist.slice(-4);
  if (h.every((v) => !isNaN(v))) {
    if (macdLine[n - 1] > signalLine[n - 1] && h[3] < h[2] && h[2] < h[1] && h[1] < h[0]) {
      signals.push({
        name: "MACD Momentum Loss",
        direction: "DOWN",
        detail: "bullish but histogram shrinking 3 bars",
      });
    } else if (macdLine[n - 1] < signalLine[n - 1] && h[3] > h[2] && h[2] > h[1] && h[1] > h[0]) {
      signals.push({
        name: "MACD Momentum Loss",
        direction: "UP",
        detail: "bearish but histogram rising 3 bars",
      });
    }
  }

  /* --- 3. Bollinger band reversion ------------------------------------- *
   * Prior candle closed outside a band, current closed back inside →
   * mean-reversion reversal signal.
   */
  const mid = s20;
  const sd = rollingStdDev(closes, 20);
  if (!isNaN(sd[n - 2]) && !isNaN(sd[n - 1])) {
    const up2 = mid[n - 2] + 2 * sd[n - 2];
    const lo2 = mid[n - 2] - 2 * sd[n - 2];
    const up1 = mid[n - 1] + 2 * sd[n - 1];
    const lo1 = mid[n - 1] - 2 * sd[n - 1];
    if (prev.close > up2 && last.close < up1) {
      signals.push({
        name: "Bollinger Reversion",
        direction: "DOWN",
        detail: "closed back inside upper band",
      });
    } else if (prev.close < lo2 && last.close > lo1) {
      signals.push({
        name: "Bollinger Reversion",
        direction: "UP",
        detail: "closed back inside lower band",
      });
    }
  }

  /* --- 4. Stochastic reversal cross ------------------------------------ *
   * %K crossing back below %D while >80 (overbought) → bearish.
   * %K crossing back above %D while <20 (oversold) → bullish.
   */
  {
    const period = 14;
    const pk: number[] = new Array(n).fill(NaN);
    for (let i = period - 1; i < n; i++) {
      let hh = -Infinity,
        ll = Infinity;
      for (let j = i - period + 1; j <= i; j++) {
        if (k[j].high > hh) hh = k[j].high;
        if (k[j].low < ll) ll = k[j].low;
      }
      pk[i] = hh === ll ? 50 : (100 * (k[i].close - ll)) / (hh - ll);
    }
    const pd = sma(pk, 3);
    if (!isNaN(pk[n - 2]) && !isNaN(pd[n - 2])) {
      if (pk[n - 2] > 80 && pk[n - 2] >= pd[n - 2] && pk[n - 1] < pd[n - 1]) {
        signals.push({
          name: "Stochastic Cross",
          direction: "DOWN",
          detail: `%K crossed below %D in overbought (${pk[n - 1].toFixed(0)})`,
        });
      } else if (pk[n - 2] < 20 && pk[n - 2] <= pd[n - 2] && pk[n - 1] > pd[n - 1]) {
        signals.push({
          name: "Stochastic Cross",
          direction: "UP",
          detail: `%K crossed above %D in oversold (${pk[n - 1].toFixed(0)})`,
        });
      }
    }
  }

  /* --- 5. Parabolic SAR flip ------------------------------------------- *
   * Re-run a lightweight SAR; if the dot side flipped on the last bar,
   * that's a direct trend-change signal.
   */
  {
    let isBull = true;
    let af = 0.02;
    let ep = k[0].high;
    let s = k[0].low;
    let prevBull = true;
    for (let i = 1; i < n; i++) {
      prevBull = isBull;
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
      } else {
        if (k[i].high > s) {
          isBull = true;
          s = ep;
          ep = k[i].high;
          af = 0.02;
        } else if (k[i].low < ep) {
          ep = k[i].low;
          af = Math.min(af + 0.02, 0.2);
        }
      }
    }
    if (prevBull !== isBull) {
      signals.push({
        name: "Parabolic SAR Flip",
        direction: isBull ? "UP" : "DOWN",
        detail: `dots flipped ${isBull ? "below (bullish)" : "above (bearish)"}`,
      });
    }
  }

  /* --- 6. Supertrend flip ---------------------------------------------- */
  {
    const period = 10;
    const mult = 3;
    const atrArr = atr(k, period);
    const upper: number[] = new Array(n).fill(NaN);
    const lower: number[] = new Array(n).fill(NaN);
    const st: number[] = new Array(n).fill(NaN);
    let dir = 0; // v2.1: 0 = unseeded; seeded from price like indSupertrend (was a bullish default)
    for (let i = 0; i < n; i++) {
      if (isNaN(atrArr[i])) continue;
      const basis = (k[i].high + k[i].low) / 2;
      const ub = basis + mult * atrArr[i];
      const lb = basis - mult * atrArr[i];
      upper[i] = i > 0 && !isNaN(upper[i - 1]) ? (ub < upper[i - 1] || k[i - 1].close > upper[i - 1] ? ub : upper[i - 1]) : ub;
      lower[i] = i > 0 && !isNaN(lower[i - 1]) ? (lb > lower[i - 1] || k[i - 1].close < lower[i - 1] ? lb : lower[i - 1]) : lb;
      const prevDir = dir;
      if (dir === 0) dir = k[i].close >= basis ? 1 : -1;
      else if (dir === 1 && k[i].close < lower[i]) dir = -1;
      else if (dir === -1 && k[i].close > upper[i]) dir = 1;
      st[i] = dir === 1 ? lower[i] : upper[i];
      // A seeding step is not a flip.
      if (i === n - 1 && prevDir !== 0 && prevDir !== dir) {
        signals.push({
          name: "Supertrend Flip",
          direction: dir === 1 ? "UP" : "DOWN",
          detail: `direction → ${dir === 1 ? "uptrend" : "downtrend"}`,
        });
      }
    }
  }

  /* --- 7. RSI zone exit ------------------------------------------------ */
  if (!isNaN(rsiArr[n - 2]) && !isNaN(rsiArr[n - 1])) {
    if (rsiArr[n - 2] >= 70 && rsiArr[n - 1] < 70) {
      signals.push({
        name: "RSI Overbought Exit",
        direction: "DOWN",
        detail: `RSI ${rsiArr[n - 2].toFixed(0)}→${rsiArr[n - 1].toFixed(0)}`,
      });
    } else if (rsiArr[n - 2] <= 30 && rsiArr[n - 1] > 30) {
      signals.push({
        name: "RSI Oversold Exit",
        direction: "UP",
        detail: `RSI ${rsiArr[n - 2].toFixed(0)}→${rsiArr[n - 1].toFixed(0)}`,
      });
    }
  }

  /* --- 8. Engulfing candlestick ---------------------------------------- *
   * Bearish engulfing: prior bullish, current bearish, current body fully
   * covers prior body, occurring near a recent high (top).
   * Bullish engulfing: mirror, near a recent low.
   */
  {
    const lookback = 20;
    const recentHigh = Math.max(...k.slice(n - lookback).map((c) => c.high));
    const recentLow = Math.min(...k.slice(n - lookback).map((c) => c.low));
    const prevBull = prev.close > prev.open;
    const prevBear = prev.close < prev.open;
    const lastBear = last.close < last.open;
    const lastBull = last.close > last.open;
    const engulfsDown = prevBull && lastBear && last.open >= prev.close && last.close <= prev.open;
    const engulfsUp = prevBear && lastBull && last.open <= prev.close && last.close >= prev.open;
    if (engulfsDown && last.high >= recentHigh * 0.99) {
      signals.push({
        name: "Bearish Engulfing",
        direction: "DOWN",
        detail: "engulfing candle near recent high",
      });
    } else if (engulfsUp && last.low <= recentLow * 1.01) {
      signals.push({
        name: "Bullish Engulfing",
        direction: "UP",
        detail: "engulfing candle near recent low",
      });
    }
  }

  /* --- 9. Hammer / Shooting star --------------------------------------- *
   * Hammer: lower wick ≥ 2× body, small upper wick, near recent low → bullish.
   * Shooting star: upper wick ≥ 2× body, small lower wick, near recent high → bearish.
   */
  {
    const lookback = 20;
    const recentHigh = Math.max(...k.slice(n - lookback).map((c) => c.high));
    const recentLow = Math.min(...k.slice(n - lookback).map((c) => c.low));
    const body = Math.abs(last.close - last.open);
    const upperWick = last.high - Math.max(last.close, last.open);
    const lowerWick = Math.min(last.close, last.open) - last.low;
    if (body > 0) {
      if (lowerWick >= 2 * body && upperWick <= body && last.low <= recentLow * 1.01) {
        signals.push({
          name: "Hammer",
          direction: "UP",
          detail: "long lower wick near recent low",
        });
      } else if (upperWick >= 2 * body && lowerWick <= body && last.high >= recentHigh * 0.99) {
        signals.push({
          name: "Shooting Star",
          direction: "DOWN",
          detail: "long upper wick near recent high",
        });
      }
    }
  }

  /* --- Aggregate ------------------------------------------------------- */
  const upCount = signals.filter((s) => s.direction === "UP").length;
  const downCount = signals.filter((s) => s.direction === "DOWN").length;
  const score = upCount - downCount;

  let direction: ReversalDir = "NONE";
  if (score > 0) direction = "UP";
  else if (score < 0) direction = "DOWN";

  // A genuine reversal requires signals to oppose the prevailing trend.
  const isReversal =
    (currentTrend === "UPTREND" && direction === "DOWN") ||
    (currentTrend === "DOWNTREND" && direction === "UP");

  const mag = Math.abs(score);
  let confidence: Confidence = "NONE";
  if (mag >= 3) confidence = "HIGH";
  else if (mag >= 2) confidence = "MODERATE";
  else if (mag >= 1) confidence = "LOW";

  let summary: string;
  if (direction === "NONE" || confidence === "NONE") {
    summary = `No reversal signal · ${currentTrend.toLowerCase()}`;
  } else if (isReversal) {
    const dirLabel = direction === "UP" ? "bullish" : "bearish";
    summary = `${confidence} ${dirLabel} reversal forming · ${currentTrend.toLowerCase()} exhausting`;
  } else {
    summary = `${confidence} ${direction === "UP" ? "bullish" : "bearish"} bias · aligns with ${currentTrend.toLowerCase()}`;
  }

  return {
    signals,
    currentTrend,
    direction,
    isReversal,
    confidence,
    score,
    upCount,
    downCount,
    summary,
  };
}
