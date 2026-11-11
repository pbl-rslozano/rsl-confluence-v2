"use client";

/** Status line: storage (save) state · online/offline · Powered-by stamp · credit (identity skill §4.1). */
import { poweredBy } from "@rsl/core-kit/core/rsl-brand.js";
import { APP } from "../app-info";
import { useRsl } from "../RslContext";

export function StatusFooter({ children }: { children?: React.ReactNode }) {
  const { t, port, online } = useRsl();
  return (
    // v2.5 (restores v2.3.1): on phones the items flow into short, unwrapped lines (status, legend,
    // stamp, credit last) instead of squeezing into a tall two-column block.
    <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1 text-[10px] leading-tight text-zinc-400 sm:justify-between">
      <span className="flex min-w-0 basis-full items-center gap-1.5 sm:flex-1 sm:basis-auto">
        <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${online ? "bg-emerald-500" : "bg-amber-500"}`} />
        <span className="whitespace-nowrap">{online ? t("status.online") : t("status.offline")}</span>
        <span className="text-zinc-600">·</span>
        <span className={`whitespace-nowrap ${port.durable ? "" : "text-amber-300"}`}>{t("status.storage", { kind: port.kind })}</span>
        <span className="text-zinc-600">·</span>
        <span className="truncate" title={t("status.disclaimer")}>{t("status.disclaimer")}</span>
      </span>
      <span className="contents sm:flex sm:items-center sm:gap-3">
        {children}
        <span dir="ltr" className="min-w-0 font-mono tracking-tight sm:whitespace-nowrap sm:tracking-normal">{poweredBy({ name: APP.name, version: APP.version, year: APP.year, build: APP.build })}</span>
        <span dir="ltr" className="ms-auto whitespace-nowrap sm:ms-0">{APP.credit}</span>
      </span>
    </div>
  );
}
