#!/usr/bin/env node
// check-acceptance-ids.mjs — release check R14 (v2.5).
// Every acceptance check ID recorded in tools/acceptance-ids.json must still exist
// in tools/e2e/acceptance.cjs, unless its removal cites an existing ADR. This stops a
// snapshot upload from silently deleting checks (see docs/reviews/2026-11-07-v2.4-session-diagnosis.md).
//
//   node tools/check-acceptance-ids.mjs                 # against tools/acceptance-ids.json (working tree)
//   node tools/check-acceptance-ids.mjs --base <ref>    # also against the suite + baseline at <ref> (CI: PR base / previous main)
//
// With --base, a snapshot that overwrites BOTH acceptance.cjs and acceptance-ids.json with older
// copies still fails, because the IDs present at <ref> are read from git, not from the working tree.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Remove comments that start a line (commented-out checks), markers having been read first.
 * Only line-leading comments are stripped: `//` and `/*` also occur inside the suite's strings and regexes.
 */
function stripComments(src) {
  return src.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "").replace(/^[ \t]*\/\/[^\n]*/gm, "");
}

/** Sorted unique IDs passed to record(...); template literals become "<prefix>*"; marker comments add declared IDs. */
export function listAcceptanceIds(source) {
  const ids = new Set();
  // Dynamic record(id, …) calls declare their IDs in a marker comment: /* acceptance-ids: M-20, M-21 */
  for (const m of source.matchAll(/acceptance-ids:\s*([A-Za-z0-9.,\s-]+?)\s*\*\//g)) for (const id of m[1].split(",")) if (id.trim()) ids.add(id.trim());
  const code = stripComments(source);
  for (const m of code.matchAll(/record\(\s*(["'])([^"']+)\1/g)) ids.add(m[2]);
  for (const m of code.matchAll(/record\(\s*`([^`$]*)\$\{/g)) ids.add(`${m[1]}*`);
  return [...ids].sort();
}

const ADR = /^docs\/adr\/\d{4}-.+\.md$/;
const allowedRemovals = (removals, exists) =>
  new Set((removals ?? []).filter((r) => typeof r.adr === "string" && ADR.test(r.adr) && exists(r.adr)).map((r) => r.id));

/** Baseline IDs must be present unless removed with a reference to an existing ADR file. */
export function checkIds(current, baseline, exists = () => true) {
  const have = new Set(current);
  const allowed = allowedRemovals(baseline.removals, exists);
  const missing = baseline.ids.filter((id) => !have.has(id) && !allowed.has(id));
  return { ok: missing.length === 0, missing };
}

/** Every ID present on the base ref (its suite and its baseline) must still exist, unless removed with an ADR. */
export function checkAgainstBase(current, baseIds, removals, exists = () => true) {
  const have = new Set(current);
  const allowed = allowedRemovals(removals, exists);
  const missing = [...new Set(baseIds)].filter((id) => !have.has(id) && !allowed.has(id)).sort();
  return { ok: missing.length === 0, missing };
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const root = resolve(new URL("..", import.meta.url).pathname);
  const exists = (p) => existsSync(resolve(root, p));
  const current = listAcceptanceIds(readFileSync(resolve(root, "tools/e2e/acceptance.cjs"), "utf8"));
  const baseline = JSON.parse(readFileSync(resolve(root, "tools/acceptance-ids.json"), "utf8"));
  const r = checkIds(current, baseline, exists);
  if (!r.ok) { console.error(`R14: acceptance checks missing without an ADR: ${r.missing.join(", ")}`); process.exit(1); }
  const i = process.argv.indexOf("--base");
  const ref = i > 0 ? process.argv[i + 1] : null;
  if (ref && !/^0+$/.test(ref)) {
    const show = (path) => { try { return execFileSync("git", ["show", `${ref}:${path}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };
    const baseSuite = show("tools/e2e/acceptance.cjs");
    if (baseSuite === null) console.log(`R14: base ${ref} not available or has no acceptance suite — base comparison skipped.`);
    else {
      const baseBaseline = show("tools/acceptance-ids.json");
      const baseIds = [...listAcceptanceIds(baseSuite), ...(baseBaseline ? JSON.parse(baseBaseline).ids : [])];
      const b = checkAgainstBase(current, baseIds, baseline.removals, exists);
      if (!b.ok) { console.error(`R14: acceptance checks present at ${ref} are missing without an ADR: ${b.missing.join(", ")}`); process.exit(1); }
      console.log(`R14: all ${new Set(baseIds).size} acceptance IDs present at ${ref} are kept.`);
    }
  }
  console.log(`R14: ${baseline.ids.length} baseline acceptance IDs present.`);
}
