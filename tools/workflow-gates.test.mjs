// workflow-gates.test.mjs — 2.8.0 release prep (owner decisions of 17 and 18 Nov 2026; review fix round 1: C2, I3, I4).
//
// Every workflow in .github/workflows is scanned. A job counts as PUBLISHING by what it does, not by its name: it has
// contents: write (job level, or inherited from the workflow), or it runs `gh release`, publish-update.mjs, uses
// NETLIFY_AUTH_TOKEN, `git push` or `git tag`, or a release action. Every publishing job must stay off for:
//   a publish=false dispatch from main, from a feature branch and from a tag ref; a publish=true dispatch from a feature
//   branch; and a pull request.
// It may run only on a version-tag PUSH, a [release…] commit pushed to main (owner rule, unchanged) or a dispatch of main
// with publish == true. Build jobs keep no write permission and no Netlify token. Windows and macOS build without
// signing material (owner decision 18 Nov 2026).
//
// Job `if:` expressions are evaluated with a small evaluator for the GitHub expression subset the workflows use
// (||, &&, !, ==, !=, parentheses, string literals, true/false/null, context paths, startsWith, contains). A job without
// `if:` runs whenever its workflow is triggered by that event.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WF_DIR = join(ROOT, ".github/workflows");
const WORKFLOWS = Object.fromEntries(readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => [f, readFileSync(join(WF_DIR, f), "utf8")]));
const RELEASE = WORKFLOWS["release.yml"];

/* ---------- a small parser for the workflow shapes used here ---------- */
const indentOf = (l) => l.length - l.trimStart().length;
/** Lines of the block under `key:` at `indent` (exclusive), as text; inline value if any. */
function block(lines, i, indent) {
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() && !l.trimStart().startsWith("#") && indentOf(l) <= indent) break;
    out.push(l);
  }
  return out;
}
function triggersOf(lines) {
  const i = lines.findIndex((l) => /^(on|"on"|'on'):/.test(l));
  if (i < 0) return new Set();
  const inline = lines[i].replace(/^[^:]+:\s*/, "").trim();
  if (inline) return new Set(inline.replace(/[[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean));
  return new Set(block(lines, i, 0).filter((l) => indentOf(l) === 2 && /^\s+[a-z_]+:/.test(l)).map((l) => l.trim().split(":")[0]));
}
function permsAt(lines, i, indent) {
  const inline = lines[i].replace(/^[^:]+:\s*/, "").trim();
  return inline || block(lines, i, indent).join("\n");
}
export function parseWorkflow(text) {
  const lines = text.split("\n");
  const wfPermLine = lines.findIndex((l) => /^permissions:/.test(l));
  const wf = { triggers: triggersOf(lines), perms: wfPermLine >= 0 ? permsAt(lines, wfPermLine, 0) : "", jobs: {} };
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  let job = null;
  for (let i = start + 1; start >= 0 && i < lines.length; i++) {
    const l = lines[i];
    const key = /^  ([A-Za-z0-9_-]+):\s*$/.exec(l);
    if (key) { job = wf.jobs[key[1]] = { if: null, body: "", perms: null }; continue; }
    if (!job) continue;
    job.body += l + "\n";
    if (/^    if:/.test(l)) {
      const v = l.replace(/^    if:\s*/, "").trim();
      job.if = /^[>|]/.test(v) ? block(lines, i, 4).map((x) => x.trim()).join(" ") : v;
    }
    if (/^    permissions:/.test(l)) job.perms = permsAt(lines, i, 4);
  }
  return wf;
}
const effectivePerms = (wf, job) => (job.perms ?? wf.perms ?? "");
const hasWrite = (perms) => /write/.test(perms);
const RELEASE_ACTION = /^\s*-?\s*uses:\s*[^\s@]*(gh-release|release-action|create-release|upload-release|action-automatic-releases|release-please|semantic-release)[^\s@]*@/im;
export function isPublishing(wf, job) {
  const body = job.body.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  return /contents:\s*write|write-all/.test(effectivePerms(wf, job)) || /\bgh release\b/.test(body) || /publish-update\.mjs/.test(body)
    || /NETLIFY_AUTH_TOKEN/.test(body) || /\bgit push\b/.test(body) || /\bgit tag\b/.test(body) || RELEASE_ACTION.test(body);
}

/* ---------- expression evaluator ---------- */
function tokenize(src) {
  const re = /\s*(\|\||&&|==|!=|!|\(|\)|,|'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_.-]*|\d+)/y;
  const out = [];
  let m;
  while (re.lastIndex < src.trimEnd().length && (m = re.exec(src))) out.push(m[1]);
  if (re.lastIndex < src.trimEnd().length) throw new Error(`cannot tokenize: ${src.slice(re.lastIndex)}`);
  return out;
}
export function evaluate(expr, ctx) {
  const t = tokenize(expr.replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, ""));
  let i = 0;
  const peek = () => t[i];
  const take = (want) => { const x = t[i++]; if (want && x !== want) throw new Error(`expected ${want}, got ${x} in ${expr}`); return x; };
  const truthy = (v) => !(v === false || v === "" || v === 0 || v === null || v === undefined);
  const lookup = (path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), ctx) ?? null;
  const eq = (a, b) => (typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b);
  function primary() {
    const x = take();
    if (x === "(") { const v = or(); take(")"); return v; }
    if (x === "!") return !truthy(primary());
    if (x.startsWith("'")) return x.slice(1, -1).replaceAll("''", "'");
    if (x === "true" || x === "false") return x === "true";
    if (x === "null") return null;
    if (/^\d+$/.test(x)) return Number(x);
    if (peek() === "(") {
      take("(");
      const args = [];
      while (peek() !== ")") { args.push(or()); if (peek() === ",") take(","); }
      take(")");
      const [a, b] = args.map((v) => String(v ?? "").toLowerCase());
      if (x === "startsWith") return a.startsWith(b);
      if (x === "contains") return a.includes(b);
      if (x === "always" || x === "success") return true;
      throw new Error(`function ${x} not supported`);
    }
    return lookup(x);
  }
  function comparison() {
    let v = primary();
    while (peek() === "==" || peek() === "!=") { const op = take(); const w = primary(); v = op === "==" ? eq(v, w) : !eq(v, w); }
    return v;
  }
  function and() { let v = comparison(); while (peek() === "&&") { take(); const w = comparison(); v = truthy(v) ? w : v; } return v; }
  function or() { let v = and(); while (peek() === "||") { take(); const w = and(); v = truthy(v) ? v : w; } return v; }
  const v = or();
  if (i !== t.length) throw new Error(`trailing tokens in ${expr}: ${t.slice(i).join(" ")}`);
  return truthy(v);
}
const runs = (wf, job, ctx) => wf.triggers.has(ctx.github.event_name) && evaluate(job.if ?? "true", ctx);

/* ---------- contexts ---------- */
const dispatch = (ref, publish) => ({ github: { event_name: "workflow_dispatch", ref, event: { inputs: { publish } } }, inputs: { publish, draft: true } });
const push = (ref, message) => ({ github: { event_name: "push", ref, event: { head_commit: { message } } }, inputs: {} });
export const MUST_NOT_PUBLISH = {
  "publish=false dispatch from main": dispatch("refs/heads/main", false),
  "publish=false dispatch from a feature branch": dispatch("refs/heads/v2.8/release-prep", false),
  "publish=false dispatch from a tag ref": dispatch("refs/tags/v2.8.0", false),
  "publish=true dispatch from a feature branch": dispatch("refs/heads/v2.8/release-prep", true),
  "publish=true dispatch from a tag ref": dispatch("refs/tags/v2.8.0", true),
  "pull_request": { github: { event_name: "pull_request", ref: "refs/pull/17/merge", event: {} }, inputs: {} },
  "ordinary push to main": push("refs/heads/main", "Merge pull request #17"),
  "push to a feature branch": push("refs/heads/v2.8/release-prep", "x"),
};
const PUBLISH_FROM_MAIN = dispatch("refs/heads/main", true);
const TAG_PUSH = push("refs/tags/v2.8.0", "2.8.0");
const RELEASE_COMMIT = push("refs/heads/main", "2.8.0 [release]");
const BUILDS = ["verify", "windows", "macos", "linux", "android", "ios"];

/** All findings for a set of workflow texts ({ file: text }). Empty = every gate holds. */
export function audit(files) {
  const findings = [];
  for (const [file, text] of Object.entries(files)) {
    const wf = parseWorkflow(text);
    for (const [id, job] of Object.entries(wf.jobs)) {
      if (isPublishing(wf, job)) {
        for (const [name, ctx] of Object.entries(MUST_NOT_PUBLISH)) if (runs(wf, job, ctx)) findings.push(`${file}:${id} publishes on a ${name}`);
      } else {
        if (hasWrite(effectivePerms(wf, job))) findings.push(`${file}:${id} is a build job with write permission`);
        if (/NETLIFY_AUTH_TOKEN/.test(job.body)) findings.push(`${file}:${id} is a build job with the Netlify token`);
      }
    }
    if (file === "release.yml") for (const id of BUILDS) if (!wf.jobs[id]) findings.push(`release.yml: build job ${id} missing`);
  }
  return findings;
}

/* ---------- the real workflows ---------- */
test("every publishing job in every workflow stays off for publish=false dispatches, branch/tag dispatches and PRs", () => {
  assert.deepEqual(audit(WORKFLOWS), []);
});

test("jobs are classified by behaviour: the expected publishing jobs are found", () => {
  const found = [];
  for (const [file, text] of Object.entries(WORKFLOWS)) {
    const wf = parseWorkflow(text);
    for (const [id, job] of Object.entries(wf.jobs)) if (isPublishing(wf, job)) found.push(`${file}:${id}`);
  }
  for (const id of ["publish", "publish_windows", "publish_macos", "publish_android", "publish_iphone", "publish_linux", "publish_web"]) assert.ok(found.includes(`release.yml:${id}`), id);
  assert.ok(found.includes("promote-desktop.yml:promote"), "promote-desktop creates draft releases");
  assert.ok(found.includes("release-audit.yml:verify"), "release-audit uploads to releases with contents: write");
  for (const id of BUILDS) assert.ok(!found.includes(`release.yml:${id}`), `${id} is a build job`);
});

test("release.yml publish jobs run on a v-tag push, a [release] commit and a publish=true dispatch of main", () => {
  const wf = parseWorkflow(RELEASE);
  for (const id of Object.keys(wf.jobs).filter((x) => x === "publish" || x.startsWith("publish_"))) {
    const job = wf.jobs[id];
    assert.match(job.if, /\(github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)\)/, id);
    assert.match(job.if, /\(github\.event_name == 'workflow_dispatch' && inputs\.publish == true && github\.ref == 'refs\/heads\/main'\)/, id);
    assert.equal(runs(wf, job, PUBLISH_FROM_MAIN), true, `${id}: publish=true dispatch of main`);
    assert.equal(runs(wf, job, TAG_PUSH), true, `${id}: tag push`);
    assert.equal(runs(wf, job, RELEASE_COMMIT), true, `${id}: [release] commit on main`);
  }
  for (const id of BUILDS.slice(1)) {
    assert.equal(runs(wf, wf.jobs[id], dispatch("refs/heads/main", false)), true, `${id} builds on a publish=false dispatch`);
    assert.equal(runs(wf, wf.jobs[id], MUST_NOT_PUBLISH.pull_request), false, `${id} does not build on a PR`);
  }
});

test("promote-desktop and release-audit run only on a publish=true dispatch of main, never on push", () => {
  for (const [file, id] of [["promote-desktop.yml", "promote"], ["release-audit.yml", "verify"]]) {
    const wf = parseWorkflow(WORKFLOWS[file]);
    assert.ok(!wf.triggers.has("push"), `${file}: no push trigger`);
    assert.match(WORKFLOWS[file], /\n      publish:\n(?:        .+\n)*        type: boolean\n(?:        .+\n)*        default: false\n/, `${file}: publish input`);
    assert.equal(runs(wf, wf.jobs[id], PUBLISH_FROM_MAIN), true, `${file}: publish=true dispatch of main`);
  }
});

test("release.yml workflow_dispatch has a boolean `publish` input, default false, and keeps `draft`", () => {
  const inputs = RELEASE.slice(RELEASE.indexOf("  workflow_dispatch:"), RELEASE.indexOf("\npermissions:"));
  const publish = /\n      publish:\n((?:        .+\n)+)/.exec(inputs)?.[1] ?? "";
  assert.match(publish, /^        type: boolean$/m, publish);
  assert.match(publish, /^        default: false$/m, publish);
  assert.match(publish, /^        description: "Publish: deploy the update channel and create GitHub releases"$/m, publish);
  assert.match(inputs, /\n      draft:\n(?:        .+\n)*        type: boolean\n(?:        .+\n)*        default: true\n/);
  for (const id of ["publish_windows", "publish_macos", "publish_android", "publish_iphone", "publish_linux", "publish_web"]) {
    assert.match(parseWorkflow(RELEASE).jobs[id].body, /DRAFT: \$\{\{ github\.event_name != 'workflow_dispatch' \|\| inputs\.draft \}\}/, id);
  }
});

/* ---------- mutations: each loosening must be caught ---------- */
const sneaky = `
  sneaky_upload:
    name: Upload notes
    needs: verify
    if: github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-24.04
    steps:
      - run: gh release create "v9.9.9" --notes x
`;
test("mutation: a new job under another name that runs `gh release create` on any dispatch is caught", () => {
  const f = audit({ "release.yml": RELEASE.trimEnd() + "\n" + sneaky });
  assert.ok(f.some((x) => x.startsWith("release.yml:sneaky_upload publishes on a publish=false dispatch from main")), f.join("\n"));
});

test("mutation: a `gh release upload` step added to a build job is caught", () => {
  const mutated = RELEASE.replace("      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4\n        with:\n          name: installer-${{ 'windows' }}",
    "      - run: gh release upload v2.8.0-windows installer.msi\n      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4\n        with:\n          name: installer-${{ 'windows' }}");
  assert.notEqual(mutated, RELEASE, "mutation applied");
  const f = audit({ "release.yml": mutated });
  assert.ok(f.some((x) => x.startsWith("release.yml:windows publishes on a publish=false dispatch")), f.join("\n"));
});

test("mutation: the old tag-first clause (a dispatch from a tag publishes) is caught", () => {
  const mutated = RELEASE.replace("(github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v'))", "startsWith(github.ref, 'refs/tags/v')");
  assert.notEqual(mutated, RELEASE, "mutation applied");
  const f = audit({ "release.yml": mutated });
  assert.ok(f.some((x) => / publishes on a publish=false dispatch from a tag ref$/.test(x)), f.join("\n"));
});

test("mutation: a dispatch clause without the main-ref check, or a build job with write access, is caught", () => {
  const anyRef = RELEASE.replaceAll(" && github.ref == 'refs/heads/main')", ")");
  assert.ok(audit({ "release.yml": anyRef }).some((x) => /publishes on a publish=true dispatch from a feature branch$/.test(x)));
  const writeBuild = RELEASE.replace("  linux:\n    name: Desktop — ubuntu-22.04 (Linux)\n", "  linux:\n    name: Desktop — ubuntu-22.04 (Linux)\n    permissions: { packages: write }\n");
  assert.notEqual(writeBuild, RELEASE, "mutation applied");
  assert.ok(audit({ "release.yml": writeBuild }).includes("release.yml:linux is a build job with write permission"));
  const promotePush = WORKFLOWS["promote-desktop.yml"].replace(/^on:\n/m, "on:\n  push:\n    branches: [main]\n");
  const noIf = promotePush.replace(/^    if: .*\n/m, "");
  assert.ok(audit({ "promote-desktop.yml": noIf }).some((x) => x.startsWith("promote-desktop.yml:promote publishes")));
});

/* ---------- unsigned desktop builds (owner decision 18 Nov 2026) ---------- */
test("2.8.0 desktop builds need no signing material", () => {
  const J = parseWorkflow(RELEASE).jobs;
  const tauri = JSON.parse(readFileSync(join(ROOT, "apps/confluence/desktop/src-tauri/tauri.conf.json"), "utf8"));
  const win = tauri.bundle.windows ?? {};
  for (const k of ["signCommand", "certificateThumbprint", "digestAlgorithm", "timestampUrl"]) assert.equal(win[k], undefined, `tauri.conf.json bundle.windows.${k}`);
  const winSteps = J.windows.body.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.doesNotMatch(winSteps, /signtool|signCommand|AzureSignTool|WINDOWS_CERTIFICATE|TAURI_SIGNING/i, "the Windows job adds no signing step");
  const mac = J.macos.body;
  assert.match(mac, /if \[ -z "\$CERT\$PASSWORD\$IDENTITY\$KEY_B64\$KEY_ID\$ISSUER" \]; then\n\s+echo "RSL_MACOS_UNSIGNED=true" >> "\$GITHUB_ENV"/, "no Apple secrets → RSL_MACOS_UNSIGNED");
  assert.match(mac, /if \[ "\$\{RSL_MACOS_UNSIGNED:-\}" = true \]; then\n\s+unset APPLE_CERTIFICATE[^\n]*\n\s+export APPLE_SIGNING_IDENTITY=-/, "unsigned path signs ad hoc");
  assert.match(mac, /-unnotarized\.dmg/, "unnotarised DMGs are labelled");
  // Release notes name the unsigned Windows installer (review M9).
  assert.match(J.publish_windows.body, /Unsigned installer: Windows SmartScreen shows 'unknown publisher' — choose More info → Run anyway\./);
});

test("the evaluator reads the expression forms the workflows use", () => {
  assert.equal(evaluate("(github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v'))", TAG_PUSH), true);
  assert.equal(evaluate("github.event_name == 'workflow_dispatch' && inputs.publish == true", dispatch("refs/heads/main", false)), false);
  assert.equal(evaluate("inputs.publish == true", MUST_NOT_PUBLISH.pull_request), false);
  assert.equal(evaluate("(github.ref == 'refs/heads/main' && contains(github.event.head_commit.message, '[release]'))", RELEASE_COMMIT), true);
  assert.equal(evaluate("!(inputs.publish)", dispatch("refs/heads/main", false)), true);
});
