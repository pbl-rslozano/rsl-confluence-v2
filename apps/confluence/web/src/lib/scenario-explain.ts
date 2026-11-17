/**
 * scenario-explain.ts — v2.8 (WP22) rule-based explanation and sheet notes.
 *
 * Pure module: no I/O, no clock, no free text. Every sentence is an i18n key with parameters (18 languages);
 * the panel translates the keys. Numbers, labels and event names enter `vars` already formatted by the caller's
 * `fmt`. "Possible scenarios from past data — not a forecast."
 */
import type { BlocName, ConfluenceResult, Kline } from "./indicators";
import { ENGINE_BARS } from "./engine-window";
import { MACRO_EVENTS, type MacroEvent } from "./macro-calendar";
import { barClose, volRegime, SC_MIN_NEFF, type FtState, type ScenarioResult } from "./scenarios";

export { volRegime };

export interface ExplainPart { key: string; vars?: Record<string, string | number> }

/** Swing lookback for the invalidation level, in bars. */
const SWING = 20;

export const EXPLAIN_KEYS: readonly string[] = [
  "sc.x.trend.up", "sc.x.trend.down", "sc.x.trend.flat", "sc.x.trend.none",
  "sc.x.conf.agree", "sc.x.conf.bloc", "sc.x.conf.neutral",
  "sc.bloc.trend", "sc.bloc.meanReversion", "sc.bloc.breakout", "sc.bloc.flow", "sc.bloc.volatility",
  "sc.x.vol.low", "sc.x.vol.normal", "sc.x.vol.high", "sc.x.widened", "sc.x.widenedAll",
  "sc.x.inval.below", "sc.x.inval.above", "sc.x.inval.range",
  "sc.x.macro", "sc.x.perp", "sc.x.perpFunding", "sc.x.perpBasis",
  "sc.x.sample", "sc.x.sampleSmall",
  "sc.fallback.few", "sc.fallback.noState", "sc.stateCoverage", "sc.recorded", "sc.noPath",
];

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Level that would go against the trend: the nearer of 2 x ATR from the last close and the last 20-bar swing.
 * Up trend: below only; down trend: above only; flat or unknown: both. Empty bars give nulls.
 */
export function invalidation(bars: Kline[], atr: number, s: FtState | null): { below: number | null; above: number | null } {
  if (!bars.length) return { below: null, above: null };
  const close = bars[bars.length - 1].close;
  const win = bars.slice(-SWING);
  const swingLo = Math.min(...win.map((b) => b.low));
  const swingHi = Math.max(...win.map((b) => b.high));
  const below = fin(swingLo) ? (fin(atr) ? Math.max(close - 2 * atr, swingLo) : swingLo) : null;
  const above = fin(swingHi) ? (fin(atr) ? Math.min(close + 2 * atr, swingHi) : swingHi) : null;
  if (s === "up") return { below, above: null };
  if (s === "down") return { below: null, above };
  return { below, above };
}

/** First verified event with after < at <= until (unverified dates are never used). */
export function nextMacroEvent(after: number, until: number, events: readonly MacroEvent[] = MACRO_EVENTS): MacroEvent | null {
  let best: MacroEvent | null = null;
  for (const e of events) if (e.verified && e.at > after && e.at <= until && (!best || e.at < best.at)) best = e;
  return best;
}

/** The voting bloc whose score points against the master signal, strongest first; null for NEUTRAL or none. */
export function disagreeingBloc(c: Pick<ConfluenceResult, "master" | "blocs">): BlocName | null {
  if (c.master === "NEUTRAL") return null;
  const sign = c.master === "BULLISH" ? 1 : -1;
  let best: BlocName | null = null;
  let mag = 0;
  for (const b of c.blocs) {
    if (!fin(b.score) || Math.sign(b.score) !== -sign) continue;
    if (Math.abs(b.score) > mag) { mag = Math.abs(b.score); best = b.bloc; }
  }
  return best;
}

export interface ExplainInput {
  result: ScenarioResult;
  confluence: Pick<ConfluenceResult, "master" | "strength" | "blocs">;
  bars: Kline[];
  intervalMs: number;
  /** fr: funding per interval as a fraction; bp: perp basis in percent (the ledger's `bp`). */
  perp: { fr: number | null; bp: number | null } | null;
  events?: readonly MacroEvent[];
}
export interface ExplainFmt {
  price: (p: number) => string;
  pct: (f: number) => string;
  time: (ms: number) => string;
  label: (master: ConfluenceResult["master"], strength: ConfluenceResult["strength"]) => string;
  event: (kind: MacroEvent["kind"]) => string;
}

export function explainScenarios(x: ExplainInput, fmt: ExplainFmt): ExplainPart[] {
  const { result: r, confluence: c } = x;
  const state = r.odds.state;
  const parts: ExplainPart[] = [];

  // 1. Fund trend state
  if (state === null) parts.push({ key: "sc.x.trend.none" });
  else {
    const ft = fin(r.ftNow) ? (r.ftNow > 0 ? "+" : "") + Math.round(r.ftNow) : "–";
    parts.push({ key: `sc.x.trend.${state}`, vars: { ft } });
  }

  // 2. Confluence label and the bloc that disagrees
  if (c.master === "NEUTRAL") parts.push({ key: "sc.x.conf.neutral" });
  else {
    const label = fmt.label(c.master, c.strength);
    const bloc = disagreeingBloc(c);
    parts.push(bloc ? { key: "sc.x.conf.bloc", vars: { label, bloc: `sc.bloc.${bloc}` } } : { key: "sc.x.conf.agree", vars: { label } });
  }

  // 3. Volatility regime, and how far the simulation had to widen its volatility match
  const reg = volRegime(r.volPct);
  if (reg) parts.push({ key: `sc.x.vol.${reg}`, vars: { pct: Math.round(r.volPct) } });
  if (r.widened === "all") parts.push({ key: "sc.x.widenedAll" });
  else if (r.widened !== 15) parts.push({ key: "sc.x.widened", vars: { band: r.widened } });

  // 4. Invalidation level
  const inv = invalidation(x.bars, r.atr, state);
  if (state === "up") { if (inv.below !== null) parts.push({ key: "sc.x.inval.below", vars: { level: fmt.price(inv.below) } }); }
  else if (state === "down") { if (inv.above !== null) parts.push({ key: "sc.x.inval.above", vars: { level: fmt.price(inv.above) } }); }
  else if (inv.below !== null && inv.above !== null) parts.push({ key: "sc.x.inval.range", vars: { hi: fmt.price(inv.above), lo: fmt.price(inv.below) } });

  // 5. Next verified macro event inside the horizon (after the last bar closes, up to H bars later)
  const after = barClose(r.lastTime, x.intervalMs);
  const ev = nextMacroEvent(after, after + r.horizon * x.intervalMs, x.events);
  if (ev) parts.push({ key: "sc.x.macro", vars: { event: fmt.event(ev.kind), when: fmt.time(ev.at) } });

  // 6. Perpetual funding / basis
  if (x.perp) {
    const hasFr = fin(x.perp.fr);
    const hasBp = fin(x.perp.bp);
    if (hasFr && hasBp) parts.push({ key: "sc.x.perp", vars: { fr: fmt.pct(x.perp.fr as number), bp: fmt.pct((x.perp.bp as number) / 100) } });
    else if (hasFr) parts.push({ key: "sc.x.perpFunding", vars: { fr: fmt.pct(x.perp.fr as number) } });
    else if (hasBp) parts.push({ key: "sc.x.perpBasis", vars: { bp: fmt.pct((x.perp.bp as number) / 100) } });
  }

  // 7. Sample-size caveat
  const neff = Math.round(r.odds.nEff * 10) / 10;
  parts.push({ key: r.odds.nEff < SC_MIN_NEFF ? "sc.x.sampleSmall" : "sc.x.sample", vars: { neff } });
  return parts;
}

/** Notes under the odds: fallback, Fund trend coverage, the official 1,000-bar run, and empty scenario paths. */
export function sheetNotes(result: ScenarioResult, barsHeld: number): ExplainPart[] {
  const o = result.odds;
  const parts: ExplainPart[] = [];
  if (o.fallback === "fewMatches") parts.push({ key: "sc.fallback.few" });
  else if (o.fallback === "noState") parts.push({ key: "sc.fallback.noState" });
  if (o.withState > 0 && o.withState < o.sampled) parts.push({ key: "sc.stateCoverage", vars: { n: o.withState, m: o.sampled } });
  if (barsHeld > ENGINE_BARS) parts.push({ key: "sc.recorded" });
  if (Object.values(result.paths).some((p) => p === null)) parts.push({ key: "sc.noPath" });
  return parts;
}
