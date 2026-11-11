# ADR-0002 — Data model: records in the StoragePort, candles in an IndexedDB cache

**Status:** Accepted · 31 Oct 2026

## Context
2.0x kept preferences in `localStorage` (`ct-preferences-v1`) and candle history in IndexedDB. WKWebView IndexedDB is best-effort and evictable. The rsL rule is: records in native SQLite, IndexedDB only as cache or PWA fallback.

## Decision
| Data | Where | Why |
|---|---|---|
| Preferences, identity (CNR), audit trail, meta | rsL Core Kit **StoragePort** (`rsl_docs` table) — SQLite via `@tauri-apps/plugin-sql` (desktop) / `@capacitor-community/sqlite` (mobile); IndexedDB `rsl-conf` → localStorage → memory in the PWA | These are the user's records; they must survive eviction and are backed up |
| Candle history (klines) | IndexedDB cache, unchanged from 2.02 | Re-fetchable market data, large, not a record; losing it costs one refetch |
| Exchange API keys | Never stored by the app; held in memory by the localhost gateway for the session | Unchanged 2.02 boundary |

- Collections: `meta`, `identity`, `preferences`, `audit`, `audit_meta`.
- Migration 1 (forward-only, snapshot first): seeds the personal identity, imports `ct-preferences-v1` once, writes `migration.import` to the audit trail. The legacy key is left untouched (read-only), so a rollback to 2.02 still finds its settings.
- Backup: `ConfluenceTerminal_<CODE>_backup_<yyyymmdd>.rslbak` = `exportSnapshot` JSON with SHA-256 and audit head; restore checks checksum, app id and schema before any write. Reminder after 7 days, always while storage is not durable.

## Consequences
- The PWA shows "Storage: browser IndexedDB" and the non-durable notice; desktop/mobile show SQLite (**NOT VERIFIED** on devices — needs the CI builds).
- Heavy SQL tables are not needed (record volume is tiny), so no app tables beyond `rsl_docs`.
