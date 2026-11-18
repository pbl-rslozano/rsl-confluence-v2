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

const SAFE_TOKEN_RE = /^[A-Za-z0-9._-]{1,40}$/;
const CFG_RE = /^[0-9a-z]{1,40}$/;
const finiteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const safeTok = (v: unknown): v is string => typeof v === "string" && SAFE_TOKEN_RE.test(v);

/** v2.8 (WP28): validate one untrusted pre-registration; a clean copy with only known fields, or null. */
export function sanitizePreregistration(x: unknown): PreRegistration | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const r = x as Record<string, unknown>;
  if (typeof r.cfg !== "string" || !CFG_RE.test(r.cfg)) return null;
  if (!safeTok(r.source) || !safeTok(r.tf) || !safeTok(r.assetClass) || !safeTok(r.windowMode)) return null;
  if (typeof r.hypothesis !== "string" || r.hypothesis.length > 500) return null;
  if (![1, 3, 6, 12, 24].includes(r.horizon as number)) return null;
  if (!finiteNum(r.startedAt) || !finiteNum(r.decisionDate) || !finiteNum(r.minDays)) return null;
  if (r.minDays < PREREG_MIN_DAYS || r.decisionDate !== r.startedAt + r.minDays * 86_400_000) return null;
  return {
    cfg: r.cfg, source: r.source, tf: r.tf, assetClass: r.assetClass, windowMode: r.windowMode, hypothesis: r.hypothesis,
    horizon: r.horizon as number, startedAt: r.startedAt, decisionDate: r.decisionDate, minDays: r.minDays,
  };
}

/** v2.8 (WP28): validate one untrusted trial entry. */
export function sanitizeTrial(x: unknown): TrialEntry | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const r = x as Record<string, unknown>;
  if (typeof r.id !== "string" || !/^app-[0-9a-f]{8}$/.test(r.id)) return null;
  if (typeof r.cfg !== "string" || !CFG_RE.test(r.cfg)) return null;
  if (typeof r.variant !== "string" || r.variant.length > 200 || !finiteNum(r.at)) return null;
  const out: TrialEntry = { id: r.id, cfg: r.cfg, variant: r.variant, at: r.at };
  if (r.note !== undefined && r.note !== null) {
    if (typeof r.note !== "string" || r.note.length > 500) return null;
    out.note = r.note;
  }
  return out;
}

/* ---- v2.8 final review (I-1): the ledger's own scored records that a backup carries besides the rows ---- */
const TF_RE = /^[0-9]{1,2}[mhdwM]$/;
const PAIR_RE = /^[A-Z0-9]{2,30}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HORIZON_KEYS = new Set(["1", "3", "6", "12", "24"]); // ledger-metrics DEFAULT_HORIZONS
const MAX_OUTCOME_ROWS = 1000;
const MAX_UNIVERSE = 300;
const MAX_GAP_SPANS = 50;
const plainObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** The outcome snapshots of one bar document (`o|<doc>`): row id → horizon → snapshot. */
export interface OutcomeDoc { doc: string; out: Record<string, Record<string, OutcomeSnapshot>> }
/** One stored universe (`u|<src>|<t>`). */
export interface UniverseDoc { src: string; t: number; list: UniverseEntry[] }
/** The recorded gaps of one series (`gap|<src>|<tf>|<pair>`). */
export interface GapDoc { src: string; tf: string; pair: string; spans: GapSpan[] }

function cleanSnapshot(x: unknown): OutcomeSnapshot | null {
  if (!plainObj(x)) return null;
  const n = (v: unknown) => finiteNum(v) && Math.abs(v) < 1e6;
  if (!n(x.g) || !n(x.mfe) || !n(x.mae) || !n(x.f)) return null;
  const out: OutcomeSnapshot = { g: x.g as number, mfe: x.mfe as number, mae: x.mae as number, f: x.f as number };
  // A hold length that was NaN is stored as null by JSON: it is dropped (funding then comes from `f`).
  if (x.hh !== undefined && x.hh !== null) {
    if (!finiteNum(x.hh) || x.hh < 0 || x.hh > 1e6) return null;
    out.hh = x.hh;
  }
  return out;
}

/**
 * v2.8 final review (I-1): validate one untrusted outcome document. The bar document id must be well formed (its day is
 * the day of its bar time) and every row id must belong to that bar (same engine, source, timeframe and time). Anything
 * malformed makes the whole document null; nothing throws.
 */
export function sanitizeOutcomeDoc(x: unknown): OutcomeDoc | null {
  if (!plainObj(x) || typeof x.doc !== "string" || !plainObj(x.out)) return null;
  const parts = x.doc.split("|");
  if (parts.length !== 5) return null;
  const [day, src, tf, cfg, ts] = parts;
  const t = Number(ts);
  if (!DAY_RE.test(day) || !SAFE_TOKEN_RE.test(src) || !TF_RE.test(tf) || !CFG_RE.test(cfg) || !/^\d{1,16}$/.test(ts) || !Number.isSafeInteger(t)) return null;
  if (dayOf(t) !== day) return null;
  const keys = Object.keys(x.out);
  if (!keys.length || keys.length > MAX_OUTCOME_ROWS) return null;
  const out: Record<string, Record<string, OutcomeSnapshot>> = {};
  for (const rowId of keys) {
    const rp = rowId.split("|");
    if (rp.length !== 5 || rp[0] !== cfg || rp[1] !== src || rp[2] !== tf || !PAIR_RE.test(rp[3]) || rp[4] !== ts) return null;
    const hs = (x.out as Record<string, unknown>)[rowId];
    if (!plainObj(hs)) return null;
    const hk = Object.keys(hs);
    if (!hk.length) return null;
    const clean: Record<string, OutcomeSnapshot> = {};
    for (const h of hk) {
      if (!HORIZON_KEYS.has(h)) return null;
      const s = cleanSnapshot(hs[h]);
      if (!s) return null;
      clean[h] = s;
    }
    out[rowId] = clean;
  }
  return { doc: x.doc, out };
}

/** v2.8 final review (I-1): validate one untrusted universe snapshot. */
export function sanitizeUniverseDoc(x: unknown): UniverseDoc | null {
  if (!plainObj(x) || !safeTok(x.src) || !Number.isSafeInteger(x.t) || (x.t as number) < 0 || !Array.isArray(x.list)) return null;
  if (!x.list.length || x.list.length > MAX_UNIVERSE) return null;
  const list: UniverseEntry[] = [];
  for (const e of x.list) {
    if (!plainObj(e) || typeof e.p !== "string" || !PAIR_RE.test(e.p) || !finiteNum(e.qv) || e.qv < 0 || !safeTok(e.ac)) return null;
    list.push({ p: e.p, qv: e.qv, ac: e.ac });
  }
  return { src: x.src, t: x.t as number, list };
}

/** v2.8 final review (I-1): validate one untrusted series of recorded gaps. */
export function sanitizeGapDoc(x: unknown): GapDoc | null {
  if (!plainObj(x) || !safeTok(x.src) || typeof x.tf !== "string" || !TF_RE.test(x.tf) || typeof x.pair !== "string" || !PAIR_RE.test(x.pair)) return null;
  if (!Array.isArray(x.spans) || !x.spans.length || x.spans.length > MAX_GAP_SPANS) return null;
  const spans: GapSpan[] = [];
  for (const s of x.spans) {
    if (!plainObj(s) || !finiteNum(s.from) || !finiteNum(s.to) || s.from > s.to) return null;
    spans.push({ from: s.from, to: s.to });
  }
  return { src: x.src, tf: x.tf, pair: x.pair, spans };
}

/** Per record kind: added, already on this device (`present`), and not kept (rows not on this device, too old, no room under the cap). */
export interface RestoreExtraCounts { added: number; present: number; notKept: number }

/** capDropped = ledger ROWS removed by the row cap (whole oldest days); agePrunedDays = days dropped for age. Never index units. */
export interface RestoreRowsResult { added: number; duplicates: number; tooOld: number; capDropped: number; agePrunedDays: number }
/** Filled by prune/dropDay when a restore wants to know what was removed. */
interface PruneStats { ageDays: number; capDays: number; capRows: number }

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
/** Row cap per storage kind (~380 B per row before v2.8 WP25; a populated `rad` adds ~110 B, `rad: null` ~10 B, so a radar-recording ledger is ~30 % heavier per row; v2.8 WP22 scb + scp add about 130 B per row; v2.8 WP23 `v2` adds about 54 B per row, 10 B when null). */
export function maxRowsFor(kind: string): number {
  if (kind === "sqlite") return 1_000_000;
  if (kind === "indexeddb") return 400_000;
  if (kind === "localstorage") return 5_000;
  return 20_000;
}

/** v2.8 final review (I-2): a restore writes at most this many rows per chunk (a day that holds more is one chunk). */
export const RESTORE_CHUNK_ROWS = 1000;

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

  async function dayRows(port: LedgerPort, day: string): Promise<number> {
    const dayDoc = ((await port.get(LEDGER_META, `day|${day}`)) as DayDoc | null) ?? {};
    let n = 0;
    for (const id of dayDoc.ids ?? []) n += ((await port.get(LEDGER_COLLECTION, id)) as BarDoc | null)?.rows?.length ?? 0;
    return n;
  }

  async function dropDay(port: LedgerPort, index: LedgerIndex, day: string): Promise<void> {
    const dayDoc = ((await port.get(LEDGER_META, `day|${day}`)) as DayDoc | null) ?? {};
    for (const id of dayDoc.ids ?? []) await port.del(LEDGER_COLLECTION, id);
    for (const id of dayDoc.meta ?? []) await port.del(LEDGER_META, id);
    await port.del(LEDGER_META, `day|${day}`);
    delete index.days[day];
  }

  async function prune(port: LedgerPort, index: LedgerIndex, now: number, aggressive = false, stats?: PruneStats): Promise<void> {
    const cutoff = dayOf(now - retentionFor(port.kind) * 86_400_000);
    const days = Object.keys(index.days).sort();
    for (const d of days) if (d < cutoff) { await dropDay(port, index, d); if (stats) stats.ageDays++; }
    let total = Object.values(index.days).reduce((a, n) => a + n, 0);
    const cap = maxRowsFor(port.kind);
    for (const d of Object.keys(index.days).sort()) {
      if (total <= cap) break;
      total -= index.days[d];
      if (stats) { stats.capRows += await dayRows(port, d); stats.capDays++; }
      await dropDay(port, index, d);
    }
    if (aggressive) {
      const remaining = Object.keys(index.days).sort();
      for (const d of remaining.slice(0, Math.max(1, Math.ceil(remaining.length / 4)))) await dropDay(port, index, d);
    }
  }

  /**
   * Writes meta documents (outcome snapshots, universes) that belong to a day. v2.8 final review (I-2): the index is saved
   * with the new units BEFORE any document, then the day document lists the key, then the document is written, so a
   * failure at any point (a full store) never leaves a document that pruning cannot reach. Units of documents that were
   * not written are taken back and the index saved again (best effort; an over-count only prunes earlier).
   */
  async function writeMeta(port: LedgerPort, index: LedgerIndex, items: { day: string; key: string; units: number; doc: unknown }[]): Promise<void> {
    if (!items.length) return;
    for (const it of items) index.days[it.day] = (index.days[it.day] ?? 0) + it.units;
    await port.put(LEDGER_META, INDEX_ID, index);
    let i = 0;
    try {
      for (; i < items.length; i++) {
        const it = items[i];
        const dayDoc = ((await port.get(LEDGER_META, `day|${it.day}`)) as DayDoc | null) ?? { ids: [] };
        if (!(dayDoc.meta ?? []).includes(it.key)) {
          dayDoc.meta = [...(dayDoc.meta ?? []), it.key];
          await port.put(LEDGER_META, `day|${it.day}`, dayDoc);
        }
        await port.put(LEDGER_META, it.key, it.doc);
      }
    } catch (error) {
      for (const it of items.slice(i)) index.days[it.day] = Math.max(0, (index.days[it.day] ?? 0) - it.units);
      await port.put(LEDGER_META, INDEX_ID, index).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Appends rows. v2.8 final review (I-2): the order makes every failure consistent. (1) the index is saved with the
   * chunk's new rows counted, so every day this call touches is indexed before any of its documents exists; (2) the day
   * documents list the new bar documents; (3) the bar documents are written. If a put fails part-way, the units of rows
   * that were not written are taken back and the index is saved again, then the error is rethrown. Pruning walks the
   * index, so no stored row is ever out of its reach.
   */
  async function write(port: LedgerPort, rows: LedgerRow[], universe?: UniverseSnapshot, stats?: PruneStats): Promise<number> {
    const groups = new Map<string, LedgerRow[]>();
    for (const r of rows) {
      const id = `${dayOf(r.t)}|${r.src}|${r.tf}|${r.cfg}|${r.t}`;
      const list = groups.get(id);
      if (list) list.push(r); else groups.set(id, [r]);
    }
    const index = await readIndex(port);
    await prune(port, index, Date.now(), false, stats);
    const plans: { id: string; day: string; doc: BarDoc; toAdd: LedgerRow[]; isNew: boolean; list: LedgerRow[] }[] = [];
    for (const [id, list] of groups) {
      const day = id.split("|")[0];
      const stored = (await port.get(LEDGER_COLLECTION, id)) as BarDoc | null;
      const doc = stored ?? { schema: 2, day, src: list[0].src, tf: list[0].tf, cfg: list[0].cfg, t: list[0].t, rows: [] };
      const have = new Set(doc.rows.map((r) => r.id));
      const toAdd = list.filter((r) => !have.has(r.id));
      if (toAdd.length) plans.push({ id, day, doc, toAdd, isNew: !have.size, list });
      else list.forEach((r) => seen.add(r.id));
    }
    let added = 0;
    if (plans.length) {
      for (const p of plans) index.days[p.day] = (index.days[p.day] ?? 0) + p.toAdd.length;
      await port.put(LEDGER_META, INDEX_ID, index); // (1)
      let written = 0;
      try {
        const newIds = new Map<string, string[]>();
        for (const p of plans) if (p.isNew) newIds.set(p.day, [...(newIds.get(p.day) ?? []), p.id]);
        for (const [day, ids] of newIds) { // (2)
          const dayDoc = ((await port.get(LEDGER_META, `day|${day}`)) as DayDoc | null) ?? { ids: [] };
          dayDoc.ids = [...new Set([...(dayDoc.ids ?? []), ...ids])];
          await port.put(LEDGER_META, `day|${day}`, dayDoc);
        }
        for (; written < plans.length; written++) { // (3)
          const p = plans[written];
          await port.put(LEDGER_COLLECTION, p.id, { ...p.doc, rows: [...p.doc.rows, ...p.toAdd] });
          added += p.toAdd.length;
          p.list.forEach((r) => seen.add(r.id));
        }
      } catch (error) {
        for (const p of plans.slice(written)) index.days[p.day] = Math.max(0, (index.days[p.day] ?? 0) - p.toAdd.length);
        await port.put(LEDGER_META, INDEX_ID, index).catch(() => undefined);
        throw error;
      }
    }
    // The full venue ranking, once per (source, bar time) — only for the scan's
    // newest bar, so a lagging pair cannot attach today's ranking to an older bar.
    if (universe?.list.length && rows.length) {
      const key = `u|${rows[0].src}|${universe.t}`;
      if (!(await port.get(LEDGER_META, key))) {
        await writeMeta(port, index, [{ day: dayOf(universe.t), key, units: UNIVERSE_UNITS, doc: { src: rows[0].src, t: universe.t, list: universe.list.slice(0, 300) } }]);
      }
    }
    // Prune again after writing: rows older than the window (e.g. catch-up of
    // very old bars) must not outlive this call.
    await prune(port, index, Date.now(), false, stats);
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

  /**
   * v2.8 (WP21): recorded scores for one series at the given bar open times, read by document id (one get per bar, never the
   * whole ledger). Only rows with the same engine config and a full engine window (wb = `fullWindow`) count, so a reused
   * score is exactly the one the list would show.
   */
  function seriesScores(src: string, tf: string, pair: string, cfg: string, times: number[], fullWindow: number): Promise<Map<number, number>> {
    return enqueue(async (port) => {
      const out = new Map<number, number>();
      for (const t of times) {
        const doc = (await port.get(LEDGER_COLLECTION, `${dayOf(t)}|${src}|${tf}|${cfg}|${t}`)) as BarDoc | null;
        const row = doc?.rows?.find((r) => r.pair === pair && r.cfg === cfg && r.t === t && r.wb === fullWindow);
        if (row && Number.isFinite(row.sc)) out.set(t, row.sc);
      }
      return out;
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
      const items: { day: string; key: string; units: number; doc: unknown }[] = [];
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
        if (changed) items.push({ day: id.split("|")[0], key, units: newRows * SNAPSHOT_UNITS, doc: { out } });
      }
      await writeMeta(port, index, items);
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
  /* ---- v2.8 (WP28): restore from an encrypted backup. Rows are already sanitised by the caller. ---- */
  /**
   * Restore chunks of at most RESTORE_CHUNK_ROWS rows, or one whole day when a day holds more, never splitting a day (so a
   * day is never re-created after its eviction). v2.8 final review (I-2): small chunks, each indexed before its documents
   * are written, so a full store stops a restore at a chunk boundary or inside one chunk with the index consistent.
   */
  function restoreChunks(fresh: LedgerRow[]): LedgerRow[][] {
    const out: LedgerRow[][] = [];
    let cur: LedgerRow[] = [];
    let i = 0;
    while (i < fresh.length) {
      const day = dayOf(fresh[i].t);
      let j = i;
      while (j < fresh.length && dayOf(fresh[j].t) === day) j++;
      if (cur.length && cur.length + (j - i) > RESTORE_CHUNK_ROWS) { out.push(cur); cur = []; }
      for (let k = i; k < j; k++) cur.push(fresh[k]);
      i = j;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  /** The dry run: replays write()'s pruning (age, then whole oldest days over the cap) over the index, chunk by chunk. */
  async function simulateRestore(port: LedgerPort, chunks: LedgerRow[][]): Promise<{ stats: PruneStats; units: Record<string, number>; gone: Set<string>; added: Record<string, number> }> {
    const units = { ...(await readIndex(port)).days };
    const stats: PruneStats = { ageDays: 0, capDays: 0, capRows: 0 };
    const gone = new Set<string>(); // days already evicted in this simulation (their stored rows are gone)
    const added: Record<string, number> = {};
    const cutoff = dayOf(Date.now() - retentionFor(port.kind) * 86_400_000);
    const cap = maxRowsFor(port.kind);
    const evict = async (d: string): Promise<number> => {
      const rows = (gone.has(d) ? 0 : await dayRows(port, d)) + (added[d] ?? 0);
      gone.add(d);
      added[d] = 0;
      delete units[d];
      return rows;
    };
    const prune = async () => {
      for (const d of Object.keys(units).sort()) if (d < cutoff) { await evict(d); stats.ageDays++; }
      let total = Object.values(units).reduce((a, n) => a + n, 0);
      for (const d of Object.keys(units).sort()) {
        if (total <= cap) break;
        total -= units[d];
        stats.capRows += await evict(d);
        stats.capDays++;
      }
    };
    for (const chunk of chunks) {
      await prune();
      for (const r of chunk) { const d = dayOf(r.t); units[d] = (units[d] ?? 0) + 1; added[d] = (added[d] ?? 0) + 1; }
      await prune();
    }
    return { stats, units, gone, added };
  }

  /** The ledger as it stands after the rows step of a restore: real (read from the store) or simulated (dry run). */
  interface LedgerView {
    /** day → index units; a copy the extras planner charges as it goes. */
    units: Record<string, number>;
    /** Row ids of a bar document after the rows step, or null when it does not exist. */
    rowIds(docId: string): Promise<Set<string> | null>;
    /** A meta document of `day` after the rows step (null when absent or when its day was evicted). */
    meta(key: string, day: string): Promise<unknown>;
  }

  /** Rows of a restore: dry run (simulated) or real (written in small indexed chunks), and the ledger view after them. */
  async function rowsPhase(port: LedgerPort, rows: LedgerRow[], dryRun: boolean): Promise<{ result: RestoreRowsResult; view: () => Promise<LedgerView> }> {
    const cutoff = dayOf(Date.now() - retentionFor(port.kind) * 86_400_000);
    let tooOld = 0;
    let duplicates = 0;
    const groups = new Map<string, LedgerRow[]>();
    const inFile = new Set<string>();
    for (const r of rows) {
      if (dayOf(r.t) < cutoff) { tooOld++; continue; }
      if (inFile.has(r.id)) { duplicates++; continue; }
      inFile.add(r.id);
      const id = barDocId(r);
      const l = groups.get(id);
      if (l) l.push(r); else groups.set(id, [r]);
    }
    const fresh: LedgerRow[] = [];
    for (const [id, list] of groups) {
      const doc = (await port.get(LEDGER_COLLECTION, id)) as BarDoc | null;
      const have = new Set((doc?.rows ?? []).map((r) => r.id));
      for (const r of list) { if (have.has(r.id)) duplicates++; else fresh.push(r); }
    }
    fresh.sort((a, b) => a.t - b.t || a.pair.localeCompare(b.pair));
    const chunks = restoreChunks(fresh);
    const realView = async (): Promise<LedgerView> => ({
      units: { ...(await readIndex(port)).days },
      rowIds: async (docId) => {
        const doc = (await port.get(LEDGER_COLLECTION, docId)) as BarDoc | null;
        return doc ? new Set((doc.rows ?? []).map((r) => r.id)) : null;
      },
      meta: (key) => port.get(LEDGER_META, key),
    });
    if (dryRun) {
      const sim = await simulateRestore(port, chunks);
      const freshByDoc = new Map<string, Set<string>>();
      for (const r of fresh) { const id = barDocId(r); const set = freshByDoc.get(id); if (set) set.add(r.id); else freshByDoc.set(id, new Set([r.id])); }
      const view = async (): Promise<LedgerView> => ({
        units: { ...sim.units },
        rowIds: async (docId) => {
          const d = docId.slice(0, 10);
          const out = new Set<string>();
          let exists = false;
          if (!sim.gone.has(d)) {
            const doc = (await port.get(LEDGER_COLLECTION, docId)) as BarDoc | null;
            if (doc) { exists = true; for (const r of doc.rows ?? []) out.add(r.id); }
          }
          if ((sim.added[d] ?? 0) > 0 && freshByDoc.has(docId)) { exists = true; for (const id of freshByDoc.get(docId)!) out.add(id); }
          return exists ? out : null;
        },
        meta: async (key, day) => (sim.gone.has(day) ? null : port.get(LEDGER_META, key)),
      });
      return { result: { added: fresh.length, duplicates, tooOld, capDropped: sim.stats.capRows, agePrunedDays: sim.stats.ageDays }, view };
    }
    const st: PruneStats = { ageDays: 0, capDays: 0, capRows: 0 };
    let added = 0;
    for (const chunk of chunks) {
      try {
        added += await write(port, chunk, undefined, st);
      } catch (error) {
        // v2.8 final review (I-2): no aggressive pruning here (it would delete this device's rows to make room for older
        // backup rows, against the plan). Stop: write() left the index consistent, the caller reports a partial restore,
        // and running it again stops at the same point or finishes once there is room.
        if (isQuotaError(error)) full = true;
        throw error;
      }
    }
    return { result: { added, duplicates, tooOld, capDropped: st.capRows, agePrunedDays: st.ageDays }, view: realView };
  }

  /**
   * v2.8 final review (I-1): plan the outcome snapshots and universes of a restore against the ledger after its rows step.
   * Merged by key; a local value is never overwritten (a row's snapshots gain only the horizons it lacks). Kept only for rows
   * this device holds after the restore and within its age window, and only while they fit under the row cap: they never
   * cause a row to be removed. Newest days first; the same function runs for the dry run and the real run, so the counts
   * agree.
   */
  async function planExtras(kind: string, view: LedgerView, outcomes: OutcomeDoc[], universes: UniverseDoc[]) {
    const cutoff = dayOf(Date.now() - retentionFor(kind) * 86_400_000);
    const cap = maxRowsFor(kind);
    let total = Object.values(view.units).reduce((a, n) => a + n, 0);
    const items: { day: string; key: string; units: number; doc: unknown }[] = [];
    const oc: RestoreExtraCounts = { added: 0, present: 0, notKept: 0 };
    const uc: RestoreExtraCounts = { added: 0, present: 0, notKept: 0 };
    // The same bar document twice in a file: merged, the first value of a row and horizon wins.
    const byDoc = new Map<string, Record<string, Record<string, OutcomeSnapshot>>>();
    for (const od of outcomes) {
      const cur = byDoc.get(od.doc) ?? {};
      for (const [rowId, hs] of Object.entries(od.out)) cur[rowId] = { ...hs, ...(cur[rowId] ?? {}) };
      byDoc.set(od.doc, cur);
    }
    for (const doc of [...byDoc.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))) {
      const fromFile = byDoc.get(doc)!;
      const rowKeys = Object.keys(fromFile).sort();
      const day = doc.slice(0, 10);
      if (day < cutoff || !(day in view.units)) { oc.notKept += rowKeys.length; continue; }
      const ids = await view.rowIds(doc);
      const key = `o|${doc}`;
      const local = ((await view.meta(key, day)) as { out?: Record<string, Record<string, OutcomeSnapshot>> } | null)?.out ?? {};
      const out = { ...local };
      let units = 0;
      let changed = false;
      for (const rowId of rowKeys) {
        if (!ids?.has(rowId)) { oc.notKept++; continue; }
        const before = local[rowId];
        const missing = Object.keys(fromFile[rowId]).some((h) => !before || !Object.prototype.hasOwnProperty.call(before, h));
        if (!missing) { oc.present++; continue; }
        const cost = before ? 0 : SNAPSHOT_UNITS;
        if (total + cost > cap) { oc.notKept++; continue; }
        total += cost;
        units += cost;
        out[rowId] = { ...fromFile[rowId], ...(before ?? {}) };
        changed = true;
        oc.added++;
      }
      if (changed) { items.push({ day, key, units, doc: { out } }); view.units[day] = (view.units[day] ?? 0) + units; }
    }
    const planned = new Set<string>();
    for (const u of [...universes].sort((a, b) => b.t - a.t || (a.src < b.src ? -1 : a.src > b.src ? 1 : 0))) {
      const key = `u|${u.src}|${u.t}`;
      const day = dayOf(u.t);
      if (planned.has(key)) { uc.present++; continue; }
      if (day < cutoff || !(day in view.units)) { uc.notKept++; continue; }
      if (await view.meta(key, day)) { uc.present++; continue; }
      if (total + UNIVERSE_UNITS > cap) { uc.notKept++; continue; }
      total += UNIVERSE_UNITS;
      planned.add(key);
      items.push({ day, key, units: UNIVERSE_UNITS, doc: { src: u.src, t: u.t, list: u.list } });
      view.units[day] = (view.units[day] ?? 0) + UNIVERSE_UNITS;
      uc.added++;
    }
    return { items, outcomes: oc, universes: uc };
  }

  /**
   * Merge rows by id (an existing row is never overwritten). Rows older than the retention window are not written and are
   * counted as tooOld. The dry run replays the pruning exactly, so capDropped (rows removed by the cap, whole oldest days)
   * and agePrunedDays (days dropped for age) are the same numbers a real run reports.
   */
  function restoreRows(rows: LedgerRow[], o: { dryRun?: boolean } = {}): Promise<RestoreRowsResult> {
    return enqueue(async (port) => (await rowsPhase(port, rows, !!o.dryRun)).result);
  }

  /**
   * v2.8 final review (I-1): restore rows, then their outcome snapshots and the universes (see planExtras). The extras are
   * written in chunks, each indexed before its documents (writeMeta), so a full store stops with the index consistent.
   */
  function restoreLedger(input: { rows: LedgerRow[]; outcomes: OutcomeDoc[]; universes: UniverseDoc[] }, o: { dryRun?: boolean } = {}): Promise<{ rows: RestoreRowsResult; outcomes: RestoreExtraCounts; universes: RestoreExtraCounts }> {
    return enqueue(async (port) => {
      const { result, view } = await rowsPhase(port, input.rows, !!o.dryRun);
      const plan = await planExtras(port.kind, await view(), input.outcomes, input.universes);
      if (!o.dryRun && plan.items.length) {
        const index = await readIndex(port);
        for (let i = 0; i < plan.items.length; i += 200) {
          try {
            await writeMeta(port, index, plan.items.slice(i, i + 200));
          } catch (error) {
            if (isQuotaError(error)) full = true;
            throw error;
          }
        }
      }
      return { rows: result, outcomes: plan.outcomes, universes: plan.universes };
    });
  }

  /** v2.8 final review (I-1): what a backup carries besides the rows: outcome snapshots of the given rows, universes, gaps. */
  function backupMeta(rowIds: Set<string>): Promise<{ outcomes: unknown[]; universes: unknown[]; gaps: unknown[] }> {
    return enqueue(async (port) => {
      const outcomes: unknown[] = [];
      const universes: unknown[] = [];
      const gaps: unknown[] = [];
      for (const { id, doc } of await port.list(LEDGER_META)) {
        const d = doc as Record<string, unknown> | null;
        if (!d || typeof d !== "object") continue;
        if (id.startsWith("o|")) {
          const out: Record<string, unknown> = {};
          const all = (d.out ?? {}) as Record<string, unknown>;
          for (const rowId of Object.keys(all)) if (rowIds.has(rowId)) out[rowId] = all[rowId];
          if (Object.keys(out).length) outcomes.push({ doc: id.slice(2), out });
        } else if (id.startsWith("u|")) {
          universes.push({ src: d.src, t: d.t, list: d.list });
        } else if (id.startsWith("gap|")) {
          const [, src, tf, pair] = id.split("|");
          gaps.push({ src, tf, pair, spans: d.spans });
        }
      }
      return { outcomes, universes, gaps };
    });
  }

  /** v2.8 final review (I-1): merge recorded gaps by series and span start; a local span is never replaced or dropped. */
  function restoreGaps(list: GapDoc[], o: { dryRun?: boolean } = {}): Promise<RestoreExtraCounts> {
    return enqueue(async (port) => {
      const c: RestoreExtraCounts = { added: 0, present: 0, notKept: 0 };
      const bySeries = new Map<string, GapSpan[]>();
      for (const g of list) bySeries.set(`gap|${g.src}|${g.tf}|${g.pair}`, [...(bySeries.get(`gap|${g.src}|${g.tf}|${g.pair}`) ?? []), ...g.spans]);
      for (const [id, incoming] of bySeries) {
        const spans = [...(((await port.get(LEDGER_META, id)) as { spans?: GapSpan[] } | null)?.spans ?? [])];
        let changed = false;
        for (const s of incoming) {
          if (spans.some((g) => g.from === s.from)) { c.present++; continue; }
          if (spans.length >= MAX_GAP_SPANS) { c.notKept++; continue; }
          spans.push({ from: s.from, to: s.to });
          changed = true;
          c.added++;
        }
        if (changed && !o.dryRun) await port.put(LEDGER_META, id, { spans });
      }
      return c;
    });
  }
  /** Merge pre-registrations: a key that exists is kept and its decision date never moves. */
  function restorePreregistrations(list: PreRegistration[], o: { dryRun?: boolean } = {}): Promise<{ added: number; kept: number }> {
    return enqueue(async (port) => {
      let added = 0;
      let kept = 0;
      const seenKeys = new Set<string>();
      for (const p of list) {
        const id = preregKey(p);
        if (seenKeys.has(id) || (await port.get(LEDGER_META, id))) { kept++; continue; }
        seenKeys.add(id);
        if (!o.dryRun) await port.put(LEDGER_META, id, p);
        added++;
      }
      return { added, kept };
    });
  }
  /** Add trials whose `trial|cfg|variant` key is absent; returns how many were added. */
  function restoreTrials(list: TrialEntry[], o: { dryRun?: boolean } = {}): Promise<number> {
    return enqueue(async (port) => {
      let added = 0;
      const seenKeys = new Set<string>();
      for (const t of list) {
        const id = `trial|${t.cfg}|${t.variant}`.slice(0, 240);
        if (seenKeys.has(id) || (await port.get(LEDGER_META, id))) continue;
        seenKeys.add(id);
        if (!o.dryRun) await port.put(LEDGER_META, id, t);
        added++;
      }
      return added;
    });
  }
  /** Newest bar open time stored (0 when empty). Reads only the newest day's bar documents, never the whole ledger. */
  function newestBarTime(): Promise<number> {
    return enqueue(async (port) => {
      const index = await readIndex(port);
      for (const day of Object.keys(index.days).sort().reverse()) {
        const dayDoc = (await port.get(LEDGER_META, `day|${day}`)) as DayDoc | null;
        let newest = 0;
        for (const id of dayDoc?.ids ?? []) {
          const t = ((await port.get(LEDGER_COLLECTION, id)) as BarDoc | null)?.t;
          if (typeof t === "number" && t > newest) newest = t;
        }
        if (newest) return newest;
      }
      return 0;
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
    record, all, seriesScores, stats, clear, cursor, setCursor,
    seriesCursors, setSeriesCursors, outcomes, saveOutcomes, universes,
    registerTrial, trials, preregistration, preregistrations, preregister, lastExport, markExported, slippage, setSlippage,
    addGap, gaps, restoreRows, restoreLedger, restoreGaps, backupMeta, restorePreregistrations, restoreTrials, newestBarTime,
    /** True after a storage-full error that pruning could not resolve (writes are being dropped). */
    isFull: () => full,
    get kind() { return kind; },
  };
}

export type LedgerStore = ReturnType<typeof createLedgerStore>;
