import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDerivativeSnapshots, summarizeDerivatives } from "./derivatives-context.ts";

test("Bybit snapshots preserve zero, isolate instruments, and compare distinct OI timestamps", () => {
  const base = { venue: "bybit", cat: "linear", pair: "BTCUSDT", fr: 0, fi: 480 };
  const rows = parseDerivativeSnapshots([
    { ...base, t: 1000, oi: 100, oit: 1000 },
    { ...base, t: 2000, oi: 150, oit: 2000 },
    { ...base, t: 3000, oi: 150, oit: 2000 },
    { ...base, pair: "ETHUSDT", t: 4000, oi: 1, oit: 4000 },
    { ...base, cat: "inverse", t: 5000, oi: 1, oit: 5000 },
  ].map((row) => JSON.stringify(row)).join("\n"));
  const view = summarizeDerivatives(rows, "BTCUSDT", 3000);
  assert.equal(view.latest.fr, 0);
  assert.equal(view.openInterest, 150);
  assert.equal(view.changePercent, 50);
  assert.equal(view.stale, false);
  assert.equal(summarizeDerivatives(rows, "BTCUSDT", 9_000_000).stale, true);
  assert.equal(summarizeDerivatives(rows, "SOLUSDT", 3000).latest, undefined);
});
