#!/usr/bin/env node
/**
 * protected-build.mjs — release checks R17 (protected build) and R18 (protected equivalence), v2.6 WP8 / ADR-0014.
 *
 *   node tools/checks/protected-build.mjs [check] --out <out/> --manifest <build-manifest.json> [--minified <dist-minified/>] [--require-master]
 *   node tools/checks/protected-build.mjs equivalence --evidence <evidence.json> --manifest <build-manifest.json>
 *   node tools/checks/protected-build.mjs evidence --out <out/> --manifest <m.json> --acceptance <results.json> [--golden <golden.json>] [--write <evidence.json>]
 *
 * Exit 0 = ok, 1 = findings, 2 = usage. The selection helpers here are also used by tools/protect-build.mjs, so the
 * pipeline and the check apply the same rules from tools/protect-targets.json.
 *
 * Release-check hook (wired by the coordinator in tools/release-check.mjs):
 *   const { checkProtectedBuild, checkProtectedEquivalence } = await import("./checks/protected-build.mjs");
 *   const r17 = checkProtectedBuild({ outDir, manifestPath, minifiedDir });
 *   check("R17", "Protected build: no maps, only listed own chunks obfuscated, vendor unchanged, manifest complete", r17.ok, r17.findings.join("; "));
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_TARGETS = join(ROOT, "tools", "protect-targets.json");
/** Files that never ship (package-pwa and publish-update leave it out), so tree hashes ignore it. */
const TREE_IGNORE = new Set([".rsl-target"]);

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
/** BG-5 (plan WP8): protected bundle size cap over the minified build. */
export const MAX_JS_GROWTH_PCT = 15;

export function loadTargets(path = DEFAULT_TARGETS) {
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  return {
    raw: cfg,
    path,
    scope: new RegExp(cfg.scope.pattern),
    include: cfg.includeMarkers.map((m) => m.marker),
    exclude: cfg.excludeMarkers.map((m) => m.marker),
    required: cfg.requiredMarkers ?? [],
    remove: (cfg.removeFiles ?? []).map((r) => ({ re: new RegExp(r.pattern), reason: r.reason })),
    strip: (cfg.stripCommentsIn ?? []).map((p) => new RegExp(p)),
    signature: { re: new RegExp(cfg.obfuscatedSignature.pattern, "g"), min: cfg.obfuscatedSignature.minCount },
    options: cfg.obfuscator.options,
  };
}

/** All files under dir, as sorted posix paths relative to dir. */
export function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** Canonical tree hash: SHA-256 over "sha256  path\n" lines, sorted by path (.rsl-target left out). */
export function treeHash(dir) {
  const files = listFiles(dir).filter((f) => !TREE_IGNORE.has(f));
  const lines = files.map((f) => `${sha256(readFileSync(join(dir, f)))}  ${f}\n`).join("");
  return { sha256: sha256(lines), files: files.length };
}

/** Why a file is (not) a target: { target, include[], exclude[] }. */
export function classify(rel, text, t) {
  if (!t.scope.test(rel)) return { target: false, include: [], exclude: [], inScope: false };
  const include = t.include.filter((m) => text.includes(m));
  const exclude = t.exclude.filter((m) => text.includes(m));
  return { target: include.length > 0 && exclude.length === 0, include, exclude, inScope: true };
}

/** Apply the protect-targets rules to a (minified) tree. */
export function selectTargets(dir, t) {
  const targets = [];
  const others = [];
  for (const rel of listFiles(dir)) {
    if (!t.scope.test(rel)) continue;
    const c = classify(rel, readFileSync(join(dir, rel), "utf8"), t);
    (c.target ? targets : others).push({ path: rel, ...c });
  }
  return { targets, others };
}

// `//# sourceMappingURL=…`, `//@ sourceURL=…` and `/*# sourceMappingURL=… */` (also inside HTML <script>/<style>).
const MAP_COMMENT = /(?:\/\/[#@][ \t]*source(?:Mapping)?URL[ \t]*=[^\r\n]*|\/\*[#@][ \t]*source(?:Mapping)?URL[ \t]*=[\s\S]*?\*\/)/g;
export const hasMapComment = (text) => new RegExp(MAP_COMMENT.source).test(text);
export function stripMapComments(text) {
  let n = 0;
  const out = text.replace(MAP_COMMENT, () => { n++; return ""; });
  return { text: out, removed: n };
}

/** Dynamic-code sinks the CSP forbids (no 'unsafe-eval'). */
export function countDynamicCode(text) {
  return {
    eval: (text.match(/\beval\s*\(/g) ?? []).length,
    Function: (text.match(/\bFunction\s*\(/g) ?? []).length,
  };
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * R17. findings[] is empty when ok.
 * - no *.map file and no sourceMappingURL / sourceURL comment in out/
 * - every file the manifest lists as protected exists with its recorded hash; no other JS file looks obfuscated
 * - with minifiedDir: the protect-targets rules applied to the minified tree select exactly the manifest's set, and
 *   every other file is byte-identical to its minified counterpart (removed files excepted)
 * - the manifest names a commit and both tree hashes, and the protected tree hash matches out/
 */
export function checkProtectedBuild({ outDir, manifestPath, minifiedDir, targetsPath = DEFAULT_TARGETS, requireMaster = false }) {
  const findings = [];
  if (!outDir || !existsSync(outDir)) return { ok: false, findings: [`out/ not found: ${outDir}`] };
  if (!manifestPath || !existsSync(manifestPath)) return { ok: false, findings: [`build manifest not found: ${manifestPath}`] };
  const t = loadTargets(targetsPath);
  let m;
  try { m = JSON.parse(readFileSync(manifestPath, "utf8")); } catch (e) { return { ok: false, findings: [`build manifest unreadable: ${e.message}`] }; }

  const files = listFiles(outDir);
  const protectedSet = new Map((m.protected ?? []).map((p) => [p.path, p]));

  // 1. Source maps and map comments.
  for (const f of files) {
    if (f.endsWith(".map")) findings.push(`source map shipped: ${f}`);
    else if (t.strip.some((re) => re.test(f)) && hasMapComment(readFileSync(join(outDir, f), "utf8"))) findings.push(`map comment in ${f}`);
  }
  // Removed-by-rule files (worker TypeScript sources) must stay gone.
  for (const f of files) for (const r of t.remove) if (r.re.test(f) && !f.endsWith(".map")) findings.push(`file that must not ship: ${f} (${r.reason})`);

  // 2. Protected files listed and unchanged since the pipeline; nothing else obfuscated.
  if (protectedSet.size === 0) findings.push("manifest lists no protected files");
  for (const [p, rec] of protectedSet) {
    const abs = join(outDir, p);
    if (!existsSync(abs)) { findings.push(`protected file missing: ${p}`); continue; }
    if (sha256(readFileSync(abs)) !== rec.sha256After) findings.push(`protected file changed after protection: ${p}`);
  }
  for (const f of files) {
    if (!/\.m?js$/.test(f) || protectedSet.has(f)) continue;
    const hits = (readFileSync(join(outDir, f), "utf8").match(t.signature.re) ?? []).length;
    if (hits >= t.signature.min) findings.push(`obfuscated file outside protect-targets.json: ${f} (${hits} _0x names)`);
  }

  // 3. Against the kept minified build.
  if (minifiedDir) {
    if (!existsSync(minifiedDir)) findings.push(`minified build not found: ${minifiedDir}`);
    else {
      const sel = selectTargets(minifiedDir, t).targets.map((x) => x.path).sort();
      const listed = [...protectedSet.keys()].sort();
      const extra = listed.filter((p) => !sel.includes(p));
      const missing = sel.filter((p) => !listed.includes(p));
      if (extra.length) findings.push(`protected but not selected by protect-targets.json: ${extra.join(", ")}`);
      if (missing.length) findings.push(`selected by protect-targets.json but not protected: ${missing.join(", ")}`);
      const minFiles = listFiles(minifiedDir);
      const outSet = new Set(files);
      const removable = (f) => t.remove.some((r) => r.re.test(f));
      for (const f of minFiles) {
        if (TREE_IGNORE.has(f) || protectedSet.has(f) || removable(f)) continue;
        if (!outSet.has(f)) { findings.push(`file missing from protected build: ${f}`); continue; }
        const a = readFileSync(join(minifiedDir, f));
        const b = readFileSync(join(outDir, f));
        if (a.equals(b)) continue;
        // The only allowed change to a non-target file is removing map comments.
        const stripped = t.strip.some((re) => re.test(f)) ? stripMapComments(a.toString("utf8")).text : null;
        if (stripped === null || stripped !== b.toString("utf8")) findings.push(`vendor/untouched file differs from the minified build: ${f}`);
      }
      const minSet = new Set(minFiles);
      for (const f of files) if (!minSet.has(f) && !TREE_IGNORE.has(f)) findings.push(`file not in the minified build: ${f}`);
      if (m.trees?.minified?.sha256 && treeHash(minifiedDir).sha256 !== m.trees.minified.sha256) findings.push("minified tree hash ≠ manifest");
    }
  }

  // 4. Manifest completeness.
  if (!m.commit || typeof m.commit !== "string") findings.push("manifest lacks the source commit");
  if (!HEX64.test(m.trees?.minified?.sha256 ?? "")) findings.push("manifest lacks the minified tree hash");
  if (!HEX64.test(m.trees?.protected?.sha256 ?? "")) findings.push("manifest lacks the protected tree hash");
  else if (treeHash(outDir).sha256 !== m.trees.protected.sha256) findings.push("out/ tree hash ≠ manifest protected tree hash");
  if (requireMaster && !HEX64.test(m.masterSource?.sha256 ?? "")) findings.push("manifest lacks the master source SHA-256");

  // 5. BG-5 size: total chunk JS shipped may grow at most +15 % over the minified build (first-scan time is
  //    capped by tools/protect-golden.mjs). First-load growth is reported in the manifest, not capped.
  const growth = m.sizes?.chunkJsGrowthPct;
  if (typeof growth !== "number") findings.push("manifest lacks sizes.chunkJsGrowthPct");
  else if (growth > MAX_JS_GROWTH_PCT) findings.push(`protected chunk JS is +${growth} % over the minified build (BG-5 cap +${MAX_JS_GROWTH_PCT} %)`);

  return { ok: findings.length === 0, findings, protected: protectedSet.size, files: files.length, growthPct: growth };
}

/**
 * R18. The evidence written after the acceptance (BG-3) and engine golden (BG-4) runs must name this exact
 * protected tree hash and report pass for every required check.
 */
export function checkProtectedEquivalence({ evidencePath, manifestPath, require = ["BG-3", "BG-4"] }) {
  const findings = [];
  if (!evidencePath || !existsSync(evidencePath)) return { ok: false, findings: [`equivalence evidence not found: ${evidencePath}`] };
  if (!manifestPath || !existsSync(manifestPath)) return { ok: false, findings: [`build manifest not found: ${manifestPath}`] };
  let ev, m;
  try { ev = JSON.parse(readFileSync(evidencePath, "utf8")); } catch (e) { return { ok: false, findings: [`evidence unreadable: ${e.message}`] }; }
  try { m = JSON.parse(readFileSync(manifestPath, "utf8")); } catch (e) { return { ok: false, findings: [`build manifest unreadable: ${e.message}`] }; }
  const want = m.trees?.protected?.sha256;
  if (!HEX64.test(want ?? "")) findings.push("manifest lacks the protected tree hash");
  if (ev.protectedTreeSha256 !== want) findings.push(`evidence is for tree ${String(ev.protectedTreeSha256).slice(0, 12)}…, build is ${String(want).slice(0, 12)}…`);
  for (const id of require) {
    const c = ev.checks?.[id];
    if (!c) findings.push(`${id} evidence missing`);
    else if (c.pass !== true) findings.push(`${id} did not pass${c.detail ? ` (${c.detail})` : ""}`);
  }
  if (ev.pass !== true) findings.push("evidence does not say pass");
  return { ok: findings.length === 0, findings };
}

/** Build the R18 evidence object from an acceptance results.json (+ optional golden result) for the tree in outDir. */
export function buildEquivalenceEvidence({ outDir, manifestPath, acceptancePath, goldenPath }) {
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  const tree = treeHash(outDir).sha256;
  const checks = {};
  if (tree !== m.trees?.protected?.sha256) checks["BG-3"] = { pass: false, detail: "out/ is not the build named in the manifest" };
  else if (acceptancePath && existsSync(acceptancePath)) {
    const r = JSON.parse(readFileSync(acceptancePath, "utf8"));
    const failed = (r.results ?? []).filter((x) => !x.pass).map((x) => x.id);
    checks["BG-3"] = { pass: (r.results ?? []).length > 0 && failed.length === 0, total: (r.results ?? []).length, failed, at: r.at, base: r.base };
  } else checks["BG-3"] = { pass: false, detail: "no acceptance results" };
  if (goldenPath && existsSync(goldenPath)) {
    const g = JSON.parse(readFileSync(goldenPath, "utf8"));
    checks["BG-4"] = { pass: g.pass === true, detail: g.detail ?? undefined };
  } else checks["BG-4"] = { pass: false, detail: "no engine golden replay evidence" };
  return {
    schema: 1,
    protectedTreeSha256: tree,
    commit: m.commit,
    version: m.version,
    build: m.build,
    checks,
    pass: Object.values(checks).every((c) => c.pass === true),
    writtenAt: new Date().toISOString(),
  };
}

/* ---------- CLI ---------- */
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const mode = args[0] && !args[0].startsWith("--") ? args.shift() : "check";
  const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const abs = (p) => (p ? resolve(p) : p);
  const report = (id, r) => {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${id}${r.ok ? "" : ""}`);
    for (const f of r.findings) console.log(`  - ${f}`);
    process.exit(r.ok ? 0 : 1);
  };
  if (mode === "check") {
    if (!opt("out") || !opt("manifest")) { console.error("usage: protected-build.mjs check --out <dir> --manifest <file> [--minified <dir>] [--require-master]"); process.exit(2); }
    const r = checkProtectedBuild({ outDir: abs(opt("out")), manifestPath: abs(opt("manifest")), minifiedDir: abs(opt("minified")), targetsPath: abs(opt("targets")) ?? DEFAULT_TARGETS, requireMaster: args.includes("--require-master") });
    if (r.ok) console.log(`  ${r.protected} protected files, ${r.files} files in out/`);
    report("R17 protected build", r);
  } else if (mode === "equivalence") {
    if (!opt("evidence") || !opt("manifest")) { console.error("usage: protected-build.mjs equivalence --evidence <file> --manifest <file>"); process.exit(2); }
    report("R18 protected equivalence", checkProtectedEquivalence({ evidencePath: abs(opt("evidence")), manifestPath: abs(opt("manifest")) }));
  } else if (mode === "evidence") {
    if (!opt("out") || !opt("manifest")) { console.error("usage: protected-build.mjs evidence --out <dir> --manifest <file> --acceptance <results.json> [--golden <file>] [--write <file>]"); process.exit(2); }
    const ev = buildEquivalenceEvidence({ outDir: abs(opt("out")), manifestPath: abs(opt("manifest")), acceptancePath: abs(opt("acceptance")), goldenPath: abs(opt("golden")) });
    const json = JSON.stringify(ev, null, 2) + "\n";
    if (opt("write")) { const { writeFileSync } = await import("node:fs"); writeFileSync(abs(opt("write")), json); }
    process.stdout.write(json);
    process.exit(ev.pass ? 0 : 1);
  } else { console.error(`unknown mode ${mode}`); process.exit(2); }
}
