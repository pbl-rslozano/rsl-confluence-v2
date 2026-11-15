// Fund trend daily-bar feed (v2.8 WP21, Task 2). Run: node scripts/run-engine-tests.mjs fund-trend-feed.test.mjs
// No test touches the network: the fetcher and the store are stubs, the clock is injected.
import { loadDailyBars, loadFundTrends, resetFundTrendFeedForTests, DAY_MS } from "./fund-trend-feed.ts";
import { RateLimitError, rateLimitCooldown, resetRateLimitForTests, noteVenueRateLimit } from "./market-client.ts";

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log("  ok   - " + name); }
  else { failed++; console.log("  FAIL - " + name + (extra ? "  [" + extra + "]" : "")); }
};

const D0 = Date.UTC(2026, 10, 15); // 15 Nov 2026 00:00 UTC
const bar = (time, i) => ({ time, open: 100 + i * 0.1, high: 101 + i * 0.1, low: 99 + i * 0.1, close: 100 + i * 0.1 + Math.sin(i) , volume: 10 });
/** `n` daily bars whose newest bar OPENED at `lastOpen`. */
const series = (n, lastOpen) => Array.from({ length: n }, (_, i) => bar(lastOpen - (n - 1 - i) * DAY_MS, i));

function stubs({ failOn = null, rateLimitOn = null } = {}) {
  const store = new Map(); const days = new Map(); const requests = [];
  let ctr = 0;
  return {
    requests,
    deps: {
      async fetchSeries(source, interval, symbol, bars, signal, plan, merge) {
        requests.push({ symbol, plan: plan ? { ...plan } : null, bars });
        ctr++;
        if (signal?.aborted) throw new DOMException("x", "AbortError");
        if (rateLimitOn && symbol === rateLimitOn) throw new RateLimitError("429", 30_000);
        if (failOn && symbol === failOn) throw new Error("HTTP 500");
        const now = stubs.now;
        // newest closed bar opened yesterday; the bar still building (today) is returned too, like a venue does.
        const todayOpen = Math.floor(now / DAY_MS) * DAY_MS;
        if (plan && merge) {
          const fresh = []; for (let t = plan.overlapOpenTime; t <= todayOpen; t += DAY_MS) fresh.push(bar(t, Math.round((t - D0) / DAY_MS) + 5000));
          const stored = store.get(symbol);
          // overlap bar must equal the stored one so the merge accepts it
          fresh[0] = stored.find((b) => b.time === plan.overlapOpenTime);
          const m = merge(fresh, plan.overlapOpenTime);
          if (m) return m;
        }
        return series(1000, todayOpen); // includes the open bar
      },
      load: async (s, sym) => store.get(sym) ?? [],
      save: async (s, sym, bars) => { store.set(sym, bars); },
      loadDay: async (s, sym) => days.get(sym) ?? null,
      saveDay: async (s, sym, d) => { days.set(sym, d); },
    },
  };
}

async function main() {
  console.log("fund-trend feed");
  const SRC = "binance";

  // fetches daily bars once per UTC day
  {
    resetFundTrendFeedForTests();
    const t = stubs(); const now1 = D0 + 3_600_000; stubs.now = now1;
    const a = await loadDailyBars(SRC, "BTCUSDT", now1, undefined, t.deps);
    const b = await loadDailyBars(SRC, "BTCUSDT", now1 + 5 * 3_600_000, undefined, t.deps);
    ok("two calls on the same UTC day make 1 request", t.requests.length === 1, JSON.stringify(t.requests.length));
    ok("full 1,000-bar request the first time (no stored series)", t.requests[0].plan === null && t.requests[0].bars === 1000);
    ok("bars are closed daily bars, newest last (open bar dropped)", a.length === 999 && a[a.length - 1].time === D0 - DAY_MS && b.length === 999);
    // stored marker survives a fresh page (memory cleared)
    resetFundTrendFeedForTests();
    await loadDailyBars(SRC, "BTCUSDT", now1 + 6 * 3_600_000, undefined, t.deps);
    ok("the stored UTC-day marker prevents a second request after the in-memory cache is gone", t.requests.length === 1);

    // cache refreshes after the UTC day changes
    const now2 = D0 + DAY_MS + 60_000; stubs.now = now2;
    const c = await loadDailyBars(SRC, "BTCUSDT", now2, undefined, t.deps);
    ok("a call after 00:00 UTC the next day makes a delta request", t.requests.length === 2 && t.requests[1].plan && t.requests[1].plan.limit >= 2, JSON.stringify(t.requests[1]));
    ok("the new closed daily bar is included and the open bar is dropped", c[c.length - 1].time === D0 && c.every((x) => x.time + DAY_MS <= now2), String(c[c.length - 1]?.time - D0));
    ok("the series stays contiguous after the delta merge", c.every((x, i) => i === 0 || x.time - c[i - 1].time === DAY_MS));
  }

  // non-crypto rows are n/a without requests
  {
    resetFundTrendFeedForTests();
    const t = stubs(); stubs.now = D0 + 1000;
    const seen = [];
    const m = await loadFundTrends(SRC, [{ symbol: "AAPLUSDT", ac: "stock" }, { symbol: "EURUSD", ac: "fx" }, { symbol: "XAUUSDT", ac: "commodity" }, { symbol: "TSLAx", ac: "rwa" }],
      D0 + 1000, { deps: t.deps, onValue: (s, v) => seen.push(s) });
    ok("non-crypto rows are { na: class } with no request", t.requests.length === 0 && [...m.values()].every((v) => v.na === "class") && m.size === 4 && seen.length === 4);
  }

  // crypto row values and history / error mapping
  {
    resetFundTrendFeedForTests();
    const t = stubs({ failOn: "BADUSDT" }); stubs.now = D0 + 1000;
    const m = await loadFundTrends(SRC, [{ symbol: "BTCUSDT", ac: "crypto" }, { symbol: "BADUSDT", ac: "crypto" }], D0 + 1000, { deps: t.deps });
    const v = m.get("BTCUSDT");
    ok("a crypto row with 999 closed bars gets a Fund trend value", v && typeof v.value === "number" && v.value >= -100 && v.value <= 100, JSON.stringify(v));
    ok("a fetch failure other than 429 is { na: error }", m.get("BADUSDT")?.na === "error");
    // short history -> history
    resetFundTrendFeedForTests();
    const short = stubs(); short.deps.fetchSeries = async () => series(100, D0 - DAY_MS);
    const m2 = await loadFundTrends(SRC, [{ symbol: "NEWUSDT", ac: "crypto" }], D0 + 1000, { deps: short.deps });
    ok("fewer than 366 closed bars is { na: history }", m2.get("NEWUSDT")?.na === "history");
  }

  // 429 halts daily loading
  {
    resetFundTrendFeedForTests(); resetRateLimitForTests();
    const t = stubs({ rateLimitOn: "P3" }); stubs.now = D0 + 1000;
    const rows = ["P1", "P2", "P3", "P4", "P5"].map((symbol) => ({ symbol, ac: "crypto" }));
    const m = await loadFundTrends(SRC, rows, D0 + 1000, { deps: t.deps });
    ok("429 on pair 3 of 5: values for 1-2", typeof m.get("P1")?.value === "number" && typeof m.get("P2")?.value === "number");
    ok("429 on pair 3 of 5: pairs 3-5 are { na: loading }", ["P3", "P4", "P5"].every((s) => m.get(s)?.na === "loading"), JSON.stringify([...m]));
    ok("nothing is requested after the batch that hit the 429", !t.requests.some((r) => r.symbol === "P5"), JSON.stringify(t.requests.map((r) => r.symbol)));
    ok("the venue cooldown is set", rateLimitCooldown(SRC) > 0);
    resetRateLimitForTests();
  }

  // switching source aborts the feed
  {
    resetFundTrendFeedForTests();
    const t = stubs(); stubs.now = D0 + 1000;
    const ctl = new AbortController();
    const values = [];
    const slow = { ...t.deps, fetchSeries: async (...a) => { await new Promise((r) => setTimeout(r, 5)); return t.deps.fetchSeries(...a); } };
    const rows = Array.from({ length: 8 }, (_, i) => ({ symbol: `Q${i}`, ac: "crypto" }));
    const p = loadFundTrends(SRC, rows, D0 + 1000, { deps: slow, signal: ctl.signal, onValue: (s, v) => values.push(s) });
    setTimeout(() => ctl.abort(), 8);
    let err = null; try { await p; } catch (e) { err = e; }
    const n = t.requests.length;
    await new Promise((r) => setTimeout(r, 50));
    ok("abort rejects with AbortError", err && err.name === "AbortError");
    ok("nothing is requested or emitted after the abort", t.requests.length === n && n < 8 && values.length <= n);
  }

  // I-1: an already-active venue cooldown makes no request (the 429 halt path)
  {
    resetFundTrendFeedForTests(); resetRateLimitForTests();
    const t = stubs(); stubs.now = D0 + 1000;
    noteVenueRateLimit("binance", new RateLimitError("429", 60_000));
    const m = await loadFundTrends(SRC, ["C1", "C2", "C3"].map((symbol) => ({ symbol, ac: "crypto" })), D0 + 1000, { deps: t.deps });
    ok("active cooldown makes no request", t.requests.length === 0, JSON.stringify(t.requests));
    ok("active cooldown: every row is { na: loading }", ["C1", "C2", "C3"].every((s) => m.get(s)?.na === "loading"), JSON.stringify([...m]));
    resetRateLimitForTests();
  }

  // M3: joining an in-flight job that was aborted under another signal starts one fresh fetch
  {
    resetFundTrendFeedForTests();
    const t = stubs(); stubs.now = D0 + 1000;
    const a = new AbortController();
    let gate; const held = new Promise((r) => { gate = r; });
    const slow = { ...t.deps, fetchSeries: async (...args) => { if (t.requests.length === 0) { t.requests.push({ symbol: "J", plan: null, bars: 1000 }); await held; } return t.deps.fetchSeries(...args); } };
    const first = loadDailyBars(SRC, "JUSDT", D0 + 1000, a.signal, slow).catch((e) => e);
    await new Promise((r) => setTimeout(r, 2));
    const second = loadDailyBars(SRC, "JUSDT", D0 + 1000, undefined, slow); // joins the first job
    a.abort(); gate();
    const r1 = await first; const r2 = await second;
    ok("the aborted starter gets AbortError", r1 && r1.name === "AbortError");
    ok("a joiner whose own signal is live gets bars from a fresh fetch", Array.isArray(r2) && r2.length === 999, String(r2));
  }

  // M7: the UTC-day marker is saved only when the series save succeeded
  {
    resetFundTrendFeedForTests();
    const t = stubs(); stubs.now = D0 + 1000;
    let marked = 0;
    const deps = { ...t.deps, save: async () => { throw new Error("quota"); }, saveDay: async () => { marked++; } };
    await loadDailyBars(SRC, "SUSDT", D0 + 1000, undefined, deps);
    ok("no marker when the series save failed", marked === 0);
    const deps2 = { ...t.deps, saveDay: async () => { marked++; } };
    resetFundTrendFeedForTests();
    await loadDailyBars(SRC, "SUSDT", D0 + 1000, undefined, deps2);
    ok("marker saved after a successful series save", marked === 1);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
main();
