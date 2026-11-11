// native-icons.mjs — v2.5: copy the rsL app icon into the Capacitor projects (WP2).
// Source of truth: apps/confluence/desktop/src-tauri/icons/ (generated from source-512.png by `tauri icon`)
// plus an opaque 1024 px iOS icon (apps/confluence/mobile/resources/ios-AppIcon-1024.png — Apple app
// icons must not have transparency). Release check R13 (tools/check-icons.py) verifies the built APK/IPA.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Colour of the rsL icon tile (sampled from ic_launcher_foreground.png): the adaptive-icon background. */
export const ICON_TILE = "#090D14";

/**
 * @param {{ mobileDir: string, iconsDir: string, iosIcon: string, which?: "android"|"ios"|"all" }} o
 * @returns {{ android: number, ios: number }} files copied per platform (0 when the project is absent)
 */
export function applyIcons({ mobileDir, iconsDir, iosIcon, which = "all" }) {
  const done = { android: 0, ios: 0 };
  const res = join(mobileDir, "android", "app", "src", "main", "res");
  if ((which === "all" || which === "android") && existsSync(res)) {
    const src = join(iconsDir, "android");
    if (!existsSync(src)) throw new Error(`icons: ${src} missing`);
    for (const dir of readdirSync(src)) {
      if (!statSync(join(src, dir)).isDirectory()) continue;
      for (const file of readdirSync(join(src, dir))) {
        if (dir === "mipmap-anydpi-v26") continue; // keep Capacitor's adaptive XML (it references the copied foreground/background)
        mkdirSync(join(res, dir), { recursive: true });
        copyFileSync(join(src, dir, file), join(res, dir, file));
        done.android++;
      }
    }
    // Tauri generates a white background colour; launchers with square/squircle masks would show white corners.
    writeFileSync(join(res, "values", "ic_launcher_background.xml"),
      `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="ic_launcher_background">${ICON_TILE}</color>\n</resources>\n`);
  }
  const set = join(mobileDir, "ios", "App", "App", "Assets.xcassets", "AppIcon.appiconset");
  if ((which === "all" || which === "ios") && existsSync(set)) {
    if (!existsSync(iosIcon)) throw new Error(`icons: ${iosIcon} missing`);
    copyFileSync(iosIcon, join(set, "AppIcon-512@2x.png"));
    done.ios++;
  }
  return done;
}
