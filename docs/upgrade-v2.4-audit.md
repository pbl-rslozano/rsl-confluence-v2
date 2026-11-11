# Confluence Terminal v2.4 release audit

Release date 5 November 2026. The Windows PWA and source are version 2.4.0.
The unchanged default scoring engine remains version 2.3.0 with config ID
2c1a18ad8a61e9ab. Custom profiles use separate configuration IDs.

## Included features

Editable chart indicator settings with EMA 20, EMA 50 and SMA 200 defaults.
Saved scans, venue-qualified watchlists, closed-bar score and rank-rise
alerts, local gateway sync, and a durable alert inbox. Visual chart replay
with isolated paper fills and persistent annotations on closed paper
trades. Bybit linear derivatives import, bounded public depth and trade
captures, sequenced depth replay, a heatmap and observed liquidation
markers. The depth recorder supports bounded reconnection and resync.
Optional scoring profiles work in the scanner, worker, recorder, replay
CLI and ledger view.

## Superpowers review

Independent source review found and verified fixes for profile reapplication
clearing rows, stale history requests committing after profile changes, and
legacy alert transition state mixing profiles. The reviewer reran 48 engine
checks and 8 alert checks and found no remaining important issue in those fixes.
The browser fixture waits for the delayed backfill request to finish before
checking that it cannot reopen old results.

## Verification

- Final browser acceptance passed 105 of 105 checks.
- Full automated test command and lint passed.
- Build and build-time TypeScript check passed.
- Eleven release checks passed on a clean source snapshot.
- Default and custom replay CLI smoke tests produced separate IDs and
  14 custom rows. Recorder profile tests cover ledger and cursor isolation.
- Same-origin upgrade from the original v2.3 PWA retained all four seeded
  ledger rows and allowed access to them offline. The updated shell loaded
  offline and a clean profile registered the service worker automatically.
  The test manually registered the original worker to reproduce an installed
  v2.3 PWA because its original load-time registration can miss activation.
- Prior live BTCUSDT captures verified synchronization and reconstruction.
  Reconnection and liquidation event handling were checked with fixtures.
- PWA SHA-256
  099c2e6245cb7196af88b26009cb1db42eb1292d57656bf897e6b282ce7bc69a

## REA package audit

REA inventoried the exact final PWA and statically analyzed its launcher,
service worker and compiled feature chunk. Three JavaScript files parsed
with zero parse failures and zero declared integrity contradictions.
The inventory included 2,204 relevant files. Source analysis left 2,201
inventoried files outside its selected scope, and semantic retention hit
per-file limits. The retained evidence states these limits explicitly.
Runtime claims above rely on the separate browser and recorder checks.

Parent evidence ID
ev_a56d0d11fdf8ae18818106b8e247bb19dbb4ccab42b006bf6eb0e8bdcb5d1171

## Boundaries

The delivered application is a locally served PWA with optional source-run
Node tools. Native installer creation, signing and native device testing are
outside this release. Derivatives and order-flow tools cover Bybit linear
contracts. Cross-venue provider expansion remains a separate scope.
Recorder capture files and imported market data remain subject to the
documented size and retention caps. Browser testing used mocked exchange
feeds except for the separately noted live depth smoke captures.
