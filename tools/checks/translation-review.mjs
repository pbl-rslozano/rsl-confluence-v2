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
    ? `${Object.entries(pending).map(([c, n]) => `${c} ${n} pending`).join(", ")}${release ? "" : " (allowed for a merge; --release needs the review, or an owner waiver for this version: ADR-0020)"}`
    : "no tier-1 strings pending review";
  return { ok: !release || findings.length === 0, findings, summary, pending };
}

/**
 * Owner waiver for one release (ADR-0020, owner decision 17 Nov 2026). Takes the result of checkTranslationReview for a
 * release run and, only while strings are still pending, reads tools/r25-waiver.json:
 *   { "version": "2.8.0", "adr": "docs/adr/0020-….md", "owner": "…", "date": "YYYY-MM-DD", "reason": "…" }
 * The release passes as WAIVED (with the pending count) only when the waiver names exactly this app version and its ADR
 * exists and records it (names that version and says "owner waiver"). Otherwise the result is the unwaived one, with the reason the waiver did not apply. The measurement itself is
 * unchanged; deleting the waiver file re-blocks the release.
 */
export const R25_WAIVER = "tools/r25-waiver.json";
export const R25_LABEL = "Tier-1 translations reviewed: no string pending native-speaker review";
export const R25_WAIVED_LABEL = "Tier-1 translations: release waived by owner (pending native-speaker review)";
export function applyR25Waiver(root, result, { version } = {}) {
  if (result.ok) return { ...result, waived: false, label: R25_LABEL };
  const fail = (why) => ({ ...result, ok: false, waived: false, label: R25_LABEL, findings: [...result.findings, why] });
  const path = join(root, R25_WAIVER);
  if (!existsSync(path)) return fail(`no owner waiver (${R25_WAIVER})`);
  let w;
  try { w = JSON.parse(readFileSync(path, "utf8")); } catch { return fail(`${R25_WAIVER} is not valid JSON`); }
  const missing = ["version", "adr", "owner", "date", "reason"].filter((k) => typeof w?.[k] !== "string" || !w[k].trim());
  if (missing.length) return fail(`${R25_WAIVER} lacks ${missing.join(", ")}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(w.date)) return fail(`${R25_WAIVER}: date "${w.date}" is not YYYY-MM-DD`);
  if (!version || w.version !== version) return fail(`owner waiver is for ${w.version}, not ${version ?? "(unknown version)"}`);
  if (!/^docs\/adr\/\d{4}-[^/]+\.md$/.test(w.adr) || !existsSync(join(root, w.adr))) return fail(`waiver ADR ${w.adr} not found`);
  // The ADR must be the record of THIS waiver: it names the waiver's version and says "owner waiver" (review M3).
  const adr = readFileSync(join(root, w.adr), "utf8");
  if (!new RegExp(`(?<![\\d.])${w.version.replaceAll(".", "\\.")}(?![\\d.])`).test(adr) || !/owner waiver/i.test(adr)) {
    return fail(`waiver ADR ${w.adr} does not record an owner waiver for ${w.version}`);
  }
  const pending = Object.entries(result.pending).map(([c, n]) => `${c} ${n} pending`).join(", ");
  return {
    ...result, ok: true, waived: true, label: R25_WAIVED_LABEL,
    summary: `WAIVED — ${pending} native-speaker review; owner waiver for ${w.version} (${w.adr}, ${w.owner}, ${w.date})`,
  };
}

// CLI: node tools/checks/translation-review.mjs [--release]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = checkTranslationReview(join(new URL(".", import.meta.url).pathname, "..", ".."), { release: process.argv.includes("--release") });
  console.log(r.ok ? `ok: ${r.summary}` : r.findings.join("\n"));
  process.exit(r.ok ? 0 : 1);
}
