"use client";

import { useState } from "react";
import { VOTING_INDICATORS, normalizeScoringProfile, type ScoringProfile, type VotingIndicatorId } from "@/lib/scoring-profile";
import { LIQUIDITY_FLOOR_CHOICES } from "@/lib/market-client";
import { floorLabel } from "@/lib/scan-pipeline";

type T = (key: string, vars?: Record<string, string | number>) => string;

export function ScoringProfileEditor({ profile, configId, onApply, disabled, liquidityFloorUsd, onLiquidityFloor, t }: {
  profile: ScoringProfile | null;
  configId: string;
  onApply: (profile: ScoringProfile | null) => Promise<void>;
  disabled: boolean;
  /** v2.8 (WP19): crypto liquidity floor (US$ of 24 h quote volume; 0 = off) — a scan setting, applied on the next scan. */
  liquidityFloorUsd: number;
  onLiquidityFloor: (usd: number) => void;
  t: T;
}) {
  const floorChoices = [...new Set<number>([...LIQUIDITY_FLOOR_CHOICES, liquidityFloorUsd])].sort((a, b) => a - b);
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState<VotingIndicatorId[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const draft = () => normalizeScoringProfile({ version: 1, enabled });

  async function apply() {
    setBusy(true);
    try {
      await onApply(draft());
      setMessage("Scoring profile applied.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Profile could not be applied.");
    } finally {
      setBusy(false);
    }
  }

  function exportProfile() {
    const value = draft() ?? { version: 1, enabled: VOTING_INDICATORS.map((indicator) => indicator.id) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "scoring-profile.json";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="relative">
      <button type="button" disabled={disabled} aria-expanded={open}
        className="h-8 rounded border border-zinc-700 px-2 text-xs"
        onClick={() => {
          if (!open) {
            setEnabled(profile?.enabled ?? VOTING_INDICATORS.map((indicator) => indicator.id));
            setMessage("");
          }
          setOpen(!open);
        }}>Scoring profile · {profile ? "Custom" : "Default"}</button>
      {open && (
        <section aria-label="Scoring profile editor" className="absolute start-0 top-full z-30 mt-1 grid w-72 gap-2 rounded border border-zinc-700 bg-zinc-900 p-3 text-xs">
          <p>Active engine <code>{configId}</code></p>
          <label className="grid gap-1" title={t("liq.help")}>
            <span>{t("liq.floor")}</span>
            <select data-testid="liquidity-floor" value={String(liquidityFloorUsd)} disabled={disabled}
              className="h-7 rounded border border-zinc-700 bg-zinc-900 px-1"
              onChange={(event) => onLiquidityFloor(Number(event.target.value))}>
              {floorChoices.map((usd) => <option key={usd} value={String(usd)}>{usd > 0 ? floorLabel(usd) : t("liq.off")}</option>)}
            </select>
          </label>
          <fieldset disabled={busy} className="grid max-h-64 gap-1 overflow-auto">
            <legend>Indicator votes</legend>
            {VOTING_INDICATORS.map((indicator) => <label key={indicator.id} className="flex items-center gap-2">
              <input type="checkbox" checked={enabled.includes(indicator.id)} onChange={(event) => {
                setEnabled(event.target.checked ? [...enabled, indicator.id] : enabled.filter((id) => id !== indicator.id));
              }} />{indicator.name}
            </label>)}
          </fieldset>
          {!enabled.length && <p role="status">No enabled votes. Signals will be suppressed.</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => void apply()}>Apply scoring profile</button>
            <button type="button" disabled={busy} onClick={() => setEnabled(VOTING_INDICATORS.map((indicator) => indicator.id))}>Reset scoring draft</button>
            <button type="button" disabled={busy} onClick={exportProfile}>Export scoring profile</button>
          </div>
          <label>Import scoring profile
            <input type="file" accept=".json,application/json" disabled={busy} className="w-full" onChange={async (event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (!file) return;
              try {
                if (file.size > 16_384) throw new Error("Profile is too large.");
                const imported = normalizeScoringProfile(JSON.parse(await file.text()));
                setEnabled(imported?.enabled ?? VOTING_INDICATORS.map((indicator) => indicator.id));
                setMessage("Profile loaded into the draft.");
              } catch (error) { setMessage(error instanceof Error ? error.message : "Invalid scoring profile."); }
            }} />
          </label>
          {message && <p role="status">{message}</p>}
        </section>
      )}
    </div>
  );
}
