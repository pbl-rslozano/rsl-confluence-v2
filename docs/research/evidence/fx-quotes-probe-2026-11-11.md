# Live probe — 11 Nov 2026, ~08:55 Riyadh, from the owner's Windows PC (Claude desktop browser pane, origin https://example.com)

Method: `fetch()` from a page on a neutral origin, so a 200 means the host sends a CORS header that browsers accept (ACAO `*`).

## FX rate sources
| Source | Result | Notes |
|---|---|---|
| Frankfurter v2 `https://api.frankfurter.dev/v2/rates?base=USD` | 200, CORS OK, 12.6 KB, 200 rows | `/v2/currencies`: 161 type `currency` + 4 `metal` + 35 `crypto`. Rows `{date, base, quote, rate}`; `expand=providers` lists each central bank (e.g. PHP: BSP 62.90 on 2026-11-11, ECB, …; ARS: BCRA, SAMA …) and marks outliers `excluded:true`. `cache-control: public, max-age=64725, stale-if-error=86400`. Values seen: SAR 3.75, AED 3.6725, QAR 3.64, KWD 0.3093, PHP 63.00, EUR 0.89234, JPY 158.24, NGN 1347.37, ARS 1546.23, VND 25648, HKD 7.8488; also USDT 1.0013 (2026-11-10). |
| Frankfurter v1 `api.frankfurter.dev/v1/latest?base=USD` | 200, CORS OK | ECB only: 29 currencies, no SAR/AED. |
| `api.frankfurter.app` | failed (CORS/network) | old host. |
| fawazahmed0 `cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json` | 200, CORS OK, 6.1 KB | 341 codes (fiat+crypto), date 2026-11-10, SAR 3.75, PHP 62.949, usdt 1.00142. Methodology/licence not documented. |
| fawazahmed0 mirror `latest.currency-api.pages.dev/v1/currencies/usd.min.json` | 200, CORS OK | date 2026-11-11, PHP 63.164. |
| open.er-api.com `/v6/latest/USD` | 200, CORS OK | 166 codes, daily, attribution required by terms. |
| ECB `eurofxref-daily.xml` | failed (no CORS) | |
| ECB SDMX `data-api.ecb.europa.eu` jsondata | 200, CORS OK | 29 currencies only. |
| floatrates `/daily/usd.json` | 200, CORS OK | 146 codes, SAR 3.7515 (not the peg). |
| CoinGecko `/api/v3/exchange_rates` | 200 keyless | 97 rows (BTC-based). |

## Exchange stablecoin quotes (public, keyless)
- **Bybit spot** `/v5/market/instruments-info?category=spot&limit=1000`: 521 instruments in one page (no cursor). Trading pairs by `quoteCoin`: USDT 389, USDC 82, EUR 18, USD1 4, USDE 3, RLUSD 3, USD 3, XUSD 1. Fields: `symbol, baseCoin, quoteCoin, status, symbolType, …`.
- **Bybit linear**: 930 instruments over pages: USDT-settled perpetual 822, USDC-settled perpetual 68 (symbols `BTCPERP`, `1000PEPEPERP`, base in `baseCoin`), USDT dated futures 40.
- **Bitget spot** `/api/v2/spot/public/symbols`: 3,670 symbols; online by `quoteCoin`: USDT 3,595, USDC 31, EUR 11, USD1 6, USD 3, USDE 3, U 1, RLUSD 1.
- **Bitget USDC-FUTURES** `/api/v2/mix/market/contracts?productType=USDC-FUTURES`: 49 perpetuals, symbols `BTCPERP` (baseCoin BTC, quoteCoin USDC). Tickers carry `lastPr, quoteVolume, usdtVolume, change24h, markPrice, indexPrice` (same shape as USDT-FUTURES).
- **Binance** `data-api.binance.vision`: every CORS fetch failed ("Failed to fetch"), while a `no-cors` request returned opaque → host reachable, response without CORS headers. Consistent with a 418/429 IP ban response (errors carry no ACAO) on the owner's IP at that moment; earlier probe PH-1 (7 Nov) had Binance 200. Binance quote counts therefore come from research notes only (≈ USDT 400+, USDC 100+, FDUSD ~50, plus USD1, EURI, U …; MiCA restrictions for EEA users).
