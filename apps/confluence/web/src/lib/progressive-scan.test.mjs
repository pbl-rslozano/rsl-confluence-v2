// Progressive scan scheduler — v2.8 (WP27 smooth loading). Pure: no network, no IndexedDB.
// Run: node --experimental-strip-types --no-warnings --test src/lib/progressive-scan.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  priorityOrder, runTiers, createBatcher, liveOnly, recordable, initialRows, ProgressiveRows,
  rememberTickers, rememberedTickers, newBarDue, PRIORITY_TOP, PRIORITY_CHUNK,
} from "./progressive-scan.ts";

const syms = (n, p = "S") => Array.from({ length: n }, (_, i) => `${p}${String(i).padStart(3, "0")}USDT`);
class RateLimitError extends Error { constructor(m) { super(m); this.name = "RateLimitError"; } }
const noSleep = async () => {};

test("priorityOrder: watchlist first, else top10 then chunks of 20", () => {
  const all = syms(55);
  // byVolume differs from list order: the reversed list is the volume ranking.
  const byVolume = [...all].reverse();
  const tiers = priorityOrder(all, null, byVolume);
  assert.equal(PRIORITY_TOP, 10);
  assert.equal(PRIORITY_CHUNK, 20);
  assert.deepEqual(tiers.map((t) => t.length), [10, 20, 20, 5]);
  assert.deepEqual(tiers[0], byVolume.slice(0, 10));
  assert.deepEqual(tiers[1], byVolume.slice(10, 30));
  assert.deepEqual(tiers.flat().sort(), [...all].sort(), "every symbol exactly once");

  const watch = [all[40], all[3], "NOTSCANNEDUSDT"];
  const w = priorityOrder(all, watch, byVolume);
  assert.deepEqual(w[0], [all[40], all[3]], "watch tier = watched symbols present in the list, in watch order");
  assert.deepEqual(w.slice(1).map((t) => t.length), [20, 20, 13]);
  assert.ok(!w.slice(1).flat().includes(all[40]) && !w.slice(1).flat().includes(all[3]));
  assert.deepEqual(w.flat().sort(), [...all].sort());

  assert.deepEqual(priorityOrder(all.slice(0, 4), [], all.slice(0, 4)), [all.slice(0, 4)], "empty watch list → top tier");
  assert.deepEqual(priorityOrder([], null, []), []);
  // A symbol missing from byVolume is still scheduled (after the ranked ones).
  assert.deepEqual(priorityOrder(["A", "B"], null, ["B"]).flat(), ["B", "A"]);
});

test("runTiers emits results in tier order and reports progress", async () => {
  const tiers = priorityOrder(syms(35), null, syms(35));
  const seen = [];
  const progress = [];
  const r = await runTiers(tiers, async (s) => s.toLowerCase(), {
    concurrency: 6, sleep: noSleep,
    onResult: (s, v) => seen.push([s, v]), onError: () => assert.fail("no error expected"),
    onBatch: (done, total) => progress.push([done, total]),
  });
  assert.equal(r.halted, false);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(seen.map(([s]) => s), tiers.flat());
  assert.equal(seen[0][1], seen[0][0].toLowerCase());
  assert.deepEqual(progress.at(-1), [35, 35]);
  assert.ok(progress.every(([d], i) => i === 0 || d > progress[i - 1][0]), "progress only grows");
});

test("switching source cancels and never mixes rows", async () => {
  const ac = new AbortController();
  const tiers = priorityOrder(syms(30, "OLD"), null, syms(30, "OLD"));
  const emitted = [];
  let calls = 0;
  const run = runTiers(tiers, async (s) => { calls++; return s; }, {
    concurrency: 6, signal: ac.signal, sleep: noSleep,
    onResult: (s) => { emitted.push(s); if (emitted.length === 3) ac.abort(); },
    onError: () => {},
  });
  await assert.rejects(run, (e) => e.name === "AbortError");
  // Results of the batch in flight when the user switched are dropped after the abort.
  assert.equal(emitted.length, 3, "no further onSeries for the old key after abort");
  assert.equal(calls, 6, "queued work (later batches and tiers) is never started");

  // The new view starts empty: none of the old source's rows survive.
  const oldRows = new ProgressiveRows("binance|4h", emitted.map((pair) => ({ pair, freshness: "live" })));
  const start = initialRows({ key: oldRows.key, rows: oldRows.rows() }, "bybit-spot|4h");
  assert.deepEqual(start, []);
  const fresh = new ProgressiveRows("bybit-spot|4h", start);
  fresh.put({ pair: "BTCUSDT", freshness: "updating" });
  assert.deepEqual(fresh.rows().map((r) => r.pair), ["BTCUSDT"]);
  // A rescan of the same view keeps its rows until they are refreshed in place.
  assert.equal(initialRows({ key: "binance|4h", rows: oldRows.rows() }, "binance|4h").length, 3);
});

test("cached rows are display-only", () => {
  const rows = new ProgressiveRows("binance|4h");
  const strong = { master: "BULLISH", strength: "STRONG", score: 90, suppressed: false };
  rows.put({ pair: "BTCUSDT", freshness: "updating", confluence: strong });
  rows.put({ pair: "ETHUSDT", freshness: "stale", confluence: strong });
  rows.put({ pair: "SOLUSDT", freshness: "live", confluence: strong });
  // A late history row never replaces a row already refreshed by a fresh fetch.
  assert.equal(rows.put({ pair: "SOLUSDT", freshness: "updating", confluence: strong }), false);
  assert.equal(rows.get("SOLUSDT").freshness, "live");

  const all = rows.rows();
  // Ledger: the recorder callback is never even called for a display-only row.
  const asked = [];
  const ledger = recordable(all, (r) => { asked.push(r.pair); return { pair: r.pair }; });
  assert.deepEqual(ledger.map((r) => r.pair), ["SOLUSDT"]);
  assert.deepEqual(asked, ["SOLUSDT"]);
  // Paper proposals (STRONG rows of the heartbeat) see live rows only.
  const proposals = liveOnly(all).filter((r) => r.confluence.strength === "STRONG");
  assert.deepEqual(proposals.map((r) => r.pair), ["SOLUSDT"]);
  assert.deepEqual(liveOnly([{ pair: "X", freshness: "updating" }]), []);
});

test("429 halts all tiers", async () => {
  const all = syms(40);
  const tiers = priorityOrder(all, null, all);
  const requested = [];
  const errors = [];
  let cooldownUntil = 0;
  const r = await runTiers(tiers, async (s) => {
    requested.push(s);
    if (s === all[12]) { cooldownUntil = Date.now() + 60_000; throw new RateLimitError("rate limited (429)"); }
    return s;
  }, { concurrency: 6, sleep: noSleep, onResult: () => {}, onError: (s, e) => errors.push([s, e.name]) });
  assert.equal(r.halted, true);
  assert.ok(cooldownUntil > Date.now(), "cooldown set by the fetcher");
  const tier3plus = tiers.slice(2).flat();
  assert.ok(tier3plus.every((s) => !requested.includes(s)), "no tier-3+ request after the 429");
  assert.ok(!requested.includes(all[16]), "nothing after the halted batch");
  assert.deepEqual(errors, [[all[12], "RateLimitError"]]);
  assert.deepEqual(r.skipped, all.slice(16));
});

test("runTiers paces between batches, not after the last", async () => {
  const waits = [];
  await runTiers([["A", "B", "C"], ["D"]], async (s) => s, {
    concurrency: 2, pauseMs: 120, sleep: async (ms) => { waits.push(ms); }, onResult: () => {}, onError: () => {},
  });
  assert.deepEqual(waits, [120, 120]);
});

test("batched UI updates at most every 250 ms", () => {
  let t = 1_000;
  const timers = [];
  const fake = {
    now: () => t,
    setTimeout: (fn, ms) => { const id = timers.length; timers.push({ fn, at: t + ms, live: true }); return id; },
    clearTimeout: (id) => { if (timers[id]) timers[id].live = false; },
  };
  const advance = (ms) => { t += ms; for (const x of timers) if (x.live && x.at <= t) { x.live = false; x.fn(); } };
  const flushes = [];
  const b = createBatcher(() => flushes.push(t), 250, fake);
  b.schedule(); b.schedule(); b.schedule();
  advance(0);
  assert.deepEqual(flushes, [1_000], "first update shows at once");
  b.schedule(); advance(100); b.schedule(); advance(100);
  assert.deepEqual(flushes, [1_000]);
  advance(50);
  assert.deepEqual(flushes, [1_000, 1_250], "next update ≥ 250 ms later, coalesced");
  b.schedule(); b.flushNow();
  assert.deepEqual(flushes, [1_000, 1_250, 1_250]);
  advance(500);
  assert.equal(flushes.length, 3, "flushNow clears the pending timer");
  b.cancel(); b.schedule(); advance(1_000);
  assert.equal(flushes.length, 3, "a cancelled batcher never flushes again");
  for (let i = 1; i < flushes.length - 1; i++) assert.ok(flushes[i] - flushes[i - 1] >= 250);
});

test("remembered ticker list for instant start", () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
  const list = [{ rank: 1, symbol: "BTCUSDT", lastPrice: "101", priceChangePercent: "1.0", quoteVolume: "9000" }];
  rememberTickers("binance|crypto|USDT", list, storage);
  assert.deepEqual(rememberedTickers("binance|crypto|USDT", storage), list);
  assert.deepEqual(rememberedTickers("bybit-spot|crypto|USDT", storage), []);
  mem.set("ct-scan-list-v1:x", "{not json");
  assert.deepEqual(rememberedTickers("x", storage), []);
  const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.doesNotThrow(() => rememberTickers("k", list, throwing));
  assert.deepEqual(rememberedTickers("k", throwing), []);
  // Hostile stored entries are dropped.
  mem.set("ct-scan-list-v1:h", JSON.stringify([{ symbol: "<img>", rank: 1 }, list[0]]));
  assert.deepEqual(rememberedTickers("h", storage).map((t) => t.symbol), ["BTCUSDT"]);
});

test("other-timeframe cache refetches only when a new bar has closed", () => {
  const H = 3_600_000;
  const open = 10 * H; // newest cached bar opened at 10:00, closed 11:00
  assert.equal(newBarDue(undefined, H, 11 * H), true);
  assert.equal(newBarDue(open, H, 11.5 * H), false, "bar 11:00 still open");
  assert.equal(newBarDue(open, H, 12 * H), true, "bar 11:00 closed at 12:00");
});
