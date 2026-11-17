// Confluence v2 inputs — v2.8 (WP23 Task 2). Run: npm run test:v2-inputs
// Volatility-standardised, clipped inputs (ADR-0017 table). Pure code: no network, no ledger.
import { sma, ema, atr, rollingStdDev, macdHistogram } from "./indicators.ts";
import { runConfluence } from "./indicators.ts";
import { fingerprintSeries } from "./engine-config.ts";
import { VOTE_ORDER } from "./scan-pipeline.ts";
import {
  V2_SIGMA_BARS, V2_ATR, V2_CLIP, V2_DROP_FROM_MS, V2_CONTRARIAN, V2_INPUTS,
  contrarianDropped, rollingSigmaAt, v2InputSeries,
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
  ok("flat series: ATR- and sigma-divided inputs are NaN", ["sma", "ema", "macd", "adx", "psar", "ichimoku", "supertrend", "rsi", "cci", "ao", "bollinger", "keltner", "vwap", "obv", "cmf"].every((id) => r.find((s) => s.id === id).z.every(Number.isNaN)));
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
}

// 10. rollingSigmaAt
{
  ok("rollingSigmaAt([1,2,3,4], n=4) = sqrt(1.25)", rollingSigmaAt([1, 2, 3, 4], 3, 4) === Math.sqrt(1.25));
  ok("NaN inside the window gives NaN", Number.isNaN(rollingSigmaAt([1, NaN, 3, 4], 3, 4)));
  ok("window not yet full gives NaN", Number.isNaN(rollingSigmaAt([1, 2, 3, 4], 2, 4)));
  const xs = measureWalks(1, 300, 5)[0].map((c) => c.close);
  ok("matches Classic rollingStdDev", near(rollingSigmaAt(xs, 250, 20), rollingStdDev(xs, 20)[250], 1e-12));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
