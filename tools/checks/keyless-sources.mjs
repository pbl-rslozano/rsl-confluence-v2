#!/usr/bin/env node
/**
 * keyless-sources.mjs — release check R20 (v2.6, ADR-0013, ADR-0014).
 *
 * Public market-data sources stay keyless and read-only:
 *   1. the public-source modules (coinsph.ts, public-hosts.ts) contain no key,
 *      signature or auth-header handling;
 *   2. no app or adapter source references a Coins.ph path outside the read
 *      allowlist in src/lib/public-hosts.ts (an allowlist, not a denylist);
 *   3. Coins.ph is never a private-API profile: no `privateApi` on its source
 *      entry, and no mention in the private-API code or the local gateway.
 *
 *   node tools/checks/keyless-sources.mjs     exit 0 = ok
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseTable } from "./public-hosts.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP = new Set(["node_modules", ".next", "out", "dist", "dist-minified", ".turbo", "android", "ios", "gen", "target"]);
const isTest = (p) => /\.test\.[cm]?[jt]sx?$/.test(p) || /[\\/](test|tests|__tests__)[\\/]/.test(p);

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e)) yield p;
  }
}

const AUTH = /X-COINS-APIKEY|apiSecret|api_secret|createHmac|HmacSHA256|\bsignature\b|Authorization['"]?\s*:/i;

export function checkKeylessSources(root = ROOT) {
  const findings = [];
  const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : "");
  const lib = "apps/confluence/web/src/lib";

  for (const f of [`${lib}/coinsph.ts`, `${lib}/public-hosts.ts`]) {
    const src = read(f);
    if (!src) findings.push(`${f} missing`);
    else if (AUTH.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""))) findings.push(`${f}: key/signature/auth handling in a public source`);
  }

  const { paths } = parseTable(read(`${lib}/public-hosts.ts`));
  const allowed = (p) => paths.some((a) => (a.endsWith("/") ? p.startsWith(a) && p.length > a.length : p === a));
  for (const dir of ["apps/confluence/web/src", "packages/adapters"]) {
    for (const file of walk(join(root, dir))) {
      const rel = relative(root, file).split(sep).join("/");
      if (isTest(rel) || rel === `${lib}/public-hosts.ts`) continue; // the table itself
      const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$|^\s*\*.*$/gm, "");
      for (const m of src.matchAll(/["'`](\/openapi\/[A-Za-z0-9_\/.-]*)/g)) {
        const path = m[1].replace(/[?].*$/, "");
        // A template that continues after the literal (e.g. `/openapi/quote/v1/klines?symbol=${…}`) is matched up to "?".
        if (!allowed(path) && !paths.includes(path + "/")) findings.push(`${rel}: Coins.ph path ${path} outside the read allowlist`);
      }
    }
  }

  const mc = read(`${lib}/market-client.ts`);
  const entry = /value:\s*"coinsph"[\s\S]*?\}/.exec(mc)?.[0] ?? "";
  if (!entry) findings.push("market-client.ts: coinsph source entry not found");
  else if (/privateApi\s*:/.test(entry)) findings.push("market-client.ts: coinsph has a privateApi profile");
  for (const f of [`${lib}/private-api.ts`, "apps/confluence/web/src/components/private-api-dialog.tsx", "apps/confluence/gateway/server.mjs", "apps/confluence/gateway/exchange-auth.mjs"]) {
    if (/coins\.?ph/i.test(read(f))) findings.push(`${f}: mentions Coins.ph (no private profile allowed)`);
  }
  return { ok: findings.length === 0, findings };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const r = checkKeylessSources();
  console.log(r.ok ? "R20 ok" : `R20 FAIL\n  ${r.findings.join("\n  ")}`);
  process.exit(r.ok ? 0 : 1);
}
