"use client";

/**
 * scenario-panel.tsx — v2.8 (WP22) the collapsed "Scenarios (simulation)" section of the detail sheet.
 *
 * Collapsed (the default) it renders only its title row: nothing is computed and no daily bars are requested.
 * Expanded, it loads the daily bars (crypto, direct fetch only, through the existing `loadDailyBars`), runs the
 * simulation in the report worker and shows the odds, the rule-based explanation and the notes. "Show on chart"
 * hands a memoised `ChartProjection` to the price chart. Display only: nothing here reaches scoring, rules,
 * alerts or the Radar. "Possible scenarios from past data — not a forecast."
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Shuffle } from "lucide-react";
import type { ConfluenceResult, Kline } from "@/lib/indicators";
import type { AssetClass, LedgerRow } from "@/lib/ledger-metrics";
import { INTERVAL_MS, usesDirectFetch, type DataSource } from "@/lib/market-client";
import { isFundTrendClass } from "@/lib/fund-trend";
import { loadDailyBars } from "@/lib/fund-trend-feed";
import { runScenariosAsync } from "@/lib/report-runner";
import {
  BUCKETS, SC_HORIZONS, SC_MIN_BARS, scenarioKey, scenarioOf, scenarioOrder,
  type Bucket, type Scenario, type ScenarioResult, type ScHorizon,
} from "@/lib/scenarios";
import { explainScenarios, sampleLine, sheetNotes, type ExplainPart } from "@/lib/scenario-explain";
import type { ChartProjection } from "@/lib/chart-geometry";
import { RadioPills } from "@/components/ui/radio-pills";
import { useRsl } from "@/rsl/RslContext";

type ScOut = ScenarioResult | { na: "history" };

const ALL_SCENARIOS: Scenario[] = ["continue", "pause", "reverse", "up", "range", "down"];

/** Scenario of each bucket, in tab order (scenarioOrder). */
function bucketsInOrder(r: ScenarioResult): { id: Scenario; bucket: Bucket }[] {
  const state = r.odds.state;
  return scenarioOrder(state).map((id) => ({ id, bucket: BUCKETS.find((b) => scenarioOf(b, state) === id)! }));
}

/** What the chart draws for a result: tabs in scenario order, empty candles = no path; initial = the likeliest with a path. */
export function toProjection(r: ScenarioResult, label: (s: Scenario) => string): ChartProjection {
  const order = bucketsInOrder(r);
  const paths = order.map(({ id, bucket }) => ({ id, label: label(id), candles: r.paths[bucket] ?? [] }));
  let initial = order[0].id;
  let best = -1;
  for (const { id, bucket } of order) {
    const p = r.odds.odds[bucket].p;
    if (r.paths[bucket] && r.paths[bucket]!.length > 0 && p > best) { best = p; initial = id; }
  }
  return { horizon: r.horizon, bands: r.bands, paths, initial };
}

const pct1 = (f: number) => `${(f * 100).toFixed(1)} %`;
/** Wilson range edges as percent with 1 decimal, clamped to 0..100 (a zero-case lower edge can come out as −1e-17: never "-0.0"). */
const edge = (f: number) => (Math.min(1, Math.max(0, f)) * 100).toFixed(1);

export interface ScenarioAsset {
  src: DataSource;
  tf: string;
  pair: string;
  assetClass: AssetClass;
  klines: Kline[];
  confluence: ConfluenceResult;
  context?: Partial<LedgerRow>;
}

export function ScenarioSection({ asset, formatPrice, onProjection }: {
  asset: ScenarioAsset;
  formatPrice: (p: number) => string;
  onProjection: (p: ChartProjection | null) => void;
}) {
  const { t } = useRsl();
  const [open, setOpen] = useState(false);
  const [horizon, setHorizon] = useState<ScHorizon>(6);
  const [show, setShow] = useState(false);

  // A different coin (or timeframe) takes the projection off the chart.
  const assetKey = `${asset.src}|${asset.tf}|${asset.pair}`;
  const [seenAsset, setSeenAsset] = useState(assetKey);
  if (seenAsset !== assetKey) { setSeenAsset(assetKey); setShow(false); }

  const { klines } = asset;
  const enough = klines.length >= SC_MIN_BARS;
  // Daily bars (Fund trend state) only while the section is open, for a Fund trend class on a direct-fetch build.
  const dailyClass = isFundTrendClass(asset.assetClass) && usesDirectFetch();
  const wantDaily = open && enough && dailyClass;
  const [daily, setDaily] = useState<{ key: string; bars: Kline[] | null } | null>(null);
  const { src, pair, tf } = asset;
  useEffect(() => {
    if (!wantDaily) return;
    const ac = new AbortController();
    const key = `${src}|${tf}|${pair}`;
    loadDailyBars(src, pair, Date.now(), ac.signal).then(
      (bars) => { if (!ac.signal.aborted) setDaily({ key, bars }); },
      () => { if (!ac.signal.aborted) setDaily({ key, bars: null }); },
    );
    return () => ac.abort();
  }, [wantDaily, src, tf, pair]);
  /** undefined = still loading. */
  const dailyBars: Kline[] | null | undefined = !dailyClass ? null : daily?.key === assetKey ? daily.bars : undefined;

  // One run per input key (pair, timeframe, last bar, bar count, horizon, last daily bar): live re-renders with the
  // same closed bars never re-run it, and a late result for other inputs is discarded by its key.
  const last = klines[klines.length - 1];
  const runKey = open && enough && last && dailyBars !== undefined
    ? scenarioKey({ pair, tf, horizon }, last.time, klines.length, dailyBars && dailyBars.length ? dailyBars[dailyBars.length - 1].time : null)
    : null;
  const inputs = useRef({ klines, dailyBars, pair, tf, horizon });
  useEffect(() => { inputs.current = { klines, dailyBars, pair, tf, horizon }; });
  const [res, setRes] = useState<{ key: string; out: ScOut } | null>(null);
  useEffect(() => {
    if (!runKey) return;
    const x = inputs.current;
    let live = true;
    runScenariosAsync({ pair: x.pair, tf: x.tf, intervalMs: INTERVAL_MS[x.tf], bars: x.klines, daily: x.dailyBars ?? null, horizon: x.horizon }).then(
      (out) => { if (live && ("na" in out || out.key === runKey)) setRes({ key: runKey, out }); },
      () => { if (live) setRes({ key: runKey, out: { na: "history" } }); },
    );
    return () => { live = false; };
  }, [runKey]);
  const shown = res && runKey && res.key === runKey ? res.out : null;
  const result = shown && !("na" in shown) ? shown : null;

  // The projection keeps its identity while the result does (a new object resets the chart's tab and Play state).
  const labelSig = ALL_SCENARIOS.map((s) => t(`sc.${s}`)).join("\u0001");
  const projection = useMemo(() => {
    if (!result) return null;
    const labels = labelSig.split("\u0001");
    return toProjection(result, (s) => labels[ALL_SCENARIOS.indexOf(s)]);
  }, [result, labelSig]);
  const emitted = open && show ? projection : null;
  useEffect(() => { onProjection(emitted); }, [emitted, onProjection]);
  useEffect(() => () => onProjection(null), [onProjection]);

  const render = (part: ExplainPart) => {
    const vars = part.vars && typeof part.vars.bloc === "string" ? { ...part.vars, bloc: t(part.vars.bloc) } : part.vars;
    return t(part.key, vars);
  };

  let body: React.ReactNode = null;
  if (open) {
    let content: React.ReactNode;
    if (!enough || (shown && "na" in shown)) {
      content = <p data-testid="scenarios-na" className="text-zinc-400">{t("sc.notEnough")}</p>;
    } else if (!result) {
      content = <p data-testid="scenarios-loading" className="text-zinc-500">{t("sc.loading")}</p>;
    } else {
      const o = result.odds;
      const sample = sampleLine(o);
      const c = asset.confluence;
      const explain = explainScenarios({
        result, confluence: c, bars: klines, intervalMs: INTERVAL_MS[tf],
        perp: src.endsWith("-perp") ? { fr: asset.context?.fr ?? null, bp: asset.context?.bp ?? null } : null,
      }, {
        price: formatPrice,
        pct: (f) => `${(f * 100).toFixed(3)} %`,
        time: (ms) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`,
        label: (master, strength) => master === "NEUTRAL" ? t("sig.neutral")
          : `${t(master === "BULLISH" ? "sig.buy" : "sig.sell")} · ${t(strength === "STRONG" ? "sig.strong" : strength === "MODERATE" ? "sig.moderate" : "sig.weak")}`,
        event: (kind) => t(`macro.${kind}`),
      });
      const notes = sheetNotes(result, klines.length);
      content = (
        <>
          <div className="overflow-x-auto">
            <table data-testid="scenarios-table" data-h={horizon} className="w-full min-w-[22rem] border-collapse font-mono tabular-nums">
              <thead>
                <tr className="text-zinc-500">
                  <th scope="col" className="py-1 pe-2 text-start font-normal">{t("sc.col.scenario")}</th>
                  <th scope="col" className="py-1 pe-2 text-end font-normal">{t("sc.col.odds")}</th>
                  <th scope="col" className="py-1 pe-2 text-end font-normal">{t("sc.col.range")}</th>
                  <th scope="col" className="py-1 pe-2 text-end font-normal">{t("sc.col.cases")}</th>
                  <th scope="col" className="py-1 text-end font-normal">{t("sc.col.base")}</th>
                </tr>
              </thead>
              <tbody>
                {bucketsInOrder(result).map(({ id, bucket }) => {
                  const b = o.odds[bucket];
                  return (
                    <tr key={id} data-scenario={id} data-p={b.p} className="border-t border-zinc-800 text-zinc-200">
                      <th scope="row" className="py-1 pe-2 text-start font-sans font-normal">{t(`sc.${id}`)}</th>
                      <td className="py-1 pe-2 text-end">{pct1(b.p)}</td>
                      <td className="py-1 pe-2 text-end text-zinc-400">{`${edge(b.lo)}–${edge(b.hi)} %`}</td>
                      <td className="py-1 pe-2 text-end text-zinc-400">{b.cases}</td>
                      <td className="py-1 text-end text-zinc-400">{pct1(o.base[bucket])}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p data-testid="scenarios-sample" data-neff={sample.vars!.neff} className="text-zinc-500">{render(sample)}</p>
          <p data-testid="scenarios-explain" className="leading-relaxed text-zinc-400">{explain.map(render).join(" ")}</p>
          {notes.length > 0 && (
            <div data-testid="scenarios-note" className="space-y-0.5 text-[11px] text-zinc-500">
              {notes.map((n) => <p key={n.key}>{render(n)}</p>)}
            </div>
          )}
          <button type="button" data-testid="scenarios-show" aria-pressed={show} onClick={() => setShow(!show)}
            className={`rsl-touch min-h-8 rounded-md border px-2 text-xs ${show ? "border-cyan-400 bg-cyan-500/10 text-cyan-200" : "border-zinc-700 text-zinc-300"}`}>
            {t(show ? "sc.hideFromChart" : "sc.showOnChart")}
          </button>
        </>
      );
    }
    body = (
      <div id="scenarios-body" className="mt-2 space-y-2">
        <p data-testid="scenarios-header" className="font-semibold text-zinc-300">{t("sc.header")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-zinc-500">{t("sc.horizon")}</span>
          <RadioPills testId="scenarios-h" label={t("sc.horizon")} value={horizon}
            options={SC_HORIZONS.map((h) => ({ value: h as ScHorizon, label: t("sc.h", { h }) }))} onChange={setHorizon} />
        </div>
        {content}
      </div>
    );
  }

  return (
    <section data-testid="scenarios-section" className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2.5 text-xs">
      <button type="button" data-testid="scenarios-toggle" aria-expanded={open} aria-controls="scenarios-body"
        onClick={() => { if (open) setShow(false); setOpen(!open); }}
        className="flex w-full items-center justify-between gap-2 text-start">
        <span className="flex items-center gap-2">
          <Shuffle className="h-4 w-4 text-cyan-400" aria-hidden />
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{t("sc.title")}</span>
        </span>
        <ChevronDown className={`h-4 w-4 text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {body}
    </section>
  );
}
