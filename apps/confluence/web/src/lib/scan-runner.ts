"use client";
/**
 * scan-runner.ts — v2.1.1
 * Sends scan jobs to the scan worker; falls back to the main thread when
 * workers are unavailable (old WebViews, file:// origins, CSP) or fail.
 */
import { runScanJobSafe, type ScanJob, type ScanJobResult } from "./scan-jobs";
import type { Kline } from "./indicators";
import { packKlines } from "./scan-jobs";
import { createLatestWins } from "./latest-wins";

/** A worker batch that has not answered within this time is treated as hung. */
const WORKER_TIMEOUT_MS = 120_000;

let worker: Worker | null = null;
let workerBroken = false;
let nextId = 1;
const pending = new Map<number, { resolve: (r: never) => void; reject: (e: Error) => void }>();

export type ScanMode = "worker" | "main";
let lastMode: ScanMode = "main";
export const scanMode = () => lastMode;

function getWorker(): Worker | null {
  if (workerBroken || typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./scan.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ id: number; results?: ScanJobResult[]; scores?: (number | null)[]; error?: string }>) => {
      const p = pending.get(event.data.id);
      if (!p) return;
      pending.delete(event.data.id);
      if (event.data.error) p.reject(new Error(event.data.error));
      else p.resolve((event.data.scores ?? event.data.results ?? []) as never);
    };
    worker.onerror = (event) => {
      // Load or runtime failure: stop using the worker and fail over everything in flight.
      event.preventDefault?.();
      markBroken();
    };
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

function runOnMain(jobs: ScanJob[]): ScanJobResult[] {
  lastMode = "main";
  return jobs.map(runScanJobSafe);
}

function markBroken(): void {
  workerBroken = true;
  worker?.terminate();
  worker = null;
  for (const [, p] of pending) p.reject(new Error("scan worker unavailable"));
  pending.clear();
}

/**
 * Run jobs in the worker. `allowMainThread: false` (background work such as
 * ledger catch-up) returns [] instead of falling back, so it can never freeze
 * the UI.
 */
export async function runScanJobs(jobs: ScanJob[], { allowMainThread = true } = {}): Promise<ScanJobResult[]> {
  if (!jobs.length) return [];
  const w = getWorker();
  if (!w) return allowMainThread ? runOnMain(jobs) : [];
  const id = nextId++;
  try {
    const results = await new Promise<ScanJobResult[]>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); markBroken(); reject(new Error("scan worker timed out")); }, WORKER_TIMEOUT_MS);
      pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      // Copies keep the caller's arrays usable for the main-thread fallback; the copies are transferred.
      const copies = jobs.map((j) => ({ ...j, packed: j.packed.slice() }));
      w.postMessage({ id, jobs: copies }, copies.map((j) => j.packed.buffer));
    });
    lastMode = "worker";
    return results;
  } catch {
    return allowMainThread ? runOnMain(jobs) : [];
  }
}

/** A panel request that has not answered within this time resolves null; unlike a scan batch it never disables the worker. */
const PANEL_TIMEOUT_MS = 30_000;

interface PanelRequest {
  job: Omit<ScanJob, "packed">;
  klines: Kline[];
  visible: number;
  known: ReadonlyMap<number, number>;
  id?: number;
}

function postPanel(req: PanelRequest): Promise<(number | null)[] | null> {
  const w = getWorker();
  if (!w) return Promise.resolve(null);
  const id = (req.id = nextId++);
  return new Promise<(number | null)[]>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (r: never) => void, reject });
    const packed = packKlines(req.klines);
    w.postMessage({ id, panelScores: { job: { ...req.job, packed }, visible: req.visible, known: [...req.known] } }, [packed.buffer]);
  }).finally(() => pending.delete(id));
}

/** One panel request at a time, the newest waiting one wins; a timeout drops only that request. */
const panelQueue = createLatestWins<PanelRequest, (number | null)[]>(postPanel, PANEL_TIMEOUT_MS, (req) => { if (req.id !== undefined) pending.delete(req.id); });

/**
 * v2.8 (WP21): per-bar Confluence scores for the Fund trend panel, in the scan worker. Never runs on the main thread
 * (300 scoreSeries calls would freeze the UI): without a worker, when superseded by a newer request, on timeout or on
 * failure it resolves null. `klines` ends at the newest bar to score; `known` are ledger scores by bar time, used as they are.
 */
export function runPanelScores(
  job: Omit<ScanJob, "packed">,
  klines: Kline[],
  visible: number,
  known: ReadonlyMap<number, number>,
): Promise<(number | null)[] | null> {
  return panelQueue({ job, klines, visible, known });
}
