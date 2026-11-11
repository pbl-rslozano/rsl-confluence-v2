"use client";

import { useEffect, useState } from "react";
import { parseDerivativeSnapshots, summarizeDerivatives, type DerivativeSnapshot } from "@/lib/derivatives-context";

type Port = {
  get(collection: string, id: string): Promise<unknown>;
  put(collection: string, id: string, document: unknown): Promise<void>;
};

export function DerivativesPanel({ port, pair }: { port: Port; pair: string }) {
  const [records, setRecords] = useState<DerivativeSnapshot[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let mounted = true;
    void port.get("preferences", "bybit-derivatives-v1").then((value) => {
      if (mounted && Array.isArray(value)) setRecords(value);
    }).catch(() => { if (mounted) setMessage("Saved derivatives snapshots could not be loaded."); });
    return () => { mounted = false; };
  }, [port]);

  async function importSnapshots(file: File) {
    setBusy(true);
    try {
      if (file.size > 10_000_000) throw new Error("Choose a recorder snapshot file under 10 MB.");
      const imported = parseDerivativeSnapshots(await file.text());
      if (!imported.length) throw new Error("The file contains no Bybit linear snapshots.");
      const saved = await port.get("preferences", "bybit-derivatives-v1");
      const merged = [...new Map([...(Array.isArray(saved) ? saved as DerivativeSnapshot[] : []), ...imported]
        .map((row) => [row.pair + "|" + row.t, row])).values()].sort((a, b) => b.t - a.t).slice(0, 10_000);
      await port.put("preferences", "bybit-derivatives-v1", merged);
      setRecords(merged);
      setNow(Date.now());
      setMessage("Recorder snapshots imported.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Snapshot import failed.");
    } finally {
      setBusy(false);
    }
  }

  const { latest, openInterest, interestTime, stale, interestStale, changePercent } = summarizeDerivatives(records, pair, now);
  return (
    <section aria-label="Bybit derivatives context" className="space-y-2 rounded border border-zinc-800 p-3 text-xs">
      <h3 className="font-semibold">Bybit linear derivatives · {pair}</h3>
      <p className="text-zinc-400">Recorder snapshots · chart context</p>
      {latest ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt>Snapshot time</dt><dd>{new Date(latest.t).toISOString()}{stale ? " · stale" : ""}</dd>
          <dt>Funding rate</dt><dd>{latest.fr === null ? "Unavailable" : (latest.fr * 100).toFixed(4) + "%"}{latest.fi ? " / " + latest.fi / 60 + " h" : ""}</dd>
          <dt>Open interest</dt><dd>{openInterest === null ? "Unavailable" : openInterest.toLocaleString() + " base units"}{interestStale ? " · stale" : ""}</dd>
          <dt>Open-interest time</dt><dd>{interestTime === null ? "Unavailable" : new Date(interestTime).toISOString()}</dd>
          <dt>Change since prior sample</dt><dd>{changePercent === null ? "Unavailable" : changePercent.toFixed(2) + "%"}</dd>
        </dl>
      ) : <p>No snapshots for this instrument.</p>}
      <label className="block">Import recorder derivatives JSONL
        <input type="file" accept=".jsonl" disabled={busy} className="block max-w-full" onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void importSnapshots(file);
        }} />
      </label>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
