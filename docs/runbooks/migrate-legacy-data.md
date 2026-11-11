# Runbook — Migrate from Confluence Terminal 2.0x

Automatic on first start of v2.1:
1. Migration 1 takes a pre-migration snapshot (`localStorage: rsl-conf-premigration-snapshot`).
2. It reads `ct-preferences-v1` (timeframe, source, universe, theme, watch list, sort, auto-refresh, chart depth), validates every field, and writes it to the StoragePort record `preferences/current`.
3. It writes `migration.import` to the audit trail with what was imported.
4. The old key is **not deleted**, so 2.02 still works if you go back.

Moving between devices (e.g. from the 2.0x Windows Electron app to the v2.1 desktop app): settings live per install, so on the new install set them once and use **Export backup** from then on. Candle history is a cache and refills on the first scan.

Rollback: uninstall 2.1, reinstall 2.02 — its settings are untouched. Settings changed in 2.1 are not copied back.
