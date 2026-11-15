// Paper-trading regression suite — v2.2 Phase G (PAPER ONLY).
// Run: node scripts/run-engine-tests.mjs paper.test.mjs   (from apps/confluence/web)
//
// Pins: every risk rule, sizing math, next-open fills (no look-ahead), the
// stop-before-target rule, fees/slippage/funding, journal statistics,
// nonce-bound single-use expiring approvals, kill and dead-man switches, and a
// store round-trip through an in-memory port.
import {
  evaluateProposal, DEFAULT_RISK_SETTINGS, validateSettings, normaliseSettings, clusterOf, defaultLotStep, roundToStep,
  isPerpSource, signalAgeBars, lossLocks, TIME_STOP_PRESET_BARS, timeStopToggleBars,
} from "./risk-engine.ts";
import {
  newBook, createProposal, approveProposal, rejectProposal, processBars, requestClose, engageKill, resetKill,
  journalStats, accountSnapshot, isUnmanaged, lockState, bookEquity, updateSettings, setStartingEquity, randomNonce,
  utcWeekStart, utcDayStart, KILL_RESET_WORD,
} from "./paper-broker.ts";
import { createPaperStore, memoryPaperPort, PAPER_JOURNAL_COLUMNS, journalRowValues } from "./paper-store.ts";
import { DEFAULT_COSTS } from "./ledger-metrics.ts";
import { atr } from "./indicators.ts";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log("  ok   - " + name); }
  else { failed++; console.log("  FAIL - " + name + (extra ? "  [" + extra + "]" : "")); }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
const H = 3600e3;
const I = 4 * H;
const T0 = Date.UTC(2026, 9, 26, 0); // Monday 26 Oct 2026 00:00 UTC
const S = DEFAULT_RISK_SETTINGS;
const lossLocksOf = (a) => lossLocks(a, S);

/** A proposal input for a fresh strong BUY on bar T0 (closes at T0 + I). */
const input = (over = {}) => ({
  pair: "SOLUSDT", src: "binance", tf: "4h", assetClass: "crypto", side: "long",
  entryRef: 100, atr: 2, score: 72, strength: "STRONG", master: "BULLISH", suppressed: false,
  underlyingClosed: false, configId: "cfgtest000000001", barTime: T0, intervalMs: I, ...over,
});
const acct = (over = {}) => ({ equity: 10_000, positions: [], realisedToday: 0, realisedWeek: 0, killSwitch: false, lastHeartbeat: T0 + I, ...over });
const NOW = T0 + I + 10 * 60e3; // 10 min after the signal bar closed
const pos = (over = {}) => ({ pair: "XRPUSDT", src: "binance", assetClass: "crypto", side: "long", riskAmount: 50, notional: 1000, ...over });
const bar = (time, open, high, low, close) => ({ time, open, high, low, close, volume: 1 });

/* ------------------------------------------------------------------ */
console.log("Risk engine — sizing");
{
  const v = evaluateProposal(input(), acct(), S, NOW);
  ok("clean proposal is approved", v.approved && v.reasons.length === 0, v.reasons.join(","));
  ok("stop = ref − 2×ATR", v.stop === 96 && v.stopDistance === 4);
  ok("target = ref + RR × stop distance", v.target === 108);
  // 0.5 % of 10 000 = 50 risk; 50 / 4 = 12.5 units; lot step for 100 is 0.01.
  ok("size = risk budget ÷ stop distance", v.size === 12.5, String(v.size));
  ok("risk amount = size × stop distance", v.riskAmount === 50);
  ok("lot step from price (100 → 0.01)", v.lotStep === 0.01);
  ok("short: stop above, target below", (() => { const s = evaluateProposal(input({ side: "short", master: "BEARISH", score: -72, src: "bybit-perp" }), acct(), S, NOW); return s.stop === 104 && s.target === 92 && s.approved; })());
  ok("defaultLotStep BTC 100k → 1e-5", defaultLotStep(100_000) === 1e-5);
  ok("defaultLotStep 3000 → 1e-4", defaultLotStep(3000) === 1e-4);
  ok("defaultLotStep 0.5 → 1 (capped)", defaultLotStep(0.5) === 1);
  ok("roundToStep rounds DOWN", roundToStep(12.3456, 0.01) === 12.34 && roundToStep(0.3, 0.1) === 0.3);
  ok("roundToStep never exceeds budget", roundToStep(0.999999, 0.001) === 0.999);
  const btc = evaluateProposal(input({ pair: "BTCUSDT", entryRef: 100_000, atr: 1500 }), acct(), S, NOW);
  ok("BTC sizing rounds to 0.00001 and stays ≤ budget", btc.size === 0.01666 && btc.riskAmount <= 50, `${btc.size} ${btc.riskAmount}`);
  // Leverage cap: tiny ATR would need 50 000 notional; capped at 1× equity.
  const capped = evaluateProposal(input({ atr: 0.05 }), acct(), S, NOW);
  ok("size capped to maxLeverage × equity", capped.capped && capped.notional <= 10_000 + 1e-9 && capped.approved, `${capped.notional}`);
  const full = evaluateProposal(input(), acct({ positions: [pos({ notional: 10_000, riskAmount: 10 })] }), S, NOW);
  ok("no notional room → rejected (paper.rule.notional)", full.reasons.includes("paper.rule.notional"));
  ok("custom lot step respected", evaluateProposal(input({ lotStep: 1 }), acct(), S, NOW).size === 12);
}

console.log("Risk engine — every rule");
{
  const has = (v, key) => v.reasons.includes(key);
  const ev = (i = {}, a = {}, s = {}, now = NOW) => evaluateProposal(input(i), acct(a), { ...S, ...s }, now);
  ok("kill switch", has(ev({}, { killSwitch: true }), "paper.rule.killSwitch"));
  ok("daily loss lock at 2 % of start-of-day balance", has(ev({}, { equity: 9_800, realisedToday: -200, realisedWeek: -200 }), "paper.rule.dailyLock"));
  ok("daily lock not tripped at 1.9 %", !has(ev({}, { equity: 9_810, realisedToday: -190, realisedWeek: -190 }), "paper.rule.dailyLock"));
  ok("weekly loss lock at 5 %", has(ev({}, { equity: 9_500, realisedToday: 0, realisedWeek: -500 }), "paper.rule.weeklyLock"));
  ok("weekly lock not tripped at 4.9 %", !has(ev({}, { equity: 9_510, realisedWeek: -490 }), "paper.rule.weeklyLock"));
  ok("max positions", has(ev({}, { positions: Array.from({ length: 5 }, (_, i) => pos({ pair: `X${i}USDT`, assetClass: ["rwa", "stock", "fx", "commodity", "crypto"][i], riskAmount: 1, notional: 1 })) }), "paper.rule.maxPositions"));
  ok("open-risk cap (2 %)", has(ev({}, { positions: [pos({ riskAmount: 160, notional: 1, assetClass: "stock", pair: "AAPLUSDT" })] }), "paper.rule.openRisk"));
  ok("open-risk exactly at cap passes", !has(ev({}, { positions: [pos({ riskAmount: 150, notional: 1, assetClass: "stock", pair: "AAPLUSDT" })] }), "paper.rule.openRisk"));
  ok("cluster cap: two alts block a third alt", has(ev({}, { positions: [pos({ pair: "XRPUSDT" }), pos({ pair: "ADAUSDT" })] }), "paper.rule.cluster"));
  ok("cluster: majors are a separate cluster from alts", !has(ev({}, { positions: [pos({ pair: "BTCUSDT" }), pos({ pair: "ETHUSDT" })] }), "paper.rule.cluster"));
  ok("clusterOf splits crypto majors vs alts", clusterOf("crypto", "BTCUSDT") === "crypto-major" && clusterOf("crypto", "SOLUSDT") === "crypto-alt" && clusterOf("fx", "EURUSDT") === "fx");
  ok("duplicate position on the same pair", has(ev({}, { positions: [pos({ pair: "SOLUSDT" })] }), "paper.rule.duplicate"));
  ok("spot short disallowed by default", has(ev({ side: "short", master: "BEARISH", score: -72 }), "paper.rule.spotShort"));
  ok("spot short allowed when enabled", !has(ev({ side: "short", master: "BEARISH", score: -72 }, {}, { allowShortsOnSpot: true }), "paper.rule.spotShort"));
  ok("perp short allowed", !has(ev({ side: "short", master: "BEARISH", score: -72, src: "bybit-perp" }), "paper.rule.spotShort") && isPerpSource("bybit-perp") && !isPerpSource("binance"));
  ok("stale signal (> 1 bar after close)", has(ev({}, { lastHeartbeat: T0 + 3 * I }, {}, T0 + 2 * I + 1), "paper.rule.stale"));
  ok("signal exactly 1 bar old is fresh", !has(ev({}, { lastHeartbeat: T0 + 2 * I }, {}, T0 + 2 * I), "paper.rule.stale") && signalAgeBars(T0, I, T0 + 2 * I) === 1);
  ok("stale rule off when requireFreshSignal = false", !has(ev({}, { lastHeartbeat: T0 + 5 * I }, { requireFreshSignal: false }, T0 + 5 * I), "paper.rule.stale"));
  ok("score below threshold", has(ev({ score: 54 }), "paper.rule.score"));
  ok("score at threshold passes", !has(ev({ score: 55 }), "paper.rule.score"));
  ok("NEUTRAL rejected", has(ev({ master: "NEUTRAL", score: 60 }), "paper.rule.neutral"));
  ok("suppressed rejected", has(ev({ suppressed: true }), "paper.rule.suppressed"));
  ok("side must match the master direction", has(ev({ side: "short", src: "bybit-perp" }), "paper.rule.sideMismatch"));
  ok("underlying-closed stock bar rejected", has(ev({ assetClass: "stock", pair: "AAPLUSDT", underlyingClosed: true }), "paper.rule.underlyingClosed"));
  ok("underlying-closed FX bar rejected", has(ev({ assetClass: "fx", pair: "EURUSDT", underlyingClosed: true }), "paper.rule.underlyingClosed"));
  ok("invalid ATR rejected", has(ev({ atr: NaN }), "paper.rule.invalidInput") && has(ev({ atr: 0 }), "paper.rule.invalidInput"));
  ok("invalid price rejected", has(ev({ entryRef: -1 }), "paper.rule.invalidInput") && has(ev({ entryRef: Infinity }), "paper.rule.invalidInput"));
  ok("stop at/below zero is invalid", has(ev({ atr: 60 }), "paper.rule.invalidInput"));
  ok("dead-man: no heartbeat for > 3 bars", has(ev({}, { lastHeartbeat: NOW - 3 * I - 1 }), "paper.rule.deadMan"));
  ok("dead-man: never seen a heartbeat", has(ev({}, { lastHeartbeat: 0 }), "paper.rule.deadMan"));
  ok("dead-man: heartbeat 3 bars ago is fine", !has(ev({}, { lastHeartbeat: NOW - 3 * I }), "paper.rule.deadMan"));
  const many = ev({ master: "NEUTRAL", score: 10, atr: NaN }, { killSwitch: true });
  ok("every failed rule is listed (not just the first)", many.reasons.length >= 4 && !many.approved, many.reasons.join(","));
  ok("deterministic: same input → same verdict", JSON.stringify(ev()) === JSON.stringify(ev()));
}

console.log("Settings");
{
  ok("defaults are valid", validateSettings(S).length === 0);
  ok("out-of-range value flagged", validateSettings({ ...S, riskPerTradePct: 9 }).includes("riskPerTradePct"));
  ok("non-integer position count flagged", validateSettings({ ...S, maxPositions: 2.5 }).includes("maxPositions"));
  ok("normalise drops invalid values to defaults", normaliseSettings({ riskPerTradePct: -1, targetRR: 3 }).riskPerTradePct === 0.5 && normaliseSettings({ targetRR: 3 }).targetRR === 3);
  const b = newBook(T0);
  ok("updateSettings refuses invalid", !updateSettings(b, { ...S, stopAtrMult: 0 }).ok);
  ok("updateSettings accepts valid", updateSettings(b, { ...S, stopAtrMult: 3 }).book.account.settings.stopAtrMult === 3);
  ok("starting equity editable on an empty book only", setStartingEquity(b, 5000).book.account.balance === 5000);
}

/* ------------------------------------------------------------------ */
/** Book with a heartbeat for binance|4h so the dead-man rule is satisfied. */
const liveBook = (now = NOW) => ({ ...newBook(T0), account: { ...newBook(T0).account, heartbeats: { "binance|4h": now } } });

console.log("Proposals — nonce-bound, single-use, expiring");
{
  const b = liveBook();
  const p = createProposal(b, input(), NOW, "n1");
  ok("proposal carries nonce and expiry at the next bar close", p && p.nonce === "n1" && p.expiresAt === T0 + 2 * I);
  ok("proposal verdict computed at creation", p.verdict.approved);
  ok("wrong nonce refused", approveProposal(b, p, "nX", NOW).error === "nonce");
  ok("empty nonce refused", approveProposal(b, p, "", NOW).error === "nonce");
  const a = approveProposal(b, p, "n1", NOW + 1000);
  ok("matching nonce approves", a.ok && a.book.positions.length === 1 && a.position.status === "pending");
  ok("position records approver-independent ids", a.position.proposalId === p.id && a.position.configId === "cfgtest000000001");
  ok("nonce is single-use", approveProposal(a.book, p, "n1", NOW + 2000).error === "used");
  ok("decided proposal is not proposed again", createProposal(a.book, input(), NOW + 3000, "n2") === null);
  const late = approveProposal(b, p, "n1", T0 + 2 * I + 1);
  ok("expired proposal refused", late.error === "expired" && late.book.account.usedNonces.includes("n1"));
  ok("no proposal after expiry", createProposal(b, input(), T0 + 2 * I + 1, "n3") === null);
  // Re-run at approval: the account changed (kill switch) after the proposal was made.
  const killed = engageKill(b, NOW);
  const r = approveProposal(killed, p, "n1", NOW + 1000);
  ok("risk engine re-runs at approval time", r.error === "risk" && r.verdict.reasons.includes("paper.rule.killSwitch") && r.book.positions.length === 0);
  ok("blocked approval consumes the nonce", r.book.account.usedNonces.includes("n1"));
  const rj = rejectProposal(b, p, "n1", NOW);
  ok("reject consumes the nonce", rj.ok && approveProposal(rj.book, p, "n1", NOW).error === "used");
  ok("reject needs the nonce too", rejectProposal(b, p, "bad", NOW).error === "nonce");
  ok("randomNonce: 32 hex chars, unique", /^[0-9a-f]{32}$/.test(randomNonce()) && randomNonce() !== randomNonce());
}

console.log("Broker — next-open fill, no look-ahead");
{
  const b0 = liveBook();
  const p = createProposal(b0, input(), NOW, "n1");
  const approvedAt = NOW; // during bar T0+I (opened at T0+I, before approval)
  const b1 = approveProposal(b0, p, "n1", approvedAt).book;
  const costs = { feeBps: 10, slipBps: 5, fundingBpsPer8h: 0 };
  // Signal bar (T0) and the bar already open at approval (T0+I) must not fill.
  const k1 = [bar(T0, 99, 101, 98, 100), bar(T0 + I, 100.5, 101, 100, 100.8)];
  const r1 = processBars(b1, "binance", "4h", { SOLUSDT: k1 }, T0 + 2 * I, costs);
  ok("no fill at the signal bar close nor at a bar that opened before approval", r1.book.positions[0].status === "pending" && r1.filled.length === 0);
  const k2 = [...k1, bar(T0 + 2 * I, 101, 102, 100.5, 101.5)];
  const r2 = processBars(r1.book, "binance", "4h", { SOLUSDT: k2 }, T0 + 3 * I, costs);
  const q = r2.book.positions[0];
  ok("fills at the open of the first bar opening after approval", q.status === "open" && q.openedAt === T0 + 2 * I);
  ok("entry includes slippage against the position", near(q.entry, 101 * 1.0005), String(q.entry));
  ok("stop/target re-anchored to the fill (same distances)", near(q.stop, q.entry - 4) && near(q.target, q.entry + 8));
  ok("entry fee charged on notional", near(q.entryFee, q.entry * q.size * 0.001) && q.size === 11.62);
  ok("mark-to-market at the bar close", q.mark === 101.5 && near(bookEquity(r2.book), 10_000 + (101.5 - q.entry) * q.size - q.entryFee));
  ok("reprocessing the same bars is idempotent", JSON.stringify(processBars(r2.book, "binance", "4h", { SOLUSDT: k2 }, T0 + 3 * I, costs).book.positions) === JSON.stringify(r2.book.positions));
  ok("other source/timeframe bars are ignored", processBars(b1, "binance", "1h", { SOLUSDT: k2 }, T0 + 3 * I, costs).book.positions[0].status === "pending");
  ok("heartbeat recorded for the processed series", r2.book.account.heartbeats["binance|4h"] === T0 + 3 * I);
  // A position approved right at a bar boundary fills at that bar's open.
  const bEdge = approveProposal(b0, p, "n1", T0 + I).book;
  const rEdge = processBars(bEdge, "binance", "4h", { SOLUSDT: k2 }, T0 + 3 * I, costs);
  ok("approval at a bar open fills at that bar's open (still after the signal bar)", rEdge.book.positions[0].openedAt === T0 + I);
}

console.log("Broker — exits");
{
  const costs = { feeBps: 10, slipBps: 5, fundingBpsPer8h: 0 };
  const open = () => {
    const b0 = liveBook();
    const p = createProposal(b0, input(), NOW, "n1");
    const b1 = approveProposal(b0, p, "n1", NOW).book;
    return processBars(b1, "binance", "4h", { SOLUSDT: [bar(T0 + 2 * I, 100, 100.5, 99.5, 100)] }, T0 + 3 * I, costs).book;
  };
  const b = open();
  const e = b.positions[0].entry; // 100.05
  // Bar touching both stop and target → stop first.
  const both = processBars(b, "binance", "4h", { SOLUSDT: [bar(T0 + 3 * I, 100, e + 9, e - 5, 101)] }, T0 + 4 * I, costs);
  ok("bar touching stop and target → stop assumed first", both.closed.length === 1 && both.closed[0].reason === "stop");
  const j = both.closed[0];
  ok("stop exit at stop with slippage", near(j.exit, (e - 4) * (1 - 0.0005)));
  ok("fees = entry + exit taker fees", near(j.fees, e * j.size * 0.001 + j.exit * j.size * 0.001));
  ok("pnl = gross − fees − funding", near(j.pnl, (j.exit - e) * j.size - j.fees));
  // v2.8: the round-trip cost is inside the 1 R budget, so a clean stop-out is ≈ −1 R (was −1.06 R).
  ok("R multiple = pnl ÷ planned risk (≈ −1R, costs inside the budget)", near(j.r, j.pnl / b.positions[0].plannedRisk) && j.r <= -0.95 && j.r >= -1, String(j.r));
  ok("journal entry is approvedBy owner with ids", j.approvedBy === "owner" && j.proposalId && j.configId === "cfgtest000000001");
  ok("balance updated by realised pnl", near(both.book.account.balance, 10_000 + j.pnl) && both.book.positions.length === 0);
  ok("closedAt = close of the exit bar", j.closedAt === T0 + 4 * I);
  const tgt = processBars(b, "binance", "4h", { SOLUSDT: [bar(T0 + 3 * I, 100.2, e + 8.5, 100, 107)] }, T0 + 4 * I, costs);
  ok("target-only bar exits at target", tgt.closed[0].reason === "target" && near(tgt.closed[0].exit, (e + 8) * (1 - 0.0005)));
  ok("target trade ≈ +2R minus costs", tgt.closed[0].r > 1.7 && tgt.closed[0].r < 1.9, String(tgt.closed[0].r));
  const gap = processBars(b, "binance", "4h", { SOLUSDT: [bar(T0 + 3 * I, 90, 91, 89, 90.5)] }, T0 + 4 * I, costs);
  ok("gap through the stop exits at the open (worse than stop)", gap.closed[0].reason === "stop" && near(gap.closed[0].exit, 90 * (1 - 0.0005)));
  const hold = processBars(b, "binance", "4h", { SOLUSDT: [bar(T0 + 3 * I, 100, 101, 99, 100.7)] }, T0 + 4 * I, costs);
  ok("inside bar keeps the position open and marks it", hold.closed.length === 0 && hold.book.positions[0].mark === 100.7);
  // Manual close at next bar open.
  const req = requestClose(b, b.positions[0].id, T0 + 3 * I + 60e3);
  ok("manual close is a request, not an instant fill", req.book.positions[0].closeRequestedAt === T0 + 3 * I + 60e3 && req.book.journal.length === 0);
  const m = processBars(req.book, "binance", "4h", { SOLUSDT: [bar(T0 + 3 * I, 100, 101, 99, 100.5), bar(T0 + 4 * I, 100.9, 102, 100, 101)] }, T0 + 5 * I, costs);
  ok("manual close fills at the next bar's open", m.closed[0].reason === "manual" && near(m.closed[0].exit, 100.9 * (1 - 0.0005)) && m.closed[0].closedAt === T0 + 4 * I);
  // Pending close = cancel.
  const b0 = liveBook();
  const p = createProposal(b0, input(), NOW, "n1");
  const pend = approveProposal(b0, p, "n1", NOW).book;
  const c = requestClose(pend, pend.positions[0].id, NOW + 1);
  ok("closing a pending position cancels it (no journal entry)", c.cancelled && c.book.positions.length === 0 && c.book.journal.length === 0);
  // Short side.
  const sb0 = liveBook();
  const sp = createProposal(sb0, input({ side: "short", master: "BEARISH", score: -80, src: "bybit-perp" }), NOW, "s1");
  const sb1 = approveProposal({ ...sb0, account: { ...sb0.account, heartbeats: { "bybit-perp|4h": NOW } } }, sp, "s1", NOW).book;
  const sOpen = processBars(sb1, "bybit-perp", "4h", { SOLUSDT: [bar(T0 + 2 * I, 100, 100.5, 99.5, 100)] }, T0 + 3 * I, DEFAULT_COSTS["bybit-perp"]).book;
  const se = sOpen.positions[0].entry;
  ok("short entry slips down", near(se, 100 * (1 - 0.0005)));
  const sBoth = processBars(sOpen, "bybit-perp", "4h", { SOLUSDT: [bar(T0 + 3 * I, 100, se + 5, se - 9, 99)] }, T0 + 4 * I, DEFAULT_COSTS["bybit-perp"]);
  ok("short: both touched → stop first", sBoth.closed[0].reason === "stop" && near(sBoth.closed[0].exit, (se + 4) * 1.0005));
}

console.log("Broker — funding on perpetuals");
{
  const costs = DEFAULT_COSTS["bybit-perp"]; // 5.5 bp fee, 5 bp slip, 1 bp / 8 h
  const mk = (side) => {
    const b0 = { ...newBook(T0), account: { ...newBook(T0).account, heartbeats: { "bybit-perp|4h": NOW } } };
    const p = createProposal(b0, input({ src: "bybit-perp", side, master: side === "long" ? "BULLISH" : "BEARISH", score: side === "long" ? 72 : -72 }), NOW, "f");
    const b1 = approveProposal(b0, p, "f", NOW).book;
    const bars = [bar(T0 + 2 * I, 100, 100.4, 99.6, 100), bar(T0 + 3 * I, 100, 100.4, 99.6, 100), bar(T0 + 4 * I, 100, 100.4, 99.6, 100)];
    return processBars(b1, "bybit-perp", "4h", { SOLUSDT: bars }, T0 + 5 * I, costs).book.positions[0];
  };
  const L = mk("long");
  const Sh = mk("short");
  // 3 bars × 4 h = 12 h = 1.5 funding periods × 1 bp × notional.
  ok("long pays funding pro rata per 8 h", near(L.funding, 1.5 * 1e-4 * L.entry * L.size), String(L.funding));
  ok("short receives funding", near(Sh.funding, -1.5 * 1e-4 * Sh.entry * Sh.size));
  ok("perp fee 5.5 bp", near(L.entryFee, L.entry * L.size * 0.00055));
  const spotCosts = DEFAULT_COSTS.binance;
  ok("spot has no funding", spotCosts.fundingBpsPer8h === 0);
}

console.log("Journal statistics");
{
  const J = (pnl, r, t) => ({ id: `t${t}`, openedAt: t - 1, closedAt: t, pair: "X", src: "binance", tf: "4h", side: "long", size: 1, entry: 1, exit: 1, stop: 0.9, target: 1.2, fees: 0, funding: 0, pnl, r, reason: "stop", configId: "c", proposalId: "p", approvedAt: t - 2, approvedBy: "owner" });
  const journal = [J(100, 2, 1), J(-50, -1, 2), J(-50, -1, 3), J(100, 2, 4), J(-50, -1, 5)];
  const s = journalStats(journal, 10_000);
  ok("trade count", s.trades === 5 && s.wins === 2 && s.losses === 3);
  ok("win rate", near(s.winRate, 0.4));
  ok("avg R", near(s.avgR, 0.2));
  ok("expectancy R = win% × avg win R + loss% × avg loss R", near(s.expectancyR, 0.4 * 2 + 0.6 * -1) && near(s.expectancyR, s.avgR));
  ok("net pnl", s.netPnl === 50);
  ok("profit factor", near(s.profitFactor, 200 / 150));
  ok("max drawdown (10 100 → 10 000)", s.maxDrawdown === 100 && near(s.maxDrawdownPct, 100 / 10_100));
  ok("equity curve starts at starting equity", s.curve[0].equity === 10_000 && s.curve.at(-1).equity === 10_050);
  const e = journalStats([], 10_000);
  ok("empty journal: zero trades, NaN rates, no drawdown", e.trades === 0 && Number.isNaN(e.winRate) && e.maxDrawdown === 0);
  ok("CSV columns match row values", journalRowValues(journal[0]).length === PAPER_JOURNAL_COLUMNS.length);
}

console.log("Kill switch and dead-man switch");
{
  const b = liveBook();
  const k = engageKill(b, NOW);
  ok("kill switch engaged", k.account.killSwitch && lockState(k, "binance", "4h", I, NOW).kill);
  ok("kill switch closes nothing", (() => {
    const p = createProposal(b, input(), NOW, "z");
    const withPos = approveProposal(b, p, "z", NOW).book;
    return engageKill(withPos, NOW).positions.length === 1;
  })());
  ok("kill switch blocks new approvals", (() => { const p = createProposal(k, input(), NOW, "k1"); return approveProposal(k, p, "k1", NOW).error === "risk"; })());
  ok("reset needs the typed word", !resetKill(k, "reset please", NOW).ok && resetKill(k, "  " + KILL_RESET_WORD + " ", NOW).ok);
  ok("reset clears the switch", !resetKill(k, KILL_RESET_WORD, NOW).book.account.killSwitch);
  // Dead-man: heartbeat older than 3 bars.
  const stale = { ...b, account: { ...b.account, heartbeats: { "binance|4h": NOW - 3 * I - 1 } } };
  ok("dead-man flag in lock state", lockState(stale, "binance", "4h", I, NOW).deadMan && !lockState(b, "binance", "4h", I, NOW).deadMan);
  const p = createProposal(b, input(), NOW, "d1");
  const withPos = approveProposal(b, p, "d1", NOW).book;
  const later = NOW + 3 * I + 1;
  ok("positions flagged unmanaged after > 3 bars without a scan", isUnmanaged(withPos, withPos.positions[0], later) && !isUnmanaged(withPos, withPos.positions[0], NOW));
  ok("dead-man blocks approvals", (() => { const pr = createProposal(stale, input(), NOW, "d2"); return pr.verdict.reasons.includes("paper.rule.deadMan"); })());
  ok("a scan (processBars) re-arms the heartbeat", !lockState(processBars(stale, "binance", "4h", { SOLUSDT: [bar(T0, 1, 1, 1, 1)] }, NOW).book, "binance", "4h", I, NOW).deadMan);
  // Daily lock from the journal.
  const lost = { ...b, account: { ...b.account, balance: 9_790 }, journal: [{ id: "t1", openedAt: NOW - 2 * H, closedAt: NOW - H, pnl: -210, r: -1, src: "binance", tf: "4h" }] };
  ok("daily lock from today's realised loss", lockState(lost, "binance", "4h", I, NOW).daily && accountSnapshot(lost, "binance", "4h", NOW).realisedToday === -210);
  ok("UTC week starts Monday", utcWeekStart(Date.UTC(2026, 10, 1, 12)) === Date.UTC(2026, 9, 26) && utcDayStart(Date.UTC(2026, 9, 27, 13)) === Date.UTC(2026, 9, 27));
}

console.log("Store round-trip (in-memory port)");
{
  const port = memoryPaperPort();
  const store = createPaperStore(Promise.resolve(port));
  const fresh = await store.load(T0);
  ok("empty store loads a fresh book", fresh.account.balance === 10_000 && fresh.positions.length === 0 && fresh.journal.length === 0);
  const b0 = liveBook();
  const p = createProposal(b0, input(), NOW, "n1");
  let b = approveProposal(b0, p, "n1", NOW).book;
  b = processBars(b, "binance", "4h", { SOLUSDT: [bar(T0 + 2 * I, 100, 100.5, 99.5, 100)] }, T0 + 3 * I).book;
  b = engageKill(b, NOW);
  // Overlapping saves are serialised.
  await Promise.all([store.save(b), store.save(b)]);
  const back = await store.load();
  ok("account round-trips", back.account.killSwitch && back.account.usedNonces.includes("n1") && back.account.heartbeats["binance|4h"] === T0 + 3 * I);
  ok("positions round-trip", back.positions.length === 1 && JSON.stringify(back.positions[0]) === JSON.stringify(b.positions[0]));
  const closed = processBars(back, "binance", "4h", { SOLUSDT: [bar(T0 + 3 * I, 90, 91, 89, 90)] }, T0 + 4 * I).book;
  await store.save(closed);
  const back2 = await store.load();
  ok("closed position removed from paper_positions", back2.positions.length === 0 && (await port.list("paper_positions")).length === 0);
  ok("journal persisted", back2.journal.length === 1 && back2.journal[0].reason === "stop");
  ok("balance persisted", near(back2.account.balance, closed.account.balance));
  ok("settings normalised on load", JSON.stringify(back2.account.settings) === JSON.stringify(S));
  await store.clear();
  ok("clear empties every collection", (await store.load()).journal.length === 0 && (await port.list("paper_state")).length === 0);
  ok("save is a snapshot (later mutation does not leak)", await (async () => {
    const bb = newBook(T0); const pr = store.save(bb); bb.account.balance = 1; await pr; return (await store.load()).account.balance === 10_000;
  })());
}

console.log("Boundary — paper only");
{
  const here = dirname(fileURLToPath(import.meta.url));
  const files = ["risk-engine.ts", "paper-broker.ts", "paper-store.ts"];
  const src = files.map((f) => readFileSync(join(here, f), "utf8")).join("\n");
  ok("no network primitives in the paper modules", !/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/.test(src));
  ok("no exchange/order modules imported", !/from\s+"\.\/(market-client|private-api)/.test(src));
  ok("no order/API-key vocabulary in code paths", !/(apiKey|api_key|secretKey|placeOrder|createOrder|\/order\b)/i.test(src));
  ok("atr export usable for proposals", Number.isFinite(atr(Array.from({ length: 30 }, (_, i) => bar(i, 100 + i, 101 + i, 99 + i, 100.5 + i))).at(-1)));
  ok("suite sits next to the lib it tests", readdirSync(here).includes("paper-broker.ts"));
}

{
  // v2.3 review S14: paper costs follow the ledger, including the per-class slippage extra.
  const { costsFor: paperCosts } = await import("./paper-broker.ts");
  ok("paper stock costs include the class slippage extra", paperCosts("bybit-perp", "stock").slipBps > paperCosts("bybit-perp", "crypto").slipBps);
}


{
  const { queueReplayTrade, advanceReplayTrade } = await import("./replay-paper.ts");
  const instrument = { pair: "BTCUSDT", src: "binance", tf: "1h", intervalMs: 3600000, assetClass: "crypto" };
  const bar = { time: 3600000, open: 100, high: 100, low: 100, close: 100, volume: 1 };
  const queued = queueReplayTrade(newBook(bar.time), instrument, bar, "long", 1, 1, 2);
  ok("replay queues a next-open paper fill", queued?.positions[0].status === "pending");
  const next = { ...bar, time: 7200000, high: 105, low: 95 };
  const replayed = advanceReplayTrade(queued, instrument, next);
  ok("replay flags ambiguous candles and keeps the broker stop-first convention",
    replayed.ambiguous && replayed.book.journal[0].reason === "stop");
  ok("same replay bar produces deterministic paper results",
    JSON.stringify(replayed) === JSON.stringify(advanceReplayTrade(queued, instrument, next)));
}

console.log("v2.8 WP19 — drawdown lock (10%) and RESET");
{
  const { resetDrawdown, PAPER_SCHEMA } = await import("./paper-broker.ts");
  const zero = { feeBps: 0, slipBps: 0, fundingBpsPer8h: 0 };
  ok("drawdown lock default 10", DEFAULT_RISK_SETTINGS.maxDrawdownLockPct === 10);
  ok("drawdown lock range 1–50", validateSettings({ ...S, maxDrawdownLockPct: 0.5 }).includes("maxDrawdownLockPct")
    && validateSettings({ ...S, maxDrawdownLockPct: 51 }).includes("maxDrawdownLockPct")
    && validateSettings({ ...S, maxDrawdownLockPct: 10 }).length === 0);
  ok("paper schema is 2", PAPER_SCHEMA === 2 && newBook(T0).account.schema === 2);
  ok("new book starts with peak = starting equity, unlocked", newBook(T0).account.peakEquity === 10_000 && newBook(T0).account.drawdownLocked === false);
  const has = (v, key) => v.reasons.includes(key);
  ok("equity ≤ peak × 0.9 blocks new trades", has(evaluateProposal(input(), acct({ equity: 10_000, peakEquity: 11_200 }), S, NOW), "paper.rule.drawdownLock"));
  ok("equity above the floor passes", !has(evaluateProposal(input(), acct({ equity: 10_100, peakEquity: 11_200 }), S, NOW), "paper.rule.drawdownLock"));
  ok("an active lock blocks even after equity recovers", has(evaluateProposal(input(), acct({ equity: 12_000, peakEquity: 12_000, drawdownLocked: true }), S, NOW), "paper.rule.drawdownLock"));

  // Book: one open SOL long on binance|4h (enlarged to 300 units, far stop), one open ETH long on
  // bybit-spot|4h, one pending XRP on binance|4h.
  const b0 = liveBook();
  const pr = createProposal(b0, input(), NOW, "dd1");
  const b1 = approveProposal(b0, pr, "dd1", NOW).book;
  let b = processBars(b1, "binance", "4h", { SOLUSDT: [bar(T0 + 2 * I, 100, 100.5, 99.5, 100)] }, T0 + 3 * I, zero).book;
  const sol = { ...b.positions[0], size: 300, stop: 1, stopDistance: 99, plannedRisk: 300 * 99, target: 1000, targetDistance: 900 };
  const eth = { ...sol, id: "pos-eth", proposalId: "eth", pair: "ETHUSDT", src: "bybit-spot", size: 0.1, entry: 3000, mark: 3000, stop: 1, target: 9000, plannedRisk: 299.9, refPrice: 3000 };
  const xrp = { ...sol, id: "pos-xrp", proposalId: "xrp", pair: "XRPUSDT", status: "pending", entry: null, openedAt: null, size: 10, plannedRisk: 1 };
  b = { ...b, positions: [sol, eth, xrp] };
  const up = processBars(b, "binance", "4h", { SOLUSDT: [bar(T0 + 3 * I, 100, 101.2, 99.8, 101)] }, T0 + 4 * I, zero).book;
  ok("peak tracks highest marked equity incl. open P&L", near(up.account.peakEquity, 10_000 + 300 * 1) && !up.account.drawdownLocked, String(up.account.peakEquity));
  const LOCK_AT = T0 + 5 * I;
  const down = processBars(up, "binance", "4h", { SOLUSDT: [bar(T0 + 4 * I, 101, 101, 96.2, 96.5)] }, LOCK_AT, zero).book;
  ok("drop to ≤ 90% of peak engages the lock", down.account.drawdownLocked === true);
  ok("pending positions are cancelled", !down.positions.some((x) => x.status === "pending"));
  ok("every open position gets a close request", down.positions.length === 2 && down.positions.every((x) => x.closeRequestedAt === LOCK_AT && x.closeReason === "drawdown lock"));
  ok("lockState reports the drawdown", lockState(down, "binance", "4h", I, LOCK_AT).drawdown === true && lockState(down, "binance", "4h", I, LOCK_AT).drawdownPct > 0.1);
  const r1 = resetDrawdown(down, "RESET", LOCK_AT + 1);
  ok("RESET refused while closes are pending, naming the series", !r1.ok && r1.waitingSeries.join(",") === "binance|4h,bybit-spot|4h", r1.waitingSeries.join(","));
  const c1 = processBars(down, "binance", "4h", { SOLUSDT: [bar(T0 + 5 * I, 96, 97, 95.5, 96.4)] }, T0 + 6 * I, zero);
  ok("scanned series closes at its next open with reason 'drawdown lock'", c1.closed.length === 1 && c1.closed[0].reason === "drawdown lock" && near(c1.closed[0].exit, 96));
  ok("lock stays engaged after the closes", c1.book.account.drawdownLocked === true);
  const r2 = resetDrawdown(c1.book, "RESET", T0 + 6 * I);
  ok("lock closes unscanned series later and RESET waits", !r2.ok && r2.waitingSeries.join(",") === "bybit-spot|4h");
  const c2 = processBars(c1.book, "bybit-spot", "4h", { ETHUSDT: [bar(T0 + 6 * I, 2990, 3000, 2980, 2995)] }, T0 + 7 * I, zero);
  ok("unscanned series closes on its own next scan", c2.closed.length === 1 && c2.closed[0].reason === "drawdown lock" && c2.book.positions.length === 0);
  ok("wrong word refused", !resetDrawdown(c2.book, "reset", T0 + 7 * I).ok);
  const r3 = resetDrawdown(c2.book, "RESET", T0 + 7 * I);
  ok("RESET after every close sets a fresh peak at current equity", r3.ok && !r3.book.account.drawdownLocked && near(r3.book.account.peakEquity, bookEquity(r3.book)));
  ok("RESET is journaled on the account", r3.book.account.resets.length === 1 && r3.book.account.resets[0].at === T0 + 7 * I && r3.book.account.lockClearedAt === T0 + 7 * I);
  ok("RESET with no lock is a no-op", (() => { const z = resetDrawdown(newBook(T0), "RESET", T0); return z.ok && z.book.account.resets.length === 0; })());
  ok("evaluate sees the book's peak", accountSnapshot(down, "binance", "4h", LOCK_AT).drawdownLocked === true && accountSnapshot(up, "binance", "4h", T0 + 4 * I).peakEquity === up.account.peakEquity);

  // Migration: a stored v1 account with an open position.
  const port = memoryPaperPort();
  const v1 = { ...newBook(T0).account, schema: 1, balance: 9_500, startingEquity: 10_000 };
  delete v1.peakEquity; delete v1.drawdownLocked; delete v1.resets; delete v1.lockClearedAt;
  await port.put("paper_state", "account", v1);
  const openPos = { ...sol, size: 10, mark: 98, entry: 100 };
  await port.put("paper_positions", openPos.id, openPos);
  const migrated = await createPaperStore(Promise.resolve(port)).load(T0);
  ok("migrates v1 book with open positions", migrated.account.schema === 2 && migrated.account.balance === 9_500 && migrated.positions.length === 1
    && migrated.account.drawdownLocked === false && near(migrated.account.peakEquity, bookEquity(migrated)), JSON.stringify({ s: migrated.account.schema, b: migrated.account.balance, p: migrated.account.peakEquity }));
}

console.log("v2.8 WP19 — fix round 1 (Task 1)");
{
  const { EXIT_REASON_KEYS } = await import("./paper-broker.ts");
  const en = JSON.parse(readFileSync(join(process.cwd(), "src/rsl/i18n/en.json"), "utf8"));
  const reasons = ["stop", "target", "manual", "drawdown lock", "time"];
  ok("every ExitReason maps to a catalog key present in en.json",
    reasons.every((r) => typeof EXIT_REASON_KEYS?.[r] === "string" && !/\s/.test(EXIT_REASON_KEYS[r]) && typeof en[EXIT_REASON_KEYS[r]] === "string"),
    JSON.stringify(EXIT_REASON_KEYS));
  // T1-2: entering a starting equity on a fresh book must not trip the drawdown lock.
  const lowered = setStartingEquity(newBook(T0), 5_000);
  ok("setStartingEquity sets the peak to the new equity", lowered.ok && lowered.book.account.peakEquity === 5_000, String(lowered.book.account.peakEquity));
  const zero = { feeBps: 0, slipBps: 0, fundingBpsPer8h: 0 };
  const hb = { ...lowered.book, account: { ...lowered.book.account, heartbeats: { "binance|4h": NOW } } };
  ok("a fresh book at 5 000 is not drawdown-locked", !evaluateProposal(input(), accountSnapshot(hb, "binance", "4h", NOW), hb.account.settings, NOW).reasons.includes("paper.rule.drawdownLock"));
  const raised = setStartingEquity(newBook(T0), 50_000);
  ok("raising the starting equity moves the peak too", raised.ok && raised.book.account.peakEquity === 50_000);
  const scanned = processBars(hb, "binance", "4h", { SOLUSDT: [bar(T0 + 6 * I, 1, 1, 1, 1)] }, T0 + 7 * I, zero).book;
  ok("a scan after lowering does not engage the lock", scanned.account.drawdownLocked === false);
  // T1-4: a NaN mark never engages the lock (and drawdownBreached is the single formula).
  const { drawdownBreached } = await import("./risk-engine.ts");
  ok("drawdownBreached: NaN equity is not a breach", drawdownBreached({ equity: NaN, peakEquity: 10_000, drawdownLocked: false }, S) === false);
  const nanBook = { ...liveBook(), positions: [{ id: "n", proposalId: "n", configId: "c", pair: "SOLUSDT", src: "binance", tf: "4h", assetClass: "crypto", side: "long", size: 1, stopDistance: 4, targetDistance: 8, plannedRisk: 4, refPrice: 100, signalBarTime: T0, intervalMs: I, approvedAt: T0, status: "open", entry: 100, openedAt: T0 + I, stop: 96, target: 108, mark: NaN, fundingPaid: 0, feesPaid: 0, closeRequestedAt: null }] };
  const nanRes = processBars(nanBook, "binance", "4h", { SOLUSDT: [bar(T0 + 2 * I, 100, 100.5, 99.5, 100)] }, T0 + 3 * I, zero);
  ok("a NaN mark does not engage the lock", nanRes.book.account.drawdownLocked === false);
}

console.log("v2.8 WP19 — cost-inclusive sizing, open-loss locks, no loosening, caps and gates");
{
  const has = (v, key) => v.reasons.includes(key);
  const ev = (i = {}, a = {}, st = {}, now = NOW) => evaluateProposal(input(i), acct(a), { ...S, ...st }, now);
  const binRt = 2 * (10 + 5) / 1e4;
  const v = ev({ roundTripCost: binRt });
  ok("size = budget ÷ (stop distance + entry × round-trip cost)", v.size === roundToStep(50 / (4 + 100 * binRt), 0.01), String(v.size));
  ok("1 R includes the round-trip cost", near(v.riskAmount, v.size * (4 + 100 * binRt)));
  ok("no round-trip cost given → old sizing", ev().size === 12.5);
  // End to end: a clean stop-out through the broker is ≈ −1 R (stop 2% from entry).
  const cleanStopR = (src, pair) => {
    const c = DEFAULT_COSTS[src];
    const b0 = { ...newBook(T0), account: { ...newBook(T0).account, heartbeats: { [`${src}|4h`]: NOW } } };
    const rt = 2 * (c.feeBps + c.slipBps) / 1e4;
    const pr = createProposal(b0, input({ src, pair, atr: 1, roundTripCost: rt }), NOW, "c" + src);
    const b1 = approveProposal(b0, pr, "c" + src, NOW).book;
    const o = processBars(b1, src, "4h", { [pair]: [bar(T0 + 2 * I, 100, 100.5, 99.5, 100)] }, T0 + 3 * I, c).book;
    const e = o.positions[0].entry;
    const stopDist = o.positions[0].stopDistance;
    return { r: processBars(o, src, "4h", { [pair]: [bar(T0 + 3 * I, e, e, e - stopDist - 0.5, e - stopDist)] }, T0 + 4 * I, c).closed[0].r, stopDist };
  };
  const rb = cleanStopR("binance", "SOLUSDT");
  ok("clean stop-out ≈ −1 R on Binance (2% stop, in [−1.00, −0.97])", near(rb.stopDist, 2) && rb.r >= -1.0 - 1e-9 && rb.r <= -0.97, JSON.stringify(rb));
  const rc = cleanStopR("coinsph", "SOLUSDT");
  ok("clean stop-out ≈ −1 R on Coins.ph (2% stop, in [−1.00, −0.94])", near(rc.stopDist, 2) && rc.r >= -1.0 - 1e-9 && rc.r <= -0.94, JSON.stringify(rc));

  // T2-1: changing the starting equity restarts the day/week marks (and the peak) at the new equity.
  const low = setStartingEquity(newBook(T0), 1_000);
  ok("lowering the starting equity resets day/week marks and peak", low.ok && low.book.account.dayMark.equity === 1_000 && low.book.account.weekMark.equity === 1_000 && low.book.account.peakEquity === 1_000,
    JSON.stringify([low.book.account.dayMark, low.book.account.weekMark]));
  const lowLive = { ...low.book, account: { ...low.book.account, heartbeats: { "binance|4h": NOW } } };
  const lowLocks = lockState(lowLive, "binance", "4h", I, NOW);
  ok("lowering 10 000 → 1 000 does not trip the daily or weekly lock", !lowLocks.daily && !lowLocks.weekly && !lowLocks.drawdown);
  const high = setStartingEquity(newBook(T0), 50_000);
  ok("raising resets day/week marks to the new equity", high.book.account.dayMark.equity === 50_000 && high.book.account.weekMark.equity === 50_000);
  const highSnap = accountSnapshot({ ...high.book, account: { ...high.book.account, balance: 48_900 } }, "binance", "4h", NOW);
  ok("after raising to 50 000 a −2.2% day is still a daily lock", lossLocksOf(highSnap).daily);

  // T2-2: a loss realised in the scan that sets today's mark counts toward today's locks.
  {
    const zeroC = { feeBps: 0, slipBps: 0, fundingBpsPer8h: 0 };
    const x0 = liveBook();
    const xp = createProposal(x0, input(), NOW, "t22");
    const x1 = processBars(approveProposal(x0, xp, "t22", NOW).book, "binance", "4h", { SOLUSDT: [bar(T0 + 2 * I, 100, 100.5, 99.5, 100)] }, T0 + 3 * I, zeroC).book;
    const A = { ...x1.positions[0], size: 75, entry: 100, mark: 100, stop: 98, stopDistance: 2, target: 1000, targetDistance: 900, plannedRisk: 150, feesPaid: 0, fundingPaid: 0 };
    const B = { ...A, id: "pos-B", proposalId: "B", pair: "ETHUSDT", size: 100, stop: 1, plannedRisk: 99 * 100 };
    const x2 = { ...x1, positions: [A, B], account: { ...x1.account, balance: 10_000 } };
    const D2 = T0 + 86_400_000;
    const s1 = processBars(x2, "binance", "4h", { SOLUSDT: [bar(D2, 100, 100, 97, 97.5)], ETHUSDT: [bar(D2, 100, 100, 100, 100)] }, D2 + I, zeroC);
    ok("the overnight stop closed at −1.5%", s1.closed.length === 1 && near(s1.closed[0].pnl, -150), JSON.stringify(s1.closed.map((c) => c.pnl)));
    ok("the day mark is the equity before today's realised loss", near(s1.book.account.dayMark.equity, 10_000), String(s1.book.account.dayMark.equity));
    const s2 = processBars(s1.book, "binance", "4h", { ETHUSDT: [bar(D2 + I, 100, 100, 99.3, 99.4)] }, D2 + 2 * I, zeroC);
    const ls = lockState(s2.book, "binance", "4h", I, D2 + 2 * I);
    ok("−1.5% realised then −0.6% open engages the 2% daily lock", ls.daily === true, JSON.stringify([bookEquity(s2.book), s2.book.account.dayMark]));
  }
  // The realised basis is kept as the other half of "the stricter of the two".
  ok("realised basis still locks when the mark basis alone would not", lossLocksOf({ ...acct({ equity: 9_790, realisedToday: -210 }), dayStartEquity: 9_790 }).daily);

  ok("open losses count toward the daily lock", has(ev({}, { equity: 9_790, realisedToday: 0, dayStartEquity: 10_000 }), "paper.rule.dailyLock"));
  ok("daily lock not tripped at 1.9% open loss", !has(ev({}, { equity: 9_810, realisedToday: 0, dayStartEquity: 10_000 }), "paper.rule.dailyLock"));
  ok("open losses count toward the weekly lock", has(ev({}, { equity: 9_500, weekStartEquity: 10_000, dayStartEquity: 9_500 }), "paper.rule.weeklyLock"));

  // Start-of-day mark: the first mark at or after 00:00 UTC.
  const bk = liveBook();
  ok("new book carries day/week start marks", bk.account.dayMark.equity === 10_000 && bk.account.dayMark.day === utcDayStart(T0) && bk.account.weekMark.week === utcWeekStart(T0));
  const nextDay = processBars(bk, "binance", "4h", { SOLUSDT: [bar(T0 + 6 * I, 1, 1, 1, 1)] }, T0 + 7 * I).book;
  ok("first mark of a new UTC day resets the day start", nextDay.account.dayMark.day === utcDayStart(T0 + 7 * I));
  ok("snapshot passes the start-of-day equity", accountSnapshot(nextDay, "binance", "4h", T0 + 7 * I).dayStartEquity === nextDay.account.dayMark.equity);

  // No loosening while locked.
  const killed = engageKill(liveBook(), NOW);
  const loosen = updateSettings(killed, { ...killed.account.settings, riskPerTradePct: 1 }, NOW);
  ok("locks can't be loosened while active (kill switch)", !loosen.ok && loosen.invalid.join() === "locked");
  ok("tightening is allowed while locked", updateSettings(killed, { ...killed.account.settings, riskPerTradePct: 0.25 }, NOW).ok);
  ok("non-risk settings can change while locked", updateSettings(killed, { ...killed.account.settings, stopAtrMult: 3 }, NOW).ok);
  const unlocked = resetKill(killed, "RESET", NOW + 1).book;
  ok("still refused later the same UTC day after the lock cleared", !updateSettings(unlocked, { ...S, riskPerTradePct: 1 }, NOW + 2).ok);
  ok("allowed again from the next UTC day", updateSettings(unlocked, { ...S, riskPerTradePct: 1 }, utcDayStart(NOW) + 86_400_000).ok);
  const lostDay = { ...liveBook(), account: { ...liveBook().account, balance: 9_790 } };
  ok("daily lock (open or realised) also blocks loosening", !updateSettings(lostDay, { ...S, dailyLossLockPct: 3 }, NOW).ok);
  const dmOnly = { ...newBook(T0) }; // no heartbeat → dead-man badge only
  ok("the dead-man badge alone does not block loosening", updateSettings(dmOnly, { ...S, riskPerTradePct: 1 }, NOW).ok);

  // Max drawdown % is tracked separately from the amount.
  const jr = (id, t, pnl) => ({ id, openedAt: t - 1, closedAt: t, pnl, r: pnl / 50 });
  const st = journalStats([jr("a", 1, -50), jr("b", 2, 950), jr("c", 3, -300)], 100);
  ok("max drawdown % is the largest % drawdown", st.maxDrawdown === 300 && near(st.maxDrawdownPct, 0.5), `${st.maxDrawdown} ${st.maxDrawdownPct}`);

  // Correlated crypto cap.
  const three = [pos({ pair: "BTCUSDT" }), pos({ pair: "XRPUSDT" }), pos({ pair: "ETHUSDT" })];
  ok("crypto cap default 3", S.maxCryptoPositions === 3);
  ok("a 4th crypto position is blocked", has(ev({}, { positions: three }, { maxPerClusterPositions: 5 }), "paper.rule.cryptoCap"));
  ok("a stock is not counted against the crypto cap", !has(ev({ assetClass: "stock", pair: "AAPLUSDT" }, { positions: three }, { maxPerClusterPositions: 5 }), "paper.rule.cryptoCap"));

  // Depeg gate.
  ok("quote depeg ≥ 1% blocks", has(ev({ depegPct: 1.0 }), "paper.rule.depeg") && has(ev({ depegPct: -2.4 }), "paper.rule.depeg"));
  ok("quote depeg 0.99% passes", !has(ev({ depegPct: 0.99 }), "paper.rule.depeg"));
  ok("USDT (reference, null reading) is never gated", !has(ev({ depegPct: null }), "paper.rule.depeg"));

  // Intraday as context.
  const M15 = 15 * 60e3;
  ok("1m–15m proposals blocked by default", has(ev({ tf: "15m", intervalMs: M15, barTime: NOW - 2 * M15 + 1 }), "paper.rule.intradayContext"));
  ok("1h passes the intraday rule", !has(ev({ tf: "1h", intervalMs: H, barTime: NOW - 2 * H + 1 }), "paper.rule.intradayContext"));
  ok("intraday allowed by the setting", !has(ev({ tf: "15m", intervalMs: M15, barTime: NOW - 2 * M15 + 1 }, {}, { allowIntradayProposals: true }), "paper.rule.intradayContext"));

  // Time stop.
  ok("time stop off by default", S.timeStopBars === 0);
  ok("time-stop checkbox: on fills the 24-bar preset, off sets 0", timeStopToggleBars(true) === TIME_STOP_PRESET_BARS && TIME_STOP_PRESET_BARS === 24 && timeStopToggleBars(false) === 0);
  const zero = { feeBps: 0, slipBps: 0, fundingBpsPer8h: 0 };
  const tb0 = { ...liveBook(), account: { ...liveBook().account, settings: { ...S, timeStopBars: 2 } } };
  const tpr = createProposal(tb0, input(), NOW, "ts");
  let tb = approveProposal(tb0, tpr, "ts", NOW).book;
  tb = processBars(tb, "binance", "4h", { SOLUSDT: [bar(T0 + 2 * I, 100, 100.5, 99.5, 100)] }, T0 + 3 * I, zero).book;
  const tr = processBars(tb, "binance", "4h", { SOLUSDT: [bar(T0 + 3 * I, 100, 101, 99, 100.5), bar(T0 + 4 * I, 100.7, 101, 100, 100.9)] }, T0 + 5 * I, zero);
  ok("time stop closes at the next open with reason 'time'", tr.closed.length === 1 && tr.closed[0].reason === "time" && near(tr.closed[0].exit, 100.7), tr.closed.map((c) => c.reason + "@" + c.exit).join());

  // Event blackout (WP19).
  const FOMC_AT = Date.UTC(2026, 9, 28, 18); // 28 Oct 2026 14:00 EDT
  const inEvent = FOMC_AT - 90 * 60e3;
  const evAt = (now, s = {}) => evaluateProposal(input({ barTime: now - 4 * H }), acct(), { ...S, ...s }, now);
  ok("proposal 90 min before FOMC is blocked with paper.rule.event", has(evAt(inEvent), "paper.rule.event"));
  ok("event blackout off lets it pass", !has(evAt(inEvent, { eventBlackout: false }), "paper.rule.event"));
  ok("outside the window the rule is silent", !has(evAt(FOMC_AT - 3 * H), "paper.rule.event") && !has(evAt(FOMC_AT + 61 * 60e3), "paper.rule.event"));

  // Warnings and leverage.
  ok("risk per trade > 1% warns", ev({}, {}, { riskPerTradePct: 1.5 }).warnings.includes("paper.warn.riskAbove1") && !ev().warnings.length);
  ok("leverage capped at 1 until liquidation is modelled", validateSettings({ ...S, maxLeverage: 2 }).includes("maxLeverage"));
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
