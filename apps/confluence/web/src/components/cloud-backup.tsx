"use client";

/**
 * cloud-backup.tsx — v2.8 (WP28 Task 10): About → "Cloud backup (encrypted)".
 *
 * A collapsed <details> after the existing Backup section. Its body mounts only while it is open, so at rest nothing is
 * computed and nothing is requested. One operation at a time; closing the section (or About) aborts it through the
 * AbortSignal that every target call receives. The passphrase lives only in the two inputs and is cleared after every
 * attempt; it is never stored, logged or put in a message. Errors show a fixed text per BackupError code, never a raw
 * message. Restoring asks first, shows the backup time and leaves newer settings alone unless the box is ticked.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRsl } from "@/rsl/RslContext";
import { BackupError, MIN_PASSPHRASE_CHARS } from "@/lib/backup-crypto";
import { applyRestore, createBackupFile, openBackupFile, type BackupDeps, type RestorePlan } from "@/lib/backup-service";
import { BUILD_BACKUP_CONFIG, PROVIDER_NAMES, availability, type Availability, type BackupProviderId, type OAuthProviderId } from "@/lib/backup-providers";
import { beginWebSignIn, signInShell } from "@/lib/backup-oauth";
import { clearSession, getSession } from "@/lib/backup-session";
import { backupHttp, shellOAuth } from "@/lib/backup-http";
import { gdriveTarget, onedriveTarget, pcloudTarget, type BackupFileInfo, type BackupTarget } from "@/lib/backup-targets";
import { gatewayBackupTarget } from "@/lib/backup-gateway-client";
import type { LedgerStore } from "@/lib/signal-ledger";
import type { ProviderLink, ProviderProfile } from "@/lib/private-api";
import { channelShell } from "@/lib/update-channel";
import { buildStamp } from "@rsl/core-kit/core/rsl-brand.js";
import { APP } from "@/rsl/app-info";

export interface CloudBackupProps {
  /** `ledger` also offers `stats` (the device's retention days and row cap, read only when a plan needs them). */
  deps: Omit<BackupDeps, "now" | "app" | "actorId" | "ledger"> & { ledger: BackupDeps["ledger"] & Pick<LedgerStore, "stats"> };
  providerLink: ProviderLink | null;
  startOpen: boolean;
  /** A sign-in return to report (an i18n key and its values, translated at render), shown once the section is open. */
  notice: StatusLine | null;
}

/** One status line: an i18n key and its values, translated at render so a language change applies to it. */
export interface StatusLine { key: string; vars?: Record<string, string | number> }

const PROVIDERS: BackupProviderId[] = ["gdrive", "onedrive", "pcloud", "b2", "r2"];
const STATE_KEY: Record<Availability, string> = {
  ready: "bk.state.ready",
  "not-set-up": "bk.state.notSetUp",
  "desktop-only": "bk.state.desktopOnly",
  "web-desktop-only": "bk.state.webDesktopOnly",
  "needs-gateway": "bk.state.needsGateway",
  "not-here": "bk.state.notHere",
};
/** The app version in the authenticated header, e.g. "2.8.0 (build 20261117)". */
const APP_STAMP: string = buildStamp({ version: APP.version, year: APP.year, build: APP.build });
const isOAuth = (p: BackupProviderId): p is OAuthProviderId => p === "gdrive" || p === "onedrive" || p === "pcloud";

/** The newest connected gateway profile of this bucket kind, or null. */
function newestProfile(link: ProviderLink | null, p: "b2" | "r2"): ProviderProfile | null {
  const list = (link?.providers ?? []).filter((x) => x.provider === p);
  if (!list.length) return null;
  const at = (x: ProviderProfile) => { const t = Date.parse(x.connectedAt); return Number.isFinite(t) ? t : 0; };
  return list.reduce((best, x) => (at(x) >= at(best) ? x : best)); // ties: the later connection
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const passLength = (s: string) => [...s.normalize("NFC")].length;

export function CloudBackupSection(props: CloudBackupProps) {
  const { t } = useRsl();
  const [open, setOpen] = useState(props.startOpen);
  return (
    <details data-testid="about-cloud-backup" open={props.startOpen} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="mt-3 rounded-md border border-zinc-800 px-3 py-2 text-xs text-zinc-400">
      <summary className="cursor-pointer select-none text-sm font-semibold text-zinc-200">{t("bk.title")}</summary>
      {open && <CloudBackupBody {...props} />}
    </details>
  );
}

type Status = { tone: "ok" | "err" | "info"; lines: StatusLine[] };

function CloudBackupBody({ deps: base, providerLink, notice }: CloudBackupProps) {
  const { t, i18n, id, info } = useRsl();
  const shell = channelShell(info.shell);
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [running, setBusy] = useState(false);
  const [reloading, setReloading] = useState(false);
  const busy = running || reloading;
  const [status, setStatus] = useState<Status | null>(null);
  // The notice goes into the live region after it has mounted, so screen readers announce it (content present at
  // insertion is not read out).
  useEffect(() => {
    if (!notice) return;
    const id = requestAnimationFrame(() => setStatus({ tone: "err", lines: [notice] }));
    return () => cancelAnimationFrame(id);
  }, [notice]);
  const rootRef = useRef<HTMLDivElement>(null);
  /** After Cancel, focus goes back to the Restore button that opened the plan. */
  const [refocus, setRefocus] = useState<{ p: BackupProviderId } | null>(null);
  useEffect(() => {
    if (!refocus) return;
    rootRef.current?.querySelector<HTMLButtonElement>(`[data-testid="bk-restore-${refocus.p}"]`)?.focus();
  }, [refocus]);
  const [, setTick] = useState(0); // sessions live in module memory: re-render after sign-in / sign-out
  const [list, setList] = useState<{ p: BackupProviderId; files: BackupFileInfo[]; chosen: string } | null>(null);
  const [plan, setPlan] = useState<{ p: BackupProviderId; plan: RestorePlan; settings: boolean; limits: { days: number; max: number } | null } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Closing the section (or About) unmounts this body: whatever is running is aborted.
  useEffect(() => () => abortRef.current?.abort(), []);

  const deps: BackupDeps = useMemo(() => ({
    ...base,
    actorId: id.operator.id || "local",
    app: APP_STAMP,
    now: () => Date.now(),
  }), [base, id.operator.id]);

  const gatewayProviders = useMemo(() => (providerLink?.providers ?? []).map((x) => x.provider), [providerLink]);
  const origin = typeof location !== "undefined" ? location.origin : "";
  const state = (p: BackupProviderId): Availability =>
    availability(p, { shell, config: BUILD_BACKUP_CONFIG, origin, gatewayProviders });

  const when = (ms: number) => new Date(ms).toLocaleString(i18n.locale, { dateStyle: "medium", timeStyle: "short" });

  /** A fixed text per code. The timeout copy speaks of sign-in, so a transfer that ran out of time says "could not be reached". */
  const errLine = (e: unknown, signingIn: boolean): StatusLine => {
    // Anything that is not a BackupError makes no claim about what changed (a store can fail part-way).
    if (!(e instanceof BackupError)) return { key: "bk.failed" };
    const d = e.detail;
    const code = e.code === "timeout" && !signingIn ? "network" : e.code;
    // Final review M-2: a backup over the 160 MB unpacked cap says both sizes (the file size is an estimate then).
    const key = code === "too-large-backup" && typeof d.plain === "number" ? "bk.err.too-large-plain" : `bk.err.${code}`;
    return {
      key,
      vars: {
        size: typeof d.size === "number" ? formatBytes(d.size) : "—", plain: typeof d.plain === "number" ? formatBytes(d.plain) : "—",
        status: d.status ?? "—", origin: d.origin ?? "—", n: d.n ?? "—",
      },
    };
  };

  /** One operation at a time, with a fresh AbortSignal; the passphrase fields are cleared afterwards. */
  const run = async (work: (signal: AbortSignal) => Promise<void>, signingIn = false) => {
    if (busy) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    setStatus({ tone: "info", lines: [{ key: "bk.working" }] });
    try {
      await work(ac.signal);
    } catch (e) {
      if (!ac.signal.aborted) setStatus({ tone: "err", lines: [errLine(e, signingIn)] });
    } finally {
      setPass("");
      setPass2("");
      if (abortRef.current === ac) abortRef.current = null;
      if (!ac.signal.aborted) setBusy(false);
    }
  };

  const target = (p: BackupProviderId): BackupTarget => {
    const a = state(p);
    if (a === "needs-gateway") throw new BackupError("needs-gateway", { provider: p });
    if (a === "not-set-up") throw new BackupError("not-set-up", { provider: p });
    if (a !== "ready") throw new BackupError("unavailable", { provider: p });
    if (p === "b2" || p === "r2") {
      const profile = newestProfile(providerLink, p);
      if (!providerLink || !profile) throw new BackupError("needs-gateway", { provider: p });
      return gatewayBackupTarget(providerLink, profile);
    }
    const s = getSession(p);
    if (!s) throw new BackupError("session", { provider: p });
    const http = backupHttp();
    return p === "gdrive" ? gdriveTarget(s, http) : p === "onedrive" ? onedriveTarget(s, http) : pcloudTarget(s, http);
  };

  const signIn = (p: OAuthProviderId) => run(async (signal) => {
    if (shell === "web") {
      await beginWebSignIn(p, BUILD_BACKUP_CONFIG, { storage: sessionStorage, assign: (url) => window.location.assign(url) });
      return; // the page leaves for the sign-in page
    }
    const oauth = shellOAuth();
    if (!oauth) throw new BackupError("unavailable", { provider: p });
    await signInShell(p, BUILD_BACKUP_CONFIG, { shell, oauth, http: backupHttp(), now: () => Date.now(), signal });
    setTick((n) => n + 1);
    setStatus({ tone: "ok", lines: [{ key: "bk.signedIn" }] });
  }, true);

  const signOut = (p: OAuthProviderId) => {
    clearSession(p);
    setList(null);
    setPlan(null);
    setTick((n) => n + 1);
    setStatus(null);
  };

  const backUp = (p: BackupProviderId) => {
    const ok = pass === pass2 && passLength(pass) >= MIN_PASSPHRASE_CHARS;
    const passphrase = pass;
    if (!ok) {
      setPass("");
      setPass2("");
      setStatus({ tone: "err", lines: [{ key: "bk.err.passphrase" }] });
      return;
    }
    setList(null);
    setPlan(null);
    void run(async (signal) => {
      const tg = target(p);
      const file = await createBackupFile(deps, passphrase);
      if (signal.aborted) throw new BackupError("cancelled");
      await tg.upload(file.name, file.text, signal);
      const lines: StatusLine[] = [{ key: "bk.done", vars: { name: file.name, size: formatBytes(file.bytes) } }];
      const s = file.skipped;
      if (s.rows + s.preregistrations + s.trials + s.journal > 0) {
        lines.push({ key: "bk.skipped", vars: { rows: s.rows, prereg: s.preregistrations, trials: s.trials, journal: s.journal } });
      }
      if (s.replayRows > 0) lines.push({ key: "bk.skippedReplay", vars: { n: s.replayRows } });
      const other = s.outcomes + s.universes + s.gaps + s.notes;
      if (other > 0) lines.push({ key: "bk.skippedRecords", vars: { n: other } });
      try {
        await deps.audit.append({
          actorId: deps.actorId, event: "backup.cloud.upload", record: "backup",
          reason: `${PROVIDER_NAMES[p]} · ${file.name} · ${file.bytes} bytes · ${file.counts.rows} rows`,
        });
      } catch {
        // The file is in the bucket: say so, and that only its audit entry is missing.
        setStatus({ tone: "err", lines: [...lines, { key: "bk.uploadAuditFailed" }] });
        return;
      }
      setStatus({ tone: "ok", lines });
    });
  };

  const showList = (p: BackupProviderId) => {
    setPlan(null);
    setList(null);
    void run(async (signal) => {
      const files = await target(p).list(signal);
      if (!files.length) { setStatus({ tone: "info", lines: [{ key: "bk.none" }] }); return; }
      setList({ p, files, chosen: files[0].id });
      setStatus(null);
    });
  };

  const openChosen = () => {
    if (!list) return;
    const passphrase = pass;
    if (passLength(passphrase) < MIN_PASSPHRASE_CHARS) {
      setPass("");
      setPass2("");
      setStatus({ tone: "err", lines: [{ key: "bk.err.passphrase" }] });
      return;
    }
    const { p, files, chosen } = list;
    const file = files.find((f) => f.id === chosen) ?? files[0];
    void run(async (signal) => {
      const text = await target(p).download(file, signal);
      if (signal.aborted) throw new BackupError("cancelled");
      const opened = await openBackupFile(text, passphrase, deps);
      if (signal.aborted) throw new BackupError("cancelled");
      let limits: { days: number; max: number } | null = null;
      if (opened.ledger.tooOld > 0 || opened.ledger.capDropped > 0 || opened.ledger.agePrunedDays > 0) {
        const st = await base.ledger.stats();
        limits = { days: st.retentionDays, max: st.maxRows };
      }
      const s = opened.settings;
      setPlan({ p, plan: opened, settings: s.present && !(s.localNewer || s.differs), limits });
      setList(null);
      setStatus(null);
    });
  };

  const confirmRestore = () => {
    if (!plan) return;
    const current = plan;
    void run(async () => {
      await applyRestore(current.plan, { settings: current.settings && current.plan.settings.present }, deps);
      setPlan(null);
      setStatus({ tone: "ok", lines: [{ key: "bk.restored" }] });
      setReloading(true); // every button stays disabled until the reload
      window.setTimeout(() => window.location.reload(), 800);
    });
  };

  const btn = "inline-flex h-9 items-center justify-center rounded-md border border-zinc-700 px-3 text-xs text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50";
  const field = "h-9 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100";

  return (
    <div ref={rootRef} className="mt-2 space-y-3">
      <p>{t("bk.intro")}</p>

      <ul className="space-y-2">
        {PROVIDERS.map((p) => {
          const a = state(p);
          const session = isOAuth(p) ? getSession(p) : null;
          const profile = p === "b2" || p === "r2" ? newestProfile(providerLink, p) : null;
          const canUse = a === "ready" && (isOAuth(p) ? !!session : !!profile);
          return (
            <li key={p} data-testid={`bk-provider-${p}`} data-state={a} className="border-t border-zinc-800 pt-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="text-sm font-semibold text-zinc-200" dir="ltr">{PROVIDER_NAMES[p]}</span>
                <span>
                  {a === "ready" && session ? t("bk.signedIn") : t(STATE_KEY[a])}
                  {a === "ready" && profile && <span className="ms-2 font-mono text-zinc-500" dir="ltr">{profile.bucket ?? profile.label}</span>}
                </span>
              </div>
              {a === "ready" && (
                <div className="mt-1 flex flex-wrap gap-2">
                  {isOAuth(p) && !session && <button type="button" data-testid={`bk-signin-${p}`} className={btn} disabled={busy} onClick={() => void signIn(p)}>{t("bk.signIn")}</button>}
                  {isOAuth(p) && session && <button type="button" data-testid={`bk-signout-${p}`} className={btn} disabled={busy} onClick={() => signOut(p)}>{t("bk.signOut")}</button>}
                  {canUse && <button type="button" data-testid={`bk-backup-${p}`} className={btn} disabled={busy} onClick={() => backUp(p)}>{t("bk.backup")}</button>}
                  {canUse && <button type="button" data-testid={`bk-restore-${p}`} className={btn} disabled={busy} onClick={() => showList(p)}>{t("bk.restore")}</button>}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="block text-zinc-300">{t("bk.passphrase")}</span>
          <input data-testid="bk-pass" type="password" autoComplete="new-password" spellCheck={false} className={field} disabled={busy}
            value={pass} onChange={(e) => setPass(e.target.value)} />
        </label>
        <label className="space-y-1">
          <span className="block text-zinc-300">{t("bk.passphraseAgain")}</span>
          <input data-testid="bk-pass2" type="password" autoComplete="new-password" spellCheck={false} className={field} disabled={busy}
            value={pass2} onChange={(e) => setPass2(e.target.value)} />
        </label>
      </div>
      <p>{t("bk.passphraseRule")}</p>

      {list && (
        <fieldset data-testid="bk-list" className="space-y-1 rounded-md border border-zinc-800 p-2">
          <legend className="px-1 text-zinc-300" dir="ltr">{PROVIDER_NAMES[list.p]}</legend>
          {list.files.map((f) => (
            <label key={f.id} className="flex flex-wrap items-center gap-2">
              <input type="radio" name="bk-file" value={f.id} checked={list.chosen === f.id} disabled={busy}
                onChange={() => setList({ ...list, chosen: f.id })} />
              <span className="font-mono" dir="ltr">{f.name}</span>
              <span>{when(f.modifiedAt)}</span>
              <span dir="ltr">{formatBytes(f.size)}</span>
            </label>
          ))}
          <button type="button" data-testid="bk-open" className={btn} disabled={busy} onClick={openChosen}>{t("bk.open")}</button>
        </fieldset>
      )}

      {plan && <PlanPanel plan={plan} busy={busy} btn={btn} when={when}
        onSettings={(v) => setPlan({ ...plan, settings: v })} onConfirm={confirmRestore} onCancel={() => { setPlan(null); setStatus(null); setRefocus({ p: plan.p }); }} />}

      <div role="status" data-testid="bk-status" className={status?.tone === "err" ? "text-rose-300" : status?.tone === "ok" ? "text-emerald-300" : "text-zinc-300"}>
        {status?.lines.map((l, i) => <p key={i}>{t(l.key, l.vars)}</p>)}
      </div>
    </div>
  );
}

function PlanPanel({ plan: s, busy, btn, when, onSettings, onConfirm, onCancel }: {
  plan: { p: BackupProviderId; plan: RestorePlan; settings: boolean; limits: { days: number; max: number } | null };
  busy: boolean;
  btn: string;
  when: (ms: number) => string;
  onSettings: (v: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useRsl();
  const plan = s.plan;
  const descId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const focusedRef = useRef(false);
  // alertdialog pattern: focus moves into the panel when it opens; Cancel (the safe choice) takes it as soon as it is
  // enabled (the panel mounts while the opening operation is still finishing).
  useEffect(() => {
    if (busy || focusedRef.current || !cancelRef.current) return;
    cancelRef.current.focus();
    focusedRef.current = true;
  }, [busy]);
  const payload = plan.parsed.payload;
  const rejected = plan.ledger.rejected + plan.journal.rejected + plan.preregistrations.rejected + plan.trials.rejected
    + plan.outcomes.rejected + plan.universes.rejected + plan.gaps.rejected + plan.notes.rejected;
  const notKept = plan.outcomes.notKept + plan.universes.notKept + plan.gaps.notKept;
  const st = plan.settings;
  return (
    <div role="alertdialog" aria-label={t("bk.restore")} aria-describedby={`${descId}-time ${descId}-counts`} data-testid="bk-plan" className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-amber-100">
      <p id={`${descId}-time`}>{t("bk.restore.time", { time: when(plan.header.createdAt) })}</p>
      <p id={`${descId}-counts`}>{t("bk.restore.counts", {
        rows: plan.ledger.inFile, added: plan.ledger.added,
        journal: plan.journal.inFile, jadded: plan.journal.added,
        prereg: payload.research.preregistrations.length + plan.preregistrations.rejected, padded: plan.preregistrations.added,
      })}</p>
      <p data-testid="bk-plan-records">{t("bk.restore.records", {
        outcomes: plan.outcomes.inFile, oadded: plan.outcomes.added, universes: plan.universes.inFile, uadded: plan.universes.added,
        gaps: plan.gaps.inFile, gadded: plan.gaps.added, notes: plan.notes.inFile, nadded: plan.notes.added,
      })}</p>
      {rejected > 0 && <p>{t("bk.restore.rejected", { n: rejected })}</p>}
      {notKept > 0 && <p>{t("bk.restore.notKept", { n: notKept })}</p>}
      {plan.ledger.tooOld > 0 && <p>{t("bk.restore.tooOld", { n: plan.ledger.tooOld, days: s.limits?.days ?? "—" })}</p>}
      {plan.ledger.capDropped > 0 && <p>{t("bk.restore.overCap", { n: plan.ledger.capDropped, max: s.limits?.max ?? "—" })}</p>}
      {plan.ledger.agePrunedDays > 0 && <p>{t("bk.restore.agePruned", { n: plan.ledger.agePrunedDays, days: s.limits?.days ?? "—" })}</p>}
      {plan.localNewerRecords && <p>{t("bk.restore.newerRecords")}</p>}
      {st.present && (
        <>
          {st.localNewer && st.localChangedAt !== null
            ? <p data-testid="bk-settings-newer">{t("bk.restore.newer", { time: when(st.localChangedAt) })}</p>
            : st.differs && <p data-testid="bk-settings-differs">{t("bk.restore.differs")}</p>}
          <label className="flex items-center gap-2">
            <input type="checkbox" data-testid="bk-settings" className="h-4 w-4 accent-cyan-500" checked={s.settings} disabled={busy}
              onChange={(e) => onSettings(e.target.checked)} />
            {t("bk.restore.settings")}
          </label>
        </>
      )}
      <div className="flex gap-2 pt-1">
        <button type="button" data-testid="bk-confirm" className={btn} disabled={busy} onClick={onConfirm}>{t("bk.restore.confirm")}</button>
        <button type="button" ref={cancelRef} data-testid="bk-cancel" className={btn} disabled={busy} onClick={onCancel}>{t("bk.restore.cancel")}</button>
      </div>
    </div>
  );
}
