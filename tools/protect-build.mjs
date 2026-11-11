#!/usr/bin/env node
/**
 * protect-build.mjs — v2.6 WP8 protected build (ADR-0014), run on the static export after `next build`.
 *
 *   node tools/protect-build.mjs --out apps/confluence/web/out [--minified-copy <dir>] [--manifest <path>]
 *                                [--targets tools/protect-targets.json] [--master-source <zip>] [--quiet]
 *
 * (a) copies the un-obfuscated out/ to --minified-copy (the audit artefact "dist-minified");
 * (b) selects the app's own chunks by content (tools/protect-targets.json — Turbopack names are hashes);
 * (c) obfuscates only those with javascript-obfuscator (conservative options, no eval-based transforms);
 * (d) deletes every *.map and the worker TypeScript copies, strips sourceMappingURL / sourceURL comments;
 * (e) writes build-manifest.json (default: next to out/, never inside it).
 * Vendor and framework chunks are not touched (byte-identical, release check R17).
 *
 * Exit 1 when a target fails to obfuscate or compile, when the obfuscator adds eval( / Function( to a file,
 * when a required marker ends up in no protected chunk, or when out/ already looks protected.
 * No network access. Writes nothing to out/ until every target has been obfuscated and compiled.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import {
  DEFAULT_TARGETS, countDynamicCode, listFiles, loadTargets, selectTargets, sha256, stripMapComments, treeHash,
} from "./checks/protected-build.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

/** Version and build from apps/confluence/web/src/lib/build-info.ts (the stamp the app shows). */
export function readBuildInfo(path = join(ROOT, "apps/confluence/web/src/lib/build-info.ts")) {
  const src = existsSync(path) ? readFileSync(path, "utf8") : "";
  return {
    version: /version:\s*"([^"]+)"/.exec(src)?.[1] ?? null,
    build: Number(/build:\s*(\d+)/.exec(src)?.[1]) || null,
  };
}

function gitCommit() {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    let clean = null;
    try { clean = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() === ""; } catch { /* unknown */ }
    if (/^[0-9a-f]{40}$/.test(sha)) return { commit: sha, source: "git", worktreeClean: clean };
  } catch { /* not a checkout */ }
  if (process.env.GITHUB_SHA) return { commit: process.env.GITHUB_SHA, source: "GITHUB_SHA", worktreeClean: null };
  return { commit: null, source: null, worktreeClean: null };
}

/** Per-file options: reproducible seed from content, unique top-level prefix per path (chunks share one global). */
export function optionsFor(rel, beforeSha, base) {
  const pathSha = sha256(rel);
  return { ...base, seed: parseInt(beforeSha.slice(0, 8), 16), identifiersPrefix: `_r${pathSha.slice(0, 6)}_` };
}

export function protectBuild({ outDir, minifiedCopy, manifestPath, targetsPath = DEFAULT_TARGETS, masterSource, log = console.log }) {
  if (!outDir || !existsSync(join(outDir, "index.html"))) throw new Error(`no static export at ${outDir} (index.html missing)`);
  const out = resolve(outDir);
  const manifest = resolve(manifestPath ?? join(out, "..", "build-manifest.json"));
  if (manifest.startsWith(out + "/") || manifest.startsWith(out + "\\")) throw new Error("the manifest must not be written inside out/ (it would ship)");
  const t = loadTargets(targetsPath);
  const JavaScriptObfuscator = require("javascript-obfuscator");
  const obfVersion = JSON.parse(readFileSync(require.resolve("javascript-obfuscator/package.json"), "utf8")).version;

  // Refuse a tree that was already protected: its "minified copy" would not be the minified build.
  for (const rel of listFiles(out).filter((f) => t.scope.test(f))) {
    const hits = (readFileSync(join(out, rel), "utf8").match(t.signature.re) ?? []).length;
    if (hits >= t.signature.min) throw new Error(`${rel} is already obfuscated — rebuild out/ before protecting`);
  }

  const startedAt = new Date().toISOString();
  const minifiedTree = treeHash(out);

  // (a) audit copy of the minified, un-obfuscated build.
  if (minifiedCopy) {
    const dst = resolve(minifiedCopy);
    if (dst === out || dst.startsWith(out + "/") || out.startsWith(dst + "/")) throw new Error("--minified-copy must be outside out/");
    rmSync(dst, { recursive: true, force: true });
    cpSync(out, dst, { recursive: true });
    log(`minified copy → ${dst}`);
  }

  // (b) select targets.
  const { targets, others } = selectTargets(out, t);
  for (const x of targets) log(`target  ${x.path}  (${x.include.join(", ")})`);
  const excludedWithOwn = others.filter((x) => x.include.length && x.exclude.length);
  for (const x of excludedWithOwn) log(`vendor  ${x.path}  (own marker ${x.include.join(", ")} but excluded by ${x.exclude.join(", ")})`);
  if (targets.length === 0) throw new Error("no own chunks selected — check tools/protect-targets.json against this build");
  const missingRequired = t.required.filter((m) => !targets.some((x) => readFileSync(join(out, x.path), "utf8").includes(m)));
  if (missingRequired.length) throw new Error(`required markers in no protected chunk: ${missingRequired.join(", ")}`);
  const prefixes = new Set();

  // (c) obfuscate in memory; fail before writing anything.
  const results = [];
  const base = { ...t.options };
  for (const x of targets) {
    const abs = join(out, x.path);
    const before = readFileSync(abs, "utf8");
    const beforeSha = sha256(before);
    const opts = optionsFor(x.path, beforeSha, base);
    if (prefixes.has(opts.identifiersPrefix)) throw new Error(`identifier prefix collision for ${x.path}`);
    prefixes.add(opts.identifiersPrefix);
    let code;
    const t0 = Date.now();
    try { code = JavaScriptObfuscator.obfuscate(before, opts).getObfuscatedCode(); } catch (e) { throw new Error(`obfuscation failed for ${x.path}: ${e.message}`); }
    try { new vm.Script(code, { filename: x.path }); } catch (e) { throw new Error(`obfuscated ${x.path} does not compile: ${e.message}`); }
    const dynBefore = countDynamicCode(before);
    const dynAfter = countDynamicCode(code);
    if (dynAfter.eval > dynBefore.eval || dynAfter.Function > dynBefore.Function) {
      throw new Error(`obfuscator introduced dynamic code in ${x.path}: eval ${dynBefore.eval}→${dynAfter.eval}, Function( ${dynBefore.Function}→${dynAfter.Function}`);
    }
    code = stripMapComments(code).text;
    results.push({ x, abs, before, code, beforeSha, ms: Date.now() - t0, prefix: opts.identifiersPrefix, seed: opts.seed });
  }
  for (const r of results) writeFileSync(r.abs, r.code);

  // (d) remove maps and worker sources, strip map comments everywhere.
  const removed = [];
  for (const rel of listFiles(out)) {
    const rule = t.remove.find((r) => r.re.test(rel));
    if (rule) { unlinkSync(join(out, rel)); removed.push({ path: rel, reason: rule.reason }); }
  }
  const stripped = [];
  for (const rel of listFiles(out)) {
    if (!t.strip.some((re) => re.test(rel))) continue;
    const abs = join(out, rel);
    const s = stripMapComments(readFileSync(abs, "utf8"));
    if (s.removed) { writeFileSync(abs, s.text); stripped.push({ path: rel, removed: s.removed }); }
  }
  const leftover = listFiles(out).filter((f) => f.endsWith(".map"));
  if (leftover.length) throw new Error(`source maps left: ${leftover.join(", ")}`);

  // (e) manifest.
  const protectedTree = treeHash(out);
  // Every shipped script/style that was not obfuscated (chunks, build-id manifests, sw.js, CSS).
  const why = new Map(others.map((x) => [x.path, x.exclude]));
  const vendor = listFiles(out).filter((f) => /\.(m?js|css)$/.test(f) && !results.some((r) => r.x.path === f)).map((f) => {
    const buf = readFileSync(join(out, f));
    const ex = why.get(f) ?? [];
    return { path: f, sha256: sha256(buf), bytes: buf.length, ...(ex.length ? { excludedBy: ex } : {}) };
  });
  const chunkVendor = vendor.filter((v) => t.scope.test(v.path));
  const sum = (a) => a.reduce((n, v) => n + v, 0);
  const jsBytesMinified = sum(results.map((r) => Buffer.byteLength(r.before))) + sum(chunkVendor.filter((v) => v.path.endsWith(".js")).map((v) => v.bytes));
  const jsBytesProtected = sum(results.map((r) => Buffer.byteLength(r.code))) + sum(chunkVendor.filter((v) => v.path.endsWith(".js")).map((v) => v.bytes));
  const info = readBuildInfo();
  const git = gitCommit();
  const m = {
    schema: 1,
    app: "rsL Confluence Terminal",
    version: info.version,
    build: info.build,
    commit: git.commit,
    commitSource: git.source,
    worktreeClean: git.worktreeClean,
    target: existsSync(join(out, ".rsl-target")) ? readFileSync(join(out, ".rsl-target"), "utf8").trim() : null,
    startedAt,
    writtenAt: new Date().toISOString(),
    masterSource: masterSource && existsSync(masterSource)
      ? { file: masterSource.split(/[\\/]/).pop(), sha256: sha256(readFileSync(masterSource)) }
      : null,
    obfuscator: { package: "javascript-obfuscator", version: obfVersion, options: base, perFile: t.raw.obfuscator.perFile },
    targetsFile: { path: "tools/protect-targets.json", sha256: sha256(readFileSync(t.path)) },
    trees: {
      method: "sha256 over sorted lines '<sha256>  <path>\\n' of every file (.rsl-target left out)",
      minified: { ...minifiedTree, dir: minifiedCopy ? "dist-minified" : null },
      protected: protectedTree,
    },
    sizes: {
      protectedBytesMinified: sum(results.map((r) => Buffer.byteLength(r.before))),
      protectedBytesObfuscated: sum(results.map((r) => Buffer.byteLength(r.code))),
      chunkJsBytesMinified: jsBytesMinified,
      chunkJsBytesProtected: jsBytesProtected,
      chunkJsGrowthPct: Number(((jsBytesProtected / jsBytesMinified - 1) * 100).toFixed(2)),
    },
    protected: results.map((r) => ({
      path: r.x.path,
      markers: r.x.include,
      sha256Before: r.beforeSha,
      sha256After: sha256(readFileSync(r.abs)),
      bytesBefore: Buffer.byteLength(r.before),
      bytesAfter: readFileSync(r.abs).length,
      identifiersPrefix: r.prefix,
      seed: r.seed,
      ms: r.ms,
    })),
    removed,
    strippedComments: stripped,
    vendor,
  };
  writeFileSync(manifest, JSON.stringify(m, null, 2) + "\n");
  log(`protected ${results.length} chunks (${m.sizes.protectedBytesMinified} → ${m.sizes.protectedBytesObfuscated} bytes), ` +
    `${m.vendor.length} untouched, removed ${removed.length}, stripped comments in ${stripped.length}; ` +
    `chunk JS ${m.sizes.chunkJsGrowthPct >= 0 ? "+" : ""}${m.sizes.chunkJsGrowthPct} %`);
  log(`manifest → ${manifest}  (protected tree ${protectedTree.sha256.slice(0, 16)}…, commit ${git.commit ? git.commit.slice(0, 12) : "unknown"})`);
  return { manifest: m, manifestPath: manifest };
}

/* ---------- CLI ---------- */
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined; };
  if (!opt("out")) {
    console.error("usage: node tools/protect-build.mjs --out <out/> [--minified-copy <dir>] [--manifest <path>] [--targets <json>] [--master-source <zip>] [--quiet]");
    process.exit(2);
  }
  try {
    protectBuild({
      outDir: resolve(opt("out")),
      minifiedCopy: opt("minified-copy") && resolve(opt("minified-copy")),
      manifestPath: opt("manifest") && resolve(opt("manifest")),
      targetsPath: opt("targets") ? resolve(opt("targets")) : DEFAULT_TARGETS,
      masterSource: opt("master-source") && resolve(opt("master-source")),
      log: args.includes("--quiet") ? () => {} : (s) => console.log(`[protect] ${s}`),
    });
  } catch (e) {
    console.error(`[protect] FAILED: ${e.message}`);
    process.exit(1);
  }
}
