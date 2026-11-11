import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileDepth } from "../src/depth-capture.mjs";

test("snapshot must align with a buffered delta and all following updates must be consecutive", () => {
  const snapshot = { u: 4, seq: 20 };
  assert.equal(reconcileDepth(snapshot, [{ u: 5, seq: 21 }]), null);
  assert.equal(reconcileDepth(snapshot, [{ u: 4, seq: 20 }, { u: 6, seq: 22 }]), null);
  assert.deepEqual(reconcileDepth(snapshot, [{ u: 3, seq: 18 }, { u: 4, seq: 20 }, { u: 5, seq: 23 }]), [{ u: 5, seq: 23 }]);
});

test("a recoverable failure emits a gap and retries within the deadline", async () => {
  const { captureWithReconnect } = await import("../src/depth-capture.mjs");
  const calls = [];
  let time = 0;
  const result = await captureWithReconnect({
    deadline: 20_000,
    now: () => time,
    wait: async (ms) => { time += ms; },
    recordGap: (reason) => calls.push(reason),
    captureSegment: async () => {
      calls.push("connect");
      return time === 0 ? "sequence gap or reset" : "duration limit";
    },
  });
  assert.deepEqual(calls, ["connect", "sequence gap or reset", "connect"]);
  assert.equal(result, "duration limit");
});

test("a full capture stops without reconnecting", async () => {
  const { captureWithReconnect } = await import("../src/depth-capture.mjs");
  const result = await captureWithReconnect({
    deadline: 20_000,
    now: () => 0,
    wait: async () => assert.fail("unexpected retry"),
    recordGap: () => assert.fail("unexpected gap"),
    captureSegment: async () => "capture size limit",
  });
  assert.equal(result, "capture size limit");
});

test("liquidations decode position side and retain distinct events in one exchange batch", async () => {
  const { normalizeLiquidations } = await import("../src/depth-capture.mjs");
  const base = { s: "BTCUSDT", S: "Buy", T: 1000, v: "2", p: "99" };
  const events = normalizeLiquidations("BTCUSDT", { ts: 1200, data: [
    base, base, { ...base, S: "Sell" }, { ...base, s: "ETHUSDT" }, { ...base, p: "0" },
  ] });
  assert.deepEqual(events.map(({ side, price }) => [side, price]), [["long", 99], ["long", 99], ["short", 99]]);
  assert.equal(new Set(events.map(({ id }) => id)).size, 3);
});
