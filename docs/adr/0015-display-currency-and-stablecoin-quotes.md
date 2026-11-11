# ADR-0015 — Display currency from honest reference rates; stablecoin quote pairing

**Status:** Accepted · 11 Nov 2026 (v2.7, plan `docs/superpowers/specs/2026-11-11-v2.7-architecture-design.md` WP12–WP13)
**Deciders:** rsLozano (owner)

## Context
The owner asked for (a) exchange stablecoin pairing and (b) any global fiat currency, converted automatically at a "global and
honest" exchange rate. The app is keyless, has no backend, and its strongest property is that it is read-only. Scores, the
ledger and paper trading must stay reproducible: converting history at today's rate would distort past bars.

## Decision
1. **Display only.** Prices and volumes are converted when they are formatted. Engine, scan pipeline, ledger, paper book,
   alerts, recorder and MCP keep each scan's native currency (USD ≈ USDT, EUR for EUR stablecoins, PHP on Coins.ph).
   Release check R21 enforces the boundary.
2. **Rate source order:** Frankfurter v2 (`/v2/rates?base=USD`, central-bank blend with per-currency providers, pegs exact,
   161 fiat currencies, MIT) → fawazahmed0 currency-api via jsDelivr → its `currency-api.pages.dev` mirror (labelled
   "community rates, method not published") → built-in official pegs (SAR, AED, QAR, OMR, BHD, JOD). One source per refresh,
   at most every 6 hours, cached on the device; > 3 days old is labelled stale.
3. **Honesty labels:** the info line names the rate, its kind (official peg + authority, HKD band, "official rate" for
   currencies with parallel markets, otherwise reference rate), the source and the date. Stablecoin prices are shown at
   **1 USDT = 1 USD**, with USDT's own USD price beside it; we do not multiply prices by a stablecoin market price.
4. **Automatic currency** = the device region's currency (from `navigator.languages`), never from the network or IP.
5. **Stablecoin quotes:** per source, USDT (default, identical to v2.6), any listed stablecoin, or *Best USD stablecoin* (the
   deepest USD-pegged pair per coin, 25 % hysteresis). One real pair's candles per coin — never blended. Volumes are valued
   at the quote's own price on the same venue. Depeg readings (≥ 0.5 / 1 / 2 %) are information only.
6. **User choice of source (owner request 11 Nov 2026).** *Automatic* (above) or one of five tested sources —
   Frankfurter, European Central Bank, ExchangeRate-API open access (attribution shown), fawazahmed0, FloatRates —
   each described in the app with publisher, method, coverage, cadence, terms, website and the exact data address.
   A chosen source is never silently replaced. **Update now** and a 6-hour automatic update (switchable).
7. **Custom (untested) source = imported file, never fetched.** The user names the source, opens it in the browser,
   saves its rates file and imports it; it is labelled *not tested*, and adding it to the list needs a written request
   to the developer (pre-filled e-mail). Fetching arbitrary addresses would require `connect-src *` (or a proxy), which
   would remove the app's strongest security property; rejected for the same reason as credential storage in Build 1.8.
8. **Paper trading** stays in USDT and refuses pairs not quoted in a USD stablecoin (fixes the v2.6 peso/USDT mix).

## Options considered
| Option | Verdict |
|---|---|
| ECB reference rates directly | Official but 29 currencies (no SAR, AED, PHP is present), XML without CORS → rejected as primary |
| Frankfurter v2 | Central-bank blend with providers, 161 fiat, CORS, keyless → **primary** |
| open.er-api.com | Keyless, CORS, but attribution on every page and no redistribution; blend method undisclosed → not used |
| fawazahmed0 | Keyless, CORS, 340 codes, provenance unpublished → **fallback, labelled** |
| Stablecoin-implied rates (e.g. USDT/PHP) | Market price, not a reference rate → shown as information (Coins.ph USDT premium), never used to convert |
| Convert candles before scoring | Distorts history, changes engine inputs → rejected |
| ECB direct (SDMX JSON, CORS) | Official, ~30 currencies → **user-selectable alternative** |
| open.er-api.com | Attribution shown in the app → **user-selectable alternative** |
| FloatRates | No published method, SAR off the peg → **user-selectable alternative, labelled** |
| Fetch a user-typed URL | Needs `connect-src *` → rejected; custom sources are imported files |

## Consequences
- Three new `connect-src` hosts (ADR-0003 amendment v2.7); R8 now reads one host table.
- A peso volume shown in PHP is USD volume (valued at Coins.ph's USDT/PHP) converted back at the reference rate, so it can
  differ slightly from Coins.ph's own peso figure; the guide says so.
- Revisit when: Frankfurter changes its terms or API, a central bank publishes a CORS-enabled feed for a currency the owner
  uses, or the owner wants the ledger in another currency (would need rates fixed per bar).
