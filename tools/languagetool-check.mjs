#!/usr/bin/env node
/**
 * languagetool-check.mjs — informational LanguageTool pass over the UI catalogs (2.8.0, owner decision 17 Nov 2026;
 * docs/translation-review.md). CI only (.github/workflows/languagetool.yml); never a release check, never a gate, never
 * sets a catalog status.
 *
 *   node tools/languagetool-check.mjs --lt <LanguageTool-X.Y dir> --out <report dir>
 *
 * For each catalog in LT_LANGUAGES it extracts the strings (metadata keys skipped; ICU placeholders removed; plural and
 * select reduced to their `other` text; brand strings and the build stamp removed, since they are never translated),
 * writes them one paragraph per string to <out>/<code>.txt, runs the LOCAL LanguageTool command line on it
 * (`java -jar languagetool-commandline.jar -l <lang> --json <file>`; no remote API, no network from this script) and
 * writes <out>/<code>.json, <out>/summary.json and <out>/summary.md (strings checked, matches by rule category). The
 * summary is also appended to $GITHUB_STEP_SUMMARY when set.
 *
 * LanguageTool is LGPL-2.1-or-later, downloaded in CI at the version and SHA-256 in tools/languagetool.lock.json, and
 * is not part of any build or bundle (licence policy R24 covers shipped components only).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Catalog code → LanguageTool language code. The fil catalog is checked as Tagalog. */
export const LT_LANGUAGES = Object.freeze({
  en: "en-US",
  ar: "ar",
  de: "de-DE",
  es: "es",
  fr: "fr",
  it: "it",
  ja: "ja-JP",
  pt: "pt-BR",
  ru: "ru-RU",
  zh: "zh-CN",
  fil: "tl-PH",
});

const GAP = "\u0000"; // stands where a placeholder or brand string was removed

/** Brand strings and the build stamp (never translated, so never checked). Longest first. */
const BRAND = [
  /\b\d+\.\d+\.\d+(?: \(build \d{8}\)| · build \d{8})?/g,
  /\bbuild \d{8}\b/g,
  /\brsL Core Kit\b/g,
  /\bby rsLozano\b/g,
  /\brsLozano\b/g,
  /\bConfluence Terminal\b/g,
  /\brsL\b/g,
];

function closingBrace(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i;
  }
  return s.length - 1;
}

/** ICU options "sel {msg} sel {msg} …" → { sel: msg }. */
function options(s) {
  const out = {};
  let i = 0;
  while (i < s.length) {
    const m = /^\s*([^\s{]+)\s*\{/.exec(s.slice(i));
    if (!m) break;
    const open = i + m[0].length - 1;
    const close = closingBrace(s, open);
    if (!m[1].startsWith("offset:")) out[m[1]] = s.slice(open + 1, close);
    i = close + 1;
  }
  return out;
}

function icuRaw(msg, plural = false) {
  let out = "";
  for (let i = 0; i < msg.length; i++) {
    const c = msg[i];
    if (c === "'" && msg[i + 1] === "'") { out += "'"; i++; continue; }
    if (c === "'" && (msg[i + 1] === "{" || msg[i + 1] === "}")) {
      const end = msg.indexOf("'", i + 1);
      if (end > 0) { out += msg.slice(i + 1, end); i = end; continue; }
    }
    if (plural && c === "#") { out += GAP; continue; }
    if (c !== "{") { out += c; continue; }
    const close = closingBrace(msg, i);
    const inner = msg.slice(i + 1, close);
    i = close;
    const parts = inner.split(",");
    const type = (parts[1] ?? "").trim();
    if (["plural", "select", "selectordinal"].includes(type)) {
      const opts = options(parts.slice(2).join(","));
      const branch = opts.other ?? Object.values(opts).pop() ?? "";
      out += icuRaw(branch, type !== "select");
    } else out += GAP; // {name}, {n, number}, {d, date} …
  }
  return out;
}

function clean(text) {
  return text
    .replace(new RegExp(`${GAP}(?:[ \\t]*[·|][ \\t]*${GAP})+`, "g"), GAP)
    .replace(new RegExp(`[ \\t]*${GAP}+[ \\t]*(?=[,.;:!?…)\\]、。，．！？])`, "g"), "")
    .replace(new RegExp(`[ \\t]*${GAP}+[ \\t]*`, "g"), " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[\s·|—–-]+|[\s·|—–-]+$/g, "");
}

/** One ICU message → the plain text LanguageTool should see. */
export function icuText(msg) {
  return clean(icuRaw(String(msg)));
}

function stripBrand(raw) {
  return BRAND.reduce((t, re) => t.replace(re, GAP), raw);
}

/** Catalog object → [{ key, text }] of checkable strings (metadata keys, brand-only and placeholder-only strings skipped). */
export function extractStrings(catalog) {
  const out = [];
  for (const [key, value] of Object.entries(catalog)) {
    if (key.startsWith("@") || typeof value !== "string") continue;
    const text = clean(stripBrand(icuRaw(value)));
    if (/\p{L}/u.test(text)) out.push({ key, text });
  }
  return out;
}

/** LanguageTool command-line JSON output → { matches, byCategory }. */
export function summarise(stdout) {
  const s = String(stdout);
  const start = s.indexOf('{"software"') >= 0 ? s.indexOf('{"software"') : s.indexOf("{");
  const json = JSON.parse(s.slice(start, s.lastIndexOf("}") + 1));
  const byCategory = {};
  for (const m of json.matches ?? []) {
    const cat = m?.rule?.category?.id ?? "OTHER";
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
  }
  return { matches: (json.matches ?? []).length, byCategory };
}

/** Markdown summary for the job summary and the artifact. */
export function renderSummary({ version, results }) {
  const rows = results.map((r) => {
    const cats = Object.entries(r.byCategory ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([c, n]) => `${c} ${n}`).join(", ");
    return r.error
      ? `| ${r.catalog} | ${r.language} | ${r.strings} | — | error: ${r.error} |`
      : `| ${r.catalog} | ${r.language} | ${r.strings} | ${r.matches} | ${cats || "—"} |`;
  });
  return [
    `## LanguageTool ${version} — UI catalogs (informational)`,
    "",
    "Informational only: run locally in CI, never blocks a merge or a release, never sets a catalog status. Matches are",
    "hints for the native reviewer (placeholders, brand strings and the build stamp are not checked).",
    "",
    "| Catalog | LanguageTool language | Strings checked | Matches | By rule category |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const ltDir = arg("--lt");
  const outDir = arg("--out") ?? "languagetool-report";
  const lock = JSON.parse(readFileSync(join(ROOT, "tools/languagetool.lock.json"), "utf8"));
  const jar = ltDir && join(ltDir, "languagetool-commandline.jar");
  if (!jar || !existsSync(jar)) { console.error(`languagetool-commandline.jar not found in ${ltDir ?? "(no --lt)"}`); return 1; }
  mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const [catalog, language] of Object.entries(LT_LANGUAGES)) {
    const strings = extractStrings(JSON.parse(readFileSync(join(ROOT, `apps/confluence/web/src/rsl/i18n/${catalog}.json`), "utf8")));
    const txt = join(outDir, `${catalog}.txt`);
    writeFileSync(txt, strings.map((s) => s.text).join("\n\n") + "\n");
    const r = spawnSync("java", ["-jar", jar, "-l", language, "--json", txt], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: 15 * 60_000 });
    const row = { catalog, language, strings: strings.length, matches: 0, byCategory: {} };
    if (r.status !== 0) row.error = `java exited ${r.status ?? r.signal}: ${String(r.stderr || r.error || "").trim().split("\n").pop()}`;
    else {
      writeFileSync(join(outDir, `${catalog}.json`), r.stdout);
      try { Object.assign(row, summarise(r.stdout)); } catch (e) { row.error = `unreadable output: ${e.message}`; }
    }
    results.push(row);
    console.log(row.error ? `${catalog} (${language}): ${row.error}` : `${catalog} (${language}): ${row.strings} strings, ${row.matches} matches`);
  }
  const md = renderSummary({ version: lock.version, results });
  writeFileSync(join(outDir, "summary.json"), JSON.stringify({ languagetool: lock.version, results }, null, 2) + "\n");
  writeFileSync(join(outDir, "summary.md"), md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  return results.some((r) => r.error) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
