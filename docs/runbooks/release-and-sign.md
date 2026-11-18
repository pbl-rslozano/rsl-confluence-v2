# Runbook — Release and sign

1. **Bump** `package.json` version, `apps/confluence/web/src/lib/build-info.ts`, `src/rsl/app-info.ts` (`version`, `build`), `tauri.conf.json` `version`, `public/sw.js` `CACHE_VERSION`, and add a CHANGELOG entry.
2. **Local gate** (Node 22.5+, pnpm 10.34.9):
   ```
   pnpm install --frozen-lockfile
   pnpm typecheck && pnpm lint
   pnpm sbom
   node tools/release-check.mjs --with-tests      # must print 10/10
   pnpm build:pwa
   (cd apps/confluence/web/out && python3 -m http.server 8770 --bind 127.0.0.1 &) && pnpm e2e   # must print all passed
   ```
3. **Tag** `v2.2.0` and push. `.github/workflows/release.yml` runs the gate again, then builds Windows (.msi/.exe), macOS (universal .dmg), Android (.aab/.apk) and an iOS simulator compile.
4. **Signing secrets** (GitHub → Settings → Secrets; never in the repo):
   - macOS: `APPLE_CERTIFICATE` (base64 .p12 Developer ID Application), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH` (notarisation).
   - Windows: add a `bundle.windows.signCommand` (e.g. Azure Trusted Signing) once a certificate exists.
   - Android: `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
     **versionCode** (set in CI by `tools/set-android-version.mjs`): since 18 Nov 2026 it is `build × 100 + (run number mod
     100)`, e.g. 2026111836 for build 20261118 in run 36 (was `build + run number`). Every 2.8.0 code is above any 2.7.0
     code, and the scheme stays under Android's 2,100,000,000 cap through 2099. Two builds with the same build date
     collide only when the run number wraps (runs 100 apart); bump the build date for a second release on one day if in
     doubt. The iOS `CURRENT_PROJECT_VERSION` is unchanged; it matters only for App Store Connect, which this app does
     not use.
   - iOS: personal device install via Xcode with your Apple ID, or an Apple Business custom app if ever shared (no public App Store build).
   - 2.8.0 (owner decision 18 Nov 2026): no Windows certificate and no Apple secrets — Windows ships unsigned, macOS ad-hoc
     signed without notarisation (`RSL_MACOS_UNSIGNED`, set automatically when the six Apple secrets are absent).
5. **Build without publishing:** run the release workflow by hand with `publish` unticked (the default). It builds and
   uploads the installers as workflow artifacts only; the update channel and GitHub releases are untouched. Publish with a
   second dispatch (`publish` ticked) or a tag only after the owner has approved the installers.
6. **Before the first shared release:** pin every `uses:` action to a full commit SHA.
7. **Publish**: attach installers, `rsL-Confluence-<ver>-pwa.zip` (e.g. `rsL-Confluence-2.8.0-pwa.zip`) + `.sha256`, and the SBOM. Keep keys offline; report only their location.
