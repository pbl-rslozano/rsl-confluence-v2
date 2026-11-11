/**
 * route-guard.ts — minimal abuse protection for the server-side market routes.
 *
 * Build 2.02. On a server deploy (Netlify / standalone) the /api/market/* routes
 * call the exchanges on the server's IP. Without a guard they were open
 * amplification proxies: anyone could vary `assets` to bypass the cache and
 * make every request cost ~200 upstream calls, or ask for 10,000-bar backfills.
 * That spends function time and gets the server IP banned by Binance (HTTP 418)
 * — at which point the dashboard itself stops working.
 *
 * Two layers, both cheap:
 *   1. Browser same-origin check (Sec-Fetch-Site / Origin vs Host). Stops other
 *      websites from using the routes through visitors' browsers.
 *   2. A per-client fixed-window rate limit. Stops scripted callers, which can
 *      forge headers but cannot exceed the budget.
 *
 * Limits are per server instance (in-memory). That is deliberate: the goal is
 * to bound upstream cost per instance, not to build a distributed limiter.
 */
import { NextResponse } from "next/server";

interface Window {
  start: number;
  count: number;
}

const windows = new Map<string, Window>();
const MAX_TRACKED_CLIENTS = 5_000;

function clientId(request: Request): string {
  const h = request.headers;
  return (
    h.get("x-nf-client-connection-ip") ||
    h.get("x-real-ip") ||
    (h.get("x-forwarded-for") ?? "").split(",")[0].trim() ||
    "local"
  );
}

function sameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = request.headers.get("origin");
  if (!origin) return true; // non-browser caller: handled by the rate limit
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

/**
 * Returns a response to send instead of handling the request, or null when the
 * request may proceed.
 */
export function guardRoute(request: Request, bucket: string, maxPerMinute: number): NextResponse | null {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  }
  const now = Date.now();
  const key = `${bucket}:${clientId(request)}`;
  const w = windows.get(key);
  if (!w || now - w.start > 60_000) {
    if (windows.size >= MAX_TRACKED_CLIENTS) {
      for (const [k, v] of windows) if (now - v.start > 60_000) windows.delete(k);
      if (windows.size >= MAX_TRACKED_CLIENTS) windows.clear();
    }
    windows.set(key, { start: now, count: 1 });
    return null;
  }
  w.count += 1;
  if (w.count > maxPerMinute) {
    const retry = Math.max(1, Math.ceil((60_000 - (now - w.start)) / 1000));
    return NextResponse.json(
      { error: `Rate limit exceeded. Retry in ${retry}s.` },
      { status: 429, headers: { "Retry-After": String(retry) } },
    );
  }
  return null;
}
