# ADR-0004 — Personal edition: rsL brand, no customer factories, no licensing

**Status:** Accepted · 31 Oct 2026 (decided by rsLozano in this port)

## Decision
- **Brand:** rsL monogram → `rsL Confluence Terminal` → `by rsLozano` → `v2.1 2026 · build 20261031`, fixed order, LTR-isolated, never translated.
- **Customer layer (CNR):** default workspace `rsLozano — Personal trading desk` / `Personal` / `PERS`, editable in the first-run wizard and About → Edit identity. No organisation logo, no site selector.
- **Credit (page end only):** "Created by rsLozano". No confidentiality line, no department or organisation credit, because this is a personal tool.
- **No organisation details anywhere (amended 14 Nov 2026, owner decision, KIT-002):** the app, the rsL Core Kit (v1.1 2026), the docs and the built output carry no employer or company names, departments, people or sites. Release check R22 (`tools/checks/no-org-ids.mjs`) enforces it on the source tree and the built web output, using salted hashes so the check itself names nobody.
- **Licensing:** none. No chip, no watermark, no key verification; About shows "Personal build — no license required". The kit's license module is present but not wired.

- **Personal web address (amended 14 Nov 2026, owner decision):** the hosted web app and update channel stay reachable by
  address (installed apps need them) but are kept out of search results. Netlify sends `X-Robots-Tag: noindex, nofollow,
  noarchive` on every path (`public/_headers`), every page carries a robots `noindex` meta tag (layout metadata), and
  `robots.txt` lets only Googlebot and Bingbot fetch — Google documents that a robots.txt block alone would hide the
  noindex from it — while every other crawler is disallowed. Release check R23 enforces all three.

## Consequences
If the app is ever shared outside personal use, revisit: licensing (License masterclass) and an Apple Business custom-app channel for iOS.
