import { normalizePublicTrades, type PublicTrade } from "./order-flow";
/**
 * market-client.ts
 * ----------------------------------------------------------------------------
 * Multi-source market-data layer for the Confluence Terminal.
 *
 * Build 1.9 correctness guarantees:
 *
 *  1. CLOSED BARS ONLY. Every provider returns the in-progress candle as the
 *     final array element. We drop it. Downstream indicators therefore compute
 *     on a bar that cannot change, which is what stops signals repainting.
 *
 *  2. EPOCH-ANCHORED AGGREGATION. Synthetic 2d/4d/8h candles are bucketed by
 *     absolute timestamp, not by position in the returned array. Index-based
 *     grouping re-paired every candle each time the window slid forward, which
 *     silently redefined historical bars from one day to the next.
 *
 *  3. FRESHNESS GATE. A series whose newest closed bar is older than
 *     MAX_STALENESS_BARS is rejected with a typed reason rather than being
 *     rendered as a confident signal on stale data.
 *
 *  4. NO SILENT FALLBACK. A failed server proxy no longer re-issues the whole
 *     scan from the browser. That escalation turned a transient server error
 *     into a rate-limit ban on the operator's own IP.
 *
 * Build 2.02:
 *
 *  5. THE FETCH PATH IS DECIDED AT BUILD TIME. Static exports (HTML / PWA /
 *     Electron / Capacitor) have no /api routes — build-html.mjs removes them —
 *     so they always fetch directly. Only a server build uses the proxy. 2.01
 *     decided by URL scheme, so a static export served over http(s) (Netlify
 *     Drop, the 1-click localhost launchers) called a proxy that did not exist
 *     and then refused to fetch at all.
 *
 *  6. CALENDAR-CORRECT BAR CLOSE. Monthly bars close at the next calendar
 *     month, not after a fixed 30 days (2.01 scored the unfinished month on the
 *     31st and dropped a finished February until 3 March).
 *
 *  7. CONTIGUITY. `contiguousTail` trims a merged history to the newest run of
 *     bars with no missing intervals, so stored history plus fresh candles can
 *     never be scored as one continuous series across a hole.
 *
 * v2.1.1:
 *
 *  8. RATE LIMITS STOP THE SCAN. HTTP 429/418 (Binance, Bitget) and Bybit's
 *     retCode 10006/10018 raise RateLimitError. The scan stops issuing requests
 *     at once, keeps what it already has, and refuses new scans until the
 *     Retry-After window (default 60 s; 10 min after a 418 ban) has passed.
 *     Error payloads with HTTP 200 (Bybit retCode ≠ 0, Bitget code ≠ "00000")
 *     are no longer parsed as empty candle lists.
 *
 *  9. WARM START. `klineLimit(symbol)` lets the caller ask for up to 1,000
 *     bars for series it has no stored history for, so the engine sees its
 *     full fixed window on the first scan (no warm-up bias), and 200 bars
 *     otherwise.
 *
 * v2.3:
 *
 * 11. UNIVERSE LOG. Every scan also returns the FULL unfiltered venue ranking
 *     (all classes, top 300 by 24 h quote volume) so the ledger can record
 *     what the top-N looked like at each bar (survivorship / rank look-ahead).
 * 12. TURNOVER FLOOR. Non-crypto instruments (tokenised stocks, FX, commodity,
 *     RWA) need ≥ MIN_QUOTE_VOLUME_NONCRYPTO of 24 h quote volume to be scored.
 * 13. BITGET USDT PERPETUALS (source "bitget-perp", v2 mix endpoints — field
 *     names NOT VERIFIED against live responses in this build environment).
 * 14. BASIS. Perp tickers carry mark and index prices; basis % is returned per
 *     symbol, and a series is flagged band-pinned when |basis| ≥ 1.5 % or the
 *     last three bars have zero range (closed underlying, venue price band).
 * 15. DEPTH. `fetchOrderBook` + `slippageBps` measure one-side slippage for a
 *     notional from the public order book (used for per-pair cost estimates).
 * 16. TAKER FLOW. Binance klines carry taker-buy base volume (field 9).
 *
 * v2.6:
 *
 * 17. COINS.PH (source "coinsph", coinsph.ts, ADR-0013). Peso (PHP) pairs only;
 *     prices in PHP, volume converted to USD; thin pairs are not scored; PH
 *     premium vs the global Binance price is information only.
 * 18. PER-VENUE COOLDOWN. A rate limit pauses only the venue that sent it
 *     (Binance, Bybit, Bitget, Coins.ph), not every source.
 *
 * v2.7:
 *
 * 19. STABLECOIN QUOTES (quotes.ts, plan WP12). A scan reads one quote (USDT by
 *     default — requests and results identical to v2.6), any listed stablecoin,
 *     or BEST (the deepest USD-pegged pair per coin). Volume is converted to USD at
 *     the quote's own price on the same venue (USDCUSDT, FDUSDUSDT, EURIUSDT…).
 *     Bybit/Bitget USDC perpetuals (`BTCPERP`) are served by quote "USDC".
 * 20. DEPEG READINGS. The selected quote (and USDT on Coins.ph) is checked
 *     against its peg every scan; information only, never scored.
 *
 * v2.8 (WP27):
 *
 * 21. PRIORITY TIERS. Candles are fetched tier by tier (progressive-scan.ts):
 *     the watch list, or the top 10 by volume, then chunks of 20; the 429/418
 *     halt stops every remaining tier. `onSeries` hands each series to the
 *     page as soon as it is fetched (rows appear while the scan runs).
 * 22. DELTA FETCH. With `delta`/`mergeDelta` a series whose stored history is
 *     contiguous asks only for the bars after the newest stored bar plus that
 *     bar again; a revised overlap bar falls back to the full 1,000-bar
 *     window. Aggregated (synthetic) intervals always fetch normally.
 *
 * 10. VOLUME IS DETECTED, NOT ASSUMED. `volumeBySymbol` reports whether each
 *     series carries real traded volume (tokenised assets and thin pairs
 *     often do not), so volume indicators are excluded instead of voting on
 *     zeros.
 * ----------------------------------------------------------------------------
 */
import { macdHistogram, type Kline, type MacdHistogramPoint } from "./indicators";
import { priorityOrder, runTiers } from "./progressive-scan";
import { classifySymbol, inClass, type AssetClassFilter } from "./asset-classes";
import {
  COINSPH_INTERVALS, COINSPH_MAX_ASSETS, COINSPH_MIN_USD_TURNOVER, CoinsphError, coinsphCooldown, coinsphGet, coinsphPassesThinRule,
  fetchCoinsphKlineRows, fetchCoinsphUniverse, phPremiumPct, resetCoinsphForTests,
} from "./coinsph";
export type { AssetClassFilter } from "./asset-classes";
import {
  BEST, DEFAULT_QUOTE, type DepegReading, type QuoteMode, baseFromInput, baseOf, depegLevel, normalizeQuoteMode,
  priceCurrencyOfQuote, rememberPairs, selectPairs, splitPair, stableQuote,
} from "./quotes";

const BINANCE_BASE = "https://data-api.binance.vision";
const BYBIT_BASE = "https://api.bybit.com";
const BITGET_BASE = "https://api.bitget.com";

/**
 * Leveraged tokens and USD-pegged pairs are excluded and every other symbol is
 * assigned an asset class (crypto / RWA / stock / FX / commodity) by
 * asset-classes.ts (v2.1.1). Unknown pegs are also caught at runtime by the
 * flat-series guard in the indicators.
 */

/**
 * A closed bar may legitimately lag by a little (exchange publish latency,
 * clock skew). Beyond 2.5 bar lengths the feed is treated as stale.
 */
export const MAX_STALENESS_BARS = 2.5;

export const DATA_SOURCES = [
  {
    value: "binance",
    label: "Binance Spot",
    note: "Public USDT spot tickers and OHLCV candles.",
    maxAssets: 200,
    privateApi: "binance",
  },
  {
    value: "bybit-spot",
    label: "Bybit Spot",
    note: "Public USDT spot tickers and OHLCV candles.",
    maxAssets: 200,
    privateApi: "bybit",
  },
  {
    value: "bybit-perp",
    label: "Bybit Perpetual",
    note: "Public USDT linear perpetual tickers and OHLCV candles.",
    maxAssets: 200,
    privateApi: "bybit",
  },
  {
    value: "bitget",
    label: "Bitget Spot",
    note: "Public USDT spot tickers and OHLCV candles.",
    maxAssets: 200,
    privateApi: "bitget",
  },
  {
    value: "bitget-perp",
    label: "Bitget Perpetual",
    note: "Public USDT-margined perpetual tickers and OHLCV candles (v2 mix API; field names not verified in this build).",
    maxAssets: 200,
    privateApi: "bitget",
  },
  {
    // v2.6 (ADR-0013): public data only — no privateApi, never offered under 🔑 (R20).
    value: "coinsph",
    label: "Coins.ph (PH)",
    note: "Public Philippine peso (PHP) spot tickers and OHLCV candles. Thin local market: pairs under $250k/day are not scored.",
    maxAssets: COINSPH_MAX_ASSETS,
  },
] as const;

/** v2.6: price currency per source (volumes are always reported in USD). v2.7: EUR for EUR-stablecoin quotes. */
export function priceCurrencyOf(source: string, quote: QuoteMode = DEFAULT_QUOTE): "USD" | "EUR" | "PHP" {
  return priceCurrencyOfQuote(source, normalizeQuoteMode(source, quote));
}

/** v2.3: 24 h quote-volume floor (USD) for non-crypto instruments. */
export const MIN_QUOTE_VOLUME_NONCRYPTO = 250_000;
/**
 * v2.8 (WP19): default crypto liquidity floor — 24 h quote volume in US dollars (`qvUsd`), a scan
 * setting (0 = off). Measured on the scan's own USD volume: non-USD quotes are converted at the
 * quote's price on the same venue (1 USDT = 1 USD), never at display-currency rates (R21).
 */
export const DEFAULT_LIQUIDITY_FLOOR_USD = 1_000_000;
/** Largest floor a caller may set (keeps stored and query values sane). */
export const MAX_LIQUIDITY_FLOOR_USD = 1_000_000_000;
/** Settings choices for the liquidity floor (US$ per 24 h; 0 = off). */
export const LIQUIDITY_FLOOR_CHOICES = [0, 250_000, 500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000] as const;
/** A stored or requested floor value → a whole number of US$ in [0, MAX], or the default. */
export function normalizeLiquidityFloor(value: unknown): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return DEFAULT_LIQUIDITY_FLOOR_USD;
  return Math.min(MAX_LIQUIDITY_FLOOR_USD, Math.round(n));
}
/** v2.3: |basis| at or above this percentage marks a perp as band-pinned. */
export const PINNED_BASIS_PCT = 1.5;
export const UNIVERSE_SIZE = 300;
export interface UniverseEntry { p: string; qv: number; ac: string }

export type DataSource = (typeof DATA_SOURCES)[number]["value"];

/** Bar length in milliseconds for every supported interval. */
export const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "8h": 8 * 60 * 60_000,
  "12h": 12 * 60 * 60_000,
  "1d": 86_400_000,
  "2d": 2 * 86_400_000,
  "4d": 4 * 86_400_000,
  "1w": 7 * 86_400_000,
  "1M": 30 * 86_400_000,
};

const VALID_INTERVALS = new Set(Object.keys(INTERVAL_MS));
const SYNTHETIC_DAY_INTERVALS: Record<string, number> = { "2d": 2, "4d": 4 };

export type FetchErrorReason = "HTTP" | "PARSE" | "STALE" | "EMPTY" | "TIMEOUT" | "RATE_LIMIT" | "UNKNOWN";

export interface FetchError {
  symbol: string;
  reason: FetchErrorReason;
  message: string;
}

export interface ServerTicker {
  rank: number;
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
}

export interface AllResponse {
  source: DataSource;
  sourceLabel: string;
  sourceNote: string;
  tickers: ServerTicker[];
  klines: Record<string, Kline[]>;
  histograms: Record<string, MacdHistogramPoint[]>;
  errors: FetchError[];
  effectiveInterval: string;
  /** Bar length in ms — consumed by session-anchored indicators. */
  intervalMs: number;
  /** True only when every returned series carries real volume. */
  volumeAvailable: boolean;
  /** v2.1.1: per-series volume availability. */
  volumeBySymbol: Record<string, boolean>;
  /** v2.1.1: set when an exchange rate-limited the scan; results are partial. */
  rateLimitedUntil?: number;
  durationMs: number;
  /** Newest closed-bar timestamp seen across the universe. */
  newestBarTime: number;
  staleCount: number;
  /** v2.3: full unfiltered venue ranking (all classes, top 300). */
  universe?: UniverseEntry[];
  /** v2.3: perp basis vs index, % (mark/index − 1), per symbol. */
  basisBySymbol?: Record<string, number>;
  /** v2.3: symbols dropped by the non-crypto turnover floor. */
  belowFloor?: number;
  /** v2.6: currency of `lastPrice` and of the candles ("USD" ≈ USDT, "EUR" for EUR stablecoins, or "PHP"). */
  priceCurrency?: "USD" | "EUR" | "PHP";
  /** v2.7: quote mode this scan used (USDT, USDC, …, BEST or PHP). */
  quote?: QuoteMode;
  /** v2.7: quote of each scanned pair (Best mode mixes them). */
  quoteBySymbol?: Record<string, string>;
  /** v2.7: pairs per stablecoin quote on this venue (for the Quote menu). */
  quoteCounts?: Record<string, number>;
  /** v2.7: pairs whose USD volume assumed the quote at exactly its peg (no venue price). */
  approxVolume?: string[];
  /** v2.7: stablecoins found off their peg on this venue (information only). */
  depeg?: DepegReading[];
  /** v2.6 Coins.ph: PH premium vs the global Binance USDT price, %, per symbol (information only). */
  premiumBySymbol?: Record<string, number>;
  /** v2.6 Coins.ph: PHP per USDT used to value volumes, or null. */
  usdPhp?: number | null;
  /** v2.6 Coins.ph: thin pairs (under the turnover floor) left out of scoring. v2.8: also crypto pairs under the liquidity floor. */
  thinSymbols?: string[];
  /** v2.8 (WP19): the US$ floor `thinSymbols` fell under (Coins.ph's thin rule or the crypto liquidity floor). */
  thinFloorUsd?: number;
}

/** v2.8 (WP27): what a scan knows once its list is chosen (the same fields its final response carries). */
export type ListMeta = Pick<AllResponse, "universe" | "basisBySymbol" | "belowFloor" | "priceCurrency" | "quote" | "quoteBySymbol"
  | "quoteCounts" | "approxVolume" | "depeg" | "thinSymbols" | "thinFloorUsd" | "usdPhp">;

/** v2.8 (WP27): progressive-scan hooks (direct-fetch builds only). */
export interface ProgressiveFetch {
  /** The chosen list (rank, price, change, volume) and its metadata, before any candle request. */
  onTickers?: (tickers: ServerTicker[], meta: ListMeta) => void;
  /** Called once per fetched series, in fetch order, while the scan runs. */
  onSeries?: (symbol: string, klines: Kline[]) => void;
  /** Symbols settled so far / total, after every batch. */
  onProgress?: (done: number, total: number) => void;
  /** Delta request for a symbol (history-store `deltaPlan`), or null for the normal request. */
  delta?: (symbol: string) => { limit: number; overlapOpenTime: number } | null;
  /** Stored + fresh bars (history-store `mergeDelta`), or null → the full window is fetched instead. */
  mergeDelta?: (symbol: string, fresh: Kline[], overlapOpenTime: number) => Kline[] | null;
  /** The user's watchlist/selection: fetched first (otherwise the top 10 by volume). */
  priority?: string[];
}

interface MarketFetchOptions extends ProgressiveFetch {
  source?: DataSource;
  assets?: string[];
  limit?: number;
  signal?: AbortSignal;
  /** Bars to request per symbol (200 default; up to 1,000 for a warm start). */
  klineLimit?: (symbol: string) => number;
  /** Restrict the universe to one asset class (default: crypto only). */
  assetClass?: AssetClassFilter;
  /** v2.7: stablecoin quote mode (default USDT). */
  quote?: QuoteMode;
  /** v2.8 (WP19): crypto liquidity floor, US$ of 24 h quote volume (default DEFAULT_LIQUIDITY_FLOOR_USD; 0 = off). */
  liquidityFloorUsd?: number;
}

interface RawBinanceTicker {
  symbol: string;
  openPrice: string;
  lastPrice: string;
  quoteVolume: string;
}

interface RawBybitTicker {
  symbol: string;
  markPrice?: string;
  indexPrice?: string;
  lastPrice: string;
  price24hPcnt?: string;
  turnover24h?: string;
  volume24h?: string;
}

interface RawBitgetTicker {
  symbol: string;
  open: string;
  lastPr: string;
  quoteVolume?: string;
  usdtVolume?: string;
  change24h?: string;
  markPrice?: string;
  indexPrice?: string;
}

interface TickerSet {
  tickers: ServerTicker[]; universe: UniverseEntry[]; basis: Record<string, number>; belowFloor: number;
  /** v2.7 */ quoteBySymbol?: Record<string, string>; quoteCounts?: Record<string, number>; approx?: string[]; depeg?: DepegReading[];
  /** v2.8 (WP19): crypto pairs left out by the liquidity floor. */ thin?: string[];
}

/* ---------------------------------------------------------------------------
 * v2.7 quote layer (WP12). `pickQuotes` turns one venue's raw ticker rows into
 * the rows of the selected quote mode with USD volume. In USDT mode it is the
 * v2.6 filter (`endsWith("USDT")`, volume as reported) so results are identical.
 * ------------------------------------------------------------------------- */
interface Picked<T> { t: T; symbol: string; base: string; quote: string; qvUsd: number }
interface PickResult<T> { rows: Picked<T>[]; counts: Record<string, number>; approx: string[]; depeg: DepegReading[] }
function pickQuotes<T>(
  source: DataSource,
  list: readonly T[],
  symOf: (t: T) => string,
  qvOf: (t: T) => number,
  pxOf: (t: T) => number,
  mode: QuoteMode,
): PickResult<T> {
  const counts: Record<string, number> = {};
  const parts = list.map((t) => ({ t, symbol: symOf(t), ...splitPair(symOf(t), source) }));
  for (const p of parts) if (stableQuote(p.quote)) counts[p.quote] = (counts[p.quote] ?? 0) + 1;
  if (mode === "USDT") {
    const rows = parts.filter((p) => p.symbol.endsWith("USDT") && !(source.endsWith("perp") && p.quote === "USDC"))
      .map((p) => ({ t: p.t, symbol: p.symbol, base: p.symbol.slice(0, -4), quote: "USDT", qvUsd: qvOf(p.t) }));
    // Review v2.7 #8: USDT scans also watch USDC/USDT, the deepest stablecoin cross (information only).
    const usdc = parts.find((p) => p.symbol === "USDCUSDT");
    const v = usdc ? pxOf(usdc.t) : NaN;
    const level = depegLevel((v - 1) * 100);
    const depeg = level ? [{ coin: "USDC", reference: "USDT", price: v, deviationPct: Math.round((v - 1) * 100_000) / 1000, level }] : [];
    return { rows, counts, approx: [], depeg };
  }
  // Quote prices in USDT from the same ticker list (USDCUSDT, FDUSDUSDT, EURIUSDT…).
  const px = new Map(parts.map((p) => [p.symbol, pxOf(p.t)]));
  const approx: string[] = [];
  const depeg: DepegReading[] = [];
  const usdtPer = (q: string): number | undefined => {
    if (q === "USDT") return 1;
    const v = px.get(`${q}USDT`);
    return v !== undefined && v > 0 ? v : undefined;
  };
  const wanted = new Set(mode === BEST
    ? Object.keys(counts).filter((q) => stableQuote(q)?.peg === "USD")
    : [mode]);
  for (const q of wanted) {
    const v = usdtPer(q);
    if (q === "USDT" || v === undefined || stableQuote(q)?.peg !== "USD") continue;
    const dev = (v - 1) * 100;
    const level = depegLevel(dev);
    if (level) depeg.push({ coin: q, reference: "USDT", price: v, deviationPct: Math.round(dev * 1000) / 1000, level });
  }
  const rows: Picked<T>[] = [];
  for (const p of parts) {
    if (!wanted.has(p.quote) || !p.base) continue;
    const peg = stableQuote(p.quote)?.peg;
    let rate = usdtPer(p.quote);
    // USDC-margined perps settle in USDC by definition: counted at $1 without a per-row "≈" (review v2.7 #8).
    if (rate === undefined && peg === "USD") { rate = 1; if (!source.endsWith("perp")) approx.push(p.symbol); }
    rows.push({ t: p.t, symbol: p.symbol, base: p.base, quote: p.quote, qvUsd: rate === undefined ? NaN : qvOf(p.t) * rate });
  }
  const chosen = selectPairs(source, rows, mode).sort(byUsdDesc);
  return { rows: chosen, counts, approx: approx.filter((s) => chosen.some((r) => r.symbol === s)), depeg };
}
/** Highest USD volume first; unknown (NaN) volumes last. Stable, like v2.6's sort. */
const byUsdDesc = (a: { qvUsd: number }, b: { qvUsd: number }) =>
  (Number.isFinite(b.qvUsd) ? b.qvUsd : -1) - (Number.isFinite(a.qvUsd) ? a.qvUsd : -1);
const quoteMapOf = <T,>(rows: Picked<T>[]) => Object.fromEntries(rows.map((r) => [r.symbol, r.quote]));

/** Full ranking (all classes) for the universe log; leveraged/pegged pairs are left out. */
function universeOf(source: DataSource, rows: { symbol: string; qv: number }[], types?: Map<string, string> | null): UniverseEntry[] {
  const out: UniverseEntry[] = [];
  for (const r of rows) {
    const ac = classifySymbol(source, r.symbol, types?.get(r.symbol));
    if (ac === "excluded") continue;
    out.push({ p: r.symbol, qv: Math.round(r.qv), ac });
    if (out.length >= UNIVERSE_SIZE) break;
  }
  return out;
}
/** Non-crypto instruments below the 24 h turnover floor are not scored (thin, quote-driven books). */
export function passesTurnoverFloor(source: string, symbol: string, quoteVolume: number, venueType?: string): boolean {
  const ac = classifySymbol(source, symbol, venueType);
  return ac === "crypto" || ac === "excluded" || quoteVolume >= MIN_QUOTE_VOLUME_NONCRYPTO;
}
/**
 * v2.8 (WP19): crypto liquidity floor. `qvUsd` is the scan's own USD volume — the function takes
 * no rate and no display currency (R21). 0 turns the floor off; an unknown volume (NaN) never
 * clears an active floor. Coins.ph peso pairs keep their own thin-pair rule (coinsphPassesThinRule).
 */
export function passesLiquidityFloor(qvUsd: number, floorUsd: number, source: string): boolean {
  if (source === "coinsph" || !(floorUsd > 0)) return true;
  return Number.isFinite(qvUsd) && qvUsd >= floorUsd;
}
/**
 * Apply the liquidity floor to crypto rows (other classes keep MIN_QUOTE_VOLUME_NONCRYPTO).
 * `thin` lists only pairs the floor actually kept out of this scan: those that would otherwise
 * have been among the `limit` pairs scanned (after the watch-list filter).
 */
function splitLiquidity<T>(
  source: DataSource, rows: Picked<T>[], floorUsd: number, assets: string[] | undefined, limit: number, types?: Map<string, string> | null,
): { kept: Picked<T>[]; thin: string[] } {
  if (!(floorUsd > 0)) return { kept: rows, thin: [] };
  const fails = (r: Picked<T>) => classifySymbol(source, r.symbol, types?.get(r.symbol)) === "crypto" && !passesLiquidityFloor(r.qvUsd, floorUsd, source);
  const wanted = normalizeAssets(assets);
  const candidates = (wanted ? rows.filter((r) => wanted.has(baseOf(r.symbol, source))) : rows).slice(0, limit);
  return { kept: rows.filter((r) => !fails(r)), thin: candidates.filter(fails).map((r) => r.symbol) };
}

/* ---------------------------------------------------------------------------
 * v2.8 (WP19): Binance used-weight pacing. Binance reports the request weight
 * used in the current minute in `X-MBX-USED-WEIGHT-1M` (documented as
 * X-MBX-USED-WEIGHT-(intervalNum)(intervalLetter)). Node fetch (recorder,
 * replay CLI, server route) can read it; a page or WebView cannot (cross-origin
 * response headers are hidden unless exposed — like Retry-After), and Binance
 * is not on the native-HTTP allowlist, so every app build keeps the fixed
 * pacing below plus the global 429/418 halt. The pause only ever adds waiting.
 * ------------------------------------------------------------------------- */
/** Binance's documented request-weight limit per minute (spot, per IP). */
export const BINANCE_WEIGHT_LIMIT_1M = 6000;
/**
 * Milliseconds to wait before the next Binance request for a used-weight reading:
 * 0 at or below 80% of `limit`, rising linearly to a full minute at the limit.
 * A missing or unreadable header (null, "", junk) is 0.
 */
export function paceFromUsedWeight(header: string | null, limit = BINANCE_WEIGHT_LIMIT_1M): number {
  if (header == null || String(header).trim() === "") return 0;
  const used = Number(header);
  if (!Number.isFinite(used) || used < 0 || !(limit > 0)) return 0;
  const start = limit * 0.8;
  if (used <= start) return 0;
  return Math.min(60_000, Math.ceil(((used - start) / (limit - start)) * 60_000));
}
/** True where the used-weight header can be read: Node (no window). Pages and WebViews: false. */
export function usedWeightReadable(): boolean {
  return typeof window === "undefined";
}
let binancePaceUntil = 0;
/** Remaining used-weight pause before the next Binance request, ms (0 = none). */
export function binancePaceMs(now = Date.now()): number {
  return Math.max(0, binancePaceUntil - now);
}
function noteUsedWeight(res: Response, url: string): void {
  if (!url.startsWith(BINANCE_BASE) || !usedWeightReadable()) return;
  const wait = paceFromUsedWeight(res.headers.get("x-mbx-used-weight-1m"));
  if (wait > 0) binancePaceUntil = Math.max(binancePaceUntil, Date.now() + wait);
}
async function awaitBinancePace(url: string, signal?: AbortSignal): Promise<void> {
  if (!url.startsWith(BINANCE_BASE)) return;
  const target = binancePaceUntil;
  const wait = target - Date.now();
  if (wait <= 0 || signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => { clearTimeout(id); signal?.removeEventListener("abort", done); resolve(); };
    const id = setTimeout(done, Math.min(wait, 60_000));
    signal?.addEventListener("abort", done, { once: true });
  });
  // Waited it out; clear unless a newer reading raised it meanwhile (also safe on a frozen test clock).
  if (binancePaceUntil === target) binancePaceUntil = 0;
}
function basisPct(mark?: string, index?: string): number | undefined {
  const m = parseFloat(mark ?? "");
  const i = parseFloat(index ?? "");
  return m > 0 && i > 0 ? (m / i - 1) * 100 : undefined;
}
/** Band-pinned: large basis, or no price movement over the last three bars. */
export function isBandPinned(klines: Kline[], basis?: number): boolean {
  if (basis !== undefined && Math.abs(basis) >= PINNED_BASIS_PCT) return true;
  const tail = klines.slice(-3);
  return tail.length === 3 && tail.every((b) => b.high === b.low);
}

export class RateLimitError extends Error {
  readonly reason: FetchErrorReason = "RATE_LIMIT";
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Cooldown after a rate-limit response, per venue (v2.6; shared by scans and
 * backfills). A ban from one exchange no longer pauses the others.
 */
export type Venue = "binance" | "bybit" | "bitget" | "coinsph";
const rateLimitedUntil: Record<Venue, number> = { binance: 0, bybit: 0, bitget: 0, coinsph: 0 };
export function venueOf(source: string): Venue {
  if (source.startsWith("bybit")) return "bybit";
  if (source.startsWith("bitget")) return "bitget";
  if (source === "coinsph") return "coinsph";
  return "binance";
}
function venueOfUrl(url: string): Venue {
  if (url.startsWith(BYBIT_BASE)) return "bybit";
  if (url.startsWith(BITGET_BASE)) return "bitget";
  return "binance";
}
/** Remaining cooldown for one source's venue, or the longest one when no source is given. */
export function rateLimitCooldown(source?: string): number {
  const now = Date.now();
  if (source !== undefined) {
    const v = venueOf(source);
    return v === "coinsph" ? coinsphCooldown(now) : Math.max(0, rateLimitedUntil[v] - now);
  }
  return Math.max(0, coinsphCooldown(now), ...Object.values(rateLimitedUntil).map((t) => t - now));
}
function noteRateLimit(err: RateLimitError, venue: Venue): void {
  rateLimitedUntil[venue] = Math.max(rateLimitedUntil[venue], Date.now() + err.retryAfterMs);
}
/** Test hook: clear every rate-limit cooldown. */
export function resetRateLimitForTests(): void {
  (Object.keys(rateLimitedUntil) as Venue[]).forEach((v) => { rateLimitedUntil[v] = 0; });
  binancePaceUntil = 0;
  resetCoinsphForTests();
}
function assertNotCoolingDown(source: string): void {
  const wait = rateLimitCooldown(source);
  if (wait > 0) {
    throw new RateLimitError(`Exchange rate limit: paused for ${Math.ceil(wait / 1000)} s to protect your IP.`, wait);
  }
}

/**
 * fetch + JSON with exchange-aware error handling. Throws RateLimitError on
 * 429/418 or Bybit/Bitget rate-limit codes, and Error on any other non-OK or
 * error-envelope response.
 */
async function fetchJson(url: string, label: string, signal?: AbortSignal): Promise<unknown> {
  await awaitBinancePace(url, signal);
  const res = await fetch(url, { cache: "no-store", signal });
  noteUsedWeight(res, url);
  // Bybit signals an IP ban with HTTP 403 ("access too frequent", ~10 min).
  if (res.status === 403 && url.startsWith(BYBIT_BASE)) {
    const err = new RateLimitError(`${label}: IP temporarily banned by Bybit (403).`, 600_000);
    noteRateLimit(err, venueOfUrl(url));
    throw err;
  }
  if (res.status === 429 || res.status === 418) {
    // Retry-After is readable in Node (replay) but not cross-origin in a browser
    // (not a CORS-safelisted header), so pages fall back to the defaults below.
    const header = Number(res.headers.get("retry-after"));
    const retryAfterMs = Number.isFinite(header) && header > 0 ? header * 1000 : res.status === 418 ? 600_000 : 60_000;
    const err = new RateLimitError(`${label}: rate limited (${res.status}).`, retryAfterMs);
    noteRateLimit(err, venueOfUrl(url));
    throw err;
  }
  if (!res.ok) throw new Error(`${label} ${res.status}`);
  const json = (await res.json()) as unknown;
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const o = json as { retCode?: number; retMsg?: string; code?: string | number; msg?: string };
    if (typeof o.retCode === "number" && o.retCode !== 0) {
      if (o.retCode === 10006 || o.retCode === 10018) {
        const err = new RateLimitError(`${label}: rate limited (Bybit ${o.retCode}).`, 60_000);
        noteRateLimit(err, venueOfUrl(url));
        throw err;
      }
      throw new Error(`${label} error ${o.retCode}: ${o.retMsg ?? ""}`.trim());
    }
    if (o.code !== undefined && String(o.code) !== "00000" && String(o.code) !== "0") {
      if (String(o.code) === "429") {
        const err = new RateLimitError(`${label}: rate limited (Bitget 429).`, 60_000);
        noteRateLimit(err, venueOfUrl(url));
        throw err;
      }
      throw new Error(`${label} error ${o.code}: ${o.msg ?? ""}`.trim());
    }
  }
  return json;
}

/** Exchange symbols are untrusted input: accept only plain upper-case alphanumerics. */
const SAFE_SYMBOL = /^[A-Z0-9]{2,30}$/;

/** Bars per request: 100–1,000 (v2.8 WP27: a delta request may ask as few as 2 — overlap + the bar in progress). */
const clampLimit = (n: number | undefined, delta = false) => Math.max(delta ? 2 : 100, Math.min(1000, Math.round(n ?? 200)));

/* ---------------------------------------------------------------------------
 * Venue instrument types (v2.1.1). Bybit V5 instruments-info carries
 * `symbolType` (linear: stock / ETF / commodity / forex; spot: xstocks;
 * "" or "innovation" for crypto). Read once per 6 h per source; on failure the
 * classifier falls back to symbol patterns and the scan carries on.
 * ------------------------------------------------------------------------- */
const INSTRUMENT_TTL_MS = 6 * 3_600_000;
const instrumentTypes = new Map<DataSource, { at: number; types: Map<string, string> }>();

export async function loadInstrumentTypes(source: DataSource, signal?: AbortSignal): Promise<Map<string, string> | null> {
  if (source !== "bybit-spot" && source !== "bybit-perp") return null;
  const cached = instrumentTypes.get(source);
  if (cached && Date.now() - cached.at < INSTRUMENT_TTL_MS) return cached.types;
  const category = source === "bybit-perp" ? "linear" : "spot";
  try {
    const types = new Map<string, string>();
    const pairs: [string, { base: string; quote: string }][] = [];
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const url = `${BYBIT_BASE}/v5/market/instruments-info?category=${category}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const json = (await fetchJson(url, "Bybit instruments", signal)) as {
        result?: { list?: { symbol: string; symbolType?: string; status?: string; baseCoin?: string; quoteCoin?: string; settleCoin?: string }[]; nextPageCursor?: string };
      };
      for (const it of json.result?.list ?? []) {
        if (it.status && it.status !== "Trading") continue;
        types.set(it.symbol, String(it.symbolType ?? "").toLowerCase());
        // v2.7: base/quote from the venue (USDC perps are named BTCPERP; settle coin = quote).
        if (it.baseCoin) pairs.push([it.symbol, { base: it.baseCoin, quote: category === "linear" ? (it.settleCoin || it.quoteCoin || "") : (it.quoteCoin ?? "") }]);
      }
      cursor = json.result?.nextPageCursor ?? "";
      if (!cursor) break;
    }
    instrumentTypes.set(source, { at: Date.now(), types });
    if (pairs.length) rememberPairs(source, pairs);
    return types;
  } catch (error) {
    if (error instanceof RateLimitError || (error instanceof DOMException && error.name === "AbortError")) throw error;
    return null; // older API shape or transient failure: pattern classification only
  }
}

/** Venue type for one symbol, when known (used by classifySymbol). */
export function venueTypeOf(source: DataSource, symbol: string): string | undefined {
  return instrumentTypes.get(source)?.types.get(symbol);
}

export class StaleFeedError extends Error {
  readonly reason: FetchErrorReason = "STALE";
  constructor(message: string) {
    super(message);
    this.name = "StaleFeedError";
  }
}

function classify(error: unknown): FetchErrorReason {
  if (error instanceof RateLimitError) return "RATE_LIMIT";
  if (error instanceof StaleFeedError) return "STALE";
  if (error instanceof DOMException && error.name === "TimeoutError") return "TIMEOUT";
  const message = error instanceof Error ? error.message : "";
  if (/\b(4\d\d|5\d\d)\b/.test(message)) return "HTTP";
  if (/json|parse|unexpected token/i.test(message)) return "PARSE";
  if (/empty|no candles/i.test(message)) return "EMPTY";
  return "UNKNOWN";
}

function sourceMeta(source: DataSource) {
  return DATA_SOURCES.find((s) => s.value === source) ?? DATA_SOURCES[0];
}

function normalizeAssets(assets?: string[]): Set<string> | null {
  const clean = (assets ?? [])
    .map((a) => a.trim().toUpperCase())
    .filter(Boolean)
    .map((a) => baseFromInput(a)); // v2.7: any quote ("BTC/USDC", "ETHFDUSD") → base
  return clean.length ? new Set(clean) : null;
}

function filterTickers(tickers: ServerTicker[], assets?: string[], limit = 200, source?: string): ServerTicker[] {
  const wanted = normalizeAssets(assets);
  const filtered = wanted
    ? tickers.filter((t) => wanted.has(baseOf(t.symbol, source)))
    : tickers;
  return filtered.slice(0, limit).map((t, i) => ({ ...t, rank: i + 1 }));
}

/** Build target baked in by next.config.ts ("html", "capacitor" or "server"). */
const BUILD_TARGET = process.env.NEXT_PUBLIC_BUILD_TARGET ?? "server";

/**
 * True when this bundle has no server-side /api routes and must fetch market
 * data directly from the exchanges. Static exports never contain the routes,
 * whatever origin they are served from.
 */
export function usesDirectFetch(): boolean {
  if (BUILD_TARGET === "html" || BUILD_TARGET === "capacitor" || BUILD_TARGET === "tauri") return true;
  if (typeof window === "undefined") return false;
  return (
    typeof (window as unknown as { Capacitor?: unknown }).Capacitor !== "undefined" ||
    window.location.protocol === "capacitor:" ||
    window.location.protocol === "file:"
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Close time of a bar that opened at `openTime`. Monthly bars close at the
 * start of the next UTC calendar month; every other interval has a fixed
 * length.
 */
export function barCloseTime(openTime: number, intervalMs: number): number {
  if (intervalMs === INTERVAL_MS["1M"]) {
    const d = new Date(openTime);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return openTime + intervalMs;
}

/**
 * Remove any bar whose close time is still in the future — i.e. the candle the
 * exchange is currently building. Without this, every threshold-crossing
 * indicator repaints continuously within the bar.
 */
export function dropUnclosed(klines: Kline[], intervalMs: number, now = Date.now()): Kline[] {
  const out = [...klines].sort((a, b) => a.time - b.time);
  while (out.length && barCloseTime(out[out.length - 1].time, intervalMs) > now) out.pop();
  return out;
}

/**
 * Keep only the newest run of bars with no missing intervals.
 *
 * Stored history and freshly fetched candles are merged by timestamp. If the
 * app was closed for longer than one fetch window, the merge contains a hole,
 * and every path-dependent calculation (PSAR, Supertrend, OBV, FVG detection,
 * analogue forward returns) would silently treat the two sides as adjacent.
 * A gap larger than 1.5 bar lengths (calendar months: 32 days) ends the run.
 */
export function contiguousTail(klines: Kline[], intervalMs: number): Kline[] {
  if (klines.length < 2) return klines;
  const maxStep = intervalMs === INTERVAL_MS["1M"] ? 32 * 86_400_000 : intervalMs * 1.5;
  let start = klines.length - 1;
  while (start > 0 && klines[start].time - klines[start - 1].time <= maxStep) start--;
  return start === 0 ? klines : klines.slice(start);
}

/** Reject a series whose newest CLOSED bar is too old to act on. */
export function assertFresh(klines: Kline[], intervalMs: number, symbol: string, now = Date.now()): void {
  if (!klines.length) throw new StaleFeedError(`${symbol}: no closed candles returned.`);
  const newest = barCloseTime(klines[klines.length - 1].time, intervalMs);
  const age = now - newest;
  if (age > intervalMs * MAX_STALENESS_BARS) {
    throw new StaleFeedError(
      `${symbol}: newest closed bar is ${Math.round(age / 1000)}s old (> ${MAX_STALENESS_BARS} bars).`,
    );
  }
}

/**
 * Bucket candles into larger bars anchored to the Unix epoch.
 *
 * Index-based grouping (the prior implementation) started at element 0 of a
 * sliding window, so the pairing that formed a 2-day candle shifted every time
 * a new daily bar arrived — historical bars silently redefined themselves and a
 * signal could not be reproduced the next day.
 */
export function aggregateKlines(klines: Kline[], groupSize: number, baseIntervalMs: number): Kline[] {
  const bucketMs = groupSize * baseIntervalMs;
  const buckets = new Map<number, Kline[]>();
  for (const c of [...klines].sort((a, b) => a.time - b.time)) {
    const bucket = Math.floor(c.time / bucketMs) * bucketMs;
    const group = buckets.get(bucket);
    if (group) group.push(c);
    else buckets.set(bucket, [c]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, group]) => group.length === groupSize) // drop partial buckets
    .map(([time, group]) => ({
      time,
      open: group[0].open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((sum, c) => sum + c.volume, 0),
      // v2.8 (WP19): Binance quote volume and trade count add up, when every bar has them.
      ...(group.every((c) => c.qv !== undefined) ? { qv: group.reduce((sum, c) => sum + (c.qv as number), 0) } : {}),
      ...(group.every((c) => c.trades !== undefined) ? { trades: group.reduce((sum, c) => sum + (c.trades as number), 0) } : {}),
    }));
}

async function fetchViaProxy(
  interval: string,
  source: DataSource,
  assets: string[],
  limit: number,
  signal?: AbortSignal,
  assetClass: AssetClassFilter = "crypto",
  quote: QuoteMode = DEFAULT_QUOTE,
  liquidityFloorUsd = DEFAULT_LIQUIDITY_FLOOR_USD,
): Promise<AllResponse> {
  const qs = new URLSearchParams({ interval, source, limit: String(limit), assetClass });
  if (quote !== DEFAULT_QUOTE) qs.set("quote", quote);
  if (liquidityFloorUsd !== DEFAULT_LIQUIDITY_FLOOR_USD) qs.set("floor", String(liquidityFloorUsd));
  if (assets.length) qs.set("assets", assets.join(","));
  const res = await fetch(`/api/market/all?${qs.toString()}`, { cache: "no-store", signal });
  if (!res.ok) throw new Error(`Proxy failed: ${res.status}`);
  return (await res.json()) as AllResponse;
}

function withHistograms(
  source: DataSource,
  tickers: ServerTicker[],
  klines: Record<string, Kline[]>,
  errors: FetchError[],
  interval: string,
  startedAt: number,
): AllResponse {
  const meta = sourceMeta(source);
  const histograms: Record<string, MacdHistogramPoint[]> = {};
  const volumeBySymbol: Record<string, boolean> = {};
  let newestBarTime = 0;
  Object.entries(klines).forEach(([symbol, values]) => {
    histograms[symbol] = macdHistogram(values);
    const tail = values.slice(-200);
    volumeBySymbol[symbol] = tail.length > 0 && tail.filter((b) => b.volume > 0).length / tail.length >= 0.8;
    const newest = values.length ? values[values.length - 1].time : 0;
    if (newest > newestBarTime) newestBarTime = newest;
  });
  return {
    source,
    sourceLabel: meta.label,
    sourceNote: meta.note,
    tickers,
    klines,
    histograms,
    errors,
    effectiveInterval: interval,
    intervalMs: INTERVAL_MS[interval] ?? INTERVAL_MS["15m"],
    volumeAvailable: Object.values(volumeBySymbol).every(Boolean),
    volumeBySymbol,
    durationMs: Date.now() - startedAt,
    newestBarTime,
    staleCount: errors.filter((e) => e.reason === "STALE").length,
  };
}

/** v2.7: Binance base/quote for every trading symbol (exchangeInfo, weight 20), read only for non-USDT modes, 6 h cache. */
let binanceMetaAt = 0;
async function loadBinancePairs(signal?: AbortSignal): Promise<void> {
  if (Date.now() - binanceMetaAt < INSTRUMENT_TTL_MS) return;
  try {
    const j = (await fetchJson(`${BINANCE_BASE}/api/v3/exchangeInfo?showPermissionSets=false`, "Binance exchangeInfo", signal)) as {
      symbols?: { symbol: string; baseAsset: string; quoteAsset: string; status: string }[];
    };
    rememberPairs("binance", (j.symbols ?? []).filter((x) => x.status === "TRADING").map((x) => [x.symbol, { base: x.baseAsset, quote: x.quoteAsset }]));
    binanceMetaAt = Date.now();
  } catch (error) {
    if (error instanceof RateLimitError || (error instanceof DOMException && error.name === "AbortError")) throw error;
    // suffix parsing only; the scan continues
  }
}
/** v2.7: Bitget spot base/quote (public symbols list), non-USDT modes only, 6 h cache. */
let bitgetMetaAt = 0;
async function loadBitgetPairs(signal?: AbortSignal): Promise<void> {
  if (Date.now() - bitgetMetaAt < INSTRUMENT_TTL_MS) return;
  try {
    const j = (await fetchJson(`${BITGET_BASE}/api/v2/spot/public/symbols`, "Bitget symbols", signal)) as {
      data?: { symbol: string; baseCoin: string; quoteCoin: string; status: string }[];
    };
    rememberPairs("bitget", (j.data ?? []).filter((x) => x.status === "online").map((x) => [x.symbol, { base: x.baseCoin, quote: x.quoteCoin }]));
    bitgetMetaAt = Date.now();
  } catch (error) {
    if (error instanceof RateLimitError || (error instanceof DOMException && error.name === "AbortError")) throw error;
  }
}

async function fetchBinanceTickers(assets?: string[], limit = 200, signal?: AbortSignal, assetClass: AssetClassFilter = "crypto", quote: QuoteMode = DEFAULT_QUOTE, floorUsd = 0): Promise<TickerSet> {
  if (quote !== "USDT") await loadBinancePairs(signal);
  const all = (await fetchJson(`${BINANCE_BASE}/api/v3/ticker/24hr?type=MINI`, "Binance ticker upstream", signal)) as RawBinanceTicker[];
  const picked = pickQuotes("binance", all.filter((t) => SAFE_SYMBOL.test(t.symbol)), (t) => t.symbol,
    (t) => parseFloat(t.quoteVolume) || 0, (t) => parseFloat(t.lastPrice), quote);
  const ranked = picked.rows.sort(byUsdDesc);
  const universe = universeOf("binance", ranked.map((r) => ({ symbol: r.symbol, qv: Number.isFinite(r.qvUsd) ? r.qvUsd : 0 })));
  const inCls = ranked.filter((r) => inClass("binance", r.symbol, assetClass));
  const turnover = inCls.filter((r) => passesTurnoverFloor("binance", r.symbol, Number.isFinite(r.qvUsd) ? r.qvUsd : 0));
  const { kept: floored, thin } = splitLiquidity("binance", turnover, floorUsd, assets, limit);
  const tickers = floored
    .map(({ t, qvUsd }, i) => {
      const open = parseFloat(t.openPrice);
      const lastPx = parseFloat(t.lastPrice);
      const pct = open > 0 ? ((lastPx - open) / open) * 100 : 0;
      return {
        rank: i + 1,
        symbol: t.symbol,
        lastPrice: t.lastPrice,
        priceChangePercent: pct.toFixed(4),
        quoteVolume: quote === "USDT" ? t.quoteVolume : String(qvUsd),
      };
    });
  return {
    tickers: filterTickers(tickers, assets, limit, "binance"), universe, basis: {}, belowFloor: inCls.length - turnover.length,
    quoteBySymbol: quoteMapOf(floored), quoteCounts: picked.counts, approx: picked.approx, depeg: picked.depeg, thin,
  };
}

/** v2.8 (WP19): Binance kline fields 7 (quote-asset volume) and 8 (number of trades), when present and numeric. */
function binanceExtras(r: (string | number)[]): { qv?: number; trades?: number } {
  const qv = r[7] !== undefined ? Number(r[7]) : NaN;
  const trades = r[8] !== undefined ? Number(r[8]) : NaN;
  return { ...(Number.isFinite(qv) ? { qv } : {}), ...(Number.isFinite(trades) ? { trades } : {}) };
}

async function fetchBinanceKlines(symbol: string, interval: string, signal?: AbortSignal, bars = 200, delta = false): Promise<Kline[]> {
  const syntheticDays = SYNTHETIC_DAY_INTERVALS[interval];
  const upstreamInterval = syntheticDays ? "1d" : interval;
  const requestLimit = syntheticDays ? 1000 : clampLimit(bars, delta);
  const raw = (await fetchJson(
    `${BINANCE_BASE}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${upstreamInterval}&limit=${requestLimit}`,
    `Binance klines ${symbol}`,
    signal,
  )) as (string | number)[][];
  const parsed = raw.map((r) => ({
    time: Number(r[0]),
    open: parseFloat(r[1] as string),
    high: parseFloat(r[2] as string),
    low: parseFloat(r[3] as string),
    close: parseFloat(r[4] as string),
    volume: parseFloat(r[5] as string),
    // v2.3: taker-buy base volume (Binance kline field 9).
    ...(r[9] !== undefined ? { takerBuy: parseFloat(r[9] as string) } : {}),
    // v2.8 (WP19): quote-asset volume (field 7) and trade count (field 8). Logged context, never scored.
    ...binanceExtras(r),
  }));
  const baseMs = INTERVAL_MS[upstreamInterval] ?? INTERVAL_MS["15m"];
  const closed = dropUnclosed(parsed, baseMs);
  const finalSeries = syntheticDays
    ? aggregateKlines(closed, syntheticDays, baseMs).slice(-clampLimit(bars))
    : closed;
  assertFresh(finalSeries, INTERVAL_MS[interval] ?? baseMs, symbol);
  return finalSeries;
}

function bybitInterval(interval: string): { interval: string; aggregate?: number; baseMs: number } {
  const map: Record<string, string> = {
    "1m": "1",
    "5m": "5",
    "15m": "15",
    "1h": "60",
    "4h": "240",
    "6h": "360",
    "12h": "720",
    "1d": "D",
    "1w": "W",
    "1M": "M",
  };
  if (interval === "8h") return { interval: "240", aggregate: 2, baseMs: INTERVAL_MS["4h"] };
  if (interval === "2d") return { interval: "D", aggregate: 2, baseMs: INTERVAL_MS["1d"] };
  if (interval === "4d") return { interval: "D", aggregate: 4, baseMs: INTERVAL_MS["1d"] };
  return { interval: map[interval] ?? "15", baseMs: INTERVAL_MS[interval] ?? INTERVAL_MS["15m"] };
}

async function fetchBybitTickers(
  category: "spot" | "linear",
  assets?: string[],
  limit = 200,
  signal?: AbortSignal,
  assetClass: AssetClassFilter = "crypto",
  quote: QuoteMode = DEFAULT_QUOTE,
  floorUsd = 0,
): Promise<TickerSet> {
  const json = (await fetchJson(`${BYBIT_BASE}/v5/market/tickers?category=${category}`, "Bybit ticker upstream", signal)) as { result?: { list?: RawBybitTicker[] } };
  const src: DataSource = category === "linear" ? "bybit-perp" : "bybit-spot";
  const types = await loadInstrumentTypes(src, signal);
  const qvOf = (t: RawBybitTicker) => parseFloat(t.turnover24h ?? t.volume24h ?? "0") || 0;
  const picked = pickQuotes(src, (json.result?.list ?? []).filter((t) => SAFE_SYMBOL.test(t.symbol) && (!types || types.has(t.symbol))),
    (t) => t.symbol, qvOf, (t) => parseFloat(t.lastPrice), quote);
  const ranked = picked.rows.sort(byUsdDesc);
  const usd = (r: { qvUsd: number }) => (Number.isFinite(r.qvUsd) ? r.qvUsd : 0);
  const universe = universeOf(src, ranked.map((r) => ({ symbol: r.symbol, qv: usd(r) })), types);
  const basis: Record<string, number> = {};
  if (category === "linear") for (const { t } of ranked) { const b = basisPct(t.markPrice, t.indexPrice); if (b !== undefined) basis[t.symbol] = b; }
  const inCls = ranked.filter((r) => inClass(src, r.symbol, assetClass, types?.get(r.symbol)));
  const turnover = inCls.filter((r) => passesTurnoverFloor(src, r.symbol, usd(r), types?.get(r.symbol)));
  const { kept: floored, thin } = splitLiquidity(src, turnover, floorUsd, assets, limit, types);
  const tickers = floored
    .map(({ t, qvUsd }, i) => ({
      rank: i + 1,
      symbol: t.symbol,
      lastPrice: t.lastPrice,
      priceChangePercent: (parseFloat(t.price24hPcnt ?? "0") * 100).toFixed(4),
      quoteVolume: quote === "USDT" ? (t.turnover24h ?? t.volume24h ?? "0") : String(qvUsd),
    }));
  return {
    tickers: filterTickers(tickers, assets, limit, src), universe, basis, belowFloor: inCls.length - turnover.length,
    quoteBySymbol: quoteMapOf(floored), quoteCounts: picked.counts, approx: picked.approx, depeg: picked.depeg, thin,
  };
}

async function fetchBybitKlines(
  category: "spot" | "linear",
  symbol: string,
  interval: string,
  signal?: AbortSignal,
  bars = 200,
  delta = false,
): Promise<Kline[]> {
  const mapped = bybitInterval(interval);
  const requestLimit = mapped.aggregate ? 1000 : clampLimit(bars, delta);
  const json = (await fetchJson(
    `${BYBIT_BASE}/v5/market/kline?category=${category}&symbol=${encodeURIComponent(symbol)}&interval=${mapped.interval}&limit=${requestLimit}`,
    `Bybit klines ${symbol}`,
    signal,
  )) as { result?: { list?: string[][] } };
  const parsed = (json.result?.list ?? [])
    .map((r) => ({
      time: Number(r[0]),
      open: parseFloat(r[1]),
      high: parseFloat(r[2]),
      low: parseFloat(r[3]),
      close: parseFloat(r[4]),
      volume: parseFloat(r[5]),
    }))
    .sort((a, b) => a.time - b.time);
  const closed = dropUnclosed(parsed, mapped.baseMs);
  const finalSeries = mapped.aggregate
    ? aggregateKlines(closed, mapped.aggregate, mapped.baseMs).slice(-clampLimit(bars))
    : closed;
  assertFresh(finalSeries, INTERVAL_MS[interval] ?? mapped.baseMs, symbol);
  return finalSeries;
}

function bitgetGranularity(interval: string): { granularity: string; aggregate?: number; baseMs: number } {
  const map: Record<string, string> = {
    "1m": "1min",
    "5m": "5min",
    "15m": "15min",
    "1h": "1h",
    "4h": "4h",
    // v2.3 (review S1): Bitget's plain 6h/12h/1day/1week/1M candles are cut on
    // UTC+8; the "…utc" granularities are UTC, like every other venue here.
    // (Bitget v2 docs; NOT VERIFIED against a live response in this build.)
    "6h": "6Hutc",
    "12h": "12Hutc",
    "1d": "1Dutc",
    "1w": "1Wutc",
    "1M": "1Mutc",
  };
  if (interval === "8h") return { granularity: "4h", aggregate: 2, baseMs: INTERVAL_MS["4h"] };
  if (interval === "2d") return { granularity: "1Dutc", aggregate: 2, baseMs: INTERVAL_MS["1d"] };
  if (interval === "4d") return { granularity: "1Dutc", aggregate: 4, baseMs: INTERVAL_MS["1d"] };
  return { granularity: map[interval] ?? "15min", baseMs: INTERVAL_MS[interval] ?? INTERVAL_MS["15m"] };
}

const BITGET_PERP_PRODUCT = "USDT-FUTURES";
/** v2.7: Bitget USDC-margined perpetuals (symbols `BTCPERP`, probe 11 Nov 2026). */
const BITGET_USDC_PRODUCT = "USDC-FUTURES";
/** Product type of a Bitget perpetual symbol (USDC perps are named …PERP). */
export function bitgetProductOf(symbol: string): string {
  return /PERP$/.test(symbol) ? BITGET_USDC_PRODUCT : BITGET_PERP_PRODUCT;
}

async function fetchBitgetTickers(assets?: string[], limit = 200, signal?: AbortSignal, assetClass: AssetClassFilter = "crypto", perp = false, quote: QuoteMode = DEFAULT_QUOTE, floorUsd = 0): Promise<TickerSet> {
  const src: DataSource = perp ? "bitget-perp" : "bitget";
  let list: RawBitgetTicker[];
  if (perp) {
    const products = quote === "USDT" ? [BITGET_PERP_PRODUCT] : quote === "USDC" ? [BITGET_USDC_PRODUCT] : [BITGET_PERP_PRODUCT, BITGET_USDC_PRODUCT];
    list = [];
    for (const product of products) {
      const json = (await fetchJson(`${BITGET_BASE}/api/v2/mix/market/tickers?productType=${product}`, "Bitget ticker upstream", signal)) as { data?: RawBitgetTicker[] };
      list.push(...(json.data ?? []));
    }
  } else {
    if (quote !== "USDT") await loadBitgetPairs(signal);
    const json = (await fetchJson(`${BITGET_BASE}/api/v2/spot/market/tickers`, "Bitget ticker upstream", signal)) as { data?: RawBitgetTicker[] };
    list = json.data ?? [];
  }
  // Spot quoteVolume is in the quote coin; usdtVolume (when present) is already USD-valued.
  const qvOf = (t: RawBitgetTicker) => parseFloat(t.usdtVolume ?? t.quoteVolume ?? "0") || 0;
  const usdValued = (t: RawBitgetTicker) => t.usdtVolume !== undefined;
  const picked = pickQuotes(src, list.filter((t) => SAFE_SYMBOL.test(t.symbol)), (t) => t.symbol,
    (t) => qvOf(t), (t) => parseFloat(t.lastPr), quote);
  // A row whose venue volume is already in USDT must not be converted again.
  for (const r of picked.rows) if (quote !== "USDT" && usdValued(r.t)) r.qvUsd = qvOf(r.t);
  const ranked = picked.rows.sort(byUsdDesc);
  const usd = (r: { qvUsd: number }) => (Number.isFinite(r.qvUsd) ? r.qvUsd : 0);
  const universe = universeOf(src, ranked.map((r) => ({ symbol: r.symbol, qv: usd(r) })));
  const basis: Record<string, number> = {};
  if (perp) for (const { t } of ranked) { const b = basisPct(t.markPrice, t.indexPrice); if (b !== undefined) basis[t.symbol] = b; }
  const inCls = ranked.filter((r) => inClass(src, r.symbol, assetClass));
  const turnover = inCls.filter((r) => passesTurnoverFloor(src, r.symbol, usd(r)));
  const { kept: floored, thin } = splitLiquidity(src, turnover, floorUsd, assets, limit);
  const tickers = floored
    .map(({ t, qvUsd }, i) => ({
      rank: i + 1,
      symbol: t.symbol,
      lastPrice: t.lastPr,
      priceChangePercent: (parseFloat(t.change24h ?? "0") * 100).toFixed(4),
      quoteVolume: quote === "USDT" ? (t.usdtVolume ?? t.quoteVolume ?? "0") : String(qvUsd),
    }));
  return {
    tickers: filterTickers(tickers, assets, limit, src), universe, basis, belowFloor: inCls.length - turnover.length,
    quoteBySymbol: quoteMapOf(floored), quoteCounts: picked.counts, approx: picked.approx, depeg: picked.depeg, thin,
  };
}

/** Bitget mix (perpetual) granularities use upper-case hour/day units. */
function bitgetPerpGranularity(interval: string): { granularity: string; aggregate?: number; baseMs: number } {
  const map: Record<string, string> = {
    "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "6h": "6Hutc",
    "12h": "12Hutc", "1d": "1Dutc", "1w": "1Wutc", "1M": "1Mutc",
  };
  if (interval === "8h") return { granularity: "4H", aggregate: 2, baseMs: INTERVAL_MS["4h"] };
  if (interval === "2d") return { granularity: "1Dutc", aggregate: 2, baseMs: INTERVAL_MS["1d"] };
  if (interval === "4d") return { granularity: "1Dutc", aggregate: 4, baseMs: INTERVAL_MS["1d"] };
  return { granularity: map[interval] ?? "15m", baseMs: INTERVAL_MS[interval] ?? INTERVAL_MS["15m"] };
}

async function fetchBitgetKlines(symbol: string, interval: string, signal?: AbortSignal, bars = 200, perp = false, delta = false): Promise<Kline[]> {
  const mapped = perp ? bitgetPerpGranularity(interval) : bitgetGranularity(interval);
  const end = Date.now();
  const requestLimit = mapped.aggregate ? 1000 : clampLimit(bars, delta);
  const json = (await fetchJson(
    perp
      ? `${BITGET_BASE}/api/v2/mix/market/candles?symbol=${encodeURIComponent(symbol)}&productType=${bitgetProductOf(symbol)}&granularity=${mapped.granularity}&endTime=${end}&limit=${requestLimit}`
      : `${BITGET_BASE}/api/v2/spot/market/candles?symbol=${encodeURIComponent(symbol)}&granularity=${mapped.granularity}&endTime=${end}&limit=${requestLimit}`,
    `Bitget klines ${symbol}`,
    signal,
  )) as { data?: string[][] };
  const parsed = (json.data ?? [])
    .map((r) => ({
      time: Number(r[0]),
      open: parseFloat(r[1]),
      high: parseFloat(r[2]),
      low: parseFloat(r[3]),
      close: parseFloat(r[4]),
      volume: parseFloat(r[5]),
    }))
    .sort((a, b) => a.time - b.time);
  const closed = dropUnclosed(parsed, mapped.baseMs);
  const finalSeries = mapped.aggregate
    ? aggregateKlines(closed, mapped.aggregate, mapped.baseMs).slice(-clampLimit(bars))
    : closed;
  assertFresh(finalSeries, INTERVAL_MS[interval] ?? mapped.baseMs, symbol);
  return finalSeries;
}

/* ---------------------------------------------------------------------------
 * Coins.ph (v2.6, ADR-0013). Transport, budget and cooldown live in coinsph.ts;
 * here its results are shaped like every other source.
 * ------------------------------------------------------------------------- */

/** Coins.ph rate limits surface as the shared RateLimitError (scoped to Coins.ph's own cooldown). */
async function viaCoinsph<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CoinsphError && e.kind === "RATE_LIMIT") throw new RateLimitError(e.message, e.retryAfterMs || coinsphCooldown());
    throw e;
  }
}

interface CoinsphTickerSet extends TickerSet { usdPhp: number | null; thin: string[] }

async function fetchCoinsphTickers(assets?: string[], limit = COINSPH_MAX_ASSETS, signal?: AbortSignal, assetClass: AssetClassFilter = "crypto"): Promise<CoinsphTickerSet> {
  const uni = await viaCoinsph(() => fetchCoinsphUniverse(signal));
  const universe = universeOf("coinsph", uni.ranked.map((r) => ({ symbol: r.symbol, qv: Number.isFinite(r.quoteVolumeUsd) ? r.quoteVolumeUsd : 0 })));
  const inCls = uni.ranked.filter((r) => inClass("coinsph", r.symbol, assetClass));
  const kept = inCls.filter((r) => coinsphPassesThinRule(r.quoteVolumeUsd));
  const thin = inCls.filter((r) => !coinsphPassesThinRule(r.quoteVolumeUsd)).map((r) => r.symbol);
  const tickers = kept.map((r, i) => ({
    rank: i + 1,
    symbol: r.symbol,
    lastPrice: String(r.lastPrice),
    priceChangePercent: r.changePct.toFixed(4),
    // Volumes are always USD in the app; Coins.ph's peso turnover is converted at its own USDT/PHP price.
    quoteVolume: String(r.quoteVolumeUsd),
  }));
  return {
    tickers: filterTickers(tickers, assets, Math.min(limit, COINSPH_MAX_ASSETS)),
    universe,
    basis: {},
    belowFloor: thin.length,
    usdPhp: uni.usdPhp,
    thin,
  };
}

async function fetchCoinsphKlines(symbol: string, interval: string, signal?: AbortSignal, bars = 200, delta = false): Promise<Kline[]> {
  const syntheticDays = SYNTHETIC_DAY_INTERVALS[interval];
  const upstreamInterval = syntheticDays ? "1d" : interval;
  if (!COINSPH_INTERVALS.has(upstreamInterval)) throw new Error(`Coins.ph has no ${interval} candles`);
  const requestLimit = syntheticDays ? 1000 : clampLimit(bars, delta);
  const parsed: Kline[] = await viaCoinsph(() => fetchCoinsphKlineRows(symbol, upstreamInterval, requestLimit, signal));
  const baseMs = INTERVAL_MS[upstreamInterval] ?? INTERVAL_MS["15m"];
  const closed = dropUnclosed(parsed, baseMs);
  const finalSeries = syntheticDays ? aggregateKlines(closed, syntheticDays, baseMs).slice(-clampLimit(bars)) : closed;
  assertFresh(finalSeries, INTERVAL_MS[interval] ?? baseMs, symbol);
  return finalSeries;
}

/**
 * PH premium per Coins.ph pair against Binance's global USDT price (one public
 * Binance call). Information only; any failure just leaves premiums out.
 */
async function coinsphPremiums(tickers: ServerTicker[], usdPhp: number | null, signal?: AbortSignal): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (!usdPhp || !tickers.length || rateLimitCooldown("binance") > 0) return out;
  try {
    const all = (await fetchJson(`${BINANCE_BASE}/api/v3/ticker/price`, "Binance price (PH premium)", signal)) as { symbol: string; price: string }[];
    const global = new Map(all.map((p) => [p.symbol, parseFloat(p.price)]));
    for (const t of tickers) {
      const base = t.symbol.replace(/PHP$/, "");
      const prem = phPremiumPct(parseFloat(t.lastPrice), global.get(`${base}USDT`) ?? NaN, usdPhp);
      if (prem !== undefined && Number.isFinite(prem)) out[t.symbol] = Math.round(prem * 1000) / 1000;
    }
  } catch {
    // Premium is optional context; the scan never fails because of it.
  }
  return out;
}

/**
 * v2.8 (WP27): true when `interval` is served natively by the source's candle
 * endpoint (delta requests apply); false for intervals aggregated from smaller
 * bars (Binance/Coins.ph 2d/4d, Bybit/Bitget 8h/2d/4d), which always fetch normally.
 */
export function deltaSupported(source: DataSource, interval: string): boolean {
  if (source === "binance" || source === "coinsph") return !SYNTHETIC_DAY_INTERVALS[interval];
  if (source === "bybit-spot" || source === "bybit-perp") return !bybitInterval(interval).aggregate;
  return !(source === "bitget-perp" ? bitgetPerpGranularity(interval) : bitgetGranularity(interval)).aggregate;
}

/** Closed bars of one series from the source's candle endpoint (`bars` requested; `delta` allows fewer than 100). */
export function fetchSymbolKlines(source: DataSource, interval: string, symbol: string, bars: number, signal?: AbortSignal, delta = false): Promise<Kline[]> {
  if (source === "coinsph") return fetchCoinsphKlines(symbol, interval, signal, bars, delta);
  if (source === "binance") return fetchBinanceKlines(symbol, interval, signal, bars, delta);
  if (source === "bybit-spot") return fetchBybitKlines("spot", symbol, interval, signal, bars, delta);
  if (source === "bybit-perp") return fetchBybitKlines("linear", symbol, interval, signal, bars, delta);
  return fetchBitgetKlines(symbol, interval, signal, bars, source === "bitget-perp", delta);
}

/**
 * v2.8 (WP27): one series with the delta rule. With a plan, ask `limit + 1`
 * bars (the extra one is the bar still building, dropped as unclosed) and
 * merge; when the overlap bar is missing or revised, fetch the full 1,000-bar
 * window instead (the caller discards its stored series). Without a plan,
 * `bars` as before (warm start 200, or 1,000).
 */
export async function fetchSeries(
  source: DataSource,
  interval: string,
  symbol: string,
  bars: number,
  signal?: AbortSignal,
  plan?: { limit: number; overlapOpenTime: number } | null,
  merge?: (fresh: Kline[], overlapOpenTime: number) => Kline[] | null,
): Promise<Kline[]> {
  if (plan && merge && deltaSupported(source, interval) && plan.limit >= 1) {
    const fresh = await fetchSymbolKlines(source, interval, symbol, plan.limit + 1, signal, true);
    const merged = merge(fresh, plan.overlapOpenTime);
    if (merged) return merged;
    return fetchSymbolKlines(source, interval, symbol, 1000, signal);
  }
  return fetchSymbolKlines(source, interval, symbol, bars, signal);
}

export async function fetchDirectMarketData(
  interval: string,
  source: DataSource = "binance",
  assets: string[] = [],
  limit = 200,
  signal?: AbortSignal,
  klineLimit?: (symbol: string) => number,
  assetClass: AssetClassFilter = "crypto",
  quoteMode: QuoteMode = DEFAULT_QUOTE,
  /** v2.8 (WP19): crypto liquidity floor, US$ (0 = off — the low-level default; fetchMarketData and the route pass the setting). */
  liquidityFloorUsd = 0,
  /** v2.8 (WP27): progressive-scan hooks (onSeries, delta, priority). */
  progressive: ProgressiveFetch = {},
): Promise<AllResponse> {
  const startedAt = Date.now();
  const floorUsd = Number.isFinite(liquidityFloorUsd) && liquidityFloorUsd > 0 ? liquidityFloorUsd : 0;
  const quote = normalizeQuoteMode(source, quoteMode);
  if (!VALID_INTERVALS.has(interval)) throw new Error(`Invalid interval: ${interval}`);
  assertNotCoolingDown(source);

  const klines: Record<string, Kline[]> = {};
  const errors: FetchError[] = [];
  // Coins.ph: one request at a time; coinsph.ts spaces and budgets them.
  const concurrency = source === "coinsph" ? 1 : 6;

  let set: TickerSet;
  let coinsph: CoinsphTickerSet | null = null;
  if (source === "coinsph") set = coinsph = await fetchCoinsphTickers(assets, limit, signal, assetClass);
  else if (source === "binance") set = await fetchBinanceTickers(assets, limit, signal, assetClass, quote, floorUsd);
  else if (source === "bybit-spot") set = await fetchBybitTickers("spot", assets, limit, signal, assetClass, quote, floorUsd);
  else if (source === "bybit-perp") set = await fetchBybitTickers("linear", assets, limit, signal, assetClass, quote, floorUsd);
  else set = await fetchBitgetTickers(assets, limit, signal, assetClass, source === "bitget-perp", quote, floorUsd);
  const tickers = set.tickers;
  // Everything the scan line and banners need that is known once the list is chosen (PH premium comes at the end).
  const listMeta: ListMeta = {
    universe: set.universe,
    basisBySymbol: set.basis,
    belowFloor: set.belowFloor,
    priceCurrency: priceCurrencyOf(source, quote),
    quote,
    quoteBySymbol: set.quoteBySymbol ?? Object.fromEntries(tickers.map((t) => [t.symbol, source === "coinsph" ? "PHP" : "USDT"])),
    ...(set.quoteCounts ? { quoteCounts: set.quoteCounts } : {}),
    ...(set.approx?.length ? { approxVolume: set.approx } : {}),
    ...(set.depeg?.length ? { depeg: set.depeg } : {}),
    // v2.8 (WP19): crypto pairs under the liquidity floor, for the thin-pair note in the scan line.
    ...(set.thin?.length ? { thinSymbols: set.thin, thinFloorUsd: floorUsd } : {}),
    ...(coinsph ? { usdPhp: coinsph.usdPhp, thinSymbols: coinsph.thin, thinFloorUsd: COINSPH_MIN_USD_TURNOVER } : {}),
  };
  progressive.onTickers?.(tickers, listMeta);

  let haltedUntil: number | undefined;
  // v2.8 (WP27): priority tiers — watch list (or top 10 by volume), then chunks of 20.
  const byVolume = [...tickers].sort((a, b) => (parseFloat(b.quoteVolume) || 0) - (parseFloat(a.quoteVolume) || 0)).map((t) => t.symbol);
  const tiers = priorityOrder(tickers.map((t) => t.symbol), progressive.priority?.length ? progressive.priority : null, byVolume);
  const run = await runTiers(tiers, (symbol) => {
    const plan = progressive.delta?.(symbol) ?? null;
    const merge = progressive.mergeDelta;
    return fetchSeries(source, interval, symbol, klineLimit ? klineLimit(symbol) : 200, signal, plan,
      merge ? (fresh, ov) => merge(symbol, fresh, ov) : undefined);
  }, {
    concurrency,
    signal,
    // Bitget allows ~20 public requests/s per IP; pace it harder (review S1). Coins.ph paces itself.
    pauseMs: source === "coinsph" ? 0 : source === "bitget" || source === "bitget-perp" ? 350 : 120,
    isHalt: (e) => e instanceof RateLimitError,
    onResult: (symbol, value) => {
      klines[symbol] = value;
      progressive.onSeries?.(symbol, value);
    },
    onError: (symbol, reason) => {
      errors.push({ symbol, reason: classify(reason), message: reason instanceof Error ? reason.message : String(reason) });
    },
    onBatch: progressive.onProgress,
  });
  // Stop at the first rate-limit response: every further request would only
  // extend the ban. Symbols not fetched (in any tier) are reported, not retried.
  if (run.halted) {
    haltedUntil = Date.now() + rateLimitCooldown(source);
    run.skipped.forEach((symbol) => errors.push({ symbol, reason: "RATE_LIMIT", message: "Skipped: scan halted by exchange rate limit." }));
  }

  const response = withHistograms(source, tickers, klines, errors, interval, startedAt);
  if (haltedUntil) response.rateLimitedUntil = haltedUntil;
  Object.assign(response, listMeta);
  if (coinsph) response.premiumBySymbol = await coinsphPremiums(tickers, coinsph.usdPhp, signal);
  return response;
}

export async function fetchMarketData(
  interval: string,
  options: MarketFetchOptions = {},
): Promise<AllResponse> {
  const source = options.source ?? "binance";
  const assets = options.assets ?? [];
  const limit = Math.min(options.limit ?? 100, sourceMeta(source).maxAssets);
  if (!VALID_INTERVALS.has(interval)) throw new Error(`Invalid interval: ${interval}`);
  const floor = options.liquidityFloorUsd === undefined ? DEFAULT_LIQUIDITY_FLOOR_USD : normalizeLiquidityFloor(options.liquidityFloorUsd);

  // Static exports and native shells have no server proxy by design.
  if (usesDirectFetch()) {
    const { onTickers, onSeries, onProgress, delta, mergeDelta, priority } = options;
    return fetchDirectMarketData(interval, source, assets, limit, options.signal, options.klineLimit, options.assetClass ?? "crypto", options.quote ?? DEFAULT_QUOTE, floor,
      { onTickers, onSeries, onProgress, delta, mergeDelta, priority });
  }

  try {
    return await fetchViaProxy(interval, source, assets, limit, options.signal, options.assetClass ?? "crypto", options.quote ?? DEFAULT_QUOTE, floor);
  } catch (err) {
    // Never retry a deliberately superseded scan.
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    // Do NOT silently re-issue 200 requests from the browser: that turns a
    // transient server error into an exchange rate-limit ban on the operator's
    // own IP, and changes the egress path without telling anyone.
    throw new Error(
      `Server proxy unavailable (${err instanceof Error ? err.message : "unknown error"}). ` +
        "Direct browser fetch is disabled to protect your IP from exchange rate limits. " +
        "Retry, or switch data source.",
    );
  }
}

/* ========================================================================== *
 *  Historical backfill (shared by the server route and static/native builds)
 * ========================================================================== */

/** Hard cap on bars returned by one backfill request. */
export const MAX_HISTORY_BARS = 5_000;

const HISTORY_SYNTHETIC: Record<string, { base: string; group: number }> = {
  "8h": { base: "4h", group: 2 },
  "2d": { base: "1d", group: 2 },
  "4d": { base: "1d", group: 4 },
};
const HISTORY_BYBIT: Record<string, string> = {
  "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240",
  "6h": "360", "12h": "720", "1d": "D", "1w": "W", "1M": "M",
};
const HISTORY_BITGET: Record<string, string> = {
  "1m": "1min", "5m": "5min", "15m": "15min", "1h": "1h", "4h": "4h",
  "6h": "6Hutc", "12h": "12Hutc", "1d": "1Dutc", "1w": "1Wutc", "1M": "1Mutc",
};

function historyMapping(source: DataSource, interval: string) {
  // Binance and Coins.ph serve 8h natively.
  const special = (source === "binance" || source === "coinsph") && interval === "8h" ? undefined : HISTORY_SYNTHETIC[interval];
  const base = special?.base ?? interval;
  return {
    upstream: source.startsWith("bybit")
      ? HISTORY_BYBIT[base]
      : source === "bitget" ? HISTORY_BITGET[base]
      : source === "bitget-perp" ? bitgetPerpGranularity(base).granularity
      : base,
    baseMs: INTERVAL_MS[base],
    group: special?.group ?? 1,
    pageSize: source === "bitget" || source === "bitget-perp" ? 200 : 1000,
  };
}

const parseRow = (r: (string | number)[]): Kline => ({
  time: Number(r[0]), open: Number(r[1]), high: Number(r[2]),
  low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]),
});
/** Binance rows also carry taker-buy base volume at index 9 (v2.8: quote volume at 7, trade count at 8). */
const parseBinanceRow = (r: (string | number)[]): Kline => ({
  ...parseRow(r),
  ...(r[9] !== undefined ? { takerBuy: Number(r[9]) } : {}),
  ...binanceExtras(r),
});

async function historyPage(
  source: DataSource,
  symbol: string,
  upstream: string,
  endTime: number,
  signal?: AbortSignal,
): Promise<Kline[]> {
  if (source === "coinsph") {
    return viaCoinsph(() => fetchCoinsphKlineRows(symbol, upstream, 1000, signal, endTime));
  }
  let url: string;
  if (source === "binance") {
    url = `${BINANCE_BASE}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${upstream}&endTime=${endTime}&limit=1000`;
  } else if (source.startsWith("bybit")) {
    const category = source === "bybit-perp" ? "linear" : "spot";
    url = `${BYBIT_BASE}/v5/market/kline?category=${category}&symbol=${encodeURIComponent(symbol)}&interval=${upstream}&end=${endTime}&limit=1000`;
  } else if (source === "bitget-perp") {
    url = `${BITGET_BASE}/api/v2/mix/market/history-candles?symbol=${encodeURIComponent(symbol)}&productType=${bitgetProductOf(symbol)}&granularity=${upstream}&endTime=${endTime}&limit=200`;
  } else {
    url = `${BITGET_BASE}/api/v2/spot/market/history-candles?symbol=${encodeURIComponent(symbol)}&granularity=${upstream}&endTime=${endTime}&limit=200`;
  }
  const json = await fetchJson(url, `${source} history`, signal);
  if (Array.isArray(json)) return (json as (string | number)[][]).map(source === "binance" ? parseBinanceRow : parseRow);
  const rows =
    (json as { result?: { list?: string[][] } }).result?.list ??
    (json as { data?: string[][] }).data ??
    [];
  return rows.map(parseRow);
}

export interface HistoryResult {
  klines: Kline[];
  complete: boolean;
}

/**
 * Page backwards from `endTime` until `limit` closed bars are collected or the
 * exchange runs out of history. Closed bars only; synthetic intervals are
 * epoch-aggregated exactly as in the live scan.
 */
export async function fetchHistory(
  source: DataSource,
  symbol: string,
  interval: string,
  limit: number,
  endTime = Date.now(),
  signal?: AbortSignal,
): Promise<HistoryResult> {
  if (!VALID_INTERVALS.has(interval)) throw new Error(`Invalid interval: ${interval}`);
  const mapped = historyMapping(source, interval);
  assertNotCoolingDown(source);
  const target = Math.max(200, Math.min(MAX_HISTORY_BARS, limit)) * mapped.group;
  const all = new Map<number, Kline>();
  let cursor = Number.isFinite(endTime) ? endTime : Date.now();
  let exhausted = false;
  while (all.size < target) {
    if (signal?.aborted) throw new DOMException("Backfill cancelled", "AbortError");
    const values = await historyPage(source, symbol, mapped.upstream, cursor, signal);
    if (!values.length) { exhausted = true; break; }
    values.forEach((bar) => { if (Number.isFinite(bar.time)) all.set(bar.time, bar); });
    const oldest = Math.min(...values.map((bar) => bar.time));
    if (!Number.isFinite(oldest) || oldest >= cursor) { exhausted = true; break; }
    cursor = oldest - 1;
    if (values.length < mapped.pageSize) { exhausted = true; break; }
    await sleep(120);
  }
  const closed = dropUnclosed([...all.values()], mapped.baseMs);
  const final = mapped.group > 1 ? aggregateKlines(closed, mapped.group, mapped.baseMs) : closed;
  return { klines: final.slice(-Math.min(MAX_HISTORY_BARS, limit)), complete: exhausted };
}

/**
 * v2.1.1 — page backwards from `toMs` until `fromMs` is covered (no 5,000-bar
 * cap). Used by the Node replay/backtest; same closed-bar and epoch
 * aggregation rules as the live scan. Stops at the first rate-limit response.
 */
export async function fetchHistoryRange(
  source: DataSource,
  symbol: string,
  interval: string,
  fromMs: number,
  toMs = Date.now(),
  signal?: AbortSignal,
  pauseMs = 250,
): Promise<Kline[]> {
  if (!VALID_INTERVALS.has(interval)) throw new Error(`Invalid interval: ${interval}`);
  assertNotCoolingDown(source);
  const mapped = historyMapping(source, interval);
  const all = new Map<number, Kline>();
  let cursor = toMs;
  for (let guard = 0; guard < 2000; guard++) {
    if (signal?.aborted) throw new DOMException("Replay cancelled", "AbortError");
    const values = await historyPage(source, symbol, mapped.upstream, cursor, signal);
    if (!values.length) break;
    values.forEach((bar) => { if (Number.isFinite(bar.time)) all.set(bar.time, bar); });
    const oldest = Math.min(...values.map((bar) => bar.time));
    if (!Number.isFinite(oldest) || oldest >= cursor || oldest <= fromMs) break;
    cursor = oldest - 1;
    if (values.length < mapped.pageSize) break;
    await sleep(pauseMs);
  }
  const closed = dropUnclosed([...all.values()], mapped.baseMs).filter((b) => b.time <= toMs);
  return mapped.group > 1 ? aggregateKlines(closed, mapped.group, mapped.baseMs) : closed;
}

/* ========================================================================== *
 *  v2.3 — order-book depth → measured slippage
 * ========================================================================== */

export interface OrderBook { bids: [number, number][]; asks: [number, number][] }

/**
 * Average one-side slippage in basis points for a market order of `notional`
 * (quote currency) against `book`: half-spread plus the VWAP walk, averaged
 * over a buy and a sell. Returns NaN when the visible book is too thin.
 */
export function slippageBps(book: OrderBook, notional: number): number {
  const bid = book.bids[0]?.[0];
  const ask = book.asks[0]?.[0];
  if (!(bid > 0) || !(ask > 0) || !(notional > 0)) return NaN;
  const mid = (bid + ask) / 2;
  const walk = (levels: [number, number][]): number => {
    let left = notional;
    let qty = 0;
    for (const [px, q] of levels) {
      const take = Math.min(left, px * q);
      qty += take / px;
      left -= take;
      if (left <= 1e-9) break;
    }
    return left > 1e-9 ? NaN : notional / qty; // VWAP
  };
  const buy = walk(book.asks);
  const sell = walk(book.bids);
  if (!Number.isFinite(buy) || !Number.isFinite(sell)) return NaN;
  return (((buy - mid) / mid + (mid - sell) / mid) / 2) * 1e4;
}

const toLevels = (rows: unknown): [number, number][] =>
  Array.isArray(rows)
    ? (rows as unknown[][])
        .map((r) => [Number(r[0]), Number(r[1])] as [number, number])
        .filter(([p, q]) => p > 0 && q > 0)
    : [];

/** Public order book snapshot (top 50–100 levels). */
export async function fetchOrderBook(source: DataSource, symbol: string, signal?: AbortSignal): Promise<OrderBook> {
  if (!SAFE_SYMBOL.test(symbol)) throw new Error("Invalid symbol");
  assertNotCoolingDown(source);
  const s = encodeURIComponent(symbol);
  if (source === "coinsph") {
    const j = (await viaCoinsph(() => coinsphGet(`/openapi/quote/v1/depth?symbol=${s}&limit=100`, 5, signal))) as { bids?: unknown; asks?: unknown };
    return { bids: toLevels(j.bids), asks: toLevels(j.asks) };
  }
  if (source === "binance") {
    const j = (await fetchJson(`${BINANCE_BASE}/api/v3/depth?symbol=${s}&limit=100`, `Binance depth ${symbol}`, signal)) as { bids?: unknown; asks?: unknown };
    return { bids: toLevels(j.bids), asks: toLevels(j.asks) };
  }
  if (source === "bybit-spot" || source === "bybit-perp") {
    const cat = source === "bybit-perp" ? "linear" : "spot";
    const j = (await fetchJson(`${BYBIT_BASE}/v5/market/orderbook?category=${cat}&symbol=${s}&limit=50`, `Bybit depth ${symbol}`, signal)) as { result?: { b?: unknown; a?: unknown } };
    return { bids: toLevels(j.result?.b), asks: toLevels(j.result?.a) };
  }
  const url = source === "bitget-perp"
    ? `${BITGET_BASE}/api/v2/mix/market/merge-depth?symbol=${s}&productType=${bitgetProductOf(symbol)}&limit=50`
    : `${BITGET_BASE}/api/v2/spot/market/orderbook?symbol=${s}&type=step0&limit=50`;
  const j = (await fetchJson(url, `Bitget depth ${symbol}`, signal)) as { data?: { bids?: unknown; asks?: unknown } };
  return { bids: toLevels(j.data?.bids), asks: toLevels(j.data?.asks) };
}

/** Recent executions for the Bybit linear order-flow pilot. */
export async function fetchBybitLinearTrades(symbol: string, signal?: AbortSignal): Promise<PublicTrade[]> {
  if (!SAFE_SYMBOL.test(symbol)) throw new Error("Invalid symbol");
  assertNotCoolingDown("bybit-perp");
  const data = await fetchJson(
    BYBIT_BASE + "/v5/market/recent-trade?category=linear&limit=50&symbol=" + encodeURIComponent(symbol),
    "Bybit public trades " + symbol,
    signal,
  ) as { retCode?: number; result?: { list?: unknown } };
  if (data.retCode !== 0 || !Array.isArray(data.result?.list)) throw new Error("Bybit trades unavailable");
  return normalizePublicTrades(data.result.list, symbol);
}
