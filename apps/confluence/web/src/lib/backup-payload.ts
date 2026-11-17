/**
 * backup-payload.ts — v2.8 (WP28 Task 2): what an encrypted backup holds, and how it is read back.
 * Included: signal ledger rows, pre-registrations and registered trials, the paper JOURNAL, app preferences, the scoring profile.
 * Excluded: the paper account, open positions and risk settings (a restore must never loosen a drawdown lock), market history,
 * tokens, keys and the passphrase. Plain JSON.parse only; nothing is evaluated. A failing item is counted, never dropped silently.
 */
import { BackupError, type EnvelopeHeader } from "./backup-crypto";
import { sanitizeLedgerRow, type LedgerRow } from "./ledger-metrics";
import { normalizePreferences, type AppPreferences } from "./preferences-store";
import { normalizeScoringProfile, type ScoringProfile } from "./scoring-profile";
import { sanitizePreregistration, sanitizeTrial, type PreRegistration, type TrialEntry } from "./signal-ledger";
import { sanitizeJournalEntry } from "./paper-store";
import type { JournalEntry } from "./paper-broker";

export const PAYLOAD_FORMAT = "rsl-confluence-backup-payload";
export const PAYLOAD_SCHEMA = 1;
export const PAYLOAD_LIMITS = { rows: 1_000_000, preregistrations: 500, trials: 20_000, journal: 100_000 };

export interface BackupPayload {
  format: typeof PAYLOAD_FORMAT;
  schema: 1;
  createdAt: number;
  app: string;
  settings: { preferences: AppPreferences | null; scoringProfile: ScoringProfile | null };
  ledger: { rows: LedgerRow[] };
  research: { preregistrations: PreRegistration[]; trials: TrialEntry[] };
  paper: { journal: JournalEntry[] };
}

export function buildPayload(parts: Omit<BackupPayload, "format" | "schema">): string {
  return JSON.stringify({ format: PAYLOAD_FORMAT, schema: PAYLOAD_SCHEMA, ...parts });
}

export interface ParsedPayload {
  payload: BackupPayload;
  rejected: { rows: number; preregistrations: number; trials: number; journal: number };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const schema = (what: string) => new BackupError("schema", { what });

function list<T>(source: unknown, max: number, name: string, ok: (x: unknown) => T | null): { items: T[]; rejected: number } {
  if (!Array.isArray(source)) throw schema(name);
  if (source.length > max) throw schema(`${name}-limit`);
  const items: T[] = [];
  let rejected = 0;
  for (const x of source) {
    const v = ok(x);
    if (v === null) rejected++; else items.push(v);
  }
  return { items, rejected };
}

export function parsePayload(text: string, header: EnvelopeHeader, limits = PAYLOAD_LIMITS): ParsedPayload {
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

  const rows = list(ledger.rows, limits.rows, "rows", (x) => {
    const r = sanitizeLedgerRow(x);
    return r && r.live === 1 ? r : null;
  });
  const pre = list(research.preregistrations, limits.preregistrations, "preregistrations", sanitizePreregistration);
  const trials = list(research.trials, limits.trials, "trials", sanitizeTrial);
  const journal = list(paper.journal, limits.journal, "journal", sanitizeJournalEntry);

  return {
    payload: {
      format: PAYLOAD_FORMAT, schema: 1, createdAt: raw.createdAt, app: raw.app,
      settings: { preferences, scoringProfile },
      ledger: { rows: rows.items },
      research: { preregistrations: pre.items, trials: trials.items },
      paper: { journal: journal.items },
    },
    rejected: { rows: rows.rejected, preregistrations: pre.rejected, trials: trials.rejected, journal: journal.rejected },
  };
}
