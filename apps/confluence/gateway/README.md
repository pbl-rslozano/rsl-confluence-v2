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

