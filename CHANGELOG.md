# v2.8.0 — in progress, Steps 1 to 3 (not released; app still reports v2.7.0)

Steps 1 to 3 of the v2.8 plan (`docs/superpowers/specs/2026-11-15-v2.8-architecture-design.md`): safety fixes, licence
credits and smooth loading (Step 1); OKX, Coinbase and Upbit as scan sources (Step 2); Fund trend (Step 3). Engine 2.4.0 (`5c30b5c39f5ba3f2`);
ledger rows of engine 2.3.0 stay and are reported separately.

- **Paper safety (WP19):** 10% drawdown lock (Stop + close all at the next open of each chart; pending positions cancelled;
  typed RESET restarts the 10% from current equity, disabled while closes are pending); open losses count in the daily and
  weekly locks; no loosening while a lock is active; costs inside the risk budget (a clean stop-out ≈ −1 R); event
  blackout around FOMC/CPI/NFP (2 h before, 1 h after; ECB never blocks) with 2027 dates; crypto cap 3; depeg gate;
  time stop (off, preset 24 bars); intraday proposals off by default; total notional capped at 1×; risk > 1 % warning;
  measured slippage in fills; More statistics (profit factor, Wilson range, R histogram, MAE/MFE), Add a note, rejected
  proposals with their bracket outcome. New limits in a collapsed **More limits** section.
- **Signals and measurement (WP19):** Pattern calls a direction only past a Wilson lower bound (20–40 analogues, "Too few
  analogues"); FVG minimum gap 0.5 × ATR(14), "FVG adjustment (unvalidated)"; honest wording for paper, power, macro and
  reversal; ledger records the 18 votes, Pattern and derivative context, shows days needed at the current Sharpe and imports
  CSV; confirmatory DSR counts active pre-registrations; ATR-bracket outcome in the replay CLI; noise regressions.
- **Data (WP19):** Binance quote volume and trade count, a crypto liquidity floor (default $1M, scan setting; a pair holding
  a paper position still gets its bars for the simulator), used-weight pacing in the Node tools; the gateway refuses write
  or unknown-permission keys (Bitget: only known read-only authorities pass).
- **Licences (WP20):** THIRD-PARTY-NOTICES.txt in every bundle, About → Open-source licences with the trademark line, full
  OFL font texts, Rust and mobile notices, WebView2 terms, rate-provider credits (ExchangeRate-API, ECB), SBOM licences and
  scope, release check **R24** licence policy, Binance Vision archive notice, root `LICENSE`.
- **Smooth loading (WP27):** rows appear at once from on-device history ("updating" / "not updated" badges, display only),
  watchlist or top 10 first, then batches of 20, delta fetch of new bars only; acceptance PG-1, PG-2.
- **New exchanges (WP26, ADR-0018):** **OKX Spot**, **OKX Perpetual** (USDT-margined), **Coinbase (US)** (USD, USDT) and
  **Upbit (KR)** (KRW, USDT, BTC) are scan sources, with public prices only and no keys, orders, referral codes or embedded
  pages. Closed bars only: OKX's open bar (`confirm "0"`) and the forming row of Coinbase and Upbit are never scored. Pages
  are merged without duplicates, capped at 16 requests per series (OKX needs at most 5) and scored cold below 1,000 bars. Each venue is paced
  at 80 % of its documented limit (OKX candles 16/s and history 8/s; Coinbase 8/s; Upbit 8/s).
  - Timeframes a venue lacks are built from complete shorter candles: Coinbase weeks start Monday 00:00 UTC and its
    months are calendar months.
  - Upbit's KRW prices follow the display currency; its BTC-market prices stay in BTC. Volume is valued with Upbit's own
    KRW-USDT and USDT-BTC markets (R21). Without KRW-USDT, KRW volume is unknown, never "NaN".
  - Paper trading: Coinbase USD and USDT pairs can be proposed; Upbit KRW and BTC pairs are refused. Upbit fees per
    market: KRW 5 bps, BTC and USDT 25 bps (secondary source). A scan whose every series is unavailable shows "Blocked or
    unreachable".
  - Hosts: `www.okx.com` and `api.exchange.coinbase.com` are fetched directly (CSP). `api.upbit.com` is reached only
    through the read-only relay: the `/x/upbit/` rewrite on the web, path-scoped native access in the apps (ADR-0003
    amendment, R8/R16). A refused relay is "feed unavailable" for Upbit alone.
- **View on [exchange] and Data sources & thanks (WP26):** the detail sheet ends with a plain link to the pair on the
  exchange's own site, opening in the browser. About gains a collapsed **Data sources & thanks** listing 13 providers with
  their API docs and terms, as names in text. Venue terms and link patterns are to be checked by the owner before
  release (ADR-0018). Acceptance **EX-1**…**EX-6** and **ID-2.6**.
- **Fund trend (WP21):** a second opinion from closed daily bars, adapted from the published time-series-momentum research
  (Moskowitz–Ooi–Pedersen 2012; Hurst–Ooi–Pedersen 2017), not any fund's positions: −100…+100 from 30, 91 and 365-day
  returns scaled by EWMA volatility, plus **Fund size** (40 % volatility target, at most 200 %). Crypto only, at least 366
  daily bars, else "not enough history" or n/a; daily bars are fetched once per coin per UTC day behind the scan, on builds
  that fetch directly (the hosted web version shows n/a). Off by default: **Fund trend ribbon** and **panel** (Confluence
  score, Fund trend, Fund size, Fund rank) at the end of the chart's Indicators menu; disagreement hatching and ◆ (score
  at least 55 against Fund trend of the opposite sign at 25 or more; list ◆ only with the ribbon on); **Disagreement
  pulse** (3 pulses, Off, Keep pulsing) and an optional **Fund rank** column in Scoring profile. The ledger records `ft`
  and the report adds **Fund trend sign** beside 20-bar momentum; CSV column `fund_trend`. It never votes: engine
  `5c30b5c39f5ba3f2` unchanged. Acceptance **FT-1**…**FT-5**.
- **Design unchanged (spec §3):** acceptance **DS-1** (main screen) and **DS-2** (detail sheet top and chart layers, paper
  dialog, ledger dialog) compare the layout at rest with text masked against baselines captured from the v2.7.0-web build.
- **Languages:** the new and changed v2.8 strings are Arabic drafts awaiting native-speaker review (About shows the count;
  release check **R25** blocks a release until they are reviewed); the other 16 languages show them in English for now.
- **Coffee tip card (owner addition, no WP):** About → *☕ Treat the developer to a coffee*, collapsed above Open-source
  licences — the rsL Coffee Kit v1.1 2026 (build 20261115) card images for GCash, PayPal and Bitcoin, copied unchanged
  into `src/rsl/coffee-kit.json` and shown verbatim; optional and never a fee (nothing gated, never opens by itself); only
  Bitcoin has **Copy address**. Unit tests pin the six image hashes and scan for contact details; acceptance **CK-1**.
- **Docs:** user guide chapters for WP19, WP20, WP26 and WP27; ADR-0018 (new venues); R19 accepts this "in progress" entry above the released v2.7.0.
- **Before going back to v2.7, export the paper journal** (Paper → Export CSV) and note your open positions: v2.7 cannot
  read the v2.8 paper account format and starts a fresh 10,000 USDT account over it on its first scan.

# v2.7.0 — 11 November 2026 · build 20261111

Stablecoin quotes on every exchange, any display currency at official reference rates, and a chart that zooms, pans and
goes full screen. Engine unchanged (2.3.0, `2c1a18ad8a61e9ab`); USDT scans are identical to v2.6.

- **Android: uninstall v2.6 first (new signing key, WP18).** Export a backup (About) and the ledger, uninstall v2.6, install v2.7.0, restore. The paper account is not in backups. Later updates install normally.
- **Stablecoin quote pairing (WP12, ADR-0015):** a **Quote** menu per source — USDT (default), USDC, FDUSD, USD1, USDE,
  RLUSD, XUSD, U, EURI as the exchange lists them, or **Best USD stablecoin** (deepest dollar-stablecoin pair per coin,
  25 % hysteresis). Bybit and Bitget USDC-margined perpetuals (`BTCPERP`). Volumes valued at the stablecoin's own price on
  the same venue; one real pair's candles per coin, never blended. Depeg banner at 0.5 / 1 / 2 % (information only).
  One `splitPair` replaces the USDT-suffix regexes (BTCFDUSD was read as "BTCFD"); non-USDT pairs are classed as their
  USDT twin.
- **Display currency (WP13, ADR-0015):** Auto (device region), USD or about 160 currencies. Frankfurter v2 central-bank
  rates → fawazahmed0 fallback → built-in Gulf pegs offline; the rate line names the rate kind (peg/band/official/reference),
  source and date, and shows USDT's real USD price (prices use 1 USDT = 1 USD). Display only — release check **R21**.
  Three new `connect-src` hosts (ADR-0003 amendment v2.7).
- **Rate sources (owner request):** **⇄ Rate sources** lets you choose *Automatic*, Frankfurter or one of four
  alternatives (European Central Bank, ExchangeRate-API open access, fawazahmed0, FloatRates); **Update now** and
  automatic updates every 6 hours; every source shown with publisher, method, coverage, cadence, terms, website and the
  exact data address to verify it (Frankfurter: the central banks behind each rate). A **custom source** (not listed) can
  be imported from its rates file, marked *not tested*, with a pre-filled written request to the developer to add it.
  Three more `connect-src` hosts (ADR-0003 amendment v2.7).
- **Chart (WP14):** zoom (buttons, + / −, Ctrl/⌘+wheel, trackpad and two-finger pinch) anchored at the cursor, pan (drag,
  Shift+wheel, Shift+arrows), reset (0, double-click/tap), full screen (Fullscreen API, or a Focus view on iPhone and in the
  apps; desktop window full screen through `core:window:allow-set-fullscreen`; Esc / Android Back leaves full screen
  without closing the sheet). Candles thinned to one per 1.5 px and static layers memoised (10,000-bar views stay fast).
- **Fixes from the v2.6 review (WP15, `docs/reviews/2026-11-11-v2.6-code-review.md`):** chart crash when the depth shrank
  under an inspected candle; Bollinger bands missing on the first 19 visible bars; "Load 5K older" could store one source's
  bars under another source's key; paper trading booked Coins.ph peso amounts as USDT (now refused) and allowed BTCUSDT and
  BTCPHP as separate positions; beta / excess-over-BTC empty on Coins.ph; R8 hard-coded its allowlist (now one host table
  shared by both CSPs, R8 and ADR-0003); R6 wildcard detection; empty translations passed the catalog check; monitor
  assets typed as `BTC-USDT` were dropped on restart; key levels showed `5.000e-1`; duplicate axis labels on tight ranges.
- **User guide (WP16):** v2.7, full 22-chapter guide in the repository; new sections for quotes, display currency and chart
  zoom / full screen. 21 new labels in all 18 catalogs.
- **Second review (12 findings, all fixed):** Focus-view full screen inside the sheet on iPhone/apps/desktop, rates for
  Coins.ph/EUR scans with a USD display, rate-line wording, chart view on "All saved" and on older-history loads,
  scroll-vs-tap, `DOTUSD` input, Auto currency from the time zone, depeg readings in USDT scans, axis labels, desktop
  full-screen restore, paper base asset per venue, transitive R21.
- **Release workflow (WP17):** the Android keystore secret is accepted with Windows line endings or `certutil`
  headers; publishing the web or Linux release no longer starts another release run.
- **Android signing key rotated (WP18), 12 Nov 2026:** new release key made on the owner's PC with
  `tools/new-android-key.ps1` (RSA 4096, PKCS12, alias `rsl-conf`), stored only as GitHub secrets and offline; reason:
  the v2.6 key's secret was not usable and the original file was not found. A `[release-android]` commit on `main`
  builds only Android and the update channel after the full gate (like `[release-apple]`).
- **Checks:** unit suites + quotes 62, FX 47, chart view 8; release checks R1–R21; browser acceptance adds SQ-8, FX-7,
  FX-14, FX-15, CH-1, CH-4, CH-5, CH-5b, CH-6.

# v2.6.0 — 7 November 2026 · build 20261107

Adds the Philippine peso market from Coins.ph (public data only, no account), protected builds,
five new release gates and plain source-health safeguards. Engine unchanged (2.3.0, `2c1a18ad8a61e9ab`).

- **Coins.ph (PH) source (WP7, ADR-0013):** peso-quoted pairs with ₱ prices and USD volume, a local-market note,
  thin pairs (under about $250k a day) counted and not scanned, USDT/PHP and USDC/PHP under Currencies, and the PH
  premium against the global price (information only, never scored). Coins.ph sends no CORS header, so the web app
  reaches it through a same-origin rewrite of the read paths (`/x/coinsph/…`, Netlify and the local launcher) and
  the Android, iPhone and desktop apps through a path-scoped native GET. `connect-src` is unchanged. Request pacing
  stays under Coins.ph's 120-per-minute limit; a 429/418 pauses this source only. Cooldowns are now per venue for
  every source. PDAX, GCash, Maya, GoTyme and UnionBank have no public price feed and are not included.
- **Market data is never cached offline:** the service worker now passes `/x/` straight to the network, so peso
  prices are never served from the offline copy (acceptance PH-13). The currency label and premium change together
  with the rows, so earlier rows never show ₱.
- **Protected builds (WP8, ADR-0014):** the app's own chunks are obfuscated (renamed identifiers) on every platform,
  with no source maps and no raw worker sources. Framework chunks stay byte-identical. The minified build and a
  manifest linking both by SHA-256 are kept as CI artefacts for audits. Engine results identical (120/120 replay),
  scan time −0.1 %, total JS +3.5 %.
- **Release gates (WP9):** R16 public-host table, R17 protected build (incl. the +15 % size cap), R18 protected
  equivalence (acceptance + engine replay on the exact protected tree), R19 plan and user-guide parity, R20 keyless
  public sources.
- **Source health (WP10):** the footer shows OK, Slow, Rate-limited, Blocked or unreachable, Network blocked or
  Stale for the current source. About shows the source commit and a data notice; the update notice shows the
  download fingerprint.
- **User guide (WP11):** rewritten for v2.6 (English). The Arabic guide awaits its reviewer.
- **New release channels (WP11):** Linux desktop (`.deb`, `.rpm`, `.AppImage`) and a web release (the PWA zip with the
  local launcher, plus the SBOM). Every platform is built from the same commit in one run.
- **Release pipeline:** the website publish step fails when the Netlify token is missing instead of passing without
  deploying; the Android/iPhone icon checks run in their own Python environment.
- **Checks:** acceptance 128/128 on the protected build (PH-9…13, US-1, US-1b added).

# v2.5.1 — 7 November 2026 · build 20261107

Adds the update channel (ADR-0012): GitHub Actions publishes each release to Netlify, and the app
tells you when a newer version exists. Engine unchanged (2.3.0, `2c1a18ad8a61e9ab`).

- **Update notice:** at launch and every 6 hours the app reads one public file, `/updates/latest.json`, and shows a notice when a newer version is published. The notice offers Reload on the web, Download update on Android, and install instructions on iPhone and desktop. Nothing is sent.
- **About → Updates:** check automatically (on by default), Check now, and the last result.
- **Release publishing:** release runs deploy the PWA, `latest.json` and the signed APK to Netlify in one atomic deploy. This needs the `NETLIFY_AUTH_TOKEN` repository secret.
- **Web app:** a new version now waits for Reload instead of switching code mid-session. The service worker is re-versioned with every build (release check R15).
- **Checks:** acceptance U-1 to U-4 added (121/121 passing), and release checks 15/15.

# v2.5.0 — 7 November 2026 · build 20261107

Restores the phone layout lost in v2.4, replaces the light-theme overrides with a real theme
system, makes every language readable in the menu, puts the rsL icon on Android and iPhone,
and adds an honest translation status path. Engine unchanged (2.3.0, `2c1a18ad8a61e9ab`).

- **Phone list restored (WP1):** Expand list, fixed full-viewport shell (nothing below the
  footer), compact footer and 16 px touch inputs — removed by the v2.4 upload (commit 90fa621;
  see docs/reviews/2026-11-07-v2.4-session-diagnosis.md). Phones (< 640 px) get a compact header
  (215 px, was 442 px) with secondary controls behind **More controls**. Acceptance M-20, M-21, M-22.
- **Theme (WP5, ADR-0011):** System / Light / Dark. One palette per `data-theme`; the light theme
  has a light app bar, no dark-on-dark controls and no half-switched frames; System follows the OS
  live; `theme-color`, Android/iOS status bar and the desktop window follow. Acceptance T-1…T-5.
- **Language menu (WP3):** vendored glyph-subset Noto fonts (11.6 KB, OFL) so every native
  language name renders on any device; AA contrast; bottom sheet on phones. ID-8.12a/b.
- **App icon (WP2):** the rsL icon on Android (adaptive, tile-coloured) and iPhone (opaque
  1024 px), copied by `tools/apply-native-config.mjs`; release check **R13** verifies the built
  APK/IPA (v2.4 shipped Capacitor's default icon — REA evidence `ev_a8a8651a…`).
- **Translations (WP4):** statuses APPROVED / CERTIFIED / MACHINE-CHECKED / DRAFT. The 16 tier-2
  languages are **machine-checked** (all automated checks + acceptance L-1 across 18 languages at
  390/1366 px); **certified** needs a named native speaker's approval in a GitHub PR (template +
  CI job `i18n-certification`). Safety statements are hash-locked. Fixed clipped Top N / asset-class labels.
- **Guards:** release check **R14** (acceptance checks cannot disappear without an ADR);
  `AGENTS.md` / `CLAUDE.md` working rules (start from `main`, never upload a snapshot over it).
- Acceptance 117/117 locally; release checks 14/14.

# v2.4.0 — 5 November 2026

Added chart indicator settings, scanner presets and watchlists, recorder
alert rules and inbox, optional gateway sync, visual replay paper fills,
trade annotations, Bybit derivatives and order-flow tools, and scoring
profiles. Windows launcher opens the browser after the server starts.
Upgrade and offline ledger checks are recorded in docs/upgrade-v2.4-audit.md.

# Changelog — rsL Confluence Terminal

## v2.3 2026 · build 20261101 — mobile list layout (lost in v2.4, restored in v2.5)
- **Expand list:** a toolbar above the asset table hides the header controls and informational notes so the list fills the screen (on a 390 px phone the list grows from about 228 px to 716 px). In expanded mode the bar shows the asset count, timeframe, source, last update and a refresh button. **Show controls** restores the header. The choice is remembered per device. Alerts (stale feed, rate limit, errors) stay visible.
- **Footer pinned, nothing after it:** the screener is now a fixed full-viewport shell, and document scrolling is locked while it is open, so no blank space can appear below the footer on mobile browsers (including older browsers without `dvh`).
- **Compact footer on phones:** the status, legend, Powered-by stamp and credit flow into short lines. The footer is about 65 px tall at 390 px, down from about 103 px, and the credit stays last.
- **No input zoom on iOS:** text fields use 16 px on touch devices, so focusing Filter or Watch no longer zooms and shifts the page.
- **Phone builds:** new `.github/workflows/mobile.yml` builds a **signed Android APK** and an **unsigned iPhone IPA** (for Sideloadly) as two separate jobs and downloads. The native projects are stamped with version 2.3 (20261101). See `docs/runbooks/phone-builds.md`.
- 3 new catalog keys × 18 languages (`list.expand`, `list.collapse`, `list.expandHint`; Tier 2 DRAFT). Acceptance **74/74**: new check M-20, and the ID-8.11 keyboard walkthrough now waits for the last dialog to close. Engine unchanged (2.3.0, id `2c1a18ad8a61e9ab`).

## v2.3 2026 · build 20261031 — research hygiene, paper trading, recorder, Claude (read-only)
Closes the v2.2 gap report (phases A–G; execution limited to **paper only**). Engine **2.3.0**, id `2c1a18ad8a61e9ab` — v2.2 ledger rows are kept but never pooled with v2.3 rows.

### Added — measurement (phases A–B)
- **Per-series catch-up cursors**: a pair that joins the top-N later is caught up from its own last bar.
- **Universe log**: each bar stores the full unfiltered venue ranking (top 300, all classes); rows carry `universe_rank_full` and `rank_source` (live / now / none). Catch-up rows get today's rank, labelled as such.
- **Primary statistics on full 1,000-bar windows**, with a ≥ 300-bar toggle.
- **Outcome snapshots** stored with each bar (a delisted pair keeps its results; costs re-applied).
- **Wilson and bootstrap 95 % intervals**, **BTC-excess**, **20-bar momentum** and **label-shuffle** benchmarks in the dialog and replay.
- **Trials register** feeding the deflated Sharpe (app: per variant viewed; replay: `trials.jsonl`). Survives a ledger clear.
- **Pre-registration** with a fixed decision date ≥ 90 days ahead; part of the gate; audited.
- **PBO (CSCV)** in the replay report over horizon × strength variants.
- **Measured slippage**: daily order-book sample of the top 10 pairs; per-class cost extras otherwise.
- **Storage durability** status / request and a **weekly export** reminder.
- `tools/fetch-binance-archive.mjs`: data.binance.vision downloader with **SHA-256 CHECKSUM verification**, built-in ZIP reader and a `--list` that marks **delisted** symbols.

### Added — asset classes and context (phases D–E)
- **Regular-session bars** for tokenised stocks; **split guard**; FX and CME holiday rules (simplified, NOT VERIFIED); **turnover floor** ($250k/24 h) for non-crypto; **basis / band-pinned** flag on perps; manual **earnings list** (ships empty).
- **Bitget perpetuals** source (`bitget-perp`; v2 mix endpoints, field names NOT VERIFIED live).
- **Logged context fields** (never scored): relative-strength percentile, beta to BTC, higher-timeframe trend, taker delta (Binance), macro-event distance — in rows, CSV and the detail panel.

### Added — automation (phases C, F, G)
- **Headless recorder** (`apps/confluence/recorder`): records the ledger, funding and open interest without the app open; optional Telegram / webhook alerts with the token redacted from logs. See docs/recorder.md, ADR-0008; egress manifest + `tools/check-egress.mjs`.
- **Read-only Claude connection** (`apps/confluence/mcp`, MCP stdio): seven analysis tools over the exported ledger; no network, no order path; every answer ends "Analysis only — not financial advice.". See docs/claude-mcp.md, ADR-0009.
- **Paper trading**: risk engine, proposals with single-use nonces, approval, simulated fills at the next bar open, costs and funding, journal, daily/weekly loss locks, kill switch and dead-man switch. **No orders are ever sent** (boundary unit-tested). See docs/paper-trading.md, ADR-0010.

### Changed
- Engine fingerprint now includes the stock session filter and the split guard.
- Ledger CSV gains 12 context columns (incl. `universe_rank_full`, `engine_bars`).
- Row assembly shared by app and recorder (`lib/scan-record.ts`); ledger import (recorder JSONL / JSON export, validated, live rows only).
- Tests: measurement v2.3 suite (87), paper (138), archive downloader (13), recorder (31), MCP (26); release checks R11 (egress) and R12 (no order path); acceptance adds M-14…M-19 and P-1…P-3.

### Fixed after independent code review (docs/reviews/Confluence-Terminal-v2.3-Code-Review.md)
- **Cost-neutral edge** (critical): base rates, benchmarks and the 2× check now pay the same costs as the signals they are compared with.
- Label test permutes labels **within each bar** (the independent draw rejected a true null ~35 % of the time).
- Pre-registration is scoped to its view and the gate reads only rows recorded after it; trials counted across engine versions and per horizon.
- Catch-up: no back-fill for new pairs (selection look-ahead), cursors advance only after successful writes, holes beyond 48 bars logged as gaps.
- Stock rows record the bars the engine saw; outcomes across a stock split are not measured.
- Universe stored once per source × bar outside the row documents; snapshots in their own keys; both count toward the row cap.
- Report built in a Web Worker; replay/app/recorder rows identical (venue types, volume rule); one trial schema for app, replay and MCP.
- Archive tool runs from paths with spaces/Windows, caps downloads and inflation, restricts hosts; Bitget UTC candles and pacing; MCP and paper use per-class costs; accessible radio groups and symbol text.

## v2.2 2026 · build 20261031 — measurement layer, asset classes, fixes
### Added
- **Signal ledger (forward test)**: every scored closed bar is recorded with the engine id; toolbar → Ledger shows hit rate vs base rate, net expectancy after fees/slippage/funding, edge over base, profit factor, rank IC, PSR, score calibration and an indicative go/no-go check. CSV/JSON export (audited). Exported separately (not in backups). See docs/measurement.md.
- **Engine id**: hash of version, parameters and behaviour on a fixed series; pinned in tests; identical in browser and Node.
- **Replay backtest** (`pnpm --filter @rsl/confluence-web replay`): same scoring path and window as live; exchange history or data.binance.vision CSVs; in-sample vs out-of-sample; momentum baseline; deflated Sharpe for N trials.
- **Asset classes**: Crypto · RWA · Stocks (tokenised) · Currencies (FX) · Commodities · All — from the existing three exchanges (Bybit instrument types; bStocks, xStocks, Ondo tokens, fiat stablecoins, tokenised gold). Class badges, "underlying closed" badge, market-hours note, FX volatility profile. See docs/asset-classes.md.
- Detail view: bloc scores with regime (efficiency ratio and contrarian weight), fair-value-gap panel (modifier, reason, zones) and the missing **Structure** tab (FVG).
- Scoring runs in a **Web Worker** (main-thread fallback).
- Measurement test suite (102 checks); acceptance suite now 64 checks.

### Fixed
- **Warm-up bias**: the engine always scores a fixed 1,000-bar window; first scans request 1,000 bars.
- **Exchange rate limits**: HTTP 429/418 and Bybit/Bitget error envelopes now halt the scan, keep partial results, pause new scans (Retry-After when readable, else 60 s / 10 min) and show a banner. Error envelopes are no longer read as empty candles.
- **Volume flag** was hard-coded "available"; volume is now detected per series.
- **Reversal detector**: flat-series RSI read 100 (fired false RSI exits) and Supertrend started bullish; both now match the main engine.
- **Crypto universe leaks**: Bybit stock/commodity perps (TSLAUSDT, COINUSDT, XAUUSDT…) were ranked as crypto; JUPUSDT and SYRUPUSDT were dropped as "leveraged tokens".
- `npm run gateway` (documented) did not exist — added at the root and in the gateway package.
- CI gate now runs on every push and pull request (installers only on tags).
- New installs default to the 4 h timeframe (saved choices kept).

### Fixed after independent code review (docs/reviews/Confluence-Terminal-v2.2-Code-Review.md)
- **Statistics no longer treat overlapping outcomes as independent** (critical): non-overlapping outcomes per series, block-aggregated PSR, spaced IC cross-sections; noise now passes the gate ~3 % instead of ~50 %.
- Failed-feed symbols are not scored from cache or recorded as live; report no longer crashes above ~125k rows; per-bar ledger documents instead of rewriting a growing day bucket; exact gap check for long horizons; funding included in base rates.
- Catch-up from a persisted cursor with full windows, worker-only; worker per-job error isolation and 120 s timeout; ledger view no longer re-measures on every refresh and shows errors.
- Ledger in its own browser database (no main IndexedDB upgrade); storage-full recovery; `clear()` serialised with writes; Bybit 403 bans treated as rate limits; exchange symbols validated and URL-encoded.
- Replay: gap-aware windows, CSV files filtered by interval, in-/out-of-sample embargo. Engine id now covers the scoring pipeline (window, FX profile, volume detection).
- CI: Android signing step works (and warns when unsigned); release-check R8 reads the real web CSP source; acceptance checks for the worker and failed feeds can now fail.
- NYSE holidays/early closes 2026–2028 and a macro-event banner (FOMC, CPI, jobs report, ECB).

### Changed
- Version 2.2.0; engine 2.2.0 (`6dbcfdc424942e02`). Service-worker cache renamed so installed PWAs update.

## v2.1 2026 · build 20261031 — rsL cross-platform port
**Platforms:** Windows and macOS (Tauri 2.12.5), iPhone/iPad and Android (Capacitor 8.6.0), browser PWA — one web core.

### Added
- rsL identity: brand block (monogram → rsL Confluence Terminal → by rsLozano → build), splash with signature art and greeting, first-run wizard (language, workspace, name), workspace chip, About with 3D monogram (static fallback), Powered-by stamp, "Created by rsLozano" at page end.
- 18 languages in rsL order with RTL for Arabic and Urdu, Latin digits, searchable language menu with SVG flags; English and Arabic approved, 16 drafts marked in About.
- Records (preferences, identity, audit, meta) in the rsL Core Kit StoragePort: native SQLite on desktop/mobile, IndexedDB/localStorage in the PWA with a visible non-durable notice.
- Hash-chained audit trail, guarded clock, `.rslbak` backup export/restore with checksum and tamper refusal, backup reminder.
- Native menus (desktop), Android back handling, single instance and window state (desktop).
- Release tooling: `release-check.mjs` (10 gates), CycloneDX SBOM, PWA packager, Playwright + axe acceptance suite (50 checks), CI matrix.

### Changed
- Electron and the 2.0x Android wrapper are replaced. The localhost gateway accepts Tauri origins (still refuses `null`/foreign origins).
- Preferences migrate automatically from `ct-preferences-v1` (left untouched for rollback).
- Light theme: signal colours, separators and notice text now meet WCAG AA contrast; the app bar stays navy in both themes.
- Asset rows: a real button opens details, so screen readers read every cell (rows were `role="button"`).
- Pinch-zoom is allowed (was disabled). Header controls wrap on narrow screens; 48 px touch targets on touch devices.
- Language menu returns focus to its button on Esc or after choosing.
- Arabic `ctl.alerts` one/two forms include the numeral.

### Engine
Unchanged from 2.02 (bloc-weighted voting, closed bars only, neutral band 55, strong band 70). Regression: engine 37/37, FVG 21/21.

### Known issues
See README → Not verified. Kit issue KIT-001 (class collision) worked around in app CSS.

## 2.02 — fixes from the 2.01 code review
See the Trading project doc *Confluence-Terminal-Build2.01-Code-Review* and the 2.02 notes on the P: drive.
