import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyIcons } from "./native-icons.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "icons-"));
  const icons = join(root, "icons");
  for (const d of ["mipmap-mdpi", "mipmap-xxxhdpi"]) {
    mkdirSync(join(icons, "android", d), { recursive: true });
    for (const f of ["ic_launcher.png", "ic_launcher_round.png", "ic_launcher_foreground.png"]) writeFileSync(join(icons, "android", d, f), `rsl-${d}-${f}`);
  }
  mkdirSync(join(icons, "android", "values"), { recursive: true });
  writeFileSync(join(icons, "android", "values", "ic_launcher_background.xml"), "<rsl-bg/>");
  const ios = join(root, "ios-AppIcon-1024.png"); writeFileSync(ios, "rsl-ios");
  const mobile = join(root, "mobile");
  const res = join(mobile, "android", "app", "src", "main", "res");
  mkdirSync(join(res, "mipmap-xxxhdpi"), { recursive: true }); writeFileSync(join(res, "mipmap-xxxhdpi", "ic_launcher.png"), "capacitor");
  const set = join(mobile, "ios", "App", "App", "Assets.xcassets", "AppIcon.appiconset");
  mkdirSync(set, { recursive: true }); writeFileSync(join(set, "AppIcon-512@2x.png"), "capacitor"); writeFileSync(join(set, "Contents.json"), "{}");
  return { mobile, icons, ios, res, set };
}

test("android launcher icons and background colour are replaced by the rsL set", () => {
  const f = fixture();
  const r = applyIcons({ mobileDir: f.mobile, iconsDir: f.icons, iosIcon: f.ios, which: "android" });
  assert.equal(readFileSync(join(f.res, "mipmap-xxxhdpi", "ic_launcher.png"), "utf8"), "rsl-mipmap-xxxhdpi-ic_launcher.png");
  assert.equal(readFileSync(join(f.res, "mipmap-mdpi", "ic_launcher_round.png"), "utf8"), "rsl-mipmap-mdpi-ic_launcher_round.png");
  // Adaptive-icon background = the rsL tile colour, so square/squircle masks show no white corners.
  assert.match(readFileSync(join(f.res, "values", "ic_launcher_background.xml"), "utf8"), /<color name="ic_launcher_background">#090D14<\/color>/);
  assert.equal(r.android, 7);
});

test("iOS app icon is replaced; Contents.json untouched", () => {
  const f = fixture();
  const r = applyIcons({ mobileDir: f.mobile, iconsDir: f.icons, iosIcon: f.ios, which: "ios" });
  assert.equal(readFileSync(join(f.set, "AppIcon-512@2x.png"), "utf8"), "rsl-ios");
  assert.equal(readFileSync(join(f.set, "Contents.json"), "utf8"), "{}");
  assert.equal(r.ios, 1);
});

test("a missing native project is skipped, a missing source fails", () => {
  const f = fixture();
  assert.equal(applyIcons({ mobileDir: join(f.mobile, "nope"), iconsDir: f.icons, iosIcon: f.ios, which: "all" }).android, 0);
  assert.throws(() => applyIcons({ mobileDir: f.mobile, iconsDir: f.icons, iosIcon: join(f.icons, "missing.png"), which: "ios" }), /missing\.png/);
  assert.ok(existsSync(join(f.set, "AppIcon-512@2x.png")));
});
