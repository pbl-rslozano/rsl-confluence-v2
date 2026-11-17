# ADR-0016 — Scenarios: a direction-neutral simulation from past data (WP22)

**Status:** Accepted (owner, 15 Nov 2026) · v2.8 plan WP22, Step 5 (built on branch `v2.8/step5`, not merged or released).

## Context
The owner asked for a way to see how far price could move over the next bars, drawn as candlesticks, without a
forecast (spec `docs/superpowers/specs/2026-11-15-v2.8-architecture-design.md`, WP22). Three options were weighed:
- **A**: a single projected path (a forecast in disguise; rejected);
- **B**: a parametric cone from volatility alone (candles would not look like this coin's candles);
- **C** (chosen): resample this coin's own past candles in blocks, remove the sample's drift, show bands and one example
  path per scenario, and report odds from history with their sample size.

The app stays a measurement and paper-practice tool: "Possible scenarios from past data — not a forecast." Not financial
advice. Scenarios never vote (no score, paper rule, alert or Radar input), the engine stays 2.4.0
(`5c30b5c39f5ba3f2`), and there is no new host and no new dependency.

## Decision
- **Direction-neutral block bootstrap.** 200 paths of blocks of 6 relative candles (OHLC ÷ previous close), drawn from bars
  whose ATR(14)/close percentile is within ±15 points of today's; fewer than 20 eligible blocks widens to ±30, then to all
  bars, and the explanation says so. The mean log return of the sample is removed. Seeded from pair + timeframe + last
  closed bar time. Minimum 300 bars. Bands 2.5–97.5 % and 16–84 %, dotted median. One 24-step simulation; the 6-bar
  horizon uses its first 6 steps.
- **Odds from history.** State = Fund trend direction only (down ≤ −15, flat, up ≥ 15). Matches are past bars in that
  state, sampled every 2 bars; n_eff = matches × 2 ÷ H and must be ≥ 20, otherwise the coin's overall odds are shown with
  the fallback text. Outcomes are bucketed at ±0.5 σ_H (σ_H = ATR(14)/close × √H at the signal bar): Continue / Pause /
  Reverse, or Up / Range / Down on a flat trend. Wilson 95 % range on n_eff, plus the all-bars base rate. The scenario
  path is the one nearest the bucket median; an empty bucket draws nothing and its odds still show.
- **Official run.** The scan path (`scan-record.ts`, fixed 1,000-bar window, H = 6) is the official one; the recorder and
  catch-up rows compute the same fields through the same code (`scenarioFields`). The sheet uses its own history and says
  "The recorded check uses the last 1,000 bars." when it differs.
- **Ledger.** `scb` (the 6-bar band edges) and `scp` (state, scenario odds, base-rate odds, σ_6, fallback flag) are logged
  and never scored: 13 CSV columns after the Radar columns, strict type and range checks that reject the whole row.
- **No extra requests.** Daily bars for the state come from the existing `loadDailyBars` (same hosts, at most one per pair
  per UTC day), only while the Scenarios section is open. Rows without a state show the overall odds.
- **Never a vote**, and the display options (Heikin-Ashi, Reflect view) are display only.

## Consequences
- **Ledger self-check.** A collapsed Scenario check in the ledger measures band coverage (targets 68 % / 95 %, Wilson
  range) and the three-outcome Brier score of the scenario odds against the base-rate odds, over non-overlapping 6-bar
  windows. If the fan is mis-sized or the odds do not beat the base rate, the ledger shows it. Brier skips fallback rows,
  which carry no odds of their own.
- **Builder-check rulings** (controller, during the Step 5 build):

| Question | Ruling | Reason |
|---|---|---|
| Simulation draw schedule | 0-based step index; a new 6-bar block is drawn at steps 1, 7, 13 and 19 | One rule for the sheet and the ledger; the first 6 steps are exactly one block, so H = 6 is a prefix of the 24-step run. |
| Volatility regime | One function, `volRegime`: low, normal, high, cut at percentiles 33 and 67. A NaN percentile is unknown: no volatility sentence, and the section shows "not enough history" | The explanation, the widening rule and the tests share it; an invented number would be worse than silence. |
| Play button | Reads "▶ Play" at first; Pause holds the count and the button reads "▶ Play" again, pressing it resumes; "Replay" only at the end; with reduced motion, Play shows all candles at once | A pause is not a restart; Replay is only meaningful when the run is finished; no animation under reduced motion. |
| Fallback sample line | When the odds fall back to the overall odds the line reads `sc.sampleAll` ("{cases} past moments (all bars) · effective sample {neff}"), using all sampled bars | The shown cases and n_eff must describe the sample actually used, not matches that were discarded. |
| Scenario check population | Only rows that also pass the ledger's own usable-row filter; closed-market rows and rows under the bar-count minimum are not scenario-checked | The check must use the same rows as every other ledger statistic; the rest cannot be measured on the same footing. |
| `scp` content | State, base-rate odds, σ_6 and a fallback flag (13 CSV columns) | Everything the check needs to score the odds later without recomputation. |
| Daily bars | No extra daily-bar requests; no-state rows show overall odds | Keeps ADR-0003 hosts and request budget unchanged. |
| Simulation size | One 24-step simulation; H = 6 uses its first 6 steps | Cost and consistency. |
| Projection visibility | Shown only while the view includes the newest bar | A projection after a past bar would mislead. |
| Widening | Applies when fewer than 20 eligible blocks | A thin sample gives a jagged fan; the widening is disclosed in the text. |
| Pointer zoom and pan | With the projection on they use the real bars' span | The empty slots must not change what a zoom gesture means. |

- **Cost.** One simulation per open sheet and horizon, in the existing worker. The ledger's official run costs about 1 ms
  per row on a desktop (Node/V8; `npm run test:scenario-ledger` prints it, about 1.0 ms), several times that on a phone.
  Catch-up writes up to 48 rows per pair, so a return after a gap costs pairs × 48 rows: about 4.8 s at 100 pairs and
  about 10 s at 200; a scan's live rows add about 0.1–0.25 s. In the app this runs on the main thread (scoring goes to the
  worker, the enrichment does not), so it is cut into chunks of 8 rows with a yield between chunks
  (`applyScenariosAsync`, `enrichCatchUpAsync`, `writeLiveRows`; `scheduler.yield()`, else a `MessageChannel` task).
  The values, the row order and the single catch-up write are unchanged. The tests "C1: catch-up of 100 pairs x 48 rows
  …" and "C1: a live write of 200 rows …" in `src/lib/scenario-ledger.test.mjs` measure the largest synchronous block
  (an event-loop heartbeat) and require ≤ 100 ms; it was about 6 s for the catch-up and about 0.28 s for the live write
  before the chunking, and is about 50 ms and 30 ms after. The recorder (Node, no UI) runs it in one pass and computes
  each row once (step 3c). At rest nothing is computed.
- **Writer limits.** `scenarioFields` writes `scb` as null when an edge is beyond ±5 and `scp` as null when σ_6 > 5 (after
  a crash of 90 % or more ATR/close can pass 2), and a row whose scenario work throws gets both null: these fields are
  logged only, so they must never make the strict import reject, or block the write of, a scored row.
- **Limits.** A flat or missing Fund trend, or too few similar moments, gives the coin's overall odds. The odds describe
  the past and carry no claim about the next bars.
