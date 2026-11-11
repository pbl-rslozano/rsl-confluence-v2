## Code Review: rsL Confluence Terminal v2.2

*Reviewed tree: `/home/claude/rsl-confluence`, snapshot taken 31 Oct 2026 12:54 (+03). The repository was being edited while this review ran (12:47–12:52: cfg filtering in the ledger dialog, the `uc` ledger field, NYSE holidays, `assetClass` forwarding through the proxy, background catch-up recording, a macro calendar). Every line number below refers to that 12:54 snapshot. Findings that those edits had already fixed are listed under "What Looks Good". No repository files were modified. Tests at the snapshot: engine 37/37, measurement 95/95, FVG 21/21, i18n 18 × 198 keys, all passing. Numeric claims marked "verified" come from probe scripts run against the snapshot's own modules (`/tmp/claude-0/-home-claude/4c0e2d66-8ed0-52aa-8dc9-68bbbc857be0/scratchpad/lib/probe.mjs`, `bench.mjs`).*

### Summary
The v2.2 measurement layer has a sound core. Entry is at the next bar's open, only closed bars are used, there is one scoring path, and the engine id is the same in the browser and in Node. However, its significance statistics treat heavily overlapping outcomes as independent: the "go/no-go" gate passes pure noise about half the time. The live scan also scores and records series whose fetch failed, using cached data, and the ledger store and report break or slow down sharply at realistic ledger sizes.

### Critical Issues
| # | File | Line | Issue | Severity |
|---|---|---|---|---|
| 1 | apps/confluence/web/src/lib/ledger-metrics.ts | 218–233, 268, 346 (gate: components/ledger-dialog.tsx 107–120) | PSR, group t-stat and rank-IC t-stat assume i.i.d. observations. Ledger outcomes overlap: every bar is recorded, so at h = 24 consecutive rows share 23 of 24 bars, and they are also correlated across pairs. Verified: on a driftless random walk, an always-long h = 24 series gives PSR ≥ 0.95 in 101/200 windows. With non-overlapping sampling the rate is 6/200. | 🔴 Critical |
| 2 | apps/confluence/web/src/app/page.tsx | 551–567, 587–622, 627–653 | Symbols whose fetch failed this scan (stale feed, HTTP error, or skipped after a rate-limit halt) get `recent = []`. They are then scored from IndexedDB history, shown as current signals and recorded as `live: 1` ledger rows (catch-up included). This bypasses the Build 1.9 freshness gate (market-client.ts 423–433). | 🟠 High |
| 3 | apps/confluence/web/src/lib/ledger-metrics.ts | 356–357 | `Math.min(...times)` / `Math.max(...times)` throws `RangeError` above about 125k rows (verified: OK at 120k, throws at 130k). `measure()` in ledger-dialog.tsx 66–96 has no catch, so the Performance view goes blank once the sample becomes meaningful. | 🟠 High |
| 4 | apps/confluence/web/src/lib/signal-ledger.ts | 86–111 | Each record() re-reads and rewrites the whole (day, source, tf, cfg) bucket. One row is about 382 B (verified), so 200 pairs give 1.8 MB/day at 1h, 22 MB/day at 5m and 110 MB/day at 1m. That bucket is rewritten every 30–60 s, plus a JSON deep clone in the IndexedDB adapter, so the cost is O(n²) per day. | 🟠 High |
| 5 | apps/confluence/web/src/lib/ledger-metrics.ts | 120–122 | The contiguity check allows a 5 % span tolerance, so for h ≥ 20 one missing bar passes. Verified: h = 20 and h = 24 are measured across a hole (spans of 21 h and 25 h). h = 24 is a default horizon. | 🟡 Medium |
| 6 | apps/confluence/web/src/app/page.tsx; apps/confluence/web/src/lib/scan-jobs.ts | 627–653; 59–80 | Catch-up starts with `since = 0` on every session, i.e. 200 × 48 ≈ 9,600 scorings (about 46 s of CPU at 4.8 ms each). This runs in the same FIFO worker ahead of the next live scan. If the worker fails, runScanJobs falls back to the main thread and freezes the UI. Catch-up windows (and first-scan live rows, 999 bars) are shorter than ENGINE_BARS, so they are not identical to replay. `lastRecordedRef` advances before success. | 🟡 Medium |
| 7 | apps/confluence/web/src/lib/signal-ledger.ts | 103, 109–110 (swallowed at page.tsx 622) | With a localStorage port, `put` throws QuotaExceeded before `prune` runs, so retention never frees space and the ledger stops recording permanently, without any message. Verified: the newest recorded day stayed 13 days behind today. | 🟡 Medium |
| 8 | apps/confluence/web/src/lib/signal-ledger.ts | 62, 83–115, 142–150 | `clear()` is not serialised through `queue`, so a scan finishing during Clear interleaves its index and bucket writes with the deletes. The queue is also per JS instance, so two tabs or windows lose read-modify-write updates on the same bucket. | 🟡 Medium |
| 9 | apps/confluence/web/src/lib/market-client.ts | 244–255 | Bybit signals an IP rate-limit ban with HTTP 403 ("access too frequent", 10-minute ban). This is treated as a generic error, so the scan keeps firing about 200 requests into an active ban. | 🟡 Medium |
| 10 | apps/confluence/web/src/lib/replay.cli.mjs | 123; 69–89 | Replay windows are never trimmed with `contiguousTail`, so live and replay diverge for up to 1,000 bars after any exchange gap. `readCsvDir` keys files only by symbol, so 1h and 4h CSVs of one symbol are merged into one series. | 🟡 Medium |
| 11 | apps/confluence/web/src/lib/scan-runner.ts; scan.worker.ts | 51–67; 13–18 | No timeout and no cancellation. A worker that never answers leaves `load()` pending with Refresh disabled. Aborted scans still occupy the worker. One throwing job fails the whole batch, and the main-thread fallback re-throws, so the entire scan errors. | 🟡 Medium |
| 12 | apps/confluence/web/src/components/ledger-dialog.tsx; app/page.tsx | 66–103; 816 | `liveKlines` gets a new identity on every scan. While the dialog is open, each refresh re-runs `store.all()` over the whole ledger plus up to 200 IndexedDB history loads. `busy` hides the report on every refresh, and overlapping measures are not cancelled. | 🟡 Medium |
| 13 | apps/confluence/web/src/lib/engine-config.ts | 119–137 | The behaviour fingerprint calls `runConfluence` directly on ≤ 600 bars. It never exercises `scoreSeries`: the ENGINE_BARS slice, the FX `lowVolatilityCap: false`, or `hasUsableVolume` (0.8 / 200 rule). Changes there keep the same configId, contrary to docs/measurement.md. | 🟡 Medium |
| 14 | apps/confluence/web/src/app/page.tsx | 736 | Backfill re-scores with no `assetClass` and with `volumeAvailable: true`. An FX pair then shows a low-volatility-capped strength, which differs from the scan path, until the next refresh. | 🟡 Medium |
| 15 | .github/workflows/release.yml | 118–122 | `if: ${{ env.ANDROID_KEYSTORE_B64 != '' }}` cannot see that step's own `env`, so the keystore is never decoded. Gradle then builds unsigned release artifacts on tags without any error (apply-native-config.mjs 36–49). | 🟡 Medium |
| 16 | apps/confluence/web/src/rsl/boot.ts; rsl/app-info.ts | 109, 116–119; 21 | v2.2 adds the `ledger` collection, which forces an IndexedDB version upgrade. Any open v2.1 tab blocks it, and the Core Kit then falls back to localStorage without telling the user (identity, preferences and audit appear reset). The pre-migration safety snapshot (localStorage) now includes the ledger and is skipped once it exceeds the quota. | 🟡 Medium |

### Suggestions
| # | File | Line | Suggestion | Category |
|---|---|---|---|---|
| S1 | apps/confluence/web/src/app/page.tsx; lib/history-store.ts | 551–567; 52–96 | Per symbol per scan: 3 IndexedDB opens, 2 reads and 1 write of up to 10,000 bars. Reuse one connection, keep an in-memory series cache and append only new bars. | Performance |
| S2 | apps/confluence/web/src/app/page.tsx; lib/scan-runner.ts | 575–581, 634–645; 60 | Full stored history (up to 10k bars) is packed, packed again for catch-up, and `.slice()`-copied before transfer. Pack once, transfer the original, and re-pack from `kl` only on fallback. | Performance |
| S3 | apps/confluence/web/src/lib/market-client.ts | 279, 537–560 | One request returns at most 1,000 bars including the forming one, so 999 closed bars. Synthetic 4d gets 250 bars and 1M about 100, so those ledgers stay "cold" (< 300) forever. Page the history, or say in the dialog why there is no data. | Correctness / UX |
| S4 | apps/confluence/web/src/app/api/market/all/route.ts | 82–86 | The server always fetches and returns 1,000 bars plus MACD histograms for every symbol (tens of MB per response at 200 pairs, every 15 s TTL on 1m). Send only new bars to clients that already hold the window. | Performance |
| S5 | apps/confluence/web/src/lib/ledger-metrics.ts | 136, 274 | Net includes funding, but the base rate subtracts only fee + slippage. On perps this biases edge against longs and in favour of shorts (about 12 bp at 4h, h = 24). Subtract expected funding from the base too. | Correctness |
| S6 | apps/confluence/web/src/lib/ledger-metrics.ts | 334–339 | IC needs at least 5 pairs per cross-section. The documented 3-symbol replay example therefore always reports IC "—" and the gate can never pass. Document this, or fall back to time-series IC. | Correctness / Docs |
| S7 | apps/confluence/web/src/lib/replay.cli.mjs | 151 | No purge or embargo: in-sample rows within h bars of `--oos` are measured on out-of-sample prices. Drop rows with `t + h·interval ≥ oos` from the in-sample set. | Correctness |
| S8 | apps/confluence/web/src/lib/replay.cli.mjs | 120–124 | O(n·W): about 4.8 ms per bar (verified), so about 85 s per symbol for 2 years of 1h. Use `worker_threads` per symbol. | Performance |
| S9 | apps/confluence/web/src/components/ledger-dialog.tsx | 66–96 | Add catch, an error message and a generation/abort guard to `measure()`. | Maintainability |
| S10 | apps/confluence/web/src/lib/signal-ledger.ts | 61 | `seen` grows without bound (288k ids/day at 1m × 200). Prune it by day. | Performance |
| S11 | apps/confluence/web/src/lib/signal-ledger.ts | 51–55 | IndexedDB gets 400-day "durable" retention, but the Core Kit marks it `durable: false` (evictable; WKWebView cap). Check `navigator.storage.persisted()` and warn. | Maintainability |
| S12 | tools/release-check.mjs | 111–113 | The R8 web half reads `layout.tsx`, which has no `connect-src` (it moved to `src/lib/csp.ts`), so the check always passes. Parse `CONNECT_SRC` from csp.ts. | Security / CI |
| S13 | tools/e2e/acceptance.cjs | 347, 295 | M-4 is tautological (`… \|\| workers.length > 0`). BLD-9.4-11a asserts ≤ 17 s for a "≤ 2 s" budget. There are no checks for worker failure, stale symbols or Bybit 403. | Test coverage |
| S14 | apps/confluence/web/src/lib/market-client.ts | 542, 615, 676, 837–842 | Symbols from the exchange go into URLs without encoding. Validate `/^[A-Z0-9]{2,30}$/` at the ticker boundary and use `encodeURIComponent`. | Security (hardening) |
| S15 | apps/confluence/web/src/lib/scan-pipeline.ts | 31–46 | `suppressedConfluence` hard-codes neutral/excluded = 20, but the panel has 21 indicators of which 18 vote, so the B/N/S column reads 0/20/0. | Maintainability |
| S16 | apps/confluence/web/src/lib/asset-classes.ts | 59, 74 | Dead entry `LINKUSDT_RWA` (no ticker can match it). `SQ` (Block has traded as XYZ since Jan 2025). Date the curated lists and test them against venue snapshots. | Maintainability |
| S17 | apps/confluence/web/src/lib/measure.test.mjs | — | Missing tests: h ≥ 20 gap, more than 125k-row report, stale-symbol scan, clear/record interleave, localStorage quota, catch-up `wb`, replay contiguity. | Test coverage |

### What Looks Good
- **No look-ahead in outcomes or replay.** Entry is `k[i+1].open` and exit `k[i+h].close` (ledger-metrics.ts 112–139). The replay window ends at bar `i` (replay.cli.mjs 123). `dropUnclosed` is applied on every fetch path, including history and the acceptance mock's forming bar.
- **Statistics formulas are correct.** A-S 7.1.26 `normCdf`, Acklam `normInv`, the PSR denominator `1 − γ₃SR + (γ₄−1)/4·SR²` and the Bailey–López de Prado expected-max SR₀ all check out. Verified: normCdf(−6) = 9.90e-10 against a true value of 9.87e-10. Spearman ties are handled.
- **DST transitions are exact.** Verified at 2026-03-08 07:00Z and 2026-11-01 06:00Z. NYSE holidays and early closes are now modelled through 2028 with an end-of-table constant.
- **Engine id stays the same across runtimes.** Hashing the indicator count instead of minified function names, and using an arithmetic-only fingerprint series, are both well judged. The id is pinned in tests and checked in the browser by M-8b.
- **Already fixed during the review (verified in the snapshot):**
  - The ledger dialog now pools only `cfg === engineConfigId()` and reports rows from other engines separately (ledger-dialog.tsx 71–75).
  - The proxy forwards `assetClass`.
  - Rows carry `uc` (underlying closed).
- **CSV export is injection-safe.** `toCSV`/`safeCell`, and an identical `safe()` in the replay, prefix `= + - @` and control characters, and numbers keep their sign.
- **Rate-limit handling is good.** 429/418 and Bybit/Bitget error envelopes halt the scan, partial results are kept, and the cooldown is module-wide and tested.
- **Leveraged-token fix works.** Verified: JUP, SYRUP, API3, C98 and 1000SATS stay crypto, while 3L/3S and the listed UP/DOWN tokens are excluded.
- **Worker fallback keeps the caller's arrays intact.** The CSP has `worker-src 'self'` in both the web and Tauri policies.

### Verdict
**Request Changes.** Fix #1 before the in-app gate is used to justify any automation. Fix #2–#4 before the ledger is relied on for more than a few weeks or on timeframes below 1h.

---

## Details

**#1 Overlap-inflated significance (ledger-metrics.ts 218–233, 268, 346).**
- *What happens:* every scored bar becomes a row, so at h = 24 on 1h bars consecutive outcomes share 23 of 24 bars. Rows from 100–200 pairs at the same timestamp are also strongly correlated. `sharpeStats` uses `√(n−1)`, `groupStats` uses `√n` and the IC t-stat uses `√periods`, all as if each observation were independent.
- *Failure scenario (verified):* on a driftless random walk, a strategy that is always long at h = 24 reaches PSR ≥ 0.95 in 101 of 200 random 1000-bar windows. Sampling every 24th bar instead gives 6 of 200; h = 1 also gives 6 of 200. The dialog gate (n ≥ 200, edge > 0, IC t ≥ 2, PSR ≥ 0.95) will therefore show "pass" on noise during any trending month.
- *Fix:*
  - Compute the statistics on non-overlapping samples (every h-th bar per pair), or use Newey–West / Hansen–Hodrick standard errors with lag h−1.
  - Aggregate cross-sections first: one mean return per timestamp, then the time-series t over timestamps.
  - Show the effective N, and pass `trials` (the DSR) in the app as well as in the replay.

**#2 Stale or skipped series scored from cache (page.tsx 551–567, 587–622, 627–653).**
- *What happens:* `fetchDirectMarketData` keeps every ticker but omits klines for symbols that failed. That includes the whole tail skipped after a 429 halt (market-client.ts 746–752) and every `StaleFeedError`. `load()` then merges `saved` with `recent = []`, scores the cached series, renders it as a normal BUY/SELL and records it with `live: 1`, the current `rk` and the current `qv`. It is also fed to catch-up with `since = 0`.
- *Failure scenario:* after a rate-limit halt at symbol 30 of 200, 170 rows show signals from the last session (possibly days old) with no stale badge. The ledger also gains "live" rows for old bars, ranked by today's universe.
- *Fix:* when `recent.length === 0`, mark the row stale (badge it, set `usable: false`) and record no ledger row. Alternatively, run `assertFresh` on the merged `kl` before scoring.

**#3 Report crashes on large ledgers (ledger-metrics.ts 356–357).**
- *What happens:* V8 cannot spread more than about 125k arguments (verified: 120k works, 130k throws "Maximum call stack size exceeded").
- *Failure scenario:* 200 pairs on 1h produce 4,800 rows a day, so the limit is reached after about 27 days of scanning. On 15m it takes about 7 days. `measure()` has no catch, so `busy` clears and the dialog shows nothing, exactly when the sample becomes large enough to matter.
- *Fix:* compute min and max in a loop (`for (const r of rows) …`). Also stop sorting the whole multi-source ledger with `localeCompare` in `all()`. Instead, add `all({ src, tf, cfg })` that loads only the matching bucket ids from the index.

**#4 Whole-bucket rewrite per scan (signal-ledger.ts 86–111).**
- *What happens:* each scan adds about one row per pair but rewrites the entire day bucket. The IndexedDB adapter also deep-clones the bucket through JSON (rsl-storage.js 84). A 5m bucket reaches about 22 MB by the evening and is read, cloned and written every 30 s; 1m reaches about 110 MB. Expect main-thread jank, write amplification and, on WKWebView, quota eviction.
- *Fix:* bucket by (hour for tf < 1h, day otherwise), or store one document per (series, day), or use a real SQLite table (`rsl_docs` already exists natively) with an `INSERT … ON CONFLICT DO NOTHING` per row.

**#5 Gap tolerance at long horizons (ledger-metrics.ts 120–122).**
- *What happens:* `maxSpan = h·interval·1.05`. One missing bar gives a span of (h+1)·interval, which is accepted whenever h ≥ 20.
- *Failure scenario (verified):* with bar 15 missing, a row at bar 10 is measured at h = 24 over 25 hours, and the entry may fall after the hole. The doc promise "no outcome across a hole" is broken for the default 24-bar horizon.
- *Fix:* for fixed intervals require `span === h·interval` exactly (exchanges align bars); keep the calendar rule only for 1M. Also check that `k[i+1].time − k[i].time === interval` so the entry is the immediately next bar.

**#6 Catch-up cost and fidelity (page.tsx 627–653; scan-jobs.ts 59–80).**
- *What happens:* `lastRecordedRef` is session memory, so every session start scores the last 48 bars of every series again (about 9,600 `scoreSeries` calls, about 46 s of worker CPU). That work is already in the ledger and is deduplicated only at write time. It sits in the worker queue ahead of the next live scan; at the 30 s cadence on 1m or 5m the table stays stale for about a minute.
- *Second failure:* if the worker errors during catch-up, `runScanJobs` silently runs all 9,600 jobs on the main thread.
- *Third failure:* windows for bar j have only j+1 bars when `kl` ≤ 1,000, so `wb` is 952–999. These rows are pooled with replay rows scored on 1,000 bars. First-scan live rows are 999 bars because the forming bar is dropped from a 1,000-bar fetch.
- *Fix:*
  - Derive `since` from the ledger: store a `{series: newestT}` map in the ledger index.
  - Never fall back to the main thread for catch-up (pass a `noFallback` flag).
  - Fetch ENGINE_BARS + 48 + 1 bars when catch-up is needed, and skip catch-up rows with `wb < ENGINE_BARS`.
  - Advance `lastRecordedRef` only after `record()` resolves.

**#7 localStorage ledger freezes (signal-ledger.ts 103, 109–110).**
- *What happens:* the order is put bucket → prune → put index. Once the 5 MB quota is reached, the first `put` throws, so `prune` never runs and every later `record()` throws again. page.tsx 622 swallows the error.
- *Failure scenario (verified with a quota-limited port):* the newest stored day stayed at 2026-10-18 on 2026-10-31. Fourteen-day retention is unreachable anyway: one hour-level day for 200 pairs is about 1.8 MB.
- *Fix:* prune before writing, catch `QuotaExceededError` and drop the oldest bucket, then retry once. Surface a "ledger paused: storage full" notice. On localStorage, cap the ledger by bytes rather than days.

**#8 Clear and multi-tab races (signal-ledger.ts 62, 83–115, 142–150).**
- *What happens:* `clear()` awaits the current queue but does not put itself on it. A `record()` that starts during clear can read the old index, write a bucket after clear's `list()`, then write an index after clear's empty index. The result is phantom rows in `stats()`, or rows in `all()` that the index does not list. Separately, two PWA windows each hold their own `queue`, so concurrent read-modify-writes of the same day bucket lose one side's rows.
- *Fix:* route `clear` (and `stats`/`all`) through `queue`. Wrap each bucket read-modify-write in `navigator.locks.request("rsl-ledger", …)` where available, or use per-row documents so writes commute.

**#9 Bybit 403 ban not recognised (market-client.ts 244–255).**
- *What happens:* Bybit's V5 rate-limit rules return HTTP 403 "access too frequent" and ban the IP for about 10 minutes. `fetchJson` throws a plain Error, `classify` labels it "HTTP", and the batch loop carries on through all 200 symbols, extending the ban.
- *Fix:* when the host is api.bybit.com and the status is 403, throw `RateLimitError` with a 600_000 ms retry. Add a test next to the existing 10006 case.

**#10 Replay ≠ live after gaps; CSV interval mixing (replay.cli.mjs 123, 69–89).**
- *What happens:* live scoring always runs `contiguousTail`, so after an exchange outage the live window restarts and is shorter than 1,000 bars. Replay slices 1,000 bars straight across the hole.
- *Failure scenario:* the claim "a replayed row and a live ledger row for the same bar are identical" fails for up to 1,000 bars after every gap. Separately, `--csv-dir` holding `BTCUSDT-1h-*.csv` and `BTCUSDT-4h-*.csv` merges both into one series, because the symbol is the only key.
- *Fix:* `const window = contiguousTail(k.slice(...), intervalMs)`. Parse `SYMBOL-INTERVAL-` and keep only files whose interval equals `--tf`.

**#11 Worker without timeout or isolation (scan-runner.ts 51–67; scan.worker.ts 13–18).**
- *What happens:* no watchdog exists, so if a worker never answers (OOM-killed, a WebView quirk), `runScanJobs` never settles. `loading` stays true and the Refresh button stays disabled. Superseded scans cannot be cancelled and keep the worker busy. The worker wraps all jobs in one try, so one throwing series fails the batch; `runOnMain` then throws the same error and `load()` shows a global error for the whole universe.
- *Fix:*
  - Add a timeout (for example 20 s plus 50 ms per job) that terminates the worker and falls back.
  - Accept an `AbortSignal` and post `{cancel: id}`.
  - Catch per job in both paths and return `{ key, error }` so a single series shows "unavailable".

**#12 Dialog recomputes every scan (ledger-dialog.tsx 66–103; page.tsx 816).**
- *What happens:* `liveKlines` is a new object on every `setRows`, so `measure` is recreated and the effect re-runs on every refresh while the dialog is open. Each run means a full `store.all()` across every source and timeframe, a sort, up to 200 `loadHistoricalSeries` calls and a rebuilt report; `busy` hides the table each time.
- *Fix:* measure on open and on an explicit "Refresh" button only, or key the effect on `lastUpdate` with a debounce. Keep the previous report visible while busy, and guard with a generation counter.

**#13 Fingerprint misses the scoring pipeline (engine-config.ts 119–137).**
- *What happens:* the fingerprint uses `runConfluence(k, { volumeAvailable: true })` on 120–600 bars. Changing `hasUsableVolume` (the 0.8 share and the 200-bar tail), the FX `lowVolatilityCap` rule or the window-slicing logic in `scoreSeries` leaves the configId unchanged. Rows from different behaviours would then pool, contrary to "Any change to … window changes it".
- *Fix:* fingerprint through `scoreSeries` on a 1,200-bar series, in three variants: crypto, FX (`assetClass: "fx"`) and a zero-volume copy. Repin the test.

**#14 Backfill scores with a different profile (page.tsx 736).**
- *What happens:* `runScanJobs([{ …, volumeAvailable: true }])` omits `assetClass`. For an FX pair, `lowVolatilityCap` is back on, so a STRONG reading can display as MODERATE in the detail view and table until the next scan overwrites it.
- *Fix:* pass `assetClass: asset.assetClass` and the series' detected volume flag, the same as `load()`.

**#15 Android signing step never runs (release.yml 118–122).**
- *What happens:* a step's own `env:` is not in scope for that step's `if:`, and `secrets` cannot be used in `if` directly, so the condition is always false. `RSL_KEYSTORE` then points at a file that does not exist, `rslSigned` is false, and `bundleRelease` produces unsigned .aab and .apk files that are uploaded as release artifacts.
- *Fix:* set `env: HAS_KEYSTORE: ${{ secrets.ANDROID_KEYSTORE_B64 != '' }}` at job level and use `if: env.HAS_KEYSTORE == 'true'`. On tag builds, fail the job when signing is expected but absent.

**#16 New collection triggers a silent storage fallback (boot.ts 109, 116–119; app-info.ts 21).**
- *What happens:* adding `ledger` makes `createIndexedDBAdapter` reopen the database at version + 1. The Core Kit rejects on `onblocked` and registers no `onversionchange` handler, so any still-open v2.1 tab or installed-PWA window blocks the upgrade. `openStorage` then picks localStorage: the user sees a first-run wizard and an empty audit trail, while the real data sits untouched in IndexedDB. Separately, the pre-migration snapshot exports every collection, the ledger included, into one localStorage key. Once the ledger exceeds about 5 MB, the safety snapshot is silently skipped.
- *Fix:* in boot, detect the "upgrade blocked" message and show a "close other Confluence tabs" prompt instead of falling back (the Core Kit itself is hash-pinned). Exclude `ledger` from the pre-migration local snapshot, and keep it only in the user-initiated `.rslbak`.

**S1 History-store I/O per scan.** For 200 symbols every 30 s: 600 `indexedDB.open` calls, 400 reads and 200 rewrites of up to 10k-bar arrays. Keep a module-level `IDBDatabase`, cache series in memory per session, and write only the new tail.

**S2 Redundant copies.** `packKlines(kl)` (up to 480 KB per symbol), then `.slice()` in scan-runner, then a second pack for catch-up. Transfer the packed buffer itself and rebuild from `kl` only on fallback.

**S3 Cold timeframes.** A 1,000-bar fetch returns 999 closed bars, aggregated 4d gives 250 bars, and most 1M and 1w series are under 300. Those ledgers can never produce statistics. Page backwards to ENGINE_BARS on first contact (`fetchHistory` exists), or state "needs ≥ 300 bars" in the dialog.

**S4 Server payload.** The route always fetches 1,000 bars. That fixes warm-up for proxy clients, but the full 1,000-bar arrays plus histograms are serialised to every client on every refresh. Add `since`/`klineLimit` to the API and return only the bars the client lacks.

**S5 Funding in the base rate.** On bybit-perp, `edgeBps` compares net (with funding) against a base that ignores funding, which misstates edge by `funding × hold` in the direction's favour or against it. Include `dir × expected funding` in the base adjustment.

**S6 IC with few pairs.** `list.length < 5` skips every cross-section of the documented 3-symbol replay, so IC = NaN and the gate fails by construction. Document a 5-pair minimum, or report a pooled time-series IC when there are fewer pairs.

**S7 OOS leakage.** In-sample rows near `--oos` use outcome bars after `oos`. Purge rows whose horizon ends after the split, and embargo h bars.

**S8 Replay speed.** About 85 s per symbol per 2 years of 1h bars on this machine. Parallelise symbols with `worker_threads`, and/or score on `--step` by default for exploratory runs.

**S9 Dialog error handling.** Wrap `measure` in try/catch, show an error string, and ignore results from a superseded run.

**S10 `seen` growth.** Keep `seen` per day bucket and drop old days, or replace it with a newest-t per series.

**S11 IndexedDB retention.** The Core Kit marks IndexedDB as best-effort. Pair the 400-day retention with `navigator.storage.persisted()`, and remind the user to back up when persistence is not granted.

**S12 Vacuous R8.** release-check reads `layout.tsx` for `connect-src`, but the policy lives in `src/lib/csp.ts`. Today the web half of R8 can never fail. Parse `CONNECT_SRC` from csp.ts.

**S13 Acceptance gaps.** M-4 passes with any worker. BLD-9.4-11a's threshold is 17 s. Add checks that block `scan.worker` (expect main-thread fallback and rows rendered), make one symbol stale (expect no signal and no ledger row), and return Bybit 403.

**S14 Symbol hygiene.** Ticker symbols from exchange JSON are used unencoded in query strings and as storage keys. Validate them at the ticker boundary and encode them in URLs.

**S15 Suppressed counts.** Use `INDICATORS.length` and the voting count instead of the literal 20.

**S16 Curated lists.** Remove `LINKUSDT_RWA`, update `SQ` to `XYZ`, and add a dated venue snapshot test (the docs already plan a "weekend check").

**S17 Test gaps.** Add regression tests for:
- #3: a report over 200k rows.
- #5: h = 24 across a hole.
- #2: a scan where one symbol errors.
- #7: a quota-limited port.
- #8: clear during record.
- #6: catch-up rows must have `wb === ENGINE_BARS`.
- #10: a replay window across a gap.

---

## Disposition (31 Oct 2026, after review)

| # | Finding | Status | Where / evidence |
|---|---|---|---|
| 1 | Overlapping outcomes treated as i.i.d. (gate passes noise ~50 %) | **Fixed** | `ledger-metrics.ts` thinNonOverlapping / blockReturns / spaced IC; test "noise passes the PSR gate rarely (3/120)" |
| 2 | Failed-feed symbols scored from cache and recorded live | **Fixed** | `page.tsx` `fresh` gate; acceptance M-13 |
| 3 | `Math.min(...times)` RangeError > 125k rows | **Fixed** | loops in `buildReport`; test "130k rows" |
| 4 | Whole day bucket rewritten every scan | **Fixed** | `signal-ledger.ts` per-bar documents + day indexes; tests |
| 5 | 5 % gap tolerance lets h ≥ 20 straddle a hole | **Fixed** | exact span check; test "h = 24 … one missing bar" |
| 6 | Catch-up cost, short windows, main-thread fallback | **Fixed** | persisted cursor, full windows only, `allowMainThread: false`; tests |
| 7 | localStorage quota freezes the ledger | **Fixed** | quota recovery (drop oldest quarter, retry); test |
| 8 | `clear()` not serialised; cross-tab races | **Fixed** (clear) / **Mitigated** (tabs) | queue; per-bar docs shrink the race window — multi-tab writes to the same bar remain last-writer-wins |
| 9 | Bybit 403 ban not recognised | **Fixed** | `fetchJson` 403 → 10 min cooldown |
| 10 | Replay gaps; CSV intervals merged | **Fixed** | contiguousTail per window; files filtered by interval |
| 11 | Worker: no timeout, one job fails all | **Fixed** (timeout, isolation) / **Open** (cancellation of superseded batches) | `scan-runner.ts`, `runScanJobSafe` |
| 12 | Ledger view re-measures every refresh | **Fixed** | `getLiveKlines` on demand, generation guard, error state |
| 13 | Engine id misses the scoring pipeline | **Fixed** | fingerprint runs `scoreSeries` (window, FX, volume); new id `6dbcfdc424942e02` |
| 14 | Backfill ignores asset class | **Fixed** | `page.tsx` backfill job |
| 15 | Android signing step never runs | **Fixed** | `release.yml` checks the secret in the script, warns when unsigned |
| 16 | `ledger` store forces main IndexedDB upgrade | **Fixed** | separate `rsl-conf-ledger` database; `ledger` removed from main collections |
| S1/S2/S4 | Per-scan IndexedDB reads, duplicate packing, large server responses | **Deferred** | performance work for v2.3 |
| S3 | 4d / 1M series stay "cold" (< 300 bars) | **Open** | documented; paging history for synthetic intervals planned |
| S5 | Funding missing from base rate | **Fixed** | `fundingLong` in outcomes; test |
| S6 | IC needs ≥ 5 pairs; 3-symbol doc example | **Fixed** (docs) | measurement.md example uses 6 symbols |
| S7 | No in-/out-of-sample embargo | **Fixed** | replay `split` |
| S8 | Replay O(n·W) speed | **Deferred** | worker_threads per symbol (v2.3) |
| S9 | Dialog lacks catch / guard | **Fixed** | see #12 |
| S10 | `seen` grows unbounded | **Fixed** | cleared above 50k |
| S11 | IndexedDB "durable" retention vs evictable storage | **Open** | non-durable notice already shown; persisted() check planned |
| S12 | R8 always passes | **Fixed** | reads `CONNECT_SRC` in csp.ts; verified it fails on an injected host |
| S13 | Tautological acceptance checks | **Fixed** (M-4) / **Open** (11a budget) | — |
| S14 | Unencoded symbols in URLs | **Fixed** | `SAFE_SYMBOL` + `encodeURIComponent` |
| S15 | Suppressed counts 0/20/0 | **Fixed** | 0/0/0, 21 excluded |
| S16 | Dead `LINKUSDT_RWA`, stale `SQ` | **Fixed** | removed / XYZ |
| S17 | Missing tests | **Mostly fixed** | measurement suite 83 → 102 checks; acceptance M-13 |
