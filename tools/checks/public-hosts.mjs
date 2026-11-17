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
 * v2.8 (WP28, encrypted cloud backup): BACKUP_NATIVE_URLS (native HTTP, outside the CSP) and BACKUP_SIGN_IN_URLS
 * (opened in the system browser, never fetched) are checked the same way: the Tauri http scope is the native URLs
 * above plus BACKUP_NATIVE_URLS, the opener scope is the mailto link plus BACKUP_SIGN_IN_URLS, the egress manifest
 * lists their hosts under web.backupNativeHosts / web.signInPages (equal sets), and ADR-0003 names every host.
 * Google is desktop only, so no Google host may be a CSP host; B2 and R2 are gateway only, so no CSP host either.
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

/** v2.8 (WP28): the string literals of one `export const NAME = [ ... ]` list (null when the constant is missing). */
export function parseUrlList(src, name) {
  const block = new RegExp(`export const ${name}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\]`).exec(src)?.[1];
  return block === undefined ? null : [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** The origins in CSP_HOSTS (v2.8 WP28 uses them to keep Google, B2 and R2 out of the CSP). */
function cspOrigins(src) {
  const block = /export const CSP_HOSTS = \[([\s\S]*?)\] as const;/.exec(src)?.[1] ?? "";
  return [...block.matchAll(/origin:\s*"([^"]+)"/g)].map((m) => m[1]);
}

const hostOf = (url) => { try { return new URL(url.replace(/\*$/, "")).host; } catch { return null; } };
const unique = (l) => [...new Set(l)];

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
  let openerUrls = null;
  try {
    const cap = JSON.parse(capSrc ?? "{}");
    for (const perm of cap.permissions ?? []) {
      const id = typeof perm === "string" ? perm : perm.identifier;
      if (id === "opener:allow-open-url" && typeof perm !== "string") openerUrls = (perm.allow ?? []).map((a) => a.url);
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

  // v2.8 (WP28) — encrypted cloud backup hosts.
  const backupNative = parseUrlList(tableSrc, "BACKUP_NATIVE_URLS");
  const signIn = parseUrlList(tableSrc, "BACKUP_SIGN_IN_URLS");
  if (!backupNative?.length) findings.push("public-hosts.ts: BACKUP_NATIVE_URLS not found");
  if (!signIn?.length) findings.push("public-hosts.ts: BACKUP_SIGN_IN_URLS not found");
  for (const [name, list] of [["BACKUP_NATIVE_URLS", backupNative ?? []], ["BACKUP_SIGN_IN_URLS", signIn ?? []]]) {
    for (const e of list) {
      let u = null;
      try { u = new URL(e.replace(/\*$/, "")); } catch { /* reported below */ }
      // https, a host, a path that names something (never a whole host), no userinfo, query or hash, no dot segments.
      if (!u || u.protocol !== "https:" || u.username || u.password || u.search || u.hash || e.includes("?") || e.includes("#") || u.pathname === "/" || e.includes("..") || e.indexOf("*") !== -1 && e.indexOf("*") !== e.length - 1) findings.push(`public-hosts.ts: ${name} entry ${e} must be an https URL with a path (no whole host), no query or hash, and "*" only as a final prefix mark`);
    }
  }
  wantUrls.push(...(backupNative ?? []));
  if (JSON.stringify([...urls].sort()) !== JSON.stringify([...wantUrls].sort())) findings.push(`capability http scope ${JSON.stringify(urls)} ≠ ${JSON.stringify(wantUrls)}`);

  const wantOpener = ["mailto:rslozano@gmail.com*", ...(signIn ?? [])];
  if (openerUrls === null) findings.push("capability: opener:allow-open-url scope missing");
  else if (JSON.stringify([...openerUrls].sort()) !== JSON.stringify([...wantOpener].sort())) findings.push(`capability opener scope ${JSON.stringify(openerUrls)} ≠ ${JSON.stringify(wantOpener)}`);

  const nativeBackupHosts = unique((backupNative ?? []).map(hostOf).filter(Boolean));
  const signInHosts = unique((signIn ?? []).map(hostOf).filter(Boolean));
  if (eg) {
    for (const [key, want] of [["backupNativeHosts", nativeBackupHosts], ["signInPages", signInHosts]]) {
      const have = eg.processes?.web?.[key];
      if (!Array.isArray(have)) { findings.push(`egress-manifest: web.${key} lacks ${want.join(", ")}`); continue; }
      for (const h of want) if (!have.includes(h)) findings.push(`egress-manifest: web.${key} lacks ${h}`);
      for (const h of have) if (!want.includes(h)) findings.push(`egress-manifest: web.${key} lists ${h}, which is not ${key === "signInPages" ? "a sign-in page" : "a backup native host"} in public-hosts.ts`);
    }
  }
  for (const h of unique([...nativeBackupHosts, ...signInHosts])) if (!adr.includes(h)) findings.push(`ADR-0003 does not name ${h}`);

  // Google is desktop only and B2 / R2 are gateway only: none of them may be a CSP host. Origins the OneDrive
  // download check adds must be CSP hosts and native backup URLs too.
  const csp = cspOrigins(tableSrc);
  for (const o of csp) {
    if (/(^|\.)(google|googleapis|gstatic)\.com$/i.test(new URL(o).hostname)) findings.push(`public-hosts.ts: CSP_HOSTS lists Google host ${o}; Google is reached from the desktop app only`);
    if (/backblazeb2\.com$|r2\.cloudflarestorage\.com$/i.test(new URL(o).hostname)) findings.push(`public-hosts.ts: CSP_HOSTS lists ${o}; B2 and R2 are gateway only`);
  }
  for (const o of parseUrlList(tableSrc, "ONEDRIVE_DOWNLOAD_ORIGINS") ?? []) {
    if (!csp.includes(o)) findings.push(`public-hosts.ts: ONEDRIVE_DOWNLOAD_ORIGINS lists ${o}, which is not in CSP_HOSTS`);
    if (!(backupNative ?? []).some((e) => e.startsWith(o + "/"))) findings.push(`public-hosts.ts: ONEDRIVE_DOWNLOAD_ORIGINS lists ${o}, which is not in BACKUP_NATIVE_URLS`);
  }
  const backupSummary = `${(backupNative ?? []).length} backup URLs, ${(signIn ?? []).length} sign-in pages`;

  return { ok: findings.length === 0, findings, summary: `${summaries.join("; ")}; ${urls.length} Tauri URLs; ${backupSummary}` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const r = checkPublicHosts();
  console.log(r.ok ? `R16 ok — ${r.summary}` : `R16 FAIL\n  ${r.findings.join("\n  ")}`);
  process.exit(r.ok ? 0 : 1);
}
