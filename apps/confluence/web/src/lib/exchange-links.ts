/**
 * exchange-links.ts — v2.8 Step 2 (plan WP26): the "View on [exchange]" link at the end of the detail sheet.
 *
 * A plain https link on the venue's own web host, opened by the browser (target=_blank rel=noopener noreferrer);
 * it is never fetched, so it adds no network host. No referral, invite, affiliate or tracking parameters, ever
 * (the one query string is Upbit's own `code=CRIX.UPBIT.…` instrument id, and Binance's `type=spot`).
 * Each URL pattern is "[pattern not verified — owner click-check]" (ADR-0018). Pure.
 */
import type { DataSource } from "./market-client";
import { splitPair } from "./quotes";
import { venueIdOf } from "./venue-ids";

const SAFE = /^[A-Z0-9]{2,30}$/;

/** The pair's page on the venue's own site, or null when this app cannot build it with confidence. */
export function exchangeUrl(source: DataSource | string, symbol: string): string | null {
  const s = String(symbol ?? "").toUpperCase();
  if (!SAFE.test(s)) return null;
  const { base, quote } = splitPair(s, source);
  switch (source) {
    case "binance":
      return base && quote ? `https://www.binance.com/en/trade/${base}_${quote}?type=spot` : null;
    case "bybit-spot":
      return base && quote ? `https://www.bybit.com/en/trade/spot/${base}/${quote}` : null;
    // Perpetual pages are USDT-margined only; a USDC perpetual (BTCPERP) has no pattern here.
    case "bybit-perp":
      return base && quote === "USDT" ? `https://www.bybit.com/trade/usdt/${s}` : null;
    case "bitget":
      return base && quote ? `https://www.bitget.com/spot/${s}` : null;
    case "bitget-perp":
      return base && quote === "USDT" ? `https://www.bitget.com/futures/usdt/${s}` : null;
    case "coinsph":
      return base && quote ? `https://pro.coins.ph/trade/${base}-${quote}` : null;
    case "okx": {
      const id = venueIdOf("okx", s);
      return id ? `https://www.okx.com/trade-spot/${id.toLowerCase()}` : null;
    }
    case "okx-perp": {
      const id = venueIdOf("okx-perp", s);
      return id ? `https://www.okx.com/trade-swap/${id.toLowerCase()}` : null;
    }
    case "coinbase": {
      const id = venueIdOf("coinbase", s);
      return id ? `https://www.coinbase.com/advanced-trade/spot/${id}` : null;
    }
    case "upbit": {
      const id = venueIdOf("upbit", s);
      return id ? `https://upbit.com/exchange?code=CRIX.UPBIT.${id}` : null;
    }
    default:
      return null;
  }
}
