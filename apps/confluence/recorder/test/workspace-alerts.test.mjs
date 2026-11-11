import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { evaluateWorkspaceAlerts } from "../src/workspace-alerts.mjs";

test("workspace crossing is written once across recorder restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "confluence-inbox-"));
  try {
    writeFileSync(join(dir, "workspace-rules.json"), JSON.stringify({ version: 1, rules: [
      { id: "rule-1", source: "binance", timeframe: "4h", symbols: ["BTCUSDT"], threshold: 70 },
    ] }));
    const bar = (t, sc, src = "binance") => ({ row: { src, tf: "4h", pair: "BTCUSDT", t, tc: t + 1, sc, cfg: "fixture" } });
    assert.equal(evaluateWorkspaceAlerts(dir, [bar(1, 60).row], []), 0);
    assert.equal(evaluateWorkspaceAlerts(dir, [], [bar(2, 80, "bybit-perp")]), 0);
    assert.equal(evaluateWorkspaceAlerts(dir, [], [bar(2, 80)]), 1);
    assert.equal(evaluateWorkspaceAlerts(dir, [], [bar(2, 80)]), 0);
    const inbox = JSON.parse(readFileSync(join(dir, "workspace-inbox.json"), "utf8"));
    assert.equal(inbox.events.length, 1);
    assert.equal(inbox.events[0].pair, "BTCUSDT");
    assert.equal(inbox.events[0].barOpen, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rank rise requires consecutive bars and the same ranked universe membership", () => {
  const dir = mkdtempSync(join(tmpdir(), "confluence-rank-"));
  try {
    writeFileSync(join(dir, "workspace-rules.json"), JSON.stringify({ version: 1, rules: [
      { id: "rank", kind: "rank-rise", source: "binance", timeframe: "4h", symbols: ["BTCUSDT"], threshold: 2 },
    ] }));
    const tick = (t, symbols, complete = true) => evaluateWorkspaceAlerts(dir, [], [
      { row: { src: "binance", tf: "4h", pair: "BTCUSDT", t, tc: t + 10, sc: 60, cfg: "fixture" } },
    ], complete ? { bar: t, intervalMs: 10, symbols } : undefined);
    const low = ["ETHUSDT", "SOLUSDT", "BTCUSDT"];
    const high = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
    assert.equal(tick(10, low), 0);
    assert.equal(tick(20, high, false), 0);
    assert.equal(tick(30, high), 0);
    assert.equal(tick(40, low), 0);
    assert.equal(tick(50, ["BTCUSDT", "ETHUSDT", "XRPUSDT"]), 0);
    assert.equal(tick(60, low), 0);
    assert.equal(tick(70, high), 1);
    assert.equal(tick(70, high), 0);
    const [event] = JSON.parse(readFileSync(join(dir, "workspace-inbox.json"), "utf8")).events;
    assert.deepEqual([event.kind, event.previousRank, event.rank], ["rank-rise", 3, 1]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
