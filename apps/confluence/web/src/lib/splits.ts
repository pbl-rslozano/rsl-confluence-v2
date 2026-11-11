/**
 * splits.ts — v2.3 stock-split detection, shared by scoring (signal mute) and
 * outcome measurement (an outcome whose holding window spans a split is not
 * measured: a 2:1 split is not a −50 % trade).
 *
 * A bar-to-bar close ratio within 2 % of a common split ratio (or its inverse)
 * is treated as a corporate action. Genuine ±50 %/+100 % moves on a tokenised
 * stock are rare enough that muting them is the conservative choice.
 */
import type { Kline } from "./indicators";

export const SPLIT_RATIOS = [1.5, 2, 3, 4, 5, 8, 10, 15, 20, 25, 30, 50];

export function isSplitRatio(a: number, b: number): boolean {
  if (!(a > 0) || !(b > 0)) return false;
  const r = a > b ? a / b : b / a;
  if (r < 1.45) return false;
  return SPLIT_RATIOS.some((x) => Math.abs(r - x) / x < 0.02);
}

/** True when any adjacent pair of closes in `k` looks like a split. */
export function detectSplit(k: Kline[]): boolean {
  for (let i = 1; i < k.length; i++) if (isSplitRatio(k[i - 1].close, k[i].close)) return true;
  return false;
}
