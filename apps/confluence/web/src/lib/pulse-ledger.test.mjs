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
  l.mount(pulseKey("a|X", 1, 1)); l.mount(pulseKey("a|Y", 1, -1)); l.mount(pulseKey("a|Z", 1, 1));
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

test("I-3: only keep pulses whose marker is mounted count as running; unmount (scroll/filter/mode change) ends them", () => {
  const l = createPulseLedger();
  const k = pulseKey("a|X", 1, 1);
  l.claim("a|X", 1, 1, true);
  assert.equal(l.runningCount(), 0, "claimed but not mounted: nothing is pulsing on screen");
  l.mount(k);
  assert.equal(l.runningCount(), 1);
  let n = 0; l.subscribe(() => { n++; });
  l.unmount(k);
  assert.equal(l.runningCount(), 0, "row scrolled or filtered away, ribbon off, mode changed: no keep pulse is left");
  assert.equal(l.isActive(k), false);
  assert.ok(n > 0, "subscribers are told, so the Stop button disappears");
  assert.equal(l.claim("a|X", 1, 1, true), false, "an ended pulse is not replayed");
});

test("I-3: a new bar's keep pulse replaces the old bar's keep pulse of the same pair; other pairs are untouched", () => {
  const l = createPulseLedger();
  const old = pulseKey("a|X", 1, 1), other = pulseKey("a|Y", 1, 1);
  l.claim("a|X", 1, 1, true); l.mount(old);
  l.claim("a|Y", 1, 1, true); l.mount(other);
  assert.equal(l.runningCount(), 2);
  l.claim("a|X", 2, 1, true); l.mount(pulseKey("a|X", 2, 1));
  assert.equal(l.isActive(old), false, "the old bar's entry is removed");
  assert.equal(l.isActive(other), true);
  assert.equal(l.runningCount(), 2);
});

test("I-3: a disagreement that ends (the mark unmounts) leaves no Stop button; a three-pulse mark is unaffected by mount counts", () => {
  const l = createPulseLedger();
  const k = pulseKey("a|X", 1, 1), z = pulseKey("a|Z", 1, 1);
  l.claim("a|X", 1, 1, true); l.mount(k);
  l.claim("a|Z", 1, 1, false); l.mount(z);
  assert.equal(l.runningCount(), 1, "three-pulse marks never count");
  l.unmount(z);
  assert.equal(l.isActive(z), false);
  l.unmount(k);
  assert.equal(l.runningCount(), 0);
  // a double mount (React development) needs two unmounts
  l.claim("a|W", 1, 1, true); const w = pulseKey("a|W", 1, 1); l.mount(w); l.mount(w); l.unmount(w);
  assert.equal(l.runningCount(), 1);
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
