/**
 * fixture.mjs — builds a small, deterministic recorder data directory.
 *
 *   node test-support/fixture.mjs /tmp/conf-demo     # write a demo folder to try the server by hand
 *
 * Contents
 *   ledger/2026-08.jsonl, ledger/2026-09.jsonl  engine A (7 pairs × 31 bars, binance 4h) + engine B,
 *                                               a cold row, an underlying-closed row, a bad line, a duplicate
 *   candles/…                                   six pairs in five different cache layouts; ADAUSDT has none
 *   exports/ledger-bybit.csv                    app CSV export (via the web lib's ledgerRowValues)
 *   exports/ledger-bitget.json                  app JSON export
 *   heartbeat.json, rankings/, derivs/
 */
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMetricsLib } from "../src/lib-loader.mjs";

export const H = 3_600_000;
export const T0 = Date.UTC(2026, 8, 1); // 2026-09-01
export const ENGINE_A = "aaaaaaaaaaaaaaaa";
export const ENGINE_B = "bbbbbbbbbbbbbbbb";
export const PAIRS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT", "ADAUSDT"];
export const BARS = 80;
export const FIRST = 30;
export const LAST = 60;

function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

export function makeCandles(pair, n = BARS, step = 4 * H) {
  const r = prng([...pair].reduce((a, c) => a * 31 + c.charCodeAt(0), 7));
  const out = [];
  let px = 100 + (pair.length * 13) % 50;
  for (let i = 0; i < n; i++) {
    const o = px;
    px *= Math.exp((r() - 0.5) * 0.04);
    out.push({ time: T0 + i * step, open: o, high: Math.max(o, px) * 1.004, low: Math.min(o, px) * 0.996, close: px, volume: 1000 + Math.floor(r() * 500) });
  }
  return out;
}

export function makeRow({ cfg = ENGINE_A, src = "binance", tf = "4h", pair, i, sc, ac = "crypto", wb = 1000, uc = 0, live = 1, step = 4 * H, close = 100 }) {
  const t = T0 + i * step;
  const m = sc >= 55 ? 1 : sc <= -55 ? -1 : 0;
  const st = Math.abs(sc) >= 70 ? 2 : Math.abs(sc) >= 55 ? 1 : 0;
  return {
    id: `${cfg}|${src}|${tf}|${pair}|${t}`, cfg, ev: "2.3.0", app: "2.3.0", src, tf, pair, ac, t, tc: t + step, rec: t + step + 5000,
    c: close, sc, m, st, sup: 0, lv: 0, v: 17, bu: 9, be: 6, er: 0.42, bl: [30, -10, 5, 12], rk: 3, qv: 1e7,
    rd: 0, rc: 0, wb, live, uc,
  };
}

/** Write the fixture into `dir` (created if needed). Returns a summary for assertions. */
export async function buildFixture(dir = mkdtempSync(join(tmpdir(), "conf-mcp-"))) {
  const { lib } = await loadMetricsLib();
  for (const d of ["ledger", "candles/binance/4h/XRPUSDT", "exports", "rankings", "derivs"]) mkdirSync(join(dir, d), { recursive: true });

  // Candles in every supported layout.
  const series = Object.fromEntries(PAIRS.map((p) => [p, makeCandles(p)]));
  writeFileSync(join(dir, "candles/binance/4h/BTCUSDT.json"), JSON.stringify({ source: "binance", interval: "4h", symbol: "BTCUSDT", klines: series.BTCUSDT }));
  writeFileSync(join(dir, "candles/binance/4h/ETHUSDT.json"), JSON.stringify(series.ETHUSDT));
  writeFileSync(join(dir, "candles/binance/4h/SOLUSDT.json"), JSON.stringify({ candles: series.SOLUSDT.map((b) => [b.time, String(b.open), String(b.high), String(b.low), String(b.close), String(b.volume)]) }));
  writeFileSync(join(dir, "candles/binance/4h/XRPUSDT/2026-08.json"), JSON.stringify(series.XRPUSDT.slice(0, 40)));
  writeFileSync(join(dir, "candles/binance/4h/XRPUSDT/2026-09.json"), JSON.stringify(series.XRPUSDT.slice(40)));
  writeFileSync(join(dir, "candles/binance_4h_BNBUSDT.json"), JSON.stringify({ bars: series.BNBUSDT.map((b) => ({ t: b.time / 1000, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume })) }));
  writeFileSync(join(dir, "candles/doge-cache.json"), JSON.stringify({ source: "binance", interval: "4h", symbol: "DOGEUSDT", klines: series.DOGEUSDT }));
  // ADAUSDT: deliberately no candles.

  // Ledger: engine A on every pair, bars FIRST..LAST; scores cycle so BUY, SELL and NEUTRAL all occur.
  const r = prng(42);
  const rowsA = [];
  for (let i = FIRST; i <= LAST; i++) {
    for (const pair of PAIRS) {
      let sc = Math.round((r() * 2 - 1) * 90);
      if (i === LAST && pair === "ETHUSDT") sc = 88; // newest bar has a strong BUY
      const row = makeRow({ pair, i, sc, close: series[pair][i].close });
      if (pair !== "BTCUSDT" && i % 2 === 0) row.beta = 0.8 + (pair.length % 4) * 0.15; // v2.3 recorded beta on some rows
      rowsA.push(row);
    }
  }
  const rowsB = [];
  for (let i = FIRST; i <= FIRST + 10; i++) rowsB.push(makeRow({ cfg: ENGINE_B, pair: "ETHUSDT", i, sc: 75, close: series.ETHUSDT[i].close }));
  const cold = makeRow({ pair: "SOLUSDT", i: 20, sc: 80, wb: 120 });
  const closed = makeRow({ pair: "XRPUSDT", i: 21, sc: -80, uc: 1, ac: "crypto" });
  const half = Math.floor(rowsA.length / 2);
  const lines = (rows) => rows.map((x) => JSON.stringify(x)).join("\n") + "\n";
  writeFileSync(join(dir, "ledger/2026-08.jsonl"), lines([cold, closed, ...rowsA.slice(0, half)]) + "{not json\n");
  writeFileSync(join(dir, "ledger/2026-09.jsonl"), lines([...rowsA.slice(half), ...rowsB, rowsA[0]])); // last = duplicate id

  // App CSV export (bybit-perp 1h), written with the web lib's own column list and values.
  const csvRows = [0, 1, 2].map((i) => makeRow({ src: "bybit-perp", tf: "1h", pair: "SOLUSDT", i, sc: [72, -60, 10][i], step: H }));
  csvRows[1].beta = 1.3; csvRows[1].rku = 7; csvRows[1].rks = "live";
  const q = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const safe = (v) => (v === null || v === undefined ? "" : typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : /^[=+\-@\u0000-\u001F]/.test(String(v)) ? `'${v}` : String(v));
  const header = [...lib.LEDGER_CSV_COLUMNS, ...lib.DEFAULT_HORIZONS.map((h) => `net_return_h${h}`)];
  const body = csvRows.map((row, k) => [...lib.ledgerRowValues(row), ...lib.DEFAULT_HORIZONS.map((h) => (k === 0 ? 0.001 * h : ""))].map(safe).map(q).join(","));
  writeFileSync(join(dir, "exports/ledger-bybit.csv"), "﻿" + [header.map(q).join(","), ...body].join("\r\n") + "\r\n");

  // App JSON export (bitget 1d).
  const jsonRows = [0, 1].map((i) => makeRow({ src: "bitget", tf: "1d", pair: "BTCUSDT", i, sc: 60, step: 24 * H }));
  writeFileSync(join(dir, "exports/ledger-bitget.json"), JSON.stringify({ format: "rsl-signal-ledger", version: 1, app: "2.3.0", configId: ENGINE_A, source: "bitget", timeframe: "1d", rows: jsonRows }));

  // Recorder side files.
  const now = Date.now();
  writeFileSync(join(dir, "heartbeat.json"), JSON.stringify({ at: new Date(now - 5 * 60_000).toISOString(), intervalMs: 5 * 60_000, pid: 1234, errors: [{ at: new Date(now - 60 * 60_000).toISOString(), message: "bybit 429 rate limit" }] }));
  writeFileSync(join(dir, "rankings/2026-09.jsonl"), JSON.stringify({ t: T0 + LAST * 4 * H, src: "binance", tf: "4h", ranks: PAIRS.map((p, i) => [p, 1e9 / (i + 1)]) }) + "\n");
  writeFileSync(join(dir, "derivs/2026-09.jsonl"), JSON.stringify({ t: T0 + LAST * 4 * H, src: "bybit-perp", pair: "BTCUSDT", funding: 0.0001, oi: 123456 }) + "\n");

  return {
    dir,
    rowsA: rowsA.length,
    rowsB: rowsB.length,
    ledgerRows: rowsA.length + rowsB.length + 2, // + cold + closed
    csvRows: csvRows.length,
    jsonRows: jsonRows.length,
    totalRows: rowsA.length + rowsB.length + 2 + csvRows.length + jsonRows.length,
    series,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = await buildFixture(process.argv[2]);
  console.log(`fixture written to ${out.dir} (${out.totalRows} rows)`);
}
