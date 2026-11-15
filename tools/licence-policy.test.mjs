// Tests for release check R24 (tools/checks/licence-policy.mjs, v2.8 WP20).
//   node --test tools/licence-policy.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateLicence, checkComponents, checkLicencePolicy, checkArchiveNotTracked, ARCHIVE_FILE, loadPolicy } from "./checks/licence-policy.mjs";

const policy = loadPolicy();
const c = (name, license, extra = {}) => ({ name, version: "1.0.0", license, scope: "required", ...extra });

test("SPDX expressions: OR picks an allowed branch, AND needs all, WITH keeps the base licence", () => {
  assert.equal(evaluateLicence("(MIT OR GPL-3.0-or-later)", policy).ok, true);
  assert.equal(evaluateLicence("MIT AND Zlib", policy).ok, true);
  assert.equal(evaluateLicence("MIT/Apache-2.0", policy).ok, true);
  assert.equal(evaluateLicence("Apache-2.0 WITH LLVM-exception", policy).ok, true);
  assert.equal(evaluateLicence("(MIT OR Apache-2.0) AND Unicode-3.0", policy).ok, true);
  assert.equal(evaluateLicence("GPL-3.0-only", policy).ok, false);
  assert.equal(evaluateLicence("MIT AND GPL-2.0-only", policy).ok, false);
  assert.equal(evaluateLicence("CC-BY-NC-4.0", policy).ok, false);
  assert.equal(evaluateLicence("", policy).ok, false);
  assert.equal(evaluateLicence("SEE LICENSE IN LICENSE.md", policy).ok, false);
});

test("component fixtures: GPL fails, missing fails, MPL needs a notice entry, LGPL build-only passes, @rsl/* first-party", () => {
  const run = (comps, noticed = []) => checkComponents(comps, policy, { mplNoticed: new Set(noticed) });
  assert.equal(run([c("dual", "(MIT OR GPL-3.0-or-later)")]).ok, true);
  const gpl = run([c("gpl-thing", "GPL-3.0-only")]);
  assert.equal(gpl.ok, false);
  assert.match(gpl.findings[0], /gpl-thing@1\.0\.0: GPL-3\.0-only/);
  assert.equal(run([c("nolic", "")]).ok, false);
  assert.equal(run([c("mpl-crate", "MPL-2.0")]).ok, false, "MPL without a notice entry");
  assert.equal(run([c("mpl-crate", "MPL-2.0")], ["mpl-crate@1.0.0"]).ok, true, "MPL with a notice entry");
  assert.equal(run([c("libvips", "LGPL-3.0-or-later", { scope: "excluded" })]).ok, true, "build-only is not distributed");
  assert.equal(run([c("@rsl/confluence-web", "UNLICENSED")]).ok, true);
  assert.equal(run([c("someone-else", "UNLICENSED")]).ok, false, "UNLICENSED only for first-party");
});

test("Binance Vision archive files: any tracked monthly CSV/ZIP fails, other CSVs pass", () => {
  assert.ok(ARCHIVE_FILE.test("BTCUSDT-4h-2024-01.csv"));
  assert.ok(ARCHIVE_FILE.test("ETHUSDT-1mo-2026-09.zip"));
  assert.ok(!ARCHIVE_FILE.test("ledger-export.csv"));
  assert.equal(checkArchiveNotTracked(["tools/e2e/evidence/ledger-export.csv", "README.md"]).ok, true);
  const bad = checkArchiveNotTracked(["data/BTCUSDT-1h-2024-01.csv", "klines/ETHUSDT-4h-2025-02.csv"]);
  assert.equal(bad.ok, false);
  assert.equal(bad.findings.length, 2);
});

test("the .gitignore keeps monthly archive files out wherever they are written", () => {
  const dir = mkdtempSync(join(tmpdir(), "r24-"));
  try {
    writeFileSync(join(dir, ".gitignore"), "klines/\n");
    assert.equal(checkArchiveNotTracked([], { root: dir }).ok, false, "only klines/ ignored");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("R24 passes on the repository (npm closure, Rust crates, notices, archive files)", () => {
  const r = checkLicencePolicy();
  assert.equal(r.ok, true, r.findings.join("\n"));
  assert.match(r.summary, /npm/);
  assert.match(r.summary, /crates/);
});

test("R24 fails on a fixture GPL npm dependency", () => {
  const dir = mkdtempSync(join(tmpdir(), "r24-npm-"));
  try {
    const app = join(dir, "app");
    mkdirSync(join(app, "node_modules", "gpl-dep"), { recursive: true });
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "@rsl/fixture", license: "UNLICENSED", dependencies: { "gpl-dep": "1.0.0" } }));
    writeFileSync(join(app, "node_modules", "gpl-dep", "package.json"), JSON.stringify({ name: "gpl-dep", version: "1.0.0", license: "GPL-3.0-only" }));
    writeFileSync(join(app, "node_modules", "gpl-dep", "LICENSE"), "GNU GENERAL PUBLIC LICENSE\n");
    const r = checkLicencePolicy({ root: dir, roots: ["app"], skip: ["rust", "archive", "workspace"] });
    assert.equal(r.ok, false);
    assert.match(r.findings.join("\n"), /gpl-dep@1\.0\.0/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
