// replay.cli.mjs — v2.3 history replay / backtest for the Confluence engine.
//
//   pnpm --filter @rsl/confluence-web replay -- --symbols BTCUSDT,ETHUSDT --tf 4h --from 2024-01-01
//   pnpm --filter @rsl/confluence-web replay -- --csv-dir ./binance-klines --tf 1d --from 2023-01-01
//
// Replays CLOSED bars through exactly the same scoring path the app uses live
// (scan-pipeline.scoreSeries, fixed ENGINE_BARS window), so a replayed row and
// a live ledger row for the same bar are identical. Outcomes use the
// ledger-metrics rules (next-bar-open entry, costs, funding on perps). Reports
// in-sample vs out-of-sample, and a 20-bar momentum baseline the engine must beat.
//
// Data: the exchange's public history endpoints (network), or Binance public
// data dumps (data.binance.vision CSVs, spot timestamps in µs since 2025).
//
// v2.3: every run appends to <out>/../trials.jsonl (or --trials-file) so the
// deflated Sharpe counts every configuration tried; PBO via CSCV over the
// variant grid (horizon × strength filter); label-shuffle and momentum
// benchmarks; BTC-excess when BTCUSDT is in the set; per-class costs; logged
// context fields (beta, HTF trend, taker delta, macro-event distance).
//
// Biases this tool does NOT remove — read docs/measurement.md:
//   • survivorship: symbols you pass are today's survivors (use
//     tools/fetch-binance-archive.mjs, which also lists delisted symbols);
//   • universe look-ahead: rank/qv are 0 in replay (no historical top-N);
//   • slippage is a per-class placeholder, not measured depth.
import { normalizeScoringProfile } from "./scoring-profile.ts";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { scoreSeries, toLedgerRow } from "./scan-pipeline.ts";
import { enrich } from "./enrichment.ts";
import { scoreV2, v2Compact, v2ConfigId } from "./confluence-v2.ts";
import { asV2Row, labelChurn, sideOf, splitByV2 } from "./head-to-head.ts";
import { ENGINE_BARS, engineConfigId, ENGINE_VERSION } from "./engine-config.ts";
import { barCloseTime, contiguousTail, fetchHistoryRange, INTERVAL_MS, loadInstrumentTypes } from "./market-client.ts";
import { hashId } from "./signal-ledger.ts";
import { splitPair } from "./quotes.ts";
import { barWhileClosed, classifySymbol } from "./asset-classes.ts";
import {
  buildReport, costsFor, DEFAULT_COSTS, DEFAULT_HORIZONS, LEDGER_CSV_COLUMNS, ledgerRowValues, measureOutcome, pbo, WARM_MIN_BARS,
  measureBracket, OUTCOME_MODES, summarizeBrackets,
} from "./ledger-metrics.ts";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]);
    return acc;
  }, []),
);
if (args.help || args.h) {
  console.log(`Options:
  --source binance|bybit-spot|bybit-perp|bitget|bitget-perp|okx|okx-perp|coinbase|upbit   (default binance)
  --symbols BTCUSDT,ETHUSDT                       (or --csv-dir)
  --csv-dir <folder>                              Binance kline CSVs named SYMBOL-INTERVAL-*.csv
  --tf 4h                                         timeframe (default 4h)
  --from 2024-01-01  --to 2026-10-01              evaluation window (UTC)
  --oos 2025-07-01                                out-of-sample start (default: last 30 %)
  --fee-bps 10 --slip-bps 5 --funding-bps 0       one-way costs (default: per source)
  --trials N                                      override the trial count (default: trials.jsonl register)
  --trials-file <path>                            trial register (default: <out>/../trials.jsonl)
  --min-bars 1000                                 primary statistics on full windows (300 = warm)
  --step 1                                        score every Nth bar (speed)
  --profile <file>                               exported scoring profile
  --outcome horizon|atr-bracket                   v2.8: atr-bracket adds the paper bracket (2×ATR stop, 2R target,
                                                  stop first, gap at the open) — R per trade, as ADR-0010 gate 3 compares
  --no-v2                                         v2.8 (WP23): leave the four Confluence v2 columns empty (default: every row also
                                                  records Confluence v2, scored on the same window with the same code as the app;
                                                  logged, never scored)
  --out ./replay-out                              output folder`);
  process.exit(0);
}

const profile = args.profile ? normalizeScoringProfile(JSON.parse(readFileSync(resolve(args.profile), "utf8"))) : null;
const source = args.source ?? "binance";
const tf = args.tf ?? "4h";
const intervalMs = INTERVAL_MS[tf];
if (!intervalMs) throw new Error(`Unknown timeframe ${tf}`);
const from = Date.parse(args.from ?? "2024-01-01T00:00:00Z");
const to = args.to ? Date.parse(args.to) : Date.now();
const oos = args.oos ? Date.parse(args.oos) : from + (to - from) * 0.7;
const base = DEFAULT_COSTS[source] ?? DEFAULT_COSTS.binance;
const costs = {
  feeBps: Number(args["fee-bps"] ?? base.feeBps),
  slipBps: Number(args["slip-bps"] ?? base.slipBps),
  fundingBpsPer8h: Number(args["funding-bps"] ?? base.fundingBpsPer8h),
};
const costBps = 2 * (costs.feeBps + costs.slipBps);
const step = Math.max(1, Number(args.step ?? 1));
const outDir = resolve(args.out ?? "replay-out");
const minBars = Math.max(WARM_MIN_BARS, Number(args["min-bars"] ?? ENGINE_BARS));
const noV2 = args["no-v2"] !== undefined && args["no-v2"] !== "false";
const outcomeMode = args.outcome ?? "horizon";
if (!OUTCOME_MODES.includes(outcomeMode)) throw new Error(`Unknown --outcome ${outcomeMode} (${OUTCOME_MODES.join(", ")})`);
const explicitCosts = args["fee-bps"] !== undefined || args["slip-bps"] !== undefined || args["funding-bps"] !== undefined;
/** Per-class (and, v2.8, per-quote-market) costs unless the caller fixed them on the command line. */
const costsOf = (ac, pair) => (explicitCosts ? costs : costsFor(source, ac, undefined, pair ? splitPair(pair, source).quote : undefined));

// Trials register (one JSON line per distinct configuration ever run).
const trialsFile = resolve(args["trials-file"] ?? join(dirname(outDir), "trials.jsonl"));
const variantKey = `${engineConfigId(profile)}|${source}|${tf}|${args.from ?? ""}|${args.to ?? ""}|${costs.feeBps}/${costs.slipBps}/${costs.fundingBpsPer8h}|${minBars}|${step}`;
const known = existsSync(trialsFile) ? readFileSync(trialsFile, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
// One record schema for app, replay and MCP (review C12): { id, at, cfg, variant }.
// The count is the number of DISTINCT variants over every engine config.
if (!known.some((k) => k.variant === variantKey)) {
  mkdirSync(dirname(trialsFile), { recursive: true });
  const rec = { id: `replay-${hashId(variantKey)}`, at: new Date().toISOString(), cfg: engineConfigId(profile), variant: variantKey };
  appendFileSync(trialsFile, JSON.stringify(rec) + "\n");
  known.push(rec);
}
const distinctVariants = new Set(known.filter((k) => k && typeof k.variant === "string").map((k) => k.variant)).size;
const trials = Math.max(1, Number(args.trials ?? distinctVariants));

/* ---------------- data ---------------- */
function readCsvDir(dir) {
  const bySymbol = new Map();
  // data.binance.vision names files SYMBOL-INTERVAL-YYYY-MM(.csv); only files of
  // the requested interval are read, so 1h and 4h dumps are never merged.
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".csv"))) {
    const [symRaw, fileTf] = f.split("-");
    if (fileTf && fileTf !== tf) continue;
    const symbol = symRaw.toUpperCase();
    const rows = readFileSync(join(dir, f), "utf8").trim().split(/\r?\n/);
    const list = bySymbol.get(symbol) ?? [];
    for (const line of rows) {
      const c = line.split(",");
      let t = Number(c[0]);
      if (!Number.isFinite(t)) continue; // header
      if (t > 1e14) t = Math.floor(t / 1000); // µs (Binance spot since 2025) → ms
      list.push({ time: t, open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5] });
    }
    bySymbol.set(symbol, list);
  }
  for (const [s, list] of bySymbol) {
    const m = new Map(list.map((b) => [b.time, b]));
    bySymbol.set(s, [...m.values()].sort((a, b) => a.time - b.time));
  }
  return bySymbol;
}

async function loadSeries() {
  if (args["csv-dir"]) return readCsvDir(resolve(args["csv-dir"]));
  const symbols = String(args.symbols ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length) throw new Error("Pass --symbols or --csv-dir (see --help).");
  const out = new Map();
  for (const symbol of symbols) {
    process.stdout.write(`fetching ${symbol} ${tf}… `);
    const k = await fetchHistoryRange(source, symbol, tf, from - ENGINE_BARS * intervalMs, to);
    console.log(`${k.length} bars`);
    out.set(symbol, k);
  }
  return out;
}

/* ---------------- replay ---------------- */
function momentumRow(row, k, i) {
  const back = 20;
  if (i < back) return null;
  const ret = k[i].close / k[i - back].close - 1;
  const m = ret > 0 ? 1 : ret < 0 ? -1 : 0;
  return { ...row, id: row.id.replace(row.cfg, "momentum20"), cfg: "momentum20", sc: Math.max(-100, Math.min(100, Math.round(ret * 1000))), m, st: 1 };
}

const series = await loadSeries();
// Same classification inputs as live (review C11): Bybit venue types when reachable.
const venueTypes = args["csv-dir"] ? null : await loadInstrumentTypes(source).catch(() => null);
const btcSeries = series.get("BTCUSDT");
const rows = [];
const baseline = [];
const started = Date.now();
for (const [pair, k] of series) {
  const ac = classifySymbol(source, pair, venueTypes?.get(pair));
  for (let i = 0; i < k.length; i += step) {
    const t = k[i].time;
    if (t < from || t > to) continue;
    // Same rule as the live scan: never score across a hole (contiguousTail).
    const window = contiguousTail(k.slice(Math.max(0, i - ENGINE_BARS + 1), i + 1), intervalMs);
    const cls = ac === "excluded" ? "crypto" : ac;
    const s = scoreSeries(window, { intervalMs, volumeAvailable: true, assetClass: cls, profile });
    if (!s.usable) continue;
    const row = toLedgerRow(window, s, {
      src: source, tf, pair, ac: cls, intervalMs,
      closeTime: barCloseTime(t, intervalMs), rank: 0, quoteVolume: 0, appVersion: "replay", live: false,
      recordedAt: barCloseTime(t, intervalMs),
      underlyingClosed: ac !== "excluded" && barWhileClosed(ac, t, intervalMs),
      rankSource: "none",
    });
    if (!row) continue;
    Object.assign(row, enrich(row, window, { intervalMs, btc: btcSeries, rs: null, split: s.split }));
    // v2.8 (WP23): Confluence v2 on the same window (never a profile), logged beside Classic and never scored.
    if (!noV2) {
      let v2 = null;
      try { v2 = v2Compact(scoreV2(window, { intervalMs, volumeAvailable: true, assetClass: cls }), row.t); } catch { /* v2 is logged only: a fault leaves the Classic row as it was */ }
      if (v2) row.v2 = v2;
    }
    rows.push(row);
    const b = momentumRow(row, k, i);
    if (b) baseline.push(b);
  }
  console.log(`${pair}: ${rows.filter((r) => r.pair === pair).length} rows scored`);
}

const momentumSign = new Map();
for (const [pair, k] of series) {
  for (let i = 20; i < k.length; i++) {
    const ret = k[i].close / k[i - 20].close - 1;
    momentumSign.set(`${pair}|${k[i].time}`, ret > 0 ? 1 : ret < 0 ? -1 : 0);
  }
}
function outcomesOf(list) {
  const warm = list.filter((r) => (r.eb ?? r.wb) >= minBars && !r.uc);
  const outcomes = new Map(DEFAULT_HORIZONS.map((h) => [h, []]));
  for (const r of warm) {
    const k = series.get(r.pair);
    const c = costsOf(r.ac, r.pair);
    for (const h of DEFAULT_HORIZONS) {
      const o = measureOutcome(r, k, h, c, intervalMs);
      if (!o) continue;
      if (btcSeries && r.pair !== "BTCUSDT") {
        const b = measureOutcome({ ...r, pair: "BTCUSDT", m: 1 }, btcSeries, h, c, intervalMs);
        if (b) o.btcGross = b.gross;
      }
      outcomes.get(h).push(o);
    }
  }
  return { warm, outcomes };
}
function measure(list) {
  const { warm, outcomes } = outcomesOf(list);
  return buildReport(warm, outcomes, costBps, trials, intervalMs, { momentumOf: (r) => momentumSign.get(`${r.pair}|${r.t}`) ?? 0 });
}

/**
 * PBO (CSCV) over the variant grid horizon × {all, strong}: per calendar
 * period (one per longest horizon), each variant's mean net return of its
 * directional signals. A high PBO means the best-looking variant in-sample
 * tends to be below median out-of-sample — i.e. the choice is overfit.
 */
function pboOf(list) {
  const { outcomes } = outcomesOf(list);
  const variants = [];
  for (const h of DEFAULT_HORIZONS) for (const strong of [false, true]) variants.push({ h, strong });
  const period = (Math.max(...DEFAULT_HORIZONS) + 1) * intervalMs;
  const cells = new Map();
  variants.forEach((v, k) => {
    for (const o of outcomes.get(v.h)) {
      if (o.row.m === 0 || (v.strong && o.row.st !== 2)) continue;
      const p = Math.floor(o.row.t / period);
      const row = cells.get(p) ?? variants.map(() => ({ s: 0, n: 0 }));
      row[k].s += o.net / v.h; row[k].n += 1; // per bar held, so horizons are comparable
      cells.set(p, row);
    }
  });
  // Empty cells are not returns (review S7): drop variants active in < 50 % of
  // periods, then keep only periods where every remaining variant traded.
  const periodsAll = [...cells.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
  const keep = variants.map((_, k) => periodsAll.filter((row) => row[k].n > 0).length >= 0.5 * periodsAll.length);
  const kept = variants.map((v, k) => ({ v, k })).filter(({ k }) => keep[k]);
  const matrix = periodsAll.filter((row) => kept.every(({ k }) => row[k].n > 0)).map((row) => kept.map(({ k }) => row[k].s / row[k].n));
  const columns = kept.map(({ v, k }, j) => {
    const col = matrix.map((row) => row[j]);
    const active = [...cells.values()].filter((row) => row[k].n > 0).length;
    const mu = col.reduce((a, x) => a + x, 0) / Math.max(1, col.length);
    const sd = Math.sqrt(col.reduce((a, x) => a + (x - mu) ** 2, 0) / Math.max(1, col.length - 1));
    return { variant: `h${v.h}${v.strong ? "·strong" : ""}`, activePeriods: active, meanPerBarBps: mu * 1e4, sharpe: sd > 0 ? mu / sd : null };
  });
  const dropped = variants.filter((_, k) => !keep[k]).map((v) => `h${v.h}${v.strong ? "·strong" : ""}`);
  return { ...pbo(matrix, 8), periods: matrix.length, variants: columns.map((c) => c.variant), columns, dropped };
}
// Embargo: an in-sample row whose longest horizon ends after --oos would be
// measured on out-of-sample prices, so it is dropped from the in-sample set.
const maxH = Math.max(...DEFAULT_HORIZONS);
const split = (list) => [list.filter((r) => r.t + (maxH + 1) * intervalMs < oos), list.filter((r) => r.t >= oos)];
const [inS, outS] = split(rows);
const [bIn, bOut] = split(baseline);
const reports = {
  engine: { inSample: measure(inS), outOfSample: measure(outS) },
  momentum20: { inSample: measure(bIn), outOfSample: measure(bOut) },
};
const overfit = pboOf(rows);

// v2.8 (WP19): outcome mode "atr-bracket" — the same bracket the paper book uses, in R.
function bracketsOf(list) {
  const outs = [];
  // ATR(14) on the engine window ending at each signal bar (measureBracket's default).
  for (const r of list.filter((x) => (x.eb ?? x.wb) >= minBars && !x.uc && x.m !== 0)) {
    const o = measureBracket(r, series.get(r.pair), costsOf(r.ac, r.pair), intervalMs);
    if (o) outs.push(o);
  }
  return summarizeBrackets(outs);
}
const brackets = outcomeMode === "atr-bracket" ? { inSample: bracketsOf(inS), outOfSample: bracketsOf(outS) } : null;

/* ---------------- output ---------------- */
mkdirSync(outDir, { recursive: true });
const safe = (v) => {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  const s = String(v);
  const g = /^[=+\-@\u0000-\u001F]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(g) ? `"${g.replace(/"/g, '""')}"` : g;
};
const csv = [LEDGER_CSV_COLUMNS.join(","), ...rows.map((r) => ledgerRowValues(r).map(safe).join(","))].join("\r\n") + "\r\n";
writeFileSync(join(outDir, "ledger.csv"), csv);
const meta = { outcomeMode, engineVersion: ENGINE_VERSION, configId: engineConfigId(profile), source, tf, from: new Date(from).toISOString(), to: new Date(to).toISOString(), oos: new Date(oos).toISOString(), costs: explicitCosts ? costs : "per class (costsFor)", trials, trialsFile, minBars, step, symbols: [...series.keys()], rows: rows.length, seconds: Math.round((Date.now() - started) / 1000) };
writeFileSync(join(outDir, "report.json"), JSON.stringify({ meta, reports, pbo: overfit, ...(brackets ? { brackets } : {}) }, null, 1));

const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "—");
const lines = [
  `# Replay report — engine ${meta.configId} (v${ENGINE_VERSION})`,
  "",
  `${source} · ${tf} · ${meta.symbols.length} symbols · ${meta.from.slice(0, 10)} → ${meta.to.slice(0, 10)} · out-of-sample from ${meta.oos.slice(0, 10)}`,
  `Costs per side: fee ${costs.feeBps} bp + slippage ${costs.slipBps} bp${explicitCosts ? "" : " (+ per-class extra slippage)"}; funding ${costs.fundingBpsPer8h} bp/8 h. Trials for DSR: ${trials} (register: ${trialsFile}). Primary window: ≥ ${minBars} bars.`,
  `PBO (CSCV, ${overfit.combinations} combinations over ${overfit.periods} periods, variants ${overfit.variants.join(", ")}): ${Number.isFinite(overfit.pbo) ? overfit.pbo.toFixed(2) : "—"} (≥ 0.5 = the in-sample choice is likely overfit).`,
  `PBO variants (sparse variants dropped: ${overfit.dropped?.join(", ") || "none"}; only periods where every kept variant traded): ${overfit.columns?.map((c) => `${c.variant} ${c.activePeriods}/${overfit.periods} active, SR ${Number.isFinite(c.sharpe) ? c.sharpe.toFixed(2) : "—"}`).join(" · ") ?? "—"}`,
  "",
  "Survivorship and universe look-ahead are NOT removed (see docs/measurement.md). Not financial advice.",
  "",
];
for (const [name, pair] of Object.entries(reports)) {
  for (const [label, rep] of Object.entries(pair)) {
    lines.push(`## ${name} · ${label} (${rep.rows} rows, ${rep.directional} directional)`, "");
    lines.push("| h | group | n | hit (95 % CI) | base hit | mean net bp (95 % CI) | edge bp | vs BTC bp | vs universe bp | PF | t |", "|---|---|---|---|---|---|---|---|---|---|---|");
    for (const h of rep.horizons) {
      for (const g of h.groups) lines.push(`| ${h.horizon} | ${g.label} | ${g.n} | ${f(g.hitRate * 100)}% (${f(g.hitCi[0] * 100)}–${f(g.hitCi[1] * 100)}) | ${f(g.baseHitRate * 100)}% | ${f(g.meanNetBps)} (${f(g.meanCi[0])}…${f(g.meanCi[1])}) | ${f(g.edgeBps)} | ${f(g.excessBtcBps)} | ${f(g.excessXsBps)} | ${f(g.profitFactor, 2)} | ${f(g.tStat, 2)} |`);
    }
    lines.push("", "| h | rank IC | IC t | periods | SR/trade | PSR | DSR | shuffle p | momentum edge bp |", "|---|---|---|---|---|---|---|---|---|");
    for (const h of rep.horizons) lines.push(`| ${h.horizon} | ${f(h.ic.mean, 3)} | ${f(h.ic.tStat, 2)} | ${h.ic.periods} | ${f(h.sharpe.sr, 3)} | ${f(h.sharpe.psr, 2)} | ${f(h.sharpe.dsr, 2)} | ${f(h.benchmarks.shuffledP, 3)} | ${h.benchmarks.momentum ? f(h.benchmarks.momentum.edgeBps) : "—"} |`);
    lines.push("");
  }
}
// v2.8 (WP23 Task 9): Classic vs Confluence v2 on the SAME rows and outcomes (logged, never scored; Classic's report above is unchanged).
const h2hLines = [`## Classic vs Confluence v2 (test) — engine ${v2ConfigId()}`, ""];
{
  // Final review I2: only rows of this v2 config are compared; rows of another v2 version are counted, never pooled.
  const { compared: withV2, notCompared, otherVersions } = splitByV2(rows, v2ConfigId());
  if (!withV2.length) {
    h2hLines.push(noV2 ? "Not run: --no-v2 left Confluence v2 out of these rows." : "No rows with Confluence v2 in this replay.");
  } else {
    const v2Rows = withV2.map(asV2Row);
    const classicRep = measure(withV2);
    const v2Rep = measure(v2Rows);
    const churn = { classic: labelChurn(withV2, intervalMs).per100, v2: labelChurn(v2Rows, intervalMs).per100 };
    h2hLines.push(`${withV2.length} bars labelled by both engines (${notCompared} rows without v2 not compared; ${otherVersions} rows of another Confluence v2 version not compared — only engine ${v2ConfigId()} is compared); both are measured on the same outcomes.`, "");
    h2hLines.push("| h | engine | n | hit | mean net bp | edge bp | IC t | PSR | label changes /100 bars |", "|---|---|---|---|---|---|---|---|---|");
    for (const h of DEFAULT_HORIZONS) {
      for (const [name, rep, ch] of [["Classic", classicRep, churn.classic], ["Confluence v2", v2Rep, churn.v2]]) {
        const x = sideOf(rep, h, ch);
        h2hLines.push(`| ${h} | ${name} | ${x.n} | ${Number.isFinite(x.hitRate) ? f(x.hitRate * 100) + "%" : "—"} | ${f(x.meanNetBps)} | ${f(x.edgeBps)} | ${f(x.icT, 2)} | ${f(x.psr, 2)} | ${f(x.churnPer100)} |`);
      }
    }
  }
  h2hLines.push("");
}
lines.push(...h2hLines);
if (brackets) {
  lines.push("## Outcome mode atr-bracket (2×ATR stop, 2R target, stop first, gap at the open; one trade at a time per pair)", "");
  lines.push("| set | n | mean R | hit (95 % CI) | stops | targets |", "|---|---|---|---|---|---|");
  for (const [label, b] of Object.entries(brackets)) lines.push(`| ${label} | ${b.n} | ${f(b.meanR, 3)} | ${f(b.hitRate * 100)}% (${f(b.hitCi[0] * 100)}–${f(b.hitCi[1] * 100)}) | ${b.stops} | ${b.targets} |`);
  lines.push("");
}
writeFileSync(join(outDir, "report.md"), lines.join("\n") + "\n");
console.log("\n" + h2hLines.join("\n"));
console.log(`\n${rows.length} rows → ${outDir}/ledger.csv, report.json, report.md (${meta.seconds}s)`);
