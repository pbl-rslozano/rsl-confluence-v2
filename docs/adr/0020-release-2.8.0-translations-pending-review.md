# ADR-0020 — Release 2.8.0 with tier-1 translations pending native review (owner waiver)

**Status:** Accepted · owner decision of 17 Nov 2026 · scope: release 2.8.0 only.

## Context
Release check **R25** (final review I-1, `tools/checks/translation-review.mjs`) blocks a release build (`--release`:
version tags, manual dispatch, `[release…]` commits on main) while any tier-1 catalog still lists strings in
`@pendingReview`, the machine drafts of new or changed strings awaiting a native-speaker review. When 2.8.0 was prepared,
the Arabic catalog (`ar.json`, the only tier-1 catalog) still listed the new and changed v2.8 strings (390 when this ADR
was written), and no native review had taken place, so R25 blocked the 2.8.0 release build. The 16 tier-2 catalogs are
MACHINE-CHECKED; none is CERTIFIED.

## Decision
The owner decided on **17 Nov 2026** that 2.8.0 ships its translations as drafts without native validation:
- nothing is marked CERTIFIED; Arabic stays APPROVED for its reviewed strings and keeps its `@pendingReview` list, and
  About keeps showing *N new strings await native-speaker review*;
- R25 is **not** removed or weakened. It still counts the pending strings on every run. With `--release` it passes only when
  `tools/r25-waiver.json` holds an owner waiver for exactly the app version being released, and the ADR it names exists,
  names that version and says "owner waiver" (this ADR). It then prints `WAIVED` with the pending count, under the label
  *Tier-1 translations: release waived by owner (pending native-speaker review)*. Without that waiver it fails exactly
  as before;
- the waiver file is machine-readable: `{ "version", "adr", "owner", "date", "reason" }`. `version` must equal the root
  `package.json` version. `adr` must point to this file.

## Scope
Release **2.8.0** only. A waiver names one version, so for 2.8.1 or 2.9.0 R25 blocks again unless the owner records a new
decision (a new ADR and a new waiver).

## Consequences
- 2.8.0 users of Arabic see machine drafts for the new v2.8 strings, marked as awaiting review in About. Other languages
  are unchanged MACHINE-CHECKED drafts. The CHANGELOG and the user guide say so.
- LanguageTool runs as an **informational** CI check over the catalogs (`docs/translation-review.md`). It does not replace a
  native review and never sets a status.

## Known gaps (2.8.0)
- `docs/user-guide/ar.md` §1, Mac row: still says right-click → Open on first launch. On macOS 15 (the app's minimum)
  the 2.8.0 Mac app, which is not notarised, must be opened through System Settings → Privacy & Security → Open Anyway
  (English guide §1). The Arabic guide is APPROVED text awaiting native review, so the line is left for the reviewer.

## How to remove
Delete `tools/r25-waiver.json` (or let the version move on). R25 then blocks every release again until each `@pendingReview`
list is empty, i.e. a native speaker has reviewed the strings and their keys have been removed from the list. Keep this ADR
as the record of the 2.8.0 decision.
