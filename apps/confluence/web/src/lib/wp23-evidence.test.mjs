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

// The Task 10 guard (pure): a changed Classic, continuity below 0.99 and a row size above 64 each fail with their message.
{
  const good = { classic: { unchanged: true }, v2: { continuity: { rate: 1 }, bytesPerRow: { max: 55 } } };
  ok("guard passes a clean run", mod.guardFailures(good).length === 0);
  const changed = mod.guardFailures({ ...good, classic: { unchanged: false } }, ["noise.0.labelled"]);
  ok("guard: a changed Classic metric prints CLASSIC CHANGED with the differing keys", changed.length === 1 && /^CLASSIC CHANGED.*noise\.0\.labelled/.test(changed[0]));
  const lowRate = mod.guardFailures({ ...good, v2: { ...good.v2, continuity: { rate: 0.9899 } } });
  ok("guard: continuity below 0.99 fails", lowRate.length === 1 && /CONTINUITY/.test(lowRate[0]));
  ok("guard: continuity exactly 0.99 passes", mod.guardFailures({ ...good, v2: { ...good.v2, continuity: { rate: 0.99 } } }).length === 0);
  const big = mod.guardFailures({ ...good, v2: { ...good.v2, bytesPerRow: { max: 65 } } });
  ok("guard: a row size above 64 fails", big.length === 1 && /BYTES PER ROW/.test(big[0]));
  ok("guard: a row size of exactly 64 passes", mod.guardFailures({ ...good, v2: { ...good.v2, bytesPerRow: { max: 64 } } }).length === 0);
  ok("guard: NaN continuity fails", mod.guardFailures({ ...good, v2: { ...good.v2, continuity: { rate: NaN } } }).length === 1);
  ok("diffPaths names the differing leaves", JSON.stringify(mod.diffPaths({ a: { b: 1, c: 2 } }, { a: { b: 1, c: 3 } })) === '["a.c"]');
}

// The CLI must run when the entry path goes through a symlink (macOS tmpdir is one). A cheap
// invalid call (no --out) proves main() ran: it prints usage and exits 2; a skipped main() exits 0.
const real = fileURLToPath(new URL("./wp23-evidence.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "wp23-link-"));
try {
  const link = join(dir, "link-evidence.mjs");
  symlinkSync(real, link);
  const run = (file, ...args) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", file, ...args], { encoding: "utf8" });
  const direct = run(real);
  const viaLink = run(link);
  ok("direct entry runs the CLI (usage, exit 2)", direct.status === 2 && /usage:/.test(direct.stderr));
  ok("symlinked entry runs the CLI too (usage, exit 2)", viaLink.status === 2 && /usage:/.test(viaLink.stderr));
  // --part handling: an unknown part, and `all` without --baseline, are usage errors (exit 2) that write nothing.
  const unknown = run(real, "--part", "bogus", "--out", join(dir, "x.json"));
  ok("an unknown --part exits 2", unknown.status === 2 && /unknown part/.test(unknown.stderr));
  const noBase = run(real, "--part", "all", "--out", join(dir, "x.json"));
  ok("--part all without --baseline exits 2", noBase.status === 2 && /usage:/.test(noBase.stderr));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("\nWP23 evidence import: " + (failed === 0 ? "passed" : failed + " failed"));
process.exit(failed === 0 ? 0 : 1);
