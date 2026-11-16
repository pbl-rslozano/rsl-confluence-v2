/**
 * Data-provider reads for the Radar (v2.8 WP25 part 2): CoinGlass spot ETF flows and a Whale Alert large-transfer stream.
 *
 * Context only: nothing here reaches scoring or any order path. Fetch, WebSocket constructor, clock and timers are
 * injectable so the unit tests need no network. The Whale Alert key is part of the socket URL, so nothing in this file
 * logs, throws or returns text that carries a URL, a key or upstream wording.
 */
import { buildCoinglassRequest, whaleAlertUrl } from "./provider-auth.mjs";

const ETF_DAYS = 30;
const ETF_TICKERS_PER_DAY = 20;
const ETF_MAX_FLOW_USD = 1e11;
const ETF_TIMEOUT_MS = 10_000;
const ETF_CACHE_MS = 60 * 60_000;
const ETF_UNAVAILABLE = "ETF flows unavailable.";

/** One asset. Returns the kept days, or null when the call failed (so the caller can tell "failed" from "no data"). */
async function fetchAsset(apiKey, path, fetcher) {
  const request = buildCoinglassRequest(apiKey, path);
  let response;
  try {
    response = await fetcher(request.url, { ...request.options, cache: "no-store", signal: AbortSignal.timeout(ETF_TIMEOUT_MS) });
  } catch {
    return null;
  }
  if (!response?.ok) {
    try { await response?.body?.cancel(); } catch { /* body already released */ } // free the connection
    return null;
  }
  const payload = await response.json().catch(() => null);
  if (!payload || payload.code !== "0" || !Array.isArray(payload.data)) return null;

  const days = [];
  for (const row of payload.data) {
    const stamp = new Date(typeof row?.timestamp === "number" ? row.timestamp : Number.NaN);
    if (Number.isNaN(stamp.getTime())) continue;
    const flows = [];
    if (Array.isArray(row.etf_flows)) {
      for (const entry of row.etf_flows) {
        if (flows.length >= ETF_TICKERS_PER_DAY) break;
        const ticker = entry?.etf_ticker;
        const flowUsd = entry?.flow_usd;
        if (typeof ticker !== "string" || !/^[A-Z0-9]{1,8}$/.test(ticker)) continue;
        // A missing flow_usd is "no data", never zero.
        if (typeof flowUsd !== "number" || !Number.isFinite(flowUsd) || Math.abs(flowUsd) > ETF_MAX_FLOW_USD) continue;
        flows.push({ ticker, flowUsd });
      }
    }
    days.push({ date: stamp.toISOString().slice(0, 10), totalUsd: flows.reduce((sum, f) => sum + f.flowUsd, 0), flows });
  }
  return days.slice(-ETF_DAYS);
}

/** CoinGlass returns the full history in one call per asset, oldest to newest; the newest 30 days are kept. */
export async function fetchEtfFlows(apiKey, { fetcher = fetch, now = Date.now } = {}) {
  const [btc, eth] = await Promise.all([
    fetchAsset(apiKey, "/api/etf/bitcoin/flow-history", fetcher),
    fetchAsset(apiKey, "/api/etf/ethereum/flow-history", fetcher),
  ]);
  if (btc === null && eth === null) throw new Error(ETF_UNAVAILABLE);
  return { asOf: now(), btc: btc ?? [], eth: eth ?? [] };
}

/** In-memory 1 h cache per profile. Entries are dropped when the profile goes. */
export function createEtfFlowCache({ fetchFlows = fetchEtfFlows, now = Date.now, ttlMs = ETF_CACHE_MS } = {}) {
  const entries = new Map();
  return {
    async get(id, apiKey) {
      const hit = entries.get(id);
      if (hit && now() - hit.at < ttlMs) return hit.value;
      const value = await fetchFlows(apiKey, { now });
      entries.set(id, { at: now(), value });
      return value;
    },
    delete(id) { entries.delete(id); },
    clear() { entries.clear(); },
  };
}

// ---- Whale Alert ----

const WHALE_MIN_USD = 1e6;
const WHALE_MAX_USD = 1e10;
const WHALE_IDLE_MS = 15 * 60_000;
const WHALE_KEEP_MS = 24 * 3_600_000;
const WHALE_KEEP_COUNT = 200;
const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 300_000;
const WORD = /^[A-Za-z0-9 _.-]{1,32}$/;

function clampMin(value) {
  const n = typeof value === "number" && Number.isFinite(value) ? value : WHALE_MIN_USD;
  return Math.min(WHALE_MAX_USD, Math.max(WHALE_MIN_USD, n));
}

function cleanText(value) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 80) : "";
}

function inRange(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1e12;
}

/** One Whale Alert frame to a WhaleAlert, or null when it is not a valid alert. */
function toAlert(message) {
  if (!message || !Array.isArray(message.amounts)) return null;
  let best = null;
  for (const entry of message.amounts) {
    if (!entry || typeof entry.value_usd !== "number" || !Number.isFinite(entry.value_usd)) continue;
    if (!best || entry.value_usd > best.value_usd) best = entry;
  }
  if (!best || !inRange(best.value_usd) || !inRange(best.amount)) return null;
  if (typeof best.symbol !== "string" || !WORD.test(best.symbol)) return null;
  if (typeof message.blockchain !== "string" || !WORD.test(message.blockchain)) return null;
  if (typeof message.transaction_type !== "string" || !WORD.test(message.transaction_type)) return null;
  if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp) || message.timestamp <= 0) return null;
  const hash = message.transaction?.hash;
  return {
    t: message.timestamp * 1000,
    chain: message.blockchain,
    kind: message.transaction_type,
    from: cleanText(message.from),
    to: cleanText(message.to),
    symbol: best.symbol,
    amount: best.amount,
    valueUsd: best.value_usd,
    hash: typeof hash === "string" && /^[A-Za-z0-9]{1,100}$/.test(hash) ? hash : "",
  };
}

/**
 * One lazy Whale Alert stream for one key. The first poll opens the socket; 15 minutes without a poll closes it; a poll
 * with a different clamped minimum reconnects with it. A "not authenticated" frame stops reconnecting until the next poll.
 * poll() returns the last 24 h (at most 200), newest first.
 */
export function createWhaleStream({ apiKey, WebSocketCtor = globalThis.WebSocket, now = Date.now, timers = globalThis } = {}) {
  let ws = null;
  let connected = false;
  let minUsd = null;
  let buffer = [];
  let idleTimer = null;
  let reconnectTimer = null;
  let backoff = BACKOFF_START_MS;
  let halted = false; // authentication failed: no reconnect until the next poll

  const prune = () => {
    const cutoff = now() - WHALE_KEEP_MS;
    buffer = buffer.filter((a) => a.t >= cutoff).slice(-WHALE_KEEP_COUNT);
  };

  const detach = () => {
    const old = ws;
    ws = null;
    connected = false;
    if (old) {
      old.onopen = old.onmessage = old.onerror = old.onclose = null;
      try { old.close(); } catch { /* already closed */ }
    }
  };

  const clearReconnect = () => {
    if (reconnectTimer !== null) timers.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const scheduleReconnect = () => {
    if (reconnectTimer !== null || halted) return;
    const delay = backoff;
    backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
    reconnectTimer = timers.setTimeout(() => { reconnectTimer = null; open(); }, delay);
  };

  function open() {
    clearReconnect();
    detach();
    let socket;
    try {
      socket = new WebSocketCtor(whaleAlertUrl(apiKey));
    } catch {
      scheduleReconnect(); // the thrown message may carry the URL: it is dropped
      return;
    }
    ws = socket;
    const lost = () => {
      if (ws !== socket) return;
      detach();
      scheduleReconnect();
    };
    socket.onopen = () => {
      try {
        socket.send(JSON.stringify({ type: "subscribe_alerts", id: "rsl-radar", min_value_usd: minUsd }));
      } catch {
        lost();
      }
    };
    socket.onmessage = (event) => {
      if (ws !== socket) return;
      let message = null;
      try { message = JSON.parse(String(event?.data)); } catch { return; }
      if (!message || typeof message !== "object") return;
      if ("error" in message) {
        // Upstream text is never surfaced. Only an authentication failure changes behaviour.
        if (typeof message.error === "string" && /not authenticated/i.test(message.error)) {
          halted = true;
          detach();
        }
        return;
      }
      if (message.type === "subscribed_alerts") {
        connected = true;
        backoff = BACKOFF_START_MS;
        return;
      }
      const alert = toAlert(message);
      if (alert) {
        buffer.push(alert);
        prune();
      }
    };
    socket.onerror = lost;
    socket.onclose = lost;
  }

  function close() {
    if (idleTimer !== null) timers.clearTimeout(idleTimer);
    idleTimer = null;
    clearReconnect();
    detach();
    buffer = [];
    backoff = BACKOFF_START_MS;
    halted = false;
    minUsd = null;
  }

  function poll(requested) {
    const wanted = clampMin(requested);
    if (idleTimer !== null) timers.clearTimeout(idleTimer);
    idleTimer = timers.setTimeout(close, WHALE_IDLE_MS);
    halted = false;
    if (wanted !== minUsd) {
      minUsd = wanted;
      backoff = BACKOFF_START_MS;
      open(); // first poll, or a new minimum: reconnect now
    } else if (!ws && reconnectTimer === null) {
      open();
    }
    prune();
    return { connected, alerts: buffer.slice().reverse() };
  }

  return { poll, close };
}
