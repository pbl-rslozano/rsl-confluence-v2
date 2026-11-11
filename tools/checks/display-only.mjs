#!/usr/bin/env node
/**
 * display-only.mjs — release check R21 (v2.7, plan WP13.2, ADR-0015).
 *
 *   1. src/lib/fx-rates.ts (display-currency rates) is never imported by the scoring engine, the
 *      scan pipeline, the market-data layer, the ledger, paper trading, the risk engine, the scan
 *      record/enrichment, or the Node recorder and MCP server. Rates change what is SHOWN only.
 *   2. Every URL in fx-rates.ts is on a host of the public-host table (CSP_HOSTS), so R8 covers it.
 *
 *   node tools/checks/display-only.mjs     exit 0 = ok
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIB = "apps/confluence/web/src/lib";
/** Modules that compute, record or trade — none may see an FX rate. */
export const BOUNDARY = [
  "indicators.ts", "engine-config.ts", "engine-window.ts", "scan-pipeline.ts", "scan-jobs.ts", "scan.worker.ts", "scan-runner.ts",
  "market-client.ts", "coinsph.ts", "signal-ledger.ts", "ledger-metrics.ts", "paper-broker.ts", "paper-store.ts", "replay-paper.ts",
  "risk-engine.ts", "scan-record.ts", "enrichment.ts", "pattern-signal.ts", "reversal.ts", "fvg.ts", "report.worker.ts",
].map((f) => `${LIB}/${f}`);
const NODE_APPS = ["apps/confluence/recorder", "apps/confluence/mcp"];

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p); else yield p;
  }
}

export function checkDisplayOnly(root = ROOT) {
  const findings = [];
  const imports = (text) => /from\s+["'][^"']*fx-rates(\.ts)?["']|import\(\s*["'][^"']*fx-rates/.test(text);
  let scanned = 0;
  for (const f of BOUNDARY) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    scanned++;
    if (imports(readFileSync(p, "utf8"))) findings.push(`${f} imports fx-rates`);
  }
  for (const app of NODE_APPS) {
    const dir = join(root, app);
    if (!existsSync(dir)) continue;
    for (const p of walk(dir)) {
      if (!/\.(m?js|ts)$/.test(p)) continue;
      scanned++;
      if (imports(readFileSync(p, "utf8"))) findings.push(`${relative(root, p).split(sep).join("/")} imports fx-rates`);
    }
  }
  const fx = join(root, LIB, "fx-rates.ts");
  const hosts = readFileSync(join(root, LIB, "public-hosts.ts"), "utf8");
  const table = new Set([...((hosts.match(/export const CSP_HOSTS = \[([\s\S]*?)\] as const;/) || [, ""])[1]).matchAll(/origin:\s*"([^"]+)"/g)].map((m) => m[1]));
  if (!existsSync(fx)) findings.push("fx-rates.ts missing");
  else {
    const urls = [...readFileSync(fx, "utf8").matchAll(/"(https:\/\/[^"]+)"/g)].map((m) => m[1]);
    for (const u of urls) if (!table.has(new URL(u).origin)) findings.push(`fx-rates.ts reaches ${new URL(u).origin}, not in CSP_HOSTS`);
    if (!urls.length) findings.push("fx-rates.ts names no source URL");
  }
  return { ok: findings.length === 0, findings, summary: `${scanned} boundary files clean · FX hosts in the table` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const r = checkDisplayOnly();
  console.log(r.ok ? `R21 ok — ${r.summary}` : `R21 FAIL\n  ${r.findings.join("\n  ")}`);
  process.exit(r.ok ? 0 : 1);
}
