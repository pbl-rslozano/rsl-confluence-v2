// docs-parity.test.mjs — release check R19 (tools/checks/docs-parity.mjs) on fixture trees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDocsParity } from "./checks/docs-parity.mjs";

const RELEASED = "# v2.7.0 — 11 November 2026 · build 20261111\n\n- **Quotes (WP12):** stablecoin pairs.\n";
function tree(changelog) {
  const root = mkdtempSync(join(tmpdir(), "r19-"));
  const put = (p, text) => { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), text); };
  put("apps/confluence/web/src/lib/build-info.ts", 'export const BUILD_INFO = { version: "2.7.0", build: 20261111 } as const;\n');
  put("docs/user-guide/en.md", "<!-- wp:WP12 -->\n# rsL Confluence Terminal v2.7 2026 — User guide\n\nv2.7 2026 · build 20261111\n");
  put("docs/superpowers/specs/2026-11-11-v2.7-architecture-design.md", "<!-- user-visible: WP12 -->\n### WP12 — Quotes\n");
  put("CHANGELOG.md", changelog);
  return root;
}

test("released top entry for this version that names a WP passes", () => {
  assert.equal(checkDocsParity(tree(RELEASED)).ok, true);
});

test("released top entry that names no WP fails", () => {
  const r = checkDocsParity(tree("# v2.7.0 — 11 November 2026\n\n- fixes\n"));
  assert.equal(r.ok, false);
  assert.match(r.findings.join(" "), /names no plan work package/);
});

test("an in-progress entry for the next version above the released one passes, with a note", () => {
  const r = checkDocsParity(tree(`# v2.8.0 — in progress, Step 1 (not released)\n\n- **Safety (WP19).**\n\n${RELEASED}`));
  assert.equal(r.ok, true, r.findings.join("; "));
  assert.match(r.notes.join(" "), /v2\.8\.0 in progress/);
});

test("an in-progress entry must name a work package", () => {
  const r = checkDocsParity(tree(`# v2.8.0 — in progress\n\n- fixes\n\n${RELEASED}`));
  assert.equal(r.ok, false);
  assert.match(r.findings.join(" "), /v2\.8\.0 \(in progress\) names no plan work package/);
});

test("an in-progress entry still needs the released entry of this version right below it", () => {
  const r = checkDocsParity(tree("# v2.8.0 — in progress\n\n- **Safety (WP19).**\n\n# v2.6.0 — 7 November 2026\n\n- (WP7)\n"));
  assert.equal(r.ok, false);
  assert.match(r.findings.join(" "), /CHANGELOG entry below v2\.8\.0 \(in progress\) is not v2\.7\.0/);
});

test("an in-progress entry cannot be for this or an older version (a release must not ship 'in progress')", () => {
  for (const v of ["2.7.0", "2.6.9"]) {
    const r = checkDocsParity(tree(`# v${v} — in progress\n\n- (WP12)\n\n${RELEASED}`));
    assert.equal(r.ok, false, v);
    assert.match(r.findings.join(" "), /in progress/);
  }
});
