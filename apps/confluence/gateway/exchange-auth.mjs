import { createHmac, randomUUID } from "node:crypto";

const RECV_WINDOW = "5000";

export function hmacHex(secret, value) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function hmacBase64(secret, value) {
  return createHmac("sha256", secret).update(value).digest("base64");
}

export function maskApiKey(apiKey) {
  const clean = String(apiKey || "").trim();
  if (clean.length <= 8) return `${clean.slice(0, 2)}••••${clean.slice(-2)}`;
  return `${clean.slice(0, 4)}••••••${clean.slice(-4)}`;
}

export function buildBinanceAccountRequest({ apiKey, apiSecret, environment, timestamp = Date.now() }) {
  const baseUrl = environment === "testnet" ? "https://testnet.binance.vision" : "https://api.binance.com";
  const query = new URLSearchParams({ recvWindow: RECV_WINDOW, timestamp: String(timestamp) }).toString();
  const signature = hmacHex(apiSecret, query);
  return {
    url: `${baseUrl}/api/v3/account?${query}&signature=${signature}`,
    options: { method: "GET", headers: { "X-MBX-APIKEY": apiKey } },
  };
}

/**
 * Binance API-KEY permissions (mainnet only; testnet has no /sapi).
 *
 * Build 2.02: `/api/v3/account` reports `canTrade` / `canWithdraw` for the
 * ACCOUNT, not for the API key, so a read-only key used to be labelled
 * "Trading enabled · withdraw". The key's own restrictions live here.
 */
export function buildBinanceApiRestrictionsRequest({ apiKey, apiSecret, timestamp = Date.now() }) {
  const query = new URLSearchParams({ recvWindow: RECV_WINDOW, timestamp: String(timestamp) }).toString();
  const signature = hmacHex(apiSecret, query);
  return {
    url: `https://api.binance.com/sapi/v1/account/apiRestrictions?${query}&signature=${signature}`,
    options: { method: "GET", headers: { "X-MBX-APIKEY": apiKey } },
  };
}

/** Map Binance apiRestrictions flags to the profile's permission summary. */
export function binanceKeyPermissions(restrictions) {
  const r = restrictions || {};
  const flags = [
    ["enableReading", "read"],
    ["enableSpotAndMarginTrading", "spot-margin-trade"],
    ["enableMargin", "margin"],
    ["enableFutures", "futures"],
    ["enableVanillaOptions", "options"],
    ["enableWithdrawals", "withdraw"],
    ["enableInternalTransfer", "internal-transfer"],
    ["permitsUniversalTransfer", "universal-transfer"],
    ["enablePortfolioMarginTrading", "portfolio-margin"],
  ];
  const permissions = flags.filter(([key]) => r[key] === true).map(([, label]) => label);
  const writes = permissions.filter((p) => p !== "read");
  return { readOnly: writes.length === 0, permissions };
}

export function buildBybitProfileRequest({ apiKey, apiSecret, environment, timestamp = Date.now() }) {
  const baseUrl = environment === "testnet" ? "https://api-testnet.bybit.com" : "https://api.bybit.com";
  const payload = `${timestamp}${apiKey}${RECV_WINDOW}`;
  const signature = hmacHex(apiSecret, payload);
  return {
    url: `${baseUrl}/v5/user/query-api`,
    options: {
      method: "GET",
      headers: {
        "X-BAPI-API-KEY": apiKey,
        "X-BAPI-SIGN": signature,
        "X-BAPI-TIMESTAMP": String(timestamp),
        "X-BAPI-RECV-WINDOW": RECV_WINDOW,
      },
    },
  };
}

/**
 * Bitget signs timestamp + method + requestPath + queryString. The current
 * endpoint takes no parameters, so an omitted queryString happened to produce a
 * valid signature — and would have silently started producing invalid ones the
 * moment anyone added a query parameter. The concatenation is explicit now, and
 * pinned by a test.
 */
export function buildBitgetProfileRequest({ apiKey, apiSecret, passphrase, timestamp = Date.now(), queryString = "" }) {
  const requestPath = "/api/v2/spot/account/info";
  const suffix = queryString ? `?${queryString}` : "";
  const payload = `${timestamp}GET${requestPath}${suffix}`;
  const signature = hmacBase64(apiSecret, payload);
  return {
    url: "https://api.bitget.com" + requestPath + suffix, // host written literally for the egress check (R11)
    options: {
      method: "GET",
      headers: {
        "ACCESS-KEY": apiKey,
        "ACCESS-SIGN": signature,
        "ACCESS-TIMESTAMP": String(timestamp),
        "ACCESS-PASSPHRASE": passphrase,
        "Content-Type": "application/json",
        locale: "en-US",
      },
    },
  };
}

function safeMessage(payload, fallback) {
  if (!payload || typeof payload !== "object") return fallback;
  const candidate = payload.msg || payload.message || payload.retMsg || payload.error;
  return typeof candidate === "string" && candidate.length < 240 ? candidate : fallback;
}

async function fetchPrivate(request) {
  const response = await fetch(request.url, {
    ...request.options,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Exchange rejected the credential test (${response.status}): ${safeMessage(payload, "authentication failed")}`);
  return payload;
}

export async function verifyCredentials(credentials, fetcher = fetchPrivate) {
  const base = {
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    environment: credentials.environment,
  };

  if (credentials.provider === "binance") {
    // Proves the key authenticates (both environments).
    await fetcher(buildBinanceAccountRequest(base));
    if (credentials.environment !== "mainnet") {
      // Testnet has no key-restrictions endpoint: report "unknown" rather than
      // guessing from account-level flags.
      return { readOnly: null, permissions: ["testnet: key permissions not reported"] };
    }
    try {
      const restrictions = await fetcher(buildBinanceApiRestrictionsRequest(base));
      return binanceKeyPermissions(restrictions);
    } catch {
      return { readOnly: null, permissions: ["key permissions unavailable"] };
    }
  }

  if (credentials.provider === "bybit") {
    const payload = await fetcher(buildBybitProfileRequest(base));
    if (payload.retCode !== 0) throw new Error(`Exchange rejected the credential test: ${safeMessage(payload, "authentication failed")}`);
    const result = payload.result || {};
    const permissions = Object.entries(result.permissions || {})
      .flatMap(([group, values]) => Array.isArray(values) && values.length ? [`${group}:${values.join("/")}`] : [])
      .slice(0, 12);
    return { readOnly: result.readOnly === 1, permissions };
  }

  if (credentials.provider === "bitget") {
    const payload = await fetcher(buildBitgetProfileRequest({ ...base, passphrase: credentials.passphrase }));
    if (payload.code !== "00000") throw new Error(`Exchange rejected the credential test: ${safeMessage(payload, "authentication failed")}`);
    const permissions = Array.isArray(payload.data?.authorities) ? payload.data.authorities : [];
    const hasWrite = permissions.some((value) => typeof value === "string" && value.endsWith("w"));
    // An empty or missing authority list is unknown, never read-only.
    if (permissions.length === 0) return { readOnly: null, permissions };
    return { readOnly: !hasWrite, permissions };
  }

  throw new Error("Unsupported private API provider.");
}

export function createProfile(credentials, verification) {
  return {
    id: randomUUID(),
    provider: credentials.provider,
    environment: credentials.environment,
    label: credentials.label,
    maskedKey: maskApiKey(credentials.apiKey),
    connectedAt: new Date().toISOString(),
    readOnly: typeof verification.readOnly === "boolean" ? verification.readOnly : null,
    permissions: verification.permissions || [],
  };
}

export const REFUSAL_MESSAGE = "This key can trade or its permissions are unknown. Create a read-only key.";

/**
 * Only read-only keys may become profiles. Unknown permissions (readOnly null)
 * are accepted solely on Binance testnet, which has no restrictions endpoint.
 */
export function profileAllowed(credentials, verification) {
  if (verification?.readOnly === true) return { ok: true };
  if (verification?.readOnly === null && credentials?.provider === "binance" && credentials?.environment === "testnet") {
    return { ok: true, label: "permissions not reported" };
  }
  return { ok: false };
}
