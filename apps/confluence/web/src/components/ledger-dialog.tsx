"use client";
/**
 * ledger-dialog.tsx — v2.3 "Signal ledger" (forward-test performance).
 *
 * v2.3: primary statistics on full-window rows (1,000 bars) with a toggle;
 * per-pair measured slippage + per-class costs; stored outcome snapshots (a
 * delisted pair keeps its measured outcomes); Wilson / bootstrap intervals;
 * BTC-excess; momentum and label-shuffle benchmarks; a trials register that
 * feeds the deflated Sharpe; pre-registration with a 90-day minimum and a
 * fixed decision date; storage durability and a weekly export reminder.
 *
 * Measures every recorded signal for the current source × timeframe against
 * what happened next: next-bar-open entry, horizon-h close exit, fees +
 * slippage (+ funding on perps). Reports hit rate vs the unconditional base
 * rate, net expectancy, score calibration, cross-sectional rank IC and the
 * probabilistic Sharpe ratio, with an indicative go/no-go check.
 */
import { baseOf as pairBase, splitPair } from "@/lib/quotes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, Download, Loader2, Lock, ShieldCheck, Trash2, Upload } from "lucide-react";
import { exportFileName, toCSV } from "@rsl/core-kit/core/rsl-export.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useRsl } from "@/rsl/RslContext";
import { APP } from "@/rsl/app-info";
import type { Kline } from "@/lib/indicators";
import type { LedgerStore, PreRegistration } from "@/lib/signal-ledger";
import { buildReportAsync } from "@/lib/report-runner";
import {
  confirmatoryTrials,
  costsFor,
  engineBarsOf,
  DEFAULT_HORIZONS,
  LEDGER_CSV_COLUMNS,
  ledgerRowValues,
  hasFundTrendBench,
  measureOutcome,
  outcomeFromSnapshot,
  parseLedgerImport,
  PRIMARY_WARM_BARS,
  toSnapshot,
  type AssetClass,
  type CostModel,
  type LedgerReport,
  type LedgerRow,
  type Outcome,
  type OutcomeSnapshot,
  WARM_MIN_BARS,
  isSpotSellGroup,
} from "@/lib/ledger-metrics";
import { loadHistoricalSeries, mergeKlines, saveHistoricalSeries } from "@/lib/history-store";
import { fetchHistory, INTERVAL_MS, RateLimitError, type DataSource } from "@/lib/market-client";
import { engineConfigId } from "@/lib/engine-config";


interface Props {
  open: boolean;
  configId?: string;
  onOpenChange: (open: boolean) => void;
  store: LedgerStore | null;
  source: DataSource;
  timeframe: string;
  /** Current asset-class view ("all" = every class). Engines and classes are never pooled. */
  assetClass: string;
  /** Newest in-memory candles per pair (fresher than the history cache), read on demand. */
  getLiveKlines: () => Record<string, Kline[]>;
}

const fmtBps = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}` : "—");
const fmtPct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "—");
const fmtNum = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—");

export function LedgerDialog({ open, onOpenChange, store, source, timeframe, assetClass, getLiveKlines, configId = engineConfigId() }: Props) {
  const { t, id, platform, audit, announce } = useRsl();
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [report, setReport] = useState<LedgerReport | null>(null);
  /** v2.3 (review C3): the confirmatory report — only rows recorded after the pre-registration, in its scope. */
  const [confirm, setConfirm] = useState<LedgerReport | null>(null);
  const [gapCount, setGapCount] = useState(0);
  const [refetched, setRefetched] = useState(0);
  const [busy, setBusy] = useState(false);
  const [horizon, setHorizon] = useState(6);
  const [confirmClear, setConfirmClear] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [otherEngines, setOtherEngines] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  /** v2.3: primary = full engine window only; "warm" = ≥ 300 bars (more rows, some warm-up bias). */
  const [windowMode, setWindowMode] = useState<"full" | "warm">("full");
  const [trialCount, setTrialCount] = useState(1);
  const [confTrialCount, setConfTrialCount] = useState(1);
  const [prereg, setPrereg] = useState<PreRegistration | null>(null);
  const [durable, setDurable] = useState<boolean | null>(null);
  const [lastExport, setLastExport] = useState(0);
  const [snapCount, setSnapCount] = useState(0);
  const [measuredSlip, setMeasuredSlip] = useState(0);
  /** Generation guard: only the newest measurement may update state. */
  const generation = useRef(0);
  const viewClass: AssetClass = assetClass === "all" ? "crypto" : (assetClass as AssetClass);
  const costs = costsFor(source, viewClass);
  const costBps = 2 * (costs.feeBps + costs.slipBps);
  const intervalMs = INTERVAL_MS[timeframe] ?? INTERVAL_MS["4h"];
  const minBars = windowMode === "full" ? PRIMARY_WARM_BARS : WARM_MIN_BARS;

  const measure = useCallback(async () => {
    if (!store) return;
    const gen = ++generation.current;
    setBusy(true);
    setMessage(null);
    setFailure(null);
    try {
      const liveKlines = getLiveKlines();
      const cfg = configId;
      const scope = (await store.all()).filter((r) => r.src === source && r.tf === timeframe && (assetClass === "all" || r.ac === assetClass));
      // Rows scored by a different engine are kept but never pooled into these statistics.
      const all = scope.filter((r) => r.cfg === cfg);
      setOtherEngines(scope.length - all.length);
      if (gen !== generation.current) return;
      setRows(all);
      // Research hygiene: every variant looked at is registered — the report
      // shows all horizons at once, so each horizon is a trial; the count over
      // ALL engines feeds the deflated Sharpe ratio (review C4).
      for (const h of DEFAULT_HORIZONS) await store.registerTrial(cfg, `${source}|${timeframe}|${assetClass}|${windowMode}|h${h}`);
      // Bars printed while the underlying market was shut (synthetic weekend /
      // overnight prices) are kept in the ledger but not pooled into statistics.
      // The window rule uses the bars the engine really saw (stocks: session bars).
      const usable = all.filter((r) => engineBarsOf(r) >= minBars && !r.uc);
      const scopeKey = { cfg, source, tf: timeframe, assetClass };
      const [trialList, pre, snaps, slip, exported, gapMap, preregs] = await Promise.all([
        store.trials(), store.preregistration(scopeKey), store.outcomes(usable), store.slippage(source), store.lastExport(), store.gaps(source, timeframe),
        store.preregistrations(),
      ]);
      const trials = Math.max(1, trialList.length);
      // v2.8 (WP19): the confirmatory report deflates by the active pre-registered hypotheses only.
      const confTrials = confirmatoryTrials(preregs, cfg);
      const byPair = new Map<string, LedgerRow[]>();
      usable.forEach((r) => { const l = byPair.get(r.pair); if (l) l.push(r); else byPair.set(r.pair, [r]); });
      const outcomes = new Map<number, Outcome[]>(DEFAULT_HORIZONS.map((h) => [h, []]));
      const klinesOf = async (pair: string) => {
        let saved: Kline[] = [];
        try { saved = await loadHistoricalSeries(source, timeframe, pair); } catch { /* cache unavailable */ }
        return mergeKlines(saved, liveKlines[pair]);
      };
      // v2.3 (review C14): a pair that left the scan before its horizons closed
      // gets its missing bars fetched once (public history, ≤ 10 pairs per open).
      const now = Date.now();
      const maxH = Math.max(...DEFAULT_HORIZONS);
      let refetchedPairs = 0;
      const ensureBars = async (pair: string, k: Kline[], list: LedgerRow[]) => {
        const newest = k.length ? k[k.length - 1].time : 0;
        const needs = list.some((r) => r.t + (maxH + 1) * intervalMs <= now && r.t + (maxH + 1) * intervalMs > newest && !snaps.get(r.id)?.[maxH]);
        if (!needs || refetchedPairs >= 10) return k;
        try {
          const oldest = Math.min(...list.map((r) => r.t));
          const bars = Math.min(5_000, Math.ceil((now - oldest) / intervalMs) + 30);
          const h = await fetchHistory(source, pair, timeframe, bars);
          refetchedPairs++;
          if (h.klines.length) {
            void saveHistoricalSeries(source, timeframe, pair, h.klines).catch(() => undefined);
            return mergeKlines(k, h.klines);
          }
        } catch (error) {
          if (error instanceof RateLimitError) refetchedPairs = 10; // stop fetching for this open
        }
        return k;
      };
      // v2.7 (review #8): this ledger's own BTC pair (BTCPHP on Coins.ph, BTCUSDC in a USDC scan…).
      const btcPair = byPair.has("BTCUSDT") ? "BTCUSDT" : [...byPair.keys()].find((p) => pairBase(p, source) === "BTC") ?? (source === "coinsph" ? "BTCPHP" : "BTCUSDT");
      const btc = await klinesOf(btcPair);
      const momentumSign = new Map<string, -1 | 0 | 1>();
      const fresh = new Map<string, Record<string, OutcomeSnapshot>>();
      let fromSnapshots = 0;
      for (const [pair, list] of byPair) {
        const k = await ensureBars(pair, await klinesOf(pair), list);
        const at = new Map(k.map((b, i) => [b.time, i]));
        for (const row of list) {
          // Per-pair measured slippage (order-book depth) replaces the default when known.
          const c: CostModel = costsFor(source, row.ac, slip[pair]?.bps, splitPair(pair, source).quote);
          const i = at.get(row.t);
          if (i !== undefined && i >= 20) {
            const ret = k[i].close / k[i - 20].close - 1;
            momentumSign.set(row.id, ret > 0 ? 1 : ret < 0 ? -1 : 0);
          }
          const stored = snaps.get(row.id) ?? {};
          for (const h of DEFAULT_HORIZONS) {
            let o = measureOutcome(row, k, h, c, intervalMs);
            if (o) {
              if (!stored[h]) (fresh.get(row.id) ?? fresh.set(row.id, {}).get(row.id)!)[h] = toSnapshot(o);
            } else if (stored[h]) {
              // History no longer served (delisting, cache cleared): use the stored outcome.
              o = outcomeFromSnapshot(row, h, stored[h], c);
              fromSnapshots++;
            }
            if (!o) continue;
            if (pair !== btcPair && btc.length) {
              const b = measureOutcome({ ...row, pair: btcPair, m: 1 }, btc, h, c, intervalMs);
              if (b) o.btcGross = b.gross;
            }
            outcomes.get(h)!.push(o);
          }
        }
      }
      if (fresh.size) void store.saveOutcomes(usable, fresh).catch(() => undefined);
      let persisted: boolean | null = null;
      try { persisted = (await navigator.storage?.persisted?.()) ?? null; } catch { persisted = null; }
      if (gen !== generation.current) return;
      setTrialCount(trials);
      setConfTrialCount(confTrials);
      setPrereg(pre);
      setSnapCount(fromSnapshots);
      setMeasuredSlip(Object.keys(slip).length);
      setLastExport(exported);
      setDurable(store.kind === "sqlite" ? true : persisted);
      setGapCount(Object.values(gapMap).reduce((a, g) => a + g.length, 0));
      setRefetched(refetchedPairs);
      const full = await buildReportAsync({ rows: usable, outcomes, costBps, trials, intervalMs, momentum: momentumSign });
      // Confirmatory evidence: only rows recorded after the hypothesis was fixed,
      // in the registered window mode (review C3).
      let conf: LedgerReport | null = null;
      if (pre && pre.windowMode === windowMode) {
        const after = usable.filter((r) => r.rec >= pre.startedAt);
        const ids = new Set(after.map((r) => r.id));
        const confOut = new Map([...outcomes].map(([h, list]) => [h, list.filter((o) => ids.has(o.row.id))]));
        conf = await buildReportAsync({ rows: after, outcomes: confOut, costBps, trials: confTrials, intervalMs, momentum: momentumSign });
      }
      if (gen !== generation.current) return;
      setReport(full);
      setConfirm(conf);
    } catch (error) {
      if (gen === generation.current) setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      if (gen === generation.current) setBusy(false);
    }
  }, [store, configId, source, timeframe, assetClass, getLiveKlines, costBps, intervalMs, windowMode, minBars]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void measure(), 0);
    return () => window.clearTimeout(timer);
  }, [open, measure]);

  const current = useMemo(() => report?.horizons.find((h) => h.horizon === horizon) ?? null, [report, horizon]);

  // Indicative pre-registered check (docs/measurement.md). Not a trading recommendation.
  // With a pre-registration in this view, the gate reads the CONFIRMATORY report
  // (rows recorded after it); otherwise the exploratory one, which can never pass.
  const preregInView = !!prereg && prereg.windowMode === windowMode;
  const gateHorizon = useMemo(() => (preregInView && confirm ? confirm.horizons.find((h) => h.horizon === horizon) ?? null : current), [preregInView, confirm, current, horizon]);
  const gate = useMemo(() => {
    const cur = gateHorizon;
    if (!cur) return null;
    const dirGroups = cur.groups.filter((g) => g.label.endsWith("all"));
    const n = dirGroups.reduce((a, g) => a + g.n, 0);
    const edge = dirGroups.length ? dirGroups.reduce((a, g) => a + g.edgeBps * g.n, 0) / Math.max(1, n) : NaN;
    const sigCost = dirGroups.length ? dirGroups.reduce((a, g) => a + g.costBps * g.n, 0) / Math.max(1, n) : costBps;
    const mom = cur.benchmarks.momentum;
    const now = Date.now();
    const current = cur;
    const checks = [
      { key: "ledger.gateN", ok: n >= 200, value: String(n) },
      { key: "ledger.gateEdge", ok: Number.isFinite(edge) && edge > 0, value: fmtBps(edge) },
      // Robustness: still positive if the costs these signals actually paid were doubled.
      { key: "ledger.gate2x", ok: Number.isFinite(edge) && edge - sigCost > 0, value: fmtBps(edge - sigCost) },
      { key: "ledger.gateIc", ok: current.ic.tStat >= 2, value: fmtNum(current.ic.tStat) },
      { key: "ledger.gatePsr", ok: current.sharpe.psr >= 0.95, value: fmtNum(current.sharpe.psr) },
      // v2.3: the deflated Sharpe accounts for every variant looked at.
      // v2.8 (WP19): the confirmatory DSR counts active pre-registrations; the exploratory one every view.
      { key: "ledger.gateDsr", ok: current.sharpe.dsr >= 0.95, value: `${fmtNum(current.sharpe.dsr)} · ${preregInView && confirm ? confTrialCount : trialCount}` },
      { key: "ledger.gateShuffle", ok: current.benchmarks.shuffledP <= 0.05, value: fmtNum(current.benchmarks.shuffledP, 3) },
      { key: "ledger.gateMomentum", ok: !!mom && Number.isFinite(edge) && edge > mom.edgeBps, value: mom ? fmtBps(mom.edgeBps) : "—" },
      {
        key: "ledger.gatePrereg",
        ok: preregInView && !!prereg && prereg.horizon === horizon && now >= prereg.decisionDate,
        value: prereg ? new Date(prereg.decisionDate).toISOString().slice(0, 10) : "—",
      },
    ];
    return { checks, pass: checks.every((c) => c.ok) };
  }, [gateHorizon, costBps, trialCount, confTrialCount, confirm, prereg, horizon, preregInView]);

  const preregister = async () => {
    if (!store) return;
    const cfg = configId;
    const p = await store.preregister({
      cfg,
      source,
      tf: timeframe,
      assetClass,
      windowMode,
      horizon,
      hypothesis: `Master signal net edge > 0 and rank IC t ≥ 2 at h=${horizon} on ${source}·${timeframe}·${assetClass} (engine ${cfg}).`,
    });
    setPrereg(p);
    await audit.append({ actorId: id.operator.id || "local", event: "ledger.preregister", record: "ledger", reason: p.hypothesis });
  };

  const requestDurable = async () => {
    try { setDurable((await navigator.storage?.persist?.()) ?? false); } catch { setDurable(false); }
  };

  const exportCsv = async () => {
    if (!rows?.length) return;
    const outByRow = new Map<string, Record<number, number>>();
    for (const [pair, list] of Object.entries(groupBy(rows, (r) => r.pair))) {
      let saved: Kline[] = [];
      try { saved = await loadHistoricalSeries(source, timeframe, pair); } catch { /* ignore */ }
      const k = mergeKlines(saved, getLiveKlines()[pair]);
      for (const row of list) {
        const rec: Record<number, number> = {};
        const c = costsFor(source, row.ac, undefined, splitPair(pair, source).quote);
        for (const h of DEFAULT_HORIZONS) { const o = measureOutcome(row, k, h, c, intervalMs); if (o) rec[h] = o.net; }
        outByRow.set(row.id, rec);
      }
    }
    const headers = [...LEDGER_CSV_COLUMNS, ...DEFAULT_HORIZONS.map((h) => `net_return_h${h}`)];
    const data = rows.map((r) => [...ledgerRowValues(r), ...DEFAULT_HORIZONS.map((h) => outByRow.get(r.id)?.[h] ?? "")]);
    const csv = toCSV(data, { headers, columns: headers });
    const name = exportFileName({ app: "ConfluenceTerminal", customerCode: id.customer.code, docId: `ledger-${source}-${timeframe}`, ext: "csv" });
    const res = await platform.saveOrShare(new TextEncoder().encode(csv), name, "text/csv");
    if (res.ok) {
      await store?.markExported();
      setLastExport(Date.now());
      await audit.append({ actorId: id.operator.id || "local", event: "ledger.export", record: "ledger", reason: `${rows.length} rows · ${name}` });
      setMessage(t("ledger.exported", { n: rows.length }));
      announce(t("ledger.exported", { n: rows.length }));
    }
  };

  const exportJson = async () => {
    if (!rows?.length) return;
    const body = JSON.stringify({ format: "rsl-signal-ledger", version: 1, app: APP.version, configId: configId, source, timeframe, costs, rows }, null, 1);
    const name = exportFileName({ app: "ConfluenceTerminal", customerCode: id.customer.code, docId: `ledger-${source}-${timeframe}`, ext: "json" });
    const res = await platform.saveOrShare(new TextEncoder().encode(body), name, "application/json");
    if (res.ok) {
      await store?.markExported();
      setLastExport(Date.now());
      await audit.append({ actorId: id.operator.id || "local", event: "ledger.export", record: "ledger", reason: `${rows.length} rows · ${name}` });
      setMessage(t("ledger.exported", { n: rows.length }));
    }
  };

  /** v2.3: import the headless recorder's ledger (JSONL) or a JSON export; v2.8: or a ledger CSV. Rows are validated; duplicates are ignored. */
  const importLedger = async () => {
    if (!store) return;
    try {
      const f = await platform.openFile({ accept: [".jsonl", ".json", ".csv"], maxBytes: 200 * 1024 * 1024 });
      if (!f) return;
      const { rows: incoming, rejected } = parseLedgerImport(new TextDecoder().decode(f.bytes));
      let added = 0;
      for (let i = 0; i < incoming.length; i += 5_000) added += await store.record(incoming.slice(i, i + 5_000));
      await audit.append({ actorId: id.operator.id || "local", event: "ledger.import", record: "ledger", reason: `${f.name}: ${added} added, ${incoming.length - added} duplicates, ${rejected} rejected` });
      const msg = t("ledger.imported", { n: added, k: rejected });
      setMessage(msg);
      announce(msg);
      await measure();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  };

  const clear = async () => {
    if (!store) return;
    const before = (await store.stats()).rows;
    await store.clear();
    await audit.append({ actorId: id.operator.id || "local", event: "ledger.clear", record: "ledger", reason: `${before} rows deleted` });
    setConfirmClear(false);
    await measure();
  };

  const excludedCold = rows ? rows.filter((r) => r.wb < minBars).length : 0;
  const excludedClosed = rows ? rows.filter((r) => r.wb >= minBars && r.uc).length : 0;
  const exportAgeDays = lastExport ? Math.floor((Date.now() - lastExport) / 86_400_000) : null;
  const exportDue = !!rows?.length && (exportAgeDays === null || exportAgeDays >= 7);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(100vw-1.5rem,52rem)] max-w-[min(100vw-1.5rem,52rem)] max-h-[92dvh] overflow-y-auto overflow-x-hidden border-zinc-800 bg-zinc-900 p-4 text-zinc-100 sm:p-5">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-5 w-5 text-cyan-400" />
            {t("ledger.title")}
          </DialogTitle>
          <DialogDescription className="text-xs text-zinc-400">{t("ledger.intro")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
          <span className="rounded border border-zinc-700 px-2 py-0.5 font-mono">{source} · {timeframe}</span>
          <span className="rounded border border-zinc-700 px-2 py-0.5 font-mono" title={t("ledger.configHelp")}>{t("ledger.config", { id: configId })}</span>
          {rows && <span>{t("ledger.rows", { n: rows.length })}</span>}
          {excludedCold > 0 && <span className="text-amber-300">{t("ledger.cold", { n: excludedCold, bars: minBars })}</span>}
          {otherEngines > 0 && <span className="text-zinc-400">{t("ledger.otherEngines", { n: otherEngines })}</span>}
          {excludedClosed > 0 && <span className="text-zinc-400">{t("ledger.closedExcluded", { n: excludedClosed })}</span>}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-zinc-400">{t("ledger.window")}</span>
          <RadioPills
            label={t("ledger.window")}
            value={windowMode}
            options={(["full", "warm"] as const).map((m) => ({ value: m, label: m === "full" ? t("ledger.windowFull", { bars: PRIMARY_WARM_BARS }) : t("ledger.windowWarm", { bars: WARM_MIN_BARS }) }))}
            onChange={setWindowMode}
          />
          <span className="font-mono text-zinc-400">{t("ledger.trials", { n: trialCount })}</span>
          {snapCount > 0 && <span className="text-zinc-400">{t("ledger.snapshots", { n: snapCount })}</span>}
          {measuredSlip > 0 && <span className="text-zinc-400">{t("ledger.measuredSlip", { n: measuredSlip })}</span>}
          {gapCount > 0 && <span className="text-amber-300">{t("ledger.gaps", { n: gapCount })}</span>}
          {refetched > 0 && <span className="text-zinc-400">{t("ledger.refetched", { n: refetched })}</span>}
          {preregInView && confirm && <span className="text-cyan-300">{t("ledger.confirmatory", { n: confirm.rows })}</span>}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          {durable === true && <span className="inline-flex items-center gap-1 text-emerald-300"><ShieldCheck className="h-3.5 w-3.5" />{t("ledger.storageDurable")}</span>}
          {durable !== true && (
            <>
              <span className="text-amber-300">{t("ledger.storageBestEffort")}</span>
              <Button size="sm" variant="outline" className="h-8 border-zinc-700 text-zinc-300" onClick={() => void requestDurable()}>{t("ledger.persistBtn")}</Button>
            </>
          )}
          {exportDue && (
            <span role="status" className="text-amber-300">
              {exportAgeDays === null ? t("ledger.exportNever") : t("ledger.exportDue", { days: exportAgeDays })}
            </span>
          )}
        </div>

        {failure && <p role="alert" className="text-xs text-rose-300">{t("about.failed", { reason: failure })}</p>}

        {busy && (
          <div className="flex items-center gap-2 py-6 text-sm text-zinc-400"><Loader2 className="h-4 w-4 animate-spin" />{t("ledger.loading")}</div>
        )}

        {!busy && rows && rows.length === 0 && (
          <p className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 text-sm text-zinc-400">{t("ledger.empty")}</p>
        )}

        {!busy && report && rows && rows.length > 0 && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-zinc-400">{t("ledger.horizon")}</span>
              <RadioPills
                label={t("ledger.horizon")}
                value={horizon}
                options={DEFAULT_HORIZONS.map((h) => ({ value: h, label: t("ledger.bars", { n: h }) }))}
                onChange={setHorizon}
              />
            </div>

            {current && current.groups.length === 0 && <p className="text-sm text-zinc-400">{t("ledger.pending")}</p>}

            {current && current.groups.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-zinc-800">
                <table className="w-full min-w-[34rem] text-xs">
                  <thead className="bg-zinc-950 text-zinc-400">
                    <tr>
                      <th scope="col" className="px-2 py-1.5 text-start">{t("ledger.group")}</th>
                      <th scope="col" className="px-2 py-1.5 text-end">n</th>
                      <th scope="col" className="px-2 py-1.5 text-end">{t("ledger.hit")}</th>
                      <th scope="col" className="px-2 py-1.5 text-end">{t("ledger.base")}</th>
                      <th scope="col" className="px-2 py-1.5 text-end">{t("ledger.mean")}</th>
                      <th scope="col" className="px-2 py-1.5 text-end">{t("ledger.ci")}</th>
                      <th scope="col" className="px-2 py-1.5 text-end">{t("ledger.edge")}</th>
                      <th scope="col" className="px-2 py-1.5 text-end">{t("ledger.pf")}</th>
                      <th scope="col" className="px-2 py-1.5 text-end">t</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono tabular-nums">
                    {current.groups.map((g) => (
                      <tr key={g.label} className="border-t border-zinc-800">
                        <th scope="row" className="px-2 py-1.5 text-start font-sans font-medium text-zinc-200">{isSpotSellGroup(g.label, source) ? `${g.label} (${t("ledger.longAvoided")})` : g.label}</th>
                        <td className="px-2 py-1.5 text-end">{g.n}</td>
                        <td className="px-2 py-1.5 text-end">{fmtPct(g.hitRate)}</td>
                        <td className="px-2 py-1.5 text-end text-zinc-400">{fmtPct(g.baseHitRate)}</td>
                        <td className={`px-2 py-1.5 text-end ${g.meanNetBps > 0 ? "text-emerald-400" : "text-rose-400"}`}>{fmtBps(g.meanNetBps)}</td>
                        <td className="px-2 py-1.5 text-end text-zinc-400">
                          <span className="block">{fmtBps(g.meanCi[0])}…{fmtBps(g.meanCi[1])}</span>
                          <span className="block text-[10px]">{t("ledger.hit")} {fmtPct(g.hitCi[0])}–{fmtPct(g.hitCi[1])}</span>
                        </td>
                        <td className={`px-2 py-1.5 text-end ${g.edgeBps > 0 ? "text-emerald-400" : "text-rose-400"}`}>{fmtBps(g.edgeBps)}</td>
                        <td className="px-2 py-1.5 text-end">{fmtNum(g.profitFactor)}</td>
                        <td className="px-2 py-1.5 text-end">{fmtNum(g.tStat)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {current && (
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-xs">
                  <div className="mb-1 font-semibold text-zinc-200">{t("ledger.ic")}</div>
                  <div className="font-mono tabular-nums text-zinc-300">
                    IC {fmtNum(current.ic.mean, 3)} · t {fmtNum(current.ic.tStat)} · {t("ledger.periods", { n: current.ic.periods })}
                  </div>
                  <div className="mt-1 font-mono tabular-nums text-zinc-300">
                    {t("ledger.psr")} {fmtNum(current.sharpe.psr)} · {t("ledger.dsr")} {fmtNum(current.sharpe.dsr)} · SR {fmtNum(current.sharpe.sr, 3)}
                  </div>
                  {/* v2.8 (WP19) power readout: days needed at the current Sharpe for PSR 0.95. */}
                  {(current.power.totalDays !== null || current.sharpe.sr <= 0) && (
                    <div className="mt-1 font-mono tabular-nums text-zinc-400" data-testid="ledger-power">
                      {current.power.totalDays !== null && current.power.remainingDays !== null
                        ? t("ledger.power", { days: current.power.totalDays, remaining: current.power.remainingDays })
                        : t("ledger.powerNever")}
                    </div>
                  )}
                  <div className="mt-2 mb-1 font-semibold text-zinc-200">{t("ledger.benchmarks")}</div>
                  <div className="font-mono tabular-nums text-zinc-300">
                    {t("ledger.benchMomentum")} {current.benchmarks.momentum && current.benchmarks.momentum.n > 0 ? `${fmtBps(current.benchmarks.momentum.edgeBps)} bp · n ${current.benchmarks.momentum.n}` : "—"}
                  </div>
                  {hasFundTrendBench(current.benchmarks.fundTrend) && (
                    <div className="font-mono tabular-nums text-zinc-300" data-testid="ledger-bench-fundtrend">
                      {t("ledger.bench.fundTrend")} {fmtBps(current.benchmarks.fundTrend.edgeBps)} bp · n {current.benchmarks.fundTrend.n}
                    </div>
                  )}
                  <div className="font-mono tabular-nums text-zinc-300">
                    {t("ledger.benchShuffle")} p {fmtNum(current.benchmarks.shuffledP, 3)}
                  </div>
                  <div className="font-mono tabular-nums text-zinc-300">
                    {t("ledger.excessBtc")} {fmtBps(current.groups.find((g) => g.label === "BUY · all")?.excessBtcBps ?? NaN)} / {fmtBps(current.groups.find((g) => g.label === "SELL · all")?.excessBtcBps ?? NaN)} bp
                  </div>
                  <div className="font-mono tabular-nums text-zinc-300">
                    {t("ledger.excessXs")} {fmtBps(current.groups.find((g) => g.label === "BUY · all")?.excessXsBps ?? NaN)} / {fmtBps(current.groups.find((g) => g.label === "SELL · all")?.excessXsBps ?? NaN)} bp
                  </div>
                </div>
                {gate && (
                  <div className={`rounded-lg border p-3 text-xs ${gate.pass ? "border-emerald-500/40 bg-emerald-500/5" : "border-amber-500/40 bg-amber-500/5"}`}>
                    <div className="mb-1 font-semibold text-zinc-200">{gate.pass ? t("ledger.gatePass") : t("ledger.gateFail")}</div>
                    <ul className="space-y-0.5">
                      {gate.checks.map((c) => (
                        <li key={c.key} className="flex justify-between gap-2">
                          <span><span aria-hidden="true">{c.ok ? "✓" : "✗"}</span><span className="sr-only">{c.ok ? t("ledger.checkOk") : t("ledger.checkFail")}: </span> {t(c.key)}</span>
                          <span className="font-mono tabular-nums">{c.value}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {current && (
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-xs">
                <div className="mb-1 font-semibold text-zinc-200">{t("ledger.calibration")}</div>
                <div className="grid grid-cols-7 gap-1 text-center font-mono tabular-nums">
                  {current.calibration.map((b) => (
                    <div key={b.bucket} className="rounded bg-zinc-900 px-1 py-1">
                      <div className="text-[10px] text-zinc-400">{b.bucket}</div>
                      <div className={b.meanGrossBps > 0 ? "text-emerald-400" : b.meanGrossBps < 0 ? "text-rose-400" : "text-zinc-400"}>{fmtBps(b.meanGrossBps)}</div>
                      <div className="text-[10px] text-zinc-400">n {b.n}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-xs">
          <div className="mb-1 flex items-center gap-1 font-semibold text-zinc-200"><Lock className="h-3.5 w-3.5" />{t("ledger.prereg")}</div>
          {prereg ? (
            <p className="text-zinc-300">
              {t("ledger.preregStatus", { date: new Date(prereg.decisionDate).toISOString().slice(0, 10), h: prereg.horizon })}
              <span className="mt-1 block font-mono text-[11px] text-zinc-400">{prereg.hypothesis}</span>
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-zinc-400">{t("ledger.preregHelp", { days: 90 })}</span>
              <Button size="sm" variant="outline" className="h-8 border-zinc-700 text-zinc-300" disabled={!rows?.length} onClick={() => void preregister()}>
                {t("ledger.preregBtn", { h: horizon })}
              </Button>
            </div>
          )}
        </div>

        <p className="text-[11px] text-zinc-400">
          {t("ledger.costs", { fee: costs.feeBps, slip: costs.slipBps, funding: costs.fundingBpsPer8h })} {t("ledger.notAdvice")}
        </p>
        {message && <p role="status" className="text-xs text-emerald-300">{message}</p>}

        <div className="flex flex-wrap justify-end gap-2">
          {confirmClear ? (
            <div role="alertdialog" aria-label={t("ledger.clear")} className="flex flex-wrap items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/5 px-3 py-2 text-xs">
              <span>{t("ledger.clearConfirm")}</span>
              <Button autoFocus size="sm" variant="outline" className="h-8 border-zinc-700" onClick={() => setConfirmClear(false)}>{t("about.close")}</Button>
              <Button size="sm" className="h-8 bg-rose-700 text-white hover:bg-rose-600" onClick={() => void clear()}>{t("ledger.clear")}</Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" className="h-8 border-zinc-700 text-zinc-300" disabled={!rows?.length} onClick={() => setConfirmClear(true)}>
              <Trash2 className="h-3.5 w-3.5" />{t("ledger.clear")}
            </Button>
          )}
          <Button size="sm" variant="outline" className="h-8 border-zinc-700 text-zinc-300" disabled={!store} onClick={() => void importLedger()}>
            <Upload className="h-3.5 w-3.5" />{t("ledger.import")}
          </Button>
          <Button size="sm" variant="outline" className="h-8 border-zinc-700 text-zinc-300" disabled={!rows?.length} onClick={() => void exportJson()}>
            <Download className="h-3.5 w-3.5" />{t("ledger.exportJson")}
          </Button>
          <Button size="sm" className="h-8 bg-cyan-800 text-white hover:bg-cyan-700" disabled={!rows?.length} onClick={() => void exportCsv()}>
            <Download className="h-3.5 w-3.5" />{t("ledger.export")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Radio pills with roving tab index and arrow-key navigation (WAI-ARIA radio group pattern). */
function RadioPills<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (from: number, delta: number) => {
    const next = (from + delta + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
      {options.map((o, i) => (
        <button
          key={String(o.value)}
          ref={(el) => { refs.current[i] = el; }}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); move(i, document.dir === "rtl" && e.key === "ArrowRight" ? -1 : 1); }
            else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); move(i, document.dir === "rtl" && e.key === "ArrowLeft" ? 1 : -1); }
          }}
          className={`rsl-touch min-h-8 rounded-md border px-2 text-xs ${value === o.value ? "border-cyan-400 bg-cyan-500/10 text-cyan-200" : "border-zinc-700 text-zinc-300"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of items) (out[key(item)] ??= []).push(item);
  return out;
}
