/**
 * lib-loader.mjs — import the app's measurement library (ledger-metrics.ts)
 * directly from apps/confluence/web/src/lib, so the server computes exactly
 * the statistics the app computes. Nothing is copied.
 *
 * The web lib uses extensionless relative imports (resolved by Next's
 * bundler). A module hook, scoped to the lib directory only, maps
 * `./name` → `./name.ts` and marks those files as TypeScript modules for
 * Node's built-in type stripping (Node ≥ 22.18 unflagged; older 22.x needs
 * --experimental-strip-types).
 */
import * as nodeModule from "node:module";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_LIB_PATH = fileURLToPath(new URL("../../web/src/lib/ledger-metrics.ts", import.meta.url));

const REQUIRED = ["buildReport", "measureOutcome", "DEFAULT_COSTS", "DEFAULT_HORIZONS", "WARM_MIN_BARS", "spearman"];

let registeredFor = null;

export function registerTsHooks(libDir) {
  const scope = pathToFileURL(libDir).href.replace(/\/?$/, "/");
  if (registeredFor === scope) return;
  if (registeredFor) throw new Error("TypeScript hooks already registered for another directory.");
  registeredFor = scope;
  const inScope = (url) => typeof url === "string" && url.startsWith(scope);
  if (typeof nodeModule.registerHooks === "function") {
    nodeModule.registerHooks({
      resolve(specifier, context, next) {
        if (inScope(context.parentURL) && /^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$|\.json$/.test(specifier)) {
          try { return next(`${specifier}.ts`, context); } catch { /* fall through to the original specifier */ }
        }
        return next(specifier, context);
      },
      load(url, context, next) {
        if (inScope(url) && url.endsWith(".ts")) return next(url, { ...context, format: "module-typescript" });
        return next(url, context);
      },
    });
  } else {
    nodeModule.register(new URL("./ts-hooks-async.mjs", import.meta.url), { data: { scope } });
  }
}

let cached = null;

/**
 * Load the measurement library once. Returns { lib, path, features }.
 * Throws a readable error when the file is missing or does not export the
 * functions the report needs.
 */
export async function loadMetricsLib(libPath = DEFAULT_LIB_PATH) {
  if (cached && cached.path === libPath) return cached;
  if (!existsSync(libPath)) throw new Error(`Measurement library not found: ${libPath} (set --lib)`);
  if (!process.features?.typescript) {
    throw new Error("This Node build cannot strip TypeScript types. Use Node ≥ 22.18, or start the server with --experimental-strip-types.");
  }
  registerTsHooks(dirname(libPath));
  const lib = await import(pathToFileURL(libPath).href);
  const missing = REQUIRED.filter((name) => !(name in lib));
  if (missing.length) throw new Error(`Measurement library at ${libPath} is missing: ${missing.join(", ")}`);
  const features = {
    btcExcess: true, // outcomes carry btcGross; v2.3 libs report excessBtcBps per group
    wilson: typeof lib.wilson === "function",
    momentumBenchmark: true, // ReportOptions.momentumOf (ignored by older libs)
    primaryWarmBars: typeof lib.PRIMARY_WARM_BARS === "number" ? lib.PRIMARY_WARM_BARS : null,
  };
  cached = { lib, path: libPath, features };
  return cached;
}
