/**
 * ts-resolve.mjs — lets plain Node 22 import the web engine's TypeScript as-is.
 *
 *   node --experimental-strip-types --import ./ts-resolve.mjs recorder.mjs …
 *
 * The engine modules in apps/confluence/web/src/lib are written for Next's
 * bundler: relative imports have NO extension (`from "./indicators"`). Node's
 * native type stripping only loads files it can resolve, and Node never
 * guesses extensions for ES modules. This hook adds exactly one rule:
 *
 *   a relative, extensionless specifier imported FROM a `.ts` file resolves to
 *   `<specifier>.ts` when that file exists.
 *
 * Nothing else is rewritten (bare packages, explicit extensions and imports
 * from .mjs files resolve as usual), and the source files are never copied or
 * modified — contrast scripts/run-engine-tests.mjs in the web app, which copies
 * the lib to a temp folder and rewrites the imports.
 *
 * The web package.json has no "type" field, so Node would sniff every .ts file
 * (and print MODULE_TYPELESS_PACKAGE_JSON). Files under apps/confluence/web/src
 * are ES modules by construction (Next bundles them as ESM), so the hook states
 * that format explicitly for them. Only that directory gets the override.
 *
 * Uses the in-thread `module.registerHooks` (Node ≥ 22.15) and falls back to the
 * off-thread `module.register` on older 22.x releases.
 */
import * as nodeModule from "node:module";
import { statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";

// file:///…/apps/confluence/web/src/ — trailing slash so a prefix test cannot
// match a sibling such as "src-old/".
const WEB_SRC = new URL("../web/src/", import.meta.url).href;

/** "./indicators" or "../lib/x" with no extension in its last path segment. */
function isExtensionlessRelative(specifier) {
  if (!(specifier.startsWith("./") || specifier.startsWith("../"))) return false;
  const last = specifier.slice(specifier.lastIndexOf("/") + 1);
  return last.length > 0 && !last.includes(".");
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Returns a rewritten resolution, or null to defer to Node's default. */
function tryTs(specifier, parentURL) {
  if (!parentURL || !parentURL.startsWith("file:") || !parentURL.endsWith(".ts")) return null;
  if (!isExtensionlessRelative(specifier)) return null;
  const candidate = new URL(`${specifier}.ts`, parentURL);
  // fileURLToPath gives a native path (C:\… on Windows) for the existence test.
  return isFile(fileURLToPath(candidate)) ? candidate.href : null;
}

function withFormat(result) {
  if (result && typeof result.url === "string" && result.url.endsWith(".ts") && result.url.startsWith(WEB_SRC) && !result.format) {
    return { ...result, format: "module-typescript" };
  }
  return result;
}

/** Synchronous hook (module.registerHooks). */
function resolveSync(specifier, context, nextResolve) {
  const rewritten = tryTs(specifier, context.parentURL);
  if (rewritten) return { url: rewritten, format: rewritten.startsWith(WEB_SRC) ? "module-typescript" : undefined, shortCircuit: true };
  return withFormat(nextResolve(specifier, context));
}

/** Asynchronous hook (module.register) — same rule. */
export async function resolve(specifier, context, nextResolve) {
  const rewritten = tryTs(specifier, context.parentURL);
  if (rewritten) return { url: rewritten, format: rewritten.startsWith(WEB_SRC) ? "module-typescript" : undefined, shortCircuit: true };
  return withFormat(await nextResolve(specifier, context));
}

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({ resolve: resolveSync });
} else if (isMainThread && typeof nodeModule.register === "function") {
  // Off-thread hooks load this same file in the loader worker; isMainThread
  // stops that copy from registering itself again.
  nodeModule.register(import.meta.url, pathToFileURL("./"));
}

// Exposed for the unit test of the rewrite rule.
export const __test = { isExtensionlessRelative, tryTs };
