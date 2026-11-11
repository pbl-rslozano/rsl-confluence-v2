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
 * Native HTTP is not subject to the CSP, so THIS table is the allowlist for it:
 * the adapters refuse any URL it does not allow, and R16 fails the release if the
 * rewrite rules, the launcher proxy, the Tauri scope or the egress manifest
 * disagree with it. Read paths only — Coins.ph serves its private (account,
 * order, wallet) endpoints on the same host, so the HOST is never allowed whole.
 */

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

export interface NativeHostRule {
  origin: string;
  paths: readonly string[];
  purpose: string;
}

/** Every host the app reaches outside the CSP. One entry per host. */
export const NATIVE_HOSTS: readonly NativeHostRule[] = [
  { origin: COINSPH_ORIGIN, paths: COINSPH_READ_PATHS, purpose: "Coins.ph public market data (ADR-0013)" },
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
