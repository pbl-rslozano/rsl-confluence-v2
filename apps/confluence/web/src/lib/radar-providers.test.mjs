// Data-provider client (v2.8 Step 4b, Task 7). Run: npm run test:radar-providers
import { connectProvider, listProviders, disconnectProvider, nextProviderLink } from "./private-api.ts";
import { fetchEtfLive, fetchWhaleAlerts } from "./radar/providers-client.ts";

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} ${extra}`); }
};
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e instanceof Error ? e.message : String(e); } };

const SESSION = { url: "http://127.0.0.1:8787", token: "tok" };
const LINK = { session: SESSION, providers: [] };
const SECRET = "SECRET-PROVIDER-KEY-123456";
const realFetch = globalThis.fetch;
const realLocal = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const realSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
const realAny = AbortSignal.any;
const restoreProp = (name, desc) => { if (desc) Object.defineProperty(globalThis, name, desc); else delete globalThis[name]; };
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const mockFetch = (fn) => { globalThis.fetch = fn; };

try {
  // connectProvider refuses a non-loopback gateway
  let called = false;
  mockFetch(async () => { called = true; return json(200, {}); });
  let msg = await rejects(() => connectProvider({ url: "http://example.com:8787", token: "t" }, { provider: "coinglass", label: "x", apiKey: SECRET }));
  ok("connectProvider refuses a non-loopback gateway", !!msg && !called && !msg.includes(SECRET));
  msg = await rejects(() => connectProvider({ url: SESSION.url, token: " " }, { provider: "coinglass", label: "x", apiKey: SECRET }));
  ok("connectProvider needs a token", !!msg && !called);

  // posts provider, label and key; returns the profile; no extra fields; key never in a URL or storage
  const store = new Map();
  const writes = [];
  const fakeStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { writes.push(`${k}=${v}`); store.set(k, String(v)); }, removeItem: (k) => store.delete(k), clear: () => store.clear(), key: () => null, length: 0 };
  Object.defineProperty(globalThis, "localStorage", { value: fakeStorage, configurable: true, writable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: fakeStorage, configurable: true, writable: true });
  let seen = null;
  const profile = { id: "p1", kind: "provider", provider: "coinglass", label: "CG", maskedKey: "SECR…3456", connectedAt: "2026-11-16T00:00:00.000Z" };
  mockFetch(async (url, init) => { seen = { url: String(url), init }; return json(200, { profile }); });
  const got = await connectProvider(SESSION, { provider: "coinglass", label: "CG", apiKey: SECRET });
  const body = JSON.parse(seen.init.body);
  ok("connectProvider posts to /providers/connect with bearer", seen.url === "http://127.0.0.1:8787/providers/connect" && seen.init.method === "POST" && seen.init.headers.Authorization === "Bearer tok");
  ok("connectProvider body has exactly provider, label, apiKey", JSON.stringify(Object.keys(body).sort()) === JSON.stringify(["apiKey", "label", "provider"]) && body.apiKey === SECRET);
  ok("connectProvider returns the profile", got.id === "p1" && got.kind === "provider" && got.maskedKey === "SECR…3456");
  ok("the key is not in the URL", !seen.url.includes(SECRET));
  ok("the key is never written to storage", store.size === 0 && ![...store.values()].some((v) => v.includes(SECRET)) && !writes.some((w) => w.includes(SECRET)));
  ok("the returned profile carries no key", !JSON.stringify(got).includes(SECRET));

  // a malformed profile is refused
  mockFetch(async () => json(200, { profile: { id: "p", kind: "exchange" } }));
  msg = await rejects(() => connectProvider(SESSION, { provider: "coinglass", label: "CG", apiKey: SECRET }));
  ok("connectProvider refuses a malformed profile", !!msg && !msg.includes(SECRET));

  // gateway error text is surfaced without the key
  mockFetch(async () => json(400, { error: "Bad key." }));
  msg = await rejects(() => connectProvider(SESSION, { provider: "coinglass", label: "CG", apiKey: SECRET }));
  ok("connectProvider surfaces the gateway error", msg === "Bad key.");

  // list and disconnect
  mockFetch(async (url) => json(200, { profiles: [profile, { id: 5 }, { ...profile, id: "p2", provider: "bogus" }] }));
  const list = await listProviders(SESSION);
  ok("listProviders keeps only valid provider profiles", list.length === 1 && list[0].id === "p1");
  mockFetch(async (url, init) => { seen = { url: String(url), init }; return json(200, { ok: true }); });
  await disconnectProvider(SESSION, "a/b");
  ok("disconnectProvider DELETEs the encoded id", seen.url === "http://127.0.0.1:8787/providers/a%2Fb" && seen.init.method === "DELETE");

  // fetchEtfLive revalidates
  const day = (date, flows) => ({ date, totalUsd: 0, flows });
  mockFetch(async (url) => {
    seen = { url: String(url) };
    return json(200, {
      asOf: 1_700_000_000_000,
      btc: [
        day("2026-11-14", [{ ticker: "IBIT", flowUsd: 100 }, { ticker: "<img>", flowUsd: 5 }, { ticker: "FBTC", flowUsd: 1e30 }, { ticker: "ARKB", flowUsd: Infinity }, { ticker: "GBTC", flowUsd: -40 }]),
        day("2026-11-15", [{ ticker: "<img>", flowUsd: 5 }]),
        day("bad-date", [{ ticker: "IBIT", flowUsd: 1 }]),
        day("2026-11-13", Array.from({ length: 25 }, (_, i) => ({ ticker: `T${i}`, flowUsd: 1 }))),
      ],
      eth: Array.from({ length: 40 }, (_, i) => day(new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10), [{ ticker: "ETHA", flowUsd: 2 }])),
    });
  });
  const etf = await fetchEtfLive(LINK, new AbortController().signal);
  ok("fetchEtfLive calls /providers/etf-flows", seen.url === "http://127.0.0.1:8787/providers/etf-flows");
  const d14 = etf.btc.find((d) => d.date === "2026-11-14");
  ok("fetchEtfLive drops <img> ticker and 1e30/Infinity flows", d14 && d14.flows.length === 2 && d14.flows.every((f) => /^[A-Z0-9]{1,8}$/.test(f.ticker) && Math.abs(f.flowUsd) <= 1e11));
  ok("fetchEtfLive recomputes totalUsd from kept flows", d14.totalUsd === 60);
  ok("fetchEtfLive drops a day with no valid flows and a bad date", !etf.btc.some((d) => d.date === "2026-11-15" || d.date === "bad-date"));
  ok("fetchEtfLive caps 20 tickers per day", etf.btc.find((d) => d.date === "2026-11-13").flows.length === 20);
  ok("fetchEtfLive caps 30 days, keeping the newest", etf.eth.length === 30 && etf.eth[0].date === "2026-09-11" && etf.eth[29].date === "2026-10-10");
  ok("fetchEtfLive keeps asOf", etf.asOf === 1_700_000_000_000);
  // M2: sorted ascending, dedupe by date and by ticker (last wins) before the caps
  mockFetch(async () => json(200, { asOf: 1, btc: [
    day("2026-11-03", [{ ticker: "A", flowUsd: 3 }]),
    day("2026-11-01", [{ ticker: "A", flowUsd: 1 }, { ticker: "B", flowUsd: 2 }, { ticker: "A", flowUsd: 10 }]),
    day("2026-11-03", [{ ticker: "Z", flowUsd: 9 }]),
    day("2026-11-02", [{ ticker: "A", flowUsd: 5 }]),
  ], eth: [] }));
  const srt = await fetchEtfLive(LINK, new AbortController().signal);
  ok("fetchEtfLive sorts days ascending and dedupes dates (last wins)", srt.btc.map((d) => d.date).join() === "2026-11-01,2026-11-02,2026-11-03" && srt.btc[2].flows[0].ticker === "Z");
  const d1 = srt.btc[0];
  ok("fetchEtfLive dedupes tickers within a day (last wins) and totals them", d1.flows.length === 2 && d1.flows.find((f) => f.ticker === "A").flowUsd === 10 && d1.totalUsd === 12);
  mockFetch(async () => json(200, { asOf: 1, btc: [day("2026-11-01", Array.from({ length: 30 }, (_, i) => ({ ticker: `T${i % 22}`, flowUsd: 1 })))], eth: [] }));
  ok("ticker cap applies after the dedupe", (await fetchEtfLive(LINK, new AbortController().signal)).btc[0].flows.length === 20);
  mockFetch(async () => json(200, { nope: true }));
  msg = await rejects(() => fetchEtfLive(LINK, new AbortController().signal));
  ok("fetchEtfLive maps a malformed answer to unavailable", msg === "gateway:unavailable");

  // fetchWhaleAlerts
  const alert = { t: 1_700_000_000_000, chain: "bitcoin", kind: "transfer", from: "a", to: "b", symbol: "BTC", amount: 10, valueUsd: 1e6, hash: "abc123" };
  mockFetch(async (url) => {
    seen = { url: String(url) };
    return json(200, {
      connected: true,
      alerts: [
        alert,
        { ...alert, chain: "<b>" },
        { ...alert, t: -1 },
        { ...alert, valueUsd: 1e13 },
        { ...alert, amount: 0 },
        { ...alert, hash: "has space" },
        { ...alert, from: "x\u0000y" },
        { ...alert, to: "z".repeat(81) },
        { ...alert, hash: "" },
        "junk",
      ],
    });
  });
  const wa = await fetchWhaleAlerts(LINK, 2_500_000, new AbortController().signal);
  ok("fetchWhaleAlerts passes min in the query", seen.url === "http://127.0.0.1:8787/providers/whale-alerts?min=2500000");
  ok("fetchWhaleAlerts keeps valid alerts only", wa.connected === true && wa.alerts.length === 2 && wa.alerts[0].hash === "abc123" && wa.alerts[1].hash === "");
  mockFetch(async () => json(200, { connected: true, alerts: Array.from({ length: 250 }, () => alert) }));
  const many = await fetchWhaleAlerts(LINK, 1e6, new AbortController().signal);
  ok("fetchWhaleAlerts caps 200 alerts", many.alerts.length === 200);
  mockFetch(async () => json(200, { connected: "yes", alerts: [] }));
  const nc = await fetchWhaleAlerts(LINK, 1e6, new AbortController().signal);
  ok("fetchWhaleAlerts connected is strictly boolean", nc.connected === false);

  // error mapping
  mockFetch(async () => json(401, { error: "Unauthorized with upstream text" }));
  ok("fetchWhaleAlerts maps 401 to gateway:401", (await rejects(() => fetchWhaleAlerts(LINK, 1e6, new AbortController().signal))) === "gateway:401");
  ok("fetchEtfLive maps 401 to gateway:401", (await rejects(() => fetchEtfLive(LINK, new AbortController().signal))) === "gateway:401");
  mockFetch(async () => json(409, {}));
  ok("fetchEtfLive maps 409 to gateway:409", (await rejects(() => fetchEtfLive(LINK, new AbortController().signal))) === "gateway:409");
  ok("fetchWhaleAlerts maps 409 to gateway:409", (await rejects(() => fetchWhaleAlerts(LINK, 1e6, new AbortController().signal))) === "gateway:409");
  mockFetch(async () => json(502, {}));
  ok("a 502 maps to gateway:unavailable", (await rejects(() => fetchEtfLive(LINK, new AbortController().signal))) === "gateway:unavailable");
  mockFetch(async () => { throw new Error(`boom ${SECRET}`); });
  msg = await rejects(() => fetchWhaleAlerts(LINK, 1e6, new AbortController().signal));
  ok("a network error maps to gateway:unavailable without its text", msg === "gateway:unavailable");
  const aborted = new AbortController();
  aborted.abort();
  mockFetch(async (_u, init) => { if (init.signal.aborted) throw new Error("aborted"); return json(200, {}); });
  ok("the caller's signal is combined", (await rejects(() => fetchEtfLive(LINK, aborted.signal))) === "gateway:unavailable");
  // M1: no AbortSignal.any (older webviews)
  try {
    delete AbortSignal.any;
    ok("AbortSignal.any is really absent for the fallback test", typeof AbortSignal.any !== "function");
    let sig = null;
    mockFetch(async (_u, init) => { sig = init.signal; return json(200, { asOf: 1, btc: [], eth: [] }); });
    const okRes = await fetchEtfLive(LINK, new AbortController().signal);
    ok("fallback without AbortSignal.any still fetches", okRes.asOf === 1 && !!sig);
    const ac = new AbortController();
    mockFetch(async (_u, init) => new Promise((_res, rej) => { init.signal.addEventListener("abort", () => rej(new Error("aborted"))); ac.abort(); }));
    ok("fallback honours the caller's signal", (await rejects(() => fetchEtfLive(LINK, ac.signal))) === "gateway:unavailable");
    const pre = new AbortController();
    pre.abort();
    mockFetch(async (_u, init) => { if (init.signal.aborted) throw new Error("aborted"); return json(200, {}); });
    ok("fallback honours an already-aborted signal", (await rejects(() => fetchEtfLive(LINK, pre.signal))) === "gateway:unavailable");
  } finally {
    AbortSignal.any = realAny;
  }
  ok("AbortSignal.any restored", AbortSignal.any === realAny);
  called = false;
  mockFetch(async () => { called = true; return json(200, {}); });
  msg = await rejects(() => fetchEtfLive({ session: { url: "http://evil.example", token: "t" }, providers: [] }, new AbortController().signal));
  ok("fetch helpers refuse a non-loopback gateway", msg === "gateway:unavailable" && !called);
  // 401 and network failures on connect/list/disconnect use fixed codes
  mockFetch(async () => json(401, { error: "Unauthorized" }));
  ok("connectProvider maps 401 to gateway:401", (await rejects(() => connectProvider(SESSION, { provider: "coinglass", label: "x", apiKey: SECRET }))) === "gateway:401");
  ok("listProviders maps 401 to gateway:401", (await rejects(() => listProviders(SESSION))) === "gateway:401");
  ok("disconnectProvider maps 401 to gateway:401", (await rejects(() => disconnectProvider(SESSION, "p1"))) === "gateway:401");
  mockFetch(async () => { throw new TypeError("Failed to fetch"); });
  ok("disconnectProvider maps a network error to gateway:unavailable", (await rejects(() => disconnectProvider(SESSION, "p1"))) === "gateway:unavailable");
  ok("listProviders maps a network error to gateway:unavailable", (await rejects(() => listProviders(SESSION))) === "gateway:unavailable");

  // nextProviderLink: pure link transitions (I1, I2)
  const P1 = { id: "p1", kind: "provider", provider: "coinglass", label: "CG", maskedKey: "a…b", connectedAt: "t" };
  const P2 = { ...P1, id: "p2", provider: "whale-alert" };
  const S2 = { url: SESSION.url, token: "other" };
  const l0 = nextProviderLink(null, { type: "connected", session: SESSION, profile: P1 });
  ok("connect ok creates a link with the profile", l0?.providers.length === 1 && l0.session.token === "tok");
  const l1 = nextProviderLink(l0, { type: "connected", session: SESSION, profile: P2 });
  ok("connect ok adds the profile locally", l1?.providers.map((p) => p.id).join() === "p1,p2");
  ok("connect ok does not duplicate an id", nextProviderLink(l1, { type: "connected", session: SESSION, profile: P2 })?.providers.length === 2);
  ok("connect ok on a different session replaces the link", nextProviderLink(l1, { type: "connected", session: S2, profile: P1 })?.providers.length === 1);
  ok("disconnect ok removes the id", nextProviderLink(l1, { type: "disconnected", id: "p1" })?.providers.map((p) => p.id).join() === "p2");
  ok("disconnect ok of the last one gives null", nextProviderLink(l0, { type: "disconnected", id: "p1" }) === null);
  ok("disconnect with no link stays null", nextProviderLink(null, { type: "disconnected", id: "p1" }) === null);
  ok("gateway lost (401 or network) clears the link", nextProviderLink(l1, { type: "gateway-lost" }) === null);
  ok("a check against the same session keeps the link", nextProviderLink(l1, { type: "checked", session: { url: "http://127.0.0.1:8787/", token: " tok " } }) === l1);
  ok("a check against a different token clears the stale link", nextProviderLink(l1, { type: "checked", session: S2 }) === null);
  const l3 = nextProviderLink(l1, { type: "listed", session: S2, providers: [P2] });
  ok("a re-list replaces the link with the fresh session's list", l3?.session.token === "other" && l3.providers.length === 1);
  ok("an empty re-list gives null", nextProviderLink(l1, { type: "listed", session: SESSION, providers: [] }) === null);
  // a failed re-list dispatches nothing: the local result stands
  const afterDisc = nextProviderLink(l1, { type: "disconnected", id: "p1" });
  ok("a failed re-list leaves the local result in place", afterDisc?.providers.length === 1);
} finally {
  globalThis.fetch = realFetch;
  AbortSignal.any = realAny;
  restoreProp("localStorage", realLocal);
  restoreProp("sessionStorage", realSession);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
