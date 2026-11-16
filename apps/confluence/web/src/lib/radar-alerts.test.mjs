// Radar alerts and their feeds — v2.8 Step 4a (WP25, Task 4).
// Run: npm run test:radar-alerts   (node scripts/run-engine-tests.mjs radar-alerts.test.mjs)
import {
  DEFAULT_THRESHOLDS, sanitizeThresholds, breakAway, volumeSpike, depegAlerts, supplyJump, setAlertsClockForTests, ALERT_CODE,
} from "./radar/alerts.ts";
import {
  fetchBreakAwayCloses, fetchDailyVolumes, fetchDailyVolumesDetailed, setFeedClockForTests, BREAKAWAY_BARS,
} from "./radar/breakaway-feed.ts";
import { standingPremiumMedian } from "./radar/regional.ts";
import { RateLimitError } from "./market-client.ts";

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} ${extra}`); }
};
const H = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 16, 12, 30, 0);
const th = { ...DEFAULT_THRESHOLDS };
setAlertsClockForTests(() => NOW);
setFeedClockForTests(() => NOW);
const lastHour = Math.floor(NOW / H) * H;

console.log("breakaway");
const flat = (v, n = 2) => Array(n).fill(v);
const four = { binance: flat(100), bybit: flat(100), bitget: flat(100), okx: flat(100) };
{
  const a = breakAway({ ...four, coinbase: flat(101.2) }, {}, th);
  ok("coinbase +1.2 % for 2 bars: one BREAKAWAY_COINBASE", a.length === 1 && a[0].code === "BREAKAWAY_COINBASE" && a[0].kind === "breakaway", JSON.stringify(a));
  ok("alert has source url, i18n key, vars", a[0].sourceUrl.startsWith("https://") && a[0].trigger.key === "radar.alert.breakaway" && a[0].trigger.vars.venue === "Coinbase" && a[0].trigger.vars.bars === 2 && a[0].trigger.vars.pct === 1.2, JSON.stringify(a[0]));
  ok("since = close of the first bar of the run (default clock)", a[0].since === lastHour - H, String(a[0].since));
  const b = breakAway({ ...four, coinbase: [100, 101.2] }, {}, th);
  ok("only 1 bar over the line: none", b.length === 0);
  const c = breakAway({ ...four, coinbase: [101.2, 100] }, {}, th);
  ok("newest bar back inside: none", c.length === 0);
  const d = breakAway({ ...four, coinbase: flat(100.9) }, {}, th);
  ok("0.9 %: none", d.length === 0);
  const e = breakAway({ ...four, coinbase: flat(98.7) }, {}, th);
  ok("below also counts (-1.3 %)", e.length === 1 && e[0].trigger.vars.pct === -1.3);
  const f = breakAway({ ...four, coinbase: flat(101) }, {}, th);
  ok("exactly 1.0 % counts (>=)", f.length === 1);
  const times = [1000, 2000];
  const g = breakAway({ ...four, coinbase: flat(101.2) }, {}, th, times);
  ok("since from closeTimes", g[0].since === 1000);
  const run3 = breakAway({ ...four, coinbase: flat(101.2, 3), binance: flat(100, 3), bybit: flat(100, 3), bitget: flat(100, 3), okx: flat(100, 3) }, {}, th, [10, 20, 30]);
  ok("run of 3 bars: since = first bar of the run", run3.length === 1 && run3[0].since === 10 && run3[0].trigger.vars.bars === 3);
  const bars3 = breakAway({ ...four, coinbase: flat(101.2) }, {}, { ...th, breakAwayBars: 3 });
  ok("needs breakAwayBars bars (3 asked, 2 held)", bars3.length === 0);
  const bars1 = breakAway({ ...four, coinbase: [100, 101.2] }, {}, { ...th, breakAwayBars: 1 });
  ok("breakAwayBars 1 alerts on the newest bar", bars1.length === 1);
}
{
  const a = breakAway({ binance: flat(100), bybit: flat(100), coinbase: flat(101.5) }, {}, th);
  ok("needs two other venues: with 2 others it alerts", a.length === 1 && a[0].code === "BREAKAWAY_COINBASE");
  const b = breakAway({ binance: flat(100), coinbase: flat(101.5) }, {}, th);
  ok("only 1 other venue: no alert", b.length === 0);
  const c = breakAway({ binance: flat(100), bybit: [NaN, NaN], coinbase: flat(101.5) }, {}, th);
  ok("others without data do not count", c.length === 0);
  const d = breakAway({ binance: flat(100), bybit: [100, NaN], coinbase: flat(101.5) }, {}, th);
  ok("2 others needed on EVERY bar (bybit lacks the newest, so only 1 other there)", d.length === 0, JSON.stringify(d));
  const e = breakAway({ ...four, coinbase: [NaN, 101.5] }, {}, th);
  ok("a venue lacking a bar cannot alert", e.length === 0);
  const f = breakAway({ ...four, coinbase: [] }, {}, th);
  ok("empty series: none", f.length === 0);
}
{
    const a = breakAway({ ...four, upbit: flat(103.4) }, { upbit: 3 }, th);
  ok("standing premium removed: Upbit +3 % standing at +3.4 % gives none", a.length === 0, JSON.stringify(a));
  const b = breakAway({ ...four, upbit: flat(104.2) }, { upbit: 3 }, th);
  ok("Upbit at +4.2 % for 2 bars alerts", b.length === 1 && b[0].code === "BREAKAWAY_UPBIT", JSON.stringify(b));
  const c = breakAway({ ...four, upbit: flat(104.2) }, { upbit: null }, th);
  ok("standing null: Upbit excluded", c.length === 0);
  const d = breakAway({ ...four, upbit: flat(110), coinsph: flat(100.5) }, { upbit: null, coinsph: 0.5 }, th);
  ok("a null-standing venue is not a comparison either (no alert from the rest)", d.length === 0, JSON.stringify(d));
  const e = breakAway({ ...four, coinbase: flat(101.5), upbit: flat(103) }, { upbit: null }, th);
  ok("null-standing venue left out of the median; others still alert", e.length === 1 && e[0].code === "BREAKAWAY_COINBASE");
  const f = breakAway({ ...four, coinsph: flat(98.0) }, { coinsph: -1 }, th);
  ok("negative standing premium (-1 %): -2 % raw is about -1 % adjusted → alert", f.length === 1 && f[0].code === "BREAKAWAY_COINSPH", JSON.stringify(f));
}
{
  const a = breakAway({ ...four, coinbase: flat(101.2) }, {}, { breakAwayPct: NaN, breakAwayBars: 99, volumeZ: -1, supplyPctl: 50 });
  ok("breakAway sanitises its thresholds (falls back to defaults)", a.length === 1);
}

console.log("volume spike");
const vols = (last, n = 30) => [...Array.from({ length: n }, (_, i) => (i % 2 ? 90 : 110)), last];
{
  const a = volumeSpike(vols(140), th);
  ok("30 days mean 100 sd 10 then 140: VOL_SPIKE (z 4)", a?.code === "VOL_SPIKE" && a.kind === "volume" && a.trigger.vars.z === 4 && a.trigger.vars.pct === 40, JSON.stringify(a));
  ok("since = close of the latest closed day (default)", a.since === Math.floor(NOW / DAY) * DAY);
  ok("lastDayOpen sets since", volumeSpike(vols(140), th, 5 * DAY).since === 6 * DAY);
  ok("125 (z 2.5): none", volumeSpike(vols(125), th) === null);
  ok("30 days of history: null", volumeSpike(vols(140, 29), th) === null);
  ok("zero spread: null", volumeSpike([...Array(30).fill(100), 200], th) === null);
  ok("a drop is not a spike", volumeSpike(vols(40), th) === null);
  ok("non-finite value: null", volumeSpike([...vols(140).slice(0, 30), NaN], th) === null);
  ok("lower volumeZ threshold (2.5) alerts at 125", volumeSpike(vols(125), { ...th, volumeZ: 2.5 })?.code === "VOL_SPIKE");
  ok("uses only the last 31 days", volumeSpike([1e9, 5, ...vols(140)], th)?.code === "VOL_SPIKE");
}

console.log("depeg");
{
  const r = (coin, dev, level) => ({ coin, reference: "USDT", price: 1 + dev / 100, deviationPct: dev, level });
  const a = depegAlerts([r("USDC", -0.7, "watch"), r("FDUSD", 0.2, "watch"), r("USDE", 2.4, "severe")]);
  ok("DEPEG_<COIN> for tier watch or worse, none inside 0.5 %", a.length === 2 && a[0].code === "DEPEG_USDC" && a[1].code === "DEPEG_USDE", JSON.stringify(a));
  ok("depeg vars and kind", a[1].kind === "depeg" && a[1].trigger.key === "radar.alert.depeg" && a[1].trigger.vars.level === "severe" && a[1].trigger.vars.dev === 2.4 && a[1].trigger.vars.coin === "USDE");
  ok("depeg source url from providers", /^https:\/\//.test(a[0].sourceUrl) && a[0].since === NOW);
  ok("asOf and providerId", depegAlerts([r("USDC", 1, "warning")], "okx", 5)[0].since === 5 && depegAlerts([r("USDC", 1, "warning")], "okx")[0].sourceUrl.includes("okx.com"));
  ok("exactly 0.5 % counts", depegAlerts([r("USDC", 0.5, "watch")]).length === 1);
  ok("duplicate coin: the larger deviation", depegAlerts([r("USDC", 0.6, "watch"), r("USDC", -1.5, "warning")])[0].trigger.vars.dev === -1.5);
  ok("junk readings are skipped", depegAlerts([null, { coin: "X", deviationPct: NaN }, r("", 1, "warning"), r("USDC", 1, "warning")]).map((x) => x.code).join() === "DEPEG_USDC");
  ok("empty and non-array input", depegAlerts([]).length === 0 && depegAlerts(undefined).length === 0);
  ok("odd coin names stay safe", depegAlerts([r("us dc!", 1, "warning")]).every((x) => ALERT_CODE.test(x.code)) && depegAlerts([r("A".repeat(40), 1, "warning")]).length === 0);
}

console.log("supply jump");
{
  // 91 points: day 0 supply 1000, daily changes +1..+89 (prior) then today's change.
  const make = (todayDelta, n = 91) => {
    const pts = [{ day: 0, usd: 1_000_000 }];
    for (let i = 1; i < n - 1; i++) pts.push({ day: i * DAY, usd: pts[i - 1].usd + (i % 2 ? i : -i) });
    pts.push({ day: (n - 1) * DAY, usd: pts[n - 2].usd + todayDelta });
    return pts;
  };
  // |prior deltas| = 1..89, p99 (linear) = 1 + 0.99*88 = 88.12
  const a = supplyJump(make(100), th);
  ok("today's change above the 99th percentile: SUPPLY_JUMP", a?.code === "SUPPLY_JUMP" && a.kind === "supply" && a.trigger.key === "radar.alert.supply" && a.trigger.vars.pctl === 99, JSON.stringify(a));
  ok("supply since = today's point; source is DefiLlama", a.since === 90 * DAY && a.sourceUrl.includes("defillama"));
  ok("negative jump counts (|change|)", supplyJump(make(-100), th)?.code === "SUPPLY_JUMP");
  ok("below the percentile: none", supplyJump(make(80), th) === null);
  ok("at the percentile (88.12) is not above it", supplyJump(make(88.12), th) === null);
  ok("90 days of points: null", supplyJump(make(100, 90), th) === null);
  ok("lower percentile (90) alerts at 85, the 99th does not", supplyJump(make(85), { ...th, supplyPctl: 90 })?.code === "SUPPLY_JUMP" && supplyJump(make(85), th) === null);
  ok("older days than 90 prior are ignored", supplyJump([{ day: -4 * DAY, usd: 0 }, { day: -3 * DAY, usd: 5e9 }, { day: -2 * DAY, usd: 5e9 }, { day: -DAY, usd: 1_000_000 }, ...make(100)], th)?.code === "SUPPLY_JUMP");
  ok("bad point: null", supplyJump(make(100).map((p, i) => (i === 40 ? { ...p, usd: NaN } : p)), th) === null);
}

console.log("thresholds sanitize");
{
  const d = DEFAULT_THRESHOLDS;
  ok("defaults", d.breakAwayPct === 1 && d.breakAwayBars === 2 && d.volumeZ === 3 && d.supplyPctl === 99);
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  ok("non-objects give the defaults", [null, undefined, 5, "x", [], true].every((x) => eq(sanitizeThresholds(x), d)));
  ok("NaN / Infinity / strings / out of range fall back", eq(sanitizeThresholds({ breakAwayPct: NaN, breakAwayBars: Infinity, volumeZ: "4", supplyPctl: 100 }), d));
  ok("range edges are kept", eq(sanitizeThresholds({ breakAwayPct: 0.2, breakAwayBars: 6, volumeZ: 10, supplyPctl: 99.9 }), { breakAwayPct: 0.2, breakAwayBars: 6, volumeZ: 10, supplyPctl: 99.9 }));
  ok("just outside the range falls back", eq(sanitizeThresholds({ breakAwayPct: 0.19, breakAwayBars: 7, volumeZ: 1.4, supplyPctl: 89.9 }), d) && eq(sanitizeThresholds({ breakAwayPct: 10.1, breakAwayBars: 0, volumeZ: 10.1, supplyPctl: 99.91 }), d));
  ok("a fractional bar count falls back", sanitizeThresholds({ breakAwayBars: 2.5 }).breakAwayBars === 2 && sanitizeThresholds({ breakAwayBars: 3 }).breakAwayBars === 3);
  ok("valid values pass, bad ones fall back individually", eq(sanitizeThresholds({ breakAwayPct: 2, breakAwayBars: 99, volumeZ: 4, supplyPctl: NaN }), { breakAwayPct: 2, breakAwayBars: 2, volumeZ: 4, supplyPctl: 99 }));
  ok("unknown keys dropped, no mutation of defaults", !("extra" in sanitizeThresholds({ extra: 1, __proto__: { breakAwayPct: 5 } })) && sanitizeThresholds({ __proto__: { breakAwayPct: 5 } }).breakAwayPct === 1 && eq(DEFAULT_THRESHOLDS, { breakAwayPct: 1, breakAwayBars: 2, volumeZ: 3, supplyPctl: 99 }));
}

console.log("codes are safe");
{
  const all = [
    ...breakAway({ ...four, coinbase: flat(101.2), upbit: flat(104.2), "weird venue!": flat(90), coinsph: flat(103) }, { upbit: 3, coinsph: 0 }, th),
    volumeSpike(vols(140), th),
    ...depegAlerts([{ coin: "USDC", reference: "USDT", price: 0.99, deviationPct: -1, level: "warning" }]),
  ].filter(Boolean);
  ok("every produced code matches /^[A-Z0-9_]{1,32}$/", all.length >= 4 && all.every((a) => /^[A-Z0-9_]{1,32}$/.test(a.code)), all.map((a) => a.code).join());
  ok("venue ids are normalised into the code", all.some((a) => a.code === "BREAKAWAY_WEIRD_VENUE_"));
  ok("no sourceUrl is empty (known venues)", all.filter((a) => a.code !== "BREAKAWAY_WEIRD_VENUE_").every((a) => /^https:\/\/\S+$/.test(a.sourceUrl)), all.map((a) => a.sourceUrl).join());
}

/* ---------------- feeds ---------------- */
console.log("fetchBreakAwayCloses");
const bar = (time, close, volume = 1) => ({ time, open: close, high: close, low: close, close, volume });
const hours = (n, f) => Array.from({ length: n }, (_, i) => bar(lastHour - (n - i) * H, f(i)));       // closed; newest opens at lastHour - H
const withForming = (bars, close) => [...bars, bar(lastHour, close)];                                   // the bar still forming
const days = (n, f, vol = () => 10) => Array.from({ length: n }, (_, i) => ({ ...bar(Math.floor(NOW / DAY) * DAY - (n - i) * DAY, f(i), vol(i)) }));

function makeDeps(spec) {
  const calls = [];
  return {
    calls,
    deps: {
      klines: async (source, interval, symbol, bars) => {
        calls.push(`k:${source}:${interval}:${symbol}:${bars}`);
        const v = spec.hourly[`${source}:${symbol}`];
        if (v instanceof Error) throw v;
        if (!v) throw new Error(`no fixture ${source}:${symbol}`);
        return v;
      },
      daily: async (source, symbol) => {
        calls.push(`d:${source}:${symbol}`);
        const v = spec.daily[`${source}:${symbol}`];
        if (v instanceof Error) throw v;
        if (!v) throw new Error(`no fixture ${source}:${symbol}`);
        return v;
      },
    },
  };
}
const usdtHourly = (price) => withForming(hours(8, () => price), price);
function baseSpec() {
  const hourly = {
    "binance:BTCUSDT": usdtHourly(100), "bybit-spot:BTCUSDT": usdtHourly(100), "bitget:BTCUSDT": usdtHourly(100),
    "okx:BTCUSDT": usdtHourly(100), "coinbase:BTCUSDT": usdtHourly(101.3),
    "upbit:BTCKRW": withForming(hours(8, () => 100 * 1.03 * 1400), 1), "upbit:USDTKRW": withForming(hours(8, () => 1400), 1),
    "coinsph:BTCPHP": withForming(hours(8, () => 100 * 58), 1), "coinsph:USDTPHP": withForming(hours(8, () => 58), 1),
  };
  const daily = {
    "binance:BTCUSDT": days(40, () => 100),
    // Upbit stands 3 % above Binance (ratio 103), Coins.ph exactly at par.
    "upbit:BTCKRW": days(40, () => 100 * 1.03 * 1400), "upbit:USDTKRW": days(40, () => 1400),
    "coinsph:BTCPHP": days(40, () => 100 * 58), "coinsph:USDTPHP": days(40, () => 58),
  };
  return { hourly, daily };
}
{
  const s = baseSpec();
  const { deps, calls } = makeDeps(s);
  const r = await fetchBreakAwayCloses(undefined, deps);
  ok("closes for all seven venues, nothing unavailable", Object.keys(r.closes).length === 7 && r.unavailable.length === 0, JSON.stringify(Object.keys(r.closes)) + r.unavailable);
  ok("keeps the last BREAKAWAY_BARS closed bars, aligned, forming bar dropped", BREAKAWAY_BARS === 6 && Object.values(r.closes).every((a) => a.length === 6) && r.closeTimes.length === 6 && r.closeTimes[5] === lastHour);
  ok("closeTimes are consecutive hours", r.closeTimes.every((t, i) => i === 0 || t - r.closeTimes[i - 1] === H));
  ok("Upbit = KRW-BTC ÷ KRW-USDT, Coins.ph = BTCPHP ÷ USDTPHP", r.closes.upbit.every((c) => Math.abs(c - 103) < 1e-9) && r.closes.coinsph.every((c) => Math.abs(c - 100) < 1e-9));
  ok("standing: Upbit +3 % over 30 days, Coins.ph 0 %", Math.abs(r.standing.upbit - 3) < 1e-6 && Math.abs(r.standing.coinsph) < 1e-6, JSON.stringify(r.standing));
  ok("hourly requests: 9 per cycle (binance, bybit, bitget, okx, coinbase, 2 upbit, 2 coinsph)", calls.filter((c) => c.startsWith("k:")).length === 9, calls.join());
  ok("1h interval, 8 bars requested per series", calls.filter((c) => c.startsWith("k:")).every((c) => c.includes(":1h:") && c.endsWith(":8")));
  const feed = breakAway(r.closes, r.standing, th, r.closeTimes);
  ok("feed → breakAway: Coinbase +1.3 % alerts, Upbit standing premium removed", feed.map((a) => a.code).join() === "BREAKAWAY_COINBASE", feed.map((a) => a.code).join() + JSON.stringify(r.standing));
}
{
  const s = baseSpec();
  s.hourly["upbit:BTCKRW"] = withForming(hours(8, () => 100 * 1.032 * 1400), 1);
  const r = await fetchBreakAwayCloses(undefined, makeDeps(s).deps);
  ok("Upbit at +3.2 % with +3 % standing: no alert", breakAway(r.closes, r.standing, th, r.closeTimes).every((a) => a.code !== "BREAKAWAY_UPBIT"));
  s.hourly["upbit:BTCKRW"] = withForming(hours(8, () => 100 * 1.042 * 1400), 1);
  const r2 = await fetchBreakAwayCloses(undefined, makeDeps(s).deps);
  ok("Upbit at +4.2 % with +3 % standing alerts", breakAway(r2.closes, r2.standing, th, r2.closeTimes).some((a) => a.code === "BREAKAWAY_UPBIT"));
}
{
  const s = baseSpec();
  s.hourly["upbit:BTCKRW"] = new RateLimitError("Upbit cooling", 60_000);
  s.hourly["bybit-spot:BTCUSDT"] = new Error("HTTP 500");
  const { deps, calls } = makeDeps(s);
  const r = await fetchBreakAwayCloses(undefined, deps);
  ok("failed / cooling venues are unavailable and never throw", r.unavailable.join() === "bybit,upbit" && !("upbit" in r.closes) && !("bybit" in r.closes), r.unavailable.join());
  ok("an unavailable ratio venue has null standing", r.standing.upbit === null && typeof r.standing.coinsph === "number");
  ok("daily history of an unavailable venue is not requested", !calls.some((c) => c.startsWith("d:upbit")));
}
{
  const s = baseSpec();
  s.daily["upbit:BTCKRW"] = days(19, () => 100 * 1.03 * 1400); // only 19 days
  const { deps } = makeDeps(s);
  const r = await fetchBreakAwayCloses(undefined, deps);
  ok("fewer than 20 daily bars: standing null (venue left out of break-away)", r.standing.upbit === null && typeof r.standing.coinsph === "number");
  s.daily["upbit:BTCKRW"] = days(20, () => 100 * 1.03 * 1400);
  const r2 = await fetchBreakAwayCloses(undefined, makeDeps(s).deps);
  ok("20 daily bars: standing present", typeof r2.standing.upbit === "number");
  s.daily["upbit:USDTKRW"] = new Error("relay down");
  const r3 = await fetchBreakAwayCloses(undefined, makeDeps(s).deps);
  ok("daily failure: standing null, closes kept", r3.standing.upbit === null && "upbit" in r3.closes);
  s.daily["binance:BTCUSDT"] = new Error("down");
  const r4 = await fetchBreakAwayCloses(undefined, makeDeps(s).deps);
  ok("Binance daily failure: both local venues null standing", r4.standing.upbit === null && r4.standing.coinsph === null && r4.unavailable.length === 0);
}
{
  // Alignment: Coinbase lacks the 2nd-newest bar, Upbit's USDT leg lacks the newest bar.
  const s = baseSpec();
  s.hourly["coinbase:BTCUSDT"] = withForming(hours(8, () => 100).filter((_, i) => i !== 6), 100);
  s.hourly["upbit:USDTKRW"] = withForming(hours(8, () => 1400).slice(0, 7), 1);
  const r = await fetchBreakAwayCloses(undefined, makeDeps(s).deps);
  const n = r.closeTimes.length;
  ok("a bar a venue lacks is NaN for that venue only", Number.isNaN(r.closes.coinbase[n - 2]) && !Number.isNaN(r.closes.coinbase[n - 1]) && Number.isNaN(r.closes.upbit[n - 1]) && !Number.isNaN(r.closes.binance[n - 2]), JSON.stringify(r.closes.coinbase));
  ok("arrays stay the same length", Object.values(r.closes).every((a) => a.length === n));
}
{
  // The newest bar of the whole market is a gap: the run is the newest consecutive hours with >= 3 venues.
  const s = baseSpec();
  for (const k of Object.keys(s.hourly)) s.hourly[k] = s.hourly[k].filter((b) => b.time !== lastHour - 3 * H);
  const r = await fetchBreakAwayCloses(undefined, makeDeps(s).deps);
  ok("a gap hour for every venue ends the run (consecutive bars only)", r.closeTimes.length === 2 && r.closeTimes[1] === lastHour && r.closeTimes[0] === lastHour - H, JSON.stringify(r.closeTimes));
}
{
  const s = baseSpec();
  for (const k of Object.keys(s.hourly)) s.hourly[k] = new Error("all down");
  const r = await fetchBreakAwayCloses(undefined, makeDeps(s).deps);
  ok("everything down: empty result, no throw, no daily request", Object.keys(r.closes).length === 0 && r.unavailable.length === 7 && r.closeTimes.length === 0);
  ok("an empty answer counts as unavailable", (await fetchBreakAwayCloses(undefined, { ...makeDeps(baseSpec()).deps, klines: async () => [] })).unavailable.length === 7);
}
{
  const ac = new AbortController();
  const s = baseSpec();
  const { deps } = makeDeps(s);
  let threw = null;
  try { await fetchBreakAwayCloses(ac.signal, { ...deps, klines: async () => { ac.abort(); throw new DOMException("x", "AbortError"); } }); } catch (e) { threw = e; }
  ok("an abort rejects", threw instanceof DOMException && threw.name === "AbortError");
}
{
  const s = baseSpec();
  s.hourly["binance:BTCUSDT"] = withForming(hours(8, () => 100), 100).map((b) => ({ ...b, close: b.time === lastHour - H ? 0 : b.close }));
  const r = await fetchBreakAwayCloses(undefined, makeDeps(s).deps);
  ok("a non-positive close is dropped (NaN)", Number.isNaN(r.closes.binance[5]));
  ok("closes still positive numbers elsewhere", r.closes.binance.slice(0, 5).every((c) => c === 100));
}

console.log("fetchDailyVolumes");
{
  const dayOf = (i, n) => Math.floor(NOW / DAY) * DAY - (n - i) * DAY;
  const vol = (n, v) => Array.from({ length: n }, (_, i) => ({ time: dayOf(i, n), open: 1, high: 1, low: 1, close: 1, volume: v }));
  const spec = (n = 40) => ({ hourly: {}, daily: {
    "binance:BTCUSDT": vol(n, 10), "bybit-spot:BTCUSDT": vol(n, 5), "bitget:BTCUSDT": vol(n, 3), "okx:BTCUSDT": vol(n, 4),
    "coinbase:BTCUSD": vol(n, 2), "upbit:BTCKRW": vol(n, 1),
  } });
  const s = spec();
  const { deps, calls } = makeDeps(s);
  const v = await fetchDailyVolumes(undefined, deps);
  ok("summed across the six venues, ascending", v.length === 40 && v.every((x) => x === 25), JSON.stringify(v.slice(0, 3)));
  ok("daily requests: one series per venue (Coinbase BTC-USD, Upbit KRW-BTC)", calls.length === 6 && calls.includes("d:coinbase:BTCUSD") && calls.includes("d:upbit:BTCKRW"), calls.join());
  s.daily["okx:BTCUSDT"] = vol(40, 4).filter((_, i) => i !== 10);
  const d = await fetchDailyVolumesDetailed(undefined, makeDeps(s).deps);
  ok("a day a venue lacks leaves that day out", d.volumes.length === 39 && !d.days.includes(vol(40, 1)[10].time), String(d.volumes.length));
  ok("days are UTC midnights, ascending, last = latest closed day", d.days.every((t) => t % DAY === 0) && d.days.every((t, i) => i === 0 || t > d.days[i - 1]) && d.days[d.days.length - 1] === Math.floor(NOW / DAY) * DAY - DAY);
  const s2 = spec(); s2.daily["upbit:BTCKRW"] = new Error("relay down");
  const d2 = await fetchDailyVolumesDetailed(undefined, makeDeps(s2).deps);
  ok("a venue that fails is left out of every day; the others still sum", d2.unavailable.join() === "upbit" && d2.volumes.length === 40 && d2.volumes.every((x) => x === 24));
  const s3 = spec(); s3.daily["upbit:BTCKRW"] = new Error("x"); s3.daily["okx:BTCUSDT"] = new Error("x"); s3.daily["bitget:BTCUSDT"] = new Error("x");
  ok("fewer than 4 venues loaded: empty", (await fetchDailyVolumes(undefined, makeDeps(s3).deps)).length === 0);
  const s4 = spec(200);
  ok("at most 61 days returned", (await fetchDailyVolumes(undefined, makeDeps(s4).deps)).length === 61);
  const s5 = spec(); s5.daily["binance:BTCUSDT"] = [...vol(40, 10), { time: Math.floor(NOW / DAY) * DAY, open: 1, high: 1, low: 1, close: 1, volume: 999 }];
  ok("the day still forming is never summed", (await fetchDailyVolumes(undefined, makeDeps(s5).deps)).length === 40);
  const s6 = spec(); s6.daily["binance:BTCUSDT"] = vol(40, 10).map((b, i) => (i === 5 ? { ...b, volume: NaN } : b));
  ok("a non-finite volume leaves that day out", (await fetchDailyVolumes(undefined, makeDeps(s6).deps)).length === 39);
  const all = vol(40, 10).map((b, i) => ({ ...b, volume: i === 39 ? 400 : 10 + (i % 2 ? 2 : -2) }));
  const s7 = spec(); for (const k of Object.keys(s7.daily)) s7.daily[k] = all.map((b) => ({ ...b }));
  const sp = volumeSpike(await fetchDailyVolumes(undefined, makeDeps(s7).deps), th);
  ok("feed → volumeSpike", sp?.code === "VOL_SPIKE");
  const ac = new AbortController();
  let threw = null;
  try { await fetchDailyVolumes(ac.signal, { ...makeDeps(spec()).deps, daily: async () => { ac.abort(); throw new DOMException("x", "AbortError"); } }); } catch (e) { threw = e; }
  ok("an abort rejects", threw instanceof DOMException);
}

console.log("shared pieces");
ok("standingPremiumMedian is the Task 2 function (20-day minimum)", standingPremiumMedian(Array(19).fill(1)) === null && standingPremiumMedian(Array(20).fill(1)) === 1);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
