/**
 * server.mjs — rsL Confluence analyst MCP server (Phase F, "Claude as analyst").
 *
 * Read-only boundary (ADR-0009):
 *   • Tools read the local data directory only. No tool trades, moves funds,
 *     holds credentials or reaches the network.
 *   • The single write is log_trial, which appends one line to trials.jsonl.
 *   • Every tool response, including errors, ends with DISCLAIMER.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LedgerStore } from "./store.mjs";
import { loadMetricsLib, DEFAULT_LIB_PATH } from "./lib-loader.mjs";
import { ledgerOverview, queryLedger, latestSignals, performanceReport, recorderHealth, tidy } from "./analysis.mjs";
import { appendTrial, readTrials, countHypotheses, DECISIONS } from "./trials.mjs";

export const SERVER_NAME = "rsl-confluence-analyst";
export const SERVER_VERSION = "2.3.0";
export const DISCLAIMER = "Analysis only — not financial advice.";
/** Largest tool response text (characters) before rows are trimmed. */
export const MAX_RESPONSE_CHARS = 120_000;

const FALLBACK_WARM = 300; // only used by ledger_overview when the lib cannot load

export const withDisclaimer = (text) => `${String(text).replace(/\s+$/, "")}\n\n${DISCLAIMER}`;

/** Serialise a result, trimming list fields until it fits MAX_RESPONSE_CHARS. */
export function render(result, max = MAX_RESPONSE_CHARS) {
  let text = JSON.stringify(result, null, 1);
  if (text.length <= max) return text;
  const copy = structuredClone(result);
  const lists = [];
  const find = (o, path) => {
    if (Array.isArray(o)) { if (o.length > 1) lists.push({ o, path }); o.forEach((x, i) => find(x, `${path}[${i}]`)); }
    else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) find(v, path ? `${path}.${k}` : k);
  };
  find(copy, "");
  lists.sort((a, b) => b.o.length - a.o.length);
  let trimmed = 0;
  for (let guard = 0; guard < 200 && text.length > max && lists.length; guard++) {
    const target = lists[0];
    const keep = Math.max(1, Math.floor(target.o.length / 2));
    trimmed += target.o.length - keep;
    target.o.length = keep;
    lists.sort((a, b) => b.o.length - a.o.length);
    copy._truncated = { removedItems: trimmed, reason: `response limited to ${max} characters; narrow the filters or lower 'limit'` };
    text = JSON.stringify(copy, null, 1);
  }
  if (text.length > max) text = `${text.slice(0, max)}\n…(truncated)`;
  return text;
}

/** MCP server whose error results also carry the disclaimer (input-validation errors included). */
class AnalystMcpServer extends McpServer {
  // Overrides the SDK's tool-error builder (used for validation and unknown-tool
  // errors). test/protocol.test.mjs pins the behaviour across SDK upgrades.
  createToolError(message) {
    return { content: [{ type: "text", text: withDisclaimer(`Error: ${message}`) }], isError: true };
  }
}

/* ---------------- input schemas (strict: unknown keys are rejected) ---------------- */
const shortStr = z.string().min(1).max(64);
const strOrList = z.union([shortStr, z.array(shortStr).min(1).max(200)]);
const dateArg = z.union([z.string().max(40), z.number().int().nonnegative()]).describe("ISO date/time, YYYY-MM-DD, or epoch ms (UTC)");
const relFile = z.string().min(1).max(512).describe("Optional: one file inside the data directory (relative path), e.g. exports/ledger-binance-4h.csv. Default: ledger/**.jsonl plus exports/**");
const assetClass = z.enum(["crypto", "rwa", "stock", "fx", "commodity", "unknown"]);
const strength = z.enum(["weak", "moderate", "strong"]);

const filterShape = {
  engine_id: strOrList.optional().describe("Engine configId(s), 16 hex"),
  source: strOrList.optional().describe("binance | bybit-spot | bybit-perp | bitget | bitget-perp | okx | okx-perp | coinbase | upbit"),
  timeframe: strOrList.optional().describe("e.g. 4h"),
  pair: strOrList.optional().describe("e.g. BTCUSDT"),
  asset_class: z.union([assetClass, z.array(assetClass).min(1).max(6)]).optional(),
  from: dateArg.optional(),
  to: dateArg.optional().describe("Inclusive; a bare date includes the whole day"),
  live: z.boolean().optional().describe("true = forward-test rows only, false = replay rows only"),
  file: relFile.optional(),
};

const schemas = {
  ledger_overview: z.object({ file: relFile.optional() }).strict(),
  query_ledger: z.object({
    ...filterShape,
    direction: z.enum(["BUY", "SELL", "NEUTRAL", "DIRECTIONAL"]).optional(),
    strength: strength.optional(),
    min_strength: strength.optional(),
    min_score: z.number().min(-100).max(100).optional(),
    max_score: z.number().min(-100).max(100).optional(),
    min_warm_bars: z.number().int().min(0).max(100000).optional(),
    exclude_underlying_closed: z.boolean().optional(),
    order: z.enum(["newest", "oldest"]).optional(),
    limit: z.number().int().min(1).max(500).optional().describe("Rows to return (default 50, max 500)"),
    full: z.boolean().optional().describe("Return raw LedgerRow objects instead of the compact view"),
  }).strict(),
  performance_report: z.object({
    ...filterShape,
    by_class: z.boolean().optional().describe("Split by asset class (default true). false pools classes like the app's 'all' filter; engines are never pooled"),
    horizons: z.array(z.number().int()).min(1).max(5).optional().describe("Subset of 1, 3, 6, 12, 24"),
    min_warm_bars: z.number().int().min(0).max(100000).optional().describe("Default: PRIMARY_WARM_BARS (1000) on the bars the engine saw, as in the app's primary view; 300 = the app's warm view"),
    trials: z.number().int().min(1).max(100000).optional().describe("Trials for the deflated Sharpe; default = hypotheses in trials.jsonl"),
    fee_bps: z.number().min(0).max(500).optional(),
    slippage_bps: z.number().min(0).max(500).optional(),
    funding_bps_per_8h: z.number().min(-100).max(100).optional(),
    benchmark_pair: shortStr.optional().describe("Default: BTCUSDT (then BTCUSDC, BTCUSD …) on the same source and timeframe"),
    shuffles: z.number().int().min(0).max(2000).optional(),
    max_groups: z.number().int().min(1).max(24).optional(),
  }).strict(),
  latest_signals: z.object({
    engine_id: strOrList.optional(), source: strOrList.optional(), timeframe: strOrList.optional(),
    asset_class: filterShape.asset_class, file: relFile.optional(),
    directional_only: z.boolean().optional().describe("Default true: hide NEUTRAL rows"),
    limit: z.number().int().min(1).max(200).optional().describe("Rows per group (default 30)"),
    max_groups: z.number().int().min(1).max(24).optional(),
  }).strict(),
  recorder_health: z.object({ stale_after_minutes: z.number().min(1).max(100000).optional() }).strict(),
  log_trial: z.object({
    hypothesis: z.string().min(10).max(2000).describe("What you expect and why, stated BEFORE looking at the result"),
    config: z.record(z.string().max(64), z.unknown()).optional().describe("Exact test setup: engine id, source, timeframe, class, horizon, filters, date range, costs"),
    metric: z.string().min(2).max(300).describe("Pre-registered metric and threshold, e.g. 'beta-residual rank IC t ≥ 2 at h=6'"),
    decision: z.enum(DECISIONS).optional().describe("Default 'pending'. Record a later verdict as a NEW trial with ref"),
    ref: z.string().max(32).optional().describe("Id of the earlier trial this entry concludes"),
  }).strict(),
  list_trials: z.object({
    limit: z.number().int().min(1).max(500).optional(),
    decision: z.enum(DECISIONS).optional(),
  }).strict(),
};

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/**
 * Build the server.
 * @param {{ dataDir: import("./data-dir.mjs").DataDir, libPath?: string }} opts
 */
export function createServer({ dataDir, libPath = DEFAULT_LIB_PATH }) {
  const store = new LedgerStore(dataDir);
  const server = new AnalystMcpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: "rsL Confluence Terminal — ledger analyst (read-only)" },
    {
      capabilities: { tools: {} },
      instructions: [
        "Read-only analyst for the rsL Confluence Terminal forward-test ledger. No tool can trade, move funds, hold keys or use the network.",
        "Workflow: recorder_health → ledger_overview → log_trial (state the hypothesis and metric BEFORE testing) → performance_report per engine id → list_trials.",
        "Never pool engine ids. Report BTC-excess (beta-residual) IC and Wilson intervals alongside raw figures. Treat any gate pass as evidence, not proof.",
        DISCLAIMER,
      ].join("\n"),
    },
  );

  const tool = (name, title, description, annotations, handler) => {
    server.registerTool(name, { title, description, inputSchema: schemas[name], annotations }, async (args) => {
      try {
        const result = await handler(args ?? {});
        return { content: [{ type: "text", text: withDisclaimer(render(result)) }] };
      } catch (error) {
        return { content: [{ type: "text", text: withDisclaimer(`Error: ${error?.message ?? String(error)}`) }], isError: true };
      }
    });
  };

  const libOrNull = async () => { try { return await loadMetricsLib(libPath); } catch { return null; } };
  const trialsInfo = async () => {
    const { trials, bad } = await readTrials(dataDir);
    return { trials, bad, hypotheses: countHypotheses(trials) };
  };

  tool("ledger_overview", "Ledger overview",
    "Rows, bar/recorded date range, engine ids, sources, timeframes, asset classes, warm/cold/underlying-closed counts and per-file read status.",
    READ_ONLY,
    async (a) => {
      const lib = await libOrNull();
      const load = await store.loadRows({ file: a.file });
      return ledgerOverview(load, { warmMin: lib?.lib.WARM_MIN_BARS ?? FALLBACK_WARM, fullWarm: lib?.features.primaryWarmBars ?? null });
    });

  tool("query_ledger", "Query ledger rows",
    "Filter rows by engine id, source, timeframe, pair, asset class, direction, strength, score and date range. Returns at most 500 rows (default 50), newest first.",
    READ_ONLY,
    async (a) => queryLedger(await store.loadRows({ file: a.file }), a));

  tool("performance_report", "Performance report (per engine id)",
    "The app's statistics (buildReport/measureOutcome from ledger-metrics.ts) per engine id × source × timeframe × asset class, using the recorder's candle cache: hit rate vs base, mean net and edge after costs, profit factor, t, rank IC, PSR/DSR, calibration, benchmarks, the app's indicative gate, and BTC-excess figures (incl. beta-residual IC) when a BTC series is cached. Engines are never pooled.",
    READ_ONLY,
    async (a) => {
      const libInfo = await loadMetricsLib(libPath);
      const load = await store.loadRows({ file: a.file });
      return performanceReport(load, store, libInfo, a, await trialsInfo());
    });

  tool("latest_signals", "Latest signals",
    "Rows of the newest recorded bar per engine × source × timeframe, strong signals first (NEUTRAL hidden by default).",
    READ_ONLY,
    async (a) => latestSignals(await store.loadRows({ file: a.file }), a));

  tool("recorder_health", "Recorder health",
    "Heartbeat age and status, last errors reported by the recorder, and the newest ledger / rankings / derivs records.",
    READ_ONLY,
    async (a) => recorderHealth(dataDir, a));

  tool("log_trial", "Log a trial (append-only)",
    "Append a hypothesis to trials.jsonl BEFORE testing it. Append-only: entries are never edited or deleted; record a verdict as a new entry with ref = the earlier id. The server sets id and timestamp. This is the server's only write.",
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (a) => {
      const record = await appendTrial(dataDir, a);
      const { hypotheses } = await trialsInfo();
      return { logged: record, hypothesesInRegister: hypotheses, note: "Use this count as `trials` for the deflated Sharpe ratio (performance_report does so by default)." };
    });

  tool("list_trials", "List trials",
    "The trials register, newest first, with counts by decision and the hypothesis count used for the deflated Sharpe ratio.",
    READ_ONLY,
    async (a) => {
      const { trials, bad, hypotheses } = await trialsInfo();
      const shown = trials.filter((t) => !a.decision || t.decision === a.decision).reverse().slice(0, a.limit ?? 50);
      const byDecision = {};
      for (const t of trials) byDecision[t.decision] = (byDecision[t.decision] ?? 0) + 1;
      return tidy({ total: trials.length, hypotheses, byDecision, malformedLines: bad, trials: shown });
    });

  return server;
}

export const TOOL_NAMES = Object.keys(schemas);
