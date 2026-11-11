"use client";

/**
 * Workspace identity fields (shared by the first-run wizard and About → Edit identity).
 * Validation is the kit's validateIdentity(); logos must pass isSafeLogo().
 */
import { useState } from "react";
import { isSafeLogo, avatarColor, initials, type Identity } from "@rsl/core-kit/core/rsl-identity.js";
import { useRsl } from "../RslContext";

export function IdentityForm({ draft, onChange, show }: { draft: Identity; onChange: (d: Identity) => void; show: "workspace" | "operator" | "both" }) {
  const { t } = useRsl();
  const [logoError, setLogoError] = useState(false);
  const c = draft.customer;
  const set = (patch: Partial<Identity["customer"]>) => onChange({ ...draft, customer: { ...c, ...patch } });
  const field = "h-11 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100";
  const codeOk = /^[A-Z]{2,6}$/.test(c.code);

  const onLogo = async (file: File | undefined) => {
    setLogoError(false);
    if (!file) return;
    if (file.size > 300_000) { setLogoError(true); return; }
    const uri = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file); });
    if (!isSafeLogo(uri)) { setLogoError(true); return; }
    set({ logo: uri });
  };

  return (
    <div className="space-y-4">
      {(show === "workspace" || show === "both") && (
        <>
          <label className="block space-y-1 text-sm">
            <span className="text-zinc-300">{t("wiz.legalName")} <span className="text-xs text-zinc-500">({t("wiz.required")})</span></span>
            <input className={field} value={c.legalName} maxLength={120} required onChange={(e) => set({ legalName: e.target.value })} />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1 text-sm">
              <span className="text-zinc-300">{t("wiz.shortName")}</span>
              <input className={field} value={c.shortName} maxLength={24} onChange={(e) => set({ shortName: e.target.value })} />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="text-zinc-300">{t("wiz.code")}</span>
              <input
                className={`${field} font-mono uppercase`}
                value={c.code}
                maxLength={6}
                aria-invalid={!codeOk}
                dir="ltr"
                onChange={(e) => set({ code: e.target.value.toUpperCase().replace(/[^A-Z]/g, "") })}
              />
            </label>
          </div>
          <label className="block space-y-1 text-sm">
            <span className="text-zinc-300">{t("wiz.logo")}</span>
            <input type="file" accept="image/png,image/jpeg,image/svg+xml" onChange={(e) => void onLogo(e.target.files?.[0])} className="block w-full text-xs text-zinc-400 file:me-3 file:h-9 file:rounded-md file:border-0 file:bg-zinc-800 file:px-3 file:text-zinc-200" />
            {logoError && <span role="alert" className="text-xs text-rose-300">{t("wiz.logoBad")}</span>}
          </label>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
            <div className="mb-2 text-[11px] uppercase tracking-wider text-zinc-500">{t("wiz.preview")}</div>
            <div className="flex items-center gap-3">
              {c.logo
                ?
                  <img src={c.logo} alt="" className="h-10 w-10 rounded-md bg-white object-contain p-1" />
                : <span className="flex h-10 w-10 items-center justify-center rounded-full text-sm font-bold text-white" style={{ background: avatarColor(c.code || "XX") }}>{initials(c.legalName || "?")}</span>}
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-zinc-100" title={c.legalName}><bdi>{c.legalName || "—"}</bdi></div>
                <div className="font-mono text-xs text-zinc-500" dir="ltr">{c.shortName || "—"} · {c.code || "—"}</div>
              </div>
            </div>
          </div>
        </>
      )}
      {(show === "operator" || show === "both") && (
        <label className="block space-y-1 text-sm">
          <span className="text-zinc-300">{t("wiz.displayName")}</span>
          <input className={field} value={draft.operator.displayName} maxLength={60} onChange={(e) => onChange({ ...draft, operator: { ...draft.operator, displayName: e.target.value } })} />
        </label>
      )}
    </div>
  );
}
