import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildManifest, collectDigest, notesFromChangelog, deployDigest, apkFileName } from "./publish-update.mjs";
import { parseManifest } from "../apps/confluence/web/src/lib/update-channel.ts";

const sha1 = (s) => createHash("sha1").update(s).digest("hex");

test("the manifest the publisher writes is one the app accepts", () => {
  const m = buildManifest({ version: "2.5.1", build: "20261108", publishedAt: "2026-11-08T06:00:00.000Z", notes: "x", apk: { file: "rsL-Confluence-v2.5.1-build20261108.apk", bytes: 10, sha256: "b".repeat(64) } });
  assert.equal(parseManifest(m).ok, true);
  assert.equal(parseManifest(buildManifest({ version: "2.5.1", build: "20261108", publishedAt: "2026-11-08T06:00:00.000Z", notes: "", apk: null })).ok, true);
});

test("APK file name from version and build", () => {
  assert.equal(apkFileName("2.5.1", "20261108"), "rsL-Confluence-v2.5.1-build20261108.apk");
});

test("release notes come from the CHANGELOG section of that version, capped at 500 characters", () => {
  const log = "# Changelog\n\n## v2.5.1 — 2026-11-08\n- Update channel.\n- Fix A.\n\n## v2.5.0 — 2026-11-07\n- Old.\n";
  assert.equal(notesFromChangelog(log, "2.5.1"), "Update channel. Fix A.");
  assert.equal(notesFromChangelog(log, "9.9.9"), "");
  assert.ok(notesFromChangelog(`## v2.5.1\n- ${"y".repeat(900)}\n`, "2.5.1").length <= 500);
  // This repo's CHANGELOG uses level-1 headings with the build after the version.
  const real = "# v2.5.1 — 7 November 2026 · build 20261107\n\nIntro line.\n\n- **Updates:** notice.\n- Fix B.\n\n# v2.5.0 — 7 November 2026\n- Old.\n";
  assert.equal(notesFromChangelog(real, "2.5.1"), "Updates: notice. Fix B.", "markdown emphasis and code marks are dropped");
  assert.equal(notesFromChangelog(real, "2.5"), "");
});

test("digest lists every file with a leading slash and its SHA-1", () => {
  const d = mkdtempSync(join(tmpdir(), "pub-")); mkdirSync(join(d, "updates"));
  writeFileSync(join(d, "index.html"), "<p>hi</p>"); writeFileSync(join(d, "updates", "latest.json"), "{}");
  const files = collectDigest(d);
  assert.deepEqual(Object.keys(files).sort(), ["/index.html", "/updates/latest.json"]);
  assert.equal(files["/index.html"].sha1, sha1("<p>hi</p>"));
});

function fakeNetlify({ required, failFirstUpload = false }) {
  const calls = []; let uploads = 0; let polls = 0;
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", auth: init.headers?.Authorization, body: init.body });
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (url.endsWith("/sites/effervescent-bubblegum-1e5c03.netlify.app/deploys") && init.method === "POST") return ok({ id: "d1", state: "preparing" });
    if (url.endsWith("/sites/effervescent-bubblegum-1e5c03.netlify.app/deploys/d1")) { polls++; return ok({ id: "d1", state: polls === 1 ? "preparing" : "prepared", required }); }
    if (url.includes("/deploys/d1/files/") && init.method === "PUT") { uploads++; if (failFirstUpload && uploads === 1) return { ok: false, status: 500, text: async () => "boom" }; return ok({}); }
    if (url.endsWith("/deploys/d1")) return ok({ id: "d1", state: "ready" });
    return { ok: false, status: 404, text: async () => "nope" };
  };
  return { fetch, calls };
}

test("deploy uploads only the files Netlify asks for, retries a failed upload, and waits for ready", async () => {
  const files = { "/index.html": { sha1: "aaa", read: () => Buffer.from("i") }, "/updates/x.apk": { sha1: "bbb", read: () => Buffer.from("a") } };
  const { fetch, calls } = fakeNetlify({ required: ["bbb"], failFirstUpload: true });
  const logs = [];
  const r = await deployDigest({ site: "effervescent-bubblegum-1e5c03.netlify.app", token: "SECRET-TOKEN", files, fetch, sleep: async () => {}, log: (m) => logs.push(m) });
  assert.equal(r.state, "ready");
  const puts = calls.filter((c) => c.method === "PUT").map((c) => c.url);
  assert.equal(puts.length, 2);
  assert.ok(puts.every((u) => u.endsWith("/deploys/d1/files/updates/x.apk")));
  const create = calls.find((c) => c.method === "POST");
  assert.equal(JSON.parse(create.body).async, true);
  assert.deepEqual(JSON.parse(create.body).files, { "/index.html": "aaa", "/updates/x.apk": "bbb" });
  assert.ok(calls.every((c) => c.auth === "Bearer SECRET-TOKEN"));
  assert.ok(!logs.join("\n").includes("SECRET-TOKEN"), "the token is never logged");
});

test("deploy refuses to run without a token", async () => {
  await assert.rejects(deployDigest({ site: "s", token: "", files: {}, fetch: async () => ({}), sleep: async () => {}, log: () => {} }), /NETLIFY_AUTH_TOKEN/);
});
