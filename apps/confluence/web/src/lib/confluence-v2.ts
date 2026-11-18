/**
 * Confluence v2 — v2.8 (WP23 Task 3). Pure code: the hidden challenger scored beside Classic.
 *
 * Score. At every bar j the 18 standardised inputs of `confluence-v2-inputs.ts` (all 18 on every
 * interval: the owner kept the contrarian bloc on >= 4h, WP23 Task 4 rework) are averaged per bloc;
 * the bloc means are combined with Classic's bloc weights (meanReversion x (1 - g_j), g_j = Classic's efficiency-ratio gate over the
 * 40 bars ending at j; every other bloc 1) into a mean in [-1, 1], and
 *   score_j = round(100 x clamp(V2_GAIN x mean_j, -1, 1)).
 * A bar with fewer than ceil(voters x MIN_VALID_VOTING_SHARE) finite inputs has no score (null).
 *
 * Label (hysteresis 55/40, no stored state). The label of a row is the hysteresis run over the
 * last V2_HYST_BARS per-bar scores INSIDE THE ROW'S OWN WINDOW (Classic's window: the last
 * ENGINE_BARS raw bars, session-filtered for stocks), starting NEUTRAL. Nothing is read from or
 * written to storage, so the app, the worker, the recorder, catch-up and replay give the same label
 * for the same bars. Recorded rows must call `scoreV2` on the row's own window: `v2RowAt` over a
 * longer precomputed series is display-only (it differs in the last bits, and for VWAP below 1d).
 *
 * Determinism: only + - * / Math.abs Math.min Math.max Math.round here, and the inputs module's
 * whitelist below it (no exp/log/pow/floor/ceil, no `**`): browsers, WebViews and Node agree bit-for-bit.
 * Classic is untouched; this module only reads its exports.
 */
import {
  MIN_VALID_VOTING_SHARE, ER_PERIOD, ER_GATE_LOW, ER_GATE_HIGH, LOW_VOLATILITY_PERCENTILE, indATR,
  type Kline, type SignalState,
} from "./indicators";
import { sessionBars, detectSplit, hasUsableVolume, type ScoreOptions } from "./scan-pipeline";
import { ENGINE_BARS, MIN_ENGINE_BARS } from "./engine-window";
import { hash64, stableStringify, fingerprintSeries } from "./engine-config";
import {
  V2_INPUTS, V2_SIGMA_BARS, V2_ATR, V2_CLIP, V2_DIVISOR_FLOOR, V2_CONTRARIAN,
  v2InputSeries, SCALE_KIND, type V2Bloc, type V2InputSeries,
} from "./confluence-v2-inputs";
import type { VotingIndicatorId } from "./scoring-profile";

/** Hashed into V2_PARAMS (and so into the v2 config id); not stored on rows. */
export const V2_ENGINE_VERSION = "cv2-1.0.0";
/** Enter a label at |score| >= 55; return to NEUTRAL below 40 (spec, fixed). */
export const V2_ENTER = 55;
export const V2_EXIT = 40;
/** Per-bar scores of the row's own window the hysteresis runs over. */
export const V2_HYST_BARS = 300;
/**
 * Noise-calibrated (WP23 Task 4, re-run in the rework with the contrarian bloc kept on every interval): the largest
 * gain on the 0.50..3.00 grid whose worst noise cell labels <= 6.0 % (worst 5.00 %; the next step, 0.85, gives 6.67 %).
 * Evidence: docs/research/evidence/wp23-v2-calibration-2026-11-18.json (npm run calibrate:v2); it supersedes the
 * 2026-11-17 file (gain 0.55, contrarian dropped on >= 4h), which is removed.
 */
export const V2_GAIN = 0.8;
/**
 * Noise-calibrated (same run): the smallest band in 56..100 whose worst noise cell has STRONG <= 1.5 % at V2_GAIN
 * (worst 1.33 %). Same evidence file.
 */
export const V2_STRONG_BAND = 64;

/** Bloc order of Classic's VOTING_BLOCS (sum order is part of the definition). */
const V2_BLOCS: readonly V2Bloc[] = ["trend", "meanReversion", "breakout", "flow"];

export const V2_PARAMS = {
  version: V2_ENGINE_VERSION,
  enter: V2_ENTER,
  exit: V2_EXIT,
  hystBars: V2_HYST_BARS,
  gain: V2_GAIN,
  strongBand: V2_STRONG_BAND,
  sigmaBars: V2_SIGMA_BARS,
  atr: V2_ATR,
  clip: V2_CLIP,
  divisorFloor: V2_DIVISOR_FLOOR,
  contrarian: [...V2_CONTRARIAN],
  inputs: V2_INPUTS.map((s) => [s.id, s.divisor, s.sign] as const),
  // Review M1: the bloc, the volume requirement and the divisor-floor scale are part of the definition too.
  inputBlocs: V2_INPUTS.map((s) => [s.id, s.bloc] as const),
  inputVolume: V2_INPUTS.map((s) => [s.id, s.volume] as const),
  inputScaleKind: V2_INPUTS.map((s) => [s.id, SCALE_KIND[s.id]] as const),
  minValidVotingShare: MIN_VALID_VOTING_SHARE,
  erPeriod: ER_PERIOD,
  erGate: [ER_GATE_LOW, ER_GATE_HIGH],
  lowVolatilityPercentile: LOW_VOLATILITY_PERCENTILE,
  engineBars: ENGINE_BARS,
  minEngineBars: MIN_ENGINE_BARS,
} as const;

export type V2State = -1 | 0 | 1;
export type V2Strength = "STRONG" | "MODERATE" | "WEAK";
export interface V2Input { id: VotingIndicatorId; bloc: V2Bloc; z: number | null }
export interface V2BlocScore { bloc: V2Bloc; score: number; valid: number; weight: number }
export interface V2Result {
  /** False below MIN_ENGINE_BARS engine bars (nothing scored). */
  usable: boolean;
  /** Raw window length (<= ENGINE_BARS), as Classic's warmBars. */
  warmBars: number;
  /** Time of the raw window's last bar (the bar toLedgerRow records); NaN for an empty series. */
  t: number;
  score: number;
  master: SignalState;
  strength: V2Strength;
  /** No score at the last bar (too few valid inputs, a stock split, or an unusable window). */
  suppressed: boolean;
  /** A label kept by the hysteresis while |score| < V2_ENTER. */
  held: boolean;
  lowVolatility: boolean;
  validCount: number;
  voters: number;
  blocs: V2BlocScore[];
  inputs: V2Input[];
  er: number | null;
  trendGate: number;
}

const fin = (v: number): boolean => Number.isFinite(v);

/** Classic's efficiency ratio of the ER_PERIOD bars ending at j (same formula and sum order as `efficiencyRatio`). */
function erAt(k: Kline[], j: number): number | null {
  if (j < ER_PERIOD || j >= k.length) return null;
  let path = 0;
  for (let i = j - ER_PERIOD + 1; i <= j; i++) path += Math.abs(k[i].close - k[i - 1].close);
  const net = Math.abs(k[j].close - k[j - ER_PERIOD].close);
  if (!fin(path) || !fin(net)) return null;
  return path === 0 ? 0 : net / path;
}
const gateOf = (er: number | null): number =>
  er === null ? 0 : Math.max(0, Math.min(1, (er - ER_GATE_LOW) / (ER_GATE_HIGH - ER_GATE_LOW)));

/** Index of each input's bloc in V2_BLOCS. */
const BLOC_INDEX: readonly number[] = V2_INPUTS.map((s) => V2_BLOCS.indexOf(s.bloc));

/**
 * Bloc means and the combined mean at bar j. `sums`/`counts` are caller-owned scratch (length 4).
 * Returns null when fewer than `minValid` inputs are finite.
 */
function meanAt(series: readonly V2InputSeries[], j: number, gate: number, minValid: number, sums: Float64Array, counts: Int32Array): number | null {
  sums.fill(0);
  counts.fill(0);
  let valid = 0;
  for (let i = 0; i < series.length; i++) {
    const z = series[i].z[j];
    if (!fin(z)) continue;
    valid++;
    sums[BLOC_INDEX[i]] += z;
    counts[BLOC_INDEX[i]]++;
  }
  if (valid < minValid) return null;
  let num = 0, den = 0;
  for (let b = 0; b < V2_BLOCS.length; b++) {
    const w = V2_BLOCS[b] === "meanReversion" ? 1 - gate : 1;
    if (counts[b] === 0 || !(w > 0)) continue;
    num += w * (sums[b] / counts[b]);
    den += w;
  }
  // den > 0 always holds here (the validity floor leaves the trend bloc non-empty); 0 mirrors Classic.
  return den > 0 ? num / den : 0;
}

/** ceil(voters x MIN_VALID_VOTING_SHARE), as Classic's floor, with whitelisted operations only (x > 0). */
function minValidOf(voters: number): number {
  const x = voters * MIN_VALID_VOTING_SHARE, r = Math.round(x);
  return r < x ? r + 1 : r;
}

/** Combined means of precomputed input series; null before `from` and on bars below the validity floor. */
function meansOf(series: readonly V2InputSeries[], k: Kline[], from: number): (number | null)[] {
  const n = k.length, out = new Array<number | null>(n).fill(null);
  const minValid = minValidOf(series.length);
  const sums = new Float64Array(V2_BLOCS.length), counts = new Int32Array(V2_BLOCS.length);
  for (let j = Math.max(0, from); j < n; j++) out[j] = meanAt(series, j, gateOf(erAt(k, j)), minValid, sums, counts);
  return out;
}

/** Per-bar v2 mean in [-1, 1], aligned to `k`, null before `from` and where too few inputs are valid. */
export function v2MeanSeries(k: Kline[], o: { intervalMs: number; volumeAvailable: boolean }, from: number): (number | null)[] {
  const f = Math.max(0, from);
  return meansOf(v2InputSeries(k, o, f), k, f);
}

/** round(100 x clamp(gain x mean, -1, 1)); null stays null (never -0, never NaN). */
export function scoresFromMeans(means: (number | null)[], gain: number): (number | null)[] {
  return means.map((m) => {
    if (m === null || !fin(m)) return null;
    const s = Math.round(100 * Math.max(-1, Math.min(1, gain * m))) + 0;
    return fin(s) ? s : null;
  });
}

export function v2ScoreSeries(k: Kline[], o: { intervalMs: number; volumeAvailable: boolean }, from: number): (number | null)[] {
  return scoresFromMeans(v2MeanSeries(k, o, from), V2_GAIN);
}

/** One bar of the 55/40 hysteresis. No data resets to NEUTRAL; exit is tested before entry. */
export function hysteresisStep(state: V2State, s: number | null): V2State {
  if (s === null || !fin(s)) return 0;
  let next: V2State = state;
  if (next === 1 && s < V2_EXIT) next = 0;
  else if (next === -1 && s > -V2_EXIT) next = 0;
  if (next === 0) {
    if (s >= V2_ENTER) next = 1;
    else if (s <= -V2_ENTER) next = -1;
  }
  return next;
}

/** States from NEUTRAL at index `from` (null before it). */
export function v2States(scores: (number | null)[], from: number): (V2State | null)[] {
  const out = new Array<V2State | null>(scores.length).fill(null);
  let st: V2State = 0;
  for (let j = Math.max(0, from); j < scores.length; j++) out[j] = st = hysteresisStep(st, scores[j]);
  return out;
}

/** The last state of `v2States(scores, from)` (NEUTRAL for an empty run). */
export function runHysteresis(scores: (number | null)[], from: number): V2State {
  let st: V2State = 0;
  for (let j = Math.max(0, from); j < scores.length; j++) st = hysteresisStep(st, scores[j]);
  return st;
}

export function v2Strength(master: SignalState, score: number, lowVolatility: boolean, fx: boolean): V2Strength {
  if (master === "NEUTRAL") return "WEAK";
  const sameSign = master === "BULLISH" ? score > 0 : score < 0;
  const s: V2Strength = sameSign && Math.abs(score) >= V2_STRONG_BAND ? "STRONG" : "MODERATE";
  return s === "STRONG" && lowVolatility && !fx ? "MODERATE" : s;
}

const masterOf = (s: V2State): SignalState => (s === 1 ? "BULLISH" : s === -1 ? "BEARISH" : "NEUTRAL");

function blankResult(usable: boolean, warmBars: number, t: number): V2Result {
  return {
    usable, warmBars, t, score: 0, master: "NEUTRAL", strength: "WEAK", suppressed: true, held: false,
    lowVolatility: false, validCount: 0, voters: V2_INPUTS.length, blocs: [], inputs: [], er: null, trendGate: 0,
  };
}

/**
 * Score the newest bar of `k` with Confluence v2, using `scoreSeries`' window rules: the last
 * ENGINE_BARS raw bars, regular-session bars for stocks, MIN_ENGINE_BARS, the split guard and the
 * volume check. The scoring profile is ignored (v2 is a fixed challenger). Depends only on the
 * row's own window, so every path that scores the same bars gets the same result.
 */
export function scoreV2(k: Kline[], options: ScoreOptions): V2Result {
  const raw = k.length > ENGINE_BARS ? k.slice(-ENGINE_BARS) : k;
  const t = raw.length ? raw[raw.length - 1].time : NaN;
  const engineBars = sessionBars(raw, options.assetClass, options.intervalMs);
  if (engineBars.length < MIN_ENGINE_BARS) return blankResult(false, raw.length, t);
  if (options.assetClass === "stock" && detectSplit(engineBars)) return blankResult(true, raw.length, t);

  const o = { intervalMs: options.intervalMs, volumeAvailable: options.volumeAvailable && hasUsableVolume(engineBars) };
  const n = engineBars.length;
  const from = Math.max(0, n - V2_HYST_BARS);
  const series = v2InputSeries(engineBars, o, from);
  const scores = scoresFromMeans(meansOf(series, engineBars, from), V2_GAIN);
  const state = runHysteresis(scores, from);
  const last = scores[n - 1];

  const atrResult = indATR(engineBars);
  const lowVolatility = atrResult.valid && atrResult.value !== null && atrResult.value < LOW_VOLATILITY_PERCENTILE;
  const er = erAt(engineBars, n - 1);
  const trendGate = gateOf(er);

  // Last-bar breakdown (display and fingerprint only; the score above is the definition).
  const inputs: V2Input[] = series.map((s) => ({ id: s.id, bloc: s.bloc, z: fin(s.z[n - 1]) ? s.z[n - 1] : null }));
  const blocs: V2BlocScore[] = V2_BLOCS.map((bloc) => {
    let sum = 0, valid = 0;
    for (const x of inputs) if (x.bloc === bloc && x.z !== null) { sum += x.z; valid++; }
    return { bloc, score: valid ? sum / valid : 0, valid, weight: bloc === "meanReversion" ? 1 - trendGate : 1 };
  });
  const validCount = inputs.reduce((c, x) => c + (x.z !== null ? 1 : 0), 0);
  const voters = series.length;

  const suppressed = last === null;
  const score = suppressed ? 0 : last;
  const master = masterOf(state);
  return {
    usable: true,
    warmBars: raw.length,
    t,
    score,
    master,
    strength: suppressed ? "WEAK" : v2Strength(master, score, lowVolatility, options.assetClass === "fx"),
    suppressed,
    held: master !== "NEUTRAL" && Math.abs(score) < V2_ENTER,
    lowVolatility,
    validCount,
    voters,
    blocs,
    inputs,
    er,
    trendGate,
  };
}

/** The compact ledger field (LedgerRow.v2). Logged, never scored. */
export interface V2Compact { cfg: string; s: number | null; m: -1 | 0 | 1; st: 0 | 1 | 2 }

/** Null unless `r` is usable and scored the bar at time `t`. */
export function v2Compact(r: V2Result | null | undefined, t: number): V2Compact | null {
  if (!r?.usable || r.t !== t) return null;
  return {
    cfg: v2ConfigId(),
    s: r.suppressed ? null : r.score,
    m: r.master === "BULLISH" ? 1 : r.master === "BEARISH" ? -1 : 0,
    st: r.strength === "STRONG" ? 2 : r.strength === "MODERATE" ? 1 : 0,
  };
}

/** The opt-in detail line (Task 8): i18n key and variables. */
export function v2LineModel(r: V2Result | null | undefined): {
  key: "v2.line" | "v2.lineHeld" | "v2.lineNoData";
  master: SignalState;
  strength: V2Result["strength"];
  vars: { score: string; exit: number };
} {
  const noData = !r || !r.usable || r.suppressed;
  const score = noData ? 0 : r.score;
  return {
    key: noData ? "v2.lineNoData" : r.held ? "v2.lineHeld" : "v2.line",
    master: noData ? "NEUTRAL" : r.master,
    strength: noData ? "WEAK" : r.strength,
    vars: { score: `${score > 0 ? "+" : ""}${score}`, exit: V2_EXIT },
  };
}

/** v2's observable behaviour on the fixed fingerprint series (cuts and variants as Classic's). */
export function v2Fingerprint(): string {
  const series = fingerprintSeries();
  const H = 3_600_000;
  const DAY = 86_400_000;
  const snap = (r: V2Result) => ({
    score: r.score, master: r.master, strength: r.strength, held: r.held, validCount: r.validCount, z: r.inputs.map((x) => x.z),
  });
  const cuts = [300, 600, 1100].flatMap((n) => [H, 4 * H].map((intervalMs) =>
    ({ n, intervalMs, ...snap(scoreV2(series.slice(0, n), { intervalMs, volumeAvailable: true })) })));
  const zeroVolume = series.map((b) => ({ ...b, volume: 0 }));
  const variants = [
    scoreV2(series, { intervalMs: H, volumeAvailable: true, assetClass: "fx" }),
    scoreV2(zeroVolume, { intervalMs: H, volumeAvailable: true }),
    scoreV2(series, { intervalMs: H, volumeAvailable: true, assetClass: "stock" }),
    // behaviourFingerprint's stock split variant (1d, second part halved).
    scoreV2(series.map((b, i) => (i < 900 ? b : { ...b, open: b.open / 2, high: b.high / 2, low: b.low / 2, close: b.close / 2 })),
      { intervalMs: DAY, volumeAvailable: true, assetClass: "stock" }),
  ].map(snap);
  return hash64(stableStringify({ cuts, variants }));
}

let cachedV2Id: string | null = null;

/** 16-hex identifier of the v2 engine (computed once). Distinct from Classic's engineConfigId. */
export function v2ConfigId(): string {
  if (cachedV2Id) return cachedV2Id;
  cachedV2Id = hash64(stableStringify({ engine: "confluence-v2", params: V2_PARAMS, behaviour: v2Fingerprint() }));
  return cachedV2Id;
}
