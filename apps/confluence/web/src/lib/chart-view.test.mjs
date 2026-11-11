// Chart view window — v2.7 (plan WP14, acceptance CH-1, CH-3).
// Run: node --experimental-strip-types --no-warnings --test src/lib/chart-view.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { MIN_BARS, clampView, initialView, zoomView, panView, wheelZoomFactor, pinchZoomFactor, clampHover } from "./chart-view.ts";

test("initial view shows the newest depth bars, or all when fewer", () => {
  assert.deepEqual(initialView(1000, 60), { end: 1000, count: 60 });
  assert.deepEqual(initialView(40, 60), { end: 40, count: 40 });
  assert.deepEqual(initialView(10, 60), { end: 10, count: 10 });
  assert.deepEqual(initialView(0, 60), { end: 0, count: 0 });
});

test("clamp keeps the window inside the series with at least MIN_BARS", () => {
  assert.deepEqual(clampView({ end: 5000, count: 5 }, 300), { end: 300, count: MIN_BARS });
  assert.deepEqual(clampView({ end: 3, count: 100 }, 300), { end: 100, count: 100 });
  assert.deepEqual(clampView({ end: NaN, count: NaN }, 300), { end: 300, count: 300 });
});

test("CH-3 zoom in at the right edge keeps the newest bar", () => {
  const v = zoomView({ end: 1000, count: 200 }, 1000, 2, 1);
  assert.deepEqual(v, { end: 1000, count: 100 });
});

test("CH-3 zoom is anchored: the bar under the cursor stays put", () => {
  const before = { end: 800, count: 200 }; // bars 600..800
  const anchor = 0.25; // bar 650
  const after = zoomView(before, 1000, 2, anchor); // 100 bars
  const barBefore = before.end - before.count + anchor * before.count;
  const barAfter = after.end - after.count + anchor * after.count;
  assert.equal(after.count, 100);
  assert.ok(Math.abs(barBefore - barAfter) <= 1, `${barBefore} vs ${barAfter}`);
});

test("CH-3 zoom out never exceeds the series and zoom in never below MIN_BARS", () => {
  assert.deepEqual(zoomView({ end: 1000, count: 900 }, 1000, 0.25, 0.5), { end: 1000, count: 1000 });
  assert.equal(zoomView({ end: 1000, count: 30 }, 1000, 10, 0.5).count, MIN_BARS);
  assert.deepEqual(zoomView({ end: 1000, count: 100 }, 1000, NaN, 0.5), { end: 1000, count: 100 });
});

test("pan moves the window and stops at both ends", () => {
  assert.deepEqual(panView({ end: 1000, count: 100 }, 1000, -50), { end: 950, count: 100 });
  assert.deepEqual(panView({ end: 150, count: 100 }, 1000, -500), { end: 100, count: 100 });
  assert.deepEqual(panView({ end: 950, count: 100 }, 1000, 500), { end: 1000, count: 100 });
});

test("wheel and pinch factors: spread/scroll-up zooms in, bounded", () => {
  assert.ok(wheelZoomFactor(-100) > 1);
  assert.ok(wheelZoomFactor(100) < 1);
  assert.equal(wheelZoomFactor(-10_000), wheelZoomFactor(-200));
  assert.ok(wheelZoomFactor(-3, 1) > 1); // line mode
  assert.equal(pinchZoomFactor(100, 200), 2);
  assert.equal(pinchZoomFactor(0, 200), 1);
});

test("CH-1 hover index is clamped when the window shrinks", () => {
  assert.equal(clampHover(900, 60), 59);
  assert.equal(clampHover(-3, 60), 0);
  assert.equal(clampHover(null, 60), null);
  assert.equal(clampHover(5, 0), null);
});
