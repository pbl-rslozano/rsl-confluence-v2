export interface PublicTrade {
  id: string;
  price: number;
  size: number;
  side: "Buy" | "Sell";
  time: number;
}

export function normalizePublicTrades(input: unknown, symbol: string): PublicTrade[] {
  if (!Array.isArray(input)) return [];
  const trades = new Map<string, PublicTrade>();
  for (const row of input) {
    if (!row || row.symbol !== symbol || typeof row.execId !== "string" || !row.execId ||
        (row.side !== "Buy" && row.side !== "Sell")) continue;
    const price = Number(row.price);
    const size = Number(row.size);
    const time = Number(row.time);
    if (![price, size, time].every((value) => Number.isFinite(value) && value > 0) || time > 8.64e15) continue;
    trades.set(row.execId, { id: row.execId, price, size, side: row.side, time });
  }
  return [...trades.values()].sort((a, b) => b.time - a.time).slice(0, 50);
}

export type Liquidation = { id: string; time: number; side: "long" | "short"; price: number; size: number };

export function readLiquidations(messages: unknown[], pair: string): Liquidation[] {
  const events = new Map<string, Liquidation>();
  for (const value of messages) {
    const row = value as (Partial<Liquidation> & { type?: string; pair?: string }) | null;
    if (row?.type !== "liquidation" || row.pair !== pair || typeof row.id !== "string" ||
        (row.side !== "long" && row.side !== "short") || typeof row.time !== "number" ||
        !Number.isSafeInteger(row.time) || row.time <= 0 || row.time > 8.64e15 ||
        typeof row.price !== "number" || !Number.isFinite(row.price) || row.price <= 0 ||
        typeof row.size !== "number" || !Number.isFinite(row.size) || row.size <= 0) continue;
    events.set(row.id, { id: row.id, side: row.side, time: row.time, price: row.price, size: row.size });
  }
  return [...events.values()].sort((a, b) => a.time - b.time);
}
