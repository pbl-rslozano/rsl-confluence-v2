# Phone builds — Android APK and iPhone IPA (v2.3 · build 20261101)

Both are built by GitHub Actions (`.github/workflows/mobile.yml`) as two separate jobs with
two separate downloads. They run on every push to `main`, or on demand: **Actions → mobile →
Run workflow**. When a run finishes, open it and download **android-apk** or **iphone-ipa**
under *Artifacts* (GitHub keeps them for 90 days).

Personal edition, paper trading only — the app sends no exchange orders. Not financial advice.

## Android (signed APK)

The APK is signed with your own release key. The key lives only in
`rsL-Confluence-Android-Signing-PRIVATE\` (P: drive) and in four encrypted repository secrets:
`ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
Without them the job stops with an error, because Android will not install an unsigned APK.

Install:
1. Copy `rsL-Confluence-v2.3-2026-build<date>.apk` to the phone (USB, Google Drive, e-mail).
2. Tap it. Allow **Install unknown apps** for the app you opened it from when Android asks.
3. Updates: install the newer APK over the old one; data is kept. This works only while the
   same key signs every build — back up the PRIVATE folder.

Check the file first if you like: the `.sha256` beside it must match
`certutil -hashfile <apk> SHA256` on Windows.

## iPhone (unsigned IPA → Sideloadly)

Apple only installs apps signed for your device. The workflow builds an **unsigned** `.ipa`
on GitHub's Mac; you sign and install it from Windows with **Sideloadly** and your Apple ID.

One-time setup on the PC:
1. Install **iTunes** and **iCloud** from apple.com (the website versions, not the Microsoft
   Store ones — Sideloadly needs them).
2. Install **Sideloadly** from sideloadly.io.

Install:
1. Connect the iPhone by USB and tap **Trust** on the phone.
2. Open Sideloadly, drop `rsL-Confluence-v2.3-2026-build<date>-unsigned.ipa` on it, enter your
   Apple ID, press **Start**. (Use an Apple ID you are comfortable using for this; an app-specific
   password is supported.)
3. On the iPhone: **Settings → General → VPN & Device Management** → trust your Apple ID.
4. iOS 16+: **Settings → Privacy & Security → Developer Mode** → on, then restart when asked.

Limits of a free Apple ID: the app stops opening after **7 days** — re-sign it with Sideloadly
(your data stays, because the bundle id is unchanged); at most 3 sideloaded apps at a time.
A paid Apple Developer account ($99/year) removes the 7-day limit (signing certificates would
then go into repository secrets — see `release-and-sign.md`).

No-install alternative: open the Netlify address in Safari → Share → **Add to Home Screen**.

## NOT VERIFIED

- The CI runs are the first real Android/iOS compiles of v2.3 (no device builds were possible
  in the development workspace). Device install and behaviour on a real phone are not yet tested.
- Sideloadly, iTunes/iCloud requirements and Apple's free-account limits are as published by
  those vendors at the time of writing and may change.
