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
  assert.equal(r2.ok, false);
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

test("the launcher refuses Upbit and Coins.ph private paths before any upstream request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "launcher-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>t</title>");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [join(ROOT, "tools/pwa-launcher/serve-pwa.mjs"), "--port", String(port), "--dir", dir], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("launcher did not start")), 10_000);
      child.stdout.on("data", (d) => { if (String(d).includes(`127.0.0.1:${port}`)) { clearTimeout(t); resolve(); } });
      child.on("exit", (code) => { clearTimeout(t); reject(new Error(`launcher exited ${code}`)); });
    });
    const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).status;
    for (const p of ["/x/upbit/v1/accounts", "/x/upbit/v1/orders?state=wait", "/x/upbit/v1/orders/chance", "/x/upbit/v1/withdraws", "/x/upbit/v1/candles/..%2faccounts", "/x/upbit/v1/candles/%2e%2e/accounts", "/x/upbit/v1/candles/", "/x/upbit/v1/tickerx", "/x/coinsph/openapi/v1/account"]) {
      assert.equal(await get(p), 403, p);
    }
    assert.equal(await get("/"), 200);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
