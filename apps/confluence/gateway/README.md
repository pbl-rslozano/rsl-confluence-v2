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
| `coinglass` | CoinGlass Hobbyist (personal use) | `GET https://open-api-v4.coinglass.com/api/bitcoin/etf/list`; HTTP OK and `code` `"0"` |
| `whale-alert` | Whale Alert Alerts API, US$29.95 per month (personal use) | open `wss://leviathan.whale-alert.io/ws`, send one `subscribe_alerts`, wait for `subscribed_alerts`, close |

Routes (same token, origin and host checks as the rest):

- `POST /providers/connect` with `{ "provider": "coinglass" | "whale-alert", "apiKey": "...", "label": "..." }`. It shares the 5-per-15-minutes limit with `/connect`. A bad payload is refused before any request leaves the PC.
- `GET /providers` lists the connected profiles (masked key only).
- `DELETE /providers/:id` removes one and blanks its key.
- `GET /health` also reports `providers: <count>`.

Where keys live: in this process's memory only, never on disk, never in the web app, a backup, a log line, an error message or a response. They are cleared when the gateway stops and on a crash. Errors from a provider are replaced with a fixed message, so a key or the Whale Alert socket URL (which carries the key) never appears in one.

Both providers are optional and are contacted only for a profile you connect. Whale Alert allows 2 concurrent connections per key.
