/**
 * fvg.ts — Fair Value Gap (FVG / imbalance) detector for the Confluence Terminal.
 *
 * DESIGN CONTRACT (matches the engine in indicators.ts):
 *  - CLOSED-BAR ONLY. The final, possibly-open bar is excluded unless the caller
 *    asserts it is closed (`lastBarClosed: true`). A gap formed on closed bars never
 *    disappears or moves retroactively — only its mitigation advances forward. No repainting.
 *  - NON-DIRECTIONAL. An FVG is a level/zone (a magnet), not a BULLISH/BEARISH vote.
 *    This module casts no vote into the bloc aggregation. It returns a bounded CONFIDENCE
 *    modifier (a multiplier near 1.0) plus zone data.
 *  - BOUNDED. The modifier is clamped to [minModifier, maxModifier] (default ±15%), so it
 *    can never flip the master direction or dominate the vote-based score.
 *
 * Bullish FVG (gap up) on window i-2,i-1,i:  low[i] > high[i-2]; zone = [high[i-2], low[i]].
 * Bearish FVG (gap down):                     high[i] < low[i-2]; zone = [high[i], low[i-2]].
 *
 * This is a 1:1 TypeScript port of the reference implementation validated by a
 * 21-assertion regression suite.
 *
 * v2.8 (WP19): a gap counts only when it is at least `minGapAtr` (0.5) × ATR(14)
 * measured at the middle candle of the three-bar window. A fixed 0.05 % floor
 * let ordinary bar-to-bar noise register as "imbalance" on volatile assets;
 * `minGapPct` stays as an optional absolute floor (default 0). The modifier is
 * still an unvalidated adjustment — the UI labels it so.
 */

/** Minimal OHLC candle. Structurally compatible with indicators.ts `Kline`. */
export interface FvgCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type FvgType = "bull" | "bear";

export interface FvgZone {
  type: FvgType;
  top: number;
  bottom: number;
  size: number;
  sizePct: number;
  createdIndex: number;
  createdTime: number;
  /** 0 = untouched, 1 = fully filled. */
  mitigation: number;
  filled: boolean;
}

export interface FvgOptions {
  /** Treat the final candle as closed (default false → excluded, anti-repaint). */
  lastBarClosed?: boolean;
  /** Optional absolute floor: ignore gaps smaller than this fraction of price (default 0 — off; v2.7: 0.05%). */
  minGapPct?: number;
  /**
   * v2.8: ignore gaps smaller than this multiple of ATR(14) at the middle candle
   * (default 0.5; 0 turns the ATR minimum off). ATR here is this module's own
   * definition — the mean true range of the last 14 bars up to and including the
   * middle candle (fewer at the very start of a series), the same ATR the magnet
   * distance uses — so fvg.ts stays dependency-free.
   */
  minGapAtr?: number;
  /** Cap on active zones returned (most recent kept). */
  maxZones?: number;
  minModifier?: number;
  maxModifier?: number;
  supportBoost?: number;
  magnetDamp?: number;
  nearZoneAtrMult?: number;
}

export const FVG_DEFAULTS: Required<FvgOptions> = {
  lastBarClosed: false,
  minGapPct: 0,
  minGapAtr: 0.5,
  maxZones: 24,
  minModifier: 0.85,
  maxModifier: 1.15,
  supportBoost: 0.12,
  magnetDamp: 0.12,
  // Distance (in ATRs) at which an opposing gap ahead of price counts as a
  // magnet. Build 2.01 shipped 0.25 but compared against max(0.25·ATR, ATR),
  // so the option was dead and the effective threshold was always 1 ATR.
  // Build 2.02 makes the option live and sets the default to 1.0 so behaviour
  // is unchanged.
  nearZoneAtrMult: 1.0,
};

function cfg(opts?: FvgOptions): Required<FvgOptions> {
  return { ...FVG_DEFAULTS, ...(opts ?? {}) };
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function closedSlice<T>(candles: T[], lastBarClosed: boolean): T[] {
  if (lastBarClosed) return candles;
  return candles.length ? candles.slice(0, candles.length - 1) : candles;
}

function atr(candles: FvgCandle[], period = 14): number {
  const n = candles.length;
  if (n < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const w = trs.slice(-period);
  if (!w.length) return 0;
  return w.reduce((a, b) => a + b, 0) / w.length;
}

function mkZone(
  type: FvgType,
  top: number,
  bottom: number,
  size: number,
  sizePct: number,
  createdIndex: number,
  createdTime: number,
): FvgZone {
  return { type, top, bottom, size, sizePct, createdIndex, createdTime, mitigation: 0, filled: false };
}

function advanceMitigation(zone: FvgZone, view: FvgCandle[]): void {
  let deepest = 0;
  for (let j = zone.createdIndex + 1; j < view.length; j++) {
    const b = view[j];
    let pen = 0;
    if (zone.type === "bull") {
      if (b.low <= zone.bottom) pen = 1;
      else if (b.low < zone.top) pen = (zone.top - b.low) / zone.size;
    } else {
      if (b.high >= zone.top) pen = 1;
      else if (b.high > zone.bottom) pen = (b.high - zone.bottom) / zone.size;
    }
    if (pen > deepest) deepest = pen;
    if (deepest >= 1) break;
  }
  zone.mitigation = clamp(deepest, 0, 1);
  zone.filled = zone.mitigation >= 1;
}

export interface FvgDetection {
  active: FvgZone[];
  all: FvgZone[];
  lastClosedIndex: number;
}

export function detectFVG(candles: FvgCandle[], opts?: FvgOptions): FvgDetection {
  const o = cfg(opts);
  const view = closedSlice(candles, o.lastBarClosed);
  const n = view.length;
  const out: FvgDetection = { active: [], all: [], lastClosedIndex: n - 1 };
  if (n < 3) return out;

  // Prefix sums of true range (tr[j] for j ≥ 1) → ATR(14) at any bar in O(1).
  const period = 14;
  const trSum = new Float64Array(n);
  for (let j = 1; j < n; j++) {
    const b = view[j];
    const p = view[j - 1];
    const tr = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
    trSum[j] = trSum[j - 1] + tr;
  }
  const atrAt = (j: number): number => {
    const from = Math.max(1, j - period + 1);
    return (trSum[j] - trSum[from - 1]) / (j - from + 1);
  };

  const zones: FvgZone[] = [];
  for (let i = 2; i < n; i++) {
    const c0 = view[i - 2];
    const c2 = view[i];
    const mid = (c2.high + c2.low) / 2 || 1;
    const minSize = o.minGapAtr > 0 ? o.minGapAtr * atrAt(i - 1) : 0;
    if (c2.low > c0.high) {
      const top = c2.low;
      const bot = c0.high;
      const size = top - bot;
      if (size / mid >= o.minGapPct && size >= minSize) zones.push(mkZone("bull", top, bot, size, size / mid, i, c2.time));
    }
    if (c2.high < c0.low) {
      const btop = c0.low;
      const bbot = c2.high;
      const bsize = btop - bbot;
      if (bsize / mid >= o.minGapPct && bsize >= minSize) zones.push(mkZone("bear", btop, bbot, bsize, bsize / mid, i, c2.time));
    }
  }

  for (const z of zones) advanceMitigation(z, view);

  out.all = zones.slice();
  let active = zones.filter((z) => !z.filled);
  if (active.length > o.maxZones) active = active.slice(active.length - o.maxZones);
  out.active = active;
  return out;
}

export type CompositeDirection = "buy" | "sell" | "neutral";

export interface FvgModifierResult {
  /** Multiplier in [minModifier, maxModifier]; apply as confidence * modifier. */
  modifier: number;
  reason: string;
  zones: FvgZone[];
  priceInZone: FvgZone | null;
}

/**
 * Non-directional confidence modifier. Scales confidence only; clamped so it can
 * never exceed ±(maxModifier−1). Never returns a direction of its own.
 */
export function fvgModifier(
  candles: FvgCandle[],
  direction: CompositeDirection,
  price?: number,
  opts?: FvgOptions,
): FvgModifierResult {
  const o = cfg(opts);
  const det = detectFVG(candles, o);
  const view = closedSlice(candles, o.lastBarClosed);
  const px = price != null ? price : view.length ? view[view.length - 1].close : null;
  const res: FvgModifierResult = {
    modifier: 1,
    reason: "no relevant gap near price",
    zones: det.active,
    priceInZone: null,
  };
  if (px == null || !det.active.length) return res;

  const a = atr(view, 14);
  const near = a * o.nearZoneAtrMult;

  let inZone: FvgZone | null = null;
  for (let i = det.active.length - 1; i >= 0; i--) {
    const z = det.active[i];
    if (px <= z.top && px >= z.bottom) {
      inZone = z;
      break;
    }
  }
  res.priceInZone = inZone;

  let adj = 0;
  let reason = res.reason;

  if (inZone) {
    const fresh = 1 - inZone.mitigation;
    if ((direction === "buy" && inZone.type === "bull") || (direction === "sell" && inZone.type === "bear")) {
      adj += o.supportBoost * fresh;
      reason = `price resting in a fresh ${inZone.type} gap aligned with ${direction} — supportive`;
    } else if ((direction === "buy" && inZone.type === "bear") || (direction === "sell" && inZone.type === "bull")) {
      adj -= o.magnetDamp * fresh;
      reason = `price inside an opposing ${inZone.type} gap — signal faces overhead/underfoot supply`;
    } else {
      reason = `price inside a ${inZone.type} gap; composite neutral`;
    }
  } else if (direction === "buy" || direction === "sell") {
    let magnet: FvgZone | null = null;
    for (const g of det.active) {
      const edge = direction === "buy" ? g.bottom : g.top;
      const ahead = direction === "buy" ? g.bottom > px : g.top < px;
      const isOpposing = (direction === "buy" && g.type === "bear") || (direction === "sell" && g.type === "bull");
      if (ahead && isOpposing && Math.abs(edge - px) <= near) {
        magnet = g;
        break;
      }
    }
    if (magnet) {
      adj -= o.magnetDamp * (1 - magnet.mitigation) * 0.6;
      reason = `unfilled opposing ${magnet.type} gap just ahead — mild magnet against ${direction}`;
    }
  }

  res.modifier = clamp(1 + adj, o.minModifier, o.maxModifier);
  res.reason = reason;
  return res;
}
