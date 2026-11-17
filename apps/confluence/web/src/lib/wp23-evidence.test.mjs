// WP23 evidence module is importable without running its CLI (Task 10 imports classicMetrics).
// Run: npm run test:wp23-evidence   (node scripts/run-engine-tests.mjs wp23-evidence.test.mjs)
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const mod = await import("./wp23-evidence.mjs");
let failed = 0;
const ok = (name, cond) => { if (cond) console.log("  ok   - " + name); else { failed++; console.log("  FAIL - " + name); } };
ok("importing the module does not run the CLI or exit", true);
ok("classicMetrics is exported as a function", typeof mod.classicMetrics === "function");

// The CLI must run when the entry path goes through a symlink (macOS tmpdir is one). A cheap
// invalid call (no --out) proves main() ran: it prints usage and exits 2; a skipped main() exits 0.
const real = fileURLToPath(new URL("./wp23-evidence.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "wp23-link-"));
try {
  const link = join(dir, "link-evidence.mjs");
  symlinkSync(real, link);
  const run = (file) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", file], { encoding: "utf8" });
  const direct = run(real);
  const viaLink = run(link);
  ok("direct entry runs the CLI (usage, exit 2)", direct.status === 2 && /usage:/.test(direct.stderr));
  ok("symlinked entry runs the CLI too (usage, exit 2)", viaLink.status === 2 && /usage:/.test(viaLink.stderr));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("\nWP23 evidence import: " + (failed === 0 ? "passed" : failed + " failed"));
process.exit(failed === 0 ? 0 : 1);
