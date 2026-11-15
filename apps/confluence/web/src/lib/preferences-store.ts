"use client";

import { baseFromInput, normalizeQuoteMode } from "./quotes";
import { DEFAULT_LIQUIDITY_FLOOR_USD, normalizeLiquidityFloor, type DataSource } from "./market-client";
import { ASSET_CLASS_FILTERS, type AssetClassFilter } from "./asset-classes";

export type StoredTimeframe =
  | "1M"
  | "1w"
  | "1d"
  | "4d"
  | "2d"
  | "12h"
  | "8h"
  | "6h"
  | "4h"
  | "1h"
  | "15m"
  | "5m"
  | "1m";
/** v2.5: "system" follows the OS; "white" is the stored name of the light theme (back-compat). */
export type StoredBackground = "dark" | "white" | "system";
export type StoredSortKey =
  | "rank"
  | "symbol"
  | "price"
  | "change24h"
  | "quoteVolume"
  | "bull"
  | "bear"
  | "score";
export type StoredSortDir = "asc" | "desc";
export type StoredChartDepth = "60" | "250" | "1000" | "all";

export interface AppPreferences {
  timeframe: StoredTimeframe;
  dataSource: DataSource;
  universeLimit: number;
  background: StoredBackground;
  monitorAssets: string[];
  sortKey: StoredSortKey;
  sortDir: StoredSortDir;
  autoRefresh: boolean;
  chartDepth: StoredChartDepth;
  /** v2.1.1: which asset class the scanner lists (crypto by default). */
  assetClass: AssetClassFilter;
  /** v2.7 (WP12): stablecoin quote per data source (missing = USDT; Coins.ph = PHP). */
  quoteBySource: Partial<Record<DataSource, string>>;
  /** v2.7 (WP13): "AUTO" (device region) or an ISO 4217 code. Display only. */
  displayCurrency: string;
  /** v2.7: rate source — "auto", a tested source id, or "custom" (the user's own, not tested). */
  fxSource: string;
  /** v2.7: refresh rates automatically every 6 hours. */
  fxAutoUpdate: boolean;
  /** v2.7: the user's own source (name and address) when fxSource is "custom". */
  fxCustom: { name: string; url: string } | null;
  /** v2.8 (WP19): crypto liquidity floor — US$ of 24 h quote volume (the scan's qvUsd); 0 = off. A scan setting, not a paper rule. */
  liquidityFloorUsd: number;
}

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  // v2.1.1: 4h by default for new installs (signal-edge report #10: lower-noise bars,
  // costs small relative to moves). Saved preferences keep the user's choice.
  timeframe: "4h",
  dataSource: "binance",
  universeLimit: 100,
  background: "system",
  monitorAssets: [],
  sortKey: "quoteVolume",
  sortDir: "desc",
  autoRefresh: true,
  chartDepth: "250",
  assetClass: "crypto",
  quoteBySource: {},
  displayCurrency: "AUTO",
  fxSource: "auto",
  fxAutoUpdate: true,
  fxCustom: null,
  liquidityFloorUsd: DEFAULT_LIQUIDITY_FLOOR_USD,
};

const STORAGE_KEY = "ct-preferences-v1";
const TIMEFRAMES = new Set<StoredTimeframe>(["1M", "1w", "1d", "4d", "2d", "12h", "8h", "6h", "4h", "1h", "15m", "5m", "1m"]);
const DATA_SOURCES = new Set<DataSource>(["binance", "bybit-spot", "bybit-perp", "bitget", "bitget-perp", "coinsph", "okx", "okx-perp"]);
const UNIVERSE_LIMITS = new Set([25, 50, 100, 200]);
const BACKGROUNDS = new Set<StoredBackground>(["dark", "white", "system"]);
const SORT_KEYS = new Set<StoredSortKey>(["rank", "symbol", "price", "change24h", "quoteVolume", "bull", "bear", "score"]);
const SORT_DIRS = new Set<StoredSortDir>(["asc", "desc"]);
const CHART_DEPTHS = new Set<StoredChartDepth>(["60", "250", "1000", "all"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function savedOrDefault<T>(value: unknown, allowed: Set<T>, fallback: T): T {
  return allowed.has(value as T) ? value as T : fallback;
}

function normalizeMonitorAssets(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((asset): asset is string => typeof asset === "string")
    .map((asset) => baseFromInput(asset)) // v2.7: any stablecoin quote
    .filter((asset) => /^[A-Z0-9]{1,15}$/.test(asset)))]
    .slice(0, 100);
}

const FX_CHOICES = new Set(["auto", "frankfurter", "ecb", "erapi", "fawazahmed0", "floatrates", "custom"]);
/** v2.7: a user-named rate source — plain text name, and an http(s) address kept for reference only. */
export function normalizeCustomSource(value: unknown): { name: string; url: string } | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === "string" ? value.name.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 80) : "";
  let url = "";
  try {
    const u = new URL(String(value.url ?? ""));
    if (u.protocol === "https:" || u.protocol === "http:") url = u.href.slice(0, 500);
  } catch { /* not a URL */ }
  return name || url ? { name: name || url, url } : null;
}

/** v2.7: per-source quote modes, each validated against what that source can serve. */
function normalizeQuotes(value: unknown): Partial<Record<DataSource, string>> {
  if (!isRecord(value)) return {};
  const out: Partial<Record<DataSource, string>> = {};
  for (const [src, mode] of Object.entries(value)) {
    if (!DATA_SOURCES.has(src as DataSource) || typeof mode !== "string") continue;
    const m = normalizeQuoteMode(src, mode);
    if (m === mode.toUpperCase()) out[src as DataSource] = m;
  }
  return out;
}

/** Validate any stored object into AppPreferences (unknown values fall back to defaults). */
export function normalizePreferences(saved: unknown): AppPreferences | null {
  if (!isRecord(saved)) return null;
  return {
    timeframe: savedOrDefault(saved.timeframe, TIMEFRAMES, DEFAULT_APP_PREFERENCES.timeframe),
    dataSource: savedOrDefault(saved.dataSource, DATA_SOURCES, DEFAULT_APP_PREFERENCES.dataSource),
    universeLimit: savedOrDefault(saved.universeLimit, UNIVERSE_LIMITS, DEFAULT_APP_PREFERENCES.universeLimit),
    background: savedOrDefault(saved.background, BACKGROUNDS, DEFAULT_APP_PREFERENCES.background),
    monitorAssets: normalizeMonitorAssets(saved.monitorAssets),
    sortKey: savedOrDefault(saved.sortKey, SORT_KEYS, DEFAULT_APP_PREFERENCES.sortKey),
    sortDir: savedOrDefault(saved.sortDir, SORT_DIRS, DEFAULT_APP_PREFERENCES.sortDir),
    autoRefresh: typeof saved.autoRefresh === "boolean" ? saved.autoRefresh : DEFAULT_APP_PREFERENCES.autoRefresh,
    chartDepth: savedOrDefault(saved.chartDepth, CHART_DEPTHS, DEFAULT_APP_PREFERENCES.chartDepth),
    assetClass: savedOrDefault(saved.assetClass, new Set<AssetClassFilter>(ASSET_CLASS_FILTERS), DEFAULT_APP_PREFERENCES.assetClass),
    quoteBySource: normalizeQuotes(saved.quoteBySource),
    displayCurrency: typeof saved.displayCurrency === "string" && /^(AUTO|[A-Z]{3})$/.test(saved.displayCurrency) ? saved.displayCurrency : "AUTO",
    fxSource: savedOrDefault(saved.fxSource, FX_CHOICES, "auto"),
    fxAutoUpdate: typeof saved.fxAutoUpdate === "boolean" ? saved.fxAutoUpdate : true,
    fxCustom: normalizeCustomSource(saved.fxCustom),
    liquidityFloorUsd: normalizeLiquidityFloor(saved.liquidityFloorUsd),
  };
}

/** Legacy (≤ 2.02) localStorage key — read once by migration 1, never written again. */
export const LEGACY_STORAGE_KEY = STORAGE_KEY;

/** Read the pre-2.1 localStorage preferences (used only by the one-time migration). */
export function readLegacyPreferences(): AppPreferences | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizePreferences(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- *
 *  v2.1: preferences are a record in the StoragePort (native SQLite on desktop
 *  and mobile, IndexedDB in the PWA). Boot binds the port and primes the cache,
 *  so page code keeps its synchronous load/save API.
 * -------------------------------------------------------------------------- */
interface PreferencesPort {
  get(col: string, id: string): Promise<unknown>;
  put(col: string, id: string, doc: unknown): Promise<void>;
}
let boundPort: PreferencesPort | null = null;
let cached: AppPreferences | null = null;
let onSaved: ((before: AppPreferences | null, after: AppPreferences) => void) | null = null;

export async function bindPreferencesPort(
  port: PreferencesPort,
  hooks: { onSaved?: (before: AppPreferences | null, after: AppPreferences) => void } = {},
): Promise<AppPreferences | null> {
  boundPort = port;
  onSaved = hooks.onSaved ?? null;
  cached = normalizePreferences(await port.get("preferences", "current"));
  return cached;
}

export function loadAppPreferences(): AppPreferences | null {
  return cached;
}

export function saveAppPreferences(preferences: AppPreferences): boolean {
  const before = cached;
  if (before && JSON.stringify(before) === JSON.stringify(preferences)) return true;
  cached = preferences;
  if (!boundPort) return false;
  void boundPort.put("preferences", "current", preferences).then(() => onSaved?.(before, preferences)).catch(() => undefined);
  return true;
}
