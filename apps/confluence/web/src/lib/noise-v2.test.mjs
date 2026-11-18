// Confluence v2 noise regression — v2.8 (WP23 Task 4). Run: npm run test:noise-v2
//
// The calibration (v2-calibration.mjs) draws windows with seed offset 50; this test is the HOLD-OUT on the
// WP19 regression seeds (offset 0, 1,000 windows per cell), through the production path `scoreV2`.
// Bounds (spec WP23): labelled <= 7 %, STRONG <= 2 % per cell. A second test shows that v2 is not simply
// blind: a drifting series (per-bar Sharpe 0.5) is labelled, and almost always BUY.
// Rework acceptance (WP23 Task 4 rework, contrarian bloc kept on every interval), in addition:
//   - STRONG is reachable: at least one drift window is STRONG;
//   - drift detection is not worse than the 2026-11-17 calibration: >= 33 of 100 windows labelled, all BUY;
//   - no cliff: on the calibration grid, worst labelled at the next step above V2_GAIN <= 2 x V2_GAIN's worst.
// Measured at gain 0.8 / band 64: drift 81/100 labelled, 81 BUY, 62 STRONG; cliff 6.67 % / 5.00 % = 1.33.
import { scoreV2, V2_GAIN, V2_STRONG_BAND } from "./confluence-v2.ts";
import { calibrate } from "./v2-calibration.mjs";
import { WINDOWS, BARS, H, INTERVALS, MODELS, noiseCell, innovations, klines } from "./noise-fixtures.mjs";
import { rng } from "./ledger-metrics.ts";

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log("  ok   - " + name); }
  else { failed++; console.log("  FAIL - " + name + (extra ? "  [" + extra + "]" : "")); }
};
const labelledOf = (r) => !r.suppressed && r.master !== "NEUTRAL";

const started = performance.now();
const cells = [];
for (const model of MODELS) for (const iv of INTERVALS) {
  let n = 0, labelled = 0, strong = 0;
  for (const k of noiseCell(model, iv, WINDOWS)) {
    const r = scoreV2(k, { intervalMs: iv.ms, volumeAvailable: true });
    if (!r.usable || r.suppressed) continue;
    n++;
    if (r.master !== "NEUTRAL") labelled++;
    if (r.strength === "STRONG") strong++;
  }
  cells.push({ model, tf: iv.tf, n, labelled: labelled / n, strong: strong / n });
}

console.log("\n== scoreV2 on noise (hold-out, seed offset 0): share of windows labelled / STRONG ==");
for (const c of cells) {
  const tag = `${c.model.padEnd(5)} ${c.tf.padEnd(2)}`;
  ok(`${tag} >= ${WINDOWS * 0.99} scored windows (got ${c.n})`, c.n >= WINDOWS * 0.99);
  ok(`${tag} labelled <= 7% (got ${(c.labelled * 100).toFixed(2)}%)`, c.labelled <= 0.07);
  ok(`${tag} STRONG <= 2% (got ${(c.strong * 100).toFixed(2)}%)`, c.strong <= 0.02);
}

console.log("\n== Drift is still detected ==");
{
  function* drifted(gen, mu) { for (const [z, sd] of gen) yield [z + mu / sd, sd]; }
  const iv = INTERVALS[0];
  let strong = 0; // STRONG drift windows, counted by share()
  const share = (windows) => {
    let n = 0, lab = 0, buy = 0;
    for (const k of windows) {
      const r = scoreV2(k, { intervalMs: iv.ms, volumeAvailable: true });
      if (!r.usable || r.suppressed) continue;
      n++;
      if (labelledOf(r)) { lab++; if (r.master === "BULLISH") buy++; if (r.strength === "STRONG") strong++; }
    }
    return { n, lab, buy, share: lab / n };
  };
  const gaussNoise = cells.find((c) => c.model === "gauss" && c.tf === "1h");
  const r = rng(4409);
  const drift = share((function* () { for (let w = 0; w < 100; w++) yield klines(drifted(innovations("gauss", r, 0.008), 0.004), BARS, H); })());
  console.log(`  drift: ${drift.lab}/${drift.n} labelled (${(drift.share * 100).toFixed(1)}%), ${drift.buy} BUY; Gaussian 1h noise ${(gaussNoise.labelled * 100).toFixed(2)}%`);
  ok(`labelled share (${(drift.share * 100).toFixed(1)}%) >= 3 x the Gaussian 1h noise share (${(gaussNoise.labelled * 100).toFixed(2)}%)`, drift.share >= 3 * gaussNoise.labelled);
  ok(`>= 90% of the drift labels are BUY (${drift.buy}/${drift.lab})`, drift.lab > 0 && drift.buy / drift.lab >= 0.9);
  console.log(`  drift STRONG: ${strong}/${drift.n}`);
  ok(`STRONG is reachable: >= 1 drift window is STRONG (got ${strong})`, strong >= 1);
  ok(`drift not worse than before: >= 33/100 labelled, all BUY (got ${drift.lab} labelled, ${drift.buy} BUY)`,
    drift.lab >= 33 && drift.buy === drift.lab);
}

console.log("\n== No cliff on the calibration grid (v2-calibration.mjs, seed offset 50) ==");
{
  const cal = calibrate();
  const i = cal.grid.findIndex((r) => r.g === V2_GAIN);
  const at = cal.grid[i], next = cal.grid[i + 1];
  const ratio = next.worstLabelled / at.worstLabelled;
  console.log(`  g ${at.g}: worst ${(at.worstLabelled * 100).toFixed(2)}%; next g ${next.g}: worst ${(next.worstLabelled * 100).toFixed(2)}%; ratio ${ratio.toFixed(3)}`);
  ok(`the calibration still chooses V2_GAIN ${V2_GAIN} and V2_STRONG_BAND ${V2_STRONG_BAND} (got ${JSON.stringify(cal.chosen)})`,
    cal.status === "OK" && cal.chosen.gain === V2_GAIN && cal.chosen.strongBand === V2_STRONG_BAND);
  ok(`no cliff: next-step worst labelled <= 2 x the chosen gain's (ratio ${ratio.toFixed(3)})`,
    i >= 0 && next !== undefined && at.worstLabelled > 0 && next.worstLabelled <= 2 * at.worstLabelled);
}

console.log(`\n(noise grid ${((performance.now() - started) / 1000).toFixed(1)} s)`);
console.log("\nv2 noise regression: " + passed + "/" + (passed + failed) + " passed");
process.exit(failed === 0 ? 0 : 1);
