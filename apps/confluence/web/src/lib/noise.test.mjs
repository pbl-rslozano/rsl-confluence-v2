// Production-path noise regression — v2.8 (WP19).
// Run: npm run test:noise   (node scripts/run-engine-tests.mjs noise.test.mjs)
//
// Pure noise has no edge, so the scoring path the app actually uses
// (`scoreSeries` on a 1,000-bar window) must rarely label it, and the
// historical-analogue engine must abstain on it. Three return models with
// fixed seeds — Gaussian, Student-t(3) (fat tails) and GARCH(1,1) (volatility
// clustering) — on 1h / 4h / 1d bars, exactly 1,000 independent windows per
// cell. Bars are built from the returns with a deterministic intrabar range and
// volume (no extra randomness), so every number below is reproducible.
//
// Bounds (spec WP19): labelled (BULLISH/BEARISH) ≤ 7 %, STRONG ≤ 2 % per cell;
// Pattern ≥ 95 % NONE and 0 HIGH, pooled over 150 windows per cell (1,350).
import { scoreSeries } from "./scan-pipeline.ts";
import { detectHistoricalPattern } from "./pattern-signal.ts";
import { ENGINE_BARS } from "./engine-window.ts";
// v2.8 (WP23): the generators and grid constants live in noise-fixtures.mjs (shared with the WP23 evidence).
import { WINDOWS, BARS, INTERVALS, MODELS, noiseCell } from "./noise-fixtures.mjs";

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log("  ok   - " + name); }
  else { failed++; console.log("  FAIL - " + name + (extra ? "  [" + extra + "]" : "")); }
};

const PATTERN_WINDOWS = 150;

ok(`windows are the production engine window (${ENGINE_BARS} bars)`, ENGINE_BARS === BARS);

const started = performance.now();
const cells = [];
let pN = 0, pNone = 0, pHigh = 0, pModerate = 0, pLow = 0, patternMs = 0;
for (const model of MODELS) for (const iv of INTERVALS) {
  let n = 0, labelled = 0, strong = 0;
  let w = -1;
  // A fresh generator per window: windows are independent draws.
  for (const k of noiseCell(model, iv, WINDOWS)) {
    w++;
    const s = scoreSeries(k, { intervalMs: iv.ms, volumeAvailable: true });
    if (!s.usable || s.confluence.suppressed) continue;
    n++;
    if (s.confluence.master !== "NEUTRAL") labelled++;
    if (s.confluence.strength === "STRONG") strong++;
    if (w < PATTERN_WINDOWS) {
      const t = performance.now();
      const p = detectHistoricalPattern(k, {
        volumeAvailable: true,
        intervalMs: iv.ms,
        currentConfluence: s.confluence,
        currentReversal: s.reversal,
      });
      patternMs += performance.now() - t;
      pN++;
      if (p.direction === "NONE") pNone++;
      if (p.confidence === "HIGH") pHigh++;
      else if (p.confidence === "MODERATE") pModerate++;
      else if (p.confidence === "LOW") pLow++;
    }
  }
  cells.push({ model, tf: iv.tf, n, labelled: labelled / n, strong: strong / n });
}
const seconds = (performance.now() - started) / 1000;

console.log("\n== scoreSeries on noise: share of windows labelled / STRONG ==");
for (const c of cells) {
  const tag = `${c.model.padEnd(5)} ${c.tf.padEnd(2)}`;
  ok(`${tag} ≥ ${WINDOWS * 0.99} scored windows (got ${c.n})`, c.n >= WINDOWS * 0.99);
  ok(`${tag} labelled ≤ 7% (got ${(c.labelled * 100).toFixed(2)}%)`, c.labelled <= 0.07);
  ok(`${tag} STRONG ≤ 2% (got ${(c.strong * 100).toFixed(2)}%)`, c.strong <= 0.02);
}

console.log("\n== Pattern engine abstains on noise (pooled) ==");
ok(`Pattern NONE ≥ 95% (got ${((pNone / pN) * 100).toFixed(2)}% of ${pN}; LOW ${pLow}, MODERATE ${pModerate}, HIGH ${pHigh})`, pNone / pN >= 0.95);
ok(`Pattern never HIGH on noise (got ${pHigh})`, pHigh === 0);

console.log(`\n(noise grid ${seconds.toFixed(1)} s, of which Pattern ${(patternMs / 1000).toFixed(1)} s)`);
console.log("\nNoise regression: " + passed + "/" + (passed + failed) + " passed");
process.exit(failed === 0 ? 0 : 1);
