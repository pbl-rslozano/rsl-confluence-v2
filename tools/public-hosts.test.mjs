// Tests for release check R16 (tools/checks/public-hosts.mjs) — v2.8 WP26: every NATIVE_HOSTS entry
// (Coins.ph, Upbit) must agree with the Netlify rewrites, the launcher proxy, the Tauri http scope, the
// egress manifest and ADR-0003. The launcher test starts the real launcher on loopback and only asks it
// for refused paths, so nothing reaches the network.
//   node --test tools/public-hosts.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { get as httpGet } from "node:http";
import { pathToFileURL } from "node:url";
import { checkPublicHosts, parseNativeHosts, parseTable, ROOT } from "./checks/public-hosts.mjs";

const FILES = [
  "apps/confluence/web/src/lib/public-hosts.ts",
  "apps/confluence/web/public/_redirects",
  "tools/pwa-launcher/serve-pwa.mjs",
  "apps/confluence/desktop/src-tauri/capabilities/main.json",
  "tools/egress-manifest.json",
  "docs/adr/0003-network-allowlist.md",
];

/** Copy the six files R16 reads into a temp root, let `edit` change them, run R16 there. */
function withFixture(edit) {
  const dir = mkdtempSync(join(tmpdir(), "r16-"));
  try {
    for (const f of FILES) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      cpSync(join(ROOT, f), join(dir, f));
    }
    const rw = (f, fn) => writeFileSync(join(dir, f), fn(readFileSync(join(dir, f), "utf8")));
    edit(rw);
    return checkPublicHosts(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the table parses: Coins.ph (unchanged) and Upbit", () => {
  const src = readFileSync(join(ROOT, FILES[0]), "utf8");
  const hosts = parseNativeHosts(src);
  assert.deepEqual(hosts.map((h) => h.name), ["COINSPH", "UPBIT"]);
  assert.deepEqual(hosts[1], {
    name: "UPBIT", origin: "https://api.upbit.com", prefix: "/x/upbit",
    paths: ["/v1/market/all", "/v1/ticker/all", "/v1/ticker", "/v1/orderbook", "/v1/candles/"],
  });
  // parseTable keeps its v2.6 meaning (Coins.ph only) for R20.
  assert.deepEqual(parseTable(src), { origin: "https://api.pro.coins.ph", prefix: "/x/coinsph", paths: ["/openapi/v1/time", "/openapi/v1/exchangeInfo", "/openapi/quote/v1/"] });
});

test("the current tree passes R16 for every native host", () => {
  const r = checkPublicHosts();
  assert.equal(r.ok, true, r.findings.join("; "));
  assert.match(r.summary, /api\.pro\.coins\.ph: 3 read paths, 3 rewrites/);
  assert.match(r.summary, /api\.upbit\.com: 5 read paths, 5 rewrites/);
  assert.match(r.summary, /8 Tauri URLs/);
});

test("_redirects lacking an Upbit path fails R16, naming it", () => {
  const r = withFixture((rw) => rw("apps/confluence/web/public/_redirects", (s) => s.split("\n").filter((l) => !l.startsWith("/x/upbit/v1/orderbook")).join("\n")));
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.includes("_redirects: no rule for /x/upbit/v1/orderbook")), r.findings.join("; "));
});

test("_redirects lacking a Coins.ph path still fails R16 (v2.6 assertion kept)", () => {
  const r = withFixture((rw) => rw("apps/confluence/web/public/_redirects", (s) => s.split("\n").filter((l) => !l.startsWith("/x/coinsph/openapi/v1/time")).join("\n")));
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.includes("_redirects: no rule for /x/coinsph/openapi/v1/time")), r.findings.join("; "));
});

test("an extra Upbit rewrite to a private path fails R16", () => {
  const r = withFixture((rw) => rw("apps/confluence/web/public/_redirects", (s) => s + "/x/upbit/v1/accounts    https://api.upbit.com/v1/accounts    200\n"));
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.includes("6 rules under /x/upbit, expected 5")), r.findings.join("; "));
});

test("an Upbit rewrite outside its prefix, or with headers, fails R16", () => {
  const r1 = withFixture((rw) => rw("apps/confluence/web/public/_redirects", (s) => s + "/api/up/*    https://api.upbit.com/:splat    200\n"));
  assert.ok(r1.findings.some((f) => f.includes("api.upbit.com reached outside /x/upbit")), r1.findings.join("; "));
  const r2 = withFixture((rw) => rw("apps/confluence/web/public/_redirects", (s) => s.replace(/^(\/x\/upbit\/v1\/ticker\s+\S+\s+200)$/m, "$1!")));
  assert.ok(r2.findings.includes("_redirects: extra options on /x/upbit/v1/ticker"), r2.findings.join("; "));
});

test("the launcher missing Upbit, or with a different path list, fails R16", () => {
  const r1 = withFixture((rw) => rw("tools/pwa-launcher/serve-pwa.mjs", (s) => s.replace(/const UPBIT_READ_PATHS = \[[^\]]*\];/, 'const UPBIT_READ_PATHS = ["/v1/"];')));
  assert.ok(r1.findings.some((f) => f.includes("serve-pwa.mjs: Upbit proxy constants differ")), r1.findings.join("; "));
  const r2 = withFixture((rw) => rw("tools/pwa-launcher/serve-pwa.mjs", (s) => s.replace(/const COINSPH_ORIGIN = "[^"]+";/, 'const COINSPH_ORIGIN = "https://example.test";')));
  assert.ok(r2.findings.some((f) => f.includes("serve-pwa.mjs: Coins.ph proxy constants differ")), r2.findings.join("; "));
});

test("the Tauri scope missing an Upbit URL, or broader than the paths, fails R16", () => {
  const cap = "apps/confluence/desktop/src-tauri/capabilities/main.json";
  const r1 = withFixture((rw) => rw(cap, (s) => { const j = JSON.parse(s); const h = j.permissions.find((p) => p.identifier === "http:default"); h.allow = h.allow.filter((a) => !a.url.includes("/v1/candles/")); return JSON.stringify(j); }));
  assert.ok(r1.findings.some((f) => f.startsWith("capability http scope")), r1.findings.join("; "));
  const r2 = withFixture((rw) => rw(cap, (s) => { const j = JSON.parse(s); j.permissions.find((p) => p.identifier === "http:default").allow.push({ url: "https://api.upbit.com/*" }); return JSON.stringify(j); }));
  assert.ok(r2.findings.some((f) => f.startsWith("capability http scope")), r2.findings.join("; "));
});

test("the egress manifest or ADR-0003 missing api.upbit.com fails R16", () => {
  const r1 = withFixture((rw) => rw("tools/egress-manifest.json", (s) => { const j = JSON.parse(s); j.processes.web.nativeHosts = ["api.pro.coins.ph"]; return JSON.stringify(j); }));
  assert.ok(r1.findings.includes("egress-manifest: web.nativeHosts lacks api.upbit.com"), r1.findings.join("; "));
  const r2 = withFixture((rw) => rw("tools/egress-manifest.json", (s) => { const j = JSON.parse(s); j.processes.launcher.hosts = ["api.pro.coins.ph"]; return JSON.stringify(j); }));
  assert.ok(r2.findings.includes("egress-manifest: launcher.hosts lacks api.upbit.com"), r2.findings.join("; "));
  const r3 = withFixture((rw) => rw("docs/adr/0003-network-allowlist.md", (s) => s.replaceAll("api.upbit.com", "api.example.test")));
  assert.ok(r3.findings.includes("ADR-0003 does not name api.upbit.com"), r3.findings.join("; "));
});

test("a NATIVE_HOSTS entry without a proxy prefix constant fails R16", () => {
  const r = withFixture((rw) => rw(FILES[0], (s) => s.replace('export const UPBIT_PROXY_PREFIX = "/x/upbit";', "")));
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.includes("UPBIT")), r.findings.join("; "));
});

/**
 * Start the real launcher with fetch stubbed in the child (a --import preload): the stub never opens a
 * socket and echoes the upstream URL and the redirect option, so the test sees exactly what would be sent.
 * Requests go through node:http with a verbatim path so the request target reaches the launcher unnormalised (fetch() on the
 * test side would resolve "%2e%2e" and "\" before sending).
 */
async function withLauncher(fn) {
  const dir = mkdtempSync(join(tmpdir(), "launcher-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>t</title>");
  const stub = join(dir, "stub-fetch.mjs");
  writeFileSync(stub, 'globalThis.fetch = async (url, init = {}) => new Response(JSON.stringify({ upstream: String(url), redirect: init.redirect ?? null, keys: Object.keys(init).sort() }), { status: 200, headers: { "content-type": "application/json" } });\n');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["--import", pathToFileURL(stub).href, join(ROOT, "tools/pwa-launcher/serve-pwa.mjs"), "--port", String(port), "--dir", dir], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("launcher did not start")), 10_000);
      child.stdout.on("data", (d) => { if (String(d).includes(`127.0.0.1:${port}`)) { clearTimeout(t); resolve(); } });
      child.on("exit", (code) => { clearTimeout(t); reject(new Error(`launcher exited ${code}`)); });
    });
    // node:http sends `path` verbatim (no dot-segment or backslash normalisation, unlike fetch()).
    const raw = (target) => new Promise((resolve, reject) => {
      const req = httpGet({ host: "127.0.0.1", port, path: target, agent: false }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => { body += d; });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      req.on("error", reject);
    });
    await fn(raw);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the launcher refuses private, traversal and encoded paths for every relay, before any upstream request", async () => {
  await withLauncher(async (raw) => {
    const refused = [
      // Upbit private endpoints and malformed reads
      "/x/upbit/v1/accounts", "/x/upbit/v1/orders?state=wait", "/x/upbit/v1/orders/chance", "/x/upbit/v1/withdraws",
      "/x/upbit/v1/candles/", "/x/upbit/v1/tickerx",
      // Upbit traversal: plain, encoded dots (both cases), double-encoded, encoded slash, backslash (raw and encoded)
      "/x/upbit/v1/candles/../accounts", "/x/upbit/v1/candles/%2e%2e/accounts", "/x/upbit/v1/candles/%2E%2e/%2e%2E/v1/accounts",
      "/x/upbit/v1/candles/%252e%252e/accounts", "/x/upbit/v1/candles/..%2faccounts", "/x/upbit/v1/candles/minutes%2f240",
      "/x/upbit/v1/candles/..\\accounts", "/x/upbit/v1/candles/%5c..%5caccounts",
      // Coins.ph private endpoint and the same traversal family (review fix round 1)
      "/x/coinsph/openapi/v1/account",
      "/x/coinsph/openapi/quote/v1/../../v1/account", "/x/coinsph/openapi/quote/v1/%2e%2e/%2e%2e/v1/account",
      "/x/coinsph/openapi/quote/v1/%2E%2E/%2E%2E/v1/account", "/x/coinsph/openapi/quote/v1/%252e%252e/%252e%252e/v1/account",
      "/x/coinsph/openapi/quote/v1/..%2f..%2fv1%2faccount", "/x/coinsph/openapi/quote/v1/..\\..\\v1\\account",
      "/x/coinsph/openapi/quote/v1/%5c..%5c..%5cv1%5caccount",
    ];
    for (const p of refused) {
      const r = await raw(p);
      assert.equal(r.status, 403, `${p} → ${r.status} ${r.body}`);
      assert.equal(r.body, "Path not allowed", p);
    }
    assert.equal((await raw("/")).status, 200);
  });
});

test("the launcher still forwards valid read paths unchanged (Coins.ph exactly as v2.6; Upbit without redirects)", async () => {
  await withLauncher(async (raw) => {
    const cases = [
      ["/x/coinsph/openapi/v1/time", "https://api.pro.coins.ph/openapi/v1/time", null],
      ["/x/coinsph/openapi/v1/exchangeInfo", "https://api.pro.coins.ph/openapi/v1/exchangeInfo", null],
      ["/x/coinsph/openapi/quote/v1/klines?symbol=BTCPHP&interval=1h&limit=1000", "https://api.pro.coins.ph/openapi/quote/v1/klines?symbol=BTCPHP&interval=1h&limit=1000", null],
      ["/x/coinsph/openapi/quote/v1/ticker/24hr", "https://api.pro.coins.ph/openapi/quote/v1/ticker/24hr", null],
      ["/x/upbit/v1/market/all", "https://api.upbit.com/v1/market/all", "error"],
      ["/x/upbit/v1/ticker/all?quote_currencies=KRW,USDT,BTC", "https://api.upbit.com/v1/ticker/all?quote_currencies=KRW,USDT,BTC", "error"],
      ["/x/upbit/v1/candles/minutes/240?market=KRW-BTC&count=200&to=2026-11-15T04%3A00%3A00Z", "https://api.upbit.com/v1/candles/minutes/240?market=KRW-BTC&count=200&to=2026-11-15T04%3A00%3A00Z", "error"],
    ];
    for (const [p, upstream, redirect] of cases) {
      const r = await raw(p);
      assert.equal(r.status, 200, `${p} → ${r.status} ${r.body}`);
      const echo = JSON.parse(r.body);
      assert.equal(echo.upstream, upstream, p);
      assert.equal(echo.redirect, redirect, p);
      // Coins.ph keeps its v2.6 fetch options exactly: signal + accept header, nothing else.
      if (p.startsWith("/x/coinsph/")) assert.deepEqual(echo.keys, ["headers", "signal"], p);
    }
  });
});
