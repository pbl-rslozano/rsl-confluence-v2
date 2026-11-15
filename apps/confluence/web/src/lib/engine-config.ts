/**
 * engine-config.ts — v2.1.1
 * ----------------------------------------------------------------------------
 * Identity of the scoring engine, stamped on every recorded signal.
 *
 * Build 2.02 changed the engine in place, so no recorded baseline could be
 * compared with what came after. From v2.1.1 every ledger row carries
 * `configId`, a 16-hex hash of:
 *
 *   1. ENGINE_VERSION and the published parameters below, and
 *   2. a BEHAVIOUR FINGERPRINT — the engine's full output on a fixed,
 *      deterministic test series.
 *
 * (2) means a code change that alters any indicator, band or weight changes the
 * configId even if nobody remembers to bump the version, so signals scored by
 * different engines can never be pooled by accident. A regression test pins the
 * current configId; changing the engine on purpose means updating that pin.
 *
 * Pure module: no DOM, no storage — shared by the app, the scan worker and the
 * Node replay/backtest script.
 * ----------------------------------------------------------------------------
 */
import { normalizeScoringProfile, type ScoringProfile } from "./scoring-profile";
import {
  runConfluence,
  NEUTRAL_BAND,
  STRONG_BAND,
  MIN_VALID_VOTING_SHARE,
  LOW_VOLATILITY_PERCENTILE,
  ER_PERIOD,
  ER_GATE_LOW,
  ER_GATE_HIGH,
  INDICATORS,
  type Kline,
} from "./indicators";
import { detectReversal } from "./reversal";
import { PATTERN_PARAMS } from "./pattern-signal";
import { FVG_DEFAULTS } from "./fvg";

/** Bump when the engine is changed on purpose (and update the pinned configId test). */
export const ENGINE_VERSION = "2.4.0"; // v2.8 (WP19): Pattern Wilson gate, FVG 0.5 × ATR(14) minimum

export { ENGINE_BARS, MIN_ENGINE_BARS } from "./engine-window";
import { ENGINE_BARS, MIN_ENGINE_BARS } from "./engine-window";
import { scoreSeries } from "./scan-pipeline";

export const ENGINE_PARAMS = {
  version: ENGINE_VERSION,
  engineBars: ENGINE_BARS,
  minEngineBars: MIN_ENGINE_BARS,
  neutralBand: NEUTRAL_BAND,
  strongBand: STRONG_BAND,
  minValidVotingShare: MIN_VALID_VOTING_SHARE,
  lowVolatilityPercentile: LOW_VOLATILITY_PERCENTILE,
  erPeriod: ER_PERIOD,
  erGate: [ER_GATE_LOW, ER_GATE_HIGH],
  // Indicator count only: function NAMES are minified in production bundles, so
  // hashing them made the browser and Node disagree on the configId. The
  // behaviour fingerprint below already covers every indicator's output.
  indicatorCount: INDICATORS.length,
  // v2.8 (engine 2.4.0): the historical-analogue gate and the FVG minimum are
  // engine parameters too. Pattern output is not part of the behaviour
  // fingerprint (the fingerprint covers the scored indicators; since WP19 the
  // ledger does record the Pattern call as pd/pc), so its rule is hashed explicitly.
  pattern: PATTERN_PARAMS,
  fvg: { minGapPct: FVG_DEFAULTS.minGapPct, minGapAtr: FVG_DEFAULTS.minGapAtr },
} as const;

/* ---------------------------------------------------------------------------
 * Hashing — synchronous 64-bit FNV-1a (two 32-bit lanes). Not cryptographic;
 * it only has to tell engine configurations apart. Works in insecure contexts
 * (http LAN) and in Node without crypto.subtle.
 * ------------------------------------------------------------------------- */
export function hash64(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x050c5d1f;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c ^ (i & 0xff), 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** Deterministic JSON with sorted keys (numbers rounded to 8 significant digits). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") return Number.isFinite(value) ? String(Number(value.toPrecision(8))) : "null";
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * Fixed test series: 1,100 hourly bars of a seeded walk with a trend leg and a
 * range. Built with + − × ÷ only (no Math.exp): those are exactly rounded by
 * IEEE-754 in every JavaScript engine, so V8 (Chrome, Node, Android WebView)
 * and JavaScriptCore (Safari, WKWebView on macOS/iOS) produce identical bars
 * and therefore the same configId. The engine itself uses only arithmetic and
 * Math.sqrt (also exactly rounded).
 */
export function fingerprintSeries(): Kline[] {
  let seed = 20261031;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const out: Kline[] = [];
  let px = 100;
  const t0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 1100; i++) {
    const drift = i < 250 ? 0.0012 : i < 400 ? -0.0015 : i < 800 ? 0.0004 : -0.0006;
    const o = px;
    px *= 1 + drift + (rnd() - 0.5) * 0.02;
    const hi = Math.max(o, px) * (1 + rnd() * 0.004);
    const lo = Math.min(o, px) * (1 - rnd() * 0.004);
    out.push({ time: t0 + i * 3_600_000, open: o, high: hi, low: lo, close: px, volume: 1000 + Math.round(rnd() * 900) });
  }
  return out;
}

/** The engine's observable behaviour on the fixed series, at several cut points. */
const DAY_MS_FP = 86_400_000;
export function behaviourFingerprint(): string {
  const series = fingerprintSeries();
  const cuts = [120, 260, 410, 600];
  const snapshot = cuts.map((n) => {
    const k = series.slice(0, n);
    const c = runConfluence(k, { volumeAvailable: true, intervalMs: 3_600_000 });
    const r = detectReversal(k);
    return {
      n,
      score: c.score,
      master: c.master,
      strength: c.strength,
      blocs: c.blocs.map((b) => [b.bloc, b.score, b.weight]),
      ind: c.indicators.map((i) => [i.name, i.state, i.valid, i.value]),
      rev: [r.direction, r.confidence, r.score],
    };
  });
  // v2.2 review fix: also run the production scoring path, so the fixed window
  // (series longer than ENGINE_BARS), the FX profile and volume detection are
  // part of the engine identity.
  const zeroVolume = series.map((b) => ({ ...b, volume: 0 }));
  const pipeline = [
    scoreSeries(series, { intervalMs: 3_600_000, volumeAvailable: true }),
    scoreSeries(series, { intervalMs: 3_600_000, volumeAvailable: true, assetClass: "fx" }),
    scoreSeries(zeroVolume, { intervalMs: 3_600_000, volumeAvailable: true }),
    // v2.3: regular-session filter and split guard for stocks.
    scoreSeries(series, { intervalMs: 3_600_000, volumeAvailable: true, assetClass: "stock" }),
    scoreSeries(series.map((b, i) => (i < 900 ? b : { ...b, open: b.open / 2, high: b.high / 2, low: b.low / 2, close: b.close / 2 })), { intervalMs: DAY_MS_FP, volumeAvailable: true, assetClass: "stock" }),
  ].map((s) => ({
    usable: s.usable,
    warm: s.warmBars,
    score: s.confluence.score,
    strength: s.confluence.strength,
    valid: s.confluence.validCount,
    lv: s.confluence.lowVolatility,
    sf: !!s.sessionFiltered,
    split: !!s.split,
  }));
  return hash64(stableStringify({ snapshot, pipeline }));
}

let cachedId: string | null = null;

/** 16-hex identifier of this engine build (computed once, ~5 ms). */
export function engineConfigId(profile?: ScoringProfile | null): string {
  const custom = normalizeScoringProfile(profile);
  if (custom) return hash64(stableStringify({ base: engineConfigId(), profile: custom }));
  if (cachedId) return cachedId;
  cachedId = hash64(stableStringify({ params: ENGINE_PARAMS, behaviour: behaviourFingerprint() }));
  return cachedId;
}
