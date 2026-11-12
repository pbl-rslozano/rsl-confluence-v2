# Separate GitHub platform releases

The release workflow has four independent native build jobs and four
publication jobs. A failed Apple signing job does not block the Windows
or Android release. Each build runs after the shared test and acceptance
gate. Manual workflow dispatch enables all four platforms. Tag-triggered
runs use the release version from package.json. Pushes to main whose commit
message contains [release] also build all platforms.

The separate release tags are v2.4.0-windows, v2.4.0-macos,
v2.4.0-android and v2.4.0-iphone. Platform tags are excluded from the
build trigger to prevent recursive release runs. Existing tags pointing
to another source commit are refused. Releases default to drafts.
Manual workflow dispatch can select public publication.

## Repository setup

Upload this source to the intended GitHub repository, enable Actions and
allow the workflow to create release assets. Run the release workflow
from that commit. Windows produces MSI and EXE installers. macOS builds
a universal DMG. Android produces a signed APK and AAB. iPhone produces
a signed IPA. Assets include basename-compatible SHA-256 sidecars.

## Signing configuration

Store signing materials in GitHub repository secrets.

macOS requires APPLE_CERTIFICATE (base64 P12), APPLE_CERTIFICATE_PASSWORD,
APPLE_SIGNING_IDENTITY, APPLE_API_ISSUER, APPLE_API_KEY and
APPLE_API_KEY_B64 (base64 App Store Connect P8 private key).
The workflow creates a temporary key file for notarization.

Android requires ANDROID_KEYSTORE_B64, ANDROID_KEYSTORE_PASSWORD,
ANDROID_KEY_ALIAS and ANDROID_KEY_PASSWORD. Keep the release keystore
for future app updates. The generated native project receives the
2.4.0 version name and the footer build date plus the workflow run number
as version code, preserving upgrades from the date-based v2.3 builds.

iPhone requires IOS_CERTIFICATE_B64 (base64 Apple Distribution P12),
IOS_CERTIFICATE_PASSWORD and IOS_PROFILE_B64 (base64 provisioning profile).
The profile must match com.rslozano.confluence. The release-testing
export method requires registered devices in that profile. Select
app-store-connect for App Store Connect distribution. Downloading that
IPA from GitHub does not submit it to TestFlight or the App Store.

Windows installers build without a signing certificate in the current
configuration. Windows signing can be configured in the Tauri Windows
bundle settings with the user's signing provider.

## Local validation and remaining prerequisites

Workflow YAML and the independent release dependency graph were validated.
The iPhone shell passed bash syntax validation. Export-option fixtures
accepted a matching profile and rejected a different app. The source was uploaded to rslozano/rsl-confluence main at commit
90fa621f0da44504f6607309a8e23fe0068d9714. GitHub Actions run 42024979141
was launched for the first native release builds. Signing secrets are
validated by their build steps; their values are never read by the agent.
Native installation and device behavior need verification after CI builds.

Actions were pinned to upstream commit SHAs retrieved during preparation.
The application PWA artifacts from the prior release remain available
separately. This archive is the source prepared for native release CI.

## Unsigned Apple packages

At the user's request, completely absent Apple credentials produce an ad-hoc
signed, unnotarized macOS DMG and an unsigned iPhone device IPA. The IPA
must be signed for the target device before installation. Partial Apple
signing configuration still fails explicitly. Complete credentials select
the signed distribution paths. A [release-apple] main commit rebuilds only
the Apple jobs after the full verification gate. Likewise a [release-android] main
commit builds only Android, its release and the Netlify update channel (v2.7, WP18).
