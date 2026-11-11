import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTheme, migrateThemePref, THEME_COLORS } from "./theme.ts";

test("system preference follows the OS", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
});

test("explicit preference ignores the OS", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});

test("saved white background migrates to light (T-6)", () => {
  assert.equal(migrateThemePref({ background: "white" }, null), "light");
  assert.equal(migrateThemePref({ background: "dark" }, null), "dark");
});

test("legacy ct-theme=light migrates to light when no preferences are saved", () => {
  assert.equal(migrateThemePref(null, "light"), "light");
});

test("nothing saved means system", () => {
  assert.equal(migrateThemePref(null, null), "system");
});

test("a saved system preference stays system", () => {
  assert.equal(migrateThemePref({ background: "system" }, "light"), "system");
});

test("theme colours for the browser/status bar", () => {
  assert.deepEqual(THEME_COLORS, { light: "#F5F7FA", dark: "#0B1B33" });
});

test("desktop window theme: System hands control back to the OS (Tauri setTheme(null))", async () => {
  const { windowThemeArg } = await import("./theme.ts");
  assert.equal(windowThemeArg("system", "dark"), null);
  assert.equal(windowThemeArg("light", "light"), "light");
  assert.equal(windowThemeArg("dark", "dark"), "dark");
});

test("engines without CSS color-mix (iOS 15.0–16.1) stay dark: light tokens cannot reach /opacity utilities there", () => {
  assert.equal(resolveTheme("light", false, false), "dark");
  assert.equal(resolveTheme("system", false, false), "dark");
  assert.equal(resolveTheme("light", false, true), "light");
});
