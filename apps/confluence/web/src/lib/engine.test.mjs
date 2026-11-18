// Engine regression suite — Build 2.02.
// Run: npm run test:engine   (node scripts/run-engine-tests.mjs)
//
// Each block pins a defect found in the Build 2.01 code review so it cannot
// silently return. Probes run against the real engine modules.
import {
  runConfluence, indRSI, indMFI, indCCI, NEUTRAL_BAND, STRONG_BAND, INDICATORS,
} from "./indicators.ts";
import { detectFVG, fvgModifier } from "./fvg.ts";
import { detectHistoricalPattern, clearPatternCache, patternConfidence, patternAbstainKey, PATTERN_PARAMS } from "./pattern-signal.ts";
import { wilson } from "./ledger-metrics.ts";
import { detectReversal } from "./reversal.ts";
import { barCloseTime, contiguousTail, dropUnclosed, INTERVAL_MS } from "./market-client.ts";

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log("  ok   - " + name); }
  else { failed++; console.log("  FAIL - " + name + (extra ? "  [" + extra + "]" : "")); }
};
const H = 3600e3;
const T0 = Date.UTC(2026, 0, 1);

// Deterministic RNG + series builders ------------------------------------
let seed = 4242;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
function fromCloses(closes, t0 = T0, step = H) {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { time: t0 + i * step, open: o, high: Math.max(o, c) * 1.002, low: Math.min(o, c) * 0.998, close: c, volume: 1000 + ((i * 7919) % 500) };
  });
}
function randomWalk(n, vol) {
  const out = []; let px = 100;
  for (let i = 0; i < n; i++) {
    const o = px; px *= Math.exp(gauss() * vol);
    out.push({ time: T0 + i * H, open: o, high: Math.max(o, px) * (1 + Math.abs(gauss()) * vol * 0.4), low: Math.min(o, px) * (1 - Math.abs(gauss()) * vol * 0.4), close: px, volume: 1000 * Math.exp(gauss() * 0.5) });
  }
  return out;
}

console.log("\n== Panel structure ==");
{
  const k = fromCloses(Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 7)));
  const r = runConfluence(k, { intervalMs: H });
  const voting = r.indicators.filter((i) => !i.informational);
  ok("21 indicators, 18 voting", INDICATORS.length === 21 && voting.length === 18, `${INDICATORS.length}/${voting.length}`);
  ok("CCI 20 belongs to the trend bloc (2.02)", indCCI(k).bloc === "trend");
}

console.log("\n== M1: FVG sees the newest CLOSED bar ==");
{
  const base = fromCloses(Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 5)));
  const p = base.at(-1).close;
  const k = base.concat([{ time: base.at(-1).time + H, open: p, high: p * 1.03, low: p * 1.025, close: p * 1.03, volume: 1000 }]);
  const newest = (z) => z.createdIndex === k.length - 1;
  ok("module default still excludes an unclosed final bar", !detectFVG(k).all.some(newest));
  ok("engine includes a gap formed on the newest closed bar", (runConfluence(k, { intervalMs: H }).fvgZones ?? []).some(newest));
  const fvgRow = runConfluence(k, { intervalMs: H }).indicators.find((i) => i.name.startsWith("FVG"));
  ok("FVG row counts that gap", fvgRow && fvgRow.value >= 1);
}

console.log("\n== M2: mean-reversion bloc is internally consistent ==");
{
  const up = fromCloses(Array.from({ length: 200 }, (_, i) => 100 * Math.pow(1.01, i)));
  const r = runConfluence(up, { intervalMs: H });
  const mr = r.indicators.filter((i) => i.bloc === "meanReversion" && i.valid);
  ok("no mean-reversion member votes WITH a strong uptrend", mr.every((i) => i.state !== "BULLISH"), mr.map((i) => i.name + ":" + i.state).join(","));
  ok("strong clean uptrend is BULLISH (regime gate)", r.master === "BULLISH", `score ${r.score}`);
  ok("mean-reversion bloc is gated out in a persistent trend", r.blocs.find((b) => b.bloc === "meanReversion").weight === 0);
  ok("mean-reversion bloc keeps full weight in a range", runConfluence(fromCloses(Array.from({ length: 200 }, (_, i) => 100 + 3 * Math.sin(i / 4))), { intervalMs: H }).blocs.find((b) => b.bloc === "meanReversion").weight === 1);
  const down = fromCloses(Array.from({ length: 200 }, (_, i) => 100 * Math.pow(0.99, i)));
  ok("strong clean downtrend is BEARISH", runConfluence(down, { intervalMs: H }).master === "BEARISH");
}

console.log("\n== L3: flat / pegged series ==");
{
  const flat = fromCloses(Array.from({ length: 200 }, () => 1));
  ok("RSI on a flat series is 50 / NEUTRAL", indRSI(flat).value === 50 && indRSI(flat).state === "NEUTRAL");
  ok("MFI on a flat series is 50 / NEUTRAL", indMFI(flat).value === 50 && indMFI(flat).state === "NEUTRAL");
  ok("flat series master is NEUTRAL with score 0", runConfluence(flat, { intervalMs: H }).score === 0);
}

console.log("\n== M3: noise stays NEUTRAL; drift is detected (null calibration) ==");
{
  let n = 0, labelled = 0, strong = 0;
  for (const vol of [0.003, 0.01, 0.03]) for (let rep = 0; rep < 4; rep++) {
    const k = randomWalk(900, vol);
    for (let end = 200; end <= k.length; end += 10) {
      const c = runConfluence(k.slice(end - 200, end), { intervalMs: H });
      if (c.suppressed) continue;
      n++;
      if (c.master !== "NEUTRAL") labelled++;
      if (c.strength === "STRONG") strong++;
    }
  }
  const lr = labelled / n, sr = strong / n;
  ok(`bands are ${NEUTRAL_BAND}/${STRONG_BAND}`, NEUTRAL_BAND === 55 && STRONG_BAND === 70);
  ok(`≤ 6% of random-walk bars get a direction (got ${(lr * 100).toFixed(1)}%)`, lr <= 0.06);
  ok(`≤ 2.5% of random-walk bars are STRONG (got ${(sr * 100).toFixed(1)}%)`, sr <= 0.025);
  // Power check: a persistent drift (per-bar Sharpe 0.5) must be labelled far
  // more often than noise, or the bands are merely suppressing everything.
  let dn = 0, dl = 0;
  for (let rep = 0; rep < 4; rep++) {
    const k = []; let px = 100;
    for (let i = 0; i < 600; i++) { const o = px; px *= Math.exp(0.005 + gauss() * 0.01); k.push({ time: T0 + i * H, open: o, high: Math.max(o, px) * 1.003, low: Math.min(o, px) * 0.997, close: px, volume: 1000 }); }
    for (let end = 200; end <= 600; end += 10) { const c = runConfluence(k.slice(end - 200, end), { intervalMs: H }); if (c.suppressed) continue; dn++; if (c.master === "BULLISH") dl++; }
  }
  ok(`drifting series labelled BULLISH ≥ 50% of bars (got ${((dl / dn) * 100).toFixed(0)}%)`, dl / dn >= 0.5);
}

console.log("\n== M5: calendar-correct monthly close ==");
{
  const M = INTERVAL_MS["1M"];
  ok("October bar closes 1 Nov", barCloseTime(Date.UTC(2026, 9, 1), M) === Date.UTC(2026, 10, 1));
  ok("February bar closes 1 Mar", barCloseTime(Date.UTC(2026, 1, 1), M) === Date.UTC(2026, 2, 1));
  const bars = [Date.UTC(2026, 8, 1), Date.UTC(2026, 9, 1)].map((t) => ({ time: t, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
  ok("on 31 Oct the unfinished October bar is dropped", dropUnclosed(bars, M, Date.UTC(2026, 9, 31, 6)).length === 1);
  const feb = [{ time: Date.UTC(2026, 1, 1), open: 1, high: 1, low: 1, close: 1, volume: 1 }];
  ok("on 2 Mar the finished February bar is kept", dropUnclosed(feb, M, Date.UTC(2026, 2, 2, 12)).length === 1);
  ok("hourly close unchanged", barCloseTime(T0, H) === T0 + H);
}

console.log("\n== M4: contiguity ==");
{
  const a = fromCloses(Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 9)));
  const b = fromCloses(Array.from({ length: 200 }, (_, i) => 112 + Math.sin(i / 9)), a.at(-1).time + 300 * H);
  const merged = a.concat(b);
  const tail = contiguousTail(merged, H);
  ok("gap of 300 bars trims to the newest run", tail.length === 200 && tail[0].time === b[0].time);
  ok("contiguous series is untouched", contiguousTail(a, H).length === 200);
  ok("no spurious FVG across the trimmed hole", detectFVG(tail, { lastBarClosed: true }).all.every((z) => z.bottom > 105));
  const months = [0, 1, 2, 3].map((m) => ({ time: Date.UTC(2026, m, 1), open: 1, high: 1, low: 1, close: 1, volume: 1 }));
  ok("calendar months (28–31 days) count as contiguous", contiguousTail(months, INTERVAL_MS["1M"]).length === 4);
}

console.log("\n== L4: FVG magnet distance option is live ==");
{
  const c = (t, o, h, l, cl) => ({ time: T0 + t * H, open: o, high: h, low: l, close: cl, volume: 1 });
  // bull gap [12, 15] from bars 0-2, then price holds above it without filling
  const k = [c(0, 10, 12, 10, 11), c(1, 12, 16, 12, 15.5), c(2, 15, 17, 15.2, 16), c(3, 16, 18, 15.6, 17), c(4, 17, 19, 16, 18)];
  const wide = fvgModifier(k, "sell", 15.5, { lastBarClosed: true, nearZoneAtrMult: 50 }).modifier;
  const tight = fvgModifier(k, "sell", 15.5, { lastBarClosed: true, nearZoneAtrMult: 0.01 }).modifier;
  ok("nearZoneAtrMult changes the result", wide < 1 && tight === 1, `${wide} vs ${tight}`);
}

console.log("\n== H3 / L9: analogue engine ==");
{
  const k = fromCloses(Array.from({ length: 3000 }, (_, i) => 100 + 10 * Math.sin(i / 37) + 4 * Math.sin(i / 11) + i * 0.002));
  const c = runConfluence(k.slice(-1000), { intervalMs: H });
  const r = { ...detectReversal(k.slice(-1000)), direction: "UP" };
  clearPatternCache();
  const t1 = performance.now();
  const p1 = detectHistoricalPattern(k, { volumeAvailable: true, intervalMs: H, currentConfluence: c, currentReversal: r, cacheKey: "test:1h:X" });
  const cold = performance.now() - t1;
  const t2 = performance.now();
  const p2 = detectHistoricalPattern(k, { volumeAvailable: true, intervalMs: H, currentConfluence: c, currentReversal: r, cacheKey: "test:1h:X" });
  const warm = performance.now() - t2;
  ok(`memoised rerun is ≥5× faster (cold ${cold.toFixed(0)} ms, warm ${warm.toFixed(1)} ms)`, warm * 5 <= cold);
  ok("memoised rerun gives the identical result", JSON.stringify(p1) === JSON.stringify(p2));
  const times = p1.analogues.map((a) => a.time).sort((x, y) => x - y);
  ok("analogue outcome windows never overlap (≥ 6 bars apart)", times.every((t, i) => i === 0 || t - times[i - 1] >= 6 * H));
  ok("base rate is reported", typeof p1.baseRate === "number" && p1.baseRate >= 0 && p1.baseRate <= 1);
  ok("a direction requires ≥ 20 analogues (v2.8)", p1.direction === "NONE" || p1.matches >= 20);
  ok("at most 40 analogues are used (v2.8)", p1.matches <= 40);
  // v2.8 (WP19): the Wilson 95% lower bound of the hit rate must exceed the base rate by > 2 pts.
  const lb = (p) => wilson(Math.round(p.winRate * p.matches), p.matches, 1.96)[0];
  ok("a direction needs Wilson lower bound > base rate + 0.02", p1.direction === "NONE" || lb(p1) > p1.baseRate + 0.02);
  ok("the signal reports its Wilson lower bound", p1.direction === "NONE" || Math.abs((p1.lowerBound ?? -1) - lb(p1)) < 1e-9);
  const short = fromCloses(Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 6)));
  const ps = detectHistoricalPattern(short, { volumeAvailable: true, intervalMs: H, currentConfluence: runConfluence(short, { intervalMs: H }), currentReversal: { ...detectReversal(short), direction: "UP" } });
  ok("200 bars of history cannot produce a directional analogue call", ps.direction === "NONE");
}

console.log("\n== WP19 wording: Pattern abstain label ==");
{
  ok("too few analogues -> pattern.tooFew", patternAbstainKey({ tooFew: true }) === "pattern.tooFew");
  ok("a comparison that found no excess -> pattern.none", patternAbstainKey({}) === "pattern.none" && patternAbstainKey({ tooFew: false }) === "pattern.none");
  // The real abstain path: 1-19 analogues sets tooFew; a gate failure with >= 20 does not.
  let seen = 0, bad = 0;
  for (let seed = 1; seed <= 12 && seen < 1; seed++) {
    let x = seed * 7919;
    const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
    const k = fromCloses(Array.from({ length: 700 }, (_, i) => 100 + 6 * Math.sin(i / (9 + seed)) + 3 * Math.sin(i / 4) + (rnd() - 0.5) * 2));
    clearPatternCache();
    const p = detectHistoricalPattern(k, { volumeAvailable: true, intervalMs: H, currentConfluence: runConfluence(k, { intervalMs: H }), currentReversal: { ...detectReversal(k), direction: "UP" } });
    if (p.matches >= 1 && p.matches < 20) { seen++; if (p.tooFew !== true || patternAbstainKey(p) !== "pattern.tooFew") bad++; }
    if (p.matches >= 20 && p.tooFew) bad++;
  }
  ok("1-19 analogues carry tooFew (and >= 20 never do)", bad === 0 && seen >= 1, "seen=" + seen);
}

console.log("\n== H1 (v2.8): Pattern Wilson gate and confidence cut-offs ==");
{
  ok("MIN_MATCHES 20, MAX_MATCHES 40, MAX_HISTORY_ANCHORS 600",
    PATTERN_PARAMS.minMatches === 20 && PATTERN_PARAMS.maxMatches === 40 && PATTERN_PARAMS.maxHistoryAnchors === 600, JSON.stringify(PATTERN_PARAMS));
  // patternConfidence(wins, n, baseRate) → { direction called?, confidence, lowerBound }
  const at = (wins, n, base) => patternConfidence(wins, n, base);
  ok("20 / 20 hits vs 50% base → HIGH (lower bound 0.839)", at(20, 20, 0.5).confidence === "HIGH" && at(20, 20, 0.5).called);
  // 14/20: lower bound 0.481 → excess −0.019 at base 0.5 → abstain
  ok("14 / 20 vs 50% base abstains (lower bound below base + 0.02)", !at(14, 20, 0.5).called && at(14, 20, 0.5).confidence === "NONE");
  // 30/40 = 0.75: lower bound ≈ 0.598; excess over 0.55 ≈ 0.048 → LOW; over 0.50 ≈ 0.098 → MODERATE; over 0.49 ≈ 0.108 → HIGH
  ok("excess just under 0.05 is LOW", at(30, 40, 0.55).confidence === "LOW", String(at(30, 40, 0.55).lowerBound));
  ok("excess in [0.05, 0.10) is MODERATE", at(30, 40, 0.50).confidence === "MODERATE");
  ok("excess ≥ 0.10 is HIGH", at(30, 40, 0.49).confidence === "HIGH");
  const lb30 = wilson(30, 40)[0];
  ok("excess must be strictly greater than +0.02", !at(30, 40, lb30 - 0.02 + 1e-12).called && at(30, 40, lb30 - 0.021).called);
  ok("lower bound equals wilson(wins, n, 1.96)[0]", Math.abs(at(30, 40, 0.5).lowerBound - wilson(30, 40, 1.96)[0]) < 1e-12);
}

console.log("\n== Evidence floor, volume handling, determinism ==");
{
  const k = fromCloses(Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 7) * 3));
  const nv = runConfluence(k, { intervalMs: H, volumeAvailable: false });
  ok("no-volume source excludes flow + MFI and still scores", !nv.suppressed && nv.blocs.find((b) => b.bloc === "flow").valid === 0);
  ok("deterministic", JSON.stringify(runConfluence(k, { intervalMs: H })) === JSON.stringify(runConfluence(k, { intervalMs: H })));
  const thin = fromCloses(Array.from({ length: 12 }, (_, i) => 100 + i));
  ok("thin series is suppressed, not neutral", runConfluence(thin, { intervalMs: H }).suppressed === true);
}

{
  const { VOTING_INDICATORS, normalizeScoringProfile } = await import("./scoring-profile.ts");
  const { engineConfigId } = await import("./engine-config.ts");
  const k = fromCloses(Array.from({ length: 1000 }, (_, i) => 100 + i * 0.01 + Math.sin(i / 7)));
  const enabled = VOTING_INDICATORS.map((indicator) => indicator.id);
  const all = { version: 1, enabled };
  ok("all-enabled scoring profile normalizes to default", normalizeScoringProfile(all) === null);
  ok("shipped fingerprint is preserved (engine 2.4.0)", engineConfigId() === "5c30b5c39f5ba3f2", engineConfigId());
  ok("explicit all-enabled profile preserves every default result",
    JSON.stringify(runConfluence(k)) === JSON.stringify(runConfluence(k, { profile: all })));
  const profile = { version: 1, enabled: ["rsi", "stochastic"] };
  ok("profile config ID is canonical", engineConfigId(profile) === engineConfigId({ version: 1, enabled: ["stochastic", "rsi"] }));
  ok("custom profile has a different ID", engineConfigId(profile) !== engineConfigId());
  ok("all-disabled scoring profile suppresses", runConfluence(k, { profile: { version: 1, enabled: [] } }).suppressed);
  const custom = runConfluence(k, { profile });
  ok("disabled voting groups have no active voters",
    custom.blocs.filter((bloc) => bloc.bloc !== "meanReversion").every((bloc) => bloc.valid === 0));
  const volume = runConfluence(k, { volumeAvailable: false, profile: { version: 1, enabled: ["obv", "cmf"] } });
  ok("missing volume suppresses a volume-only profile", volume.suppressed);
  const { scoreSeries, toLedgerRow } = await import("./scan-pipeline.ts");
  const { runScanJobSafe, packKlines } = await import("./scan-jobs.ts");
  const direct = scoreSeries(k, { intervalMs: H, volumeAvailable: true, profile });
  const job = runScanJobSafe({ key: "profile-fixture", packed: packKlines(k), intervalMs: H, volumeAvailable: true, profile });
  ok("worker job and direct profile scoring agree", JSON.stringify(direct) === JSON.stringify(job.score));
  const row = toLedgerRow(k, direct, { src: "binance", tf: "1h", pair: "BTCUSDT", ac: "crypto",
    intervalMs: H, closeTime: k.at(-1).time + H, rank: 1, quoteVolume: 1, appVersion: "test", live: true });
  ok("profile identity reaches ledger row and dedupe ID", row.cfg === engineConfigId(profile) && row.id.startsWith(row.cfg + "|"));
  let invalid = 0;
  for (const value of [{ version: 2, enabled }, { version: 1, enabled: ["unknown"] }, { version: 1, enabled: ["rsi", "rsi"] }]) {
    try { normalizeScoringProfile(value); } catch { invalid++; }
  }
  ok("profile imports reject invalid versions, IDs and duplicates", invalid === 3);
}
// WP19: macro calendar through 2027, event blackout, coverage warning ---------
console.log("\nMacro calendar (WP19)");
{
  const { MACRO_EVENTS, coverageUntil, coverageWarnings, inBlackout } = await import("./macro-calendar.ts");
  const mod = await import("./macro-calendar.ts");
  const cpi = MACRO_EVENTS.find((e) => e.id === "cpi-2027-06-10");
  const ecb = MACRO_EVENTS.find((e) => e.kind === "ecb" && e.verified);
  ok("MACRO_CALENDAR_UNTIL is gone", !("MACRO_CALENDAR_UNTIL" in mod));
  ok("CPI coverage reaches December 2027", coverageUntil("cpi") >= Date.UTC(2027, 11, 1));
  ok("NFP coverage reaches December 2027", coverageUntil("nfp") >= Date.UTC(2027, 11, 1));
  ok("every event has a boolean verified flag", MACRO_EVENTS.every((e) => typeof e.verified === "boolean"));
  ok("2027 BLS CPI 10 Jun 2027 at 12:30 UTC (08:30 EDT)", cpi && cpi.at === Date.UTC(2027, 5, 10, 12, 30));
  ok("CPI -2 h is inside the blackout", inBlackout(cpi.at - 2 * H)?.id === cpi.id);
  ok("CPI +1 h is inside the blackout", inBlackout(cpi.at + H)?.id === cpi.id);
  ok("CPI +1 h 01 min is outside the blackout", inBlackout(cpi.at + H + 60e3) === null);
  ok("CPI -2 h 01 min is outside the blackout", inBlackout(cpi.at - 2 * H - 60e3) === null);
  ok("ECB is informational, never blocking", inBlackout(ecb.at) === null);
  // K-Dense v2 (18 Nov 2026) A-L2: the Fed's 12 Nov 2026 release makes 26-27 Oct 2027 a strategy-only meeting (no
  // policy decision), so 27 Oct 2027 14:00 ET (18:00 UTC) is not a blackout and not listed as an FOMC decision.
  ok("A-L2: 27 Oct 2027 18:00 UTC (strategy-only FOMC meeting) is not a blackout", inBlackout(Date.UTC(2027, 9, 27, 18, 0)) === null);
  ok("A-L2: no FOMC decision event on 2027-10-27", !MACRO_EVENTS.some((e) => e.id === "fomc-2027-10-27"));
  ok("A-L2: 17 Nov 2027 FOMC decision still blocks", inBlackout(Date.UTC(2027, 10, 17, 19, 0))?.id === "fomc-2027-11-17");
  // Unverified dates are ignored by blocking and coverage.
  const fake = { id: "cpi-fake", label: "US CPI", kind: "cpi", at: Date.UTC(2030, 0, 15, 13, 30), verified: false };
  MACRO_EVENTS.push(fake);
  ok("unverified date is ignored by inBlackout", inBlackout(fake.at) === null);
  ok("unverified date is ignored by coverageUntil", coverageUntil("cpi") < fake.at);
  MACRO_EVENTS.pop();
  // Banner warning: any kind with < 30 days left.
  const dec15 = Date.UTC(2027, 11, 15);
  ok("banner warns when any kind has < 30 days left (clock 2027-12-15)", coverageWarnings(dec15).length > 0 && coverageWarnings(dec15).includes("cpi"));
  ok("no warning on release day (15 Nov 2026)", coverageWarnings(Date.UTC(2026, 10, 15)).length === 0, coverageWarnings(Date.UTC(2026, 10, 15)).join());
}
console.log("\nEngine regression: " + passed + "/" + (passed + failed) + " passed");
process.exit(failed === 0 ? 0 : 1);
