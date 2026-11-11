import type { AssetClass } from "./ledger-metrics";
import type { Kline } from "./indicators";
import { processBars, type PaperBook } from "./paper-broker";

export interface ReplayInstrument {
  pair: string;
  src: string;
  tf: string;
  intervalMs: number;
  assetClass: AssetClass;
}

export function queueReplayTrade(
  book: PaperBook, instrument: ReplayInstrument, bar: Kline, side: "long" | "short",
  size: number, stopPercent: number, targetPercent: number,
): PaperBook | null {
  if (book.positions.length || ![size, stopPercent, targetPercent, bar.close, instrument.intervalMs]
    .every((value) => Number.isFinite(value) && value > 0) || stopPercent >= 100 || targetPercent >= 100) return null;
  const stopDistance = bar.close * stopPercent / 100;
  const targetDistance = bar.close * targetPercent / 100;
  const id = "replay-" + bar.time;
  return {
    ...book,
    positions: [{
      ...instrument, id, proposalId: id, configId: "manual-replay", side, size, stopDistance, targetDistance,
      plannedRisk: size * stopDistance, refPrice: bar.close, signalBarTime: bar.time,
      approvedAt: bar.time + instrument.intervalMs, status: "pending", entry: null, openedAt: null,
      stop: 0, target: 0, entryFee: 0, funding: 0, mark: bar.close, markTime: bar.time,
      lastBarTime: bar.time, closeRequestedAt: null,
    }],
  };
}

export function advanceReplayTrade(book: PaperBook, instrument: ReplayInstrument, bar: Kline) {
  const result = processBars(book, instrument.src, instrument.tf, { [instrument.pair]: [bar] }, bar.time + instrument.intervalMs);
  const position = result.filled[0] ?? book.positions[0];
  const ambiguous = result.closed[0]?.reason === "stop" && !!position &&
    (position.side === "long"
      ? (result.filled.length > 0 || bar.open > position.stop) && bar.low <= position.stop && bar.high >= position.target
      : (result.filled.length > 0 || bar.open < position.stop) && bar.high >= position.stop && bar.low <= position.target);
  return { book: result.book, ambiguous };
}
