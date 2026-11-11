<!-- wp:WP11 --> <!-- wp:WP16 -->
# rsL Confluence Terminal v2.7 2026 — User guide

The rsL Confluence Terminal is a multi-indicator market scanner. For every asset it runs 18 indicator votes on **closed bars**, combines them into a score from −100 to +100, and shows a **Master Signal**. It also records every signal so you can measure, over weeks, whether the signals would have helped you.

> **Important.** The Terminal is an analysis tool, not financial advice. It reads public market prices only and never places an order on any exchange. Paper trading is simulated.

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
| **Android 10+** | Install the release `.apk`. Allow "install unknown apps" for your file manager once. |
| **iPhone / iPad** | Install the release `.ipa` with Sideloadly. Or open the web version and choose *Share → Add to Home Screen*. |
| **Web / PWA** | Open the published web app (effervescent-bubblegum-1e5c03.netlify.app) and choose *Install app* (Chrome/Edge) or *Add to Home Screen* (phones). To run it on one computer only, install Node.js LTS once (nodejs.org), unzip the `-pwa.zip` from the web release, start **`Start-Confluence-Terminal.cmd`** (macOS/Linux: `start-confluence-terminal.sh`) and keep its window open. It serves the app on `http://127.0.0.1:8770/`. Opening `index.html` directly does **not** work. |

**Check a download.** Every release file has a matching `.sha256` file. Compare them before installing:
- Windows (PowerShell): `Get-FileHash <file> -Algorithm SHA256`
- Mac and Linux: `shasum -a 256 <file>`

<!-- wp:WP8 -->
## 2. Official builds
- Every release is built by the project's GitHub Actions only, one release per platform: Windows, macOS, Linux, Android, iPhone and web (the web release also carries the app's software bill of materials, `.cdx.json`). **About** shows the version, build number and source commit, and says that market data belongs to each exchange; compare the commit with the release page if you want to be sure you have an official build.
- From v2.6 the app's own code is shipped in a protected (minified and obfuscated) form without source maps, on every platform. This discourages copying and casual tampering. It does not hide your data or add secrets — the app holds no passwords or keys at all.
- Android only installs an update signed with the same key as the app you have, so a look-alike APK cannot replace it or read its data.

## 3. First start
The first time you open the Terminal, a short three-step setup appears. **Skip** ends the setup and keeps the defaults. You can change the workspace and your name later in **About → Edit identity**, and the language at any time from the **Language** menu.

![Step 1: choose one of 18 languages. Each language shows its review status.](images/first-start-language.webp)

1. **Language.** Pick from 18 languages. English and Arabic are *approved*. A language marked *certified* was checked by a named native-speaker reviewer; *machine-checked* means automated checks only.
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
| Theme | System, Light or Dark. |
| **Refresh** | Scan now. |

### The summary strip
Under the header: number of assets scanned, the share that are **Bull**, **Bear** and **Neutral**, reversal counts (**Rev ↑/↓**), your workspace, the source, how long the scan took, errors, when it was updated, and **bar** — the time of the closed bar the signals were computed on. Signals never use the candle that is still forming.

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

### Notes and banners
- **Rate line** (v2.7, grey): shown when prices are not in US dollars — for example *Prices in SAR · 1 USD = 3.75 SAR · official peg (SAMA) · Frankfurter central-bank rates · as of 2026-11-11 · stablecoins at 1 USDT = 1 USD (USDT now $0.9987)*. An amber **rates are more than 3 days old** tag appears when the device could not refresh them.
- **Depeg banner** (v2.7, amber or red): the stablecoin you scan in has moved away from $1 on this exchange — **Watch** at 0.5 %, **Warning** at 1 %, **Severe** at 2 %. Information only; signals are unchanged. A short spike on one exchange is possible (USDe touched $0.65 on one exchange for about 40 minutes in October 2025), so compare with another source before acting.
- **Storage and backup banner** (yellow): the browser version may lose data when the device runs low on space. The banner also appears when you have never exported a backup or the last one is 7 or more days old; its **Export backup** button saves one straight away. If the device blocks storage completely, a notice says settings are kept only until you close the app.
- **Error banner**: a scan failed. **Retry** scans again; **Use Bybit** switches the source when Binance cannot be reached.
- **Macro banner**: shown 24 hours before and 2 hours after a scheduled FOMC decision, US CPI, US jobs report or ECB decision. Signals around those releases are less reliable. The built-in calendar lists US CPI and jobs-report dates up to December 2026.
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

### Reversal
The Reversal column looks for a turn **against** the current trend (the trend is judged from the 50-bar average and its slope). It checks nine clues: RSI divergence, MACD momentum loss, a return inside the Bollinger bands, a Stochastic cross, a Parabolic SAR flip, a Supertrend flip, RSI leaving overbought or oversold, an engulfing candle, and a hammer or shooting star. Three or more net clues are **HIGH**, two **MOD**, one **LOW**. Point at the badge to see which clues fired.

### Pattern
The Pattern column is not a chart-shape detector. It looks back through the same asset's history for moments that looked like now (score, reversal and trend over the last four bars) and counts how often price rose over the next six bars.
- **↑ 75% · MOD** means similar moments rose 75% of the time, with moderate confidence.
- **N mixed** means it found N similar moments, but too few (under five) or without a clear edge over the asset's normal behaviour.
- **—** means it found no similar moments.

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

![Analysis sections: trend and reversal, historical pattern, bloc scores and context.](images/detail-analysis.webp)

- **Trend & reversal**: the current trend and any reversal clues.
- **Historical pattern signal**: the analogues behind the Pattern column — how many, how often they moved in the signal's direction, the average 6-bar move and how similar they were.
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

- **Fair-value gaps**: price gaps left by fast moves. A gap that agrees with the signal raises the shown confidence slightly; an opposing gap lowers it (×0.85 to ×1.15). Gaps never change the score or the signal.
- **Key levels (20-bar)**: pivot, two resistance levels (R1, R2) and two support levels (S1, S2), each marked above or below price, in the display currency.

![The indicator panel lists every vote with its value.](images/detail-indicators.webp)

- **Indicator panel · n voting** (n = the votes that could be calculated): every indicator with its value and vote, grouped by Trend, Momentum, Volatility, Volume and Structure, plus warnings — for example when the blocs disagree.

### Chart replay
**Open chart replay** steps through the saved history one bar at a time. Use **Play replay** / **Pause replay**, **Next bar** and **Speed** (1×, 2×, 4×). The replay chart zooms and goes full screen like the main chart. To practise, choose side (long or short), size, stop % and target %, then **Queue replay trade**; it fills at the next bar's open. When a bar touches both the stop and the target, the stop counts first.

![Chart replay with a practice trade.](images/chart-replay.webp)

### Derivatives and order flow (Bybit Perpetual)
On **Bybit Perpetual** the sheet adds two research panels:
- **Order flow**: **Capture order flow** takes a snapshot of the order book (15 levels per side) and recent trades. Up to 60 captures are kept while the sheet is open; step through them with Previous/Next. After two or more captures a **depth heatmap** appears (green bids, pink asks, brighter means more size, dots mark liquidations). You can also import a recorded depth file (JSONL, up to 8 MB).
- **Derivatives**: funding rate, open interest and its change, from a recorder file you import (JSONL, up to 10 MB). Data older than two hours is marked stale.

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

All sources are public price data only. The app never signs in to an exchange to scan. The Quote menu shows only the stablecoins the exchange lists at that moment, so a delisted stablecoin disappears from it by itself.

![The data source menu.](images/source-menu.webp)

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
- **Web version:** the published web app and the local launcher reach Coins.ph through their own address. If you put the web files on another host, Coins.ph may show **Blocked or unreachable**; the installed apps are not affected.
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

| Source | Fee per side | Slippage per side | Funding per 8 h |
|---|---|---|---|
| Binance Spot, Bybit Spot, Bitget Spot | 10 bp | 5 bp | 0 |
| Bybit Perpetual | 5.5 bp | 5 bp | 1 bp |
| Bitget Perpetual | 6 bp | 5 bp | 1 bp |
| Coins.ph (PH) | 30 bp | 15 bp | 0 |

Other stablecoin quotes on the same exchange use the same costs. RWA and stocks add 10 bp slippage, commodities 5 bp, currencies 3 bp.

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

**Pre-registration.** Choose a horizon and press **Pre-register h = N**. The hypothesis is then fixed and the verdict can be read only after at least 90 days, using signals recorded after that moment. This prevents choosing the best-looking horizon after the fact.

### Keep the ledger safe
- **Export CSV** or **Export JSON** at least weekly; the dialog reminds you. An export holds the current source, timeframe and asset class only, so export each one you use.
- **Import ledger** restores a JSON export (or a recorder file). CSV cannot be imported, and Coins.ph rows are not accepted.
- In the browser version, press **Keep storage** to ask the browser not to delete the ledger when space is low.
- **Clear ledger** deletes every recorded signal for **all** sources and timeframes, for good, after a confirmation.

## 12. Paper trading
Paper trading practises the discipline the ledger asks for. Strong signals become **proposals**, a risk engine checks each one, and only you can approve. No order is ever sent to any exchange.

![Paper trading: account, locks and proposals.](images/paper.webp)

### How it works
1. Every **STRONG** BUY or SELL in the current scan becomes a proposal: long for BUY, short for SELL, with size, stop and target worked out from the risk settings and the 14-bar ATR.
2. The risk check runs straight away. A proposal that passes says *Risk check passed*; one that fails says what blocked it.
3. **Approve** or **Reject**. A proposal expires when the next bar closes, and each one can be decided only once.
4. An approved trade fills at the **next bar's open** (never at the signal price). Stop and target are re-anchored to the fill. If a bar touches both, the stop counts first; a gap through the stop exits at the open.
5. **Close at next open** exits manually; **Cancel** withdraws an order that has not filled yet.

**Currency (v2.7).** The paper account is kept in USDT, so only pairs quoted in a dollar stablecoin (USDT, USDC, FDUSD …) can be proposed; peso (Coins.ph) and euro pairs are refused with a reason. One position per coin: BTCUSDT and BTCUSDC count as the same exposure.

### Locks
- **Daily and weekly loss locks** block new approvals after the set loss.
- **Kill switch** blocks every new approval until you reset it (type `RESET`). It does not close open positions.
- **Dead-man switch**: if no scan has run for the set number of bars, approvals stop and open positions are marked unmanaged. Keep the app scanning while you hold paper positions.

### Journal
Closed trades are listed with costs, P&L and exit reason, plus trades, win rate, average win/loss in R, expectancy, net P&L and maximum drawdown. **Export CSV** saves the journal. **Replay trade** replays a closed trade on its saved candles, and **Annotate** adds tags and notes. The journal counts reconciled trades towards **50**, the number needed before anything beyond paper is even considered.

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
| Max total notional (× equity) | 1 | 0.1–10 |
| Allow shorts on spot | off | on/off |
| Require a fresh signal | on | on/off |

A *cluster* is a group of related assets: BTC and ETH (on any quote), other crypto, and each other asset class. **Save settings** applies them; **Revert** undoes unsaved changes. Starting equity can be changed only while no trade is open or recorded, and there is no button to reset the paper account.

## 13. Private API (read-only)
![Private API setup through the local gateway.](images/private-api.webp)

**API** lets you check a **read-only** Binance, Bybit or Bitget key, for example to confirm its permissions. Scanning never needs it.
1. On the computer, start the local gateway: `npm run gateway` in the gateway folder (or `pnpm gateway` from the project folder). It listens only on `127.0.0.1:8787` and prints a **gateway token**, which changes on every restart.
2. In **API**, choose the exchange and environment (testnet or mainnet), paste the token, your API key and secret (and the passphrase for Bitget), then **Test and connect**.
3. The dialog shows the key's label, a masked key and whether it is **Read only**, **Trading enabled** or **Permission unknown**.

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
- **Backup.** **About → Export backup** saves `ConfluenceTerminal_<CODE>_backup_<date>.rslbak`. It contains your identity, preferences (including the quote per source and the display currency), saved scans, watchlists, the alert inbox, the scoring profile and the audit trail. It does **not** contain the signal ledger (export it from the Ledger) or the paper account. From Paper you can export the journal as CSV, but the account, open positions and risk settings cannot be exported or restored. Back up weekly.
- **Restore.** **Restore backup** checks the file (format, checksum, app and version) before it replaces anything, then reloads.
- **Audit trail.** A tamper-evident log of important actions: app start, settings changes, identity changes, backups, ledger exports and imports, and every paper-trading decision. About shows *intact (n entries)*, or *BROKEN at #k* if an entry was altered.
- **Identity.** **Edit identity** changes the workspace, logo and your name; **Export identity (JSON)** saves it.
- **Privacy.** The app only reads public data: market prices (Binance, Bybit, Bitget, Coins.ph — on the web, Coins.ph is reached through the app's own address), the public update file, and — only when a price needs converting, every 6 hours or on **Update now** — exchange rates from the source you chose: `api.frankfurter.dev` (Automatic falls back to `cdn.jsdelivr.net` / `latest.currency-api.pages.dev`), or `data-api.ecb.europa.eu`, `open.er-api.com` or `www.floatrates.com` when you pick them. A custom source is never contacted; you import its file. Nothing about you is sent. No tracking.
- Market data belongs to each exchange and is shown for personal use. Exchange rates are reference rates for information, not rates you can trade at.

## 17. Updates
When a newer version is published, a line appears above the footer with the new version; on Android it also shows the download size and SHA-256 fingerprint. On the web, choose **Reload to update**. On Android, choose **Download update**: the system browser downloads the signed APK, and installing it keeps your data. On iPhone, install the new build with Sideloadly. On desktop, install the new installer. **Later** hides the notice until the next version. Under **About → Updates** you can switch automatic checks off, check now, and see the last result. The check runs when the app opens, when it comes back online, and every 6 hours. It only reads one public file (`/updates/latest.json`); nothing is sent.

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
| Esc | Chart full screen | Leave full screen (the sheet stays open) |
| Ctrl/⌘ + wheel | Chart | Zoom at the cursor |
| ↑ ↓ Enter Esc | Language menu | Choose a language |
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
| A paper proposal says the account is in USDT | Peso and euro pairs cannot be booked in the USDT paper account; scan a dollar-stablecoin quote. |
| Ledger says **Not proven yet** | Normal for weeks or months. Keep scanning and export the ledger weekly. |
| A paper proposal cannot be approved | Read the reason under it (lock, cluster limit, open-risk cap, stale signal…). Engaged kill switch: reset it with `RESET`. |
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
| **Reference rate** | An official or central-bank mid rate published for information; not a rate you can trade at. |

## 22. Help
✉ in the header writes to rslozano@gmail.com with the app name as the subject. Include the version, build and source commit from **About** with any question.

---
Powered by rsL Confluence Terminal · v2.7 2026 · build 20261111 — Created by rsLozano
