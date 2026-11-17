/**
 * app-link-files.mjs — the phone's verified app link (v2.8 WP28 Task 7). Off by default.
 *
 * Enabled only when the owner sets RSL_APP_LINK=1 and a valid RSL_ANDROID_CERT_SHA256 and/or RSL_IOS_TEAM_ID
 * (repository variables: public identifiers, never secrets, never committed). Then:
 *   - writeAppLinkFiles(outDir, env)  writes out/.well-known/assetlinks.json and/or apple-app-site-association;
 *   - patchAndroidManifest(xml, cfg)  adds one verified https intent filter (idempotent);
 *   - iosEntitlements(cfg)            returns App.entitlements with the associated domain.
 * When disabled nothing is written or changed.
 *
 * The path, host and app id are read statically from source (no web TypeScript is imported at runtime).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const grab = (src, re, what) => {
  const m = re.exec(src);
  if (!m) throw new Error(`app-link-files: ${what} anchor missing`);
  return m[1];
};

export const APP_LINK_PATH = grab(read("apps/confluence/web/src/lib/backup-providers.ts"), /export const APP_LINK_PATH = "([^"]+)"/, "APP_LINK_PATH");
export const APP_ID = grab(read("apps/confluence/mobile/capacitor.config.ts"), /appId:\s*"([^"]+)"/, "appId");
const HOST = new URL(grab(read("apps/confluence/web/src/lib/update-channel.ts"), /export const UPDATE_ORIGIN = "([^"]+)"/, "UPDATE_ORIGIN")).host;

const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const TEAM_ID = /^[A-Z0-9]{10}$/;

/** null unless the owner enabled the link and supplied at least one valid public identifier. */
export function appLinkConfig(env = {}) {
  if (env.RSL_APP_LINK !== "1") return null;
  const androidSha256 = (env.RSL_ANDROID_CERT_SHA256 ?? "").split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const androidOk = androidSha256.length > 0 && androidSha256.every((f) => FINGERPRINT.test(f));
  const team = (env.RSL_IOS_TEAM_ID ?? "").trim();
  const iosOk = TEAM_ID.test(team);
  if (!androidOk && !iosOk) return null;
  return { enabled: true, host: HOST, androidSha256: androidOk ? androidSha256 : [], iosAppId: iosOk ? `${team}.${APP_ID}` : null };
}

export function writeAppLinkFiles(outDir, env = {}) {
  const cfg = appLinkConfig(env);
  if (!cfg) return [];
  const dir = join(outDir, ".well-known");
  mkdirSync(dir, { recursive: true });
  const written = [];
  if (cfg.androidSha256.length) {
    const f = join(dir, "assetlinks.json");
    writeFileSync(f, JSON.stringify([{ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: APP_ID, sha256_cert_fingerprints: cfg.androidSha256 } }], null, 2) + "\n");
    written.push(f);
  }
  if (cfg.iosAppId) {
    const f = join(dir, "apple-app-site-association");
    writeFileSync(f, JSON.stringify({ applinks: { details: [{ appIDs: [cfg.iosAppId], components: [{ "/": APP_LINK_PATH + "*" }] }] } }, null, 2) + "\n");
    written.push(f);
  }
  return written;
}

/** Adds the verified app-link intent filter to the main activity once. */
export function patchAndroidManifest(xml, cfg) {
  if (!cfg) return xml;
  if (xml.includes('android:autoVerify="true"') && xml.includes(`android:pathPrefix="${APP_LINK_PATH}"`)) return xml;
  const filter = `
            <intent-filter android:autoVerify="true">
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="https" android:host="${cfg.host}" android:pathPrefix="${APP_LINK_PATH}" />
            </intent-filter>
`;
  const i = xml.indexOf("</activity>");
  if (i < 0) throw new Error("AndroidManifest.xml: </activity> anchor missing");
  return xml.slice(0, i) + filter.replace(/^\n/, "\n") + "        " + xml.slice(i);
}

export function iosEntitlements(cfg) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.developer.associated-domains</key>
	<array>
		<string>applinks:${cfg.host}</string>
	</array>
</dict>
</plist>
`;
}
