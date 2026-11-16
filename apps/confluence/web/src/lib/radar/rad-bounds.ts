/**
 * rad-bounds.ts — v2.8 (WP25 fix wave): the ONE set of ranges for the ledger `rad` fields.
 * The producers (toRadarContext, normalizeContext: app and recorder) null any value outside them, and the ledger sanitiser
 * (strictRad) rejects the row for any value outside them, so what the app writes can always be imported back.
 */
import { OI_CHG_MAX, OI_CHG_MIN } from "../derivatives-context";

export type RadNumericKey = "frp" | "oi24" | "ls" | "tk" | "usP" | "krP" | "phP";

/** Inclusive [min, max] per field: frp 0-100, oi24 −100…10,000, ls 0-100, tk 0-1, premiums −50…50. */
export const RAD_BOUNDS: Record<RadNumericKey, readonly [number, number]> = {
  frp: [0, 100],
  oi24: [OI_CHG_MIN, OI_CHG_MAX],
  ls: [0, 100],
  tk: [0, 1],
  usP: [-50, 50],
  krP: [-50, 50],
  phP: [-50, 50],
};

/** The value when it is a finite number inside the field's range, else null. */
export function radRanged(key: RadNumericKey, v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const [lo, hi] = RAD_BOUNDS[key];
  return v >= lo && v <= hi ? v : null;
}
