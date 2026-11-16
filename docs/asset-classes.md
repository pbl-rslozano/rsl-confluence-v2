# Asset classes — crypto, RWA, stocks, currencies, commodities (2.3.0)

The selector in the header (Crypto · RWA · Stocks (tokenised) · Currencies (FX) · Commodities · All classes) works on the **three exchanges the app already uses** — no new network host, no API key.

## How symbols are classified
1. **Venue type first** — Bybit V5 `GET /v5/market/instruments-info` (`category=linear` / `spot`, paginated, cached 6 h) returns `symbolType`: `stock`, `ETF`, `commodity`, `forex` on perps (added Mar–Apr 2026; FX perps launched 8 Sep 2026), `xstocks` on spot; empty or `innovation` = crypto.
2. **Patterns and curated lists** when no venue type is available: Binance spot bStocks (`TSLABUSDT`, `NVDABUSDT`…), Ondo tokens (`AAPLONUSDT`…), xStocks (`AAPLXUSDT`…), fiat stablecoins (`EURUSDT`, `EURIUSDT`, `AEURUSDT`…), tokenised gold (`PAXGUSDT`, `XAUTUSDT`), RWA-sector tokens (`ONDOUSDT`, `SYRUPUSDT`, `PLUMEUSDT`…).
3. Everything else is crypto. Leveraged tokens and USD-pegged stablecoins are never scanned.

**Fix included:** before v2.2, Bybit perpetual scans ranked stock and commodity perps (TSLAUSDT, COINUSDT, XAUUSDT…) as "crypto" because their names look like tokens; and the old leveraged-token filter dropped real tokens ending in "…UP" (JUPUSDT, SYRUPUSDT).

## What each venue offers (as documented, Oct 2026)
| Venue (source in app) | Stocks / ETFs | FX | Commodities | RWA |
|---|---|---|---|---|
| Bybit Perpetual | ~stock & ETF perps (TSLA, NVDA, AAPL, SPY, QQQ…) | EURUSD, GBPUSD, USDJPY perps | XAU, XAG, WTI (CL), Brent (BZ) | — |
| Bybit Spot | xStocks (AAPLX, TSLAX, SPYX…) — thin | EUR stablecoins | PAXG, XAUT | ONDO, RWA tokens |
| Binance Spot | bStocks (TSLAB, NVDAB, SPYB…) | EURUSDT, EURIUSDT | PAXG | ONDO… |
| Bitget Spot | Ondo "…ON" tokens | EUR stablecoins | PAXG, XAUT | RWA tokens |

Symbol lists change; the venue type (Bybit) is authoritative. **NOT VERIFIED here:** the build environment could not reach the exchanges, so live instrument lists were not pulled; the research notes list the exact calls.

## Engine and display rules
- **FX profile**: the low-volatility cap is off (FX volatility sits far below crypto's, so the cap would fire on almost every bar).
- **Volume**: detected per series; series without real volume (most tokenised assets off-hours) have volume indicators excluded instead of voting on zeros.
- **Market sessions**: US equities 09:30–16:00 New York; FX Sunday 17:00 → Friday 17:00 New York; US daylight-saving switch handled (2026: 8 Mar → 1 Nov). Bars printed while the underlying was shut carry an **"underlying closed"** badge (also stored on ledger rows as `underlying_closed`), and the Stocks/FX views show a note: tokens keep trading 24/7 on a synthetic price within the venue's band. **NYSE holidays and 13:00 ET early closes for 2026–2028** are built in (NYSE Group release, 23 Dec 2025). v2.3: FX closes on 25 Dec and 1 Jan; CME metals/energy close on Good Friday, 25 Dec and 1 Jan and halt at 13:30 ET on the other US exchange holidays (simplified, **NOT VERIFIED** against the CME holiday notices).
- **Regular-session bars (v2.3)**: tokenised stocks are scored on the bars of the fixed 1,000-bar window that overlap the NYSE regular session (intraday and daily; weekly/monthly unchanged). On 1 h that leaves ~210 session bars, 4 h ~360, 1 d ~710. Rows record both the raw window (`warm_bars`) and the bars the engine actually saw (`engine_bars`); the window rule uses `engine_bars`, so **stock rows never count as full-window (1,000-bar) rows** — use the ≥ 300-bar view for 4 h / 1 d stocks, and treat them as exploratory.
- **Split guard (v2.3)**: a bar-to-bar move within 2 % of a common split ratio (3:2, 2, 3, 4, 5, 8, 10, 15, 20, 25, 30, 50 or the inverse) in a stock series mutes the signal until it leaves the window (`split_muted`), and **no outcome is measured across it** (a 2:1 split is not a −50 % trade). Genuine ±50 % / +100 % moves are rare on these names; muting them is the conservative choice.
- **Turnover floor (v2.3)**: non-crypto instruments need ≥ $250,000 of 24 h quote volume to be scored.
- **Basis / band-pinned (v2.3)**: perp tickers carry mark and index prices; basis % is logged and a series is flagged band-pinned when |basis| ≥ 1.5 % or the last three bars have no range.
- **Earnings window (v2.3)**: `earnings-calendar.ts` holds a manual list (ships empty — no keyless source with clear terms; never invent dates). A row is flagged (not muted) when its bar closes within 24 h of the report **day** (the UTC calendar day ± 24 h, i.e. up to 36 h from noon).
- **Per-class costs (v2.3)**: see docs/measurement.md.
- **Macro events**: a banner warns 24 h before (and 2 h after) FOMC decisions, US CPI and jobs reports, and ECB decisions (dates from the Federal Reserve, BLS and ECB; FOMC 2027 tentative; BLS published only to Dec 2026).
- Every ledger row carries its asset class, so performance can be measured per class.

## Deferred (designed, not built)
- ~~Bitget perpetuals~~ — **built in v2.3** as source `bitget-perp` (`/api/v2/mix/market/tickers|candles|history-candles|merge-depth`, `productType=USDT-FUTURES`). Field names follow Bitget's v2 documentation and are **NOT VERIFIED** against live responses (no exchange access in this build environment); instrument types are inferred from symbol patterns.
- **Binance futures** (`fapi.binance.com`) — new host; only for Binance's own gold/stock/FX perps.
- **Real stock / FX data**: no keyless, terms-compliant intraday source exists. Options, in order: Frankfurter (ECB daily reference rates, keyless, new host); a user-supplied Twelve Data key held by the local gateway (8 calls/min free). Yahoo and Stooq are excluded (terms / key).
- Per-class volatility bands measured on each symbol's own in-session history; dividend adjustments (splits are guarded, dividends are not).
- **Weekend check (do first)**: on a Saturday, fetch 1 h bars for TSLAUSDT, EURUSDUSDT, XAUUSDT on Bybit and record whether bars are missing, flat or drifting.

## Availability (facts, not legal advice)
Bybit's restricted-country list (updated 16 Oct 2026) does not name Saudi Arabia; product-level eligibility for tokenised stocks and TradFi perps is set per product and was not confirmed. A read-only scanner of public market data needs no account. Confirm eligibility and Saudi regulatory status yourself before trading these products.
