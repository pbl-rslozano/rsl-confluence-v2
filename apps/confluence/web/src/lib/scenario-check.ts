/**
 * scenario-check.ts — v2.8 (WP22): the Scenario check in the ledger dialog.
 * Band coverage (target 68 % / 95 %, Wilson range) and the three-outcome Brier score of the scenario odds against the
 * coin's base-rate odds, at the official H = 6. Logged and never scored.
 */
import type { Kline } from "./indicators";
import { indexOfTime, maxHoldSpan, wilson, type LedgerRow } from "./ledger-metrics";
import { bucketOf, type Bucket } from "./scenarios";

const OFFICIAL_H = 6;

/** ln(close h bars later / signal close); null when the bar is missing, the horizon is not closed or the window is not contiguous. */
export function realizedLogReturn(row: Pick<LedgerRow, "t" | "c">, k: Kline[], h: number, intervalMs: number): number | null {
  const i = indexOfTime(k, row.t);
  if (i < 0 || i + h >= k.length) return null;
  if (k[i + h].time - k[i].time > maxHoldSpan(h, intervalMs)) return null;
  const x = k[i + h].close;
  if (!(x > 0) || !(row.c > 0)) return null;
  const r = Math.log(x / row.c);
  return Number.isFinite(r) ? r : null;
}

/** Brier score over the three outcomes (up, range, down): sum of (p - outcome)^2. */
export function brier3(p: readonly [number, number, number], outcome: Bucket): number {
  const o = [outcome === "up" ? 1 : 0, outcome === "range" ? 1 : 0, outcome === "down" ? 1 : 0];
  return (p[0] - o[0]) ** 2 + (p[1] - o[1]) ** 2 + (p[2] - o[2]) ** 2;
}

export interface Coverage { inside: number; n: number; rate: number; ci: [number, number] }
export interface ScenarioCheck {
  n: number;
  skipped: number;
  cov68: Coverage | null;
  cov95: Coverage | null;
  brier: { n: number; scenarios: number; base: number } | null;
}

const coverage = (inside: number, n: number): Coverage => ({ inside, n, rate: inside / n, ci: wilson(inside, n) });

export function scenarioCheck(items: { row: LedgerRow; r: number }[], intervalMs: number, skipped = 0): ScenarioCheck {
  // Non-overlapping 6-bar windows per series (first wins), as thinNonOverlapping does.
  const bySeries = new Map<string, { row: LedgerRow; r: number }[]>();
  for (const it of items) {
    const key = `${it.row.src}|${it.row.tf}|${it.row.pair}`;
    const l = bySeries.get(key);
    if (l) l.push(it); else bySeries.set(key, [it]);
  }
  const kept: { row: LedgerRow; r: number }[] = [];
  const gap = OFFICIAL_H * intervalMs;
  for (const list of bySeries.values()) {
    list.sort((a, b) => a.row.t - b.row.t);
    let next = -Infinity;
    for (const it of list) if (it.row.t >= next) { kept.push(it); next = it.row.t + gap; }
  }
  if (!kept.length) return { n: 0, skipped, cov68: null, cov95: null, brier: null };
  const withBand = kept.filter((x) => x.row.scb);
  const in68 = withBand.filter((x) => x.row.scb![1] <= x.r && x.r <= x.row.scb![2]).length;
  const in95 = withBand.filter((x) => x.row.scb![0] <= x.r && x.r <= x.row.scb![3]).length;
  const own = kept.filter((x) => x.row.scp && x.row.scp.f === 0);
  let bs = 0;
  let bb = 0;
  for (const x of own) {
    const o = bucketOf(x.r / x.row.scp!.w);
    bs += brier3(x.row.scp!.p, o);
    bb += brier3(x.row.scp!.b, o);
  }
  return {
    n: kept.length,
    skipped,
    cov68: withBand.length ? coverage(in68, withBand.length) : null,
    cov95: withBand.length ? coverage(in95, withBand.length) : null,
    brier: own.length ? { n: own.length, scenarios: bs / own.length, base: bb / own.length } : null,
  };
}
