// Tests for release check R11 (tools/check-egress.mjs) added in v2.8 WP20 (licence audit 14 Nov 2026):
// the manifest's one-page overview lists every host the WebView may fetch, and the gateway's account-key hosts.
//   node --test tools/check-egress.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEgress, formatEgressFindings, ROOT } from "./check-egress.mjs";

const manifest = JSON.parse(readFileSync(join(ROOT, "tools", "egress-manifest.json"), "utf8"));
const hostsTs = readFileSync(join(ROOT, "apps/confluence/web/src/lib/public-hosts.ts"), "utf8");
const CSP = [...(hostsTs.match(/export const CSP_HOSTS = \[([\s\S]*?)\] as const;/) || [, ""])[1].matchAll(/origin:\s*"([^"]+)"/g)].map((m) => m[1].replace(/^(?:https?|wss):\/\//, ""));

test("every CSP_HOSTS host is in the manifest's web.hosts (six FX hosts included)", () => {
  assert.ok(CSP.length >= 12);
  for (const h of CSP) assert.ok(manifest.processes.web.hosts.includes(h), `${h} in web.hosts`);
  const r = checkEgress();
  assert.equal(r.ok, true, formatEgressFindings(r));
  assert.deepEqual(r.webHostDrift, []);
});

test("v2.8 WP26: every CSP_HOSTS origin is in web.hosts and web.csp; Upbit only as a native host; Node processes get all three", () => {
  const web = manifest.processes.web;
  for (const o of ["https://www.okx.com", "https://api.exchange.coinbase.com"]) {
    assert.ok(CSP.includes(o.replace(/^https:\/\//, "")), `${o} in CSP_HOSTS`);
    assert.ok(web.hosts.includes(o.replace(/^https:\/\//, "")), `${o} in web.hosts`);
    assert.ok(web.csp.includes(o), `${o} in web.csp`);
  }
  for (const h of CSP) assert.ok(web.hosts.includes(h), `${h} in web.hosts`);
  assert.ok(!CSP.includes("api.upbit.com") && !web.hosts.includes("api.upbit.com") && !web.csp.some((h) => h.includes("api.upbit.com")), "Upbit never in the CSP");
  assert.deepEqual(web.nativeHosts, ["api.pro.coins.ph", "api.upbit.com"]);
  assert.ok(manifest.processes.launcher.hosts.includes("api.upbit.com"));
  for (const h of ["www.okx.com", "api.exchange.coinbase.com", "api.upbit.com"]) assert.ok(manifest.processes.recorder.hosts.includes(h), `recorder: ${h}`);
});

test("v2.8 WP28: web.hosts lists the four backup CSP hosts, web.csp the origins; Google and B2/R2 never in the CSP", () => {
  const web = manifest.processes.web;
  for (const h of ["login.microsoftonline.com", "graph.microsoft.com", "api.pcloud.com", "eapi.pcloud.com"]) {
    assert.ok(CSP.includes(h), `${h} in CSP_HOSTS`);
    assert.ok(web.hosts.includes(h), `${h} in web.hosts`);
    assert.ok(web.csp.includes(`https://${h}`), `https://${h} in web.csp`);
  }
  for (const h of CSP) assert.ok(!/google|backblazeb2|r2\.cloudflarestorage/.test(h), `${h} must not be a CSP host`);
  assert.deepEqual(web.backupNativeHosts, ["oauth2.googleapis.com", "www.googleapis.com", "login.microsoftonline.com", "graph.microsoft.com", "api.pcloud.com", "eapi.pcloud.com"]);
  assert.deepEqual(web.signInPages, ["accounts.google.com", "login.microsoftonline.com", "my.pcloud.com"]);
  const r = checkEgress();
  assert.equal(r.ok, true, formatEgressFindings(r));
  assert.deepEqual(r.webHostDrift, []);
  assert.deepEqual(r.cspDrift, []);
});

test("v2.8 WP25 part 2: the wss CSP hosts must be in web.hosts without the scheme and in web.csp with it", () => {
  const web = manifest.processes.web;
  for (const o of ["wss://fstream.binance.com", "wss://stream.bybit.com"]) {
    assert.ok(hostsTs.includes(`"${o}"`), `${o} in CSP_HOSTS`);
    assert.ok(web.hosts.includes(o.replace(/^wss:\/\//, "")), `${o} in web.hosts`);
    assert.ok(web.csp.includes(o), `${o} in web.csp`);
    assert.ok(!web.hosts.includes(o), `${o} is not in web.hosts with its scheme`);
  }
});

test("a wss CSP host missing from web.hosts is a finding (the scheme is stripped like http and https)", () => {
  const dir = mkdtempSync(join(tmpdir(), "egress-"));
  try {
    mkdirSync(join(dir, "tools"));
    mkdirSync(join(dir, "apps/confluence/web/src/lib"), { recursive: true });
    for (const f of ["csp.ts", "public-hosts.ts"]) cpSync(join(ROOT, "apps/confluence/web/src/lib", f), join(dir, "apps/confluence/web/src/lib", f));
    const m = structuredClone(manifest);
    m.processes.web.hosts = m.processes.web.hosts.filter((h) => h !== "stream.bybit.com");
    for (const p of Object.values(m.processes)) p.roots = [];
    writeFileSync(join(dir, "tools", "egress-manifest.json"), JSON.stringify(m));
    const r = checkEgress({ root: dir });
    assert.equal(r.ok, false);
    assert.deepEqual(r.webHostDrift, ["stream.bybit.com is in CSP_HOSTS but not in web.hosts"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a CSP host missing from web.hosts is a finding", () => {
  const dir = mkdtempSync(join(tmpdir(), "egress-"));
  try {
    mkdirSync(join(dir, "tools"));
    mkdirSync(join(dir, "apps/confluence/web/src/lib"), { recursive: true });
    for (const f of ["csp.ts", "public-hosts.ts"]) cpSync(join(ROOT, "apps/confluence/web/src/lib", f), join(dir, "apps/confluence/web/src/lib", f));
    const m = structuredClone(manifest);
    m.processes.web.hosts = m.processes.web.hosts.filter((h) => h !== "open.er-api.com");
    for (const p of Object.values(m.processes)) p.roots = [];
    writeFileSync(join(dir, "tools", "egress-manifest.json"), JSON.stringify(m));
    const r = checkEgress({ root: dir });
    assert.equal(r.ok, false);
    assert.deepEqual(r.webHostDrift, ["open.er-api.com is in CSP_HOSTS but not in web.hosts"]);
    assert.match(formatEgressFindings(r), /open\.er-api\.com/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the gateway process lists the exchanges' account-key hosts and its sources pass", () => {
  const g = manifest.processes.gateway;
  assert.ok(g, "gateway process");
  for (const h of ["api.binance.com", "testnet.binance.vision", "api.bybit.com", "api-testnet.bybit.com", "api.bitget.com"]) assert.ok(g.hosts.includes(h), h);
  const r = checkEgress({ processes: ["gateway"] });
  assert.equal(r.ok, true, formatEgressFindings(r));
  assert.ok(r.scanned >= 1);
});

// v2.8 WP28 Task 8: `hostTemplates` lets a process name exactly its listed per-account host literals (B2 and R2 buckets).
function templateFixture(source, { templates = ["s3.${region}.backblazeb2.com", "${accountId}.r2.cloudflarestorage.com"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "egress-"));
  mkdirSync(join(dir, "tools"));
  mkdirSync(join(dir, "gw"));
  writeFileSync(join(dir, "gw", "store.mjs"), source);
  const proc = { roots: ["gw"], hosts: [], ...(templates ? { hostTemplates: templates } : {}) };
  writeFileSync(join(dir, "tools", "egress-manifest.json"), JSON.stringify({ schema: 1, processes: { gateway: proc } }));
  return dir;
}

test("v2.8 WP28 hostTemplates: exactly the two B2/R2 literals pass; any other dynamic host is still a finding", () => {
  const cases = [
    ["const o = `https://s3.${region}.backblazeb2.com`;", true],
    ["const o = `https://${accountId}.r2.cloudflarestorage.com`;", true],
    ["const o = `https://s3.${region}.backblazeb2.com/${bucket}`;", true],
    ["const o = `https://${host}/x`;", false],
    ["const o = `https://${accountId}.evil.example/x`;", false],
    ["const o = `https://s3.${other}.backblazeb2.com`;", false],
    ["const o = `https://s3.${region}.backblazeb2.com.evil.example`;", false],
    ["const o = `https://evil.${accountId}.r2.cloudflarestorage.com`;", false],
    ["const o = `https://${region}.backblazeb2.com`;", false],
    ["const o = `wss://s3.${region}.backblazeb2.com`;", false],
  ];
  for (const [source, passes] of cases) {
    const dir = templateFixture(source);
    try {
      const r = checkEgress({ root: dir, processes: ["gateway"] });
      assert.equal(r.ok, passes, `${source} -> ${formatEgressFindings(r)}`);
      if (!passes) assert.equal(r.findings[0].reason.length > 0, true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("v2.8 WP28 hostTemplates: a process without the list gets no exemption, and a literal host still needs `hosts`", () => {
  const dir = templateFixture("const o = `https://s3.${region}.backblazeb2.com`;", { templates: null });
  try {
    const r = checkEgress({ root: dir, processes: ["gateway"] });
    assert.equal(r.ok, false);
    assert.match(r.findings[0].reason, /built at runtime/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const dir2 = templateFixture("const o = 'https://s3.us-west-004.backblazeb2.com';");
  try {
    assert.equal(checkEgress({ root: dir2, processes: ["gateway"] }).ok, false, "a template does not allow a concrete host");
  } finally { rmSync(dir2, { recursive: true, force: true }); }
});

test("v2.8 WP28: the real gateway lists exactly the two templates, scans the two new files, and passes", () => {
  const gateway = manifest.processes.gateway;
  assert.deepEqual(gateway.hostTemplates, ["s3.${region}.backblazeb2.com", "${accountId}.r2.cloudflarestorage.com"]);
  for (const f of ["apps/confluence/gateway/s3-sign.mjs", "apps/confluence/gateway/backup-store.mjs"]) assert.ok(gateway.roots.includes(f), f);
  assert.ok(!gateway.hosts.some((h) => /backblazeb2|r2\.cloudflarestorage/.test(h)), "templates are not concrete hosts");
  const r = checkEgress({ processes: ["gateway"] });
  assert.equal(r.ok, true, formatEgressFindings(r));
  for (const h of [...manifest.processes.web.hosts, ...manifest.processes.web.csp]) assert.ok(!/backblazeb2|r2\.cloudflarestorage/.test(h), `${h} must not be a web host`);
});
