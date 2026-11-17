/**
 * backup-service.ts — v2.8 (WP28 Task 2): create a backup file, build a dry-run restore plan, apply it.
 * openBackupFile never writes. applyRestore merges by id, never overwrites a record, never touches the paper account,
 * open positions or risk settings, and writes one audit entry that holds counts only (no passphrase, no secrets).
 */
import { backupFileName, openBackup, sealBackup, utf8Bytes, type EnvelopeHeader } from "./backup-crypto";
import { buildPayload, parsePayload, type ParsedPayload } from "./backup-payload";
import { sanitizeLedgerRow } from "./ledger-metrics";
import { normalizePreferences } from "./preferences-store";
import { normalizeScoringProfile, type ScoringProfile } from "./scoring-profile";
import { sanitizePreregistration, sanitizeTrial, type LedgerStore } from "./signal-ledger";
import { sanitizeJournalEntry, type PaperStore } from "./paper-store";

export interface BackupDeps {
  ledger: Pick<LedgerStore, "all" | "preregistrations" | "trials" | "restoreRows" | "restorePreregistrations" | "restoreTrials" | "newestBarTime">;
  paper: Pick<PaperStore, "load" | "importJournal">;
  prefs: { get(col: string, id: string): Promise<unknown>; put(col: string, id: string, doc: unknown): Promise<void> };
  audit: {
    append(e: { actorId: string; event: string; record?: string; reason: string }): Promise<unknown>;
    entries(o?: { record?: string }): Promise<{ at: string; event: string }[]>;
  };
  actorId: string;
  app: string;
  now: () => number;
}

/** capDropped = ledger rows removed by the row cap (exact, same number in the plan and the report); agePrunedDays = days dropped for age. */
export interface RowCounts { inFile: number; added: number; duplicates: number; tooOld: number; rejected: number; capDropped: number; agePrunedDays: number }

const canon = (v: unknown): string => JSON.stringify(v, (_k, x) =>
  x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x);

function keep<T>(items: T[], ok: (x: unknown) => T | null): { out: T[]; skipped: number } {
  const out: T[] = [];
  let skipped = 0;
  for (const x of items) { const v = ok(x); if (v === null) skipped++; else out.push(v); }
  return { out, skipped };
}

export async function createBackupFile(deps: BackupDeps, passphrase: string): Promise<{
  name: string; text: string; bytes: number; createdAt: number;
  counts: { rows: number; journal: number; preregistrations: number; trials: number };
  /** Local records the restore sanitiser would refuse (for example replay rows), left out of the file, per section. */
  skipped: { rows: number; preregistrations: number; trials: number; journal: number };
}> {
  const createdAt = Math.floor(deps.now());
  const rows = keep(await deps.ledger.all(), (x) => { const r = sanitizeLedgerRow(x); return r && r.live === 1 ? r : null; });
  const pre = keep(await deps.ledger.preregistrations(), sanitizePreregistration);
  const trials = keep(await deps.ledger.trials(), sanitizeTrial);
  const journal = keep((await deps.paper.load(createdAt)).journal, sanitizeJournalEntry);
  const preferences = normalizePreferences(await deps.prefs.get("preferences", "current"));
  let scoringProfile: ScoringProfile | null = null;
  try { scoringProfile = normalizeScoringProfile(await deps.prefs.get("preferences", "scoring-profile-v1")); } catch { scoringProfile = null; }

  const plain = buildPayload({
    createdAt, app: deps.app,
    settings: { preferences, scoringProfile },
    ledger: { rows: rows.out },
    research: { preregistrations: pre.out, trials: trials.out },
    paper: { journal: journal.out },
  });
  const text = await sealBackup(plain, passphrase, { createdAt, app: deps.app });
  return {
    name: backupFileName(createdAt), text, bytes: utf8Bytes(text), createdAt,
    counts: { rows: rows.out.length, journal: journal.out.length, preregistrations: pre.out.length, trials: trials.out.length },
    skipped: { rows: rows.skipped, preregistrations: pre.skipped, trials: trials.skipped, journal: journal.skipped },
  };
}

export interface RestorePlan {
  header: EnvelopeHeader;
  parsed: ParsedPayload;
  ledger: RowCounts;
  journal: { inFile: number; added: number; duplicates: number; rejected: number };
  preregistrations: { added: number; kept: number; rejected: number };
  trials: { added: number; rejected: number };
  settings: {
    present: boolean;
    localChangedAt: number | null;
    localNewer: boolean;
    /** The backup's preferences / scoring profile differ from this device's (profile changes write no audit entry). */
    preferencesDiffer: boolean;
    profileDiffers: boolean;
    differs: boolean;
  };
  localNewerRecords: boolean;
}

/** Decrypt, validate and dry-run. Writes nothing. */
export async function openBackupFile(text: string, passphrase: string, deps: BackupDeps): Promise<RestorePlan> {
  const { header, plain } = await openBackup(text, passphrase, deps.now());
  const parsed = parsePayload(plain, header);
  const { payload, rejected } = parsed;

  const rows = await deps.ledger.restoreRows(payload.ledger.rows, { dryRun: true });
  const journal = await deps.paper.importJournal(payload.paper.journal, { dryRun: true });
  const pre = await deps.ledger.restorePreregistrations(payload.research.preregistrations, { dryRun: true });
  const trialsAdded = await deps.ledger.restoreTrials(payload.research.trials, { dryRun: true });

  let localChangedAt: number | null = null;
  for (const e of await deps.audit.entries({ record: "preferences" })) {
    if (e.event !== "preferences.update") continue;
    const at = Date.parse(e.at);
    if (Number.isFinite(at) && (localChangedAt === null || at > localChangedAt)) localChangedAt = at;
  }
  const present = payload.settings.preferences !== null || payload.settings.scoringProfile !== null;
  const localPrefs = normalizePreferences(await deps.prefs.get("preferences", "current"));
  let localProfile: ScoringProfile | null | "unreadable";
  try { localProfile = normalizeScoringProfile(await deps.prefs.get("preferences", "scoring-profile-v1")); } catch { localProfile = "unreadable"; }
  // Applying writes the preferences only when the backup holds them, and the profile (null = all indicators) always.
  const preferencesDiffer = present && payload.settings.preferences !== null && canon(localPrefs) !== canon(payload.settings.preferences);
  const profileDiffers = present && canon(localProfile) !== canon(payload.settings.scoringProfile);
  const newestJournal = (await deps.paper.load(deps.now())).journal.reduce((m, j) => Math.max(m, j.closedAt), 0);
  const newestBar = await deps.ledger.newestBarTime();

  return {
    header, parsed,
    ledger: { inFile: payload.ledger.rows.length + rejected.rows, ...rows, rejected: rejected.rows },
    journal: { inFile: payload.paper.journal.length + rejected.journal, added: journal.added, duplicates: journal.duplicates, rejected: rejected.journal },
    preregistrations: { added: pre.added, kept: pre.kept, rejected: rejected.preregistrations },
    trials: { added: trialsAdded, rejected: rejected.trials },
    settings: {
      present,
      localChangedAt,
      localNewer: localChangedAt !== null && localChangedAt > header.createdAt,
      preferencesDiffer,
      profileDiffers,
      differs: preferencesDiffer || profileDiffers,
    },
    localNewerRecords: newestBar > header.createdAt || newestJournal > header.createdAt,
  };
}

export interface RestoreReport {
  ledger: RowCounts;
  journal: { added: number; duplicates: number };
  preregistrations: { added: number; kept: number };
  trials: number;
  settings: boolean;
}

/** Merge the plan's records into this device. Order: pre-registrations, trials, ledger rows, journal, settings. */
export async function applyRestore(plan: RestorePlan, o: { settings: boolean }, deps: BackupDeps): Promise<RestoreReport> {
  const { payload } = plan.parsed;
  const pre = await deps.ledger.restorePreregistrations(payload.research.preregistrations);
  const trials = await deps.ledger.restoreTrials(payload.research.trials);
  const rows = await deps.ledger.restoreRows(payload.ledger.rows);
  const journal = await deps.paper.importJournal(payload.paper.journal);
  const settings = o.settings && plan.settings.present;
  if (settings) {
    if (payload.settings.preferences) await deps.prefs.put("preferences", "current", payload.settings.preferences);
    await deps.prefs.put("preferences", "scoring-profile-v1", payload.settings.scoringProfile);
  }
  const ledger: RowCounts = { inFile: plan.ledger.inFile, ...rows, rejected: plan.ledger.rejected };
  await deps.audit.append({
    actorId: deps.actorId, event: "backup.cloud.restore", record: "backup",
    reason: `${new Date(plan.header.createdAt).toISOString()} · ${rows.added} rows added, ${rows.duplicates} already present, ${rows.tooOld} too old, ${ledger.rejected} unreadable, ${rows.capDropped} removed by the row cap · ${journal.added} trades · ${pre.added} pre-registrations · settings ${settings ? "yes" : "no"}`,
  });
  return { ledger, journal, preregistrations: pre, trials, settings };
}
