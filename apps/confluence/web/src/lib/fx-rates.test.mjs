// Display-currency rates — v2.7 (plan WP13, acceptance FX-1…FX-5, FX-8).
// Run: node scripts/run-engine-tests.mjs fx-rates.test.mjs
// Fixtures are trimmed from the live probe of 11 Nov 2026 (docs/research/evidence/fx-quotes-probe-2026-11-11.md).
import {
  parseFrankfurterRates, parseFrankfurterCurrencies, parseFawazRates, pegTable, convert, canConvert, isStale,
  usdtDeviationPct, rateKind, autoCurrency, refreshRates, FRANKFURTER_RATES, FAWAZ_URLS, FX_HOSTS,
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
ok("auto: ar-SA → SAR, fil-PH → PHP, en-US → USD, ja → JPY, xx → USD",
  autoCurrency(["ar-SA"]) === "SAR" && autoCurrency(["fil-PH"]) === "PHP" && autoCurrency(["en-US"]) === "USD" && autoCurrency(["ja"]) === "JPY" && autoCurrency(["xx"]) === "USD");

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

console.log(`\nFX suite: ${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
