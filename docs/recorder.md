# Headless recorder and alerts — v2.3 2026

The recorder keeps the forward-test ledger growing while the app is closed. It runs as a small Node process on your computer and uses the **same scoring code as the app** (same engine id, same 1,000-bar window, same catch-up). It reads public market data only.

It never logs in to an exchange and never places orders. Analysis only — not financial advice.

Design and network rules: `docs/adr/0008-headless-recorder.md`.

## Requirements
- Node **22.15 or later** (tested on 22.23).
- This repository checked out. The recorder imports `apps/confluence/web/src/lib` and `tools/egress-manifest.json` from it.
- No `pnpm install` is needed. The recorder uses Node built-ins only.

## Run it
Run it from `apps/confluence/recorder`. The `--import ./ts-resolve.mjs` path is relative to the working folder.

```
cd apps/confluence/recorder
node --experimental-strip-types --import ./ts-resolve.mjs recorder.mjs --source binance --tf 4h --limit 30 --out ~/rsl-recorder
```

Short forms:
- `pnpm --filter @rsl/confluence-recorder start -- --tf 4h`
- `npm start -- --tf 4h` (from inside the folder)

Add `--disable-warning=ExperimentalWarning` after `node` to hide Node's type-stripping notice.

| Option (env) | Default | Meaning |
|---|---|---|
| `--source` (`RECORDER_SOURCE`) | `binance` | `binance`, `bybit-spot`, `bybit-perp` or `bitget` |
| `--tf` (`RECORDER_TF`) | `4h` | any timeframe the app supports |
| `--limit` (`RECORDER_LIMIT`) | `30` | universe size: top N by 24 h volume, 1–200 |
| `--asset-class` (`RECORDER_ASSET_CLASS`) | `crypto` | `crypto`, `rwa`, `stock`, `fx`, `commodity` or `all` |
| `--out` (`RECORDER_OUT`) | `./recorder-data` | output folder. **Use an absolute path for scheduled tasks.** |
| `--once` (`RECORDER_ONCE=1`) | off | one cycle, then exit. Exit code 1 if the cycle failed. |
| `--interval-seconds` | off | fixed cadence (≥ 30 s) instead of "just after each bar close" |
| `--grace-seconds` | `20` | wait after a bar close. Raise it if this PC's clock runs fast. |
| `--catch-up-max` | `48` | closed bars scored per series after a gap (same as the app) |
| `--derivs` | `auto` | funding / open-interest log. `auto` = only with `bybit-perp`; `on` = for scanned symbols that also list on Bybit linear. v2.8: rows log `fr` / `oiChg` from a snapshot ≤ 2 h before their close; on bars longer than 2 h the looping recorder adds a derivatives-only snapshot 15 min before each close (not with `--once`). |
| `--radar` | `off` | `on` = the market-radar context (BTC funding percentile, open-interest change, long/short, taker share, US/Korea/Philippines premiums, alert codes; context only, never scored) is refreshed each cycle (at most every 5 minutes) and always at the derivs pre-close wake, logged to `radar/YYYY-MM.jsonl` and joined onto each row as `rad` (newest entry at or before the row's close, ≤ 2 h old). Reads `fapi.binance.com`, `publicreporting.cftc.gov`, `stablecoins.llama.fi`, the Binance, Bybit, Bitget, OKX and Coinbase candle and price paths, and the Upbit and Coins.ph read paths, all through the egress guard. With `off` no radar request is made. No depeg alert codes (they need a scan's stablecoin readings). As with `--derivs`, a run only with `--once` on bars longer than 2 h never takes the pre-close wake, so its rows carry `rad` null unless a reading from another run falls inside the 2 h window. |
| `--oi-top` | `10` | how many top symbols get an open-interest request each cycle |
| `--check-heartbeat` | | dead-man check. Exit 1 (and alert, if configured) when no cycle has succeeded for 3 cycle periods + 10 min. |

**One recorder per output folder.** A lock file refuses a second instance on the same folder. To record several timeframes, use one output folder per recorder.

**What happens after downtime.** If the PC slept or was off, the next cycle catches up. It scores up to `--catch-up-max` missed bars per series, using full windows only, and sends one dead-man alert about the outage.

## Run it on a schedule

### Windows (Task Scheduler, PowerShell)
Run once in PowerShell, with your own paths:

```powershell
$dir  = "C:\src\rsl-confluence\apps\confluence\recorder"
$out  = "$env:USERPROFILE\rsl-recorder"
$node = (Get-Command node).Source
$argv = "--experimental-strip-types --disable-warning=ExperimentalWarning --import ./ts-resolve.mjs recorder.mjs --source binance --tf 4h --limit 30 --out `"$out`""
$action   = New-ScheduledTaskAction -Execute $node -Argument $argv -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -AtLogOn
# ExecutionTimeLimit 0 = no limit (the default of 72 h would stop the recorder).
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 5) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "rsL Confluence Recorder" -Action $action -Trigger $trigger -Settings $settings

# Dead-man watchdog: every hour, alerts if the recorder has stopped recording.
$check = New-ScheduledTaskAction -Execute $node -WorkingDirectory $dir `
         -Argument "--experimental-strip-types --disable-warning=ExperimentalWarning --import ./ts-resolve.mjs recorder.mjs --check-heartbeat --out `"$out`""
$hourly = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName "rsL Confluence Recorder check" -Action $check -Trigger $hourly
```

Notes:
- **Working directory.** It must be the recorder folder. If you cannot set one, give `--import` an absolute file URL, for example `--import file:///C:/src/rsl-confluence/apps/confluence/recorder/ts-resolve.mjs`. A bare `C:\…` path is not accepted there.
- **Stop it.** Use `Stop-ScheduledTask "rsL Confluence Recorder"`, or press Ctrl+C / Ctrl+Break in a console. A hard kill is safe: writes are atomic, and a torn ledger line is cut on the next start.
- **Laptops.** The recorder cannot record while Windows sleeps. Catch-up fills the gap afterwards.

### macOS (launchd)
Create `~/Library/LaunchAgents/com.rslozano.confluence-recorder.plist`, with your own paths (`which node` gives the node path):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.rslozano.confluence-recorder</string>
  <key>WorkingDirectory</key><string>/Users/you/src/rsl-confluence/apps/confluence/recorder</string>
  <key>ProgramArguments</key><array>
    <string>/opt/homebrew/bin/node</string>
    <string>--experimental-strip-types</string><string>--disable-warning=ExperimentalWarning</string>
    <string>--import</string><string>./ts-resolve.mjs</string>
    <string>recorder.mjs</string>
    <string>--source</string><string>binance</string><string>--tf</string><string>4h</string>
    <string>--out</string><string>/Users/you/rsl-recorder</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>/Users/you/rsl-recorder/launchd.out.log</string>
  <key>StandardErrorPath</key><string>/Users/you/rsl-recorder/launchd.err.log</string>
</dict></plist>
```

Then start it:

```
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.rslozano.confluence-recorder.plist
launchctl kickstart -k gui/$(id -u)/com.rslozano.confluence-recorder     # restart
launchctl bootout gui/$(id -u)/com.rslozano.confluence-recorder          # stop and unload
```

launchd sends SIGTERM to stop it. The recorder finishes the current step and exits cleanly.

For the watchdog, make a second agent with `--check-heartbeat`. Give it `<key>StartInterval</key><integer>3600</integer>` instead of `KeepAlive`.

### Linux (systemd user unit)
Use `ExecStart=/usr/bin/node --experimental-strip-types --import ./ts-resolve.mjs recorder.mjs --out %h/rsl-recorder` with `WorkingDirectory=` set to the recorder folder. Add `Restart=always`, then run `systemctl --user enable --now …`.

## Alerts (optional)
Alerts are configured **only** through environment variables. The recorder never writes them to disk.

| Variable | |
|---|---|
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Create a bot with @BotFather and send it a message. Get the chat id from `getUpdates`, or use a group id such as `-100…`. |
| `ALERT_WEBHOOK_URL` | Your own **https** endpoint. It receives a JSON POST: `{ source, kind, text, disclaimer, pair, src, tf, ac, cfg, score, barOpen, barClose }`. |
| `ALERT_COOLDOWN_BARS` | Default `6`: the same series and alert kind stays quiet for this many bars. |
| `ALERT_MAX_PER_CYCLE` | Default `10`: any further alerts in the same cycle are summarised in one message. |

What triggers an alert:
- `strong-bull` / `strong-bear`: the Master Signal becomes STRONG (or flips STRONG side).
- `rev-up` / `rev-down`: a HIGH or MODERATE reversal against the trend (same rule as the app).
- `failure`: 3 consecutive failed cycles, then one `recovered` message.
- `deadman`: the heartbeat went stale. This is found on restart, or by `--check-heartbeat`.

Only the newest bar can alert. Bars filled in by catch-up never do.

Each alert is sent once at most. Its key (series + bar + kind) is stored in `alerts-state.json` **before** sending, so a crash or restart cannot repeat it. Failed sends are retried up to 3 times within 2 h.

Every message includes the engine id, source / timeframe / pair, score, bar close time in UTC and "analysis only — not financial advice".

Where to keep the token:
- **Windows:** `setx TELEGRAM_BOT_TOKEN "…"` and `setx TELEGRAM_CHAT_ID "…"`. These are user environment variables; a scheduled task picks them up the next time it starts.
- **macOS:** keep the token in the Keychain with `security add-generic-password -a "$USER" -s rsl-telegram -w`. In the plist, run `/bin/sh -c 'TELEGRAM_BOT_TOKEN="$(security find-generic-password -s rsl-telegram -w)" TELEGRAM_CHAT_ID=… exec /opt/homebrew/bin/node …'`. This keeps the token out of the plist file.

The token is redacted from logs, heartbeat errors and alert state. When alerts are configured, `api.telegram.org` and the webhook host are added to the recorder's network allowlist; they are not on it otherwise.

## Files produced (`--out`)
| Path | Content |
|---|---|
| `ledger/YYYY-MM.jsonl` | One ledger row (`LedgerRow`, the same fields as the app) per series and closed bar, filed by the month of the **bar**. Append-only. |
| `ledger/YYYY-MM.ids` | Row ids of that file, line for line. This is the dedupe index, rebuilt automatically if missing. |
| `rankings/YYYY-MM.jsonl` | The full unfiltered venue ranking (all classes, top 300) of every cycle: `{ t, src, tf, cls, view, bar, n, ranks: [[symbol, quoteVolume], …] }` |
| `derivs/YYYY-MM.jsonl` | `{ t, venue: "bybit", cat: "linear", pair, fr, nft, fi, mp, oi, oit }`: funding rate per interval, next funding time (ms), funding interval (minutes), mark price, open interest and its timestamp. Never scored. |
| `radar/YYYY-MM.jsonl` | `--radar on` only: `{ t, frp, oi24, ls, tk, usP, krP, phP, al }`, one line per refresh (BTC values; null = no current value; `al` = alert codes). `radar/cache.json` keeps the CFTC and stablecoin-supply cache between `--once` runs. Never scored. |
| `candles/<src>/<tf>/<PAIR>.json` | The recorder's candle cache: the newest 2,000 bars, `{ schema, src, tf, pair, bars: [[t, o, h, l, c, v, takerBuy?]] }`. Monthly bars use the folder `1mo`, so they cannot clash with `1m` on Windows or macOS. |
| `state.json` | Per-series cursors (the newest bar recorded) for catch-up |
| `heartbeat.json` | Status, `lastSuccessAt` / `at`, `consecutiveFailures`, rows written, last errors, `rateLimitedUntil`, `nextWakeAt`, `staleAfterMs` |
| `alerts-state.json` | Sent-alert keys, cooldowns, per-series last state and the retry outbox. No secrets. |
| `recorder.log` | Log lines, redacted, rotated at 5 MB |

Ledger rows from the recorder:
- `live: 1` and `app: "recorder-2.3.0"`.
- `rk` is the rank in the scanned class view, as in the app. `rku` is the rank in the full venue ranking.
- `rks` is `"live"` for the newest bar, or `"now"` for catch-up bars (their rank is the one at catch-up time).
- `rec` is the cycle time.

Row ids are the app's (`cfg|src|tf|pair|barTime`). Pooling recorder rows with an app export is therefore safe: deduplicate by id.

## Reading the data
- **Claude:** point the local MCP server at the folder:
  ```
  node apps/confluence/mcp/src/cli.mjs --data ~/rsl-recorder
  ```
  Or set `CONFLUENCE_DATA_DIR`. Its tools read `ledger/`, `rankings/`, `derivs/`, `candles/` and `heartbeat.json` (`recorder_health`).
- **The app:** toolbar → Ledger → **Import ledger** reads `ledger/YYYY-MM.jsonl` (v2.3). Every row is validated (its id must match engine × source × timeframe × pair × bar) and duplicates are ignored, so importing the same month twice is harmless. The MCP server reads the same files directly.
- **By hand:** every file is UTF-8 JSON or JSON Lines, readable with any tool.

## Network
The recorder may contact only the hosts listed for `recorder` in `tools/egress-manifest.json`: the three market-data hosts, plus the alert hosts when configured. This is enforced at runtime, before any socket opens. `node tools/check-egress.mjs` checks the source.

Each request has a 20 s timeout and redirects are refused.

Rate limits work as in the app:
- HTTP 429/418, a Bybit 403 or Bybit retCode 10006/10018 stops the cycle at once.
- The recorder then sleeps for the venue's `Retry-After` (60 s by default; 10 min after a ban).

## Troubleshooting
- **"another recorder (pid …) is already writing"**: a second instance is pointed at the same `--out`. Stop the other one, or use another folder.
- **`heartbeat.json` shows `"status": "failing"`**: read `errors`. `ENOTFOUND` or `fetch failed (…)` means no network. `rate limited` means the recorder is waiting for the cooldown.
- **`ranking`/`universe` warnings**: the engine did not return the full ranking, so `rku` is missing for that cycle.
- **Exit codes:**
  - `0`: ok
  - `1`: `--once` cycle failed, or the heartbeat is stale
  - `2`: bad options, or the recorder could not start
  - `130`: interrupted twice

## Not verified in the build environment
- A live run against Binance, Bybit and Bitget (this environment has no route to them; every test uses recorded payload shapes).
- The Task Scheduler, launchd and systemd set-ups above.

## Scanner workspace alert files

In the terminal, scan a saved watchlist and open **Alert inbox**. Choose a
score threshold and export the active rule. Place the resulting
`workspace-rules.json` in the recorder output directory. Run the recorder
for the same venue and timeframe, with a universe that includes the listed
instruments. Rules evaluate only rows produced by that recorder.

The first eligible bar initializes the crossing state. A subsequent newly
closed bar crossing from below to at or above the threshold writes an
event to `workspace-inbox.json`. Catch-up rows establish prior state.
The recorder writes the revision, cursors and latest events atomically.
Import the inbox file through **Alert inbox**. For a signal absent from
the local ledger, import the recorder ledger and reopen the event.

## Sequenced depth replay pilot

The Bybit linear asset detail can import a normalized JSONL depth capture.
Each line contains pair, at (epoch milliseconds), type (snapshot or delta),
u (consecutive update ID), seq (exchange sequence), bids and asks. Bid and
ask entries are [price, size] pairs. A size of zero removes the level.
Start with a full snapshot, then include deltas in capture order. Insert
a fresh snapshot after reconnecting. The replay marks a missing update or
reset as a gap until a replacement snapshot arrives.

The panel accepts up to 2,000 messages in a file under 8 MB and exposes
the last 60 depth frames. The import accepts normalized capture data.

Capture one synchronized Bybit linear depth segment from the source checkout:

    pnpm --filter @rsl/confluence-recorder capture-depth BTCUSDT capture.jsonl 30

Use a new output filename. The capture retries up to three times after a disconnect or sequence loss. It writes a gap before resuming from an aligned snapshot and stops at the size or duration limit. This opt-in command uses the public Bybit market REST
and linear WebSocket endpoints and requires no credentials.

The same capture subscribes to Bybit's public all-liquidation feed for the
selected linear contract. The PWA import shows observed long and short
liquidations as time markers and lists the exchange-reported bankruptcy
price. Events are recorded only after depth synchronization and represent
the observed capture window. The depth ladder ignores liquidation records.

### Optional local gateway sync

Start the gateway with CONFLUENCE_RECORDER_DIR set to the existing recorder
output directory. In the PWA Alert inbox, open Local gateway sync and paste
the session token printed by the gateway. Deploy active rule updates the
rule for that watchlist while retaining other rules. Sync inbox reads and
merges the recorder inbox. The token is kept in page memory. The file
export and import workflow remains available when the gateway is stopped.

Rank rise rules compare turnover ranks in the recorder's ranked venue
universe of up to 300 instruments. The rule fires when a watched instrument
gains at least the configured number of places between consecutive closed
bars. Comparisons require the same universe membership and engine ID.
A missed or incomplete scan or a membership change establishes a new
baseline. Monthly timeframes are excluded from this fixed-interval rule.
