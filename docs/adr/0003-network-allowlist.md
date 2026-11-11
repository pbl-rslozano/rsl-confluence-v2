# ADR-0003 — Exception to "no network at runtime": market-data allowlist

**Status:** Accepted · 31 Oct 2026

## Context
The rsL rule is offline-first with no runtime network. A market scanner cannot work without live prices, so this app needs a narrow, explicit exception.

## Decision
The only hosts the app may contact (CSP `connect-src`, desktop and web):

| Host | Purpose |
|---|---|
| `https://data-api.binance.vision` | Binance spot public market data (default) |
| `https://api.bybit.com` | Bybit spot/perp public market data and (v2.2) the public instrument list used to classify stocks, ETFs, commodities and FX |
| `https://api.bitget.com` | Bitget public market data (user-selectable) |
| `http://127.0.0.1:8787`, `http://localhost:8787` | Optional localhost gateway for read-only private API profiles (desktop) |
| `'self'`, `ipc:`, `http://ipc.localhost` | App assets and Tauri IPC |

- No telemetry, analytics, fonts or CDN requests; all libraries and fonts are vendored.
- Offline: the UI keeps the last scan and the status line shows **Offline**.
- `tools/release-check.mjs` R8 fails the release if any other host appears.

## Evidence
Acceptance BLD-9.4-3a: only `127.0.0.1:8770` (test server) and `data-api.binance.vision` contacted. BLD-9.4-3b: offline mode keeps rows and shows Offline.

## Amendment — v2.3 (31 Oct 2026)
- **App (CSP unchanged):** the Bitget perpetuals source and the order-book depth sample use the existing hosts only (`api.bitget.com` v2 mix endpoints; `/api/v3/depth`, `/v5/market/orderbook`, Bitget `orderbook`/`merge-depth`). No new host in `connect-src`; R8 unchanged.
- **Node processes** (never the app) are listed per process in `tools/egress-manifest.json` and checked by `tools/check-egress.mjs` (release-check **R11**): the recorder (ADR-0008: the three exchange hosts; Telegram / the user's own webhook only when configured), the MCP server (ADR-0009: **no hosts**), and `tools/fetch-binance-archive.mjs` (`data.binance.vision`, `s3-ap-northeast-1.amazonaws.com` for the archive listing, `data-api.binance.vision` for exchangeInfo).
- Release-check **R12** fails if the paper-trading or MCP code references an order endpoint or imports an exchange client.


The recorder's opt-in full-depth capture command also permits the public
Bybit linear WebSocket at stream.bybit.com. The recorder egress manifest
keeps this WebSocket host separate from its HTTPS allowlist.

## Amendment — v2.5.1 (7 Nov 2026, ADR-0012)
- **App:** `https://effervescent-bubblegum-1e5c03.netlify.app` joins `connect-src` (web meta CSP in `src/lib/csp.ts` and the desktop CSP). Its only use is the update check: a GET of `/updates/latest.json` without credentials, at launch and every 6 hours, which the user can switch off under About → Updates. The PWA reads the same file from its own origin (`'self'`). R8 allows this host and R15 checks it is wired.
- **Publisher (CI only):** `tools/publish-update.mjs` talks to `api.netlify.com` (process `publish` in `tools/egress-manifest.json`, R11). The app never runs it.

## Amendment — v2.6 (7 Nov 2026, ADR-0013)
- **App:** Coins.ph public market data, read paths only (`/openapi/v1/time`, `/openapi/v1/exchangeInfo`,
  `/openapi/quote/v1/*`). Probe PH-1 showed Coins.ph sends no CORS header, so `connect-src` is **unchanged**: the web
  reaches it through a same-origin rewrite (`/x/coinsph/...`; Netlify `public/_redirects`, local launcher proxy) and the
  native shells through `nativeGet()` (explicit CapacitorHttp.get; Tauri `plugin-http` with a path-scoped capability).
- **Single table:** hosts reached outside the CSP and their paths live in `apps/confluence/web/src/lib/public-hosts.ts`;
  the Netlify rules, the launcher proxy, the Tauri http scope and `tools/egress-manifest.json` are checked against it by
  release check **R16**. R8 still polices `connect-src`.
- **Node processes:** the local PWA launcher (`launcher` in the egress manifest) proxies the same read paths; the
  recorder adds `api.pro.coins.ph` only if the owner enables Coins.ph recording (not in v2.6) (R11).

## Amendment — v2.7 (11 Nov 2026, ADR-0015)
- **App:** three display-currency hosts join `connect-src` (web meta CSP and desktop CSP): `https://api.frankfurter.dev`
  (Frankfurter v2 central-bank reference rates — primary), `https://cdn.jsdelivr.net` and
  `https://latest.currency-api.pages.dev` (fawazahmed0 currency-api — fallback, then its mirror). GET only, no credentials, at
  most once every 6 hours and only while a non-USD display currency is chosen; the JSON is parsed and validated, never executed
  (`script-src` unchanged). Rates are display only (release check R21). All three send `Access-Control-Allow-Origin: *`
  (live probe, `docs/research/evidence/fx-quotes-probe-2026-11-11.md`), so no rewrite or native path is needed.
- **One table (review #7):** `connect-src` is now built from `CSP_HOSTS` in `apps/confluence/web/src/lib/public-hosts.ts`.
  R8 reads that table, fails when the desktop CSP lists a host the table does not (or misses one it does), and fails when a
  table host is not named in this ADR. The v2.6 plan claimed R8 already did this; it did not until v2.7.
- **Stablecoin quotes (WP12):** no new host. Venue metadata comes from the existing hosts: Binance `/api/v3/exchangeInfo`,
  Bitget `/api/v2/spot/public/symbols` and `/api/v2/mix/market/{tickers,candles,history-candles,merge-depth}?productType=USDC-FUTURES`,
  Bybit `instruments-info` (already read).
- **User-selectable rate sources (owner request 11 Nov 2026):** `https://data-api.ecb.europa.eu` (ECB reference rates, SDMX
  JSON), `https://open.er-api.com` (ExchangeRate-API open access; the app shows its required attribution) and
  `https://www.floatrates.com` (FloatRates). Each is contacted only while the user has chosen it under **Rate sources**,
  GET only, at most every 6 hours or on **Update now**. All three answered browser requests from another origin in the live
  probe of 11 Nov 2026. A user's own (custom) source is never contacted by the app: its rates file is imported (ADR-0015).
