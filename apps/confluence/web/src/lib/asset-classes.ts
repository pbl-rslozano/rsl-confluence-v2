/**
 * asset-classes.ts — v2.1.1
 * ----------------------------------------------------------------------------
 * Classifies exchange symbols into asset classes so the scanner can show
 * crypto, RWAs (tokenised gold / treasuries / RWA-sector tokens), tokenised
 * stocks and currency (FX) pairs separately — all from the three exchanges the
 * app already talks to (no new network host, no API key).
 *
 * Classification order:
 *   1. the venue's own instrument type when known — Bybit V5 instruments-info
 *      `symbolType` (linear: stock / ETF / commodity / forex; spot: xstocks;
 *      "" or "innovation" = crypto). This also stops stock and commodity perps
 *      (TSLAUSDT, COINUSDT, XAUUSDT…) leaking into the "crypto" top-N, which
 *      name patterns cannot do reliably;
 *   2. curated lists and symbol patterns (Binance bStocks "…BUSDT", Ondo
 *      "…ONUSDT", xStocks "…XUSDT", fiat stablecoins, tokenised gold);
 *   3. otherwise crypto.
 * See docs/asset-classes.md for sources and dates.
 * ----------------------------------------------------------------------------
 */
import { isPerpSource, splitPair, stableQuote, USD_STABLE_ASSETS } from "./quotes";
import type { AssetClass } from "./ledger-metrics";

export type AssetClassFilter = AssetClass | "all";

export const ASSET_CLASS_FILTERS: AssetClassFilter[] = ["crypto", "rwa", "stock", "fx", "commodity", "all"];

/**
 * Leveraged tokens: never scanned (they decay by construction). Binance's
 * UP/DOWN tokens only ever existed on these bases; Bybit/Bitget use 2L/3S…
 * suffixes. (2.02 matched any "…UPUSDT", silently dropping JUPUSDT and
 * SYRUPUSDT from every scan.)
 */
const LEVERAGED =
  /^((BTC|ETH|BNB|XRP|ADA|DOT|LINK|LTC|TRX|EOS|XTZ|FIL|SXP|YFI|UNI|AAVE|SUSHI|1INCH|BCH|XLM)(UP|DOWN|BULL|BEAR)|[A-Z0-9]{2,}[2-5][LS])USDT$/;

/** USD-pegged stablecoins: flat series, no directional information in any class. */
const USD_PEGS = new Set([
  "USDCUSDT", "TUSDUSDT", "FDUSDUSDT", "BUSDUSDT", "USDPUSDT", "DAIUSDT", "USDEUSDT", "USDSUSDT", "USD1USDT",
  "PYUSDUSDT", "RLUSDUSDT", "XUSDUSDT", "USDQUSDT", "BFUSDUSDT", "USTCUSDT", "USDDUSDT", "FRAXUSDT", "GUSDUSDT",
  "USDGUSDT", "USDAIUSDT", "USDTBUSDT",
]);

/** Non-USD fiat stablecoins and fiat pairs quoted in USDT → currency (FX) class. */
const FX = new Set([
  "EURUSDT", "EURIUSDT", "AEURUSDT", "EURCUSDT", "EUROPUSDT", "GBPUSDT", "AUDUSDT", "JPYUSDT", "CHFUSDT",
  "TRYUSDT", "BRLUSDT", "MXNUSDT", "ZARUSDT", "XSGDUSDT", "IDRTUSDT", "BIDRUSDT", "CNHTUSDT", "EURRUSDT",
]);

/** Tokenised commodities (spot tokens) and commodity perpetuals. */
const COMMODITY = new Set([
  "PAXGUSDT", "XAUTUSDT", "XAUUSDT", "XAGUSDT", "XPTUSDT", "XPDUSDT", "KAUUSDT", "KAGUSDT", "CGOUSDT",
  "WTIUSDT", "BRENTUSDT", "USOILUSDT", "UKOILUSDT", "NATGASUSDT", "COPPERUSDT", "GOLDUSDT", "SILVERUSDT",
]);

/** RWA-sector tokens: tokenised treasuries/funds, RWA platforms and credit. */
const RWA = new Set([
  "ONDOUSDT", "USDYUSDT", "OUSGUSDT", "BUIDLUSDT", "BENJIUSDT", "STBTUSDT", "TBILLUSDT", "USTBUSDT",
  "CFGUSDT", "PLUMEUSDT", "OMUSDT", "POLYXUSDT", "TRUUSDT", "MPLUSDT", "SYRUPUSDT", "CPOOLUSDT",
  "GFIUSDT", "RIOUSDT", "PROPCUSDT", "LANDUSDT", "TOKENUSDT", "RSRUSDT", "SKYUSDT",
]);

/**
 * Tokenised equities and ETFs. Backed xStocks use an "X" suffix on the ticker
 * (AAPLXUSDT, TSLAXUSDT, SPYXUSDT …); Ondo Global Markets tokens use "ON"
 * (AAPLONUSDT …). Exchange stock perpetuals use the plain ticker and are listed
 * explicitly per source in STOCK_PERPS.
 */
const XSTOCK = /^[A-Z]{1,5}XUSDT$/;
const ONDO_STOCK = /^[A-Z]{1,5}ONUSDT$/;
const KNOWN_EQUITY_TICKERS = new Set([
  "AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "GOOG", "META", "NFLX", "AMD", "INTC", "COIN", "MSTR", "HOOD",
  "PLTR", "CRCL", "SPY", "QQQ", "IWM", "GLD", "SLV", "TLT", "ORCL", "AVGO", "CRM", "UBER", "ABNB", "BABA",
  "JPM", "WMT", "PEP", "DIS", "NKE", "XOM", "CVX", "LLY", "UNH", "COST", "ADBE",
  "MCD", "PFE", "MRK", "TSM", "ASML", "SHOP", "XYZ", "PYPL", "ARM", "SMCI", "RDDT", "CRWD", "GME", "AMC",
]);
/**
 * Fallback for Bybit stock/ETF perps (bare ticker + USDT) when the instrument
 * list could not be read. Deliberately short: only tickers with no crypto
 * namesake on that venue.
 */
const BYBIT_PERP_EQUITY = new Set([
  "TSLAUSDT", "NVDAUSDT", "AAPLUSDT", "MSFTUSDT", "GOOGLUSDT", "AMZNUSDT", "METAUSDT", "MSTRUSDT", "COINUSDT",
  "HOODUSDT", "ORCLUSDT", "TSMUSDT", "INTCUSDT", "CRCLUSDT", "SPYUSDT", "QQQUSDT", "PLTRUSDT", "AMDUSDT", "NFLXUSDT",
  "EWJUSDT", "EWYUSDT", "MUUSDT",
]);
/** FX perps quoted in USDT (EURUSDUSDT …) and oil perps (WTI CL, Brent BZ) on Bybit linear. */
const FX_PERP = /^(EUR|GBP|AUD|NZD|USD|CAD|CHF|JPY)(USD|JPY|CHF|CAD|CNH)USDT$/;
const BYBIT_PERP_COMMODITY = new Set(["CLUSDT", "BZUSDT", "NGUSDT", "XCUUSDT"]);
/** Binance spot bStocks: ticker + "B" + USDT (TSLABUSDT, NVDABUSDT, SPYBUSDT …). */
const BSTOCK = /^[A-Z]{1,5}BUSDT$/;

function equityTicker(symbol: string): string | null {
  if (XSTOCK.test(symbol)) {
    const base = symbol.slice(0, -5);
    return KNOWN_EQUITY_TICKERS.has(base) ? base : null;
  }
  if (ONDO_STOCK.test(symbol)) {
    const base = symbol.slice(0, -6);
    return KNOWN_EQUITY_TICKERS.has(base) ? base : null;
  }
  if (BSTOCK.test(symbol)) {
    const base = symbol.slice(0, -5);
    return KNOWN_EQUITY_TICKERS.has(base) ? base : null;
  }
  return null;
}

/** Venue instrument type (lower-case) → asset class; undefined = not decisive. */
function fromVenueType(type: string | undefined): AssetClass | undefined {
  switch (type) {
    case "stock":
    case "etf":
    case "xstocks":
      return "stock";
    case "commodity":
    case "metal":
    case "energy":
      return "commodity";
    case "forex":
    case "fx":
      return "fx";
    default:
      return undefined; // "", "innovation", unknown → decide by symbol
  }
}

/** v2.6 Coins.ph: USD stablecoins quoted in pesos are the peso against the dollar. */
const PHP_USD_STABLES = new Set(["USDT", "USDC", "FDUSD", "PYUSD", "USDP", "TUSD", "DAI", "USDE", "USD1", "RLUSD", "USDG"]);

export function classifySymbol(source: string, symbol: string, venueType?: string): AssetClass | "excluded" {
  const s = symbol.toUpperCase();
  if (source === "coinsph") {
    // Only peso pairs are scanned on Coins.ph (ADR-0013). A coin is classified
    // as its USDT twin would be, so PAXG stays a commodity, ONDO an RWA, etc.
    const m = /^([A-Z0-9]{2,})PHP$/.exec(s);
    if (!m) return "excluded";
    if (PHP_USD_STABLES.has(m[1])) return "fx";
    return classifySymbol("binance", `${m[1]}USDT`, venueType);
  }
  // v2.7 (WP12.4): a pair on another stablecoin (BTCUSDC, ETHFDUSD, SOLEURI, BTCPERP USDC perps)
  // is classified as its USDT twin; a USD stablecoin against a USD-pegged quote is flat → excluded.
  if (!s.endsWith("USDT")) {
    const { base, quote } = splitPair(s, source);
    const q = stableQuote(quote);
    if (q && base) {
      if (q.peg === "USD" && USD_STABLE_ASSETS.has(base)) return "excluded";
      return classifySymbol(source, `${base}USDT`, venueType);
    }
  }
  if (LEVERAGED.test(s) || USD_PEGS.has(s)) return "excluded";
  const venue = fromVenueType(venueType);
  if (venue) return venue;
  const perp = isPerpSource(source);
  if (FX.has(s) || (perp && FX_PERP.test(s))) return "fx";
  if (COMMODITY.has(s) || (perp && BYBIT_PERP_COMMODITY.has(s))) return "commodity";
  if (equityTicker(s)) return "stock";
  // Without a venue type, bare-ticker perps are only trusted from the short list.
  if (source === "bybit-perp" && venueType === undefined && BYBIT_PERP_EQUITY.has(s)) return "stock";
  if (RWA.has(s)) return "rwa";
  return "crypto";
}

/** Does `symbol` belong to the requested class on `source`? */
export function inClass(source: string, symbol: string, filter: AssetClassFilter, venueType?: string): boolean {
  const cls = classifySymbol(source, symbol, venueType);
  if (cls === "excluded") return false;
  return filter === "all" || cls === filter;
}

/**
 * Asset classes whose underlying market closes (stocks: US sessions; FX:
 * weekends). Tokens keep trading 24/7 against a stale reference, so bars
 * printed while the underlying is shut are flagged in the UI.
 */
export function hasSessionGaps(cls: AssetClass): boolean {
  return cls === "stock" || cls === "fx" || cls === "commodity";
}

/* ------------------------------------------------------------------ *
 *  Underlying-market sessions (UTC). US equities: 09:30–16:00 New York;
 *  FX: Sunday 17:00 → Friday 17:00 New York. US daylight saving: second
 *  Sunday of March → first Sunday of November. NYSE holidays and 13:00 ET
 *  early closes 2026–2028 are hard-coded from NYSE Group's release of
 *  23 Dec 2025 (refresh yearly).
 *  v2.3: FX closes on 25 Dec and 1 Jan (interbank liquidity holidays);
 *  CME metals/energy close on Good Friday, 25 Dec and 1 Jan and halt at
 *  13:30 New York on the other US exchange holidays. These CME/FX rules are
 *  simplified and NOT VERIFIED against the 2026–2028 CME holiday notices.
 * ------------------------------------------------------------------ */
function nthSundayUTC(year: number, month: number, n: number): number {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (7 - first.getUTCDay()) % 7;
  return Date.UTC(year, month, 1 + offset + (n - 1) * 7);
}
/** New York UTC offset in hours (−4 in summer time, −5 in winter). */
export function newYorkOffsetHours(ms: number): number {
  const y = new Date(ms).getUTCFullYear();
  const start = nthSundayUTC(y, 2, 2) + 7 * 3_600_000; // 2:00 local EST = 07:00 UTC
  const end = nthSundayUTC(y, 10, 1) + 6 * 3_600_000; // 2:00 local EDT = 06:00 UTC
  return ms >= start && ms < end ? -4 : -5;
}
function nyClock(ms: number): { day: number; minutes: number; date: string } {
  const local = new Date(ms + newYorkOffsetHours(ms) * 3_600_000);
  return { day: local.getUTCDay(), minutes: local.getUTCHours() * 60 + local.getUTCMinutes(), date: local.toISOString().slice(0, 10) };
}

/** NYSE full-day closures (NYSE Group, 23 Dec 2025). Nasdaq follows the same calendar. */
export const NYSE_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
  "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19", "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25",
]);
/** NYSE early closes at 13:00 New York. */
export const NYSE_EARLY_CLOSES = new Set(["2026-11-27", "2026-12-24", "2027-11-26", "2028-07-03", "2028-11-24"]);
/** Good Friday (NYSE table) — CME metals/energy closed. */
const GOOD_FRIDAYS = new Set(["2026-04-03", "2027-03-26", "2028-04-14"]);
const isYearEnd = (date: string) => date.endsWith("-12-25") || date.endsWith("-01-01");
/** Last year the holiday table covers; after it the session model warns that holidays are unknown. */
export const HOLIDAY_TABLE_UNTIL = 2028;
/** Is the underlying market open at instant `ms`? Crypto, RWA and commodities tokens: always. */
export function underlyingOpenAt(cls: AssetClass, ms: number): boolean {
  if (!hasSessionGaps(cls)) return true;
  const { day, minutes, date } = nyClock(ms);
  if (cls === "stock") {
    if (day < 1 || day > 5 || NYSE_HOLIDAYS.has(date)) return false;
    const close = NYSE_EARLY_CLOSES.has(date) ? 13 * 60 : 16 * 60;
    return minutes >= 9 * 60 + 30 && minutes < close;
  }
  if (cls === "commodity") {
    // CME Globex metals/energy: Sunday 18:00 → Friday 17:00 New York, with a
    // daily 17:00–18:00 maintenance break. Tokenised gold trades 24/7 on-chain,
    // but its reference market follows these hours. Holidays not modelled.
    if (day === 6) return false;
    if (isYearEnd(date) || GOOD_FRIDAYS.has(date)) return false;
    // Other US holidays: early halt at 13:30 (session re-opens 18:00).
    if (NYSE_HOLIDAYS.has(date) && minutes >= 13 * 60 + 30 && minutes < 18 * 60) return false;
    if (day === 5) return minutes < 17 * 60;
    if (day === 0) return minutes >= 18 * 60;
    return minutes < 17 * 60 || minutes >= 18 * 60;
  }
  // FX: closed from Friday 17:00 to Sunday 17:00 New York, and on 25 Dec / 1 Jan.
  if (isYearEnd(date)) return false;
  if (day === 6) return false;
  if (day === 5) return minutes < 17 * 60;
  if (day === 0) return minutes >= 17 * 60;
  return true;
}
/** True when the underlying market was closed for the whole bar [open, open+interval). */
export function barWhileClosed(cls: AssetClass, openMs: number, intervalMs: number): boolean {
  if (!hasSessionGaps(cls)) return false;
  const step = Math.min(intervalMs, 15 * 60_000);
  for (let t = openMs; t < openMs + intervalMs; t += step) if (underlyingOpenAt(cls, t)) return false;
  return true;
}
