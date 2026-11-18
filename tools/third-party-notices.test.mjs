// Tests for tools/third-party-notices.mjs (v2.8 WP20, licence audit 14 Nov 2026).
//   node --test tools/third-party-notices.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  ROOT, npmInventory, buildNotices, checkNotices, checkRustInventory, checkNativeNotices, parseCargoLock, isBuildOnly,
  cp1252Unencodable,
} from "./third-party-notices.mjs";

const inv = npmInventory();
const html = buildNotices({ target: "html" });

test("every shipped npm package is listed with a licence text; nothing is missing", () => {
  assert.ok(inv.shipped.length > 150, `${inv.shipped.length} shipped packages`);
  assert.deepEqual(html.missing, []);
  for (const p of inv.shipped) {
    assert.ok(html.text.includes(`${p.name}@${p.version}`), `${p.name}@${p.version} listed`);
    assert.ok(p.texts.length > 0, `${p.name}@${p.version} has a licence text`);
  }
  // The header count is the closure count (173 at audit time; whatever the closure is now).
  assert.match(html.text, new RegExp(`npm packages shipped: ${inv.shipped.length}\\b`));
});

test("three@0.187.0 is credited to the three.js authors", () => {
  const i = html.text.indexOf("=\nthree@0.187.0 — ");
  assert.ok(i > 0);
  assert.match(html.text.slice(i, i + 3000), /three\.js authors/);
});

test("the 11 packages without a licence file use the pinned fallbacks", () => {
  const noFile = ["react-remove-scroll-bar", "@web3icons/react", "@web3icons/common", "embla-carousel", "embla-carousel-react",
    "embla-carousel-reactive-utils", "input-otp", "react-resizable-panels", "client-only", "isarray", "victory-vendor"];
  for (const name of noFile) {
    const p = inv.shipped.find((x) => x.name === name);
    assert.ok(p, `${name} shipped`);
    assert.ok(p.fallback, `${name} uses a fallback`);
  }
  assert.match(html.text, /Copyright \(c\) David Jerleke/);
  assert.match(html.text, /Copyright \(c\) 2013 Julian Gruber/);
  // victory-vendor: its own MIT plus the vendored d3 licences from the package.
  const v = html.text.slice(html.text.indexOf("=\nvictory-vendor@36.9.2 — "));
  assert.match(v.slice(0, 20000), /Mike Bostock/);
});

test("build-only packages are left out of the notices and recorded as excluded", () => {
  for (const n of ["sharp", "caniuse-lite", "@next/swc-linux-x64-gnu", "typescript", "@types/react", "@rollup/rollup-linux-x64-gnu", "postcss"]) {
    assert.ok(isBuildOnly(n), `${n} is build-only`);
    assert.ok(!inv.shipped.some((p) => p.name === n), `${n} not shipped`);
  }
  assert.ok(inv.buildOnly.some((p) => p.name === "caniuse-lite"));
});

test("fonts: full SIL OFL 1.1 text and every menu-font copyright line; Fontsource fonts credited", () => {
  assert.match(html.text, /SIL OPEN FONT LICENSE/);
  assert.match(html.text, /PERMISSION & CONDITIONS/);
  for (const line of [
    "Copyright 2022 The Noto Project Authors (https://github.com/notofonts/arabic)",
    "Copyright 2025 The Noto Project Authors (https://github.com/notofonts/bengali)",
    "(c) 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'.",
  ]) assert.ok(html.text.includes(line), line);
  for (const f of ["inter", "space-grotesk", "jetbrains-mono", "noto-naskh-arabic", "noto-nastaliq-urdu"]) assert.ok(html.text.includes(`@fontsource/${f}@`), f);
  assert.match(html.text, /Copyright 2016 The Inter Project Authors/);
});

test("shadcn/ui origin (MIT) is credited", () => {
  assert.match(html.text, /shadcn\/ui/);
  assert.match(html.text, /Copyright \(c\) 2023 shadcn/);
});

test("per target: Rust crates + WebView2 on desktop, SQLCipher on mobile", () => {
  const tauri = buildNotices({ target: "tauri" }).text;
  const cap = buildNotices({ target: "capacitor" }).text;
  assert.ok(!/SQLCipher/.test(html.text) && !/WebView2 Runtime/.test(html.text));
  assert.match(tauri, /WebView2 Runtime/);
  assert.match(tauri, /Mozilla Public License Version 2\.0/);
  assert.match(tauri, /option-ext 0\.2\.0[\s\S]{0,400}Source code:/);
  assert.match(tauri, /Community Data License Agreement/);
  assert.match(tauri, /UNICODE LICENSE V3/);
  assert.match(cap, /SQLCipher/);
  assert.match(cap, /ZETETIC LLC/);
});

test("checkNativeNotices fails when SQLCipher is missing while the SQLite plugin ships", () => {
  assert.equal(checkNativeNotices(["@capacitor-community/sqlite"], "no native notice").ok, false);
  assert.equal(checkNativeNotices(["@capacitor-community/sqlite"], "SQLCipher Community Edition …").ok, true);
  assert.equal(checkNativeNotices(["react"], "").ok, true);
});

test("checkRustInventory: inventory must match Cargo.lock; MPL crates need a source location", () => {
  const lock = `version = 4\n\n[[package]]\nname = "a"\nversion = "1.0.0"\n\n[[package]]\nname = "b"\nversion = "2.0.0"\n`;
  const crates = [
    { name: "a", version: "1.0.0", license: "MIT", texts: ["x"] },
    { name: "b", version: "2.0.0", license: "MPL-2.0", texts: ["y"], source: "https://crates.io/crates/b/2.0.0" },
  ];
  assert.deepEqual(parseCargoLock(lock).map((c) => `${c.name}@${c.version}`), ["a@1.0.0", "b@2.0.0"]);
  assert.equal(checkRustInventory(lock, crates).ok, true);
  assert.equal(checkRustInventory(lock, crates.slice(0, 1)).ok, false, "b missing");
  assert.equal(checkRustInventory(lock, [crates[0], { ...crates[1], source: "" }]).ok, false, "MPL without source");
  assert.equal(checkRustInventory(lock, [crates[0], { ...crates[1], texts: [] }]).ok, false, "no licence text");
});

test("--check fails on a fixture package with no licence file and no fallback; passes once a fallback exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "tpn-"));
  try {
    const app = join(dir, "app");
    mkdirSync(join(app, "node_modules", "nolicence"), { recursive: true });
    mkdirSync(join(app, "node_modules", "withlicence"), { recursive: true });
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "@rsl/fixture", dependencies: { nolicence: "1.0.0", withlicence: "1.0.0" } }));
    writeFileSync(join(app, "node_modules", "nolicence", "package.json"), JSON.stringify({ name: "nolicence", version: "1.0.0", license: "MIT" }));
    writeFileSync(join(app, "node_modules", "withlicence", "package.json"), JSON.stringify({ name: "withlicence", version: "1.0.0", license: "ISC" }));
    writeFileSync(join(app, "node_modules", "withlicence", "LICENSE"), "ISC License\n\nCopyright (c) Fixture Author\n");
    const fb = join(dir, "fallbacks");
    mkdirSync(fb, { recursive: true });
    writeFileSync(join(fb, "sources.json"), JSON.stringify({ files: {}, packages: {}, components: [], notices: [] }));
    const opts = { root: dir, roots: ["app"], fallbackDir: fb, skip: ["fonts", "rust", "native", "menuFonts"] };
    const bad = checkNotices(opts);
    assert.equal(bad.ok, false);
    assert.match(bad.findings.join("\n"), /nolicence@1\.0\.0: no licence text/);
    mkdirSync(join(fb, "npm"));
    writeFileSync(join(fb, "npm", "nolicence.LICENSE"), "MIT License\n\nCopyright (c) Fixture\n");
    const src = (sha256) => JSON.stringify({ files: { "npm/nolicence.LICENSE": { source: "fixture", sha256 } }, packages: { "nolicence@1.0.0": { files: ["npm/nolicence.LICENSE"] } }, components: [], notices: [] });
    writeFileSync(join(fb, "sources.json"), src("0".repeat(64)));
    assert.match(checkNotices(opts).findings.join("\n"), /sha256 differs/, "a fallback whose hash changed fails");
    writeFileSync(join(fb, "sources.json"), src(createHash("sha256").update(readFileSync(join(fb, "npm", "nolicence.LICENSE"))).digest("hex")));
    const good = checkNotices(opts);
    assert.equal(good.ok, true, good.findings.join("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI: --check passes on the repository; --out writes the notices file", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "tools", "third-party-notices.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const dir = mkdtempSync(join(tmpdir(), "tpn-out-"));
  try {
    const out = join(dir, "THIRD-PARTY-NOTICES.txt");
    const w = spawnSync(process.execPath, [join(ROOT, "tools", "third-party-notices.mjs"), "--out", out, "--target", "html"], { encoding: "utf8" });
    assert.equal(w.status, 0, w.stdout + w.stderr);
    assert.ok(existsSync(out));
    assert.match(readFileSync(out, "utf8"), /^rsL Confluence Terminal — third-party notices/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// 2.8.0 release build (18 Nov 2026): the Windows MSI (WiX) shows bundle.licenseFile on its licence page and WiX refuses
// any character outside code page 1252 (LGHT0311) — the "→" in LICENSE failed the first 2.8.0 Windows build.
test("the desktop licence file (WiX MSI licence page) uses only code page 1252 characters", () => {
  assert.deepEqual(cp1252Unencodable("ASCII, é, — and € are fine"), []);
  assert.deepEqual(cp1252Unencodable("About → Open-source licences"), ["→"]);
  const conf = JSON.parse(readFileSync(join(ROOT, "apps/confluence/desktop/src-tauri/tauri.conf.json"), "utf8"));
  const text = readFileSync(join(ROOT, "apps/confluence/desktop/src-tauri", conf.bundle.licenseFile), "utf8");
  assert.deepEqual(cp1252Unencodable(text), [], "LICENSE has characters the MSI licence page cannot show");
});
