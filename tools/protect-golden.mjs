#!/usr/bin/env node
/**
 * protect-golden.mjs — BG-4 engine equivalence for the protected build (v2.6 WP8, ADR-0014, release check R18).
 *
 * Loads the shipped engine module from the minified build (dist-minified/) and from the protected build (out/),
 * runs the same deterministic series through `runScanJobSafe` in both, and requires every result to be identical
 * (canonical JSON), and the protected engine to be no more than +15 % slower (BG-5). The chunks only register
 * factories when loaded, so nothing else in the app runs.
 *
 *   node tools/protect-golden.mjs --minified <dist-minified/> --protected <out/> [--write <golden.json>]
 *
 * Exit 0 = identical, 1 = a difference or too few usable scores, 2 = usage / engine not found.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const MARKER = "runScanJobSafe";

/** Register every Turbopack chunk under _next/static/chunks in a sandbox; return a module loader. */
export function loadEngine(dir, knownId) {
  const chunkDir = join(dir, "_next", "static", "chunks");
  const g = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    Math, Date, Float64Array, Float32Array, Uint8Array, Uint16Array, Int32Array, Uint32Array, ArrayBuffer, DataView,
    Array, Object, Map, Set, WeakMap, WeakSet, Error, TypeError, RangeError, JSON, Number, String, Boolean, Symbol,
    Reflect, Proxy, Promise, RegExp, BigInt, parseInt, parseFloat, isFinite, isNaN, Infinity, NaN, undefined,
    decodeURIComponent, encodeURIComponent, TextEncoder, TextDecoder, structuredClone, queueMicrotask,
    setTimeout, clearTimeout, performance,
  };
  g.globalThis = g; g.self = g; g.TURBOPACK = [];
  vm.createContext(g);
  for (const f of readdirSync(chunkDir).filter((n) => n.endsWith(".js")).sort()) {
    try { vm.runInContext(readFileSync(join(chunkDir, f), "utf8"), g, { filename: f, timeout: 5000 }); } catch { /* runtime chunks need a DOM; not needed here */ }
  }
  const factories = new Map();
  for (const entry of g.TURBOPACK) {
    if (!Array.isArray(entry)) continue;
    let ids = [];
    for (const el of entry.slice(1)) {
      if (typeof el === "number") ids.push(el);
      else if (typeof el === "function") { for (const id of ids) factories.set(id, el); ids = []; }
      else ids = [];
    }
  }
  const cache = new Map();
  const mod = (id) => { if (!cache.has(id)) cache.set(id, { exports: {} }); return cache.get(id); };
  const define = (exp, arr) => {
    for (let i = 0; i < arr.length;) {
      const name = arr[i++], tag = arr[i++];
      if (tag === 0) Object.defineProperty(exp, name, { value: arr[i++], enumerable: true, configurable: true });
      else { if (typeof arr[i] === "function") i++; Object.defineProperty(exp, name, { get: tag, enumerable: true, configurable: true }); }
    }
  };
  const req = (id) => {
    const m = mod(id);
    if (m.done) return m.exports;
    m.done = true;
    const f = factories.get(id);
    if (!f) throw new Error(`module ${id} not in this build`);
    const ctx = { s(arr, other) { define(other != null ? mod(other).exports : m.exports, arr); }, i: (x) => req(x), r: (x) => req(x), v(x) { m.exports = x; }, n(x) { m.exports = x; } };
    f.call(undefined, ctx, m, m.exports);
    return m.exports;
  };
  // The minified build still names the export in the factory source; the protected build hides it in its string
  // table, so it is loaded by the module id found in the minified build (both come from the same next build).
  const engineIds = knownId != null ? [knownId] : [...factories.entries()].filter(([, f]) => f.toString().includes(MARKER)).map(([id]) => id);
  for (const id of engineIds) {
    try { const e = req(id); if (typeof e[MARKER] === "function") return { id, run: e[MARKER] }; } catch { /* try the next candidate */ }
  }
  return null;
}

/** Deterministic OHLCV series packed as [time, open, high, low, close, volume] × n (the worker's wire format). */
export function series(n, seed, { drift = 0, vol = 0.02, zeroVolume = false, stepMs = 3_600_000 } = {}) {
  let s = seed >>> 0, p = 100;
  const out = new Float64Array(n * 6);
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const r = s / 4294967296 - 0.5;
    const o = p;
    p = Math.max(0.0001, p * (1 + drift + r * vol));
    const h = Math.max(o, p) * (1 + (s % 7) / 2000), l = Math.min(o, p) * (1 - (s % 5) / 2000);
    out.set([1.7e12 + i * stepMs, o, h, l, p, zeroVolume ? 0 : 1000 + (s % 5000)], i * 6);
  }
  return out;
}

/** The replay set: lengths, regimes, volume and timeframes chosen to reach every scoring branch. */
export function replayJobs() {
  const jobs = [];
  const regimes = [{ drift: 0 }, { drift: 0.002 }, { drift: -0.002 }, { drift: 0, vol: 0.002 }, { drift: 0.0005, vol: 0.06 }];
  const frames = [["15m", 900_000], ["1h", 3_600_000], ["4h", 14_400_000], ["1d", 86_400_000]];
  let k = 0;
  for (const [tf, stepMs] of frames) for (const reg of regimes) for (const n of [60, 250, 1000]) {
    k++;
    const zeroVolume = k % 9 === 0;
    for (const assetClass of ["crypto", "fx"]) {
      jobs.push({ key: `golden:${tf}:S${k}${assetClass === "fx" ? "PHP" : "USDT"}`, packed: series(n, 7919 * k, { ...reg, zeroVolume, stepMs }), intervalMs: stepMs, volumeAvailable: !zeroVolume, assetClass });
    }
  }
  return jobs;
}

const canonical = (v) => JSON.stringify(v, (_k, x) => (typeof x === "number" && !Number.isFinite(x) ? String(x) : x));

/** BG-5 (plan WP8): the protected engine may be at most this much slower than the minified one. */
export const MAX_SLOWDOWN_PCT = 15;

export function compareEngines(minifiedDir, protectedDir, { maxSlowdownPct = MAX_SLOWDOWN_PCT } = {}) {
  const a = loadEngine(minifiedDir), b = a ? loadEngine(protectedDir, a.id) : null;
  if (!a || !b) return { pass: false, detail: `engine (${MARKER}) not found in ${!a ? "minified" : "protected"} build` };
  const jobs = replayJobs();
  let identical = 0, usable = 0, ta = 0, tb = 0;
  const diffs = [];
  const timed = (engine, job) => { const t0 = performance.now(); const r = engine.run({ ...job, packed: job.packed.slice() }); return [r, performance.now() - t0]; };
  jobs.forEach((job, i) => {
    // Alternate which build runs first so warm-up and GC do not favour one side.
    let ra, rb, da, db;
    if (i % 2 === 0) { [ra, da] = timed(a, job); [rb, db] = timed(b, job); }
    else { [rb, db] = timed(b, job); [ra, da] = timed(a, job); }
    ta += da; tb += db;
    if (canonical(ra) === canonical(rb)) identical++;
    else if (diffs.length < 5) diffs.push(job.key);
    if (ra?.score?.usable || ra?.ok === true || ra?.result?.score?.usable) usable++;
  });
  const deltaPct = Number(((tb / Math.max(ta, 1e-6) - 1) * 100).toFixed(1));
  const enough = usable >= Math.floor(jobs.length / 4);
  const fast = deltaPct <= maxSlowdownPct;
  const pass = identical === jobs.length && enough && fast;
  return {
    pass,
    series: jobs.length,
    identical,
    usable,
    timeMinifiedMs: Math.round(ta),
    timeProtectedMs: Math.round(tb),
    timeDeltaPct: deltaPct,
    maxSlowdownPct,
    detail: identical !== jobs.length ? `${jobs.length - identical} results differ: ${diffs.join(", ")}`
      : !enough ? `only ${usable}/${jobs.length} usable scores — replay set does not exercise the engine`
      : !fast ? `results identical, but the protected engine is ${deltaPct} % slower (BG-5 cap +${maxSlowdownPct} %)`
      : `${identical}/${jobs.length} engine results identical (${usable} usable); scan time ${deltaPct >= 0 ? "+" : ""}${deltaPct} % (cap +${maxSlowdownPct} %)`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  if (!opt("minified") || !opt("protected")) { console.error("usage: protect-golden.mjs --minified <dir> --protected <dir> [--write <file>]"); process.exit(2); }
  const r = compareEngines(resolve(opt("minified")), resolve(opt("protected")));
  if (opt("write")) writeFileSync(resolve(opt("write")), JSON.stringify({ ...r, writtenAt: new Date().toISOString() }, null, 2) + "\n");
  console.log(`${r.pass ? "PASS" : "FAIL"}  BG-4/BG-5 engine golden replay  — ${r.detail}`);
  process.exit(r.pass ? 0 : r.series ? 1 : 2);
}
