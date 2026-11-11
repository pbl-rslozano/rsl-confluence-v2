/// <reference lib="webworker" />
/**
 * report.worker.ts — v2.3 (review C10)
 * Builds the ledger report off the main thread: at 400k rows the statistics
 * (bootstrap, label permutation) took over a minute and froze the dialog.
 */
import { buildReport, type LedgerRow, type Outcome } from "./ledger-metrics";

export interface ReportRequest {
  id: number;
  rows: LedgerRow[];
  outcomes: [number, Outcome[]][];
  costBps: number;
  trials: number;
  intervalMs: number;
  momentum: [string, -1 | 0 | 1][];
}

self.onmessage = (event: MessageEvent<ReportRequest>) => {
  const { id, rows, outcomes, costBps, trials, intervalMs, momentum } = event.data;
  try {
    const mom = new Map(momentum);
    const report = buildReport(rows, new Map(outcomes), costBps, trials, intervalMs, { momentumOf: (r) => mom.get(r.id) ?? 0 });
    (self as unknown as Worker).postMessage({ id, report });
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
