// Chart geometry — v2.8 (WP22 Step 5 Task 4): bucketing, forward buckets, Heikin-Ashi, play state.
// Run: node --experimental-strip-types --no-warnings --test src/lib/chart-geometry.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { bucketBars, bucketForward, heikinAshi, projectionSlots, bandsAtSlots, playReducer, playLabel, plotSpan, plotFrac, SC_PLAY_MS } from "./chart-geometry.ts";

function bars(n) {
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const open = p;
    const close = p + Math.sin(i * 1.7) * 2 + (i % 5 === 0 ? 1.5 : -0.4);
    out.push({ time: 1_700_000_000_000 + i * 3_600_000, open, high: Math.max(open, close) + 1 + (i % 3), low: Math.min(open, close) - 1 - (i % 4) * 0.5, close, volume: 10 + i });
    p = close;
  }
  return out;
}

// Verbatim copy of the chart's inline bucketing at BASE a7e94ac (price-chart.tsx).
function oldBucketing(slice, k) {
  const bucketEnds = [];
  for (let e = slice.length - 1; e >= 0; e -= k) bucketEnds.unshift(e);
  const bars2 = k === 1 ? slice : bucketEnds.map((e) => {
    const b = slice.slice(Math.max(0, e - k + 1), e + 1);
    let hi2 = -Infinity, lo2 = Infinity, vol2 = 0;
    for (const c of b) { if (c.high > hi2) hi2 = c.high; if (c.low < lo2) lo2 = c.low; vol2 += c.volume; }
    return { time: b[0].time, open: b[0].open, high: hi2, low: lo2, close: b[b.length - 1].close, volume: vol2 };
  });
  return { bars: bars2, ends: bucketEnds };
}

test("bucketBars equals the chart's old bucketing", () => {
  const slice = bars(101);
  for (const k of [1, 3, 7]) assert.deepEqual(bucketBars(slice, k), oldBucketing(slice, k));
});

test("bucketForward is start-aligned", () => {
  const c = bars(24).map(({ open, high, low, close }) => ({ open, high, low, close }));
  const b = bucketForward(c, 5);
  assert.equal(b.length, 5);
  assert.equal(b[4].open, c[20].open);
  assert.equal(b[4].close, c[23].close);
  assert.equal(b[4].high, Math.max(...c.slice(20).map((x) => x.high)));
  assert.equal(b[0].open, c[0].open);
  assert.equal(b[0].close, c[4].close);
  assert.equal(bucketForward(c, 1).length, 24);
});

test("projectionSlots", () => {
  assert.equal(projectionSlots(24, 1), 24);
  assert.equal(projectionSlots(24, 5), 5);
  assert.equal(projectionSlots(6, 7), 1);
});

test("heikinAshi known values and continuation", () => {
  const b = [
    { open: 10, high: 12, low: 9, close: 11 },
    { open: 11, high: 13, low: 10, close: 12 },
    { open: 12, high: 12.5, low: 8, close: 9 },
  ];
  const ha = heikinAshi(b);
  assert.deepEqual(ha[0], { open: 10.5, high: 12, low: 9, close: 10.5 });
  // bar 2: close (11+13+10+12)/4 = 11.5; open (10.5+10.5)/2 = 10.5; high 13; low 10
  assert.deepEqual(ha[1], { open: 10.5, high: 13, low: 10, close: 11.5 });
  // bar 3: close (12+12.5+8+9)/4 = 10.375; open (10.5+11.5)/2 = 11; high max(12.5,11,10.375); low min(8,..)
  assert.deepEqual(ha[2], { open: 11, high: 12.5, low: 8, close: 10.375 });
  const first = heikinAshi(b.slice(0, 2));
  const rest = heikinAshi(b.slice(2), first[first.length - 1]);
  assert.deepEqual([...first, ...rest], ha);
});

test("heikinAshi high/low envelope", () => {
  const ha = heikinAshi(bars(200));
  for (const c of ha) {
    assert.ok(c.high >= Math.max(c.open, c.close));
    assert.ok(c.low <= Math.min(c.open, c.close));
  }
});

test("bandsAtSlots samples each bucket's last step", () => {
  const bands = Array.from({ length: 24 }, (_, i) => ({ p025: i, p16: i, p50: i, p84: i, p975: i }));
  assert.deepEqual(bandsAtSlots(bands, 5).map((b) => b.p50), [4, 9, 14, 19, 23]);
  assert.deepEqual(bandsAtSlots(bands, 1).map((b) => b.p50), bands.map((b) => b.p50));
  assert.deepEqual(bandsAtSlots(bands.slice(0, 6), 7).map((b) => b.p50), [5]);
});

test("playReducer", () => {
  const h = 24;
  let s = playReducer({ count: 0, playing: false, started: true }, "reset", h, false);
  assert.deepEqual(s, { count: 24, playing: false, started: false });
  s = playReducer(s, "play", h, false);
  assert.deepEqual(s, { count: 0, playing: true, started: true });
  for (let i = 0; i < 24; i++) s = playReducer(s, "tick", h, false);
  assert.deepEqual(s, { count: 24, playing: false, started: true });
  assert.deepEqual(playReducer(s, "tick", h, false), { count: 24, playing: false, started: true });
  // Replay from the end starts again at 0.
  assert.deepEqual(playReducer(s, "play", h, false), { count: 0, playing: true, started: true });
  // Pause mid-way keeps the count; the next play resumes from it.
  let m = playReducer({ count: 24, playing: false, started: false }, "play", h, false);
  for (let i = 0; i < 10; i++) m = playReducer(m, "tick", h, false);
  m = playReducer(m, "pause", h, false);
  assert.deepEqual(m, { count: 10, playing: false, started: true });
  assert.deepEqual(playReducer(m, "play", h, false), { count: 10, playing: true, started: true });
  assert.deepEqual(playReducer({ count: 3, playing: false, started: false }, "play", h, true), { count: 24, playing: false, started: true });
  assert.equal(SC_PLAY_MS, 250);
});

test("playLabel", () => {
  assert.equal(playLabel({ count: 24, playing: false, started: false }, 24), "sc.play");
  assert.equal(playLabel({ count: 5, playing: true, started: true }, 24), "sc.pausePlay");
  assert.equal(playLabel({ count: 10, playing: false, started: true }, 24), "sc.play");
  assert.equal(playLabel({ count: 24, playing: false, started: true }, 24), "sc.replay");
});

test("plotSpan / plotFrac: pointer maths with a projection", () => {
  const chartW = 688, bars = 60, slots = 24;
  const step = chartW / (bars + slots);
  const span = plotSpan(chartW, step, bars, true);
  assert.ok(Math.abs(span - (chartW * 60) / 84) < 1e-9);
  assert.equal(plotSpan(chartW, chartW / bars, bars, false), chartW);
  // Pointer on the newest real candle's right edge anchors at 1 (old chartW maths gave ~0.71).
  assert.ok(Math.abs(plotFrac(bars * step, span) - 1) < 1e-9);
  // Over the simulated area it is clamped to the newest bar.
  assert.equal(plotFrac(chartW - 5, span), 1);
  assert.equal(plotFrac(-4, span), 0);
  // No projection: unchanged.
  assert.equal(plotFrac(344, plotSpan(chartW, chartW / bars, bars, false)), 0.5);
});
