# Runbook — Restore from backup

1. Open **About** (ⓘ in the header, or Help → About on desktop).
2. **Restore backup** → pick `ConfluenceTerminal_<CODE>_backup_<yyyymmdd>.rslbak`.
3. Confirm. The app checks the SHA-256, the app id (`CONF`) and the schema version **before** writing anything. A changed or foreign file is refused with "checksum does not match" and nothing is changed.
4. On success the app reloads with the backed-up preferences, identity and audit trail; a `backup.restore` audit entry is added.
5. If the audit trail shows **BROKEN at #k** afterwards, keep the file, export a fresh backup and report it — do not edit the database by hand.

What a backup contains: preferences, identity, audit trail, meta. It does not contain candle history (re-downloaded automatically) or exchange API keys (never stored).
