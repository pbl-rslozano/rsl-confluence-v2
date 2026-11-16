/**
 * report-runner.ts — v2.3: run buildReport in a Web Worker, with a main-thread
 * fallback when workers are unavailable or fail to load. Same numbers either way.
 */
import { buildReport, ftSign, type LedgerReport, type LedgerRow, type Outcome } from "./ledger-metrics";

let worker: Worker | null = null;
let broken = false;
let seq = 0;
const pending = new Map<number, { resolve: (r: LedgerReport) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (broken || typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./report.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ id: number; report?: LedgerReport; error?: string }>) => {
      const p = pending.get(event.data.id);
      if (!p) return;
      pending.delete(event.data.id);
      if (event.data.error || !event.data.report) p.reject(new Error(event.data.error ?? "report failed"));
      else p.resolve(event.data.report);
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      broken = true;
      worker?.terminate();
      worker = null;
      for (const [, p] of pending) p.reject(new Error("report worker unavailable"));
      pending.clear();
    };
    return worker;
  } catch {
    broken = true;
    return null;
  }
}

export interface ReportInput {
  rows: LedgerRow[];
  outcomes: Map<number, Outcome[]>;
  costBps: number;
  trials: number;
  intervalMs: number;
  momentum: Map<string, -1 | 0 | 1>;
}

const onMainThread = (x: ReportInput) =>
  buildReport(x.rows, x.outcomes, x.costBps, x.trials, x.intervalMs, { momentumOf: (r) => x.momentum.get(r.id) ?? 0, fundTrendOf: ftSign });

export async function buildReportAsync(x: ReportInput): Promise<LedgerReport> {
  const w = getWorker();
  if (!w) return onMainThread(x);
  const id = ++seq;
  try {
    return await new Promise<LedgerReport>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.postMessage({ id, rows: x.rows, outcomes: [...x.outcomes], costBps: x.costBps, trials: x.trials, intervalMs: x.intervalMs, momentum: [...x.momentum] });
    });
  } catch {
    return onMainThread(x);
  }
}
