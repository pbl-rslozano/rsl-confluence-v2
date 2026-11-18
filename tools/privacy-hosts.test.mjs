// privacy-hosts.test.mjs — K-Dense v2 audit (18 Nov 2026) B-M2 / B-M3: the user guide's privacy section (§16) names
// every host the app or its local gateway contacts, and makes no blanket "nothing is sent" claim.
//   node --test tools/privacy-hosts.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const guide = read("docs/user-guide/en.md");
const manifest = JSON.parse(read("tools/egress-manifest.json"));
const hostsTs = read("apps/confluence/web/src/lib/public-hosts.ts");

/** §16 runs from its heading to the next numbered chapter. */
function section16() {
  const start = guide.indexOf("\n## 16.");
  const end = guide.indexOf("\n## 17.", start + 1);
  assert.ok(start >= 0 && end > start, "en.md has a §16 followed by §17");
  return guide.slice(start, end);
}

const CSP_HOSTS = [...(hostsTs.match(/export const CSP_HOSTS = \[([\s\S]*?)\] as const;/) || [, ""])[1].matchAll(/origin:\s*"([^"]+)"/g)]
  .map((m) => m[1].replace(/^(?:https?|wss):\/\//, ""));
const NATIVE_HOSTS = manifest.processes.web.nativeHosts ?? [];
/** The gateway's two paid data providers (WP25 part 2): CoinGlass REST and the Whale Alert websocket. */
const GATEWAY_PROVIDER_HOSTS = ["open-api-v4.coinglass.com", "leviathan.whale-alert.io"];

test("the host lists are read (CSP_HOSTS, nativeHosts, gateway provider hosts)", () => {
  assert.ok(CSP_HOSTS.length >= 20, `CSP_HOSTS: ${CSP_HOSTS.length}`);
  assert.deepEqual(NATIVE_HOSTS, ["api.pro.coins.ph", "api.upbit.com"]);
  const gw = manifest.processes.gateway;
  for (const h of GATEWAY_PROVIDER_HOSTS) assert.ok([...(gw.hosts ?? []), ...(gw.websocketHosts ?? [])].includes(h), `${h} is a gateway host`);
});

test("B-M2: every CSP_HOSTS host, every native host and both gateway provider hosts appear in en.md §16", () => {
  const s16 = section16();
  const missing = [...CSP_HOSTS, ...NATIVE_HOSTS, ...GATEWAY_PROVIDER_HOSTS].filter((h) => !s16.includes(h));
  assert.deepEqual(missing, [], `missing from §16: ${missing.join(", ")}`);
});

test("B-M2: en.md never says \"Nothing about you is sent\"", () => {
  assert.ok(!guide.includes("Nothing about you is sent"));
});

test("B-M2: the radar bullet names the live liquidation streams and keeps paid keys in the gateway", () => {
  const s16 = section16();
  assert.ok(s16.includes("`wss://fstream.binance.com`") && s16.includes("`wss://stream.bybit.com`"));
  assert.ok(!/GET only, no keys, no orders, no live stream/.test(s16));
  assert.ok(/Paid keys for CoinGlass or Whale Alert, if you add them, stay in the desktop gateway, which sends them only to that provider\./.test(s16));
});

test("B-M3: the Philippines bullet names OKX, Bybit and Bitget", () => {
  const bullet = guide.split("\n").find((l) => /^- \*\*[^*]*in the Philippines\.\*\*/.test(l));
  assert.ok(bullet, "en.md has the Philippines bullet");
  for (const v of ["okx", "bybit", "bitget"]) assert.ok(bullet.toLowerCase().includes(v), `${v} named`);
});
