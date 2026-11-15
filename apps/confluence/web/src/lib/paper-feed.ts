/**
 * paper-feed.ts — v2.8 final review I-3 / M-5 (PAPER ONLY).
 *
 * A pair that holds an open or pending paper position must keep delivering bars to the paper book — stops,
 * targets, the time stop and drawdown-lock closes depend on them — even when the scan leaves it out (the
 * liquidity floor, the top-N cut or a changed watch list). Display rules are unchanged: such a pair is fetched
 * for the paper book only; it is never scored, listed, recorded or alerted on.
 *
 * Read-only market data through the caller's fetcher; no order path (R12).
 */
import type { Kline } from "./indicators";
import type { PaperBook } from "./paper-broker";

/** Pairs of this source × timeframe holding an open (incl. close-requested) or pending position, sorted. */
export function heldPairs(book: PaperBook, src: string, tf: string): string[] {
  return [...new Set(book.positions.filter((p) => p.src === src && p.tf === tf && (p.status === "open" || p.status === "pending")).map((p) => p.pair))].sort();
}

/** Held pairs of this series that the scan did not deliver (they need a paper-only fetch). */
export function missingHeldPairs(book: PaperBook, src: string, tf: string, scanned: Iterable<string>): string[] {
  const have = new Set(scanned);
  return heldPairs(book, src, tf).filter((pair) => !have.has(pair));
}

/** A 429/418 (or venue rate-limit code) from market-client, recognised without importing it (R12). */
const isRateLimit = (error: unknown): boolean =>
  error instanceof Error && (error.name === "RateLimitError" || (error as { reason?: unknown }).reason === "RATE_LIMIT");

/**
 * Fetch closed bars for each pair, one at a time (a few pairs at most). A pair whose fetch fails or returns
 * no bars is listed in `failed`; an abort stops the loop and is rethrown.
 * Rate limits (re-review N-1): while `cooldownMs()` > 0 nothing is requested, and a rate-limit error stops the
 * loop; in both cases every pair not loaded is in `failed` and `halted` is true.
 */
export async function fetchHeldBars(
  pairs: readonly string[],
  fetcher: (pair: string, signal?: AbortSignal) => Promise<Kline[]>,
  signal?: AbortSignal,
  opts: { cooldownMs?: () => number } = {},
): Promise<{ bars: Record<string, Kline[]>; failed: string[]; halted: boolean }> {
  const bars: Record<string, Kline[]> = {};
  const failed: string[] = [];
  if ((opts.cooldownMs?.() ?? 0) > 0) return { bars, failed: [...pairs].sort(), halted: true };
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (signal?.aborted) throw new DOMException("Held-pair fetch cancelled", "AbortError");
    try {
      const k = await fetcher(pair, signal);
      if (Array.isArray(k) && k.length) bars[pair] = k; else failed.push(pair);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (isRateLimit(error)) return { bars, failed: [...failed, ...pairs.slice(i)].sort(), halted: true };
      failed.push(pair);
    }
  }
  return { bars, failed: failed.sort(), halted: false };
}

/**
 * One paper-only held-pair feed for a completed scan (re-review N-1 / N-4): find held pairs the scan did not
 * deliver, fetch them (cooldown-aware), then apply them only if the scan was not aborted and the view
 * (`src|tf`) is still the one they were fetched for — otherwise the result is dropped (`stale`).
 */
export async function runHeldFeed(o: {
  book: PaperBook;
  src: string;
  tf: string;
  scanned: Iterable<string>;
  fetcher: (pair: string, signal?: AbortSignal) => Promise<Kline[]>;
  ingest: (bars: Record<string, Kline[]>) => void;
  currentView: () => string;
  signal?: AbortSignal;
  cooldownMs?: () => number;
  usable?: (k: Kline[]) => boolean;
}): Promise<{ stale: boolean; applied: boolean; failed: string[]; halted: boolean }> {
  const view = `${o.src}|${o.tf}`;
  const missing = missingHeldPairs(o.book, o.src, o.tf, o.scanned);
  if (!missing.length) return { stale: false, applied: false, failed: [], halted: false };
  let res: Awaited<ReturnType<typeof fetchHeldBars>>;
  try {
    res = await fetchHeldBars(missing, o.fetcher, o.signal, { cooldownMs: o.cooldownMs });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return { stale: true, applied: false, failed: [], halted: false };
    throw error;
  }
  if (o.signal?.aborted || o.currentView() !== view) return { stale: true, applied: false, failed: [], halted: res.halted };
  const fresh: Record<string, Kline[]> = {};
  const failed = [...res.failed];
  for (const [pair, k] of Object.entries(res.bars)) if (!o.usable || o.usable(k)) fresh[pair] = k; else failed.push(pair);
  const applied = Object.keys(fresh).length > 0;
  if (applied) o.ingest(fresh);
  return { stale: false, applied, failed: failed.sort(), halted: res.halted };
}

/** "Source · timeframe: PAIR, PAIR" for one series (label supplies the source label and localised timeframe). */
export function pairsText(pairs: readonly string[], src: string, tf: string, label: (src: string, tf: string) => string): string {
  return pairs.length ? `${label(src, tf)}: ${[...pairs].sort().join(", ")}` : "";
}

/** Every pair still holding a position, grouped by series: the RESET waiting text (never raw `src|tf` keys). */
export function waitingText(book: PaperBook, label: (src: string, tf: string) => string): string {
  const groups = new Map<string, { src: string; tf: string; pairs: Set<string> }>();
  for (const p of book.positions) {
    const key = `${p.src}|${p.tf}`;
    const g = groups.get(key) ?? { src: p.src, tf: p.tf, pairs: new Set<string>() };
    g.pairs.add(p.pair);
    groups.set(key, g);
  }
  return [...groups.keys()].sort().map((k) => { const g = groups.get(k)!; return pairsText([...g.pairs], g.src, g.tf, label); }).join("; ");
}
