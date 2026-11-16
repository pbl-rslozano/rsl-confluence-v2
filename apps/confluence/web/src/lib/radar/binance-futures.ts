/**
 * binance-futures.ts — v2.8 Step 4a (plan WP25, Task 1): Binance USDⓈ-M futures positioning for the market radar.
 *
 * Public market data only: GET, no key, no credentials, no account or order endpoint (R12, R20). The host
 * (fapi.binance.com) answers cross-origin (probe RD-PROBE-1), so it is fetched directly and listed in CSP_HOSTS.
 * The venue "binance-fut" is a rate venue with its own cooldown and its own gate; it is not a scan source.
 *
 * Context, never a vote: nothing here reaches scoring.
 *
 * Gate: one sliding window of 400 requests per 5 minutes for the whole venue. Documented IP limits
 * (developers.binance.com, USDⓈ-M futures; checked 16 Nov 2026): REQUEST_WEIGHT 2400 per minute (the example in the
 * exchangeInfo response; the live value is in `rateLimits`), /futures/data/* 1000 requests per 5 minutes per IP,
 * and GET /fapi/v1/fundingRate 500 per 5 minutes per IP (shared with fundingInfo). The strictest is 500 per
 * 5 minutes, so the venue gate is 80 % of it, which also keeps every other limit far away.
 */
import { FAPI_BASE, RateLimitError, basisPct, noteVenueRateLimit, venueCooldown } from "../market-client";
import { createRateGate, realClock, type RateClock, type RateGate } from "../rate-gate";

export interface FuturesPositioning {
  symbol: string;
  /** Last funding rate as a fraction (0.0001 = 0.01 %). */
  fundingRate: number | null;
  /** Percent (0–100) of the last 90 funding samples (30 days at 8 h) that are ≤ the current rate. */
  fundingPctl30d: number | null;
  /** Open interest, newest 1h sample, in base-coin units. */
  oi: number | null;
  oiChg24hPct: number | null;
  /** Global long/short account ratio, newest 1h sample. */
  longShortRatio: number | null;
  /** Taker buy/sell volume ratio, newest 1h sample. */
  takerBuySellRatio: number | null;
  /** Perpetual mark over index, percent. */
  basisPct: number | null;
  /** Newest data timestamp (ms) among the endpoints that answered. */
  asOf: number;
}

export const FUTURES_GATE_LIMIT = 400;
export const FUTURES_GATE_WINDOW_MS = 300_000;
const FUNDING_SAMPLES = 90;
const H = 3_600_000;

let clock: RateClock = realClock;
let gate: RateGate = createRateGate(FUTURES_GATE_LIMIT, FUTURES_GATE_WINDOW_MS, clock);
/** Test hook: use `c` (null = the real clock) for pacing, with a fresh gate. */
export function setFuturesClockForTests(c: RateClock | null): void {
  clock = c ?? realClock;
  gate = createRateGate(FUTURES_GATE_LIMIT, FUTURES_GATE_WINDOW_MS, clock);
}
/** Test hook: a fresh gate on the current clock. */
export function resetFuturesForTests(): void {
  setFuturesClockForTests(clock === realClock ? null : clock);
}

function cooldownError(): RateLimitError {
  const wait = venueCooldown("binance-fut");
  return new RateLimitError(`Binance futures: paused for ${Math.ceil(wait / 1000)} s to protect your IP.`, wait);
}

/** Cooldown check, gate, cooldown check again (a 429 may have landed meanwhile), then one GET. */
async function fapiGet(pathAndQuery: string, label: string, signal?: AbortSignal): Promise<unknown> {
  if (venueCooldown("binance-fut") > 0) throw cooldownError();
  await gate.take(signal);
  if (venueCooldown("binance-fut") > 0) throw cooldownError();
  const res = await fetch(`${FAPI_BASE}${pathAndQuery}`, { cache: "no-store", credentials: "omit", redirect: "error", signal });
  if (res.status === 429 || res.status === 418) {
    const header = Number(res.headers.get("retry-after"));
    const retryAfterMs = Number.isFinite(header) && header > 0 ? header * 1000 : res.status === 418 ? 600_000 : 60_000;
    const err = new RateLimitError(`${label}: rate limited (Binance futures ${res.status}).`, retryAfterMs);
    noteVenueRateLimit("binance-fut", err);
    throw err;
  }
  if (!res.ok) throw new Error(`${label} ${res.status}`);
  return (await res.json()) as unknown;
}

/** A finite number from a number or numeric string, else null. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const positive = (v: unknown): number | null => { const n = num(v); return n !== null && n > 0 ? n : null; };
const nonNegative = (v: unknown): number | null => { const n = num(v); return n !== null && n >= 0 ? n : null; };
const rows = (j: unknown): Record<string, unknown>[] =>
  Array.isArray(j) ? j.filter((r): r is Record<string, unknown> => !!r && typeof r === "object") : [];

/** Percent of the samples ≤ `current` (0–100); null with fewer than 90 valid samples or a bad current. */
export function fundingPercentile(history: number[], current: number): number | null {
  if (!Number.isFinite(current)) return null;
  const h = history.filter((x) => Number.isFinite(x));
  if (h.length < FUNDING_SAMPLES) return null;
  return (h.filter((x) => x <= current).length / h.length) * 100;
}

/** (newest / sample 24 h earlier − 1) · 100; needs a sample within ±1 h of 24 h before the newest, else null. */
export function oiChange24h(hist: { t: number; oi: number }[]): number | null {
  const ok = hist.filter((r) => Number.isFinite(r.t) && Number.isFinite(r.oi));
  if (ok.length < 2) return null;
  const newest = ok.reduce((a, b) => (b.t > a.t ? b : a));
  const target = newest.t - 24 * H;
  let best: { t: number; oi: number } | null = null;
  for (const r of ok) {
    if (Math.abs(r.t - target) > H) continue;
    if (!best || Math.abs(r.t - target) < Math.abs(best.t - target)) best = r;
  }
  if (!best || !(best.oi > 0) || newest.oi < 0) return null;
  return (newest.oi / best.oi - 1) * 100;
}

function newestRow(j: unknown): Record<string, unknown> | null {
  const r = rows(j);
  return r.length ? r.reduce((a, b) => ((num(b.timestamp) ?? 0) > (num(a.timestamp) ?? 0) ? b : a)) : null;
}

/** Positioning of one perpetual: five GETs; a failing endpoint leaves its fields null; a rate limit throws. */
export async function fetchFuturesPositioning(symbol: "BTCUSDT" | "ETHUSDT", signal?: AbortSignal): Promise<FuturesPositioning> {
  if (symbol !== "BTCUSDT" && symbol !== "ETHUSDT") throw new Error(`${String(symbol)}: not a radar perpetual`);
  const s = encodeURIComponent(symbol);
  const calls = {
    premium: `/fapi/v1/premiumIndex?symbol=${s}`,
    funding: `/fapi/v1/fundingRate?symbol=${s}&limit=${FUNDING_SAMPLES}`,
    oi: `/futures/data/openInterestHist?symbol=${s}&period=1h&limit=25`,
    ls: `/futures/data/globalLongShortAccountRatio?symbol=${s}&period=1h&limit=1`,
    taker: `/futures/data/takerlongshortRatio?symbol=${s}&period=1h&limit=1`,
  } as const;
  const got: Partial<Record<keyof typeof calls, unknown>> = {};
  let answered = 0;
  for (const k of Object.keys(calls) as (keyof typeof calls)[]) {
    try {
      got[k] = await fapiGet(calls[k], `Binance futures ${k} ${symbol}`, signal);
      answered++;
    } catch (e) {
      if (e instanceof RateLimitError || (e instanceof DOMException && e.name === "AbortError") || signal?.aborted) throw e;
    }
  }
  if (!answered) throw new Error(`${symbol}: Binance futures positioning unavailable`);

  const times: number[] = [];
  const note = (t: unknown) => { const n = num(t); if (n !== null && n > 0) times.push(n); };

  const p = got.premium && typeof got.premium === "object" && !Array.isArray(got.premium) ? (got.premium as Record<string, unknown>) : null;
  const fundingRate = p ? num(p.lastFundingRate) : null;
  const mark = p ? positive(p.markPrice) : null;
  const index = p ? positive(p.indexPrice) : null;
  const basis = mark !== null && index !== null ? basisPct(String(mark), String(index)) ?? null : null;
  if (p) note(p.time);

  const hist = rows(got.funding).map((r) => num(r.fundingRate)).filter((x): x is number => x !== null);
  const fundingPctl30d = fundingRate !== null ? fundingPercentile(hist, fundingRate) : null;

  // The newest sample decides: a bad newest value gives null, not an older sample's value.
  const oiAll = rows(got.oi).map((r) => ({ t: num(r.timestamp), oi: num(r.sumOpenInterest) })).filter((r): r is { t: number; oi: number } => r.t !== null && r.oi !== null);
  const newestOi = oiAll.length ? oiAll.reduce((a, b) => (b.t > a.t ? b : a)) : null;
  const oiOk = newestOi !== null && newestOi.oi >= 0;
  if (newestOi) note(newestOi.t);

  const ls = newestRow(got.ls);
  const tk = newestRow(got.taker);
  if (ls) note(ls.timestamp);
  if (tk) note(tk.timestamp);

  return {
    symbol,
    fundingRate,
    fundingPctl30d,
    oi: oiOk ? newestOi.oi : null,
    oiChg24hPct: oiOk ? oiChange24h(oiAll.filter((r) => r.oi >= 0)) : null,
    longShortRatio: ls ? positive(ls.longShortRatio) : null,
    takerBuySellRatio: tk ? positive(tk.buySellRatio) : null,
    basisPct: basis,
    asOf: times.length ? Math.max(...times) : clock.now(),
  };
}
