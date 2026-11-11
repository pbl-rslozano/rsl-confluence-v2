const MAX_LEVELS_PER_SIDE = 50_000;

type Level = [number, number];
export type DepthFrame =
  | { at: number; gap: true }
  | { at: number; gap: false; bids: Level[]; asks: Level[] };

function parseLevels(value: unknown): Level[] | null {
  if (!Array.isArray(value) || value.length > MAX_LEVELS_PER_SIDE) return null;
  const levels: Level[] = [];
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== 2 ||
        !row.every((cell) => typeof cell === "number" || (typeof cell === "string" && cell.trim()))) return null;
    const [price, size] = row.map(Number);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size < 0) return null;
    levels.push([price, size]);
  }
  return levels;
}

export function reconstructDepth(input: unknown[], pair: string): DepthFrame[] {
  const frames: DepthFrame[] = [];
  const bids = new Map<number, number>();
  const asks = new Map<number, number>();
  let cursor: { u: number; seq: number } | null = null;
  let lastTime = 0;
  const apply = (book: Map<number, number>, levels: Level[]) => {
    for (const [price, size] of levels) {
      if (size === 0) book.delete(price);
      else book.set(price, size);
    }
  };
  const gap = (at: number) => {
    if (cursor || !frames.length || !frames.at(-1)?.gap) frames.push({ at, gap: true });
    cursor = null;
    bids.clear();
    asks.clear();
  };

  for (const value of input.slice(0, 20_000)) {
    const row = value as { pair?: unknown; at?: unknown; u?: unknown; seq?: unknown; type?: unknown; bids?: unknown; asks?: unknown } | null;
    if (row?.type === "liquidation") continue;
    if (row?.pair !== pair || typeof row.at !== "number" || !Number.isFinite(row.at) ||
        row.at < lastTime || row.at > 8.64e15) continue;
    if (typeof row.u !== "number" || !Number.isSafeInteger(row.u) || row.u < 1 ||
        typeof row.seq !== "number" || !Number.isSafeInteger(row.seq) || row.seq < 1) {
      gap(row.at);
      continue;
    }
    if (row.type === "delta") {
      if (!cursor) { gap(row.at); continue; }
      if (row.u !== 1 && (row.u <= cursor.u || row.seq < cursor.seq)) continue;
      if (row.u === 1 || row.u !== cursor.u + 1) { gap(row.at); continue; }
    } else if (row.type !== "snapshot") {
      gap(row.at);
      continue;
    }
    const bidUpdates = parseLevels(row.bids);
    const askUpdates = parseLevels(row.asks);
    if (!bidUpdates || !askUpdates) { gap(row.at); continue; }
    if (row.type === "snapshot") { bids.clear(); asks.clear(); }
    apply(bids, bidUpdates);
    apply(asks, askUpdates);
    if (!bids.size || !asks.size || bids.size > MAX_LEVELS_PER_SIDE || asks.size > MAX_LEVELS_PER_SIDE) { gap(row.at); continue; }
    const topBids = [...bids].sort((a, b) => b[0] - a[0]).slice(0, 15);
    const topAsks = [...asks].sort((a, b) => a[0] - b[0]).slice(0, 15);
    if (topBids[0][0] >= topAsks[0][0]) { gap(row.at); continue; }
    cursor = { u: row.u, seq: row.seq };
    lastTime = row.at;
    frames.push({ at: row.at, gap: false, bids: topBids, asks: topAsks });
  }
  return frames.slice(-60);
}
