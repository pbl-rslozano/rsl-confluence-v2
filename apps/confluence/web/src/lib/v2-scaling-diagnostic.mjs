// Confluence v2 input-scaling diagnostic — v2.8 (WP23 Task 4 rework).
// Run (from apps/confluence/web): node scripts/run-engine-tests.mjs v2-scaling-diagnostic.mjs --out <absolute path>
//
// Read-only on the engine. On the calibration noise set (every model x interval cell, 300 windows, seed
// offset 50, the hysteresis span of each window: the last V2_HYST_BARS bars) it measures, per input and per
// interval, the distribution of z under every divisor option the spec allows ("/ ATR(14) or its own rolling
// sigma"; Bollinger and Keltner also keep their band half-width): the share of |z| >= 0.999 (at the clip)
// and the median |z|. For each candidate divisor table it reports the distribution of the combined bloc mean
// per interval, the per-bloc median |bloc score|, the calibration gain grid (the pinned Task 4 algorithm),
// the next-step cliff ratio and the drift fixture of noise-v2.test.mjs.
//
// The aggregation (bloc means, the efficiency-ratio gate, the validity floor) is re-stated here so that any
// table can be evaluated without editing the engine; a self-check requires the live table's means to equal
// v2MeanSeries bit for bit.
import { writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { INTERVALS, MODELS, noiseCell, innovations, klines, BARS, H } from "./noise-fixtures.mjs";
import { rng } from "./ledger-metrics.ts";
import {
  MIN_VALID_VOTING_SHARE, ER_PERIOD, ER_GATE_LOW, ER_GATE_HIGH, LOW_VOLATILITY_PERCENTILE, indATR,
} from "./indicators.ts";
import { V2_INPUTS, V2_DIVISOR_FLOOR, SCALE_KIND, v2InputSeries, rollingSigmaAt } from "./confluence-v2-inputs.ts";
import { v2MeanSeries, V2_HYST_BARS, V2_ENTER, V2_EXIT } from "./confluence-v2.ts";

export const DIAG_WINDOWS = 300;
export const DIAG_SEED_OFFSET = 50;
const CLIP_AT = 0.999;
const BINS = 10_000; // |z| and |mean| lie in [0, 1]: medians/quantiles to 1e-4
const BLOCS = ["trend", "meanReversion", "breakout", "flow"];
const GRID = Array.from({ length: 51 }, (_, i) => Math.round((0.5 + 0.05 * i) * 100) / 100);
const TARGET_LABELLED = 0.06;
const TARGET_STRONG = 0.015;

/** Inputs whose live divisor is not sigma100: sigma100 is measured for them as the alternative. */
const ALT_IDS = V2_INPUTS.filter((s) => s.divisor !== "sigma100").map((s) => s.id);

/** Candidate tables: the inputs moved to sigma100 (everything else keeps the live divisor). */
export const TABLES = {
  current: [],
  trend5: ["sma", "ema", "psar", "ichimoku", "supertrend"],
  // By measurement: the inputs whose clipped share falls with sigma100 at every interval (EMA, SMA and the
  // bands do not improve; VWAP improves at 1h and 1d only, so it is tried both ways).
  measured: ["psar", "ichimoku", "supertrend", "ao"],
  measured_vwap: ["psar", "ichimoku", "supertrend", "ao", "vwap"],
  trend5_ao_vwap: ["sma", "ema", "psar", "ichimoku", "supertrend", "ao", "vwap"],
  all_sigma: ALT_IDS,
};

const r6 = (x) => (typeof x === "number" && Number.isFinite(x) ? Number(x.toPrecision(6)) : null);
const fin = Number.isFinite;
const clamp = (x) => Math.min(1, Math.max(-1, x)) + 0;

class Hist {
  constructor() { this.h = new Float64Array(BINS + 1); this.n = 0; this.clipped = 0; }
  add(a) { this.h[Math.min(BINS, Math.round(a * BINS))]++; this.n++; if (a >= CLIP_AT) this.clipped++; }
  q(p) {
    const target = p * this.n;
    let c = 0;
    for (let i = 0; i <= BINS; i++) { c += this.h[i]; if (c >= target) return i / BINS; }
    return 1;
  }
  summary() { return { n: this.n, clipped: r6(this.clipped / this.n), median: r6(this.q(0.5)), q90: r6(this.q(0.9)), q99: r6(this.q(0.99)) }; }
}

/** sigma100-divided z of `raw` at j, with the engine's divisor floor (same arithmetic as v2InputSeries). */
function zSigma(raw, j, sign, scale) {
  const d = rollingSigmaAt(raw, j);
  if (!fin(raw[j]) || !fin(d) || d <= 0 || d <= V2_DIVISOR_FLOOR * scale) return NaN;
  return clamp((sign * raw[j]) / d);
}

function erAt(k, j) {
  if (j < ER_PERIOD || j >= k.length) return null;
  let path = 0;
  for (let i = j - ER_PERIOD + 1; i <= j; i++) path += Math.abs(k[i].close - k[i - 1].close);
  const net = Math.abs(k[j].close - k[j - ER_PERIOD].close);
  if (!fin(path) || !fin(net)) return null;
  return path === 0 ? 0 : net / path;
}
const gateOf = (er) => (er === null ? 0 : Math.max(0, Math.min(1, (er - ER_GATE_LOW) / (ER_GATE_HIGH - ER_GATE_LOW))));

/**
 * One window: the z of every input under the live divisor and, for ALT_IDS, under sigma100, over [from, n).
 * Returns { zLive[i][j - from], zAlt[id][j - from], gate[j - from], dropped[i] }.
 */
function windowZ(k, intervalMs, from) {
  const n = k.length, span = n - from;
  const series = v2InputSeries(k, { intervalMs, volumeAvailable: true }, from);
  const zLive = series.map((s) => s.z.subarray(from));
  const zAlt = {};
  for (let i = 0; i < V2_INPUTS.length; i++) {
    const spec = V2_INPUTS[i];
    if (!ALT_IDS.includes(spec.id) || series[i].dropped) continue;
    const scaleKind = SCALE_KIND[spec.id];
    const z = new Float64Array(span).fill(NaN);
    for (let j = from; j < n; j++) z[j - from] = zSigma(series[i].raw, j, spec.sign, scaleKind === "price" ? Math.abs(k[j].close) : 1);
    zAlt[spec.id] = z;
  }
  const gate = new Float64Array(span);
  for (let j = from; j < n; j++) gate[j - from] = gateOf(erAt(k, j));
  return { zLive, zAlt, gate, dropped: series.map((s) => s.dropped) };
}

/** The engine's aggregation (meanAt) over a table: moved ids read zAlt. Returns means (null as NaN) and bloc scores. */
function meansOf(w, moved, blocHists) {
  const span = w.gate.length;
  const voters = w.dropped.filter((d) => !d).length;
  const x = voters * MIN_VALID_VOTING_SHARE, rx = Math.round(x), minValid = rx < x ? rx + 1 : rx;
  const out = new Float64Array(span).fill(NaN);
  const sums = new Float64Array(4), counts = new Int32Array(4);
  const zs = V2_INPUTS.map((s, i) => (moved.includes(s.id) ? w.zAlt[s.id] : w.zLive[i]));
  const bi = V2_INPUTS.map((s) => BLOCS.indexOf(s.bloc));
  for (let t = 0; t < span; t++) {
    sums.fill(0); counts.fill(0);
    let valid = 0;
    for (let i = 0; i < zs.length; i++) {
      if (w.dropped[i]) continue;
      const z = zs[i][t];
      if (!fin(z)) continue;
      valid++; sums[bi[i]] += z; counts[bi[i]]++;
    }
    if (valid < minValid) continue;
    let num = 0, den = 0;
    for (let b = 0; b < 4; b++) {
      const wt = BLOCS[b] === "meanReversion" ? 1 - w.gate[t] : 1;
      if (counts[b] === 0 || !(wt > 0)) continue;
      if (blocHists) blocHists[b].add(Math.abs(sums[b] / counts[b]));
      num += wt * (sums[b] / counts[b]); den += wt;
    }
    out[t] = den > 0 ? num / den : 0;
  }
  return out;
}

/** Hysteresis label at the last bar and the last score, for means at a gain (engine arithmetic). */
function labelOf(means, g) {
  let st = 0, s = null;
  for (let t = 0; t < means.length; t++) {
    const m = means[t];
    s = fin(m) ? Math.round(100 * Math.max(-1, Math.min(1, g * m))) + 0 : null;
    if (s === null) { st = 0; continue; }
    if (st === 1 && s < V2_EXIT) st = 0;
    else if (st === -1 && s > -V2_EXIT) st = 0;
    if (st === 0) { if (s >= V2_ENTER) st = 1; else if (s <= -V2_ENTER) st = -1; }
  }
  return { st, s };
}
const strongAt = ({ st, s }, band) => st !== 0 && s !== null && (st === 1 ? s > 0 : s < 0) && Math.abs(s) >= band;

/** The pinned Task 4 calibration over per-cell means; plus the next-step cliff ratio. */
function calibrateMeans(cellMeans) {
  const evalG = (g) => cellMeans.map((c) => c.means.map((m) => labelOf(m, g)));
  const grid = GRID.map((g) => {
    const labs = evalG(g);
    return { g, worstLabelled: r6(Math.max(...labs.map((ls) => ls.filter((l) => l.st !== 0).length / ls.length))),
      worstStrong70: r6(Math.max(...labs.map((ls) => ls.filter((l) => strongAt(l, 70)).length / ls.length))) };
  });
  const qi = grid.map((r, i) => (r.worstLabelled <= TARGET_LABELLED ? i : -1)).filter((i) => i >= 0);
  if (!qi.length) return { grid, chosen: null };
  const gi = qi[qi.length - 1], gain = grid[gi].g;
  const labs = evalG(gain);
  let band = null;
  for (let b = V2_ENTER + 1; b <= 100 && band === null; b++) {
    if (Math.max(...labs.map((ls) => ls.filter((l) => strongAt(l, b)).length / ls.length)) <= TARGET_STRONG) band = b;
  }
  const next = grid[gi + 1] ?? null;
  const cells = cellMeans.map((c, i) => ({ model: c.model, tf: c.tf,
    labelled: r6(labs[i].filter((l) => l.st !== 0).length / labs[i].length),
    strong: band === null ? null : r6(labs[i].filter((l) => strongAt(l, band)).length / labs[i].length) }));
  return { grid, chosen: { gain, strongBand: band }, cells,
    cliff: next ? { nextG: next.g, nextWorstLabelled: next.worstLabelled, ratio: r6(next.worstLabelled / grid[gi].worstLabelled) } : null };
}

/** noise-v2.test.mjs's drift fixture (seed 4409, 100 windows, 1h, per-bar Sharpe 0.5). */
function driftWindows() {
  function* drifted(gen, mu) { for (const [z, sd] of gen) yield [z + mu / sd, sd]; }
  const r = rng(4409), out = [];
  for (let w = 0; w < 100; w++) out.push(klines(drifted(innovations("gauss", r, 0.008), 0.004), BARS, H));
  return out;
}

export function diagnose() {
  const from = BARS - V2_HYST_BARS;
  const names = Object.keys(TABLES);
  // Per interval: per input, per divisor option, a |z| histogram; per table: |mean| and per-bloc histograms.
  const zh = {}, mh = {}, bh = {};
  const cellMeans = Object.fromEntries(names.map((t) => [t, []]));
  let selfCheck = 0, selfBad = "";
  for (const iv of INTERVALS) {
    zh[iv.tf] = {}; mh[iv.tf] = {}; bh[iv.tf] = {};
    for (const s of V2_INPUTS) {
      zh[iv.tf][s.id] = { [s.divisor]: new Hist() };
      if (ALT_IDS.includes(s.id)) zh[iv.tf][s.id].sigma100 = new Hist();
    }
    for (const t of names) { mh[iv.tf][t] = new Hist(); bh[iv.tf][t] = BLOCS.map(() => new Hist()); }
  }
  for (const model of MODELS) for (const iv of INTERVALS) {
    const perTable = Object.fromEntries(names.map((t) => [t, []]));
    let w = 0;
    for (const k of noiseCell(model, iv, DIAG_WINDOWS, DIAG_SEED_OFFSET)) {
      const wz = windowZ(k, iv.ms, from);
      V2_INPUTS.forEach((s, i) => {
        if (wz.dropped[i]) return;
        for (const z of wz.zLive[i]) if (fin(z)) zh[iv.tf][s.id][s.divisor].add(Math.abs(z));
        if (wz.zAlt[s.id]) for (const z of wz.zAlt[s.id]) if (fin(z)) zh[iv.tf][s.id].sigma100.add(Math.abs(z));
      });
      for (const t of names) {
        const m = meansOf(wz, TABLES[t], bh[iv.tf][t]);
        for (const x of m) if (fin(x)) mh[iv.tf][t].add(Math.abs(x));
        perTable[t].push(m);
      }
      if (w++ < 3) { // self-check: the re-stated aggregation equals the engine on the live table
        const eng = v2MeanSeries(k, { intervalMs: iv.ms, volumeAvailable: true }, from).slice(from);
        const mine = perTable.current[perTable.current.length - 1];
        for (let t = 0; t < eng.length; t++) {
          const a = eng[t] === null ? NaN : eng[t];
          if (!(Object.is(a, mine[t]) || (Number.isNaN(a) && Number.isNaN(mine[t])))) { selfBad = `${model} ${iv.tf} w${w} t${t}: ${a} vs ${mine[t]}`; break; }
        }
        selfCheck++;
      }
    }
    for (const t of names) cellMeans[t].push({ model, tf: iv.tf, means: perTable[t] });
  }
  if (selfBad) throw new Error("self-check failed: " + selfBad);

  const drift = driftWindows().map((k) => {
    const wz = windowZ(k, H, from);
    const atrR = indATR(k);
    const lowVol = atrR.valid && atrR.value !== null && atrR.value < LOW_VOLATILITY_PERCENTILE;
    return { wz, lowVol };
  });

  const inputs = {};
  for (const iv of INTERVALS) {
    inputs[iv.tf] = {};
    for (const s of V2_INPUTS) {
      const o = {};
      for (const [d, h] of Object.entries(zh[iv.tf][s.id])) if (h.n) o[d] = h.summary();
      inputs[iv.tf][s.id] = Object.keys(o).length ? o : "dropped";
    }
  }
  const tables = {};
  for (const t of names) {
    const cal = calibrateMeans(cellMeans[t]);
    let lab = 0, buy = 0, strong = 0;
    if (cal.chosen && cal.chosen.strongBand !== null) {
      for (const d of drift) {
        const l = labelOf(meansOf(d.wz, TABLES[t]), cal.chosen.gain);
        if (l.st !== 0) { lab++; if (l.st === 1) buy++; if (!d.lowVol && strongAt(l, cal.chosen.strongBand)) strong++; }
      }
    }
    tables[t] = {
      sigma100: TABLES[t],
      mean: Object.fromEntries(INTERVALS.map((iv) => [iv.tf, mh[iv.tf][t].summary()])),
      blocMedian: Object.fromEntries(INTERVALS.map((iv) => [iv.tf, Object.fromEntries(BLOCS.map((b, i) => [b, bh[iv.tf][t][i].n ? r6(bh[iv.tf][t][i].q(0.5)) : null]))])),
      calibration: { chosen: cal.chosen, cliff: cal.cliff ?? null, cells: cal.cells ?? [], grid: cal.grid },
      drift: { windows: drift.length, labelled: lab, buy, strong },
    };
  }
  return {
    what: "WP23 Task 4 rework: noise distribution of the v2 inputs' z per divisor option, and the bloc mean, gain grid and drift per candidate table",
    set: { models: MODELS, intervals: INTERVALS.map((i) => i.tf), windows: DIAG_WINDOWS, seedOffset: DIAG_SEED_OFFSET, bars: `last ${V2_HYST_BARS} of ${BARS}` },
    clippedMeans: `share of |z| >= ${CLIP_AT}`,
    selfCheckWindows: selfCheck,
    inputs,
    tables,
  };
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--out");
  const out = i >= 0 ? args[i + 1] : undefined;
  if (!out || !out.startsWith("/")) { console.error("usage: --out <absolute path>"); process.exit(2); }
  const t0 = performance.now();
  const r = diagnose();
  writeFileSync(out, JSON.stringify(r, null, 2) + "\n");
  const pct = (x) => (x === null ? "   -  " : (x * 100).toFixed(1).padStart(5) + "%");
  for (const iv of INTERVALS) {
    console.log(`\n== ${iv.tf}: per input, clipped share / median |z| ==`);
    for (const s of V2_INPUTS) {
      const o = r.inputs[iv.tf][s.id];
      if (o === "dropped") { console.log(`  ${s.id.padEnd(11)} dropped`); continue; }
      console.log(`  ${s.id.padEnd(11)} ` + Object.entries(o).map(([d, x]) => `${d.padEnd(8)} ${pct(x.clipped)} ${x.median.toFixed(3)}`).join("   "));
    }
  }
  for (const [t, x] of Object.entries(r.tables)) {
    console.log(`\n== table ${t} (sigma100: ${x.sigma100.join(",") || "-"}) ==`);
    for (const iv of INTERVALS) {
      const m = x.mean[iv.tf];
      console.log(`  ${iv.tf} |mean| median ${m.median.toFixed(3)} q90 ${m.q90.toFixed(3)} q99 ${m.q99.toFixed(3)} >=0.999 ${pct(m.clipped)}  blocs ${JSON.stringify(x.blocMedian[iv.tf])}`);
    }
    const c = x.calibration;
    console.log(`  chosen ${JSON.stringify(c.chosen)} cliff ${JSON.stringify(c.cliff)} drift ${JSON.stringify(x.drift)}`);
    console.log("  grid " + c.grid.filter((g) => g.g <= 2).map((g) => `${g.g}:${(g.worstLabelled * 100).toFixed(1)}`).join(" "));
  }
  console.log(`\n(${((performance.now() - t0) / 1000).toFixed(1)} s) wrote ${out}`);
}
function isEntryPoint() {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; }
}
if (isEntryPoint()) main();
