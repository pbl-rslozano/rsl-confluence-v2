/**
 * store.ts — v2.8 Step 4a (plan WP25, Task 3): per-device persistence for the radar's slow inputs, on the StoragePort
 * (the same document port preferences-store uses: get/put by collection and id).
 *  - cache doc  "radar-cache": the newest CFTC report per asset and the stablecoin series, each with its fetch time;
 *  - ETF doc    "radar-etf": imported ETF rows, at most 800 days (newest kept).
 * Both live in the existing "meta" collection, so no new collection (and no IndexedDB version bump) is needed.
 * Everything read back is re-validated; a bad or missing doc reads as empty. Nothing here reaches scoring.
 */
import type { CotAsset, CotReport } from "./cftc";
import type { EtfFlow } from "./etf-csv";
import { parseSupply, type SupplyPoint } from "./stablecoins";

export interface RadarPort {
  get(col: string, id: string): Promise<unknown>;
  put(col: string, id: string, doc: unknown): Promise<void>;
}

export const RADAR_COLLECTION = "meta";
export const RADAR_CACHE_ID = "radar-cache";
export const RADAR_ETF_ID = "radar-etf";
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

export function normalizeCache(raw: unknown): RadarCache {
  const out: RadarCache = { cot: {}, supply: null };
  if (!isObj(raw)) return out;
  if (isObj(raw.cot)) {
    for (const asset of ["BTC", "ETH"] as const) {
      const e = raw.cot[asset];
      if (!isObj(e)) continue;
      const at = finiteAt(e.at);
      // The stored report is re-checked field by field, never trusted as written.
      const r = isObj(e.report) ? e.report : null;
      if (at === null || !r || r.asset !== asset || typeof r.reportDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.reportDate)) continue;
      const group = (g: unknown) => {
        if (!isObj(g)) return null;
        const { long, short, net, netChg } = g as Record<string, unknown>;
        if (![long, short, net].every((x) => typeof x === "number" && Number.isFinite(x))) return null;
        return { long: long as number, short: short as number, net: net as number, netChg: typeof netChg === "number" && Number.isFinite(netChg) ? netChg : null };
      };
      out.cot[asset] = {
        at,
        report: {
          asset, reportDate: r.reportDate,
          assetManagers: group(r.assetManagers), leveragedFunds: group(r.leveragedFunds),
          openInterest: typeof r.openInterest === "number" && Number.isFinite(r.openInterest) && r.openInterest >= 0 ? r.openInterest : null,
        },
      };
    }
  }
  if (isObj(raw.supply)) {
    const at = finiteAt(raw.supply.at);
    const pts = Array.isArray(raw.supply.points)
      ? parseSupply(raw.supply.points.map((p: unknown) => (isObj(p) && typeof p.day === "number" ? { date: String(p.day / 1000), totalCirculatingUSD: { peggedUSD: p.usd } } : null)))
      : [];
    if (at !== null && pts.length) out.supply = { at, points: pts };
  }
  return out;
}

export async function loadRadarCache(port: RadarPort): Promise<RadarCache> {
  try { return normalizeCache(await port.get(RADAR_COLLECTION, RADAR_CACHE_ID)); } catch { return { cot: {}, supply: null }; }
}

/** Merge one slice into the cache doc and write it. Returns false when the port failed. */
async function writeCache(port: RadarPort, patch: (c: RadarCache) => void): Promise<boolean> {
  try {
    const cache = await loadRadarCache(port);
    patch(cache);
    await port.put(RADAR_COLLECTION, RADAR_CACHE_ID, cache);
    return true;
  } catch { return false; }
}
export const saveCotCache = (port: RadarPort, report: CotReport, at: number) => writeCache(port, (c) => { c.cot[report.asset] = { at, report }; });
export const saveSupplyCache = (port: RadarPort, points: SupplyPoint[], at: number) =>
  writeCache(port, (c) => { c.supply = { at, points: points.slice(-SUPPLY_KEEP_DAYS) }; });

/** Merge imported rows into the stored ones (same date and issuer: the imported row wins), keep the newest 800 days. */
export function mergeEtfRows(existing: EtfFlow[], incoming: EtfFlow[], keepDays = ETF_KEEP_DAYS): EtfFlow[] {
  const map = new Map<string, EtfFlow>();
  for (const r of [...existing, ...incoming]) map.set(`${r.date}\u0000${r.issuer}`, r);
  const dates = [...new Set([...map.values()].map((r) => r.date))].sort().slice(-keepDays);
  const keep = new Set(dates);
  return [...map.values()].filter((r) => keep.has(r.date)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.issuer < b.issuer ? -1 : a.issuer > b.issuer ? 1 : 0));
}

const ETF_ISSUER_RE = /^[A-Za-z0-9 .&-]{1,40}$/;
/** Stored ETF rows, re-validated (date, issuer, finite flow); anything else is dropped. */
export function normalizeEtfDoc(raw: unknown): EtfFlow[] {
  const rows = isObj(raw) && Array.isArray(raw.rows) ? raw.rows : [];
  const out: EtfFlow[] = [];
  for (const r of rows) {
    if (!isObj(r)) continue;
    if (typeof r.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue;
    if (typeof r.issuer !== "string" || !ETF_ISSUER_RE.test(r.issuer)) continue;
    if (typeof r.flowUsd !== "number" || !Number.isFinite(r.flowUsd) || Math.abs(r.flowUsd) > 1e11) continue;
    out.push({ date: r.date, issuer: r.issuer, flowUsd: r.flowUsd });
  }
  return out;
}
export async function loadEtfRows(port: RadarPort): Promise<EtfFlow[]> {
  try { return normalizeEtfDoc(await port.get(RADAR_COLLECTION, RADAR_ETF_ID)); } catch { return []; }
}
/** Merge `incoming` into the stored rows and write them; returns the stored rows, or null when the port failed. */
export async function saveEtfRows(port: RadarPort, incoming: EtfFlow[]): Promise<EtfFlow[] | null> {
  try {
    const merged = mergeEtfRows(await loadEtfRows(port), incoming);
    await port.put(RADAR_COLLECTION, RADAR_ETF_ID, { rows: merged, savedAt: Date.now() });
    return merged;
  } catch { return null; }
}
