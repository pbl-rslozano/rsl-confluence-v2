import { writeFileSync, existsSync, rmSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// --target=html (PWA / browser, default) | tauri (desktop) | capacitor (mobile)
// v2.6 WP8: the export is then protected (tools/protect-build.mjs, ADR-0014) before anything packages out/.
// Skip protection for local debugging with --no-protect or RSL_PROTECT=0; release builds keep the default.
const target = (process.argv.find((a) => a.startsWith("--target=")) ?? "--target=html").split("=")[1];
if (!["html", "tauri", "capacitor"].includes(target)) { console.error(`Unknown target ${target}`); process.exit(2); }
const protect = process.env.RSL_PROTECT !== "0" && !process.argv.includes("--no-protect");
const appDir = join(process.cwd(), "src", "app");
const apiDir = join(appDir, "api");
const tempApiDir = join(process.cwd(), "src", "api.__htmlbuild");

// Build 2.02: if a previous build was interrupted (Ctrl+C during `next build`),
// the temp folder holds the ONLY copy of src/app/api. Restore it — never delete
// it. Only discard the temp copy when the real folder is also present.
if (existsSync(tempApiDir)) {
  if (!existsSync(apiDir)) {
    renameSync(tempApiDir, apiDir);
    console.log("Restored src/app/api from an interrupted previous build.");
  } else {
    rmSync(tempApiDir, { recursive: true, force: true });
  }
}

// v2.6 WP8: a stale manifest or minified copy must never describe a new out/.
rmSync("build-manifest.json", { force: true });
rmSync("dist-minified", { recursive: true, force: true });

let exitCode = 0;
try {
  if (existsSync(apiDir)) renameSync(apiDir, tempApiDir);
  const result = spawnSync("next", ["build"], {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, BUILD_TARGET: target },
  });
  exitCode = result.status ?? 1;
} finally {
  if (existsSync(tempApiDir)) renameSync(tempApiDir, apiDir);
}

// Stamp the target so packaging can refuse a mismatched out/ (e.g. zipping a Tauri build as the PWA).
if (exitCode === 0) writeFileSync("out/.rsl-target", `${target}\n`);

// v2.6 WP8: obfuscate the app's own chunks, delete source maps, write build-manifest.json (next to out/, never
// inside). Runs here, before Capacitor/Tauri copy out/ and before package-pwa/publish-update zip or deploy it.
// The service worker's CACHE_VERSION is a source constant (R15) and sw.js precaches no hashed chunks, so it stays
// valid after obfuscation; protect-build leaves sw.js byte-identical.
if (exitCode === 0 && protect) {
  const result = spawnSync(process.execPath, [
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "tools", "protect-build.mjs"),
    "--out", "out",
    "--minified-copy", "dist-minified",
    "--manifest", "build-manifest.json",
  ], { stdio: "inherit" });
  exitCode = result.status ?? 1;
  // Never leave a half-protected out/ that a later packaging step could pick up.
  if (exitCode !== 0) rmSync("out/.rsl-target", { force: true });
} else if (exitCode === 0) {
  console.warn("WARNING: protection skipped (--no-protect / RSL_PROTECT=0) — local debugging build, not for release.");
}

process.exit(exitCode);
