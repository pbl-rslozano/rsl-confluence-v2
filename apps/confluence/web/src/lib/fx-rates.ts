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
/** Every host this module may contact (ADR-0003 v2.7; R8 reads public-hosts.ts, which lists them). */
export const FX_HOSTS = ["https://api.frankfurter.dev", "https://cdn.jsdelivr.net", "https://latest.currency-api.pages.dev"] as const;

export const FX_REFRESH_MS = 6 * 3_600_000;
export const FX_STALE_MS = 3 * 86_400_000;
const CURRENCY_LIST_TTL_MS = 30 * 86_400_000;
const STORE_KEY = "ct-fx-rates-v1";
const LIST_KEY = "ct-fx-currencies-v1";

export type FxSource = "frankfurter" | "fawazahmed0" | "peg";
export interface FxTable {
  /** Units per 1 USD, ISO 4217 codes; USD = 1 always. */
  rates: Record<string, number>;
  /** Date each rate refers to (YYYY-MM-DD), when the source gives one. */
  dates: Record<string, string>;
  /** USDT per 1 USD from the source's own row, when published (information only). */
  usdtPerUsd?: number;
  source: FxSource;
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
/** Currency of the device's region (navigator.language), never from the network; USD when unknown. */
export function autoCurrency(languages: readonly string[] = typeof navigator !== "undefined" ? navigator.languages ?? [navigator.language] : []): string {
  for (const tag of languages) {
    let region = "";
    try {
      region = (new Intl.Locale(tag).maximize().region ?? "").toUpperCase();
    } catch {
      region = (/[-_]([A-Za-z]{2})\b/.exec(tag)?.[1] ?? "").toUpperCase();
    }
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
export function cachedTable(): FxTable | null {
  const t = readStore<FxTable>(STORE_KEY);
  return t && t.rates && typeof t.rates === "object" && t.rates.USD === 1 ? t : null;
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
export async function refreshRates(opts: { force?: boolean; fetcher?: Fetcher; signal?: AbortSignal; now?: number } = {}): Promise<FxTable> {
  const now = opts.now ?? Date.now();
  const fetcher = opts.fetcher ?? fetch;
  const cached = cachedTable();
  if (!opts.force && cached && cached.source !== "peg" && now - cached.fetchedAt < FX_REFRESH_MS) return cached;
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
