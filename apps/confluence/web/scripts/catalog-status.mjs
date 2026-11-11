/**
 * catalog-status.mjs — v2.5 translation status rules (WP4).
 *
 *   APPROVED         en (source) and ar (tier 1)
 *   CERTIFIED        tier 2, approved by a named native-speaker reviewer in a GitHub PR;
 *                    needs @reviewer, @reviewerGithub (login), @certifiedAt (YYYY-MM-DD) and
 *                    @certifiedHash = catalogHash(catalog). CI (tools/check-certification-pr.mjs) requires
 *                    an approval from @reviewerGithub on the PR's head commit.
 *                    Any later edit breaks the hash → the catalog must go back to MACHINE-CHECKED.
 *   MACHINE-CHECKED  tier 2, passes every automated check (keys, ICU, plurals, brand tokens,
 *                    safety lock, text fit — acceptance L-1). Not a human review.
 *   DRAFT            tier 2, not yet machine-checked.
 *
 *   node scripts/catalog-status.mjs hash <lang>   # print @certifiedHash for a reviewer's PR
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/** Safety statements whose meaning must never drift (docs/translation-review.md). */
export const SAFETY_KEYS = ["paper.banner", "status.disclaimer"];
const TIER2 = new Set(["CERTIFIED", "MACHINE-CHECKED", "DRAFT"]);
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** sha256 over the catalog's message keys (sorted), metadata (@…) excluded. */
export function catalogHash(catalog) {
  const entries = Object.keys(catalog).filter((k) => !k.startsWith("@")).sort().map((k) => [k, catalog[k]]);
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function statusErrors(code, cat, tier) {
  const s = cat["@status"];
  if (code === "en" || tier === 1) return s === "APPROVED" || (code === "en" && s === undefined) ? [] : [`${code}: tier-1 catalog must be "@status":"APPROVED"`];
  if (!TIER2.has(s)) return [`${code}: unknown @status "${s}" (CERTIFIED | MACHINE-CHECKED | DRAFT)`];
  if (s !== "CERTIFIED") return cat["@reviewer"] || cat["@reviewerGithub"] ? [`${code}: @reviewer/@reviewerGithub are only set on CERTIFIED catalogs`] : [];
  const errs = [];
  if (typeof cat["@reviewer"] !== "string" || !cat["@reviewer"].trim()) errs.push(`${code}: CERTIFIED needs a named @reviewer`);
  if (!GITHUB_LOGIN.test(cat["@reviewerGithub"] ?? "")) errs.push(`${code}: CERTIFIED needs @reviewerGithub (the reviewer's GitHub login; CI requires that login's approval)`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cat["@certifiedAt"] ?? "")) errs.push(`${code}: CERTIFIED needs @certifiedAt (YYYY-MM-DD)`);
  if (cat["@certifiedHash"] !== catalogHash(cat)) errs.push(`${code}: catalog changed since certification — set @status back to MACHINE-CHECKED or re-certify`);
  return errs;
}

/** Safety strings must match the lock (tools/i18n-safety-lock.json); renewing it is a reviewed change. */
export function safetyErrors(code, cat, lock) {
  const want = lock?.[code];
  if (!want) return [`${code}: no safety lock entry`];
  return SAFETY_KEYS.filter((k) => want[k] !== catalogHash({ [k]: cat[k] })).map((k) => `${code}: safety string ${k} changed — needs reviewer approval and a renewed lock (node apps/confluence/web/scripts/catalog-status.mjs lock)`);
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const [cmd, lang] = process.argv.slice(2);
  const dir = new URL("../src/rsl/i18n/", import.meta.url);
  const load = (c) => JSON.parse(readFileSync(new URL(`${c}.json`, dir), "utf8"));
  if (cmd === "hash" && lang) console.log(catalogHash(load(lang)));
  else if (cmd === "lock") {
    const { readdirSync, writeFileSync } = await import("node:fs");
    const codes = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")).sort();
    const lock = { "@note": "Hashes of the safety statements per language (SAFETY_KEYS). Renew only in a reviewed PR." };
    for (const c of codes) { const cat = load(c); lock[c] = Object.fromEntries(SAFETY_KEYS.map((k) => [k, catalogHash({ [k]: cat[k] })])); }
    writeFileSync(new URL("../../../../tools/i18n-safety-lock.json", import.meta.url), JSON.stringify(lock, null, 2) + "\n");
    console.log(`safety lock written for ${codes.length} languages`);
  } else { console.error("usage: catalog-status.mjs hash <lang> | lock"); process.exit(2); }
}
