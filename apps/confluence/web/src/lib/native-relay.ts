/**
 * native-relay.ts — v2.8 (WP26, ADR-0003 amendment v2.8): a small, generic read-only relay for
 * public market-data hosts that the WebView cannot fetch cross-origin (no or unreliable CORS).
 * ----------------------------------------------------------------------------
 * Upbit is the first user (probe EX-PROBE-1, docs/research/evidence/wp26-venues-probe-2026-11-15.json:
 * CORS "UNRELIABLE"). Coins.ph keeps its own transport in coinsph.ts, unchanged.
 *
 *   - native shells (Capacitor, Tauri): the adapters' nativeGet(), fenced by isAllowedNativeUrl
 *     and, on desktop, by the path-scoped Tauri http capability;
 *   - browser / PWA: the same-origin rewrite `<proxyPrefix>/...` (Netlify public/_redirects, the
 *     local launcher proxy). A browser page NEVER fetches the origin directly;
 *   - Node (server route, recorder, replay): plain fetch to the origin, listed in tools/egress-manifest.json.
 *
 * Every request is checked against the rule's read paths AND the NATIVE_HOSTS table before any
 * request is made, on every transport: the hosts also serve private account and order endpoints.
 * The relay never sends credentials, cookies or extra headers and follows no redirect. It does not
 * judge HTTP statuses: the venue module reads `status` (429/418 → its own cooldown).
 * ----------------------------------------------------------------------------
 */
import { isAllowedNativeUrl, pathAllowed, type NativeHostRule } from "./public-hosts";
import type { NativeGet } from "./coinsph";

export type RelayFailure = "REFUSED" | "NOT_READY" | "NETWORK" | "PARSE";

export class RelayError extends Error {
  readonly kind: RelayFailure;
  constructor(kind: RelayFailure, message: string) {
    super(message);
    this.name = "RelayError";
    this.kind = kind;
  }
}

/** The part of a fetch Response the venue modules use. */
export interface RelayResponse {
  status: number;
  json(): Promise<unknown>;
  headers: { get(name: string): string | null };
}

let nativeGet: NativeGet | null = null;
/** Called once at boot by the shells that have native HTTP (Capacitor, Tauri), like setCoinsphNativeGet. */
export function setRelayNativeGet(fn: NativeGet | null): void {
  nativeGet = fn;
}

function isNativeShell(): boolean {
  const g = globalThis as unknown as { __TAURI_INTERNALS__?: unknown; Capacitor?: { isNativePlatform?: () => boolean } };
  return !!g.__TAURI_INTERNALS__ || !!g.Capacitor?.isNativePlatform?.();
}

export type RelayTransport = "native" | "proxy" | "direct";

/**
 * How this runtime reaches a relayed host. Same detection as coinsphTransport(), except that any
 * page (a `location` or `document` exists, whatever its protocol) is "proxy": direct is Node only.
 */
export function relayTransport(): RelayTransport {
  if (nativeGet) return "native";
  const g = globalThis as unknown as { location?: { protocol?: string }; document?: unknown };
  if (g.location || g.document) return "proxy";
  return "direct";
}

/** Normalise any header shape to lower-case keys. */
function lowerHeaders(h: Headers | Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (typeof (h as Headers).forEach === "function" && typeof (h as Headers).get === "function") {
    (h as Headers).forEach((v, k) => { out[k.toLowerCase()] = v; });
  } else {
    for (const [k, v] of Object.entries(h as Record<string, string>)) out[k.toLowerCase()] = String(v);
  }
  return out;
}

function response(status: number, headers: Record<string, string>, body: unknown): RelayResponse {
  return {
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => {
      if (typeof body !== "string") return body;
      try {
        return JSON.parse(body);
      } catch {
        throw new RelayError("PARSE", `relay ${status}: unreadable response`);
      }
    },
  };
}

/**
 * GET `pathAndQuery` ("/v1/...?...") from `rule.origin` through the transport this runtime allows.
 * Throws RelayError REFUSED (before any request) for a path outside `rule.paths` or the NATIVE_HOSTS
 * table, NOT_READY in a native shell whose native GET is not wired, NETWORK when unreachable.
 */
export async function relayGet(rule: NativeHostRule, proxyPrefix: string, pathAndQuery: string, signal?: AbortSignal): Promise<RelayResponse> {
  const q = pathAndQuery.indexOf("?");
  const path = q >= 0 ? pathAndQuery.slice(0, q) : pathAndQuery;
  const absolute = rule.origin + pathAndQuery;
  // Both fences: the rule's own paths on the raw text (no "..", encoded slashes or dots, backslashes,
  // fragments), and the NATIVE_HOSTS table on the parsed URL (a forged rule cannot widen the paths).
  if (!pathAllowed(path, rule.paths) || /%2e|#/i.test(pathAndQuery) || !isAllowedNativeUrl(absolute)) {
    throw new RelayError("REFUSED", `relay: path not allowed: ${path}`);
  }
  if (!proxyPrefix.startsWith("/") || proxyPrefix.endsWith("/")) throw new RelayError("REFUSED", "relay: bad proxy prefix");

  const transport = relayTransport();
  if (transport !== "native" && isNativeShell()) throw new RelayError("NOT_READY", "relay: native connection not ready yet — refresh in a moment.");
  try {
    if (transport === "native" && nativeGet) {
      const r = await nativeGet(absolute, { signal });
      return response(r.status, lowerHeaders(r.headers), r.body);
    }
    const url = transport === "proxy" ? proxyPrefix + pathAndQuery : absolute;
    const res = await fetch(url, { cache: "no-store", credentials: "omit", redirect: "error", signal, headers: { accept: "application/json" } });
    return response(res.status, lowerHeaders(res.headers), await res.text());
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    if (err instanceof RelayError) throw err;
    throw new RelayError("NETWORK", transport === "native" ? "relay: network blocked or unreachable." : "relay: blocked or unreachable from this page.");
  }
}
