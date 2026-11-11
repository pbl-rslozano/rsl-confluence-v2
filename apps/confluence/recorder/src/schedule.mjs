/**
 * schedule.mjs — when to wake next.
 *
 * Default: shortly after the NEXT bar close, derived from the newest closed
 * bar the venue returned (so weekly bars that open on Monday and calendar
 * months come out right without special cases), plus a grace period for
 * exchange publish latency and local clock skew. The engine drops a bar whose
 * close time is in the future by the LOCAL clock, so waking a little late is
 * what keeps an in-progress candle from being scored when this PC's clock runs
 * fast.
 */
import { barCloseTime, INTERVAL_MS } from "./engine.mjs";

const WEEK = 7 * 86_400_000;
const MONDAY_OFFSET = 4 * 86_400_000; // 1970-01-01 was a Thursday; Monday 1970-01-05 = 4 days in

/** Close time of the bar in progress at `now`, without any market data. */
export function epochNextClose(tf, now) {
  const iv = INTERVAL_MS[tf];
  if (tf === "1M") {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  if (tf === "1w") return Math.floor((now - MONDAY_OFFSET) / WEEK) * WEEK + MONDAY_OFFSET + WEEK;
  return Math.floor(now / iv) * iv + iv;
}

/**
 * @param {{ now: number, tf: string, newestBarOpen?: number, intervalSeconds?: number, graceMs?: number }} p
 */
export function nextRegularWake({ now, tf, newestBarOpen = 0, intervalSeconds = 0, graceMs = 20_000 }) {
  if (intervalSeconds > 0) return now + intervalSeconds * 1000;
  const iv = INTERVAL_MS[tf];
  let close;
  if (newestBarOpen > 0) {
    // newest closed bar → the bar in progress → its close.
    const openNow = barCloseTime(newestBarOpen, iv);
    close = barCloseTime(openNow, iv);
    for (let guard = 0; close + graceMs <= now && guard < 10_000; guard++) close = barCloseTime(close, iv);
  } else {
    close = epochNextClose(tf, now);
  }
  return close + graceMs;
}

/**
 * Wake time after a cycle. Failures retry with backoff (30 s, 1 min, 2 min …
 * ≤ 15 min) but never later than the regular wake; a rate-limit cooldown is
 * always honoured.
 */
export function nextWake({ now, tf, newestBarOpen, intervalSeconds, graceMs, ok, consecutiveFailures, cooldownUntil = 0 }) {
  let at = nextRegularWake({ now, tf, newestBarOpen, intervalSeconds, graceMs });
  if (!ok) at = Math.min(at, now + Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, consecutiveFailures - 1)));
  if (cooldownUntil > now) at = Math.max(at, cooldownUntil + 1_000);
  return at;
}

/** Nominal cycle period, used for the heartbeat's staleness threshold. */
export function cyclePeriodMs(tf, intervalSeconds = 0) {
  return intervalSeconds > 0 ? intervalSeconds * 1000 : INTERVAL_MS[tf];
}

/** Heartbeat counts as dead after three missed cycles plus 10 minutes of slack. */
export const staleAfterMs = (tf, intervalSeconds = 0) => 3 * cyclePeriodMs(tf, intervalSeconds) + 10 * 60_000;
