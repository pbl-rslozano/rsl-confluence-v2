# ADR-0010 — Assisted execution: paper only

**Status:** Accepted · 31 Oct 2026 · v2.3 (gap-report Phase G)

## Context
The measurement layer (ADR-0007) can show whether signals beat chance after costs. It cannot show whether the owner can *trade* them with discipline: taking only qualifying signals, sizing by fixed risk, respecting loss limits, and leaving losers to the stop. That gap is behavioural, and it can be closed without any exchange connection.

Placing orders, even demo or testnet orders, would add credentials, a network surface (ADR-0003 allows three read-only market-data hosts), regulatory questions for the owner's jurisdiction (KSA), and the risk that a bug acts on real money. The current evidence does not justify any of that.

## Decision
1. **Paper only.** Phase G is a simulator: `lib/risk-engine.ts`, `lib/paper-broker.ts`, `lib/paper-store.ts` and `components/paper-dialog.tsx`.
   - It places no orders of any kind (real, demo or testnet).
   - It makes no network calls and holds no API keys.
   - It does not import `market-client` or `private-api`.
   - No LLM is in the decision path.
   A unit test fails if network primitives or order and API-key vocabulary appear in the paper modules.
2. **The owner decides; rules constrain.** Proposals are generated automatically from STRONG signals. Each needs an explicit owner approval, bound to a single-use nonce that expires at the next bar close. The deterministic risk engine runs at proposal time and **again** at approval time.
3. **Same no-look-ahead rule as the ledger.** A trade fills at the open of the first bar that opens after the approval. Costs come from `DEFAULT_COSTS`, and funding uses the ledger's pro-rata model. When a bar touches both levels, the stop is assumed to have been hit first.
4. **Hard stops on behaviour.**
   - Daily and weekly realised-loss locks.
   - Caps on positions, open risk and clusters.
   - A manual kill switch, reset only by a typed confirmation.
   - A dead-man switch: more than 3 bars without a scan heartbeat blocks approvals and flags positions as unmanaged.
5. **Separate storage.** A separate IndexedDB database `rsl-conf-paper` in the browser and the main SQLite port in the shells. The book is excluded from `.rslbak` backups and exported as CSV.
6. **Audit.** The events `paper.propose`, `paper.approve`, `paper.reject`, `paper.close`, `paper.kill`, `paper.settings` and `paper.export` go to the hash-chained audit trail.

## Gate to anything beyond paper
No code that can send an order may be added (no exchange order endpoint, no demo or testnet trading) until **all three** of these hold, recorded in a new ADR that supersedes this one:
1. **G1 passed.** The measurement gate in `docs/measurement.md` passes on forward-recorded live data for the timeframe and asset class concerned:
   - at least 200 measured signals;
   - positive edge after costs, still positive at 2× costs;
   - rank-IC t ≥ 2;
   - PSR ≥ 0.95.
   This must hold on the current engine id, and it must be confirmed out of sample by replay.
2. **KSA eligibility confirmed.** The owner has confirmed in writing that the venue, the product (spot or perpetual) and automated or assisted order placement are permitted for a KSA resident. This covers CMA rules and the venue's own terms and onboarding.
3. **50 paper/demo trades reconciled.** At least **50** closed paper trades from this simulator have been reconciled against the ledger. Reconciled means each trade's fill, exit and costs were matched to the recorded bars, and the realised R distribution is consistent with the ledger's expectancy for the same signals. The dialog shows progress as "n of 50".

Passing the gate allows a design review; it does not grant permission. Any later step would still need its own threat model, as follows:
- **Key storage:** keys stay out of app storage, as in ADR-0002.
- **Permissions:** an order-only, withdrawal-disabled key with an IP allowlist.
- **Rate limits.**
- **Least-privilege network allowlist:** an amendment to ADR-0003.

## Consequences
- The owner can practise the full routine (proposal, check, approval, management, journal) at no risk to capital.
- Paper results inherit the ledger's biases, listed in `docs/measurement.md`, and add the owner's own selection. They are a discipline record, not evidence of edge.
- Positions update only while the app scans. Gaps are processed on the next scan, and the dead-man flag makes them visible.
- Adding 127 i18n keys per catalog (`paper.*`); 16 tier-2 catalogs stay DRAFT until reviewed.
