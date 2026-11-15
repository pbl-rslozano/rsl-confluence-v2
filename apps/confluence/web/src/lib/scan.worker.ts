/// <reference lib="webworker" />
/**
 * scan.worker.ts — v2.1.1
 * Runs the confluence, reversal and analogue engines off the main thread, so a
 * 200-pair scan no longer freezes the UI (open item from the Build 2.01 review).
 */
import { runScanJobSafe, scoreVisibleBars, unpackKlines, type ScanJob } from "./scan-jobs";

/** `panelScores` (v2.8, WP21): per-bar Confluence scores for the Fund trend panel, scored with the production window. */
interface Request { id: number; jobs?: ScanJob[]; panelScores?: { job: ScanJob; visible: number; known: [number, number][] } }

self.onmessage = (event: MessageEvent<Request>) => {
  const { id, jobs, panelScores } = event.data;
  try {
    if (panelScores) {
      const scores = scoreVisibleBars(panelScores.job, unpackKlines(panelScores.job.packed), panelScores.visible, new Map(panelScores.known));
      (self as unknown as Worker).postMessage({ id, scores });
      return;
    }
    const results = (jobs ?? []).map(runScanJobSafe);
    (self as unknown as Worker).postMessage({ id, results });
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
