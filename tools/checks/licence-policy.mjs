/**
 * licence-policy.mjs — release check R24 (v2.8 WP20, licence audit 14 Nov 2026).
 *
 * Every component shipped in a bundle must carry an allowed licence (tools/licence-policy.json):
 *   - npm: the production closure that tools/third-party-notices.mjs lists (build-only packages are not judged);
 *   - Rust: the crates in apps/confluence/desktop/src-tauri/third-party-crates.json, which must match Cargo.lock;
 *   - MPL-2.0 only with a notice entry (licence text + source location in the notices);
 *   - first-party: @rsl/* and the desktop crate, "UNLICENSED" (all rights reserved) — and every private workspace
 *     package.json says so (packages/core is the vendored Core Kit and changes only through a KIT issue);
 *   - no Binance Vision monthly archive file (CC BY-NC-SA 4.0, personal backtesting only) is tracked, and .gitignore
 *     keeps them out wherever they are written.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { npmInventory, checkRustInventory, PRODUCTION_ROOTS, RUST_DIR, RUST_INVENTORY, RUST_NOTICES } from "../third-party-notices.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadPolicy(root = ROOT) {
  return JSON.parse(readFileSync(join(root, "tools", "licence-policy.json"), "utf8"));
}

/* ---- SPDX expression → alternatives (OR of AND-sets) ---- */
function tokenize(expr) {
  return expr.replace(/\s*\/\s*/g, " OR ").replace(/([()])/g, " $1 ").split(/\s+/).filter(Boolean);
}
function parse(tokens) {
  let i = 0;
  const peek = () => tokens[i];
  const primary = () => {
    const t = tokens[i++];
    if (t === "(") { const v = orExpr(); if (tokens[i++] !== ")") throw new Error("unbalanced"); return v; }
    if (!t || ["AND", "OR", "WITH", ")"].includes(t)) throw new Error(`unexpected ${t ?? "end"}`);
    if (peek() === "WITH") { i++; const ex = tokens[i++]; if (!ex) throw new Error("WITH without exception"); return [[`${t} WITH ${ex}`]]; }
    return [[t]];
  };
  const andExpr = () => {
    let left = primary();
    while (peek() === "AND") { i++; const right = primary(); left = left.flatMap((a) => right.map((b) => [...a, ...b])); }
    return left;
  };
  const orExpr = () => {
    let left = andExpr();
    while (peek() === "OR") { i++; left = [...left, ...andExpr()]; }
    return left;
  };
  const v = orExpr();
  if (i !== tokens.length) throw new Error(`unexpected ${tokens[i]}`);
  return v;
}

/**
 * @returns {{ ok: boolean, needsNotice: boolean, reason: string }}  needsNotice: only a branch with MPL-2.0 passes.
 */
export function evaluateLicence(expr, policy, { noticed = false } = {}) {
  if (!expr || !String(expr).trim()) return { ok: false, needsNotice: false, reason: "no licence declared" };
  let alts;
  try { alts = parse(tokenize(String(expr).trim())); } catch (e) { return { ok: false, needsNotice: false, reason: `unparseable licence "${expr}" (${e.message})` }; }
  const allow = new Set(policy.allow);
  const withNotice = new Set(policy.withNotice ?? []);
  const exceptions = new Set(policy.exceptions ?? []);
  const base = (id) => {
    const m = id.match(/^(\S+) WITH (\S+)$/);
    return m ? (exceptions.has(m[2]) ? m[1] : null) : id;
  };
  const plain = alts.find((a) => a.every((id) => allow.has(base(id))));
  if (plain) return { ok: true, needsNotice: false, reason: plain.join(" AND ") };
  const cond = alts.find((a) => a.every((id) => allow.has(base(id)) || withNotice.has(base(id))));
  if (cond) return noticed ? { ok: true, needsNotice: true, reason: cond.join(" AND ") } : { ok: false, needsNotice: true, reason: `${cond.join(" AND ")} needs a notice entry (licence text + source location)` };
  return { ok: false, needsNotice: false, reason: `${expr} is not on the allow-list` };
}

/**
 * @param {{name: string, version: string, license: string, scope?: string}[]} components
 * @param {{ mplNoticed?: Set<string>, firstPartyCrates?: string[] }} [opts]
 */
export function checkComponents(components, policy, { mplNoticed = new Set(), firstPartyCrates = policy.firstParty?.crates ?? [] } = {}) {
  const findings = [];
  let judged = 0, excluded = 0, firstParty = 0;
  for (const comp of components) {
    const key = `${comp.name}@${comp.version}`;
    const isFirst = comp.name.startsWith(policy.firstParty?.npmScope ?? "@rsl/") || firstPartyCrates.includes(comp.name);
    if (isFirst) { firstParty++; continue; }
    if (comp.scope === "excluded") { excluded++; continue; }
    judged++;
    if (String(comp.license).trim() === (policy.firstParty?.licence ?? "UNLICENSED")) { findings.push(`${key}: UNLICENSED is allowed only for first-party packages`); continue; }
    const r = evaluateLicence(comp.license, policy, { noticed: mplNoticed.has(key) });
    if (!r.ok) findings.push(`${key}: ${r.reason}`);
  }
  return { ok: findings.length === 0, findings, judged, excluded, firstParty };
}

/* ---- Binance Vision archive files ---- */
export const ARCHIVE_FILE = /(^|\/)[A-Z0-9]{2,30}-(1s|1m|3m|5m|15m|30m|1h|2h|4h|6h|8h|12h|1d|3d|1w|1mo)-\d{4}-\d{2}(-\d{2})?\.(csv|zip)(\.CHECKSUM)?$/;
export const ARCHIVE_IGNORE = ["*-[0-9][0-9][0-9][0-9]-[0-9][0-9].csv", "*-[0-9][0-9][0-9][0-9]-[0-9][0-9].zip"];

export function checkArchiveNotTracked(tracked, { root } = {}) {
  const findings = tracked.filter((f) => ARCHIVE_FILE.test(f)).map((f) => `${f}: Binance Vision archive file tracked (CC BY-NC-SA 4.0, personal backtesting only — never commit)`);
  if (root) {
    const gi = existsSync(join(root, ".gitignore")) ? readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/).map((l) => l.trim()) : [];
    for (const p of ARCHIVE_IGNORE) if (!gi.includes(p)) findings.push(`.gitignore lacks ${p} (monthly Binance Vision files outside klines/)`);
  }
  return { ok: findings.length === 0, findings };
}

function trackedFiles(root) {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  } catch {
    // Not a git checkout (e.g. a source zip): judge every file that is there.
    const out = [];
    const skip = new Set(["node_modules", ".git", ".next", "out", "target", "dist", ".turbo"]);
    const walk = (d) => { for (const e of readdirSync(d)) { if (skip.has(e)) continue; const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else out.push(relative(root, p).split(sep).join("/")); } };
    walk(root);
    return out;
  }
}

/** MPL crates whose notices entry carries a source location. */
function noticedCrates(rustText) {
  const set = new Set();
  for (const m of rustText.matchAll(/^(\S+) (\S+) — [^\n]*\n {4}Source code: https:\/\/crates\.io\/crates\/\S+/gm)) set.add(`${m[1]}@${m[2]}`);
  return set;
}

const WORKSPACE_GLOBS = ["", "apps/confluence", "packages/adapters"];

/**
 * @param {{ root?: string, roots?: string[], skip?: ("npm"|"rust"|"archive"|"workspace")[] }} [opts]
 * @returns {{ ok: boolean, findings: string[], summary: string }}
 */
export function checkLicencePolicy({ root = ROOT, roots = PRODUCTION_ROOTS, skip = [] } = {}) {
  const policy = loadPolicy(existsSync(join(root, "tools", "licence-policy.json")) ? root : ROOT);
  const findings = [];
  const parts = [];
  if (!skip.includes("npm")) {
    const inv = npmInventory({ root, roots });
    const comps = [...inv.shipped, ...inv.buildOnly];
    const noticed = new Set(inv.shipped.filter((p) => p.texts.length).map((p) => `${p.name}@${p.version}`));
    const r = checkComponents(comps, policy, { mplNoticed: noticed });
    findings.push(...r.findings);
    parts.push(`${r.judged} npm shipped (${r.excluded} build-only not judged)`);
  }
  if (!skip.includes("rust")) {
    const invPath = join(root, RUST_INVENTORY);
    if (!existsSync(invPath)) findings.push(`${RUST_INVENTORY} missing — node tools/third-party-notices.mjs --rust`);
    else {
      const crates = JSON.parse(readFileSync(invPath, "utf8")).crates;
      const rustText = existsSync(join(root, RUST_NOTICES)) ? readFileSync(join(root, RUST_NOTICES), "utf8") : "";
      const lock = readFileSync(join(root, RUST_DIR, "Cargo.lock"), "utf8");
      findings.push(...checkRustInventory(lock, crates.map((c) => ({ ...c, texts: [...(c.files ?? []), ...(c.fallback ? [c.fallback] : [])] }))).findings);
      const r = checkComponents(crates.map((c) => ({ ...c, scope: "required" })), policy, { mplNoticed: noticedCrates(rustText) });
      findings.push(...r.findings);
      parts.push(`${r.judged} crates`);
    }
  }
  if (!skip.includes("workspace")) {
    let n = 0;
    for (const base of WORKSPACE_GLOBS) {
      const dirs = base === "" ? [root] : existsSync(join(root, base)) ? readdirSync(join(root, base)).map((d) => join(root, base, d)) : [];
      for (const d of dirs) {
        const p = join(d, "package.json");
        if (!existsSync(p)) continue;
        const j = JSON.parse(readFileSync(p, "utf8"));
        if (!j.private) continue;
        n++;
        if (j.license !== policy.firstParty.licence) findings.push(`${relative(root, p).split(sep).join("/")}: private workspace package without "license": "${policy.firstParty.licence}"`);
      }
    }
    parts.push(`${n} workspace packages UNLICENSED`);
  }
  if (!skip.includes("archive")) {
    const r = checkArchiveNotTracked(trackedFiles(root), { root });
    findings.push(...r.findings);
    parts.push("no archive CSV tracked");
  }
  return { ok: findings.length === 0, findings, summary: parts.join(", ") };
}
