#!/usr/bin/env node
/**
 * public-hosts.mjs — release check R16 (v2.6, ADR-0003 amendment v2.6, ADR-0013).
 *
 * Hosts the app reaches OUTSIDE the browser CSP (Coins.ph: no CORS header; v2.8 WP26
 * Upbit: unreliable CORS) are listed once, in apps/confluence/web/src/lib/public-hosts.ts
 * (NATIVE_HOSTS). For EVERY entry, every other place
 * that opens a path to them must say exactly the same thing:
 *
 *   - the Netlify rewrites            apps/confluence/web/public/_redirects
 *   - the local PWA launcher proxy    tools/pwa-launcher/serve-pwa.mjs
 *   - the Tauri HTTP capability       apps/confluence/desktop/src-tauri/capabilities/main.json
 *   - the egress manifest             tools/egress-manifest.json (web.nativeHosts, launcher)
 *   - ADR-0003                        docs/adr/0003-network-allowlist.md names the host
 *
 * Rewrites may only be plain 200 rewrites of read paths: no headers, no
 * signing, no force flags, no other upstream host.
 *
 *   node tools/checks/public-hosts.mjs      exit 0 = consistent
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const read = (root, p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null);

/** Parse the Coins.ph table out of public-hosts.ts (string literals only, so the check stays static). Used by R20. */
export function parseTable(src) {
  const origin = /export const COINSPH_ORIGIN = "([^"]+)"/.exec(src)?.[1] ?? null;
  const prefix = /export const COINSPH_PROXY_PREFIX = "([^"]+)"/.exec(src)?.[1] ?? null;
  const block = /export const COINSPH_READ_PATHS[^=]*=\s*\[([\s\S]*?)\]/.exec(src)?.[1] ?? "";
  const paths = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return { origin, prefix, paths };
}

/**
 * v2.8 (WP26): every NATIVE_HOSTS entry. Each entry is written `{ origin: <NAME>_ORIGIN, paths: <NAME>_READ_PATHS, … }`
 * and the module exports `<NAME>_ORIGIN`, `<NAME>_PROXY_PREFIX` and `<NAME>_READ_PATHS` as string literals.
 * A missing constant gives null / [] (a finding in checkPublicHosts).
 */
export function parseNativeHosts(src) {
  const block = /export const NATIVE_HOSTS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(src)?.[1] ?? "";
  const out = [];
  for (const m of block.matchAll(/\{\s*origin:\s*([A-Z0-9_]+)_ORIGIN\s*,\s*paths:\s*([A-Z0-9_]+)_READ_PATHS\b/g)) {
    const name = m[1];
    const origin = new RegExp(`export const ${name}_ORIGIN = "([^"]+)"`).exec(src)?.[1] ?? null;
    const prefix = new RegExp(`export const ${name}_PROXY_PREFIX = "([^"]+)"`).exec(src)?.[1] ?? null;
    const list = new RegExp(`export const ${m[2]}_READ_PATHS[^=]*=\\s*\\[([\\s\\S]*?)\\]`).exec(src)?.[1] ?? "";
    out.push({ name, origin, prefix, paths: [...list.matchAll(/"([^"]+)"/g)].map((x) => x[1]) });
  }
  // An entry written any other way (inline literals, other names) cannot be checked statically.
  const entries = (block.match(/\{\s*origin:/g) ?? []).length;
  if (entries !== out.length) out.push({ name: "<unparsed NATIVE_HOSTS entry>", origin: null, prefix: null, paths: [] });
  return out;
}

/** Display names used in findings (v2.6 wording kept for Coins.ph). */
const LABEL = { COINSPH: "Coins.ph", UPBIT: "Upbit" };

/** Expected Netlify/launcher route for each allowed path. */
function routeFor(path) {
  return path.endsWith("/") ? { from: `${path}*`, to: `${path}:splat` } : { from: path, to: path };
}

export function checkPublicHosts(root = ROOT) {
  const findings = [];
  const tableSrc = read(root, "apps/confluence/web/src/lib/public-hosts.ts");
  if (!tableSrc) return { ok: false, findings: ["public-hosts.ts missing"] };
  const hosts = parseNativeHosts(tableSrc);
  if (!hosts.length) findings.push("public-hosts.ts: NATIVE_HOSTS not found");
  if (!hosts.some((h) => h.name === "COINSPH")) findings.push("public-hosts.ts: COINSPH_ORIGIN / COINSPH_PROXY_PREFIX / COINSPH_READ_PATHS not found");

  const redirects = read(root, "apps/confluence/web/public/_redirects") ?? "";
  const rules = redirects.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => l.split(/\s+/));
  const launcher = read(root, "tools/pwa-launcher/serve-pwa.mjs") ?? "";
  if (/req\.headers|headers:\s*req\./.test(launcher)) findings.push("serve-pwa.mjs: proxy must not forward request headers");
  let eg = null;
  try {
    eg = JSON.parse(read(root, "tools/egress-manifest.json") ?? "{}");
  } catch {
    findings.push("egress-manifest.json unreadable");
  }
  const adr = read(root, "docs/adr/0003-network-allowlist.md") ?? "";

  // Tauri capability: the http scope must be exactly the union of every host's URLs, nothing broader.
  const capSrc = read(root, "apps/confluence/desktop/src-tauri/capabilities/main.json");
  let urls = [];
  try {
    const cap = JSON.parse(capSrc ?? "{}");
    for (const perm of cap.permissions ?? []) {
      const id = typeof perm === "string" ? perm : perm.identifier;
      if (!id?.startsWith("http:")) continue;
      if (typeof perm === "string") findings.push(`capability: ${id} without a URL scope`);
      urls.push(...(perm.allow ?? []).map((a) => a.url));
      if (perm.deny?.length) continue;
    }
  } catch {
    findings.push("capabilities/main.json unreadable");
  }
  const wantUrls = [];
  const summaries = [];

  for (const { name, origin, prefix, paths } of hosts) {
    const label = LABEL[name] ?? name;
    if (!origin || !prefix || !paths.length) {
      findings.push(`public-hosts.ts: ${name}_ORIGIN / ${name}_PROXY_PREFIX / ${name}_READ_PATHS not found`);
      continue;
    }
    const host = new URL(origin).host;

    // 1 — Netlify rewrites: exactly one plain 200 rule per allowed path, nothing else for this prefix.
    const mine = rules.filter((r) => r[0]?.startsWith(prefix + "/"));
    for (const p of paths) {
      const want = routeFor(p);
      const hit = mine.find((r) => r[0] === prefix + want.from);
      if (!hit) findings.push(`_redirects: no rule for ${prefix}${want.from}`);
      else if (hit[1] !== origin + want.to || hit[2] !== "200" || hit.length !== 3) findings.push(`_redirects: rule for ${p} must be "${prefix}${want.from} ${origin}${want.to} 200" (no headers, signing or force)`);
    }
    if (mine.length !== paths.length) findings.push(`_redirects: ${mine.length} rules under ${prefix}, expected ${paths.length}`);
    for (const r of rules) {
      if (r[1]?.includes(host) && !r[0]?.startsWith(prefix + "/")) findings.push(`_redirects: ${host} reached outside ${prefix}`);
      if (/signed|Header|!$/i.test(r.slice(2).join(" ")) && r[0]?.startsWith(prefix)) findings.push(`_redirects: extra options on ${r[0]}`);
    }

    // 2 — launcher proxy: same origin, prefix and path list.
    const lOrigin = new RegExp(`const ${name}_ORIGIN = "([^"]+)"`).exec(launcher)?.[1];
    const lPrefix = new RegExp(`const ${name}_PROXY_PREFIX = "([^"]+)"`).exec(launcher)?.[1];
    const lPaths = [...(new RegExp(`const ${name}_READ_PATHS = \\[([^\\]]*)\\]`).exec(launcher)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (lOrigin !== origin || lPrefix !== prefix || JSON.stringify(lPaths) !== JSON.stringify(paths)) findings.push(`serve-pwa.mjs: ${label} proxy constants differ from public-hosts.ts`);

    // 3 — Tauri URLs for this host.
    wantUrls.push(...paths.map((p) => origin + (p.endsWith("/") ? `${p}*` : p)));

    // 4 — egress manifest lists the host for the app (native) and the launcher.
    if (eg) {
      if (!(eg.processes?.web?.nativeHosts ?? []).includes(host)) findings.push(`egress-manifest: web.nativeHosts lacks ${host}`);
      if (!(eg.processes?.launcher?.hosts ?? []).includes(host)) findings.push(`egress-manifest: launcher.hosts lacks ${host}`);
    }

    // 5 — ADR-0003 names the host.
    if (!adr.includes(host)) findings.push(`ADR-0003 does not name ${host}`);

    summaries.push(`${host}: ${paths.length} read paths, ${mine.length} rewrites`);
  }
  if (JSON.stringify([...urls].sort()) !== JSON.stringify([...wantUrls].sort())) findings.push(`capability http scope ${JSON.stringify(urls)} ≠ ${JSON.stringify(wantUrls)}`);

  return { ok: findings.length === 0, findings, summary: `${summaries.join("; ")}; ${urls.length} Tauri URLs` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const r = checkPublicHosts();
  console.log(r.ok ? `R16 ok — ${r.summary}` : `R16 FAIL\n  ${r.findings.join("\n  ")}`);
  process.exit(r.ok ? 0 : 1);
}
