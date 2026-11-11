"use client";

/** Skippable 3-step first-run capture (≈30 s): language → workspace → your name. Identity skill §3.2. */
import { useState } from "react";
import type { Identity } from "@rsl/core-kit/core/rsl-identity.js";
import { useRsl } from "../RslContext";
import { BrandBlock } from "./BrandBlock";
import { IdentityForm } from "./IdentityForm";
import { LanguageMenu } from "./LanguageMenu";

export function FirstRunWizard({ onDone }: { onDone: () => void }) {
  const { t, id, setIdentity } = useRsl();
  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState<Identity>(id);
  const [errors, setErrors] = useState<string[]>([]);
  const TOTAL = 3;
  const titles = ["wiz.lang", "wiz.workspace", "wiz.operator"];

  const finish = async () => {
    const r = await setIdentity({ ...draft, operator: { ...draft.operator, id: draft.operator.id || `op-${crypto.randomUUID().slice(0, 8)}` } });
    if (!r.ok) { setErrors(r.errors); setStep(2); return; }
    onDone();
  };

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-zinc-950 p-4 text-zinc-100">
      <section aria-labelledby="wiz-title" className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <BrandBlock />
          <span className="text-xs text-zinc-500">{t("wiz.step", { n: step, total: TOTAL })}</span>
        </div>
        <h1 id="wiz-title" className="text-lg font-semibold">{t("wiz.title")}</h1>
        <h2 className="mb-3 mt-1 text-sm text-zinc-400">{t(titles[step - 1])}</h2>
        <ol className="mb-4 flex gap-1" aria-hidden="true">
          {[1, 2, 3].map((n) => <li key={n} className={`h-1 flex-1 rounded ${n <= step ? "bg-gradient-to-r from-[#0755F5] to-[#7524F4]" : "bg-zinc-800"}`} />)}
        </ol>

        {step === 1 && <LanguageMenu inline onPicked={() => undefined} />}
        {step === 2 && (
          <>
            <p className="mb-3 text-xs text-zinc-500">{t("wiz.workspaceHint")}</p>
            <IdentityForm draft={draft} onChange={setDraft} show="workspace" />
          </>
        )}
        {step === 3 && <IdentityForm draft={draft} onChange={setDraft} show="operator" />}
        {errors.length > 0 && <ul role="alert" className="mt-3 list-disc ps-5 text-xs text-rose-300">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}

        <div className="mt-5 flex items-center justify-between gap-2">
          <button type="button" onClick={onDone} className="h-11 rounded-md px-3 text-sm text-zinc-400 hover:text-zinc-200">{t("wiz.skip")}</button>
          <div className="flex gap-2">
            {step > 1 && <button type="button" onClick={() => setStep(step - 1)} className="h-11 rounded-md border border-zinc-700 px-4 text-sm">{t("wiz.back")}</button>}
            {step < TOTAL
              ? <button type="button" onClick={() => setStep(step + 1)} className="h-11 rounded-md bg-gradient-to-r from-[#0755F5] to-[#7524F4] px-5 text-sm font-semibold text-white">{t("wiz.next")}</button>
              : <button type="button" onClick={() => void finish()} className="h-11 rounded-md bg-gradient-to-r from-[#0755F5] to-[#7524F4] px-5 text-sm font-semibold text-white">{t("wiz.finish")}</button>}
          </div>
        </div>
      </section>
    </div>
  );
}
