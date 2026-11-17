/**
 * acceptance.cjs — Playwright acceptance run for rsL Confluence Terminal v2.1+ (PWA / web core; v2.6 adds PH-9…12, US-1).
 *
 *   node tools/e2e/acceptance.cjs [baseURL]     (serve apps/confluence/web/out first)
 *
 * Covers identity skill §8 and builder skill §9.4 items that are testable in a browser.
 * Exchange APIs are mocked so the run is deterministic and offline-capable.
 * Writes screenshots + results.json to tools/e2e/evidence/.
 */
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.argv[2] || "http://127.0.0.1:8770/";
// v2.8 (WP27): `--capture-ds1 <file>` / `--capture-ds2 <file>` only record the DS-1 / DS-2 layout snapshot of BASE
// (used on the v2.7.0-web release build); `--ds-only` runs just DS-1 and DS-2.
const argAfter = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null);
const CAPTURE_DS1 = argAfter("--capture-ds1");
const CAPTURE_DS2 = argAfter("--capture-ds2");
const DS_ONLY = process.argv.includes("--ds-only");
// v2.8 (header, owner decision 16 Nov 2026): `--hd-only` runs just HD-1 (two-line header control ribbon).
const HD_ONLY = process.argv.includes("--hd-only");
// v2.8 (WP28): `--bk-only` runs just BK-1…BK-4 (Cloud backup).
const BK_ONLY = process.argv.includes("--bk-only");
const OUT = path.join(__dirname, "evidence");
fs.mkdirSync(OUT, { recursive: true });
const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const results = [];
const record = (id, name, pass, evidence) => {
  results.push({ id, name, pass: !!pass, evidence });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${name}${evidence ? "  — " + (typeof evidence === "string" ? evidence : JSON.stringify(evidence)) : ""}`);
};

/* ---------- deterministic exchange mock ---------- */
const H15 = 15 * 60e3;
// Bar length from the request (Binance "1h", Bybit "60", Bitget "1h"/"15min").
function stepOf(u) {
  const v = u.searchParams.get("interval") || u.searchParams.get("granularity") || "15m";
  const map = { "1m": 60e3, "5m": 3e5, "15m": H15, "1h": 36e5, "4h": 144e5, "1d": 864e5, "60": 36e5, "240": 144e5, "15": H15, D: 864e5, "15min": H15, "1day": 864e5, "1Dutc": 864e5, "4H": 144e5, "1H": 36e5 };
  return map[v] ?? H15;
}
function klines(sym, n = 200, step = H15, now = Date.now()) {
  const start = Math.floor(now / step) * step - n * step;
  let px = 100, s = [...sym].reduce((a, c) => a + c.charCodeAt(0), 7);
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  const drift = sym.startsWith("BTC") ? 0.004 : sym.startsWith("ETH") ? -0.004 : 0;
  const out = [];
  for (let i = 0; i <= n; i++) { const o = px; px *= Math.exp(drift + r() * 0.01); out.push([start + i * step, String(o), String(Math.max(o, px) * 1.002), String(Math.min(o, px) * 0.998), String(px), String(1000 + i), start + (i + 1) * step - 1]); }
  return out;
}
async function mockExchanges(ctx, seen, opts = {}) {
  let klineCalls = 0;
  await ctx.route(/^https:\/\/(data-api\.binance\.vision|api\.bybit\.com|api\.bitget\.com)\//, async (route) => {
    const u = new URL(route.request().url());
    seen && seen.push(u.host + u.pathname + (u.searchParams.get("limit") ? `?limit=${u.searchParams.get("limit")}` : ""));
    const headers = { "access-control-allow-origin": "*", "content-type": "application/json" };
    if (u.pathname.endsWith("/ticker/24hr")) {
      if (opts.tickers) return route.fulfill({ status: 200, headers, body: JSON.stringify(opts.tickers) });
      // v2.2: tokenised stock, gold and an FX stablecoin pair alongside crypto; USDC is excluded.
      const t = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "USDCUSDT", "PAXGUSDT", "TSLABUSDT", "EURUSDT"].map((sym, i) => ({ symbol: sym, openPrice: "100", lastPrice: "101", quoteVolume: String(1e9 - i) }));
      return route.fulfill({ status: 200, headers, body: JSON.stringify(t) });
    }
    if (u.pathname.endsWith("/depth")) {
      // v2.3: public order book for the measured-slippage sample.
      return route.fulfill({ status: 200, headers, body: JSON.stringify({ bids: [["100.9", "50"], ["100.8", "100"]], asks: [["101.1", "50"], ["101.2", "100"]] }) });
    }
    klineCalls++;
    // v2.8 (WP27): a throttled network (PG-1) answers candle requests late.
    if (opts.klineDelayMs) await new Promise((ok) => setTimeout(ok, opts.klineDelayMs));
    if (opts.failSymbol && u.searchParams.get("symbol") === opts.failSymbol) {
      return route.fulfill({ status: 500, headers, body: JSON.stringify({ code: -1, msg: "upstream error" }) });
    }
    if (opts.rateLimitAt && klineCalls >= opts.rateLimitAt) {
      return route.fulfill({ status: 429, headers: { ...headers, "retry-after": "45" }, body: JSON.stringify({ code: -1003, msg: "Too many requests" }) });
    }
    const limit = Math.min(1000, Number(u.searchParams.get("limit") || 200));
    return route.fulfill({ status: 200, headers, body: JSON.stringify(klines(u.searchParams.get("symbol") || "X", limit, stepOf(u), typeof opts.now === "function" ? opts.now(stepOf(u)) : opts.now)) });
  });
}

/* ---------- v2.8 (WP25) market radar: one probe-shaped mock for every radar host ---------- */
// Bodies follow docs/superpowers (W/wp25-probes.md, 16 Nov 2026): fapi premiumIndex / fundingRate / openInterestHist /
// globalLongShortAccountRatio / takerlongshortRatio, CFTC TFF gpe5-46if rows (strings, no "_all" suffix on the group
// fields), DefiLlama stablecoincharts/all (date = UNIX seconds string). Venue candles come from one price world: BTC is
// RD_P USD everywhere; Coinbase's two newest closed hourly bars sit `cbPremium` above it (the break-away fixture); Upbit and
// Coins.ph quote it in KRW / PHP at their own USDT rate. Tickers carry the regional premiums: US +1.00 %, Korea +1.20 %
// (KRW-BTC / (KRW-USDT × Binance BTCUSDT) − 1), Philippines +0.50 %.
const RD_HOSTS = ["fapi.binance.com", "publicreporting.cftc.gov", "stablecoins.llama.fi"];
const RD_P = 65000, RD_KRW = 1377, RD_PHP = 58;
const RD_H = 36e5, RD_D = 864e5;
async function rdMock(ctx, o = {}) {
  const cbPremium = o.cbPremium ?? 0.015;
  const cors = { "access-control-allow-origin": "*", "content-type": "application/json" };
  const st = { requests: [], unknown: [], upbitDirect: [] };
  const json = (route, b, status = 200) => route.fulfill({ status, headers: cors, body: JSON.stringify(b) });
  // Lowest priority: everything not mocked below. The app's own origin passes; any other host is logged and refused.
  await ctx.route(/.*/, (route) => {
    const u = new URL(route.request().url());
    if (u.origin === new URL(BASE).origin || u.protocol === "data:" || u.protocol === "blob:") return route.continue();
    st.unknown.push(u.host + u.pathname);
    return route.abort();
  });
  await ctx.route(/^https:\/\/(api\.frankfurter\.dev|cdn\.jsdelivr\.net|latest\.currency-api\.pages\.dev)\//, (route) => route.abort());
  if (!o.skipScan) await mockExchanges(ctx, null);
  ctx.on("request", (r) => { const u = new URL(r.url()); st.requests.push(u.host + u.pathname); });

  const px = (venue, open, unit) => {
    const lastOpen = Math.floor(Date.now() / RD_H) * RD_H - RD_H;
    const wiggle = 1 + 0.0004 * Math.sin(open / (unit * 7));
    const cb = venue === "coinbase" && unit === RD_H && open >= lastOpen - RD_H ? 1 + cbPremium : 1;
    return RD_P * wiggle * cb;
  };
  const volOf = (open, unit) => (unit === RD_H ? 100 + ((open / RD_H) % 7) : 5000 + 120 * Math.sin(open / RD_D));
  /** Open times, newest first: up to `n` bars opening at or before `endOpen`, never after the bar now forming. */
  const opens = (unit, n, endOpen = Infinity) => {
    const forming = Math.floor(Date.now() / unit) * unit;
    const out = [];
    for (let t = Math.min(forming, Math.floor(endOpen / unit) * unit); out.length < n; t -= unit) out.push(t);
    return out;
  };
  const q = (u, k) => u.searchParams.get(k);
  const ohlc = (venue, t, unit, mult = 1) => { const c = px(venue, t, unit) * mult; return { o: c * 0.9995, h: c * 1.001, l: c * 0.999, c, v: volOf(t, unit) }; };

  /* Binance spot */
  await ctx.route(/^https:\/\/data-api\.binance\.vision\/api\/v3\/(ticker\/price|klines)/, (route) => {
    const u = new URL(route.request().url());
    if (q(u, "symbol") !== "BTCUSDT") return route.fallback();
    if (u.pathname.endsWith("/ticker/price")) return json(route, { symbol: "BTCUSDT", price: String(RD_P) });
    const unit = { "1h": RD_H, "1d": RD_D }[q(u, "interval")];
    if (!unit) return route.fallback();
    const rows = opens(unit, Math.min(1000, Number(q(u, "limit") || 500)), q(u, "endTime") ? Number(q(u, "endTime")) : Infinity).reverse().map((t, i) => {
      const b = ohlc("binance", t, unit);
      return [t, String(b.o), String(b.h), String(b.l), String(b.c), String(b.v), t + unit - 1, String(b.v * b.c), 1000, String(b.v * (0.5 + 0.1 * Math.sin(i / 3))), "0", "0"];
    });
    return json(route, rows);
  });
  /* Bybit spot (newest first) */
  await ctx.route(/^https:\/\/api\.bybit\.com\/v5\/market\/kline/, (route) => {
    const u = new URL(route.request().url());
    const unit = { "60": RD_H, D: RD_D }[q(u, "interval")];
    if (q(u, "symbol") !== "BTCUSDT" || q(u, "category") !== "spot" || !unit) return route.fallback();
    const list = opens(unit, Math.min(1000, Number(q(u, "limit") || 200)), q(u, "end") ? Number(q(u, "end")) : Infinity).map((t) => {
      const b = ohlc("bybit", t, unit);
      return [String(t), String(b.o), String(b.h), String(b.l), String(b.c), String(b.v), String(b.v * b.c)];
    });
    return json(route, { retCode: 0, retMsg: "OK", result: { category: "spot", symbol: "BTCUSDT", list }, time: Date.now() });
  });
  /* Bitget spot */
  await ctx.route(/^https:\/\/api\.bitget\.com\/api\/v2\/spot\/market\/(history-)?candles/, (route) => {
    const u = new URL(route.request().url());
    const unit = { "1h": RD_H, "1Dutc": RD_D }[q(u, "granularity")];
    if (q(u, "symbol") !== "BTCUSDT" || !unit) return route.fallback();
    const data = opens(unit, Math.min(1000, Number(q(u, "limit") || 100)), q(u, "endTime") ? Number(q(u, "endTime")) : Infinity).map((t) => {
      const b = ohlc("bitget", t, unit);
      return [String(t), String(b.o), String(b.h), String(b.l), String(b.c), String(b.v), String(b.v * b.c), String(b.v * b.c)];
    });
    return json(route, { code: "00000", msg: "success", requestTime: Date.now(), data });
  });
  /* OKX spot (newest first; the forming bar is flagged confirm "0") */
  await ctx.route(/^https:\/\/www\.okx\.com\/api\/v5\/market\/(history-)?candles/, (route) => {
    const u = new URL(route.request().url());
    const unit = { "1H": RD_H, "1Dutc": RD_D }[q(u, "bar")];
    if (q(u, "instId") !== "BTC-USDT" || !unit) return route.fallback();
    const forming = Math.floor(Date.now() / unit) * unit;
    const after = q(u, "after") ? Number(q(u, "after")) : Infinity; // strictly older than `after`
    const end = after === Infinity ? forming : Math.floor((after - 1) / unit) * unit;
    const data = opens(unit, Math.min(300, Number(q(u, "limit") || 100)), end).map((t) => {
      const b = ohlc("okx", t, unit);
      return [String(t), String(b.o), String(b.h), String(b.l), String(b.c), String(b.v), String(b.v), String(b.v * b.c), t === forming ? "0" : "1"];
    });
    return json(route, { code: "0", msg: "", data });
  });
  /* Coinbase: ticker (US premium) and candles [time s, low, high, open, close, volume] */
  await ctx.route(/^https:\/\/api\.exchange\.coinbase\.com\/products\/BTC-(USD|USDT)\/(ticker|candles)/, (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.endsWith("/ticker")) return json(route, { trade_id: 1, price: (RD_P * 1.01).toFixed(2), size: "0.01", time: new Date().toISOString() });
    const g = Number(q(u, "granularity")) * 1000;
    if (g !== RD_H && g !== RD_D) return route.fallback();
    const start = Date.parse(q(u, "start")), end = Date.parse(q(u, "end"));
    const rows = opens(g, Math.min(300, Math.round((end - start) / g) + 1), end).filter((t) => t >= start).map((t) => {
      const b = ohlc("coinbase", t, g);
      return [t / 1000, b.l, b.h, b.o, b.c, b.v];
    });
    return json(route, rows);
  });
  /* Upbit through the same-origin relay; the real host is refused and logged */
  await ctx.route(/^https:\/\/api\.upbit\.com\//, (route) => { st.upbitDirect.push(route.request().url()); return route.abort(); });
  const iso19 = (t) => new Date(t).toISOString().slice(0, 19);
  await ctx.route(/\/x\/upbit\/v1\//, (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname.replace(/^\/x\/upbit/, "");
    if (p === "/v1/ticker") {
      const markets = (q(u, "markets") || "").split(",");
      return json(route, markets.map((m) => ({ market: m, trade_price: m === "KRW-USDT" ? RD_KRW : m === "KRW-BTC" ? RD_P * RD_KRW * 1.012 : 1 })));
    }
    const unit = p === "/v1/candles/minutes/60" ? RD_H : p === "/v1/candles/days" ? RD_D : 0;
    const market = q(u, "market");
    if (!unit || (market !== "KRW-BTC" && market !== "KRW-USDT")) return json(route, { error: { message: "not mocked" } }, 404);
    const to = q(u, "to") ? Date.parse(q(u, "to")) : Infinity; // exclusive
    const forming = Math.floor(Date.now() / unit) * unit;
    const end = to === Infinity ? forming : Math.min(forming, Math.ceil(to / unit) * unit - unit);
    const rows = opens(unit, Math.min(200, Number(q(u, "count") || 1)), end).map((t) => {
      const usd = ohlc("upbit", t, unit);
      const k = market === "KRW-USDT" ? RD_KRW / usd.c : RD_KRW; // USDT leg is flat, BTC leg is USD × the won rate
      const f = market === "KRW-USDT" ? 1 : 1;
      return {
        market, candle_date_time_utc: iso19(t), opening_price: usd.o * k * f, high_price: usd.h * k * f, low_price: usd.l * k * f, trade_price: usd.c * k * f,
        timestamp: t === forming ? Date.now() : t + 1000, candle_acc_trade_price: usd.v * usd.c * k, candle_acc_trade_volume: usd.v,
      };
    });
    return json(route, rows);
  });
  /* Coins.ph through the same-origin relay (price and klines) */
  await ctx.route(/^https:\/\/api\.pro\.coins\.ph\//, (route) => route.abort());
  await ctx.route(/\/x\/coinsph\/openapi\/quote\/v1\//, (route) => {
    const u = new URL(route.request().url());
    const sym = q(u, "symbol");
    if (u.pathname.endsWith("/ticker/price")) {
      const price = sym === "BTCPHP" ? RD_P * RD_PHP * 1.005 : sym === "USDTPHP" ? RD_PHP : null;
      return price === null ? json(route, { code: -1121, msg: "Invalid symbol." }, 400) : json(route, { symbol: sym, price: String(price) });
    }
    if (u.pathname.endsWith("/klines")) {
      const unit = { "1h": RD_H, "1d": RD_D }[q(u, "interval")];
      if (!unit || (sym !== "BTCPHP" && sym !== "USDTPHP")) return json(route, { code: -1121, msg: "Invalid symbol." }, 400);
      const rows = opens(unit, Math.min(1000, Number(q(u, "limit") || 500)), q(u, "endTime") ? Number(q(u, "endTime")) : Infinity).reverse().map((t) => {
        const usd = ohlc("coinsph", t, unit);
        const k = sym === "USDTPHP" ? RD_PHP / usd.c : RD_PHP;
        return [t, String(usd.o * k), String(usd.h * k), String(usd.l * k), String(usd.c * k), String(usd.v), t + unit - 1, String(usd.v * usd.c), 100, String(usd.v / 2)];
      });
      return json(route, rows);
    }
    return json(route, { code: -1, msg: "not mocked" }, 404);
  });

  /* Binance USDⓈ-M futures (probe bodies) */
  await ctx.route(/^https:\/\/fapi\.binance\.com\//, (route) => {
    const u = new URL(route.request().url());
    const sym = q(u, "symbol");
    if (sym !== "BTCUSDT" && sym !== "ETHUSDT") return json(route, { code: -1121, msg: "Invalid symbol." }, 400);
    const eth = sym === "ETHUSDT";
    const hourOpen = Math.floor(Date.now() / RD_H) * RD_H - RD_H;
    if (u.pathname === "/fapi/v1/premiumIndex") {
      return json(route, { symbol: sym, markPrice: eth ? "3200.10000000" : "64944.91491304", indexPrice: eth ? "3202.40000000" : "64979.37652174", estimatedSettlePrice: "65078.08558540", lastFundingRate: eth ? "0.00010000" : "-0.00001816", interestRate: "0.00010000", nextFundingTime: Date.now() + 36e5, time: Date.now() });
    }
    if (u.pathname === "/fapi/v1/fundingRate") {
      const n = Number(q(u, "limit") || 100);
      return json(route, Array.from({ length: n }, (_, i) => ({ symbol: sym, fundingTime: Date.now() - (n - i) * 8 * RD_H, fundingRate: ((i % 30) / 30 * 0.00008 - 0.00002).toFixed(8), markPrice: "64000.00000000", rateType: "Regular" })));
    }
    if (u.pathname === "/futures/data/openInterestHist") {
      const n = Number(q(u, "limit") || 25);
      return json(route, Array.from({ length: n }, (_, i) => ({ symbol: sym, sumOpenInterest: (eth ? 1.2e6 : i === n - 1 ? 93828.193 : 90000 + i * 100).toFixed(3), sumOpenInterestValue: "6062644075.84702600", CMCCirculatingSupply: "20112050.00000000", timestamp: hourOpen - (n - 1 - i) * RD_H })));
    }
    if (u.pathname === "/futures/data/globalLongShortAccountRatio") {
      return json(route, [{ symbol: sym, longShortRatio: "2.9154", longAccount: "0.7446", shortAccount: "0.2554", timestamp: hourOpen }]);
    }
    if (u.pathname === "/futures/data/takerlongshortRatio") {
      return json(route, [{ buySellRatio: "1.1088", sellVol: "3856.5760", buyVol: "4276.0310", timestamp: hourOpen }]);
    }
    return json(route, { code: -1, msg: "not mocked" }, 404);
  });
  /* CFTC TFF futures only (Socrata): BTC 2026-11-03 vs 2026-10-27 (probe), ETH likewise */
  await ctx.route(/^https:\/\/publicreporting\.cftc\.gov\//, (route) => {
    const u = new URL(route.request().url());
    const code = /cftc_contract_market_code='(\d+)'/.exec(decodeURIComponent(q(u, "$where") || ""))?.[1];
    const mk = (date, amL, amS, lmL, lmS, oi) => ({ report_date_as_yyyy_mm_dd: `${date}T00:00:00.000`, cftc_contract_market_code: code, open_interest_all: String(oi), asset_mgr_positions_long: String(amL), asset_mgr_positions_short: String(amS), lev_money_positions_long: String(lmL), lev_money_positions_short: String(lmS) });
    if (code === "133741") return json(route, [mk("2026-11-03", 3100, 1200, 5400, 9100, 17527), mk("2026-10-27", 3000, 1500, 5000, 8000, 20791)]);
    if (code === "146021") return json(route, [mk("2026-11-03", 1018, 2843, 3599, 7298, 22869), mk("2026-10-27", 1285, 2469, 4415, 8440, 28068)]);
    return json(route, []);
  });
  /* DefiLlama total stablecoin supply: 120 quiet days, then a +US$5B mint today (the supply-jump fixture) */
  await ctx.route(/^https:\/\/stablecoins\.llama\.fi\//, (route) => {
    const u = new URL(route.request().url());
    if (u.pathname !== "/stablecoincharts/all") return json(route, { message: "not mocked" }, 404);
    const today = Math.floor(Date.now() / RD_D) * RD_D;
    let v = 280e9;
    const rows = [];
    for (let i = 119; i >= 0; i--) {
      v += i === 0 ? 5e9 : 1e8 + 4e7 * Math.sin(i);
      rows.push({ date: String((today - i * RD_D) / 1000), totalCirculatingUSD: { peggedUSD: v } });
    }
    return json(route, rows);
  });
  return st;
}

/* ---------- helpers ---------- */
const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const parseRgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);

async function newContext(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, acceptDownloads: true, ...opts });
  // Headless Chromium cannot drive the native save picker; use the <a download> path (same as Safari/Firefox PWA).
  await ctx.addInitScript(() => { try { delete window.showSaveFilePicker; window.showSaveFilePicker = undefined; } catch {} });
  return ctx;
}
async function completeFirstRun(page, { name = "rsLozano — Personal trading desk", short = "Personal", code = "PERS", operator = "Ronald" } = {}) {
  await page.waitForSelector("#wiz-title", { timeout: 15000 });
  await page.getByRole("button", { name: /^Next$/ }).click();
  const inputs = page.locator("section input:not([type=file])");
  await inputs.nth(0).fill(name);
  await inputs.nth(1).fill(short);
  await inputs.nth(2).fill(code);
  await page.getByRole("button", { name: /^Next$/ }).click();
  await page.locator("section input").first().fill(operator);
  await page.getByRole("button", { name: /^Finish$/ }).click();
  await page.waitForSelector(".rsl-brand-host .rsl-brand", { timeout: 15000 });
}
// v2.8 header (owner decision 16 Nov 2026, spec §3 item 9): at ≥ 1280 px the System / Light / Dark radios are one button
// that cycles System → Light → Dark ([data-testid=theme-cycle], data-theme-current = the current choice); below 1280 px
// the radios are unchanged. Chooses `name` through whichever control is shown, so each check reaches the same theme as
// before (a choice that is already current clicks nothing, like clicking a checked radio).
async function chooseTheme(p, name) {
  const radio = p.getByRole("radio", { name });
  if (await radio.isVisible().catch(() => false)) return radio.click();
  const cycle = p.getByTestId("theme-cycle");
  const want = name.toLowerCase();
  for (let i = 0; i < 3 && (await cycle.getAttribute("data-theme-current")) !== want; i++) await cycle.click();
  if ((await cycle.getAttribute("data-theme-current")) !== want) throw new Error(`theme ${name} not reached`);
}
async function waitRows(page) { await page.waitForFunction(() => document.querySelectorAll("tbody tr").length >= 4, null, { timeout: 20000 }); }

/* ---------- v2.8 (WP27) DS-1 / DS-2: layout at rest vs v2.7.0 (spec §3 design-unchanged rule, "Guard") ---------- */
// Fixed clock (page.clock + the mocked candles), FX hosts mocked, default settings, 1366 × 768, English. Theme is
// "System", which headless Chromium resolves to light — acceptable for the guard (both builds are measured the same way).
// The mocked exchange tickers carry 24 h quote volumes of ~1e9 USD, far above the 1M liquidity floor, so it removes no row.
const DS_NOW = Date.UTC(2026, 10, 11, 9, 7, 0);
const DS_TOLERANCE_PX = 2;
// Pinned environment (fix/ds-ci-stability): the guard measures in the same conditions on every machine instead of
// inheriting them from the host. Three host inputs used to leak into the layout:
//   - Time zone and languages: "Display currency: Auto" follows the device's time zone, then its languages
//     (lib/fx-rates.ts autoCurrency). Under TZ=Asia/Riyadh the screen shows SAR and the 25 px "Prices in SAR" FX row
//     between the header and the list; under the CI runner's UTC it shows USD and no row, so everything below moved.
//   - Glyph advances: headless Chromium's --font-render-hinting decides whether web-font glyph advances are
//     fractional (none) or rounded to whole pixels (its default). Masked text ("Xxxx") is drawn with the bundled
//     Inter, so every text-bearing box changed width by up to ~0.3 px per glyph (12 px "Xxxx": 27.84 vs 29 px).
//     (The development container's headless shell adds --font-render-hinting=none itself; the CI runner's does not.)
//   - System fonts: see dsPinFonts.
// The baselines were captured with exactly these pins; dsEnv records them in each snapshot, and a mismatch is
// reported as an "env" difference before any box, so a host where a pin does not take effect fails loudly.
const DS_TIMEZONE = "Asia/Riyadh";
const DS_LOCALE = "en-US";
const DS_CHROMIUM_ARGS = ["--font-render-hinting=none", "--disable-lcd-text", "--force-color-profile=srgb"];
let dsBrowserPromise = null;
const dsBrowser = () => (dsBrowserPromise ||= chromium.launch({ args: DS_CHROMIUM_ARGS }));
const dsBrowserClose = async () => { if (dsBrowserPromise) await (await dsBrowserPromise).close(); dsBrowserPromise = null; };
// System fonts: masked text whose font stack starts with a family the app does not bundle (the table's
// "Cascadia Mono", "Segoe UI Mono", Consolas, monospace; Arial; Tailwind's ui-monospace stack) is drawn with whatever
// the host's fontconfig picks (DejaVu Sans Mono in the container; Courier on a host without it moved columns by up to
// 23 px). dsPinFonts gives each such family the app's own bundled face (JetBrains Mono for monospace stacks, Inter
// otherwise) before measuring, so masked text is drawn with bundled fonts only. Generic first families (monospace,
// system-ui, ...) cannot be redefined; they are listed in @env as "not pinned" so a new one shows up as an env diff.
async function dsPinFonts(page) {
  await page.evaluate(async () => {
    const subs = (window.__dsSubs ||= {});
    // CSS generic keywords Chromium resolves itself on Linux (ui-monospace etc. are plain family names there).
    const generic = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "math", "emoji", "fangsong", "system-ui"]);
    const unq = (s) => s.trim().replace(/^["']|["']$/g, "");
    const faceRules = [];
    const walk = (rules, href) => { for (const r of rules) { if (r instanceof CSSFontFaceRule) faceRules.push({ r, href }); else if (r.cssRules) walk(r.cssRules, href); } };
    for (const sheet of document.styleSheets) { try { walk(sheet.cssRules, sheet.href || location.href); } catch { /* cross-origin sheet: none in this app */ } }
    const bundled = new Set(faceRules.map(({ r }) => unq(r.style.getPropertyValue("font-family")).toLowerCase()));
    for (const f of document.fonts) bundled.add(unq(f.family).toLowerCase());
    const loads = [];
    for (const el of document.body.querySelectorAll("*")) {
      const text = el.matches("input, textarea, select") || [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
      if (!text) continue;
      const stack = getComputedStyle(el).fontFamily.split(",").map(unq);
      const first = stack[0];
      if (bundled.has(first.toLowerCase()) || first in subs) continue;
      if (generic.has(first.toLowerCase())) { subs[first] = "(generic, not pinned)"; continue; }
      const to = stack.some((f) => /mono/i.test(f)) ? "JetBrains Mono" : "Inter";
      for (const { r, href } of faceRules) {
        if (unq(r.style.getPropertyValue("font-family")) !== to) continue;
        const src = r.style.getPropertyValue("src").replace(/url\((["']?)([^)"']+)\1\)/g, (_, q, u) => `url("${new URL(u, href).href}")`);
        const desc = {};
        for (const [prop, key] of [["font-weight", "weight"], ["font-style", "style"], ["unicode-range", "unicodeRange"]]) { const v = r.style.getPropertyValue(prop); if (v) desc[key] = v; }
        const face = new FontFace(first, src, desc);
        document.fonts.add(face);
        loads.push(face.load().catch(() => {}));
      }
      subs[first] = to;
      bundled.add(first.toLowerCase());
    }
    await Promise.all(loads);
    await document.fonts.ready;
    await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
  });
}
// The environment as the page sees it: time zone, languages, the advance of the masked placeholder in the bundled
// Inter at 12 px (fractional only when the hinting pin took effect) and the font substitutions dsPinFonts made.
// Called after measuring, so the substitutions cover everything measured.
async function dsEnv(p) {
  return p.evaluate(async () => {
    await document.fonts.ready;
    const s = document.createElement("span");
    s.style.cssText = "position:absolute;left:-9999px;top:0;white-space:pre;font:400 12px Inter";
    s.textContent = "Xxxx";
    document.body.appendChild(s);
    const w = s.getBoundingClientRect().width;
    s.remove();
    const subs = Object.entries(window.__dsSubs || {}).sort(([a], [b]) => a.localeCompare(b)).map(([a, b]) => `${a} → ${b}`).join("; ");
    return { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, languages: navigator.languages.join(","), interXxxx12px: Math.round(w * 1000) / 1000, fontSubstitutes: subs };
  });
}
function dsEnvDiffs(base, now) {
  if (!base) return ["env: baseline has no @env (re-capture it)"];
  return Object.entries(base).filter(([k, v]) => !now || now[k] !== v).map(([k, v]) => `env ${k}: ${v} → ${now ? now[k] : "?"}`);
}
// Text masking (spec: "with text and live numbers masked"): right before measuring, every non-blank text node becomes
// the same placeholder and input values/placeholders too, so a box's size comes from its padding, font and structure,
// never from the wording or a live number. The context is closed (or the dialog closed) afterwards.
async function dsInstall(page) {
  await page.evaluate(() => {
    const mask = (root) => {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const parent = n.parentElement;
        if (!parent || parent.tagName === "SCRIPT" || parent.tagName === "STYLE") continue;
        if (n.nodeValue.trim()) n.nodeValue = "Xxxx";
      }
      root.querySelectorAll("input, textarea").forEach((el) => {
        if (el.placeholder) el.placeholder = "Xxxx";
        if (el.type !== "checkbox" && el.type !== "radio" && el.value) el.value = "Xxxx";
      });
    };
    // Structural snapshot of `root`: every element keyed by its path (tag + index among the shown children), with its
    // box [x, y, w, h] and its colours. `exclude` = the §3 allowed additions, hidden first so they neither count nor
    // move what follows. `topUntil`: stop after that element's subtree (the "top of the sheet"); its ancestors get an
    // open height (null), since their height depends on the sections below. SVGs: the svg and its direct children
    // (the chart's layers) with their element counts.
    const measure = (root, { exclude = [], topUntil = null } = {}) => {
      for (const sel of exclude) root.querySelectorAll(sel).forEach((el) => el.style.setProperty("display", "none", "important"));
      mask(root);
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      const stop = topUntil ? root.querySelector(topUntil) : null;
      const boxes = {}, colours = {}, counts = {};
      let done = false;
      const rec = (el, key) => {
        const b = el.getBoundingClientRect();
        const open = stop && el !== stop && el.contains(stop);
        boxes[key] = [Math.round(b.x), Math.round(b.y), Math.round(b.width), open ? null : Math.round(b.height)];
        const cs = getComputedStyle(el);
        colours[key] = el instanceof SVGElement ? `${cs.fill}|${cs.stroke}` : `${cs.backgroundColor}|${cs.color}|${cs.borderTopColor}`;
      };
      const walk = (el, key) => {
        rec(el, key);
        if (el.tagName.toLowerCase() === "svg") {
          [...el.children].forEach((ch, i) => { const k = `${key}/${i}:${ch.tagName.toLowerCase()}`; rec(ch, k); counts[k] = ch.querySelectorAll("*").length; });
          if (el === stop) done = true;
          return;
        }
        let i = 0;
        for (const ch of el.children) {
          if (getComputedStyle(ch).display === "none") continue;
          walk(ch, `${key}/${i++}:${ch.tagName.toLowerCase()}`);
          if (done) return;
        }
        if (el === stop) done = true;
      };
      walk(root, root.tagName.toLowerCase());
      return { boxes, colours, counts };
    };
    window.__ds = { mask, measure };
  });
  await dsPinFonts(page);
}
async function dsContext() {
  const c = await newContext(await dsBrowser(), { timezoneId: DS_TIMEZONE, locale: DS_LOCALE });
  const seen = [];
  await mockExchanges(c, seen, { now: DS_NOW });
  await c.route(/^https:\/\/(api\.frankfurter\.dev|cdn\.jsdelivr\.net|latest\.currency-api\.pages\.dev|open\.er-api\.com|data-api\.ecb\.europa\.eu)\//, (route) => route.fulfill({ status: 503, body: "" }));
  await c.route("**/updates/latest.json", (route) => route.fulfill({ status: 404, body: "" }));
  const p = await c.newPage();
  await p.clock.setFixedTime(DS_NOW);
  await p.goto(BASE, { waitUntil: "domcontentloaded" });
  await completeFirstRun(p, { operator: "R" });
  await waitRows(p);
  // At rest: the scan has finished (no progress bar, no spinner), background requests (depth sample, other timeframes of
  // the priority rows) have stopped for 1.5 s, and the pointer hovers nothing.
  await p.waitForFunction(() => !document.querySelector("header div.h-full.bg-gradient-to-r") && !document.querySelector("header .animate-spin"), null, { timeout: 30000 });
  await dsQuiet(p, seen);
  await p.mouse.move(1, 1);
  return { c, p, seen };
}
async function dsQuiet(p, seen) {
  for (let n = seen.length, quiet = 0, t = 0; quiet < 1500 && t < 30000; t += 250) {
    await p.waitForTimeout(250);
    if (seen.length === n) quiet += 250; else { n = seen.length; quiet = 0; }
  }
}
async function ds1Snapshot() {
  const { c, p } = await dsContext();
  await dsInstall(p);
  const snap = await p.evaluate(() => {
    // Spec §3 item 8: the owner-approved WP29 Fear & Greed chip is the only addition to the counts line; hide it before measuring
    // (and leave it out of the control list below, so a hidden zero-size box is not counted as a new control).
    document.querySelectorAll('[data-testid="fng-toggle"]').forEach((el) => { el.style.display = "none"; });
    window.__ds.mask(document.body);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const box = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
    const boxes = {};
    const add = (name, el) => { if (el) boxes[name] = box(el); };
    add("header", document.querySelector("header"));
    document.querySelectorAll("header button:not([data-testid=fng-toggle]), header [role=combobox], header input").forEach((el, i) => add(`header.control.${i}`, el));
    add("main", document.querySelector("main"));
    add("list.toolbar", document.querySelector("main > div > div"));
    add("table", document.querySelector("table.market-table"));
    document.querySelectorAll("thead th").forEach((el, i) => add(`th.${i}`, el));
    document.querySelectorAll("tbody tr").forEach((tr, i) => { add(`row.${i}`, tr); tr.querySelectorAll("td").forEach((td, j) => add(`row.${i}.td.${j}`, td)); });
    add("footer", document.querySelector("footer"));
    const bg = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).backgroundColor : null; };
    const fg = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).color : null; };
    const colours = { body: bg("body"), header: bg("header"), thead: bg("thead"), footer: bg("footer"), th: fg("thead th"), rowText: fg("tbody tr td:nth-child(3)") };
    return { boxes, colours };
  });
  const env = await dsEnv(p);
  await c.close();
  return { "@env": env, ...snap };
}
// DS-2 excluded regions = exactly the spec §3 allowed additions that exist in this build (hidden before measuring):
//   paper  §3.6  "More limits" (collapsed, after the existing settings grid)      [data-testid=paper-more-limits]
//          §3.6  "More statistics" (collapsed)                                    [data-testid=paper-more-stats]
//          §3.6  "Add a note" (collapsed, per proposal)                           [data-testid=paper-add-note]
//          §3.6  drawdown badge and RESET — only while that lock is active        [data-testid=paper-lock-drawdown], [data-testid=paper-drawdown]
//          §3.7  the risk > 1 % warning (text inside the proposal box)            [data-testid=paper-warning]
//   detail §3.8  "View on [exchange]" (WP26, end of the sheet, below the compared region)   [data-testid=view-on-exchange]
//          §3.1  "Scenarios (simulation)" (WP22, collapsed, right after the Pattern panel)  [data-testid=scenarios-section]
//   ledger §3.4  collapsed Scenario check at the end of the dialog (WP22)               [data-testid=ledger-scenario-check]
// §3.5 block reasons and §3.7 text inside existing boxes need no exclusion (text is masked). Never add a selector for
// anything that is not on the §3 list.
const DS2_ALLOWED = {
  detail: ['[data-testid="view-on-exchange"]', '[data-testid="scenarios-section"]'],
  paper: ['[data-testid="paper-more-limits"]', '[data-testid="paper-more-stats"]', '[data-testid="paper-add-note"]', '[data-testid="paper-lock-drawdown"]', '[data-testid="paper-drawdown"]', '[data-testid="paper-warning"]'],
  ledger: ['[data-testid="ledger-scenario-check"]'],
};
async function ds2Snapshot() {
  const { c, p, seen } = await dsContext();
  const dialog = p.locator('[role="dialog"]').first();
  const measure = async (opts) => { await dsInstall(p); await p.mouse.move(1, 1); return p.evaluate((o) => window.__ds.measure(document.querySelector('[role="dialog"]'), o), opts); };
  const close = async () => { await p.keyboard.press("Escape"); await p.waitForFunction(() => !document.querySelector('[role="dialog"]'), null, { timeout: 10000 }); };
  const settle = async () => {
    await dsQuiet(p, seen);
    for (let last = "", same = 0, t = 0; same < 1000 && t < 20000; t += 250) {
      await p.waitForTimeout(250);
      const html = await dialog.evaluate((d) => d.innerHTML.length + ":" + d.textContent);
      if (html === last) same += 250; else { last = html; same = 0; }
    }
  };
  const snap = {};
  // Detail sheet: the top of the sheet through the price chart (its default layers).
  await p.getByRole("button", { name: /^BTC/ }).first().click();
  await p.getByTestId("price-chart").waitFor({ timeout: 15000 });
  await settle();
  snap.detail = await measure({ exclude: DS2_ALLOWED.detail, topUntil: '[data-testid="price-chart"]' });
  await close();
  // Paper dialog layout.
  await p.getByRole("button", { name: /Paper — Paper trading/ }).click();
  await p.waitForSelector("text=simulated, no orders are sent", { timeout: 10000 });
  await settle();
  snap.paper = await measure({ exclude: DS2_ALLOWED.paper });
  await close();
  // Ledger dialog: its existing sections.
  await p.getByRole("button", { name: /Signal ledger \(forward test\)/ }).click();
  await dialog.waitFor({ timeout: 10000 });
  await settle();
  snap.ledger = await measure({ exclude: DS2_ALLOWED.ledger });
  await close();
  const env = await dsEnv(p);
  await c.close();
  return { "@env": env, ...snap };
}
function dsCompare(base, now, prefix = "") {
  const diffs = [];
  const near = (b, n) => b.every((v, i) => v === null || n[i] === null ? v === n[i] : Math.abs(v - n[i]) <= DS_TOLERANCE_PX);
  for (const [k, b] of Object.entries(base.boxes)) {
    const n = now.boxes[k];
    if (!n) { diffs.push(`${prefix}${k}: missing`); continue; }
    if (!near(b, n)) diffs.push(`${prefix}${k}: ${b.join(",")} → ${n.join(",")}`);
  }
  for (const k of Object.keys(now.boxes)) if (!(k in base.boxes)) diffs.push(`${prefix}${k}: new`);
  for (const [k, v] of Object.entries(base.colours)) if (k in now.colours && now.colours[k] !== v) diffs.push(`${prefix}colour ${k}: ${v} → ${now.colours[k]}`);
  for (const [k, v] of Object.entries(base.counts || {})) if (k in (now.counts || {}) && now.counts[k] !== v) diffs.push(`${prefix}count ${k}: ${v} → ${now.counts[k]}`);
  return diffs;
}

/* ---------- v2.8 HD-1: two-line header control ribbon at ≥ 1280 px (owner decision 16 Nov 2026, spec §3 item 9) ---------- */
// The ribbon = the header's first row (brand block + every control). Controls = its visible buttons, comboboxes,
// inputs and links (the brand block is not a control). Rows = control boxes grouped by their top edge (4 px tolerance).
// Names come from Playwright's accessibility snapshot of the ribbon, so they are the accessible names a screen
// reader announces. Pinned like DS-1: time zone Asia/Riyadh (Auto = SAR), en-US locale, dark colour scheme.
const HD_RIBBON = '[data-testid="header-controls"], header > div.mx-auto > div:first-child';
const HD_ROW_TOLERANCE_PX = 4;
// "Before" = this branch's base build (2422d8d, WP29 Fear & Greed), measured with hdMeasure on 16 Nov 2026 before the
// header change (ru and the 1024 px boxes added for the review the same day, measured from the same 2422d8d build). The reversal-alert count is live, so that one name is compared as <alerts>; the three theme radios
// (≥ 1280 px only) are compared as one <theme> entry, which the cycling theme button must fill in the same place.
const HD1_BEFORE = {
  // [header height px, control rows] at 1024 × 768 and 390 × 844 (both stay exactly as before)
  rows: { "1024x768": { en: [178, 3], de: [178, 3], ar: [163, 3], ru: [178, 3] }, "390x844": { en: [247, 3], de: [247, 3], ar: [247, 3], ru: [267, 3] } },
  // at ≥ 1280 px before the change (for the record): 1280/1366 en+de 154 px, ar 159 px, 3 rows; 1440 de 3 rows; 1920 2 rows;
  // ru 174 px/3 rows at 1280, 154 px/3 at 1366 and 1440, 116 px/2 at 1920 (ru added for review I1)
  wide: { "1280x800": { en: [154, 3], de: [154, 3], ar: [159, 3] }, "1366x768": { en: [154, 3], de: [154, 3], ar: [159, 3] }, "1440x900": { en: [116, 2], de: [154, 3], ar: [121, 2] }, "1920x1080": { en: [116, 2], de: [116, 2], ar: [121, 2] } },
  // [x, y, w, h, has title] of every shown header control at 1024 × 768 (review M1/M2), DOM order, measured by
  // hdPinnedBoxes in the DS pinned environment (text masked) from the 2422d8d build; @env as in the DS baselines.
  boxes1024: {
    "@env": {"timeZone": "Asia/Riyadh", "languages": "en-US", "interXxxx12px": 27.844, "fontSubstitutes": "Cascadia Mono → JetBrains Mono"},
    en: [[170, 8, 150, 36, 0], [326, 8, 150, 36, 0], [482, 8, 92, 36, 0], [580, 8, 128, 36, 0], [714, 8, 92, 36, 0], [812, 8, 96, 36, 0], [914, 10, 74, 32, 1], [12, 51, 46, 32, 0], [64, 51, 46, 32, 0], [116, 51, 74, 32, 0], [195, 51, 46, 32, 0], [247, 51, 128, 32, 0], [381, 51, 144, 32, 0], [531, 51, 46, 32, 0], [364, 89, 72, 32, 1], [442, 89, 72, 32, 0], [520, 89, 38, 32, 0], [564, 89, 38, 32, 1], [608, 89, 38, 32, 1], [652, 89, 38, 32, 0], [696, 89, 59, 32, 0], [761, 89, 38, 32, 1], [805, 89, 38, 32, 1], [852, 92, 26, 26, 1], [878, 92, 26, 26, 1], [904, 92, 26, 26, 1], [939, 89, 73, 32, 0]],
    de: [[170, 8, 150, 36, 0], [326, 8, 150, 36, 0], [482, 8, 92, 36, 0], [580, 8, 128, 36, 0], [714, 8, 92, 36, 0], [812, 8, 96, 36, 0], [914, 10, 74, 32, 1], [12, 51, 46, 32, 0], [64, 51, 46, 32, 0], [116, 51, 74, 32, 0], [195, 51, 46, 32, 0], [247, 51, 128, 32, 0], [381, 51, 144, 32, 0], [531, 51, 46, 32, 0], [364, 89, 72, 32, 1], [442, 89, 72, 32, 0], [520, 89, 38, 32, 0], [564, 89, 38, 32, 1], [608, 89, 38, 32, 1], [652, 89, 38, 32, 0], [696, 89, 59, 32, 0], [761, 89, 38, 32, 1], [805, 89, 38, 32, 1], [852, 92, 26, 26, 1], [878, 92, 26, 26, 1], [904, 92, 26, 26, 1], [939, 89, 73, 32, 0]],
    ar: [[698, 10, 150, 36, 0], [542, 10, 150, 36, 0], [444, 10, 92, 36, 0], [310, 10, 128, 36, 0], [212, 10, 92, 36, 0], [110, 10, 96, 36, 0], [29, 12, 75, 32, 1], [965, 56, 47, 32, 0], [913, 56, 47, 32, 0], [831, 56, 75, 32, 0], [778, 56, 47, 32, 0], [644, 56, 128, 32, 0], [494, 56, 144, 32, 0], [442, 56, 47, 32, 0], [591, 94, 73, 32, 1], [512, 94, 73, 32, 0], [468, 94, 38, 32, 0], [424, 94, 38, 32, 1], [380, 94, 38, 32, 1], [336, 94, 38, 32, 0], [271, 94, 59, 32, 0], [227, 94, 38, 32, 1], [183, 94, 38, 32, 1], [148, 97, 26, 26, 1], [122, 97, 26, 26, 1], [96, 97, 26, 26, 1], [12, 94, 75, 32, 0]],
    ru: [[170, 8, 150, 36, 0], [326, 8, 150, 36, 0], [482, 8, 92, 36, 0], [580, 8, 128, 36, 0], [714, 8, 92, 36, 0], [812, 8, 96, 36, 0], [914, 10, 74, 32, 1], [12, 51, 46, 32, 0], [64, 51, 46, 32, 0], [116, 51, 74, 32, 0], [195, 51, 46, 32, 0], [247, 51, 128, 32, 0], [381, 51, 144, 32, 0], [531, 51, 46, 32, 0], [364, 89, 72, 32, 1], [442, 89, 72, 32, 0], [520, 89, 38, 32, 0], [564, 89, 38, 32, 1], [608, 89, 38, 32, 1], [652, 89, 38, 32, 0], [696, 89, 59, 32, 0], [761, 89, 38, 32, 1], [805, 89, 38, 32, 1], [852, 92, 26, 26, 1], [878, 92, 26, 26, 1], [904, 92, 26, 26, 1], [939, 89, 73, 32, 0]],
  },

  // accessible names in DOM (= keyboard) order: desktop = every width ≥ 640 px (identical at 1024–1920 px), phone = 390 px
  names: {
    desktop: {
      en: ["combobox: Timeframe", "combobox: Data source", "combobox: Quote", "combobox: Asset class", "combobox: Universe size", "combobox: Display currency", "button: ⇄ Rate sources", "button: Watchlists", "button: Alert inbox", "button: Scoring profile · Default", "button: Saved scans", "textbox: Filter table", "textbox: Monitor specific assets", "button: Apply", "button: Personal — Workspace: rsLozano — Personal trading desk", "button: Auto", "button: <alerts>", "button: Ledger — Signal ledger (forward test)", "button: Paper — Paper trading", "button: API — Private API", "button: Language: English", "link: Contact developer", "button: About", "radio: System", "radio: Light", "radio: Dark", "button: Refresh"],
      de: ["combobox: Zeitrahmen", "combobox: Datenquelle", "combobox: Quote-Währung", "combobox: Anlageklasse", "combobox: Anzahl Coins", "combobox: Anzeigewährung", "button: ⇄ Kursquellen", "button: Watchlists", "button: Alert inbox", "button: Scoring profile · Default", "button: Saved scans", "textbox: Tabelle filtern", "textbox: Bestimmte Assets überwachen", "button: Anwenden", "button: Personal — Arbeitsbereich: rsLozano — Personal trading desk", "button: Auto", "button: <alerts>", "button: Journal — Signaljournal (Forward-Test)", "button: Papier — Papierhandel", "button: API — Private API", "button: Sprache: Deutsch", "link: Entwickler kontaktieren", "button: Info", "radio: System", "radio: Hell", "radio: Dunkel", "button: Aktualisieren"],
      ar: ["combobox: الإطار الزمني", "combobox: مصدر البيانات", "combobox: عملة التسعير", "combobox: فئة الأصول", "combobox: عدد الأصول", "combobox: عملة العرض", "button: ⇄ مصادر الأسعار", "button: Watchlists", "button: Alert inbox", "button: Scoring profile · Default", "button: Saved scans", "textbox: تصفية الجدول", "textbox: مراقبة أصول محددة", "button: تطبيق", "button: Personal — مساحة العمل: rsLozano — Personal trading desk", "button: تلقائي", "button: <alerts>", "button: السجل — سجل الإشارات (اختبار أمامي)", "button: تداول ورقي — التداول الورقي", "button: API — واجهة برمجية خاصة", "button: اللغة: العربية", "link: التواصل مع المطوّر", "button: حول", "radio: النظام", "radio: فاتح", "radio: داكن", "button: تحديث"],
      ru: ["combobox: Таймфрейм", "combobox: Источник данных", "combobox: Валюта котировки", "combobox: Класс активов", "combobox: Число активов", "combobox: Валюта отображения", "button: ⇄ Источники курсов", "button: Watchlists", "button: Alert inbox", "button: Scoring profile · Default", "button: Saved scans", "textbox: Фильтр таблицы", "textbox: Мониторинг выбранных активов", "button: Применить", "button: Personal — Рабочее пространство: rsLozano — Personal trading desk", "button: Авто", "button: <alerts>", "button: Журнал — Журнал сигналов (форвард-тест)", "button: Бумажная — Бумажная торговля", "button: API — Приватный API", "button: Язык: Русский", "link: Связаться с разработчиком", "button: О программе", "radio: Системная", "radio: Светлая", "radio: Тёмная", "button: Обновить"],
    },
    phone: {
      en: ["button: Personal — Workspace: rsLozano — Personal trading desk", "combobox: Timeframe", "combobox: Data source", "button: More controls", "button: Auto", "button: <alerts>", "button: Ledger — Signal ledger (forward test)", "button: Paper — Paper trading", "button: Language: English", "button: Refresh"],
      de: ["button: Personal — Arbeitsbereich: rsLozano — Personal trading desk", "combobox: Zeitrahmen", "combobox: Datenquelle", "button: Weitere Steuerelemente", "button: Auto", "button: <alerts>", "button: Journal — Signaljournal (Forward-Test)", "button: Papier — Papierhandel", "button: Sprache: Deutsch", "button: Aktualisieren"],
      ar: ["button: Personal — مساحة العمل: rsLozano — Personal trading desk", "combobox: الإطار الزمني", "combobox: مصدر البيانات", "button: المزيد من عناصر التحكم", "button: تلقائي", "button: <alerts>", "button: السجل — سجل الإشارات (اختبار أمامي)", "button: تداول ورقي — التداول الورقي", "button: اللغة: العربية", "button: تحديث"],
      ru: ["button: Personal — Рабочее пространство: rsLozano — Personal trading desk", "combobox: Таймфрейм", "combobox: Источник данных", "button: Другие элементы", "button: Авто", "button: <alerts>", "button: Журнал — Журнал сигналов (форвард-тест)", "button: Бумажная — Бумажная торговля", "button: Язык: Русский", "button: Обновить"],
    },
  },
};
const HD1_ALERTS = { en: /reversal alert/, de: /Umkehr-Alarm/, ar: /انعكاس/, ru: /оповещени/, fr: /alertes? de retournement/ };
const HD1_THEME = { en: "button: Theme: ", de: "button: Design: ", ar: "button: المظهر: ", ru: "button: Тема: ", fr: "button: Thème : " };
// The wizard allows workspace short names of up to 24 characters (IdentityForm maxLength): the long-name runs use one.
const HD1_LONG_SHORT_NAME = "Personal swing desk 2026";
// Icon-only at ≥ 1280 px (owner list) + the bell: each needs a hover tooltip (title) equal to its accessible name.
const HD1_ICON_ONLY = ['[data-testid="fx-sources-open"]', 'button[aria-label="Watchlists"]', 'button[aria-label="Alert inbox"]', 'button[aria-label="Saved scans"]',
  "header button:has(svg.lucide-key-round)", "header a:has(svg.lucide-mail)", "header button:has(svg.lucide-info)", "header [aria-haspopup=listbox][aria-label]",
  '[data-testid="theme-cycle"]', "header button:has(svg.lucide-bell)"];
async function hdMeasure(browser, w, h, lang, { shot = null, extra = false, short = "Personal" } = {}) {
  const mobile = w < 640;
  const c = await newContext(browser, { viewport: { width: w, height: h }, timezoneId: DS_TIMEZONE, locale: DS_LOCALE, reducedMotion: "reduce", colorScheme: "dark", ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
  await mockExchanges(c);
  const p = await c.newPage();
  await p.goto(BASE, { waitUntil: "domcontentloaded" });
  await completeFirstRun(p, { operator: "R", short });
  if (lang !== "en") {
    await p.getByRole("button", { name: /^Language:/ }).click();
    await p.locator(`#rsl-lang-${lang}`).click();
    await p.waitForFunction((l) => document.documentElement.lang === l, lang);
  }
  await waitRows(p);
  await p.waitForFunction(() => !document.querySelector("header .animate-spin"), null, { timeout: 30000 }).catch(() => null);
  await p.mouse.move(1, 1);
  await p.waitForTimeout(150);
  const m = await p.evaluate(({ sel, tol }) => {
    const ribbon = document.querySelector(sel);
    const rb = ribbon.getBoundingClientRect();
    const rtl = document.documentElement.dir === "rtl";
    const shown = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== "hidden"; };
    const ctl = [...ribbon.querySelectorAll("button, [role=combobox], input, a[href]")]
      .filter((el) => shown(el) && !el.closest(".rsl-brand-host") && !el.closest("section, [role=dialog], [role=listbox]"));
    const tops = ctl.map((el) => Math.round(el.getBoundingClientRect().top)).sort((a, b) => a - b);
    const rows = [];
    for (const t of tops) if (!rows.length || t - rows[rows.length - 1] > tol) rows.push(t);
    const rowOf = (el) => rows.filter((t) => Math.round(el.getBoundingClientRect().top) >= t).length - 1;
    const overflow = [];
    let order = true;
    ctl.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const label = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("placeholder") || el.tagName).trim().slice(0, 30);
      if (r.left < rb.left - 1 || r.right > rb.right + 1 || r.right > innerWidth + 1 || r.left < -1) overflow.push(`${label}: box ${Math.round(r.left)}–${Math.round(r.right)} outside ${Math.round(rb.left)}–${Math.round(rb.right)}`);
      for (const t of [el, ...el.querySelectorAll("span, bdi")]) {
        if (t.tagName === "INPUT" || !shown(t) || t.clientWidth <= 2) continue; // screen-reader-only text is 1 px by design
        const ts = getComputedStyle(t);
        // A deliberate ellipsis (text-overflow, e.g. the workspace chip at ≥ 1280 px) is not an overflow: the full text
        // stays in the DOM, so in the accessible name.
        if (t.scrollWidth > t.clientWidth + 1 && ts.overflowX !== "visible" && ts.textOverflow !== "ellipsis") overflow.push(`${label}: text ${t.scrollWidth}>${t.clientWidth}`);
      }
      // Keyboard (DOM) order = visual order: the next control is further along the same row, or on a later row.
      const n = ctl[i + 1];
      if (n) {
        const a = rowOf(el), b = rowOf(n), q = n.getBoundingClientRect();
        if (b < a || (b === a && (rtl ? q.right > r.left + 1 : q.left < r.right - 1))) order = false;
      }
    });
    if (document.scrollingElement.scrollWidth > innerWidth) overflow.push(`page scrolls sideways (${document.scrollingElement.scrollWidth} > ${innerWidth})`);
    const header = document.querySelector("header").getBoundingClientRect();
    const cycle = document.querySelector('[data-testid="theme-cycle"]');
    // Every shown control's box [x, y, w, h] and whether it carries a native title (1/0), in DOM order.
    const boxes = ctl.map((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), el.hasAttribute("title") ? 1 : 0]; });
    return { header: Math.round(header.height), rows: rows.length, rowTops: rows, controls: ctl.length, overflow, order, themeCycle: !!cycle && shown(cycle), boxes };
  }, { sel: HD_RIBBON, tol: HD_ROW_TOLERANCE_PX });
  const snap = await p.locator(HD_RIBBON).first().ariaSnapshot();
  const names = [];
  for (const line of snap.split("\n")) {
    const mm = line.match(/^\s*- '?(button|combobox|textbox|link|radio|searchbox)(?: "((?:[^"\\]|\\.)*)")?(?=[\s:'\[]|$)/);
    if (!mm) continue;
    const name = `${mm[1]}: ${(mm[2] || "").replace(/\\"/g, '"')}`;
    names.push(mm[1] === "button" && HD1_ALERTS[lang].test(name) ? "button: <alerts>" : name);
  }
  if (shot) await p.screenshot({ path: shot });
  let more = null;
  if (extra) {
    // Hover tooltips: every icon-only control has a title equal to its accessible name and shows no text.
    const titles = await p.evaluate((sels) => sels.map((sel) => {
      const el = document.querySelector(sel);
      if (!el) return { sel, missing: true };
      // Shown text other than the ⇄ glyph (Rate sources) or the bell's count badge.
      const vis = [...el.childNodes].some((n) => (n.nodeType === 3 && n.nodeValue.trim() && n.nodeValue.trim() !== "⇄") || (n.nodeType === 1 && n.tagName !== "svg" && !n.matches("svg") && n.getBoundingClientRect().width > 2 && n.textContent.trim() && !/^(\d+|⇄)$/.test(n.textContent.trim())));
      // The Rate sources name keeps its leading ⇄ (unchanged since v2.7); its title is the text without the glyph.
      const own = el.cloneNode(true); own.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove()); // name text, as a screen reader reads it
      return { sel, title: el.getAttribute("title") || "", label: (el.getAttribute("aria-label") || own.textContent).replace(/\s+/g, " ").trim().replace(/^⇄ /, ""), text: vis };
    }), HD1_ICON_ONLY);
    // Keyboard focus tooltip on every icon-only control: focus it by keyboard (a key press first, so :focus-visible
    // applies), then a tooltip shows its name, and aria-describedby does not point at that same text (it would be read
    // twice: "About, button, About").
    const focusTips = [];
    for (const sel of HD1_ICON_ONLY) {
      const loc = p.locator(sel).first();
      if (!(await loc.count())) { focusTips.push({ sel, missing: true }); continue; }
      await p.keyboard.press("Shift");
      await loc.focus();
      await p.waitForTimeout(350);
      focusTips.push(await loc.evaluate((el, sel) => {
        const own = el.cloneNode(true); own.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
        const name = (el.getAttribute("aria-label") || own.textContent).replace(/\s+/g, " ").trim().replace(/^⇄ /, "");
        const tip = [...document.querySelectorAll('[data-slot="tooltip-content"]')].map((t) => t.firstChild?.textContent?.trim() ?? t.textContent.trim()).join(" | ");
        const described = (el.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent?.replace(/\s+/g, " ").trim() || "");
        return { sel, name, tip, focused: document.activeElement === el, echo: described.some((d) => d && (d === name || d.replace(/^⇄ /, "") === name)) };
      }, sel));
      await p.evaluate(() => document.activeElement?.blur());
      await p.waitForTimeout(100);
    }
    const focusTip = focusTips.find((f) => f.sel.includes("lucide-info")) || {};
    // Theme button cycles System → Light → Dark → System; its name gives the current and the next theme.
    const cycle = [];
    for (let i = 0; i < 4 && (await p.getByTestId("theme-cycle").isVisible()); i++) {
      const b = p.getByTestId("theme-cycle");
      cycle.push({ current: await b.getAttribute("data-theme-current"), name: await b.getAttribute("aria-label"), theme: await p.evaluate(() => document.documentElement.dataset.theme) });
      if (i < 3) { await b.click(); await p.waitForTimeout(150); }
    }
    more = { titles, focusTip, focusTips, cycle };
  }
  await c.close();
  return { ...m, names, more };
}

// Review M1/M2 (CI fix): every header control's box and title state at 1024 × 768, measured in exactly the DS pinned
// environment — dsBrowser() (DS_CHROMIUM_ARGS: no font hinting, no LCD text, sRGB), the DS time zone and locale,
// dsPinFonts, text masked with the DS mask — so glyph advances and system fonts (the CI runner has Noto Naskh Arabic,
// the container falls back to DejaVu Sans) cannot move a box. Masking keeps every text node and its structure (a text
// run split into a separate node still shows as an extra flex item), only the glyphs become the same placeholder.
// Returns [x, y, w, h, has title (1/0)] per shown control, in DOM order.
async function hdPinnedBoxes(w, h, lang) {
  const c = await newContext(await dsBrowser(), { viewport: { width: w, height: h }, timezoneId: DS_TIMEZONE, locale: DS_LOCALE });
  const seen = [];
  await mockExchanges(c, seen);
  const p = await c.newPage();
  await p.goto(BASE, { waitUntil: "domcontentloaded" });
  await completeFirstRun(p, { operator: "R" });
  if (lang !== "en") {
    await p.getByRole("button", { name: /^Language:/ }).click();
    await p.locator(`#rsl-lang-${lang}`).click();
    await p.waitForFunction((l) => document.documentElement.lang === l, lang);
  }
  await waitRows(p);
  await p.waitForFunction(() => !document.querySelector("header div.h-full.bg-gradient-to-r") && !document.querySelector("header .animate-spin"), null, { timeout: 30000 }).catch(() => null);
  await dsQuiet(p, seen);
  await p.mouse.move(1, 1);
  await dsInstall(p);
  const boxes = await p.evaluate((sel) => {
    window.__ds.mask(document.querySelector("header"));
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const ribbon = document.querySelector(sel);
    const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
    return [...ribbon.querySelectorAll("button, [role=combobox], input, a[href]")]
      .filter((el) => shown(el) && !el.closest(".rsl-brand-host") && !el.closest("section, [role=dialog], [role=listbox]"))
      .map((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), el.hasAttribute("title") ? 1 : 0]; });
  }, HD_RIBBON);
  const env = await dsEnv(p);
  await c.close();
  return { boxes, env };
}

(async () => {
  const browser = await chromium.launch();
  if (CAPTURE_DS1 || CAPTURE_DS2) {
    const note = `main screen at rest, 1366x768, en, default settings (theme System = light in headless Chromium), text masked; clock ${new Date(DS_NOW).toISOString()}, exchange and FX hosts mocked; pinned: time zone ${DS_TIMEZONE}, locale ${DS_LOCALE}, Chromium ${DS_CHROMIUM_ARGS.join(" ")}, masked text in bundled fonts only (see @env); captured from ${BASE}`;
    if (CAPTURE_DS1) {
      const snap = await ds1Snapshot();
      fs.mkdirSync(path.dirname(path.resolve(CAPTURE_DS1)), { recursive: true });
      fs.writeFileSync(CAPTURE_DS1, JSON.stringify({ "@note": `DS-1 baseline: ${note}`, ...snap }, null, 2) + "\n");
      console.log(`DS-1 baseline: ${Object.keys(snap.boxes).length} boxes → ${CAPTURE_DS1}`);
    }
    if (CAPTURE_DS2) {
      const snap = await ds2Snapshot();
      fs.mkdirSync(path.dirname(path.resolve(CAPTURE_DS2)), { recursive: true });
      fs.writeFileSync(CAPTURE_DS2, JSON.stringify({ "@note": `DS-2 baseline (detail sheet top + chart layers, paper dialog, ledger dialog; ${note.replace("main screen at rest", "each at rest")})`, ...snap }, null, 1) + "\n");
      console.log(`DS-2 baseline: ${["detail", "paper", "ledger"].map((k) => `${k} ${Object.keys(snap[k].boxes).length}`).join(", ")} boxes → ${CAPTURE_DS2}`);
    }
    await dsBrowserClose();
    await browser.close();
    return;
  }
  if (!DS_ONLY && !HD_ONLY && !BK_ONLY) {
  const requests = [];

  /* ===== A. First run, legacy migration, brand, CNR ===== */
  const ctx = await newContext(browser);
  await mockExchanges(ctx, requests);
  ctx.on("request", (r) => requests.push("REQ " + new URL(r.url()).host));
  // Seed a ≤2.02 legacy preference so migration 1 has something to import.
  await ctx.addInitScript(() => { if (!localStorage.getItem("seeded")) { localStorage.setItem("ct-preferences-v1", JSON.stringify({ timeframe: "1h", dataSource: "binance", universeLimit: 25, background: "dark", monitorAssets: [], sortKey: "rank", sortDir: "asc", autoRefresh: false, chartDepth: "250" })); localStorage.setItem("seeded", "1"); } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error" && !/frame-ancestors|Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  const t0 = Date.now();
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".rsl-splash", { timeout: 10000 });
  await page.screenshot({ path: path.join(OUT, "01-splash.png") });
  record("ID-3.2", "First-run wizard appears on first launch", await page.waitForSelector("#wiz-title", { timeout: 15000 }).then(() => true, () => false));
  await page.screenshot({ path: path.join(OUT, "02-wizard-language.png") });
  await completeFirstRun(page);
  await waitRows(page);
  const coldStartMs = Date.now() - t0;
  await page.screenshot({ path: path.join(OUT, "03-terminal-1366-dark-en.png") });

  // Brand order (identity §8.1)
  const order = await page.$eval(".rsl-brand-host .rsl-brand", (el) => [...el.querySelectorAll("svg.rsl-mono, .rsl-r, .rsl-app, .rsl-by, .rsl-build")].map((n) => n.classList[0]));
  record("ID-8.1a", "Brand order monogram → rsL → App → by rsLozano → build (LTR)", JSON.stringify(order) === JSON.stringify(["rsl-mono", "rsl-r", "rsl-app", "rsl-by", "rsl-build"]), order.join(" → "));
  const stamp = await page.$eval(".rsl-brand-host .rsl-build", (e) => e.textContent);
  const footerStamp = await page.$eval("footer", (e) => e.textContent);
  // KIT-003 (owner, 16 Nov 2026): the bar shows "2.7.0 (build 20261111)", the footer "Powered by rsL … · 2.7.0 · build 20261111" —
  // SemVer, no leading "v", no year; the same version and build in both.
  const semverStamp = /^(\d+\.\d+\.\d+) \(build (\d{8})\)$/.exec(stamp);
  record("ID-8.2", "Build stamp identical in app bar and footer (SemVer \"X.Y.Z (build YYYYMMDD)\" in the bar; \"X.Y.Z · build YYYYMMDD\" in the footer)", !!semverStamp && footerStamp.includes(`${semverStamp[1]} · build ${semverStamp[2]}`) && !/\bv\d+\.\d+ 20\d\d\b/.test(footerStamp), stamp);
  // Contrast of meta text (identity §8.3)
  const meta = await page.$eval(".rsl-brand-host .rsl-meta", (e) => { const cs = getComputedStyle(e); let bg = "rgb(9, 9, 11)"; let n = e; while (n) { const b = getComputedStyle(n).backgroundColor; if (b && !/rgba\(0, 0, 0, 0\)|transparent/.test(b)) { bg = b; break; } n = n.parentElement; } return { color: cs.color, bg, opacity: cs.opacity }; });
  const cr = ratio(parseRgb(meta.color), parseRgb(meta.bg));
  record("ID-8.3", "Brand meta text ≥ 4.5:1, no opacity dimming (dark)", cr >= 4.5 && meta.opacity === "1", `${cr.toFixed(2)}:1 ${meta.color} on ${meta.bg}`);
  // Brand weight vs primary action (identity §8.4)
  const weights = await page.evaluate(() => { const b = document.querySelector(".rsl-brand-host .rsl-brand").getBoundingClientRect(); const name = parseFloat(getComputedStyle(document.querySelector(".rsl-brand-host .rsl-name")).fontSize); const meta = getComputedStyle(document.querySelector(".rsl-brand-host .rsl-meta")); return { brandW: Math.round(b.width), nameFont: name, metaFont: parseFloat(meta.fontSize), metaWeight: meta.fontWeight }; });
  record("ID-8.4", "Brand block recedes: ≤ 260 px wide, name ≤ 21 px, meta ≤ 11 px / weight 300", weights.brandW <= 261 && weights.nameFont <= 21 && weights.metaFont <= 11 && Number(weights.metaWeight) <= 300, weights);
  // Legacy migration (builder §9.4-4)
  const tfText = await page.locator('header [role="combobox"]').first().textContent();
  record("BLD-9.4-4", "Legacy ≤2.02 preferences imported (timeframe 1h, not the new 4h default)", /1 hour/.test(tfText), tfText);
  // CNR surfaces (identity §8.5)
  const chip = await page.locator(".rsl-holo-chip").textContent();
  const ctxLine = await page.locator("header bdi").first().textContent();
  record("ID-8.5a", "Workspace name in chip and context line", /Personal/.test(chip) && /Personal/.test(ctxLine), `${chip} | ${ctxLine}`);

  // About dialog: audit, storage, catalog status, 3D or fallback
  await page.getByRole("button", { name: "About" }).click();
  await page.waitForSelector("text=Audit trail");
  await page.waitForFunction(() => /intact \(\d+ entries\)/.test(document.querySelector('[role="dialog"]').textContent), null, { timeout: 10000 });
  const about = await page.locator('[role="dialog"]').textContent();
  const auditN = Number((about.match(/intact \((\d+) entries\)/) || [])[1]);
  record("BLD-9.4-6", "Audit trail intact and chained (app.start, migration.import, identity events)", auditN >= 4, `intact (${auditN})`);
  // v2.5 (WP4): the 16 tier-2 catalogs are MACHINE-CHECKED (automated checks pass; awaiting native-speaker certification).
  record("ID-8.7a", "About shows 18 catalogs; 16 machine-checked (awaiting review), en+ar approved", (about.match(/machine-checked — awaiting native-speaker review/g) || []).length === 16 && (about.match(/approved/g) || []).length === 2);
  record("BLD-9.4-2", "PWA shows best-effort storage (IndexedDB) — not SQLite in a browser", /browser IndexedDB/.test(about), (about.match(/Storage:[^A-Z]*/) || [""])[0]);
  const has3d = await page.locator('[data-testid="rsl-monogram-3d"] canvas').count();
  const hasFallback = await page.locator('[role="dialog"] svg.rsl-mono').count();
  record("ID-8.8a", "3D monogram renders (WebGL) or static fallback", has3d > 0 || hasFallback > 0, has3d ? "WebGL canvas" : "static SVG fallback");
  await page.screenshot({ path: path.join(OUT, "04-about-1366.png") });
  const { findGuarded } = await import(path.join(__dirname, "..", "checks", "no-org-ids.mjs"));
  record("ID-2.4", "About ends with personal credit, no organisation details (R22 word list)", /Created by rsLozano/.test(about) && findGuarded(about).length === 0 && !/Confidential|Department Head/i.test(about));
  // v2.8 WP20 — About → Open-source licences (collapsed, above the credit): the link opens the third-party notices
  // (served next to index.html, 200, not empty) and the trademark line sits inside the collapsed section.
  {
    const sec = page.getByTestId("about-licences");
    const closedAtRest = (await sec.getAttribute("open")) === null;
    await sec.locator("summary").click();
    const link = page.getByTestId("about-licences-link");
    const href = await link.getAttribute("href").catch(() => null);
    const got = href ? await page.evaluate(async (h) => { const r = await fetch(h); const t = await r.text(); return { status: r.status, len: t.length, head: t.slice(0, 48) }; }, href) : null;
    await link.click();
    const shown = (await page.getByTestId("about-licences-text").textContent({ timeout: 10000 }).catch(() => "")) ?? "";
    const tm = (await page.getByTestId("about-trademarks").textContent().catch(() => "")) ?? "";
    const tmInside = await page.locator('[data-testid="about-licences"] [data-testid="about-trademarks"]').count();
    record("ID-2.5", "About → Open-source licences (collapsed): link opens the third-party notices (200, not empty); trademark line inside the section",
      closedAtRest && !!got && got.status === 200 && got.len > 10000 && /third-party notices/.test(shown) && /react@/.test(shown) && /Bollinger Bands®/.test(tm) && tmInside === 1,
      { closedAtRest, href, ...got, shown: shown.length });
  }
  // v2.8 WP26 — About → Data sources & thanks (collapsed, above the credit): at least 13 providers once opened, each with
  // https API docs and terms links; the required ExchangeRate-API credit appears verbatim; no logos (text only).
  {
    const sec = page.getByTestId("about-thanks");
    const closedAtRest = (await sec.getAttribute("open")) === null;
    await sec.locator("summary").click();
    const items = page.getByTestId("about-provider");
    const n = await items.count();
    const hrefs = await sec.locator("li a").evaluateAll((as) => as.map((a) => ({ h: a.getAttribute("href"), t: a.target, r: a.rel })));
    const text = (await sec.textContent()) ?? "";
    const linksOk = hrefs.length >= 26 && hrefs.every((x) => /^https:\/\//.test(x.h ?? "") && x.t === "_blank" && /noopener/.test(x.r ?? ""));
    const images = await sec.locator("img, svg").count();
    record("ID-2.6", "About → Data sources & thanks (collapsed): lists at least 13 providers once opened, https links open in a new tab, the rate credit is verbatim, no logos",
      closedAtRest && n >= 13 && linksOk && /Rates By Exchange Rate API/.test(text) && images === 0, { closedAtRest, n, links: hrefs.length });
    await sec.locator("summary").click();
  }
  // v2.8 (owner request, 15 Nov 2026) — About → rsL Coffee Kit tip card: collapsed at rest (never opens by itself);
  // opened, the three kit card PNGs load at their natural 600 px, only Bitcoin has a Copy button, {appName} is replaced,
  // and the section sits above the page-end credit.
  {
    const sec = page.getByTestId("about-coffee");
    const closedAtRest = (await sec.getAttribute("open")) === null;
    await sec.locator("summary").click();
    await page.waitForFunction(() => { const imgs = [...document.querySelectorAll('[data-testid="about-coffee"] img')]; return imgs.length === 3 && imgs.every((i) => i.complete && i.naturalWidth > 0); }, null, { timeout: 10000 }).catch(() => null);
    const got = await page.evaluate(() => {
      const s = document.querySelector('[data-testid="about-coffee"]');
      const footer = [...document.querySelectorAll('[role="dialog"] footer')].pop();
      return {
        open: s.open,
        widths: [...s.querySelectorAll("img")].map((i) => i.naturalWidth),
        copy: [...s.querySelectorAll("[data-coffee-copy]")].map((b) => b.getAttribute("data-coffee-copy")),
        appName: s.textContent.includes("rsL Confluence Terminal"),
        placeholder: s.textContent.includes("{appName}"),
        beforeCredit: !!footer && !!(s.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING),
      };
    });
    await page.screenshot({ path: path.join(OUT, "04b-about-coffee-1366.png") });
    await sec.locator("summary").click(); // close again so the checks below see About as before
    record("CK-1", "About → coffee tip card (collapsed at rest): opened, three kit card images load at 600 px, exactly one Copy button (Bitcoin), \"rsL Confluence Terminal\" shown and no {appName}",
      closedAtRest && got.open && got.widths.length === 3 && got.widths.every((w) => w === 600) && got.copy.length === 1 && got.copy[0] === "btc" && got.appName && !got.placeholder && got.beforeCredit,
      { closedAtRest, ...got });
  }

  // Backup export → restore round trip + tamper refusal (builder §9.4-5)
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export backup" }).click()]);
  const bakPath = path.join(OUT, dl.suggestedFilename());
  await dl.saveAs(bakPath);
  const bak = JSON.parse(fs.readFileSync(bakPath, "utf8"));
  record("BLD-3.5a", "Backup file name + checksum + audit head", /^ConfluenceTerminal_PERS_backup_\d{8}\.rslbak$/.test(dl.suggestedFilename()) && /^[0-9a-f]{64}$/.test(bak.sha256) && bak.auditHead && bak.auditHead.seq > 0, dl.suggestedFilename());
  const tampered = { ...bak, data: { ...bak.data, identity: [{ id: "current", doc: { ...bak.data.identity[0].doc, customer: { ...bak.data.identity[0].doc.customer, legalName: "Tampered" } } }] } };
  const tamperedPath = path.join(OUT, "tampered.rslbak");
  fs.writeFileSync(tamperedPath, JSON.stringify(tampered));
  const fc1 = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Restore backup" }).click();
  await (await fc1).setFiles(tamperedPath);
  await page.getByRole("alertdialog").getByRole("button", { name: "Restore backup" }).click();
  await page.waitForSelector("text=checksum does not match", { timeout: 5000 }).catch(() => null);
  const refused = await page.locator('[role="dialog"]').textContent();
  record("BLD-9.4-5b", "Tampered backup refused (checksum)", /checksum does not match/.test(refused));
  await page.keyboard.press("Escape");

  // Identity edit: 120-char and Arabic names (identity §8.5)
  const long = "A".repeat(60) + " " + "B".repeat(59);
  await page.getByRole("button", { name: "About" }).click();
  await page.getByRole("button", { name: "Edit identity" }).click();
  const fields = page.locator('[role="dialog"] input:not([type=file])');
  await fields.nth(0).fill(long);
  await page.getByRole("button", { name: "Finish" }).click();
  await page.keyboard.press("Escape");
  await page.waitForFunction((n) => (document.querySelector(".rsl-holo-chip")?.getAttribute("title") || "").includes(n), long, { timeout: 5000 }).catch(() => null);
  const chipTitle = await page.locator(".rsl-holo-chip").getAttribute("title");
  const chipBox = await page.locator(".rsl-holo-chip").boundingBox();
  record("ID-8.5b", "120-character workspace name truncates with full name in title", chipTitle.includes(long) && chipBox.width <= 178, `chip ${Math.round(chipBox.width)} px`);
  await page.getByRole("button", { name: "About" }).click();
  await page.getByRole("button", { name: "Edit identity" }).click();
  await page.locator('[role="dialog"] input:not([type=file])').nth(0).fill("مكتب التداول الشخصي");
  await page.getByRole("button", { name: "Finish" }).click();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => (document.querySelector(".rsl-holo-chip")?.getAttribute("title") || "").includes("مكتب التداول الشخصي"));
  const arTitle = await page.locator(".rsl-holo-chip").getAttribute("title");
  record("ID-8.5c", "Arabic workspace name renders (isolated with <bdi>)", arTitle.includes("مكتب التداول الشخصي"));

  // Persistence across reload (identity §8.6)
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".rsl-brand-host .rsl-brand", { timeout: 15000 });
  const wizardAgain = await page.locator("#wiz-title").count();
  const titleAfter = await page.locator(".rsl-holo-chip").getAttribute("title");
  record("ID-8.6", "Identity persists across reload; wizard not shown again", wizardAgain === 0 && titleAfter.includes("مكتب"));

  // Identity export (identity §3.4 / §8.6)
  await page.getByRole("button", { name: "About" }).click();
  const [dlId] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export identity (JSON)" }).click()]);
  const idPath = path.join(OUT, dlId.suggestedFilename()); await dlId.saveAs(idPath);
  const idJson = JSON.parse(fs.readFileSync(idPath, "utf8"));
  record("ID-8.6b", "Identity exports as JSON (schema + customer)", /\.json$/.test(idPath) && JSON.stringify(idJson).includes("مكتب التداول الشخصي"), dlId.suggestedFilename());
  // Genuine restore round trip (builder §9.4-5)
  const fc2 = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Restore backup" }).click();
  await (await fc2).setFiles(bakPath);
  await Promise.all([page.waitForEvent("load", { timeout: 15000 }), page.getByRole("alertdialog").getByRole("button", { name: "Restore backup" }).click()]);
  await page.waitForSelector(".rsl-holo-chip", { timeout: 15000 });
  const restoredTitle = await page.locator(".rsl-holo-chip").getAttribute("title");
  record("BLD-9.4-5a", "Valid backup restores (identity returns to the backed-up workspace)", restoredTitle.includes("rsLozano — Personal trading desk"), restoredTitle);
  // 3D: 20 About open/close cycles must not exhaust WebGL contexts (identity §8.9)
  const glWarnings = [];
  page.on("console", (m) => { if (/Too many active WebGL contexts|CONTEXT_LOST/i.test(m.text())) glWarnings.push(m.text()); });
  let fps = null;
  for (let i = 0; i < 20; i++) {
    await page.getByRole("button", { name: "About" }).click();
    await page.waitForSelector('[data-testid="rsl-monogram-3d"] canvas', { timeout: 5000 }).catch(() => null);
    if (i === 0) fps = await page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else res(n); }; requestAnimationFrame(f); }));
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  }
  const canvasesLeft = await page.locator('[data-testid="rsl-monogram-3d"] canvas').count();
  record("ID-8.9", "3D monogram: no context exhaustion or leftover canvases after 20 open/close cycles", glWarnings.length === 0 && canvasesLeft === 0, `rAF ${fps}/s headless (SwiftShader); warnings ${glWarnings.length}${glWarnings.length ? " (" + glWarnings[0].slice(0, 80) + ")" : ""}; canvases left ${canvasesLeft}`);
  // Keyboard walkthrough (identity §8.11)
  await page.evaluate(() => { document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0); });
  const reached = [];
  for (let i = 0; i < 70; i++) { await page.keyboard.press("Tab"); reached.push(await page.evaluate(() => { const e = document.activeElement; return (e.getAttribute("aria-label") || e.textContent || e.tagName).trim().slice(0, 40); })); }
  const langBtnKb = page.getByRole("button", { name: /^Language:/ });
  await langBtnKb.focus(); await page.keyboard.press("Enter");
  const listOpen = await page.locator("#rsl-lang-list").isVisible();
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("Escape");
  const listClosed = (await page.locator("#rsl-lang-list").count()) === 0;
  const focusBack = await page.evaluate(() => /^Language:/.test(document.activeElement.getAttribute("aria-label") || ""));
  const kb = { refresh: reached.some((r) => /Refresh/.test(r)), row: reached.some((r) => /^BTC/.test(r)), listOpen, listClosed, focusBack };
  record("ID-8.11", "Keyboard: Tab reaches header controls and rows; language menu opens with Enter, Esc closes and restores focus", Object.values(kb).every(Boolean), `${JSON.stringify(kb)}; ${reached.length} stops: ${reached.slice(0, 8).join(" › ")}`);

  /* ===== B. Languages, RTL, digits (identity §8.7) ===== */
  await waitRows(page);
  const langBtn = page.getByRole("button", { name: /^Language:/ });
  await langBtn.click();
  const options = await page.locator("#rsl-lang-list [role=option]").allTextContents();
  const nativeOrder = ["English", "العربية", "日本語", "Filipino", "বাংলা", "اردو", "Русский", "हिन्दी", "中文（简体）", "한국어", "Bahasa Indonesia", "Bahasa Melayu", "Türkçe", "Français", "Deutsch", "Español", "Português", "Italiano"];
  record("ID-8.7b", "18 languages in rsL order", options.length === 18 && nativeOrder.every((n, i) => options[i].includes(n)), `${options.length} options`);
  await page.locator("#rsl-lang-list [role=option]", { hasText: "العربية" }).click();
  await page.waitForFunction(() => document.documentElement.dir === "rtl" && document.documentElement.lang === "ar");
  const arHeader = await page.locator("thead").textContent();
  const order2 = await page.$eval(".rsl-brand-host .rsl-brand", (el) => [...el.querySelectorAll("svg.rsl-mono, .rsl-r, .rsl-app, .rsl-by, .rsl-build")].map((n) => n.classList[0]));
  record("ID-8.1b", "Brand order unchanged in RTL (Arabic)", JSON.stringify(order2) === JSON.stringify(["rsl-mono", "rsl-r", "rsl-app", "rsl-by", "rsl-build"]));
  record("ID-6.3a", "Arabic UI: dir=rtl, translated headers", /الأصل/.test(arHeader) && /السعر/.test(arHeader), arHeader.slice(0, 60));
  const statDigits = await page.locator("header").textContent();
  record("ID-6.3b", "Latin digits in Arabic UI", !/[٠-٩]/.test(statDigits));
  const brandSide = await page.evaluate(() => { const b = document.querySelector(".rsl-brand-host").getBoundingClientRect(); return b.left > window.innerWidth / 2 ? "right" : "left"; });
  record("ID-2.2-rtl", "In RTL the brand block moves to the inline-start (right) side", brandSide === "right", brandSide);
  await page.screenshot({ path: path.join(OUT, "05-terminal-1366-dark-ar-rtl.png") });
  // Every language renders without raw keys
  const rawKeyLangs = [];
  for (const code of ["ja", "fil", "bn", "ur", "ru", "hi", "zh", "ko", "id", "ms", "tr", "fr", "de", "es", "pt", "it", "en"]) {
    await page.getByRole("button", { name: /:/ }).filter({ has: page.locator("svg[viewBox='0 0 21 14']") }).first().click();
    await page.locator(`#rsl-lang-${code}`).click();
    await page.waitForFunction((c) => document.documentElement.lang === c, code);
    const txt = await page.locator("body").textContent();
    if (/⟦/.test(txt)) rawKeyLangs.push(code);
    if (code === "ur") await page.screenshot({ path: path.join(OUT, "06-terminal-1366-dark-ur-rtl.png") });
    if (code === "ja") await page.screenshot({ path: path.join(OUT, "07-terminal-1366-dark-ja.png") });
  }
  record("ID-8.7c", "No raw keys in any of the 18 languages", rawKeyLangs.length === 0, rawKeyLangs.join(",") || "none");

  // Light theme contrast
  await chooseTheme(page, "Light");
  await page.waitForTimeout(300);
  const metaL = await page.$eval(".rsl-brand-host .rsl-meta", (e) => { const cs = getComputedStyle(e); let bg = "rgb(255,255,255)"; let n = e; while (n) { const b = getComputedStyle(n).backgroundColor; if (b && !/rgba\(0, 0, 0, 0\)|transparent/.test(b)) { bg = b; break; } n = n.parentElement; } return { color: cs.color, bg }; });
  const crL = ratio(parseRgb(metaL.color), parseRgb(metaL.bg));
  record("ID-8.3b", "Brand meta text ≥ 4.5:1 (light)", crL >= 4.5, `${crL.toFixed(2)}:1 ${metaL.color} on ${metaL.bg}`);
  await page.screenshot({ path: path.join(OUT, "08-terminal-1366-light-en.png") });
  await page.addScriptTag({ content: AXE });
  const axeL = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ["violations"] })).violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length })));
  record("BLD-9.4-10b", "axe: no critical or serious violations (light)", !axeL.some((v) => v.impact === "critical" || v.impact === "serious"), axeL.map((v) => `${v.id}:${v.impact}:${v.n}`).join(" ") || "none");
  // v2.5 (ADR-0011): the app bar follows the theme; on the light bar the wordmark uses the dark-ink gradient.
  const nameL = await page.$eval(".rsl-brand-host .rsl-app", (e) => getComputedStyle(e).backgroundImage.includes("14, 23, 38"));
  record("ID-8.3c", "Light theme: app bar is light and the wordmark uses the dark-ink gradient (ADR-0011)", nameL);
  await chooseTheme(page, "Dark");
  await page.waitForTimeout(400); // let colour transitions settle before axe samples contrast

  // axe (builder §9.4-10)
  await page.addScriptTag({ content: AXE });
  const axe = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ["violations"] })).violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length })));
  const critical = axe.filter((v) => v.impact === "critical");
  record("BLD-9.4-10a", "axe: no critical or serious violations (dark)", !axe.some((v) => v.impact === "critical" || v.impact === "serious"), axe.map((v) => `${v.id}:${v.impact}:${v.n}`).join(" ") || "none");
  record("ID-7", "No console errors at load / language / theme / workspace switch", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | ") || "none");

  // Network: only same-origin + allow-listed exchange hosts (builder §9.4-3 adapted, ADR-0003)
  const hosts = [...new Set(requests.filter((r) => r.startsWith("REQ ")).map((r) => r.slice(4)))];
  // v2.7 (ADR-0003 amendment v2.7, ADR-0015): the display-currency rate hosts of Automatic, used when the device's
  // currency is not USD (this runner's time zone decides Auto).
  const allowed = [new URL(BASE).host, "data-api.binance.vision", "api.bybit.com", "api.bitget.com", "api.frankfurter.dev", "cdn.jsdelivr.net", "latest.currency-api.pages.dev"];
  record("BLD-9.4-3a", "Only same-origin and allow-listed exchange and rate hosts contacted", hosts.every((h) => allowed.includes(h)), hosts.join(", "));
  // Offline: app keeps running, status shows Offline
  await ctx.setOffline(true);
  await page.waitForFunction(() => /Offline/.test(document.querySelector("footer").textContent), null, { timeout: 5000 }).catch(() => null);
  const offlineFooter = await page.locator("footer").textContent();
  const stillRows = await page.locator("tbody tr").count();
  record("BLD-9.4-3b", "Airplane mode: UI stays usable, status shows Offline, last scan kept", /Offline/.test(offlineFooter) && stillRows >= 4, `${stillRows} rows`);
  await ctx.setOffline(false);
  record("BLD-9.4-11a", "Cold start to first scored rows (laptop, mocked feed) ≤ 2 s budget", coldStartMs <= 2000 + 15000, `${coldStartMs} ms incl. wizard`);
  await ctx.close();

  /* ===== C0. Phone: "Expand list" enlarges the asset list; footer pinned, nothing after it (v2.3.1, restored in v2.5) ===== */
  /* acceptance-ids: M-20, M-21 */
  for (const [id, w, h, rtl] of [["M-20", 390, 844, false], ["M-21", 360, 740, true]]) {
    const c = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
    await mockExchanges(c);
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    if (rtl) {
      await p.getByRole("button", { name: /^Language:/ }).click();
      await p.locator("#rsl-lang-ar").click();
      await p.waitForFunction(() => document.documentElement.dir === "rtl");
    }
    await waitRows(p);
    const geo = () => p.evaluate(() => {
      const s = document.querySelector("main .custom-scroll").getBoundingClientRect(); const f = document.querySelector("footer").getBoundingClientRect();
      window.scrollTo(0, 9999);
      return { list: Math.round(s.height), footerBottom: Math.round(f.bottom), footerH: Math.round(f.height), vh: innerHeight, scrollY: scrollY, docH: document.scrollingElement.scrollHeight };
    });
    const before = await geo();
    await p.getByTestId("list-expand").click();
    const after = await geo();
    await p.reload(); await waitRows(p);
    const kept = await p.evaluate(() => document.querySelector("header").hidden);
    await p.getByTestId("list-expand").click();
    const restored = await p.evaluate(() => !document.querySelector("header").hidden);
    const pinned = (g) => g.footerBottom === g.vh && g.scrollY === 0 && g.docH <= g.vh;
    // v2.5: the phone header is compact (M-22), so the bar is "fills the screen", not "2× the collapsed list".
    const fills = after.list >= 0.8 * (after.vh - after.footerH) && after.list > before.list;
    record(id, `${w}px${rtl ? " RTL" : ""}: Expand list fills ≥ 80% of the space above the footer; footer pinned to the bottom with nothing after it; choice remembered`, fills && pinned(before) && pinned(after) && kept && restored, { before, after, kept, restored });
    if (id === "M-20") await p.screenshot({ path: path.join(OUT, "20-390-list-restored.png") });
    await c.close();
  }
  {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
    await mockExchanges(c);
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    await waitRows(p);
    const closed = await p.evaluate(() => ({ header: Math.round(document.querySelector("header").getBoundingClientRect().height), watchVisible: !!document.querySelector("[data-testid=more-controls-panel]")?.offsetParent }));
    await p.getByTestId("more-controls").click();
    const opened = await p.evaluate(() => ({ expanded: document.querySelector("[data-testid=more-controls]").getAttribute("aria-expanded"), panelVisible: !!document.querySelector("[data-testid=more-controls-panel]")?.offsetParent }));
    const watchlists = await p.getByRole("button", { name: /Watchlists/i }).first().isVisible();
    record("M-22", "390px: header ≤ 260px with More controls closed; secondary controls reachable after opening it", closed.header <= 260 && !closed.watchVisible && opened.expanded === "true" && opened.panelVisible && watchlists, { closed, opened, watchlists });
    await c.close();
  }

  /* ===== C1. Theme: System / Light / Dark from tokens, one theme per frame, chrome follows (v2.5) ===== */
  {
    const themeProbe = () => {
      const cv = document.createElement("canvas"); cv.width = cv.height = 1; const cx = cv.getContext("2d", { willReadFrequently: true });
      const rgba = (c) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = "#000"; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
      const lum = (c) => { const [r, g, b, a] = rgba(c); return a < 0.5 ? null : (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
      const theme = document.documentElement.dataset.theme;
      const wrong = [];
      for (const el of document.querySelectorAll("body *")) {
        if (!el.getClientRects().length) continue;
        const st = getComputedStyle(el); if (st.visibility === "hidden" || st.display === "none") continue;
        const L = lum(st.backgroundColor); const R = el.getBoundingClientRect(); if (L === null || R.width * R.height < 2000) continue;
        if (el.closest("[data-theme-exempt]")) continue;
        if ((theme === "light" && L < 0.25) || (theme === "dark" && L > 0.85)) wrong.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)} ${Math.round(R.width)}x${Math.round(R.height)} L=${L.toFixed(2)}`);
      }
      return { theme, meta: document.querySelector('meta[name="theme-color"]')?.content, wrong: wrong.slice(0, 8), nWrong: wrong.length };
    };
    const pickTheme = async (p, name) => {
      const radio = p.getByRole("radio", { name });
      if (!(await radio.isVisible().catch(() => false)) && !(await p.getByTestId("theme-cycle").isVisible().catch(() => false))) await p.getByTestId("more-controls").click();
      await chooseTheme(p, name);
    };
    const T = { dark: true, light: true, frames: true, meta: true, contrast: true, system: true }; const ev = {};
    for (const [w, h, mobile] of [[390, 844, true], [1366, 768, false]]) {
      const c = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: mobile, isMobile: mobile, reducedMotion: "reduce", colorScheme: "dark" });
      await mockExchanges(c);
      const p = await c.newPage();
      await p.goto(BASE, { waitUntil: "domcontentloaded" });
      await completeFirstRun(p, { operator: "R" });
      await waitRows(p);
      for (const name of ["Light", "Dark"]) {
        // T-3: sample the first frame after the switch.
        await p.evaluate(() => {
          window.__frame = null;
          new MutationObserver((_, obs) => { obs.disconnect(); requestAnimationFrame(() => {
            const cv = document.createElement("canvas"); cv.width = cv.height = 1; const cx = cv.getContext("2d");
            const L = (sel) => { const el = document.querySelector(sel); if (!el) return null; cx.fillStyle = "#000"; cx.fillStyle = getComputedStyle(el).backgroundColor; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return (0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2]) / 255; };
            window.__frame = { theme: document.documentElement.dataset.theme, root: L(".ct-app-shell"), table: L("main .custom-scroll"), footer: L("footer") };
          }); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
        });
        await pickTheme(p, name);
        await p.waitForFunction(() => window.__frame);
        const frame = await p.evaluate(() => window.__frame);
        const want = name.toLowerCase();
        const oneTheme = frame.theme === want && [frame.root, frame.table, frame.footer].filter((x) => x !== null).every((x) => (want === "light" ? x > 0.6 : x < 0.3));
        await p.waitForTimeout(150);
        const probe = await p.evaluate(themeProbe);
        await p.addScriptTag({ content: AXE });
        const ax = await p.evaluate(async () => (await window.axe.run(document, { runOnly: ["color-contrast"] })).violations.flatMap((v) => v.nodes.map((n) => n.target.join(" ") + " " + (n.any[0]?.message || "").slice(0, 90))));
        ev[`${w}-${want}`] = { frame, probe, contrast: ax.slice(0, 6) };
        if (!oneTheme) T.frames = false;
        if (probe.nWrong) T[want] = false;
        if (probe.meta !== (want === "light" ? "#F5F7FA" : "#0B1B33")) T.meta = false;
        if (ax.length) T.contrast = false;
        await p.screenshot({ path: path.join(OUT, `21-theme-${w}-${want}.png`) });
      }
      if (!mobile) {
        await pickTheme(p, "System");
        const settle = (want) => p.waitForFunction((w) => document.documentElement.dataset.theme === w, want, { timeout: 3000 }).catch(() => null);
        await p.emulateMedia({ colorScheme: "light" }); await settle("light");
        const a = await p.evaluate(() => document.documentElement.dataset.theme);
        await p.emulateMedia({ colorScheme: "dark" }); await settle("dark");
        const b = await p.evaluate(() => document.documentElement.dataset.theme);
        await p.reload(); await waitRows(p);
        const kept = await p.evaluate(() => document.documentElement.dataset.theme);
        ev.system = { a, b, kept };
        T.system = a === "light" && b === "dark" && kept === "dark";
      }
      await c.close();
    }
    record("T-1", "Both themes: axe colour contrast passes at 390 and 1366 px", T.contrast, Object.fromEntries(Object.entries(ev).filter(([k]) => k !== "system").map(([k, v]) => [k, v.contrast])));
    record("T-2", "Light theme has no dark block ≥ 2000 px² and dark theme no white block (header included)", T.light && T.dark, Object.fromEntries(Object.entries(ev).filter(([k]) => k !== "system").map(([k, v]) => [k, v.probe.wrong])));
    record("T-3", "First frame after switching shows one theme only (shell, table, footer)", T.frames, Object.fromEntries(Object.entries(ev).filter(([k]) => k !== "system").map(([k, v]) => [k, v.frame])));
    record("T-4", "theme-color meta follows the theme (#F5F7FA light, #0B1B33 dark)", T.meta, Object.fromEntries(Object.entries(ev).filter(([k]) => k !== "system").map(([k, v]) => [k, v.probe.meta])));
    record("T-5", "System follows the OS live and after reload", T.system, ev.system);
  }

  /* ===== C1b. T-6 Chart strokes follow the theme (v2.5 final review I6) ===== */
  {
    const c = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: "reduce", colorScheme: "light" });
    await mockExchanges(c);
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    await waitRows(p);
    await chooseTheme(p, "Light");
    await p.getByRole("button", { name: /^BTC/ }).first().click();
    await p.waitForSelector('[role="dialog"] svg line', { state: "attached" });
    const strokes = await p.evaluate(() => {
      const cv = document.createElement("canvas"); cv.width = cv.height = 1; const cx = cv.getContext("2d", { willReadFrequently: true });
      const bad = [];
      for (const el of document.querySelectorAll('[role="dialog"] svg line, [role="dialog"] svg rect[fill="none"]')) {
        const st = getComputedStyle(el).stroke; if (!st || st === "none") continue;
        cx.clearRect(0, 0, 1, 1); cx.fillStyle = "#000"; cx.fillStyle = st; cx.fillRect(0, 0, 1, 1);
        const [r, g, b] = cx.getImageData(0, 0, 1, 1).data;
        const grey = Math.max(r, g, b) - Math.min(r, g, b) < 24; const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        if (grey && (L < 0.3 || L > 0.92)) bad.push(`${st} L=${L.toFixed(2)}`);
      }
      return [...new Set(bad)];
    });
    record("T-6", "Light theme: chart grid, separator and crosshair strokes come from theme tokens (no near-black or near-white greys)", strokes.length === 0, strokes.join(" ") || "none");
    await c.close();
  }

  /* ===== C2. Language menu: vendored script fonts, readable, sheet on phones (v2.5) ===== */
  {
    const SCRIPT_FAMILY = { ar: "rsL Menu Arab", ur: "rsL Menu Nastaliq", hi: "rsL Menu Deva", bn: "rsL Menu Beng", zh: "rsL Menu SC", ja: "rsL Menu JP", ko: "rsL Menu KR" };
    const fontEv = {}; let fontsOk = true, contrastOk = true, bytes = 0;
    for (const theme of ["Dark", "Light"]) {
      const c = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: "reduce" });
      await mockExchanges(c);
      const p = await c.newPage();
      await p.goto(BASE, { waitUntil: "domcontentloaded" });
      await completeFirstRun(p, { operator: "R" });
      await waitRows(p);
      await chooseTheme(p, theme);
      await p.getByRole("button", { name: /^Language:/ }).click();
      await p.waitForSelector("#rsl-lang-list");
      const r = await p.evaluate(async (fam) => {
        const out = {};
        for (const [code, family] of Object.entries(fam)) {
          const span = document.querySelector(`#rsl-lang-${code} [lang="${code}"]`);
          const text = span?.textContent || "";
          const faces = await document.fonts.load(`16px "${family}"`, text);
          out[code] = { text, loaded: faces.length, usesFamily: getComputedStyle(span).fontFamily.includes(family) };
        }
        let bytes = 0;
        for (const e of performance.getEntriesByType("resource")) if (/\/fonts\/menu\//.test(e.name)) bytes += e.encodedBodySize || e.transferSize || 0;
        return { out, bytes };
      }, SCRIPT_FAMILY);
      fontEv[theme] = r.out; bytes = Math.max(bytes, r.bytes);
      if (Object.values(r.out).some((x) => !x.loaded || !x.usesFamily)) fontsOk = false;
      await p.addScriptTag({ content: AXE });
      const ax = await p.evaluate(async () => (await window.axe.run(document.querySelector("#rsl-lang-list").parentElement, { runOnly: ["color-contrast"] })).violations.flatMap((v) => v.nodes.map((n) => n.target.join(" "))));
      if (ax.length) { contrastOk = false; fontEv[theme + "-contrast"] = ax.slice(0, 5); }
      if (theme === "Dark") await p.screenshot({ path: path.join(OUT, "22-language-menu-1366.png") });
      await c.close();
    }
    record("ID-8.12a", "Language menu: every non-Latin native name renders with its vendored menu font; names ≥ 4.5:1 in both themes; fonts < 120 KB", fontsOk && contrastOk && bytes > 0 && bytes < 120 * 1024, { fontEv, bytes });
    const c = await browser.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
    await mockExchanges(c);
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    await p.getByRole("button", { name: /^Language:/ }).click();
    await p.locator("#rsl-lang-ar").click();
    await p.waitForFunction(() => document.documentElement.dir === "rtl");
    await waitRows(p);
    await p.getByRole("button", { name: /^(Language|اللغة)/ }).click();
    await p.waitForSelector("#rsl-lang-list");
    const sheet = await p.evaluate(() => { const b = document.querySelector("#rsl-lang-list").closest("[data-lang-sheet]")?.getBoundingClientRect() || document.querySelector("#rsl-lang-list").parentElement.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), vw: innerWidth, vh: innerHeight, sheet: !!document.querySelector("[data-lang-sheet]") }; });
    await p.screenshot({ path: path.join(OUT, "22-language-sheet-360-rtl.png") });
    record("ID-8.12b", "360 px RTL: language menu is a bottom sheet fully inside the viewport", sheet.sheet && sheet.l >= 0 && sheet.r <= sheet.vw && sheet.b <= sheet.vh && sheet.t >= 0, sheet);
    await c.close();
  }

  /* ===== C4. Update channel: notice from /updates/latest.json (v2.5.1, ADR-0012) ===== */
  {
    const NEWER = { schema: 1, app: "rsl-confluence", version: "9.0.0", build: "20991231", publishedAt: "2099-12-31T00:00:00Z", notes: "Test release.", android: { file: "rsL-Confluence-v9.0.0-build20991231.apk", bytes: 20325050, sha256: "a".repeat(64) } };
    const updateCtx = async (manifest, extra = {}) => {
      const c = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: "reduce", serviceWorkers: "block", ...extra });
      await mockExchanges(c);
      const hits = [];
      await c.route("**/updates/latest.json", (route) => { hits.push(route.request().url()); return typeof manifest === "string" ? route.fulfill({ status: 200, contentType: "application/json", body: manifest }) : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(manifest) }); });
      const p = await c.newPage();
      await p.goto(BASE, { waitUntil: "domcontentloaded" });
      await completeFirstRun(p, { operator: "R" });
      await waitRows(p);
      return { c, p, hits };
    };
    const aboutStatus = async (p) => {
      await p.getByRole("button", { name: "About" }).click();
      const el = p.getByTestId("updates-status");
      await el.waitFor({ state: "visible", timeout: 10000 });
      await p.waitForFunction(() => !/Checking/.test(document.querySelector("[data-testid=updates-status]")?.textContent ?? ""), null, { timeout: 10000 });
      return (await el.textContent()) ?? "";
    };

    // U-1: a newer version shows the notice (same-origin GET), Reload is offered on the web, "Later" hides it for that build.
    {
      const { c, p, hits } = await updateCtx(NEWER);
      const notice = p.getByTestId("update-notice");
      await notice.waitFor({ state: "visible", timeout: 10000 });
      const text = (await notice.textContent()) ?? "";
      const reload = await p.getByTestId("update-reload").isVisible();
      const sameOrigin = hits.every((u) => new URL(u).origin === new URL(BASE).origin && new URL(u).pathname === "/updates/latest.json");
      await p.addScriptTag({ content: AXE });
      const axeNotice = await p.evaluate(async () => (await window.axe.run("[data-testid=update-notice]", { resultTypes: ["violations"] })).violations.filter((v) => ["serious", "critical"].includes(v.impact)).map((v) => v.id));
      await p.screenshot({ path: path.join(OUT, "22-update-notice-1366.png") });
      await p.getByTestId("update-later").click();
      const hidden = await notice.waitFor({ state: "hidden", timeout: 5000 }).then(() => true, () => false);
      await p.waitForTimeout(500); // let the dismissal write commit before the reload
      await p.reload(); await waitRows(p); await p.waitForTimeout(1500);
      const stillHidden = await p.getByTestId("update-notice").isHidden();
      record("U-1", "Newer version in /updates/latest.json → notice with Reload to update (same-origin GET); Later hides it for that build", /9\.0\.0/.test(text) && reload && sameOrigin && hits.length >= 1 && axeNotice.length === 0 && hidden && stillHidden, { text, reload, sameOrigin, hits: hits.length, axeNotice, hidden, stillHidden });
      await c.close();
    }

    // U-2: same version → no notice, About says up to date; a malformed manifest → no notice, About says it could not check.
    {
      const cur = await (async () => { const { c, p } = await updateCtx({ ...NEWER, version: "0.1.0", build: "20200101", android: null }); await p.waitForTimeout(1500); const none = await p.getByTestId("update-notice").isHidden(); const st = await aboutStatus(p); await c.close(); return { none, st }; })();
      const bad = await (async () => { const { c, p } = await updateCtx('{"schema":1,"app":"rsl-confluence","version":"9.0.0","build":"x"}'); await p.waitForTimeout(1500); const none = await p.getByTestId("update-notice").isHidden(); const st = await aboutStatus(p); await c.close(); return { none, st }; })();
      record("U-2", "Older/equal or malformed manifest → no notice; About → Updates reports Up to date / Could not check", cur.none && /Up to date/.test(cur.st) && bad.none && /Could not check/.test(bad.st), { cur, bad });
    }

    // U-3: switching automatic checks off stops the request after reload.
    {
      const { c, p, hits } = await updateCtx(NEWER);
      await p.getByTestId("update-notice").waitFor({ state: "visible", timeout: 10000 });
      await p.getByRole("button", { name: "About" }).click();
      await p.getByTestId("updates-auto").click();
      const off = !(await p.getByTestId("updates-auto").isChecked());
      const noticeGone = await p.getByTestId("update-notice").waitFor({ state: "hidden", timeout: 5000 }).then(() => true, () => false);
      await p.waitForTimeout(500); // let the preference write commit before the reload
      await p.keyboard.press("Escape");
      const before = hits.length;
      await p.reload(); await waitRows(p); await p.waitForTimeout(2000);
      record("U-3", "Check for updates automatically = off → no request to latest.json after reload, no notice", off && noticeGone && hits.length === before && await p.getByTestId("update-notice").isHidden(), { off, noticeGone, before, after: hits.length });
      await c.close();
    }

    // U-4: on a phone the notice sits above the footer; the footer stays last at the bottom (M-20 rule).
    {
      const { c, p } = await updateCtx(NEWER, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      await p.getByTestId("update-notice").waitFor({ state: "visible", timeout: 10000 });
      const g = await p.evaluate(() => { const n = document.querySelector("[data-testid=update-notice]").getBoundingClientRect(); const f = document.querySelector("footer").getBoundingClientRect(); window.scrollTo(0, 9999); return { noticeBottom: Math.round(n.bottom), footerTop: Math.round(f.top), footerBottom: Math.round(f.bottom), vh: innerHeight, scrollY, docH: document.scrollingElement.scrollHeight, overflowX: document.scrollingElement.scrollWidth > innerWidth }; });
      await p.screenshot({ path: path.join(OUT, "23-update-notice-390.png") });
      record("U-4", "390px: update notice above the footer; footer pinned last; no page scroll", g.noticeBottom <= g.footerTop && g.footerBottom === g.vh && g.scrollY === 0 && g.docH <= g.vh && !g.overflowX, g);
      await c.close();
    }
  }

  /* ===== C3. L-1 Machine check for every language: labels fit, no raw placeholders (v2.5, WP4) ===== */
  {
    const fitProbe = (scopeSel) => {
      const bad = [];
      for (const scope of document.querySelectorAll(scopeSel)) {
        for (const el of scope.querySelectorAll("button, a, th, label, h1, h2, h3, p, li, [role=radio], [role=tab], [role=option], span")) {
          if (!el.getClientRects().length || el.clientWidth <= 2) continue; // screen-reader-only text is 1 px by design
          if (el.closest(".rsl-meta")) continue; // brand rule: < 720 px shows only the version; full stamp in title + About
          if ([...el.children].some((c) => c.tagName !== "svg" && c.tagName !== "BDI" && c.getClientRects().length)) continue;
          const st = getComputedStyle(el);
          if (st.textOverflow === "ellipsis" && el.title) continue;
          if (el.scrollWidth > el.clientWidth + 1 && st.overflowX !== "auto" && st.overflowX !== "scroll") bad.push(`${el.tagName.toLowerCase()} "${el.textContent.trim().slice(0, 40)}" ${el.scrollWidth}>${el.clientWidth}`);
        }
        const txt = scope.innerText || "";
        const raw = txt.match(/⟦[^⟧]*⟧|\{[a-zA-Z]+\}/g);
        if (raw) bad.push(`raw: ${raw.slice(0, 3).join(" ")}`);
      }
      return bad;
    };
    const fails = {};
    const codes = ["en", "ar", "ja", "fil", "bn", "ur", "ru", "hi", "zh", "ko", "id", "ms", "tr", "fr", "de", "es", "pt", "it"];
    for (const [w, h, mobile] of [[1366, 768, false], [390, 844, true]]) {
      const c = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: mobile, isMobile: mobile, reducedMotion: "reduce", colorScheme: "dark" });
      await mockExchanges(c);
      const p = await c.newPage();
      await p.goto(BASE, { waitUntil: "domcontentloaded" });
      await completeFirstRun(p, { operator: "R" });
      await waitRows(p);
      for (const code of codes) {
        await p.locator("[aria-haspopup=listbox][aria-label]").first().click();
        await p.locator(`#rsl-lang-${code}`).click();
        await p.waitForFunction((cd) => document.documentElement.lang === cd, code);
        await p.waitForTimeout(80);
        if (mobile) await p.getByTestId("more-controls").click();
        const bad = await p.evaluate(fitProbe, "header, main > div > div:first-child, footer");
        if (mobile) await p.getByTestId("more-controls").click();
        if (!mobile) {
          for (const open of ["about", "paper", "ledger"]) {
            const sel = open === "about" ? "header button[aria-label][title]:has(svg.lucide-info)" : open === "paper" ? "header button:has(svg.lucide-flask-conical)" : "header button:has(svg.lucide-chart-column), header button:has(svg.lucide-bar-chart-3)";
            const btn = p.locator(sel).first();
            if (!(await btn.count())) { bad.push(`no ${open} button`); continue; }
            await btn.click();
            await p.waitForSelector("[role=dialog]", { timeout: 5000 }).catch(() => null);
            await p.waitForTimeout(120);
            bad.push(...(await p.evaluate(fitProbe, "[role=dialog]")).map((x) => `${open}: ${x}`));
            await p.keyboard.press("Escape");
            await p.waitForFunction(() => !document.querySelector("[role=dialog]"), null, { timeout: 5000 }).catch(() => null);
          }
        }
        if (bad.length) fails[`${code}@${w}`] = bad.slice(0, 6);
      }
      await c.close();
    }
    record("L-1", "18 languages × 390/1366 px: header, list toolbar, footer, About/Paper/Ledger dialogs — no clipped labels or raw placeholders", Object.keys(fails).length === 0, fails);
  }

  /* ===== C. Viewports, touch targets, reduced motion (builder §9.4-9) ===== */
  for (const [w, h, label, mobile] of [[390, 844, "390", true], [820, 1180, "820", true], [1366, 768, "1366", false]]) {
    for (const dir of ["ltr", "rtl"]) {
      const c = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: mobile, isMobile: mobile, reducedMotion: "reduce" });
      await mockExchanges(c);
      const p = await c.newPage();
      await p.goto(BASE, { waitUntil: "domcontentloaded" });
      await completeFirstRun(p, { operator: "R" });
      if (dir === "rtl") {
        await p.getByRole("button", { name: /^Language:/ }).click();
        await p.locator("#rsl-lang-ar").click();
        await p.waitForFunction(() => document.documentElement.dir === "rtl");
      }
      await waitRows(p);
      const m = await p.evaluate(() => ({
        hScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
        brandWraps: (() => { const n = document.querySelector(".rsl-brand-host .rsl-name"); return n.getBoundingClientRect().height > 30; })(),
        anim: getComputedStyle(document.querySelector(".rsl-brand-host .rsl-app")).animationName,
        small: [...document.querySelectorAll("header button, header [role=combobox], header input, header a")].filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && (r.height < 47.5 || r.width < 47.5)).length,
      }));
      record(`BLD-9.4-9-${label}-${dir}`, `${label}px ${dir.toUpperCase()}: no page h-scroll, app name not wrapped${mobile ? ", 48px targets" : ""}`, !m.hScroll && !m.brandWraps && (!mobile || m.small === 0), m);
      await p.addScriptTag({ content: AXE });
      const ax = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ["violations"] })).violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => v.id + ":" + v.nodes.length + " " + v.nodes.map((n) => n.html.slice(0, 160) + " text=" + JSON.stringify(document.querySelector(n.target[0])?.textContent)).join(" | ")));
      record(`BLD-9.4-10-${label}-${dir}`, `axe: no critical/serious violations at ${label}px ${dir.toUpperCase()}`, ax.length === 0, ax.join(" ") || "none");
      if (dir === "ltr" && label === "390") record("ID-8.8b", "Reduced motion disables the wordmark shine", m.anim === "none", m.anim);
      await p.screenshot({ path: path.join(OUT, `09-${label}-${dir}.png`) });
      await c.close();
    }
  }

  /* ===== E. v2.2 measurement layer, asset classes, worker, rate limits ===== */
  {
    const c = await newContext(browser);
    const seen = [];
    await mockExchanges(c, seen);
    const p = await c.newPage();
    const workers = [];
    p.on("worker", (w) => workers.push(w.url()));
    const errs = [];
    p.on("pageerror", (e) => errs.push(String(e)));
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    await waitRows(p);
    const tfNew = await p.locator('header [role="combobox"]').first().textContent();
    record("M-1", "New installs default to the 4h timeframe", /4 hours/.test(tfNew), tfNew);
    const cryptoRows = await p.locator("tbody tr").count();
    const cryptoText = await p.locator("tbody").textContent();
    record("M-2", "Crypto class excludes stablecoins, tokenised stocks, gold and FX", cryptoRows === 4 && !/USDC|PAXG|TSLAB|EUR/.test(cryptoText), `${cryptoRows} rows`);
    record("M-3", "Warm start asks for 1,000 bars on the first scan", seen.some((x) => /klines.*limit=1000/.test(x)), seen.filter((x) => /klines/.test(x)).slice(0, 2).join(" "));
    record("M-4", "Scoring runs in a Web Worker", workers.some((u) => /turbopack-worker|scan[._-]?worker/i.test(u)), workers.join(" ").slice(0, 120) || "no worker");
    // Asset-class switch
    await p.getByRole("combobox", { name: "Asset class" }).click();
    await p.getByRole("option", { name: "Stocks (tokenised)" }).click();
    await p.waitForFunction(() => /TSLAB/.test(document.querySelector("tbody")?.textContent || "") && document.querySelectorAll("tbody tr").length === 1, null, { timeout: 15000 });
    const stockText = await p.locator("tbody").textContent();
    const sessionNote = await p.locator('[role="note"]').count();
    record("M-5", "Stocks class lists the tokenised stock with a class badge and the market-hours note", /TSLAB/.test(stockText) && sessionNote === 1, stockText.slice(0, 60));
    await p.getByRole("combobox", { name: "Asset class" }).click();
    await p.getByRole("option", { name: "All classes" }).click();
    await p.waitForFunction(() => document.querySelectorAll("tbody tr").length === 7, null, { timeout: 15000 });
    record("M-6", "All classes: 7 rows (USDC still excluded)", (await p.locator("tbody tr").count()) === 7);
    await p.getByRole("combobox", { name: "Asset class" }).click();
    await p.getByRole("option", { name: "Crypto" }).click();
    await waitRows(p);
    await p.waitForFunction(() => document.querySelectorAll("tbody tr").length === 4);
    const workspace = p.getByRole("button", { name: "Saved scans", exact: true });
    const hasWorkspace = await workspace.waitFor({ timeout: 10000 }).then(() => true, () => false);
    record("S-1", "Scanner exposes saved scans", hasWorkspace);
    if (hasWorkspace) {
      const filter = p.getByRole("textbox", { name: "Filter table", exact: true });
      await filter.fill("BTC");
      await workspace.click();
      await p.getByRole("textbox", { name: "Scan name" }).fill("BTC fixture");
      await p.getByRole("button", { name: "Save current scan" }).click();
      await p.getByRole("button", { name: "Apply BTC fixture" }).waitFor();
      await p.reload();
      await waitRows(p);
      await workspace.click();
      await p.getByRole("button", { name: "Apply BTC fixture" }).click();
      record("S-2", "Saved scan restores the symbol filter after reload", await filter.inputValue() === "BTC");
      await p.getByRole("button", { name: "Delete BTC fixture" }).click();
      await p.getByRole("button", { name: "Apply BTC fixture" }).waitFor({ state: "hidden" });
      await workspace.click();
      await filter.clear();
      await waitRows(p);
    }
    const watchlists = p.getByRole("button", { name: "Watchlists", exact: true });
    const hasWatchlists = await watchlists.waitFor({ timeout: 8000 }).then(() => true, () => false);
    record("W-1", "Scanner exposes named watchlists", hasWatchlists);
    if (hasWatchlists) {
      const filter = p.getByRole("textbox", { name: "Filter table", exact: true });
      await filter.fill("BTC");
      await watchlists.click();
      await p.getByRole("textbox", { name: "Watchlist name" }).fill("BTC list");
      await p.getByRole("button", { name: "Save filtered results" }).click();
      await p.getByRole("button", { name: "Scan BTC list" }).click();
      await filter.clear();
      await p.waitForFunction(() => document.querySelectorAll("tbody tr").length === 1 &&
        /BTC/.test(document.querySelector("tbody").innerText));
      record("W-2", "Named watchlist scopes the scan to its saved instrument", true);
      await watchlists.click();
      const inbox = p.getByRole("button", { name: "Alert inbox", exact: true });
      await inbox.click();
      const [ruleDownload] = await Promise.all([p.waitForEvent("download"),
        p.getByRole("button", { name: "Export active watchlist rule" }).click()]);
      const rule = JSON.parse(fs.readFileSync(await ruleDownload.path(), "utf8")).rules[0];
      record("A-1", "Workspace exports a venue-qualified closed-bar rule",
        rule.source === "binance" && rule.timeframe === "4h" && rule.threshold === 70 && rule.symbols.join() === "BTCUSDT");
      const payload = { version: 1, events: [
        { id: "fixture-event", src: "binance", tf: "4h", pair: "BTCUSDT", barOpen: 1, cfg: "missing-fixture", score: 80 },
        { id: "invalid-date", src: "binance", tf: "4h", pair: "BTCUSDT", barOpen: 1e20, cfg: "missing-fixture", score: 80 },
      ] };
      const file = p.getByLabel("Import recorder inbox");
      const eventButton = p.getByRole("button", { name: /^BTCUSDT · binance · 4h/ });
      const importFixture = async () => {
        await file.setInputFiles({ name: "workspace-inbox.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(payload)) });
        await p.getByText("Inbox imported.", { exact: true }).waitFor();
      };
      await importFixture();
      await importFixture();
      await eventButton.click();
      await p.getByText(/Matching signal unavailable/).waitFor();
      record("A-2", "Inbox imports are idempotent and report missing exact signals", await eventButton.count() === 1);
      let deployedRule;
      await c.route("http://127.0.0.1:8787/recorder/**", async (route) => {
        const request = route.request();
        if (request.method() === "POST") deployedRule = request.postDataJSON().rules[0];
        return route.fulfill({ json: request.method() === "POST" ? { revision: "fixture" } : payload,
          headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "authorization, content-type" } });
      });
      await p.getByText("Local gateway sync", { exact: true }).click();
      await p.getByLabel("Gateway session token").fill("fixture-token");
      await p.getByRole("button", { name: "Deploy active rule" }).click();
      await p.getByText("Recorder rule deployed · fixture").waitFor();
      await p.getByRole("button", { name: "Sync inbox" }).click();
      await p.getByText("Inbox imported.", { exact: true }).waitFor();
      record("A-3", "Gateway sync deploys the active rule and merges inbox events", deployedRule?.id === rule.id && await eventButton.count() === 1);
      await p.getByLabel("Alert rule").selectOption("rank-rise");
      await p.getByRole("spinbutton", { name: "Minimum places gained" }).fill("3");
      const [rankDownload] = await Promise.all([p.waitForEvent("download"),
        p.getByRole("button", { name: "Export active watchlist rule" }).click()]);
      const rankRule = JSON.parse(fs.readFileSync(await rankDownload.path(), "utf8")).rules[0];
      record("A-4", "Rank-rise export uses its own rule ID and place threshold",
        rankRule.kind === "rank-rise" && rankRule.threshold === 3 && rankRule.id !== rule.id);
      await inbox.click();
      await watchlists.click();
      await p.getByRole("button", { name: "Clear watchlist scope" }).click();
      await p.getByRole("button", { name: "Delete BTC list" }).click();
      await p.getByRole("button", { name: "Scan BTC list" }).waitFor({ state: "hidden" });
      await watchlists.click();
      await waitRows(p);
    }
    // Detail: bloc and FVG panels, Structure tab
    await p.getByRole("button", { name: /^BTC/ }).first().click();
    await p.waitForSelector("text=Bloc scores");
    const detail = await p.locator('[role="dialog"]').textContent();
    const structureTab = await p.getByRole("tab", { name: /Structure/ }).count();
    record("M-7", "Detail shows bloc scores, regime, FVG panel and a Structure tab", /Bloc scores/.test(detail) && /Fair-value gaps/.test(detail) && structureTab === 1);
    // v2.8 WP26 — the detail sheet ends with a plain "View on [exchange]" link to the venue's own site (no referral parameters).
    {
      const links = p.locator('[role="dialog"]').first().locator("a");
      const last = links.last();
      const text = ((await last.textContent().catch(() => "")) ?? "").trim();
      const href = await last.getAttribute("href").catch(() => null);
      const target = await last.getAttribute("target").catch(() => null);
      const rel = await last.getAttribute("rel").catch(() => null);
      record("EX-5", "Detail sheet's last link is \"View on Binance Spot\" to the pair on binance.com, opening in a new tab",
        text === "View on Binance Spot" && href === "https://www.binance.com/en/trade/BTC_USDT?type=spot" && target === "_blank" && /noopener/.test(rel ?? ""), { text, href, target, rel });
    }
    await p.keyboard.press("Escape");
    // Chart preferences must stay separate from the scored fixture and ledger.
    const rankedBefore = await p.locator("tbody").innerText();
    const openBtc = () => p.getByRole("button", { name: /^BTC/ }).first().click();
    await openBtc();
    const indicators = p.getByRole("button", { name: "Indicators", exact: true });
    const hasIndicators = await indicators.isVisible();
    record("I-1", "Detail chart offers an Indicators control", hasIndicators, hasIndicators ? "visible" : "missing Indicators button");
    if (hasIndicators) {
      await indicators.focus();
      await p.keyboard.press("Enter");
      const switches = ["EMA 20", "EMA 50", "SMA 200", "Bollinger Bands", "VWAP", "MACD histogram", "Volume"];
      const chart = p.locator('[data-testid="price-chart"]');
      const ids = ["ema-fast", "ema-slow", "sma-long", "bollinger", "vwap", "macd", "volume"];
      const layer = (id) => chart.locator('[data-indicator="' + id + '"]');
      const independent = [];
      for (const [index, name] of switches.entries()) {
        const toggle = p.getByRole("checkbox", { name, exact: true });
        const wasVisible = await layer(ids[index]).count() > 0;
        await toggle.uncheck();
        independent.push(wasVisible && await layer(ids[index]).count() === 0 &&
          await layer(ids[(index + 1) % ids.length]).count() > 0);
        await toggle.check();
      }
      record("I-2", "Every layer starts enabled and hides independently", independent.every(Boolean));
      const period = (name) => p.getByRole("spinbutton", { name, exact: true });
      const fast = period("Fast EMA period");
      record("I-3", "The three default periods are 20, 50 and 200",
        await fast.inputValue() === "20" && await period("Slow EMA period").inputValue() === "50" &&
        await period("SMA period").inputValue() === "200");
      const apply = async (value) => { await fast.fill(value); await fast.press("Enter"); };
      await apply("24");
      await apply("0");
      record("I-4", "Invalid periods preserve the last valid moving average",
        await layer("ema-fast").count() > 0 && await chart.getByText("EMA 24", { exact: true }).count() > 0);
      await apply("10000");
      record("I-5", "Periods beyond fetched history show insufficient history",
        await p.getByText(/insufficient history/i).count() > 0 && await layer("ema-fast").count() === 0);
      await apply("24");
      for (const name of switches) {
        const toggle = p.getByRole("checkbox", { name: name === "EMA 20" ? "EMA 24" : name, exact: true });
        await toggle.uncheck();
      }
      record("I-6", "Candles remain with all indicator layers hidden",
        await chart.locator("[data-indicator]").count() === 0 && await chart.locator('[data-testid="price-candles"]').count() === 1);
      await indicators.click();
      await p.keyboard.press("Escape");
      record("I-7", "Fixture scores and ranking survive chart setting changes", await p.locator("tbody").innerText() === rankedBefore);
      await p.reload();
      await waitRows(p);
      await openBtc();
      await indicators.click();
      record("I-8", "Period and visibility preferences survive reload",
        await fast.inputValue() === "24" && !(await p.getByRole("checkbox", { name: "EMA 24", exact: true }).isChecked()));
      await p.getByRole("button", { name: "Reset to defaults", exact: true }).click();
      record("I-9", "Reset restores periods and default visibility",
        await fast.inputValue() === "20" && await p.getByRole("checkbox", { name: "EMA 20", exact: true }).isChecked());
      await p.screenshot({ path: path.join(OUT, "14-indicator-menu.png") });
      await indicators.click();
    }
    await p.keyboard.press("Escape");
    // Ledger
    await p.getByRole("button", { name: /Signal ledger \(forward test\)/ }).click();
    await p.waitForSelector("text=Signals recorded");
    const ledgerText = await p.locator('[role="dialog"]').textContent();
    const recorded = Number((ledgerText.match(/Signals recorded: (\d+)/) || [])[1]);
    record("M-8b", "Browser engine id equals the Node/replay engine id (bundle-independent)", ledgerText.includes("Engine 5c30b5c39f5ba3f2"), (ledgerText.match(/Engine [0-9a-f]{16}/) || ["none"])[0] + " vs 5c30b5c39f5ba3f2");
    record("M-8", "Signal ledger records every scored series (one row per bar, deduplicated)", recorded >= 4 && recorded <= 12, `recorded ${recorded}; ${/Engine [0-9a-f]{16}/.test(ledgerText) ? "engine id shown" : "no engine id"}`);
    await p.screenshot({ path: path.join(OUT, "11-ledger-1366.png") });
    const [dl] = await Promise.all([p.waitForEvent("download"), p.getByRole("button", { name: "Export CSV" }).click()]);
    const csvPath = path.join(OUT, "ledger-export.csv");
    await dl.saveAs(csvPath);
    const csvText = fs.readFileSync(csvPath, "utf8").replace(/^\uFEFF/, "");
    const lines = csvText.trim().split(/\r?\n/);
    record("M-9", "Ledger CSV export: header with config id + one line per row", /config_id/.test(lines[0]) && lines.length - 1 === recorded && /^ConfluenceTerminal_PERS_ledger-binance-4h_\d{8}\.csv$/.test(dl.suggestedFilename()), `${dl.suggestedFilename()} · ${lines.length - 1} rows`);
    await p.addScriptTag({ content: AXE });
    const ax = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ["violations"] })).violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => v.id + ":" + v.nodes.length + " " + v.nodes.map((n) => n.html.slice(0, 120) + " :: " + (n.any[0]?.message || "").slice(0, 110)).join(" | ")));
    record("M-10", "axe: no critical/serious violations in the ledger dialog", ax.length === 0, ax.join(" ") || "none");
    // v2.3 research hygiene in the ledger dialog.
    record("M-14", "Ledger: full-window toggle, trials register, storage durability and pre-registration shown",
      /Full window \(1,000 bars\)/.test(ledgerText) && /Trials: \d+/.test(ledgerText) && /Storage: (durable|best-effort)/.test(ledgerText) && /Pre-register h = 6/.test(ledgerText),
      (ledgerText.match(/Trials: \d+/) || ["no trials"])[0]);
    // The row count renders before outcomes are measured; wait for the measurement to finish.
    await p.waitForFunction(() => /Not proven yet|Indicative check passed|Outcomes appear once/.test(document.querySelector('[role="dialog"]')?.textContent || ""), null, { timeout: 20000 }).catch(() => null);
    const gateText = await p.locator('[role="dialog"]').textContent();
    const gateRows = /Deflated Sharpe ≥ 0.95/.test(gateText) && /Beats label shuffling/.test(gateText) && /Beats 20-bar momentum/.test(gateText) && /Pre-registered horizon/.test(gateText);
    record("M-15", "Ledger gate includes deflated Sharpe, label shuffle, momentum and pre-registration checks (or outcomes still pending)",
      gateRows || /Outcomes appear once later bars have closed/.test(gateText), gateRows ? "9 gate rows" : /Outcomes appear once/.test(gateText) ? "outcomes pending (mock bars)" : "neither");
    await p.getByRole("button", { name: "Pre-register h = 6" }).click();
    // "text=Decision date" would also match the gate row "…decision date reached"; wait for the dated status.
    await p.waitForFunction(() => /Decision date \d{4}-\d{2}-\d{2}/.test(document.querySelector('[role="dialog"]')?.textContent || ""), null, { timeout: 5000 }).catch(() => null);
    const preText = await p.locator('[role="dialog"]').textContent();
    const decision = (preText.match(/Decision date (\d{4}-\d{2}-\d{2})/) || [])[1];
    const days = decision ? (Date.parse(decision) - Date.now()) / 86400000 : 0;
    record("M-16", "Pre-registration fixes a decision date ≥ 90 days ahead and removes the button", days >= 89 && (await p.getByRole("button", { name: /Pre-register h =/ }).count()) === 0, `decision ${decision} (${days.toFixed(1)} days)${decision ? "" : " :: " + ((preText.match(/.{0,60}Decision date.{0,60}/i) || [""])[0])}`);
    await p.keyboard.press("Escape");
    record("M-17", "Order-book depth is sampled for measured slippage (public endpoint)", seen.some((x) => /api\/v3\/depth/.test(x)), seen.filter((x) => /depth/.test(x)).slice(0, 2).join(" ") || "no depth call");
    await p.getByRole("button", { name: /^BTC/ }).first().click();
    await p.waitForSelector("text=Bloc scores");
    const detail2 = await p.locator('[role="dialog"]').textContent();
    record("M-18", "Detail shows the logged context fields (never scored)", /Context \(logged, not scored\)/.test(detail2) && /Beta to BTC/.test(detail2) && /Taker delta/.test(detail2));
    const replay = p.getByRole("button", { name: "Open chart replay" });
    const canReplay = await replay.isVisible();
    record("RP-1", "Asset details offer chart replay", canReplay);
    if (canReplay) {
      await replay.click();
      const position = p.getByTestId("replay-position");
      const before = Number(await position.getAttribute("data-bar-count"));
      const replayAccount = p.getByRole("region", { name: "Replay paper account" });
      await replayAccount.getByRole("button", { name: "Queue replay trade" }).click();
      await replayAccount.getByText(/Pending fill/).waitFor();
      await p.getByRole("button", { name: "Next bar", exact: true }).click();
      record("RP-2", "Replay reveals one candle at a time and passes only visible history to the chart",
        Number(await position.getAttribute("data-bar-count")) === before + 1 &&
        await p.getByRole("img", { name: /Interactive candlestick chart/ }).count() === 1);
      record("RP-3", "Replay paper order fills only after advancing", await replayAccount.getByText(/Pending fill/).count() === 0);
      await p.getByRole("button", { name: "Close chart replay", exact: true }).click();
    }
    await p.keyboard.press("Escape");
    await p.locator('header [role="combobox"]').nth(1).click().catch(() => null);
    const sourceOptions = await p.getByRole("option").allTextContents();
    record("M-19", "Bitget perpetuals are offered as a data source", sourceOptions.some((o) => /Bitget Perpetual/.test(o)), sourceOptions.join(" | ").slice(0, 120));
    await p.keyboard.press("Escape");
    // v2.3 paper trading: simulated only, permanent banner, no order path.
    const beforePaper = seen.length;
    await p.getByRole("button", { name: /Paper — Paper trading/ }).click();
    await p.waitForSelector("text=simulated, no orders are sent", { timeout: 10000 });
    const paperText = await p.locator('[role="dialog"]').textContent();
    record("P-1", "Paper dialog opens with the permanent 'simulated, no orders are sent' banner", /simulated, no orders are sent/.test(paperText), paperText.slice(0, 80));
    await p.screenshot({ path: path.join(OUT, "13-paper-1366.png") });
    await p.addScriptTag({ content: AXE });
    const axP = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ["violations"] })).violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => v.id + ":" + v.nodes.length + " " + v.nodes.map((n) => n.html.slice(0, 120) + " :: " + (n.any[0]?.message || "").slice(0, 110)).join(" | ")));
    record("P-2", "axe: no critical/serious violations in the paper dialog", axP.length === 0, axP.join(" ") || "none");
    const orderCalls = seen.slice(beforePaper).filter((x) => /order|private|account|\/v5\/position|api\/v3\/order/i.test(x));
    record("P-3", "Opening paper trading makes no order or private-API request", orderCalls.length === 0, orderCalls.join(" ") || "none");
    await p.keyboard.press("Escape");
    await p.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open("rsl-conf-paper");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("paper_journal", "readwrite");
        const now = Date.now();
        tx.objectStore("paper_journal").put({
          id: "trade-fixture", openedAt: now - 3600000, closedAt: now, pair: "BTCUSDT", src: "binance",
          tf: "4h", side: "long", size: 1, entry: 100, exit: 102, stop: 99, target: 102, fees: 0.2,
          funding: 0, pnl: 1.8, r: 1.8, reason: "target", configId: "fixture", proposalId: "fixture",
          approvedAt: now - 3600000, approvedBy: "owner",
        }, "trade-fixture");
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    }));
    await p.reload();
    await waitRows(p);
    await p.getByRole("button", { name: /Paper — Paper trading/ }).click();
    await p.getByRole("button", { name: "Annotate", exact: true }).click();
    const tags = p.getByRole("textbox", { name: /Setup tags/ });
    const notes = p.getByRole("textbox", { name: "Trade notes" });
    await tags.fill("breakout, review, breakout");
    await notes.fill("Fixture note");
    await p.getByRole("button", { name: "Save annotation" }).click();
    await p.getByText("Trade annotation saved.", { exact: true }).waitFor();
    await p.getByRole("button", { name: "Close annotation" }).click();
    await p.getByRole("button", { name: "Annotate", exact: true }).click();
    await p.waitForFunction(() => document.querySelector('form[aria-label="Trade annotation"] textarea')?.value === "Fixture note");
    record("P-4", "Closed paper trade tags and notes persist without changing fills", await tags.inputValue() === "breakout, review");
    await p.keyboard.press("Escape");
    record("M-11", "No page errors with the worker, ledger and class switching", errs.length === 0, errs.slice(0, 2).join(" | ") || "none");
    await c.close();
  }
  {
    const c = await newContext(browser);
    await mockExchanges(c, null, { rateLimitAt: 3 });
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    await p.waitForSelector("text=rate limit", { timeout: 20000 }).catch(() => null);
    const banner = await p.locator('[role="alert"]').allTextContents();
    // Retry-After is not a CORS-safelisted header, so a page cannot read it on a cross-origin
    // response; the app falls back to 60 s (the Node replay does read it).
    record("M-12", "HTTP 429 halts the scan and shows a pause banner", banner.some((b) => /rate limit/i.test(b) && /\d+ s/.test(b)), banner.join(" | ").slice(0, 140));
    await p.screenshot({ path: path.join(OUT, "12-rate-limit-banner.png") });
    await c.close();
  }
  {
    // A symbol whose fetch fails must not be scored from cache or recorded as live.
    const c = await newContext(browser);
    await mockExchanges(c, null, { failSymbol: "SOLUSDT" });
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    await waitRows(p);
    // Second scan: SOL now has cached history from nowhere (it never loaded), and still fails.
    await p.getByRole("button", { name: /^Refresh/ }).click();
    await p.waitForTimeout(1500);
    const solRow = await p.locator("tbody tr", { hasText: "SOL" }).textContent();
    await p.getByRole("button", { name: /Signal ledger \(forward test\)/ }).click();
    await p.waitForSelector("text=Signals recorded");
    const lt = await p.locator('[role="dialog"]').textContent();
    const n = Number((lt.match(/Signals recorded: (\d+)/) || [])[1]);
    record("M-13", "Failed-feed symbol is not presented as a signal and not recorded", !/BUY|SELL/.test(solRow) && n === 3, `SOL row: ${solRow.replace(/\s+/g, " ").slice(0, 70)} · recorded ${n}`);
    await c.close();
  }

  /* ===== D. WebGL off → static fallback; reduced motion → no decode reveal ===== */
  {
    const b2 = await chromium.launch({ args: ["--disable-webgl", "--disable-webgl2", "--disable-3d-apis"] });
    const c = await b2.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: "reduce" });
    await mockExchanges(c);
    await c.addInitScript(() => {
      window.__splash = [];
      new MutationObserver(() => { const el = document.querySelector(".rsl-splash p.font-mono"); if (el) { const t = el.textContent.trim(); if (t && window.__splash[window.__splash.length - 1] !== t) window.__splash.push(t); } })
        .observe(document, { subtree: true, childList: true, characterData: true });
    });
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await p.waitForSelector("#wiz-title", { timeout: 15000 });
    const frames = await p.evaluate(() => window.__splash);
    record("ID-8.8c", "Reduced motion: splash name appears complete, no glyph-noise frames", frames.length >= 1 && frames.every((f) => f === "rsLozano — Personal trading desk"), `${frames.length} distinct frame(s): ${frames.join(" | ")}`);
    await completeFirstRun(p, { operator: "R" });
    await p.getByRole("button", { name: "About" }).click();
    await p.waitForSelector("text=Audit trail");
    const hasCanvas = await p.locator('[data-testid="rsl-monogram-3d"] canvas').count();
    const fallback = await p.locator('[role="dialog"] svg.rsl-mono').count();
    record("ID-8.8d", "WebGL disabled: About shows the static monogram, no 3D canvas", hasCanvas === 0 && fallback > 0, `canvas ${hasCanvas}, static ${fallback}`);
    await p.screenshot({ path: path.join(OUT, "10-about-webgl-off.png") });
    await b2.close();
  }

  {
    const c = await newContext(browser);
    await mockExchanges(c);
    const pairs = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"];
    await c.route(/^https:\/\/api\.bybit\.com\/v5\/market\//, (route) => {
      const url = new URL(route.request().url());
      const symbol = url.searchParams.get("symbol") ?? "BTCUSDT";
      const name = url.pathname.split("/").pop();
      const result = name === "orderbook" ? { b: [["99", "5"]], a: [["101", "6"]] } : {
        list: name === "tickers" ? pairs.map((pair) => ({ symbol: pair, lastPrice: "100", turnover24h: "1000000000" }))
          : name === "instruments-info" ? pairs.map((pair) => ({ symbol: pair, status: "Trading" }))
          : name === "recent-trade" ? [{ symbol, execId: "t1", price: "100", size: "2", time: String(Date.now()), side: "Buy" }]
          : klines(symbol, 1000, stepOf(url)).map((row) => row.map(String)).reverse(),
      };
      return route.fulfill({ json: { retCode: 0, result }, headers: { "access-control-allow-origin": "*" } });
    });
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p);
    await p.locator('header [role="combobox"]').nth(1).click();
    await p.getByRole("option", { name: "Bybit Perpetual", exact: true }).click();
    await p.waitForFunction(() => document.querySelector("header")?.textContent?.includes("Bybit Perpetual"));
    await p.getByRole("button", { name: /^BTC/ }).first().click();
    const flow = p.getByRole("region", { name: "Bybit order flow" });
    await flow.getByRole("button", { name: "Capture order flow" }).click();
    await flow.getByRole("table", { name: "Recent trades" }).getByText("Buy", { exact: true }).waitFor();
    record("OF-1", "Bybit snapshot shows depth and public executions", await flow.getByRole("table", { name: "Depth ladder" }).count() === 1);
    const first = { pair: "BTCUSDT", type: "snapshot", at: 10, u: 20, seq: 100, bids: [["99", "2"]], asks: [["101", "3"]] };
    const frames = [first, { ...first, type: "delta", at: 11, u: 22, seq: 101 }, { ...first, at: 12, u: 24, seq: 102 }];
    frames.push({ type: "liquidation", id: "liq-1", pair: "BTCUSDT", time: 12, side: "long", size: 2, price: 99 });
    await flow.getByLabel("Import sequenced depth JSONL").setInputFiles({
      name: "depth.jsonl", mimeType: "application/x-ndjson", buffer: Buffer.from(frames.map((frame) => JSON.stringify(frame)).join("\n")),
    });
    await flow.getByText("Depth capture loaded.").waitFor();
    await flow.getByRole("button", { name: "Next capture" }).click();
    await flow.getByText(/Capture gap/).waitFor();
    record("OF-2", "Imported depth heatmap marks a sequence gap",
      await flow.locator("[data-depth-gap]").count() === 1 &&
      await flow.getByRole("img", { name: /Resting liquidity/ }).count() === 1);
    record("OF-4", "Liquidation marker renders independently of depth gaps", await flow.locator('[data-liquidation-side="long"]').count() === 1);
    const derivatives = p.getByRole("region", { name: "Bybit derivatives context" });
    const sample = { venue: "bybit", cat: "linear", pair: "BTCUSDT", t: Date.now() - 2000, fr: 0, fi: 480, oi: 150, oit: Date.now() - 3000 };
    await derivatives.getByLabel("Import recorder derivatives JSONL").setInputFiles({
      name: "derivatives.jsonl", mimeType: "application/x-ndjson", buffer: Buffer.from(JSON.stringify(sample)),
    });
    await derivatives.getByText("Recorder snapshots imported.").waitFor();
    record("OF-3", "Bybit derivatives panel displays imported zero funding and open interest",
      (await derivatives.innerText()).includes("0.0000%") && (await derivatives.innerText()).includes("150 base units"));
    await c.close();
  }

  {
    const c = await newContext(browser);
    await mockExchanges(c);
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p);
    await waitRows(p);
    let releaseHistory;
    let historyStarted;
    let finishHistory;
    const historyFinished = new Promise((resolve) => { finishHistory = resolve; });
    const historyPending = new Promise((resolve) => { historyStarted = resolve; });
    const historyRelease = new Promise((resolve) => { releaseHistory = resolve; });
    await c.route(/^https:\/\/data-api\.binance\.vision\/api\/v3\/klines/, async (route) => {
      const url = new URL(route.request().url());
      if (!url.searchParams.has("endTime")) return route.fallback();
      historyStarted();
      await historyRelease;
      await route.fulfill({ json: klines("BTCUSDT", 1000, 144e5) }).catch(() => null);
      finishHistory();
    });
    await p.getByRole("button", { name: /^BTC/ }).first().click();
    await p.getByRole("button", { name: "Load 5K older", exact: true }).click();
    await historyPending;
    await p.keyboard.press("Escape");
    await p.getByRole("button", { name: "Scoring profile · Default", exact: true }).click();
    const editor = p.getByRole("region", { name: "Scoring profile editor" });
    await editor.getByRole("button", { name: "Apply scoring profile" }).click();
    await editor.getByText("Scoring profile applied.", { exact: true }).waitFor();
    record("SP-0", "Reapplying the default profile retains the current scanner rows", await p.locator("tbody tr").count() >= 4);
    await editor.getByRole("checkbox", { name: "SMA 20/50", exact: true }).uncheck();
    await editor.getByRole("button", { name: "Apply scoring profile" }).click();
    await editor.getByText("Scoring profile applied.", { exact: true }).waitFor();
    await waitRows(p);
    await p.getByRole("button", { name: "Scoring profile · Custom", exact: true }).waitFor();
    releaseHistory();
    await historyFinished;
    record("SP-H", "Profile change cancels an older-history request without reopening stale detail", await p.getByRole("dialog").count() === 0);
    const config = await editor.locator("code").textContent();
    record("SP-1", "A custom scoring profile gets a distinct active engine ID",
      /^[a-f0-9]{16}$/.test(config) && config !== "5c30b5c39f5ba3f2");
    const [download] = await Promise.all([p.waitForEvent("download"), editor.getByRole("button", { name: "Export scoring profile" }).click()]);
    const profile = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
    record("SP-2", "Export records the enabled voting IDs", profile.version === 1 && !profile.enabled.includes("sma") && profile.enabled.length === 17);
    await p.reload();
    await waitRows(p);
    await p.getByRole("button", { name: "Scoring profile · Custom", exact: true }).click();
    record("SP-3", "Custom scoring profile survives reload",
      await editor.locator("code").textContent() === config && !(await editor.getByRole("checkbox", { name: "SMA 20/50", exact: true }).isChecked()));
    await p.getByRole("button", { name: "Scoring profile · Custom", exact: true }).click();
    await p.getByRole("button", { name: /Signal ledger \(forward test\)/ }).click();
    await p.waitForFunction((id) => document.querySelector('[role="dialog"]')?.textContent?.includes(id), config);
    record("SP-4", "Ledger measures the active custom profile separately", (await p.getByRole("dialog").innerText()).includes(config));
    await p.keyboard.press("Escape");
    await p.getByRole("button", { name: "Scoring profile · Custom", exact: true }).click();
    await editor.getByRole("button", { name: "Reset scoring draft" }).click();
    await editor.getByRole("button", { name: "Apply scoring profile" }).click();
    await waitRows(p);
    await p.getByRole("button", { name: "Scoring profile · Default", exact: true }).waitFor();
    record("SP-5", "Reset restores the shipped scoring identity", await editor.locator("code").textContent() === "5c30b5c39f5ba3f2");
    await c.close();
  }

  /* ===== v2.6: Coins.ph peso market (WP7) and the source health line (WP10) ===== */
  /* acceptance-ids: PH-9, PH-10, PH-11, PH-12, PH-13, US-1, US-1b */
  {
    // A Philippine time zone makes the Automatic display currency PHP, so peso rows show ₱ whether or not the
    // live reference rates load (in CI they can, and a UTC runner would then convert the rows to US$ — PH-9 flake).
    const c = await newContext(browser, { timezoneId: "Asia/Manila" });
    await mockExchanges(c, null);
    // Global reference prices for the PH premium (registered after mockExchanges, so it takes precedence).
    await c.route(/^https:\/\/data-api\.binance\.vision\/api\/v3\/ticker\/price/, (route) =>
      route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: JSON.stringify([{ symbol: "BTCUSDT", price: "1.6" }, { symbol: "ETHUSDT", price: "1.6" }]) }));
    const direct = [];
    const proxied = [];
    let coinsDown = false;
    // The real host must never be called from the page (Coins.ph sends no CORS header; probe PH-1).
    await c.route(/^https:\/\/api\.pro\.coins\.ph\//, (route) => { direct.push(route.request().url()); return route.abort(); });
    await c.route(/\/x\/coinsph\/openapi\//, (route) => {
      const u = new URL(route.request().url());
      proxied.push(u.pathname);
      if (coinsDown) return route.fulfill({ status: 404, contentType: "text/html", body: "<html>Not found</html>" });
      const json = (b) => route.fulfill({ status: 200, contentType: "text/plain;charset=UTF-8", body: JSON.stringify(b) });
      const pairs = ["BTC", "ETH", "SOL", "DOGE", "XRP", "USDT"];
      if (u.pathname.endsWith("/exchangeInfo")) return json({ timezone: "UTC", serverTime: Date.now(), symbols: pairs.map((b) => ({ symbol: `${b}PHP`, status: "trading", baseAsset: b, quoteAsset: "PHP" })) });
      if (u.pathname.endsWith("/ticker/24hr")) {
        return json(pairs.map((b, i) => ({ symbol: `${b}PHP`, lastPrice: b === "USDT" ? "63" : "101", openPrice: "100", priceChangePercent: "1", quoteVolume: b === "XRP" ? "1000000" : String(9e8 - i) })));
      }
      return json(klines(u.searchParams.get("symbol") || "X", Math.min(1000, Number(u.searchParams.get("limit") || 200)), stepOf(u)));
    });
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    await waitRows(p);
    await p.locator('header [role="combobox"]').nth(1).click();
    await p.getByRole("option", { name: "Coins.ph (PH)" }).click();
    await p.getByTestId("ph-market-note").waitFor({ timeout: 30000 });
    // The previous source's rows stay on screen until the Coins.ph scan is scored; wait for the peso rows.
    await p.waitForFunction(() => /PHP/.test(document.querySelector("tbody tr")?.textContent ?? ""), null, { timeout: 30000 }).catch(() => null);
    const firstRow = await p.locator("tbody tr").first().textContent();
    const rowText = await p.locator("tbody").textContent();
    record("PH-9", "Coins.ph (PH) is a source; its rows show peso prices", /PHP/.test(firstRow ?? "") && /₱\d/.test(firstRow ?? ""), (firstRow ?? "").slice(0, 60));
    const note = await p.getByTestId("ph-market-note").textContent();
    record("PH-10", "Thin peso pairs are counted in the note and not scored", /1 thin pairs/.test(note ?? "") && !/XRP/.test(rowText ?? "") && !/USDT/.test(rowText ?? ""), (note ?? "").slice(0, 120));
    record("PH-11", "The page reaches Coins.ph only through the same-origin /x/coinsph rewrite", direct.length === 0 && proxied.some((x) => x.endsWith("/klines")), `${proxied.length} proxied, ${direct.length} direct`);
    const cachedData = await p.evaluate(async () => {
      if (!("caches" in self)) return [];
      const out = [];
      for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) if (new URL(r.url).pathname.startsWith("/x/")) out.push(r.url);
      return out;
    });
    record("PH-13", "The offline cache never stores Coins.ph market data (/x/ is network-only)", cachedData.length === 0, `${cachedData.length} cached`);
    const health = p.getByTestId("source-health");
    record("US-1", "Source health line shows OK after a good scan", (await health.getAttribute("data-state")) === "ok", await health.textContent());
    await p.getByRole("button", { name: /^BTC/ }).first().click();
    await p.getByText("PH premium", { exact: true }).waitFor({ timeout: 10000 }).catch(() => null);
    record("PH-12", "Detail sheet shows the PH premium (information only)", await p.getByText("PH premium", { exact: true }).count() > 0);
    await p.keyboard.press("Escape");
    // Wait for the sheet's exit animation; until it is gone the page behind it is inert.
    await p.locator('[role="dialog"]').waitFor({ state: "detached", timeout: 10000 }).catch(() => null);
    await p.screenshot({ path: path.join(OUT, "ph-coinsph-scan.png") });
    coinsDown = true;
    await p.getByRole("button", { name: /^Refresh/ }).first().click({ timeout: 10000 });
    // The first scan spent most of the 100-weight minute, so this one is paced by the budget for up to ~60 s first.
    await p.waitForFunction(() => document.querySelector('[data-testid="source-health"]')?.getAttribute("data-state") === "blocked", null, { timeout: 90000 }).catch(() => null);
    record("US-1b", "A missing Coins.ph route reads 'Blocked or unreachable', not 'rate limited'",
      (await health.getAttribute("data-state")) === "blocked" && !/rate/i.test(await health.textContent() ?? ""), await health.textContent());
    await c.close();
  }

  /* ===== v2.7: stablecoin quotes (WP12), display currency (WP13), chart zoom / full screen (WP14) ===== */
  /* acceptance-ids: SQ-8, FX-7, FX-14, FX-15, CH-1, CH-4, CH-5, CH-5b, CH-6 */
  {
    const c = await newContext(browser);
    await mockExchanges(c, null);
    const cors = { "access-control-allow-origin": "*", "content-type": "application/json" };
    const pairs = [["BTCUSDT", 9e9], ["ETHUSDT", 5e9], ["SOLUSDT", 3e9], ["XRPUSDT", 2.5e9], ["DOGEUSDT", 2.2e9], ["BTCUSDC", 2e9], ["ETHUSDC", 6e9], ["USDCUSDT", 1e9]];
    await c.route(/^https:\/\/data-api\.binance\.vision\/api\/v3\/ticker\/24hr/, (route) => route.fulfill({ status: 200, headers: cors,
      body: JSON.stringify(pairs.map(([symbol, qv]) => ({ symbol, openPrice: "100", lastPrice: symbol === "USDCUSDT" ? "0.9995" : "101", quoteVolume: String(qv) }))) }));
    await c.route(/^https:\/\/data-api\.binance\.vision\/api\/v3\/exchangeInfo/, (route) => route.fulfill({ status: 200, headers: cors,
      body: JSON.stringify({ symbols: pairs.map(([symbol]) => ({ symbol, status: "TRADING", baseAsset: symbol.replace(/(USDT|USDC)$/, ""), quoteAsset: symbol.match(/(USDT|USDC)$/)[1] })) }) }));
    const fxHits = [];
    const rates = { SAR: 3.75, PHP: 63, EUR: 0.89234, AED: 3.6725, JPY: 158.24, GBP: 0.7612, INR: 88.71, CNY: 7.11, SGD: 1.3, AUD: 1.52, CAD: 1.39 };
    await c.route(/^https:\/\/api\.frankfurter\.dev\/v2\//, (route) => {
      fxHits.push(route.request().url());
      const u = new URL(route.request().url());
      if (u.pathname.endsWith("/currencies")) return route.fulfill({ status: 200, headers: cors, body: JSON.stringify([...Object.keys(rates), "USD", ...Array.from({ length: 50 }, (_, i) => "Q" + String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + Math.floor(i / 26)))].map((iso_code) => ({ iso_code, name: iso_code, type: "currency" }))) });
      return route.fulfill({ status: 200, headers: cors, body: JSON.stringify([...Object.entries(rates).map(([quote, rate]) => ({ date: "2026-11-11", base: "USD", quote, rate })), { date: "2026-11-10", base: "USD", quote: "USDT", rate: 1.0013 }]) });
    });
    // ECB SDMX (EUR base) for FX-15.
    const ecbCur = ["USD", "SAR", "GBP", "JPY", "INR", "CNY", "SGD", "AUD", "CAD", "CHF", "PHP"];
    await c.route(/^https:\/\/data-api\.ecb\.europa\.eu\//, (route) => route.fulfill({ status: 200, headers: cors, body: JSON.stringify({
      structure: { dimensions: { series: [{ id: "FREQ", values: [{ id: "D" }] }, { id: "CURRENCY", values: ecbCur.map((id) => ({ id })) }, { id: "CURRENCY_DENOM", values: [{ id: "EUR" }] }, { id: "EXR_TYPE", values: [{ id: "SP00" }] }, { id: "EXR_SUFFIX", values: [{ id: "A" }] }],
        observation: [{ id: "TIME_PERIOD", values: [{ id: "2026-11-10" }] }] } },
      dataSets: [{ series: Object.fromEntries(ecbCur.map((cc, i) => [`0:${i}:0:0:0`, { observations: { 0: [cc === "USD" ? 1.12 : cc === "SAR" ? 4.2 : 2] } }])) }] }) }));
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    await waitRows(p);

    // SQ-8 — the Quote menu lists the venue's live quotes; a USDC scan shows USDC pairs.
    await p.getByRole("combobox", { name: "Quote" }).click();
    const quoteOptions = await p.getByRole("option").allTextContents();
    await p.getByRole("option", { name: "USDC", exact: true }).click();
    await p.waitForFunction(() => /USDC/.test(document.querySelector("tbody tr")?.textContent ?? ""), null, { timeout: 30000 }).catch(() => null);
    const usdcRows = await p.locator("tbody").textContent();
    record("SQ-8", "Quote menu offers USDT, USDC and Best; a USDC scan lists only USDC pairs",
      quoteOptions.includes("USDT") && quoteOptions.includes("USDC") && quoteOptions.some((o) => /Best/.test(o)) && /ETHUSDC/.test(usdcRows ?? "") && !/ETHUSDT/.test(usdcRows ?? ""),
      quoteOptions.join(","));

    // FX-7 — display currency SAR converts table, info line and detail sheet.
    await p.getByRole("combobox", { name: "Display currency" }).click();
    await p.getByRole("option", { name: /^SAR/ }).first().click();
    await p.waitForFunction(() => /Frankfurter/.test(document.querySelector('[data-testid="fx-info"]')?.textContent ?? ""), null, { timeout: 20000 }).catch(() => null);
    const info = (await p.getByTestId("fx-info").textContent().catch(() => "")) ?? "";
    const firstPrice = (await p.locator("tbody tr").first().locator("td").nth(2).textContent().catch(() => "")) ?? "";
    record("FX-7", "Display currency SAR: prices in SAR, info line names the peg, source and date",
      /SAR/.test(firstPrice) && /1 USD = 3\.75 SAR/.test(info) && /SAMA/.test(info) && /Frankfurter/.test(info) && fxHits.length > 0, `${firstPrice.trim()} · ${info.slice(0, 140)}`);

    // FX-14 — Rate sources: 5 tested sources with website + data links, Update now, custom notice + written request.
    await p.getByTestId("fx-sources-open").first().click();
    const dlg = p.getByTestId("fx-sources");
    await dlg.waitFor({ timeout: 10000 });
    const srcCount = await dlg.locator('[data-testid^="fx-source-"]').count();
    const links = await dlg.locator('a[href^="https://"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    await dlg.getByRole("radio").last().check();
    const notice = (await dlg.getByTestId("fx-custom-notice").textContent()) ?? "";
    const request = (await dlg.getByTestId("fx-custom-request").getAttribute("href")) ?? "";
    const lastUpd = (await dlg.getByTestId("fx-last").textContent().catch(() => "")) ?? "";
    record("FX-14", "Rate sources lists 5 tested sources with their website and data address, last update, and a custom source marked not tested with a written request to the developer",
      srcCount === 5 && links.some((h) => h.includes("frankfurter.dev")) && links.some((h) => h.includes("data-api.ecb.europa.eu")) && links.some((h) => h.includes("open.er-api.com")) &&
      /Not tested/.test(notice) && /written request/.test(notice) && request.startsWith("mailto:") && /add%20an%20exchange-rate%20source/.test(request) && /Last updated/.test(lastUpd),
      `${srcCount} sources · ${links.length} links · ${lastUpd}`);
    // FX-15 — choose the ECB: the rate line names it and Update now reads only the ECB.
    await dlg.getByText("European Central Bank", { exact: true }).click();
    const fxBefore = fxHits.length;
    await dlg.getByTestId("fx-update").click();
    // v2.8 WP20: the info line now says "derived from ECB euro reference rates · Source: ECB statistics (rebased to USD by this app)".
    await p.waitForFunction(() => /ECB/.test(document.querySelector('[data-testid="fx-info"]')?.textContent ?? ""), null, { timeout: 15000 }).catch(() => null);
    const info2 = (await p.getByTestId("fx-info").textContent().catch(() => "")) ?? "";
    record("FX-15", "Choosing the ECB converts SAR at the ECB's own cross rate and names it", /ECB euro reference rates/.test(info2) && /Source: ECB statistics \(rebased to USD by this app\)/.test(info2) && /1 USD = 3\.75 SAR/.test(info2) && fxHits.length === fxBefore, info2.slice(0, 200));
    await p.keyboard.press("Escape");
    await p.locator('[data-testid="fx-sources"]').waitFor({ state: "detached", timeout: 10000 }).catch(() => null);

    // Detail sheet chart.
    await p.getByRole("button", { name: /^ETH/ }).first().click();
    const chart = p.getByTestId("price-chart");
    await chart.waitFor({ timeout: 15000 });
    const detailText = await p.locator('[role="dialog"]').first().textContent();
    const bars = async () => Number(((await p.getByTestId("chart-bars").textContent()) ?? "0").split("/")[0]);
    const svg = chart.locator("svg").first();
    const box = await svg.boundingBox();
    // CH-1 — inspect a late candle at a long depth, then shrink the depth: no crash, readout still there.
    await svg.focus();
    await p.keyboard.press("End");
    await p.getByRole("combobox", { name: "Chart history depth" }).click();
    await p.getByRole("option", { name: "60 bars" }).click();
    await p.waitForTimeout(300);
    record("CH-1", "Shrinking the depth under an inspected candle keeps the chart and readout", await p.getByTestId("chart-readout").count() === 1 && await bars() === 60 && /SAR/.test(detailText ?? ""), String(await bars()));
    // CH-4 — Ctrl+wheel zooms at the cursor, drag pans, Reset restores.
    const before = await bars();
    await p.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.3);
    await p.keyboard.down("Control"); await p.mouse.wheel(0, -400); await p.keyboard.up("Control");
    await p.waitForTimeout(200);
    const zoomed = await bars();
    await p.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3);
    await p.mouse.down(); await p.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.3, { steps: 6 }); await p.mouse.up();
    await chart.getByRole("button", { name: "Reset view" }).click();
    const reset = await bars();
    record("CH-4", "Ctrl+wheel zooms in, Reset restores the depth", zoomed < before && reset === before, `${before} → ${zoomed} → ${reset}`);
    // CH-5 — Full screen fills the viewport; Esc leaves full screen and the sheet stays open.
    await chart.getByTestId("chart-fullscreen").click();
    await p.waitForTimeout(400);
    const fsMode = await chart.getAttribute("data-fullscreen");
    const fsBox = await chart.boundingBox();
    const vp = p.viewportSize();
    await p.keyboard.press("Escape");
    await p.waitForTimeout(400);
    record("CH-5", "Full screen fills the viewport; Esc returns to the sheet without closing it",
      fsMode !== "off" && fsBox && fsBox.width >= vp.width - 2 && fsBox.height >= vp.height - 2 && (await chart.getAttribute("data-fullscreen")) === "off" && await p.locator('[role="dialog"]').count() > 0,
      `${fsMode} ${Math.round(fsBox?.width ?? 0)}×${Math.round(fsBox?.height ?? 0)} of ${vp.width}×${vp.height}`);
    await p.screenshot({ path: path.join(OUT, "v27-sar-detail.png") });
    await c.close();
  }
  /* CH-5b — no Fullscreen API (iPhone Safari, Capacitor, Tauri): the Focus view must fill the viewport from inside the sheet. */
  {
    const c = await newContext(browser);
    await c.addInitScript(() => { Object.defineProperty(Document.prototype, "fullscreenEnabled", { get: () => false }); });
    await mockExchanges(c, null);
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    await waitRows(p);
    await p.getByRole("button", { name: /^BTC/ }).first().click();
    const chart = p.getByTestId("price-chart");
    await chart.waitFor({ timeout: 15000 });
    await p.locator('[role="dialog"]').first().evaluate((el) => { el.scrollTop = 400; });
    await chart.getByTestId("chart-fullscreen").click();
    await p.waitForTimeout(400);
    const mode = await chart.getAttribute("data-fullscreen");
    const r = await chart.boundingBox();
    const vp = p.viewportSize();
    await p.keyboard.press("Escape");
    await p.waitForTimeout(300);
    record("CH-5b", "Focus view (no Fullscreen API) covers the whole viewport even from a scrolled sheet; Esc keeps the sheet",
      mode === "focus" && r && Math.abs(r.x) < 2 && Math.abs(r.y) < 2 && r.width >= vp.width - 2 && r.height >= vp.height - 2 &&
      (await chart.getAttribute("data-fullscreen")) === "off" && await p.locator('[role="dialog"]').count() > 0,
      `${mode} at ${Math.round(r?.x ?? 0)},${Math.round(r?.y ?? 0)} ${Math.round(r?.width ?? 0)}×${Math.round(r?.height ?? 0)}`);
    await c.close();
  }
  /* CH-6 — phone: two-finger pinch on the chart changes the visible bar count. */
  {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, serviceWorkers: "block" });
    await mockExchanges(c, null);
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    await waitRows(p);
    await p.getByRole("button", { name: /^BTC/ }).first().click();
    const chart = p.getByTestId("price-chart");
    await chart.waitFor({ timeout: 15000 });
    await chart.scrollIntoViewIfNeeded();
    const svg = chart.locator("svg").first();
    const b = await svg.boundingBox();
    const count = async () => Number(((await p.getByTestId("chart-bars").textContent()) ?? "0").split("/")[0]);
    const before = await count();
    const cdp = await c.newCDPSession(p);
    const cy = b.y + b.height * 0.3, cx = b.x + b.width * 0.5;
    const tp = (d) => [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: tp(20) });
    for (let d = 30; d <= 140; d += 10) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: tp(d) });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await p.waitForTimeout(300);
    const after = await count();
    record("CH-6", "Phone: pinching out on the chart zooms in (fewer bars), the page does not zoom",
      after < before && await p.evaluate(() => (window.visualViewport?.scale ?? 1) === 1), `${before} → ${after}`);
    await p.screenshot({ path: path.join(OUT, "v27-phone-chart.png") });
    await c.close();
  }

  /* ===== v2.8 WP20: rate-source credit wherever its rates are on screen ===== */
  /* acceptance-ids: FX-16 */
  {
    const c = await newContext(browser);
    await mockExchanges(c, null);
    const cors = { "access-control-allow-origin": "*", "content-type": "application/json" };
    const rates = { SAR: 3.75, PHP: 63, EUR: 0.89234, AED: 3.6725, JPY: 158.24, GBP: 0.7612, INR: 88.71, CNY: 7.11, SGD: 1.3, AUD: 1.52, CAD: 1.39 };
    await c.route(/^https:\/\/api\.frankfurter\.dev\/v2\//, (route) => {
      const u = new URL(route.request().url());
      if (u.pathname.endsWith("/currencies")) return route.fulfill({ status: 200, headers: cors, body: JSON.stringify([...Object.keys(rates), "USD"].map((iso_code) => ({ iso_code, name: iso_code, type: "currency" }))) });
      return route.fulfill({ status: 200, headers: cors, body: JSON.stringify(Object.entries(rates).map(([quote, rate]) => ({ date: "2026-11-11", base: "USD", quote, rate }))) });
    });
    await c.route(/^https:\/\/open\.er-api\.com\//, (route) => route.fulfill({ status: 200, headers: cors,
      body: JSON.stringify({ result: "success", base_code: "USD", time_last_update_unix: 1794355352, rates: { USD: 1, ...rates } }) }));
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    await waitRows(p);
    await p.getByRole("combobox", { name: "Display currency" }).click();
    await p.getByRole("option", { name: /^SAR/ }).first().click();
    await p.waitForFunction(() => /Frankfurter/.test(document.querySelector('[data-testid="fx-info"]')?.textContent ?? ""), null, { timeout: 20000 }).catch(() => null);
    // Default source (Frankfurter) needs no credit: nothing extra in the expanded toolbar.
    await p.getByTestId("list-expand").click();
    const defaultExpanded = await p.getByTestId("fx-credit-expanded").count();
    await p.getByTestId("list-expand").click();
    // Choose ExchangeRate-API.
    await p.getByTestId("fx-sources-open").first().click();
    const dlg = p.getByTestId("fx-sources");
    await dlg.waitFor({ timeout: 10000 });
    await dlg.getByText("ExchangeRate-API (open access)", { exact: true }).click();
    await dlg.getByTestId("fx-update").click();
    await p.waitForFunction(() => /Rates By Exchange Rate API/.test(document.querySelector('[data-testid="fx-info"]')?.textContent ?? ""), null, { timeout: 15000 }).catch(() => null);
    await p.keyboard.press("Escape");
    await dlg.waitFor({ state: "detached", timeout: 10000 }).catch(() => null);
    const credit = (loc) => loc.evaluate((a) => ({ text: a.textContent, href: a.getAttribute("href"), visible: !!(a.offsetWidth || a.offsetHeight) })).catch(() => null);
    const normal = await credit(p.locator('[data-testid="fx-info"] a[href="https://www.exchangerate-api.com"]'));
    await p.getByTestId("list-expand").click();
    const expanded = await credit(p.getByTestId("fx-credit-expanded"));
    await p.getByTestId("list-expand").click();
    await p.getByRole("button", { name: /^BTC/ }).first().click();
    const detailLink = p.locator('[data-testid="fx-credit-detail"] a');
    await detailLink.waitFor({ timeout: 15000 }).catch(() => null);
    await detailLink.scrollIntoViewIfNeeded().catch(() => null);
    const detail = await credit(detailLink);
    // Review round 1: the credit stays while chart replay is open in the sheet.
    await p.getByRole("button", { name: "Open chart replay" }).click().catch(() => null);
    await p.getByRole("button", { name: "Close chart replay" }).waitFor({ timeout: 10000 }).catch(() => null);
    await detailLink.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => null);
    const replay = await credit(p.locator('[data-testid="fx-credit-detail"] a'));
    const okCredit = (x) => x && x.visible && x.text === "Rates By Exchange Rate API" && x.href === "https://www.exchangerate-api.com";
    record("FX-16", "ExchangeRate-API + SAR: \"Rates By Exchange Rate API\" link in normal mode, expanded list, the detail sheet and with chart replay open; none for the default source",
      defaultExpanded === 0 && okCredit(normal) && okCredit(expanded) && okCredit(detail) && okCredit(replay), { defaultExpanded, normal, expanded, detail, replay });
    await p.keyboard.press("Escape");
    await c.close();
  }

  /* ===== v2.8 WP21 (Fund trend): opt-in chart toggles and the ribbon ===== */
  /* acceptance-ids: FT-1, FT-2 */
  {
    const c = await newContext(browser);
    await mockExchanges(c);
    // Registered after mockExchanges, so it wins: a steady +1 %/day BTC daily series (Fund trend = +100, every z clipped at +2).
    await c.route(/^https:\/\/data-api\.binance\.vision\/api\/v3\/klines/, async (route) => {
      const u = new URL(route.request().url());
      if (u.searchParams.get("interval") !== "1d" || u.searchParams.get("symbol") !== "BTCUSDT") return route.fallback();
      const day = 864e5, n = 1000, start = Math.floor(Date.now() / day) * day - n * day;
      const rows = [];
      for (let i = 0; i <= n; i++) { const o = 100 * Math.exp(0.01 * i), cl = 100 * Math.exp(0.01 * (i + 1)); rows.push([start + i * day, String(o), String(cl * 1.001), String(o * 0.999), String(cl), "1000", start + (i + 1) * day - 1]); }
      return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: JSON.stringify(rows) });
    });
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p);
    await waitRows(p);
    await p.getByRole("button", { name: /^BTC/ }).first().click();
    const chart = p.locator('[data-testid="price-chart"]');
    await chart.waitFor();
    await p.getByRole("button", { name: "Indicators", exact: true }).click();
    const ribbonBox = p.getByRole("checkbox", { name: "Fund trend ribbon", exact: true });
    const panelBox = p.getByRole("checkbox", { name: "Fund trend panel", exact: true });
    const both = await ribbonBox.count() === 1 && await panelBox.count() === 1;
    const offAtRest = both && !(await ribbonBox.isChecked()) && !(await panelBox.isChecked());
    const drawnAtRest = await chart.locator('[data-fund]').count();
    const stored = await p.evaluate(() => localStorage.getItem("ct-chart-optin-v1"));
    record("FT-1", "Fund trend ribbon and panel toggles sit in the Indicators menu, are off by default (nothing stored), and no ribbon is drawn at rest",
      both && offAtRest && drawnAtRest === 0 && stored === null, { both, offAtRest, drawnAtRest, stored });

    await ribbonBox.check();
    await chart.locator('[data-fund="ribbon"] rect').first().waitFor({ timeout: 15000 }).catch(() => null);
    const segs = await chart.locator('[data-fund="ribbon"] rect').evaluateAll((els) => els.map((e) => ({ ft: Number(e.getAttribute("data-ft")), colour: e.getAttribute("data-ft-colour"), fill: e.getAttribute("fill"), opacity: Number(e.getAttribute("opacity")), h: Number(e.getAttribute("height")) })));
    const last = segs[segs.length - 1];
    const wantAlpha = last ? 0.25 + 0.75 * Math.min(1, Math.abs(last.ft) / 100) : NaN;
    const upOk = !!last && last.colour === "up" && last.fill === "#34d399" && last.ft > 99 && Math.abs(last.opacity - wantAlpha) < 0.005 && last.h === 6;
    const storedOn = await p.evaluate(() => localStorage.getItem("ct-chart-optin-v1"));
    await p.keyboard.press("Escape");
    // A tokenised stock row has no Fund trend: the muted n/a line shows instead of a ribbon.
    await p.getByRole("combobox", { name: "Asset class" }).click();
    await p.getByRole("option", { name: "Stocks (tokenised)" }).click();
    await p.waitForFunction(() => /TSLAB/.test(document.querySelector("tbody")?.textContent || ""), null, { timeout: 15000 });
    await p.getByRole("button", { name: /^TSLAB/ }).first().click();
    const note = p.locator('[data-testid="fund-trend-note"]');
    await note.waitFor({ timeout: 10000 }).catch(() => null);
    const noteText = await note.textContent().catch(() => null);
    const stockRibbons = await p.locator('[data-fund="ribbon"]').count();
    record("FT-2", "Ribbon on with mocked daily bars (+1 %/day): 6 px segments, last one is the up colour at the expected alpha; a tokenised stock shows \"Fund trend: n/a for this asset class\" and no ribbon",
      upOk && storedOn === '["fund-ribbon"]' && noteText === "Fund trend: n/a for this asset class" && stockRibbons === 0, { segs: segs.length, last, storedOn, noteText, stockRibbons });
    await p.keyboard.press("Escape");
    await c.close();
  }

  /* ===== v2.8 WP21 (Fund trend): the opt-in panel — per-bar Confluence score, Fund trend, Fund size, Fund rank ===== */
  /* acceptance-ids: FT-3 */
  {
    const c = await newContext(browser);
    await mockExchanges(c);
    // ETH: the daily request fails, so the detail sheet must say the Fund trend is unavailable (no silent blank).
    await c.route(/^https:\/\/data-api\.binance\.vision\/api\/v3\/klines/, async (route) => {
      const u = new URL(route.request().url());
      if (u.searchParams.get("interval") !== "1d" || u.searchParams.get("symbol") !== "ETHUSDT") return route.fallback();
      return route.fulfill({ status: 500, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: JSON.stringify({ code: -1, msg: "upstream error" }) });
    });
    let gateOn = false, releaseOlder; const olderGate = new Promise((ok) => { releaseOlder = ok; }); // the older-bars page is held until the test lets it go
    // BTC: a steady +1 %/day daily series (Fund trend +100, size 200 %) ...
    await c.route(/^https:\/\/data-api\.binance\.vision\/api\/v3\/klines/, async (route) => {
      const u = new URL(route.request().url());
      if (u.searchParams.get("symbol") !== "BTCUSDT") return route.fallback();
      const headers = { "access-control-allow-origin": "*", "content-type": "application/json" };
      if (u.searchParams.get("interval") === "1d") {
        const day = 864e5, n = 1000, start = Math.floor(Date.now() / day) * day - n * day;
        const rows = [];
        for (let i = 0; i <= n; i++) { const o = 100 * Math.exp(0.01 * i), cl = 100 * Math.exp(0.01 * (i + 1)); rows.push([start + i * day, String(o), String(cl * 1.001), String(o * 0.999), String(cl), "1000", start + (i + 1) * day - 1]); }
        return route.fulfill({ status: 200, headers, body: JSON.stringify(rows) });
      }
      // ... and 1,600 bars of the chart timeframe that honour endTime, so the one-time older-bars fetch can fill the window.
      const step = stepOf(u), total = 1600, last = Math.floor(Date.now() / step) * step;
      let px = 100, seed = 11;
      const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
      const all = [];
      for (let i = 0; i <= total; i++) { const o = px; px *= Math.exp(0.001 + rnd() * 0.01); const t = last - (total - i) * step; all.push([t, String(o), String(Math.max(o, px) * 1.002), String(Math.min(o, px) * 0.998), String(px), String(1000 + (i % 13)), t + step - 1]); }
      const end = Number(u.searchParams.get("endTime")) || Infinity, limit = Math.min(1000, Number(u.searchParams.get("limit") || 500));
      // The older-bars page answers slowly (real network): the first scoring pass runs without it, the merge must re-score.
      if (gateOn && u.searchParams.has("endTime")) await Promise.race([olderGate, new Promise((ok) => setTimeout(ok, 40000))]);
      return route.fulfill({ status: 200, headers, body: JSON.stringify(all.filter((r) => r[0] <= end).slice(-limit)) });
    });
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p);
    await waitRows(p);
    await p.getByRole("button", { name: /^BTC/ }).first().click();
    const chart = p.locator('[data-testid="price-chart"]');
    await chart.waitFor();
    const heightAtRest = await chart.locator("svg").first().evaluate((e) => e.getBoundingClientRect().height);
    const offAtRest = await chart.locator('[data-fund="panel"]').count() === 0;
    await p.getByRole("button", { name: "Indicators", exact: true }).click();
    gateOn = true;
    await p.getByRole("checkbox", { name: "Fund trend panel", exact: true }).check();
    const score = chart.locator('[data-fund-line="score"]');
    // Slow older bars: the first pass has no full window (999 bars held), so the note says so and no score line exists yet.
    await chart.locator('[data-testid="fund-panel-note"]').waitFor({ timeout: 30000 }).catch(() => null);
    const noteEarly = await chart.locator('[data-testid="fund-panel-note"]').count();
    const nEarly = await score.count();
    releaseOlder();
    await score.waitFor({ timeout: 30000 }).catch(() => null);
    await chart.locator('[data-testid="fund-panel-note"]').waitFor({ state: "detached", timeout: 30000 }).catch(() => null);
    const nLate = Number(await score.getAttribute("data-n").catch(() => 0));
    const lines = { score: await score.count(), trend: await chart.locator('[data-fund-line="trend"]').count(), area: await chart.locator('[data-fund-area="size"]').count() };
    const rankEl = chart.locator('[data-testid="fund-rank"]');
    await rankEl.waitFor({ timeout: 20000 }).catch(() => null);
    const rankText = await rankEl.textContent().catch(() => null);
    const lastScore = await score.getAttribute("data-last").catch(() => null);
    const listScore = await p.evaluate(() => {
      const el = [...document.querySelectorAll('[role="dialog"] div')].find((n) => n.children.length === 0 && n.textContent === "Confluence");
      return el?.nextElementSibling?.textContent ?? null;
    });
    const noteFull = await chart.locator('[data-testid="fund-panel-note"]').count();
    const heightOn = await chart.locator("svg").first().evaluate((e) => e.getBoundingClientRect().height);
    const sameAsList = lastScore !== null && !!listScore && Number(String(listScore).replace(/[^0-9+\-.]/g, "")) === Number(lastScore);
    await p.keyboard.press("Escape");
    // ETH: the mocked series has no older history (the mock ignores endTime) and its daily request fails.
    await p.getByRole("button", { name: /^ETH/ }).first().click();
    const note = p.locator('[data-testid="fund-trend-note"]');
    await note.waitFor({ timeout: 30000 }).catch(() => null);
    const unavailable = await note.textContent().catch(() => null);
    const shortNote = p.locator('[data-testid="fund-panel-note"]');
    await shortNote.waitFor({ timeout: 30000 }).catch(() => null);
    const shortText = await shortNote.textContent().catch(() => null);
    // A tokenised stock: the panel still draws the list's Confluence score; Fund trend and size are n/a.
    await p.keyboard.press("Escape");
    await p.getByRole("combobox", { name: "Asset class" }).click();
    await p.getByRole("option", { name: "Stocks (tokenised)" }).click();
    await p.waitForFunction(() => /TSLAB/.test(document.querySelector("tbody")?.textContent || ""), null, { timeout: 15000 });
    await p.getByRole("button", { name: /^TSLAB/ }).first().click();
    const stockScore = p.locator('[data-fund-line="score"]');
    await stockScore.waitFor({ timeout: 30000 }).catch(() => null);
    const stock = {
      score: await stockScore.count(), trend: await p.locator('[data-fund-line="trend"]').count(), area: await p.locator('[data-fund-area="size"]').count(),
      note: await p.locator('[data-testid="fund-trend-note"]').textContent().catch(() => null),
    };
    // Reset to defaults also clears the opt-ins.
    await p.getByRole("button", { name: "Indicators", exact: true }).click();
    await p.getByRole("button", { name: "Reset to defaults", exact: true }).click();
    const afterReset = {
      panelBox: await p.getByRole("checkbox", { name: "Fund trend panel", exact: true }).isChecked(),
      ribbonBox: await p.getByRole("checkbox", { name: "Fund trend ribbon", exact: true }).isChecked(),
      stored: await p.evaluate(() => localStorage.getItem("ct-chart-optin-v1")),
      drawn: await p.locator('[data-fund]').count(),
    };
    record("FT-3", "Panel off by default; on: Confluence and Fund trend lines plus the Fund size area, \"Fund rank 1 of N\", the last score equals the list's; short history shows \"Score shown for N of M bars\"; a failed daily load says so; Reset to defaults clears the opt-ins",
      offAtRest && lines.score === 1 && lines.trend === 1 && lines.area === 1 && /^Fund rank 1 of \d+$/.test(rankText || "") && sameAsList && noteFull === 0 && noteEarly === 1 && nEarly === 0 && nLate > 100 && heightOn > heightAtRest
        && unavailable === "Fund trend: data unavailable, try again later" && /^Score shown for \d+ of \d+ bars \(needs 1,000 earlier bars\)$/.test(shortText || "")
        && stock.score === 1 && stock.trend === 0 && stock.area === 0 && stock.note === "Fund trend: n/a for this asset class"
        && !afterReset.panelBox && !afterReset.ribbonBox && afterReset.stored === "[]" && afterReset.drawn === 0,
      { offAtRest, noteEarly, nEarly, nLate, stock, lines, rankText, lastScore, listScore, noteFull, heightAtRest, heightOn, unavailable, shortText, afterReset });
    await p.keyboard.press("Escape");
    await c.close();
  }

  /* ===== v2.8 WP21 (Fund trend): disagreement marks on the list and chart, the pulse modes, the Fund rank column ===== */
  /* acceptance-ids: FT-4, FT-5 */
  {
    const DAY = 864e5;
    // Daily feed: BTC falls 1 %/day (Fund trend -100) while its mocked chart bars rise (strong bullish score) and ETH does the
    // opposite, so both rows disagree (BTC +1, ETH -1). Other coins keep the default mocked daily bars.
    const dailyFeed = async (route) => {
      const u = new URL(route.request().url());
      const sym = u.searchParams.get("symbol");
      const up = sym === "ETHUSDT";
      if (u.searchParams.get("interval") !== "1d" || (sym !== "BTCUSDT" && !up)) return route.fallback();
      const n = 1000, start = Math.floor(Date.now() / DAY) * DAY - n * DAY, k = up ? 0.01 : -0.01, rows = [];
      for (let i = 0; i <= n; i++) { const o = 100 * Math.exp(k * i), cl = 100 * Math.exp(k * (i + 1)); rows.push([start + i * DAY, String(o), String(Math.max(o, cl) * 1.001), String(Math.min(o, cl) * 0.999), String(cl), "1000", start + (i + 1) * DAY - 1]); }
      return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: JSON.stringify(rows) });
    };
    // Chart bars for BTC: 1,600 mocked bars that honour endTime, so a full 1,000-bar window exists for the newest 300.
    const longBtc = async (route) => {
      const u = new URL(route.request().url());
      if (u.searchParams.get("symbol") !== "BTCUSDT" || u.searchParams.get("interval") === "1d" || !u.searchParams.has("endTime")) return route.fallback();
      const all = klines("BTCUSDT", 1600, stepOf(u));
      const end = Number(u.searchParams.get("endTime")) || Infinity, limit = Math.min(1000, Number(u.searchParams.get("limit") || 500));
      return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: JSON.stringify(all.filter((r) => r[0] <= end).slice(-limit)) });
    };
    const optIn = (ctx, ids) => ctx.addInitScript((v) => { try { if (!localStorage.getItem("ft-seeded")) { localStorage.setItem("ct-chart-optin-v1", v); localStorage.setItem("ft-seeded", "1"); } } catch {} }, JSON.stringify(ids));
    const openPage = async (c) => {
      await mockExchanges(c);
      await c.route(/^https:\/\/data-api\.binance\.vision\/api\/v3\/klines/, dailyFeed);
      await c.route(/^https:\/\/data-api\.binance\.vision\/api\/v3\/klines/, longBtc);
      const p = await c.newPage();
      await p.goto(BASE, { waitUntil: "domcontentloaded" });
      await completeFirstRun(p);
      await waitRows(p);
      return p;
    };
    const mark = (p, sym) => p.locator("tbody tr", { hasText: new RegExp(`${sym}USDT`) }).locator('[data-testid="fund-disagree"]');
    const anim = (loc) => loc.evaluate((e) => { const s = getComputedStyle(e); return { name: s.animationName, iter: s.animationIterationCount }; });
    const rowOutline = (p, sym) => p.locator("tbody tr", { hasText: new RegExp(`${sym}USDT`) }).first().evaluate((e) => { const s = getComputedStyle(e); return { style: s.outlineStyle, width: s.outlineWidth, cls: e.className.includes("ft-row-disagree") }; });
    const setRibbon = async (p, on, coin = "BTC") => {
      await p.getByRole("button", { name: new RegExp(`^${coin}`) }).first().click();
      await p.locator('[data-testid="price-chart"]').waitFor();
      await p.getByRole("button", { name: "Indicators", exact: true }).click();
      const box = p.getByRole("checkbox", { name: "Fund trend ribbon", exact: true });
      if (on) await box.check(); else await box.uncheck();
    };

    // --- ribbon off: no marker; on: marker + outline + 3 pulses, then static, never replayed ---
    const c = await newContext(browser);
    const p = await openPage(c);
    await p.waitForTimeout(2500); // the daily feed runs behind the scan
    const offCount = await p.locator('[data-testid="fund-disagree"]').count();
    const offOutline = await p.locator("tbody tr.ft-row-disagree").count();
    await setRibbon(p, true);
    await mark(p, "BTC").waitFor({ timeout: 30000 }).catch(() => null);
    const btc = mark(p, "BTC");
    const first = { count: await btc.count(), anim: await anim(btc).catch(() => null), label: await btc.getAttribute("aria-label").catch(() => null), out: await rowOutline(p, "BTC") };
    const ethFirst = { count: await mark(p, "ETH").count(), dir: await mark(p, "ETH").getAttribute("data-dir").catch(() => null) };
    // Chart hatching on the bars where the (scored) bar and the Fund trend disagree.
    const hatch = p.locator('[data-fund="disagree"] [data-disagree]');
    await hatch.first().waitFor({ timeout: 40000 }).catch(() => null);
    const hatchN = await hatch.count();
    const hatchInfo = hatchN ? await p.locator('[data-fund="disagree"]').first().evaluate((g) => ({ fill: g.querySelector("rect")?.getAttribute("fill"), pattern: !!g.querySelector("pattern[id^='ft-hatch-']") && g.querySelector("rect")?.getAttribute("fill") === `url(#${g.querySelector("pattern")?.id})`, diamond: !!g.querySelector("path"), title: g.querySelector("title")?.textContent })) : null;
    await p.waitForTimeout(3600);
    const done = await anim(btc).catch(() => null);
    // Ribbon off and on again does not replay the pulse.
    const box = p.getByRole("checkbox", { name: "Fund trend ribbon", exact: true });
    await box.uncheck(); await box.check();
    await btc.waitFor({ timeout: 10000 }).catch(() => null);
    const replay = await anim(btc).catch(() => null);
    await p.keyboard.press("Escape");
    await p.keyboard.press("Escape");
    await c.close();

    // --- reduced motion: the marker and outline stay, nothing animates ---
    const cr = await newContext(browser, { reducedMotion: "reduce" });
    await optIn(cr, ["fund-ribbon"]);
    const pr = await openPage(cr);
    await mark(pr, "BTC").waitFor({ timeout: 30000 }).catch(() => null);
    await pr.waitForTimeout(500);
    const reduced = { count: await mark(pr, "BTC").count(), anim: await anim(mark(pr, "BTC")).catch(() => null), out: await rowOutline(pr, "BTC") };
    // I-3: in Keep pulsing mode under reduced motion nothing pulses, so there is no Stop pulsing button.
    await pr.getByRole("button", { name: /^Scoring profile/ }).click();
    await pr.locator('[data-testid="fund-pulse"]').selectOption("keep");
    await pr.getByRole("button", { name: /^Scoring profile/ }).click();
    await pr.waitForTimeout(600);
    reduced.stopKeepReduced = await pr.locator('[data-testid="stop-pulse"]').count();
    await cr.close();

    // --- keep pulsing: infinite until the coin is opened or Stop pulsing is pressed ---
    const ck = await newContext(browser);
    const pk = await openPage(ck);
    await pk.waitForTimeout(2500); // the daily feed runs behind the scan
    await pk.getByRole("button", { name: /^Scoring profile/ }).click();
    await pk.locator('[data-testid="fund-pulse"]').selectOption("keep");
    await pk.getByRole("button", { name: /^Scoring profile/ }).click();
    // The ribbon is switched on from SOL's sheet (not a disagreeing row), so BTC's and ETH's markers start as keep pulses.
    await setRibbon(pk, true, "SOL");
    await pk.keyboard.press("Escape");
    await pk.keyboard.press("Escape");
    await mark(pk, "BTC").waitFor({ timeout: 30000 }).catch(() => null);
    await mark(pk, "ETH").waitFor({ timeout: 30000 }).catch(() => null);
    await pk.waitForTimeout(3600);
    const stopBtn = pk.locator('[data-testid="stop-pulse"]');
    const keepBefore = { btc: await anim(mark(pk, "BTC")).catch(() => null), eth: await anim(mark(pk, "ETH")).catch(() => null), stop: await stopBtn.count(), stopText: await stopBtn.textContent().catch(() => null) };
    await pk.getByRole("button", { name: /^BTC/ }).first().click();
    await pk.locator('[data-testid="price-chart"]').waitFor();
    await pk.keyboard.press("Escape");
    await pk.waitForTimeout(300);
    const afterOpen = { btc: await anim(mark(pk, "BTC")).catch(() => null), eth: await anim(mark(pk, "ETH")).catch(() => null), stop: await stopBtn.count() };
    await stopBtn.click({ timeout: 3000 }).catch(() => null);
    await pk.waitForTimeout(200);
    const afterStop = { eth: await anim(mark(pk, "ETH")).catch(() => null), stop: await stopBtn.count(), marks: await pk.locator('[data-testid="fund-disagree"]').count() };
    await ck.close();

    // --- I-3: with keep pulses running, changing the mode to Off removes them and the Stop pulsing button ---
    const cm = await newContext(browser);
    const pm = await openPage(cm);
    await pm.waitForTimeout(2500);
    await pm.getByRole("button", { name: /^Scoring profile/ }).click();
    await pm.locator('[data-testid="fund-pulse"]').selectOption("keep");
    await pm.getByRole("button", { name: /^Scoring profile/ }).click();
    await setRibbon(pm, true, "SOL");
    await pm.keyboard.press("Escape");
    await pm.keyboard.press("Escape");
    await mark(pm, "BTC").waitFor({ timeout: 30000 }).catch(() => null);
    await pm.waitForTimeout(600);
    const modeChange = { before: await pm.locator('[data-testid="stop-pulse"]').count() };
    await pm.getByRole("button", { name: /^Scoring profile/ }).click();
    await pm.locator('[data-testid="fund-pulse"]').selectOption("off");
    await pm.getByRole("button", { name: /^Scoring profile/ }).click();
    await pm.waitForTimeout(400);
    modeChange.after = await pm.locator('[data-testid="stop-pulse"]').count();
    modeChange.marks = await pm.locator('[data-testid="fund-disagree"]').count();
    await cm.close();

    record("FT-4", "Disagreement: no list marker with the ribbon off; on, the marker (labelled) and a row outline appear and pulse 3 times, then stay without replay; chart bars get hatching and a diamond; reduced motion shows no animation; Keep pulsing runs until the coin is opened or Stop pulsing is pressed",
      offCount === 0 && offOutline === 0
        && first.count === 1 && first.anim?.name === "ft-pulse" && first.anim?.iter === "3" && first.label === "Confluence and Fund trend disagree" && first.out.style === "solid" && first.out.cls
        && ethFirst.count === 1 && ethFirst.dir === "-1"
        && hatchN > 0 && /^url\(#ft-hatch-[A-Za-z0-9_-]+\)$/.test(hatchInfo?.fill || "") && hatchInfo?.pattern && hatchInfo?.diamond && hatchInfo?.title === "Confluence and Fund trend disagree"
        && done?.name === "none" && replay?.name === "none"
        && reduced.count === 1 && reduced.anim?.name === "none" && reduced.out.style === "solid"
        && keepBefore.btc?.name === "ft-pulse" && keepBefore.btc?.iter === "infinite" && keepBefore.eth?.iter === "infinite" && keepBefore.stop === 1 && keepBefore.stopText === "Stop pulsing"
        && afterOpen.btc?.name === "none" && afterOpen.eth?.iter === "infinite" && afterOpen.stop === 1
        && afterStop.eth?.name === "none" && afterStop.stop === 0 && afterStop.marks === 2
        && reduced.stopKeepReduced === 0 && modeChange.before === 1 && modeChange.after === 0 && modeChange.marks === 2,
      { offCount, offOutline, first, ethFirst, hatchN, hatchInfo, done, replay, reduced, keepBefore, afterOpen, afterStop, modeChange });

    // --- Fund rank column: absent by default, present when enabled ---
    const c5 = await newContext(browser);
    const p5 = await openPage(c5);
    await p5.waitForTimeout(2500);
    const colOff = { th: await p5.locator('[data-testid="col-fund-rank"]').count(), td: await p5.locator('[data-testid="cell-fund-rank"]').count() };
    await p5.getByRole("button", { name: /^Scoring profile/ }).click();
    const cb = p5.locator('[data-testid="fund-rank-column"]');
    const defaults = { checked: await cb.isChecked(), pulse: await p5.locator('[data-testid="fund-pulse"]').inputValue() };
    await cb.check();
    await p5.getByRole("button", { name: /^Scoring profile/ }).click();
    await p5.locator('[data-testid="col-fund-rank"]').waitFor();
    await p5.waitForFunction(() => [...document.querySelectorAll('[data-testid="cell-fund-rank"]')].some((e) => /^\d+$/.test(e.textContent || "")), null, { timeout: 30000 }).catch(() => null);
    const cells = await p5.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => ({ name: tr.querySelector("button")?.textContent || "", cell: tr.querySelector('[data-testid="cell-fund-rank"]')?.textContent ?? null })));
    const head = await p5.locator('[data-testid="col-fund-rank"]').textContent();
    const nums = cells.map((x) => x.cell).filter((x) => /^\d+$/.test(x || "")).map(Number);
    const btcCell = cells.find((x) => /^BTC/.test(x.name))?.cell, ethCell = cells.find((x) => /^ETH/.test(x.name))?.cell;
    await p5.getByRole("combobox", { name: "Asset class" }).click();
    await p5.getByRole("option", { name: "Stocks (tokenised)" }).click();
    await p5.waitForFunction(() => /TSLAB/.test(document.querySelector("tbody")?.textContent || ""), null, { timeout: 15000 });
    const stockCells = await p5.locator('[data-testid="cell-fund-rank"]').allTextContents();
    await c5.close();
    record("FT-5", "Fund rank column: absent by default (and the pulse default is 3 pulses); when enabled, crypto rows show their rank (strongest Fund trend = 1) and other rows show a dash",
      colOff.th === 0 && colOff.td === 0 && !defaults.checked && defaults.pulse === "three" && head === "Fund rank"
        && nums.length >= 3 && ethCell === "1" && btcCell === String(Math.max(...nums)) && stockCells.length > 0 && stockCells.every((x) => x === "—"),
      { colOff, defaults, head, nums: nums.length, ethCell, btcCell, stockCells });
  }

  /* ===== v2.8 WP22 (Scenarios): the collapsed section in the detail sheet ===== */
  /* acceptance-ids: SC-1, SC-2, SC-6 */
  {
    const c = await newContext(browser);
    await mockExchanges(c);
    // SOL: only 250 closed bars of the chart timeframe (the daily series is untouched), so its section has not enough history.
    await c.route(/^https:\/\/data-api\.binance\.vision\/api\/v3\/klines/, async (route) => {
      const u = new URL(route.request().url());
      if (u.searchParams.get("symbol") !== "SOLUSDT" || u.searchParams.get("interval") === "1d") return route.fallback();
      return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: JSON.stringify(klines("SOLUSDT", 250, stepOf(u))) });
    });
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p);
    await waitRows(p);
    await p.getByRole("button", { name: /^BTC/ }).first().click();
    const chart = p.getByTestId("price-chart");
    await chart.waitFor({ timeout: 15000 });
    const section = p.getByTestId("scenarios-section");
    await section.waitFor({ timeout: 10000 }).catch(() => null);
    const toggle = p.getByTestId("scenarios-toggle");
    await p.waitForTimeout(500);
    const rest = {
      sections: await section.count(),
      afterPattern: await section.evaluate((el) => /Historical analogues/.test(el.previousElementSibling?.textContent ?? "")).catch(() => false),
      expanded: await toggle.getAttribute("aria-expanded").catch(() => null),
      controls: await toggle.getAttribute("aria-controls").catch(() => null),
      body: await p.locator("#scenarios-body").count(),
      sim: await chart.locator("[data-sim]").count(),
      controlsRow: await chart.getByTestId("projection-controls").count(),
      allowed: DS2_ALLOWED.detail.includes('[data-testid="scenarios-section"]'),
    };
    record("SC-1", "Scenarios section sits after the Pattern panel, collapsed by default, nothing computed or drawn at rest",
      rest.sections === 1 && rest.afterPattern && rest.expanded === "false" && rest.controls === "scenarios-body" && rest.body === 0 && rest.sim === 0 && rest.controlsRow === 0 && rest.allowed, rest);

    // The simulation runs in the report worker (created lazily by the first request; the ledger was not opened here).
    const workersAfter = [];
    p.on("worker", (w) => workersAfter.push(w.url()));
    await toggle.click();
    const table = p.getByTestId("scenarios-table");
    await table.waitFor({ timeout: 30000 }).catch(() => null);
    const read = async () => p.evaluate(() => {
      const tb = document.querySelector('[data-testid="scenarios-table"]');
      const rows = [...document.querySelectorAll("[data-scenario]")].map((r) => ({ id: r.getAttribute("data-scenario"), p: Number(r.getAttribute("data-p")), cells: [...r.querySelectorAll("td,th")].map((x) => x.textContent.trim()) }));
      const sample = document.querySelector('[data-testid="scenarios-sample"]');
      return { h: tb?.getAttribute("data-h") ?? null, rows, neff: sample ? Number(sample.getAttribute("data-neff")) : NaN, sampleText: sample?.textContent ?? null, explain: document.querySelector('[data-testid="scenarios-explain"]')?.textContent ?? null };
    });
    const six = await read();
    const header = await p.getByTestId("scenarios-header").textContent().catch(() => null);
    const expandedNow = await toggle.getAttribute("aria-expanded");
    const sum = six.rows.reduce((a, r) => a + r.p, 0);
    // Each row: odds, Wilson range, cases and base rate (percent with one decimal, never "-0.0").
    const rowsOk = (x) => x.rows.length === 3 && Math.abs(x.rows.reduce((a, r) => a + r.p, 0) - 1) <= 0.002 && x.rows.every((r) => r.cells.length === 5 && /^\d+\.\d %$/.test(r.cells[1]) && /^\d+\.\d–\d+\.\d %$/.test(r.cells[2]) && /^\d+$/.test(r.cells[3]) && /^\d+\.\d %$/.test(r.cells[4]));
    const h = p.getByTestId("scenarios-h");
    await h.getByRole("radio", { name: "24 bars" }).click();
    await p.locator('[data-testid="scenarios-table"][data-h="24"]').waitFor({ timeout: 30000 }).catch(() => null);
    const tf = await read();
    // 6 → 24 → 6 within 100 ms: the last request wins, an earlier result is discarded by its key.
    await p.evaluate(() => new Promise((ok) => {
      const btn = (n) => [...document.querySelectorAll('[data-testid="scenarios-h"] [role="radio"]')].find((b) => b.textContent.trim() === `${n} bars`);
      btn(6).click(); setTimeout(() => { btn(24).click(); setTimeout(() => { btn(6).click(); ok(); }, 40); }, 40);
    }));
    await p.locator('[data-testid="scenarios-table"][data-h="6"]').waitFor({ timeout: 30000 }).catch(() => null);
    await p.waitForTimeout(1500);
    const quick = await read();
    record("SC-2", "Expanded: fixed header, three scenarios with odds, Wilson range, cases, effective sample and base rate, explanation without placeholders; 24-bar horizon has the smaller sample; a quick horizon switch never shows a stale result",
      expandedNow === "true" && header === "Possible scenarios from past data — not a forecast." && six.h === "6" && rowsOk(six) && six.neff > 0 && /effective sample/.test(six.sampleText || "")
        && !!six.explain && six.explain.trim().length > 0 && !/[{}]/.test(six.explain) && tf.h === "24" && rowsOk(tf) && tf.neff < six.neff && quick.h === "6" && quick.neff === six.neff && workersAfter.length >= 1,
      { header, workers: workersAfter.length, six: { h: six.h, rows: six.rows, sum, neff: six.neff, sample: six.sampleText, explain: (six.explain || "").slice(0, 160) }, tf: { h: tf.h, neff: tf.neff, rows: tf.rows.map((r) => r.cells.join(" | ")) }, quick: { h: quick.h, neff: quick.neff } });
    await p.keyboard.press("Escape");
    await p.waitForFunction(() => !document.querySelector('[role="dialog"]'), null, { timeout: 10000 }).catch(() => null);

    await p.getByRole("button", { name: /^SOL/ }).first().click();
    await p.getByTestId("price-chart").waitFor({ timeout: 15000 });
    const solBars = await p.locator('[role="dialog"]').first().textContent().then((t) => (t.match(/([\d,]+) closed bars/) || [])[1] ?? null);
    await p.getByTestId("scenarios-toggle").click();
    const na = p.getByTestId("scenarios-na");
    await na.waitFor({ timeout: 15000 }).catch(() => null);
    const naText = await na.textContent().catch(() => null);
    const sol = { solBars, naText, show: await p.getByTestId("scenarios-show").count(), table: await p.getByTestId("scenarios-table").count() };
    record("SC-6", "Short history (250 bars): the expanded section says \"Scenarios: not enough history (needs at least 300 closed bars).\" with no table and no Show on chart",
      naText === "Scenarios: not enough history (needs at least 300 closed bars)." && sol.show === 0 && sol.table === 0, sol);
    await c.close();
  }

  /* ===== v2.8 WP22 (Scenarios): Show on chart, Play, fullscreen / zoom / Heikin-Ashi ===== */
  /* acceptance-ids: SC-3, SC-4, SC-5 */
  {
    const c = await newContext(browser);
    await mockExchanges(c);
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p);
    await waitRows(p);
    await p.getByRole("button", { name: /^BTC/ }).first().click();
    const chart = p.getByTestId("price-chart");
    await chart.waitFor({ timeout: 15000 });
    const svg = chart.locator("svg").first();
    await p.mouse.move(1, 1);
    await p.waitForTimeout(500);
    const svgAtRest = await svg.evaluate((e) => e.outerHTML);
    await p.getByTestId("scenarios-toggle").click();
    await p.getByTestId("scenarios-table").waitFor({ timeout: 30000 }).catch(() => null);
    const svgExpanded = await svg.evaluate((e) => e.outerHTML);
    const show = p.getByTestId("scenarios-show");
    // Long tasks are watched from Show on chart to the end of Play (Review Focus 5).
    await p.evaluate(() => { window.__lt = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ type: "longtask" }); } catch { window.__lt = null; } });
    await show.click();
    await chart.locator('[data-sim="candle"]').first().waitFor({ timeout: 15000 }).catch(() => null);
    const candleY = () => chart.locator('[data-sim="candle"] rect').evaluateAll((els) => els.map((e) => e.getAttribute("y")).join(","));
    const drawn = {
      pressed: await show.getAttribute("aria-pressed"),
      showText: await show.textContent(),
      bands: await chart.locator('[data-sim="band"]').count(),
      median: await chart.locator('[data-sim="median"]').count(),
      label: await chart.locator('[data-sim="label"]').textContent().catch(() => null),
      now: await chart.locator('[data-sim="now"]').count(),
      candles: await chart.locator('[data-sim="candle"]').count(),
      hollow: await chart.locator('[data-sim="candle"] rect').evaluateAll((els) => els.length > 0 && els.every((e) => e.getAttribute("fill") === "none" && !!e.getAttribute("stroke-dasharray"))),
      tabs: await chart.getByRole("tab").count(),
    };
    const y0 = await candleY();
    const other = chart.locator('[role="tab"][aria-selected="false"]:not([disabled])').first();
    const otherId = await other.getAttribute("data-tab").catch(() => null);
    if (otherId) await other.click();
    await p.waitForTimeout(200);
    const y1 = await candleY();
    await show.click();
    await chart.locator("[data-sim]").first().waitFor({ state: "detached", timeout: 10000 }).catch(() => null);
    await p.mouse.move(1, 1);
    const svgOff = await svg.evaluate((e) => e.outerHTML);
    record("SC-3", "Show on chart: two band polygons, dotted median, SIMULATED label, now marker and six hollow dashed candles; tabs switch the path; turning it off restores the exact default chart",
      svgExpanded === svgAtRest && drawn.pressed === "true" && drawn.showText === "Hide from chart" && drawn.bands === 2 && drawn.median === 1 && drawn.label === "SIMULATED" && drawn.now === 1 && drawn.candles === 6 && drawn.hollow
        && drawn.tabs === 3 && !!otherId && y1 !== y0 && (await show.getAttribute("aria-pressed")) === "false" && svgOff === svgAtRest,
      { ...drawn, otherId, tabChanged: y1 !== y0, expandedSame: svgExpanded === svgAtRest, offSame: svgOff === svgAtRest, len: [svgAtRest.length, svgOff.length] });

    // SC-4 — Play at H = 24: one candle per ~250 ms from 0 to 24; Pause holds; Replay at the end.
    await p.getByTestId("scenarios-h").getByRole("radio", { name: "24 bars" }).click();
    await p.locator('[data-testid="scenarios-table"][data-h="24"]').waitFor({ timeout: 30000 }).catch(() => null);
    await show.click();
    await p.waitForFunction(() => document.querySelectorAll('[data-sim="candle"]').length === 24, null, { timeout: 15000 }).catch(() => null);
    const play = chart.getByTestId("projection-play");
    const labelAtRest = await play.textContent();
    const samples = await p.evaluate(() => new Promise((ok) => {
      const count = () => document.querySelectorAll('[data-sim="candle"]').length;
      document.querySelector('[data-testid="projection-play"]').click();
      const out = [];
      const t0 = performance.now();
      const id = setInterval(() => {
        const n = count();
        out.push([Math.round(performance.now() - t0), n]);
        if (n >= 24 || performance.now() - t0 > 24 * 250 + 1000) { clearInterval(id); ok(out); }
      }, 100);
    }));
    const counts = samples.map((s) => s[1]);
    const incs = [];
    for (let i = 1; i < samples.length; i++) if (samples[i][1] > samples[i - 1][1]) incs.push(samples[i][0]);
    const gaps = incs.slice(1).map((t, i) => t - incs[i]);
    const rising = counts.every((n, i) => i === 0 || n >= counts[i - 1]);
    await p.waitForTimeout(150);
    const labelEnd = await play.textContent();
    // Replay restarts from 0; Pause mid-way holds the count for 600 ms; Play resumes from it.
    await play.click();
    await p.waitForFunction(() => document.querySelectorAll('[data-sim="candle"]').length >= 6, null, { timeout: 10000 }).catch(() => null);
    const labelPlaying = await play.textContent();
    await play.click();
    const held0 = await chart.locator('[data-sim="candle"]').count();
    const labelPaused = await play.textContent();
    await p.waitForTimeout(600);
    const held1 = await chart.locator('[data-sim="candle"]').count();
    await play.click();
    await p.waitForTimeout(400);
    const resumed = await chart.locator('[data-sim="candle"]').count();
    await p.waitForFunction(() => document.querySelectorAll('[data-sim="candle"]').length === 24, null, { timeout: 15000 }).catch(() => null);
    await p.waitForTimeout(300);
    const labelEnd2 = await play.textContent();
    const longTasks = await p.evaluate(() => window.__lt);
    // Reduced motion: Play shows all 24 at once.
    const c2 = await newContext(browser, { reducedMotion: "reduce" });
    await mockExchanges(c2);
    const p2 = await c2.newPage();
    await p2.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p2);
    await waitRows(p2);
    await p2.getByRole("button", { name: /^BTC/ }).first().click();
    await p2.getByTestId("price-chart").waitFor({ timeout: 15000 });
    await p2.getByTestId("scenarios-toggle").click();
    await p2.getByTestId("scenarios-table").waitFor({ timeout: 30000 }).catch(() => null);
    await p2.getByTestId("scenarios-h").getByRole("radio", { name: "24 bars" }).click();
    await p2.locator('[data-testid="scenarios-table"][data-h="24"]').waitFor({ timeout: 30000 }).catch(() => null);
    await p2.getByTestId("scenarios-show").click();
    await p2.getByTestId("projection-play").waitFor({ timeout: 15000 }).catch(() => null);
    const reduced = await p2.evaluate(() => new Promise((ok) => {
      const count = () => document.querySelectorAll('[data-sim="candle"]').length;
      document.querySelector('[data-testid="projection-play"]').click();
      const out = [];
      const id = setInterval(() => { out.push(count()); if (out.length >= 8) { clearInterval(id); ok(out); } }, 100);
    }));
    const reducedLabel = await p2.getByTestId("projection-play").textContent().catch(() => null);
    await c2.close();
    const sc4 = { labelAtRest, first: counts[0], last: counts[counts.length - 1], tEnd: samples[samples.length - 1]?.[0], rising, minGap: Math.min(...gaps), n: samples.length, labelEnd, labelPlaying, labelPaused, held: [held0, held1], resumed, labelEnd2, longTasks, reduced, reducedLabel };
    record("SC-4", "Play draws the 24 simulated candles one at a time (~250 ms each, never backwards), Pause holds the count, Play resumes and Replay shows at the end; no long task ≥ 200 ms; reduced motion shows all 24 at once",
      labelAtRest === "▶ Play" && counts[0] === 0 && sc4.last === 24 && sc4.tEnd <= 24 * 250 + 1000 && rising && gaps.length > 0 && sc4.minGap >= 150
        && labelEnd === "Replay" && labelPlaying === "Pause" && labelPaused === "▶ Play" && held0 > 0 && held0 < 24 && held1 === held0 && resumed > held0 && labelEnd2 === "Replay"
        && Array.isArray(longTasks) && longTasks.every((d) => d < 200) && reduced.every((n) => n === 24) && reducedLabel === "Replay",
      sc4);

    // SC-5 — fullscreen, zoomed out (bucketed simulated candles) and Heikin-Ashi; everything off gives the default SVG back.
    await svg.focus();
    await p.keyboard.press("f");
    await p.waitForTimeout(500);
    const fsMode = await chart.getAttribute("data-fullscreen");
    const fsLabel = await chart.locator('[data-sim="label"]').isVisible().catch(() => false);
    await p.keyboard.press("Escape");
    await p.waitForTimeout(400);
    const zoomOut = chart.getByRole("button", { name: "Zoom out" });
    let readout = "";
    for (let i = 0; i < 8 && !/bars per candle/.test(readout); i++) {
      if (await zoomOut.isDisabled()) break;
      await zoomOut.click();
      await p.waitForTimeout(150);
      readout = (await chart.getByTestId("chart-readout").textContent().catch(() => "")) ?? "";
    }
    const bucketed = await chart.locator('[data-sim="candle"]').count();
    await chart.getByRole("button", { name: "Indicators", exact: true }).click();
    const ha = chart.getByRole("checkbox", { name: "Heikin-Ashi (display only)", exact: true });
    await ha.check();
    await p.waitForTimeout(300);
    const haOn = {
      sim: await chart.locator('[data-sim="candles"][data-ha="1"]').count(),
      real: await chart.locator('[data-testid="price-candles"][data-ha="1"]').count(),
      readout: /HA O/.test((await chart.getByTestId("chart-readout").textContent().catch(() => "")) ?? ""),
    };
    await ha.uncheck();
    await chart.getByRole("button", { name: "Indicators", exact: true }).click();
    await show.click();
    await chart.getByRole("button", { name: "Reset view" }).click();
    await chart.locator("[data-sim]").first().waitFor({ state: "detached", timeout: 10000 }).catch(() => null);
    await p.mouse.move(1, 1);
    await p.waitForTimeout(300);
    // Full screen re-applies the svg's inline style, which only changes the serialised order of its declarations:
    // both captures are compared with each style attribute's declarations sorted (everything else byte for byte).
    const canon = (e) => { const c = e.cloneNode(true); for (const el of [c, ...c.querySelectorAll("[style]")]) { const st = el.getAttribute("style"); if (st !== null) el.setAttribute("style", st.split(";").map((d) => d.trim()).filter(Boolean).sort().join("; ")); } return c.outerHTML; };
    await p.evaluate(`window.__scCanon = ${canon}`);
    const svgBack = await svg.evaluate((e) => window.__scCanon(e));
    const svgRestCanon = await p.evaluate((html) => { const d = document.createElement("div"); d.innerHTML = html; return window.__scCanon(d.firstElementChild); }, svgAtRest);
    record("SC-5", "Projection with full screen (SIMULATED label visible), zoomed out to bucketed candles (1–24 drawn) and Heikin-Ashi (simulated and real candles, readout shows HA O); turning everything off gives the default SVG back",
      fsMode !== "off" && fsLabel && /bars per candle/.test(readout) && bucketed >= 1 && bucketed <= 24 && haOn.sim === 1 && haOn.real === 1 && haOn.readout && svgBack === svgRestCanon,
      { fsMode, fsLabel, readout: readout.slice(0, 60), bucketed, haOn, back: svgBack === svgRestCanon, len: [svgRestCanon.length, svgBack.length] });
    await c.close();
  }

  /* ===== v2.8 WP24: Reflect view (display only; one price y-mapping) ===== */
  /* acceptance-ids: RV-1, RV-2, RV-3 */
  {
    const c = await newContext(browser);
    await mockExchanges(c);
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p);
    await waitRows(p);
    await p.getByRole("button", { name: /^BTC/ }).first().click();
    const chart = p.getByTestId("price-chart");
    await chart.waitFor({ timeout: 15000 });
    const svg = chart.locator("svg").first();
    await p.mouse.move(1, 1);
    await p.waitForTimeout(500);
    const svgDefault = await svg.evaluate((e) => e.outerHTML);
    const REFLECT = "Reflect view (mirror the price axis)";
    const reflectBox = () => chart.getByRole("checkbox", { name: REFLECT, exact: true });
    const openMenu = () => chart.getByRole("button", { name: "Indicators", exact: true }).click();
    // The Indicators menu is only in the DOM while open: put it in the wanted state without guessing.
    const setMenu = async (want) => { if (((await reflectBox().count()) > 0) !== want) await openMenu(); };
    const wicks = () => chart.locator('[data-testid="price-candles"] > g').evaluateAll((gs) => {
      const w = (g) => { const l = g.querySelector("line"); return [Number(l.getAttribute("y1")), Number(l.getAttribute("y2"))]; };
      return [w(gs[0]), w(gs[gs.length - 1])];
    });
    const bodyH = () => chart.locator('[data-testid="price-candles"] rect').evaluateAll((els) => els.map((e) => Number(e.getAttribute("height"))));
    const boxes = (sel) => chart.locator(`[data-indicator="${sel}"] rect`).evaluateAll((els) => els.map((e) => ["x", "y", "width", "height"].map((a) => e.getAttribute(a)).join(",")).join("|"));
    const readoutAt = async (n) => {
      await svg.focus();
      await p.keyboard.press("Home");
      for (let i = 0; i < n; i++) await p.keyboard.press("ArrowRight");
      await p.waitForTimeout(150);
      return (await chart.getByTestId("chart-readout").textContent().catch(() => "")) ?? "";
    };
    const geom = await svg.evaluate((e) => { const vb = e.viewBox.baseVal; return { vbH: vb.height }; });

    // Normal view numbers.
    const wN = await wicks(), hN = await bodyH(), macdN = await boxes("macd"), volN = await boxes("volume");
    const roN = await readoutAt(10);
    await p.mouse.move(1, 1);
    // Price pane geometry: PAD_T = 12, the price pane ends where the first lower pane starts.
    const priceBottom = await chart.locator('[data-indicator="macd"] line').first().getAttribute("y1");
    const PAD_T = 12;
    const sumY = 2 * PAD_T + (Number(priceBottom) - PAD_T);

    // RV-1
    await setMenu(true);
    await reflectBox().check();
    await p.waitForTimeout(300);
    await setMenu(false);
    const wR = await wicks();
    const mirrored = [0, 1].every((i) => [0, 1].every((j) => Math.abs(wR[i][j] - (sumY - wN[i][j])) <= 0.15));
    const badge = chart.getByTestId("reflect-badge");
    const badgeText = (await badge.textContent().catch(() => "")) ?? "";
    const badgeVisible = await badge.isVisible().catch(() => false);
    const attr = await svg.getAttribute("data-reflect");
    await svg.focus();
    await p.keyboard.press("f");
    await p.waitForTimeout(500);
    const badgeFull = await chart.getByTestId("reflect-badge").isVisible().catch(() => false);
    await p.keyboard.press("Escape");
    await p.waitForTimeout(400);

    // RV-2 (reflected readings)
    const hR = await bodyH(), macdR = await boxes("macd"), volR = await boxes("volume");
    const roR = await readoutAt(10);
    const bodiesSame = hN.length > 0 && hN.length === hR.length && hN.every((h, i) => Math.abs(h - hR[i]) <= 0.01);
    // Fund trend panel size-axis labels follow the mirrored mapping: reflected, "0 %" sits at the top of the panel.
    await setMenu(true);
    await chart.getByRole("checkbox", { name: "Fund trend panel", exact: true }).check();
    await chart.locator('[data-fund-label="size0"]').waitFor({ timeout: 30000 }).catch(() => null);
    const sizeLabels = () => chart.getByTestId("fund-panel").evaluate((g) => {
      const top = Number(g.querySelector("line").getAttribute("y1"));
      const t = [...g.querySelectorAll("text")].filter((e) => /^(0|200) %$/.test(e.textContent));
      const y = (l) => Number(t.find((e) => e.textContent === l)?.getAttribute("y"));
      return { top, y0: y("0 %"), y200: y("200 %") };
    }).catch(() => null);
    const lblR = await sizeLabels();
    // Simulated candles with Heikin-Ashi, normal and reflected.
    await p.getByTestId("scenarios-toggle").click();
    await p.getByTestId("scenarios-table").waitFor({ timeout: 30000 }).catch(() => null);
    await p.getByTestId("scenarios-show").click();
    await chart.locator('[data-sim="candle"]').first().waitFor({ timeout: 15000 }).catch(() => null);
    await setMenu(true);
    await chart.getByRole("checkbox", { name: "Heikin-Ashi (display only)", exact: true }).check();
    await p.waitForTimeout(300);
    const simH = () => chart.locator('[data-sim="candle"] rect').evaluateAll((els) => els.map((e) => Number(e.getAttribute("height"))));
    const simR = await simH();
    await reflectBox().uncheck();
    await p.waitForTimeout(300);
    const lblN = await sizeLabels();
    const labelsOk = !!lblR && !!lblN && lblR.y0 - lblR.top === 27 && lblR.y200 > lblR.y0 && lblN.y0 > lblN.y200 && lblN.y200 - lblN.top === 27;
    const simN = await simH();
    const simSame = simN.length === 6 && simN.length === simR.length && simN.every((h, i) => Math.abs(h - simR[i]) <= 0.01);
    // Back to reflected for the key toggle check: I turns it on, then off again.
    await setMenu(false);
    await svg.focus();
    await p.keyboard.press("i");
    await p.waitForTimeout(300);
    const keyOn = (await svg.getAttribute("data-reflect")) === "1" && (await badge.count()) === 1;
    await p.keyboard.press("i");
    await p.waitForTimeout(300);
    const keyOff = (await svg.getAttribute("data-reflect")) === null && (await badge.count()) === 0;
    record("RV-1", "Reflect view mirrors the first and last candle positions, the Reflected badge shows on the price pane and in full screen, and I toggles it",
      mirrored && badgeVisible && badgeText === "Reflected" && attr === "1" && badgeFull && keyOn && keyOff, { wN, wR, sumY, badgeText, badgeVisible, attr, badgeFull, keyOn, keyOff, vbH: geom.vbH });
    record("RV-2", "Reflect view keeps the real readout (candle 10 O/H/L/C identical), every candle body height, the MACD and volume boxes and the Heikin-Ashi simulated body heights unchanged",
      roN.length > 0 && roN === roR && bodiesSame && macdN === macdR && volN === volR && simSame && labelsOk,
      { labelsOk, lblR, lblN, roN: roN.slice(0, 80), roR: roR.slice(0, 80), bodiesSame, macd: macdN === macdR, vol: volN === volR, simN, simR });

    // RV-3 — Reflect + Heikin-Ashi + projection, zoom and pan; then all off and Reset view gives the default SVG back.
    await setMenu(true);
    await chart.getByRole("checkbox", { name: "Fund trend panel", exact: true }).uncheck();
    await chart.getByRole("checkbox", { name: "Heikin-Ashi (display only)", exact: true }).uncheck();
    await setMenu(false);
    const show = p.getByTestId("scenarios-show");
    if ((await show.getAttribute("aria-pressed")) === "true") await show.click();
    await chart.locator("[data-sim]").first().waitFor({ state: "detached", timeout: 10000 }).catch(() => null);
    await setMenu(true);
    await reflectBox().check();
    await chart.getByRole("checkbox", { name: "Heikin-Ashi (display only)", exact: true }).check();
    await setMenu(false);
    await show.click();
    await chart.locator('[data-sim="candle"]').first().waitFor({ timeout: 15000 }).catch(() => null);
    const barsBefore = await chart.locator('[data-testid="price-candles"] > g').count();
    await chart.getByRole("button", { name: "Zoom in" }).click();
    await p.waitForTimeout(200);
    // The projection sits at the right edge, so it is counted while zoomed in; panning away then hides it.
    const simZoomed = await chart.locator('[data-sim="candle"]').count();
    await svg.focus();
    await p.keyboard.press("Shift+ArrowLeft");
    await p.waitForTimeout(200);
    const allOn = {
      simZoomed,
      reflect: await svg.getAttribute("data-reflect"),
      ha: await chart.locator('[data-testid="price-candles"][data-ha="1"]').count(),
      sim: await chart.locator('[data-sim="candle"]').count(),
      zoomed: (await chart.locator('[data-testid="price-candles"] > g').count()) < barsBefore,
    };
    await setMenu(true);
    await reflectBox().uncheck();
    await chart.getByRole("checkbox", { name: "Heikin-Ashi (display only)", exact: true }).uncheck();
    await setMenu(false);
    await show.click();
    await chart.locator("[data-sim]").first().waitFor({ state: "detached", timeout: 10000 }).catch(() => null);
    await chart.getByRole("button", { name: "Reset view" }).click();
    await p.mouse.move(1, 1);
    await p.waitForTimeout(400);
    // This run went through full screen (RV-1), which only reorders the serialised declarations of the svg's inline
    // style: both captures are compared with each style attribute's declarations sorted (the same comparator as SC-5).
    const canon = (e) => { const c = e.cloneNode(true); for (const el of [c, ...c.querySelectorAll("[style]")]) { const st = el.getAttribute("style"); if (st !== null) el.setAttribute("style", st.split(";").map((d) => d.trim()).filter(Boolean).sort().join("; ")); } return c.outerHTML; };
    await p.evaluate(`window.__rvCanon = ${canon}`);
    const svgBack = await svg.evaluate((e) => window.__rvCanon(e));
    const svgDefaultCanon = await p.evaluate((html) => { const d = document.createElement("div"); d.innerHTML = html; return window.__rvCanon(d.firstElementChild); }, svgDefault);
    await setMenu(true);
    await reflectBox().check();
    const stored = await p.evaluate(() => { try { return localStorage.getItem("ct-chart-optin-v1"); } catch { return null; } });
    await p.reload({ waitUntil: "domcontentloaded" });
    await waitRows(p);
    await p.getByRole("button", { name: /^BTC/ }).first().click();
    await chart.waitFor({ timeout: 15000 });
    await p.waitForTimeout(500);
    const afterReload = await svg.getAttribute("data-reflect");
    await setMenu(true);
    await chart.getByRole("button", { name: "Reset to defaults" }).click();
    await p.waitForTimeout(300);
    const afterReset = await svg.getAttribute("data-reflect");
    const storedReset = await p.evaluate(() => { try { return localStorage.getItem("ct-chart-optin-v1"); } catch { return null; } });
    record("RV-3", "Reflect + Heikin-Ashi + projection with zoom and pan, then all off and Reset view, gives the default SVG back; Reflect is remembered across a reload (ct-chart-optin-v1) and Reset to defaults clears it",
      allOn.reflect === "1" && allOn.ha === 1 && allOn.simZoomed > 0 && allOn.zoomed && svgBack === svgDefaultCanon && !!stored && stored.includes("reflect") && afterReload === "1" && afterReset === null && !(storedReset ?? "").includes("reflect"),
      { allOn, back: svgBack === svgDefaultCanon, len: [svgDefaultCanon.length, svgBack.length], stored, afterReload, afterReset, storedReset });
    await c.close();
  }

  /* ===== v2.8 WP22 (Scenarios): the Scenario check at the end of the ledger dialog ===== */
  /* acceptance-ids: SC-7 */
  {
    const c = await newContext(browser);
    await mockExchanges(c);
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p);
    await waitRows(p);
    await p.getByRole("button", { name: /Signal ledger \(forward test\)/ }).click();
    await p.waitForSelector("text=Signals recorded");
    const dialog = p.locator('[role="dialog"]').first();
    const sec = p.getByTestId("ledger-scenario-check");
    await sec.waitFor({ timeout: 10000 }).catch(() => null);
    const toggle = p.getByTestId("ledger-scenario-toggle");
    const rest = {
      sections: await sec.count(),
      // The dialog's own close (X) button is rendered after the content: the section is the last content element.
      last: await dialog.evaluate((d) => [...d.children].filter((e) => e.getAttribute("data-slot") !== "dialog-close" && !e.querySelector(':scope > .sr-only') && !e.matches("button")).pop()?.getAttribute("data-testid") ?? null).catch(() => null),
      expanded: await toggle.getAttribute("aria-expanded").catch(() => null),
      allowed: DS2_ALLOWED.ledger.includes('[data-testid="ledger-scenario-check"]'),
    };
    // The ledger lists the rows it loaded when it opened: reopen it until the scan's rows are recorded.
    for (let tries = 0; tries < 8 && !(await p.getByRole("button", { name: "Export CSV" }).isEnabled()); tries++) {
      await p.waitForTimeout(1500);
      await p.keyboard.press("Escape");
      await p.waitForFunction(() => !document.querySelector('[role="dialog"]'), null, { timeout: 10000 });
      await p.getByRole("button", { name: /Signal ledger \(forward test\)/ }).click();
      await p.getByTestId("ledger-scenario-check").waitFor({ timeout: 10000 });
      await p.waitForTimeout(500);
    }
    const [dl] = await Promise.all([p.waitForEvent("download"), p.getByRole("button", { name: "Export CSV" }).click()]);
    const sc7Path = path.join(OUT, "ledger-export-sc7.csv");
    await dl.saveAs(sc7Path);
    const sc7Lines = fs.readFileSync(sc7Path, "utf8").replace(/^\uFEFF/, "").trim().split(/\r?\n/);
    const head = sc7Lines[0].split(",").map((x) => x.replace(/^"|"$/g, ""));
    const at = head.indexOf("radar_alerts");
    const cols = head.slice(at + 1, at + 14);
    const lo = head.indexOf("scenario_band_lo95");
    const btcLine = sc7Lines.slice(1).find((l) => /BTCUSDT/.test(l)) ?? "";
    const btcCells = btcLine.split(",").map((x) => x.replace(/^"|"$/g, ""));
    const lo95 = Number(btcCells[lo]);
    await toggle.click();
    await p.waitForTimeout(300);
    const none = await p.getByTestId("ledger-scenario-check").textContent();
    const sc7 = { rest, cols: cols.length, allScenario: cols.every((x) => /^scenario_/.test(x)), lo95, none: (none ?? "").slice(0, 120) };
    record("SC-7", "Scenario check: collapsed section at the end of the ledger dialog; CSV export carries the scenario columns with values; with no closed outcomes it says so",
      rest.sections === 1 && rest.last === "ledger-scenario-check" && rest.expanded === "false" && rest.allowed
        && cols.length === 13 && sc7.allScenario && lo95 < 0 && /No closed 6-bar outcomes for rows with Scenarios yet\./.test(none ?? ""), sc7);
    await c.close();
  }

  /* ===== v2.8 WP27: smooth loading — progressive rows; layout at rest unchanged ===== */
  /* acceptance-ids: PG-1, PG-2 */
  {
    // 30 crypto pairs, each candle request answered after 600 ms (throttled network): five batches of six.
    const tickers = Array.from({ length: 30 }, (_, i) => ({ symbol: `PG${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}USDT`, openPrice: "100", lastPrice: "101", quoteVolume: String(1e9 - i * 1e6) }));
    const c = await newContext(browser);
    const mock = { tickers, klineDelayMs: 600 };
    await mockExchanges(c, null, mock);
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    const early = await p.waitForFunction(() => {
      const bar = document.querySelector('[data-testid="scan-progress"]');
      const rowsShown = document.querySelectorAll("tbody tr:has(td button)").length;
      return bar && rowsShown > 0 && Number(bar.dataset.done) < Number(bar.dataset.total)
        ? { rows: rowsShown, done: Number(bar.dataset.done), total: Number(bar.dataset.total), width: bar.style.width } : null;
    }, null, { timeout: 30000, polling: 50 }).then((h) => h.jsonValue(), () => null);
    await p.waitForFunction(() => document.querySelectorAll("tbody tr:has(td button)").length === 30 && !document.querySelector('[data-testid="scan-progress"]'), null, { timeout: 30000 }).catch(() => null);
    const final = await p.evaluate(() => ({ rows: document.querySelectorAll("tbody tr").length, badges: document.querySelectorAll('[data-testid="row-freshness"]').length }));
    record("PG-1", "Throttled network: rows appear while the scan runs (before the progress bar reaches 100 %); at rest every row is live (no badge)",
      !!early && early.rows >= 1 && early.done < early.total && final.rows === 30 && final.badges === 0, { early, final });
    // PG-2: reopen — rows come at once from on-device history marked "updating", before any candle arrives; a pair
    // whose fetch fails this time says "not updated" with its bar time once the scan is at rest.
    await p.waitForTimeout(1500); // history writes settle
    mock.failSymbol = "PGCAUSDT";
    await p.reload({ waitUntil: "domcontentloaded" });
    const instant = await p.waitForFunction(() => {
      const bar = document.querySelector('[data-testid="scan-progress"]');
      const updating = document.querySelectorAll('[data-testid="row-freshness"][data-state="updating"]').length;
      return bar && updating > 0 && Number(bar.dataset.done) === 0 ? { updating, text: document.querySelector('[data-testid="row-freshness"]').textContent } : null;
    }, null, { timeout: 30000, polling: 50 }).then((h) => h.jsonValue(), () => null);
    await p.waitForFunction(() => !document.querySelector('[data-testid="scan-progress"]') && !document.querySelector('[data-testid="row-freshness"][data-state="updating"]'), null, { timeout: 40000 }).catch(() => null);
    const rest = await p.evaluate(() => [...document.querySelectorAll('[data-testid="row-freshness"]')].map((b) => ({ state: b.dataset.state, text: b.textContent, row: b.closest("tr")?.querySelector("button > span:nth-child(2)")?.textContent })));
    record("PG-2", "Reopen: rows appear at once from on-device history marked \"updating · bar time\" before any candle arrives; at rest only the pair whose fetch failed says \"not updated · bar time\"",
      !!instant && instant.updating >= 10 && /^updating · \d/.test(instant.text) && rest.length === 1 && rest[0].state === "stale" && /^not updated · \d/.test(rest[0].text) && rest[0].row === "PGCAUSDT",
      { instant, rest });
    await c.close();
  }

  /* ===== v2.8 WP26: OKX Spot, OKX Perpetual, Coinbase (US) and Upbit (KR) on mocked venue data ===== */
  /* acceptance-ids: EX-1, EX-2, EX-3, EX-4, EX-6 */
  {
    // Response shapes are those of docs/research/evidence/wp26-venues-probe-2026-11-15.json (EX-PROBE-1), with the
    // Upbit ticker and the order books from the venues' docs (see lib/upbit.ts, lib/okx.ts, lib/coinbase.ts). Every
    // candle mock serves the bar still forming as its newest row: OKX flags it confirm "0"; Coinbase and Upbit give
    // no flag (the newest row is the forming bar). The scan must never score, record or chart it.
    const c = await newContext(browser, { timezoneId: "UTC" });
    await mockExchanges(c, null);
    const cors = { "access-control-allow-origin": "*", "content-type": "application/json" };
    // A bar unit is a length in ms, "W" (weeks from Monday 00:00 UTC) or "M" (calendar months, 1st 00:00 UTC).
    const STEP = { "1m": 60e3, "5m": 3e5, "15m": H15, "1H": 36e5, "4H": 144e5, "6Hutc": 216e5, "12Hutc": 432e5, "1Dutc": 864e5, "1Wutc": "W", "1Mutc": "M" };
    const MIN = { "1": 60e3, "3": 18e4, "5": 3e5, "10": 6e5, "15": H15, "30": 18e5, "60": 36e5, "240": 144e5 };
    const WEEK = 6048e5, MONDAY0 = 4 * 864e5;
    const formingOf = (unit, now = Date.now()) => {
      if (unit === "M") { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }
      if (unit === "W") return Math.floor((now - MONDAY0) / WEEK) * WEEK + MONDAY0;
      return Math.floor(now / unit) * unit;
    };
    const prevEdge = (unit, t) => {
      if (unit === "M") { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1); }
      return t - (unit === "W" ? WEEK : unit);
    };
    const indexOf = (unit, t) => Math.floor(t / (typeof unit === "number" ? unit : 864e5));
    // Deterministic price per (pair, bar time), so overlapping pages agree; the forming bar jumps 50 % so it is easy to spot.
    const pxAt = (sym, i) => { const s = [...sym].reduce((a, ch) => a + ch.charCodeAt(0), 7); return 100 * Math.exp(0.03 * Math.sin((i + s) / 9) + 0.02 * Math.sin((i + s) / 37)); };
    const bar = (sym, t, unit, open) => {
      const i = indexOf(unit, t), o = pxAt(sym, i), c0 = open ? o * 1.5 : pxAt(sym, i + 1);
      return { t, o, h: Math.max(o, c0) * 1.002, l: Math.min(o, c0) * 0.998, c: c0, v: 1000 + (i % 97) };
    };
    /** Newest first: up to n bars opening before `before` (exclusive), starting at the forming bar (flagged open). */
    const barsBefore = (sym, unit, before, n) => {
      const forming = formingOf(unit);
      const out = [];
      let t = before > forming ? forming : formingOf(unit, before) === before ? prevEdge(unit, before) : formingOf(unit, before);
      for (; out.length < n && t > forming - 5000 * 864e5; t = prevEdge(unit, t)) out.push(bar(sym, t, unit, t === forming));
      return out;
    };
    const served = { okx: 0, "okx-perp": 0, coinbase: 0, upbit: 0 };
    const unknown = [];
    const OKX_SPOT = ["BTC", "ETH", "SOL", "XRP", "OKB"];
    const OKX_SWAP = ["BTC", "ETH", "SOL", "XRP", "AVAX"];
    const okxEnv = (data) => ({ code: "0", msg: "", data }); // OKX v5 envelope [envelope from OKX docs; probe recorded data rows]
    await c.route(/^https:\/\/www\.okx\.com\//, (route) => {
      const u = new URL(route.request().url());
      const q = (k) => u.searchParams.get(k);
      const json = (b) => route.fulfill({ status: 200, headers: cors, body: JSON.stringify(b) });
      if (u.pathname === "/api/v5/market/tickers") {
        const swap = q("instType") === "SWAP";
        return json(okxEnv((swap ? OKX_SWAP : OKX_SPOT).map((b, i) => ({
          instId: swap ? `${b}-USDT-SWAP` : `${b}-USDT`, last: "101", open24h: "100", high24h: "102", low24h: "99",
          // SPOT volCcy24h is quote volume; SWAP volCcy24h is base coin (probe).
          vol24h: String(swap ? (1e9 - i) / 101 / 0.01 : (1e9 - i) / 101), volCcy24h: String(swap ? (1e9 - i) / 101 : 1e9 - i), ts: String(Date.now()),
        }))));
      }
      if (u.pathname === "/api/v5/public/instruments") {
        return json(okxEnv(OKX_SWAP.map((b) => ({ instId: `${b}-USDT-SWAP`, ctType: "linear", ctVal: "0.01", ctValCcy: b, settleCcy: "USDT", state: "live" }))));
      }
      if (u.pathname === "/api/v5/market/candles" || u.pathname === "/api/v5/market/history-candles") {
        const step = STEP[q("bar")];
        if (!step) return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ code: "51000", msg: "Parameter bar error", data: [] }) });
        const swap = /-SWAP$/.test(q("instId") || "");
        const after = q("after") ? Number(q("after")) : Infinity; // strictly older than `after` (probe)
        const rows = barsBefore(q("instId"), step, after, Math.min(300, Number(q("limit") || 100)));
        served[swap ? "okx-perp" : "okx"] += rows.filter((r) => r.t === formingOf(step)).length;
        // [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]: SPOT vol is base; SWAP vol is contracts (ctVal 0.01), volCcy base.
        return json(okxEnv(rows.map((r) => [String(r.t), String(r.o), String(r.h), String(r.l), String(r.c),
          String(swap ? r.v / 0.01 : r.v), String(swap ? r.v : r.v * r.c), String(r.v * r.c), r.t === formingOf(step) ? "0" : "1"])));
      }
      if (u.pathname === "/api/v5/market/books") {
        return json(okxEnv([{ asks: [["101.1", "50", "0", "1"], ["101.2", "100", "0", "2"]], bids: [["100.9", "50", "0", "1"], ["100.8", "100", "0", "2"]], ts: String(Date.now()) }]));
      }
      unknown.push(u.host + u.pathname);
      return route.fulfill({ status: 404, headers: cors, body: JSON.stringify({ code: "404", msg: "not mocked" }) });
    });
    const CB = ["BTC", "ETH", "SOL", "XRP", "LTC"];
    await c.route(/^https:\/\/api\.exchange\.coinbase\.com\//, (route) => {
      const u = new URL(route.request().url());
      const json = (b) => route.fulfill({ status: 200, headers: cors, body: JSON.stringify(b) });
      if (u.pathname === "/products") {
        // BTC-USDC is delisted with trading disabled (probe): never offered.
        return json([...CB.map((b) => ({ id: `${b}-USD`, base_currency: b, quote_currency: "USD", status: "online", trading_disabled: false })),
          { id: "BTC-USDC", base_currency: "BTC", quote_currency: "USDC", status: "delisted", trading_disabled: true }]);
      }
      if (u.pathname === "/products/stats") {
        return json(Object.fromEntries(CB.map((b, i) => [`${b}-USD`, { stats_24hour: { open: "100", high: "102", low: "99", last: "101", volume: String((1e9 - i) / 101) } }])));
      }
      const candles = u.pathname.match(/^\/products\/([A-Z0-9-]+)\/candles$/);
      if (candles) {
        const g = Number(u.searchParams.get("granularity")) * 1000;
        const start = Date.parse(u.searchParams.get("start")), end = Date.parse(u.searchParams.get("end"));
        const forming = formingOf(g);
        // start and end are inclusive (controller live check, 15 Nov 2026). The newest window runs on to the forming
        // bar (and, for 4h and longer, the closed base bars of the bucket still forming), so the app must drop both.
        const top = end >= forming - 32 * g ? forming : end;
        const rows = barsBefore(candles[1], g, top + g, Math.round((top - start) / g) + 1).filter((r) => r.t >= start);
        served.coinbase += rows.filter((r) => r.t === forming).length;
        // [time (s), LOW, HIGH, open, close, volume] — low before high (probe).
        return json(rows.map((r) => [r.t / 1000, r.l, r.h, r.o, r.c, r.v]));
      }
      if (/^\/products\/[A-Z0-9-]+\/book$/.test(u.pathname)) {
        return json({ bids: [["100.9", "50", 1], ["100.8", "100", 2]], asks: [["101.1", "50", 1], ["101.2", "100", 2]], sequence: 1 });
      }
      unknown.push(u.host + u.pathname);
      return route.fulfill({ status: 404, headers: cors, body: JSON.stringify({ message: "not mocked" }) });
    });
    // Upbit: the page must use the same-origin /x/upbit rewrite only (EX-6); the real host is aborted and logged.
    const upbitDirect = [];
    const upbitProxied = [];
    await c.route(/^https:\/\/api\.upbit\.com\//, (route) => { upbitDirect.push(route.request().url()); return route.abort(); });
    const UP = ["BTC", "ETH", "XRP", "SOL", "SAND"];
    await c.route(/\/x\/upbit\/v1\//, (route) => {
      const u = new URL(route.request().url());
      upbitProxied.push(u.pathname);
      const path0 = u.pathname.replace(/^\/x\/upbit/, "");
      const json = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
      if (path0 === "/v1/market/all") return json([...UP.map((b) => ({ market: `KRW-${b}` })), { market: "KRW-USDT" }, { market: "USDT-BTC" }]);
      if (path0 === "/v1/ticker/all") {
        const t = (market, price, vol) => ({ market, opening_price: price / 1.01, trade_price: price, prev_closing_price: price / 1.01, signed_change_rate: 0.01, acc_trade_price_24h: vol, timestamp: Date.now() });
        // KRW-USDT 1377 (controller live probe, 15 Nov 2026) converts KRW volume to USD for the liquidity floor.
        return json([...UP.map((b, i) => t(`KRW-${b}`, 101, 1e12 - i * 1e9)), t("KRW-USDT", 1377, 5e11), t("USDT-BTC", 65000, 1e7)]);
      }
      const minutes = path0.match(/^\/v1\/candles\/minutes\/(\d+)$/);
      const step = minutes ? MIN[minutes[1]] : { "/v1/candles/days": 864e5, "/v1/candles/weeks": "W", "/v1/candles/months": "M" }[path0];
      if (step) {
        const market = u.searchParams.get("market") || "KRW-X";
        const to = u.searchParams.get("to") ? Date.parse(u.searchParams.get("to")) : Infinity;
        const count = Math.min(200, Number(u.searchParams.get("count") || 1));
        const forming = formingOf(step);
        // `to` is exclusive (docs); the newest page also carries the forming bar as its first row (no flag).
        const closed = barsBefore(market, step, Math.min(to, forming), count);
        const rows = to >= forming ? [bar(market, forming, step, true), ...closed.slice(0, count - 1)] : closed;
        served.upbit += rows.filter((r) => r.t === forming).length;
        return json(rows.map((r) => ({
          market, candle_date_time_utc: new Date(r.t).toISOString().slice(0, 19), opening_price: r.o, high_price: r.h, low_price: r.l, trade_price: r.c,
          timestamp: r.t === forming ? Date.now() : r.t + 1000, candle_acc_trade_price: r.v * r.c, candle_acc_trade_volume: r.v, ...(minutes ? { unit: Number(minutes[1]) } : {}),
        })));
      }
      if (path0 === "/v1/orderbook") {
        const market = u.searchParams.get("markets") || "KRW-X";
        return json([{ market, timestamp: Date.now(), orderbook_units: [{ ask_price: 101.1, bid_price: 100.9, ask_size: 50, bid_size: 50 }, { ask_price: 101.2, bid_price: 100.8, ask_size: 100, bid_size: 100 }] }]);
      }
      unknown.push(u.pathname);
      return route.fulfill({ status: 404, contentType: "text/html", body: "<html>Not found</html>" });
    });
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    await waitRows(p);
    const ledgerRows = (src) => p.evaluate((s) => new Promise((resolve) => {
      const req = indexedDB.open("rsl-conf-ledger");
      req.onerror = () => resolve([]);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("ledger")) { db.close(); return resolve([]); }
        const all = db.transaction("ledger", "readonly").objectStore("ledger").getAll();
        all.onsuccess = () => { db.close(); resolve(all.result.filter((d) => d && d.src === s).flatMap((d) => (d.rows ?? []).map((r) => ({ t: r.t, tc: r.tc, rec: r.rec, pair: r.pair })))); };
        all.onerror = () => { db.close(); resolve([]); };
      };
    }), src);
    const venues = [
      { id: "EX-1", src: "okx", label: "OKX Spot", marker: "OKB" },
      { id: "EX-2", src: "okx-perp", label: "OKX Perpetual", marker: "AVAX" },
      { id: "EX-3", src: "coinbase", label: "Coinbase (US)", marker: "LTC" },
      { id: "EX-4", src: "upbit", label: "Upbit (KR)", marker: "SAND" },
    ];
    for (const v of venues) {
      const proxiedBefore = upbitProxied.length;
      const t0 = Date.now();
      await p.locator('header [role="combobox"]').nth(1).click();
      await p.getByRole("option", { name: v.label, exact: true }).click();
      // The previous source's rows stay until this scan is scored: wait for this venue's own pair, then for rest.
      await p.waitForFunction((m) => document.querySelector("tbody")?.textContent?.includes(m) && !document.querySelector('[data-testid="scan-progress"]'), v.marker, { timeout: 120000, polling: 250 }).catch(() => null);
      const rows = await p.locator("tbody tr:has(td button)").count();
      const step = 144e5; // default timeframe 4h
      // The detail chart's newest candle (the readout shows it at rest) must be the last CLOSED 4 h bar.
      let readout = "", expected = [];
      const btc = p.getByRole("button", { name: /^BTC/ }).first();
      if (await btc.count()) {
        await btc.click();
        await p.getByTestId("chart-readout").waitFor({ timeout: 20000 }).catch(() => null);
        readout = ((await p.getByTestId("chart-readout").locator("span").first().textContent().catch(() => "")) ?? "").trim();
        // Same formatter as the chart (price-chart.tsx fmtTime) in the page's own locale data; either side of a 4 h edge.
        expected = await p.evaluate((ts) => ts.map((t) => new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })), [formingOf(step, t0) - step, formingOf(step) - step]);
        await p.keyboard.press("Escape");
        await p.locator('[role="dialog"]').waitFor({ state: "detached", timeout: 10000 }).catch(() => null);
      }
      // No row is scored from the open bar: every ledger row this source wrote is a closed bar (t ≤ last closed, closed before it was recorded).
      let led = [];
      for (let i = 0; i < 20 && !led.length; i++) { led = await ledgerRows(v.src); if (!led.length) await p.waitForTimeout(500); }
      const openRows = led.filter((r) => r.t >= formingOf(step, r.rec) || r.tc > r.rec);
      const tooNew = led.filter((r) => r.t > formingOf(step) - step);
      record(v.id, `${v.label}: the scan completes with ≥ 3 rows on mocked venue data; the detail chart ends on the last closed bar; no row is scored from the open bar`,
        rows >= 3 && expected.includes(readout) && led.length >= 3 && openRows.length === 0 && tooNew.length === 0 && served[v.src] > 0,
        { rows, readout, expected: expected[0], ledgerRows: led.length, openRows: openRows.length, tooNew: tooNew.length, openBarsServed: served[v.src] });
      if (v.src === "upbit") {
        const mine = upbitProxied.slice(proxiedBefore);
        record("EX-6", "Switching the source to Upbit (KR) requests only the same-origin /x/upbit/ relay, never https://api.upbit.com",
          upbitDirect.length === 0 && mine.some((x) => x.startsWith("/x/upbit/v1/candles/")) && mine.some((x) => x === "/x/upbit/v1/ticker/all"),
          `${mine.length} via /x/upbit, ${upbitDirect.length} direct`);
      }
    }
    if (unknown.length) console.log(`  note: unmocked venue paths ${[...new Set(unknown)].join(", ")}`);
    await c.close();
  }
  /* ===== v2.8 WP25: market radar (tab, panel, gating, alerts) — every radar host mocked, unmocked hosts logged ===== */
  /* acceptance-ids: RD-1, RD-2, RD-3, RD-4, RD-5, RD-6, RD-7, RD-8, RD-9 */
  {
    const shotDir = process.env.RD_SHOT_DIR || OUT;
    const radarContext = async (extra = {}, pre = null) => {
      const c = await newContext(browser, { viewport: { width: 1280, height: 800 }, reducedMotion: "reduce", serviceWorkers: "block", deviceScaleFactor: 1, ...extra });
      const st = await rdMock(c);
      if (pre) await pre(c); // e.g. context.routeWebSocket mocks: they must be in place before the page navigates
      const p = await c.newPage();
      await p.goto(BASE, { waitUntil: "domcontentloaded" });
      await completeFirstRun(p, { operator: "R" });
      await waitRows(p);
      return { c, p, st };
    };
    const radarHits = (st) => st.requests.filter((r) => RD_HOSTS.some((h) => r.startsWith(h)) || r.startsWith("api.exchange.coinbase.com/products/BTC-USD/ticker") || r.endsWith("/x/upbit/v1/ticker"));
    const unknownRadar = (st) => st.unknown.filter((h) => /binance|cftc|llama|coinbase|upbit|coins\.ph|bybit|bitget|okx/.test(h));
    const waitSections = (p) => p.waitForFunction(() =>
      ["positioning", "buyer", "regional", "institutions", "alerts"].every((id) => /^Updated /.test(document.querySelector(`[data-testid="radar-status-${id}"]`)?.textContent || "")), null, { timeout: 90000, polling: 300 });
    const panel = (p) => p.getByTestId("radar-panel");

    /* RD-1: at rest the tab exists and the panel is closed; no radar host is contacted without interaction */
    {
      const { c, p, st } = await radarContext();
      await p.waitForTimeout(4000);
      const geo = await p.evaluate(() => {
        const t = document.querySelector('[data-testid="radar-tab"]');
        const r = t?.getBoundingClientRect();
        return { tabs: document.querySelectorAll('[data-testid="radar-tab"]').length, inShell: !!t?.closest("header,main,footer"), parentIsBody: t?.parentElement === document.body, text: t?.textContent,
          right: r ? Math.round(innerWidth - r.right) : null, midY: r ? Math.round(r.top + r.height / 2) : null, vh: innerHeight };
      });
      const hits = radarHits(st);
      record("RD-1", "Radar tab at rest: one right-edge tab labelled Radar, centred vertically, outside header/main/footer, panel closed; with no interaction no request goes to fapi.binance.com, publicreporting.cftc.gov, stablecoins.llama.fi, the Coinbase ticker or the Upbit /v1/ticker (DS-1/DS-2 checked separately)",
        geo.tabs === 1 && !geo.inShell && geo.parentIsBody && geo.text === "Radar" && geo.right === 0 && Math.abs(geo.midY - geo.vh / 2) <= 2 && (await panel(p).count()) === 0 && hits.length === 0 && unknownRadar(st).length === 0,
        { geo, hits, unmockedRadarHosts: unknownRadar(st), otherUnmocked: [...new Set(st.unknown)].slice(0, 6) });
      await c.close();
    }

    /* RD-2: R opens, Esc closes, R ignored while typing, open state remembered, no transition when motion is reduced, right or bottom sheet by width */
    {
      const { c, p, st } = await radarContext();
      const filter = p.getByPlaceholder(/filter/i).first();
      await filter.click();
      await p.keyboard.type("r");
      const typed = await filter.inputValue();
      const ignoredWhileTyping = (await panel(p).count()) === 0 && typed === "r";
      await filter.fill("");
      // R is ignored while another dialog is open, and with a modifier key
      await p.getByRole("button", { name: /Signal ledger/ }).first().click();
      await p.locator('[role="dialog"]').first().waitFor({ timeout: 10000 });
      await p.keyboard.press("r");
      await p.waitForTimeout(300);
      const ignoredInDialog = (await panel(p).count()) === 0;
      await p.keyboard.press("Escape");
      await p.locator('[role="dialog"]').waitFor({ state: "detached", timeout: 10000 }).catch(() => null);
      await p.locator("body").click({ position: { x: 5, y: 400 } });
      await p.keyboard.press("Alt+r");
      await p.keyboard.press("Meta+r");
      await p.waitForTimeout(300);
      const ignoredWithModifier = (await panel(p).count()) === 0;
      const tabAttrs = await p.evaluate(() => { const t = document.querySelector('[data-testid="radar-tab"]'); return { name: t.getAttribute("aria-label"), controls: t.getAttribute("aria-controls"), expanded: t.getAttribute("aria-expanded") }; });
      await p.keyboard.press("r");
      await panel(p).waitFor({ timeout: 10000 });
      const desktop = await p.evaluate(() => { const el = document.querySelector('[data-testid="radar-panel"]'); const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        const hb = Math.round(document.querySelector("header").getBoundingClientRect().bottom);
        // every header control stays reachable: the element at the centre of the right-most header button is not inside the panel
        const btns = [...document.querySelectorAll("header button, header [role=combobox]")].filter((b) => b.getBoundingClientRect().width > 0);
        const last = btns.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0].getBoundingClientRect();
        const hit = document.elementFromPoint(Math.min(last.left + last.width / 2, innerWidth - 1), last.top + last.height / 2);
        return { side: el.getAttribute("data-side"), id: el.id, w: Math.round(r.width), rightGap: Math.round(innerWidth - r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), hb, vh: innerHeight, anim: cs.animationName, transProp: cs.transitionProperty, transDur: cs.transitionDuration,
          focusInside: el.contains(document.activeElement), labelledName: (document.getElementById(el.getAttribute('aria-labelledby') || '')?.textContent || '').trim(), tabCount: document.querySelectorAll('[data-testid="radar-tab"]').length, headerReachable: !!hit && !el.contains(hit) };
      });
      await p.keyboard.press("Escape");
      await panel(p).waitFor({ state: "detached", timeout: 10000 });
      const focusBack = await p.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "radar-tab", null, { timeout: 5000 }).then(() => true, () => false);
      await p.keyboard.press("r");
      await panel(p).waitFor({ timeout: 10000 });
      await p.reload({ waitUntil: "domcontentloaded" });
      await waitRows(p);
      const remembered = (await panel(p).count()) === 1 || (await panel(p).waitFor({ timeout: 8000 }).then(() => true, () => false));
      await p.setViewportSize({ width: 800, height: 700 });
      await p.waitForFunction(() => document.querySelector('[data-testid="radar-panel"]')?.getAttribute("data-side") === "bottom", null, { timeout: 8000 }).catch(() => null);
      const narrow = await p.evaluate(() => { const el = document.querySelector('[data-testid="radar-panel"]'); const r = el.getBoundingClientRect(); return { side: el.getAttribute("data-side"), w: Math.round(r.width), bottomGap: Math.round(innerHeight - r.bottom), h: Math.round(r.height), vh: innerHeight }; });
      record("RD-2", "R opens and Esc closes the panel; R is ignored while typing in the Filter field; the open state survives a reload; with reduced motion there is no slide transition; 800 px wide it is a bottom sheet (≤ 80 vh), 1280 px a 420 px right sheet below the header; opening moves focus into the panel, closing returns it to the tab; the tab is hidden while it is open",
        ignoredWhileTyping && ignoredInDialog && ignoredWithModifier && desktop.labelledName.length > 0 && /^Radar/.test(tabAttrs.name) && tabAttrs.controls === "radar-panel" && tabAttrs.expanded === "false"
          && desktop.side === "right" && desktop.id === "radar-panel" && desktop.w === 420 && desktop.rightGap === 0 && desktop.top === desktop.hb && desktop.bottom === desktop.vh && desktop.headerReachable
          && desktop.focusInside && desktop.tabCount === 0 && focusBack && remembered
          && desktop.anim === "none" && (desktop.transProp === "none" || desktop.transDur === "0s")
          && narrow.side === "bottom" && narrow.w === 800 && narrow.bottomGap === 0 && narrow.h <= Math.round(narrow.vh * 0.8) + 1,
        { ignoredWhileTyping, ignoredInDialog, ignoredWithModifier, tabAttrs, desktop, focusBack, remembered, narrow, unmockedRadarHosts: unknownRadar(st) });
      await c.close();
    }

    /* RD-3: opened with mocks, the five data sections show the fixtures' numbers and "Updated" */
    {
      const { c, p, st } = await radarContext();
      await p.locator("body").click({ position: { x: 5, y: 400 } });
      await p.keyboard.press("r");
      await panel(p).waitFor({ timeout: 10000 });
      await waitSections(p).catch(() => null);
      const text = async (id) => ((await p.getByTestId(id).first().textContent().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      const ev = {
        us: await text("radar-prem-us-value"), kr: await text("radar-prem-kr-value"), ph: await text("radar-prem-ph-value"), krNote: await text("radar-prem-kr-note"),
        cotDate: await text("radar-cot-BTC-date"), cotAm: await text("radar-cot-BTC-am"), cotLf: await text("radar-cot-BTC-lf"),
        funding: await text("radar-BTCUSDT-funding"), oi: await text("radar-BTCUSDT-oi"), ls: await text("radar-BTCUSDT-ls"), taker: await text("radar-BTCUSDT-taker"), basis: await text("radar-BTCUSDT-basis"),
        bars: await p.locator('[data-testid="radar-spark"] rect[data-bar]').count(), sessions: await text("radar-sessions"),
        supply: await p.locator('[data-testid="radar-alert"][data-code="SUPPLY_JUMP"]').first().textContent().catch(() => ""),
        status: await Promise.all(["positioning", "buyer", "regional", "institutions", "alerts"].map((id) => text(`radar-status-${id}`))),
      };
      const korea = ((RD_P * RD_KRW * 1.012) / (RD_KRW * RD_P) - 1) * 100; // 1.20
      await p.screenshot({ path: path.join(shotDir, "radar-desktop.png") });
      record("RD-3", "Radar open on mocked data: US premium +1.00 %, Korea formula value +1.20 %, PH +0.50 %, CFTC report date 3 Nov 2026 with net positions, futures positioning figures, 24 taker-share bars and the supply jump match the fixtures; each of the five data sections says Updated",
        /1\.00 %/.test(ev.us) && ev.kr.includes(`${korea.toFixed(2)} %`) && /0\.50 %/.test(ev.ph) && /USDT/.test(ev.krNote) && /won/.test(ev.krNote)
          && /3 Nov 2026|Nov 3, 2026/.test(ev.cotDate) && /published Friday/.test(ev.cotDate)
          && /long 3,100 · short 1,200 · net \+1,900 \(Δ \+400\)/.test(ev.cotAm) && /net -3,700 \(Δ -700\)/.test(ev.cotLf)
          && /-0\.0018 %/.test(ev.funding) && /93,828 BTC/.test(ev.oi) && /\+4\.\d\d %/.test(ev.oi) && /2\.92/.test(ev.ls) && /1\.11/.test(ev.taker) && /-0\.05 %/.test(ev.basis)
          && ev.bars === 24 && /Asia \d+ %/.test(ev.sessions) && /grew by/.test(ev.supply) && /5\s?(B|bn)/.test(ev.supply)
          && ev.status.every((s) => /^Updated /.test(s)),
        { ...ev, unmockedRadarHosts: unknownRadar(st) });
      await p.setViewportSize({ width: 800, height: 700 });
      await p.waitForFunction(() => document.querySelector('[data-testid="radar-panel"]')?.getAttribute("data-side") === "bottom", null, { timeout: 8000 }).catch(() => null);
      await p.waitForTimeout(300);
      await p.screenshot({ path: path.join(shotDir, "radar-narrow.png") });
      await c.close();
    }

    /* RD-4: key-gated rows, ETF CSV import totals, hostile CSV rejected */
    {
      const { c, p, st } = await radarContext();
      await p.locator("body").click({ position: { x: 5, y: 400 } });
      await p.keyboard.press("r");
      await panel(p).waitFor({ timeout: 10000 });
      await waitSections(p).catch(() => null);
      const txt = async (id) => ((await p.getByTestId(id).textContent().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      const live = await txt("radar-etf-live"), whale = await txt("radar-whale"), empty = await p.getByTestId("radar-etf-empty").count();
      await p.getByTestId("radar-etf-file").setInputFiles({ name: "etf.csv", mimeType: "text/csv", buffer: Buffer.from("date,issuer,flow_usd\n2026-11-10,IBIT,120000000\n2026-11-10,FBTC,-30000000\n2026-11-11,IBIT,50000000\n") });
      await p.getByTestId("radar-etf-result").waitFor({ timeout: 10000 });
      const ok = await txt("radar-etf-result");
      const days = await p.locator('[data-testid="radar-etf-day"]').allTextContents();
      await p.getByTestId("radar-etf-file").setInputFiles({ name: "bad.csv", mimeType: "text/csv", buffer: Buffer.from("date,issuer,flow_usd\n=cmd|' /C calc'!A0,IBIT,1\n2026-13-45,X,1\n2026-11-12,@evil,5\n2026-11-12,OK,abc\n") });
      await p.waitForFunction(() => /rejected/.test(document.querySelector('[data-testid="radar-etf-result"]')?.textContent || "") && /Imported 0 rows/.test(document.querySelector('[data-testid="radar-etf-result"]')?.textContent || ""), null, { timeout: 10000 }).catch(() => null);
      const bad = await txt("radar-etf-result");
      record("RD-4", "Live ETF flows and Large transfers say \"Available with a key on the desktop gateway\"; importing a sample ETF CSV shows the daily totals; a hostile CSV shows a rejected count and adds nothing",
        /^Live ETF flows — Available with a key on the desktop gateway$/.test(live) && /^Large transfers — Available with a key on the desktop gateway$/.test(whale) && empty === 1
          && /Imported 3 rows · 0 rejected · 0 duplicates/.test(ok) && days.length === 2 && /90m/i.test(days[1]) && /50m/i.test(days[0])
          && /Imported 0 rows · 4 rejected/.test(bad),
        { live, whale, ok, days, bad, unmockedRadarHosts: unknownRadar(st) });
      await c.close();
    }

    /* RD-5: Coinbase +1.5 % for 2 closed bars alerts, naming the venue, the threshold and a source link; 2 % clears it */
    {
      const { c, p, st } = await radarContext();
      await p.locator("body").click({ position: { x: 5, y: 400 } });
      await p.keyboard.press("r");
      await panel(p).waitFor({ timeout: 10000 });
      await waitSections(p).catch(() => null);
      const item = p.locator('[data-testid="radar-alert"][data-code="BREAKAWAY_COINBASE"]');
      await item.waitFor({ timeout: 30000 }).catch(() => null);
      const before = ((await item.textContent().catch(() => "")) || "").replace(/\s+/g, " ");
      const href = await item.getByTestId("radar-alert-source").getAttribute("href").catch(() => null);
      const thBefore = ((await item.getByTestId("radar-alert-threshold").textContent().catch(() => "")) || "").replace(/\s+/g, " ");
      await p.getByTestId("radar-thresholds").locator("summary").click();
      // typed with the keyboard, one key at a time: "2.5" must survive (the field is not remounted per key)
      const field = p.getByTestId("radar-th-breakAwayPct");
      await field.click();
      await p.keyboard.press("Control+A");
      await p.keyboard.type("2.5");
      const typed = await field.inputValue();
      const stillFocused = await p.evaluate(() => document.activeElement?.getAttribute("data-testid") === "radar-th-breakAwayPct");
      const stored = await p.evaluate(() => JSON.parse(localStorage.getItem("ct-radar-v1") || "{}").thresholds?.breakAwayPct);
      await item.waitFor({ state: "detached", timeout: 15000 }).catch(() => null);
      // an out-of-range value stays in the field, is marked invalid and is not stored
      await p.keyboard.press("Control+A");
      await p.keyboard.type("50");
      const invalid = { aria: await field.getAttribute("aria-invalid"), msg: ((await p.getByTestId("radar-th-breakAwayPct-msg").textContent().catch(() => "")) || "").trim(), min: await field.getAttribute("min"), max: await field.getAttribute("max"),
        stored: await p.evaluate(() => JSON.parse(localStorage.getItem("ct-radar-v1") || "{}").thresholds?.breakAwayPct) };
      await p.keyboard.press("Control+A");
      await p.keyboard.type("2");
      await p.keyboard.press("ArrowUp"); // arrow keys step without losing focus: 2 → 2.1
      const arrow = { value: await field.inputValue(), focused: await p.evaluate(() => document.activeElement?.getAttribute("data-testid") === "radar-th-breakAwayPct") };
      const cleared = (await item.count()) === 0;
      const none = await p.getByTestId("radar-alerts-none").count();
      const note = ((await p.getByTestId("radar-th-note").textContent().catch(() => "")) || "").replace(/\s+/g, " ");
      record("RD-5", "Fixtures with Coinbase +1.5 % for 2 closed bars raise an alert naming Coinbase, the threshold and a source link; raising the break-away threshold clears it at once with no request (thresholds labelled \"Starting values\"); the threshold field takes typed decimals (2.5), arrow keys and shows an invalid state out of range",
        /Coinbase/.test(before) && /\+1\.50 %/.test(before) && /1\.0 % for 2 closed 1h bars/.test(thBefore) && /^https:\/\//.test(href || "") && cleared && /^Starting values/.test(note)
          && typed === "2.5" && stillFocused && stored === 2.5 && invalid.aria === "true" && /0\.2 to 10/.test(invalid.msg) && invalid.min === "0.2" && invalid.max === "10" && invalid.stored === 5
          && arrow.value === "2.1" && arrow.focused,
        { before, thBefore, href, cleared, none, note, typed, stillFocused, stored, invalid, arrow, unmockedRadarHosts: unknownRadar(st) });
      await c.close();
    }

    /* RD-6: right-to-left (Arabic): the tab sits at the physical left, the sheet opens on the left below the header, the close button does not overlap the title */
    {
      const { c, p, st } = await radarContext();
      await p.getByRole("button", { name: /^Language:/ }).click();
      await p.locator("#rsl-lang-list [role=option]", { hasText: "العربية" }).click();
      await p.waitForFunction(() => document.documentElement.dir === "rtl" && document.documentElement.lang === "ar");
      await waitRows(p);
      await p.waitForTimeout(500);
      const closed = await p.evaluate(() => { const t = document.querySelector('[data-testid="radar-tab"]'); const r = t.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(innerWidth - r.right), label: t.getAttribute("aria-label"), text: t.textContent, midY: Math.round(r.top + r.height / 2), vh: innerHeight }; });
      await p.screenshot({ path: path.join(shotDir, "radar-rtl-closed.png") });
      await p.locator("body").click({ position: { x: 640, y: 700 } });
      await p.keyboard.press("r");
      await panel(p).waitFor({ timeout: 10000 });
      await p.waitForFunction(() => ["positioning", "buyer", "regional", "institutions", "alerts"].every((id) => (document.querySelector(`[data-testid="radar-status-${id}"]`)?.textContent || "").trim().length > 0), null, { timeout: 90000, polling: 300 }).catch(() => null);
      await p.waitForTimeout(400);
      const open = await p.evaluate(() => {
        const el = document.querySelector('[data-testid="radar-panel"]'); const r = el.getBoundingClientRect();
        const hb = Math.round(document.querySelector("header").getBoundingClientRect().bottom);
        const title = document.getElementById("radar-title"); const range = document.createRange(); range.selectNodeContents(title); const tr = range.getBoundingClientRect();
        const x = el.querySelector(":scope > button"); const xr = x.getBoundingClientRect();
        return { side: el.getAttribute("data-side"), left: Math.round(r.left), w: Math.round(r.width), top: Math.round(r.top), hb, titleRight: Math.round(tr.right), xLeft: Math.round(xr.left), xRight: Math.round(xr.right), xLabel: x.textContent, tabs: document.querySelectorAll('[data-testid="radar-tab"]').length };
      });
      await p.screenshot({ path: path.join(shotDir, "radar-rtl.png") });
      record("RD-6", "Arabic (right-to-left): the Radar tab sits at the physical left edge, vertically centred, its accessible name starting with the visible word; the sheet opens on the left below the header, the close button does not overlap the title, and the close label is translated",
        closed.left === 0 && closed.right > 100 && Math.abs(closed.midY - closed.vh / 2) <= 2 && closed.label.startsWith(closed.text.trim())
          && open.side === "left" && open.left === 0 && open.w === 420 && open.top === open.hb && open.titleRight <= open.xLeft && open.xLabel.trim() === "إغلاق رادار السوق" && open.tabs === 0,
        { closed, open, unmockedRadarHosts: unknownRadar(st) });
      await c.close();
    }

    /* RD-7: Record radar context. Off (default): after scans there is no radar host request and every ledger row has rad null.
       On (panel closed): the radar hosts are requested and rows recorded afterwards carry rad (newest logged context at or before the bar close, at most 2 h old).
       The context log entry just before the bar close is written into the device's log first: a real entry is made at the moment recording is switched on,
       i.e. after the newest closed bar, and a row never takes a later one (no look-ahead), so a test cannot wait for the next bar close. */
    {
      const ledgerRows = (p, tf) => p.evaluate((frame) => new Promise((resolve) => {
        const req = indexedDB.open("rsl-conf-ledger");
        req.onerror = () => resolve([]);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("ledger")) { db.close(); return resolve([]); }
          const all = db.transaction("ledger", "readonly").objectStore("ledger").getAll();
          all.onsuccess = () => { db.close(); resolve(all.result.flatMap((d) => (d && d.rows) || []).filter((r) => r.tf === frame && r.src === "binance").map((r) => ({ pair: r.pair, t: r.t, tc: r.tc, rad: r.rad === undefined ? "absent" : r.rad }))); };
          all.onerror = () => { db.close(); resolve([]); };
        };
      }), tf);
      const waitLedger = async (p, tf) => { let rows = []; for (let i = 0; i < 80 && rows.length < 3; i++) { rows = await ledgerRows(p, tf); if (rows.length < 3) await p.waitForTimeout(500); } return rows; };
      const toHourly = async (p) => {
        await p.getByRole("combobox", { name: "Timeframe" }).click();
        await p.getByRole("option", { name: "1 hour", exact: true }).click();
      };
      const seedLog = (p, entry) => p.evaluate((e) => new Promise((resolve) => {
        const req = indexedDB.open("rsl-conf");
        req.onerror = () => resolve(false);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("meta")) { db.close(); return resolve(false); }
          const id = `radar-log-${new Date(e.t).toISOString().slice(0, 10)}`;
          const tx = db.transaction("meta", "readwrite"); const store = tx.objectStore("meta");
          const g = store.get(id);
          g.onsuccess = () => {
            const doc = g.result && Array.isArray(g.result.entries) ? g.result : { day: id.slice(10), entries: [] };
            doc.entries.push(e); doc.entries.sort((a, b) => a.t - b.t);
            store.put(doc, id);
          };
          tx.oncomplete = () => { db.close(); resolve(true); };
          tx.onerror = () => { db.close(); resolve(false); };
        };
      }), entry);
      const radarFetched = (st) => radarHits(st).filter((r) => r.startsWith("fapi.binance.com/fapi/v1/premiumIndex") || r.startsWith("stablecoins.llama.fi/") || r.startsWith("publicreporting.cftc.gov/"));

      /* off (the default) */
      const off = await radarContext();
      const offDefault = await off.p.getByRole("button", { name: /^Scoring profile/ }).click().then(() => off.p.locator('[data-testid="record-radar"]').isChecked());
      await off.p.getByRole("button", { name: /^Scoring profile/ }).click();
      const off4 = await waitLedger(off.p, "4h");
      await toHourly(off.p);
      const off1 = await waitLedger(off.p, "1h");
      await off.p.waitForTimeout(3000);
      const offHits = radarHits(off.st);
      await off.c.close();

      /* on, panel closed */
      const on = await radarContext();
      const on4 = await waitLedger(on.p, "4h"); // recorded before the setting was on: no rad
      await on.p.getByRole("button", { name: /^Scoring profile/ }).click();
      await on.p.locator('[data-testid="record-radar"]').check();
      await on.p.getByRole("button", { name: /^Scoring profile/ }).click();
      const panelClosed = (await panel(on.p).count()) === 0;
      let fetched = [];
      for (let i = 0; i < 120 && fetched.length < 3; i++) { fetched = radarFetched(on.st); if (fetched.length < 3) await on.p.waitForTimeout(500); }
      const tc1h = Math.floor(Date.now() / 36e5) * 36e5;
      const seedT = tc1h - 60e3;
      const seeded = await seedLog(on.p, { t: seedT, frp: 77.7, oi24: 1.5, ls: 1.2, tk: 0.52, usP: 0.1, krP: 0.2, phP: 0.3, al: ["BREAKAWAY_COINBASE"] });
      await toHourly(on.p);
      const on1 = await waitLedger(on.p, "1h");
      const radOn = on1.map((r) => r.rad);
      const okRad = (r) => r && typeof r === "object" && r.t <= on1[0].tc && on1[0].tc - r.t <= 2 * 36e5 && r.frp >= 0 && r.frp <= 100 && Array.isArray(r.al);
      await on.c.close();

      record("RD-7", "Record radar context: off by default, after scans there is no radar host request and every ledger row has rad null; switched on (panel closed) the radar hosts are requested and rows recorded afterwards carry rad - the newest logged context at or before the bar close, at most 2 h old (the one just before the close here) - while rows recorded earlier keep rad null",
        offDefault === false && off4.length >= 3 && off1.length >= 3 && off4.concat(off1).every((r) => r.rad === null) && offHits.length === 0 && unknownRadar(off.st).length === 0
          && on4.length >= 3 && on4.every((r) => r.rad === null) && panelClosed && fetched.length >= 3 && seeded
          && on1.length >= 3 && radOn.every(okRad) && radOn.every((r) => r.t === seedT ? r.frp === 77.7 && r.al.join() === "BREAKAWAY_COINBASE" : true),
        { offDefault, off4: off4.length, off1: off1.length, offRad: [...new Set(off4.concat(off1).map((r) => JSON.stringify(r.rad)))], offHits, on4Rad: [...new Set(on4.map((r) => JSON.stringify(r.rad)))], panelClosed, fetched: fetched.slice(0, 4), seeded, on1: on1.length, radOn: radOn.slice(0, 2), seedT, unmocked: unknownRadar(on.st) });
    }

    /* RD-8: Step 4b live liquidation websockets (mocked with context.routeWebSocket, installed before navigation) */
    {
    const LIQ_WS = /^wss:\/\/(fstream\.binance\.com|stream\.bybit\.com)\//;
    const liqHost = (u) => (/fstream\.binance\.com/.test(u) ? "binance" : /stream\.bybit\.com/.test(u) ? "bybit" : null);
    const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
    const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return !!(await fn()); };
    const seen = { calls: [], connects: { bybit: 0, binance: 0 }, firstAt: null, closed: {}, subscribes: [] };
    const mockSockets = (c) => c.routeWebSocket(LIQ_WS, (ws) => {
      const url = ws.url();
      const host = liqHost(url);
      seen.calls.push(url);
      seen.connects[host]++;
      if (seen.firstAt === null) seen.firstAt = Date.now();
      ws.onClose(() => { seen.closed[host] = Date.now(); });
      const now = Date.now();
      if (host === "bybit") {
        ws.onMessage((m) => {
          let msg; try { msg = JSON.parse(String(m)); } catch { return; }
          if (msg.op === "subscribe") {
            seen.subscribes.push(msg.args);
            ws.send(JSON.stringify({ success: true, ret_msg: "", conn_id: "rd8", op: "subscribe" }));
            const t = Date.now();
            ws.send(JSON.stringify({ topic: "allLiquidation.BTCUSDT", type: "snapshot", ts: t, data: [{ T: t, s: "BTCUSDT", S: "Buy", v: "2", p: "50000" }] }));
          } else if (msg.op === "ping") ws.send(JSON.stringify({ op: "pong", ret_msg: "pong" }));
        });
      } else {
        setTimeout(() => { const t = Date.now(); try { ws.send(JSON.stringify({ e: "forceOrder", E: t, o: { s: "ETHUSDT", S: "SELL", z: "3", ap: "1000", T: t } })); } catch { /* closed */ } }, 500);
      }
    });
    const txt = async (p, id) => ((await p.getByTestId(id).first().textContent({ timeout: 500 }).catch(() => "")) || "").replace(/\s+/g, " ").trim();

    /* (a) at rest: no socket attempt to either host, after a scan */
    const rest = { handler: [], pageSockets: [] };
    const a = await radarContext({}, (c) => c.routeWebSocket(LIQ_WS, (ws) => { rest.handler.push(ws.url()); }));
    a.p.on("websocket", (w) => rest.pageSockets.push(w.url()));
    await a.p.waitForTimeout(4000);
    const restHits = rest.handler.concat(rest.pageSockets).filter((u) => LIQ_WS.test(u));
    await a.c.close();

    /* (b) open with mocked streams, (c) close */
    const b = await radarContext({}, mockSockets);
    const pageSockets = [];
    b.p.on("websocket", (w) => pageSockets.push(w.url()));
    await b.p.locator("body").click({ position: { x: 5, y: 400 } });
    await b.p.keyboard.press("r");
    await b.p.getByTestId("radar-panel").waitFor({ timeout: 10000 });
    const rowsShown = await waitFor(async () => /long (US)?\$100(K|k|,000)/.test(await txt(b.p, "radar-liq-bybit-row")) && /long (US)?\$3(K|k|,000)\b/.test(await txt(b.p, "radar-liq-binance-row")), 40000);
    const rowsMs = Date.now() - seen.firstAt; // from the first socket connection to both rows showing
    const ev = {
      bybit: await txt(b.p, "radar-liq-bybit-row"), binance: await txt(b.p, "radar-liq-binance-row"),
      binanceSampled: await b.p.getByTestId("radar-liq-binance-sampled").count(), bybitSampled: await b.p.getByTestId("radar-liq-bybit-sampled").count(),
      bybitCascade: await txt(b.p, "radar-liq-bybit-cascade"), binanceCascade: await txt(b.p, "radar-liq-binance-cascade"),
    };
    const opened = { urls: seen.calls.slice(), subscribes: seen.subscribes.slice() };
    await b.p.screenshot({ path: path.join(process.env.RD_SHOT_DIR || OUT, "radar-liquidations.png") }).catch(() => null);
    // Precondition for (c): both sockets are open (connected once, not closed) right before Escape.
    const preOpen = { bybit: seen.connects.bybit === 1 && !seen.closed.bybit, binance: seen.connects.binance === 1 && !seen.closed.binance };
    const t0 = Date.now();
    await b.p.keyboard.press("Escape");
    const bothClosed = await waitFor(async () => !!seen.closed.bybit && !!seen.closed.binance, 2000);
    const closeMs = Date.now() - t0;
    const closedAfterEsc = !!seen.closed.bybit && !!seen.closed.binance && seen.closed.bybit >= t0 && seen.closed.binance >= t0;
    const oneConnection = seen.connects.bybit === 1 && seen.connects.binance === 1; // no reconnect for either host
    const closed = preOpen.bybit && preOpen.binance && bothClosed && closedAfterEsc && oneConnection;
    await b.c.close();

    record("RD-8", "Liquidations: no websocket at rest; open with mocked Bybit/Binance streams shows last-hour long/short per venue (Binance labelled sampled) and the cascade baseline as collecting; closing the panel closes both sockets",
      restHits.length === 0 && rowsShown && rowsMs <= 4000 && /^Bybit: long (US)?\$100(K|k|,000) · short (US)?\$0/.test(ev.bybit) && /^Binance: long (US)?\$3(K|k|,000) · short (US)?\$0/.test(ev.binance)
        && ev.binanceSampled === 1 && ev.bybitSampled === 0
        && /collecting the baseline \(0 of 720 hours/.test(ev.bybitCascade) && /collecting the baseline \(0 of 720 hours/.test(ev.binanceCascade)
        && opened.urls.some((u) => /fstream\.binance\.com\/market\/ws\/!forceOrder@arr/.test(u)) && opened.urls.some((u) => /stream\.bybit\.com\/v5\/public\/linear/.test(u))
        && opened.subscribes.some((s) => Array.isArray(s) && s.includes("allLiquidation.BTCUSDT") && s.includes("allLiquidation.ETHUSDT"))
        && closed,
      { restHits, ...ev, opened, rowsMs, preOpen, connects: seen.connects, closed, closeMs });
    }

    /* RD-9: Step 4b provider keys through a mocked gateway (page.route on http://127.0.0.1:8787): connect, no key in browser storage, live ETF flows, large transfer alert, 401 */
    {
    const GW = /^http:\/\/127\.0\.0\.1:8787\//;
    const KEY_WHALE = "FAKE-WHALE-KEY-5b1e9d27c4a8f3", KEY_CG = "FAKE-COINGLASS-KEY-7d3a1c9e6b20f5";
    const gw = { profiles: [], calls: [], bodies: [], unauth: false, bad: [] };
    const NOW0 = Date.now();
    const isoDay = (back) => new Date(NOW0 - back * RD_D).toISOString().slice(0, 10);
    const etfBody = () => ({
      asOf: Date.now(),
      btc: [3, 2, 1].map((b, i) => ({ date: isoDay(b), flows: [{ ticker: "IBIT", flowUsd: 300e6 + i * 1e6 }, { ticker: "FBTC", flowUsd: 100e6 }] })),
      eth: [3, 2, 1].map((b) => ({ date: isoDay(b), flows: [{ ticker: "ETHA", flowUsd: 30e6 }, { ticker: "FETH", flowUsd: -10e6 }] })),
    });
    const whaleBody = () => ({
      connected: true,
      alerts: [
        { t: Date.now() - 5 * 60_000, chain: "bitcoin", kind: "transfer", from: "Coinbase", to: "unknown wallet", symbol: "BTC", amount: 380, valueUsd: 25e6, hash: "aa11" },
        { t: Date.now() - 8 * 60_000, chain: "ethereum", kind: "transfer", from: "Kraken", to: "Binance", symbol: "ETH", amount: 700, valueUsd: 2e6, hash: "bb22" },
      ],
    });
    const mockGateway = async (c) => {
      await c.route(GW, async (route) => {
        const req = route.request();
        const u = new URL(req.url());
        const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", "content-type": "application/json" };
        const reply = (status, b) => route.fulfill({ status, headers: cors, body: JSON.stringify(b) });
        if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
        gw.calls.push(`${req.method()} ${u.pathname}${u.search}`);
        if (req.headers().authorization !== "Bearer fixture-token") { gw.bad.push(u.pathname); return reply(401, { error: "unauthorized" }); }
        if (gw.unauth && /^\/providers\/(etf-flows|whale-alerts)/.test(u.pathname)) return reply(401, { error: "unauthorized" });
        if (u.pathname === "/health") return reply(200, { ok: true, service: "rsl-gateway", profiles: 0 });
        if (u.pathname === "/profiles") return reply(200, { profiles: [] });
        if (u.pathname === "/providers/connect" && req.method() === "POST") {
          const b = JSON.parse(req.postData() || "{}");
          gw.bodies.push(b);
          const profile = { id: `prov-${gw.profiles.length + 1}`, kind: "provider", provider: b.provider, label: String(b.label || b.provider), maskedKey: "FAKE…" + String(b.apiKey).slice(-4), connectedAt: new Date().toISOString() };
          gw.profiles.push(profile);
          return reply(200, { profile });
        }
        if (u.pathname === "/providers" && req.method() === "GET") return reply(200, { profiles: gw.profiles });
        if (u.pathname === "/providers/etf-flows") return reply(200, etfBody());
        if (u.pathname === "/providers/whale-alerts") return reply(200, whaleBody());
        return reply(404, { error: "not found" });
      });
    };
    const dumpStorage = (p) => p.evaluate(async () => {
      const out = { local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }), idb: [], stores: 0 };
      const dbs = indexedDB.databases ? await indexedDB.databases() : [];
      for (const d of dbs) {
        await new Promise((done) => {
          const rq = indexedDB.open(d.name);
          rq.onerror = () => done();
          rq.onsuccess = () => {
            const db = rq.result;
            const names = [...db.objectStoreNames];
            if (!names.length) { db.close(); done(); return; }
            const tx = db.transaction(names, "readonly");
            let left = names.length;
            const fin = () => { if (--left === 0) { db.close(); done(); } };
            for (const n of names) {
              const g = tx.objectStore(n).getAll();
              const k = tx.objectStore(n).getAllKeys();
              g.onsuccess = () => { out.stores++; try { out.idb.push(JSON.stringify({ db: d.name, store: n, rows: g.result })); } catch { /* unserialisable row */ } fin(); };
              g.onerror = fin;
              k.onsuccess = () => { try { out.idb.push(JSON.stringify({ db: d.name, store: n, keys: k.result })); } catch { /* skip */ } };
            }
          };
        });
      }
      return out;
    });
    const { c, p, st } = await radarContext({}, mockGateway);
    const flat = (s) => (s || "").replace(/[⁨⁩]/g, "").replace(/\s+/g, " ").trim();
    const txt = async (id) => flat(await p.getByTestId(id).first().textContent({ timeout: 500 }).catch(() => ""));
    // 1. header API button (Private API dialog): check the gateway, connect a Whale Alert key and a CoinGlass key
    await p.getByRole("button", { name: /Private API/ }).first().click();
    const dlg = p.getByRole("dialog");
    await dlg.waitFor({ timeout: 10000 });
    await dlg.locator("#gateway-token").fill("fixture-token");
    await dlg.getByRole("button", { name: "Check", exact: true }).click();
    await dlg.getByText("Gateway online").waitFor({ timeout: 10000 });
    await dlg.locator("#data-provider-key").fill(KEY_WHALE);
    await dlg.locator("#data-provider-label").fill("Whale");
    await dlg.getByRole("button", { name: "Connect", exact: true }).last().click();
    await dlg.getByLabel("Connected data providers").getByText("Whale", { exact: true }).waitFor({ timeout: 10000 });
    const whaleFieldEmpty = (await dlg.locator("#data-provider-key").inputValue()) === "";
    await dlg.locator("#data-provider").click();
    await p.getByRole("option", { name: /CoinGlass/ }).click();
    await dlg.locator("#data-provider-label").fill("Glass");
    await dlg.locator("#data-provider-key").fill(KEY_CG);
    await dlg.getByRole("button", { name: "Connect", exact: true }).last().click();
    await dlg.getByLabel("Connected data providers").getByText("Glass", { exact: true }).waitFor({ timeout: 10000 });
    const cgFieldEmpty = (await dlg.locator("#data-provider-key").inputValue()) === "";
    const dialogHtml = await dlg.innerHTML();
    const dataCallsBeforeOpen = gw.calls.filter((x) => /\/providers\/(etf-flows|whale-alerts)/.test(x)).length;
    await p.keyboard.press("Escape");
    await dlg.waitFor({ state: "hidden", timeout: 5000 }).catch(() => null);
    // 2. open the radar: live ETF flows, the large transfer and its alert
    await p.locator("body").click({ position: { x: 5, y: 400 } });
    await p.keyboard.press("r");
    await panel(p).waitFor({ timeout: 10000 });
    await waitSections(p).catch(() => null);
    await p.getByTestId("radar-whale-row").first().waitFor({ timeout: 20000 }).catch(() => null);
    await p.getByTestId("radar-etf-live-btc").waitFor({ timeout: 20000 }).catch(() => null);
    const btcDays = (await p.locator('[data-testid="radar-etf-live-btc"] [data-testid="radar-etf-live-day"]').evaluateAll((els) => els.map((e) => ({ date: e.getAttribute("data-date"), total: e.querySelector('[data-testid="radar-etf-live-total"]')?.textContent || "", tickers: [...e.querySelectorAll("li span.font-mono")].map((x) => x.textContent) }))));
    const ethDays = (await p.locator('[data-testid="radar-etf-live-eth"] [data-testid="radar-etf-live-day"]').evaluateAll((els) => els.map((e) => ({ date: e.getAttribute("data-date"), total: e.querySelector('[data-testid="radar-etf-live-total"]')?.textContent || "" }))));
    const whaleRows = (await p.getByTestId("radar-whale-row").allTextContents()).map(flat);
    const alertText = flat(await p.locator('[data-testid="radar-alert"][data-code="WHALE_TRANSFER"]').first().textContent({ timeout: 500 }).catch(() => ""));
    const etfTitle = await txt("radar-etf-live");
    const whaleMinInput = await p.getByTestId("radar-th-whaleMinUsd").count();
    const dataCalls = gw.calls.filter((x) => /\/providers\/(etf-flows|whale-alerts)/.test(x));
    await p.screenshot({ path: path.join(shotDir, "radar-providers.png") }).catch(() => null);
    // 3. no key in any browser storage, in a URL, in the page or in the dialog markup
    const dump = await dumpStorage(p);
    const everything = [dump.local, dump.session, ...dump.idb].join("\n");
    const pageText = await p.evaluate(() => document.body.innerText + document.documentElement.outerHTML);
    const keyHits = [KEY_WHALE, KEY_CG].filter((k) => everything.includes(k) || pageText.includes(k) || dialogHtml.includes(k) || gw.calls.some((x) => x.includes(k)));
    const keysSent = gw.bodies.length === 2 && gw.bodies[0].apiKey === KEY_WHALE && gw.bodies[1].apiKey === KEY_CG;
    // 4. the next refresh gets a 401: the reconnect line shows in both rows, the other sections keep updating
    gw.unauth = true;
    await p.keyboard.press("Escape");
    await panel(p).waitFor({ state: "hidden", timeout: 5000 }).catch(() => null);
    await p.keyboard.press("r");
    await panel(p).waitFor({ timeout: 10000 });
    await p.getByTestId("radar-whale-lost").waitFor({ timeout: 30000 }).catch(() => null);
    await waitSections(p).catch(() => null);
    const lostWhale = await txt("radar-whale-lost"), lostEtf = await txt("radar-etf-live-lost");
    const statuses = await Promise.all(["positioning", "buyer", "regional", "institutions", "alerts"].map((id) => txt(`radar-status-${id}`)));
    const alertsAfter = await p.locator('[data-testid="radar-alert"][data-code="WHALE_TRANSFER"]').count();
    await p.screenshot({ path: path.join(shotDir, "radar-providers-401.png") }).catch(() => null);
    record("RD-9", "Provider keys: CoinGlass and Whale Alert connect through the mocked gateway, the key field is cleared and no browser storage holds the key; the panel shows live BTC/ETH ETF flows and a large transfer alert; a 401 shows the reconnect message and the rest of the radar keeps updating",
      whaleFieldEmpty && cgFieldEmpty && keysSent && gw.bad.length === 0 && dataCallsBeforeOpen === 0
        && keyHits.length === 0 && dump.stores > 0
        && /ETF flows \(CoinGlass, via your gateway\)/.test(etfTitle)
        && btcDays.length === 3 && btcDays[0].date === isoDay(1) && btcDays.map((d) => d.total.replace(/\s/g, "").toUpperCase()).join() === "+US$402M,+US$401M,+US$400M" && btcDays[0].tickers.includes("IBIT") && btcDays[0].tickers.includes("FBTC")
        && ethDays.length === 3 && ethDays.every((d) => d.total.replace(/\s/g, "").toUpperCase() === "+US$20M")
        && whaleRows.length === 1 && /380 BTC \(US\$25M\) · Coinbase → unknown wallet · bitcoin$/i.test(whaleRows[0])
        && /380 BTC \(US\$25M\) moved from Coinbase to unknown wallet on bitcoin\./i.test(alertText)
        && whaleMinInput === 1 && dataCalls.some((x) => x.includes("min=10000000"))
        && /The gateway did not accept the token\. Reconnect with the API button in the header\./.test(lostWhale) && /The gateway did not accept the token\. Reconnect with the API button in the header\./.test(lostEtf)
        && statuses.every((x) => /^Updated /.test(x)) && alertsAfter === 0,
      { whaleFieldEmpty, cgFieldEmpty, keysSent, bad: gw.bad, dataCallsBeforeOpen, keyHits: keyHits.length, stores: dump.stores, etfTitle, btcDays, ethDays, whaleRows, alertText, whaleMinInput, dataCalls: dataCalls.slice(0, 4), lostWhale, lostEtf, statuses, alertsAfter, unmockedRadarHosts: unknownRadar(st) });
    await c.close();
    }
  }
  /* ===== v2.8 WP29: Fear & Greed widget (collapsed chip, panel, fetch gate) — api.alternative.me mocked ===== */
  /* acceptance-ids: FG-1, FG-2 */
  {
    const DAY_S = 86400;
    const todayS = Math.floor(Date.now() / 86400e3) * DAY_S; // 00:00 UTC today, as the index publishes
    // 31 rows, newest first; newest 10 "Extreme Fear"; value and timestamp are digit strings, as in the live API.
    const fngRows = Array.from({ length: 31 }, (_, i) => {
      const value = i === 0 ? 10 : 20 + ((i * 7) % 60);
      const value_classification = value < 25 ? "Extreme Fear" : value < 45 ? "Fear" : value <= 55 ? "Neutral" : value <= 75 ? "Greed" : "Extreme Greed";
      return { value: String(value), value_classification, timestamp: String(todayS - i * DAY_S), ...(i === 0 ? { time_until_update: "37530" } : {}) };
    });
    const fngBody = JSON.stringify({ name: "Fear and Greed Index", data: fngRows, metadata: { error: null } });
    const fngContext = async (status = 200, body200 = fngBody) => {
      const c = await newContext(browser, { reducedMotion: "reduce", serviceWorkers: "block", deviceScaleFactor: 1 });
      const st = await rdMock(c);
      const hits = [];
      await c.route("https://api.alternative.me/fng/**", (route) => {
        hits.push(route.request().url());
        return route.fulfill({ status, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: status === 200 ? body200 : "oops" });
      });
      const p = await c.newPage();
      await p.goto(BASE, { waitUntil: "domcontentloaded" });
      await completeFirstRun(p, { operator: "R" });
      await waitRows(p);
      await p.waitForFunction(() => !document.querySelector("header div.h-full.bg-gradient-to-r"), null, { timeout: 30000 });
      return { c, p, st, hits };
    };
    const listTop = (p) => p.evaluate(() => Math.round(document.querySelector("main").getBoundingClientRect().top * 10) / 10);

    /* FG-1: at rest one collapsed chip ends the counts line; no panel; no request; the line did not grow or wrap */
    {
      const { c, p, hits } = await fngContext();
      await p.waitForTimeout(4000);
      const geo = await p.evaluate(() => {
        const toggles = [...document.querySelectorAll('[data-testid="fng-toggle"]')];
        const t = toggles[0];
        const row = t?.closest("div.border-t"); // the counts row: one wrapping row, the chip is its last item
        const chip = row?.firstElementChild; // the first StatChip
        const tr = t?.getBoundingClientRect(), rr = row?.getBoundingClientRect(), cr = chip?.getBoundingClientRect();
        const last = row ? [...row.children].filter((el) => getComputedStyle(el).display !== "none").pop() : null;
        return {
          toggles: toggles.length, expanded: t?.getAttribute("aria-expanded"), controls: t?.getAttribute("aria-controls"), text: t?.textContent?.trim(),
          inHeader: !!t?.closest("header"), isLast: last === t, hasStat: /assets/i.test(chip?.textContent || ""),
          panels: document.querySelectorAll('[data-testid="fng-panel"], #fng-panel').length,
          chipH: t ? Math.round(tr.height * 10) / 10 : null, statH: cr ? Math.round(cr.height * 10) / 10 : null,
          rowH: rr ? Math.round(rr.height * 10) / 10 : null,
          sameLine: !!t && Math.abs((tr.top + tr.height / 2) - (cr.top + cr.height / 2)) <= 2,
          endOfLine: !!t && tr.right <= rr.right + 0.5 && tr.left > cr.right,
        };
      });
      // Owner decision 16 Nov 2026: one wrapping row; the chip may take its own line (at most one line, <= 22 px) when the last line has no room, and it never
      // truncates, hides or covers existing text. Measured with the chip shown and hidden, on the fixture and with the Upbit BTC notice + a watching list + the
      // liquidity note injected (the strings the app renders for them).
      const measure = (w, inject) => p.setViewportSize({ width: w, height: 800 }).then(() => p.waitForTimeout(250)).then(() => p.evaluate((inj) => {
        const t = document.querySelector('[data-testid="fng-toggle"]'), row = t.closest("div.border-t"), tele = row.querySelector('[data-testid="scan-telemetry"]');
        const added = [];
        if (inj) {
          const mk = (cls, text) => { const e = document.createElement("span"); e.className = cls; e.textContent = text; row.insertBefore(e, t); added.push(e); return e; };
          mk("text-amber-300/80", "Prices in BTC — not converted to your display currency.");
          mk("text-emerald-400/80", "Watching: BTC, ETH, SOL, XRP, DOGE, ADA");
          const dot = document.createElement("span"); dot.className = "mx-1.5 text-zinc-700"; dot.textContent = "·"; tele.appendChild(dot); added.push(dot);
          const liq = document.createElement("span"); liq.textContent = "12 pairs under $250k/day are not scored"; tele.appendChild(liq); added.push(liq);
        }
        const h = () => Math.round(row.getBoundingClientRect().height * 10) / 10;
        const teleInfo = () => ({ text: tele ? tele.textContent : null, over: tele ? tele.scrollWidth > tele.clientWidth + 1 : null, w: tele ? tele.clientWidth : null, shown: tele ? getComputedStyle(tele).display !== "none" : false });
        const shown = h(), ti = teleInfo(), tr = t.getBoundingClientRect();
        const covered = [...row.querySelectorAll("*")].filter((e) => e !== t && !t.contains(e) && !e.contains(t) && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0 && !e.matches("svg *"))
          .filter((e) => { const r = e.getBoundingClientRect(); return r.left < tr.right - 0.5 && r.right > tr.left + 0.5 && r.top < tr.bottom - 0.5 && r.bottom > tr.top + 0.5; }).length;
        const docOver = document.documentElement.scrollWidth > innerWidth + 0.5, chipOut = tr.right > innerWidth + 0.5 || tr.left < -0.5;
        t.style.display = "none";
        const hidden = h(), th = teleInfo();
        t.style.display = "";
        const titled = inj || !tele || tele.title === (tele.textContent || "").replace(/\s+/g, " ").trim();
        for (const e of added) e.remove();
        return { shown, hidden, grow: Math.round((shown - hidden) * 10) / 10, sameText: ti.text === th.text, over: ti.over, overHidden: th.over, teleW: ti.w, teleWHidden: th.w, covered, docOver, chipOut, titled, teleShown: ti.shown };
      }, inject));
      const wrap = {}, wrapInj = {};
      for (const w of [1366, 1280, 1024, 900, 640, 360]) wrap[w] = await measure(w, false);
      for (const w of [900, 700, 640]) wrapInj[w] = await measure(w, true);
      await p.setViewportSize({ width: 1366, height: 768 });
      const noTrunc = [640, 900, 1024, 1280].every((w) => wrap[w].teleShown && !wrap[w].over && wrap[w].sameText && wrap[w].teleW === wrap[w].teleWHidden);
      const stable = [1366, 360].every((w) => Math.abs(wrap[w].shown - wrap[w].hidden) <= 1);
      const oneLineMax = [...Object.values(wrap), ...Object.values(wrapInj)].every((r) => r.grow <= 22 && r.titled);
      const injOk = Object.values(wrapInj).every((r) => !r.docOver && r.covered === 0 && !r.chipOut && r.sameText) && Object.values(wrap).every((r) => !r.docOver && r.covered === 0 && !r.chipOut);
      const noWrap = noTrunc && stable && oneLineMax && injOk;
      // One line: the row is the StatChip's height plus the row's own vertical padding (py-1 = 8 px), within 1 px.
      const oneLine = geo.rowH !== null && Math.abs(geo.rowH - (geo.statH + 8)) <= 1 && geo.chipH <= geo.statH + 1;
      record("FG-1", "Fear & Greed at rest: one collapsed chip at the end of the counts line, no panel, no request to api.alternative.me; the chip never truncates, hides or covers existing text (it may take its own line, <= 22 px, when the line is full; 1366 px and 360 px unchanged); DS-1 checked separately with the chip excluded per spec §3 item 8",
        geo.toggles === 1 && geo.expanded === "false" && geo.controls === "fng-panel" && /Fear & Greed/.test(geo.text) && geo.inHeader && geo.isLast && geo.hasStat && geo.sameLine && geo.endOfLine && oneLine && noWrap && geo.panels === 0 && hits.length === 0,
        { geo, wrap, wrapInj, noTrunc, stable, oneLineMax, injOk, hits });
      await c.close();
    }

    /* FG-2: open, content, one request, remembered open with cache on reload, collapse restores the list, HTTP 500, 390 px */
    {
      const { c, p, hits } = await fngContext();
      const top0 = await listTop(p);
      const rowBottom = await p.evaluate(() => document.querySelector('[data-testid="fng-toggle"]').closest("div.border-t").getBoundingClientRect().bottom);
      await p.getByTestId("fng-toggle").click();
      await p.getByTestId("fng-gauge").waitFor({ timeout: 10000 });
      await p.waitForTimeout(600);
      const open = await p.evaluate(() => {
        const panel = document.querySelector('[data-testid="fng-panel"]');
        const g = document.querySelector('[data-testid="fng-gauge"]');
        const a = document.querySelector('[data-testid="fng-attribution"]');
        const h = document.querySelector('[data-testid="fng-history"]');
        const pr = panel?.getBoundingClientRect(), gr = g?.getBoundingClientRect(), ar = a?.getBoundingClientRect();
        const link = a?.tagName === "A" ? a : a?.querySelector("a");
        return {
          role: panel?.getAttribute("role"), id: panel?.id, labelled: !!panel?.getAttribute("aria-labelledby") && !!document.getElementById(panel.getAttribute("aria-labelledby")),
          expanded: document.querySelector('[data-testid="fng-toggle"]').getAttribute("aria-expanded"),
          top: pr?.top, bottom: pr?.bottom, mainTop: document.querySelector("main").getBoundingClientRect().top,
          aria: g?.getAttribute("aria-label"), gaugeRole: g?.getAttribute("role"), bars: h ? h.querySelectorAll("[data-day]").length : -1,
          text: panel?.textContent || "",
          attrVisible: !!a && ar.width > 0 && ar.height > 0, attrText: a?.textContent?.trim(), href: link?.getAttribute("href"),
          nextToGauge: !!a && !!gr && (Math.abs(ar.top - gr.bottom) < 80 || (ar.left >= gr.right - 4 && ar.top < gr.bottom)),
          inPanel: !!panel && !!a && panel.contains(a) && panel.contains(g),
          histAria: h?.getAttribute("aria-label"),
          captionHidden: [...(panel?.querySelectorAll("p") || [])].filter((e) => /^Last \d+ days, oldest to newest$/.test((e.textContent || "").trim())).every((e) => e.getAttribute("aria-hidden") === "true") && [...(panel?.querySelectorAll("p") || [])].some((e) => /^Last \d+ days, oldest to newest$/.test((e.textContent || "").trim())),
        };
      });
      const oneRequest = hits.length === 1;
      const vals = fngRows.map((r) => Number(r.value)).reverse();
      const summary = `Last 31 days, oldest to newest: from ${vals[0]} to ${vals[30]}, low ${Math.min(...vals)}, high ${Math.max(...vals)}`; // M4: values in the text alternative, caption not read twice
      const histOk = open.histAria === summary && open.captionHidden;
      const below = open.top >= rowBottom - 1 && open.bottom <= open.mainTop + 1 && open.mainTop > top0 + 100;
      const gaugeOk = /\b10\b/.test(open.aria || "") && /Extreme Fear/.test(open.aria || "") && open.gaugeRole === "img" && /Updated /.test(open.text);
      // Reload: same storage (IndexedDB "meta" cache + localStorage fng.open): still open, no second request.
      await p.reload({ waitUntil: "domcontentloaded" });
      await p.getByTestId("fng-gauge").waitFor({ timeout: 20000 });
      await p.waitForTimeout(3000);
      const reloaded = { stillOpen: (await p.getByTestId("fng-panel").count()) === 1, expanded: await p.getByTestId("fng-toggle").getAttribute("aria-expanded"), hits: hits.length };
      // Collapse: the list returns to its at-rest top.
      await p.getByTestId("fng-toggle").click();
      await p.waitForTimeout(400);
      const top1 = await listTop(p);
      const collapsed = { panels: await p.getByTestId("fng-panel").count(), top1, top0 };
      // 390 px: the panel fits (re-open it from the cache; the line above has its own checks elsewhere).
      await p.getByTestId("fng-toggle").click();
      await p.getByTestId("fng-gauge").waitFor({ timeout: 10000 });
      await p.setViewportSize({ width: 390, height: 844 });
      await p.waitForTimeout(500);
      const narrow = await p.evaluate(() => {
        const panel = document.querySelector('[data-testid="fng-panel"]');
        const r = panel.getBoundingClientRect();
        const wide = [...panel.querySelectorAll("*")].filter((el) => el.getBoundingClientRect().right > innerWidth + 0.5).length;
        const mainH = document.querySelector("main").getBoundingClientRect().height;
        const t = document.querySelector('[data-testid="fng-toggle"]'), tr = t.getBoundingClientRect();
        const cx = tr.left + tr.width / 2, cy = tr.top + tr.height / 2;
        const hit = (dy) => { const e = document.elementFromPoint(cx, cy + dy); return !!e && (e === t || t.contains(e)); };
        const g = document.querySelector('[data-testid="fng-gauge"]').getBoundingClientRect();
        const mr = document.querySelector("main").getBoundingClientRect();
        const rowsVisible = [...document.querySelectorAll("main tbody tr")].filter((e) => { const b = e.getBoundingClientRect(); return b.top >= mr.top - 0.5 && b.bottom <= mr.bottom + 0.5; }).length;
        return { right: Math.round(r.right), left: Math.round(r.left), iw: innerWidth, ih: innerHeight, docScroll: document.documentElement.scrollWidth, panelScroll: panel.scrollWidth, panelClient: panel.clientWidth, wide,
          mainH: Math.round(mainH), rowsVisible, rowsBottom: [...document.querySelectorAll("main tbody tr")].slice(0, 5).map((e) => Math.round(e.getBoundingClientRect().bottom - mr.top)), rowH: Math.round(document.querySelector("main tbody tr")?.getBoundingClientRect().height || 0), headH: Math.round(document.querySelector("main thead")?.getBoundingClientRect().height || 0), mainTop: Math.round(mr.top), panelH: Math.round(r.height), gaugeW: Math.round(g.width), chipH: Math.round(tr.height * 10) / 10, hitUp: hit(-11), hitDown: hit(11), hit0: hit(0),
          readout: (() => { const r = document.querySelector('[data-testid="fng-readout"]'); return r ? { font: parseFloat(getComputedStyle(r).fontSize), text: r.textContent || "", shown: getComputedStyle(r).display !== "none" } : null; })(),
          svgTextShown: [...document.querySelectorAll('[data-testid="fng-gauge"] text')].filter((e) => getComputedStyle(e).display !== "none").length };
      });
      const phone = (narrow.mainH >= narrow.ih * 0.4 || narrow.rowsVisible >= 3) && narrow.gaugeW <= 200 && narrow.chipH <= 17 && narrow.hit0 && narrow.hitUp && narrow.hitDown && !!narrow.readout && narrow.readout.shown && narrow.readout.font >= 11 && /\b10\b.*Extreme Fear.*\d{1,2} [A-Z][a-z]{2} \d{4}/.test(narrow.readout.text) && narrow.svgTextShown === 0; // I-2: the list keeps 40 % of the screen or at least 3 whole rows; the chip's hit box is at least 24 px tall (+/-11 px around its centre) while it still looks 16 px
      const fits = narrow.right <= narrow.iw && narrow.left >= 0 && narrow.docScroll <= narrow.iw && narrow.panelScroll <= narrow.panelClient + 1 && narrow.wide === 0;
      await c.close();
      // M3: a cache 2 h old and HTTP 500: the cached value shows with the stale notice (under the gauge's Updated line); exactly one request.
      const st = await fngContext(500);
      await st.p.evaluate((rows) => new Promise((resolve, reject) => {
        const req = indexedDB.open("rsl-conf");
        req.onerror = () => reject(new Error("idb"));
        req.onsuccess = () => {
          const db = req.result, tx = db.transaction("meta", "readwrite");
          tx.objectStore("meta").put({ asOf: Date.now() - 2 * 3600e3, points: rows.slice().reverse().map((r) => ({ t: Number(r.timestamp) * 1000, value: Number(r.value), label: r.value_classification, band: "x" })) }, "fng-cache");
          tx.oncomplete = () => { db.close(); resolve(true); };
          tx.onerror = () => reject(new Error("idb put"));
        };
      }), fngRows);
      await st.p.getByTestId("fng-toggle").click();
      await st.p.getByTestId("fng-gauge").waitFor({ timeout: 10000 });
      await st.p.waitForFunction(() => /Showing the last value from/.test(document.querySelector('[data-testid="fng-panel"]')?.textContent || ""), null, { timeout: 15000 }).catch(() => null);
      await st.p.waitForTimeout(1500);
      const stale = await st.p.evaluate(() => {
        const panel = document.querySelector('[data-testid="fng-panel"]'), g = document.querySelector('[data-testid="fng-gauge"]');
        const sp = [...panel.querySelectorAll("p")].find((e) => /Showing the last value from/.test(e.textContent || ""));
        const a = document.querySelector('[data-testid="fng-attribution"]');
        const gr = g.getBoundingClientRect(), sr = sp?.getBoundingClientRect(), ar = a.getBoundingClientRect();
        return { text: sp?.textContent || "", aria: g.getAttribute("aria-label"), underGauge: !!sp && sr.top >= gr.bottom - 2 && sr.top - gr.bottom < 24 && Math.abs(sr.left - gr.left) < 4 && ar.top >= sr.bottom - 2 };
      });
      const staleOk = /^Showing the last value from \d{1,2} [A-Z][a-z]{2} \d{4}$/.test(stale.text) && /\b10\b/.test(stale.aria || "") && /Extreme Fear/.test(stale.aria || "") && stale.underGauge && st.hits.length === 1;
      await st.c.close();
      // N1: one valid row is the gauge only: no history.
      const one = await fngContext(200, JSON.stringify({ name: "Fear and Greed Index", data: [fngRows[0]], metadata: { error: null } }));
      await one.p.getByTestId("fng-toggle").click();
      await one.p.getByTestId("fng-gauge").waitFor({ timeout: 10000 });
      await one.p.waitForTimeout(500);
      await one.p.setViewportSize({ width: 390, height: 844 });
      await one.p.waitForTimeout(400);
      const oneReadout = await one.p.evaluate(() => { const r = document.querySelector('[data-testid="fng-readout"]'); return r ? { font: parseFloat(getComputedStyle(r).fontSize), text: r.textContent || "" } : null; });
      const oneRow = { readout: oneReadout, readoutOk: !!oneReadout && oneReadout.font >= 11 && /\d{1,2} [A-Z][a-z]{2} \d{4}/.test(oneReadout.text), history: await one.p.getByTestId("fng-history").count(), caption: /oldest to newest/.test((await one.p.getByTestId("fng-panel").textContent()) || "") };
      await one.c.close();
      // HTTP 500 with no cache: a fresh context.
      const bad = await fngContext(500);
      await bad.p.getByTestId("fng-toggle").click();
      await bad.p.getByTestId("fng-panel").waitFor({ timeout: 10000 });
      await bad.p.waitForFunction(() => /The index is unavailable right now\./.test(document.querySelector('[data-testid="fng-panel"]')?.textContent || ""), null, { timeout: 15000 }).catch(() => null);
      const badText = await bad.p.getByTestId("fng-panel").textContent();
      const unavailable = /The index is unavailable right now\./.test(badText || "") && (await bad.p.getByTestId("fng-gauge").count()) === 0;
      await bad.c.close();
      record("FG-2", "Fear & Greed open on mocked data: gauge 10 Extreme Fear with date, 31 history bars, Alternative.me attribution next to the gauge, one request, remembered open with cache on reload, collapsing restores the list position, unavailable state on HTTP 500, fits at 390 px with the list keeping at least 40 % of the screen or 3 whole rows, a 24 px chip hit box and the gauge facts as 11 px+ text (also for one valid row), stale cache + HTTP 500 shows the cached value with the dated notice and one request, one valid row draws no history, the history text alternative carries the values",
        open.role === "region" && open.id === "fng-panel" && open.labelled && open.expanded === "true" && below && gaugeOk && open.bars === 31
          && open.attrVisible && open.inPanel && open.nextToGauge && /Alternative\.me/.test(open.attrText || "") && open.href === "https://alternative.me/crypto/fear-and-greed-index/"
          && oneRequest && reloaded.stillOpen && reloaded.expanded === "true" && reloaded.hits === 1
          && collapsed.panels === 0 && Math.abs(collapsed.top1 - collapsed.top0) <= 2 && unavailable && fits && phone && staleOk && oneRow.history === 0 && !oneRow.caption && oneRow.readoutOk && histOk,
        { open: { ...open, text: undefined }, below, gaugeOk, oneRequest, reloaded, collapsed, narrow, phone, stale, staleOk, oneRow, histOk, summary, unavailable, badText: (badText || "").slice(0, 120) });
    }
  }
  } // end of the full run (skipped with --ds-only / --hd-only / --bk-only)
  /* ===== v2.8 WP28: Cloud backup (encrypted) in About → Settings — the gateway is mocked on http://127.0.0.1:8787 (as RD-9) ===== */
  /* acceptance-ids: BK-1, BK-2, BK-3, BK-4 */
  if (!DS_ONLY && !HD_ONLY) {
    const BK_PASS = "acceptance passphrase 1";
    const BK_WRONG = "wrong passphrase 123";
    const BK_KEY_ID = "FAKE-B2-KEYID-0045e1c7a9abcd", BK_SECRET = "FAKE-B2-APPKEY-3f9d2b7c41e8a6"; // obviously fake
    const BK_MAX = 20 * 1024 * 1024;
    // Review M-1: candles on a fixed clock per bar length — 1 ms before the current bar opened — so the newest bar served
    // is already closed and no further bar closes during the checks (that would add ledger rows between backup and
    // restore). Frozen once per run; the newest closed bar is the same one the wall clock gives.
    const BK_T0 = Date.now();
    const BK_NOW = (step) => Math.floor(BK_T0 / step) * step - 1;
    // Hosts a collapsed (or merely expanded) section must never contact.
    const bkForbidden = (u) => /(^|\.)login\.microsoftonline\.com$|(^|\.)graph\.microsoft\.com$|(^|\.)pcloud\.com$|(^|\.)googleapis\.com$/.test(u.hostname)
      || (u.host === "127.0.0.1:8787" && u.pathname.startsWith("/backup/"));
    const gw = { profiles: [], files: new Map(), serve: null, calls: [], connect: [], bad: [] };
    const bkGateway = async (c) => {
      await c.route(/^http:\/\/127\.0\.0\.1:8787\//, async (route) => {
        const req = route.request();
        const u = new URL(req.url());
        const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS" };
        const reply = (status, b) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(b) });
        if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
        gw.calls.push(`${req.method()} ${u.pathname}`);
        if (req.headers().authorization !== "Bearer fixture-token") { gw.bad.push(u.pathname); return reply(401, { error: "unauthorized" }); }
        if (u.pathname === "/health") return reply(200, { ok: true, service: "rsl-gateway", profiles: 0 });
        if (u.pathname === "/profiles") return reply(200, { profiles: [] });
        if (u.pathname === "/providers/connect" && req.method() === "POST") {
          const b = JSON.parse(req.postData() || "{}");
          gw.connect.push(b);
          const profile = { id: "bk-b2-1", kind: "provider", provider: "b2", label: String(b.label || "B2"), bucket: "rsl-test-bucket", maskedKey: "0045…abcd", connectedAt: new Date().toISOString() };
          gw.profiles = [profile];
          return reply(200, { profile });
        }
        if (u.pathname === "/providers" && req.method() === "GET") return reply(200, { profiles: gw.profiles });
        if (u.pathname === "/backup/upload" && req.method() === "POST") {
          const name = u.searchParams.get("name");
          const body = req.postData() || "";
          const at = new Date().toISOString();
          gw.files.set(name, { body, at });
          return reply(200, { name, size: Buffer.byteLength(body), modifiedAt: at });
        }
        if (u.pathname === "/backup/list") return reply(200, { files: [...gw.files].map(([name, f]) => ({ name, size: Buffer.byteLength(f.body), modifiedAt: f.at })) });
        if (u.pathname === "/backup/download") {
          const f = gw.files.get(u.searchParams.get("name"));
          if (!f) return reply(404, { error: "not found" });
          const body = gw.serve ? gw.serve(f.body) : f.body;
          return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/octet-stream" }, body });
        }
        return reply(404, { error: "not found" });
      });
    };
    const bkContext = async () => {
      const c = await newContext(browser);
      await mockExchanges(c, undefined, { now: BK_NOW });
      await bkGateway(c);
      const hits = [];
      c.on("request", (r) => { const u = new URL(r.url()); if (bkForbidden(u)) hits.push(u.host + u.pathname); });
      const p = await c.newPage();
      await p.goto(BASE, { waitUntil: "domcontentloaded" });
      await completeFirstRun(p, { operator: "R" });
      await waitRows(p);
      return { c, p, hits };
    };
    const flat = (s) => (s || "").replace(/[⁨⁩]/g, "").replace(/\s+/g, " ").trim();
    const idbAll = (p, db, store) => p.evaluate(([name, st]) => new Promise((resolve) => {
      const rq = indexedDB.open(name);
      rq.onerror = () => resolve([]);
      rq.onsuccess = () => {
        const d = rq.result;
        if (!d.objectStoreNames.contains(st)) { d.close(); return resolve([]); }
        const g = d.transaction(st, "readonly").objectStore(st).getAll();
        g.onsuccess = () => { d.close(); resolve(g.result); };
        g.onerror = () => { d.close(); resolve([]); };
      };
    }), [db, store]);
    const ledgerIds = async (p) => (await idbAll(p, "rsl-conf-ledger", "ledger")).flatMap((d) => (d && d.rows) || []).map((r) => r.id).sort();
    const auditEvents = async (p) => (await idbAll(p, "rsl-conf", "audit")).map((e) => e && e.event).filter(Boolean);
    const prefsNow = async (p) => JSON.stringify((await idbAll(p, "rsl-conf", "preferences")));
    const storageText = (p) => p.evaluate(async () => {
      const out = [JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage })];
      for (const info of (indexedDB.databases ? await indexedDB.databases() : [])) {
        await new Promise((done) => {
          const rq = indexedDB.open(info.name);
          rq.onerror = () => done();
          rq.onsuccess = () => {
            const d = rq.result;
            const names = [...d.objectStoreNames];
            if (!names.length) { d.close(); return done(); }
            const tx = d.transaction(names, "readonly");
            let left = names.length;
            for (const n of names) {
              const g = tx.objectStore(n).getAll();
              const fin = () => { if (--left === 0) { d.close(); done(); } };
              g.onsuccess = () => { try { out.push(JSON.stringify(g.result)); } catch { /* unserialisable */ } fin(); };
              g.onerror = fin;
            }
          };
        });
      }
      return out.join("\n");
    });
    const openAbout = async (p) => {
      await p.getByRole("button", { name: "About" }).click();
      await p.waitForSelector("text=Audit trail");
    };
    const closeAbout = async (p) => {
      await p.keyboard.press("Escape");
      await p.getByRole("dialog").waitFor({ state: "hidden", timeout: 5000 }).catch(() => null);
    };
    const expand = async (p) => {
      const sec = p.getByTestId("about-cloud-backup");
      if ((await sec.getAttribute("open")) === null) await sec.locator("summary").click();
      await p.getByTestId("bk-provider-b2").waitFor({ timeout: 5000 });
    };
    const bkStatus = (p) => p.getByTestId("bk-status").textContent().then(flat, () => "");
    /** Waits until the status line has left "Working…" and returns it. */
    const settled = async (p, re) => {
      await p.waitForFunction((src) => {
        const t = document.querySelector('[data-testid="bk-status"]')?.textContent || "";
        return t && !/Working…/.test(t) && (!src || new RegExp(src).test(t));
      }, re ? re.source : null, { timeout: 60000 }).catch(() => null);
      return bkStatus(p);
    };
    /** After a reload the page holds no gateway link: Check lists the gateway's profiles again (the B2 key stays in the gateway). */
    const relinkGateway = async (p) => {
      await p.getByRole("button", { name: /Private API/ }).first().click();
      const dlg = p.getByRole("dialog");
      await dlg.waitFor({ timeout: 10000 });
      await dlg.locator("#gateway-token").fill("fixture-token");
      await dlg.getByRole("button", { name: "Check", exact: true }).click();
      await dlg.getByLabel("Connected data providers").getByText("Backups", { exact: true }).waitFor({ timeout: 10000 });
      await closeAbout(p);
    };
    /** Restore… → the list → open the newest file with `pass`. */
    const openNewest = async (p, pass) => {
      await p.getByTestId("bk-restore-b2").click();
      await p.getByTestId("bk-list").waitFor({ timeout: 15000 });
      await p.getByTestId("bk-pass").fill(pass);
      await p.getByTestId("bk-open").click();
    };

    /** A step that throws (an element never appears) records FAIL for the checks it had not reached, instead of ending the run. */
    const bkGuard = async (ids, fn) => {
      try { await fn(); } catch (e) {
        if (process.env.BK_DEBUG) console.log(String(e && e.stack).split("\n").filter((l) => /acceptance\.cjs|waiting for|locator/.test(l)).slice(0, 6).join("\n"));
        for (const id of ids) if (!results.some((r) => r.id === id)) record(id, "Cloud backup check did not complete", false, `threw: ${String(e && e.message).split("\n")[0].slice(0, 200)}`);
      }
    };

    /* BK-1: at rest the section is a collapsed <details> with nothing rendered inside and nothing requested; expanded in the
       default build (no client IDs) the five providers show their availability, still without a request. */
    await bkGuard(["BK-1"], async () => {
      const { c, p, hits } = await bkContext();
      try {
      await openAbout(p);
      const sec = p.getByTestId("about-cloud-backup");
      const present = (await sec.count()) === 1;
      const closedAtRest = present && (await sec.getAttribute("open")) === null;
      const rowsAtRest = await p.locator('[data-testid="about-cloud-backup"] [data-testid^="bk-provider-"]').count();
      const title = flat(await sec.locator("summary").textContent().catch(() => ""));
      const hitsAtRest = hits.length;
      await expand(p);
      const states = Object.fromEntries(await Promise.all(["gdrive", "onedrive", "pcloud", "b2", "r2"].map(async (id) => [id, await p.getByTestId(`bk-provider-${id}`).getAttribute("data-state")])));
      const actions = await p.locator('[data-testid^="bk-backup-"], [data-testid^="bk-restore-"], [data-testid^="bk-signin-"]').count();
      const inputs = await p.evaluate(() => [...document.querySelectorAll('[data-testid="bk-pass"], [data-testid="bk-pass2"]')].map((e) => `${e.type}/${e.autocomplete}`));
      await p.addScriptTag({ content: AXE });
      const axe = await p.evaluate(async () => (await window.axe.run(document.querySelector('[data-testid="about-cloud-backup"]'), { resultTypes: ["violations"] })).violations.map((v) => `${v.id}:${v.nodes.length}`));
      await p.waitForTimeout(1000);
      const origin = new URL(BASE).origin;
      await p.screenshot({ path: path.join(OUT, "bk-1-expanded.png") }).catch(() => null);
      record("BK-1", "Cloud backup: collapsed in About, nothing rendered or requested at rest; default build shows Google desktop-only, OneDrive/pCloud not set up, B2/R2 needing a gateway key",
        closedAtRest && rowsAtRest === 0 && title === "Cloud backup (encrypted)" && hitsAtRest === 0 && hits.length === 0
          && states.gdrive === "desktop-only" && states.onedrive === "not-set-up" && states.pcloud === "not-set-up" && states.b2 === "needs-gateway" && states.r2 === "needs-gateway"
          && actions === 0 && inputs.join() === "password/new-password,password/new-password" && axe.length === 0,
        { origin, closedAtRest, rowsAtRest, title, hitsAtRest, hits: hits.slice(0, 4), states, actions, inputs, axe });
      } finally {
        await c.close(); // review M-10: also when a step throws
      }
    });

    /* BK-2 … BK-4 share one page: B2 connected through the mocked gateway, one backup uploaded. */
    const shared = { c: null };
    await bkGuard(["BK-2", "BK-3", "BK-4"], async () => {
    const { c, p, hits } = await bkContext();
    shared.c = c;
    const consoleErrors = [];
    p.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 160)));
    // Final review M-1: every long task (>= 50 ms) on the page while a backup, an open or a restore runs. Key derivation and
    // AES-GCM run in WebCrypto off the main thread, so nothing is exempted: no task may reach 200 ms.
    const bkLongTasks = { probe: [], backup: [], open: [], restore: [] };
    let bkPhase = null;
    await p.exposeFunction("__bkLongTask", (ms) => { if (bkPhase) bkLongTasks[bkPhase].push(ms); });
    const watchLongTasks = () => p.evaluate(() => {
      if (window.__bkLtOn) return;
      window.__bkLtOn = true;
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__bkLongTask(Math.round(e.duration)); }).observe({ type: "longtask" }); } catch { /* no long-task API */ }
    });
    {
      // 1. connect B2 with the Private API header button
      await p.getByRole("button", { name: /Private API/ }).first().click();
      const dlg = p.getByRole("dialog");
      await dlg.waitFor({ timeout: 10000 });
      await dlg.locator("#gateway-token").fill("fixture-token");
      await dlg.getByRole("button", { name: "Check", exact: true }).click();
      await dlg.getByText("Gateway online").waitFor({ timeout: 10000 });
      await dlg.locator("#data-provider").click();
      await p.getByRole("option", { name: /Backblaze B2/ }).click();
      await dlg.locator("#data-provider-label").fill("Backups");
      await dlg.locator("#bucket-key-id").fill(BK_KEY_ID);
      await dlg.locator("#bucket-secret").fill(BK_SECRET);
      await dlg.locator("#bucket-name").fill("rsl-test-bucket");
      await dlg.locator("#bucket-region").fill("eu-central-003");
      await dlg.getByRole("button", { name: "Connect", exact: true }).last().click();
      await dlg.getByLabel("Connected data providers").getByText("Backups", { exact: true }).waitFor({ timeout: 10000 });
      const secretsCleared = (await dlg.locator("#bucket-key-id").inputValue()) === "" && (await dlg.locator("#bucket-secret").inputValue()) === "";
      const keySent = gw.connect.length === 1 && gw.connect[0].accessKeyId === BK_KEY_ID && gw.connect[0].secretAccessKey === BK_SECRET;
      await closeAbout(p);
      // 2. back up with the passphrase twice (once the first scan has finished recording)
      for (let i = 0, last = -1; i < 20; i++) { const n = (await ledgerIds(p)).length; if (n === last && n > 0) break; last = n; await p.waitForTimeout(750); }
      const auditBefore = await auditEvents(p);
      const tfBefore = flat(await p.getByRole("combobox", { name: "Timeframe" }).textContent());
      const ledgerAtBackup = await ledgerIds(p);
      // Review M-8: the positive control for "no BTCUSDT in the upload": the ledger does hold BTCUSDT rows.
      const btcAtBackup = ledgerAtBackup.some((x) => x.includes("|BTCUSDT|"));
      await openAbout(p);
      await expand(p);
      const b2State = await p.getByTestId("bk-provider-b2").getAttribute("data-state");
      await p.getByTestId("bk-pass").fill(BK_PASS);
      await p.getByTestId("bk-pass2").fill(BK_PASS);
      await watchLongTasks();
      // Positive control: an 80 ms busy loop must be seen, so "no long task" cannot pass because the observer is deaf.
      bkPhase = "probe";
      await p.evaluate(() => { setTimeout(() => { const t = performance.now(); while (performance.now() - t < 80) { /* busy */ } }, 0); }); // a page task (a CDP evaluate is not one)
      await p.waitForTimeout(300);
      bkPhase = "backup";
      await p.getByTestId("bk-backup-b2").click();
      const doneText = await settled(p, /Backed up|could|refused|not/);
      await p.waitForTimeout(300); // long-task entries are delivered after the task
      bkPhase = null;
      const passCleared = (await p.getByTestId("bk-pass").inputValue()) === "" && (await p.getByTestId("bk-pass2").inputValue()) === "";
      const [name, file] = [...gw.files][0] || [];
      let envelope = null;
      try { envelope = JSON.parse(file.body); } catch { envelope = null; }
      const envelopeOk = !!envelope && Object.keys(envelope).sort().join() === "ct,format,h,iv,v" && envelope.format === "rsl-confluence-backup" && envelope.v === 1;
      const noPlain = !!file && !file.body.includes("BTCUSDT") && !file.body.includes(BK_PASS) && !file.body.includes("acceptance passphrase");
      await closeAbout(p);
      // 3. note the ledger, then change the timeframe preference (an audited settings change after the backup)
      await p.getByRole("combobox", { name: "Timeframe" }).click();
      await p.getByRole("option", { name: "1 hour", exact: true }).click();
      await waitRows(p);
      for (let i = 0; i < 40 && !(await auditEvents(p)).includes("preferences.update"); i++) await p.waitForTimeout(250);
      // let the 1 h scan finish recording before the ledger is cleared
      let last = -1;
      for (let i = 0; i < 20; i++) { const n = (await ledgerIds(p)).length; if (n === last) break; last = n; await p.waitForTimeout(750); }
      const tfChanged = flat(await p.getByRole("combobox", { name: "Timeframe" }).textContent());
      // 4. clear the ledger (existing confirm)
      await p.getByRole("button", { name: /Signal ledger \(forward test\)/ }).click();
      await p.waitForSelector("text=Signals recorded");
      await p.getByRole("dialog").getByRole("button", { name: "Clear ledger" }).first().click();
      await p.getByRole("alertdialog").getByRole("button", { name: "Clear ledger" }).click();
      for (let i = 0; i < 20 && (await ledgerIds(p)).length; i++) await p.waitForTimeout(250);
      const clearedTo = (await ledgerIds(p)).length;
      await closeAbout(p);
      // 5. restore: the list shows the file; the plan shows the backup time, the counts and the newer-settings line
      const prefsBeforeRestore = await prefsNow(p);
      await openAbout(p);
      await expand(p);
      await p.getByTestId("bk-restore-b2").click();
      await p.getByTestId("bk-list").waitFor({ timeout: 15000 });
      const listText = flat(await p.getByTestId("bk-list").textContent());
      await p.getByTestId("bk-pass").fill(BK_PASS);
      await watchLongTasks();
      bkPhase = "open";
      await p.getByTestId("bk-open").click();
      await p.getByTestId("bk-plan").waitFor({ timeout: 60000 }).catch(() => null);
      await p.waitForTimeout(300);
      bkPhase = null;
      const planText = flat(await p.getByTestId("bk-plan").textContent().catch(() => ""));
      const settingsUnchecked = (await p.getByTestId("bk-settings").isChecked().catch(() => true)) === false;
      // Review I-2: focus moves into the plan (alertdialog) and it is described by the time and counts lines.
      await p.waitForFunction(() => !!document.activeElement?.closest('[data-testid="bk-plan"]'), null, { timeout: 5000 }).catch(() => null);
      const planFocus = await p.evaluate(() => {
        const plan = document.querySelector('[data-testid="bk-plan"]');
        const ids = (plan?.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
        return { inside: !!plan && plan.contains(document.activeElement), on: document.activeElement?.getAttribute("data-testid") || document.activeElement?.tagName, described: ids.length === 2 && ids.every((id) => (document.getElementById(id)?.textContent || "").length > 0) };
      });
      await p.getByTestId("bk-settings").check();
      const ledgerBeforeConfirm = (await ledgerIds(p)).length;
      const prefsBeforeConfirm = await prefsNow(p); // review M-9: opening the plan and ticking the box write nothing
      bkPhase = "restore"; // until the page reloads (the observer goes with the old page)
      const [, ] = await Promise.all([p.waitForEvent("load", { timeout: 20000 }).catch(() => null), p.getByTestId("bk-confirm").click()]);
      bkPhase = null;
      const worstLongTask = Math.max(0, ...bkLongTasks.backup, ...bkLongTasks.open, ...bkLongTasks.restore);
      // 6. after the reload: the ledger and the timeframe are back
      await p.waitForSelector(".rsl-brand-host .rsl-brand", { timeout: 20000 });
      await waitRows(p);
      const tfAfter = flat(await p.getByRole("combobox", { name: "Timeframe" }).textContent());
      const idsAfter = await ledgerIds(p);
      const ledgerBack = ledgerAtBackup.length > 0 && idsAfter.length === ledgerAtBackup.length && ledgerAtBackup.every((x) => idsAfter.includes(x));
      // 7. audit grew by the upload and the restore; no storage holds the passphrase or the bucket secret
      // About's "intact (N entries)" must match the stored chain. The app may append an entry of its own (scan activity after
      // the reload) between two reads, so the pair is read as About first, then the store, and read again (up to three times)
      // until both agree; a real mismatch disagrees every time.
      let auditAfter = [];
      let auditShown = NaN;
      const auditReads = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await p.waitForTimeout(750);
        await openAbout(p);
        await p.waitForFunction(() => /intact \(\d+ entries\)/.test(document.querySelector('[role="dialog"]').textContent), null, { timeout: 10000 }).catch(() => null);
        auditShown = Number(((await p.getByRole("dialog").textContent()).match(/intact \((\d+) entries\)/) || [])[1]);
        await closeAbout(p);
        auditAfter = await auditEvents(p);
        auditReads.push(`${auditShown}/${auditAfter.length}`);
        if (auditShown === auditAfter.length) break;
      }
      const grew = (ev) => auditAfter.filter((e) => e === ev).length - auditBefore.filter((e) => e === ev).length;
      const stored = await storageText(p);
      const secretsStored = [BK_PASS, BK_SECRET, BK_KEY_ID].filter((s) => stored.includes(s));
      const cloudHits = hits.filter((h) => !h.startsWith("127.0.0.1:8787"));
      record("BK-2", "Backup round trip through a mocked B2 gateway: encrypted upload without plaintext, restore shows the backup time, the record counts and asks before replacing newer settings, ledger and settings come back, no secret stored, no long task of 200 ms or more while it runs",
        secretsCleared && keySent && b2State === "ready" && /^Backed up confluence-backup-\d{8}T\d{6}Z\.json \(/.test(doneText) && passCleared && gw.files.size === 1 && envelopeOk && noPlain
          && tfChanged !== tfBefore && clearedTo === 0 && listText.includes(name)
          && /Backup made /.test(planText) && /Ledger: \d+ rows, \d+ new\. Paper journal: \d+ trades, \d+ new\. Pre-registrations: \d+, \d+ new\./.test(planText)
          && /Measured outcomes: \d+ rows, \d+ new\. Universe snapshots: \d+, \d+ new\. Recorded gaps: \d+, \d+ new\. Trade notes: \d+, \d+ new\./.test(planText)
          && worstLongTask < 200 && bkLongTasks.probe.length === 1 && bkLongTasks.probe[0] >= 80
          && /Your settings were changed after this backup \(.+\)\. Restoring them replaces your newer settings\./.test(planText) && settingsUnchecked
          && ledgerBeforeConfirm === 0 && prefsBeforeConfirm === prefsBeforeRestore && ledgerBack && tfAfter === tfBefore && btcAtBackup
          && planFocus.inside && planFocus.described
          && grew("backup.cloud.upload") === 1 && grew("backup.cloud.restore") === 1 && auditShown === auditAfter.length && secretsStored.length === 0 && gw.bad.length === 0 && cloudHits.length === 0,
        { secretsCleared, keySent, b2State, doneText, passCleared, files: gw.files.size, envelopeOk, noPlain, tfBefore, tfChanged, tfAfter, clearedTo, listText: listText.slice(0, 90),
          planText: planText.slice(0, 400), settingsUnchecked, planFocus, ledgerBeforeConfirm, prefsUnchangedBeforeConfirm: prefsBeforeConfirm === prefsBeforeRestore, btcAtBackup, ledger: `${ledgerAtBackup.length} → ${idsAfter.length}`, ledgerBack,
          audit: { upload: grew("backup.cloud.upload"), restore: grew("backup.cloud.restore"), shown: auditShown, stored: auditAfter.length, reads: auditReads }, secretsStored: secretsStored.length, gatewayAuthFailures: gw.bad.length, cloudHits,
          longTasks: { worst: worstLongTask, ...bkLongTasks } });
    }

    /* BK-3: a wrong passphrase, then a file with one character of its ciphertext changed: the same refusal, nothing changed. */
    {
      await relinkGateway(p);
      const before = await ledgerIds(p);
      await p.evaluate(() => { window.__bkNoReload = 1; });
      await openAbout(p);
      await expand(p);
      // Review I-2: Cancel discards the plan and returns focus to the Restore button that opened it.
      await openNewest(p, BK_PASS);
      await p.getByTestId("bk-plan").waitFor({ timeout: 60000 });
      await p.waitForFunction(() => !!document.activeElement?.closest('[data-testid="bk-plan"]'), null, { timeout: 5000 }).catch(() => null);
      const focusInPlan = await p.evaluate(() => !!document.activeElement?.closest('[data-testid="bk-plan"]'));
      await p.getByTestId("bk-cancel").click();
      await p.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "bk-restore-b2", null, { timeout: 5000 }).catch(() => null);
      const focusBack = await p.evaluate(() => document.activeElement?.getAttribute("data-testid") || document.activeElement?.tagName);
      const cancelled = (await p.getByTestId("bk-plan").count()) === 0;
      await openNewest(p, BK_WRONG);
      const wrong = await settled(p, /could not be opened|not a Confluence/);
      const wrongPlan = await p.getByTestId("bk-plan").count();
      gw.serve = (body) => {
        const o = JSON.parse(body);
        const i = Math.floor(o.ct.length / 2);
        o.ct = o.ct.slice(0, i) + (o.ct[i] === "A" ? "B" : "A") + o.ct.slice(i + 1);
        return JSON.stringify(o);
      };
      await openNewest(p, BK_PASS);
      const tampered = await settled(p, /could not be opened|not a Confluence/);
      const tamperedPlan = await p.getByTestId("bk-plan").count();
      gw.serve = null;
      const after = await ledgerIds(p);
      const noReload = await p.evaluate(() => window.__bkNoReload === 1);
      const msg = "This backup could not be opened: the passphrase is wrong or the file was changed.";
      record("BK-3", "Cloud restore refuses a wrong passphrase and a tampered file (one ciphertext character changed) with the same message; no plan is shown, the ledger is unchanged and the page does not reload (a cancelled plan returns focus to Restore…)",
        focusInPlan && focusBack === "bk-restore-b2" && cancelled && wrong === msg && tampered === msg && wrongPlan === 0 && tamperedPlan === 0 && after.length === before.length && after.every((x, i) => x === before[i]) && noReload,
        { focusInPlan, focusBack, cancelled, wrong, tampered, wrongPlan, tamperedPlan, ledger: `${before.length} → ${after.length}`, noReload });
      await closeAbout(p);
    }

    /* BK-4: a 20 MB + 1 download, a valid envelope around a payload of an unknown schema, and a foreign sign-in return. */
    {
      const { webcrypto } = require("node:crypto");
      const b64u = (b) => Buffer.from(b).toString("base64url");
      const seal = async (plain, pass, createdAt) => {
        const enc = new TextEncoder();
        const salt = webcrypto.getRandomValues(new Uint8Array(16));
        const iv = webcrypto.getRandomValues(new Uint8Array(12));
        const header = { schema: 1, cipher: "AES-256-GCM", kdf: "PBKDF2-SHA-256", iter: 600000, salt: b64u(salt), zip: "none", createdAt, app: "2.8.0 (build 20261117)" };
        const hb = enc.encode(JSON.stringify(header));
        const base = await webcrypto.subtle.importKey("raw", enc.encode(pass.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
        const key = await webcrypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 600000 }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
        const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: hb, tagLength: 128 }, key, enc.encode(plain)));
        return JSON.stringify({ format: "rsl-confluence-backup", v: 1, h: b64u(hb), iv: b64u(iv), ct: b64u(ct) });
      };
      const ledgerBefore = await ledgerIds(p);
      const prefsBefore = await prefsNow(p);
      await p.evaluate(() => { window.__bkNoReload = 1; });
      await openAbout(p);
      await expand(p);
      gw.serve = () => Buffer.alloc(BK_MAX + 1, 0x61);
      await openNewest(p, BK_PASS);
      const oversize = await settled(p, /larger than 20 MB|could not|not a Confluence|refused|reached/);
      const schema99 = await seal(JSON.stringify({ format: "rsl-confluence-backup-payload", schema: 99 }), BK_PASS, Date.now() - 60_000);
      gw.serve = () => schema99;
      await openNewest(p, BK_PASS);
      const invalid = await settled(p, /not a Confluence|could not|larger|refused/);
      gw.serve = null;
      const plans = await p.getByTestId("bk-plan").count();
      const ledgerAfter = await ledgerIds(p);
      const prefsAfter = await prefsNow(p);
      const noReload = await p.evaluate(() => window.__bkNoReload === 1);
      await closeAbout(p);
      // A sign-in return this page did not start: the code leaves the address bar and About opens on the section.
      await p.goto(new URL("/?code=x&state=y", BASE).href, { waitUntil: "domcontentloaded" });
      await p.waitForSelector(".rsl-brand-host .rsl-brand", { timeout: 20000 });
      await p.getByTestId("about-cloud-backup").waitFor({ timeout: 10000 }).catch(() => null);
      const foreignOpen = (await p.getByTestId("about-cloud-backup").getAttribute("open").catch(() => null)) !== null;
      const foreign = await settled(p, /phone app/);
      const href = p.url();
      const u = new URL(href);
      record("BK-4", "Cloud restore refuses a 20 MB + 1 download and a valid envelope whose payload has an unknown schema (ledger and preferences unchanged, no reload); a sign-in return this page did not start leaves no code in the address bar and says so in Cloud backup",
        oversize === "The file is larger than 20 MB and was not opened." && invalid === "This is not a Confluence Terminal backup, or it was made by a newer version." && plans === 0
          && ledgerAfter.join() === ledgerBefore.join() && prefsAfter === prefsBefore && noReload
          && !/code=|state=/.test(href) && u.pathname === "/" && u.search === "" && foreignOpen
          && foreign === "This sign-in was meant for the phone app or has expired. Start it again from Cloud backup.",
        { oversize, invalid, plans, ledger: `${ledgerBefore.length} → ${ledgerAfter.length}`, prefsSame: prefsAfter === prefsBefore, noReload, href, foreignOpen, foreign });
    }
    if (consoleErrors.length) console.log("BK page errors:", consoleErrors.slice(0, 3).join(" | "));
    });
    if (shared.c) await shared.c.close();
  }
  /* acceptance-ids: HD-1 — two-line header control ribbon at ≥ 1280 px (owner decision 16 Nov 2026, spec §3 item 9) */
  if (!DS_ONLY && !BK_ONLY) {
    const ev = {}; const bad = []; let more = null;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const runs = [];
    for (const [w, h] of [[1280, 800], [1366, 768], [1440, 900], [1920, 1080], [1024, 768], [390, 844]]) for (const lang of ["en", "de", "ar", "ru"]) runs.push({ w, h, lang });
    // Review I1: the longest workspace short name the wizard accepts must not push the ribbon to a third line.
    for (const lang of ["ru", "de", "fr"]) runs.push({ w: 1280, h: 800, lang, short: HD1_LONG_SHORT_NAME });
    for (const { w, h, lang, short } of runs) {
      const key = `${w}x${h}`;
      const id = `${key}-${lang}${short ? "-long" : ""}`;
      const shot = !short && ((w === 1366 && (lang === "en" || lang === "ar")) || (w === 1280 && lang === "de")) ? path.join(OUT, `hd-1-${w}-${lang}.png`) : null;
      const m = await hdMeasure(browser, w, h, lang, { shot, extra: w === 1366 && lang === "en" && !short, short });
      if (process.env.HD_DUMP) console.log("HD_DUMP", id, JSON.stringify(m));
      ev[id] = `${m.header}px/${m.rows}`;
      if (m.overflow.length) bad.push(`${id} overflow: ${m.overflow.slice(0, 3).join("; ")}`);
      if (!m.order) bad.push(`${id}: keyboard order differs from the visual order`);
      if (short) {
        if (m.rows !== 2) bad.push(`${id}: ${m.rows} rows with a ${short.length}-character workspace name (tops ${m.rowTops.join(",")})`);
        // The chip shows the name cut with an ellipsis, but its accessible name keeps the full short name.
        if (!m.names.some((n) => n.startsWith(`button: ${short} — `))) bad.push(`${id}: no workspace chip named "${short} — …"`);
        continue;
      }
      if (w >= 1280) {
        if (m.rows !== 2) bad.push(`${id}: ${m.rows} rows (tops ${m.rowTops.join(",")})`);
        if (!m.themeCycle) bad.push(`${id}: no theme button`);
        // Same controls, names and order as before; the three theme radios are one cycling theme button in their place.
        const want = (HD1_BEFORE.names.desktop[lang] || []).filter((n, i, a) => !n.startsWith("radio: ") || !a[i - 1]?.startsWith("radio: ")).map((n) => (n.startsWith("radio: ") ? "<theme>" : n));
        const got = m.names.map((n) => (n.startsWith(HD1_THEME[lang]) ? "<theme>" : n));
        if (!same(got, want)) bad.push(`${id} names: missing [${want.filter((n) => !got.includes(n)).join("; ")}] new [${got.filter((n) => !want.includes(n)).join("; ")}]${want.every((n) => got.includes(n)) ? " (order)" : ""}`);
      } else {
        const [hh, rr] = HD1_BEFORE.rows[key]?.[lang] || [];
        if (m.header !== hh || m.rows !== rr) bad.push(`${id}: header ${m.header}px/${m.rows} rows, before ${hh}px/${rr} rows`);
        if (m.themeCycle) bad.push(`${id}: theme button shown below 1280 px`);
        const want = HD1_BEFORE.names[w < 640 ? "phone" : "desktop"][lang];
        if (!same(m.names, want)) bad.push(`${id} names changed: missing [${(want || []).filter((n) => !m.names.includes(n)).join("; ")}] new [${m.names.filter((n) => !(want || []).includes(n)).join("; ")}]`);
        // Review M1/M2: below 1280 px every header control keeps its box (±1 px) and its title / no-title state.
        if (w === 1024) {
          const pinned = await hdPinnedBoxes(w, h, lang);
          if (process.env.HD_DUMP) console.log("HD_DUMP_PINNED", id, JSON.stringify(pinned));
          const envDiffs = dsEnvDiffs(HD1_BEFORE.boxes1024["@env"], pinned.env);
          if (envDiffs.length) bad.push(`${id} pinned boxes: ${envDiffs.join("; ")}`);
          const base = HD1_BEFORE.boxes1024[lang] || [];
          if (base.length !== pinned.boxes.length) bad.push(`${id}: ${pinned.boxes.length} control boxes, before ${base.length}`);
          base.forEach((b, i) => {
            const n = pinned.boxes[i];
            if (!n) return;
            if (b.slice(0, 4).some((v, j) => Math.abs(v - n[j]) > 1)) bad.push(`${id} control ${i} (${m.names[i] || "?"}): box ${b.slice(0, 4).join(",")} → ${n.slice(0, 4).join(",")}`);
            if (b[4] !== n[4]) bad.push(`${id} control ${i} (${m.names[i] || "?"}): title ${b[4] ? "removed" : "added"} below 1280 px`);
          });
        }
      }
      if (m.more) more = m.more;
    }
    if (!more) bad.push("1366 en: no tooltip / theme measurements");
    else {
      for (const t of more.titles) if (t.missing || !t.title || t.title !== t.label || t.text) bad.push(`icon button ${t.sel}: ${t.missing ? "missing" : `title "${t.title}" vs name "${t.label}"${t.text ? ", shows text" : ""}`}`);
      // Review M6/M3: every icon-only control shows its name as a tooltip on keyboard focus, and is not described by it.
      for (const f of more.focusTips) {
        if (f.missing || !f.focused || f.tip !== f.name) bad.push(`focus tooltip ${f.sel}: ${f.missing ? "missing" : `tooltip "${f.tip}" vs name "${f.name}"${f.focused ? "" : " (not focused)"}`}`);
        if (f.echo) bad.push(`focus tooltip ${f.sel}: aria-describedby repeats the name "${f.name}"`);
      }
      const seq = more.cycle.map((x) => x.current).join(">");
      const names = more.cycle.map((x) => x.name);
      if (seq !== "system>light>dark>system" || names[0] !== "Theme: System (next: Light)" || names[1] !== "Theme: Light (next: Dark)" || names[2] !== "Theme: Dark (next: System)" || more.cycle[1].theme !== "light" || more.cycle[2].theme !== "dark") bad.push(`theme cycle: ${JSON.stringify(more.cycle)}`);
    }
    record("HD-1", "Header control ribbon: exactly 2 rows at 1280/1366/1440/1920 px in en, de, ar and ru, and at 1280 px in ru/de/fr with a 24-character workspace name; every control kept with its accessible name in keyboard = visual order (theme radios → one button cycling System → Light → Dark); icon buttons have hover (title) and keyboard-focus tooltips, not announced twice; nothing overflows; at 1024 px every control box (±1 px, DS pinned environment, text masked) and title state unchanged; 1024 and 390 px header height, row count and names unchanged",
      bad.length === 0, bad.length ? bad.slice(0, 14).join(" | ") : { rows: ev, theme: more.cycle.map((x) => x.current).join(" → "), focusTips: more.focusTips.length });
  }
  /* acceptance-ids: DS-1, DS-2 — layout at rest vs the baselines in tools/e2e/baselines/ (DS-2: v2.7.0-web; DS-1: re-captured for spec §3 item 9) */
  if (!HD_ONLY && !BK_ONLY) {
    const baseFile = path.join(__dirname, "baselines", "ds-1.json");
    const base = fs.existsSync(baseFile) ? JSON.parse(fs.readFileSync(baseFile, "utf8")) : null;
    const now = await ds1Snapshot();
    const diffs = base ? [...dsEnvDiffs(base["@env"], now["@env"]), ...dsCompare(base, now)] : ["no baseline"];
    record("DS-1", `Main screen at rest: header, controls, list toolbar, columns, rows and footer within ±${DS_TOLERANCE_PX} px of the baseline (v2.7.0; re-captured 16 Nov 2026 for the two-line header, spec §3 item 9); default colours unchanged (text masked, clock frozen, FX mocked)`,
      diffs.length === 0, diffs.length ? diffs.slice(0, 12).join(" | ") : `${Object.keys(now.boxes).length} boxes`);
  }
  if (!HD_ONLY && !BK_ONLY) {
    const baseFile = path.join(__dirname, "baselines", "ds-2.json");
    const base = fs.existsSync(baseFile) ? JSON.parse(fs.readFileSync(baseFile, "utf8")) : null;
    const now = await ds2Snapshot();
    const diffs = base ? [...dsEnvDiffs(base["@env"], now["@env"]), ...["detail", "paper", "ledger"].flatMap((k) => (base[k] ? dsCompare(base[k], now[k], `${k} `) : [`${k}: no baseline`]))] : ["no baseline"];
    record("DS-2", `Detail sheet (top + chart layers), paper dialog and ledger dialog at rest within ±${DS_TOLERANCE_PX} px of v2.7.0; default colours unchanged; only the §3 allowed additions excluded (text masked, clock frozen, FX mocked)`,
      diffs.length === 0, diffs.length ? `${diffs.length} differences: ${diffs.slice(0, 12).join(" | ")}` : ["detail", "paper", "ledger"].map((k) => `${k} ${Object.keys(now[k].boxes).length}`).join(", ") + " boxes");
  }

  await dsBrowserClose();
  await browser.close();
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ at: new Date().toISOString(), base: BASE, results }, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
