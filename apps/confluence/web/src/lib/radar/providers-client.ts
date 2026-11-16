/**
 * Web side of the gateway's data-provider routes (v2.8 Step 4b): US spot ETF flows and large transfers.
 * Context only: nothing here reaches scoring or any order path. The web trusts nothing from the gateway: every field is
 * re-validated with the gateway's own rules, and anything invalid is dropped, never thrown. Errors are fixed codes
 * ("gateway:401", "gateway:409", "gateway:unavailable"): no upstream text, URL or key is ever surfaced.
 */
import { isLoopbackGateway, normalizeGatewayUrl, type ProviderLink } from "../private-api";

export interface EtfFlow { ticker: string; flowUsd: number }
export interface EtfDay { date: string; totalUsd: number; flows: EtfFlow[] }
export interface EtfLive { asOf: number; btc: EtfDay[]; eth: EtfDay[] }
export interface WhaleAlert {
  t: number;
  chain: string;
  kind: string;
  from: string;
  to: string;
  symbol: string;
  amount: number;
  valueUsd: number;
  hash: string;
}

const MAX_DAYS = 30;
const MAX_TICKERS = 20;
const MAX_FLOW_USD = 1e11;
const MAX_ALERTS = 200;
const MAX_VALUE = 1e12;
const WORD = /^[A-Za-z0-9 _.-]{1,32}$/;
const TIMEOUT_MS = 10_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const inRange = (v: unknown): v is number => isNum(v) && v > 0 && v <= MAX_VALUE;
const hasControl = (s: string) => /[\u0000-\u001f\u007f-\u009f]/.test(s);

function toDay(value: unknown): EtfDay | null {
  if (!isObject(value) || typeof value.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) return null;
  if (!Array.isArray(value.flows)) return null;
  const byTicker = new Map<string, EtfFlow>();
  for (const entry of value.flows) {
    if (!isObject(entry) || typeof entry.ticker !== "string" || !/^[A-Z0-9]{1,8}$/.test(entry.ticker)) continue;
    if (!isNum(entry.flowUsd) || Math.abs(entry.flowUsd) > MAX_FLOW_USD) continue;
    byTicker.delete(entry.ticker); // the last flow for a ticker wins
    byTicker.set(entry.ticker, { ticker: entry.ticker, flowUsd: entry.flowUsd });
  }
  const flows = [...byTicker.values()].slice(0, MAX_TICKERS);
  if (flows.length === 0) return null; // a day with no flows is "no data", never a zero day
  return { date: value.date, totalUsd: flows.reduce((sum, f) => sum + f.flowUsd, 0), flows };
}

function toDays(value: unknown): EtfDay[] {
  if (!Array.isArray(value)) return [];
  const byDate = new Map<string, EtfDay>();
  for (const entry of value) {
    const day = toDay(entry);
    if (!day) continue;
    byDate.delete(day.date); // the last day with a date wins
    byDate.set(day.date, day);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).slice(-MAX_DAYS);
}

function toAlert(value: unknown): WhaleAlert | null {
  if (!isObject(value)) return null;
  const { t, chain, kind, from, to, symbol, amount, valueUsd, hash } = value;
  if (!isNum(t) || t <= 0) return null;
  for (const word of [chain, kind, symbol]) if (typeof word !== "string" || !WORD.test(word)) return null;
  for (const text of [from, to]) if (typeof text !== "string" || text.length > 80 || hasControl(text)) return null;
  if (typeof hash !== "string" || !/^[A-Za-z0-9]{0,100}$/.test(hash)) return null;
  if (!inRange(amount) || !inRange(valueUsd)) return null;
  return { t, chain: chain as string, kind: kind as string, from: from as string, to: to as string, symbol: symbol as string, amount, valueUsd, hash };
}

/** The caller's signal plus the timeout. AbortSignal.any is missing on older webviews: fall back to a controller. */
function combine(caller: AbortSignal, timeout: AbortSignal, register: (fn: () => void) => void): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any([caller, timeout]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (caller.aborted || timeout.aborted) controller.abort();
  else {
    caller.addEventListener("abort", abort, { once: true });
    timeout.addEventListener("abort", abort, { once: true });
    register(abort);
  }
  return controller.signal;
}

async function getJson(link: ProviderLink, path: string, signal: AbortSignal): Promise<unknown> {
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), TIMEOUT_MS); // covers the body read too; cleared in finally
  let onAbort: (() => void) | null = null;
  try {
    let response: Response;
    try {
      const base = normalizeGatewayUrl(link.session.url);
      if (!isLoopbackGateway(base) || !link.session.token.trim()) throw new Error("not allowed");
      response = await fetch(`${base}${path}`, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${link.session.token.trim()}` },
        signal: combine(signal, timer.signal, (fn) => { onAbort = fn; }),
      });
    } catch {
      throw new Error("gateway:unavailable"); // the original message is dropped on purpose
    }
    if (response.status === 401) throw new Error("gateway:401");
    if (response.status === 409) throw new Error("gateway:409");
    if (!response.ok) throw new Error("gateway:unavailable");
    try {
      return await response.json();
    } catch {
      throw new Error("gateway:unavailable");
    }
  } finally {
    clearTimeout(timeout);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function fetchEtfLive(link: ProviderLink, signal: AbortSignal): Promise<EtfLive> {
  const payload = await getJson(link, "/providers/etf-flows", signal);
  if (!isObject(payload) || !isNum(payload.asOf)) throw new Error("gateway:unavailable");
  return { asOf: payload.asOf, btc: toDays(payload.btc), eth: toDays(payload.eth) };
}

export async function fetchWhaleAlerts(
  link: ProviderLink,
  minUsd: number,
  signal: AbortSignal,
): Promise<{ connected: boolean; alerts: WhaleAlert[] }> {
  const min = isNum(minUsd) ? Math.round(minUsd) : 1_000_000;
  const payload = await getJson(link, `/providers/whale-alerts?min=${encodeURIComponent(String(min))}`, signal);
  if (!isObject(payload) || !Array.isArray(payload.alerts)) throw new Error("gateway:unavailable");
  const alerts: WhaleAlert[] = [];
  for (const entry of payload.alerts) {
    if (alerts.length >= MAX_ALERTS) break;
    const alert = toAlert(entry);
    if (alert) alerts.push(alert);
  }
  return { connected: payload.connected === true, alerts };
}
