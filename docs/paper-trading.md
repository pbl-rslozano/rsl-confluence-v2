# Paper trading (assisted execution, paper only) — v2.3 (gap-report Phase G)

Paper trading is a **simulator**. It lets you practise the routine the measurement gate asks for: take only strong signals, size every trade by a fixed risk, respect hard limits, approve each trade yourself, and keep a journal you can reconcile later.

**No order is ever sent.** That covers real orders and exchange demo or testnet orders alike. The paper modules make no network calls and use no API keys, and no LLM takes part in any decision. The banner "Paper trading — simulated, no orders are sent" is always shown. See ADR-0010 for the boundary, and for the gate that must be passed before anything beyond paper is considered.

## How it works
1. **Proposal.** On each scan, every row with a **STRONG** BUY or SELL becomes a proposal: one per pair × signal bar × engine id. A BUY is proposed as a long and a SELL as a short. A proposal carries:
   - a random 128-bit **nonce**;
   - an **expiry** at the close of the bar after the signal bar.
2. **Risk check.** The deterministic risk engine (`lib/risk-engine.ts`) evaluates the proposal. It lists **every** failed rule, not just the first one, together with the size, stop, target and risk amount.
3. **Approval by the owner.** Approve only works with the proposal's own nonce, and each nonce works once. A second click, a replay or an expired proposal is refused. At approval the risk engine **runs again** on the account as it is at that moment, because the state may have changed since the proposal was made. Rejecting a proposal also uses up its nonce. A decided signal is not proposed again.
4. **Fill (no look-ahead).** The position fills at the **open of the first bar that opens at or after the approval**, and never at the signal bar's close. This is the same rule as the signal ledger. In practice an approval made during bar *t+1* fills at the open of *t+2*. That is more conservative than the ledger's *t+1* open, because the open of *t+1* was already known when you approved. Stop and target keep their sized distances but are re-anchored to the fill price.
5. **Management on each closed bar.**
   - A gap through the stop exits at the open, which is worse than the stop price.
   - If one bar touches **both** stop and target, the **stop** is assumed to have been hit first.
   - The position is marked to market at the bar's close.
6. **Manual close.** "Close at next open" exits at the open of the next bar. Closing an unfilled (pending) position cancels it.
7. **Journal.** Every closed trade is written to the journal with these fields: id, opened/closed, pair, side, size, entry, exit, stop, target, fees, funding, net P&L, R multiple, exit reason, engine id, proposal id and `approvedBy: "owner"`. **Export CSV** writes the journal with a "simulated" notice line and a `simulated = paper` column.

## Costs
Costs come from the same table the ledger uses (`DEFAULT_COSTS`, base tier, taker, Oct 2026):

| Source | Fee per side | Slippage per side | Funding |
|---|---|---|---|
| binance, bybit-spot, bitget | 10 bp | 5 bp | — |
| bybit-perp | 5.5 bp | 5 bp | 1 bp per 8 h, pro rata per bar held; longs pay, shorts receive |
| bitget-perp (v2.3) | 6 bp | 5 bp | 1 bp per 8 h, as above |

How each cost is applied:
- **Slippage** moves every fill against you. Stop and target exits are priced as taker fills too.
- **Fees** are charged on the notional at entry and at exit.
- **Funding** follows the same pro-rata model as the ledger, so paper results and ledger outcomes can be reconciled.

## Rules (all must pass)
| Rule | Default | Reason key |
|---|---|---|
| Kill switch off | — | `paper.rule.killSwitch` |
| Dead-man: a scan heartbeat for this source × timeframe within the last N bars | N = 3 | `paper.rule.deadMan` |
| Daily realised loss below X % of the start-of-day balance (UTC day) | 2 % | `paper.rule.dailyLock` |
| Weekly realised loss below X % of the start-of-week balance (Monday 00:00 UTC) | 5 % | `paper.rule.weeklyLock` |
| Open positions (incl. pending) below the maximum | 5 | `paper.rule.maxPositions` |
| Open risk + this trade ≤ X % of equity | 2 % | `paper.rule.openRisk` |
| Positions per cluster below the maximum (cluster = asset class; crypto split into majors BTC/ETH and alts) | 2 | `paper.rule.cluster` |
| No open position on the same pair | — | `paper.rule.duplicate` |
| No shorts on spot sources | off | `paper.rule.spotShort` |
| Signal age ≤ N bars after the signal bar closed | 1 | `paper.rule.stale` |
| \|score\| ≥ minimum | 55 | `paper.rule.score` |
| Not NEUTRAL; side matches the master direction | — | `paper.rule.neutral`, `paper.rule.sideMismatch` |
| Not suppressed | — | `paper.rule.suppressed` |
| Underlying market not closed for the whole signal bar (stock, FX, commodity tokens) | — | `paper.rule.underlyingClosed` |
| Valid price and ATR, and a stop above zero | — | `paper.rule.invalidInput` |
| Room left under the leverage cap (total notional ≤ X × equity) | 1× | `paper.rule.notional` |

## Sizing
```
stop distance   = stopAtrMult × ATR(14) of the signal bar            (default 2 × ATR)
target distance = targetRR × stop distance                          (default 2R)
units           = floor_to_lot_step( riskPerTradePct % × equity ÷ stop distance )   (default 0.5 %)
units           = min(units, room under maxLeverage × equity ÷ price)              (flagged "size reduced")
risk amount     = units × stop distance   (= 1R of this trade)
R multiple      = net P&L ÷ risk amount
```
The lot step is a power of ten worth at most about one quote unit, capped at one unit:

| Asset at price | Lot step |
|---|---|
| BTC at 100 000 | 0.00001 |
| ETH at 3 000 | 0.0001 |
| Asset at 0.5 | 1 |

Sizes are always rounded **down**, so the risk taken never exceeds the plan.

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
- It does not model order-book depth, partial fills, funding-rate history, liquidation, margin interest or borrow costs. Shorting spot is off by default for that reason.
- It does not prove an edge. Paper results come from the same signals the ledger measures, so they carry the same biases, plus your own selection. Results are not financial advice.
- It does not keep positions updated while the app is closed. Bars that close in the meantime are processed on the next scan.

## Defaults at a glance
- **Risk:** 0.5 % per trade; open risk ≤ 2 %.
- **Positions:** at most 5, and at most 2 per cluster.
- **Loss locks:** daily 2 %, weekly 5 %.
- **Stop and target:** stop 2 × ATR, target 2R.
- **Signals:** |score| ≥ 55; fresh means at most 1 bar old.
- **Switches:** dead-man after 3 bars.
- **Leverage and shorts:** leverage 1×; no spot shorts.
- **Account:** starting equity 10 000 USDT. This can only be edited while the book is empty.

Settings are validated against fixed ranges (see `RISK_SETTING_LIMITS`). Invalid stored values fall back to the defaults.
