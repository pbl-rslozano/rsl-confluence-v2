/**
 * env.mjs — process settings that must exist BEFORE the web engine loads.
 *
 * market-client.ts reads NEXT_PUBLIC_BUILD_TARGET once, at module evaluation,
 * to decide between the server proxy (/api/market/all, which only exists in a
 * Next server build) and direct exchange fetches. The recorder is a plain Node
 * process with no proxy, so it must behave like the static "html" export.
 *
 * ESM evaluates sibling imports in order, so `import "./env.mjs"` as the FIRST
 * import of engine.mjs runs this before any lib module is evaluated. It is set
 * unconditionally: a user shell exporting "server" would otherwise make every
 * cycle fail against a proxy that does not exist.
 */
process.env.NEXT_PUBLIC_BUILD_TARGET = "html";
