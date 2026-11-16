/**
 * run-engine-tests.mjs — runs the engine regression suite under plain Node.
 *
 * The engine modules use extensionless relative imports (resolved by Next's
 * bundler), which Node's native TypeScript stripping cannot resolve. This
 * runner copies src/lib/*.ts into a temporary directory, rewrites relative
 * imports to explicit `.ts` paths, and executes the suite there. Source files
 * are never modified.
 *
 *   node scripts/run-engine-tests.mjs            # runs src/lib/engine.test.mjs
 *   node scripts/run-engine-tests.mjs other.mjs  # runs another suite from src/lib
 *   node scripts/run-engine-tests.mjs replay.cli.mjs --tf 4h …   # args are forwarded
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const lib = join(process.cwd(), "src", "lib");
const suite = process.argv[2] ?? "engine.test.mjs";
const dir = mkdtempSync(join(tmpdir(), "ct-engine-"));
try {
  // v2.8 (WP25): src/lib/radar/*.ts is copied to <tmp>/radar/ ("../x" and "./x" imports both get ".ts").
  const rewrite = (text) => text.replace(/from\s+"(\.{1,2})\/([A-Za-z0-9_-]+)"/g, (_m, dots, name) => `from "${dots}/${name}.ts"`);
  mkdirSync(join(dir, "radar"));
  for (const file of readdirSync(join(lib, "radar"))) {
    if (file.endsWith(".ts")) writeFileSync(join(dir, "radar", file), rewrite(readFileSync(join(lib, "radar", file), "utf8")));
  }
  for (const file of readdirSync(lib)) {
    if (file.endsWith(".ts")) {
      const src = readFileSync(join(lib, file), "utf8").replace(
        /from\s+"\.\/((?:radar\/)?[A-Za-z0-9_-]+)"/g, // v2.8 (WP25): "./radar/x" too
        (_m, name) => `from "./${name}.ts"`,
      );
      writeFileSync(join(dir, file), src);
    } else if (file.endsWith(".mjs") || file.endsWith(".json")) { // .json: shared test fixtures
      cpSync(join(lib, file), join(dir, file));
    }
  }
  // v2.1.1: extra CLI arguments are forwarded (used by the replay/backtest tool).
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(dir, suite), ...process.argv.slice(3)], {
    stdio: "inherit",
  });
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
