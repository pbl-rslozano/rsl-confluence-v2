# Translation review — status and certification (v2.5)

English (source) and Arabic are **APPROVED**. The other 16 languages (ja, fil, bn, ur, ru, hi, zh, ko, id, ms, tr, fr, de, es, pt, it) are **MACHINE-CHECKED** as of v2.5: they pass every automated check, but no native speaker has reviewed them yet. The app shows each language's real state in the language menu and in About.

| Status | Meaning | Who sets it |
|---|---|---|
| APPROVED | Source (en) or reviewed tier-1 (ar) | Owner |
| CERTIFIED | A named native-speaker reviewer approved the catalog in a GitHub pull request | Reviewer's approval; CI enforces it |
| MACHINE-CHECKED | All automated checks pass (below); not a human review | Developer, after the checks pass |
| DRAFT | Not yet machine-checked | — |

**Automated checks (every push and pull request):** key parity with English, ICU argument names, CLDR plural categories, protected brand/technical tokens, status rules, the **safety lock** (`tools/i18n-safety-lock.json`: `paper.banner` and `status.disclaimer` cannot change without a reviewed lock renewal), and acceptance **L-1** (all 18 languages at 390 px and 1366 px: header, list toolbar, footer, About/Paper/Ledger dialogs — no clipped labels, no raw placeholders). LLMs, including Claude, may help reviewers but never set CERTIFIED.

**How to certify a language:** open a pull request with the *Certify a language* template (`.github/PULL_REQUEST_TEMPLATE/certify-language.md`). The reviewer works through the checklist below and approves the PR. The author sets `@status: CERTIFIED`, `@reviewer` (full name), `@reviewerGithub` (the reviewer's GitHub login), `@certifiedAt` and `@certifiedHash` (`node apps/confluence/web/scripts/catalog-status.mjs hash <lang>`).

**What CI enforces** (workflow `i18n-certification`, re-run on every push and every review): compared with the PR base, a catalog that is newly certified, or a certified catalog whose messages or `@reviewer*`/`@certified*` fields changed, needs an approval from its `@reviewerGithub`; a renewed safety-lock entry (`tools/i18n-safety-lock.json`) needs that reviewer for a certified language, otherwise any collaborator other than the author. An approval counts only if it is the reviewer's latest decision, is on the PR's head commit (a push after approval needs a fresh approval), and comes from a repository owner, member or collaborator who is not the PR author — so add each reviewer as a collaborator (read access is enough). Setting a catalog back to MACHINE-CHECKED needs no approval.

## Reviewer checklist (legacy notes, still valid)

Missing keys fall back to English, never to raw keys (acceptance ID-8.7c).

**Reviewer task:** check the items below in the certification pull request (see above).

| Item | Keys | What to check |
|---|---|---|
| "Confluence" | `ctx.page`, splash/about strings | Brand words stay Latin and untranslated (*rsL*, *Confluence Terminal*, *by rsLozano*). Some drafts used local loanwords in descriptive text — keep or replace consistently. |
| Audit "Head" | `about.auditHead` | Means the latest entry of the hash chain (ja ヘッド, ko 헤드, zh 链头, de Kettenkopf, tr Son kayıt). Prefer a plain "latest entry" if the literal reads oddly. |
| "Identity" | `about.identity`, `about.editIdentity` | Means the workspace/operator profile, not a legal ID (ko 프로필; ja 識別情報 may read as "identification data"). |
| B / N / S column | `col.bns` | Initials for Bullish / Neutral / Sell votes; three short, distinct letters per language (ar ص / م / ها). |
| Strength badges | `sig.strong`, `sig.moderate`, `sig.weak` | Japanese uses single characters 強 / 中 / 弱 — confirm they read naturally in "買い · 強". |
| Plurals | `ctl.alerts`, `stat.*` | Arabic `one`/`two` forms now carry the numeral (`تنبيهات الانعكاس: #`) so the badge number is in the accessible name; check other languages read naturally with the numeral. |
| New key | `row.openDetails` | Added in 2.1 ("Open details", screen-reader text on each asset button). |
| v2.2 keys | `ac.*`, `ledger.*`, `detail.*`, `scan.rateLimited`, `ctl.ledger*`, `ctl.assetClass` | 59 strings for asset classes, the signal ledger and the detail panels. Check finance terms: "hit rate", "edge", "profit factor", "rank IC", "PSR", "basis points (bp)"; and that "underlying closed" is short enough for a badge. |

| v2.3 ledger keys | `ledger.window*`, `ledger.trials`, `ledger.snapshots`, `ledger.measuredSlip`, `ledger.storage*`, `ledger.persistBtn`, `ledger.export*`, `ledger.ci`, `ledger.dsr`, `ledger.bench*`, `ledger.excessBtc`, `ledger.gate{Dsr,Shuffle,Momentum,Prereg}`, `ledger.prereg*`, `ledger.import*` | 27 strings for research hygiene. Check "deflated Sharpe", "label shuffle", "pre-registration", "decision date", and that the pre-registration status says the hypothesis **cannot be changed**. |
| v2.3 detail keys | `detail.context`, `detail.rs`, `detail.beta`, `detail.htf`, `detail.td`, `detail.mev`, `detail.basis`, `detail.pinned`, `detail.split`, `detail.earn` | 10 short labels; "(logged, not scored)" must keep that meaning. |
| v2.3 paper keys | `paper.*` (127 strings) | The banner "simulated, no orders are sent" must keep that meaning **exactly** in every language — it is a safety statement. Risk-rule texts (`paper.rule.*`) must say what blocked the trade. |

No regulatory or legal wording in this app. The disclaimer "analysis tool, not financial advice" must keep that meaning exactly.
