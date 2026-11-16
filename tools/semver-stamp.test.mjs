// semver-stamp.test.mjs — KIT-003 (owner decision, 16 Nov 2026): version + build metadata is "1.0.0 (build 20261116)",
// never the old number + year form ("v1.0 2026 · build 20261116"). This guards the LIVE sources; historical records
// (CHANGELOG entries of past releases, ADRs, dated reviews, research, plans/specs, KIT-001/002, acceptance evidence) are
// not scanned. Run: node --experimental-strip-types --no-warnings --test tools/semver-stamp.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStamp, poweredBy } from "../packages/core/core/rsl-brand.js";
import { APP } from "../apps/confluence/web/src/rsl/app-info.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "tools/semver-stamp.test.mjs";
const SKIP_DIRS = new Set(["node_modules", ".next", "out", "target", "gen", "dist", ".turbo", "android", "ios", "evidence", "baselines", ".git", ".superpowers"]);
const SCAN_EXT = /\.(m?[jt]sx?|cjs|css|json|yml|yaml|md)$/;
// Live roots only. docs/ is limited to the files below: the other docs are dated or historical records.
const LIVE_DOCS = ["docs/user-guide/en.md", "docs/claude-mcp.md", "docs/recorder.md", "docs/measurement.md", "docs/asset-classes.md", "docs/security-controls.md", "README.md", "package.json"];
const LIVE_DIRS = ["apps", "packages", "tools", ".github"];
const MONTH = "(?:January|February|March|April|May|June|July|August|September|October|November|December)";
const OLD_FORMS = [
  [/\bv\d+\.\d+(?:\.\d+)? 20\d\d\b/, "v1.0 2026 (number + year)"],
  [new RegExp(`(?<!${MONTH} )\\b20\\d\\d · build\\b`), "2026 · build N (year before build)"],
  [/v\$\{[^}]*\} \$\{/, "v${version} ${year}"],
  [/\$\{[^}]*version[^}]*\} \$\{[^}]*year[^}]*\}/i, "${version} ${year}"],
];
// External document titles ("masterclass v1.0 2026") are names of other documents, not this app's stamp.
const ALLOWED_LINE = /masterclass v\d+\.\d+ 20\d\d/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (SCAN_EXT.test(name) && st.size < 2_000_000) out.push(p);
  }
  return out;
}

test("no live source, test, check, workflow or current doc uses the old number + year stamp", () => {
  const files = [...LIVE_DIRS.flatMap((d) => walk(join(ROOT, d))), ...LIVE_DOCS.map((f) => join(ROOT, f))];
  const hits = [];
  for (const f of files) {
    const rel = relative(ROOT, f).split(sep).join("/");
    if (rel === SELF || rel.endsWith("coffee-kit.json") || rel.endsWith("pnpm-lock.yaml") || rel.endsWith("package-lock.json")) continue;
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (ALLOWED_LINE.test(line)) return;
      for (const [re, what] of OLD_FORMS) if (re.test(line)) hits.push(`${rel}:${i + 1}  ${what}  ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(hits, [], "old-format stamps:\n" + hits.join("\n"));
});

test("the app stamp, footer and kit label use SemVer", () => {
  assert.match(buildStamp(APP), /^\d+\.\d+\.\d+ \(build \d{8}\)$/);
  assert.equal(buildStamp(APP), `${APP.version} (build ${APP.build})`);
  assert.equal(poweredBy(APP), `Powered by rsL ${APP.name} · ${APP.version} · build ${APP.build}`);
  const kit = JSON.parse(readFileSync(join(ROOT, "packages/core/package.json"), "utf8")).version;
  assert.match(kit, /^\d+\.\d+\.\d+$/);
  assert.equal(APP.coreKit, `rsL Core Kit ${kit}`, "app-info coreKit follows the kit package version");
  assert.equal(kit, "1.2.0", "KIT-003 bumped the kit to 1.2.0");
  assert.match(readFileSync(join(ROOT, "packages/core/README.md"), "utf8"), /^# rsL Core Kit · 1\.2\.0$/m);
  assert.ok(readFileSync(join(ROOT, "docs/kit-issues/KIT-003.md"), "utf8").startsWith("# KIT-003"), "KIT-003 records the owner decision");
});
