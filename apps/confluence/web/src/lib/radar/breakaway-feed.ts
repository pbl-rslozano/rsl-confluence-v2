/**
 * breakaway-feed.ts — v2.8 Step 4a (plan WP25, Task 4): the feeds behind the break-away and volume-spike alerts.
 *
 * Public market data only: GET, no key, no credentials (R12, R20). No new hosts and no new fetch code: every request
 * goes through the venue's existing klines fetcher (`fetchSymbolKlines`, which owns the venue gate and cooldown) or
 * `loadDailyBars` (cached per UTC day, shared with the Fund trend feed). A venue that fails or is cooling down lands
 * in `unavailable`; only an aborted signal rejects.
 *
 * BTC in USD terms through each venue's own USDT market: Binance, Bybit, Bitget, OKX and Coinbase BTCUSDT directly;
 * Upbit KRW-BTC ÷ KRW-USDT; Coins.ph BTCPHP ÷ USDTPHP. Context, never a vote.
 *
 * Requests per 5-minute cycle (fetchBreakAwayCloses): 9 — one 1h klines call each for Binance, Bybit, Bitget, OKX and
 * Coinbase, two for Upbit (KRW-BTC, KRW-USDT), two for Coins.ph (BTCPHP, USDTPHP). Daily inputs (standing premiums and
 * volumes) come from loadDailyBars: once per UTC day, the first time a cold store needs up to ~30 requests (Upbit pages
 * 200 bars, OKX 99, Coinbase 300), after that one delta request per series (9 in all) the next UTC day, none in between.
 */
import type { Kline } from "../indicators";
import { assertNotCoolingDown, dropUnclosed, fetchSymbolKlines, type DataSource } from "../market-client";
import { loadDailyBars } from "../fund-trend-feed";
import { isAbort, standingPremiumMedian } from "./regional";

const H = 3_600_000;
const DAY = 86_400_000;
/** Closed 1h bars kept per venue: the panel lets the user ask for up to 6. */
export const BREAKAWAY_BARS = 6;
/** Requested per call: the kept bars, the bar still forming and one spare. */
const HOURLY_REQUEST = BREAKAWAY_BARS + 2;
const STANDING_DAYS = 30;
/** A daily series that failed is not asked for again for this long, so "daily inputs once per UTC day" holds. */
export const DAILY_BACKOFF_MS = 45 * 60_000;
const VOLUME_DAYS_KEPT = 61;
/** A volume run needs at least this many of the six venues (the same venues on every day of the run). */
const VOLUME_MIN_VENUES = 4;

interface Leg { source: DataSource; symbol: string }
interface Venue { id: string; num: Leg; den?: Leg }

/** Venue ids are the provider ids of lib/providers.ts. Ratio venues (den) are quoted in a local currency. */
export const BREAKAWAY_VENUES: readonly Venue[] = [
  { id: "binance", num: { source: "binance", symbol: "BTCUSDT" } },
  { id: "bybit", num: { source: "bybit-spot", symbol: "BTCUSDT" } },
  { id: "bitget", num: { source: "bitget", symbol: "BTCUSDT" } },
  { id: "okx", num: { source: "okx", symbol: "BTCUSDT" } },
  { id: "coinbase", num: { source: "coinbase", symbol: "BTCUSDT" } },
  { id: "upbit", num: { source: "upbit", symbol: "BTCKRW" }, den: { source: "upbit", symbol: "USDTKRW" } },
  { id: "coinsph", num: { source: "coinsph", symbol: "BTCPHP" }, den: { source: "coinsph", symbol: "USDTPHP" } },
];

/** Volume venues: the deepest BTC market of each (Coinbase BTC-USD, Upbit KRW-BTC), base volume in BTC. */
export const VOLUME_VENUES: readonly { id: string; leg: Leg }[] = [
  { id: "binance", leg: { source: "binance", symbol: "BTCUSDT" } },
  { id: "bybit", leg: { source: "bybit-spot", symbol: "BTCUSDT" } },
  { id: "bitget", leg: { source: "bitget", symbol: "BTCUSDT" } },
  { id: "okx", leg: { source: "okx", symbol: "BTCUSDT" } },
  { id: "coinbase", leg: { source: "coinbase", symbol: "BTCUSD" } },
  { id: "upbit", leg: { source: "upbit", symbol: "BTCKRW" } },
];

export interface FeedDeps {
  /** Closed bars of one series, newest last (`bars` requested, delta allowed). Honours the venue cooldown. */
  klines: (source: DataSource, interval: string, symbol: string, bars: number, signal?: AbortSignal) => Promise<Kline[]>;
  /** Closed daily bars, newest last, cached per UTC day. */
  daily: (source: DataSource, symbol: string, now: number, signal?: AbortSignal) => Promise<Kline[]>;
}
/** The real feeds (the recorder wraps `daily` with its own per-UTC-day file cache). */
export const realDeps: FeedDeps = {
  klines: (source, interval, symbol, bars, signal) => {
    try { assertNotCoolingDown(source); } catch (e) { return Promise.reject(e); }
    return fetchSymbolKlines(source, interval, symbol, bars, signal, true);
  },
  daily: (source, symbol, now, signal) => loadDailyBars(source, symbol, now, signal),
};

let nowFn: () => number = () => Date.now();
const failedDaily = new Map<string, { at: number; error: unknown }>();
/** Test hook: forget every remembered daily failure. */
export function resetFeedBackoffForTests(): void {
  failedDaily.clear();
}
/** `deps.daily` with a per-series failure back-off (an abort is never remembered). */
function withBackoff(deps: FeedDeps): FeedDeps {
  return {
    ...deps,
    daily: async (source, symbol, now, signal) => {
      const key = `${source}:${symbol}`;
      const failed = failedDaily.get(key);
      if (failed && nowFn() - failed.at < DAILY_BACKOFF_MS) throw failed.error;
      try {
        const bars = await deps.daily(source, symbol, now, signal);
        failedDaily.delete(key);
        return bars;
      } catch (e) {
        if (!isAbort(e, signal)) failedDaily.set(key, { at: nowFn(), error: e });
        throw e;
      }
    },
  };
}
/** Test hook: use `fn` (null = the real clock). */
export function setFeedClockForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}

const isPos = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** open time → close for closed, positive bars. */
function closeMap(bars: Kline[], ms: number, now: number): Map<number, number> {
  const m = new Map<number, number>();
  for (const b of dropUnclosed(bars, ms, now)) if (isPos(b.close) && Number.isFinite(b.time)) m.set(b.time, b.close);
  return m;
}
/** num ÷ den at the open times both have. */
function ratioMap(num: Map<number, number>, den: Map<number, number>): Map<number, number> {
  const m = new Map<number, number>();
  for (const [t, c] of num) {
    const d = den.get(t);
    if (d !== undefined) m.set(t, c / d);
  }
  return m;
}

export interface BreakAwayCloses {
  /** BTC in USD terms, one array per venue with data, oldest first and aligned to `closeTimes` (NaN = the venue lacks that bar). */
  closes: Record<string, number[]>;
  /** Standing premium, %, of the local-currency venues (upbit, coinsph); null = fewer than 20 of the last 30 days, so the venue is left out. */
  standing: Record<string, number | null>;
  /** Venues whose hourly request failed or was cooling down (no closes). */
  unavailable: string[];
  /** Close time (ms) of each aligned bar, oldest first: a run of consecutive hours ending at the newest bar that at least 3 venues have. */
  closeTimes: number[];
  /** True when the newest run does not end at the latest closed hour (fewer than 3 venues have it): no closes are returned. */
  stale: boolean;
}

/**
 * The last closed 1h BTC bars of every venue (up to BREAKAWAY_BARS), aligned by open time; a bar a venue lacks is NaN
 * for that venue. Standing premiums for the local-currency venues come from the last 30 closed daily bars of the same
 * ratio against Binance BTCUSDT (standingPremiumMedian: fewer than 20 days gives null). Never throws except on abort.
 */
export async function fetchBreakAwayCloses(signal?: AbortSignal, rawDeps: FeedDeps = realDeps): Promise<BreakAwayCloses> {
  const deps = withBackoff(rawDeps);
  const now = nowFn();
  const hourly = async (v: Venue): Promise<Map<number, number>> => {
    const num = closeMap(await deps.klines(v.num.source, "1h", v.num.symbol, HOURLY_REQUEST, signal), H, now);
    if (!v.den) return num;
    const den = closeMap(await deps.klines(v.den.source, "1h", v.den.symbol, HOURLY_REQUEST, signal), H, now);
    return ratioMap(num, den);
  };
  const settled = await Promise.allSettled(BREAKAWAY_VENUES.map(hourly));
  for (const r of settled) if (r.status === "rejected" && isAbort(r.reason, signal)) throw r.reason;

  const byVenue = new Map<string, Map<number, number>>();
  const unavailable: string[] = [];
  BREAKAWAY_VENUES.forEach((v, i) => {
    const r = settled[i];
    if (r.status === "fulfilled" && r.value.size) byVenue.set(v.id, r.value);
    else unavailable.push(v.id);
  });

  // Reference bars: the newest run of consecutive hours that at least 3 venues (a candidate and two others) have.
  const count = new Map<number, number>();
  for (const m of byVenue.values()) for (const t of m.keys()) count.set(t, (count.get(t) ?? 0) + 1);
  const times = [...count].filter(([, n]) => n >= 3).map(([t]) => t).sort((a, b) => b - a);
  const run: number[] = [];
  for (const t of times) {
    if (run.length && run[run.length - 1] - t !== H) break;
    run.push(t);
    if (run.length >= BREAKAWAY_BARS) break;
  }
  run.reverse();
  // The run must end at the latest closed hour, or the alert would describe an older market without saying so.
  if (!run.length || run[run.length - 1] + H !== Math.floor(now / H) * H) {
    return { closes: {}, standing: await standingPremiums(new Map(), now, signal, deps), unavailable, closeTimes: [], stale: true };
  }
  const closes: Record<string, number[]> = {};
  for (const [id, m] of byVenue) closes[id] = run.map((t) => m.get(t) ?? NaN);

  const standing = await standingPremiums(byVenue, now, signal, deps);
  return { closes, standing, unavailable, closeTimes: run.map((t) => t + H), stale: false };
}

/**
 * Standing premium per local-currency venue. Basis note: it is measured against Binance's DAILY close, while the
 * hourly comparison is against the median of the other venues, so a small Binance-vs-median basis (typically a few
 * hundredths of a percent) stays in the figure: negligible against a 1 % threshold. Alignment note: every venue's
 * daily bars open at 00:00 UTC (Upbit candle_date_time_utc; OKX/Bitget "1Dutc"; Bybit D; Coinbase 86400; Coins.ph
 * probed 16 Nov 2026: USDTPHP 1d open 2026-11-14T00:00Z), so the ratio and Binance bars match by open time.
 * Null whenever it cannot be had; null whenever it cannot be had (venue down, history short or unavailable). */
async function standingPremiums(
  hourlyOk: Map<string, unknown>,
  now: number,
  signal: AbortSignal | undefined,
  deps: FeedDeps,
): Promise<Record<string, number | null>> {
  const ratioVenues = BREAKAWAY_VENUES.filter((v) => v.den);
  const out: Record<string, number | null> = {};
  for (const v of ratioVenues) out[v.id] = null;
  const live = ratioVenues.filter((v) => hourlyOk.has(v.id));
  if (!live.length) return out;
  let binance: Map<number, number>;
  try {
    binance = closeMap(await deps.daily("binance", "BTCUSDT", now, signal), DAY, now);
  } catch (e) {
    if (isAbort(e, signal)) throw e;
    return out;
  }
  const days = [...binance.keys()].sort((a, b) => a - b).slice(-STANDING_DAYS);
  const settled = await Promise.allSettled(live.map(async (v) => {
    const num = closeMap(await deps.daily(v.num.source, v.num.symbol, now, signal), DAY, now);
    const den = closeMap(await deps.daily(v.den!.source, v.den!.symbol, now, signal), DAY, now);
    const ratio = ratioMap(num, den);
    return standingPremiumMedian(days.map((t) => {
      const r = ratio.get(t);
      const b = binance.get(t);
      return r !== undefined && b !== undefined ? (r / b - 1) * 100 : null;
    }));
  }));
  for (const r of settled) if (r.status === "rejected" && isAbort(r.reason, signal)) throw r.reason;
  live.forEach((v, i) => {
    const r = settled[i];
    if (r.status === "fulfilled") out[v.id] = r.value;
  });
  return out;
}

export interface DailyVolumes {
  /** Summed BTC base volume per day, ascending (the last = the latest closed day). */
  volumes: number[];
  /** Open time (UTC midnight, ms) of each day. */
  days: number[];
  /** True when the last day is yesterday (UTC); fetchDailyVolumes returns [] otherwise. */
  latest: boolean;
  /** Venues whose daily bars could not be had; they are left out of every day of this run. */
  unavailable: string[];
}

/**
 * Daily BTC base volume summed across Binance, Bybit, Bitget, OKX, Coinbase and Upbit from loadDailyBars (cached per
 * UTC day). A day a venue lacks is left out; a venue that cannot be loaded is left out of every day (so each run
 * compares like with like), and with fewer than 4 venues loaded the run is empty. Never throws except on abort.
 */
export async function fetchDailyVolumesDetailed(signal?: AbortSignal, rawDeps: FeedDeps = realDeps): Promise<DailyVolumes> {
  const deps = withBackoff(rawDeps);
  const now = nowFn();
  const settled = await Promise.allSettled(VOLUME_VENUES.map(async (v) => {
    const m = new Map<number, number>();
    for (const b of dropUnclosed(await deps.daily(v.leg.source, v.leg.symbol, now, signal), DAY, now)) {
      if (Number.isFinite(b.time) && typeof b.volume === "number" && Number.isFinite(b.volume) && b.volume >= 0) m.set(b.time, b.volume);
    }
    return m;
  }));
  for (const r of settled) if (r.status === "rejected" && isAbort(r.reason, signal)) throw r.reason;
  const loaded: Map<number, number>[] = [];
  const unavailable: string[] = [];
  VOLUME_VENUES.forEach((v, i) => {
    const r = settled[i];
    if (r.status === "fulfilled" && r.value.size) loaded.push(r.value);
    else unavailable.push(v.id);
  });
  if (loaded.length < VOLUME_MIN_VENUES) return { volumes: [], days: [], latest: false, unavailable };
  const days = [...loaded[0].keys()].filter((t) => loaded.every((m) => m.has(t))).sort((a, b) => a - b).slice(-VOLUME_DAYS_KEPT);
  const latest = days.length > 0 && days[days.length - 1] === Math.floor(now / DAY) * DAY - DAY;
  return { volumes: days.map((t) => loaded.reduce((s, m) => s + (m.get(t) as number), 0)), days, latest, unavailable };
}

/** The summed daily volumes of fetchDailyVolumesDetailed, ascending; [] when the last day is not yesterday (a venue lacks it). */
export async function fetchDailyVolumes(signal?: AbortSignal, deps: FeedDeps = realDeps): Promise<number[]> {
  const d = await fetchDailyVolumesDetailed(signal, deps);
  return d.latest ? d.volumes : [];
}
