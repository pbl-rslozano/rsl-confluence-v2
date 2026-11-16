// docs-parity.test.mjs — release check R19 (tools/checks/docs-parity.mjs) on fixture trees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDocsParity } from "./checks/docs-parity.mjs";

const RELEASED = "# v2.7.0 — 11 November 2026 · build 20261111\n\n- **Quotes (WP12):** stablecoin pairs.\n";
function tree(changelog, guide) {
  const root = mkdtempSync(join(tmpdir(), "r19-"));
  const put = (p, text) => { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), text); };
  put("apps/confluence/web/src/lib/build-info.ts", 'export const BUILD_INFO = { version: "2.7.0", build: 20261111 } as const;\n');
  put("docs/user-guide/en.md", guide ?? "<!-- wp:WP12 -->\n# rsL Confluence Terminal 2.7.0 — User guide\n\nPowered by rsL Confluence Terminal · 2.7.0 · build 20261111\n");
  put("docs/superpowers/specs/2026-11-11-v2.7-architecture-design.md", "<!-- user-visible: WP12 -->\n### WP12 — Quotes\n");
  put("CHANGELOG.md", changelog);
  return root;
}

const guideWith = (title, footer) => `<!-- wp:WP12 -->\n# ${title}\n\n${footer}\n`;
test("user guide in the old number + year format fails (KIT-003)", () => {
  const r = checkDocsParity(tree(RELEASED, guideWith(`rsL Confluence Terminal v2.7 ${2026} — User guide`, `Powered by rsL Confluence Terminal · v2.7 ${2026} · build 20261111`)));
  assert.equal(r.ok, false);
  assert.match(r.findings.join(" "), /user guide title/);
  assert.match(r.findings.join(" "), /user guide footer/);
});

test("user guide title and footer must carry the SemVer version and build of BUILD_INFO", () => {
  assert.equal(checkDocsParity(tree(RELEASED, guideWith("rsL Confluence Terminal 2.7.0 — User guide", "Powered by rsL Confluence Terminal · 2.7.0 · build 20261111"))).ok, true);
  const wrong = checkDocsParity(tree(RELEASED, guideWith("rsL Confluence Terminal 2.7 — User guide", "Powered by rsL Confluence Terminal · 2.7.0 · build 20261110")));
  assert.equal(wrong.ok, false);
  assert.match(wrong.findings.join(" "), /user guide title/);
  assert.match(wrong.findings.join(" "), /user guide footer/);
});

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

// Final review M-2 / M-3 / M-4: doc and comment fixes on the real tree.
test("final review doc fixes: downgrade note, Pattern comment, slippage sample size", async () => {
  const { readFileSync } = await import("node:fs");
  const root = join(new URL(".", import.meta.url).pathname, "..");
  const read = (p) => readFileSync(join(root, p), "utf8");
  const changelog = read("CHANGELOG.md");
  const entry = changelog.slice(0, changelog.indexOf("\n# v2.7.0"));
  assert.match(entry, /going back to v2\.7[^\n]*export/i, "CHANGELOG v2.8.0: export before going back to v2.7");
  assert.match(read("docs/user-guide/en.md"), /going back to v2\.7[^\n]*export/i, "guide: export before going back to v2.7");
  const ec = read("apps/confluence/web/src/lib/engine-config.ts");
  assert.doesNotMatch(ec, /not recorded in the ledger/, "engine-config.ts: Pattern output IS recorded since WP19");
  const page = read("apps/confluence/web/src/app/page.tsx");
  assert.match(page, /slippageBps\(await fetchOrderBook\(source, r\.pair\), 10_000\)/);
  assert.match(read("docs/measurement.md"), /top 10 pairs at \$10,000/);
});
