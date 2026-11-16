import { readFileSync, statSync } from "node:fs";
/**
 * config.mjs — CLI flags and environment variables (flags win).
 *
 * Secrets (alert tokens) are read from env by alerts.mjs and never appear here,
 * in logs, or on disk.
 */
import { resolve } from "node:path";
import { ASSET_CLASS_FILTERS, DATA_SOURCES, INTERVAL_MS, normalizeScoringProfile } from "./engine.mjs";

export const VERSION = "2.5.1";

export const USAGE = `rsL Confluence recorder ${VERSION} — records the forward-test ledger while the app is closed.

  node --experimental-strip-types --import ./ts-resolve.mjs recorder.mjs [options]

Options (env in brackets):
  --source binance|bybit-spot|bybit-perp|bitget|bitget-perp|okx|okx-perp|coinbase|upbit  [RECORDER_SOURCE]  default binance
  --tf 4h                                         [RECORDER_TF]              default 4h
  --limit 30                                      [RECORDER_LIMIT]           universe size 1–200
  --asset-class crypto|rwa|stock|fx|commodity|all [RECORDER_ASSET_CLASS]     default crypto
  --out ./recorder-data                           [RECORDER_OUT]             output folder
  --once                                          [RECORDER_ONCE=1]          one cycle, then exit (for schedulers)
  --interval-seconds N                            [RECORDER_INTERVAL_SECONDS] fixed cadence (≥ 30) instead of bar closes
  --grace-seconds 20                              [RECORDER_GRACE_SECONDS]   wait after each bar close
  --catch-up-max 48                               [RECORDER_CATCHUP_MAX]     closed bars scored per series after a gap
  --derivs auto|on|off                            [RECORDER_DERIVS]          funding/OI log (auto = bybit-perp only)
  --radar on|off                                  [RECORDER_RADAR]           market-radar context (rad) on rows + <out>/radar log; default off
  --oi-top 10                                     [RECORDER_OI_TOP]          symbols with an open-interest request
  --check-heartbeat                                                          exit 1 (and alert) if the heartbeat is stale
  --profile <file>                                [RECORDER_PROFILE]        exported scoring profile
  --help

Alerts (optional, env only): TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, ALERT_WEBHOOK_URL,
ALERT_COOLDOWN_BARS (6), ALERT_MAX_PER_CYCLE (10).
Analysis only — not financial advice. Never places orders.`;

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue; // `pnpm recorder -- --source …` passes a bare separator through
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const eq = a.indexOf("=");
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[++i];
    } else {
      out[a.slice(2)] = "true";
    }
  }
  return out;
}

const KNOWN = new Set(["source", "tf", "limit", "asset-class", "out", "once", "interval-seconds", "grace-seconds", "catch-up-max", "derivs", "radar", "oi-top", "check-heartbeat", "profile", "help", "h"]);

function int(name, raw, def, lo, hi) {
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`--${name} must be an integer ${lo}–${hi}`);
  return n;
}

const truthy = (v) => v === "true" || v === "1" || v === "yes";

export function parseConfig(argv = process.argv.slice(2), env = process.env, cwd = process.cwd()) {
  const a = parseArgv(argv);
  for (const k of Object.keys(a)) if (!KNOWN.has(k)) throw new Error(`unknown option --${k} (see --help)`);
  const pick = (flag, envName) => a[flag] ?? env[envName];

  const source = pick("source", "RECORDER_SOURCE") ?? "binance";
  if (!DATA_SOURCES.some((s) => s.value === source)) throw new Error(`--source must be one of ${DATA_SOURCES.map((s) => s.value).join(", ")}`);
  const tf = pick("tf", "RECORDER_TF") ?? "4h";
  if (!INTERVAL_MS[tf]) throw new Error(`--tf must be one of ${Object.keys(INTERVAL_MS).join(", ")}`);
  const assetClass = pick("asset-class", "RECORDER_ASSET_CLASS") ?? "crypto";
  if (!ASSET_CLASS_FILTERS.includes(assetClass)) throw new Error(`--asset-class must be one of ${ASSET_CLASS_FILTERS.join(", ")}`);
  const derivs = pick("derivs", "RECORDER_DERIVS") ?? "auto";
  if (!["auto", "on", "off"].includes(derivs)) throw new Error("--derivs must be auto, on or off");
  const radar = pick("radar", "RECORDER_RADAR") ?? "off";
  if (!["on", "off"].includes(radar)) throw new Error("--radar must be on or off");
  const intervalSeconds = int("interval-seconds", pick("interval-seconds", "RECORDER_INTERVAL_SECONDS"), 0, 0, 31 * 86_400);
  if (intervalSeconds > 0 && intervalSeconds < 30) throw new Error("--interval-seconds must be at least 30 (exchange rate limits)");

  const profilePath = pick("profile", "RECORDER_PROFILE");
  let profile = null;
  if (profilePath) {
    const path = resolve(cwd, profilePath);
    if (statSync(path).size > 16_384) throw new Error("Scoring profile is too large.");
    profile = normalizeScoringProfile(JSON.parse(readFileSync(path, "utf8")));
  }
  return {
    help: truthy(a.help) || truthy(a.h),
    source,
    tf,
    limit: int("limit", pick("limit", "RECORDER_LIMIT"), 30, 1, 200),
    assetClass,
    ...(profile ? { profile } : {}),
    // Resolved once against the start-up folder: a scheduled task's working
    // directory is often System32 on Windows, so docs recommend an absolute path.
    outDir: resolve(cwd, pick("out", "RECORDER_OUT") ?? "recorder-data"),
    once: truthy(a.once) || truthy(env.RECORDER_ONCE ?? ""),
    intervalSeconds,
    graceMs: int("grace-seconds", pick("grace-seconds", "RECORDER_GRACE_SECONDS"), 20, 0, 600) * 1000,
    catchUpMax: int("catch-up-max", pick("catch-up-max", "RECORDER_CATCHUP_MAX"), 48, 0, 1000),
    derivs,
    radar: radar === "on",
    oiTop: int("oi-top", pick("oi-top", "RECORDER_OI_TOP"), 10, 0, 50),
    checkHeartbeat: truthy(a["check-heartbeat"]),
  };
}
