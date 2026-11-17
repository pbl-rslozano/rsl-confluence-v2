// WP28 Task 3: the URL gates of encrypted cloud backup. isAllowedBackupUrl and isAllowedSignInUrl are the only
// thing that keeps the backup code from reaching any other URL (native HTTP is not subject to the CSP).
// Task 4 grows this file with the OAuth flow tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BACKUP_NATIVE_URLS, BACKUP_SIGN_IN_URLS, PCLOUD_API_HOSTS, ONEDRIVE_DOWNLOAD_ORIGINS, CSP_HOSTS,
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

test("isAllowedBackupUrl: an origin in ONEDRIVE_DOWNLOAD_ORIGINS is allowed for any path, still https without userinfo or hash; empty by default", () => {
  assert.equal(ONEDRIVE_DOWNLOAD_ORIGINS.length, 0);
  const list = ONEDRIVE_DOWNLOAD_ORIGINS;
  list.push("https://example-download.test");
  try {
    assert.equal(isAllowedBackupUrl("https://example-download.test/any/path?x=1"), true);
    assert.equal(isAllowedBackupUrl("https://example-download.test/a/../b"), false);
    assert.equal(isAllowedBackupUrl("https://example-download.test/a%2fb"), false);
    assert.equal(isAllowedBackupUrl("http://example-download.test/any"), false);
    assert.equal(isAllowedBackupUrl("https://u@example-download.test/any"), false);
    assert.equal(isAllowedBackupUrl("https://example-download.test/any#x"), false);
    assert.equal(isAllowedBackupUrl("https://example-download.test.evil.test/any"), false);
  } finally {
    list.pop();
  }
  assert.equal(ONEDRIVE_DOWNLOAD_ORIGINS.length, 0);
  assert.equal(isAllowedBackupUrl("https://example-download.test/any"), false);
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
