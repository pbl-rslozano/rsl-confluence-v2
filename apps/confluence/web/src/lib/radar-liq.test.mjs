// Liquidation core — v2.8 Step 4b (WP25, Task 1). Pure: parsing, hour coverage, cascade rule.
// Run: npm run test:radar-liq   (node scripts/run-engine-tests.mjs radar-liq.test.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBybitLiq, parseBinanceLiq, HourBook, normalizeLiqDoc, liquidationCascade,
  LIQ_HOUR_MS, LIQ_BASELINE_HOURS, LIQ_MAX_GAP_MS, LIQ_KEEP_HOURS, LIQ_KEEP_MS,
} from "./radar/liquidations.ts";
import { DEFAULT_THRESHOLDS, sanitizeThresholds, ALERT_CODE } from "./radar/alerts.ts";

const H = LIQ_HOUR_MS;
const NOW = Date.UTC(2026, 10, 16, 12, 30, 0);
const MIN = 60_000;

test("constants", () => {
  assert.equal(LIQ_BASELINE_HOURS, 720);
  assert.equal(LIQ_MAX_GAP_MS, 10_000);
  assert.equal(LIQ_KEEP_HOURS, 1000);
  assert.equal(LIQ_KEEP_MS, 180 * 86_400_000);
});

test("bybit Buy is a long liquidation valued v×p", () => {
  const ev = parseBybitLiq({ topic: "allLiquidation.BTCUSDT", data: [{ T: NOW, s: "BTCUSDT", S: "Buy", v: "2", p: "50000" }] }, NOW);
  assert.deepEqual(ev, [{ venue: "bybit", symbol: "BTCUSDT", side: "long", usd: 100000, t: NOW }]);
  const sell = parseBybitLiq({ topic: "allLiquidation.ETHUSDT", data: [{ T: NOW, s: "ETHUSDT", S: "Sell", v: "1", p: "2000" }] }, NOW);
  assert.equal(sell[0].side, "short");
});

test("binance SELL is a long liquidation valued z×ap", () => {
  const ev = parseBinanceLiq({ e: "forceOrder", o: { s: "ETHUSDT", S: "SELL", q: "3", p: "1000", ap: "1010", z: "3", T: NOW } }, NOW);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].venue, "binance");
  assert.equal(ev[0].side, "long");
  assert.equal(ev[0].usd, 3030);
  const buy = parseBinanceLiq({ o: { s: "BTCUSDT", S: "BUY", q: "1", p: "100", ap: "0", z: "0", T: NOW } }, NOW);
  assert.equal(buy[0].side, "short");
  assert.equal(buy[0].usd, 100); // falls back to q×p
});

test("parsers drop junk without throwing", () => {
  const good = { T: NOW, s: "BTCUSDT", S: "Buy", v: "2", p: "50000" };
  const bybit = (d) => parseBybitLiq({ topic: "allLiquidation.BTCUSDT", data: [d] }, NOW);
  assert.deepEqual(parseBybitLiq(null, NOW), []);
  assert.deepEqual(parseBybitLiq("x", NOW), []);
  assert.deepEqual(bybit({ ...good, v: "NaN" }), []);
  assert.deepEqual(bybit({ ...good, s: "SOLUSDT" }), []);
  assert.deepEqual(bybit({ ...good, v: "400000", p: "50000" }), []); // 2e10
  assert.deepEqual(bybit({ ...good, T: NOW - 3 * H }), []);
  assert.deepEqual(bybit({ ...good, T: NOW + 61_000 }), []);
  const bin = (o) => parseBinanceLiq({ o }, NOW);
  const g = { s: "BTCUSDT", S: "SELL", q: "1", p: "100", ap: "100", z: "1", T: NOW };
  assert.deepEqual(parseBinanceLiq(null, NOW), []);
  assert.deepEqual(parseBinanceLiq("x", NOW), []);
  assert.deepEqual(bin({ ...g, z: "0", q: "NaN" }), []);
  assert.deepEqual(bin({ ...g, s: "SOLUSDT" }), []);
  assert.deepEqual(bin({ ...g, z: "2e8", ap: "100" }), []);
  assert.deepEqual(bin({ ...g, T: NOW - 3 * H }), []);
});

test("an hour with a 2-minute gap is not complete", () => {
  const h = Math.floor(NOW / H) * H;
  const b = new HourBook("bybit");
  b.connected(h - MIN);
  b.disconnected(h + 10 * MIN);
  b.connected(h + 12 * MIN);
  b.add({ venue: "bybit", symbol: "BTCUSDT", side: "long", usd: 5, t: h + 30 * MIN });
  assert.deepEqual(b.roll(h + H + 1), []);
  assert.equal(b.hours().length, 0);
});

test("an hour with a 5 s gap is complete and summed", () => {
  const h = Math.floor(NOW / H) * H;
  const b = new HourBook("bybit");
  b.connected(h - MIN);
  b.disconnected(h + 10 * MIN);
  b.connected(h + 10 * MIN + 5000);
  b.add({ venue: "bybit", symbol: "BTCUSDT", side: "long", usd: 5, t: h + 30 * MIN });
  b.add({ venue: "bybit", symbol: "ETHUSDT", side: "short", usd: 7, t: h + 40 * MIN });
  b.add({ venue: "bybit", symbol: "ETHUSDT", side: "long", usd: 1, t: h + 50 * MIN });
  const r = b.roll(h + H + 1);
  assert.deepEqual(r.filter((x) => x.h === h), [{ h, long: 6, short: 7 }]);
  assert.deepEqual(b.roll(h + H + 2), []); // each hour reported once
  assert.deepEqual(b.hours().filter((x) => x.h === h), [{ h, long: 6, short: 7 }]);
});

test("a disconnection still open at the hour end counts, and connected-before-start is required", () => {
  const h = Math.floor(NOW / H) * H;
  const b = new HourBook("binance");
  b.connected(h - MIN);
  b.disconnected(h + H - 20_000); // 20 s before the hour end, never reconnected
  assert.equal(b.roll(h + H + 1).some((x) => x.h === h), false);
  const c = new HourBook("binance"); // first connected inside the hour: hour is not covered
  c.connected(h + 5 * MIN);
  assert.equal(c.roll(h + H + 1).some((x) => x.h === h), false);
});

test("last60 reports partial coverage", () => {
  const b = new HourBook("bybit");
  b.connected(NOW - 20 * MIN);
  b.add({ venue: "bybit", symbol: "BTCUSDT", side: "short", usd: 9, t: NOW - 5 * MIN });
  b.add({ venue: "bybit", symbol: "BTCUSDT", side: "long", usd: 4, t: NOW - 90 * MIN });
  const l = b.last60(NOW);
  assert.ok(Math.abs(l.coveredMs - 20 * MIN) < 1000);
  assert.equal(l.complete, false);
  assert.equal(l.short, 9);
  assert.equal(l.long, 0);
  const full = new HourBook("bybit");
  full.connected(NOW - 2 * H);
  assert.equal(full.last60(NOW).complete, true);
  assert.equal(full.last60(NOW).coveredMs, H);
});

const hoursOf = (n, usd) => Array.from({ length: n }, (_, i) => ({ h: NOW - (n - i) * H - (NOW % H), long: usd / 2, short: usd / 2 }));
const l60 = (total, complete = true) => ({ long: total * 0.75, short: total * 0.25, coveredMs: H, complete });

test("cascade is collecting below 720 hours", () => {
  assert.deepEqual(liquidationCascade("bybit", hoursOf(719, 1e6), l60(9e6), DEFAULT_THRESHOLDS, NOW), { status: "collecting", have: 719 });
});

test("cascade fires at 3× the median", () => {
  const hrs = hoursOf(720, 1e6);
  const r = liquidationCascade("bybit", hrs, l60(3e6), DEFAULT_THRESHOLDS, NOW);
  assert.equal(r.status, "ready");
  assert.equal(r.medianUsd, 1e6);
  assert.equal(r.alert.code, "LIQ_CASCADE_BYBIT");
  assert.ok(ALERT_CODE.test(r.alert.code));
  assert.equal(r.alert.kind, "liquidation");
  assert.equal(r.alert.trigger.key, "radar.alert.liq");
  assert.deepEqual(r.alert.trigger.vars, { venue: "Bybit", usd: 3e6, mult: 3, median: 1e6, longPct: 75 });
  assert.equal(r.alert.since, NOW - H);
  assert.ok(r.alert.sourceUrl.startsWith("https://"));
  assert.equal(liquidationCascade("bybit", hrs, l60(2.9e6), DEFAULT_THRESHOLDS, NOW).alert, null);
  assert.equal(liquidationCascade("bybit", hrs, l60(3e6, false), DEFAULT_THRESHOLDS, NOW).alert, null);
  assert.equal(liquidationCascade("binance", hrs, l60(3e6), DEFAULT_THRESHOLDS, NOW).alert.code, "LIQ_CASCADE_BINANCE");
  assert.equal(liquidationCascade("bybit", hoursOf(720, 0), l60(1e6), DEFAULT_THRESHOLDS, NOW).alert, null); // median 0
});

test("cascade baseline uses the newest 720 hours only", () => {
  const old = hoursOf(100, 1e9).map((x) => ({ ...x, h: x.h - 720 * H }));
  const r = liquidationCascade("bybit", [...old, ...hoursOf(720, 1e6)], l60(1e6), DEFAULT_THRESHOLDS, NOW);
  assert.equal(r.medianUsd, 1e6);
});

test("normalizeLiqDoc drops bad hours", () => {
  const top = Math.floor(NOW / H) * H;
  const doc = {
    bybit: [
      { h: top - 2 * H, long: 1, short: 2 },
      { h: top - 3 * H + 5, long: 1, short: 1 }, // not on the hour
      { h: top - 4 * H, long: -1, short: 1 }, // negative
      { h: top - 5 * H, long: 1, short: 1e12 }, // out of range
      { h: top - 6 * H, long: NaN, short: 1 },
      { h: top - 2 * H, long: 9, short: 9 }, // duplicate
      { h: top - 181 * 86_400_000, long: 1, short: 1 }, // older than 180 days
      { h: top - 7 * H, long: 3, short: 4 },
      null,
      "x",
    ],
    binance: "nope",
  };
  const out = normalizeLiqDoc(doc, NOW);
  assert.deepEqual(out.bybit, [{ h: top - 7 * H, long: 3, short: 4 }, { h: top - 2 * H, long: 1, short: 2 }]);
  assert.deepEqual(out.binance, []);
  assert.deepEqual(normalizeLiqDoc(null, NOW), { bybit: [], binance: [] });
});

test("normalizeLiqDoc trims to the newest LIQ_KEEP_HOURS", () => {
  const top = Math.floor(NOW / H) * H;
  const many = Array.from({ length: 1200 }, (_, i) => ({ h: top - (i + 1) * H, long: 1, short: 1 }));
  const out = normalizeLiqDoc({ bybit: many }, NOW);
  assert.equal(out.bybit.length, LIQ_KEEP_HOURS);
  assert.equal(out.bybit[out.bybit.length - 1].h, top - H);
});

test("sanitizeThresholds keeps old objects working", () => {
  const a = sanitizeThresholds({ breakAwayPct: 2 });
  assert.equal(a.liqMult, 3);
  assert.equal(a.whaleMinUsd, 1e7);
  assert.equal(a.breakAwayPct, 2);
  assert.equal(sanitizeThresholds({ liqMult: 1 }).liqMult, 3);
  assert.equal(sanitizeThresholds({ liqMult: 20 }).liqMult, 20);
  assert.equal(sanitizeThresholds({ whaleMinUsd: 5e6 }).whaleMinUsd, 5e6);
  assert.equal(sanitizeThresholds({ whaleMinUsd: 5e5 }).whaleMinUsd, 1e7);
  assert.equal(sanitizeThresholds({ whaleMinUsd: 2_000_000.5 }).whaleMinUsd, 1e7);
  assert.equal(DEFAULT_THRESHOLDS.liqMult, 3);
  assert.equal(DEFAULT_THRESHOLDS.whaleMinUsd, 1e7);
});

test("a 15 s outage straddling an hour boundary makes BOTH hours incomplete", () => {
  const h = Math.floor(NOW / H) * H;
  const b = new HourBook("bybit");
  b.connected(h - 2 * H);
  b.disconnected(h + H - 5000); // 5 s before the boundary
  b.connected(h + H + 10_000); // 10 s after: 15 s in all, 5 s + 10 s clipped
  const r = b.roll(h + 2 * H + 1);
  assert.equal(r.some((x) => x.h === h), false, "hour h");
  assert.equal(r.some((x) => x.h === h + H), false, "hour h+1");
  assert.equal(r.some((x) => x.h === h - H), true, "the hour before is unaffected");
});

test("an outage straddling the edge of the last-60 window makes it incomplete; clipped length is still what is missing", () => {
  const b = new HourBook("bybit");
  b.connected(NOW - 3 * H);
  b.disconnected(NOW - H - 5000); // 15 s outage, 5 s of it inside the window
  b.connected(NOW - H + 10_000);
  const l = b.last60(NOW);
  assert.equal(l.complete, false);
  assert.equal(l.coveredMs, H - 10_000);
});

test("roll waits for the grace period: late events inside the grace still count", () => {
  const h = Math.floor(NOW / H) * H;
  const b = new HourBook("bybit");
  b.connected(h - MIN);
  b.add({ venue: "bybit", symbol: "BTCUSDT", side: "long", usd: 5, t: h + 59 * MIN });
  assert.deepEqual(b.roll(h + H + 4000, 5000), []); // 4 s after the hour end: not closable yet
  b.add({ venue: "bybit", symbol: "BTCUSDT", side: "short", usd: 3, t: h + H - 500 }); // delivered late
  assert.deepEqual(b.roll(h + H + 5000, 5000).filter((x) => x.h === h), [{ h, long: 5, short: 3 }]);
  assert.deepEqual(b.roll(h + H + 6000, 5000), []);
});

test("add prunes the recent list from the head (amortised) and the rolling window is unchanged", () => {
  const b = new HourBook("bybit");
  b.connected(NOW - 10 * H);
  for (let i = 0; i < 5000; i++) b.add({ venue: "bybit", symbol: "BTCUSDT", side: "long", usd: 1, t: NOW - 5 * H + i * 3000 });
  b.add({ venue: "bybit", symbol: "BTCUSDT", side: "short", usd: 2, t: NOW });
  assert.ok(b.recentSize() <= 2 * H / 3000 + 2, `kept ${b.recentSize()}`);
  const l = b.last60(NOW);
  assert.equal(l.short, 2);
});
