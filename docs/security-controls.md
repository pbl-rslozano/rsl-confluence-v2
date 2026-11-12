# Security controls — rsL Confluence Terminal v2.1 2026

Mapped to **OWASP ASVS 5.0** (chapter level) and **OWASP MASVS v2.1** (control ids). Target L2. Gaps are listed honestly at the end.

| Control | How it is met | Evidence |
|---|---|---|
| ASVS V3 Web Frontend — CSP | Desktop: Tauri CSP object (`script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, no `unsafe-eval`). PWA/mobile: meta CSP. `style-src 'unsafe-inline'` kept for Radix/Tailwind runtime styles (gap G2). | `tauri.conf.json`, `layout.tsx`; release-check R6 |
| ASVS V3 — no dangerous sinks | User text is rendered by React (escaped). The only `dangerouslySetInnerHTML` is the kit's `brandBlockHTML`, which takes constant brand strings. Logos must be ≤ 300 KB and pass the kit's `isSafeLogo` (PNG/JPEG data URI, or SVG with no script, event handler, `javascript:`, `foreignObject`, external `href` or entity); they are drawn with `<img>`, where SVG scripts never run. | `BrandBlock.tsx`, `IdentityForm.tsx` |
| ASVS V12 Secure Communication / MASVS-NETWORK-1 | HTTPS only to the hosts in the public-host table `CSP_HOSTS` (v2.7: three exchanges, the update host, three display-currency rate hosts) plus Coins.ph read paths outside the CSP (ADR-0003, ADR-0013, ADR-0015); Android cleartext off; iOS ATS at defaults; localhost gateway HTTP on loopback only. | release-check R7/R8; `apply-native-config.mjs` |
| ASVS V13 Configuration / MASVS-CODE-3 | Exact versions, committed `pnpm-lock.yaml` and `Cargo.lock`, `--frozen-lockfile`, lifecycle scripts limited to `onlyBuiltDependencies`, CycloneDX SBOM per release. | release-check R2/R3/R9; `dist/*.cdx.json` |
| ASVS V15 Architecture — least privilege (desktop) | Isolation pattern: every IPC call passes an allow-list hook (sql, dialog, fs read/write, opener, event, window-state). One capability: fs limited to `$APPDATA/**` plus paths the user picks in a dialog; opener limited to the contact `mailto`. `freezePrototype: true`; devtools are not compiled into release builds. | `isolation/index.js`, `capabilities/main.json`; R6 |
| ASVS V15 — ports and adapters | Only `packages/adapters/*` import native plugins (ESLint `no-restricted-imports` + release-check R5). | `eslint.config.mjs`; R5 |
| ASVS V14 Data Protection / MASVS-STORAGE-1 | No secrets stored. Exchange API keys never touch app storage; the gateway holds them in memory for the session and clears them on exit or crash. Records are on-device only. | gateway `server.mjs`; ADR-0002 |
| MASVS-STORAGE-2 | Android `allowBackup="false"`; backups are explicit user exports (`.rslbak`). | `apply-native-config.mjs` |
| ASVS V16 Logging / ALCOA+ | Hash-chained audit trail (`app.start`, `migration.import`, `preferences.update`, `identity.update`, `backup.export/restore`, `clock.set-back`); About shows `intact (n)` or `BROKEN at #k`. Tamper-evident, not tamper-proof. | Acceptance BLD-9.4-6 |
| Update channel (ADR-0012) | Read-only GET of `/updates/latest.json` (no credentials, no identifiers), strict schema validation, APK URL built from the fixed origin + validated file name, Android signature decides installation; user can switch checks off. Publisher token only in the CI `publish` job. | Unit `update-channel.test.mjs`, `publish-update.test.mjs`; acceptance U-1…U-4; R8, R11, R15 |
| ASVS V2 Validation | Backup restore validates SHA-256, app id and schema before any write; a tampered file is refused. Identity fields NFC-normalised, length-capped, code A–Z 2–6. | BLD-9.4-5b, ID-8.5b/c |
| ASVS V4 API — localhost gateway | Rejects missing/`null`/foreign Origin, validates Host (DNS-rebinding), per-session bearer token, rate-limited `/connect`, no order/withdrawal endpoints. Tauri origins allowed explicitly. | `origin.test.mjs` (8/8 gateway tests) |
| MASVS-PLATFORM-2 (WebViews) | Capacitor `webContentsDebuggingEnabled: false`, `allowMixedContent: false`; no JS bridges beyond the listed plugins. | `capacitor.config.ts`; R7 |
| ASVS V4 — exchange rate limits (v2.2) | 429/418 and venue error envelopes halt the scan and pause new requests; no retry storm against the user's IP. | measure.test.mjs "Rate limits"; acceptance M-12 |
| ASVS V16 — ledger integrity (v2.2) | Signal rows are keyed by engine id × series × bar (idempotent); exports and clears are written to the audit trail. | measure.test.mjs "Ledger store"; acceptance M-8/M-9 |
| ASVS V3 — worker (v2.2) | Scoring Web Worker is a same-origin bundle chunk (`worker-src 'self'`); falls back to the main thread if blocked. | acceptance M-4 |
| ASVS V4 — no order path (v2.3) | Paper trading is a pure simulator: no network, no API keys, no order endpoints; a unit test fails if the paper modules gain network calls, order/API-key vocabulary or imports of the market/private-API clients. The Claude/MCP connection is read-only. | paper.test.mjs boundary checks; acceptance P-3; ADR-0010, ADR-0009 |
| ASVS V16 — research integrity (v2.3) | Trials register and pre-registrations survive a ledger clear; a pre-registered decision date cannot be moved; pre-registration is audited (`ledger.preregister`). | measure23.test.mjs "Ledger store v2.3"; acceptance M-16 |
| ASVS V12 — archive integrity (v2.3) | The archive downloader refuses any ZIP whose SHA-256 differs from its published `.CHECKSUM` (or has none); entry names are reduced to a basename. | `tools/fetch-binance-archive.test.mjs` |
| MASVS-PRIVACY-1 | No telemetry, analytics or third-party requests. Identity stores operator display name and role only. | ADR-0003; BLD-9.4-3a |
| MASVS-CODE-4 | Static export; no `eval`/`new Function` in app code (blocked by CSP in any case). | CSP |
| MASVS-RESILIENCE | Not targeted (personal tool; no anti-tamper needed). | — |

## Gaps (open)
- **G1** Desktop compile, isolation-hook behaviour and capability enforcement are **NOT VERIFIED** on a real Tauri build (CI only).
- **G2** `style-src 'unsafe-inline'` remains (Radix UI positions popovers with inline styles). Script injection is still blocked.
- **G3** GitHub Actions are pinned by tag, not commit SHA (pin before the first shared release).
- **G4** Code signing certificates for Windows and Apple Developer ID do not exist yet; CI produces unsigned (Windows) or ad-hoc/unsigned (Apple) artifacts until the secrets are added. Android: release key made 12 Nov 2026 (v2.7.0, WP18, `tools/new-android-key.ps1`), held only as GitHub secrets and offline by the owner.
- **G5** No device testing on iOS/Android hardware yet.

## Vendored menu fonts (v2.5)

| Control | How met | Evidence |
|---|---|---|
| Fonts for the language menu ship with the app; no font CDN | Glyph subsets (11.6 KB total) of OFL-licensed Noto fonts from pinned `@fontsource` packages, built by `tools/build-menu-fonts.py`, committed under `apps/confluence/web/public/fonts/menu/` with input/output SHA-256 in `tools/menu-fonts.lock.json` | `python3 tools/build-menu-fonts.py --check`; acceptance ID-8.12a; release check R8 (no new host) |
