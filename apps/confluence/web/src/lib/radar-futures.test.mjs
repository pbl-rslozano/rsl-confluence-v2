// Binance USDⓈ-M futures positioning — v2.8 Step 4a (WP25, Task 1).
// Run: npm run test:radar-fut   (node scripts/run-engine-tests.mjs radar-futures.test.mjs)
//
// Fixtures: the REAL_* bodies are verbatim samples from the follow-up probe of RD-PROBE-1 (16 Nov 2026, from the
// deployed app's origin). The generators below keep the real field layout (rateType, CMCCirculatingSupply, no symbol on
// the taker rows) but their values are generated, to build edge cases (short histories, bad values).
import {
  fetchFuturesPositioning, fundingPercentile, oiChange24h, resetFuturesForTests, setFuturesClockForTests,
  FUTURES_GATE_LIMIT, FUTURES_GATE_WINDOW_MS,
} from "./radar/binance-futures.ts";
import {
  RateLimitError, fetchJson, resetRateLimitForTests, venueCooldown, noteVenueRateLimit, rateLimitCooldown, venueOf, FAPI_BASE,
} from "./market-client.ts";

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} ${extra}`); }
};
const near = (a, b, tol = 0.01) => typeof a === "number" && Math.abs(a - b) <= tol;
const realFetch = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 16, 3, 0, 0); // newest 1h sample

// ---- generated fixtures in the documented layout ----
const premium = (over = {}) => ({
  symbol: "BTCUSDT", markPrice: "66500.00000000", indexPrice: "66450.00000000", estimatedSettlePrice: "66460.1",
  lastFundingRate: "0.00010000", interestRate: "0.00010000", nextFundingTime: T0 + 5 * H, time: T0 + 1000, ...over,
});
const fundingHist = (n = 90) =>
  Array.from({ length: n }, (_, i) => ({ symbol: "BTCUSDT", fundingRate: String(0.00001 * (i + 1)), fundingTime: T0 - (n - i) * 8 * H, markPrice: "66000", rateType: "Regular" }));
const oiHist = (hours = 25, last = 1000) =>
  Array.from({ length: hours }, (_, i) => ({ symbol: "BTCUSDT", sumOpenInterest: String(last - (hours - 1 - i) * 2), sumOpenInterestValue: "66000000", CMCCirculatingSupply: "20112050.00000000", timestamp: T0 - (hours - 1 - i) * H }));
const lsr = (over = {}) => [{ symbol: "BTCUSDT", longShortRatio: "1.8105", longAccount: "0.6442", shortAccount: "0.3558", timestamp: T0 - 60_000, ...over }];
const taker = (over = {}) => [{ buySellRatio: "1.5586", sellVol: "248.5030", buyVol: "387.3300", timestamp: T0 - 30_000, ...over }];

/** Stub fetch: `routes` maps a path to a body, a number (HTTP status) or a function. Logs every URL. */
function stub(routes) {
  const seen = [];
  globalThis.fetch = async (input) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    seen.push(u);
    const r = routes[u.pathname];
    if (r === undefined) return json({ code: -1, msg: "unrouted" }, 404);
    if (typeof r === "number") return json({ code: -1, msg: "stub" }, r);
    return json(typeof r === "function" ? r(u) : r);
  };
  return seen;
}
const full = () => ({
  "/fapi/v1/premiumIndex": premium(),
  "/fapi/v1/fundingRate": fundingHist(),
  "/futures/data/openInterestHist": oiHist(),
  "/futures/data/globalLongShortAccountRatio": lsr(),
  "/futures/data/takerlongshortRatio": taker(),
});
const fresh = () => { resetRateLimitForTests(); resetFuturesForTests(); setFuturesClockForTests(null); };

try {
  // ---- pure helpers ----
  {
    const h = Array.from({ length: 90 }, (_, i) => i + 1);
    ok("funding percentile: 90 samples 1..90, current 45 -> 50", near(fundingPercentile(h, 45), 50));
    ok("funding percentile: 89 samples -> null", fundingPercentile(h.slice(0, 89), 45) === null);
    ok("funding percentile: current above all -> 100, below all -> 0", fundingPercentile(h, 1000) === 100 && fundingPercentile(h, 0) === 0);
    ok("funding percentile: non-finite current or sample -> null", fundingPercentile(h, NaN) === null && fundingPercentile([...h.slice(0, 89), NaN], 45) === null);
  }
  {
    const hist = oiHist(25, 1000).map((r) => ({ t: r.timestamp, oi: Number(r.sumOpenInterest) }));
    const newest = hist[hist.length - 1].oi;
    const old = hist[0].oi;
    ok("oi change: the 24 h earlier sample gives (new/old - 1) * 100", near(oiChange24h(hist), (newest / old - 1) * 100, 1e-9));
    ok("oi change: unsorted input is handled", near(oiChange24h([...hist].reverse()), (newest / old - 1) * 100, 1e-9));
    const short = oiHist(21, 1000).map((r) => ({ t: r.timestamp, oi: Number(r.sumOpenInterest) }));
    ok("oi change: only a 20 h span -> null", oiChange24h(short) === null);
    ok("oi change: a 23.5 h old sample is within +/- 1 h", near(oiChange24h([{ t: T0 - 23.5 * H, oi: 500 }, { t: T0, oi: 550 }]), 10, 1e-9));
    ok("oi change: a 22.5 h old sample is outside it", oiChange24h([{ t: T0 - 22.5 * H, oi: 500 }, { t: T0, oi: 550 }]) === null);
    ok("oi change: old sample 0 or negative -> null", oiChange24h([{ t: T0 - 24 * H, oi: 0 }, { t: T0, oi: 5 }]) === null && oiChange24h([{ t: T0 - 24 * H, oi: -3 }, { t: T0, oi: 5 }]) === null);
    ok("oi change: empty -> null", oiChange24h([]) === null);
  }

  // ---- the five endpoints ----
  {
    fresh();
    const seen = stub(full());
    const p = await fetchFuturesPositioning("BTCUSDT");
    const paths = seen.map((u) => u.pathname);
    ok("five GET requests, one per endpoint", seen.length === 5 && new Set(paths).size === 5 && seen.every((u) => u.origin === FAPI_BASE));
    ok("premiumIndex?symbol=BTCUSDT", seen.some((u) => u.pathname === "/fapi/v1/premiumIndex" && u.searchParams.get("symbol") === "BTCUSDT"));
    ok("fundingRate limit=90", seen.some((u) => u.pathname === "/fapi/v1/fundingRate" && u.searchParams.get("limit") === "90" && u.searchParams.get("symbol") === "BTCUSDT"));
    ok("openInterestHist period=1h limit=25", seen.some((u) => u.pathname === "/futures/data/openInterestHist" && u.searchParams.get("period") === "1h" && u.searchParams.get("limit") === "25"));
    ok("long/short and taker: period=1h limit=1", ["/futures/data/globalLongShortAccountRatio", "/futures/data/takerlongshortRatio"].every((x) => seen.some((u) => u.pathname === x && u.searchParams.get("period") === "1h" && u.searchParams.get("limit") === "1")));
    ok("no order endpoint, no key", seen.every((u) => !/order/i.test(u.pathname) && u.search.indexOf("sign") === -1));
    ok("fields are finite numbers", ["fundingRate", "fundingPctl30d", "oi", "oiChg24hPct", "longShortRatio", "takerBuySellRatio", "basisPct"].every((k) => Number.isFinite(p[k])), JSON.stringify(p));
    ok("symbol and funding rate", p.symbol === "BTCUSDT" && near(p.fundingRate, 0.0001, 1e-12));
    ok("funding percentile of 0.0001 in 0.00001..0.0009 = 10/90", near(p.fundingPctl30d, (10 / 90) * 100, 1e-6), String(p.fundingPctl30d));
    ok("oi is the newest sample, change vs 24 h earlier", near(p.oi, 1000) && near(p.oiChg24hPct, (1000 / 952 - 1) * 100, 1e-9), `${p.oi} ${p.oiChg24hPct}`);
    ok("ratios", near(p.longShortRatio, 1.8105, 1e-9) && near(p.takerBuySellRatio, 1.5586, 1e-9));
    ok("basis from mark / index", near(p.basisPct, (66500 / 66450 - 1) * 100, 1e-9));
    ok("asOf = the newest data timestamp", p.asOf === T0 + 1000, String(p.asOf));
    ok("ETHUSDT is accepted; another symbol is refused", await fetchFuturesPositioning("ETHUSDT").then(() => true, () => false)
      && await fetchFuturesPositioning("BTCUSDT&x=1").then(() => false, () => true));
  }

  // ---- one failing endpoint, bad values ----
  {
    fresh();
    stub({ ...full(), "/futures/data/globalLongShortAccountRatio": 500 });
    let p = null, threw = false;
    try { p = await fetchFuturesPositioning("BTCUSDT"); } catch { threw = true; }
    ok("500 on long/short: no throw", !threw && p !== null);
    ok("500 on long/short: that field null, the others filled", p?.longShortRatio === null && Number.isFinite(p?.fundingRate) && Number.isFinite(p?.oi) && Number.isFinite(p?.takerBuySellRatio) && Number.isFinite(p?.basisPct));
  }
  {
    fresh();
    const base = stub(full());
    const inner = globalThis.fetch;
    globalThis.fetch = async (i, o) => (new URL(typeof i === "string" ? i : i.url).pathname === "/futures/data/takerlongshortRatio" ? new Response("<html>", { status: 200 }) : inner(i, o));
    void base;
    const p = await fetchFuturesPositioning("BTCUSDT");
    ok("unreadable body: that field null, no throw", p.takerBuySellRatio === null && Number.isFinite(p.longShortRatio));
  }
  {
    fresh();
    stub({
      ...full(),
      "/fapi/v1/premiumIndex": premium({ markPrice: "NaN", lastFundingRate: "NaN" }),
      "/futures/data/openInterestHist": oiHist().map((r, i, a) => (i === a.length - 1 ? { ...r, sumOpenInterest: "-5" } : r)),
      "/futures/data/globalLongShortAccountRatio": lsr({ longShortRatio: "NaN" }),
      "/futures/data/takerlongshortRatio": taker({ buySellRatio: "-1" }),
    });
    const p = await fetchFuturesPositioning("BTCUSDT");
    ok("string NaN funding -> funding and percentile null", p.fundingRate === null && p.fundingPctl30d === null);
    ok("NaN mark -> basis null", p.basisPct === null);
    ok("negative OI -> oi and change null", p.oi === null && p.oiChg24hPct === null);
    ok("NaN and negative ratios -> null", p.longShortRatio === null && p.takerBuySellRatio === null);
  }
  {
    fresh();
    stub({ ...full(), "/fapi/v1/fundingRate": fundingHist(89) });
    const p = await fetchFuturesPositioning("BTCUSDT");
    ok("89 funding samples -> percentile null, rate still set", p.fundingPctl30d === null && Number.isFinite(p.fundingRate));
  }
  {
    fresh();
    stub({});
    ok("every endpoint failing -> throws", await fetchFuturesPositioning("BTCUSDT").then(() => false, () => true));
  }

  // ---- newest OI sample decides ----
  for (const bad of ["NaN", "abc", "-5", ""]) {
    fresh();
    stub({ ...full(), "/futures/data/openInterestHist": oiHist().map((r, i, a) => (i === a.length - 1 ? { ...r, sumOpenInterest: bad } : r)) });
    const p = await fetchFuturesPositioning("BTCUSDT");
    ok(`newest OI "${bad}" -> oi and change null, not an older sample`, p.oi === null && p.oiChg24hPct === null, `${p.oi} ${p.oiChg24hPct}`);
  }
  {
    fresh();
    // unsorted input: the newest by timestamp is bad, whatever its position
    stub({ ...full(), "/futures/data/openInterestHist": oiHist().map((r, i, a) => (i === a.length - 1 ? { ...r, sumOpenInterest: "NaN" } : r)).reverse() });
    const p = await fetchFuturesPositioning("BTCUSDT");
    ok("newest OI bad in an unsorted list -> null", p.oi === null && p.oiChg24hPct === null);
  }
  {
    fresh();
    stub({ ...full(), "/futures/data/openInterestHist": oiHist().map((r, i) => (i <= 1 ? { ...r, sumOpenInterest: "NaN" } : r)) });
    const p = await fetchFuturesPositioning("BTCUSDT");
    ok("bad OLD samples (24 h and 23 h back) only lose the change", Number.isFinite(p.oi) && p.oiChg24hPct === null);
  }

  // ---- real sample bodies (probe RD-PROBE-1, follow-up from the app origin) ----
  {
    fresh();
    const REAL_PREMIUM = { symbol: "BTCUSDT", markPrice: "64944.91491304", indexPrice: "64979.37652174", estimatedSettlePrice: "65078.08558540", lastFundingRate: "-0.00001816", interestRate: "0.00010000", nextFundingTime: 1794816000000, time: 1794800426000 };
    const REAL_FUNDING_ROW = { symbol: "BTCUSDT", fundingTime: 1794729600000, fundingRate: "0.00002303", markPrice: "63988.60882309", rateType: "Regular" };
    const REAL_OI_ROW = { symbol: "BTCUSDT", sumOpenInterest: "93828.19300000", sumOpenInterestValue: "6062644075.84702600", CMCCirculatingSupply: "20112050.00000000", timestamp: 1794794400000 };
    const REAL_LS = [{ symbol: "BTCUSDT", longShortRatio: "2.9154", longAccount: "0.7446", shortAccount: "0.2554", timestamp: 1794798000000 }];
    const REAL_TAKER = [{ buySellRatio: "1.1088", sellVol: "3856.5760", buyVol: "4276.0310", timestamp: 1794794400000 }];
    // 90 funding rows 8 h apart ending at the real row, 25 hourly OI rows ending at the real row; real rows are the newest
    const f = Array.from({ length: 90 }, (_, i) => ({ ...REAL_FUNDING_ROW, fundingTime: REAL_FUNDING_ROW.fundingTime - (89 - i) * 8 * H, fundingRate: i === 89 ? REAL_FUNDING_ROW.fundingRate : String(0.00001 * (i % 40)) }));
    const o = Array.from({ length: 25 }, (_, i) => ({ ...REAL_OI_ROW, timestamp: REAL_OI_ROW.timestamp - (24 - i) * H, sumOpenInterest: i === 24 ? REAL_OI_ROW.sumOpenInterest : "90000.000" }));
    stub({ "/fapi/v1/premiumIndex": REAL_PREMIUM, "/fapi/v1/fundingRate": f, "/futures/data/openInterestHist": o, "/futures/data/globalLongShortAccountRatio": REAL_LS, "/futures/data/takerlongshortRatio": REAL_TAKER });
    const p = await fetchFuturesPositioning("BTCUSDT");
    ok("real bodies: negative funding rate, basis below zero", near(p.fundingRate, -0.00001816, 1e-12) && near(p.basisPct, (64944.91491304 / 64979.37652174 - 1) * 100, 1e-9) && p.basisPct < 0);
    ok("real bodies: oi, change vs 24 h earlier", near(p.oi, 93828.193, 1e-9) && near(p.oiChg24hPct, (93828.193 / 90000 - 1) * 100, 1e-9), String(p.oiChg24hPct));
    ok("real bodies: ratios (taker row has no symbol field)", near(p.longShortRatio, 2.9154, 1e-9) && near(p.takerBuySellRatio, 1.1088, 1e-9));
    ok("real bodies: asOf is the newest timestamp (premiumIndex time)", p.asOf === 1794800426000, String(p.asOf));
    ok("real bodies: funding percentile is a 0-100 number", Number.isFinite(p.fundingPctl30d) && p.fundingPctl30d >= 0 && p.fundingPctl30d <= 100);
  }
  {
    fresh();
    stub({ ...full(), "/fapi/v1/premiumIndex": 500, "/futures/data/openInterestHist": 500, "/futures/data/globalLongShortAccountRatio": [], "/futures/data/takerlongshortRatio": [] });
    const p = await fetchFuturesPositioning("BTCUSDT");
    ok("no data timestamp at all -> asOf 0, never the clock", p.asOf === 0, String(p.asOf));
  }

  // ---- cooldown is its own venue ----
  {
    fresh();
    stub({ ...full(), "/fapi/v1/premiumIndex": 429 });
    let err = null;
    try { await fetchFuturesPositioning("BTCUSDT"); } catch (e) { err = e; }
    ok("429 from fapi: RateLimitError", err instanceof RateLimitError, String(err));
    ok("429 from fapi: binance-fut cooling down", venueCooldown("binance-fut") > 0);
    ok("429 from fapi: spot binance untouched", rateLimitCooldown("binance") === 0 && venueCooldown("binance") === 0 && venueCooldown("bybit") === 0);
    const seen = stub(full());
    const again = await fetchFuturesPositioning("BTCUSDT").then(() => null, (e) => e);
    ok("a cooling venue makes no request and throws RateLimitError", again instanceof RateLimitError && seen.length === 0);
  }
  {
    fresh();
    stub({ ...full(), "/fapi/v1/premiumIndex": 418 });
    const err = await fetchFuturesPositioning("BTCUSDT").then(() => null, (e) => e);
    ok("418: RateLimitError with the 10 min default", err instanceof RateLimitError && err.retryAfterMs === 600_000);
  }
  {
    fresh();
    stub(full());
    noteVenueRateLimit("binance", new RateLimitError("spot 429", 60_000));
    ok("a spot cooldown does not block futures", venueCooldown("binance") > 0 && venueCooldown("binance-fut") === 0);
    const p = await fetchFuturesPositioning("BTCUSDT").then((x) => x, () => null);
    ok("...and futures still fetch", p !== null && Number.isFinite(p.fundingRate));
  }
  {
    fresh();
    noteVenueRateLimit("binance-fut", new RateLimitError("fut 429", 60_000));
    ok("a futures cooldown does not block spot", venueCooldown("binance-fut") > 0 && venueCooldown("binance") === 0 && rateLimitCooldown("binance") === 0);
    ok("venueOf is unchanged: no futures data source", venueOf("binance") === "binance" && venueOf("bybit-perp") === "bybit");
    resetRateLimitForTests();
    ok("resetRateLimitForTests clears it", venueCooldown("binance-fut") === 0);
  }

  // ---- which API reads which cooldown ----
  {
    fresh();
    noteVenueRateLimit("binance", new RateLimitError("spot", 60_000));
    ok("venueCooldown reads spot and futures apart (spot cooling)", venueCooldown("binance") > 0 && venueCooldown("binance-fut") === 0);
    // venueOf("binance-fut") falls to "binance" by design (no futures DataSource), so the source-keyed API reports the SPOT pool:
    // radar code must use venueCooldown("binance-fut"), never rateLimitCooldown("binance-fut").
    ok("rateLimitCooldown('binance-fut') is the spot pool (documented; radar uses venueCooldown)", rateLimitCooldown("binance-fut") > 0 && venueOf("binance-fut") === "binance");
    resetRateLimitForTests();
    noteVenueRateLimit("binance-fut", new RateLimitError("fut", 60_000));
    ok("futures cooling: venueCooldown('binance-fut') > 0, spot 0", venueCooldown("binance-fut") > 0 && venueCooldown("binance") === 0 && rateLimitCooldown("binance") === 0);
  }
  {
    // fetchJson with a fapi URL (guard for future use) lands on binance-fut, not on spot.
    fresh();
    stub({ "/fapi/v1/premiumIndex": 429 });
    const err = await fetchJson(`${FAPI_BASE}/fapi/v1/premiumIndex?symbol=BTCUSDT`, "guard").then(() => null, (e) => e);
    ok("fetchJson on a fapi URL: 429 sets binance-fut only", err instanceof RateLimitError && venueCooldown("binance-fut") > 0 && venueCooldown("binance") === 0);
  }

  // ---- its own gate, at 80 % of the stricter documented limit ----
  {
    ok("gate: 400 requests / 5 min (80 % of 500 per 5 min on fundingRate)", FUTURES_GATE_LIMIT === 400 && FUTURES_GATE_WINDOW_MS === 300_000);
    fresh();
    let t = 0;
    const slept = [];
    setFuturesClockForTests({ now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
    stub(full());
    // 80 calls x 5 requests = 400 grants fit; the 81st call must wait for the window.
    for (let i = 0; i < 80; i++) await fetchFuturesPositioning("BTCUSDT");
    ok("gate: 400 requests pass without waiting", slept.length === 0);
    await fetchFuturesPositioning("BTCUSDT");
    ok("gate: the 401st waits for the window to roll", slept.length > 0 && slept[0] > 0 && slept[0] <= FUTURES_GATE_WINDOW_MS);
  }
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\nradar futures: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
