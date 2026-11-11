# ADR-0006 — Platform features not used

**Status:** Accepted · 31 Oct 2026

| Feature | Decision |
|---|---|
| Barcode / camera / USB scanner | Not applicable (no physical goods). No camera permission requested. |
| Print / A4 reports | Not applicable; the scanner is an on-screen tool. Exports: backups, identity JSON and (v2.2, ADR-0007) the signal ledger as CSV/JSON. |
| `.rsllic` association | Not applicable (no licensing, ADR-0004). |
| `.rslbak` association | Declared for desktop so backups show the app's file type and open the app. Restoring is done from About → Restore backup; routing a double-clicked file straight into Restore is **deferred** (needs a Rust `RunEvent::Opened`/argv handler plus a scoped fs grant). **NOT VERIFIED** until a signed installer is tested. |
| Orientation lock | None; the table scrolls horizontally on phones. |
