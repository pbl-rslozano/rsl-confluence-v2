/**
 * analysis.mjs — the tool logic. Pure functions over a LedgerStore; the
 * statistics come from the app's own ledger-metrics.ts (loaded by
 * lib-loader.mjs), so numbers match the in-app Ledger dialog for the same
 * rows, candles, costs and engine id.
 */
import { tailLines } from "./readers.mjs";

/**
 * Bar lengths per timeframe. Mirrors INTERVAL_MS in web/src/lib/market-client.ts,
 * which cannot be imported here because that module performs network fetches.
 * test/interval-table.test.mjs fails if the two tables drift apart.
 */
export const INTERVAL_MS = Object.freeze({
  "1m": 60_000, "5m": 5 * 60_000, "15m": 15 * 60_000, "1h": 60 * 60_000, "4h": 4 * 60 * 60_000,
  "6h": 6 * 60 * 60_000, "8h": 8 * 60 * 60_000, "12h": 12 * 60 * 60_000, "1d": 86_400_000,
  "2d": 2 * 86_400_000, "4d": 4 * 86_400_000, "1w": 7 * 86_400_000, "1M": 30 * 86_400_000,
});

const DIR_NAME = { 1: "BUY", "-1": "SELL", 0: "NEUTRAL" };
const STRENGTH_NAME = ["weak", "moderate", "strong"];
const iso = (t) => (Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null);
const BENCHMARK_PAIRS = ["BTCUSDT", "BTCUSDC", "BTCUSD", "BTCPERP", "XBTUSD"];

/* ------------------------------------------------------------------ *
 *  Shared helpers
 * ------------------------------------------------------------------ */
/** Parse a date argument (ISO string, YYYY-MM-DD or epoch ms). `end` makes a bare date inclusive. */
export function parseDate(v, end = false) {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number") return v;
  const bare = /^\d{4}-\d{2}-\d{2}$/.test(v);
  const t = Date.parse(bare ? `${v}T00:00:00Z` : v);
  if (!Number.isFinite(t)) throw new RangeError(`Not a date: ${v}`);
  return bare && end ? t + 86_400_000 - 1 : t;
}

const asList = (v) => (v === undefined ? undefined : (Array.isArray(v) ? v : [v]));

/** Apply the common row filters. */
export function filterRows(rows, a = {}) {
  const from = parseDate(a.from);
  const to = parseDate(a.to, true);
  const pairs = asList(a.pair)?.map((p) => p.toUpperCase());
  const cfgs = asList(a.engine_id);
  const srcs = asList(a.source)?.map((s) => s.toLowerCase());
  const tfs = asList(a.timeframe);
  const acs = asList(a.asset_class);
  const dir = a.direction;
  const st = a.strength ? STRENGTH_NAME.indexOf(a.strength) : -1;
  const minSt = a.min_strength ? STRENGTH_NAME.indexOf(a.min_strength) : -1;
  return rows.filter((r) =>
    (!cfgs || cfgs.includes(r.cfg)) &&
    (!srcs || srcs.includes(r.src)) &&
    (!tfs || tfs.includes(r.tf)) &&
    (!pairs || pairs.includes(r.pair)) &&
    (!acs || acs.includes(r.ac)) &&
    (from === undefined || r.t >= from) &&
    (to === undefined || r.t <= to) &&
    (!dir || (dir === "DIRECTIONAL" ? r.m !== 0 : DIR_NAME[r.m] === dir)) &&
    (st < 0 || r.st === st) &&
    (minSt < 0 || r.st >= minSt) &&
    (a.min_score === undefined || r.sc >= a.min_score) &&
    (a.max_score === undefined || r.sc <= a.max_score) &&
    (a.live === undefined || (a.live ? r.live === 1 : r.live === 0)) &&
    (a.min_warm_bars === undefined || r.wb >= a.min_warm_bars) &&
    (!a.exclude_underlying_closed || !r.uc));
}

/** Compact, readable projection of a row. */
export function compactRow(r) {
  const out = {
    engine: r.cfg, src: r.src, tf: r.tf, pair: r.pair, ac: r.ac, bar: iso(r.t),
    score: r.sc, dir: DIR_NAME[r.m], strength: STRENGTH_NAME[r.st], close: r.c,
    warm: r.wb, live: r.live, uc: r.uc, sup: r.sup, rank: r.rk, er: r.er, blocs: r.bl,
    reversal: r.rd ? { dir: r.rd, conf: r.rc } : undefined,
  };
  if (r.beta !== undefined && r.beta !== null) out.beta = r.beta;
  if (r.rs !== undefined && r.rs !== null) out.rs = r.rs;
  if (r.rku !== undefined) out.rankUnfiltered = r.rku;
  if (r.xnet) out.exportedNet = r.xnet;
  return out;
}

/** JSON-safe numbers: NaN → null, ±Infinity → string, 5 significant digits. */
export function tidy(v) {
  if (typeof v === "number") {
    if (Number.isNaN(v)) return null;
    if (!Number.isFinite(v)) return v > 0 ? "Infinity" : "-Infinity";
    if (Number.isInteger(v)) return v;
    return Number(v.toPrecision(5));
  }
  if (Array.isArray(v)) return v.map(tidy);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = tidy(x);
    return o;
  }
  return v;
}

const countBy = (rows, f) => {
  const m = {};
  for (const r of rows) { const k = f(r); m[k] = (m[k] ?? 0) + 1; }
  return m;
};

function range(rows, f) {
  let lo = Infinity, hi = -Infinity;
  for (const r of rows) { const v = f(r); if (v > 0) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  return { from: Number.isFinite(lo) ? iso(lo) : null, to: Number.isFinite(hi) ? iso(hi) : null };
}

/* ------------------------------------------------------------------ *
 *  ledger_overview
 * ------------------------------------------------------------------ */
export function ledgerOverview(load, { warmMin, fullWarm }) {
  const { rows } = load;
  const engines = {};
  for (const r of rows) {
    const e = (engines[r.cfg] ??= { rows: 0, engineVersions: new Set(), sources: new Set(), timeframes: new Set(), classes: new Set(), lo: Infinity, hi: -Infinity, live: 0 });
    e.rows++; e.engineVersions.add(r.ev); e.sources.add(r.src); e.timeframes.add(r.tf); e.classes.add(r.ac);
    if (r.t < e.lo) e.lo = r.t; if (r.t > e.hi) e.hi = r.t; if (r.live) e.live++;
  }
  return {
    rows: rows.length,
    barRange: range(rows, (r) => r.t),
    recordedRange: range(rows, (r) => r.rec),
    engines: Object.fromEntries(Object.entries(engines).sort((a, b) => b[1].rows - a[1].rows).map(([cfg, e]) => [cfg, {
      rows: e.rows, engineVersions: [...e.engineVersions], sources: [...e.sources], timeframes: [...e.timeframes], assetClasses: [...e.classes],
      from: iso(e.lo), to: iso(e.hi), liveRows: e.live,
    }])),
    sources: countBy(rows, (r) => r.src),
    timeframes: countBy(rows, (r) => r.tf),
    assetClasses: countBy(rows, (r) => r.ac),
    pairs: new Set(rows.map((r) => r.pair)).size,
    direction: countBy(rows, (r) => DIR_NAME[r.m]),
    strength: countBy(rows, (r) => STRENGTH_NAME[r.st]),
    warmup: {
      thresholdBars: warmMin,
      warm: rows.filter((r) => r.wb >= warmMin).length,
      cold: rows.filter((r) => r.wb < warmMin).length,
      fullWindowBars: fullWarm,
      fullWindow: fullWarm ? rows.filter((r) => r.wb >= fullWarm).length : undefined,
    },
    underlyingClosed: rows.filter((r) => r.uc).length,
    suppressed: rows.filter((r) => r.sup).length,
    live: rows.filter((r) => r.live).length,
    replay: rows.filter((r) => !r.live).length,
    files: load.files,
    duplicateIds: load.duplicates,
    invalidLines: load.invalid,
    truncated: load.truncated,
    note: "Statistics never pool engine ids: use performance_report per engine id.",
  };
}

/* ------------------------------------------------------------------ *
 *  query_ledger / latest_signals
 * ------------------------------------------------------------------ */
export function queryLedger(load, a) {
  const matched = filterRows(load.rows, a);
  matched.sort((x, y) => (a.order === "oldest" ? x.t - y.t : y.t - x.t) || (x.pair < y.pair ? -1 : 1));
  const limit = a.limit ?? 50;
  const rows = matched.slice(0, limit).map((r) => (a.full ? r : compactRow(r)));
  return { matched: matched.length, returned: rows.length, order: a.order ?? "newest", rows };
}

export function latestSignals(load, a) {
  const rows = filterRows(load.rows, { ...a, direction: undefined });
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.cfg}|${r.src}|${r.tf}`;
    const g = groups.get(key);
    if (!g || r.t > g.t) groups.set(key, { t: r.t, cfg: r.cfg, src: r.src, tf: r.tf });
  }
  const directionalOnly = a.directional_only ?? true;
  const perGroup = a.limit ?? 30;
  const out = [...groups.values()].sort((x, y) => y.t - x.t).slice(0, a.max_groups ?? 6).map((g) => {
    const bar = rows.filter((r) => r.cfg === g.cfg && r.src === g.src && r.tf === g.tf && r.t === g.t);
    const shown = bar.filter((r) => !directionalOnly || r.m !== 0)
      .sort((x, y) => y.st - x.st || Math.abs(y.sc) - Math.abs(x.sc) || (x.pair < y.pair ? -1 : 1));
    return {
      engine: g.cfg, source: g.src, timeframe: g.tf, bar: iso(g.t),
      barAgeHours: Math.round(((Date.now() - g.t) / 3_600_000) * 10) / 10,
      rowsAtBar: bar.length, directional: bar.filter((r) => r.m !== 0).length, strong: bar.filter((r) => r.st === 2 && r.m !== 0).length,
      rows: shown.slice(0, perGroup).map(compactRow),
    };
  });
  return { groups: out, note: "Newest recorded bar per engine × source × timeframe; strong signals first. A signal is formed on the bar close; outcomes are measured from the next bar's open." };
}

/* ------------------------------------------------------------------ *
 *  performance_report
 * ------------------------------------------------------------------ */
function indexByTime(k) {
  const m = new Map();
  for (let i = 0; i < k.length; i++) m.set(k[i].time, i);
  return m;
}

/** Rolling beta of the pair's 1-bar returns to BTC over `n` bars ending at bar i (no look-ahead). */
function rollingBeta(k, i, btc, btcIdx, n = 100) {
  if (i < n) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
  for (let j = i - n + 1; j <= i; j++) {
    const a = btcIdx.get(k[j].time);
    const b = btcIdx.get(k[j - 1].time);
    if (a === undefined || b === undefined) continue;
    const x = btc[a].close / btc[b].close - 1;
    const y = k[j].close / k[j - 1].close - 1;
    sx += x; sy += y; sxx += x * x; sxy += x * y; m++;
  }
  if (m < n * 0.8) return null;
  const vx = sxx / m - (sx / m) ** 2;
  return vx > 0 ? (sxy / m - (sx / m) * (sy / m)) / vx : null;
}

const meanOf = (x) => (x.length ? x.reduce((s, v) => s + v, 0) / x.length : NaN);
function sdOf(x) {
  if (x.length < 2) return NaN;
  const m = meanOf(x);
  return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1));
}

/** The app's indicative gate (ledger-dialog.tsx), recomputed for one horizon. */
export function indicativeGate(h, costBps) {
  const dirGroups = h.groups.filter((g) => g.label.endsWith("all"));
  const n = dirGroups.reduce((s, g) => s + g.n, 0);
  const edge = dirGroups.length ? dirGroups.reduce((s, g) => s + g.edgeBps * g.n, 0) / Math.max(1, n) : NaN;
  const checks = {
    measuredDirectional_ge_200: { ok: n >= 200, value: n },
    edgeAfterCosts_gt_0: { ok: Number.isFinite(edge) && edge > 0, value: edge },
    edgeAt2xCosts_gt_0: { ok: Number.isFinite(edge) && edge - costBps > 0, value: edge - costBps },
    rankIcT_ge_2: { ok: h.ic.tStat >= 2, value: h.ic.tStat },
    psr_ge_0_95: { ok: h.sharpe.psr >= 0.95, value: h.sharpe.psr },
  };
  return { pass: Object.values(checks).every((c) => c.ok), checks };
}

/**
 * Per engine × source × timeframe (× asset class unless by_class = false)
 * report. Engines are never pooled.
 */
export function performanceReport(load, store, libInfo, a, trialsInfo) {
  const { lib, features } = libInfo;
  const rows = filterRows(load.rows, { ...a, direction: undefined, strength: undefined, min_strength: undefined, min_warm_bars: undefined });
  const byClass = a.by_class ?? true;
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.cfg}|${r.src}|${r.tf}|${byClass ? r.ac : "all"}`;
    const g = groups.get(key);
    if (g) g.push(r); else groups.set(key, [r]);
  }
  const horizons = (a.horizons ?? lib.DEFAULT_HORIZONS).filter((h) => lib.DEFAULT_HORIZONS.includes(h));
  // Same primary rule as the app (v2.3 review S13): full 1,000-bar window on the bars the engine really saw.
  const warmMin = a.min_warm_bars ?? lib.PRIMARY_WARM_BARS ?? lib.WARM_MIN_BARS;
  const barsOf = (r) => r.eb ?? r.wb;
  const trials = a.trials ?? Math.max(1, trialsInfo.hypotheses);
  const maxGroups = a.max_groups ?? 8;
  const candleIdx = store.candleIndex();
  const ordered = [...groups.entries()].sort((x, y) => y[1].length - x[1].length);
  const reports = [];
  for (const [key, list] of ordered.slice(0, maxGroups)) {
    const [cfg, src, tf, ac] = key.split("|");
    const intervalMs = INTERVAL_MS[tf];
    if (!intervalMs) { reports.push({ engine: cfg, source: src, timeframe: tf, assetClass: ac, error: `Unknown timeframe ${tf}` }); continue; }
    const base = typeof lib.costsFor === "function" ? lib.costsFor(src, ac === "all" ? "crypto" : ac) : (lib.DEFAULT_COSTS[src] ?? lib.DEFAULT_COSTS.binance);
    const costs = { feeBps: a.fee_bps ?? base.feeBps, slipBps: a.slippage_bps ?? base.slipBps, fundingBpsPer8h: a.funding_bps_per_8h ?? base.fundingBpsPer8h };
    const costBps = 2 * (costs.feeBps + costs.slipBps);
    const usable = list.filter((r) => barsOf(r) >= warmMin && !r.uc);

    // Benchmark (BTC) series on the same source and timeframe, when cached.
    let btcPair = null;
    let btc = [];
    for (const p of a.benchmark_pair ? [a.benchmark_pair.toUpperCase()] : BENCHMARK_PAIRS) {
      const k = store.candles(candleIdx.index, src, tf, p);
      if (k.length) { btcPair = p; btc = k; break; }
    }
    const btcIdx = indexByTime(btc);

    const byPair = new Map();
    for (const r of usable) { const l = byPair.get(r.pair); if (l) l.push(r); else byPair.set(r.pair, [r]); }
    const outcomes = new Map(horizons.map((h) => [h, []]));
    const seriesOf = new Map();
    const noCandles = [];
    const betaOf = new Map();
    for (const [pair, rs] of byPair) {
      const k = pair === btcPair ? btc : store.candles(candleIdx.index, src, tf, pair);
      if (!k.length) { noCandles.push(pair); continue; }
      const idx = indexByTime(k);
      seriesOf.set(pair, { k, idx });
      for (const r of rs) {
        const i = idx.get(r.t);
        if (btc.length && pair !== btcPair && i !== undefined) {
          betaOf.set(r.id, Number.isFinite(r.beta) ? r.beta : rollingBeta(k, i, btc, btcIdx));
        }
        for (const h of horizons) {
          const o = lib.measureOutcome(r, k, h, costs, intervalMs);
          if (!o) continue;
          if (btc.length && i !== undefined) {
            const e = btcIdx.get(k[i + 1].time);
            const x = btcIdx.get(k[i + h].time);
            if (e !== undefined && x !== undefined && btc[e].open > 0) o.btcGross = btc[x].close / btc[e].open - 1;
          }
          outcomes.get(h).push(o);
        }
      }
    }
    const momentumOf = (row) => {
      const s = seriesOf.get(row.pair);
      const i = s?.idx.get(row.t);
      if (i === undefined || i < 20) return 0;
      const ret = s.k[i].close / s.k[i - 20].close - 1;
      return ret > 0 ? 1 : ret < 0 ? -1 : 0;
    };
    const rep = lib.buildReport(usable, outcomes, costBps, trials, intervalMs, { momentumOf, shuffles: a.shuffles ?? 200 });

    const perHorizon = rep.horizons.map((h) => {
      const outs = outcomes.get(h.horizon).filter((o) => !o.row.sup);
      let excess = null;
      if (btc.length) {
        const withBtc = outs.filter((o) => o.btcGross !== undefined && o.row.pair !== btcPair);
        const side = (dir, label) => {
          const thin = lib.thinNonOverlapping(withBtc.filter((o) => o.row.m === dir), h.horizon, intervalMs);
          const ex = thin.map((o) => o.net - dir * o.btcGross);
          const wins = ex.filter((v) => v > 0).length;
          return { label, n: ex.length, meanExcessNetBps: meanOf(ex) * 1e4, hitRate: ex.length ? wins / ex.length : NaN, hitCi95: features.wilson ? lib.wilson(wins, ex.length) : undefined };
        };
        // Beta-residual rank IC: score vs (gross − β·BTC gross), cross-sections ≥ h bars apart, ≥ 5 pairs.
        const sections = new Map();
        for (const o of withBtc) {
          const b = betaOf.get(o.row.id);
          if (!Number.isFinite(b)) continue;
          const l = sections.get(o.row.t);
          const item = { sc: o.row.sc, res: o.gross - b * o.btcGross };
          if (l) l.push(item); else sections.set(o.row.t, [item]);
        }
        const ics = [];
        let next = -Infinity;
        for (const t of [...sections.keys()].sort((x, y) => x - y)) {
          const l = sections.get(t);
          if (l.length < 5 || t < next) continue;
          const ic = lib.spearman(l.map((x) => x.sc), l.map((x) => x.res));
          if (Number.isFinite(ic)) { ics.push(ic); next = t + h.horizon * intervalMs; }
        }
        const sd = sdOf(ics);
        excess = {
          benchmark: btcPair,
          buy: side(1, "BUY · all"),
          sell: side(-1, "SELL · all"),
          betaResidualIc: { mean: meanOf(ics), tStat: sd > 0 ? (meanOf(ics) / sd) * Math.sqrt(ics.length) : NaN, periods: ics.length, beta: "row.beta when recorded, else rolling 100-bar beta from cached candles up to the signal bar" },
          note: "A plain BTC-excess rank IC equals the raw rank IC (subtracting one number from a whole cross-section does not change ranks); the beta-residual IC is the informative version.",
        };
      }
      return { ...h, gate: indicativeGate(h, costBps), btcExcess: excess };
    });

    reports.push({
      engine: cfg, source: src, timeframe: tf, assetClass: ac,
      costs: { ...costs, roundTripBps: costBps, assumed: a.fee_bps === undefined && a.slippage_bps === undefined && a.funding_bps_per_8h === undefined ? "app defaults (costsFor: source + asset-class slippage)" : "overridden" },
      rows: list.length,
      usable: usable.length,
      excluded: { coldWarmup: list.filter((r) => barsOf(r) < warmMin).length, underlyingClosed: list.filter((r) => barsOf(r) >= warmMin && r.uc).length, minWarmBars: warmMin },
      pairsWithoutCandles: noCandles,
      benchmark: btcPair ?? "none cached (no BTC-excess figures)",
      report: { ...rep, from: iso(rep.from), to: iso(rep.to), horizons: perHorizon },
    });
  }
  return tidy({
    groups: reports,
    groupsTotal: groups.size,
    groupsShown: reports.length,
    trialsForDsr: { used: trials, source: a.trials !== undefined ? "argument" : `trials.jsonl hypotheses (${trialsInfo.hypotheses})` },
    library: libInfo.path.split(/[\\/]/).slice(-4).join("/"),
    candles: { files: candleIdx.files, series: candleIdx.index.size, unreadable: candleIdx.unreadable, tooLarge: candleIdx.tooLarge },
    method: "Same code as the app (buildReport / measureOutcome): entry next-bar open, exit close of t+h, net of 2×(fee+slippage) and funding; non-overlapping outcomes per series; PSR on h-bar block returns; rank IC on cross-sections ≥ h bars apart. Gate = the app's indicative gate; passing it is evidence, not proof.",
  });
}

/* ------------------------------------------------------------------ *
 *  recorder_health
 * ------------------------------------------------------------------ */
const TIME_KEYS = ["at", "t", "ts", "time", "updatedAt", "updated", "lastBeat", "lastRun", "lastScan", "now"];
const ERROR_KEYS = ["errors", "lastErrors", "recentErrors", "lastError", "error"];

function toMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v;
  if (typeof v === "string") { const p = Date.parse(v); return Number.isFinite(p) ? p : null; }
  return null;
}

/** Depth/size-limited copy of an unknown JSON value. */
function bounded(v, depth = 0) {
  if (typeof v === "string") return v.length > 500 ? `${v.slice(0, 500)}…` : v;
  if (Array.isArray(v)) return depth > 4 ? "[…]" : v.slice(0, 20).map((x) => bounded(x, depth + 1));
  if (v && typeof v === "object") {
    if (depth > 4) return "{…}";
    const o = {};
    for (const [k, x] of Object.entries(v).slice(0, 40)) o[k] = bounded(x, depth + 1);
    return o;
  }
  return v;
}

export function recorderHealth(dataDir, a = {}, now = Date.now()) {
  const out = { dataDir: "(configured data directory)", checkedAt: iso(now) };
  const hb = dataDir.statFile("heartbeat.json");
  if (!hb) {
    out.heartbeat = { present: false };
  } else {
    let doc = null;
    let parseError = null;
    try { doc = JSON.parse(dataDir.readText("heartbeat.json", dataDir.limits.maxHeartbeatBytes)); } catch (e) { parseError = e.message; }
    let beat = null;
    if (doc && typeof doc === "object") for (const k of TIME_KEYS) { const v = toMs(doc[k]); if (v) { beat = v; break; } }
    const source = beat ? "heartbeat field" : "file modification time";
    beat ??= hb.mtimeMs;
    const intervalMs = doc ? [doc.intervalMs, doc.everyMs, doc.periodMs].find((v) => typeof v === "number" && v > 0) : undefined;
    const staleAfter = a.stale_after_minutes !== undefined ? a.stale_after_minutes * 60_000 : intervalMs ? 3 * intervalMs : 30 * 60_000;
    const age = now - beat;
    let errors = [];
    if (doc && typeof doc === "object") for (const k of ERROR_KEYS) if (doc[k]) { errors = Array.isArray(doc[k]) ? doc[k] : [doc[k]]; break; }
    out.heartbeat = {
      present: true, lastBeat: iso(beat), timeSource: source, ageMinutes: Math.round(age / 6000) / 10,
      staleAfterMinutes: Math.round(staleAfter / 6000) / 10, status: parseError ? "unreadable" : age <= staleAfter ? "ok" : "stale",
      lastErrors: bounded(errors.slice(-20)), parseError: parseError ?? undefined, content: bounded(doc),
    };
  }
  const newest = (sub) => {
    const { files } = dataDir.walk(sub, (n) => /\.jsonl$/i.test(n), { maxDepth: 1 });
    if (!files.length) return { files: 0 };
    files.sort((x, y) => (x.rel < y.rel ? -1 : 1));
    const last = files[files.length - 1];
    // Newest time among the last records of the newest file (lines are appended, not sorted).
    let t = null;
    try {
      for (const line of tailLines(last.abs)) {
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        const v = rec && typeof rec === "object" ? toMs(rec.rec) ?? toMs(rec.t) ?? toMs(rec.ts) ?? toMs(rec.time) : null;
        if (v && (t === null || v > t)) t = v;
      }
    } catch { t = null; }
    return { files: files.length, newestFile: last.rel, newestFileBytes: last.size, newestRecordTime: iso(t), newestRecordAgeMinutes: t ? Math.round((now - t) / 6000) / 10 : null, fileModified: iso(last.mtimeMs) };
  };
  out.ledger = newest("ledger");
  out.rankings = newest("rankings");
  out.derivs = newest("derivs");
  const candles = dataDir.walk("candles", (n) => /\.jsonl?$/i.test(n));
  out.candles = { files: candles.files.length, truncated: candles.truncated, newestModified: iso(Math.max(0, ...candles.files.map((f) => f.mtimeMs))) };
  out.overall = !hb ? "no heartbeat.json — recorder not running here, or not yet started" : out.heartbeat.status;
  return out;
}
