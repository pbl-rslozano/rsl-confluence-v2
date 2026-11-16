# Private API gateway

This localhost-only companion keeps exchange credentials outside the browser. It supports credential and permission checks for Binance, Bybit, and Bitget.

It intentionally exposes **no order-placement, withdrawal, transfer, or liquidation endpoints**.

Binance permissions shown in the dialog are the API **key's** own restrictions (`/sapi/v1/account/apiRestrictions`, mainnet). Testnet keys show "Permission unknown" because testnet has no such endpoint.

The v2.1 desktop app (Tauri) is accepted by origin (`tauri://localhost`, `http(s)://tauri.localhost`); `file://` pages (origin `null`) are still refused by design.

## Start

```powershell
npm run gateway
```

The gateway listens on `http://127.0.0.1:8787`. Credentials remain only in process memory and are erased when the gateway stops.

Use a dedicated read-only exchange key, disable withdrawals, add an IP allowlist, and prefer testnet where supported.

If the dashboard is hosted on a non-local origin, set one exact allowed origin before starting the gateway:

```powershell
$env:CONFLUENCE_ALLOWED_ORIGIN='https://your-dashboard.example'
npm run gateway
```


## Data provider keys (optional, paid)

Two market-context providers can be connected beside the exchange keys. They are a separate kind of profile (`kind: "provider"`): they cannot trade, so the read-only refusal that applies to exchange keys does not apply to them, and the two kinds never share a list or a route.

| Provider | Plan the gateway is meant for | Test call at connect |
| --- | --- | --- |
| `coinglass` | CoinGlass Hobbyist (personal use; the ETF list is on all plans) | `GET https://open-api-v4.coinglass.com/api/etf/bitcoin/list`; HTTP OK and `code` `"0"` |
| `whale-alert` | Whale Alert Alerts API, US$29.95 per month (personal use) | open `wss://leviathan.whale-alert.io/ws`, send one `subscribe_alerts`, wait for `subscribed_alerts`, close |

Routes (same token, origin and host checks as the rest):

- `POST /providers/connect` with `{ "provider": "coinglass" | "whale-alert", "apiKey": "...", "label": "..." }`. It shares the 5-per-15-minutes limit with `/connect`. A bad payload is refused before any request leaves the PC.
- `GET /providers` lists the connected profiles (masked key only).
- `DELETE /providers/:id` removes one and blanks its key; a Whale Alert stream is closed unless another profile uses the same key.
- `GET /providers/etf-flows` returns `{ asOf, btc, eth }`: spot-ETF net flows for the newest 30 days, per ticker, from the newest CoinGlass profile (`/api/etf/bitcoin/flow-history` and `/api/etf/ethereum/flow-history`). A ticker with no `flow_usd` that day is left out, and a day with no flows is left out, never counted as zero. The result is cached in memory for 1 hour. One asset failing returns the other with `[]` for the failed one; both failing returns 502 `ETF flows unavailable.`. No CoinGlass profile returns 409.
- `GET /providers/whale-alerts?min=<usd>` returns `{ connected, alerts }` from the newest Whale Alert profile: transfers of the last 24 hours (at most 200, newest first by time) at or above `min` (clamped to US$1 million to US$10 billion). The first call opens the stream; 15 minutes without a call closes it. Raising `min` only filters; lowering it below what the stream subscribed with reconnects once. A stream stays subscribed at the lowest minimum polled during its life and resets only after 15 minutes without a poll (for example when the Radar panel is closed), so a later threshold raise in the app filters locally and does not reconnect. A stream that is not confirmed within 15 seconds is retried with backoff. There is one stream per distinct key, so two profiles with the same key stay within the 2-connection limit. A `not authenticated` reply stops reconnecting until the next call. No Whale Alert profile returns 409.
- `GET /health` also reports `providers: <count>`.

Where keys live: in this process's memory only, never on disk, never in the web app, a backup, a log line, an error message or a response. They are cleared when the gateway stops and on a crash. Errors from a provider are replaced with a fixed message, so a key or the Whale Alert socket URL (which carries the key) never appears in one.

Both providers are optional and are contacted only for a profile you connect. Whale Alert allows 2 concurrent connections per key.
