#!/usr/bin/env node
/**
 * apply-native-config.mjs — idempotent hardening of the generated Capacitor projects.
 *
 *   node tools/apply-native-config.mjs [android|ios|all]      (run after `cap add …`; any cwd)
 *
 * Android: allowBackup=false, usesCleartextTraffic=false, release signing from env
 *          (RSL_KEYSTORE, RSL_KEYSTORE_PASSWORD, RSL_KEY_ALIAS, RSL_KEY_PASSWORD) — unsigned when absent.
 * iOS:     fails if an App Transport Security exception is present (ATS stays at defaults).
 * Both:    stamps the app version from apps/confluence/web/src/rsl/app-info.ts
 *          (Android versionName "2.3 (20261101)" / versionCode 20261101; iOS MARKETING_VERSION 2.3,
 *          CURRENT_PROJECT_VERSION 20261101) so the installed app shows the same build as the footer.
 * Fails loudly when an expected anchor is missing, so a template change is noticed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const which = process.argv[2] || "all";
const mobile = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "confluence", "mobile");
// v2.5: the rsL icon on Android and iPhone (WP2); verified in the built packages by release check R13.
const { applyIcons } = await import("./native-icons.mjs");
const ICONS = { mobileDir: mobile, iconsDir: join(mobile, "..", "desktop", "src-tauri", "icons"), iosIcon: join(mobile, "resources", "ios-AppIcon-1024.png") };

// v2.3.1: version stamp shared with the web build (app-info.ts is the single source).
const appInfo = readFileSync(join(mobile, "..", "web", "src", "rsl", "app-info.ts"), "utf8");
const APP_VERSION = /version:\s*"([\d.]+)"/.exec(appInfo)?.[1];
const APP_BUILD = /build:\s*"(\d{8})"/.exec(appInfo)?.[1];
if (!APP_VERSION || !APP_BUILD) throw new Error("app-info.ts: version/build anchor missing");

if (which === "all" || which === "android") {
  const manifest = join(mobile, "android", "app", "src", "main", "AndroidManifest.xml");
  if (existsSync(manifest)) {
    let xml = readFileSync(manifest, "utf8");
    if (!xml.includes("<application")) throw new Error("AndroidManifest.xml: <application> anchor missing");
    xml = xml.replace(/android:allowBackup="true"/, 'android:allowBackup="false"');
    if (!/android:allowBackup=/.test(xml)) xml = xml.replace("<application", '<application android:allowBackup="false"');
    if (!/android:usesCleartextTraffic=/.test(xml)) xml = xml.replace("<application", '<application android:usesCleartextTraffic="false"');
    writeFileSync(manifest, xml);
    console.log("Android manifest hardened ✓");

    const gradle = join(mobile, "android", "app", "build.gradle");
    let g = readFileSync(gradle, "utf8");
    if (!g.includes("rsL release signing")) {
      if (!/\n\s*buildTypes\s*\{/.test(g) || !/\n(\s*)release\s*\{/.test(g)) throw new Error("build.gradle: buildTypes/release anchor missing");
      g = g.replace(/\n(\s*)buildTypes\s*\{/, `
$1// rsL release signing — values come from CI secrets; the build is unsigned when they are absent.
$1def rslKeystore = System.getenv("RSL_KEYSTORE")
$1def rslSigned = rslKeystore != null && new File(rslKeystore).exists()
$1signingConfigs {
$1    release {
$1        if (rslSigned) {
$1            storeFile file(rslKeystore)
$1            storePassword System.getenv("RSL_KEYSTORE_PASSWORD")
$1            keyAlias System.getenv("RSL_KEY_ALIAS")
$1            keyPassword System.getenv("RSL_KEY_PASSWORD")
$1        }
$1    }
$1}
$1buildTypes {`);
      g = g.replace(/\n(\s*)release\s*\{(?![^}]*storeFile)/, (m, ind) => `${m}\n${ind}    if (rslSigned) { signingConfig signingConfigs.release }`);
      writeFileSync(gradle, g);
    }
    console.log("Android release signing wired (env) ✓");
    let g2 = readFileSync(gradle, "utf8");
    if (!/versionCode\s+\d+/.test(g2) || !/versionName\s+"[^"]*"/.test(g2)) throw new Error("build.gradle: versionCode/versionName anchor missing");
    g2 = g2.replace(/versionCode\s+\d+/, `versionCode ${APP_BUILD}`).replace(/versionName\s+"[^"]*"/, `versionName "${APP_VERSION} (${APP_BUILD})"`);
    writeFileSync(gradle, g2);
    console.log(`Android version ${APP_VERSION} (${APP_BUILD}) ✓`);
    console.log(`Android launcher icons: ${applyIcons({ ...ICONS, which: "android" }).android} files ✓`);
  } else console.log("No android/ project yet — skipped.");
}

if (which === "all" || which === "ios") {
  const plist = join(mobile, "ios", "App", "App", "Info.plist");
  if (existsSync(plist)) {
    const p = readFileSync(plist, "utf8");
    if (/NSAllowsArbitraryLoads<\/key>\s*<true\/>/.test(p)) throw new Error("ATS exception present in Info.plist — remove it.");
    console.log("iOS Info.plist: ATS at defaults ✓");
    const pbx = join(mobile, "ios", "App", "App.xcodeproj", "project.pbxproj");
    let x = readFileSync(pbx, "utf8");
    if (!/MARKETING_VERSION = /.test(x) || !/CURRENT_PROJECT_VERSION = /.test(x)) throw new Error("project.pbxproj: version anchors missing");
    x = x.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${APP_VERSION};`).replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${APP_BUILD};`);
    writeFileSync(pbx, x);
    console.log(`iOS version ${APP_VERSION} (${APP_BUILD}) ✓`);
    console.log(`iOS app icon: ${applyIcons({ ...ICONS, which: "ios" }).ios} file ✓`);
  } else console.log("No ios/ project yet — skipped.");
}
