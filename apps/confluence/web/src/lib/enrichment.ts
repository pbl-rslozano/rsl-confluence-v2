/**
 * enrichment.ts — v2.3
 * ----------------------------------------------------------------------------
 * Context fields logged next to every ledger row. They are NEVER part of the
 * score (the engine id does not depend on them): they exist so the ledger can
 * later answer "does the signal work better when …?" without re-collecting.
 *
 *   rs    cross-sectional percentile (0–100) of the 20-bar return in the scan
 *   beta  rolling 100-bar beta of log returns to BTC (same source, timeframe)
 *   htf   higher-timeframe trend: sign of the EMA-20 slope on 4× aggregated bars
 *   td    taker imbalance over the last 10 bars, (buy − sell) / volume, −1…1
 *         (venues that report taker-buy volume only — Binance spot)
 *   mev   hours to the nearest scheduled macro event within ±48 h
 *   bp    perp basis % (mark / index − 1); pin = band-pinned flag
 *   earn  earnings date within ±24 h (manual list, earnings-calendar.ts)
 *   spl   probable stock split in the window (signal muted)
 *
 * Token unlock schedules are not available from a keyless public source and
 * are not logged (see docs/measurement.md).
 * ----------------------------------------------------------------------------
 */
import type { Kline } from "./indicators";
import type { LedgerRow } from "./ledger-metrics";
import { MACRO_EVENTS } from "./macro-calendar";
import { earningsNear } from "./earnings-calendar";
import { isBandPinned } from "./market-client";

const round = (v: number, d: number) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

/** 20-bar simple return of the newest bar, or null when the series is too short. */
export function ret20(k: Kline[]): number | null {
  if (k.length < 21) return null;
  const a = k[k.length - 21].close;
  const b = k[k.length - 1].close;
  return a > 0 ? b / a - 1 : null;
}

/** Percentile rank (0–100) of each value within the set (ties share the mean rank). */
export function percentiles(values: Map<string, number>): Map<string, number> {
  const list = [...values.entries()].filter(([, v]) => Number.isFinite(v)).sort((a, b) => a[1] - b[1]);
  const out = new Map<string, number>();
  if (list.length < 2) { for (const [k] of list) out.set(k, 50); return out; }
  let i = 0;
  while (i < list.length) {
    let j = i;
    while (j + 1 < list.length && list[j + 1][1] === list[i][1]) j++;
    const pct = (((i + j) / 2) / (list.length - 1)) * 100;
    for (let x = i; x <= j; x++) out.set(list[x][0], Math.round(pct));
    i = j + 1;
  }
  return out;
}

/** Rolling beta of log returns to `btc`, aligned by bar time, over the last `n` common bars. */
export function betaTo(k: Kline[], btc: Kline[] | undefined, n = 100): number | null {
  if (!btc?.length || k.length < 3) return null;
  const btcClose = new Map(btc.map((b) => [b.time, b.close]));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = k.length - 1; i > 0 && xs.length < n; i--) {
    const b1 = btcClose.get(k[i].time);
    const b0 = btcClose.get(k[i - 1].time);
    if (!(b1! > 0) || !(b0! > 0) || !(k[i].close > 0) || !(k[i - 1].close > 0)) continue;
    xs.push(Math.log(b1! / b0!));
    ys.push(Math.log(k[i].close / k[i - 1].close));
  }
  if (xs.length < 30) return null;
  const mx = xs.reduce((a, v) => a + v, 0) / xs.length;
  const my = ys.reduce((a, v) => a + v, 0) / ys.length;
  let cov = 0;
  let vx = 0;
  for (let i = 0; i < xs.length; i++) { cov += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; }
  return vx > 0 ? round(cov / vx, 3) : null;
}

/** Higher-timeframe trend: EMA-20 slope sign on epoch-aligned 4× bars (complete buckets only). */
export function htfTrend(k: Kline[], intervalMs: number, factor = 4): -1 | 0 | 1 | null {
  const size = intervalMs * factor;
  const buckets = new Map<number, Kline[]>();
  for (const b of k) {
    const key = Math.floor(b.time / size) * size;
    const g = buckets.get(key);
    if (g) g.push(b); else buckets.set(key, [b]);
  }
  const closes = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, g]) => g.length === factor)
    .map(([, g]) => g[g.length - 1].close);
  if (closes.length < 22) return null;
  const alpha = 2 / 21;
  let ema = closes.slice(0, 20).reduce((a, v) => a + v, 0) / 20;
  let prev = ema;
  for (let i = 20; i < closes.length; i++) { prev = ema; ema = alpha * closes[i] + (1 - alpha) * ema; }
  const slope = (ema - prev) / prev;
  return Math.abs(slope) < 1e-5 ? 0 : slope > 0 ? 1 : -1;
}

/** Taker imbalance over the last `n` bars; null when the venue does not report taker volume. */
export function takerDelta(k: Kline[], n = 10): number | null {
  const tail = k.slice(-n);
  if (tail.length < n || tail.some((b) => b.takerBuy === undefined)) return null;
  const vol = tail.reduce((a, b) => a + b.volume, 0);
  if (!(vol > 0)) return null;
  const buy = tail.reduce((a, b) => a + (b.takerBuy as number), 0);
  return round((2 * buy - vol) / vol, 3);
}

/** Hours to the nearest scheduled macro event within ±48 h of `at` (negative = event already passed). */
export function macroEventHours(at: number, window = 48): number | null {
  let best: number | null = null;
  for (const e of MACRO_EVENTS) {
    const h = (e.at - at) / 3_600_000;
    if (Math.abs(h) <= window && (best === null || Math.abs(h) < Math.abs(best))) best = h;
  }
  return best === null ? null : round(best, 1);
}

export interface EnrichContext {
  intervalMs: number;
  /** BTCUSDT bars from the same source and timeframe (beta). */
  btc?: Kline[];
  /** Perp basis % for this symbol (perp sources only). */
  basis?: number;
  /** Cross-sectional percentile for this pair (computed over the whole scan). */
  rs?: number | null;
  split?: boolean;
}

/** Context fields for one row. Pure; safe on the main thread or in a worker. */
export function enrich(row: Pick<LedgerRow, "pair" | "ac" | "tc">, k: Kline[], ctx: EnrichContext): Partial<LedgerRow> {
  const out: Partial<LedgerRow> = {
    rs: ctx.rs ?? null,
    beta: row.pair === "BTCUSDT" ? 1 : betaTo(k, ctx.btc),
    htf: htfTrend(k, ctx.intervalMs),
    td: takerDelta(k),
    mev: macroEventHours(row.tc),
  };
  if (ctx.basis !== undefined && Number.isFinite(ctx.basis)) {
    out.bp = round(ctx.basis, 3);
    out.pin = isBandPinned(k, ctx.basis) ? 1 : 0;
  } else if (row.ac === "stock" || row.ac === "fx" || row.ac === "commodity") {
    out.pin = isBandPinned(k) ? 1 : 0;
  }
  if (row.ac === "stock") {
    out.earn = earningsNear(row.pair, row.tc) ? 1 : 0;
    out.spl = ctx.split ? 1 : 0;
  }
  return out;
}
