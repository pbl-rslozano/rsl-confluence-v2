# ADR-0017 — Confluence v2: a challenger scored beside Classic (WP23)

**Status:** Accepted as a challenger (owner, 17 Nov 2026). Switching the list, labels, alerts or paper trading over to v2
needs a later owner decision based on the ledger record. Amended by the owner decision of 18 Nov 2026 below: the four
contrarian oscillators are kept on every interval. v2.8 plan WP23 (built on branch `v2.8/wp23`, not merged or released).

## Context
The WP23 text of the v2.8 spec (`docs/superpowers/specs/2026-11-15-v2.8-architecture-design.md`) asks for a second engine
profile, scored in the same scan and recorded under its own config id, never shown in the list: volatility-standardised
inputs clipped to ±1, hysteresis (enter at |score| ≥ 55, back to NEUTRAL below 40), bands re-calibrated on noise to
Classic's targets (≤ 7 % labelled, ≤ 2 % STRONG), and a ledger comparison with Classic, with nothing switching over without
a later owner decision. The spec also named four contrarian oscillators to drop on 4h and above.

The reason is the audit's "retail dashboard" finding (`Confluence-Terminal-v2.7-vs-Profitable-Traders-Audit.md`): Classic
adds up unscaled 18 binary votes, so a label flips on a one-vote change and the score carries no notion of how far an
indicator sits from its trigger. v2 tests whether a standardised, hysteretic score is measurably better, on the same rows
and the same outcomes, before anyone considers replacing Classic.

Classic stays exactly as it is: `ENGINE_VERSION` 2.4.0, config id `5c30b5c39f5ba3f2`, every Classic field of every row,
the list, the labels, the alerts and the paper rules. v2 is an additional logged field.

## Decision

### Inputs
Each of Classic's 18 voters becomes a continuous measure at every bar, divided by a volatility scale, signed, and clipped to
**±1** (`clamp(sign × measure ÷ divisor, −1, 1)`). The σ window is **100** bars, the ATR period **14**. No new indicator is
added: v2 uses the same 18 voters and the same blocs as Classic. Contrarian oscillators carry sign −1 (an overbought
reading is bearish). A divisor that is not finite, is ≤ 0, or is at rounding-noise level (≤ 1e-9 × the natural scale of
its input: the price, 100 for the 0–100 oscillators, 1 for CMF, the cumulative volume for OBV) makes the input invalid (no
vote), never a saturated ±1. The mapping:

| id | bloc | measure (bar j) | divisor | sign | volume |
|---|---|---|---|---|---|
| sma | trend | SMA20 − SMA50 | ATR14 | + | |
| ema | trend | EMA9 − EMA21 | ATR14 | + | |
| macd | trend | MACD histogram 12/26/9 | σ100 of the histogram | + | |
| adx | trend | +DI14 − −DI14 | σ100 of (+DI − −DI) | + | |
| psar | trend | close − SAR (0.02, 0.2) | ATR14 | + | |
| ichimoku | trend | close − cloud mid (spans displaced 26) | ATR14 | + | |
| supertrend | trend | close − Supertrend line (10, 3) | ATR14 | + | |
| rsi | meanReversion | RSI14 − 50 | σ100 of RSI14 | − | |
| stochastic | meanReversion | %K14 − 50 | σ100 of %K | − | |
| cci | trend | CCI20 | σ100 of CCI20 | + | |
| williams | meanReversion | %R14 + 50 | σ100 of %R | − | |
| ao | trend | AO (SMA5 − SMA34 of the median price) | ATR14 | + | |
| mfi | meanReversion | MFI14 − 50 | σ100 of MFI14 | − | ✓ |
| bollinger | breakout | close − SMA20 | 2 × σ20 of close (band half-width) | + | |
| keltner | breakout | close − EMA20 | 2 × ATR10 (band half-width) | + | |
| vwap | flow | close − VWAP (session-anchored < 1d, 20-bar otherwise; as Classic) | ATR14 | + | ✓ |
| obv | flow | OBV − SMA20(OBV) | σ100 of (OBV − SMA20(OBV)) | + | ✓ |
| cmf | flow | CMF20 | σ100 of CMF20 | + | ✓ |

The "volume" column marks the inputs left out when a source has no usable volume. Each measure follows Classic's formula at
every bar, including its edge rules (RSI and MFI 50 with no gains and no losses; Stochastic 50 and %R −50 on a flat range;
CCI 0 when the mean deviation is 0). The divisors are unchanged by the rework described below.

### The four contrarian oscillators are kept on every interval (owner decision, 18 Nov 2026)
RSI, Stochastic, Williams %R and MFI vote on **every** interval, including 4h and above. This supersedes the spec's
"dropped on ≥ 4h". How it came about:
- The first calibration, with the drop in place, was near-degenerate: the worst noise cell jumped from 5.33 % labelled to
  25 % at the next gain step, and STRONG was unreachable (at the gain that qualified, the score cannot exceed the lowest
  STRONG band).
- Re-scaling the trend inputs (SMA, EMA, Parabolic SAR, Ichimoku, Supertrend, AO and others) from ATR14 to their own σ100 did
  not fix it. The cause was bloc correlation at 4h and above: trend, breakout and flow all ask whether price is above its
  recent average, so on a random walk they share a sign, and with the contrarian bloc gone nothing offsets them. The
  measurement is in `docs/research/evidence/wp23-v2-scaling-diagnostic-2026-11-18.json` (round 1, with the drop, is commit
  `4e47704`).
- The owner chose to keep the contrarian bloc. The recalibration with it kept is in
  `docs/research/evidence/wp23-v2-calibration-2026-11-18.json`. The divisors in the table above are the ones that passed.

### Score, hysteresis and state
- **Score.** The inputs are averaged per bloc, and the bloc means are combined with Classic's bloc weights (mean reversion
  phased out by Classic's 40-bar efficiency-ratio gate) into a mean in [−1, 1]; `score = round(100 × clamp(V2_GAIN × mean))`.
  A bar with fewer than 70 % of its 18 inputs valid (Classic's minimum share: 13) has no score. The floor is counted over all 18, so without usable volume the 14 remaining inputs still score the bar.
- **Hysteresis.** A label is entered at |score| ≥ 55 and returns to NEUTRAL below 40. The exit test runs before the entry
  test, and a bar without a score (suppressed) resets to NEUTRAL. A BUY entered at 58 therefore stays BUY at 45 (the detail
  line says "held") and ends below 40.
- **Strength.** STRONG needs |score| ≥ `V2_STRONG_BAND` in the label's direction; otherwise MODERATE; NEUTRAL is WEAK. The
  low-volatility cap applies as in Classic (STRONG becomes MODERATE, not for currencies).
- **State is derived, never stored.** A row's label is the hysteresis run over the last 300 per-bar scores of the row's own
  window (Classic's window: the last 1,000 bars, session-filtered for stocks), starting from NEUTRAL. Nothing is read from
  or written to storage, so the app, the worker, the recorder, catch-up and replay give the same label for the same bars.
  The cost of this is that a label at the start of a run of 300 scores can differ from a label that has run for months; the
  continuity check (below) measured how often consecutive rows disagree: never, on the fixtures.
- **Profiles are ignored.** v2 is a fixed challenger; the scoring profile applies to Classic only.
- **Determinism.** Only `+ − × ÷`, `Math.sqrt`, `Math.abs`, `Math.min`, `Math.max` and `Math.round` (no exp, log or pow), so
  the browser, the WebView and Node agree bit for bit on scores and on the config id.

### Noise calibration
Method (`npm run calibrate:v2`): the WP19 noise grid, 3 models (Gaussian, Student-t with 3 degrees of freedom, GARCH) × 3
intervals (1h, 4h, 1d), 300 windows per cell on the calibration seeds (offset 50). The hysteresis is run over each window.
- **`V2_GAIN`** is the largest gain on the grid 0.50…3.00 (step 0.05) whose worst cell labels ≤ 6.0 % of windows (the spec's
  ≤ 7 %, with a margin).
- **`V2_STRONG_BAND`** is the smallest band in 56…100 whose worst cell has STRONG ≤ 1.5 % at that gain (the spec's ≤ 2 %).
- Acceptance beyond the targets: STRONG reachable on a drifting fixture, no cliff (the next grid step's worst share within 2×
  of the chosen one), and drift detection not worse than before (≥ 33 of 100 windows labelled, all BUY).

Result: **`V2_GAIN` 0.8, `V2_STRONG_BAND` 64**, v2 config id **`f5c94871f16f6673`**. Calibration worst cell: 5.00 % labelled
and 1.33 % STRONG; the next step (0.85) gives 6.67 %, a cliff ratio of 1.33. Drift fixture: 81 of 100 windows labelled, all
BUY, 62 STRONG. Hold-out (seed offset 0, 1,000 windows per cell): worst 4.90 % labelled and 1.40 % STRONG.

| cell | calibration labelled / STRONG | hold-out labelled / STRONG |
|---|---|---|
| Gaussian 1h | 1.33 % / 0.67 % | 2.60 % / 0.50 % |
| Gaussian 4h | 0.67 % / 0.33 % | 1.40 % / 0.40 % |
| Gaussian 1d | 2.00 % / 1.00 % | 2.50 % / 0.40 % |
| Student-t 1h | 5.00 % / 1.33 % | 4.90 % / 1.30 % |
| Student-t 4h | 2.33 % / 0.33 % | 3.30 % / 0.80 % |
| Student-t 1d | 5.00 % / 1.00 % | 4.70 % / 1.40 % |
| GARCH 1h | 3.00 % / 1.33 % | 2.10 % / 0.00 % |
| GARCH 4h | 2.33 % / 1.33 % | 1.20 % / 0.10 % |
| GARCH 1d | 2.00 % / 0.67 % | 2.80 % / 0.60 % |

Classic's own worst cells on the same grid are 5.40 % labelled and 1.90 % STRONG. The `v2.cfg` member of every row is the
v2 config id: a hash of the v2 version, every parameter above (including the divisor table, blocs, sign, volume rule, gain
and band) and v2's behaviour on a fixed test series, so a change to any of them changes the id and rows are never pooled.

### Where v2 lives
- **It rides on the Classic row** as `v2: { cfg, s, m, st }` (config id, score −100…100 or null when suppressed, label
  −1/0/1, strength 0 weak / 1 moderate / 2 strong), about **54 bytes** per row, with **one shared outcome per row** (controller
  ruling, 17 Nov 2026). A second row per bar would have halved the ledger's retention and the backup capacity. Absent or null
  means "not computed" (rows recorded before WP23, or v2 not usable on that window); such rows stay valid. The ledger import
  is strict (the `scb`/`scp` pattern): a hostile or partial value rejects the whole row. Four CSV columns follow
  `scenario_fallback`: `v2_config_id`, `v2_score`, `v2_direction`, `v2_strength`.
- **Never shown, never used.** v2 never reaches list cells, sort or counts; labels, the MasterBadge, the Fund trend
  disagreement marks or the pulse; alerts of any kind; paper proposals or rules; or Classic's ledger report, gate or
  pre-registration. Its only surfaces are the opt-in detail line, the collapsed ledger section and the four exported columns.
- **Head-to-head.** `asV2Row` is the same row with v2's score, label and strength; `retargetOutcome` re-prices the row's one
  measured outcome for v2's direction (gross, cost and funding are shared; only the direction, and so the net, changes);
  `pairedOutcomes` keeps only rows whose `v2.cfg` is the current v2 config id (rows of another v2 version are counted
  separately, "{n} rows carry another Confluence v2 version and are not compared.", and never pooled; final review I2, the
  replay print applies the same filter); `labelChurn` counts label changes per 100 consecutive bars (a missing bar
  breaks a step). The comparison is a collapsed **Classic vs Confluence v2 (test)** section in the ledger dialog,
  immediately before the Scenario check (spec §3 item 4), so the Scenario check stays the last element. It shows, per
  engine, signals, hit rate, mean net and edge in basis points, rank IC t, PSR and label changes per 100 bars, and says how
  many rows were not compared. Rows are compared on the same bars and the same outcomes. The comparison is built lazily
  (final review I1): only when the section is expanded, after Classic's report has rendered, once per measurement and v2
  config id; while the section is closed no comparison work runs, so Classic's report path is exactly as before WP23.
- **Detail line (spec §3 item 3).** The setting **Confluence v2 line in the detail sheet (test)**, default off, sits in the
  Scoring profile popover. On, the detail sheet shows one line, "Confluence v2 (test): BUY · STRONG · score +74", with "held
  until the score is back inside ±40" when the label is held between 40 and 55, or "no data".
- **Build behaviour.** v2 runs behind its own guard in the scan job: a fault gives `v2: null` and never touches Classic's
  score or its catch-up rows. Catch-up goes to the worker in chunks of at most 25 jobs (each message stays well under the
  worker's time limit on a slow phone; the ruling is in the table below). The recorder (`docs/recorder.md`) and the replay
  record v2 with the same code; the replay has `--no-v2` and prints a head-to-head summary table.
- **Translations.** The new strings are in all 18 catalogs. The 16 other catalogs carry English text for the new keys (house
  practice), Arabic is drafted and listed in `@pendingReview`, and nothing is certified.

## Consequences
- **Row size.** Each ledger row grows by about 54 bytes (measured on the evidence rows: mean 52.3, maximum 54; the worst
  case, a score of −100, is 55). A stored row carries `"v2":null` (+10 bytes) when v2 was not computed.
- **Classic unchanged.** Config id `5c30b5c39f5ba3f2`, `ENGINE_VERSION` 2.4.0, and every Classic field of every row. The five
  engine files (`indicators.ts`, `scan-pipeline.ts`, `engine-config.ts`, `engine-window.ts`, `measure.test.mjs`) and
  `packages/core` are not modified. No new host, no new dependency.
- **A challenger, not a verdict.** Classic stays the engine until the ledger record says otherwise and the owner decides.
- **Evidence** (`docs/research/evidence/wp23-classic-vs-v2-2026-11-18.{json,md}`, synthetic fixtures, noise-like, not
  evidence of edge):

| Metric | Classic | Confluence v2 |
|---|---|---|
| Config id | `5c30b5c39f5ba3f2` (before and after) | `f5c94871f16f6673` |
| Worst noise cell, labelled | 5.40 % | 4.90 % |
| Worst noise cell, STRONG | 1.90 % | 1.40 % |
| Label changes per 100 bars, 1h | 7.63 | 1.25 |
| Label changes per 100 bars, 4h | 5.18 | 0.48 |
| Continuity (consecutive rows agree) | n/a | 100.00 % (4900/4900) |
| Bytes added per row (mean / max) | n/a | 52.3 / 54 |

  The performance cells on the fixtures are small samples (for example 11 signals at h = 6 on the 1h series) and are not
  read as a claim. Per-horizon figures are in the JSON.
- **Spec-conflict and rulings.**

| Question | Ruling | Reason |
|---|---|---|
| Contrarian oscillators on ≥ 4h (spec: dropped) | Kept on every interval (owner decision, 18 Nov 2026) | With the drop, the first calibration was near-degenerate (cliff from 5.33 % to 25 %, STRONG unreachable); the cause is bloc correlation at 4h and above, which σ100 divisors did not fix. |
| Trend inputs on ATR14 or σ100 | The table above (ATR14 for the price-unit trend measures); σ100 re-scaling of the price-unit trend inputs was measured and not adopted | The spec allows either. It moved the 4h trend-bloc median only a little (0.585 to 0.556) and the STRONG band from 64 to 63, and did not fix the bloc correlation. |
| Two rows per bar, or one | One row with `v2: { cfg, s, m, st }` (controller, 17 Nov 2026) | Keeps retention and backup capacity; one shared outcome. |
| Hysteresis state | Derived from the last 300 scores of the row's own window, starting NEUTRAL; never stored | The app, worker, recorder, catch-up and replay must agree; no storage to drift. |
| Rows over a longer series | Recorded and replayed rows score the row's own 1,000-bar window; a precomputed longer series (`v2RowAt`) is display only | It is not bit-identical (rounding 1e-15 to 7e-14; VWAP session start; OBV scale start). |
| One gain and one band | 55/40 fixed by the spec; one gain and one STRONG band calibrated | Stop and report if no gain qualifies; none was lost to a looser rule. |
| Catch-up message size | At most 25 jobs per worker call, sequential, same rows and order | Bounds one message to about 1/8 of a 200-pair batch (about 15 s on a phone 3.2× slower, against the 120 s limit) without weakening hang failover. |
| v2 fault | Own guard: `v2: null`, Classic untouched | By effect, a v2 bug would otherwise break the production Classic scan. |
| Detail line when 4h | No "dropped" note, no `v2.lineDropped` key | Nothing is dropped any more. |
| Replay head-to-head | Per-engine, per-horizon summary table, not full group and IC tables for v2 | The table is the side-by-side; full tables would double the output without a reader. |
| Evidence guard | Fails when nothing was measured (no rows, or NaN rate) | An empty run must not print a green file. |
| Brief of 17 Nov vs the owner decision | The owner decision wins in the ADR, guide, measurement doc and PR; the spec's WP23 sentence carries a "superseded" note | A spec that silently contradicts the code misleads. |
