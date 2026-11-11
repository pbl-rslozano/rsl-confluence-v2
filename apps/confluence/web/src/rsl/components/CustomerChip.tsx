"use client";

/**
 * Holographic workspace chip (CNR app-bar surface): initials avatar or logo + short name.
 * Glass surface, 1 px cyan→violet border; gradient drift on hover only (reduced motion: off).
 */
import { avatarColor, initials } from "@rsl/core-kit/core/rsl-identity.js";
import { useRsl } from "../RslContext";

export function CustomerChip({ onClick }: { onClick?: () => void }) {
  const { id, t } = useRsl();
  const c = id.customer;
  const label = [c.shortName, c.site].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${t("chip.workspace")}: ${c.legalName}`}
      className="rsl-holo-chip inline-flex h-8 max-w-[11rem] items-center gap-1.5 rounded-full px-2 text-xs"
    >
      {c.logo ? (
        <img src={c.logo} alt="" className="h-5 w-5 rounded-full bg-white object-contain p-0.5" />
      ) : (
        <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold text-white" style={{ background: avatarColor(c.code) }}>
          {initials(c.legalName)}
        </span>
      )}
      <bdi className="truncate">{label}</bdi>
      <span className="sr-only"> — {t("chip.workspace")}: <bdi>{c.legalName}</bdi></span>
    </button>
  );
}
