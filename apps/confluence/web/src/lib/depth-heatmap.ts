type Level = [number, number];
type Book = { bids: Level[]; asks: Level[] };
type Cell = { row: number; size: number; side: "bid" | "ask" };

export const HEATMAP_ROWS = 48;

export function buildDepthHeatmap(books: (Book | null)[]) {
  let low = Infinity;
  let high = -Infinity;
  for (const book of books) {
    if (!book) continue;
    for (const [price] of [...book.bids, ...book.asks]) {
      low = Math.min(low, price);
      high = Math.max(high, price);
    }
  }
  const hasDepth = Number.isFinite(low) && Number.isFinite(high);
  const range = high - low || 1;
  let maximum = 0;
  const columns = books.map((book): Cell[] | null => {
    if (!book) return null;
    const cells = new Map<string, Cell>();
    for (const [side, levels] of [["bid", book.bids], ["ask", book.asks]] as const) {
      for (const [price, size] of levels) {
        const row = Math.max(0, Math.min(HEATMAP_ROWS - 1, Math.floor((high - price) / range * HEATMAP_ROWS)));
        const key = side + row;
        const cell = { row, side, size: size + (cells.get(key)?.size ?? 0) };
        cells.set(key, cell);
        maximum = Math.max(maximum, cell.size);
      }
    }
    return [...cells.values()];
  });
  return { columns, maximum, low, high, hasDepth };
}
