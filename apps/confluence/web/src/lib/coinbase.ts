/**
 * coinbase.ts — v2.8 Step 2 (plan WP26, Task 4): Coinbase Exchange spot ("coinbase") scan source.
 *
 * Public market data only: keyless, no account, order or profile endpoint (R12, R20). The host
 * https://api.exchange.coinbase.com is reached by a direct fetch through CSP connect-src (CORS allowed for
 * /products, /products/stats and /products/{id}/candles — probe EX-PROBE-1). The Advanced Trade host is not used.
 *
 * Evidence: docs/research/evidence/wp26-venues-probe-2026-11-15.json, `results.coinbase`:
 *   - candle rows `[time (s), LOW, HIGH, open, close, volume (base)]` — low comes before high — newest first;
 *     granularities 60, 300, 900, 3600, 21600, 86400 only; at most 300 rows per request with start/end.
 *   - no candle is published for an interval with no trades (gaps); there is no open flag, so the newest row
 *     may be the bar still forming and is dropped by its close time.
 *   - /products: `status` and `trading_disabled`; BTC-USDC and ETH-USDC are "delisted", trading disabled
 *     (USDC books are served as USD), so USDC is not offered.
 *   - /products/stats: every product's `stats_24hour {open, high, low, last, volume (base)}` in one call.
 * Rate limits (Coinbase Exchange docs, https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits, read
 * 15 Nov 2026): public endpoints "Requests per second per IP: 10", "in bursts: Up to 15". One shared gate
 * (COINBASE_REQUESTS_PER_S, 80 %) covers EVERY Coinbase request — candles, products, stats, book — from the
 * scan, delta requests, history backfill and the page prefetch.
 *
 * Paging: windows of 300 bars (start = oldest open, end = newest open, both as ISO 8601; the docs' "more than
 * 300 data points is rejected" rule implies an inclusive range [not verified by the probe]) walk back from the
 * last closed bar, at most COINBASE_MAX_REQUESTS_PER_SERIES per series. Overlapping rows are de-duplicated;
 * the merged series keeps its newest contiguous run and is never padded (a short series is scored cold).
 *
 * Import cycle: market-client imports this module and this module imports market-client. Nothing here
 * touches a market-client binding at module load — only inside functions — so either load order works.
 */
import type { Kline } from "./indicators";
import { inClass, type AssetClassFilter } from "./asset-classes";
import { rememberPairs, type QuoteMode } from "./quotes";
import { venueIdOf, venueSymbol } from "./venue-ids";
import { createRateGate, realClock, type RateClock } from "./rate-gate";
import {
  COINBASE_BASE, INTERVAL_MS, SYNTHETIC_DAY_INTERVALS, assertFresh, assertNotCoolingDown, barCloseTime, byUsdDesc, clampLimit,
  contiguousTail, dropUnclosed, fetchJson, filterTickers, passesTurnoverFloor, quoteMapOf, splitLiquidity, universeOf,
  type OrderBook, type Picked, type TickerSet,
} from "./market-client";

/** Candles per request with start/end (probe and docs: 300). */
export const COINBASE_MAX_LIMIT = 300;
/** Candle requests one series may make (4h × 1,000 needs 14; 8h and longer stop here and return what they have). */
export const COINBASE_MAX_REQUESTS_PER_SERIES = 16;
/** Pause between candle batches and between the windows of one series; the shared gate is the hard ceiling. */
export const COINBASE_PAUSE_MS = 150;
/** Series fetched at once; the shared gate decides how fast their windows actually go. */
export const COINBASE_CONCURRENCY = 3;
/** 80 % of Coinbase Exchange's documented 10 public requests per second per IP (bursts up to 15 not used). */
export const COINBASE_REQUESTS_PER_S = 8;
/** Quotes offered (USDC books are delisted on Coinbase Exchange — probe). */
const QUOTES = new Set(["USD", "USDT"]);

const NATIVE: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "6h": 21600, "1d": 86400 };
const AGGREGATED: Record<string, [number, number]> = {
  "4h": [3600, 4], "8h": [3600, 8], "12h": [21600, 2], "1w": [86400, 7], "1M": [86400, 30],
};

/**
 * Coinbase granularity (seconds) for an app interval. 4h/8h/12h/1w/1M and the synthetic 2d/4d are built from
 * shorter candles and are "aggregated": `aggregate` is set and delta fetch never applies. 1w buckets start on
 * Monday 00:00 UTC and 1M buckets are calendar months (as barCloseTime closes a 1M bar); `aggregate` is the
 * nominal size (30 for 1M).
 */
export function coinbaseGranularity(interval: string): { granularity: number; aggregate?: number; baseMs: number } | null {
  const native = NATIVE[interval];
  if (native) return { granularity: native, baseMs: native * 1000 };
  const days = SYNTHETIC_DAY_INTERVALS[interval];
  const agg = days ? ([86400, days] as [number, number]) : AGGREGATED[interval];
  return agg ? { granularity: agg[0], aggregate: agg[1], baseMs: agg[0] * 1000 } : null;
}

/** Monday 5 Jan 1970 00:00 UTC: weekly buckets are anchored here (the epoch itself is a Thursday). */
const WEEK_ANCHOR_MS = 4 * 86_400_000;

/** Open time of the `interval` bucket containing `t` (calendar months for 1M, Monday weeks for 1w). */
function bucketStart(interval: string, t: number): number {
  if (interval === "1M") { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }
  const ms = INTERVAL_MS[interval];
  const off = interval === "1w" ? WEEK_ANCHOR_MS : 0;
  return Math.floor((t - off) / ms) * ms + off;
}
/** Open time of the bucket `n` buckets before the one opening at `start`. */
function bucketsBack(interval: string, start: number, n: number): number {
  if (interval === "1M") { const d = new Date(start); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 1); }
  return start - n * INTERVAL_MS[interval];
}

/**
 * Base bars → `interval` bars. Only complete buckets are built (every base bar present), so a bucket with a
 * no-trade gap, or the bucket still forming, is never shown. Ascending; times are bucket open times.
 */
export function aggregateCoinbase(klines: Kline[], interval: string, baseMs: number): Kline[] {
  const buckets = new Map<number, Kline[]>();
  for (const c of [...klines].sort((a, b) => a.time - b.time)) {
    const key = bucketStart(interval, c.time);
    const g = buckets.get(key);
    if (g) g.push(c); else buckets.set(key, [c]);
  }
  const out: Kline[] = [];
  for (const [time, group] of [...buckets.entries()].sort(([a], [b]) => a - b)) {
    const size = interval === "1M" ? (barCloseTime(time, INTERVAL_MS["1M"]) - time) / baseMs : INTERVAL_MS[interval] / baseMs;
    if (group.length !== size) continue;
    out.push({
      time,
      open: group[0].open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((sum, c) => sum + c.volume, 0),
    });
  }
  return out;
}

/**
 * Candle rows → ascending bars. Coinbase rows are `[time (s), low, high, open, close, volume]`: mapped
 * explicitly (low before high). Rows with a non-numeric field are skipped; a response that is not a row
 * array (an error body such as `{message}`) throws.
 */
export function parseCoinbaseCandles(json: unknown): Kline[] {
  if (!Array.isArray(json)) throw new Error("Coinbase candles: unexpected response (no row array)");
  const out: Kline[] = [];
  for (const r of json) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const raw = r.slice(0, 6);
    if (raw.some((v) => typeof v === "string" ? v.trim() === "" : typeof v !== "number")) continue;
    const bar: Kline = {
      time: Number(r[0]) * 1000, low: Number(r[1]), high: Number(r[2]), open: Number(r[3]), close: Number(r[4]), volume: Number(r[5]),
    };
    if (![bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)) continue;
    out.push(bar);
  }
  return out.sort((a, b) => a.time - b.time);
}

/* ---------------- shared pacing ---------------- */

let clock: RateClock = realClock;
/** One gate for the whole host: every Coinbase request shares one per-IP limit. */
let gate = createRateGate(COINBASE_REQUESTS_PER_S, 1000, clock);

/** Test hook: use `c` (null = the real clock) for pacing, with a fresh gate. */
export function setCoinbaseClockForTests(c: RateClock | null): void {
  clock = c ?? realClock;
  gate = createRateGate(COINBASE_REQUESTS_PER_S, 1000, clock);
}
/** Test hook: a fresh gate on the current clock. */
export function resetCoinbaseForTests(): void {
  setCoinbaseClockForTests(clock === realClock ? null : clock);
}

/** Fail fast on a cooldown, wait for the gate, check the cooldown again (a 429 may have landed meanwhile), fetch. */
async function pacedJson(path: string, label: string, signal?: AbortSignal): Promise<unknown> {
  assertNotCoolingDown("coinbase");
  await gate.take(signal);
  assertNotCoolingDown("coinbase");
  return fetchJson(`${COINBASE_BASE}${path}`, label, signal);
}

function productIdOrThrow(symbol: string): string {
  const id = venueIdOf("coinbase", symbol);
  if (!id) throw new Error(`${symbol}: not a Coinbase USD or USDT pair`);
  return id;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** One candle window: bars opening in [oldest, newest] (ms), as returned (open bars included). */
async function candleWindow(productId: string, granularity: number, oldest: number, newest: number, label: string, signal?: AbortSignal): Promise<Kline[]> {
  const path = `/products/${encodeURIComponent(productId)}/candles?granularity=${granularity}&start=${iso(oldest)}&end=${iso(newest)}`;
  return parseCoinbaseCandles(await pacedJson(path, label, signal));
}

/**
 * Up to `want` bar slots ending at the bar opening at `newest`, in windows of 300 walking back, at most
 * COINBASE_MAX_REQUESTS_PER_SERIES requests. An empty window ends the walk (nothing older: the pair is new).
 * The cooldown is checked before every window, so a 429 anywhere stops the series with a RateLimitError —
 * never a partial series returned as complete.
 */
async function closedWindows(productId: string, granularity: number, newest: number, want: number, label: string, signal?: AbortSignal): Promise<Kline[]> {
  const g = granularity * 1000;
  const byTime = new Map<number, Kline>();
  let end = newest;
  let walked = 0;
  for (let req = 0; req < COINBASE_MAX_REQUESTS_PER_SERIES && walked < want; req++) {
    if (req > 0) await clock.sleep(COINBASE_PAUSE_MS, signal);
    const n = Math.min(COINBASE_MAX_LIMIT, want - walked);
    const start = end - (n - 1) * g;
    const rows = await candleWindow(productId, granularity, start, end, label, signal);
    if (!rows.length) break;
    for (const b of rows) byTime.set(b.time, b);
    walked += n;
    end = start - g;
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * Closed bars of one Coinbase series. Native intervals: `bars` (100–1,000; fewer for a delta request).
 * Aggregated intervals: enough base bars for `bars` complete buckets, ending at the last closed bucket, within
 * the request cap (8h, 1w, 1M at 1,000 bars stop at the cap and return fewer, scored cold). Pages are merged
 * without duplicates, open bars dropped by close time, and the newest contiguous run kept; never padded.
 */
export async function fetchCoinbaseKlines(symbol: string, interval: string, signal?: AbortSignal, bars = 200, delta = false): Promise<Kline[]> {
  const mapped = coinbaseGranularity(interval);
  if (!mapped) throw new Error(`Coinbase has no ${interval} candles`);
  const productId = productIdOrThrow(symbol);
  const now = Date.now();
  const forming = bucketStart(interval, now); // open time of the bar (bucket) now forming
  const newest = forming - mapped.baseMs; // last base bar of the last closed bucket
  const count = mapped.aggregate ? clampLimit(bars) : clampLimit(bars, delta);
  const want = mapped.aggregate
    ? Math.min(COINBASE_MAX_LIMIT * COINBASE_MAX_REQUESTS_PER_SERIES, Math.round((forming - bucketsBack(interval, forming, count)) / mapped.baseMs))
    : count;
  const raw = await closedWindows(productId, mapped.granularity, newest, want, symbol, signal);
  const closed = contiguousTail(dropUnclosed(raw, mapped.baseMs, now), mapped.baseMs);
  const finalSeries = mapped.aggregate
    ? contiguousTail(aggregateCoinbase(closed, interval, mapped.baseMs), INTERVAL_MS[interval]).slice(-count)
    : closed.slice(-count);
  assertFresh(finalSeries, INTERVAL_MS[interval] ?? mapped.baseMs, symbol);
  return finalSeries;
}

/**
 * One backfill page for fetchHistory / fetchHistoryRange: closed bars opening at or before `endTime`, one window
 * of 300. `rows` is the window size whenever any candle came back: a short window means no-trade intervals,
 * not the end of history — only an empty window ends it.
 */
export async function fetchCoinbaseHistoryPage(symbol: string, granularity: number, endTime: number, signal?: AbortSignal): Promise<{ bars: Kline[]; rows: number }> {
  const g = granularity * 1000;
  const now = Date.now();
  const productId = productIdOrThrow(symbol);
  const newest = Math.min(Math.floor(endTime / g) * g, Math.floor(now / g) * g - g);
  const k = await candleWindow(productId, granularity, newest - (COINBASE_MAX_LIMIT - 1) * g, newest, `Coinbase history ${symbol}`, signal);
  return { bars: k.filter((b) => b.time <= endTime && barCloseTime(b.time, g) <= now), rows: k.length ? COINBASE_MAX_LIMIT : 0 };
}

/* ---------------- universe ---------------- */

/** /products row. `base_currency` follows `quote_currency` (named in the plan) [base_currency not verified by the probe]. */
interface RawCoinbaseProduct { id?: string; base_currency?: string; quote_currency?: string; status?: string; trading_disabled?: boolean }
interface RawCoinbaseStats { stats_24hour?: { open?: string; last?: string; volume?: string } }
interface CoinbaseRow { id: string; symbol: string; base: string; quote: string; stats: NonNullable<RawCoinbaseStats["stats_24hour"]> }

/**
 * The scan list for Coinbase (same parameter order as fetchBybitTickers). `/products` keeps `status "online"`,
 * `trading_disabled false` and USD or USDT quotes; `/products/stats` gives `stats_24hour` for all of them in
 * one call. USD volume = volume × last (USDT at 1 USD, as on every venue); 24 h change = (last − open) / open × 100.
 * `quoteCounts` counts plain USD as well as USDT (pickQuotes counts stablecoins only), so the Quote menu keeps USD.
 */
export async function fetchCoinbaseTickers(
  assets?: string[],
  limit = 100,
  signal?: AbortSignal,
  assetClass: AssetClassFilter = "crypto",
  quote: QuoteMode = "USD",
  floorUsd = 0,
): Promise<TickerSet> {
  const mode = quote === "USDT" ? "USDT" : "USD";
  const products = await pacedJson("/products", "Coinbase products", signal);
  if (!Array.isArray(products)) throw new Error("Coinbase products: unexpected response");
  const stats = (await pacedJson("/products/stats", "Coinbase ticker upstream", signal)) as Record<string, RawCoinbaseStats> | null;
  if (!stats || typeof stats !== "object" || Array.isArray(stats)) throw new Error("Coinbase stats: unexpected response");
  const rows: CoinbaseRow[] = [];
  const seen = new Set<string>();
  for (const p of products as RawCoinbaseProduct[]) {
    if (!p || typeof p.id !== "string" || p.status !== "online" || p.trading_disabled !== false) continue;
    const [idBase, idQuote] = p.id.toUpperCase().split("-");
    const q = String(p.quote_currency ?? idQuote ?? "").toUpperCase();
    if (!QUOTES.has(q)) continue;
    const symbol = venueSymbol("coinbase", p.id);
    const s = Object.prototype.hasOwnProperty.call(stats, p.id) ? stats[p.id]?.stats_24hour : undefined;
    if (!symbol || !s || seen.has(symbol)) continue; // two ids that join to one symbol: the first (listed) wins
    seen.add(symbol);
    rows.push({ id: p.id, symbol, base: String(p.base_currency ?? idBase).toUpperCase(), quote: q, stats: s });
  }
  rememberPairs("coinbase", rows.map((r) => [r.symbol, { base: r.base, quote: r.quote }]));
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.quote] = (counts[r.quote] ?? 0) + 1;
  const lastOf = (r: CoinbaseRow) => parseFloat(r.stats.last ?? "");
  const picked: Picked<CoinbaseRow>[] = rows.filter((r) => r.quote === mode).map((r) => {
    const qv = parseFloat(r.stats.volume ?? "") * lastOf(r);
    return { t: r, symbol: r.symbol, base: r.base, quote: r.quote, qvUsd: Number.isFinite(qv) ? qv : NaN };
  });
  const ranked = picked.sort(byUsdDesc);
  const usd = (r: { qvUsd: number }) => (Number.isFinite(r.qvUsd) ? r.qvUsd : 0);
  const universe = universeOf("coinbase", ranked.map((r) => ({ symbol: r.symbol, qv: usd(r) })));
  const inCls = ranked.filter((r) => inClass("coinbase", r.symbol, assetClass));
  const turnover = inCls.filter((r) => passesTurnoverFloor("coinbase", r.symbol, usd(r)));
  const { kept: floored, thin } = splitLiquidity("coinbase", turnover, floorUsd, assets, limit);
  const tickers = floored.map(({ t: r, qvUsd }, i) => {
    const open = parseFloat(r.stats.open ?? "");
    const lastPx = lastOf(r);
    const pct = open > 0 && Number.isFinite(lastPx) ? ((lastPx - open) / open) * 100 : 0;
    return { rank: i + 1, symbol: r.symbol, lastPrice: r.stats.last ?? "0", priceChangePercent: pct.toFixed(4), quoteVolume: String(usd({ qvUsd })) };
  });
  return {
    tickers: filterTickers(tickers, assets, limit, "coinbase"), universe, basis: {}, belowFloor: inCls.length - turnover.length,
    quoteBySymbol: quoteMapOf(floored), quoteCounts: counts, approx: [], depeg: [], thin,
  };
}

/* ---------------- order book ---------------- */

const levels = (rows: unknown): [number, number][] =>
  Array.isArray(rows)
    ? (rows as unknown[][]).map((r) => [Number(r?.[0]), Number(r?.[1])] as [number, number]).filter(([p, q]) => p > 0 && q > 0)
    : [];

/** `/products/{id}/book?level=2` — rows `[price, size, num-orders]` (Coinbase docs [not verified by the probe]). */
export async function fetchCoinbaseOrderBook(symbol: string, signal?: AbortSignal): Promise<OrderBook> {
  const productId = productIdOrThrow(symbol);
  const j = (await pacedJson(`/products/${encodeURIComponent(productId)}/book?level=2`, `Coinbase depth ${symbol}`, signal)) as { bids?: unknown; asks?: unknown };
  return { bids: levels(j?.bids), asks: levels(j?.asks) };
}
