#!/usr/bin/env node
/**
 * package-pwa.mjs — zip the PWA (html target) static export.
 *
 *   pnpm build:pwa     (builds the html target, then runs this)
 *
 * Refuses an out/ that was built for tauri or capacitor (out/.rsl-target).
 * Output: dist/rsL-Confluence-<ver>-pwa.zip + .sha256, e.g. rsL-Confluence-2.8.0-pwa.zip (SemVer from the root
 * package.json, no "v", no year — KIT-003)
 */
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "apps/confluence/web/out");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const marker = join(OUT, ".rsl-target");
if (!existsSync(marker)) { console.error("out/ has no .rsl-target — run `pnpm --filter @rsl/confluence-web build:static` first."); process.exit(1); }
const target = readFileSync(marker, "utf8").trim();
if (target !== "html") { console.error(`out/ was built for "${target}", not the PWA (html). Rebuild with build:static.`); process.exit(1); }

mkdirSync(join(ROOT, "dist"), { recursive: true });
const zip = join(ROOT, "dist", `rsL-Confluence-${pkg.version}-pwa.zip`);
rmSync(zip, { force: true });
const LAUNCHER = join(ROOT, "tools/pwa-launcher");
const launchFiles = ["serve-pwa.mjs", "Start-Confluence-Terminal.cmd", "start-confluence-terminal.sh"];
if (process.platform === "win32") {
  execFileSync("tar.exe", ["-a", "-cf", zip, "--exclude", ".rsl-target", "-C", OUT, ".", "-C", LAUNCHER, ...launchFiles]);
} else {
  execFileSync("zip", ["-qr9X", zip, ".", "-x", ".rsl-target"], { cwd: OUT });
  execFileSync("zip", ["-qj9X", zip, ...launchFiles.map((f) => join(LAUNCHER, f))]);
}
const sum = createHash("sha256").update(readFileSync(zip)).digest("hex");
writeFileSync(`${zip}.sha256`, `${sum}  ${basename(zip)}\n`);
console.log(`PWA: ${zip.replace(ROOT + "/", "")}  sha256 ${sum}`);
