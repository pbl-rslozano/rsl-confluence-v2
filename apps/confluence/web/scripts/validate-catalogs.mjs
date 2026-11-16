/**
 * validate-catalogs.mjs — every catalog must:
 *   1. have exactly the English key set,
 *   2. use the same ICU argument names as English for each key,
 *   3. render every key through the rsL Core Kit formatter without throwing or leaking raw keys,
 *   4. use only CLDR plural categories valid for its language,
 *   5. keep brand / technical tokens untranslated,
 *   6. carry a valid status (APPROVED / CERTIFIED / MACHINE-CHECKED / DRAFT — scripts/catalog-status.mjs),
 *   7. keep the safety statements identical to tools/i18n-safety-lock.json (v2.5),
 *   8. (tier 1) translate every string — none left identical to English outside TIER1_SAME_AS_EN; machine drafts are
 *      listed in @pendingReview (final review I-1; release check R25 blocks a release while any remain).
 * Usage: node scripts/validate-catalogs.mjs [lang ...]
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createI18n, LANGUAGES } from "../../../../packages/core/core/rsl-i18n.js";
import { statusErrors, safetyErrors, untranslatedErrors } from "./catalog-status.mjs";

const dir = fileURLToPath(new URL("../src/rsl/i18n/", import.meta.url));
const load = (c) => JSON.parse(readFileSync(join(dir, `${c}.json`), "utf8"));
const en = load("en");
const keys = Object.keys(en).filter((k) => !k.startsWith("@"));
/** ICU argument names, via a small recursive-descent walk (option bodies are text, not arguments). */
const argNames = (src) => {
  const names = new Set(); let i = 0;
  const ws = () => { while (/\s/.test(src[i] ?? "")) i++; };
  const word = () => { ws(); let w = ""; while (i < src.length && /[^\s,{}]/.test(src[i])) w += src[i++]; ws(); return w; };
  function text(inOption) {
    while (i < src.length) {
      const ch = src[i];
      if (ch === "'" && "{}#'".includes(src[i + 1] ?? "")) { const e = src.indexOf("'", i + 2); i = e < 0 ? src.length : e + 1; continue; }
      if (ch === "{") { arg(); continue; }
      if (ch === "}" && inOption) return;
      i++;
    }
  }
  function arg() {
    i++; names.add(word());
    if (src[i] === "}") { i++; return; }
    i++; const type = word();
    if (src[i] === "}") { i++; return; }
    i++;
    if (type === "number" || type === "date" || type === "time") { word(); i++; return; }
    for (;;) { ws(); if (src[i] === "}" || i >= src.length) { i++; return; } word(); i++; text(true); i++; }
  }
  text(false);
  return names;
};
const VARS = { version: "2.5.2", build: "20261108", size: "19.4 MB", event: "FOMC", hours: 5, id: "a1b2c3d4e5f60718", fee: 10, slip: 5, funding: 1, bars: 300, n: 3, count: 2, s: "1.2", time: "10:00", list: "BTC, ETH", customer: "Personal", theme: "light",
  kind: "sqlite", days: 5, k: 4, name: "Ronald", total: 3, language: "English", reason: "test", date: "2027-01-29", h: 6,
  source: "Coins.ph (PH)", floor: "$250k", sha: "0123456789ab…", // v2.6
  code: "SAR", rate: "3.75", authority: "SAMA", band: "7.75–7.85", native: "USD", price: "$0.9987", coin: "FDUSD", dev: "−1.50 %", ref: "USDT", fallback: "built-in official pegs", // v2.7
  rank: 2, m: 300, pct: 10, series: "binance|4h", move: "+0.42 %", sim: 81, remaining: 2, exchange: "Binance Spot",
  pctl: 99, chg: "+1.00 %", share: 60, asia: 30, europe: 30, us: 40, venue: "Coinbase", z: "3.4", usd: "$1.2B", label: "Live ETF flows", long: "1,000", short: "500", net: "+500", delta: "+50", rejected: 1, duplicates: 0, level: "Severe", reference: "USDT", min: 1, max: 6 }; // v2.8
const PROTECTED = ["BTC", "ETH", "SQLite", "IndexedDB", "localStorage", "JSON", "PNG", "JPEG", "SVG", "Bybit", "A–Z", "Coins.ph", "USDT", "SHA-256"]; // v2.6: +Coins.ph, USDT, SHA-256
const wanted = process.argv.slice(2);
const codes = wanted.length ? wanted : readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""));
const SAFETY_LOCK = JSON.parse(readFileSync(new URL("../../../../tools/i18n-safety-lock.json", import.meta.url), "utf8"));
let failures = 0;
for (const code of codes) {
  const cat = load(code);
  const errs = [];
  const lang = LANGUAGES.find((l) => l.code === code);
  if (!lang) errs.push("not one of the 18 rsL languages");
  const ck = Object.keys(cat).filter((k) => !k.startsWith("@"));
  const missing = keys.filter((k) => !(k in cat)); const extra = ck.filter((k) => !(k in en));
  if (missing.length) errs.push(`missing: ${missing.join(", ")}`);
  if (extra.length) errs.push(`extra: ${extra.join(", ")}`);
  errs.push(...statusErrors(code, cat, lang?.tier), ...safetyErrors(code, cat, SAFETY_LOCK), ...untranslatedErrors(code, cat, en, lang?.tier));
  const rules = lang ? new Intl.PluralRules(lang.locale).resolvedOptions().pluralCategories : ["other"];
  const i18n = createI18n({ catalogs: { en, [code]: cat }, lang: code, onMissing: (k) => errs.push(`fallback hit: ${k}`) });
  for (const k of keys) {
    const msg = cat[k]; if (typeof msg !== "string") continue;
    // v2.7 (review #13): an empty translation ships a blank label — the kit does not fall back for "".
    if (msg.trim() === "" && String(en[k] ?? "").trim() !== "") { errs.push(`${k}: empty translation`); continue; }
    const a = [...argNames(en[k])].sort().join(","), b = [...argNames(msg)].sort().join(",");
    if (a !== b) errs.push(`${k}: arguments {${b}} ≠ English {${a}}`);
    for (const m of msg.matchAll(/\b(zero|one|two|few|many|other)\s*\{/g)) if (!rules.includes(m[1])) errs.push(`${k}: plural category "${m[1]}" is not used by ${code}`);
    for (const p of PROTECTED) if (en[k].includes(p) && !msg.includes(p)) errs.push(`${k}: protected token "${p}" was translated or dropped`);
    try { const out = i18n.t(k, VARS); if (/⟦|\{[a-z]+[,}]/.test(out)) errs.push(`${k}: unrendered placeholder → ${out}`); }
    catch (e) { errs.push(`${k}: does not parse (${e.message})`); }
  }
  if (errs.length) { failures++; console.log(`✗ ${code}\n  - ${errs.join("\n  - ")}`); }
  else console.log(`✓ ${code}  ${ck.length} keys  ${cat["@status"]}${cat["@pendingReview"]?.length ? `  · ${cat["@pendingReview"].length} pending native review` : ""}`);
}
process.exit(failures ? 1 : 0);
