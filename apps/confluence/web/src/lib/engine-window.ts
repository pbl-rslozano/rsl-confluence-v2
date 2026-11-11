/**
 * engine-window.ts — v2.2
 * Bars every engine evaluation sees — live, worker, ledger and replay alike.
 * A fixed window removes warm-up bias: recursive indicators (EMA, ADX, PSAR,
 * Supertrend, Ichimoku) give different last-bar values for different seeding
 * lengths, so a score is only reproducible when the window length is fixed.
 * (Own module so scan-pipeline and engine-config do not import each other at
 * load time.)
 */
export const ENGINE_BARS = 1_000;
/** Minimum bars before a series is scored at all (Ichimoku 52 + 26 displacement). */
export const MIN_ENGINE_BARS = 80;
