#!/usr/bin/env node
// serve-pwa.mjs — local launcher for the rsL Confluence Terminal PWA.
//
//   node serve-pwa.mjs [--port 8770] [--dir <folder with index.html>]
//
// Serves the unzipped PWA on http://127.0.0.1:<port>/ ONLY (never on the
// network), with correct MIME types so the module workers and the offline
// service worker load. No dependencies; Node 18 or later.
// v2.6: also proxies Coins.ph public market data (see COINSPH_* below).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const port = Number(opt("port", process.env.PORT ?? 8770));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be between 1 and 65535.");
const root = resolve(opt("dir", dirname(fileURLToPath(import.meta.url))));
if (!existsSync(join(root, "index.html"))) {
  console.error(`No index.html in ${root}. Run this from the unzipped rsL-Confluence PWA folder.`);
  process.exit(1);
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".webp": "image/webp",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8",
  ".map": "application/json", ".glb": "model/gltf-binary",
};
const HIDDEN = new Set(["serve-pwa.mjs", "Start-Confluence-Terminal.cmd", "start-confluence-terminal.sh", ".rsl-target"]);

function fileFor(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath.split("?")[0]); } catch { return null; }
  const abs = normalize(join(root, p));
  if (abs !== root && !abs.startsWith(root + sep)) return null; // no path traversal
  if (HIDDEN.has(abs.slice(root.length + 1))) return null;
  if (existsSync(abs) && statSync(abs).isDirectory()) return existsSync(join(abs, "index.html")) ? join(abs, "index.html") : null;
  if (existsSync(abs)) return abs;
  if (!extname(abs) && existsSync(`${abs}.html`)) return `${abs}.html`;
  return null;
}

// v2.6 (ADR-0013): Coins.ph sends no CORS header, so the page reaches its public
// market data through this same-origin proxy, exactly as on the hosted PWA
// (public/_redirects). Read paths only; no request headers are forwarded.
// Must match apps/confluence/web/src/lib/public-hosts.ts (release check R16).
const COINSPH_ORIGIN = "https://api.pro.coins.ph";
const COINSPH_PROXY_PREFIX = "/x/coinsph";
const COINSPH_READ_PATHS = ["/openapi/v1/time", "/openapi/v1/exchangeInfo", "/openapi/quote/v1/"];
function coinsphTarget(url) {
  if (!url.startsWith(COINSPH_PROXY_PREFIX + "/")) return null;
  const rest = url.slice(COINSPH_PROXY_PREFIX.length);
  const q = rest.indexOf("?");
  const path = q >= 0 ? rest.slice(0, q) : rest;
  if (path.includes("..") || /%2f|%5c|\\/i.test(path)) return undefined;
  const ok = COINSPH_READ_PATHS.some((p) => (p.endsWith("/") ? path.startsWith(p) && path.length > p.length : path === p));
  return ok ? COINSPH_ORIGIN + rest : undefined;
}
async function proxyCoinsph(target, res) {
  try {
    const up = await fetch(target, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
    const body = Buffer.from(await up.arrayBuffer());
    const headers = { "content-type": up.headers.get("content-type") ?? "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" };
    const ra = up.headers.get("retry-after");
    if (ra) headers["retry-after"] = ra;
    res.writeHead(up.status, headers).end(body);
  } catch {
    res.writeHead(502, { "content-type": "text/plain" }).end("Coins.ph unreachable");
  }
}

const server = createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
  const coins = coinsphTarget(req.url ?? "/");
  if (coins === undefined) { res.writeHead(403, { "content-type": "text/plain" }).end("Path not allowed"); return; }
  if (coins) { void proxyCoinsph(coins, res); return; }
  const file = fileFor(req.url ?? "/");
  const target = file ?? join(root, "404.html");
  const status = file ? 200 : 404;
  if (!existsSync(target)) { res.writeHead(404, { "content-type": "text/plain" }).end("Not found"); return; }
  const name = target.slice(root.length + 1);
  res.writeHead(status, {
    "content-type": TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
    // The service worker and pages must revalidate so a new version is picked up.
    "cache-control": name === "sw.js" || name.endsWith(".html") ? "no-cache" : "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") { res.end(); return; }
  createReadStream(target).pipe(res);
});

server.on("error", (e) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${port} is busy — another copy may already be running. Verify the process using this port. Keep the same browser and port to access your saved ledger.` : String(e));
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  console.log(`rsL Confluence Terminal → http://127.0.0.1:${port}/   (this computer only; close this window or press Ctrl+C to stop)`);
  if (args.includes("--open-browser")) {
    const url = "http://127.0.0.1:" + port + "/";
    const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    const browser = spawn(command, [url], { windowsHide: true, stdio: "ignore" });
    browser.on("error", () => console.error("Open " + url + " in your browser."));
    browser.unref();
  }
});
