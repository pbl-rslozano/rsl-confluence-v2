/**
 * backup-payload.ts — v2.8 (WP28 Task 2): what an encrypted backup holds, and how it is read back.
 * Included: signal ledger rows with their measured outcome snapshots, the universe snapshots and the recorded gaps
 * (final review I-1), pre-registrations and registered trials, the paper JOURNAL with its trade notes (annotations), app
 * preferences, the scoring profile.
 * Excluded: the paper account, open positions and risk settings (a restore must never loosen a drawdown lock), market history,
 * tokens, keys and the passphrase. Plain JSON.parse only; nothing is evaluated. A failing item is counted, never dropped silently.
 * Final review M-1: the per-item loops yield to the event loop (cooperative), so a large payload never holds the page for long.
 */
import { BackupError, cooperative, type EnvelopeHeader } from "./backup-crypto";
import { sanitizeLedgerRow, type LedgerRow } from "./ledger-metrics";
import { normalizePreferences, type AppPreferences } from "./preferences-store";
import { normalizeScoringProfile, type ScoringProfile } from "./scoring-profile";
import {
  sanitizeGapDoc, sanitizeOutcomeDoc, sanitizePreregistration, sanitizeTrial, sanitizeUniverseDoc,
  type GapDoc, type OutcomeDoc, type PreRegistration, type TrialEntry, type UniverseDoc,
} from "./signal-ledger";
import { sanitizeJournalEntry, sanitizeTradeNote, type TradeNote } from "./paper-store";
import type { JournalEntry } from "./paper-broker";

export const PAYLOAD_FORMAT = "rsl-confluence-backup-payload";
export const PAYLOAD_SCHEMA = 1;
export const PAYLOAD_LIMITS = {
  rows: 1_000_000, preregistrations: 500, trials: 20_000, journal: 100_000,
  outcomes: 1_000_000, universes: 100_000, gaps: 100_000, notes: 100_000,
};

export interface BackupPayload {
  format: typeof PAYLOAD_FORMAT;
  schema: 1;
  createdAt: number;
  app: string;
  settings: { preferences: AppPreferences | null; scoringProfile: ScoringProfile | null };
  ledger: { rows: LedgerRow[]; outcomes: OutcomeDoc[]; universes: UniverseDoc[]; gaps: GapDoc[] };
  research: { preregistrations: PreRegistration[]; trials: TrialEntry[] };
  paper: { journal: JournalEntry[]; notes: TradeNote[] };
}

type Parts = Omit<BackupPayload, "format" | "schema">;

export function buildPayload(parts: Parts): string {
  return JSON.stringify({ format: PAYLOAD_FORMAT, schema: PAYLOAD_SCHEMA, ...parts });
}

/**
 * The same text as buildPayload for parts in the canonical order (createdAt, app, settings, ledger, research, paper), built
 * one record at a time with yields to the event loop (final review M-1), so a large ledger never blocks the page for long.
 */
export async function buildPayloadText(parts: Parts): Promise<string> {
  const tick = cooperative();
  const out: string[] = [];
  const arr = async (items: readonly unknown[]) => {
    out.push("[");
    for (let i = 0; i < items.length; i++) {
      if (i) out.push(",");
      out.push(JSON.stringify(items[i]));
      const t = tick();
      if (t) await t;
    }
    out.push("]");
  };
  const j = JSON.stringify;
  out.push(`{"format":${j(PAYLOAD_FORMAT)},"schema":${PAYLOAD_SCHEMA},"createdAt":${j(parts.createdAt)},"app":${j(parts.app)},"settings":${j(parts.settings)}`);
  out.push(',"ledger":{"rows":'); await arr(parts.ledger.rows);
  out.push(',"outcomes":'); await arr(parts.ledger.outcomes);
  out.push(',"universes":'); await arr(parts.ledger.universes);
  out.push(',"gaps":'); await arr(parts.ledger.gaps);
  out.push('},"research":{"preregistrations":'); await arr(parts.research.preregistrations);
  out.push(',"trials":'); await arr(parts.research.trials);
  out.push('},"paper":{"journal":'); await arr(parts.paper.journal);
  out.push(',"notes":'); await arr(parts.paper.notes);
  out.push("}}");
  return out.join("");
}

export interface PayloadRejected {
  rows: number; preregistrations: number; trials: number; journal: number;
  outcomes: number; universes: number; gaps: number; notes: number;
}

export interface ParsedPayload {
  payload: BackupPayload;
  rejected: PayloadRejected;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const schema = (what: string) => new BackupError("schema", { what });

async function list<T>(source: unknown, max: number, name: string, ok: (x: unknown) => T | null, tick: () => Promise<void> | undefined): Promise<{ items: T[]; rejected: number }> {
  if (!Array.isArray(source)) throw schema(name);
  if (source.length > max) throw schema(`${name}-limit`);
  const items: T[] = [];
  let rejected = 0;
  for (const x of source) {
    const v = ok(x);
    if (v === null) rejected++; else items.push(v);
    const t = tick();
    if (t) await t;
  }
  return { items, rejected };
}

export async function parsePayload(text: string, header: EnvelopeHeader, limits = PAYLOAD_LIMITS): Promise<ParsedPayload> {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new BackupError("format"); }
  if (!isObj(raw)) throw new BackupError("format");
  if (raw.format !== PAYLOAD_FORMAT || raw.schema !== PAYLOAD_SCHEMA) throw schema("version");
  if (raw.createdAt !== header.createdAt) throw schema("createdAt");
  if (typeof raw.app !== "string") throw schema("app");
  const { settings, ledger, research, paper } = raw;
  if (!isObj(settings) || !isObj(ledger) || !isObj(research) || !isObj(paper)) throw schema("section");

  let preferences: AppPreferences | null = null;
  if (settings.preferences !== null && settings.preferences !== undefined) {
    if (!isObj(settings.preferences)) throw schema("preferences");
    preferences = normalizePreferences(settings.preferences);
  }
  let scoringProfile: ScoringProfile | null;
  try { scoringProfile = normalizeScoringProfile(settings.scoringProfile); } catch { throw schema("scoringProfile"); }

  const tick = cooperative();
  const rows = await list(ledger.rows, limits.rows, "rows", (x) => {
    const r = sanitizeLedgerRow(x);
    return r && r.live === 1 ? r : null;
  }, tick);
  const outcomes = await list(ledger.outcomes, limits.outcomes, "outcomes", sanitizeOutcomeDoc, tick);
  const universes = await list(ledger.universes, limits.universes, "universes", sanitizeUniverseDoc, tick);
  const gaps = await list(ledger.gaps, limits.gaps, "gaps", sanitizeGapDoc, tick);
  const pre = await list(research.preregistrations, limits.preregistrations, "preregistrations", sanitizePreregistration, tick);
  const trials = await list(research.trials, limits.trials, "trials", sanitizeTrial, tick);
  const journal = await list(paper.journal, limits.journal, "journal", sanitizeJournalEntry, tick);
  const notes = await list(paper.notes, limits.notes, "notes", sanitizeTradeNote, tick);

  return {
    payload: {
      format: PAYLOAD_FORMAT, schema: 1, createdAt: raw.createdAt, app: raw.app,
      settings: { preferences, scoringProfile },
      ledger: { rows: rows.items, outcomes: outcomes.items, universes: universes.items, gaps: gaps.items },
      research: { preregistrations: pre.items, trials: trials.items },
      paper: { journal: journal.items, notes: notes.items },
    },
    rejected: {
      rows: rows.rejected, preregistrations: pre.rejected, trials: trials.rejected, journal: journal.rejected,
      outcomes: outcomes.rejected, universes: universes.rejected, gaps: gaps.rejected, notes: notes.rejected,
    },
  };
}
