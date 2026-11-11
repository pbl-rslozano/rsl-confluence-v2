# ADR-0001 — Shells: Tauri 2 (desktop), Capacitor 8 (mobile), PWA

**Status:** Accepted · 31 Oct 2026 · rsL Confluence Terminal v2.1 2026

## Context
Confluence Terminal 2.0x shipped as Electron (Windows) plus a Capacitor/Android wrapper and a browser build. Electron bundles Chromium (~300 MB installers), needed a file-origin workaround for the gateway, and is not the rsL standard. The app is desktop-first (a dense scanner table) but is also used on phones and tablets to check signals.

## Decision
- One web core: `apps/confluence/web`, Next.js 16 static export (`output: "export"`), built per target with `BUILD_TARGET=html|tauri|capacitor`.
- **Windows / macOS:** Tauri 2.12.5 (`apps/confluence/desktop`). Isolation pattern, `freezePrototype`, CSP object, one least-privilege capability.
- **iOS / iPadOS / Android:** Capacitor 8.6.0 (`apps/confluence/mobile`). New iOS project uses Swift Package Manager (CocoaPods trunk read-only from 2 Dec 2026).
- **Browser:** the same `out/` as an installable PWA.
- Electron, electron-builder and the 2.0x Android wrapper are removed.

## Consequences
- Installer size drops to Tauri's footprint; the desktop origin becomes `tauri://localhost` / `http(s)://tauri.localhost`, so the localhost gateway allow-list adds those origins (and still refuses `null`).
- Desktop compile, signing and installers run in CI only (`.github/workflows/release.yml`). **NOT VERIFIED** locally: this container has no WebKitGTK, so the Rust crate was resolved (`Cargo.lock`, 545 crates) but not compiled.
- Tauri mobile is not used.
