"use client";

/**
 * Rate sources — v2.7 (plan WP13, owner request 11 Nov 2026).
 *
 * The user picks where display-currency rates come from (automatic chain, one of five tested sources,
 * or their own untested source), updates them on demand, and can verify each source: its publisher,
 * method, coverage, cadence and terms, its website, and the exact address the app reads. A custom
 * source is never contacted by the app (the CSP allows listed hosts only): the user opens it in the
 * browser, saves its rates file and imports it here. To add it to the tested list, the user sends a
 * written request to the developer.
 */
import { useRef, useState } from "react";
import { BRAND } from "@rsl/core-kit/core/rsl-brand.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FX_SOURCES, parseCustomRates, saveCustomTable, verifyUrl, type FxChoice, type FxTable } from "@/lib/fx-rates";
import { normalizeCustomSource } from "@/lib/preferences-store";

type T = (key: string, vars?: Record<string, string | number>) => string;

export function FxSourcesDialog({ open, onOpenChange, t, choice, onChoice, autoUpdate, onAutoUpdate, table, displayCurrency,
  updating, onUpdate, custom, onCustom, onImported }: {
  open: boolean; onOpenChange: (v: boolean) => void; t: T;
  choice: FxChoice; onChoice: (c: FxChoice) => void;
  autoUpdate: boolean; onAutoUpdate: (v: boolean) => void;
  table: FxTable | null; displayCurrency: string;
  updating: boolean; onUpdate: () => void;
  custom: { name: string; url: string } | null; onCustom: (c: { name: string; url: string } | null) => void;
  onImported: (table: FxTable) => void;
}) {
  const [name, setName] = useState(custom?.name ?? "");
  const [url, setUrl] = useState(custom?.url ?? "");
  const [importMsg, setImportMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const code = displayCurrency === "USD" ? "SAR" : displayCurrency;
  const stamp = (ms: number) => new Date(ms).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  const activeId = table?.source;
  const draft = normalizeCustomSource({ name, url });
  const request = `mailto:${BRAND.contactEmail}?subject=${encodeURIComponent("Confluence Terminal — please add an exchange-rate source")}` +
    `&body=${encodeURIComponent(`Please test and add this exchange-rate source to the list:\n\nName: ${draft?.name ?? ""}\nAddress: ${draft?.url ?? ""}\nWhy I use it: \n`)}`;

  async function importFile(file: File) {
    setImportMsg("");
    if (file.size > 2_000_000) { setImportMsg(t("fx.customBad")); return; }
    try {
      const src = draft ?? { name: file.name, url: "" };
      const parsed = parseCustomRates(JSON.parse(await file.text()), src);
      if (!parsed) { setImportMsg(t("fx.customBad")); return; }
      saveCustomTable(parsed);
      onCustom(src);
      onChoice("custom");
      onImported(parsed);
      setImportMsg(t("fx.customImported", { n: Object.keys(parsed.rates).length }));
    } catch {
      setImportMsg(t("fx.customBad"));
    }
  }

  const radio = (value: FxChoice, label: string, extra?: React.ReactNode) => (
    <label className="flex cursor-pointer items-start gap-2 rounded border border-zinc-800 p-2 hover:border-zinc-600">
      <input type="radio" name="fx-source" className="mt-1" checked={choice === value} onChange={() => onChoice(value)} />
      <span className="min-w-0 flex-1">
        <span className="font-medium text-zinc-100">{label}</span>
        {extra}
      </span>
    </label>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="fx-sources" className="max-h-[90dvh] max-w-2xl overflow-y-auto border-zinc-800 bg-zinc-950 text-zinc-200">
        <DialogHeader>
          <DialogTitle>{t("fx.sources")}</DialogTitle>
          <DialogDescription className="text-zinc-400">{t("fx.choose")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-3 rounded border border-zinc-800 bg-zinc-900/60 p-2 text-xs">
          <button type="button" data-testid="fx-update" disabled={updating || choice === "custom"} onClick={onUpdate}
            className="rounded border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-cyan-200 disabled:opacity-50">
            {updating ? t("fx.updating") : t("fx.update")}
          </button>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={autoUpdate} onChange={(e) => onAutoUpdate(e.target.checked)} />
            {t("fx.autoUpdate")}
          </label>
          {table && table.source !== "peg" && (
            <span className="text-zinc-400" data-testid="fx-last">{t("fx.lastFetched", { time: stamp(table.fetchedAt) })}{table.asOf ? ` · ${t("fx.asOf", { date: table.asOf })}` : ""}</span>
          )}
        </div>
        {choice !== "auto" && choice !== "custom" && activeId && activeId !== choice && (
          <p role="status" className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">
            {t("fx.notReached", { source: FX_SOURCES.find((x) => x.id === choice)?.name ?? choice, fallback: t(`fx.src.${activeId}`) })}
          </p>
        )}

        <fieldset className="grid gap-2 text-sm">
          <legend className="sr-only">{t("fx.choose")}</legend>
          {radio("auto", t("fx.auto.src"))}
          {FX_SOURCES.map((x) => radio(x.id, x.name, (
            <span className="mt-1 block space-y-0.5 text-xs text-zinc-400" data-testid={`fx-source-${x.id}`}>
              <span className="block">{x.publisher} · {x.coverage} · {x.cadence}</span>
              <span className="block">{x.method}</span>
              <span className="block text-zinc-500">{x.terms}</span>
              <span className="flex flex-wrap gap-3 pt-0.5">
                <a className="text-cyan-300 underline-offset-2 hover:underline" href={x.homepage} target="_blank" rel="noopener noreferrer">{t("fx.website")}</a>
                <a className="text-cyan-300 underline-offset-2 hover:underline" href={x.dataUrl} target="_blank" rel="noopener noreferrer">{t("fx.rawData")}</a>
                {x.id === "frankfurter" && (
                  <a className="text-cyan-300 underline-offset-2 hover:underline" href={verifyUrl("frankfurter", code)} target="_blank" rel="noopener noreferrer">{t("fx.verify")} ({code})</a>
                )}
                {activeId === x.id && <span className="rounded border border-emerald-500/40 px-1 text-emerald-300">✓ {t("fx.inUse")}</span>}
              </span>
              <span className="block break-all font-mono text-[10px] text-zinc-600">{x.dataUrl}</span>
            </span>
          )))}
          {radio("custom", t("fx.custom"), (
            <span className="mt-1 block space-y-2 text-xs text-zinc-400">
              <span role="note" data-testid="fx-custom-notice" className="block rounded border border-amber-500/40 bg-amber-500/10 p-2 text-amber-200">
                ⚠ {t("fx.customNotice")}
              </span>
              <span className="block text-zinc-500">{t("fx.customWhy")}</span>
              <span className="grid gap-2 sm:grid-cols-2">
                <input aria-label={t("fx.customName")} placeholder={t("fx.customName")} value={name} maxLength={80}
                  onChange={(e) => setName(e.target.value)} onBlur={() => onCustom(normalizeCustomSource({ name, url }))}
                  className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100" />
                <input aria-label={t("fx.customUrl")} placeholder="https://…" value={url} maxLength={500} inputMode="url"
                  onChange={(e) => setUrl(e.target.value)} onBlur={() => onCustom(normalizeCustomSource({ name, url }))}
                  className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-zinc-100" />
              </span>
              <span className="flex flex-wrap items-center gap-3">
                {draft?.url && <a className="text-cyan-300 underline-offset-2 hover:underline" href={draft.url} target="_blank" rel="noopener noreferrer">{t("fx.rawData")}</a>}
                <button type="button" className="rounded border border-zinc-600 px-2 py-1 text-zinc-200" onClick={() => fileRef.current?.click()}>{t("fx.customImport")}</button>
                <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" data-testid="fx-custom-file"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ""; }} />
                <a className="text-cyan-300 underline-offset-2 hover:underline" href={request} data-testid="fx-custom-request">✉ {t("fx.customRequest")}</a>
              </span>
              {importMsg && <span role="status" className="block text-zinc-300">{importMsg}</span>}
              {table?.source === "custom" && table.custom && (
                <span className="block text-zinc-400">{t("fx.src.custom")}: {table.custom.name}{table.custom.url ? ` · ${table.custom.url}` : ""}</span>
              )}
            </span>
          ))}
        </fieldset>
        <p className="text-[11px] text-zinc-500">{t("fx.displayOnly")}</p>
      </DialogContent>
    </Dialog>
  );
}
