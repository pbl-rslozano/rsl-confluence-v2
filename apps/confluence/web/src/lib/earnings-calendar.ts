/**
 * earnings-calendar.ts — v2.3
 * ----------------------------------------------------------------------------
 * Manual earnings list for tokenised stocks. Ships EMPTY on purpose: no
 * keyless public earnings API was found, and dates must not be invented.
 * Add entries as underlying ticker → ISO dates (UTC day of the report), e.g.
 *
 *   NVDA: ["2026-11-19"],
 *
 * The token symbol is matched by its underlying ticker (NVDAXUSDT, NVDAONUSDT,
 * NVDABUSDT and NVDAUSDT all map to NVDA). A row is flagged `earn = 1` when
 * its bar closes within 24 h of the listed report DAY (that UTC day ± 24 h,
 * i.e. up to 36 h from noon). Logged only, never scored.
 * ----------------------------------------------------------------------------
 */
export const EARNINGS: Record<string, string[]> = {};

/** Underlying ticker of a tokenised-stock symbol. */
export function underlyingTicker(symbol: string): string {
  return symbol.toUpperCase().replace(/USDT$/, "").replace(/(ON|X|B)$/, "");
}

export function earningsNear(symbol: string, at: number, hours = 24, table: Record<string, string[]> = EARNINGS): boolean {
  const list = table[underlyingTicker(symbol)] ?? table[symbol.toUpperCase().replace(/USDT$/, "")];
  if (!list?.length) return false;
  return list.some((d) => {
    const t = Date.parse(`${d}T12:00:00Z`);
    return Number.isFinite(t) && Math.abs(t - at) <= hours * 3_600_000 + 12 * 3_600_000;
  });
}
