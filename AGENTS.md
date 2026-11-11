# Working rules for AI coding agents (Codex, Claude Code, others)

rsL Confluence Terminal — personal edition by rsLozano. These rules exist because v2.4 was uploaded from an
older zip over newer work on `main` and silently removed features (see
`docs/reviews/2026-11-07-v2.4-session-diagnosis.md`).

## Source of truth
1. Start every change from the **current `main` of github.com/rslozano/rsl-confluence** (clone or `git pull`).
   Never start from a zip, a build bundle or a folder copy.
2. Change code through Git: branch → commits → pull request → merge (three-way). **Never upload a snapshot over
   `main`** (no "local file differs → overwrite" uploads through an API or connector).
3. If you were given a zip, diff it against `main` and port only the intended changes onto a branch.

## Checks before a pull request
- `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm lint`
- `node tools/release-check.mjs --with-tests` (all checks pass)
- Browser acceptance: build static, serve `apps/confluence/web/out`, `node tools/e2e/acceptance.cjs <url>`
- Never delete an acceptance check. Removing one needs an ADR in `docs/adr/` and a `removals` entry in
  `tools/acceptance-ids.json` (release check R14 enforces this).

## Fixed rules
- Brand strings (rsL, Confluence Terminal, by rsLozano, build stamp) are never translated; credit only at page end.
- `packages/core` (rsL Core Kit) is unchanged — record issues as `docs/kit-issues/KIT-xxx.md`.
- Only `packages/adapters` imports `@tauri-apps/*` or `@capacitor/*`.
- Exact pinned versions; lockfiles committed; lifecycle scripts off.
- No private keys or signing secrets in the repo or in artefacts; never print them.
- Paper trading only: no exchange order endpoint anywhere; Claude/LLMs are never in an order path.
- New network hosts need an ADR-0003 amendment and release check R8.
- Translations: tier-2 catalogs never claim `CERTIFIED` without a named human reviewer.
