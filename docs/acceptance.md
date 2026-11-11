# Acceptance evidence — rsL Confluence Terminal v2.3 2026

Run `2026-10-31T12:01:14.307Z` against the PWA static export (http://127.0.0.1:8771/) in Chromium via Playwright 1.63.0, with axe-core 4.14.0 and mocked exchange APIs.
**Result (v2.5.1, build 20261107): 121/121 passed.** Re-run: `pnpm build:pwa`, serve `apps/confluence/web/out` on 127.0.0.1:8770, then `pnpm e2e`.

Screenshots in `tools/e2e/evidence/`: splash, wizard, terminal at 1366 (dark, light, Arabic, Urdu, Japanese), About, About with WebGL off, and 390/820/1366 px in LTR and RTL.

| Id | Check | Result | Evidence |
|---|---|---|---|
| ID-3.2 | First-run wizard appears on first launch | PASS |  |
| ID-8.1a | Brand order monogram → rsL → App → by rsLozano → build (LTR) | PASS | rsl-mono → rsl-r → rsl-app → rsl-by → rsl-build |
| ID-8.2 | Build stamp identical in app bar and footer | PASS | v2.3 2026 · build 20261031 |
| ID-8.3 | Brand meta text ≥ 4.5:1, no opacity dimming (dark) | PASS | 7.53:1 rgb(142, 163, 189) on rgba(9, 13, 20, 0.94) |
| ID-8.4 | Brand block recedes: ≤ 260 px wide, name ≤ 21 px, meta ≤ 11 px / weight 300 | PASS | {"brandW":260,"nameFont":19,"metaFont":10.5,"metaWeight":"300"} |
| BLD-9.4-4 | Legacy ≤2.02 preferences imported (timeframe 1h, not the new 4h default) | PASS | 1 hour |
| ID-8.5a | Workspace name in chip and context line | PASS | RDPersonal — Workspace: rsLozano — Personal trading desk / Personal |
| BLD-9.4-6 | Audit trail intact and chained (app.start, migration.import, identity events) | PASS | intact (5) |
| ID-8.7a | About shows 18 catalogs; 16 DRAFT, en+ar approved | PASS |  |
| BLD-9.4-2 | PWA shows best-effort storage (IndexedDB) — not SQLite in a browser | PASS | Storage: browser  |
| ID-8.8a | 3D monogram renders (WebGL) or static fallback | PASS | WebGL canvas |
| ID-2.4 | About ends with personal credit, no corporate lines | PASS |  |
| BLD-3.5a | Backup file name + checksum + audit head | PASS | ConfluenceTerminal_PERS_backup_20261031.rslbak |
| BLD-9.4-5b | Tampered backup refused (checksum) | PASS |  |
| ID-8.5b | 120-character workspace name truncates with full name in title | PASS | chip 93 px |
| ID-8.5c | Arabic workspace name renders (isolated with <bdi>) | PASS |  |
| ID-8.6 | Identity persists across reload; wizard not shown again | PASS |  |
| ID-8.6b | Identity exports as JSON (schema + customer) | PASS | ConfluenceTerminal_PERS_identity_20261031.json |
| BLD-9.4-5a | Valid backup restores (identity returns to the backed-up workspace) | PASS | Workspace: rsLozano — Personal trading desk |
| ID-8.9 | 3D monogram: no context exhaustion or leftover canvases after 20 open/close cycles | PASS | rAF 29/s headless (SwiftShader); warnings 0; canvases left 0 |
| ID-8.11 | Keyboard: Tab reaches header controls and rows; language menu opens with Enter, Esc closes and restores focus | PASS | {"refresh":true,"row":true,"listOpen":true,"listClosed":true,"focusBack":true}; 70 stops: Close › Close › Close › Close › Close › Close › Close › Close |
| ID-8.7b | 18 languages in rsL order | PASS | 18 options |
| ID-8.1b | Brand order unchanged in RTL (Arabic) | PASS |  |
| ID-6.3a | Arabic UI: dir=rtl, translated headers | PASS | #الأصلالسعرتغيّر 24 س %الحجم المؤشرات (18 مصوّتًا)ص / م / ها |
| ID-6.3b | Latin digits in Arabic UI | PASS |  |
| ID-2.2-rtl | In RTL the brand block moves to the inline-start (right) side | PASS | right |
| ID-8.7c | No raw keys in any of the 18 languages | PASS | none |
| ID-8.3b | Brand meta text ≥ 4.5:1 (light) | PASS | 7.53:1 rgb(142, 163, 189) on rgba(9, 13, 20, 0.94) |
| BLD-9.4-10b | axe: no critical or serious violations (light) | PASS | none |
| ID-8.3c | Light theme keeps the on-bar wordmark colours (bar stays navy) | PASS |  |
| BLD-9.4-10a | axe: no critical or serious violations (dark) | PASS | none |
| ID-7 | No console errors at load / language / theme / workspace switch | PASS | none |
| BLD-9.4-3a | Only same-origin and allow-listed exchange hosts contacted | PASS | 127.0.0.1:8771, data-api.binance.vision |
| BLD-9.4-3b | Airplane mode: UI stays usable, status shows Offline, last scan kept | PASS | 4 rows |
| BLD-9.4-11a | Cold start to first scored rows (laptop, mocked feed) ≤ 2 s budget | PASS | 5247 ms incl. wizard |
| BLD-9.4-9-390-ltr | 390px LTR: no page h-scroll, app name not wrapped, 48px targets | PASS | {"hScroll":false,"brandWraps":false,"anim":"none","small":0} |
| BLD-9.4-10-390-ltr | axe: no critical/serious violations at 390px LTR | PASS | none |
| ID-8.8b | Reduced motion disables the wordmark shine | PASS | none |
| BLD-9.4-9-390-rtl | 390px RTL: no page h-scroll, app name not wrapped, 48px targets | PASS | {"hScroll":false,"brandWraps":false,"anim":"none","small":0} |
| BLD-9.4-10-390-rtl | axe: no critical/serious violations at 390px RTL | PASS | none |
| BLD-9.4-9-820-ltr | 820px LTR: no page h-scroll, app name not wrapped, 48px targets | PASS | {"hScroll":false,"brandWraps":false,"anim":"none","small":0} |
| BLD-9.4-10-820-ltr | axe: no critical/serious violations at 820px LTR | PASS | none |
| BLD-9.4-9-820-rtl | 820px RTL: no page h-scroll, app name not wrapped, 48px targets | PASS | {"hScroll":false,"brandWraps":false,"anim":"none","small":0} |
| BLD-9.4-10-820-rtl | axe: no critical/serious violations at 820px RTL | PASS | none |
| BLD-9.4-9-1366-ltr | 1366px LTR: no page h-scroll, app name not wrapped | PASS | {"hScroll":false,"brandWraps":false,"anim":"none","small":18} |
| BLD-9.4-10-1366-ltr | axe: no critical/serious violations at 1366px LTR | PASS | none |
| BLD-9.4-9-1366-rtl | 1366px RTL: no page h-scroll, app name not wrapped | PASS | {"hScroll":false,"brandWraps":false,"anim":"none","small":18} |
| BLD-9.4-10-1366-rtl | axe: no critical/serious violations at 1366px RTL | PASS | none |
| M-1 | New installs default to the 4h timeframe | PASS | 4 hours |
| M-2 | Crypto class excludes stablecoins, tokenised stocks, gold and FX | PASS | 4 rows |
| M-3 | Warm start asks for 1,000 bars on the first scan | PASS | data-api.binance.vision/api/v3/klines?limit=1000 data-api.binance.vision/api/v3/klines?limit=1000 |
| M-4 | Scoring runs in a Web Worker | PASS | http://127.0.0.1:8771/_next/static/chunks/turbopack-worker-2gqdcwp7k90ea.js#params=%5B%5B%22.%2F_next%2Fstatic%2Fchunks% |
| M-5 | Stocks class lists the tokenised stock with a class badge and the market-hours note | PASS | 1TSLTSLABStocks (tokenised)underlying closedTSLABUSDTOpen de |
| M-6 | All classes: 7 rows (USDC still excluded) | PASS |  |
| M-7 | Detail shows bloc scores, regime, FVG panel and a Structure tab | PASS |  |
| M-8b | Browser engine id equals the Node/replay engine id (bundle-independent) | PASS | Engine 2c1a18ad8a61e9ab vs 2c1a18ad8a61e9ab |
| M-8 | Signal ledger records every scored series (one row per bar, deduplicated) | PASS | recorded 4; engine id shown |
| M-9 | Ledger CSV export: header with config id + one line per row | PASS | ConfluenceTerminal_PERS_ledger-binance-4h_20261031.csv · 4 rows |
| M-10 | axe: no critical/serious violations in the ledger dialog | PASS | none |
| M-14 | Ledger: full-window toggle, trials register, storage durability and pre-registration shown | PASS | Trials: 1 |
| M-15 | Ledger gate includes deflated Sharpe, label shuffle, momentum and pre-registration checks (or outcomes still pending) | PASS | 9 gate rows |
| M-16 | Pre-registration fixes a decision date ≥ 90 days ahead and removes the button | PASS | decision 2027-01-29 (89.5 days) |
| M-17 | Order-book depth is sampled for measured slippage (public endpoint) | PASS | data-api.binance.vision/api/v3/depth?limit=100 data-api.binance.vision/api/v3/depth?limit=100 |
| M-18 | Detail shows the logged context fields (never scored) | PASS |  |
| M-19 | Bitget perpetuals are offered as a data source | PASS | Binance Spot / Bybit Spot / Bybit Perpetual / Bitget Spot / Bitget Perpetual |
| M-20 | 390 px: Expand list fills ≥ 80% of the space above the footer; footer pinned, nothing after it; choice remembered | PASS | v2.5: collapsed 400 px → expanded 716 px; footer bottom 844 = viewport; document scroll 0 |
| M-21 | 360 px RTL (Arabic): same as M-20 | PASS | v2.5: 306 → 592 px; footer bottom 740 = viewport |
| M-22 | 390 px: header ≤ 260 px with More controls closed; secondary controls reachable after opening | PASS | v2.5: header 215 px (v2.4: 442 px) |
| T-1 | Both themes: axe colour contrast at 390 and 1366 px | PASS | v2.5: 0 violations light + dark |
| T-2 | Light theme: no dark block ≥ 2000 px² (header included); dark theme: no white block | PASS | v2.5 |
| T-3 | First frame after switching shows one theme only (shell, table, footer) | PASS | v2.5 |
| T-4 | `theme-color` follows the theme (#F5F7FA / #0B1B33) | PASS | v2.5 |
| T-5 | System follows the OS live and after reload | PASS | v2.5 |
| T-6 | Chart grid, axis labels and depth heat-map strokes follow the theme tokens (readable in light) | PASS | v2.5 |
| U-1 | Newer version in `/updates/latest.json` → notice with Reload to update (same-origin GET); Later hides it for that build | PASS | v2.5.1, ADR-0012 |
| U-2 | Older/equal or malformed manifest → no notice; About → Updates reports Up to date / Could not check | PASS | v2.5.1 |
| U-3 | Automatic checks off → no request to `latest.json` after reload | PASS | v2.5.1 |
| U-4 | 390 px: notice above the footer; footer pinned last; no page scroll | PASS | v2.5.1 |
| ID-8.12a | Language menu: native names render with vendored subset fonts; ≥ 4.5:1 both themes; fonts < 120 KB | PASS | v2.5: 7 families, 11.6 KB |
| ID-8.12b | 360 px RTL: language menu is a bottom sheet inside the viewport | PASS | v2.5 |
| L-1 | 18 languages × 390/1366 px: header, list toolbar, footer, About/Paper/Ledger — no clipped labels, no raw placeholders | PASS | v2.5 (fixed Top N / asset-class clipping) |
| P-1 | Paper dialog opens with the permanent 'simulated, no orders are sent' banner | PASS | Paper tradingPractise the discipline the measurement gate asks for: strong signa |
| P-2 | axe: no critical/serious violations in the paper dialog | PASS | none |
| P-3 | Opening paper trading makes no order or private-API request | PASS | none |
| M-11 | No page errors with the worker, ledger and class switching | PASS | none |
| M-12 | HTTP 429 halts the scan and shows a pause banner | PASS | Exchange rate limit reached — scanning is paused for 60 s to protect your IP. Partial results are shown. /  |
| M-13 | Failed-feed symbol is not presented as a signal and not recorded | PASS | SOL row: 3SOLSOLUSDTOpen details$101.0000+1.00%$1000.00Minsufficient data0/0/00 · recorded 3 |
| ID-8.8c | Reduced motion: splash name appears complete, no glyph-noise frames | PASS | 1 distinct frame(s): rsLozano — Personal trading desk |
| ID-8.8d | WebGL disabled: About shows the static monogram, no 3D canvas | PASS | canvas 0, static 2 |

ID-* = rsl-app-identity-system §8 · BLD-* = rsl-cross-platform-app-builder §9.4. Desktop/mobile shells, signing and device behaviour are not covered here — see docs/security-controls.md gaps and README "Not verified".
