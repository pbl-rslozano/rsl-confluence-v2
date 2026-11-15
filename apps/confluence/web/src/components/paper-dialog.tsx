"use client";
/**
 * paper-dialog.tsx — v2.2 Phase G "Paper trading" (PAPER ONLY).
 *
 * Assisted execution as a SIMULATOR: strong BUY/SELL rows from the current scan
 * become proposals, the deterministic risk engine checks each one, and only the
 * owner can approve. Fills, stops, targets, fees, slippage and funding are
 * simulated on closed bars (lib/paper-broker.ts). No order of any kind is sent,
 * nothing here makes a network call, and no LLM is in this path (ADR-0010).
 *
 * The component stays mounted while closed (like LedgerDialog), so positions
 * keep updating on every scan: each new `rows` array is a scan heartbeat and
 * its closed klines are fed to `processBars`. An integrator can also push bars
 * for pairs outside the visible rows through the optional `onBar` subscription.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Download, FlaskConical, Loader2, OctagonX, ShieldCheck } from "lucide-react";
import { exportFileName, toCSV } from "@rsl/core-kit/core/rsl-export.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useRsl } from "@/rsl/RslContext";
import { TradeAnnotation } from "@/components/trade-annotation";
import { ChartReplay } from "@/components/chart-replay";
import { loadHistoricalSeries } from "@/lib/history-store";
import { INTERVAL_MS, type DataSource } from "@/lib/market-client";
import { atr, type Kline } from "@/lib/indicators";
import type { AssetClass } from "@/lib/ledger-metrics";

import {
  DEFAULT_RISK_SETTINGS,
  evaluateProposal,
  RISK_SETTING_LIMITS,
  BOOLEAN_SETTINGS,
  timeStopToggleBars,
  validateSettings,
  type Master,
  type ProposalInput,
  type RiskSettings,
  type Strength,
} from "@/lib/risk-engine";
import {
  accountSnapshot,
  approveProposal,
  bookEquity,
  costsFor,
  createProposal,
  depegFor,
  slippageFor,
  engageKill,
  isUnmanaged,
  journalStats,
  KILL_RESET_WORD,
  lockState,
  openRisk,
  processBars,
  proposalId,
  randomNonce,
  RECONCILE_GATE_TRADES,
  rejectProposal,
  requestClose,
  resetKill,
  resetDrawdown,
  waitingSeries,
  EXIT_REASON_KEYS,
  setStartingEquity,
  unrealised,
  updateSettings,
  type JournalEntry,
  type PaperBook,
  type Proposal,
} from "@/lib/paper-broker";
import { journalRowValues, PAPER_JOURNAL_COLUMNS, type PaperStore } from "@/lib/paper-store";

/** The subset of a scan row the simulator needs (the page's AssetRow satisfies it structurally). */
export interface PaperScanRow {
  pair: string;
  symbol: string;
  assetClass: AssetClass;
  confluence: { master: Master; strength: Strength; score: number; suppressed: boolean };
  /** Closed bars only, time-sorted (the same series the scan scored). */
  klines: Kline[];
  underlyingClosed: boolean;
}

/** Push closed bars (pair → klines) of the CURRENT source × timeframe. */
export type PaperBarListener = (bars: Record<string, Kline[]>, now: number) => void;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** createPaperStore(port) — a separate IndexedDB database "rsl-conf-paper" in the browser. */
  store: PaperStore | null;
  /** The raw scan rows (not a sorted/filtered view): a new array = a new scan heartbeat. */
  rows: PaperScanRow[];
  source: string;
  timeframe: string;
  engineConfigId: string;
  /** Optional subscription for extra bars; return an unsubscribe function. */
  onBar?: (listener: PaperBarListener) => () => void;
  /** v2.8: stored order-book slippage readings of this source (pair → bps, time); only readings < 24 h old are used. */
  slippage?: Record<string, { bps: number; at: number }>;
  /** v2.8: stablecoin depeg readings of the scan these rows came from, and each row's quote (pair → quote). */
  depeg?: ReadonlyArray<{ coin: string; reference: string; deviationPct: number }>;
  quoteBySymbol?: Record<string, string>;
}

type NumericKey = keyof typeof RISK_SETTING_LIMITS;
const NUMERIC_KEYS = Object.keys(RISK_SETTING_LIMITS) as NumericKey[];
type BoolKey = (typeof BOOLEAN_SETTINGS)[number];
const flagsOf = (s: RiskSettings) => Object.fromEntries(BOOLEAN_SETTINGS.map((k) => [k, s[k]])) as Record<BoolKey, boolean>;

const fmtMoney = (v: number) => (Number.isFinite(v) ? v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—");
const fmtSigned = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${fmtMoney(v)}` : "—");
const fmtPx = (v: number | null) => (v == null || !Number.isFinite(v) ? "—" : v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toPrecision(4));
const fmtNum = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—");
const fmtPct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "—");
const fmtUtc = (ms: number | null) => (ms ? `${new Date(ms).toISOString().slice(5, 16).replace("T", " ")} UTC` : "—");
const pnlClass = (v: number) => (v > 0 ? "text-emerald-400" : v < 0 ? "text-rose-400" : "text-zinc-300");

/**
 * A series is fed to the simulator only when its bar spacing matches the
 * current timeframe (rows left over from a previous timeframe are ignored) and
 * its newest closed bar is recent (a stale feed is not a heartbeat).
 */
function seriesUsable(k: Kline[] | undefined, intervalMs: number, now: number): k is Kline[] {
  if (!k || k.length < 2) return false;
  const a = k[k.length - 2].time;
  const b = k[k.length - 1].time;
  const spacingOk = intervalMs >= 28 * 86_400_000 ? b - a >= 28 * 86_400_000 && b - a <= 31 * 86_400_000 : b - a === intervalMs;
  return spacingOk && b + 2 * intervalMs >= now;
}
function usableRows(rows: PaperScanRow[], intervalMs: number, now: number): PaperScanRow[] {
  return rows.filter((r) => seriesUsable(r.klines, intervalMs, now));
}

function draftOf(s: RiskSettings): Record<string, string> {
  return Object.fromEntries(NUMERIC_KEYS.map((k) => [k, String(s[k])]));
}

export function PaperDialog({ open, onOpenChange, store, rows, source, timeframe, engineConfigId, onBar, slippage, depeg, quoteBySymbol }: Props) {
  const { t, id, platform, audit, announce, port } = useRsl();
  const [annotating, setAnnotating] = useState<JournalEntry | null>(null);
  const [review, setReview] = useState<{ trade: JournalEntry; candles: Kline[] } | null>(null);
  const [book, setBook] = useState<PaperBook | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>(() => draftOf(DEFAULT_RISK_SETTINGS));
  const [draftFlags, setDraftFlags] = useState<Record<BoolKey, boolean>>(() => flagsOf(DEFAULT_RISK_SETTINGS));
  const [equityDraft, setEquityDraft] = useState("");
  const [settingErrors, setSettingErrors] = useState<string[]>([]);
  const [killText, setKillText] = useState("");
  const [killError, setKillError] = useState(false);
  const [ddText, setDdText] = useState("");
  const [ddError, setDdError] = useState(false);
  /** Source of truth for async handlers; updated only in callbacks, never during render. */
  const bookRef = useRef<PaperBook | null>(null);
  const proposalsRef = useRef<Proposal[]>([]);
  const intervalMs = INTERVAL_MS[timeframe] ?? INTERVAL_MS["4h"];
  const costs = costsFor(source);

  const log = useCallback((event: string, record: string, reason: string) => {
    void audit.append({ actorId: id.operator.id || "local", event, record, reason }).catch(() => undefined);
  }, [audit, id.operator.id]);

  const commit = useCallback((next: PaperBook) => {
    bookRef.current = next;
    setBook(next);
    if (store) void store.save(next).catch((e: unknown) => setFailure(e instanceof Error ? e.message : String(e)));
  }, [store]);

  const setProposalList = (list: Proposal[]) => {
    proposalsRef.current = list;
    setProposals(list);
  };

  const syncDraft = (b: PaperBook) => {
    setDraft(draftOf(b.account.settings));
    setDraftFlags(flagsOf(b.account.settings));
    setEquityDraft(String(b.account.startingEquity));
  };

  // Load the book once per store.
  useEffect(() => {
    if (!store) return;
    let live = true;
    store.load().then((b) => {
      if (!live) return;
      bookRef.current = b;
      setBook(b);
      syncDraft(b);
      setLoaded(true);
    }).catch((e: unknown) => { if (live) setFailure(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [store]);

  // Clock for expiry / dead-man display.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  /** Feed closed bars into the broker, persist, and audit any exits. */
  const ingestBars = useCallback((bars: Record<string, Kline[]>, at: number) => {
    const cur = bookRef.current;
    if (!cur) return;
    const slipByPair: Record<string, number> = {};
    for (const pair of Object.keys(bars)) {
      const m = slippageFor(slippage, pair, at); // readings < 24 h old only
      if (m !== undefined) slipByPair[pair] = m;
    }
    const res = processBars(cur, source, timeframe, bars, at, undefined, slipByPair); // per-position costs (asset class, measured slippage)
    commit(res.book);
    for (const j of res.closed) {
      log("paper.close", "paper", `${j.id} ${j.pair} ${j.side} ${j.reason} · exit ${fmtPx(j.exit)} · pnl ${fmtSigned(j.pnl)} · R ${fmtNum(j.r)}`);
      announce(t("paper.closedMsg", { name: j.pair, s: fmtNum(j.r) }));
    }
  }, [source, timeframe, slippage, commit, log, announce, t]);

  /** Strong BUY/SELL rows → proposals (one per signal bar; decided or expired ones are not re-proposed). */
  const refreshProposals = useCallback((scan: PaperScanRow[], at: number) => {
    const cur = bookRef.current;
    if (!cur) return;
    const existing = new Map(proposalsRef.current.map((p) => [p.id, p]));
    const next: Proposal[] = [];
    for (const row of scan) {
      const c = row.confluence;
      if (c.strength !== "STRONG" || c.master === "NEUTRAL" || row.klines.length < 2) continue;
      const last = row.klines[row.klines.length - 1];
      const input: ProposalInput = {
        pair: row.pair,
        src: source,
        tf: timeframe,
        assetClass: row.assetClass,
        side: c.master === "BULLISH" ? "long" : "short",
        entryRef: last.close,
        atr: atr(row.klines, 14).at(-1) ?? NaN,
        score: c.score,
        strength: c.strength,
        master: c.master,
        suppressed: c.suppressed,
        underlyingClosed: row.underlyingClosed,
        configId: engineConfigId,
        barTime: last.time,
        intervalMs,
        depegPct: depegFor(depeg, quoteBySymbol?.[row.pair]),
      };
      const pid = proposalId(input);
      const prior = existing.get(pid);
      if (prior && at <= prior.expiresAt && !cur.account.decisions[pid]) { next.push(prior); continue; }
      const p = createProposal(cur, input, at, randomNonce(), slippageFor(slippage, row.pair, at));
      if (p) {
        next.push(p);
        log("paper.propose", "paper", `${p.id} · ${p.verdict.approved ? "passes" : `blocked: ${p.verdict.reasons.join(",")}`}`);
      }
    }
    setProposalList(next);
  }, [source, timeframe, engineConfigId, intervalMs, slippage, depeg, quoteBySymbol, log]);

  // Latest handlers for the scan effect and the external feed, so a re-created
  // callback (e.g. after a language change) never re-runs ingestion by itself.
  const handlersRef = useRef({ ingestBars, refreshProposals });
  useEffect(() => { handlersRef.current = { ingestBars, refreshProposals }; }, [ingestBars, refreshProposals]);

  // Every new scan (rows array) is a heartbeat: process bars, then refresh proposals.
  useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(() => {
      const at = Date.now();
      const usable = usableRows(rows, intervalMs, at);
      const bars: Record<string, Kline[]> = {};
      for (const r of usable) bars[r.pair] = r.klines;
      handlersRef.current.ingestBars(bars, at);
      handlersRef.current.refreshProposals(usable, at);
      setNow(at);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [rows, loaded]);

  // Optional external bar feed (same freshness/interval checks as scan rows).
  useEffect(() => {
    if (!onBar) return;
    return onBar((bars, at) => {
      const fresh: Record<string, Kline[]> = {};
      for (const [pair, k] of Object.entries(bars)) if (seriesUsable(k, intervalMs, at)) fresh[pair] = k;
      handlersRef.current.ingestBars(fresh, at);
    });
  }, [onBar, intervalMs]);

  const view = useMemo(() => {
    if (!book) return null;
    const equity = bookEquity(book);
    const risk = openRisk(book);
    const locks = lockState(book, source, timeframe, intervalMs, now);
    const stats = journalStats(book.journal, book.account.startingEquity, book.account.createdAt);
    const snap = accountSnapshot(book, source, timeframe, now);
    const verdicts = proposals.map((p) => ({ p, v: evaluateProposal(p.input, snap, book.account.settings, now), expired: now > p.expiresAt }));
    const unmanaged = book.positions.filter((p) => isUnmanaged(book, p, now)).map((p) => p.id);
    return { equity, risk, locks, stats, verdicts, unmanaged: new Set(unmanaged) };
  }, [book, proposals, now, source, timeframe, intervalMs]);

  /* -------------------------- actions -------------------------- */
  const approve = (p: Proposal) => {
    const cur = bookRef.current;
    if (!cur) return;
    const at = Date.now();
    const res = approveProposal(cur, p, p.nonce, at);
    commit(res.book);
    setProposalList(proposalsRef.current.filter((x) => x.id !== p.id));
    setNow(at);
    if (res.ok && res.position) {
      const q = res.position;
      log("paper.approve", "paper", `${p.id} · ${q.id} ${q.side} ${q.size} @ next open · stop ${fmtPx(q.stop)} target ${fmtPx(q.target)} · risk ${fmtMoney(q.plannedRisk)} · nonce ${p.nonce.slice(0, 8)}…`);
      setFailure(null);
      setMessage(t("paper.approvedMsg", { name: q.pair }));
      announce(t("paper.approvedMsg", { name: q.pair }));
    } else {
      const why = res.error === "risk" ? (res.verdict?.reasons ?? []).map((k) => t(k)).join("; ") : t(`paper.err.${res.error}`);
      log("paper.reject", "paper", `${p.id} · refused at approval (${res.error})${res.verdict ? `: ${res.verdict.reasons.join(",")}` : ""}`);
      setMessage(null);
      setFailure(t("paper.refused", { reason: why }));
    }
  };

  const reject = (p: Proposal) => {
    const cur = bookRef.current;
    if (!cur) return;
    const res = rejectProposal(cur, p, p.nonce, Date.now());
    commit(res.book);
    setProposalList(proposalsRef.current.filter((x) => x.id !== p.id));
    if (res.ok) {
      log("paper.reject", "paper", `${p.id} · rejected by owner`);
      setMessage(t("paper.rejectedMsg", { name: p.input.pair }));
    }
  };

  const close = (positionId: string) => {
    const cur = bookRef.current;
    if (!cur) return;
    const res = requestClose(cur, positionId, Date.now());
    if (!res.found) return;
    commit(res.book);
    const pos = cur.positions.find((x) => x.id === positionId);
    log("paper.close", "paper", `${positionId} ${pos?.pair ?? ""} · ${res.cancelled ? "pending order cancelled" : "manual close requested (next bar open)"}`);
    setMessage(t(res.cancelled ? "paper.cancelledMsg" : "paper.closeRequested", { name: pos?.pair ?? "" }));
  };

  const engage = () => {
    const cur = bookRef.current;
    if (!cur || cur.account.killSwitch) return;
    commit(engageKill(cur, Date.now()));
    log("paper.kill", "paper", "kill switch engaged — new approvals blocked; positions untouched");
    setMessage(t("paper.killEngaged"));
    announce(t("paper.killEngaged"));
  };

  const reset = () => {
    const cur = bookRef.current;
    if (!cur) return;
    const res = resetKill(cur, killText, Date.now());
    if (!res.ok) { setKillError(true); return; }
    commit(res.book);
    setKillError(false);
    setKillText("");
    log("paper.kill", "paper", "kill switch reset (typed confirmation)");
    setMessage(t("paper.killResetDone"));
  };

  const resetDd = () => {
    const cur = bookRef.current;
    if (!cur) return;
    const res = resetDrawdown(cur, ddText, Date.now());
    if (!res.ok) { setDdError(true); return; }
    commit(res.book);
    setDdError(false);
    setDdText("");
    log("paper.drawdown", "paper", "drawdown lock reset (typed confirmation) — peak restarted at current equity");
    setMessage(t("paper.drawdownResetDone"));
  };

  const saveSettings = () => {
    const cur = bookRef.current;
    if (!cur) return;
    const next: RiskSettings = { ...cur.account.settings, ...draftFlags };
    for (const k of NUMERIC_KEYS) {
      const raw = (draft[k] ?? "").trim().replace(",", ".");
      (next as unknown as Record<string, number>)[k] = raw === "" ? NaN : Number(raw);
    }
    const invalid = validateSettings(next);
    let b = cur;
    let equityChanged = false;
    if (!cur.positions.length && !cur.journal.length) {
      const eq = Number(equityDraft.trim().replace(",", "."));
      if (eq !== cur.account.startingEquity) {
        const r = setStartingEquity(b, eq);
        if (!r.ok) invalid.push("startingEquity");
        else { b = r.book; equityChanged = true; }
      }
    }
    setSettingErrors(invalid);
    if (invalid.length) return;
    const res = updateSettings(b, next);
    if (!res.ok) { setSettingErrors(res.invalid); return; }
    commit(res.book);
    const changed = (Object.keys(next) as (keyof RiskSettings)[]).filter((k) => next[k] !== cur.account.settings[k]);
    log("paper.settings", "paper", `changed: ${[...changed, ...(equityChanged ? ["startingEquity"] : [])].join(", ") || "none"}`);
    setMessage(t("paper.saved"));
  };

  async function replayTrade(trade: JournalEntry) {
    try {
      const candles = await loadHistoricalSeries(trade.src as DataSource, trade.tf, trade.pair);
      const intervalMs = INTERVAL_MS[trade.tf];
      const throughExit = candles.filter((bar) => bar.time + intervalMs <= trade.closedAt);
      if (!throughExit.some((bar) => bar.time <= trade.openedAt) ||
          !throughExit.some((bar) => bar.time >= trade.openedAt)) {
        setMessage("Saved candle history does not cover this trade.");
        return;
      }
      setReview({ trade, candles: throughExit });
    } catch {
      setMessage("Saved candle history could not be loaded.");
    }
  }

  const exportCsv = async () => {
    const cur = bookRef.current;
    if (!cur?.journal.length) return;
    const headers = [...PAPER_JOURNAL_COLUMNS];
    const csv = toCSV(cur.journal.map(journalRowValues), { headers, columns: headers, notice: t("paper.banner") });
    const name = exportFileName({ app: "ConfluenceTerminal", customerCode: id.customer.code, docId: "paper-journal", ext: "csv" });
    const res = await platform.saveOrShare(new TextEncoder().encode(csv), name, "text/csv");
    if (res.ok) {
      log("paper.export", "paper", `${cur.journal.length} trades · ${name}`);
      setMessage(t("paper.exported", { n: cur.journal.length }));
    }
  };

  /* --------------------------- render --------------------------- */
  const s = book?.account.settings ?? DEFAULT_RISK_SETTINGS;
  const lockBadge = (on: boolean, label: string) => (
    <Badge variant="outline" className={on ? "border-rose-500/60 bg-rose-500/10 text-rose-200" : "border-zinc-700 text-zinc-400"}>
      {label}: {on ? t("paper.stateOn") : t("paper.stateOff")}
    </Badge>
  );
  const blocked = !!view && (view.locks.kill || view.locks.deadMan || view.locks.daily || view.locks.weekly || view.locks.drawdown);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(100vw-1.5rem,60rem)] max-w-[min(100vw-1.5rem,60rem)] max-h-[92dvh] overflow-y-auto overflow-x-hidden border-zinc-800 bg-zinc-900 p-4 text-zinc-100 sm:p-5">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <FlaskConical className="h-5 w-5 text-amber-400" />
            {t("paper.title")}
          </DialogTitle>
          <DialogDescription className="text-xs text-zinc-400">{t("paper.intro")}</DialogDescription>
        </DialogHeader>

        <p role="note" className="flex items-center gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm font-semibold text-amber-200">
          <ShieldCheck className="h-4 w-4 shrink-0" />
          {t("paper.banner")}
        </p>

        {failure && <p role="alert" className="text-xs text-rose-300">{failure}</p>}
        {message && <p role="status" className="text-xs text-emerald-300">{message}</p>}

        {!book || !view ? (
          <div className="flex items-center gap-2 py-6 text-sm text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" />{t("paper.loading")}</div>
        ) : (
          <div className="space-y-4">
            {/* ---------- Account ---------- */}
            <section aria-labelledby="paper-account" className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
              <h3 id="paper-account" className="mb-2 text-sm font-semibold text-zinc-200">{t("paper.account")}</h3>
              <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
                <div><dt className="text-zinc-400">{t("paper.equity")}</dt><dd className="font-mono tabular-nums">{fmtMoney(view.equity)}</dd></div>
                <div><dt className="text-zinc-400">{t("paper.balance")}</dt><dd className="font-mono tabular-nums">{fmtMoney(book.account.balance)}</dd></div>
                <div>
                  <dt className="text-zinc-400">{t("paper.openRisk")}</dt>
                  <dd className="font-mono tabular-nums">{fmtMoney(view.risk)} · {fmtPct(view.equity > 0 ? view.risk / view.equity : NaN)} / {fmtNum(s.maxOpenRiskPct, 1)}%</dd>
                </div>
                <div><dt className="text-zinc-400">{t("paper.todayPnl")}</dt><dd className={`font-mono tabular-nums ${pnlClass(view.locks.realisedToday)}`}>{fmtSigned(view.locks.realisedToday)}</dd></div>
                <div><dt className="text-zinc-400">{t("paper.weekPnl")}</dt><dd className={`font-mono tabular-nums ${pnlClass(view.locks.realisedWeek)}`}>{fmtSigned(view.locks.realisedWeek)}</dd></div>
              </dl>
              <div className="mt-2 flex flex-wrap gap-1.5" aria-label={t("paper.locks")}>
                {lockBadge(view.locks.daily, t("paper.lockDaily"))}
                {lockBadge(view.locks.weekly, t("paper.lockWeekly"))}
                {lockBadge(view.locks.kill, t("paper.lockKill"))}
                {lockBadge(view.locks.deadMan, t("paper.lockDeadMan"))}
                {lockBadge(view.locks.drawdown, t("paper.lockDrawdown"))}
              </div>
              {view.locks.deadMan && (
                <p role="alert" className="mt-2 flex items-center gap-1.5 text-xs text-amber-300"><AlertTriangle className="h-3.5 w-3.5" />{t("paper.deadMan", { bars: s.deadManBars })}</p>
              )}
              <p className="mt-2 text-[11px] text-zinc-400">
                {t("paper.costs", { fee: costs.feeBps, slip: costs.slipBps, funding: costs.fundingBpsPer8h })}
              </p>
            </section>

            {/* ---------- Proposals ---------- */}
            <section aria-labelledby="paper-proposals" className="space-y-2">
              <h3 id="paper-proposals" className="text-sm font-semibold text-zinc-200">{t("paper.proposals")}</h3>
              {blocked && <p className="text-xs text-amber-300">{t("paper.blockedAll")}</p>}
              {view.verdicts.length === 0 && <p className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-xs text-zinc-400">{t("paper.noProposals")}</p>}
              <ul className="space-y-2">
                {view.verdicts.map(({ p, v, expired }) => (
                  <li key={p.id} className={`rounded-lg border p-3 text-xs ${v.approved && !expired ? "border-emerald-500/40 bg-emerald-500/5" : "border-zinc-800 bg-zinc-950/40"}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-zinc-100">{p.input.pair}</span>
                        <Badge variant="outline" className={p.input.side === "long" ? "border-emerald-500/50 text-emerald-300" : "border-rose-500/50 text-rose-300"}>
                          {p.input.side === "long" ? t("paper.long") : t("paper.short")}
                        </Badge>
                        <span className="font-mono tabular-nums text-zinc-400">{t("paper.score")} {fmtNum(p.input.score, 0)}</span>
                        <span className="text-zinc-400">{t("paper.expires", { time: fmtUtc(p.expiresAt) })}</span>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" className="h-8 border-zinc-700 text-zinc-300" onClick={() => reject(p)} aria-label={`${t("paper.reject")} ${p.input.pair}`}>
                          {t("paper.reject")}
                        </Button>
                        <Button
                          size="sm"
                          className="h-8 bg-emerald-800 text-white hover:bg-emerald-700"
                          disabled={!v.approved || expired}
                          onClick={() => approve(p)}
                          aria-label={`${t("paper.approve")} ${p.input.pair}`}
                        >
                          {t("paper.approve")}
                        </Button>
                      </div>
                    </div>
                    <dl className="mt-2 grid grid-cols-2 gap-1 font-mono tabular-nums sm:grid-cols-5">
                      <div><dt className="font-sans text-zinc-400">{t("paper.entryRef")}</dt><dd>{fmtPx(p.input.entryRef)}</dd></div>
                      <div><dt className="font-sans text-zinc-400">{t("paper.size")}</dt><dd>{v.size}</dd></div>
                      <div><dt className="font-sans text-zinc-400">{t("paper.stop")}</dt><dd>{fmtPx(v.stop)}</dd></div>
                      <div><dt className="font-sans text-zinc-400">{t("paper.target")}</dt><dd>{fmtPx(v.target)}</dd></div>
                      <div><dt className="font-sans text-zinc-400">{t("paper.risk")}</dt><dd>{fmtMoney(v.riskAmount)}</dd></div>
                    </dl>
                    <div className={`mt-2 ${v.approved && !expired ? "text-emerald-300" : "text-amber-300"}`}>
                      {expired ? t("paper.err.expired") : v.approved ? t("paper.verdictPass") : t("paper.verdictBlocked")}
                      {v.capped && <span className="ms-2 text-zinc-400">{t("paper.capped")}</span>}
                    </div>
                    {(v.warnings ?? []).map((w) => <p key={w} className="mt-1 text-amber-300">{t(w)}</p>)}
                    {!v.approved && (
                      <ul className="mt-1 list-disc space-y-0.5 ps-5 text-zinc-300">
                        {v.reasons.map((r) => <li key={r}>{t(r)}</li>)}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </section>

            {/* ---------- Positions ---------- */}
            <section aria-labelledby="paper-positions" className="space-y-2">
              <h3 id="paper-positions" className="text-sm font-semibold text-zinc-200">{t("paper.positions")}</h3>
              {book.positions.length === 0 ? (
                <p className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-xs text-zinc-400">{t("paper.noPositions")}</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-zinc-800">
                  <table className="w-full min-w-[44rem] text-xs">
                    <thead className="bg-zinc-950 text-zinc-400">
                      <tr>
                        <th scope="col" className="px-2 py-1.5 text-start">{t("paper.col.pair")}</th>
                        <th scope="col" className="px-2 py-1.5 text-start">{t("paper.col.side")}</th>
                        <th scope="col" className="px-2 py-1.5 text-end">{t("paper.size")}</th>
                        <th scope="col" className="px-2 py-1.5 text-end">{t("paper.col.entry")}</th>
                        <th scope="col" className="px-2 py-1.5 text-end">{t("paper.stop")}</th>
                        <th scope="col" className="px-2 py-1.5 text-end">{t("paper.target")}</th>
                        <th scope="col" className="px-2 py-1.5 text-end">{t("paper.mark")}</th>
                        <th scope="col" className="px-2 py-1.5 text-end">{t("paper.unrealised")}</th>
                        <th scope="col" className="px-2 py-1.5 text-start">{t("paper.status")}</th>
                        <th scope="col" className="px-2 py-1.5 text-end"><span className="sr-only">{t("paper.actions")}</span></th>
                      </tr>
                    </thead>
                    <tbody className="font-mono tabular-nums">
                      {book.positions.map((p) => {
                        const u = unrealised(p);
                        return (
                          <tr key={p.id} className="border-t border-zinc-800">
                            <th scope="row" className="px-2 py-1.5 text-start font-sans font-medium text-zinc-200">{p.pair}<span className="ms-1 text-[10px] text-zinc-400">{p.src} · {p.tf}</span></th>
                            <td className="px-2 py-1.5 font-sans">{p.side === "long" ? t("paper.long") : t("paper.short")}</td>
                            <td className="px-2 py-1.5 text-end">{p.size}</td>
                            <td className="px-2 py-1.5 text-end">{fmtPx(p.entry)}</td>
                            <td className="px-2 py-1.5 text-end">{fmtPx(p.stop)}</td>
                            <td className="px-2 py-1.5 text-end">{fmtPx(p.target)}</td>
                            <td className="px-2 py-1.5 text-end">{p.status === "open" ? fmtPx(p.mark) : "—"}</td>
                            <td className={`px-2 py-1.5 text-end ${pnlClass(u)}`}>{p.status === "open" ? fmtSigned(u) : "—"}</td>
                            <td className="px-2 py-1.5 font-sans text-[11px]">
                              {p.status === "pending" ? t("paper.pending") : p.closeRequestedAt != null ? t("paper.closing") : t("paper.openState")}
                              {view.unmanaged.has(p.id) && <span className="block text-amber-300">{t("paper.unmanaged", { bars: s.deadManBars })}</span>}
                            </td>
                            <td className="px-2 py-1.5 text-end">
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 border-zinc-700 font-sans text-zinc-300"
                                disabled={p.closeRequestedAt != null}
                                onClick={() => close(p.id)}
                                aria-label={`${p.status === "pending" ? t("paper.cancel") : t("paper.closeNext")} ${p.pair}`}
                              >
                                {p.status === "pending" ? t("paper.cancel") : t("paper.closeNext")}
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* ---------- Journal & stats ---------- */}
            <section aria-labelledby="paper-journal" className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="paper-journal" className="text-sm font-semibold text-zinc-200">{t("paper.journal")}</h3>
                <Button size="sm" className="h-8 bg-cyan-800 text-white hover:bg-cyan-700" disabled={!book.journal.length} onClick={() => void exportCsv()}>
                  <Download className="h-3.5 w-3.5" />{t("paper.exportCsv")}
                </Button>
              </div>
              <dl className="grid grid-cols-2 gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-xs sm:grid-cols-6">
                <div><dt className="text-zinc-400">{t("paper.trades")}</dt><dd className="font-mono tabular-nums">{view.stats.trades}</dd></div>
                <div><dt className="text-zinc-400">{t("paper.winRate")}</dt><dd className="font-mono tabular-nums">{fmtPct(view.stats.winRate)}</dd></div>
                <div><dt className="text-zinc-400">{t("paper.avgWinLoss")}</dt><dd className="font-mono tabular-nums">{fmtNum(view.stats.avgWinR)} / {fmtNum(view.stats.avgLossR)}</dd></div>
                <div><dt className="text-zinc-400">{t("paper.expectancy")}</dt><dd className={`font-mono tabular-nums ${pnlClass(view.stats.expectancyR)}`}>{fmtNum(view.stats.expectancyR)}</dd></div>
                <div><dt className="text-zinc-400">{t("paper.netPnl")}</dt><dd className={`font-mono tabular-nums ${pnlClass(view.stats.netPnl)}`}>{fmtSigned(view.stats.netPnl)}</dd></div>
                <div><dt className="text-zinc-400">{t("paper.maxDd")}</dt><dd className="font-mono tabular-nums">{fmtMoney(view.stats.maxDrawdown)} · {fmtPct(view.stats.maxDrawdownPct)}</dd></div>
              </dl>
              <p className="text-[11px] text-zinc-400">{t("paper.gateProgress", { n: view.stats.trades, total: RECONCILE_GATE_TRADES })}</p>
              {annotating && (
                <div className="space-y-2 rounded border border-zinc-800 p-2">
                  <div className="flex items-center justify-between text-xs">
                    <span>{annotating.pair} · {fmtUtc(annotating.closedAt)}</span>
                    <button type="button" onClick={() => setAnnotating(null)}>Close annotation</button>
                  </div>
                  <TradeAnnotation key={annotating.proposalId + ":" + annotating.closedAt} port={port} trade={annotating} />
                </div>
              )}
              {review && (
                <div className="space-y-2 rounded border border-zinc-800 p-2">
                  <div className="flex items-center justify-between text-xs">
                    <span>{review.trade.pair} · {review.trade.src} · {review.trade.tf}</span>
                    <button type="button" onClick={() => setReview(null)}>Close trade replay</button>
                  </div>
                  <ChartReplay key={review.trade.id} candles={review.candles} startAt={review.trade.openedAt} />
                </div>
              )}
              {book.journal.length === 0 ? (
                <p className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-xs text-zinc-400">{t("paper.noJournal")}</p>
              ) : (
                <div className="max-h-72 overflow-auto rounded-lg border border-zinc-800">
                  <table className="w-full min-w-[44rem] text-xs">
                    <thead className="sticky top-0 bg-zinc-950 text-zinc-400">
                      <tr>
                        <th scope="col" className="px-2 py-1.5 text-start">{t("paper.col.closed")}</th>
                        <th scope="col" className="px-2 py-1.5 text-start">{t("paper.col.pair")}</th>
                        <th scope="col" className="px-2 py-1.5 text-start">{t("paper.col.side")}</th>
                        <th scope="col" className="px-2 py-1.5 text-end">{t("paper.col.entry")}</th>
                        <th scope="col" className="px-2 py-1.5 text-end">{t("paper.col.exit")}</th>
                        <th scope="col" className="px-2 py-1.5 text-end">{t("paper.col.fees")}</th>
                        <th scope="col" className="px-2 py-1.5 text-end">{t("paper.col.pnl")}</th>
                        <th scope="col" className="px-2 py-1.5 text-end">R</th>
                        <th scope="col" className="px-2 py-1.5 text-start">{t("paper.col.reason")}</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono tabular-nums">
                      {[...book.journal].reverse().map((j) => (
                        <tr key={j.id} className="border-t border-zinc-800">
                          <td className="px-2 py-1.5">{fmtUtc(j.closedAt)}</td>
                          <th scope="row" className="px-2 py-1.5 text-start font-sans font-medium text-zinc-200">{j.pair} <button type="button" className="underline" onClick={() => void replayTrade(j)}>Replay trade</button> <button type="button" className="underline" onClick={() => setAnnotating(j)}>Annotate</button></th>
                          <td className="px-2 py-1.5 font-sans">{j.side === "long" ? t("paper.long") : t("paper.short")}</td>
                          <td className="px-2 py-1.5 text-end">{fmtPx(j.entry)}</td>
                          <td className="px-2 py-1.5 text-end">{fmtPx(j.exit)}</td>
                          <td className="px-2 py-1.5 text-end">{fmtMoney(j.fees + j.funding)}</td>
                          <td className={`px-2 py-1.5 text-end ${pnlClass(j.pnl)}`}>{fmtSigned(j.pnl)}</td>
                          <td className={`px-2 py-1.5 text-end ${pnlClass(j.r)}`}>{fmtNum(j.r)}</td>
                          <td className="px-2 py-1.5 font-sans">{t(EXIT_REASON_KEYS[j.reason] ?? `paper.reason.${j.reason}`)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* ---------- Settings ---------- */}
            <section aria-labelledby="paper-settings" className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
              <h3 id="paper-settings" className="mb-2 text-sm font-semibold text-zinc-200">{t("paper.settings")}</h3>
              <form
                className="space-y-3"
                noValidate
                onSubmit={(e) => { e.preventDefault(); saveSettings(); }}
              >
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {!book.positions.length && !book.journal.length && (
                    <label className="flex flex-col gap-1 text-xs text-zinc-300" htmlFor="paper-startingEquity">
                      {t("paper.set.startingEquity")}
                      <input
                        id="paper-startingEquity"
                        inputMode="decimal"
                        value={equityDraft}
                        onChange={(e) => setEquityDraft(e.target.value)}
                        aria-invalid={settingErrors.includes("startingEquity")}
                        className="h-8 rounded-md border border-zinc-700 bg-zinc-900 px-2 font-mono text-zinc-100 aria-[invalid=true]:border-rose-500"
                      />
                    </label>
                  )}
                  {NUMERIC_KEYS.map((k) => (
                    <label key={k} className="flex flex-col gap-1 text-xs text-zinc-300" htmlFor={`paper-${k}`}>
                      {t(`paper.set.${k}`)}
                      <input
                        id={`paper-${k}`}
                        inputMode="decimal"
                        value={draft[k] ?? ""}
                        onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                        aria-invalid={settingErrors.includes(k)}
                        aria-describedby={settingErrors.includes(k) ? `paper-${k}-err` : undefined}
                        className="h-8 rounded-md border border-zinc-700 bg-zinc-900 px-2 font-mono text-zinc-100 aria-[invalid=true]:border-rose-500"
                      />
                      {settingErrors.includes(k) && (
                        <span id={`paper-${k}-err`} className="text-[11px] text-rose-300">
                          {t("paper.range", { s: String(RISK_SETTING_LIMITS[k][0]), k: String(RISK_SETTING_LIMITS[k][1]) })}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
                <div className="flex flex-wrap gap-4 text-xs text-zinc-300">
                  <label className="flex items-center gap-2" htmlFor="paper-timeStopOn">
                    <input
                      id="paper-timeStopOn"
                      type="checkbox"
                      checked={Number(draft.timeStopBars) > 0}
                      onChange={(e) => setDraft((d) => ({ ...d, timeStopBars: String(timeStopToggleBars(e.target.checked)) }))}
                    />
                    {t("paper.set.timeStopOn")}
                  </label>
                  {BOOLEAN_SETTINGS.map((k) => (
                    <label key={k} className="flex items-center gap-2" htmlFor={`paper-${k}`}>
                      <input id={`paper-${k}`} type="checkbox" checked={draftFlags[k]} onChange={(e) => setDraftFlags((f) => ({ ...f, [k]: e.target.checked }))} />
                      {t(`paper.set.${k}`)}
                    </label>
                  ))}
                </div>
                {settingErrors.length > 0 && <p role="alert" className="text-xs text-rose-300">{t("paper.invalid", { list: settingErrors.map((k) => t(`paper.set.${k}`)).join(", ") })}</p>}
                <div className="flex flex-wrap justify-end gap-2">
                  <Button type="button" size="sm" variant="outline" className="h-8 border-zinc-700 text-zinc-300" onClick={() => { syncDraft(book); setSettingErrors([]); }}>
                    {t("paper.revert")}
                  </Button>
                  <Button type="submit" size="sm" className="h-8 bg-cyan-800 text-white hover:bg-cyan-700">{t("paper.save")}</Button>
                </div>
              </form>
            </section>

            {/* ---------- Kill switch ---------- */}
            <section aria-labelledby="paper-kill" className={`rounded-lg border p-3 ${book.account.killSwitch ? "border-rose-500/50 bg-rose-500/5" : "border-zinc-800 bg-zinc-950/40"}`}>
              <h3 id="paper-kill" className="mb-1 flex items-center gap-2 text-sm font-semibold text-zinc-200"><OctagonX className="h-4 w-4 text-rose-400" />{t("paper.lockKill")}</h3>
              <p className="mb-2 text-xs text-zinc-400">{t("paper.killHelp")}</p>
              {!book.account.killSwitch ? (
                <Button size="sm" className="h-8 bg-rose-700 text-white hover:bg-rose-600" onClick={engage}>{t("paper.killEngage")}</Button>
              ) : (
                <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); reset(); }}>
                  <label className="flex flex-col gap-1 text-xs text-zinc-300" htmlFor="paper-kill-confirm">
                    {t("paper.killConfirm", { name: KILL_RESET_WORD })}
                    <input
                      id="paper-kill-confirm"
                      autoComplete="off"
                      value={killText}
                      onChange={(e) => { setKillText(e.target.value); setKillError(false); }}
                      aria-invalid={killError}
                      className="h-8 w-40 rounded-md border border-zinc-700 bg-zinc-900 px-2 font-mono text-zinc-100 aria-[invalid=true]:border-rose-500"
                    />
                  </label>
                  <Button type="submit" size="sm" variant="outline" className="h-8 border-zinc-700 text-zinc-300">{t("paper.killReset")}</Button>
                  {killError && <p role="alert" className="w-full text-xs text-rose-300">{t("paper.killMismatch", { name: KILL_RESET_WORD })}</p>}
                </form>
              )}
            </section>

            {/* ---------- Drawdown lock (v2.8) ---------- */}
            {book.account.drawdownLocked && (() => {
              const waiting = waitingSeries(book).join(", ");
              return (
              <section aria-labelledby="paper-dd" className="rounded-lg border border-rose-500/50 bg-rose-500/5 p-3">
                <h3 id="paper-dd" className="mb-1 flex items-center gap-2 text-sm font-semibold text-zinc-200"><OctagonX className="h-4 w-4 text-rose-400" />{t("paper.lockDrawdown")}</h3>
                <p className="mb-2 text-xs text-zinc-400">{t("paper.drawdownHelp", { pct: book.account.settings.maxDrawdownLockPct })}</p>
                {waiting && (
                  <p role="status" className="mb-2 text-xs text-amber-300">{t("paper.drawdownWaiting", { series: waiting })}</p>
                )}
                <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); resetDd(); }}>
                  <label className="flex flex-col gap-1 text-xs text-zinc-300" htmlFor="paper-dd-confirm">
                    {t("paper.drawdownConfirm", { name: KILL_RESET_WORD })}
                    <input
                      id="paper-dd-confirm"
                      autoComplete="off"
                      value={ddText}
                      onChange={(e) => { setDdText(e.target.value); setDdError(false); }}
                      aria-invalid={ddError}
                      className="h-8 w-40 rounded-md border border-zinc-700 bg-zinc-900 px-2 font-mono text-zinc-100 aria-[invalid=true]:border-rose-500"
                    />
                  </label>
                  <Button type="submit" size="sm" variant="outline" disabled={waiting !== ""} className="h-8 border-zinc-700 text-zinc-300">{waiting ? t("paper.drawdownResetWaiting", { series: waiting }) : t("paper.drawdownReset")}</Button>
                  {ddError && <p role="alert" className="w-full text-xs text-rose-300">{t("paper.drawdownMismatch", { name: KILL_RESET_WORD })}</p>}
                </form>
              </section>
              );
            })()}
          </div>
        )}

        <p className="text-[11px] text-zinc-400">{t("paper.notAdvice")}</p>
      </DialogContent>
    </Dialog>
  );
}
