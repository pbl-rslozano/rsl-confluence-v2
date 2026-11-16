// Radar snapshot runner, gating and context log — v2.8 Step 4a (WP25, Task 5).
// Run: npm run test:radar-snap   (node scripts/run-engine-tests.mjs radar-snapshot.test.mjs)
import {
  createRadarRunner, radarAllowed, toRadarContext, normalizeContext, radarFields, loadRadarLog, appendRadarContext, radarLogId, RADAR_INTERVAL_MS, RETRY_MS,
} from "./radar/snapshot.ts";
import { DEFAULT_THRESHOLDS } from "./radar/alerts.ts";
import { sanitizeLedgerRow } from "./ledger-metrics.ts";
import { RADAR_COLLECTION, RADAR_CACHE_ID } from "./radar/store.ts";

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} ${extra}`); }
};
const H = 3_600_000;
const DAY = 86_400_000;
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 16, 12, 30, 0);

function memPort() {
  const m = new Map();
  return {
    m,
    async get(c, id) { return m.has(`${c}/${id}`) ? structuredClone(m.get(`${c}/${id}`)) : undefined; },
    async put(c, id, doc) { m.set(`${c}/${id}`, structuredClone(doc)); },
  };
}
function fakeTimers() {
  const t = { handles: new Map(), n: 0, set(fn, ms) { t.n++; t.handles.set(t.n, { fn, ms }); return t.n; }, clear(h) { t.handles.delete(h); }, fire() { for (const { fn } of [...t.handles.values()]) fn(); } };
  return t;
}
const supplyPts = (n, end) => Array.from({ length: n }, (_, i) => ({ day: end - (n - 1 - i) * DAY, usd: 1e11 + i * 1e8 }));
function makeFetchers(clock, over = {}) {
  const calls = {};
  const c = (k) => { calls[k] = (calls[k] ?? 0) + 1; };
  const fx = {
    calls,
    async positioning(sym) { c("positioning"); return { symbol: sym, fundingRate: 0.0001, fundingPctl30d: 61, oi: 1, oiChg24hPct: 2.5, longShortRatio: 1.7, takerBuySellRatio: 1.1, basisPct: 0.02, asOf: clock.t }; },
    async regional() { c("regional"); return { usPct: 0.1, krPct: 1.2, phPct: -0.3, asOf: clock.t, unavailable: [] }; },
    async buyer() { c("buyer"); return { takerShare: [0.4, null, 0.55], sessions: { asia: 0.3, europe: 0.3, us: 0.4 }, asOf: clock.t }; },
    async cot(asset) { c("cot"); return { asset, reportDate: "2026-11-10", assetManagers: { long: 10, short: 4, net: 6, netChg: 1 }, leveragedFunds: { long: 3, short: 9, net: -6, netChg: -1 }, openInterest: 100 }; },
    async supply() { c("supply"); return supplyPts(120, Math.floor(clock.t / DAY) * DAY); },
    async breakAway() { c("breakAway"); return { closes: {}, standing: {}, unavailable: [], closeTimes: [], stale: true }; },
    async dailyVolumes() { c("dailyVolumes"); return { volumes: [], days: [], latest: false, unavailable: [] }; },
    ...over,
  };
  return fx;
}
function setup(over = {}, dep = {}) {
  const clock = { t: T0 };
  const fetchers = makeFetchers(clock, over);
  const store = memPort();
  const timers = fakeTimers();
  const runner = createRadarRunner({ now: () => clock.t, fetchers, store, thresholds: () => DEFAULT_THRESHOLDS, depeg: () => [], timers, ...dep });
  return { clock, fetchers, store, timers, runner };
}
const total = (f) => Object.values(f.calls).reduce((a, b) => a + b, 0);
const settle = () => new Promise((r) => setTimeout(r, 20));

console.log("gating");
ok("radarAllowed: closed+off false", radarAllowed({ panelOpen: false, recordRadar: false }) === false);
ok("radarAllowed: open true, record true", radarAllowed({ panelOpen: true, recordRadar: false }) === true && radarAllowed({ panelOpen: false, recordRadar: true }) === true);
{
  const { fetchers, timers, runner } = setup();
  runner.start();
  await settle();
  const ticks = [...timers.handles.values()].map((h) => h.fn);
  runner.stop();
  const before = total(fetchers);
  ok("the started runner did fetch", before > 0 && ticks.length === 1);
  for (let i = 0; i < 3; i++) ticks.forEach((fn) => fn());
  await settle();
  ok("no fetch when not allowed: a stopped runner makes 0 new fetcher calls across 3 ticks", total(fetchers) === before && timers.handles.size === 0);
}
{
  const { timers, runner, fetchers } = setup();
  runner.start(); runner.start();
  ok("start twice: one timer", timers.handles.size === 1);
  runner.stop(); runner.start();
  ok("start/stop/start: one timer at the 5-minute cadence", timers.handles.size === 1 && [...timers.handles.values()][0].ms === RADAR_INTERVAL_MS);
  runner.stop();
  ok("stop clears the timer", timers.handles.size === 0);
  await settle();
}

console.log("stop aborts and publishes nothing");
{
  let sig = null;
  let release;
  const gate = new Promise((r) => { release = r; });
  const { runner, fetchers, store } = setup({
    async positioning(sym) { sig = arguments[1]; await gate; return { symbol: sym, fundingRate: 0, fundingPctl30d: 1, oi: 1, oiChg24hPct: 0, longShortRatio: 1, takerBuySellRatio: 1, basisPct: 0, asOf: T0 }; },
  });
  let published = 0;
  runner.subscribe(() => { published++; });
  const p = runner.refresh();
  p.catch(() => {});
  await settle();
  runner.stop();
  ok("stop aborts the in-flight request signal", sig && sig.aborted === true);
  release();
  let err = null;
  try { await p; } catch (e) { err = e; }
  await settle();
  ok("late refresh after stop: rejects with AbortError, publishes and logs nothing", err && err.name === "AbortError" && published === 0 && runner.latest() === null && ![...store.m.keys()].some((k) => k.includes("radar-log")));
}
{
  let n = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = setup({ async regional() { n++; await gate; return { usPct: 0, krPct: 0, phPct: 0, asOf: T0, unavailable: [] }; } });
  s.runner.start();
  await settle();
  s.timers.fire(); s.timers.fire();
  await settle();
  ok("a tick while a refresh runs is skipped (no overlap)", n === 1);
  release(); await settle(); s.runner.stop();
}

console.log("stale values are marked");
{
  let fail = false;
  const s = setup({
    async positioning(sym) { if (fail) throw new Error("boom"); return { symbol: sym, fundingRate: 0.0002, fundingPctl30d: 70, oi: 1, oiChg24hPct: 1, longShortRatio: 1.5, takerBuySellRatio: 1, basisPct: 0, asOf: s.clock.t }; },
  });
  const a = await s.runner.refresh();
  const first = s.clock.t;
  fail = true; s.clock.t += 5 * MIN;
  const b = await s.runner.refresh();
  ok("positioning keeps refresh 1's value", b.positioning.BTCUSDT && b.positioning.BTCUSDT.asOf === first && b.positioning.ETHUSDT.asOf === first);
  ok("stale[positioning:SYMBOL] is refresh 1's asOf", b.stale["positioning:BTCUSDT"] === first && b.stale["positioning:ETHUSDT"] === first && a.stale["positioning:BTCUSDT"] === undefined, JSON.stringify(b.stale));
  ok("other sections are not stale", b.stale.regional === undefined && b.regional.asOf === s.clock.t);
  ok("latest() is the newest snapshot", s.runner.latest() === b);
}
{
  const s = setup({ async regional() { throw new Error("x"); } });
  const a = await s.runner.refresh();
  ok("failing section with no earlier value: null and listed unavailable", a.regional === null && a.unavailable.includes("regional") && a.stale.regional === undefined);
}

console.log("daily and CFTC caching");
{
  const s = setup();
  await s.runner.refresh();
  s.clock.t += 5 * MIN; await s.runner.refresh();
  s.clock.t += 5 * MIN; await s.runner.refresh();
  ok("daily items cached per UTC day: one supply and one volume fetch across 3 refreshes", s.fetchers.calls.supply === 1 && s.fetchers.calls.dailyVolumes === 1, JSON.stringify(s.fetchers.calls));
  ok("5-minute items fetched every refresh", s.fetchers.calls.regional === 3 && s.fetchers.calls.breakAway === 3 && s.fetchers.calls.positioning === 6);
  s.clock.t = Math.floor(s.clock.t / DAY) * DAY + DAY + 60 * MIN; // next UTC day
  await s.runner.refresh();
  ok("next UTC day: daily items fetched again", s.fetchers.calls.supply === 2 && s.fetchers.calls.dailyVolumes === 2, JSON.stringify(s.fetchers.calls));
}
{
  const s = setup();
  await s.runner.refresh();
  ok("cftc: two assets on first refresh", s.fetchers.calls.cot === 2);
  s.clock.t += 11 * H + 59 * MIN; await s.runner.refresh();
  ok("cftc at most every 12 h: not before 12 h", s.fetchers.calls.cot === 2);
  s.clock.t += 2 * MIN; const snap = await s.runner.refresh();
  ok("cftc refetched after 12 h", s.fetchers.calls.cot === 4 && snap.cot.BTC && snap.cot.ETH, JSON.stringify(s.fetchers.calls));
  await settle();
  const cache = s.store.m.get(`${RADAR_COLLECTION}/${RADAR_CACHE_ID}`);
  ok("cftc and supply are persisted in the cache doc", cache && cache.cot.BTC && cache.supply.points.length > 90);
  // a fresh runner on the same store reads the cache: no refetch
  const s2 = setup({}, { store: s.store });
  s2.clock.t = s.clock.t + MIN;
  await s2.runner.refresh();
  ok("a new runner reads fresh cftc and supply from the cache", !s2.fetchers.calls.cot && !s2.fetchers.calls.supply, JSON.stringify(s2.fetchers.calls));
}
{
  let fail = true;
  const s = setup({ async cot() { s.fetchers.calls.cot = (s.fetchers.calls.cot ?? 0) + 1; if (fail) throw new Error("down"); return null; } });
  const a = await s.runner.refresh();
  ok("cftc failure with nothing cached: null, unavailable", a.cot.BTC === null && a.unavailable.includes("cot:BTC") && a.unavailable.includes("cot:ETH"));
  s.clock.t += 5 * MIN; await s.runner.refresh();
  ok("a failed slow input is not retried every tick", s.fetchers.calls.cot === 2);
  s.clock.t += RETRY_MS; await s.runner.refresh();
  ok("...but is retried after the back-off", s.fetchers.calls.cot === 4);
}

console.log("alerts");
{
  const lastHour = Math.floor(T0 / H) * H;
  const mk = (cb) => ({ binance: [100, 100], bybit: [100, 100], bitget: [100, 100], okx: [100, 100], coinbase: cb });
  let mode = "alert";
  const s = setup({
    async breakAway() {
      if (mode === "stale") return { closes: {}, standing: {}, unavailable: [], closeTimes: [], stale: true };
      return { closes: mk([101.5, 101.5]), standing: {}, unavailable: [], closeTimes: [lastHour - H + 0, lastHour], stale: false };
    },
  }, { depeg: () => [{ coin: "USDC", reference: "USDT", deviationPct: 1.2 }], depegSource: () => "okx-perp" });
  const a = await s.runner.refresh();
  const codes = a.alerts.map((x) => x.code).sort();
  ok("break-away and depeg alerts assembled", codes.includes("BREAKAWAY_COINBASE") && codes.includes("DEPEG_USDC"), codes.join());
  ok("closeTimes reach breakAway: since is the exact first-bar close", a.alerts.find((x) => x.code === "BREAKAWAY_COINBASE").since === lastHour - H);
  mode = "stale"; s.clock.t += 5 * MIN;
  const b = await s.runner.refresh();
  ok("stale break-away feed keeps previous alerts, marked stale, invents none", b.alerts.some((x) => x.code === "BREAKAWAY_COINBASE") && b.stale.breakaway === T0, JSON.stringify(b.stale));
}
{
  const days = Array.from({ length: 31 }, (_, i) => Math.floor(T0 / DAY) * DAY - (31 - i) * DAY);
  const vols = days.map((_, i) => (i === 30 ? 5000 : 100 + (i % 3)));
  const s = setup({ async dailyVolumes() { return { volumes: vols, days, latest: true, unavailable: [] }; } });
  const a = await s.runner.refresh();
  const v = a.alerts.find((x) => x.code === "VOL_SPIKE");
  ok("volume spike uses the last day from dailyVolumes", v && v.since === days[30] + DAY, JSON.stringify(v));
}

console.log("context");
{
  const s = setup({}, { depeg: () => [{ coin: "USDC", reference: "USDT", deviationPct: 1.2 }] });
  const a = await s.runner.refresh();
  const c = toRadarContext(a);
  ok("context built from BTC values", c.t === T0 && c.frp === 61 && c.oi24 === 2.5 && c.ls === 1.7 && c.tk === 0.55 && c.usP === 0.1 && c.krP === 1.2 && c.phP === -0.3, JSON.stringify(c));
  ok("al sorted, unique, <= 16", c.al.join() === "DEPEG_USDC");
  const many = { ...a, alerts: Array.from({ length: 30 }, (_, i) => ({ ...a.alerts[0], code: `X_${String(29 - i).padStart(2, "0")}` })).concat([{ ...a.alerts[0], code: "X_00" }]) };
  const mc = toRadarContext(many);
  ok("al capped at 16 and sorted", mc.al.length === 16 && mc.al[0] === "X_00" && mc.al.every((x, i, arr) => i === 0 || arr[i - 1] < x));
}

console.log("radar fields no look-ahead");
{
  const tc = T0;
  const e = (t, frp = 1) => ({ t, frp, oi24: null, ls: null, tk: null, usP: null, krP: null, phP: null, al: [] });
  ok("an entry at tc + 1 min is not used", radarFields([e(tc + MIN)], tc) === null);
  ok("an entry at tc - 30 min is used", radarFields([e(tc - 30 * MIN)], tc)?.t === tc - 30 * MIN);
  ok("an entry at tc - 3 h gives null", radarFields([e(tc - 3 * H)], tc) === null);
  ok("exactly 2 h is used, newest wins, order irrelevant", radarFields([e(tc - 2 * H, 9), e(tc - 10 * MIN, 5), e(tc - 50 * MIN, 7), e(tc + 5 * MIN, 8)], tc).frp === 5 && radarFields([e(tc - 2 * H)], tc) !== null);
  ok("empty log and NaN tc give null", radarFields([], tc) === null && radarFields([e(tc)], NaN) === null);
}

console.log("log");
{
  const port = memPort();
  const NOW = T0;
  const ctx = (t) => ({ t, frp: 50, oi24: null, ls: null, tk: null, usP: null, krP: null, phP: null, al: ["A_B"] });
  for (let d = 0; d < 40; d++) await appendRadarContext(port, ctx(NOW - d * DAY));
  await appendRadarContext(port, ctx(NOW - 5 * MIN));
  ok("a day's entries land in docs radar-log-YYYY-MM-DD in the meta collection", radarLogId(NOW) === "radar-log-2026-11-16" && port.m.get("meta/radar-log-2026-11-16").entries.length === 2);
  const log = await loadRadarLog(port, NOW);
  ok("log keeps 35 days: 35 days read, older ignored", log.length === 36 && log[0].t === NOW - 34 * DAY && log.every((x, i) => i === 0 || log[i - 1].t <= x.t), String(log.length));
  const s = setup({}, { store: port });
  await s.runner.refresh(); await settle();
  ok("the runner prunes (blanks) docs older than 35 days", port.m.get(`meta/${radarLogId(NOW - 36 * DAY)}`).entries.length === 0 && port.m.get(`meta/${radarLogId(NOW - 20 * DAY)}`).entries.length === 1);
  ok("the runner appends a context at each refresh", port.m.get("meta/radar-log-2026-11-16").entries.length === 3);
  const bad = memPort();
  bad.m.set("meta/radar-log-2026-11-16", { entries: [{ t: "x" }, { t: NOW, frp: "9", al: ["bad", "OK_1"] }, 7] });
  const l2 = await loadRadarLog(bad, NOW);
  ok("stored entries are re-validated", l2.length === 1 && l2[0].frp === null && l2[0].al.join() === "OK_1");
  const failing = { async get() { throw new Error("x"); }, async put() { throw new Error("x"); } };
  ok("a port failure never throws", (await loadRadarLog(failing, NOW)).length === 0 && (await appendRadarContext(failing, ctx(NOW))) === false);
  let wrote = 0;
  const readFail = { async get() { throw new Error("read"); }, async put() { wrote++; } };
  await appendRadarContext(readFail, ctx(NOW));
  ok("a failed read never overwrites the day", wrote === 0);
}

console.log("fix round 1");
{
  // I-1: t is the END of the refresh: no value in an entry was observed after t
  const s = setup({
    async regional() { s.clock.t += 10 * MIN; return { usPct: 0.1, krPct: 0.2, phPct: 0.3, asOf: s.clock.t, unavailable: [] }; },
  });
  const a = await s.runner.refresh();
  ok("I-1: t is not before any asOf in the snapshot", a.t >= a.regional.asOf && a.t >= a.positioning.BTCUSDT.asOf && a.t === T0 + 10 * MIN, String(a.t - T0));
  ok("I-1: radarFields(tc between start and end) does not use the entry", radarFields([toRadarContext(a)], T0 + MIN) === null && radarFields([toRadarContext(a)], a.t) !== null);
}
{
  // I-2: stale sections are not logged as current
  let fail = false;
  let ba = "alert";
  const lastHour = Math.floor(T0 / H) * H;
  const s = setup({
    async positioning(sym) { if (fail) throw new Error("x"); return { symbol: sym, fundingRate: 0, fundingPctl30d: 50, oi: 1, oiChg24hPct: 3, longShortRatio: 1.4, takerBuySellRatio: 1, basisPct: 0, asOf: s.clock.t }; },
    async regional() { if (fail) throw new Error("x"); return { usPct: 0.4, krPct: 0.5, phPct: 0.6, asOf: s.clock.t, unavailable: [] }; },
    async buyer() { if (fail) throw new Error("x"); return { takerShare: [0.6], sessions: { asia: 1, europe: 0, us: 0 }, asOf: s.clock.t }; },
    async breakAway() {
      if (ba === "stale") return { closes: {}, standing: {}, unavailable: [], closeTimes: [], stale: true };
      const f = [100, 100];
      return { closes: { binance: f, bybit: f, bitget: f, okx: f, coinbase: [101.5, 101.5] }, standing: {}, unavailable: [], closeTimes: [lastHour - H, lastHour], stale: false };
    },
  });
  const a = await s.runner.refresh();
  ok("I-2: a fresh snapshot logs all fields", (c => c.frp === 50 && c.tk === 0.6 && c.usP === 0.4 && c.al.includes("BREAKAWAY_COINBASE"))(toRadarContext(a)));
  fail = true; ba = "stale"; s.clock.t += 10 * H;
  const b = await s.runner.refresh();
  const c = toRadarContext(b);
  ok("I-2: the UI snapshot still shows the kept values with their stale time", b.positioning.BTCUSDT.fundingPctl30d === 50 && b.stale["positioning:BTCUSDT"] === T0 && !b.alerts.some((x) => x.code === "BREAKAWAY_COINBASE") /* M2: 10 h without break-away data: dropped, not listed as current */);
  ok("I-2: the logged context nulls stale positioning, buyer and regional fields", c.frp === null && c.oi24 === null && c.ls === null && c.tk === null && c.usP === null && c.krP === null && c.phP === null, JSON.stringify(c));
  ok("I-2: stale break-away codes are dropped from al", !c.al.some((x) => x.startsWith("BREAKAWAY_")), c.al.join());
}
{
  // I-3: daily volumes with latest false are not cached
  let latest = false;
  const s = setup({ async dailyVolumes() { s.fetchers.calls.dailyVolumes = (s.fetchers.calls.dailyVolumes ?? 0) + 1; return { volumes: [1, 2, 3], days: [1, 2, 3], latest, unavailable: [] }; } });
  const a = await s.runner.refresh();
  ok("I-3: not latest: 'volume' is unavailable", a.unavailable.includes("volume"));
  s.clock.t += 5 * MIN; await s.runner.refresh();
  ok("I-3: not retried inside RETRY_MS", s.fetchers.calls.dailyVolumes === 1);
  latest = true; s.clock.t += RETRY_MS;
  const b = await s.runner.refresh();
  ok("I-3: retried after RETRY_MS and then cached for the day", s.fetchers.calls.dailyVolumes === 2 && !b.unavailable.includes("volume"));
  s.clock.t += 5 * MIN; await s.runner.refresh();
  ok("I-3: a latest result is cached per UTC day", s.fetchers.calls.dailyVolumes === 2);
}
{
  // I-4: a hung section times out as a section failure, not a stop
  let hang = false;
  const s = setup({
    async positioning(sym) { if (hang && sym === "ETHUSDT") return new Promise(() => {}); return { symbol: sym, fundingRate: 0, fundingPctl30d: 50, oi: 1, oiChg24hPct: 3, longShortRatio: 1.4, takerBuySellRatio: 1, basisPct: 0, asOf: s.clock.t }; },
  }, { sectionTimeoutMs: 40 });
  const a = await s.runner.refresh();
  hang = true; s.clock.t += 5 * MIN;
  const b = await s.runner.refresh();
  ok("I-4: the refresh completes with the hung section kept and stale", b.positioning.ETHUSDT !== null && b.stale["positioning:ETHUSDT"] === a.t && b.positioning.BTCUSDT.asOf === s.clock.t && b.stale["positioning:BTCUSDT"] === undefined);
  s.clock.t += 5 * MIN; s.timers.handles.clear();
  s.runner.start(); await settle(); s.runner.stop();
  const c = await s.runner.refresh();
  ok("I-4: later refreshes still run", c.t === s.clock.t);
  const s2 = setup({ async regional() { return new Promise(() => {}); } }, { sectionTimeoutMs: 40 });
  const d = await s2.runner.refresh();
  ok("I-4: a hung section with no earlier value is unavailable", d.regional === null && d.unavailable.includes("regional"));
}
{
  // M1: allowed dep
  let allowed = false;
  const s = setup({}, { allowed: () => allowed });
  s.runner.start();
  ok("M1: start refuses while not allowed", s.timers.handles.size === 0 && total(s.fetchers) === 0);
  let err = null;
  try { await s.runner.refresh(); } catch (e) { err = e; }
  ok("M1: refresh rejects while not allowed, no fetch", err && total(s.fetchers) === 0);
  allowed = true; s.runner.start(); await settle();
  const fn = [...s.timers.handles.values()][0].fn;
  const n = total(s.fetchers);
  allowed = false; fn(); await settle();
  ok("M1: a tick while not allowed makes no request", n > 0 && total(s.fetchers) === n);
  s.runner.stop();
}
{
  // M4: radarFields just after UTC midnight reads yesterday's doc
  const port = memPort();
  const mid = Date.UTC(2026, 10, 17, 0, 0, 0);
  const e = (t) => ({ t, frp: 42, oi24: null, ls: null, tk: null, usP: null, krP: null, phP: null, al: [] });
  await appendRadarContext(port, e(mid - 10 * MIN));
  const log = await loadRadarLog(port, mid + 5 * MIN);
  ok("M4: tc just after UTC midnight uses yesterday's entry", radarFields(log, mid + 5 * MIN)?.frp === 42);
}
{
  // M5: index doc, prune blanks every listed old day
  const port = memPort();
  const e = (t) => ({ t, frp: 1, oi24: null, ls: null, tk: null, usP: null, krP: null, phP: null, al: [] });
  await appendRadarContext(port, e(T0 - 200 * DAY));
  await appendRadarContext(port, e(T0 - 100 * DAY));
  await appendRadarContext(port, e(T0 - 3 * DAY));
  const idx = port.m.get("meta/radar-log-index");
  ok("M5: written days are listed in radar-log-index", idx && idx.days.length === 3 && idx.days.includes("2026-11-13"), JSON.stringify(idx));
  const { pruneRadarLog } = await import("./radar/snapshot.ts");
  await pruneRadarLog(port, T0);
  ok("M5: prune blanks every listed day older than 35 days, however old", port.m.get(`meta/${radarLogId(T0 - 200 * DAY)}`).entries.length === 0 && port.m.get(`meta/${radarLogId(T0 - 100 * DAY)}`).entries.length === 0 && port.m.get(`meta/${radarLogId(T0 - 3 * DAY)}`).entries.length === 1);
  ok("M5: pruned days leave the index", port.m.get("meta/radar-log-index").days.join() === "2026-11-13");
}
{
  // M7: per symbol; M8: asOf 0
  const s = setup({
    async positioning(sym) { if (sym === "BTCUSDT") throw new Error("x"); return { symbol: sym, fundingRate: 0, fundingPctl30d: 50, oi: 1, oiChg24hPct: 3, longShortRatio: 1.4, takerBuySellRatio: 1, basisPct: 0, asOf: 0 }; },
    async cot(asset) { if (asset === "BTC") throw new Error("x"); return { asset, reportDate: "2026-11-10", assetManagers: null, leveragedFunds: null, openInterest: null }; },
  });
  const a = await s.runner.refresh();
  ok("M7: BTC failing alone is listed per symbol", a.unavailable.includes("positioning:BTCUSDT") && !a.unavailable.includes("positioning:ETHUSDT") && a.unavailable.includes("cot:BTC") && !a.unavailable.includes("cot:ETH"), a.unavailable.join());
  ok("M7: the context uses BTC only (ETH data never fills it)", toRadarContext(a).frp === null);
  s.clock.t += 5 * MIN;
  const b = await s.runner.refresh();
  ok("M8: asOf 0 is invalid: the fetch time is used, never 1970", b.positioning.ETHUSDT !== null && Object.values(b.stale).every((v) => v > 0));
}
{
  // M11: lastError
  let boom = true;
  const s = setup({}, { thresholds: () => { if (boom) throw new Error("bad thresholds"); return DEFAULT_THRESHOLDS; } });
  const seen = [];
  s.runner.subscribe((snap, info) => seen.push(info?.lastError ?? null));
  let err = null;
  try { await s.runner.refresh(); } catch (e) { err = e; }
  ok("M11: a non-fetch error rejects, is exposed as lastError and is notified", err && s.runner.lastError() === "bad thresholds" && seen.includes("bad thresholds"), String(s.runner.lastError()));
  boom = false; await s.runner.refresh();
  ok("M11: lastError clears after a good refresh", s.runner.lastError() === null);
}


console.log("rethreshold (no request, same t, no log row)");
{
  const lastHour = Math.floor(T0 / H) * H;
  let th = DEFAULT_THRESHOLDS;
  const s = setup({
    async breakAway() { return { closes: { binance: [100, 100], bybit: [100, 100], bitget: [100, 100], okx: [100, 100], coinbase: [101.5, 101.5] }, standing: {}, unavailable: [], closeTimes: [lastHour - H, lastHour], stale: false }; },
  }, { thresholds: () => th });
  ok("rethreshold before any snapshot is a no-op", (s.runner.rethreshold(), s.runner.latest() === null));
  const a = await s.runner.refresh();
  await settle();
  const logKey = [...s.store.m.keys()].filter((k) => k.includes("radar-log-20"));
  const logBefore = JSON.stringify(logKey.map((k) => s.store.m.get(k)));
  const callsBefore = total(s.fetchers);
  const seen = [];
  s.runner.subscribe((x) => seen.push(x));
  ok("at 1 % the Coinbase break-away is raised", a.alerts.some((x) => x.code === "BREAKAWAY_COINBASE"));
  th = { ...DEFAULT_THRESHOLDS, breakAwayPct: 2 };
  s.clock.t += 7 * MIN;
  s.runner.rethreshold();
  const b = s.runner.latest();
  ok("at 2 % it is cleared, with no request", !b.alerts.some((x) => x.code === "BREAKAWAY_COINBASE") && total(s.fetchers) === callsBefore);
  ok("same t, stale and unavailable; a snapshot was published", b.t === a.t && JSON.stringify(b.stale) === JSON.stringify(a.stale) && JSON.stringify(b.unavailable) === JSON.stringify(a.unavailable) && seen.length === 1 && seen[0] === b);
  await settle();
  ok("no context log row was appended", JSON.stringify([...s.store.m.keys()].filter((k) => k.includes("radar-log-20")).map((k) => s.store.m.get(k))) === logBefore);
  th = DEFAULT_THRESHOLDS;
  s.runner.rethreshold();
  ok("back at 1 % it returns (the inputs were kept, not the alerts)", s.runner.latest().alerts.some((x) => x.code === "BREAKAWAY_COINBASE"));
}

console.log("threshold edit during a running refresh");
{
  const lastHour = Math.floor(T0 / H) * H;
  let th = DEFAULT_THRESHOLDS;
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = setup({
    async breakAway() { await gate; return { closes: { binance: [100, 100], bybit: [100, 100], bitget: [100, 100], okx: [100, 100], coinbase: [101.5, 101.5] }, standing: {}, unavailable: [], closeTimes: [lastHour - H, lastHour], stale: false }; },
  }, { thresholds: () => th });
  const p = s.runner.refresh();
  th = { ...DEFAULT_THRESHOLDS, breakAwayPct: 2 };
  release();
  const a = await p;
  ok("an edit made while fetches are pending is used by the published alerts", !a.alerts.some((x) => x.code === "BREAKAWAY_COINBASE"));
}

console.log("fix wave: I-1 producer ranges = sanitiser ranges");
{
  const snap = (p, rg, by) => ({ t: T0, positioning: { BTCUSDT: p, ETHUSDT: null }, regional: rg, buyer: by, cot: { BTC: null, ETH: null }, supply: null, alerts: [], stale: {}, unavailable: [] });
  const bad = toRadarContext(snap(
    { symbol: "BTCUSDT", fundingRate: 0, fundingPctl30d: 120, oi: 1, oiChg24hPct: 20000, longShortRatio: 150, takerBuySellRatio: 1, basisPct: 0, asOf: T0 },
    { usPct: 61, krPct: 60, phPct: -80, asOf: T0, unavailable: [] },
    { takerShare: [1.5], sessions: { asia: 1, europe: 1, us: 1 }, asOf: T0 }));
  ok("I-1 out-of-range fields are null in the produced context", bad.krP === null && bad.usP === null && bad.phP === null && bad.ls === null && bad.oi24 === null && bad.frp === null && bad.tk === null, JSON.stringify(bad));
  const row = { cfg: "c1", ev: "1", app: "t", src: "binance", tf: "4h", ac: "crypto", rec: 0, sc: 0, m: 0, st: 0, sup: 0, lv: 0, v: 18, bu: 0, be: 0, er: null, bl: [0, 0, 0, 0], rk: 1, qv: 1, rd: 0, rc: 0, wb: 1000, live: 1,
    id: `c1|binance|4h|BTCUSDT|${T0}`, pair: "BTCUSDT", t: T0, tc: T0 + 4 * H, c: 61234.5, ft: null, rad: JSON.parse(JSON.stringify(bad)) };
  ok("I-1 the row survives sanitizeLedgerRow with those fields null", sanitizeLedgerRow(row) !== null && sanitizeLedgerRow(row).rad.krP === null);
  const edge = toRadarContext(snap({ symbol: "BTCUSDT", fundingRate: 0, fundingPctl30d: 100, oi: 1, oiChg24hPct: 10000, longShortRatio: 100, takerBuySellRatio: 1, basisPct: 0, asOf: T0 }, { usPct: 50, krPct: -50, phPct: 0.5, asOf: T0, unavailable: [] }, { takerShare: [1], sessions: { asia: 1, europe: 1, us: 1 }, asOf: T0 }));
  ok("I-1 boundary values are kept", edge.frp === 100 && edge.oi24 === 10000 && edge.ls === 100 && edge.tk === 1 && edge.usP === 50 && edge.krP === -50 && edge.phP === 0.5);
  const n = normalizeContext({ t: T0, frp: 120, oi24: -101, ls: -1, tk: 2, usP: 51, krP: 60, phP: -51, al: [] });
  ok("I-1 normalizeContext (recorder + stored docs) nulls out-of-range fields", n && n.frp === null && n.oi24 === null && n.ls === null && n.tk === null && n.usP === null && n.krP === null && n.phP === null);
  ok("I-1 normalizeContext keeps in-range fields", normalizeContext({ t: T0, krP: 12.5, al: [] }).krP === 12.5);
}

console.log("fix wave: M1 regional partial failure keeps the last good per-row value");
{
  let mode = "ok";
  const s = setup({
    async regional() {
      if (mode === "ok") return { usPct: 0.1, krPct: 1.2, phPct: -0.3, asOf: s.clock.t, unavailable: [] };
      if (mode === "kr") return { usPct: 0.2, krPct: null, phPct: -0.1, asOf: s.clock.t, unavailable: ["upbit"] };
      return { usPct: null, krPct: null, phPct: null, asOf: s.clock.t, unavailable: ["binance"] };
    },
  });
  const a = await s.runner.refresh();
  const tGood = a.regional.asOf;
  s.clock.t += 5 * MIN; mode = "kr";
  const b = await s.runner.refresh();
  ok("M1 Upbit down: kr keeps its last good value, us/ph are fresh", b.regional.krPct === 1.2 && b.regional.usPct === 0.2 && b.regional.phPct === -0.1);
  ok("M1 Upbit down: only the kr row is stale, with its time", b.stale["regional:kr"] === tGood && b.stale["regional:us"] === undefined && b.stale["regional:ph"] === undefined && b.stale.regional === undefined, JSON.stringify(b.stale));
  ok("M1 the logged context nulls the stale row only", toRadarContext(b).krP === null && toRadarContext(b).usP === 0.2);
  s.clock.t += 5 * MIN; mode = "binance";
  const c = await s.runner.refresh();
  const tUs = b.regional.asOf;
  ok("M1 Binance down (all null): treated as the section's failure, rows kept, stale marked", c.regional.usPct === 0.2 && c.regional.krPct === 1.2 && typeof c.stale.regional === "number" && c.stale["regional:kr"] === tGood && c.stale["regional:us"] === tUs, JSON.stringify(c.stale));
  ok("M1 the context of an all-stale regional is all null", (() => { const x = toRadarContext(c); return x.usP === null && x.krP === null && x.phP === null; })());
  const s2 = setup({ async regional() { return { usPct: null, krPct: null, phPct: null, asOf: T0, unavailable: ["binance"] }; } });
  const d = await s2.runner.refresh();
  ok("M1 all-null with no earlier value: the section is unavailable", d.unavailable.includes("regional") && d.regional === null);
}

console.log("fix wave: M2 stale break-away alerts are marked stale and dropped after 2 h");
{
  const lastHour = Math.floor(T0 / H) * H;
  let fresh = true;
  const s = setup({
    async breakAway() {
      return fresh ? { closes: { binance: [100, 100], bybit: [100, 100], bitget: [100, 100], okx: [100, 100], coinbase: [101.5, 101.5] }, standing: {}, unavailable: [], closeTimes: [lastHour - H, lastHour], stale: false }
        : { closes: {}, standing: {}, unavailable: [], closeTimes: [], stale: true };
    },
  });
  const a = await s.runner.refresh();
  const t0 = s.clock.t;
  ok("M2 fresh: the alert is listed, not stale", a.alerts.some((x) => x.code === "BREAKAWAY_COINBASE") && a.stale.breakaway === undefined);
  fresh = false; s.clock.t = t0 + 90 * MIN;
  const b = await s.runner.refresh();
  ok("M2 90 min without data: alert still listed but marked stale with the time of the data", b.alerts.some((x) => x.code === "BREAKAWAY_COINBASE") && b.stale.breakaway === t0, JSON.stringify(b.stale));
  s.clock.t = t0 + 2 * H + MIN;
  const c = await s.runner.refresh();
  ok("M2 past 2 h: the stale alert is dropped and break-away is unavailable", !c.alerts.some((x) => x.kind === "breakaway") && c.unavailable.includes("breakaway") && c.stale.breakaway === undefined, JSON.stringify([c.alerts.map((x) => x.code), c.unavailable, c.stale]));
  fresh = true; s.clock.t += 5 * MIN;
  const d = await s.runner.refresh();
  ok("M2 fresh data again: the alert returns, not stale", d.alerts.some((x) => x.code === "BREAKAWAY_COINBASE") && d.stale.breakaway === undefined);
}

console.log("fix wave: M3 depeg since = the scan's reading time");
{
  const reading = [{ coin: "USDC", reference: "USDT", deviationPct: 1.2 }];
  let at = T0 - H;
  const s = setup({}, { depeg: () => reading, depegSource: () => "binance", depegAt: () => at });
  const a = await s.runner.refresh();
  ok("M3 since is the reading time, not the refresh time", a.alerts.find((x) => x.code === "DEPEG_USDC")?.since === T0 - H);
  s.clock.t += 5 * MIN;
  const b = await s.runner.refresh();
  ok("M3 since does not move forward on the next refresh", b.alerts.find((x) => x.code === "DEPEG_USDC")?.since === T0 - H);
  at = T0 - 3 * H; s.clock.t += 5 * MIN;
  const c = await s.runner.refresh();
  ok("M3 a reading older than 2 h is not an alert", !c.alerts.some((x) => x.code === "DEPEG_USDC"));
  const s2 = setup({}, { depeg: () => reading });
  const d = await s2.runner.refresh();
  ok("M3 without depegAt the refresh time is used (unchanged)", d.alerts.find((x) => x.code === "DEPEG_USDC")?.since === T0);
}

console.log("v2.8 4b Task 2: liquidation feed wiring");
{
  const alert = { code: "LIQ_CASCADE_BINANCE", kind: "liquidation", trigger: { key: "radar.alert.liq", vars: { venue: "Binance", usd: 9e6, mult: 4.5, median: 2e6, longPct: 80 } }, sourceUrl: "https://www.binance.com/en/futures", since: T0 - H };
  const venue = (connected, cascade) => ({ connected, since: connected ? T0 - H : null, long: 1, short: 2, coveredMs: H, complete: true, sampled: false, cascade });
  const makeFeed = (view) => {
    const f = { starts: 0, stops: 0, views: [], start() { f.starts++; }, stop() { f.stops++; }, running: () => f.starts > f.stops, view(now, th) { f.views.push({ now, th }); return view(); } };
    return f;
  };
  const view = () => ({ bybit: venue(false, { status: "collecting", have: 3 }), binance: venue(true, { status: "ready", medianUsd: 2e6, alert }) });
  const feed = makeFeed(view);
  const s = setup({}, { liquidations: feed });
  s.runner.start();
  await settle();
  const snap = s.runner.latest();
  ok("L1 start() starts the feed", feed.starts === 1);
  ok("L2 the snapshot carries the feed's view", snap?.liquidations?.binance.cascade.status === "ready" && snap.liquidations.bybit.connected === false);
  ok("L3 snap.alerts includes the venue's cascade alert", snap.alerts.some((a) => a.code === "LIQ_CASCADE_BINANCE"));
  ok("L4 toRadarContext.al carries the LIQ code", toRadarContext(snap).al.includes("LIQ_CASCADE_BINANCE"));
  ok("L5 unavailable lists the venue that is not connected, not the connected one", snap.unavailable.includes("liq:bybit") && !snap.unavailable.includes("liq:binance"), JSON.stringify(snap.unavailable));
  s.runner.rethreshold();
  ok("L6 rethreshold recomputes from feed.view(now, th) with the current thresholds", feed.views.length >= 2 && feed.views.at(-1).th.liqMult === DEFAULT_THRESHOLDS.liqMult && feed.views.at(-1).now === s.clock.t);
  s.runner.stop();
  ok("L7 stop() stops the feed", feed.stops >= 1 && !feed.running());
}
{
  const feed = { starts: 0, stops: 0, start() { feed.starts++; }, stop() { feed.stops++; }, running: () => false, view: () => { throw new Error("no"); } };
  const s = setup({}, { liquidations: feed, allowed: () => false });
  s.runner.start();
  ok("L8 while not allowed, start() never starts the feed", feed.starts === 0);
  const g = { starts: 0, stops: 0, start() { g.starts++; }, stop() { g.stops++; }, running: () => false, view: () => { throw new Error("view broke"); } };
  let allowed = true;
  const s2 = setup({}, { liquidations: g, allowed: () => allowed });
  s2.runner.start();
  await settle();
  ok("L9 a throwing view yields liquidations null and no cascade alert, never a failed refresh", s2.runner.latest()?.liquidations === null && s2.runner.lastError() === null && !s2.runner.latest().alerts.some((a) => a.kind === "liquidation"));
  allowed = false;
  [...s2.timers.handles.values()][0].fn();
  ok("L10 a tick after the gate closed stops the feed", g.stops >= 1);
  allowed = true;
  [...s2.timers.handles.values()][0].fn();
  ok("L10b the gate reopened without a stop/start pair: the next tick starts the feed again", g.starts >= 2, String(g.starts));
  const s3 = setup();
  const r = await s3.runner.refresh();
  ok("L11 without a feed: liquidations null, no liq in unavailable", r.liquidations === null && !r.unavailable.some((u) => u.startsWith("liq:")));
}

console.log(`\nradar snapshot: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
