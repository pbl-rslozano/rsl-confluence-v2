"use client";

import { useEffect, useState } from "react";
import type { JournalEntry } from "@/lib/paper-broker";
import { paperNoteId } from "@/lib/paper-store";

type Port = {
  get(collection: string, id: string): Promise<unknown>;
  put(collection: string, id: string, document: unknown): Promise<void>;
};

export function TradeAnnotation({ port, trade }: { port: Port; trade: JournalEntry }) {
  const key = paperNoteId(trade); // the journal CSV export reads the same id (Notes column)
  const [tags, setTags] = useState("");
  const [notes, setNotes] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    void port.get("preferences", key).then((value) => {
      if (!active) return;
      const saved = value as { tags?: unknown; notes?: unknown } | null;
      setTags(Array.isArray(saved?.tags) ? saved.tags.filter((tag) => typeof tag === "string").join(", ") : "");
      setNotes(typeof saved?.notes === "string" ? saved.notes : "");
      setReady(true);
    }).catch(() => { if (active) setMessage("Saved annotation could not be loaded."); });
    return () => { active = false; };
  }, [port, key]);

  async function save() {
    setBusy(true);
    try {
      const normalized = [...new Set(tags.split(",").map((tag) => tag.trim()).filter(Boolean))].slice(0, 12);
      await port.put("preferences", key, { tags: normalized, notes: notes.trim() });
      setTags(normalized.join(", "));
      setNotes(notes.trim());
      setMessage("Trade annotation saved.");
    } catch {
      setMessage("Trade annotation could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label="Trade annotation" className="grid gap-2 text-xs" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label className="grid gap-1">Setup tags (comma separated)
        <input disabled={!ready || busy} maxLength={180} value={tags} onChange={(event) => setTags(event.target.value)}
          className="rounded border border-zinc-700 bg-zinc-950 p-1" />
      </label>
      <label className="grid gap-1">Trade notes
        <textarea disabled={!ready || busy} maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)}
          className="rounded border border-zinc-700 bg-zinc-950 p-1" />
      </label>
      <button type="submit" disabled={!ready || busy} className="justify-self-start rounded border border-zinc-700 px-2 py-1">Save annotation</button>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
