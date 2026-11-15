/**
 * Confluence private API gateway — localhost credential broker.
 *
 * Build 1.9 hardening:
 *   - Requests with NO Origin header are rejected. Previously they were
 *     allowed, so any local process (another app, a compromised dependency, a
 *     malicious editor extension) could enumerate GET /profiles and learn which
 *     exchange accounts were connected and what permissions they carried.
 *   - Host header is validated as a second layer against DNS rebinding.
 *   - Every route requires a per-session bearer token printed at startup.
 *   - POST /connect is rate limited.
 *   - Credentials are cleared on crash as well as on clean shutdown.
 *
 * It still exposes NO order-placement, withdrawal, transfer, or liquidation
 * endpoint. That boundary is deliberate and should hold until the signal engine
 * has demonstrated an edge net of costs against a recorded ledger.
 */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../recorder/src/store.mjs";
import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { REFUSAL_MESSAGE, createProfile, profileAllowed, verifyCredentials } from "./exchange-auth.mjs";

const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.CONFLUENCE_GATEWAY_PORT || "8787", 10);
const MAX_BODY_BYTES = 32 * 1024;
const TAURI_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]);
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Per-session token. Regenerated on every start; never persisted. */
const SESSION_TOKEN = process.env.CONFLUENCE_GATEWAY_TOKEN || randomUUID();

const profiles = new Map();
const recorderDir = process.env.CONFLUENCE_RECORDER_DIR ? realpathSync(process.env.CONFLUENCE_RECORDER_DIR) : null;

/* ---------------------------------------------------------------- *
 *  Rate limiting — fixed window on credential-testing attempts.
 * ---------------------------------------------------------------- */
const CONNECT_WINDOW_MS = 15 * 60_000;
const CONNECT_MAX_ATTEMPTS = 5;
let connectWindowStart = Date.now();
let connectAttempts = 0;

function rateLimitConnect() {
  const now = Date.now();
  if (now - connectWindowStart > CONNECT_WINDOW_MS) {
    connectWindowStart = now;
    connectAttempts = 0;
  }
  connectAttempts += 1;
  if (connectAttempts > CONNECT_MAX_ATTEMPTS) {
    const waitMin = Math.ceil((CONNECT_WINDOW_MS - (now - connectWindowStart)) / 60_000);
    throw new Error(`Too many credential tests. Try again in ${waitMin} minute(s).`);
  }
}

/* ---------------------------------------------------------------- *
 *  Origin / Host / token checks
 * ---------------------------------------------------------------- */
function allowedOrigin(origin) {
  // No Origin means the request did not come from a browser page we trust.
  // Browsers always attach Origin to cross-origin and non-GET requests, so
  // rejecting here costs nothing legitimate and closes local-process access.
  if (!origin) return false;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin)) return true;
  // v2.1: the Tauri desktop shell has a real, app-specific origin (Electron's file:// sent
  // "null", which is refused). tauri://localhost = macOS/Linux, http(s)://tauri.localhost = Windows.
  if (TAURI_ORIGINS.has(origin)) return true;
  return Boolean(process.env.CONFLUENCE_ALLOWED_ORIGIN) && process.env.CONFLUENCE_ALLOWED_ORIGIN === origin;
}

function allowedHost(hostHeader) {
  const host = String(hostHeader || "").split(":")[0];
  return ALLOWED_HOSTS.has(host);
}

function tokenMatches(authorization) {
  const provided = String(authorization || "").replace(/^Bearer\s+/i, "");
  if (provided.length !== SESSION_TOKEN.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(SESSION_TOKEN));
  } catch {
    return false;
  }
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "http://127.0.0.1",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
}

function sendJson(response, status, payload, origin) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin) });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function validateRecorderRules(value) {
  if (value?.version !== 1 || !Array.isArray(value.rules) || value.rules.length > 20) throw new Error("Invalid recorder rule file.");
  // Recorder rules scan public market data only (v2.8 WP26: OKX, Coinbase and Upbit are keyless; no private profile exists for them).
  const sources = ["binance", "bybit-spot", "bybit-perp", "bitget", "bitget-perp", "okx", "okx-perp", "coinbase", "upbit"];
  const timeframes = ["1m", "5m", "15m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "2d", "4d", "1w", "1M"];
  const ids = new Set();
  const rules = value.rules.map((rule) => {
    const rankRule = rule?.kind === "rank-rise";
    if (typeof rule?.id !== "string" || !/^[\w-]{1,80}$/.test(rule.id) || ids.has(rule.id) ||
        !sources.includes(rule.source) || !timeframes.includes(rule.timeframe) ||
        !Array.isArray(rule.symbols) || !rule.symbols.length || rule.symbols.length > 200 ||
        !rule.symbols.every((symbol) => typeof symbol === "string" && /^[A-Z0-9]{2,30}$/.test(symbol)) ||
        (rankRule ? rule.timeframe === "1M" || !Number.isInteger(rule.threshold) || rule.threshold < 1 || rule.threshold > 299
          : (rule.kind !== undefined && rule.kind !== "score-crossing") || !Number.isFinite(rule.threshold) || rule.threshold < -100 || rule.threshold > 100)) {
      throw new Error("Invalid recorder rule.");
    }
    ids.add(rule.id);
    return { id: rule.id, source: rule.source, timeframe: rule.timeframe, symbols: [...new Set(rule.symbols)], threshold: rule.threshold, ...(rule.kind ? { kind: rule.kind } : {}) };
  });
  return { version: 1, revision: new Date().toISOString(), rules };
}

function readRecorderFile(name, fallback) {
  const path = join(recorderDir, name);
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.size > 5_000_000) throw new Error("Invalid recorder file.");
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function validateCredentials(value) {
  if (!value || typeof value !== "object") throw new Error("Invalid credential payload.");
  if (!["binance", "bybit", "bitget"].includes(value.provider)) throw new Error("Unsupported exchange provider.");
  if (!["testnet", "mainnet"].includes(value.environment)) throw new Error("Invalid environment.");
  if (value.provider === "bitget" && value.environment !== "mainnet") {
    throw new Error("Bitget credential testing supports mainnet only in this build.");
  }
  for (const field of ["apiKey", "apiSecret"]) {
    if (typeof value[field] !== "string" || value[field].trim().length < 4 || value[field].length > 512) {
      throw new Error(`Invalid ${field}.`);
    }
  }
  if (value.provider === "bitget" && (typeof value.passphrase !== "string" || value.passphrase.length < 1 || value.passphrase.length > 256)) {
    throw new Error("Bitget passphrase is required.");
  }
  return {
    provider: value.provider,
    environment: value.environment,
    label: typeof value.label === "string" && value.label.trim() ? value.label.trim().slice(0, 80) : `${value.provider} profile`,
    apiKey: value.apiKey.trim(),
    apiSecret: value.apiSecret.trim(),
    passphrase: typeof value.passphrase === "string" ? value.passphrase : "",
  };
}

const server = createServer(async (request, response) => {
  const origin = request.headers.origin || "";

  if (!allowedHost(request.headers.host)) {
    sendJson(response, 403, { error: "Invalid Host header." }, origin);
    return;
  }
  if (!allowedOrigin(origin)) {
    sendJson(response, 403, { error: "Origin is not allowed by the local gateway." }, origin);
    return;
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders(origin));
    response.end();
    return;
  }
  if (!tokenMatches(request.headers.authorization)) {
    sendJson(response, 401, { error: "Missing or invalid gateway token. Copy it from the gateway console." }, origin);
    return;
  }

  const url = new URL(request.url || "/", `http://${HOST}:${PORT}`);
  try {
    if (recorderDir && request.method === "GET" && url.pathname === "/recorder/inbox") {
      sendJson(response, 200, readRecorderFile("workspace-inbox.json", { version: 1, events: [] }), origin);
      return;
    }
    if (recorderDir && request.method === "POST" && url.pathname === "/recorder/rules") {
      const incoming = validateRecorderRules(await readJson(request));
      const stored = validateRecorderRules(readRecorderFile("workspace-rules.json", { version: 1, rules: [] }));
      const merged = new Map([...stored.rules, ...incoming.rules].map((rule) => [rule.id, rule]));
      const deployment = validateRecorderRules({ version: 1, rules: [...merged.values()] });
      writeJsonAtomic(join(recorderDir, "workspace-rules.json"), deployment);
      sendJson(response, 200, { revision: deployment.revision }, origin);
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, service: "confluence-private-api-gateway", profiles: profiles.size }, origin);
      return;
    }

    if (request.method === "GET" && url.pathname === "/profiles") {
      sendJson(response, 200, { profiles: [...profiles.values()].map(({ credentials: _credentials, ...profile }) => profile) }, origin);
      return;
    }

    if (request.method === "POST" && url.pathname === "/connect") {
      rateLimitConnect();
      const credentials = validateCredentials(await readJson(request));
      const verification = await verifyCredentials(credentials);
      if (!profileAllowed(credentials, verification).ok) throw new Error(REFUSAL_MESSAGE);
      const profile = createProfile(credentials, verification);
      profiles.set(profile.id, { ...profile, credentials });
      sendJson(response, 200, { profile }, origin);
      return;
    }

    const profileMatch = url.pathname.match(/^\/profiles\/([0-9a-f-]+)$/i);
    if (request.method === "DELETE" && profileMatch) {
      const removed = profiles.delete(profileMatch[1]);
      sendJson(response, removed ? 200 : 404, removed ? { ok: true } : { error: "Profile not found." }, origin);
      return;
    }

    sendJson(response, 404, { error: "Route not found." }, origin);
  } catch (reason) {
    const message = reason instanceof SyntaxError
      ? "Invalid JSON payload."
      : reason instanceof Error
        ? reason.message
        : "Gateway request failed.";
    sendJson(response, 400, { error: message }, origin);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Confluence private API gateway listening on http://${HOST}:${PORT}`);
  console.log("");
  console.log(`  Gateway token: ${SESSION_TOKEN}`);
  console.log("  Paste this into the Private API dialog. It changes on every restart.");
  console.log("");
  console.log("Credentials are held in memory only. No trading endpoints are enabled.");
});

function clearSecrets() {
  for (const entry of profiles.values()) {
    if (entry.credentials) {
      entry.credentials.apiKey = "";
      entry.credentials.apiSecret = "";
      entry.credentials.passphrase = "";
    }
  }
  profiles.clear();
}

function shutdown() {
  clearSecrets();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// A crash must not leave plaintext secrets in a core dump.
process.on("uncaughtException", (error) => {
  clearSecrets();
  console.error("Gateway crashed; credentials cleared.", error);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  clearSecrets();
  console.error("Gateway unhandled rejection; credentials cleared.", reason);
  process.exit(1);
});
