// Shared noise fixtures — v2.8 (WP23).
// The seeded noise generators of the WP19 noise regression (noise.test.mjs), moved here
// unchanged so the Classic baseline evidence, the Confluence v2 calibration and the
// noise test draw the very same windows. Values and formulas are verbatim.
import { rng } from "./ledger-metrics.ts";

export const H = 3600e3;
export const WINDOWS = 1000;
export const BARS = 1000;
export const INTERVALS = [
  // Per-bar volatility roughly typical of large-cap crypto at each interval.
  { tf: "1h", ms: H, sigma: 0.008 },
  { tf: "4h", ms: 4 * H, sigma: 0.016 },
  { tf: "1d", ms: 24 * H, sigma: 0.039 },
];
export const MODELS = ["gauss", "t3", "garch"];
export const SEEDS = { gauss: 1101, t3: 2203, garch: 3307 };
export const TF_SEED = { "1h": 11, "4h": 23, "1d": 37 };

export function normal(r) {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/** Unit-variance innovations z_t and the conditional per-bar sd σ_t. */
export function* innovations(model, r, sigma) {
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

export function klines(gen, n, intervalMs) {
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

/**
 * One cell of the noise grid: `windows` independent 1,000-bar windows of `model` at
 * interval `iv`. One rng per cell; a fresh generator per window (windows are independent
 * draws). `seedOffset` shifts the stream, so a calibration or hold-out set can be drawn
 * without touching the WP19 stream (offset 0).
 */
export function* noiseCell(model, iv, windows, seedOffset = 0) {
  const r = rng(SEEDS[model] * 100 + TF_SEED[iv.tf] + seedOffset);
  for (let w = 0; w < windows; w++) yield klines(innovations(model, r, iv.sigma), BARS, iv.ms);
}

/**
 * `count` series of `n` bars from measure.test.mjs's `walk` formula (Park–Miller
 * seed * 16807 % 2147483647, exp((rnd − 0.5) · 0.03), high ×1.003, low ×0.997, volume
 * 500 + rnd · 500), drawn one after another from one stream.
 */
export function measureWalks(count, n, seed = 99, step = 4 * H) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const t0 = Date.UTC(2025, 0, 1);
  const all = [];
  for (let c = 0; c < count; c++) {
    const out = []; let px = 100;
    for (let i = 0; i < n; i++) {
      const o = px; px *= Math.exp((rnd() - 0.5) * 0.03);
      out.push({ time: t0 + i * step, open: o, high: Math.max(o, px) * 1.003, low: Math.min(o, px) * 0.997, close: px, volume: 500 + rnd() * 500 });
    }
    all.push(out);
  }
  return all;
}
