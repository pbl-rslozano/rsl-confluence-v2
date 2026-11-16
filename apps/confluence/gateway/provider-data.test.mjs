import assert from "node:assert/strict";
import test from "node:test";
import { createEtfFlowCache, createWhaleStream, fetchEtfFlows } from "./provider-data.mjs";

const KEY = "SECRETKEY-abcdef-123456";
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 16, 12, 0, 0); // 16 Nov 2026 12:00 UTC

function okResponse(payload) {
  return { ok: true, status: 200, json: async () => payload, body: { cancel: async () => {} } };
}

function fakeFetcher(byPath) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    const path = new URL(url).pathname;
    const handler = byPath[path];
    if (!handler) throw new Error("network down");
    return typeof handler === "function" ? handler() : okResponse(handler);
  };
  fetcher.calls = calls;
  return fetcher;
}

const BTC = "/api/etf/bitcoin/flow-history";
const ETH = "/api/etf/ethereum/flow-history";

test("etf flows map per-ticker rows and skip missing flow_usd", async () => {
  const day = (n, etfs) => ({ timestamp: Date.UTC(2026, 10, 10 + n), flow_usd: 0, price_usd: 90000, etf_flows: etfs });
  const btc = {
    code: "0",
    data: [
      day(0, [{ etf_ticker: "IBIT", flow_usd: 100 }, { etf_ticker: "FBTC", flow_usd: -40 }]),
      day(1, [{ etf_ticker: "IBIT", flow_usd: 10 }, { etf_ticker: "FBTC" }, { etf_ticker: "ARKB", flow_usd: 5 }]),
      day(2, [{ etf_ticker: "IBIT", flow_usd: 7 }]),
    ],
  };
  const fetcher = fakeFetcher({ [BTC]: btc, [ETH]: { code: "0", data: [] } });
  const live = await fetchEtfFlows(KEY, { fetcher, now: () => T0 });
  assert.equal(live.asOf, T0);
  assert.equal(live.btc.length, 3);
  assert.equal(live.btc[0].date, "2026-11-10");
  assert.equal(live.btc[0].totalUsd, 60);
  assert.deepEqual(live.btc[1].flows, [{ ticker: "IBIT", flowUsd: 10 }, { ticker: "ARKB", flowUsd: 5 }]);
  assert.equal(live.btc[1].totalUsd, 15);
  assert.deepEqual(live.eth, []);
  assert.equal(fetcher.calls.length, 2);
  assert.equal(fetcher.calls[0].options.headers["CG-API-KEY"], KEY);
});

test("etf flows cap hostile payloads", async () => {
  const flows = [];
  for (let i = 0; i < 500; i += 1) flows.push({ etf_ticker: i === 0 ? "<b>" : i === 1 ? "BAD" : `T${i}`, flow_usd: i === 1 ? 1e30 : 1 });
  const data = Array.from({ length: 5000 }, (_, i) => ({ timestamp: Date.UTC(2010, 0, 1) + i * DAY, etf_flows: flows }));
  const fetcher = fakeFetcher({ [BTC]: { code: "0", data }, [ETH]: { code: "0", data: [] } });
  const live = await fetchEtfFlows(KEY, { fetcher, now: () => T0 });
  assert.ok(live.btc.length <= 30);
  assert.equal(live.btc.length, 30);
  assert.equal(live.btc.at(-1).date, new Date(Date.UTC(2010, 0, 1) + 4999 * DAY).toISOString().slice(0, 10));
  for (const d of live.btc) {
    assert.ok(d.flows.length <= 20);
    for (const f of d.flows) {
      assert.match(f.ticker, /^[A-Z0-9]{1,8}$/);
      assert.ok(Math.abs(f.flowUsd) <= 1e11);
    }
    assert.ok(!d.flows.some((f) => f.ticker === "BAD"));
  }
});

test("etf flows return the newest 30 days even when upstream is newest-first", async () => {
  const data = Array.from({ length: 60 }, (_, i) => ({ timestamp: Date.UTC(2026, 8, 1) + i * DAY, etf_flows: [{ etf_ticker: "IBIT", flow_usd: i + 1 }] })).reverse();
  data.push({ timestamp: Date.UTC(2026, 8, 1) + 59 * DAY + 3_600_000, etf_flows: [{ etf_ticker: "IBIT", flow_usd: 999 }] }); // same date, later
  const fetcher = fakeFetcher({ [BTC]: { code: "0", data }, [ETH]: { code: "0", data: [] } });
  const live = await fetchEtfFlows(KEY, { fetcher, now: () => T0 });
  assert.equal(live.btc.length, 30);
  assert.equal(live.btc[0].date, "2026-10-01");
  assert.equal(live.btc.at(-1).date, "2026-10-30");
  assert.equal(live.btc.at(-1).totalUsd, 999); // dedupe keeps the last
  assert.deepEqual(live.btc.map((d) => d.date), [...live.btc.map((d) => d.date)].sort());
});

test("etf flows skip days with no kept flows and out-of-range timestamps", async () => {
  const btc = { code: "0", data: [
    { timestamp: Date.UTC(2026, 10, 10) }, // no etf_flows
    { timestamp: Date.UTC(2026, 10, 11), etf_flows: "nope" },
    { timestamp: Date.UTC(2026, 10, 12), etf_flows: [{ etf_ticker: "IBIT" }, { etf_ticker: "FBTC", flow_usd: null }] },
    { timestamp: Date.UTC(2026, 10, 13), etf_flows: [{ etf_ticker: "<b>", flow_usd: 1 }] },
    { timestamp: Date.UTC(2005, 0, 1), etf_flows: [{ etf_ticker: "IBIT", flow_usd: 1 }] }, // before 2015
    { timestamp: T0 + 3 * DAY, etf_flows: [{ etf_ticker: "IBIT", flow_usd: 1 }] }, // future
    { timestamp: Date.UTC(2026, 10, 14), etf_flows: [{ etf_ticker: "IBIT", flow_usd: 4 }] },
  ] };
  const fetcher = fakeFetcher({ [BTC]: btc, [ETH]: { code: "0", data: [] } });
  const live = await fetchEtfFlows(KEY, { fetcher, now: () => T0 });
  assert.deepEqual(live.btc.map((d) => d.date), ["2026-11-14"]);
});

test("etf flows drop non-finite flows and days with a bad timestamp", async () => {
  const btc = { code: "0", data: [
    { timestamp: "nope", etf_flows: [{ etf_ticker: "IBIT", flow_usd: 1 }] },
    { timestamp: 1e30, etf_flows: [{ etf_ticker: "IBIT", flow_usd: 1 }] },
    { timestamp: Date.UTC(2026, 10, 15), etf_flows: [{ etf_ticker: "IBIT", flow_usd: "5" }, { etf_ticker: "FBTC", flow_usd: null }, { etf_ticker: "ARKB", flow_usd: 2 }] },
  ] };
  const fetcher = fakeFetcher({ [BTC]: btc, [ETH]: { code: "0", data: [] } });
  const live = await fetchEtfFlows(KEY, { fetcher, now: () => T0 });
  assert.equal(live.btc.length, 1);
  assert.deepEqual(live.btc[0].flows, [{ ticker: "ARKB", flowUsd: 2 }]);
});

test("one asset failing still returns the other, and non-OK bodies are released", async () => {
  let cancelled = 0;
  const fetcher = fakeFetcher({
    [BTC]: { code: "0", data: [{ timestamp: Date.UTC(2026, 10, 15), etf_flows: [{ etf_ticker: "IBIT", flow_usd: 3 }] }] },
    [ETH]: () => ({ ok: false, status: 429, json: async () => ({}), body: { cancel: async () => { cancelled += 1; } } }),
  });
  const live = await fetchEtfFlows(KEY, { fetcher, now: () => T0 });
  assert.equal(live.btc.length, 1);
  assert.deepEqual(live.eth, []);
  assert.equal(cancelled, 1);
});

test("both assets failing throws a fixed message without the key", async () => {
  const fetcher = fakeFetcher({ [BTC]: { code: "40001", msg: `bad ${KEY}` }, [ETH]: () => { throw new Error(`boom ${KEY}`); } });
  await assert.rejects(fetchEtfFlows(KEY, { fetcher, now: () => T0 }), (error) => {
    assert.equal(error.message, "ETF flows unavailable.");
    return true;
  });
});

test("etf cache serves for 1 h, then refetches, and drops on delete", async () => {
  let clock = T0;
  let calls = 0;
  const cache = createEtfFlowCache({
    now: () => clock,
    fetchFlows: async () => { calls += 1; return { asOf: clock, btc: [], eth: [] }; },
  });
  await cache.get("p1", KEY);
  clock += 59 * 60_000;
  await cache.get("p1", KEY);
  assert.equal(calls, 1);
  clock += 2 * 60_000;
  await cache.get("p1", KEY);
  assert.equal(calls, 2);
  cache.delete("p1");
  await cache.get("p1", KEY);
  assert.equal(calls, 3);
  cache.clear();
  await cache.get("p1", KEY);
  assert.equal(calls, 4);
});

test("etf cache shares one in-flight fetch and negative-caches a failure for 5 min", async () => {
  let clock = T0;
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const cache = createEtfFlowCache({ now: () => clock, fetchFlows: async () => { calls += 1; await gate; return { asOf: clock, btc: [], eth: [] }; } });
  const both = Promise.all([cache.get("p", KEY), cache.get("p", KEY)]);
  release();
  await both;
  assert.equal(calls, 1);

  let failing = 0;
  const bad = createEtfFlowCache({ now: () => clock, fetchFlows: async () => { failing += 1; throw new Error("ETF flows unavailable."); } });
  await assert.rejects(bad.get("p", KEY));
  clock += 4 * 60_000;
  await assert.rejects(bad.get("p", KEY));
  assert.equal(failing, 1);
  clock += 2 * 60_000;
  await assert.rejects(bad.get("p", KEY));
  assert.equal(failing, 2);
});

// ---- whale stream ----

class FakeTimers {
  constructor() { this.t = 0; this.q = []; this.id = 0; }
  setTimeout(fn, ms) { const id = ++this.id; this.q.push({ id, at: this.t + ms, fn }); return id; }
  clearTimeout(id) { this.q = this.q.filter((x) => x.id !== id); }
  advance(ms) {
    const end = this.t + ms;
    for (;;) {
      const next = this.q.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.q = this.q.filter((x) => x !== next);
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

function harness() {
  const timers = new FakeTimers();
  const sockets = [];
  class FakeWS {
    constructor(url) { this.url = url; this.sent = []; this.closed = false; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.closed = true; }
    open() { this.onopen?.(); }
    message(obj) { this.onmessage?.({ data: typeof obj === "string" ? obj : JSON.stringify(obj) }); }
    drop() { this.onclose?.(); }
  }
  const now = () => T0 + timers.t;
  const stream = createWhaleStream({ apiKey: KEY, WebSocketCtor: FakeWS, now, timers });
  return { timers, sockets, stream, now };
}

const alertAt = (nowMs, over = {}) => ({
  type: "alert",
  timestamp: Math.floor(nowMs / 1000),
  blockchain: "bitcoin",
  transaction_type: "transfer",
  from: "unknown wallet",
  to: "Binance",
  amounts: [{ symbol: "BTC", amount: 100, value_usd: 9_000_000 }],
  text: "ignored",
  transaction: { hash: "abc123DEF" },
  ...over,
});

test("whale stream opens lazily, filters invalid alerts, keeps 24 h and closes after 15 min idle", () => {
  const { timers, sockets, stream, now } = harness();
  assert.equal(sockets.length, 0);
  assert.deepEqual(stream.poll(5_000_000), { connected: false, alerts: [] });
  assert.equal(sockets.length, 1);
  const ws = sockets[0];
  ws.open();
  assert.deepEqual(ws.sent[0], { type: "subscribe_alerts", id: "rsl-radar", min_value_usd: 5_000_000 });
  ws.message({ type: "subscribed_alerts", id: "rsl-radar" });
  assert.equal(stream.poll(5_000_000).connected, true);

  ws.message(alertAt(now()));
  ws.message(alertAt(now(), { type: undefined, amounts: [{ symbol: "ETH", amount: 5, value_usd: 1_000 }, { symbol: "USDT", amount: 20_000_000, value_usd: 20_000_000 }] }));
  ws.message(alertAt(now(), { blockchain: "<script>" }));              // bad chain
  ws.message(alertAt(now(), { amounts: [{ symbol: "BTC", amount: 1, value_usd: 1e13 }] })); // too large
  ws.message(alertAt(now(), { amounts: [{ symbol: "BTC", amount: 0, value_usd: 5 }] }));    // zero amount
  ws.message(alertAt(now(), { amounts: "nope" }));                      // not an alert
  ws.message(alertAt(now(), { from: "a\u0000b\u001fc" + "x".repeat(200), transaction: { hash: "bad hash!" } }));
  ws.message("not json");
  const { alerts } = stream.poll(5_000_000);
  assert.equal(alerts.length, 3);
  const usdt = alerts.find((a) => a.symbol === "USDT");
  assert.equal(usdt.valueUsd, 20_000_000);
  assert.equal(usdt.t, Math.floor(now() / 1000) * 1000);
  const messy = alerts.find((a) => a.from.startsWith("abc"));
  assert.equal(messy.from.length, 80);
  assert.equal(messy.hash, "");
  assert.equal(alerts.find((a) => a.symbol === "BTC" && a.hash === "abc123DEF").chain, "bitcoin");

  // 24 h window: an hour later nothing is dropped, 25 h later everything is.
  timers.advance(14 * 60_000);
  stream.poll(5_000_000); // keeps the stream alive
  timers.advance(14 * 60_000);
  assert.equal(ws.closed, false);
  timers.advance(16 * 60_000); // 15+ min since the last poll
  assert.equal(ws.closed, true);
  assert.equal(sockets.length, 1);
  // next poll reopens lazily
  stream.poll(5_000_000);
  assert.equal(sockets.length, 2);
});

test("whale stream keeps only alerts from the last 24 h and at most 200", () => {
  const { timers, sockets, stream, now } = harness();
  stream.poll(1e6);
  const ws = sockets[0];
  ws.open();
  ws.message({ type: "subscribed_alerts" });
  ws.message(alertAt(now() - 25 * 3_600_000)); // too old on arrival
  for (let i = 0; i < 250; i += 1) ws.message(alertAt(now(), { transaction: { hash: `h${i}` } }));
  const first = stream.poll(1e6).alerts;
  assert.equal(first.length, 200);
  assert.ok(first.some((a) => a.hash === "h249"));
  assert.ok(!first.some((a) => a.hash === "h0"));
  for (let i = 0; i < 140; i += 1) { timers.advance(10 * 60_000); stream.poll(1e6); } // 23 h 20 min, kept alive
  assert.equal(stream.poll(1e6).alerts.length, 200);
  for (let i = 0; i < 8; i += 1) { timers.advance(10 * 60_000); stream.poll(1e6); } // now past 24 h
  assert.deepEqual(stream.poll(1e6).alerts, []);
});

test("whale stream reconnects only when the minimum is lowered, and clamps it", () => {
  const { sockets, stream } = harness();
  stream.poll(10); // clamps to 1e6
  sockets[0].open();
  assert.equal(sockets[0].sent[0].min_value_usd, 1e6);
  stream.poll(1e6); // same value: no reconnect
  stream.poll(9e12); // raise (clamped to 1e10): the filter handles it
  stream.poll(Number.NaN); // back to 1e6: still within the subscription
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].closed, false);
});

test("whale stream: lowering the minimum reconnects once with it", () => {
  const { sockets, stream } = harness();
  stream.poll(5e6);
  sockets[0].open();
  assert.equal(sockets[0].sent[0].min_value_usd, 5e6);
  stream.poll(2e6);
  assert.equal(sockets[0].closed, true);
  assert.equal(sockets.length, 2);
  sockets[1].open();
  assert.equal(sockets[1].sent[0].min_value_usd, 2e6);
  stream.poll(2e6);
  stream.poll(3e6);
  assert.equal(sockets.length, 2);
});

test("whale stream: raising the minimum filters what poll returns without a reconnect", () => {
  const { sockets, stream, now } = harness();
  stream.poll(1e6);
  sockets[0].open();
  sockets[0].message({ type: "subscribed_alerts" });
  sockets[0].message(alertAt(now(), { amounts: [{ symbol: "BTC", amount: 1, value_usd: 2_000_000 }], transaction: { hash: "small" } }));
  sockets[0].message(alertAt(now(), { amounts: [{ symbol: "BTC", amount: 1, value_usd: 8_000_000 }], transaction: { hash: "big" } }));
  assert.equal(stream.poll(1e6).alerts.length, 2);
  const raised = stream.poll(5e6);
  assert.deepEqual(raised.alerts.map((a) => a.hash), ["big"]);
  assert.equal(sockets.length, 1);
  assert.equal(raised.connected, true);
});

test("whale stream rejects far-future alerts and returns newest first by time", () => {
  const { sockets, stream, now } = harness();
  stream.poll(1e6);
  sockets[0].open();
  sockets[0].message({ type: "subscribed_alerts" });
  sockets[0].message(alertAt(now() - 60_000, { transaction: { hash: "older" } }));
  sockets[0].message(alertAt(now() - 5_000, { transaction: { hash: "newer" } }));
  sockets[0].message(alertAt(now() - 120_000, { transaction: { hash: "oldest" } }));
  sockets[0].message(alertAt(now() + 10 * 60_000, { transaction: { hash: "future" } }));
  assert.deepEqual(stream.poll(1e6).alerts.map((a) => a.hash), ["newer", "older", "oldest"]);
});

test("whale stream reconnects when no subscription confirmation arrives in 15 s", () => {
  const { timers, sockets, stream } = harness();
  stream.poll(1e6);
  sockets[0].open();
  timers.advance(14_999);
  assert.equal(sockets[0].closed, false);
  timers.advance(1);
  assert.equal(sockets[0].closed, true);
  timers.advance(5_000);
  assert.equal(sockets.length, 2);
  sockets[1].open();
  sockets[1].message({ type: "subscribed_alerts" });
  timers.advance(60_000);
  assert.equal(sockets[1].closed, false); // confirmed: the timeout is cleared
});

test("whale stream reconnects on a non-auth error before subscription, not after", () => {
  const { timers, sockets, stream } = harness();
  stream.poll(1e6);
  sockets[0].open();
  sockets[0].message({ error: "something odd" });
  assert.equal(sockets[0].closed, true);
  timers.advance(5_000);
  assert.equal(sockets.length, 2);
  sockets[1].open();
  sockets[1].message({ type: "subscribed_alerts" });
  sockets[1].message({ error: "alert rate limit exceeded" });
  assert.equal(sockets[1].closed, false);
});

test("whale stream reconnects with backoff 5 s to 5 min and resets after a subscription", () => {
  const { timers, sockets, stream } = harness();
  stream.poll(1e6);
  sockets[0].drop();
  assert.equal(stream.poll(1e6).connected, false);
  timers.advance(4_999);
  assert.equal(sockets.length, 1);
  timers.advance(1);
  assert.equal(sockets.length, 2);
  sockets[1].drop();
  timers.advance(9_999);
  assert.equal(sockets.length, 2);
  timers.advance(1);
  assert.equal(sockets.length, 3);
  for (const delay of [20_000, 40_000, 80_000, 160_000, 300_000, 300_000]) {
    const before = sockets.length;
    sockets.at(-1).drop();
    stream.poll(1e6);
    timers.advance(delay - 1);
    assert.equal(sockets.length, before);
    timers.advance(1);
    assert.equal(sockets.length, before + 1);
  }
  const n = sockets.length;
  sockets.at(-1).drop();
  stream.poll(1e6);
  timers.advance(299_999);
  assert.equal(sockets.length, n);
  timers.advance(1);
  assert.equal(sockets.length, n + 1);
  sockets.at(-1).open();
  sockets.at(-1).message({ type: "subscribed_alerts" });
  sockets.at(-1).drop();
  timers.advance(5_000);
  assert.equal(sockets.length, n + 2);
});

test("whale stream stops on an authentication error until the next poll", () => {
  const { timers, sockets, stream } = harness();
  stream.poll(1e6);
  sockets[0].open();
  sockets[0].message({ error: `not authenticated (${KEY})` });
  assert.equal(sockets[0].closed, true);
  sockets[0].drop();
  timers.advance(10 * 60_000);
  assert.equal(sockets.length, 1);
  assert.equal(stream.poll(1e6).connected, false);
  assert.equal(sockets.length, 2);
});

test("whale stream treats a rate-limit error as non-fatal and never surfaces it", () => {
  const { sockets, stream } = harness();
  stream.poll(1e6);
  sockets[0].open();
  sockets[0].message({ type: "subscribed_alerts" });
  sockets[0].message({ error: "alert rate limit exceeded" });
  assert.equal(sockets[0].closed, false);
  assert.ok(!JSON.stringify(stream.poll(1e6)).includes("rate limit"));
});

test("whale stream never exposes the key", () => {
  const { sockets, stream, now } = harness();
  assert.ok(sockets.length === 0);
  const out = [JSON.stringify(stream.poll(1e7))];
  sockets[0].open();
  sockets[0].message({ error: `oops ${KEY}` });
  sockets[0].message(alertAt(now(), { text: `leak ${KEY}`, from: "w" }));
  out.push(JSON.stringify(stream.poll(1e7)));
  assert.ok(!out.join("").includes(KEY));
  assert.ok(!out.join("").includes(encodeURIComponent(KEY)));
  // a constructor that throws with the URL in its message must not escape
  const throwing = createWhaleStream({
    apiKey: KEY,
    WebSocketCtor: class { constructor(url) { throw new Error(`cannot open ${url}`); } },
    now: () => T0,
    timers: new FakeTimers(),
  });
  assert.doesNotThrow(() => throwing.poll(1e6));
  assert.ok(!JSON.stringify(throwing.poll(1e6)).includes(KEY));
});

test("close tears the stream down and cancels timers", () => {
  const { timers, sockets, stream } = harness();
  stream.poll(1e6);
  sockets[0].open();
  stream.close();
  assert.equal(sockets[0].closed, true);
  sockets[0].drop();
  timers.advance(60 * 60_000);
  assert.equal(sockets.length, 1);
});
