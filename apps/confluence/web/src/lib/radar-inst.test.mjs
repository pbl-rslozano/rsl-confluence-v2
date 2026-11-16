// CFTC COT, ETF CSV import, DefiLlama stablecoin supply and the radar store — v2.8 Step 4a (WP25, Task 3).
// Run: npm run test:radar-inst   (node scripts/run-engine-tests.mjs radar-inst.test.mjs)
//
// Fixtures: field names and value formats come from the follow-up probe of RD-PROBE-1 (16 Nov 2026, from the
// deployed app's origin): CFTC gpe5-46if rows carry numbers as strings, dates as "YYYY-MM-DDT00:00:00.000", and the
// group fields have no `_all` suffix; stablecoincharts/all dates are strings of UNIX seconds. The numbers are generated.
import { CFTC_CODES, CFTC_GATE_LIMIT, CFTC_GATE_WINDOW_MS, cftcCooldown, cotUrl, fetchCot, parseCotRows, resetCftcForTests, setCftcClockForTests } from "./radar/cftc.ts";
import { LLAMA_GATE_LIMIT, fetchStablecoinSupply, llamaCooldown, parseSupply, resetLlamaForTests, setLlamaClockForTests } from "./radar/stablecoins.ts";
import { etfDailyTotals, isFormulaLike, parseEtfCsv } from "./radar/etf-csv.ts";
import { isFresh, loadEtfRows, loadRadarCache, mergeEtfRows, saveCotCache, saveEtfRows, saveSupplyCache, supplyFreshForDay, RADAR_CACHE_ID } from "./radar/store.ts";
import { RateLimitError } from "./market-client.ts";

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} ${extra}`); }
};
const realFetch = globalThis.fetch;
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const row = (date, code, o = {}) => ({
  report_date_as_yyyy_mm_dd: `${date}T00:00:00.000`, cftc_contract_market_code: code, open_interest_all: "21450",
  asset_mgr_positions_long: "5000", asset_mgr_positions_short: "1200", lev_money_positions_long: "3000", lev_money_positions_short: "7000", ...o,
});

// fake clock: sleep advances time
const fakeClock = (t0 = 1_000_000) => { const c = { t: t0, now: () => c.t, sleep: async (ms) => { c.t += ms; } }; return c; };

try {
  /* ---------- CFTC ---------- */
  const two = [row("2026-11-03", "133741"), row("2026-10-27", "133741", { asset_mgr_positions_long: "4500", asset_mgr_positions_short: "1000", lev_money_positions_long: "3500", lev_money_positions_short: "6000" })];
  const r = parseCotRows(two);
  ok("cot parses two reports", r && r.asset === "BTC" && r.reportDate === "2026-11-03" && r.openInterest === 21450);
  ok("cot asset managers net and change", r.assetManagers.long === 5000 && r.assetManagers.short === 1200 && r.assetManagers.net === 3800 && r.assetManagers.netChg === 3800 - 3500);
  ok("cot leveraged funds net and change", r.leveragedFunds.net === -4000 && r.leveragedFunds.netChg === -4000 - -2500);
  ok("cot rows in any order", parseCotRows([...two].reverse())?.reportDate === "2026-11-03");
  ok("cot one row: netChg null", parseCotRows([two[0]]).assetManagers.netChg === null);
  ok("cot ETH code", parseCotRows([row("2026-11-03", "146021")])?.asset === "ETH");
  ok("cot unknown contract is null", parseCotRows([row("2026-11-03", "999999")]) === null);
  ok("cot prior row of another contract is not used", parseCotRows([row("2026-11-03", "133741"), row("2026-10-27", "146021")]).assetManagers.netChg === null);

  const noShort = parseCotRows([row("2026-11-03", "133741", { lev_money_positions_short: undefined }), two[1]]);
  ok("cftc rows with missing fields: lev money null, asset managers kept", noShort.leveragedFunds === null && noShort.assetManagers.net === 3800);
  ok("cftc non-numeric field gives null group", parseCotRows([row("2026-11-03", "133741", { asset_mgr_positions_long: "n/a" })]).assetManagers === null);
  ok("cftc negative position gives null group", parseCotRows([row("2026-11-03", "133741", { asset_mgr_positions_long: "-5" })]).assetManagers === null);
  ok("cftc bad prior group: netChg null", parseCotRows([row("2026-11-03", "133741"), row("2026-10-27", "133741", { asset_mgr_positions_short: "x" })]).assetManagers.netChg === null);
  ok("cftc [] is null", parseCotRows([]) === null);
  ok("cftc junk is null", parseCotRows([null, 5, "x", { report_date_as_yyyy_mm_dd: "2026-13-40" }]) === null && parseCotRows(null) === null);
  ok("cftc bad open interest is null", parseCotRows([row("2026-11-03", "133741", { open_interest_all: "abc" })]).openInterest === null);

  const url = new URL(cotUrl("BTC"));
  ok("cftc url host and path", url.origin === "https://publicreporting.cftc.gov" && url.pathname === "/resource/gpe5-46if.json");
  ok("cftc url query decodes to the brief's query", url.searchParams.get("$where") === "cftc_contract_market_code='133741'" && url.searchParams.get("$order") === "report_date_as_yyyy_mm_dd DESC" && url.searchParams.get("$limit") === "2");
  ok("cftc url has no raw space or quote-breaking chars", !/[ ]/.test(cotUrl("ETH")) && cotUrl("ETH").includes("146021"));
  ok("cftc codes", CFTC_CODES.BTC === "133741" && CFTC_CODES.ETH === "146021");

  // fetch + cooldown + gate
  resetCftcForTests();
  let seen = [];
  globalThis.fetch = async (input, init) => { seen.push({ u: String(input), init }); return json(two); };
  const f1 = await fetchCot("BTC");
  ok("fetchCot returns the report", f1?.reportDate === "2026-11-03" && seen.length === 1);
  ok("fetchCot is keyless and credential-free", seen[0].init.credentials === "omit" && !("authorization" in (seen[0].init.headers ?? {})) && !/X-App-Token|\$\$app_token/i.test(seen[0].u));
  globalThis.fetch = async () => json([row("2026-11-03", "146021")]);
  ok("fetchCot rejects a mismatched contract", (await fetchCot("BTC")) === null);
  globalThis.fetch = async () => json({ error: true });
  ok("fetchCot non-array body is null", (await fetchCot("BTC")) === null);
  globalThis.fetch = async () => json({}, 500);
  let e5 = null; try { await fetchCot("BTC"); } catch (e) { e5 = e; }
  ok("fetchCot 500 throws a plain error", e5 && !(e5 instanceof RateLimitError));
  let eBad = null; try { await fetchCot("DOGE"); } catch (e) { eBad = e; }
  ok("fetchCot refuses other assets", !!eBad);

  const c1 = fakeClock(); setCftcClockForTests(c1);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return json({}, 429, { "retry-after": "120" }); };
  let e429 = null; try { await fetchCot("BTC"); } catch (e) { e429 = e; }
  ok("cftc 429 throws RateLimitError with retry-after", e429 instanceof RateLimitError && e429.retryAfterMs === 120_000);
  ok("cftc cooldown is set", cftcCooldown() === 120_000);
  const before = calls; let eCool = null; try { await fetchCot("ETH"); } catch (e) { eCool = e; }
  ok("cftc cooling: no request is made", eCool instanceof RateLimitError && calls === before);
  c1.t += 121_000;
  ok("cftc cooldown ends", cftcCooldown() === 0);
  globalThis.fetch = async () => { calls++; return json({}, 429); };
  try { await fetchCot("BTC"); } catch (e) { e429 = e; }
  ok("cftc 429 without header: 60 s", e429.retryAfterMs === 60_000);

  resetCftcForTests(); const c2 = fakeClock(); setCftcClockForTests(c2);
  globalThis.fetch = async () => json(two);
  const t0 = c2.t;
  for (let i = 0; i < CFTC_GATE_LIMIT + 1; i++) await fetchCot("BTC");
  ok("cftc gate: 3rd request waits for the window", c2.t - t0 >= CFTC_GATE_WINDOW_MS && CFTC_GATE_LIMIT === 2);

  /* ---------- stablecoin supply ---------- */
  const D = 86_400;
  const pt = (sec, usd, extra = {}) => ({ date: String(sec), totalCirculating: { peggedUSD: usd }, totalCirculatingUSD: { peggedUSD: usd, peggedEUR: 5e9 }, totalMintedUSD: {}, totalBridgedToUSD: {}, ...extra });
  const base = 1794787200; // a UTC midnight (real last element of the probe)
  const s = parseSupply([pt(base + D, 288e9), pt(base - D, 286e9), pt(base, 287090877644.08)]);
  ok("supply sorted ascending, UTC midnight ms", s.length === 3 && s[0].day === (base - D) * 1000 && s[2].day === (base + D) * 1000 && s[1].usd === 287090877644.08 && s.every((p) => p.day % 86_400_000 === 0));
  const gaps = parseSupply([
    pt(base, 1e11), pt(base + D, NaN), { date: String(base + 2 * D), totalCirculatingUSD: { peggedUSD: "x" } }, { date: String(base + 3 * D) },
    { date: "abc", totalCirculatingUSD: { peggedUSD: 5 } }, null, 7, pt(base + 4 * D, -1), pt(base + 5 * D, Infinity), pt(base + 6 * D, 2e11),
  ]);
  ok("supply series with gaps: non-finite and bad entries dropped", gaps.length === 2 && gaps[0].usd === 1e11 && gaps[1].usd === 2e11);
  const dup = parseSupply([pt(base + 100, 1e11), pt(base + 5000, 2e11), pt(base + D, 3e11)]);
  ok("supply duplicate days removed (last entry wins)", dup.length === 2 && dup[0].usd === 2e11 && dup[1].usd === 3e11);
  ok("supply non-array is []", sameJson(parseSupply({}), []) && sameJson(parseSupply(null), []));
  ok("supply uses peggedUSD, not other pegs", parseSupply([{ date: String(base), totalCirculatingUSD: { peggedEUR: 9 } }]).length === 0);

  resetLlamaForTests();
  seen = [];
  globalThis.fetch = async (input, init) => { seen.push({ u: String(input), init }); return json([pt(base, 1e11)]); };
  const fs = await fetchStablecoinSupply();
  ok("fetchStablecoinSupply path and credentials", fs.length === 1 && seen[0].u === "https://stablecoins.llama.fi/stablecoincharts/all" && seen[0].init.credentials === "omit");
  const c3 = fakeClock(); setLlamaClockForTests(c3);
  globalThis.fetch = async () => json({}, 429, { "retry-after": "30" });
  let l429 = null; try { await fetchStablecoinSupply(); } catch (e) { l429 = e; }
  ok("llama 429 starts a cooldown", l429 instanceof RateLimitError && llamaCooldown() === 30_000);
  let lc = 0; globalThis.fetch = async () => { lc++; return json([]); };
  let lCool = null; try { await fetchStablecoinSupply(); } catch (e) { lCool = e; }
  ok("llama cooling: no request is made", lCool instanceof RateLimitError && lc === 0);
  globalThis.fetch = async () => json({}, 503);
  c3.t += 31_000;
  let l503 = null; try { await fetchStablecoinSupply(); } catch (e) { l503 = e; }
  ok("llama 503 is a plain error", l503 && !(l503 instanceof RateLimitError) && LLAMA_GATE_LIMIT === 2);

  /* ---------- ETF CSV ---------- */
  const good = "date,issuer,flow_usd\n2026-11-03,IBIT,120500000\n2026-11-03,FBTC,-45200000.5\n2026-11-04,IBIT,0\n";
  const g = parseEtfCsv(good);
  ok("etf csv: a good file round-trips", g.rejected === 0 && g.duplicates === 0 && sameJson(g.rows, [
    { date: "2026-11-03", issuer: "IBIT", flowUsd: 120500000 }, { date: "2026-11-03", issuer: "FBTC", flowUsd: -45200000.5 }, { date: "2026-11-04", issuer: "IBIT", flowUsd: 0 },
  ]));
  ok("etf csv: header is case-insensitive, CRLF and BOM accepted", parseEtfCsv("﻿Date,Issuer,FLOW_USD\r\n2026-11-03,IBIT,5\r\n").rows.length === 1);
  const bad = parseEtfCsv([
    "date,issuer,flow_usd", "2026-11-03,IBIT,1", "2026-11-03,=SUM(1),5", "2026-11-03,FBTC,+cmd", "2026-13-01,ARKB,5", "2026-02-30,ARKB,5",
    "2026-11-03,BITB,1e12", "2026-11-03,BITB,100000000001", "2026-11-03,HODL,@x", "\t2026-11-03,HODL,5", "2026-11-03,EZBC,-cmd|calc",
    "2026-11-03,<img src=x>,5", "2026-11-03,,5", "2026-11-03,BRRR", "2026-11-03,BRRR,5,6", "2026-11-03,BTCO,abc", "2026-11-03,-BTCW,5",
  ].join("\n"));
  ok("etf csv: formulas, bad dates and 1e12 rejected and counted", bad.rows.length === 1 && bad.rejected === 15, `${bad.rejected} ${bad.rows.length}`);
  ok("etf csv: bound is inclusive at 1e11", parseEtfCsv("date,issuer,flow_usd\n2026-11-03,A,1e11\n2026-11-03,B,-100000000000\n").rows.length === 2);
  ok("etf csv: negative number is not a formula, +5 is fine", parseEtfCsv("date,issuer,flow_usd\n2026-11-03,A,-5\n2026-11-03,B,+5\n").rejected === 0);
  const dups = parseEtfCsv("date,issuer,flow_usd\n2026-11-03,IBIT,1\n2026-11-03,FBTC,2\n2026-11-03,IBIT,9\n");
  ok("etf csv: duplicate (date, issuer) counts 1 and the last wins", dups.duplicates === 1 && dups.rows.length === 2 && dups.rows.find((x) => x.issuer === "IBIT").flowUsd === 9);
  ok("etf csv: missing header rejects everything", sameJson(parseEtfCsv("2026-11-03,IBIT,5\n2026-11-04,IBIT,6"), { rows: [], rejected: 2, duplicates: 0 }));
  ok("etf csv: empty and non-string", parseEtfCsv("").rejected === 0 && parseEtfCsv(null).rows.length === 0);
  ok("etf csv: issuer stays plain text", parseEtfCsv("date,issuer,flow_usd\n2026-11-03,Grayscale Trust.,5\n").rows[0].issuer === "Grayscale Trust.");
  ok("isFormulaLike", isFormulaLike("=1") && isFormulaLike("@a") && isFormulaLike("+a") && isFormulaLike("-a") && isFormulaLike("\tx") && isFormulaLike("\rx") && !isFormulaLike("-1") && !isFormulaLike("+1") && !isFormulaLike("x=") && !isFormulaLike(""));

  /* ---------- ETF totals ---------- */
  const rows3 = [
    { date: "2026-11-03", issuer: "IBIT", flowUsd: 100 }, { date: "2026-11-03", issuer: "FBTC", flowUsd: -30 }, { date: "2026-11-03", issuer: "ARKB", flowUsd: 5 },
    { date: "2026-11-04", issuer: "IBIT", flowUsd: 50 }, { date: "2026-11-04", issuer: "FBTC", flowUsd: 20 },
    { date: "2026-11-05", issuer: "constructor", flowUsd: 7 }, { date: "2026-11-05", issuer: "constructor", flowUsd: 1 },
  ];
  const tot = etfDailyTotals(rows3);
  ok("etf daily totals over 3 issuers", tot.length === 3 && tot[0].date === "2026-11-03" && tot[0].total === 75 && sameJson(tot[0].byIssuer, { IBIT: 100, FBTC: -30, ARKB: 5 }) && tot[1].total === 70);
  ok("etf daily totals: issuer named like an Object method", tot[2].byIssuer.constructor === 8 && tot[2].total === 8);
  ok("etf daily totals: days limit keeps the newest", sameJson(etfDailyTotals(rows3, 2).map((d) => d.date), ["2026-11-04", "2026-11-05"]) && etfDailyTotals(rows3, 0).length === 0 && etfDailyTotals([]).length === 0);

  /* ---------- store ---------- */
  const mem = () => { const m = new Map(); return { m, get: async (c, i) => m.get(`${c}/${i}`) ?? null, put: async (c, i, d) => { m.set(`${c}/${i}`, JSON.parse(JSON.stringify(d))); } }; };
  const port = mem();
  ok("empty store reads empty", sameJson(await loadRadarCache(port), { cot: {}, supply: null }) && (await loadEtfRows(port)).length === 0);
  await saveCotCache(port, r, 5000);
  await saveSupplyCache(port, s, 6000);
  const back = await loadRadarCache(port);
  ok("cache round-trips cot and supply with fetch time", back.cot.BTC.at === 5000 && sameJson(back.cot.BTC.report, r) && back.supply.at === 6000 && sameJson(back.supply.points, s));
  port.m.set(`meta/${RADAR_CACHE_ID}`, { cot: { BTC: { at: 1, report: { asset: "ETH", reportDate: "x" } } }, supply: { at: 1, points: [{ day: "a", usd: 1 }] } });
  ok("a bad cache doc reads empty", sameJson(await loadRadarCache(port), { cot: {}, supply: null }));
  const bp = { get: async () => { throw new Error("x"); }, put: async () => { throw new Error("x"); } };
  ok("a failing port never throws", sameJson(await loadRadarCache(bp), { cot: {}, supply: null }) && (await saveCotCache(bp, r, 1)) === false && (await saveEtfRows(bp, [])) === null && (await loadEtfRows(bp)).length === 0);
  ok("isFresh", isFresh(1000, 500, 1400) && !isFresh(1000, 500, 1500) && !isFresh(2000, 500, 1000) && !isFresh(null, 5, 1));
  ok("supplyFreshForDay is the UTC day", supplyFreshForDay(Date.UTC(2026, 10, 16, 1), Date.UTC(2026, 10, 16, 23)) && !supplyFreshForDay(Date.UTC(2026, 10, 15, 23), Date.UTC(2026, 10, 16, 0, 1)));

  const merged = mergeEtfRows([{ date: "2026-11-03", issuer: "IBIT", flowUsd: 1 }], [{ date: "2026-11-03", issuer: "IBIT", flowUsd: 2 }, { date: "2026-11-02", issuer: "A", flowUsd: 3 }]);
  ok("mergeEtfRows: imported wins, sorted", merged.length === 2 && merged[0].date === "2026-11-02" && merged[1].flowUsd === 2);
  const many = Array.from({ length: 900 }, (_, i) => ({ date: new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10), issuer: "A", flowUsd: i }));
  const capped = mergeEtfRows([], many);
  ok("mergeEtfRows keeps the newest 800 days", capped.length === 800 && capped[799].flowUsd === 899 && capped[0].flowUsd === 100);
  const saved = await saveEtfRows(port, good ? parseEtfCsv(good).rows : []);
  ok("saveEtfRows persists and reloads", saved.length === 3 && sameJson(await loadEtfRows(port), saved));
  port.m.set("meta/radar-etf", { rows: [{ date: "2026-11-03", issuer: "<b>x</b>", flowUsd: 1 }, { date: "2026-11-03", issuer: "OK", flowUsd: 1e12 }, { date: "2026-11-03", issuer: "OK", flowUsd: 2 }, 5] });
  ok("stored ETF rows are re-validated", sameJson(await loadEtfRows(port), [{ date: "2026-11-03", issuer: "OK", flowUsd: 2 }]));
} finally {
  globalThis.fetch = realFetch;
  resetCftcForTests(); resetLlamaForTests();
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
