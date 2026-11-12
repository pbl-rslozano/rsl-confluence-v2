# Runbook — Rotate a signing key

Applies to the Android upload keystore, Apple Developer ID certificate and (later) a Windows signing certificate. The app has **no license key** and **no updater key** (ADR-0004, ADR-0005).

1. Create the new key offline. Android: on your PC run `powershell -ExecutionPolicy Bypass -File tools\new-android-key.ps1` — it makes the key (RSA 4096, PKCS12, alias `rsl-conf`), and saves the four Android secrets (plus `NETLIFY_AUTH_TOKEN` if missing) through the GitHub CLI, or guides you to paste them; it never prints the key or password. Manual alternative: `keytool -genkeypair -v -keystore new.keystore -storetype PKCS12 -alias rsl-conf -keyalg RSA -keysize 4096 -validity 10000`, then save `[Convert]::ToBase64String([IO.File]::ReadAllBytes("new.keystore"))` as `ANDROID_KEYSTORE_B64`. Apple: new Developer ID certificate in the developer portal.
2. Store the private part offline (encrypted volume + one offline copy). Never commit it; `.gitignore` and release-check R1 block `*.keystore`, `*.p12`, `*.pem`, `*-PRIVATE*`.
3. Replace the GitHub secrets listed in *release-and-sign*.
4. Android with Play App Signing: request an upload-key reset in Play Console. Sideloaded APKs signed with a new key cannot update the old install — uninstall first after exporting a backup.
5. Revoke the old certificate (Apple) or mark the old keystore retired. Record the date and reason in the CHANGELOG.
6. Android: build with a `[release-android]` commit on `main` (gate + Android + update channel only). Say in the CHANGELOG's first bullet that phones must uninstall once; that bullet is shown in the in-app update notice.

**History:** 12 Nov 2026 — Android key replaced for v2.7.0 (v2.6 key not recoverable). See CHANGELOG v2.7.0 and plan WP18.
