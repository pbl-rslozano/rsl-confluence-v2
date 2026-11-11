/**
 * GET /api/market/all?interval=15m&source=binance&assets=BTC,ETH&limit=200
 * ----------------------------------------------------------------------------
 * Server proxy for the normalized multi-source market layer.
 *
 * Build 1.9: the TTL cache is actually wired up. Prior builds shipped a
 * complete, correct `TtlCache` that nothing imported, while the README promised
 * 20s/45s caching — so every client refresh re-issued the full scan upstream,
 * with no deduplication between browser tabs or devices. At 200 assets on a 30s
 * cadence that is roughly 960 Binance request-weight per minute per tab, which
 * is how you collect an HTTP 418 IP ban during exactly the volatility you
 * opened the dashboard to watch.
 *
 * `getOrSet` also collapses concurrent callers onto one upstream fetch, which
 * is the half that matters when a phone PWA and a desktop tab refresh together.
 * ----------------------------------------------------------------------------
 */
import { ASSET_CLASS_FILTERS, type AssetClassFilter } from "@/lib/asset-classes";
import { NextResponse } from "next/server";
import { TtlCache } from "@/lib/cache";
import { guardRoute } from "@/lib/route-guard";
import {
  DATA_SOURCES,
  INTERVAL_MS,
  fetchDirectMarketData,
  type AllResponse,
  type DataSource,
} from "@/lib/market-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

const SOURCE_VALUES = new Set<string>(DATA_SOURCES.map((s) => s.value));

const marketCache = new TtlCache<AllResponse>(45_000);

/**
 * Cache for a fraction of the bar length, capped at 5 minutes. Never longer
 * than the bar itself, or a closed bar would be served as current after the
 * next one opens.
 */
function cacheTtlForInterval(interval: string): number {
  const barMs = INTERVAL_MS[interval] ?? INTERVAL_MS["15m"];
  return Math.min(Math.max(Math.floor(barMs * 0.25), 15_000), 5 * 60_000);
}

/** Explicit asset lists are capped so a caller cannot mint unbounded cache keys. */
const MAX_EXPLICIT_ASSETS = 50;
const ASSET_RE = /^[A-Z0-9]{1,20}$/;

export async function GET(request: Request) {
  // Build 2.02: same-origin + rate limit (a full scan is up to ~200 upstream calls).
  const blocked = guardRoute(request, "all", 12);
  if (blocked) return blocked;
  const { searchParams } = new URL(request.url);
  const interval = searchParams.get("interval") ?? "15m";
  const sourceParam = searchParams.get("source") ?? "binance";
  const source = SOURCE_VALUES.has(sourceParam) ? (sourceParam as DataSource) : "binance";
  const assets = [...new Set(
    (searchParams.get("assets") ?? "")
      .split(",")
      .map((a) => a.trim().toUpperCase().replace(/[-_/\s]?(USDT|USD)$/i, ""))
      .filter((a) => ASSET_RE.test(a)),
  )].sort(); // stable cache key regardless of input order
  if (assets.length > MAX_EXPLICIT_ASSETS) {
    return NextResponse.json({ error: `At most ${MAX_EXPLICIT_ASSETS} explicit assets per request.` }, { status: 400 });
  }
  if (!INTERVAL_MS[interval]) {
    return NextResponse.json({ error: "Invalid interval." }, { status: 400 });
  }
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") ?? "200", 10) || 200, 1), 200);

  // v2.2: asset-class filter, validated against the known set.
  const classParam = searchParams.get("assetClass") ?? "crypto";
  const assetClass = (ASSET_CLASS_FILTERS as string[]).includes(classParam) ? (classParam as AssetClassFilter) : "crypto";

  const key = `${source}|${interval}|${limit}|${assetClass}|${assets.join(",")}`;

  try {
    const data = await marketCache.getOrSet(
      key,
      // The server answers from a shared cache, so it always fetches the full
      // engine window (1,000 bars): no warm-up bias for any client.
      () => fetchDirectMarketData(interval, source, assets, limit, undefined, () => 1000, assetClass),
      cacheTtlForInterval(interval),
    );
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 502 },
    );
  }
}
