#!/usr/bin/env node
/**
 * release-check.mjs — release gate for rsL Confluence Terminal (builder skill §8–§9).
 *
 *   node tools/release-check.mjs [--with-tests] [--require-build]   (R17/R18 run when out/ is built; --require-build makes a missing build fail)
 *
 * Fails (exit 1) on any of:
 *   R1  private-key material or key files anywhere in the source tree
 *   R2  a dependency range instead of an exact version (any package.json)
 *   R3  missing lockfile (pnpm-lock.yaml, Cargo.lock)
 *   R4  rsL Core Kit files differ from KIT-MANIFEST.sha256
 *   R5  a native plugin imported outside packages/adapters
 *   R6  Tauri: CSP weakened (unsafe-eval, wildcard), isolation/freezePrototype off, wildcard capability
 *   R7  Capacitor: web debugging or mixed content enabled
 *   R8  CSP connect-src hosts not in the ADR-0003 allowlist
 *   R9  SBOM for this version missing
 *   R10 (--with-tests) any unit / regression / catalog test failing
 *   R11 recorder / MCP / tools egress outside tools/egress-manifest.json (ADR-0003, ADR-0008)
 *   R12 paper / MCP boundary: an order endpoint or private-API import in the paper or MCP code
 *   R13 app icon: rsL icon sources present and copied into the Capacitor projects (CI also checks the built APK/IPA, tools/check-icons.py)
 *   R14 an acceptance check in tools/acceptance-ids.json missing from the suite without an ADR (v2.5)
 *   R15 update channel (ADR-0012): service worker re-versioned per build, Netlify headers, update host in both CSPs, CI publish job
 *   R16 public-host table (v2.6, ADR-0013): Coins.ph read paths identical in public-hosts.ts, _redirects, the launcher proxy, the Tauri http scope, the egress manifest and ADR-0003
 *   R17 protected build (v2.6, ADR-0014): no source maps, only listed own chunks obfuscated, vendor chunks unchanged, build manifest complete (needs a built out/)
 *   R18 protected equivalence (v2.6, ADR-0014): evidence that acceptance + engine golden passed on this protected build (needs a built out/)
 *   R19 docs parity (v2.6): the architecture plan and the user guide cover every user-visible change; version stamps match
 *   R22 no organisation details (v2.8, KIT-002): no employer/company names, departments, people or sites in the
 *       source tree or the built web output (tools/checks/no-org-ids.mjs; salted word hashes)
 *   R21 display only (v2.7, ADR-0015): fx-rates.ts is imported by display code only, and fetches only table hosts
 *   R20 keyless public sources (v2.6): no keys/signatures in public sources, Coins.ph paths only from the read allowlist, no private profile
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", ".next", "out", "target", "gen", "dist", ".turbo", "android", "ios", "confluence-terminal-2.01", "evidence"]);
const results = [];
const check = (id, name, ok, detail = "") => { results.push({ id, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? "  — " + detail : ""}`); };

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p); else yield p;
  }
}
const files = [...walk(ROOT)];
const rel = (p) => relative(ROOT, p).split(sep).join("/");

/* R1 — private keys */
const keyName = /\.(key|pem|p12|pfx|jks|keystore|p8|mobileprovision)$|-PRIVATE|\.enc\.json$/i;
const keyText = /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|"d"\s*:\s*"[A-Za-z0-9_-]{40,}"|TAURI_SIGNING_PRIVATE_KEY\s*=\s*\S{20,}/;
const keyHits = [];
for (const f of files) {
  if (keyName.test(f)) keyHits.push(rel(f));
  else if (statSync(f).size < 2_000_000 && !/\.(png|ico|icns|woff2?|ttf|zip|jpg)$/i.test(f) && keyText.test(readFileSync(f, "utf8"))) keyHits.push(rel(f));
}
check("R1", "No private-key material in the source tree", keyHits.length === 0, keyHits.join(", ") || `${files.length} files scanned`);

/* R2 — exact versions */
const loose = [];
for (const f of files.filter((p) => p.endsWith("package.json"))) {
  const j = JSON.parse(readFileSync(f, "utf8"));
  for (const sec of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [n, v] of Object.entries(j[sec] || {})) if (!/^(workspace:\*|\d+\.\d+\.\d+(-[\w.]+)?)$/.test(v)) loose.push(`${rel(f)}:${n}@${v}`);
  }
}
const cargo = readFileSync(join(ROOT, "apps/confluence/desktop/src-tauri/Cargo.toml"), "utf8");
for (const m of cargo.matchAll(/^([\w-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)")/gm)) {
  const v = m[2] || m[3];
  if (m[1] !== "version" && m[1] !== "edition" && m[1] !== "rust-version" && v && !/^=\d/.test(v) && /^\d|^\^|^~/.test(v)) loose.push(`Cargo.toml:${m[1]}@${v}`);
}
check("R2", "Every dependency pinned to an exact version", loose.length === 0, loose.slice(0, 6).join(", ") || "npm + cargo");

/* R3 — lockfiles */
const locks = ["pnpm-lock.yaml", "apps/confluence/desktop/src-tauri/Cargo.lock"].filter((p) => !existsSync(join(ROOT, p)));
check("R3", "Lockfiles committed", locks.length === 0, locks.join(", ") || "pnpm-lock.yaml, Cargo.lock");

/* R4 — Core Kit unchanged */
const kitDir = join(ROOT, "packages/core");
const bad = [];
for (const line of readFileSync(join(kitDir, "KIT-MANIFEST.sha256"), "utf8").trim().split("\n")) {
  const [hash, file] = line.split(/\s+\*?/);
  const p = join(kitDir, file);
  if (!existsSync(p) || createHash("sha256").update(readFileSync(p)).digest("hex") !== hash) bad.push(file);
}
check("R4", "rsL Core Kit matches its manifest (changes only via a KIT-xxx owner decision)", bad.length === 0, bad.join(", ") || "18 files");

/* R5 — native imports only in adapters */
const nativeImport = /from\s+["'](@tauri-apps\/|@capacitor\/|@capacitor-community\/)/;
const leaks = files.filter((f) => /\.(m?[jt]sx?)$/.test(f) && !rel(f).startsWith("packages/adapters/") && !rel(f).startsWith("apps/confluence/mobile/") && nativeImport.test(readFileSync(f, "utf8"))).map(rel);
check("R5", "Native plugins imported only in packages/adapters", leaks.length === 0, leaks.join(", ") || "ports-and-adapters intact");

/* R6 — Tauri hardening */
const tconf = JSON.parse(readFileSync(join(ROOT, "apps/confluence/desktop/src-tauri/tauri.conf.json"), "utf8"));
const sec = tconf.app.security;
const cspText = Object.entries(sec.csp).map(([k, v]) => `${k} ${v}`).join("; ");
const caps = readFileSync(join(ROOT, "apps/confluence/desktop/src-tauri/capabilities/main.json"), "utf8");
const t = {
  isolation: sec.pattern?.use === "isolation",
  freezePrototype: sec.freezePrototype === true,
  noUnsafeEval: !/unsafe-eval/.test(cspText),
  scriptSelfOnly: sec.csp["script-src"] === "'self'",
  objectNone: sec.csp["object-src"] === "'none'",
  // v2.7 (review #11): every directive token, not a regex over the joined text.
  noCspWildcard: Object.entries(sec.csp).every(([dir, v]) => String(v).split(/\s+/).filter(Boolean).every((tok) =>
    !tok.includes("*") && tok !== "https:" && tok !== "http:" && (tok !== "data:" || dir === "img-src" || dir === "font-src"))),
  noCapWildcard: !/"path":\s*"(\*\*|\/\*\*|\$HOME\/\*\*|\$DOCUMENT\/\*\*|\$DOWNLOAD\/\*\*|\$DESKTOP\/\*\*)"|"url":\s*"\*"/.test(caps),
  noHttpsOpener: !/"url":\s*"https:\/\/\*"/.test(caps),
  // v2.7 (WP14.3): window permissions limited to theme + full screen.
  windowPermsMinimal: [...caps.matchAll(/"core:window:allow-([a-z-]+)"/g)].every((m) => ["set-theme", "set-fullscreen"].includes(m[1])),
  devtoolsOff: !/"devtools"\s*:\s*true/.test(readFileSync(join(ROOT, "apps/confluence/desktop/src-tauri/Cargo.toml"), "utf8") + JSON.stringify(tconf)),
};
check("R6", "Tauri: isolation, frozen prototypes, strict CSP, least-privilege capabilities", Object.values(t).every(Boolean), Object.entries(t).filter(([, v]) => !v).map(([k]) => k).join(", ") || Object.keys(t).length + " checks");

/* R7 — Capacitor hardening */
const cap = readFileSync(join(ROOT, "apps/confluence/mobile/capacitor.config.ts"), "utf8");
const c = { noDebug: !/webContentsDebuggingEnabled:\s*true/.test(cap), noMixed: !/allowMixedContent:\s*true/.test(cap), noCleartext: !/cleartext:\s*true/.test(cap) };
check("R7", "Capacitor: no web debugging, no mixed content, no cleartext", Object.values(c).every(Boolean), Object.entries(c).filter(([, v]) => !v).map(([k]) => k).join(", "));

/* R8 — network allowlist (ADR-0003). v2.7 (review #7): the allowlist is the public-host table
 * (src/lib/public-hosts.ts CSP_HOSTS); csp.ts builds connect-src from it; the desktop CSP must list
 * exactly the same hosts; every host must be named in ADR-0003. */
const hostsSource = readFileSync(join(ROOT, "apps/confluence/web/src/lib/public-hosts.ts"), "utf8");
const tableBlock = (hostsSource.match(/export const CSP_HOSTS = \[([\s\S]*?)\] as const;/) || [, ""])[1];
const TABLE = [...tableBlock.matchAll(/origin:\s*"([^"]+)"/g)].map((m) => m[1]);
const ALLOW = new Set(["'self'", "ipc:", "http://ipc.localhost", ...TABLE]);
const desktopHosts = sec.csp["connect-src"].split(/\s+/).filter(Boolean);
const extra = desktopHosts.filter((h) => !ALLOW.has(h));
const desktopMissing = TABLE.filter((h) => !desktopHosts.includes(h)).map((h) => `desktop CSP lacks ${h}`);
const cspSource = readFileSync(join(ROOT, "apps/confluence/web/src/lib/csp.ts"), "utf8");
const cspLiterals = [...cspSource.matchAll(/"(https?:\/\/[^"\s]+)"/g)].map((m) => m[1]).filter((h) => !ALLOW.has(h));
const metaConnect = !TABLE.length ? ["<CSP_HOSTS not found in public-hosts.ts>"]
  : !/CONNECT_SRC = \["'self'", \.\.\.CSP_HOSTS\.map/.test(cspSource) ? ["csp.ts does not build CONNECT_SRC from CSP_HOSTS"] : cspLiterals;
const adr3 = readFileSync(join(ROOT, "docs/adr/0003-network-allowlist.md"), "utf8");
const metaHosts = ["'self'", ...TABLE];
const notInAdr = TABLE.filter((h) => !adr3.includes(h.replace(/^https?:\/\//, ""))).map((h) => `${h} not in ADR-0003`);
check("R8", "connect-src = the public-host table (desktop CSP + web meta CSP), every host in ADR-0003", extra.length + metaConnect.length + desktopMissing.length + notInAdr.length === 0, [...extra, ...metaConnect, ...desktopMissing, ...notInAdr].join("; ") || `${TABLE.length} hosts`);

/* R9 — SBOM */
const ver = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version.replace(/\.0$/, "");
const sbom = join(ROOT, "dist", `rsL-Confluence-v${ver}-2026-sbom.cdx.json`);
check("R9", "CycloneDX SBOM present for this version", existsSync(sbom) && JSON.parse(readFileSync(sbom, "utf8")).bomFormat === "CycloneDX", rel(sbom));

/* R10 — tests */
if (process.argv.includes("--with-tests")) {
  let ok = true, detail = "";
  try { execSync("pnpm -s test", { cwd: ROOT, stdio: "pipe", timeout: 600_000 }); detail = "kit + engine + measurement (v2.2 + v2.3) + paper + FVG + catalogs + gateway + recorder + MCP + archive tool + egress"; }
  catch (e) { ok = false; detail = String(e.stdout || e.message).split("\n").filter((l) => /fail|✗|Error/i.test(l)).slice(0, 4).join(" | "); }
  check("R10", "All unit, regression and catalog tests pass", ok, detail);
}

/* R11 — egress of the Node processes (recorder, MCP, tools) */
{
  const { checkEgress, formatEgressFindings } = await import("./check-egress.mjs");
  const eg = checkEgress();
  check("R11", "Recorder / MCP / tools egress limited to tools/egress-manifest.json", eg.ok, formatEgressFindings(eg));
}

/* R12 — no order path anywhere (ADR-0009, ADR-0010; v2.3 review S2): no source file
 * outside tests references an exchange order / position-changing endpoint, the
 * paper modules make no network calls, and paper + MCP import no exchange client. */
{
  const ORDER = /\/api\/v3\/order|\/sapi\/v\d\/margin\/order|\/(fapi|dapi)\/v\d\/order|\/papi\/v\d\/\w+\/order|\/v5\/order\/|\/v5\/position\/(set|switch|trading-stop|add-margin)|place-?order|\/api\/v2\/(spot|mix)\/(trade|order)\/|\/api\/(spot|mix)\/v1\/(trade|order)/i;
  const isTest = (p) => /(^|\/)(test|tests|__tests__|test-support)\//.test(p) || /\.test\.[cm]?[jt]sx?$/.test(p);
  const bad = [];
  let scanned = 0;
  for (const root of ["apps", "packages", "tools"]) {
    for (const f of walk(join(ROOT, root))) {
      const r = rel(f);
      if (!/\.(m?[jt]sx?|cjs)$/.test(r) || isTest(r) || r === "tools/release-check.mjs") continue;
      scanned++;
      if (ORDER.test(readFileSync(f, "utf8"))) bad.push(`${r}: order endpoint`);
    }
  }
  const paper = ["apps/confluence/web/src/lib/risk-engine.ts", "apps/confluence/web/src/lib/paper-broker.ts", "apps/confluence/web/src/lib/paper-store.ts", "apps/confluence/web/src/components/paper-dialog.tsx"];
  const boundary = [...paper];
  const mcpDir = join(ROOT, "apps/confluence/mcp/src");
  if (existsSync(mcpDir)) for (const f of readdirSync(mcpDir)) if (/\.m?[jt]s$/.test(f)) boundary.push(`apps/confluence/mcp/src/${f}`);
  for (const f of boundary) {
    const p = join(ROOT, f);
    if (!existsSync(p)) { bad.push(`${f} missing`); continue; }
    const src = readFileSync(p, "utf8");
    if (paper.includes(f) && /\bfetch\s*\(|XMLHttpRequest|WebSocket\s*\(|EventSource\s*\(/.test(src)) bad.push(`${f}: network call`);
    if (/from\s+["'][^"']*(private-api|exchange-auth)["']/.test(src)) bad.push(`${f}: imports a private exchange client`);
    // market-client: only the bar-length table (a constant) may be imported, never a fetch function.
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*market-client["']/g)) {
      const names = m[1].split(",").map((x) => x.trim()).filter((x) => x && !x.startsWith("type "));
      if (names.some((n) => n !== "INTERVAL_MS")) bad.push(`${f}: imports ${names.join(", ")} from market-client`);
    }
    if (/import\s+\*\s+as\s+\w+\s+from\s*["'][^"']*market-client["']/.test(src)) bad.push(`${f}: namespace import of market-client`);
  }
  check("R12", "No order path: no order endpoint in any source file; paper/MCP make no network calls and import no exchange client", bad.length === 0, bad.join(" | ") || `${scanned} source files + ${boundary.length} boundary files`);
}

/* R13 — one app icon on every platform (v2.5). Source level here; CI runs tools/check-icons.py on the built APK/IPA. */
{
  const need = [
    "apps/confluence/desktop/src-tauri/icons/android/mipmap-xxxhdpi/ic_launcher.png",
    "apps/confluence/desktop/src-tauri/icons/android/values/ic_launcher_background.xml",
    "apps/confluence/mobile/resources/ios-AppIcon-1024.png",
    "tools/icon-fixtures/rsl-192.png",
  ].filter((f) => !existsSync(join(ROOT, f)));
  const wired = readFileSync(join(ROOT, "tools/apply-native-config.mjs"), "utf8").includes("applyIcons(");
  const ci = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
  const ciOk = ci.includes("check-icons.py --apk") && ci.includes("check-icons.py --ipa");
  check("R13", "rsL app icon wired into Android/iPhone builds and verified in CI", need.length === 0 && wired && ciOk, [...need.map((f) => `missing ${f}`), wired ? "" : "apply-native-config does not apply icons", ciOk ? "" : "CI icon check missing"].filter(Boolean).join("; ") || "sources present, wired, CI-checked");
}

/* R14 — acceptance checks cannot disappear without an ADR (v2.5; snapshot-overwrite guard) */
{
  const { listAcceptanceIds, checkIds } = await import("./check-acceptance-ids.mjs");
  const current = listAcceptanceIds(readFileSync(join(ROOT, "tools/e2e/acceptance.cjs"), "utf8"));
  const r = checkIds(current, JSON.parse(readFileSync(join(ROOT, "tools/acceptance-ids.json"), "utf8")));
  check("R14", "Acceptance check IDs kept (tools/acceptance-ids.json; removals need an ADR)", r.ok, r.ok ? `${current.length} IDs in suite` : `missing ${r.missing.join(", ")}`);
}

/* R15 — update channel (v2.5.1, ADR-0012) */
{
  const web = join(ROOT, "apps/confluence/web");
  const appInfo = readFileSync(join(web, "src/rsl/app-info.ts"), "utf8");
  const want = `v${/version:\s*"([^"]+)"/.exec(appInfo)?.[1]}-${/build:\s*"([^"]+)"/.exec(appInfo)?.[1]}`;
  const swVer = /const CACHE_VERSION = "([^"]+)"/.exec(readFileSync(join(web, "public/sw.js"), "utf8"))?.[1];
  const origin = /export const UPDATE_ORIGIN = "([^"]+)"/.exec(readFileSync(join(web, "src/lib/update-channel.ts"), "utf8"))?.[1];
  const headers = existsSync(join(web, "public/_headers")) ? readFileSync(join(web, "public/_headers"), "utf8") : "";
  const latestBlock = headers.split(/\n(?=\S)/).find((b) => b.startsWith("/updates/latest.json")) ?? "";
  const ci = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
  const problems = [
    swVer !== want && `sw.js CACHE_VERSION ${swVer} ≠ ${want}`,
    !origin && "UPDATE_ORIGIN missing",
    origin && !metaHosts.includes(origin) && "update host not in web CSP",
    origin && !sec.csp["connect-src"].split(/\s+/).includes(origin) && "update host not in desktop CSP",
    !/Access-Control-Allow-Origin:\s*\*/.test(latestBlock) && "_headers: latest.json lacks CORS",
    !/Cache-Control:\s*no-cache/.test(latestBlock) && "_headers: latest.json cacheable",
    !/publish-update\.mjs/.test(ci) && "release.yml has no publish job",
  ].filter(Boolean);
  check("R15", "Update channel wired (sw version, Netlify headers, update host in CSPs, CI publish)", problems.length === 0, problems.join("; ") || `${want} → ${origin}`);
}

/* R16 — hosts reached outside the CSP (v2.6, ADR-0013) */
{
  const { checkPublicHosts } = await import("./checks/public-hosts.mjs");
  const r = checkPublicHosts(ROOT);
  check("R16", "Public-host table consistent (rewrites, launcher, Tauri scope, egress manifest, ADR-0003)", r.ok, r.ok ? r.summary : r.findings.join("; "));
}

/* R17 / R18 — protected build and its equivalence evidence (v2.6 WP8, ADR-0014). They need a built out/; CI runs
 * them right after `pnpm build:pwa` and the acceptance run. Here they run when a build is present, or are required
 * with --require-build. */
{
  const web = join(ROOT, "apps", "confluence", "web");
  const outDir = join(web, "out"), manifestPath = join(web, "build-manifest.json");
  const built = existsSync(join(outDir, "index.html")) && existsSync(manifestPath);
  if (!built && !process.argv.includes("--require-build")) {
    console.log("SKIP  R17  Protected build — no built out/ here (CI runs it after pnpm build:pwa)");
    console.log("SKIP  R18  Protected equivalence — no built out/ here (CI runs it after acceptance)");
  } else {
    const { checkProtectedBuild, checkProtectedEquivalence } = await import("./checks/protected-build.mjs");
    const r17 = built ? checkProtectedBuild({ outDir, manifestPath, minifiedDir: join(web, "dist-minified") }) : { ok: false, findings: ["no built out/ and build-manifest.json"] };
    check("R17", "Protected build: no maps, only listed own chunks obfuscated, vendor unchanged, manifest complete", r17.ok, r17.ok ? `${r17.protected} protected of ${r17.files} files` : r17.findings.join("; "));
    const r18 = built ? checkProtectedEquivalence({ evidencePath: join(web, "build-evidence.json"), manifestPath }) : { ok: false, findings: ["no build"] };
    check("R18", "Protected equivalence: acceptance (BG-3) and engine golden (BG-4) passed on this protected tree", r18.ok, r18.findings.join("; "));
  }
}

/* R19 — every change in the plan and the user guide (v2.6, owner rule) */
{
  const { checkDocsParity } = await import("./checks/docs-parity.mjs");
  const r = checkDocsParity(ROOT);
  check("R19", "Architecture plan and user guide cover this release", r.ok, r.ok ? `${r.summary}${r.notes.length ? " · note: " + r.notes.join("; ") : ""}` : r.findings.join("; "));
}

/* R20 — public sources stay keyless and read-only (v2.6) */
{
  const { checkKeylessSources } = await import("./checks/keyless-sources.mjs");
  const r = checkKeylessSources(ROOT);
  check("R20", "Public sources keyless; Coins.ph paths only from the read allowlist; no private profile", r.ok, r.ok ? "coinsph, public-hosts, adapters" : r.findings.join("; "));
}

/* R21 — display currency is display only (v2.7, plan WP13.2) */
{
  const { checkDisplayOnly } = await import("./checks/display-only.mjs");
  const r = checkDisplayOnly(ROOT);
  check("R21", "Display-currency rates never reach engine, ledger, paper, recorder or MCP; FX hosts in the table", r.ok, r.ok ? r.summary : r.findings.join("; "));
}

/* R22 — no organisation details (v2.8, KIT-002, owner decision 14 Nov 2026) */
{
  const { checkNoOrgIds } = await import("./checks/no-org-ids.mjs");
  const r = checkNoOrgIds(ROOT);
  check("R22", "No organisation details (employer, department, people, sites) in source or built output", r.ok, r.ok ? r.summary : r.findings.join("; "));
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} release checks passed`);
process.exit(failed ? 1 : 0);
