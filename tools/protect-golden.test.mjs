// protect-golden.test.mjs — BG-4 replay tool (v2.6 WP8): deterministic series, engine lookup by module id, diff detection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareEngines, loadEngine, replayJobs, series } from "./protect-golden.mjs";

/** A fake Turbopack chunk exporting runScanJobSafe from module 4242; `body` is the scoring expression. */
function fakeBuild(body, { hideName = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "golden-"));
  mkdirSync(join(dir, "_next", "static", "chunks"), { recursive: true });
  const name = hideName ? '["run","ScanJobSafe"].join("")' : '"runScanJobSafe"';
  writeFileSync(join(dir, "_next", "static", "chunks", "engine.js"),
    `(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push([void 0,4242,(e)=>{"use strict";e.s([${name},0,(job)=>{const c=job.packed;let s=0;for(let i=4;i<c.length;i+=6)s+=c[i];return {score:{usable:c.length>=600,value:${body}}};}]);}]);`);
  return dir;
}

test("replay series are deterministic and cover several timeframes and both asset classes", () => {
  assert.deepEqual([...series(50, 7)], [...series(50, 7)]);
  const jobs = replayJobs();
  assert.ok(jobs.length >= 100);
  assert.equal(new Set(jobs.map((j) => j.key)).size, jobs.length);
  assert.deepEqual([...new Set(jobs.map((j) => j.intervalMs))].length, 4);
  assert.ok(jobs.some((j) => j.assetClass === "fx") && jobs.some((j) => !j.volumeAvailable));
});

test("finds the engine in the minified build and the same module id in the protected one", () => {
  const minified = fakeBuild("s"), protectedDir = fakeBuild("s", { hideName: true });
  const a = loadEngine(minified);
  assert.equal(a?.id, 4242);
  assert.equal(loadEngine(protectedDir), null, "a hidden export name is not found by text");
  assert.equal(loadEngine(protectedDir, a.id)?.id, 4242);
  // Microsecond fake engines are too small to time; the speed cap has its own test below.
  const r = compareEngines(minified, protectedDir, { maxSlowdownPct: Infinity });
  assert.equal(r.pass, true, r.detail);
  assert.equal(r.identical, r.series);
});

test("any changed result fails BG-4", () => {
  const r = compareEngines(fakeBuild("s"), fakeBuild("s + 1e-9", { hideName: true }), { maxSlowdownPct: Infinity });
  assert.equal(r.pass, false);
  assert.match(r.detail, /differ/);
});

test("identical but much slower fails BG-5", () => {
  const slow = "(()=>{let z=0;for(let k=0;k<20000;k++)z+=k%3;return s+z*0;})()";
  const r = compareEngines(fakeBuild("s"), fakeBuild(slow, { hideName: true }));
  assert.equal(r.identical, r.series);
  assert.equal(r.pass, false);
  assert.match(r.detail, /slower/);
});

test("a missing engine is reported, not passed", () => {
  const dir = mkdtempSync(join(tmpdir(), "golden-empty-"));
  mkdirSync(join(dir, "_next", "static", "chunks"), { recursive: true });
  const r = compareEngines(dir, dir);
  assert.equal(r.pass, false);
  assert.match(r.detail, /not found/);
});
