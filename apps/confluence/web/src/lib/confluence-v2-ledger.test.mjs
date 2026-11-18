// Confluence v2 (WP23) Task 5: the compact `v2` ledger field, its CSV columns, the strict sanitiser, the backup round trip, row size.
// Run: npm run test:v2-ledger   (node scripts/run-engine-tests.mjs confluence-v2-ledger.test.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeLedgerRow, parseLedgerCsv, parseLedgerImport, LEDGER_CSV_COLUMNS, ledgerRowValues } from "./ledger-metrics.ts";
import { buildPayload, parsePayload } from "./backup-payload.ts";

const H = 3_600_000;
const t = Date.UTC(2026, 10, 1, 8);
const CFG = "f5c94871f16f6673";
const baseRow = {
  cfg: "c1", ev: "2.4.0", app: "t", src: "binance", tf: "4h", ac: "crypto", sup: 0, lv: 0, v: 18, bu: 9, be: 3,
  er: 0.4, bl: [55, -20, 10, 0], rk: 1, qv: 1, rd: 0, rc: 0, wb: 1000, live: 1, uc: 0,
  id: `c1|binance|4h|BTCUSDT|${t}`, pair: "BTCUSDT", t, tc: t + 4 * H, rec: t + 4 * H, c: 61234.5, sc: 47.5, m: 1, st: 1,
  rku: 4, rks: "live", rs: 81.2, beta: 1.07, htf: 1, td: -0.12, mev: -6.5, bp: 0.031, pin: 0, spl: 0, earn: 0,
  vt: 12345, pd: -1, pc: 2, fr: 0.0001, oiChg: -3.25, ft: -37.3,
  rad: null,
  scb: [-0.04123, -0.02011, 0.0199, 0.04188], scp: { s: 1, p: [0.512, 0.301, 0.187], b: [0.4, 0.35, 0.25], w: 0.0245, f: 0 },
};
const V2 = { cfg: CFG, s: -72, m: -1, st: 1 };
const safe = (v) => { if (v === null || v === undefined) return ""; if (typeof v === "number") return Number.isFinite(v) ? String(v) : ""; const g = /^[=+\-@\u0000-\u001F]/.test(String(v)) ? `'${v}` : String(v); return /[",\r\n]/.test(g) ? `"${g.replace(/"/g, '""')}"` : g; };
const csvOf = (cols, lines) => "﻿" + [cols.join(","), ...lines.map((l) => l.map(safe).join(","))].join("\r\n") + "\r\n";
const at = (c) => LEDGER_CSV_COLUMNS.indexOf(c);
const V2_COLS = ["v2_config_id", "v2_score", "v2_direction", "v2_strength"];
const csvRow = (r, edit) => { const v = ledgerRowValues(r); if (edit) edit(v); return csvOf([...LEDGER_CSV_COLUMNS, "net_return_h1"], [[...v, ""]]); };

test("CSV: the v2 columns follow scenario_fallback and round-trip", () => {
  assert.equal(LEDGER_CSV_COLUMNS.slice(at("scenario_fallback")).join(), ["scenario_fallback", ...V2_COLS].join());
  assert.equal(LEDGER_CSV_COLUMNS[LEDGER_CSV_COLUMNS.length - 1], "v2_strength");
  for (const v2 of [V2, { cfg: CFG, s: null, m: 0, st: 0 }, { cfg: CFG, s: 0, m: 0, st: 0 }]) {
    const row = { ...baseRow, v2 };
    const vals = ledgerRowValues(row);
    assert.equal(vals.length, LEDGER_CSV_COLUMNS.length);
    assert.equal(vals[at("v2_config_id")], CFG);
    assert.equal(vals[at("v2_score")], v2.s === null ? "" : v2.s);
    const out = parseLedgerCsv(csvRow(row));
    assert.equal(out.rejected, 0);
    assert.equal(JSON.stringify(out.rows[0]), JSON.stringify(sanitizeLedgerRow(row)));
    assert.deepEqual(out.rows[0].v2, v2);
  }
  const none = ledgerRowValues({ ...baseRow, v2: null });
  assert.deepEqual(V2_COLS.map((c) => none[at(c)]), ["", "", "", ""]);
  assert.equal(parseLedgerCsv(csvRow({ ...baseRow, v2: null })).rows[0].v2, null);
});

test("an earlier v2.8 CSV without v2 columns imports with v2 null", () => {
  const cols = LEDGER_CSV_COLUMNS.slice(0, at("scenario_fallback") + 1);
  const out = parseLedgerCsv(csvOf([...cols, "net_return_h1"], [[...ledgerRowValues(baseRow).slice(0, cols.length), ""]]));
  assert.equal(out.rejected, 0);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].v2, null);
});

test("rows without v2 stay valid", () => {
  assert.equal(sanitizeLedgerRow(baseRow).v2, null);
  assert.equal(sanitizeLedgerRow({ ...baseRow, v2: null }).v2, null);
});

test("hostile v2 values reject the whole row", () => {
  const bad = {
    "cfg XYZ": { ...V2, cfg: "XYZ" }, "cfg 15 hex": { ...V2, cfg: CFG.slice(1) }, "cfg upper case": { ...V2, cfg: CFG.toUpperCase() },
    "s 101": { ...V2, s: 101 }, "s -101": { ...V2, s: -101 }, "s 12.5": { ...V2, s: 12.5 }, "s abc": { ...V2, s: "abc" }, "s NaN": { ...V2, s: NaN },
    "m 2": { ...V2, m: 2 }, "st 3": { ...V2, st: 3 },
    "s null m 1": { cfg: CFG, s: null, m: 1, st: 1 }, "s null st 1": { cfg: CFG, s: null, m: 0, st: 1 },
    "m 0 st 2": { cfg: CFG, s: 5, m: 0, st: 2 }, "m 1 st 0": { cfg: CFG, s: 70, m: 1, st: 0 },
    "array": [CFG, -72, -1, 1], "string": CFG, "number": 1,
  };
  for (const [name, v2] of Object.entries(bad)) assert.equal(sanitizeLedgerRow({ ...baseRow, v2 }), null, name);
  assert.equal(sanitizeLedgerRow({ ...baseRow, v2: V2 }) !== null, true);
  const row = { ...baseRow, v2: V2 };
  for (const drop of V2_COLS) {
    const out = parseLedgerCsv(csvRow(row, (v) => { v[at(drop)] = ""; }));
    // a blank v2_score alone is the null-score form (and inconsistent with m -1), the others are partial
    assert.equal(out.rows.length, 0, `blank ${drop}`);
    assert.equal(out.rejected, 1, `blank ${drop}`);
  }
  const three = parseLedgerCsv(csvRow(row, (v) => { v[at("v2_strength")] = ""; v[at("v2_direction")] = ""; v[at("v2_score")] = ""; }));
  assert.equal(three.rejected, 1);
  const abc = parseLedgerCsv(csvRow(row, (v) => { v[at("v2_direction")] = "abc"; }));
  assert.equal(abc.rejected, 1);
  assert.equal(abc.rows.length, 0);
});

test("JSON import keeps v2 and drops unknown v2 keys", () => {
  const text = JSON.stringify({ ...baseRow, v2: { ...V2, extra: "x", __proto__x: 1 } });
  const out = parseLedgerImport(text);
  assert.equal(out.rows.length, 1);
  assert.deepEqual(out.rows[0].v2, V2);
  assert.deepEqual(Object.keys(out.rows[0].v2).sort(), ["cfg", "m", "s", "st"]);
});

test("the WP28 backup carries v2", async () => {
  const row = sanitizeLedgerRow({ ...baseRow, v2: V2 });
  const row2 = sanitizeLedgerRow({ ...baseRow, id: `c1|binance|4h|ETHUSDT|${t}`, pair: "ETHUSDT", v2: { cfg: CFG, s: null, m: 0, st: 0 } });
  const parts = {
    createdAt: 1_700_000_000_000, app: "2.8.0", settings: { preferences: null, scoringProfile: null },
    ledger: { rows: [row, row2], outcomes: [], universes: [], gaps: [] }, research: { preregistrations: [], trials: [] }, paper: { journal: [], notes: [] },
  };
  const header = { createdAt: parts.createdAt };
  const ok = await parsePayload(buildPayload(parts), header);
  assert.equal(ok.rejected.rows, 0);
  assert.deepEqual(ok.payload.ledger.rows, [row, row2]);
  const hostile = JSON.parse(buildPayload(parts));
  hostile.ledger.rows.push({ ...JSON.parse(JSON.stringify(row)), id: `c1|binance|4h|SOLUSDT|${t}`, pair: "SOLUSDT", v2: { cfg: "bad", s: 1, m: 0, st: 0 } });
  const bad = await parsePayload(JSON.stringify(hostile), header);
  assert.equal(bad.rejected.rows, 1);
  assert.equal(bad.payload.ledger.rows.length, 2);
});

test("Classic fields are untouched by v2", () => {
  const { v2: _a, ...withV2 } = sanitizeLedgerRow({ ...baseRow, v2: V2 });
  const { v2: _b, ...without } = sanitizeLedgerRow(baseRow);
  assert.deepEqual(withV2, without);
});

test("row size (Review Focus 5): v2 adds at most 64 JSON characters", () => {
  const w = sanitizeLedgerRow({ ...baseRow, v2: V2 });
  const { v2: _v2, ...wo } = sanitizeLedgerRow(baseRow); // the key absent: the added JSON is the key and its value
  assert.equal(wo.rad, null);
  const n = JSON.stringify(w).length - JSON.stringify(wo).length;
  const nullN = JSON.stringify({ ...wo, v2: null }).length - JSON.stringify(wo).length;
  console.log(`v2 row size: +${n} characters (worst case s -72, m -1, st 1); a null v2 key adds +${nullN}`);
  assert.ok(n <= 64, `v2 adds ${n}`);
});
