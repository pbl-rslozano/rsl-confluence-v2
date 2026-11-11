<!-- wp:WP11 -->
# rsL Confluence Terminal v2.6 2026 — User guide

A multi-indicator crypto market scanner. It scores each asset with 18 indicator votes on **closed bars** and shows a Master Signal. It is an analysis tool, **not financial advice**, and it never places orders.

## Install
| Device | How |
|---|---|
| **Windows 10/11** | Run the `.msi` (or `-setup.exe`) installer from the latest release. |
| **Mac (macOS 15+)** | Open the `.dmg`, drag the app to Applications. First launch: right-click → Open if macOS asks. |
| **iPhone / iPad** | Install the release `.ipa` with Sideloadly. Or use the web version and *Share → Add to Home Screen*. |
| **Android 10+** | Install the release `.apk` (allow "install unknown apps" for your file manager once). |
| **Linux (64-bit)** | From the Linux release: `.deb` for Debian/Ubuntu (`sudo apt install ./<file>.deb`), `.rpm` for Fedora/openSUSE (`sudo dnf install ./<file>.rpm`), or the `.AppImage` for any distribution (`chmod +x` it, then run it). The packages are not signed; compare the file with its `.sha256`. |
| **Web / PWA** | Open the published web app (effervescent-bubblegum-1e5c03.netlify.app) and choose *Install app* (Chrome/Edge) or *Add to Home Screen* (phones). To run it on one computer only, install Node.js LTS once (nodejs.org), unzip the `-pwa.zip` from the web release, start **`Start-Confluence-Terminal.cmd`** (macOS/Linux: `start-confluence-terminal.sh`) and keep its window open; it serves the app on `http://127.0.0.1:8770/`. Opening `index.html` directly does **not** work. |

<!-- wp:WP8 -->
## Official builds
- Every release is built by the project's GitHub Actions only, one release per platform: Windows, macOS, Linux, Android, iPhone and web (the web release also carries the app's software bill of materials, `.cdx.json`). **About** shows the version, build number and source commit, and says that market data belongs to each exchange; compare the commit with the release page if you want to be sure you have an official build.
- From v2.6 the app's own code is shipped in a protected (minified and obfuscated) form without source maps, on every platform. This discourages copying and casual tampering. It does not hide your data or add secrets — the app holds no passwords or keys at all.
- Android only installs an update signed with the same key as the app you have, so a look-alike APK cannot replace it or read its data.

## First start
1. **Language** — pick from 18 languages. Status: *approved* (English, Arabic), *certified* (named native-speaker reviewer), *machine-checked* (automated checks only).
2. **Workspace** — your desk name (default *rsLozano — Personal trading desk*), short name, a 2–6 letter code, optional logo.
3. **Your name** — shown in the greeting. You can skip any step and change it later in **About → Edit identity**.

## Daily use
- **Timeframe / Source / Top N / Filter / Watch** in the header choose what is scanned. **Refresh** scans now; the ⚡ button toggles auto-refresh.
- The table: price, 24 h change, volume, the 18-vote bar, Bull/Neutral/Sell counts, Score, Reversal, Pattern and **Master Signal** (BUY/SELL · STRONG/MODERATE, or NEUTRAL).
- Click an asset name for the detail sheet (chart and every indicator).
- **Expand list** (above the table) hides the header controls and notes so the asset list fills the screen. **Show controls** brings the header back; the choice is remembered on that device. On a phone, **More controls** (the sliders button) holds the asset class, Top N, watchlists, alerts inbox, scoring profile, saved scans, filters, API, contact, About and theme.
- **Theme**: **System** follows your phone or PC setting, or choose **Light** or **Dark**.
- 🔔 lists reversal alerts. 🔑 connects a **read-only** exchange API profile through the optional local gateway (desktop; Binance, Bybit, Bitget only).

<!-- wp:WP7 -->
## Sources
| Source | Market | Quote |
|---|---|---|
| Binance Spot (default) | global spot | USDT |
| Bybit Spot / Perpetual | global spot and USDT perpetuals | USDT |
| Bitget Spot / Perpetual | global spot and USDT perpetuals | USDT |
| **Coins.ph (PH)** — v2.6 | Philippine peso market | PHP, USDT, USDC |

All sources are public price data only. The app never signs in to an exchange to scan.

## Philippine market (Coins.ph)
- Choose **Coins.ph (PH)** under **Source**. Prices are in pesos (₱); volume is shown in US dollars, converted with Coins.ph's own USDT/PHP price. A blue note above the list reminds you that this is the local peso market.
- **Peso books are thin.** Most Coins.ph volume is people swapping pesos and stablecoins. Pairs with less than about $250,000 of trading a day are left out of the scan, because a few orders can move their candles. The note counts them; point at the count to see which coins they are.
- **USDT/PHP and USDC/PHP** are the peso against the dollar, so they appear under **Asset class → Currencies**, not crypto.
- **PH premium** (detail sheet): how far the peso price sits above or below the global price for the same coin. It is information only and does not change the score.
- **Slower refresh.** Coins.ph allows each internet connection only about 120 requests a minute (heavier requests may count more). The app scans at most 40 pairs from this source and auto-refreshes no faster than every 5 minutes. If Coins.ph asks it to slow down, only Coins.ph pauses — the other sources keep working — and it resumes by itself. A **Refresh** right after a scan can take up to a minute to start, because the app waits until it is back under the limit.
- **Not available:** no public price feed was found for PDAX, GCash GCrypto, Maya, GoTyme or UnionBank, so they are not included. If one publishes such a feed, it can be added later.
- **Web version:** the published web app and the local launcher reach Coins.ph through their own address. If you put the web files on another host, Coins.ph may show **Blocked or unreachable**; the installed apps are not affected.
- Peso prices are always fetched live. The web app's offline copy never stores them, so a scan never shows old Coins.ph prices as current.
- Coins.ph is never offered under 🔑 — there is no account connection for it.

<!-- wp:WP10 -->
## Source health
The status line at the bottom shows the state of the source you are scanning:
- **OK** / **Slow** — working.
- **Rate-limited until hh:mm** — the exchange asked the app to wait; only that source pauses and it resumes by itself.
- **Blocked or unreachable** (web version) — the browser could not read the exchange and does not say why: the exchange may not allow web pages, your network may block it, or it may be asking for a pause. Try again later, the installed app, or another source.
- **Rate-limited** or **Network blocked** (installed apps, which can see the reason) — wait for the time shown, or, if your network or provider blocks the exchange, choose another source.
- **Stale** — the newest closed candle is too old to trust; those rows get no signal.

A failed source never borrows another source's candles. Missing rows are listed, not filled in.

## Measure before you trust
- **Ledger** (toolbar) shows how past signals for the current source and timeframe actually played out: hit rate against the base rate, average result after fees, and an indicative check. Each source keeps its own ledger, including Coins.ph. **Export CSV** to analyse it elsewhere.
- **Asset class** (header) switches between crypto, RWA tokens, tokenised stocks, currencies and commodities. Stocks and currencies show an "underlying closed" badge when their real market was shut.

## Your data
- Desktop and mobile keep your settings, identity and audit trail in an on-device **SQLite** database. The browser version uses browser storage, which the browser may clear — the yellow banner reminds you.
- **About → Export backup** saves `ConfluenceTerminal_<CODE>_backup_<date>.rslbak`. Do it weekly. **Restore backup** checks the file before changing anything.
- The app only asks for public market prices (Binance, Bybit, Bitget, Coins.ph — on the web, Coins.ph is reached through the app's own address) and the public update file. Nothing about you is sent. No tracking.
- Market data belongs to each exchange and is shown for personal use.

## Offline
Without a connection the last scan stays on screen and the footer shows **Offline**. Refresh when you are back online. Market data is never served from the offline copy.

## Updates
When a newer version is published, a line appears above the footer with the new version; on Android it also shows the download size and SHA-256 fingerprint (new in v2.6). On the web, choose **Reload to update**. On Android, choose **Download update**: the system browser downloads the signed APK, and installing it keeps your data. On iPhone, install the new build with Sideloadly. On desktop, install the new installer. **Later** hides the notice until the next version. Under **About → Updates** you can switch automatic checks off, check now, and see the last result. The check only reads one public file (`/updates/latest.json`); nothing is sent.

## Help
✉ in the header writes to rslozano@gmail.com with the app name as subject.

---
Powered by rsL Confluence Terminal · v2.6 2026 · build 20261107 — Created by rsLozano
