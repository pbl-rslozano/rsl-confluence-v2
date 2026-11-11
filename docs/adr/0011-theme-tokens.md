# ADR-0011 — Theme tokens: System / Light / Dark; the app bar follows the theme

**Status:** Accepted · 7 Nov 2026 (v2.5; owner approved the v2.5 architecture plan WP5 with the default "light header")

## Context
v2.0–v2.4 implemented the light theme as ~25 `[class*='bg-zinc-…'] … !important` overrides (and a similar
set for dark). Anything those selectors missed kept its dark colours: in light mode the navy app bar held
light-styled controls, four header buttons rendered dark-on-dark (blank), the first frame after a switch
was half dark and half light, and `theme-color` stayed navy (see the v2.5 spec, finding F4).

## Decision
- One palette per theme, selected by `<html data-theme="dark|light">`. Tailwind's neutral scale
  (`--color-zinc-50…950`) and the text accents are remapped per theme in `globals.css`, so every
  `bg-/text-/border-zinc-*` utility (including `/opacity` variants) switches in the same frame.
- Three preferences: **System** (default for new installs; follows `prefers-color-scheme` live), Light, Dark.
  Stored as `background: "system" | "white" | "dark"` (back-compatible) and mirrored to `ct-theme-pref`
  for the pre-paint script.
- The theme is applied before first paint; switching suspends transitions for one frame (`.theme-switching`).
- Platform chrome follows: `theme-color` (#F5F7FA / #0B1B33), Capacitor status bar, Tauri window theme
  (`core:window:allow-set-theme`).
- **The app bar follows the theme** (light bar in light mode). This replaces acceptance ID-8.3c's previous
  wording "bar stays navy"; the check now asserts the dark-ink wordmark on the light bar.

## Consequences
- New acceptance checks T-1…T-5 (contrast in both themes, no wrong-theme blocks, one theme per frame,
  theme-color, System live + after reload).
- New components should use the neutral utilities or tokens; hard-coded hex surfaces bypass the theme.
