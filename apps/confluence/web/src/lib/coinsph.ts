/**
 * coinsph.ts — v2.6 Coins.ph (Philippines) public market data (ADR-0013, plan WP7).
 * ----------------------------------------------------------------------------
 * Coins.ph Pro serves a Binance-style public API at https://api.pro.coins.ph.
 * Probe PH-1 (docs/research/evidence/coinsph-probe-2026-11-07.json) found:
 *   - no Access-Control-Allow-Origin header → the browser cannot call it
 *     directly; web goes through a same-origin rewrite, native shells through
 *     the adapters' nativeGet() (public-hosts.ts);
 *   - klines rows = the first 11 Binance kline fields (last row = open bar);
 *   - exchangeInfo `status` is lower-case ("trading" / "break");
 *   - the limit header is `x-sapi-used-ip-weight-1m`, so the 120/min/IP limit
 *     (since 16 Mar 2026) is counted in WEIGHT.
 *
 * Rules implemented here:
 *   1. TRANSPORT: native → nativeGet (allowlist enforced by the adapter and
 *      again here); browser → `/x/coinsph/...` same origin; Node → direct.
 *   2. BUDGET: ≤ 100 weight per rolling minute (headroom under 120) and
 *      ≥ 600 ms between requests; the server's own weight header tightens it.
 *   3. OWN COOLDOWN: a 429/418 pauses Coins.ph only, for the full Retry-After
 *      (418 bans can last days). Binance/Bybit/Bitget keep working, and their
 *      cooldowns never block Coins.ph.
 *   4. PESO MARKET: only PHP-quoted pairs are scanned. USDT/PHP and USDC/PHP
 *      are the peso against the dollar (asset class FX). 24 h volume is
 *      converted to USD with Coins.ph's own USDT/PHP price; without that price
 *      nothing is valued in USD and every pair counts as thin.
 *   5. THIN RULE: a pair under COINSPH_MIN_USD_TURNOVER of 24 h turnover is
 *      not scored (counted in `belowFloor`).
 *   6. PH PREMIUM: information only — never an indicator vote.
 * ----------------------------------------------------------------------------
 */
import { COINSPH_ORIGIN, COINSPH_PROXY_PREFIX, isAllowedNativeUrl } from "./public-hosts";

/** Rolling-minute weight budget (Coins.ph allows 120 per IP; keep headroom). */
export const COINSPH_WEIGHT_PER_MIN = 100;
/** Minimum spacing between two Coins.ph requests. */
export const COINSPH_MIN_SPACING_MS = 600;
/** Most pairs scanned per Coins.ph scan. */
export const COINSPH_MAX_ASSETS = 40;
/** Auto-refresh never faster than this for Coins.ph. */
export const COINSPH_MIN_REFRESH_MS = 5 * 60_000;
/** v2.6 start value; recalibrate from the ledger after 30 days (plan WP7.5). */
export const COINSPH_MIN_USD_TURNOVER = 250_000;

/**
 * Request weights (Coins.ph docs where stated; otherwise the conservative
 * Binance-spot equivalent). The full 24 h ticker is 40.
 */
export const COINSPH_WEIGHTS = {
  time: 1,
  exchangeInfo: 10,
  ticker24hAll: 40,
  ticker24hOne: 1,
  priceOne: 1,
  klines: 1,
} as const;

/* ---------------------------------------------------------------- errors */

export type CoinsphFailure = "RATE_LIMIT" | "BLOCKED" | "NETWORK_BLOCKED" | "HTTP" | "PARSE";

export class CoinsphError extends Error {
  readonly kind: CoinsphFailure;
  readonly retryAfterMs: number;
  constructor(kind: CoinsphFailure, message: string, retryAfterMs = 0) {
    super(message);
    this.name = "CoinsphError";
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

/* -------------------------------------------------------------- transport */

export interface NativeResponse {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON when the shell could parse it, otherwise the raw text. */
  body: unknown;
}
export type NativeGet = (url: string, opts?: { signal?: AbortSignal }) => Promise<NativeResponse>;

let nativeGet: NativeGet | null = null;
/** Called once at boot by the shells that have native HTTP (Capacitor, Tauri). */
export function setCoinsphNativeGet(fn: NativeGet | null): void {
  nativeGet = fn;
}

function isNativeShell(): boolean {
  const g = globalThis as unknown as { __TAURI_INTERNALS__?: unknown; Capacitor?: { isNativePlatform?: () => boolean } };
  return !!g.__TAURI_INTERNALS__ || !!g.Capacitor?.isNativePlatform?.();
}

export type CoinsphTransport = "native" | "proxy" | "direct";

/** How this runtime reaches Coins.ph. */
export function coinsphTransport(): CoinsphTransport {
  if (nativeGet) return "native";
  const loc = (globalThis as unknown as { location?: { protocol?: string } }).location;
  if (loc && (loc.protocol === "https:" || loc.protocol === "http:")) return "proxy";
  return "direct";
}

/* ---------------------------------------------------------------- budget */

/** Clock and sleep are injectable so tests can simulate long schedules. */
let clock: () => number = () => Date.now();
let sleeper: (ms: number, signal?: AbortSignal) => Promise<void> = (ms, signal) => sleep(ms, signal);
let spacingMs = COINSPH_MIN_SPACING_MS;
/** Test hook: fake clock / sleep / spacing (pass nothing to restore the real ones). */
export function setCoinsphTimingForTests(t?: { now?: () => number; sleep?: (ms: number) => Promise<void>; spacingMs?: number }): void {
  clock = t?.now ?? (() => Date.now());
  sleeper = t?.sleep ?? ((ms, signal) => sleep(ms, signal));
  spacingMs = t?.spacingMs ?? COINSPH_MIN_SPACING_MS;
}

let cooldownUntil = 0;
let lastRequestAt = 0;
let spent: { t: number; w: number }[] = [];
/** Earliest time the server-reported weight window allows another request. */
let serverWindowUntil = 0;

export function coinsphCooldown(now = clock()): number {
  return Math.max(0, cooldownUntil - now);
}
/** Test hook. */
export function resetCoinsphForTests(): void {
  cooldownUntil = 0;
  lastRequestAt = 0;
  spent = [];
  serverWindowUntil = 0;
  exchangeInfoCache = null;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (ms <= 0) return resolve();
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      reject(new DOMException("Scan superseded", "AbortError"));
    }, { once: true });
  });

/** Wait until `weight` fits the rolling minute and the spacing rule. */
export function budgetWaitMs(weight: number, now = clock()): number {
  spent = spent.filter((s) => now - s.t < 60_000);
  let wait = Math.max(0, lastRequestAt + spacingMs - now, serverWindowUntil - now);
  let used = spent.reduce((a, s) => a + s.w, 0);
  // Drop the oldest entries until the new request fits.
  for (const s of spent) {
    if (used + weight <= COINSPH_WEIGHT_PER_MIN) break;
    used -= s.w;
    wait = Math.max(wait, s.t + 60_000 - now);
  }
  return wait;
}

/** Weight spent in the current rolling minute (for tests and the status line). */
export function coinsphWeightUsed(now = clock()): number {
  return spent.filter((s) => now - s.t < 60_000).reduce((a, s) => a + s.w, 0);
}

async function acquire(weight: number, signal?: AbortSignal): Promise<void> {
  for (;;) {
    const wait = budgetWaitMs(weight);
    if (wait <= 0) break;
    await sleeper(wait, signal);
  }
  const now = clock();
  lastRequestAt = now;
  spent.push({ t: now, w: weight });
}

function noteCooldown(ms: number): void {
  cooldownUntil = Math.max(cooldownUntil, clock() + ms);
}

function retryAfterMs(headers: Record<string, string>, status: number): number {
  const h = Number(headers["retry-after"]);
  if (Number.isFinite(h) && h > 0) return h * 1000;
  return status === 418 ? 600_000 : 60_000;
}

/** Normalise any header shape to lower-case keys. */
function lowerHeaders(h: Headers | Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (typeof (h as Headers).forEach === "function" && typeof (h as Headers).get === "function") {
    (h as Headers).forEach((v, k) => { out[k.toLowerCase()] = v; });
  } else {
    for (const [k, v] of Object.entries(h as Record<string, string>)) out[k.toLowerCase()] = String(v);
  }
  return out;
}

/**
 * GET a Coins.ph public path ("/openapi/...?..."), within budget, through the
 * transport this runtime allows. Throws CoinsphError; never touches the other
 * venues' cooldown.
 */
export async function coinsphGet(pathAndQuery: string, weight: number, signal?: AbortSignal): Promise<unknown> {
  const absolute = COINSPH_ORIGIN + pathAndQuery;
  if (!isAllowedNativeUrl(absolute)) throw new CoinsphError("HTTP", `Coins.ph path not allowed: ${pathAndQuery.split("?")[0]}`);
  const wait = coinsphCooldown();
  if (wait > 0) throw new CoinsphError("RATE_LIMIT", `Coins.ph rate limit: paused for ${Math.ceil(wait / 1000)} s to protect your IP.`, wait);
  if (isNativeShell() && !nativeGet) throw new CoinsphError("HTTP", "Coins.ph: native connection not ready yet — refresh in a moment.");
  await acquire(weight, signal);

  const transport = coinsphTransport();
  let status: number;
  let headers: Record<string, string>;
  let body: unknown;
  try {
    if (transport === "native" && nativeGet) {
      const r = await nativeGet(absolute, { signal });
      status = r.status;
      headers = lowerHeaders(r.headers);
      body = r.body;
    } else {
      const url = transport === "proxy" ? COINSPH_PROXY_PREFIX + pathAndQuery : absolute;
      const res = await fetch(url, { cache: "no-store", signal, headers: { accept: "application/json" } });
      status = res.status;
      headers = lowerHeaders(res.headers);
      body = await res.text();
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    // A browser sees CORS refusals, DNS blocks and header-less 429s as the same
    // opaque TypeError; native shells reach here only on real network failure.
    throw new CoinsphError(
      transport === "native" ? "NETWORK_BLOCKED" : "BLOCKED",
      transport === "native" ? "Coins.ph: network blocked or unreachable." : "Coins.ph: blocked or unreachable from this page.",
    );
  }

  const used = Number(headers["x-sapi-used-ip-weight-1m"]);
  if (Number.isFinite(used) && used >= COINSPH_WEIGHT_PER_MIN) serverWindowUntil = clock() + 60_000;

  if (status === 429 || status === 418) {
    const ms = retryAfterMs(headers, status);
    noteCooldown(ms);
    throw new CoinsphError("RATE_LIMIT", `Coins.ph: rate limited (${status}).`, ms);
  }
  if (status === 403) throw new CoinsphError("NETWORK_BLOCKED", "Coins.ph: request refused by its firewall (403).");
  if (transport === "proxy" && (status === 404 || status === 405)) {
    // The rewrite is missing (web files served from another host).
    throw new CoinsphError("BLOCKED", "Coins.ph: this web host has no Coins.ph route — use the published web app, the local launcher or the installed app.");
  }

  let json: unknown = body;
  if (typeof body === "string") {
    try {
      json = JSON.parse(body);
    } catch {
      throw new CoinsphError(status >= 400 ? "HTTP" : "PARSE", `Coins.ph ${status}: unreadable response.`);
    }
  }
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const o = json as { code?: number | string; msg?: string };
    if (o.code !== undefined && Number(o.code) !== 0) {
      if (Number(o.code) === -1003) {
        noteCooldown(60_000);
        throw new CoinsphError("RATE_LIMIT", "Coins.ph: too many requests (-1003).", 60_000);
      }
      throw new CoinsphError("HTTP", `Coins.ph error ${o.code}: ${o.msg ?? ""}`.trim());
    }
  }
  if (status >= 400) throw new CoinsphError("HTTP", `Coins.ph ${status}`);
  return json;
}

/* ---------------------------------------------------------------- symbols */

export interface CoinsphSymbol {
  symbol: string;
  base: string;
  quote: string;
  trading: boolean;
}

let exchangeInfoCache: { at: number; symbols: Map<string, CoinsphSymbol> } | null = null;
const EXCHANGE_INFO_TTL_MS = 6 * 60 * 60_000;
const SAFE = /^[A-Z0-9]{1,20}$/;

export function parseExchangeInfo(json: unknown): Map<string, CoinsphSymbol> {
  const out = new Map<string, CoinsphSymbol>();
  const rows = (json as { symbols?: unknown[] })?.symbols;
  if (!Array.isArray(rows)) throw new CoinsphError("PARSE", "Coins.ph exchangeInfo: no symbol list.");
  for (const r of rows) {
    const s = r as { symbol?: unknown; baseAsset?: unknown; quoteAsset?: unknown; status?: unknown };
    if (typeof s.symbol !== "string" || typeof s.baseAsset !== "string" || typeof s.quoteAsset !== "string") continue;
    const symbol = s.symbol.toUpperCase();
    const base = s.baseAsset.toUpperCase();
    const quote = s.quoteAsset.toUpperCase();
    if (!SAFE.test(base) || !SAFE.test(quote) || symbol !== base + quote) continue;
    out.set(symbol, { symbol, base, quote, trading: String(s.status ?? "").toLowerCase() === "trading" });
  }
  return out;
}

export async function loadCoinsphSymbols(signal?: AbortSignal): Promise<Map<string, CoinsphSymbol>> {
  if (exchangeInfoCache && clock() - exchangeInfoCache.at < EXCHANGE_INFO_TTL_MS) return exchangeInfoCache.symbols;
  const symbols = parseExchangeInfo(await coinsphGet("/openapi/v1/exchangeInfo", COINSPH_WEIGHTS.exchangeInfo, signal));
  exchangeInfoCache = { at: clock(), symbols };
  return symbols;
}

/** USD-pegged stablecoins: a STABLE/PHP pair is the peso against the dollar. */
export const USD_STABLE_BASES = new Set(["USDT", "USDC", "FDUSD", "PYUSD", "USDP", "TUSD", "DAI", "USDE", "USD1", "RLUSD", "USDG"]);

/* ---------------------------------------------------------------- tickers */

export interface RawCoinsphTicker {
  symbol: string;
  lastPrice: string;
  openPrice?: string;
  priceChangePercent?: string;
  quoteVolume?: string;
}

export interface CoinsphRankedPair {
  symbol: string;
  base: string;
  lastPrice: number;
  changePct: number;
  /** 24 h turnover in pesos (venue figure). */
  quoteVolumePhp: number;
  /** 24 h turnover in US dollars, or NaN when no USD/PHP price is available. */
  quoteVolumeUsd: number;
}

export interface CoinsphUniverse {
  /** PHP per 1 USDT (Coins.ph's own last price), or null. */
  usdPhp: number | null;
  /** Every trading PHP pair, ranked by turnover. */
  ranked: CoinsphRankedPair[];
}

/** Rank the PHP market from a 24 h ticker list plus exchangeInfo. Pure. */
export function rankPesoMarket(tickers: RawCoinsphTicker[], symbols: Map<string, CoinsphSymbol>): CoinsphUniverse {
  const bySymbol = new Map(tickers.map((t) => [String(t.symbol).toUpperCase(), t]));
  const px = (s: string) => parseFloat(bySymbol.get(s)?.lastPrice ?? "");
  const usdt = px("USDTPHP");
  const usdc = px("USDCPHP");
  const usdPhp = usdt > 0 ? usdt : usdc > 0 ? usdc : null;
  const ranked: CoinsphRankedPair[] = [];
  for (const info of symbols.values()) {
    if (info.quote !== "PHP" || !info.trading) continue;
    const t = bySymbol.get(info.symbol);
    if (!t) continue;
    const last = parseFloat(t.lastPrice);
    if (!(last > 0)) continue;
    const open = parseFloat(t.openPrice ?? "");
    const pct = parseFloat(t.priceChangePercent ?? "");
    const qvPhp = parseFloat(t.quoteVolume ?? "") || 0;
    ranked.push({
      symbol: info.symbol,
      base: info.base,
      lastPrice: last,
      changePct: Number.isFinite(pct) ? pct : open > 0 ? ((last - open) / open) * 100 : 0,
      quoteVolumePhp: qvPhp,
      quoteVolumeUsd: usdPhp ? qvPhp / usdPhp : Number.NaN,
    });
  }
  ranked.sort((a, b) => b.quoteVolumePhp - a.quoteVolumePhp);
  return { usdPhp, ranked };
}

/** True when a pair clears the thin-market rule (NaN volume never does). */
export function coinsphPassesThinRule(quoteVolumeUsd: number): boolean {
  return Number.isFinite(quoteVolumeUsd) && quoteVolumeUsd >= COINSPH_MIN_USD_TURNOVER;
}

export async function fetchCoinsphUniverse(signal?: AbortSignal): Promise<CoinsphUniverse> {
  const symbols = await loadCoinsphSymbols(signal);
  const raw = await coinsphGet("/openapi/quote/v1/ticker/24hr", COINSPH_WEIGHTS.ticker24hAll, signal);
  if (!Array.isArray(raw)) throw new CoinsphError("PARSE", "Coins.ph 24 h ticker: not a list.");
  return rankPesoMarket(raw as RawCoinsphTicker[], symbols);
}

/* ----------------------------------------------------------------- klines */

/** Coins.ph serves these natively (no 1s); 2d/4d are built from 1d by the caller. */
export const COINSPH_INTERVALS = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M"]);

export interface CoinsphKline {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  takerBuy?: number;
}

/** Parse Coins.ph kline rows (Binance fields 0–10). Rows with bad numbers are dropped. */
export function parseCoinsphKlines(json: unknown): CoinsphKline[] {
  if (!Array.isArray(json)) throw new CoinsphError("PARSE", "Coins.ph klines: not a list.");
  const out: CoinsphKline[] = [];
  for (const r of json as unknown[]) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const k: CoinsphKline = {
      time: Number(r[0]),
      open: parseFloat(String(r[1])),
      high: parseFloat(String(r[2])),
      low: parseFloat(String(r[3])),
      close: parseFloat(String(r[4])),
      volume: parseFloat(String(r[5])),
      ...(r[9] !== undefined ? { takerBuy: parseFloat(String(r[9])) } : {}),
    };
    if ([k.time, k.open, k.high, k.low, k.close, k.volume].every(Number.isFinite)) out.push(k);
  }
  return out;
}

export async function fetchCoinsphKlineRows(
  symbol: string,
  interval: string,
  limit: number,
  signal?: AbortSignal,
  endTime?: number,
): Promise<CoinsphKline[]> {
  if (!COINSPH_INTERVALS.has(interval)) throw new CoinsphError("HTTP", `Coins.ph has no ${interval} candles.`);
  const lim = Math.max(1, Math.min(1000, Math.round(limit)));
  // CCXT note: startTime alone does not page reliably; always anchor on endTime when paging.
  const end = endTime !== undefined ? `&endTime=${Math.floor(endTime)}` : "";
  const json = await coinsphGet(
    `/openapi/quote/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${lim}${end}`,
    COINSPH_WEIGHTS.klines,
    signal,
  );
  return parseCoinsphKlines(json);
}

/* ---------------------------------------------------------------- premium */

/**
 * PH premium, %: how far the peso price sits above (+) or below (−) the global
 * USDT price converted at Coins.ph's own USDT/PHP rate. Information only.
 */
export function phPremiumPct(pricePhp: number, globalUsdt: number, usdPhp: number | null): number | undefined {
  if (!(pricePhp > 0) || !(globalUsdt > 0) || !usdPhp || !(usdPhp > 0)) return undefined;
  return (pricePhp / (globalUsdt * usdPhp) - 1) * 100;
}
