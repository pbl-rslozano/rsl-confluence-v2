# Runbook — Rotate a signing key

Applies to the Android upload keystore, Apple Developer ID certificate and (later) a Windows signing certificate. The app has **no license key** and **no updater key** (ADR-0004, ADR-0005).

1. Create the new key offline (Android: `keytool -genkeypair -v -keystore new.keystore -alias rsl-conf -keyalg RSA -keysize 4096 -validity 9125`; Apple: new Developer ID certificate in the developer portal).
2. Store the private part offline (encrypted volume + one offline copy). Never commit it; `.gitignore` and release-check R1 block `*.keystore`, `*.p12`, `*.pem`, `*-PRIVATE*`.
3. Replace the GitHub secrets listed in *release-and-sign*.
4. Android with Play App Signing: request an upload-key reset in Play Console. Sideloaded APKs signed with a new key cannot update the old install — uninstall first after exporting a backup.
5. Revoke the old certificate (Apple) or mark the old keystore retired. Record the date and reason in the CHANGELOG.
