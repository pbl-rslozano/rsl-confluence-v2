// Tests for release check R25 (tools/checks/translation-review.mjs; final review I-1).
// R25 blocks a RELEASE while a tier-1 catalog still has strings flagged @pendingReview (machine drafts awaiting a
// native-speaker review). A normal (merge) run reports the count and does not fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = async () => (await import("./checks/translation-review.mjs").catch(() => ({}))).checkTranslationReview;

function fixture(ar) {
  const root = mkdtempSync(join(tmpdir(), "r25-"));
  const dir = join(root, "apps/confluence/web/src/rsl/i18n");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "en.json"), JSON.stringify({ "@status": "APPROVED", "a.one": "One", "b.two": "Two" }));
  writeFileSync(join(dir, "ar.json"), JSON.stringify(ar));
  writeFileSync(join(dir, "ja.json"), JSON.stringify({ "@status": "MACHINE-CHECKED", "a.one": "One", "b.two": "Two" }));
  return root;
}

test("R25 release mode fails while tier-1 strings are pending native review", async () => {
  const check = await load();
  assert.equal(typeof check, "function", "checkTranslationReview exported");
  const root = fixture({ "@status": "APPROVED", "@pendingReview": ["a.one", "b.two"], "a.one": "واحد", "b.two": "اثنان" });
  try {
    const r = check(root, { release: true });
    assert.equal(r.ok, false);
    assert.match(r.findings.join(" "), /ar: 2 strings pending native-speaker review/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("R25 merge mode reports pending strings but does not fail", async () => {
  const check = await load();
  const root = fixture({ "@status": "APPROVED", "@pendingReview": ["a.one"], "a.one": "واحد", "b.two": "اثنان" });
  try {
    const r = check?.(root, { release: false });
    assert.equal(r?.ok, true);
    assert.match(r?.summary ?? "", /ar 1 pending/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("R25 release mode passes once every flag is cleared", async () => {
  const check = await load();
  const root = fixture({ "@status": "APPROVED", "a.one": "واحد", "b.two": "اثنان" });
  try {
    assert.equal(check?.(root, { release: true })?.ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("R25 is wired: release-check runs it, and CI passes --release only on release builds", () => {
  const rc = readFileSync(join(ROOT, "tools/release-check.mjs"), "utf8");
  assert.match(rc, /checkTranslationReview\(ROOT, \{ release: process\.argv\.includes\("--release"\) \}\)/);
  const yml = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
  const step = yml.split("\n").find((l) => l.includes("node tools/release-check.mjs --with-tests")) ?? "";
  assert.match(step, /startsWith\(github\.ref, 'refs\/tags\/v'\)/, step);
  assert.match(step, /'--release'/, step);
});
