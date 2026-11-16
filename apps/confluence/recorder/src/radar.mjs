/**
 * radar.mjs — v2.8 (WP25, Task 7): the market-radar context log for the recorder (`--radar on`).
 *
 * Logged-but-unscored context, like derivs.mjs: nothing here feeds a score. It runs the app's own radar runner
 * (web/src/lib/radar/snapshot.ts, via engine.mjs) in Node with `allowed: () => true`, refreshes it when the recorder
 * asks (the derivs pre-close wake and each cycle; the runner's own 5-minute timer is never started), and appends one
 * trimmed context per refresh (BTC values: funding percentile, OI change, long/short, taker share, regional premiums,
 * alert codes) to <out>/radar/YYYY-MM.jsonl. The same entries are kept in memory and passed to the row assembly
 * (recordCtx.radar), so each row gets `rad` = the newest entry at or before its own bar close, at most 2 h old.
 *
 * Egress: the radar fetchers use the global `fetch`. Every refresh therefore runs with the recorder's guarded fetch
 * installed as the global one (installGlobalFetch(guard), restored afterwards), so only https hosts of the recorder
 * manifest (tools/egress-manifest.json) are reachable: fapi.binance.com, publicreporting.cftc.gov, stablecoins.llama.fi,
 * api.exchange.coinbase.com, api.upbit.com (Node reaches it directly through relayGet's "direct" transport) and
 * api.pro.coins.ph. Anything else is refused before a socket is opened (EgressBlockedError) and counts as that
 * section's failure.
 *
 * With `--radar off` (the default) this module is never created: no radar request is made.
 * The stablecoin readings (depeg alerts) come from a scan, which the recorder does not keep: no DEPEG_* codes here.
 */
import { join } from "node:path";
import { createRadarRunner, DEFAULT_RADAR_THRESHOLDS, fetchBreakAwayCloses, fetchDailyVolumesDetailed, normalizeRadarContext, realRadarFeedDeps, realRadarFetchers, toRadarContext } from "./engine.mjs";
import { installGlobalFetch } from "./net.mjs";
import { readJson, writeJsonAtomic } from "./store.mjs";

/** Entries kept in memory (and read back from the log at start-up): catch-up rows after a gap need older ones. */
export const RADAR_KEEP_MS = 14 * 86_400_000;
const CACHE_ID = "radar-cache";
const DAY_MS = 86_400_000;
const DAILY_KEEP_BARS = 400;
const isBar = (b) => b && [b.time, b.open, b.high, b.low, b.close, b.volume].every((v) => typeof v === "number" && Number.isFinite(v));

/**
 * The radar's daily inputs (the 30-day standing premiums and the daily volumes) are closed daily bars per series, read through
 * `deps.daily`. This wraps it with <out>/radar/daily.json: bars fetched on the current UTC day are reused by later runs, so a
 * scheduler's `--once` runs do not refetch ~30 requests each time (daily inputs: once per UTC day). Anything unreadable is a miss.
 */
export function persistDailyDeps(outDir, base = realRadarFeedDeps, now = Date.now) {
  const path = join(outDir, "radar", "daily.json");
  let doc = null;
  const load = () => {
    if (doc) return doc;
    const raw = readJson(path, null);
    doc = raw && raw.schema === 1 && raw.series && typeof raw.series === "object" ? raw : { schema: 1, series: {} };
    return doc;
  };
  return {
    ...base,
    daily: async (source, symbol, at, signal) => {
      const key = `${source}|${symbol}`;
      const day = Math.floor(now() / DAY_MS);
      const hit = load().series[key];
      if (hit && hit.day === day && Array.isArray(hit.bars) && hit.bars.length && hit.bars.every(isBar)) return hit.bars;
      const bars = await base.daily(source, symbol, at, signal);
      if (Array.isArray(bars) && bars.length && bars.every(isBar)) {
        load().series[key] = { day, bars: bars.slice(-DAILY_KEEP_BARS).map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })) };
        try { writeJsonAtomic(path, doc); } catch { /* the cache is best effort */ }
      }
      return bars;
    },
  };
}

/**
 * @param {{ guard: { fetch: typeof fetch }, outDir: string, appendJsonl: (path: string, records: object[]) => number, monthOf: (ms: number) => string,
 *   seed?: string, fetchers?: object, now?: () => number }} deps  `seed` = JSONL text of the recent logs.
 */
export function createRadarRecorder({ guard, outDir, appendJsonl, monthOf, seed = "", fetchers, now = Date.now }) {
  if (!fetchers) {
    const deps = persistDailyDeps(outDir, realRadarFeedDeps, now);
    fetchers = { ...realRadarFetchers, breakAway: (signal) => fetchBreakAwayCloses(signal, deps), dailyVolumes: (signal) => fetchDailyVolumesDetailed(signal, deps) };
  }
  // The runner's per-device store, in Node: only its slow-input cache (CFTC, stablecoin supply) is kept on disk, so a
  // scheduler's `--once` runs do not refetch it every time; the runner's own context log stays in memory (ours is the JSONL).
  const mem = new Map();
  const cachePath = join(outDir, "radar", "cache.json");
  const store = {
    async get(col, id) {
      const key = `${col}/${id}`;
      if (mem.has(key)) return mem.get(key);
      return id === CACHE_ID ? readJson(cachePath, null) : null;
    },
    async put(col, id, doc) {
      const copy = JSON.parse(JSON.stringify(doc));
      mem.set(`${col}/${id}`, copy);
      if (id === CACHE_ID) writeJsonAtomic(cachePath, copy);
    },
  };
  const runner = createRadarRunner({ now, fetchers, store, thresholds: () => DEFAULT_RADAR_THRESHOLDS, depeg: () => [], allowed: () => true });

  let history = [];
  for (const line of seed.split("\n")) {
    if (!line.trim()) continue;
    try {
      const c = normalizeRadarContext(JSON.parse(line));
      if (c && c.t >= now() - RADAR_KEEP_MS) history.push(c);
    } catch { /* an unreadable line is skipped */ }
  }
  history.sort((a, b) => a.t - b.t);

  return {
    /** The logged contexts, oldest first (what recordCtx.radar carries). */
    entries: () => history,
    /**
     * One refresh, with the egress guard installed as the global fetch for its duration. Returns the logged context
     * and the sections that had no value; rejects only on a stop or a non-fetch error (the caller never fails a cycle on it).
     */
    async refresh(signal) {
      const restore = installGlobalFetch(guard);
      try {
        const snap = await runner.refresh(signal);
        const ctx = toRadarContext(snap);
        history = [...history.filter((e) => e.t >= ctx.t - RADAR_KEEP_MS && e.t !== ctx.t), ctx].sort((a, b) => a.t - b.t);
        appendJsonl(join(outDir, "radar", `${monthOf(ctx.t)}.jsonl`), [ctx]);
        return { ctx, unavailable: snap.unavailable };
      } finally {
        restore();
      }
    },
  };
}
