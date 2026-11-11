# ADR-0013 — Philippine exchange source: Coins.ph (public market data only)

**Status:** Accepted · 7 Nov 2026 (v2.6 plan, WP7). Probe PH-1 recorded; fetch path chosen below.

## Context
The owner asked to add Philippine centralized exchanges by pulling their APIs automatically. The app is read-only and
credential-free (ADR-0003, ADR-0004). Research (`docs/research/Philippine exchange API integration.md`) found:
- Coins.ph publishes a keyless market-data API at `https://api.pro.coins.ph` (Binance-style klines, tickers, depth,
  exchangeInfo); limit 120/min per IP since 16 Mar 2026 (requests or weight: unconfirmed); CORS not documented.
- No keyless market data was found for PDAX, GCash GCrypto, Maya, GoTyme or UnionBank (PDAX's REST reference could
  not be opened; checked by hand in WP7.0).
- Peso books are thin; ~89 % of Coins.ph volume is USDT/PHP and USDC/PHP.

## Decision
1. Add source `coinsph` ("Coins.ph (PH)") for public market data only: `/openapi/v1/time`, `/openapi/v1/exchangeInfo`
   and `/openapi/quote/v1/*` (the same list in ADR-0003, `public-hosts.ts`, the Tauri scope and the rewrite rules). No other path, no key, no signature, no 🔑
   profile (release checks R16, R20).
2. Fetch path — **to be filled from the probe:**
   - CORS allowed → direct fetch on all platforms; `https://api.pro.coins.ph` joins `connect-src` (ADR-0003 amendment).
   - CORS refused → web: Netlify rewrite of the read paths under `/x/coinsph/` (same origin; `public/_redirects`, and
     the same proxy in the local PWA launcher); Android/iPhone/desktop:
     `nativeGet()` in `packages/adapters` (explicit `CapacitorHttp.request`, Tauri `plugin-http` with a path-scoped
     capability). The global CapacitorHttp switch stays off.
   - **Chosen: rewrite + native** (CORS refused). Evidence: `docs/research/evidence/coinsph-probe-2026-11-07.json`.
3. Budget 100 weight/min, ≥ 600 ms spacing, top-N ≤ 40, auto-refresh ≥ 5 min; 429/418 stop **this source only**
   (per-source cooldown, new code) until the full `Retry-After`.
4. Only PHP-quoted pairs are scanned. USDT/PHP and USDC/PHP are classified Currency (FX). Peso pairs under $250 k/day
   (USD-equivalent) are not scanned; the app counts them in a note. The PH premium is logged and displayed, never voted.
5. Not integrated: PDAX, GCash, Maya, GoTyme, UnionBank. Revisit when one publishes keyless market data.

## Consequences
- One more host (or Netlify rule) to keep in step with ADR-0003, the Tauri scope and `src/lib/public-hosts.ts` (R16).
- On the rewrite path requests leave from Netlify's shared edge IPs, also used by other Netlify sites, so a Coins.ph
  429/418 can hit this app without the user causing it. On other static hosts the rewrite is absent and the web
  source shows "Blocked or unreachable".
- Coins.ph API terms of use and fee schedule are not yet reviewed [unverified]; the ledger fee for this source stays
  configurable and conservative until they are.
