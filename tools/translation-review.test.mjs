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

// 2.8.0 owner waiver (ADR-0020, owner decision 17 Nov 2026): with --release, R25 still measures the pending strings and
// passes only on a machine-readable waiver (tools/r25-waiver.json) for exactly this app version whose ADR exists.
// Removing the waiver, changing the version or deleting the ADR re-blocks the release.
const loadWaiver = async () => (await import("./checks/translation-review.mjs").catch(() => ({}))).applyR25Waiver;
const ADR = "docs/adr/0020-release-2.8.0-translations-pending-review.md";
const ADR_TEXT = "# ADR-0020 — Release 2.8.0 with tier-1 translations pending native review (owner waiver)\n";
function waived({ version = "2.8.0", adr = true, waiver = true, adrText = ADR_TEXT } = {}) {
  const root = fixture({ "@status": "APPROVED", "@pendingReview": ["a.one", "b.two"], "a.one": "واحد", "b.two": "اثنان" });
  if (adr) { mkdirSync(join(root, "docs/adr"), { recursive: true }); writeFileSync(join(root, ADR), adrText); }
  if (waiver) {
    mkdirSync(join(root, "tools"), { recursive: true });
    writeFileSync(join(root, "tools/r25-waiver.json"), JSON.stringify({ version, adr: ADR, owner: "rsLozano", date: "2026-11-17", reason: "drafts ship" }));
  }
  return root;
}
async function r25(root, version = "2.8.0") {
  const check = await load();
  const apply = await loadWaiver();
  assert.equal(typeof apply, "function", "applyR25Waiver exported");
  return apply(root, check(root, { release: true }), { version });
}

test("R25 release + matching owner waiver: passes, says WAIVED and still reports the pending count", async () => {
  const root = waived();
  try {
    const r = await r25(root);
    assert.equal(r.ok, true, r.findings?.join("; "));
    assert.equal(r.waived, true);
    assert.match(r.summary, /^WAIVED/);
    assert.match(r.summary, /ar 2 pending/);
    assert.match(r.summary, /ADR-0020|0020-release-2\.8\.0/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("R25 release + waiver for another version: fails as before", async () => {
  const root = waived({ version: "2.7.0" });
  try {
    const r = await r25(root);
    assert.equal(r.ok, false);
    assert.match(r.findings.join(" "), /ar: 2 strings pending native-speaker review/);
    assert.match(r.findings.join(" "), /waiver is for 2\.7\.0, not 2\.8\.0/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("R25 release with the waiver file removed: fails as before", async () => {
  const root = waived({ waiver: false });
  try {
    const r = await r25(root);
    assert.equal(r.ok, false);
    assert.match(r.findings.join(" "), /ar: 2 strings pending native-speaker review/);
    assert.doesNotMatch(r.summary ?? "", /WAIVED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("R25 release with the waiver's ADR missing: fails as before", async () => {
  const root = waived({ adr: false });
  try {
    const r = await r25(root);
    assert.equal(r.ok, false);
    assert.match(r.findings.join(" "), /ADR .*0020.* not found/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("R25 release with nothing pending passes without a waiver and never says WAIVED", async () => {
  const check = await load();
  const apply = await loadWaiver();
  const root = fixture({ "@status": "APPROVED", "a.one": "واحد", "b.two": "اثنان" });
  try {
    const r = apply?.(root, check(root, { release: true }), { version: "2.8.0" });
    assert.equal(r?.ok, true);
    assert.doesNotMatch(r?.summary ?? "", /WAIVED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("R25 waiver is wired into release-check for --release runs, against the root package version", () => {
  const rc = readFileSync(join(ROOT, "tools/release-check.mjs"), "utf8");
  assert.match(rc, /applyR25Waiver\(ROOT, r, \{ version: ver \}\)/);
});

// Review M3: the waiver's ADR must be the waiver's record: it names the waiver's version and says "owner waiver".
test("R25 release with a waiver pointing at an unrelated ADR (ADR-0003): fails", async () => {
  const root = waived({ adrText: readFileSync(join(ROOT, "docs/adr/0003-network-allowlist.md"), "utf8") });
  try {
    const r = await r25(root);
    assert.equal(r.ok, false);
    assert.match(r.findings.join(" "), /does not record an owner waiver for 2\.8\.0/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("R25 release with an ADR that records a waiver for another version: fails", async () => {
  const root = waived({ adrText: "# ADR-0099 — Release 2.7.0 (owner waiver)\n" });
  try {
    assert.equal((await r25(root)).ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the real ADR-0020 names 2.8.0 and the owner waiver", () => {
  const w = JSON.parse(readFileSync(join(ROOT, "tools/r25-waiver.json"), "utf8"));
  const adr = readFileSync(join(ROOT, w.adr), "utf8");
  assert.ok(adr.includes(w.version) && /owner waiver/i.test(adr));
});

// Review M4: a waived pass must not claim that nothing is pending.
test("R25 label: waived passes say so; the unwaived label is unchanged", async () => {
  const root = waived();
  try {
    const r = await r25(root);
    assert.equal(r.label, "Tier-1 translations: release waived by owner (pending native-speaker review)");
    assert.doesNotMatch(r.label, /no string pending/);
  } finally { rmSync(root, { recursive: true, force: true }); }
  const none = waived({ waiver: false });
  try {
    assert.equal((await r25(none)).label, "Tier-1 translations reviewed: no string pending native-speaker review");
  } finally { rmSync(none, { recursive: true, force: true }); }
  const rc = readFileSync(join(ROOT, "tools/release-check.mjs"), "utf8");
  assert.match(rc, /check\("R25", w\.label, w\.ok/);
});
