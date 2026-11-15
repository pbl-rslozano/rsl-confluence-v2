/**
 * source-health.ts — v2.6 user safeguard US-1 (plan WP10.1).
 *
 * One plain state per data source after each scan. The web version cannot
 * tell a CORS refusal, a DNS block and a header-less 429 apart (the browser
 * reports all three as the same opaque TypeError), so there it says
 * "blocked or unreachable"; native shells see real status codes and say
 * "rate-limited" or "network blocked". It never guesses the user's country.
 */
import { CoinsphError } from "./coinsph";
import { RateLimitError } from "./market-client";

export type SourceHealthState = "ok" | "slow" | "rate-limited" | "blocked" | "network-blocked" | "stale";

export interface SourceHealth {
  state: SourceHealthState;
  /** Epoch ms when a rate-limited source may be scanned again. */
  until?: number;
}

/**
 * A scan slower than this is "slow" (Coins.ph is paced deliberately, so it gets more room; v2.8 WP26: OKX pages
 * a 1,000-bar warm start in 4 requests per series at 4 series at a time, so it gets 60 s).
 */
export function slowAfterMs(source: string): number {
  return source === "coinsph" ? 90_000 : source === "okx" || source === "okx-perp" ? 60_000 : 20_000;
}

export function healthFromScan(
  source: string,
  res: { durationMs: number; rateLimitedUntil?: number; staleCount: number; tickers: unknown[] },
  now = Date.now(),
): SourceHealth {
  if (res.rateLimitedUntil && res.rateLimitedUntil > now) return { state: "rate-limited", until: res.rateLimitedUntil };
  if (res.tickers.length > 0 && res.staleCount >= res.tickers.length) return { state: "stale" };
  if (res.durationMs > slowAfterMs(source)) return { state: "slow" };
  return { state: "ok" };
}

export function healthFromError(err: unknown, native: boolean, now = Date.now()): SourceHealth | null {
  if (err instanceof DOMException && err.name === "AbortError") return null;
  if (err instanceof RateLimitError) return { state: "rate-limited", until: now + err.retryAfterMs };
  if (err instanceof CoinsphError) {
    if (err.kind === "RATE_LIMIT") return { state: "rate-limited", until: now + err.retryAfterMs };
    if (err.kind === "BLOCKED") return { state: "blocked" };
    if (err.kind === "NETWORK_BLOCKED") return { state: "network-blocked" };
    return null;
  }
  // fetch() rejects with a TypeError for network-level failures.
  if (err instanceof TypeError) return { state: native ? "network-blocked" : "blocked" };
  return null;
}
