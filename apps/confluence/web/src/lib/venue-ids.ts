/**
 * venue-ids.ts — v2.8 Step 2 (plan WP26): the new exchanges' native instrument ids
 * ⇄ the app's pair symbols.
 *
 *   coinbase  BTC-USD        ⇄ BTCUSD
 *   upbit     KRW-BTC        ⇄ BTCKRW   (the venue writes QUOTE-BASE; the app writes BASE+QUOTE)
 *   okx       BTC-USDT       ⇄ BTCUSDT
 *   okx-perp  BTC-USDT-SWAP  ⇄ BTCUSDT  (linear swaps only; BTC-USD-SWAP inverse is not offered)
 *
 * Every symbol must match `[A-Z0-9]{2,30}` (the app-wide SAFE_PAIR); anything else is
 * null so a hostile or odd venue id never becomes a pair. Pure; no network.
 */
import { knownPairs, VENUE_QUOTES } from "./quotes";

/** The four source ids added by WP26, used verbatim everywhere. */
export const NEW_SOURCES = ["okx", "okx-perp", "coinbase", "upbit"] as const;
export type NewSource = (typeof NEW_SOURCES)[number];

const SAFE = /^[A-Z0-9]{2,30}$/;
const PART = /^[A-Z0-9]+$/;

/** Native venue id → app symbol, or null when the id is not one we offer. */
export function venueSymbol(source: string, venueId: string): string | null {
  const parts = String(venueId ?? "").toUpperCase().split("-");
  let base: string;
  let quote: string;
  if (source === "upbit") {
    if (parts.length !== 2) return null;
    [quote, base] = parts;
  } else if (source === "coinbase" || source === "okx") {
    if (parts.length !== 2) return null;
    [base, quote] = parts;
  } else if (source === "okx-perp") {
    if (parts.length !== 3 || parts[2] !== "SWAP" || parts[1] !== "USDT") return null;
    [base, quote] = parts;
  } else return null;
  if (!base || !quote || !PART.test(base) || !PART.test(quote)) return null;
  const sym = base + quote;
  return SAFE.test(sym) ? sym : null;
}

/** App symbol → native venue id: venue metadata first, then the longest known quote suffix. */
export function venueIdOf(source: string, symbol: string): string | null {
  const s = String(symbol ?? "").toUpperCase();
  if (!SAFE.test(s)) return null;
  let base = "";
  let quote = "";
  const meta = knownPairs(source)?.get(s);
  if (meta) ({ base, quote } = meta);
  else {
    const quotes = [...(VENUE_QUOTES[source] ?? [])].sort((a, b) => b.length - a.length);
    const q = quotes.find((c) => s.length > c.length && s.endsWith(c));
    if (!q) return null;
    base = s.slice(0, -q.length);
    quote = q;
  }
  if (!base || !quote) return null;
  switch (source) {
    case "upbit": return `${quote}-${base}`;
    case "coinbase":
    case "okx": return `${base}-${quote}`;
    case "okx-perp": return quote === "USDT" ? `${base}-${quote}-SWAP` : null;
    default: return null;
  }
}
