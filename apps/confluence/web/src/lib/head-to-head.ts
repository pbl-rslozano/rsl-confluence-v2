/**
 * head-to-head.ts — v2.8 (WP23): Classic and Confluence v2 measured on the same ledger rows and the same outcomes.
 *
 * The comparison is a read of what is already logged: a row carries Classic's label (sc / m / st / sup) and, when
 * computed, v2's compact label (row.v2). v2's side is the same bar and close with v2's label, over the SAME measured
 * outcome (gross, cost and funding are shared; only the direction, and so the net, changes). Nothing here fetches,
 * stores or scores: Classic's report, gate and pre-registration never see v2.
 */
import { maxHoldSpan, type LedgerReport, type LedgerRow, type Outcome } from "./ledger-metrics";

/** The same bar and close with v2's label, or null when v2 was not computed on the row. */
export function asV2Row(row: LedgerRow): LedgerRow | null {
  const v2 = row.v2;
  if (!v2) return null;
  return { ...row, sc: v2.s ?? 0, m: v2.m, st: v2.st, sup: v2.s === null ? 1 : 0 };
}

/** The same measured outcome, priced for `row`'s direction (outcomeFromSnapshot's rule: NEUTRAL is measured long). */
export function retargetOutcome(o: Outcome, row: LedgerRow): Outcome {
  const d = row.m === 0 ? 1 : row.m;
  // Excursions are not stored per direction here, so they are left unknown (the report does not read them for the comparison).
  return { ...o, row, net: d * o.gross - o.cost - d * o.fundingLong, mfe: NaN, mae: NaN };
}

/** Whether a row is compared: it carries v2 recorded by the CURRENT v2 config. Rows of another v2 version are never pooled. */
export const comparedV2 = (row: LedgerRow, v2Cfg: string): boolean => row.v2?.cfg === v2Cfg;

/** The rows compared under `v2Cfg`, and the two kinds left out: no v2 at all, and v2 of another version. */
export function splitByV2(rows: LedgerRow[], v2Cfg: string): { compared: LedgerRow[]; notCompared: number; otherVersions: number } {
  const compared: LedgerRow[] = [];
  let notCompared = 0;
  let otherVersions = 0;
  for (const r of rows) {
    if (comparedV2(r, v2Cfg)) compared.push(r);
    else if (r.v2) otherVersions++;
    else notCompared++;
  }
  return { compared, notCompared, otherVersions };
}

/** Only outcomes whose row carries v2 of `v2Cfg`; one outcome per row is shared by both sides. */
export function pairedOutcomes(outcomes: Map<number, Outcome[]>, v2Cfg: string): { classic: Map<number, Outcome[]>; v2: Map<number, Outcome[]> } {
  const classic = new Map<number, Outcome[]>();
  const v2 = new Map<number, Outcome[]>();
  for (const [h, list] of outcomes) {
    const kept = list.filter((o) => comparedV2(o.row, v2Cfg));
    classic.set(h, kept);
    v2.set(h, kept.map((o) => retargetOutcome(o, asV2Row(o.row) as LedgerRow)));
  }
  return { classic, v2 };
}

/**
 * Label changes per 100 consecutive bar pairs, per source|timeframe|pair series. A step is a pair of consecutive rows
 * 0 < Δt ≤ maxHoldSpan(1, intervalMs) (a missing bar breaks it); a change is a step whose direction differs.
 */
export function labelChurn(rows: LedgerRow[], intervalMs: number): { changes: number; steps: number; per100: number } {
  const bySeries = new Map<string, LedgerRow[]>();
  for (const r of rows) {
    const key = `${r.src}|${r.tf}|${r.pair}`;
    const list = bySeries.get(key);
    if (list) list.push(r); else bySeries.set(key, [r]);
  }
  const span = maxHoldSpan(1, intervalMs);
  let changes = 0;
  let steps = 0;
  for (const list of bySeries.values()) {
    list.sort((a, b) => a.t - b.t);
    for (let i = 1; i < list.length; i++) {
      const dt = list[i].t - list[i - 1].t;
      if (!(dt > 0 && dt <= span)) continue;
      steps++;
      if (list[i].m !== list[i - 1].m) changes++;
    }
  }
  return { changes, steps, per100: steps > 0 ? (100 * changes) / steps : NaN };
}

export interface H2HSide { n: number; hitRate: number; meanNetBps: number; edgeBps: number; icT: number; psr: number; churnPer100: number }

/** One engine's line at one horizon: BUY · all and SELL · all pooled, weighted by n. NaN without signals. */
export function sideOf(report: LedgerReport, horizon: number, churnPer100: number): H2HSide {
  const h = report.horizons.find((x) => x.horizon === horizon);
  const groups = (h?.groups ?? []).filter((g) => g.label === "BUY · all" || g.label === "SELL · all");
  const n = groups.reduce((a, g) => a + g.n, 0);
  const w = (pick: (g: (typeof groups)[number]) => number) => (n > 0 ? groups.reduce((a, g) => a + g.n * pick(g), 0) / n : NaN);
  return {
    n,
    hitRate: w((g) => g.hitRate),
    meanNetBps: w((g) => g.meanNetBps),
    edgeBps: w((g) => g.edgeBps),
    icT: h ? h.ic.tStat : NaN,
    psr: h ? h.sharpe.psr : NaN,
    churnPer100,
  };
}

/** What the ledger hands the head-to-head: the Classic report's own rows, outcomes and options (the shape of `buildReportAsync`'s input). */
export interface H2HInputs {
  rows: LedgerRow[];
  outcomes: Map<number, Outcome[]>;
  costBps: number;
  trials: number;
  intervalMs: number;
  momentum: Map<string, -1 | 0 | 1>;
}
export type H2HReportBuilder = (x: H2HInputs) => Promise<LedgerReport>;

/** The cheap part: which rows are compared, the two counts left out, and closed outcomes per horizon on the compared bars. */
export interface H2HPrep {
  n: number;
  notCompared: number;
  otherVersions: number;
  paired: Map<number, number>;
  rows: LedgerRow[];
  pairs: { classic: Map<number, Outcome[]>; v2: Map<number, Outcome[]> };
}
export interface H2HReports { classic: LedgerReport; v2: LedgerReport; churn: { classic: number; v2: number } }

export function headToHeadPrep(inputs: H2HInputs, v2Cfg: string): H2HPrep {
  const { compared, notCompared, otherVersions } = splitByV2(inputs.rows, v2Cfg);
  const pairs = pairedOutcomes(inputs.outcomes, v2Cfg);
  return { n: compared.length, notCompared, otherVersions, paired: new Map([...pairs.classic].map(([h, list]) => [h, list.length])), rows: compared, pairs };
}

/** The two reports on the compared rows (null when no compared bar has a closed outcome at any horizon). */
async function headToHeadReports(prep: H2HPrep, inputs: H2HInputs, build: H2HReportBuilder): Promise<H2HReports | null> {
  if (!prep.n || ![...prep.paired.values()].some((n) => n > 0)) return null;
  const v2Rows = prep.rows.map((r) => asV2Row(r) as LedgerRow);
  const opts = { costBps: inputs.costBps, trials: inputs.trials, intervalMs: inputs.intervalMs, momentum: inputs.momentum };
  const classic = await build({ rows: prep.rows, outcomes: prep.pairs.classic, ...opts });
  const v2 = await build({ rows: v2Rows, outcomes: prep.pairs.v2, ...opts });
  return { classic, v2, churn: { classic: labelChurn(prep.rows, inputs.intervalMs).per100, v2: labelChurn(v2Rows, inputs.intervalMs).per100 } };
}

export interface H2HJob { inputs: H2HInputs; v2Cfg: string; prep: H2HPrep; reports: Promise<H2HReports | null> }

/**
 * Final review I1: the comparison is built lazily. `load(open, inputs, v2Cfg)` returns null — and builds nothing — while the
 * section is closed or before the Classic report has handed over its inputs; otherwise one job per (inputs, v2Cfg), cached,
 * so re-opening the section does not build again. A new measurement passes new inputs and builds again. A failed build is
 * not kept, so the next open retries.
 */
export function headToHeadLoader(build: H2HReportBuilder): (open: boolean, inputs: H2HInputs | null, v2Cfg: string) => H2HJob | null {
  let job: H2HJob | null = null;
  return (open, inputs, v2Cfg) => {
    if (!open || !inputs) return null;
    if (job && job.inputs === inputs && job.v2Cfg === v2Cfg) return job;
    const prep = headToHeadPrep(inputs, v2Cfg);
    const next: H2HJob = { inputs, v2Cfg, prep, reports: headToHeadReports(prep, inputs, build) };
    next.reports.catch(() => { if (job === next) job = null; });
    job = next;
    return next;
  };
}
