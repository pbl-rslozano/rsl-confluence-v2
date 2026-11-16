/**
 * snapshot.ts — v2.8 Step 4a (plan WP25, Task 5): the radar runner. Framework-free (Task 6 wraps it in React).
 *
 * Context, never a vote: nothing here reaches scoring, and no alert blocks or places a trade. The runner makes no
 * network request itself; every request goes through the fetchers it is given (the real ones: realFetchers).
 *
 * Gating: `radarAllowed` is the one rule (panel open or recordRadar on). The caller starts the runner only while it
 * holds, and stops it otherwise; a stopped runner has no timer and makes no request.
 * Cadence while started: an immediate refresh, then every 5 min. Daily inputs (stablecoin supply, daily volumes) are read
 * once per UTC day and kept; CFTC at most once per 12 h (cache doc, so it also survives a reload). A refresh still
 * running when the next tick fires makes that tick a no-op. A failed slow input is retried after RETRY_MS, not every tick.
 * `stop()` aborts every in-flight request and clears the timer; a refresh that was aborted never publishes or logs.
 *
 * A section that fails keeps its last good value, and `stale[section]` is the time that value was good.
 * Sections: positioning, regional, buyer, cot, supply, breakaway. `unavailable` lists the sections with no value at all
 * (also "volume" when the daily volumes could not be had), plus `breakaway:<venue>` for a venue whose hourly bars
 * failed and `standing:<venue>` for a venue left out for fewer than 20 days of standing-premium history.
 *
 * Per-device context log: one doc per UTC day, id `radar-log-YYYY-MM-DD` in the "meta" collection (no schema change), written
 * through the store's serialised queue. A trimmed RadarContext (BTC values) is appended at each refresh. The port has no delete,
 * so docs older than 35 days are blanked (once per UTC day per runner, over days 35-64 back) and are never read.
 */
import type { DepegReading } from "../quotes";
import { breakAway, depegAlerts, sanitizeThresholds, supplyJump, volumeSpike, ALERT_CODE, type AlertCode, type RadarAlert, type RadarThresholds } from "./alerts";
import { fetchFuturesPositioning, type FuturesPositioning } from "./binance-futures";
import { fetchBreakAwayCloses, fetchDailyVolumesDetailed, type BreakAwayCloses, type DailyVolumes } from "./breakaway-feed";
import { fetchCot, type CotAsset, type CotReport } from "./cftc";
import { fetchBuyerPressure, fetchRegionalDemand, type BuyerPressure, type RegionalDemand } from "./regional";
import { fetchStablecoinSupply, type SupplyPoint } from "./stablecoins";
import {
  CFTC_TTL_MS, RADAR_COLLECTION, isFresh, loadRadarCache, saveCotCache, saveSupplyCache, serialised, supplyFreshForDay,
  type RadarCache, type RadarPort,
} from "./store";

export const RADAR_INTERVAL_MS = 5 * 60_000;
/** A failed slow input (CFTC, supply, daily volumes) is not retried sooner than this. */
export const RETRY_MS = 30 * 60_000;
export const LOG_KEEP_DAYS = 35;
export const LOG_MAX_PER_DAY = 600;
export const FIELDS_MAX_AGE_MS = 2 * 3_600_000;
const DAY_MS = 86_400_000;
const PRUNE_DAYS = 30;

export interface RadarSnapshot {
  t: number;
  positioning: Record<"BTCUSDT" | "ETHUSDT", FuturesPositioning | null>;
  regional: RegionalDemand | null;
  buyer: BuyerPressure | null;
  cot: Record<"BTC" | "ETH", CotReport | null>;
  supply: SupplyPoint[] | null;
  alerts: RadarAlert[];
  /** Section → time (ms) its kept value was last good. */
  stale: Record<string, number>;
  unavailable: string[];
}

export interface RadarContext {
  t: number;
  /** Funding-rate 30-day percentile, 0-100. */
  frp: number | null;
  /** Open-interest change over 24 h, %. */
  oi24: number | null;
  /** Global long/short account ratio. */
  ls: number | null;
  /** Taker-buy share of the newest closed 1h bar's volume, 0-1. */
  tk: number | null;
  usP: number | null;
  krP: number | null;
  phP: number | null;
  al: AlertCode[];
}

/** The gate: radar hosts are contacted only while the panel is open or the user switched recording on. */
export function radarAllowed(state: { panelOpen: boolean; recordRadar: boolean }): boolean {
  return !!state && (state.panelOpen === true || state.recordRadar === true);
}

export interface RadarFetchers {
  positioning(symbol: "BTCUSDT" | "ETHUSDT", signal?: AbortSignal): Promise<FuturesPositioning>;
  regional(signal?: AbortSignal): Promise<RegionalDemand>;
  buyer(signal?: AbortSignal): Promise<BuyerPressure>;
  cot(asset: CotAsset, signal?: AbortSignal): Promise<CotReport | null>;
  supply(signal?: AbortSignal): Promise<SupplyPoint[]>;
  breakAway(signal?: AbortSignal): Promise<BreakAwayCloses>;
  dailyVolumes(signal?: AbortSignal): Promise<DailyVolumes>;
}
export const realFetchers: RadarFetchers = {
  positioning: fetchFuturesPositioning,
  regional: fetchRegionalDemand,
  buyer: fetchBuyerPressure,
  cot: fetchCot,
  supply: fetchStablecoinSupply,
  breakAway: (signal) => fetchBreakAwayCloses(signal),
  dailyVolumes: (signal) => fetchDailyVolumesDetailed(signal),
};

export interface RadarTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const realTimers: RadarTimers = { set: (fn, ms) => setInterval(fn, ms), clear: (h) => clearInterval(h as ReturnType<typeof setInterval>) };

export interface RadarRunnerDeps {
  now: () => number;
  fetchers: RadarFetchers;
  store: RadarPort;
  thresholds: () => RadarThresholds;
  /** The scan's current stablecoin readings (no fetch). */
  depeg: () => DepegReading[];
  /** Id of the scan source the readings came from (default binance). */
  depegSource?: () => string;
  /** Test hook: replaces setInterval/clearInterval. */
  timers?: RadarTimers;
}

export interface RadarRunner {
  start(): void;
  stop(): void;
  refresh(signal?: AbortSignal): Promise<RadarSnapshot>;
  latest(): RadarSnapshot | null;
  subscribe(fn: (s: RadarSnapshot) => void): () => void;
}

/* ---------------- context ---------------- */

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The BTC values of a snapshot, trimmed for the ledger. `al` = the current alert codes: unique, sorted, at most 16. */
export function toRadarContext(s: RadarSnapshot): RadarContext {
  const p = s.positioning?.BTCUSDT ?? null;
  const shares = s.buyer?.takerShare ?? [];
  let tk: number | null = null;
  for (let i = shares.length - 1; i >= 0; i--) {
    const v = num(shares[i]);
    if (v !== null) { tk = v; break; }
  }
  const al = [...new Set((s.alerts ?? []).map((a) => a.code).filter((c) => ALERT_CODE.test(c)))].sort().slice(0, 16);
  return {
    t: s.t,
    frp: num(p?.fundingPctl30d),
    oi24: num(p?.oiChg24hPct),
    ls: num(p?.longShortRatio),
    tk,
    usP: num(s.regional?.usPct),
    krP: num(s.regional?.krPct),
    phP: num(s.regional?.phPct),
    al,
  };
}

/** The newest entry with t <= tc and tc - t <= 2 h; otherwise null. Never looks ahead. */
export function radarFields(log: RadarContext[], tc: number): RadarContext | null {
  if (!Array.isArray(log) || !Number.isFinite(tc)) return null;
  let best: RadarContext | null = null;
  for (const e of log) {
    if (!e || !Number.isFinite(e.t) || e.t > tc || tc - e.t > FIELDS_MAX_AGE_MS) continue;
    if (!best || e.t > best.t) best = e;
  }
  return best;
}

/* ---------------- per-device log ---------------- */

const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
export const radarLogId = (t: number) => `radar-log-${dayKey(t)}`;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** One stored entry, re-validated field by field; null when it is not a context. */
export function normalizeContext(raw: unknown): RadarContext | null {
  if (!isObj(raw) || typeof raw.t !== "number" || !Number.isFinite(raw.t) || raw.t <= 0) return null;
  const al = Array.isArray(raw.al) ? [...new Set(raw.al.filter((c): c is string => typeof c === "string" && ALERT_CODE.test(c)))].sort().slice(0, 16) : [];
  return { t: raw.t, frp: num(raw.frp), oi24: num(raw.oi24), ls: num(raw.ls), tk: num(raw.tk), usP: num(raw.usP), krP: num(raw.krP), phP: num(raw.phP), al };
}
function normalizeLogDoc(raw: unknown): RadarContext[] {
  if (!isObj(raw) || !Array.isArray(raw.entries)) return [];
  const out: RadarContext[] = [];
  for (const e of raw.entries) {
    const c = normalizeContext(e);
    if (c) out.push(c);
  }
  return out.sort((a, b) => a.t - b.t).slice(-LOG_MAX_PER_DAY);
}

/** The logged contexts of the last 35 UTC days (today and the 34 before), oldest first. A bad or missing doc reads as empty. */
export async function loadRadarLog(port: RadarPort, now: number): Promise<RadarContext[]> {
  const out: RadarContext[] = [];
  for (let i = LOG_KEEP_DAYS - 1; i >= 0; i--) {
    try { out.push(...normalizeLogDoc(await port.get(RADAR_COLLECTION, radarLogId(now - i * DAY_MS)))); } catch { /* unreadable day: empty */ }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Append one context to its UTC day's doc (queued; a failed read never writes). Returns false when the port failed. */
export function appendRadarContext(port: RadarPort, ctx: RadarContext): Promise<boolean> {
  return serialised(async () => {
    try {
      const id = radarLogId(ctx.t);
      const entries = normalizeLogDoc(await port.get(RADAR_COLLECTION, id)); // a throw here skips the write
      entries.push(ctx);
      await port.put(RADAR_COLLECTION, id, { day: dayKey(ctx.t), entries: entries.sort((a, b) => a.t - b.t).slice(-LOG_MAX_PER_DAY) });
      return true;
    } catch { return false; }
  });
}

/** Blank the docs older than 35 days (the port cannot delete); only non-empty ones are written. */
export function pruneRadarLog(port: RadarPort, now: number): Promise<void> {
  return serialised(async () => {
    for (let i = LOG_KEEP_DAYS; i < LOG_KEEP_DAYS + PRUNE_DAYS; i++) {
      const id = radarLogId(now - i * DAY_MS);
      try {
        const raw = await port.get(RADAR_COLLECTION, id);
        if (isObj(raw) && Array.isArray(raw.entries) && raw.entries.length) await port.put(RADAR_COLLECTION, id, { day: id.slice(10), entries: [] });
      } catch { /* leave it */ }
    }
  });
}

/* ---------------- runner ---------------- */

const abortError = () => new DOMException("The radar refresh was stopped.", "AbortError");
const isAbortErr = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
async function attempt<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<Outcome<T>> {
  try {
    const value = await fn();
    if (signal.aborted) throw abortError(); // stopped while it ran: the value is dropped
    return { ok: true, value };
  } catch (error) {
    if (signal.aborted || isAbortErr(error)) throw abortError();
    return { ok: false, error };
  }
}

export function createRadarRunner(deps: RadarRunnerDeps): RadarRunner {
  const timers = deps.timers ?? realTimers;
  const f = deps.fetchers;
  const listeners = new Set<(s: RadarSnapshot) => void>();

  let timer: unknown = null;
  let latestSnap: RadarSnapshot | null = null;
  let inflight: Promise<RadarSnapshot> | null = null;
  const controllers = new Set<AbortController>();

  let cache: RadarCache | null = null;
  // Kept values and the time each was last good.
  const kept: {
    positioning: Record<"BTCUSDT" | "ETHUSDT", { v: FuturesPositioning; at: number } | null>;
    regional: { v: RegionalDemand; at: number } | null;
    buyer: { v: BuyerPressure; at: number } | null;
    breakaway: { v: RadarAlert[]; at: number } | null;
  } = { positioning: { BTCUSDT: null, ETHUSDT: null }, regional: null, buyer: null, breakaway: null };
  let daily: { day: number; data: DailyVolumes } | null = null;
  const retryAfter: Record<string, number> = {};
  let prunedDay = -1;

  async function run(outer: AbortSignal | undefined): Promise<RadarSnapshot> {
    const ctl = new AbortController();
    controllers.add(ctl);
    const onOuter = () => ctl.abort();
    if (outer) { if (outer.aborted) ctl.abort(); else outer.addEventListener("abort", onOuter, { once: true }); }
    const signal = ctl.signal;
    try {
      const now = deps.now();
      const th = sanitizeThresholds(deps.thresholds());
      if (!cache) cache = await loadRadarCache(deps.store);
      if (signal.aborted) throw abortError();
      const stale: Record<string, number> = {};
      const unavailable: string[] = [];

      /* 5-minute sections, in parallel */
      const [bt, et, rg, by, ba] = await Promise.all([
        attempt(() => f.positioning("BTCUSDT", signal), signal),
        attempt(() => f.positioning("ETHUSDT", signal), signal),
        attempt(() => f.regional(signal), signal),
        attempt(() => f.buyer(signal), signal),
        attempt(() => f.breakAway(signal), signal),
      ]);
      /* slow inputs (cache first) */
      const cotOut = await refreshCot(now, signal);
      const supplyOut = await refreshSupply(now, signal);
      const volOut = await refreshVolumes(now, signal);
      if (signal.aborted) throw abortError();

      const take = <T extends { asOf: number }>(slot: "regional" | "buyer", r: Outcome<T>) => {
        if (r.ok) (kept as Record<string, unknown>)[slot] = { v: r.value, at: r.value.asOf };
        const k = kept[slot] as { v: T; at: number } | null;
        if (!r.ok) { if (k) stale[slot] = k.at; else unavailable.push(slot); }
        return k ? k.v : null;
      };
      const pos = (sym: "BTCUSDT" | "ETHUSDT", r: Outcome<FuturesPositioning>) => {
        if (r.ok) kept.positioning[sym] = { v: r.value, at: r.value.asOf };
        const k = kept.positioning[sym];
        if (!r.ok) { const key = "positioning"; if (k) stale[key] = Math.min(stale[key] ?? Infinity, k.at); }
        return k ? k.v : null;
      };
      const positioning = { BTCUSDT: pos("BTCUSDT", bt), ETHUSDT: pos("ETHUSDT", et) };
      if (!positioning.BTCUSDT && !positioning.ETHUSDT) unavailable.push("positioning");
      const regional = take("regional", rg);
      const buyer = take("buyer", by);

      /* alerts */
      const alerts: RadarAlert[] = [];
      if (ba.ok && !ba.value.stale && Object.keys(ba.value.closes).length) {
        const fresh = breakAway(ba.value.closes, ba.value.standing, th, ba.value.closeTimes);
        kept.breakaway = { v: fresh, at: now };
        alerts.push(...fresh);
      } else if (kept.breakaway) {
        // No usable break-away data this cycle: keep the previous alerts, marked stale, and invent none.
        stale.breakaway = kept.breakaway.at;
        alerts.push(...kept.breakaway.v);
      } else {
        unavailable.push("breakaway");
      }
      if (ba.ok) {
        for (const id of ba.value.unavailable) unavailable.push(`breakaway:${id}`);
        for (const [id, v] of Object.entries(ba.value.standing)) if (v === null && !ba.value.unavailable.includes(id)) unavailable.push(`standing:${id}`);
      }
      if (volOut.data && volOut.data.latest) {
        const a = volumeSpike(volOut.data.volumes, th, volOut.data.days[volOut.data.days.length - 1]);
        if (a) alerts.push(a);
      } else if (!volOut.data) unavailable.push("volume");
      let source = "binance";
      try { source = deps.depegSource?.() || "binance"; } catch { /* default */ }
      let readings: DepegReading[] = [];
      try { readings = deps.depeg() ?? []; } catch { /* no readings */ }
      alerts.push(...depegAlerts(readings, source, now));
      if (supplyOut.points) { const a = supplyJump(supplyOut.points, th); if (a) alerts.push(a); }

      for (const k of Object.keys(cotOut.stale)) stale[k] = cotOut.stale[k];
      if (supplyOut.stale !== null) stale.supply = supplyOut.stale;
      if (!supplyOut.points) unavailable.push("supply");
      if (!cotOut.cot.BTC && !cotOut.cot.ETH) unavailable.push("cot");

      const snap: RadarSnapshot = { t: now, positioning, regional, buyer, cot: cotOut.cot, supply: supplyOut.points, alerts, stale, unavailable };
      if (signal.aborted) throw abortError(); // stopped meanwhile: publish nothing, log nothing
      latestSnap = snap;
      for (const fn of [...listeners]) { try { fn(snap); } catch { /* a listener never breaks the runner */ } }
      void logSnapshot(snap);
      return snap;
    } finally {
      outer?.removeEventListener("abort", onOuter);
      controllers.delete(ctl);
    }
  }

  async function logSnapshot(s: RadarSnapshot): Promise<void> {
    await appendRadarContext(deps.store, toRadarContext(s));
    const day = Math.floor(s.t / DAY_MS);
    if (day !== prunedDay) { prunedDay = day; await pruneRadarLog(deps.store, s.t); }
  }

  async function refreshCot(now: number, signal: AbortSignal) {
    const cot: Record<"BTC" | "ETH", CotReport | null> = { BTC: null, ETH: null };
    const stale: Record<string, number> = {};
    for (const asset of ["BTC", "ETH"] as const) {
      const c = cache!.cot[asset];
      if (c && isFresh(c.at, CFTC_TTL_MS, now)) { cot[asset] = c.report; continue; }
      const key = `cot:${asset}`;
      if (now < (retryAfter[key] ?? 0)) { cot[asset] = c?.report ?? null; if (c) stale.cot = Math.min(stale.cot ?? Infinity, c.at); continue; }
      const r = await attempt(() => f.cot(asset, signal), signal);
      if (r.ok && r.value && r.value.asset === asset) {
        cot[asset] = r.value;
        cache!.cot[asset] = { at: now, report: r.value };
        void saveCotCache(deps.store, r.value, now);
      } else {
        retryAfter[key] = now + RETRY_MS;
        cot[asset] = c?.report ?? null;
        if (c) stale.cot = Math.min(stale.cot ?? Infinity, c.at);
      }
    }
    return { cot, stale };
  }

  async function refreshSupply(now: number, signal: AbortSignal) {
    const c = cache!.supply;
    if (c && supplyFreshForDay(c.at, now)) return { points: c.points, stale: null as number | null };
    if (now < (retryAfter.supply ?? 0)) return { points: c?.points ?? null, stale: c ? c.at : null };
    const r = await attempt(() => f.supply(signal), signal);
    if (r.ok && r.value.length) {
      cache!.supply = { at: now, points: r.value };
      void saveSupplyCache(deps.store, r.value, now);
      return { points: r.value, stale: null as number | null };
    }
    retryAfter.supply = now + RETRY_MS;
    return { points: c?.points ?? null, stale: c ? c.at : null };
  }

  async function refreshVolumes(now: number, signal: AbortSignal): Promise<{ data: DailyVolumes | null }> {
    const day = Math.floor(now / DAY_MS);
    if (daily && daily.day === day) return { data: daily.data };
    if (now < (retryAfter.volume ?? 0)) return { data: null };
    const r = await attempt(() => f.dailyVolumes(signal), signal);
    if (r.ok && r.value.volumes.length) { daily = { day, data: r.value }; return { data: r.value }; }
    retryAfter.volume = now + RETRY_MS;
    return { data: null };
  }

  function refresh(signal?: AbortSignal): Promise<RadarSnapshot> {
    if (inflight) return inflight;
    const p = run(signal).finally(() => { if (inflight === p) inflight = null; });
    inflight = p;
    return p;
  }

  function tick() {
    if (inflight) return; // still running: skip this tick
    refresh().catch(() => { /* aborted or failed: the next tick tries again */ });
  }

  return {
    start() {
      if (timer !== null) return;
      timer = timers.set(tick, RADAR_INTERVAL_MS);
      tick();
    },
    stop() {
      if (timer !== null) { timers.clear(timer); timer = null; }
      for (const c of [...controllers]) c.abort();
      inflight = null;
    },
    refresh,
    latest: () => latestSnap,
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}
