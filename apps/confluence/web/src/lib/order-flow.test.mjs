import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizePublicTrades } from "./order-flow.ts";

test("public trades are symbol-specific, validated, unique and sorted newest first", () => {
  const trade = { execId: "1", symbol: "BTCUSDT", price: "100", size: "0.2", side: "Buy", time: "1000" };
  const rows = [trade, trade, { ...trade, execId: "2", time: "2000", side: "Sell" },
    { ...trade, execId: "3", symbol: "ETHUSDT" }, { ...trade, execId: "4", size: "-1" }];
  assert.deepEqual(normalizePublicTrades(rows, "BTCUSDT").map(({ id, side }) => [id, side]), [["2", "Sell"], ["1", "Buy"]]);
});

test("full-depth replay invalidates gaps and waits for a replacement snapshot", async () => {
  const { reconstructDepth } = await import("./depth-replay.ts");
  const base = { pair: "BTCUSDT", bids: [["99", "2"]], asks: [["101", "3"]] };
  const rows = [
    { ...base, type: "snapshot", at: 10, u: 20, seq: 100 },
    { ...base, type: "delta", at: 11, u: 21, seq: 105, bids: [["99", "0"], ["98", "4"]], asks: [] },
    { ...base, type: "delta", at: 12, u: 21, seq: 105 },
    { ...base, type: "delta", at: 13, u: 23, seq: 108 },
    { ...base, type: "delta", at: 14, u: 24, seq: 110 },
    { ...base, type: "snapshot", at: 15, u: 25, seq: 112 },
    { ...base, type: "delta", at: 16, u: 1, seq: 113 },
  ];
  const frames = reconstructDepth(rows, "BTCUSDT");
  assert.deepEqual(frames.map((frame) => frame.at), [10, 11, 13, 15, 16]);
  assert.deepEqual(frames[1].bids, [[98, 4]]);
  assert.equal(frames[2].gap, true);
  assert.deepEqual(frames[3].asks, [[101, 3]]);
  assert.equal(frames[4].gap, true);
});

test("a deep venue snapshot can exceed ten thousand levels per side", async () => {
  const { reconstructDepth } = await import("./depth-replay.ts");
  const frames = reconstructDepth([{ type: "snapshot", at: 1, pair: "BTCUSDT", u: 1, seq: 1,
    bids: Array.from({ length: 11000 }, (_, i) => [11000 - i, 1]),
    asks: Array.from({ length: 11000 }, (_, i) => [11001 + i, 1]),
  }], "BTCUSDT");
  assert.equal(frames[0].gap, false);
  assert.deepEqual(frames[0].bids[0], [11000, 1]);
  assert.deepEqual(frames[0].asks[0], [11001, 1]);
});

test("heatmap uses shared price buckets and leaves gaps empty", async () => {
  const { buildDepthHeatmap } = await import("./depth-heatmap.ts");
  const heatmap = buildDepthHeatmap([
    { bids: [[99, 2], [99, 3]], asks: [[101, 1]] },
    null,
    { bids: [[99, 4]], asks: [[102, 2]] },
  ]);
  assert.equal(heatmap.columns[1], null);
  assert.equal(heatmap.columns[0].find((cell) => cell.side === "bid").size, 5);
  assert.equal(heatmap.columns[0].find((cell) => cell.side === "bid").row,
    heatmap.columns[2].find((cell) => cell.side === "bid").row);
  assert.equal(heatmap.maximum, 5);
});

test("an explicit disconnect gap rejects deltas until a replacement snapshot", async () => {
  const { reconstructDepth } = await import("./depth-replay.ts");
  const snapshot = { type: "snapshot", at: 10, pair: "BTCUSDT", u: 20, seq: 100,
    bids: [[99, 1]], asks: [[101, 1]] };
  const frames = reconstructDepth([snapshot, { pair: "BTCUSDT", at: 10, type: "gap" },
    { ...snapshot, at: 11, type: "delta", u: 21, seq: 101 },
    { ...snapshot, at: 12, u: 22, seq: 102 }], "BTCUSDT");
  assert.deepEqual(frames.map(({ gap }) => gap), [false, true, false]);
});
