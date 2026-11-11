#!/usr/bin/env node
/**
 * cli.mjs — start the read-only analyst MCP server on stdio.
 *
 *   node apps/confluence/mcp/src/cli.mjs --data /path/to/recorder-data
 *   CONFLUENCE_DATA_DIR=/path/to/recorder-data node apps/confluence/mcp/src/cli.mjs
 *
 * Options
 *   --data <dir>          data directory (or CONFLUENCE_DATA_DIR)
 *   --lib <file>          ledger-metrics.ts to use (default: ../web/src/lib/ledger-metrics.ts)
 *   --max-file-mb <n>     largest JSONL/CSV streamed (default 512)
 *   --max-json-mb <n>     largest JSON document parsed (default 64)
 *   --max-rows <n>        most ledger rows held in memory (default 3,000,000)
 *
 * stdout carries only MCP JSON-RPC; diagnostics go to stderr.
 */
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { installNetworkGuard } from "./no-network.mjs";
import { DataDir } from "./data-dir.mjs";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.mjs";
import { DEFAULT_LIB_PATH } from "./lib-loader.mjs";

export function parseArgs(argv, env = process.env) {
  const out = { data: env.CONFLUENCE_DATA_DIR, lib: env.CONFLUENCE_LEDGER_LIB || DEFAULT_LIB_PATH, limits: {} };
  const MB = 1024 * 1024;
  const num = (flag, v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} needs a positive number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const value = () => inline ?? argv[++i];
    switch (flag) {
      case "--data": out.data = value(); break;
      case "--lib": out.lib = value(); break;
      case "--max-file-mb": out.limits.maxStreamBytes = num(flag, value()) * MB; break;
      case "--max-json-mb": out.limits.maxJsonBytes = num(flag, value()) * MB; break;
      case "--max-rows": out.limits.maxRows = Math.floor(num(flag, value())); break;
      case "--help": case "-h": out.help = true; break;
      case "--version": out.version = true; break;
      default: throw new Error(`Unknown option: ${a}`);
    }
  }
  return out;
}

async function main() {
  // Block the web-platform network globals before any tool can run.
  installNetworkGuard();
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); }
  if (args.help) { process.stderr.write("Usage: rsl-confluence-mcp --data <dir> [--lib <ledger-metrics.ts>] [--max-file-mb N] [--max-json-mb N] [--max-rows N]\n"); return; }
  if (args.version) { process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION}\n`); return; }
  let dataDir;
  try { dataDir = new DataDir(args.data, args.limits); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); }
  const server = createServer({ dataDir, libPath: args.lib });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} ready (read-only; data dir set)\n`);
  const stop = async () => { try { await server.close(); } finally { process.exit(0); } };
  process.stdin.on("end", stop);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

// Run only when executed directly (tests import parseArgs).
const self = fileURLToPath(import.meta.url);
let invoked = "";
try { invoked = process.argv[1] ? realpathSync(process.argv[1]) : ""; } catch { /* ignore */ }
if (invoked === self) main().catch((e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); });
