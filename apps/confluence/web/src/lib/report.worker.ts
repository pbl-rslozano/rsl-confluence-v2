/// <reference lib="webworker" />
/**
 * report.worker.ts — v2.3 (review C10)
 * Builds the ledger report off the main thread: at 400k rows the statistics
 * (bootstrap, label permutation) took over a minute and froze the dialog.
 * v2.8 (WP22): also runs the Scenarios simulation (message kind "scenarios"); see report-handlers.ts.
 */
import { handleWorkerRequest, type WorkerRequest } from "./report-handlers";

export type { ReportRequest } from "./report-handlers";

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  (self as unknown as Worker).postMessage(handleWorkerRequest(event.data));
};
