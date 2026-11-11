import { test } from "node:test";
import assert from "node:assert/strict";
import { UPDATE_ORIGIN, CHECK_INTERVAL_MS, parseManifest, isNewer, dueForCheck, manifestUrl, updateAction, formatBytes } from "./update-channel.ts";

const good = {
  schema: 1, app: "rsl-confluence", version: "2.5.1", build: "20261108", publishedAt: "2026-11-08T06:00:00Z", notes: "Update channel.",
  android: { file: "rsL-Confluence-v2.5.1-build20261108.apk", bytes: 20325050, sha256: "a".repeat(64) },
};

test("the update origin is the approved Netlify site (ADR-0012)", () => {
  assert.equal(UPDATE_ORIGIN, "https://effervescent-bubblegum-1e5c03.netlify.app");
  assert.equal(CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000);
});

test("a valid manifest parses", () => {
  const r = parseManifest(good);
  assert.equal(r.ok, true);
  assert.equal(r.manifest.version, "2.5.1");
  assert.equal(r.manifest.android.file, good.android.file);
});

test("android may be null (web-only release)", () => {
  assert.equal(parseManifest({ ...good, android: null }).ok, true);
});

test("malformed manifests are rejected", () => {
  for (const bad of [
    null, "x", { ...good, schema: 2 }, { ...good, app: "other" }, { ...good, version: "2.5.1-beta" }, { ...good, build: "2026118" },
    { ...good, notes: "x".repeat(501) }, { ...good, android: { ...good.android, file: "../evil.apk" } },
    { ...good, android: { ...good.android, file: "https://evil.example/x.apk" } }, { ...good, android: { ...good.android, sha256: "zz" } },
    { ...good, android: { ...good.android, bytes: 0 } }, { ...good, android: { ...good.android, bytes: 300 * 1024 * 1024 } },
  ]) assert.equal(parseManifest(bad).ok, false, JSON.stringify(bad)?.slice(0, 80));
});

test("newer = higher version, or same version with a later build", () => {
  assert.equal(isNewer({ version: "2.5", build: "20261107" }, { version: "2.5.1", build: "20261107" }), true);
  assert.equal(isNewer({ version: "2.5.1", build: "20261107" }, { version: "2.5.1", build: "20261108" }), true);
  assert.equal(isNewer({ version: "2.5.1", build: "20261108" }, { version: "2.5.1", build: "20261108" }), false);
  assert.equal(isNewer({ version: "2.10", build: "20261101" }, { version: "2.9.9", build: "20261231" }), false);
  assert.equal(isNewer({ version: "2.5.1", build: "20261108" }, { version: "2.5", build: "20261109" }), false);
});

test("a check is due on first run and every 6 hours", () => {
  const now = Date.parse("2026-11-08T12:00:00Z");
  assert.equal(dueForCheck(null, now), true);
  assert.equal(dueForCheck("2026-11-08T07:00:00Z", now), false);
  assert.equal(dueForCheck("2026-11-08T05:59:00Z", now), true);
  assert.equal(dueForCheck("not a date", now), true);
});

test("the PWA reads its own origin; native shells read the update origin", () => {
  assert.equal(manifestUrl("web", "https://effervescent-bubblegum-1e5c03.netlify.app/"), "https://effervescent-bubblegum-1e5c03.netlify.app/updates/latest.json");
  assert.equal(manifestUrl("web", "http://127.0.0.1:8770/index.html"), "http://127.0.0.1:8770/updates/latest.json");
  assert.equal(manifestUrl("capacitor", "https://localhost/"), `${UPDATE_ORIGIN}/updates/latest.json`);
  assert.equal(manifestUrl("tauri", "tauri://localhost/"), `${UPDATE_ORIGIN}/updates/latest.json`);
});

test("the action per platform; the APK URL is built from the fixed origin", () => {
  const m = parseManifest(good).manifest;
  assert.deepEqual(updateAction("web", "linux", m), { kind: "reload" });
  assert.deepEqual(updateAction("capacitor", "android", m), { kind: "download", url: `${UPDATE_ORIGIN}/updates/${good.android.file}`, bytes: good.android.bytes, sha256: good.android.sha256 });
  assert.deepEqual(updateAction("capacitor", "android", { ...m, android: null }), { kind: "notice", hint: "android-later" });
  assert.deepEqual(updateAction("capacitor", "ios", m), { kind: "notice", hint: "ios" });
  assert.deepEqual(updateAction("tauri", "windows", m), { kind: "notice", hint: "desktop" });
});

test("sizes are shown in MB", () => {
  assert.equal(formatBytes(20325050), "19.4 MB");
  assert.equal(formatBytes(900000), "0.9 MB");
});

test("kit shell names map to channel shells (browser/pwa/electron → web)", async () => {
  const { channelShell } = await import("./update-channel.ts");
  assert.deepEqual(["browser", "pwa", "electron", "tauri", "capacitor"].map(channelShell), ["web", "web", "web", "tauri", "capacitor"]);
});
