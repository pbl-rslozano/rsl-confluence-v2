/**
 * Confluence v2 inputs — v2.8 (WP23 Task 2). Pure code; consumed read-only by the v2 scorer.
 *
 * Each of Classic's 18 voters is turned into a continuous, volatility-standardised input in
 * [-1, 1] (ADR-0017 table): the indicator's measure at bar j is divided by ATR(14), by its own
 * rolling sigma over 100 bars, or by a band half-width, signed (contrarian oscillators carry -1)
 * and clipped. Classic is untouched: this module only reads `indicators.ts` helpers and
 * re-derives, bar by bar, the same measures Classic reads at the last bar only.
 *
 * Causality: raw[j] and z[j] use bars <= j only. Warm-up and invalid bars are NaN, never zero.
 * Determinism: only + - * / % Math.sqrt Math.abs Math.min Math.max (no floor/exp/log/pow, no `**`).
 *
 * Divisor floor (fix round 1). A divisor that is mathematically zero but arrives as rounding noise
 * (1e-16 .. 1e-13: a constant RSI, a flat market's ATR) would turn into a saturated +-1 vote. Every
 * divisor (ATR, band half-width, rolling sigma) must therefore exceed V2_DIVISOR_FLOOR (1e-9) times
 * the natural scale of its input, else z is NaN: the price for price-unit inputs, 100 for the
 * 0..100 oscillators and the DI difference (and CCI), 1 for CMF, and the cumulative traded volume
 * for OBV. 1e-9 is ~7 orders above double rounding noise (1e-16) and ~3 orders below the quietest
 * real market (a stablecoin pair moves ~1e-6 of price per bar), so it only removes dead windows.
 *
 * Classic helpers that are not exported (trueRange, the per-bar forms of Ichimoku, Williams,
 * CMF, VWAP, CCI, RSI, MFI, Stochastic, PSAR, Supertrend, ADX) are re-implemented here with the
 * same formulas; confluence-v2-inputs.test.mjs pins each one to Classic's value at the last bar.
 */
import { sma, ema, atr, macdHistogram, type BlocName, type Kline } from "./indicators";
import type { VotingIndicatorId } from "./scoring-profile";

export const V2_SIGMA_BARS = 100;
export const V2_ATR = 14;
export const V2_CLIP = 1;
/** Contrarian oscillators are dropped from this interval up (>= 4h). */
export const V2_DROP_FROM_MS = 4 * 3_600_000;
/** A divisor at or below this fraction of its input's natural scale is rounding noise, not volatility. */
export const V2_DIVISOR_FLOOR = 1e-9;
export const V2_CONTRARIAN = ["rsi", "stochastic", "williams", "mfi"] as const;

export type V2Bloc = Exclude<BlocName, "volatility">;
export type V2Divisor = "atr14" | "sigma100" | "band";
export interface V2InputSpec {
  id: VotingIndicatorId;
  bloc: V2Bloc;
  measure: string;
  divisor: V2Divisor;
  sign: 1 | -1;
  volume: boolean;
}
export interface V2InputSeries {
  id: VotingIndicatorId;
  bloc: V2Bloc;
  /** The un-divided measure at every bar (NaN where not computable). */
  raw: Float64Array;
  /** clamp(sign * raw / divisor) for bars >= `from`; NaN elsewhere, when invalid, dropped or volume-less. */
  z: Float64Array;
  dropped: boolean;
}

/** ADR-0017 table, in Classic's voter (VOTE_ORDER) order. */
export const V2_INPUTS: readonly V2InputSpec[] = [
  { id: "sma", bloc: "trend", measure: "SMA20 - SMA50", divisor: "atr14", sign: 1, volume: false },
  { id: "ema", bloc: "trend", measure: "EMA9 - EMA21", divisor: "atr14", sign: 1, volume: false },
  { id: "macd", bloc: "trend", measure: "MACD histogram 12/26/9", divisor: "sigma100", sign: 1, volume: false },
  { id: "adx", bloc: "trend", measure: "+DI14 - -DI14", divisor: "sigma100", sign: 1, volume: false },
  { id: "psar", bloc: "trend", measure: "close - SAR (0.02, 0.2)", divisor: "atr14", sign: 1, volume: false },
  { id: "ichimoku", bloc: "trend", measure: "close - cloud mid (spans displaced 26)", divisor: "atr14", sign: 1, volume: false },
  { id: "supertrend", bloc: "trend", measure: "close - Supertrend line (10, 3)", divisor: "atr14", sign: 1, volume: false },
  { id: "rsi", bloc: "meanReversion", measure: "RSI14 - 50", divisor: "sigma100", sign: -1, volume: false },
  { id: "stochastic", bloc: "meanReversion", measure: "%K14 - 50", divisor: "sigma100", sign: -1, volume: false },
  { id: "cci", bloc: "trend", measure: "CCI20", divisor: "sigma100", sign: 1, volume: false },
  { id: "williams", bloc: "meanReversion", measure: "%R14 + 50", divisor: "sigma100", sign: -1, volume: false },
  { id: "ao", bloc: "trend", measure: "AO (SMA5 - SMA34 of the median price)", divisor: "atr14", sign: 1, volume: false },
  { id: "mfi", bloc: "meanReversion", measure: "MFI14 - 50", divisor: "sigma100", sign: -1, volume: true },
  { id: "bollinger", bloc: "breakout", measure: "close - SMA20", divisor: "band", sign: 1, volume: false },
  { id: "keltner", bloc: "breakout", measure: "close - EMA20", divisor: "band", sign: 1, volume: false },
  { id: "vwap", bloc: "flow", measure: "close - VWAP (session-anchored < 1d, 20-bar otherwise)", divisor: "atr14", sign: 1, volume: true },
  { id: "obv", bloc: "flow", measure: "OBV - SMA20(OBV)", divisor: "sigma100", sign: 1, volume: true },
  { id: "cmf", bloc: "flow", measure: "CMF20", divisor: "sigma100", sign: 1, volume: true },
];

export function contrarianDropped(intervalMs: number): boolean {
  return intervalMs >= V2_DROP_FROM_MS;
}

const DAY_MS = 86_400_000;
const fin = (v: number): boolean => Number.isFinite(v);
const clamp = (x: number): number => Math.min(V2_CLIP, Math.max(-V2_CLIP, x)) + 0; // + 0: no -0

/**
 * Population sigma of values[j-n+1 .. j] (two-pass). NaN unless all n values are finite.
 * Returns exactly 0 when sigma is rounding noise on a constant window: sigma <= 1e-9 x mean|value|
 * (e.g. 100 x 0.1 gives 0, not 1.9e-16).
 */
export function rollingSigmaAt(values: ArrayLike<number>, j: number, n = V2_SIGMA_BARS): number {
  if (j < n - 1 || j >= values.length) return NaN;
  let sum = 0, sumAbs = 0;
  for (let i = j - n + 1; i <= j; i++) {
    const v = values[i];
    if (!fin(v)) return NaN;
    sum += v;
    sumAbs += Math.abs(v);
  }
  const mean = sum / n;
  let variance = 0;
  for (let i = j - n + 1; i <= j; i++) {
    const d = values[i] - mean;
    variance += d * d;
  }
  const sigma = Math.sqrt(variance / n);
  return sigma <= V2_DIVISOR_FLOOR * (sumAbs / n) ? 0 : sigma;
}

/** Natural scale of each input, for the divisor floor. */
const SCALE_KIND: Record<VotingIndicatorId, "price" | "osc" | "unit" | "volume"> = {
  sma: "price", ema: "price", macd: "price", adx: "osc", psar: "price", ichimoku: "price", supertrend: "price",
  rsi: "osc", stochastic: "osc", cci: "osc", williams: "osc", ao: "price", mfi: "osc", bollinger: "price",
  keltner: "price", vwap: "price", obv: "volume", cmf: "unit",
};

const nan = (n: number): Float64Array => new Float64Array(n).fill(NaN);

/* ---- per-bar raw measures (Classic's formulas, evaluated at every bar) ------------------------ */

function rawSma(k: Kline[], closes: number[]): Float64Array {
  const a = sma(closes, 20), b = sma(closes, 50), out = nan(k.length);
  for (let j = 0; j < k.length; j++) { const v = a[j] - b[j]; if (fin(v)) out[j] = v; }
  return out;
}
function rawEma(k: Kline[], closes: number[]): Float64Array {
  const a = ema(closes, 9), b = ema(closes, 21), out = nan(k.length);
  for (let j = 0; j < k.length; j++) { const v = a[j] - b[j]; if (fin(v)) out[j] = v; }
  return out;
}
function rawMacd(k: Kline[]): Float64Array {
  const h = macdHistogram(k), out = nan(k.length);
  for (let j = 0; j < k.length; j++) if (fin(h[j].histogram)) out[j] = h[j].histogram;
  return out;
}
/** +DI14 - -DI14 (Wilder), as indADX builds them. */
function rawAdx(k: Kline[]): Float64Array {
  const n = k.length, period = 14, out = nan(n);
  if (n <= period) return out;
  const plusDM = new Array<number>(n).fill(0), minusDM = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = k[i].high - k[i - 1].high, down = k[i - 1].low - k[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const a14 = atr(k, period);
  let pSum = 0, mSum = 0;
  for (let i = 1; i <= period; i++) { pSum += plusDM[i]; mSum += minusDM[i]; }
  let pSmooth = pSum, mSmooth = mSum;
  for (let i = period; i < n; i++) {
    if (i > period) { pSmooth = pSmooth - pSmooth / period + plusDM[i]; mSmooth = mSmooth - mSmooth / period + minusDM[i]; }
    const a = a14[i];
    if (fin(a) && a > 0) out[i] = 100 * (pSmooth / period) / a - 100 * (mSmooth / period) / a;
  }
  return out;
}
function rawPsar(k: Kline[]): Float64Array {
  const n = k.length, out = nan(n);
  if (n < 5) return out;
  let isBull = true, af = 0.02, ep = k[0].high, s = k[0].low;
  for (let i = 1; i < n; i++) {
    s = s + af * (ep - s);
    if (isBull) {
      if (k[i].low < s) { isBull = false; s = ep; ep = k[i].low; af = 0.02; }
      else if (k[i].high > ep) { ep = k[i].high; af = Math.min(af + 0.02, 0.2); }
    } else if (k[i].high > s) { isBull = true; s = ep; ep = k[i].high; af = 0.02; }
    else if (k[i].low < ep) { ep = k[i].low; af = Math.min(af + 0.02, 0.2); }
    if (i >= 4 && fin(s)) out[i] = k[i].close - s;
  }
  return out;
}
function rawIchimoku(k: Kline[]): Float64Array {
  const n = k.length, out = nan(n), displacement = 26;
  const hi = (p: number, i: number) => { let m = -Infinity; for (let x = Math.max(0, i - p + 1); x <= i; x++) if (k[x].high > m) m = k[x].high; return m; };
  const lo = (p: number, i: number) => { let m = Infinity; for (let x = Math.max(0, i - p + 1); x <= i; x++) if (k[x].low < m) m = k[x].low; return m; };
  for (let j = 0; j < n; j++) {
    const src = j - displacement;
    if (src < 51) continue;
    const tenkan = (hi(9, src) + lo(9, src)) / 2, kijun = (hi(26, src) + lo(26, src)) / 2;
    const spanA = (tenkan + kijun) / 2, spanB = (hi(52, src) + lo(52, src)) / 2;
    if (!fin(spanA) || !fin(spanB)) continue;
    const top = Math.max(spanA, spanB), bot = Math.min(spanA, spanB);
    out[j] = k[j].close - (top + bot) / 2;
  }
  return out;
}
function rawSupertrend(k: Kline[]): Float64Array {
  const n = k.length, mult = 3, a10 = atr(k, 10), out = nan(n);
  const upper = nan(n), lower = nan(n);
  let dir = 0;
  for (let i = 0; i < n; i++) {
    if (!fin(a10[i])) continue;
    const basis = (k[i].high + k[i].low) / 2, ub = basis + mult * a10[i], lb = basis - mult * a10[i];
    upper[i] = i > 0 && fin(upper[i - 1]) ? (ub < upper[i - 1] || k[i - 1].close > upper[i - 1] ? ub : upper[i - 1]) : ub;
    lower[i] = i > 0 && fin(lower[i - 1]) ? (lb > lower[i - 1] || k[i - 1].close < lower[i - 1] ? lb : lower[i - 1]) : lb;
    if (dir === 0) dir = k[i].close >= basis ? 1 : -1;
    else if (dir === 1 && k[i].close < lower[i]) dir = -1;
    else if (dir === -1 && k[i].close > upper[i]) dir = 1;
    const line = dir === 1 ? lower[i] : upper[i];
    if (fin(line)) out[i] = k[i].close - line;
  }
  return out;
}
/** RSI14 - 50 (Wilder). 50 when there are no gains and no losses. */
function rawRsi(closes: number[]): Float64Array {
  const n = closes.length, period = 14, out = nan(n);
  if (n < period + 1) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const ch = closes[i] - closes[i - 1]; if (ch >= 0) gain += ch; else loss -= ch; }
  let avgG = gain / period, avgL = loss / period;
  const rsiOf = (g: number, l: number) => (g === 0 && l === 0 ? 50 : l === 0 ? 100 : 100 - 100 / (1 + g / l));
  out[period] = rsiOf(avgG, avgL) - 50;
  for (let i = period + 1; i < n; i++) {
    const ch = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + (ch >= 0 ? ch : 0)) / period;
    avgL = (avgL * (period - 1) + (ch < 0 ? -ch : 0)) / period;
    out[i] = rsiOf(avgG, avgL) - 50;
  }
  return out;
}
/** %K14 - 50; 50 on a flat range. */
function rawStoch(k: Kline[]): Float64Array {
  const n = k.length, period = 14, out = nan(n);
  for (let i = period - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) { if (k[j].high > hh) hh = k[j].high; if (k[j].low < ll) ll = k[j].low; }
    out[i] = (hh === ll ? 50 : (100 * (k[i].close - ll)) / (hh - ll)) - 50;
  }
  return out;
}
/** CCI20; 0 when the mean deviation is 0. */
function rawCci(k: Kline[]): Float64Array {
  const n = k.length, period = 20, out = nan(n);
  const tp = k.map((c) => (c.high + c.low + c.close) / 3), m = sma(tp, period);
  for (let i = period - 1; i < n; i++) {
    if (!fin(m[i])) continue;
    let dev = 0;
    for (let j = i - period + 1; j <= i; j++) dev += Math.abs(tp[j] - m[i]);
    dev /= period;
    const c = dev === 0 ? 0 : (tp[i] - m[i]) / (0.015 * dev);
    if (fin(c)) out[i] = c;
  }
  return out;
}
/** Williams %R14 + 50; %R is -50 on a flat range. */
function rawWilliams(k: Kline[]): Float64Array {
  const n = k.length, period = 14, out = nan(n);
  for (let i = period - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) { if (k[j].high > hh) hh = k[j].high; if (k[j].low < ll) ll = k[j].low; }
    const w = hh === ll ? -50 : (-100 * (hh - k[i].close)) / (hh - ll);
    if (fin(w)) out[i] = w + 50;
  }
  return out;
}
function rawAo(k: Kline[]): Float64Array {
  const med = k.map((c) => (c.high + c.low) / 2), a = sma(med, 5), b = sma(med, 34), out = nan(k.length);
  for (let j = 0; j < k.length; j++) { const v = a[j] - b[j]; if (fin(v)) out[j] = v; }
  return out;
}
/** MFI14 - 50; 50 when there is no positive and no negative flow. */
function rawMfi(k: Kline[]): Float64Array {
  const n = k.length, period = 14, out = nan(n);
  if (n < period + 1) return out;
  const tp = k.map((c) => (c.high + c.low + c.close) / 3), mf = tp.map((v, i) => v * k[i].volume);
  let pos = 0, neg = 0;
  for (let i = 1; i <= period; i++) { if (tp[i] > tp[i - 1]) pos += mf[i]; else if (tp[i] < tp[i - 1]) neg += mf[i]; }
  const mfiOf = (p: number, q: number) => (p === 0 && q === 0 ? 50 : q === 0 ? 100 : 100 - 100 / (1 + p / q));
  out[period] = mfiOf(pos, neg) - 50;
  for (let i = period + 1; i < n; i++) {
    const oldPos = tp[i - period] > tp[i - period - 1] ? mf[i - period] : 0;
    const oldNeg = tp[i - period] < tp[i - period - 1] ? mf[i - period] : 0;
    pos = pos - oldPos + (tp[i] > tp[i - 1] ? mf[i] : 0);
    neg = neg - oldNeg + (tp[i] < tp[i - 1] ? mf[i] : 0);
    const v = mfiOf(pos, neg) - 50;
    if (fin(v)) out[i] = v;
  }
  return out;
}
function rawBollinger(k: Kline[], closes: number[]): { raw: Float64Array; band: Float64Array } {
  const n = k.length, m = sma(closes, 20), raw = nan(n), band = nan(n);
  for (let j = 0; j < n; j++) {
    const s = rollingSigmaAt(closes, j, 20);
    if (fin(m[j]) && fin(s)) { raw[j] = closes[j] - m[j]; band[j] = 2 * s; }
  }
  return { raw, band };
}
function rawKeltner(k: Kline[], closes: number[]): { raw: Float64Array; band: Float64Array } {
  const n = k.length, m = ema(closes, 20), a10 = atr(k, 10), raw = nan(n), band = nan(n);
  for (let j = 0; j < n; j++) if (fin(m[j]) && fin(a10[j])) { raw[j] = closes[j] - m[j]; band[j] = 2 * a10[j]; }
  return { raw, band };
}
/** close - VWAP. Session-anchored (UTC day) below 1d, else the last 20 bars; < 3 session bars fall back to 20 bars. */
function rawVwap(k: Kline[], intervalMs: number): Float64Array {
  const n = k.length, out = nan(n);
  let sessDay = NaN, sessStart = 0, cumPV = 0, cumV = 0;
  for (let j = 0; j < n; j++) {
    const c = k[j], tp = (c.high + c.low + c.close) / 3;
    if (intervalMs < DAY_MS) {
      const day = c.time - (c.time % DAY_MS); // = Classic's Math.floor(t / DAY) * DAY for t >= 0
      if (day !== sessDay) { sessDay = day; sessStart = j; cumPV = 0; cumV = 0; }
      cumPV += tp * c.volume;
      cumV += c.volume;
    }
    let pv = 0, v = 0;
    if (intervalMs < DAY_MS && j - sessStart + 1 >= 3) { pv = cumPV; v = cumV; }
    else {
      for (let x = Math.max(0, j - 19); x <= j; x++) { pv += ((k[x].high + k[x].low + k[x].close) / 3) * k[x].volume; v += k[x].volume; }
    }
    if (v <= 0) continue;
    const vwap = pv / v;
    if (fin(vwap)) out[j] = c.close - vwap;
  }
  return out;
}
/** OBV - SMA20(OBV); needs 21 bars and some traded volume. */
function rawObv(k: Kline[]): Float64Array {
  const n = k.length, out = nan(n);
  const obv = new Array<number>(n).fill(0), total = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    total[i] = total[i - 1] + k[i].volume;
    if (k[i].close > k[i - 1].close) obv[i] = obv[i - 1] + k[i].volume;
    else if (k[i].close < k[i - 1].close) obv[i] = obv[i - 1] - k[i].volume;
    else obv[i] = obv[i - 1];
  }
  const avg = sma(obv, 20); // running-sum SMA: the value at bar i never depends on later bars
  for (let i = 20; i < n; i++) if (total[i] > 0 && fin(avg[i])) out[i] = obv[i] - avg[i];
  return out;
}
/** CMF20 (Chaikin); needs 20 bars and some traded volume in the window. */
function rawCmf(k: Kline[]): Float64Array {
  const n = k.length, period = 20, out = nan(n);
  const mfv = k.map((c) => { const r = c.high - c.low; return r === 0 ? 0 : (((c.close - c.low) - (c.high - c.close)) / r) * c.volume; });
  for (let i = period - 1; i < n; i++) {
    let sm = 0, sv = 0;
    for (let x = i - period + 1; x <= i; x++) { sm += mfv[x]; sv += k[x].volume; }
    if (sv <= 0) continue;
    const v = sm / sv;
    if (fin(v)) out[i] = v;
  }
  return out;
}

/**
 * The 18 standardised inputs. `raw` covers every bar; `z[j]` exists only for j >= `from`.
 * z is NaN (never 0, never +-1) when the raw value or the divisor is not finite, when the
 * divisor is <= 0, when the input is dropped (contrarian at >= 4h) or needs volume that
 * the venue does not supply.
 */
export function v2InputSeries(k: Kline[], o: { intervalMs: number; volumeAvailable: boolean }, from: number): V2InputSeries[] {
  const n = k.length;
  const closes = k.map((c) => c.close);
  const atr14 = atr(k, V2_ATR);
  const boll = rawBollinger(k, closes), kelt = rawKeltner(k, closes);
  const raws: Record<VotingIndicatorId, Float64Array> = {
    sma: rawSma(k, closes), ema: rawEma(k, closes), macd: rawMacd(k), adx: rawAdx(k), psar: rawPsar(k),
    ichimoku: rawIchimoku(k), supertrend: rawSupertrend(k), rsi: rawRsi(closes), stochastic: rawStoch(k),
    cci: rawCci(k), williams: rawWilliams(k), ao: rawAo(k), mfi: rawMfi(k), bollinger: boll.raw, keltner: kelt.raw,
    vwap: rawVwap(k, o.intervalMs), obv: rawObv(k), cmf: rawCmf(k),
  };
  const bands: Partial<Record<VotingIndicatorId, Float64Array>> = { bollinger: boll.band, keltner: kelt.band };
  const dropAll = contrarianDropped(o.intervalMs);
  const cumVol = new Float64Array(n);
  for (let j = 0; j < n; j++) cumVol[j] = (j > 0 ? cumVol[j - 1] : 0) + (fin(k[j].volume) ? Math.abs(k[j].volume) : 0);

  return V2_INPUTS.map((spec): V2InputSeries => {
    const raw = raws[spec.id];
    const z = nan(n);
    const dropped = dropAll && (V2_CONTRARIAN as readonly string[]).includes(spec.id);
    if (!dropped && !(spec.volume && !o.volumeAvailable)) {
      for (let j = Math.max(0, from); j < n; j++) {
        const divisor = spec.divisor === "atr14" ? atr14[j] : spec.divisor === "band" ? bands[spec.id]![j] : rollingSigmaAt(raw, j);
        const kind = SCALE_KIND[spec.id];
        const scale = kind === "price" ? Math.abs(closes[j]) : kind === "osc" ? 100 : kind === "unit" ? 1 : cumVol[j];
        if (!fin(raw[j]) || !fin(divisor) || divisor <= 0 || divisor <= V2_DIVISOR_FLOOR * scale) continue;
        z[j] = clamp((spec.sign * raw[j]) / divisor);
      }
    }
    return { id: spec.id, bloc: spec.bloc, raw, z, dropped };
  });
}

/**
 * z of every input at bar `j` of a series computed once by `v2InputSeries`, in V2_INPUTS order
 * (NaN for an out-of-range bar). Because raw[j] and z[j] are causal, this equals recomputing on
 * `k.slice(0, j + 1)`, at a few microseconds per row: compute the series once, then slice per row.
 */
export function v2RowAt(series: readonly V2InputSeries[], j: number): Float64Array {
  const out = new Float64Array(series.length).fill(NaN);
  for (let i = 0; i < series.length; i++) if (j >= 0 && j < series[i].z.length) out[i] = series[i].z[j];
  return out;
}
