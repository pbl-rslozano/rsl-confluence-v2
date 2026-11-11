export type PrivateApiProvider = "binance" | "bybit" | "bitget";
export type PrivateApiEnvironment = "testnet" | "mainnet";

export interface PrivateApiCredentials {
  provider: PrivateApiProvider;
  environment: PrivateApiEnvironment;
  label: string;
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
}

export interface GatewaySession {
  url: string;
  /** Per-session bearer token printed by the gateway on startup. */
  token: string;
}

export interface PrivateApiProfile {
  id: string;
  provider: PrivateApiProvider;
  environment: PrivateApiEnvironment;
  label: string;
  maskedKey: string;
  connectedAt: string;
  readOnly: boolean | null;
  permissions: string[];
  gatewayUrl: string;
  gatewayToken: string;
}

export interface GatewayHealth {
  ok: boolean;
  service: string;
  profiles: number;
}

export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8787";

export function normalizeGatewayUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function isLoopbackGateway(value: string): boolean {
  try {
    const url = new URL(normalizeGatewayUrl(value));
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function authHeaders(token: string, json = false): HeadersInit {
  const headers: Record<string, string> = { Authorization: `Bearer ${token.trim()}` };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

async function parseGatewayResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) {
    throw new Error(payload.error || `Gateway request failed (${response.status})`);
  }
  return payload;
}

export async function checkGateway(session: GatewaySession): Promise<GatewayHealth> {
  const base = normalizeGatewayUrl(session.url);
  if (!isLoopbackGateway(base)) throw new Error("Gateway must use localhost or 127.0.0.1 over HTTP.");
  if (!session.token.trim()) throw new Error("Paste the gateway token printed in the gateway console.");
  const response = await fetch(`${base}/health`, {
    cache: "no-store",
    headers: authHeaders(session.token),
    signal: AbortSignal.timeout(5_000),
  });
  return parseGatewayResponse<GatewayHealth>(response);
}

export async function connectPrivateApi(
  session: GatewaySession,
  credentials: PrivateApiCredentials,
): Promise<PrivateApiProfile> {
  const base = normalizeGatewayUrl(session.url);
  if (!isLoopbackGateway(base)) throw new Error("Gateway must use localhost or 127.0.0.1 over HTTP.");
  if (!session.token.trim()) throw new Error("Paste the gateway token printed in the gateway console.");
  const response = await fetch(`${base}/connect`, {
    method: "POST",
    headers: authHeaders(session.token, true),
    body: JSON.stringify(credentials),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await parseGatewayResponse<{
    profile: Omit<PrivateApiProfile, "gatewayUrl" | "gatewayToken">;
  }>(response);
  return { ...payload.profile, gatewayUrl: base, gatewayToken: session.token.trim() };
}

export async function disconnectPrivateApi(profile: PrivateApiProfile): Promise<void> {
  const response = await fetch(`${profile.gatewayUrl}/profiles/${encodeURIComponent(profile.id)}`, {
    method: "DELETE",
    cache: "no-store",
    headers: authHeaders(profile.gatewayToken),
    signal: AbortSignal.timeout(5_000),
  });
  await parseGatewayResponse<{ ok: boolean }>(response);
}

