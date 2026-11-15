// Disagreement pulse ledger and Fund rank helper (v2.8 WP21, Task 6). Run: npm run test:pulse
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPulseLedger, pulseKey } from "./pulse-ledger.ts";
import { fundRanks } from "./fund-trend.ts";

test("a (pair, bar, direction) pulses once; a new bar or a changed direction pulses again", () => {
  const l = createPulseLedger();
  assert.equal(l.claim("binance|BTCUSDT", 1000, 1), true);
  assert.equal(l.claim("binance|BTCUSDT", 1000, 1), false);
  assert.equal(l.claim("binance|BTCUSDT", 2000, 1), true, "new bar");
  assert.equal(l.claim("binance|BTCUSDT", 2000, -1), true, "changed direction");
  assert.equal(l.claim("okx|BTCUSDT", 1000, 1), true, "the source is part of the key");
});

test("keep pulses run until stopped; stopPair and stopAll end them and notify", () => {
  const l = createPulseLedger();
  let n = 0;
  l.subscribe(() => { n++; });
  l.claim("a|X", 1, 1, true);
  l.claim("a|Y", 1, -1, true);
  l.claim("a|Z", 1, 1, false);
  assert.equal(l.isActive(pulseKey("a|X", 1, 1)), true);
  assert.equal(l.isActive(pulseKey("a|Z", 1, 1)), true);
  l.finish(pulseKey("a|Z", 1, 1));
  assert.equal(l.isActive(pulseKey("a|Z", 1, 1)), false, "a three-pulse mark ends when its animation ends");
  l.finish(pulseKey("a|X", 1, 1));
  assert.equal(l.isActive(pulseKey("a|X", 1, 1)), true, "a keep pulse does not end by itself");
  assert.equal(l.runningCount(), 2);
  l.stopPair("a|X");
  assert.equal(l.isActive(pulseKey("a|X", 1, 1)), false);
  assert.equal(l.runningCount(), 1);
  const before = n;
  l.stopAll();
  assert.equal(l.runningCount(), 0);
  assert.ok(n > before);
  assert.equal(l.claim("a|X", 1, 1, true), false, "a stopped pulse is not replayed");
});

test("the record is bounded", () => {
  const l = createPulseLedger(10);
  for (let i = 0; i < 25; i++) l.claim("a|X", i, 1);
  assert.ok(l.size() <= 10);
  assert.equal(l.claim("a|X", 24, 1), false, "the newest are kept");
});

test("fundRanks ranks crypto rows of one source, others have no rank", () => {
  const st = new Map([
    ["b|A", { value: 80 }], ["b|B", { value: 20 }], ["b|C", { na: "history" }], ["o|A", { value: -90 }], ["b|S", { value: 99 }],
  ]);
  const rows = [
    { src: "b", pair: "A", assetClass: "crypto" }, { src: "b", pair: "B", assetClass: "crypto" }, { src: "b", pair: "C", assetClass: "crypto" },
    { src: "o", pair: "A", assetClass: "crypto" }, { src: "b", pair: "S", assetClass: "stock" },
  ];
  const r = fundRanks(rows, st, "b");
  assert.equal(r.n, 2);
  assert.equal(r.ranks.get("A"), 1);
  assert.equal(r.ranks.get("B"), 2);
  assert.equal(r.ranks.has("C"), false);
  assert.equal(r.ranks.has("S"), false);
});
