# Certify a language — <language name> (<code>)

Reviewer: **<full name>** (native speaker, GitHub: @<reviewer-login>) · Date: YYYY-MM-DD

This pull request moves `apps/confluence/web/src/rsl/i18n/<code>.json` from `MACHINE-CHECKED` to
`CERTIFIED`. Only the reviewer named above may approve it. CI (`i18n-certification`) requires an approval
from `@reviewerGithub` on the latest commit: push all corrections first, then ask for the approval. The reviewer
must be a repository collaborator and cannot be the PR author.

## Reviewer checklist (see docs/translation-review.md)
- [ ] Read every string in the app in this language (header, list, detail panel, Ledger, Paper, About, wizard).
- [ ] Brand words stay Latin and untranslated: rsL, Confluence Terminal, by rsLozano, build stamp.
- [ ] Finance terms read correctly: hit rate, edge, profit factor, rank IC, PSR, deflated Sharpe, basis points.
- [ ] Safety statements keep their exact meaning:
      `paper.banner` — "simulated, no orders are sent"; `status.disclaimer` — "analysis tool, not financial advice".
- [ ] Plurals and numbers read naturally; nothing is cut off on a phone.
- [ ] Corrections made in this PR (list them, or "none").

## Author steps
1. Apply the reviewer's corrections to `<code>.json`.
2. Set `"@status": "CERTIFIED"`, `"@reviewer": "<full name>"`, `"@reviewerGithub": "<reviewer-login>"`, `"@certifiedAt": "YYYY-MM-DD"`.
3. Run `node apps/confluence/web/scripts/catalog-status.mjs hash <code>` and paste the result into `"@certifiedHash"`.
4. If a safety statement changed, run `node apps/confluence/web/scripts/catalog-status.mjs lock` (the reviewer approves the new wording).
5. `pnpm --filter @rsl/confluence-web test:i18n` must pass.
