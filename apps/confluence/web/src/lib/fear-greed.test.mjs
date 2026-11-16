// Crypto Fear & Greed Index data module — v2.8 WP29 (Task 1).
// Run: npm run test:fng   (node scripts/run-engine-tests.mjs fear-greed.test.mjs)
//
// Fixtures follow the live sample of 16 Nov 2026 (docs/research/evidence/wp29-fng-probe-2026-11-16.json): newest row first,
// value and timestamp as strings, `time_until_update` on the newest row only. The numbers are generated.
import { FNG_CACHE_ID, FNG_COLORS, FNG_TTL_MS, FNG_URL, fetchFng, fngBand, isFngFresh, loadFngCache, parseFng, saveFngCache } from "./fear-greed.ts";

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} ${extra}`); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const DAY = 86_400;
const NOW = 1794787200 * 1000 + 3_600_000; // 16 Nov 2026 01:00 UTC
const row = (value, ts, cls = "Fear", extra = {}) => ({ value, value_classification: cls, timestamp: ts, ...extra });
const body = (data, error = null) => ({ name: "Fear and Greed Index", data, metadata: { error } });
const response = (b, status = 200) => new Response(typeof b === "string" ? b : JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

try {
  ok("FNG_URL is the verbatim endpoint", FNG_URL === "https://api.alternative.me/fng/?limit=31&format=json");
  ok("cache constants", FNG_CACHE_ID === "fng-cache" && FNG_TTL_MS === 3_600_000);

  /* ---------- parse ---------- */
  { const d = parseFng(body([row("10", "1794787200", "Extreme Fear", { time_until_update: "37530" }), row("30", String(1794787200 - DAY), "Fear"), row("55", String(1794787200 - 2 * DAY), "Neutral")]), NOW);
    ok("parses newest-first into oldest-first points", d && d.points.length === 3 && d.points[0].t < d.points[1].t && d.points[1].t < d.points[2].t);
    ok("values are numbers, t is ms at 00:00 UTC", d.points.every((p) => typeof p.value === "number" && p.t % 86_400_000 === 0) && d.points[2].t === 1794787200 * 1000 && d.points[2].value === 10);
    ok("bands and labels", same(d.points.map((p) => p.band), ["neutral", "fear", "extremeFear"]) && same(d.points.map((p) => p.label), ["Neutral", "Fear", "Extreme Fear"]));
    ok("asOf is the fetch time (now), not the newest point's day", d.asOf === NOW); }
  { const good = row("40", "1794700800");
    const bad = [row("101", "1794700800"), row("-1", "1794700800"), row("12.5", "1794700800"), row("abc", "1794700800"), row(null, "1794700800"),
      row("50", "0"), row("50", String(NOW / 1000 + 3 * DAY)), row("50", "x"), row("50", "1514764799"), null, "row", row("50", undefined)];
    const d = parseFng(body([...bad, good]), NOW);
    ok("drops invalid rows, keeps the valid one", d && d.points.length === 1 && d.points[0].value === 40, JSON.stringify(d));
    ok("accepts a numeric value and timestamp", parseFng(body([{ value: 40, value_classification: "Fear", timestamp: 1794700800 }]), NOW)?.points.length === 1);
    ok("a timestamp up to one day ahead is kept", parseFng(body([row("40", String(NOW / 1000 + DAY - 60))]), NOW)?.points.length === 1); }
  { const d = parseFng(body([row("70", "1794700900", "Greed"), row("20", "1794700800", "Extreme Fear")]), NOW);
    ok("dedupes by UTC day, last wins", d.points.length === 1 && d.points[0].value === 20 && d.points[0].label === "Extreme Fear"); }
  { const d = parseFng(body([row("80", "1794787200", "<b>Hype</b>")]), NOW);
    ok("unknown classification falls back to the band name", d.points[0].label === "Extreme Greed" && d.points[0].band === "extremeGreed"); }
  ok("a known label from the API is kept even if the band differs", parseFng(body([row("50", "1794787200", "Greed")]), NOW).points[0].label === "Greed");
  ok("metadata.error string -> null", parseFng(body([row("40", "1794787200")], "rate limit"), NOW) === null);
  ok("empty metadata.error is fine", parseFng(body([row("40", "1794787200")], ""), NOW) !== null);
  ok("no valid rows -> null", parseFng(body([row("999", "1794787200")]), NOW) === null);
  ok("junk input -> null, never throws", [null, undefined, 5, "x", [], {}, { data: "x" }, { data: [] }].every((j) => parseFng(j, NOW) === null));
  { const many = Array.from({ length: 40 }, (_, i) => row(String(i + 1), String(1794787200 - i * DAY)));
    const d = parseFng(body(many), NOW);
    ok("at most 31 points, newest kept", d.points.length === 31 && d.points[30].value === 1); }

  /* ---------- bands ---------- */
  ok("band edges", [[24, "extremeFear"], [25, "fear"], [44, "fear"], [45, "neutral"], [55, "neutral"], [56, "greed"], [75, "greed"], [76, "extremeGreed"], [0, "extremeFear"], [100, "extremeGreed"]].every(([v, b]) => fngBand(v) === b));
  ok("band colours (kit)", FNG_COLORS.extremeFear === "#fd5b70" && FNG_COLORS.fear === "#f59b6b" && FNG_COLORS.neutral === "#eccb77" && FNG_COLORS.greed === "#79d59e" && FNG_COLORS.extremeGreed === "#28cdb0");

  /* ---------- fetch ---------- */
  { const calls = [];
    const f = async (u, init) => { calls.push({ u, init }); return response(body([row("10", "1794787200", "Extreme Fear"), row("30", String(1794787200 - DAY))])); };
    const d = await fetchFng(undefined, f);
    ok("fetchFng returns parsed data", d.points.length === 2 && d.points[1].value === 10);
    ok("fetchFng url, no-store and a signal", calls.length === 1 && calls[0].u === FNG_URL && calls[0].init.cache === "no-store" && calls[0].init.signal instanceof AbortSignal); }
  { const e1 = await rejects(() => fetchFng(undefined, async () => response("nope", 500)));
    const e2 = await rejects(() => fetchFng(undefined, async () => response("{not json")));
    const e3 = await rejects(() => fetchFng(undefined, async () => response(body([row("999", "1794787200")]))));
    const e4 = await rejects(() => fetchFng(undefined, async () => { throw new TypeError("network down https://secret"); }));
    ok("HTTP 500, bad JSON, null parse and network failure -> fng:unavailable", [e1, e2, e3, e4].every((e) => e instanceof Error && e.message === "fng:unavailable"), [e1, e2, e3, e4].map((e) => e?.message).join("|")); }
  { const ac = new AbortController();
    const f = (u, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    const p = rejects(() => fetchFng(ac.signal, f));
    ac.abort();
    const e = await p;
    ok("the caller's signal aborts the request (fng:unavailable)", e?.message === "fng:unavailable"); }
  { const realAny = AbortSignal.any;
    try {
      delete AbortSignal.any;
      const d = await fetchFng(new AbortController().signal, async () => response(body([row("40", "1794787200")])));
      ok("fetchFng works without AbortSignal.any", d.points.length === 1 && typeof AbortSignal.any !== "function");
      const ac = new AbortController();
      const f = (u, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("x")), { once: true }));
      const p = rejects(() => fetchFng(ac.signal, f));
      ac.abort();
      ok("the fallback still honours the caller's signal", (await p)?.message === "fng:unavailable");
    } finally { AbortSignal.any = realAny; } }

  /* ---------- timeout (10 s) ---------- */
  { // The timer is faked: setTimeout/clearTimeout are swapped only around the call, so nothing waits 10 s.
    const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
    const timers = new Map();
    let nextId = 1;
    globalThis.setTimeout = (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; };
    globalThis.clearTimeout = (id) => { timers.delete(id); };
    try {
      let seenSignal = null;
      const hang = (u, init) => new Promise((_, reject) => { seenSignal = init.signal; init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }); });
      const p = rejects(() => fetchFng(undefined, hang));
      const pending = [...timers.values()];
      ok("one 10 s timer is armed for the request", pending.length === 1 && pending[0].ms === 10_000);
      ok("not aborted before the timer fires", seenSignal !== null && seenSignal.aborted === false);
      pending[0].fn(); // the 10 s elapse
      const e = await p;
      ok("a request that hangs past 10 s aborts and rejects with fng:unavailable", e instanceof Error && e.message === "fng:unavailable" && seenSignal.aborted === true);
      ok("the timer is cleared after the timeout path", timers.size === 0);
      const d = await fetchFng(undefined, async () => response(body([row("40", "1794787200")])));
      ok("a normal fetch clears its timer", d.points.length === 1 && timers.size === 0);
      // The timer also covers a body that never arrives.
      const slowBody = async (u, init) => ({ ok: true, json: () => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })) });
      const p2 = rejects(() => fetchFng(undefined, slowBody));
      await new Promise((r) => realSet(r, 0)); // let fetchFng reach the body read before the 10 s elapse
      [...timers.values()][0].fn();
      ok("the timeout covers the body read", (await p2)?.message === "fng:unavailable");
    } finally { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; } }

  /* ---------- cache ---------- */
  { const store = new Map();
    const port = { get: async (c, id) => store.get(`${c}/${id}`), put: async (c, id, doc) => { store.set(`${c}/${id}`, JSON.parse(JSON.stringify(doc))); } };
    const data = parseFng(body([row("10", "1794787200", "Extreme Fear"), row("30", String(1794787200 - DAY)), row("55", String(1794787200 - 2 * DAY), "Neutral")]), NOW);
    ok("load of nothing is null", (await loadFngCache(port, NOW)) === null);
    await saveFngCache(port, data);
    ok("saved in the meta store under fng-cache", store.has("meta/fng-cache") && FNG_CACHE_ID === "fng-cache");
    ok("cache round-trip", same(await loadFngCache(port, NOW), data));
    ok("fresh at 59 min, stale at 61 min", isFngFresh(data, data.asOf + 59 * 60_000) && !isFngFresh(data, data.asOf + 61 * 60_000));
    const doc = store.get("meta/fng-cache");
    doc.points[1].value = 500; doc.points.push({ t: "x" });
    store.set("meta/fng-cache", doc);
    const back = await loadFngCache(port, NOW);
    ok("a stored doc with a bad point loads without that point", back && back.points.length === 2 && back.points.every((p) => p.value <= 100));
    store.set("meta/fng-cache", { junk: true });
    ok("a junk doc loads as null", (await loadFngCache(port, NOW)) === null);
    ok("a throwing port loads as null", (await loadFngCache({ get: async () => { throw new Error("x"); }, put: async () => {} }, NOW)) === null); }
} finally {
  // nothing global is replaced: every fetch above uses an injected fetcher
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
