/**
 * theme.ts — v2.5 theme system (System / Light / Dark).
 *
 * The visual theme is a set of CSS variables selected by `<html data-theme>` (see globals.css),
 * so every component switches in the same frame. This module resolves the preference, applies it,
 * and keeps the platform chrome (browser bar, status bar, desktop window) in step.
 * No DOM access at import time: the pure helpers are unit-tested in Node.
 */

export type ThemePref = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

/** Browser `theme-color`, Android/iOS status bar and splash background per theme. */
export const THEME_COLORS: Record<ResolvedTheme, string> = { light: "#F5F7FA", dark: "#0B1B33" };

/** localStorage key read by the pre-paint script in layout.tsx (must stay in sync). */
export const THEME_PREF_KEY = "ct-theme-pref";

/**
 * Tailwind 4 emits `/opacity` utilities as fixed dark hex fallbacks and puts the token-based
 * `color-mix()` versions behind `@supports`. Engines without `color-mix` (Safari/WKWebView
 * < 16.2, i.e. iOS 15.0–16.1) would show dark translucent blocks in light mode, so they stay dark.
 */
export function resolveTheme(pref: ThemePref, systemDark: boolean, supportsColorMix = true): ResolvedTheme {
  if (!supportsColorMix) return "dark";
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}

/** True when the engine supports CSS color-mix() (needed for light-theme opacity utilities). */
export function cssSupportsColorMix(): boolean {
  return typeof CSS === "undefined" || typeof CSS.supports !== "function" || CSS.supports("color", "color-mix(in lab, red, red)");
}

/** Saved app preferences ("dark" | "white" | "system") or the legacy `ct-theme` key → preference. */
export function migrateThemePref(saved: { background?: string } | null, legacyCtTheme: string | null): ThemePref {
  const bg = saved?.background;
  if (bg === "system") return "system";
  if (bg === "white" || bg === "light") return "light";
  if (bg === "dark") return "dark";
  if (legacyCtTheme === "light") return "light";
  if (legacyCtTheme === "dark") return "dark";
  return "system";
}

/** Stored preference value (kept as "white" for back-compat with v2.0–v2.4 preference files). */
export function toStoredBackground(pref: ThemePref): "dark" | "white" | "system" {
  return pref === "light" ? "white" : pref;
}

export interface PlatformThemeHooks {
  setStatusBar?(resolved: ResolvedTheme): Promise<void>;
  /** `null` = follow the OS (Tauri `setTheme(null)`); forcing a theme also forces the webview's prefers-color-scheme. */
  setWindowTheme?(theme: ResolvedTheme | null): Promise<void>;
}

/** Desktop window theme for a preference: System must hand control back to the OS, or the
 *  webview's `prefers-color-scheme` freezes on the forced value and System stops following. */
export function windowThemeArg(pref: ThemePref, resolved: ResolvedTheme): ResolvedTheme | null {
  return pref === "system" ? null : resolved;
}

/**
 * Apply a resolved theme in one frame: `data-theme`, `color-scheme`, shadcn's `.dark`, the
 * `theme-color` meta, and native chrome. Transitions are suspended for one frame so no element
 * animates between themes (no mixed frames).
 */
export function applyTheme(resolved: ResolvedTheme, hooks: PlatformThemeHooks = {}, pref: ThemePref = resolved): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.add("theme-switching");
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  root.classList.toggle("dark", resolved === "dark");
  root.classList.toggle("ct-light", resolved === "light");
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = THEME_COLORS[resolved];
    meta.removeAttribute("media");
  }
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
  void hooks.setStatusBar?.(resolved).catch(() => {});
  void hooks.setWindowTheme?.(windowThemeArg(pref, resolved)).catch(() => {});
}
