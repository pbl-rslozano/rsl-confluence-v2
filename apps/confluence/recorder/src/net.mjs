/**
 * net.mjs — the recorder's only door to the network.
 *
 * 1. EGRESS ALLOWLIST AT RUNTIME (ADR-0003 / ADR-0008). Every request — the
 *    engine's own fetches included, because the guard replaces globalThis.fetch
 *    — must be https to a host listed for the "recorder" process in
 *    tools/egress-manifest.json, or to an alert host that was configured via
 *    env. Anything else is refused before a socket is opened. The static check
 *    (tools/check-egress.mjs) proves the source has no other literal; this
 *    proves nothing slipped in at runtime (a redirect target, a URL built from
 *    payload data, a future lib change).
 * 2. TIMEOUTS. The engine's fetchJson has none (a browser tab can be closed);
 *    a headless loop must never hang on a dead socket, so each request gets
 *    AbortSignal.timeout, combined with the caller's signal.
 * 3. PER-CYCLE MEMO. With --source bybit-perp the engine's universe request and
 *    the funding step read the very same linear ticker list. A memoised 2xx body
 *    is replayed to the second reader, so both come from one snapshot and the
 *    venue sees one request. Cleared at the start of every cycle.
 * 4. REDACTION. Secrets (bot token, webhook URL) are scrubbed from every error
 *    string that leaves this module.
 */
import { readFileSync } from "node:fs";
import { RateLimitError } from "./engine.mjs";

const MANIFEST_URL = new URL("../../../../tools/egress-manifest.json", import.meta.url);

/** Hosts the recorder may contact without any alert configuration. */
export function loadRecorderManifest(url = MANIFEST_URL) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(url, "utf8"));
  } catch (error) {
    // Fail closed: without the manifest we do not know what is allowed.
    throw new Error(`egress manifest unreadable (${error instanceof Error ? error.message : error}); refusing to start`);
  }
  const rec = manifest?.processes?.recorder;
  if (!rec || !Array.isArray(rec.hosts)) throw new Error("egress manifest has no processes.recorder.hosts; refusing to start");
  return {
    hosts: rec.hosts.map((h) => String(h).toLowerCase()),
    websocketHosts: (rec.websocketHosts ?? []).map((h) => String(h).toLowerCase()),
    conditionalHosts: Object.keys(rec.conditionalHosts ?? {}).map((h) => h.toLowerCase()),
    allowsUserWebhook: Boolean(rec.userConfiguredHosts?.ALERT_WEBHOOK_URL),
  };
}

/* ------------------------------------------------------------------ *
 *  Redaction
 * ------------------------------------------------------------------ */
// Telegram bot tokens look like 123456789:AA…; scrub the shape even when the
// configured token is unknown to this function (e.g. a token pasted in a URL).
// No \b before the digits: in ".../bot123456:AA…" the "t1" pair is not a word boundary.
const TOKEN_SHAPE = /(?<!\d)\d{6,12}:[A-Za-z0-9_-]{30,}/g;

export function makeRedactor(secrets = []) {
  const list = secrets.filter((s) => typeof s === "string" && s.length >= 6).sort((a, b) => b.length - a.length);
  return (value) => {
    let text = value instanceof Error ? `${value.name}: ${value.message}` : String(value ?? "");
    for (const s of list) text = text.split(s).join("<redacted>");
    return text.replace(TOKEN_SHAPE, "<redacted>");
  };
}

/* ------------------------------------------------------------------ *
 *  Guarded fetch
 * ------------------------------------------------------------------ */
export class EgressBlockedError extends Error {
  constructor(host) {
    super(`egress blocked: ${host} is not in the recorder allowlist (tools/egress-manifest.json)`);
    this.name = "EgressBlockedError";
  }
}

const urlOf = (input) => (typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? String(input));

/**
 * @param {{ baseFetch?: typeof fetch, hosts: Iterable<string>, timeoutMs?: number, redact?: (v: unknown) => string }} options
 */
export function createGuardedFetch({ baseFetch = globalThis.fetch, hosts, timeoutMs = 20_000, redact = String }) {
  const allowed = new Set([...hosts].map((h) => h.toLowerCase()));
  const memoUrls = new Set();
  const memo = new Map();
  const stats = { requests: 0, memoHits: 0, blocked: 0 };

  async function guardedFetch(input, init = {}) {
    const href = urlOf(input);
    let url;
    try {
      url = new URL(href);
    } catch {
      throw new TypeError(`invalid URL: ${redact(href)}`);
    }
    // `host` includes a non-default port, so "api.bybit.com:8443" is not "api.bybit.com".
    if (url.protocol !== "https:" || !allowed.has(url.host.toLowerCase())) {
      stats.blocked++;
      throw new EgressBlockedError(`${url.protocol}//${url.host}`);
    }
    const method = String(init.method ?? "GET").toUpperCase();
    if (method === "GET" && memo.has(href)) {
      stats.memoHits++;
      const m = memo.get(href);
      return new Response(m.body, { status: m.status, statusText: m.statusText, headers: m.headers });
    }
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (init.signal) signals.push(init.signal);
    // Redirects could leave the allowlist; exchanges and Telegram never redirect API calls.
    const { cache: _cache, ...rest } = init; // `cache` is a browser hint; undici rejects some modes
    stats.requests++;
    const res = await baseFetch(href, { ...rest, redirect: "error", signal: AbortSignal.any(signals) });
    if (method === "GET" && memoUrls.has(href) && res.ok) {
      const body = await res.arrayBuffer();
      const entry = { body, status: res.status, statusText: res.statusText, headers: [...res.headers.entries()] };
      memo.set(href, entry);
      return new Response(body, { status: entry.status, statusText: entry.statusText, headers: entry.headers });
    }
    return res;
  }

  return {
    fetch: guardedFetch,
    stats,
    allowHost(host) { allowed.add(host.toLowerCase()); },
    isAllowed(host) { return allowed.has(host.toLowerCase()); },
    /** Replay the next 2xx body of `url` to later GETs until clearMemo(). */
    memoize(url) { memoUrls.add(url); },
    clearMemo() { memo.clear(); memoUrls.clear(); },
  };
}

/** Swap globalThis.fetch for the guard (the engine calls the global). Returns an undo function. */
export function installGlobalFetch(guard) {
  const previous = globalThis.fetch;
  globalThis.fetch = guard.fetch;
  return () => {
    if (globalThis.fetch === guard.fetch) globalThis.fetch = previous;
  };
}

/* ------------------------------------------------------------------ *
 *  JSON GET with the engine's exchange semantics
 * ------------------------------------------------------------------ */
/**
 * Same rate-limit rules as market-client.fetchJson (which is private):
 * Bybit 403 = IP ban (10 min), 429/418 with Retry-After, Bybit retCode
 * 10006/10018, Bitget code 429; error envelopes with HTTP 200 are errors.
 * Throws the engine's RateLimitError so callers have one type to handle.
 */
export async function getJson(fetchFn, url, label, signal) {
  const res = await fetchFn(url, { signal });
  if (res.status === 403 && url.startsWith("https://api.bybit.com")) throw new RateLimitError(`${label}: IP temporarily banned by Bybit (403).`, 600_000);
  if (res.status === 429 || res.status === 418) {
    const header = Number(res.headers.get("retry-after"));
    throw new RateLimitError(`${label}: rate limited (${res.status}).`, Number.isFinite(header) && header > 0 ? header * 1000 : res.status === 418 ? 600_000 : 60_000);
  }
  if (!res.ok) throw new Error(`${label} ${res.status}`);
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`${label}: invalid JSON`);
  }
  if (json && typeof json === "object" && !Array.isArray(json)) {
    if (typeof json.retCode === "number" && json.retCode !== 0) {
      if (json.retCode === 10006 || json.retCode === 10018) throw new RateLimitError(`${label}: rate limited (Bybit ${json.retCode}).`, 60_000);
      throw new Error(`${label} error ${json.retCode}: ${String(json.retMsg ?? "").slice(0, 120)}`.trim());
    }
    if (json.code !== undefined && String(json.code) !== "00000" && String(json.code) !== "0") {
      if (String(json.code) === "429") throw new RateLimitError(`${label}: rate limited (Bitget 429).`, 60_000);
      throw new Error(`${label} error ${json.code}: ${String(json.msg ?? "").slice(0, 120)}`.trim());
    }
  }
  return json;
}
