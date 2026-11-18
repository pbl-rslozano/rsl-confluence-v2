// languagetool-check.test.mjs — the informational LanguageTool CI check (2.8.0, owner decision 17 Nov 2026).
// Tests the extraction (ICU placeholders and brand strings removed, plural/select reduced to their `other` text), the
// language map (fil → Tagalog), the summary, and that the CI job is pinned, local and never blocking. No LanguageTool or
// Java is needed here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = async () => import("./languagetool-check.mjs").catch(() => ({}));

test("language map covers ar, de, es, fr, it, ja, pt, ru, zh, fil (as Tagalog) and en, nothing else", async () => {
  const { LT_LANGUAGES } = await load();
  assert.ok(LT_LANGUAGES, "LT_LANGUAGES exported");
  assert.deepEqual(Object.keys(LT_LANGUAGES).sort(), ["ar", "de", "en", "es", "fil", "fr", "it", "ja", "pt", "ru", "zh"]);
  assert.match(LT_LANGUAGES.fil, /^tl(-PH)?$/, "the fil catalog is checked as Tagalog (tl)");
  assert.equal(LT_LANGUAGES.pt, "pt-BR", "the pt catalog is Brazilian Portuguese");
  assert.match(LT_LANGUAGES.en, /^en-/);
});

test("ICU placeholders are removed; plural and select keep their `other` text without #", async () => {
  const { icuText } = await load();
  assert.equal(typeof icuText, "function", "icuText exported");
  assert.equal(icuText("Top {n, number}"), "Top");
  assert.equal(icuText("Hello {name}, welcome"), "Hello, welcome");
  assert.equal(icuText("{count, plural, =0 {No reversal alerts} one {# reversal alert} other {# reversal alerts}}"), "reversal alerts");
  assert.equal(icuText("Switch to {theme, select, light {light} other {dark}} theme"), "Switch to dark theme");
  assert.equal(icuText("{days, plural, one {Last backup # day ago.} other {Last backup # days ago.}} Export one from About."), "Last backup days ago. Export one from About.");
  assert.equal(icuText("{n, plural, other {{src} has # rows}}"), "has rows", "nested placeholder inside a branch");
  assert.equal(icuText("l'alerte de {coin}"), "l'alerte de", "a lone apostrophe is text");
  assert.equal(icuText("SHA-256 {sha}"), "SHA-256");
});

test("brand strings and the build stamp are removed; metadata keys and empty strings are skipped", async () => {
  const { extractStrings } = await load();
  assert.equal(typeof extractStrings, "function", "extractStrings exported");
  const out = extractStrings({
    "@status": "MACHINE-CHECKED",
    "@reviewer": null,
    "@pendingReview": ["x.y"],
    "about.credit": "rsL Confluence Terminal by rsLozano",
    "about.stamp": "Version 2.8.0 (build 20261118)",
    "about.powered": "Powered by rsL Confluence Terminal · 2.8.0 · build 20261118",
    "only.placeholder": "{sha}",
    "ctl.top": "Top {n, number}",
    "kit": "rsL Core Kit",
  });
  assert.deepEqual(out.map((s) => s.key), ["about.stamp", "about.powered", "ctl.top"]);
  for (const { text } of out) {
    assert.doesNotMatch(text, /rsL|rsLozano|Confluence Terminal|\{|\}|\d+\.\d+\.\d+|build \d{8}/, text);
  }
  assert.equal(out.find((s) => s.key === "about.stamp").text, "Version");
  assert.equal(out.find((s) => s.key === "ctl.top").text, "Top");
});

test("the real catalogs extract without braces or brand strings (fil and ar spot check)", async () => {
  const { extractStrings } = await load();
  for (const code of ["fil", "ar", "en"]) {
    const cat = JSON.parse(readFileSync(join(ROOT, `apps/confluence/web/src/rsl/i18n/${code}.json`), "utf8"));
    const out = extractStrings(cat);
    assert.ok(out.length > 500, `${code}: ${out.length} strings`);
    const bad = out.filter(({ text }) => /[{}]|\brsL\b|rsLozano|Confluence Terminal/.test(text)).map((s) => `${s.key}: ${s.text}`);
    assert.deepEqual(bad, [], code);
  }
});

test("a LanguageTool JSON result is summarised as matches per rule category", async () => {
  const { summarise } = await load();
  assert.equal(typeof summarise, "function", "summarise exported");
  const lt = JSON.stringify({
    software: { name: "LanguageTool", version: "6.6" },
    matches: [
      { rule: { id: "MORFOLOGIK_RULE_DE_DE", category: { id: "TYPOS", name: "Possible Typo" } } },
      { rule: { id: "DE_AGREEMENT", category: { id: "GRAMMAR", name: "Grammar" } } },
      { rule: { id: "MORFOLOGIK_RULE_DE_DE", category: { id: "TYPOS", name: "Possible Typo" } } },
      { rule: { id: "X" } },
    ],
  });
  const s = summarise("Expected text language: German\n" + lt);
  assert.equal(s.matches, 4);
  assert.deepEqual(s.byCategory, { TYPOS: 2, GRAMMAR: 1, OTHER: 1 });
});

test("the summary table lists each catalog with strings checked and matches by category", async () => {
  const { renderSummary } = await load();
  assert.equal(typeof renderSummary, "function", "renderSummary exported");
  const md = renderSummary({ version: "6.6", results: [
    { catalog: "de", language: "de-DE", strings: 840, matches: 3, byCategory: { TYPOS: 2, GRAMMAR: 1 } },
    { catalog: "fil", language: "tl-PH", strings: 838, matches: 0, byCategory: {} },
    { catalog: "ja", language: "ja-JP", strings: 0, matches: 0, byCategory: {}, error: "java exited 1" },
  ] });
  assert.match(md, /informational/i);
  assert.match(md, /\| de \| de-DE \| 840 \| 3 \| GRAMMAR 1, TYPOS 2 \|/);
  assert.match(md, /\| fil \| tl-PH \| 838 \| 0 \| — \|/);
  assert.match(md, /\| ja \| ja-JP \| 0 \| — \| error: java exited 1 \|/);
});

test("CI: the LanguageTool job is informational, local, and pinned (LanguageTool version + SHA-256, Java action by SHA)", () => {
  const yml = readFileSync(join(ROOT, ".github/workflows/languagetool.yml"), "utf8");
  assert.match(yml, /^on:\n  pull_request:[\s\S]*\n  workflow_dispatch:/m);
  assert.match(yml, /^    continue-on-error: true$/m, "job-level continue-on-error");
  assert.match(yml, /uses: actions\/setup-java@[0-9a-f]{40} /, "setup-java pinned by commit SHA");
  for (const m of yml.matchAll(/uses: ([^\s@]+)@(\S+)/g)) assert.match(m[2], /^[0-9a-f]{40}$/, `${m[1]} pinned by SHA`);
  assert.match(yml, /sha256sum -c/, "the download is verified against the pinned SHA-256");
  assert.match(yml, /node tools\/languagetool-check\.mjs/);
  assert.match(yml, /GITHUB_STEP_SUMMARY|upload-artifact/);
  assert.doesNotMatch(yml, /api\.languagetool\.org|languagetoolplus\.com/, "no remote LanguageTool API");
  const lock = JSON.parse(readFileSync(join(ROOT, "tools/languagetool.lock.json"), "utf8"));
  assert.match(lock.version, /^\d+\.\d+(\.\d+)?$/, "exact LanguageTool version");
  assert.match(lock.sha256, /^[0-9a-f]{64}$/, "SHA-256 of the zip");
  assert.equal(lock.url, `https://languagetool.org/download/LanguageTool-${lock.version}.zip`);
  assert.match(lock.licence, /LGPL-2\.1/);
  // Not a release check and not in the release workflow: it can never block a build or a release.
  assert.doesNotMatch(readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8"), /languagetool/i);
  assert.doesNotMatch(readFileSync(join(ROOT, "tools/release-check.mjs"), "utf8"), /languagetool/i);
});
