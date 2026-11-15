/**
 * GET /api/market/history?source=binance&interval=1h&symbol=BTCUSDT&limit=5000&endTime=…
 * ----------------------------------------------------------------------------
 * Server-side backfill for server deploys. Build 2.02:
 *   - The paging logic lives in `fetchHistory` (market-client.ts) and is shared
 *     with static/native builds, which call the exchanges directly.
 *   - Requests are same-origin only and rate limited (route-guard.ts).
 *   - `limit` is capped at MAX_HISTORY_BARS (5,000), down from 10,000 × group.
 * ----------------------------------------------------------------------------
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchHistory, INTERVAL_MS, MAX_HISTORY_BARS, type DataSource } from "@/lib/market-client";
import { guardRoute } from "@/lib/route-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const VALID_SOURCES = new Set<DataSource>(["binance", "bybit-spot", "bybit-perp", "bitget", "bitget-perp", "coinsph", "okx", "okx-perp"]);
const VALID_INTERVALS = new Set(Object.keys(INTERVAL_MS));

export async function GET(request: NextRequest) {
  const blocked = guardRoute(request, "history", 6);
  if (blocked) return blocked;

  const source = (request.nextUrl.searchParams.get("source") ?? "binance") as DataSource;
  const interval = request.nextUrl.searchParams.get("interval") ?? "15m";
  const symbol = (request.nextUrl.searchParams.get("symbol") ?? "").toUpperCase();
  const requested = Number(request.nextUrl.searchParams.get("limit") ?? MAX_HISTORY_BARS);
  const endTime = Number(request.nextUrl.searchParams.get("endTime") ?? Date.now());
  if (!VALID_SOURCES.has(source) || !VALID_INTERVALS.has(interval) || !/^[A-Z0-9]{3,20}$/.test(symbol)) {
    return NextResponse.json({ error: "Invalid history request." }, { status: 400 });
  }
  const limit = Number.isFinite(requested) ? requested : MAX_HISTORY_BARS;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55_000);
  try {
    const { klines, complete } = await fetchHistory(
      source,
      symbol,
      interval,
      limit,
      Number.isFinite(endTime) ? endTime : Date.now(),
      controller.signal,
    );
    return NextResponse.json({
      source,
      interval,
      symbol,
      klines,
      oldestTime: klines[0]?.time ?? 0,
      newestTime: klines.at(-1)?.time ?? 0,
      complete,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "History fetch failed." },
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
