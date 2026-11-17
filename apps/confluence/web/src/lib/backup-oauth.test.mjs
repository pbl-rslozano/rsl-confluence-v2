// WP28 Task 3: the URL gates of encrypted cloud backup. isAllowedBackupUrl and isAllowedSignInUrl are the only
// thing that keeps the backup code from reaching any other URL (native HTTP is not subject to the CSP).
// Task 4 adds the provider registry, availability, HTTP port, sessions and the OAuth core below.
// Run: npm run test:backup-oauth   (node scripts/run-engine-tests.mjs backup-oauth.test.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { BackupError } from "./backup-crypto.ts";
import {
  readBackupConfig, BUILD_BACKUP_CONFIG, availability, PROVIDER_NAMES, HOSTED_ORIGIN, WEB_REDIRECT, LOOPBACK_PORT,
  LOOPBACK_REDIRECT, APP_LINK_PATH, APP_LINK_REDIRECT,
} from "./backup-providers.ts";
import { webBackupHttp, backupHttp, setBackupNativeRequest, setShellOAuth, shellOAuth } from "./backup-http.ts";
import { getSession, setSession, clearSession, clearAllSessions } from "./backup-session.ts";
import {
  createPkce, randomState, authUrl, parseCallback, exchangeCode, beginWebSignIn, consumeWebCallback, completeWebSignIn,
  signInShell, PENDING_KEY, purgeStalePending,
} from "./backup-oauth.ts";
import { UPDATE_ORIGIN } from "./update-channel.ts";
import {
  BACKUP_NATIVE_URLS, BACKUP_SIGN_IN_URLS, PCLOUD_API_HOSTS, ONEDRIVE_DOWNLOAD_ORIGINS, urlAllowed, CSP_HOSTS,
  isAllowedBackupUrl, isAllowedSignInUrl,
} from "./public-hosts.ts";

test("the tables are exactly the owner-approved lists", () => {
  assert.deepEqual([...BACKUP_NATIVE_URLS], [
    "https://oauth2.googleapis.com/token",
    "https://www.googleapis.com/drive/v3/files*",
    "https://www.googleapis.com/upload/drive/v3/files*",
    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    "https://graph.microsoft.com/v1.0/me/drive/special/approot*",
    "https://graph.microsoft.com/v1.0/me/drive/items/*",
    "https://api.pcloud.com/uploadfile*", "https://api.pcloud.com/listfolder*", "https://api.pcloud.com/gettextfile*",
    "https://eapi.pcloud.com/uploadfile*", "https://eapi.pcloud.com/listfolder*", "https://eapi.pcloud.com/gettextfile*",
  ]);
  assert.deepEqual([...BACKUP_SIGN_IN_URLS], [
    "https://accounts.google.com/o/oauth2/v2/auth*",
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize*",
    "https://my.pcloud.com/oauth2/authorize*",
  ]);
  assert.deepEqual([...PCLOUD_API_HOSTS], ["api.pcloud.com", "eapi.pcloud.com"]);
  assert.deepEqual([...ONEDRIVE_DOWNLOAD_ORIGINS], []);
});

test("the web CSP gets the four backup hosts and no Google, B2 or R2 host", () => {
  const origins = CSP_HOSTS.map((h) => h.origin);
  for (const o of ["https://login.microsoftonline.com", "https://graph.microsoft.com", "https://api.pcloud.com", "https://eapi.pcloud.com"]) assert.ok(origins.includes(o), o);
  for (const o of origins) assert.ok(!/google|backblazeb2|cloudflarestorage/.test(o), `${o} must not be in the web CSP`);
  for (const h of CSP_HOSTS.filter((h) => /microsoft|pcloud/.test(h.origin))) assert.match(h.purpose, /ADR-0003 v2\.8, WP28/);
});

test("isAllowedBackupUrl: the owner-listed examples", () => {
  for (const u of [
    "https://www.googleapis.com/drive/v3/files?spaces=appDataFolder",
    "https://www.googleapis.com/drive/v3/files/abc123?alt=media",
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
    "https://oauth2.googleapis.com/token",
    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    "https://graph.microsoft.com/v1.0/me/drive/special/approot:/x.json:/content",
    "https://graph.microsoft.com/v1.0/me/drive/special/approot",
    "https://graph.microsoft.com/v1.0/me/drive/items/ABC!123/content",
    "https://eapi.pcloud.com/gettextfile?fileid=1",
    "https://api.pcloud.com/listfolder?folderid=0",
    "https://api.pcloud.com/uploadfile?folderid=0&filename=a.rslbak",
  ]) assert.equal(isAllowedBackupUrl(u), true, u);
});

test("isAllowedBackupUrl: refuses other schemes, paths, hosts and shapes", () => {
  for (const u of [
    "http://www.googleapis.com/drive/v3/files",
    "http://api.pcloud.com/listfolder",
    "ftp://api.pcloud.com/listfolder",
    "https://api.pcloud.com/deletefile",
    "https://api.pcloud.com/",
    "https://api.pcloud.com",
    "https://graph.microsoft.com/v1.0/me/drive/root/children",
    "https://graph.microsoft.com/v1.0/me/drive/special",
    "https://graph.microsoft.com/v1.0/me/drive/items",
    "https://oauth2.googleapis.com/token/",
    "https://oauth2.googleapis.com/tokeninfo",
    "https://oauth2.googleapis.com/revoke",
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    "https://www.googleapis.com/drive/v2/files",
    "https://www.googleapis.com/gmail/v1/users/me/messages",
    "https://www.googleapis.com/upload/drive/v2/files",
    // a download origin that is not listed (OneDrive pre-authenticated download hosts, a CDN, a lookalike)
    "https://public.dm.files.1drv.com/y4mabc",
    "https://example-download.test/file",
    "https://api.pcloud.com.evil.test/listfolder",
    "https://evil.test/api.pcloud.com/listfolder",
    "https://evil.test/?u=https://api.pcloud.com/listfolder",
    "https://notapi.pcloud.com/listfolder",
    // userinfo
    "https://user@api.pcloud.com/listfolder",
    "https://user:pw@api.pcloud.com/listfolder",
    "https://:pw@api.pcloud.com/listfolder",
    "https://api.pcloud.com@evil.test/listfolder",
    "https://api.pcloud.com:pw@evil.test/listfolder",
    // hash
    "https://api.pcloud.com/listfolder#x",
    "https://api.pcloud.com/listfolder?a=1#",
    // junk
    "", " ", "not a url", "//api.pcloud.com/listfolder", "/listfolder", "javascript:alert(1)", "data:text/plain,hi", "file:///etc/passwd",
  ]) assert.equal(isAllowedBackupUrl(u), false, JSON.stringify(u));
  for (const v of [undefined, null, 5, {}, ["https://api.pcloud.com/listfolder"]]) assert.equal(isAllowedBackupUrl(v), false, String(v));
});

test("isAllowedBackupUrl: traversal and encoded separators are refused in the raw string, not only the parsed path", () => {
  for (const u of [
    "https://www.googleapis.com/drive/v3/../../x",
    "https://www.googleapis.com/drive/v3/files/../../../gmail/v1/users/me/messages",
    "https://www.googleapis.com/drive/v3/files/..",
    "https://www.googleapis.com/drive/v3/files/./../files",
    "https://www.googleapis.com/drive/v3/files/%2e%2e/%2e%2e/x",
    "https://www.googleapis.com/drive/v3/files/%2E%2E/x",
    "https://www.googleapis.com/drive/v3/files/.%2e/x",
    "https://www.googleapis.com/drive/v3/files/%2e./x",
    "https://www.googleapis.com/drive/v3/files/%252e%252e/x",
    "https://www.googleapis.com/drive/v3/files/a%2fb",
    "https://www.googleapis.com/drive/v3/files/a%2Fb",
    "https://www.googleapis.com/drive/v3/files/a%5cb",
    "https://www.googleapis.com/drive/v3/files/a%5Cb",
    "https://www.googleapis.com/drive/v3/files/a\\b",
    "https://www.googleapis.com/drive/v3/files/..\\x",
    "https://graph.microsoft.com/v1.0/me/drive/items/../root/children",
    "https://graph.microsoft.com/v1.0/me/drive/items/x%2f..%2f..%2froot",
    "https://graph.microsoft.com/v1.0/me/drive/special/approot:/../x.json:/content",
    "https://api.pcloud.com/listfolder/../deletefile",
    "https://api.pcloud.com/listfolder%2f..%2fdeletefile",
    "https://api.pcloud.com/listfolder%00",
    "https://api.pcloud.com/list\tfolder",
    "https://api.pcloud.com/list\nfolder",
    "https://api.pcloud.com/listfolder /x",
  ]) assert.equal(isAllowedBackupUrl(u), false, JSON.stringify(u));
});

test("isAllowedBackupUrl: the query is ignored, even when it carries dots, slashes or another URL", () => {
  for (const u of [
    "https://api.pcloud.com/listfolder?path=../../x",
    "https://api.pcloud.com/listfolder?path=%2fbackups%2f..",
    "https://api.pcloud.com/listfolder?next=https://evil.test/",
    "https://api.pcloud.com/listfolder?",
    "https://oauth2.googleapis.com/token?x=1",
  ]) assert.equal(isAllowedBackupUrl(u), true, u);
  // ... but a query cannot turn a refused path into an allowed one.
  assert.equal(isAllowedBackupUrl("https://api.pcloud.com/deletefile?x=/listfolder"), false);
  assert.equal(isAllowedBackupUrl("https://api.pcloud.com/?/listfolder"), false);
});

test("isAllowedBackupUrl: host case, trailing dot, ports and path case", () => {
  // URL parsing lowercases the host and drops the default port, so these name the same origin and the same request.
  assert.equal(isAllowedBackupUrl("https://API.PCLOUD.COM/listfolder"), true);
  assert.equal(isAllowedBackupUrl("HTTPS://api.pcloud.com/listfolder"), true);
  assert.equal(isAllowedBackupUrl("https://api.pcloud.com:443/listfolder"), true);
  // A different origin is refused: trailing dot, non-default port, other ports, IP and IPv6 hosts.
  assert.equal(isAllowedBackupUrl("https://api.pcloud.com./listfolder"), false);
  assert.equal(isAllowedBackupUrl("https://API.PCLOUD.COM./listfolder"), false);
  assert.equal(isAllowedBackupUrl("https://api.pcloud.com:8443/listfolder"), false);
  assert.equal(isAllowedBackupUrl("https://api.pcloud.com:80/listfolder"), false);
  assert.equal(isAllowedBackupUrl("https://oauth2.googleapis.com:444/token"), false);
  assert.equal(isAllowedBackupUrl("https://127.0.0.1/listfolder"), false);
  assert.equal(isAllowedBackupUrl("https://[::1]/listfolder"), false);
  // Paths are case-sensitive: no case-folded match.
  assert.equal(isAllowedBackupUrl("https://api.pcloud.com/ListFolder"), false);
  assert.equal(isAllowedBackupUrl("https://oauth2.googleapis.com/TOKEN"), false);
  assert.equal(isAllowedBackupUrl("https://www.googleapis.com/Drive/v3/files"), false);
  // Look-alike Unicode hosts (full-width dot, Cyrillic a) are different origins.
  assert.equal(isAllowedBackupUrl("https://api．pcloud.com/listfolder"), false);
  assert.equal(isAllowedBackupUrl("https://аpi.pcloud.com/listfolder"), false);
});

test("isAllowedBackupUrl: an exact entry is exact, a trailing-star entry is a prefix that includes the prefix itself", () => {
  assert.equal(isAllowedBackupUrl("https://oauth2.googleapis.com/token"), true);
  assert.equal(isAllowedBackupUrl("https://oauth2.googleapis.com/token/x"), false);
  assert.equal(isAllowedBackupUrl("https://www.googleapis.com/drive/v3/files"), true);
  assert.equal(isAllowedBackupUrl("https://www.googleapis.com/drive/v3/files/x/y"), true);
  assert.equal(isAllowedBackupUrl("https://graph.microsoft.com/v1.0/me/drive/items/"), true);
  assert.equal(isAllowedBackupUrl("https://graph.microsoft.com/v1.0/me/drive/items"), false);
});

test("the exported allowlists are frozen at runtime", () => {
  for (const l of [BACKUP_NATIVE_URLS, BACKUP_SIGN_IN_URLS, PCLOUD_API_HOSTS, ONEDRIVE_DOWNLOAD_ORIGINS]) {
    assert.ok(Object.isFrozen(l));
    assert.throws(() => l.push("https://example.test/x"), TypeError);
    assert.throws(() => { l[0] = "https://example.test/x"; }, TypeError);
  }
  assert.equal(ONEDRIVE_DOWNLOAD_ORIGINS.length, 0);
  assert.equal(isAllowedBackupUrl("https://example-download.test/any"), false);
});

test("an origin in the download-origin list is allowed for any path, still https without userinfo or hash (gate called with an explicit origin list)", () => {
  const extra = ["https://example-download.test"];
  assert.equal(urlAllowed("https://example-download.test/any/path?x=1", [], extra), true);
  assert.equal(urlAllowed("https://example-download.test/a/../b", [], extra), false);
  assert.equal(urlAllowed("https://example-download.test/a%2fb", [], extra), false);
  assert.equal(urlAllowed("http://example-download.test/any", [], extra), false);
  assert.equal(urlAllowed("https://u@example-download.test/any", [], extra), false);
  assert.equal(urlAllowed("https://example-download.test/any#x", [], extra), false);
  assert.equal(urlAllowed("https://example-download.test.evil.test/any", [], extra), false);
  assert.equal(urlAllowed("https://example-download.test/any", [], []), false);
});

test("isAllowedSignInUrl: the three sign-in prefixes with a query; nothing else", () => {
  for (const u of [
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=y",
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x",
    "https://my.pcloud.com/oauth2/authorize?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A48787%2F",
    "https://accounts.google.com/o/oauth2/v2/auth",
  ]) assert.equal(isAllowedSignInUrl(u), true, u);
  for (const u of [
    "https://accounts.google.com/signin",
    "https://accounts.google.com/o/oauth2/v2/",
    "https://accounts.google.com/",
    "http://accounts.google.com/o/oauth2/v2/auth",
    "https://accounts.google.com/o/oauth2/v2/auth#x",
    "https://u@accounts.google.com/o/oauth2/v2/auth",
    "https://accounts.google.com/o/oauth2/v2/auth/../../../signin",
    "https://accounts.google.com/o/oauth2/v2/auth%2f..%2f..%2fsignin",
    "https://accounts.google.com/o/oauth2/v2/auth\\..\\signin",
    "https://accounts.google.com./o/oauth2/v2/auth",
    "https://accounts.google.com:8443/o/oauth2/v2/auth",
    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
    "https://my.pcloud.com/oauth2/token",
    "https://my.pcloud.com/login",
    "https://api.pcloud.com/oauth2/authorize",
    "https://evil.test/https://accounts.google.com/o/oauth2/v2/auth",
    "", "javascript:alert(1)",
  ]) assert.equal(isAllowedSignInUrl(u), false, JSON.stringify(u));
  // A sign-in page is a navigation, never a fetch: the gates do not overlap.
  assert.equal(isAllowedBackupUrl("https://accounts.google.com/o/oauth2/v2/auth?x=1"), false);
  assert.equal(isAllowedBackupUrl("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1"), false);
  assert.equal(isAllowedBackupUrl("https://my.pcloud.com/oauth2/authorize?x=1"), false);
  assert.equal(isAllowedSignInUrl("https://oauth2.googleapis.com/token"), false);
  assert.equal(isAllowedSignInUrl("https://api.pcloud.com/listfolder"), false);
});


// ---------------------------------------------------------------------------------------------------------------------
// WP28 Task 4. Every value below is an obviously fake fixture.
// ---------------------------------------------------------------------------------------------------------------------
const FAKE_IDS = {
  gdrive: "123456789012-fakefakefakefakefakefake.apps.googleusercontent.com",
  onedrive: "00000000-0000-0000-0000-000000000000",
  pcloud: "FAKEFAKE1234",
};
const FULL = readBackupConfig({
  NEXT_PUBLIC_RSL_BACKUP_GDRIVE_CLIENT_ID: FAKE_IDS.gdrive,
  NEXT_PUBLIC_RSL_BACKUP_ONEDRIVE_CLIENT_ID: FAKE_IDS.onedrive,
  NEXT_PUBLIC_RSL_BACKUP_PCLOUD_CLIENT_ID: FAKE_IDS.pcloud,
  NEXT_PUBLIC_RSL_APP_LINK: "1",
});
const EMPTY = readBackupConfig({});
const FAKE_TOKEN = "fake-access-token-0000";
const NOW = Date.UTC(2026, 10, 17, 10, 0, 0);

function memStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    dump: () => JSON.stringify([...m.entries()]),
    has: (k) => m.has(k),
    get: (k) => m.get(k),
  };
}
function recordingHttp(responder) {
  const calls = [];
  const fn = async (r) => {
    calls.push(r);
    return responder(r);
  };
  fn.calls = calls;
  return fn;
}
const tokenOk = (extra = {}) => ({ status: 200, headers: {}, text: JSON.stringify({ access_token: FAKE_TOKEN, expires_in: 3600, ...extra }) });
const b64u = (buf) => Buffer.from(buf).toString("base64url");
async function rejectsCode(p, code) {
  await assert.rejects(p, (e) => e instanceof BackupError && e.code === code, `expected BackupError(${code})`);
}
function throwsCode(fn, code) {
  assert.throws(fn, (e) => e instanceof BackupError && e.code === code, `expected BackupError(${code})`);
}
function fakeShell(kind, impl) {
  const calls = [];
  return { kind, calls, authorize: async (url, o) => { calls.push({ url, o }); return impl(url, o); } };
}
const stateOf = (url) => new URL(url).searchParams.get("state");

test("config: empty by default, invalid IDs become empty", () => {
  assert.deepEqual(readBackupConfig({}), { clientIds: { gdrive: "", onedrive: "", pcloud: "" }, appLink: false });
  // The build constant is whatever the build environment holds, so the test never assumes it is empty.
  const env = process.env;
  assert.deepEqual(BUILD_BACKUP_CONFIG, readBackupConfig({
    NEXT_PUBLIC_RSL_BACKUP_GDRIVE_CLIENT_ID: env.NEXT_PUBLIC_RSL_BACKUP_GDRIVE_CLIENT_ID,
    NEXT_PUBLIC_RSL_BACKUP_ONEDRIVE_CLIENT_ID: env.NEXT_PUBLIC_RSL_BACKUP_ONEDRIVE_CLIENT_ID,
    NEXT_PUBLIC_RSL_BACKUP_PCLOUD_CLIENT_ID: env.NEXT_PUBLIC_RSL_BACKUP_PCLOUD_CLIENT_ID,
    NEXT_PUBLIC_RSL_APP_LINK: env.NEXT_PUBLIC_RSL_APP_LINK,
  }));
  if (env.RSL_BK_NESTED) assert.equal(BUILD_BACKUP_CONFIG.clientIds.pcloud, "FAKEFAKE1234", "the nested run really saw the variable");
  const bad = readBackupConfig({
    NEXT_PUBLIC_RSL_BACKUP_GDRIVE_CLIENT_ID: "x",
    NEXT_PUBLIC_RSL_BACKUP_ONEDRIVE_CLIENT_ID: "00000000-0000-0000-0000-00000000000G",
    NEXT_PUBLIC_RSL_BACKUP_PCLOUD_CLIENT_ID: "has space",
    NEXT_PUBLIC_RSL_APP_LINK: "true",
  });
  assert.deepEqual(bad, { clientIds: { gdrive: "", onedrive: "", pcloud: "" }, appLink: false });
  assert.equal(readBackupConfig({ NEXT_PUBLIC_RSL_BACKUP_ONEDRIVE_CLIENT_ID: "AAAAAAAA-0000-0000-0000-000000000000" }).clientIds.onedrive, "", "GUID must be lower-case");
  assert.equal(readBackupConfig({ NEXT_PUBLIC_RSL_BACKUP_PCLOUD_CLIENT_ID: "abc" }).clientIds.pcloud, "", "pCloud id is 6 to 64 characters");
  assert.deepEqual(FULL, { clientIds: FAKE_IDS, appLink: true });
});

test("constants", () => {
  assert.equal(HOSTED_ORIGIN, UPDATE_ORIGIN);
  assert.equal(WEB_REDIRECT, UPDATE_ORIGIN + "/");
  assert.equal(LOOPBACK_PORT, 48787);
  assert.equal(LOOPBACK_REDIRECT, "http://127.0.0.1:48787/callback");
  assert.equal(APP_LINK_PATH, "/oauth/app/");
  assert.equal(APP_LINK_REDIRECT, UPDATE_ORIGIN + "/oauth/app/");
  assert.deepEqual(PROVIDER_NAMES, { gdrive: "Google Drive", onedrive: "Microsoft OneDrive", pcloud: "pCloud", b2: "Backblaze B2", r2: "Cloudflare R2" });
});

test("availability table", () => {
  const ctx = (shell, config = FULL, origin = HOSTED_ORIGIN, gatewayProviders = []) => ({ shell, config, origin, gatewayProviders });
  // gdrive: desktop app only
  assert.equal(availability("gdrive", ctx("web")), "desktop-only");
  assert.equal(availability("gdrive", ctx("capacitor")), "desktop-only");
  assert.equal(availability("gdrive", ctx("web", EMPTY)), "desktop-only", "shell rule precedes the client-id rule");
  assert.equal(availability("gdrive", ctx("tauri")), "ready");
  assert.equal(availability("gdrive", ctx("tauri", EMPTY)), "not-set-up");
  // onedrive and pcloud
  for (const p of ["onedrive", "pcloud"]) {
    assert.equal(availability(p, ctx("web")), "ready");
    assert.equal(availability(p, ctx("tauri")), "ready");
    assert.equal(availability(p, ctx("capacitor")), "ready", "app link on");
    assert.equal(availability(p, ctx("capacitor", { ...FULL, appLink: false })), "web-desktop-only");
    assert.equal(availability(p, ctx("capacitor", { ...EMPTY, appLink: false })), "web-desktop-only", "shell rule precedes the client-id rule");
    assert.equal(availability(p, ctx("web", EMPTY)), "not-set-up");
    assert.equal(availability(p, ctx("tauri", EMPTY)), "not-set-up");
    assert.equal(availability(p, ctx("capacitor", { ...EMPTY, appLink: true })), "not-set-up");
    assert.equal(availability(p, ctx("web", FULL, "http://127.0.0.1:8770")), "not-here");
    assert.equal(availability(p, ctx("web", EMPTY, "http://127.0.0.1:8770")), "not-set-up", "client-id rule precedes not-here");
    assert.equal(availability(p, ctx("tauri", FULL, "tauri://localhost")), "ready", "origin is only a web rule");
  }
  assert.equal(availability("pcloud", ctx("web", FULL, "http://127.0.0.1:8770")), "not-here");
  // b2 and r2
  for (const p of ["b2", "r2"]) {
    assert.equal(availability(p, ctx("capacitor", FULL, HOSTED_ORIGIN, [p])), "desktop-only");
    assert.equal(availability(p, ctx("tauri")), "needs-gateway");
    assert.equal(availability(p, ctx("tauri", FULL, HOSTED_ORIGIN, [p === "b2" ? "r2" : "b2"])), "needs-gateway");
    assert.equal(availability(p, ctx("tauri", FULL, HOSTED_ORIGIN, [p])), "ready");
    assert.equal(availability(p, ctx("tauri", EMPTY, HOSTED_ORIGIN, [p])), "ready", "no client id involved");
    assert.equal(availability(p, ctx("web", FULL, HOSTED_ORIGIN, [p])), "ready");
  }
});

test("not set up means no network and no navigation", async () => {
  const http = recordingHttp(() => tokenOk());
  const assigned = [];
  const storage = memStorage();
  await rejectsCode(beginWebSignIn("onedrive", EMPTY, { storage, assign: (u) => assigned.push(u), origin: HOSTED_ORIGIN }), "not-set-up");
  assert.equal(assigned.length, 0);
  assert.equal(storage.dump(), "[]", "nothing stored either");
  const shell = fakeShell("loopback", () => LOOPBACK_REDIRECT);
  await rejectsCode(signInShell("gdrive", EMPTY, { shell: "tauri", oauth: shell, http, now: () => NOW }), "not-set-up");
  await rejectsCode(signInShell("pcloud", EMPTY, { shell: "tauri", oauth: shell, http, now: () => NOW }), "not-set-up");
  assert.equal(shell.calls.length, 0);
  assert.equal(http.calls.length, 0);
  // completing a callback for an unset provider makes no request either
  await rejectsCode(completeWebSignIn({ provider: "onedrive", result: { kind: "code", code: "fake-code" }, verifier: "v".repeat(43) }, EMPTY, http, NOW), "not-set-up");
  assert.equal(http.calls.length, 0);
  assert.equal(getSession("onedrive"), null);
});

test("other unavailable states are refused before any request, with a matching code", async () => {
  const http = recordingHttp(() => tokenOk());
  const shell = fakeShell("loopback", () => LOOPBACK_REDIRECT);
  await rejectsCode(signInShell("gdrive", FULL, { shell: "capacitor", oauth: fakeShell("applink", () => ""), http, now: () => NOW }), "unavailable");
  await rejectsCode(signInShell("onedrive", { ...FULL, appLink: false }, { shell: "capacitor", oauth: fakeShell("applink", () => ""), http, now: () => NOW }), "unavailable");
  // a loopback broker cannot serve the phone, an app-link broker cannot serve the desktop
  await rejectsCode(signInShell("onedrive", FULL, { shell: "capacitor", oauth: shell, http, now: () => NOW }), "unavailable");
  await rejectsCode(signInShell("onedrive", FULL, { shell: "tauri", oauth: fakeShell("applink", () => ""), http, now: () => NOW }), "unavailable");
  await rejectsCode(beginWebSignIn("gdrive", FULL, { storage: memStorage(), assign: () => assert.fail("navigated"), origin: HOSTED_ORIGIN }), "unavailable");
  await rejectsCode(beginWebSignIn("pcloud", FULL, { storage: memStorage(), assign: () => assert.fail("navigated"), origin: "http://127.0.0.1:8770" }), "unavailable");
  assert.equal(http.calls.length, 0);
});

test("PKCE: a 43-character base64url verifier, S256 challenge, never repeated", async () => {
  const a = await createPkce();
  const b = await createPkce();
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(a.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a.challenge, createHash("sha256").update(a.verifier).digest("base64url"));
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(a.challenge, b.challenge);
  const s = randomState();
  assert.match(s, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(s, randomState());
});

test("PKCE and state use crypto.getRandomValues", async () => {
  const real = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  let used = 0;
  Object.defineProperty(globalThis.crypto, "getRandomValues", { configurable: true, value: (a) => { used++; return real(a); } });
  try {
    await createPkce();
    randomState();
  } finally {
    Object.defineProperty(globalThis.crypto, "getRandomValues", { configurable: true, value: real });
  }
  assert.equal(used, 2);
});

test("auth URLs: exact parameters per provider", () => {
  const g = authUrl("gdrive", { clientId: FAKE_IDS.gdrive, redirectUri: LOOPBACK_REDIRECT, state: "st_1", challenge: "ch_1" });
  assert.ok(g.startsWith("https://accounts.google.com/o/oauth2/v2/auth?"));
  assert.deepEqual(Object.fromEntries(new URL(g).searchParams), {
    client_id: FAKE_IDS.gdrive, redirect_uri: LOOPBACK_REDIRECT, response_type: "code",
    scope: "https://www.googleapis.com/auth/drive.appdata", code_challenge: "ch_1", code_challenge_method: "S256", state: "st_1",
  });
  const o = authUrl("onedrive", { clientId: FAKE_IDS.onedrive, redirectUri: WEB_REDIRECT, state: "st_2", challenge: "ch_2" });
  assert.ok(o.startsWith("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?"));
  assert.deepEqual(Object.fromEntries(new URL(o).searchParams), {
    client_id: FAKE_IDS.onedrive, response_type: "code", redirect_uri: WEB_REDIRECT, response_mode: "query",
    scope: "Files.ReadWrite.AppFolder", code_challenge: "ch_2", code_challenge_method: "S256", state: "st_2",
  });
  assert.ok(!/offline_access/.test(o), "no refresh token");
  const p = authUrl("pcloud", { clientId: FAKE_IDS.pcloud, redirectUri: APP_LINK_REDIRECT, state: "st_3" });
  assert.ok(p.startsWith("https://my.pcloud.com/oauth2/authorize?"));
  assert.deepEqual(Object.fromEntries(new URL(p).searchParams), { client_id: FAKE_IDS.pcloud, response_type: "token", redirect_uri: APP_LINK_REDIRECT, state: "st_3" });
  for (const u of [g, o, p]) assert.ok(isAllowedSignInUrl(u), u);
  // values are URL-encoded, not pasted
  assert.ok(g.includes("redirect_uri=http%3A%2F%2F127.0.0.1%3A48787%2Fcallback"));
  assert.ok(!authUrl("pcloud", { clientId: "a&b=c", redirectUri: WEB_REDIRECT, state: "s s" }).includes("a&b=c"));
  // PKCE is not optional for the code flows
  throwsCode(() => authUrl("gdrive", { clientId: FAKE_IDS.gdrive, redirectUri: LOOPBACK_REDIRECT, state: "s" }), "sign-in");
});

test("token exchange sends no client_secret and follows the expiry rule", async () => {
  for (const [prov, url, redirect, extra] of [
    ["gdrive", "https://oauth2.googleapis.com/token", LOOPBACK_REDIRECT, []],
    ["onedrive", "https://login.microsoftonline.com/common/oauth2/v2.0/token", WEB_REDIRECT, ["scope"]],
  ]) {
    const http = recordingHttp(() => tokenOk({ refresh_token: "fake-refresh-token", expires_in: 3600 }));
    const v = "v".repeat(43);
    const s = await exchangeCode(prov, { clientId: FAKE_IDS[prov], code: "fake-code", verifier: v, redirectUri: redirect }, http, NOW);
    assert.deepEqual(s, { token: FAKE_TOKEN, expiresAt: NOW + (3600 - 60) * 1000 });
    assert.equal(http.calls.length, 1);
    const r = http.calls[0];
    assert.equal(r.method, "POST");
    assert.equal(r.url, url);
    assert.equal(r.headers["content-type"], "application/x-www-form-urlencoded");
    const body = new URLSearchParams(r.body);
    assert.deepEqual([...body.keys()].sort(), ["client_id", "code", "code_verifier", "grant_type", "redirect_uri", ...extra].sort());
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code_verifier"), v);
    assert.equal(body.get("redirect_uri"), redirect);
    assert.equal(body.get("code"), "fake-code");
    if (prov === "onedrive") assert.equal(body.get("scope"), "Files.ReadWrite.AppFolder");
    assert.ok(!/secret/i.test(r.body));
    assert.ok(isAllowedBackupUrl(r.url));
    assert.ok(!JSON.stringify(s).includes("refresh"), "a refresh token is never kept");
  }
});

test("token response is validated", async () => {
  const args = { clientId: FAKE_IDS.gdrive, code: "fake-code", verifier: "v".repeat(43), redirectUri: LOOPBACK_REDIRECT };
  const respond = (body, status = 200) => recordingHttp(() => ({ status, headers: {}, text: typeof body === "string" ? body : JSON.stringify(body) }));
  for (const bad of [
    "not json", "[]", "null", {}, { access_token: FAKE_TOKEN }, { expires_in: 3600 },
    { access_token: "", expires_in: 3600 }, { access_token: "has space", expires_in: 3600 }, { access_token: "tok\nen", expires_in: 3600 },
    { access_token: "a".repeat(4097), expires_in: 3600 }, { access_token: 5, expires_in: 3600 },
    { access_token: FAKE_TOKEN, expires_in: 59 }, { access_token: FAKE_TOKEN, expires_in: 86401 },
    { access_token: FAKE_TOKEN, expires_in: "3600" }, { access_token: FAKE_TOKEN, expires_in: 3600.5 },
  ]) await rejectsCode(exchangeCode("gdrive", args, respond(bad), NOW), "sign-in");
  const edge = await exchangeCode("gdrive", args, respond({ access_token: "a".repeat(4096), expires_in: 60 }), NOW);
  assert.equal(edge.expiresAt, NOW);
  const edge2 = await exchangeCode("gdrive", args, respond({ access_token: FAKE_TOKEN, expires_in: 86400 }), NOW);
  assert.equal(edge2.expiresAt, NOW + (86400 - 60) * 1000);
  // bad inputs never reach the network
  const http = recordingHttp(() => tokenOk());
  await rejectsCode(exchangeCode("gdrive", { ...args, redirectUri: "https://evil.example/" }, http, NOW), "sign-in");
  await rejectsCode(exchangeCode("gdrive", { ...args, verifier: "short" }, http, NOW), "sign-in");
  await rejectsCode(exchangeCode("gdrive", { ...args, code: "has space" }, http, NOW), "sign-in");
  await rejectsCode(exchangeCode("pcloud", args, http, NOW), "unavailable");
  assert.equal(http.calls.length, 0);
});

test("upstream error text never reaches the error", async () => {
  const args = { clientId: FAKE_IDS.gdrive, code: "fake-code", verifier: "v".repeat(43), redirectUri: LOOPBACK_REDIRECT };
  const http = recordingHttp(() => ({ status: 400, headers: {}, text: '{"error_description":"secret-text"}' }));
  try {
    await exchangeCode("gdrive", args, http, NOW);
    assert.fail("should reject");
  } catch (e) {
    assert.ok(e instanceof BackupError);
    assert.equal(e.code, "sign-in");
    assert.deepEqual(e.detail, { status: 400 });
    assert.ok(!String(e.message).includes("secret-text"));
    assert.ok(!JSON.stringify(e).includes("secret-text"));
    assert.ok(!(e.stack || "").includes("secret-text"));
  }
  // a thrown non-BackupError from the transport becomes "network" and its message is dropped
  const boom = recordingHttp(() => { throw new Error("secret-text"); });
  try {
    await exchangeCode("gdrive", args, boom, NOW);
    assert.fail("should reject");
  } catch (e) {
    assert.ok(e instanceof BackupError && e.code === "network");
    assert.ok(!JSON.stringify(e).includes("secret-text") && !String(e.message).includes("secret-text"));
  }
});

test("callback parsing: exact redirect, state, provider errors", () => {
  const o = (extra = {}) => ({ provider: "gdrive", redirectUri: LOOPBACK_REDIRECT, state: "s", ...extra });
  assert.deepEqual(parseCallback(LOOPBACK_REDIRECT + "?code=c&state=s", o()), { kind: "code", code: "c" });
  assert.deepEqual(parseCallback(WEB_REDIRECT + "?state=s&code=c#", o({ provider: "onedrive", redirectUri: WEB_REDIRECT })).kind, "code");
  throwsCode(() => parseCallback(LOOPBACK_REDIRECT + "?code=c&state=other", o()), "state");
  throwsCode(() => parseCallback(LOOPBACK_REDIRECT + "?code=c", o()), "state");
  throwsCode(() => parseCallback(LOOPBACK_REDIRECT + "?code=c&state=", o()), "state");
  throwsCode(() => parseCallback(LOOPBACK_REDIRECT + "?code=c&state=s&state=s", o()), "state"); // duplicated
  throwsCode(() => parseCallback(LOOPBACK_REDIRECT + "?error=access_denied&state=s", o()), "sign-in");
  throwsCode(() => parseCallback(LOOPBACK_REDIRECT + "?error=access_denied&error_description=secret-text&state=s", o()), "sign-in");
  throwsCode(() => parseCallback(LOOPBACK_REDIRECT + "?state=s", o()), "sign-in"); // no code
  throwsCode(() => parseCallback(LOOPBACK_REDIRECT + "?code=&state=s", o()), "sign-in");
  throwsCode(() => parseCallback(LOOPBACK_REDIRECT + "?code=c&code=d&state=s", o()), "sign-in");
  throwsCode(() => parseCallback(LOOPBACK_REDIRECT + "?code=" + "a".repeat(4097) + "&state=s", o()), "sign-in");
  assert.equal(parseCallback(LOOPBACK_REDIRECT + "?code=" + "a".repeat(4096) + "&state=s", o()).kind, "code");
  throwsCode(() => parseCallback(LOOPBACK_REDIRECT + "?code=a%20b&state=s", o()), "sign-in"); // decoded space is not printable-token
  throwsCode(() => parseCallback(LOOPBACK_REDIRECT + "?code=a%0Ab&state=s", o()), "sign-in");
  throwsCode(() => parseCallback(LOOPBACK_REDIRECT + "?code=%C3%A9&state=s", o()), "sign-in");
  // the redirect URI is matched exactly, not by prefix
  for (const bad of [
    "http://127.0.0.1:48787/callbackX?code=c&state=s", "http://127.0.0.1:48787/callback/x?code=c&state=s",
    "http://127.0.0.1:48788/callback?code=c&state=s", "http://127.0.0.1:48787/?code=c&state=s",
    "https://evil.example/?code=c&state=s", "http://127.0.0.1:48787/callback@evil.example?code=c&state=s",
    "HTTP://127.0.0.1:48787/callback?code=c&state=s", "", "not a url",
  ]) throwsCode(() => parseCallback(bad, o()), "sign-in");
  throwsCode(() => parseCallback(WEB_REDIRECT + "evil?code=c&state=s", o({ provider: "onedrive", redirectUri: WEB_REDIRECT })), "sign-in");
  throwsCode(() => parseCallback(WEB_REDIRECT + "?code=c&state=s", o({ provider: "onedrive", redirectUri: WEB_REDIRECT + "x" })), "sign-in");
});

test("pcloud callback: token in the fragment, region host only from the allowlist", () => {
  const o = { provider: "pcloud", redirectUri: WEB_REDIRECT, state: "s" };
  assert.deepEqual(parseCallback(WEB_REDIRECT + "#access_token=t0k&token_type=bearer&uid=1&state=s&hostname=eapi.pcloud.com", o), { kind: "token", token: "t0k", apiHost: "eapi.pcloud.com" });
  assert.deepEqual(parseCallback(WEB_REDIRECT + "#access_token=t0k&state=s&hostname=api.pcloud.com", o), { kind: "token", token: "t0k", apiHost: "api.pcloud.com" });
  for (const host of ["evil.example", "api.pcloud.com.evil.example", "API.PCLOUD.COM", "api.pcloud.com:443", "eapi.pcloud.com/", "", "pcloud.com"]) {
    throwsCode(() => parseCallback(WEB_REDIRECT + "#access_token=t0k&state=s&hostname=" + encodeURIComponent(host), o), "sign-in");
  }
  throwsCode(() => parseCallback(WEB_REDIRECT + "#access_token=t0k&state=s", o), "sign-in"); // no hostname
  throwsCode(() => parseCallback(WEB_REDIRECT + "#access_token=t0k&hostname=api.pcloud.com", o), "state");
  throwsCode(() => parseCallback(WEB_REDIRECT + "#access_token=t0k&state=zzz&hostname=api.pcloud.com", o), "state");
  throwsCode(() => parseCallback(WEB_REDIRECT + "#state=s&hostname=api.pcloud.com", o), "sign-in"); // no token
  throwsCode(() => parseCallback(WEB_REDIRECT + "#access_token=" + "a".repeat(4097) + "&state=s&hostname=api.pcloud.com", o), "sign-in");
  throwsCode(() => parseCallback(WEB_REDIRECT + "#error=access_denied&state=s", o), "sign-in");
  throwsCode(() => parseCallback(WEB_REDIRECT + "?error=access_denied&state=s", o), "sign-in");
  // a code is not a token: the pcloud flow takes only the fragment
  throwsCode(() => parseCallback(WEB_REDIRECT + "?code=c&state=s", o), "state");
  // the token flow's fragment does not feed a code flow
  throwsCode(() => parseCallback(WEB_REDIRECT + "#access_token=t0k&state=s&hostname=api.pcloud.com", { ...o, provider: "onedrive" }), "state");
});

test("web sign-in: pending entry, allowed sign-in URL, a verifier only for code flows", async () => {
  const storage = memStorage();
  const assigned = [];
  const deps = { storage, assign: (u) => assigned.push(u), origin: HOSTED_ORIGIN };
  await beginWebSignIn("onedrive", FULL, deps);
  assert.equal(PENDING_KEY, "rsl-bk-oauth-v1");
  assert.equal(assigned.length, 1);
  assert.ok(isAllowedSignInUrl(assigned[0]));
  const q = new URL(assigned[0]).searchParams;
  assert.equal(q.get("redirect_uri"), WEB_REDIRECT);
  assert.equal(q.get("client_id"), FAKE_IDS.onedrive);
  const pending = JSON.parse(storage.get(PENDING_KEY));
  assert.deepEqual(Object.keys(pending).sort(), ["p", "s", "t", "v"]);
  assert.equal(pending.p, "onedrive");
  assert.equal(pending.s, q.get("state"));
  assert.match(pending.v, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(q.get("code_challenge"), createHash("sha256").update(pending.v).digest("base64url"));
  assert.equal(typeof pending.t, "number");
  assert.ok(!assigned[0].includes(pending.v), "the verifier never appears in a URL");
  // pCloud: no verifier at all
  await beginWebSignIn("pcloud", FULL, deps);
  const pc = JSON.parse(storage.get(PENDING_KEY));
  assert.deepEqual(Object.keys(pc).sort(), ["p", "s", "t"]);
  assert.equal(pc.p, "pcloud");
  assert.equal(new URL(assigned[1]).searchParams.get("response_type"), "token");
  // state is fresh per sign-in
  assert.notEqual(pending.s, pc.s);
  // storage that cannot be written stops the flow before navigation
  const before = assigned.length;
  await rejectsCode(beginWebSignIn("onedrive", FULL, { ...deps, storage: { setItem: () => { throw new Error("quota"); } } }), "unavailable");
  assert.equal(assigned.length, before);
});

test("web callback: right state resolves and clears the entry; replay, stale and app-link paths are foreign", async () => {
  const storage = memStorage();
  const assigned = [];
  await beginWebSignIn("onedrive", FULL, { storage, assign: (u) => assigned.push(u), origin: HOSTED_ORIGIN });
  const pending = JSON.parse(storage.get(PENDING_KEY));
  const href = WEB_REDIRECT + "?code=fake-code&state=" + pending.s;
  const t = JSON.parse(storage.get(PENDING_KEY)).t;
  const r = consumeWebCallback(href, { storage, now: t + 1000 });
  assert.deepEqual(r, { provider: "onedrive", result: { kind: "code", code: "fake-code" }, verifier: pending.v });
  assert.equal(storage.has(PENDING_KEY), false, "removed");
  // replay with the same URL
  assert.deepEqual(consumeWebCallback(href, { storage, now: t + 2000 }), { foreign: true });
  // an 11-minute-old entry
  await beginWebSignIn("onedrive", FULL, { storage, assign: () => {}, origin: HOSTED_ORIGIN });
  const p2 = JSON.parse(storage.get(PENDING_KEY));
  assert.deepEqual(consumeWebCallback(WEB_REDIRECT + "?code=c&state=" + p2.s, { storage, now: p2.t + 11 * 60 * 1000 }), { foreign: true });
  assert.equal(storage.has(PENDING_KEY), false);
  // exactly 10 minutes is still fresh
  await beginWebSignIn("onedrive", FULL, { storage, assign: () => {}, origin: HOSTED_ORIGIN });
  const p3 = JSON.parse(storage.get(PENDING_KEY));
  assert.equal(consumeWebCallback(WEB_REDIRECT + "?code=c&state=" + p3.s, { storage, now: p3.t + 10 * 60 * 1000 }).provider, "onedrive");
  // app-link path, even with a pending entry: foreign, and the entry is removed first
  await beginWebSignIn("onedrive", FULL, { storage, assign: () => {}, origin: HOSTED_ORIGIN });
  const p4 = JSON.parse(storage.get(PENDING_KEY));
  assert.deepEqual(consumeWebCallback(UPDATE_ORIGIN + APP_LINK_PATH + "?code=c&state=" + p4.s, { storage, now: p4.t }), { foreign: true });
  assert.equal(storage.has(PENDING_KEY), false);
  assert.deepEqual(consumeWebCallback(UPDATE_ORIGIN + APP_LINK_PATH, { storage, now: NOW }), { foreign: true }, "the path alone is enough");
  // no callback parameters at all
  assert.equal(consumeWebCallback(WEB_REDIRECT, { storage, now: NOW }), null);
  assert.equal(consumeWebCallback(WEB_REDIRECT + "?tab=about#top", { storage, now: NOW }), null);
  assert.equal(consumeWebCallback("not a url", { storage, now: NOW }), null);
  // a null return does not touch a pending entry that is still waiting
  await beginWebSignIn("onedrive", FULL, { storage, assign: () => {}, origin: HOSTED_ORIGIN });
  assert.equal(consumeWebCallback(WEB_REDIRECT, { storage, now: JSON.parse(storage.get(PENDING_KEY)).t }), null);
  assert.equal(storage.has(PENDING_KEY), true);
  // corrupt storage is just "no entry"
  const bad = memStorage({ [PENDING_KEY]: "{not json" });
  assert.deepEqual(consumeWebCallback(WEB_REDIRECT + "?code=c&state=s", { storage: bad, now: NOW }), { foreign: true });
  assert.equal(bad.has(PENDING_KEY), false);
  const odd = memStorage({ [PENDING_KEY]: JSON.stringify({ p: "b2", s: "s", t: NOW }) });
  assert.deepEqual(consumeWebCallback(WEB_REDIRECT + "?code=c&state=s", { storage: odd, now: NOW }), { foreign: true });
});

test("web callback: a wrong state throws and still clears the entry; pCloud returns its token", async () => {
  const storage = memStorage();
  await beginWebSignIn("onedrive", FULL, { storage, assign: () => {}, origin: HOSTED_ORIGIN });
  const t = JSON.parse(storage.get(PENDING_KEY)).t;
  assert.throws(() => consumeWebCallback(WEB_REDIRECT + "?code=c&state=forged", { storage, now: t }), (e) => e instanceof BackupError && e.code === "state");
  assert.equal(storage.has(PENDING_KEY), false);
  await beginWebSignIn("pcloud", FULL, { storage, assign: () => {}, origin: HOSTED_ORIGIN });
  const pc = JSON.parse(storage.get(PENDING_KEY));
  const r = consumeWebCallback(WEB_REDIRECT + "#access_token=t0k&state=" + pc.s + "&hostname=api.pcloud.com", { storage, now: pc.t });
  assert.deepEqual(r, { provider: "pcloud", result: { kind: "token", token: "t0k", apiHost: "api.pcloud.com" }, verifier: undefined });
  // provider error: sign-in, entry cleared
  await beginWebSignIn("onedrive", FULL, { storage, assign: () => {}, origin: HOSTED_ORIGIN });
  const p5 = JSON.parse(storage.get(PENDING_KEY));
  assert.throws(() => consumeWebCallback(WEB_REDIRECT + "?error=access_denied&state=" + p5.s, { storage, now: p5.t }), (e) => e instanceof BackupError && e.code === "sign-in");
  assert.equal(storage.has(PENDING_KEY), false);
});

test("completeWebSignIn: exchanges the code, or accepts the pCloud token, into memory only", async () => {
  clearAllSessions();
  const http = recordingHttp(() => tokenOk());
  await completeWebSignIn({ provider: "onedrive", result: { kind: "code", code: "fake-code" }, verifier: "v".repeat(43) }, FULL, http, NOW);
  assert.deepEqual(getSession("onedrive", NOW), { token: FAKE_TOKEN, expiresAt: NOW + 3540 * 1000 });
  assert.equal(http.calls.length, 1);
  assert.equal(new URLSearchParams(http.calls[0].body).get("redirect_uri"), WEB_REDIRECT);
  assert.equal(new URLSearchParams(http.calls[0].body).get("client_id"), FAKE_IDS.onedrive);
  await completeWebSignIn({ provider: "pcloud", result: { kind: "token", token: "pc-fake-token", apiHost: "eapi.pcloud.com" } }, FULL, http, NOW);
  assert.deepEqual(getSession("pcloud", NOW), { token: "pc-fake-token", expiresAt: null, apiHost: "eapi.pcloud.com" });
  assert.equal(http.calls.length, 1, "the pCloud token flow makes no request");
  // a code without its verifier, or a result of the wrong kind, never reaches the network
  clearAllSessions();
  await rejectsCode(completeWebSignIn({ provider: "onedrive", result: { kind: "code", code: "fake-code" } }, FULL, http, NOW), "sign-in");
  await rejectsCode(completeWebSignIn({ provider: "onedrive", result: { kind: "token", token: "t", apiHost: "api.pcloud.com" }, verifier: "v".repeat(43) }, FULL, http, NOW), "sign-in");
  await rejectsCode(completeWebSignIn({ provider: "pcloud", result: { kind: "code", code: "c" } }, FULL, http, NOW), "sign-in");
  assert.equal(http.calls.length, 1);
  assert.equal(getSession("onedrive"), null);
  clearAllSessions();
});

test("tokens stay in memory: no storage, no URL, no error holds a token", async () => {
  clearAllSessions();
  const seen = [];
  const mk = () => {
    const m = new Map();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, String(v)); seen.push(String(v)); }, removeItem: (k) => m.delete(k), dump: () => JSON.stringify([...m]) };
  };
  const local = mk();
  const sess = mk();
  globalThis.localStorage = local;
  globalThis.sessionStorage = sess;
  try {
    const http = recordingHttp(() => tokenOk());
    await beginWebSignIn("onedrive", FULL, { storage: sess, assign: () => {}, origin: HOSTED_ORIGIN });
    const p = JSON.parse(sess.getItem(PENDING_KEY));
    const r = consumeWebCallback(WEB_REDIRECT + "?code=fake-code&state=" + p.s, { storage: sess, now: p.t });
    await completeWebSignIn(r, FULL, http, NOW);
    assert.equal(getSession("onedrive", NOW).token, FAKE_TOKEN);
    await beginWebSignIn("pcloud", FULL, { storage: sess, assign: () => {}, origin: HOSTED_ORIGIN });
    const q = JSON.parse(sess.getItem(PENDING_KEY));
    const r2 = consumeWebCallback(WEB_REDIRECT + "#access_token=pc-fake-token&state=" + q.s + "&hostname=api.pcloud.com", { storage: sess, now: q.t });
    await completeWebSignIn(r2, FULL, http, NOW);
    for (const t of [FAKE_TOKEN, "pc-fake-token"]) {
      assert.ok(!local.dump().includes(t), "localStorage");
      assert.ok(!sess.dump().includes(t), "sessionStorage");
      assert.ok(!seen.some((v) => v.includes(t)), "no write anywhere");
    }
    assert.equal(sess.dump(), "[]", "the pending entry is gone");
  } finally {
    delete globalThis.localStorage;
    delete globalThis.sessionStorage;
    clearAllSessions();
  }
});

test("shell sign-in: loopback for the desktop, app link for the phone", async () => {
  clearAllSessions();
  const http = recordingHttp(() => tokenOk());
  const shell = fakeShell("loopback", (url) => LOOPBACK_REDIRECT + "?code=fake-code&state=" + stateOf(url));
  await signInShell("gdrive", FULL, { shell: "tauri", oauth: shell, http, now: () => NOW });
  assert.equal(shell.calls.length, 1);
  const { url, o } = shell.calls[0];
  assert.ok(isAllowedSignInUrl(url));
  assert.deepEqual({ ...o }, { redirectUri: LOOPBACK_REDIRECT, relayFragment: false, timeoutMs: 5 * 60 * 1000, signal: undefined });
  assert.equal(new URL(url).searchParams.get("redirect_uri"), LOOPBACK_REDIRECT);
  assert.deepEqual(getSession("gdrive", NOW), { token: FAKE_TOKEN, expiresAt: NOW + 3540 * 1000 });
  const body = new URLSearchParams(http.calls[0].body);
  assert.equal(body.get("code_verifier").length, 43);
  assert.equal(new URL(url).searchParams.get("code_challenge"), createHash("sha256").update(body.get("code_verifier")).digest("base64url"));
  assert.equal(body.get("redirect_uri"), LOOPBACK_REDIRECT);
  // phone: pCloud via the app link, fragment relayed
  const ctl = new AbortController();
  const phone = fakeShell("applink", (u) => APP_LINK_REDIRECT + "#access_token=pc-fake-token&state=" + stateOf(u) + "&hostname=eapi.pcloud.com");
  await signInShell("pcloud", FULL, { shell: "capacitor", oauth: phone, http, now: () => NOW, signal: ctl.signal });
  assert.equal(phone.calls[0].o.redirectUri, APP_LINK_REDIRECT);
  assert.equal(phone.calls[0].o.relayFragment, true);
  assert.equal(phone.calls[0].o.signal, ctl.signal);
  assert.deepEqual(getSession("pcloud", NOW), { token: "pc-fake-token", expiresAt: null, apiHost: "eapi.pcloud.com" });
  assert.equal(http.calls.length, 1, "pCloud's token flow makes no request");
  // each sign-in uses its own state
  const states = [];
  const rec = fakeShell("loopback", (u) => { states.push(stateOf(u)); return LOOPBACK_REDIRECT + "?code=c&state=" + stateOf(u); });
  await signInShell("onedrive", FULL, { shell: "tauri", oauth: rec, http, now: () => NOW });
  await signInShell("onedrive", FULL, { shell: "tauri", oauth: rec, http, now: () => NOW });
  assert.notEqual(states[0], states[1]);
  clearAllSessions();
});

test("shell sign-in: broker failures map to their codes and leave no session", async () => {
  clearAllSessions();
  const http = recordingHttp(() => tokenOk());
  for (const msg of ["port-busy", "timeout", "cancelled"]) {
    const shell = fakeShell("loopback", () => { throw new Error(msg); });
    await rejectsCode(signInShell("gdrive", FULL, { shell: "tauri", oauth: shell, http, now: () => NOW }), msg);
    assert.equal(getSession("gdrive", NOW), null);
  }
  const weird = fakeShell("loopback", () => { throw new Error("secret-text"); });
  try {
    await signInShell("gdrive", FULL, { shell: "tauri", oauth: weird, http, now: () => NOW });
    assert.fail("should reject");
  } catch (e) {
    assert.ok(e instanceof BackupError);
    assert.ok(!JSON.stringify(e).includes("secret-text") && !e.message.includes("secret-text"));
  }
  // a forged or wrong-state redirect is refused and nothing is exchanged
  const forged = fakeShell("loopback", () => LOOPBACK_REDIRECT + "?code=fake-code&state=forged");
  await rejectsCode(signInShell("gdrive", FULL, { shell: "tauri", oauth: forged, http, now: () => NOW }), "state");
  const foreign = fakeShell("loopback", () => "https://evil.example/?code=fake-code&state=x");
  await rejectsCode(signInShell("gdrive", FULL, { shell: "tauri", oauth: foreign, http, now: () => NOW }), "sign-in");
  assert.equal(http.calls.length, 0);
  assert.equal(getSession("gdrive", NOW), null);
  // an already-aborted signal never opens a browser
  const ctl = new AbortController();
  ctl.abort();
  const never = fakeShell("loopback", () => assert.fail("opened"));
  await rejectsCode(signInShell("gdrive", FULL, { shell: "tauri", oauth: never, http, now: () => NOW, signal: ctl.signal }), "cancelled");
  assert.equal(never.calls.length, 0);
});

test("sessions: memory only, expiry clears", () => {
  clearAllSessions();
  assert.equal(getSession("gdrive"), null);
  setSession("gdrive", { token: FAKE_TOKEN, expiresAt: NOW + 1000 });
  assert.equal(getSession("gdrive", NOW).token, FAKE_TOKEN);
  assert.equal(getSession("gdrive", NOW + 999) !== null, true);
  assert.equal(getSession("gdrive", NOW + 1000), null, "expired");
  assert.equal(getSession("gdrive", NOW), null, "and stays cleared");
  setSession("pcloud", { token: "pc-fake-token", expiresAt: null, apiHost: "api.pcloud.com" });
  assert.equal(getSession("pcloud", NOW + 10 ** 12).token, "pc-fake-token", "no expiry");
  const copy = getSession("pcloud");
  copy.token = "changed";
  assert.equal(getSession("pcloud").token, "pc-fake-token", "callers get a copy");
  setSession("onedrive", { token: FAKE_TOKEN, expiresAt: null });
  clearSession("pcloud");
  assert.equal(getSession("pcloud"), null);
  assert.notEqual(getSession("onedrive"), null);
  clearAllSessions();
  assert.equal(getSession("onedrive"), null);
});

function withFetch(impl, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init);
  };
  return Promise.resolve(fn(calls)).finally(() => { globalThis.fetch = real; });
}
const GOOD_URL = "https://graph.microsoft.com/v1.0/me/drive/special/approot:/x.json:/content";

test("webBackupHttp: no credentials, no redirects, lower-cased headers, refuses oversize before reading", async () => {
  await withFetch(
    () => new Response("hello", { status: 200, headers: { "Content-Type": "text/plain", "X-Fake": "1" } }),
    async (calls) => {
      const r = await webBackupHttp({ method: "PUT", url: GOOD_URL, headers: { authorization: "Bearer fake" }, body: "b" });
      assert.deepEqual(r, { status: 200, headers: { "content-type": "text/plain", "x-fake": "1" }, text: "hello" });
      const init = calls[0].init;
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "error");
      assert.equal(init.cache, "no-store");
      assert.equal(init.referrerPolicy, "no-referrer");
      assert.equal(init.method, "PUT");
      assert.equal(init.body, "b");
    },
  );
  const MAX = 20 * 1024 * 1024;
  let read = false;
  await withFetch(
    () => ({ status: 200, headers: new Headers({ "content-length": String(MAX + 1) }), text: async () => { read = true; return ""; } }),
    async () => {
      await rejectsCode(webBackupHttp({ method: "GET", url: GOOD_URL }), "too-large-file");
      assert.equal(read, false, "the body was not read");
    },
  );
  await withFetch(
    () => ({ status: 200, headers: new Headers({ "content-length": String(MAX) }), text: async () => "x" }),
    async () => assert.equal((await webBackupHttp({ method: "GET", url: GOOD_URL })).text, "x"),
  );
  await withFetch(
    () => ({ status: 200, headers: new Headers(), text: async () => "x".repeat(MAX + 1) }),
    async () => rejectsCode(webBackupHttp({ method: "GET", url: GOOD_URL }), "too-large-file"),
  );
  // a multi-byte text over the limit in bytes is refused too
  await withFetch(
    () => ({ status: 200, headers: new Headers(), text: async () => "é".repeat(MAX / 2 + 1) }),
    async () => rejectsCode(webBackupHttp({ method: "GET", url: GOOD_URL }), "too-large-file"),
  );
});

test("webBackupHttp: failures become BackupError without the original message; URLs are gated", async () => {
  await withFetch(() => { throw new TypeError("secret-text failed to fetch"); }, async () => {
    try {
      await webBackupHttp({ method: "GET", url: GOOD_URL });
      assert.fail("should reject");
    } catch (e) {
      assert.ok(e instanceof BackupError && e.code === "network");
      assert.ok(!JSON.stringify(e).includes("secret-text") && !e.message.includes("secret-text"));
    }
  });
  const ctl = new AbortController();
  ctl.abort();
  await withFetch(() => { throw new DOMException("aborted", "AbortError"); }, async () => {
    await rejectsCode(webBackupHttp({ method: "GET", url: GOOD_URL, signal: ctl.signal }), "cancelled");
  });
  await withFetch(() => new Response("x"), async (calls) => {
    for (const u of [
      "http://graph.microsoft.com/v1.0/me/drive/special/approot", "https://evil.example/v1.0/me/drive/special/approot",
      "https://graph.microsoft.com/v1.0/me/drive/special/approot#x", "https://user@graph.microsoft.com/v1.0/me/drive/special/approot",
      "https://graph.microsoft.com/v1.0/me/drive/special/approot/../../x", "https://graph.microsoft.com/v1.0/me/messages",
    ]) await rejectsCode(webBackupHttp({ method: "GET", url: u }), "unavailable");
    assert.equal(calls.length, 0, "no request left the app");
  });
});

test("backupHttp: web by default; the native function is wrapped and gated", async () => {
  setBackupNativeRequest(null);
  assert.equal(backupHttp(), webBackupHttp);
  const seen = [];
  setBackupNativeRequest(async (r) => { seen.push(r.url); return { status: 200, headers: {}, text: "ok" }; });
  try {
    const h = backupHttp();
    assert.notEqual(h, webBackupHttp);
    assert.equal((await h({ method: "GET", url: GOOD_URL })).text, "ok");
    assert.deepEqual(seen, [GOOD_URL]);
    await rejectsCode(h({ method: "GET", url: "https://evil.example/x" }), "unavailable");
    assert.equal(seen.length, 1, "a disallowed URL never reaches the native function");
    setBackupNativeRequest(async () => { throw new Error("too-large-file"); });
    await rejectsCode(backupHttp()({ method: "GET", url: GOOD_URL }), "too-large-file");
    setBackupNativeRequest(async () => { throw new Error("secret-text"); });
    try {
      await backupHttp()({ method: "GET", url: GOOD_URL });
      assert.fail("should reject");
    } catch (e) {
      assert.ok(e instanceof BackupError && e.code === "network");
      assert.ok(!JSON.stringify(e).includes("secret-text") && !e.message.includes("secret-text"));
    }
    setBackupNativeRequest(async () => ({ status: 200, headers: {}, text: "x".repeat(20 * 1024 * 1024 + 1) }));
    await rejectsCode(backupHttp()({ method: "GET", url: GOOD_URL }), "too-large-file");
  } finally {
    setBackupNativeRequest(null);
  }
  assert.equal(backupHttp(), webBackupHttp);
});

test("shell broker slot", () => {
  assert.equal(shellOAuth(), null);
  const o = fakeShell("loopback", () => "");
  setShellOAuth(o);
  assert.equal(shellOAuth(), o);
  setShellOAuth(null);
  assert.equal(shellOAuth(), null);
});

test("the suite passes with a client-ID variable set in the environment (the gate stays green once the owner configures one)", () => {
  if (process.env.RSL_BK_NESTED) return; // the nested run is the proof; it does not nest again
  const r = spawnSync(process.execPath, [join(process.cwd(), "scripts", "run-engine-tests.mjs"), "backup-oauth.test.mjs"], {
    env: {
      ...process.env,
      RSL_BK_NESTED: "1",
      NEXT_PUBLIC_RSL_BACKUP_PCLOUD_CLIENT_ID: "FAKEFAKE1234",
      NEXT_PUBLIC_RSL_BACKUP_ONEDRIVE_CLIENT_ID: "00000000-0000-0000-0000-000000000000",
      NEXT_PUBLIC_RSL_APP_LINK: "1",
    },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, (r.stdout || "").split("\n").filter((l) => /^not ok|^# (pass|fail)/.test(l)).join("\n") + (r.stderr || "").slice(0, 400));
});

test("release workflow: client IDs and the app link come from repository variables, only into the web-core build steps", () => {
  const text = readFileSync(join(process.cwd(), "..", "..", "..", ".github", "workflows", "release.yml"), "utf8");
  const pairs = [
    ["NEXT_PUBLIC_RSL_BACKUP_GDRIVE_CLIENT_ID", "RSL_BACKUP_GDRIVE_CLIENT_ID"],
    ["NEXT_PUBLIC_RSL_BACKUP_ONEDRIVE_CLIENT_ID", "RSL_BACKUP_ONEDRIVE_CLIENT_ID"],
    ["NEXT_PUBLIC_RSL_BACKUP_PCLOUD_CLIENT_ID", "RSL_BACKUP_PCLOUD_CLIENT_ID"],
    ["NEXT_PUBLIC_RSL_APP_LINK", "RSL_APP_LINK"],
  ];
  const [head, jobsText] = text.split(/^jobs:\s*$/m);
  const jobs = {};
  let cur = null;
  for (const line of jobsText.split("\n")) {
    const m = /^  ([a-z_]+):\s*$/.exec(line);
    if (m) cur = jobs[m[1]] = [];
    else if (cur) cur.push(line);
  }
  for (const k of Object.keys(jobs)) jobs[k] = jobs[k].join("\n");
  for (const [k, v] of pairs) {
    assert.ok(!head.includes(k), `${k} must not be workflow-level: every step, the gate's tests included, would see it`);
    assert.ok(!jobs.verify.includes(k), `${k} must not reach the gate job`);
    assert.ok(!new RegExp(`${k}:\\s*\\$\\{\\{\\s*secrets\\.`).test(text), `${k} must not come from a secret`);
    // the web-core builds: desktop (three OS), Android and iOS web builds, and the update-channel PWA build
    for (const job of ["windows", "macos", "linux", "android", "ios", "publish"]) {
      assert.ok(jobs[job].includes(`${k}: \${{ vars.${v} }}`), `${job} sets ${k}`);
    }
  }
});

test("M-2: the native wrapper lower-cases response header names", async () => {
  setBackupNativeRequest(async () => ({ status: 200, headers: { "Content-Type": "text/plain", ETag: "w", "x-a": "1" }, text: "ok" }));
  try {
    const r = await backupHttp()({ method: "GET", url: GOOD_URL });
    assert.deepEqual(r.headers, { "content-type": "text/plain", etag: "w", "x-a": "1" });
  } finally {
    setBackupNativeRequest(null);
  }
});

test("M-3: expired pending sign-in entries (verifier included) are purged whenever the module reads them", async () => {
  const stale = (t) => JSON.stringify({ p: "onedrive", s: "old-state", v: "OLDVERIFIER".repeat(4), t });
  // a plain page load (no callback parameters) removes an entry older than 10 minutes, keeps a fresh one
  let st = memStorage({ [PENDING_KEY]: stale(NOW - 11 * 60 * 1000) });
  assert.equal(consumeWebCallback(WEB_REDIRECT, { storage: st, now: NOW }), null);
  assert.equal(st.has(PENDING_KEY), false);
  st = memStorage({ [PENDING_KEY]: stale(NOW - 9 * 60 * 1000) });
  assert.equal(consumeWebCallback(WEB_REDIRECT, { storage: st, now: NOW }), null);
  assert.equal(st.has(PENDING_KEY), true, "a sign-in that may still return is kept");
  // an unparseable leftover goes too
  st = memStorage({ [PENDING_KEY]: "{junk" });
  assert.equal(consumeWebCallback("not a url", { storage: st, now: NOW }), null);
  assert.equal(st.has(PENDING_KEY), false);
  // the helper itself
  st = memStorage({ [PENDING_KEY]: stale(NOW - 10 * 60 * 1000 - 1) });
  purgeStalePending(st, NOW);
  assert.equal(st.has(PENDING_KEY), false);
  st = memStorage({ [PENDING_KEY]: stale(NOW - 10 * 60 * 1000) });
  purgeStalePending(st, NOW);
  assert.equal(st.has(PENDING_KEY), true, "exactly 10 minutes is still fresh");
  // beginWebSignIn purges first, even when it then refuses (provider not set up), and replaces an old entry otherwise
  st = memStorage({ [PENDING_KEY]: stale(Date.now() - 11 * 60 * 1000) });
  await rejectsCode(beginWebSignIn("onedrive", EMPTY, { storage: st, assign: () => assert.fail("navigated"), origin: HOSTED_ORIGIN }), "not-set-up");
  assert.equal(st.has(PENDING_KEY), false);
  st = memStorage({ [PENDING_KEY]: stale(Date.now() - 11 * 60 * 1000) });
  await beginWebSignIn("pcloud", FULL, { storage: st, assign: () => {}, origin: HOSTED_ORIGIN });
  assert.ok(!st.get(PENDING_KEY).includes("OLDVERIFIER"));
  assert.equal(JSON.parse(st.get(PENDING_KEY)).p, "pcloud");
  // a storage that only writes still works
  await beginWebSignIn("pcloud", FULL, { storage: { setItem: () => {} }, assign: () => {}, origin: HOSTED_ORIGIN });
});

test("M-4: a cancel after the redirect arrives stops the sign-in, and the signal reaches the token request", async () => {
  clearAllSessions();
  // aborted while the browser was open, redirect arrives anyway: no exchange, no session
  let ctl = new AbortController();
  let http = recordingHttp(() => tokenOk());
  let shell = fakeShell("loopback", (u) => { ctl.abort(); return LOOPBACK_REDIRECT + "?code=fake-code&state=" + stateOf(u); });
  await rejectsCode(signInShell("gdrive", FULL, { shell: "tauri", oauth: shell, http, now: () => NOW, signal: ctl.signal }), "cancelled");
  assert.equal(http.calls.length, 0);
  assert.equal(getSession("gdrive", NOW), null);
  // aborted during the token request: the session is not set, and the request carried the signal
  ctl = new AbortController();
  http = recordingHttp(() => { ctl.abort(); return tokenOk(); });
  shell = fakeShell("loopback", (u) => LOOPBACK_REDIRECT + "?code=fake-code&state=" + stateOf(u));
  await rejectsCode(signInShell("gdrive", FULL, { shell: "tauri", oauth: shell, http, now: () => NOW, signal: ctl.signal }), "cancelled");
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].signal, ctl.signal);
  assert.equal(getSession("gdrive", NOW), null);
  // not aborted: unchanged
  ctl = new AbortController();
  http = recordingHttp(() => tokenOk());
  await signInShell("gdrive", FULL, { shell: "tauri", oauth: shell, http, now: () => NOW, signal: ctl.signal });
  assert.equal(http.calls[0].signal, ctl.signal);
  assert.notEqual(getSession("gdrive", NOW), null);
  clearAllSessions();
  // exchangeCode on its own passes the signal through
  http = recordingHttp(() => tokenOk());
  ctl = new AbortController();
  await exchangeCode("gdrive", { clientId: FAKE_IDS.gdrive, code: "fake-code", verifier: "v".repeat(43), redirectUri: LOOPBACK_REDIRECT }, http, NOW, ctl.signal);
  assert.equal(http.calls[0].signal, ctl.signal);
});
