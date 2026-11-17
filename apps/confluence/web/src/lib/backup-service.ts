/**
 * backup-service.ts — v2.8 (WP28 Task 2): create a backup file, build a dry-run restore plan, apply it.
 * openBackupFile never writes. applyRestore merges by id, never overwrites a record, never touches the paper account,
 * open positions or risk settings, and writes one audit entry that holds counts only (no passphrase, no secrets).
 */
import { BackupError, backupFileName, cooperative, openBackup, sealBackup, utf8Bytes, type EnvelopeHeader } from "./backup-crypto";
import { buildPayloadText, parsePayload, type ParsedPayload } from "./backup-payload";
import { sanitizeLedgerRow } from "./ledger-metrics";
import { normalizePreferences } from "./preferences-store";
import { normalizeScoringProfile, type ScoringProfile } from "./scoring-profile";
import {
  sanitizeGapDoc, sanitizeOutcomeDoc, sanitizePreregistration, sanitizeTrial, sanitizeUniverseDoc,
  type LedgerStore, type RestoreExtraCounts,
} from "./signal-ledger";
import { paperNoteId, sanitizeJournalEntry, sanitizeTradeNote, type PaperStore, type TradeNote } from "./paper-store";

export interface BackupDeps {
  ledger: Pick<LedgerStore, "all" | "preregistrations" | "trials" | "restoreRows" | "restoreLedger" | "restoreGaps" | "backupMeta" | "restorePreregistrations" | "restoreTrials" | "newestBarTime">;
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

async function keep<T>(items: readonly unknown[], ok: (x: unknown) => T | null, tick = cooperative()): Promise<{ out: T[]; skipped: number }> {
  const out: T[] = [];
  let skipped = 0;
  for (const x of items) {
    const v = ok(x);
    if (v === null) skipped++; else out.push(v);
    const t = tick();
    if (t) await t;
  }
  return { out, skipped };
}

/** Numbers of the records a backup carries besides rows, journal, pre-registrations and trials (final review I-1). */
export interface ExtraTotals { outcomes: number; universes: number; gaps: number; notes: number }

export async function createBackupFile(deps: BackupDeps, passphrase: string): Promise<{
  name: string; text: string; bytes: number; createdAt: number;
  counts: { rows: number; journal: number; preregistrations: number; trials: number } & ExtraTotals;
  /**
   * Local records the restore sanitiser would refuse, left out of the file, per section. Replay ledger rows (`live: 0`) are
   * left out on purpose (only live rows are backed up) and counted apart in `replayRows`; `rows` holds unreadable rows only.
   * Outcome snapshots of replay rows are left out with their rows and are not counted.
   */
  skipped: { rows: number; replayRows: number; preregistrations: number; trials: number; journal: number } & ExtraTotals;
}> {
  const createdAt = Math.floor(deps.now());
  const tick = cooperative();
  let replayRows = 0;
  const rows = await keep(await deps.ledger.all(), (x) => {
    const r = sanitizeLedgerRow(x);
    if (r && r.live !== 1) { replayRows++; return null; }
    return r;
  }, tick);
  rows.skipped -= replayRows;
  const meta = await deps.ledger.backupMeta(new Set(rows.out.map((r) => r.id)));
  const outcomes = await keep(meta.outcomes, sanitizeOutcomeDoc, tick);
  const universes = await keep(meta.universes, sanitizeUniverseDoc, tick);
  const gaps = await keep(meta.gaps, sanitizeGapDoc, tick);
  const pre = await keep(await deps.ledger.preregistrations(), sanitizePreregistration, tick);
  const trials = await keep(await deps.ledger.trials(), sanitizeTrial, tick);
  const journal = await keep((await deps.paper.load(createdAt)).journal, sanitizeJournalEntry, tick);
  // Trade notes (annotations) live in "preferences" under paperNoteId of the trade; only trades in the journal have one.
  const notes: TradeNote[] = [];
  let notesSkipped = 0;
  const noteKeys = new Set<string>();
  for (const j of journal.out) {
    const key = paperNoteId(j);
    if (noteKeys.has(key)) continue;
    noteKeys.add(key);
    const saved = await deps.prefs.get("preferences", key);
    if (saved === null || saved === undefined) continue;
    const note = sanitizeTradeNote(typeof saved === "object" && !Array.isArray(saved)
      ? { ...(saved as Record<string, unknown>), proposalId: j.proposalId, openedAt: j.openedAt, closedAt: j.closedAt }
      : null);
    if (note) notes.push(note); else notesSkipped++;
  }
  const preferences = normalizePreferences(await deps.prefs.get("preferences", "current"));
  let scoringProfile: ScoringProfile | null = null;
  try { scoringProfile = normalizeScoringProfile(await deps.prefs.get("preferences", "scoring-profile-v1")); } catch { scoringProfile = null; }

  const plain = await buildPayloadText({
    createdAt, app: deps.app,
    settings: { preferences, scoringProfile },
    ledger: { rows: rows.out, outcomes: outcomes.out, universes: universes.out, gaps: gaps.out },
    research: { preregistrations: pre.out, trials: trials.out },
    paper: { journal: journal.out, notes },
  });
  const text = await sealBackup(plain, passphrase, { createdAt, app: deps.app });
  return {
    name: backupFileName(createdAt), text, bytes: utf8Bytes(text), createdAt,
    counts: {
      rows: rows.out.length, journal: journal.out.length, preregistrations: pre.out.length, trials: trials.out.length,
      outcomes: outcomes.out.reduce((n, o) => n + Object.keys(o.out).length, 0), universes: universes.out.length,
      gaps: gaps.out.reduce((n, g) => n + g.spans.length, 0), notes: notes.length,
    },
    skipped: {
      rows: rows.skipped, replayRows, preregistrations: pre.skipped, trials: trials.skipped, journal: journal.skipped,
      outcomes: outcomes.skipped, universes: universes.skipped, gaps: gaps.skipped, notes: notesSkipped,
    },
  };
}

/** inFile = records in the file (outcome rows, universes, gap spans or notes) plus unreadable entries; the rest partitions the readable ones. */
export interface ExtraPlan extends RestoreExtraCounts { inFile: number; rejected: number }

export interface RestorePlan {
  header: EnvelopeHeader;
  parsed: ParsedPayload;
  ledger: RowCounts;
  /** Final review I-1: a row's measured outcomes (all its horizons count once), universe snapshots, gap spans, trade notes. */
  outcomes: ExtraPlan;
  universes: ExtraPlan;
  gaps: ExtraPlan;
  notes: { inFile: number; added: number; present: number; rejected: number };
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

/** Merge trade notes by key (paperNoteId): a note that exists on this device is kept as it is. */
async function restoreNotes(notes: TradeNote[], deps: BackupDeps, dryRun: boolean): Promise<{ added: number; present: number }> {
  let added = 0;
  let present = 0;
  const done = new Set<string>();
  for (const n of notes) {
    const key = paperNoteId(n);
    const local = done.has(key) ? true : await deps.prefs.get("preferences", key);
    if (local !== null && local !== undefined) { present++; continue; }
    done.add(key);
    if (!dryRun) await deps.prefs.put("preferences", key, { tags: n.tags, notes: n.notes });
    added++;
  }
  return { added, present };
}

const outcomeRows = (list: { out: Record<string, unknown> }[]) => list.reduce((n, o) => n + Object.keys(o.out).length, 0);
const gapSpans = (list: { spans: unknown[] }[]) => list.reduce((n, g) => n + g.spans.length, 0);

/** Decrypt, validate and dry-run. Writes nothing. */
export async function openBackupFile(text: string, passphrase: string, deps: BackupDeps): Promise<RestorePlan> {
  const { header, plain } = await openBackup(text, passphrase, deps.now());
  const parsed = await parsePayload(plain, header);
  const { payload, rejected } = parsed;

  const led = await deps.ledger.restoreLedger(
    { rows: payload.ledger.rows, outcomes: payload.ledger.outcomes, universes: payload.ledger.universes }, { dryRun: true });
  const gaps = await deps.ledger.restoreGaps(payload.ledger.gaps, { dryRun: true });
  const journal = await deps.paper.importJournal(payload.paper.journal, { dryRun: true });
  const notes = await restoreNotes(payload.paper.notes, deps, true);
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
    ledger: { inFile: payload.ledger.rows.length + rejected.rows, ...led.rows, rejected: rejected.rows },
    outcomes: { inFile: outcomeRows(payload.ledger.outcomes) + rejected.outcomes, ...led.outcomes, rejected: rejected.outcomes },
    universes: { inFile: payload.ledger.universes.length + rejected.universes, ...led.universes, rejected: rejected.universes },
    gaps: { inFile: gapSpans(payload.ledger.gaps) + rejected.gaps, ...gaps, rejected: rejected.gaps },
    notes: { inFile: payload.paper.notes.length + rejected.notes, ...notes, rejected: rejected.notes },
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
  outcomes: RestoreExtraCounts;
  universes: RestoreExtraCounts;
  gaps: RestoreExtraCounts;
  notes: { added: number; present: number };
  journal: { added: number; duplicates: number };
  preregistrations: { added: number; kept: number };
  trials: number;
  settings: boolean;
}

type Step = "preregistrations" | "trials" | "rows" | "gaps" | "journal" | "notes" | "settings" | "audit";
type Done = Record<"preregistrations" | "trials" | "rows" | "outcomes" | "universes" | "gaps" | "journal" | "notes" | "settings", number>;

/**
 * Merge the plan's records into this device. Order: pre-registrations, trials, ledger rows (then their outcome snapshots
 * and the universes), recorded gaps, journal, trade notes, settings.
 *
 * A failure part-way (a store error, a full disk) is never reported as "nothing changed": the records already merged are
 * counted (the step that threw is re-counted with a dry run, which writes nothing), a `backup.cloud.restore.partial`
 * audit entry records them, and a BackupError("partial") carries the counts with the original error as its `cause`.
 * If that audit entry cannot be written either, the partial error is still thrown (detail.audit = "failed"). Running the
 * same restore again is safe: every record merges by id or key.
 */
export async function applyRestore(plan: RestorePlan, o: { settings: boolean }, deps: BackupDeps): Promise<RestoreReport> {
  const { payload } = plan.parsed;
  const done: Done = { preregistrations: 0, trials: 0, rows: 0, outcomes: 0, universes: 0, gaps: 0, journal: 0, notes: 0, settings: 0 };
  let step: Step = "preregistrations";
  try {
    const pre = await deps.ledger.restorePreregistrations(payload.research.preregistrations);
    done.preregistrations = pre.added;
    step = "trials";
    const trials = await deps.ledger.restoreTrials(payload.research.trials);
    done.trials = trials;
    step = "rows";
    const led = await deps.ledger.restoreLedger({ rows: payload.ledger.rows, outcomes: payload.ledger.outcomes, universes: payload.ledger.universes });
    done.rows = led.rows.added;
    done.outcomes = led.outcomes.added;
    done.universes = led.universes.added;
    step = "gaps";
    const gaps = await deps.ledger.restoreGaps(payload.ledger.gaps);
    done.gaps = gaps.added;
    step = "journal";
    const journal = await deps.paper.importJournal(payload.paper.journal);
    done.journal = journal.added;
    step = "notes";
    const notes = await restoreNotes(payload.paper.notes, deps, false);
    done.notes = notes.added;
    step = "settings";
    const settings = o.settings && plan.settings.present;
    if (settings) {
      if (payload.settings.preferences) { await deps.prefs.put("preferences", "current", payload.settings.preferences); done.settings++; }
      await deps.prefs.put("preferences", "scoring-profile-v1", payload.settings.scoringProfile);
      done.settings++;
    }
    step = "audit";
    const rows = led.rows;
    const ledger: RowCounts = { inFile: plan.ledger.inFile, ...rows, rejected: plan.ledger.rejected };
    await deps.audit.append({
      actorId: deps.actorId, event: "backup.cloud.restore", record: "backup",
      reason: `${new Date(plan.header.createdAt).toISOString()} · ${rows.added} rows added, ${rows.duplicates} already present, ${rows.tooOld} too old, ${ledger.rejected} unreadable, ${rows.capDropped} removed by the row cap · ${journal.added} trades · ${pre.added} pre-registrations · settings ${settings ? "yes" : "no"} · ${led.outcomes.added} outcome records · ${led.universes.added} universes · ${gaps.added} gaps · ${notes.added} trade notes`,
    });
    return { ledger, outcomes: led.outcomes, universes: led.universes, gaps, notes, journal, preregistrations: pre, trials, settings };
  } catch (cause) {
    if (step !== "settings" && step !== "audit") await countWrittenBeforeFailure(step, plan, deps, done);
    const n = Object.values(done).reduce((a, x) => a + x, 0);
    let audit: "written" | "failed" = "written";
    try {
      await deps.audit.append({
        actorId: deps.actorId, event: "backup.cloud.restore.partial", record: "backup",
        reason: `${new Date(plan.header.createdAt).toISOString()} · stopped in the ${step} step · ${done.rows} rows, ${done.journal} trades, ${done.preregistrations} pre-registrations, ${done.trials} trials, ${done.settings} settings written · ${done.outcomes} outcome records, ${done.universes} universes, ${done.gaps} gaps, ${done.notes} trade notes written`,
      });
    } catch {
      audit = "failed"; // the original failure is what the caller must see
    }
    const err = new BackupError("partial", { n, ...done, step, audit });
    (err as Error & { cause?: unknown }).cause = cause;
    throw err;
  }
}

/**
 * How many of a step's planned records reached the store before it threw: the plan's dry-run count minus what a new dry
 * run would still add. A store that cannot be read gives 0 (the count is then a lower bound).
 */
async function countWrittenBeforeFailure(step: "preregistrations" | "trials" | "rows" | "gaps" | "journal" | "notes", plan: RestorePlan, deps: BackupDeps, done: Done): Promise<void> {
  const { payload } = plan.parsed;
  const less = (planned: number, left: number) => Math.max(0, planned - left);
  try {
    if (step === "preregistrations") done.preregistrations += less(plan.preregistrations.added, (await deps.ledger.restorePreregistrations(payload.research.preregistrations, { dryRun: true })).added);
    else if (step === "trials") done.trials += less(plan.trials.added, await deps.ledger.restoreTrials(payload.research.trials, { dryRun: true }));
    else if (step === "rows") {
      const left = await deps.ledger.restoreLedger({ rows: payload.ledger.rows, outcomes: payload.ledger.outcomes, universes: payload.ledger.universes }, { dryRun: true });
      done.rows += less(plan.ledger.added, left.rows.added);
      done.outcomes += less(plan.outcomes.added, left.outcomes.added);
      done.universes += less(plan.universes.added, left.universes.added);
    } else if (step === "gaps") done.gaps += less(plan.gaps.added, (await deps.ledger.restoreGaps(payload.ledger.gaps, { dryRun: true })).added);
    else if (step === "journal") done.journal += less(plan.journal.added, (await deps.paper.importJournal(payload.paper.journal, { dryRun: true })).added);
    else done.notes += less(plan.notes.added, (await restoreNotes(payload.paper.notes, deps, true)).added);
  } catch {
    /* a store that cannot be read: the counts stay lower bounds */
  }
}
