/**
 * ts-hooks-async.mjs — fallback for Node versions without module.registerHooks
 * (< 22.15). Same behaviour as the synchronous hooks in lib-loader.mjs:
 * extensionless relative imports inside the web lib directory resolve to
 * `.ts`, and those files load as TypeScript modules.
 */
let scope = "";

export async function initialize(data) {
  scope = data?.scope ?? "";
}

const inScope = (url) => typeof url === "string" && scope && url.startsWith(scope);

export async function resolve(specifier, context, next) {
  if (inScope(context.parentURL) && /^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$|\.json$/.test(specifier)) {
    try { return await next(`${specifier}.ts`, context); } catch { /* fall through */ }
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (inScope(url) && url.endsWith(".ts")) return next(url, { ...context, format: "module-typescript" });
  return next(url, context);
}
