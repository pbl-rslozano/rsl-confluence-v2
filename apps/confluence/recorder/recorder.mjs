#!/usr/bin/env node
/**
 * recorder.mjs — rsL Confluence headless recorder (Phase C) with alerts (Phase F).
 *
 *   node --experimental-strip-types --import ./ts-resolve.mjs recorder.mjs --source binance --tf 4h --limit 30
 *
 * Records the forward-test ledger while the app is closed, with exactly the
 * app's scoring code (see src/engine.mjs). Read-only market data; never places
 * orders. Analysis only — not financial advice. See docs/recorder.md.
 *
 * Exit codes: 0 ok · 1 cycle failed (--once) or heartbeat stale (--check-heartbeat)
 *             2 bad options / cannot start · 130 interrupted twice
 */
import { parseConfig, USAGE } from "./src/config.mjs";
import { createRecorder, readHeartbeatStatus } from "./src/recorder-core.mjs";

let config;
try {
  config = parseConfig();
} catch (error) {
  console.error(`recorder: ${error instanceof Error ? error.message : error}\n\n${USAGE}`);
  process.exit(2);
}
if (config.help) {
  console.log(USAGE);
  process.exit(0);
}

/* --check-heartbeat: dead-man watchdog for a second scheduled task (no lock, no market requests). */
if (config.checkHeartbeat) {
  const status = readHeartbeatStatus(config.outDir);
  const minutes = Number.isFinite(status.staleForMs) ? Math.round(status.staleForMs / 60_000) : null;
  if (!status.stale) {
    console.log(`heartbeat ok: last success ${minutes} min ago (${config.outDir})`);
    process.exit(0);
  }
  console.log(status.exists ? `heartbeat STALE: last success ${minutes ?? "never"} min ago` : `no heartbeat in ${config.outDir}`);
  // Alert through the recorder's alerter (same dedupe state: one alert per outage).
  const rec = createRecorder({ ...config, ...(status.hb ? { source: status.hb.src, tf: status.hb.tf, assetClass: status.hb.ac } : {}) });
  const restore = rec.installFetch();
  try {
    if (rec.alerter.deadman({ lastSuccessAt: status.hb?.lastSuccessAt ?? 0, staleForMs: status.staleForMs, detail: "Reported by --check-heartbeat." })) await rec.alerter.flush();
  } finally {
    restore();
  }
  process.exit(1);
}

const { acquireLock } = await import("./src/store.mjs");
let releaseLock;
let recorder;
try {
  releaseLock = acquireLock(config.outDir);
  recorder = createRecorder(config);
} catch (error) {
  console.error(`recorder: ${error instanceof Error ? error.message : error}`);
  releaseLock?.();
  process.exit(2);
}

const controller = new AbortController();
let stopping = false;
const stop = (sig) => {
  if (stopping) {
    console.error(`recorder: second ${sig}, exiting now`);
    releaseLock?.();
    process.exit(130);
  }
  stopping = true;
  recorder.log(`${sig} received: finishing the current step and stopping`);
  controller.abort();
};
// SIGBREAK = Ctrl+Break in a Windows console; SIGTERM is what launchd and systemd send.
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(sig, () => stop(sig));

recorder.log(`recorder ${recorder.heartbeat.version} · engine ${recorder.cfg} · ${config.source} ${config.tf} · ${config.assetClass} top ${config.limit} · out ${config.outDir}${recorder.alerter.enabled ? ` · alerts: ${recorder.alerter.channels.join("+")}` : ""}`);
let exitCode = 0;
try {
  const last = await recorder.run(controller.signal, { once: config.once });
  if (config.once && !last.ok) exitCode = 1;
} catch (error) {
  recorder.log(`fatal: ${error instanceof Error ? error.stack ?? error.message : error}`);
  exitCode = 2;
} finally {
  releaseLock?.();
}
process.exitCode = exitCode;
