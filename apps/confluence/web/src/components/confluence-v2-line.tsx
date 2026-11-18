"use client";

import { v2LineModel, type V2Result } from "@/lib/confluence-v2";

type T = (key: string, vars?: Record<string, string | number>) => string;

/**
 * v2.8 (WP23): the optional "Confluence v2 (test)" line in the detail sheet. Shown only when the
 * user turns the setting on; a challenger recorded for comparison, never part of the list, signals,
 * alerts or paper trades.
 */
export function ConfluenceV2Line({ r, t }: { r: V2Result | null | undefined; t: T }) {
  const model = v2LineModel(r);
  const label = model.master === "NEUTRAL" || model.strength === "WEAK"
    ? t("sig.neutral")
    : `${t(model.master === "BULLISH" ? "sig.buy" : "sig.sell")} · ${t(model.strength === "STRONG" ? "sig.strong" : "sig.moderate")}`;
  return (
    <div data-testid="confluence-v2-line" className="text-[11px] text-zinc-400">
      <p>{t(model.key, { label, score: model.vars.score, exit: model.vars.exit })}</p>
      <p>{t("v2.lineNote")}</p>
    </div>
  );
}
