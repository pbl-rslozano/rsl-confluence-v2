/**
 * translation-review.mjs — release check R25 (final review I-1, v2.8).
 *
 * Tier-1 catalogs (ar) may carry machine drafts flagged "@pendingReview" (apps/confluence/web/scripts/catalog-status.mjs)
 * so a merge can ship honest drafts instead of English. A RELEASE must not: with { release: true } any non-empty list
 * fails. Without it (the merge gate) the count is reported and the check passes.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function checkTranslationReview(root, { release = false } = {}) {
  const dir = join(root, "apps/confluence/web/src/rsl/i18n");
  const pending = {};
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
      const cat = JSON.parse(readFileSync(join(dir, f), "utf8"));
      const n = Array.isArray(cat["@pendingReview"]) ? cat["@pendingReview"].length : 0;
      if (n) pending[f.replace(/\.json$/, "")] = n;
    }
  }
  const findings = Object.entries(pending).map(([code, n]) => `${code}: ${n} strings pending native-speaker review (@pendingReview) — a release needs the review first`);
  const summary = findings.length
    ? `${Object.entries(pending).map(([c, n]) => `${c} ${n} pending`).join(", ")}${release ? "" : " (allowed for a merge; --release fails)"}`
    : "no tier-1 strings pending review";
  return { ok: !release || findings.length === 0, findings, summary, pending };
}

// CLI: node tools/checks/translation-review.mjs [--release]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = checkTranslationReview(join(new URL(".", import.meta.url).pathname, "..", ".."), { release: process.argv.includes("--release") });
  console.log(r.ok ? `ok: ${r.summary}` : r.findings.join("\n"));
  process.exit(r.ok ? 0 : 1);
}
