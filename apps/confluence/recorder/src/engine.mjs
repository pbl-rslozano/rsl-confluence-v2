/**
 * engine.mjs — the ONLY place the recorder touches the web engine.
 *
 * Everything that decides a score, a ledger row, a bar boundary or an asset
 * class is imported from apps/confluence/web/src/lib unchanged, so a row the
 * recorder writes is the row the app would write for the same closed bars
 * (same configId, same fixed ENGINE_BARS window, same catch-up code path).
 * Requires `--experimental-strip-types --import ./ts-resolve.mjs`.
 */
import "./env.mjs"; // must stay first: sets NEXT_PUBLIC_BUILD_TARGET before market-client.ts evaluates

export {
  fetchMarketData,
  loadInstrumentTypes,
  venueTypeOf,
  rateLimitCooldown,
  resetRateLimitForTests,
  RateLimitError,
  INTERVAL_MS,
  DATA_SOURCES,
  barCloseTime,
  contiguousTail,
  usesDirectFetch,
} from "../../web/src/lib/market-client.ts";
export { scoreSeries, toLedgerRow } from "../../web/src/lib/scan-pipeline.ts";
export { runScanJobSafe, packKlines } from "../../web/src/lib/scan-jobs.ts";
export { engineConfigId, ENGINE_VERSION, ENGINE_BARS } from "../../web/src/lib/engine-config.ts";
export { classifySymbol, inClass, barWhileClosed, ASSET_CLASS_FILTERS } from "../../web/src/lib/asset-classes.ts";
export { mergeKlines } from "../../web/src/lib/history-store.ts";
export { enrich, percentiles, ret20 } from "../../web/src/lib/enrichment.ts";
export { liveRow, catchUpContext, enrichCatchUp, applyFundTrend, scanShared } from "../../web/src/lib/scan-record.ts";
export { BUILD_INFO } from "../../web/src/lib/build-info.ts";
export { normalizeScoringProfile } from "../../web/src/lib/scoring-profile.ts";
// v2.8 (WP19): the Pattern output and the derivative context recorded on each row.
export { detectHistoricalPattern } from "../../web/src/lib/pattern-signal.ts";
export { derivativeFields, parseDerivativeSnapshots, DERIV_MAX_AGE_MS } from "../../web/src/lib/derivatives-context.ts";
// v2.8 (WP21): the Fund trend benchmark and its daily-bar feed (in Node the feed's marker and cache are in memory).
export { fundTrend } from "../../web/src/lib/fund-trend.ts";
export { loadFundTrends, cachedDailyBars, resetFundTrendFeedForTests } from "../../web/src/lib/fund-trend-feed.ts";
// v2.8 (WP25): the market-radar runner and the context joined onto each row (rad).
export { fetchBreakAwayCloses, realDeps as realRadarFeedDeps } from "../../web/src/lib/radar/breakaway-feed.ts";
export { fetchDailyVolumesDetailed } from "../../web/src/lib/radar/breakaway-feed.ts";
export { createRadarRunner, realFetchers as realRadarFetchers, toRadarContext, radarFields, normalizeContext as normalizeRadarContext, RADAR_INTERVAL_MS } from "../../web/src/lib/radar/snapshot.ts";
export { DEFAULT_THRESHOLDS as DEFAULT_RADAR_THRESHOLDS } from "../../web/src/lib/radar/alerts.ts";
// v2.8 Step 4b (WP25 part 2): the liquidation websockets (continuous mode only); the recorder gives them a guarded constructor.
export { createLiquidationFeed } from "../../web/src/lib/radar/liquidation-feed.ts";
export { LIQ_BASELINE_HOURS, LIQ_HOUR_MS } from "../../web/src/lib/radar/liquidations.ts";
