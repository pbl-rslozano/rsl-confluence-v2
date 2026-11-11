# ADR-0007 — Measurement layer: engine id, signal ledger, replay, worker

**Status:** Accepted · 31 Oct 2026 · v2.2

## Context
The v2.1 gap analysis found the app could not say whether any signal beats chance: nothing was recorded, the engine was changed in place, and scores depended on how much history a device happened to hold (warm-up bias).

## Decision
1. **Fixed engine window** (`ENGINE_BARS = 1000`) for every caller; scans ask for 1,000 bars when a series is not yet covered (warm start).
2. **Engine id** = hash(version, parameters, behaviour fingerprint on a fixed arithmetic-only series). Pinned in tests; identical across bundlers and JavaScript engines.
3. **Signal ledger**: one document per bar, idempotent by row id, retention by age and row cap, storage-full recovery; SQLite in the shells, a separate IndexedDB database in the browser; exported as CSV/JSON, not in backups (amends ADR-0006: signal export is now in scope).
4. **One scoring path** (`scan-pipeline.scoreSeries`) used by the live scan, a Web Worker and the Node replay, so live and replayed rows are identical (unit-tested).
5. **Outcome rules**: next-bar-open entry, costs, funding, no outcome across gaps; statistics on non-overlapping outcomes (block PSR, spaced IC), base rates include funding.
6. **Rate limits** halt a scan and pause new ones (ASVS V4 / exchange-ban avoidance).

## Consequences
- First scan of a session downloads ~5× more candles (1,000 vs 200 bars per pair); later scans are unchanged.
- The ledger grows ~600 rows/day per 100-pair 4 h scan; each scan writes one small per-bar document.
- Survivorship, universe look-ahead and placeholder slippage remain (docs/measurement.md).
