// WP23 evidence — Classic baseline (Task 1); Task 10 adds the `all` part (Classic vs Confluence v2).
// Run: npm run evidence:wp23 -- --out <absolute path> [--part classic|all]
//
// Everything here is read-only on the engine: it scores the shared noise grid and two fixed
// series with Classic exactly as the app does, and writes the numbers as JSON.
import { writeFileSync, realpathSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { engineConfigId, behaviourFingerprint, fingerprintSeries, ENGINE_VERSION } from "./engine-config.ts";
import { scoreSeries, toLedgerRow } from "./scan-pipeline.ts";
import { measureOutcome, buildReport, costsFor, DEFAULT_HORIZONS } from "./ledger-metrics.ts";
import { H, MODELS, INTERVALS, WINDOWS, noiseCell, measureWalks } from "./noise-fixtures.mjs";

/** Numbers to 6 significant digits; non-finite values become null (JSON has no NaN). */
const r6 = (x) => (typeof x === "number" && Number.isFinite(x) ? Number(x.toPrecision(6)) : null);

/** Classic's noise grid: the share of scored windows labelled / STRONG per cell (the noise test's loop). */
function noiseGrid() {
  const out = [];
  for (const model of MODELS) for (const iv of INTERVALS) {
    let n = 0, labelled = 0, strong = 0;
    for (const k of noiseCell(model, iv, WINDOWS)) {
      const s = scoreSeries(k, { intervalMs: iv.ms, volumeAvailable: true });
      if (!s.usable || s.confluence.suppressed) continue;
      n++;
      if (s.confluence.master !== "NEUTRAL") labelled++;
      if (s.confluence.strength === "STRONG") strong++;
    }
    out.push({ model, tf: iv.tf, n, labelled: r6(labelled / n), strong: r6(strong / n) });
  }
  return out;
}

/** Every bar j ≥ 299 of a series, scored on its trailing 1,000 bars, as a ledger row. */
function seriesRows(series, pair, tf, intervalMs) {
  const rows = [];
  for (let j = 299; j < series.length; j++) {
    const win = series.slice(Math.max(0, j - 999), j + 1);
    const s = scoreSeries(win, { intervalMs, volumeAvailable: true });
    if (!s.usable) continue;
    const row = toLedgerRow(win, s, {
      src: "binance", tf, pair, ac: "crypto", intervalMs,
      closeTime: series[j].time + intervalMs, rank: 0, quoteVolume: 0,
      appVersion: "evidence", live: false, recordedAt: series[j].time + intervalMs,
    });
    if (row) rows.push(row);
  }
  return rows;
}

/** Share (per cent) of consecutive rows (Δt = one interval) whose label differs. Task 9's labelChurn replaces this. */
function churn(rows, intervalMs) {
  let pairs = 0, flips = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].t - rows[i - 1].t !== intervalMs) continue;
    pairs++;
    if (rows[i].m !== rows[i - 1].m) flips++;
  }
  return pairs ? (flips / pairs) * 100 : 0;
}

/** One interval group → the brief per horizon, with churn averaged over its series. */
function brief(groupSeries, intervalMs) {
  const costs = costsFor("binance", "crypto");
  const costBps = 2 * (costs.feeBps + costs.slipBps);
  const rows = [];
  const perSeries = [];
  for (const { series, pair, tf } of groupSeries) {
    const r = seriesRows(series, pair, tf, intervalMs);
    perSeries.push(r);
    rows.push(...r);
  }
  const outcomes = new Map();
  for (const h of DEFAULT_HORIZONS) {
    const list = [];
    for (let g = 0; g < groupSeries.length; g++) {
      for (const row of perSeries[g]) {
        const o = measureOutcome(row, groupSeries[g].series, h, costs, intervalMs);
        if (o) list.push(o);
      }
    }
    outcomes.set(h, list);
  }
  const rep = buildReport(rows, outcomes, costBps, 1, intervalMs, { shuffles: 200 });
  const result = {};
  for (const hr of rep.horizons) {
    result[hr.horizon] = {
      scored: hr.scored,
      groups: hr.groups.map((g) => ({ label: g.label, n: g.n, hitRate: r6(g.hitRate), meanNetBps: r6(g.meanNetBps), edgeBps: r6(g.edgeBps) })),
      icT: r6(hr.ic.tStat),
      psr: r6(hr.sharpe.psr),
    };
  }
  const churnAvg = perSeries.reduce((a, r) => a + churn(r, intervalMs), 0) / perSeries.length;
  return { brief: { horizons: DEFAULT_HORIZONS.map((h) => ({ horizon: h, ...result[h] })) }, churn: r6(churnAvg) };
}

export function classicMetrics() {
  const one = brief([{ series: fingerprintSeries(), pair: "FPUSDT", tf: "1h" }], H);
  const walks = measureWalks(8, 1600);
  const four = brief(walks.map((series, i) => ({ series, pair: `W${i}USDT`, tf: "4h" })), 4 * H);
  return {
    configId: engineConfigId(),
    engineVersion: ENGINE_VERSION,
    fingerprint: behaviourFingerprint(),
    noise: noiseGrid(),
    fixtures: { "1h": one.brief, "4h": four.brief },
    churnPer100: { "1h": one.churn, "4h": four.churn },
  };
}

function main() {
  const args = process.argv.slice(2);
  const get = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const out = get("--out");
  const part = get("--part") ?? "classic";
  if (!out || !out.startsWith("/")) { console.error("usage: --out <absolute path> [--part classic|all]"); process.exit(2); }
  if (part !== "classic") { console.error(`part "${part}" is not available yet (added in WP23 Task 10)`); process.exit(2); }
  const base = execSync("git rev-parse HEAD", { cwd: process.cwd() }).toString().trim();
  const evidence = { wp: "WP23", part, base, classic: classicMetrics() };
  writeFileSync(out, JSON.stringify(evidence, null, 2) + "\n");
  console.log(`wrote ${out}`);
}
// Only the entry point runs the CLI, so Task 10 and the tests can import classicMetrics.
// Real paths, so a symlinked entry (macOS tmpdir is under /var -> /private/var) still counts; any failure = not the entry.
function isEntryPoint() {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; }
}
if (isEntryPoint()) main();
