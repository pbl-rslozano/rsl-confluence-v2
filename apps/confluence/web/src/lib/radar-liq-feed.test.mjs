// Liquidation websocket feed — v2.8 Step 4b (WP25, Task 2). Fake sockets, fake timers, in-memory store.
// Run: npm run test:radar-liq-feed   (node scripts/run-engine-tests.mjs radar-liq-feed.test.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLiquidationFeed, BINANCE_LIQ_URL, BYBIT_LIQ_URL } from "./radar/liquidation-feed.ts";
import { LIQ_HOUR_MS } from "./radar/liquidations.ts";
import { DEFAULT_THRESHOLDS } from "./radar/alerts.ts";
import { RADAR_COLLECTION, RADAR_LIQ_ID } from "./radar/store.ts";

const H = LIQ_HOUR_MS;
const MIN = 60_000;
const H0 = Date.UTC(2026, 10, 16, 12, 0, 0);

class FakeWs {
  static all = [];
  static autoPong = true; // a live Bybit socket answers {"op":"ping"}
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closed = false; this.l = {}; FakeWs.all.push(this); }
  addEventListener(type, fn) { (this.l[type] ??= []).push(fn); }
  send(d) { this.sent.push(d); if (FakeWs.autoPong && d === '{"op":"ping"}') this.say({ success: true, ret_msg: "pong", conn_id: "x", op: "ping" }); }
  close() { this.closed = true; this.readyState = 3; }
  emit(type, ev = {}) { for (const fn of this.l[type] ?? []) fn(ev); }
  open() { this.readyState = 1; this.emit("open"); }
  say(obj) { this.emit("message", { data: typeof obj === "string" ? obj : JSON.stringify(obj) }); }
  drop() { this.readyState = 3; this.emit("close"); }
}

function fakeTimers(clock) {
  let seq = 0;
  const items = new Map();
  const api = {
    setTimeout(fn, ms) { const id = ++seq; items.set(id, { fn, at: clock.t + ms, every: 0 }); return id; },
    clearTimeout(id) { items.delete(id); },
    setInterval(fn, ms) { const id = ++seq; items.set(id, { fn, at: clock.t + ms, every: ms }); return id; },
    clearInterval(id) { items.delete(id); },
    count: () => items.size,
    advance(ms) {
      const target = clock.t + ms;
      for (;;) {
        let best = null;
        for (const [id, it] of items) if (it.at <= target && (!best || it.at < best[1].at)) best = [id, it];
        if (!best) break;
        const [id, it] = best;
        const due = it.at;
        clock.t = Math.max(clock.t, due); // an overdue timer fires once, late (a machine that slept)
        if (it.every) it.at = (due < clock.t ? clock.t : due) + it.every; else items.delete(id);
        it.fn();
      }
      clock.t = target;
    },
  };
  return api;
}

function memStore() {
  const docs = new Map();
  return {
    docs, failGet: false, failPut: false,
    async get(col, id) { if (this.failGet) throw new Error("read failed"); return docs.get(`${col}/${id}`); },
    async put(col, id, doc) { if (this.failPut) throw new Error("write failed"); docs.set(`${col}/${id}`, structuredClone(doc)); },
  };
}

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

function setup(t0 = H0, store = memStore()) {
  FakeWs.all = [];
  FakeWs.autoPong = true;
  const clock = { t: t0 };
  const timers = fakeTimers(clock);
  const feed = createLiquidationFeed({ WebSocketCtor: FakeWs, now: () => clock.t, store, timers });
  const sock = (venue) => FakeWs.all.filter((w) => w.url === (venue === "bybit" ? BYBIT_LIQ_URL : BINANCE_LIQ_URL));
  return { clock, timers, feed, store, sock };
}
const ackSub = (ws) => ws.say({ success: true, ret_msg: "", conn_id: "x", op: "subscribe" });
const bybitEv = (t, S, v, p) => ({ topic: "allLiquidation.BTCUSDT", type: "snapshot", ts: t, data: [{ T: t, s: "BTCUSDT", S, v: String(v), p: String(p) }] });

test("URLs are written literally", () => {
  assert.equal(BINANCE_LIQ_URL, "wss://fstream.binance.com/market/ws/!forceOrder@arr");
  assert.equal(BYBIT_LIQ_URL, "wss://stream.bybit.com/v5/public/linear");
});

test("start opens one socket per venue and subscribes bybit; a second start opens nothing", () => {
  const { feed, sock, timers } = setup();
  assert.equal(feed.running(), false);
  assert.equal(FakeWs.all.length, 0, "nothing opens before start");
  feed.start();
  feed.start();
  assert.equal(feed.running(), true);
  assert.equal(FakeWs.all.length, 2);
  assert.equal(sock("bybit").length, 1);
  assert.equal(sock("binance").length, 1);
  sock("bybit")[0].open();
  assert.deepEqual(sock("bybit")[0].sent.map((s) => JSON.parse(s)), [{ op: "subscribe", args: ["allLiquidation.BTCUSDT", "allLiquidation.ETHUSDT"] }]);
  sock("binance")[0].open();
  assert.deepEqual(sock("binance")[0].sent, []);
  feed.stop();
  assert.equal(timers.count(), 0);
});

test("bybit counts as connected only after the subscribe success; binance on open", () => {
  const { feed, sock, clock } = setup();
  feed.start();
  const [by] = sock("bybit");
  const [bn] = sock("binance");
  by.open();
  bn.open();
  let v = feed.view(clock.t, DEFAULT_THRESHOLDS);
  assert.equal(v.bybit.connected, false);
  assert.equal(v.binance.connected, true);
  assert.equal(v.binance.sampled, true);
  assert.equal(v.bybit.sampled, false);
  by.say({ success: true, ret_msg: "pong", op: "ping" }); // a pong is not a subscribe reply
  assert.equal(feed.view(clock.t, DEFAULT_THRESHOLDS).bybit.connected, false);
  ackSub(by);
  v = feed.view(clock.t, DEFAULT_THRESHOLDS);
  assert.equal(v.bybit.connected, true);
  assert.equal(v.bybit.since, clock.t);
  feed.stop();
});

test("events are summed into the last-60 view", async () => {
  const { feed, sock, clock } = setup();
  feed.start();
  sock("bybit")[0].open(); ackSub(sock("bybit")[0]);
  sock("binance")[0].open();
  clock.t += MIN;
  sock("bybit")[0].say(bybitEv(clock.t, "Buy", 2, 50_000));
  sock("binance")[0].say({ e: "forceOrder", o: { s: "ETHUSDT", S: "BUY", q: "1", p: "2000", ap: "2000", z: "1", T: clock.t } });
  sock("bybit")[0].say("not json");
  const v = feed.view(clock.t, DEFAULT_THRESHOLDS);
  assert.equal(v.bybit.long, 100_000);
  assert.equal(v.binance.short, 2000);
  assert.equal(v.bybit.cascade.status, "collecting");
  feed.stop();
});

test("a close schedules a reconnect with backoff 2, 4, 8 ... capped at 60 s", () => {
  const { feed, sock, timers } = setup();
  feed.start();
  const delays = [];
  let seen = 1;
  for (let i = 0; i < 8; i++) {
    const cur = sock("binance").at(-1);
    cur.drop();
    // find the delay by stepping 1 s at a time
    let waited = 0;
    while (sock("binance").length === seen && waited < 100_000) { timers.advance(1000); waited += 1000; }
    delays.push(waited);
    seen = sock("binance").length;
  }
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  feed.stop();
});

test("an error and its close schedule only one reconnect", () => {
  const { feed, sock, timers } = setup();
  feed.start();
  const s = sock("binance")[0];
  s.emit("error", {});
  s.drop();
  timers.advance(2000);
  assert.equal(sock("binance").length, 2);
  feed.stop();
});

test("backoff resets after 5 minutes connected", () => {
  const { feed, sock, timers } = setup();
  feed.start();
  sock("binance")[0].drop();
  timers.advance(2000);
  sock("binance")[1].drop();
  timers.advance(4000);
  assert.equal(sock("binance").length, 3);
  sock("binance")[2].open();
  timers.advance(5 * MIN);
  sock("binance")[2].drop();
  timers.advance(2000); // back to the first step
  assert.equal(sock("binance").length, 4);
  feed.stop();
});

test("stop closes both sockets, clears every timer and no reconnect fires after stop", () => {
  const { feed, sock, timers, clock } = setup();
  feed.start();
  sock("bybit")[0].open(); ackSub(sock("bybit")[0]);
  sock("binance")[0].open();
  sock("binance")[0].drop(); // a reconnect is now pending
  feed.stop();
  assert.equal(feed.running(), false);
  assert.ok(sock("bybit")[0].closed);
  assert.equal(timers.count(), 0, "no timer left");
  timers.advance(120_000);
  assert.equal(FakeWs.all.length, 2, "no new socket");
  sock("bybit")[0].say(bybitEv(H0, "Buy", 1, 1)); // late event on a closed socket is ignored
  assert.equal(feed.view(clock.t, DEFAULT_THRESHOLDS).bybit.long, 0);
});

test("stopping counts as a disconnection: the view says not connected", () => {
  const { feed, sock, clock } = setup();
  feed.start();
  sock("binance")[0].open();
  feed.stop();
  assert.equal(feed.view(clock.t, DEFAULT_THRESHOLDS).binance.connected, false);
  feed.start();
  assert.equal(FakeWs.all.length, 4, "a restart opens two new sockets");
  feed.stop();
});

test("bybit pings every 20 s while open, and stops after a close", () => {
  const { feed, sock, timers } = setup();
  feed.start();
  const by = sock("bybit")[0];
  by.open(); ackSub(by);
  const pings = () => by.sent.filter((s) => JSON.parse(s).op === "ping").length;
  timers.advance(19_000);
  assert.equal(pings(), 0);
  timers.advance(1000);
  assert.equal(pings(), 1);
  assert.equal(by.sent.at(-1), '{"op":"ping"}');
  timers.advance(40_000);
  assert.equal(pings(), 3);
  by.drop();
  timers.advance(19_000);
  assert.equal(pings(), 3);
  feed.stop();
});

test("complete hours are persisted and reloaded", async () => {
  const store = memStore();
  const { feed, sock, clock, timers } = setup(H0 - 2 * MIN, store);
  feed.start();
  sock("bybit")[0].open(); ackSub(sock("bybit")[0]);
  sock("binance")[0].open();
  timers.advance(10 * MIN);
  sock("bybit")[0].say(bybitEv(clock.t, "Buy", 1, 50_000)); // 50 000 long
  timers.advance(20 * MIN);
  sock("bybit")[0].say(bybitEv(clock.t, "Sell", 2, 10_000)); // 20 000 short
  timers.advance(H); // past the hour end + 5 s grace; the 60 s roll timer fires
  await flush();
  const doc = store.docs.get(`${RADAR_COLLECTION}/${RADAR_LIQ_ID}`);
  assert.equal(doc.v, 1);
  assert.deepEqual(doc.hours.bybit, [{ h: H0, long: 50_000, short: 20_000 }]);
  assert.deepEqual(doc.hours.binance, [{ h: H0, long: 0, short: 0 }]);
  feed.stop();
  const again = setup(clock.t, store);
  await flush();
  const v = again.feed.view(clock.t, DEFAULT_THRESHOLDS);
  assert.deepEqual(v.bybit.cascade, { status: "collecting", have: 1 });
  assert.deepEqual(v.binance.cascade, { status: "collecting", have: 1 });
});

test("an hour is not closed before the 5 s grace, so a late event still counts", async () => {
  const store = memStore();
  const { feed, sock, clock, timers } = setup(H0 - 2 * MIN, store);
  feed.start();
  sock("bybit")[0].open(); ackSub(sock("bybit")[0]);
  sock("binance")[0].open();
  timers.advance(30 * MIN);
  sock("bybit")[0].say(bybitEv(clock.t, "Buy", 1, 1000)); // 1 000
  timers.advance(H0 + H + 3000 - clock.t); // 3 s after the hour end
  assert.equal(clock.t, H0 + H + 3000);
  sock("bybit")[0].say(bybitEv(H0 + H - 500, "Sell", 1, 700)); // delivered late; this message also rolls
  await flush();
  assert.equal(store.docs.get(`${RADAR_COLLECTION}/${RADAR_LIQ_ID}`), undefined, "not closed yet");
  timers.advance(MIN); // the next 60 s roll is past the grace
  await flush();
  const doc = store.docs.get(`${RADAR_COLLECTION}/${RADAR_LIQ_ID}`);
  assert.deepEqual(doc.hours.bybit, [{ h: H0, long: 1000, short: 700 }]);
  feed.stop();
});

test("an unreadable store starts empty, never throws, and a failed read never overwrites", async () => {
  const store = memStore();
  store.docs.set(`${RADAR_COLLECTION}/${RADAR_LIQ_ID}`, { v: 1, hours: { bybit: [{ h: H0 - 5 * H, long: 1, short: 1 }], binance: [] } });
  store.failGet = true;
  const { feed, sock, clock, timers } = setup(H0 - 2 * MIN, store);
  await flush();
  assert.deepEqual(feed.view(clock.t, DEFAULT_THRESHOLDS).bybit.cascade, { status: "collecting", have: 0 });
  feed.start();
  sock("binance")[0].open();
  sock("bybit")[0].open(); ackSub(sock("bybit")[0]);
  timers.advance(H + 10 * MIN);
  await flush();
  assert.deepEqual(store.docs.get(`${RADAR_COLLECTION}/${RADAR_LIQ_ID}`).hours.bybit, [{ h: H0 - 5 * H, long: 1, short: 1 }], "stored doc untouched");
  feed.stop();
});

test("garbage in the stored doc is dropped on load", async () => {
  const store = memStore();
  store.docs.set(`${RADAR_COLLECTION}/${RADAR_LIQ_ID}`, { v: 1, hours: { bybit: [{ h: 12345, long: 1, short: 1 }, { h: H0 - H, long: -4, short: 0 }, { h: H0 - 2 * H, long: 3, short: 4 }], binance: "x" } });
  const { feed, clock } = setup(H0, store);
  await flush();
  const v = feed.view(clock.t, DEFAULT_THRESHOLDS);
  assert.deepEqual(v.bybit.cascade, { status: "collecting", have: 1 });
  assert.deepEqual(v.binance.cascade, { status: "collecting", have: 0 });
});

test("I1: hours the machine slept through are not saved as complete zeros (sockets drop on waking)", async () => {
  const store = memStore();
  const { feed, sock, clock, timers } = setup(H0 - 2 * MIN, store);
  feed.start();
  for (const v of ["bybit", "binance"]) sock(v)[0].open();
  ackSub(sock("bybit")[0]);
  clock.t += 3 * H; // asleep: no timer runs, no close arrives
  for (const v of ["bybit", "binance"]) sock(v)[0].drop();
  timers.advance(5000);
  for (const v of ["bybit", "binance"]) { sock(v).at(-1).open(); }
  ackSub(sock("bybit").at(-1));
  timers.advance(2 * H);
  await flush();
  const doc = store.docs.get(`${RADAR_COLLECTION}/${RADAR_LIQ_ID}`);
  for (const v of ["bybit", "binance"]) assert.deepEqual((doc?.hours[v] ?? []).filter((x) => x.h < H0 + 3 * H), [], `${v}: no slept hour is stored`);
  feed.stop();
});

test("I1: hours the machine slept through are not saved as complete zeros (a timer fires first, sockets stay up)", async () => {
  const store = memStore();
  const { feed, sock, clock, timers } = setup(H0 - 2 * MIN, store);
  feed.start();
  for (const v of ["bybit", "binance"]) sock(v)[0].open();
  ackSub(sock("bybit")[0]);
  clock.t += 3 * H;
  timers.advance(60_000); // the roll timer wakes first
  await flush();
  timers.advance(2 * H);
  await flush();
  const doc = store.docs.get(`${RADAR_COLLECTION}/${RADAR_LIQ_ID}`);
  for (const v of ["bybit", "binance"]) assert.deepEqual((doc?.hours[v] ?? []).filter((x) => x.h < H0 + 3 * H), [], `${v}: no slept hour is stored`);
  assert.ok((doc?.hours.binance ?? []).some((x) => x.h >= H0 + 3 * H), "hours after waking are covered again");
  feed.stop();
});

test("I1: a bybit socket that goes silent (no pong) is closed and reconnected through the backoff", () => {
  const { feed, sock, timers } = setup();
  feed.start();
  FakeWs.autoPong = false;
  const by = sock("bybit")[0];
  by.open(); ackSub(by);
  timers.advance(40_000);
  assert.equal(sock("bybit").length, 1, "40 s of silence is tolerated");
  timers.advance(20_000);
  assert.ok(by.closed, "closed after about two ping intervals of silence");
  assert.equal(feed.view(H0 + 60_000, DEFAULT_THRESHOLDS).bybit.connected, false);
  timers.advance(2000);
  assert.equal(sock("bybit").length, 2);
  feed.stop();
});

test("I1: a bybit socket that keeps answering pings is never recycled", () => {
  const { feed, sock, timers } = setup();
  feed.start();
  const by = sock("bybit")[0];
  by.open(); ackSub(by);
  timers.advance(10 * MIN);
  assert.equal(sock("bybit").length, 1);
  assert.equal(by.closed, false);
  feed.stop();
});

test("I1: a bybit subscribe reply with success false reconnects through the backoff", () => {
  const { feed, sock, timers } = setup();
  feed.start();
  const by = sock("bybit")[0];
  by.open();
  by.say({ success: false, ret_msg: "error:handler not found", op: "subscribe" });
  assert.ok(by.closed);
  timers.advance(2000);
  assert.equal(sock("bybit").length, 2);
  feed.stop();
});

test("I1: no subscribe reply within 10 s reconnects through the backoff", () => {
  const { feed, sock, timers } = setup();
  feed.start();
  const by = sock("bybit")[0];
  by.open();
  timers.advance(9000);
  assert.equal(by.closed, false);
  timers.advance(1000);
  assert.ok(by.closed);
  timers.advance(2000);
  assert.equal(sock("bybit").length, 2);
  feed.stop();
  assert.equal(timers.count(), 0);
});

test("I2 via the feed: a disconnect just before the hour end that stays down never saves that hour", async () => {
  const store = memStore();
  const { feed, sock, clock, timers } = setup(H0 - 2 * MIN, store);
  feed.start();
  for (const v of ["bybit", "binance"]) sock(v)[0].open();
  ackSub(sock("bybit")[0]);
  timers.advance(H + 2 * MIN - 8000); // 8 s before the end of hour H0
  sock("binance")[0].drop();
  timers.advance(120_000); // reconnect fires after 2 s; keep the new socket closed so the outage lasts
  await flush();
  const doc = store.docs.get(`${RADAR_COLLECTION}/${RADAR_LIQ_ID}`);
  assert.equal((doc?.hours.binance ?? []).some((x) => x.h === H0), false);
  feed.stop();
});
