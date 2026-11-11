/**
 * fixtures.mjs — deterministic, offline exchange + Telegram/webhook mock.
 *
 * Bars are a pure function of (symbol, bar index since ANCHOR), so two
 * requests that overlap in time always return identical OHLCV — exactly like a
 * real venue's closed bars — and expected ledger rows can be rebuilt
 * independently from `bars()`. The newest returned bar is the one in
 * progress at the (mocked) Date.now(), as every venue does; the engine drops it.
 * Payload shapes follow apps/confluence/web/src/lib/market-client.ts and
 * tools/e2e/acceptance.cjs.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const H = 3_600_000;
export const STEP_4H = 4 * H;
export const ANCHOR = Date.UTC(2025, 0, 1);
/** 30 s after the 12:00 UTC 4 h close on 31 Oct 2026. */
export const T0 = Date.UTC(2026, 9, 31, 12, 0, 30);

export const BINANCE_TICKERS = [
  // symbol, 24h quote volume (descending) — USDC excluded (peg), PAXG commodity, EUR fx.
  ["BTCUSDT", 9e9], ["ETHUSDT", 5e9], ["PAXGUSDT", 3e9], ["SOLUSDT", 2e9], ["USDCUSDT", 1.5e9], ["EURUSDT", 1e9], ["XRPUSDT", 8e8],
];

const series = new Map(); // symbol → number[] closes from ANCHOR

function seedOf(sym) {
  return [...sym].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 100_003, 7);
}

/** OHLCV of bar `idx` (bars since ANCHOR at `step`). */
export function barAt(sym, idx, step = STEP_4H) {
  const key = `${sym}|${step}`;
  let closes = series.get(key);
  if (!closes) series.set(key, (closes = [100 + (seedOf(sym) % 50)]));
  const s = seedOf(sym);
  while (closes.length <= idx + 1) {
    const i = closes.length;
    const r = Math.sin(i * 0.731 + s) * 0.011 + Math.sin(i * 0.117 + s * 0.5) * 0.006 + Math.sin(i * 0.031 + s) * 0.003;
    closes.push(closes[i - 1] * (1 + r));
  }
  const open = closes[idx];
  const close = closes[idx + 1];
  const wig = 1 + (Math.abs(Math.sin(idx * 1.37 + s)) * 0.004);
  return {
    time: ANCHOR + idx * step,
    open,
    high: Math.max(open, close) * wig,
    low: Math.min(open, close) / wig,
    close,
    volume: 1000 + ((idx * 37 + s) % 900),
    // Binance reports taker-buy base volume (kline field 9); used only by the v2.3 taker-delta context field.
    takerBuy: 300 + ((idx * 53 + s) % 500),
  };
}

/** Closed bars with open times in [fromOpen, toOpen] (inclusive). */
export function bars(sym, fromOpen, toOpen, step = STEP_4H) {
  const out = [];
  for (let t = fromOpen; t <= toOpen; t += step) out.push(barAt(sym, Math.round((t - ANCHOR) / step), step));
  return out;
}

/** Open time of the bar in progress at `now`. */
export const currentOpen = (now = Date.now(), step = STEP_4H) => ANCHOR + Math.floor((now - ANCHOR) / step) * step;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * @param {object} [o]
 * @param {(url: URL) => Response | undefined} [o.override]  return a Response to replace the default
 * @param {[string, number][]} [o.binanceTickers]
 * @param {object[]} [o.bybitLinear]   raw Bybit linear ticker objects
 * @param {object[]} [o.bybitInstruments]
 * @param {(sym: string) => object} [o.openInterest]  Bybit open-interest payload per symbol
 * @param {(req: { url: URL, body: any, headers: any }) => Response} [o.telegram]
 * @param {(req: { url: URL, body: any }) => Response} [o.webhook]
 */
export function mockExchange(o = {}) {
  const calls = [];
  async function fetchMock(input, init = {}) {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({ url: url.href, host: url.host, path: url.pathname, method, symbol: url.searchParams.get("symbol") });
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const custom = o.override?.(url, init);
    if (custom) return custom;

    if (url.host === "api.telegram.org") {
      const body = init.body ? JSON.parse(init.body) : null;
      return o.telegram ? o.telegram({ url, body, headers: init.headers }) : json({ ok: true, result: { message_id: calls.length } });
    }
    if (url.host.endsWith(".test")) {
      return o.webhook ? o.webhook({ url, body: init.body ? JSON.parse(init.body) : null }) : new Response("", { status: 204 });
    }

    const limit = Math.min(1000, Number(url.searchParams.get("limit") || 200));
    if (url.host === "data-api.binance.vision") {
      if (url.pathname === "/api/v3/ticker/24hr") {
        return json((o.binanceTickers ?? BINANCE_TICKERS).map(([symbol, qv]) => ({ symbol, openPrice: "100", lastPrice: "101", quoteVolume: String(qv) })));
      }
      if (url.pathname === "/api/v3/klines") {
        const step = { "1h": H, "4h": STEP_4H, "1d": 24 * H }[url.searchParams.get("interval")] ?? STEP_4H;
        const cur = currentOpen(Date.now(), step);
        const list = bars(url.searchParams.get("symbol"), cur - (limit - 1) * step, cur, step);
        return json(list.map((b) => [b.time, String(b.open), String(b.high), String(b.low), String(b.close), String(b.volume), b.time + step - 1, "0", 10, String(b.takerBuy), "0", "0"]));
      }
    }
    if (url.host === "api.bybit.com") {
      if (url.pathname === "/v5/market/tickers") {
        return json({ retCode: 0, retMsg: "OK", result: { category: url.searchParams.get("category"), list: o.bybitLinear ?? [] } });
      }
      if (url.pathname === "/v5/market/instruments-info") {
        return json({ retCode: 0, retMsg: "OK", result: { list: o.bybitInstruments ?? [], nextPageCursor: "" } });
      }
      if (url.pathname === "/v5/market/kline") {
        const step = { "60": H, "240": STEP_4H, D: 24 * H }[url.searchParams.get("interval")] ?? STEP_4H;
        const cur = currentOpen(Date.now(), step);
        const list = bars(url.searchParams.get("symbol"), cur - (limit - 1) * step, cur, step).reverse(); // Bybit: newest first
        return json({ retCode: 0, retMsg: "OK", result: { list: list.map((b) => [String(b.time), String(b.open), String(b.high), String(b.low), String(b.close), String(b.volume), "0"]) } });
      }
      if (url.pathname === "/v5/market/open-interest") {
        const sym = url.searchParams.get("symbol");
        return json(o.openInterest ? o.openInterest(sym) : { retCode: 0, result: { symbol: sym, list: [{ openInterest: "12345.5", timestamp: String(currentOpen(Date.now(), H)) }] } });
      }
    }
    return json({ code: -1, msg: `no mock for ${url.host}${url.pathname}` }, 404);
  }
  return { fetch: fetchMock, calls };
}

export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "rsl-recorder-test-"));
  t?.after?.(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function baseConfig(outDir, extra = {}) {
  return {
    source: "binance",
    tf: "4h",
    limit: 3,
    assetClass: "crypto",
    outDir,
    once: true,
    intervalSeconds: 0,
    graceMs: 20_000,
    catchUpMax: 12,
    derivs: "auto",
    oiTop: 2,
    fetchTimeoutMs: 5_000,
    ...extra,
  };
}

export const quiet = { log: () => {}, pause: async () => {}, sleepUntil: async () => {} };
