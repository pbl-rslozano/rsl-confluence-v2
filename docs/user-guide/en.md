<!-- wp:WP11 --> <!-- wp:WP16 -->
# rsL Confluence Terminal 2.7.0 — User guide

The rsL Confluence Terminal is a multi-indicator market scanner. For every asset it runs 18 indicator votes on **closed bars**, combines them into a score from −100 to +100, and shows a **Master Signal**. It also records every signal so you can measure, over weeks, whether the signals would have helped you.

> **Important.** The Terminal is an analysis tool, not financial advice. It reads public market prices only and never places an order on any exchange. Paper trading is simulated.

**v2.8 (in progress, Step 1 — WP19, WP20, WP27):** a 10% **drawdown lock** with RESET and more paper limits, a
**liquidity floor** for thin crypto pairs, honest Pattern and fair-value-gap labels, the **open-source licences** and data
credits, and a list that **appears at once** from saved history while the scan refreshes it (sections 4, 5, 6, 7, 8, 9, 11, 12, 13, 16, with new
rows in 20 and 21).

**v2.8 (in progress, Step 4a — WP25, part 1):** a **Market radar** panel (the **Radar** tab, or **R**) with positioning, buyer pressure, regional premiums, CFTC positions, an ETF CSV import and alerts for price break-away, volume spikes, depegs and stablecoin supply jumps: context only, never a vote, and fetched only while it is open or recording is on (sections 10, 11, 16, 19). Liquidations come later.

**New in v2.7:** choose the **stablecoin** each exchange is quoted in (USDT, USDC, FDUSD, USD1 … or the deepest one per coin), show prices in **any currency** at official reference rates, and **zoom, pan and go full screen** on the chart (pinch on phones).

## In this guide
1. Install
2. Official builds
3. First start
4. The main screen
5. How a signal is made
6. The asset detail sheet
7. Sources, quotes, display currency, timeframes and asset classes
8. Philippine market (Coins.ph)
9. Watchlists, filters, saved scans and scoring profiles
10. Alerts
11. Signal ledger: measure before you trust
12. Paper trading
13. Private API (read-only)
14. Source health
15. Languages, themes and phone layout
16. Your data, backups and privacy
17. Updates
18. Offline use
19. Keyboard and desktop menu
20. Troubleshooting
21. Glossary
22. Help

## 1. Install
| Device | How |
|---|---|
| **Windows 10/11** | Run the `.msi` (or `-setup.exe`) installer from the latest Windows release. |
| **Mac (macOS 15+)** | Open the `.dmg` and drag the app to Applications. The Mac build is not notarized by Apple: on first launch, right-click the app and choose **Open**. |
| **Linux (64-bit)** | From the Linux release: `.deb` for Debian/Ubuntu (`sudo apt install ./<file>.deb`), `.rpm` for Fedora/openSUSE (`sudo dnf install ./<file>.rpm`), or the `.AppImage` for any distribution (`chmod +x` it, then run it). The packages are not signed; compare the file with its `.sha256`. |
| **Android 10+** | Install the release `.apk`. Allow "install unknown apps" for your file manager once. **Coming from v2.6:** see *Android: moving from v2.6* below. |
| **iPhone / iPad** | Install the release `.ipa` with Sideloadly. Or open the web version and choose *Share → Add to Home Screen*. |
| **Web / PWA** | Open the published web app (effervescent-bubblegum-1e5c03.netlify.app) and choose *Install app* (Chrome/Edge) or *Add to Home Screen* (phones). To run it on one computer only, install Node.js LTS once (nodejs.org), unzip the `-pwa.zip` from the web release, start **`Start-Confluence-Terminal.cmd`** (macOS/Linux: `start-confluence-terminal.sh`) and keep its window open. It serves the app on `http://127.0.0.1:8770/`. Opening `index.html` directly does **not** work. The web app is personal: it is kept out of search engines, so keep its address yourself. |

**Android developer verification (v2.8 note).** Google's developer verification applies to sideloaded apps from 2027
(enforced in Brazil, Indonesia, Singapore and Thailand from 30 Sep 2026). The release `.apk` is installed outside the
Play Store, so this rule will apply to it.

<!-- wp:WP18 -->
**Android: moving from v2.6 (once).** v2.7.0 for Android is signed with a new key, so Android refuses to install it over
v2.6 ("App not installed" or "conflicts with an existing package"). Do this once:
1. In v2.6, **About → Export backup**, and in the Ledger **Export JSON** for each source, timeframe and asset class you use. Write down any open paper
   positions you want to keep: the paper account is not part of backups.
2. Uninstall v2.6 (long-press the icon → **Uninstall**).
3. Install the v2.7.0 `.apk` from the Android release.
4. **About → Restore backup**, then **Import ledger** for each ledger file.

Updates after v2.7.0 install over it normally and keep your data.

**Check a download.** Every release file has a matching `.sha256` file. Compare them before installing:
- Windows (PowerShell): `Get-FileHash <file> -Algorithm SHA256`
- Mac and Linux: `shasum -a 256 <file>`

<!-- wp:WP8 -->
## 2. Official builds
- Every release is built by the project's GitHub Actions only, one release per platform: Windows, macOS, Linux, Android, iPhone and web (the web release also carries the app's software bill of materials, `.cdx.json`). **About** shows the version, build number and source commit, and says that market data belongs to each exchange; compare the commit with the release page if you want to be sure you have an official build.
- From v2.6 the app's own code is shipped in a protected (minified and obfuscated) form without source maps, on every platform. This discourages copying and casual tampering. It does not hide your data or add secrets — the app holds no passwords or keys at all.
- Android only installs an update signed with the same key as the app you have, so a look-alike APK cannot replace it or read its data.
- Publishing one platform's release on GitHub never starts a new build; each release comes from the one build run of that version.

## 3. First start
The first time you open the Terminal, a short three-step setup appears. **Skip** ends the setup and keeps the defaults. You can change the workspace and your name later in **About → Edit identity**, and the language at any time from the **Language** menu.

![Step 1: choose one of 18 languages. Each language shows its review status.](images/first-start-language.webp)

1. **Language.** Pick from 18 languages. English and Arabic are *approved*; while new Arabic strings are still drafts, About shows *approved — N new strings await native-speaker review* for Arabic. A language marked *certified* was checked by a named native-speaker reviewer; *machine-checked* means automated checks only.
2. **Workspace.** Your desk name (default *rsLozano — Personal trading desk*), a short name, a 2–6 letter code (A–Z) and an optional logo (PNG, JPEG or plain SVG). The code appears in exported file names.
3. **Your name.** Used in the greeting when the app opens.

![Step 2: the workspace name, short name and code, with a live preview.](images/first-start-workspace.webp)

The first scan starts on its own. New installs scan **Binance Spot**, quoted in **USDT**, on **4-hour** bars, the **top 100** crypto assets by volume, refresh automatically, and show prices in your device's currency (**Display currency → Auto**, rates from **Automatic**).

## 4. The main screen
![The main screen (light theme). Illustrative market data.](images/terminal-light.webp)

### Header controls
| Control | What it does |
|---|---|
| **Timeframe** | The bar length to score: 1 minute up to monthly (13 choices). Default **4 hours**. |
| **Data source** | Where prices come from: Binance Spot, Bybit Spot or Perpetual, Bitget Spot or Perpetual, or Coins.ph (PH). |
| **Quote** | v2.7. Which stablecoin the pairs are quoted in: **USDT** (default), USDC, FDUSD, USD1 and the others the exchange lists, or **Best USD stablecoin**. Coins.ph is always PHP. See section 7. |
| **Asset class** | Crypto, RWA, Stocks (tokenised), Currencies (FX), Commodities, or All classes. |
| **Top N** | How many of the most-traded assets to scan: 25, 50, 100 or 200 (Coins.ph: at most 40). |
| **Display currency** | v2.7. The currency prices and volumes are **shown** in: **Auto** (your device's region), USD, or any of about 160 currencies. Display only — scores never change. See section 7. |
| **⇄ Rate sources** | v2.7. Where the exchange rates come from (five tested sources or your own), **Update now**, automatic updates, and links to check each source. See section 7. |
| **Watchlists** | Save a list of assets and scan only that list. See section 9. |
| **Alert inbox** | Rules for score and rank alerts, used with the external recorder. See section 10. |
| **Scoring profile** | Turn individual indicator votes on or off. See section 9. |
| **Saved scans** | Save and reapply a full scan setup. See section 9. |
| **Filter…** | Shows only rows whose symbol contains the text you type. |
| **Watch BTC, ETH…** | Scan only the assets you list (separate them with spaces or commas), then press **Apply** or Enter. `BTC`, `BTC/USDC` and `BTCFDUSD` all mean BTC. |
| **Workspace chip** | Your workspace short name. |
| **Auto / Manual** | Turns automatic refresh on or off. |
| 🔔 | Reversal alerts from the latest scans (the badge shows how many). |
| **Ledger** | The signal ledger (forward test). See section 11. |
| **Paper** | Paper trading. See section 12. |
| **API** | Connect a read-only exchange account through the local gateway. See section 13. |
| **Language** | Switch language at any time. |
| ✉ | Write to the developer. |
| ⓘ | About: version, storage, backup, updates, languages. |
| Theme | System, Light or Dark. From 1280 px wide it is one button (see below). |
| **Refresh** | Scan now. |

**Two-line header from 1280 px (v2.8).** On screens 1280 px wide or wider (laptops and desktops on Windows, macOS and
Linux, and the web app) all the controls above fit on **two lines**, and every one is still one click away. To make room,
these buttons show only an icon; **point at one, or move to it with Tab, to see its name**:

| Icon | Button |
|---|---|
| ⇄ | **Rate sources** |
| Star | **Watchlists** |
| Inbox tray | **Alert inbox** |
| Folder | **Saved scans** |
| Key | **API** (private API) |
| Flag of your language | **Language** |
| ✉ | **Contact developer** |
| ⓘ | **About** |
| Screen, sun or moon | **Theme** — one button: each click goes **System → Light → Dark** and back to System; its name says the current theme and the next one |

The selects are narrower and a long workspace name in the chip is shortened with "…"; every other button keeps its text.
Screen readers announce the same names as before. Below 1280 px (tablets, small laptops, phones) the header is unchanged.

### The summary strip
Under the header: number of assets scanned, the share that are **Bull**, **Bear** and **Neutral**, reversal counts (**Rev ↑/↓**), your workspace, the source, how long the scan took, errors, when it was updated, and **bar** — the time of the closed bar the signals were computed on. Signals never use the candle that is still forming.
When the liquidity floor left crypto pairs out (section 9), the strip also says *n thin pairs under $1M/day are not
scored*; point at it to see which pairs.

<!-- wp:WP29 -->
### Fear & Greed (v2.8)
The **Fear & Greed** chip at the end of the counts line (the line under the header with **Assets**, **Bull**, **Bear**, **Neutral** and **Rev**) opens a small panel with the **Crypto Fear & Greed Index**: a gauge from 0 (extreme fear) to 100 (extreme greed) and the index of the last 31 days. It is **context only**: it never changes a score, a signal, an alert or a paper-trading rule, and it never blocks a trade. The engine code stays `5c30b5c39f5ba3f2`.

- **What it is.** An index of crypto market mood published **once a day** by Alternative.me. The gauge shows today's value, its band (**Extreme Fear** 0–24, **Fear** 25–44, **Neutral** 45–55, **Greed** 56–75, **Extreme Greed** 76–100) and the day it was published (**Updated** and the date, as a UTC calendar day). The bars show the last 31 days, oldest to newest (in Arabic and Urdu, which run right to left, the oldest day is on the right). The gauge itself always has 0 on the left, as on the source's own page.
- **Open and close.** Click the chip to open the panel and click it again to close it. It opens directly below the counts line and moves the list down; closing it puts the list back. It is **closed by default**, and whether it is open is remembered **on this device** (browser storage, not in a backup): leave it open and the next start fetches it again, which is your choice.
- **When it contacts the internet.** Only while the panel is **open**. With the chip collapsed the app makes **no request** to Alternative.me, not even when you point at it. When you open it the last value shows at once from this device; the app asks again only if there is none or it is **older than an hour**, and while the panel stays open it checks every 15 minutes and fetches only when the value has become that old. Closing the panel cancels a request in flight. If the source cannot be reached the panel says **The index is unavailable right now.**, or, when it has an earlier value, keeps showing it with **Showing the last value from** its date.
- **Source.** **Data: Alternative.me Crypto Fear & Greed Index** sits right under the gauge and opens Alternative.me's page in your browser. The same source is listed in **About → Data sources & thanks**. The app is not made by or affiliated with Alternative.me.

### The table
| Column | Meaning |
|---|---|
| **#** | Rank in the current sort. |
| **Asset** | Coin name and the exchange pair (for example `BTCUSDT`, `ETHUSDC`). Click it to open the detail sheet. |
| **Price** | Last price, in the display currency. |
| **24h %** | Price change over 24 hours, in the pair's own market. |
| **Volume** | 24-hour traded value, in the display currency. **≈** marks a volume valued at the stablecoin's $1 peg because the exchange lists no price for that stablecoin. |
| **Indicators (18 vote)** | One small block per indicator: green bull, grey neutral, red bear, amber for an indicator that could not be calculated. The last three blocks (ATR, Std Dev, fair-value gaps) are information only and always grey. Point at a block to see its value. |
| **B / N / S** | Count of bull, neutral and bear votes. |
| **Score** | The combined score, −100 to +100. |
| **Reversal** | A possible turn against the current trend: REV↑ or REV↓ with LOW, MOD or HIGH confidence. |
| **Pattern** | What happened after similar past moments in this asset's own history. |
| **Master signal** | BUY or SELL with STRONG or MODERATE, or NEUTRAL. |

Click **#, Asset, Price, 24h %, Volume** or **Score** to sort; click again to reverse. The default sort is by volume, highest first.

**Expand list** (above the table) hides the header controls and notes so the asset list fills the screen. **Show controls** brings them back; the choice is remembered on that device.

<!-- wp:WP27 -->
### Smooth loading (v2.8)
The list no longer starts empty and appears all at once at the end of a scan:
- **Instant start.** When you open the app, rows appear at once from the market history saved on this device, each
  marked **updating · *bar time*** (the time of the newest saved closed bar), and refresh in place as fresh data arrives.
  This needs browser storage (or the app's own storage); without saved history — the first scan on a device, a private
  window, or cleared site data — the first scan works as before.
- **Priority order.** Your Watch list (or the selected watchlist) comes first, otherwise the top 10 by volume; then the
  next 20, the next 20 … up to the Top N you chose (25, 50, 100 — the default — or 200). Rows appear as each one is
  scored and the progress bar shows the whole scan.
- **Saved rows are display only.** Until a fresh fetch refreshes it, a row shown from saved history is never recorded in
  the ledger, never proposed to paper trading and never raises an alert. Its **Pattern** shows **—** until it is
  refreshed. Rank, relative strength, beta and ledger rows are worked out once the whole list is in, exactly as in a
  full scan, so what is recorded is the same as before.
- **not updated · *bar time*** marks a row whose fetch failed this scan: it still shows the saved history, display only.
  Point at either badge for the explanation.
- **Delta fetch.** When the saved history is unbroken, only the bars after the last saved closed bar are fetched (plus one
  overlap bar to check it; if that bar differs, the saved series is thrown away and fetched again in full). The engine
  always sees the same 1,000-bar window, so scores equal a full download.
- Changing source or timeframe cancels the queued work and starts again. At rest the screen looks exactly as in v2.7.

### Notes and banners
- **Rate line** (v2.7, grey): shown when prices are not in US dollars — for example *Prices in SAR · 1 USD = 3.75 SAR · official peg (SAMA) · Frankfurter central-bank rates · as of 2026-11-11 · stablecoins at 1 USDT = 1 USD (USDT now $0.9987)*. An amber **rates are more than 3 days old** tag appears when the device could not refresh them.
- **Depeg banner** (v2.7, amber or red): the stablecoin you scan in has moved away from $1 on this exchange — **Watch** at 0.5 %, **Warning** at 1 %, **Severe** at 2 %. Information only; signals are unchanged. A short spike on one exchange is possible (USDe touched $0.65 on one exchange for about 40 minutes in October 2025), so compare with another source before acting.
- **Storage and backup banner** (yellow): the browser version may lose data when the device runs low on space. The banner also appears when you have never exported a backup or the last one is 7 or more days old; its **Export backup** button saves one straight away. If the device blocks storage completely, a notice says settings are kept only until you close the app.
- **Error banner**: a scan failed. **Retry** scans again; **Use Bybit** switches the source when Binance cannot be reached.
- **Macro banner**: shown 24 hours before and 2 hours after a scheduled FOMC decision, US CPI, US jobs report or ECB decision. Volatility is often higher around those releases; how much that affects the signals is not yet measured. The built-in calendar (v2.8) lists FOMC, US CPI, US jobs-report and ECB dates through late 2027, taken from the Fed, BLS and ECB pages; a date that could not be confirmed there is shown but never blocks paper trades. When any kind has fewer than 30 days of dates left, the banner adds a line such as *CPI dates are only listed until … — update the app; the event blackout cannot cover later releases*.
- **Stale banner**: shown when at least three assets (and at least 5% of the scan) returned candles that were too old; they were left out. Fewer stale assets show only as *n stale* in the summary strip.
- **Rate-limit banner**: the exchange asked the app to slow down; scanning pauses for the time shown and partial results stay on screen.

### The footer
The footer shows **Online/Offline**, where your data is stored, the reminder *Signals computed on closed bars · analysis tool, not financial advice*, the source status (section 14), the colour legend, and the build stamp.

## 5. How a signal is made
### The 18 voting indicators
Each indicator casts one vote — bull, bear or neutral — on the last closed bar. They are grouped into four families ("blocs").

| Bloc | Indicators | Votes bull when… |
|---|---|---|
| **Trend** (9) | SMA 20/50 · EMA 9/21 · MACD 12/26/9 · ADX 14 · Parabolic SAR · Ichimoku Cloud · Supertrend 10/3 · CCI 20 · Awesome Oscillator | the fast average is above the slow one, price is above SAR, the cloud or Supertrend, MACD is above its signal and rising, CCI is above +100, or the oscillator is above zero and rising. ADX votes only when the trend is strong (ADX above 25). |
| **Mean reversion** (4) | RSI 14 · Stochastic 14/3 · Williams %R 14 · MFI 14 | the market is oversold (RSI ≤ 30, Stochastic below 20, Williams %R ≤ −80, MFI ≤ 20). Overbought readings vote bear. |
| **Breakout** (2) | Bollinger 20/2 · Keltner 20/10 | price closes above the upper band. A close below the lower band votes bear. |
| **Flow** (3) | VWAP · OBV · CMF 20 | price is above VWAP, OBV is above its 20-bar average, or CMF is above +0.05. |

ATR 14, Std Dev 20 and fair-value gaps are shown for information but do not vote. When a source has no usable volume, the volume indicators (VWAP, OBV, CMF, MFI) are left out. The quote and the display currency never change any vote.

### From votes to score
1. Each bloc gets a score from −1 to +1: (bull votes − bear votes) ÷ valid votes.
2. The **Score** is the weighted average of the four blocs, times 100.
3. **Trend regime.** In a strong, smooth trend, oversold and overbought readings mislead. The app measures trend efficiency over 40 bars (the *efficiency ratio*). Between 0.30 and 0.60 the mean-reversion bloc is phased out; above 0.60 it has no weight. The detail sheet shows this as *contrarian weight*.

### Master signal
| Score | Master signal |
|---|---|
| +70 or more | **BUY · STRONG** |
| +55 to +69 | **BUY · MODERATE** |
| −54 to +54 | **NEUTRAL** |
| −55 to −69 | **SELL · MODERATE** |
| −70 or less | **SELL · STRONG** |

- **·lv** (low volatility): when the price range is in the quietest 10% of its own history, a STRONG signal is reduced to MODERATE and marked ·lv. Not applied to currencies.
- **NO DATA**: fewer than 13 of the 18 indicators could be calculated, the asset has fewer than 80 closed bars, a stock split was detected, or the feed failed this scan. The row is shown but gets no signal.
- **Closed bars only.** The unfinished candle is always dropped. A feed whose newest closed bar is more than 2½ bars old is marked stale and gets no signal.

<!-- wp:WP23 -->
### Confluence v2 (test challenger, v2.8)
Confluence v2 is a second way of scoring the same 18 indicators, run beside Classic so the ledger can measure which one
works better. It is a test: **Classic stays the engine**, and nothing switches over without a later decision based on the
ledger record. What v2 changes:
- **Standardised inputs.** Each indicator's measure (for example price minus its average, or the MACD histogram) is divided by
  the market's own volatility (ATR 14, or the measure's own spread over 100 bars) and **clipped to ±1**, so a reading far
  from its trigger counts more than one just past it, and no single reading can count for more than 1.
- **All four mean-reversion oscillators vote on every timeframe.** RSI, Stochastic, Williams %R and MFI are kept on 4h and
  above too (owner decision, 18 Nov 2026).
- **Hysteresis, 55 and 40.** v2 gives a label when its score reaches ±55 and returns to NEUTRAL only when the score is below
  40 in size. Example: a BUY entered at 58 stays BUY at 45, and ends when the score falls below 40. Hysteresis is meant to keep
  the label steady; on the test fixtures v2 changed its label far less often than Classic did.
- **Its own calibration.** v2's score scale was set on noise so that, like Classic, at most about 7% of random windows get a
  label and at most 2% get STRONG.

**v2 is never shown in the list and never used for signals, alerts or paper trades.** The list, the labels, the Master
signal, the alerts and the paper rules read Classic only.

**The setting and the line.** In **Scoring profile**, tick **Confluence v2 line in the detail sheet (test)** (off by
default). The asset detail sheet then shows one extra line, for example "Confluence v2 (test): BUY · STRONG · score +74",
and "A challenger recorded for comparison only. It never changes the list, signals, alerts or paper trades." When the
label is being **held** between 40 and 55, the line reads "Confluence v2 (test): BUY · MODERATE · score +45 · held until the
score is back inside ±40". With too little data it reads "Confluence v2 (test): no data". Untick the setting and the line goes away.

**The ledger records it.** Each ledger row also records v2's label, config id, score and strength (about 54 bytes more per
row, logged and never scored). Rows recorded before v2.8, or without enough history, have no v2 label and are not compared.
The new texts are in all 18 catalogs; 16 languages show them in English for now, and the Arabic text is a draft pending native review. Nothing is certified.

### Reversal
The Reversal column looks for a turn **against** the current trend (the trend is judged from the 50-bar average and its slope). It checks nine clues: RSI divergence, MACD momentum loss, a return inside the Bollinger bands, a Stochastic cross, a Parabolic SAR flip, a Supertrend flip, RSI leaving overbought or oversold, an engulfing candle, and a hammer or shooting star. Three or more net clues are **HIGH**, two **MOD**, one **LOW**. HIGH is a count of clues, not a probability that the trend will turn. Point at the badge to see which clues fired.

### Pattern
The Pattern column is not a chart-shape detector, and it is descriptive, not a validated forecast. It looks back through
the same asset's earlier closed bars for moments that looked like now (score, reversal and trend over the last four bars;
the 20 to 40 closest analogues) and counts how often price moved each way over the next six bars.
- A direction (**Past analogues ↑** or **↓**) is shown only when the 95% **Wilson lower bound** of that hit rate beats the
  asset's own base rate by more than 2 points. Confidence comes from that excess alone: **HIGH** at 10 points or more,
  **MODERATE** at 5 or more, **LOW** otherwise. On random price series this gate calls almost nothing (in the noise test
  about 99% of windows abstain and none are HIGH).
- **N mixed** means it found N analogues but no excess over the base rate (*No excess over base rate*), or fewer than 20
  analogues (*Too few analogues* — no comparison is made). Point at it for the reason.
- **—** means it found no analogues, or the row is still shown from saved history (section 4).

## 6. The asset detail sheet
Click an asset name to open its detail sheet. Scroll down for each section. The sheet closes when you change the source, timeframe or quote, so it never acts on rows from another scan.

![Top of the detail sheet: key figures, saved history and the chart.](images/detail-overview.webp)

- **Key figures**: price, 24-hour change, 24-hour volume (in the display currency) and the confluence score. On Coins.ph also the **PH premium**.
- **Saved market history**: how many closed bars are stored on this device. Choose how many to chart (60, 250, 1,000 or all). **Load 5K older** fetches more history for this row's own source and timeframe.
- **Chart**: candlesticks with EMA 20, EMA 50, SMA 200, VWAP (from the first visible bar) and Bollinger 20/2, plus MACD histogram and volume panels. Prices on the axis and in the readout are in the display currency. The **Indicators** menu shows or hides each line and lets you change the moving-average periods.

<!-- wp:WP14 -->
### Zoom, pan and full screen (v2.7)
The chart toolbar has **+** (zoom in), **−** (zoom out), **Reset**, **Full screen** and a counter such as *60 / 1000 bars* (bars shown / bars saved).

| On | Zoom | Pan | Reset | Inspect a candle |
|---|---|---|---|---|
| **PC** | Ctrl (⌘ on Mac) + mouse wheel, or pinch on the trackpad | drag, Shift + wheel, or Shift + ← → | double-click, or **0** | hover, or ← → Home End |
| **Phone / tablet** | pinch with two fingers | drag sideways with one finger (drag up/down still scrolls the sheet) | double-tap | tap |
| **Keyboard** | **+** and **−** | Shift + ← → | **0** | ← → Home End |

- Zoom keeps the candle under your cursor or between your fingers in place. You can zoom out to every saved bar and in to 20 bars. The depth menu (60 / 250 / 1K / All) sets where the view starts.
- When a long view has more candles than the screen has room for, neighbouring bars are combined into one candle and the readout says *n bars per candle*. Zoom in to see each bar.
- **Full screen** (or **F**): on a PC browser and Android Chrome the chart takes the whole screen; on iPhone, iPad and in the Android and iPhone apps it fills the app window and hides the status bar; in the desktop app the window also goes full screen. **Esc**, **Exit full screen** or Android **Back** returns to the detail sheet — the sheet stays open. Turn a phone sideways for a wider chart.
- Page zoom (pinch outside the chart, or the browser's zoom) keeps working for reading text.

<!-- wp:WP24 -->
### Reflect view (v2.8)
A falling market is harder to read than a rising one for many people, and traders check a chart's symmetry by flipping it. **Reflect view** mirrors the price pane vertically: the price axis runs high to low, so a fall is drawn as a rise. It is display only.
- Turn it on with **Reflect view (mirror the price axis)** in **Indicators** (off by default), or press **I** while the chart has focus. The state is remembered per device; **Reset to defaults** in the same menu turns it off.
- A **Reflected** badge sits on the price pane, also in full screen and in screenshots, so a mirrored chart is never mistaken for a normal one.
- Axis labels and the readout still show real prices. Every layer of the price pane (candles, averages, Bollinger bands, VWAP, levels, gaps, the scenario fan) uses the same mirrored axis.
- Candles keep their **real colours and real prices**: a rising candle is still green. The crosshair stays on the hovered candle's close and the readout keeps the real open, high, low and close.
- **MACD and volume are not flipped.** The **Fund trend ribbon** stays at the bottom of the price pane and is not flipped, and neither are the disagreement marks. The **Fund trend panel is flipped** together with price.
- Turning it off restores the normal drawing exactly. It never reaches a score, an alert, the paper rules or the Radar.

![Analysis sections: trend and reversal, historical pattern, bloc scores and context.](images/detail-analysis.webp)

- **Trend & reversal**: the current trend and any reversal clues.
- **Historical analogues (descriptive)**: the analogues behind the Pattern column — how many, how often they moved in the signal's direction with its 95% lower bound against the base rate, the average 6-bar move and how similar they were. With 1–19 analogues it says *Too few analogues*.
- **Scenarios (simulation)**: a collapsed section right after the Pattern panel; see *Scenarios (simulation) and Heikin-Ashi (v2.8)* below.
- **Bloc scores**: the four bloc scores, the efficiency ratio and the contrarian weight.
- **Context (logged, not scored)**: extra information that is recorded with the signal but does not change it:
  - **Relative strength**: where this asset's 20-bar return ranks in the scan, 0–100.
  - **Beta to BTC**: how strongly it moves with Bitcoin (the scan's own BTC pair, so BTCPHP on Coins.ph and BTCUSDC in a USDC scan).
  - **Higher-timeframe trend**: the trend on bars four times longer.
  - **Taker delta**: buying minus selling pressure (Binance Spot and Coins.ph).
  - **Macro event**: hours to or since the nearest scheduled macro release.
  - **Basis**: perpetual price against the index (Bybit and Bitget Perpetual).
  - **Band-pinned**: the price looks held in place (large basis or three flat bars); perpetuals, stocks, currencies and commodities.
  - **Split muted** and **Earnings window**: tokenised stocks only. The earnings calendar ships empty, so the earnings window is not flagged yet.

![Fair-value gaps and key levels.](images/detail-levels.webp)

- **Fair-value gaps**: price gaps left by fast moves, at least 0.5 × ATR(14) wide (v2.8; this ATR is a simple 14-bar average of the true range, not Wilder's smoothing). A gap that agrees with the signal raises the shown confidence slightly; an opposing gap lowers it (×0.85 to ×1.15), shown as **FVG adjustment (unvalidated)** because that adjustment has not been measured yet. Gaps never change the score or the signal.
- **Key levels (20-bar)**: pivot, two resistance levels (R1, R2) and two support levels (S1, S2), each marked above or below price, in the display currency.

![The indicator panel lists every vote with its value.](images/detail-indicators.webp)

- **Indicator panel · n voting** (n = the votes that could be calculated): every indicator with its value and vote, grouped by Trend, Momentum, Volatility, Volume and Structure, plus warnings — for example when the blocs disagree.

<!-- wp:WP22 -->
### Scenarios (simulation) and Heikin-Ashi (v2.8)
**Scenarios (simulation)** is a collapsed section on the detail sheet, right after the Pattern panel. It always starts with the line **"Possible scenarios from past data — not a forecast."** It shows how far price might move, never which way. **Not a forecast; not financial advice.** It never changes a score, a signal, an alert, a paper-trading rule or the Radar, and the engine code stays `5c30b5c39f5ba3f2`. At rest nothing is computed and nothing is requested.

**The fan (how far, never which way).**
- **200 paths** are simulated. Each path is built from **blocks of 6 candles** copied from this coin's own past: every past candle becomes a relative candle (open, high, low and close divided by the previous close), and a new block is drawn after every 6 candles.
- Blocks come only from bars whose volatility (ATR(14) ÷ close, as a percentile) is **within ±15 points** of today's. When too few blocks qualify the band widens to **±30**, then to **all bars**, and the explanation says so.
- The simulation is **direction-neutral**: the mean log return of the sample is removed, so the fan is centred on today's close.
- One simulation runs for 24 bars; the **6-bar** horizon uses its first 6 steps. **Horizon** switches between **6 bars** and **24 bars**.
- It is **seeded** from the pair, the timeframe and the last closed bar's time: the same view gives the same picture, and a refresh does not reshuffle it.
- The **range bands** at each step are **2.5–97.5 %** (light) and **16–84 %** (darker) of the simulated closes; the **median is dotted**.
- **Minimum 300 bars.** With fewer closed bars the section says **"Scenarios: not enough history (needs at least 300 closed bars)."** If today's volatility percentile cannot be worked out, the volatility sentence is left out and the section shows *not enough history*.

**The odds.**
- **State** is the Fund trend direction only: **down ≤ −15 · flat · up ≥ 15**. A coin without a Fund trend (stocks, forex, commodities, a new listing, or a build that cannot fetch daily bars) has no state and shows its overall odds: **"No Fund trend state for this coin — showing its overall odds."**
- **Matches** are past bars in the same state, **sampled every 2 bars**. The **effective sample** is n_eff = matches × 2 ÷ horizon, and it must be **at least 20**. Otherwise the section uses all sampled bars and says **"Not enough similar moments — showing this coin's overall odds."** The sample line then reads *{cases} past moments (all bars) · effective sample {neff}*; with enough matches it reads *{cases} similar past moments · effective sample {neff}*.
- **Outcome** is the move after the horizon in units of σ_H = ATR(14) ÷ close × √H at the signal bar (log-return units). With an up or down trend, **Continue** is more than +0.5 σ_H in the trend's direction, **Reverse** is less than −0.5 σ_H, and **Pause** is anything in between. With a flat trend the three are **Up / Range / Down**.
- Each scenario shows its **Odds**, a **95 % range** (Wilson, computed on n_eff), the **Cases**, and the coin's all-bars **Base rate**. The odds are descriptions of the past, not probabilities of what comes next.
- The **scenario path** of a scenario is, among the 200 paths that end in that bucket, the one nearest the bucket's median. If no path ended there, no candles are drawn (*No simulated path ended in one of the scenarios; its odds still show.*), and the odds still show.
- The daily bars for the Fund trend state come from the existing daily-bar feed (same hosts, at most one request per pair per UTC day) and **only while the Scenarios section is open**. Nothing is fetched until you open it.
- The sheet works on the history it holds, including **Load 5K older**. The official recorded check always uses the last 1,000 bars; when the sheet holds more, it says **"The recorded check uses the last 1,000 bars."**

**On the chart.** The graphic appears only after the section is opened and **Show on chart** is pressed (**Hide from chart** turns it off, and the chart is then exactly the v2.7 chart).
- The time axis gains empty slots for the horizon, and the bands fill them. Candles are **hollow with a dashed outline**, a **SIMULATED** label sits on the area and the axis marks **now**. The projection shows only while the view includes the newest bar.
- The tabs **Continue / Pause / Reverse** (**Up / Range / Down** on a flat trend) switch the path.
- **▶ Play** draws the candles one at a time (about 250 ms each) and stops at the horizon. **Pause** holds the count and the button reads **▶ Play** again; pressing it resumes. **Replay** appears only at the end. With *reduce motion* set on your device, Play shows all candles at once.
- It works with zoom, pan (the projection uses the real bars' span), **Full screen** and Heikin-Ashi. **Chart replay** is not changed.
- At most 2 band polygons and 24 simulated candles are drawn.

**Heikin-Ashi (display only).** In **Indicators** tick **Heikin-Ashi (display only)**; it is off by default. Real candles and simulated candles are both converted. Scores, levels and every calculation keep real prices, and the readout shows the real open, high, low and close and, beside them, the Heikin-Ashi values (**HA O** …).

### Chart replay
**Open chart replay** steps through the saved history one bar at a time. Use **Play replay** / **Pause replay**, **Next bar** and **Speed** (1×, 2×, 4×). The replay chart zooms and goes full screen like the main chart. To practise, choose side (long or short), size, stop % and target %, then **Queue replay trade**; it fills at the next bar's open. When a bar touches both the stop and the target, the stop counts first.

![Chart replay with a practice trade.](images/chart-replay.webp)

### Derivatives and order flow (Bybit Perpetual)
On **Bybit Perpetual** the sheet adds two research panels:
- **Order flow**: **Capture order flow** takes a snapshot of the order book (15 levels per side) and recent trades. Up to 60 captures are kept while the sheet is open; step through them with Previous/Next. After two or more captures a **depth heatmap** appears (green bids, pink asks, brighter means more size, dots mark liquidations). You can also import a recorded depth file (JSONL, up to 8 MB).
- **Derivatives**: funding rate, open interest and its change, from a recorder file you import (JSONL, up to 10 MB). Data older than two hours is marked stale.

<!-- wp:WP21 -->
### Fund trend (v2.8)
**Fund trend** is a second opinion that never changes the score. It asks whether a coin has been trending, over about one, three and twelve months, **relative to how much it normally moves**. It is an adaptation of published research, not any fund's positions: the method follows Moskowitz, Ooi and Pedersen (2012, "Time series momentum", *Journal of Financial Economics*) and Hurst, Ooi and Pedersen (2017, "A century of evidence on trend-following investing", *Journal of Portfolio Management*), who trade the **sign** of each past return. Here a volatility-scaled return replaces the sign so that it fits the same −100…+100 scale as the score. Nothing here says what any fund holds or would do. It is an analysis tool for paper practice, not financial advice.
- **How it is worked out.** From closed **daily** bars only. For 30, 91 and 365 days the app takes the log return, divides it by the coin's usual daily movement (an exponentially weighted volatility, centre of mass 60 days, using bars up to the day before) times the square root of the days, and clips each result to ±2. **Fund trend** is 50 × the average of the three: −100 is a strong, steady fall, +100 a strong, steady rise. The value does not depend on the timeframe you scan.
- **Fund size** is what a fund aiming for 40 % yearly volatility on this one asset would hold, as a share of its normal size: 40 % ÷ the coin's annualised volatility, at most 200 %. A calm coin gives a large number, a wild one a small number. It is an illustration of risk scaling, not a position size for you.
- **Crypto only.** Spot, perpetual and Coins.ph peso pairs each use their own daily bars. Tokenised stocks, forex and commodities show **n/a**, because their weekend prices are synthetic.
- **Not enough history.** At least **366 contiguous closed daily bars** are needed. A newer listing shows **Fund trend: not enough history**. Data that is out of order, has duplicates or a bad price also counts as not enough history or n/a; the app never guesses.
- **Where the data comes from.** Daily bars are fetched from the same exchange and hosts as the row, **at most once per coin per UTC day**, after the scan has finished and behind its usual pacing and rate-limit pause. Only builds that fetch directly do this: the installable web app, the desktop app and the phone app. The **hosted web version** cannot, so it shows no Fund trend values at all (the panel's Confluence line still works). If the exchange asks the app to wait, the feed stops: the list rows still waiting stay empty, and the detail sheet says **Fund trend: data unavailable, try again later**, until you open the coin again after the pause.
- **It never votes.** Fund trend is not one of the 18 voting indicators. It does not change any score, signal, alert or paper-trading rule, and the engine code stays `5c30b5c39f5ba3f2`.

**Everything is off by default.** Open a coin, press **Indicators** under the chart and tick **Fund trend ribbon** or **Fund trend panel**. **Reset to defaults** in the same menu turns both off.
- **Ribbon.** A thin band at the bottom of the price pane, one cell per bar: green for positive, red for negative, grey when the value is between −15 and +15; the stronger the value, the more solid the colour. For intraday bars it uses the value from the daily bars that **closed before that bar's day**, so it never looks ahead.
- **Panel.** A pane below the volume: the **Confluence score** and **Fund trend** as two lines on one −100…+100 axis, and **Fund size** as a shaded area (0–200 %). The header shows **Fund rank** (below). The Confluence line works for **every** asset class; Fund trend and Fund size show n/a for non-crypto coins.
  - A bar is scored only when its full 1,000-bar window exists (the bar and the 999 closed bars before it), exactly as the list scores it. The note under the panel says **Score shown for N of M bars**. If fewer than about 1,300 bars are on hand, the app fetches the missing older bars once (one history page from the same exchange); otherwise the line starts where a full window begins.
  - The panel scores at most the **newest 300 bars** of the view; when you zoom out past 300 bars, the note says so.
- **Disagreement.** When the Confluence score is **+55 or higher while Fund trend is −25 or lower** (or the score is −55 or lower while Fund trend is +25 or higher), the two methods point opposite ways. Those bars get diagonal hatching and a **◆** marker, with ribbon or panel on. In the asset list, a coin whose newest bar disagrees gets a **◆** and a thin outline, **only while the ribbon is on**. A disagreement is a reason to look closer, not a signal to trade.
- **Pulse.** In **Scoring profile** (section 9), **Disagreement pulse** sets how a new ◆ draws attention: **3 pulses** (the default: about three seconds, then it stays), **Off**, or **Keep pulsing** (at most one pulse a second until you open that coin; **Stop pulsing** ends all of them). With *reduce motion* set on your device there is no animation at all.
- **Fund rank.** The coin's Fund trend ranked among all the crypto rows of the current scan, shown as **Fund rank 3 of 87** in the panel header. A **Fund rank column** in the list is available under **Scoring profile**, off by default. It is a sort aid only.

**In the ledger (section 11).** Each recorded crypto row also keeps its Fund trend (**ft**, one decimal) where it was available. Live rows wait up to 90 seconds for the day's daily bars so it is not lost. The ledger report adds **Fund trend sign** beside the 20-bar momentum in the benchmarks once rows carry it: does going long when it is positive and short when it is negative do better than the signals? The CSV export has a **fund_trend** column. It is measurement only and never enters the score.

## 7. Sources, quotes, display currency, timeframes and asset classes
<!-- wp:WP7 -->
| Source | Market | Quotes (v2.7) |
|---|---|---|
| Binance Spot (default) | global spot | USDT, USDC, FDUSD, USD1, U, EURI |
| Bybit Spot | global spot | USDT, USDC, USD1, USDE, RLUSD, XUSD |
| Bybit Perpetual | USDT- and USDC-margined perpetuals | USDT, USDC |
| Bitget Spot | global spot | USDT, USDC, USD1, USDE, RLUSD, U |
| Bitget Perpetual | USDT- and USDC-margined perpetuals | USDT, USDC |
| **Coins.ph (PH)** | Philippine peso market | PHP |
| **OKX Spot** (v2.8) | global spot | USDT, USDC |
| **OKX Perpetual** (v2.8) | USDT-margined perpetuals | USDT |
| **Coinbase (US)** (v2.8) | US dollar spot | USD (default), USDT |
| **Upbit (KR)** (v2.8) | Korean won spot, plus USDT and BTC markets | KRW (default), USDT, BTC |

All sources are public price data only. The app never signs in to an exchange to scan. The Quote menu shows only the stablecoins the exchange lists at that moment, so a delisted stablecoin disappears from it by itself.

![The data source menu.](images/source-menu.webp)

<!-- wp:WP26 -->
### OKX, Coinbase and Upbit (v2.8)
Choose them under **Data source**. They scan like the other sources: closed candles only, public prices only, no sign-in.
- **Timeframes built from shorter candles.** When an exchange has no candle of that length, the app builds it from
  shorter ones and uses only complete bars:

  | Exchange | Built from shorter candles |
  |---|---|
  | OKX | 8 hours (from 4 hours), 2 and 4 days |
  | Coinbase | 4, 8 and 12 hours, 2 and 4 days, weekly (weeks start Monday 00:00 UTC) and monthly (calendar months) |
  | Upbit | 6, 8 and 12 hours, 2 and 4 days |

  Upbit's own weekly and monthly candles also start on Monday and on the 1st, at 00:00 UTC.
- **Request cap and "cold" scores.** These exchanges send at most 300 candles (OKX, Coinbase) or 200 (Upbit) per request.
  A full history of 1,000 bars therefore takes several requests per pair, and the app stops at **16 requests per pair**
  (OKX needs at most 5).
  Where that is not enough, the pair is scored on the bars it has and counts as **cold** in the ledger (fewer than 1,000
  bars), for example:
  - Coinbase 8 hours, weekly and monthly;
  - Upbit 6 hours and 4 days;
  - OKX 8 hours, 2 and 4 days, which use at most 1,000 shorter candles.

  A pair listed only recently, or one with hours without trades (Coinbase and Upbit publish no candle for them), is
  scored cold too. Missing bars are never filled in.
- **Slow first scans on Coinbase.** Coinbase allows about 10 requests a second, and the app uses 8. A first 4-hour scan
  of 100 pairs needs about 14 requests per pair and takes about three minutes. The status line may say **Slow** meanwhile
  (after 90 seconds; 60 seconds for OKX). Later scans ask for far fewer bars, except on timeframes scored cold, which ask
  for the full window every time. Each exchange's own limits are kept: if one asks the app to wait, only that exchange
  pauses.
- **Prices in KRW and BTC (Upbit).**
  - **KRW** prices follow your display currency, like pesos on Coins.ph.
  - **BTC-market** prices stay in BTC, and the scan line says *Prices in BTC — not converted to your display currency.*
  - For the liquidity floor and the ranking, volume is valued in US dollars with Upbit's own USDT market (KRW-USDT,
    USDT-BTC), never with display rates. If Upbit's KRW-USDT price is missing, KRW volume is unknown: with a liquidity
    floor on, those pairs are not scored, and the scan line says *… pairs with unknown US$ volume are not scored*.
  - Upbit's **24h %** is measured from the previous 00:00 UTC close, not over a rolling 24 hours as on the other exchanges.
  - In paper trading, Upbit's KRW and BTC pairs are refused (the paper account is in US dollars); its USDT pairs can be
    proposed.
- **Coinbase** offers USD and USDT pairs. USDC pairs are not offered, because Coinbase Exchange has delisted its USDC books
  and serves them as USD. Both USD and USDT pairs can be proposed in paper trading.
- **Upbit is reached through a relay.**
  - The web app and the local launcher read Upbit through their own address (`/x/upbit/…`). The installed apps read it
    directly, but only Upbit's public price paths.
  - If the relay is missing or refused (for example when the web files are on another host), Upbit's rows say **Feed
    unavailable** and the status line shows **Blocked or unreachable**. The other sources keep working, and the app never
    falls back to calling Upbit directly from the page.
- **View on [exchange].** The last line of the detail sheet opens the pair's market page on that exchange's own website,
  in your browser. It is a plain link: there is no referral code and no embedded exchange page. The app never logs in to
  the exchange and never trades; paper trading stays simulated.
- **Data sources & thanks.** **About → Data sources & thanks** (collapsed) names every provider the app reads: the
  exchanges, the Binance Vision archive and the rate sources. For each it says what the app uses and links its public API
  documentation and terms. Names are in text, with no logos. ExchangeRate-API's required credit *Rates By Exchange Rate
  API* is shown there too. Since the market radar it also names Binance USDⓈ-M Futures, the CFTC Commitments of Traders and DefiLlama (section 10).

<!-- wp:WP12 -->
### Quote currency (stablecoins)
The same coin often trades against several stablecoins — BTCUSDT, BTCUSDC, BTCFDUSD. **Quote** chooses which pairs are scanned:
- **USDT** (default) scans exactly what earlier versions scanned.
- **USDC, FDUSD, USD1, …** scan the pairs quoted in that stablecoin. Their 24-hour volume is turned into US dollars with that stablecoin's own price on the same exchange (USDC/USDT, FDUSD/USDT …), so a stablecoin trading at $0.98 does not inflate the ranking.
- **EURI** (Binance) is a euro stablecoin: prices are in euros.
- **Best USD stablecoin** takes, for every coin, the dollar-stablecoin pair with the most trading. A coin switches pair only when another one is at least 25 % busier, so the ledger does not flip between BTCUSDT and BTCUSDC every scan.
- On **perpetuals**, USDC means the USDC-margined contracts (named like `BTCPERP`).
- Signals always use **one real pair's candles**. Pairs are never blended.
- Each pair has its own history, ledger and alerts: BTCUSDT and BTCUSDC are measured separately. The quote is remembered per source (and kept in backups); saved scans and watchlists use the source's current quote.
- If the stablecoin moves away from $1, the depeg banner appears (section 4).

<!-- wp:WP13 -->
### Display currency (any fiat)
**Display currency** shows prices and volumes in the currency you read — SAR, PHP, EUR, AED, JPY, INR and about 160 more. **Auto** picks your device's currency from its time zone, then its language and region settings (Riyadh → SAR, Manila → PHP; anything unknown → USD). It never looks at your internet address.
- **Display only.** Scores, signals, the ledger, alerts and paper trading stay in each market's own currency. Only what you see is converted.
- **Where the rates come from.** First **Frankfurter**, which publishes central-bank reference rates and says which banks each rate comes from (for the peso, for example, Bangko Sentral ng Pilipinas among others). If it cannot be reached, a community rate service (fawazahmed0, labelled *community rates (method not published)*). With no connection and no saved rates, the built-in official pegs of the Gulf currencies are used (SAR 3.75 SAMA, AED 3.6725 CBUAE, QAR 3.64 QCB, OMR 0.3845 CBO, BHD 0.376 CBB, JOD 0.709 CBJ); any other currency then shows USD and says so.
- **Honest labels.** The rate line says what kind of rate it is: **official peg** (with the central bank), **managed band** (HKD 7.75–7.85), **official rate** for currencies that also have a parallel market (ARS, NGN, EGP, LBP, VES …), otherwise **reference rate**, plus the source and date.
- **Stablecoins.** Prices from USDT pairs are converted at **1 USDT = 1 USD**, and the rate line shows what USDT is really worth today (for example $0.9987). On Coins.ph it also shows how far USDT's peso price is from the official peso rate.
- Rates are refreshed every 6 hours while **Update automatically** is on (the default), and whenever you press **Update now**. They are kept on the device for offline use; older than 3 days is marked.
- A peso volume shown in PHP is the dollar volume converted back at the reference rate, so it can differ slightly from the figure Coins.ph shows.

### Rate sources (choose, update, verify)
Open **⇄ Rate sources** in the header (or **Rate sources** at the end of the grey rate line). It shows every source with who publishes it, how the rate is made, how many currencies it covers, how often it changes and its terms, plus two links: the source's **Website** and **Open the data** — the exact address the app reads, so you can compare the numbers yourself. For Frankfurter, **Verify this rate** opens the list of central banks behind your currency's rate.

| Source | What it is | Currencies | Notes |
|---|---|---|---|
| **Automatic** (default) | Frankfurter; if it cannot be reached, fawazahmed0, then the built-in Gulf pegs | about 160 | never stops working |
| **Frankfurter** | central-bank reference rates, blended per currency, with the banks named | about 160 | pegs exact (SAR 3.75) |
| **European Central Bank** | the ECB's official euro reference rates, converted to a dollar base | about 30 | no SAR or AED; working days only |
| **ExchangeRate-API (open access)** | mid-market rates from a commercial provider | about 165 | the app shows its required credit "Rates By Exchange Rate API" |
| **fawazahmed0 currency-api** | community project, method not published | about 340 codes | |
| **FloatRates** | daily rates, method not published | about 145 | its SAR is not exactly the peg |

- **Credits (v2.8).** Wherever ExchangeRate-API's rates are on screen — the rate line, the expanded list and the detail
  sheet (also with chart replay open) — the app shows its required link **Rates By Exchange Rate API**. With the European
  Central Bank the rate line says *derived from ECB euro reference rates · Source: ECB statistics (rebased to USD by this
  app)*: the ECB publishes euro rates, and the app turns them into a dollar base itself.
- **Update now** fetches the chosen source straight away; **Last updated** shows when and **as of** shows the date the rates refer to. **Update automatically (every 6 hours)** can be switched off.
- When you choose one source, the app uses only that source. If it cannot be reached, the rate line says so and the last rates it gave are kept (or the Gulf pegs) — it never switches to another provider behind your back.
- **Custom source (not listed).** Type the source's name and address, open it in your browser, save its rates file (JSON) and press **Import its rates file**. The app reads the common formats (a list of rates against USD or another base). A custom source is marked **Not tested**: its rates are used exactly as you import them. For your security the app never connects to an address that is not on its list, so a custom source is updated by importing a new file. To have a source tested and added to the list, use **Send a written request to the developer** (it opens an e-mail with the name and address filled in).

### Timeframes and refresh
All sources offer the same 13 timeframes: 1 minute, 5 minutes, 15 minutes, 1 hour, 4 hours, 6 hours, 8 hours, 12 hours, daily, 2 days, 4 days, weekly and monthly. Where an exchange has no native bar (for example 2 and 4 days), the app builds it from shorter bars.

With **Auto** on, the scan repeats:
| Timeframe | Refresh |
|---|---|
| 1 and 5 minutes | every 30 seconds |
| 15 minutes and 1 hour | every minute |
| 4 to 12 hours | every 5 minutes |
| daily and longer | every 15 minutes |
| Coins.ph (any timeframe) | no faster than every 5 minutes |

### Asset classes
| Class | Examples | Notes |
|---|---|---|
| **Crypto** | BTC, ETH, SOL | Stablecoins and leveraged tokens are left out, on every quote. |
| **RWA** | ONDO, USDY, BUIDL | Tokenised real-world assets. |
| **Stocks (tokenised)** | AAPLX, TSLAB | On daily and shorter timeframes, scored only on bars inside US market hours. A stock split mutes the signal. |
| **Currencies (FX)** | EUR/USDT, USDT/PHP | The low-volatility rule is not applied. |
| **Commodities** | PAXG, XAUT (gold) | |

A pair on another stablecoin is classed like its USDT twin (PAXGUSDC is a commodity, like PAXGUSDT). Non-crypto assets need at least $250,000 of trading a day to be scored. When the real market behind a token is closed (evenings, weekends), its rows show **underlying closed**: token prices can drift and volume is thin, so treat those signals with care.

## 8. Philippine market (Coins.ph)
![The Coins.ph peso market with the local-market note.](images/coinsph-scan.webp)

- Choose **Coins.ph (PH)** under **Data source**. Prices follow your **display currency** like every other source — choose **PHP** to see pesos (₱). Volume is valued in US dollars with Coins.ph's own USDT/PHP price. A blue note above the list reminds you that this is the local peso market.
- **Peso books are thin.** Most Coins.ph volume is people swapping pesos and stablecoins. Pairs with less than about $250,000 of trading a day are left out of the scan, because a few orders can move their candles. The note counts them; point at the count to see which coins they are.
- **USDT/PHP and USDC/PHP** are the peso against the dollar, so they appear under **Asset class → Currencies**, not crypto.
- **PH premium** (detail sheet): how far the peso price sits above or below the global price for the same coin. It is information only and does not change the score.
- **USDT premium** (rate line, v2.7): how far Coins.ph's USDT peso price is from the official peso rate.
- **Slower refresh.** Coins.ph allows each internet connection only about 120 requests a minute (heavier requests may count more). The app scans at most 40 pairs from this source and auto-refreshes no faster than every 5 minutes. If Coins.ph asks it to slow down, only Coins.ph pauses — the other sources keep working — and it resumes by itself. A **Refresh** right after a scan can take up to a minute to start, because the app waits until it is back under the limit.
- **Not available:** no public price feed was found for PDAX, GCash GCrypto, Maya, GoTyme or UnionBank, so they are not included. If one publishes such a feed, it can be added later.
- **Web version:** the published web app and the local launcher reach Coins.ph through their own address. If you put the web files on another host, Coins.ph may show **Blocked or unreachable**; the installed apps are not affected. This relay of Coins.ph's public prices (through Netlify on the published web app) serves **personal use only** until Coins.ph confirms in writing that its public market data may be relayed; that confirmation has not been received yet.
- **Bybit and Bitget in the Philippines.** In the Philippines the SEC's advisory of 4 August 2025 lists Bybit and Bitget among unregistered crypto platforms, and some internet providers block them. The app only reads their public prices; connecting an account key under API is your own decision under local rules.
- Peso prices are always fetched live. The web app's offline copy never stores them, so a scan never shows old Coins.ph prices as current.
- Coins.ph is never offered under **API** — there is no account connection for it — and its peso pairs are not proposed in paper trading (the paper account is in USDT).

![The PH premium in the detail sheet.](images/coinsph-detail.webp)

## 9. Watchlists, filters, saved scans and scoring profiles
### Watch field
Type assets into **Watch BTC, ETH…** (for example `BTC ETH SOL`) and press **Apply**. The scan then fetches only those assets, in the current quote. Clear the field and apply to scan the top N again. Up to 100 assets.

### Watchlists
![Watchlists panel.](images/watchlists.webp)

1. Type a **Watchlist name** (up to 60 characters, unique).
2. **Save filtered results** saves the rows that match the current filter, or **Import monitored instruments** saves the assets in the Watch field.
3. **Scan** next to a list limits the scan to it, switches to the source the list was made on and sets the asset class to **All classes**. A chip with the list name appears; click **×** to go back to the full scan. **Delete** removes the list.

### Filter and sort
**Filter…** keeps rows whose symbol contains your text (not case-sensitive). Sort by clicking a column heading.

### Saved scans
![Saved scans panel.](images/saved-scans.webp)

A saved scan keeps the timeframe, source, Top N, asset class, sort, Watch list and filter. Type a **Scan name** and choose **Save current scan**. Each saved scan has **Apply**, **Rename** and **Delete** (delete does not ask first). Applying a saved scan ends any watchlist scan.

### Scoring profile
![Scoring profile: turn individual indicator votes on or off.](images/scoring-profile.webp)

The scoring profile turns individual indicators on or off; weights and thresholds stay fixed. Untick an indicator, then **Apply scoring profile**. The button changes to **Scoring profile · Custom**.
- A custom profile gets its own **engine** code, so the signal ledger never mixes its results with the default engine.
- **Reset scoring draft** turns all 18 indicators back on (press **Apply scoring profile** to use it).
- **Export scoring profile** saves it as `scoring-profile.json`. **Import scoring profile** loads a saved file into the editor; press **Apply scoring profile** to use it.
- A signal still needs at least 70% of the enabled indicators to be calculable. With no indicator ticked, every signal is suppressed.
- **Liquidity floor (crypto, 24 h volume)** (v2.8, in the same panel): crypto pairs with less 24-hour quote volume than
  this are left out of the score, with a note in the summary strip (section 4). Default **$1M**; choose $250k–$10M or
  **Off**. The volume is in US dollars, valued at the quote's own price on the same exchange (1 USDT = 1 USD) — the
  display currency never changes it. Coins.ph peso pairs keep their own thin-pair rule (section 8). It is a scan setting,
  not a paper-trading rule: a pair that holds an open or pending paper trade on the scanned source and timeframe keeps
  receiving its bars for the paper simulator (stops, targets, time stop and lock closes) even when the floor — or the
  list length or watch list — leaves it out of the list. It is still not shown, scored, recorded or alerted on. If its
  bars cannot be loaded, the paper window says so and names the pair, the source and the timeframe.

## 10. Alerts
### Reversal alerts (🔔)
When a scan finds new reversals with MOD or HIGH confidence, the 🔔 list shows them (up to 12), replacing the previous list. The same asset and direction stays quiet for six bars. Click an alert to open that asset; **Clear alerts** empties the list. The list is kept while the app is open; there are no sound or system notifications.

### Alert inbox
![Alert inbox rules.](images/alert-inbox.webp)

The alert inbox works with the optional external recorder, which watches the market while the app is closed.
- Choose a rule: **Score crossing** (a threshold from −100 to 100, default 70) or **Rank rise** (an asset climbing 1–299 places, default 5; not on the monthly timeframe).
- Rules apply to a watchlist: start a watchlist scan first (section 9). **Export active watchlist rule** then saves `workspace-rules.json` for the recorder. **Import recorder inbox** loads the alerts it found (the newest 5,000 are kept).
- **Local gateway sync** exchanges rules and alerts directly with the local gateway (section 13). It works only when the gateway was started with the recorder folder set (`CONFLUENCE_RECORDER_DIR`).
- Click an alert to see the matching ledger entry.

<!-- wp:WP25 -->
### Market radar (v2.8)
The **Radar** answers one question: *is a move building across the world market, and who is pushing it?* It is **context, never a vote**. No radar value changes a score, a signal or a paper-trading rule; no radar alert blocks or places a trade (the paper depeg gate of section 12 is a separate rule and is unchanged); the engine code stays `5c30b5c39f5ba3f2`. The radar is an analysis aid, not financial advice. Everything on it describes the market through **Bitcoin** (the market's reference asset); positioning and the CFTC positions also cover Ether.

**Where it is.** A small **Radar** tab sits on the right edge of the screen (on the left in Arabic and Urdu, where the page runs right to left). Click it, or press **R**, to open the panel; **Esc**, the close button in the panel or **R** again closes it. The panel opens below the header, so the header controls stay reachable: on a screen **1,024 px wide or more** it is a side panel beside the list, and below that it is a sheet from the bottom edge (a tap outside closes it). The panel is **collapsed by default**. Whether it is open, which sections you collapsed and your alert thresholds are remembered **on this device** (browser storage; they are not in a backup). **R** does nothing while you type in a field or menu or while another dialog is open. With *reduce motion* set on your device the panel appears without sliding.

**When the radar contacts the internet.** Only while the panel is **open**, or while **Record radar context** is on (**Scoring profile**, section 9; default **off**). Otherwise no radar request is made, no live connection is open, the timers are stopped and the ledger's radar field stays empty. So the default install contacts no radar host. The same rule covers the two liquidation connections and the gateway's provider data. While it runs, the radar refreshes **every 5 minutes**; the inputs that change once a day (the 30-day premium baselines, the daily volumes, stablecoin supply) are read **once per UTC day**; the CFTC report **at most every 12 hours**. Each venue is paced below its documented limit (**Binance futures** at 80 % of the strictest one, the free **CFTC** and **DefiLlama** hosts at a conservative 2 requests per 10 seconds) and a venue that answers *429* or *418* is left alone until it allows requests again, while the other sections keep refreshing. The panel remembers that it was open, so after a reload it starts contacting the hosts again. A section whose source cannot be reached shows **Unavailable — last value 14:35** (the time that value was good), or just **Unavailable** if it never had one; the other sections are not affected.

**Positioning** (Binance USDⓈ-M perpetual futures, **BTCUSDT** and **ETHUSDT**).
- **Funding** is the latest funding rate; the **30-day percentile** says how that rate ranks among the last 90 funding payments (30 days at 8 hours): 95 means funding is at or above 95 % of them. It needs all 90.
- **Open interest** is the size of open contracts, in coins; the change is against the sample 24 hours earlier.
- **Long/short accounts** is the ratio of accounts that are long to those that are short (the panel also shows the long share in %), and **Taker buy/sell** is the ratio of volume bought by takers to volume sold by takers, both from the newest 1-hour sample.
- **Basis** is the perpetual's mark price against its index price, in %. It uses Binance's own perpetual only.

**Liquidations and the cascade check.** At the end of **Positioning** the panel lists, for **Bybit** and **Binance** USDⓈ-M, the **BTC and ETH perpetual** liquidations of the **last hour**: how much was **long** (longs forced out) and how much was **short**, in US dollars. They come from two live connections that open only while the panel is open or **Record radar context** is on, and close with it; the figures update every few seconds and say "not connected" while a venue is down. **Binance sends at most one liquidation per symbol per second, so its figures are *sampled* and are marked that way** wherever they appear, in the alerts too; Bybit's are complete. Under each venue the **cascade check** compares the last hour with the **median complete hour of the last 720 hours (30 days)** kept in a log on this device. Hours when the app was closed or the connection broke are left out, never counted as zero, so it says **collecting the baseline (n of 720 hours logged on this device)** until 720 complete hours exist, and no cascade alert is possible before then. After that, a venue alerts when its last hour is at least the **Liquidation cascade** threshold times that median (starting value **3 ×**, adjustable from 1.5 to 20 under **Alert thresholds**). Reaching 720 complete hours realistically needs the recorder running in continuous mode, or **Record radar context** on with the app open, for about 30 days. The app's baseline (kept in the browser) and the recorder's baseline (`radar/liq.json`) are separate: each builds its own. Like every radar value it is context only.

**Buyer pressure** (Binance spot **BTCUSDT**). A small chart of the **taker-buy share** of each hour's volume over the last 24 hours (above 50 % means buyers hit the ask more than sellers hit the bid), and the **session shares** of the last week's traded value by the hour a bar opens, in UTC: **Asia 21:00–07:59** (the evening hours 21:00–23:59 are counted with the Asia session that follows), **Europe 08:00–13:59**, **US 14:00–20:59**. The three shares add up to 100 %.

**Regional demand.** Each region's Bitcoin price against Binance BTCUSDT; positive means the region pays more.
- **United States:** Coinbase BTC-USD ÷ Binance BTCUSDT − 1.
- **Korea:** Upbit KRW-BTC ÷ (Upbit KRW-USDT × Binance BTCUSDT) − 1. **Caveat:** it leaves out **USDT's own premium or discount in won** (dividing by Upbit's KRW-USDT removes the won-against-dollar rate, but not what Korean buyers pay for USDT itself), so it is Bitcoin's premium over USDT in won, not over the dollar. Read it as a direction, not an exact arbitrage figure.
- **Philippines:** Coins.ph BTC-PHP, converted at the Coins.ph USDT-PHP rate (USDC-PHP if USDT is missing), ÷ Binance BTCUSDT − 1 (the same figure as the **PH premium** of section 8).

**Institutions.**
- **CFTC Commitments of Traders** (Traders in Financial Futures, futures only) for **CME Bitcoin** (contract 133741) and **CME Ether** (146021): for **asset managers** and for **leveraged funds**, each as a group, the long, short and net positions (net = long − short) and the change in net since the previous report. The positions are **as of Tuesday** and are **usually published on Friday at 3:30 p.m. US Eastern time**; the panel shows the report date, so the numbers are always a few days old. They are groups of traders, not any one fund's book.
- **ETF flows (imported).** The radar does not fetch ETF flows. Choose **Import ETF flows (CSV)** and pick a file; it stays on this device. The first row is the header `date,issuer,flow_usd` (three columns, any letter case; commas only, no quotes — a file saved with semicolons or quoted cells is rejected), then one row per issuer per day: `date` as `YYYY-MM-DD` (a real calendar date), `issuer` as letters, digits, spaces, `.`, `&` or `-` (up to 40, not starting with `+ - = @`), and `flow_usd` a plain number in US dollars (negative = outflow, at most 100 billion). Example: `2026-11-12,Example Fund,125000000`. The file may be at most **1 MB**. After the import the panel says **Imported n rows · r rejected · d duplicates**: a rejected row is one with the wrong columns, a bad date, issuer or number, or a cell a spreadsheet could read as a formula; for a date and issuer given twice the last row wins and the earlier one counts as a duplicate. Rows already imported are merged (a re-import replaces the same date and issuer), the newest **800 days** are kept, and the panel shows the net flow per day for the last 10 days.
- **Live ETF flows** and **Large transfers** (Whale Alert) show **Available with a key on the desktop gateway** until you add the matching key (see **Paid data keys (optional)** below); without a key nothing is fetched for them.

**Alerts.** Each alert says what triggered it, since when, and links its source. **Alert thresholds** are **starting values**, not recommendations: change them in the panel (they are stored on this device, and **Reset to starting values** restores them). A changed threshold re-checks the last fetched data at once, with no new request.
- **Exchange price break-away.** Bitcoin priced in dollars through each venue's own USDT market (Binance, Bybit, Bitget, OKX, Coinbase, Upbit and Coins.ph). A venue alerts when its price is **at least 1 %** away from the **median of at least two other venues**, on the same side every time, for **at least 2 closed 1-hour bars** in a row, counting back from the latest closed hour (range 0.2–10 % and 1–6 bars). A venue that stands apart for hours can be a sign of an exchange problem such as a withdrawal freeze, but it is only a sign. Upbit (won) and Coins.ph (pesos) always sit at a premium, so each is compared **after removing its own standing premium**: the median of its premium over the last **30 daily closes**, worked out at once from daily bars. A venue with **fewer than 20** of those days is **left out** of the check, and the panel says so. A venue with no prices is left out the same way. The alert code is `BREAKAWAY_<VENUE>`.
- **Volume spike.** Bitcoin's traded volume of the last closed UTC day, summed over six venues (Binance, Bybit, Bitget, OKX, Coinbase BTC-USD and Upbit KRW-BTC; at least four must answer), is compared with the previous 30 days: it alerts when the **z-score is 3 or more** (z = (day − 30-day mean) ÷ the sample standard deviation, range 1.5–10; a spike up only). Code `VOL_SPIKE`.
- **Stablecoin depeg.** Read from the stablecoin prices of the **current scan** (no extra request), with the tiers used everywhere in the app: **watch** from 0.5 %, **warning** from 1 %, **severe** from 2 % away from 1:1. Code `DEPEG_<COIN>`. The radar only shows it; the paper depeg gate stays a separate rule.
- **Stablecoin supply jump.** DefiLlama's total US-dollar stablecoin supply, once a day. It alerts when today's change, up or down, is **larger than the 99th percentile** of the daily changes of the **prior 90 days** (range 90–99.9), and says whether supply **grew** (a mint) or **shrank** (a redemption). It needs 91 consecutive daily points. Code `SUPPLY_JUMP`.
- **Hacks.** A link to DefiLlama's hack history opens in your browser; the radar does not read it.
- **Liquidation cascade.** An alert per venue when the last hour of liquidations is at least **3 ×** the median hour (see **Liquidations and the cascade check** above).
- **Large transfer.** With a Whale Alert key connected, the **largest transfer of the last hour at or above the Large transfer threshold** (starting value **US$10 million**, whole dollars from 1 million to 10 billion) raises one alert, code `WHALE_TRANSFER`, naming the amount, the coin, where it moved from and to, and the chain (see **Large transfers and live ETF flows** below).

**Paid data keys (optional).** Two extra radar rows need a paid key from a data provider, added in **Private API → Data providers (optional, paid)** (the **API** button in the header; check the local gateway first, section 13):
- **CoinGlass** unlocks **Live ETF flows**: the daily net flow of the US spot Bitcoin and Ether ETFs, per fund ticker.
- **Whale Alert** unlocks **Large transfers**: big on-chain transfers as they happen, and the **Large transfer** alert.
- Both are **paid plans for personal use**; the radar adds no key of its own and works without them. A key is typed into the dialog once and the field is cleared at once. It is kept **only in the memory of the gateway on this PC**: never in the web app's storage, a backup, a log or an error message, and it is **forgotten when the gateway stops** (after a restart the dialog shows nothing for that key: add it again). The web app only ever holds the gateway's own session token, in page memory. The gateway contacts a provider only for a key you added: it checks the key once when you add it, then reads CoinGlass when the Radar asks for ETF flows and keeps the Whale Alert stream open while the Radar polls it (the stream lingers for up to 15 minutes after the last poll, then closes). A provider key is a separate kind from an exchange key: exchange keys with trading or withdrawal permission are still refused. If the gateway no longer accepts the token (it was restarted), each row that has a matching key profile says **The gateway did not accept the token. Reconnect with the API button in the header.** and the rest of the radar keeps updating. If Whale Alert itself refuses the key, the row says **Whale Alert refused this key. Check the subscription, then add the key again.**; the gateway then stops asking for 15 minutes (or until you add the key again).

**Large transfers and live ETF flows.** Both appear in the panel only when the gateway holds the matching key; every figure comes from the provider, is checked again by the app and shown as plain text.
- **Live ETF flows (CoinGlass, via your gateway)** sits under the imported flows in **Institutions**. It lists, for **Bitcoin** and for **Ether** spot ETFs, the **net flow per day** for the last 10 days, newest first; click a day to see each fund ticker's figure. A fund with no figure for a day is **left out, not counted as zero**, and the latest day may still be revised. The data is read at most **every 6 hours**; if the gateway cannot reach CoinGlass the last values stay on screen marked **Unavailable — last value**.
- **Large transfers (Whale Alert, via your gateway)** sits in **Alerts**. It lists the **newest 10 transfers of the last 24 hours at or above the threshold**: time, amount and coin, the US-dollar value, from → to, and the chain. The **Large transfer (US$ minimum)** field under **Alert thresholds** sets the threshold. Raising it hides smaller transfers at once; lowering it shows smaller ones from the next refresh (within 5 minutes). It says **Connecting to Whale Alert…** until the stream is up and **No transfer at or above the threshold in the last 24 hours.** when there is none. The gateway keeps one Whale Alert stream open at the lowest minimum asked for and lets it go 15 minutes after the panel closes.
- Like everything on the radar these are **context only**: no score, signal or paper rule changes and nothing blocks or places a trade.

**Data sources & thanks.** The last section of the panel is the same list as **About → Data sources & thanks**; it now also names **Binance USDⓈ-M Futures**, the **CFTC Commitments of Traders** and **DefiLlama**, each with links to its documentation and terms.

**In the ledger (section 11).** With **Record radar context** on, each new ledger row also keeps the radar's **Bitcoin** values as of its bar close (**rad**): funding percentile, 24-hour open-interest change, long/short ratio, taker-buy share of the newest closed hour, the US, Korea and Philippines premiums and the codes of the active alerts. It takes the **newest radar reading at or before the bar's close and no more than 2 hours old**, never a later one, so it cannot look ahead; a field the radar had no current value for stays empty, and with the setting off (or no reading that recent) the whole field is empty. Radar readings are logged every 5 minutes while the setting is on, even with the panel closed. The CSV export has eight columns after **fund_trend**: `radar_funding_pctl`, `radar_oi_chg_24h`, `radar_long_short`, `radar_taker_share`, `radar_us_premium`, `radar_kr_premium`, `radar_ph_premium` and `radar_alerts` (codes joined by `|`). It is measurement only and never enters the score. The optional recorder does the same with `--radar on` (default off); see `docs/recorder.md`. In continuous mode the recorder also listens to the two liquidation streams and builds the cascade baseline in `radar/liq.json`; `--once` does not.

## 11. Signal ledger: measure before you trust
Every scored closed bar is recorded with the engine version. The ledger shows how those signals actually played out, after costs, for the current source and timeframe. Open it with **Ledger** in the header. Each pair is its own series, so BTCUSDT and BTCUSDC are measured separately; the BTC benchmark is the scan's own BTC pair.

![The signal ledger.](images/ledger.webp)

- **Engine**: the scoring engine's code. Results from different engines are never pooled.
- **Signals recorded** and **trials**; rows left out during warm-up.
- **Window**: the full 1,000-bar window, or ≥ 300 bars (more data, some warm-up bias).
- **Horizon**: how many bars after the signal to measure: +1, +3, +6 (default), +12 or +24.
- **Results by group**: hit rate against the base rate, mean net result in basis points (bp), edge against the base, profit factor and a 95% confidence interval.
- **Score calibration**: the average move for each score band, so you can see whether higher scores led to bigger moves.
- **Costs**: each outcome enters at the next bar's open and pays fees, slippage and (on perpetuals) funding.
- **Spot SELL** groups (v2.8): on spot sources a SELL cannot be shorted, so those groups are labelled **(long avoided)**
  next to the short result — read them as the losses a long would have avoided.
- **Days needed at the current Sharpe** (v2.8): how many days of signals it would take, at the current Sharpe, for the
  probabilistic Sharpe to reach 0.95 — in total and beyond the blocks already logged. When the current Sharpe is zero or
  negative it gives no figure. Small edges usually take **years** to confirm, not weeks.
- **What each row records** (v2.8, engine 2.4.0): the 18 individual votes, the Pattern output, and the funding rate and
  open-interest change when a recorder snapshot of at most 2 hours is available (otherwise empty). They are logged and
  exported, never scored. Rows of engine 2.3.0 stay and are reported separately.
- **Scenario check** (v2.8, collapsed at the end of the ledger, after the report): each recorded row also keeps what the
  Scenarios section computed at that bar, logged and never scored. **`scb`** holds the 6-bar band edges (2.5, 16, 84 and 97.5 %
  of the simulated closes, as the log of the band divided by the signal close); **`scp`** holds the Fund trend state, the
  three scenario odds, the coin's base-rate odds, σ_6 and a flag saying the overall odds were used. The check scores
  them at the official horizon of **6 bars** on the **last 1,000 bars** (the same computation in the scan, the catch-up and
  the recorder), with non-overlapping 6-bar windows per series:
  - **Band coverage**: how often the realised 6-bar return fell inside each band, against the targets **68 %** (16–84 %)
    and **95 %** (2.5–97.5 %), with a Wilson range. A fan that is too narrow covers less than its target.
  - **Brier score** (three outcomes, lower is better): the scenario odds against the base-rate odds. Rows that fell back to
    the overall odds are skipped, because they carry no odds of their own. If scenarios score no better than the base rate,
    they add nothing.
  - Only rows that also pass the ledger's own usable-row filter are checked; closed-market rows and rows under the
    bar-count minimum are not. Rows whose bars are no longer stored are counted as not measured.
  - The CSV export has **13 scenario columns** after the Radar columns: `scenario_band_lo95`, `scenario_band_lo68`,
    `scenario_band_hi68`, `scenario_band_hi95`, `scenario_state`, `scenario_p_up`, `scenario_p_range`, `scenario_p_down`,
    `scenario_base_up`, `scenario_base_range`, `scenario_base_down`, `scenario_width`, `scenario_fallback`.
- **Classic vs Confluence v2 (test)** (v2.8, collapsed, just before the Scenario check): the same rows and the same measured
  outcomes, scored once with Classic's label and once with Confluence v2's (the entry, the costs and the funding are shared;
  only the direction, and so the net result, differs). For each engine and the chosen horizon it shows the number of signals,
  hit rate, mean net result and edge in basis points, rank IC t, probabilistic Sharpe and the **label changes per 100 bars**.
  Only rows of the Confluence v2 version shown in the section are compared: rows recorded without v2 (before v2.8, or too
  little history) are listed as **not compared**, and rows that carry another Confluence v2 version are counted on their own
  line and are not compared either (versions are never pooled). The comparison is worked out only when you open the section,
  after Classic's report is on screen, so a closed section costs nothing. The CSV export has **four v2
  columns** after the scenario ones: `v2_config_id`, `v2_score`, `v2_direction`, `v2_strength`. It is a comparison only:
  **nothing switches over**, and Classic's report, check and pre-registration never read v2.

| Source | Fee per side | Slippage per side | Funding per 8 h |
|---|---|---|---|
| Binance Spot, Bybit Spot, Bitget Spot | 10 bp | 5 bp | 0 |
| Bybit Perpetual | 5.5 bp | 5 bp | 1 bp |
| Bitget Perpetual | 6 bp | 5 bp | 1 bp |
| Coins.ph (PH) | 30 bp | 15 bp | 0 |
| OKX Spot (v2.8) | 10 bp | 5 bp | 0 |
| OKX Perpetual (v2.8) | 6 bp | 5 bp | 1 bp |
| Coinbase (US) (v2.8) | 60 bp | 5 bp | 0 |
| Upbit (KR) (v2.8): KRW markets | 5 bp | 5 bp | 0 |
| Upbit (KR) (v2.8): BTC and USDT markets | 25 bp | 5 bp | 0 |

Other stablecoin quotes on the same exchange use the same costs. The OKX and Upbit fees are not yet confirmed on the
exchanges' own fee pages (Upbit's come from a 2026 review of the exchange). RWA and stocks add 10 bp slippage, commodities 5 bp, currencies 3 bp.

### The check
![The measurement check and pre-registration.](images/ledger-gate.webp)

**Indicative check passed** appears only when all nine conditions hold; otherwise it says **Not proven yet** and shows which ones are missing:
| Condition | Why |
|---|---|
| At least 200 measured signals | Fewer is mostly noise. |
| Positive edge after costs | It must beat doing nothing, after paying to trade. |
| Still positive at 2× costs | A thin edge disappears with real-world costs. |
| Rank IC t-stat ≥ 2 | Higher scores should rank future moves correctly. |
| Probabilistic Sharpe ≥ 0.95 | The result is unlikely to be luck. |
| Deflated Sharpe ≥ 0.95 | Same, after allowing for how many settings you tried. |
| Beats label shuffling (p ≤ 0.05) | Random signals must do worse. |
| Beats 20-bar momentum | A simple trend rule must do worse. |
| Pre-registered horizon, decision date reached | The test was fixed in advance. |

**Pre-registration.** Choose a horizon and press **Pre-register h = N**. The hypothesis is then fixed and the verdict can be read only after at least 90 days, using signals recorded after that moment. This prevents choosing the best-looking horizon after the fact. In this confirmatory view the deflated Sharpe counts only the active pre-registered hypotheses of the current engine (v2.8); the exploratory view keeps counting every view you looked at.

### Keep the ledger safe
- **Export CSV** or **Export JSON** at least weekly; the dialog reminds you. An export holds the current source, timeframe and asset class only, so export each one you use.
- **Import ledger** restores a JSON or CSV export (CSV from v2.8) or a recorder file. Every row is checked; duplicates are ignored and Coins.ph rows are not accepted.
- In the browser version, press **Keep storage** to ask the browser not to delete the ledger when space is low.
- **Clear ledger** deletes every recorded signal for **all** sources and timeframes, for good, after a confirmation.

<!-- wp:WP19 -->
## 12. Paper trading
Paper trading practises the discipline the ledger asks for. STRONG score bands become practice **proposals** (not yet validated by the ledger), a risk engine checks each one, and only you can approve. No order is ever sent to any exchange.

![Paper trading: account, locks and proposals.](images/paper.webp)

### How it works
1. Every **STRONG** BUY or SELL in the current scan becomes a proposal: long for BUY, short for SELL, with size, stop and target worked out from the risk settings and the 14-bar ATR.
2. The risk check runs straight away. A proposal that passes says *Risk check passed*; one that fails says what blocked it.
3. **Approve** or **Reject**. A proposal expires when the next bar closes, and each one can be decided only once.
4. An approved trade fills at the **next bar's open** (never at the signal price). Stop and target are re-anchored to the fill. If a bar touches both, the stop counts first; a gap through the stop exits at the open.
5. **Close at next open** exits manually; **Cancel** withdraws an order that has not filled yet.
6. **Add a note** (v2.8, optional and collapsed) under a proposal takes a short *Why this trade?* reason and a **Setup**
   tag. On an approved trade they are kept with the trade and exported in the journal CSV. **Approve** stays one click.

**Costs inside the risk budget (v2.8).** The size is the risk budget ÷ (stop distance + entry × round-trip cost), where the
round trip is 2 × (fee + slippage). So a clean stop-out loses about **1 R** (slightly less — about −0.98 R on Binance and
−0.95 R on Coins.ph for a stop 2% away — because the stop is placed from the filled entry); in v2.7 the same stop lost about
−1.12 R and −1.37 R. Funding is not in the budget, and a gap through the stop can still lose more than 1 R. Where the scan
has measured an order book in the last 24 hours (top 10 pairs per source, once a day), that pair's **measured slippage**
replaces the default slippage in sizing and fills.

**Proposals that are blocked (v2.8).** Besides the locks below and the existing limits, a proposal is blocked:
- **Event blackout** (on by default): from 2 hours before to 1 hour after an FOMC decision, US CPI or US jobs report (the
  ECB decision is shown in the macro banner but never blocks). Turn it off with *Pause around FOMC, CPI and jobs reports*.
- **Crypto cap**: at most **3** open crypto positions (crypto moves together).
- **Depeg**: when the quote stablecoin is 1% or more off its peg against USDT (USDT itself is the reference).
- **Intraday**: proposals from 1-minute to 15-minute charts are context only by default; *Allow 1m–15m proposals* lets
  them through.

**Time stop** (off by default): when you turn it on it is preset to 24 bars; a trade still open after that many bars exits
at the next open, reason *time*. **Warnings:** risk per trade above 1% of equity shows a warning on each proposal, and the
total notional is capped at 1 × equity until liquidation is modelled. **Rejected** proposals, with any note and the result the
same ATR bracket later gave, are kept in the paper account on this device; they are not shown on screen or exported yet.

**Currency (v2.7).** The paper account is kept in US dollars (USDT), so only pairs quoted in a dollar stablecoin (USDT, USDC, FDUSD …) can be proposed, plus (v2.8) Coinbase's own USD pairs; peso (Coins.ph), won and BTC-market (Upbit) and euro pairs are refused with a reason. One position per coin: BTCUSDT and BTCUSDC count as the same exposure.

### Locks
- **Daily and weekly loss locks** block new approvals after the set loss. From v2.8 **open losses count**: the lock
  compares equity (open P&L included) with the first mark at or after 00:00 UTC each day / each Monday.
- **Drawdown lock** (v2.8, default **10%**, 1–50%): when equity, open P&L included, falls 10% below its highest mark, the
  app (a) blocks new trades, (b) cancels pending positions — they are removed without a journal entry, since they never
  filled — and (c) closes every open trade at the **next open of its own chart**, reason *drawdown lock*. A position whose
  chart is not being scanned (another source or timeframe) closes at that chart's next scan; the dead-man badge shows
  it. A pair left out of the list by the liquidity floor, the list length or the watch list still gets its bars on its
  own source and timeframe, so it closes too (section 9). The highest mark is checked
  after every scan with each position at its latest price (bars missed while the app was closed are marked at the next
  scan from their real closes). A **Drawdown lock** badge and a red **RESET** box appear only while the lock is active.
  - **Losses can exceed 10%.** The closes happen at the next bar's open, so gaps, moves between marks, exit costs and a
    longer timeframe's wait for its next open can take the loss past the limit.
  - **RESET.** After every lock close has filled (no open or pending positions), type `RESET` (the same word as the kill
    switch, a separate button) and press **Reset drawdown lock**: the highest mark restarts at current equity — a fresh
    10% — and the reset is recorded with the account (the trade journal and its statistics are unchanged). While closes
    are still waiting, the button is disabled and names each pair with its source and timeframe, for example *Reset
    drawdown lock (scan Binance · 4 hours: SOLUSDT first)*. If a pair's bars could not be loaded, a line says so and
    names it; the next scan tries again. RESET keeps the loss; it only restarts the 10% from where you are.
  - **How prop firms compare.** Topstep closes positions at its Maximum Loss Limit, which trails the end-of-day balance;
    FTMO's Maximum Loss is 10% of initial capital measured on equity (2-Step; on the 1-Step the floor trails the highest
    end-of-day balance). This lock trails the highest **marked** equity, which is stricter. Topstep's paid Reset restarts a
    Trading Combine at its starting balance; this RESET keeps the loss and only restarts the 10% from current equity.
- **Kill switch** blocks every new approval until you reset it (type `RESET`). It does not close open positions.
- **Dead-man switch**: if no scan has run for the set number of bars, approvals stop and open positions are marked unmanaged. Keep the app scanning while you hold paper positions.
- **No loosening while locked (v2.8).** While the daily, weekly or drawdown lock or the kill switch is active, the app
  refuses to raise a loss lock, risk per trade, open risk or total notional; that is allowed again from the next UTC day
  after the lock clears (the drawdown lock clears only by RESET). The dead-man switch does not count here.

### Journal
Closed trades are listed with costs, P&L and exit reason, plus trades, win rate, average win/loss in R, expectancy, net P&L and maximum drawdown (from v2.8 the largest percentage drawdown, tracked on its own). **More statistics** (collapsed) adds profit factor, a 95% range for the win rate, average MAE and MFE in R (how far trades went against and for you), and a histogram of trades by R; below 30 trades it says the figures are too few to judge. The CSV adds MAE, MFE, the pre-trade reason, the setup tag and notes, with localised column names. **Export CSV** saves the journal. **Replay trade** replays a closed trade on its saved candles, and **Annotate** adds tags and notes; the CSV's Notes column carries those notes, with the annotation tags in square brackets after them. The journal counts **closed** paper trades towards **50**, the number needed before anything beyond paper is even considered. Matching them to the recorded bars (reconciliation) is a separate step.

### Risk settings
![Risk settings and the kill switch.](images/paper-settings.webp)

| Setting | Default | Allowed |
|---|---|---|
| Starting equity (USDT) | 10,000 | any positive amount; can be changed only while the book is empty |
| Risk per trade (% of equity) | 0.5 | 0.01–5 |
| Max open risk (% of equity) | 2 | 0.1–20 |
| Max open positions | 5 | 1–50 |
| Max positions per cluster | 2 | 1–50 |
| Daily loss lock (%) | 2 | 0.1–50 |
| Weekly loss lock (%) | 5 | 0.1–80 |
| Stop distance (× ATR) | 2 | 0.25–10 |
| Target (× stop distance) | 2 | 0.25–10 |
| Minimum \|score\| | 55 | 0–100 |
| Max signal age (bars) | 1 | 0–10 |
| Dead-man limit (bars) | 3 | 1–100 |
| Max total notional (× equity) | 1 | 0.1–1 (v2.8: capped at 1 until liquidation is modelled) |
| Allow shorts on spot | off | on/off |
| Require a fresh signal | on | on/off |
| *More limits* (v2.8, collapsed): Drawdown lock (% below highest equity) | 10 | 1–50 |
| Max open crypto positions | 3 | 1–50 |
| Time stop (bars held; 0 = off) | 0 (off; preset 24 when turned on) | 0–1000 |
| Pause around FOMC, CPI and jobs reports | on | on/off |
| Allow 1m–15m proposals | off | on/off |

The v2.8 limits sit in the collapsed **More limits** section after the settings grid; it opens by itself when one of its fields is invalid. A *cluster* is a group of related assets: BTC and ETH (on any quote), other crypto, and each other asset class. **Save settings** applies them; **Revert** undoes unsaved changes. Starting equity can be changed only while no trade is open or recorded, and there is no button to reset the paper account.

## 13. Private API (read-only)
![Private API setup through the local gateway.](images/private-api.webp)

**API** lets you check a **read-only** Binance, Bybit or Bitget key, for example to confirm its permissions. Scanning never needs it.
1. On the computer, start the local gateway: `npm run gateway` in the gateway folder (or `pnpm gateway` from the project folder). It listens only on `127.0.0.1:8787` and prints a **gateway token**, which changes on every restart.
2. In **API**, choose the exchange and environment (testnet or mainnet), paste the token, your API key and secret (and the passphrase for Bitget), then **Test and connect**.
3. The dialog shows the key's label, a masked key and whether it is **Read only**, **Trading enabled** or **Permission unknown**.

From v2.8 the gateway only keeps a **read-only** key: a key that reports write permissions, or reports none on mainnet, is
refused. Binance testnet keys (which have no permissions endpoint) are allowed and labelled *permissions not reported*. A
Bitget key with an empty or missing permission list counts as unknown and is refused; a Bybit read-only key with an empty
permission list stays allowed.

Keys go only to the gateway on your own computer, which keeps them in memory; the browser never stores them and the form is cleared after connecting. Reloading the app forgets the connection. Create a dedicated read-only key with withdrawals disabled and an IP allowlist. The gateway has no order, withdrawal or transfer function.

<!-- wp:WP10 -->
## 14. Source health
The status line at the bottom shows the state of the source you are scanning:
- **OK** / **Slow** — working.
- **Rate-limited until hh:mm** — the exchange asked the app to wait; only that source pauses and it resumes by itself.
- **Blocked or unreachable** (web version) — the browser could not read the exchange and does not say why: the exchange may not allow web pages, your network may block it, or it may be asking for a pause. Try again later, the installed app, or another source.
- **Rate-limited** or **Network blocked** (installed apps, which can see the reason) — wait for the time shown, or, if your network or provider blocks the exchange, choose another source.
- **Stale** — the newest closed candle is too old to trust; those rows get no signal.

A failed source never borrows another source's candles. Missing rows are listed, not filled in.

## 15. Languages, themes and phone layout
![The language menu with each language's review status.](images/language-menu.webp)

- **Language**: 18 languages, in this order: English, العربية, 日本語, Filipino, বাংলা, اردو, Русский, हिन्दी, 中文（简体）, 한국어, Bahasa Indonesia, Bahasa Melayu, Türkçe, Français, Deutsch, Español, Português, Italiano. Type in **Search languages…** to find one quickly. Arabic and Urdu switch the layout to right-to-left. Brand names, symbols and numbers stay as they are. About lists each language's review status. The new v2.7 labels are translated in all 18 languages; the chart toolbar is in English.
- **Theme**: **System** follows your phone or computer; or choose **Light** or **Dark**.

![The dark theme.](images/terminal-dark.webp)

- **Phone layout**: the header becomes compact. **More controls** (the sliders button) holds quote, display currency, rate sources, asset class, Top N, watchlists, alert inbox, scoring profile, saved scans, filter, the Watch field with **Apply**, API, contact, About and theme. On Android the Back button closes the open dialog (or leaves chart full screen first).

![Phone layout.](images/phone.webp) ![The More controls panel on a phone.](images/phone-more-controls.webp)

## 16. Your data, backups and privacy
![About: workspace, storage, audit trail, backup, updates and languages.](images/about.webp)

- **Where data lives.** The desktop and mobile apps keep settings, identity and the audit trail in an on-device **SQLite** database. The browser version uses browser storage, which the browser may clear when space is low — the yellow banner reminds you. Candle history (up to 10,000 bars per asset and timeframe), the ledger, the paper book and the last exchange rates are stored on the device too.
- **Backup.** **About → Export backup** saves `ConfluenceTerminal_<CODE>_backup_<date>.rslbak`. It contains your identity, preferences (including the quote per source and the display currency), saved scans, watchlists, the alert inbox, the scoring profile, the audit trail and, from the market radar, any ETF flows you imported, its cached CFTC and stablecoin data and its 5-minute log. It does **not** contain the signal ledger (export it from the Ledger) or the paper account. From Paper you can export the journal as CSV, but the account, open positions and risk settings cannot be exported or restored. Back up weekly. **Before going back to v2.7, export the paper journal** (Export CSV) and note your open positions: v2.7 cannot read the v2.8 paper account and starts a fresh 10,000 USDT account over it on its first scan.
- **Restore.** **Restore backup** checks the file (format, checksum, app and version) before it replaces anything, then reloads. To keep an **encrypted copy in your own cloud storage** instead, see *Cloud backup (encrypted, v2.8)* below.
- **Audit trail.** A tamper-evident log of important actions: app start, settings changes, identity changes, backups, ledger exports and imports, and every paper-trading decision. About shows *intact (n entries)*, or *BROKEN at #k* if an entry was altered.
- **Identity.** **Edit identity** changes the workspace, logo and your name; **Export identity (JSON)** saves it.
- **Privacy.** The app only reads public data: market prices (Binance, Bybit, Bitget, Coins.ph — on the web, Coins.ph is reached through the app's own address), the public update file, and — only when a price needs converting, every 6 hours or on **Update now** — exchange rates from the source you chose: `api.frankfurter.dev` (Automatic falls back to `cdn.jsdelivr.net` / `latest.currency-api.pages.dev`), or `data-api.ecb.europa.eu`, `open.er-api.com` or `www.floatrates.com` when you pick them. A custom source is never contacted; you import its file. **Cloud backup hosts (v2.8)** are contacted only after you open **Cloud backup**, choose a provider and sign in; they are listed in that section. No account, identifier or cookie is sent and there is no tracking; like any web request, each source sees your internet address (for Coins.ph on the web, Netlify's). **On Windows**, the desktop app runs on Microsoft's WebView2 Runtime, whose Microsoft Defender SmartScreen (on by default) and automatic updates may contact Microsoft — see the WebView2 notice under **About → Open-source licences**.
- **Market radar hosts (v2.8).** Only while the **Radar** panel is open, or while **Record radar context** is on, the app also reads: `fapi.binance.com` (Binance USDⓈ-M futures: funding, open interest, long/short and taker ratios, mark and index price; GET only, no keys, no orders, no live stream), `publicreporting.cftc.gov` (weekly CFTC positions, at most every 12 hours), `stablecoins.llama.fi` (DefiLlama total stablecoin supply, once a day), and the exchange prices it already uses: Binance spot, Bybit, Bitget, OKX and Coinbase candles and prices, Upbit through the app's own relay (`/x/upbit/…` on the web) and Coins.ph (through the app's own address on the web). With the panel closed and the setting off, none of them is contacted. Nothing about you is sent; each source sees your internet address. An ETF file you import never leaves the device. The panel's remembered state (open or closed, collapsed sections, alert thresholds) stays in this device's browser storage and is not part of a backup; imported ETF rows, the radar's cache and its 5-minute log are saved with **Export backup** and come back with **Restore backup**.
- Market data belongs to each exchange and is shown for personal use. Exchange rates are reference rates for information, not rates you can trade at.

<!-- wp:WP28 -->
### Cloud backup (encrypted, v2.8)
**About → Cloud backup (encrypted)** (collapsed, just after **Backup**; **Settings…** in the desktop menu opens About) keeps an encrypted copy of your own records in your own cloud storage. Nothing is contacted, and nothing is sent anywhere, until you open the section, pick a provider and sign in. It is off by default and separate from **Export backup**, which is unchanged.

*Back up your ledger, paper journal, settings, pre-registrations and scoring profile to your own cloud storage. The file is encrypted on this device with your passphrase before it is uploaded. Market history stays on the device.*

- **What is in it.** Your signal-ledger rows with their measured **outcome snapshots** (so a new device keeps your scored outcomes even when the exchange no longer serves that history, for example after a delisting), the **universe snapshots** (the full ranking stored with each recorded bar, which guards against survivorship bias) and the **recorded gaps**; your pre-registrations and registered trials (so the multiple-testing count survives); the paper **journal** with its **trade notes** (the tags and notes you saved on a trade); your preferences and your scoring profile. Only **live** ledger rows are backed up: replay rows are left out on purpose, and the message says *n replay ledger rows are not backed up (only live rows are).*
- **What is not in it.** Market history (the app downloads it again); the **paper account, open positions and risk settings** (a restore must never loosen a drawdown lock, so these are left out on purpose); tokens, keys, your passphrase and the radar caches; replay rows (above); and three pieces of the ledger's own bookkeeping that belong to the device: the recording cursors (each device records from where it left off), the measured slippage (measured again from order books) and the time of the last ledger export.
- **Providers and where each works.**

| Provider | Web (hosted app) | Desktop app | Phone app |
|---|---|---|---|
| Google Drive | Desktop app only | Yes | Desktop app only |
| Microsoft OneDrive | Yes | Yes | Only when the build has the phone app link; otherwise "Web and desktop only" |
| pCloud | Yes | Yes | Only when the build has the phone app link; otherwise "Web and desktop only" |
| Backblaze B2 | Add a bucket key with Private API (the key button in the header) while the local gateway runs on this computer | Same | Desktop app only |
| Cloudflare R2 | Add a bucket key with Private API (the key button in the header) while the local gateway runs on this computer | Same | Desktop app only |

  A provider whose developer registration has not been done in this build shows **Not set up yet** and is never contacted. A web address other than the official one shows **Not set up for this web address**. Google Drive, OneDrive and pCloud store the file in a private area of your account (Google's hidden app data, OneDrive's app folder, and the folder `/rsL Confluence Backup` in pCloud). The app asks each provider for the narrowest access it offers; no sign-in script from any provider is loaded into the app.
- **The passphrase.** Choose one of **at least 12 characters** and type it twice. It is **never stored, logged or uploaded**, and it is not in the audit trail. **If you forget it, the backup cannot be opened**, by you or by anyone else. The app cannot reset it.
- **Encryption, in plain words.** The file is scrambled with AES-256-GCM, a standard cipher that also detects any change to the file. The key is made from your passphrase with PBKDF2-SHA-256 at 600,000 rounds, which makes guessing slow. A short header (version, rounds, backup time) is part of what is checked, so it cannot be altered either. The contents are compressed before they are encrypted. A long, unique passphrase matters more than anything else here.
- **Size limit.** The file is at most **20 MB**, and its contents at most 160 MB once unpacked. If it would be larger the app says *The backup would be … ; the limit is 20 MB. Export the ledger as CSV from the Ledger instead.* (or, over the unpacked limit, *The backup would be about …, and … once unpacked; the limits are 20 MB for the file and 160 MB unpacked.*) and uploads nothing. In practice 20 MB holds **about 120,000 live rows** without outcome snapshots (measured on rows with every field filled and varied values, about 710 bytes each before compression), and about 45,000 live rows when every row carries measured outcomes at all five horizons and every bar its universe snapshot. A year of a large 1-hour or 15-minute desktop ledger is often more: export it as CSV instead.
- **Delete old backups.** Every **Back up now** adds a new file of up to 20 MB, and the app never deletes one. Delete old backups yourself in the provider's own app or website: OneDrive's app folder, the pCloud folder `/rsL Confluence Backup`, the `rsl-confluence/` prefix of your B2 or R2 bucket; Google's hidden app data can only be removed as a whole (Google Drive settings, Manage apps). **Restore…** lists the newest first.
- **Back up now.** Choose the provider, **Sign in** (Google Drive, OneDrive and pCloud; B2 and R2 have no Sign in button, they use the bucket key added with **Private API**; once per session: the sign-in lives in memory and is gone when you reload; there is no refresh and nothing is saved), type the passphrase twice and choose **Back up now**. The file is named `confluence-backup-<date>T<time>Z.json`. If a few rows could not be read they are left out, and the message counts them (*Left out because a restore could not read them: …*).
- **Restore.** Choose **Restore…**, pick a file, enter the passphrase and read the plan **before** anything changes:
  - **Backup made …** is the time the backup was taken.
  - The counts say how many ledger rows, journal trades and pre-registrations are in the file and how many of them are **new** to this device; a second line does the same for measured outcomes, universe snapshots, recorded gaps and trade notes. A row's outcomes gain only the horizons this device has not measured, a note or gap already here is kept, and outcome and universe snapshots are kept only for rows this device keeps and while they fit under its row cap: no row is ever removed to make room for them (the plan counts those not kept). Records are **merged, never overwritten**: what you already have stays. Journal trades are matched by their content, and every restored trade that is not already on this device gets an id of the form `bk:<8 characters>:<original id>`. Restoring the same file again adds nothing twice.
  - Rows older than the device keeps, rows that could not be read, rows that would go over the device's row cap and days of rows older than the usual age limit are each counted and named in the plan, separately. The cap line says how many rows, on this device or in the backup, will be removed to stay within the limit; the age line says how many days of older rows are removed, as usual.
  - **Also restore settings and the scoring profile** replaces your preferences and scoring profile with the backup's. The box starts ticked; if your settings were changed after the backup, or differ from it, the plan says so and the box starts **unticked**: tick it only if you want the backup's settings.
  - **Restore** applies the plan; **Cancel** changes nothing. A wrong passphrase, a changed file, a file from a newer version, a file over 20 MB or one that fails the checks changes nothing at all. A restore reads plain data only and never runs anything from the file.
  - If a restore stops part-way (*Restore stopped part-way: … items were written. Running the same restore again is safe.*) the audit trail records what was written. Running it again is safe. The ledger is written in batches of at most 1,000 rows (or one day), each recorded in the ledger's index before it is written, so if this device's storage is full the restore stops at a clean point: everything written is counted, indexed and removed by age or the row cap as usual. Running it again stops at the same point until there is room (free space or **Clear ledger**), then it finishes.
- **Backblaze B2 and Cloudflare R2.** These work through the local gateway, a separate program you start by hand on this computer (`pnpm gateway` from the project folder, see section 13; the apps do not start it), with a key you create for **one bucket only** (Read and Write). With the gateway running, open **Private API** (the key button in the header), paste the gateway token and enter the key and the bucket. The key stays in the gateway's memory until the gateway stops: closing the app does not remove it, stopping the gateway does. The app refuses a key that can list other buckets. A "cannot list buckets" answer from the provider is normal for a limited key; it does not mean the key is wrong. Still create the key for one bucket.
- **OneDrive restore.** Backing up and listing work. Restoring a file may need OneDrive's download server, which this build does not allow yet: you will see *Restoring from OneDrive needs its download server (…), which this build does not allow yet.* Use another provider, or restore from a file you saved yourself, until a later version allows it.
- **Signing in on the desktop.** The sign-in opens your browser and returns to the app on this computer only (address `127.0.0.1`, port 48787). If another program uses that port you will see *Sign-in needs port 48787 on this computer, which another program is using.* For pCloud the token passes through your browser, which may keep that visit in its history; if that worries you, revoke the app's access in your pCloud account settings.
- **On the web, pCloud** sends you back to the app with its token in the page address. The app removes it from the address bar at once, but your browser history keeps that visit, token included, and a pCloud token does not expire. If that worries you, delete that entry from your browser history and revoke the app's access in your pCloud account settings (the list of apps with access); signing in again creates a new token.
- **Hosts contacted, and only after you sign in:** `login.microsoftonline.com` and `graph.microsoft.com` (OneDrive), `api.pcloud.com` or `eapi.pcloud.com` (pCloud, by your account's region), `oauth2.googleapis.com` and `www.googleapis.com` (Google Drive, desktop app only); the sign-in pages `accounts.google.com`, `login.microsoftonline.com` and `my.pcloud.com` open in your browser; B2 and R2 are reached by the local gateway only. Nothing about you is sent except what the provider needs to store your file.

<!-- wp:WP20 -->
### Licences and credits (v2.8)
- **About → Open-source licences** (collapsed, just above the credit line) says that the app includes open-source
  software and opens **Third-party notices (THIRD-PARTY-NOTICES.txt)**: every shipped component with its licence and
  copyright notice — the npm packages (with fallback texts for those published without a licence file), shadcn/ui (MIT),
  the fonts under the full SIL Open Font License 1.1 with each family's copyright line, and, in the desktop and phone
  apps, the Rust and native components (including MPL-2.0 parts with their source locations, SQLCipher, and Microsoft's
  WebView2 Runtime terms on Windows). The same section holds the trademark line: *Bollinger Bands® is a registered
  trademark of John Bollinger. Exchange and token names and logos belong to their owners and only identify the market; no
  affiliation or endorsement.*
- **About** names this edition *Personal build — no licence key required*. The app itself is © rsLozano, all rights
  reserved (the `LICENSE` file).
- **Data credits.** Rates from ExchangeRate-API carry *Rates By Exchange Rate API*; ECB rates carry *Source: ECB
  statistics (rebased to USD by this app)* (section 7). Coins.ph prices relayed on the web are for personal use only
  (section 8).

### Treat the developer to a coffee (optional, v2.8)
**About → ☕ Treat the developer to a coffee** (collapsed, just above Open-source licences) holds an optional tip card with
three codes to scan: GCash (QR Ph), PayPal and Bitcoin (on-chain only; **Copy address** copies the Bitcoin address). It is a
personal thank-you, never a fee: every feature works the same whether you tip or not, and the card never opens by itself.
Your payment app shows who you are paying before you confirm.
- **Binance Vision archive (backtesting tool).** The optional `fetch-binance-archive` tool downloads Binance's public
  monthly archives from data.binance.vision. Under the Binance Vision Terms of Use v1.0 (26 Aug 2026) that data is
  CC BY-NC-SA 4.0: personal, non-production backtesting only; credit Binance Vision and keep CC BY-NC-SA 4.0 on anything you
  share that is derived from it; commercial use needs a data licence from Binance. The app itself never uses the archive.

## 17. Updates
When a newer version is published, a line appears above the footer with the new version; on Android it also shows the download size and SHA-256 fingerprint. On the web, choose **Reload to update**. On Android, choose **Download update**: the system browser downloads the signed APK, and installing it keeps your data (from v2.6 to v2.7.0 only, uninstall first: see *Android: moving from v2.6* in §1). On iPhone, install the new build with Sideloadly. On desktop, install the new installer. **Later** hides the notice until the next version. Under **About → Updates** you can switch automatic checks off, check now, and see the last result. The check runs when the app opens, when it comes back online, and every 6 hours. It only reads one public file (`/updates/latest.json`); nothing is sent.

## 18. Offline use
Without a connection the last scan stays on screen and the footer shows **Offline**. Refresh when you are back online. Market data is never served from the offline copy. The display currency keeps working with the last saved rates (marked stale after 3 days), or with the built-in Gulf pegs.

## 19. Keyboard and desktop menu
| Keys | Where | Action |
|---|---|---|
| Enter | Watch field | Apply the list |
| ← → Home End | Chart | Move between candles |
| Shift + ← → | Chart | Pan |
| + / − / 0 | Chart | Zoom in / zoom out / reset view |
| F | Chart | Full screen on or off |
| I | Chart | Reflect view (mirror the price axis) on or off |
| Esc | Chart full screen | Leave full screen (the sheet stays open) |
| Ctrl/⌘ + wheel | Chart | Zoom at the cursor |
| ↑ ↓ Enter Esc | Language menu | Choose a language |
| R | Anywhere except in fields, menus and dialogs | Open or close the Radar panel (section 10) |
| Esc | Radar panel | Close it |
| Esc | Any dialog | Close it |
| Ctrl/⌘ + R | Desktop app | Refresh |
| Ctrl/⌘ + , | Desktop app | Open About (settings) |
| Ctrl/⌘ + E | Desktop app | Open About to export a backup |

The desktop app also has menus: **File** (Export backup…, Restore backup…), **View** (Refresh scan, Full screen), **Help** (Contact developer…, About) and **Settings…** (under **Tools** on Windows and Linux, in the app menu on macOS). The backup and settings items open About, where those actions live.

## 20. Troubleshooting
| Problem | What to do |
|---|---|
| Rows show **NO DATA** | The asset has too little history, a stock split was detected, or its feed failed. Try a longer timeframe or wait for the next scan. |
| Many rows dropped as **stale** | The exchange returned old candles. Wait a few minutes or try another source. |
| **Rate-limited** | Wait for the time shown; only that source is paused. Use a longer timeframe or fewer assets (Top N). |
| **Blocked or unreachable** on the web | Try the installed app or another source. If you host the web files yourself, Coins.ph needs the rewrite rules from the official build. |
| Coins.ph **Refresh** takes a minute | Expected: the app waits to stay under Coins.ph's request limit. |
| The **Quote** menu is greyed out | Coins.ph has only peso pairs. On other sources it lists what the exchange offers after the first scan. |
| Few rows in a USDC or FDUSD scan | Those books list fewer coins than USDT; try **Best USD stablecoin**. |
| Prices stay in USD after choosing a currency | The rate service could not be reached and no rate is saved for that currency: the rate line says *No rate for … yet*. Check the connection; the Gulf pegs always work. |
| Rate line says **rates are more than 3 days old** | The device has been offline or the rate services were down; press **Update now** in **⇄ Rate sources**. |
| **Could not reach …** in Rate sources | The source you chose is down or blocked on your network; the last rates it gave are kept. Choose **Automatic** or another source. |
| A custom rates file is refused | It holds no rates the app can read; save the source's JSON (not its web page) and import that. |
| **Load 5K older** says the row is from an earlier scan | You changed source or timeframe; wait for the new scan, then reopen the asset. |
| A paper proposal says the account is in US dollars | Peso, won, BTC-market and euro pairs cannot be booked in the US-dollar paper account; scan a dollar-stablecoin quote (or Coinbase USD). |
| Rows say **updating · …** | They are shown from the history on this device while the scan refreshes them (section 4); they are display only until then. |
| A row says **not updated · …** | Its fetch failed this scan; it shows saved history, display only. The next scan tries again. |
| *n thin pairs … are not scored* | The liquidity floor left those crypto pairs out; lower or turn off **Liquidity floor** in the scoring-profile panel (section 9). |
| **Reset drawdown lock** is greyed out | Lock closes are still waiting: scan the source and timeframe the button names (each pair is listed) so they fill, then type `RESET`. A pair below the liquidity floor still gets its bars; if *Bars could not be loaded* names it, wait for the next scan. |
| Saving says *risk can't be loosened until the next UTC day* | A lock is active: limits cannot be loosened until the next UTC day after it clears (section 12). |
| Ledger says **Not proven yet** | Normal for months, and for a small edge often years rather than weeks (see the power readout in the ledger). Keep scanning and export the ledger weekly. |
| A paper proposal cannot be approved | Read the reason under it (lock, cluster limit, open-risk cap, stale signal…). Engaged kill switch: reset it with `RESET`. |
| A Radar section says **Unavailable — last value …** | That source could not be reached or is pausing the app (a rate limit). The last good value and its time stay on screen, marked in amber, and the section heading says so too: for Regional demand each premium keeps its own last value and time, so one failed source does not hide the other two. Break-away alerts from data older than the last good refresh are marked the same way and are removed after 2 hours without fresh data, and a stablecoin alert older than 2 hours is not shown. The other sections still refresh. It retries on the next 5-minute refresh (the CFTC report and the daily inputs wait longer, by design). |
| The Radar tab does nothing when I press **R** | **R** is ignored while you type, while a menu or another dialog is open, and with Ctrl, Alt or ⌘ held. Close the dialog or click the page first. |
| **This backup could not be opened** | The passphrase is wrong (it is case-sensitive and must be exactly what you typed when backing up) or the file was changed. Nothing was restored. If you chose a file from a newer version you will see *This is not a Confluence Terminal backup, or it was made by a newer version.* instead. A forgotten passphrase cannot be recovered. |
| Settings disappeared (browser) | The browser cleared its storage. Restore your last backup from About. |
| The page from the zip shows nothing | Use the included launcher; opening `index.html` directly does not work. |

## 21. Glossary
| Term | Meaning |
|---|---|
| **Closed bar** | A finished candle. Signals use only closed bars. |
| **Confluence** | Several independent indicators agreeing. |
| **Bloc** | A family of indicators: trend, mean reversion, breakout, flow. |
| **Efficiency ratio** | How straight the price path was over 40 bars (0 = choppy, 1 = straight). |
| **bp** | Basis point: 0.01%. |
| **Hit rate / base rate** | How often signals were right, against how often the market moved that way anyway. |
| **Edge** | Average result above the base rate, after costs. |
| **Rank IC** | Whether higher scores went with bigger later moves across assets. |
| **Sharpe (probabilistic, deflated)** | Return per unit of risk, and how likely it is not luck. |
| **R** | Profit or loss as a multiple of the amount risked on the trade. |
| **ATR** | Average true range: a measure of how much price usually moves per bar. |
| **PH premium** | Peso price against the global price for the same coin. |
| **Perpetual** | A futures contract without an expiry date. |
| **Funding** | The periodic payment between long and short holders of a perpetual. |
| **Stablecoin** | A token meant to hold a fixed value, usually $1 (USDT, USDC, FDUSD …) or €1 (EURI). |
| **Quote currency** | What a pair is priced in: BTCUSDC is bitcoin priced in USDC. |
| **Depeg** | A stablecoin trading away from its fixed value. |
| **Peg** | A currency held at a fixed rate by its central bank (SAR 3.75 per USD). |
| **Drawdown** | How far equity has fallen from its highest mark, in %. |
| **Analogue** | An earlier moment in the same asset's history that looked like now (Pattern). |
| **Wilson lower bound** | A cautious low estimate of a hit rate from a small sample (95% level). |
| **MAE / MFE** | Maximum adverse / favourable excursion: how far a trade went against / for you, in R. |
| **Open interest** | The total size of open futures contracts; a rise means new positions are being opened. |
| **Long/short ratio** | Accounts that are long divided by accounts that are short, on a perpetual. |
| **Taker** | The side that trades against a resting order; taker-buy share is the part of volume bought that way. |
| **Basis** | A perpetual's mark price against its index price, in %. |
| **COT** | The CFTC's weekly Commitments of Traders report: futures positions by trader group, as of Tuesday. |
| **Break-away** | One exchange's price standing well apart from the median of the others. |
| **Reference rate** | An official or central-bank mid rate published for information; not a rate you can trade at. |

## 22. Help
✉ in the header writes to rslozano@gmail.com with the app name as the subject. Include the version, build and source commit from **About** with any question.

---
Powered by rsL Confluence Terminal · 2.7.0 · build 20261111 — Created by rsLozano
