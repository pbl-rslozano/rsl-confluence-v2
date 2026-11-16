"use client";

/**
 * About — brand + build stamp, 3D signature, edition, platform/storage, audit-trail integrity,
 * language catalog status, workspace identity (edit / export), backup export/restore,
 * contact, credit at the end. Builder skill §3.5, §7; identity skill §2.3–2.4, §3.3, §6.2.
 * v2.8 (WP20, licence audit): a collapsed "Open-source licences" section just above the credit — the third-party notices
 * (out/THIRD-PARTY-NOTICES.txt, tools/third-party-notices.mjs) and the trademark line.
 * v2.8 (owner request, 15 Nov 2026): a collapsed, optional rsL Coffee Kit tip card (CoffeeSection) just above it.
 */
import { useEffect, useState, type MouseEvent } from "react";
import { LANGUAGES } from "@rsl/core-kit/core/rsl-i18n.js";
import { CATALOGS, PENDING_REVIEW } from "../i18n/catalogs";
import { exportSnapshot, importSnapshot } from "@rsl/core-kit/core/rsl-storage.js";
import { contactMailto, poweredBy, BRAND } from "@rsl/core-kit/core/rsl-brand.js";
import { exportFileName } from "@rsl/core-kit/core/rsl-export.js";
import type { Identity } from "@rsl/core-kit/core/rsl-identity.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { APP, COLLECTIONS } from "../app-info";
import { SCHEMA_VERSION } from "../boot";
import { useRsl } from "../RslContext";
import { useUpdate } from "../UpdateContext";
import { BrandBlock } from "./BrandBlock";
import { CoffeeSection } from "./CoffeeSection";
import { Flag } from "./Flags";
import { IdentityForm } from "./IdentityForm";
import { Monogram3D } from "./Monogram3D";

import { BUILD_COMMIT } from "@/lib/build-info";
import { PROVIDERS } from "@/lib/providers";

const STAMP_APP = { name: APP.name, version: APP.version, year: APP.year, build: APP.build };

export function AboutDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] w-[min(100vw-1.5rem,40rem)] max-w-[min(100vw-1.5rem,40rem)] overflow-y-auto border-zinc-800 bg-zinc-900 text-zinc-100">
        {/* Mounted only while open, so every opening starts from fresh state. */}
        {open && <AboutBody />}
      </DialogContent>
    </Dialog>
  );
}

function AboutBody() {
  const rsl = useRsl();
  const { t, id, info, port, audit, platform, i18n } = rsl;
  const [verify, setVerify] = useState<{ intact: boolean; count: number; brokenAt: number | null } | null>(null);
  const [headRef, setHeadRef] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Identity>(id);
  const [pendingRestore, setPendingRestore] = useState<unknown>(null);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    void audit.verify().then(setVerify);
    void audit.footerRef().then(setHeadRef);
  }, [audit]);

  const actor = id.operator.id || "local";

  const doExport = async () => {
    try {
      const head = await audit.head();
      const snap = await exportSnapshot(port, { appId: APP.code, appVersion: `${APP.version} ${APP.year}`, collections: COLLECTIONS, auditHead: { seq: head.seq, hash: head.hash } });
      const name = exportFileName({ app: "ConfluenceTerminal", customerCode: id.customer.code, docId: "backup", ext: "rslbak" });
      const r = await platform.saveOrShare(JSON.stringify(snap, null, 2), name, "application/json");
      if (r.cancelled) return;
      await audit.append({ actorId: actor, event: "backup.export", reason: `${name} · sha256 ${String(snap.sha256).slice(0, 12)}…` });
      await rsl.markBackup();
      setMsg({ tone: "ok", text: t("about.exported") });
    } catch (e) {
      setMsg({ tone: "err", text: t("about.failed", { reason: e instanceof Error ? e.message : String(e) }) });
    }
  };

  const pickRestore = async () => {
    try {
      const f = await platform.openFile({ accept: [".rslbak", ".json"], maxBytes: 5 * 1024 * 1024 });
      if (!f) return;
      setPendingRestore(JSON.parse(new TextDecoder().decode(f.bytes)));
    } catch (e) {
      setMsg({ tone: "err", text: t("about.failed", { reason: e instanceof Error ? e.message : String(e) }) });
    }
  };

  const confirmRestore = async () => {
    try {
      const r = await importSnapshot(port, pendingRestore, { appId: APP.code, maxSchemaVersion: SCHEMA_VERSION });
      await audit.append({ actorId: actor, event: "backup.restore", reason: `${r.collections} collections · schema ${r.schemaVersion}` });
      setMsg({ tone: "ok", text: t("about.restored") });
      window.setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      setPendingRestore(null);
      setMsg({ tone: "err", text: t("about.failed", { reason: e instanceof Error ? e.message : String(e) }) });
    }
  };

  const saveIdentity = async () => {
    const r = await rsl.setIdentity(draft);
    if (!r.ok) { setErrors(r.errors); return; }
    setErrors([]); setEditing(false);
  };

  const exportIdentity = async () => {
    const name = exportFileName({ app: "ConfluenceTerminal", customerCode: id.customer.code, docId: "identity", ext: "json" });
    await platform.saveOrShare(rsl.identity.exportJSON(), name, "application/json");
  };

  const row = "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-zinc-800 py-2 text-sm";
  const btn = "inline-flex h-11 items-center justify-center rounded-md border border-zinc-700 px-3 text-sm text-zinc-200 hover:bg-zinc-800";

  return (
    <>
        <DialogHeader>
          <DialogTitle>{t("about.title")}</DialogTitle>
          <DialogDescription className="sr-only">{poweredBy(STAMP_APP)}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-2 pb-2">
          <Monogram3D size={168} fallbackLabel={t("about.webglOff")} />
          <BrandBlock large />
          <p className="text-xs text-zinc-400">{t("app.subtitle")}</p>
          <p className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300">{t("about.edition")}</p>
        </div>

        <div>
          <div className={row}><span className="text-zinc-400">{t("chip.workspace")}</span><span className="max-w-[60%] truncate text-end" title={id.customer.legalName}><bdi>{id.customer.legalName}</bdi></span></div>
          <div className={row}><span className="text-zinc-400">{t("about.platform")}</span><span className="font-mono text-xs" dir="ltr">{info.shell} · {info.os} · {info.pointer}</span></div>
          <div className={row}><span className="text-zinc-400">{t("about.storage")}</span><span className="text-xs">{t("status.storage", { kind: port.kind })}</span></div>
          <div className={row}>
            <span className="text-zinc-400">{t("about.audit")}</span>
            <span className={`text-xs ${verify && !verify.intact ? "font-semibold text-rose-300" : "text-emerald-300"}`}>
              {verify ? (verify.intact ? t("about.auditOk", { n: verify.count }) : t("about.auditBroken", { k: verify.brokenAt })) : "…"}
              <span className="ms-2 font-mono text-zinc-500" dir="ltr">{headRef}</span>
            </span>
          </div>
          <div className={row}><span className="text-zinc-400">{t("about.kit")}</span><span className="font-mono text-xs" dir="ltr">{APP.coreKit}</span></div>
          {/* v2.6 (US-4): the source commit lets a user compare this build with the GitHub release. */}
          <div className={row}><span className="text-zinc-400">{t("about.commit")}</span><span data-testid="about-commit" className="select-all font-mono text-xs" dir="ltr">{BUILD_COMMIT}</span></div>
        </div>

        <section className="pt-2">
          <h3 className="mb-2 text-sm font-semibold">{t("about.identity")}</h3>
          {editing ? (
            <div className="space-y-3">
              <IdentityForm draft={draft} onChange={setDraft} show="both" />
              {errors.length > 0 && <ul role="alert" className="list-disc ps-5 text-xs text-rose-300">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
              <div className="flex gap-2"><button type="button" className={btn} onClick={() => void saveIdentity()}>{t("wiz.finish")}</button><button type="button" className={btn} onClick={() => setEditing(false)}>{t("wiz.back")}</button></div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={btn} onClick={() => setEditing(true)}>{t("about.editIdentity")}</button>
              <button type="button" className={btn} onClick={() => void exportIdentity()}>{t("about.exportIdentity")}</button>
            </div>
          )}
        </section>

        <section className="pt-3">
          <h3 className="mb-2 text-sm font-semibold">{t("about.backup")}</h3>
          {pendingRestore ? (
            <div role="alertdialog" aria-label={t("about.restore")} className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100">
              <p>{t("about.restoreConfirm")}</p>
              <div className="flex gap-2"><button type="button" className={btn} onClick={() => void confirmRestore()}>{t("about.restore")}</button><button type="button" className={btn} onClick={() => setPendingRestore(null)}>{t("wiz.back")}</button></div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={btn} onClick={() => void doExport()}>{t("about.export")}</button>
              <button type="button" className={btn} onClick={() => void pickRestore()}>{t("about.restore")}</button>
            </div>
          )}
          {msg && <p role="status" className={`mt-2 text-xs ${msg.tone === "ok" ? "text-emerald-300" : "text-rose-300"}`}>{msg.text}</p>}
        </section>

        <UpdatesSection btn={btn} />

        <section className="pt-3">
          <h3 className="mb-2 text-sm font-semibold">{t("about.languages")}</h3>
          <ul className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
            {LANGUAGES.map((l) => (
              <li key={l.code} className="flex items-center gap-2">
                <Flag code={l.flag} />
                <span lang={l.code} dir={l.dir}>{l.native}</span>
                {(() => {
                  // v2.5: APPROVED (en, ar) · CERTIFIED (named reviewer) · MACHINE-CHECKED · DRAFT
                  const st = i18n.status(l.code);
                  const meta = CATALOGS[l.code] ?? {};
                  if (st === "CERTIFIED") return <span className="text-emerald-300">{t("about.catalogCertified", { name: meta["@reviewer"] ?? "", date: meta["@certifiedAt"] ?? "" })}</span>;
                  // Final review I-1: an approved tier-1 catalog with machine drafts says how many await review.
                  const pending = PENDING_REVIEW[l.code]?.length ?? 0;
                  if (st === "APPROVED" && pending) return <span data-testid={`catalog-pending-${l.code}`} className="text-amber-300">{t("about.catalogApprovedPending", { n: pending })}</span>;
                  if (st === "APPROVED") return <span className="text-emerald-300">{t("about.catalogApproved")}</span>;
                  if (st === "MACHINE-CHECKED") return <span className="text-sky-300">{t("about.catalogMachine")}</span>;
                  return <span className="text-amber-300">{t("about.catalogDraft")}</span>;
                })()}
              </li>
            ))}
          </ul>
        </section>

        <CoffeeSection />

        <LicencesSection />
        <ThanksSection />

        <footer className="mt-4 space-y-1 border-t border-zinc-800 pt-3 text-xs text-zinc-400">
          <p>
            {t("ctl.contact")}: <a className="text-cyan-300 underline-offset-2 hover:underline" href={contactMailto(STAMP_APP, APP.contactSubject)}>{BRAND.contactEmail}</a>
            <span className="select-all font-mono text-zinc-500"> ({BRAND.contactEmail})</span>
          </p>
          {/* v2.6 (US-6) */}
          <p>{t("about.dataNotice")}</p>
          <p dir="ltr">{poweredBy(STAMP_APP)}</p>
          <p dir="ltr">{APP.credit}</p>
        </footer>
    </>
  );
}

/** Shipped next to index.html in every bundle (scripts/build-html.mjs → tools/third-party-notices.mjs). */
const NOTICES_HREF = "./THIRD-PARTY-NOTICES.txt";

/**
 * v2.8 (WP20): collapsed by default. The link opens the notices file; a plain click shows it here instead, because the
 * desktop and mobile shells do not open a new window for a local file.
 */
function LicencesSection() {
  const { t } = useRsl();
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const show = async (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    try {
      const r = await fetch(NOTICES_HREF, { cache: "no-cache" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setErr(null);
      setText(await r.text());
    } catch (x) {
      setErr(t("about.failed", { reason: x instanceof Error ? x.message : String(x) }));
    }
  };
  return (
    <details data-testid="about-licences" className="mt-4 rounded-md border border-zinc-800 px-3 py-2 text-xs text-zinc-400">
      <summary className="cursor-pointer select-none text-sm font-semibold text-zinc-200">{t("about.licences")}</summary>
      <p className="mt-2">{t("about.licencesNote")}</p>
      <p className="mt-1">
        <a data-testid="about-licences-link" href={NOTICES_HREF} target="_blank" rel="noopener" onClick={(e) => void show(e)}
          className="text-cyan-300 underline-offset-2 hover:underline">{t("about.licencesOpen")}</a>
      </p>
      {text !== null && (
        <pre data-testid="about-licences-text" dir="ltr" tabIndex={0}
          className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-950 p-2 font-mono text-[10px] text-zinc-300">{text}</pre>
      )}
      {err && <p role="status" className="mt-2 text-rose-300">{err}</p>}
      <p data-testid="about-trademarks" className="mt-2">{t("about.trademarks")}</p>
    </details>
  );
}

/**
 * v2.8 (WP26): "Data sources & thanks" — collapsed by default; names in text only. Links open in the browser and are
 * never fetched. The required rate credit appears verbatim where a provider has one.
 */
export function ThanksSection({ testId = "about-thanks", open, onToggle }: { testId?: string; open?: boolean; onToggle?: (open: boolean) => void } = {}) {
  const { t } = useRsl();
  const link = "text-cyan-300 underline-offset-2 hover:underline";
  return (
    <details data-testid={testId} open={open} onToggle={onToggle ? (e) => onToggle((e.currentTarget as HTMLDetailsElement).open) : undefined} className="mt-3 rounded-md border border-zinc-800 px-3 py-2 text-xs text-zinc-400">
      <summary className="cursor-pointer select-none text-sm font-semibold text-zinc-200">{t("about.thanks")}</summary>
      <p className="mt-2">{t("about.thanksNote")}</p>
      <ul className="mt-2 space-y-2">
        {PROVIDERS.map((p) => (
          <li key={p.id} data-testid="about-provider" className="border-t border-zinc-800 pt-2">
            <span className="font-semibold text-zinc-200" dir="ltr">{p.name}</span>
            <span className="ms-2">{t(p.uses)}</span>
            <span className="mt-0.5 flex flex-wrap gap-x-3">
              <a className={link} href={p.apiDocs} target="_blank" rel="noopener noreferrer">{t("about.thanksApi")}</a>
              <a className={link} href={p.terms} target="_blank" rel="noopener noreferrer">{t("about.thanksTerms")}</a>
              {p.credit && <span dir="ltr" className="text-zinc-300">{p.credit}</span>}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** v2.5.1 (ADR-0012): automatic update checks (default on), Check now, last result. */
function UpdatesSection({ btn }: { btn: string }) {
  const { t, i18n } = useRsl();
  const u = useUpdate();
  const when = u.lastCheckedAt ? new Date(u.lastCheckedAt).toLocaleString(i18n.locale, { dateStyle: "medium", timeStyle: "short" }) : null;
  const line =
    u.status === "checking" ? t("about.updatesChecking")
    : u.status === "available" && u.manifest ? t("about.updatesAvailable", { version: u.manifest.version })
    : u.status === "current" ? t("about.updatesCurrent")
    : u.status === "failed" ? t("about.updatesFailed")
    : null;
  return (
    <section className="pt-3" data-testid="about-updates">
      <h3 className="mb-2 text-sm font-semibold">{t("about.updates")}</h3>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" role="switch" data-testid="updates-auto" className="h-4 w-4 accent-cyan-500" checked={u.enabled} onChange={(e) => void u.setEnabled(e.target.checked)} aria-checked={u.enabled} />
          {t("about.updatesAuto")}
        </label>
        <button type="button" data-testid="updates-check" className={btn} disabled={u.status === "checking"} onClick={() => void u.checkNow()}>{t("about.updatesCheck")}</button>
      </div>
      <p role="status" data-testid="updates-status" className="mt-2 text-xs text-zinc-400">
        {line}{line && when ? " · " : ""}{when ? t("about.updatesLast", { time: when }) : ""}
      </p>
      <p className="mt-1 text-xs text-zinc-400">{t("about.updatesNote")}</p>
    </section>
  );
}
