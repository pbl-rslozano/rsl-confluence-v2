/**
 * quotes.ts — v2.7 (plan WP12): stablecoin quote pairing.
 *
 * One registry of stablecoin QUOTES (with the fiat they are pegged to), one
 * `splitPair` used everywhere a pair symbol is taken apart (v2.6 stripped
 * `USDT|USD|PHP` by regex in five places, so BTCFDUSD became "BTCFD"), and the
 * per-scan selection of which pair represents each coin.
 *
 * Fiat order books (Bybit/Bitget "USD", "EUR") are not stablecoins and are not
 * offered. Indicators always use ONE real pair's candles; quotes are never
 * blended into synthetic candles.
 */

export type Peg = "USD" | "EUR";
export interface StableQuote { code: string; peg: Peg; name: string; /** safe to recognise by symbol suffix alone */ suffix: boolean }

/** Ordered by how often venues list them (menu order). */
export const STABLE_QUOTES: readonly StableQuote[] = [
  { code: "USDT", peg: "USD", name: "Tether USD", suffix: true },
  { code: "USDC", peg: "USD", name: "USD Coin", suffix: true },
  { code: "FDUSD", peg: "USD", name: "First Digital USD", suffix: true },
  { code: "USD1", peg: "USD", name: "World Liberty USD1", suffix: true },
  { code: "USDE", peg: "USD", name: "Ethena USDe", suffix: true },
  { code: "RLUSD", peg: "USD", name: "Ripple USD", suffix: true },
  { code: "XUSD", peg: "USD", name: "StraitsX XUSD", suffix: true },
  { code: "PYUSD", peg: "USD", name: "PayPal USD", suffix: true },
  { code: "USDG", peg: "USD", name: "Global Dollar", suffix: true },
  { code: "TUSD", peg: "USD", name: "TrueUSD", suffix: true },
  { code: "DAI", peg: "USD", name: "Dai", suffix: true },
  { code: "BFUSD", peg: "USD", name: "BFUSD", suffix: true },
  // "U" is a real Binance/Bitget quote, but too short to recognise from a symbol: venue metadata only.
  { code: "U", peg: "USD", name: "United Stables U", suffix: false },
  { code: "EURI", peg: "EUR", name: "Eurite", suffix: true },
  { code: "EURC", peg: "EUR", name: "Euro Coin", suffix: true },
];
const BY_CODE = new Map(STABLE_QUOTES.map((q) => [q.code, q]));
/** Longest code first so FDUSD wins over a shorter suffix. */
const SUFFIXES = STABLE_QUOTES.filter((q) => q.suffix).map((q) => q.code).sort((a, b) => b.length - a.length);

export function stableQuote(code: string): StableQuote | undefined {
  return BY_CODE.get(code.toUpperCase());
}
export function isStableQuote(code: string): boolean {
  return BY_CODE.has(code.toUpperCase());
}
/** USD-pegged stablecoins as BASE assets (a stablecoin against a USD quote is flat → excluded). */
export const USD_STABLE_ASSETS = new Set([
  ...STABLE_QUOTES.filter((q) => q.peg === "USD").map((q) => q.code),
  "BUSD", "USDP", "USDS", "USDQ", "USTC", "USDD", "FRAX", "GUSD", "USDAI", "USDTB", "LUSD", "CRVUSD", "SUSD",
]);

/** The scan setting: one quote, or the deepest USD-pegged pair per coin. */
export type QuoteMode = string; // a STABLE_QUOTES code, "PHP" (Coins.ph) or BEST
export const BEST = "BEST";
export const DEFAULT_QUOTE: QuoteMode = "USDT";

/** Quotes each source can offer before live metadata arrives (probe 11 Nov 2026 / docs). */
export const VENUE_QUOTES: Record<string, readonly string[]> = {
  binance: ["USDT", "USDC", "FDUSD", "USD1", "U", "EURI"],
  "bybit-spot": ["USDT", "USDC", "USD1", "USDE", "RLUSD", "XUSD"],
  "bybit-perp": ["USDT", "USDC"],
  bitget: ["USDT", "USDC", "USD1", "USDE", "RLUSD", "U"],
  "bitget-perp": ["USDT", "USDC"],
  coinsph: ["PHP"],
};
export function isPerpSource(source: string): boolean {
  return source === "bybit-perp" || source === "bitget-perp";
}
/** Modes the Quote menu offers for a source: its quotes, plus Best when it has ≥ 2 USD-pegged ones. */
export function quoteModesFor(source: string, live?: readonly string[]): QuoteMode[] {
  const base = (live && live.length ? live : VENUE_QUOTES[source] ?? ["USDT"]).filter((q) => q === "PHP" || isStableQuote(q));
  const ordered = [...new Set(["USDT", ...base])].filter((q) => (VENUE_QUOTES[source] ?? []).includes(q) || (live ?? []).includes(q));
  const usd = ordered.filter((q) => stableQuote(q)?.peg === "USD");
  return usd.length >= 2 ? [...ordered, BEST] : ordered;
}
/** A saved / stored mode that this source cannot serve falls back to its default. */
export function normalizeQuoteMode(source: string, mode: string | undefined): QuoteMode {
  if (source === "coinsph") return "PHP";
  const m = (mode ?? DEFAULT_QUOTE).toUpperCase();
  if (m === BEST) return BEST;
  if (isPerpSource(source)) return m === "USDC" ? "USDC" : "USDT";
  return isStableQuote(m) ? m : DEFAULT_QUOTE;
}
/** Price currency of a scan in this mode (Best only picks USD-pegged quotes). */
export function priceCurrencyOfQuote(source: string, mode: QuoteMode): "USD" | "EUR" | "PHP" {
  if (source === "coinsph") return "PHP";
  return stableQuote(mode)?.peg === "EUR" ? "EUR" : "USD";
}

/* ---------------- splitting pair symbols ---------------- */

export interface PairParts { base: string; quote: string }
/** Venue metadata (symbol → base/quote), remembered per source when it is read. */
const known = new Map<string, Map<string, PairParts>>();
export function rememberPairs(source: string, entries: Iterable<[string, PairParts]>): void {
  const m = new Map<string, PairParts>();
  for (const [s, p] of entries) if (p.base && p.quote) m.set(s.toUpperCase(), { base: p.base.toUpperCase(), quote: p.quote.toUpperCase() });
  known.set(source, m);
}
export function knownPairs(source: string): Map<string, PairParts> | undefined {
  return known.get(source);
}
export function forgetPairsForTests(): void {
  known.clear();
}

/**
 * Split an exchange symbol into base and quote. Venue metadata first; then
 * USDC perpetual names (`BTCPERP`, Bybit linear / Bitget USDC-FUTURES); then the
 * longest known suffix (stablecoins, PHP, plain USD). Unknown → quote "".
 */
export function splitPair(symbol: string, source?: string): PairParts {
  const s = symbol.toUpperCase();
  const meta = source ? known.get(source)?.get(s) : undefined;
  if (meta) return meta;
  if (/PERP$/.test(s) && s.length > 4 && (!source || isPerpSource(source))) return { base: s.slice(0, -4), quote: "USDC" };
  for (const q of SUFFIXES) if (s.length > q.length && s.endsWith(q)) return { base: s.slice(0, -q.length), quote: q };
  if (s.length > 3 && s.endsWith("PHP")) return { base: s.slice(0, -3), quote: "PHP" };
  if (s.length > 3 && s.endsWith("USD")) return { base: s.slice(0, -3), quote: "USD" };
  return { base: s, quote: "" };
}
/** Base asset of a pair (`BTCFDUSD` → BTC, `ETHPERP` → ETH). */
export function baseOf(symbol: string, source?: string): string {
  return splitPair(symbol, source).base;
}
/** Strip a quote from user input ("BTC/USDC", "btc-usdt", "SOL") → base. */
export function baseFromInput(text: string): string {
  const t = text.trim().toUpperCase().replace(/[-_/\s]+/g, "");
  const { base, quote } = splitPair(t);
  return quote ? base : t;
}

/* ---------------- choosing pairs per coin ---------------- */

export interface QuoteRow { symbol: string; base: string; quote: string; qvUsd: number }

/** Hysteresis for Best: keep the previous pick unless another quote is ≥ 25 % deeper. */
export const BEST_SWITCH_RATIO = 1.25;
const lastPick = new Map<string, string>(); // `${source}:${base}` → symbol
export function resetBestPicksForTests(): void {
  lastPick.clear();
}

/**
 * Keep the rows the mode asks for. One quote → its pairs. Best → per base, the
 * USD-pegged pair with the highest USD volume (with hysteresis). Rows whose USD
 * volume is unknown (NaN) lose to any known one.
 */
export function selectPairs<T extends QuoteRow>(source: string, rows: readonly T[], mode: QuoteMode): T[] {
  if (mode !== BEST) return rows.filter((r) => r.quote === mode);
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    if (stableQuote(r.quote)?.peg !== "USD") continue;
    const g = groups.get(r.base);
    if (g) g.push(r); else groups.set(r.base, [r]);
  }
  const vol = (r: T) => (Number.isFinite(r.qvUsd) ? r.qvUsd : -1);
  const out: T[] = [];
  for (const [base, g] of groups) {
    let best = g[0];
    for (const r of g) if (vol(r) > vol(best) || (vol(r) === vol(best) && r.quote === "USDT")) best = r;
    const key = `${source}:${base}`;
    const prev = g.find((r) => r.symbol === lastPick.get(key));
    if (prev && prev !== best && vol(best) < vol(prev) * BEST_SWITCH_RATIO) best = prev;
    lastPick.set(key, best.symbol);
    out.push(best);
  }
  return out;
}

/* ---------------- depeg monitor (information only, WP12.5) ---------------- */

export type DepegLevel = "watch" | "warning" | "severe";
export const DEPEG_TIERS: readonly [DepegLevel, number][] = [["severe", 2], ["warning", 1], ["watch", 0.5]];
/** Deviation from the peg in % → tier, or null when within 0.5 %. */
export function depegLevel(deviationPct: number): DepegLevel | null {
  if (!Number.isFinite(deviationPct)) return null;
  const a = Math.abs(deviationPct);
  for (const [level, min] of DEPEG_TIERS) if (a >= min) return level;
  return null;
}
export interface DepegReading { coin: string; reference: string; price: number; deviationPct: number; level: DepegLevel }
