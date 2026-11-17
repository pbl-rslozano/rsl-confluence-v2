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


## Backup bucket keys (Backblaze B2, Cloudflare R2)

The encrypted cloud backup (About > Encrypted cloud backup) can keep its file in your own Backblaze B2 or Cloudflare R2 bucket. Those two go through this gateway, not the browser, with a key you create for **one bucket only**. The app encrypts the file before it reaches the gateway; the gateway only signs and forwards it.

Create the key:

- **Backblaze B2:** make a private bucket, then App Keys > Add a New Application Key, set "Allow access to Bucket(s)" to that one bucket, type "Read and Write". Note the keyID, the applicationKey (shown once), the bucket name and the region in the S3 endpoint (for example `us-west-004` from `s3.us-west-004.backblazeb2.com`).
- **Cloudflare R2:** make a bucket, then R2 > Manage API tokens > Create API token, permission "Object Read & Write", "Specify bucket(s)" set to that one bucket. Note the Access Key ID, the Secret Access Key (shown once), the bucket name and your account id (32 hex characters).

Connect it with `POST /providers/connect`:

- B2: `{ "provider": "b2", "accessKeyId": "...", "secretAccessKey": "...", "bucket": "...", "region": "us-west-004", "label": "..." }`
- R2: `{ "provider": "r2", "accessKeyId": "...", "secretAccessKey": "...", "bucket": "...", "accountId": "<32 hex>", "label": "..." }`

What the test call checks (it shares the 5-per-15-minutes limit with `/connect`):

1. `HEAD /<bucket>` must answer 200, so the key works and the bucket is the one you named.
2. The key must **not** be able to enumerate other buckets: `GET /` (ListBuckets) must be refused (403), or list only this bucket. A key that lists other buckets is refused with "This key can reach other buckets. Create a key restricted to one bucket."

A 403 only proves the key cannot list buckets. It does not prove the key is limited to one bucket (an R2 token with Object Read & Write on all buckets would also get 403 and be accepted). The gateway itself only ever addresses `rsl-confluence/<name>` in the one bucket you named, but you should still create a key limited to that bucket, as described above.

Transfers: an upload is allowed 10 s plus the time its size needs at 128 KiB/s (at most 5 minutes); a download has 10 s to start and then 30 s between chunks; the key test and the listing keep 10 s.

A bucket key is a provider profile (`kind: "provider"`, with `bucket` and a masked key id). The read-only refusal for exchange keys is unchanged and does not apply to it; it cannot reach an exchange.

Where keys live: in this process's memory only, never on disk, never in the web app, a backup, a log line, an error message or a response. They are cleared when the gateway stops, on a crash and when you remove the profile (`DELETE /providers/:id`). Upstream text, URLs and keys never appear in an error: a failure is one fixed message.

Routes (same token, origin and host checks as the rest; `profile` is the id returned by connect):

- `POST /backup/upload?profile=<id>&name=<file>`: the body is the file, up to **20 MB** (20 x 1024 x 1024 bytes; larger is 413 "Backup is larger than 20 MB."). This is the only route with that limit; every other route keeps 32 KB. `name` must be `confluence-backup-YYYYMMDDTHHMMSSZ.json`; the object is stored as `rsl-confluence/<name>` and nothing else can be written. Answers `{ name, size, modifiedAt }`.
- `GET /backup/list?profile=<id>` answers `{ files: [{ name, size, modifiedAt }] }`: the newest 20 valid backups under `rsl-confluence/`.
- `GET /backup/download?profile=<id>&name=<file>` answers the file's text (`application/json; charset=utf-8`); a file over 20 MB is refused.
- No bucket key connected for that profile: 409 "No backup bucket key is connected."; a bad name: 400; the bucket refuses or does not answer: 502 "The bucket did not accept the request."
- A request refused before its body is read (a bad Host, Origin or token, and the 409/400/413 answers above) is answered once its body has arrived, read and discarded (at most 21 MB, never kept), so an upload receives its answer and not a connection reset, also on a `Connection: close` request.

Backblaze and Cloudflare terms and CORS are not involved (the gateway, not the browser, makes these calls). Their hosts (`s3.<region>.backblazeb2.com`, `<accountId>.r2.cloudflarestorage.com`) are contacted only for a connected bucket profile.

