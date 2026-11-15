/**
 * fx-rates.ts — v2.7 (plan WP13, ADR-0015): display currency rates.
 *
 * DISPLAY ONLY. Engine, scan pipeline, ledger, paper, risk engine, recorder and
 * MCP never import this file (release check R21). Prices are converted when they
 * are formatted, nothing else.
 *
 * Order (one source per refresh; the next only when the previous failed):
 *   1. Frankfurter v2 — central-bank reference rates blended per currency, the
 *      contributing banks listed per currency (`expand=providers`). Keyless, CORS.
 *   2. fawazahmed0 currency-api (jsDelivr, then its pages.dev mirror) — community
 *      aggregate; method not published, so it is labelled as such.
 *   3. Official pegs built in (SAMA, CBUAE, QCB, CBO, CBB, CBJ) — offline last resort.
 * Rates are "units of X per 1 USD". Stablecoin prices are shown at 1 USDT = 1 USD
 * (plan §13.3); the USDT/USD reading is shown next to it, never multiplied in.
 */

export const FRANKFURTER_RATES = "https://api.frankfurter.dev/v2/rates?base=USD";
export const FRANKFURTER_CURRENCIES = "https://api.frankfurter.dev/v2/currencies";
export const FAWAZ_URLS = [
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json",
  "https://latest.currency-api.pages.dev/v1/currencies/usd.min.json",
] as const;
export const ECB_RATES = "https://data-api.ecb.europa.eu/service/data/EXR/D..EUR.SP00.A?lastNObservations=1&format=jsondata&detail=dataonly";
export const ERAPI_RATES = "https://open.er-api.com/v6/latest/USD";
export const FLOATRATES_RATES = "https://www.floatrates.com/daily/usd.json";
/** Every host this module may contact (ADR-0003 v2.7; R8 reads public-hosts.ts, which lists them). */
export const FX_HOSTS = [
  "https://api.frankfurter.dev", "https://cdn.jsdelivr.net", "https://latest.currency-api.pages.dev",
  "https://data-api.ecb.europa.eu", "https://open.er-api.com", "https://www.floatrates.com",
] as const;

/* ---------------- the tested sources (owner request 11 Nov 2026: four alternatives + custom) ---------------- */
export type FxSourceId = "frankfurter" | "ecb" | "erapi" | "fawazahmed0" | "floatrates";
/** What the user picks: automatic chain, one tested source, or their own (not tested) source. */
export type FxChoice = "auto" | FxSourceId | "custom";
export interface FxSourceInfo {
  id: FxSourceId;
  name: string;
  publisher: string;
  /** How the rate is made — shown in the app so the user can judge it. */
  method: string;
  coverage: string;
  cadence: string;
  terms: string;
  homepage: string;
  /** The exact address the app reads (open it to verify). */
  dataUrl: string;
  /** Required attribution, shown next to the rates when this source is used. */
  attribution?: { text: string; url: string };
}
export const FX_SOURCES: readonly FxSourceInfo[] = [
  {
    id: "frankfurter", name: "Frankfurter", publisher: "Frankfurter (open source, frankfurter.dev)",
    method: "Reference rates published by central banks and official bodies, blended per currency; each rate lists the banks it came from (SAMA, BSP, ECB …); outliers are excluded; pegs are exact.",
    coverage: "about 160 currencies", cadence: "daily, after the banks publish",
    // v2.8 WP20: its published terms (frankfurter.dev, frankfurter.dev/license) — the MIT licence covers the code, not the rates.
    terms: "free, no key, no quotas (rate-limited against abuse); code MIT; rates are public data under each central bank's terms",
    homepage: "https://frankfurter.dev", dataUrl: FRANKFURTER_RATES,
  },
  {
    id: "ecb", name: "European Central Bank", publisher: "European Central Bank (ECB Data Portal)",
    method: "Official euro reference rates, published around 16:00 CET on TARGET working days, for information only; this app divides them by the EUR/USD rate to show a US-dollar base.",
    coverage: "29 currencies (PHP included; no SAR or AED)", cadence: "working days", terms: "ECB statistics, free reuse with source credit",
    homepage: "https://data.ecb.europa.eu/main-figures/ecb-reference-rates", dataUrl: ECB_RATES,
    // v2.8 WP20: the ECB's reuse terms ask for the source; the rates are rebased, so the credit says so.
    attribution: { text: "Source: ECB statistics (rebased to USD by this app)", url: "https://data.ecb.europa.eu/main-figures/ecb-reference-rates" },
  },
  {
    id: "erapi", name: "ExchangeRate-API (open access)", publisher: "ExchangeRate-API",
    method: "Mid-market rates blended by the provider from several sources (method not detailed).",
    coverage: "about 165 currencies", cadence: "once a day", terms: "free with attribution; no redistribution; heavy use is rate-limited",
    homepage: "https://www.exchangerate-api.com/docs/free", dataUrl: ERAPI_RATES,
    attribution: { text: "Rates By Exchange Rate API", url: "https://www.exchangerate-api.com" },
  },
  {
    id: "fawazahmed0", name: "fawazahmed0 currency-api", publisher: "community project on GitHub, served by jsDelivr",
    method: "Single-maintainer project; the method and the sources are not published.",
    coverage: "about 340 codes (fiat and crypto; fiat used)", cadence: "daily", terms: "free, no key; licence not verified by us — see the repository",
    homepage: "https://github.com/fawazahmed0/exchange-api", dataUrl: FAWAZ_URLS[0],
  },
  {
    id: "floatrates", name: "FloatRates", publisher: "FloatRates (floatrates.com)",
    method: "Daily rates; the method is not published (its SAR is not exactly the 3.75 peg).",
    coverage: "about 145 currencies", cadence: "daily", terms: "free feed; terms not stated",
    homepage: "https://www.floatrates.com/json-feeds.html", dataUrl: FLOATRATES_RATES,
  },
];
export function fxSourceInfo(id: string): FxSourceInfo | undefined {
  return FX_SOURCES.find((x) => x.id === id);
}
/** Address that shows how one currency's rate was made (Frankfurter lists the banks), or the raw data. */
export function verifyUrl(source: string, code: string): string {
  if (source === "frankfurter" && /^[A-Z]{3}$/.test(code)) return `https://api.frankfurter.dev/v2/rates?base=USD&quotes=${code}&expand=providers`;
  return fxSourceInfo(source)?.dataUrl ?? FRANKFURTER_RATES;
}

export const FX_REFRESH_MS = 6 * 3_600_000;
export const FX_STALE_MS = 3 * 86_400_000;
const CURRENCY_LIST_TTL_MS = 30 * 86_400_000;
const STORE_KEY = "ct-fx-rates-v1";
const LIST_KEY = "ct-fx-currencies-v1";

export type FxSource = FxSourceId | "peg" | "custom";
export interface FxTable {
  /** Units per 1 USD, ISO 4217 codes; USD = 1 always. */
  rates: Record<string, number>;
  /** Date each rate refers to (YYYY-MM-DD), when the source gives one. */
  dates: Record<string, string>;
  /** USDT per 1 USD from the source's own row, when published (information only). */
  usdtPerUsd?: number;
  source: FxSource;
  /** Custom source only: the user's name and address for it. */
  custom?: { name: string; url: string };
  /** Newest rate date in the table. */
  asOf: string;
  fetchedAt: number;
}
export interface FiatCurrency { code: string; name: string }

/* ---------------- official pegs and labels ---------------- */
export const PEGS: Record<string, { rate: number; authority: string }> = {
  SAR: { rate: 3.75, authority: "SAMA" },
  AED: { rate: 3.6725, authority: "CBUAE" },
  QAR: { rate: 3.64, authority: "QCB" },
  OMR: { rate: 0.3845, authority: "CBO" },
  BHD: { rate: 0.376, authority: "CBB" },
  JOD: { rate: 0.709, authority: "CBJ" },
};
export const BANDS: Record<string, string> = { HKD: "7.75–7.85 (HKMA)" };
/** Currencies with official and parallel market rates: the official rate is shown and said so. */
export const OFFICIAL_ONLY = new Set(["ARS", "NGN", "EGP", "LBP", "VES", "IRR", "SYP", "MMK", "SSP", "ZWG"]);
export type RateKind = "peg" | "band" | "official" | "reference";
export function rateKind(code: string): RateKind {
  if (PEGS[code]) return "peg";
  if (BANDS[code]) return "band";
  if (OFFICIAL_ONLY.has(code)) return "official";
  return "reference";
}

/** Metals and units that are not money a person prices things in. */
const NOT_DISPLAY = new Set(["XAU", "XAG", "XPT", "XPD", "XDR", "XSU", "XUA", "XBA", "XBB", "XBC", "XBD", "XTS", "XXX"]);
const ISO = /^[A-Z]{3}$/;
const valid = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/* ---------------- parsers (pure; tested on recorded responses) ---------------- */

/** Frankfurter v2 `/v2/currencies` → fiat list (type "currency" only). */
export function parseFrankfurterCurrencies(body: unknown): FiatCurrency[] {
  if (!Array.isArray(body)) return [];
  const out: FiatCurrency[] = [];
  for (const c of body as { iso_code?: unknown; name?: unknown; type?: unknown }[]) {
    const code = typeof c?.iso_code === "string" ? c.iso_code.toUpperCase() : "";
    if (c?.type !== "currency" || !ISO.test(code) || NOT_DISPLAY.has(code)) continue;
    out.push({ code, name: typeof c.name === "string" ? c.name.slice(0, 60) : code });
  }
  if (!out.some((c) => c.code === "USD")) out.push({ code: "USD", name: "US Dollar" });
  return out.sort((a, b) => a.code.localeCompare(b.code));
}

/** Frankfurter v2 `/v2/rates?base=USD` rows → table. Only codes in `fiat` (when given) are kept. */
export function parseFrankfurterRates(body: unknown, fiat?: ReadonlySet<string>, now = Date.now()): FxTable | null {
  if (!Array.isArray(body)) return null;
  const rates: Record<string, number> = { USD: 1 };
  const dates: Record<string, string> = {};
  let usdtPerUsd: number | undefined;
  let asOf = "";
  for (const r of body as { base?: unknown; quote?: unknown; rate?: unknown; date?: unknown }[]) {
    if (r?.base !== "USD" || typeof r.quote !== "string") continue;
    const date = typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : "";
    if (r.quote === "USDT" && valid(r.rate)) { usdtPerUsd = r.rate; continue; }
    if (!ISO.test(r.quote) || NOT_DISPLAY.has(r.quote) || !valid(r.rate)) continue;
    if (fiat && !fiat.has(r.quote)) continue;
    rates[r.quote] = r.rate;
    if (date) { dates[r.quote] = date; if (date > asOf) asOf = date; }
  }
  if (Object.keys(rates).length < 10) return null; // a broken or partial answer is not a rate table
  return { rates, dates, usdtPerUsd, source: "frankfurter", asOf, fetchedAt: now };
}

/** fawazahmed0 `{date, usd: {eur: 0.89, …}}` → table; lower-case codes, fiat filtered by `fiat`. */
export function parseFawazRates(body: unknown, fiat?: ReadonlySet<string>, now = Date.now()): FxTable | null {
  const b = body as { date?: unknown; usd?: Record<string, unknown> } | null;
  if (!b || typeof b !== "object" || !b.usd || typeof b.usd !== "object") return null;
  const date = typeof b.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : "";
  const rates: Record<string, number> = { USD: 1 };
  const dates: Record<string, string> = {};
  for (const [k, v] of Object.entries(b.usd)) {
    const code = k.toUpperCase();
    if (!ISO.test(code) || NOT_DISPLAY.has(code) || !valid(v)) continue;
    if (fiat ? !fiat.has(code) : false) continue;
    rates[code] = v;
    if (date) dates[code] = date;
  }
  const usdt = b.usd.usdt;
  if (Object.keys(rates).length < 10) return null;
  return { rates, dates, usdtPerUsd: valid(usdt) ? usdt : undefined, source: "fawazahmed0", asOf: date, fetchedAt: now };
}

/** ECB SDMX JSON (EUR base) → USD-base table. Series older than 14 days before the newest are dropped. */
export function parseEcbRates(body: unknown, now = Date.now()): FxTable | null {
  const b = body as { structure?: { dimensions?: { series?: { id: string; values: { id: string }[] }[]; observation?: { values: { id: string }[] }[] } }; dataSets?: { series?: Record<string, { observations?: Record<string, unknown[]> }> }[] } | null;
  const dims = b?.structure?.dimensions;
  const seriesDims = dims?.series ?? [];
  const ci = seriesDims.findIndex((d) => d.id === "CURRENCY");
  const dates = dims?.observation?.[0]?.values?.map((v) => v.id) ?? [];
  const series = b?.dataSets?.[0]?.series;
  if (ci < 0 || !series) return null;
  const perEur: Record<string, { rate: number; date: string }> = {};
  for (const [key, sv] of Object.entries(series)) {
    const code = seriesDims[ci].values[Number(key.split(":")[ci])]?.id;
    const [[idx, obs] = []] = Object.entries(sv.observations ?? {});
    const rate = Array.isArray(obs) ? obs[0] : undefined;
    const date = dates[Number(idx)] ?? "";
    if (code && ISO.test(code) && valid(rate) && /^\d{4}-\d{2}-\d{2}$/.test(date)) perEur[code] = { rate, date };
  }
  const usd = perEur.USD;
  if (!usd) return null;
  const newest = Object.values(perEur).reduce((m, x) => (x.date > m ? x.date : m), "");
  const cutoff = new Date(Date.parse(newest) - 14 * 86_400_000).toISOString().slice(0, 10);
  const rates: Record<string, number> = { USD: 1, EUR: 1 / usd.rate };
  const out: Record<string, string> = { EUR: usd.date };
  for (const [code, x] of Object.entries(perEur)) {
    if (code === "USD" || x.date < cutoff) continue;
    rates[code] = x.rate / usd.rate;
    out[code] = x.date;
  }
  if (Object.keys(rates).length < 10) return null;
  return { rates, dates: out, source: "ecb", asOf: newest, fetchedAt: now };
}

/** ExchangeRate-API open access `{result, base_code: "USD", rates, time_last_update_unix}`. */
export function parseErApiRates(body: unknown, now = Date.now()): FxTable | null {
  const b = body as { result?: string; base_code?: string; rates?: Record<string, unknown>; time_last_update_unix?: number } | null;
  if (!b || b.result !== "success" || b.base_code !== "USD" || !b.rates) return null;
  const date = Number.isFinite(b.time_last_update_unix) ? new Date((b.time_last_update_unix as number) * 1000).toISOString().slice(0, 10) : "";
  const rates: Record<string, number> = { USD: 1 };
  const dates: Record<string, string> = {};
  for (const [code, v] of Object.entries(b.rates)) {
    if (!ISO.test(code) || NOT_DISPLAY.has(code) || !valid(v)) continue;
    rates[code] = v;
    if (date) dates[code] = date;
  }
  return Object.keys(rates).length < 10 ? null : { rates, dates, source: "erapi", asOf: date, fetchedAt: now };
}

/** FloatRates `{sar: {code: "SAR", rate: "3.75…", date: "Tue, 10 Nov 2026 …"}, …}` (base USD). */
export function parseFloatRates(body: unknown, now = Date.now()): FxTable | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const rates: Record<string, number> = { USD: 1 };
  const dates: Record<string, string> = {};
  let asOf = "";
  for (const v of Object.values(body as Record<string, { code?: unknown; rate?: unknown; date?: unknown }>)) {
    const code = typeof v?.code === "string" ? v.code.toUpperCase() : "";
    const rate = Number(v?.rate);
    if (!ISO.test(code) || NOT_DISPLAY.has(code) || !valid(rate)) continue;
    rates[code] = rate;
    const t = Date.parse(String(v?.date ?? ""));
    if (Number.isFinite(t)) { const d = new Date(t).toISOString().slice(0, 10); dates[code] = d; if (d > asOf) asOf = d; }
  }
  return Object.keys(rates).length < 10 ? null : { rates, dates, source: "floatrates", asOf, fetchedAt: now };
}

/**
 * A rates file from a source that is NOT on the tested list (owner request 11 Nov 2026). Accepts the common
 * shapes — Frankfurter v1/v2, `{base|base_code, rates}`, fawazahmed0 `{date, usd:{…}}`, FloatRates, ECB SDMX —
 * and rebases to USD. Returns null when nothing usable is found. The table is labelled "custom (not tested)".
 */
export function parseCustomRates(body: unknown, custom: { name: string; url: string }, now = Date.now()): FxTable | null {
  const tag = (t: FxTable | null): FxTable | null => (t ? { ...t, source: "custom", custom } : null);
  const b = body as Record<string, unknown> | unknown[] | null;
  if (Array.isArray(b)) {
    const base = (b[0] as { base?: string })?.base;
    if (base === "USD") return tag(parseFrankfurterRates(b, undefined, now));
    return null;
  }
  if (!b || typeof b !== "object") return null;
  if ("dataSets" in b) return tag(parseEcbRates(b, now));
  if ("result" in b && "base_code" in b) return tag(parseErApiRates(b, now));
  if ("usd" in b && typeof b.usd === "object") return tag(parseFawazRates(b, undefined, now));
  const ratesObj = (b as { rates?: Record<string, unknown> }).rates;
  if (ratesObj && typeof ratesObj === "object") {
    const base = String((b as { base?: unknown; base_code?: unknown }).base ?? (b as { base_code?: unknown }).base_code ?? "USD").toUpperCase();
    const date = String((b as { date?: unknown }).date ?? "").slice(0, 10);
    const raw: Record<string, number> = { [base]: 1 };
    for (const [k, v] of Object.entries(ratesObj)) { const c = k.toUpperCase(); if (ISO.test(c) && valid(Number(v))) raw[c] = Number(v); }
    const usdPerBase = base === "USD" ? 1 : raw.USD;
    if (!valid(usdPerBase)) return null;
    const rates: Record<string, number> = { USD: 1 };
    for (const [c, v] of Object.entries(raw)) if (!NOT_DISPLAY.has(c) && c !== "USD") rates[c] = v / usdPerBase;
    const ok = /^\d{4}-\d{2}-\d{2}$/.test(date);
    return Object.keys(rates).length < 2 ? null : { rates, dates: ok ? Object.fromEntries(Object.keys(rates).map((c) => [c, date])) : {}, source: "custom", custom, asOf: ok ? date : "", fetchedAt: now };
  }
  return tag(parseFloatRates(b, now));
}

/** Offline last resort: official pegs only. */
export function pegTable(now = Date.now()): FxTable {
  const rates: Record<string, number> = { USD: 1 };
  for (const [code, p] of Object.entries(PEGS)) rates[code] = p.rate;
  return { rates, dates: {}, source: "peg", asOf: "", fetchedAt: now };
}

/* ---------------- conversion ---------------- */

/** Convert `value` in `from` into `to` through USD. NaN when a rate is missing. */
export function convert(value: number, from: string, to: string, table: FxTable | null): number {
  if (from === to) return value;
  const perUsd = (c: string) => (c === "USD" ? 1 : table?.rates[c] ?? (PEGS[c]?.rate ?? NaN));
  return (value / perUsd(from)) * perUsd(to);
}
/** Can `to` be shown from `from` with this table? */
export function canConvert(from: string, to: string, table: FxTable | null): boolean {
  return Number.isFinite(convert(1, from, to, table));
}
export function isStale(table: FxTable | null, now = Date.now()): boolean {
  if (!table || table.source === "peg") return false;
  const ref = table.asOf ? Date.parse(table.asOf + "T23:59:59Z") : table.fetchedAt;
  return now - Math.min(ref, table.fetchedAt) > FX_STALE_MS;
}
/** USDT per USD → USDT's price in USD and its deviation from $1, %. */
export function usdtDeviationPct(table: FxTable | null): number | undefined {
  const u = table?.usdtPerUsd;
  return valid(u) ? (1 / u - 1) * 100 : undefined;
}

/** Coins.ph: USDT's peso price against the official USD/PHP rate → USDT premium in %, or undefined. */
export function impliedUsdtPremiumPct(usdtLocal: number | null | undefined, currency: string, table: FxTable | null): number | undefined {
  const official = currency === "USD" ? 1 : table?.rates[currency];
  return valid(usdtLocal) && valid(official) ? (usdtLocal / official - 1) * 100 : undefined;
}

/* ---------------- automatic currency from the device region ---------------- */
const REGION_CURRENCY: Record<string, string> = {
  US: "USD", SA: "SAR", AE: "AED", QA: "QAR", OM: "OMR", BH: "BHD", KW: "KWD", JO: "JOD", EG: "EGP", PH: "PHP",
  IN: "INR", PK: "PKR", BD: "BDT", LK: "LKR", NP: "NPR", ID: "IDR", MY: "MYR", SG: "SGD", TH: "THB", VN: "VND",
  CN: "CNY", HK: "HKD", TW: "TWD", JP: "JPY", KR: "KRW", AU: "AUD", NZ: "NZD", CA: "CAD", MX: "MXN", BR: "BRL",
  AR: "ARS", CL: "CLP", CO: "COP", PE: "PEN", GB: "GBP", IE: "EUR", DE: "EUR", FR: "EUR", IT: "EUR", ES: "EUR",
  PT: "EUR", NL: "EUR", BE: "EUR", AT: "EUR", FI: "EUR", GR: "EUR", LU: "EUR", SK: "EUR", SI: "EUR", EE: "EUR",
  LV: "EUR", LT: "EUR", CY: "EUR", MT: "EUR", HR: "EUR", BG: "EUR", CH: "CHF", NO: "NOK", SE: "SEK", DK: "DKK",
  PL: "PLN", CZ: "CZK", HU: "HUF", RO: "RON", TR: "TRY", RU: "RUB", UA: "UAH", IL: "ILS", ZA: "ZAR", NG: "NGN",
  KE: "KES", GH: "GHS", MA: "MAD", DZ: "DZD", TN: "TND", IQ: "IQD", LB: "LBP", IR: "IRR", KZ: "KZT", UZ: "UZS",
};
/** Device time zone → region (review v2.7 #7: "English in Riyadh" is SAR, not USD). Local setting, never the network. */
const TZ_REGION: Record<string, string> = {
  "Asia/Riyadh": "SA", "Asia/Dubai": "AE", "Asia/Qatar": "QA", "Asia/Muscat": "OM", "Asia/Bahrain": "BH", "Asia/Kuwait": "KW",
  "Asia/Amman": "JO", "Africa/Cairo": "EG", "Asia/Manila": "PH", "Asia/Kolkata": "IN", "Asia/Calcutta": "IN", "Asia/Karachi": "PK",
  "Asia/Dhaka": "BD", "Asia/Colombo": "LK", "Asia/Kathmandu": "NP", "Asia/Jakarta": "ID", "Asia/Kuala_Lumpur": "MY",
  "Asia/Singapore": "SG", "Asia/Bangkok": "TH", "Asia/Ho_Chi_Minh": "VN", "Asia/Shanghai": "CN", "Asia/Hong_Kong": "HK",
  "Asia/Taipei": "TW", "Asia/Tokyo": "JP", "Asia/Seoul": "KR", "Australia/Sydney": "AU", "Australia/Melbourne": "AU",
  "Pacific/Auckland": "NZ", "America/Toronto": "CA", "America/Vancouver": "CA", "America/Mexico_City": "MX",
  "America/Sao_Paulo": "BR", "America/Argentina/Buenos_Aires": "AR", "Europe/London": "GB", "Europe/Dublin": "IE",
  "Europe/Berlin": "DE", "Europe/Paris": "FR", "Europe/Rome": "IT", "Europe/Madrid": "ES", "Europe/Lisbon": "PT",
  "Europe/Amsterdam": "NL", "Europe/Brussels": "BE", "Europe/Vienna": "AT", "Europe/Zurich": "CH", "Europe/Oslo": "NO",
  "Europe/Stockholm": "SE", "Europe/Copenhagen": "DK", "Europe/Warsaw": "PL", "Europe/Istanbul": "TR", "Europe/Moscow": "RU",
  "Europe/Kyiv": "UA", "Asia/Jerusalem": "IL", "Africa/Johannesburg": "ZA", "Africa/Lagos": "NG", "Africa/Nairobi": "KE",
  "Asia/Baghdad": "IQ", "Asia/Beirut": "LB", "Asia/Tehran": "IR",
};
/**
 * Currency of the device's region: its time zone first, then a language tag with an explicit region
 * (en-SA), then the language's likely region (ja → JP). Never from the IP; USD when unknown.
 */
export function autoCurrency(
  languages: readonly string[] = typeof navigator !== "undefined" ? navigator.languages ?? [navigator.language] : [],
  timeZone: string = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""; } catch { return ""; } })(),
): string {
  const tzRegion = TZ_REGION[timeZone];
  if (tzRegion && REGION_CURRENCY[tzRegion]) return REGION_CURRENCY[tzRegion];
  for (const tag of languages) {
    const explicit = (/^[a-z]{2,3}(?:-[A-Za-z]{4})?[-_]([A-Za-z]{2})\b/.exec(tag)?.[1] ?? "").toUpperCase();
    if (explicit && REGION_CURRENCY[explicit]) return REGION_CURRENCY[explicit];
  }
  for (const tag of languages) {
    let region = "";
    try { region = (new Intl.Locale(tag).maximize().region ?? "").toUpperCase(); } catch { /* bad tag */ }
    if (region && REGION_CURRENCY[region]) return REGION_CURRENCY[region];
  }
  return "USD";
}

/* ---------------- fetching and the on-device cache ---------------- */

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const readStore = <T,>(key: string): T | null => {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") as T | null; } catch { return null; }
};
const writeStore = (key: string, v: unknown) => {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage blocked: memory only */ }
};
const CUSTOM_KEY = "ct-fx-custom-v1";
const storeKey = (choice: FxChoice) => (choice === "auto" ? STORE_KEY : `${STORE_KEY}:${choice}`);
export function cachedTable(choice: FxChoice = "auto"): FxTable | null {
  const t = readStore<FxTable>(choice === "custom" ? CUSTOM_KEY : storeKey(choice));
  return t && t.rates && typeof t.rates === "object" && t.rates.USD === 1 ? t : null;
}
/** Keep an imported custom table on the device (it is never fetched by the app). */
export function saveCustomTable(t: FxTable): void {
  writeStore(CUSTOM_KEY, t);
}
export function cachedCurrencies(): FiatCurrency[] {
  const c = readStore<{ at: number; list: FiatCurrency[] }>(LIST_KEY);
  return Array.isArray(c?.list) ? c.list : [];
}

async function getJson(fetcher: Fetcher, url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetcher(url, { cache: "no-store", credentials: "omit", signal, headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.json();
}

/** Fiat list: Frankfurter's, cached 30 days; Intl's ISO list when that fails. */
export async function loadCurrencies(fetcher: Fetcher = fetch, signal?: AbortSignal, now = Date.now()): Promise<FiatCurrency[]> {
  const c = readStore<{ at: number; list: FiatCurrency[] }>(LIST_KEY);
  if (c && Array.isArray(c.list) && c.list.length > 50 && now - c.at < CURRENCY_LIST_TTL_MS) return c.list;
  try {
    const list = parseFrankfurterCurrencies(await getJson(fetcher, FRANKFURTER_CURRENCIES, signal));
    if (list.length > 50) { writeStore(LIST_KEY, { at: now, list }); return list; }
  } catch { /* fall through */ }
  if (c?.list?.length) return c.list;
  const intl = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("currency") ?? [];
  return intl.filter((code) => ISO.test(code) && !NOT_DISPLAY.has(code)).map((code) => ({ code, name: code }));
}

/**
 * Fresh table when the cached one is older than FX_REFRESH_MS (or `force`).
 * Never throws: on total failure it returns the cached table, else the peg table.
 */
export async function refreshRates(opts: { force?: boolean; fetcher?: Fetcher; signal?: AbortSignal; now?: number; choice?: FxChoice } = {}): Promise<FxTable> {
  const now = opts.now ?? Date.now();
  const fetcher = opts.fetcher ?? fetch;
  const choice = opts.choice ?? "auto";
  if (choice === "custom") return cachedTable("custom") ?? cachedTable("auto") ?? pegTable(now);
  const cached = cachedTable(choice);
  if (!opts.force && cached && cached.source !== "peg" && now - cached.fetchedAt < FX_REFRESH_MS) return cached;
  if (choice !== "auto") {
    // One chosen source: no silent switch to another provider — on failure the last table it gave is kept.
    try {
      const body = await getJson(fetcher, fxSourceInfo(choice)?.dataUrl ?? FRANKFURTER_RATES, opts.signal);
      const fiatSet = choice === "frankfurter" || choice === "fawazahmed0"
        ? new Set((await loadCurrencies(fetcher, opts.signal, now)).map((c) => c.code)) : undefined;
      const fiat = fiatSet && fiatSet.size > 50 ? fiatSet : undefined;
      const t = choice === "frankfurter" ? parseFrankfurterRates(body, fiat, now)
        : choice === "ecb" ? parseEcbRates(body, now)
        : choice === "erapi" ? parseErApiRates(body, now)
        : choice === "fawazahmed0" ? parseFawazRates(body, fiat, now)
        : parseFloatRates(body, now);
      if (t) { writeStore(storeKey(choice), t); return t; }
    } catch { /* keep the last table */ }
    return cached ?? pegTable(now);
  }
  const fiat = new Set((await loadCurrencies(fetcher, opts.signal, now)).map((c) => c.code));
  const fiatSet = fiat.size > 50 ? fiat : undefined;
  try {
    const t = parseFrankfurterRates(await getJson(fetcher, FRANKFURTER_RATES, opts.signal), fiatSet, now);
    if (t) { writeStore(STORE_KEY, t); return t; }
  } catch { /* next source */ }
  for (const url of FAWAZ_URLS) {
    try {
      const t = parseFawazRates(await getJson(fetcher, url, opts.signal), fiatSet, now);
      if (t) { writeStore(STORE_KEY, t); return t; }
    } catch { /* next mirror */ }
  }
  return cached ?? pegTable(now);
}
/**
 * v2.8 WP20 (licence audit): the credit a source's terms require, when its rates convert something on screen —
 * prices shown in another currency than the market's own (`shown !== native`). ExchangeRate-API requires
 * "Rates By Exchange Rate API" on the pages that use its rates; the ECB asks for the source. Frankfurter (the default)
 * and the fallbacks need none, so the default layout carries no extra text.
 */
export function fxCredit(fx: FxTable | null, native: string, shown: string): { text: string; url: string } | undefined {
  if (!fx || native === shown) return undefined;
  return fxSourceInfo(fx.source)?.attribution;
}
