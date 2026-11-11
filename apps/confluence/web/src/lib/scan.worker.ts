/// <reference lib="webworker" />
/**
 * scan.worker.ts — v2.1.1
 * Runs the confluence, reversal and analogue engines off the main thread, so a
 * 200-pair scan no longer freezes the UI (open item from the Build 2.01 review).
 */
import { runScanJobSafe, type ScanJob } from "./scan-jobs";

interface Request { id: number; jobs: ScanJob[] }

self.onmessage = (event: MessageEvent<Request>) => {
  const { id, jobs } = event.data;
  try {
    const results = jobs.map(runScanJobSafe);
    (self as unknown as Worker).postMessage({ id, results });
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
