# Classic before/after and Confluence v2 (WP23)

Generated 2026-11-18; Classic baseline at `d572a3a`, this run at `c516e8b`.
Classic unchanged: **true**.

| Metric | Classic before | Classic after | Confluence v2 |
| --- | --- | --- | --- |
| Config id | `5c30b5c39f5ba3f2` | `5c30b5c39f5ba3f2` | `f5c94871f16f6673` |
| Worst noise cell, labelled | 5.40 % (t3 1d) | 5.40 % (t3 1d) | 4.90 % (t3 1h) |
| Worst noise cell, STRONG | 1.90 % (t3 1h) | 1.90 % (t3 1h) | 1.40 % (t3 1d) |
| h = 6, 1h: signals | 29 | 29 | 11 |
| h = 6, 1h: hit rate | 51.72 % | 51.72 % | 72.73 % |
| h = 6, 1h: mean net bp | -10.70 | -10.70 | 62.09 |
| h = 6, 1h: edge bp | 5.36 | 5.36 | 66.66 |
| h = 6, 1h: IC t | n/a | n/a | n/a |
| h = 6, 1h: PSR | 0.346 | 0.346 | 0.967 |
| h = 6, 4h: signals | 236 | 236 | 30 |
| h = 6, 4h: hit rate | 41.95 % | 41.95 % | 33.33 % |
| h = 6, 4h: mean net bp | -34.74 | -34.74 | -67.59 |
| h = 6, 4h: edge bp | -4.78 | -4.78 | -37.97 |
| h = 6, 4h: IC t | -0.74 | -0.74 | -0.71 |
| h = 6, 4h: PSR | 0.010 | 0.010 | 0.071 |
| Label changes per 100 bars, 1h | 7.63 | 7.63 | 1.25 |
| Label changes per 100 bars, 4h | 5.18 | 5.18 | 0.48 |
| Continuity (consecutive rows agree) | n/a | n/a | 100.00 % (4900/4900) |
| Bytes added per row (mean / max) | n/a | n/a | 52.3 / 54 |

Notes

- Noise cells: Classic is the shared grid (as in the baseline); Confluence v2 is the hold-out cells (seed offset 0, 1,000 windows per cell): the cells `npm run test:noise-v2` prints.
- Signals, hit rate, mean net bp, edge bp, IC t and PSR are at h = 6, BUY and SELL pooled (weighted by n). Signals is the number of signals with a measured outcome at that horizon.
- Pools all fixture rows. There is no in-sample/out-of-sample split, and neither engine was fitted on these fixtures. n is the number of signals (BUY and SELL, measured) at each horizon.
- Label changes per 100 bars: Classic after and Confluence v2 use the same rule (`labelChurn`).
- Continuity: scored over consecutive rows whose two windows are both full 1,000 bars. Bytes: JSON characters added to a sanitised ledger row.
- Owner decision 2026-11-18: RSI, Stochastic, Williams %R and MFI are kept on every interval (the spec's ≥ 4h drop was superseded after calibration evidence)

synthetic fixtures (noise-like); not evidence of edge; Classic stays the engine
