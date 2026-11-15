/**
 * risk-engine.ts — v2.2 Phase G (PAPER ONLY)
 * ----------------------------------------------------------------------------
 * Pure, deterministic pre-trade risk check for the paper-trading simulator.
 * Same input → same verdict: no clock, no randomness, no I/O. The caller
 * passes `now` explicitly.
 *
 * Boundary (ADR-0010): this module sizes SIMULATED positions only. Nothing in
 * this file, or anything it imports, can reach an exchange. No orders, no
 * network, no API keys, and no LLM in the decision path.
 *
 * A verdict lists EVERY failed rule (not just the first), as i18n keys
 * ("paper.rule.*"), so the owner sees the full picture before approving.
 * ----------------------------------------------------------------------------
 */
import { splitPair, stableQuote } from "./quotes";
import { inBlackout } from "./macro-calendar";
import type { AssetClass } from "./ledger-metrics";

export type Side = "long" | "short";
export type Strength = "STRONG" | "MODERATE" | "WEAK";
export type Master = "BULLISH" | "BEARISH" | "NEUTRAL";

/** Everything the risk engine needs to know about one candidate trade. */
export interface ProposalInput {
  pair: string;
  src: string;
  tf: string;
  assetClass: AssetClass;
  side: Side;
  /** Reference price: close of the signal bar. The real (simulated) fill is the next bar's open. */
  entryRef: number;
  /** ATR(14) on the signal bar, in price units. */
  atr: number;
  /** Master score −100..100. */
  score: number;
  strength: Strength;
  master: Master;
  suppressed: boolean;
  /** Stock/FX/commodity: the underlying market was closed for the whole signal bar. */
  underlyingClosed: boolean;
  configId: string;
  /** Open time of the signal bar (ms). */
  barTime: number;
  /** Bar length (ms). */
  intervalMs: number;
  /** Optional exchange lot step; derived from price when absent. */
  lotStep?: number;
  /** v2.8: round-trip cost as a fraction of entry, 2 × (taker fee + slippage); sized inside the risk budget. */
  roundTripCost?: number;
  /** v2.8: the measured one-side slippage (bp) that went into roundTripCost; frozen on the position at approval. */
  measuredSlipBps?: number;
  /** v2.8: the quote stablecoin's deviation from USDT in % (null for USDT itself or no reading). */
  depegPct?: number | null;
}

/** Minimal view of an open (or pending) paper position the engine needs. */
export interface OpenRiskItem {
  pair: string;
  src: string;
  assetClass: AssetClass;
  side: Side;
  /** Initial risk in quote currency (size × stop distance). */
  riskAmount: number;
  /** Notional at entry (or at the reference price while pending). */
  notional: number;
}

export interface AccountState {
  /** Current equity (realised balance + unrealised P&L), quote currency. */
  equity: number;
  positions: OpenRiskItem[];
  /** Net realised P&L since 00:00 UTC today (negative = loss). */
  realisedToday: number;
  /** Net realised P&L since Monday 00:00 UTC (negative = loss). */
  realisedWeek: number;
  killSwitch: boolean;
  /** Last scan heartbeat for this proposal's source × timeframe (ms; 0 = never). */
  lastHeartbeat: number;
  /** v2.8: highest marked equity (incl. open P&L) since the book started or the last drawdown RESET. */
  peakEquity?: number;
  /** v2.8: the drawdown lock is engaged (clears only by RESET). */
  drawdownLocked?: boolean;
  /** v2.8: equity at the first mark at or after 00:00 UTC today / Monday — open losses then count in the locks. */
  dayStartEquity?: number;
  weekStartEquity?: number;
}

export interface RiskSettings {
  /** Risk per trade, % of equity. */
  riskPerTradePct: number;
  /** Sum of initial risk over all open positions, % of equity. */
  maxOpenRiskPct: number;
  maxPositions: number;
  /** Positions per cluster (asset class; crypto split into majors vs alts). */
  maxPerClusterPositions: number;
  /** Lock new approvals once today's realised loss reaches this % of start-of-day balance. */
  dailyLossLockPct: number;
  /** Same, for the UTC week (Monday 00:00). */
  weeklyLossLockPct: number;
  /** Stop distance = stopAtrMult × ATR. */
  stopAtrMult: number;
  /** Target distance = targetRR × stop distance. */
  targetRR: number;
  /** Minimum |score|. */
  minScoreAbs: number;
  /** Spot cannot be shorted without borrowing; off by default. */
  allowShortsOnSpot: boolean;
  /** Reject signals whose bar closed more than `maxSignalAgeBars` bars ago. */
  requireFreshSignal: boolean;
  maxSignalAgeBars: number;
  /** Dead-man switch: block approvals when no scan heartbeat for more than this many bars. */
  deadManBars: number;
  /** Total notional of all positions ≤ maxLeverage × equity (1 = no leverage). */
  maxLeverage: number;
  /** v2.8: stop and close everything once equity falls this % below its highest mark. */
  maxDrawdownLockPct: number;
  /** v2.8: open crypto positions at once (crypto moves together). */
  maxCryptoPositions: number;
  /** v2.8: block proposals 2 h before to 1 h after FOMC / CPI / NFP. */
  eventBlackout: boolean;
  /** v2.8: close after this many bars held (0 = off; preset 24 when turned on). */
  timeStopBars: number;
  /** v2.8: 1m–15m proposals are context only unless this is on. */
  allowIntradayProposals: boolean;
}

export const DEFAULT_RISK_SETTINGS: RiskSettings = {
  riskPerTradePct: 0.5,
  maxOpenRiskPct: 2,
  maxPositions: 5,
  maxPerClusterPositions: 2,
  dailyLossLockPct: 2,
  weeklyLossLockPct: 5,
  stopAtrMult: 2,
  targetRR: 2,
  minScoreAbs: 55,
  allowShortsOnSpot: false,
  requireFreshSignal: true,
  maxSignalAgeBars: 1,
  deadManBars: 3,
  maxLeverage: 1,
  maxDrawdownLockPct: 10,
  maxCryptoPositions: 3,
  eventBlackout: true,
  timeStopBars: 0,
  allowIntradayProposals: false,
};

/** v2.8: settings whose increase loosens risk — refused while a lock is active and until the next UTC day. */
export const LOOSENING_KEYS = ["dailyLossLockPct", "weeklyLossLockPct", "maxDrawdownLockPct", "riskPerTradePct", "maxOpenRiskPct", "maxLeverage"] as const;
/** v2.8: boolean settings. */
export const BOOLEAN_SETTINGS = ["allowShortsOnSpot", "requireFreshSignal", "eventBlackout", "allowIntradayProposals"] as const;
/** v2.8: preset offered when the time stop is turned on. */
export const TIME_STOP_PRESET_BARS = 24;
/** Bars to put in the time-stop field when the on/off checkbox changes: the preset when turned on, 0 when off. */
export const timeStopToggleBars = (on: boolean): number => (on ? TIME_STOP_PRESET_BARS : 0);
/** v2.8: proposals at or below this bar length are intraday context. */
export const INTRADAY_MAX_MS = 15 * 60_000;

/** Valid range for every numeric setting: [min, max]. Used by the settings form and `validateSettings`. */
export const RISK_SETTING_LIMITS: Record<Exclude<keyof RiskSettings, (typeof BOOLEAN_SETTINGS)[number]>, [number, number]> = {
  riskPerTradePct: [0.01, 5],
  maxOpenRiskPct: [0.1, 20],
  maxPositions: [1, 50],
  maxPerClusterPositions: [1, 50],
  dailyLossLockPct: [0.1, 50],
  weeklyLossLockPct: [0.1, 80],
  stopAtrMult: [0.25, 10],
  targetRR: [0.25, 10],
  minScoreAbs: [0, 100],
  maxSignalAgeBars: [0, 10],
  deadManBars: [1, 100],
  // v2.8: capped at 1 until liquidation is modelled.
  maxLeverage: [0.1, 1],
  maxDrawdownLockPct: [1, 50],
  maxCryptoPositions: [1, 50],
  timeStopBars: [0, 1000],
};

/** Integer-only settings. */
const INTEGER_SETTINGS = new Set(["maxPositions", "maxPerClusterPositions", "maxSignalAgeBars", "deadManBars", "maxCryptoPositions", "timeStopBars"]);

/** Returns the names of invalid fields (empty = valid). */
export function validateSettings(s: Partial<RiskSettings>): string[] {
  const bad: string[] = [];
  for (const [key, [lo, hi]] of Object.entries(RISK_SETTING_LIMITS)) {
    const v = (s as Record<string, unknown>)[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi || (INTEGER_SETTINGS.has(key) && !Number.isInteger(v))) bad.push(key);
  }
  for (const key of BOOLEAN_SETTINGS) if (typeof s[key] !== "boolean") bad.push(key);
  return bad;
}

/** Merge stored settings over the defaults, dropping invalid values. */
export function normaliseSettings(s: Partial<RiskSettings> | null | undefined): RiskSettings {
  const out: RiskSettings = { ...DEFAULT_RISK_SETTINGS };
  if (!s) return out;
  const merged = { ...DEFAULT_RISK_SETTINGS, ...s };
  const bad = new Set(validateSettings(merged));
  for (const key of Object.keys(DEFAULT_RISK_SETTINGS) as (keyof RiskSettings)[]) {
    if (!bad.has(key)) (out as unknown as Record<string, unknown>)[key] = merged[key];
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  Classification helpers
 * ------------------------------------------------------------------ */
/** Crypto majors cluster; every other crypto pair is an "alt". */
export const CRYPTO_MAJORS = new Set(["BTC", "ETH"]);

/** Base asset of a pair (BTCUSDT → BTC; v2.7: BTCFDUSD → BTC, ETHPERP → ETH, BTCU on Binance → BTC). */
export function baseOf(pair: string, src?: string): string {
  const { base, quote } = splitPair(pair, src || (/PERP$/i.test(pair) ? "bybit-perp" : undefined));
  return (quote ? base : pair).toUpperCase();
}

/**
 * v2.7: is the pair quoted in a USD-pegged stablecoin (the paper account's currency family)? v2.8 (WP26 final
 * review I-1): Coinbase's own plain-USD books are US dollars too. Gated on the source, so fiat or inverse USD books
 * on other venues stay refused.
 */
export function usdQuoted(pair: string, src = ""): boolean {
  const q = splitPair(pair, src || (/PERP$/i.test(pair) ? "bybit-perp" : undefined)).quote;
  return stableQuote(q)?.peg === "USD" || (src === "coinbase" && q === "USD");
}

/** Correlation cluster: asset class, with crypto split into majors and alts. */
export function clusterOf(assetClass: AssetClass, pair: string, src?: string): string {
  if (assetClass !== "crypto") return assetClass;
  return CRYPTO_MAJORS.has(baseOf(pair, src)) ? "crypto-major" : "crypto-alt";
}

/** Perpetual sources can be shorted without borrowing. */
export function isPerpSource(src: string): boolean {
  return /perp/i.test(src);
}

/**
 * Default lot step: a power of ten worth at most ~1 quote unit per step,
 * capped at 1 unit (BTC @ 100 000 → 0.00001; ETH @ 3 000 → 0.0001; 0.5 → 1).
 */
export function defaultLotStep(price: number): number {
  if (!(price > 0) || !Number.isFinite(price)) return 1;
  // −ceil(log10 p) with a little slack, so exact powers of ten are not pushed down a decade.
  const exp = -Math.ceil(Math.log10(price) - 1e-9);
  return Math.min(1, Number(`1e${exp}`));
}

/** Round `units` DOWN to a multiple of `step` (never more risk than planned). */
export function roundToStep(units: number, step: number): number {
  if (!(units > 0) || !(step > 0)) return 0;
  const n = Math.floor(units / step + 1e-9);
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
  return Number((n * step).toFixed(Math.min(12, decimals)));
}

/* ------------------------------------------------------------------ *
 *  Verdict
 * ------------------------------------------------------------------ */
export type RuleKey =
  | "paper.rule.invalidInput"
  | "paper.rule.killSwitch"
  | "paper.rule.deadMan"
  | "paper.rule.dailyLock"
  | "paper.rule.weeklyLock"
  | "paper.rule.drawdownLock"
  | "paper.rule.cryptoCap"
  | "paper.rule.depeg"
  | "paper.rule.intradayContext"
  | "paper.rule.event"
  | "paper.rule.maxPositions"
  | "paper.rule.openRisk"
  | "paper.rule.cluster"
  | "paper.rule.duplicate"
  | "paper.rule.spotShort"
  | "paper.rule.stale"
  | "paper.rule.score"
  | "paper.rule.neutral"
  | "paper.rule.suppressed"
  | "paper.rule.sideMismatch"
  | "paper.rule.underlyingClosed"
  | "paper.rule.notional"
  | "paper.rule.currency";

export interface RiskVerdict {
  approved: boolean;
  /** Every failed rule, as i18n keys. Empty when approved. */
  reasons: RuleKey[];
  /** Units, rounded down to the lot step (0 when not sizeable). */
  size: number;
  /** Stop and target relative to the reference price (re-anchored to the fill by the broker). */
  stop: number;
  target: number;
  stopDistance: number;
  /** size × stopDistance, quote currency. */
  riskAmount: number;
  /** size × entryRef. */
  notional: number;
  lotStep: number;
  cluster: string;
  /** True when the size was reduced to fit the leverage cap. */
  capped: boolean;
  /** v2.8: advisory warnings (i18n keys); they never block. */
  warnings: WarningKey[];
}

export type WarningKey = "paper.warn.riskAbove1";

/** v2.8: daily / weekly loss locks, on the stricter of two bases: the start-of-period mark (open losses count) and
 * the v2.2 realised basis (realised loss over equity − realised) — so a loss realised before the mark was set,
 * or an engine-only caller without marks, still locks. */
export function lossLocks(acct: AccountState, s: RiskSettings): { daily: boolean; weekly: boolean } {
  const hit = (start: number | undefined, realised: number, pct: number) => {
    const marked = typeof start === "number" && start > 0 && start - acct.equity >= (pct / 100) * start - 1e-9;
    const base = acct.equity - realised;
    return marked || (realised < 0 && base > 0 && -realised >= (pct / 100) * base);
  };
  return { daily: hit(acct.dayStartEquity, acct.realisedToday, s.dailyLossLockPct), weekly: hit(acct.weekStartEquity, acct.realisedWeek, s.weeklyLossLockPct) };
}

const finitePos = (v: number) => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Bars elapsed since the signal bar CLOSED (0 while still inside the following bar's first instant). */
export function signalAgeBars(barTime: number, intervalMs: number, now: number): number {
  return (now - (barTime + intervalMs)) / intervalMs;
}

/** True when the dead-man switch is tripped for a series (no heartbeat for > deadManBars bars). */
export function deadManTripped(lastHeartbeat: number, intervalMs: number, now: number, deadManBars: number): boolean {
  return !(lastHeartbeat > 0) || now - lastHeartbeat > deadManBars * intervalMs;
}

/** v2.8: the drawdown lock is engaged, or equity is at or below peak × (1 − maxDrawdownLockPct). */
export function drawdownBreached(acct: Pick<AccountState, "equity" | "peakEquity" | "drawdownLocked">, s: RiskSettings): boolean {
  if (acct.drawdownLocked) return true;
  const peak = acct.peakEquity;
  return typeof peak === "number" && peak > 0 && acct.equity <= peak * (1 - s.maxDrawdownLockPct / 100) + 1e-9;
}

/**
 * Evaluate one proposal against the account and settings at instant `now`.
 * Pure and deterministic.
 */
export function evaluateProposal(p: ProposalInput, acct: AccountState, s: RiskSettings, now: number): RiskVerdict {
  const reasons: RuleKey[] = [];
  const cluster = clusterOf(p.assetClass, p.pair, p.src);
  const lotStep = p.lotStep && p.lotStep > 0 ? p.lotStep : defaultLotStep(p.entryRef);
  const dir = p.side === "long" ? 1 : -1;
  const rt = typeof p.roundTripCost === "number" && Number.isFinite(p.roundTripCost) && p.roundTripCost > 0 ? p.roundTripCost : 0;

  const inputOk = finitePos(p.entryRef) && finitePos(p.atr) && finitePos(p.intervalMs) && finitePos(acct.equity) && Number.isFinite(p.score);
  const stopDistance = inputOk ? s.stopAtrMult * p.atr : NaN;
  const stop = inputOk ? p.entryRef - dir * stopDistance : NaN;
  const target = inputOk ? p.entryRef + dir * stopDistance * s.targetRR : NaN;
  // A long stop at or below zero means the ATR is nonsense for this price.
  if (!inputOk || !(stopDistance > 0) || !(stop > 0) || !(target > 0)) reasons.push("paper.rule.invalidInput");

  // Account-level locks.
  if (acct.killSwitch) reasons.push("paper.rule.killSwitch");
  if (deadManTripped(acct.lastHeartbeat, p.intervalMs, now, s.deadManBars)) reasons.push("paper.rule.deadMan");
  const locks = lossLocks(acct, s);
  if (locks.daily) reasons.push("paper.rule.dailyLock");
  if (locks.weekly) reasons.push("paper.rule.weeklyLock");
  if (drawdownBreached(acct, s)) reasons.push("paper.rule.drawdownLock");

  // Portfolio rules.
  if (acct.positions.length >= s.maxPositions) reasons.push("paper.rule.maxPositions");
  if (acct.positions.filter((x) => clusterOf(x.assetClass, x.pair, x.src) === cluster).length >= s.maxPerClusterPositions) reasons.push("paper.rule.cluster");
  // v2.7 (review #3): one position per BASE asset (BTCUSDT and BTCUSDC/BTCPHP are the same exposure).
  if (acct.positions.some((x) => x.pair.toUpperCase() === p.pair.toUpperCase() || baseOf(x.pair, x.src) === baseOf(p.pair, p.src))) reasons.push("paper.rule.duplicate");
  // The paper account is kept in US dollars: only pairs quoted in a USD stablecoin (or Coinbase's own USD books,
  // v2.8 WP26) can be sized and booked in it (v2.6 booked Coins.ph peso amounts as USDT).
  if (!usdQuoted(p.pair, p.src)) reasons.push("paper.rule.currency");
  // v2.8: crypto moves together — cap open crypto positions across clusters.
  if (p.assetClass === "crypto" && acct.positions.filter((x) => x.assetClass === "crypto").length >= s.maxCryptoPositions) reasons.push("paper.rule.cryptoCap");
  // v2.8: the quote stablecoin is off its peg against USDT (DEPEG_TIERS "warning" or "severe").
  if (typeof p.depegPct === "number" && Number.isFinite(p.depegPct) && Math.abs(p.depegPct) >= 1) reasons.push("paper.rule.depeg");
  // v2.8: 1m–15m signals are context, not trades, unless allowed.
  if (!s.allowIntradayProposals && finitePos(p.intervalMs) && p.intervalMs <= INTRADAY_MAX_MS) reasons.push("paper.rule.intradayContext");
  // v2.8: 2 h before to 1 h after FOMC / CPI / jobs report.
  if (s.eventBlackout && inBlackout(now)) reasons.push("paper.rule.event");
  if (p.side === "short" && !isPerpSource(p.src) && !s.allowShortsOnSpot) reasons.push("paper.rule.spotShort");

  // Signal rules.
  if (p.master === "NEUTRAL") reasons.push("paper.rule.neutral");
  else if ((p.master === "BULLISH" && p.side !== "long") || (p.master === "BEARISH" && p.side !== "short")) reasons.push("paper.rule.sideMismatch");
  if (p.suppressed) reasons.push("paper.rule.suppressed");
  if (!(Math.abs(p.score) >= s.minScoreAbs)) reasons.push("paper.rule.score");
  if (s.requireFreshSignal && finitePos(p.intervalMs) && signalAgeBars(p.barTime, p.intervalMs, now) > s.maxSignalAgeBars) reasons.push("paper.rule.stale");
  // Bars printed while the stock/FX/commodity reference market was shut carry synthetic prices.
  if (p.underlyingClosed) reasons.push("paper.rule.underlyingClosed");

  // Sizing: risk a fixed fraction of equity over the ATR stop, rounded down to the lot step.
  let size = 0;
  let capped = false;
  if (!reasons.includes("paper.rule.invalidInput")) {
    const riskBudget = (s.riskPerTradePct / 100) * acct.equity;
    // v2.8: the round-trip cost sits inside the budget, so a clean stop-out is ≈ −1 R.
    size = roundToStep(riskBudget / (stopDistance + p.entryRef * rt), lotStep);
    // Leverage cap: total notional of all positions ≤ maxLeverage × equity.
    const usedNotional = acct.positions.reduce((a, x) => a + (Number.isFinite(x.notional) ? x.notional : 0), 0);
    const room = s.maxLeverage * acct.equity - usedNotional;
    const maxUnits = room > 0 ? roundToStep(room / p.entryRef, lotStep) : 0;
    if (size > maxUnits) { size = maxUnits; capped = true; }
    if (!(size > 0)) reasons.push("paper.rule.notional");
    const openRisk = acct.positions.reduce((a, x) => a + (Number.isFinite(x.riskAmount) ? x.riskAmount : 0), 0);
    if (openRisk + size * (stopDistance + p.entryRef * rt) > (s.maxOpenRiskPct / 100) * acct.equity + 1e-9) reasons.push("paper.rule.openRisk");
  }

  const riskAmount = size > 0 ? size * (stopDistance + p.entryRef * rt) : 0;
  const warnings: WarningKey[] = s.riskPerTradePct > 1 ? ["paper.warn.riskAbove1"] : [];
  return {
    approved: reasons.length === 0,
    reasons,
    size,
    stop: Number.isFinite(stop) ? stop : 0,
    target: Number.isFinite(target) ? target : 0,
    stopDistance: Number.isFinite(stopDistance) ? stopDistance : 0,
    riskAmount,
    notional: size * (p.entryRef || 0),
    lotStep,
    cluster,
    capped,
    warnings,
  };
}
