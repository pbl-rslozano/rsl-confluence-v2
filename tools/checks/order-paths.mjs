#!/usr/bin/env node
/**
 * order-paths.mjs — release check R12, part 1 (ADR-0009, ADR-0010; v2.3 review S2): no source file outside
 * tests references an exchange order, account, funding or position-changing endpoint.
 *
 * v2.8 (WP26) adds the three new venues (OKX, Coinbase, Upbit). Each pattern below is written with escaped
 * slashes so this file never matches itself; it is skipped by the scan anyway.
 *
 *   node tools/checks/order-paths.mjs     exit 0 = ok
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const PARTS = [
  // Binance spot / margin / futures / portfolio margin
  String.raw`\/api\/v3\/order|\/sapi\/v\d\/margin\/order|\/(fapi|dapi)\/v\d\/order|\/papi\/v\d\/\w+\/order`,
  // Bybit V5
  String.raw`\/v5\/order\/|\/v5\/position\/(set|switch|trading-stop|add-margin)`,
  // generic
  String.raw`place-?order`,
  // Bitget v1 / v2
  String.raw`\/api\/v2\/(spot|mix)\/(trade|order)\/|\/api\/(spot|mix)\/v1\/(trade|order)`,
  // v2.8 (WP26) OKX: trading, account and funding (asset) endpoints are all private; fix round 1 adds the other
  // order-placing families (trading bots, spread trading, block trading / RFQ, copy trading)
  String.raw`\/api\/v5\/(trade|account|asset|tradingBot|sprd|rfq|copytrading)\/`,
  // v2.8 (WP26) Coinbase Exchange: orders, fills, accounts and (fix round 1) funding paths — on the host, or as a
  // bare path literal. "/profiles" only on the host: the local gateway has its own /profiles route.
  String.raw`api\.exchange\.coinbase\.com\/(orders|fills|accounts|withdrawals|deposits|transfers|conversions|profiles|coinbase-accounts)\b`,
  String.raw`["'\x60}]\/(orders|fills|accounts|withdrawals|deposits|transfers|conversions|coinbase-accounts)(?=[\/?"'\x60]|$)`,
  // v2.8 (WP26) Coinbase Advanced Trade: everything under brokerage except public market data and time
  String.raw`\/api\/v3\/brokerage\/(?!market\/|time\b)`,
  // v2.8 (WP26) Upbit: orders, accounts, withdrawals, deposits
  String.raw`\/v1\/(orders?|accounts|withdraws?|deposits?)\b`,
];
export const ORDER_ENDPOINT = new RegExp(PARTS.join("|"), "im");

/** The first order-endpoint reference in `src`, or null. */
export function orderEndpointIn(src) {
  const m = ORDER_ENDPOINT.exec(String(src));
  return m ? m[0] : null;
}

const SKIP = new Set(["node_modules", ".next", "out", "target", "gen", "dist", ".turbo", "android", "ios", "confluence-terminal-2.01", "evidence"]);
const isTest = (p) => /(^|\/)(test|tests|__tests__|test-support)\//.test(p) || /\.test\.[cm]?[jt]sx?$/.test(p);
/** The check itself and this pattern table are not scanned. */
const SELF = new Set(["tools/release-check.mjs", "tools/checks/order-paths.mjs"]);

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p); else yield p;
  }
}

/** Scan apps/, packages/ and tools/ (non-test source files) under `root`. */
export function scanOrderEndpoints(root = ROOT) {
  const bad = [];
  let scanned = 0;
  for (const top of ["apps", "packages", "tools"]) {
    for (const f of walk(join(root, top))) {
      const r = relative(root, f).split(sep).join("/");
      if (!/\.(m?[jt]sx?|cjs)$/.test(r) || isTest(r) || SELF.has(r)) continue;
      scanned++;
      const hit = orderEndpointIn(readFileSync(f, "utf8"));
      if (hit) bad.push(`${r}: order endpoint (${hit})`);
    }
  }
  return { bad, scanned };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const r = scanOrderEndpoints();
  console.log(r.bad.length ? `R12 order paths FAIL\n  ${r.bad.join("\n  ")}` : `R12 order paths ok (${r.scanned} files)`);
  process.exit(r.bad.length ? 1 : 0);
}
