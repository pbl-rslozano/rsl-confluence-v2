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

/**
 * Fetch closed bars for each pair, one at a time (a few pairs at most). A pair whose fetch fails or returns
 * no bars is listed in `failed`; an abort stops the loop and is rethrown.
 */
export async function fetchHeldBars(
  pairs: readonly string[],
  fetcher: (pair: string, signal?: AbortSignal) => Promise<Kline[]>,
  signal?: AbortSignal,
): Promise<{ bars: Record<string, Kline[]>; failed: string[] }> {
  const bars: Record<string, Kline[]> = {};
  const failed: string[] = [];
  for (const pair of pairs) {
    if (signal?.aborted) throw new DOMException("Held-pair fetch cancelled", "AbortError");
    try {
      const k = await fetcher(pair, signal);
      if (Array.isArray(k) && k.length) bars[pair] = k; else failed.push(pair);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      failed.push(pair);
    }
  }
  return { bars, failed };
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
