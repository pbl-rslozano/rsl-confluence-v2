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
const CSP = [...(hostsTs.match(/export const CSP_HOSTS = \[([\s\S]*?)\] as const;/) || [, ""])[1].matchAll(/origin:\s*"([^"]+)"/g)].map((m) => m[1].replace(/^https?:\/\//, ""));

test("every CSP_HOSTS host is in the manifest's web.hosts (six FX hosts included)", () => {
  assert.ok(CSP.length >= 12);
  for (const h of CSP) assert.ok(manifest.processes.web.hosts.includes(h), `${h} in web.hosts`);
  const r = checkEgress();
  assert.equal(r.ok, true, formatEgressFindings(r));
  assert.deepEqual(r.webHostDrift, []);
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
