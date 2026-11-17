// Confluence v2 inputs — v2.8 (WP23 Task 2). Run: npm run test:v2-inputs
// Volatility-standardised, clipped inputs (ADR-0017 table). Pure code: no network, no ledger.
import { sma, ema, atr, rollingStdDev, macdHistogram, runConfluence } from "./indicators.ts";
import * as IND from "./indicators.ts";
import { fingerprintSeries } from "./engine-config.ts";
import { VOTE_ORDER } from "./scan-pipeline.ts";
import {
  V2_SIGMA_BARS, V2_ATR, V2_CLIP, V2_DROP_FROM_MS, V2_CONTRARIAN, V2_INPUTS,
  contrarianDropped, rollingSigmaAt, v2InputSeries, v2RowAt,
} from "./confluence-v2-inputs.ts";
import { measureWalks } from "./noise-fixtures.mjs";

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log("  ok   - " + name); }
  else { failed++; console.log("  FAIL - " + name + (extra ? "  [" + extra + "]" : "")); }
};
const near = (a, b, rel = 1e-9) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));
const clamp = (x) => Math.min(1, Math.max(-1, x));
const H = 3_600_000;
const O1H = { intervalMs: H, volumeAvailable: true };

ok("constants", V2_SIGMA_BARS === 100 && V2_ATR === 14 && V2_CLIP === 1 && V2_DROP_FROM_MS === 4 * H
  && V2_CONTRARIAN.join() === "rsi,stochastic,williams,mfi");

const fp = fingerprintSeries().slice(0, 1000);
const run = runConfluence(fp, { intervalMs: H });
// Classic voters in engine order (informational ones skipped).
const voters = run.indicators.filter((r) => !r.informational);
const byId = Object.fromEntries(VOTE_ORDER.map((id, i) => [id, voters[i]]));
const series = v2InputSeries(fp, O1H, 900);
const S = Object.fromEntries(series.map((s) => [s.id, s]));
const L = fp.length - 1;

// 1. table
ok("V2_INPUTS is the voter list in engine order with Classic's blocs",
  V2_INPUTS.map((s) => s.id).join() === VOTE_ORDER.join()
  && V2_INPUTS.every((s) => s.bloc === byId[s.id].bloc && s.bloc !== "volatility"),
  V2_INPUTS.map((s) => s.id).join());
ok("series are returned in table order, one per input", series.map((s) => s.id).join() === VOTE_ORDER.join()
  && series.every((s) => s.raw.length === fp.length && s.z.length === fp.length));

// 2. raw == Classic at the last bar
{
  const v = (id) => byId[id].value;
  const closes = fp.map((c) => c.close);
  const sd20 = rollingStdDev(closes, 20)[L];
  const atr10 = atr(fp, 10)[L];
  const vw = (() => { // Classic's VWAP is recoverable from its value: (cur - vwap) / vwap
    const val = v("vwap"); return fp[L].close / (1 + val);
  })();
  const checks = {
    sma: v("sma"), ema: v("ema"), macd: v("macd"), psar: v("psar"), ichimoku: v("ichimoku"), supertrend: v("supertrend"),
    cci: v("cci"), ao: v("ao"), cmf: v("cmf"), obv: v("obv"),
    rsi: v("rsi") - 50, stochastic: v("stochastic") - 50, williams: v("williams") + 50, mfi: v("mfi") - 50,
    bollinger: v("bollinger") * sd20, keltner: v("keltner") * atr10, vwap: v("vwap") * vw,
  };
  for (const [id, expected] of Object.entries(checks)) {
    ok(`raw ${id} equals Classic at the last bar`, near(S[id].raw[L], expected), `${S[id].raw[L]} vs ${expected}`);
  }
  // adx: Classic prints +DI / -DI (2 dp) in the detail string.
  const m = /\+DI=([\d.]+) · −DI=([\d.]+)/.exec(byId.adx.detail);
  ok("raw adx equals +DI - -DI (Classic detail, 2 dp)", !!m && Math.abs(S.adx.raw[L] - (Number(m[1]) - Number(m[2]))) <= 0.011,
    `${S.adx.raw[L]} vs ${m && m[0]}`);
}

// 3. divisions and clipping
{
  const closes = fp.map((c) => c.close);
  const a14 = atr(fp, 14)[L];
  const s20 = sma(closes, 20)[L], s50 = sma(closes, 50)[L];
  ok("z_sma = clamp((SMA20 - SMA50) / ATR14)", S.sma.z[L] === clamp((s20 - s50) / a14));
  const hist = macdHistogram(fp).map((p) => p.histogram);
  ok("z_macd = clamp(hist / sigma100(hist))", S.macd.z[L] === clamp(hist[L] / rollingSigmaAt(hist, L)));
  ok("z_bollinger = clamp((c - m) / (2 sigma20))",
    near(S.bollinger.z[L], clamp((closes[L] - s20) / (2 * rollingStdDev(closes, 20)[L])), 1e-12));
  const e20 = ema(closes, 20)[L];
  ok("z_keltner = clamp((c - EMA20) / (2 ATR10))", near(S.keltner.z[L], clamp((closes[L] - e20) / (2 * atr(fp, 10)[L])), 1e-12));
  let allIn = true, finiteCount = 0, hitClip = false;
  for (const s of series) for (let j = 0; j < fp.length; j++) {
    const z = s.z[j];
    if (Number.isFinite(z)) { finiteCount++; if (z < -1 || z > 1) allIn = false; if (Math.abs(z) === 1) hitClip = true; }
  }
  ok("every finite z lies in [-1, 1]", allIn && finiteCount > 0 && hitClip, `finite=${finiteCount} clipped=${hitClip}`);
  ok("z is NaN before `from`", series.every((s) => { for (let j = 0; j < 900; j++) if (!Number.isNaN(s.z[j])) return false; return true; }));
  ok("all 18 inputs are finite at the last bar at 1h", series.every((s) => Number.isFinite(s.z[L])), series.filter((s) => !Number.isFinite(s.z[L])).map((s) => s.id).join());
}

// 4. contrarian sign
{
  const rising = [];
  for (let i = 0; i < 400; i++) {
    const c = 100 + i * 0.5 + 3 * Math.sin(i * 0.7); // drift up, with pullbacks so RSI varies
    rising.push({ time: Date.UTC(2025, 0, 1) + i * H, open: c - 0.2, high: c + 0.3, low: c - 0.4, close: c, volume: 1000 + (i % 7) });
  }
  const r = v2InputSeries(rising, O1H, 399);
  const g = (id) => r.find((s) => s.id === id).z[399];
  ok("rising series: z_rsi < 0 (contrarian) and z_sma > 0 (trend)", g("rsi") < 0 && g("sma") > 0, `${g("rsi")} ${g("sma")}`);
}

// 5. drop on >= 4h only
{
  ok("contrarianDropped boundary", contrarianDropped(4 * H) && !contrarianDropped(4 * H - 1) && contrarianDropped(30 * 24 * H) && !contrarianDropped(H));
  const k = measureWalks(1, 1000)[0];
  for (const [label, ms] of [["4h", 4 * H], ["1d", 24 * H], ["1M", 30 * 24 * H]]) {
    const r = v2InputSeries(k, { intervalMs: ms, volumeAvailable: true }, 900);
    const dropped = r.filter((s) => s.dropped).map((s) => s.id).join();
    ok(`${label}: exactly rsi,stochastic,williams,mfi dropped with all-NaN z`,
      dropped === "rsi,stochastic,williams,mfi"
      && r.filter((s) => s.dropped).every((s) => s.z.every(Number.isNaN)), dropped);
    ok(`${label}: the other 14 are not dropped and are finite at the last bar`,
      r.filter((s) => !s.dropped).length === 14 && r.filter((s) => !s.dropped).every((s) => Number.isFinite(s.z[999])));
  }
  for (const [label, ms] of [["1h", H], ["4h - 1 ms", 4 * H - 1]]) {
    const r = v2InputSeries(k, { intervalMs: ms, volumeAvailable: true }, 900);
    ok(`${label}: nothing dropped`, r.every((s) => !s.dropped) && r.every((s) => Number.isFinite(s.z[999])));
  }
}

// 6. no volume
{
  const noVol = fp.map((c) => ({ ...c, volume: 0 }));
  const r = v2InputSeries(noVol, { intervalMs: H, volumeAvailable: false }, 900);
  const vol = r.filter((s) => ["mfi", "vwap", "obv", "cmf"].includes(s.id));
  ok("no volume: mfi, vwap, obv, cmf z all NaN", vol.length === 4 && vol.every((s) => s.z.every(Number.isNaN)));
  ok("no volume: the other inputs still score", r.filter((s) => !vol.includes(s)).every((s) => Number.isFinite(s.z[999])));
  // volumeAvailable false with real volume present still suppresses (flag decides).
  const r2 = v2InputSeries(fp, { intervalMs: H, volumeAvailable: false }, 900);
  ok("volumeAvailable=false suppresses volume inputs even when volume exists", r2.filter((s) => ["mfi", "vwap", "obv", "cmf"].includes(s.id)).every((s) => s.z.every(Number.isNaN)));
}

// 7. zero divisor
{
  const flat = Array.from({ length: 400 }, (_, i) => ({ time: Date.UTC(2025, 0, 1) + i * H, open: 100, high: 100, low: 100, close: 100, volume: 1000 }));
  let r, threw = false;
  try { r = v2InputSeries(flat, O1H, 300); } catch { threw = true; }
  ok("flat series does not throw", !threw);
  const dividedIds = ["sma", "ema", "macd", "adx", "psar", "ichimoku", "supertrend", "rsi", "stochastic", "cci", "williams", "ao", "mfi", "bollinger", "keltner", "vwap", "obv", "cmf"];
  const bad = r.filter((s) => dividedIds.includes(s.id) && s.z.some((z) => Number.isFinite(z) && Math.abs(z) === 1)).map((s) => s.id);
  ok("flat series: no divisor-zero input is reported as +-1", bad.length === 0, bad.join());
  ok("flat series: every ATR-, band- and sigma-divided input is NaN (all 18)", r.every((s) => s.z.every(Number.isNaN)),
    r.filter((s) => !s.z.every(Number.isNaN)).map((s) => s.id).join());
}

// 7b. flat-after-movement ("dead pair"): rounding noise must not become a +-1 vote
{
  const k = [];
  let px = 100;
  for (let i = 0; i < 400; i++) {
    if (i < 150) {
      const o = px; px = o * (1 + 0.012 * Math.sin(i * 0.37) + 0.001 * i % 3 * 0.01);
      k.push({ time: Date.UTC(2025, 0, 1) + i * H, open: o, high: Math.max(o, px) * 1.003, low: Math.min(o, px) * 0.997, close: px, volume: 1000 + (i % 11) * 37 });
    } else {
      k.push({ time: Date.UTC(2025, 0, 1) + i * H, open: px, high: px, low: px, close: px, volume: 500 + (i % 7) * 91 });
    }
  }
  const r = v2InputSeries(k, O1H, 399);
  const sigmaDivided = ["macd", "adx", "rsi", "stochastic", "cci", "williams", "mfi", "obv", "cmf"];
  const loud = r.filter((s) => sigmaDivided.includes(s.id) && !Number.isNaN(s.z[399])).map((s) => `${s.id}=${s.z[399]}`);
  ok("dead pair: every sigma-divided input is NaN at the last bar", loud.length === 0, loud.join(" "));
  const loud2 = r.filter((s) => !Number.isNaN(s.z[399])).map((s) => `${s.id}=${s.z[399]}`);
  ok("dead pair: ATR- and band-divided inputs are NaN too (all 18)", loud2.length === 0, loud2.join(" "));
  ok("rollingSigmaAt(100 x 0.1) is 0, not rounding noise", rollingSigmaAt(new Array(100).fill(0.1), 99) === 0);
}

// 8. causal
{
  const k = measureWalks(1, 1000, 7)[0];
  const full = v2InputSeries(k, O1H, 700);
  let bad = "";
  for (let j = 700; j <= 999 && !bad; j += 1) {
    const cut = v2InputSeries(k.slice(0, j + 1), O1H, j);
    for (let i = 0; i < cut.length; i++) {
      const a = cut[i].z[j], b = full[i].z[j];
      const ra = cut[i].raw[j], rb = full[i].raw[j];
      if (!(Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b))) || !(Object.is(ra, rb) || (Number.isNaN(ra) && Number.isNaN(rb)))) { bad = `${cut[i].id}@${j}: ${a} vs ${b}`; break; }
    }
  }
  ok("causal: z[j] and raw[j] from a prefix equal the full-series values (j 700..999)", bad === "", bad);
  const finiteLate = full.filter((s) => Number.isFinite(s.z[999])).length;
  ok("causal fixture is live (inputs finite)", finiteLate === 18, String(finiteLate));
}

// 9. warm-up is NaN, not zero
{
  const k = measureWalks(1, 300, 11)[0];
  const r = v2InputSeries(k, O1H, 0);
  const early = r.filter((s) => Number.isFinite(s.z[5]) && s.z[5] === 0).map((s) => s.id);
  ok("warm-up bars are NaN, never zero-filled", early.length === 0, early.join());
  ok("sigma100 inputs need 100 finite raws: macd z is NaN before bar ~134", Number.isNaN(r.find((s) => s.id === "macd").z[120]));
  // First bar at which each raw measure is defined (period - 1, or the seed bar of its smoothing).
  const FIRST = { sma: 49, ema: 20, macd: 33, adx: 14, psar: 4, ichimoku: 77, supertrend: 10, rsi: 14, stochastic: 13, cci: 19,
    williams: 13, ao: 33, mfi: 14, bollinger: 19, keltner: 19, vwap: 0, obv: 20, cmf: 19 };
  const bad = [];
  for (const s of r) {
    const f = FIRST[s.id];
    for (let j = 0; j < f; j++) if (!Number.isNaN(s.raw[j])) { bad.push(`${s.id}@${j}=${s.raw[j]}`); break; }
    if (!Number.isFinite(s.raw[f])) bad.push(`${s.id} not finite at its first bar ${f}`);
  }
  ok("raw is NaN (never 0) below each input's first valid bar, finite at it", bad.length === 0, bad.join(" "));
}

// 10. rollingSigmaAt
{
  ok("rollingSigmaAt([1,2,3,4], n=4) = sqrt(1.25)", rollingSigmaAt([1, 2, 3, 4], 3, 4) === Math.sqrt(1.25));
  ok("NaN inside the window gives NaN", Number.isNaN(rollingSigmaAt([1, NaN, 3, 4], 3, 4)));
  ok("window not yet full gives NaN", Number.isNaN(rollingSigmaAt([1, 2, 3, 4], 2, 4)));
  const xs = measureWalks(1, 300, 5)[0].map((c) => c.close);
  ok("matches Classic rollingStdDev", near(rollingSigmaAt(xs, 250, 20), rollingStdDev(xs, 20)[250], 1e-12));
}

// 11. sampled prefix pin (M1/M2/M5): raw[j] vs Classic's ind* on k.slice(0, j+1)
{
  const k = fingerprintSeries().slice(0, 1000);
  const ser = Object.fromEntries(v2InputSeries(k, O1H, 0).map((s) => [s.id, s]));
  // Independent +DI - -DI (Wilder), recomputed here from the brief's definition.
  const diDiff = (p) => {
    const n = p.length, per = 14, a = atr(p, per);
    const pdm = [0], mdm = [0];
    for (let i = 1; i < n; i++) {
      const up = p[i].high - p[i - 1].high, dn = p[i - 1].low - p[i].low;
      pdm.push(up > dn && up > 0 ? up : 0); mdm.push(dn > up && dn > 0 ? dn : 0);
    }
    let ps = 0, ms = 0;
    for (let i = 1; i <= per; i++) { ps += pdm[i]; ms += mdm[i]; }
    for (let i = per + 1; i < n; i++) { ps = ps - ps / per + pdm[i]; ms = ms - ms / per + mdm[i]; }
    return 100 * (ps / per) / a[n - 1] - 100 * (ms / per) / a[n - 1];
  };
  const bad = [];
  for (const j of [20, 40, 80, 150, 400, 999]) {
    const p = k.slice(0, j + 1);
    const cl = p.map((c) => c.close);
    const val = (fn) => fn(p).value;
    const exp = {
      sma: val(IND.indSMA), ema: val(IND.indEMA), macd: val(IND.indMACD), psar: val(IND.indPSAR), ichimoku: val(IND.indIchimoku),
      supertrend: val(IND.indSupertrend), cci: val(IND.indCCI), ao: val(IND.indAO), cmf: val(IND.indCMF), obv: val(IND.indOBV),
      rsi: val(IND.indRSI) == null ? null : val(IND.indRSI) - 50,
      stochastic: val(IND.indStoch) == null ? null : val(IND.indStoch) - 50,
      williams: val(IND.indWilliamsR) == null ? null : val(IND.indWilliamsR) + 50,
      mfi: val(IND.indMFI) == null ? null : val(IND.indMFI) - 50,
      bollinger: val(IND.indBollinger) == null ? null : val(IND.indBollinger) * rollingStdDev(cl, 20)[j],
      keltner: val(IND.indKeltner) == null ? null : val(IND.indKeltner) * atr(p, 10)[j],
      adx: j >= 28 ? diDiff(p) : null,
    };
    const vw = IND.indVWAP(p, { intervalMs: H });
    if (vw.value != null) { const vwap = cl[j] / (1 + vw.value); exp.vwap = vw.value * vwap; }
    for (const [id, e] of Object.entries(exp)) {
      if (e == null) continue; // Classic is unavailable at this prefix
      if (!near(ser[id].raw[j], e, 1e-12)) bad.push(`${id}@${j}: ${ser[id].raw[j]} vs ${e}`);
    }
  }
  ok("prefix pin: raw[j] equals Classic on slice(0, j+1) for j in {20,40,80,150,400,999}, all inputs incl. ADX and VWAP", bad.length === 0, bad.join(" | "));
  // VWAP spans many UTC days at 1h: pin session bucketing at every 7th bar against Classic.
  let vbad = "";
  for (let j = 30; j < 1000 && !vbad; j += 7) {
    const vw = IND.indVWAP(k.slice(0, j + 1), { intervalMs: H });
    const vwap = k[j].close / (1 + vw.value);
    if (!near(ser.vwap.raw[j], vw.value * vwap, 1e-12)) vbad = `vwap@${j}`;
  }
  ok("vwap session bucketing equals Classic's at every 7th bar of 1000 (41 UTC days)", vbad === "", vbad);
  // 1d interval uses the 20-bar form
  const d = v2InputSeries(measureWalks(1, 200, 3, 24 * H)[0], { intervalMs: 24 * H, volumeAvailable: true }, 0).find((s) => s.id === "vwap");
  const kd = measureWalks(1, 200, 3, 24 * H)[0];
  const vd = IND.indVWAP(kd, { intervalMs: 24 * H });
  ok("vwap at 1d (20-bar) equals Classic", near(d.raw[199], vd.value * (kd[199].close / (1 + vd.value)), 1e-12));
}

// 12. per-row cost of slicing from a precomputed series (M6 / Task 6 budget: <= 5 ms per row, <= 2 x Classic)
{
  const k = fingerprintSeries().slice(0, 1000);
  const T = () => Number(process.hrtime.bigint()) / 1e6;
  v2InputSeries(k, O1H, 0); runConfluence(k, { intervalMs: H }); // warm
  let t0 = T(); for (let i = 0; i < 20; i++) runConfluence(k, { intervalMs: H }); const classicMs = (T() - t0) / 20;
  t0 = T(); let pre; for (let i = 0; i < 20; i++) pre = v2InputSeries(k, O1H, 0); const wholeMs = (T() - t0) / 20;
  const rows = 400;
  t0 = T(); let sink = 0;
  for (let rep = 0; rep < 20; rep++) for (let j = 600; j < 600 + rows; j++) { const z = v2RowAt(pre, j); sink += z[0] || 0; }
  const perRowMs = (T() - t0) / (20 * rows);
  console.log(`  bench: classic ${classicMs.toFixed(3)} ms/window; v2 whole series (1000 bars, from 0) ${wholeMs.toFixed(3)} ms; v2RowAt ${(perRowMs * 1000).toFixed(2)} us/row`);
  ok("v2RowAt per-row cost from a precomputed series is far under the 5 ms / 2 x Classic budget", perRowMs < 0.05 && perRowMs < 2 * classicMs, `${perRowMs} ms`);
  const row = v2RowAt(pre, 700), cut = v2InputSeries(k.slice(0, 701), O1H, 700);
  ok("v2RowAt(precomputed, j) equals the prefix recomputation (bit-identical)", row.length === 18 && cut.every((s, i) => Object.is(s.z[700], row[i])));
  ok("v2RowAt rejects out-of-range rows with NaN", v2RowAt(pre, 5000).every(Number.isNaN) && v2RowAt(pre, -1).every(Number.isNaN));
}

// 13. the divisor floor does not suppress a real low-priced market (scale invariance)
{
  const k = fingerprintSeries().slice(0, 600);
  const tiny = k.map((c) => ({ ...c, open: c.open * 1e-6, high: c.high * 1e-6, low: c.low * 1e-6, close: c.close * 1e-6 }));
  const a = v2InputSeries(k, O1H, 599), b = v2InputSeries(tiny, O1H, 599);
  ok("prices x 1e-6 give the same z (floor is relative, not absolute)", a.every((s, i) => near(s.z[599], b[i].z[599], 1e-6)),
    a.map((s, i) => `${s.id}:${s.z[599]}/${b[i].z[599]}`).join(" "));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
