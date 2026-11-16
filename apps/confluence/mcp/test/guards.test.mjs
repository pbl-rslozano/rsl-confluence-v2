// Safety guards: path traversal, size limits, append-only trial log, no network, table drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DataDir, PathError } from "../src/data-dir.mjs";
import { appendTrial, readTrials, validateTrial, TRIALS_FILE } from "../src/trials.mjs";
import { installNetworkGuard } from "../src/no-network.mjs";
import { INTERVAL_MS } from "../src/analysis.mjs";
import { readLedgerCsv, candleMetaFromPath, toKline } from "../src/readers.mjs";
import { connect, DISCLAIMER } from "../test-support/helpers.mjs";
import { buildFixture } from "../test-support/fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src");
const WEB_LIB = join(here, "..", "..", "web", "src", "lib");
const tmp = () => mkdtempSync(join(tmpdir(), "conf-mcp-guard-"));

/* ---------------- path traversal ---------------- */
test("traversal guard: relative paths only, no '..', no links out of the data dir", () => {
  const outside = tmp();
  const root = tmp();
  writeFileSync(join(outside, "secret.jsonl"), "{}\n");
  mkdirSync(join(root, "ledger"));
  writeFileSync(join(root, "ledger", "ok.jsonl"), "");
  symlinkSync(join(outside, "secret.jsonl"), join(root, "ledger", "link.jsonl"));
  symlinkSync(outside, join(root, "escape"));
  const d = new DataDir(root);
  for (const bad of ["../secret.jsonl", "ledger/../../secret.jsonl", "/etc/passwd", "C:\\Windows\\win.ini", "\\\\server\\share", "ledger\\..\\..\\x", "a\0b", "", "escape/secret.jsonl", "ledger/link.jsonl"]) {
    assert.throws(() => d.resolve(bad), PathError, JSON.stringify(bad));
  }
  assert.equal(d.resolve("ledger/ok.jsonl"), join(d.root, "ledger", "ok.jsonl"));
  assert.equal(d.resolve("./ledger/./ok.jsonl"), join(d.root, "ledger", "ok.jsonl"));
  assert.equal(d.resolve("not/yet/there.jsonl"), join(d.root, "not", "yet", "there.jsonl"));
  const walked = d.walk("ledger", () => true).files.map((f) => f.rel);
  assert.deepEqual(walked, ["ledger/ok.jsonl"], "links that leave the data dir are skipped by walks");
  assert.equal(d.walk("escape", () => true).files.length, 0);
  assert.throws(() => new DataDir(join(root, "missing")), PathError);
  assert.throws(() => new DataDir(join(root, "ledger", "ok.jsonl")), PathError);
  rmSync(outside, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("traversal guard through the tools", async () => {
  const fx = await buildFixture();
  const outside = tmp();
  writeFileSync(join(outside, "x.jsonl"), "{}\n");
  symlinkSync(join(outside, "x.jsonl"), join(fx.dir, "exports", "evil.jsonl"));
  const c = await connect(fx.dir);
  for (const file of ["../../../etc/passwd", "/etc/passwd", "exports/evil.jsonl", "exports/../../x.jsonl"]) {
    const res = await c.raw("query_ledger", { file });
    assert.equal(res.isError, true, file);
    assert.match(res.content[0].text, /data directory|'\.\.'|Absolute/);
    assert.ok(res.content[0].text.endsWith(DISCLAIMER));
  }
  const o = await c.call("ledger_overview");
  assert.ok(!o.files.some((f) => f.file.includes("evil")), "a symlink to outside is ignored when walking exports/");
  await c.close();
  rmSync(fx.dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/* ---------------- size limits ---------------- */
test("size limits: oversize files are refused, not read", async () => {
  const fx = await buildFixture();
  const c = await connect(fx.dir, { maxStreamBytes: 20_000, maxJsonBytes: 1_000, maxHeartbeatBytes: 50 });
  const o = await c.call("ledger_overview");
  const errs = o.files.filter((f) => f.error);
  assert.ok(errs.length >= 2 && errs.every((f) => /too large/.test(f.error)), JSON.stringify(o.files));
  const h = await c.call("recorder_health");
  assert.equal(h.heartbeat.status, "unreadable");
  assert.match(h.heartbeat.parseError, /too large/);
  const rep = await c.call("performance_report", { engine_id: "aaaaaaaaaaaaaaaa", source: "binance", horizons: [1], shuffles: 0 });
  assert.ok(rep.candles.tooLarge > 0, "candle files over the JSON limit are skipped");
  await c.close();
  const d = new DataDir(fx.dir, { maxJsonBytes: 10 });
  assert.throws(() => d.readText("heartbeat.json"), /too large/);
  const capped = await connect(fx.dir, { maxRows: 25 });
  const co = await capped.call("ledger_overview");
  assert.equal(co.rows, 25);
  assert.equal(co.truncated, true);
  await capped.close();
  rmSync(fx.dir, { recursive: true, force: true });
});

/* ---------------- append-only trial log ---------------- */
test("trial log is append-only: existing bytes never change", async () => {
  const root = tmp();
  const d = new DataDir(root);
  const a = await appendTrial(d, { hypothesis: "First hypothesis to test", metric: "IC t >= 2", config: { h: 6 } });
  const file = join(root, TRIALS_FILE);
  const after1 = readFileSync(file);
  const b = await appendTrial(d, { hypothesis: "Second hypothesis to test", metric: "edge > 0" });
  const after2 = readFileSync(file);
  assert.ok(after2.length > after1.length);
  assert.deepEqual(after2.subarray(0, after1.length), after1, "earlier bytes are untouched");
  assert.notEqual(a.id, b.id);
  assert.match(b.id, /^T0002-/);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);

  // A file without a trailing newline (e.g. hand-edited) gets a new line, the old bytes stay.
  appendFileSync(file, '{"id":"T0003-abcd","at":"x","hypothesis":"by hand","metric":"m","decision":"pending"}');
  const before = readFileSync(file);
  await appendTrial(d, { hypothesis: "Third hypothesis to test", metric: "PSR >= 0.95" });
  const now = readFileSync(file);
  assert.deepEqual(now.subarray(0, before.length), before);
  const { trials, bad } = await readTrials(d);
  assert.equal(trials.length, 4);
  assert.equal(bad, 0);

  // Validation: server-owned fields and unknown fields are refused; ref must exist.
  assert.throws(() => validateTrial({ id: "T9", hypothesis: "x".repeat(20), metric: "m1" }), /unknown field: id/);
  assert.throws(() => validateTrial({ at: "now", hypothesis: "x".repeat(20), metric: "m1" }), /unknown field: at/);
  assert.throws(() => validateTrial({ hypothesis: "too short", metric: "m1" }), /hypothesis/);
  assert.throws(() => validateTrial({ hypothesis: "x".repeat(20), metric: "m1", decision: "delete" }), /decision/);
  assert.throws(() => validateTrial({ hypothesis: "bad\u0007bell char", metric: "m1" }), /control/);
  assert.throws(() => validateTrial({ hypothesis: "x".repeat(20), metric: "m1", config: [1, 2] }), /config/);
  assert.throws(() => validateTrial({ hypothesis: "x".repeat(20), metric: "m1", config: { big: "y".repeat(5000) } }), /4096/);
  await assert.rejects(appendTrial(d, { hypothesis: "x".repeat(20), metric: "m1", ref: "T0999-ffff" }), /not in the register/);
  assert.equal(readFileSync(file).length, now.length, "rejected input writes nothing");
  rmSync(root, { recursive: true, force: true });
});

test("trial log refuses to write through a symlink or into a non-file", async () => {
  const root = tmp();
  const outside = tmp();
  writeFileSync(join(outside, "target.jsonl"), "");
  symlinkSync(join(outside, "target.jsonl"), join(root, TRIALS_FILE));
  await assert.rejects(appendTrial(new DataDir(root), { hypothesis: "x".repeat(20), metric: "m1" }), PathError);
  assert.equal(readFileSync(join(outside, "target.jsonl"), "utf8"), "");
  const root2 = tmp();
  mkdirSync(join(root2, TRIALS_FILE));
  await assert.rejects(appendTrial(new DataDir(root2), { hypothesis: "x".repeat(20), metric: "m1" }), /regular file/);
  for (const p of [root, outside, root2]) rmSync(p, { recursive: true, force: true });
});

test("the only file the tools ever create or change is trials.jsonl", async () => {
  const fx = await buildFixture();
  const snapshot = (dir) => {
    const out = {};
    const walk = (p) => { for (const e of readdirSync(p, { withFileTypes: true })) { const q = join(p, e.name); if (e.isDirectory()) walk(q); else out[relative(dir, q)] = readFileSync(q).toString("base64"); } };
    walk(dir);
    return out;
  };
  const before = snapshot(fx.dir);
  const c = await connect(fx.dir);
  for (const [n, a] of [["ledger_overview", {}], ["query_ledger", {}], ["latest_signals", {}], ["recorder_health", {}], ["list_trials", {}], ["performance_report", { shuffles: 0 }], ["log_trial", { hypothesis: "One logged hypothesis", metric: "m1" }]]) await c.call(n, a);
  await c.close();
  const after = snapshot(fx.dir);
  const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
  assert.deepEqual(changed, [TRIALS_FILE]);
  assert.deepEqual(Object.keys(before).filter((k) => !(k in after)), [], "nothing deleted");
  rmSync(fx.dir, { recursive: true, force: true });
});

/* ---------------- no network ---------------- */
const FORBIDDEN_MODULES = ["http", "https", "http2", "net", "tls", "dgram", "dns", "child_process", "cluster", "worker_threads", "inspector"];
const ALLOWED_BARE = new Set(["@modelcontextprotocol/sdk/server/mcp.js", "@modelcontextprotocol/sdk/server/stdio.js", "zod"]);

function scanForNetwork(file, text) {
  const problems = [];
  // The guard module names the blocked globals once, in one array literal.
  const code = text.replace(/^const BLOCKED_GLOBALS = \[.*\];$/m, "");
  const mod = `(?:node:)?(?:${FORBIDDEN_MODULES.join("|")})(?:/[\\w/]*)?`;
  if (new RegExp(`from\\s+["']${mod}["']`).test(code)) problems.push("imports a network/process module");
  if (new RegExp(`import\\s*\\(\\s*["']${mod}["']`).test(code)) problems.push("dynamically imports a network/process module");
  if (new RegExp(`import\\s+["']${mod}["']`).test(code)) problems.push("side-effect import of a network/process module");
  if (/\brequire\s*\(/.test(code) || /createRequire/.test(code)) problems.push("uses require()");
  if (/\bprocess\.(binding|_linkedBinding|dlopen)\b/.test(code)) problems.push("uses process.binding/dlopen");
  if (/\bfetch\b/.test(code)) problems.push("mentions fetch");
  if (/\b(WebSocket|EventSource|XMLHttpRequest|navigator\.sendBeacon)\b/.test(code)) problems.push("uses a web network API");
  // child_process calls (RegExp.prototype.exec, i.e. `.exec(`, is fine).
  if (/\b(execFile|execSync|execFileSync|spawn|spawnSync|fork)\s*\(/.test(code) || /(?<![.\w])exec\s*\(/.test(code)) problems.push("spawns a process");
  for (const m of code.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"'.][^"']*)["']/g)) {
    const spec = m[1];
    if (spec.startsWith("node:")) continue; // node built-ins: checked above
    if (!ALLOWED_BARE.has(spec)) problems.push(`imports package ${spec} (only the SDK stdio server and zod are allowed)`);
  }
  return problems.map((p) => `${file}: ${p}`);
}

test("no-network guard: server code never imports or uses fetch/http/https/net/child_process", () => {
  const files = readdirSync(SRC).filter((f) => /\.m?[jt]s$/.test(f));
  assert.ok(files.length >= 9, files.join(","));
  const problems = files.flatMap((f) => scanForNetwork(f, readFileSync(join(SRC, f), "utf8")));
  // The reused web library (statistics only) is held to the same rule.
  problems.push(...scanForNetwork("web/src/lib/ledger-metrics.ts", readFileSync(join(WEB_LIB, "ledger-metrics.ts"), "utf8")));
  assert.deepEqual(problems, []);
});

test("no-network guard: the scanner itself catches violations", () => {
  const bad = [
    'import http from "node:http";', 'import { request } from "https";', 'import net from "net";', 'import { spawn } from "node:child_process";',
    'const m = await import("node:net");', 'await fetch("https://x");', "globalThis.fetch(u)", 'const cp = require("child_process");',
    'new WebSocket("wss://x")', 'exec("ls")', 'cp.spawn("sh")', 'fork("./worker.mjs")', 'import express from "express";', 'import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";',
  ];
  for (const line of bad) assert.ok(scanForNetwork("x", line).length > 0, line);
  assert.deepEqual(scanForNetwork("x", 'import { readFileSync } from "node:fs";\nimport { z } from "zod";\nconst m = /a(b)/.exec(s);'), []);
});

test("no-network guard: network globals throw at runtime", () => {
  const target = {};
  installNetworkGuard(target);
  for (const name of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"]) {
    assert.throws(() => target[name]("https://example.com"), /Network access is disabled/);
    assert.throws(() => { target[name] = () => 1; }, TypeError, `${name} cannot be reassigned`);
  }
});

/* ---------------- drift and parsing ---------------- */
test("INTERVAL_MS mirrors web/src/lib/market-client.ts", () => {
  const src = readFileSync(join(WEB_LIB, "market-client.ts"), "utf8");
  const block = src.match(/export const INTERVAL_MS[^=]*=\s*\{([\s\S]*?)\};/)[1];
  const web = {};
  for (const m of block.matchAll(/"([^"]+)":\s*([^,\n]+),/g)) web[m[1]] = Function(`"use strict"; return (${m[2].replace(/_/g, "")});`)();
  assert.deepEqual({ ...INTERVAL_MS }, web);
});

test("CSV reader: quotes, injection guard and notice line", async () => {
  const dir = tmp();
  const p = join(dir, "x.csv");
  writeFileSync(p, '\uFEFF"NOTICE, exported"\r\nid,config_id,source,timeframe,pair,bar_open_utc,score,direction,strength,warm_bars,app_version\r\n' +
    '"a|b,c",cfg1,binance,4h,ETHUSDT,2026-09-01T00:00:00.000Z,-60,SELL,MODERATE,1000,"\'=1+2"\r\n' +
    'bad,,binance,4h,X,,,,,,\r\n');
  const { items, bad } = await readLedgerCsv(p);
  assert.equal(items.length, 1);
  assert.equal(bad, 1);
  assert.equal(items[0].id, "a|b,c");
  assert.equal(items[0].m, -1);
  assert.equal(items[0].st, 1);
  assert.equal(items[0].app, "=1+2", "apostrophe guard removed");
  assert.equal(items[0].t, Date.UTC(2026, 8, 1));
  rmSync(dir, { recursive: true, force: true });
});

test("CSV reader (WP25): radar columns are range-checked, alert codes are pattern-checked, older exports have no rad", async () => {
  const dir = tmp();
  const p = join(dir, "r.csv");
  const head = "id,config_id,source,timeframe,pair,bar_open_utc,bar_close_utc,score,direction,strength,warm_bars,radar_funding_pctl,radar_oi_chg_24h,radar_long_short,radar_taker_share,radar_us_premium,radar_kr_premium,radar_ph_premium,radar_alerts\r\n";
  writeFileSync(p, head +
    "a,c,binance,4h,BTCUSDT,2026-09-01T00:00:00.000Z,2026-09-01T04:00:00.000Z,60,BUY,WEAK,1000,150,-3,1.5,0.5,0.1,,99,\"OK_1|'=cmd|lower|OK_2\"\r\n" +
    "b,c,binance,4h,BTCUSDT,2026-09-01T04:00:00.000Z,2026-09-01T08:00:00.000Z,60,BUY,WEAK,1000,,,,,,,,\r\n");
  const { items } = await readLedgerCsv(p);
  assert.deepEqual(items[0].rad, { t: Date.UTC(2026, 8, 1, 4), frp: null, oi24: -3, ls: 1.5, tk: 0.5, usP: 0.1, krP: null, phP: null, al: ["OK_1", "OK_2"] });
  assert.ok(!("rad" in items[1]));
  rmSync(dir, { recursive: true, force: true });
});

test("candle cache: path layouts and bar shapes", () => {
  assert.deepEqual(candleMetaFromPath("binance/4h/btcusdt.json"), { src: "binance", tf: "4h", pair: "BTCUSDT" });
  assert.deepEqual(candleMetaFromPath("bybit-perp/1h/SOLUSDT/2026-10.json"), { src: "bybit-perp", tf: "1h", pair: "SOLUSDT" });
  assert.deepEqual(candleMetaFromPath("bybit-perp_1h_SOLUSDT.jsonl"), { src: "bybit-perp", tf: "1h", pair: "SOLUSDT" });
  // Recorder layout: monthly bars under "1mo", Windows device names prefixed with "_".
  assert.deepEqual(candleMetaFromPath("binance/1mo/BTCUSDT.json"), { src: "binance", tf: "1M", pair: "BTCUSDT" });
  assert.deepEqual(candleMetaFromPath("bybit-spot/4h/_CONUSDT.json"), { src: "bybit-spot", tf: "4h", pair: "_CONUSDT" });
  assert.deepEqual(candleMetaFromPath("bybit-spot/4h/_CON.json"), { src: "bybit-spot", tf: "4h", pair: "CON" });
  assert.equal(candleMetaFromPath("cache.json"), null);
  assert.deepEqual(toKline([1_700_000_000, "1", "2", "0.5", "1.5", "10"]), { time: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
  assert.deepEqual(toKline({ openTime: "2026-09-01T00:00:00Z", o: 1, h: 2, l: 1, c: 2 }), { time: Date.UTC(2026, 8, 1), open: 1, high: 2, low: 1, close: 2, volume: 0 });
  assert.equal(toKline({ time: 1, open: 0, high: 1, low: 1, close: 1 }), null);
});

test("trial counting: one rule for app, replay and MCP records (v2.3 review C12)", async () => {
  const { countHypotheses } = await import("../src/trials.mjs");
  const recs = [
    { id: "replay-1a2b3c4d", at: "2026-10-31T00:00:00Z", cfg: "a", variant: "a|binance|4h" },
    { id: "replay-1a2b3c4d", at: "2026-10-31T00:01:00Z", cfg: "a", variant: "a|binance|4h" }, // repeated run
    { id: "replay-55aa55aa", at: "2026-10-31T00:02:00Z", cfg: "b", variant: "b|binance|4h" },
    { id: "T0001-9f2c", at: "2026-10-31T00:03:00Z", hypothesis: "x" },
    { id: "T0002-1111", at: "2026-10-31T00:04:00Z", hypothesis: "verdict", ref: "T0001-9f2c" },
  ];
  assert.equal(countHypotheses(recs), 3);
});
