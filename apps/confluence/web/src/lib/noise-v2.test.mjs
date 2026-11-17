// Confluence v2 noise regression — v2.8 (WP23 Task 4). Run: npm run test:noise-v2
//
// The calibration (v2-calibration.mjs) draws windows with seed offset 50; this test is the HOLD-OUT on the
// WP19 regression seeds (offset 0, 1,000 windows per cell), through the production path `scoreV2`.
// Bounds (spec WP23): labelled <= 7 %, STRONG <= 2 % per cell. A second test shows that v2 is not simply
// blind: a drifting series (per-bar Sharpe 0.5) is labelled, and almost always BUY.
import { scoreV2 } from "./confluence-v2.ts";
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
  const share = (windows) => {
    let n = 0, lab = 0, buy = 0;
    for (const k of windows) {
      const r = scoreV2(k, { intervalMs: iv.ms, volumeAvailable: true });
      if (!r.usable || r.suppressed) continue;
      n++;
      if (labelledOf(r)) { lab++; if (r.master === "BULLISH") buy++; }
    }
    return { n, lab, buy, share: lab / n };
  };
  const gaussNoise = cells.find((c) => c.model === "gauss" && c.tf === "1h");
  const r = rng(4409);
  const drift = share((function* () { for (let w = 0; w < 100; w++) yield klines(drifted(innovations("gauss", r, 0.008), 0.004), BARS, H); })());
  console.log(`  drift: ${drift.lab}/${drift.n} labelled (${(drift.share * 100).toFixed(1)}%), ${drift.buy} BUY; Gaussian 1h noise ${(gaussNoise.labelled * 100).toFixed(2)}%`);
  ok(`labelled share (${(drift.share * 100).toFixed(1)}%) >= 3 x the Gaussian 1h noise share (${(gaussNoise.labelled * 100).toFixed(2)}%)`, drift.share >= 3 * gaussNoise.labelled);
  ok(`>= 90% of the drift labels are BUY (${drift.buy}/${drift.lab})`, drift.lab > 0 && drift.buy / drift.lab >= 0.9);
}

console.log(`\n(noise grid ${((performance.now() - started) / 1000).toFixed(1)} s)`);
console.log("\nv2 noise regression: " + passed + "/" + (passed + failed) + " passed");
process.exit(failed === 0 ? 0 : 1);
