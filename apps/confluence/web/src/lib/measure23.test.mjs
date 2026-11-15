// v2.3 regression suite — research hygiene, enrichment, sessions, depth, sources.
// Run: npm run test:measure23   (node scripts/run-engine-tests.mjs measure23.test.mjs)
import {
  buildReport, wilson, bootstrapMean, pbo, rng, measureOutcome, outcomeFromSnapshot, toSnapshot, costsFor,
  DEFAULT_COSTS, CLASS_EXTRA_SLIP_BPS, LEDGER_CSV_COLUMNS, ledgerRowValues, PRIMARY_WARM_BARS,
  parseLedgerImport, sanitizeLedgerRow, isSpotSellGroup,
} from "./ledger-metrics.ts";
import { liveRow, scanShared, applyFundTrend } from "./scan-record.ts";
import { fundTrend } from "./fund-trend.ts";
import { engineConfigId } from "./engine-config.ts";
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

/* ------------------------------------------------------------------ *
 *  v2.8 (WP19, Task 7): ledger completeness and measurement honesty.
 *  Namespace imports + `check` so a missing export fails as an assertion.
 * ------------------------------------------------------------------ */
const check = (name, fn) => {
  let res; let note = "";
  try { res = fn(); } catch (e) { res = false; note = e instanceof Error ? e.message : String(e); }
  if (Array.isArray(res)) { note = String(res[1] ?? ""); res = res[0]; }
  ok(name, res === true, note);
};
const near = (a, b, eps = 1e-9) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const LM = await import("./ledger-metrics.ts");
const SP = await import("./scan-pipeline.ts");
const PB = await import("./paper-broker.ts");
const SR = await import("./scan-record.ts");
const DC = await import("./derivatives-context.ts");
const { VOTING_INDICATORS } = await import("./scoring-profile.ts");
const { atr: atrOf } = await import("./indicators.ts");

console.log("WP19 ledger completeness: vote vector, Pattern, derivatives");
{
  const MAX = 4 ** 18 - 1;
  check("packVotes/unpackVotes round-trip for 4^18−1 and 0", () => {
    const all3 = LM.packVotes(Array(18).fill(3));
    const all0 = LM.packVotes(Array(18).fill(0));
    const u3 = LM.unpackVotes(MAX);
    const u0 = LM.unpackVotes(0);
    return [all3 === MAX && all0 === 0 && u3.length === 18 && u3.every((d) => d === 3) && u0.length === 18 && u0.every((d) => d === 0), `${all3} ${all0}`];
  });
  check("digit 0 is the first voter (least significant), digit 17 the last (×4 packing beyond 32 bits)", () => {
    const first = Array(18).fill(0); first[0] = 1;
    const last = Array(18).fill(0); last[17] = 1;
    const mixed = [0, 1, 2, 3, 3, 2, 1, 0, 1, 1, 2, 2, 3, 3, 0, 0, 2, 3];
    return LM.packVotes(first) === 1 && LM.packVotes(last) === 4 ** 17 && JSON.stringify(LM.unpackVotes(LM.packVotes(mixed))) === JSON.stringify(mixed);
  });
  check("packVotes refuses a vector that is not 18 digits of 0…3", () => {
    const bad = (v) => { try { LM.packVotes(v); return false; } catch { return true; } };
    return bad(Array(17).fill(0)) && bad([...Array(17).fill(0), 4]) && bad([...Array(17).fill(0), 1.5]);
  });

  const k = walk(1000, Date.UTC(2025, 3, 1), 4 * H);
  const ctx = { src: "binance", tf: "4h", pair: "XUSDT", ac: "crypto", intervalMs: 4 * H, closeTime: k[999].time + 4 * H, rank: 1, quoteVolume: 1, appVersion: "t", live: true };
  const s = scoreSeries(k, { intervalMs: 4 * H, volumeAvailable: true, assetClass: "crypto" });
  const slots = SP.VOTE_SLOTS ?? [];
  check("vote order = the engine's 18 voters (VOTING_INDICATORS order)", () => [
    slots.length === 18 && slots.every((i, j) => s.confluence.indicators[i] && !s.confluence.indicators[i].informational) && SP.VOTE_ORDER?.join() === VOTING_INDICATORS.map((v) => v.id).join(),
    String(SP.VOTE_ORDER),
  ]);
  check("vt digits mirror the voters' states (0 bull, 1 bear, 2 neutral)", () => {
    const row = toLedgerRow(k, s, ctx);
    const d = LM.unpackVotes(row.vt);
    const want = slots.map((i) => { const ind = s.confluence.indicators[i]; return !ind.valid || ind.informational ? 3 : ind.state === "BULLISH" ? 0 : ind.state === "BEARISH" ? 1 : 2; });
    return [Number.isSafeInteger(row.vt) && JSON.stringify(d) === JSON.stringify(want), `${row.vt} ${d.join("")} vs ${want.join("")}`];
  });
  check("invalid indicator writes 3 even though state NEUTRAL", () => {
    const j = 7; // RSI 14
    const inds = s.confluence.indicators.map((x, i) => (i === slots[j] ? { ...x, valid: false, state: "NEUTRAL" } : { ...x, valid: true, informational: x.informational, state: x.informational ? x.state : "NEUTRAL" }));
    const row = toLedgerRow(k, { ...s, confluence: { ...s.confluence, indicators: inds } }, ctx);
    const d = LM.unpackVotes(row.vt);
    return [d[j] === 3 && d.filter((x, i) => i !== j).every((x) => x === 2), d.join("")];
  });
  check("a voter disabled by the scoring profile (informational) writes 3", () => {
    const profile = { version: 1, enabled: VOTING_INDICATORS.map((v) => v.id).filter((id) => id !== "cmf") };
    const sp = scoreSeries(k, { intervalMs: 4 * H, volumeAvailable: true, assetClass: "crypto", profile });
    const d = LM.unpackVotes(toLedgerRow(k, sp, ctx).vt);
    return [d[17] === 3, d.join("")];
  });
  check("a split-muted (indicator-less) row records every voter as not valid", () => {
    const muted = { ...s, confluence: SP.suppressedConfluence("x") };
    return toLedgerRow(k, muted, ctx).vt === MAX;
  });
  check("Pattern output → pd/pc (UP/MODERATE → 1/2, DOWN/HIGH → −1/3, NONE → 0/0, none computed → null)", () => {
    const up = toLedgerRow(k, s, { ...ctx, pattern: { direction: "UP", confidence: "MODERATE" } });
    const dn = toLedgerRow(k, s, { ...ctx, pattern: { direction: "DOWN", confidence: "HIGH" } });
    const no = toLedgerRow(k, s, { ...ctx, pattern: { direction: "NONE", confidence: "NONE" } });
    const un = toLedgerRow(k, s, ctx);
    return up.pd === 1 && up.pc === 2 && dn.pd === -1 && dn.pc === 3 && no.pd === 0 && no.pc === 0 && un.pd === null && un.pc === null && un.fr === null && un.oiChg === null;
  });
  check("derivatives (Bybit linear) ≤ 2 h old at the bar close → fr, oiChg; newer (look-ahead) or older → null", () => {
    const tc = Date.UTC(2025, 5, 1, 12);
    const snaps = [
      { pair: "BTCUSDT", t: tc - 90 * 60e3, fr: 0.0001, fi: 480, oi: 1000, oit: tc - 120 * 60e3 + 1 },
      { pair: "BTCUSDT", t: tc - 30 * 60e3, fr: 0.0002, fi: 480, oi: 1100, oit: tc - 60 * 60e3 },
      { pair: "BTCUSDT", t: tc + 10 * 60e3, fr: 0.0009, fi: 480, oi: 9999, oit: tc + 5 * 60e3 },
    ];
    const f = DC.derivativeFields(snaps, "BTCUSDT", tc);
    const old = DC.derivativeFields(snaps.slice(0, 1), "BTCUSDT", tc + 3 * H);
    const none = DC.derivativeFields(snaps, "ETHUSDT", tc);
    return [f.fr === 0.0002 && near(f.oiChg, 10) && old.fr === null && old.oiChg === null && none.fr === null && none.oiChg === null, JSON.stringify([f, old])];
  });
  check("liveRow attaches fr/oiChg from the context's snapshots and pd/pc from the series' pattern", () => {
    const series = { symbol: "BTCUSDT", rank: 1, quoteVolume: 1, ac: "crypto", kl: k, pattern: { direction: "UP", confidence: "LOW" } };
    const tc = k[999].time + 4 * H;
    const derivatives = [{ pair: "BTCUSDT", t: tc - 60e3, fr: -0.0003, fi: 480, oi: 50, oit: tc - 30 * 60e3 }, { pair: "BTCUSDT", t: tc - 61 * 60e3, fr: 0, fi: 480, oi: 40, oit: tc - 90 * 60e3 }];
    const row = SR.liveRow(series, s, { src: "bybit-perp", tf: "4h", intervalMs: 4 * H, appVersion: "t", derivatives }, SR.scanShared([series]));
    return [row.fr === -0.0003 && near(row.oiChg, 25) && row.pd === 1 && row.pc === 1, JSON.stringify({ fr: row.fr, oi: row.oiChg, pd: row.pd, pc: row.pc })];
  });
}

console.log("WP19 measurement honesty: moments, power readout, confirmatory gate");
{
  const x = Array.from({ length: 300 }, () => { const u = r(); return (u - 0.48) * 0.02 + (u > 0.97 ? 0.05 : 0); });
  check("sharpeStats g3/g4 equal moment(x,3)/moment(x,4)", () => {
    const st = LM.sharpeStats(x);
    const m = x.reduce((a, v) => a + v, 0) / x.length;
    const sd = Math.sqrt(x.reduce((a, v) => a + (v - m) ** 2, 0) / (x.length - 1));
    const skew = x.reduce((a, v) => a + ((v - m) / sd) ** 3, 0) / x.length;
    const kurt = x.reduce((a, v) => a + ((v - m) / sd) ** 4, 0) / x.length;
    return [st.g3 === LM.moment(x, 3) && st.g4 === LM.moment(x, 4) && near(st.g3, skew) && near(st.g4, kurt), `${st.g3} ${st.g4}`];
  });
  const closed = (sr, g3, g4) => 1 + ((1.645 * Math.sqrt(Math.max(1e-12, 1 - g3 * sr + ((g4 - 1) / 4) * sr * sr))) / sr) ** 2;
  check("daysForPsr95 null for sr ≤ 0; positive fixture matches the closed form", () => {
    const a = LM.daysForPsr95(-0.05, 0, 3, 6);
    const b = LM.daysForPsr95(0, 0, 3, 6);
    const c = LM.daysForPsr95(0.1, -0.5, 6, 2);
    const want = Math.ceil(Math.ceil(closed(0.1, -0.5, 6)) / 2);
    const floor = LM.daysForPsr95(0.5, 100, 3, 1); // term under the root < 0 → floored at 1e-12
    return [a === null && b === null && c === want && floor === Math.ceil(Math.ceil(closed(0.5, 100, 3))), `${a} ${b} ${c} vs ${want}; ${floor}`];
  });
  check("power readout: total and remaining days; SR ≤ 0 shows no day count", () => {
    const pos = LM.powerReadout({ sr: 0.1, g3: 0, g4: 3 }, 100, 6);
    const need = Math.ceil(closed(0.1, 0, 3));
    const neg = LM.powerReadout({ sr: -0.2, g3: 0, g4: 3 }, 100, 6);
    const done = LM.powerReadout({ sr: 0.5, g3: 0, g4: 3 }, 400, 6);
    return [pos.totalDays === Math.ceil(need / 6) && pos.remainingDays === Math.ceil((need - 100) / 6) && neg.totalDays === null && neg.remainingDays === null && done.remainingDays === 0, JSON.stringify([pos, neg, done])];
  });
  // Report wiring: buildReport exposes the power readout from the block returns it used for the PSR.
  const k = walk(700, Date.UTC(2025, 0, 1), 4 * H);
  const rows = []; const outs = new Map([[1, []]]);
  for (let i = 30; i < 690; i++) {
    const row = { ...baseRow, id: `p|${i}`, pair: "AUSDT", t: k[i].time, tc: k[i].time + 4 * H, c: k[i].close, m: k[i + 1].close > k[i + 1].open ? 1 : -1 };
    rows.push(row);
    const o = measureOutcome(row, k, 1, DEFAULT_COSTS.binance, 4 * H); if (o) outs.get(1).push(o);
  }
  const rep = buildReport(rows, outs, 30, 1, 4 * H);
  check("buildReport carries power (blocks, blocks/day) next to the Sharpe it came from", () => {
    const h = rep.horizons[0];
    const p = h.power;
    return [p && p.blocks > 600 && near(p.blocksPerDay, 6, 0.01) && p.totalDays === LM.daysForPsr95(h.sharpe.sr, h.sharpe.g3, h.sharpe.g4, p.blocksPerDay), JSON.stringify(p)];
  });
  check("confirmatory DSR uses active hypotheses only", () => {
    const preregs = [{ cfg: "c1" }, { cfg: "c1" }, { cfg: "c1" }, { cfg: "old" }, { cfg: "old" }];
    const n = LM.confirmatoryTrials(preregs, "c1");
    const conf = buildReport(rows, outs, 30, n, 4 * H).horizons[0].sharpe;
    const allViews = buildReport(rows, outs, 30, 40, 4 * H).horizons[0].sharpe;
    const three = buildReport(rows, outs, 30, 3, 4 * H).horizons[0].sharpe;
    return [n === 3 && LM.confirmatoryTrials([], "c1") === 1 && conf.dsr === three.dsr && conf.sr0 === three.sr0 && conf.sr0 < allViews.sr0 && conf.dsr >= allViews.dsr, `${n} ${conf.sr0} ${allViews.sr0}`];
  });
  check("the ledger dialog deflates the confirmatory report by active pre-registrations, the exploratory one by all views", () => {
    const src = readFileSync(join(process.cwd(), "src", "components", "ledger-dialog.tsx"), "utf8");
    const conf = src.slice(src.indexOf("conf = await buildReportAsync"), src.indexOf("conf = await buildReportAsync") + 200);
    const full = src.slice(src.indexOf("const full = await buildReportAsync"), src.indexOf("const full = await buildReportAsync") + 200);
    return [src.includes("confirmatoryTrials(") && /trials: confTrials/.test(conf) && /trials,/.test(full) && !/trials: confTrials/.test(full), conf];
  });
}

console.log("WP19 ATR-bracket outcome mode (ledger, replay and paper share one bracket)");
{
  const I = 4 * H;
  const T0 = Date.UTC(2026, 9, 26, 0);
  const k = walk(400, T0 - 20 * I, I, 0.04);
  const sig = 20;
  const A = atrOf(k.slice(0, sig + 1), 14).at(-1);
  const viaPaper = (side, src) => {
    const now = k[sig + 1].time; // decision at the signal bar's close → fill at the next open
    const book0 = PB.newBook(T0 - I);
    const book = { ...book0, account: { ...book0.account, heartbeats: { [`${src}|4h`]: now } } };
    const input = { pair: "SOLUSDT", src, tf: "4h", assetClass: "crypto", side, entryRef: k[sig].close, atr: A, score: side === "long" ? 72 : -72,
      strength: "STRONG", master: side === "long" ? "BULLISH" : "BEARISH", suppressed: false, underlyingClosed: false, configId: "cfgtest000000001", barTime: k[sig].time, intervalMs: I };
    const p = PB.createProposal(book, input, now, "n1");
    const a = PB.approveProposal(book, p, "n1", now);
    if (!a.ok) throw new Error("not approved: " + (a.verdict?.reasons ?? a.error));
    const done = PB.processBars(a.book, src, "4h", { SOLUSDT: k.slice(sig + 1) }, k.at(-1).time + I);
    return { j: done.closed[0], p, book };
  };
  for (const [side, src] of [["long", "binance"], ["short", "bybit-perp"]]) {
    check(`atr-bracket outcome equals processBars R on the same fixture (${side}, ${src})`, () => {
      const { j } = viaPaper(side, src);
      const row = { ...baseRow, src, id: `c1|${src}|4h|SOLUSDT|${k[sig].time}`, pair: "SOLUSDT", t: k[sig].time, tc: k[sig + 1].time, c: k[sig].close, m: side === "long" ? 1 : -1 };
      const b = LM.measureBracket(row, k, LM.costsFor(src, "crypto"), I, { atr: A });
      return [!!j && !!b && near(b.r, j.r) && b.reason === j.reason && b.closedAt === j.closedAt, JSON.stringify({ b, r: j?.r, reason: j?.reason, at: j?.closedAt })];
    });
  }
  check("atr-bracket: 2×ATR stop, 2R target, ATR from the engine window by default; NEUTRAL and unresolved rows → null", () => {
    const row = { ...baseRow, id: "x", pair: "SOLUSDT", t: k[sig].time, tc: k[sig + 1].time, c: k[sig].close, m: 1 };
    const d = LM.measureBracket(row, k, LM.costsFor("binance", "crypto"), I);
    const e = LM.measureBracket(row, k, LM.costsFor("binance", "crypto"), I, { atr: A });
    const neutral = LM.measureBracket({ ...row, m: 0 }, k, LM.costsFor("binance", "crypto"), I, { atr: A });
    const tooShort = LM.measureBracket(row, k.slice(0, sig + 2), LM.costsFor("binance", "crypto"), I, { atr: A * 50 });
    return [LM.OUTCOME_MODES?.includes("atr-bracket") && !!d && JSON.stringify(d) === JSON.stringify(e) && near(d.stopDistance, 2 * A) && neutral === null && tooShort === null, JSON.stringify(d)];
  });
}

console.log("WP19 CSV: v2.7 import, hostile values, round-trip");
{
  const safe = (v) => { // the kit's safeCell + quote, as the app's Export CSV writes cells
    if (v === null || v === undefined) return "";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
    const s = String(v); const g = /^[=+\-@\u0000-\u001F]/.test(s) ? `'${s}` : s;
    return /[",\r\n]/.test(g) ? `"${g.replace(/"/g, '""')}"` : g;
  };
  const t = Date.UTC(2026, 9, 1, 8);
  const row = { ...baseRow, id: `c1|binance|4h|BTCUSDT|${t}`, pair: "BTCUSDT", t, tc: t + 4 * H, rec: t + 4 * H + 5000, c: 61234.5, sc: 47.5, m: 1, st: 1, v: 17, bu: 9, be: 3, er: 0.412,
    bl: [55, -20, 10, 0], rd: -1, rc: 2, uc: 0, rku: 4, rks: "live", rs: 81.2, beta: 1.07, htf: 1, td: -0.12, mev: -6.5, bp: 0.031, pin: 0, spl: 0, earn: 0,
    vt: LM.packVotes?.([0, 0, 1, 2, 3, 0, 0, 2, 2, 1, 1, 2, 3, 0, 2, 0, 1, 2]) ?? 12345, pd: -1, pc: 2, fr: 0.0001, oiChg: -3.25 };
  const header = [...LEDGER_CSV_COLUMNS, "net_return_h1"];
  const csvOf = (cols, lines) => "﻿" + [cols.join(","), ...lines.map((l) => l.map(safe).join(","))].join("\r\n") + "\r\n";
  const v27Cols = LEDGER_CSV_COLUMNS.slice(0, LEDGER_CSV_COLUMNS.indexOf("engine_bars") + 1);
  check("CSV appends vote_vector, pattern_dir, pattern_conf, funding_rate, oi_change_pct after the v2.7 columns", () =>
    [v27Cols.length === 44 && LEDGER_CSV_COLUMNS.slice(44, 49).join() === "vote_vector,pattern_dir,pattern_conf,funding_rate,oi_change_pct" && ledgerRowValues(row).length === LEDGER_CSV_COLUMNS.length, LEDGER_CSV_COLUMNS.slice(44).join()]);
  check("v2.7 CSV imports with null new fields", () => {
    const v27 = csvOf([...v27Cols, "net_return_h1"], [[...ledgerRowValues(row).slice(0, 44), 0.0012]]);
    const imp = parseLedgerImport(v27);
    const got = imp.rows[0];
    return [imp.rows.length === 1 && imp.rejected === 0 && got.vt === null && got.pd === null && got.pc === null && got.fr === null && got.oiChg === null && got.sc === 47.5 && got.t === t && got.m === 1 && got.rku === 4 && got.bl.join() === "55,-20,10,0", JSON.stringify(imp)];
  });
  check("an old JSON/JSONL row (no new fields) imports with the new fields null too", () => {
    const { vt, pd, pc, fr, oiChg, ...old } = row;
    const got = sanitizeLedgerRow(old);
    return got && got.vt === null && got.pd === null && got.pc === null && got.fr === null && got.oiChg === null;
  });
  check("CSV round-trip (export → import) is lossless for every field", () => {
    const imp = parseLedgerImport(csvOf(header, [[...ledgerRowValues(row), ""]]));
    const want = sanitizeLedgerRow(row);
    return [imp.rows.length === 1 && JSON.stringify(imp.rows[0]) === JSON.stringify(want), `${JSON.stringify(imp.rows[0])}\n   want ${JSON.stringify(want)}`];
  });
  check("a ledger row of each new source round-trips through export and import", () => {
    const cases = [["okx", "BTCUSDT"], ["okx-perp", "BTCUSDT"], ["coinbase", "BTCUSD"], ["upbit", "BTCKRW"]];
    const bad = [];
    for (const [src, pair] of cases) {
      const r = { ...row, id: `c1|${src}|4h|${pair}|${t}`, src, pair };
      const imp = parseLedgerImport(csvOf(header, [[...ledgerRowValues(r), ""]]));
      const want = sanitizeLedgerRow(r);
      if (!(want && imp.rows.length === 1 && JSON.stringify(imp.rows[0]) === JSON.stringify(want) && imp.rows[0].src === src && imp.rows[0].pair === pair)) bad.push(src);
    }
    return [bad.length === 0, bad.join()];
  });
  check("hostile values rejected (vt > 4^18−1, pd 2, fr \"=1+1\")", () => {
    const vals = ledgerRowValues(row);
    const at = (col) => LEDGER_CSV_COLUMNS.indexOf(col);
    const bad = (col, v) => { const l = [...vals, ""]; l[at(col)] = v; return l; };
    const imp = parseLedgerImport(csvOf(header, [bad("vote_vector", 4 ** 18), bad("pattern_dir", 2), bad("funding_rate", "=1+1"), bad("oi_change_pct", "1e999"), bad("pattern_conf", "-1"), [...vals, ""]]));
    const json = [{ ...row, vt: 4 ** 18 }, { ...row, vt: -1 }, { ...row, vt: 2.5 }, { ...row, pd: 2 }, { ...row, pc: 4 }, { ...row, fr: "=1+1" }, { ...row, fr: 0.5 }, { ...row, oiChg: Infinity }].map((x) => sanitizeLedgerRow(x));
    return [imp.rows.length === 1 && imp.rejected === 5 && json.every((x) => x === null), `${imp.rows.length} ${imp.rejected} ${json.map((x) => x === null)}`];
  });
  check("CSV with a formula-like string field or a bad timestamp is rejected", () => {
    const vals = ledgerRowValues(row);
    const l1 = [...vals, ""]; l1[LEDGER_CSV_COLUMNS.indexOf("pair")] = "=HYPERLINK(1)";
    const l2 = [...vals, ""]; l2[LEDGER_CSV_COLUMNS.indexOf("bar_open_utc")] = "yesterday";
    const imp = parseLedgerImport(csvOf(header, [l1, l2]));
    return [imp.rows.length === 0 && imp.rejected === 2, JSON.stringify(imp)];
  });
}

console.log("WP21 ft: ledger field, CSV, catch-up no-look-ahead, benchmark");
{
  const DAY = 86_400_000;
  const t = Date.UTC(2026, 9, 1, 8);
  const safe = (v) => { if (v === null || v === undefined) return ""; if (typeof v === "number") return Number.isFinite(v) ? String(v) : ""; const g = /^[=+\-@\u0000-\u001F]/.test(String(v)) ? `'${v}` : String(v); return /[",\r\n]/.test(g) ? `"${g.replace(/"/g, '""')}"` : g; };
  const csvOf = (cols, lines) => "\uFEFF" + [cols.join(","), ...lines.map((l) => l.map(safe).join(","))].join("\r\n") + "\r\n";
  const row = { ...baseRow, id: `c1|binance|4h|BTCUSDT|${t}`, pair: "BTCUSDT", t, tc: t + 4 * H, rec: t + 4 * H, c: 61234.5, sc: 47.5, m: 1, st: 1, v: 17, bu: 9, be: 3, er: 0.4, bl: [55, -20, 10, 0], rd: 0, rc: 0, uc: 0, rku: 4, rks: "live", rs: 81.2, beta: 1.07, htf: 1, td: -0.12, mev: -6.5, bp: 0.031, pin: 0, spl: 0, earn: 0, vt: 12345, pd: -1, pc: 2, fr: 0.0001, oiChg: -3.25, ft: -37.3 };
  const header = [...LEDGER_CSV_COLUMNS, "net_return_h1"];
  const at = (col) => LEDGER_CSV_COLUMNS.indexOf(col);

  ok("fund_trend is the last CSV column and ft is exported", LEDGER_CSV_COLUMNS[LEDGER_CSV_COLUMNS.length - 1] === "fund_trend" && ledgerRowValues(row)[at("fund_trend")] === -37.3);
  {
    const imp = parseLedgerImport(csvOf(header, [[...ledgerRowValues(row), ""]]));
    ok("v2.8 CSV round-trips ft", imp.rows.length === 1 && imp.rows[0].ft === -37.3 && JSON.stringify(imp.rows[0]) === JSON.stringify(sanitizeLedgerRow(row)), JSON.stringify(imp));
    const nullFt = parseLedgerImport(csvOf(header, [[...ledgerRowValues({ ...row, ft: null }), ""]]));
    ok("an empty ft cell imports as null", nullFt.rows.length === 1 && nullFt.rows[0].ft === null);
  }
  {
    const v27Cols = LEDGER_CSV_COLUMNS.slice(0, at("engine_bars") + 1);
    const imp = parseLedgerImport(csvOf([...v27Cols, "net_return_h1"], [[...ledgerRowValues(row).slice(0, v27Cols.length), 0.0012]]));
    ok("a v2.7 CSV (no ft column) imports with ft null", imp.rows.length === 1 && imp.rejected === 0 && imp.rows[0].ft === null, JSON.stringify(imp));
    const v28Cols = LEDGER_CSV_COLUMNS.slice(0, at("fund_trend"));
    const imp2 = parseLedgerImport(csvOf(v28Cols, [ledgerRowValues(row).slice(0, v28Cols.length)]));
    ok("an earlier v2.8 CSV (no fund_trend column) imports with ft null", imp2.rows.length === 1 && imp2.rows[0].ft === null);
  }
  {
    const bad = (v) => { const l = [...ledgerRowValues(row), ""]; l[at("fund_trend")] = v; return l; };
    const imp = parseLedgerImport(csvOf(header, [bad(100.5), bad(-101), bad("=1+1"), bad("@SUM(1)"), bad("+5"), bad("\t5"), bad("abc"), bad("1e999"), bad(100), bad(-100), bad(0)]));
    ok("CSV ft outside -100..100 or formula-like is rejected (100, -100 and 0 kept)", imp.rows.length === 3 && imp.rejected === 8 && imp.rows.map((x) => x.ft).join() === "100,-100,0", `${imp.rows.length} ${imp.rejected}`);
    const json = [{ ...row, ft: 100.1 }, { ...row, ft: -100.1 }, { ...row, ft: "5" }, { ...row, ft: "=1+1" }, { ...row, ft: Infinity }, { ...row, ft: NaN }].map(sanitizeLedgerRow);
    ok("JSON ft out of range or not a number is rejected", json.every((x) => x === null));
    const { ft, ...old } = row;
    ok("a row without ft (v2.7 JSON) imports with ft null; a recorder row with ft 12.3 or null passes", sanitizeLedgerRow(old).ft === null && sanitizeLedgerRow({ ...row, ft: 12.3 }).ft === 12.3 && sanitizeLedgerRow({ ...row, ft: null }).ft === null);
  }

  // Catch-up: ft from the daily bars closed at or before each bar's own close.
  const D0 = Date.UTC(2025, 0, 1);
  const daily = []; { let c = 100; const rr = rng(77); for (let i = 0; i < 700; i++) { c *= Math.exp(0.0008 + (rr() - 0.5) * 0.06); daily.push({ time: D0 + i * DAY, open: c, high: c, low: c, close: c, volume: 1 }); } }
  const dayN = (i) => D0 + i * DAY;
  const mk = (pair, tOpen, ac = "crypto") => ({ ...baseRow, id: `c|binance|4h|${pair}|${tOpen}`, pair, ac, t: tOpen, tc: tOpen + 4 * H });
  {
    const rows = [mk("BTCUSDT", dayN(500) + 4 * H), mk("BTCUSDT", dayN(500) + 8 * H), mk("BTCUSDT", dayN(520) + 12 * H), mk("BTCUSDT", dayN(100)), mk("BTCUSDT", dayN(690) + 20 * H), mk("AAPLUSDT", dayN(520), "stock")];
    applyFundTrend(rows, (p) => (p === "BTCUSDT" ? daily : []));
    const want = (r) => { const v = fundTrend(daily, r.tc)?.value; return v === undefined ? null : Math.round(v * 10) / 10; };
    ok("catch-up rows carry ft from daily bars closed before each bar", rows.slice(0, 3).concat(rows[4]).every((r) => typeof r.ft === "number" && r.ft === want(r)), rows.map((r) => r.ft).join());
    ok("a catch-up row inside the first 366 days has ft null; non-crypto rows are not given one", rows[3].ft === null && rows[5].ft === undefined);
    ok("ft is rounded to 1 decimal", rows.every((r) => r.ft === null || r.ft === undefined || Math.abs(r.ft * 10 - Math.round(r.ft * 10)) < 1e-9));
    const early = rows.slice(0, 3).map((r) => r.ft);
    const rows2 = [mk("BTCUSDT", dayN(500) + 4 * H), mk("BTCUSDT", dayN(500) + 8 * H), mk("BTCUSDT", dayN(520) + 12 * H)];
    const last = daily[daily.length - 1];
    const bigLater = [...daily, { ...last, time: last.time + DAY, close: last.close * 9 }];
    applyFundTrend(rows2, () => bigLater);
    ok("a later daily bar does not change earlier catch-up rows (no look-ahead)", rows2.map((r) => r.ft).join() === early.join());
    const same = [mk("BTCUSDT", dayN(500) + 4 * H), mk("BTCUSDT", dayN(500) + 8 * H)];
    applyFundTrend(same, () => daily);
    {
      // M3: a stale cache (the feed halted) must not give old values to later rows: newest daily bar used must close <= 36 h before the row's close.
      const lastClose = daily[daily.length - 1].time + DAY; // 700 days of bars: the cache stops here
      const fresh = mk("BTCUSDT", lastClose - 4 * H - 4 * H); // closes just before the cache end: not stale
      const edge = mk("BTCUSDT", lastClose + 32 * H); // row closes exactly 36 h after the newest daily close
      const stale = mk("BTCUSDT", lastClose + 36 * H); // closes 40 h after
      applyFundTrend([fresh, edge, stale], () => daily);
      ok("a row closing more than 36 h after the newest daily close gets ft null; 36 h and fresh keep it", typeof fresh.ft === "number" && typeof edge.ft === "number" && stale.ft === null, [fresh.ft, edge.ft, stale.ft].join());
    }
    ok("two bars of the same day share one ft (daily bar of that day is not closed yet)", same[0].ft === same[1].ft);
  }

  // Benchmark: the sign of ft, same costs as momentum.
  {
    const kl = (() => { let c = 100; const rr = rng(5); return Array.from({ length: 1500 }, (_, i) => { const o = c; c *= Math.exp((rr() - 0.5) * 0.02); return { time: Date.UTC(2026, 0, 1) + i * 4 * H, open: o, high: Math.max(o, c) * 1.002, low: Math.min(o, c) * 0.998, close: c, volume: 1 }; }); })();
    const rows = []; const outs = new Map([[3, []]]);
    for (let i = 1020; i < 1380; i++) {
      const ftv = i % 7 === 0 ? null : i % 5 === 0 ? 0 : (i % 2 ? 30 : -30);
      const rw = { ...baseRow, pair: "ETHUSDT", id: `E${i}`, t: kl[i].time, tc: kl[i].time + 4 * H, c: kl[i].close, m: 0, sc: 0, st: 0, ft: ftv };
      rows.push(rw);
      const o = measureOutcome(rw, kl, 3, DEFAULT_COSTS.binance, 4 * H);
      if (o) outs.get(3).push(o);
    }
    const sgn = (rw) => (rw.ft ? (rw.ft > 0 ? 1 : -1) : 0);
    const rep = buildReport(rows, outs, 30, 1, 4 * H, { momentumOf: sgn, fundTrendOf: sgn, shuffles: 20 });
    const b = rep.horizons[0].benchmarks;
    ok("report fund-trend benchmark uses the sign of ft, charged the same costs as momentum", !!b.fundTrend && JSON.stringify(b.fundTrend) === JSON.stringify(b.momentum) && b.fundTrend.n > 0, JSON.stringify(b));
    const sparse = rows.map((x, i) => ({ ...x, ft: i % 60 === 0 ? 30 : i % 2 ? null : 0 }));
    const withRows = (rs) => { const byId = new Map(rs.map((x) => [x.id, x])); return new Map([[3, outs.get(3).map((o) => ({ ...o, row: byId.get(o.row.id) }))]]); };
    const excluded = buildReport(sparse, withRows(sparse), 30, 1, 4 * H, { fundTrendOf: sgn, shuffles: 20 }).horizons[0].benchmarks;
    const dense = rows.map((x) => ({ ...x, ft: 30 }));
    const allIn = buildReport(dense, withRows(dense), 30, 1, 4 * H, { fundTrendOf: sgn, shuffles: 20 }).horizons[0].benchmarks;
    ok("rows with ft null or 0 are excluded from n", excluded.fundTrend.n < allIn.fundTrend.n && excluded.momentum === null);
    ok("no fundTrendOf option gives a null fund-trend benchmark", buildReport(rows, outs, 30, 1, 4 * H, { shuffles: 20 }).horizons[0].benchmarks.fundTrend === null);
    const flip = buildReport(rows, outs, 30, 1, 4 * H, { fundTrendOf: (rw) => -sgn(rw), shuffles: 20 }).horizons[0].benchmarks.fundTrend;
    const plain = buildReport(rows, outs, 30, 1, 4 * H, { fundTrendOf: sgn, shuffles: 20 }).horizons[0].benchmarks.fundTrend;
    ok("the benchmark follows the sign: flipping it changes the result", flip.meanNetBps !== plain.meanNetBps);
  }
  ok("engine config id unchanged", engineConfigId() === "5c30b5c39f5ba3f2", engineConfigId());
}

console.log("\n== WP19 wording: spot SELL is 'long avoided' ==");
{
  ok("SELL groups on spot sources are long avoided", ["binance", "bybit-spot", "bitget", "coinsph"].every((src) => isSpotSellGroup("SELL · all", src) && isSpotSellGroup("SELL · strong", src)));
  ok("BUY groups are never long avoided", !isSpotSellGroup("BUY · all", "binance") && !isSpotSellGroup("BUY · strong", "bybit-spot"));
  ok("SELL groups on perpetual sources are real shorts", !isSpotSellGroup("SELL · all", "bybit-perp") && !isSpotSellGroup("SELL · strong", "bitget-perp"));
}

console.log(`\nMeasurement v2.3 suite: ${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
