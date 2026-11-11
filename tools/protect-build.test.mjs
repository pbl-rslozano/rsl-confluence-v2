// protect-build.test.mjs — v2.6 WP8: protected-build pipeline and release checks R17/R18 on a tiny fake out/ tree.
//   node --test tools/protect-build.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { protectBuild } from "./protect-build.mjs";
import {
  buildEquivalenceEvidence, checkProtectedBuild, checkProtectedEquivalence, loadTargets, selectTargets, sha256, treeHash,
} from "./checks/protected-build.mjs";

const CHUNKS = "_next/static/chunks";
// Shaped like a Turbopack chunk; carries own-code markers (runScanJobSafe, DEFAULT_HORIZONS, …) and app strings
// that must keep their values (postMessage fields, i18n keys, localStorage keys, exchange JSON fields).
const OWN = `(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,4711,e=>{"use strict";` +
  `let t={"app.subtitle":"Confluence Terminal",store:"rsl.preferences.v1"};const DEFAULT_HORIZONS=[1,4,24];` +
  `function a(n){let s=0;for(const h of DEFAULT_HORIZONS)s+=h*n;return{id:n,results:s,label:t["app.subtitle"],key:t.store,field:JSON.parse('{"lastPrice":"42.5"}').lastPrice}}` +
  `function runScanJobSafe(j){return a(j)}globalThis.__own=runScanJobSafe;e.s(["runScanJobSafe",0,runScanJobSafe,"DEFAULT_HORIZONS",0,DEFAULT_HORIZONS])}]);\n` +
  `//# sourceMappingURL=own.js.map\n`;
const WORKER = `(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,5,e=>{"use strict";` +
  `const COINSPH_INTERVALS=["1m","1h"];function RslProvider(){return"scan worker timed out"}globalThis.__worker=()=>[COINSPH_INTERVALS.join(","),RslProvider()].join("|");e.s(["COINSPH_INTERVALS",0,COINSPH_INTERVALS,"RslProvider",0,RslProvider])}]);`;
const VENDOR = `(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,99,e=>{"use strict";` +
  `function r(e){return"https://react.dev/errors/"+e+" Minified React error"}e.s(["default",0,r])}]);\n//# sourceMappingURL=vendor.js.map`;
// Vendor chunk that also contains an own marker: exclusion wins.
const MIXED = `!function(){var __TAURI_TO_IPC_KEY__=1;function createAdapters(){return __TAURI_TO_IPC_KEY__}globalThis.__mixed=createAdapters}();`;

function fakeOut() {
  const root = mkdtempSync(join(tmpdir(), "rsl-protect-"));
  const out = join(root, "out");
  mkdirSync(join(out, CHUNKS), { recursive: true });
  mkdirSync(join(out, "_next/static/media"), { recursive: true });
  writeFileSync(join(out, "index.html"), `<!doctype html><html><head><script src="./_next/static/chunks/own.js"></script></head><body>rsL<script>/*# sourceMappingURL=data:application/json;base64,e30= */</script></body></html>`);
  writeFileSync(join(out, CHUNKS, "own.js"), OWN);
  writeFileSync(join(out, CHUNKS, "worker.js"), WORKER);
  writeFileSync(join(out, CHUNKS, "vendor.js"), VENDOR);
  writeFileSync(join(out, CHUNKS, "tauri.js"), MIXED);
  writeFileSync(join(out, CHUNKS, "app.css"), "body{color:#fff}\n/*# sourceMappingURL=app.css.map */");
  writeFileSync(join(out, CHUNKS, "own.js.map"), JSON.stringify({ version: 3, sources: ["src/lib/scan-jobs.ts"], mappings: "" }));
  writeFileSync(join(out, "_next/static/media/scan.worker.abc.ts"), "self.onmessage = () => {};");
  writeFileSync(join(out, "sw.js"), `const CACHE_VERSION = "v2.6.0-20261107";`);
  writeFileSync(join(out, ".rsl-target"), "html\n");
  return { root, out, minified: join(root, "dist-minified"), manifest: join(root, "build-manifest.json") };
}

function evaluate(code, key, arg) {
  const ctx = { JSON, TURBOPACK: [] };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  for (const entry of ctx.TURBOPACK) for (const el of entry) if (typeof el === "function") el({ s() {} });
  return JSON.stringify(ctx[key](arg));
}

const quiet = () => {};

test("own chunks are obfuscated and behave the same; vendor chunks stay byte-identical; maps are gone", () => {
  const f = fakeOut();
  try {
    const { manifest } = protectBuild({ outDir: f.out, minifiedCopy: f.minified, manifestPath: f.manifest, log: quiet });
    const own = readFileSync(join(f.out, CHUNKS, "own.js"), "utf8");
    const worker = readFileSync(join(f.out, CHUNKS, "worker.js"), "utf8");
    assert.notEqual(own, OWN, "own chunk changed");
    assert.match(own, /_0x[0-9a-f]{4,}/, "own chunk carries obfuscated names");
    assert.doesNotMatch(own, /function runScanJobSafe\(/, "own function name is renamed");
    assert.equal(evaluate(own, "__own", 7), evaluate(OWN, "__own", 7), "same result as the minified chunk");
    assert.equal(JSON.parse(evaluate(own, "__own", 7)).key, "rsl.preferences.v1", "string values unchanged");
    assert.equal(evaluate(worker, "__worker"), evaluate(WORKER, "__worker"), "worker chunk behaves the same");
    assert.doesNotMatch(own, /\beval\s*\(|\bFunction\s*\(/, "no eval / Function introduced");

    assert.equal(readFileSync(join(f.out, CHUNKS, "vendor.js"), "utf8"), VENDOR.replace("//# sourceMappingURL=vendor.js.map", ""), "vendor: only the map comment removed");
    assert.equal(readFileSync(join(f.out, CHUNKS, "tauri.js"), "utf8"), MIXED, "excluded chunk byte-identical");
    assert.equal(readFileSync(join(f.out, "sw.js"), "utf8"), `const CACHE_VERSION = "v2.6.0-20261107";`);

    assert.equal(existsSync(join(f.out, CHUNKS, "own.js.map")), false, "map deleted");
    assert.equal(existsSync(join(f.out, "_next/static/media/scan.worker.abc.ts")), false, "worker TypeScript source deleted");
    for (const p of ["index.html", `${CHUNKS}/app.css`, `${CHUNKS}/own.js`, `${CHUNKS}/vendor.js`]) {
      assert.doesNotMatch(readFileSync(join(f.out, p), "utf8"), /source(Mapping)?URL/, `no map comment in ${p}`);
    }

    // Audit copy is the untouched minified build.
    assert.equal(readFileSync(join(f.minified, CHUNKS, "own.js"), "utf8"), OWN);
    assert.equal(existsSync(join(f.minified, CHUNKS, "own.js.map")), true, "dist-minified keeps the build as produced");

    // Manifest.
    assert.equal(existsSync(join(f.out, "build-manifest.json")), false, "manifest not inside out/");
    assert.deepEqual(manifest.protected.map((p) => p.path).sort(), [`${CHUNKS}/own.js`, `${CHUNKS}/worker.js`]);
    const ownRec = manifest.protected.find((p) => p.path.endsWith("own.js"));
    assert.equal(ownRec.sha256Before, sha256(OWN));
    assert.equal(ownRec.sha256After, sha256(own));
    assert.ok(manifest.vendor.some((v) => v.path === `${CHUNKS}/tauri.js` && v.sha256 === sha256(MIXED) && v.excludedBy.includes("__TAURI_TO_IPC_KEY__")));
    assert.equal(manifest.trees.protected.sha256, treeHash(f.out).sha256);
    assert.equal(manifest.trees.minified.sha256, treeHash(f.minified).sha256);
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.ok(Number.isInteger(manifest.build));
    assert.ok(manifest.commit, "commit recorded");
    assert.equal(manifest.obfuscator.package, "javascript-obfuscator");
    assert.match(manifest.obfuscator.version, /^\d+\.\d+\.\d+$/);
    for (const k of ["controlFlowFlattening", "deadCodeInjection", "selfDefending", "debugProtection", "disableConsoleOutput", "transformObjectKeys", "renameGlobals"]) {
      assert.equal(manifest.obfuscator.options[k], false, `${k} off`);
    }
    assert.deepEqual(manifest.obfuscator.options.domainLock, []);
    assert.deepEqual(manifest.removed.map((r) => r.path).sort(), [`${CHUNKS}/own.js.map`, "_next/static/media/scan.worker.abc.ts"]);

    const r17 = checkProtectedBuild({ outDir: f.out, manifestPath: f.manifest, minifiedDir: f.minified });
    assert.deepEqual(r17.findings, []);
    assert.equal(r17.ok, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("R17 fails on a leftover map, a map comment, a changed vendor chunk or a stray obfuscated file", () => {
  const f = fakeOut();
  try {
    protectBuild({ outDir: f.out, minifiedCopy: f.minified, manifestPath: f.manifest, log: quiet });
    writeFileSync(join(f.out, CHUNKS, "late.js.map"), "{}");
    let r = checkProtectedBuild({ outDir: f.out, manifestPath: f.manifest, minifiedDir: f.minified });
    assert.equal(r.ok, false);
    assert.ok(r.findings.some((x) => /source map shipped: .*late\.js\.map/.test(x)), r.findings.join("\n"));
    rmSync(join(f.out, CHUNKS, "late.js.map"));

    writeFileSync(join(f.out, CHUNKS, "vendor.js"), VENDOR + "/*patched*/");
    r = checkProtectedBuild({ outDir: f.out, manifestPath: f.manifest, minifiedDir: f.minified });
    assert.ok(r.findings.some((x) => /vendor\/untouched file differs.*vendor\.js/.test(x)), r.findings.join("\n"));
    assert.ok(r.findings.some((x) => /map comment in .*vendor\.js/.test(x)));

    writeFileSync(join(f.out, CHUNKS, "vendor.js"), readFileSync(join(f.out, CHUNKS, "own.js")));
    r = checkProtectedBuild({ outDir: f.out, manifestPath: f.manifest });
    assert.ok(r.findings.some((x) => /obfuscated file outside protect-targets\.json: .*vendor\.js/.test(x)), r.findings.join("\n"));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("R17 fails when the manifest lacks the commit or tree hashes, or a protected file changed", () => {
  const f = fakeOut();
  try {
    protectBuild({ outDir: f.out, manifestPath: f.manifest, log: quiet });
    const m = JSON.parse(readFileSync(f.manifest, "utf8"));
    writeFileSync(f.manifest, JSON.stringify({ ...m, commit: null, trees: {} }));
    const r = checkProtectedBuild({ outDir: f.out, manifestPath: f.manifest, requireMaster: true });
    assert.ok(r.findings.includes("manifest lacks the source commit"));
    assert.ok(r.findings.includes("manifest lacks the protected tree hash"));
    assert.ok(r.findings.includes("manifest lacks the master source SHA-256"));
    writeFileSync(f.manifest, JSON.stringify(m));
    writeFileSync(join(f.out, CHUNKS, "own.js"), OWN.replace("//# sourceMappingURL=own.js.map\n", ""));
    const r2 = checkProtectedBuild({ outDir: f.out, manifestPath: f.manifest });
    assert.ok(r2.findings.some((x) => /protected file changed after protection/.test(x)), r2.findings.join("\n"));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("R17 enforces the BG-5 size cap on total chunk JS", () => {
  const f = fakeOut();
  try {
    protectBuild({ outDir: f.out, manifestPath: f.manifest, log: quiet });
    const m = JSON.parse(readFileSync(f.manifest, "utf8"));
    writeFileSync(f.manifest, JSON.stringify({ ...m, sizes: { ...m.sizes, chunkJsGrowthPct: 15.1 } }));
    assert.ok(checkProtectedBuild({ outDir: f.out, manifestPath: f.manifest }).findings.some((x) => /BG-5 cap/.test(x)));
    writeFileSync(f.manifest, JSON.stringify({ ...m, sizes: { ...m.sizes, chunkJsGrowthPct: 14.9 } }));
    assert.ok(!checkProtectedBuild({ outDir: f.out, manifestPath: f.manifest }).findings.some((x) => /BG-5/.test(x)));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("pipeline refuses an already protected tree and a manifest path inside out/", () => {
  const f = fakeOut();
  try {
    assert.throws(() => protectBuild({ outDir: f.out, manifestPath: join(f.out, "build-manifest.json"), log: quiet }), /must not be written inside out/);
    protectBuild({ outDir: f.out, manifestPath: f.manifest, log: quiet });
    assert.throws(() => protectBuild({ outDir: f.out, manifestPath: f.manifest, log: quiet }), /already obfuscated/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("pipeline fails when a required marker would ship unprotected", () => {
  const f = fakeOut();
  try {
    // The engine chunk now also carries a framework marker, so exclusion wins and runScanJobSafe is in no target.
    writeFileSync(join(f.out, CHUNKS, "own.js"), OWN + "/*__NEXT_ERROR_CODE*/");
    assert.throws(() => protectBuild({ outDir: f.out, manifestPath: f.manifest, log: quiet }), /required markers in no protected chunk: runScanJobSafe/);
    assert.equal(readFileSync(join(f.out, CHUNKS, "worker.js"), "utf8"), WORKER, "nothing written on failure");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("selection follows tools/protect-targets.json (include marker and no exclude marker)", () => {
  const f = fakeOut();
  try {
    const sel = selectTargets(f.out, loadTargets());
    assert.deepEqual(sel.targets.map((x) => x.path).sort(), [`${CHUNKS}/own.js`, `${CHUNKS}/worker.js`]);
    const tauri = sel.others.find((x) => x.path.endsWith("tauri.js"));
    assert.deepEqual([tauri.include, tauri.exclude], [["createAdapters"], ["__TAURI_TO_IPC_KEY__"]]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("R18 accepts evidence for this exact protected tree only", () => {
  const f = fakeOut();
  try {
    protectBuild({ outDir: f.out, manifestPath: f.manifest, log: quiet });
    const acc = join(f.root, "results.json");
    const golden = join(f.root, "golden.json");
    writeFileSync(acc, JSON.stringify({ at: "2026-11-07T00:00:00Z", base: "http://127.0.0.1:8770/", results: [{ id: "ID-3.2", pass: true }] }));
    writeFileSync(golden, JSON.stringify({ pass: true }));
    const evPath = join(f.root, "evidence.json");
    const ev = buildEquivalenceEvidence({ outDir: f.out, manifestPath: f.manifest, acceptancePath: acc, goldenPath: golden });
    writeFileSync(evPath, JSON.stringify(ev));
    assert.deepEqual(checkProtectedEquivalence({ evidencePath: evPath, manifestPath: f.manifest }), { ok: true, findings: [] });

    writeFileSync(evPath, JSON.stringify({ ...ev, protectedTreeSha256: "0".repeat(64) }));
    assert.equal(checkProtectedEquivalence({ evidencePath: evPath, manifestPath: f.manifest }).ok, false);

    const noGolden = buildEquivalenceEvidence({ outDir: f.out, manifestPath: f.manifest, acceptancePath: acc });
    writeFileSync(evPath, JSON.stringify(noGolden));
    const r = checkProtectedEquivalence({ evidencePath: evPath, manifestPath: f.manifest });
    assert.equal(r.ok, false);
    assert.ok(r.findings.some((x) => /BG-4 did not pass/.test(x)));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
