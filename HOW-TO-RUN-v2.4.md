# Run Confluence Terminal v2.4

Install Node.js 22.15 or newer. Extract the PWA ZIP, then double-click
Start-Confluence-Terminal.cmd. Open http://127.0.0.1:8770/ in the same
browser and profile used for the previous release to retain the ledger.
Keep the server window open while using the app.

Export the existing ledger before upgrading. Keep the previous release
folder for rollback. The source archive contains the optional gateway,
recorder, replay CLI and depth capture. Those tools need pnpm 10.34.9 and
pnpm install --frozen-lockfile from the source directory.

The Scoring profile menu controls votes. Apply a draft to rescan, or export
scoring-profile.json for the headless tools.

    pnpm recorder -- --profile C:\path\scoring-profile.json --out C:\recorder
    pnpm --filter @rsl/confluence-web replay -- --profile C:\path\scoring-profile.json --csv-dir C:\klines --tf 4h

Custom profiles receive separate engine IDs. Default scoring keeps the
v2.3 engine identity so earlier default rows remain comparable. Reset the
scoring draft and apply it to return to the default.

Recorder alert files and gateway configuration are described in docs/recorder.md.
Derivatives and order-flow panels cover Bybit linear contracts. Cross-venue
provider expansion is a separate release scope.
