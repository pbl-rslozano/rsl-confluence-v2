# Classic before/after and Confluence v2 (WP23)

Generated 2026-11-18; Classic baseline at `d572a3a`, this run at `1997b2e`.
Classic unchanged: **true**.

| Metric | Classic before | Classic after | Confluence v2 |
| --- | --- | --- | --- |
| Config id | `5c30b5c39f5ba3f2` | `5c30b5c39f5ba3f2` | `f5c94871f16f6673` |
| Worst noise cell, labelled | 5.40 % (t3 1d) | 5.40 % (t3 1d) | 4.90 % (t3 1h) |
| Worst noise cell, STRONG | 1.90 % (t3 1h) | 1.90 % (t3 1h) | 1.40 % (t3 1d) |
| h = 6, 1h, one series: signals | 29 (small sample) | 29 (small sample) | 11 (small sample) |
| h = 6, 1h, one series: hit rate | 51.72 % (15/29) | 51.72 % (15/29) | 72.73 % (8/11) |
| h = 6, 1h, one series: mean net bp | -10.70 | -10.70 | 62.09 |
| h = 6, 1h, one series: edge bp | 5.36 | 5.36 | 66.66 |
| h = 6, 1h, one series: IC t | n/a | n/a | n/a |
| h = 6, 1h, one series: PSR | 0.346 | 0.346 | 0.967 |
| h = 6, 4h, eight walks: signals | 236 | 236 | 30 |
| h = 6, 4h, eight walks: hit rate | 41.95 % (99/236) | 41.95 % (99/236) | 33.33 % (10/30) |
| h = 6, 4h, eight walks: mean net bp | -34.74 | -34.74 | -67.59 |
| h = 6, 4h, eight walks: edge bp | -4.78 | -4.78 | -37.97 |
| h = 6, 4h, eight walks: IC t | -0.74 | -0.74 | -0.71 |
| h = 6, 4h, eight walks: PSR | 0.010 | 0.010 | 0.071 |
| Label changes per 100 bars, 1h | 7.63 | 7.63 | 1.25 |
| Label changes per 100 bars, 4h | 5.18 | 5.18 | 0.48 |
| Continuity (consecutive rows agree) | n/a | n/a | 100.00 % (4900/4900) |
| Bytes added per row (mean / max) | n/a | n/a | 52.3 / 54 |

synthetic fixtures (noise-like); not evidence of edge; Classic stays the engine

Notes

- Read the 1h columns with caution: at h = 6, Confluence v2 has 11 signals and Classic has 29 signals (below 30), from one 1h series. Confluence v2's 72.73 % is 8 of 11 (1 BUY, 10 SELL); 8 of 11 or better happens about 11.33 % of the time for a fair coin, and PSR 0.967 is not stable at that size. At h = 1 the same engine has 52 signals and a 40.38 % hit rate.
- Confluence v2 at 4h (h = 6, 30 signals) has a 33.33 % hit rate and -67.59 mean net bp. No claim is made from these cells.
- h = 6 is one horizon of 5 (1, 3, 6, 12, 24); the JSON `headToHead` holds all of them. The 1h fixture is a single series; the 4h fixture is eight walks.
- Cells with fewer than 30 signals at the horizon are marked "small sample".
- Noise cells: Classic is the shared grid (as in the baseline); Confluence v2 is the hold-out cells (seed offset 0, 1,000 windows per cell): the cells `npm run test:noise-v2` prints.
- Signals, hit rate (with hits/signals), mean net bp, edge bp, IC t and PSR are at h = 6, BUY and SELL pooled (weighted by n). Signals is the number of signals with a measured outcome at that horizon.
- Pools all fixture rows. There is no in-sample/out-of-sample split, and neither engine was fitted on these fixtures. n is the number of signals (BUY and SELL, measured) at each horizon.
- Label changes per 100 bars: Classic after and Confluence v2 use the same rule (`labelChurn`).
- Continuity: scored over consecutive rows whose two windows are both full 1,000 bars. Bytes: JSON characters added to a sanitised ledger row.
- Owner decision 2026-11-18: RSI, Stochastic, Williams %R and MFI are kept on every interval (the spec's ≥ 4h drop was superseded after calibration evidence)
