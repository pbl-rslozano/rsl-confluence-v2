/**
 * paper-store.ts — v2.2 Phase G (PAPER ONLY)
 * ----------------------------------------------------------------------------
 * Persistence for the paper-trading book through the same port interface as
 * the signal ledger (get/put/del/list). Three collections:
 *   • paper_state      one document `account` (balance, settings, kill switch,
 *                      heartbeats, used nonces, decisions)
 *   • paper_positions  one document per open/pending position
 *   • paper_journal    one document per closed trade (immutable)
 *
 * In the browser the integrator passes a port for a SEPARATE IndexedDB
 * database (`rsl-conf-paper`), so the main database never needs an upgrade;
 * in the native shells the main SQLite port. Every write goes through one
 * queue, so overlapping saves can never interleave.
 * ----------------------------------------------------------------------------
 */
import type { LedgerPort } from "./signal-ledger";
import { bookEquity, newBook, PAPER_SCHEMA, type JournalEntry, type PaperAccount, type PaperBook, type PaperPosition } from "./paper-broker";
import { normaliseSettings } from "./risk-engine";

export type PaperPort = LedgerPort;
export const PAPER_STATE = "paper_state";
export const PAPER_POSITIONS = "paper_positions";
export const PAPER_JOURNAL = "paper_journal";
export const PAPER_COLLECTIONS = [PAPER_STATE, PAPER_POSITIONS, PAPER_JOURNAL] as const;
export const PAPER_DB_NAME = "rsl-conf-paper";
const ACCOUNT_ID = "account";

function isAccount(doc: unknown): doc is PaperAccount {
  const a = doc as PaperAccount | null;
  return !!a && (a.schema === PAPER_SCHEMA || a.schema === (1 as unknown)) && Number.isFinite(a.balance) && Number.isFinite(a.startingEquity);
}

/**
 * v2.8 migration (schema 1 → 2): the drawdown fields are added with the peak at
 * the book's current marked equity, so opening an old book never engages the
 * lock. Schema-2 documents keep their stored values (invalid ones are repaired).
 */
export function migrateAccount(raw: PaperAccount, positions: PaperPosition[], base: PaperAccount): PaperAccount {
  const account: PaperAccount = {
    ...base,
    ...raw,
    schema: PAPER_SCHEMA,
    settings: normaliseSettings(raw.settings),
    heartbeats: { ...(raw.heartbeats ?? {}) },
    usedNonces: Array.isArray(raw.usedNonces) ? raw.usedNonces : [],
    decisions: { ...(raw.decisions ?? {}) },
    drawdownLocked: raw.drawdownLocked === true,
    lockClearedAt: Number.isFinite(raw.lockClearedAt) ? raw.lockClearedAt : null,
    resets: Array.isArray(raw.resets) ? raw.resets : [],
    // v2.8 (WP19): rejected proposals and their bracket outcomes (absent on older books).
    rejected: Array.isArray(raw.rejected) ? raw.rejected.filter((x) => x && typeof x.proposalId === "string") : [],
  };
  const marked = bookEquity({ account, positions, journal: [] });
  account.peakEquity = Number.isFinite(raw.peakEquity) && raw.peakEquity > 0 ? raw.peakEquity : marked;
  if (!raw.dayMark || !Number.isFinite(raw.dayMark.equity)) account.dayMark = { ...base.dayMark, equity: marked };
  if (!raw.weekMark || !Number.isFinite(raw.weekMark.equity)) account.weekMark = { ...base.weekMark, equity: marked };
  account.lastLockAt = Number.isFinite(raw.lastLockAt) ? raw.lastLockAt : null;
  return account;
}

export function createPaperStore(portOrPromise: PaperPort | Promise<PaperPort>) {
  const portP = Promise.resolve(portOrPromise);
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: (port: PaperPort) => Promise<T>): Promise<T> => {
    const job = queue.then(() => portP).then(fn);
    queue = job.catch(() => undefined);
    return job;
  };

  /** Load the whole book (a fresh one when nothing is stored yet). */
  function load(now = Date.now()): Promise<PaperBook> {
    return enqueue(async (port) => {
      const raw = await port.get(PAPER_STATE, ACCOUNT_ID);
      const base = newBook(now);
      const positions = (await port.list(PAPER_POSITIONS))
        .map(({ doc }) => doc as PaperPosition)
        .filter((p) => p && typeof p.id === "string" && p.size > 0)
        .sort((a, b) => a.approvedAt - b.approvedAt || a.id.localeCompare(b.id));
      const account: PaperAccount = isAccount(raw) ? migrateAccount(raw, positions, base.account) : base.account;
      const journal = (await port.list(PAPER_JOURNAL))
        .map(({ doc }) => doc as JournalEntry)
        .filter((j) => j && typeof j.id === "string" && Number.isFinite(j.pnl))
        .sort((a, b) => a.closedAt - b.closedAt || a.id.localeCompare(b.id));
      return { account, positions, journal };
    });
  }

  /**
   * Persist a book: the account document, every current position (removing
   * positions that no longer exist) and journal entries not yet stored.
   * Journal entries are never rewritten.
   */
  function save(book: PaperBook): Promise<void> {
    const snapshot: PaperBook = structuredCloneSafe(book);
    return enqueue(async (port) => {
      await port.put(PAPER_STATE, ACCOUNT_ID, snapshot.account);
      const keep = new Set(snapshot.positions.map((p) => p.id));
      for (const { id } of await port.list(PAPER_POSITIONS)) if (!keep.has(id)) await port.del(PAPER_POSITIONS, id);
      for (const p of snapshot.positions) await port.put(PAPER_POSITIONS, p.id, p);
      const stored = new Set((await port.list(PAPER_JOURNAL)).map(({ id }) => id));
      for (const j of snapshot.journal) if (!stored.has(j.id)) await port.put(PAPER_JOURNAL, j.id, j);
    });
  }

  /** Delete everything (positions, journal, account). */
  function clear(): Promise<void> {
    return enqueue(async (port) => {
      for (const col of PAPER_COLLECTIONS) for (const { id } of await port.list(col)) await port.del(col, id);
    });
  }

  return { load, save, clear };
}

export type PaperStore = ReturnType<typeof createPaperStore>;

function structuredCloneSafe<T>(v: T): T {
  return typeof structuredClone === "function" ? structuredClone(v) : (JSON.parse(JSON.stringify(v)) as T);
}

/** In-memory port (tests, and the fallback when no durable store is available). */
export function memoryPaperPort(): PaperPort {
  const data = new Map<string, Map<string, unknown>>();
  const col = (c: string) => { let m = data.get(c); if (!m) { m = new Map(); data.set(c, m); } return m; };
  return {
    kind: "memory",
    async get(c, id) { const v = col(c).get(id); return v === undefined ? null : JSON.parse(JSON.stringify(v)); },
    async put(c, id, doc) { col(c).set(id, JSON.parse(JSON.stringify(doc))); },
    async del(c, id) { col(c).delete(id); },
    async list(c) { return [...col(c).entries()].map(([id, doc]) => ({ id, doc: JSON.parse(JSON.stringify(doc)) })); },
  };
}

/* ------------------------------------------------------------------ *
 *  Journal CSV (the component renders it with the kit's toCSV)
 * ------------------------------------------------------------------ */
export const PAPER_JOURNAL_COLUMNS = [
  "id", "opened_utc", "closed_utc", "source", "timeframe", "pair", "side", "size", "entry", "exit", "stop", "target",
  "fees", "funding", "pnl", "r_multiple", "reason", "config_id", "proposal_id", "approved_utc", "approved_by", "simulated",
  "mae", "mfe", "pre_trade_reason", "setup_tag", "notes",
] as const;

/** Same rule as the kit's safeCell (cells starting with = + - @ or a control character get a leading apostrophe); lib code cannot import the kit. */
const safeText = (v: unknown): string => {
  const s = typeof v === "string" ? v : "";
  return /^[=+\-@\u0000-\u001F]/.test(s) ? `'${s}` : s;
};
const optR = (v: unknown): number | string => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : "");

const iso = (ms: number) => (ms ? new Date(ms).toISOString() : "");

/** Id of a trade's saved annotation (tags + notes) in the "preferences" collection (components/trade-annotation.tsx). */
export const paperNoteId = (j: Pick<JournalEntry, "proposalId" | "openedAt" | "closedAt">): string =>
  "paper-note:" + [j.proposalId, j.openedAt, j.closedAt].join(":");

/** The Notes CSV cell from a saved annotation: "notes [tag, tag]"; anything malformed or missing is "". */
export function annotationNote(saved: unknown): string {
  const a = saved && typeof saved === "object" ? (saved as { tags?: unknown; notes?: unknown }) : {};
  const notes = typeof a.notes === "string" ? a.notes.trim() : "";
  const tags = Array.isArray(a.tags) ? a.tags.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : [];
  return [notes, tags.length ? `[${tags.join(", ")}]` : ""].filter(Boolean).join(" ");
}

/** One journal CSV row; `note` is the trade's annotation (annotationNote) and fills the Notes column. */
export function journalRowValues(j: JournalEntry, note?: string): (string | number)[] {
  return [
    j.id, iso(j.openedAt), iso(j.closedAt), j.src, j.tf, j.pair, j.side, j.size, j.entry, j.exit, j.stop, j.target,
    round(j.fees), round(j.funding), round(j.pnl), Math.round(j.r * 1000) / 1000, j.reason, j.configId, j.proposalId,
    iso(j.approvedAt), j.approvedBy, "paper",
    optR(j.mae), optR(j.mfe), safeText(j.preReason), safeText(j.tag), safeText(note ?? j.notes),
  ];
}
const round = (v: number) => Math.round(v * 1e6) / 1e6;
