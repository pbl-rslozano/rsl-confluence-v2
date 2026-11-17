import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appLinkConfig, writeAppLinkFiles, patchAndroidManifest, iosEntitlements, APP_LINK_PATH, APP_ID } from "./app-link-files.mjs";

// Obviously fake values only.
const FP = Array.from({ length: 32 }, () => "AA").join(":");
const FP31 = Array.from({ length: 31 }, () => "AA").join(":");
const TEAM = "FAKETEAM00";
const tmp = () => mkdtempSync(join(tmpdir(), "applink-"));
const json = (f) => JSON.parse(readFileSync(f, "utf8"));

test("disabled by default", () => {
  assert.equal(appLinkConfig({}), null);
  assert.equal(appLinkConfig({ RSL_ANDROID_CERT_SHA256: FP, RSL_IOS_TEAM_ID: TEAM }), null, "needs RSL_APP_LINK=1");
  const d = tmp();
  assert.deepEqual(writeAppLinkFiles(d, {}), []);
  assert.equal(existsSync(join(d, ".well-known")), false);
  rmSync(d, { recursive: true });
});

test("android file", () => {
  const d = tmp();
  const w = writeAppLinkFiles(d, { RSL_APP_LINK: "1", RSL_ANDROID_CERT_SHA256: FP });
  assert.equal(w.length, 1);
  assert.deepEqual(json(join(d, ".well-known/assetlinks.json")), [
    { relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: "com.rslozano.confluence", sha256_cert_fingerprints: [FP] } },
  ]);
  assert.equal(existsSync(join(d, ".well-known/apple-app-site-association")), false);
  rmSync(d, { recursive: true });
});

test("ios file", () => {
  const d = tmp();
  writeAppLinkFiles(d, { RSL_APP_LINK: "1", RSL_IOS_TEAM_ID: TEAM });
  assert.deepEqual(json(join(d, ".well-known/apple-app-site-association")), {
    applinks: { details: [{ appIDs: [`${TEAM}.com.rslozano.confluence`], components: [{ "/": "/oauth/app/*" }] }] },
  });
  assert.equal(existsSync(join(d, ".well-known/assetlinks.json")), false);
  assert.equal(APP_ID, "com.rslozano.confluence");
  assert.equal(APP_LINK_PATH, "/oauth/app/");
  rmSync(d, { recursive: true });
});

test("invalid values are refused", () => {
  assert.equal(appLinkConfig({ RSL_APP_LINK: "1", RSL_ANDROID_CERT_SHA256: FP31 }), null);
  assert.equal(appLinkConfig({ RSL_APP_LINK: "1", RSL_IOS_TEAM_ID: "abc" }), null);
  assert.equal(appLinkConfig({ RSL_APP_LINK: "1", RSL_ANDROID_CERT_SHA256: `${FP},${FP31}` }), null);
  const c = appLinkConfig({ RSL_APP_LINK: "1", RSL_ANDROID_CERT_SHA256: `${FP} ${FP.replace(/AA/g, "bb")}`, RSL_IOS_TEAM_ID: "abc" });
  assert.equal(c.androidSha256.length, 2);
  assert.equal(c.iosAppId, null);
  assert.match(c.host, /^[a-z0-9.-]+$/);
});

test("manifest patch is idempotent", () => {
  const cfg = appLinkConfig({ RSL_APP_LINK: "1", RSL_ANDROID_CERT_SHA256: FP });
  const xml = `<manifest><application><activity android:name=".MainActivity">\n  <intent-filter><action android:name="android.intent.action.MAIN" /></intent-filter>\n</activity></application></manifest>`;
  const once = patchAndroidManifest(xml, cfg);
  const twice = patchAndroidManifest(once, cfg);
  assert.equal(twice, once);
  assert.equal((once.match(/android:autoVerify="true"/g) || []).length, 1);
  assert.ok(once.includes(`android:host="${cfg.host}"`) && once.includes('android:pathPrefix="/oauth/app/"') && once.includes("BROWSABLE"));
  assert.equal(patchAndroidManifest(xml, null), xml, "disabled changes nothing");
});

test("ios entitlements carry the associated domain", () => {
  const cfg = appLinkConfig({ RSL_APP_LINK: "1", RSL_IOS_TEAM_ID: TEAM });
  assert.ok(iosEntitlements(cfg).includes(`<string>applinks:${cfg.host}</string>`));
});
