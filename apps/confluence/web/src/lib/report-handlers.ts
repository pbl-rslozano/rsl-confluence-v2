/**
 * report-handlers.ts — v2.8 (WP22): what the report worker does with each message, as a pure function so the
 * worker, the main-thread fallback and the tests run the same code. Two kinds: the ledger report (v2.3, no `kind`)
 * and the Scenarios simulation. It never throws: a failure becomes `error`.
 */
import { buildReport, ftSign, type LedgerReport, type LedgerRow, type Outcome } from "./ledger-metrics";
import { runScenarios, type ScenarioRequest, type ScenarioResult } from "./scenarios";

export interface ReportRequest {
  id: number;
  rows: LedgerRow[];
  outcomes: [number, Outcome[]][];
  costBps: number;
  trials: number;
  intervalMs: number;
  momentum: [string, -1 | 0 | 1][];
}

export type WorkerRequest = ({ kind?: "report" } & ReportRequest) | { kind: "scenarios"; id: number; req: ScenarioRequest };

export interface WorkerResponse {
  id: number;
  report?: LedgerReport;
  scenarios?: ScenarioResult | { na: "history" };
  error?: string;
}

export function handleWorkerRequest(msg: WorkerRequest): WorkerResponse {
  const id = msg?.id;
  try {
    if (msg.kind === "scenarios") return { id, scenarios: runScenarios(msg.req) };
    const { rows, outcomes, costBps, trials, intervalMs, momentum } = msg;
    const mom = new Map(momentum);
    const report = buildReport(rows, new Map(outcomes), costBps, trials, intervalMs, { momentumOf: (r) => mom.get(r.id) ?? 0, fundTrendOf: ftSign });
    return { id, report };
  } catch (error) {
    return { id, error: error instanceof Error ? error.message : String(error) };
  }
}
