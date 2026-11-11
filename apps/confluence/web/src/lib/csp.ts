/**
 * csp.ts — single source of truth for the Content-Security-Policy.
 *
 * Imported by next.config.ts (to emit a real HTTP header on server builds) and
 * by layout.tsx (to emit a <meta> fallback on static exports, which have no
 * server to set headers). Keeping one definition prevents the two from drifting
 * apart, which is how the prior build ended up with a production policy nobody
 * had reviewed.
 */
import { CSP_HOSTS } from "./public-hosts";

/**
 * The app itself plus every host in the public-host table (src/lib/public-hosts.ts, v2.7):
 * the loopback credential gateway, the market-data hosts, the update file and the
 * display-currency rate hosts. One table, so the web CSP, the desktop CSP and R8 agree.
 */
export const CONNECT_SRC = ["'self'", ...CSP_HOSTS.map((h) => h.origin)].join(" ");

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
