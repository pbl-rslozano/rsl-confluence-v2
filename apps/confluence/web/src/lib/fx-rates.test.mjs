// Display-currency rates — v2.7 (plan WP13, acceptance FX-1…FX-5, FX-8).
// Run: node scripts/run-engine-tests.mjs fx-rates.test.mjs
// Fixtures are trimmed from the live probe of 11 Nov 2026 (docs/research/evidence/fx-quotes-probe-2026-11-11.md).
import {
  parseFrankfurterRates, parseFrankfurterCurrencies, parseFawazRates, pegTable, convert, canConvert, isStale,
  usdtDeviationPct, rateKind, autoCurrency, refreshRates, FRANKFURTER_RATES, FAWAZ_URLS, FX_HOSTS,
  parseEcbRates, parseErApiRates, parseFloatRates, parseCustomRates, FX_SOURCES, verifyUrl, saveCustomTable, cachedTable,
  ECB_RATES, ERAPI_RATES, FLOATRATES_RATES, fxCredit,
} from "./fx-rates.ts";
import { formatMoney, formatMoneyCompact, minorUnits } from "./money.ts";

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log("  ok   - " + name); }
  else { failed++; console.log("  FAIL - " + name + (extra ? "  [" + extra + "]" : "")); }
};

const D = "2026-11-11";
const FIAT = ["AED", "ARS", "EUR", "HKD", "JPY", "KWD", "NGN", "PHP", "QAR", "SAR", "VND", "GBP", "INR"];
const RATES = { AED: 3.6725, ARS: 1546.23, EUR: 0.89234, HKD: 7.8488, JPY: 158.24, KWD: 0.3093, NGN: 1347.37, PHP: 63, QAR: 3.64, SAR: 3.75, VND: 25648, GBP: 0.7612, INR: 88.71 };
const frankRows = [
  ...Object.entries(RATES).map(([quote, rate]) => ({ date: D, base: "USD", quote, rate })),
  { date: "2026-11-10", base: "USD", quote: "USDT", rate: 1.0013 },
  { date: "2026-11-10", base: "USD", quote: "ADA", rate: 5.7593 },
  { date: D, base: "USD", quote: "XAU", rate: 0.00024 },
  { date: D, base: "USD", quote: "BAD", rate: -1 },
];
const currencies = [
  ...FIAT.map((c) => ({ iso_code: c, name: c + " name", type: "currency" })),
  { iso_code: "USD", name: "US Dollar", type: "currency" },
  { iso_code: "ADA", name: "Cardano", type: "crypto" },
  { iso_code: "XAU", name: "Gold", type: "metal" },
];

/* FX-1 Frankfurter parser */
const list = parseFrankfurterCurrencies(currencies);
ok("FX-1 currency list keeps fiat only (no crypto, no metals)", list.length === FIAT.length + 1 && !list.some((c) => ["ADA", "XAU"].includes(c.code)));
const fiat = new Set(list.map((c) => c.code));
const t = parseFrankfurterRates(frankRows, fiat, 1_000);
ok("FX-1 rates parsed, USD = 1, pegs exact", t && t.rates.USD === 1 && t.rates.SAR === 3.75 && t.rates.AED === 3.6725);
ok("FX-1 crypto, metals and invalid rows dropped", t && !("ADA" in t.rates) && !("XAU" in t.rates) && !("BAD" in t.rates));
ok("FX-1 USDT row kept aside as information", t?.usdtPerUsd === 1.0013 && !("USDT" in (t?.rates ?? {})));
ok("FX-1 asOf = newest date, source labelled", t?.asOf === D && t?.source === "frankfurter");
ok("FX-1 partial answer is rejected", parseFrankfurterRates(frankRows.slice(0, 3), fiat) === null && parseFrankfurterRates({}, fiat) === null);

/* FX-2 fallback parser */
const fawaz = { date: "2026-11-10", usd: Object.fromEntries([...Object.entries(RATES).map(([k, v]) => [k.toLowerCase(), v]), ["usdt", 1.0014], ["btc", 0.0000135], ["1inch", 4]]) };
const f = parseFawazRates(fawaz, fiat, 2_000);
ok("FX-2 fawazahmed0 parsed, fiat only, labelled", f && f.source === "fawazahmed0" && f.rates.PHP === 63 && !("BTC" in f.rates) && f.usdtPerUsd === 1.0014);

/* FX-3 peg table */
const p = pegTable(3_000);
ok("FX-3 offline peg table: SAR, AED, QAR, OMR, BHD, JOD", p.rates.SAR === 3.75 && p.rates.OMR === 0.3845 && p.rates.BHD === 0.376 && p.source === "peg");
ok("FX-3 peg table cannot show PHP (no invented rate)", !canConvert("USD", "PHP", p) && canConvert("USD", "SAR", p));

/* FX-4 conversion through USD */
ok("FX-4 USD → SAR", convert(100, "USD", "SAR", t) === 375);
ok("FX-4 PHP → SAR cross rate", Math.abs(convert(63, "PHP", "SAR", t) - 3.75) < 1e-9);
ok("FX-4 EUR → JPY cross rate", Math.abs(convert(1, "EUR", "JPY", t) - 158.24 / 0.89234) < 1e-9);
ok("FX-4 same currency untouched; unknown → NaN", convert(5, "PHP", "PHP", null) === 5 && Number.isNaN(convert(1, "USD", "ZZZ", t)));
ok("FX-4 USDT deviation reported, not applied", Math.abs(usdtDeviationPct(t) - (1 / 1.0013 - 1) * 100) < 1e-9);

/* labels */
ok("labels: peg / band / official / reference", rateKind("SAR") === "peg" && rateKind("HKD") === "band" && rateKind("ARS") === "official" && rateKind("JPY") === "reference");

/* FX-8 stale */
const day = 86_400_000;
const fresh = { ...t, asOf: "2026-11-11", fetchedAt: Date.parse("2026-11-11T12:00:00Z") };
ok("FX-8 not stale after one day", !isStale(fresh, Date.parse("2026-11-12T12:00:00Z")));
ok("FX-8 stale after three days", isStale(fresh, Date.parse("2026-11-11T12:00:00Z") + 4 * day));
ok("FX-8 peg table never 'stale'", !isStale(p, Date.now() + 100 * day));

/* automatic currency */
ok("auto: ar-SA → SAR, fil-PH → PHP, en-US → USD, ja → JPY, xx → USD (no known time zone)",
  autoCurrency(["ar-SA"], "UTC") === "SAR" && autoCurrency(["fil-PH"], "UTC") === "PHP" && autoCurrency(["en-US"], "UTC") === "USD" && autoCurrency(["ja"], "UTC") === "JPY" && autoCurrency(["xx"], "UTC") === "USD");
ok("auto: the device time zone wins — English in Riyadh → SAR, Arabic in Riyadh → SAR (not EGP)",
  autoCurrency(["en-US"], "Asia/Riyadh") === "SAR" && autoCurrency(["ar"], "Asia/Riyadh") === "SAR" && autoCurrency(["en"], "Asia/Manila") === "PHP");

/* FX-5 formatting */
ok("FX-5 USD keeps the v2.6 look", formatMoney(64250.5, "USD") === "$64,250.50" && formatMoney(1.2345678, "USD") === "$1.2346" && formatMoney(0.5, "USD") === "$0.50000");
ok("FX-5 JPY has no minor unit", formatMoney(10166000, "JPY") === "¥10,166,000", formatMoney(10166000, "JPY"));
ok("FX-5 KWD has three", formatMoney(19872.1, "KWD") === "KWD 19,872.100", formatMoney(19872.1, "KWD"));
ok("FX-5 SAR and PHP symbols", formatMoney(240937.5, "SAR") === "SAR 240,937.50" && formatMoney(4789170.5, "PHP") === "₱4,789,170.50", formatMoney(240937.5, "SAR") + " " + formatMoney(4789170.5, "PHP"));
ok("FX-5 tiny prices keep significant digits", formatMoney(0.00001234, "SAR") === "SAR 0.00001234", formatMoney(0.00001234, "SAR"));
ok("FX-5 zero and NaN", formatMoney(0, "USD") === "$0.00" && formatMoney(NaN, "USD") === "—");
ok("FX-5 compact volume", formatMoneyCompact(1.5e9, "USD") === "$1.50B" && formatMoneyCompact(2.5e6, "SAR") === "SAR 2.50M");
ok("FX-5 minor units", minorUnits("JPY") === 0 && minorUnits("KWD") === 3 && minorUnits("EUR") === 2);

/* FX-2 fetch order with a fake fetcher (no network) */
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const seen = [];
const resp = (body, status = 200) => new Response(JSON.stringify(body), { status });
let table = await refreshRates({ fetcher: async (u) => { seen.push(u); return u.includes("/v2/currencies") ? resp(currencies) : u === FRANKFURTER_RATES ? resp(frankRows) : resp({}, 500); }, now: 10_000 });
ok("FX-2 primary Frankfurter used when it answers", table.source === "frankfurter" && seen.includes(FRANKFURTER_RATES) && !seen.some((u) => u.includes("jsdelivr")));
seen.length = 0;
table = await refreshRates({ fetcher: async (u) => { seen.push(u); return resp({}, 500); }, now: 20_000 });
ok("FX-2 within 6 h the cached table is reused (no request)", table.source === "frankfurter" && seen.length === 0);
store.clear(); seen.length = 0;
table = await refreshRates({ force: true, fetcher: async (u) => { seen.push(u); if (u.includes("/v2/currencies")) return resp(currencies); if (u === FAWAZ_URLS[1]) return resp(fawaz); return resp({}, 503); }, now: 30_000 });
ok("FX-2 Frankfurter down → jsDelivr → pages.dev mirror", table.source === "fawazahmed0" && seen.indexOf(FAWAZ_URLS[0]) < seen.indexOf(FAWAZ_URLS[1]));
store.clear();
table = await refreshRates({ force: true, fetcher: async () => { throw new TypeError("Failed to fetch"); }, now: 40_000 });
ok("FX-3 everything offline, nothing cached → peg table", table.source === "peg");
ok("hosts: every URL is on FX_HOSTS", [FRANKFURTER_RATES, ...FAWAZ_URLS].every((u) => FX_HOSTS.includes(new URL(u).origin)));


/* ===== owner request 11 Nov 2026: four alternative sources + custom (FX-9…FX-13) ===== */
const curNames = ["ARS", "AUD", "BGN", "GBP", "INR", "JPY", "PHP", "SGD", "USD", "CHF", "CAD", "CNY", "HKD"];
const ecb = {
  structure: { dimensions: {
    series: [{ id: "FREQ", values: [{ id: "D" }] }, { id: "CURRENCY", values: curNames.map((id) => ({ id })) }, { id: "CURRENCY_DENOM", values: [{ id: "EUR" }] }, { id: "EXR_TYPE", values: [{ id: "SP00" }] }, { id: "EXR_SUFFIX", values: [{ id: "A" }] }],
    observation: [{ id: "TIME_PERIOD", values: [{ id: "2008-12-31" }, { id: "2026-11-10" }] }],
  } },
  dataSets: [{ series: Object.fromEntries(curNames.map((c, i) => [`0:${i}:0:0:0`, { observations: c === "ARS" ? { 0: [91.5953] } : { 1: [{ USD: 1.1206, PHP: 70.6, JPY: 177.3, GBP: 0.853, INR: 99.4, BGN: 1.9558, AUD: 1.70, SGD: 1.456, CHF: 0.93, CAD: 1.557, CNY: 7.97, HKD: 8.795 }[c]] } }])) }],
};
const e = parseEcbRates(ecb, 5);
ok("FX-9 ECB: rebased to USD (EUR = 1/1.1206)", e && Math.abs(e.rates.EUR - 1 / 1.1206) < 1e-12 && Math.abs(e.rates.PHP - 70.6 / 1.1206) < 1e-9 && e.source === "ecb");
ok("FX-9 ECB: a series last seen in 2008 is dropped", e && !("ARS" in e.rates) && e.asOf === "2026-11-10");
const er = parseErApiRates({ result: "success", base_code: "USD", time_last_update_unix: 1794355352, rates: { USD: 1, AED: 3.6725, SAR: 3.75, PHP: 63.02, EUR: 0.892, JPY: 158.2, GBP: 0.761, INR: 88.7, CNY: 7.11, CAD: 1.39, AUD: 1.52 } }, 6);
ok("FX-10 ExchangeRate-API parsed with its date", er && er.rates.SAR === 3.75 && er.source === "erapi" && /^2026-11-1/.test(er.asOf), er?.asOf);
const fr = parseFloatRates(Object.fromEntries(Object.entries(RATES).map(([c, r]) => [c.toLowerCase(), { code: c, alphaCode: c, rate: String(r === 3.75 ? 3.75151668 : r), date: "Tue, 10 Nov 2026 23:59:00 GMT" }])), 7);
ok("FX-11 FloatRates parsed (its SAR is not the peg — shown as is)", fr && Math.abs(fr.rates.SAR - 3.75151668) < 1e-9 && fr.asOf === "2026-11-10" && fr.source === "floatrates");
ok("FX-12 five tested sources, each with method, terms, homepage and the exact data URL on a listed host",
  FX_SOURCES.length === 5 && FX_SOURCES.every((x) => x.method && x.terms && x.homepage.startsWith("https://") && FX_HOSTS.includes(new URL(x.dataUrl).origin)));
ok("FX-12 ExchangeRate-API carries its required attribution", FX_SOURCES.find((x) => x.id === "erapi")?.attribution?.text === "Rates By Exchange Rate API");
ok("FX-12 verify link: Frankfurter lists the banks behind one currency", verifyUrl("frankfurter", "SAR").endsWith("quotes=SAR&expand=providers") && verifyUrl("ecb", "SAR") === ECB_RATES);
const custom = { name: "My bank", url: "https://example.org/rates.json" };
const c1 = parseCustomRates({ base: "EUR", date: "2026-11-11", rates: { USD: 1.12, SAR: 4.2, PHP: 70.56 } }, custom, 8);
ok("FX-13 custom {base: EUR, rates} rebased to USD and labelled custom", c1 && c1.source === "custom" && Math.abs(c1.rates.SAR - 3.75) < 1e-9 && Math.abs(c1.rates.EUR - 1 / 1.12) < 1e-12 && c1.custom?.name === "My bank");
ok("FX-13 custom accepts Frankfurter v2, fawazahmed0 and ExchangeRate-API files", parseCustomRates(frankRows, custom)?.rates.SAR === 3.75 && parseCustomRates(fawaz, custom)?.rates.PHP === 63 && parseCustomRates({ result: "success", base_code: "USD", rates: { SAR: 3.75, AED: 3.6725, PHP: 63, EUR: 0.89, JPY: 158, GBP: 0.76, INR: 88, CNY: 7.1, CAD: 1.39, AUD: 1.5 } }, custom)?.source === "custom");
ok("FX-13 a file without rates is refused", parseCustomRates({ hello: "world" }, custom) === null && parseCustomRates("x", custom) === null);
store.clear();
saveCustomTable(c1);
ok("FX-13 custom choice never fetches; it uses the imported table", (await refreshRates({ choice: "custom", fetcher: async () => { throw new Error("must not fetch"); } })).source === "custom");
/* chosen source: no silent switch */
seen.length = 0;
let chosen = await refreshRates({ choice: "erapi", force: true, fetcher: async (u) => { seen.push(u); return resp({ result: "success", base_code: "USD", time_last_update_unix: 1794355352, rates: Object.fromEntries([["USD", 1], ...Object.entries(RATES)]) }); }, now: 50_000 });
ok("FX-10 choosing ExchangeRate-API reads only its address", chosen.source === "erapi" && seen.length === 1 && seen[0] === ERAPI_RATES);
chosen = await refreshRates({ choice: "erapi", force: true, fetcher: async () => resp({}, 503), now: 60_000 });
ok("FX-10 when the chosen source fails, its last table is kept (no silent switch)", chosen.source === "erapi" && cachedTable("erapi")?.fetchedAt === 50_000);
seen.length = 0;
chosen = await refreshRates({ choice: "floatrates", force: true, fetcher: async (u) => { seen.push(u); return resp({}, 500); }, now: 70_000 });
ok("FX-11 a chosen source that never answered → pegs, not another provider", chosen.source === "peg" && seen.every((u) => u === FLOATRATES_RATES));
/* v2.8 WP20 (licence audit): source terms and credits */
const src = (id) => FX_SOURCES.find((x) => x.id === id);
ok("WP20 Frankfurter terms are its published terms (not \"MIT licence …\")", !src("frankfurter").terms.startsWith("MIT licence") &&
  src("frankfurter").terms === "free, no key, no quotas (rate-limited against abuse); code MIT; rates are public data under each central bank's terms", src("frankfurter").terms);
ok("WP20 ECB: method, 29 currencies (PHP included; no SAR or AED), credit rebased to USD",
  src("ecb").method === "Official euro reference rates, published around 16:00 CET on TARGET working days, for information only; this app divides them by the EUR/USD rate to show a US-dollar base." &&
  src("ecb").coverage === "29 currencies (PHP included; no SAR or AED)" &&
  src("ecb").attribution?.text === "Source: ECB statistics (rebased to USD by this app)" && src("ecb").attribution?.url === "https://data.ecb.europa.eu/main-figures/ecb-reference-rates");
ok("WP20 fawazahmed0: single-maintainer project, licence not verified by us",
  src("fawazahmed0").method === "Single-maintainer project; the method and the sources are not published." &&
  src("fawazahmed0").terms === "free, no key; licence not verified by us — see the repository");
const tbl = (source) => ({ rates: { USD: 1, SAR: 3.75, PHP: 63 }, dates: {}, source, asOf: D, fetchedAt: 1 });
ok("WP20 fxCredit: ExchangeRate-API credited whenever its rates convert what is on screen",
  fxCredit(tbl("erapi"), "USD", "SAR")?.text === "Rates By Exchange Rate API" && fxCredit(tbl("erapi"), "PHP", "USD")?.url === "https://www.exchangerate-api.com");
ok("WP20 fxCredit: nothing when no value is converted, or the source needs no credit (default Frankfurter)",
  fxCredit(tbl("erapi"), "USD", "USD") === undefined && fxCredit(tbl("frankfurter"), "USD", "SAR") === undefined && fxCredit(null, "USD", "SAR") === undefined &&
  fxCredit(tbl("ecb"), "USD", "SAR")?.text === "Source: ECB statistics (rebased to USD by this app)");
ok("WP20 fix 1 fxCredit: volume-only conversion (USD volume shown in PHP on a peso market) still credits the source",
  fxCredit(tbl("erapi"), "PHP", "PHP", "PHP")?.text === "Rates By Exchange Rate API" && fxCredit(tbl("erapi"), "EUR", "EUR", "EUR")?.text === "Rates By Exchange Rate API" &&
  fxCredit(tbl("erapi"), "USD", "USD", "USD") === undefined && fxCredit(tbl("erapi"), "PHP", "PHP", "USD") === undefined);
console.log(`\nFX suite: ${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
