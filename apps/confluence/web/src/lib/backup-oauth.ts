// WP28 Task 4: OAuth for cloud backup. Authorization code + PKCE S256 (Google Drive, OneDrive) and the pCloud token
// flow, all with PUBLIC client IDs and no client secret. Tokens go to backup-session.ts (memory only). No refresh
// token is requested or kept. Errors carry a code only: never a token, a code, a state, an upstream body or a URL.
import { BackupError } from "./backup-crypto";
import {
  APP_LINK_PATH, APP_LINK_REDIRECT, HOSTED_ORIGIN, LOOPBACK_REDIRECT, WEB_REDIRECT, availability,
  type Availability, type BackupConfig, type BackupShell, type OAuthProviderId,
} from "./backup-providers";
import type { BackupHttp, ShellOAuth } from "./backup-http";
import { setSession, type ProviderSession } from "./backup-session";
import { PCLOUD_API_HOSTS, isAllowedBackupUrl, isAllowedSignInUrl } from "./public-hosts";

type PcloudHost = (typeof PCLOUD_API_HOSTS)[number];

const GDRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const ONEDRIVE_SCOPE = "Files.ReadWrite.AppFolder";
const TOKEN_URLS = {
  gdrive: "https://oauth2.googleapis.com/token",
  onedrive: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
} as const;
const TOKEN_RE = /^[\x21-\x7e]{1,4096}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const KNOWN_REDIRECTS: readonly string[] = [WEB_REDIRECT, LOOPBACK_REDIRECT, APP_LINK_REDIRECT];
const SHELL_TIMEOUT_MS = 5 * 60 * 1000;
const PENDING_MAX_AGE_MS = 10 * 60 * 1000;

export const PENDING_KEY = "rsl-bk-oauth-v1";

function b64u(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomB64u(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b64u(b);
}

/** 32 random bytes as the verifier (43 characters); the challenge is base64url(SHA-256(verifier)). */
export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomB64u(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier) as BufferSource);
  return { verifier, challenge: b64u(new Uint8Array(digest)) };
}

/** A fresh state per sign-in: 32 random bytes, base64url. */
export function randomState(): string {
  return randomB64u(32);
}

const isCodeFlow = (p: OAuthProviderId): p is "gdrive" | "onedrive" => p !== "pcloud";

export function authUrl(p: OAuthProviderId, o: { clientId: string; redirectUri: string; state: string; challenge?: string }): string {
  const e = encodeURIComponent;
  let base: string;
  let pairs: Array<[string, string]>;
  if (p === "pcloud") {
    base = "https://my.pcloud.com/oauth2/authorize";
    pairs = [["client_id", o.clientId], ["response_type", "token"], ["redirect_uri", o.redirectUri], ["state", o.state]];
  } else {
    if (!o.challenge) throw new BackupError("sign-in"); // PKCE is not optional
    const pkce: Array<[string, string]> = [["code_challenge", o.challenge], ["code_challenge_method", "S256"], ["state", o.state]];
    if (p === "gdrive") {
      base = "https://accounts.google.com/o/oauth2/v2/auth";
      pairs = [["client_id", o.clientId], ["redirect_uri", o.redirectUri], ["response_type", "code"], ["scope", GDRIVE_SCOPE], ...pkce];
    } else {
      base = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
      pairs = [["client_id", o.clientId], ["response_type", "code"], ["redirect_uri", o.redirectUri], ["response_mode", "query"], ["scope", ONEDRIVE_SCOPE], ...pkce];
    }
  }
  const url = base + "?" + pairs.map(([k, v]) => `${k}=${e(v)}`).join("&");
  if (!isAllowedSignInUrl(url)) throw new BackupError("unavailable");
  return url;
}

export type CallbackResult =
  | { kind: "code"; code: string }
  | { kind: "token"; token: string; apiHost: PcloudHost };

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** The single value of `name`, or null when it is absent or repeated. */
function one(params: URLSearchParams, name: string): string | null {
  const all = params.getAll(name);
  return all.length === 1 ? all[0] : null;
}

/**
 * Validates a redirect. The URL up to its query or fragment must equal `redirectUri` exactly (no prefix match), a
 * provider `error` is a `sign-in` failure, and the state must be present, single and equal.
 */
export function parseCallback(url: string, o: { provider: OAuthProviderId; redirectUri: string; state: string }): CallbackResult {
  if (typeof url !== "string" || !KNOWN_REDIRECTS.includes(o.redirectUri)) throw new BackupError("sign-in");
  const cut = url.search(/[?#]/);
  if ((cut < 0 ? url : url.slice(0, cut)) !== o.redirectUri) throw new BackupError("sign-in");
  const hash = url.indexOf("#");
  const beforeHash = hash < 0 ? url : url.slice(0, hash);
  const q = beforeHash.indexOf("?");
  const query = new URLSearchParams(q < 0 ? "" : beforeHash.slice(q + 1));
  const frag = new URLSearchParams(hash < 0 ? "" : url.slice(hash + 1));
  if (query.has("error") || frag.has("error")) throw new BackupError("sign-in");

  const source = o.provider === "pcloud" ? frag : query;
  const state = one(source, "state");
  if (state === null || !o.state || !sameString(state, o.state)) throw new BackupError("state");

  if (o.provider === "pcloud") {
    const token = one(frag, "access_token");
    const host = one(frag, "hostname");
    if (token === null || !TOKEN_RE.test(token)) throw new BackupError("sign-in");
    if (host === null || !(PCLOUD_API_HOSTS as readonly string[]).includes(host)) throw new BackupError("sign-in");
    return { kind: "token", token, apiHost: host as PcloudHost };
  }
  const code = one(query, "code");
  if (code === null || !TOKEN_RE.test(code)) throw new BackupError("sign-in");
  return { kind: "code", code };
}

/** Exchanges an authorization code (PKCE, no client secret). The upstream body never reaches an error. */
export async function exchangeCode(
  p: "gdrive" | "onedrive",
  o: { clientId: string; code: string; verifier: string; redirectUri: string },
  http: BackupHttp,
  now: number,
  signal?: AbortSignal,
): Promise<ProviderSession> {
  if (p !== "gdrive" && p !== "onedrive") throw new BackupError("unavailable");
  if (!KNOWN_REDIRECTS.includes(o.redirectUri) || !VERIFIER_RE.test(o.verifier) || !TOKEN_RE.test(o.code) || !o.clientId) {
    throw new BackupError("sign-in");
  }
  const url = TOKEN_URLS[p];
  if (!isAllowedBackupUrl(url)) throw new BackupError("unavailable");
  const form = new URLSearchParams();
  form.set("client_id", o.clientId);
  form.set("grant_type", "authorization_code");
  form.set("code", o.code);
  form.set("code_verifier", o.verifier);
  form.set("redirect_uri", o.redirectUri);
  if (p === "onedrive") form.set("scope", ONEDRIVE_SCOPE);
  let res;
  try {
    res = await http({ method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form.toString(), signal });
  } catch (e) {
    throw e instanceof BackupError ? e : new BackupError("network");
  }
  if (res.status < 200 || res.status > 299) throw new BackupError("sign-in", { status: res.status });
  let j: unknown;
  try {
    j = JSON.parse(res.text);
  } catch {
    throw new BackupError("sign-in", { status: res.status });
  }
  const r = j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : {};
  const token = r.access_token;
  const ttl = r.expires_in;
  if (typeof token !== "string" || !TOKEN_RE.test(token)) throw new BackupError("sign-in", { status: res.status });
  if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 60 || ttl > 86_400) throw new BackupError("sign-in", { status: res.status });
  return { token, expiresAt: now + (ttl - 60) * 1000 };
}

function refuse(a: Availability, p: OAuthProviderId): never {
  if (a === "not-set-up") throw new BackupError("not-set-up", { provider: p });
  if (a === "needs-gateway") throw new BackupError("needs-gateway", { provider: p });
  throw new BackupError("unavailable", { provider: p, availability: a });
}

/** Every entry point checks this first: a provider that is not ready makes no request and no navigation. */
function requireReady(p: OAuthProviderId, shell: BackupShell, cfg: BackupConfig, origin: string): void {
  const a = availability(p, { shell, config: cfg, origin, gatewayProviders: [] });
  if (a !== "ready") refuse(a, p);
}

/** location.origin in a browser; outside one nothing can navigate, so the hosted origin stands in. */
function currentOrigin(): string {
  return typeof location !== "undefined" && typeof location.origin === "string" ? location.origin : HOSTED_ORIGIN;
}

async function startFlow(p: OAuthProviderId, cfg: BackupConfig, redirectUri: string): Promise<{ url: string; state: string; verifier?: string }> {
  const state = randomState();
  if (isCodeFlow(p)) {
    const { verifier, challenge } = await createPkce();
    return { url: authUrl(p, { clientId: cfg.clientIds[p], redirectUri, state, challenge }), state, verifier };
  }
  return { url: authUrl(p, { clientId: cfg.clientIds[p], redirectUri, state }), state };
}

/** Stores the pending sign-in (state, verifier for code flows) in sessionStorage and leaves for the sign-in page. */
export async function beginWebSignIn(
  p: OAuthProviderId,
  cfg: BackupConfig,
  deps: { storage: Pick<Storage, "setItem"> & Partial<Pick<Storage, "getItem" | "removeItem">>; assign: (url: string) => void; origin?: string },
): Promise<void> {
  purgeStalePending(deps.storage, Date.now());
  requireReady(p, "web", cfg, deps.origin ?? currentOrigin());
  const { url, state, verifier } = await startFlow(p, cfg, WEB_REDIRECT);
  try {
    deps.storage.setItem(PENDING_KEY, JSON.stringify({ p, s: state, ...(verifier ? { v: verifier } : {}), t: Date.now() }));
  } catch {
    throw new BackupError("unavailable");
  }
  deps.assign(url);
}

/**
 * Removes a pending sign-in entry (the verifier included) once it is older than 10 minutes, or is not an entry at
 * all. An entry that may still come back is kept. Called whenever this module reads the entry.
 */
export function purgeStalePending(storage: Partial<Pick<Storage, "getItem" | "removeItem">>, now: number): void {
  try {
    if (!storage.getItem || !storage.removeItem) return;
    const raw = storage.getItem(PENDING_KEY);
    if (raw === null) return;
    const e = readPending(raw);
    if (!e || now - e.t > PENDING_MAX_AGE_MS) storage.removeItem(PENDING_KEY);
  } catch {
    /* storage unavailable: nothing to purge */
  }
}

interface Pending { p: OAuthProviderId; s: string; v?: string; t: number }

function readPending(raw: string | null): Pending | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (!j || typeof j !== "object") return null;
    if (j.p !== "gdrive" && j.p !== "onedrive" && j.p !== "pcloud") return null;
    if (typeof j.s !== "string" || !j.s || typeof j.t !== "number" || !Number.isFinite(j.t)) return null;
    if (j.v !== undefined && typeof j.v !== "string") return null;
    return { p: j.p, s: j.s, v: j.v as string | undefined, t: j.t };
  } catch {
    return null;
  }
}

/**
 * Called on page load with the current URL. null: nothing to do. `{ foreign: true }`: a redirect this page did not
 * start (app-link path, replay, no or stale pending entry). Otherwise the validated result, or a thrown BackupError.
 * The pending entry is removed first, so a state is checked at most once.
 */
export function consumeWebCallback(
  href: string,
  deps: { storage: Pick<Storage, "getItem" | "removeItem">; now: number },
): { provider: OAuthProviderId; result: CallbackResult; verifier?: string } | { foreign: true } | null {
  purgeStalePending(deps.storage, deps.now);
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  const frag = new URLSearchParams(u.hash.slice(1));
  const has = (k: string) => u.searchParams.has(k) || frag.has(k);
  const onAppLink = u.pathname === APP_LINK_PATH;
  if (!onAppLink && !["code", "error", "access_token", "state"].some(has)) return null;

  let raw: string | null = null;
  try {
    raw = deps.storage.getItem(PENDING_KEY);
  } catch {
    raw = null;
  }
  try {
    deps.storage.removeItem(PENDING_KEY);
  } catch {
    /* nothing more to do */
  }
  const pending = readPending(raw);
  const age = pending ? deps.now - pending.t : 0;
  if (onAppLink || !pending || age > PENDING_MAX_AGE_MS || age < -60_000) return { foreign: true };
  const result = parseCallback(href, { provider: pending.p, redirectUri: WEB_REDIRECT, state: pending.s });
  return { provider: pending.p, result, verifier: pending.v };
}

/** Turns a validated web callback into an in-memory session. */
export async function completeWebSignIn(
  r: { provider: OAuthProviderId; result: CallbackResult; verifier?: string },
  cfg: BackupConfig,
  http: BackupHttp,
  now: number,
): Promise<void> {
  requireReady(r.provider, "web", cfg, currentOrigin());
  setSession(r.provider, await sessionFrom(r.provider, r.result, r.verifier, cfg, WEB_REDIRECT, http, now));
}

async function sessionFrom(
  p: OAuthProviderId,
  result: CallbackResult,
  verifier: string | undefined,
  cfg: BackupConfig,
  redirectUri: string,
  http: BackupHttp,
  now: number,
  signal?: AbortSignal,
): Promise<ProviderSession> {
  if (result.kind === "token") {
    if (p !== "pcloud") throw new BackupError("sign-in");
    return { token: result.token, expiresAt: null, apiHost: result.apiHost };
  }
  if (p === "pcloud" || !verifier) throw new BackupError("sign-in");
  return exchangeCode(p, { clientId: cfg.clientIds[p], code: result.code, verifier, redirectUri }, http, now, signal);
}

/** Desktop (loopback) and phone (app link) sign-in through the shell's broker. */
export async function signInShell(
  p: OAuthProviderId,
  cfg: BackupConfig,
  o: { shell: "tauri" | "capacitor"; oauth: ShellOAuth; http: BackupHttp; now: () => number; signal?: AbortSignal },
): Promise<void> {
  requireReady(p, o.shell, cfg, HOSTED_ORIGIN);
  if (o.oauth.kind !== (o.shell === "tauri" ? "loopback" : "applink")) throw new BackupError("unavailable", { provider: p });
  if (o.signal?.aborted) throw new BackupError("cancelled");
  const redirectUri = o.shell === "tauri" ? LOOPBACK_REDIRECT : APP_LINK_REDIRECT;
  const { url, state, verifier } = await startFlow(p, cfg, redirectUri);
  let back: string;
  try {
    back = await o.oauth.authorize(url, { redirectUri, relayFragment: p === "pcloud", timeoutMs: SHELL_TIMEOUT_MS, signal: o.signal });
  } catch (e) {
    const m = e instanceof Error ? e.message : "";
    if (m === "timeout" || m === "port-busy" || m === "cancelled") throw new BackupError(m);
    throw new BackupError("sign-in");
  }
  if (o.signal?.aborted) throw new BackupError("cancelled");
  const result = parseCallback(back, { provider: p, redirectUri, state });
  const session = await sessionFrom(p, result, verifier, cfg, redirectUri, o.http, o.now(), o.signal);
  if (o.signal?.aborted) throw new BackupError("cancelled");
  setSession(p, session);
}
