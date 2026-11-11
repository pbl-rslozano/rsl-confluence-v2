"use client";

/**
 * UpdateNotice — one line above the footer when a newer version is published (ADR-0012).
 * PWA: Reload to update · Android: Download update (opens the signed APK in the system browser) ·
 * iPhone / desktop: how to install. "Later" hides it until the next version.
 */
import { formatBytes } from "@/lib/update-channel";
import { useRsl } from "../RslContext";
import { useUpdate } from "../UpdateContext";

const btn = "rsl-touch inline-flex items-center rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs font-medium text-zinc-100 hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400";

export function UpdateNotice() {
  const { t } = useRsl();
  const u = useUpdate();
  if (!u.showNotice || !u.manifest || !u.action) return null;
  const { manifest: m, action: a } = u;
  return (
    <div role="status" data-testid="update-notice" className="flex shrink-0 flex-wrap items-center gap-2 border-t border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-100">
      <span className="min-w-0 grow">
        {t("update.available", { version: m.version, build: m.build })}
        {m.notes ? <span title={m.notes} className="ms-1 hidden max-w-[48ch] truncate align-bottom text-zinc-400 sm:inline-block">{m.notes}</span> : null}
      </span>
      {a.kind === "reload" && <button type="button" data-testid="update-reload" className={btn} onClick={() => void u.applyReload()}>{t("update.reload")}</button>}
      {a.kind === "download" && (
        <a data-testid="update-download" className={btn} href={a.url} target="_blank" rel="noopener noreferrer" title={`SHA-256 ${a.sha256}`}>
          {t("update.download", { size: formatBytes(a.bytes) })}
        </a>
      )}
      {a.kind === "download" && (
        // v2.6 (US-4): the fingerprint is visible, not only a tooltip, so it can be compared with the release page.
        <span data-testid="update-fingerprint" dir="ltr" className="select-all font-mono text-[10px] text-zinc-400" title={`SHA-256 ${a.sha256}`}>
          {t("update.fingerprint", { sha: `${a.sha256.slice(0, 12)}…` })}
        </span>
      )}
      {a.kind === "notice" && (
        <span data-testid="update-hint" className="text-zinc-300">
          {t(a.hint === "ios" ? "update.hintIos" : a.hint === "desktop" ? "update.hintDesktop" : "update.hintAndroidLater")}
        </span>
      )}
      <button type="button" data-testid="update-later" className={btn} onClick={() => void u.dismiss()}>{t("update.later")}</button>
    </div>
  );
}
