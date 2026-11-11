// Store, scheduler, config and resolve-hook unit tests.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireLock, createCandleCache, createLedger, repairTail, safeFileStem, tfDir } from "../src/store.mjs";
import { epochNextClose, nextRegularWake, nextWake } from "../src/schedule.mjs";
import { parseConfig } from "../src/config.mjs";
import { usesDirectFetch } from "../src/engine.mjs";
import { __test as hook } from "../ts-resolve.mjs";
import { tempDir } from "./fixtures.mjs";

const H = 3_600_000;

test("engine loads unmodified through the resolve hook and fetches directly (no proxy)", () => {
  assert.equal(process.env.NEXT_PUBLIC_BUILD_TARGET, "html");
  assert.equal(usesDirectFetch(), true);
  assert.equal(hook.isExtensionlessRelative("./indicators"), true);
  assert.equal(hook.isExtensionlessRelative("../lib/x"), true);
  assert.equal(hook.isExtensionlessRelative("./x.ts"), false);
  assert.equal(hook.isExtensionlessRelative("node:fs"), false);
  assert.equal(hook.isExtensionlessRelative("zod"), false);
  const lib = pathToFileURL(join(import.meta.dirname, "..", "..", "web", "src", "lib", "scan-pipeline.ts")).href;
  assert.match(hook.tryTs("./indicators", lib), /indicators\.ts$/);
  assert.equal(hook.tryTs("./does-not-exist", lib), null);
  assert.equal(hook.tryTs("./indicators", lib.replace(/\.ts$/, ".mjs")), null, "only imports from .ts files are rewritten");
});

test("Windows-safe names: case-safe timeframe folders, reserved device names, untrusted symbols", () => {
  assert.equal(tfDir("1M"), "1mo");
  assert.equal(tfDir("1m"), "1m");
  assert.equal(tfDir("4h"), "4h");
  assert.throws(() => tfDir("../x"));
  assert.equal(safeFileStem("BTCUSDT"), "BTCUSDT");
  assert.equal(safeFileStem("CON"), "_CON");
  assert.equal(safeFileStem("COM1"), "_COM1");
  assert.throws(() => safeFileStem("..\\evil"));
  assert.throws(() => safeFileStem("btc/usdt"));
});

test("repairTail cuts only an unterminated last line", (t) => {
  const dir = tempDir(t);
  const p = join(dir, "a.jsonl");
  writeFileSync(p, '{"a":1}\n{"b":2}\n{"c":');
  assert.equal(repairTail(p), 5);
  assert.equal(readFileSync(p, "utf8"), '{"a":1}\n{"b":2}\n');
  assert.equal(repairTail(p), 0);
  writeFileSync(p, "no newline at all");
  repairTail(p);
  assert.equal(readFileSync(p, "utf8"), "");
});

test("ledger dedupes within a batch and across instances, by bar month", (t) => {
  const dir = tempDir(t);
  const r = (id, t) => ({ id, t, x: 1 });
  const oct = Date.UTC(2026, 9, 31, 20);
  const nov = Date.UTC(2026, 10, 1, 0);
  const a = createLedger(dir);
  assert.deepEqual(a.record([r("a", oct), r("a", oct), r("b", nov)]), { written: 2, duplicates: 1 });
  const b = createLedger(dir);
  assert.deepEqual(b.record([r("a", oct), r("b", nov), r("c", nov)]), { written: 1, duplicates: 2 });
  assert.equal(readFileSync(join(dir, "ledger", "2026-11.jsonl"), "utf8").trim().split("\n").length, 2);
  assert.equal(b.has("c", nov), true);
});

test("candle cache keeps the newest 2,000 bars and the taker-buy field", (t) => {
  const dir = tempDir(t);
  const c = createCandleCache(dir, "binance", "1M");
  const k = Array.from({ length: 2100 }, (_, i) => ({ time: i, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, ...(i % 2 ? { takerBuy: 4 } : {}) }));
  c.save("BTCUSDT", k);
  const back = c.load("BTCUSDT");
  assert.equal(back.length, 2000);
  assert.equal(back[0].time, 100);
  assert.equal(back[1].takerBuy, 4);
  assert.equal(back[0].takerBuy, undefined);
  assert.match(c.dir, /1mo$/);
});

test("single-instance lock: a live owner blocks, a stale lock is taken over", (t) => {
  const dir = tempDir(t);
  const release = acquireLock(dir);
  writeFileSync(join(dir, "recorder.lock"), JSON.stringify({ pid: process.ppid })); // a live process that is not us
  assert.throws(() => acquireLock(dir), /already writing/);
  writeFileSync(join(dir, "recorder.lock"), JSON.stringify({ pid: 2 ** 22 + 12345 })); // no such pid
  const again = acquireLock(dir);
  again();
  release();
});

test("wake-up: just after each bar close, weekly on Monday, monthly on the 1st, backoff and cooldown", () => {
  const now = Date.UTC(2026, 9, 31, 13, 10);
  const newest4h = Date.UTC(2026, 9, 31, 8); // closed 08:00–12:00 bar
  assert.equal(nextRegularWake({ now, tf: "4h", newestBarOpen: newest4h, graceMs: 20_000 }), Date.UTC(2026, 9, 31, 16, 0, 20));
  assert.equal(nextRegularWake({ now, tf: "4h", graceMs: 0 }), Date.UTC(2026, 9, 31, 16));
  assert.equal(epochNextClose("1w", now), Date.UTC(2026, 10, 2), "Monday 2 Nov 2026");
  assert.equal(epochNextClose("1M", now), Date.UTC(2026, 10, 1));
  assert.equal(nextRegularWake({ now, tf: "1M", newestBarOpen: Date.UTC(2026, 8, 1), graceMs: 0 }), Date.UTC(2026, 10, 1));
  assert.equal(nextRegularWake({ now, tf: "4h", intervalSeconds: 90 }), now + 90_000);
  assert.equal(nextWake({ now, tf: "4h", newestBarOpen: newest4h, graceMs: 0, ok: false, consecutiveFailures: 1 }), now + 30_000);
  assert.equal(nextWake({ now, tf: "4h", newestBarOpen: newest4h, graceMs: 0, ok: false, consecutiveFailures: 9 }), now + 15 * 60_000);
  assert.equal(nextWake({ now, tf: "4h", newestBarOpen: newest4h, graceMs: 0, ok: true, consecutiveFailures: 0, cooldownUntil: Date.UTC(2026, 9, 31, 17) }), Date.UTC(2026, 9, 31, 17) + 1000);
  // Woke late (laptop slept past a close): next close in the future, not one in the past.
  assert.ok(nextRegularWake({ now: now + 9 * H, tf: "4h", newestBarOpen: newest4h, graceMs: 0 }) > now + 9 * H);
});

test("config: flags beat env, validation, absolute out dir", () => {
  const c = parseConfig(["--source", "bybit-perp", "--tf=1h", "--once"], { RECORDER_LIMIT: "50", RECORDER_SOURCE: "bitget" }, "/data");
  assert.equal(c.source, "bybit-perp");
  assert.equal(c.tf, "1h");
  assert.equal(c.limit, 50);
  assert.equal(c.once, true);
  assert.equal(c.assetClass, "crypto");
  assert.ok(c.outDir.endsWith("recorder-data"));
  assert.throws(() => parseConfig(["--source", "kraken"], {}), /--source/);
  assert.throws(() => parseConfig(["--tf", "3h"], {}), /--tf/);
  assert.throws(() => parseConfig(["--interval-seconds", "5"], {}), /at least 30/);
  assert.throws(() => parseConfig(["--limit", "500"], {}), /--limit/);
  assert.throws(() => parseConfig(["--token", "x"], {}), /unknown option/);
});

test("recorder loads an exported scoring profile", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "profile.json");
  writeFileSync(file, JSON.stringify({ version: 1, enabled: ["stochastic", "rsi"] }));
  assert.deepEqual(parseConfig(["--profile", file], {}).profile, { version: 1, enabled: ["rsi", "stochastic"] });
  writeFileSync(file, JSON.stringify({ version: 1, enabled: ["rsi", "rsi"] }));
  assert.throws(() => parseConfig(["--profile", file], {}), /duplicate/);
});
