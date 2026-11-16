# Claude as analyst — local read-only MCP server · 2.3.0

Phase F, level 1.5 (see `docs/research/Confluence Terminal v2.2 gaps.md` and ADR-0009). Package: `apps/confluence/mcp` (`@rsl/confluence-mcp` 2.3.0).

Claude Desktop or Claude Code starts the server as a **local stdio process**. It reads the recorder folder and app exports, computes the app's own ledger statistics, and keeps an append-only trials register. It **cannot** place orders, move funds, hold API keys or reach the network.

- **MCP SDK:** `@modelcontextprotocol/sdk` **1.32.2**, pinned exactly. It was the latest stable on 31 Oct 2026, released 23 Oct 2026. Its required peer `zod` is pinned at **4.6.7**. Only `server/mcp.js` and `server/stdio.js` are imported, and a test enforces this. No HTTP, SSE or Express transport is loaded.
- **Node:** 22.18 or later is recommended, because it strips TypeScript types without a flag. Node 22.15–22.17 needs `--experimental-strip-types`, and anything older falls back to an async loader hook. Tested on 22.23.

## Data directory
Point the server at one folder with `--data <dir>` or `CONFLUENCE_DATA_DIR`. Every path a tool accepts is relative to it. Absolute paths and `..` are rejected, and so are links that resolve outside the folder.

```
<data>/
├─ ledger/YYYY-MM.jsonl        recorder: one LedgerRow per line
├─ rankings/YYYY-MM.jsonl      recorder: {t, src, tf, ranks:[[symbol, quoteVolume], …]}
├─ derivs/YYYY-MM.jsonl        recorder: funding / OI records
├─ candles/**                  recorder candle cache (see below)
├─ heartbeat.json              recorder heartbeat
├─ exports/                    put app exports here: Ledger → Export CSV / Export JSON
└─ trials.jsonl                trials register (created by log_trial; append-only)
```

- **Ledger:** by default the server reads `ledger/**.jsonl` and then `exports/**` (`.csv`, `.json` or `.jsonl`). Rows are de-duplicated by row id, and the first file wins. A tool's `file` argument restricts the read to one file.
- **Candles:** the layout is still settling, so the reader accepts several forms:
  - layouts `candles/<src>/<tf>/<PAIR>.json`, `…/<PAIR>/<YYYY-MM>.json` chunks, or `candles/<src>_<tf>_<PAIR>.json`. Any other file name works when the document carries `source`, `interval` and `symbol`.
  - content: an array of bars, or `{klines|candles|bars|data: […]}`.
  - bars: `{time|t|openTime, open|o, …}` or `[t, o, h, l, c, v]`. Times may be ms, seconds or ISO strings.
  - pairs without cached candles are listed, not measured.
- **Limits:**
  - 512 MB per streamed JSONL/CSV file (`--max-file-mb`)
  - 64 MB per JSON document (`--max-json-mb`)
  - 1 MB for `heartbeat.json`
  - 16 MB for `trials.jsonl`
  - 3,000,000 rows in memory (`--max-rows`)
  - 20,000 files and 6 levels per directory walk
  - 120,000 characters per tool response. Longer lists are halved until they fit, and the response says so in `_truncated`.

## Tools
Every response ends with **"Analysis only — not financial advice."**, including errors and input-validation failures.

| Tool | What it does |
|---|---|
| `ledger_overview` | Shows rows, bar and recorded date ranges, and per-engine summaries. It also gives counts by source, timeframe, asset class, direction and strength, plus warm (≥ 300), full-window (≥ 1000), cold, underlying-closed and suppressed counts. Per-file read status covers bad lines and duplicates. |
| `query_ledger` | Filters by engine id, source, timeframe, pair, asset class, direction, strength, score, warm-up, live/replay and date range. Returns newest first, 50 rows by default and at most 500. `full: true` returns raw rows. |
| `performance_report` | Runs `buildReport` / `measureOutcome` from `apps/confluence/web/src/lib/ledger-metrics.ts`, imported directly rather than copied, against the candle cache. Results are given per **engine id × source × timeframe × asset class**, and engines are never pooled. Each horizon reports hit rate vs base with a Wilson interval, mean net and edge after costs with a bootstrap interval, PF, t, calibration, rank IC, PSR and DSR. It also covers the momentum and shuffled-label benchmarks, the app's indicative gate and **BTC-excess** figures when a BTC series is cached. The BTC-excess figures are mean excess net and hit rate with a Wilson interval per side, plus a **beta-residual rank IC**. `trials` defaults to the number of hypotheses in `trials.jsonl`. Costs default to the app's `DEFAULT_COSTS` and can be overridden. |
| `latest_signals` | Shows the newest recorded bar per engine × source × timeframe, strong signals first. NEUTRAL rows are hidden by default. |
| `recorder_health` | Reports heartbeat age and status: stale after 3 × its `intervalMs`, or 30 min by default. It also shows the last errors and the newest ledger, rankings and derivs records. |
| `log_trial` | Appends `{id, at, hypothesis, config, metric, decision, ref?}` to `trials.jsonl`. The server sets `id` and `at`. Unknown fields are rejected, and so are control characters and a config over 4 KB. A later verdict is a **new** entry with `ref` set to the earlier id. This is the only write. |
| `list_trials` | Lists the register newest first, with counts by decision and the hypothesis count used for the DSR. |

Why a beta-residual IC: within one cross-section, subtracting BTC's return from every pair shifts all returns by the same amount, so the ranks do not change. A plain BTC-excess rank IC therefore equals the raw IC. The informative version ranks score against `gross − β × BTC gross`. β is taken from the recorded `beta` field, which v2.3 rows carry. Otherwise it is a rolling 100-bar beta from cached candles up to the signal bar, so there is no look-ahead.

## Register with Claude Desktop
Edit `claude_desktop_config.json` and restart Claude Desktop. You can open the file from Settings → Developer → Edit Config.
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Use **absolute paths**, because Desktop does not use your shell's `PATH`. Find node with `which node`, or `where node` on Windows.

```json
{
  "mcpServers": {
    "rsl-confluence": {
      "command": "/usr/local/bin/node",
      "args": [
        "/Users/you/rsl-confluence/apps/confluence/mcp/src/cli.mjs",
        "--data", "/Users/you/rsl-confluence-data"
      ]
    }
  }
}
```

Hardened variant: Node's permission model restricts the process further. Reads are limited to the repo and the data folder, and writes to the one register file. Child processes, workers and native add-ons are blocked. `test/protocol.test.mjs` runs exactly this.

```json
{
  "mcpServers": {
    "rsl-confluence": {
      "command": "/usr/local/bin/node",
      "args": [
        "--permission",
        "--allow-fs-read=/Users/you/rsl-confluence",
        "--allow-fs-read=/Users/you/rsl-confluence-data",
        "--allow-fs-write=/Users/you/rsl-confluence-data/trials.jsonl",
        "/Users/you/rsl-confluence/apps/confluence/mcp/src/cli.mjs",
        "--data", "/Users/you/rsl-confluence-data"
      ]
    }
  }
}
```

In Node 22, the permission model does not restrict sockets. The network boundary rests on two things: the server never imports or uses a network module, which `test/guards.test.mjs` enforces, and `fetch` and `WebSocket` are disabled at start-up.

## Register with Claude Code
```
claude mcp add --scope user --transport stdio rsl-confluence -- \
  node /home/you/rsl-confluence/apps/confluence/mcp/src/cli.mjs --data /home/you/rsl-confluence-data

# or pass the folder through the environment (put another option between --env and the name)
claude mcp add --env CONFLUENCE_DATA_DIR=/home/you/rsl-confluence-data --transport stdio rsl-confluence -- \
  node /home/you/rsl-confluence/apps/confluence/mcp/src/cli.mjs

claude mcp list                 # expect: rsl-confluence … ✔ Connected
claude mcp get rsl-confluence
```
Choose a scope:
- `--scope local` (the default): this project only, stored in `~/.claude.json`
- `--scope project`: written to `.mcp.json`, shared through git. Do not commit personal paths.
- `--scope user`: all projects

Inside a session, `/mcp` shows the server and its seven tools.

Try it without real data:
```
node apps/confluence/mcp/test-support/fixture.mjs /tmp/conf-demo
node apps/confluence/mcp/src/cli.mjs --data /tmp/conf-demo   # waits for JSON-RPC on stdin; Ctrl-C to stop
```

## Weekly review — prompt template for Claude
Paste this into a session with the server connected. Fill in the brackets.

```
You are my read-only ledger analyst for the rsL Confluence Terminal. You cannot trade and must not suggest
order sizes or entries. Pre-registered primary test: engine [6dbcfdc424942e02], source [binance], 4h, crypto,
h = 6, beta-residual BTC-excess rank IC, decision date [2027-02-05].

1. recorder_health. If the heartbeat is stale or the newest ledger record is > 2 bars old, stop and report the hole.
2. ledger_overview. Report rows per ENGINE ID and per asset class; note cold (wb < 300), wb < 1000,
   underlying-closed and invalid/duplicate counts. Never combine engine ids.
3. list_trials. Before ANY new analysis, call log_trial with the hypothesis, the exact config
   (engine, source, tf, class, horizon, filters, date range, costs) and the pass metric. Only then run it.
   Exploratory looks count as trials too.
4. performance_report per engine id, by_class true, twice: min_warm_bars 300 (app view) and 1000 (primary).
   For h = 6 (and 1, 24 as context) report, per group:
   n; hit rate WITH its Wilson 95 % interval vs base hit rate; mean net and edge (bp) with the bootstrap interval;
   edge at 2× costs; rank IC t; beta-residual BTC-excess IC (mean, t, periods); BTC-excess mean net per side
   with Wilson interval; PSR and DSR (trials = register count); momentum benchmark edge; shuffled p;
   calibration monotonicity; the gate checks.
5. Say plainly which figures are noise (Wilson interval straddles base, |t| < 2, periods < 30, n < 200).
   Do not call anything an edge unless it beats momentum, survives 2× costs and the decision date has passed.
6. For each hypothesis tested this week, log the verdict as a NEW log_trial entry with ref = its id and
   decision accept / reject / inconclusive. Never reinterpret an earlier trial.
7. End with: data quality issues, figures vs last week, open hypotheses. Analysis only — not financial advice.
```

## Safety notes
- **No write or trade tools, by design.** The tool list is fixed at seven, and a test fails if any tool name suggests orders, transfers, deletes or edits. The only write appends one line to `trials.jsonl` with `O_APPEND`/`O_NOFOLLOW`. It never truncates, rewrites or deletes, and a test checks that every other file in the data folder is byte-for-byte unchanged after all tools have run.
- **No network.** `test/guards.test.mjs` fails if server code, or the reused `ledger-metrics.ts`, imports or uses any of the following:
  - `fetch`, `http`, `https`, `http2`, `net`, `tls`, `dgram`, `dns`, `child_process`, `cluster`, `worker_threads` or `inspector`
  - `require`, or `process.binding`
  - any package other than the SDK's stdio server modules and zod

  At runtime, `fetch`, `WebSocket`, `EventSource` and `XMLHttpRequest` are replaced with functions that throw.
- **Never give Claude an exchange key**, and do not add community exchange MCP servers to the same client. CCXT-style servers can place orders, and one widely forked example allows up to 100× leverage, has no read-only mode and stores keys in plaintext. Any Claude-proposed order would be a Phase G item behind the gateway risk engine, with Claude outside the order path (ADR-0009).
- The ledger and the trials register are personal research data. Keep the data folder off shared or synced drives if you do not want them copied. Each tool response sends ledger rows into your Claude conversation.
- Every number is analysis, not a recommendation. A gate pass is evidence, not proof (`docs/measurement.md`).

Created by rsLozano.
