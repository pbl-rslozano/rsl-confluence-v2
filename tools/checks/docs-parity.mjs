#!/usr/bin/env node
/**
 * docs-parity.mjs — release check R19 (v2.6, owner rule of 7 Nov 2026):
 * every change appears in the architecture plan AND in the user guide.
 *
 *   1. The user guide's title is "rsL Confluence Terminal v<major.minor> <year>" and its
 *      footer carries "v<major.minor> <year> · build <build>", both matching BUILD_INFO
 *      (apps/confluence/web/src/lib/build-info.ts).
 *   2. The architecture plan for this major.minor exists
 *      (docs/superpowers/specs/*-v<major.minor>-architecture-design.md) and declares its
 *      user-visible work packages on a line "<!-- user-visible: WP7 WP8 … -->".
 *   3. docs/user-guide/en.md has an anchor "<!-- wp:WPn -->" for each of them.
 *   4. The newest CHANGELOG entry is for this version and names at least one plan WP.
 *
 * The Arabic guide (docs/user-guide/ar.md) is APPROVED text: a stale Arabic guide is
 * reported as a note for the reviewer, never a failure.
 *
 *   node tools/checks/docs-parity.mjs     exit 0 = ok
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function checkDocsParity(root = ROOT) {
  const findings = [];
  const notes = [];
  const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : "");
  const info = read("apps/confluence/web/src/lib/build-info.ts");
  const version = /version:\s*"([^"]+)"/.exec(info)?.[1];
  const build = /build:\s*"?(\d{8})"?/.exec(info)?.[1];
  if (!version || !build) return { ok: false, findings: ["build-info.ts: version/build not found"], notes };
  const mm = version.split(".").slice(0, 2).join(".");
  const year = build.slice(0, 4);

  const guide = read("docs/user-guide/en.md");
  const title = guide.split("\n").find((l) => l.startsWith("# ")) ?? "";
  if (!title.includes(`rsL Confluence Terminal v${mm} ${year}`)) findings.push(`user guide title "${title}" ≠ "rsL Confluence Terminal v${mm} ${year}"`);
  if (!guide.includes(`v${mm} ${year} · build ${build}`)) findings.push(`user guide footer lacks "v${mm} ${year} · build ${build}"`);

  const specs = existsSync(join(root, "docs/superpowers/specs")) ? readdirSync(join(root, "docs/superpowers/specs")) : [];
  const planFile = specs.filter((f) => f.endsWith(`-v${mm}-architecture-design.md`)).sort().pop();
  if (!planFile) findings.push(`no architecture plan for v${mm} in docs/superpowers/specs`);
  else {
    const plan = read(`docs/superpowers/specs/${planFile}`);
    const decl = /<!--\s*user-visible:\s*([^>]*?)\s*-->/.exec(plan)?.[1];
    if (!decl) findings.push(`${planFile}: no "<!-- user-visible: … -->" line`);
    else {
      for (const wp of decl.split(/\s+/).filter(Boolean)) {
        if (!new RegExp(`<!--\\s*wp:${wp}\\s*-->`).test(guide)) findings.push(`user guide has no <!-- wp:${wp} --> section for the plan's ${wp}`);
        if (!new RegExp(`###\\s+${wp}\\b`).test(plan)) findings.push(`${planFile}: declares ${wp} but has no "### ${wp}" section`);
      }
    }
  }

  const changelog = read("CHANGELOG.md");
  const top = changelog.split(/\n(?=# )/).find((b) => b.startsWith("# ")) ?? "";
  if (!top.startsWith(`# v${version}`)) findings.push(`CHANGELOG top entry is not v${version}`);
  else if (!/\bWP\d+\b/.test(top)) findings.push(`CHANGELOG v${version} names no plan work package`);

  const ar = read("docs/user-guide/ar.md");
  if (ar && !ar.includes(`v${mm}`)) notes.push(`Arabic guide not yet updated to v${mm} (reviewer)`);
  return { ok: findings.length === 0, findings, notes, summary: `v${version} build ${build} · ${planFile ?? "no plan"}` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const r = checkDocsParity();
  console.log(r.ok ? `R19 ok — ${r.summary}${r.notes.length ? " · note: " + r.notes.join("; ") : ""}` : `R19 FAIL\n  ${r.findings.join("\n  ")}`);
  process.exit(r.ok ? 0 : 1);
}
