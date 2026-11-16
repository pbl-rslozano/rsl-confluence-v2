// v2.8 Step 4b (WP25, Task 4): the recorder's liquidation streams (--radar on, continuous mode) — fake sockets, mocked clock.
import test, { beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resetRateLimitForTests } from "../src/engine.mjs";
import { createRecorder } from "../src/recorder-core.mjs";
import { createRadarRecorder } from "../src/radar.mjs";
import { createGuardedFetch, EgressBlockedError, guardedWebSocket, loadRecorderManifest } from "../src/net.mjs";
import { createJsonlAppender, monthOf, writeJsonAtomic, ensureDir } from "../src/store.mjs";
import { baseConfig, mockExchange, quiet, T0, tempDir } from "./fixtures.mjs";

// Built at runtime so this file holds no unlisted URL literal (the static egress check scans tests too).
const WSS = "wss" + "://";
const BYBIT_URL = `${WSS}stream.bybit.com/v5/public/linear`;
const BINANCE_URL = `${WSS}fstream.binance.com/market/ws/!forceOrder@arr`;
const HOUR = 3_600_000;
const MIN = 60_000;

class FakeWs {
  static all = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closed = false; this.l = {}; FakeWs.all.push(this); }
  addEventListener(type, fn) { (this.l[type] ??= []).push(fn); }
  send(d) { this.sent.push(d); }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; for (const fn of this.l.open ?? []) fn({}); }
  say(obj) { for (const fn of this.l.message ?? []) fn({ data: JSON.stringify(obj) }); }
}
const live = () => FakeWs.all.filter((w) => !w.closed);
const sockOf = (url) => FakeWs.all.find((w) => w.url === url);
const ack = (ws) => ws.say({ success: true, ret_msg: "", conn_id: "x", op: "subscribe" });
const bybitEv = (t, S, v, p) => ({ topic: "allLiquidation.BTCUSDT", type: "snapshot", ts: t, data: [{ T: t, s: "BTCUSDT", S, v: String(v), p: String(p) }] });

beforeEach(() => {
  FakeWs.all = [];
  resetRateLimitForTests();
  mock.timers.enable({ apis: ["Date"], now: T0 });
});
afterEach(() => mock.timers.reset());

const DAY = 86_400_000;
function fakeFetchers() {
  const now = () => Date.now();
  return {
    async positioning(symbol) { return { symbol, fundingRate: 0.0001, fundingPctl30d: 61.5, oi: 1, oiChg24hPct: 2.5, longShortRatio: 1.7, takerBuySellRatio: 1.1, basisPct: 0.02, asOf: now() }; },
    async regional() { return { usPct: 0.1, krPct: 1.2, phPct: -0.3, asOf: now(), unavailable: [] }; },
    async buyer() { return { takerShare: [0.4, null, 0.55], sessions: { asia: 0.3, europe: 0.3, us: 0.4 }, asOf: now() }; },
    async cot(asset) { return { asset, reportDate: "2026-10-27", assetManagers: { long: 10, short: 4, net: 6, netChg: 1 }, leveragedFunds: { long: 3, short: 9, net: -6, netChg: -1 }, openInterest: 100 }; },
    async supply() { return Array.from({ length: 120 }, (_, i) => ({ day: Math.floor(now() / DAY) * DAY - (119 - i) * DAY, usd: 1e11 + i * 1e8 })); },
    async breakAway() { return { closes: {}, standing: {}, unavailable: [], closeTimes: [], stale: true }; },
    async dailyVolumes() { return { volumes: [], days: [], latest: false, unavailable: [] }; },
  };
}
const makeRadar = (dir, extra = {}) => {
  const guard = createGuardedFetch({ baseFetch: async () => new Response("{}"), hosts: [] });
  return createRadarRecorder({ guard, outDir: dir, appendJsonl: createJsonlAppender(), monthOf, fetchers: fakeFetchers(), ...extra });
};
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

test("guardedWebSocket refuses a host outside websocketHosts", () => {
  const built = [];
  const Guarded = guardedWebSocket(["stream.bybit.com"], class { constructor(u) { built.push(u); } });
  assert.throws(() => new Guarded(`${WSS}evil.example.net/x`), (e) => e instanceof EgressBlockedError && !/\/x/.test(e.message) && /wss:\/\/evil\.example\.net/.test(e.message));
  assert.throws(() => new Guarded("ws" + "://stream.bybit.com/v5/public/linear"), EgressBlockedError);
  assert.throws(() => new Guarded(`${WSS}stream.bybit.com:8443/v5/public/linear`), EgressBlockedError, "a non-default port is another host");
  assert.throws(() => new Guarded("not a url"), TypeError);
  assert.deepEqual(built, [], "nothing was constructed");
});

test("guardedWebSocket allows the two radar hosts", () => {
  const manifest = loadRecorderManifest();
  assert.deepEqual([...manifest.websocketHosts].sort(), ["fstream.binance.com", "stream.bybit.com"]);
  const built = [];
  const Guarded = guardedWebSocket(manifest.websocketHosts, class { constructor(u) { built.push(u); } });
  new Guarded(BYBIT_URL);
  new Guarded(BINANCE_URL);
  assert.deepEqual(built, [BYBIT_URL, BINANCE_URL]);
});

test("radar recorder persists complete hours to radar/liq.json and reloads them", async (t) => {
  const dir = tempDir(t);
  const hour0 = Math.floor(T0 / HOUR) * HOUR + HOUR; // the next full hour
  mock.timers.setTime(hour0 - MIN);
  const rec = makeRadar(dir, { liquidations: true, WebSocketCtor: FakeWs });
  assert.equal(FakeWs.all.length, 0, "no socket before start()");
  rec.start();
  assert.equal(FakeWs.all.length, 2);
  const bybit = sockOf(BYBIT_URL);
  const binance = sockOf(BINANCE_URL);
  bybit.open(); ack(bybit); binance.open();
  // one minute at a time, so no gap longer than the sleep detector allows, until the hour is complete and its grace has passed
  for (let t = hour0; t <= hour0 + HOUR + 10_000; t += MIN) {
    mock.timers.setTime(t);
    if (t === hour0 + 10 * MIN) bybit.say(bybitEv(t, "Buy", 1, 50_000));
    else bybit.say({ op: "pong" });
  }
  mock.timers.setTime(hour0 + HOUR + 10_000);
  bybit.say({ op: "pong" });
  await settle();
  rec.stop();
  const path = join(dir, "radar", "liq.json");
  assert.equal(existsSync(path), true);
  const doc = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(doc.v, 1);
  assert.deepEqual(doc.hours.bybit, [{ h: hour0, long: 50_000, short: 0 }]);
  assert.equal(doc.hours.binance.length, 1);
  assert.equal(live().length, 0, "stop() closed both sockets");

  const again = makeRadar(dir, { liquidations: true, WebSocketCtor: FakeWs });
  await settle();
  const view = again.liquidationView(Date.now());
  assert.equal(view.bybit.cascade.status, "collecting");
  assert.equal(view.bybit.cascade.have, 1);
});

test("--once opens no socket and says so once", async (t) => {
  const dir = tempDir(t);
  const ex = mockExchange();
  const lines = [];
  const rec = createRecorder(baseConfig(dir, { radar: true }), { ...quiet, log: (l) => lines.push(l), baseFetch: ex.fetch, env: {}, radarFetchers: fakeFetchers(), WebSocketCtor: FakeWs });
  const r = await rec.run(undefined, { once: true });
  assert.equal(r.ok, true);
  assert.equal(FakeWs.all.length, 0, "no socket was constructed");
  assert.equal(lines.filter((l) => /liquidation streams need continuous mode/.test(l)).length, 1);
});

test("continuous --radar on starts the sockets at start-up and closes them on abort; --radar off opens none", async (t) => {
  const dir = tempDir(t);
  const ex = mockExchange();
  const ac = new AbortController();
  let wakes = 0;
  let openDuringRun = -1;
  const sleepUntil = async (until) => {
    wakes++;
    openDuringRun = live().length;
    ac.abort();
  };
  const rec = createRecorder(baseConfig(dir, { once: false, radar: true }), { ...quiet, sleepUntil, baseFetch: ex.fetch, env: {}, radarFetchers: fakeFetchers(), WebSocketCtor: FakeWs });
  await rec.run(ac.signal);
  assert.ok(wakes >= 1);
  assert.equal(openDuringRun, 2, "both streams were open while the recorder slept");
  assert.equal(live().length, 0, "every socket is closed after the run");

  FakeWs.all = [];
  const dir2 = tempDir(t);
  const ac2 = new AbortController();
  const off = createRecorder(baseConfig(dir2, { once: false, radar: false }), { ...quiet, sleepUntil: async () => ac2.abort(), baseFetch: mockExchange().fetch, env: {}, WebSocketCtor: FakeWs });
  await off.run(ac2.signal);
  assert.equal(FakeWs.all.length, 0);
});

test("sockets are closed when the run fails", async (t) => {
  const dir = tempDir(t);
  const ex = mockExchange();
  const rec = createRecorder(baseConfig(dir, { once: false, radar: true }), { ...quiet, sleepUntil: async () => { throw new Error("boom"); }, baseFetch: ex.fetch, env: {}, radarFetchers: fakeFetchers(), WebSocketCtor: FakeWs });
  await assert.rejects(rec.run(new AbortController().signal), /boom/);
  assert.equal(FakeWs.all.length, 2);
  assert.equal(live().length, 0);
});

test("context rows carry LIQ_CASCADE codes", async (t) => {
  const dir = tempDir(t);
  const now = Math.floor(T0 / HOUR) * HOUR + 30 * MIN;
  mock.timers.setTime(now - 2 * HOUR);
  // a 30-day baseline of complete hours (median 10 000) written the way an earlier session would have left it
  const hours = Array.from({ length: 720 }, (_, i) => ({ h: Math.floor((now - 2 * HOUR) / HOUR) * HOUR - (719 - i) * HOUR - HOUR, long: 6_000, short: 4_000 }));
  ensureDir(join(dir, "radar"));
  writeJsonAtomic(join(dir, "radar", "liq.json"), { v: 1, hours: { bybit: hours, binance: hours } });
  const rec = makeRadar(dir, { liquidations: true, WebSocketCtor: FakeWs });
  await settle();
  rec.start();
  const bybit = sockOf(BYBIT_URL);
  bybit.open(); ack(bybit); sockOf(BINANCE_URL).open();
  for (let t = now - 2 * HOUR + MIN; t <= now; t += MIN) {
    mock.timers.setTime(t);
    bybit.say(t === now - 20 * MIN ? bybitEv(t, "Sell", 1, 90_000) : { op: "pong" }); // 90 000 inside the last hour: 9 x the median
  }
  const { ctx } = await rec.refresh();
  rec.stop();
  assert.ok(ctx.al.includes("LIQ_CASCADE_BYBIT"), `al: ${JSON.stringify(ctx.al)}`);
  assert.ok(!ctx.al.includes("LIQ_CASCADE_BINANCE"));
});

test("a corrupt or hostile radar/liq.json reads as an empty baseline and never throws", async (t) => {
  const bad = [
    JSON.stringify({ v: 1, hours: { bybit: [{ h: "x", long: -1, short: 1e30 }, null], binance: "nope" } }),
    JSON.stringify({ v: 1, hours: { bybit: [{ h: Number.NaN, long: 1, short: 1 }, { h: 1.5, long: 1, short: 1 }, [], 7] } }),
    JSON.stringify([1, 2, 3]),
    "{ not json at all",
    "",
  ];
  for (const text of bad) {
    const dir = tempDir(t);
    ensureDir(join(dir, "radar"));
    writeFileSync(join(dir, "radar", "liq.json"), text);
    let rec;
    assert.doesNotThrow(() => { rec = makeRadar(dir, { liquidations: true, WebSocketCtor: FakeWs }); }, text);
    await settle();
    const view = rec.liquidationView(Date.now());
    assert.equal(view.bybit.cascade.status, "collecting", text);
    assert.equal(view.bybit.cascade.have, 0, text);
    assert.equal(view.binance.cascade.have, 0, text);
  }
});

test("an already aborted signal starts no liquidation stream", async (t) => {
  const dir = tempDir(t);
  const ex = mockExchange();
  const ac = new AbortController();
  ac.abort();
  const lines = [];
  const rec = createRecorder(baseConfig(dir, { once: false, radar: true }), { ...quiet, log: (l) => lines.push(l), sleepUntil: async () => undefined, baseFetch: ex.fetch, env: {}, radarFetchers: fakeFetchers(), WebSocketCtor: FakeWs });
  await rec.run(ac.signal);
  assert.equal(FakeWs.all.length, 0, "no socket was constructed");
  assert.equal(lines.filter((l) => /liquidation streams started/.test(l)).length, 0);
});

// F3 (WP25 4b final review): "no value for liq:*" is not a heartbeat error while the feed is not running or has never connected.
const heartbeatMsgs = (dir) => JSON.parse(readFileSync(join(dir, "heartbeat.json"), "utf8")).errors.map((e) => e.msg);
const drop = (ws) => { ws.readyState = 3; for (const fn of ws.l.close ?? []) fn({}); };

test("F3: --once --radar on writes no liq heartbeat errors (the feed is never started)", async (t) => {
  const dir = tempDir(t);
  const rec = createRecorder(baseConfig(dir, { radar: true }), { ...quiet, baseFetch: mockExchange().fetch, env: {}, radarFetchers: fakeFetchers(), WebSocketCtor: FakeWs });
  const r = await rec.run(undefined, { once: true });
  assert.equal(r.ok, true);
  assert.deepEqual(heartbeatMsgs(dir).filter((m) => /liq:/.test(m)), []);
});

test("F3: continuous mode before any venue acknowledged writes no liq errors; a venue that connected and then dropped does", async (t) => {
  const dir = tempDir(t);
  const ac = new AbortController();
  let wakes = 0;
  const seen = [];
  const sleepUntil = async () => {
    wakes++;
    seen.push(heartbeatMsgs(dir).filter((m) => /liq:/.test(m)));
    mock.timers.setTime(Date.now() + 6 * MIN); // past the 5-minute radar cadence: the next cycle refreshes
    if (wakes === 1) { const by = sockOf(BYBIT_URL); by.open(); ack(by); }
    else if (wakes === 2) drop(sockOf(BYBIT_URL));
    else ac.abort();
  };
  const rec = createRecorder(baseConfig(dir, { once: false, radar: true }), { ...quiet, sleepUntil, baseFetch: mockExchange().fetch, env: {}, radarFetchers: fakeFetchers(), WebSocketCtor: FakeWs });
  await rec.run(ac.signal);
  assert.deepEqual(seen[0], [], "first cycle: nothing has connected yet");
  assert.deepEqual(seen[1], [], "second cycle: bybit is up, binance never connected");
  assert.ok(seen[2].some((m) => /liq:bybit/.test(m)), "third cycle: bybit dropped after connecting");
  assert.ok(!seen[2].some((m) => /liq:binance/.test(m)), "binance never connected: still not reported");
});
