// Confluence v2 noise calibration — v2.8 (WP23 Task 4).
// Run: npm run calibrate:v2 -- --out <absolute path>
//
// Sets V2_GAIN and V2_STRONG_BAND so that v2 labels pure noise as rarely as Classic's targets:
// worst-cell labelled <= 6.0 % and worst-cell STRONG <= 1.5 % (margins under the 7 % / 2 % bounds that
// the hold-out test noise-v2.test.mjs checks on disjoint seeds). The hysteresis (55 / 40) is the spec and
// is never tuned. Calibration set: every model x interval cell, 300 windows, seed offset 50.
//
//   1. means per window once (v2MeanSeries over the hysteresis span);
//   2. gain grid 0.50, 0.55 ... 3.00; label = runHysteresis(scoresFromMeans(means, g));
//   3. V2_GAIN = the largest g whose worst cell has labelled <= 0.060;
//   4. V2_STRONG_BAND = the smallest integer in [56, 100] whose worst cell has STRONG <= 0.015 at V2_GAIN;
//   5. no g, or no band, qualifies -> BLOCKED: the table is still written, exit code 3; nothing is tuned.
import { writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { INTERVALS, MODELS, noiseCell, BARS } from "./noise-fixtures.mjs";
import {
  v2MeanSeries, scoresFromMeans, runHysteresis, v2Strength, V2_HYST_BARS, V2_ENTER, V2_STRONG_BAND,
} from "./confluence-v2.ts";

export const CAL_WINDOWS = 300;
export const CAL_SEED_OFFSET = 50;
export const TARGET_LABELLED = 0.06;
export const TARGET_STRONG = 0.015;
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const masterOf = (s) => (s === 1 ? "BULLISH" : s === -1 ? "BEARISH" : "NEUTRAL");
/** STRONG at an explicit band (v2Strength with lowVolatility false, which only lowers the share). */
const strongAt = (state, score, band) => state !== 0 && score !== null && (state === 1 ? score > 0 : score < 0) && Math.abs(score) >= band;

export function calibrate() {
  const from = BARS - V2_HYST_BARS;
  const cells = [];
  for (const model of MODELS) for (const iv of INTERVALS) {
    const means = [];
    for (const w of noiseCell(model, iv, CAL_WINDOWS, CAL_SEED_OFFSET)) means.push(v2MeanSeries(w, { intervalMs: iv.ms, volumeAvailable: true }, from));
    cells.push({ model, tf: iv.tf, means });
  }
  /** Per cell labelled count and, for each band, STRONG count, at gain g. */
  const evalGain = (g, bands) => cells.map((c) => {
    let labelled = 0;
    const strong = bands.map(() => 0);
    for (const m of c.means) {
      const scores = scoresFromMeans(m, g);
      const st = runHysteresis(scores, from);
      if (st === 0) continue;
      labelled++;
      const last = scores[scores.length - 1];
      bands.forEach((b, i) => { if (strongAt(st, last, b)) strong[i]++; });
    }
    return { labelled: labelled / c.means.length, strong: strong.map((x) => x / c.means.length) };
  });

  const grid = [];
  for (let i = 0; i <= 50; i++) {
    const g = Math.round((0.5 + 0.05 * i) * 100) / 100;
    const e = evalGain(g, [V2_STRONG_BAND]);
    grid.push({ g, worstLabelled: r6(Math.max(...e.map((x) => x.labelled))), worstStrong70: r6(Math.max(...e.map((x) => x.strong[0]))) });
  }
  const qual = grid.filter((r) => r.worstLabelled <= TARGET_LABELLED);
  const result = { grid, chosen: null, cells: [], windows: CAL_WINDOWS, seedOffset: CAL_SEED_OFFSET, status: "BLOCKED", reason: "" };
  if (!qual.length) { result.reason = `no gain in 0.50..3.00 has worst-cell labelled <= ${TARGET_LABELLED}`; return result; }
  const gain = qual[qual.length - 1].g;
  const bands = [];
  for (let b = V2_ENTER + 1; b <= 100; b++) bands.push(b);
  const e = evalGain(gain, bands);
  const bi = bands.findIndex((_b, i) => Math.max(...e.map((x) => x.strong[i])) <= TARGET_STRONG);
  result.cells = cells.map((c, i) => ({ model: c.model, tf: c.tf, labelled: r6(e[i].labelled), strong: bi >= 0 ? r6(e[i].strong[bi]) : null }));
  if (bi < 0) { result.reason = `gain ${gain} qualifies but no STRONG band in 56..100 has worst-cell STRONG <= ${TARGET_STRONG}`; return result; }
  result.chosen = { gain, strongBand: bands[bi] };
  result.status = "OK";
  // Cross-check the inline STRONG rule against the production v2Strength at the provisional band.
  for (const s of [-100, -71, -70, -69, 0, 69, 70, 71, 100]) for (const st of [-1, 0, 1]) {
    if (strongAt(st, s, V2_STRONG_BAND) !== (v2Strength(masterOf(st), s, false, false) === "STRONG")) throw new Error("strongAt differs from v2Strength");
  }
  return result;
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--out");
  const out = i >= 0 ? args[i + 1] : undefined;
  if (!out || !out.startsWith("/")) { console.error("usage: --out <absolute path>"); process.exit(2); }
  const t = performance.now();
  const r = calibrate();
  writeFileSync(out, JSON.stringify(r, null, 2) + "\n");
  console.log("g     worstLabelled  worstStrong@" + V2_STRONG_BAND);
  for (const row of r.grid) console.log(`${row.g.toFixed(2)}  ${(row.worstLabelled * 100).toFixed(2).padStart(6)}%       ${(row.worstStrong70 * 100).toFixed(2).padStart(6)}%`);
  for (const c of r.cells) console.log(`${c.model.padEnd(5)} ${c.tf}  labelled ${(c.labelled * 100).toFixed(2)}%  strong ${c.strong === null ? "-" : (c.strong * 100).toFixed(2) + "%"}`);
  console.log(`(${((performance.now() - t) / 1000).toFixed(1)} s) wrote ${out}`);
  if (r.status !== "OK") { console.log("BLOCKED: " + r.reason); process.exit(3); }
  console.log("chosen: " + JSON.stringify(r.chosen));
}
function isEntryPoint() {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; }
}
if (isEntryPoint()) main();
