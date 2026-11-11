# ADR-0009 — Claude as analyst: local, read-only MCP server

**Status:** Accepted · 31 Oct 2026 · v2.3 (Phase F, L1.5)

## Context
The v2.2 gap report puts Claude's first role at "L1 analyst". In that role Claude reads the forward-test ledger, splits it by engine id and class, and computes what the in-app dialog lacks, such as BTC-excess IC and Wilson intervals. It also logs every hypothesis as a trial before testing it. Doing this from pasted exports is slow and error-prone. Claude may also recompute statistics in ways that differ from the app.

The project's rule on orders also stands: no order route exists until a recorded ledger shows edge net of costs (gateway `server.mjs`, ADR-0003). Community exchange MCP servers can place orders, so they are excluded.

## Decision
1. **A local stdio MCP server** (`apps/confluence/mcp`, `@rsl/confluence-mcp`) is built on the official `@modelcontextprotocol/sdk` (1.32.2, pinned). Claude Desktop or Claude Code spawns it as a child process. No port is opened.
2. **Read-only boundary.** There are seven tools: `ledger_overview`, `query_ledger`, `performance_report`, `latest_signals`, `recorder_health`, `list_trials` and `log_trial`. All are read-only except `log_trial`, which appends one validated line to `<data>/trials.jsonl` and never edits or deletes. There are no order, transfer, key, config or delete tools, and adding one requires a new ADR.
3. **No network, no processes.** Server code may import only Node file and path modules, the SDK's `server/mcp.js` and `server/stdio.js`, and zod. A static test fails on `fetch`, `http(s)`, `net`, `tls`, `dgram`, `dns`, `child_process`, workers or `require`. The web network globals are disabled at start-up. Node's permission model is the documented hardened launch: fs read limited to the repo and data folder, write limited to `trials.jsonl`, and no child processes.
4. **Filesystem confinement.** There is one data directory, set by `--data` or `CONFLUENCE_DATA_DIR`. Caller paths must be relative. They are resolved through `realpath` and must stay inside that directory. Every read is size-limited, and every walk is depth- and count-limited.
5. **One statistics implementation.** The server imports `apps/confluence/web/src/lib/ledger-metrics.ts` (`buildReport`, `measureOutcome`, …) through a module hook that is scoped to that directory and maps extensionless imports to `.ts`. Numbers therefore match the app for the same rows, candles, costs and engine id. Reports are always split per engine id, and engines are never pooled. The DSR trial count defaults to the hypotheses in the register.
6. **Every response ends with "Analysis only — not financial advice."**, errors included.

## Why local stdio
- The ledger, candles and trials stay on the owner's machine. Claude sees only the tool responses it asks for.
- Claude Desktop and Claude Code support local stdio servers. The Messages API MCP connector accepts only public HTTPS servers, which would mean exposing personal data on the internet.
- There is no listener, so there is no CORS, origin, auth or port-collision surface (contrast the gateway, ADR-0003). The process lives only as long as the client session.
- Not built: an HTTP or SSE transport, remote hosting, or tools over the gateway's exchange profiles.

## Consequences
- Claude can run the weekly review in `docs/claude-mcp.md` directly against recorder files. Hypotheses are logged before testing, so the DSR uses a real trial count instead of 1.
- The server depends on the web lib's import shape and on Node ≥ 22.18 type stripping (older 22.x needs a flag). If `ledger-metrics.ts` starts importing a module that performs network I/O, the no-network test fails, which is intended. Keep the statistics module pure.
- Adding the SDK brings 62 transitive packages into `pnpm-lock.yaml`, among them express, hono and cors. They are installed but never loaded, and SBOM and lockfile review cover them. Install scripts stay disabled (`onlyBuiltDependencies` unchanged).
- The candle-cache reader is tolerant because the recorder format is still being finalised. Once it is fixed, the accepted layouts can be narrowed.
- Ledger rows enter Claude conversations, which the owner should treat as sharing that data with the Claude service.
- Moving to L2 (Claude proposing trades) is a separate decision. It requires G1 to pass first, and goes through the gateway risk engine with nonce-bound human approval and Claude outside the order path.
