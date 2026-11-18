import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const { version } = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Android release requires a three-part version.");
const appInfo = readFileSync(new URL("apps/confluence/web/src/rsl/app-info.ts", root), "utf8");
const build = Number(/build:\s*"([^"]+)"/.exec(appInfo)?.[1]);
// 18 Nov 2026: build date * 100 + (CI run number mod 100). Stays above every older "build + run" code (2.7.0 and earlier)
// and under Android's 2,100,000,000 cap through 2099; two builds of the same date collide only when the run number wraps.
const code = build * 100 + (Number(process.env.GITHUB_RUN_NUMBER ?? 0) % 100);
if (!Number.isSafeInteger(code) || code < 1 || code > 2100000000) throw new Error("Invalid Android version code.");
const path = fileURLToPath(new URL("apps/confluence/mobile/android/app/build.gradle", root));
const source = readFileSync(path, "utf8");
if ((source.match(/\bversionCode\s+\d+/g) ?? []).length !== 1 ||
    (source.match(/\bversionName\s+"[^"]+"/g) ?? []).length !== 1) {
  throw new Error("Android version anchors are missing or ambiguous.");
}
writeFileSync(path, source.replace(/\bversionCode\s+\d+/, "versionCode " + code)
  .replace(/\bversionName\s+"[^"]+"/, 'versionName "' + version + '"'));
