/**
 * store.ts — v2.8 Step 4a (plan WP25, Task 3): per-device persistence for the radar's slow inputs, on the StoragePort
 * (the same document port preferences-store uses: get/put by collection and id).
 *  - cache doc  "radar-cache": the newest CFTC report per asset and the stablecoin series, each with its fetch time;
 *  - ETF doc    "radar-etf": imported ETF rows, at most 800 days (newest kept).
 * Saves are serialised through one queue, and a failed read aborts a save (never overwrites what it could not read).
 * Both live in the existing "meta" collection, so no new collection (and no IndexedDB version bump) is needed.
 * Everything read back is re-validated; a bad or missing doc reads as empty. Nothing here reaches scoring.
 */
import type { CotAsset, CotReport } from "./cftc";
import { normalizeEtfRow, validEtfDate, type EtfFlow } from "./etf-csv";
import { SUPPLY_MAX_USD, type SupplyPoint } from "./stablecoins";

export interface RadarPort {
  get(col: string, id: string): Promise<unknown>;
  put(col: string, id: string, doc: unknown): Promise<void>;
}

export const RADAR_COLLECTION = "meta";
export const RADAR_CACHE_ID = "radar-cache";
export const RADAR_ETF_ID = "radar-etf";
/** v2.8 Step 4b: the liquidation feed's complete UTC hours, `{ v: 1, hours: { bybit, binance } }` (see liquidation-feed.ts). */
export const RADAR_LIQ_ID = "radar-liq";
export const CFTC_TTL_MS = 12 * 3_600_000;
export const SUPPLY_KEEP_DAYS = 400;
export const ETF_KEEP_DAYS = 800;
const DAY_MS = 86_400_000;

export interface RadarCache {
  cot: Partial<Record<CotAsset, { at: number; report: CotReport }>>;
  supply: { at: number; points: SupplyPoint[] } | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finiteAt = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/** Fresh when fetched at or before `now` and less than `ttlMs` ago (a fetch time in the future is not fresh). */
export function isFresh(at: number | null | undefined, ttlMs: number, now: number): boolean {
  return typeof at === "number" && Number.isFinite(at) && at <= now && now - at < ttlMs;
}

/** True when the cached supply was fetched on the same UTC day as `now` (daily input: once per UTC day). */
export function supplyFreshForDay(at: number | null | undefined, now: number): boolean {
  return typeof at === "number" && Number.isFinite(at) && at <= now && Math.floor(at / DAY_MS) === Math.floor(now / DAY_MS);
}

const COT_MAX_POSITION = 1e9;
const COT_MAX_CHG = 2e9;
const SUPPLY_MIN_DAY = Date.UTC(2015, 0, 1);

/** A stored CFTC group: long/short whole numbers in [0, 1e9]; net is recomputed, never trusted; netChg bounded or null. */
function cotGroup(g: unknown): { long: number; short: number; net: number; netChg: number | null } | null {
  if (!isObj(g)) return null;
  const { long, short, netChg } = g;
  const pos = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= COT_MAX_POSITION;
  if (!pos(long) || !pos(short)) return null;
  return { long, short, net: long - short, netChg: typeof netChg === "number" && Number.isFinite(netChg) && Math.abs(netChg) <= COT_MAX_CHG ? netChg : null };
}

/** Stored supply points: UTC-midnight day in [2015-01-01, now + 1 day], 0 < usd <= 1e13; ascending, one per day, newest 400. */
function supplyPoints(raw: unknown, now: number): SupplyPoint[] {
  if (!Array.isArray(raw)) return [];
  const byDay = new Map<number, number>();
  for (const p of raw) {
    if (!isObj(p)) continue;
    const { day, usd } = p;
    if (typeof day !== "number" || !Number.isInteger(day) || day % DAY_MS !== 0 || day < SUPPLY_MIN_DAY || day > now + DAY_MS) continue;
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0 || usd > SUPPLY_MAX_USD) continue;
    byDay.set(day, usd);
  }
  return [...byDay.entries()].sort((a, b) => a[0] - b[0]).slice(-SUPPLY_KEEP_DAYS).map(([day, usd]) => ({ day, usd }));
}

export function normalizeCache(raw: unknown, now: number = Date.now()): RadarCache {
  const out: RadarCache = { cot: {}, supply: null };
  if (!isObj(raw)) return out;
  if (isObj(raw.cot)) {
    for (const asset of ["BTC", "ETH"] as const) {
      const e = raw.cot[asset];
      if (!isObj(e)) continue;
      const at = finiteAt(e.at);
      // The stored report is re-checked field by field, never trusted as written.
      const r = isObj(e.report) ? e.report : null;
      if (at === null || !r || r.asset !== asset || !validEtfDate(r.reportDate)) continue;
      out.cot[asset] = {
        at,
        report: {
          asset, reportDate: r.reportDate,
          assetManagers: cotGroup(r.assetManagers), leveragedFunds: cotGroup(r.leveragedFunds),
          openInterest: typeof r.openInterest === "number" && Number.isFinite(r.openInterest) && r.openInterest >= 0 && r.openInterest <= COT_MAX_POSITION ? r.openInterest : null,
        },
      };
    }
  }
  if (isObj(raw.supply)) {
    const at = finiteAt(raw.supply.at);
    const pts = supplyPoints(raw.supply.points, now);
    if (at !== null && pts.length) out.supply = { at, points: pts };
  }
  return out;
}

export async function loadRadarCache(port: RadarPort): Promise<RadarCache> {
  try { return normalizeCache(await port.get(RADAR_COLLECTION, RADAR_CACHE_ID)); } catch { return { cot: {}, supply: null }; }
}

/**
 * Every read-modify-write of a radar doc runs through this one queue, so two saves never interleave (BTC COT, ETH COT
 * and supply are saved close together). A failed task never blocks the next one.
 */
let writeQueue: Promise<unknown> = Promise.resolve();
export function serialised<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => undefined);
  return run;
}

/** Merge one slice into the cache doc and write it. Returns false when the port failed; a failed read never writes. */
function writeCache(port: RadarPort, patch: (c: RadarCache) => void): Promise<boolean> {
  return serialised(async () => {
    try {
      const cache = normalizeCache(await port.get(RADAR_COLLECTION, RADAR_CACHE_ID)); // a throw here skips the write
      patch(cache);
      await port.put(RADAR_COLLECTION, RADAR_CACHE_ID, cache);
      return true;
    } catch { return false; }
  });
}
export const saveCotCache = (port: RadarPort, report: CotReport, at: number) => writeCache(port, (c) => { c.cot[report.asset] = { at, report }; });
export const saveSupplyCache = (port: RadarPort, points: SupplyPoint[], at: number) =>
  writeCache(port, (c) => { c.supply = { at, points: supplyPoints(points, Date.now()) }; });

/** Merge imported rows into the stored ones (same date and issuer: the imported row wins), keep the newest 800 days. Rows that fail validation are dropped. */
export function mergeEtfRows(existing: EtfFlow[], incoming: EtfFlow[], keepDays = ETF_KEEP_DAYS): EtfFlow[] {
  const map = new Map<string, EtfFlow>();
  for (const raw of [...existing, ...incoming]) {
    const r = normalizeEtfRow(raw);
    if (r) map.set(`${r.date}\u0000${r.issuer}`, r);
  }
  const dates = [...new Set([...map.values()].map((r) => r.date))].sort().slice(-keepDays);
  const keep = new Set(dates);
  return [...map.values()].filter((r) => keep.has(r.date)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.issuer < b.issuer ? -1 : a.issuer > b.issuer ? 1 : 0));
}

/** Stored ETF rows, re-validated like an import (calendar date, issuer rule, finite capped flow), de-duplicated, newest 800 dates. */
export function normalizeEtfDoc(raw: unknown): EtfFlow[] {
  return mergeEtfRows([], isObj(raw) && Array.isArray(raw.rows) ? raw.rows : []);
}
export async function loadEtfRows(port: RadarPort): Promise<EtfFlow[]> {
  try { return normalizeEtfDoc(await port.get(RADAR_COLLECTION, RADAR_ETF_ID)); } catch { return []; }
}
/**
 * Merge `incoming` into the stored rows and write them; returns the stored rows, or null when the port failed.
 * A failed read aborts the save (null, nothing written): the imported history must never be replaced by one file.
 */
export function saveEtfRows(port: RadarPort, incoming: EtfFlow[]): Promise<EtfFlow[] | null> {
  return serialised(async () => {
    try {
      const existing = normalizeEtfDoc(await port.get(RADAR_COLLECTION, RADAR_ETF_ID)); // a throw here skips the write
      const merged = mergeEtfRows(existing, incoming);
      await port.put(RADAR_COLLECTION, RADAR_ETF_ID, { rows: merged, savedAt: Date.now() });
      return merged;
    } catch { return null; }
  });
}
