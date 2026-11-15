/**
 * okx.ts — v2.8 Step 2 (plan WP26, Task 3): OKX spot ("okx") and USDT-margined perpetual ("okx-perp") scan sources.
 *
 * Public market data only: keyless, no account or order endpoint (R12, R20). The host is reached by a direct
 * fetch through CSP connect-src (CORS allowed for every path used here — probe EX-PROBE-1).
 *
 * Evidence: docs/research/evidence/wp26-venues-probe-2026-11-15.json, `results.okx`:
 *   - candle rows `[ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]`, newest first; confirm "0" = the bar
 *     is still open, "1" = closed. For SWAP, `vol` is contracts and `volCcy` the base coin.
 *   - 300 rows per request on both candle paths (limit=500 is capped to 300); `after=<ts>` returns bars
 *     strictly older than ts.
 *   - 8H is rejected (code 51000); 1D is cut on UTC+8, so the `…utc` bars are used for 6h and longer.
 *   - SPOT `volCcy24h` is quote volume; SWAP `volCcy24h` is base coin (BTC-USDT-SWAP 207733.5 BTC).
 * Rate limits are not readable from a page and were not confirmed at OKX's documentation in this build:
 * the pacing below is deliberately conservative [not verified].
 *
 * Import cycle: market-client imports this module and this module imports market-client. Nothing here
 * touches a market-client binding at module load — only inside functions — so either load order works.
 */
import type { Kline } from "./indicators";
import { inClass, type AssetClassFilter } from "./asset-classes";
import { DEFAULT_QUOTE, rememberPairs, type QuoteMode } from "./quotes";
import { venueIdOf, venueSymbol } from "./venue-ids";
import {
  INSTRUMENT_TTL_MS, INTERVAL_MS, OKX_BASE, RateLimitError, SYNTHETIC_DAY_INTERVALS, aggregateKlines, assertFresh,
  assertNotCoolingDown, byUsdDesc, clampLimit, contiguousTail, dropUnclosed, fetchJson, filterTickers, passesTurnoverFloor,
  pickQuotes, quoteMapOf, splitLiquidity, universeOf, type OrderBook, type TickerSet,
} from "./market-client";

export type OkxSource = "okx" | "okx-perp";

/** Rows per candle request on /market/candles and /market/history-candles (probe: limit=500 → 300). */
export const OKX_MAX_LIMIT = 300;
/** Pause between candle batches and between the pages of one series (rate limit [not verified]; conservative). */
export const OKX_PAUSE_MS = 120;
/** Series fetched at once (rate limit [not verified]; conservative). */
export const OKX_CONCURRENCY = 4;
/** OKX's rate-limit code ("Too Many Requests") — sent with HTTP 429; also honoured in a 200 envelope [not verified]. */
export const OKX_RATE_LIMIT_CODE = "50011";

const NATIVE_BARS: Record<string, string> = {
  "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H",
  "6h": "6Hutc", "12h": "12Hutc", "1d": "1Dutc", "1w": "1Wutc", "1M": "1Mutc",
};

/**
 * OKX bar for an app interval. 8h is two 4H bars and 2d/4d are synthetic days from 1Dutc (the existing
 * SYNTHETIC_DAY_INTERVALS path); those are "aggregated" — `aggregate` is set and delta fetch never applies.
 */
export function okxBar(interval: string): { bar: string; aggregate?: number; baseMs: number } | null {
  if (interval === "8h") return { bar: "4H", aggregate: 2, baseMs: INTERVAL_MS["4h"] };
  const days = SYNTHETIC_DAY_INTERVALS[interval];
  if (days) return { bar: "1Dutc", aggregate: days, baseMs: INTERVAL_MS["1d"] };
  const bar = NATIVE_BARS[interval];
  return bar ? { bar, baseMs: INTERVAL_MS[interval] } : null;
}

/**
 * Candle rows (a whole response or its `data` array) → ascending bars, with `open[i]` true when row i is
 * flagged confirm "0" (still forming). Spot volume is `vol` (base coin); perp volume is `volCcy` (base coin —
 * `vol` counts contracts). Rows with a non-numeric field are skipped; a response without rows throws.
 */
export function parseOkxCandles(json: unknown, perp = false): { k: Kline[]; open: boolean[] } {
  const rows = Array.isArray(json) ? json : (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) throw new Error("OKX candles: unexpected response (no data array)");
  const out: { bar: Kline; open: boolean }[] = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 7) continue;
    const bar: Kline = {
      time: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]),
      volume: Number(perp ? r[6] : r[5]),
    };
    if (![bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) || String(r[0]).trim() === "") continue;
    out.push({ bar, open: String(r[8]) === "0" });
  }
  out.sort((a, b) => a.bar.time - b.bar.time);
  return { k: out.map((o) => o.bar), open: out.map((o) => o.open) };
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (!(ms > 0) || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(id); signal?.removeEventListener("abort", done); resolve(); };
    const id = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function instIdOrThrow(source: OkxSource, symbol: string): string {
  const id = venueIdOf(source, symbol);
  if (!id) throw new Error(`${symbol}: not an OKX ${source === "okx-perp" ? "USDT perpetual" : "spot"} pair`);
  return id;
}

/**
 * Up to `want` CLOSED bars, newest first page `/market/candles`, older pages `/market/history-candles?after=`.
 * Stops when `want` closed bars are collected or a page is empty. The venue cooldown is checked before every
 * page, so a 429 anywhere (this series or another one in flight) stops the series: a RateLimitError, never a
 * partial series returned as complete.
 */
async function closedPages(source: OkxSource, instId: string, bar: string, want: number, label: string, signal?: AbortSignal): Promise<Kline[]> {
  const perp = source === "okx-perp";
  const byTime = new Map<number, Kline>();
  const maxPages = Math.ceil(want / (OKX_MAX_LIMIT - 1)) + 1;
  let after: number | null = null;
  for (let page = 0; page < maxPages && byTime.size < want; page++) {
    if (page > 0) await pause(OKX_PAUSE_MS, signal);
    assertNotCoolingDown(source);
    // +1: the newest page usually carries the bar still forming, which is dropped.
    const limit = Math.min(OKX_MAX_LIMIT, want - byTime.size + 1);
    const q = `instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${limit}`;
    const url = after === null
      ? `${OKX_BASE}/api/v5/market/candles?${q}`
      : `${OKX_BASE}/api/v5/market/history-candles?${q}&after=${after}`;
    const { k, open } = parseOkxCandles(await fetchJson(url, `OKX klines ${label}`, signal), perp);
    if (!k.length) break;
    k.forEach((b, i) => { if (!open[i]) byTime.set(b.time, b); });
    const oldest = k[0].time;
    if (after !== null && oldest >= after) break; // no progress: never loop on a misbehaving page
    after = oldest;
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * Closed bars of one OKX series. Native bars: `bars` (100–1,000; fewer for a delta request). Aggregated
 * intervals read enough base bars for `bars` buckets (at most 1,000 base bars, like Bybit/Binance) and are
 * epoch-aggregated. Merged pages are de-duplicated, sorted and trimmed to the newest contiguous run; a pair
 * with less history returns what exists (scored cold), never padded.
 */
export async function fetchOkxKlines(
  source: OkxSource,
  symbol: string,
  interval: string,
  signal?: AbortSignal,
  bars = 200,
  delta = false,
): Promise<Kline[]> {
  const mapped = okxBar(interval);
  if (!mapped) throw new Error(`OKX has no ${interval} candles`);
  const instId = instIdOrThrow(source, symbol);
  const want = mapped.aggregate
    ? Math.min(1000, clampLimit(bars) * mapped.aggregate + mapped.aggregate)
    : clampLimit(bars, delta);
  const raw = await closedPages(source, instId, mapped.bar, want, symbol, signal);
  const closed = contiguousTail(dropUnclosed(raw, mapped.baseMs), mapped.baseMs);
  const finalSeries = mapped.aggregate
    ? aggregateKlines(closed, mapped.aggregate, mapped.baseMs).slice(-clampLimit(bars))
    : closed.slice(-want);
  assertFresh(finalSeries, INTERVAL_MS[interval] ?? mapped.baseMs, symbol);
  return finalSeries;
}

/**
 * One backfill page for fetchHistory / fetchHistoryRange: bars strictly older than `endTime + 1` (OKX `after`),
 * open bars removed. `rows` is the raw row count, so a page that only lost its open bar is not taken for the
 * end of history.
 */
export async function fetchOkxHistoryPage(source: OkxSource, symbol: string, bar: string, endTime: number, signal?: AbortSignal): Promise<{ bars: Kline[]; rows: number }> {
  assertNotCoolingDown(source);
  const instId = instIdOrThrow(source, symbol);
  const url = `${OKX_BASE}/api/v5/market/history-candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${OKX_MAX_LIMIT}&after=${Math.floor(endTime) + 1}`;
  const { k, open } = parseOkxCandles(await fetchJson(url, `OKX history ${symbol}`, signal), source === "okx-perp");
  return { bars: k.filter((_, i) => !open[i]), rows: k.length };
}

/* ---------------- universe ---------------- */

interface RawOkxTicker { instId: string; last: string; open24h?: string; vol24h?: string; volCcy24h?: string }
interface RawOkxInstrument { instId: string; ctType?: string; ctVal?: string; state?: string }
interface OkxRow { t: RawOkxTicker; symbol: string }

/** Live linear USDT swaps (instId → contract value in base coin), read once per INSTRUMENT_TTL_MS. */
let swapMeta: { at: number; live: Map<string, { ctVal: number }> } | null = null;

/** Test hook: forget the cached instrument list. */
export function resetOkxForTests(): void {
  swapMeta = null;
}

/**
 * `/api/v5/public/instruments?instType=SWAP`, keeping `ctType linear`, `state live`, `*-USDT-SWAP` only.
 * A failure other than a rate limit or an abort returns null (the caller decides what that means).
 */
export async function loadOkxSwapInstruments(signal?: AbortSignal): Promise<Map<string, { ctVal: number }> | null> {
  if (swapMeta && Date.now() - swapMeta.at < INSTRUMENT_TTL_MS) return swapMeta.live;
  try {
    const j = (await fetchJson(`${OKX_BASE}/api/v5/public/instruments?instType=SWAP`, "OKX instruments", signal)) as { data?: RawOkxInstrument[] };
    const live = new Map<string, { ctVal: number }>();
    for (const it of j.data ?? []) {
      if (it.ctType !== "linear" || it.state !== "live" || !venueSymbol("okx-perp", it.instId)) continue;
      live.set(it.instId, { ctVal: Number(it.ctVal) });
    }
    swapMeta = { at: Date.now(), live };
    return live;
  } catch (error) {
    if (error instanceof RateLimitError || (error instanceof DOMException && error.name === "AbortError")) throw error;
    return null;
  }
}

/**
 * The scan list for OKX (same parameter order as fetchBybitTickers, with the source first).
 * Spot: `/market/tickers?instType=SPOT`, USD volume = `volCcy24h` (quote volume; USDC converted at USDC-USDT
 * by pickQuotes). Perp: `instType=SWAP`, live linear `*-USDT-SWAP` only, USD volume = `volCcy24h × last`
 * (`volCcy24h` is base coin for SWAP). 24 h change = (last − open24h) / open24h × 100. The perp basis stays
 * undefined (no mark-price call in Step 2), so an OKX perp is never band-pinned by basis.
 */
export async function fetchOkxTickers(
  source: OkxSource,
  assets?: string[],
  limit = 200,
  signal?: AbortSignal,
  assetClass: AssetClassFilter = "crypto",
  quote: QuoteMode = DEFAULT_QUOTE,
  floorUsd = 0,
): Promise<TickerSet> {
  const perp = source === "okx-perp";
  // Without the instrument list (a transient failure) the -USDT-SWAP id alone still names a linear USDT
  // swap (OKX's inverse swaps are -USD-SWAP); live state is then taken from the ticker being listed.
  const live = perp ? await loadOkxSwapInstruments(signal) : null;
  const json = (await fetchJson(`${OKX_BASE}/api/v5/market/tickers?instType=${perp ? "SWAP" : "SPOT"}`, "OKX ticker upstream", signal)) as { data?: RawOkxTicker[] };
  const rows: OkxRow[] = [];
  const seen = new Set<string>();
  const pairs: [string, { base: string; quote: string }][] = [];
  for (const t of json.data ?? []) {
    if (!t || typeof t.instId !== "string") continue;
    const symbol = venueSymbol(source, t.instId);
    if (!symbol || seen.has(symbol)) continue; // two ids that join to one symbol: the first (listed) wins
    if (perp && live && !live.has(t.instId)) continue;
    seen.add(symbol);
    rows.push({ t, symbol });
    const [base, q] = t.instId.toUpperCase().split("-");
    pairs.push([symbol, { base, quote: q }]);
  }
  rememberPairs(source, pairs);
  const lastOf = (r: OkxRow) => parseFloat(r.t.last);
  const qvOf = (r: OkxRow) => {
    const v = parseFloat(r.t.volCcy24h ?? "") || 0;
    return perp ? v * (lastOf(r) || 0) : v;
  };
  const picked = pickQuotes(source, rows, (r) => r.symbol, qvOf, lastOf, quote);
  const ranked = picked.rows.sort(byUsdDesc);
  const usd = (r: { qvUsd: number }) => (Number.isFinite(r.qvUsd) ? r.qvUsd : 0);
  const universe = universeOf(source, ranked.map((r) => ({ symbol: r.symbol, qv: usd(r) })));
  const inCls = ranked.filter((r) => inClass(source, r.symbol, assetClass));
  const turnover = inCls.filter((r) => passesTurnoverFloor(source, r.symbol, usd(r)));
  const { kept: floored, thin } = splitLiquidity(source, turnover, floorUsd, assets, limit);
  const tickers = floored.map(({ t: r, qvUsd }, i) => {
    const open = parseFloat(r.t.open24h ?? "");
    const lastPx = lastOf(r);
    const pct = open > 0 && Number.isFinite(lastPx) ? ((lastPx - open) / open) * 100 : 0;
    return {
      rank: i + 1,
      symbol: r.symbol,
      lastPrice: r.t.last,
      priceChangePercent: pct.toFixed(4),
      quoteVolume: quote === "USDT" && !perp ? (r.t.volCcy24h ?? "0") : String(qvUsd),
    };
  });
  return {
    tickers: filterTickers(tickers, assets, limit, source), universe, basis: {}, belowFloor: inCls.length - turnover.length,
    quoteBySymbol: quoteMapOf(floored), quoteCounts: picked.counts, approx: picked.approx, depeg: picked.depeg, thin,
  };
}

/* ---------------- order book ---------------- */

const levels = (rows: unknown, mult: number): [number, number][] =>
  Array.isArray(rows)
    ? (rows as unknown[][])
        .map((r) => [Number(r?.[0]), Number(r?.[1]) * mult] as [number, number])
        .filter(([p, q]) => p > 0 && q > 0)
    : [];

/**
 * `/api/v5/market/books?instId=&sz=100`. Perp sizes are contracts and are converted to base coin with the
 * instrument's `ctVal`, so slippage is measured on the same notional as spot.
 */
export async function fetchOkxOrderBook(source: OkxSource, symbol: string, signal?: AbortSignal): Promise<OrderBook> {
  assertNotCoolingDown(source);
  const instId = instIdOrThrow(source, symbol);
  let mult = 1;
  if (source === "okx-perp") {
    const ctVal = (await loadOkxSwapInstruments(signal))?.get(instId)?.ctVal ?? NaN;
    if (!(ctVal > 0)) throw new Error(`OKX depth ${symbol}: contract size unknown`);
    mult = ctVal;
  }
  const j = (await fetchJson(`${OKX_BASE}/api/v5/market/books?instId=${encodeURIComponent(instId)}&sz=100`, `OKX depth ${symbol}`, signal)) as { data?: { bids?: unknown; asks?: unknown }[] };
  const book = Array.isArray(j.data) ? j.data[0] : undefined;
  return { bids: levels(book?.bids, mult), asks: levels(book?.asks, mult) };
}
