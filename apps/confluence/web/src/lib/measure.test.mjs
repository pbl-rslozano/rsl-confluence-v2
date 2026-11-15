// Measurement-layer regression suite — v2.1.1.
// Run: npm run test:measure   (node scripts/run-engine-tests.mjs measure.test.mjs)
//
// Pins: engine identity, live == replay scoring, outcome rules (no look-ahead,
// costs, gaps), statistics, the ledger store, asset classification, market
// sessions and rate-limit handling.
import { engineConfigId, ENGINE_BARS, behaviourFingerprint, hash64, stableStringify } from "./engine-config.ts";
import { scoreSeries, toLedgerRow, hasUsableVolume } from "./scan-pipeline.ts";
import { measureOutcome, buildReport, spearman, normCdf, normInv, sharpeStats, DEFAULT_COSTS, thinNonOverlapping } from "./ledger-metrics.ts";
import { createLedgerStore, retentionFor } from "./signal-ledger.ts";
import { classifySymbol, inClass, underlyingOpenAt, barWhileClosed, newYorkOffsetHours } from "./asset-classes.ts";
import { contiguousTail, fetchDirectMarketData, rateLimitCooldown, resetRateLimitForTests, RateLimitError } from "./market-client.ts";
import { packKlines, unpackKlines, runScanJob } from "./scan-jobs.ts";

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log("  ok   - " + name); }
  else { failed++; console.log("  FAIL - " + name + (extra ? "  [" + extra + "]" : "")); }
};
const H = 3600e3;
let seed = 99;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
function walk(n, t0 = Date.UTC(2025, 0, 1), step = 4 * H) {
  const out = []; let px = 100;
  for (let i = 0; i < n; i++) {
    const o = px; px *= Math.exp((rnd() - 0.5) * 0.03);
    out.push({ time: t0 + i * step, open: o, high: Math.max(o, px) * 1.003, low: Math.min(o, px) * 0.997, close: px, volume: 500 + rnd() * 500 });
  }
  return out;
}

console.log("Engine identity");
{
  const id = engineConfigId();
  ok("configId is 16 hex chars", /^[0-9a-f]{16}$/.test(id), id);
  ok("configId is stable across calls", engineConfigId() === id);
  ok("behaviour fingerprint is deterministic", behaviourFingerprint() === behaviourFingerprint());
  // Pinned: changing any indicator, band, weight or the window changes this.
  // Update the pin ONLY together with ENGINE_VERSION when the engine is changed on purpose.
  ok("configId pinned for engine 2.4.0", id === "5c30b5c39f5ba3f2", id);
  ok("stableStringify sorts keys", stableStringify({ b: 1, a: [2, { d: 1, c: 0 }] }) === '{"a":[2,{"c":0,"d":1}],"b":1}');
  ok("hash64 differs for different input", hash64("a") !== hash64("b"));
}

console.log("Fixed engine window / live == replay");
{
  const k = walk(1600);
  const full = scoreSeries(k, { intervalMs: 4 * H, volumeAvailable: true });
  const tail = scoreSeries(k.slice(-ENGINE_BARS), { intervalMs: 4 * H, volumeAvailable: true });
  ok("engine sees exactly ENGINE_BARS bars", full.warmBars === ENGINE_BARS, String(full.warmBars));
  ok("score depends only on the last ENGINE_BARS bars", JSON.stringify(full.confluence) === JSON.stringify(tail.confluence));
  // Live: stored history (old part) merged with a fresh 200-bar fetch.
  const stored = k.slice(0, 1450);
  const fresh = k.slice(1400);
  const byTime = new Map([...stored, ...fresh].map((b) => [b.time, b]));
  const live = contiguousTail([...byTime.values()].sort((a, b) => a.time - b.time), 4 * H);
  const liveScore = scoreSeries(live, { intervalMs: 4 * H, volumeAvailable: true });
  const replayWindow = k.slice(k.length - ENGINE_BARS);
  const replayScore = scoreSeries(replayWindow, { intervalMs: 4 * H, volumeAvailable: true });
  ok("live merge and replay window give identical scores", JSON.stringify(liveScore) === JSON.stringify(replayScore));
  const job = runScanJob({ key: "t", packed: packKlines(k), intervalMs: 4 * H, volumeAvailable: true });
  ok("worker job (packed transfer) equals direct scoring", JSON.stringify(job.score.confluence) === JSON.stringify(full.confluence));
  ok("pack/unpack round-trips", JSON.stringify(unpackKlines(packKlines(k.slice(0, 50)))) === JSON.stringify(k.slice(0, 50)));
  ok("short series is not scored", scoreSeries(k.slice(0, 50), { intervalMs: 4 * H, volumeAvailable: true }).usable === false);
  const zeroVol = k.map((b) => ({ ...b, volume: 0 }));
  ok("zero-volume series detected", hasUsableVolume(zeroVol) === false && hasUsableVolume(k) === true);
  const zv = scoreSeries(zeroVol, { intervalMs: 4 * H, volumeAvailable: true });
  ok("volume indicators excluded on zero-volume series", zv.confluence.indicators.filter((i) => i.category === "Volume").every((i) => !i.valid));
}

console.log("Ledger rows and outcomes (no look-ahead)");
{
  const t0 = Date.UTC(2025, 5, 1);
  const k = Array.from({ length: 40 }, (_, i) => ({ time: t0 + i * H, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1 }));
  const s = scoreSeries(walk(300), { intervalMs: H, volumeAvailable: true });
  const row = toLedgerRow(k.slice(0, 11), s, { src: "binance", tf: "1h", pair: "XUSDT", ac: "crypto", intervalMs: H, closeTime: k[10].time + H, rank: 3, quoteVolume: 1e6, appVersion: "test", live: true });
  ok("row id = config|source|tf|pair|bar", row.id === `${engineConfigId()}|binance|1h|XUSDT|${k[10].time}`);
  ok("row keeps universe rank and warm-up", row.rk === 3 && row.wb === 300);
  const longRow = { ...row, m: 1 };
  const zero = { feeBps: 0, slipBps: 0, fundingBpsPer8h: 0 };
  const o3 = measureOutcome(longRow, k, 3, zero, H);
  // entry = open of bar 11 (111), exit = close of bar 13 (113.5)
  ok("entry at next bar open, exit at close of t+h", Math.abs(o3.gross - (113.5 / 111 - 1)) < 1e-12, String(o3.gross));
  ok("MFE uses highs after entry", Math.abs(o3.mfe - (114 / 111 - 1)) < 1e-12);
  const costed = measureOutcome(longRow, k, 3, { feeBps: 10, slipBps: 5, fundingBpsPer8h: 0 }, H);
  ok("round-trip cost = 2 × (fee + slippage)", Math.abs(o3.net - costed.net - 0.003) < 1e-12);
  const shortRow = { ...row, m: -1 };
  const os = measureOutcome(shortRow, k, 3, zero, H);
  ok("short net is the negative of gross", Math.abs(os.net + os.gross) < 1e-12);
  const perp = measureOutcome(longRow, k, 8, { feeBps: 0, slipBps: 0, fundingBpsPer8h: 1 }, H);
  ok("perp funding charged to longs for 8 h", Math.abs((perp.gross - perp.net) - 0.0001) < 1e-12);
  ok("no outcome before the horizon closes", measureOutcome({ ...row, t: k[38].time }, k, 3, zero, H) === null);
  const gap = k.filter((_, i) => i !== 12);
  ok("no outcome across a hole in the data", measureOutcome(longRow, gap, 3, zero, H) === null);
}

console.log("Statistics");
{
  ok("spearman of a monotonic pair is 1", Math.abs(spearman([1, 2, 3, 4, 5], [2, 4, 8, 16, 32]) - 1) < 1e-12);
  ok("spearman handles ties", Number.isFinite(spearman([1, 1, 2, 3, 3], [5, 4, 3, 2, 1])));
  ok("normInv inverts normCdf", Math.abs(normInv(normCdf(1.2345)) - 1.2345) < 1e-4);
  const good = Array.from({ length: 400 }, (_, i) => 0.002 + ((i % 7) - 3) * 0.001);
  const s1 = sharpeStats(good, 1);
  const s50 = sharpeStats(good, 50);
  ok("PSR high for a consistently positive series", s1.psr > 0.95, String(s1.psr));
  ok("deflated Sharpe ≤ PSR when many configurations were tried", s50.dsr <= s1.psr && s50.sr0 > 0);
  // Report: BUY rows that are always right beat the base rate.
  const t0 = Date.UTC(2025, 0, 1);
  const rows = []; const outs = [];
  for (let i = 0; i < 60; i++) {
    const m = i % 3 === 0 ? 1 : 0;
    const r = { id: String(i), cfg: "x", ev: "1", app: "t", src: "binance", tf: "1h", pair: `P${i % 6}USDT`, ac: "crypto", t: t0 + Math.floor(i / 6) * H, tc: 0, rec: 0, c: 1, sc: m ? 60 : 0, m, st: m ? 1 : 0, sup: 0, lv: 0, v: 18, bu: 0, be: 0, er: 0.2, bl: [0, 0, 0, 0], rk: 0, qv: 0, rd: 0, rc: 0, wb: 1000, live: 1 };
    rows.push(r);
    outs.push({ row: r, horizon: 1, gross: m ? 0.01 : -0.002, net: m ? 0.007 : -0.002, mfe: 0, mae: 0, fundingLong: 0 });
  }
  const rep = buildReport(rows, new Map([[1, outs]]), 30, 1, H);
  const buy = rep.horizons[0].groups.find((g) => g.label === "BUY · all");
  ok("report counts directional rows", buy.n === 20 && rep.directional === 20);
  ok("hit rate 100 % for always-right signals", buy.hitRate === 1);
  ok("edge over base is positive", buy.edgeBps > 0, String(buy.edgeBps));
  ok("rank IC positive when score predicts return", rep.horizons[0].ic.mean > 0.5, String(rep.horizons[0].ic.mean));
  ok("default perp costs include funding", DEFAULT_COSTS["bybit-perp"].fundingBpsPer8h > 0 && DEFAULT_COSTS.binance.fundingBpsPer8h === 0);
}

console.log("Overlap-robust statistics (v2.2 review fix)");
{
  // Pure noise, always long, h = 24 on 1 h bars: the PSR gate must pass ≈ 5 % of
  // the time, not ≈ 50 % as with overlapping outcomes treated as independent.
  const zero = { feeBps: 0, slipBps: 0, fundingBpsPer8h: 0 };
  let passes = 0;
  const windows = 120;
  for (let w = 0; w < windows; w++) {
    const rows = [];
    const outs = [];
    for (let p = 0; p < 5; p++) {
      const k = [];
      let px = 100;
      for (let i = 0; i < 600; i++) {
        const o = px; px *= 1 + (rnd() - 0.5) * 0.02;
        k.push({ time: Date.UTC(2026, 0, 1) + i * H, open: o, high: Math.max(o, px), low: Math.min(o, px), close: px, volume: 1 });
      }
      for (let i = 0; i < 575; i++) {
        const r = { id: `${w}-${p}-${i}`, cfg: "x", ev: "1", app: "t", src: "binance", tf: "1h", pair: `P${p}USDT`, ac: "crypto", t: k[i].time, tc: 0, rec: 0, c: k[i].close, sc: 60, m: 1, st: 1, sup: 0, lv: 0, v: 18, bu: 0, be: 0, er: 0, bl: [0, 0, 0, 0], rk: 0, qv: 0, rd: 0, rc: 0, wb: 1000, live: 1 };
        rows.push(r);
        const o = measureOutcome(r, k, 24, zero, H);
        if (o) outs.push(o);
      }
    }
    const rep = buildReport(rows, new Map([[24, outs]]), 0, 1, H);
    if (rep.horizons[0].sharpe.psr >= 0.95) passes++;
  }
  ok(`noise passes the PSR gate rarely (${passes}/${windows})`, passes / windows <= 0.15, String(passes));
  const thinned = thinNonOverlapping([1, 2, 3, 30, 31, 60].map((i) => ({ row: { src: "b", tf: "1h", pair: "X", t: i * H }, net: 0 })), 24, H);
  ok("thinning keeps only non-overlapping holding windows", thinned.map((o) => o.row.t / H).join(",") === "1,30,60");
  const many = Array.from({ length: 130_000 }, (_, i) => ({ id: String(i), cfg: "x", pair: "A", t: i * H, sup: 0, m: 0 }));
  let threw = false;
  try { buildReport(many, new Map(), 0, 1, H); } catch { threw = true; }
  ok("report over 130k rows does not throw (no Math.min spread)", !threw);
  const t0 = Date.UTC(2025, 5, 1);
  const k = Array.from({ length: 40 }, (_, i) => ({ time: t0 + i * H, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
  const gap24 = k.filter((_, i) => i !== 20);
  ok("h = 24 is not measured across one missing bar", measureOutcome({ t: k[2].time, m: 1 }, gap24, 24, zero, H) === null);
  const perpBase = buildReport([], new Map([[8, [
    { row: { src: "b", tf: "1h", pair: "A", t: 0, m: 0, sup: 0, sc: 0 }, gross: 0, net: 0, mfe: 0, mae: 0, fundingLong: 0.001 },
    { row: { src: "b", tf: "1h", pair: "A", t: 8 * H, m: 1, sup: 0, sc: 60, st: 1 }, gross: 0, net: -0.001, mfe: 0, mae: 0, fundingLong: 0.001 },
  ]]]), 0, 1, H).horizons[0].groups[0];
  ok("perp base rate includes funding (a funded long equals its base: edge 0)", Math.abs(perpBase.edgeBps) < 1e-9, String(perpBase.edgeBps));
}

console.log("Ledger store");
{
  const mem = new Map();
  const col = (c) => { if (!mem.has(c)) mem.set(c, new Map()); return mem.get(c); };
  const port = {
    kind: "indexeddb",
    async get(c, id) { const v = col(c).get(id); return v ? JSON.parse(JSON.stringify(v)) : null; },
    async put(c, id, doc) { col(c).set(id, JSON.parse(JSON.stringify(doc))); },
    async del(c, id) { col(c).delete(id); },
    async list(c) { return [...col(c)].map(([id, doc]) => ({ id, doc })); },
  };
  const store = createLedgerStore(port);
  const base = { cfg: "c1", ev: "1", app: "t", src: "binance", tf: "4h", ac: "crypto", tc: 0, rec: 0, c: 1, sc: 0, m: 0, st: 0, sup: 0, lv: 0, v: 18, bu: 0, be: 0, er: null, bl: [0, 0, 0, 0], rk: 1, qv: 1, rd: 0, rc: 0, wb: 1000, live: 1 };
  const now = Date.now();
  const mk = (pair, t) => ({ ...base, pair, t, id: `c1|binance|4h|${pair}|${t}` });
  const added = await store.record([mk("AUSDT", now), mk("BUSDT", now)]);
  const again = await store.record([mk("AUSDT", now), mk("BUSDT", now)]);
  ok("record writes new rows once", added === 2 && again === 0);
  const store2 = createLedgerStore(port); // new session: in-memory dedupe empty
  ok("rows are idempotent across sessions", (await store2.record([mk("AUSDT", now)])) === 0);
  ok("one document per bar (all pairs of that bar together)", col("ledger").size === 1 && col("ledger").values().next().value.rows.length === 2);
  await store2.record([mk("AUSDT", now + 3_600_000)]);
  ok("a new bar writes a new small document (no day bucket rewrite)", col("ledger").size === 2);
  const old = now - 500 * 86_400_000;
  await store2.record([mk("CUSDT", old)]);
  ok("rows older than the retention window are pruned", !(await store2.all()).some((r) => r.pair === "CUSDT"));
  const stats = await store2.stats();
  ok("stats count rows from the index", stats.rows === 3 && stats.retentionDays === 400, JSON.stringify(stats));
  ok("fragile storage keeps less history", retentionFor("localstorage") < retentionFor("indexeddb"));
  // clear() is queued behind pending writes, so a write issued first cannot resurrect rows.
  const pending = store2.record([mk("DUSDT", now)]);
  await store2.clear();
  await pending;
  ok("clear empties the ledger (queued after pending writes)", (await store2.all()).length === 0 && (await store2.stats()).rows === 0);
  // Quota: a localStorage-like port that throws when more than N documents exist.
  const qmem = new Map();
  const qcol = (c) => { if (!qmem.has(c)) qmem.set(c, new Map()); return qmem.get(c); };
  const qport = {
    kind: "localstorage",
    async get(c, id) { const v = qcol(c).get(id); return v ? JSON.parse(JSON.stringify(v)) : null; },
    async put(c, id, doc) {
      if (c === "ledger" && !qcol(c).has(id) && qcol(c).size >= 6) { const e = new Error("The quota has been exceeded."); e.name = "QuotaExceededError"; throw e; }
      qcol(c).set(id, JSON.parse(JSON.stringify(doc)));
    },
    async del(c, id) { qcol(c).delete(id); },
    async list(c) { return [...qcol(c)].map(([id, doc]) => ({ id, doc })); },
  };
  const qs = createLedgerStore(qport);
  for (let d = 9; d >= 0; d--) await qs.record([mk("QUSDT", now - d * 86_400_000)]);
  const qst = await qs.stats();
  ok("storage-full: oldest days are dropped and recording continues", qst.newestDay === new Date(now).toISOString().slice(0, 10) && !qst.full, JSON.stringify(qst));
}

console.log("Asset classes");
{
  const cases = [
    ["binance", "BTCUSDT", undefined, "crypto"],
    ["binance", "JUPUSDT", undefined, "crypto"],
    ["binance", "MAXUSDT", undefined, "crypto"],
    ["binance", "BNBUSDT", undefined, "crypto"],
    ["binance", "BTCUPUSDT", undefined, "excluded"],
    ["bybit-perp", "BTC3LUSDT", undefined, "excluded"],
    ["binance", "USDCUSDT", undefined, "excluded"],
    ["binance", "EURUSDT", undefined, "fx"],
    ["binance", "PAXGUSDT", undefined, "commodity"],
    ["binance", "TSLABUSDT", undefined, "stock"],
    ["bybit-spot", "AAPLXUSDT", undefined, "stock"],
    ["bitget", "NVDAONUSDT", undefined, "stock"],
    ["bitget", "ONDOUSDT", undefined, "rwa"],
    ["bitget", "SYRUPUSDT", undefined, "rwa"],
    ["bybit-perp", "EURUSDUSDT", undefined, "fx"],
    ["bybit-perp", "XAUUSDT", "commodity", "commodity"],
    ["bybit-perp", "TSLAUSDT", "stock", "stock"],
    ["bybit-perp", "SPYUSDT", "etf", "stock"],
    ["bybit-perp", "USDJPYUSDT", "forex", "fx"],
    ["bybit-perp", "COINUSDT", undefined, "stock"],
    ["bybit-perp", "COINUSDT", "", "crypto"],
    ["bybit-spot", "TSLAXUSDT", "xstocks", "stock"],
  ];
  for (const [src, sym, vt, want] of cases) ok(`${src} ${sym}${vt !== undefined ? ` (${vt || "''"})` : ""} → ${want}`, classifySymbol(src, sym, vt) === want, String(classifySymbol(src, sym, vt)));
  ok("crypto filter drops venue-typed stock perps (leak fix)", !inClass("bybit-perp", "TSLAUSDT", "crypto", "stock"));
  ok("'all' includes every non-excluded class", inClass("binance", "PAXGUSDT", "all") && !inClass("binance", "USDCUSDT", "all"));
}

console.log("Underlying sessions (US DST; holidays not modelled)");
{
  ok("New York is UTC−4 in July", newYorkOffsetHours(Date.UTC(2026, 6, 1, 12)) === -4);
  ok("New York is UTC−5 after 1 Nov 2026", newYorkOffsetHours(Date.UTC(2026, 10, 2, 12)) === -5);
  ok("stocks open Mon 2 Nov 2026 15:00 UTC (10:00 NY)", underlyingOpenAt("stock", Date.UTC(2026, 10, 2, 15)));
  ok("stocks closed Mon 2 Nov 2026 14:00 UTC (09:00 NY)", !underlyingOpenAt("stock", Date.UTC(2026, 10, 2, 14)));
  ok("stocks open Wed 1 Jul 2026 13:45 UTC (09:45 EDT)", underlyingOpenAt("stock", Date.UTC(2026, 6, 1, 13, 45)));
  ok("stocks closed on Saturday", !underlyingOpenAt("stock", Date.UTC(2026, 9, 31, 15)));
  ok("FX closed Saturday", !underlyingOpenAt("fx", Date.UTC(2026, 9, 31, 12)));
  ok("FX open Sunday 22:30 UTC in winter (17:30 NY)", underlyingOpenAt("fx", Date.UTC(2026, 10, 8, 22, 30)));
  ok("FX closed Friday 22:30 UTC in winter (17:30 NY)", !underlyingOpenAt("fx", Date.UTC(2026, 10, 6, 22, 30)));
  ok("crypto never closes", underlyingOpenAt("crypto", Date.UTC(2026, 9, 31, 3)));
  ok("gold/energy closed on Saturday and in the 17:00–18:00 ET break", !underlyingOpenAt("commodity", Date.UTC(2026, 9, 31, 12)) && !underlyingOpenAt("commodity", Date.UTC(2026, 10, 3, 22, 30)) && underlyingOpenAt("commodity", Date.UTC(2026, 10, 3, 23, 30)));
  ok("a Saturday 4h stock bar is flagged closed", barWhileClosed("stock", Date.UTC(2026, 9, 31, 12), 4 * H));
  ok("a Monday 4h stock bar spanning the open is not", !barWhileClosed("stock", Date.UTC(2026, 10, 2, 12), 4 * H));
}

console.log("Rate limits");
{
  const realFetch = globalThis.fetch;
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const now = Date.now();
  const kl = Array.from({ length: 220 }, (_, i) => [now - (221 - i) * H, "1", "1.1", "0.9", "1.05", "10", now - (220 - i) * H - 1]);
  let klineCalls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("ticker/24hr")) return json(Array.from({ length: 30 }, (_, i) => ({ symbol: `T${i}XYZUSDT`, openPrice: "1", lastPrice: "1", quoteVolume: String(1000 - i) })));
    klineCalls++;
    if (klineCalls === 8) return json({ code: -1003, msg: "Too many requests" }, 429, { "retry-after": "30" });
    return json(kl);
  };
  resetRateLimitForTests();
  const res = await fetchDirectMarketData("1h", "binance", [], 30);
  ok("scan halts at the first 429 and keeps earlier results", res.rateLimitedUntil > now && Object.keys(res.klines).length >= 6 && Object.keys(res.klines).length < 30);
  ok("skipped symbols are reported as RATE_LIMIT", res.errors.filter((e) => e.reason === "RATE_LIMIT").length >= 18);
  ok("no requests after the halt", klineCalls <= 12, String(klineCalls));
  ok("Retry-After honoured (≈30 s)", rateLimitCooldown() > 25_000 && rateLimitCooldown() <= 30_000);
  let threw = null;
  try { await fetchDirectMarketData("1h", "binance", [], 30); } catch (e) { threw = e; }
  ok("new scans refused during the cooldown", threw instanceof RateLimitError);
  resetRateLimitForTests();
  globalThis.fetch = async () => json({ retCode: 10006, retMsg: "Too many visits!" });
  threw = null;
  try { await fetchDirectMarketData("1h", "bybit-spot", [], 5); } catch (e) { threw = e; }
  ok("Bybit retCode 10006 (HTTP 200) is a rate limit, not empty data", threw instanceof RateLimitError);
  resetRateLimitForTests();
  globalThis.fetch = async () => json({ retCode: 10001, retMsg: "params error" });
  threw = null;
  try { await fetchDirectMarketData("1h", "bybit-spot", [], 5); } catch (e) { threw = e; }
  ok("other Bybit error envelopes raise errors", threw instanceof Error && !(threw instanceof RateLimitError) && /10001/.test(threw.message));
  resetRateLimitForTests();
  globalThis.fetch = realFetch;
}

console.log("Catch-up recording, holidays and macro calendar (v2.2)");
{
  const { MACRO_EVENTS, eventsNear } = await import("./macro-calendar.ts");
  const k = walk(1100);
  const lastT = k[k.length - 1].time;
  const since = k[k.length - 11].time; // 9 bars closed after `since`, excluding the newest
  const res = runScanJob({
    key: "cu", packed: packKlines(k), intervalMs: 4 * H, volumeAvailable: true, assetClass: "crypto",
    catchUp: { since, max: 48, ctx: { src: "binance", tf: "4h", pair: "CUUSDT", ac: "crypto", intervalMs: 4 * H, rank: 0, quoteVolume: 0, appVersion: "t", live: true } },
  });
  const cu = res.catchUpRows;
  ok("catch-up scores only bars after the last recorded one (newest excluded)", cu.length === 9 && cu.every((r) => r.t > since && r.t < lastT), String(cu.length));
  const direct = toLedgerRow(k.slice(k.length - 2 - ENGINE_BARS + 1, k.length - 1), scoreSeries(k.slice(k.length - 2 - ENGINE_BARS + 1, k.length - 1), { intervalMs: 4 * H, volumeAvailable: true, assetClass: "crypto" }), { src: "binance", tf: "4h", pair: "CUUSDT", ac: "crypto", intervalMs: 4 * H, closeTime: 0, rank: 0, quoteVolume: 0, appVersion: "t", live: true });
  const sameBar = cu.find((r) => r.t === direct.t);
  ok("catch-up row equals a live score of the same bar", sameBar && sameBar.sc === direct.sc && sameBar.m === direct.m && sameBar.id === direct.id);
  ok("catch-up capped at max bars", runScanJob({ key: "cu2", packed: packKlines(k), intervalMs: 4 * H, volumeAvailable: true, catchUp: { since: 0, max: 5, ctx: { src: "binance", tf: "4h", pair: "X", ac: "crypto", intervalMs: 4 * H, rank: 0, quoteVolume: 0, appVersion: "t", live: true } } }).catchUpRows.length === 5);
  ok("Thanksgiving 2026 (26 Nov) is a closed stock day", !underlyingOpenAt("stock", Date.UTC(2026, 10, 26, 16)));
  ok("27 Nov 2026 early close: open 12:00 ET, closed 13:30 ET", underlyingOpenAt("stock", Date.UTC(2026, 10, 27, 17)) && !underlyingOpenAt("stock", Date.UTC(2026, 10, 27, 18, 30)));
  ok("Christmas Eve 2027 is a holiday (observed)", !underlyingOpenAt("stock", Date.UTC(2027, 11, 24, 16)));
  const at = (id) => MACRO_EVENTS.find((e) => e.id === id)?.at;
  ok("FOMC 9 Dec 2026 decision at 19:00 UTC (14:00 EST)", at("fomc-2026-12-09") === Date.UTC(2026, 11, 9, 19));
  ok("FOMC 28 Oct 2026 decision at 18:00 UTC (14:00 EDT)", at("fomc-2026-10-28") === Date.UTC(2026, 9, 28, 18));
  ok("US CPI 10 Nov 2026 at 13:30 UTC (08:30 EST)", at("cpi-2026-11-10") === Date.UTC(2026, 10, 10, 13, 30));
  ok("ECB 17 Dec 2026 at 13:15 UTC (14:15 CET)", at("ecb-2026-12-17") === Date.UTC(2026, 11, 17, 13, 15));
  ok("ECB 10 Jun 2027 at 12:15 UTC (14:15 CEST)", at("ecb-2027-06-10") === Date.UTC(2027, 5, 10, 12, 15));
  ok("eventsNear finds the jobs report the day before", eventsNear(Date.UTC(2026, 10, 5, 15)).some((e) => e.kind === "nfp"));
}

console.log(`\nMeasurement suite: ${passed}/${passed + failed} passed`);
if (failed) process.exitCode = 1;
