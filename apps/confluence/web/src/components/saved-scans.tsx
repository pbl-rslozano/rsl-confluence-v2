"use client";

import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { HeaderTip } from "@/components/header-tip";
import { normalizePreferences, type AppPreferences } from "@/lib/preferences-store";

export type ScanInputs = Pick<AppPreferences, "timeframe" | "dataSource" | "universeLimit" | "assetClass" | "sortKey" | "sortDir" | "monitorAssets"> & { search: string };
type Preset = { id: string; name: string; inputs: ScanInputs };
type Port = {
  get(collection: string, id: string): Promise<unknown>;
  put(collection: string, id: string, document: unknown): Promise<void>;
};

function readPresets(value: unknown): Preset[] {
  const saved = value as { version?: unknown; presets?: unknown } | null;
  if (saved?.version !== 1 || !Array.isArray(saved.presets)) return [];
  return saved.presets.flatMap((preset): Preset[] => {
    if (typeof preset?.id !== "string" || typeof preset.name !== "string") return [];
    const preferences = normalizePreferences(preset.inputs);
    if (!preferences) return [];
    return [{ id: preset.id, name: preset.name, inputs: {
      ...preferences,
      search: typeof preset.inputs.search === "string" ? preset.inputs.search : "",
    } }];
  });
}

export function SavedScans({ port, current, onApply }: { port: Port; current: ScanInputs; onApply: (inputs: ScanInputs) => void }) {
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<Preset[] | null>(null);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void port.get("preferences", "saved-scans").then((value) => {
      if (active) setPresets(readPresets(value));
    }).catch(() => { if (active) setError("Saved scans could not be loaded."); });
    return () => { active = false; };
  }, [port]);

  async function persist(next: Preset[]) {
    setBusy(true);
    setError("");
    try {
      await port.put("preferences", "saved-scans", { version: 1, presets: next });
      setPresets(next);
      return true;
    } catch {
      setError("Saved scans could not be updated.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!presets || busy) return;
    const title = name.trim();
    if (!title || presets.some((preset) => preset.id !== editing && preset.name.toLowerCase() === title.toLowerCase())) {
      setError(title ? "A saved scan already uses that name." : "Enter a scan name.");
      return;
    }
    const next = editing
      ? presets.map((preset) => preset.id === editing ? { ...preset, name: title } : preset)
      : [...presets, { id: crypto.randomUUID(), name: title, inputs: current }];
    if (await persist(next)) {
      setEditing(null);
      setName("");
    }
  }

  return (
    <div className="relative">
      {/* v2.8 header (owner decision 16 Nov 2026): icon-only at ≥ 1280 px; same accessible name; HeaderTip adds the hover title and the focus tooltip there only. */}
      <HeaderTip label="Saved scans">
        <button type="button" aria-expanded={open} aria-label="Saved scans" onClick={() => setOpen(!open)}
          className="h-8 rounded border border-zinc-700 px-2 text-xs text-zinc-200 xl:inline-flex xl:w-8 xl:items-center xl:justify-center xl:px-0">
          <FolderOpen aria-hidden="true" className="hidden h-3.5 w-3.5 xl:block" /><span className="xl:sr-only">Saved scans</span>
        </button>
      </HeaderTip>
      {open && (
        <section aria-label="Saved scans" className="absolute start-0 z-30 mt-1 grid w-64 gap-2 rounded border border-zinc-700 bg-zinc-900 p-3 text-xs text-zinc-100">
          <form className="grid gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <label className="grid gap-1">Scan name
              <input value={name} onChange={(event) => setName(event.target.value)} maxLength={60}
                className="rounded border border-zinc-600 bg-zinc-950 p-1" />
            </label>
            <button type="submit" disabled={!presets || busy} className="justify-self-start rounded border border-zinc-600 px-2 py-1">
              {editing ? "Save name" : "Save current scan"}
            </button>
          </form>
          {error && <p role="alert">{error}</p>}
          <ul className="grid max-h-64 gap-2 overflow-auto">
            {presets?.map((preset) => (
              <li key={preset.id} className="grid gap-1 border-t border-zinc-700 pt-1">
                <span className="break-all">{preset.name}</span>
                <div className="flex flex-wrap gap-2">
                  <button type="button" aria-label={"Apply " + preset.name} onClick={() => onApply(preset.inputs)}>Apply</button>
                  <button type="button" aria-label={"Rename " + preset.name} onClick={() => { setEditing(preset.id); setName(preset.name); }}>Rename</button>
                  <button type="button" disabled={busy} aria-label={"Delete " + preset.name}
                    onClick={() => { void persist(presets.filter((item) => item.id !== preset.id)); }}>Delete</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
