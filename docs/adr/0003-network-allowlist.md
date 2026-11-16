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

- No telemetry, analytics, fonts or CDN code; all libraries and fonts are vendored. (v2.8 wording, licence audit: since
  v2.7 one JSON rates file may be read from `cdn.jsdelivr.net` — the fawazahmed0 fallback, ADR-0015 — as data, parsed and
  validated, never executed.)
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

## Amendment — v2.8 (15 Nov 2026, licence audit WP20)
- **App: no new host.** `tools/egress-manifest.json` `web.hosts` now lists every `CSP_HOSTS` host (the six display-currency
  rate hosts of v2.7 were in `web.csp` only); `tools/check-egress.test.mjs` fails when a table host is missing (R11).
- **Gateway (existing behaviour, now listed):** the optional local gateway (`apps/confluence/gateway`, process `gateway` in the
  egress manifest, R11) calls an exchange's account endpoint only when the user connects an API key and asks it to check the
  key's permissions: `api.binance.com`, `testnet.binance.vision`, `api.bybit.com`, `api-testnet.bybit.com`, `api.bitget.com`.
  It listens on loopback, never runs inside the app, and refuses keys that can trade or withdraw (ADR-0009, WP19).

## Amendment — v2.8 (15 Nov 2026, WP26: new exchanges)
Evidence: probe EX-PROBE-1, `docs/research/evidence/wp26-venues-probe-2026-11-15.json` (cross-origin `fetch()` from a
Chromium page, 15 Nov 2026). All three venues are public market data only: GET, no key, no credentials, no account and no
order endpoint (paper trading only; release checks R12 and R20).
- **App, `connect-src` (+2):** `https://www.okx.com` (OKX spot and perpetual: tickers, instruments, candles,
  history-candles, books) and `https://api.exchange.coinbase.com` (Coinbase Exchange: products, stats, candles). Both
  answered every cross-origin request in the probe (`cors: ALLOWED`), so they are fetched directly; they are in `CSP_HOSTS`
  (`apps/confluence/web/src/lib/public-hosts.ts`), the desktop CSP and `tools/egress-manifest.json` `web.hosts` (R8, R11).
  The Coinbase Advanced Trade host was refused cross-origin in the probe and is **not** used.
- **App, outside the CSP (+1):** `https://api.upbit.com`. The probe found its CORS **unreliable** (the same paths were
  answered and refused within one minute), so `connect-src` does not list it. It follows the Coins.ph pattern (v2.6
  amendment, ADR-0013) through the generic relay `src/lib/native-relay.ts`: web through the same-origin rewrite
  `/x/upbit/...` (Netlify `public/_redirects`, the local launcher proxy), native shells through `nativeGet()` (Tauri
  `plugin-http` with a path-scoped capability; Capacitor), Node with plain fetch. A browser page never fetches it directly.
- **Read paths only (Upbit):** `/v1/market/all`, `/v1/ticker/all`, `/v1/ticker`, `/v1/orderbook` and `/v1/candles/*`
  (`UPBIT_READ_PATHS`, one `NATIVE_HOSTS` entry). Upbit serves its private account, order, deposit and withdrawal
  endpoints on the same host, so the host is never allowed whole: the relay, the adapters, the rewrites, the launcher and
  the Tauri scope each allow only these paths. Release check **R16** now checks every `NATIVE_HOSTS` entry (Coins.ph and
  Upbit) against the rewrites, the launcher, the Tauri scope, the egress manifest and this ADR.
- **Node processes:** the recorder (`recorder.hosts`) gains `www.okx.com`, `api.exchange.coinbase.com` and
  `api.upbit.com`; the launcher (`launcher.hosts`) gains `api.upbit.com`; `web.nativeHosts` gains `api.upbit.com` (R11, R16).
  The app's server route and the replay CLI use the same three hosts.
- **Not verified in the probe:** rate limits (headers are not exposed cross-origin) and each venue's terms; the venue
  modules record their limits as constants marked `[not verified]` where no source confirms them.

## Amendment — v2.8 (16 Nov 2026, WP25: market radar)
Evidence: probe RD-PROBE-1, `docs/research/evidence/wp25-radar-probe-2026-11-16.json` (built-in browser on the owner's
computer, 16 Nov 2026). All three hosts are public data only: GET, no key, no credentials, no account and no order endpoint
(paper trading only; release checks R12 and R20). The radar contacts them only while its panel is open or while the
recorder's radar option is on; the default build contacts none of them (acceptance BLD-9.4-3a is unchanged).
- **App, `connect-src` (+3):** `https://fapi.binance.com` (Binance USDⓈ-M futures, REST only: `/fapi/v1/premiumIndex`,
  `/fapi/v1/fundingRate`, `/futures/data/openInterestHist`, `/futures/data/globalLongShortAccountRatio`,
  `/futures/data/takerlongshortRatio`; no `wss://`), `https://publicreporting.cftc.gov` (CFTC Commitments of Traders,
  dataset `gpe5-46if`, CORS allowed in the probe) and `https://stablecoins.llama.fi` (DefiLlama stablecoin supply, CORS
  allowed in the probe). They are fetched directly and are in `CSP_HOSTS`
  (`apps/confluence/web/src/lib/public-hosts.ts`), the desktop CSP and `tools/egress-manifest.json` `web.hosts` and
  `web.csp` (R8, R11). A follow-up probe from the deployed app's own origin found all three hosts CORS-allowed
  (`premiumIndex` and `takerlongshortRatio` on fapi.binance.com), so no same-origin rewrite is needed.
- **Rate venue:** Binance futures is the rate venue `binance-fut` (own cooldown and gate, separate from the spot pool); it
  is not a scan source. Documented IP limits (Binance developer documentation, checked 16 Nov 2026): REQUEST_WEIGHT 2400
  per minute (exchangeInfo example; the live value is in `rateLimits`), `/futures/data/*` 1000 requests per 5 minutes,
  `/fapi/v1/fundingRate` 500 per 5 minutes (shared with fundingInfo); `premiumIndex` weight 1 with a symbol,
  `openInterest` weight 1. The gate is 400 requests per 5 minutes, 80 % of the strictest. A 429 or 418 stops the venue
  for the `Retry-After` period (else 60 s, or 600 s for 418).
- **Node processes:** the recorder (`recorder.hosts`) gains `fapi.binance.com`, `publicreporting.cftc.gov`,
  `stablecoins.llama.fi` and `api.pro.coins.ph` (listed for the radar's later regional-premium reads; its read-path restriction is by policy and the R12/R20 static checks, as the recorder's runtime guard is host-level); `web.hosts` and `web.csp` gain the three
  hosts (R8, R11).
- **Not verified:** the live exchangeInfo limit value, the `fundingRate` weight, and the terms of the three hosts.

## Amendment — v2.8 part 2 (web) (16 Nov 2026, WP25: liquidation websockets)
Evidence: probe `docs/research/evidence/wp25-liquidation-ws-probe-2026-11-16.json` (16 Nov 2026, from the deployed app's
own origin `https://effervescent-bubblegum-1e5c03.netlify.app`). Both streams are public market data only: no key, no
credentials, no account and no order endpoint (paper trading only; release checks R12 and R20). The radar opens them
only while its panel is open or the recorder's radar option is on (the runner starts and stops the feed under the same
gate as every radar request); the default build at rest opens no socket (acceptance BLD-9.4-3a is unchanged).
- **App, `connect-src` (+2, websocket):** `wss://fstream.binance.com` and `wss://stream.bybit.com`. They are in
  `CSP_HOSTS` (`apps/confluence/web/src/lib/public-hosts.ts`), the desktop CSP, and `tools/egress-manifest.json` `web.csp`
  (with the scheme) and `web.hosts` (`fstream.binance.com`, `stream.bybit.com`, without it; R8, R11). R8 reads the full
  `wss://` origin here, so both origins are written in full in this amendment.
- **Binance USD-M liquidation stream:** `wss://fstream.binance.com/market/ws/!forceOrder@arr`. Probe: 8 events in 35 s from
  the app origin. The legacy `/ws/` path opened but sent nothing in about 2 minutes, so it is not used. Binance pushes only
  the latest liquidation per symbol per second, so its totals are labelled "sampled" wherever they are shown.
- **Bybit public liquidation stream:** `wss://stream.bybit.com/v5/public/linear`, topics `allLiquidation.BTCUSDT` and
  `allLiquidation.ETHUSDT`. Probe: the socket opened from the app origin, acknowledged the `allLiquidation.*USDT`
  subscribe and pushed events. The feed counts Bybit as connected only after that acknowledgement and sends
  `{"op":"ping"}` every 20 s.
- **Reconnects:** after a close or error the feed waits 2 s, 4 s, 8 s ... up to 60 s (reset after 5 minutes connected).
  `stop()` closes both sockets and cancels every timer and pending reconnect.
- **Recorder (`websocketHosts` +1):** `fstream.binance.com` joins `stream.bybit.com` in the recorder's `websocketHosts`
  (`tools/egress-manifest.json`). Only in continuous mode with `--radar on`; `--once` opens no socket. The recorder opens them
  through a WebSocket constructor that refuses, before connecting, any URL that is not `wss:` or whose host is not listed, and
  its error names only protocol and host. `tools/check-egress.mjs` checks the source; the guard checks at runtime.
- **Not verified:** each venue's terms for the streams and any connection or message rate limit beyond what the probe saw.

## Amendment — v2.8 part 2 (gateway) (16 Nov 2026, WP25: data-provider keys)
Two optional, paid providers are reachable only from the local gateway (`apps/confluence/gateway`, on the user's own
computer, loopback only). Neither is reachable from the web app, the desktop CSP or the recorder, and no web bundle
carries a provider key. Both are on personal-use plans: Whale Alert Alerts API (US$29.95 per month) and CoinGlass
Hobbyist. Both are optional: without a connected provider profile the radar rows say "Available with a key on the
desktop gateway" and the gateway contacts neither host.
- **Gateway `hosts` +1:** `open-api-v4.coinglass.com` (https, header `CG-API-KEY`). Test call at connect:
  `GET https://open-api-v4.coinglass.com/api/bitcoin/etf/list`; the key passes only when the HTTP status is OK and the
  response `code` is `"0"`.
- **Gateway `websocketHosts` +1:** `leviathan.whale-alert.io` (wss, `wss://leviathan.whale-alert.io/ws?api_key=<key>`).
  Test at connect: the gateway opens the socket, sends one `subscribe_alerts` message and waits for the
  `subscribed_alerts` confirmation, then closes the socket. Whale Alert allows at most 2 concurrent connections per key.
- **Keys:** held in the gateway's memory only, as a provider profile kept separate from exchange profiles. They are
  cleared at exit and on a crash (`clearSecrets`). They are never in the web app's storage, the repository, a backup, a
  log line, an error message or a gateway response (only a masked key is returned). The Whale Alert key is part of the
  socket URL, so the gateway replaces every failure with a fixed message that carries no URL, key or upstream text.
- **Manifest and check:** `tools/egress-manifest.json` gateway `roots` gain `provider-auth.mjs` and `provider-data.mjs`,
  `hosts` gains the CoinGlass host and `websocketHosts` gains the Whale Alert host. `tools/check-egress.mjs` checks both
  files' URL literals; both URLs are written in full in the source.
- **Not verified:** the response CoinGlass gives for an invalid key is undocumented, so any non-OK status or any
  `code` other than `"0"` is treated as rejected. No Whale Alert ping or keepalive is documented.
