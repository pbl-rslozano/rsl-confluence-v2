/**
 * public-hosts.ts — v2.6 (ADR-0003 amendment v2.6, ADR-0013, release check R16).
 *
 * The browser CSP (`csp.ts` → `connect-src`) polices every request the WebView
 * makes with `fetch`. Coins.ph refuses cross-origin browser requests (no
 * `Access-Control-Allow-Origin`; probe PH-1, docs/research/evidence/
 * coinsph-probe-2026-11-07.json), so it is reached OUTSIDE the CSP:
 *
 *   - web / PWA: a same-origin rewrite, `/x/coinsph/...` → `https://api.pro.coins.ph/...`
 *     (Netlify `public/_redirects`; the local launcher `tools/pwa-launcher/serve-pwa.mjs`);
 *   - Android / iPhone: `nativeGet()` in @rsl/adapter-capacitor (explicit CapacitorHttp.request);
 *   - desktop: `nativeGet()` in @rsl/adapter-tauri (@tauri-apps/plugin-http, path-scoped capability);
 *   - Node (replay CLI, server route, recorder): plain fetch, listed in tools/egress-manifest.json.
 *
 * v2.8 (WP26): Upbit is reached the same way (`/x/upbit/...`, `native-relay.ts`).
 *
 * Native HTTP is not subject to the CSP, so THIS table is the allowlist for it:
 * the adapters refuse any URL it does not allow, and R16 fails the release if the
 * rewrite rules, the launcher proxy, the Tauri scope or the egress manifest
 * disagree with it. Read paths only — Coins.ph serves its private (account,
 * order, wallet) endpoints on the same host, so the HOST is never allowed whole.
 */

/**
 * v2.7 (review #7, ADR-0003 amendment v2.7): every host the WebView may `fetch` directly.
 * `csp.ts` builds `connect-src` from this table, release check R8 reads it (and checks that the
 * desktop CSP lists exactly these hosts), and each origin must be named in ADR-0003.
 * String literals only — the release checks parse this block statically.
 */
export const CSP_HOSTS = [
  { origin: "http://127.0.0.1:8787", purpose: "local read-only API gateway (desktop)" },
  { origin: "http://localhost:8787", purpose: "local read-only API gateway (desktop)" },
  { origin: "https://data-api.binance.vision", purpose: "Binance public market data" },
  { origin: "https://api.bybit.com", purpose: "Bybit public market data" },
  { origin: "https://api.bitget.com", purpose: "Bitget public market data" },
  { origin: "https://effervescent-bubblegum-1e5c03.netlify.app", purpose: "update notice: GET /updates/latest.json (ADR-0012)" },
  { origin: "https://api.frankfurter.dev", purpose: "display-currency rates, central-bank blend (ADR-0015)" },
  { origin: "https://cdn.jsdelivr.net", purpose: "display-currency rates fallback, fawazahmed0 (ADR-0015)" },
  { origin: "https://latest.currency-api.pages.dev", purpose: "display-currency rates fallback mirror (ADR-0015)" },
  { origin: "https://data-api.ecb.europa.eu", purpose: "display-currency rates, ECB reference rates — user-selectable (ADR-0015)" },
  { origin: "https://open.er-api.com", purpose: "display-currency rates, ExchangeRate-API open access — user-selectable (ADR-0015)" },
  { origin: "https://www.floatrates.com", purpose: "display-currency rates, FloatRates — user-selectable (ADR-0015)" },
  { origin: "https://www.okx.com", purpose: "OKX public market data, spot and perpetual (ADR-0003 v2.8, WP26)" },
  { origin: "https://api.exchange.coinbase.com", purpose: "Coinbase Exchange public market data (ADR-0003 v2.8, WP26)" },
  { origin: "https://fapi.binance.com", purpose: "Binance USD-M futures public market data, REST only, market radar (ADR-0003 v2.8, WP25)" },
  { origin: "https://publicreporting.cftc.gov", purpose: "CFTC Commitments of Traders, public reporting (ADR-0003 v2.8, WP25)" },
  { origin: "https://stablecoins.llama.fi", purpose: "DefiLlama stablecoin supply, public (ADR-0003 v2.8, WP25)" },
  { origin: "https://api.alternative.me", purpose: "Crypto Fear & Greed Index, GET /fng/ (ADR-0003 v2.8, WP29)" },
  { origin: "wss://fstream.binance.com", purpose: "Binance USD-M liquidation stream, market radar (ADR-0003 v2.8, WP25)" },
  { origin: "wss://stream.bybit.com", purpose: "Bybit public liquidation stream, market radar (ADR-0003 v2.8, WP25)" },
] as const;

export const COINSPH_ORIGIN = "https://api.pro.coins.ph";

/** Same-origin prefix of the rewrite on the web (Netlify and the local launcher). */
export const COINSPH_PROXY_PREFIX = "/x/coinsph";

/**
 * Allowed request paths. An entry ending in "/" is a prefix; any other entry
 * must match exactly. The query string is not part of the match.
 */
export const COINSPH_READ_PATHS: readonly string[] = [
  "/openapi/v1/time",
  "/openapi/v1/exchangeInfo",
  "/openapi/quote/v1/",
];

/**
 * v2.8 (WP26, ADR-0003 amendment v2.8). Upbit's CORS is unreliable (probe EX-PROBE-1,
 * docs/research/evidence/wp26-venues-probe-2026-11-15.json: the same paths were answered and
 * refused within one minute), so it is reached like Coins.ph, through `native-relay.ts`.
 * Upbit serves its private account, order, deposit and withdrawal endpoints on this host:
 * only the public quotation paths below are ever allowed.
 */
export const UPBIT_ORIGIN = "https://api.upbit.com";

/** Same-origin prefix of the Upbit rewrite on the web (Netlify and the local launcher). */
export const UPBIT_PROXY_PREFIX = "/x/upbit";

/** Upbit public quotation read paths (same matching rules as COINSPH_READ_PATHS). */
export const UPBIT_READ_PATHS: readonly string[] = ["/v1/market/all", "/v1/ticker/all", "/v1/ticker", "/v1/orderbook", "/v1/candles/"];

export interface NativeHostRule {
  origin: string;
  paths: readonly string[];
  purpose: string;
}

/**
 * Every host the app reaches outside the CSP. One entry per host. Each entry names its
 * constants as `<NAME>_ORIGIN` / `<NAME>_READ_PATHS`, with a matching `<NAME>_PROXY_PREFIX`:
 * release check R16 parses them statically and checks every entry.
 */
export const NATIVE_HOSTS: readonly NativeHostRule[] = [
  { origin: COINSPH_ORIGIN, paths: COINSPH_READ_PATHS, purpose: "Coins.ph public market data (ADR-0013)" },
  { origin: UPBIT_ORIGIN, paths: UPBIT_READ_PATHS, purpose: "Upbit public market data (ADR-0003 v2.8, WP26)" },
];

/** True when `path` (no query) is allowed by `paths`. Rejects traversal and encoded slashes. */
export function pathAllowed(path: string, paths: readonly string[]): boolean {
  if (!path.startsWith("/") || path.includes("..") || /%2f|%5c|\\/i.test(path)) return false;
  return paths.some((p) => (p.endsWith("/") ? path.startsWith(p) && path.length > p.length : path === p));
}

/** True when an absolute URL is on the native allowlist (https, exact origin, allowed path). */
export function isAllowedNativeUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.hash) return false;
  const rule = NATIVE_HOSTS.find((r) => r.origin === u.origin);
  return !!rule && pathAllowed(u.pathname, rule.paths);
}
