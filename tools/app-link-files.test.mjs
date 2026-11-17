import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appLinkConfig, writeAppLinkFiles, patchAndroidManifest, iosEntitlements, patchPbxproj, appLinkWarnings, ENTITLEMENTS_SETTING, APP_LINK_PATH, APP_ID } from "./app-link-files.mjs";

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

const pbxBlock = (name, extra = "") => `\t\t${name} /* ${name} */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tMARKETING_VERSION = 1.0;
${extra}\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.rslozano.confluence;
\t\t\t};
\t\t\tname = ${name};
\t\t};
`;
const PBX = (dbgExtra = "") => pbxBlock("Debug", dbgExtra) + pbxBlock("Release") + `\t\tOther /* Other */ = {
\t\t\tbuildSettings = {
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.example.fake.tests;
\t\t\t};
\t\t};
`;

test("pbxproj: entitlements setting is added to Debug and Release of the app target only", () => {
  const cfg = appLinkConfig({ RSL_APP_LINK: "1", RSL_IOS_TEAM_ID: TEAM });
  const out = patchPbxproj(PBX(), cfg);
  assert.equal((out.match(/CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/g) || []).length, 2);
  assert.equal(ENTITLEMENTS_SETTING, "App/App.entitlements");
  const other = out.slice(out.indexOf("Other /*"));
  assert.ok(!other.includes("CODE_SIGN_ENTITLEMENTS"), "other targets untouched");
});

test("pbxproj: patch is idempotent", () => {
  const cfg = appLinkConfig({ RSL_APP_LINK: "1", RSL_IOS_TEAM_ID: TEAM });
  const once = patchPbxproj(PBX(), cfg);
  assert.equal(patchPbxproj(once, cfg), once);
});

test("pbxproj: an existing different value is replaced (the link needs this file)", () => {
  const cfg = appLinkConfig({ RSL_APP_LINK: "1", RSL_IOS_TEAM_ID: TEAM });
  const out = patchPbxproj(PBX("\t\t\t\tCODE_SIGN_ENTITLEMENTS = Fake/Old.entitlements;\n"), cfg);
  assert.ok(!out.includes("Fake/Old.entitlements"));
  assert.equal((out.match(/CODE_SIGN_ENTITLEMENTS/g) || []).length, 2);
});

test("pbxproj: disabled changes nothing; a missing anchor fails loudly", () => {
  assert.equal(patchPbxproj(PBX(), null), PBX());
  const android = appLinkConfig({ RSL_APP_LINK: "1", RSL_ANDROID_CERT_SHA256: FP });
  assert.equal(patchPbxproj(PBX(), android), PBX(), "no iOS identifier, no change");
  const cfg = appLinkConfig({ RSL_APP_LINK: "1", RSL_IOS_TEAM_ID: TEAM });
  assert.throws(() => patchPbxproj("buildSettings = { FOO = 1; };", cfg), /anchor missing/);
});

test("warnings name the rejected variable, never its value", () => {
  assert.deepEqual(appLinkWarnings({}), [], "off on purpose: silent");
  assert.deepEqual(appLinkWarnings({ RSL_ANDROID_CERT_SHA256: "bad" }), [], "needs RSL_APP_LINK=1");
  const badFp = "ZZ:FAKE-FINGERPRINT-VALUE", badTeam = "fake-team-value";
  const both = appLinkWarnings({ RSL_APP_LINK: "1", RSL_ANDROID_CERT_SHA256: badFp, RSL_IOS_TEAM_ID: badTeam });
  const text = both.join("\n");
  assert.ok(text.includes("RSL_ANDROID_CERT_SHA256") && text.includes("RSL_IOS_TEAM_ID") && /stays off/.test(text));
  assert.ok(!text.includes(badFp) && !text.includes(badTeam) && !text.includes("FAKE"), "value never printed");
  const one = appLinkWarnings({ RSL_APP_LINK: "1", RSL_ANDROID_CERT_SHA256: FP, RSL_IOS_TEAM_ID: badTeam });
  assert.equal(one.length, 1);
  assert.ok(one[0].includes("RSL_IOS_TEAM_ID") && !/stays off/.test(one[0]));
  assert.deepEqual(appLinkWarnings({ RSL_APP_LINK: "1", RSL_IOS_TEAM_ID: TEAM }), []);
});

test("apply-native-config prints the warning without the value (captured)", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, ["tools/apply-native-config.mjs", "android"], { env: { ...process.env, RSL_APP_LINK: "1", RSL_ANDROID_CERT_SHA256: "fake-bad-value" }, encoding: "utf8" });
  const out = r.stdout + r.stderr;
  assert.match(out, /RSL_ANDROID_CERT_SHA256 is not valid/);
  assert.match(out, /stays off/);
  assert.ok(!out.includes("fake-bad-value"));
});
