// WP23 evidence — Classic baseline (Task 1); Task 10 adds the `all` part (Classic vs Confluence v2).
// Run: npm run evidence:wp23 -- --out <absolute path> [--part classic]
//      npm run evidence:wp23 -- --part all --baseline <absolute path of the Task 1 JSON> --out <absolute path .json>
//
// Everything here is read-only on the engine: it scores the shared noise grid and two fixed
// series with Classic exactly as the app does, and writes the numbers as JSON. `--part all`
// also scores Confluence v2 on the same rows, checks that Classic's metrics equal the baseline
// (the guard) and writes the PR table next to the JSON (same name, `.md`).
import { writeFileSync, readFileSync, realpathSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { engineConfigId, behaviourFingerprint, fingerprintSeries, ENGINE_VERSION } from "./engine-config.ts";
import { scoreSeries, toLedgerRow, hasUsableVolume } from "./scan-pipeline.ts";
import { measureOutcome, buildReport, costsFor, sanitizeLedgerRow, DEFAULT_HORIZONS } from "./ledger-metrics.ts";
import { H, MODELS, INTERVALS, WINDOWS, noiseCell, measureWalks } from "./noise-fixtures.mjs";
import { scoreV2, v2Compact, v2ConfigId, V2_PARAMS, V2_HYST_BARS, v2ScoreSeries, v2States } from "./confluence-v2.ts";
import { asV2Row, pairedOutcomes, labelChurn, sideOf } from "./head-to-head.ts";

/** Guard limits (Task 10): the Task 3 continuity rule and the Task 5 row-size rule. */
export const CONTINUITY_MIN = 0.99;
export const BYTES_MAX = 64;

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
function seriesRows(series, pair, tf, intervalMs, v2Acc = null) {
  const rows = [];
  let prev = null; // { j, master } of the previous row, for the continuity rule
  for (let j = 299; j < series.length; j++) {
    const win = series.slice(Math.max(0, j - 999), j + 1);
    const s = scoreSeries(win, { intervalMs, volumeAvailable: true });
    if (!s.usable) continue;
    const row = toLedgerRow(win, s, {
      src: "binance", tf, pair, ac: "crypto", intervalMs,
      closeTime: series[j].time + intervalMs, rank: 0, quoteVolume: 0,
      appVersion: "evidence", live: false, recordedAt: series[j].time + intervalMs,
    });
    if (row) {
      if (v2Acc) {
        const r2 = scoreV2(win, { intervalMs, volumeAvailable: true });
        row.v2 = v2Compact(r2, row.t);
        // Task 3 rule: row j-1's label equals the in-window state at j-1 recomputed inside row j's window.
        if (prev && prev.j === j - 1) {
          const from = Math.max(0, win.length - V2_HYST_BARS);
          const st = v2States(v2ScoreSeries(win, { intervalMs, volumeAvailable: hasUsableVolume(win) }, from), from)[win.length - 2];
          const hit = prev.master === st;
          v2Acc.allTotal++; if (hit) v2Acc.allAgree++;
          if (j >= 1000) { v2Acc.total++; if (hit) v2Acc.agree++; } // both windows are full 1,000 bars
        }
        prev = { j, master: r2.master === "BULLISH" ? 1 : r2.master === "BEARISH" ? -1 : 0 };
      }
      rows.push(row);
    }
  }
  return rows;
}

/** One interval group → the brief per horizon, with churn averaged over its series. */
function brief(groupSeries, intervalMs, v2Acc = null) {
  const costs = costsFor("binance", "crypto");
  const costBps = 2 * (costs.feeBps + costs.slipBps);
  const rows = [];
  const perSeries = [];
  for (const { series, pair, tf } of groupSeries) {
    const r = seriesRows(series, pair, tf, intervalMs, v2Acc);
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
  return { brief: shapeBrief(rep), churn: r6(labelChurn(rows, intervalMs).per100), rows, outcomes, costBps };
}

/** A report → the brief (per horizon: scored signals-with-outcomes, groups, IC t, PSR). */
function shapeBrief(rep) {
  const result = {};
  for (const hr of rep.horizons) {
    result[hr.horizon] = {
      scored: hr.scored,
      groups: hr.groups.map((g) => ({ label: g.label, n: g.n, hitRate: r6(g.hitRate), meanNetBps: r6(g.meanNetBps), edgeBps: r6(g.edgeBps) })),
      icT: r6(hr.ic.tStat),
      psr: r6(hr.sharpe.psr),
    };
  }
  return { horizons: DEFAULT_HORIZONS.map((h) => ({ horizon: h, ...result[h] })) };
}

const side6 = (s) => ({ n: s.n, hitRate: r6(s.hitRate), meanNetBps: r6(s.meanNetBps), edgeBps: r6(s.edgeBps), icT: r6(s.icT), psr: r6(s.psr), churnPer100: r6(s.churnPer100) });

/** The two fixed fixtures: one 1h series (the fingerprint series) and eight 4h walks. */
function fixtureGroups() {
  return {
    "1h": { intervalMs: H, group: [{ series: fingerprintSeries(), pair: "FPUSDT", tf: "1h" }] },
    "4h": { intervalMs: 4 * H, group: measureWalks(8, 1600).map((series, i) => ({ series, pair: `W${i}USDT`, tf: "4h" })) },
  };
}

/**
 * K-Dense v2 (18 Nov 2026) A-M4: the ledger rows of one evidence fixture ("1h" or "4h"), every row carrying its v2
 * compact, exactly as `allMetrics` builds them (used by head-to-head.test.mjs to keep the guide's churn statement tested).
 */
export function fixtureRows(key) {
  const fx = fixtureGroups()[key];
  if (!fx) throw new Error(`unknown fixture ${key}`);
  const acc = { agree: 0, total: 0, allAgree: 0, allTotal: 0 };
  const rows = [];
  for (const { series, pair, tf } of fx.group) rows.push(...seriesRows(series, pair, tf, fx.intervalMs, acc));
  return { rows, intervalMs: fx.intervalMs };
}

function classicOf(one, four) {
  return {
    configId: engineConfigId(),
    engineVersion: ENGINE_VERSION,
    fingerprint: behaviourFingerprint(),
    noise: noiseGrid(),
    fixtures: { "1h": one.brief, "4h": four.brief },
    churnPer100: { "1h": one.churn, "4h": four.churn },
  };
}

export function classicMetrics() {
  const f = fixtureGroups();
  return classicOf(brief(f["1h"].group, f["1h"].intervalMs), brief(f["4h"].group, f["4h"].intervalMs));
}

/** v2's noise grid on the production path, the hold-out cells (seed offset 0) that `npm run test:noise-v2` prints. */
function v2NoiseGrid() {
  const out = [];
  for (const model of MODELS) for (const iv of INTERVALS) {
    let n = 0, labelled = 0, strong = 0;
    for (const k of noiseCell(model, iv, WINDOWS)) {
      const r = scoreV2(k, { intervalMs: iv.ms, volumeAvailable: true });
      if (!r.usable || r.suppressed) continue;
      n++;
      if (r.master !== "NEUTRAL") labelled++;
      if (r.strength === "STRONG") strong++;
    }
    out.push({ model, tf: iv.tf, n, labelled: r6(labelled / n), strong: r6(strong / n) });
  }
  return out;
}

/** JSON characters v2 adds to a stored row (Task 5's measure: the sanitised row with and without the key). */
function bytesPerRow(rows) {
  const sizes = [];
  for (const row of rows) {
    if (!row.v2) continue;
    // The sanitiser writes `v2: null` for an absent field, so the key is removed from its output (as Task 5's test does).
    const a = sanitizeLedgerRow(row);
    if (!a) continue;
    const { v2, ...without } = a;
    sizes.push(JSON.stringify(a).length - JSON.stringify(without).length);
  }
  return sizes.length === 0 ? { rows: 0, mean: null, max: null } : { rows: sizes.length, mean: r6(sizes.reduce((x, y) => x + y, 0) / sizes.length), max: Math.max(...sizes) };
}

/** Classic after (v2 attached to every row) + Confluence v2 on the same rows and outcomes. */
export function allMetrics() {
  const f = fixtureGroups();
  const acc = { agree: 0, total: 0, allAgree: 0, allTotal: 0 };
  const one = brief(f["1h"].group, f["1h"].intervalMs, acc);
  const four = brief(f["4h"].group, f["4h"].intervalMs, acc);
  const after = classicOf(one, four);

  const v2 = { fixtures: {}, churn: {} };
  const headToHead = {};
  const allRows = [];
  for (const [key, b, fx] of [["1h", one, f["1h"]], ["4h", four, f["4h"]]]) {
    const paired = pairedOutcomes(b.outcomes, v2ConfigId());
    const withV2 = b.rows.filter((r) => r.v2?.cfg === v2ConfigId());
    const v2Rows = withV2.map(asV2Row);
    const classicRep = buildReport(withV2, paired.classic, b.costBps, 1, fx.intervalMs, { shuffles: 200 });
    const v2Rep = buildReport(v2Rows, paired.v2, b.costBps, 1, fx.intervalMs, { shuffles: 200 });
    const cC = labelChurn(withV2, fx.intervalMs).per100, cV = labelChurn(v2Rows, fx.intervalMs).per100;
    v2.fixtures[key] = shapeBrief(v2Rep);
    v2.churn[key] = r6(cV);
    headToHead[key] = {};
    for (const h of DEFAULT_HORIZONS) headToHead[key][h] = { classic: side6(sideOf(classicRep, h, cC)), v2: side6(sideOf(v2Rep, h, cV)) };
    allRows.push(...withV2);
  }
  return {
    after,
    v2: {
      configId: v2ConfigId(),
      params: V2_PARAMS,
      noiseSet: "hold-out cells (seed offset 0, 1,000 windows per cell): the cells `npm run test:noise-v2` prints",
      noise: v2NoiseGrid(),
      fixtures: v2.fixtures,
      churnPer100: v2.churn,
      continuity: {
        scope: "consecutive rows whose two windows are both full 1,000 bars (the Task 3 rule)",
        agree: acc.agree, total: acc.total, rate: r6(acc.agree / acc.total),
        allRows: { agree: acc.allAgree, total: acc.allTotal, rate: r6(acc.allAgree / acc.allTotal) },
      },
      bytesPerRow: { ...bytesPerRow(allRows), unit: "JSON characters added to a sanitised ledger row" },
    },
    headToHead,
    headToHeadNote: "Pools all fixture rows. There is no in-sample/out-of-sample split, and neither engine was fitted on these fixtures. n is the number of signals (BUY and SELL, measured) at each horizon.",
  };
}

/** Paths at which two JSON values differ (for the guard's message). */
export function diffPaths(a, b, path = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((k) => diffPaths(a[k], b[k], path ? `${path}.${k}` : k));
  }
  return [path || "(root)"];
}

/** Why the run must fail (empty = pass). */
export function guardFailures(ev, differing = []) {
  const f = [];
  if (!ev.classic.unchanged) f.push(`CLASSIC CHANGED (differing keys: ${differing.join(", ") || "unknown"})`);
  if (!(ev.v2.continuity.total > 0)) f.push("V2 CONTINUITY measured no consecutive row pairs (total = 0)");
  else if (!(ev.v2.continuity.rate >= CONTINUITY_MIN)) f.push(`V2 CONTINUITY ${ev.v2.continuity.rate} is below ${CONTINUITY_MIN}`);
  if (!(ev.v2.bytesPerRow.rows > 0)) f.push("V2 BYTES PER ROW measured no rows (none carry v2)");
  else if (!(Number.isFinite(ev.v2.bytesPerRow.max) && ev.v2.bytesPerRow.max <= BYTES_MAX)) f.push(`V2 BYTES PER ROW max ${ev.v2.bytesPerRow.max} is above ${BYTES_MAX}`);
  for (const [iv, hs] of Object.entries(ev.headToHead ?? {})) {
    for (const eng of ["classic", "v2"]) {
      if (!Object.values(hs).some((h) => h[eng] && h[eng].n > 0)) f.push(`HEAD-TO-HEAD ${eng} ${iv} has no signals at any horizon (n = 0)`);
    }
  }
  return f;
}

const pct = (x) => (Number.isFinite(x) ? (100 * x).toFixed(2) + " %" : "n/a");
const num = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const worst = (noise, key) => noise.reduce((w, c) => (c[key] > w[key] ? c : w), noise[0]);

/** Small-sample threshold: an engine x interval with fewer signals than this at the horizon is flagged. */
export const SMALL_N = 30;

/** P(X >= k) for X ~ Binomial(n, 1/2), exactly (integer binomials; no pow/exp). */
export function binomTailHalf(n, k) {
  let c = 1, sum = 0, total = 1;
  for (let i = 1; i <= n; i++) total *= 2;
  for (let i = 0; i <= n; i++) { if (i >= k) sum += c; c = (c * (n - i)) / (i + 1); }
  return sum / total;
}

/** The PR table (Markdown). */
export function renderMarkdown(ev) {
  const b = ev.classic.before, a = ev.classic.after, v = ev.v2;
  const six = (m, key) => { const h = m.fixtures[key].horizons.find((x) => x.horizon === 6); return sideOf({ horizons: [{ horizon: 6, groups: h.groups, ic: { tStat: h.icT ?? NaN }, sharpe: { psr: h.psr ?? NaN } }] }, 6, NaN); };
  const rows = [];
  const add = (name, x, y, z) => rows.push(`| ${name} | ${x} | ${y} | ${z} |`);
  const cell = (c, key) => `${pct(c[key])} (${c.model} ${c.tf})`;
  const hits = (s) => (s.n > 0 && Number.isFinite(s.hitRate) ? ` (${Math.round(s.hitRate * s.n)}/${s.n})` : "");
  const sig = (s) => (s.n < SMALL_N ? `${s.n} (small sample)` : String(s.n));
  const label = { "1h": "1h, one series", "4h": "4h, eight walks" };
  add("Config id", `\`${b.configId}\``, `\`${a.configId}\``, `\`${v.configId}\``);
  add("Worst noise cell, labelled", cell(worst(b.noise, "labelled"), "labelled"), cell(worst(a.noise, "labelled"), "labelled"), cell(worst(v.noise, "labelled"), "labelled"));
  add("Worst noise cell, STRONG", cell(worst(b.noise, "strong"), "strong"), cell(worst(a.noise, "strong"), "strong"), cell(worst(v.noise, "strong"), "strong"));
  for (const key of ["1h", "4h"]) {
    const sb = six(b, key), sa = six(a, key), sv = ev.headToHead[key][6].v2;
    const L = `h = 6, ${label[key]}`;
    add(`${L}: signals`, sig(sb), sig(sa), sig(sv));
    add(`${L}: hit rate`, pct(sb.hitRate) + hits(sb), pct(sa.hitRate) + hits(sa), pct(sv.hitRate) + hits(sv));
    add(`${L}: mean net bp`, num(sb.meanNetBps), num(sa.meanNetBps), num(sv.meanNetBps));
    add(`${L}: edge bp`, num(sb.edgeBps), num(sa.edgeBps), num(sv.edgeBps));
    add(`${L}: IC t`, num(sb.icT), num(sa.icT), num(sv.icT));
    add(`${L}: PSR`, num(sb.psr, 3), num(sa.psr, 3), num(sv.psr, 3));
  }
  for (const key of ["1h", "4h"]) add(`Label changes per 100 bars, ${key}`, num(b.churnPer100[key]), num(a.churnPer100[key]), num(v.churnPer100[key]));
  add("Continuity (consecutive rows agree)", "n/a", "n/a", `${pct(v.continuity.rate)} (${v.continuity.agree}/${v.continuity.total})`);
  add("Bytes added per row (mean / max)", "n/a", "n/a", `${num(v.bytesPerRow.mean, 1)} / ${v.bytesPerRow.max}`);

  // Caution notes, generated from the data: one per interval whose v2 or Classic signal count at h = 6 is below SMALL_N.
  const cautions = [];
  for (const key of ["1h", "4h"]) {
    const sv = ev.headToHead[key][6].v2, sc = six(a, key);
    const small = [["Confluence v2", sv], ["Classic", sc]].filter(([, s]) => s.n < SMALL_N);
    if (!small.length) continue;
    const g = v.fixtures[key].horizons.find((x) => x.horizon === 6).groups;
    const nOf = (l) => g.find((x) => x.label === l)?.n ?? 0;
    let text = `Read the ${key} column${small.length > 1 ? "s" : ""} with caution: at h = 6, ${small.map(([name, s]) => `${name} has ${s.n} signals`).join(" and ")} (below ${SMALL_N}), from ${key === "1h" ? "one 1h series" : "eight 4h walks"}.`;
    if (sv.n < SMALL_N && sv.n > 0 && Number.isFinite(sv.hitRate)) {
      const k = Math.round(sv.hitRate * sv.n);
      text += ` Confluence v2's ${pct(sv.hitRate)} is ${k} of ${sv.n} (${nOf("BUY · all")} BUY, ${nOf("SELL · all")} SELL); ${k} of ${sv.n} or better happens about ${pct(binomTailHalf(sv.n, k))} of the time for a fair coin, and PSR ${num(sv.psr, 3)} is not stable at that size.`;
      const h1 = ev.headToHead[key][1].v2;
      text += ` At h = 1 the same engine has ${h1.n} signals and a ${pct(h1.hitRate)} hit rate.`;
    }
    cautions.push(text);
  }
  const other4 = ev.headToHead["4h"][6].v2;
  cautions.push(`Confluence v2 at 4h (h = 6, ${other4.n} signals) has a ${pct(other4.hitRate)} hit rate and ${num(other4.meanNetBps)} mean net bp. No claim is made from these cells.`);
  return [
    "# Classic before/after and Confluence v2 (WP23)",
    "",
    `Generated ${ev.generated}; Classic baseline at \`${ev.base.slice(0, 7)}\`, this run at \`${ev.head.slice(0, 7)}\`.`,
    `Classic unchanged: **${ev.classic.unchanged}**.`,
    "",
    "| Metric | Classic before | Classic after | Confluence v2 |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "synthetic fixtures (noise-like); not evidence of edge; Classic stays the engine",
    "",
    "Notes",
    "",
    ...cautions.map((c) => `- ${c}`),
    `- h = 6 is one horizon of ${DEFAULT_HORIZONS.length} (${DEFAULT_HORIZONS.join(", ")}); the JSON \`headToHead\` holds all of them. The 1h fixture is a single series; the 4h fixture is eight walks.`,
    `- Cells with fewer than ${SMALL_N} signals at the horizon are marked "small sample".`,
    `- Noise cells: Classic is the shared grid (as in the baseline); Confluence v2 is the ${v.noiseSet}.`,
    "- Signals, hit rate (with hits/signals), mean net bp, edge bp, IC t and PSR are at h = 6, BUY and SELL pooled (weighted by n). Signals is the number of signals with a measured outcome at that horizon.",
    `- ${ev.headToHeadNote}`,
    "- Label changes per 100 bars: Classic after and Confluence v2 use the same rule (`labelChurn`).",
    "- Continuity: scored over consecutive rows whose two windows are both full 1,000 bars. Bytes: JSON characters added to a sanitised ledger row.",
    "- Owner decision 2026-11-18: RSI, Stochastic, Williams %R and MFI are kept on every interval (the spec's ≥ 4h drop was superseded after calibration evidence)",
    "",
  ].join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const get = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const out = get("--out");
  const part = get("--part") ?? "classic";
  const usage = "usage: --out <absolute path> [--part classic] | --part all --baseline <absolute path> --out <absolute path .json>";
  if (!out || !out.startsWith("/")) { console.error(usage); process.exit(2); }
  if (part !== "classic" && part !== "all") { console.error(`unknown part "${part}"\n${usage}`); process.exit(2); }
  const base = execSync("git rev-parse HEAD", { cwd: process.cwd() }).toString().trim();
  if (part === "classic") {
    writeFileSync(out, JSON.stringify({ wp: "WP23", part, base, classic: classicMetrics() }, null, 2) + "\n");
    console.log(`wrote ${out}`);
    return;
  }
  const baselinePath = get("--baseline");
  if (!baselinePath || !baselinePath.startsWith("/") || !out.endsWith(".json")) { console.error(usage); process.exit(2); }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const r = allMetrics();
  const before = baseline.classic;
  const after = JSON.parse(JSON.stringify(r.after)); // the same normalisation the file went through
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  const evidence = {
    wp: "WP23", part, generated: new Date().toISOString().slice(0, 10), base: baseline.base, head: base,
    classic: { before, after, unchanged },
    v2: { configId: r.v2.configId, params: r.v2.params, noiseSet: r.v2.noiseSet, noise: r.v2.noise, fixtures: r.v2.fixtures,
      churnPer100: r.v2.churnPer100, continuity: r.v2.continuity, bytesPerRow: r.v2.bytesPerRow },
    headToHead: r.headToHead, headToHeadNote: r.headToHeadNote,
  };
  const failures = guardFailures(evidence, diffPaths(before, after));
  if (failures.length) { for (const f of failures) console.error(f); process.exit(1); }
  writeFileSync(out, JSON.stringify(evidence, null, 2) + "\n");
  const md = out.replace(/\.json$/, ".md");
  writeFileSync(md, renderMarkdown(evidence));
  console.log(`wrote ${out}\nwrote ${md}`);
}
// Only the entry point runs the CLI, so Task 10 and the tests can import classicMetrics.
// Real paths, so a symlinked entry (macOS tmpdir is under /var -> /private/var) still counts; any failure = not the entry.
function isEntryPoint() {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; }
}
if (isEntryPoint()) main();
