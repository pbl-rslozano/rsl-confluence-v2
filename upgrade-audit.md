# Confluence Terminal upgrade candidate audit

## Scope

The final Windows PWA ZIP has SHA-256 d41097195c4f907503e8774516877a87f8fc9295536b6b67ff5d57391520df60. It retains the v2.3 package label. The companion source ZIP contains the headless recorder and depth-capture command. Native installer and provider-entitlement checks are outside this candidate.

## Superpowers source review

An independent reviewer inspected the extracted source against the indicator and scanner workspace plans. The review found four issues, all corrected before rebuilding the candidate.

- The workspace alert evaluator now consumes the recorder's bare catch-up rows. A regression fixture reproduced the original error before the fix.
- Inbox import rejects timestamps outside JavaScript's Date range. The acceptance fixture includes a malformed event alongside a valid event.
- Closed-trade replay stops at the last candle that closed by the trade exit.
- A watchlist scans its exact venue and symbols across asset classes so the current class selector cannot hide saved members.

## Packaged REA evidence

The scoped REA CLI run analyzed serve-pwa.mjs, sw.js and the compiled feature chunk from the exact final ZIP. It parsed three JavaScript files with zero parse failures. The inventory covered the extracted artifact. Source analysis left 2,201 inventoried files outside its selected scope and semantic retention hit per-file ceilings. This is static evidence. Runtime behavior is covered by separate browser and recorder checks.

- Summary: rea-final-audit.json
- Retained evidence: rea-final-evidence
- Parent evidence ID: ev_1dff922bfbde2241836e6ec98320d4bba2d84b66ed5a27f461654331d127de6b

## Verification

- PWA build and build-time TypeScript check passed.
- Full test command and 11 release checks passed.
- Browser acceptance passed 96 of 96 checks on the second run. The first run passed 95 of 96 and exceeded the cold-start timing budget while the broader REA pass was running. Treat cold-start timing as variable on this host.
- The PWA checksum matched the sidecar. The source archive inventory includes the recorder capture entry point and excludes dependency caches and smoke capture data.
- Earlier live BTCUSDT smoke runs verified ordinary depth capture and replay. Reconnect and liquidation event handling were verified with fixtures.

The candidate includes the indicator controls, scanner workspace, file-based alerts, chart replay, isolated paper fills, journal annotations, Bybit derivatives import and order-flow tools. Optional scoring profiles, automated gateway sync, rank-change rules and cross-venue provider expansion remain outside the delivered scope.
