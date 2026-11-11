# rsL Confluence Terminal · v2.5 2026 · build 20261107

A multi-indicator crypto market scanner: 18 indicator votes per asset on closed bars, combined into one Master Signal. It is an analysis tool, not financial advice, and it never places orders.

It is built from one web core with thin native shells:

- **Tauri 2** for Windows and macOS
- **Capacitor 8** for iPhone, iPad and Android
- an installable **PWA** for any browser

The common parts come from the rsL Core Kit: storage, audit, identity, i18n, brand and platform.

Personal edition (ADR-0004): no licensing; credit line "Created by rsLozano".

New in v2.2:
- **Signal ledger and replay backtest.** Every signal is recorded and measured after costs. See `docs/measurement.md`.
- **Asset classes.** RWA, tokenised stocks, FX and commodities from the same exchanges, plus Bitget perpetuals (v2.3). See `docs/asset-classes.md`.
- **Research hygiene (v2.3).** Trials register and deflated Sharpe, label-shuffle and momentum benchmarks, PBO in replay, pre-registration, outcome snapshots, measured slippage.
- **Paper trading (v2.3).** Risk engine, proposals, approval, simulated fills, journal, kill switch — no orders are ever sent. See `docs/paper-trading.md`.
- **Phones, theme, languages (v2.5).** Expand list and compact phone header; System / Light / Dark theme (ADR-0011); readable language menu with vendored script fonts; rsL icon on Android and iPhone (release check R13); translation statuses with reviewer certification (`docs/translation-review.md`). Contributors and AI agents: read `AGENTS.md` first.

## Layout
```
rsl-confluence/
├─ packages/
│  ├─ core/                 rsL Core Kit v1.0 2026 — unchanged (KIT-MANIFEST.sha256, 21 tests)
│  └─ adapters/             tauri/ · capacitor/ · web/  — the only place native plugins are imported
├─ apps/confluence/
│  ├─ web/                  Next.js 16 static export (engine, UI, rsL identity, 18 catalogs)
│  ├─ desktop/              src-tauri/ (Cargo.toml, Cargo.lock, tauri.conf.json, capabilities/, icons/), isolation/
│  ├─ mobile/               capacitor.config.ts (android/ and ios/ are generated in CI)
│  ├─ gateway/              optional localhost gateway for read-only exchange API profiles
│  ├─ recorder/             v2.3 headless forward-test recorder + optional Telegram/webhook alerts (Node)
│  └─ mcp/                  v2.3 read-only Claude connection (MCP stdio server; no network, no orders)
├─ docs/                    adr/, runbooks/, user-guide/ (en, ar), security-controls.md, acceptance.md, …
├─ tools/                   release-check.mjs, sbom.mjs, package-pwa.mjs, apply-native-config.mjs, check-egress.mjs,
│                           egress-manifest.json, fetch-binance-archive.mjs, e2e/
└─ .github/workflows/release.yml
```

## Run the app (no build needed)
1. Install **Node.js LTS** once (https://nodejs.org).
2. Unzip `rsL-Confluence-v2.3-2026-pwa.zip` into a folder.
3. Double-click **`Start-Confluence-Terminal.cmd`** (Windows) or run `./start-confluence-terminal.sh` (macOS/Linux). The app opens on `http://127.0.0.1:8770/`, reachable from this computer only. Keep the launcher window open; close it to stop.
4. Optional: in Chrome/Edge use *Install app* in the address bar for a desktop icon (start the launcher first each time).

Opening `index.html` directly from the folder does not work: the scan worker and the offline cache need http. Desktop (.msi/.dmg) and Android (.apk) installers are produced by CI (`.github/workflows/release.yml`) and are not part of this build.

## Quick start (developers)
Requires Node 22.5 or later and pnpm 10.34.9.
```
pnpm install --frozen-lockfile
pnpm --filter @rsl/confluence-web dev          # browser dev server
pnpm test                                      # kit · engine · measurement v2.2 + v2.3 · paper · FVG · 18 catalogs · gateway · recorder · MCP · archive · egress
pnpm --filter @rsl/confluence-web replay -- --symbols BTCUSDT,ETHUSDT --tf 4h --from 2024-01-01   # backtest
npm run gateway                                # optional localhost gateway (read-only API profiles)
pnpm recorder -- --source binance --tf 4h --limit 30 --out ./recorder-data   # headless recorder (docs/recorder.md)
pnpm archive -- --list                         # archived symbols incl. delisted (survivorship-safe replay data)
pnpm typecheck && pnpm lint
pnpm build:pwa                                 # → dist/rsL-Confluence-v2.3-2026-pwa.zip
pnpm sbom && node tools/release-check.mjs --with-tests
pnpm build:desktop                             # Tauri (needs Rust + platform toolchain)
pnpm --filter @rsl/confluence-mobile sync      # Capacitor (then open android/ or ios/)
```
Acceptance: serve `apps/confluence/web/out` on `127.0.0.1:8770`, then run `pnpm e2e`. The latest run is in `docs/acceptance.md`.

## Docs
- **ADRs:**
  - 0001 shells
  - 0002 data model
  - 0003 network allowlist
  - 0004 personal edition
  - 0005 kit packaging and updater
  - 0006 features not used
  - 0007 measurement layer
- **Security:** `docs/security-controls.md` (ASVS 5.0 / MASVS v2.1)
- **Runbooks:** release and sign, rotate a key, restore from backup, migrate legacy data
- **User guides:** `docs/user-guide/en.md`, `docs/user-guide/ar.md`
- **Port audit:** `docs/port-audit.md`
- **Translation review:** `docs/translation-review.md`
- **Kit issue:** `docs/kit-issues/KIT-001.md`
- **Measurement:** `docs/measurement.md`
- **Asset classes:** `docs/asset-classes.md`
- **Paper trading (simulated only):** `docs/paper-trading.md`, ADR-0010
- **Headless recorder and alerts:** `docs/recorder.md`, ADR-0008
- **Read-only Claude connection (MCP):** `docs/claude-mcp.md`, ADR-0009
- **Archive downloader (survivorship-safe replay data):** `tools/fetch-binance-archive.mjs`

## Not verified
These items need CI or devices; they were not run in the build environment.
- Tauri desktop compile and installers (no WebKitGTK here; `Cargo.lock` resolved, `tauri.conf.json` valid against the CLI schema)
- Isolation-hook behaviour and capability enforcement at runtime
- SQLite storage on real desktop and mobile builds
- Capacitor native builds: Gradle and Xcode. The projects were generated and hardened, but not compiled.
- Code signing and notarisation (no certificates yet)
- Device tests on iPhone, iPad and Android, including the 3D monogram on iPad
- `.rslbak` file association behaviour
- Live exchange responses for the v2.2 asset classes (instrument types, weekend bars) and a replay on real history; WebKit (Safari) run of the acceptance suite
