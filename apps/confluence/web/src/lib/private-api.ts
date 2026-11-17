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


// ---- Data providers (v2.8 Step 4b): paid market-context keys held only by the gateway ----

export type DataProvider = "whale-alert" | "coinglass" | "b2" | "r2";
export type BucketProvider = "b2" | "r2";

export function isBucketProvider(provider: DataProvider): provider is BucketProvider {
  return provider === "b2" || provider === "r2";
}

const BUCKET_NAME_RE = /^[A-Za-z0-9-]{3,63}$/;

export interface ProviderProfile {
  id: string;
  kind: "provider";
  provider: DataProvider;
  label: string;
  maskedKey: string;
  connectedAt: string;
  /** B2 and R2 profiles only: the bucket name (not secret). */
  bucket?: string;
}

/** Gateway session plus the connected provider profiles. Lives in page state only; never persisted. */
export interface ProviderLink {
  session: GatewaySession;
  providers: ProviderProfile[];
}

function requireLoopbackSession(session: GatewaySession): string {
  const base = normalizeGatewayUrl(session.url);
  if (!isLoopbackGateway(base)) throw new Error("Gateway must use localhost or 127.0.0.1 over HTTP.");
  if (!session.token.trim()) throw new Error("Paste the gateway token printed in the gateway console.");
  return base;
}

/** The gateway is trusted for nothing: a profile is kept only when every field has the expected shape. */
function toProviderProfile(value: unknown): ProviderProfile | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  if (typeof p.id !== "string" || p.id.length === 0 || p.id.length > 100) return null;
  if (p.kind !== "provider") return null;
  if (p.provider !== "whale-alert" && p.provider !== "coinglass" && p.provider !== "b2" && p.provider !== "r2") return null;
  const bucket = p.provider === "b2" || p.provider === "r2";
  if (bucket && (typeof p.bucket !== "string" || !BUCKET_NAME_RE.test(p.bucket))) return null;
  if (typeof p.label !== "string" || typeof p.maskedKey !== "string" || typeof p.connectedAt !== "string") return null;
  return {
    id: p.id,
    kind: "provider",
    provider: p.provider,
    label: p.label.slice(0, 80),
    maskedKey: p.maskedKey.slice(0, 40),
    connectedAt: p.connectedAt.slice(0, 40),
    ...(bucket ? { bucket: p.bucket as string } : {}),
  };
}

/** Provider calls: 401 and network failures become fixed codes (no upstream text); other errors keep the gateway's message. */
async function providerRequest<T>(url: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, cache: "no-store" });
  } catch {
    throw new Error("gateway:unavailable");
  }
  if (response.status === 401) throw new Error("gateway:401");
  return parseGatewayResponse<T>(response);
}

export const PROVIDER_LINK_STALE_MESSAGE = "The gateway restarted or the token changed. Provider keys must be added again.";

export function isStaleGatewayError(reason: unknown): boolean {
  return reason instanceof Error && (reason.message === "gateway:401" || reason.message === "gateway:unavailable");
}

export type ProviderLinkEvent =
  | { type: "connected"; session: GatewaySession; profile: ProviderProfile }
  | { type: "disconnected"; id: string }
  | { type: "listed"; session: GatewaySession; providers: ProviderProfile[] }
  | { type: "gateway-lost" }
  | { type: "checked"; session: GatewaySession };

function sameSession(a: GatewaySession, b: GatewaySession): boolean {
  return normalizeGatewayUrl(a.url) === normalizeGatewayUrl(b.url) && a.token.trim() === b.token.trim();
}

/**
 * Pure link transitions. A change the gateway already made is applied locally; a re-list is only a refresh (when it
 * fails nothing is dispatched and the local result stands). A 401 or network failure, or a check against a different
 * session, drops a stale link.
 */
export function nextProviderLink(link: ProviderLink | null, event: ProviderLinkEvent): ProviderLink | null {
  switch (event.type) {
    case "connected": {
      if (!link || !sameSession(link.session, event.session)) return { session: event.session, providers: [event.profile] };
      return { session: link.session, providers: [...link.providers.filter((p) => p.id !== event.profile.id), event.profile] };
    }
    case "disconnected": {
      if (!link) return null;
      const providers = link.providers.filter((p) => p.id !== event.id);
      return providers.length > 0 ? { session: link.session, providers } : null;
    }
    case "listed":
      return event.providers.length > 0 ? { session: event.session, providers: event.providers } : null;
    case "gateway-lost":
      return null;
    case "checked":
      return link && sameSession(link.session, event.session) ? link : null;
  }
}

/** A key-only provider, or a bucket-restricted key pair for B2 (region) or R2 (account id). */
export type ProviderConnectInput =
  | { provider: "whale-alert" | "coinglass"; label: string; apiKey: string }
  | { provider: "b2"; label: string; accessKeyId: string; secretAccessKey: string; bucket: string; region: string }
  | { provider: "r2"; label: string; accessKeyId: string; secretAccessKey: string; bucket: string; accountId: string };

/** Exactly the fields the gateway reads, in a fixed order; nothing else the caller holds is sent. */
function providerConnectBody(input: ProviderConnectInput): Record<string, string> {
  if (input.provider === "b2") {
    return { provider: "b2", label: input.label, accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey, bucket: input.bucket, region: input.region };
  }
  if (input.provider === "r2") {
    return { provider: "r2", label: input.label, accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey, bucket: input.bucket, accountId: input.accountId };
  }
  return { provider: input.provider, label: input.label, apiKey: input.apiKey };
}

export async function connectProvider(
  session: GatewaySession,
  input: ProviderConnectInput,
): Promise<ProviderProfile> {
  const base = requireLoopbackSession(session);
  const payload = await providerRequest<{ profile?: unknown }>(`${base}/providers/connect`, {
    method: "POST",
    headers: authHeaders(session.token, true),
    body: JSON.stringify(providerConnectBody(input)),
    signal: AbortSignal.timeout(15_000),
  });
  const profile = toProviderProfile(payload.profile);
  if (!profile) throw new Error("The gateway returned an unexpected answer.");
  return profile;
}

export async function listProviders(session: GatewaySession): Promise<ProviderProfile[]> {
  const base = requireLoopbackSession(session);
  const payload = await providerRequest<{ profiles?: unknown }>(`${base}/providers`, {
    headers: authHeaders(session.token),
    signal: AbortSignal.timeout(5_000),
  });
  if (!Array.isArray(payload.profiles)) return [];
  return payload.profiles.map(toProviderProfile).filter((p): p is ProviderProfile => p !== null);
}

export async function disconnectProvider(session: GatewaySession, id: string): Promise<void> {
  const base = requireLoopbackSession(session);
  await providerRequest<{ ok: boolean }>(`${base}/providers/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(session.token),
    signal: AbortSignal.timeout(5_000),
  });
}
