"use client";

import { ScoringProfileEditor } from "@/components/scoring-profile-editor";
import { normalizeScoringProfile, type ScoringProfile } from "@/lib/scoring-profile";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TokenIcon } from "@web3icons/react/dynamic";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CircleDot,
  Bell,
  KeyRound,
  Loader2,
  Database,
  History,
  Minus,
  RefreshCw,
  Maximize2,
  Minimize2,
  SlidersHorizontal,
  Monitor,
  Sun,
  Moon,
  RotateCcw,
  Search,
  TrendingDown,
  TrendingUp,
  Zap,
  Info,
  Mail,
  BarChart3,
  FlaskConical,
} from "lucide-react";
import { contactMailto } from "@rsl/core-kit/core/rsl-brand.js";
import { useMediaQuery, PHONE_QUERY } from "@/lib/use-media-query";
import { applyTheme, cssSupportsColorMix, migrateThemePref, resolveTheme, toStoredBackground, THEME_PREF_KEY, type ThemePref } from "@/lib/theme";
import { useRsl } from "@/rsl/RslContext";
import { RadarHost } from "@/components/radar-panel";
import { FearGreedPanel, FearGreedToggle, useFngOpen } from "@/components/fear-greed";
import { loadRadarLog, type RadarContext } from "@/lib/radar/snapshot";
import { APP } from "@/rsl/app-info";
import { BrandBlock } from "@/rsl/components/BrandBlock";
import { CustomerChip } from "@/rsl/components/CustomerChip";
import { LanguageMenu } from "@/rsl/components/LanguageMenu";
import { AboutDialog } from "@/rsl/components/AboutDialog";
import { StatusFooter } from "@/rsl/components/StatusFooter";
import { UpdateNotice } from "@/rsl/components/UpdateNotice";
import {
  type ConfluenceResult,
  type IndicatorResult,
  type Kline,
  type SignalState,
} from "@/lib/indicators";
import type { ReversalResult } from "@/lib/reversal";
import type { PatternSignal } from "@/lib/pattern-signal";
import { runPanelScores, runScanJobs, scanMode } from "@/lib/scan-runner";
import { packKlines, type ScanJob, type ScanJobResult } from "@/lib/scan-jobs";
import { createLedgerStore } from "@/lib/signal-ledger";
import { createIndexedDBAdapter } from "@rsl/core-kit/core/rsl-storage.js";
import { emptyReversal, floorLabel, suppressedConfluence, thinNote, type SeriesScore } from "@/lib/scan-pipeline";
import { emptySignal, patternAbstainKey } from "@/lib/pattern-signal";
import { ENGINE_BARS, engineConfigId } from "@/lib/engine-config";
import { ASSET_CLASS_FILTERS, barWhileClosed, classifySymbol, hasSessionGaps, type AssetClassFilter } from "@/lib/asset-classes";
import type { AssetClass, LedgerRow } from "@/lib/ledger-metrics";
import { LedgerDialog } from "@/components/ledger-dialog";
import { PaperDialog } from "@/components/paper-dialog";
import { createPaperStore, memoryPaperPort, PAPER_COLLECTIONS, PAPER_DB_NAME } from "@/lib/paper-store";
import { coverageUntil, coverageWarnings, eventsNear } from "@/lib/macro-calendar";
import { cachedDailyBars, loadDailyBars, loadFundTrends } from "@/lib/fund-trend-feed";
import { useChartOptIn } from "@/lib/chart-optin";
import { createSerialQueue, writeLiveRows } from "@/lib/fund-feed-gate";
import { disagreement, fundRanks, fundTrendSeriesFull, isFundTrendClass, type FundTrendState } from "@/lib/fund-trend";
import { pulseLedger } from "@/lib/pulse-ledger";
import { FundDisagreeMark, StopPulseButton } from "@/components/fund-disagree-mark";
import { loadOlderOnce, panelBarsNeeded, panelCacheFor, panelCacheKey, PANEL_MAX_BARS, resolvePanelScores, type PanelScoreMap } from "@/lib/panel-scores";
import { deltaPlan, loadHistoricalSeries, MAX_STORED_BARS, mergeDelta, mergeKlines, saveHistoricalSeries } from "@/lib/history-store";
import {
  createBatcher, initialRows, liveOnly, priorityOrder, PRIORITY_TOP, ProgressiveRows, recordable, rememberedTickers, rememberTickers,
  UI_BATCH_MS, type Freshness,
} from "@/lib/progressive-scan";
import { displaySeries, loadStoredSeries, prefetchOtherTimeframes, type SeriesCache } from "@/lib/progressive-load";
import {
  barCloseTime,
  contiguousTail,
  DATA_SOURCES,
  fetchHistory,
  fetchMarketData,
  fetchPaperHeldKlines,
  rateLimitCooldown,
  INTERVAL_MS,
  fetchOrderBook,
  MAX_HISTORY_BARS,
  priceCurrencyOf,
  RateLimitError,
  type ListMeta,
  slippageBps,
  usesDirectFetch,
  venueTypeOf,
  type DataSource,
} from "@/lib/market-client";
import { COINSPH_MIN_REFRESH_MS, COINSPH_MIN_USD_TURNOVER } from "@/lib/coinsph";
import { healthFromError, healthFromScan, type SourceHealth } from "@/lib/source-health";
import { catchUpContext, enrichCatchUp, liveRow, scanShared, type ScanRecordContext, type ScanSeries } from "@/lib/scan-record";
import {
  DEFAULT_APP_PREFERENCES,
  loadAppPreferences,
  saveAppPreferences,
  type AppPreferences,
  type StoredChartDepth,
} from "@/lib/preferences-store";
import { ScannerInbox } from "@/components/scanner-inbox";
import { ScannerWatchlists, type Watchlist } from "@/components/scanner-watchlists";
import { SavedScans } from "@/components/saved-scans";
import { OrderFlowPanel } from "@/components/order-flow-panel";
import { DerivativesPanel } from "@/components/derivatives-panel";
import type { DerivativeSnapshot } from "@/lib/derivatives-context";
import { ChartReplay } from "@/components/chart-replay";
import { PriceChart } from "@/components/price-chart";
import { exchangeUrl } from "@/lib/exchange-links";
import { BEST, baseOf as pairBase, normalizeQuoteMode, quoteModesFor, stableQuote, type DepegReading, type PriceCurrency } from "@/lib/quotes";
import { autoCurrency, BANDS, cachedCurrencies, cachedTable, canConvert, convert, impliedUsdtPremiumPct, isStale, loadCurrencies, PEGS, priceDisplay, rateKind, refreshRates, usdtDeviationPct, type FiatCurrency, type FxTable } from "@/lib/fx-rates";
import { formatMoney, formatMoneyCompact } from "@/lib/money";
import { FxSourcesDialog } from "@/components/fx-sources-dialog";
import { fxCredit, fxSourceInfo, type FxChoice } from "@/lib/fx-rates";
import { PrivateApiDialog } from "@/components/private-api-dialog";
import type { PrivateApiProfile, ProviderLink } from "@/lib/private-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

/* ========================================================================== *
 *  Constants & types
 * ========================================================================== */

const TIMEFRAMES = [
  { value: "1M", label: "Monthly" },
  { value: "1w", label: "Weekly" },
  { value: "1d", label: "Daily" },
  { value: "4d", label: "4 Days" },
  { value: "2d", label: "2 Days" },
  { value: "12h", label: "12 Hours" },
  { value: "8h", label: "8 Hours" },
  { value: "6h", label: "6 Hours" },
  { value: "4h", label: "4 Hour" },
  { value: "1h", label: "1 Hour" },
  { value: "15m", label: "15 Minutes (Intraday)" },
  { value: "5m", label: "5 Minutes" },
  { value: "1m", label: "1 Minute" },
] as const;

type TF = (typeof TIMEFRAMES)[number]["value"];

type BackgroundOption = "dark" | "white" | "system";

/** Bars of silence before the same pair may re-alert in the same direction. */
const ALERT_COOLDOWN_BARS = 6;

/* ENGINE_BARS (fixed engine window) now lives in lib/engine-config.ts (v2.1.1) and is
 * shared with the scan worker, the signal ledger and the replay backtest. */
/** Upper bound on remembered alert keys, so a long session cannot leak memory. */
const ALERT_MEMORY_LIMIT = 2000;

/** v2.6: Coins.ph allows ~120 weight/min per IP, so its auto-refresh is never faster than 5 min. */
const refreshCadenceFor = (timeframe: TF, source: string) =>
  Math.max(refreshCadence(timeframe), source === "coinsph" ? COINSPH_MIN_REFRESH_MS : 0);

/** True inside the Capacitor or Tauri shell (real HTTP status codes are visible there). */
const inNativeShell = () => {
  const g = globalThis as unknown as { __TAURI_INTERNALS__?: unknown; Capacitor?: { isNativePlatform?: () => boolean } };
  return !!g.__TAURI_INTERNALS__ || !!g.Capacitor?.isNativePlatform?.();
};

/** v2.6: what the last scan of a source carried besides rows (price currency, Coins.ph extras). */
interface ScanMeta {
  source: string;
  currency: PriceCurrency;
  premium: Record<string, number>;
  thin: string[];
  /** v2.8 (WP19): the US$ floor the thin pairs fell under (Coins.ph thin rule or the crypto liquidity floor). */
  thinFloorUsd?: number;
  /** v2.8 (WP26 final wave): pairs the liquidity floor left out because their US$ volume is unknown. */
  unknownVolume?: string[];
  /** v2.7: timeframe and quote mode of these rows, the quote of each row, venue quote counts, depeg readings. */
  tf?: string;
  quote?: string;
  quoteBySymbol?: Record<string, string>;
  quoteCounts?: Record<string, number>;
  approx?: string[];
  depeg?: DepegReading[];
  /** v2.8 (WP25 fix wave): when the scan took the depeg readings (ms); the radar's depeg "since". */
  depegAt?: number;
  usdPhp?: number | null;
}

const refreshCadence = (timeframe: TF) => {
  if (timeframe === "1m" || timeframe === "5m") return 30_000;
  if (timeframe === "15m" || timeframe === "1h") return 60_000;
  if (timeframe.endsWith("h")) return 5 * 60_000;
  return 15 * 60_000;
};

interface AssetRow {
  /** v2.7 (review #2): source and timeframe the row was scored on — detail-sheet actions use these, never the header's. */
  src: DataSource;
  tf: TF;
  rank: number;
  symbol: string; // e.g. BTC
  pair: string; // e.g. BTCUSDT
  price: number;
  change24h: number;
  quoteVolume: number;
  confluence: ConfluenceResult;
  reversal: ReversalResult;
  pattern: PatternSignal;
  klines: Kline[];
  assetClass: AssetClass;
  /** Stocks/FX: the newest bar printed while the underlying market was shut. */
  underlyingClosed: boolean;
  /** v2.3: context fields logged with the ledger row (never scored). */
  context?: Partial<LedgerRow>;
  /**
   * v2.8 (WP27): "live" = refreshed by a fresh fetch this scan; "updating" = drawn from on-device history while
   * its fetch is queued; "stale" = its fetch failed ("not updated"). Only live rows are recorded, proposed or alerted.
   */
  freshness: Freshness;
}

type SortKey =
  | "rank"
  | "symbol"
  | "price"
  | "change24h"
  | "quoteVolume"
  | "bull"
  | "bear"
  | "score";
type SortDir = "asc" | "desc";

/* ========================================================================== *
 *  Formatting helpers
 * ========================================================================== */

function fmtPrice(p: number): string {
  if (!isFinite(p)) return "—";
  if (p >= 1000) return p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(5);
  return p.toExponential(3);
}

function fmtVol(v: number): string {
  if (!isFinite(v)) return "—";
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(2) + "K";
  return v.toFixed(2);
}

function fmtPct(p: number): string {
  if (!isFinite(p)) return "--";
  return (p >= 0 ? "+" : "") + p.toFixed(2) + "%";
}

function parseAssetInput(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((v) => v.trim().toUpperCase())
    .filter(Boolean);
}


/* ========================================================================== *
 *  Market data fetching
 * ----------------------------------------------------------------------------
 * Uses the unified `fetchMarketData` layer which works in three contexts:
 * Next.js server (fast proxy), Capacitor native shell (direct Binance), and
 * standalone PWA (direct Binance fallback). See src/lib/market-client.ts.
 * ========================================================================== */

/* ========================================================================== *
 *  Signal visual primitives
 * ========================================================================== */

function SignalDot({ state, size = 12 }: { state: SignalState; size?: number }) {
  const color =
    state === "BULLISH"
      ? "bg-emerald-400"
      : state === "BEARISH"
        ? "bg-rose-400"
        : "bg-zinc-500";
  return <span className={`inline-block rounded-full ${color}`} style={{ width: size, height: size }} />;
}

function AssetLogo({ symbol, size = 28 }: { symbol: string; size?: number }) {
  const fallback = (
    <span
      className="flex h-full w-full items-center justify-center rounded-full bg-zinc-800 text-[9px] font-bold text-zinc-300"
      aria-hidden="true"
    >
      {symbol.slice(0, 3)}
    </span>
  );

  return (
    <span className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full" style={{ width: size, height: size }}>
      <TokenIcon symbol={symbol.toLowerCase()} variant="branded" size={size} fallback={fallback} aria-label={`${symbol} logo`} />
    </span>
  );
}

function MasterBadge({ c }: { c: ConfluenceResult }) {
  const { t } = useRsl();
  const map = {
    BULLISH: { cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40", icon: TrendingUp },
    BEARISH: { cls: "bg-rose-500/15 text-rose-300 border-rose-500/40", icon: TrendingDown },
    NEUTRAL: { cls: "bg-zinc-500/15 text-zinc-300 border-zinc-500/40", icon: Minus },
  } as const;
  // "Not enough information" and "no directional edge" are different states.
  // Rendering them identically is how thin-data assets end up looking like
  // opportunities, so suppressed rows get their own badge.
  if (c.suppressed) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800/40 px-2 py-0.5 text-[11px] font-semibold text-zinc-500"
        title={c.warnings.join(" ")}
      >
        <AlertTriangle className="h-3 w-3" />
        {t("sig.noData")}
      </span>
    );
  }
  const { cls, icon: Icon } = map[c.master];
  const strength = t(c.strength === "STRONG" ? "sig.strong" : c.strength === "MODERATE" ? "sig.moderate" : "sig.weak");
  const label =
    c.master === "NEUTRAL"
      ? t("sig.neutral")
      : `${t(c.master === "BULLISH" ? "sig.buy" : "sig.sell")} · ${strength}`;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${cls}`}
      title={c.warnings.join(" ")}
    >
      <Icon className="h-3 w-3" />
      {label}
      {c.lowVolatility && <span className="font-normal text-zinc-300" title="Compressed volatility — strength capped">·lv</span>}
    </span>
  );
}

/**
 * Compact reversal indicator for the table. Shows an arrow + confidence only
 * when a genuine reversal (opposing the current trend) is detected, otherwise
 * a muted dash. Tooltip lists every contributing reversal signal.
 */
function ReversalBadge({ r }: { r: ReversalResult }) {
  const { t } = useRsl();
  if (r.confidence === "NONE" || r.direction === "NONE" || !r.isReversal) {
    return (
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center gap-1 text-xs text-zinc-600">
              <Minus className="h-3 w-3" />
              <span>—</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="border-zinc-700 bg-zinc-900 text-xs">
            <div className="font-semibold text-zinc-300">{r.summary}</div>
            {r.signals.length > 0 && (
              <div className="mt-1 text-zinc-500">{r.upCount} up / {r.downCount} down signals</div>
            )}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  const isUp = r.direction === "UP";
  const toneCls = isUp
    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
    : "bg-rose-500/15 text-rose-300 border-rose-500/40";
  const confLabel =
    r.confidence === "HIGH" ? "HIGH" : r.confidence === "MODERATE" ? "MOD" : "LOW";
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${toneCls}`}>
            {isUp ? <RotateCcw className="h-3 w-3" /> : <RotateCcw className="h-3 w-3 -scale-y-100" />}
            {isUp ? "REV↑" : "REV↓"} {confLabel}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="w-72 p-0 border-zinc-700 bg-zinc-900">
          <div className="px-3 py-2 border-b border-zinc-800 text-xs font-semibold text-zinc-200">
            Reversal Detection · {r.currentTrend}
          </div>
          <div className="px-3 py-1.5 text-[11px] text-zinc-400 border-b border-zinc-800">
            {r.summary}
          </div>
          <div className="px-3 py-1.5 text-[11px] text-zinc-500 border-b border-zinc-800">
            {t("reversal.clueNote")}
          </div>
          <div className="max-h-56 overflow-y-auto p-1">
            {r.signals.map((s, i) => (
              <div key={i} className="flex items-center justify-between gap-2 rounded px-2 py-1 text-xs hover:bg-zinc-800/60">
                <span className="flex items-center gap-2 text-zinc-300">
                  <span className={`inline-block h-2 w-2 rounded-full ${s.direction === "UP" ? "bg-emerald-400" : "bg-rose-400"}`} />
                  {s.name}
                </span>
                <span className="font-mono text-[10px] text-zinc-500">{s.detail}</span>
              </div>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function PatternBadge({ pattern }: { pattern: PatternSignal }) {
  const { t } = useRsl();
  if (pattern.direction === "NONE" || pattern.confidence === "NONE") {
    return (
      <span className="text-[11px] text-zinc-600" title={pattern.matches > 0 && pattern.tooFew ? `${t(patternAbstainKey(pattern))}. ${pattern.summary}` : pattern.summary}>
        {pattern.matches > 0 ? t("pattern.mixed", { n: pattern.matches }) : "—"}
      </span>
    );
  }
  const up = pattern.direction === "UP";
  const tip = t("pattern.badgeTip", {
    h: pattern.horizonBars,
    move: fmtPct(pattern.expectedMovePct),
    sim: Math.round(pattern.averageSimilarity * 100),
  });
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${
        up
          ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-300"
          : "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-300"
      }`}
      title={`${up ? t("pattern.up") : t("pattern.down")} · ${pattern.confidence}. ${pattern.summary} ${tip}`}
    >
      {up ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
      {Math.round(pattern.winRate * 100)}% · {pattern.confidence.slice(0, 3)}
    </span>
  );
}

/** Horizontal 20-cell bar summarising each indicator's state at a glance. */
function IndicatorBar({ c }: { c: ConfluenceResult }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label={`Indicator breakdown: ${c.bull} bullish, ${c.neutral} neutral, ${c.bear} bearish, ${c.excludedCount} excluded`} className="flex h-5 w-full overflow-hidden rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400">
            {c.indicators.map((ind, i) => (
              <div
                key={i}
                title={ind.qualityNote ?? ind.detail}
                className={`flex-1 ${ind.valid === false ? "bg-amber-400/50" :
                  ind.state === "BULLISH"
                    ? "bg-emerald-400/80"
                    : ind.state === "BEARISH"
                      ? "bg-rose-400/80"
                      : "bg-zinc-600/60"
                } ${i > 0 ? "border-l border-zinc-950/60" : ""}`}
              />
            ))}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="w-72 p-0 border-zinc-700 bg-zinc-900">
          <div className="px-3 py-2 border-b border-zinc-800 text-xs font-semibold text-zinc-200">
            Indicator breakdown · 18 voting, 3 context
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            {c.indicators.map((ind, i) => (
              <div key={i} className="flex items-center justify-between gap-2 rounded px-2 py-1 text-xs hover:bg-zinc-800/60">
                <span className="flex items-center gap-2 text-zinc-400">
                  <SignalDot state={ind.state} size={8} />
                  <span className="font-medium text-zinc-300">{ind.name}</span>
                  <span className="text-zinc-600">{ind.category}</span>
                </span>
                <span className="max-w-32 text-right font-mono text-[10px] text-zinc-500">{ind.qualityNote ?? ind.detail}</span>
              </div>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/* ========================================================================== *
 *  Main page component
 * ========================================================================== */

/** Source id → label for the paper simulator's waiting text (M-5); the dialog may not import market-client (R12). */
const SOURCE_LABELS: Record<string, string> = Object.fromEntries(DATA_SOURCES.map((d) => [d.value, d.label]));

export default function Home() {
  const rsl = useRsl();
  const { t, id } = rsl;
  const [aboutOpen, setAboutOpen] = useState(false);
  const loadRef = useRef<() => void>(() => undefined);
  // v2.7 (review #2): what the header currently asks for; detail-sheet actions compare their row with it.
  const currentScanRef = useRef<{ source: DataSource; tf: string }>({ source: DEFAULT_APP_PREFERENCES.dataSource, tf: DEFAULT_APP_PREFERENCES.timeframe });
  useEffect(() => rsl.onMenuAction((menuId) => {
    if (menuId === "about" || menuId === "settings" || menuId.startsWith("backup.")) setAboutOpen(true);
    else if (menuId === "refresh") loadRef.current();
    else if (menuId === "contact") rsl.openExternal(contactMailto({ name: APP.name }, APP.contactSubject));
  }), [rsl]);
  const [timeframe, setTimeframe] = useState<TF>(DEFAULT_APP_PREFERENCES.timeframe);
  const [dataSource, setDataSource] = useState<DataSource>(DEFAULT_APP_PREFERENCES.dataSource);
  const [universeLimit, setUniverseLimit] = useState(DEFAULT_APP_PREFERENCES.universeLimit);
  const [background, setBackground] = useState<BackgroundOption>(DEFAULT_APP_PREFERENCES.background);
  const [scoringProfile, setScoringProfile] = useState<ScoringProfile | null>(null);
  const [profileReady, setProfileReady] = useState(false);
  const [profileFailure, setProfileFailure] = useState("");
  const activeConfigId = engineConfigId(scoringProfile);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [privateApiOpen, setPrivateApiOpen] = useState(false);
  const [privateApiProfile, setPrivateApiProfile] = useState<PrivateApiProfile | null>(null);
  // Gateway session and data-provider profiles (v2.8 Step 4b): memory only, never persisted.
  const [providerLink, setProviderLink] = useState<ProviderLink | null>(null);
  const [fngOpen, setFngOpen] = useFngOpen(); // v2.8 (WP29): Fear & Greed panel, remembered per device
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [scanStats, setScanStats] = useState({ durationMs: 0, errors: 0, stale: 0, newestBarTime: 0 });
  const [monitorDraft, setMonitorDraft] = useState("");
  const [monitorAssets, setMonitorAssets] = useState<string[]>([]);
  const [watchlistScope, setWatchlistScope] = useState<Watchlist | null>(null);
  const [unavailableMembers, setUnavailableMembers] = useState<string[]>([]);
  const [rows, setRows] = useState<AssetRow[]>([]);
  /** v2.8 (WP27): the paper simulator's scan heartbeat — set when a scan completes, live rows only. */
  const [paperRows, setPaperRows] = useState<AssetRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  // v2.6 (WP10): source health line and per-scan currency / Coins.ph extras.
  const [health, setHealth] = useState<(SourceHealth & { source: string }) | null>(null);
  const [paperSlippage, setPaperSlippage] = useState<{ source: string; readings: Record<string, { bps: number; at: number }> }>({ source: "", readings: {} });
  const [scanMeta, setScanMeta] = useState<ScanMeta>({ source: "binance", currency: "USD", premium: {}, thin: [] });
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>(DEFAULT_APP_PREFERENCES.sortKey);
  const [sortDir, setSortDir] = useState<SortDir>(DEFAULT_APP_PREFERENCES.sortDir);
  const [autoRefresh, setAutoRefresh] = useState(DEFAULT_APP_PREFERENCES.autoRefresh);
  const [detailAsset, setDetailAsset] = useState<AssetRow | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [chartDepth, setChartDepth] = useState<StoredChartDepth>(DEFAULT_APP_PREFERENCES.chartDepth);
  const [reversalAlert, setReversalAlert] = useState<AssetRow[]>([]);
  const [assetClass, setAssetClass] = useState<AssetClassFilter>(DEFAULT_APP_PREFERENCES.assetClass);
  // v2.7 (WP12/WP13): stablecoin quote per source, display currency and its rate table.
  const [quoteBySource, setQuoteBySource] = useState<Partial<Record<DataSource, string>>>(DEFAULT_APP_PREFERENCES.quoteBySource);
  const quote = normalizeQuoteMode(dataSource, quoteBySource[dataSource]);
  const [displayPref, setDisplayPref] = useState<string>(DEFAULT_APP_PREFERENCES.displayCurrency);
  const [fx, setFx] = useState<FxTable | null>(null);
  const [fiatList, setFiatList] = useState<FiatCurrency[]>([]);
  // v2.7 (owner request): chosen rate source, automatic updates, the user's own source, and the sources dialog.
  const [fxChoice, setFxChoice] = useState<FxChoice>(DEFAULT_APP_PREFERENCES.fxSource as FxChoice);
  const [fxAutoUpdate, setFxAutoUpdate] = useState<boolean>(DEFAULT_APP_PREFERENCES.fxAutoUpdate);
  const [fxCustom, setFxCustom] = useState<{ name: string; url: string } | null>(DEFAULT_APP_PREFERENCES.fxCustom);
  // v2.8 (WP19): crypto liquidity floor (US$ of 24 h quote volume, the scan's qvUsd; 0 = off). Never display FX (R21).
  const [liquidityFloorUsd, setLiquidityFloorUsd] = useState<number>(DEFAULT_APP_PREFERENCES.liquidityFloorUsd);
  const [fundPulse, setFundPulse] = useState<AppPreferences["fundPulse"]>(DEFAULT_APP_PREFERENCES.fundPulse);
  const [fundRankColumn, setFundRankColumn] = useState<boolean>(DEFAULT_APP_PREFERENCES.fundRankColumn);
  const [recordRadar, setRecordRadar] = useState<boolean>(DEFAULT_APP_PREFERENCES.recordRadar);
  // The scan reads the live setting when it builds rows (the scan runs from a long-lived callback).
  const recordRadarRef = useRef(recordRadar);
  useEffect(() => { recordRadarRef.current = recordRadar; }, [recordRadar]);
  const [fxDialog, setFxDialog] = useState(false);
  const [fxUpdating, setFxUpdating] = useState(false);
  const displayCurrency = displayPref === "AUTO" ? autoCurrency() : displayPref;
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [paperOpen, setPaperOpen] = useState(false);
  const [chartReplay, setChartReplay] = useState(false);
  const [rateLimitUntil, setRateLimitUntil] = useState<number | null>(null);
  // v2.5 (restores build 20261101): "Expand list" hides the control header and informational
  // notes so the asset table gets the screen (mainly for phones). Alerts and the footer stay.
  // Home renders only on the client after boot, so reading storage here is safe; it can throw.
  const [listExpanded, setListExpanded] = useState(() => {
    try { return typeof window !== "undefined" && localStorage.getItem("ct-list-expanded") === "1"; } catch { return false; }
  });
  const toggleListExpanded = () => setListExpanded((v) => {
    const next = !v;
    try { localStorage.setItem("ct-list-expanded", next ? "1" : "0"); } catch { /* session-only */ }
    return next;
  });
  /** Phones (< 640 px): secondary header controls live behind "More controls". */
  const [moreControlsOpen, setMoreControlsOpen] = useState(false);
  const isPhone = useMediaQuery(PHONE_QUERY);
  // The screener is a fixed full-viewport shell; lock document scrolling while it is mounted so
  // nothing (a blank strip, an offset left by an input zoom) can show below the footer.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("ct-shell");
    return () => root.classList.remove("ct-shell");
  }, []);
  // v2.2: in the browser the ledger has its own IndexedDB database, so adding it
  // never forces a version upgrade of the main one (an open older tab would block
  // that upgrade and push identity/preferences to a fallback store).
  const ledgerStore = useMemo(
    () => createLedgerStore(
      rsl.port.kind === "indexeddb"
        ? createIndexedDBAdapter({ dbName: "rsl-conf-ledger", collections: ["ledger", "ledger_meta"] }).catch(() => rsl.port)
        : rsl.port,
    ),
    [rsl.port],
  );
  // v2.3: paper trading (simulated only — no order path exists). Own IndexedDB
  // database in the browser; the main database does not declare its collections.
  const paperStore = useMemo(
    () => createPaperStore(
      rsl.port.kind === "indexeddb"
        ? createIndexedDBAdapter({ dbName: PAPER_DB_NAME, collections: [...PAPER_COLLECTIONS] }).catch(() => memoryPaperPort())
        : rsl.port,
    ),
    [rsl.port],
  );
  /** Stored-history length per series, so a scan asks for 1,000 bars only when the engine window is not yet covered. */
  const historyLenRef = useRef<Map<string, { len: number; newest: number }>>(new Map());
  /** Newest bar already handed to the ledger per series (this session), so catch-up only scores new holes. */
  const lastRecordedRef = useRef<Map<string, number>>(new Map());
  /** v2.3: last order-book depth sample per source (once per 24 h, top 10 pairs). */
  const depthSampledRef = useRef<Map<string, number>>(new Map());
  const abortRef = useRef<AbortController | null>(null);
  /** v2.8 (WP27): view (source|tf|class|quote) of the rows on screen, and those rows, for in-place rescans. */
  const shownRef = useRef<{ key: string | null; rows: AssetRow[] }>({ key: null, rows: [] });
  /** v2.8 (WP27): other-timeframe series of the priority rows (`src:tf:symbol`, display only). */
  const seriesCacheRef = useRef<SeriesCache>(new Map());
  const historyAbortRef = useRef<AbortController | null>(null);
  /** v2.8 (WP21): Fund trend per `source|symbol`, filled by the daily-bar feed that runs behind a finished scan (no display yet). */
  const [fundTrends, setFundTrends] = useState<Map<string, FundTrendState>>(new Map());
  const fundPendingRef = useRef<Map<string, FundTrendState>>(new Map());
  const fundAbortRef = useRef<AbortController | null>(null);
  /**
   * v2.8 (WP21): the detail sheet loads daily bars ONLY while the opt-in ribbon or panel is on (nothing at rest),
   * from the row's own source (cached once per UTC day), and aborts on close, symbol change or toggle off.
   */
  const chartOptIn = useChartOptIn();
  const detailFundWanted = chartOptIn.has("fund-ribbon") || chartOptIn.has("fund-panel");
  const detailFundKey = detailAsset && isFundTrendClass(detailAsset.assetClass) && detailFundWanted && usesDirectFetch()
    ? `${detailAsset.src}|${detailAsset.pair}` : null;
  const [detailDaily, setDetailDaily] = useState<{ key: string; bars: Kline[] | null } | null>(null);
  useEffect(() => {
    if (!detailFundKey) return;
    const [src, pair] = [detailFundKey.slice(0, detailFundKey.indexOf("|")), detailFundKey.slice(detailFundKey.indexOf("|") + 1)];
    const ac = new AbortController();
    loadDailyBars(src as DataSource, pair, Date.now(), ac.signal).then(
      (bars) => { if (!ac.signal.aborted) setDetailDaily({ key: detailFundKey, bars }); },
      () => { if (!ac.signal.aborted) setDetailDaily({ key: detailFundKey, bars: null }); },
    );
    return () => ac.abort();
  }, [detailFundKey]);
  const detailFund = useMemo(() => {
    if (!detailAsset || !detailFundWanted) return null;
    if (!isFundTrendClass(detailAsset.assetClass)) return { series: undefined, size: undefined, note: "ft.na" as const };
    if (!detailFundKey || detailDaily?.key !== detailFundKey) return { series: undefined, size: undefined, note: null }; // loading: pass nothing
    // A failed load (network, or a venue cooldown) says so once; there is no automatic retry. Reopening the sheet tries again.
    if (!detailDaily.bars) return { series: undefined, size: undefined, note: "ft.unavailable" as const };
    const ms = INTERVAL_MS[detailAsset.tf];
    const full = fundTrendSeriesFull(detailDaily.bars, detailAsset.klines.map((k) => ({ time: k.time, closeTime: barCloseTime(k.time, ms) })));
    const series = full.map((f) => f?.value ?? null);
    return { series, size: full.map((f) => f?.size ?? null), note: series.every((v) => v == null) ? "ft.notEnough" as const : null };
  }, [detailAsset, detailFundWanted, detailFundKey, detailDaily]);

  /**
   * v2.8 (WP21): the panel's per-bar Confluence score. Only while the opt-in panel is on, for the bars in view (at most 300)
   * that have a full 1,000-bar window; ledger rows (same cfg, wb = 1,000) first, then the scan worker (never the main thread).
   * With fewer than 1,299 contiguous bars held, the missing older bars are fetched ONCE per series (one history page).
   */
  const detailPanelOn = chartOptIn.has("fund-panel");
  // Per-bar scores also feed the disagreement hatching, which shows with the ribbon OR the panel.
  const detailScoresOn = detailPanelOn || chartOptIn.has("fund-ribbon");
  // The Confluence line is the list's score for every asset class; only Fund trend / size / rank are crypto-only.
  const panelSeriesKey = detailAsset && detailScoresOn ? `${detailAsset.src}|${detailAsset.tf}|${detailAsset.pair}` : null;
  const panelLastBar = detailAsset?.klines.at(-1)?.time ?? 0;
  const panelOlderRef = useRef<Map<string, Kline[]>>(new Map());
  const [panelOlderVer, setPanelOlderVer] = useState(0);
  const [panelRange, setPanelRange] = useState<{ from: number; to: number } | null>(null);
  const [panelResult, setPanelResult] = useState<{ key: string; scores: PanelScoreMap; scored: number; total: number; capped: boolean; shortHistory: boolean } | null>(null);
  const onPanelRange = useCallback((from: number, to: number) => setPanelRange((cur) => (cur && cur.from === from && cur.to === to ? cur : { from, to })), []);
  // The older-bars guard is the series key alone (source|tf|pair): a growing series never aborts and re-sends it, so it is ONE request.
  const panelHeldRef = useRef({ count: 0, first: 0 });
  useEffect(() => { panelHeldRef.current = { count: detailAsset?.klines.length ?? 0, first: detailAsset?.klines[0]?.time ?? 0 }; });
  useEffect(() => {
    const held = panelHeldRef.current;
    if (!panelSeriesKey || !detailAsset || held.count >= panelBarsNeeded(PANEL_MAX_BARS) || panelOlderRef.current.has(panelSeriesKey)) return;
    const [src, tf, pair] = [detailAsset.src, detailAsset.tf, detailAsset.pair];
    const ac = new AbortController();
    void (async () => {
      const stored = await loadOlderOnce(panelOlderRef.current, panelSeriesKey, async () => {
        // One history page at most (1,000 bars) on both paths; fetchHistory itself never goes below 200.
        const limit = Math.min(1000, Math.max(200, panelBarsNeeded(PANEL_MAX_BARS) - held.count));
        const endTime = held.first - 1;
        if (usesDirectFetch()) return (await fetchHistory(src, pair, tf, limit, endTime, ac.signal)).klines; // asserts the venue cooldown (RateLimitError, no request sent)
        const qs = new URLSearchParams({ source: src, interval: tf, symbol: pair, limit: String(limit), endTime: String(endTime) });
        const response = await fetch(`/api/market/history?${qs.toString()}`, { cache: "no-store", signal: ac.signal });
        if (response.status === 429) throw new RateLimitError("Exchange rate limit", 0); // refused by the venue: not the one attempt
        const payload = await response.json() as { klines?: Kline[] };
        return response.ok && payload.klines ? payload.klines : [];
      }, ac.signal);
      if (stored) setPanelOlderVer((n) => n + 1);
    })();
    return () => ac.abort();
  }, [panelSeriesKey]);
  useEffect(() => {
    if (!panelSeriesKey || !detailAsset || !panelRange) return; // a stale result is ignored by its key
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const base = detailAsset.klines;
        const older = panelOlderRef.current.get(panelSeriesKey);
        const ext = older?.length ? contiguousTail(mergeKlines(older, base), INTERVAL_MS[detailAsset.tf]) : base;
        const off = ext.length - base.length;
        const from = Math.max(0, panelRange.from + off), to = Math.min(ext.length, panelRange.to + off);
        const cacheKey = panelCacheKey(detailAsset.src, detailAsset.tf, detailAsset.pair, panelLastBar, activeConfigId);
        const cache = panelCacheFor(cacheKey);
        const wanted: number[] = [];
        for (let j = Math.max(from, to - PANEL_MAX_BARS); j < to; j++) if (j + 1 >= ENGINE_BARS && !cache.has(ext[j].time)) wanted.push(ext[j].time);
        let known = new Map<number, number>();
        if (wanted.length) {
          try { known = await ledgerStore.seriesScores(detailAsset.src, detailAsset.tf, detailAsset.pair, activeConfigId, wanted, ENGINE_BARS); } catch { /* no ledger: the worker scores them */ }
        }
        if (cancelled) return;
        const jobBase = { key: panelSeriesKey, intervalMs: INTERVAL_MS[detailAsset.tf], volumeAvailable: true, assetClass: detailAsset.assetClass, profile: scoringProfile };
        const res = await resolvePanelScores({ klines: ext, from, to, cache, known, run: (end, count, kn) => runPanelScores(jobBase, ext.slice(0, end), count, kn) });
        if (!cancelled) setPanelResult({ key: panelSeriesKey, scores: res.scores, scored: res.scored, total: res.total, capped: res.capped, shortHistory: res.shortHistory });
      })();
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [panelSeriesKey, panelRange, panelLastBar, panelOlderVer, detailAsset, activeConfigId, ledgerStore, scoringProfile]);
  const panelNote = useMemo(() => {
    if (!panelSeriesKey || !panelResult || panelResult.key !== panelSeriesKey || panelResult.scored >= panelResult.total) return undefined;
    // M = bars in view, N = bars with a score. Short history (some of the newest 300 lack a full window) wins over the cap note.
    return t(panelResult.shortHistory ? "ft.panelNote" : "ft.panelCapped", { n: panelResult.scored, m: panelResult.total });
  }, [panelSeriesKey, panelResult, t]);
  /** Fund rank across the scan's crypto rows of this source (the feed's values; ties share a rank). */
  const detailFundRank = useMemo(() => {
    if (!detailAsset || !detailPanelOn || !isFundTrendClass(detailAsset.assetClass)) return undefined;
    const { ranks, n } = fundRanks(rows, fundTrends, detailAsset.src);
    const rank = ranks.get(detailAsset.pair);
    return rank === undefined ? undefined : t("ft.rank", { rank, n });
  }, [detailAsset, detailPanelOn, rows, fundTrends, t]);
  /** v2.8 (WP21): Fund rank per pair for the optional list column (same computation as the panel header). */
  const listFundRanks = useMemo(() => (fundRankColumn ? fundRanks(rows, fundTrends, dataSource).ranks : null), [fundRankColumn, rows, fundTrends, dataSource]);
  const listRibbonOn = chartOptIn.has("fund-ribbon");
  // "Keep pulsing" ends for a coin once its detail sheet is opened.
  useEffect(() => { if (detailAsset) pulseLedger.stopPair(`${detailAsset.src}|${detailAsset.pair}`); }, [detailAsset]);
  /** v2.8 (WP21): one daily-bar run at a time (post-scan feed and catch-up share it), so concurrency stays 2 in total. */
  const fundQueueRef = useRef(createSerialQueue());
  const alertedReversalRef = useRef<Map<string, number>>(new Map());

  // v2.5: theme preference (System / Light / Dark) → resolved theme → tokens on <html data-theme>.
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const themePref: ThemePref = migrateThemePref({ background }, null);
  const resolvedTheme = resolveTheme(themePref, systemDark, cssSupportsColorMix());
  const applyBackground = useCallback((value: BackgroundOption) => {
    setBackground(value);
    try {
      localStorage.setItem(THEME_PREF_KEY, migrateThemePref({ background: value }, null));
      localStorage.removeItem("ct-theme");
    } catch {
      // Theme still works for the current session when storage is unavailable.
    }
  }, []);
  useEffect(() => {
    if (!preferencesReady) return;
    applyTheme(resolvedTheme, rsl.adapters.theme, themePref);
  }, [resolvedTheme, themePref, preferencesReady, rsl.adapters.theme]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const saved = loadAppPreferences();
      if (saved) {
        setTimeframe(saved.timeframe);
        setDataSource(saved.dataSource);
        setUniverseLimit(saved.universeLimit);
        setMonitorAssets(saved.monitorAssets);
        setMonitorDraft(saved.monitorAssets.join(", "));
        setSortKey(saved.sortKey);
        setSortDir(saved.sortDir);
        setAutoRefresh(saved.autoRefresh);
        setChartDepth(saved.chartDepth);
        setAssetClass(saved.assetClass);
        setQuoteBySource(saved.quoteBySource);
        setDisplayPref(saved.displayCurrency);
        setFxChoice(saved.fxSource as FxChoice);
        setFxAutoUpdate(saved.fxAutoUpdate);
        setFxCustom(saved.fxCustom);
        setLiquidityFloorUsd(saved.liquidityFloorUsd);
        setFundPulse(saved.fundPulse);
        setFundRankColumn(saved.fundRankColumn);
        setRecordRadar(saved.recordRadar);
        applyBackground(saved.background);
      } else {
        let legacy: string | null = null;
        try {
          legacy = localStorage.getItem(THEME_PREF_KEY) ?? localStorage.getItem("ct-theme");
        } catch {}
        applyBackground(toStoredBackground(migrateThemePref(legacy === "system" || legacy === "dark" || legacy === "light" ? { background: legacy } : null, legacy)));
      }
      setPreferencesReady(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [applyBackground]);

  useEffect(() => {
    if (!preferencesReady) return;
    const preferences: AppPreferences = {
      timeframe,
      dataSource,
      universeLimit,
      background,
      monitorAssets,
      sortKey,
      sortDir,
      autoRefresh,
      chartDepth,
      assetClass,
      quoteBySource,
      displayCurrency: displayPref,
      fxSource: fxChoice,
      fxAutoUpdate,
      fxCustom,
      liquidityFloorUsd,
      fundPulse,
      fundRankColumn,
      recordRadar,
    };
    saveAppPreferences(preferences);
  }, [preferencesReady, timeframe, dataSource, universeLimit, background, monitorAssets, sortKey, sortDir, autoRefresh, chartDepth, assetClass, quoteBySource, displayPref, fxChoice, fxAutoUpdate, fxCustom, liquidityFloorUsd, fundPulse, fundRankColumn, recordRadar]);

  // v2.7 (WP13): display-currency rates — from the chosen source, cached on the device, refreshed every 6 h
  // while "Update automatically" is on, or on "Update now". Display only: the scan never sees them.
  const scanCurrency = scanMeta.currency;
  useEffect(() => {
    if (!preferencesReady) return;
    let active = true;
    const cached = cachedTable(fxChoice);
    const cachedList = cachedCurrencies();
    // Review v2.7 #2: also when the scan's own currency is not USD (Coins.ph PHP, EUR stablecoins).
    const needed = () => displayCurrency !== "USD" || scanCurrency !== "USD" || !!cached;
    const run = () => {
      if (!needed()) return;
      void refreshRates({ choice: fxChoice }).then((table) => { if (active) setFx(table); });
      void loadCurrencies().then((list) => { if (active) setFiatList(list); });
    };
    const first = window.setTimeout(() => {
      setFx(cached);
      if (cachedList.length) setFiatList(cachedList);
      run();
    }, 0);
    const id = fxAutoUpdate ? window.setInterval(run, 6 * 3_600_000) : undefined;
    return () => { active = false; window.clearTimeout(first); if (id) window.clearInterval(id); };
  }, [preferencesReady, displayCurrency, scanCurrency, fxChoice, fxAutoUpdate]);
  const updateRatesNow = useCallback(async () => {
    setFxUpdating(true);
    try { setFx(await refreshRates({ choice: fxChoice, force: true })); } finally { setFxUpdating(false); }
  }, [fxChoice]);
  /**
   * Load the full universe in a single request. The server returns tickers +
   * all klines (throttled & cached upstream), then we run the 21-indicator
   * confluence engine client-side for each asset.
   */
  useEffect(() => {
    let active = true;
    void rsl.port.get("preferences", "scoring-profile-v1").then((value) => {
      const profile = normalizeScoringProfile(value);
      if (active) { setScoringProfile(profile); setProfileReady(true); }
    }).catch(() => {
      if (active) setProfileFailure("Saved scoring profile could not be loaded. Restore default to resume scanning.");
    });
    return () => { active = false; };
  }, [rsl.port]);

  async function applyScoringProfile(value: ScoringProfile | null) {
    const profile = normalizeScoringProfile(value);
    await rsl.port.put("preferences", "scoring-profile-v1", profile);
    if (profileReady && engineConfigId(profile) === activeConfigId) return;
    historyAbortRef.current?.abort();
    setHistoryLoading(false);
    abortRef.current?.abort();
    setDetailAsset(null);
    setRows([]);
    setPaperRows([]);
    shownRef.current = { key: null, rows: [] };
    setScoringProfile(profile);
    setProfileFailure("");
    setProfileReady(true);
  }

  const load = useCallback(async (tf: TF, source: DataSource, assets: string[], limit: number, cls: AssetClassFilter, quoteMode: string) => {
    if (!profileReady) return;
    abortRef.current?.abort();
    fundAbortRef.current?.abort(); // a new scan stops the daily-bar feed of the previous one
    const ac = new AbortController();
    abortRef.current = ac;
    // v2.8 (WP21): this scan's daily-bar feed (post-scan feed and catch-up) stops with the scan; `feedSettled` releases the live ledger write.
    const feed = new AbortController();
    fundAbortRef.current = feed;
    ac.signal.addEventListener("abort", () => feed.abort(), { once: true });
    let resolveFeed: () => void = () => undefined;
    const feedSettled = new Promise<void>((resolve) => { resolveFeed = resolve; });
    setLoading(true);
    setError(null);
    setProgress({ done: 0, total: 1 });
    setUnavailableMembers([]);
    // v2.8 (WP27): a view is source × timeframe × class × quote. A rescan of the same view keeps its rows
    // and refreshes them in place; a new view starts empty, so no row of the old one is ever mixed in.
    const view = `${source}|${tf}|${cls}|${normalizeQuoteMode(source, quoteMode)}`;
    const listKey = `${source}|${cls}|${normalizeQuoteMode(source, quoteMode)}|${limit}|${assets.join(",")}|${watchlistScope?.symbols.join(",") ?? ""}`;
    const newView = shownRef.current.key !== view;
    const session = new ProgressiveRows<AssetRow>(view, initialRows(shownRef.current, view));
    shownRef.current = { key: view, rows: session.rows() };
    if (newView) setRows([]);
    const scanProgress = { done: 0, total: 1 };
    let listMeta: ListMeta | null = null;
    let metaStage = 0; // new view: 0 = previous view's meta, 1 = currency only, 2 = list metadata
    let completed = false;
    const flush = () => {
      if (ac.signal.aborted) return;
      const shown = session.rows();
      shownRef.current = { key: view, rows: shown };
      setRows(shown);
      setProgress({ ...scanProgress });
      // Currency etc. change with the rows they describe: a new view's first rows bring its own currency.
      // History rows before the list arrives get the view's currency; the list's own metadata follows
      // (premium, which needs one more request, when the scan completes).
      const lm = listMeta;
      if (newView && shown.length && lm && metaStage < 2) {
        metaStage = 2;
        setScanMeta({
          source, currency: lm.priceCurrency ?? "USD", premium: {}, thin: lm.thinSymbols ?? [], thinFloorUsd: lm.thinFloorUsd,
          tf, quote: lm.quote, quoteBySymbol: lm.quoteBySymbol, quoteCounts: lm.quoteCounts, approx: lm.approxVolume, depeg: lm.depeg, depegAt: Date.now(), usdPhp: lm.usdPhp,
          unknownVolume: lm.unknownVolumeSymbols,
        });
      } else if (newView && shown.length && !lm && metaStage < 1) {
        metaStage = 1;
        const q = normalizeQuoteMode(source, quoteMode);
        setScanMeta({ source, currency: priceCurrencyOf(source, q), premium: {}, thin: [], tf, quote: q });
      }
      setDetailAsset((current) => (current ? session.get(current.pair) ?? current : null));
    };
    const batcher = createBatcher(flush, UI_BATCH_MS);
    ac.signal.addEventListener("abort", () => batcher.cancel(), { once: true });
    try {
      if (watchlistScope && (!watchlistScope.symbols.length || watchlistScope.source !== source)) {
        setRows([]);
        shownRef.current = { key: view, rows: [] };
        setDetailAsset(null);
        setUnavailableMembers(watchlistScope.symbols);
        return;
      }
      const intervalMs = INTERVAL_MS[tf];
      const inScope = (symbol: string) => !watchlistScope || watchlistScope.symbols.includes(symbol);
      const classOf = (symbol: string): AssetClass => {
        const c = classifySymbol(source, symbol, venueTypeOf(source, symbol));
        return c === "excluded" ? "crypto" : c;
      };
      type Ticker = { rank: number; symbol: string; lastPrice: string; priceChangePercent: string; quoteVolume: string };
      const rowOf = (t: Ticker, kl: Kline[], res: { score: { confluence: ConfluenceResult; reversal: ReversalResult }; pattern: PatternSignal }, freshness: Freshness, priceFromBars = false): AssetRow => {
        const assetCls = classOf(t.symbol);
        return {
          rank: t.rank,
          symbol: pairBase(t.symbol, source), // v2.7: any quote (BTCUSDC → BTC)
          pair: t.symbol,
          src: source,
          tf,
          price: priceFromBars && kl.length ? kl[kl.length - 1].close : parseFloat(t.lastPrice),
          change24h: parseFloat(t.priceChangePercent),
          quoteVolume: parseFloat(t.quoteVolume),
          confluence: res.score.confluence,
          reversal: res.score.reversal,
          pattern: res.pattern,
          klines: kl,
          assetClass: assetCls,
          underlyingClosed: kl.length > 0 && barWhileClosed(assetCls, kl[kl.length - 1].time, intervalMs),
          freshness,
        };
      };
      const jobOf = (symbol: string, kl: Kline[]): ScanJob => ({
        key: `${source}:${tf}:${symbol}`,
        packed: packKlines(kl),
        intervalMs,
        // v2.3 (review C11): volume usability is decided by scoreSeries on the
        // scored window itself (as replay and the recorder do), not by a flag
        // computed on today's fetch — identical rows for the same bar everywhere.
        volumeAvailable: true,
        assetClass: classOf(symbol),
        profile: scoringProfile,
      });

      // 0 — instant start (WP27): rows from on-device history, marked "updating" (display only), for a new view.
      const remembered = rememberedTickers(listKey).filter((t) => inScope(t.symbol));
      const stored = await loadStoredSeries(source, tf, remembered.map((t) => t.symbol));
      if (ac.signal.aborted) return;
      if (newView && remembered.length) {
        void (async () => {
          const todo = remembered.map((t) => ({ t, kl: contiguousTail(displaySeries(seriesCacheRef.current, source, tf, t.symbol, stored), intervalMs) }))
            .filter((x) => x.kl.length > 1 && !session.get(x.t.symbol));
          for (let i = 0; i < todo.length && !ac.signal.aborted && !completed; i += 10) {
            const chunk = todo.slice(i, i + 10);
            const results = await runScanJobs(chunk.map((x) => ({ ...jobOf(x.t.symbol, x.kl), displayOnly: true })));
            if (ac.signal.aborted || completed) return;
            chunk.forEach((x, j) => { const r = results[j]; if (r && !r.error) session.put(rowOf(x.t, x.kl, r, "updating", true)); });
            batcher.schedule();
          }
        })().catch(() => undefined);
      }

      // 1 — fetch tier by tier; each fresh series is merged with stored bars and scored as it arrives.
      const tickerOf = new Map<string, Ticker>();
      const preparedLive = new Map<string, Kline[]>();
      const scoredLive = new Map<string, ScanJobResult>();
      const discarded = new Set<string>();
      const pendingWork: Promise<void>[] = [];
      const onSeries = (symbol: string, recent: Kline[]) => {
        if (ac.signal.aborted || !inScope(symbol)) return;
        pendingWork.push((async () => {
          const discard = discarded.has(symbol);
          let saved: Kline[] = stored.get(symbol) ?? [];
          if (!discard && !stored.has(symbol)) {
            try { saved = await loadHistoricalSeries(source, tf, symbol); } catch { /* blocked store: fresh bars only */ }
          }
          // Build 2.02: keep only the newest gap-free run, so stored and fresh
          // bars are never scored as one series across a hole. A revised delta overlap discards the stored series.
          const kl = contiguousTail(discard ? recent : mergeKlines(saved, recent), intervalMs);
          void saveHistoricalSeries(source, tf, symbol, recent, discard).catch(() => undefined);
          if (kl.length) historyLenRef.current.set(`${source}:${tf}:${symbol}`, { len: kl.length, newest: kl[kl.length - 1].time });
          preparedLive.set(symbol, kl);
          const [res] = await runScanJobs([jobOf(symbol, kl)]);
          if (ac.signal.aborted || !res) return;
          scoredLive.set(symbol, res);
          const ticker = tickerOf.get(symbol);
          if (ticker && !res.error) { session.put(rowOf(ticker, kl, res, "live")); batcher.schedule(); }
        })().catch(() => undefined));
      };
      const data = await fetchMarketData(tf, {
        source,
        assets: watchlistScope?.symbols ?? assets,
        limit: watchlistScope ? watchlistScope.symbols.length : limit,
        signal: ac.signal,
        assetClass: watchlistScope ? "all" : cls,
        quote: quoteMode,
        liquidityFloorUsd,
        // Warm start (v2.1.1): ask for the full engine window only when this
        // session has not yet seen ENGINE_BARS contiguous bars for the series.
        klineLimit: (symbol) => {
          const h = historyLenRef.current.get(`${source}:${tf}:${symbol}`);
          return h && h.len >= ENGINE_BARS && Date.now() - h.newest < intervalMs * 150 ? 200 : 1000;
        },
        // v2.8 (WP27): delta fetch from the stored history; priority: the watch list, else the top 10 by volume.
        delta: (symbol) => { const st = stored.get(symbol); return st ? deltaPlan(st, intervalMs, Date.now()) : null; },
        mergeDelta: (symbol, fresh, ov) => {
          const m = mergeDelta(stored.get(symbol) ?? [], fresh, ov);
          if (!m) discarded.add(symbol);
          return m;
        },
        priority: watchlistScope?.symbols,
        onTickers: (list, meta) => { for (const t of list) tickerOf.set(t.symbol, t); listMeta = meta; },
        onProgress: (done, total) => { scanProgress.done = done; scanProgress.total = Math.max(1, total); batcher.schedule(); },
        onSeries,
      });
      await Promise.all(pendingWork);
      completed = true;
      if (ac.signal.aborted) return;
      batcher.cancel();
      setRateLimitUntil(data.rateLimitedUntil ?? null);
      setHealth({ source, ...healthFromScan(source, data, Date.now(), inNativeShell()) });

      // 2 — the chosen list is complete: assemble it exactly as a full scan (stored + fresh bars per series).
      const scopedTickers = watchlistScope
        ? data.tickers.filter((ticker) => watchlistScope.symbols.includes(ticker.symbol))
        : data.tickers;
      if (watchlistScope) {
        const available = new Set(scopedTickers.map((ticker) => ticker.symbol));
        setUnavailableMembers(watchlistScope.symbols.filter((symbol) => !available.has(symbol)));
      }
      const prepared = await Promise.all(scopedTickers.map(async (t) => {
        const live = preparedLive.get(t.symbol);
        if (live) return { t, kl: live, fresh: true, failure: "no fresh candles" };
        // Server-proxy builds (no onSeries) and series whose fetch failed this scan.
        const recent = data.klines[t.symbol] ?? [];
        let saved: Kline[] = stored.get(t.symbol) ?? [];
        if (!stored.has(t.symbol)) {
          try {
            saved = await loadHistoricalSeries(source, tf, t.symbol);
          } catch {
            // A blocked/private browser store must not break live scanning.
          }
        }
        const kl = contiguousTail(mergeKlines(saved, recent), data.intervalMs);
        if (recent.length) {
          void saveHistoricalSeries(source, tf, t.symbol, recent).catch(() => undefined);
        }
        if (kl.length) historyLenRef.current.set(`${source}:${tf}:${t.symbol}`, { len: kl.length, newest: kl[kl.length - 1].time });
        // v2.2 review fix: a symbol whose fetch failed this scan (stale feed,
        // HTTP error, rate-limit skip) must not be scored from cached history
        // and presented — or recorded — as a live signal.
        const failure = recent.length ? null : data.errors.find((e) => e.symbol === t.symbol);
        return { t, kl, fresh: recent.length > 0, failure: failure ? `${failure.reason}: ${failure.message}` : "no fresh candles" };
      }));
      if (ac.signal.aborted) return;

      // 3 — score what was not scored progressively (off the main thread, same fixed window as the ledger and replay).
      const jobs: ScanJob[] = prepared.filter((p) => p.fresh && !scoredLive.has(p.t.symbol)).map(({ t, kl }) => jobOf(t.symbol, kl));
      const results = await runScanJobs(jobs);
      if (ac.signal.aborted) return;
      const byKey = new Map(results.map((res) => [res.key, res]));
      for (const [symbol, res] of scoredLive) byKey.set(`${source}:${tf}:${symbol}`, res);

      // v2.3: rows are assembled by lib/scan-record.ts — the same code the
      // headless recorder uses — with the logged context fields (never scored).
      const seriesOf = (t: (typeof prepared)[number]["t"], kl: Kline[]): ScanSeries => ({
        symbol: t.symbol, rank: t.rank, quoteVolume: parseFloat(t.quoteVolume) || 0, ac: classOf(t.symbol), kl,
      });
      // v2.8 (WP19): fr / oiChg only from recorder snapshots the owner imported (derivatives panel); otherwise null.
      let derivatives: DerivativeSnapshot[] = [];
      try {
        const saved = await rsl.port.get("preferences", "bybit-derivatives-v1");
        if (Array.isArray(saved)) derivatives = saved as DerivativeSnapshot[];
      } catch { /* no imported snapshots */ }
      // v2.8 (WP25): the radar context log, only while "Record radar context" is on (otherwise rad is null on every row).
      // The log is the per-device one the radar runner writes every 5 min; each row takes its newest entry at or before its own close.
      let radar: RadarContext[] = [];
      if (recordRadarRef.current) {
        try { radar = await loadRadarLog(rsl.port, Date.now()); } catch { /* no log: rad null */ }
      }
      const recordCtx: ScanRecordContext = {
        src: source, tf, intervalMs: data.intervalMs, appVersion: APP.version,
        universe: data.universe, basisBySymbol: data.basisBySymbol,
        ...(derivatives.length ? { derivatives } : {}),
        ...(recordRadarRef.current ? { radar } : {}),
      };
      // Cross-sectional fields (RS percentile, BTC beta, universe rank) once the chosen list is complete, as in a full scan.
      const shared = scanShared(prepared.filter((p) => p.fresh && p.kl.length).map((p) => seriesOf(p.t, p.kl)), data.universe);
      const scoredOf = new Map<string, { t: (typeof prepared)[number]["t"]; res: Pick<ScanJobResult, "score" | "pattern"> }>();
      const out: AssetRow[] = prepared.map(({ t, kl, fresh, failure }) => {
        const scored = byKey.get(`${source}:${tf}:${t.symbol}`);
        const res = scored && !scored.error
          ? scored
          : {
              score: { usable: false, warmBars: 0, confluence: suppressedConfluence(`Feed unavailable this scan (${scored?.error ?? failure}) — not scored, not recorded.`), reversal: emptyReversal() },
              pattern: emptySignal("Feed unavailable"),
            };
        scoredOf.set(t.symbol, { t, res: res as Pick<ScanJobResult, "score" | "pattern"> });
        // A row whose fetch failed this scan is display-only: "not updated" with its bar time.
        return rowOf(t, kl, res, fresh ? "live" : "stale");
      });
      // 4 — forward-test ledger: one row per live series per closed bar (idempotent).
      const ledgerRows: LedgerRow[] = recordable(out, (row) => {
        const x = scoredOf.get(row.pair);
        if (!x || !x.res.score.usable || !row.klines.length) return null;
        // v2.8 (WP19): the row logs this scan's Pattern output (pd / pc).
        const lr = liveRow({ ...seriesOf(x.t, row.klines), pattern: x.res.pattern }, x.res.score as SeriesScore, recordCtx, shared);
        if (lr) row.context = lr;
        return lr;
      });
      const newestClosed = prepared.reduce((m, p) => (p.fresh && p.kl.length ? Math.max(m, p.kl[p.kl.length - 1].time) : m), 0);
      // v2.8 (WP21): crypto rows wait for this scan's Fund trend feed (<= 90 s; an abort writes at once) so ft is not lost for good; others write at once.
      const universeSnap = data.universe ? { t: newestClosed, list: data.universe } : undefined;
      const liveWrite = ledgerRows.length
        ? writeLiveRows(ledgerRows, {
            write: (rs) => ledgerStore.record(rs, universeSnap).catch(() => 0),
            settled: feedSettled,
            signal: feed.signal,
            // ft as of each row's OWN bar close (the catch-up rule: daily bars closed at or before it, 36 h staleness), never the value now.
            ...(usesDirectFetch() ? { dailyOf: (symbol: string) => cachedDailyBars(source, symbol) } : {}),
          }).catch(() => 0)
        : Promise.resolve(0);

      // Catch-up (v2.3: per-series cursors): score bars that closed while the
      // app was shut (up to 48 per series, full 1,000-bar windows only) in the
      // background worker. Each pair resumes from ITS own last recorded bar.
      // A pair with no cursor yet starts forward from now — back-filling bars
      // from before it entered the scan would add selection look-ahead
      // (review C6). Catch-up rows carry today's rank (rank_source "now").
      if (scanMode() === "worker" && newestClosed > 0) {
        void (async () => {
          const cursors = await ledgerStore.seriesCursors(source, tf, scoringProfile ? activeConfigId : undefined);
          const fresh = prepared.filter((p) => p.fresh && p.kl.length > 1);
          const jobs = fresh.map(({ t, kl }) => {
            const key = `${activeConfigId}|${source}:${tf}:${t.symbol}`;
            const known = cursors[t.symbol] ?? lastRecordedRef.current.get(key);
            const since = Math.max(cursors[t.symbol] ?? 0, lastRecordedRef.current.get(key) ?? 0);
            const job: ScanJob = {
              key,
              packed: packKlines(kl),
              intervalMs: data.intervalMs,
              volumeAvailable: true,
              assetClass: classOf(t.symbol),
              profile: scoringProfile,
              catchUp: { since, max: 48, ctx: catchUpContext(seriesOf(t, kl), recordCtx, shared) },
            };
            return { job, kl, key, pair: t.symbol, pending: known !== undefined && since < kl[kl.length - 2].time };
          });
          const pending = jobs.filter((j) => j.pending);
          const done: Record<string, number> = {};
          for (const j of jobs) if (!j.pending) done[j.pair] = j.kl[j.kl.length - 1].time;
          if (pending.length) {
            const res = await runScanJobs(pending.map((j) => j.job), { allowMainThread: false });
            const byKey = new Map(res.map((x) => [x.key, x]));
            const rowsToAdd: LedgerRow[] = [];
            // v2.8 (WP21): catch-up rows log ft from the daily bars closed before each bar (same feed: one request per pair per UTC day, venue gates, 429 halt; a halt leaves ft null).
            let catchUpCtx = recordCtx;
            if (usesDirectFetch()) {
              try {
                const cryptoRows = pending.filter((j) => classOf(j.pair) === "crypto").map((j) => ({ symbol: j.pair, ac: "crypto" as const }));
                // Same queue and abort signal as the post-scan feed: never two runs at once, and a new scan or source switch stops it.
                if (cryptoRows.length) await fundQueueRef.current.enqueue(() => loadFundTrends(source, cryptoRows, Date.now(), { signal: feed.signal }), feed.signal);
              } catch { /* aborted, halted or unavailable: those rows log ft null (still written) */ }
              catchUpCtx = { ...recordCtx, dailyOf: (symbol) => cachedDailyBars(source, symbol) };
            }
            for (const j of pending) {
              const r = byKey.get(j.job.key);
              if (!r || r.error) continue; // cursor not advanced: retried next scan (review C5)
              rowsToAdd.push(...enrichCatchUp(r.catchUpRows ?? [], j.kl, catchUpCtx, shared));
              if (r.gap) void ledgerStore.addGap(source, tf, j.pair, r.gap);
              done[j.pair] = j.kl[j.kl.length - 1].time;
            }
            if (rowsToAdd.length) await ledgerStore.record(rowsToAdd);
          }
          await liveWrite;
          // Storage full: nothing was written, so nothing may be marked as recorded.
          if (ledgerStore.isFull()) return;
          for (const j of jobs) if (done[j.pair] !== undefined) lastRecordedRef.current.set(j.key, done[j.pair]);
          await ledgerStore.setSeriesCursors(source, tf, done, scoringProfile ? activeConfigId : undefined);
        })().catch(() => undefined);
      }

      // v2.3: measured slippage — sample the public order book of the top 10
      // pairs once per 24 h per source ($10,000 notional) for per-pair costs.
      const lastDepth = depthSampledRef.current.get(source) ?? 0;
      if (usesDirectFetch() && Date.now() - lastDepth > 24 * 3_600_000 && out.length) {
        depthSampledRef.current.set(source, Date.now());
        void (async () => {
          const known = await ledgerStore.slippage(source);
          const measured: Record<string, number> = {};
          for (const r of out.slice(0, 10)) {
            if (known[r.pair] && Date.now() - known[r.pair].at < 24 * 3_600_000) continue;
            try {
              // $10,000: at $1,000 a liquid book only shows the half-spread (review S15).
              const bps = slippageBps(await fetchOrderBook(source, r.pair), 10_000);
              if (Number.isFinite(bps)) measured[r.pair] = Math.round(bps * 100) / 100;
            } catch {
              break; // rate limit or network: try again tomorrow
            }
            await new Promise((ok) => setTimeout(ok, 300));
          }
          if (Object.keys(measured).length) await ledgerStore.setSlippage(source, measured);
        })().catch(() => undefined);
      }

      if (ac.signal.aborted) return;
      // Reversal alerts from live rows only (cached history never alerts).
      const activeReversals = liveOnly(out).filter(
        (r) =>
          r.reversal.isReversal &&
          r.reversal.direction !== "NONE" &&
          (r.reversal.confidence === "HIGH" || r.reversal.confidence === "MODERATE"),
      );
      // The dedup key deliberately excludes confidence: an asset oscillating
      // MODERATE -> HIGH -> MODERATE is one reversal, not three. The cooldown
      // is expressed in bar lengths so it scales with the timeframe, and the
      // map is bounded so a long session cannot grow it without limit.
      const now = Date.now();
      const cooldownMs = (data.intervalMs || refreshCadence(tf)) * ALERT_COOLDOWN_BARS;
      const newReversals = activeReversals.filter((r) => {
        const key = `${source}:${tf}:${r.pair}:${r.reversal.direction}`;
        const lastAlerted = alertedReversalRef.current.get(key);
        return lastAlerted === undefined || now - lastAlerted > cooldownMs;
      });
      newReversals.forEach((r) => {
        alertedReversalRef.current.set(`${source}:${tf}:${r.pair}:${r.reversal.direction}`, now);
      });
      if (alertedReversalRef.current.size > ALERT_MEMORY_LIMIT) {
        const oldest = [...alertedReversalRef.current.entries()]
          .sort((a, b) => a[1] - b[1])
          .slice(0, alertedReversalRef.current.size - ALERT_MEMORY_LIMIT);
        oldest.forEach(([key]) => alertedReversalRef.current.delete(key));
      }
      if (newReversals.length > 0) {
        setReversalAlert(newReversals.slice(0, 12));
      }
      // v2.8: stored order-book slippage readings for the paper simulator (read before the rows publish, so the scan sees them).
      try { setPaperSlippage({ source, readings: await ledgerStore.slippage(source) }); } catch { setPaperSlippage({ source, readings: {} }); }
      if (ac.signal.aborted) return;
      shownRef.current = { key: view, rows: out };
      setRows(out);
      // The paper simulator's heartbeat: completed scans only, live rows only (WP27).
      setPaperRows(liveOnly(out));
      // Currency, premium and thin list change with the rows they describe, never before
      // (otherwise the previous source's rows show ₱ while the new scan is still scoring).
      setScanMeta({
        source, currency: data.priceCurrency ?? "USD", premium: data.premiumBySymbol ?? {}, thin: data.thinSymbols ?? [], thinFloorUsd: data.thinFloorUsd,
        tf, quote: data.quote, quoteBySymbol: data.quoteBySymbol, quoteCounts: data.quoteCounts, approx: data.approxVolume,
        depeg: data.depeg, depegAt: Date.now(), usdPhp: data.usdPhp, unknownVolume: data.unknownVolumeSymbols,
      });
      setDetailAsset((current) => current ? out.find((row) => row.pair === current.pair) ?? null : null);
      setScanStats({
        durationMs: data.durationMs,
        errors: data.errors.length,
        stale: data.staleCount,
        newestBarTime: data.newestBarTime,
      });
      setProgress({ done: 1, total: 1 });
      setLastUpdate(new Date());
      // WP27: remember this list for the next instant start, then cache the top-10 tier's other timeframes.
      rememberTickers(listKey, scopedTickers);
      if (usesDirectFetch() && source !== "coinsph" && !data.rateLimitedUntil) {
        const byVolume = [...scopedTickers].sort((a, b) => (parseFloat(b.quoteVolume) || 0) - (parseFloat(a.quoteVolume) || 0)).map((x) => x.symbol);
        const top = priorityOrder(scopedTickers.map((x) => x.symbol), watchlistScope?.symbols ?? null, byVolume)[0] ?? [];
        void prefetchOtherTimeframes({
          source, symbols: top.slice(0, PRIORITY_TOP), timeframes: TIMEFRAMES.map((x) => x.value).filter((x) => x !== tf),
          cache: seriesCacheRef.current, signal: ac.signal,
        });
      }
      // v2.8 (WP21): the daily-bar feed starts only now, behind the finished scan, for live rows (never display-only cached ones).
      let feedStarted = false;
      if (usesDirectFetch() && !ac.signal.aborted && !data.rateLimitedUntil) {
        const feedRows = liveOnly(out).map((r) => ({ symbol: r.pair, ac: r.assetClass }));
        if (feedRows.length) {
          feedStarted = true;
          // One state update per batch (<= every 250 ms), not one per pair.
          const flushFund = () => {
            if (feed.signal.aborted || !fundPendingRef.current.size) return;
            const batch = fundPendingRef.current;
            fundPendingRef.current = new Map();
            setFundTrends((cur) => new Map([...cur, ...batch]));
          };
          fundPendingRef.current = new Map();
          const fundBatcher = createBatcher(flushFund);
          void fundQueueRef.current.enqueue(() => loadFundTrends(source, feedRows, Date.now(), {
            signal: feed.signal,
            onValue: (symbol, state) => { fundPendingRef.current.set(`${source}|${symbol}`, state); fundBatcher.schedule(); },
          }), feed.signal)
            .then(() => fundBatcher.flushNow(), () => fundBatcher.cancel()) // a rejection = aborted by a newer scan or a source switch
            .finally(resolveFeed);
        }
      }
      if (!feedStarted) resolveFeed(); // no feed this scan (hosted build, cooling venue, no live rows): nothing to wait for
    } catch (e) {
      resolveFeed();
      if (!ac.signal.aborted) {
        batcher.cancel();
        setError(e instanceof Error ? e.message : "Failed to load market data");
        const h = healthFromError(e, inNativeShell());
        if (h) setHealth({ source, ...h });
        // Rows still waiting for their fetch say "not updated" with their bar time.
        const shown = session.rows().map((r) => (r.freshness === "updating" ? { ...r, freshness: "stale" as const } : r));
        if (shown.length) { shownRef.current = { key: view, rows: shown }; setRows(shown); }
      }
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, [ledgerStore, watchlistScope, scoringProfile, profileReady, activeConfigId, rsl.port, liquidityFloorUsd]);

  useEffect(() => () => { historyAbortRef.current?.abort(); }, [dataSource, timeframe, scoringProfile]);
  // v2.8 (WP21): a source switch (or leaving the page) aborts the daily-bar feed.
  useEffect(() => () => { fundAbortRef.current?.abort(); }, [dataSource]);

  const backfillHistory = useCallback(async (asset: AssetRow) => {
    historyAbortRef.current?.abort();
    const controller = new AbortController();
    historyAbortRef.current = controller;
    setHistoryLoading(true);
    setHistoryError(null);
    // v2.7 (review #2): the row's own source/timeframe; a row left over from another scan is refused,
    // so its bars are never stored under the new source's history key.
    const dataSource = asset.src;
    const timeframe = asset.tf;
    try {
      if (asset.src !== currentScanRef.current.source || asset.tf !== currentScanRef.current.tf) {
        throw new Error("This row is from an earlier scan of another source or timeframe. Wait for the current scan, then try again.");
      }
      if (asset.klines.length >= MAX_STORED_BARS) {
        throw new Error(`Stored history is at its ${MAX_STORED_BARS.toLocaleString()}-bar limit for this asset.`);
      }
      const oldest = asset.klines[0]?.time;
      const endTime = oldest ? oldest - 1 : Date.now();
      let older: Kline[];
      if (usesDirectFetch()) {
        // Static / desktop / Android builds have no /api routes: page the
        // exchange directly (Build 2.02 — 2.01 always called the server route).
        older = (await fetchHistory(dataSource, asset.pair, timeframe, MAX_HISTORY_BARS, endTime, controller.signal)).klines;
      } else {
        const qs = new URLSearchParams({
          source: dataSource,
          interval: timeframe,
          symbol: asset.pair,
          limit: String(MAX_HISTORY_BARS),
          endTime: String(endTime),
        });
        const response = await fetch(`/api/market/history?${qs.toString()}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as { klines?: Kline[]; error?: string };
        if (!response.ok || !payload.klines) throw new Error(payload.error ?? `History request failed (${response.status})`);
        older = payload.klines;
      }
      if (controller.signal.aborted) return;
      const intervalMs = INTERVAL_MS[timeframe];
      const stored = await saveHistoricalSeries(dataSource, timeframe, asset.pair, mergeKlines(asset.klines, older));
      const klines = contiguousTail(stored, intervalMs);
      const seriesKey = `${dataSource}:${timeframe}:${asset.pair}`;
      const [res] = await runScanJobs([{ key: seriesKey, packed: packKlines(klines), intervalMs, volumeAvailable: true, assetClass: asset.assetClass, profile: scoringProfile }]);
      if (controller.signal.aborted) return;
      historyLenRef.current.set(seriesKey, { len: klines.length, newest: klines.at(-1)?.time ?? 0 });
      const updated = { ...asset, klines, confluence: res.score.confluence, reversal: res.score.reversal, pattern: res.pattern };
      setRows((current) => current.map((row) => row.pair === asset.pair ? updated : row));
      if (shownRef.current.rows.some((row) => row.pair === asset.pair)) shownRef.current = { ...shownRef.current, rows: shownRef.current.rows.map((row) => row.pair === asset.pair ? updated : row) };
      if (updated.freshness === "live") setPaperRows((current) => current.map((row) => row.pair === asset.pair ? updated : row));
      setDetailAsset(updated);
    } catch (error) {
      if (controller.signal.aborted) return;
      setHistoryError(error instanceof Error ? error.message : "Unable to retrieve history.");
    } finally {
      if (historyAbortRef.current === controller) setHistoryLoading(false);
    }
  }, [scoringProfile]);

  useEffect(() => { currentScanRef.current = { source: dataSource, tf: timeframe }; });
  useEffect(() => {
    loadRef.current = () => void load(timeframe, dataSource, monitorAssets, universeLimit, assetClass, quote);
  });

  // Initial load + on timeframe change.
  useEffect(() => {
    if (!preferencesReady) return;
    const initialLoad = window.setTimeout(() => void load(timeframe, dataSource, monitorAssets, universeLimit, assetClass, quote), 0);
    return () => window.clearTimeout(initialLoad);
  }, [preferencesReady, timeframe, dataSource, monitorAssets, universeLimit, assetClass, quote, load]);

  // Refresh cadence follows the selected market timeframe.
  useEffect(() => {
    if (!preferencesReady || !autoRefresh) return;
    const id = setInterval(() => void load(timeframe, dataSource, monitorAssets, universeLimit, assetClass, quote), refreshCadenceFor(timeframe, dataSource));
    return () => clearInterval(id);
  }, [preferencesReady, autoRefresh, timeframe, dataSource, monitorAssets, universeLimit, assetClass, quote, load]);

  /* ---- derived / filtered / sorted ---- */
  const visible = useMemo(() => {
    let r = rows;
    if (search.trim()) {
      const q = search.trim().toUpperCase();
      r = r.filter((x) => x.symbol.includes(q) || x.pair.includes(q));
    }
    const sorted = [...r].sort((a, b) => {
      let av: number | string, bv: number | string;
      switch (sortKey) {
        case "symbol": av = a.symbol; bv = b.symbol; break;
        case "price": av = a.price; bv = b.price; break;
        case "change24h": av = a.change24h; bv = b.change24h; break;
        case "quoteVolume": av = a.quoteVolume; bv = b.quoteVolume; break;
        case "bull": av = a.confluence.bull; bv = b.confluence.bull; break;
        case "bear": av = a.confluence.bear; bv = b.confluence.bear; break;
        case "score": av = a.confluence.score; bv = b.confluence.score; break;
        default: av = a.rank; bv = b.rank;
      }
      if (typeof av === "string") {
        return sortDir === "asc" ? av.localeCompare(bv as string) : (bv as string).localeCompare(av);
      }
      return sortDir === "asc" ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
    return sorted;
  }, [rows, search, sortKey, sortDir]);

  const totals = useMemo(() => {
    let bull = 0, bear = 0, neutral = 0, revUp = 0, revDown = 0;
    for (const r of rows) {
      if (r.confluence.master === "BULLISH") bull++;
      else if (r.confluence.master === "BEARISH") bear++;
      else neutral++;
      if (r.reversal.isReversal) {
        if (r.reversal.direction === "UP") revUp++;
        else if (r.reversal.direction === "DOWN") revDown++;
      }
    }
    return { bull, bear, neutral, revUp, revDown, total: rows.length };
  }, [rows]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const pct = (n: number) => (totals.total ? (n / totals.total) * 100 : 0);
  // The ledger view reads current candles on demand, so a refresh does not re-run its measurement.
  const rowsRef = useRef(rows);
  useEffect(() => { rowsRef.current = rows; }, [rows]);
  const getLiveKlines = useCallback(() => Object.fromEntries(liveOnly(rowsRef.current).map((row) => [row.pair, row.klines])), []);
  // Final review I-3: closed bars for a pair holding a paper position that the scan left out (liquidity floor,
  // list cut). Paper book only: never scored, listed, recorded or alerted on. Read-only public candles.
  const fetchPaperKlines = useCallback(
    (pair: string, signal?: AbortSignal) => fetchPaperHeldKlines(dataSource, timeframe, pair, 200, signal),
    [dataSource, timeframe],
  );
  // Re-review N-1: no held-pair request while this source's venue is cooling down after a 429/418.
  const paperCooldownMs = useCallback(() => rateLimitCooldown(dataSource), [dataSource]);
  // Scheduled macro releases within the next 24 h (or the last 2 h), measured from the last scan.
  const macroEvents = useMemo(() => (lastUpdate ? eventsNear(lastUpdate.getTime()) : []), [lastUpdate]);
  // Kinds whose verified dates run out within 30 days (text-only addition to the macro banner).
  const macroStale = useMemo(() => (lastUpdate ? coverageWarnings(lastUpdate.getTime()) : []), [lastUpdate]);
  const selectedSource = DATA_SOURCES.find((s) => s.value === dataSource) ?? DATA_SOURCES[0];

  /* ---- v2.7 (WP13): display currency — formatting only, rows stay in their native currency ---- */
  const nativeCurrency = scanMeta.currency;
  // v2.8 (WP26): BTC-quoted prices (Upbit BTC market) never pass through fiat FX; KRW converts like PHP.
  const shownPrices = priceDisplay(nativeCurrency, displayCurrency, fx);
  const priceCurrency = shownPrices.currency;
  const pricesInBtc = shownPrices.pricesInBtc && scanMeta.source === dataSource;
  const volumeCurrency = canConvert("USD", displayCurrency, fx) ? displayCurrency : "USD";
  // v2.8 WP20: a rate source's required credit wherever its rates convert values on screen — prices or volumes
  // (review round 1) — and none for the default source.
  const rateCredit = fxCredit(fx, nativeCurrency, priceCurrency, volumeCurrency);
  const showPrice = useCallback((v: number) => formatMoney(priceDisplay(nativeCurrency, priceCurrency, fx).convert(v), priceCurrency), [nativeCurrency, priceCurrency, fx]);
  const showVolume = (usd: number) => formatMoneyCompact(convert(usd, "USD", volumeCurrency, fx), volumeCurrency);
  const chartConvert = useCallback((v: number) => priceDisplay(nativeCurrency, priceCurrency, fx).convert(v), [nativeCurrency, priceCurrency, fx]);
  const liveQuotes = scanMeta.source === dataSource && scanMeta.quoteCounts ? Object.keys(scanMeta.quoteCounts) : undefined;
  const quoteModes = quoteModesFor(dataSource, liveQuotes);
  const setQuote = (mode: string) => { setDetailAsset(null); setQuoteBySource((cur) => ({ ...cur, [dataSource]: mode })); };
  const PRIORITY_FIAT = ["USD", "SAR", "PHP", "EUR", "AED", "QAR", "KWD", "BHD", "OMR", "GBP", "JPY", "INR", "CNY", "SGD", "AUD", "CAD", "CHF", "HKD", "KRW", "IDR", "MYR", "THB", "TRY", "NZD"];
  const fiatCodes = [...new Set([...PRIORITY_FIAT, ...fiatList.map((c) => c.code)])];
  const fiatName = new Map(fiatList.map((c) => [c.code, c.name]));
  // v2.8 (WP19): thin-pair note for the scan line (crypto liquidity floor; Coins.ph keeps its own box).
  const liquidityNote = scanMeta.source === dataSource && scanMeta.source !== "coinsph" ? thinNote(scanMeta.thin, scanMeta.thinFloorUsd) : null;
  // Backup reminder: after 7 days, or always while storage is not durable (builder skill §3.5).
  const backupDueDays = (() => {
    const last = rsl.lastBackupAt ? Date.parse(rsl.lastBackupAt) : null;
    const days = last ? Math.floor((Date.now() - last) / 86_400_000) : 0;
    if (last === null) return rsl.port.durable ? null : 0;
    return days >= 7 || !rsl.port.durable ? days : null;
  })();
  const applyMonitorAssets = () => setMonitorAssets(parseAssetInput(monitorDraft));

  /* v2.5: each control is rendered once — inline on ≥ 640 px, inside "More controls" on phones. */
  const renderAssetClassSelect = (cls = "") => (
      <Select value={assetClass} onValueChange={(v) => setAssetClass(v as AssetClassFilter)}>
        <SelectTrigger aria-label={t("ctl.assetClass")} className={`h-8 w-auto min-w-[128px] gap-2 border-zinc-800 bg-zinc-900 text-xs ${cls}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="border-zinc-800 bg-zinc-900">
          {ASSET_CLASS_FILTERS.map((c) => <SelectItem key={c} value={c}>{t(`ac.${c}`)}</SelectItem>)}
        </SelectContent>
      </Select>
  );
  const renderQuoteSelect = (cls = "") => (
      <Select value={quote} onValueChange={setQuote} disabled={quoteModes.length < 2}>
        <SelectTrigger aria-label={t("ctl.quote")} data-testid="quote-select" className={`h-8 w-auto min-w-[92px] gap-2 border-zinc-800 bg-zinc-900 text-xs ${cls}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="border-zinc-800 bg-zinc-900">
          {quoteModes.map((m) => (
            <SelectItem key={m} value={m}>{m === BEST ? t("quote.best") : m}{m !== BEST && stableQuote(m)?.peg === "EUR" ? " (EUR)" : ""}</SelectItem>
          ))}
        </SelectContent>
      </Select>
  );
  const renderCurrencySelect = (cls = "") => (
      <Select value={displayPref} onValueChange={setDisplayPref}>
        <SelectTrigger aria-label={t("ctl.currency")} data-testid="currency-select" className={`h-8 w-auto min-w-[96px] gap-2 border-zinc-800 bg-zinc-900 text-xs ${cls}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-h-80 border-zinc-800 bg-zinc-900">
          <SelectItem value="AUTO">{t("fx.auto", { code: autoCurrency() })}</SelectItem>
          {fiatCodes.map((code) => (
            <SelectItem key={code} value={code}>{code}{fiatName.get(code) ? ` · ${fiatName.get(code)}` : ""}</SelectItem>
          ))}
        </SelectContent>
      </Select>
  );
  const renderRatesButton = (cls = "") => (
      <button type="button" data-testid="fx-sources-open" onClick={() => setFxDialog(true)} title={t("fx.sources")}
        className={`rsl-touch inline-flex h-8 items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-xs text-zinc-300 hover:bg-zinc-800 ${cls}`}>
        ⇄ {t("fx.sources")}
      </button>
  );
  const renderUniverseSelect = (cls = "") => (
      <Select value={String(universeLimit)} onValueChange={(value) => setUniverseLimit(Number(value))}>
        <SelectTrigger aria-label={t("ctl.universe")} className={`h-8 w-auto min-w-[92px] gap-2 border-zinc-800 bg-zinc-900 text-xs ${cls}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="border-zinc-800 bg-zinc-900">
          {[25, 50, 100, 200].map((size) => <SelectItem key={size} value={String(size)}>{t("ctl.top", { n: size })}</SelectItem>)}
        </SelectContent>
      </Select>
  );
  const renderApiButton = (cls = "") => (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setPrivateApiOpen(true)}
        aria-label={`${privateApiProfile ? privateApiProfile.provider : "API"} — ${t("ctl.api")}`}
        className={`h-8 border-zinc-800 px-2 text-xs ${privateApiProfile ? "text-emerald-400" : "text-zinc-300"} ${cls}`}
      >
        <KeyRound className="h-3.5 w-3.5" />
        <span className="hidden xl:inline">{privateApiProfile ? privateApiProfile.provider : "API"}</span>
      </Button>
  );
  const renderContactButton = (cls = "") => (
      <Button variant="outline" size="sm" asChild className={`h-8 border-zinc-800 px-2 text-xs text-zinc-300 ${cls}`}>
        <a href={contactMailto({ name: APP.name }, APP.contactSubject)} aria-label={t("ctl.contact")} title={t("ctl.contact")}>
          <Mail className="h-3.5 w-3.5" />
        </a>
      </Button>
  );
  const renderAboutButton = (cls = "") => (
      <Button variant="outline" size="sm" onClick={() => setAboutOpen(true)} aria-label={t("ctl.about")} title={t("ctl.about")} className={`h-8 border-zinc-800 px-2 text-xs text-zinc-300 ${cls}`}>
        <Info className="h-3.5 w-3.5" />
      </Button>
  );
  const renderThemeButton = (cls = "") => (
      <div role="radiogroup" aria-label={t("theme.label")} className={`inline-flex h-8 shrink-0 items-center rounded-md border border-zinc-800 bg-zinc-900 p-0.5 ${cls}`}
        onKeyDown={(e) => {
          const order: ThemePref[] = ["system", "light", "dark"];
          const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
          if (!step) return;
          e.preventDefault();
          const next = order[(order.indexOf(themePref) + (document.dir === "rtl" && e.key.startsWith("Arrow") && (e.key === "ArrowRight" || e.key === "ArrowLeft") ? -step : step) + order.length) % order.length];
          applyBackground(toStoredBackground(next));
          (e.currentTarget.querySelector(`[data-theme-option="${next}"]`) as HTMLElement | null)?.focus();
        }}>
        {(["system", "light", "dark"] as const).map((opt) => (
          <button key={opt} type="button" role="radio" aria-checked={themePref === opt} tabIndex={themePref === opt ? 0 : -1}
            data-theme-option={opt} title={t(`theme.${opt}`)} aria-label={t(`theme.${opt}`)}
            onClick={() => applyBackground(toStoredBackground(opt))}
            className={`rsl-touch inline-flex h-full items-center justify-center rounded px-1.5 text-zinc-400 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${themePref === opt ? "bg-zinc-800 text-zinc-100" : ""}`}>
            {opt === "system" ? <Monitor className="h-3.5 w-3.5" aria-hidden="true" /> : opt === "light" ? <Sun className="h-3.5 w-3.5" aria-hidden="true" /> : <Moon className="h-3.5 w-3.5" aria-hidden="true" />}
          </button>
        ))}
      </div>
  );

  /* ========================================================================== *
   *  Render
   * ========================================================================== */
  return (
    <div
      className="ct-app-shell flex flex-col overflow-hidden bg-zinc-950 text-zinc-100"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
      data-list-expanded={listExpanded ? "true" : undefined}
    >
      {/* ----------------------------------------------------------------- *
       *  Header — deliberately dense.
       *
       *  Chrome is overhead: every pixel spent on it is a row of the asset
       *  panel the operator cannot see. The prior layout spent roughly 240px
       *  on a tall header, four large stat cards, and an info bar before the
       *  first row of data. This collapses the same information into two thin
       *  rows (~76px) and gives the reclaimed height to the table.
       * ----------------------------------------------------------------- */}
      <header hidden={listExpanded} className="brand-surface relative z-30 shrink-0 border-b border-cyan-400/15 backdrop-blur">
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-cyan-400/50 to-transparent" />
        <div className="mx-auto w-full max-w-[1600px] px-3">
          {/* Row 1 — brand + controls */}
          <div className="flex flex-wrap items-center gap-1.5 py-1.5">
            {/* rsL brand block: monogram → rsL Confluence Terminal → by rsLozano → build (fixed order). */}
            <div className="me-2 flex min-w-0 items-center">
              <BrandBlock />
              <h1 className="sr-only">{t("ctx.page")} — {id.customer.legalName}</h1>
            </div>
            {isPhone && <span className="ms-auto"><CustomerChip onClick={() => setAboutOpen(true)} /></span>}

            <Select value={timeframe} onValueChange={(v) => { setDetailAsset(null); setTimeframe(v as TF); }}>
              <SelectTrigger aria-label={t("ctl.timeframe")} className="h-8 min-w-0 flex-1 border-zinc-800 bg-zinc-900 text-xs sm:w-[150px] sm:flex-none">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-900">
                {TIMEFRAMES.map((tf) => (
                  <SelectItem key={tf.value} value={tf.value}>{t(`tf.${tf.value}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={dataSource} onValueChange={(v) => { setDetailAsset(null); setDataSource(v as DataSource); }}>
              <SelectTrigger aria-label={t("ctl.source")} className="h-8 min-w-0 flex-1 border-zinc-800 bg-zinc-900 text-xs sm:w-[150px] sm:flex-none">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-80 border-zinc-800 bg-zinc-900">
                {DATA_SOURCES.map((source) => (
                  <SelectItem key={source.value} value={source.value}>{source.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            {!isPhone && renderQuoteSelect()}

            {!isPhone && renderAssetClassSelect()}

            {!isPhone && renderUniverseSelect()}

            {!isPhone && renderCurrencySelect()}
            {!isPhone && renderRatesButton()}

            <button
              type="button"
              data-testid="more-controls"
              aria-expanded={moreControlsOpen}
              aria-controls="ct-more-controls"
              onClick={() => setMoreControlsOpen((v) => !v)}
              className="rsl-touch inline-flex h-8 items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-xs text-zinc-300 sm:hidden"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only">{t("ctl.moreControls")}</span>
            </button>
            <div id="ct-more-controls" data-testid="more-controls-panel"
              className={`${moreControlsOpen ? "flex" : "hidden"} w-full flex-wrap items-center gap-1.5 sm:contents`}>
            {isPhone && (
              <div className="flex w-full flex-wrap items-center gap-1.5">
                {renderQuoteSelect()}
                {renderCurrencySelect()}
                {renderRatesButton()}
                {renderAssetClassSelect()}
                {renderUniverseSelect()}
                {renderApiButton()}
                {renderContactButton()}
                {renderAboutButton()}
                {renderThemeButton()}
              </div>
            )}
            <ScannerWatchlists port={rsl.port} source={dataSource}
              results={rows.filter((row) => !search.trim() || row.pair.includes(search.trim().toUpperCase())).map((row) => row.pair)}
              monitored={rows.filter((row) => monitorAssets.includes(row.symbol)).map((row) => row.pair)}
              active={watchlistScope} onScope={(list) => {
                setWatchlistScope(list);
                if (list) setDataSource(list.source);
              }} />
            <ScannerInbox port={rsl.port} list={watchlistScope} timeframe={timeframe} ledger={ledgerStore} />
            <ScoringProfileEditor profile={scoringProfile} configId={activeConfigId} onApply={applyScoringProfile} disabled={!profileReady}
              liquidityFloorUsd={liquidityFloorUsd} onLiquidityFloor={setLiquidityFloorUsd}
              fundPulse={fundPulse} onFundPulse={setFundPulse} fundRankColumn={fundRankColumn} onFundRankColumn={setFundRankColumn} recordRadar={recordRadar} onRecordRadar={setRecordRadar} t={t} />
            <SavedScans port={rsl.port}
              current={{ timeframe, dataSource, universeLimit, assetClass, sortKey, sortDir, search, monitorAssets }}
              onApply={(preset) => {
                setWatchlistScope(null);
                setTimeframe(preset.timeframe);
                setDataSource(preset.dataSource);
                setUniverseLimit(preset.universeLimit);
                setAssetClass(preset.assetClass);
                setSortKey(preset.sortKey);
                setSortDir(preset.sortDir);
                setSearch(preset.search);
                setMonitorAssets(preset.monitorAssets);
                setMonitorDraft(preset.monitorAssets.join(", "));
              }} />
            <div className="relative">
              <Search className="absolute start-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("ctl.filter")}
                aria-label={t("ctl.filterLabel")}
                className="h-8 w-32 border-zinc-800 bg-zinc-900 ps-7 text-xs"
              />
            </div>

            <Input
              value={monitorDraft}
              onChange={(e) => setMonitorDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") applyMonitorAssets(); }}
              placeholder={t("ctl.watch")}
              aria-label={t("ctl.watchLabel")}
              className="h-8 w-36 border-zinc-800 bg-zinc-900 text-xs"
            />
            <Button variant="outline" size="sm" onClick={applyMonitorAssets} className="h-8 border-zinc-800 px-2 text-xs text-zinc-300">
              {t("ctl.apply")}
            </Button>
            </div>

            <div className="ms-auto flex flex-wrap items-center gap-1.5">
              {!isPhone && <CustomerChip onClick={() => setAboutOpen(true)} />}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAutoRefresh((v) => !v)}
                aria-label={autoRefresh ? t("ctl.auto") : t("ctl.manual")}
                aria-pressed={autoRefresh}
                className={`h-8 border-zinc-800 px-2 text-xs ${autoRefresh ? "text-emerald-400" : "text-zinc-500"}`}
              >
                <Zap className="h-3.5 w-3.5" />
                <span className="hidden lg:inline">{autoRefresh ? t("ctl.auto") : t("ctl.manual")}</span>
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={() => setAlertsOpen(true)}
                className="relative h-8 border-zinc-800 px-2 text-xs text-zinc-300"
                aria-label={t("ctl.alerts", { count: reversalAlert.length })}
              >
                <Bell className="h-3.5 w-3.5" />
                {reversalAlert.length > 0 && (
                  <span className="absolute -right-1.5 -top-1.5 min-w-4 rounded-full bg-amber-500 px-1 text-[9px] font-bold leading-4 text-black">
                    {reversalAlert.length}
                  </span>
                )}
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={() => setLedgerOpen(true)}
                aria-label={`${t("ctl.ledgerShort")} — ${t("ctl.ledger")}`}
                title={t("ctl.ledger")}
                className="h-8 border-zinc-800 px-2 text-xs text-zinc-300"
              >
                <BarChart3 className="h-3.5 w-3.5" />
                <span className="hidden xl:inline">{t("ctl.ledgerShort")}</span>
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={() => setPaperOpen(true)}
                aria-label={`${t("paper.toolbar")} — ${t("paper.title")}`}
                title={t("paper.banner")}
                className="h-8 border-zinc-800 px-2 text-xs text-zinc-300"
              >
                <FlaskConical className="h-3.5 w-3.5" />
                <span className="hidden xl:inline">{t("paper.toolbar")}</span>
              </Button>

              {!isPhone && renderApiButton()}

              <LanguageMenu />
              {!isPhone && renderContactButton()}
              {!isPhone && renderAboutButton()}
              {!isPhone && renderThemeButton()}

              <Button
                size="sm"
                onClick={() => void load(timeframe, dataSource, monitorAssets, universeLimit, assetClass, quote)}
                disabled={loading}
                aria-label={t("ctl.refresh")}
                className="h-8 border border-emerald-300/20 bg-gradient-to-r from-cyan-500 to-emerald-500 px-2 text-xs font-semibold text-[#061018] shadow-[0_0_16px_rgb(36_200_117/0.13)] hover:from-cyan-400 hover:to-emerald-400"
              >
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                <span className="hidden lg:inline">{t("ctl.refresh")}</span>
              </Button>
            </div>
          </div>

          {/* Row 2 — counts and scan telemetry, one line */}
          {/* v2.8 (WP29, owner decision 16 Nov 2026): one wrapping row. The Fear & Greed chip is its last item (ms-auto); when the last line has no room
              it takes its own line (at most one line, about 20 px). No existing text is truncated or hidden by the chip. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-800/60 py-1 text-[11px] text-zinc-500">
            <StatChip icon={<Activity className="h-3 w-3 text-zinc-400" />} label={t("stat.assets")} value={totals.total} />
            <StatChip icon={<TrendingUp className="h-3 w-3 text-emerald-400" />} label={t("stat.bull")} value={totals.bull} sub={`${pct(totals.bull).toFixed(0)}%`} tone="emerald" />
            <StatChip icon={<TrendingDown className="h-3 w-3 text-rose-400" />} label={t("stat.bear")} value={totals.bear} sub={`${pct(totals.bear).toFixed(0)}%`} tone="rose" />
            <StatChip icon={<Minus className="h-3 w-3 text-zinc-400" />} label={t("stat.neutral")} value={totals.neutral} sub={`${pct(totals.neutral).toFixed(0)}%`} />
            <StatChip icon={<RotateCcw className="h-3 w-3 text-amber-400" />} label={t("stat.rev")} value={`${totals.revUp}/${totals.revDown}`} tone="amber" />

            <span className="hidden text-zinc-700 sm:inline">|</span>
            <FullTitle data-testid="scan-telemetry" className="hidden truncate sm:inline">
              <bdi className="text-zinc-300">{id.customer.shortName}</bdi>
              <span className="mx-1.5 text-zinc-700">·</span>
              <span className="text-zinc-400">{selectedSource.label}</span>
              <span className="mx-1.5 text-zinc-700">·</span>
              {t("scan.duration", { s: (scanStats.durationMs / 1000).toFixed(1) })}
              <span className="mx-1.5 text-zinc-700">·</span>
              <span className={scanStats.errors ? "text-amber-400" : ""}>{t("scan.errors", { n: scanStats.errors })}</span>
              {scanStats.stale > 0 && (
                <>
                  <span className="mx-1.5 text-zinc-700">·</span>
                  <span className="font-semibold text-rose-400">{t("scan.stale", { n: scanStats.stale })}</span>
                </>
              )}
              {/* v2.8 (WP19): crypto pairs the liquidity floor left out of the score (Coins.ph shows its own note). */}
              {liquidityNote && (
                <>
                  <span className="mx-1.5 text-zinc-700">·</span>
                  <span data-testid="liquidity-note" title={scanMeta.thin.join(", ")}>{t("liq.thin", liquidityNote)}</span>
                </>
              )}
              {/* v2.8 (WP26 final wave): pairs left out because their US$ volume is unknown (not "thin"). */}
              {scanMeta.source === dataSource && (scanMeta.unknownVolume?.length ?? 0) > 0 && (
                <>
                  <span className="mx-1.5 text-zinc-700">·</span>
                  <span data-testid="unknown-volume-note" title={scanMeta.unknownVolume?.join(", ")}>{t("liq.unknown", { n: scanMeta.unknownVolume?.length ?? 0 })}</span>
                </>
              )}
              <span className="mx-1.5 text-zinc-700">·</span>
              {lastUpdate ? t("scan.updated", { time: rsl.i18n.formatDate(lastUpdate, { timeStyle: "medium", hour12: false }) }) : "—"}
              {scanStats.newestBarTime > 0 && (
                <>
                  <span className="mx-1.5 text-zinc-700">·</span>
                  <span title={t("scan.barHint")}>
                    {t("scan.bar", { time: rsl.i18n.formatDate(scanStats.newestBarTime, { timeStyle: "medium", hour12: false }) })}
                  </span>
                </>
              )}
            </FullTitle>
            {/* v2.8 (WP26): Upbit BTC market — prices stay in BTC (never converted through fiat FX). */}
            {pricesInBtc && <span data-testid="prices-in-btc" className="text-amber-300/80">{t("scan.pricesInBtc")}</span>}
            {monitorAssets.length > 0 && (
              <span className="text-emerald-400/80">{t("scan.watching", { list: monitorAssets.join(", ") })}</span>
            )}
            {/* v2.8 (WP29): collapsed Fear & Greed chip, spec §3 item 8. No request while collapsed. */}
            <FearGreedToggle open={fngOpen} onToggle={() => setFngOpen(!fngOpen)} />
          </div>
          {/* The header is not sticky (a shrink-0 block above the list), so the open panel pushes the list down and never covers it; it scrolls inside 15 vh on a phone, 55 vh from the sm breakpoint. */}
          {fngOpen && <FearGreedPanel port={rsl.port} />}

          {loading && progress.total > 0 && (
            <div className="h-0.5 w-full overflow-hidden rounded bg-zinc-800">
              <div data-testid="scan-progress" data-done={progress.done} data-total={progress.total} className="h-full bg-gradient-to-r from-cyan-400 to-emerald-400 transition-all duration-300" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
            </div>
          )}
        </div>
      </header>

      {watchlistScope && unavailableMembers.length > 0 && (
        <p role="status" className="px-4 py-1 text-xs text-amber-300">Unavailable watchlist instruments: {unavailableMembers.join(", ")}</p>
      )}

      {profileFailure && <p role="alert" className="px-4 py-1 text-xs text-amber-300">
        {profileFailure} <button type="button" onClick={() => void applyScoringProfile(null).catch(() => setProfileFailure("Default profile could not be saved."))}>Restore default scoring profile</button>
      </p>}
      {/* Stale-feed banner — a degraded feed should be loud, not subtle. */}
      {scanStats.stale > 0 && scanStats.stale >= Math.max(3, totals.total * 0.05) && (
        <div role="alert" className="shrink-0 border-b border-rose-500/40 bg-rose-500/10 px-4 py-1.5 text-xs text-rose-300">
          {t("banner.stale", { n: scanStats.stale })}
        </div>
      )}

      {/* Storage is never silently best-effort (builder skill rule 4). */}
      {!listExpanded && (rsl.notice || backupDueDays !== null) && (
        <div role="status" className="shrink-0 flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1 text-xs text-amber-200">
          <span>
            {rsl.notice ? t(rsl.port.sessionOnly ? "notice.session" : "notice.bestEffort") : null}
            {rsl.notice && backupDueDays !== null ? " " : null}
            {backupDueDays !== null ? t("notice.backupDue", { days: backupDueDays }) : null}
          </span>
          <Button size="sm" variant="outline" className="h-7 border-amber-500/40 text-xs" onClick={() => setAboutOpen(true)}>{t("about.export")}</Button>
        </div>
      )}

      {!listExpanded && (assetClass === "all" ? rows.some((x) => hasSessionGaps(x.assetClass)) : hasSessionGaps(assetClass as AssetClass)) && (
        <div role="note" className="shrink-0 border-b border-sky-500/30 bg-sky-500/10 px-4 py-1 text-xs text-sky-200">
          {t("ac.sessionNote")}
        </div>
      )}

      {!listExpanded && lastUpdate && (macroEvents.length > 0 || macroStale.length > 0) && (
        <div role="note" className="shrink-0 border-b border-violet-500/30 bg-violet-500/10 px-4 py-1 text-xs text-violet-200">
          {macroEvents.map((e) => {
            const hours = Math.round(Math.abs(e.at - lastUpdate.getTime()) / 3_600_000);
            return (
              <span key={e.id} className="me-3 inline-block">
                {t(e.at >= lastUpdate.getTime() ? "macro.upcoming" : "macro.recent", { event: t(`macro.${e.kind}`), hours })}
              </span>
            );
          })}
          {macroStale.map((k) => (
            <span key={`stale-${k}`} className="me-3 inline-block">
              {t("macro.coverage", { event: t(`macro.${k}`), date: new Date(coverageUntil(k)).toISOString().slice(0, 10) })}
            </span>
          ))}
        </div>
      )}

      {scanMeta.source === "coinsph" && dataSource === "coinsph" && (
        <div data-testid="ph-market-note" className="shrink-0 border-b border-sky-500/30 bg-sky-500/10 px-4 py-1.5 text-xs text-sky-200">
          {t("ph.localMarket")}
          {scanMeta.thin.length > 0 && (
            <span className="ms-2 text-sky-300/80" title={scanMeta.thin.map((p) => p.replace(/PHP$/, "")).join(", ")}>
              · {t("ph.thin", { n: scanMeta.thin.length, floor: floorLabel(scanMeta.thinFloorUsd ?? COINSPH_MIN_USD_TURNOVER) })}
            </span>
          )}
        </div>
      )}

      {!listExpanded && !shownPrices.pricesInBtc && <FxInfoLine t={t} native={nativeCurrency} display={displayCurrency} shown={priceCurrency} fx={fx}
        usdtPhp={scanMeta.source === "coinsph" && dataSource === "coinsph" ? scanMeta.usdPhp ?? null : null}
        onSources={() => setFxDialog(true)} />}
      <FxSourcesDialog open={fxDialog} onOpenChange={setFxDialog} t={t} choice={fxChoice}
        onChoice={(c) => { setFxChoice(c); setFx(cachedTable(c)); }}
        autoUpdate={fxAutoUpdate} onAutoUpdate={setFxAutoUpdate} table={fx} displayCurrency={displayCurrency}
        updating={fxUpdating} onUpdate={() => void updateRatesNow()} custom={fxCustom} onCustom={setFxCustom}
        onImported={(table) => setFx(table)} />
      {!listExpanded && scanMeta.source === dataSource && (scanMeta.depeg ?? []).map((d) => (
        <div key={d.coin} role="status" data-testid="depeg-banner"
          className={`shrink-0 border-b px-4 py-1.5 text-xs ${d.level === "severe" ? "border-rose-500/40 bg-rose-500/10 text-rose-200" : "border-amber-500/40 bg-amber-500/10 text-amber-200"}`}>
          <strong className="me-1">{t(`depeg.${d.level}`)}:</strong>
          {t("depeg.note", { coin: d.coin, ref: d.reference, dev: `${d.deviationPct > 0 ? "+" : ""}${d.deviationPct.toFixed(2)} %` })}
        </div>
      ))}

      {rateLimitUntil !== null && rateLimitUntil > Date.now() && (
        <div role="alert" className="shrink-0 border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-200">
          {t("scan.rateLimited", { s: Math.ceil((rateLimitUntil - Date.now()) / 1000) })}
        </div>
      )}

      {error && (
        <div role="alert" className="shrink-0 flex flex-wrap items-center justify-between gap-2 border-b border-rose-500/40 bg-rose-500/10 px-4 py-1.5 text-xs text-rose-300">
          <span className="min-w-0 flex-1 truncate" title={error}>{error}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="h-7 border-rose-500/40 text-xs" onClick={() => void load(timeframe, dataSource, monitorAssets, universeLimit, assetClass, quote)}>{t("err.retry")}</Button>
            {dataSource !== "bybit-spot" && (
              <Button size="sm" variant="outline" className="h-7 border-rose-500/40 text-xs" onClick={() => setDataSource("bybit-spot")}>{t("err.useBybit")}</Button>
            )}
          </div>
        </div>
      )}

      {/* ---------- Data table — fills all remaining height ---------- */}
      <main className={`mx-auto flex w-full max-w-[1600px] min-h-0 flex-1 flex-col ${listExpanded ? "px-1.5 py-1" : "px-3 py-2"}`}>
        {listExpanded && <h1 className="sr-only">{t("ctx.page")} — {id.customer.legalName}</h1>}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50">
          {/* List toolbar — the expand control lives with the list it enlarges. */}
          <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-2 py-0.5 text-[11px] text-zinc-500">
            <span className="min-w-0 flex-1 truncate">
              {t("stat.assets")} <span className="font-mono tabular-nums text-zinc-300">{visible.length}</span>
              {listExpanded && (
                <>
                  <span className="mx-1.5 text-zinc-700">·</span>
                  <span className="text-zinc-400">{t(`tf.${timeframe}`)}</span>
                  <span className="mx-1.5 text-zinc-700">·</span>
                  <span className="text-zinc-400">{selectedSource.label}</span>
                  {lastUpdate && (
                    <>
                      <span className="mx-1.5 text-zinc-700">·</span>
                      {t("scan.updated", { time: rsl.i18n.formatDate(lastUpdate, { timeStyle: "short", hour12: false }) })}
                    </>
                  )}
                </>
              )}
            </span>
            {/* v2.8 WP20: the info line is hidden while the list is expanded, so the required rate credit moves here. */}
            {listExpanded && rateCredit && (
              <a data-testid="fx-credit-expanded" href={rateCredit.url} target="_blank" rel="noopener noreferrer"
                className="shrink-0 text-cyan-300/90 hover:underline">{rateCredit.text}</a>
            )}
            {listExpanded && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void load(timeframe, dataSource, monitorAssets, universeLimit, assetClass, quote)}
                disabled={loading}
                aria-label={t("ctl.refresh")}
                title={t("ctl.refresh")}
                className="rsl-touch h-7 shrink-0 border-zinc-800 px-2 text-xs text-zinc-300"
              >
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              </Button>
            )}
            {listRibbonOn && <StopPulseButton label={t("ft.stopPulse")} mode={fundPulse} />}
            <Button
              variant="outline"
              size="sm"
              onClick={toggleListExpanded}
              title={listExpanded ? t("list.collapse") : t("list.expandHint")}
              data-testid="list-expand"
              className="rsl-touch h-7 shrink-0 gap-1.5 border-zinc-800 px-2 text-xs text-zinc-300"
            >
              {listExpanded ? <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" /> : <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />}
              <span>{listExpanded ? t("list.collapse") : t("list.expand")}</span>
            </Button>
          </div>
          {loading && progress.total > 0 && listExpanded && (
            <div className="h-0.5 w-full shrink-0 overflow-hidden bg-zinc-800">
              <div className="h-full bg-gradient-to-r from-cyan-400 to-emerald-400 transition-all duration-300" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-auto custom-scroll">
            <table className="market-table w-full min-w-[1180px] border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-zinc-900 shadow-[0_1px_0_0_rgb(63_63_70)]">
                <tr className="text-left text-xs uppercase tracking-wider text-zinc-500">
                  <Th onClick={() => toggleSort("rank")} active={sortKey === "rank"} dir={sortDir} className="w-14 text-center">#</Th>
                  <Th onClick={() => toggleSort("symbol")} active={sortKey === "symbol"} dir={sortDir}>{t("col.asset")}</Th>
                  <Th onClick={() => toggleSort("price")} active={sortKey === "price"} dir={sortDir} className="text-end">{t("col.price")}</Th>
                  <Th onClick={() => toggleSort("change24h")} active={sortKey === "change24h"} dir={sortDir} className="text-end">{t("col.change")}</Th>
                  <Th onClick={() => toggleSort("quoteVolume")} active={sortKey === "quoteVolume"} dir={sortDir} className="text-end">{t("col.volume")}</Th>
                  <th className="px-3 py-1.5 font-medium">
                    <div className="flex items-center gap-1.5">
                      <CircleDot className="h-3.5 w-3.5" /> {t("col.indicators")}
                    </div>
                  </th>
                  <th className="min-w-[108px] whitespace-nowrap px-3 py-1.5 font-medium text-center">{t("col.bns")}</th>
                  <Th onClick={() => toggleSort("score")} active={sortKey === "score"} dir={sortDir} className="text-center">{t("col.score")}</Th>
                  <th className="px-3 py-1.5 font-medium text-center">
                    <div className="flex items-center justify-center gap-1.5">
                      <RotateCcw className="h-3.5 w-3.5" /> {t("col.reversal")}
                    </div>
                  </th>
                  <th className="px-3 py-1.5 font-medium text-center" title={t("pattern.title")}>{t("col.pattern")}</th>
                  <th className="px-3 py-1.5 pe-4 text-end font-medium">{t("col.signal")}</th>
                  {fundRankColumn && <th className="px-3 py-1.5 pe-4 text-end font-medium" data-testid="col-fund-rank">{t("col.fundRank")}</th>}
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 && !loading && (
                  <tr>
                    <td colSpan={fundRankColumn ? 12 : 11} className="py-16 text-center text-zinc-500">
                      {rows.length > 0 ? (
                        t("empty.filtered")
                      ) : (
                        <span className="inline-flex flex-col items-center gap-1">
                          <span className="text-sm text-zinc-300">{t("empty.title", { customer: id.customer.shortName })}</span>
                          {!error && <span className="text-xs">{t("empty.body")}</span>}
                        </span>
                      )}
                    </td>
                  </tr>
                )}
                {visible.map((r) => {
                  // v2.8 (WP21): disagreement mark only with the opt-in ribbon on; the score is the one the list shows.
                  const ftState = listRibbonOn ? fundTrends.get(`${r.src}|${r.pair}`) : undefined;
                  const dis = ftState && !("na" in ftState) ? disagreement(r.confluence.score, ftState.value) : 0;
                  return (
                  <tr
                    key={r.pair}
                    onClick={() => setDetailAsset(r)}
                    data-ft-disagree={dis !== 0 ? String(dis) : undefined}
                    className={`border-t border-zinc-800/70 hover:bg-zinc-800/40 cursor-pointer transition-colors focus-within:bg-zinc-800/40${dis !== 0 ? " ft-row-disagree" : ""}`}
                  >
                    <td className="px-3 py-1.5 text-center text-zinc-500 text-xs">{r.rank}</td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <AssetLogo symbol={r.symbol} />
                        {/* v2.1: a real button keeps the row's cells readable to screen readers (no role=button on <tr>). */}
                        <button
                          type="button"
                          onClick={(event) => { event.stopPropagation(); setDetailAsset(r); }}
                          title={t("row.openDetails")}
                          className="rounded text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                        >
                          <span className="block font-semibold text-zinc-100 leading-tight">
                            {r.symbol}
                            {r.assetClass !== "crypto" && (
                              <span className="ms-1 rounded border border-zinc-700 px-1 align-middle text-[9px] font-normal uppercase text-zinc-400">{t(`ac.${r.assetClass}`)}</span>
                            )}
                            {r.underlyingClosed && (
                              <span className="ms-1 rounded border border-amber-500/40 px-1 align-middle text-[9px] font-normal text-amber-300" title={t("ac.sessionNote")}>{t("ac.closed")}</span>
                            )}
                            {r.freshness !== "live" && <FreshnessBadge row={r} t={t} formatDate={rsl.i18n.formatDate} />}
                          </span>
                          <span className="block text-[10px] text-zinc-500 leading-tight">{r.pair}</span>
                          <span className="sr-only">{t("row.openDetails")}</span>
                        </button>
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-zinc-200">
                      {showPrice(r.price)}
                    </td>
                    <td className={`px-3 py-1.5 text-right font-mono tabular-nums ${r.change24h >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                      {fmtPct(r.change24h)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-zinc-400">
                      {showVolume(r.quoteVolume)}{scanMeta.approx?.includes(r.pair) ? " ≈" : ""}
                    </td>
                    <td className="px-3 py-1.5 min-w-[160px] max-w-[220px]">
                      {r.confluence.indicators.length > 0 ? (
                        <IndicatorBar c={r.confluence} />
                      ) : (
                        <span className="text-xs text-zinc-600">{t("sig.insufficient")}</span>
                      )}
                    </td>
                    <td className="min-w-[108px] whitespace-nowrap px-3 py-1.5 text-center">
                      <span className="inline-flex flex-row items-center justify-center gap-1 font-mono text-xs">
                        <span className="text-emerald-400">{r.confluence.bull}</span>
                        <span className="text-zinc-600">/</span>
                        <span className="text-zinc-400">{r.confluence.neutral}</span>
                        <span className="text-zinc-600">/</span>
                        <span className="text-rose-400">{r.confluence.bear}</span>
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      <ScorePill score={r.confluence.score} />
                      {dis !== 0 && <FundDisagreeMark key={`${r.src}|${r.pair}|${r.klines.at(-1)?.time ?? 0}|${dis}`} pairKey={`${r.src}|${r.pair}`}
                        bar={r.klines.at(-1)?.time ?? 0} dir={dis} mode={fundPulse} label={t("ft.disagree")} />}
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      <ReversalBadge r={r.reversal} />
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      <PatternBadge pattern={r.pattern} />
                    </td>
                    <td className="px-3 py-1.5 text-right pr-4">
                      <MasterBadge c={r.confluence} />
                    </td>
                    {fundRankColumn && (
                      <td className="px-3 py-1.5 pe-4 text-end font-mono text-xs tabular-nums text-zinc-300" data-testid="cell-fund-rank">
                        {listFundRanks?.get(r.pair) ?? "—"}
                      </td>
                    )}
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      {/* v2.5.1: update notice (ADR-0012) — in the column above the footer, so the footer stays last. */}
      <UpdateNotice />

      {/* ---------- Footer — one thin line ---------- */}
      <footer
        className="shrink-0 border-t border-zinc-800 bg-zinc-950"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <StatusFooter>
          {health && health.source === dataSource && (
            <span
              data-testid="source-health"
              data-state={health.state}
              className={`whitespace-nowrap ${health.state === "ok" ? "text-emerald-400" : health.state === "slow" ? "text-zinc-300" : "text-amber-300"}`}
              title={health.state === "blocked" ? t("health.blockedHelp") : health.state === "network-blocked" ? t("health.networkBlockedHelp") : undefined}
            >
              {t("health.label", { source: selectedSource.label })}: {health.state === "rate-limited"
                ? t("health.rateLimited", { time: new Date(health.until ?? Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })
                : t(`health.${{ ok: "ok", slow: "slow", blocked: "blocked", "network-blocked": "networkBlocked", stale: "stale" }[health.state]}`)}
            </span>
          )}
          <Legend />
        </StatusFooter>
      </footer>
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
      <LedgerDialog
        open={ledgerOpen}
        onOpenChange={setLedgerOpen}
        store={ledgerStore}
        source={dataSource}
        timeframe={timeframe}
        assetClass={assetClass}
        getLiveKlines={getLiveKlines}
        configId={activeConfigId}
      />
      <PaperDialog
        open={paperOpen}
        onOpenChange={setPaperOpen}
        store={paperStore}
        rows={paperRows}
        source={dataSource}
        timeframe={timeframe}
        engineConfigId={activeConfigId}
        slippage={paperSlippage.source === dataSource ? paperSlippage.readings : undefined}
        depeg={scanMeta.source === dataSource ? scanMeta.depeg : undefined}
        quoteBySymbol={scanMeta.source === dataSource ? scanMeta.quoteBySymbol : undefined}
        fetchKlines={fetchPaperKlines}
        cooldownMs={paperCooldownMs}
        sourceLabels={SOURCE_LABELS}
      />

      {/* v2.8 (WP25): market radar. The tab portals to document.body (outside header, main and footer). It contacts no host until opened. */}
      <RadarHost port={rsl.port} depeg={scanMeta.depeg} depegSource={scanMeta.source} depegAt={scanMeta.depegAt} recordRadar={recordRadar} providerLink={providerLink} />

      {/* ---------- Detail modal ---------- */}
      <Dialog open={!!detailAsset} onOpenChange={(o) => { if (!o) { setChartReplay(false); setDetailAsset(null); } }}>
        <DialogContent
          className="w-[min(100vw-1.5rem,56rem)] max-w-[min(100vw-1.5rem,56rem)] max-h-[92dvh] overflow-y-auto overflow-x-hidden border-zinc-800 bg-zinc-900 p-4 text-zinc-100 sm:p-5"
        >
          <DialogHeader>
            <DialogTitle className="flex min-w-0 flex-wrap items-center justify-between gap-2 pr-8 text-base">
              <span className="flex items-center gap-2">
                {detailAsset && <AssetLogo symbol={detailAsset.symbol} size={30} />}
                {detailAsset?.symbol}
                <Badge variant="outline" className="text-zinc-500 border-zinc-700 font-mono">
                  {detailAsset?.pair}
                </Badge>
                <Badge variant="outline" className="text-zinc-500 border-zinc-700 font-normal">
                  {timeframe}
                </Badge>
                {detailAsset && detailAsset.freshness !== "live" && <FreshnessBadge row={detailAsset} t={t} formatDate={rsl.i18n.formatDate} />}
              </span>
              {detailAsset && !chartReplay && <MasterBadge c={detailAsset.confluence} />}
            </DialogTitle>
          </DialogHeader>
          {detailAsset && (
            <div className="min-w-0 space-y-3">
              {!chartReplay && <>
              {/* key stats row */}
              <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4">
                <MiniStat label="Price" value={showPrice(detailAsset.price)} />
                <MiniStat label="24h Change" value={fmtPct(detailAsset.change24h)} tone={detailAsset.change24h >= 0 ? "up" : "down"} />
                <MiniStat label="24h Volume" value={showVolume(detailAsset.quoteVolume)} />
                <MiniStat label="Confluence" value={`${detailAsset.confluence.score > 0 ? "+" : ""}${detailAsset.confluence.score}`} tone={detailAsset.confluence.score > 0 ? "up" : detailAsset.confluence.score < 0 ? "down" : undefined} />
                {scanMeta.source === "coinsph" && scanMeta.premium[detailAsset.pair] !== undefined && (
                  <MiniStat label={t("ph.premium")} value={`${scanMeta.premium[detailAsset.pair] > 0 ? "+" : ""}${scanMeta.premium[detailAsset.pair].toFixed(2)} %`} />
                )}
              </div>
              {scanMeta.source === "coinsph" && scanMeta.premium[detailAsset.pair] !== undefined && (
                <p className="text-[10px] text-zinc-500">{t("ph.premiumHelp")}</p>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Database className="h-4 w-4 shrink-0 text-cyan-400" />
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-zinc-200">Saved market history</div>
                    <div className="truncate text-[10px] text-zinc-500">
                      {detailAsset.klines.length.toLocaleString()} closed bars · {detailAsset.klines[0] ? new Date(detailAsset.klines[0].time).toLocaleDateString() : "none"} to present
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Select value={chartDepth} onValueChange={(value) => setChartDepth(value as StoredChartDepth)}>
                    <SelectTrigger aria-label="Chart history depth" className="h-8 w-[108px] border-zinc-700 bg-zinc-900 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="border-zinc-700 bg-zinc-900">
                      <SelectItem value="60">60 bars</SelectItem>
                      <SelectItem value="250">250 bars</SelectItem>
                      <SelectItem value="1000">1K bars</SelectItem>
                      <SelectItem value="all">All saved</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 border-cyan-500/30 bg-cyan-500/5 text-xs text-cyan-300 hover:bg-cyan-500/10"
                    disabled={historyLoading}
                    onClick={() => void backfillHistory(detailAsset)}
                  >
                    {historyLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <History className="h-3.5 w-3.5" />}
                    {historyLoading ? "Backfilling…" : "Load 5K older"}
                  </Button>
                </div>
                {historyError && <div className="w-full text-xs text-rose-400">{historyError}</div>}
              </div>

              </>}
              {/* price chart */}
              {detailAsset.klines.length > 2 && <button type="button" onClick={() => setChartReplay(!chartReplay)}
                className="rounded border border-zinc-700 px-2 py-1 text-sm">{chartReplay ? "Close chart replay" : "Open chart replay"}</button>}
              {chartReplay ? (
                <ChartReplay key={detailAsset.pair} candles={detailAsset.klines}
                  visible={chartDepth === "all" ? Number.MAX_SAFE_INTEGER : Number(chartDepth)}
                  instrument={{ pair: detailAsset.pair, src: detailAsset.src, tf: detailAsset.tf, intervalMs: INTERVAL_MS[detailAsset.tf], assetClass: detailAsset.assetClass }} />
              ) : detailAsset.klines.length > 1 ? (
                <PriceChart
                  formatPrice={showPrice}
                  convertPrice={chartConvert}
                  klines={detailAsset.klines}
                  visible={chartDepth === "all" ? Number.MAX_SAFE_INTEGER : Number(chartDepth)}
                  fundTrend={detailFund?.series}
                  fundTrendNote={detailFund?.note ? t(detailFund.note) : undefined}
                  fundSize={detailFund?.size}
                  panelScores={panelResult && panelResult.key === panelSeriesKey ? panelResult.scores : undefined}
                  panelNote={panelNote}
                  fundRankLabel={detailFundRank}
                  onPanelRange={onPanelRange}
                />
              ) : (
                <div className="flex h-32 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950/50 text-sm text-zinc-500">
                  Chart unavailable — insufficient candle data
                </div>
              )}

              {!chartReplay && <>
              {/* reversal + trend panel */}
              <ReversalPanel r={detailAsset.reversal} />

              <PatternPanel pattern={detailAsset.pattern} />

              <BlocPanel c={detailAsset.confluence} />
              {detailAsset.context && <ContextPanel x={detailAsset.context} />}
              {detailAsset.src === "bybit-perp" && <DerivativesPanel port={rsl.port} pair={detailAsset.pair} />}
              {detailAsset.src === "bybit-perp" && <OrderFlowPanel key={detailAsset.pair} pair={detailAsset.pair} />}
              <FvgPanel c={detailAsset.confluence} fmt={showPrice} />

              {/* key levels */}
              <KeyLevels klines={detailAsset.klines} price={detailAsset.price} fmt={showPrice} />

              {/* indicator breakdown by category */}
              <div className="min-w-0 overflow-hidden rounded-lg border border-zinc-800">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-950 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  <span>Indicator panel · {detailAsset.confluence.validCount} voting</span>
                  <span className="flex items-center gap-2 font-mono normal-case">
                    <span className="text-emerald-400">{detailAsset.confluence.bull}B</span>
                    <span className="text-zinc-600">·</span>
                    <span className="text-zinc-400">{detailAsset.confluence.neutral}N</span>
                    <span className="text-zinc-600">·</span>
                    <span className="text-rose-400">{detailAsset.confluence.bear}S</span>
                  </span>
                </div>
                <CategoryIndicatorList indicators={detailAsset.confluence.indicators} />
                {detailAsset.confluence.warnings.map((warning) => <div key={warning} className="border-t border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{warning}</div>)}
              </div>
              </>}
              {/* v2.8 WP20: required rate credit while the sheet shows values converted with its rates — also with chart
                  replay open (review round 1); none for the default source. */}
              {rateCredit && (
                <p data-testid="fx-credit-detail" className="text-[10px] text-zinc-500">
                  <a href={rateCredit.url} target="_blank" rel="noopener noreferrer" className="text-cyan-300/90 hover:underline">{rateCredit.text}</a>
                </p>
              )}
              {/* v2.8 WP26 (§3.8): plain link to the pair on the venue's own site — the very last thing in the sheet. */}
              {(() => {
                const href = exchangeUrl(detailAsset.src, detailAsset.pair);
                return href ? (
                  <p data-testid="view-on-exchange" className="text-xs">
                    <a href={href} target="_blank" rel="noopener noreferrer" className="text-cyan-300/90 hover:underline">
                      {t("detail.viewOn", { exchange: SOURCE_LABELS[detailAsset.src] ?? detailAsset.src })}
                    </a>
                  </p>
                ) : null;
              })()}
            </div>
          )}
        </DialogContent>
      </Dialog>


      {/* ---------- Reversal warning popup ---------- */}
      <Dialog open={alertsOpen} onOpenChange={setAlertsOpen}>
        <DialogContent className="w-[min(100vw-1.5rem,36rem)] max-w-[min(100vw-1.5rem,36rem)] overflow-x-hidden border-amber-500/40 bg-zinc-900 p-4 text-zinc-100">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-300">
              <AlertTriangle className="h-5 w-5" />
              Reversal Warning
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-zinc-400">
              New active reversal signals detected on {selectedSource.label} / {timeframe}. Review before acting; this is not financial advice.
            </p>
            <div className="max-h-72 overflow-y-auto rounded-lg border border-zinc-800 custom-scroll">
              {reversalAlert.map((r) => (
                <button
                  key={r.pair}
                  type="button"
                  onClick={() => {
                    setDetailAsset(r);
                    setAlertsOpen(false);
                  }}
                  className="flex w-full items-center justify-between gap-3 border-b border-zinc-800 px-3 py-2 text-left last:border-b-0 hover:bg-zinc-800/60"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <AssetLogo symbol={r.symbol} size={26} />
                    <span className="min-w-0">
                      <span className="block font-semibold text-zinc-100">{r.symbol}</span>
                    <span className="block text-xs text-zinc-500">{r.reversal.summary}</span>
                    </span>
                  </span>
                  <span className={`shrink-0 rounded-md border px-2 py-1 text-xs font-semibold ${r.reversal.direction === "UP" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-rose-500/40 bg-rose-500/10 text-rose-300"}`}>
                    {r.reversal.direction === "UP" ? "REV UP" : "REV DOWN"} · {r.reversal.confidence}
                  </span>
                </button>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" className="border-zinc-700 text-zinc-300" onClick={() => { setReversalAlert([]); setAlertsOpen(false); }}>
                Clear alerts
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <PrivateApiDialog open={privateApiOpen} onOpenChange={setPrivateApiOpen} profile={privateApiProfile} onProfileChange={setPrivateApiProfile} providerLink={providerLink} onProviderLinkChange={setProviderLink} />
      {/* custom scrollbar styles */}
      <style jsx global>{`
        body { font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
        /* v2.5: theme colours come from tokens in globals.css (data-theme), not class-substring overrides. */
        @media (max-width: 640px) {
          .market-table th, .market-table td { padding-left: .55rem; padding-right: .55rem; }
          .market-table { min-width: 1080px; }
        }
      `}</style>
    </div>
  );
}

/* ========================================================================== *
 *  Small presentational sub-components
 * ========================================================================== */

/**
 * Compact inline stat. Replaces the four large cards that previously consumed
 * ~100px of vertical space above the table for four numbers.
 */
/** A span whose `title` is always its full text, so anything the layout truncates stays reachable (hover / long press). */
function FullTitle({ children, ...rest }: React.HTMLAttributes<HTMLSpanElement> & { "data-testid"?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => { const el = ref.current; if (el) el.title = (el.textContent ?? "").replace(/\s+/g, " ").trim(); });
  return <span ref={ref} {...rest}>{children}</span>;
}

function StatChip({
  icon, label, value, sub, tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  sub?: string;
  tone?: "emerald" | "rose" | "amber";
}) {
  const valueTone =
    tone === "emerald" ? "text-emerald-400"
    : tone === "rose" ? "text-rose-400"
    : tone === "amber" ? "text-amber-400"
    : "text-zinc-200";
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      {icon}
      <span className="uppercase tracking-wider text-zinc-500">{label}</span>
      <span className={`font-mono font-semibold tabular-nums ${valueTone}`}>{value}</span>
      {sub && <span className="text-zinc-600">{sub}</span>}
    </span>
  );
}

function Th({
  children, onClick, active, dir, className = "",
}: {
  children: React.ReactNode;
  onClick: () => void;
  active: boolean;
  dir: SortDir;
  className?: string;
}) {
  return (
    <th className={`px-3 py-1.5 font-medium ${className}`}>
      <button onClick={onClick} className={`inline-flex items-center gap-1 hover:text-zinc-200 ${active ? "text-zinc-200" : ""}`}>
        {children}
        {active ? (dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 opacity-40" />}
      </button>
    </th>
  );
}

function ScorePill({ score }: { score: number }) {
  const tone = score > 0 ? "text-emerald-400" : score < 0 ? "text-rose-400" : "text-zinc-400";
  const bg = score > 0 ? "bg-emerald-500/10" : score < 0 ? "bg-rose-500/10" : "bg-zinc-700/30";
  return (
    <span className={`inline-block min-w-[52px] rounded px-2 py-0.5 font-mono text-xs font-semibold ${tone} ${bg}`}>
      {score > 0 ? "+" : ""}{score}
    </span>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  const color = tone === "up" ? "text-emerald-400" : tone === "down" ? "text-rose-400" : "text-zinc-200";
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`mt-0.5 text-base font-semibold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

function DetailRow({ ind }: { ind: IndicatorResult }) {
  const tone =
    ind.state === "BULLISH" ? "text-emerald-400" : ind.state === "BEARISH" ? "text-rose-400" : "text-zinc-400";
  const label =
    ind.state === "BULLISH" ? "BULL" : ind.state === "BEARISH" ? "BEAR" : "NEUTRAL";
  return (
    <div className={`flex min-w-0 items-center justify-between gap-2 px-3 py-1.5 text-sm ${ind.valid ? "" : "opacity-50"}`}>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <SignalDot state={ind.state} size={8} />
        <span className="truncate font-medium text-zinc-200">{ind.name}</span>
        {ind.informational && (
          <Badge variant="outline" className="shrink-0 border-zinc-700 px-1 py-0 text-[9px] font-normal text-zinc-500">
            filter
          </Badge>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono text-[10px] text-zinc-500" title={ind.qualityNote ?? ind.detail}>
          {ind.detail}
        </span>
        <span className={`w-11 shrink-0 text-right font-mono text-[11px] font-semibold ${tone}`}>{label}</span>
      </div>
    </div>
  );
}

/** Separate the 21 indicators into chart-category tabs. */
function CategoryIndicatorList({ indicators }: { indicators: IndicatorResult[] }) {
  // v2.1.1: "Structure" (FVG) was computed but had no tab, so it never appeared.
  const categories = ["Trend", "Momentum", "Volatility", "Volume", "Structure"] as const;
  if (indicators.length === 0) {
    return <div className="px-3 py-6 text-center text-sm text-zinc-500">Insufficient data for indicator breakdown</div>;
  }

  const categoryData = categories.map((category) => {
    const items = indicators.filter((indicator) => indicator.category === category);
    return {
      category,
      items,
      bull: items.filter((indicator) => indicator.state === "BULLISH").length,
      neutral: items.filter((indicator) => indicator.state === "NEUTRAL").length,
      bear: items.filter((indicator) => indicator.state === "BEARISH").length,
    };
  });

  return (
    <Tabs defaultValue="Trend" className="gap-0">
      {/* No min-width and no horizontal scroller here: a fixed 480px tab strip
          was the main thing forcing the detail dialog to overflow sideways. */}
      <div className="border-b border-zinc-800 bg-zinc-950/50 px-2 py-1.5">
        <TabsList className="grid h-8 w-full grid-cols-5 bg-zinc-900 p-0.5">
          {categoryData.map(({ category, items }) => (
            <TabsTrigger key={category} value={category} className="min-w-0 gap-1 px-1 text-[11px] data-[state=active]:bg-zinc-800">
              <span className="truncate">{category}</span>
              <span className="rounded bg-zinc-950/70 px-1 font-mono text-[9px] text-zinc-400">{items.length}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {categoryData.map(({ category, items, bull, neutral, bear }) => (
        <TabsContent key={category} value={category} className="mt-0">
          <div className="flex items-center justify-between border-b border-zinc-800/70 bg-zinc-900/60 px-3 py-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{category} indicators</span>
            <span className="font-mono text-[10px]" aria-label={`${bull} bullish, ${neutral} neutral, ${bear} bearish`}>
              <span className="text-emerald-400">{bull}B</span>
              <span className="text-zinc-600"> / </span>
              <span className="text-zinc-400">{neutral}N</span>
              <span className="text-zinc-600"> / </span>
              <span className="text-rose-400">{bear}S</span>
            </span>
          </div>
          {items.length > 0 ? (
            <div className="divide-y divide-zinc-800/40">
              {items.map((indicator) => <DetailRow key={indicator.name} ind={indicator} />)}
            </div>
          ) : (
            <div className="px-3 py-6 text-center text-sm text-zinc-500">No {category.toLowerCase()} indicators available</div>
          )}
        </TabsContent>
      ))}
    </Tabs>
  );
}

const BLOC_LABEL: Record<string, string> = {
  trend: "detail.blocTrend",
  meanReversion: "detail.blocMeanReversion",
  breakout: "detail.blocBreakout",
  flow: "detail.blocFlow",
};

/** v2.1.1: bloc scores and the regime gate were computed but never shown. */
/** v2.3 — context fields recorded with the ledger row. Shown for research; they never change the score. */
function ContextPanel({ x }: { x: Partial<LedgerRow> }) {
  const { t } = useRsl();
  const num = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(d));
  // Symbols are paired with words for screen readers (review S16).
  const items: [string, string, string?][] = [
    ["detail.rs", x.rs === null || x.rs === undefined ? "—" : `${x.rs}`],
    ["detail.beta", num(x.beta)],
    ["detail.htf", x.htf === 1 ? "▲" : x.htf === -1 ? "▼" : x.htf === 0 ? "■" : "—", x.htf === 1 ? t("detail.htfUp") : x.htf === -1 ? t("detail.htfDown") : x.htf === 0 ? t("detail.htfFlat") : undefined],
    ["detail.td", num(x.td)],
    ["detail.mev", x.mev === null || x.mev === undefined ? "—" : `${x.mev > 0 ? "+" : ""}${x.mev.toFixed(1)} h`],
  ];
  if (x.bp !== undefined) items.push(["detail.basis", `${num(x.bp, 3)} %`]);
  if (x.pin) items.push(["detail.pinned", "●", t("detail.yes")]);
  if (x.spl) items.push(["detail.split", "●", t("detail.yes")]);
  if (x.earn) items.push(["detail.earn", "●", t("detail.yes")]);
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">{t("detail.context")}</div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
        {items.map(([k, v, spoken]) => (
          <div key={k} className="flex justify-between gap-2">
            <dt className="text-zinc-400">{t(k)}</dt>
            <dd className="font-mono tabular-nums text-zinc-200">
              {spoken ? <><span aria-hidden="true">{v}</span><span className="sr-only">{spoken}</span></> : v}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function BlocPanel({ c }: { c: ConfluenceResult }) {
  const { t } = useRsl();
  if (!c.blocs.length) return null;
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-semibold uppercase tracking-wider text-zinc-400">{t("detail.blocs")}</span>
        {c.er != null && (
          <span className="font-mono text-zinc-400">
            {t("detail.regime")} {c.er.toFixed(2)} · {t("detail.mrWeight", { pct: Math.round((1 - (c.trendGate ?? 0)) * 100) })}
          </span>
        )}
      </div>
      <div className="grid gap-1.5">
        {c.blocs.map((b) => {
          const pct = Math.round(b.score * 100);
          return (
            <div key={b.bloc} className="grid grid-cols-[8rem_1fr_3.5rem] items-center gap-2 text-xs">
              <span className="truncate text-zinc-300">{t(BLOC_LABEL[b.bloc] ?? b.bloc)}</span>
              <div className="relative h-2 rounded bg-zinc-800" role="img" aria-label={`${t(BLOC_LABEL[b.bloc] ?? b.bloc)} ${pct}`}>
                <div className="absolute inset-y-0 start-1/2 w-px bg-zinc-600" />
                <div
                  className={`absolute inset-y-0 rounded ${pct >= 0 ? "bg-emerald-500/70" : "bg-rose-500/70"}`}
                  style={pct >= 0 ? { insetInlineStart: "50%", width: `${pct / 2}%` } : { insetInlineEnd: "50%", width: `${-pct / 2}%` }}
                />
              </div>
              <span className={`text-end font-mono tabular-nums ${b.weight === 0 ? "text-zinc-500" : pct > 0 ? "text-emerald-400" : pct < 0 ? "text-rose-400" : "text-zinc-400"}`}>
                {pct > 0 ? "+" : ""}{pct}{b.weight < 1 ? ` ×${b.weight.toFixed(1)}` : ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** v2.1.1: FVG confidence modifier, reason and active zones (computed, previously hidden). */
function FvgPanel({ c, fmt: fmtPrice }: { c: ConfluenceResult; fmt: (p: number) => string }) {
  const { t } = useRsl();
  if (c.fvgModifier === undefined) return null;
  const zones = c.fvgZones ?? [];
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-xs">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold uppercase tracking-wider text-zinc-400">{t("detail.fvg")}</span>
        <span className="font-mono text-zinc-300">
          {t("fvg.label")} ×{c.fvgModifier.toFixed(2)}{c.confidence !== undefined ? ` · ${t("detail.confidence")} ${c.confidence}` : ""}
        </span>
      </div>
      {c.fvgReason && <p className="text-zinc-400">{c.fvgReason}</p>}
      {zones.length === 0 ? (
        <p className="mt-1 text-zinc-500">{t("detail.fvgNone")}</p>
      ) : (
        <ul className="mt-1 grid gap-1 sm:grid-cols-2">
          {zones.slice(0, 6).map((z, i) => (
            <li key={`${z.type}-${z.top}-${z.bottom}-${i}`} className="flex justify-between gap-2 rounded bg-zinc-900 px-2 py-1 font-mono tabular-nums">
              <span className={z.type === "bull" ? "text-emerald-400" : "text-rose-400"}>{z.type === "bull" ? t("detail.fvgBull") : t("detail.fvgBear")}</span>
              <span className="text-zinc-300">{fmtPrice(z.bottom)} – {fmtPrice(z.top)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Reversal + current-trend summary panel for the detail modal. */
function ReversalPanel({ r }: { r: ReversalResult }) {
  const trendIcon =
    r.currentTrend === "UPTREND" ? <TrendingUp className="h-4 w-4 text-emerald-400" />
    : r.currentTrend === "DOWNTREND" ? <TrendingDown className="h-4 w-4 text-rose-400" />
    : <Minus className="h-4 w-4 text-zinc-400" />;
  const revActive = r.isReversal && r.direction !== "NONE";
  const revTone = !revActive ? "text-zinc-400"
    : r.direction === "UP" ? "text-emerald-400"
    : "text-rose-400";
  const revBg = !revActive ? "bg-zinc-800/40 border-zinc-700"
    : r.direction === "UP" ? "bg-emerald-500/10 border-emerald-500/40"
    : "bg-rose-500/10 border-rose-500/40";
  return (
    <div className={`rounded-lg border ${revBg} px-3 py-2.5`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <RotateCcw className="h-4 w-4 text-amber-400" />
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Trend & Reversal</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="flex items-center gap-1.5 text-zinc-300">
            {trendIcon}
            <span className="font-medium">{r.currentTrend}</span>
          </span>
          <span className="text-zinc-600">·</span>
          <span className={`flex items-center gap-1.5 font-semibold ${revTone}`}>
            {revActive ? (r.direction === "UP" ? "Reversing ↑" : "Reversing ↓") : "No reversal"}
            {revActive && <span className="text-zinc-500 font-normal">({r.confidence.toLowerCase()})</span>}
          </span>
        </div>
      </div>
      <p className="mt-1.5 text-xs text-zinc-400">{r.summary}</p>
      {r.signals.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {r.signals.map((s, i) => (
            <span
              key={i}
              className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                s.direction === "UP"
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  : "border-rose-500/40 bg-rose-500/10 text-rose-300"
              }`}
              title={s.detail}
            >
              {s.direction === "UP" ? "↑" : "↓"} {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function PatternPanel({ pattern }: { pattern: PatternSignal }) {
  const { t } = useRsl();
  const active = pattern.direction !== "NONE" && pattern.confidence !== "NONE";
  const up = pattern.direction === "UP";
  const tone = !active ? "border-zinc-700 bg-zinc-800/30"
    : up ? "border-cyan-500/40 bg-cyan-500/10"
    : "border-fuchsia-500/40 bg-fuchsia-500/10";
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${tone}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-cyan-400" />
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            {t("pattern.title")}
          </span>
        </div>
        {active ? (
          <span className={`text-sm font-semibold ${up ? "text-cyan-300" : "text-fuchsia-300"}`}>
            {up ? t("pattern.up") : t("pattern.down")} · {pattern.confidence}
          </span>
        ) : (
          <span className="text-xs text-zinc-500">{t(patternAbstainKey(pattern))}</span>
        )}
      </div>
      <p className="mt-1.5 text-xs text-zinc-400">{pattern.summary}</p>
      {pattern.matches > 0 && (
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MiniStat label={t("pattern.analogues")} value={String(pattern.matches)} />
          <MiniStat label={t("pattern.hit")} value={`${Math.round(pattern.winRate * 100)}%`} />
          <MiniStat
            label={t("pattern.mean", { h: pattern.horizonBars })}
            value={fmtPct(pattern.expectedMovePct)}
            tone={pattern.expectedMovePct > 0 ? "up" : pattern.expectedMovePct < 0 ? "down" : undefined}
          />
          <MiniStat label={t("pattern.similarity")} value={`${Math.round(pattern.averageSimilarity * 100)}%`} />
        </div>
      )}
      <p className="mt-2 text-[10px] leading-relaxed text-zinc-600">
        {t("pattern.disclaimer")}
      </p>
    </div>
  );
}

/**
 * Key levels panel: recent high/low, pivot support/resistance, and where the
 * current price sits relative to them. Support/resistance derived from a
 * classic pivot calculation on the last completed swing.
 */
/** v2.7 (WP13.3): which rate converts the prices, from whom, as of when — and its honesty labels. */
function FxInfoLine({ t, native, display, shown, fx, usdtPhp, onSources }: {
  t: (key: string, vars?: Record<string, string | number>) => string;
  native: string; display: string; shown: string; fx: FxTable | null; usdtPhp: number | null; onSources: () => void;
}) {
  const parts: string[] = [];
  if (display !== shown) parts.push(t("fx.unavailable", { code: display, native: shown }));
  // The rate that was applied: shown currency when it is not USD, else the market's own (PHP/EUR → USD).
  // Review v2.7 #3: "Prices in" always names what the table shows.
  const ref = shown !== "USD" ? shown : native;
  if (ref !== "USD") {
    const rate = convert(1, "USD", ref, fx);
    if (Number.isFinite(rate)) {
      if (display === shown) parts.push(t("fx.info", { code: shown, rate: rate >= 100 ? rate.toFixed(2) : rate.toPrecision(5).replace(/0+$/, "").replace(/\.$/, ""), ref }));
      const kind = rateKind(ref);
      parts.push(kind === "peg" ? t("fx.kind.peg", { authority: PEGS[ref].authority }) : kind === "band" ? t("fx.kind.band", { band: BANDS[ref] }) : t(`fx.kind.${kind}`));
      if (fx) {
        parts.push(fx.source === "custom" && fx.custom ? `${t("fx.src.custom")}: ${fx.custom.name}` : t(`fx.src.${fx.source}`));
        if (fx.dates[ref] || fx.asOf) parts.push(t("fx.asOf", { date: fx.dates[ref] ?? fx.asOf }));
      } else if (PEGS[ref]) parts.push(t("fx.src.peg")); // before the first refresh, a peg converts on its own
    }
  }
  if (!parts.length) return null;
  const dev = usdtDeviationPct(fx);
  if (native === "USD" && shown !== "USD") parts.push(t("fx.usdt", { price: dev === undefined ? "—" : `$${(1 + dev / 100).toFixed(4)}` }));
  const stale = isStale(fx);
  const phPrem = impliedUsdtPremiumPct(usdtPhp, "PHP", fx);
  const attribution = fx ? fxSourceInfo(fx.source)?.attribution : undefined;
  return (
    <div data-testid="fx-info" className="shrink-0 border-b border-zinc-800 bg-zinc-900/60 px-4 py-1 text-[11px] text-zinc-400">
      {parts.join(" · ")}
      {attribution && <> · <a href={attribution.url} target="_blank" rel="noopener noreferrer" className="text-cyan-300/90 hover:underline">{attribution.text}</a></>}
      {stale && <span className="ms-2 rounded border border-amber-500/40 px-1 text-amber-300">{t("fx.stale")}</span>}
      {phPrem !== undefined && (
        <span className="ms-2 text-sky-300/90">{t("ph.usdtPremium", { dev: `${phPrem > 0 ? "+" : ""}${phPrem.toFixed(2)} %` })}</span>
      )}
      <button type="button" onClick={onSources} className="ms-2 text-cyan-300/90 underline-offset-2 hover:underline">{t("fx.sources")}</button>
    </div>
  );
}

function KeyLevels({ klines, price, fmt: fmtShown }: { klines: Kline[]; price: number; fmt: (p: number) => string }) {
  const levels = useMemo(() => {
    if (klines.length < 2) return null;
    const win = klines.slice(-20);
    const high = Math.max(...win.map((c) => c.high));
    const low = Math.min(...win.map((c) => c.low));
    // Pivot point from the prior bar's H/L/C — classic floor trader pivots.
    const prev = klines[klines.length - 2];
    const pivot = (prev.high + prev.low + prev.close) / 3;
    const r1 = 2 * pivot - low;
    const s1 = 2 * pivot - high;
    const r2 = pivot + (high - low);
    const s2 = pivot - (high - low);
    return { high, low, pivot, r1, s1, r2, s2 };
  }, [klines]);

  if (!levels) {
    return <div className="rounded-lg border border-zinc-800 px-3 py-2 text-xs text-zinc-500">Key levels unavailable</div>;
  }
  const fmt = fmtShown; // v2.7: one formatter (review #9: 0.5 used to read "5.000e-1")
  const rows: { label: string; val: number; tone: string }[] = [
    { label: "R2", val: levels.r2, tone: "text-rose-300" },
    { label: "R1", val: levels.r1, tone: "text-rose-300/80" },
    { label: "Pivot", val: levels.pivot, tone: "text-zinc-300" },
    { label: "S1", val: levels.s1, tone: "text-emerald-300/80" },
    { label: "S2", val: levels.s2, tone: "text-emerald-300" },
  ];
  return (
    <div className="rounded-lg border border-zinc-800 px-3 py-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Key Levels (20-bar)</span>
        <span className="font-mono text-xs text-zinc-300">
          High <span className="text-emerald-400">{fmt(levels.high)}</span>
          <span className="mx-1.5 text-zinc-600">·</span>
          Low <span className="text-rose-400">{fmt(levels.low)}</span>
        </span>
      </div>
      <div className="mt-2 grid grid-cols-5 gap-1.5">
        {rows.map((row) => {
          const isAbove = price > row.val;
          return (
            <div key={row.label} className="rounded border border-zinc-800 bg-zinc-950/50 px-2 py-1.5 text-center">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">{row.label}</div>
              <div className={`font-mono text-xs font-semibold ${row.tone}`}>{fmt(row.val)}</div>
              <div className={`text-[9px] mt-0.5 ${isAbove ? "text-emerald-500/70" : "text-rose-500/70"}`}>
                {isAbove ? "below price" : "above price"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * v2.8 (WP27): badge text for a display-only row — "updating · bar time" (on-device history while its fetch is
 * queued) or "not updated · bar time" (its fetch failed this scan). Live rows show nothing (layout at rest unchanged).
 */
function FreshnessBadge({ row, t, formatDate }: {
  row: Pick<AssetRow, "freshness" | "klines">;
  t: (key: string, vars?: Record<string, string | number>) => string;
  formatDate: (d: Date | number, opt?: Intl.DateTimeFormatOptions) => string;
}) {
  const bar = row.klines.at(-1)?.time;
  const time = bar ? formatDate(bar, { dateStyle: "short", timeStyle: "short", hour12: false }) : "—";
  const updating = row.freshness === "updating";
  return (
    <span
      data-testid="row-freshness"
      data-state={row.freshness}
      title={t(updating ? "row.updatingHint" : "row.notUpdatedHint")}
      className={`ms-1 whitespace-nowrap rounded border px-1 align-middle text-[9px] font-normal ${updating ? "border-sky-500/40 text-sky-300" : "border-amber-500/40 text-amber-300"}`}
    >
      {t(updating ? "row.updating" : "row.notUpdated", { time })}
    </span>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-3">
      <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-emerald-400" /> Bullish</span>
      <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-zinc-500" /> Neutral</span>
      <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-rose-400" /> Bearish</span>
    </div>
  );
}
