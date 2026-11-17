# Backup provider setup (owner notes)

For the owner of the build. These are the one-time registrations and checks behind the encrypted cloud backup
(Settings, About). Nothing here is needed for the app to work: a provider with no client ID shows "Not set up yet" and
is never contacted. No live sign-in is part of any release gate. Client IDs are public identifiers, but they are
build-time configuration and are never committed. There are no client secrets anywhere in this build.

## 1. Redirect URIs

Register these exactly, character for character, wherever a provider asks for a redirect or callback address.

| Where the app runs | Redirect URI |
| --- | --- |
| Web (hosted app) | `https://effervescent-bubblegum-1e5c03.netlify.app/` |
| Desktop (loopback) | `http://127.0.0.1:48787/callback` |
| Phone (app link) | `https://effervescent-bubblegum-1e5c03.netlify.app/oauth/app/` |

## 2. Google Drive (desktop only)

The web and phone apps show "Desktop app only" for Google Drive (ADR-0019), so only the desktop client is registered.

1. In the Google Cloud console, create a project.
2. Enable the Google Drive API for it.
3. Configure the OAuth consent screen. Add the one scope `https://www.googleapis.com/auth/drive.appdata` and no other.
   An External app in Testing status lets only listed test users sign in, so add your own Google account as a test user.
   Otherwise the first sign-in is blocked, which looks like the refusal in step 6 but is not.
4. Create an OAuth client ID of type **Desktop app**. It accepts any loopback port, so `http://127.0.0.1:48787/callback`
   needs no separate entry.
5. Copy the client ID into `RSL_BACKUP_GDRIVE_CLIENT_ID` (section 5).
6. **Sign-in check without a client secret.** The app sends no client secret. Google may refuse a desktop sign-in
   without one: developer forum reports say so, while Google's documentation treats the desktop secret as
   non-confidential. After registering, try one Google sign-in in the desktop app.
   - It works: nothing more to do.
   - Google refuses (`invalid_request` or `invalid_client` at the token step): Google Drive stays unavailable. Decide
     whether to allow Google's desktop "client secret" as a public build variable, and record a spec exception if you
     do, because the build currently carries no secret.

## 3. Microsoft OneDrive

1. Open the Entra admin centre, App registrations, New registration.
2. Supported account types: accounts in any organisational directory and personal Microsoft accounts (the `common`
   endpoint).
3. Authentication, add these platforms in the portal:
   - **Single-page application**, redirect URI: the web URI from section 1.
   - **Mobile and desktop applications**, redirect URI: the phone URI from section 1.
4. Add the desktop loopback URI through the manifest. General guidance from Microsoft's documentation (not read from this
   repo): the portal's Redirect URIs box cannot add an `http` loopback URI that uses `127.0.0.1`; it has to be added by
   editing `replyUrlsWithType` in the app manifest. Microsoft documents the "port is ignored" rule only for `localhost`,
   so the port is registered explicitly here. Source: Microsoft Learn, "Redirect URI (reply URL) outline and
   restrictions", https://learn.microsoft.com/entra/identity-platform/reply-url. Open the app's Manifest page and add
   an entry like this to `replyUrlsWithType`, keeping the entries already there:
   ```json
   { "url": "http://127.0.0.1:48787/callback", "type": "InstalledClient" }
   ```
   Save, then confirm against the current portal (section 8, item 5) that this still works.
5. API permissions, add the delegated Microsoft Graph permission `Files.ReadWrite.AppFolder`. Nothing else.
6. Do not create a client secret.
7. Copy the Application (client) ID into `RSL_BACKUP_ONEDRIVE_CLIENT_ID`.
8. **Restore is off for OneDrive until its download host is verified and added.** That is the manual check in
   section 8. Backup and listing work before then.

## 4. pCloud

1. In the pCloud developer area, create a new app.
2. Access type: **Private app folder**.
3. Add the three redirect URIs from section 1.
4. The app uses the token flow. Copy the app's client ID into `RSL_BACKUP_PCLOUD_CLIENT_ID`.
5. Backups are written to the folder `/rsL Confluence Backup`. With "Private app folder" access the token is rooted at
   your app's folder, so that folder appears inside it. In pCloud this is normally under `Applications`, in a folder
   named after the app. Confirm where it appears during the section 8 check.
6. **pCloud desktop sign-in.** pCloud tokens do not expire. After a desktop sign-in the browser may keep the local
   callback address in its history. To remove the risk, revoke the app's access in pCloud's account settings. Signing in
   again makes a new token.

## 5. Where the client IDs go

1. In the repository settings, add **variables** (not secrets): `RSL_BACKUP_GDRIVE_CLIENT_ID`,
   `RSL_BACKUP_ONEDRIVE_CLIENT_ID` and `RSL_BACKUP_PCLOUD_CLIENT_ID`.
2. The release workflow passes them to the build as `NEXT_PUBLIC_RSL_BACKUP_GDRIVE_CLIENT_ID`,
   `NEXT_PUBLIC_RSL_BACKUP_ONEDRIVE_CLIENT_ID` and `NEXT_PUBLIC_RSL_BACKUP_PCLOUD_CLIENT_ID`. You do not set those names
   in the repository.
3. For a local build, export the `NEXT_PUBLIC_RSL_BACKUP_...` names above in your shell before `pnpm build:pwa`.
4. The app checks the format of each ID. A malformed ID keeps that provider "Not set up yet", so if a provider stays
   that way after a build, re-copy the ID exactly as the provider shows it.

## 6. Phone app link (optional)

Without it the phone cannot return from sign-in to the app, so phone sign-in for OneDrive and pCloud stays off. It is off
by default.

1. Set these repository variables: `RSL_APP_LINK` to `1`, `RSL_ANDROID_CERT_SHA256` (the release signing key's SHA-256
   fingerprint, in `AA:BB:...` form; more than one may be listed) and `RSL_IOS_TEAM_ID` (your 10-character Apple team ID).
   One of the two identifiers is enough for that platform.
2. The workflow also passes `NEXT_PUBLIC_RSL_APP_LINK` (from `RSL_APP_LINK`). For a local build, export
   `NEXT_PUBLIC_RSL_APP_LINK=1` as well as the three above.
3. What the build then generates, and nothing when the link is off:
   - `.well-known/assetlinks.json` and `.well-known/apple-app-site-association` in the web output, for the hosted origin;
   - one verified https intent filter in the Android manifest for the path `/oauth/app/`;
   - the iOS entitlements file with the associated domain, and the build setting `CODE_SIGN_ENTITLEMENTS` that names it.
     The build sets that setting itself.
4. **iOS:** the provisioning profile needs the "Associated Domains" capability ticked for the app ID in the Apple
   Developer site. Without it the signed build is rejected or the link never verifies.
5. Confirm on each phone (general practice, not read from this repo):
   - Both files open in a browser at `https://<hosted origin>/.well-known/...` and show your identifiers.
   - Android: install the release build, then check Settings, Apps, the app, Open by default: the hosted address is
     listed and allowed. `adb shell pm get-app-links <app id>` should show it as verified.
   - iPhone: install the build, then tap the phone redirect address from Notes or Messages. It must open the app, not
     the browser. iOS can take a while to fetch the file after install; reinstalling retries it.
6. A malformed identifier is reported by name (never its value) in the build log, and that platform's link is skipped.

## 7. Backblaze B2 and Cloudflare R2

These go through the local gateway (a separate Node process you start by hand; the apps never bundle or start it), not
the browser, with a key that you create for one bucket only. The key stays in the gateway's memory until the gateway stops.

1. **B2:** create a private bucket. App Keys, Add a New Application Key, "Allow access to Bucket(s)" set to that one
   bucket, type Read and Write. Note the key ID, the application key (shown once), the bucket name and the region from the
   S3 endpoint (for example `us-west-004`).
2. **R2:** create a bucket. R2, Manage API tokens, Create API token, permission "Object Read & Write", "Specify
   bucket(s)" set to that one bucket. Note the Access Key ID, the Secret Access Key (shown once), the bucket name and your
   32-character account ID.
3. **R2 token check.** A token with Object Read & Write on all buckets typically gets 403 on ListBuckets and is accepted
   by the key test, because a 403 only proves the key cannot list buckets. The gateway only ever addresses the one named
   bucket, but create a token scoped to one bucket anyway.
4. Start the gateway by hand (`pnpm gateway` from the project folder; it prints a gateway token), then in the app open
   **Private API** (the key button in the header), paste the token and enter the key and the bucket. The key test refuses a
   key that can reach other buckets. The key is gone when the gateway stops.

## 8. Manual checks before release (deferred, ADR-0003 amendment and ADR-0019)

These are checked by you, once client IDs exist. Until then none is verified. For every item, if it fails: remove the
host or the provider, amend ADR-0003, and update the user guide.

1. **CORS from the hosted origin** for the OneDrive token endpoint, Microsoft Graph and the pCloud API.
   - Check: on the hosted web app, sign in and run Back up now for each of the three providers, with the browser's
     network panel open. Look for blocked cross-origin requests.
   - On failure: remove that host from the web build (`CSP_HOSTS`) and show the provider as desktop and phone only.
2. **Google token exchange without a client secret** (desktop). See the sign-in check in section 2.
3. **pCloud behaviour.**
   - Check: the Bearer authorization header is accepted; `gettextfile` returns the backup text; `uploadfile` stores it
     in `/rsL Confluence Backup`; and which region host answers for your account (`api.pcloud.com` for the US,
     `eapi.pcloud.com` for the EU).
   - On failure: remove the failing host or switch pCloud off until the code is fixed.
4. **OneDrive download origin.** OneDrive may answer a download with a redirect to a pre-authenticated file host. The
   restore message names the host it was refused at.
   - Check: run a restore and read the host in that message.
   - On success: this is a developer change, requested through an ADR-0003 amendment. The origin goes into
     `ONEDRIVE_DOWNLOAD_ORIGINS`, `CSP_HOSTS` and `BACKUP_NATIVE_URLS`, and the Tauri http scope, the `_redirects` and
     launcher rows and the egress manifest must match. The developer re-runs `node tools/release-check.mjs` until R16
     passes. Until then OneDrive restore stays off.
5. **Sign-in on every platform:** Windows, macOS, Linux, Android and iPhone. Sign in, back up, list and restore with a
   throwaway test passphrase. For OneDrive on desktop, also confirm the sign-in returns to the app on port 48787 and that
   Entra accepted the manifest entry from section 3 step 4. If Entra rejects it or the sign-in does not return, do not
   change the doc: this is a code or port decision for the developer.
6. **Each provider's API terms and limits.** Read them for a personal single-user backup of a small file, and confirm
   the use is allowed.
