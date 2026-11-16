/**
 * regional.ts — v2.8 Step 4a (plan WP25, Task 2): regional demand premiums and buyer pressure for the market radar.
 *
 * Public market data only: GET, no key, no credentials (R12, R20). No new hosts: Coinbase `/products/{id}/ticker`
 * (CSP-direct), Upbit `/v1/ticker?markets=` and Coins.ph `ticker/price` (both through their relay modules), and
 * Binance spot (`/api/v3/ticker/price`, `/api/v3/klines`) under the spot cooldown. Every request goes through its
 * venue module's own gate and cooldown; a cooling venue is not contacted at all.
 *
 * The radar describes the market through BTC. Context, never a vote: nothing here reaches scoring.
 *
 * Korea premium (spec): Upbit KRW-BTC ÷ (Upbit KRW-USDT × Binance BTCUSDT) − 1. It leaves out the won's own premium on
 * USDT; the panel says so (UI task). US premium: Coinbase BTC-USD ÷ Binance BTCUSDT − 1. PH premium: phPremiumPct.
 */
import { fetchCoinbaseTicker } from "../coinbase";
import { fetchUpbitTickerPrices } from "../upbit";
import { COINSPH_WEIGHTS, coinsphGet, phPremiumPct } from "../coinsph";
import { BINANCE_BASE, RateLimitError, dropUnclosed, fetchJson, venueCooldown } from "../market-client";
import type { Kline } from "../indicators";

export type RegionalSource = "coinbase" | "upbit" | "coinsph" | "binance";

export interface RegionalDemand {
  usPct: number | null;
  krPct: number | null;
  phPct: number | null;
  asOf: number;
  /** Sources that failed or were cooling down; their premiums are null. */
  unavailable: RegionalSource[];
}

export interface BuyerPressure {
  /** Taker-buy share of volume per closed 1h bar, oldest first; null where it cannot be computed. */
  takerShare: (number | null)[];
  sessions: { asia: number; europe: number; us: number };
  asOf: number;
}

const H = 3_600_000;
const WEEK_BARS = 168;
const STANDING_DAYS = 30;
const STANDING_MIN = 20;

let nowFn: () => number = () => Date.now();
/** Test hook: use `fn` (null = the real clock) for `asOf` and the closed-bar test. */
export function setRegionalClockForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}

const isPos = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/* ---------------- pure formulas ---------------- */

/** US premium, %: Coinbase BTC-USD over Binance BTCUSDT. Null unless both prices are positive. */
export function usPremiumPct(coinbaseUsd: number, binanceUsdt: number): number | null {
  if (!isPos(coinbaseUsd) || !isPos(binanceUsdt)) return null;
  return (coinbaseUsd / binanceUsdt - 1) * 100;
}

/** Korea premium, %: (KRW-BTC ÷ (KRW-USDT × Binance BTCUSDT) − 1) × 100. Null unless all three are positive. */
export function koreaPremiumPct(krwBtc: number, krwUsdt: number, binanceUsdt: number): number | null {
  if (!isPos(krwBtc) || !isPos(krwUsdt) || !isPos(binanceUsdt)) return null;
  return (krwBtc / (krwUsdt * binanceUsdt) - 1) * 100;
}

/** Taker-buy volume ÷ volume per bar; null when the volume is not positive or takerBuy is missing or outside 0..volume. */
export function takerShareSeries(klines: Kline[]): (number | null)[] {
  return klines.map((k) => {
    const v = k.volume;
    const t = k.takerBuy;
    if (!isPos(v) || typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > v) return null;
    return t / v;
  });
}

/**
 * Share of the last 7 days' (168 bars') quote volume by the bar's UTC open hour: Asia 00:00–07:59, Europe 08:00–13:59,
 * US 14:00–20:59; 21:00–23:59 counts as Asia (the next session). Shares sum to 1; all zero without volume.
 * Quote volume is the bar's `qv`, else close × volume.
 */
export function sessionVolumes(klines: Kline[]): { asia: number; europe: number; us: number } {
  const bars = [...klines].sort((a, b) => a.time - b.time).slice(-WEEK_BARS);
  const sum = { asia: 0, europe: 0, us: 0 };
  for (const k of bars) {
    const q = typeof k.qv === "number" && Number.isFinite(k.qv) && k.qv >= 0 ? k.qv : k.close * k.volume;
    if (!Number.isFinite(q) || q < 0) continue;
    const hour = new Date(k.time).getUTCHours();
    if (hour >= 8 && hour < 14) sum.europe += q;
    else if (hour >= 14 && hour < 21) sum.us += q;
    else sum.asia += q;
  }
  const total = sum.asia + sum.europe + sum.us;
  return total > 0 ? { asia: sum.asia / total, europe: sum.europe / total, us: sum.us / total } : { asia: 0, europe: 0, us: 0 };
}

/** Median of the last 30 daily premiums; null with fewer than 20 numbers among them. */
export function standingPremiumMedian(dailyPremiums: (number | null)[]): number | null {
  const nums = dailyPremiums.slice(-STANDING_DAYS).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  if (nums.length < STANDING_MIN) return null;
  nums.sort((a, b) => a - b);
  const mid = nums.length >> 1;
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

/* ---------------- fetchers ---------------- */

/** An abort (the signal fired, or an AbortError): the only error the radar fetchers rethrow. */
export const isAbort = (e: unknown, signal?: AbortSignal) => (e instanceof DOMException && e.name === "AbortError") || !!signal?.aborted;

function cooling(venue: "binance"): RateLimitError {
  const wait = venueCooldown(venue);
  return new RateLimitError(`Binance: paused for ${Math.ceil(wait / 1000)} s to protect your IP.`, wait);
}

/** Price from a Binance-style `{symbol, price}` body (or a one-row list). */
function priceOf(j: unknown): number | null {
  const o = Array.isArray(j) ? j[0] : j;
  if (!o || typeof o !== "object") return null;
  const raw = (o as { price?: unknown }).price;
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return isPos(n) ? n : null;
}

async function binanceBtcUsdt(signal?: AbortSignal): Promise<number> {
  if (venueCooldown("binance") > 0) throw cooling("binance");
  const p = priceOf(await fetchJson(`${BINANCE_BASE}/api/v3/ticker/price?symbol=BTCUSDT`, "Binance BTCUSDT price", signal));
  if (p === null) throw new Error("Binance BTCUSDT: no valid price");
  return p;
}

async function coinsphPrice(symbol: "BTCPHP" | "USDTPHP" | "USDCPHP", signal?: AbortSignal): Promise<number> {
  const p = priceOf(await coinsphGet(`/openapi/quote/v1/ticker/price?symbol=${symbol}`, COINSPH_WEIGHTS.priceOne, signal));
  if (p === null) throw new Error(`Coins.ph ${symbol}: no valid price`);
  return p;
}

/**
 * BTC premiums of three regions against Binance spot BTCUSDT. A source that fails or is cooling down lands in
 * `unavailable` and its premium is null; without the Binance price every premium is null and nothing else is
 * requested. Never throws except on an aborted signal.
 */
export async function fetchRegionalDemand(signal?: AbortSignal): Promise<RegionalDemand> {
  const failed = new Set<RegionalSource>();
  const guard = async <T>(source: RegionalSource, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      if (isAbort(e, signal)) throw e;
      failed.add(source);
      return null;
    }
  };
  const result = (usPct: number | null, krPct: number | null, phPct: number | null): RegionalDemand => ({
    usPct, krPct, phPct, asOf: nowFn(),
    unavailable: (["coinbase", "upbit", "coinsph", "binance"] as const).filter((s) => failed.has(s)),
  });

  const binance = await guard("binance", () => binanceBtcUsdt(signal));
  if (binance === null) return result(null, null, null);

  // allSettled: an abort waits for the sibling requests to settle instead of leaving them running.
  const settled = await Promise.allSettled([
    guard("coinbase", () => fetchCoinbaseTicker("BTC-USD", signal)),
    guard("upbit", async () => {
      const m = await fetchUpbitTickerPrices(["KRW-BTC", "KRW-USDT"], signal);
      const btc = m.get("KRW-BTC");
      const usdt = m.get("KRW-USDT");
      if (btc === undefined || usdt === undefined) throw new Error("Upbit ticker: KRW-BTC or KRW-USDT missing");
      return { btc, usdt };
    }),
    guard("coinsph", async () => {
      const btc = await coinsphPrice("BTCPHP", signal);
      // The peso against the dollar, as coinsph.ts does: USDT/PHP, else USDC/PHP.
      let usdPhp: number;
      try {
        usdPhp = await coinsphPrice("USDTPHP", signal);
      } catch (e) {
        if (isAbort(e, signal)) throw e;
        usdPhp = await coinsphPrice("USDCPHP", signal);
      }
      return { btc, usdPhp };
    }),
  ] as const);
  const rejected = settled.find((r) => r.status === "rejected");
  if (rejected && rejected.status === "rejected") throw rejected.reason;
  const [cb, up, ph] = settled.map((r) => (r.status === "fulfilled" ? r.value : null)) as [number | null, { btc: number; usdt: number } | null, { btc: number; usdPhp: number } | null];

  const usPct = cb === null ? null : usPremiumPct(cb, binance);
  const krPct = up === null ? null : koreaPremiumPct(up.btc, up.usdt, binance);
  const phRaw = ph === null ? undefined : phPremiumPct(ph.btc, binance, ph.usdPhp);
  return result(usPct, krPct, phRaw === undefined || !Number.isFinite(phRaw) ? null : phRaw);
}

/**
 * Buyer pressure from one request: Binance spot BTCUSDT 1h, the newest 168 closed bars (169 requested so the bar
 * still forming is dropped). Throws on a cooldown (no request), a failure or no closed bar.
 */
export async function fetchBuyerPressure(signal?: AbortSignal): Promise<BuyerPressure> {
  if (venueCooldown("binance") > 0) throw cooling("binance");
  const raw = await fetchJson(`${BINANCE_BASE}/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=${WEEK_BARS + 1}`, "Binance BTCUSDT 1h klines", signal);
  if (!Array.isArray(raw)) throw new Error("Binance klines: unexpected response (no row array)");
  const parsed: Kline[] = [];
  for (const r of raw as unknown[]) {
    if (!Array.isArray(r)) continue;
    const time = Number(r[0]);
    const [open, high, low, close, volume] = [1, 2, 3, 4, 5].map((i) => parseFloat(String(r[i])));
    if (![time, open, high, low, close, volume].every(Number.isFinite)) continue;
    const qv = r[7] !== undefined ? Number(r[7]) : NaN;
    const tb = r[9] !== undefined ? Number(r[9]) : NaN;
    parsed.push({ time, open, high, low, close, volume, ...(Number.isFinite(tb) ? { takerBuy: tb } : {}), ...(Number.isFinite(qv) ? { qv } : {}) });
  }
  const closed = dropUnclosed(parsed, H, nowFn()).slice(-WEEK_BARS);
  if (!closed.length) throw new Error("Binance BTCUSDT: no closed 1h bars returned");
  return { takerShare: takerShareSeries(closed), sessions: sessionVolumes(closed), asOf: nowFn() };
}
