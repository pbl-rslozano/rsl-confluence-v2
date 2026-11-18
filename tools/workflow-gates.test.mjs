// workflow-gates.test.mjs — 2.8.0 release prep (owner decisions of 17 and 18 Nov 2026).
//
// .github/workflows/release.yml: a manual dispatch builds every installer, but deploys the update channel (Netlify job
// `publish`) and creates GitHub releases (`publish_*` jobs) only when its `publish` input is true (default false). Tag
// pushes and `[release…]` commits on main publish as before. Windows and macOS installers build without signing
// material: Windows has no signCommand; macOS takes the ad-hoc RSL_MACOS_UNSIGNED path when the Apple secrets are absent.
//
// The job-level `if:` expressions are evaluated here with a small evaluator for the GitHub expression subset they use
// (||, &&, !, ==, !=, parentheses, string literals, true/false, context paths, startsWith, contains).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const YML = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");

/** Job id → { if, body } from the top-level `jobs:` map (two-space job keys, four-space job fields). */
function jobs(yml) {
  const lines = yml.split("\n");
  const start = lines.indexOf("jobs:");
  const out = {};
  let id = null;
  for (const line of lines.slice(start + 1)) {
    const key = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (key) { id = key[1]; out[id] = { if: null, body: "" }; continue; }
    if (!id) continue;
    out[id].body += line + "\n";
    const cond = /^    if:\s*(.+)$/.exec(line);
    if (cond) out[id].if = cond[1].trim();
  }
  return out;
}

function tokenize(src) {
  const re = /\s*(\|\||&&|==|!=|!|\(|\)|,|'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_.-]*)/y;
  const out = [];
  let m;
  while (re.lastIndex < src.length && (m = re.exec(src))) out.push(m[1]);
  if (re.lastIndex < src.trimEnd().length) throw new Error(`cannot tokenize: ${src.slice(re.lastIndex)}`);
  return out;
}

function evaluate(expr, ctx) {
  const t = tokenize(expr.replace(/^\$\{\{\s*|\s*\}\}$/g, ""));
  let i = 0;
  const peek = () => t[i];
  const take = (want) => { const x = t[i++]; if (want && x !== want) throw new Error(`expected ${want}, got ${x} in ${expr}`); return x; };
  const truthy = (v) => !(v === false || v === "" || v === 0 || v === null || v === undefined);
  const lookup = (path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), ctx);
  const eq = (a, b) => (typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b);
  function primary() {
    const x = take();
    if (x === "(") { const v = or(); take(")"); return v; }
    if (x === "!") return !truthy(primary());
    if (x.startsWith("'")) return x.slice(1, -1).replaceAll("''", "'");
    if (x === "true" || x === "false") return x === "true";
    if (peek() === "(") {
      take("(");
      const args = [];
      while (peek() !== ")") { args.push(or()); if (peek() === ",") take(","); }
      take(")");
      const [a, b] = args.map((v) => String(v ?? "").toLowerCase());
      if (x === "startsWith") return a.startsWith(b);
      if (x === "contains") return a.includes(b);
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

const CTX = {
  pr: { github: { event_name: "pull_request", ref: "refs/pull/17/merge", event: {} }, inputs: {} },
  pushMain: { github: { event_name: "push", ref: "refs/heads/main", event: { head_commit: { message: "Merge pull request #17" } } }, inputs: {} },
  releaseCommit: { github: { event_name: "push", ref: "refs/heads/main", event: { head_commit: { message: "2.8.0 [release]" } } }, inputs: {} },
  tag: { github: { event_name: "push", ref: "refs/tags/v2.8.0", event: { head_commit: { message: "x" } } }, inputs: {} },
  dispatchBuild: { github: { event_name: "workflow_dispatch", ref: "refs/heads/main", event: {} }, inputs: { publish: false, draft: true } },
  dispatchPublish: { github: { event_name: "workflow_dispatch", ref: "refs/heads/main", event: {} }, inputs: { publish: true, draft: true } },
};

const J = jobs(YML);
const PUBLISH = Object.keys(J).filter((id) => id === "publish" || id.startsWith("publish_"));
const BUILDS = ["windows", "macos", "linux", "android", "ios"];

test("the evaluator reads the expression forms release.yml uses", () => {
  assert.equal(evaluate("startsWith(github.ref, 'refs/tags/v') || github.event_name == 'workflow_dispatch'", CTX.tag), true);
  assert.equal(evaluate("github.event_name == 'workflow_dispatch' && inputs.publish", CTX.dispatchBuild), false);
  assert.equal(evaluate("(github.ref == 'refs/heads/main' && contains(github.event.head_commit.message, '[release]'))", CTX.releaseCommit), true);
  assert.equal(evaluate("!(inputs.publish)", CTX.dispatchBuild), true);
});

test("workflow_dispatch has a boolean `publish` input, default false, and keeps `draft`", () => {
  const inputs = YML.slice(YML.indexOf("  workflow_dispatch:"), YML.indexOf("\npermissions:"));
  const publish = /\n      publish:\n((?:        .+\n)+)/.exec(inputs)?.[1] ?? "";
  assert.match(publish, /^        type: boolean$/m, publish);
  assert.match(publish, /^        default: false$/m, publish);
  assert.match(publish, /^        description: "Publish: deploy the update channel and create GitHub releases"$/m, publish);
  assert.match(inputs, /\n      draft:\n(?:        .+\n)*        type: boolean\n(?:        .+\n)*        default: true\n/);
});

test("every publish job (Netlify `publish` and each `publish_*`) needs inputs.publish on a manual dispatch", () => {
  assert.ok(PUBLISH.includes("publish"), "Netlify publish job present");
  for (const p of ["windows", "macos", "linux", "android", "iphone", "web"]) assert.ok(PUBLISH.includes(`publish_${p}`), `publish_${p} present`);
  for (const id of PUBLISH) {
    const cond = J[id].if;
    assert.ok(cond, `${id} has a job-level if`);
    assert.match(cond, /\(github\.event_name == 'workflow_dispatch' && inputs\.publish\)/, `${id}: ${cond}`);
    assert.equal(evaluate(cond, CTX.dispatchBuild), false, `${id} must not run on a dispatch with publish false`);
    assert.equal(evaluate(cond, CTX.dispatchPublish), true, `${id} runs on a dispatch with publish true`);
    assert.equal(evaluate(cond, CTX.tag), true, `${id} runs on a version tag`);
    assert.equal(evaluate(cond, CTX.releaseCommit), true, `${id} runs on a [release] commit on main`);
    assert.equal(evaluate(cond, CTX.pr), false, `${id} never runs on a pull request`);
    assert.equal(evaluate(cond, CTX.pushMain), false, `${id} never runs on an ordinary push to main`);
  }
});

test("a dispatch with publish false still builds every installer and keeps the draft default", () => {
  for (const id of BUILDS) {
    assert.ok(J[id]?.if, `${id} job present`);
    assert.equal(evaluate(J[id].if, CTX.dispatchBuild), true, `${id} builds on a dispatch with publish false`);
    assert.equal(evaluate(J[id].if, CTX.pr), false, `${id} does not build on a pull request`);
  }
  for (const id of PUBLISH.filter((x) => x !== "publish")) assert.match(J[id].body, /DRAFT: \$\{\{ github\.event_name != 'workflow_dispatch' \|\| inputs\.draft \}\}/, id);
});

test("2.8.0 desktop builds need no signing material (owner decision 18 Nov 2026)", () => {
  const tauri = JSON.parse(readFileSync(join(ROOT, "apps/confluence/desktop/src-tauri/tauri.conf.json"), "utf8"));
  const win = tauri.bundle.windows ?? {};
  for (const k of ["signCommand", "certificateThumbprint", "digestAlgorithm", "timestampUrl"]) assert.equal(win[k], undefined, `tauri.conf.json bundle.windows.${k}`);
  const winSteps = J.windows.body.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.doesNotMatch(winSteps, /signtool|signCommand|AzureSignTool|WINDOWS_CERTIFICATE|TAURI_SIGNING/i, "the Windows job adds no signing step");
  const mac = J.macos.body;
  assert.match(mac, /if \[ -z "\$CERT\$PASSWORD\$IDENTITY\$KEY_B64\$KEY_ID\$ISSUER" \]; then\n\s+echo "RSL_MACOS_UNSIGNED=true" >> "\$GITHUB_ENV"/, "no Apple secrets → RSL_MACOS_UNSIGNED");
  assert.match(mac, /if \[ "\$\{RSL_MACOS_UNSIGNED:-\}" = true \]; then\n\s+unset APPLE_CERTIFICATE[^\n]*\n\s+export APPLE_SIGNING_IDENTITY=-/, "unsigned path signs ad hoc");
  assert.match(mac, /-unnotarized\.dmg/, "unnotarised DMGs are labelled");
});
