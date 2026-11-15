/**
 * upbit.ts — v2.8 Step 2 (plan WP26, Task 5): Upbit spot ("upbit") scan source — KRW, USDT and BTC markets.
 *
 * Public quotation data only: keyless, no account, order, deposit or withdrawal endpoint (R12, R20). Upbit's
 * CORS is unreliable (probe EX-PROBE-1), so EVERY request — browser, native shell and Node (server route
 * /api/market/*, recorder, replay CLI) — goes through `relayGet` (native-relay.ts), which enforces
 * UPBIT_READ_PATHS on every transport. A page uses the same-origin rewrite `/x/upbit/...` and never fetches
 * https://api.upbit.com itself. A refused or missing relay (RelayError, HTTP 404 from a missing rewrite, an
 * unreadable body) is an UpbitFeedError — "feed unavailable" — and never falls back to a direct fetch.
 *
 * Evidence: docs/research/evidence/wp26-venues-probe-2026-11-15.json, `results.upbit`:
 *   - candle paths /v1/candles/minutes/{unit} (1, 3, 5, 10, 15, 30, 60, 240), /days, /weeks, /months; rows
 *     newest first, `{market, candle_date_time_utc, opening_price, high_price, low_price, trade_price,
 *     timestamp, candle_acc_trade_price, candle_acc_trade_volume, unit}`; no open flag — the newest row is the
 *     bar still forming (its timestamp is the latest trade) and is dropped by close time.
 *   - day candles start 00:00 UTC (09:00 KST); /v1/market/all ids are QUOTE-BASE (KRW-BTC, USDT-BTC, BTC-ETH);
 *     KRW-USDT exists.
 * Upbit's docs (https://docs.upbit.com/kr/reference/list-candles-weeks, read 15 Nov 2026): the candle group
 * allows 10 calls per second per IP, `count` max 200, `to` an ISO 8601 time (candles before it — exclusive);
 * /v1/ticker/all needs `quote_currencies` in upper case (KRW,BTC,USDT) and serves `market`, `trade_price`,
 * `opening_price`, `acc_trade_price_24h`, `signed_change_rate`, `timestamp`; the ticker group allows 10/s.
 * The ticker shape is not in the probe (no CORS response) [not verified by probe].
 * Weeks start Monday 00:00 UTC and months on the 1st 00:00 UTC (week example `candle_date_time_utc`
 * "2018-04-16T00:00:00", a Monday, and month "2018-04-01T00:00:00", as quoted from Upbit's docs by the `upbit`
 * Rust crate, docs.rs/crate/upbit, read 15 Nov 2026 [secondary source]) — the same as barCloseTime (calendar
 * months) and the other venues' Monday weeks. Rows that are not on a bucket edge are skipped, so a change of
 * alignment shows as a feed error, never as misaligned bars.
 * Candles exist only for intervals with trades (gaps): pages are merged without duplicates and the newest
 * contiguous run is kept, never padded (a short series is scored cold).
 *
 * Two shared gates at 80 % of the documented 10/s: one for candles (scan, delta, backfill, prefetch), one for
 * /v1/market/all, /v1/ticker/all and /v1/orderbook. 429 and 418 → RateLimitError and the venue "upbit" cooldown.
 *
 * Import cycle: market-client imports this module and this module imports market-client. Nothing here
 * touches a market-client binding at module load — only inside functions — so either load order works.
 */
import type { Kline } from "./indicators";
import { inClass, type AssetClassFilter } from "./asset-classes";
import { rememberPairs, type QuoteMode } from "./quotes";
import { venueIdOf, venueSymbol } from "./venue-ids";
import { createRateGate, realClock, type RateClock, type RateGate } from "./rate-gate";
import { RelayError, relayGet } from "./native-relay";
import { NATIVE_HOSTS, UPBIT_ORIGIN, UPBIT_PROXY_PREFIX, UPBIT_READ_PATHS, type NativeHostRule } from "./public-hosts";
import {
  INTERVAL_MS, RateLimitError, SYNTHETIC_DAY_INTERVALS, aggregateKlines, assertFresh, assertNotCoolingDown, barCloseTime, byUsdDesc,
  clampLimit, contiguousTail, dropUnclosed, filterTickers, noteVenueRateLimit, passesTurnoverFloor, quoteMapOf, splitLiquidity,
  universeOf, type OrderBook, type Picked, type TickerSet,
} from "./market-client";

/** Candles per request (Upbit docs: `count` max 200). */
export const UPBIT_MAX_COUNT = 200;
/** Candle requests one series may make (1,000 bars = 5; 6h = 6 × 60m stops here and returns what it has). */
export const UPBIT_MAX_REQUESTS_PER_SERIES = 16;
/** Pause between candle batches and between the pages of one series; the shared gates are the hard ceiling. */
export const UPBIT_PAUSE_MS = 150;
/** Series fetched at once; the shared candle gate decides how fast their pages actually go. */
export const UPBIT_CONCURRENCY = 2;
/** 80 % of Upbit's documented 10 calls per second per IP, for each of the candle and ticker/market gates. */
export const UPBIT_REQUESTS_PER_S = 8;
/** Markets offered, in Quote-menu order (KRW default). */
const QUOTES = ["KRW", "USDT", "BTC"] as const;

const RULE: NativeHostRule = NATIVE_HOSTS.find((r) => r.origin === UPBIT_ORIGIN) ?? { origin: UPBIT_ORIGIN, paths: UPBIT_READ_PATHS, purpose: "Upbit" };

/* ---------------- errors ---------------- */

/** The Upbit feed cannot be reached through the relay (refused path, missing rewrite, unreadable body, network). */
export class UpbitFeedError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.name = "UpbitFeedError";
    this.kind = kind;
  }
}

/* ---------------- intervals ---------------- */

const MINUTES: Record<string, number> = { "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240 };
const AGGREGATED: Record<string, [string, number]> = { "6h": ["1h", 6], "8h": ["4h", 2], "12h": ["4h", 3] };

/** Native Upbit candle path for a native app interval. */
function nativePath(interval: string): string | null {
  if (MINUTES[interval]) return `/v1/candles/minutes/${MINUTES[interval]}`;
  if (interval === "1d") return "/v1/candles/days";
  if (interval === "1w") return "/v1/candles/weeks";
  if (interval === "1M") return "/v1/candles/months";
  return null;
}

/**
 * Upbit candle path for an app interval. 6h = 6 × 60m, 8h = 2 × 240m, 12h = 3 × 240m and the synthetic 2d/4d
 * (from days) are "aggregated": `aggregate` is set and delta fetch never applies. `baseMs` is the base candle's
 * nominal length (INTERVAL_MS; a 1M bar closes at the next calendar month, see barCloseTime).
 */
export function upbitCandlePath(interval: string): { path: string; aggregate?: number; baseMs: number } | null {
  const native = nativePath(interval);
  if (native) return { path: native, baseMs: INTERVAL_MS[interval] };
  const days = SYNTHETIC_DAY_INTERVALS[interval];
  const agg = days ? (["1d", days] as [string, number]) : AGGREGATED[interval];
  if (!agg) return null;
  return { path: nativePath(agg[0]) as string, aggregate: agg[1], baseMs: INTERVAL_MS[agg[0]] };
}

/** Monday 5 Jan 1970 00:00 UTC: weekly buckets are anchored here (the epoch itself is a Thursday). */
const WEEK_ANCHOR_MS = 4 * 86_400_000;

/** Open time of the `interval` bucket containing `t` (calendar months for 1M, Monday weeks for 1w, else epoch). */
export function upbitBucketStart(interval: string, t: number): number {
  if (interval === "1M") { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }
  const ms = INTERVAL_MS[interval];
  const off = interval === "1w" ? WEEK_ANCHOR_MS : 0;
  return Math.floor((t - off) / ms) * ms + off;
}

/** App interval of a base candle path (for alignment). */
function intervalOfPath(path: string): string {
  if (path.endsWith("/days")) return "1d";
  if (path.endsWith("/weeks")) return "1w";
  if (path.endsWith("/months")) return "1M";
  const unit = Number(path.split("/").pop());
  return Object.keys(MINUTES).find((k) => MINUTES[k] === unit) ?? "";
}

/* ---------------- parsing ---------------- */

interface RawUpbitCandle {
  candle_date_time_utc?: string; opening_price?: number; high_price?: number; low_price?: number; trade_price?: number;
  candle_acc_trade_volume?: number;
}

/** "2026-11-15T04:00:00" (UTC, no zone) → ms; a string that already carries a zone is parsed as it is. */
const utcMs = (s: unknown): number =>
  typeof s === "string" ? Date.parse(/(Z|[+-]\d\d:\d\d)$/.test(s) ? s : `${s}Z`) : NaN;

/**
 * Candle rows → ascending bars: open time = Date.parse(candle_date_time_utc + "Z"), o/h/l/c = opening/high/low/
 * trade_price, volume = candle_acc_trade_volume (base). Rows with a missing or non-numeric field — or, when
 * `interval` is given, not on that interval's bucket edge — are skipped. A body that is not a row array (an
 * error envelope such as `{error: {...}}`) throws.
 */
export function parseUpbitCandles(json: unknown, interval?: string): Kline[] {
  if (!Array.isArray(json)) throw new Error("Upbit candles: unexpected response (no row array)");
  const out: Kline[] = [];
  for (const r of json as RawUpbitCandle[]) {
    if (!r || typeof r !== "object") continue;
    const bar: Kline = {
      time: utcMs(r.candle_date_time_utc), open: Number(r.opening_price), high: Number(r.high_price), low: Number(r.low_price),
      close: Number(r.trade_price), volume: Number(r.candle_acc_trade_volume),
    };
    const fields = [r.opening_price, r.high_price, r.low_price, r.trade_price, r.candle_acc_trade_volume];
    if (fields.some((v) => typeof v !== "number") || ![bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)) continue;
    if (interval && upbitBucketStart(interval, bar.time) !== bar.time) continue;
    out.push(bar);
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Closed bars of one candle response at `now` (the newest row, still forming, is dropped by its close time). */
export function closedUpbitBars(json: unknown, interval: string, now = Date.now()): Kline[] {
  return dropUnclosed(parseUpbitCandles(json, interval), INTERVAL_MS[interval], now);
}

/* ---------------- transport, pacing, errors ---------------- */

let clock: RateClock = realClock;
let candleGate: RateGate = createRateGate(UPBIT_REQUESTS_PER_S, 1000, clock);
let quoteGate: RateGate = createRateGate(UPBIT_REQUESTS_PER_S, 1000, clock);
/** KRW per USDT and USDT per BTC from the last ticker read (order-book valuation only). */
let lastRates: { KRW?: number; BTC?: number } = {};

/** Test hook: use `c` (null = the real clock) for pacing, with fresh gates. */
export function setUpbitClockForTests(c: RateClock | null): void {
  clock = c ?? realClock;
  candleGate = createRateGate(UPBIT_REQUESTS_PER_S, 1000, clock);
  quoteGate = createRateGate(UPBIT_REQUESTS_PER_S, 1000, clock);
}
/** Test hook: fresh gates on the current clock, no remembered rates. */
export function resetUpbitForTests(): void {
  setUpbitClockForTests(clock === realClock ? null : clock);
  lastRates = {};
}

const feedError = (label: string, kind: string, detail: string) =>
  new UpbitFeedError(kind, `${label}: Upbit feed unavailable (${detail}).`);

/**
 * Fail fast on a cooldown, wait for the gate, check the cooldown again (a 429 may have landed meanwhile), then
 * GET through the relay. 429/418 → RateLimitError + the "upbit" cooldown; a relay refusal, a 404 (missing
 * rewrite), any other non-OK status or an unreadable body → UpbitFeedError. Never a direct fetch.
 */
async function upbitGet(pathAndQuery: string, gate: RateGate, label: string, signal?: AbortSignal): Promise<unknown> {
  assertNotCoolingDown("upbit");
  await gate.take(signal);
  assertNotCoolingDown("upbit");
  let res;
  try {
    res = await relayGet(RULE, UPBIT_PROXY_PREFIX, pathAndQuery, signal);
  } catch (e) {
    if (e instanceof RelayError) throw feedError(label, e.kind, e.message);
    throw e; // AbortError
  }
  if (res.status === 429 || res.status === 418) {
    const header = Number(res.headers.get("retry-after"));
    const retryAfterMs = Number.isFinite(header) && header > 0 ? header * 1000 : res.status === 418 ? 600_000 : 60_000;
    const err = new RateLimitError(`${label}: rate limited (Upbit ${res.status}).`, retryAfterMs);
    noteVenueRateLimit("upbit", err);
    throw err;
  }
  if (res.status === 404) throw feedError(label, "HTTP_404", "HTTP 404 — the relay route or the market is missing");
  if (res.status < 200 || res.status >= 300) throw feedError(label, "HTTP", `HTTP ${res.status}`);
  try {
    return await res.json();
  } catch (e) {
    throw feedError(label, "PARSE", e instanceof Error ? e.message : "unreadable response");
  }
}

function marketOrThrow(symbol: string): string {
  const id = venueIdOf("upbit", symbol);
  if (!id || !QUOTES.some((q) => id.startsWith(`${q}-`))) throw new Error(`${symbol}: not an Upbit KRW, USDT or BTC market`);
  return id;
}

/** ISO 8601 UTC, whole seconds ("2026-11-15T04:00:00Z"). */
const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

async function candlePage(market: string, path: string, count: number, to: number, label: string, signal?: AbortSignal): Promise<{ bars: Kline[]; rows: number }> {
  const q = `${path}?market=${encodeURIComponent(market)}&count=${count}&to=${encodeURIComponent(iso(to))}`;
  const json = await upbitGet(q, candleGate, label, signal);
  if (!Array.isArray(json)) throw new Error(`${label}: Upbit candles: unexpected response (no row array)`);
  return { bars: parseUpbitCandles(json, intervalOfPath(path)), rows: json.length };
}

/**
 * Up to `want` base candles opening before `firstTo`, in pages of 200 walking back (`to` = the previous page's
 * oldest open, exclusive), at most UPBIT_MAX_REQUESTS_PER_SERIES requests. A short page is the start of the
 * pair's history; a gap ends the walk (older bars could never join the newest contiguous run). The cooldown
 * is checked before every page, so a 429/418 anywhere stops the series — never a partial series as complete.
 */
async function candlePages(market: string, path: string, baseMs: number, firstTo: number, want: number, label: string, signal?: AbortSignal): Promise<Kline[]> {
  const byTime = new Map<number, Kline>();
  let to = firstTo;
  for (let req = 0; req < UPBIT_MAX_REQUESTS_PER_SERIES && byTime.size < want; req++) {
    if (req > 0) await clock.sleep(UPBIT_PAUSE_MS, signal);
    // After the first page, one extra row covers a venue that repeats the `to` bar (an inclusive bound).
    const n = Math.min(UPBIT_MAX_COUNT, want - byTime.size + (req > 0 ? 1 : 0));
    const { bars, rows } = await candlePage(market, path, n, to, label, signal);
    const before = byTime.size;
    // A bar opening at or after `firstTo` is the one still forming (the venue should not send it): never kept.
    for (const b of bars) if (b.time < firstTo) byTime.set(b.time, b);
    const oldest = bars[0]?.time ?? to;
    if (byTime.size === before || oldest >= to || rows < n) break;
    to = oldest;
    const merged = [...byTime.values()].sort((a, b) => a.time - b.time);
    if (contiguousTail(merged, baseMs).length < merged.length) break;
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * Closed bars of one Upbit series. Native intervals: `bars` (100–1,000; fewer for a delta request), the first
 * page ending before the bar now forming. Aggregated intervals: `bars` × group base candles ending at the last
 * closed bucket, within the request cap (6h at 1,000 bars stops at the cap: 533 bars, scored cold). Open bars
 * are dropped by close time, pages merged without duplicates, the newest contiguous run kept; never padded.
 */
export async function fetchUpbitKlines(symbol: string, interval: string, signal?: AbortSignal, bars = 200, delta = false): Promise<Kline[]> {
  const mapped = upbitCandlePath(interval);
  if (!mapped) throw new Error(`Upbit has no ${interval} candles`);
  const market = marketOrThrow(symbol);
  const now = Date.now();
  const forming = upbitBucketStart(interval, now);
  const count = mapped.aggregate ? clampLimit(bars) : clampLimit(bars, delta);
  const want = mapped.aggregate ? Math.min(UPBIT_MAX_COUNT * UPBIT_MAX_REQUESTS_PER_SERIES, count * mapped.aggregate) : count;
  const raw = await candlePages(market, mapped.path, mapped.baseMs, forming, want, symbol, signal);
  const closed = contiguousTail(dropUnclosed(raw, mapped.baseMs, now), mapped.baseMs);
  const finalSeries = mapped.aggregate
    ? contiguousTail(aggregateKlines(closed, mapped.aggregate, mapped.baseMs), INTERVAL_MS[interval]).slice(-count)
    : closed.slice(-count);
  assertFresh(finalSeries, INTERVAL_MS[interval], symbol);
  return finalSeries;
}

/**
 * One backfill page for fetchHistory / fetchHistoryRange: up to 200 closed candles opening at or before
 * `endTime` (`to` = the next whole second after it, exclusive, at most the open of the bar now forming). `rows` is the venue's raw row count: fewer
 * than 200 is the start of history.
 */
export async function fetchUpbitHistoryPage(symbol: string, path: string, endTime: number, signal?: AbortSignal): Promise<{ bars: Kline[]; rows: number }> {
  const market = marketOrThrow(symbol);
  const now = Date.now();
  const base = intervalOfPath(path);
  const to = Math.min(Math.floor(endTime / 1000) * 1000 + 1000, upbitBucketStart(base, now)); // never asks for the forming bar
  const { bars, rows } = await candlePage(market, path, UPBIT_MAX_COUNT, to, `Upbit history ${symbol}`, signal);
  return { bars: bars.filter((b) => b.time <= endTime && barCloseTime(b.time, INTERVAL_MS[base]) <= now), rows };
}

/* ---------------- universe ---------------- */

interface RawUpbitMarket { market?: string }
/** /v1/ticker/all row — fields from Upbit's docs [not verified by probe]. */
interface RawUpbitTicker { market?: string; trade_price?: number; opening_price?: number; acc_trade_price_24h?: number; signed_change_rate?: number; timestamp?: number }
interface UpbitRow { market: string; symbol: string; base: string; quote: string; t: RawUpbitTicker }

/**
 * USD value of a 24 h quote volume, from Upbit's own markets in the same ticker call (R21, never display FX):
 * KRW → ÷ trade_price(KRW-USDT); USDT → as is; BTC → × trade_price(USDT-BTC). Unknown → NaN.
 */
export function upbitVolumeUsd(quote: string, quoteVolume: number, rates: { KRW?: number; BTC?: number }): number {
  if (!Number.isFinite(quoteVolume)) return NaN;
  if (quote === "USDT") return quoteVolume;
  if (quote === "KRW") return rates.KRW && rates.KRW > 0 ? quoteVolume / rates.KRW : NaN;
  if (quote === "BTC") return rates.BTC && rates.BTC > 0 ? quoteVolume * rates.BTC : NaN;
  return NaN;
}

/**
 * The scan list for Upbit (same parameter order as fetchBybitTickers). /v1/market/all lists the markets;
 * /v1/ticker/all?quote_currencies=KRW,USDT,BTC gives every ticker in one call. USD volume per upbitVolumeUsd —
 * a KRW market's volume is unknown (NaN: ranked last, never clears an active liquidity floor) when KRW-USDT
 * is missing. 24 h change = signed_change_rate × 100 (Upbit measures it from the previous 00:00 UTC close).
 * `quoteCounts` counts KRW, USDT and BTC (pickQuotes counts stablecoins only), so the Quote menu keeps them.
 */
export async function fetchUpbitTickers(
  assets?: string[],
  limit = 100,
  signal?: AbortSignal,
  assetClass: AssetClassFilter = "crypto",
  quote: QuoteMode = "KRW",
  floorUsd = 0,
): Promise<TickerSet> {
  const mode = quote === "USDT" || quote === "BTC" ? quote : "KRW";
  const markets = await upbitGet("/v1/market/all", quoteGate, "Upbit markets", signal);
  if (!Array.isArray(markets)) throw new Error("Upbit markets: unexpected response");
  const tickerJson = await upbitGet(`/v1/ticker/all?quote_currencies=${QUOTES.join(",")}`, quoteGate, "Upbit ticker upstream", signal);
  if (!Array.isArray(tickerJson)) throw new Error("Upbit tickers: unexpected response");
  const listed = new Set((markets as RawUpbitMarket[]).map((m) => (typeof m?.market === "string" ? m.market.toUpperCase() : "")).filter(Boolean));
  const byMarket = new Map<string, RawUpbitTicker>();
  for (const t of tickerJson as RawUpbitTicker[]) if (t && typeof t.market === "string") byMarket.set(t.market.toUpperCase(), t);
  const price = (m: string) => { const v = Number(byMarket.get(m)?.trade_price); return Number.isFinite(v) && v > 0 ? v : undefined; };
  const rates = { KRW: price("KRW-USDT"), BTC: price("USDT-BTC") };
  lastRates = rates;

  const rows: UpbitRow[] = [];
  const seen = new Set<string>();
  for (const market of listed) {
    const [q, base] = market.split("-");
    const t = byMarket.get(market);
    if (!t || !(QUOTES as readonly string[]).includes(q)) continue;
    const symbol = venueSymbol("upbit", market);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    rows.push({ market, symbol, base, quote: q, t });
  }
  rememberPairs("upbit", rows.map((r) => [r.symbol, { base: r.base, quote: r.quote }]));
  const counts: Record<string, number> = {};
  for (const q of QUOTES) { const n = rows.filter((r) => r.quote === q).length; if (n) counts[q] = n; }

  const picked: Picked<UpbitRow>[] = rows.filter((r) => r.quote === mode).map((r) => ({
    t: r, symbol: r.symbol, base: r.base, quote: r.quote, qvUsd: upbitVolumeUsd(r.quote, Number(r.t.acc_trade_price_24h), rates),
  }));
  const ranked = picked.sort(byUsdDesc);
  const usd = (r: { qvUsd: number }) => (Number.isFinite(r.qvUsd) ? r.qvUsd : 0);
  const universe = universeOf("upbit", ranked.map((r) => ({ symbol: r.symbol, qv: usd(r) })));
  const inCls = ranked.filter((r) => inClass("upbit", r.symbol, assetClass));
  const turnover = inCls.filter((r) => passesTurnoverFloor("upbit", r.symbol, usd(r)));
  const { kept: floored, thin: left } = splitLiquidity("upbit", turnover, floorUsd, assets, limit);
  // Final wave: a pair the floor left out because its USD volume is unknown (no KRW-USDT / USDT-BTC price) is not
  // "thin" — the scan line says "unknown US$ volume" for it instead.
  const unknownVol = new Set(turnover.filter((r) => !Number.isFinite(r.qvUsd)).map((r) => r.symbol));
  const thin = left.filter((s) => !unknownVol.has(s));
  const unknownVolume = left.filter((s) => unknownVol.has(s));
  const tickers = floored.map(({ t: r, qvUsd }, i) => {
    const last = Number(r.t.trade_price);
    const rate = Number(r.t.signed_change_rate);
    const open = Number(r.t.opening_price);
    const pct = Number.isFinite(rate) ? rate * 100 : open > 0 && Number.isFinite(last) ? ((last - open) / open) * 100 : 0;
    // An unknown USD volume is sent as "0" (what the ranking and the turnover floor above already count it as), never "NaN".
    return { rank: i + 1, symbol: r.symbol, lastPrice: Number.isFinite(last) ? String(last) : "0", priceChangePercent: pct.toFixed(4), quoteVolume: Number.isFinite(qvUsd) ? String(qvUsd) : "0" };
  });
  return {
    tickers: filterTickers(tickers, assets, limit, "upbit"), universe, basis: {}, belowFloor: inCls.length - turnover.length,
    quoteBySymbol: quoteMapOf(floored), quoteCounts: counts, approx: [], depeg: [], thin, unknownVolume,
  };
}

/* ---------------- order book ---------------- */

/**
 * `/v1/orderbook?markets=KRW-BTC` — `[{market, orderbook_units: [{ask_price, bid_price, ask_size, bid_size}]}]`
 * (Upbit docs [not verified by probe]). Prices are valued in USD at the venue's own KRW-USDT / USDT-BTC price
 * from the last ticker read (as volumes are), so a US$ notional walks the book correctly; no rate → an error.
 */
export async function fetchUpbitOrderBook(symbol: string, signal?: AbortSignal): Promise<OrderBook> {
  const market = marketOrThrow(symbol);
  const quote = market.split("-")[0];
  const toUsd = quote === "USDT" ? 1 : upbitVolumeUsd(quote, 1, lastRates);
  if (!Number.isFinite(toUsd)) throw new Error(`Upbit depth ${symbol}: no ${quote} → USD price from the venue yet`);
  const json = await upbitGet(`/v1/orderbook?markets=${encodeURIComponent(market)}`, quoteGate, `Upbit depth ${symbol}`, signal);
  const units = Array.isArray(json) ? (json[0] as { orderbook_units?: unknown })?.orderbook_units : undefined;
  const bids: [number, number][] = [];
  const asks: [number, number][] = [];
  if (Array.isArray(units)) {
    for (const u of units as Record<string, unknown>[]) {
      const bp = Number(u?.bid_price) * toUsd, bq = Number(u?.bid_size), ap = Number(u?.ask_price) * toUsd, aq = Number(u?.ask_size);
      if (bp > 0 && bq > 0) bids.push([bp, bq]);
      if (ap > 0 && aq > 0) asks.push([ap, aq]);
    }
  }
  return { bids, asks };
}
