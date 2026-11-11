# ADR-0005 — Core Kit packaging; desktop updater deferred

**Status:** Accepted · 31 Oct 2026

## Kit packaging (deviation from the skill's tree)
The skill lists `packages/core`, `packages/tokens`, `packages/ui`. Here the whole rsL Core Kit v1.0 2026 sits **unchanged** in `packages/core` (`core/`, `tokens/`, `ui/`, `tests/`), published as `@rsl/core-kit` with exports `./core/*`, `./tokens/*`, `./ui/*`. Reason: the kit's own 21 tests then run in place, and `KIT-MANIFEST.sha256` (18 files) proves it is unmodified (release-check R4).

Kit CSS loads in the lowest cascade layer (`@layer rsl-kit`) so it never overrides the app's Tailwind theme.

**Kit issue found during the port:** see `docs/kit-issues/KIT-001.md` (`.rsl-app` class collision). The app carries a scoped, documented workaround until the kit is bumped.

## Updater deferred
No internal HTTPS host and no offline updater key exist yet, so `tauri-plugin-updater` is not included. Desktop updates are by installing the next signed release. Adding it later needs: a separate updater key (never the license key), `latest.json` on an internal HTTPS host, user consent before install, and a switch to turn checks off; the host must then be added to ADR-0003.
