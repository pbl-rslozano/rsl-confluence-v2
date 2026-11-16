/**
 * liquidations.ts — v2.8 Step 4b (plan WP25, Task 1): the pure liquidation core. No socket, no storage, no clock of its own.
 *
 * Context, never a vote: a cascade alert is information in the Radar panel; it never reaches scoring and never blocks or
 * places a trade. Binance pushes only the latest liquidation per symbol per second, so its totals are "sampled".
 *
 * The 30-day baseline is the device's own log of COMPLETE UTC hours: an hour counts only when the venue's feed was
 * connected for all of it (every disconnection inside it <= LIQ_MAX_GAP_MS). A missing or incomplete hour is left out,
 * never counted as zero. Time before the first `connected()` counts as disconnected.
 */
import type { RadarAlert, RadarThresholds } from "./alerts";
import { ALERT_CODE, median, pageOf, sanitizeThresholds } from "./alerts";

export type LiqVenue = "bybit" | "binance";
export type LiqSymbol = "BTCUSDT" | "ETHUSDT";
/** `side` = the side that was liquidated (a Bybit "Buy" or Binance "SELL" order closes a long). */
export interface LiqEvent { venue: LiqVenue; symbol: LiqSymbol; side: "long" | "short"; usd: number; t: number }
/** `h` = UTC hour start (ms). */
export interface LiqHour { h: number; long: number; short: number }

export const LIQ_HOUR_MS = 3_600_000;
export const LIQ_BASELINE_HOURS = 720;
export const LIQ_MAX_GAP_MS = 10_000;
export const LIQ_KEEP_HOURS = 1000;
export const LIQ_KEEP_MS = 180 * 86_400_000;

const MAX_USD = 1e10;
const MAX_HOUR_USD = 1e11;
const FUTURE_SLACK_MS = 60_000;
const PAST_SLACK_MS = 2 * LIQ_HOUR_MS;
const VENUES: LiqVenue[] = ["bybit", "binance"];
const VENUE_NAME: Record<LiqVenue, string> = { bybit: "Bybit", binance: "Binance" };

const num = (x: unknown): number => (typeof x === "number" || (typeof x === "string" && x.trim() !== "") ? Number(x) : NaN);
const isRec = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const isSymbol = (s: unknown): s is LiqSymbol => s === "BTCUSDT" || s === "ETHUSDT";

function accept(venue: LiqVenue, symbol: unknown, side: "long" | "short" | null, usd: number, t: number, now: number): LiqEvent[] {
  if (!isSymbol(symbol) || !side) return [];
  if (!Number.isFinite(usd) || usd <= 0 || usd > MAX_USD) return [];
  if (!Number.isFinite(t) || !Number.isFinite(now) || t > now + FUTURE_SLACK_MS || t < now - PAST_SLACK_MS) return [];
  return [{ venue, symbol, side, usd, t }];
}

/** Bybit v5 `allLiquidation.<SYMBOL>` message. Never throws; junk yields []. */
export function parseBybitLiq(msg: unknown, now: number): LiqEvent[] {
  try {
    if (!isRec(msg) || typeof msg.topic !== "string" || !msg.topic.startsWith("allLiquidation.") || !Array.isArray(msg.data)) return [];
    const out: LiqEvent[] = [];
    for (const d of msg.data) {
      if (!isRec(d)) continue;
      const side = d.S === "Buy" ? "long" : d.S === "Sell" ? "short" : null;
      out.push(...accept("bybit", d.s, side, num(d.v) * num(d.p), num(d.T), now));
    }
    return out;
  } catch {
    return [];
  }
}

/** Binance `forceOrder` message (`!forceOrder@arr`). 0 or 1 event (an array of messages is tolerated). Never throws. */
export function parseBinanceLiq(msg: unknown, now: number): LiqEvent[] {
  try {
    if (Array.isArray(msg)) return msg.flatMap((m) => parseBinanceLiq(m, now));
    if (!isRec(msg) || !isRec(msg.o)) return [];
    const o = msg.o;
    const side = o.S === "SELL" ? "long" : o.S === "BUY" ? "short" : null;
    const z = num(o.z);
    const ap = num(o.ap);
    const usd = z > 0 && ap > 0 ? z * ap : num(o.q) * num(o.p);
    return accept("binance", o.s, side, usd, num(o.T), now);
  } catch {
    return [];
  }
}

/** Sorted (oldest first), deduplicated by hour (first wins) and trimmed to LIQ_KEEP_HOURS; shared by the constructor, roll and normalizeLiqDoc. */
function tidy(hours: LiqHour[]): LiqHour[] {
  const byH = new Map<number, LiqHour>();
  for (const x of hours) if (!byH.has(x.h)) byH.set(x.h, { h: x.h, long: x.long, short: x.short });
  const sorted = [...byH.values()].sort((a, b) => a.h - b.h);
  return sorted.length > LIQ_KEEP_HOURS ? sorted.slice(sorted.length - LIQ_KEEP_HOURS) : sorted;
}

interface Gap { start: number; end: number | null }

/**
 * One venue's liquidation totals per UTC hour plus the feed's coverage. Feed callbacks call `connected` / `disconnected`
 * on socket open / close and `add` for each parsed event; `roll(now)` (call it at least hourly) moves hours that closed
 * complete into `hours()`; `last60(now)` is the rolling window the cascade rule reads.
 */
export class HourBook {
  private readonly venue: LiqVenue;
  private done: LiqHour[];
  private open = new Map<number, { long: number; short: number }>();
  private recent: LiqEvent[] = [];
  private head = 0; // recent[head..] is live; the front is dropped by moving this index, compacted when half is dead
  private gaps: Gap[] = [{ start: -Infinity, end: null }]; // before the first connected(): disconnected
  private firstConnected: number | null = null;
  private rolledThrough = -Infinity; // end (ms) of the newest hour already reported
  private clock = 0;

  constructor(venue: LiqVenue, hours: LiqHour[] = []) {
    this.venue = venue;
    this.done = tidy(Array.isArray(hours) ? hours : []);
  }

  connected(t: number): void {
    if (!Number.isFinite(t)) return;
    this.bump(t);
    const g = this.gaps[this.gaps.length - 1];
    if (g && g.end === null) g.end = Math.max(t, g.start);
    if (this.firstConnected === null) this.firstConnected = t;
  }

  disconnected(t: number): void {
    if (!Number.isFinite(t)) return;
    this.bump(t);
    const g = this.gaps[this.gaps.length - 1];
    if (!g || g.end !== null) this.gaps.push({ start: t, end: null });
  }

  add(e: LiqEvent): void {
    if (!e || e.venue !== this.venue || !Number.isFinite(e.t) || !Number.isFinite(e.usd)) return;
    this.bump(e.t);
    this.recent.push(e);
    // Amortised O(1): events arrive in time order, so only the head can be stale (an out-of-order straggler is pruned later).
    while (this.head < this.recent.length - 1 && this.recent[this.head].t < e.t - 2 * LIQ_HOUR_MS) this.head++;
    if (this.head > this.recent.length / 2) { this.recent = this.recent.slice(this.head); this.head = 0; }
    const h = Math.floor(e.t / LIQ_HOUR_MS) * LIQ_HOUR_MS;
    if (h + LIQ_HOUR_MS <= this.rolledThrough) return; // that hour was already closed and reported
    const b = this.open.get(h) ?? { long: 0, short: 0 };
    b[e.side] += e.usd;
    this.open.set(h, b);
  }

  /**
   * Hours that closed complete since the previous roll (each hour once). Incomplete hours are dropped for good.
   * An hour is closable only once `now >= hourEnd + graceMs`, so events delivered a little late still count.
   */
  roll(now: number, graceMs = 0): LiqHour[] {
    if (!Number.isFinite(now)) return [];
    this.bump(now);
    const grace = Number.isFinite(graceMs) && graceMs > 0 ? graceMs : 0;
    const lastClosed = Math.floor((now - grace) / LIQ_HOUR_MS) * LIQ_HOUR_MS - LIQ_HOUR_MS;
    const out: LiqHour[] = [];
    let decided = lastClosed + LIQ_HOUR_MS; // end of the newest hour whose fate is settled
    if (this.firstConnected !== null) {
      const firstWhole = Math.ceil(this.firstConnected / LIQ_HOUR_MS) * LIQ_HOUR_MS;
      let start = Math.max(firstWhole, this.rolledThrough === -Infinity ? firstWhole : this.rolledThrough, lastClosed - (LIQ_KEEP_HOURS - 1) * LIQ_HOUR_MS);
      start = Math.ceil(start / LIQ_HOUR_MS) * LIQ_HOUR_MS;
      const have = new Set(this.done.map((x) => x.h));
      for (let h = start; h <= lastClosed; h += LIQ_HOUR_MS) {
        if (have.has(h)) continue;
        const state = this.judge(h, h + LIQ_HOUR_MS, now);
        if (state === "pending") { decided = h; break; } // a short outage is still open: decide this hour (and later ones) at a later roll
        if (state === "incomplete") continue;
        const b = this.open.get(h) ?? { long: 0, short: 0 };
        out.push({ h, long: b.long, short: b.short });
      }
    }
    if (decided > this.rolledThrough) this.rolledThrough = decided;
    for (const h of [...this.open.keys()]) if (h + LIQ_HOUR_MS <= this.rolledThrough) this.open.delete(h);
    this.gaps = this.gaps.filter((g) => g.end === null || g.end >= this.rolledThrough - LIQ_HOUR_MS);
    if (out.length) this.done = tidy([...this.done, ...out]);
    return out;
  }

  last60(now: number): { long: number; short: number; coveredMs: number; complete: boolean } {
    this.bump(now);
    const a = now - LIQ_HOUR_MS;
    let long = 0;
    let short = 0;
    for (let i = this.head; i < this.recent.length; i++) {
      const e = this.recent[i];
      if (e.t <= a || e.t > now) continue;
      if (e.side === "long") long += e.usd;
      else short += e.usd;
    }
    const { missing, complete } = this.coverage(a, now);
    return { long, short, coveredMs: Math.max(0, LIQ_HOUR_MS - missing), complete };
  }

  /** Number of events kept for the rolling window (test hook for the pruning bound). */
  recentSize(): number {
    return this.recent.length - this.head;
  }

  /** Complete hours, oldest first, at most LIQ_KEEP_HOURS and none older than LIQ_KEEP_MS. */
  hours(): LiqHour[] {
    const min = this.clock - LIQ_KEEP_MS;
    if (this.clock > 0) this.done = this.done.filter((x) => x.h >= min);
    return this.done.map((x) => ({ ...x }));
  }

  private bump(t: number): void {
    if (t > this.clock) this.clock = t;
  }

  /**
   * Disconnected time inside [a, b] (`missing`, clipped to the window) and whether every disconnection touching it is
   * <= LIQ_MAX_GAP_MS. "Complete" is judged on the gap's FULL length (a still-open gap ends at b), so one outage that
   * straddles an hour boundary or the window edge spoils every window it touches.
   */
  private coverage(a: number, b: number): { missing: number; complete: boolean } {
    let missing = 0;
    let complete = true;
    for (const g of this.gaps) {
      const end = g.end ?? b;
      const len = Math.min(end, b) - Math.max(g.start, a);
      if (len <= 0) continue;
      missing += len;
      if (end - g.start > LIQ_MAX_GAP_MS) complete = false;
    }
    return { missing, complete };
  }

  /**
   * Fate of the closed hour [a, b] at roll time `now`: every disconnection touching it is judged on its FULL length, and one
   * still open counts up to `now`. An open outage that has not yet passed LIQ_MAX_GAP_MS leaves the hour "pending".
   */
  private judge(a: number, b: number, now: number): "complete" | "incomplete" | "pending" {
    let pending = false;
    for (const g of this.gaps) {
      const end = g.end ?? Math.max(b, now);
      if (Math.min(end, b) - Math.max(g.start, a) <= 0) continue;
      if (end - g.start > LIQ_MAX_GAP_MS) return "incomplete";
      if (g.end === null) pending = true;
    }
    return pending ? "pending" : "complete";
  }
}

/** Re-validates a stored document `{ bybit: LiqHour[], binance: LiqHour[] }`: bad hours are dropped, never repaired. */
export function normalizeLiqDoc(raw: unknown, now: number): Record<LiqVenue, LiqHour[]> {
  const out: Record<LiqVenue, LiqHour[]> = { bybit: [], binance: [] };
  if (!isRec(raw)) return out;
  for (const v of VENUES) {
    const list = raw[v];
    if (!Array.isArray(list)) continue;
    const good: LiqHour[] = [];
    for (const x of list) {
      if (!isRec(x)) continue;
      const { h, long, short } = x;
      if (typeof h !== "number" || !Number.isFinite(h) || h % LIQ_HOUR_MS !== 0 || h > now || h < now - LIQ_KEEP_MS) continue;
      if (typeof long !== "number" || !Number.isFinite(long) || long < 0 || long > MAX_HOUR_USD) continue;
      if (typeof short !== "number" || !Number.isFinite(short) || short < 0 || short > MAX_HOUR_USD) continue;
      good.push({ h, long, short });
    }
    out[v] = tidy(good);
  }
  return out;
}

const roundTo = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

/**
 * The cascade rule: the last 60 minutes of liquidations >= liqMult x the median complete hour (newest 720 hours).
 * "collecting" until 720 complete hours exist. No alert when the last-60 window is not complete or the median is 0.
 */
export function liquidationCascade(
  venue: LiqVenue,
  hours: LiqHour[],
  last60: { long: number; short: number; coveredMs?: number; complete: boolean },
  th: RadarThresholds,
  now: number,
): { status: "collecting"; have: number } | { status: "ready"; medianUsd: number; alert: RadarAlert | null } {
  const t = sanitizeThresholds(th);
  const list = (Array.isArray(hours) ? hours : []).filter((x) => x && Number.isFinite(x.long) && Number.isFinite(x.short) && Number.isFinite(x.h));
  if (list.length < LIQ_BASELINE_HOURS) return { status: "collecting", have: list.length };
  const newest = [...list].sort((a, b) => b.h - a.h).slice(0, LIQ_BASELINE_HOURS);
  const medianUsd = median(newest.map((x) => x.long + x.short));
  const total = last60.long + last60.short;
  const code = `LIQ_CASCADE_${venue.toUpperCase()}`;
  if (!last60.complete || !(medianUsd > 0) || !Number.isFinite(total) || total + 1e-9 < t.liqMult * medianUsd || !ALERT_CODE.test(code)) {
    return { status: "ready", medianUsd, alert: null };
  }
  const alert: RadarAlert = {
    code,
    kind: "liquidation",
    trigger: {
      key: "radar.alert.liq",
      vars: {
        venue: VENUE_NAME[venue],
        usd: Math.round(total),
        mult: roundTo(total / medianUsd, 1),
        median: Math.round(medianUsd),
        longPct: Math.round((last60.long / total) * 100),
      },
    },
    sourceUrl: pageOf(venue),
    since: now - LIQ_HOUR_MS,
  };
  return { status: "ready", medianUsd, alert };
}
