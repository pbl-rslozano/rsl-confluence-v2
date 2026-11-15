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
 *   @pendingReview   (final review I-1, tier 1 only) keys whose text is a machine draft awaiting a native-speaker
 *                    review. The catalog stays APPROVED for its reviewed strings; About says how many are pending;
 *                    release check R25 (--release) blocks a release until the list is empty. Clear a key only after
 *                    the native reviewer has passed its text.
 *   No tier-1 string may equal English (untranslatedErrors) unless its key is in TIER1_SAME_AS_EN.
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
/** Tier-1 keys whose text is legitimately the same as English: tickers, metric abbreviations, technical tokens. */
export const TIER1_SAME_AS_EN = ["ledger.bars", "ledger.psr", "update.fingerprint"];
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** sha256 over the catalog's message keys (sorted), metadata (@…) excluded. */
export function catalogHash(catalog) {
  const entries = Object.keys(catalog).filter((k) => !k.startsWith("@")).sort().map((k) => [k, catalog[k]]);
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/** Shape of @pendingReview: an array of distinct message keys present in the catalog. */
function pendingShapeErrors(code, cat) {
  const list = cat["@pendingReview"];
  if (list === undefined) return [];
  if (!Array.isArray(list)) return [`${code}: @pendingReview must be an array of message keys`];
  const bad = list.filter((k, i) => typeof k !== "string" || k.startsWith("@") || !(k in cat) || list.indexOf(k) !== i);
  return bad.length ? [`${code}: @pendingReview lists unknown, metadata or repeated keys: ${bad.slice(0, 5).join(", ")}`] : [];
}

export function statusErrors(code, cat, tier) {
  const s = cat["@status"];
  if (code === "en" || tier === 1) {
    if (!(s === "APPROVED" || (code === "en" && s === undefined))) return [`${code}: tier-1 catalog must be "@status":"APPROVED"`];
    return pendingShapeErrors(code, cat);
  }
  if (cat["@pendingReview"] !== undefined) return [`${code}: @pendingReview is only used on tier-1 catalogs`];
  if (!TIER2.has(s)) return [`${code}: unknown @status "${s}" (CERTIFIED | MACHINE-CHECKED | DRAFT)`];
  if (s !== "CERTIFIED") return cat["@reviewer"] || cat["@reviewerGithub"] ? [`${code}: @reviewer/@reviewerGithub are only set on CERTIFIED catalogs`] : [];
  const errs = [];
  if (typeof cat["@reviewer"] !== "string" || !cat["@reviewer"].trim()) errs.push(`${code}: CERTIFIED needs a named @reviewer`);
  if (!GITHUB_LOGIN.test(cat["@reviewerGithub"] ?? "")) errs.push(`${code}: CERTIFIED needs @reviewerGithub (the reviewer's GitHub login; CI requires that login's approval)`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cat["@certifiedAt"] ?? "")) errs.push(`${code}: CERTIFIED needs @certifiedAt (YYYY-MM-DD)`);
  if (cat["@certifiedHash"] !== catalogHash(cat)) errs.push(`${code}: catalog changed since certification — set @status back to MACHINE-CHECKED or re-certify`);
  return errs;
}

/** Tier-1 strings left identical to English (outside TIER1_SAME_AS_EN): an approved catalog must not show English. */
export function untranslatedErrors(code, cat, en, tier) {
  if (code === "en" || tier !== 1) return [];
  const same = Object.keys(en).filter((k) => !k.startsWith("@") && typeof en[k] === "string" && en[k].trim() !== "" && cat[k] === en[k] && !TIER1_SAME_AS_EN.includes(k));
  return same.length ? [`${code}: ${same.length} tier-1 strings are still English (draft them and flag @pendingReview): ${same.slice(0, 8).join(", ")}${same.length > 8 ? " …" : ""}`] : [];
}

/** Release gate (R25 --release): a tier-1 catalog with strings still pending native-speaker review. */
export function pendingReviewErrors(code, cat) {
  const n = Array.isArray(cat["@pendingReview"]) ? cat["@pendingReview"].length : 0;
  return n ? [`${code}: ${n} strings pending native-speaker review (@pendingReview) — a release needs the review first`] : [];
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
