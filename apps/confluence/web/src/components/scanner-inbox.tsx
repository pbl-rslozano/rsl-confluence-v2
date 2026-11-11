"use client";

import { useState } from "react";
import type { LedgerRow } from "@/lib/ledger-metrics";
import type { Watchlist } from "./scanner-watchlists";

type InboxEvent = { id: string; src: string; tf: string; pair: string; barOpen: number; score: number; cfg: string; kind?: string; previousRank?: number; rank?: number };
type Port = {
  get(collection: string, id: string): Promise<unknown>;
  put(collection: string, id: string, document: unknown): Promise<void>;
};

function eventsFrom(value: unknown): InboxEvent[] {
  const data = value as { version?: unknown; events?: unknown } | null;
  if (data?.version !== 1 || !Array.isArray(data.events)) return [];
  return data.events.filter((event) => event && typeof event.id === "string" && event.id.length > 0 && event.id.length <= 200 &&
    typeof event.src === "string" && typeof event.tf === "string" &&
    typeof event.pair === "string" && typeof event.cfg === "string" &&
    Number.isSafeInteger(event.barOpen) && event.barOpen > 0 && event.barOpen <= 8.64e15 && Number.isFinite(event.score));
}

export function ScannerInbox({ port, list, timeframe, ledger }: {
  port: Port; list: Watchlist | null; timeframe: string; ledger: { all(): Promise<LedgerRow[]> };
}) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<InboxEvent[]>([]);
  const [gatewayToken, setGatewayToken] = useState("");
  const [rankRule, setRankRule] = useState(false);
  const [threshold, setThreshold] = useState("70");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [detail, setDetail] = useState<LedgerRow | null>(null);

  async function toggle() {
    setOpen(!open);
    if (!open) {
      try { setEvents(eventsFrom(await port.get("preferences", "workspace-inbox"))); }
      catch { setMessage("Inbox could not be loaded."); }
    }
  }

  function ruleDeployment() {
    const value = Number(threshold);
    const valid = rankRule ? timeframe !== "1M" && Number.isInteger(value) && value >= 1 && value <= 299
      : Number.isFinite(value) && value >= -100 && value <= 100;
    if (!list?.symbols.length || !threshold.trim() || !valid) {
      setMessage(rankRule ? "Select a watchlist and enter 1–299 places on a nonmonthly timeframe."
        : "Select a nonempty watchlist and a threshold between −100 and 100.");
      return;
    }
    return { version: 1, revision: new Date().toISOString(), rules: [
      { id: list.id + (rankRule ? "-rank" : ""), source: list.source, timeframe, symbols: list.symbols,
        threshold: value, ...(rankRule ? { kind: "rank-rise" } : {}) },
    ] };
  }

  function exportRule() {
    const deployment = ruleDeployment();
    if (!deployment) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(deployment, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "workspace-rules.json";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage("Place workspace-rules.json in the recorder output folder.");
  }

  async function mergeInbox(incoming: { version?: unknown; events?: unknown } | null) {
      if (incoming?.version !== 1 || !Array.isArray(incoming.events)) throw new Error("Unsupported inbox file.");
      const stored = eventsFrom(await port.get("preferences", "workspace-inbox"));
      const merged = [...new Map([...stored, ...eventsFrom(incoming)].map((event) => [event.id, event])).values()]
        .sort((a, b) => b.barOpen - a.barOpen).slice(0, 5000);
      await port.put("preferences", "workspace-inbox", { version: 1, events: merged });
      setEvents(merged);
      setMessage("Inbox imported.");
  }

  async function importInbox(file: File) {
    setBusy(true);
    try {
      if (file.size > 5_000_000) throw new Error("Inbox file is too large.");
      const incoming = JSON.parse(await file.text());
      await mergeInbox(incoming);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Inbox import failed.");
    } finally {
      setBusy(false);
    }
  }

  async function syncGateway(deploy: boolean) {
    const rule = deploy ? ruleDeployment() : undefined;
    if (!gatewayToken.trim() || (deploy && !rule)) return;
    setBusy(true);
    try {
      const response = await fetch("http://127.0.0.1:8787/recorder/" + (deploy ? "rules" : "inbox"), {
        method: deploy ? "POST" : "GET",
        headers: { Authorization: "Bearer " + gatewayToken.trim(), ...(deploy ? { "Content-Type": "application/json" } : {}) },
        body: deploy ? JSON.stringify(rule) : undefined,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("Gateway returned HTTP " + response.status + ".");
      const result = await response.json();
      if (deploy) setMessage("Recorder rule deployed · " + result.revision);
      else await mergeInbox(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Gateway sync failed.");
    } finally {
      setBusy(false);
    }
  }

  async function openSignal(event: InboxEvent) {
    setDetail(null);
    try {
      const match = (await ledger.all()).find((row) => row.src === event.src && row.tf === event.tf &&
        row.pair === event.pair && row.t === event.barOpen && row.cfg === event.cfg);
      setDetail(match ?? null);
      setMessage(match ? "" : "Matching signal unavailable. Import the recorder ledger for this bar.");
    } catch {
      setMessage("Ledger could not be opened.");
    }
  }

  return (
    <div className="relative">
      <button type="button" aria-expanded={open} onClick={() => void toggle()}
        className="h-8 rounded border border-zinc-700 px-2 text-xs">Alert inbox</button>
      {open && <section aria-label="Alert inbox" className="absolute start-0 top-full z-30 mt-1 grid w-64 gap-2 rounded border border-zinc-700 bg-zinc-900 p-3 text-xs">
        <label className="block">Alert rule
          <select value={rankRule ? "rank-rise" : "score"} onChange={(event) => {
            const rank = event.target.value === "rank-rise";
            setRankRule(rank);
            setThreshold(rank ? "5" : "70");
          }} className="block rounded bg-zinc-950 p-1">
            <option value="score">Score crossing</option>
            <option value="rank-rise">Rank rise</option>
          </select>
        </label>
        <label>{rankRule ? "Minimum places gained" : "Score threshold"} <input type="number" min={rankRule ? 1 : -100}
          max={rankRule ? 299 : 100} step={rankRule ? 1 : "any"} value={threshold}
          onChange={(event) => setThreshold(event.target.value)} className="w-20 rounded bg-zinc-950 p-1" /></label>
        <button type="button" onClick={exportRule}>Export active watchlist rule</button>
        <label>Import recorder inbox <input type="file" accept=".json,application/json" disabled={busy}
          className="w-full" onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void importInbox(file);
          }} /></label>
        <details className="space-y-2">
          <summary>Local gateway sync</summary>
          <label className="block">Gateway session token
            <input type="password" autoComplete="off" value={gatewayToken} onChange={(event) => setGatewayToken(event.target.value)}
              className="block w-full rounded bg-zinc-950 p-1" />
          </label>
          <div className="flex gap-2">
            <button type="button" disabled={busy || !gatewayToken.trim()} onClick={() => void syncGateway(false)}>Sync inbox</button>
            <button type="button" disabled={busy || !gatewayToken.trim() || !list?.symbols.length}
              onClick={() => void syncGateway(true)}>Deploy active rule</button>
          </div>
        </details>
        {message && <p role="status">{message}</p>}
        {detail && <p>{detail.pair} · {detail.src} · {detail.tf} · {new Date(detail.t).toISOString()} · score {detail.sc}</p>}
        <ul className="grid max-h-56 gap-1 overflow-auto">
          {events.map((event) => <li key={event.id}>
            <button type="button" onClick={() => void openSignal(event)}>
              {event.pair} · {event.src} · {event.tf} · {new Date(event.barOpen).toISOString()} · {event.kind === "rank-rise" && Number.isInteger(event.previousRank) && Number.isInteger(event.rank)
                ? "rank " + event.previousRank + " → " + event.rank : "score " + event.score}
            </button>
          </li>)}
        </ul>
      </section>}
    </div>
  );
}
