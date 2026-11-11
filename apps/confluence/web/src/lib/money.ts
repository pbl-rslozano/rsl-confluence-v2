/**
 * money.ts — v2.7 (plan WP13.4, review #9): ONE formatter for prices and volumes in
 * any currency. Replaces the scattered fmtPrice / KeyLevels.fmt / "₱"/"$" prefixes.
 *
 * Numbers use en-US grouping (as the app always has); the currency sign comes from
 * Intl (`currencyDisplay: "symbol"`: "$" only for USD, "SAR ", "₱", "€", "¥"…).
 * Prices ≥ 1,000 use the currency's ISO minor units (JPY 0, KWD 3); smaller prices
 * keep the app's significant-digit rules so a $0.00001234 token stays readable.
 */

const symbolCache = new Map<string, { prefix: string; suffix: string; digits: number }>();

function parts(currency: string): { prefix: string; suffix: string; digits: number } {
  const hit = symbolCache.get(currency);
  if (hit) return hit;
  let out = { prefix: currency + " ", suffix: "", digits: 2 };
  try {
    const nf = new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "symbol" });
    const p = nf.formatToParts(1);
    const iNum = p.findIndex((x) => x.type === "integer");
    const before = p.slice(0, iNum).filter((x) => x.type === "currency" || x.type === "literal").map((x) => x.value).join("");
    const after = p.slice(iNum).filter((x) => x.type === "currency" || (x.type === "literal" && p.some((y) => y.type === "currency"))).map((x) => x.value).join("");
    const digits = nf.resolvedOptions().maximumFractionDigits ?? 2;
    const prefix = before.replace(/ /g, " ");
    // Intl writes "SAR 1.00" with a no-break space; codes get a plain space, signs none.
    out = { prefix: /^[A-Z]{3}$/.test(prefix.trim()) ? prefix.trim() + " " : prefix, suffix: after.replace(/ /g, " ").trimEnd() === "" ? "" : after.replace(/ /g, " "), digits };
  } catch {
    // unknown code: "XYZ 1.00"
  }
  symbolCache.set(currency, out);
  return out;
}

/** ISO 4217 minor units (JPY 0, KWD 3, most 2). */
export function minorUnits(currency: string): number {
  return parts(currency).digits;
}

/** Plain number with the app's rules: grouping ≥ 1,000, then 4 / 5 decimals, then significant digits. */
export function formatAmount(value: number, digitsAtThousand = 2): string {
  if (!Number.isFinite(value)) return "—";
  const a = Math.abs(value);
  if (a === 0) return (0).toFixed(Math.max(digitsAtThousand, 2));
  if (a >= 1000) return value.toLocaleString("en-US", { minimumFractionDigits: digitsAtThousand, maximumFractionDigits: digitsAtThousand });
  if (a >= 1) return value.toFixed(4);
  if (a >= 0.01) return value.toFixed(5);
  // Small prices: four significant digits without exponent notation.
  return value.toLocaleString("en-US", { maximumSignificantDigits: 4, useGrouping: false });
}

/** Price in `currency` ("$64,250.50", "SAR 240,937.50", "¥10,166,000", "₱4,789,170.50"). */
export function formatMoney(value: number, currency = "USD"): string {
  if (!Number.isFinite(value)) return "—";
  const { prefix, suffix, digits } = parts(currency);
  const sign = value < 0 ? "-" : "";
  return `${sign}${prefix}${formatAmount(Math.abs(value), digits)}${suffix}`;
}

/** Compact amount (volumes): "$1.50B", "SAR 2.50M". */
export function formatMoneyCompact(value: number, currency = "USD"): string {
  if (!Number.isFinite(value)) return "—";
  const { prefix, suffix } = parts(currency);
  const a = Math.abs(value);
  const n = a >= 1e12 ? (a / 1e12).toFixed(2) + "T" : a >= 1e9 ? (a / 1e9).toFixed(2) + "B" : a >= 1e6 ? (a / 1e6).toFixed(2) + "M" : a >= 1e3 ? (a / 1e3).toFixed(2) + "K" : a.toFixed(2);
  return `${value < 0 ? "-" : ""}${prefix}${n}${suffix}`;
}

/** Short axis label, distinct on tight ranges (v2.6 printed "99.9k, 99.9k, 100.0k"). */
export function formatAxisTicks(values: readonly number[]): string[] {
  const span = Math.max(...values) - Math.min(...values);
  return values.map((v) => {
    const a = Math.abs(v);
    if (a >= 1000) {
      const step = span / Math.max(1, values.length - 1);
      if (step >= 100 || span === 0) return (v / 1000).toFixed(step >= 1000 ? 1 : 2) + "k";
      return v.toLocaleString("en-US", { maximumFractionDigits: step >= 1 ? 0 : 2 });
    }
    if (a >= 1) return v.toFixed(span / 4 < 0.01 ? 4 : 2);
    if (a >= 0.01) return v.toFixed(4);
    return v.toLocaleString("en-US", { maximumSignificantDigits: 3, useGrouping: false });
  });
}
