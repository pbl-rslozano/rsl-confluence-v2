// WP28 Task 11: docs/backup-provider-setup.md (owner registration notes) must agree with the code it describes.
// Every constant is read statically from source, never retyped here.
//   node --test tools/backup-setup-doc.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const grab = (src, re, what) => {
  const m = re.exec(src);
  assert.ok(m, `${what} anchor missing in source`);
  return m[1];
};

const DOC = read("docs/backup-provider-setup.md");
const providers = read("apps/confluence/web/src/lib/backup-providers.ts");
const oauth = read("apps/confluence/web/src/lib/backup-oauth.ts");

const UPDATE_ORIGIN = grab(read("apps/confluence/web/src/lib/update-channel.ts"), /export const UPDATE_ORIGIN = "([^"]+)"/, "UPDATE_ORIGIN");
const LOOPBACK_REDIRECT = grab(providers, /export const LOOPBACK_REDIRECT = "([^"]+)"/, "LOOPBACK_REDIRECT");
const APP_LINK_PATH = grab(providers, /export const APP_LINK_PATH = "([^"]+)"/, "APP_LINK_PATH");

test("the three redirect URIs are in the doc", () => {
  for (const uri of [UPDATE_ORIGIN + "/", LOOPBACK_REDIRECT, UPDATE_ORIGIN + APP_LINK_PATH]) {
    assert.ok(DOC.includes(uri), `redirect URI missing: ${uri}`);
  }
});

test("every NEXT_PUBLIC_ build variable read by the code, and the repository variables, are named", () => {
  const names = [...new Set([...providers.matchAll(/\b(NEXT_PUBLIC_RSL_[A-Z0-9_]+)/g)].map((m) => m[1]))];
  assert.ok(names.length >= 4, "expected the client-ID and app-link variables in backup-providers.ts");
  for (const n of names) {
    assert.ok(DOC.includes(n), `build variable missing: ${n}`);
    assert.ok(DOC.includes(n.replace(/^NEXT_PUBLIC_/, "")), `repository variable missing: ${n.replace(/^NEXT_PUBLIC_/, "")}`);
  }
  const appLink = read("tools/app-link-files.mjs");
  for (const n of [...new Set([...appLink.matchAll(/env\.(RSL_[A-Z0-9_]+)/g)].map((m) => m[1]))]) {
    assert.ok(DOC.includes(n), `app-link variable missing: ${n}`);
  }
});

test("both scopes from the auth URLs are in the doc", () => {
  const gdrive = grab(oauth, /const GDRIVE_SCOPE = "([^"]+)"/, "GDRIVE_SCOPE");
  const onedrive = grab(oauth, /const ONEDRIVE_SCOPE = "([^"]+)"/, "ONEDRIVE_SCOPE");
  assert.ok(DOC.includes(gdrive), "Google scope missing");
  assert.ok(DOC.includes(onedrive), "OneDrive scope missing");
});

test("it names the deferred download-origin list and the pCloud folder", () => {
  assert.ok(DOC.includes("ONEDRIVE_DOWNLOAD_ORIGINS"));
  assert.ok(read("apps/confluence/web/src/lib/public-hosts.ts").includes("ONEDRIVE_DOWNLOAD_ORIGINS"));
  const folder = decodeURIComponent(grab(read("apps/confluence/web/src/lib/backup-targets.ts"), /const FOLDER = "([^"]+)"/, "FOLDER"));
  assert.ok(DOC.includes(folder), `pCloud folder missing: ${folder}`);
});

test("it holds no client secret value", () => {
  assert.ok(!/client_secret\s*[=:]\s*["']?[A-Za-z0-9_\-]{8,}/i.test(DOC), "a client_secret value pattern is present");
  assert.ok(!/GOCSPX-[A-Za-z0-9_-]+/.test(DOC), "a Google secret pattern is present");
  assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(DOC), "a private key is present");
});

test("the organisation-details check passes", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "tools/checks/no-org-ids.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
