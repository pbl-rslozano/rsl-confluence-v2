/**
 * Data-provider key profiles (v2.8 WP25 part 2): Whale Alert and CoinGlass.
 *
 * These are a different kind from exchange keys. They read public-style market context, cannot trade, and so have no
 * read-only/write distinction; the exchange read-only refusal in exchange-auth.mjs is untouched. A key is checked once
 * at connect and then held in the gateway's memory only.
 *
 * Nothing thrown from here carries a URL, a key or upstream text: the Whale Alert key sits in the socket URL, so every
 * failure is replaced with one of two fixed messages.
 */
import { randomUUID } from "node:crypto";
import { maskApiKey } from "./exchange-auth.mjs";

export const PROVIDER_IDS = Object.freeze(["whale-alert", "coinglass"]);

const REJECTED = "The provider rejected the key test.";
const TIMED_OUT = "The provider did not answer the key test in time.";

export function validateProviderCredentials(value) {
  if (!value || typeof value !== "object") throw new Error("Invalid provider payload.");
  if (!PROVIDER_IDS.includes(value.provider)) throw new Error("Unsupported data provider.");
  const apiKey = typeof value.apiKey === "string" ? value.apiKey.trim() : "";
  if (apiKey.length < 8 || apiKey.length > 256 || !/^[\x21-\x7e]+$/.test(apiKey)) throw new Error("Invalid apiKey.");
  return {
    provider: value.provider,
    label: typeof value.label === "string" && value.label.trim() ? value.label.trim().slice(0, 80) : `${value.provider} key`,
    apiKey,
  };
}

/** CoinGlass v4. The host is written literally so tools/check-egress.mjs can verify it. */
export function buildCoinglassRequest(apiKey, path = "/api/etf/bitcoin/list") {
  return {
    url: "https://open-api-v4.coinglass.com" + path,
    options: { method: "GET", headers: { "CG-API-KEY": apiKey, accept: "application/json" } },
  };
}

/** Whale Alert WebSocket Alerts API. The key is part of this URL: never log it or put it in a message. */
export function whaleAlertUrl(apiKey) {
  return "wss://leviathan.whale-alert.io/ws?api_key=" + encodeURIComponent(apiKey);
}

async function verifyCoinglass({ apiKey }, fetcher, timeoutMs) {
  const request = buildCoinglassRequest(apiKey);
  let response;
  try {
    response = await fetcher(request.url, { ...request.options, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(error?.name === "TimeoutError" || error?.name === "AbortError" ? TIMED_OUT : REJECTED);
  }
  if (!response?.ok) {
    try { await response?.body?.cancel(); } catch { /* body already released */ } // free the connection
    throw new Error(REJECTED);
  }
  const payload = await response.json().catch(() => null);
  if (!payload || payload.code !== "0") throw new Error(REJECTED);
  return { ok: true };
}

function verifyWhaleAlert({ apiKey }, WebSocketCtor, timeoutMs) {
  return new Promise((resolve, reject) => {
    let ws = null;
    let timer = null;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* already closed */ }
      if (error) reject(error); else resolve({ ok: true });
    };
    try {
      ws = new WebSocketCtor(whaleAlertUrl(apiKey));
    } catch {
      finish(new Error(REJECTED));
      return;
    }
    timer = setTimeout(() => finish(new Error(TIMED_OUT)), timeoutMs);
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ type: "subscribe_alerts", id: "rsl-verify", min_value_usd: 1_000_000_000 }));
      } catch {
        finish(new Error(REJECTED));
      }
    };
    ws.onmessage = (event) => {
      let message = null;
      try { message = JSON.parse(String(event?.data)); } catch { return; }
      if (message && typeof message === "object") {
        if ("error" in message) finish(new Error(REJECTED));
        else if (message.type === "subscribed_alerts") finish(null);
      }
    };
    ws.onerror = () => finish(new Error(REJECTED));
    ws.onclose = () => finish(new Error(REJECTED));
  });
}

export function verifyProvider(creds, { fetcher = fetch, WebSocketCtor = globalThis.WebSocket, timeoutMs = 10_000 } = {}) {
  if (creds?.provider === "coinglass") return verifyCoinglass(creds, fetcher, timeoutMs);
  if (creds?.provider === "whale-alert") return verifyWhaleAlert(creds, WebSocketCtor, timeoutMs);
  return Promise.reject(new Error("Unsupported data provider."));
}

export function createProviderProfile(creds) {
  return {
    id: randomUUID(),
    kind: "provider",
    provider: creds.provider,
    label: creds.label,
    maskedKey: maskApiKey(creds.apiKey),
    connectedAt: new Date().toISOString(),
  };
}
