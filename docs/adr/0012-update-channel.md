# ADR-0012 — Update channel (Netlify) and release gating on `main`

**Status:** Accepted · 7 Nov 2026 (v2.5.1). Approved by the owner ("Auto-update everywhere", site
`effervescent-bubblegum-1e5c03`). Amends ADR-0003 (one read-only host) and ADR-0005 (desktop: notice only).

## Context
Phone builds were installed by hand from GitHub Actions downloads, and nobody was told when a new version existed.
The owner asked for updates on every platform, built only by GitHub Actions.

## Decision
**Publisher (CI only).** On a release run (a `v*` tag, a manual run, or a `main` commit containing `[release]`),
once the gate and the signed Android build pass, the `publish` job of `.github/workflows/release.yml` deploys one
atomic Netlify site:

| Path | Content |
|---|---|
| `/` | the PWA (static export, html target) |
| `/updates/latest.json` | `{schema:1, app:"rsl-confluence", version, build, publishedAt, notes, android:{file, bytes, sha256}}` |
| `/updates/<file>.apk` | the signed APK (same key as every earlier build, so data is kept) |

The deploy uses Netlify's file-digest API (`tools/publish-update.mjs`, no dependencies) with the token from the
`NETLIFY_AUTH_TOKEN` repository secret. The site is addressed by its domain, so no site-ID secret is needed. With no
token, the job logs a warning and publishes nothing.

**App (reader).** At launch and every 6 hours, while online and while *Check for updates automatically* is on
(About → Updates, default on, stored in `meta/update-check`), the app GETs `latest.json`:
- PWA: `./updates/latest.json` on its own origin (`'self'`, no new host);
- Android, iPhone and desktop: `https://effervescent-bubblegum-1e5c03.netlify.app/updates/latest.json`.

The response is validated strictly (`src/lib/update-channel.ts`). A newer version or build shows a dismissible
notice (dismissed per build):
- **PWA:** *Reload to update*. The service worker now waits for that click (no automatic `skipWaiting`) and is
  re-versioned with every build (release check R15).
- **Android:** *Download update (size)*. This opens `/updates/<file>.apk` in the system browser, and the system
  installer then verifies the signature. The download URL is always built from the fixed origin and a file name
  matching `^[A-Za-z0-9._-]+\.apk$`. A URL from the manifest is never used.
- **iPhone:** a notice to install the new build with Sideloadly. **Desktop:** a notice to install the next
  installer. The Tauri updater stays deferred (ADR-0005).

Nothing is sent: a GET of one public JSON file, with no identifiers and no cookies (`credentials: "omit"`).

**ADR-0003 amendment.** `https://effervescent-bubblegum-1e5c03.netlify.app` joins `connect-src` (web meta CSP and
desktop CSP) for that GET only. Release check R8 allows it. `tools/egress-manifest.json` lists the publisher's
`api.netlify.com` under a separate `publish` process that the app never runs.

**Release gating on `main`.** Branch protection on `main` is the control for ADR rulings 16–17 of v2.5. It requires
a pull request, the `Gate — tests, release-check, PWA, acceptance` and `i18n — certification …` checks, and blocks
force-pushes and deletion. GitHub offers branch protection for private repositories only on paid plans. Until the
owner's account is on GitHub Pro, the protection cannot be switched on (recorded in the v2.5.1 PR).

## Consequences
- The update notice is advisory: the channel can only offer a version. On Android the signature, and on the web the
  same-origin service worker, decide what is installed.
- A compromised Netlify token could publish a misleading notice or an APK that Android rejects (wrong signature).
  The token is a GitHub secret, used only by the `publish` job, and never printed.
- NOT VERIFIED on a real phone: that the system browser downloads the APK and hands it to the installer (Android
  behaviour for external links from a Capacitor WebView). Verified in CI: deploy state `ready` and `latest.json`
  served with the expected build.
