/**
 * snapshot.ts — v2.8 Step 4a (plan WP25, Task 5): the radar runner. Framework-free (Task 6 wraps it in React).
 *
 * Context, never a vote: nothing here reaches scoring, and no alert blocks or places a trade. The runner makes no
 * network request itself; every request goes through the fetchers it is given (the real ones: realFetchers).
 *
 * Gating: `radarAllowed` is the one rule (panel open or recordRadar on). The caller starts the runner only while it
 * holds, and stops it otherwise; a stopped runner has no timer and its ticks do nothing.
 * Cadence while started: an immediate refresh, then every 5 min. Daily inputs (stablecoin supply, daily volumes) are read
 * once per UTC day and kept; CFTC at most once per 12 h (cache doc, so it also survives a reload). A refresh still
 * running when the next tick fires makes that tick a no-op. A failed slow input is retried after RETRY_MS, not every tick.
 * `stop()` aborts every in-flight request and clears the timer; a refresh that was aborted never publishes or logs.
 *
 * A section that fails keeps its last good value, and `stale[section]` is the time that value was good.
 * Stale keys: positioning:BTCUSDT, positioning:ETHUSDT, regional (whole section), regional:us / regional:kr / regional:ph (one premium
 * whose source failed while the others answered: its last good value is kept, with its time), buyer, cot:BTC, cot:ETH, supply, breakaway
 * (kept break-away inputs; dropped after FIELDS_MAX_AGE_MS without fresh data). `unavailable` lists
 * what has no value at all: positioning:<symbol>, regional, buyer, cot:<asset>, supply, breakaway, volume (daily volumes could
 * not be had or do not end at yesterday), plus `breakaway:<venue>` (hourly bars failed) and `standing:<venue>` (under 20 days).
 * Every section has a deadline (45 s): a timeout is that section's failure, not a stop. `snapshot.t` is the END of the refresh.
 * The context log nulls the fields of a stale section and omits stale break-away codes.
 * Optional `allowed()` dep: while false, start/tick/refresh make no request (refresh rejects).
 *
 * Per-device context log: one doc per UTC day, id `radar-log-YYYY-MM-DD` in the "meta" collection (no schema change), written
 * through the store's serialised queue. A trimmed RadarContext (BTC values) is appended at each refresh. The port has no delete,
 * so every day listed in the `radar-log-index` doc that is older than 35 days is blanked and unlisted (once per UTC day per runner).
 */
import type { DepegReading } from "../quotes";
import { breakAway, depegAlerts, sanitizeThresholds, supplyJump, volumeSpike, ALERT_CODE, type AlertCode, type RadarAlert, type RadarThresholds } from "./alerts";
import { fetchFuturesPositioning, type FuturesPositioning } from "./binance-futures";
import { fetchBreakAwayCloses, fetchDailyVolumesDetailed, type BreakAwayCloses, type DailyVolumes } from "./breakaway-feed";
import { fetchCot, type CotAsset, type CotReport } from "./cftc";
import { fetchBuyerPressure, fetchRegionalDemand, type BuyerPressure, type RegionalDemand } from "./regional";
import { radRanged } from "./rad-bounds";
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
  /** When the scan took the readings (ms). The depeg alert's `since`; readings older than 2 h are not alerts. Default: the refresh time. */
  depegAt?: () => number | null | undefined;
  /** Per-section deadline in ms (default 45 s); a section that exceeds it counts as failed (kept value, stale), not as a stop. */
  sectionTimeoutMs?: number;
  /** Optional gate (radarAllowed of the caller): while it returns false, start/tick/refresh make no request. */
  allowed?: () => boolean;
  /** Test hook: replaces setInterval/clearInterval. */
  timers?: RadarTimers;
}

export interface RadarRunner {
  start(): void;
  stop(): void;
  /** One refresh. A call that joins a refresh already running shares it (and its signal); the joiner's own signal is ignored. */
  refresh(signal?: AbortSignal): Promise<RadarSnapshot>;
  latest(): RadarSnapshot | null;
  /** Re-run the alert rules over the last fetched inputs with the current thresholds: no request, same `t`, no log row. A no-op before the first snapshot. */
  rethreshold(): void;
  /** Called with each published snapshot (lastError null) and with (latest, { lastError }) when a refresh failed for a non-fetch reason. */
  subscribe(fn: (s: RadarSnapshot | null, info?: { lastError: string | null }) => void): () => void;
  /** Message of the last non-fetch error (a throwing getter, a bug); null after a good refresh. */
  lastError(): string | null;
}

/* ---------------- context ---------------- */

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The BTC values of a snapshot, trimmed for the ledger. `al` = the current (not stale) alert codes: unique, sorted, at most 16. */
export function toRadarContext(s: RadarSnapshot): RadarContext {
  // A section whose value was kept from an earlier refresh (stale) is not logged as current: its fields are null.
  const st = s.stale ?? {};
  const p = st["positioning:BTCUSDT"] !== undefined ? null : s.positioning?.BTCUSDT ?? null;
  const shares = st.buyer !== undefined ? [] : s.buyer?.takerShare ?? [];
  const regional = st.regional !== undefined ? null : s.regional;
  const prem = (key: "usP" | "krP" | "phP", id: "us" | "kr" | "ph", v: number | null | undefined) => (st[`regional:${id}`] !== undefined ? null : radRanged(key, v));
  let tk: number | null = null;
  for (let i = shares.length - 1; i >= 0; i--) {
    const v = num(shares[i]);
    if (v !== null) { tk = v; break; }
  }
  const al = [...new Set((s.alerts ?? []).filter((a) => !(st.breakaway !== undefined && a.kind === "breakaway")).map((a) => a.code).filter((c) => ALERT_CODE.test(c)))].sort().slice(0, 16);
  return {
    t: s.t,
    // Out-of-range values (a glitched price, a kimchi premium above 50 %) are logged as null: the ledger would reject the row.
    frp: radRanged("frp", p?.fundingPctl30d),
    oi24: radRanged("oi24", p?.oiChg24hPct),
    ls: radRanged("ls", p?.longShortRatio),
    tk: radRanged("tk", tk),
    usP: prem("usP", "us", regional?.usPct),
    krP: prem("krP", "kr", regional?.krPct),
    phP: prem("phP", "ph", regional?.phPct),
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
  return { t: raw.t, frp: radRanged("frp", raw.frp), oi24: radRanged("oi24", raw.oi24), ls: radRanged("ls", raw.ls), tk: radRanged("tk", raw.tk), usP: radRanged("usP", raw.usP), krP: radRanged("krP", raw.krP), phP: radRanged("phP", raw.phP), al };
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
      try { // the index of written days (so pruning finds every old day); best effort, the entry is already stored
        const days = readIndex(await port.get(RADAR_COLLECTION, RADAR_LOG_INDEX_ID));
        const day = dayKey(ctx.t);
        if (!days.includes(day)) await port.put(RADAR_COLLECTION, RADAR_LOG_INDEX_ID, { days: [...days, day].sort() });
      } catch { /* index not updated */ }
      return true;
    } catch { return false; }
  });
}
export const RADAR_LOG_INDEX_ID = "radar-log-index";
const DAY_ID = /^\d{4}-\d{2}-\d{2}$/;
function readIndex(raw: unknown): string[] {
  return isObj(raw) && Array.isArray(raw.days) ? raw.days.filter((d): d is string => typeof d === "string" && DAY_ID.test(d)) : [];
}

/**
 * Blank every logged day older than 35 days (the port cannot delete) and drop it from the index. Note: the queue is per
 * JS realm, so two tabs can interleave a read-modify-write and lose an entry: best effort per device.
 */
export function pruneRadarLog(port: RadarPort, now: number): Promise<void> {
  return serialised(async () => {
    try {
      const days = readIndex(await port.get(RADAR_COLLECTION, RADAR_LOG_INDEX_ID));
      const cutoff = dayKey(now - (LOG_KEEP_DAYS - 1) * DAY_MS); // days before this are out of the window
      const old = days.filter((d) => d < cutoff);
      if (!old.length) return;
      const left = new Set(days);
      for (const d of old) {
        try { await port.put(RADAR_COLLECTION, `radar-log-${d}`, { day: d, entries: [] }); left.delete(d); } catch { /* stays listed */ }
      }
      await port.put(RADAR_COLLECTION, RADAR_LOG_INDEX_ID, { days: [...left].sort() });
    } catch { /* leave it */ }
  });
}

/* ---------------- runner ---------------- */

const abortError = () => new DOMException("The radar refresh was stopped.", "AbortError");
export const SECTION_TIMEOUT_MS = 45_000;

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
/**
 * Run one section with its own deadline. A timeout (or a failure) is that section's failure, never a stop; only the
 * refresh's own signal being aborted rejects with AbortError. A fetcher that ignores its signal is still cut off.
 */
async function attempt<T>(fn: (s: AbortSignal) => Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<Outcome<T>> {
  const child = new AbortController();
  const onParent = () => child.abort();
  signal.addEventListener("abort", onParent, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Outcome<T>>((resolve) => {
    timer = setTimeout(() => { child.abort(); resolve({ ok: false, error: new Error("radar section timed out") }); }, timeoutMs);
  });
  try {
    const run = fn(child.signal).then((value): Outcome<T> => ({ ok: true, value }), (error): Outcome<T> => ({ ok: false, error }));
    const r = await Promise.race([run, deadline]);
    if (signal.aborted) throw abortError(); // stopped while it ran: the outcome is dropped
    return r;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onParent);
  }
}

/** What the alert rules read: the last good break-away closes, the daily volumes, the stablecoin readings and the supply series. */
interface BreakInputs { closes: Record<string, number[]>; standing: Record<string, number | null>; closeTimes: number[] }
interface AlertInputs { breakaway: BreakInputs | null; vol: DailyVolumes | null; readings: DepegReading[]; source: string; now: number; readingAt: number; supply: SupplyPoint[] | null }

/** The alert rules over kept inputs, in the order break-away, volume, depeg, supply. Pure: no request. */
function composeAlerts(inp: AlertInputs, th: RadarThresholds): RadarAlert[] {
  const out: RadarAlert[] = [];
  if (inp.breakaway) out.push(...breakAway(inp.breakaway.closes, inp.breakaway.standing, th, inp.breakaway.closeTimes));
  if (inp.vol) {
    const a = volumeSpike(inp.vol.volumes, th, inp.vol.days[inp.vol.days.length - 1]);
    if (a) out.push(a);
  }
  out.push(...depegAlerts(inp.readings, inp.source, inp.readingAt));
  if (inp.supply) { const a = supplyJump(inp.supply, th); if (a) out.push(a); }
  return out;
}

export function createRadarRunner(deps: RadarRunnerDeps): RadarRunner {
  const timers = deps.timers ?? realTimers;
  const f = deps.fetchers;
  const timeoutMs = deps.sectionTimeoutMs ?? SECTION_TIMEOUT_MS;
  const listeners = new Set<(s: RadarSnapshot | null, info?: { lastError: string | null }) => void>();
  const permitted = () => { try { return deps.allowed ? deps.allowed() === true : true; } catch { return false; } };

  let timer: unknown = null;
  let latestSnap: RadarSnapshot | null = null;
  let lastInputs: AlertInputs | null = null;
  let lastErr: string | null = null;
  let inflight: Promise<RadarSnapshot> | null = null;
  const controllers = new Set<AbortController>();

  let cache: RadarCache | null = null;
  // Kept values and the time each was last good.
  const kept: {
    positioning: Record<"BTCUSDT" | "ETHUSDT", { v: FuturesPositioning; at: number } | null>;
    regional: { v: RegionalDemand; at: number } | null;
    /** The last good value of each premium and the time it was good (a source can fail while the others answer). */
    premiums: Record<"usPct" | "krPct" | "phPct", { v: number; at: number } | null>;
    buyer: { v: BuyerPressure; at: number } | null;
    /** The last good break-away inputs (not the alerts), so a changed threshold can be applied without a request. */
    breakaway: { v: BreakInputs; at: number } | null;
  } = { positioning: { BTCUSDT: null, ETHUSDT: null }, regional: null, premiums: { usPct: null, krPct: null, phPct: null }, buyer: null, breakaway: null };
  let daily: { day: number; data: DailyVolumes } | null = null;
  const retryAfter: Record<string, number> = {};
  let prunedDay = -1;
  const notify = (s: RadarSnapshot | null, info?: { lastError: string | null }) => {
    for (const fn of [...listeners]) { try { fn(s, info); } catch { /* a listener never breaks the runner */ } }
  };
  /** A usable `asOf`, else the time the fetch ended (a futures answer without a timestamp carries 0). */
  const goodAt = (asOf: number) => (typeof asOf === "number" && Number.isFinite(asOf) && asOf > 0 ? asOf : deps.now());

  async function run(outer: AbortSignal | undefined): Promise<RadarSnapshot> {
    const ctl = new AbortController();
    controllers.add(ctl);
    const onOuter = () => ctl.abort();
    if (outer) { if (outer.aborted) ctl.abort(); else outer.addEventListener("abort", onOuter, { once: true }); }
    const signal = ctl.signal;
    try {
      const now = deps.now();
      sanitizeThresholds(deps.thresholds()); // fail early on bad settings; re-read below, after the fetches
      if (!cache) {
        const loaded = await loadRadarCache(deps.store);
        if (signal.aborted) throw abortError();
        cache = loaded; // assigned only by a run that is still wanted
      }
      const stale: Record<string, number> = {};
      const unavailable: string[] = [];

      /* 5-minute sections, in parallel */
      const [bt, et, rg, by, ba] = await Promise.all([
        attempt((s) => f.positioning("BTCUSDT", s), signal, timeoutMs),
        attempt((s) => f.positioning("ETHUSDT", s), signal, timeoutMs),
        attempt((s) => f.regional(s), signal, timeoutMs),
        attempt((s) => f.buyer(s), signal, timeoutMs),
        attempt((s) => f.breakAway(s), signal, timeoutMs),
      ]);
      /* slow inputs (cache first) */
      const cotOut = await refreshCot(now, signal);
      const supplyOut = await refreshSupply(now, signal);
      const volOut = await refreshVolumes(now, signal);
      if (signal.aborted) throw abortError();

      const take = <T extends { asOf: number }>(slot: "buyer", r: Outcome<T>) => {
        if (r.ok) (kept as Record<string, unknown>)[slot] = { v: r.value, at: goodAt(r.value.asOf) };
        const k = kept[slot] as { v: T; at: number } | null;
        if (!r.ok) { if (k) stale[slot] = k.at; else unavailable.push(slot); }
        return k ? k.v : null;
      };
      /**
       * Regional demand keeps the last good value of each premium with its time. An answer with every premium null (Binance
       * spot down) is the section's failure; with some null (one source down) only those rows are stale (`regional:us|kr|ph`).
       */
      const PREM_IDS = { usPct: "us", krPct: "kr", phPct: "ph" } as const;
      const takeRegional = (r: Outcome<RegionalDemand>): RegionalDemand | null => {
        const rows = kept.premiums;
        const keys = Object.keys(PREM_IDS) as (keyof typeof PREM_IDS)[];
        if (r.ok && keys.some((k) => num(r.value[k]) !== null)) {
          const at = goodAt(r.value.asOf);
          for (const k of keys) { const x = num(r.value[k]); if (x !== null) rows[k] = { v: x, at }; }
          const merged: RegionalDemand = { ...r.value, usPct: rows.usPct?.v ?? null, krPct: rows.krPct?.v ?? null, phPct: rows.phPct?.v ?? null };
          kept.regional = { v: merged, at };
          for (const k of keys) if (num(r.value[k]) === null && rows[k]) stale[`regional:${PREM_IDS[k]}`] = rows[k]!.at;
          return merged;
        }
        const k = kept.regional;
        if (!k) { unavailable.push("regional"); return null; }
        stale.regional = k.at;
        for (const key of keys) if (rows[key]) stale[`regional:${PREM_IDS[key]}`] = rows[key]!.at;
        return { ...k.v, usPct: rows.usPct?.v ?? null, krPct: rows.krPct?.v ?? null, phPct: rows.phPct?.v ?? null };
      };
      const pos = (sym: "BTCUSDT" | "ETHUSDT", r: Outcome<FuturesPositioning>) => {
        if (r.ok) kept.positioning[sym] = { v: r.value, at: goodAt(r.value.asOf) };
        const k = kept.positioning[sym];
        if (!r.ok) { if (k) stale[`positioning:${sym}`] = k.at; else unavailable.push(`positioning:${sym}`); }
        return k ? k.v : null;
      };
      const positioning = { BTCUSDT: pos("BTCUSDT", bt), ETHUSDT: pos("ETHUSDT", et) };
      const regional = takeRegional(rg);
      const buyer = take("buyer", by);

      /* alerts: the inputs are kept so rethreshold() can re-run the rules without a request */
      if (ba.ok && !ba.value.stale && Object.keys(ba.value.closes).length) {
        kept.breakaway = { v: { closes: ba.value.closes, standing: ba.value.standing, closeTimes: ba.value.closeTimes }, at: deps.now() };
      } else if (kept.breakaway && now - kept.breakaway.at <= FIELDS_MAX_AGE_MS) {
        // No usable break-away data this cycle: keep the previous inputs, marked stale, and invent none.
        stale.breakaway = kept.breakaway.at;
      } else {
        kept.breakaway = null; // older than 2 h without fresh data: dropped, never shown as current
        unavailable.push("breakaway");
      }
      if (ba.ok) {
        for (const id of ba.value.unavailable) unavailable.push(`breakaway:${id}`);
        for (const [id, v] of Object.entries(ba.value.standing)) if (v === null && !ba.value.unavailable.includes(id)) unavailable.push(`standing:${id}`);
      }
      if (!volOut.data) unavailable.push("volume");
      let source = "binance";
      try { source = deps.depegSource?.() || "binance"; } catch { /* default */ }
      let readings: DepegReading[] = [];
      try { readings = deps.depeg() ?? []; } catch { /* no readings */ }
      let readingAt = now;
      try { const x = deps.depegAt?.(); if (typeof x === "number" && Number.isFinite(x) && x > 0) readingAt = Math.min(x, now); } catch { /* the refresh time */ }
      if (readingAt < now - FIELDS_MAX_AGE_MS) readings = []; // an old scan's reading is not a current alert
      const inputs: AlertInputs = { breakaway: kept.breakaway?.v ?? null, vol: volOut.data, readings, source, now, readingAt, supply: supplyOut.points };
      const alerts = composeAlerts(inputs, sanitizeThresholds(deps.thresholds()));

      for (const k of Object.keys(cotOut.stale)) stale[k] = cotOut.stale[k];
      for (const a of ["BTC", "ETH"] as const) if (!cotOut.cot[a]) unavailable.push(`cot:${a}`);
      if (supplyOut.stale !== null) stale.supply = supplyOut.stale;
      if (!supplyOut.points) unavailable.push("supply");

      if (signal.aborted) throw abortError(); // stopped meanwhile: publish nothing, log nothing
      // t is the END of the refresh: every value in this snapshot was observed at or before it (no look-ahead in rad).
      const asOfs = [regional?.asOf, buyer?.asOf, positioning.BTCUSDT?.asOf, positioning.ETHUSDT?.asOf].filter((x): x is number => typeof x === "number" && Number.isFinite(x));
      const t = Math.max(deps.now(), now, ...asOfs);
      const snap: RadarSnapshot = { t, positioning, regional, buyer, cot: cotOut.cot, supply: supplyOut.points, alerts, stale, unavailable };
      latestSnap = snap;
      lastInputs = inputs;
      lastErr = null;
      notify(snap, { lastError: null });
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
      const keep = () => { cot[asset] = c?.report ?? null; if (c) stale[key] = c.at; };
      if (now < (retryAfter[key] ?? 0)) { keep(); continue; }
      const r = await attempt((s) => f.cot(asset, s), signal, timeoutMs);
      if (r.ok && r.value && r.value.asset === asset) {
        cot[asset] = r.value;
        cache!.cot[asset] = { at: now, report: r.value };
        void saveCotCache(deps.store, r.value, now);
      } else {
        retryAfter[key] = now + RETRY_MS;
        keep();
      }
    }
    return { cot, stale };
  }

  async function refreshSupply(now: number, signal: AbortSignal) {
    const c = cache!.supply;
    if (c && supplyFreshForDay(c.at, now)) return { points: c.points, stale: null as number | null };
    if (now < (retryAfter.supply ?? 0)) return { points: c?.points ?? null, stale: c ? c.at : null };
    const r = await attempt((s) => f.supply(s), signal, timeoutMs);
    if (r.ok && r.value.length) {
      cache!.supply = { at: now, points: r.value };
      void saveSupplyCache(deps.store, r.value, now);
      return { points: r.value, stale: null as number | null };
    }
    retryAfter.supply = now + RETRY_MS;
    return { points: c?.points ?? null, stale: c ? c.at : null };
  }

  /** Daily volumes are cached for the UTC day only when they end at yesterday (`latest`); otherwise retried after RETRY_MS and reported unavailable. */
  async function refreshVolumes(now: number, signal: AbortSignal): Promise<{ data: DailyVolumes | null }> {
    const day = Math.floor(now / DAY_MS);
    if (daily && daily.day === day) return { data: daily.data };
    if (now < (retryAfter.volume ?? 0)) return { data: null };
    const r = await attempt((s) => f.dailyVolumes(s), signal, timeoutMs);
    if (r.ok && r.value.volumes.length && r.value.latest) { daily = { day, data: r.value }; return { data: r.value }; }
    retryAfter.volume = now + RETRY_MS;
    return { data: null };
  }

  function refresh(signal?: AbortSignal): Promise<RadarSnapshot> {
    if (!permitted()) return Promise.reject(new Error("The radar is not allowed to fetch (panel closed and recording off)."));
    if (inflight) return inflight;
    const p = run(signal)
      .catch((e: unknown) => {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          lastErr = e instanceof Error ? e.message : String(e);
          notify(latestSnap, { lastError: lastErr });
        }
        throw e;
      })
      .finally(() => { if (inflight === p) inflight = null; });
    inflight = p;
    return p;
  }

  function tick() {
    if (timer === null || inflight || !permitted()) return; // stopped, still running (skip, no overlap) or not allowed
    refresh().catch(() => { /* aborted or failed: lastError is set; the next tick tries again */ });
  }

  return {
    start() {
      if (timer !== null || !permitted()) return;
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
    rethreshold() {
      if (!latestSnap || !lastInputs) return;
      let th: RadarThresholds;
      try { th = sanitizeThresholds(deps.thresholds()); } catch { return; }
      latestSnap = { ...latestSnap, alerts: composeAlerts(lastInputs, th) };
      notify(latestSnap, { lastError: lastErr });
    },
    lastError: () => lastErr,
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}
