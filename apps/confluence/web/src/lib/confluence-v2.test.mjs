// Confluence v2 scoring — v2.8 (WP23 Task 3). Run: npm run test:v2
// Bloc aggregation, the window-derived 55/40 hysteresis, the compact ledger field and v2's own
// config id. Pure code: no network, no ledger.
import { deepStrictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { efficiencyRatio, indATR, LOW_VOLATILITY_PERCENTILE } from "./indicators.ts";
import { fingerprintSeries, engineConfigId, hash64, stableStringify } from "./engine-config.ts";
import { scoreSeries, sessionBars, hasUsableVolume } from "./scan-pipeline.ts";
import { barWhileClosed } from "./asset-classes.ts";
import { contiguousTail } from "./market-client.ts";
import {
  V2_ENGINE_VERSION, V2_ENTER, V2_EXIT, V2_HYST_BARS, V2_GAIN, V2_STRONG_BAND, V2_PARAMS,
  v2MeanSeries, scoresFromMeans, v2ScoreSeries, hysteresisStep, v2States, runHysteresis, v2Strength,
  scoreV2, v2Compact, v2LineModel, v2Fingerprint, v2ConfigId,
} from "./confluence-v2.ts";
import { V2_INPUTS, v2InputSeries } from "./confluence-v2-inputs.ts";
import { measureWalks } from "./noise-fixtures.mjs";

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log("  ok   - " + name); }
  else { failed++; console.log("  FAIL - " + name + (extra ? "  [" + extra + "]" : "")); }
};
const deq = (a, b) => { try { deepStrictEqual(a, b); return true; } catch { return false; } };
const noThrow = (fn) => { try { fn(); return true; } catch (e) { console.log("    threw: " + (e && e.message)); return false; } };
const H = 3_600_000;
const H4 = 4 * H;
const DAY = 24 * H;
const SIGN = { BULLISH: 1, BEARISH: -1, NEUTRAL: 0 };
const optsOf = (k, intervalMs, extra = {}) => ({ intervalMs, volumeAvailable: true, ...extra });
/** The (intervalMs, volumeAvailable) pair scoreV2 hands to the inputs for a raw window `w`. */
const inner = (w, intervalMs) => ({ intervalMs, volumeAvailable: hasUsableVolume(w) });

// ---- constants -----------------------------------------------------------------------------------
ok("constants", V2_ENGINE_VERSION === "cv2-1.0.0" && V2_ENTER === 55 && V2_EXIT === 40 && V2_HYST_BARS === 300
  && typeof V2_GAIN === "number" && V2_GAIN > 0 && Number.isInteger(V2_STRONG_BAND) && V2_STRONG_BAND > V2_ENTER);
ok("V2_PARAMS carries the inputs as [id, divisor, sign] and the shared engine constants",
  Array.isArray(V2_PARAMS.inputs) && V2_PARAMS.inputs.length === 18
  && deq(V2_PARAMS.inputs[0], ["sma", "atr14", 1]) && deq(V2_PARAMS.inputs[7], ["rsi", "sigma100", -1])
  && V2_PARAMS.version === V2_ENGINE_VERSION && V2_PARAMS.enter === 55 && V2_PARAMS.exit === 40 && V2_PARAMS.hystBars === 300
  && V2_PARAMS.engineBars === 1000 && V2_PARAMS.minValidVotingShare === 0.7 && deq(V2_PARAMS.erGate, [0.3, 0.6])
  && V2_PARAMS.erPeriod === 40 && V2_PARAMS.lowVolatilityPercentile === 0.1 && V2_PARAMS.sigmaBars === 100
  && V2_PARAMS.dropFromMs === H4 && deq(V2_PARAMS.contrarian, ["rsi", "stochastic", "williams", "mfi"]));

// ---- hysteresis (Review Focus 2: exactly 55 / 40, one-bar flips, null) ------------------------------
{
  const table = [[0, 55, 1], [0, 54, 0], [0, -55, -1], [1, 40, 1], [1, 39, 0], [1, 45, 1], [1, -45, 0], [1, -60, -1],
    [-1, -40, -1], [-1, -39, 0], [-1, 60, 1], [1, null, 0], [-1, null, 0],
    // extra edges: exactly -54, staying in state at exactly the entry band, NaN treated as no data
    [0, -54, 0], [-1, -55, -1], [1, 100, 1], [0, null, 0], [1, NaN, 0], [0, Infinity, 0]];
  const bad = table.filter(([s, x, e]) => !Object.is(hysteresisStep(s, x), e)).map(([s, x, e]) => `(${s},${x})->${hysteresisStep(s, x)} want ${e}`);
  ok("hysteresisStep table", bad.length === 0, bad.join(" "));
}
ok("runHysteresis holds and releases",
  runHysteresis([60, 50, 45, 41], 0) === 1 && runHysteresis([60, 50, 39], 0) === 0 && runHysteresis([-70, -45], 0) === -1
  && runHysteresis([60, null, 50], 0) === 0 && runHysteresis([50, 54, 45], 0) === 0);
ok("runHysteresis of an empty run (from past the end) is NEUTRAL", runHysteresis([60, 70], 2) === 0 && runHysteresis([], 0) === 0);
{
  const st = v2States([60, 70, 50, 45, 39, -55], 2);
  ok("v2States is null before from and starts NEUTRAL", st[0] === null && st[1] === null && st[2] === 0 && st[3] === 0 && st[4] === 0 && st[5] === -1
    && st.length === 6, JSON.stringify(st));
  ok("v2States last value equals runHysteresis", v2States([60, 50, 41, 39, 70, 45], 0)[5] === runHysteresis([60, 50, 41, 39, 70, 45], 0));
  ok("v2States with a negative from starts at 0", deq(v2States([60, 50], -5), [1, 1]));
}

// ---- scoresFromMeans / v2Strength ----------------------------------------------------------------
ok("scoresFromMeans", deq(scoresFromMeans([0.3, 0.9, -0.275, null], 2), [60, 100, -55, null]));
ok("scoresFromMeans never yields -0 or NaN", Object.is(scoresFromMeans([-0.001], 1)[0], 0) && scoresFromMeans([NaN], 1)[0] === null);
ok("v2Strength",
  v2Strength("BULLISH", 75, false, false) === "STRONG" && v2Strength("BULLISH", 75, true, false) === "MODERATE"
  && v2Strength("BULLISH", 75, true, true) === "STRONG" && v2Strength("BULLISH", -75, false, false) === "MODERATE"
  && v2Strength("BEARISH", -75, false, false) === "STRONG" && v2Strength("NEUTRAL", 90, false, false) === "WEAK");

// ---- v2MeanSeries: the aggregation rules -----------------------------------------------------------
{
  const k = fingerprintSeries().slice(0, 1000);
  const o = { intervalMs: H, volumeAvailable: true };
  const means = v2MeanSeries(k, o, 700);
  ok("v2MeanSeries is aligned to k and null before from", means.length === 1000 && means.slice(0, 700).every((m) => m === null)
    && means.slice(700).some((m) => m !== null));
  // Independent recomputation of the rule at a few bars, at 1h (18 voters) and 4h (14 voters).
  const gateAt = (j) => { const er = efficiencyRatio(k.slice(0, j + 1)); return er === null ? 0 : Math.max(0, Math.min(1, (er - 0.3) / 0.3)); };
  let bad = "";
  for (const [iv, voters] of [[H, 18], [H4, 14]]) {
  const oi = { intervalMs: iv, volumeAvailable: true };
  const series = v2InputSeries(k, oi, 700);
  const meansI = v2MeanSeries(k, oi, 700);
  if (series.filter((s) => !s.dropped).length !== voters) bad = `voters ${iv}`;
  for (const j of [700, 750, 900, 999]) {
    const valid = series.filter((s) => !s.dropped && Number.isFinite(s.z[j]));
    let expected = null;
    if (valid.length >= Math.ceil(voters * 0.7)) {
      let num = 0, den = 0;
      for (const bloc of ["trend", "meanReversion", "breakout", "flow"]) {
        const m = valid.filter((s) => s.bloc === bloc);
        const w = bloc === "meanReversion" ? 1 - gateAt(j) : 1;
        if (!m.length || w <= 0) continue;
        let sum = 0; for (const s of m) sum += s.z[j];
        num += w * (sum / m.length); den += w;
      }
      expected = den > 0 ? num / den : 0;
    }
    if (!Object.is(meansI[j], expected)) bad = `${iv} ${j}: ${meansI[j]} vs ${expected}`;
  }
  }
  // Validity floor at 4h: 14 voters, 3 volume inputs off -> 11 valid >= ceil(9.8) = 10, still scored.
  const noVol4 = v2MeanSeries(k, { intervalMs: H4, volumeAvailable: false }, 999);
  if (noVol4[999] === null) bad = "4h without volume should still score (11 of 14 >= 10)";
  ok("v2MeanSeries = weighted mean of bloc means (meanReversion x (1 - ER gate)), recomputed independently", bad === "", bad);
  ok("v2ScoreSeries = scoresFromMeans(v2MeanSeries, V2_GAIN)", deq(v2ScoreSeries(k, o, 700), scoresFromMeans(means, V2_GAIN)));
  // Validity floor: with volume off and the series cut so that few inputs are warm, the mean is null.
  const cold = v2MeanSeries(k.slice(0, 120), o, 0);
  ok("bars with fewer than ceil(0.7 x voters) valid inputs are null", cold[60] === null && cold.slice(0, 100).every((m) => m === null));
}

// ---- scoreV2: Classic's window rules ---------------------------------------------------------------
const walk4h = measureWalks(1, 1600, 31)[0];
{
  const a = scoreV2(walk4h, optsOf(walk4h, H4));
  ok("1,600-bar 4h walk: warmBars 1000, usable", a.warmBars === 1000 && a.usable === true);
  ok("scoreV2(k) deep-equals scoreV2(k.slice(-1000))", deq(a, scoreV2(walk4h.slice(-1000), optsOf(walk4h, H4))));
  ok("t is the last raw bar's time", a.t === walk4h[1599].time);
  ok("79 bars: usable false, no throw", scoreV2(walk4h.slice(0, 79), optsOf(walk4h, H4)).usable === false);
  ok("80 bars: usable", scoreV2(walk4h.slice(0, 80), optsOf(walk4h, H4)).usable === true);
}
{
  // A stock series with its second part halved (daily bars). behaviourFingerprint's own variant halves
  // at bar 900 of hourly-stamped bars, where the session filter leaves a ratio outside detectSplit's 2 %
  // tolerance, so Classic does not flag it either; here the halving is exact across two session bars.
  const fp = fingerprintSeries().map((b, i) => ({ ...b, time: Date.UTC(2023, 0, 2) + i * DAY }));
  const opt = { intervalMs: DAY, volumeAvailable: true, assetClass: "stock" };
  let s = 900;
  while (barWhileClosed("stock", fp[s].time, DAY) || barWhileClosed("stock", fp[s - 1].time, DAY)) s++;
  const f = (0.5 * fp[s - 1].close) / fp[s].close;
  const split = fp.map((b, i) => (i < s ? b : { ...b, open: b.open * f, high: b.high * f, low: b.low * f, close: b.close * f }));
  const r = scoreV2(split, opt);
  const c = scoreSeries(split, opt);
  ok("stock split in the window: usable and suppressed, like Classic", r.usable && r.suppressed && c.split === true
    && r.master === "NEUTRAL" && r.strength === "WEAK" && r.score === 0 && r.warmBars === c.warmBars, `classic split=${c.split}`);
  ok("the same series without the split is scored", !scoreV2(fp, opt).suppressed);
  const cv = v2Compact(r, r.t);
  ok("split row compacts to s null, m 0, st 0", cv && cv.s === null && cv.m === 0 && cv.st === 0);
}
{
  const fp = fingerprintSeries().slice(0, 1000);
  const zero = fp.map((b) => ({ ...b, volume: 0 }));
  const r = scoreV2(zero, optsOf(zero, H));
  const vol = r.inputs.filter((x) => ["mfi", "vwap", "obv", "cmf"].includes(x.id));
  ok("zero volume: mfi, vwap, obv, cmf have z null; others still score", vol.length === 4 && vol.every((x) => x.z === null)
    && r.inputs.filter((x) => !vol.includes(x)).every((x) => Number.isFinite(x.z)) && !r.suppressed, JSON.stringify(vol));
  // volumeAvailable false likewise
  const r2 = scoreV2(fp, { intervalMs: H, volumeAvailable: false });
  ok("volumeAvailable false: the four volume inputs are null", r2.inputs.filter((x) => ["mfi", "vwap", "obv", "cmf"].includes(x.id)).every((x) => x.z === null));
}
{
  // Stock 1h: find a cut whose last raw bar falls outside the regular session.
  const fp = fingerprintSeries();
  let cut = -1;
  for (let n = 1100; n > 900; n--) if (barWhileClosed("stock", fp[n - 1].time, H)) { cut = n; break; }
  const k = fp.slice(0, cut);
  const r = scoreV2(k, { intervalMs: H, volumeAvailable: true, assetClass: "stock" });
  const eb = sessionBars(k.slice(-1000), "stock", H);
  ok("stock window whose last bar is outside the session: t = last raw bar's time", cut > 0 && r.usable
    && r.t === k[k.length - 1].time && eb[eb.length - 1].time !== r.t, `cut=${cut} t=${r.t}`);
  ok("stock session window: the engine sees only session bars (er from them)", Object.is(r.er, efficiencyRatio(eb)));
}
{
  const k = fingerprintSeries().slice(0, 1000);
  const base = scoreV2(k, { intervalMs: H, volumeAvailable: true });
  const prof = scoreV2(k, { intervalMs: H, volumeAvailable: true, profile: { version: 1, enabled: ["sma"] } });
  ok("ignores the scoring profile", deq(base, prof));
}

// ---- the label is the hysteresis over the window's own scores ---------------------------------------
for (const [label, k, iv] of [["1h fingerprint", fingerprintSeries(), H], ["4h walk", walk4h, H4]]) {
  let bad = "";
  for (const end of [400, 700, k.length]) {
    const w = k.slice(Math.max(0, end - 1000), end);
    const r = scoreV2(w, optsOf(w, iv));
    const from = Math.max(0, w.length - V2_HYST_BARS);
    const scores = v2ScoreSeries(w, inner(w, iv), from);
    const state = runHysteresis(scores, from);
    if (SIGN[r.master] !== state || r.score !== (scores[w.length - 1] ?? 0)) bad = `${end}: ${r.master} ${r.score} vs ${state} ${scores[w.length - 1]}`;
    if (r.held !== (r.master !== "NEUTRAL" && Math.abs(r.score) < 55)) bad = `${end}: held`;
  }
  ok(`${label}: master equals runHysteresis(v2ScoreSeries(w), from); score is the last bar's`, bad === "", bad);
}
{
  const w = fingerprintSeries().slice(0, 1000);
  const r = scoreV2(w, optsOf(w, H));
  ok("er and trendGate are Classic's ER gate at the last bar", Object.is(r.er, efficiencyRatio(w))
    && r.trendGate === Math.max(0, Math.min(1, (r.er - 0.3) / 0.3)));
  const atr = indATR(w);
  ok("lowVolatility uses Classic's ATR percentile", r.lowVolatility === (atr.valid && atr.value !== null && atr.value < LOW_VOLATILITY_PERCENTILE));
  ok("inputs: 18 in V2_INPUTS order with blocs; voters 18 at 1h", r.inputs.map((x) => x.id).join() === V2_INPUTS.map((s) => s.id).join()
    && r.inputs.every((x, i) => x.bloc === V2_INPUTS[i].bloc) && r.voters === 18 && r.dropped === false);
  ok("validCount counts finite inputs", r.validCount === r.inputs.filter((x) => x.z !== null).length);
  ok("blocs are reported in Classic's order", r.blocs.map((b) => b.bloc).join() === "trend,meanReversion,breakout,flow"
    && r.blocs.find((b) => b.bloc === "meanReversion").weight === 1 - r.trendGate);
}

// ---- pure and repeatable -------------------------------------------------------------------------
{
  const w = fingerprintSeries().slice(100, 1100);
  const snap = JSON.stringify(w);
  const a = scoreV2(w, optsOf(w, H));
  const b = scoreV2(structuredClone(w), optsOf(w, H));
  const c = scoreV2(w, optsOf(w, H));
  ok("pure and repeatable", deq(a, b) && deq(a, c) && JSON.stringify(w) === snap);
}

// ---- window equality (controller ruling): a row's v2 depends only on its own window ------------------
{
  const k = fingerprintSeries();
  const wk = measureWalks(1, 1600, 47, H)[0];
  // 1m bars: 1,000 bars span < 1 day, so the session-anchored VWAP is truncated by the window start
  // (the case where v2RowAt over the longer series differs from the row's own window by ~1e-2).
  const wk1m = measureWalks(1, 1600, 53, 60_000)[0];
  let bad = "", n = 0;
  for (const [series, iv] of [[k, H], [wk, H], [wk1m, 60_000], [walk4h, H4]]) {
    for (const t of [1000, 1050, 1099, ...(series.length > 1100 ? [1300, 1599] : [])]) {
      const longer = scoreV2(series.slice(0, t + 1), optsOf(series, iv));
      const own = scoreV2(series.slice(t - 999, t + 1), optsOf(series, iv));
      const a = v2Compact(longer, series[t].time), b = v2Compact(own, series[t].time);
      n++;
      if (!a || !b || a.s !== b.s || a.m !== b.m || a.st !== b.st || !deq(longer, own)) bad = `iv=${iv} t=${t}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
    }
  }
  ok(`scoreV2 on a series longer than 1,000 bars equals the row's own window exactly (s, m, st and the whole result; ${n} rows incl. 1m)`, bad === "", bad);
}

// ---- consecutive rows agree (Review Focus 1) --------------------------------------------------------
const heldSeen = [];
{
  const fixtures = [
    ...measureWalks(2, 1600).map((k, i) => [`walk${i} 4h`, k, H4]),
    ["fingerprint 1h", fingerprintSeries(), H],
  ];
  let agree = 0, total = 0, labelled = 0;
  for (const [, k, iv] of fixtures) {
    let prevMaster = null;
    for (let t = 1000; t < k.length; t++) {
      const w = k.slice(t - 999, t + 1);
      const r = scoreV2(w, optsOf(w, iv));
      if (r.held) heldSeen.push(r);
      if (r.master !== "NEUTRAL") labelled++;
      if (prevMaster !== null) {
        // Row t-1's label vs the in-window state at t-1 computed inside row t's window.
        const from = Math.max(0, w.length - V2_HYST_BARS);
        const st = v2States(v2ScoreSeries(w, inner(w, iv), from), from)[w.length - 2];
        total++;
        if (SIGN[prevMaster] === st) agree++;
      }
      prevMaster = r.master;
    }
  }
  const rate = agree / total;
  console.log(`  continuity: ${agree}/${total} consecutive rows agree (${(100 * rate).toFixed(2)} %); labelled rows ${labelled}`);
  ok("consecutive rows agree on >= 99 % of fixture bars", total > 1000 && rate >= 0.99, `${rate}`);
}
ok("held bars are never STRONG (and the fixtures contain held bars)", heldSeen.length > 0 && heldSeen.every((r) => r.strength === "MODERATE"),
  `held=${heldSeen.length}`);

// ---- gaps, cold windows and hostile inputs (Review Focus 2) -------------------------------------------
{
  const k = fingerprintSeries().slice(0, 1000).map((b, i) => (i >= 950 ? { ...b, time: b.time + 10 * H } : b));
  const tail = contiguousTail(k, H);
  let r;
  ok("a gap restarts from NEUTRAL like every path: contiguousTail gives 50 bars, unusable, no throw",
    noThrow(() => { r = scoreV2(tail, optsOf(tail, H)); }) && tail.length === 50 && r.usable === false && r.master === "NEUTRAL");
  ok("unusable rows compact to null", v2Compact(r, r.t) === null);
}
{
  // Cold window: 200 bars, fewer than V2_HYST_BARS scored bars; hysteresis runs from bar 0.
  const w = fingerprintSeries().slice(0, 200);
  let r;
  ok("cold window (200 bars) scores without throwing", noThrow(() => { r = scoreV2(w, optsOf(w, H)); }) && r.usable && r.warmBars === 200);
  const scores = v2ScoreSeries(w, inner(w, H), 0);
  ok("cold window: master is the hysteresis from bar 0 over the warm-up nulls", SIGN[r.master] === runHysteresis(scores, 0)
    && scores.slice(0, 100).every((s) => s === null));
}
{
  const flat = Array.from({ length: 400 }, (_, i) => ({ time: Date.UTC(2025, 0, 1) + i * H, open: 100, high: 100, low: 100, close: 100, volume: 1000 }));
  let r;
  ok("flat series (sigma = 0, ATR = 0): suppressed NEUTRAL, no NaN, no throw", noThrow(() => { r = scoreV2(flat, optsOf(flat, H)); })
    && r.usable && r.suppressed && r.master === "NEUTRAL" && r.score === 0 && r.inputs.every((x) => x.z === null));
  const lm = v2LineModel(r);
  ok("flat series line model: no data", lm.key === "v2.lineNoData");
}
{
  const fp = fingerprintSeries().slice(0, 1000);
  const hostile = [
    ["empty", []],
    ["one bar", fp.slice(0, 1)],
    ["NaN last close", fp.map((b, i) => (i === 999 ? { ...b, close: NaN } : b))],
    ["Infinity volume", fp.map((b, i) => (i % 50 === 0 ? { ...b, volume: Infinity } : b))],
    ["negative volume", fp.map((b) => ({ ...b, volume: -b.volume }))],
    ["NaN highs", fp.map((b, i) => (i > 900 ? { ...b, high: NaN } : b))],
    ["zero prices", fp.map((b, i) => (i > 900 ? { ...b, open: 0, high: 0, low: 0, close: 0 } : b))],
  ];
  const bad = [];
  for (const [name, k] of hostile) {
    for (const iv of [H, H4, 30 * DAY]) {
      try {
        const r = scoreV2(k, optsOf(k, iv));
        const finiteOk = Number.isFinite(r.score) && r.inputs.every((x) => x.z === null || (Number.isFinite(x.z) && Math.abs(x.z) <= 1));
        const c = v2Compact(r, r.t);
        if (!finiteOk || (c && c.s !== null && !Number.isInteger(c.s))) bad.push(`${name}@${iv}: non-finite`);
        v2LineModel(r);
      } catch (e) { bad.push(`${name}@${iv}: threw ${e && e.message}`); }
    }
  }
  ok("hostile inputs never throw and never give a non-finite score", bad.length === 0, bad.join(" | "));
  ok("empty series: unusable", scoreV2([], optsOf([], H)).usable === false);
}
{
  // FX: the low-volatility cap is off. Same window, fx vs crypto, differ only where the cap applies.
  const w = fingerprintSeries().slice(0, 1000);
  const a = scoreV2(w, { intervalMs: H, volumeAvailable: true, assetClass: "fx" });
  const b = scoreV2(w, { intervalMs: H, volumeAvailable: true });
  ok("FX scores like crypto apart from the strength cap", a.score === b.score && a.master === b.master
    && a.strength === v2Strength(a.master, a.score, a.lowVolatility, true));
}
{
  // 4h boundary and 1M bars.
  const w = walk4h.slice(-1000);
  const below = scoreV2(w, optsOf(w, H4 - 1)), at = scoreV2(w, optsOf(w, H4)), month = scoreV2(w, optsOf(w, 30 * DAY));
  const drop = (r) => r.inputs.filter((x) => x.dropped).map((x) => x.id).join();
  ok("4h - 1 ms: nothing dropped, 18 voters", below.voters === 18 && !below.dropped && drop(below) === "");
  ok("4h and 1M: the four contrarian oscillators dropped, 14 voters, z null", at.voters === 14 && at.dropped && month.dropped
    && drop(at) === "rsi,stochastic,williams,mfi" && drop(month) === drop(at)
    && at.inputs.filter((x) => x.dropped).every((x) => x.z === null) && Number.isFinite(month.score));
}

// ---- v2Compact ---------------------------------------------------------------------------------------
{
  const w = fingerprintSeries().slice(0, 1000);
  const r = scoreV2(w, optsOf(w, H));
  const c = v2Compact(r, r.t);
  ok("v2Compact maps the result", c && c.cfg === v2ConfigId() && c.s === r.score && c.m === SIGN[r.master]
    && c.st === { WEAK: 0, MODERATE: 1, STRONG: 2 }[r.strength] && Object.keys(c).sort().join() === "cfg,m,s,st", JSON.stringify(c));
  const sup = { ...r, suppressed: true, master: "NEUTRAL", strength: "WEAK", score: 0, held: false };
  ok("suppressed -> s null, m 0, st 0", deq(v2Compact(sup, r.t), { cfg: v2ConfigId(), s: null, m: 0, st: 0 }));
  ok("unusable -> null", v2Compact({ ...r, usable: false }, r.t) === null);
  ok("t mismatch -> null", v2Compact(r, r.t + 1) === null && v2Compact(r, NaN) === null);
  ok("missing result -> null", v2Compact(null, r.t) === null && v2Compact(undefined, r.t) === null);
  const strong = { ...r, master: "BEARISH", strength: "STRONG", score: -80, suppressed: false };
  ok("BEARISH STRONG -> m -1, st 2", deq(v2Compact(strong, r.t), { cfg: v2ConfigId(), s: -80, m: -1, st: 2 }));
}

// ---- v2LineModel ---------------------------------------------------------------------------------------
{
  const w = fingerprintSeries().slice(0, 1000);
  const r = scoreV2(w, optsOf(w, H));
  ok("suppressed -> v2.lineNoData", v2LineModel({ ...r, suppressed: true }).key === "v2.lineNoData"
    && v2LineModel(null).key === "v2.lineNoData" && v2LineModel(undefined).key === "v2.lineNoData"
    && v2LineModel({ ...r, usable: false }).key === "v2.lineNoData");
  const held = heldSeen[0];
  const lm = v2LineModel(held);
  ok("held -> v2.lineHeld with exit 40", lm.key === "v2.lineHeld" && lm.vars.exit === 40 && lm.master === held.master
    && lm.vars.score === `${held.score > 0 ? "+" : ""}${held.score}`, JSON.stringify(lm));
  const live = v2LineModel({ ...r, suppressed: false, held: false, score: 62, master: "BULLISH", strength: "MODERATE" });
  ok("unheld -> v2.line, score formatted like the MiniStat", live.key === "v2.line" && live.vars.score === "+62" && live.strength === "MODERATE"
    && v2LineModel({ ...r, suppressed: false, held: false, score: -7, master: "NEUTRAL" }).vars.score === "-7"
    && v2LineModel({ ...r, suppressed: false, held: false, score: 0, master: "NEUTRAL" }).vars.score === "0");
  const w4 = walk4h.slice(-1000);
  ok("4h -> dropped true; 1h -> false", v2LineModel(scoreV2(w4, optsOf(w4, H4))).dropped === true && lm.dropped === true
    && v2LineModel(r).dropped === false);
}

const V2_PIN = "e2c5b7a6240ef664";

// ---- config ids ------------------------------------------------------------------------------------------
{
  const a = v2ConfigId();
  ok("v2ConfigId is 16 hex, stable, and not Classic's", /^[0-9a-f]{16}$/.test(a) && a === v2ConfigId() && a !== engineConfigId(), a);
  ok("Classic's config id is unchanged after importing v2", engineConfigId() === "5c30b5c39f5ba3f2", engineConfigId());
  ok("v2Fingerprint is a 16-hex hash and repeatable", /^[0-9a-f]{16}$/.test(v2Fingerprint()) && v2Fingerprint() === v2Fingerprint());
  console.log(`  v2ConfigId() = ${a}`);
  ok("v2 config id pinned", a === V2_PIN, `${a} !== ${V2_PIN}`);

  // Review M1: the bloc, the volume requirement and the divisor-floor scale of every input are hashed.
  const idOf = (params) => hash64(stableStringify({ engine: "confluence-v2", params, behaviour: v2Fingerprint() }));
  ok("V2_PARAMS reproduces v2ConfigId", idOf(V2_PARAMS) === a);
  const fields = ["inputBlocs", "inputVolume", "inputScaleKind"];
  ok("V2_PARAMS carries bloc, volume and scale kind for all 18 inputs",
    fields.every((f) => Array.isArray(V2_PARAMS[f]) && V2_PARAMS[f].length === 18 && V2_PARAMS[f].every((e, i) => e[0] === V2_INPUTS[i].id)));
  const flip = { inputBlocs: (v) => (v === "trend" ? "flow" : "trend"), inputVolume: (v) => !v, inputScaleKind: (v) => (v === "price" ? "osc" : "price") };
  const unchanged = [];
  for (const f of fields) for (let i = 0; i < 18; i++) {
    const p = structuredClone(V2_PARAMS);
    p[f][i][1] = flip[f](p[f][i][1]);
    if (idOf(p) === a) unchanged.push(`${f}[${i}]`);
  }
  ok("changing any input's bloc, volume flag or scale kind changes the v2 config id", unchanged.length === 0, unchanged.join(" "));
}

// ---- exactly-rounded maths only ------------------------------------------------------------------------
{
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const bad = [];
  for (const file of ["confluence-v2.ts", "confluence-v2-inputs.ts"]) {
    const code = strip(readFileSync(new URL(`./${file}`, import.meta.url), "utf8"));
    for (const f of ["Math.exp", "Math.log", "Math.pow", "Math.sin", "Math.cos"]) if (code.includes(f)) bad.push(`${file}: ${f}`);
    if (code.includes("**")) bad.push(`${file}: **`);
    const used = new Set([...code.matchAll(/Math\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));
    for (const u of used) if (!["sqrt", "abs", "min", "max", "round"].includes(u)) bad.push(`${file}: Math.${u}`);
  }
  ok("exactly-rounded maths only (no exp/log/pow/sin/cos/**; Math.* limited to sqrt/abs/min/max/round)", bad.length === 0, bad.join(" "));
}

// ---- per-window cost (reported; the budget is Task 6's) ---------------------------------------------
{
  const T = () => Number(process.hrtime.bigint()) / 1e6;
  const fp = fingerprintSeries();
  for (const [label, iv] of [["1h", H], ["4h", H4]]) {
    const wins = [];
    for (let end = 1000; end <= 1100; end += 5) wins.push(fp.slice(end - 1000, end));
    const o = optsOf(fp, iv);
    for (let i = 0; i < 5; i++) { scoreV2(wins[i], o); scoreSeries(wins[i], o); }
    let v2 = 0, cl = 0;
    for (let rep = 0; rep < 3; rep++) for (const w of wins) {
      let t0 = T(); scoreV2(w, o); v2 += T() - t0;
      t0 = T(); scoreSeries(w, o); cl += T() - t0;
    }
    const nCalls = 3 * wins.length;
    console.log(`  bench ${label}: scoreV2 ${(v2 / nCalls).toFixed(3)} ms/window; scoreSeries ${(cl / nCalls).toFixed(3)} ms/window; ratio ${(v2 / cl).toFixed(2)}`);
  }
  ok("bench ran", true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
