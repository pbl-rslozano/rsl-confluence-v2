# ADR-0019 — Encrypted cloud backup (Google Drive, OneDrive, pCloud, Backblaze B2, Cloudflare R2)

**Status:** Accepted for the v2.8 build · owner decisions of 15 and 17 Nov 2026 (v2.8 plan WP28). **Deferred:** the §6 checks
(CORS from the hosted origin, each provider's terms and limits, the OneDrive download origin, the Google token exchange
without a client secret, pCloud behaviour, sign-in on every platform) are documented manual checks for the owner, in
`docs/backup-provider-setup.md` section 8. None is verified, and no live sign-in is part of any release gate. The ADR-0003
amendment "v2.8 (17 Nov 2026, WP28)" records the hosts.

## Context
The v2.8 plan (`docs/superpowers/specs/2026-11-15-v2.8-architecture-design.md`, WP28) adds an optional, off-by-default backup
of the user's own records to the user's own cloud storage. The existing `.rslbak` export is unchanged. The owner decided on
17 Nov 2026:
- all five providers are built;
- OAuth client IDs are build-time configuration, empty by default; a provider without one shows "Not set up yet" and is excluded
  from every network path;
- every provider flow is tested against mocks, so no live sign-in is needed for any gate;
- B2 and R2 go through the local gateway (a separate Node process started by hand, never bundled into the apps) with the user's own bucket-restricted keys, held in memory, on a route with its own
  20 MB body limit;
- Google on the web is "desktop only" (reasons below);
- the §6 host checks are documented manual checks, deferred.

## Decision

### 1. File format (byte for byte)
A backup is one UTF-8 JSON text, named `confluence-backup-YYYYMMDDTHHMMSSZ.json` (`BACKUP_FILE_RE =
/^confluence-backup-\d{8}T\d{6}Z\.json$/`, the same literal in the web app and the gateway).

**Outer object**, exactly these five keys, in this order, and no others:
`{"format":"rsl-confluence-backup","v":1,"h":"<b64url>","iv":"<b64url>","ct":"<b64url>"}`

- `h` is the header's JSON bytes. `iv` is 12 random bytes. `ct` is the AES-GCM output, ciphertext followed by the 16-byte tag
  (at least 16 bytes).
- Base64url is unpadded and canonical: any other alphabet, a length that is 1 mod 4, or non-zero trailing bits is a `format`
  error.

**Header**, exactly these eight keys, in this order (`JSON.stringify` of one object):

| Key | Value |
|---|---|
| `schema` | `1` |
| `cipher` | `"AES-256-GCM"` |
| `kdf` | `"PBKDF2-SHA-256"` |
| `iter` | integer, 600,000 to 5,000,000 (seal writes 600,000) |
| `salt` | 16 random bytes, b64url |
| `zip` | `"gzip"` or `"none"` |
| `createdAt` | integer milliseconds, from 1 Jan 2026 to now plus one day |
| `app` | build stamp text, `^[0-9A-Za-z .()-]{1,40}$` |

The header is at most 1,024 bytes. **The header bytes themselves are the GCM additional authenticated data**, so every field
is authenticated: changing `createdAt`, `iter` or `schema` makes decryption fail. Seal and open share one header validation
(`validateHeader`), so the app never writes a file it will refuse to open.

**Limits.** The whole text is at most **20 MB** (20 × 1024 × 1024 bytes), checked before anything is parsed. Inside the
ciphertext the payload is gzip (when `CompressionStream` exists) and is capped at **160 MB** once decompressed. The cap is
enforced while inflating: the compressed bytes are fed in 16 KiB slices and the output is read at the same time, and the
stream is aborted the moment the cap is passed. A single large write would let Chromium inflate a whole bomb in memory
before any check, so this is a security property, not a tuning detail.

**Payload.** Plain JSON, `{"format":"rsl-confluence-backup-payload","schema":1,"createdAt","app","settings":{"preferences",
"scoringProfile"},"ledger":{"rows","outcomes","universes","gaps"},"research":{"preregistrations","trials"},"paper":{"journal","notes"}}`.
`createdAt` must equal the header's. List limits: 1,000,000 rows, 500 pre-registrations, 20,000 trials, 100,000 journal entries,
1,000,000 outcome documents, 100,000 universes, 100,000 gap series, 100,000 notes. Every item goes through a strict sanitiser
(final review I-1 added `sanitizeOutcomeDoc`, `sanitizeUniverseDoc`, `sanitizeGapDoc` and `sanitizeTradeNote`: known fields only,
ids checked against each other, sizes bounded, nothing thrown); an item that fails is counted, never silently dropped.
Schema 1 was not released before these sections were added, so its number did not change.

**Responsiveness (final review M-1).** The payload is built and sanitised one record at a time, the text is encoded and decoded in
1 MiB steps, (de)compression and the ciphertext's base64url run in steps, and each loop yields to the event loop after about 40 ms.
Key derivation and AES-GCM run in WebCrypto. One step cannot be split: the single plain `JSON.parse` of the payload (about 0.9 s
for 100,000 realistic rows, 68 MB, in Node 22), kept because restore must use plain `JSON.parse` only.

**Realistic size (final review M-2).** Measured on rows with every field filled and varied values (about 710 bytes of JSON each,
gzip about 4×, base64 4/3): 20 MB holds about 120,000 live rows; with measured outcomes at all five horizons for every row and a
universe snapshot per bar, about 45,000. A refusal over 20 MB reports the file's own size; one over the 160 MB unpacked cap reports
the estimated file size (from a compressed 8 MiB sample) and the unpacked size.

### 2. Crypto parameters
- AES-256-GCM through WebCrypto, 96-bit IV, 128-bit tag.
- Key: PBKDF2-SHA-256, **600,000 iterations**, 16-byte random salt. Source: OWASP Password Storage Cheat Sheet,
  "PBKDF2-HMAC-SHA256: 600,000 iterations", https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html,
  read 17 Nov 2026.
- The passphrase is NFC-normalised UTF-8, at least 12 characters. It is never stored, logged or uploaded, and never appears in
  an error or an audit entry. Opening uses a frozen 12-character floor, so a later, stricter sealing rule never locks anyone
  out of an older file.
- No new dependency: WebCrypto, `CompressionStream`, `node:crypto` and `std::net` only.

### 3. What is backed up, and what is not
- **In:** signal-ledger rows (**live rows only**: replay rows, `live: 0`, are left out on purpose and reported separately as
  `bk.skippedReplay`, while `bk.skipped` is kept for records that are genuinely unreadable) with their **outcome snapshots**
  (`o|<bar doc>`, only the entries of the backed-up rows), the **universe snapshots** (`u|<src>|<t>`) and the **recorded gaps**
  (`gap|<src>|<tf>|<pair>`) (final review I-1: these are the user's scored records; without them a new device rebuilds outcomes
  only from history still served, at most 10 pairs and 5,000 bars per open, and loses delisted pairs); pre-registrations and
  registered trials (the multiple-testing count); the paper journal with its **trade notes** (`paper-note:*` annotations, keyed by
  proposal id, open and close time, so they re-attach to the restored trades); preferences (`preferences/current`); the scoring
  profile (`preferences/scoring-profile-v1`).
- **Out:** market history (re-downloadable); the paper account, open positions and risk settings (a restore must never
  loosen a drawdown lock); tokens, keys and the passphrase; radar caches; replay rows; and the ledger's device bookkeeping:
  recording cursors (`cursor|`, `cursors|`: each device records from its own position), measured slippage (`slip|`, measured
  again from order books) and the time of the last ledger export (`export|last`).

### 4. Restore rules
- Plain `JSON.parse` only: no `eval`, `Function`, HTML or `innerHTML`. Nothing is executed. Schema version, field types and
  sizes are validated. An invalid, oversize, wrongly keyed or tampered file changes nothing.
- The backup time is shown. Records are merged and never overwritten.
- **Journal entries merge by content fingerprint.** Their ids (`trade-<n>`) are per-account counters that restart on every
  account, so they cannot identify a trade across devices. An identical entry is a duplicate; any other restored entry is
  written under the id `bk:<8 hex>:<origId>` (every restored entry that is not an identical duplicate, not only clashing ones), so it can never collide with a later local trade. Restoring the same file again
  is safe.
- **The plan counts exactly.** Rows removed by the device's row cap (by simulating the day-granular eviction) and days removed
  for age are counted separately, with rows too old and rows that could not be read. Per-section skipped counts are reported on
  backup.
- **Settings.** "Also restore settings" starts ticked, and starts **unticked** when the local settings changed after the
  backup or the local preferences or scoring profile differ from the backup's; the plan says so in that case.
- **Outcome snapshots, universes, gaps and notes (final review I-1).** Merged by key; a local value is never overwritten. A
  row's snapshots gain only the horizons it lacks; a gap span merges by its start (at most 50 per series, local spans never
  dropped); a note merges by `paperNoteId`. Outcome snapshots and universes are kept only for rows the device holds after the
  rows step, inside its age window, and only while they fit under the row cap (0.5 and 40 units): they never cause a row to be
  removed. Newest days first. The dry run and the real run share the planner, so the plan's counts are the report's.
- **Partial failure.** If a restore throws part-way, the audit trail records `backup.cloud.restore.partial` with the counts,
  and the UI shows `bk.err.partial`. A re-run is safe. **A full store (final review I-2):** ledger rows are written in chunks of
  at most 1,000 rows (or one whole day), and every chunk saves the index with its units **before** any of its documents, then
  the day documents, then the bar documents; a failure takes back the units of what was not written and saves the index again.
  Outcome snapshots and universes follow the same order. So every stored document stays reachable by pruning, a quota error
  stops the restore with a consistent index (the store is marked full), and a re-run stops at the same point or finishes once
  there is room. No aggressive pruning happens during a restore: it would delete this device's rows to make room for older ones.

### 5. Transport, per shell
- **Web:** `fetch` under the CSP; only the four hosts `login.microsoftonline.com`, `graph.microsoft.com`, `api.pcloud.com`
  and `eapi.pcloud.com`. The full host lists (native allowlist, sign-in pages, gateway templates) are in the ADR-0003
  amendment "v2.8 (17 Nov 2026, WP28)".
- **Backup transfer** has no Sign in step for B2 and R2: they use the bucket key added with the **Private API** header button
  (the key icon; `ctl.api`).
- **Desktop:** the Tauri HTTP plugin under the `BACKUP_NATIVE_URLS` scope (equal to the allowlist, R16). Sign-in pages open in
  the system browser through the opener scope.
- **Phone:** native HTTP under the same allowlist; sign-in in the system browser; return by a verified app link.
- Every request passes `isAllowedBackupUrl` before it is sent. Redirects are never followed: the web path uses
  `redirect: "manual"`, and a 3xx (or the opaque redirect) is `BackupError("http", { status: "3xx" })` on web and native
  alike (final review M-3).
- **Timeouts.** The web path of the provider HTTP port has the native deadline (final review M-3): 15 s to the headers (the
  native connect timeout) plus the request body at 64 KiB/s, then the response body by its Content-Length (or 20 MB) at
  64 KiB/s plus 15 s. The gateway client's deadline covers reading the body, not only the headers. In the gateway a PUT has 10 s plus
  the bytes at 128 KiB/s, capped at 5 minutes; a GET has 10 s to the headers, then an idle timer of 30 s between chunks.

### 6. Provider matrix

| Provider | Web | Desktop | Phone | Flow and scope |
|---|---|---|---|---|
| Google Drive | no | yes | no | loopback redirect + PKCE, `drive.appdata` only, no client secret |
| Microsoft OneDrive | yes | yes | with the app link | code + PKCE, `Files.ReadWrite.AppFolder`, no `offline_access`; restore blocked (section 10) |
| pCloud | yes | yes | with the app link | token flow; backups in `/rsL Confluence Backup`; codes 1000, 2000 and 2094 mean "sign in again" |
| Backblaze B2 | gateway | gateway | no | SigV4 through the local gateway, own bucket-restricted key |
| Cloudflare R2 | gateway | gateway | no | SigV4 through the local gateway, own bucket-restricted key |

The web needs the build's client ID and the official origin; otherwise the provider is "Not set up yet" or "Not set up for this
web address". "Web" for B2/R2 means the page talks to the gateway on the same computer.

### 7. Tokens live in memory
Access tokens are held in `backup-session.ts` memory only, cleared on reload, and never written to any storage, log, audit
entry, URL or backup. No refresh token (no `offline_access`). The web PKCE verifier and state live in `sessionStorage` under
`rsl-bk-oauth-v1` only between leaving for sign-in and returning, and are deleted on return. The web callback is consumed on
mount, with `history.replaceState` in a `finally` (even when it throws).

### 8. Gateway keys for B2 and R2
The gateway is a separate Node process started by hand (`pnpm gateway`); it is never bundled into or started by the apps, so a
key lives until that process stops, not until the app closes. Keys are held in gateway memory only (the WP25 rule): cleared at
exit and on a crash, never logged, never in an error or a response. A request refused before its body is read (Host, Origin,
token, and the early `/backup/upload` refusals) is answered once its body has arrived and been discarded (at most 21 MB), so an
upload sees its 401/403/409 and not a reset, also with `Connection: close` (final review M-8).
Requests are SigV4-signed with `node:crypto` to `s3.<region>.backblazeb2.com` or `<accountId>.r2.cloudflarestorage.com`, and
only to the object keys `rsl-confluence/<name>` with `<name>` matching `BACKUP_FILE_RE`. The **restriction test** at connect:
`HEAD /<bucket>` must answer 200 and the key must not enumerate other buckets (ListBuckets 403, or 200 naming only this
bucket). **A 403 means "cannot list buckets", not "restricted to one bucket"**, so an R2 token with Object Read & Write on all
buckets is accepted. The user is still told to make a one-bucket key; the gateway only ever addresses the one named bucket.
The upload route has its own 20 MB limit; every other gateway route keeps 32 KB.

### 9. Loopback listener and app link
- **Desktop loopback** (`oauth_loopback.rs`): binds `127.0.0.1:48787` only, never `0.0.0.0`; serves only `/callback`; drops the
  listener on every exit path; has a per-connection deadline; drains the request headers up to 16 KB so a closing socket cannot
  reset the page. pCloud returns its token in a URL fragment, which a server never receives, so a relay page reads it in the
  browser and sends it back as a query; the adapter rebuilds the fragment form so the web core parses what the provider sent.
  The final page scrubs the address with `history.replaceState(null, "", "/callback")`.
  **Residual risk:** the browser may still record the visit in its history, and a pCloud token does not expire. Mitigation: the
  user revokes the app's access in pCloud (`docs/backup-provider-setup.md` section 4).
- **pCloud web sign-in (final review M-4).** The same applies on the web: the token arrives in the fragment of the hosted page's
  address, the Home effect consumes and scrubs it, but the browser history keeps the visit with the token. The guide tells the
  user to delete that history entry and to revoke the app's access in pCloud if that is a concern.
- **Web callback.** The code or token stays in the address bar from the return until the Home effect runs, which consumes it and
  scrubs it. The only way the page could leak it is the `Referer` header on an outgoing request in that short window, and the
  build already sends `Referrer-Policy: no-referrer` (`apps/confluence/web/public/_headers` line 24 and `next.config.ts`
  line 48), so none is sent. The code is useless without the verifier in `sessionStorage`, which exists only in the
  tab that started the sign-in.
- **Phone app link:** `https://<hosted origin>/oauth/app/`, **off by default**. It exists only when the repository variable
  `RSL_APP_LINK` is `1` and a valid `RSL_ANDROID_CERT_SHA256` and/or `RSL_IOS_TEAM_ID` is set (public identifiers, never
  committed). Then the build writes `.well-known/assetlinks.json` and `apple-app-site-association`, one verified Android
  intent filter and the iOS associated-domain entitlements. Without it, OneDrive and pCloud on the phone say "Web and desktop
  only".

## Consequences

### Rulings made while building (what, why, cost if wrong)

| Decision | Why | Cost if wrong |
|---|---|---|
| Section lives in About, collapsed; Settings… opens About (plan author) | spec §3 item 8: design unchanged at rest | none |
| The 20 MB limit applies to the encrypted file; gzip inside; 160 MB decompression cap; oversize refused before upload (plan author) | bounded memory; a clear message before any network call | a user with a huge ledger must use CSV |
| OneDrive restore blocked until the owner verifies the download host (plan author) | the pre-authenticated file host is unverified and may not be allowed | OneDrive users cannot restore in the app until an amendment |
| Google is desktop-only (plan author, owner) | owner's documented assumption, to be confirmed by the manual check: web has no script-free flow that can be verified without a client secret; phone has no app-link redirect for Google in this build | Google users on web and phone use another provider |
| Phone app link off until the owner configures it (plan author) | needs signing identities and the Associated Domains capability | phone sign-in for OneDrive and pCloud stays off |
| pCloud token fragment relayed by a loopback relay page (plan author) | a server never sees a fragment | one extra local page |
| Backup excludes the paper account, open positions and risk settings; includes registered trials with pre-registrations (plan author) | a restore must never loosen a drawdown lock; trials carry the multiple-testing count | a user restoring on a new device starts a fresh paper account |
| OneDrive tokens are session-only (plan author) | no refresh token, nothing stored | one sign-in per session |
| PBKDF2-SHA-256 at 600,000 iterations (plan author, OWASP) | current OWASP figure | a faster guess rate if the figure rises (see below) |
| Header authenticated, with a test that removing the AAD is caught (Task 1) | the spec requires an authenticated header; a test set that cannot detect its removal is a gap | one extra test |
| Decompression cap by 16 KiB slices (Task 1) | Chromium inflates a whole write before output, so a single write let a bomb use gigabytes | none |
| Journal restore matches by content fingerprint and namespaces ids `bk:<8hex>:<origId>` (Task 2) | per-account counters cannot be cross-device keys; the old rule lost trades | restored ids differ from the originals (display only) |
| The dry-run row-cap count is exact, with age-pruned days separate (Task 2) | the user confirms against that number | a little extra dry-run work |
| Settings restore flags "differs from this device" and starts unticked (Task 2) | no audit time exists for profile changes | one extra confirmation |
| Env client IDs enter only the web-core build steps, and the gate test reads `readBackupConfig({})` (Task 4) | an owner setting a variable must never fail the gate | none |
| pCloud results 1000, 2000 and 2094 each clear the session and mean "sign in again" (Task 5) | 1000 is login required, 2094 an invalid token; the brief's single code was wrong | an extra sign-in prompt |
| pCloud backups go to the folder `/rsL Confluence Backup` (Task 5) | pCloud tokens reach the whole account, and a root listing grows with the user's files | one extra allowlisted path (`createfolderifnotexists`) |
| The desktop adapter rebuilds the pCloud redirect with the query as a fragment (Task 6) | keeps provider-specific parsing in the web core | none |
| The loopback treats any `/callback` target containing `?` as final; only a bare `/callback` gets the relay page (Task 6) | stops the relay loop on an empty fragment | none |
| The DONE page scrubs the address with `history.replaceState` (Task 6) | a non-expiring token must not linger in the address bar | one script line on a local page; the browser may still log the visit, so the user can revoke the token |
| A partial restore is audited (`backup.cloud.restore.partial`) and reported honestly; a re-run is safe (Task 10) | a restore must never silently lose or misreport records | one more message key |
| Owner check: Google token exchange without a secret (Task 4) | forum reports say Google may refuse it | if refused, Google stays unavailable until the owner allows Google's public installed-app secret, which needs a spec exception |
| Entra loopback redirect added through the manifest `replyUrlsWithType` (Task 11) | the portal box cannot add an `http` `127.0.0.1` URI | if Entra refuses, desktop OneDrive sign-in fails until the developer changes the port or flow |
| R2 all-bucket token gets 403 on ListBuckets and is accepted (Task 8, 11) | 403 proves only "cannot list buckets" | a wider key than needed; the gateway still addresses one bucket |
| Outcome snapshots, universes, gaps and trade notes join payload schema 1 (final review I-1) | they are the user's scored records; schema 1 was unreleased | larger backups (the 20 MB limit still holds) |
| Snapshots and universes are restored only while they fit under the row cap, never evicting a row (final review I-1) | rows are the primary record; the plan stays exact | on a small device some snapshots are not kept (counted) |
| Restore writes ≤ 1,000-row chunks, index first, and stops on a full store (final review I-2) | every stored document stays prunable; no hidden eviction | a slower restore |
| Early gateway refusals answer after draining the body (final review M-8) | Node closes a `Connection: close` socket at once, resetting an upload | the client sends the whole body before it learns of a refusal |

### Google Drive is desktop-only
These are the owner's documented assumptions, not verified facts; the manual check in `docs/backup-provider-setup.md`
  section 8 settles them.
- **Web:** assumed: no script-free flow that can be verified here. The app loads no third-party sign-in script and carries no client
  secret. Hosts `oauth2.googleapis.com` and `www.googleapis.com` are therefore in no CSP.
- **Phone:** assumed: no app-link redirect for Google in this build (the phone link is also off by default).
- **Desktop:** loopback + PKCE. Google may refuse the token exchange without a client secret; that is an owner check with a
  decision path in `docs/backup-provider-setup.md` sections 2 and 8.

### OneDrive download origin
OneDrive may answer a download with a redirect to a pre-authenticated host. `ONEDRIVE_DOWNLOAD_ORIGINS` is empty until the manual
check, so restore refuses with `bk.err.download-host` and names the host. Adding one needs an ADR-0003 amendment and entries in
`CSP_HOSTS` and `BACKUP_NATIVE_URLS`.

### Deferred checks
Section 8 of `docs/backup-provider-setup.md` lists the manual checks. Until each is done, treat it as unverified:
CORS from the hosted origin for the OneDrive token endpoint, Graph and the pCloud API; Google's token exchange without a
secret; pCloud's Bearer header, `gettextfile`, `uploadfile` and region host; the OneDrive download origin; sign-in on
Windows, macOS, Linux, Android and iPhone; and each provider's terms and limits. A host that fails is removed, ADR-0003 is
amended and the user guide is updated.

### Raising the iteration count later
Write a higher `iter` in new files. Older files still open as long as their `iter` is at least 600,000, because the value is
read from the authenticated header. If the floor itself ever rises, lower files need a documented migration (open with the
old value, seal again). An iteration count above 5,000,000 (`PBKDF2_MAX_ITERATIONS`) is refused when opening, so
raising past it needs a code change to that constant first.

### Other costs
- A forgotten passphrase is final; the guide says so.
- A restore onto a full store stops part-way and says so; the user frees space and runs it again (section 4).
- Old backups pile up (each up to 20 MB); the guide tells the user to delete them, and every listing shows the newest first
  (OneDrive asks Graph for `$orderby=lastModifiedDateTime desc`, final review M-7).
- Two more hosts families to keep in step: ADR-0003, `public-hosts.ts`, the CSP, the Tauri scopes and the egress manifest
  (R8, R11, R16).
