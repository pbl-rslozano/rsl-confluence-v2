/**
 * paper-broker.ts — v2.2 Phase G (PAPER ONLY)
 * ----------------------------------------------------------------------------
 * A pure simulator of assisted execution. It never talks to an exchange: no
 * orders (real or demo), no network, no API keys, no LLM. Every function takes
 * a book and returns a NEW book; the caller persists it (paper-store.ts).
 *
 * Fill rules (same no-look-ahead rule as the signal ledger):
 *   • A signal is formed on the CLOSE of bar t. An approved proposal fills at
 *     the OPEN of the first bar that opens at or after the approval instant
 *     (and strictly after bar t) — never at the signal bar's close.
 *   • Slippage moves every fill against the position; a taker fee is paid on
 *     entry and exit (DEFAULT_COSTS by source). Perpetuals accrue funding pro
 *     rata per bar held (fundingBpsPer8h × bar hours / 8; longs pay, shorts
 *     receive), the same model the ledger uses.
 *   • Stop and target are re-anchored to the fill (same distances as sized).
 *     On each new CLOSED bar: a gap through the stop exits at the open; if a
 *     bar touches both stop and target, the STOP is assumed to have hit first.
 *   • A manual close exits at the next bar's open.
 *
 * Proposals carry a random nonce and expire at the close of the bar after the
 * signal bar. Approval must present the same nonce, is single-use, and re-runs
 * the risk engine against the account as it is at approval time.
 * ----------------------------------------------------------------------------
 */
import type { Kline } from "./indicators";
import { costsFor as ledgerCostsFor, type AssetClass, type CostModel } from "./ledger-metrics";
import {
  deadManTripped,
  evaluateProposal,
  LOOSENING_KEYS,
  lossLocks,
  normaliseSettings,
  validateSettings,
  type AccountState,
  type ProposalInput,
  type RiskSettings,
  type RiskVerdict,
  type Side,
} from "./risk-engine";

export const PAPER_SCHEMA = 2;
export const DEFAULT_STARTING_EQUITY = 10_000;
/** The typed word that resets the kill switch. Not translated. */
export const KILL_RESET_WORD = "RESET";
/** Reconciled paper/demo trades required before anything beyond paper is considered (ADR-0010). */
export const RECONCILE_GATE_TRADES = 50;
const MAX_NONCES = 2_000;
const DECISION_TTL_MS = 14 * 86_400_000;
const DAY = 86_400_000;

export type PositionStatus = "pending" | "open";
export type ExitReason = "stop" | "target" | "manual" | "drawdown lock" | "time";

export interface PaperPosition {
  id: string;
  proposalId: string;
  configId: string;
  pair: string;
  src: string;
  tf: string;
  assetClass: AssetClass;
  side: Side;
  size: number;
  stopDistance: number;
  targetDistance: number;
  /** size × stopDistance — the 1R of this trade. */
  plannedRisk: number;
  /** Signal-bar close used for sizing. */
  refPrice: number;
  signalBarTime: number;
  intervalMs: number;
  approvedAt: number;
  status: PositionStatus;
  /** Fill price incl. slippage (null while pending). */
  entry: number | null;
  /** Open time of the fill bar (null while pending). */
  openedAt: number | null;
  stop: number;
  target: number;
  entryFee: number;
  /** Funding paid so far (negative = received). */
  funding: number;
  mark: number;
  markTime: number;
  /** Newest bar already processed for this position. */
  lastBarTime: number;
  /** Set by a manual close; the exit happens at the first bar opening at or after it. */
  closeRequestedAt: number | null;
  /** v2.8: why the close was requested (absent = manual). */
  closeReason?: ExitReason;
}

export interface JournalEntry {
  id: string;
  openedAt: number;
  closedAt: number;
  pair: string;
  src: string;
  tf: string;
  side: Side;
  size: number;
  entry: number;
  exit: number;
  stop: number;
  target: number;
  /** Entry + exit fees. */
  fees: number;
  /** Funding paid (negative = received). */
  funding: number;
  /** Net P&L after fees and funding, quote currency. */
  pnl: number;
  /** pnl ÷ planned risk. */
  r: number;
  reason: ExitReason;
  configId: string;
  proposalId: string;
  approvedAt: number;
  approvedBy: "owner";
}

export interface PaperAccount {
  schema: typeof PAPER_SCHEMA;
  createdAt: number;
  startingEquity: number;
  /** Starting equity + realised net P&L. */
  balance: number;
  killSwitch: boolean;
  killChangedAt: number;
  /** Last scan heartbeat per `${src}|${tf}`. */
  heartbeats: Record<string, number>;
  settings: RiskSettings;
  /** Nonces already presented (single-use), newest last, bounded. */
  usedNonces: string[];
  /** Decided proposals, so a decided signal is not proposed again. */
  decisions: Record<string, { d: "approved" | "rejected" | "blocked" | "expired"; at: number }>;
  seq: number;
  /** v2.8 (schema 2): highest marked equity since the start or the last drawdown RESET. */
  peakEquity: number;
  /** v2.8: drawdown lock engaged; clears only by RESET once every lock close has filled. */
  drawdownLocked: boolean;
  /** v2.8: when a lock (drawdown) was last cleared — the no-loosening rule runs until the next UTC day. */
  lockClearedAt: number | null;
  /** v2.8: journal of drawdown RESETs. */
  resets: { at: number; equity: number; peakBefore: number }[];
  /** v2.8: equity at the first mark at or after 00:00 UTC (day) and Monday 00:00 UTC (week). */
  dayMark: { day: number; equity: number };
  weekMark: { week: number; equity: number };
  /** v2.8: last instant any lock (daily, weekly, drawdown, kill) was seen active or cleared — no loosening until the next UTC day. */
  lastLockAt: number | null;
}

export interface PaperBook {
  account: PaperAccount;
  positions: PaperPosition[];
  journal: JournalEntry[];
}

export interface Proposal {
  id: string;
  nonce: string;
  createdAt: number;
  /** Close of the bar after the signal bar. */
  expiresAt: number;
  input: ProposalInput;
  /** Verdict at creation (informational; re-run at approval). */
  verdict: RiskVerdict;
}

/* ------------------------------------------------------------------ *
 *  Book basics
 * ------------------------------------------------------------------ */
export function newBook(now: number, startingEquity = DEFAULT_STARTING_EQUITY, settings?: Partial<RiskSettings>): PaperBook {
  const eq = startingEquity > 0 && Number.isFinite(startingEquity) ? startingEquity : DEFAULT_STARTING_EQUITY;
  return {
    account: {
      schema: PAPER_SCHEMA,
      createdAt: now,
      startingEquity: eq,
      balance: eq,
      killSwitch: false,
      killChangedAt: 0,
      heartbeats: {},
      settings: normaliseSettings(settings),
      usedNonces: [],
      decisions: {},
      seq: 0,
      peakEquity: eq,
      drawdownLocked: false,
      lockClearedAt: null,
      resets: [],
      dayMark: { day: utcDayStart(now), equity: eq },
      weekMark: { week: utcWeekStart(now), equity: eq },
      lastLockAt: null,
    },
    positions: [],
    journal: [],
  };
}

export const seriesKey = (src: string, tf: string) => `${src}|${tf}`;
/** Same cost model as the ledger, including the per-class slippage extra (review S14). */
export const costsFor = (src: string, ac: AssetClass = "crypto"): CostModel => ledgerCostsFor(src, ac);
const dirOf = (side: Side) => (side === "long" ? 1 : -1);

/** Unrealised net P&L of a position at its mark (entry fee and funding so far included). */
export function unrealised(p: PaperPosition): number {
  if (p.status !== "open" || p.entry == null) return 0;
  return dirOf(p.side) * (p.mark - p.entry) * p.size - p.entryFee - p.funding;
}

export function bookEquity(book: PaperBook): number {
  return book.account.balance + book.positions.reduce((a, p) => a + unrealised(p), 0);
}

export function openRisk(book: PaperBook): number {
  return book.positions.reduce((a, p) => a + p.plannedRisk, 0);
}

export function utcDayStart(ms: number): number {
  return Math.floor(ms / DAY) * DAY;
}
/** Monday 00:00 UTC of the week containing `ms`. */
export function utcWeekStart(ms: number): number {
  const d = utcDayStart(ms);
  const dow = new Date(d).getUTCDay(); // 0 = Sunday
  return d - ((dow + 6) % 7) * DAY;
}
export function realisedSince(journal: JournalEntry[], since: number): number {
  return journal.reduce((a, j) => (j.closedAt >= since ? a + j.pnl : a), 0);
}

/** Account state the risk engine sees for a proposal on `src × tf` at `now`. */
export function accountSnapshot(book: PaperBook, src: string, tf: string, now: number): AccountState {
  return {
    equity: bookEquity(book),
    positions: book.positions.map((p) => ({
      pair: p.pair,
      src: p.src,
      assetClass: p.assetClass,
      side: p.side,
      riskAmount: p.plannedRisk,
      notional: p.size * (p.entry ?? p.refPrice),
    })),
    realisedToday: realisedSince(book.journal, utcDayStart(now)),
    realisedWeek: realisedSince(book.journal, utcWeekStart(now)),
    killSwitch: book.account.killSwitch,
    lastHeartbeat: book.account.heartbeats[seriesKey(src, tf)] ?? 0,
    peakEquity: book.account.peakEquity,
    drawdownLocked: book.account.drawdownLocked,
    // v2.8: open losses count — no mark yet this period means nothing has moved since it began.
    dayStartEquity: book.account.dayMark?.day === utcDayStart(now) ? book.account.dayMark.equity : undefined,
    weekStartEquity: book.account.weekMark?.week === utcWeekStart(now) ? book.account.weekMark.equity : undefined,
  };
}

/** Dead-man state for a position: no scan of its series for more than `deadManBars` bars. */
export function isUnmanaged(book: PaperBook, p: PaperPosition, now: number): boolean {
  return deadManTripped(book.account.heartbeats[seriesKey(p.src, p.tf)] ?? 0, p.intervalMs, now, book.account.settings.deadManBars);
}

/** Lock flags for the account summary. */
export function lockState(book: PaperBook, src: string, tf: string, intervalMs: number, now: number) {
  const s = book.account.settings;
  const snap = accountSnapshot(book, src, tf, now);
  const loss = lossLocks(snap, s);
  return {
    daily: loss.daily,
    weekly: loss.weekly,
    kill: book.account.killSwitch,
    deadMan: deadManTripped(snap.lastHeartbeat, intervalMs, now, s.deadManBars),
    realisedToday: snap.realisedToday,
    realisedWeek: snap.realisedWeek,
    drawdown: book.account.drawdownLocked,
    /** Fall from the peak, fraction of the peak. */
    drawdownPct: book.account.peakEquity > 0 ? Math.max(0, (book.account.peakEquity - snap.equity) / book.account.peakEquity) : 0,
  };
}

/* ------------------------------------------------------------------ *
 *  Proposals (nonce-bound, single-use, expiring)
 * ------------------------------------------------------------------ */
/** 128-bit random hex nonce (Web Crypto; available in browsers and Node ≥ 19). */
export function randomNonce(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function proposalId(p: ProposalInput): string {
  return `${p.configId}|${p.src}|${p.tf}|${p.pair}|${p.barTime}|${p.side}`;
}

/** Expiry: close of the bar after the signal bar. */
export function proposalExpiry(p: ProposalInput): number {
  return p.barTime + 2 * p.intervalMs;
}

/**
 * Build a proposal for a signal, or null when it was already decided or has
 * expired. `nonce` is injected so the function stays pure (use `randomNonce()`).
 */
/** v2.8: the proposal with its round-trip cost (2 × (taker fee + slippage)) filled in from the cost model. */
export function withCosts(input: ProposalInput, measuredSlipBps?: number): ProposalInput {
  if (typeof input.roundTripCost === "number") return input;
  const c = ledgerCostsFor(input.src, input.assetClass, measuredSlipBps);
  return { ...input, roundTripCost: (2 * (c.feeBps + c.slipBps)) / 1e4 };
}

export function createProposal(book: PaperBook, rawInput: ProposalInput, now: number, nonce: string): Proposal | null {
  const input = withCosts(rawInput);
  const id = proposalId(input);
  if (book.account.decisions[id]) return null;
  const expiresAt = proposalExpiry(input);
  if (now > expiresAt) return null;
  const verdict = evaluateProposal(input, accountSnapshot(book, input.src, input.tf, now), book.account.settings, now);
  return { id, nonce, createdAt: now, expiresAt, input, verdict };
}

export type DecisionError = "nonce" | "used" | "expired" | "risk";

export interface DecisionResult {
  ok: boolean;
  book: PaperBook;
  error?: DecisionError;
  /** Verdict re-run at approval time (approve only). */
  verdict?: RiskVerdict;
  position?: PaperPosition;
}

function consume(book: PaperBook, proposal: Proposal, d: PaperAccount["decisions"][string]["d"], now: number): PaperBook {
  const usedNonces = [...book.account.usedNonces, proposal.nonce].slice(-MAX_NONCES);
  const decisions: PaperAccount["decisions"] = {};
  for (const [k, v] of Object.entries(book.account.decisions)) if (now - v.at <= DECISION_TTL_MS) decisions[k] = v;
  decisions[proposal.id] = { d, at: now };
  return { ...book, account: { ...book.account, usedNonces, decisions } };
}

function checkNonce(book: PaperBook, proposal: Proposal, presented: string): DecisionError | null {
  if (typeof presented !== "string" || !presented || presented !== proposal.nonce) return "nonce";
  if (book.account.usedNonces.includes(presented) || book.account.decisions[proposal.id]) return "used";
  return null;
}

/** Approve: same nonce, single-use, not expired, and the risk engine must pass again NOW. */
export function approveProposal(book: PaperBook, proposal: Proposal, presentedNonce: string, now: number): DecisionResult {
  const bad = checkNonce(book, proposal, presentedNonce);
  if (bad) return { ok: false, book, error: bad };
  if (now > proposal.expiresAt) return { ok: false, book: consume(book, proposal, "expired", now), error: "expired" };
  const input = proposal.input;
  const verdict = evaluateProposal(input, accountSnapshot(book, input.src, input.tf, now), book.account.settings, now);
  if (!verdict.approved) return { ok: false, book: consume(book, proposal, "blocked", now), error: "risk", verdict };
  const consumed = consume(book, proposal, "approved", now);
  const seq = consumed.account.seq + 1;
  const position: PaperPosition = {
    id: `pos-${seq}`,
    proposalId: proposal.id,
    configId: input.configId,
    pair: input.pair,
    src: input.src,
    tf: input.tf,
    assetClass: input.assetClass,
    side: input.side,
    size: verdict.size,
    stopDistance: verdict.stopDistance,
    targetDistance: verdict.stopDistance * consumed.account.settings.targetRR,
    plannedRisk: verdict.riskAmount,
    refPrice: input.entryRef,
    signalBarTime: input.barTime,
    intervalMs: input.intervalMs,
    approvedAt: now,
    status: "pending",
    entry: null,
    openedAt: null,
    stop: verdict.stop,
    target: verdict.target,
    entryFee: 0,
    funding: 0,
    mark: input.entryRef,
    markTime: input.barTime,
    lastBarTime: input.barTime,
    closeRequestedAt: null,
  };
  return {
    ok: true,
    verdict,
    position,
    book: { ...consumed, account: { ...consumed.account, seq }, positions: [...consumed.positions, position] },
  };
}

/** Reject: same nonce, single-use. */
export function rejectProposal(book: PaperBook, proposal: Proposal, presentedNonce: string, now: number): DecisionResult {
  const bad = checkNonce(book, proposal, presentedNonce);
  if (bad) return { ok: false, book, error: bad };
  return { ok: true, book: consume(book, proposal, "rejected", now) };
}

/* ------------------------------------------------------------------ *
 *  Manual close, kill switch, settings
 * ------------------------------------------------------------------ */
/**
 * Manual close. An open position exits at the open of the first bar opening at
 * or after `now`; a pending (unfilled) one is cancelled immediately.
 */
export function requestClose(book: PaperBook, positionId: string, now: number): { book: PaperBook; cancelled: boolean; found: boolean } {
  const p = book.positions.find((x) => x.id === positionId);
  if (!p) return { book, cancelled: false, found: false };
  if (p.status === "pending") return { book: { ...book, positions: book.positions.filter((x) => x.id !== positionId) }, cancelled: true, found: true };
  if (p.closeRequestedAt != null) return { book, cancelled: false, found: true };
  return { book: { ...book, positions: book.positions.map((x) => (x.id === positionId ? { ...x, closeRequestedAt: now } : x)) }, cancelled: false, found: true };
}

/** Engage the kill switch: blocks every new approval; closes nothing. */
export function engageKill(book: PaperBook, now: number): PaperBook {
  if (book.account.killSwitch) return book;
  return { ...book, account: { ...book.account, killSwitch: true, killChangedAt: now } };
}

/** Reset needs the typed confirmation word (KILL_RESET_WORD). */
export function resetKill(book: PaperBook, typed: string, now: number): { ok: boolean; book: PaperBook } {
  if (!book.account.killSwitch) return { ok: true, book };
  if (String(typed ?? "").trim() !== KILL_RESET_WORD) return { ok: false, book };
  return { ok: true, book: { ...book, account: { ...book.account, killSwitch: false, killChangedAt: now, lastLockAt: now } } };
}

/** v2.8: a lock that forbids loosening is active now (kill, drawdown, daily or weekly — not the dead-man badge). */
export function lockActive(book: PaperBook, now: number): boolean {
  if (book.account.killSwitch || book.account.drawdownLocked) return true;
  const l = lossLocks(accountSnapshot(book, "", "", now), book.account.settings);
  return l.daily || l.weekly;
}

export function updateSettings(book: PaperBook, next: RiskSettings, now = Date.now()): { ok: boolean; book: PaperBook; invalid: string[] } {
  const invalid = validateSettings(next);
  if (invalid.length) return { ok: false, book, invalid };
  const cur = book.account.settings;
  const loosens = LOOSENING_KEYS.some((k) => next[k] > cur[k]);
  const last = book.account.lastLockAt;
  if (loosens && (lockActive(book, now) || (last != null && utcDayStart(now) <= utcDayStart(last)))) return { ok: false, book, invalid: ["locked"] };
  return { ok: true, invalid, book: { ...book, account: { ...book.account, settings: { ...next } } } };
}

/** Starting equity can only change on an empty book (no positions, no journal). */
export function setStartingEquity(book: PaperBook, equity: number): { ok: boolean; book: PaperBook } {
  if (book.positions.length || book.journal.length || !(equity > 0) || !Number.isFinite(equity) || equity > 1e12) return { ok: false, book };
  return { ok: true, book: { ...book, account: { ...book.account, startingEquity: equity, balance: equity } } };
}

/* ------------------------------------------------------------------ *
 *  Bar processing
 * ------------------------------------------------------------------ */
export interface ProcessResult {
  book: PaperBook;
  filled: PaperPosition[];
  closed: JournalEntry[];
}

/**
 * Feed newly CLOSED bars of one source × timeframe. `barsByPair` maps a pair
 * (e.g. "BTCUSDT") to its closed, time-sorted klines; bars already processed
 * are skipped, so passing the whole window on every scan is fine. Also records
 * the scan heartbeat for the dead-man switch.
 */
export function processBars(
  book: PaperBook,
  src: string,
  tf: string,
  barsByPair: Record<string, Kline[] | undefined>,
  now: number,
  costsOverride?: CostModel,
): ProcessResult {
  const filled: PaperPosition[] = [];
  const closed: JournalEntry[] = [];
  let balance = book.account.balance;
  let seq = book.account.seq;
  const positions: PaperPosition[] = [];
  for (const orig of book.positions) {
    const k = orig.src === src && orig.tf === tf ? barsByPair[orig.pair] : undefined;
    if (!k || !k.length) { positions.push(orig); continue; }
    const costs = costsOverride ?? costsFor(src, orig.assetClass);
    const fee = costs.feeBps / 1e4;
    const slip = costs.slipBps / 1e4;
    let p: PaperPosition = { ...orig };
    const dir = dirOf(p.side);
    const fundingPerBar = (costs.fundingBpsPer8h / 1e4) * (p.intervalMs / 3_600_000 / 8);
    let exit: { px: number; reason: ExitReason; at: number } | null = null;

    for (const bar of k) {
      if (bar.time <= p.lastBarTime) continue;
      if (!(bar.open > 0) || !(bar.high > 0) || !(bar.low > 0) || !(bar.close > 0)) { p.lastBarTime = bar.time; continue; }
      let fillBar = false;
      if (p.status === "pending") {
        // Fill only at the open of a bar that opened at/after approval and after the signal bar.
        if (bar.time < p.approvedAt || bar.time <= p.signalBarTime) { p.lastBarTime = bar.time; continue; }
        const entry = bar.open * (1 + dir * slip);
        p = {
          ...p,
          status: "open",
          entry,
          openedAt: bar.time,
          stop: entry - dir * p.stopDistance,
          target: entry + dir * p.targetDistance,
          entryFee: entry * p.size * fee,
        };
        fillBar = true;
        filled.push(p);
      }
      // Manual close: exit at this bar's open (not on the fill bar itself — that would be a zero-length trade).
      if (!fillBar && p.closeRequestedAt != null && bar.time >= p.closeRequestedAt) {
        exit = { px: bar.open, reason: p.closeReason ?? "manual", at: bar.time };
        p.lastBarTime = bar.time;
        break;
      }
      // Holding this bar: accrue funding (perps; longs pay, shorts receive).
      p.funding += fundingPerBar * (p.entry ?? bar.open) * p.size * dir;
      const barClose = bar.time + p.intervalMs;
      if (dir === 1) {
        if (!fillBar && bar.open <= p.stop) exit = { px: bar.open, reason: "stop", at: barClose };
        else if (bar.low <= p.stop) exit = { px: p.stop, reason: "stop", at: barClose }; // stop first if both touched
        else if (bar.high >= p.target) exit = { px: p.target, reason: "target", at: barClose };
      } else {
        if (!fillBar && bar.open >= p.stop) exit = { px: bar.open, reason: "stop", at: barClose };
        else if (bar.high >= p.stop) exit = { px: p.stop, reason: "stop", at: barClose };
        else if (bar.low <= p.target) exit = { px: p.target, reason: "target", at: barClose };
      }
      p.mark = bar.close;
      p.markTime = bar.time;
      p.lastBarTime = bar.time;
      if (exit) break;
      // v2.8 time stop: after `timeStopBars` bars held, exit at the next open (reason "time").
      const ts = book.account.settings.timeStopBars;
      if (ts > 0 && p.closeRequestedAt == null && p.openedAt != null && (bar.time - p.openedAt) / p.intervalMs + 1 >= ts) {
        p.closeRequestedAt = barClose;
        p.closeReason = "time";
      }
    }

    if (exit && p.entry != null && p.openedAt != null) {
      const exitPx = exit.px * (1 - dir * slip);
      const exitFee = exitPx * p.size * fee;
      const gross = dir * (exitPx - p.entry) * p.size;
      const pnl = gross - p.entryFee - exitFee - p.funding;
      seq += 1;
      const entry: JournalEntry = {
        id: `trade-${seq}`,
        openedAt: p.openedAt,
        closedAt: exit.at,
        pair: p.pair,
        src: p.src,
        tf: p.tf,
        side: p.side,
        size: p.size,
        entry: p.entry,
        exit: exitPx,
        stop: p.stop,
        target: p.target,
        fees: p.entryFee + exitFee,
        funding: p.funding,
        pnl,
        r: p.plannedRisk > 0 ? pnl / p.plannedRisk : 0,
        reason: exit.reason,
        configId: p.configId,
        proposalId: p.proposalId,
        approvedAt: p.approvedAt,
        approvedBy: "owner",
      };
      balance += pnl;
      closed.push(entry);
    } else {
      positions.push(p);
    }
  }

  const anyBars = Object.values(barsByPair).some((k) => k && k.length);
  const heartbeats = anyBars ? { ...book.account.heartbeats, [seriesKey(src, tf)]: now } : book.account.heartbeats;
  const next: PaperBook = { account: { ...book.account, balance, seq, heartbeats }, positions, journal: [...book.journal, ...closed] };
  return { book: applyMarks(applyDrawdown(next, now), now), filled, closed };
}

/** v2.8: start-of-day/week marks (first mark at or after 00:00 UTC / Monday) and the lock memory for the no-loosening rule. */
function applyMarks(book: PaperBook, now: number): PaperBook {
  const a = book.account;
  const equity = bookEquity(book);
  const day = utcDayStart(now);
  const week = utcWeekStart(now);
  const dayMark = a.dayMark?.day === day ? a.dayMark : { day, equity };
  const weekMark = a.weekMark?.week === week ? a.weekMark : { week, equity };
  const next: PaperBook = { ...book, account: { ...a, dayMark, weekMark } };
  return lockActive(next, now) ? { ...next, account: { ...next.account, lastLockAt: now } } : next;
}

/**
 * v2.8 drawdown lock: after every bar batch, with every position at its latest
 * mark, raise the peak or — at peak × (1 − maxDrawdownLockPct) — engage the
 * lock: cancel pending positions and request a close of every open one at the
 * next open of its own series.
 */
function applyDrawdown(book: PaperBook, now: number): PaperBook {
  const a = book.account;
  if (a.drawdownLocked) return book;
  const equity = bookEquity(book);
  if (!(equity > 0) && !(a.peakEquity > 0)) return book;
  if (equity > a.peakEquity) return { ...book, account: { ...a, peakEquity: equity } };
  if (!(a.peakEquity > 0) || equity > a.peakEquity * (1 - a.settings.maxDrawdownLockPct / 100) + 1e-9) return book;
  const positions = book.positions
    .filter((p) => p.status === "open")
    .map((p) => (p.closeRequestedAt != null ? p : { ...p, closeRequestedAt: now, closeReason: "drawdown lock" as const }));
  return { ...book, account: { ...a, drawdownLocked: true }, positions };
}

/** Series (`src|tf`) that still hold a position, sorted — the scans RESET is waiting for. */
export function waitingSeries(book: PaperBook): string[] {
  return [...new Set(book.positions.map((p) => seriesKey(p.src, p.tf)))].sort();
}

/**
 * v2.8: clear the drawdown lock. Needs the typed word (KILL_RESET_WORD) and no
 * open or pending positions; sets the peak to current equity (a fresh 10%) and
 * journals the reset on the account. The realised loss is kept.
 */
export function resetDrawdown(book: PaperBook, typed: string, now: number): { ok: boolean; book: PaperBook; waitingSeries: string[] } {
  const waiting = waitingSeries(book);
  if (!book.account.drawdownLocked) return { ok: true, book, waitingSeries: [] };
  if (String(typed ?? "").trim() !== KILL_RESET_WORD || waiting.length) return { ok: false, book, waitingSeries: waiting };
  const equity = bookEquity(book);
  const a = book.account;
  return {
    ok: true,
    waitingSeries: [],
    book: {
      ...book,
      account: {
        ...a,
        drawdownLocked: false,
        peakEquity: equity,
        lockClearedAt: now,
        lastLockAt: now,
        resets: [...a.resets, { at: now, equity, peakBefore: a.peakEquity }].slice(-100),
      },
    },
  };
}

/* ------------------------------------------------------------------ *
 *  Journal statistics
 * ------------------------------------------------------------------ */
export interface JournalStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  /** Mean R over all trades. */
  avgR: number;
  avgWinR: number;
  avgLossR: number;
  /** winRate × avgWinR + lossRate × avgLossR (equals avgR; reported for the discipline check). */
  expectancyR: number;
  netPnl: number;
  profitFactor: number;
  /** Peak-to-trough fall of the realised equity curve, quote and fraction of the peak. */
  maxDrawdown: number;
  maxDrawdownPct: number;
  curve: { t: number; equity: number }[];
}

const avg = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);

export function equityCurve(journal: JournalEntry[], startingEquity: number, startTime = 0): { t: number; equity: number }[] {
  const sorted = [...journal].sort((a, b) => a.closedAt - b.closedAt || a.id.localeCompare(b.id));
  const out = [{ t: startTime, equity: startingEquity }];
  let eq = startingEquity;
  for (const j of sorted) { eq += j.pnl; out.push({ t: j.closedAt, equity: eq }); }
  return out;
}

export function journalStats(journal: JournalEntry[], startingEquity: number, startTime = 0): JournalStats {
  const rs = journal.map((j) => j.r);
  const winsR = journal.filter((j) => j.pnl > 0).map((j) => j.r);
  const lossR = journal.filter((j) => j.pnl <= 0).map((j) => j.r);
  const n = journal.length;
  const winRate = n ? winsR.length / n : NaN;
  const avgWinR = avg(winsR);
  const avgLossR = avg(lossR);
  const expectancyR = n ? (winsR.length ? winRate * avgWinR : 0) + (lossR.length ? (1 - winRate) * avgLossR : 0) : NaN;
  const grossWin = journal.filter((j) => j.pnl > 0).reduce((a, j) => a + j.pnl, 0);
  const grossLoss = -journal.filter((j) => j.pnl < 0).reduce((a, j) => a + j.pnl, 0);
  const curve = equityCurve(journal, startingEquity, startTime);
  let peak = -Infinity;
  let mdd = 0;
  let mddPct = 0;
  for (const pt of curve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = peak - pt.equity;
    if (dd > mdd) mdd = dd;
    // v2.8: the largest % drawdown is tracked on its own (it need not be the largest amount).
    if (peak > 0 && dd / peak > mddPct) mddPct = dd / peak;
  }
  return {
    trades: n,
    wins: winsR.length,
    losses: lossR.length,
    winRate,
    avgR: avg(rs),
    avgWinR,
    avgLossR,
    expectancyR,
    netPnl: journal.reduce((a, j) => a + j.pnl, 0),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : NaN,
    maxDrawdown: mdd,
    maxDrawdownPct: mddPct,
    curve,
  };
}
