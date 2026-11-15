// Fund trend maths (WP21). Run: npm run test:fundtrend
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fundTrend, fundTrendSeries, isFundTrendClass, fundRank, disagreement, ribbonStyle,
} from "./fund-trend.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);
const approx = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
/** Daily bars at 00:00 UTC from a list of log returns (first close = 100). */
function bars(rets, t0 = T0) {
  let c = 100;
  const out = [{ time: t0, open: c, high: c, low: c, close: c, volume: 1 }];
  rets.forEach((r, i) => {
    c *= Math.exp(r);
    out.push({ time: t0 + (i + 1) * DAY, open: c, high: c, low: c, close: c, volume: 1 });
  });
  return out;
}
const rep = (r, n) => Array.from({ length: n }, () => r);
const endOf = (b) => b[b.length - 1].time + DAY;

test("constant +1 % daily returns saturate", () => {
  const b = bars(rep(0.01, 399)); // 400 bars
  assert.equal(b.length, 400);
  const f = fundTrend(b, endOf(b));
  assert.ok(approx(f.value, 100));
  assert.deepEqual(f.z, [2, 2, 2]);
  assert.ok(approx(f.sigmaAnn, 0.01 * Math.sqrt(365)));
  assert.equal(f.size, 200);
});

test("constant -0.5 % daily returns", () => {
  const b = bars(rep(-0.005, 399));
  const f = fundTrend(b, endOf(b));
  assert.ok(approx(f.value, -100));
  assert.equal(f.size, 200);
});

test("flat prices give 0", () => {
  const b = bars(rep(0, 399));
  const f = fundTrend(b, endOf(b));
  assert.equal(f.value, 0);
  assert.equal(f.size, 200);
});

function altRets(d, a, nBars) {
  return Array.from({ length: nBars - 1 }, (_, i) => (i % 2 === 0 ? d + a : d - a));
}

test("unsaturated case matches a reference", () => {
  const b = bars(altRets(0.0005, 0.03, 420));
  const f = fundTrend(b, endOf(b));
  // Independent reference from the spec formulas.
  const C = b.map((x) => x.close);
  const r = [];
  for (let i = 1; i < C.length; i++) r.push(Math.log(C[i] / C[i - 1])); // r[j] = return into bar j+1
  const delta = 60 / 61;
  let v = r.slice(0, 60).reduce((s, x) => s + x * x, 0) / 60;
  // bar t (0-based) uses returns up to t-1; return into bar t is r[t-1]
  for (let t = 61; t < C.length; t++) v = delta * v + (1 - delta) * r[t - 2] ** 2;
  const sigma = Math.sqrt(v);
  const t = C.length - 1;
  const zs = [30, 91, 365].map((k) => {
    const z = Math.log(C[t] / C[t - k]) / (sigma * Math.sqrt(k));
    return Math.max(-2, Math.min(2, z));
  });
  const ref = 50 * (zs[0] + zs[1] + zs[2]) / 3;
  assert.ok(approx(f.value, ref), `${f.value} vs ${ref}`);
  assert.ok(Math.abs(f.value) < 100);
  assert.ok(approx(f.sigmaAnn, sigma * Math.sqrt(365)));
});

test("size below the cap", () => {
  const b = bars(altRets(0.0005, 0.05, 420));
  const f = fundTrend(b, endOf(b));
  assert.ok(f.sigmaAnn > 0.2);
  assert.ok(approx(f.size, (0.4 / f.sigmaAnn) * 100));
  assert.ok(f.size < 200);
});

test("needs 366 contiguous closed daily bars", () => {
  const b365 = bars(rep(0.01, 364));
  assert.equal(b365.length, 365);
  assert.equal(fundTrend(b365, endOf(b365)), null);
  const b366 = bars(rep(0.01, 365));
  assert.equal(b366.length, 366);
  assert.ok(fundTrend(b366, endOf(b366)));
  const b = bars(rep(0.01, 399));
  b.splice(390, 1); // missing day 10 bars back
  assert.equal(fundTrend(b, endOf(b)), null);
});

test("ignores the open daily bar", () => {
  const b = bars(altRets(0.0005, 0.03, 420));
  const asOf = endOf(b);
  const base = fundTrend(b, asOf);
  const open = { ...b[b.length - 1], time: asOf, close: 1e6 }; // closes at asOf + DAY
  const f = fundTrend([...b, open], asOf);
  assert.deepEqual(f, base);
});

test("intraday bar uses only daily bars closed before its close", () => {
  const b = bars(altRets(0.0005, 0.03, 420));
  const D = b[400].time; // 00:00 UTC of day D
  const bar4h = { time: D + 8 * 3_600_000, closeTime: D + 12 * 3_600_000 };
  const bar1d = { time: D, closeTime: D + DAY };
  const [v4, v1] = fundTrendSeries(b, [bar4h, bar1d]);
  assert.equal(v4, fundTrend(b, D).value);
  assert.equal(v1, fundTrend(b, D + DAY).value);
  assert.notEqual(v4, v1);
});

test("fundTrendSeries memoises per daily bar and returns null without history", () => {
  const b = bars(altRets(0.0005, 0.03, 420));
  const D = b[400].time;
  const hours = Array.from({ length: 6 }, (_, i) => ({ time: D + i * 4 * 3_600_000, closeTime: D + (i + 1) * 4 * 3_600_000 }));
  const out = fundTrendSeries(b, hours);
  assert.equal(new Set(out).size, 2); // 5 bars see D-1 close; the last closes at D+1 00:00
  assert.equal(fundTrendSeries(b, [{ time: T0, closeTime: T0 + 3_600_000 }])[0], null);
});

test("disagreement thresholds", () => {
  assert.equal(disagreement(55, -25), 1);
  assert.equal(disagreement(54, -25), 0);
  assert.equal(disagreement(55, -24), 0);
  assert.equal(disagreement(-60, 30), -1);
  assert.equal(disagreement(80, null), 0);
});

test("ribbonStyle", () => {
  assert.deepEqual(ribbonStyle(null), { colour: "none", alpha: 0 });
  assert.equal(ribbonStyle(10).colour, "grey");
  const up = ribbonStyle(15);
  assert.equal(up.colour, "up");
  assert.ok(approx(up.alpha, 0.3625));
  const dn = ribbonStyle(-100);
  assert.equal(dn.colour, "down");
  assert.ok(approx(dn.alpha, 1));
});

test("fundRank", () => {
  const r = fundRank(new Map([["A", 50], ["B", -10], ["C", 50]]));
  assert.equal(r.get("A"), 1);
  assert.equal(r.get("C"), 1);
  assert.equal(r.get("B"), 3);
});

test("isFundTrendClass", () => {
  assert.equal(isFundTrendClass("crypto"), true);
  for (const c of ["stock", "fx", "commodity"]) assert.equal(isFundTrendClass(c), false);
});
