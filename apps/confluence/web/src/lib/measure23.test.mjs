// v2.3 regression suite — research hygiene, enrichment, sessions, depth, sources.
// Run: npm run test:measure23   (node scripts/run-engine-tests.mjs measure23.test.mjs)
import {
  buildReport, wilson, bootstrapMean, pbo, rng, measureOutcome, outcomeFromSnapshot, toSnapshot, costsFor,
  DEFAULT_COSTS, CLASS_EXTRA_SLIP_BPS, LEDGER_CSV_COLUMNS, ledgerRowValues, PRIMARY_WARM_BARS,
  parseLedgerImport, sanitizeLedgerRow,
} from "./ledger-metrics.ts";
import { liveRow, scanShared } from "./scan-record.ts";
import { runCatchUp, packKlines } from "./scan-jobs.ts";
import { engineBarsOf } from "./ledger-metrics.ts";
import { createLedgerStore, PREREG_MIN_DAYS } from "./signal-ledger.ts";
import { underlyingOpenAt, classifySymbol } from "./asset-classes.ts";
import { scoreSeries, sessionBars, detectSplit, toLedgerRow } from "./scan-pipeline.ts";
import { ENGINE_BARS } from "./engine-config.ts";
import {
  slippageBps, passesTurnoverFloor, isBandPinned, fetchDirectMarketData, fetchOrderBook, resetRateLimitForTests,
  MIN_QUOTE_VOLUME_NONCRYPTO, DATA_SOURCES,
} from "./market-client.ts";
import { percentiles, betaTo, htfTrend, takerDelta, macroEventHours, ret20, enrich } from "./enrichment.ts";
import { earningsNear, underlyingTicker } from "./earnings-calendar.ts";
import { MACRO_EVENTS } from "./macro-calendar.ts";

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log("  ok   - " + name); }
  else { failed++; console.log("  FAIL - " + name + (extra ? "  [" + extra + "]" : "")); }
};
const H = 3600e3;
const r = rng(4242);
function walk(n, t0 = Date.UTC(2025, 0, 1), step = 4 * H, vol = 0.03) {
  const out = []; let px = 100;
  for (let i = 0; i < n; i++) {
    const o = px; px *= Math.exp((r() - 0.5) * vol);
    out.push({ time: t0 + i * step, open: o, high: Math.max(o, px) * 1.003, low: Math.min(o, px) * 0.997, close: px, volume: 500 + r() * 500 });
  }
  return out;
}
const baseRow = { cfg: "c1", ev: "1", app: "t", src: "binance", tf: "4h", ac: "crypto", rec: 0, sc: 0, m: 0, st: 0, sup: 0, lv: 0, v: 18, bu: 0, be: 0, er: null, bl: [0, 0, 0, 0], rk: 1, qv: 1, rd: 0, rc: 0, wb: 1000, live: 1 };

console.log("Statistics: intervals, PBO, benchmarks");
{
  const [lo, hi] = wilson(55, 100);
  ok("Wilson interval brackets the proportion", lo < 0.55 && hi > 0.55 && lo > 0.44 && hi < 0.65, `${lo} ${hi}`);
  ok("Wilson interval with n=0 is undefined", Number.isNaN(wilson(0, 0)[0]));
  const x = Array.from({ length: 400 }, () => (r() - 0.5) * 0.02 + 0.001);
  const [blo, bhi] = bootstrapMean(x);
  const m = x.reduce((a, v) => a + v, 0) / x.length;
  ok("bootstrap interval contains the sample mean", blo < m && bhi > m, `${blo} ${m} ${bhi}`);
  ok("bootstrap is reproducible (seeded)", bootstrapMean(x)[0] === blo);
  // Perfectly correlated pairs (10 identical values per period): a block bootstrap must not shrink the interval by √10.
  const per = Array.from({ length: 60 }, () => (r() - 0.5) * 0.02);
  const corr = per.flatMap((v) => Array(10).fill(v));
  const keys = per.flatMap((_, i) => Array(10).fill(i));
  const iid = bootstrapMean(corr); const blk = bootstrapMean(corr, 500, 7, keys);
  ok("block bootstrap widens the interval for cross-sectionally correlated outcomes", (blk[1] - blk[0]) > 2 * (iid[1] - iid[0]), `${(blk[1] - blk[0]).toFixed(5)} vs ${(iid[1] - iid[0]).toFixed(5)}`);
  // PBO on pure noise ≈ 0.5; when one variant dominates every period it is ≈ 0.
  // One noise matrix gives a noisy PBO (the 70 splits are correlated), so average 40 draws.
  let sum = 0; let combos = 0;
  for (let rep = 0; rep < 40; rep++) {
    const noise = Array.from({ length: 160 }, () => Array.from({ length: 10 }, () => r() - 0.5));
    const pn = pbo(noise, 8); sum += pn.pbo; combos = pn.combinations;
  }
  ok("PBO on noise averages near 0.5", sum / 40 > 0.35 && sum / 40 < 0.65 && combos === 70, String(sum / 40));
  const dominant = Array.from({ length: 160 }, () => Array.from({ length: 10 }, (_, k) => (k === 3 ? 1 : 0) + (r() - 0.5) * 0.1));
  ok("PBO when one variant truly dominates is ~0", pbo(dominant, 8).pbo < 0.05);
  ok("PBO needs ≥ 2 variants and enough periods", Number.isNaN(pbo([[1], [2]], 8).pbo));
  // Scale must not decide: variant 1 is variant 0 × 10 plus noise-free scaling — Sharpe-based PBO stays near noise level.
  let sumScaled = 0;
  for (let rep = 0; rep < 40; rep++) {
    const m = Array.from({ length: 160 }, () => { const a = r() - 0.5; const b = r() - 0.5; return [a, b * 10, r() - 0.5, (r() - 0.5) * 5]; });
    sumScaled += pbo(m, 8).pbo;
  }
  ok("PBO compares variants on Sharpe, not raw size", sumScaled / 40 > 0.3, String(sumScaled / 40));

  // Cross-section of 8 pairs per bar. "Perfect" signals on pair 0, the other
  // pairs are NEUTRAL rows on the same bars (the within-bar permutation pool).
  const pairs = Array.from({ length: 8 }, (_, j) => ({ pair: `P${j}USDT`, k: walk(1400) }));
  const rows = [];
  const outcomes = new Map([[3, []]]);
  for (let i = 1020; i < 1380; i++) {
    pairs.forEach(({ pair, k }, j) => {
      const fwd = k[i + 3].close / k[i + 1].open - 1;
      const m = j === 0 ? (fwd > 0 ? 1 : -1) : 0;
      const row = { ...baseRow, pair, id: `${pair}${i}`, t: k[i].time, tc: k[i].time + 4 * H, c: k[i].close, m, sc: m * 60, st: m ? 1 : 0 };
      rows.push(row);
      const o = measureOutcome(row, k, 3, DEFAULT_COSTS.binance, 4 * H);
      if (o) { o.btcGross = 0.001; outcomes.get(3).push(o); }
    });
  }
  const rep = buildReport(rows, outcomes, 30, 5, 4 * H, { momentumOf: () => 1, shuffles: 200 });
  const h3 = rep.horizons.find((h) => h.horizon === 3);
  ok("perfect signal beats within-bar label permutation (p ≤ 0.05)", h3.benchmarks.shuffledP <= 0.05, String(h3.benchmarks.shuffledP));

  // C2: an uninformative signal that fires in clusters when the whole market moves must NOT pass.
  {
    let rejections = 0;
    for (let rep2 = 0; rep2 < 30; rep2++) {
      const rows2 = []; const outs2 = new Map([[3, []]]);
      const T = 600;
      const market = Array.from({ length: T + 10 }, () => (r() - 0.5) * 0.06);
      const ks = Array.from({ length: 8 }, () => { let px = 100; return market.map((mv, i) => { const o = px; px *= Math.exp(mv + (r() - 0.5) * 0.01); return { time: Date.UTC(2025, 0, 1) + i * 4 * H, open: o, high: Math.max(o, px), low: Math.min(o, px), close: px, volume: 1 }; }); });
      for (let i = 0; i < T; i += 4) {
        const fire = r() < 0.3; // clustered, uninformative
        ks.forEach((k, j) => {
          const m = fire && j < 4 ? 1 : 0;
          const row = { ...baseRow, pair: `Q${j}USDT`, id: `q${rep2}-${j}-${i}`, t: k[i].time, tc: k[i].time, c: k[i].close, m, st: m };
          rows2.push(row);
          const o = measureOutcome(row, k, 3, DEFAULT_COSTS.binance, 4 * H);
          if (o) outs2.get(3).push(o);
        });
      }
      const p = buildReport(rows2, outs2, 30, 1, 4 * H, { shuffles: 100 }).horizons[0].benchmarks.shuffledP;
      if (p <= 0.05) rejections++;
    }
    ok("within-bar permutation does not reject a clustered null (≤ 15 % of 30 runs)", rejections <= 4, `${rejections}/30`);
  }

  // C1: cheap-pair signals with no information must show ~0 edge (costs are matched).
  {
    const k1 = walk(1400); const k2 = walk(1400);
    const rows3 = []; const outs3 = new Map([[3, []]]);
    for (let i = 1020; i < 1380; i++) {
      const sig = { ...baseRow, pair: "CHEAPUSDT", id: `c${i}`, t: k1[i].time, tc: k1[i].time, c: k1[i].close, m: r() < 0.5 ? 1 : -1, st: 1 };
      const neu = { ...baseRow, pair: "DEARUSDT", id: `d${i}`, t: k2[i].time, tc: k2[i].time, c: k2[i].close, m: 0 };
      rows3.push(sig, neu);
      const a = measureOutcome(sig, k1, 3, { feeBps: 10, slipBps: 0, fundingBpsPer8h: 0 }, 4 * H);
      const b = measureOutcome(neu, k2, 3, { feeBps: 10, slipBps: 15, fundingBpsPer8h: 0 }, 4 * H);
      if (a) outs3.get(3).push(a);
      if (b) outs3.get(3).push(b);
    }
    const g = buildReport(rows3, outs3, 30, 1, 4 * H, { shuffles: 50 }).horizons[0].groups;
    const gb = g.find((x) => x.label === "BUY · all");
    ok("edge is cost-neutral: a cheap pair's random signals show no cost 'edge'", Math.abs(gb.baseMeanBps - (gb.meanNetBps - gb.edgeBps)) < 1e-9 && Math.abs(gb.costBps - 20) < 1e-9, `cost ${gb.costBps} edge ${gb.edgeBps.toFixed(1)}`);
  }
  ok("momentum benchmark is reported", h3.benchmarks.momentum && h3.benchmarks.momentum.n > 0);
  const buy = h3.groups.find((g) => g.label === "BUY · all");
  ok("BTC-excess is computed when BTC outcomes exist", Number.isFinite(buy.excessBtcBps) && Math.abs(buy.excessBtcBps - (buy.meanNetBps - 10)) < 1e-6, `${buy.excessBtcBps} ${buy.meanNetBps}`);
  ok("group carries Wilson and bootstrap intervals", buy.hitCi[0] <= buy.hitRate && buy.meanCi[0] <= buy.meanNetBps);
  ok("cross-sectional excess is computed with ≥ 5 pairs per bar", Number.isFinite(buy.excessXsBps));
  ok("more trials lower the deflated Sharpe", buildReport(rows, outcomes, 30, 50, 4 * H).horizons[0].sharpe.dsr <= buildReport(rows, outcomes, 30, 1, 4 * H).horizons[0].sharpe.dsr);
}

console.log("Outcome snapshots and costs");
{
  const k = walk(200);
  const row = { ...baseRow, pair: "AUSDT", id: "x", t: k[100].time, tc: k[100].time + 4 * H, c: k[100].close, m: -1 };
  const o = measureOutcome(row, k, 6, DEFAULT_COSTS["bybit-perp"], 4 * H);
  const back = outcomeFromSnapshot(row, 6, toSnapshot(o), DEFAULT_COSTS["bybit-perp"]);
  ok("snapshot round-trip reproduces the net outcome", Math.abs(back.net - o.net) < 1e-12 && back.gross === o.gross, `${back.net} ${o.net}`);
  const dearer = outcomeFromSnapshot(row, 6, toSnapshot(o), { ...DEFAULT_COSTS["bybit-perp"], slipBps: 50 });
  ok("snapshots re-apply today's cost model", dearer.net < back.net);
  const repriced = outcomeFromSnapshot(row, 6, toSnapshot(o), { ...DEFAULT_COSTS["bybit-perp"], fundingBpsPer8h: 5 });
  ok("snapshots re-price funding from today's model (review S6)", repriced.fundingLong > o.fundingLong * 4.9 && Number.isFinite(o.cost) && o.cost > 0);
  ok("per-class costs add slippage for tokenised stocks", costsFor("bybit-perp", "stock").slipBps === DEFAULT_COSTS["bybit-perp"].slipBps + CLASS_EXTRA_SLIP_BPS.stock);
  ok("measured slippage replaces the placeholder", costsFor("binance", "stock", 2.5).slipBps === 2.5);
  ok("primary window is the full engine window", PRIMARY_WARM_BARS === ENGINE_BARS);
}

console.log("Ledger store v2.3");
{
  const data = new Map();
  const col = (c) => (data.has(c) ? data.get(c) : data.set(c, new Map()).get(c));
  const port = {
    kind: "indexeddb",
    async get(c, id) { const v = col(c).get(id); return v ? JSON.parse(JSON.stringify(v)) : null; },
    async put(c, id, doc) { col(c).set(id, JSON.parse(JSON.stringify(doc))); },
    async del(c, id) { col(c).delete(id); },
    async list(c) { return [...col(c)].map(([id, doc]) => ({ id, doc })); },
  };
  const store = createLedgerStore(port);
  const now = Date.now();
  const mk = (pair, t) => ({ ...baseRow, pair, t, tc: t, c: 1, id: `c1|binance|4h|${pair}|${t}` });
  const universe = [{ p: "AUSDT", qv: 9e6, ac: "crypto" }, { p: "TSLAXUSDT", qv: 3e6, ac: "stock" }];
  await store.record([mk("AUSDT", now)], { t: now, list: universe });
  const uKey = `u|binance|${now}`;
  ok("the full universe is stored once per (source, bar), outside the row documents", col("ledger_meta").get(uKey)?.list?.length === 2 && ![...col("ledger").values()][0].universe);
  await store.record([mk("BUSDT", now)], { t: now, list: [{ p: "ZZZ", qv: 1, ac: "crypto" }] });
  ok("first universe wins (no overwrite)", col("ledger_meta").get(uKey).list[0].p === "AUSDT");
  ok("universes() lists them", (await store.universes()).size === 1);
  ok("a stored universe counts toward the row cap", (await store.stats()).rows === 2 + 40);

  await store.setSeriesCursors("binance", "4h", { AUSDT: now, BUSDT: now - 10 });
  await store.setSeriesCursors("binance", "4h", { AUSDT: now - 999 }); // never moves backwards
  const cur = await store.seriesCursors("binance", "4h");
  ok("per-series cursors are independent and monotonic", cur.AUSDT === now && cur.BUSDT === now - 10 && cur.CUSDT === undefined);

  const rows = await store.all();
  const saved = await store.saveOutcomes(rows, new Map([[rows[0].id, { 6: { g: 0.01, mfe: 0.02, mae: -0.01, f: 0 } }]]));
  const outs = await store.outcomes(rows);
  ok("outcome snapshots are stored per bar (meta), read only for the rows asked for", saved === 1 && outs.get(rows[0].id)?.[6]?.g === 0.01 && (await store.all()).length === 2);

  await store.registerTrial("c1", "binance|4h|crypto|full");
  await store.registerTrial("c1", "binance|4h|crypto|full");
  await store.registerTrial("c1", "binance|1h|crypto|full");
  ok("trials register counts distinct variants", (await store.trials("c1")).length === 2);
  await store.registerTrial("c2", "binance|4h|crypto|full");
  ok("trial count spans engine configs (an engine change does not reset it)", (await store.trials()).length === 3 && (await store.trials()).every((x) => typeof x.id === "string"));
  const scope = { cfg: "c1", source: "binance", tf: "4h", assetClass: "crypto", windowMode: "full" };
  const p1 = await store.preregister({ ...scope, horizon: 6, hypothesis: "edge > 0" });
  const p2 = await store.preregister({ ...scope, horizon: 12, hypothesis: "changed my mind", minDays: 1 });
  ok("pre-registration is scoped to its view", (await store.preregistration({ ...scope, tf: "1h" })) === null && (await store.preregistration(scope))?.windowMode === "full");
  ok("pre-registration enforces ≥ 90 days", p1.decisionDate - p1.startedAt >= PREREG_MIN_DAYS * 86_400_000 - 1);
  ok("pre-registration cannot be moved", p2.horizon === 6 && p2.decisionDate === p1.decisionDate && p2.hypothesis === "edge > 0");
  await store.markExported(now - 8 * 86_400_000);
  ok("last export is remembered", (await store.lastExport()) === now - 8 * 86_400_000);
  await store.setSlippage("binance", { AUSDT: 1.25, BAD: Number.NaN });
  const slip = await store.slippage("binance");
  ok("measured slippage is stored per pair (NaN rejected)", slip.AUSDT?.bps === 1.25 && !slip.BAD);
  await store.addGap("binance", "4h", "AUSDT", { from: 1, to: 2 });
  ok("recording gaps are logged per series", (await store.gaps("binance", "4h")).AUSDT?.length === 1);
  await store.clear();
  ok("clear() keeps trials and pre-registrations", (await store.trials()).length === 3 && (await store.preregistration(scope))?.horizon === 6);
  ok("clear() removes rows and cursors", (await store.all()).length === 0 && Object.keys(await store.seriesCursors("binance", "4h")).length === 0);
}

console.log("Sessions: RTH filter, split guard, holidays");
{
  // 1h bars over two full weeks starting Monday 2026-03-02 00:00 UTC.
  const k = walk(24 * 14 + 1100, Date.UTC(2026, 1, 1), H);
  const rth = sessionBars(k, "stock", H);
  ok("stock intraday keeps only bars overlapping the NYSE session", rth.length < k.length * 0.3 && rth.length > k.length * 0.15, `${rth.length}/${k.length}`);
  ok("crypto bars are never filtered", sessionBars(k, "crypto", H) === k);
  ok("weekly stock bars are not filtered", sessionBars(k, "stock", 7 * 86_400_000) === k);
  const s = scoreSeries(k, { intervalMs: H, volumeAvailable: true, assetClass: "stock" });
  ok("warmBars counts the raw window for every class", s.warmBars === ENGINE_BARS && s.sessionFiltered === true);
  const split = k.map((b, i) => (i < k.length - 50 ? b : { ...b, open: b.open / 4, high: b.high / 4, low: b.low / 4, close: b.close / 4 }));
  ok("a 4:1 price jump is detected as a split", detectSplit(split) && !detectSplit(k));
  const ss = scoreSeries(split, { intervalMs: 86_400_000, volumeAvailable: true, assetClass: "stock" });
  ok("a split mutes the stock signal", ss.usable && ss.split && ss.confluence.suppressed);
  ok("crypto is never split-muted", !scoreSeries(split, { intervalMs: 86_400_000, volumeAvailable: true, assetClass: "crypto" }).split);
  const row = toLedgerRow(split, ss, { src: "bybit-perp", tf: "1d", pair: "TSLAUSDT", ac: "stock", intervalMs: 86_400_000, closeTime: 0, rank: 3, quoteVolume: 1, appVersion: "t", live: true, universeRank: 40, rankSource: "live" });
  ok("ledger row carries split, universe rank and rank source", row.spl === 1 && row.rku === 40 && row.rks === "live");
  const stockRow = toLedgerRow(k, s, { src: "bybit-perp", tf: "1h", pair: "TSLAUSDT", ac: "stock", intervalMs: H, closeTime: 0, rank: 1, quoteVolume: 1, appVersion: "t", live: true });
  ok("stock rows record the bars the engine really saw (review C7)", stockRow.eb > 0 && stockRow.eb < ENGINE_BARS && engineBarsOf(stockRow) === stockRow.eb && engineBarsOf({ wb: 1000 }) === 1000);
  const before = split.length - 52;
  const sRow = { ...baseRow, ac: "stock", pair: "TSLAUSDT", id: "s", t: split[before].time, tc: 0, c: split[before].close, m: 1 };
  ok("an outcome spanning a split is not measured (review C8)", measureOutcome(sRow, split, 6, DEFAULT_COSTS.binance, H) === null && measureOutcome({ ...sRow, ac: "crypto" }, split, 6, DEFAULT_COSTS.binance, H) !== null);

  const ny = (d, h, m = 0) => Date.UTC(...d.split("-").map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))), h + 5, m); // winter: UTC−5
  ok("FX is closed on 25 Dec", !underlyingOpenAt("fx", ny("2026-12-25", 10)));
  ok("FX is open on an ordinary weekday", underlyingOpenAt("fx", ny("2026-12-23", 10)));
  ok("CME metals closed on Good Friday", !underlyingOpenAt("commodity", Date.UTC(2027, 2, 26, 15)));
  ok("CME metals halt early on Thanksgiving", underlyingOpenAt("commodity", ny("2026-11-26", 12)) && !underlyingOpenAt("commodity", ny("2026-11-26", 14)));
  ok("bitget-perp FX/commodity perps are classified", classifySymbol("bitget-perp", "XAUUSDT") === "commodity");
}

console.log("Enrichment (logged, never scored)");
{
  const pc = percentiles(new Map([["A", 0.1], ["B", -0.2], ["C", 0.3], ["D", 0.1]]));
  ok("percentiles rank cross-sectionally with ties", pc.get("B") === 0 && pc.get("C") === 100 && pc.get("A") === pc.get("D"));
  const btc = walk(300);
  const lev = btc.map((b, i) => (i === 0 ? { ...b } : null));
  for (let i = 1; i < btc.length; i++) {
    const rr = Math.log(btc[i].close / btc[i - 1].close);
    const c = lev[i - 1].close * Math.exp(2 * rr);
    lev[i] = { ...btc[i], close: c, open: lev[i - 1].close, high: c * 1.001, low: c * 0.999 };
  }
  ok("beta of a 2× levered series is 2", Math.abs(betaTo(lev, btc) - 2) < 0.01, String(betaTo(lev, btc)));
  ok("beta is null without BTC", betaTo(lev, undefined) === null);
  const up = Array.from({ length: 200 }, (_, i) => ({ time: i * H, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1 }));
  ok("higher-timeframe trend of a rising series is +1", htfTrend(up, H) === 1);
  ok("higher-timeframe trend needs enough bars", htfTrend(up.slice(0, 40), H) === null);
  const taker = up.map((b) => ({ ...b, volume: 10, takerBuy: 7.5 }));
  ok("taker delta = (buy − sell) / volume", takerDelta(taker) === 0.5);
  ok("taker delta is null when the venue does not report it", takerDelta(up) === null);
  const ev = MACRO_EVENTS.find((e) => e.at > Date.UTC(2026, 0, 1));
  ok("macro-event distance in hours", macroEventHours(ev.at - 5 * H) === 5 && macroEventHours(ev.at + 2 * H) === -2);
  ok("tokenised-stock symbols map to the underlying ticker", underlyingTicker("NVDAXUSDT") === "NVDA" && underlyingTicker("NVDAONUSDT") === "NVDA" && underlyingTicker("NVDAUSDT") === "NVDA");
  ok("earnings flag uses the manual list only", earningsNear("NVDAXUSDT", Date.UTC(2026, 10, 19, 21), 24, { NVDA: ["2026-11-19"] }) && !earningsNear("NVDAXUSDT", Date.UTC(2026, 10, 19)));
  ok("ret20 needs 21 bars", ret20(up.slice(0, 20)) === null && ret20(up) > 0);
  const e = enrich({ pair: "TSLAXUSDT", ac: "stock", tc: ev.at }, up, { intervalMs: H, rs: 77, split: false });
  ok("enrich() fills stock fields", e.rs === 77 && e.earn === 0 && e.spl === 0 && e.pin === 0 && e.mev === 0);
  const csvRow = ledgerRowValues({ ...baseRow, id: "z", pair: "A", t: 1, tc: 1, c: 1, ...e });
  ok("CSV carries every v2.3 column", csvRow.length === LEDGER_CSV_COLUMNS.length && LEDGER_CSV_COLUMNS.includes("taker_delta") && new Set(LEDGER_CSV_COLUMNS).size === LEDGER_CSV_COLUMNS.length);
}

console.log("Market data: depth, floor, basis, universe, sources");
{
  const book = { bids: [[99.9, 5], [99.8, 10]], asks: [[100.1, 5], [100.2, 10]] };
  const small = slippageBps(book, 100);
  const big = slippageBps(book, 1000);
  ok("slippage = half spread for a small order", Math.abs(small - 10) < 0.01, String(small));
  ok("larger orders walk the book", big > small);
  ok("too-thin book returns NaN", Number.isNaN(slippageBps(book, 1e7)));
  ok("turnover floor drops thin non-crypto", !passesTurnoverFloor("binance", "PAXGUSDT", MIN_QUOTE_VOLUME_NONCRYPTO - 1) && passesTurnoverFloor("binance", "BTCUSDT", 1));
  ok("band-pinned on large basis", isBandPinned([], 2) && !isBandPinned([], 0.2));
  const flat = [1, 2, 3].map((i) => ({ time: i, open: 5, high: 5, low: 5, close: 5, volume: 0 }));
  ok("band-pinned on three zero-range bars", isBandPinned(flat));
  ok("Bitget perpetual source is registered", DATA_SOURCES.some((s) => s.value === "bitget-perp") && DEFAULT_COSTS["bitget-perp"]);

  const realFetch = globalThis.fetch;
  const seen = [];
  const now = Date.now();
  const bar = (t) => [t, "1", "1.1", "0.9", "1.05", "100", t + 4 * H - 1, "105", 10, "60", "63", "0"];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    const u = String(url);
    if (u.includes("ticker/24hr")) {
      return new Response(JSON.stringify([
        { symbol: "BTCUSDT", openPrice: "1", lastPrice: "1", quoteVolume: "900000000" },
        { symbol: "PAXGUSDT", openPrice: "1", lastPrice: "1", quoteVolume: "1000" },
        { symbol: "ETHUSDT", openPrice: "1", lastPrice: "1", quoteVolume: "500000000" },
      ]), { status: 200 });
    }
    if (u.includes("/klines")) {
      const t0 = Math.floor(now / (4 * H)) * 4 * H;
      return new Response(JSON.stringify([bar(t0 - 8 * H), bar(t0 - 4 * H), bar(t0)]), { status: 200 });
    }
    if (u.includes("mix/market/tickers")) {
      return new Response(JSON.stringify({ code: "00000", data: [{ symbol: "BTCUSDT", lastPr: "1", change24h: "0", usdtVolume: "5", markPrice: "102", indexPrice: "100" }] }), { status: 200 });
    }
    if (u.includes("/depth")) return new Response(JSON.stringify({ bids: [["99.9", "5"]], asks: [["100.1", "5"]] }), { status: 200 });
    return new Response("{}", { status: 404 });
  };
  try {
    resetRateLimitForTests();
    const d = await fetchDirectMarketData("4h", "binance", [], 10, undefined, undefined, "all");
    ok("universe lists every class (full unfiltered ranking)", d.universe?.map((u) => u.p).join(",") === "BTCUSDT,ETHUSDT,PAXGUSDT");
    ok("turnover floor removes the thin commodity token from the scan", !d.tickers.some((t) => t.symbol === "PAXGUSDT") && d.belowFloor === 1);
    ok("Binance taker-buy volume is parsed", d.klines.BTCUSDT?.[0]?.takerBuy === 60);
    const bp = await fetchDirectMarketData("4h", "bitget-perp", [], 10).catch((e) => ({ error: String(e) }));
    ok("Bitget perps use the v2 mix endpoints and report basis", seen.some((u) => u.includes("/api/v2/mix/market/tickers?productType=USDT-FUTURES")) && Math.abs((bp.basisBySymbol?.BTCUSDT ?? 0) - 2) < 1e-9, JSON.stringify(bp.basisBySymbol ?? bp));
    const ob = await fetchOrderBook("binance", "BTCUSDT");
    ok("order book is fetched from the public depth endpoint", ob.bids[0][0] === 99.9 && seen.some((u) => u.includes("/api/v3/depth?symbol=BTCUSDT&limit=100")));
    let threw = false;
    try { await fetchOrderBook("binance", "BTC/../X"); } catch { threw = true; }
    ok("order book rejects unsafe symbols", threw);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("Import (recorder JSONL / JSON export) and shared row assembly");
{
  const k = walk(1100, Date.UTC(2025, 0, 1), 4 * H);
  const series = [{ symbol: "BTCUSDT", rank: 1, quoteVolume: 1e9, ac: "crypto", kl: k }, { symbol: "ETHUSDT", rank: 2, quoteVolume: 5e8, ac: "crypto", kl: walk(1100, Date.UTC(2025, 0, 1), 4 * H) }];
  const shared = scanShared(series, [{ p: "BTCUSDT", qv: 1e9, ac: "crypto" }, { p: "PAXGUSDT", qv: 8e8, ac: "commodity" }, { p: "ETHUSDT", qv: 5e8, ac: "crypto" }]);
  const score = scoreSeries(k, { intervalMs: 4 * H, volumeAvailable: true, assetClass: "crypto" });
  const row = liveRow(series[0], score, { src: "binance", tf: "4h", intervalMs: 4 * H, appVersion: "t" }, shared);
  const row2 = liveRow(series[1], scoreSeries(series[1].kl, { intervalMs: 4 * H, volumeAvailable: true, assetClass: "crypto" }), { src: "binance", tf: "4h", intervalMs: 4 * H, appVersion: "t" }, shared);
  ok("shared row assembly sets full-ranking rank and context", row.rku === 1 && row2.rku === 3 && row.rks === "live" && row.beta === 1 && Number.isFinite(row2.beta));
  const jsonl = [row, row2].map((x) => JSON.stringify(x)).join("\n") + "\nnot json\n";
  const imp = parseLedgerImport(jsonl);
  ok("recorder JSONL imports losslessly (bad lines counted)", imp.rows.length === 2 && imp.rejected === 1 && JSON.stringify(imp.rows[0]) === JSON.stringify(sanitizeLedgerRow(row)) && imp.rows[0].sc === row.sc && imp.rows[0].rku === 1);
  const exp = parseLedgerImport(JSON.stringify({ format: "rsl-signal-ledger", version: 1, rows: [row] }));
  ok("the app's JSON export imports too", exp.rows.length === 1 && exp.rejected === 0);
  ok("replay rows (live = 0) are refused by the forward-ledger import (review S4)", parseLedgerImport(JSON.stringify({ ...row, live: 0 })).rows.length === 0);
  // Catch-up gaps (review S12): a hole longer than `max` is reported.
  const kk = walk(1100, Date.UTC(2025, 0, 1), 4 * H);
  const cu = runCatchUp({ key: "x", packed: packKlines(kk), intervalMs: 4 * H, volumeAvailable: true, assetClass: "crypto",
    catchUp: { since: kk[1100 - 100].time, max: 48, ctx: { src: "binance", tf: "4h", pair: "XUSDT", ac: "crypto", intervalMs: 4 * H, rank: 1, quoteVolume: 1, appVersion: "t", live: true } } }, kk);
  ok("catch-up reports bars it could not cover", cu.rows.length === 48 && cu.gap && cu.gap.from === kk[1001].time && cu.gap.to === kk[1100 - 49 - 1].time, JSON.stringify(cu.gap));
  ok("an id that does not match the bar is rejected", sanitizeLedgerRow({ ...row, id: row.id.replace("BTCUSDT", "ETHUSDT") }) === null);
  ok("unknown fields are dropped; bad enums rejected", !("evil" in sanitizeLedgerRow({ ...row, evil: "<script>" })) && sanitizeLedgerRow({ ...row, m: 7 }) === null && sanitizeLedgerRow({ ...row, src: "kraken", id: row.id.replace("binance", "kraken") }) === null);
}

console.log(`\nMeasurement v2.3 suite: ${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
