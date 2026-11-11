# ADR-0008 — Headless recorder and alerts (Phases C and F); egress amendment

**Status:** Accepted · 31 Oct 2026 · v2.3

## Context
The forward-test ledger (ADR-0007) only grows while the app, or its worker, is open. The app's catch-up fills at most 48 bars per series when it next opens, so a laptop that stays closed for a week on 1 h bars loses data. Bars recorded by catch-up also lose their live context (rank and volume at the time).

Alerts for strong signals and reversals were only toasts inside an open tab.

Measuring the signals needs 3–6 months of uninterrupted forward data (docs/measurement.md).

## Decision
1. **Separate Node process** (`apps/confluence/recorder`, package `@rsl/confluence-recorder` 2.3.0). It uses Node built-ins only and has no npm dependencies.
2. **One scoring path, unchanged.** The recorder imports the web engine's TypeScript directly from `apps/confluence/web/src/lib`. It uses Node type stripping plus a small resolve hook (`ts-resolve.mjs`) that maps extensionless relative imports in `.ts` files to `.ts`. Nothing is copied or rewritten.
   - Every number comes from the same functions: `fetchMarketData`, `mergeKlines`, `contiguousTail`, `scoreSeries`, `toLedgerRow`, `runScanJobSafe` (catch-up) and `enrich`.
   - Rows carry the same `configId` as the app. `NEXT_PUBLIC_BUILD_TARGET=html` is forced, so the engine fetches directly with no proxy.
3. **Plain files, append-only.**
   - Ledger: `ledger/YYYY-MM.jsonl`, with a `.ids` index per month. Dedupe is by row id, so restarts are idempotent.
   - Also written: a rankings log, a derivatives log, a per-series candle cache, `state.json` (per-series cursors), `heartbeat.json`, `alerts-state.json` and a single-instance lock.
   - Atomic renames are used for documents. A torn trailing line is cut after a crash.
4. **Scheduling.** By default the recorder wakes 20 s after each bar close. The next close is derived from the newest closed bar, so weekly and monthly bars are handled correctly.
   - Rate limits stop the cycle and the recorder sleeps for the venue's cooldown. Failures back off from 30 s up to 15 min.
   - `--once` is for OS schedulers. `--check-heartbeat` is a dead-man watchdog.
5. **Derivatives context.** Funding rate, next funding time, funding interval and open interest are logged from Bybit V5 public endpoints for the scanned symbols. They are never scored.
6. **Alerts only from the recorder.** Telegram (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`) and/or a webhook (`ALERT_WEBHOOK_URL`), configured by environment variables only. The browser app does not send alerts.
   - Triggers: a new STRONG Master Signal, a HIGH/MODERATE reversal, 3 consecutive failed cycles and a stale heartbeat.
   - Dedupe is by series + bar + kind, persisted *before* sending, with a cooldown of 6 bars per series and kind.
   - Every message ends with "analysis only — not financial advice". Secrets are redacted from every log and error.

## Egress amendment to ADR-0003
ADR-0003 limited the **app** to the market-data hosts. The allowed hosts for each process are now listed in `tools/egress-manifest.json`:

| Process | Hosts |
|---|---|
| web (app) | unchanged: CSP `connect-src`, release-check R8 |
| recorder | `data-api.binance.vision`, `api.bybit.com`, `api.bitget.com` |
| recorder, only when alerts are configured | `api.telegram.org` (both Telegram variables set), and the host of the user's own `ALERT_WEBHOOK_URL` (https only) |
| mcp | none (local, read-only) |

The list is enforced in two places:
- **Statically:** `tools/check-egress.mjs` fails when a recorder or MCP source file contains an `http(s)://` literal for a host not listed for that process, or a host built at runtime. Reserved test domains are allowed.
- **At runtime:** the recorder replaces `globalThis.fetch` with a guard. The guard refuses any non-https request, and any host not in the manifest (plus configured alert hosts), before a socket opens. It also adds a 20 s timeout, sets `redirect: "error"`, and memoises payloads within a cycle.

No telemetry, no third-party libraries, and no order endpoints. The recorder never authenticates to an exchange.

## Consequences
- The forward test runs while the app is closed. Live rows from the recorder carry real rank (`rk`, `rku`) and quote volume, and they are marked `app: "recorder-2.3.0"`.
- **Divergence risk — resolved in v2.3.** Row assembly lives in `apps/confluence/web/src/lib/scan-record.ts` (`liveRow`, `catchUpContext`, `enrichCatchUp`, `scanShared`), used by both the app and the recorder; a unit test pins recorder rows to the same functions on the same bars.
- The recorder writes to its own folder. The app does not read it yet. The MCP server (`apps/confluence/mcp`) and Claude read it. Importing it into the app is a follow-up.
- Running the app and the recorder at the same time costs two sets of market requests. That is well within public limits, but there is no shared rate-limit state between the two processes.
- Bot tokens live in user environment variables (Windows user registry, macOS Keychain via a wrapper). They are never written by the recorder.

## Evidence
- `pnpm --filter @rsl/confluence-recorder test`: 31 offline tests. They cover:
  - row identity with the engine
  - dedupe across restarts and index rebuild
  - catch-up after a gap
  - the rankings log
  - ticker and candle rate limits
  - funding/OI records and bad payloads
  - alert dedupe, cooldown, retry and redaction
  - failure and dead-man alerts
  - egress static and runtime checks
  - Windows-safe paths, the scheduler and config parsing
- **Not verified here:** a live run against the exchanges (this build environment has no route to them), and the Windows Task Scheduler and launchd set-ups described in docs/recorder.md.
