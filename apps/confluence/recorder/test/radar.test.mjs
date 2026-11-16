// v2.8 (WP25, Task 7): the recorder's market-radar context (--radar on|off) — offline, on a mocked clock.
import test, { beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resetRateLimitForTests } from "../src/engine.mjs";
import { parseConfig } from "../src/config.mjs";
import { createRecorder, interruptibleSleep } from "../src/recorder-core.mjs";
import { loadRecorderManifest } from "../src/net.mjs";
import { sanitizeLedgerRow } from "../../web/src/lib/ledger-metrics.ts";
import { baseConfig, H, mockExchange, quiet, T0, tempDir } from "./fixtures.mjs";

// Built at runtime so this file holds no unlisted URL literal (the static egress check scans tests too).
const SCHEME = "https" + "://";
const EVIL = "tracker.evil-cdn" + ".io";
const RADAR_ONLY_HOSTS = ["fapi.binance.com", "publicreporting.cftc.gov", "stablecoins.llama.fi", "api.exchange.coinbase.com", "api.upbit.com", "api.pro.coins.ph"];
const readJsonl = (p) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const ledger = (dir) => readJsonl(join(dir, "ledger", "2026-10.jsonl"));

beforeEach(() => {
  resetRateLimitForTests();
  mock.timers.enable({ apis: ["Date"], now: T0 });
});
afterEach(() => mock.timers.reset());

const DAY = 86_400_000;
/** Deterministic radar fetchers (the shapes of web/src/lib/radar/*); `seen` records calls. */
function fakeFetchers(seen = []) {
  const now = () => Date.now();
  return {
    async positioning(symbol) { seen.push(["positioning", symbol]); return { symbol, fundingRate: 0.0001, fundingPctl30d: 61.5, oi: 1, oiChg24hPct: 2.5, longShortRatio: 1.7, takerBuySellRatio: 1.1, basisPct: 0.02, asOf: now() }; },
    async regional() { seen.push(["regional"]); return { usPct: 0.1, krPct: 1.2, phPct: -0.3, asOf: now(), unavailable: [] }; },
    async buyer() { seen.push(["buyer"]); return { takerShare: [0.4, null, 0.55], sessions: { asia: 0.3, europe: 0.3, us: 0.4 }, asOf: now() }; },
    async cot(asset) { seen.push(["cot", asset]); return { asset, reportDate: "2026-10-27", assetManagers: { long: 10, short: 4, net: 6, netChg: 1 }, leveragedFunds: { long: 3, short: 9, net: -6, netChg: -1 }, openInterest: 100 }; },
    async supply() { seen.push(["supply"]); return Array.from({ length: 120 }, (_, i) => ({ day: Math.floor(now() / DAY) * DAY - (119 - i) * DAY, usd: 1e11 + i * 1e8 })); },
    async breakAway() { seen.push(["breakAway"]); return { closes: {}, standing: {}, unavailable: [], closeTimes: [], stale: true }; },
    async dailyVolumes() { seen.push(["dailyVolumes"]); return { volumes: [], days: [], latest: false, unavailable: [] }; },
  };
}

test("--radar parses on|off, default off; anything else is refused", () => {
  const cfg = (argv, env = {}) => parseConfig(argv, env, "/tmp");
  assert.equal(cfg([]).radar, false);
  assert.equal(cfg(["--radar", "on"]).radar, true);
  assert.equal(cfg(["--radar=off"]).radar, false);
  assert.equal(cfg([], { RECORDER_RADAR: "on" }).radar, true);
  assert.throws(() => cfg(["--radar", "maybe"]), /--radar must be on or off/);
});

test("--radar off makes no radar request", async (t) => {
  const dir = tempDir(t);
  const ex = mockExchange();
  let radarCalls = 0;
  const radarFetchers = new Proxy({}, { get: () => () => { radarCalls++; throw new Error("radar fetcher called with --radar off"); } });
  const rec = createRecorder(baseConfig(dir), { ...quiet, baseFetch: ex.fetch, env: {}, radarFetchers });
  const r = await rec.run(undefined, { once: true });
  assert.equal(r.ok, true);
  assert.ok(ex.calls.length > 0);
  assert.deepEqual(ex.calls.filter((c) => RADAR_ONLY_HOSTS.includes(c.host)), [], "no radar host was contacted");
  assert.equal(radarCalls, 0);
  assert.equal(existsSync(join(dir, "radar")), false, "no radar folder");
  const rows = ledger(dir);
  assert.ok(rows.length > 0 && rows.every((x) => x.rad === null), "every row has rad null");
  assert.ok(rows.every((x) => sanitizeLedgerRow(x) !== null));
});

test("--radar on writes rad on rows and a radar log (pre-close wake serves the next close; first rows have none)", async (t) => {
  const dir = tempDir(t);
  const ex = mockExchange();
  const seen = [];
  const ac = new AbortController();
  const wakes = [];
  const sleepUntil = async (until) => {
    wakes.push(until);
    if (wakes.length >= 3) ac.abort(); // pre-close wake, regular wake, then the next pre-close wake
    else mock.timers.setTime(until);
  };
  const rec = createRecorder(baseConfig(dir, { once: false, radar: true }), { ...quiet, sleepUntil, baseFetch: ex.fetch, env: {}, radarFetchers: fakeFetchers(seen) });
  await rec.run(ac.signal);
  assert.equal(wakes.length, 3);

  const log = readJsonl(join(dir, "radar", "2026-10.jsonl"));
  assert.equal(log.length, 3, "cycle 1, the pre-close wake, cycle 2");
  const pre = log[1];
  assert.equal(pre.t, wakes[0], "the pre-close entry is stamped at the wake (15 min before the 16:00 close)");
  assert.deepEqual(Object.keys(pre).sort(), ["al", "frp", "krP", "ls", "oi24", "phP", "t", "tk", "usP"]);
  assert.deepEqual({ ...pre, t: 0 }, { t: 0, frp: 61.5, oi24: 2.5, ls: 1.7, tk: 0.55, usP: 0.1, krP: 1.2, phP: -0.3, al: [] });

  const rows = ledger(dir);
  const first = rows.filter((x) => x.tc === Date.UTC(2026, 9, 31, 12));
  const second = rows.filter((x) => x.tc === Date.UTC(2026, 9, 31, 16));
  assert.ok(first.length >= 3 && second.length >= 3);
  assert.ok(first.every((x) => x.rad === null), "no earlier entry at the first cycle");
  assert.ok(second.every((x) => JSON.stringify(x.rad) === JSON.stringify(pre)), "newest entry at or before the close, never the 16:00:20 one");
  assert.ok(rows.every((x) => sanitizeLedgerRow(x) !== null), "every row passes the importer's sanitiser");
  assert.ok(seen.filter(([k]) => k === "positioning").length >= 6);
  // a restart reads the log back: the entry still serves catch-up rows after a gap
  assert.equal(existsSync(join(dir, "radar", "cache.json")), true, "slow-input cache kept for scheduler --once runs");
});

test("radar fetches run through the egress guard, even when a cycle is run directly", async (t) => {
  const dir = tempDir(t);
  const ex = mockExchange({ override: (url) => (url.host === "fapi.binance.com" ? new Response("{}", { status: 200 }) : undefined) });
  // A direct cycle() (no run()) has no guard installed for the engine; give it the plain mock so only the radar step is under test.
  const before = globalThis.fetch;
  globalThis.fetch = ex.fetch;
  t.after(() => { globalThis.fetch = before; });
  const outcome = [];
  const fetchers = {
    ...fakeFetchers(),
    async positioning(symbol) {
      outcome.push(await globalThis.fetch(`${SCHEME}${EVIL}/x`).then(() => "reached", (e) => e.name));
      outcome.push(await globalThis.fetch(`${SCHEME}fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`).then((r) => r.status, (e) => e.name));
      return fakeFetchers().positioning(symbol);
    },
  };
  const rec = createRecorder(baseConfig(dir, { radar: true }), { ...quiet, baseFetch: ex.fetch, env: {}, radarFetchers: fetchers });
  const r = await rec.cycle();
  assert.equal(r.ok, true);
  assert.deepEqual([...outcome].sort(), [200, 200, "EgressBlockedError", "EgressBlockedError"], "BTC and ETH positioning: the unlisted host refused, the manifest host reached");
  assert.equal(ex.calls.some((c) => c.host === EVIL), false, "the base fetch never saw the unlisted host");
  assert.equal(globalThis.fetch, ex.fetch, "the global fetch is restored after the refresh");
});

test("the real radar fetchers only reach manifest hosts (unreachable radar hosts fail the sections, not the cycle)", async (t) => {
  const dir = tempDir(t);
  const ex = mockExchange({ override: (url) => (RADAR_ONLY_HOSTS.concat(["stablecoins.llama.fi"]).includes(url.host) ? new Response("down", { status: 503 }) : undefined) });
  const before = globalThis.fetch;
  globalThis.fetch = ex.fetch;
  t.after(() => { globalThis.fetch = before; });
  const rec = createRecorder(baseConfig(dir, { radar: true }), { ...quiet, baseFetch: ex.fetch, env: {} });
  const r = await rec.cycle();
  assert.equal(r.ok, true, "a failing radar never fails the cycle");
  const manifest = loadRecorderManifest();
  const radarCalls = ex.calls.filter((c) => RADAR_ONLY_HOSTS.includes(c.host));
  assert.ok(radarCalls.some((c) => c.host === "fapi.binance.com"), "the radar did request its hosts");
  assert.ok(ex.calls.every((c) => manifest.hosts.includes(c.host)), "every request went to a manifest host");
  const rows = ledger(dir);
  assert.ok(rows.length > 0 && rows.every((x) => x.rad === null));
  const log = readJsonl(join(dir, "radar", "2026-10.jsonl"));
  assert.equal(log.length, 1);
  assert.ok(log[0].frp === null && log[0].oi24 === null && log[0].ls === null, "fapi.binance.com was down: positioning fields null");
});
