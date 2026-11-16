// Generic read-only relay — v2.8 Step 2 (WP26, ADR-0003 amendment v2.8).
// Run: npm run test:relay   (node scripts/run-engine-tests.mjs native-relay.test.mjs)
//
// Upbit's CORS is unreliable (probe EX-PROBE-1, docs/research/evidence/wp26-venues-probe-2026-11-15.json),
// so it is reached like Coins.ph: same-origin rewrite on the web, native GET in the shells, plain fetch in Node.
// Upbit serves private account and order endpoints on the same host, so every transport must refuse any path
// outside UPBIT_READ_PATHS before a request is made. No test touches the network.
import { relayGet, relayTransport, setRelayNativeGet, RelayError } from "./native-relay.ts";
import {
  CSP_HOSTS, NATIVE_HOSTS, UPBIT_ORIGIN, UPBIT_PROXY_PREFIX, UPBIT_READ_PATHS,
  COINSPH_ORIGIN, COINSPH_READ_PATHS, isAllowedNativeUrl,
} from "./public-hosts.ts";
import { coinsphTransport } from "./coinsph.ts";

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log("  ok   - " + name); }
  else { failed++; console.log("  FAIL - " + name + (extra ? "  [" + extra + "]" : "")); }
};
const realFetch = globalThis.fetch;
let fetchCalls = [];
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init });
  return new Response(JSON.stringify([{ market: "KRW-BTC" }]), { status: 200, headers: { "content-type": "application/json", "Remaining-Req": "group=market; min=599; sec=9" } });
};
const reset = () => { fetchCalls = []; };
async function rejects(promise) {
  try { await promise; return null; } catch (e) { return e; }
}

const upbitRule = NATIVE_HOSTS.find((r) => r.origin === UPBIT_ORIGIN);

console.log("Host table (ADR-0003 v2.8)");
{
  ok("UPBIT_ORIGIN / UPBIT_PROXY_PREFIX verbatim", UPBIT_ORIGIN === "https://api.upbit.com" && UPBIT_PROXY_PREFIX === "/x/upbit");
  ok("UPBIT_READ_PATHS verbatim",
    JSON.stringify(UPBIT_READ_PATHS) === JSON.stringify(["/v1/market/all", "/v1/ticker/all", "/v1/ticker", "/v1/orderbook", "/v1/candles/"]));
  ok("one NATIVE_HOSTS entry for Upbit, with the read paths", NATIVE_HOSTS.filter((r) => r.origin === UPBIT_ORIGIN).length === 1 && upbitRule?.paths === UPBIT_READ_PATHS);
  ok("Coins.ph entry kept as it was", NATIVE_HOSTS.filter((r) => r.origin === COINSPH_ORIGIN).length === 1 && NATIVE_HOSTS.find((r) => r.origin === COINSPH_ORIGIN).paths === COINSPH_READ_PATHS);
  const origins = CSP_HOSTS.map((h) => h.origin);
  ok("CSP_HOSTS gains OKX and Coinbase Exchange", origins.includes("https://www.okx.com") && origins.includes("https://api.exchange.coinbase.com"));
  ok("Upbit is NOT in CSP_HOSTS (never fetched cross-origin by the WebView)", !origins.includes(UPBIT_ORIGIN));
  ok("no other new CSP host (14 entries + 3 WP25 radar hosts)", origins.length === 17 && ["https://fapi.binance.com", "https://publicreporting.cftc.gov", "https://stablecoins.llama.fi"].every((o) => origins.includes(o)), String(origins.length));
  for (const p of ["/v1/accounts", "/v1/orders", "/v1/order", "/v1/orders/chance", "/v1/orders/open", "/v1/withdraws", "/v1/deposits", "/v1/api_keys", "/v1/status/wallet"]) {
    ok(`native allowlist refuses private ${p}`, !isAllowedNativeUrl(UPBIT_ORIGIN + p));
  }
  for (const p of ["/v1/market/all", "/v1/ticker/all?quote_currencies=KRW,USDT,BTC", "/v1/ticker?markets=KRW-BTC", "/v1/orderbook?markets=KRW-BTC", "/v1/candles/minutes/240?market=KRW-BTC&count=200", "/v1/candles/days?market=KRW-BTC"]) {
    ok(`native allowlist allows read ${p.split("?")[0]}`, isAllowedNativeUrl(UPBIT_ORIGIN + p));
  }
  ok("exact paths stay exact (/v1/tickerx, /v1/ticker/x, bare /v1/candles/)",
    !isAllowedNativeUrl(UPBIT_ORIGIN + "/v1/tickerx") && !isAllowedNativeUrl(UPBIT_ORIGIN + "/v1/ticker/x") && !isAllowedNativeUrl(UPBIT_ORIGIN + "/v1/candles/"));
  ok("Coins.ph allowlist unchanged", isAllowedNativeUrl(COINSPH_ORIGIN + "/openapi/v1/time") && isAllowedNativeUrl(COINSPH_ORIGIN + "/openapi/quote/v1/klines?symbol=BTCPHP")
    && !isAllowedNativeUrl(COINSPH_ORIGIN + "/openapi/v1/account") && !isAllowedNativeUrl(UPBIT_ORIGIN + "/openapi/v1/time"));
}

console.log("Refusals happen before any request");
{
  // Browser (proxy) transport.
  globalThis.location = { protocol: "https:" };
  reset();
  const e1 = await rejects(relayGet(upbitRule, "/x/upbit", "/v1/accounts"));
  ok("relay refuses a path outside the allowlist", e1 instanceof RelayError && e1.kind === "REFUSED" && fetchCalls.length === 0, String(e1));
  for (const p of ["/v1/orders?state=wait", "/v1/orders/chance?market=KRW-BTC", "/v1/withdraws", "/v1/candles/../accounts", "/v1/candles/%2e%2e/accounts", "/v1/candles/minutes%2f..%2faccounts", "/v1/candles/%252e%252e/accounts", "/v1/candles/%25/x", "/v1/candles\\..\\accounts", "v1/ticker", "//evil.example/v1/ticker", "/v1/ticker#x"]) {
    reset();
    const e = await rejects(relayGet(upbitRule, "/x/upbit", p));
    ok(`proxy refuses ${p}`, e instanceof RelayError && e.kind === "REFUSED" && fetchCalls.length === 0, String(e));
  }
  reset();
  const forged = { origin: UPBIT_ORIGIN, paths: ["/v1/"], purpose: "forged" };
  const e2 = await rejects(relayGet(forged, "/x/upbit", "/v1/accounts"));
  ok("a rule that is not the NATIVE_HOSTS entry cannot widen the paths", e2 instanceof RelayError && e2.kind === "REFUSED" && fetchCalls.length === 0, String(e2));
  delete globalThis.location;

  // Native transport.
  let nativeCalls = 0;
  setRelayNativeGet(async () => { nativeCalls++; return { status: 200, headers: {}, body: "[]" }; });
  const e3 = await rejects(relayGet(upbitRule, "/x/upbit", "/v1/candles/../accounts"));
  ok("native transport refuses traversal", relayTransport() === "native" && e3 instanceof RelayError && e3.kind === "REFUSED" && nativeCalls === 0, String(e3));
  const e4 = await rejects(relayGet(upbitRule, "/x/upbit", "/v1/orders"));
  ok("native transport refuses a private path", e4 instanceof RelayError && e4.kind === "REFUSED" && nativeCalls === 0);
  setRelayNativeGet(null);

  // Node (direct) transport.
  reset();
  const e5 = await rejects(relayGet(upbitRule, "/x/upbit", "/v1/accounts"));
  ok("direct (Node) transport refuses a private path", relayTransport() === "direct" && e5 instanceof RelayError && fetchCalls.length === 0);
}

console.log("Transports");
{
  globalThis.location = { protocol: "https:" };
  reset();
  const r = await relayGet(upbitRule, "/x/upbit", "/v1/candles/minutes/240?market=KRW-BTC&count=200");
  ok("proxy transport uses the same-origin prefix", relayTransport() === "proxy" && fetchCalls.length === 1 && fetchCalls[0].url.startsWith("/x/upbit/v1/candles/minutes/240?"), fetchCalls[0]?.url);
  ok("proxy sends no credentials and follows no redirect", fetchCalls[0].init?.credentials === "omit" && fetchCalls[0].init?.redirect === "error");
  ok("response-like: status, json(), headers.get (case-insensitive)", r.status === 200 && (await r.json())[0].market === "KRW-BTC" && r.headers.get("remaining-req") === "group=market; min=599; sec=9");
  ok("coinsph detection unchanged in a browser", coinsphTransport() === "proxy");
  delete globalThis.location;

  // A page that is neither http nor https (e.g. file:) is still a browser: never a direct cross-origin fetch.
  globalThis.location = { protocol: "file:" };
  reset();
  await rejects(relayGet(upbitRule, "/x/upbit", "/v1/market/all"));
  ok("a non-http page never fetches the origin directly", relayTransport() === "proxy" && fetchCalls.every((c) => !c.url.startsWith(UPBIT_ORIGIN)));
  delete globalThis.location;

  let nativeUrl = null;
  setRelayNativeGet(async (url) => { nativeUrl = url; return { status: 200, headers: { "Remaining-Req": "group=candles; min=599; sec=9" }, body: "[{\"market\":\"KRW-BTC\"}]" }; });
  reset();
  const n = await relayGet(upbitRule, "/x/upbit", "/v1/ticker/all?quote_currencies=KRW,USDT,BTC");
  ok("native transport calls the absolute allowed URL", relayTransport() === "native" && nativeUrl === "https://api.upbit.com/v1/ticker/all?quote_currencies=KRW,USDT,BTC" && fetchCalls.length === 0);
  ok("native: text body parsed by json(), headers lower-cased", (await n.json())[0].market === "KRW-BTC" && n.headers.get("Remaining-Req") === "group=candles; min=599; sec=9" && n.headers.get("x-missing") === null);
  setRelayNativeGet(async () => ({ status: 200, headers: {}, body: [{ market: "KRW-ETH" }] }));
  const n2 = await relayGet(upbitRule, "/x/upbit", "/v1/market/all");
  ok("native: an already-parsed body is returned as is", (await n2.json())[0].market === "KRW-ETH");
  setRelayNativeGet(null);

  reset();
  await relayGet(upbitRule, "/x/upbit", "/v1/market/all");
  ok("direct (Node) transport uses the absolute origin", fetchCalls.length === 1 && fetchCalls[0].url === "https://api.upbit.com/v1/market/all");

  // A native shell whose native GET is not wired yet must not fall back to the proxy or a direct fetch.
  globalThis.__TAURI_INTERNALS__ = {};
  globalThis.location = { protocol: "http:" }; // Tauri on Windows serves http://tauri.localhost
  reset();
  const e6 = await rejects(relayGet(upbitRule, "/x/upbit", "/v1/market/all"));
  ok("native shell without native GET: not ready, no fetch", e6 instanceof RelayError && e6.kind === "NOT_READY" && fetchCalls.length === 0, String(e6));
  delete globalThis.__TAURI_INTERNALS__;
  delete globalThis.location;
}

console.log("Failures are relay errors (the venue reports feed unavailable)");
{
  globalThis.location = { protocol: "https:" };
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  const e1 = await rejects(relayGet(upbitRule, "/x/upbit", "/v1/market/all"));
  ok("network failure → RelayError NETWORK", e1 instanceof RelayError && e1.kind === "NETWORK");
  globalThis.fetch = async () => new Response("<!doctype html><title>Not found</title>", { status: 404, headers: { "content-type": "text/html" } });
  const r = await relayGet(upbitRule, "/x/upbit", "/v1/market/all");
  const e2 = await rejects(r.json());
  ok("missing rewrite (HTML 404) → status kept, json() is a PARSE RelayError", r.status === 404 && e2 instanceof RelayError && e2.kind === "PARSE");
  globalThis.fetch = async () => new Response("{}", { status: 429, headers: { "retry-after": "2" } });
  const r429 = await relayGet(upbitRule, "/x/upbit", "/v1/market/all");
  ok("429 is returned with its headers (the venue module sets its cooldown)", r429.status === 429 && r429.headers.get("Retry-After") === "2");
  const ac = new AbortController();
  globalThis.fetch = async (_u, init) => { if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError"); return new Response("[]"); };
  ac.abort();
  const e3 = await rejects(relayGet(upbitRule, "/x/upbit", "/v1/market/all", ac.signal));
  ok("abort propagates as AbortError (not a relay error)", e3 instanceof DOMException && e3.name === "AbortError");
  delete globalThis.location;
}

globalThis.fetch = realFetch;
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
