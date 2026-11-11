"use client";

import { useEffect, useState } from "react";
import { DATA_SOURCES, type DataSource } from "@/lib/market-client";

export type Watchlist = { id: string; name: string; source: DataSource; symbols: string[] };
type Port = {
  get(collection: string, id: string): Promise<unknown>;
  put(collection: string, id: string, document: unknown): Promise<void>;
};

function readLists(value: unknown): Watchlist[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item.id === "string" &&
    typeof item.name === "string" && DATA_SOURCES.some(({ value }) => value === item.source) &&
    Array.isArray(item.symbols) && item.symbols.every((symbol: unknown) => typeof symbol === "string"));
}

export function ScannerWatchlists({ port, source, results, monitored, active, onScope }: {
  port: Port;
  source: DataSource;
  results: string[];
  monitored: string[];
  active: Watchlist | null;
  onScope: (list: Watchlist | null) => void;
}) {
  const [lists, setLists] = useState<Watchlist[] | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void port.get("preferences", "watchlists-v1").then((value) => {
      if (live) setLists(readLists(value));
    }).catch(() => { if (live) setError("Watchlists could not be loaded."); });
    return () => { live = false; };
  }, [port]);

  async function persist(next: Watchlist[]) {
    setBusy(true);
    setError("");
    try {
      await port.put("preferences", "watchlists-v1", next);
      setLists(next);
      return true;
    } catch {
      setError("Watchlists could not be saved.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(symbols: string[]) {
    if (!lists || busy) return;
    const title = name.trim();
    if (!title || lists.some((list) => list.name.toLowerCase() === title.toLowerCase())) {
      setError(title ? "That watchlist name is already in use." : "Enter a watchlist name.");
      return;
    }
    if (await persist([...lists, { id: crypto.randomUUID(), name: title, source, symbols: [...new Set(symbols)] }])) {
      setName("");
    }
  }

  return (
    <div className="relative flex flex-wrap items-center gap-1">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
        className="h-8 rounded border border-zinc-700 px-2 text-xs">Watchlists</button>
      {active && (
        <button type="button" aria-label="Clear watchlist scope" onClick={() => onScope(null)}
          className="h-8 rounded border border-cyan-700 px-2 text-xs">{active.name} ×</button>
      )}
      {open && (
        <section aria-label="Watchlists" className="absolute start-0 top-full z-30 mt-1 grid w-64 gap-2 rounded border border-zinc-700 bg-zinc-900 p-3 text-xs">
          <form className="grid gap-2" onSubmit={(event) => { event.preventDefault(); void save(results); }}>
            <label className="grid gap-1">Watchlist name
              <input value={name} onChange={(event) => setName(event.target.value)} maxLength={60}
                className="rounded border border-zinc-600 bg-zinc-950 p-1" />
            </label>
            <button type="submit" disabled={!lists || busy}>Save filtered results</button>
            <button type="button" disabled={!lists || busy || !monitored.length} onClick={() => void save(monitored)}>Import monitored instruments</button>
          </form>
          {error && <p role="alert">{error}</p>}
          <ul className="grid max-h-64 gap-2 overflow-auto">
            {lists?.map((list) => (
              <li key={list.id} className="grid gap-1 border-t border-zinc-700 pt-1">
                <span className="break-all">{list.name} · {list.source} · {list.symbols.length} instruments</span>
                <div className="flex gap-2">
                  <button type="button" aria-label={"Scan " + list.name} onClick={() => onScope(list)}>Scan</button>
                  <button type="button" disabled={busy} aria-label={"Delete " + list.name} onClick={async () => {
                    if (await persist(lists.filter((item) => item.id !== list.id)) && active?.id === list.id) onScope(null);
                  }}>Delete</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
