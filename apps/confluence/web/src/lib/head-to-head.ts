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

/** Only outcomes whose row carries v2; one outcome per row is shared by both sides. */
export function pairedOutcomes(outcomes: Map<number, Outcome[]>): { classic: Map<number, Outcome[]>; v2: Map<number, Outcome[]> } {
  const classic = new Map<number, Outcome[]>();
  const v2 = new Map<number, Outcome[]>();
  for (const [h, list] of outcomes) {
    const kept = list.filter((o) => !!o.row.v2);
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
