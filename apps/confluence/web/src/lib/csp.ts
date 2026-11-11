/**
 * csp.ts — single source of truth for the Content-Security-Policy.
 *
 * Imported by next.config.ts (to emit a real HTTP header on server builds) and
 * by layout.tsx (to emit a <meta> fallback on static exports, which have no
 * server to set headers). Keeping one definition prevents the two from drifting
 * apart, which is how the prior build ended up with a production policy nobody
 * had reviewed.
 */

/** The app itself, the loopback credential gateway, and the market-data hosts. */
export const CONNECT_SRC = [
  "'self'",
  "http://127.0.0.1:8787",
  "http://localhost:8787",
  "https://data-api.binance.vision",
  "https://api.bybit.com",
  "https://api.bitget.com",
  // v2.5.1 (ADR-0012): update notice — GET /updates/latest.json only, from the native shells.
  "https://effervescent-bubblegum-1e5c03.netlify.app",
].join(" ");

/**
 * `'unsafe-eval'` is required by the Next.js dev-server HMR pipeline only and is
 * dropped from every production build. Prior releases shipped it to production
 * alongside `'unsafe-inline'`, which left the policy close to decorative.
 */
export function buildCsp(dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    `connect-src ${CONNECT_SRC}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}
