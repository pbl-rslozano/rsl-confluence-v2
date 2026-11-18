# Paper trading (assisted execution, paper only) — v2.8

Paper trading is a **simulator**. It lets you practise the routine the measurement gate asks for: take only STRONG score bands, size every trade by a fixed risk, respect hard limits, approve each trade yourself, and keep a journal you can check later against the recorded bars. STRONG score bands become **practice proposals**; the ledger has **not yet validated** them as a source of edge.

**No order is ever sent.** That covers real orders and exchange demo or testnet orders alike. The paper modules make no network calls and use no API keys, and no LLM takes part in any decision. The banner "Paper trading — simulated, no orders are sent" is always shown. See ADR-0010 for the boundary, and for the gate that must be passed before anything beyond paper is considered.

## How it works
1. **Proposal.** On each scan, every row with a **STRONG** BUY or SELL becomes a practice proposal: one per pair × signal bar × engine id. 1m–15m rows are context only unless you allow them (see Rules). A BUY is proposed as a long and a SELL as a short. A proposal carries:
   - a random 128-bit **nonce**;
   - an **expiry** at the close of the bar after the signal bar;
   - an optional **pre-trade reason** and a **setup tag** (Breakout, Trend, Reversal, Range, Other) that you can add before approving; both are kept in the journal and the CSV.
2. **Risk check.** The deterministic risk engine (`lib/risk-engine.ts`) evaluates the proposal. It lists **every** failed rule, not just the first one, together with the size, stop, target and risk amount.
3. **Approval by the owner.** Approve only works with the proposal's own nonce, and each nonce works once. A second click, a replay or an expired proposal is refused. At approval the risk engine **runs again** on the account as it is at that moment, because the state may have changed since the proposal was made. Rejecting a proposal also uses up its nonce. A decided signal is not proposed again.
4. **Fill (no look-ahead).** The position fills at the **open of the first bar that opens at or after the approval**, and never at the signal bar's close. This is the same rule as the signal ledger. In practice an approval made during bar *t+1* fills at the open of *t+2*. That is more conservative than the ledger's *t+1* open, because the open of *t+1* was already known when you approved. Stop and target keep their sized distances but are re-anchored to the fill price.
5. **Management on each closed bar.**
   - A gap through the stop exits at the open, which is worse than the stop price.
   - An optional **time stop** (off by default; 24 bars when you turn it on) exits at the next open after that many bars held.
   - If one bar touches **both** stop and target, the **stop** is assumed to have been hit first.
   - The position is marked to market at the bar's close.
6. **Manual close.** "Close at next open" exits at the open of the next bar. Closing an unfilled (pending) position cancels it.
7. **Journal.** Every closed trade is written to the journal with these fields: id, opened/closed, pair, side, size, entry, exit, stop, target, fees, funding, net P&L, R multiple, MAE and MFE (in R), exit reason (stop, target, manual, time stop or drawdown lock), pre-trade reason, setup tag, engine id, proposal id and `approvedBy: "owner"`. **Export CSV** writes the journal with a "simulated" notice line and a `simulated = paper` column.

## Costs
Costs come from the same table the ledger uses (`DEFAULT_COSTS`, base tier, taker, Oct 2026). Crypto pairs use the **measured order-book slippage** instead of the table's 5 bp when a reading for that pair is **less than 24 hours old**; an older reading is ignored and the table applies. The reading used is frozen on the position at approval.

| Source | Fee per side | Slippage per side | Funding |
|---|---|---|---|
| binance, bybit-spot, bitget | 10 bp | 5 bp | — |
| bybit-perp | 5.5 bp | 5 bp | 1 bp per 8 h, pro rata per bar held; longs pay, shorts receive |
| bitget-perp (v2.3) | 6 bp | 5 bp | 1 bp per 8 h, as above |

How each cost is applied:
- **Slippage** moves every fill against you. Stop and target exits are priced as taker fills too.
- **Fees** are charged on the notional at entry and at exit.
- **Funding** follows the same pro-rata model as the ledger, so paper results and ledger outcomes use the same cost model. That makes them comparable; it is not a reconciliation. Matching each closed paper trade to the recorded bars (reconciliation, ADR-0010 gate 3) is a **separate step**, and closed paper trades are not reconciled trades.

## Rules (all must pass)
| Rule | Default | Reason key |
|---|---|---|
| Kill switch off | — | `paper.rule.killSwitch` |
| Dead-man: a scan heartbeat for this source × timeframe within the last N bars | N = 3 | `paper.rule.deadMan` |
| Daily loss below X % of the start-of-day equity (UTC day); open losses count, not only closed ones | 2 % | `paper.rule.dailyLock` |
| Weekly loss below X % of the start-of-week equity (Monday 00:00 UTC); open losses count | 5 % | `paper.rule.weeklyLock` |
| Drawdown lock: equity (open P&L included) less than X % below its highest mark; clears only by typing `RESET` | 10 % | `paper.rule.drawdownLock` |
| Open positions (incl. pending) below the maximum | 5 | `paper.rule.maxPositions` |
| Open crypto positions below the maximum (crypto moves together) | 3 | `paper.rule.cryptoCap` |
| Open risk + this trade ≤ X % of equity | 2 % | `paper.rule.openRisk` |
| Positions per cluster below the maximum (cluster = asset class; crypto split into majors BTC/ETH and alts) | 2 | `paper.rule.cluster` |
| No open position on the same base asset (BTCUSDT and BTCUSDC are one exposure) | — | `paper.rule.duplicate` |
| Pair quoted in a USD-pegged stablecoin: the paper account is kept in USDT, so peso (Coins.ph) and other non-USD quotes cannot be proposed | — | `paper.rule.currency` |
| Quote stablecoin less than 1 % off its peg against USDT | 1 % | `paper.rule.depeg` |
| Not inside a macro event window: 2 h before to 1 h after FOMC, CPI or the US jobs report | on | `paper.rule.event` |
| Not a 1m–15m bar (context only) | off | `paper.rule.intradayContext` |
| No shorts on spot sources | off | `paper.rule.spotShort` |
| Signal age ≤ N bars after the signal bar closed | 1 | `paper.rule.stale` |
| \|score\| ≥ minimum | 55 | `paper.rule.score` |
| Not NEUTRAL; side matches the master direction | — | `paper.rule.neutral`, `paper.rule.sideMismatch` |
| Not suppressed | — | `paper.rule.suppressed` |
| Underlying market not closed for the whole signal bar (stock, FX, commodity tokens) | — | `paper.rule.underlyingClosed` |
| Valid price and ATR, and a stop above zero | — | `paper.rule.invalidInput` |
| Room left under the leverage cap (total notional ≤ X × equity; the cap itself can be set no higher than 1×) | 1× | `paper.rule.notional` |

## Sizing
```
stop distance   = stopAtrMult × ATR(14) of the signal bar            (default 2 × ATR)
target distance = targetRR × stop distance                          (default 2R)
units           = floor_to_lot_step( riskPerTradePct % × equity ÷ (stop distance + entry × round-trip cost) )   (default 0.5 %)
units           = min(units, room under maxLeverage × equity ÷ price)              (flagged "size reduced")
risk amount     = units × (stop distance + entry × round-trip cost)   (= 1R of this trade)
R multiple      = net P&L ÷ risk amount
```
The lot step is a power of ten worth at most about one quote unit, capped at one unit:

| Asset at price | Lot step |
|---|---|
| BTC at 100 000 | 0.00001 |
| ETH at 3 000 | 0.0001 |
| Asset at 0.5 | 1 |

Sizes are always rounded **down**, so a clean stop-out never loses more than the plan; a gap through the stop exits at the open and can lose more than 1 R. The round-trip cost (two fees plus two slippages) sits **inside** the risk budget, so a clean stop-out costs about **−1 R** rather than slightly more.

## Loss limits and what can break them
- **Daily and weekly locks** count open losses as well as closed ones, measured from the first equity mark of the UTC day or week.
- **Drawdown lock.** When equity, open P&L included, falls the set percentage (10 % by default) below its highest mark, new trades stop, every pending (unfilled) position is cancelled (discarded, not journalled), and every open trade is closed at the **next open of its own chart**. `RESET` (typed) clears it once every lock close has filled, keeps the loss and starts a fresh limit from current equity.
- **The 10 % is not a guaranteed maximum loss.** Gaps, exit costs, and a longer timeframe's wait for its next open (a 1d chart's close fills at the next daily open) can all take a loss past 10 %. The simulation cannot exit faster than the next bar.
- **No loosening while locked.** While the kill switch or any loss lock is active, and until the next UTC day after it clears, these changes are refused: raising a loss limit, the risk per trade, the open-risk cap or the leverage cap; raising the maximum open positions or the maximum open crypto positions; turning the event blackout off; allowing 1m–15m (intraday) proposals; lowering the minimum |score|. Tightening is always allowed. (Widened 18 Nov 2026, K-Dense v2 audit.)

## Kill switch and dead-man switch
**Kill switch** (manual):
- It blocks every new approval at once.
- It does **not** close anything. Open positions keep running against their stops and targets.
- Resetting it requires typing `RESET`.
- Engaging and resetting are both written to the audit trail.

**Dead-man switch** (automatic): the heartbeat is the most recent scan of a source × timeframe whose newest closed bar is current. If no heartbeat arrives for more than 3 bars:
- approvals on that series are blocked;
- its open positions are flagged **Unmanaged**.

When the scans resume, the positions catch up bar by bar, with the stop checked first on each bar.

## Audit trail
These events are written to the hash-chained audit trail:

| Event | When it is written |
|---|---|
| `paper.propose` | a proposal is created |
| `paper.approve` | the owner approves (records the position, size, stop, target, risk and a nonce prefix) |
| `paper.reject` | the owner rejects a proposal, or an approval is refused (nonce used, expired, or the risk check failed) |
| `paper.close` | a manual close is requested, a pending order is cancelled, or a position exits (stop, target or manual, with P&L and R) |
| `paper.kill` | the kill switch is engaged or reset |
| `paper.settings` | settings are changed |
| `paper.export` | the journal is exported |

## Storage
- **Collections:** `paper_state` holds one `account` document; `paper_positions` and `paper_journal` hold one document each per position and per trade.
- **Where it is stored:** in the browser, a **separate IndexedDB database** `rsl-conf-paper`, so the main database is never upgraded. In the native shells, the main SQLite port.
- **Write safety:** writes are queued, so they never interleave.
- **Backups:** the book is **not** part of `.rslbak` backups. Use Export CSV.

## What it does NOT do
- It does not place, stage or route any order (real, demo or testnet). It has no order API, no keys and makes no network call. A unit test checks the paper modules for network primitives and order vocabulary.
- It does not open or close a trade without the owner. Proposals are made automatically; approvals never are. Stops and targets are simulated exits.
- It does not model order-book depth beyond the measured slippage reading, partial fills, funding-rate history, liquidation, margin interest or borrow costs. Shorting spot is off by default for that reason, and leverage is capped at 1× until liquidation is modelled.
- It does not prove an edge. Paper results come from the same signals the ledger measures, so they carry the same biases, plus your own selection. Results are not financial advice.
- It does not keep positions updated while the app is closed. Bars that close in the meantime are processed on the next scan.

## Defaults at a glance
- **Risk:** 0.5 % per trade; open risk ≤ 2 %.
- **Positions:** at most 5, at most 2 per cluster, at most 3 crypto.
- **Loss locks:** daily 2 %, weekly 5 % (open losses count); drawdown lock 10 % with `RESET`.
- **Other gates:** macro event blackout on; 1m–15m context only; quote depeg gate at 1 %; time stop off (24 bars when on).
- The time stop is optional and off by default (builder's call, 18 Nov 2026; the owner may change the default).
- **Stop and target:** stop 2 × ATR, target 2R.
- **Signals:** |score| ≥ 55; fresh means at most 1 bar old.
- **Switches:** dead-man after 3 bars.
- **Leverage and shorts:** leverage 1× (the maximum); no spot shorts.
- **Account:** starting equity 10 000 USDT. This can only be edited while the book is empty.
- **Statistics (More statistics):** win rate with its 95 % Wilson range, profit factor, average MAE and MFE in R, and a histogram of trades by R multiple in 0.5 R bins. With fewer than 30 trades the figures are labelled too few to judge.

Settings are validated against fixed ranges (see `RISK_SETTING_LIMITS`). Invalid stored values fall back to the defaults.
