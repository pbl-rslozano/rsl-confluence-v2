/**
 * signal-ledger.ts — v2.3
 * ----------------------------------------------------------------------------
 * Persistent forward-test ledger: every scored closed bar is written once, so
 * the Master Signal can be measured against what happened next.
 *
 * Layout (v2.2, after code review):
 *   • collection `ledger`:      one document per (day, source, timeframe,
 *                               engine, BAR TIME) holding that bar's rows for
 *                               every pair. A scan writes only the new bar's
 *                               document — no growing day bucket is rewritten
 *                               (the first design cost O(n²) bytes per day).
 *   • collection `ledger_meta`: `index` (rows per day) and `day|<yyyy-mm-dd>`
 *                               (document ids of that day), so pruning never
 *                               loads the ledger.
 * Retention: by age (days, per storage durability) and by a row cap. On a
 * storage-full error the oldest quarter of days is dropped and the write is
 * retried once. All writes AND clear() go through one queue.
 *
 * Storage: native SQLite in the desktop/mobile shells; in the browser a
 * separate IndexedDB database (`rsl-conf-ledger`), so adding the ledger never
 * forces a version upgrade of the main database (an open older tab would
 * block that upgrade). The ledger is exported separately (CSV/JSON) and is not
 * part of `.rslbak` backups.
 *
 * v2.3 (after review C9): the full venue ranking is stored ONCE per (source,
 * bar time) as `u|<src>|<t>` and outcome snapshots per bar document as
 * `o|<bar doc id>`, both in `ledger_meta`, so reading the rows never loads
 * them. Both count toward the row cap (a ranking ≈ 40 rows, a row's snapshots
 * ≈ ½ row) and are dropped with their day. Writes are serialised across tabs
 * with the Web Locks API where available.
 * ----------------------------------------------------------------------------
 */
import type { LedgerRow, OutcomeSnapshot } from "./ledger-metrics";

export const LEDGER_COLLECTION = "ledger";
export const LEDGER_META = "ledger_meta";
const INDEX_ID = "index";

export interface LedgerPort {
  kind: string;
  get(col: string, id: string): Promise<unknown>;
  put(col: string, id: string, doc: unknown): Promise<void>;
  del(col: string, id: string): Promise<void>;
  list(col: string): Promise<{ id: string; doc: unknown }[]>;
}

interface BarDoc {
  schema: 2;
  day: string;
  src: string;
  tf: string;
  cfg: string;
  t: number;
  rows: LedgerRow[];
}

/** Row-cap units charged for one stored universe and for one row's outcome snapshots (~380 B per unit). */
export const UNIVERSE_UNITS = 40;
export const SNAPSHOT_UNITS = 0.5;
interface DayDoc { ids?: string[]; meta?: string[] }

export interface UniverseEntry { p: string; qv: number; ac: string }
/** The full venue ranking observed at bar time `t` (the scan's newest closed bar). */
export interface UniverseSnapshot { t: number; list: UniverseEntry[] }

/** Short stable id (FNV-1a, 32-bit hex) for trial records. */
export function hashId(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

/** Pre-registration: the hypothesis is fixed before the evidence is looked at. */
export interface PreRegistration {
  cfg: string;
  /** v2.3 (review C3): the view the hypothesis applies to; the gate only counts in this view. */
  source: string;
  tf: string;
  assetClass: string;
  windowMode: string;
  hypothesis: string;
  horizon: number;
  startedAt: number;
  decisionDate: number;
  minDays: number;
}
export const PREREG_MIN_DAYS = 90;

/** One schema for app, replay (trials.jsonl) and MCP: id, at, cfg, variant. */
export interface TrialEntry { id: string; cfg: string; variant: string; at: number; note?: string }
export interface GapSpan { from: number; to: number }

interface LedgerIndex {
  schema: 2;
  days: Record<string, number>; // day → rows
}

export interface LedgerStats {
  rows: number;
  days: number;
  oldestDay: string | null;
  newestDay: string | null;
  retentionDays: number;
  maxRows: number;
  /** True after a storage-full error that pruning could not resolve. */
  full: boolean;
}

/** Days kept per storage kind: durable stores keep a year+, fragile ones far less. */
export function retentionFor(kind: string): number {
  if (kind === "sqlite" || kind === "indexeddb") return 400;
  if (kind === "localstorage") return 14;
  return 2;
}
/** Row cap per storage kind (~380 B per row). */
export function maxRowsFor(kind: string): number {
  if (kind === "sqlite") return 1_000_000;
  if (kind === "indexeddb") return 400_000;
  if (kind === "localstorage") return 5_000;
  return 20_000;
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const isQuotaError = (e: unknown) =>
  e instanceof Error && /quota|QUOTA|NS_ERROR_DOM_QUOTA|full|disk/i.test(`${e.name} ${e.message}`);

export function createLedgerStore(portOrPromise: LedgerPort | Promise<LedgerPort>) {
  const portP = Promise.resolve(portOrPromise);
  let kind = "memory";
  void portP.then((p) => { kind = p.kind; }).catch(() => undefined);
  const seen = new Set<string>();
  let full = false;
  let queue: Promise<unknown> = Promise.resolve();
  // Cross-tab serialisation (review S10): two tabs writing the same index would
  // otherwise lose each other's updates (last writer wins).
  const locks = (globalThis as { navigator?: { locks?: { request: <T>(name: string, cb: () => Promise<T>) => Promise<T> } } }).navigator?.locks;
  const enqueue = <T>(fn: (port: LedgerPort) => Promise<T>): Promise<T> => {
    const job = queue.then(() => portP).then((port) => (locks ? locks.request("rsl-conf-ledger", () => fn(port)) : fn(port)));
    queue = job.catch(() => undefined);
    return job;
  };

  async function readIndex(port: LedgerPort): Promise<LedgerIndex> {
    const doc = (await port.get(LEDGER_META, INDEX_ID)) as LedgerIndex | null;
    return doc && doc.schema === 2 ? doc : { schema: 2, days: {} };
  }

  async function dropDay(port: LedgerPort, index: LedgerIndex, day: string): Promise<void> {
    const dayDoc = ((await port.get(LEDGER_META, `day|${day}`)) as DayDoc | null) ?? {};
    for (const id of dayDoc.ids ?? []) await port.del(LEDGER_COLLECTION, id);
    for (const id of dayDoc.meta ?? []) await port.del(LEDGER_META, id);
    await port.del(LEDGER_META, `day|${day}`);
    delete index.days[day];
  }

  async function prune(port: LedgerPort, index: LedgerIndex, now: number, aggressive = false): Promise<void> {
    const cutoff = dayOf(now - retentionFor(port.kind) * 86_400_000);
    const days = Object.keys(index.days).sort();
    for (const d of days) if (d < cutoff) await dropDay(port, index, d);
    let total = Object.values(index.days).reduce((a, n) => a + n, 0);
    const cap = maxRowsFor(port.kind);
    for (const d of Object.keys(index.days).sort()) {
      if (total <= cap) break;
      total -= index.days[d];
      await dropDay(port, index, d);
    }
    if (aggressive) {
      const remaining = Object.keys(index.days).sort();
      for (const d of remaining.slice(0, Math.max(1, Math.ceil(remaining.length / 4)))) await dropDay(port, index, d);
    }
  }

  async function addDayMeta(port: LedgerPort, index: LedgerIndex, day: string, key: string, units: number): Promise<void> {
    const dayDoc = ((await port.get(LEDGER_META, `day|${day}`)) as DayDoc | null) ?? { ids: [] };
    if (!(dayDoc.meta ?? []).includes(key)) dayDoc.meta = [...(dayDoc.meta ?? []), key];
    await port.put(LEDGER_META, `day|${day}`, dayDoc);
    index.days[day] = (index.days[day] ?? 0) + units;
  }

  async function write(port: LedgerPort, rows: LedgerRow[], universe?: UniverseSnapshot): Promise<number> {
    const groups = new Map<string, LedgerRow[]>();
    for (const r of rows) {
      const id = `${dayOf(r.t)}|${r.src}|${r.tf}|${r.cfg}|${r.t}`;
      const list = groups.get(id);
      if (list) list.push(r); else groups.set(id, [r]);
    }
    const index = await readIndex(port);
    await prune(port, index, Date.now());
    let added = 0;
    for (const [id, list] of groups) {
      const day = id.split("|")[0];
      const existing = ((await port.get(LEDGER_COLLECTION, id)) as BarDoc | null) ?? {
        schema: 2, day, src: list[0].src, tf: list[0].tf, cfg: list[0].cfg, t: list[0].t, rows: [],
      };
      const have = new Set(existing.rows.map((r) => r.id));
      const toAdd = list.filter((r) => !have.has(r.id));
      if (toAdd.length) {
        existing.rows.push(...toAdd);
        await port.put(LEDGER_COLLECTION, id, existing);
        if (!have.size) {
          const dayDoc = ((await port.get(LEDGER_META, `day|${day}`)) as DayDoc | null) ?? { ids: [] };
          dayDoc.ids = [...new Set([...(dayDoc.ids ?? []), id])];
          await port.put(LEDGER_META, `day|${day}`, dayDoc);
        }
        index.days[day] = (index.days[day] ?? 0) + toAdd.length;
        added += toAdd.length;
      }
      list.forEach((r) => seen.add(r.id));
    }
    // The full venue ranking, once per (source, bar time) — only for the scan's
    // newest bar, so a lagging pair cannot attach today's ranking to an older bar.
    if (universe?.list.length && rows.length) {
      const key = `u|${rows[0].src}|${universe.t}`;
      if (!(await port.get(LEDGER_META, key))) {
        await port.put(LEDGER_META, key, { src: rows[0].src, t: universe.t, list: universe.list.slice(0, 300) });
        await addDayMeta(port, index, dayOf(universe.t), key, UNIVERSE_UNITS);
      }
    }
    // Prune again after writing: rows older than the window (e.g. catch-up of
    // very old bars) must not outlive this call.
    await prune(port, index, Date.now());
    await port.put(LEDGER_META, INDEX_ID, index);
    return added;
  }

  /** Append rows (idempotent by row id). `universe` is the full unfiltered ranking at the scan's newest bar. */
  function record(rows: LedgerRow[], universe?: UniverseSnapshot): Promise<number> {
    if (seen.size > 50_000) seen.clear(); // bound memory; the store itself is idempotent
    const fresh = rows.filter((r) => !seen.has(r.id));
    if (!fresh.length) return Promise.resolve(0);
    return enqueue(async (port) => {
      try {
        const n = await write(port, fresh, universe);
        full = false;
        return n;
      } catch (error) {
        if (!isQuotaError(error)) throw error;
        // Storage full: free the oldest quarter of days, then retry once.
        const index = await readIndex(port);
        await prune(port, index, Date.now(), true);
        await port.put(LEDGER_META, INDEX_ID, index);
        try {
          const n = await write(port, fresh, universe);
          full = false;
          return n;
        } catch {
          full = true;
          return 0;
        }
      }
    });
  }

  function all(): Promise<LedgerRow[]> {
    return enqueue(async (port) => {
      const docs = await port.list(LEDGER_COLLECTION);
      const out: LedgerRow[] = [];
      for (const { doc } of docs) {
        const b = doc as BarDoc;
        if (b && Array.isArray(b.rows)) for (const r of b.rows) out.push(r);
      }
      return out.sort((a, b) => a.t - b.t || a.pair.localeCompare(b.pair));
    });
  }

  function stats(): Promise<LedgerStats> {
    return enqueue(async (port) => {
      const index = await readIndex(port);
      const days = Object.keys(index.days).sort();
      return {
        rows: Object.values(index.days).reduce((a, n) => a + n, 0),
        days: days.length,
        oldestDay: days[0] ?? null,
        newestDay: days[days.length - 1] ?? null,
        retentionDays: retentionFor(port.kind),
        maxRows: maxRowsFor(port.kind),
        full,
      };
    });
  }

  function clear(): Promise<void> {
    return enqueue(async (port) => {
      for (const { id } of await port.list(LEDGER_COLLECTION)) await port.del(LEDGER_COLLECTION, id);
      // Trials and pre-registrations survive a clear: wiping them would reset
      // the multiple-testing count, which is exactly what they guard against.
      for (const { id } of await port.list(LEDGER_META)) {
        if (id.startsWith("trial|") || id.startsWith("prereg|")) continue;
        await port.del(LEDGER_META, id);
      }
      seen.clear();
      full = false;
    });
  }

  /** Newest bar time fully recorded (live + catch-up) for a source × timeframe, persisted across sessions. */
  // Keyed by asset-class view too: switching the class filter must not mark
  // another class's bars as already recorded.
  function cursor(src: string, tf: string, cls = "crypto"): Promise<number> {
    return enqueue(async (port) => Number(((await port.get(LEDGER_META, `cursor|${src}|${tf}|${cls}`)) as { t?: number } | null)?.t ?? 0));
  }
  function setCursor(src: string, tf: string, t: number, cls = "crypto"): Promise<void> {
    return enqueue(async (port) => {
      const id = `cursor|${src}|${tf}|${cls}`;
      const cur = Number(((await port.get(LEDGER_META, id)) as { t?: number } | null)?.t ?? 0);
      if (t > cur) await port.put(LEDGER_META, id, { t });
    });
  }

  /* ---- v2.3: per-series cursors ----
   * One document per source × timeframe holding the newest recorded bar per
   * pair. A pair that joined the top-N later is caught up from ITS own last
   * bar, not from the view-wide cursor (which skipped its history). */
  function seriesCursors(src: string, tf: string, configId?: string): Promise<Record<string, number>> {
    return enqueue(async (port) => (((await port.get(LEDGER_META, `cursors|${src}|${tf}${configId ? "|" + configId : ""}`)) as { by?: Record<string, number> } | null)?.by ?? {}));
  }
  function setSeriesCursors(src: string, tf: string, updates: Record<string, number>, configId?: string): Promise<void> {
    return enqueue(async (port) => {
      const id = `cursors|${src}|${tf}${configId ? "|" + configId : ""}`;
      const by = { ...(((await port.get(LEDGER_META, id)) as { by?: Record<string, number> } | null)?.by ?? {}) };
      let changed = false;
      for (const [pair, t] of Object.entries(updates)) if (t > (by[pair] ?? 0)) { by[pair] = t; changed = true; }
      if (changed) await port.put(LEDGER_META, id, { by });
    });
  }

  /* ---- v2.3: outcome snapshots ----
   * Outcomes are stored next to their bar (meta key o|<bar doc id>) once
   * measured, so a later report does not depend on today's exchange still
   * serving that history (delistings). Read only for the rows asked for. */
  const barDocId = (r: LedgerRow) => `${dayOf(r.t)}|${r.src}|${r.tf}|${r.cfg}|${r.t}`;
  function outcomes(rows: LedgerRow[]): Promise<Map<string, Record<string, OutcomeSnapshot>>> {
    return enqueue(async (port) => {
      const map = new Map<string, Record<string, OutcomeSnapshot>>();
      for (const id of new Set(rows.map(barDocId))) {
        const doc = (await port.get(LEDGER_META, `o|${id}`)) as { out?: Record<string, Record<string, OutcomeSnapshot>> } | null;
        if (doc?.out) for (const [rowId, v] of Object.entries(doc.out)) map.set(rowId, v);
      }
      return map;
    });
  }
  function saveOutcomes(rows: LedgerRow[], snaps: Map<string, Record<string, OutcomeSnapshot>>): Promise<number> {
    return enqueue(async (port) => {
      const byDoc = new Map<string, LedgerRow[]>();
      for (const r of rows) {
        if (!snaps.has(r.id)) continue;
        const id = barDocId(r);
        const l = byDoc.get(id);
        if (l) l.push(r); else byDoc.set(id, [r]);
      }
      const index = await readIndex(port);
      let saved = 0;
      for (const [id, list] of byDoc) {
        if (!(await port.get(LEDGER_COLLECTION, id))) continue; // pruned meanwhile
        const key = `o|${id}`;
        const doc = ((await port.get(LEDGER_META, key)) as { out?: Record<string, Record<string, OutcomeSnapshot>> } | null) ?? { out: {} };
        const out = doc.out ?? {};
        let newRows = 0;
        let changed = false;
        for (const r of list) {
          const before = out[r.id];
          const next = { ...(before ?? {}), ...snaps.get(r.id)! };
          if (Object.keys(next).length !== Object.keys(before ?? {}).length) {
            out[r.id] = next;
            changed = true;
            saved++;
            if (!before) newRows++;
          }
        }
        if (changed) {
          await port.put(LEDGER_META, key, { out });
          await addDayMeta(port, index, id.split("|")[0], key, newRows * SNAPSHOT_UNITS);
        }
      }
      await prune(port, index, Date.now());
      await port.put(LEDGER_META, INDEX_ID, index);
      return saved;
    });
  }
  function universes(): Promise<Map<string, UniverseEntry[]>> {
    return enqueue(async (port) => {
      const map = new Map<string, UniverseEntry[]>();
      for (const { id, doc } of await port.list(LEDGER_META)) {
        if (id.startsWith("u|")) map.set(id.slice(2), (doc as { list?: UniverseEntry[] }).list ?? []);
      }
      return map;
    });
  }

  /* ---- v2.3: research hygiene ---- */
  /**
   * Register a variant that was looked at (once). The count over ALL engine
   * configs feeds the deflated Sharpe (review C4): changing the engine does
   * not reset the number of things tried.
   */
  function registerTrial(cfg: string, variant: string, note?: string): Promise<void> {
    return enqueue(async (port) => {
      const id = `trial|${cfg}|${variant}`.slice(0, 240);
      if (await port.get(LEDGER_META, id)) return;
      await port.put(LEDGER_META, id, { id: `app-${hashId(`${cfg}|${variant}`)}`, cfg, variant, at: Date.now(), note } satisfies TrialEntry);
    });
  }
  /** All registered trials (every engine), or one engine's when `cfg` is given. */
  function trials(cfg?: string): Promise<TrialEntry[]> {
    return enqueue(async (port) =>
      (await port.list(LEDGER_META))
        .filter(({ id }) => id.startsWith("trial|"))
        .map(({ doc }) => doc as TrialEntry)
        .filter((d) => d && (!cfg || d.cfg === cfg)));
  }
  const preregKey = (p: Pick<PreRegistration, "cfg" | "source" | "tf" | "assetClass">) => `prereg|${p.cfg}|${p.source}|${p.tf}|${p.assetClass}`;
  function preregistration(scope: Pick<PreRegistration, "cfg" | "source" | "tf" | "assetClass">): Promise<PreRegistration | null> {
    return enqueue(async (port) => ((await port.get(LEDGER_META, preregKey(scope))) as PreRegistration | null) ?? null);
  }
  /** v2.8 (WP19): every stored pre-registration (all engines and views) — the confirmatory gate counts the active ones. */
  function preregistrations(): Promise<PreRegistration[]> {
    return enqueue(async (port) =>
      (await port.list(LEDGER_META))
        .filter(({ id }) => id.startsWith("prereg|"))
        .map(({ doc }) => doc as PreRegistration)
        .filter((d) => !!d && typeof d.cfg === "string"));
  }
  /** Fix the hypothesis once per engine × view; a second call never moves the decision date or the scope. */
  function preregister(p: Omit<PreRegistration, "startedAt" | "decisionDate" | "minDays"> & { minDays?: number }): Promise<PreRegistration> {
    return enqueue(async (port) => {
      const id = preregKey(p);
      const existing = (await port.get(LEDGER_META, id)) as PreRegistration | null;
      if (existing) return existing;
      const minDays = Math.max(PREREG_MIN_DAYS, Math.round(p.minDays ?? PREREG_MIN_DAYS));
      const startedAt = Date.now();
      const doc: PreRegistration = {
        cfg: p.cfg, source: p.source, tf: p.tf, assetClass: p.assetClass, windowMode: p.windowMode,
        hypothesis: String(p.hypothesis).slice(0, 500), horizon: p.horizon,
        startedAt, decisionDate: startedAt + minDays * 86_400_000, minDays,
      };
      await port.put(LEDGER_META, id, doc);
      return doc;
    });
  }
  /** v2.3 (review S12): holes longer than the catch-up limit are recorded, not silently lost. */
  function addGap(src: string, tf: string, pair: string, span: GapSpan): Promise<void> {
    return enqueue(async (port) => {
      const id = `gap|${src}|${tf}|${pair}`;
      const doc = ((await port.get(LEDGER_META, id)) as { spans?: GapSpan[] } | null) ?? { spans: [] };
      const spans = doc.spans ?? [];
      if (!spans.some((g) => g.from === span.from)) spans.push(span);
      await port.put(LEDGER_META, id, { spans: spans.slice(-50) });
    });
  }
  function gaps(src: string, tf: string): Promise<Record<string, GapSpan[]>> {
    return enqueue(async (port) => {
      const out: Record<string, GapSpan[]> = {};
      const prefix = `gap|${src}|${tf}|`;
      for (const { id, doc } of await port.list(LEDGER_META)) if (id.startsWith(prefix)) out[id.slice(prefix.length)] = (doc as { spans?: GapSpan[] }).spans ?? [];
      return out;
    });
  }
  function lastExport(): Promise<number> {
    return enqueue(async (port) => Number(((await port.get(LEDGER_META, "export|last")) as { t?: number } | null)?.t ?? 0));
  }
  function markExported(t = Date.now()): Promise<void> {
    return enqueue((port) => port.put(LEDGER_META, "export|last", { t }));
  }
  /** Measured slippage (bp per side, from order-book depth) per source × pair. */
  function slippage(src: string): Promise<Record<string, { bps: number; at: number }>> {
    return enqueue(async (port) => (((await port.get(LEDGER_META, `slip|${src}`)) as { by?: Record<string, { bps: number; at: number }> } | null)?.by ?? {}));
  }
  function setSlippage(src: string, by: Record<string, number>): Promise<void> {
    return enqueue(async (port) => {
      const id = `slip|${src}`;
      const cur = { ...(((await port.get(LEDGER_META, id)) as { by?: Record<string, { bps: number; at: number }> } | null)?.by ?? {}) };
      const at = Date.now();
      for (const [p, bps] of Object.entries(by)) if (Number.isFinite(bps) && bps >= 0) cur[p] = { bps, at };
      await port.put(LEDGER_META, id, { by: cur });
    });
  }

  return {
    record, all, stats, clear, cursor, setCursor,
    seriesCursors, setSeriesCursors, outcomes, saveOutcomes, universes,
    registerTrial, trials, preregistration, preregistrations, preregister, lastExport, markExported, slippage, setSlippage,
    addGap, gaps,
    /** True after a storage-full error that pruning could not resolve (writes are being dropped). */
    isFull: () => full,
    get kind() { return kind; },
  };
}

export type LedgerStore = ReturnType<typeof createLedgerStore>;
