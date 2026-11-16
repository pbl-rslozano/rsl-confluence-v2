/**
 * stablecoins.ts — v2.8 Step 4a (plan WP25, Task 3): total stablecoin supply (USD-pegged) from DefiLlama, for the
 * market radar. Daily series; the app asks once per UTC day and caches the result.
 *
 * Public data only: GET, no key, no credentials (R12, R20). Host stablecoins.llama.fi answered a cross-origin fetch
 * from the deployed app's own origin (probe RD-PROBE-1) and is listed in CSP_HOSTS. The free path is
 * /stablecoincharts/all (the api.llama.fi/stablecoin* paths answered 404 in the probe).
 *
 * Context, never a vote: nothing here reaches scoring.
 *
 * Gate: DefiLlama publishes no hard public limit for this endpoint, so the gate is a deliberately conservative
 * 2 requests per 10 s for this host. A 429 starts a cooldown held in this module (not the venue map in
 * market-client: it is not an exchange and nothing else needs to read it).
 */
import { RateLimitError } from "../market-client";
import { createRateGate, realClock, type RateClock, type RateGate } from "../rate-gate";

export const LLAMA_BASE = "https://stablecoins.llama.fi";
export interface SupplyPoint { day: number; usd: number }

export const LLAMA_GATE_LIMIT = 2;
export const LLAMA_GATE_WINDOW_MS = 10_000;
const DEFAULT_COOLDOWN_MS = 60_000;
const DAY_MS = 86_400_000;

let clock: RateClock = realClock;
let gate: RateGate = createRateGate(LLAMA_GATE_LIMIT, LLAMA_GATE_WINDOW_MS, clock);
let cooldownUntil = 0;
/** Test hook: use `c` (null = the real clock) for pacing and cooldown, with a fresh gate and no cooldown. */
export function setLlamaClockForTests(c: RateClock | null): void {
  clock = c ?? realClock;
  gate = createRateGate(LLAMA_GATE_LIMIT, LLAMA_GATE_WINDOW_MS, clock);
  cooldownUntil = 0;
}
/** Test hook: a fresh gate and no cooldown on the current clock. */
export function resetLlamaForTests(): void {
  setLlamaClockForTests(clock === realClock ? null : clock);
}
/** Remaining cooldown of the DefiLlama host in ms (0 = none). */
export function llamaCooldown(): number {
  return Math.max(0, cooldownUntil - clock.now());
}
function cooling(): RateLimitError {
  const wait = llamaCooldown();
  return new RateLimitError(`DefiLlama: paused for ${Math.ceil(wait / 1000)} s.`, wait);
}

/**
 * `[{ date: "<unix seconds>", totalCirculatingUSD: { peggedUSD: n, … }, … }]` → one point per UTC day, ascending.
 * Drops entries with a missing, non-finite or negative supply or a bad date. For a repeated day the last entry in
 * the array wins. A non-array gives [].
 */
export function parseSupply(json: unknown): SupplyPoint[] {
  if (!Array.isArray(json)) return [];
  const byDay = new Map<number, number>();
  for (const item of json) {
    if (!item || typeof item !== "object") continue;
    const o = item as { date?: unknown; totalCirculatingUSD?: unknown };
    const secRaw = typeof o.date === "string" && o.date.trim() !== "" ? Number(o.date) : typeof o.date === "number" ? o.date : NaN;
    if (!Number.isFinite(secRaw) || secRaw <= 0) continue;
    const pegged = o.totalCirculatingUSD && typeof o.totalCirculatingUSD === "object" ? (o.totalCirculatingUSD as { peggedUSD?: unknown }).peggedUSD : undefined;
    if (typeof pegged !== "number" || !Number.isFinite(pegged) || pegged < 0) continue;
    const day = Math.floor((secRaw * 1000) / DAY_MS) * DAY_MS;
    byDay.set(day, pegged);
  }
  return [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([day, usd]) => ({ day, usd }));
}

/** The whole daily series (cooldown check, gate, cooldown check, one GET). */
export async function fetchStablecoinSupply(signal?: AbortSignal): Promise<SupplyPoint[]> {
  if (llamaCooldown() > 0) throw cooling();
  await gate.take(signal);
  if (llamaCooldown() > 0) throw cooling();
  const res = await fetch(`${LLAMA_BASE}/stablecoincharts/all`, { cache: "no-store", credentials: "omit", redirect: "error", signal, headers: { accept: "application/json" } });
  if (res.status === 429) {
    const header = Number(res.headers.get("retry-after"));
    const retryAfterMs = Number.isFinite(header) && header > 0 ? header * 1000 : DEFAULT_COOLDOWN_MS;
    cooldownUntil = Math.max(cooldownUntil, clock.now() + retryAfterMs);
    throw new RateLimitError("DefiLlama: rate limited (429).", retryAfterMs);
  }
  if (!res.ok) throw new Error(`DefiLlama stablecoin supply ${res.status}`);
  return parseSupply((await res.json()) as unknown);
}
