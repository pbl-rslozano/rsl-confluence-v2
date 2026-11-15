/**
 * ledger-metrics.ts — v2.1.1
 * ----------------------------------------------------------------------------
 * Signal-ledger row format, outcome measurement and performance statistics.
 * Pure: shared by the app's Performance view, CSV export and the Node replay.
 *
 * Statistics (v2.2 review fix): every bar is recorded, so consecutive outcomes
 * at horizon h share h−1 bars. Treating them as independent made the gate pass
 * pure noise about half the time. The report therefore (1) thins outcomes per
 * series so no two overlap (a signal inside an open holding window is
 * skipped, like a no-pyramiding rule), (2) computes the PSR on returns
 * averaged per non-overlapping time block of h bars (one portfolio return per
 * block, removing cross-pair correlation), and (3) uses cross-sections at
 * least h bars apart for the rank-IC t-statistic.
 *
 * Outcome rules (no look-ahead):
 *   • A signal is formed on the CLOSE of bar t. The earliest fill is the OPEN
 *     of bar t+1 — never the close of the bar that produced the signal.
 *   • The horizon-h exit is the close of bar t+h.
 *   • Net return = direction × gross − round-trip fees − 2 × slippage − funding
 *     (perpetuals only; longs pay, shorts receive the assumed average rate).
 *   • NEUTRAL rows are kept: they define the unconditional base rate a BUY or
 *     SELL must beat.
 * ----------------------------------------------------------------------------
 */
import { atr as atrSeries, type Kline } from "./indicators";
import { detectSplit } from "./splits";
import { ENGINE_BARS } from "./engine-window";
import { FR_MAX, OI_CHG_MAX, OI_CHG_MIN } from "./derivatives-context";

export type AssetClass = "crypto" | "rwa" | "stock" | "fx" | "commodity";

/** One scored closed bar. Short keys keep the stored ledger compact. */
export interface LedgerRow {
  /** `${cfg}|${src}|${tf}|${pair}|${t}` — one row per engine × series × bar. */
  id: string;
  cfg: string; // engine configId
  ev: string; // engine version
  app: string; // app version
  src: string; // data source
  tf: string; // timeframe
  pair: string; // e.g. BTCUSDT
  ac: AssetClass;
  t: number; // signal bar open time (ms)
  tc: number; // signal bar close time (ms)
  rec: number; // recorded at (ms); for replay = tc
  c: number; // signal bar close
  sc: number; // score −100..100
  m: -1 | 0 | 1; // master direction
  st: 0 | 1 | 2; // strength: weak / moderate / strong
  sup: 0 | 1; // suppressed (too little data)
  lv: 0 | 1; // low-volatility cap applied
  v: number; // valid voting indicators
  bu: number;
  be: number;
  er: number | null; // efficiency ratio
  bl: number[]; // bloc scores ×100: trend, meanReversion, breakout, flow
  rk: number; // universe rank at signal time (0 = not ranked / replay)
  qv: number; // 24h quote volume at signal time (0 in replay)
  rd: -1 | 0 | 1; // reversal direction
  rc: 0 | 1 | 2 | 3; // reversal confidence none/low/moderate/high
  wb: number; // bars the engine saw (warm-up); < ENGINE_BARS = cold
  live: 0 | 1; // 1 = recorded live (forward test), 0 = replay/backtest
  /** v2.2: 1 when the stock/FX underlying was closed for the whole signal bar. */
  uc?: 0 | 1;
  /* ---- v2.3: logged context fields (never scored; see docs/measurement.md) ---- */
  /** Rank in the FULL unfiltered venue ranking (all classes) at signal time. */
  rku?: number;
  /** Where rk/rku came from: live scan, the ranking at catch-up time ("now"), or none. */
  rks?: "live" | "now" | "none";
  /** Cross-sectional relative-strength percentile (0–100) of the 20-bar return. */
  rs?: number | null;
  /** Rolling 100-bar beta to BTC (same source and timeframe). */
  beta?: number | null;
  /** Higher-timeframe trend: sign of EMA-20 slope on aggregated bars. */
  htf?: -1 | 0 | 1 | null;
  /** Taker buy/sell imbalance over the last 10 bars (−1…1; Binance spot only). */
  td?: number | null;
  /** Hours to the nearest scheduled macro event within ±48 h (negative = after). */
  mev?: number | null;
  /** Perp basis vs index, % (Bybit linear), and 1 when the mark sits at the venue band. */
  bp?: number | null;
  pin?: 0 | 1;
  /** 1 when a stock split was detected in the window (signal muted). */
  spl?: 0 | 1;
  /** 1 when an earnings date (manual list) falls within ±24 h. */
  earn?: 0 | 1;
  /** Bars the indicators actually saw after the stock session filter (absent = wb). */
  eb?: number;
  /* ---- v2.8 (WP19): logged context, never scored; null = not recorded (older rows, catch-up, replay) ---- */
  /** The 18 votes, base-4 packed in the engine's voter order (digit 0 = first voter): 0 bull, 1 bear, 2 neutral, 3 not valid / informational. */
  vt?: number | null;
  /** Historical-analogue Pattern output: direction UP 1 / DOWN −1 / NONE 0, confidence none/low/moderate/high 0…3. */
  pd?: -1 | 0 | 1 | null;
  pc?: 0 | 1 | 2 | 3 | null;
  /** Bybit linear funding rate per interval (fraction) and open-interest change (%) from a derivative snapshot ≤ 2 h before the bar close. */
  fr?: number | null;
  oiChg?: number | null;
}

/* ------------------------------------------------------------------ *
 *  v2.8 (WP19) vote vector: 18 base-4 digits in one integer
 * ------------------------------------------------------------------ */
export type VoteDigit = 0 | 1 | 2 | 3;
export const VOTE_COUNT = 18;
/** 4^18 − 1 = 68 719 476 735: 36 bits, safe in a JS number but beyond 32-bit shifts — packed with × 4 / % 4 only. */
export const VOTE_MAX = 4 ** VOTE_COUNT - 1;

/** Pack 18 digits (0 bull, 1 bear, 2 neutral, 3 not valid) — digit 0 is the least significant. Throws on a bad vector. */
export function packVotes(states: readonly VoteDigit[]): number {
  if (!Array.isArray(states) || states.length !== VOTE_COUNT) throw new RangeError(`packVotes: ${VOTE_COUNT} digits expected`);
  let v = 0;
  for (let i = VOTE_COUNT - 1; i >= 0; i--) {
    const d = states[i];
    if (d !== 0 && d !== 1 && d !== 2 && d !== 3) throw new RangeError(`packVotes: digit ${i} is not 0…3`);
    v = v * 4 + d;
  }
  return v;
}

/** Inverse of packVotes (digit 0 first). */
export function unpackVotes(vt: number): VoteDigit[] {
  if (!Number.isSafeInteger(vt) || vt < 0 || vt > VOTE_MAX) throw new RangeError("unpackVotes: 0…4^18−1 expected");
  const out: VoteDigit[] = [];
  let v = vt;
  for (let i = 0; i < VOTE_COUNT; i++) {
    out.push((v % 4) as VoteDigit);
    v = Math.floor(v / 4);
  }
  return out;
}

/** Bars the engine really scored on (session-filtered stocks see fewer than the raw window). */
export const engineBarsOf = (r: Pick<LedgerRow, "wb" | "eb">): number => r.eb ?? r.wb;

/** Stored outcome snapshot per horizon: gross, MFE, MAE, long funding (fractions). */
/** Stored outcome snapshot: gross, MFE, MAE, long funding (fractions) and hours held (to re-price funding). */
export interface OutcomeSnapshot { g: number; mfe: number; mae: number; f: number; hh?: number }

export interface CostModel {
  /** One-way taker fee, in basis points. */
  feeBps: number;
  /** One-way slippage, in basis points. */
  slipBps: number;
  /** Average funding per 8 h, in basis points (perpetuals only; 0 for spot). */
  fundingBpsPer8h: number;
}

/**
 * Default costs per source (base tier, taker; Oct 2026). Spot fees are the
 * standard 0.10 %; Bybit linear taker 0.055 %; slippage 5 bp is a placeholder
 * until measured from order-book depth — see docs/measurement.md.
 */
export const DEFAULT_COSTS: Record<string, CostModel> = {
  binance: { feeBps: 10, slipBps: 5, fundingBpsPer8h: 0 },
  "bybit-spot": { feeBps: 10, slipBps: 5, fundingBpsPer8h: 0 },
  "bybit-perp": { feeBps: 5.5, slipBps: 5, fundingBpsPer8h: 1 },
  "bitget-perp": { feeBps: 6, slipBps: 5, fundingBpsPer8h: 1 },
  bitget: { feeBps: 10, slipBps: 5, fundingBpsPer8h: 0 },
  // v2.6 (ADR-0013): Coins.ph fee schedule not yet confirmed — deliberately
  // conservative placeholders for a thin peso book (0.30 % fee, 15 bp slippage).
  coinsph: { feeBps: 30, slipBps: 15, fundingBpsPer8h: 0 },
  // v2.8 (WP26): OKX's fee schedule is not cited in the repo or the probe [not verified] — these mirror the
  // existing spot default and the more conservative existing perp default (Bitget perpetual).
  okx: { feeBps: 10, slipBps: 5, fundingBpsPer8h: 0 },
  "okx-perp": { feeBps: 6, slipBps: 5, fundingBpsPer8h: 1 },
  // v2.8 (WP26): Coinbase Exchange base tier ($0K-$10K) taker 60 bps (maker 40 bps) — Coinbase Exchange fees,
  // https://support.coinbase.com/en/exchange/trading-and-funding/exchange-fees (read 15 Nov 2026). Slippage placeholder.
  coinbase: { feeBps: 60, slipBps: 5, fundingBpsPer8h: 0 },
  // v2.8 (WP26): Upbit BTC and USDT markets 0.25 % taker — secondary source (Upbit review, digitalmoneybox.com,
  // 2026); check Upbit's fee page [not verified on upbit.com]. KRW markets are cheaper: QUOTE_FEE_BPS. Slippage placeholder.
  upbit: { feeBps: 25, slipBps: 5, fundingBpsPer8h: 0 },
};

/**
 * v2.8 (WP26 final wave): taker fee per quote market where a venue charges by market (bps, one side); any other quote
 * uses DEFAULT_COSTS. Upbit KRW markets 0.05 % — secondary source (Upbit review, digitalmoneybox.com, 2026); check
 * Upbit's fee page [not verified on upbit.com].
 */
export const QUOTE_FEE_BPS: Record<string, Record<string, number>> = {
  upbit: { KRW: 5 },
};

/**
 * v2.3 — extra one-side slippage per asset class (bp) on top of the source
 * default, for books that are thinner or quote-driven: tokenised stocks and
 * RWAs (+10), commodities (+5), FX (+3). Placeholders until measured depth is
 * available; a measured per-pair slippage (order-book depth) replaces BOTH.
 */
export const CLASS_EXTRA_SLIP_BPS: Record<AssetClass, number> = { crypto: 0, rwa: 10, stock: 10, fx: 3, commodity: 5 };

/** Costs for one source (and, v2.8, the pair's quote market where QUOTE_FEE_BPS has a per-market fee). */
export function costsFor(source: string, ac: AssetClass, measuredSlipBps?: number, quote?: string): CostModel {
  const base = DEFAULT_COSTS[source] ?? DEFAULT_COSTS.binance;
  const slip = measuredSlipBps !== undefined && Number.isFinite(measuredSlipBps) && measuredSlipBps >= 0
    ? measuredSlipBps
    : base.slipBps + (CLASS_EXTRA_SLIP_BPS[ac] ?? 0);
  const fee = quote ? QUOTE_FEE_BPS[source]?.[quote.toUpperCase()] : undefined;
  return { ...base, ...(fee !== undefined ? { feeBps: fee } : {}), slipBps: slip };
}

export const DEFAULT_HORIZONS = [1, 3, 6, 12, 24];

/**
 * Rows scored on fewer bars than this carry warm-up bias (recursive indicators
 * not yet converged) and are left out of the statistics by default.
 */
export const WARM_MIN_BARS = 300;
/** v2.3 primary statistics use only rows scored on the full engine window. */
export const PRIMARY_WARM_BARS = 1000;

export interface Outcome {
  row: LedgerRow;
  horizon: number;
  /** Long-side gross return from next-bar open to close of bar t+h. */
  gross: number;
  /** Direction-adjusted net return (for m = 0 rows: long, for base rates). */
  net: number;
  /** Max favourable / adverse excursion in the signal direction (fractions). */
  mfe: number;
  mae: number;
  /** Funding a LONG would pay over the hold (fraction; 0 on spot). Used for direction-matched base rates. */
  fundingLong: number;
  /** v2.3: BTC's gross return over the same holding window (same source), when known. */
  btcGross?: number;
  /** v2.3: round-trip fee + slippage charged to THIS outcome (fraction). Base rates and benchmarks reuse it. */
  cost: number;
  /** v2.3: hours held (funding re-pricing). */
  holdHours: number;
}

/** Rebuild an outcome from a stored snapshot (costs are re-applied, so cost assumptions can change). */
export function outcomeFromSnapshot(row: LedgerRow, horizon: number, snap: OutcomeSnapshot, costs: CostModel): Outcome {
  const dir = row.m === 0 ? 1 : row.m;
  const cost = (2 * (costs.feeBps + costs.slipBps)) / 1e4;
  // Funding is re-priced from today's cost model when the hold length is known.
  const fundingLong = snap.hh !== undefined ? (costs.fundingBpsPer8h / 1e4) * (snap.hh / 8) : snap.f;
  const net = dir * snap.g - cost - fundingLong * dir;
  return { row, horizon, gross: snap.g, net, mfe: snap.mfe, mae: snap.mae, fundingLong, cost, holdHours: snap.hh ?? NaN };
}
export const toSnapshot = (o: Outcome): OutcomeSnapshot => ({ g: o.gross, mfe: o.mfe, mae: o.mae, f: o.fundingLong, hh: o.holdHours });

/** Index of bar time `t` in a time-sorted series (binary search). */
export function indexOfTime(k: Kline[], t: number): number {
  let lo = 0;
  let hi = k.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = k[mid].time;
    if (v === t) return mid;
    if (v < t) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** Measure one row at one horizon; null while the horizon has not closed yet. */
export function measureOutcome(row: LedgerRow, k: Kline[], horizon: number, costs: CostModel, intervalMs: number): Outcome | null {
  const i = indexOfTime(k, row.t);
  if (i < 0 || i + horizon >= k.length) return null;
  const entry = k[i + 1].open;
  const exit = k[i + horizon].close;
  if (!(entry > 0) || !(exit > 0)) return null;
  // Contiguity: any missing bar inside the holding window adds a whole interval,
  // so the span must equal h intervals exactly (half a bar of slack for clock
  // jitter; calendar months: up to 31 days each). v2.1.1 allowed 5 %, which
  // let h ≥ 20 straddle one missing bar.
  const span = k[i + horizon].time - k[i].time;
  const maxSpan = intervalMs >= 28 * 86_400_000 ? horizon * 31 * 86_400_000 : horizon * intervalMs + intervalMs / 2;
  if (span > maxSpan) return null;
  // v2.3: a stock split inside the holding window is a corporate action, not a return.
  if (row.ac === "stock" && detectSplit(k.slice(i, i + horizon + 1))) return null;
  const gross = exit / entry - 1;
  const dir = row.m === 0 ? 1 : row.m;
  let hi = -Infinity;
  let lo = Infinity;
  for (let j = i + 1; j <= i + horizon; j++) {
    if (k[j].high > hi) hi = k[j].high;
    if (k[j].low < lo) lo = k[j].low;
  }
  const up = hi / entry - 1;
  const down = lo / entry - 1;
  const mfe = dir === 1 ? up : -down;
  const mae = dir === 1 ? down : -up;
  const holdHours = (horizon * intervalMs) / 3_600_000;
  const fundingLong = (costs.fundingBpsPer8h / 1e4) * (holdHours / 8);
  const funding = fundingLong * dir; // longs pay, shorts receive
  const cost = (2 * (costs.feeBps + costs.slipBps)) / 1e4;
  const net = dir * gross - cost - funding;
  return { row, horizon, gross, net, mfe, mae, fundingLong, cost, holdHours };
}

/* ------------------------------------------------------------------ *
 *  v2.8 (WP19) outcome mode "atr-bracket" — the paper broker's bracket
 *  (2 × ATR stop, 2 R target, stop first when a bar touches both, a gap
 *  through the stop exits at the open), so ADR-0010 gate 3 compares paper
 *  R with the same rule. One implementation, stepped bar by bar: the
 *  ledger/replay loop it over the bars after a signal; the paper broker
 *  advances it for rejected proposals as new bars close.
 * ------------------------------------------------------------------ */
export const OUTCOME_MODES = ["horizon", "atr-bracket"] as const;
export type OutcomeMode = (typeof OUTCOME_MODES)[number];
export const BRACKET_ATR_MULT = 2;
export const BRACKET_RR = 2;

export interface BracketSpec {
  dir: 1 | -1;
  /** Signal-bar close (sizing reference). */
  refPrice: number;
  stopDistance: number;
  targetDistance: number;
  /** 1 R per unit: stop distance + refPrice × round-trip cost (the paper sizing rule). */
  riskPerUnit: number;
  signalBarTime: number;
  /** Fill at the open of the first bar opening at or after this instant (and after the signal bar). */
  fillFrom: number;
  intervalMs: number;
}

export interface BracketState {
  status: "pending" | "open" | "closed";
  entry: number | null;
  openedAt: number | null;
  stop: number;
  target: number;
  /** Funding paid per unit so far (negative = received). */
  funding: number;
  lastBarTime: number;
  r?: number;
  exitReason?: "stop" | "target";
  closedAt?: number;
}

export const bracketInit = (spec: BracketSpec): BracketState => ({
  status: "pending", entry: null, openedAt: null, stop: 0, target: 0, funding: 0, lastBarTime: spec.signalBarTime,
});

/**
 * Advance a bracket over newly closed bars (already-seen bars are skipped).
 * Pure; mirrors paper-broker processBars exactly: slippage against the
 * position on fill and exit, taker fee on both, funding per bar held.
 */
export function bracketAdvance(spec: BracketSpec, state: BracketState, bars: Kline[], costs: CostModel): BracketState {
  if (state.status === "closed") return state;
  const s: BracketState = { ...state };
  const dir = spec.dir;
  const fee = costs.feeBps / 1e4;
  const slip = costs.slipBps / 1e4;
  const fundingPerBar = (costs.fundingBpsPer8h / 1e4) * (spec.intervalMs / 3_600_000 / 8);
  for (const bar of bars) {
    if (bar.time <= s.lastBarTime) continue;
    if (!(bar.open > 0) || !(bar.high > 0) || !(bar.low > 0) || !(bar.close > 0)) { s.lastBarTime = bar.time; continue; }
    let fillBar = false;
    if (s.status === "pending") {
      if (bar.time < spec.fillFrom || bar.time <= spec.signalBarTime) { s.lastBarTime = bar.time; continue; }
      s.entry = bar.open * (1 + dir * slip);
      s.openedAt = bar.time;
      s.stop = s.entry - dir * spec.stopDistance;
      s.target = s.entry + dir * spec.targetDistance;
      s.status = "open";
      fillBar = true;
    }
    const entry = s.entry as number;
    s.funding += fundingPerBar * entry * dir;
    let exit: { px: number; reason: "stop" | "target" } | null = null;
    if (dir === 1) {
      if (!fillBar && bar.open <= s.stop) exit = { px: bar.open, reason: "stop" };
      else if (bar.low <= s.stop) exit = { px: s.stop, reason: "stop" };
      else if (bar.high >= s.target) exit = { px: s.target, reason: "target" };
    } else {
      if (!fillBar && bar.open >= s.stop) exit = { px: bar.open, reason: "stop" };
      else if (bar.high >= s.stop) exit = { px: s.stop, reason: "stop" };
      else if (bar.low <= s.target) exit = { px: s.target, reason: "target" };
    }
    s.lastBarTime = bar.time;
    if (exit) {
      const exitPx = exit.px * (1 - dir * slip);
      const pnl = dir * (exitPx - entry) - entry * fee - exitPx * fee - s.funding;
      return { ...s, status: "closed", r: spec.riskPerUnit > 0 ? pnl / spec.riskPerUnit : 0, exitReason: exit.reason, closedAt: bar.time + spec.intervalMs };
    }
  }
  return s;
}

export interface BracketOutcome {
  row: LedgerRow;
  r: number;
  reason: "stop" | "target";
  /** Close of the exit bar (ms). */
  closedAt: number;
  /** Bars held, fill bar included. */
  bars: number;
  atr: number;
  stopDistance: number;
}

/**
 * Measure one directional row in "atr-bracket" mode: entry at the next bar's
 * open, stop 2 × ATR(14) of the engine window ending at the signal bar
 * (`opts.atr` overrides), target 2 R. null for NEUTRAL rows, a missing bar,
 * an unusable ATR, or a bracket not resolved by the newest bar.
 */
export function measureBracket(
  row: LedgerRow, k: Kline[], costs: CostModel, intervalMs: number,
  opts: { atr?: number; atrMult?: number; rr?: number } = {},
): BracketOutcome | null {
  if (row.m === 0) return null;
  const i = indexOfTime(k, row.t);
  if (i < 0 || i + 1 >= k.length) return null;
  const a = opts.atr ?? atrSeries(k.slice(Math.max(0, i + 1 - ENGINE_BARS), i + 1), 14).at(-1) ?? NaN;
  const stopDistance = (opts.atrMult ?? BRACKET_ATR_MULT) * a;
  if (!(stopDistance > 0) || !(row.c > 0) || !Number.isFinite(stopDistance)) return null;
  const dir = row.m;
  if (dir === 1 && !(row.c - stopDistance > 0)) return null; // same "nonsense ATR" rule as the risk engine
  const rt = (2 * (costs.feeBps + costs.slipBps)) / 1e4;
  const spec: BracketSpec = {
    dir, refPrice: row.c, stopDistance, targetDistance: stopDistance * (opts.rr ?? BRACKET_RR),
    riskPerUnit: stopDistance + row.c * rt, signalBarTime: row.t, fillFrom: row.t + intervalMs, intervalMs,
  };
  // Contiguity: a missing bar inside the hold would hide a stop; stop at the first hole.
  let j = i + 1;
  const maxGap = intervalMs >= 28 * 86_400_000 ? 31 * 86_400_000 : intervalMs + intervalMs / 2;
  while (j < k.length && k[j].time - k[j - 1].time <= maxGap) j++;
  const s = bracketAdvance(spec, bracketInit(spec), k.slice(i + 1, j), costs);
  if (s.status !== "closed" || s.r === undefined || !s.exitReason || s.closedAt === undefined || s.openedAt === null) return null;
  return { row, r: s.r, reason: s.exitReason, closedAt: s.closedAt, bars: Math.round((s.closedAt - s.openedAt) / intervalMs), atr: a, stopDistance };
}

/**
 * Summary of atr-bracket outcomes, one trade at a time per series (a signal
 * while that series' bracket is still open is skipped — no pyramiding, as in
 * the paper book): n, mean R, hit rate (R > 0) with its Wilson interval.
 */
export function summarizeBrackets(outs: BracketOutcome[]): { n: number; meanR: number; hitRate: number; hitCi: [number, number]; stops: number; targets: number } {
  const bySeries = new Map<string, BracketOutcome[]>();
  for (const o of outs) {
    const key = `${o.row.src}|${o.row.tf}|${o.row.pair}`;
    const l = bySeries.get(key);
    if (l) l.push(o); else bySeries.set(key, [o]);
  }
  const kept: BracketOutcome[] = [];
  for (const list of bySeries.values()) {
    list.sort((a, b) => a.row.t - b.row.t);
    let freeAt = -Infinity;
    for (const o of list) if (o.row.tc >= freeAt) { kept.push(o); freeAt = o.closedAt; }
  }
  const wins = kept.filter((o) => o.r > 0).length;
  return {
    n: kept.length,
    meanR: kept.length ? kept.reduce((a, o) => a + o.r, 0) / kept.length : NaN,
    hitRate: kept.length ? wins / kept.length : NaN,
    hitCi: wilson(wins, kept.length),
    stops: kept.filter((o) => o.reason === "stop").length,
    targets: kept.filter((o) => o.reason === "target").length,
  };
}

/* ------------------------------------------------------------------ *
 *  Statistics helpers
 * ------------------------------------------------------------------ */
const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
function std(x: number[]): number {
  if (x.length < 2) return NaN;
  const m = mean(x);
  return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - 1));
}
function median(x: number[]): number {
  if (!x.length) return NaN;
  const s = [...x].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}
/** p-th standardised sample moment (sample SD); 3 = skew γ₃, 4 = raw kurtosis γ₄ (3 for normal returns). */
export function moment(x: number[], p: number): number {
  const m = mean(x);
  const sd = std(x);
  if (!(sd > 0)) return NaN;
  return mean(x.map((v) => ((v - m) / sd) ** p));
}
/** Standard normal CDF (Abramowitz–Stegun 7.1.26, |err| < 1.5e-7). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
/** Inverse standard normal CDF (Acklam). */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lowP = 0.02425;
  if (p < lowP) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lowP) return -normInv(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
function ranks(x: number[]): number[] {
  const idx = x.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array(x.length).fill(0);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
export function spearman(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 3) return NaN;
  const rx = ranks(x);
  const ry = ranks(y);
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : NaN;
}

/**
 * Probabilistic Sharpe ratio P(true SR > benchmark) and the deflated version
 * for `trials` configurations tried (Bailey & López de Prado 2012/2014). With
 * trials = 1 the DSR equals the PSR against 0.
 */
export interface SharpeStats { sr: number; psr: number; dsr: number; sr0: number; g3: number; g4: number }
export function sharpeStats(returns: number[], trials = 1): SharpeStats {
  const n = returns.length;
  const sd = std(returns);
  const sr = sd > 0 ? mean(returns) / sd : NaN;
  if (!(n > 2) || !Number.isFinite(sr)) return { sr, psr: NaN, dsr: NaN, sr0: NaN, g3: NaN, g4: NaN };
  const g3 = moment(returns, 3);
  const g4 = moment(returns, 4);
  const denom = Math.sqrt(Math.max(1e-12, 1 - g3 * sr + ((g4 - 1) / 4) * sr * sr));
  const psrAt = (bench: number) => normCdf(((sr - bench) * Math.sqrt(n - 1)) / denom);
  // Expected maximum Sharpe of `trials` null strategies (false-strategy theorem), null variance 1/(n−1).
  const euler = 0.5772156649;
  const sr0 = trials > 1
    ? Math.sqrt(1 / (n - 1)) * ((1 - euler) * normInv(1 - 1 / trials) + euler * normInv(1 - 1 / (trials * Math.E)))
    : 0;
  return { sr, psr: psrAt(0), dsr: psrAt(sr0), sr0, g3, g4 };
}

/**
 * v2.8 (WP19) power: blocks n needed for PSR ≥ 0.95 at this Sharpe, from
 * SR·√(n−1) ≥ 1.645·√(1 − γ₃·SR + (γ₄−1)/4·SR²) → n = 1 + (1.645·√(…)/SR)²,
 * rounded up (term under the root floored at 1e-12, as in sharpeStats).
 * null when SR ≤ 0 (it never gets there) or an input is not finite.
 */
export function blocksForPsr95(sr: number, g3: number, g4: number): number | null {
  if (!(sr > 0) || !Number.isFinite(sr) || !Number.isFinite(g3) || !Number.isFinite(g4)) return null;
  const root = Math.sqrt(Math.max(1e-12, 1 - g3 * sr + ((g4 - 1) / 4) * sr * sr));
  return Math.ceil(1 + ((1.645 * root) / sr) ** 2);
}

/** Days needed at the current Sharpe for PSR 0.95: blocks needed ÷ observed blocks per day, rounded up; null when SR ≤ 0. */
export function daysForPsr95(sr: number, g3: number, g4: number, blocksPerDay: number): number | null {
  const n = blocksForPsr95(sr, g3, g4);
  if (n === null || !(blocksPerDay > 0) || !Number.isFinite(blocksPerDay)) return null;
  return Math.ceil(n / blocksPerDay);
}

export interface PowerReadout {
  /** Blocks already in the PSR (h-bar portfolio returns) and how many the ledger observes per day. */
  blocks: number;
  blocksPerDay: number;
  /** Total days needed at the current Sharpe, and days remaining beyond the blocks already logged; null when SR ≤ 0. */
  totalDays: number | null;
  remainingDays: number | null;
}

export function powerReadout(sharpe: Pick<SharpeStats, "sr" | "g3" | "g4">, blocks: number, blocksPerDay: number): PowerReadout {
  const need = blocksForPsr95(sharpe.sr, sharpe.g3, sharpe.g4);
  const totalDays = daysForPsr95(sharpe.sr, sharpe.g3, sharpe.g4, blocksPerDay);
  const remainingDays = need === null || totalDays === null ? null : Math.ceil(Math.max(0, need - blocks) / blocksPerDay);
  return { blocks, blocksPerDay, totalDays, remainingDays };
}

/**
 * v2.8 (WP19) confirmatory gate: the confirmatory report deflates its Sharpe by
 * the ACTIVE pre-registered hypotheses only — those fixed for the engine being
 * evaluated (a pre-registration on an older engine id can no longer be
 * confirmed by these rows). At least 1. The exploratory report keeps the
 * all-views trial count.
 */
export function confirmatoryTrials(preregistrations: ReadonlyArray<{ cfg: string }>, cfg: string): number {
  return Math.max(1, preregistrations.filter((p) => p && p.cfg === cfg).length);
}

/** Deterministic PRNG (mulberry32) so bootstrap/shuffle results are reproducible. */
export function rng(seed = 20261031): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Wilson 95 % interval for a proportion. */
export function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [NaN, NaN];
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - h) / d, (c + h) / d];
}

/**
 * Bootstrap 95 % interval of the mean. With `blocks` (one key per value, e.g.
 * the holding period it falls in) whole blocks are resampled, so outcomes of
 * different pairs over the same window — which move together — are never
 * treated as independent draws.
 */
export function bootstrapMean(x: number[], iterations = 500, seed = 7, blocks?: number[]): [number, number] {
  if (x.length < 5) return [NaN, NaN];
  const r = rng(seed);
  let groups: number[][];
  if (blocks && blocks.length === x.length) {
    const m = new Map<number, number[]>();
    x.forEach((v, i) => { const g = m.get(blocks[i]); if (g) g.push(v); else m.set(blocks[i], [v]); });
    groups = [...m.values()];
  } else {
    groups = x.map((v) => [v]);
  }
  if (groups.length < 5) return [NaN, NaN];
  const means: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let s = 0;
    let n = 0;
    for (let j = 0; j < groups.length; j++) {
      const g = groups[Math.floor(r() * groups.length)];
      for (const v of g) s += v;
      n += g.length;
    }
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * iterations)], means[Math.floor(0.975 * iterations)]];
}

/**
 * Probability of backtest overfitting via combinatorially symmetric
 * cross-validation (Bailey, Borwein, López de Prado, Zhu 2014).
 * `m[t][k]` = return of strategy k in period t. Splits T into `s` blocks, for
 * every half/half combination picks the in-sample best strategy and records
 * its out-of-sample rank; PBO = share of combinations where that rank is
 * below the median (logit ≤ 0).
 */
export function pbo(m: number[][], s = 8): { pbo: number; combinations: number } {
  const T = m.length;
  const N = m[0]?.length ?? 0;
  if (N < 2 || T < s * 2) return { pbo: NaN, combinations: 0 };
  const size = Math.floor(T / s);
  const blocks = Array.from({ length: s }, (_, b) => m.slice(b * size, (b + 1) * size));
  const half = s / 2;
  const combos: number[][] = [];
  const pick = (start: number, acc: number[]) => {
    if (acc.length === half) { combos.push([...acc]); return; }
    for (let i = start; i < s; i++) { acc.push(i); pick(i + 1, acc); acc.pop(); }
  };
  pick(0, []);
  // Performance = Sharpe ratio of each variant over the rows (Bailey et al.
  // 2014), so variants with different return scales (e.g. horizons) compare
  // on risk-adjusted terms rather than raw size.
  const perf = (rows: number[][]) => {
    const out: number[] = [];
    for (let k = 0; k < N; k++) {
      const col = rows.map((row) => row[k]);
      const mu = col.reduce((a, v) => a + v, 0) / Math.max(1, col.length);
      const sd = Math.sqrt(col.reduce((a, v) => a + (v - mu) ** 2, 0) / Math.max(1, col.length - 1));
      out.push(sd > 0 ? mu / sd : mu === 0 ? 0 : Math.sign(mu) * 1e9);
    }
    return out;
  };
  let below = 0;
  for (const c of combos) {
    const inSet = new Set(c);
    const isRows = blocks.filter((_, i) => inSet.has(i)).flat();
    const osRows = blocks.filter((_, i) => !inSet.has(i)).flat();
    const isPerf = perf(isRows);
    const osPerf = perf(osRows);
    let best = 0;
    for (let k = 1; k < N; k++) if (isPerf[k] > isPerf[best]) best = k;
    const rank = osPerf.filter((v) => v < osPerf[best]).length + 0.5; // relative rank of the IS winner OOS
    const w = rank / N;
    if (Math.log(w / (1 - w)) <= 0) below++;
  }
  return { pbo: below / combos.length, combinations: combos.length };
}

/* ------------------------------------------------------------------ *
 *  Group summaries
 * ------------------------------------------------------------------ */
export interface GroupStats {
  label: string;
  n: number;
  hitRate: number; // share of net > 0
  meanNetBps: number;
  medianNetBps: number;
  tStat: number;
  profitFactor: number;
  avgMfeBps: number;
  avgMaeBps: number;
  /** Unconditional same-direction gross mean over ALL scored rows at the same horizon. */
  baseMeanBps: number;
  baseHitRate: number;
  /** meanNet − (base gross mean − costs): what the signal adds over holding blindly. */
  edgeBps: number;
  /** v2.3: Wilson 95 % interval of the hit rate, bootstrap 95 % interval of mean net (bp). */
  hitCi: [number, number];
  meanCi: [number, number];
  /** v2.3: mean net return in excess of BTC over the same window (bp; NaN when no BTC series). */
  excessBtcBps: number;
  /** v2.3: mean net in excess of the cross-sectional mean gross return of all scored pairs at the same bar (bp). */
  excessXsBps: number;
  /** v2.3: mean round-trip cost actually charged to these signals (bp) — the 2× robustness check adds this once more. */
  costBps: number;
}

/**
 * v2.8 (WP19): on a spot source a SELL cannot be shorted without borrowing, so a SELL group is "long avoided"
 * (the long a buyer skipped) and its P&L is the short's. True for the report's SELL groups on non-perpetual sources.
 */
export const isSpotSellGroup = (label: string, source: string): boolean => label.startsWith("SELL") && !/perp/i.test(source);

/** Direction-matched base: holding every scored bar blindly in `dir`, after costs and funding. */
/**
 * Direction-matched base outcomes, charged `cost` (a fraction) each. Callers
 * pass the mean cost of the signals being compared (v2.3 review C1), so edge =
 * mean(net) − mean(base) is exactly cost-neutral: signals concentrated in
 * cheap pairs cannot show "edge" that is only a cost difference.
 */
function baseNet(baseOuts: Outcome[], dir: 1 | -1, cost: number): number[] {
  return baseOuts.map((o) => dir * o.gross - cost - dir * o.fundingLong);
}
const costOf = (o: Outcome, fallbackBps: number) => (Number.isFinite(o.cost) ? o.cost : fallbackBps / 1e4);

function groupStats(
  label: string, outs: Outcome[], baseOuts: Outcome[], dir: 1 | -1, costBps: number,
  blockMs = 0, xsMean?: Map<number, number>,
): GroupStats {
  const net = outs.map((o) => o.net);
  const pos = net.filter((v) => v > 0).reduce((a, b) => a + b, 0);
  const neg = -net.filter((v) => v < 0).reduce((a, b) => a + b, 0);
  const sigCost = outs.length ? mean(outs.map((o) => costOf(o, costBps))) : costBps / 1e4;
  const base = baseNet(baseOuts, dir, sigCost);
  const baseMean = mean(base);
  const sd = std(net);
  return {
    label,
    n: outs.length,
    hitRate: outs.length ? net.filter((v) => v > 0).length / outs.length : NaN,
    meanNetBps: mean(net) * 1e4,
    medianNetBps: median(net) * 1e4,
    tStat: sd > 0 ? (mean(net) / sd) * Math.sqrt(net.length) : NaN,
    profitFactor: neg > 0 ? pos / neg : pos > 0 ? Infinity : NaN,
    avgMfeBps: mean(outs.map((o) => o.mfe)) * 1e4,
    avgMaeBps: mean(outs.map((o) => o.mae)) * 1e4,
    baseMeanBps: baseMean * 1e4,
    baseHitRate: base.length ? base.filter((v) => v > 0).length / base.length : NaN,
    edgeBps: (mean(net) - baseMean) * 1e4,
    hitCi: wilson(net.filter((v) => v > 0).length, net.length),
    costBps: sigCost * 1e4,
    meanCi: bootstrapMean(net, 500, 7, blockMs > 0 ? outs.map((o) => Math.floor(o.row.t / blockMs)) : undefined).map((v) => v * 1e4) as [number, number],
    excessXsBps: (() => {
      if (!xsMean) return NaN;
      const ex = outs.filter((o) => xsMean.has(o.row.t)).map((o) => o.net - dir * (xsMean.get(o.row.t) as number));
      return ex.length ? mean(ex) * 1e4 : NaN;
    })(),
    excessBtcBps: (() => {
      const withBtc = outs.filter((o) => o.btcGross !== undefined && o.row.pair !== "BTCUSDT");
      return withBtc.length ? mean(withBtc.map((o) => o.net - dir * (o.btcGross as number))) * 1e4 : NaN;
    })(),
  };
}

export interface HorizonReport {
  horizon: number;
  scored: number;
  groups: GroupStats[];
  calibration: { bucket: string; n: number; meanGrossBps: number }[];
  ic: { mean: number; tStat: number; periods: number };
  sharpe: SharpeStats;
  /** v2.8 (WP19): days needed at this Sharpe for PSR 0.95, from the same block returns. */
  power: PowerReadout;
  /** v2.3 benchmarks the signal must beat. */
  benchmarks: {
    /** 20-bar momentum sign on the same bars (needs momentumOf). */
    momentum: { n: number; meanNetBps: number; edgeBps: number } | null;
    /** Share of label-shuffled replicas whose mean net ≥ the observed one (one-sided p). */
    shuffledP: number;
  };
}

export interface ReportOptions {
  /** Sign of the 20-bar return at the row's bar (−1/0/1), for the momentum benchmark. */
  momentumOf?: (row: LedgerRow) => -1 | 0 | 1;
  /** Shuffle replicas for the label-permutation test (default 200). */
  shuffles?: number;
}

export interface LedgerReport {
  rows: number;
  directional: number;
  measured: number;
  configIds: string[];
  from: number;
  to: number;
  horizons: HorizonReport[];
}

const CAL_BUCKETS: [string, number, number][] = [
  ["≤ −70", -101, -70], ["−70…−55", -70, -55], ["−55…−20", -55, -20], ["−20…20", -20, 20.0001],
  ["20…55", 20.0001, 55], ["55…70", 55, 70], ["≥ 70", 70, 101],
];

/** Keep, per series, only outcomes whose holding windows do not overlap (first signal wins). */
export function thinNonOverlapping(outs: Outcome[], horizon: number, intervalMs: number): Outcome[] {
  const bySeries = new Map<string, Outcome[]>();
  for (const o of outs) {
    const key = `${o.row.src}|${o.row.tf}|${o.row.pair}`;
    const list = bySeries.get(key);
    if (list) list.push(o); else bySeries.set(key, [o]);
  }
  const kept: Outcome[] = [];
  const gap = horizon * intervalMs;
  for (const list of bySeries.values()) {
    list.sort((a, b) => a.row.t - b.row.t);
    let next = -Infinity;
    for (const o of list) {
      if (o.row.t >= next) { kept.push(o); next = o.row.t + gap; }
    }
  }
  return kept;
}

/** Mean of `outs` nets per time block of h bars: one portfolio return per block. */
export function blockReturns(outs: Outcome[], horizon: number, intervalMs: number): number[] {
  return blockSeries(outs, horizon, intervalMs).returns;
}

/** Block returns plus the observed blocks per day (blocks ÷ days from the first to the last block, inclusive). */
function blockSeries(outs: Outcome[], horizon: number, intervalMs: number): { returns: number[]; blocksPerDay: number } {
  const block = horizon * intervalMs;
  const sums = new Map<number, { s: number; n: number }>();
  for (const o of outs) {
    const b = Math.floor(o.row.t / block);
    const cur = sums.get(b) ?? { s: 0, n: 0 };
    cur.s += o.net; cur.n += 1;
    sums.set(b, cur);
  }
  const keys = [...sums.keys()].sort((a, b) => a - b);
  const spanDays = keys.length ? ((keys[keys.length - 1] - keys[0] + 1) * block) / 86_400_000 : 0;
  return { returns: keys.map((k) => { const v = sums.get(k)!; return v.s / v.n; }), blocksPerDay: spanDays > 0 ? keys.length / spanDays : NaN };
}

/**
 * Build the report. `outcomesByHorizon[h]` holds every measured row (including
 * NEUTRAL) at horizon h; `intervalMs` is the bar length of these rows.
 * `costBps` = the round-trip cost used for base rates.
 */
export function buildReport(
  rows: LedgerRow[],
  outcomesByHorizon: Map<number, Outcome[]>,
  costBps: number,
  trials = 1,
  intervalMs = 4 * 3_600_000,
  options: ReportOptions = {},
): LedgerReport {
  const scoredRows = rows.filter((r) => !r.sup);
  const horizons: HorizonReport[] = [];
  for (const [h, outsAll] of [...outcomesByHorizon.entries()].sort((a, b) => a[0] - b[0])) {
    const scored = outsAll.filter((o) => !o.row.sup);
    // Base rate: every scored bar, thinned the same way.
    const baseOuts = thinNonOverlapping(scored, h, intervalMs);
    const buys = thinNonOverlapping(scored.filter((o) => o.row.m === 1), h, intervalMs);
    const sells = thinNonOverlapping(scored.filter((o) => o.row.m === -1), h, intervalMs);
    // Cross-sectional mean gross return per bar (≥ 5 pairs), for excess-vs-universe.
    const xsSum = new Map<number, { s: number; n: number }>();
    for (const o of scored) { const c = xsSum.get(o.row.t) ?? { s: 0, n: 0 }; c.s += o.gross; c.n++; xsSum.set(o.row.t, c); }
    const xsMean = new Map([...xsSum].filter(([, c]) => c.n >= 5).map(([t, c]) => [t, c.s / c.n]));
    const groups: GroupStats[] = [];
    if (buys.length) groups.push(groupStats("BUY · all", buys, baseOuts, 1, costBps, h * intervalMs, xsMean));
    const strongBuys = buys.filter((o) => o.row.st === 2);
    if (strongBuys.length) groups.push(groupStats("BUY · strong", strongBuys, baseOuts, 1, costBps, h * intervalMs, xsMean));
    if (sells.length) groups.push(groupStats("SELL · all", sells, baseOuts, -1, costBps, h * intervalMs, xsMean));
    const strongSells = sells.filter((o) => o.row.st === 2);
    if (strongSells.length) groups.push(groupStats("SELL · strong", strongSells, baseOuts, -1, costBps, h * intervalMs, xsMean));

    const calibration = CAL_BUCKETS.map(([bucket, lo, hiB]) => {
      const inB = baseOuts.filter((o) => o.row.sc >= lo && o.row.sc < hiB);
      return { bucket, n: inB.length, meanGrossBps: mean(inB.map((o) => o.gross)) * 1e4 };
    });

    // Rank IC per cross-section (same bar, same timeframe), using sections ≥ h bars apart.
    const bySection = new Map<number, Outcome[]>();
    for (const o of scored) {
      const list = bySection.get(o.row.t);
      if (list) list.push(o); else bySection.set(o.row.t, [o]);
    }
    const ics: number[] = [];
    let nextSection = -Infinity;
    for (const t of [...bySection.keys()].sort((a, b) => a - b)) {
      const list = bySection.get(t)!;
      if (list.length < 5 || t < nextSection) continue;
      const ic = spearman(list.map((o) => o.row.sc), list.map((o) => o.gross));
      if (Number.isFinite(ic)) { ics.push(ic); nextSection = t + h * intervalMs; }
    }
    const icSd = std(ics);

    // Benchmarks (v2.3, after review C1/C2):
    // (a) a 20-bar momentum sign on the same scored bars, charged its own costs,
    //     edge measured against the base in each signal's own direction;
    // (b) label permutation WITHIN each bar: every BUY/SELL keeps its bar and
    //     its cost but is moved to a random pair scored on that same bar. Time
    //     clustering of signals is preserved, so a market-wide move cannot make
    //     random labels look worse than the real ones (an independent draw over
    //     all bars rejected a true null ~35 % of the time).
    const directional = [...buys, ...sells];
    const baseG = mean(baseOuts.map((o) => o.gross));
    const baseF = mean(baseOuts.map((o) => o.fundingLong));
    let momentum: HorizonReport["benchmarks"]["momentum"] = null;
    if (options.momentumOf) {
      const mOuts = thinNonOverlapping(
        scored
          .map((o) => {
            const d = options.momentumOf!(o.row);
            if (!d) return null;
            const net = d * o.gross - costOf(o, costBps) - d * o.fundingLong;
            return { ...o, net, row: { ...o.row, m: d } } as Outcome;
          })
          .filter((o): o is Outcome => o !== null),
        h,
        intervalMs,
      );
      const mNet = mOuts.map((o) => o.net);
      const mEdge = mOuts.map((o) => { const d = o.row.m as 1 | -1; return o.net - (d * baseG - costOf(o, costBps) - d * baseF); });
      momentum = { n: mOuts.length, meanNetBps: mean(mNet) * 1e4, edgeBps: mean(mEdge) * 1e4 };
    }
    let shuffledP = NaN;
    if (directional.length >= 10) {
      const sec = new Map<number, { g: number[]; f: number[] }>();
      for (const o of scored) {
        const c = sec.get(o.row.t) ?? { g: [], f: [] };
        c.g.push(o.gross); c.f.push(o.fundingLong);
        sec.set(o.row.t, c);
      }
      const n = directional.length;
      const dirs = new Float64Array(n);
      const costs = new Float64Array(n);
      const pools: { g: number[]; f: number[] }[] = [];
      directional.forEach((o, j) => { dirs[j] = o.row.m; costs[j] = costOf(o, costBps); pools.push(sec.get(o.row.t)!); });
      const observed = mean(directional.map((o) => o.net));
      const r = rng(1000 + h);
      // ≤ 5 M draws per horizon (≥ 100 replicas) keeps large ledgers responsive.
      const reps = options.shuffles ?? Math.max(100, Math.min(200, Math.floor(5_000_000 / n)));
      let atLeast = 0;
      for (let i = 0; i < reps; i++) {
        let sum = 0;
        for (let j = 0; j < n; j++) {
          const p = pools[j];
          const x = Math.floor(r() * p.g.length);
          sum += dirs[j] * p.g[x] - costs[j] - dirs[j] * p.f[x];
        }
        if (sum / n >= observed - 1e-12) atLeast++;
      }
      shuffledP = (atLeast + 1) / (reps + 1);
    }

    const blocks = blockSeries([...buys, ...sells], h, intervalMs);
    const sharpe = sharpeStats(blocks.returns, trials);
    horizons.push({
      horizon: h,
      scored: baseOuts.length,
      groups,
      calibration,
      ic: { mean: mean(ics), tStat: icSd > 0 ? (mean(ics) / icSd) * Math.sqrt(ics.length) : NaN, periods: ics.length },
      sharpe,
      power: powerReadout(sharpe, blocks.returns.length, blocks.blocksPerDay),
      benchmarks: { momentum, shuffledP },
    });
  }
  // Loops, not Math.min(...xs): spreading >125k arguments throws a RangeError.
  let from = Infinity;
  let to = -Infinity;
  for (const r of rows) { if (r.t < from) from = r.t; if (r.t > to) to = r.t; }
  return {
    rows: rows.length,
    directional: scoredRows.filter((r) => r.m !== 0).length,
    measured: outcomesByHorizon.get(DEFAULT_HORIZONS[0])?.length ?? 0,
    configIds: [...new Set(rows.map((r) => r.cfg))],
    from: rows.length ? from : 0,
    to: rows.length ? to : 0,
    horizons,
  };
}

/* ------------------------------------------------------------------ *
 *  CSV
 * ------------------------------------------------------------------ */
export const LEDGER_CSV_COLUMNS = [
  "id", "config_id", "engine_version", "app_version", "source", "timeframe", "pair", "asset_class",
  "bar_open_utc", "bar_close_utc", "recorded_utc", "close", "score", "direction", "strength",
  "suppressed", "low_volatility", "valid_voters", "bull", "bear", "efficiency_ratio",
  "bloc_trend", "bloc_mean_reversion", "bloc_breakout", "bloc_flow", "universe_rank", "quote_volume_24h",
  "reversal_dir", "reversal_conf", "warm_bars", "live", "underlying_closed",
  "universe_rank_full", "rank_source", "rs_percentile", "btc_beta", "htf_trend", "taker_delta",
  "macro_event_hours", "basis_pct", "band_pinned", "split_muted", "earnings_window", "engine_bars",
  // v2.8 (WP19) — appended, so v2.7 column positions are unchanged.
  "vote_vector", "pattern_dir", "pattern_conf", "funding_rate", "oi_change_pct",
] as const;

const iso = (ms: number) => (ms ? new Date(ms).toISOString() : "");
export function ledgerRowValues(r: LedgerRow): (string | number)[] {
  return [
    r.id, r.cfg, r.ev, r.app, r.src, r.tf, r.pair, r.ac, iso(r.t), iso(r.tc), iso(r.rec), r.c, r.sc,
    r.m === 1 ? "BUY" : r.m === -1 ? "SELL" : "NEUTRAL", ["WEAK", "MODERATE", "STRONG"][r.st],
    r.sup, r.lv, r.v, r.bu, r.be, r.er ?? "", ...[0, 1, 2, 3].map((i) => r.bl[i] ?? ""), r.rk, r.qv,
    r.rd, r.rc, r.wb, r.live, r.uc ?? 0,
    r.rku ?? "", r.rks ?? "", r.rs ?? "", r.beta ?? "", r.htf ?? "", r.td ?? "",
    r.mev ?? "", r.bp ?? "", r.pin ?? "", r.spl ?? "", r.earn ?? "", engineBarsOf(r),
    r.vt ?? "", r.pd ?? "", r.pc ?? "", r.fr ?? "", r.oiChg ?? "",
  ];
}

/* ------------------------------------------------------------------ *
 *  v2.3 — import (headless recorder JSONL, or the app's JSON export)
 * ------------------------------------------------------------------ */
const IMPORT_SOURCES = new Set(["binance", "bybit-spot", "bybit-perp", "bitget", "bitget-perp", "okx", "okx-perp", "coinbase", "upbit"]);
const IMPORT_CLASSES = new Set(["crypto", "rwa", "stock", "fx", "commodity"]);
const SAFE_PAIR = /^[A-Z0-9]{2,30}$/;
const SAFE_TOKEN = /^[A-Za-z0-9._-]{1,40}$/;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const optNum = (v: unknown) => (v === null || v === undefined ? v : finite(v) ? v : undefined);
export { FR_MAX, OI_CHG_MAX, OI_CHG_MIN };
const INVALID = Symbol("invalid");
/**
 * v2.8 (WP19) strict checks for the new fields: absent/null → null; a value
 * of the wrong type or out of range rejects the WHOLE row (a hostile or
 * corrupted file must not import half a row).
 */
function strictNew(r: Record<string, unknown>): Pick<LedgerRow, "vt" | "pd" | "pc" | "fr" | "oiChg"> | typeof INVALID {
  const nil = (v: unknown) => v === null || v === undefined;
  const { vt, pd, pc, fr, oiChg } = r;
  if (!nil(vt) && !(Number.isSafeInteger(vt) && (vt as number) >= 0 && (vt as number) <= VOTE_MAX)) return INVALID;
  if (!nil(pd) && pd !== -1 && pd !== 0 && pd !== 1) return INVALID;
  if (!nil(pc) && pc !== 0 && pc !== 1 && pc !== 2 && pc !== 3) return INVALID;
  if (!nil(fr) && !(finite(fr) && Math.abs(fr) <= FR_MAX)) return INVALID;
  if (!nil(oiChg) && !(finite(oiChg) && oiChg >= OI_CHG_MIN && oiChg <= OI_CHG_MAX)) return INVALID;
  return {
    vt: nil(vt) ? null : (vt as number), pd: nil(pd) ? null : (pd as -1 | 0 | 1), pc: nil(pc) ? null : (pc as 0 | 1 | 2 | 3),
    fr: nil(fr) ? null : (fr as number), oiChg: nil(oiChg) ? null : (oiChg as number),
  };
}

/**
 * Validate one untrusted row and return a clean copy with only known fields,
 * or null. The id must equal cfg|src|tf|pair|t, so an imported row can never
 * overwrite or masquerade as a different bar.
 */
export function sanitizeLedgerRow(x: unknown): LedgerRow | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  const str = (k: string, re = SAFE_TOKEN) => (typeof r[k] === "string" && re.test(r[k] as string) ? (r[k] as string) : null);
  const cfg = str("cfg", /^[0-9a-z]{1,40}$/);
  const src = str("src");
  const tf = str("tf", /^[0-9]{1,2}[mhdwM]$/);
  const pair = str("pair", SAFE_PAIR);
  const ac = str("ac");
  if (!cfg || !src || !tf || !pair || !ac || !IMPORT_SOURCES.has(src) || !IMPORT_CLASSES.has(ac)) return null;
  if (!finite(r.t) || !finite(r.tc) || !finite(r.c) || !finite(r.sc) || !finite(r.wb)) return null;
  if (r.id !== `${cfg}|${src}|${tf}|${pair}|${r.t}`) return null;
  const m = r.m === 1 || r.m === -1 || r.m === 0 ? r.m : null;
  const st = r.st === 0 || r.st === 1 || r.st === 2 ? r.st : null;
  if (m === null || st === null || Math.abs(r.sc as number) > 100) return null;
  const v28 = strictNew(r);
  if (v28 === INVALID) return null;
  const bl = Array.isArray(r.bl) && r.bl.length === 4 && r.bl.every(finite) ? (r.bl as number[]) : [0, 0, 0, 0];
  const bit = (v: unknown): 0 | 1 => (v === 1 || v === true ? 1 : 0);
  const out: LedgerRow = {
    id: r.id as string, cfg, ev: str("ev") ?? "", app: str("app") ?? "import", src, tf, pair, ac: ac as AssetClass,
    t: r.t as number, tc: r.tc as number, rec: finite(r.rec) ? r.rec : r.tc as number, c: r.c as number,
    sc: r.sc as number, m, st, sup: bit(r.sup), lv: bit(r.lv), v: finite(r.v) ? r.v : 0, bu: finite(r.bu) ? r.bu : 0,
    be: finite(r.be) ? r.be : 0, er: finite(r.er) ? r.er : null, bl, rk: finite(r.rk) ? r.rk : 0, qv: finite(r.qv) ? r.qv : 0,
    rd: r.rd === 1 || r.rd === -1 ? r.rd : 0, rc: r.rc === 1 || r.rc === 2 || r.rc === 3 ? r.rc : 0,
    wb: r.wb as number, live: bit(r.live), uc: bit(r.uc),
  } as LedgerRow;
  const extra: Partial<LedgerRow> = {
    rku: finite(r.rku) ? r.rku : undefined,
    rks: r.rks === "live" || r.rks === "now" || r.rks === "none" ? r.rks : undefined,
    rs: optNum(r.rs) as number | null | undefined, beta: optNum(r.beta) as number | null | undefined,
    htf: r.htf === 1 || r.htf === -1 || r.htf === 0 || r.htf === null ? (r.htf as -1 | 0 | 1 | null) : undefined,
    td: optNum(r.td) as number | null | undefined, mev: optNum(r.mev) as number | null | undefined,
    bp: optNum(r.bp) as number | null | undefined,
    pin: r.pin === 1 ? 1 : r.pin === 0 ? 0 : undefined, spl: r.spl === 1 ? 1 : r.spl === 0 ? 0 : undefined,
    earn: r.earn === 1 ? 1 : r.earn === 0 ? 0 : undefined,
    eb: finite(r.eb) && r.eb >= 0 ? r.eb : undefined,
  };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
  return Object.assign(out, v28);
}

/* ------------------------------------------------------------------ *
 *  v2.8 (WP19) — CSV import (the app's Export CSV and the replay's ledger.csv)
 * ------------------------------------------------------------------ */
/** RFC 4180 records (quoted fields, doubled quotes, CRLF or LF). */
function csvRecords(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.length > 1 || row[0] !== "") out.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); out.push(row); }
  return out;
}

const NUM_CELL = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const ISO_CELL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
/** A numeric cell → number; empty → null; anything else stays a string so the sanitiser rejects or drops it. */
const csvNum = (c: string | undefined): number | string | null => {
  if (c === undefined || c === "") return null;
  if (!NUM_CELL.test(c)) return c;
  const n = Number(c);
  return Number.isFinite(n) ? n : c;
};
const csvTime = (c: string | undefined): number | string | null => {
  if (c === undefined || c === "") return null;
  return ISO_CELL.test(c) && Number.isFinite(Date.parse(c)) ? Date.parse(c) : c;
};
const DIRECTION_CELL: Record<string, -1 | 0 | 1> = { BUY: 1, SELL: -1, NEUTRAL: 0 };
const STRENGTH_CELL: Record<string, 0 | 1 | 2> = { WEAK: 0, MODERATE: 1, STRONG: 2 };

/** True when `text` starts with the ledger CSV header (BOM and quotes tolerated). */
export function looksLikeLedgerCsv(text: string): boolean {
  return /^\uFEFF?"?id"?,"?config_id"?,/.test(text);
}

/**
 * Parse a ledger CSV into untrusted row objects (then sanitised like JSON).
 * Columns are found by header name, so a v2.7 file without the v2.8 columns
 * imports with those fields null, and extra columns (net_return_h*) are ignored.
 */
export function parseLedgerCsv(text: string, maxRows = 500_000): { rows: LedgerRow[]; rejected: number } {
  const recs = csvRecords(text.replace(/^\uFEFF/, ""));
  const header = recs.shift() ?? [];
  const col = new Map(header.map((h, i) => [h.trim(), i]));
  const rows: LedgerRow[] = [];
  let rejected = 0;
  for (const rec of recs) {
    if (rows.length >= maxRows) { rejected++; continue; }
    const get = (name: (typeof LEDGER_CSV_COLUMNS)[number]) => { const i = col.get(name); return i === undefined ? undefined : rec[i]; };
    const strOrNull = (name: (typeof LEDGER_CSV_COLUMNS)[number]) => { const v = get(name); return v === undefined || v === "" ? undefined : v; };
    const num = (name: (typeof LEDGER_CSV_COLUMNS)[number]) => csvNum(get(name));
    const opt = (name: (typeof LEDGER_CSV_COLUMNS)[number]) => { const v = num(name); return v === null ? undefined : v; };
    const wb = num("warm_bars");
    const eb = num("engine_bars");
    const raw: Record<string, unknown> = {
      id: get("id"), cfg: get("config_id"), ev: strOrNull("engine_version"), app: strOrNull("app_version"), src: get("source"), tf: get("timeframe"),
      pair: get("pair"), ac: get("asset_class"), t: csvTime(get("bar_open_utc")), tc: csvTime(get("bar_close_utc")), rec: csvTime(get("recorded_utc")) ?? undefined,
      c: num("close"), sc: num("score"), m: DIRECTION_CELL[get("direction") ?? ""] ?? null, st: STRENGTH_CELL[get("strength") ?? ""] ?? null,
      sup: num("suppressed"), lv: num("low_volatility"), v: num("valid_voters"), bu: num("bull"), be: num("bear"), er: num("efficiency_ratio"),
      bl: [num("bloc_trend"), num("bloc_mean_reversion"), num("bloc_breakout"), num("bloc_flow")], rk: num("universe_rank"), qv: num("quote_volume_24h"),
      rd: num("reversal_dir"), rc: num("reversal_conf"), wb, live: num("live"), uc: num("underlying_closed"),
      rku: opt("universe_rank_full"), rks: strOrNull("rank_source"), rs: num("rs_percentile"), beta: num("btc_beta"), htf: num("htf_trend"),
      td: num("taker_delta"), mev: num("macro_event_hours"), bp: num("basis_pct"), pin: opt("band_pinned"), spl: opt("split_muted"), earn: opt("earnings_window"),
      // engine_bars is exported as eb ?? wb: only a value that differs from warm_bars is a real eb.
      eb: eb !== null && eb !== wb ? eb : undefined,
      vt: num("vote_vector"), pd: num("pattern_dir"), pc: num("pattern_conf"), fr: num("funding_rate"), oiChg: num("oi_change_pct"),
    };
    const row = sanitizeLedgerRow(raw);
    if (row) rows.push(row); else rejected++;
  }
  return { rows, rejected };
}

/**
 * Parse recorder JSONL (one row per line) or the app's JSON export. Replay
 * rows (live = 0) are rejected by default: back-tested rows must never enter
 * the forward-test ledger (review S4).
 */
export function parseLedgerImport(text: string, maxRows = 500_000, liveOnly = true): { rows: LedgerRow[]; rejected: number } {
  const rows: LedgerRow[] = [];
  let rejected = 0;
  if (looksLikeLedgerCsv(text)) {
    const csv = parseLedgerCsv(text, maxRows);
    const kept = liveOnly ? csv.rows.filter((r) => r.live === 1) : csv.rows;
    return { rows: kept, rejected: csv.rejected + csv.rows.length - kept.length };
  }
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  let items: unknown[] = [];
  if (trimmed.startsWith("{") && !trimmed.includes("\n{")) {
    try {
      const doc = JSON.parse(trimmed) as { format?: string; rows?: unknown[] };
      items = doc.format === "rsl-signal-ledger" && Array.isArray(doc.rows) ? doc.rows : [doc];
    } catch { items = []; rejected++; }
  } else {
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { items.push(JSON.parse(line)); } catch { rejected++; }
    }
  }
  for (const it of items) {
    if (rows.length >= maxRows) { rejected++; continue; }
    const r = sanitizeLedgerRow(it);
    if (r && (!liveOnly || r.live === 1)) rows.push(r); else rejected++;
  }
  return { rows, rejected };
}
