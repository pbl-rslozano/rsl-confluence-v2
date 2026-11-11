/**
 * Historical analogue engine for confluence/reversal sequences.
 *
 * This is deliberately an evidence-based nearest-neighbour model rather than
 * a black-box predictor. It compares the last four closed-bar states with
 * states earlier in the same asset history, then measures what price did over
 * the following six bars. No future bar is used in the current feature vector.
 *
 * Build 2.02:
 *  - SPEED. Snapshot states are memoised per closed bar (closed bars never
 *    change), so after the first scan only new bars are computed. 2.01 re-ran
 *    up to 560 full engine passes per asset on every refresh (~380 ms/asset at
 *    5,000 bars, on the UI thread).
 *  - INDEPENDENT OUTCOMES. Anchors are spaced at least HORIZON_BARS apart, so
 *    no two analogue outcome windows overlap and each match is a separate
 *    observation (2.01 could space anchors 2 bars apart against a 6-bar
 *    horizon and count the same move up to three times).
 *  - BASE RATE. The direction must beat the asset's own unconditional 6-bar
 *    up/down rate over the same anchors by MIN_EDGE, with at least MIN_MATCHES
 *    analogues. In a rising market most 6-bar windows are up regardless of
 *    similarity; 2.01 reported that drift as pattern evidence.
 *  - CONSISTENT FEATURES. The current sequence is scored on the same trailing
 *    180-bar window as the historical ones.
 */
import { runConfluence, type ConfluenceResult, type Kline } from "./indicators";
import { detectReversal, type ReversalResult, type TrendDir } from "./reversal";

export type PatternDirection = "UP" | "DOWN" | "NONE";
export type PatternConfidence = "HIGH" | "MODERATE" | "LOW" | "NONE";

export interface PatternMatch {
  time: number;
  similarity: number;
  forwardReturnPct: number;
}

export interface PatternSignal {
  direction: PatternDirection;
  confidence: PatternConfidence;
  matches: number;
  winRate: number;
  expectedMovePct: number;
  averageSimilarity: number;
  horizonBars: number;
  /** Share of all evaluated anchors whose 6-bar outcome matched `direction`. */
  baseRate: number;
  summary: string;
  analogues: PatternMatch[];
}

interface Snapshot {
  index: number;
  time: number;
  score: number;
  reversalScore: number;
  trend: TrendDir;
}

const MIN_BARS = 110;
const FEATURE_BARS = 4;
const HORIZON_BARS = 6;
const MAX_HISTORY_ANCHORS = 140;
const MIN_SIMILARITY = 0.72;
const MIN_MATCHES = 5;
const MAX_MATCHES = 12;
/** Directional agreement must exceed the asset's base rate by this much. */
const MIN_EDGE = 0.10;
/** Trailing context used to score every snapshot (current and historical). */
const SNAPSHOT_WINDOW = 180;

/* -------------------------------------------------------------------------- *
 *  Snapshot memo — closed bars are immutable, so a bar's snapshot never changes
 *  once its trailing window is complete. Keyed by series key → bar time.
 * -------------------------------------------------------------------------- */
const MAX_CACHED_SERIES = 400;
const MAX_SNAPSHOTS_PER_SERIES = 6_000;
const snapshotCache = new Map<string, Map<number, Snapshot | null>>();

function seriesCache(key: string | undefined): Map<number, Snapshot | null> | null {
  if (!key) return null;
  let m = snapshotCache.get(key);
  if (!m) {
    if (snapshotCache.size >= MAX_CACHED_SERIES) {
      const oldest = snapshotCache.keys().next().value;
      if (oldest !== undefined) snapshotCache.delete(oldest);
    }
    m = new Map();
    snapshotCache.set(key, m);
  } else {
    // refresh LRU position
    snapshotCache.delete(key);
    snapshotCache.set(key, m);
  }
  if (m.size > MAX_SNAPSHOTS_PER_SERIES) m.clear();
  return m;
}

/** Drop memoised snapshots for one series (e.g. after a history repair). */
export function clearPatternCache(key?: string): void {
  if (key) snapshotCache.delete(key);
  else snapshotCache.clear();
}

export const emptySignal = (summary: string): PatternSignal => ({
  direction: "NONE",
  confidence: "NONE",
  matches: 0,
  winRate: 0,
  expectedMovePct: 0,
  averageSimilarity: 0,
  horizonBars: HORIZON_BARS,
  baseRate: 0,
  summary,
  analogues: [],
});

function trendValue(trend: TrendDir): number {
  return trend === "UPTREND" ? 1 : trend === "DOWNTREND" ? -1 : 0;
}

function snapshot(
  klines: Kline[],
  index: number,
  volumeAvailable: boolean,
  intervalMs: number,
  cache: Map<number, Snapshot | null> | null,
): Snapshot | null {
  const time = klines[index].time;
  // Only memoise once the trailing window is complete; earlier snapshots
  // depend on how much history happened to be loaded.
  const cacheable = cache !== null && index >= SNAPSHOT_WINDOW - 1;
  if (cacheable && cache.has(time)) {
    const hit = cache.get(time) ?? null;
    return hit ? { ...hit, index } : null;
  }
  // Indicators only need a bounded trailing context. Keeping this window
  // bounded lets the analogue search span years without quadratic work.
  const bars = klines.slice(Math.max(0, index - (SNAPSHOT_WINDOW - 1)), index + 1);
  const confluence = runConfluence(bars, { volumeAvailable, intervalMs });
  const reversal = detectReversal(bars);
  const point: Snapshot | null = confluence.suppressed
    ? null
    : {
        index,
        time,
        score: confluence.score,
        reversalScore: reversal.score,
        trend: reversal.currentTrend,
      };
  if (cacheable) cache.set(time, point);
  return point;
}

function sequenceSimilarity(a: Snapshot[], b: Snapshot[]): number {
  let distance = 0;
  for (let i = 0; i < FEATURE_BARS; i++) {
    distance += 0.55 * Math.min(1, Math.abs(a[i].score - b[i].score) / 100);
    distance += 0.25 * Math.min(1, Math.abs(a[i].reversalScore - b[i].reversalScore) / 4);
    distance += 0.20 * (Math.abs(trendValue(a[i].trend) - trendValue(b[i].trend)) / 2);
  }
  return Math.max(0, 1 - distance / FEATURE_BARS);
}

export function detectHistoricalPattern(
  klines: Kline[],
  options: {
    volumeAvailable: boolean;
    intervalMs: number;
    currentConfluence: ConfluenceResult;
    currentReversal: ReversalResult;
    /** Stable id of this series (source:interval:symbol) — enables memoisation. */
    cacheKey?: string;
  },
): PatternSignal {
  if (klines.length < MIN_BARS) {
    return emptySignal(`Need at least ${MIN_BARS} closed bars for pattern history.`);
  }
  const cache = seriesCache(options.cacheKey);

  const lastIndex = klines.length - 1;
  const current: Snapshot[] = [];
  for (let index = lastIndex - FEATURE_BARS + 1; index <= lastIndex; index++) {
    // Same 180-bar window as the historical snapshots (2.02), so the current
    // feature vector is defined exactly like the ones it is compared against.
    const point = snapshot(klines, index, options.volumeAvailable, options.intervalMs, cache);
    if (!point) return emptySignal("Current sequence has insufficient confluence evidence.");
    current.push(point);
  }

  // Avoid expensive history scans when there is no reversal or meaningful
  // confluence turn in the current four-bar sequence.
  const scoreTurn = current[current.length - 1].score - current[0].score;
  const hasReversalContext =
    options.currentReversal.direction !== "NONE" ||
    Math.abs(scoreTurn) >= 20 ||
    current.some((point) => Math.abs(point.reversalScore) >= 1);
  if (!hasReversalContext) {
    return emptySignal("No active confluence-reversal sequence to compare.");
  }

  const candidates: PatternMatch[] = [];
  const firstAnchor = SNAPSHOT_WINDOW - 1 + FEATURE_BARS - 1;
  // The gap prevents a historical feature window and its measured outcome
  // from overlapping the current feature window.
  const finalAnchor = lastIndex - FEATURE_BARS - HORIZON_BARS;
  // Anchor spacing ≥ HORIZON_BARS: outcome windows never overlap (2.02).
  const stride = Math.max(HORIZON_BARS, Math.ceil((finalAnchor - firstAnchor + 1) / MAX_HISTORY_ANCHORS));
  // Align anchors to the END of history so the grid is stable as bars arrive,
  // which keeps the memo hit rate high.
  const startAnchor = finalAnchor - Math.floor((finalAnchor - firstAnchor) / stride) * stride;
  let evaluated = 0;
  let upOutcomes = 0;
  let downOutcomes = 0;
  for (let anchor = startAnchor; anchor <= finalAnchor; anchor += stride) {
    const sequence: Snapshot[] = [];
    let valid = true;
    for (let index = anchor - FEATURE_BARS + 1; index <= anchor; index++) {
      const point = snapshot(klines, index, options.volumeAvailable, options.intervalMs, cache);
      if (!point) {
        valid = false;
        break;
      }
      sequence.push(point);
    }
    if (!valid) continue;
    const entry = klines[anchor].close;
    const exit = klines[anchor + HORIZON_BARS].close;
    const forwardReturnPct = entry > 0 ? ((exit - entry) / entry) * 100 : 0;
    evaluated++;
    if (forwardReturnPct > 0) upOutcomes++;
    else if (forwardReturnPct < 0) downOutcomes++;
    const similarity = sequenceSimilarity(current, sequence);
    if (similarity < MIN_SIMILARITY) continue;
    candidates.push({ time: klines[anchor].time, similarity, forwardReturnPct });
  }

  const analogues = candidates
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, MAX_MATCHES);
  if (analogues.length < MIN_MATCHES) {
    return {
      ...emptySignal(`Only ${analogues.length} comparable historical sequence${analogues.length === 1 ? "" : "s"} found.`),
      matches: analogues.length,
      analogues,
    };
  }

  const weightedMove = analogues.reduce(
    (sum, match) => sum + match.forwardReturnPct * match.similarity,
    0,
  ) / analogues.reduce((sum, match) => sum + match.similarity, 0);
  const direction: PatternDirection =
    weightedMove > 0 ? "UP" : weightedMove < 0 ? "DOWN" : "NONE";
  const wins = analogues.filter((match) =>
    direction === "UP" ? match.forwardReturnPct > 0 : match.forwardReturnPct < 0,
  ).length;
  const winRate = direction === "NONE" ? 0 : wins / analogues.length;
  const averageSimilarity =
    analogues.reduce((sum, match) => sum + match.similarity, 0) / analogues.length;
  const baseRate =
    evaluated === 0 ? 0 : (direction === "DOWN" ? downOutcomes : upOutcomes) / evaluated;
  const edge = winRate - baseRate;

  // Abstain unless the analogues beat the asset's own base rate by MIN_EDGE
  // and reach 60% agreement. Similar-looking history that merely follows the
  // asset's drift is not pattern evidence.
  if (direction === "NONE" || winRate < 0.60 || edge < MIN_EDGE) {
    return {
      direction: "NONE",
      confidence: "NONE",
      matches: analogues.length,
      winRate,
      expectedMovePct: weightedMove,
      averageSimilarity,
      horizonBars: HORIZON_BARS,
      baseRate,
      summary:
        `${analogues.length} analogues: ${Math.round(winRate * 100)}% vs ` +
        `${Math.round(baseRate * 100)}% base rate — no edge over the asset's normal drift.`,
      analogues,
    };
  }

  let confidence: PatternConfidence = "LOW";
  if (analogues.length >= 10 && edge >= 0.25 && averageSimilarity >= 0.80) confidence = "HIGH";
  else if (analogues.length >= 8 && edge >= 0.17 && averageSimilarity >= 0.76) confidence = "MODERATE";

  return {
    direction,
    confidence,
    matches: analogues.length,
    winRate,
    expectedMovePct: weightedMove,
    averageSimilarity,
    horizonBars: HORIZON_BARS,
    baseRate,
    summary:
      `${analogues.length} independent analogues · ${Math.round(winRate * 100)}% moved ` +
      `${direction.toLowerCase()} over ${HORIZON_BARS} bars vs ${Math.round(baseRate * 100)}% base rate.`,
    analogues,
  };
}
