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
import { rng } from "./ledger-metrics.ts";
import { detectHistoricalPattern } from "./pattern-signal.ts";
import { ENGINE_BARS } from "./engine-window.ts";

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log("  ok   - " + name); }
  else { failed++; console.log("  FAIL - " + name + (extra ? "  [" + extra + "]" : "")); }
};

const H = 3600e3;
const WINDOWS = 1000;
const PATTERN_WINDOWS = 150;
const BARS = 1000;
const INTERVALS = [
  // Per-bar volatility roughly typical of large-cap crypto at each interval.
  { tf: "1h", ms: H, sigma: 0.008 },
  { tf: "4h", ms: 4 * H, sigma: 0.016 },
  { tf: "1d", ms: 24 * H, sigma: 0.039 },
];
const MODELS = ["gauss", "t3", "garch"];
const SEEDS = { gauss: 1101, t3: 2203, garch: 3307 };
const TF_SEED = { "1h": 11, "4h": 23, "1d": 37 };

function normal(r) {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/** Unit-variance innovations z_t and the conditional per-bar sd σ_t. */
function* innovations(model, r, sigma) {
  if (model === "gauss") for (;;) yield [normal(r), sigma];
  if (model === "t3") {
    // t(3) = Z / sqrt(χ²₃ / 3); variance 3, so divide by √3 for unit variance.
    for (;;) {
      const z = normal(r);
      const chi = normal(r) ** 2 + normal(r) ** 2 + normal(r) ** 2;
      yield [z / Math.sqrt(chi / 3) / Math.sqrt(3), sigma];
    }
  }
  // GARCH(1,1): h_{t+1} = ω + α r_t² + β h_t, unconditional variance σ².
  const alpha = 0.08, beta = 0.9, omega = sigma * sigma * (1 - alpha - beta);
  let h = sigma * sigma;
  for (let i = 0; i < 300; i++) { const e = Math.sqrt(h) * normal(r); h = omega + alpha * e * e + beta * h; } // burn-in
  for (;;) {
    const sd = Math.sqrt(h);
    const z = normal(r);
    const e = sd * z;
    h = omega + alpha * e * e + beta * h;
    yield [z, sd];
  }
}

function klines(gen, n, intervalMs) {
  const out = [];
  let px = 100;
  const t0 = Date.UTC(2025, 0, 1);
  for (let i = 0; i < n; i++) {
    const [z, sd] = gen.next().value;
    const o = px;
    px = o * Math.exp(z * sd);
    // Deterministic intrabar range (half a conditional sd beyond the body) and
    // volume (rises with |z|, carries no sign).
    out.push({
      time: t0 + i * intervalMs,
      open: o,
      high: Math.max(o, px) * (1 + 0.5 * sd),
      low: Math.min(o, px) * (1 - 0.5 * sd),
      close: px,
      volume: 1000 * (1 + Math.abs(z)),
    });
  }
  return out;
}

ok(`windows are the production engine window (${ENGINE_BARS} bars)`, ENGINE_BARS === BARS);

const started = performance.now();
const cells = [];
let pN = 0, pNone = 0, pHigh = 0, pModerate = 0, pLow = 0, patternMs = 0;
for (const model of MODELS) for (const iv of INTERVALS) {
  const r = rng(SEEDS[model] * 100 + TF_SEED[iv.tf]);
  let n = 0, labelled = 0, strong = 0;
  for (let w = 0; w < WINDOWS; w++) {
    // A fresh generator per window: windows are independent draws.
    const k = klines(innovations(model, r, iv.sigma), BARS, iv.ms);
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
