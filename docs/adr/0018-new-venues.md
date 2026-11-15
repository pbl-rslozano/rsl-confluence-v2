# ADR-0018 — New venues: OKX, Coinbase Exchange and Upbit (public market data only)

**Status:** Accepted for the v2.8 build · 15 Nov 2026 (v2.8 plan WP26, Step 2). **Before release:** the owner reads each
venue's terms (section 5) and click-checks the "View on [exchange]" links (section 6); both are open until recorded here.

## Context
The owner asked for more exchanges as scan sources (spec `docs/superpowers/specs/2026-11-15-v2.8-architecture-design.md`,
WP26). The app reads public prices only and never trades (ADR-0003, ADR-0004, ADR-0010). Before building, the build-time
probe **EX-PROBE-1** (`docs/research/evidence/wp26-venues-probe-2026-11-15.json`, 15 Nov 2026) checked three things from a
cross-origin Chromium page:
- CORS;
- candle limits, row order and the open-bar flag;
- timeframes.

The rate limits were then read from each venue's documentation. The probe could not read them, because rate-limit headers
are not exposed cross-origin. The host changes are recorded in the ADR-0003 amendment "v2.8 (15 Nov 2026, WP26: new
exchanges)".

The plan choices the owner approved on 15 Nov 2026 were:
- Coinbase is offered in USD only (plus USDT);
- Upbit BTC-market prices are not converted to the display currency;
- providers are named in text, with no logos;
- the link patterns and terms stay unverified until the owner checks them.

## Decision
Four new scan sources, with ids used verbatim everywhere:

| Id | Label | Module |
|---|---|---|
| `okx` | OKX Spot | `lib/okx.ts` |
| `okx-perp` | OKX Perpetual | `lib/okx.ts` |
| `coinbase` | Coinbase (US) | `lib/coinbase.ts` |
| `upbit` | Upbit (KR) | `lib/upbit.ts`, through `lib/native-relay.ts` |

All four go through the same pipeline as the existing sources:
- closed bars only;
- pacing, with the global 429/418 halt across tiers (`RateLimitError`, WP27 `runTiers`) and a per-venue cooldown;
- WP12 quote handling;
- merged pages that are sorted, de-duplicated and cut to their newest contiguous run (`contiguousTail`). A series shorter
  than 1,000 bars is scored **cold** (`wb` < `ENGINE_BARS`) and never padded.

Pair ids are normalised to `[A-Z0-9]{2,30}` (`lib/venue-ids.ts`). The shared rate gate is `lib/rate-gate.ts`, a sliding
one-second window per gate.

### 1. OKX (`okx`, `okx-perp`)

**Host and transport**
- Host: `https://www.okx.com`.
- CORS (probe): **ALLOWED** for every request made (SPOT/SWAP tickers, public/instruments, market/candles,
  market/history-candles, market/books).
- Transport: direct fetch through CSP `connect-src` (`CSP_HOSTS`).
- Paths: `/api/v5/market/tickers?instType=SPOT|SWAP`, `/api/v5/public/instruments?instType=SWAP`,
  `/api/v5/market/candles`, `/api/v5/market/history-candles` and `/api/v5/market/books?sz=100`.

**Limits and the gates used**

| Path | Documented limit | Gate used (80 %) |
|---|---|---|
| `GET /api/v5/market/candles` | 40 requests per 2 s per IP | 16/s (`OKX_CANDLES_PER_S`) |
| `GET /api/v5/market/history-candles` | 20 requests per 2 s per IP | 8/s (`OKX_HISTORY_PER_S`) |
| `GET /api/v5/public/instruments` | 20 requests per 2 s | not gated (see below) |

- Source: OKX API v5 docs, <https://www.okx.com/docs-v5/en/>, read 15 Nov 2026.
- Both candle paths take at most `limit` 300 (docs; the probe saw `limit=500` capped to 300).
- Each gate is shared by both OKX sources and by every caller in the process: scan, delta, backfill and prefetch. The
  server-route process has its own gate.
- Tickers, books and instruments make one call per scan or view and are not gated.
- 429 → `RateLimitError`. Code `50011` inside a 200 envelope is also treated as a rate limit [not verified].

**Timeframes and request cap**
- Native bars:

  | App | OKX bar |
  |---|---|
  | 1m, 5m, 15m | `1m`, `5m`, `15m` |
  | 1h | `1H` |
  | 4h | `4H` |
  | 6h | `6Hutc` |
  | 12h | `12Hutc` |
  | 1d | `1Dutc` |
  | 1w | `1Wutc` |
  | 1M | `1Mutc` |

  The `…utc` variants are used because `1D` is cut at 16:00 UTC (UTC+8).
- Aggregated: 8h = 2 × `4H` (the probe saw `8H` rejected with code 51000), and 2d / 4d are synthetic days from `1Dutc`
  (`SYNTHETIC_DAY_INTERVALS`).
- Paging: newest page from `/market/candles`, older pages from `/market/history-candles?after=` (strictly older, per the
  probe). At most ⌈want / 299⌉ + 1 pages, which is 5 for 1,000 bars.
- An aggregated interval reads at most 1,000 base bars, as Binance and Bybit do. 8h and 2d therefore score on 500 bars
  and 4d on 250 bars, all cold.

**Open bar**
- The probe shows `confirm` `"0"` on the bar still forming. Such rows are never kept.
- `dropUnclosed` also drops any bar whose close time is in the future.

**Perpetual**
- Only `ctType linear`, `state live`, `*-USDT-SWAP` instruments are scanned. Without the instrument list, the
  `-USDT-SWAP` id is used.
- Volume uses `volCcy` (base coin; `vol` counts contracts).
- Book sizes are multiplied by `ctVal`.
- No mark-price call in Step 2, so the basis stays undefined.

**Fees** (`DEFAULT_COSTS`)
- `okx` 10 bps and `okx-perp` 6 bps. These mirror the existing spot default and the Bitget perpetual default
  [not verified].

### 2. Coinbase Exchange (`coinbase`)

**Host and transport**
- Host: `https://api.exchange.coinbase.com`.
- CORS (probe): **ALLOWED** for `/products`, `/products/volume-summary`, `/products/stats`, `/products/{id}/stats`,
  `/products/{id}/ticker` and `/products/{id}/candles`.
- `/products/{id}/book?level=2` was not in the probe; its CORS and row shape come from Coinbase's docs [not verified by the
  probe].
- The Advanced Trade host (`api.coinbase.com/api/v3/brokerage/market/...`) was **refused** cross-origin and is not used.
- Transport: direct fetch through CSP `connect-src`.

**Limits and the gate used**
- Documented: public endpoints allow "Requests per second per IP: 10" and "in bursts: Up to 15". Source: Coinbase Exchange
  docs, <https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits>, read 15 Nov 2026.
- Gate used: **8/s** (`COINBASE_REQUESTS_PER_S`), one gate for every Coinbase request (candles, products, stats and book).
  The burst allowance is not used.

**Timeframes and request cap**
- Granularities are 60, 300, 900, 3600, 21600 and 86400 s only, with at most 300 rows per request when start and end are
  given (probe and docs).

  | App | Source | Requests for 1,000 bars | Bars when the cap stops it |
  |---|---|---|---|
  | 1m, 5m, 15m, 1h, 6h, 1d | native | 4 | — |
  | 4h | 4 × 1h | 14 | — |
  | 12h | 2 × 6h | 7 | — |
  | 2d | from 1d | 7 | — |
  | 4d | from 1d | 14 | — |
  | 8h | 8 × 1h | stops at 16 | about 600 (cold) |
  | 1w | 7 × 1d | stops at 16 | about 685 (cold) |
  | 1M | calendar months from 1d | stops at 16 | about 157 (cold) |

- Request cap: **16 per series** (`COINBASE_MAX_REQUESTS_PER_SERIES`, 4,800 base bars).
- An aggregated bucket is built only when every base bar is present. A no-trade gap, or the bucket still forming, is
  never shown.

**Calendar alignment (Coinbase-built bars)**
- 1w buckets start on Monday 00:00 UTC.
- 1M buckets are calendar months, as `barCloseTime` closes a 1M bar.

**Start and end**
- `start` and `end` are **inclusive**. A live check on 15 Nov 2026 (~14:00Z) asked for BTC-USD at granularity 3600:
  - a 299 h span returned 300 rows, with the newest = `end` and the oldest = `start`;
  - a 300 h span returned 301 rows and was not rejected.

**Gaps and the open bar**
- Coinbase publishes no candle for an interval with no trades (docs). The newest contiguous run is kept.
- There is no open flag. Windows end at the last closed bar, and bars are dropped by close time.

**Quotes**
- USD (default) and USDT, with `status "online"` and `trading_disabled false` only.
- **USDC is not offered:** BTC-USDC and ETH-USDC are `delisted` with trading disabled, and USDC books are served as USD
  (probe).
- **Paper trading:** Coinbase's own USD books are US dollars, so `usdQuoted` accepts plain `USD` when the source is
  `coinbase` (final fix wave). USD and USDT pairs can both be proposed. Plain-USD books on other venues stay refused.

**Fees**
- 60 bps: base-tier taker (maker 40 bps). Source: Coinbase Exchange fees,
  <https://support.coinbase.com/en/exchange/trading-and-funding/exchange-fees>, read 15 Nov 2026.

**Speed**
- A cold 4h scan of 100 pairs is about 14 × 100 requests at 8/s, roughly three minutes.
- The health line says "slow" after 90 s.

### 3. Upbit (`upbit`)

**Host and transport**
- Host: `https://api.upbit.com`.
- CORS (probe): **UNRELIABLE**. `/v1/market/all` and `/v1/candles/minutes/240` were sometimes answered cross-origin.
  Ticker, days, weeks and a repeat of market/all were refused in the same minute, even with 1.2 s spacing.
- Transport: the ADR-0013 rewrite-and-native pattern, applied by `relayGet` on every transport:

  | Where | How the request leaves |
  |---|---|
  | Web | Same-origin rewrite `/x/upbit/...`: Netlify `public/_redirects`, one row per read path, plus the local launcher proxy |
  | Native shells | `nativeGet()` with the path-scoped `NATIVE_HOSTS` allowlist (Tauri `plugin-http` scope, Capacitor) |
  | Node (server route, recorder, replay CLI) | Plain fetch with the same allowlist |

- Read paths only (`UPBIT_READ_PATHS`): `/v1/market/all`, `/v1/ticker/all`, `/v1/ticker`, `/v1/orderbook` and
  `/v1/candles/*`.
- A page never fetches `https://api.upbit.com` itself (acceptance EX-6).
- A refused path, a missing rewrite (404), an unreadable body or a network failure is an `UpbitFeedError`. The rows say
  "Feed unavailable" and the health line says "Blocked or unreachable" (web) or "Network blocked" (native). There is never
  a fallback to a direct fetch, and other sources are unaffected.

**Limits and the gates used**
- Documented:
  - the candle group allows 10 calls per second per IP;
  - `count` is at most 200;
  - `to` is an ISO 8601 time and exclusive.

  Source: Upbit docs, <https://docs.upbit.com/kr/reference/list-candles-weeks>, read 15 Nov 2026.
- The ticker group also allows 10/s. Source: a secondary source (algolab.co.kr) citing Upbit's docs.
- Gates used: **8/s** for candles and **8/s** for market/all, ticker/all and orderbook (`UPBIT_REQUESTS_PER_S`).
- 429 and 418 → `RateLimitError` and the `upbit` cooldown (Retry-After, or else 60 s for a 429 and 10 min for a 418).

**Timeframes and request cap**

| App | Upbit candles | Requests for 1,000 bars | Bars when the cap stops it |
|---|---|---|---|
| 1m, 5m, 15m, 1h, 4h | `minutes/1`, `5`, `15`, `60`, `240` | 5 | — |
| 1d | `days` | 5 | — |
| 1w | `weeks` | 5 | — |
| 1M | `months` | 5 | — |
| 8h | 2 × 240m | 10 | — |
| 12h | 3 × 240m | 15 | — |
| 2d | from days | 10 | — |
| 4d | from days | stops at 16 | 800 (cold) |
| 6h | 6 × 60m | stops at 16 | 533 (cold) |

- Request cap: **16 per series** (`UPBIT_MAX_REQUESTS_PER_SERIES`, 3,200 base candles).

**Calendar alignment**
- Days start at 00:00 UTC, which is 09:00 KST (probe).
- Weeks start on Monday 00:00 UTC and months on the 1st at 00:00 UTC. This was confirmed by a live probe on 15 Nov 2026
  (~16:16Z): `/v1/candles/weeks` KRW-BTC opened on 2026-11-09, 11-02 and 10-26, and `/v1/candles/months` on the 1st.
- Rows off a bucket edge are skipped, so a change of alignment shows as a feed error, never as misaligned bars.

**Open bar**
- There is no flag; the newest row is the bar still forming (probe).
- The first page asks `to` = the open of the forming bar. Any bar at or after it is dropped, and bars are also dropped by
  close time.

**Quotes and prices**
- Markets: KRW (default), USDT and BTC.
- The scan's USD volume and the liquidity floor use Upbit's own `KRW-USDT` and `USDT-BTC` tickers, never display rates
  (R21). A missing `KRW-USDT` makes KRW volume unknown and ranks the pair last. It is sent to the page as `0`, never
  `NaN`. An active liquidity floor leaves such pairs out, and the scan line counts them as "unknown US$ volume", not as
  thin pairs.
- **Paper trading:** KRW and BTC pairs are refused with `paper.rule.currency` (the paper account is in US dollars). USDT
  pairs can be proposed. Tests pin both cases.
- **KRW prices** go to the display currency through display FX, like PHP.
- **BTC-market prices are not converted.** Display FX (ADR-0015) converts fiat currencies with reference rates, and BTC is
  not one. Converting through `USDT-BTC` would put a market price into the display-only rate path. The scan line says
  "Prices in BTC — not converted to your display currency."
- The `/v1/ticker/all` fields come from Upbit's docs. A live probe on 15 Nov 2026 (~16:16Z) confirmed `market`,
  `opening_price`, `trade_price`, `prev_closing_price`, `signed_change_rate`, `acc_trade_price_24h` and `timestamp`; it
  showed KRW-USDT `trade_price` 1377.
- The `/v1/orderbook` shape comes from the docs [not verified by probe].

**Fees**
- Taker fee per quote market (`QUOTE_FEE_BPS`, through `costsFor(source, ac, slip, quote)`):
  - **KRW markets 5 bps** (0.05 %);
  - **BTC and USDT markets 25 bps** (0.25 %, the `DEFAULT_COSTS.upbit` figure).
- Slippage is a 5 bps placeholder.
- Source: a secondary source (Upbit review, digitalmoneybox.com, 2026) [not verified on Upbit's fee page].
- The ledger's measured outcomes, the paper broker and the replay CLI charge the pair's own quote market. The ledger's
  cost line still shows the source default (25 bps).

### 4. Common rules (all four sources)
- **No keys, no orders, no referral codes, no embedding:**
  - no `privateApi` profile, no account, order, deposit or withdrawal endpoint (R12 order paths, R20 keyless sources);
  - paper trading only;
  - Claude is never in an order path;
  - "View on [exchange]" is a plain `<a target="_blank" rel="noopener noreferrer">` with no referral, invite, affiliate or
    `utm_` parameter, and no exchange page is framed or embedded.
- About → **Data sources & thanks** (collapsed) names every provider in text, with no logos, and links its public API
  docs and terms (`lib/providers.ts`).
- Engine unchanged: `ENGINE_VERSION` 2.4.0, config id `5c30b5c39f5ba3f2`.

### 5. Terms of use (to be read and recorded before release)

| Venue | Terms | Status |
|---|---|---|
| OKX | The OKX API docs page (<https://www.okx.com/docs-v5/en/>) states that use of the API is subject to the **"OKX API Agreement — continued use constitutes acceptance"**. | Agreement text [to be read by the owner before release] [not verified] |
| Coinbase | <https://www.coinbase.com/legal> (Coinbase Exchange API terms to be located from there) | [to be read by the owner before release] [not verified] |
| Upbit | <https://global-docs.upbit.com/> (Korean docs: <https://docs.upbit.com/kr>) | [to be read by the owner before release] [not verified] |

**The Upbit web relay.**
- Requests leave from Netlify's shared edge IPs, so an Upbit 429/418 can reach this app without the user causing it (as
  in ADR-0013).
- Whether Upbit's terms allow its public data to be relayed is part of the terms reading above.
- Until that is recorded, treat the relay as the owner's personal use, as with Coins.ph.

### 6. "View on [exchange]" URL patterns

All patterns are **[pattern not verified — owner click-check]**:

| Source | Pattern |
|---|---|
| `okx` | `https://www.okx.com/trade-spot/{base}-{quote}` |
| `okx-perp` | `https://www.okx.com/trade-swap/{base}-usdt-swap` |
| `coinbase` | `https://www.coinbase.com/advanced-trade/spot/{BASE}-{QUOTE}` |
| `upbit` | `https://upbit.com/exchange?code=CRIX.UPBIT.{QUOTE}-{BASE}` |

The existing sources' patterns (Binance, Bybit, Bitget, Coins.ph) in `lib/exchange-links.ts` are unverified in the same
way.

### 7. Open checks (before release)
1. **Netlify `%2e%2e` in the `:splat` rewrite** (`/x/upbit/v1/candles/*`): it is not verified whether Netlify decodes an
   encoded `..` before forwarding. No credentials are relayed, so the worst case is an unauthenticated request reaching a
   private path, which Upbit refuses. To check on a deploy preview. The local launcher re-checks the parsed path and
   refuses `%2e` / `%25` / `%2f` / `%5c` / `\` (Task 2 fix).
2. **Tauri http scope for Upbit: closed, no change needed.**
   - The scope lists `/v1/market/all`, `/v1/ticker/all`, `/v1/ticker` and `/v1/orderbook` as exact URLs, and the calls
     carry query strings.
   - The pinned `tauri-plugin-http` 2.8.3 (`desktop/src-tauri/Cargo.toml`, `=2.8.3`) parses each scope URL with
     `parse_url_pattern`, which sets an empty search and hash to `*` (`src/scope.rs:17-34`). Its own `fixed_path` test
     shows that `http://localhost:8080/file.png` allows `…/file.png?q=1` and refuses `…/file.png/other.jpg`.
   - So an exact-path entry already admits any query string, while the path stays exact. The same holds for the Coins.ph
     exact entries.
   - No `…?*` entries are added. They would change nothing at runtime, and R16 would then fail, because it requires the
     scope to equal the `NATIVE_HOSTS` URLs exactly.
   - One native smoke run before release is still worthwhile, to check the wiring of `makeNativeGet`.
3. **Upbit fees:** per-quote costs are set (section 3). The figures still need checking against Upbit's own fee page.
4. **Terms and link patterns:** sections 5 and 6.

## Consequences
- Three more venues to keep in step with ADR-0003, `public-hosts.ts`, the CSP, the Tauri scope, the rewrites and the
  egress manifest (R8, R11, R16).
- Timeframes a venue lacks are built from shorter candles and cost more requests. Above the cap they are scored cold. The
  guide says so (`docs/user-guide/en.md`, `<!-- wp:WP26 -->`).
- Acceptance **EX-1**…**EX-4** scan each source on mocked venue data in the probe's shapes, with an open newest bar in
  every mock. They check that the scan completes with ≥ 3 rows, that the detail chart ends on the last closed bar, and that
  no ledger row comes from the open bar. **EX-5** checks the View link and **EX-6** that Upbit is reached only through
  `/x/upbit/`.
