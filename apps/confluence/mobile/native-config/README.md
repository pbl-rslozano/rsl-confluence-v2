# Native project settings applied after `cap add`

`android/` and `ios/` are generated (`pnpm --filter @rsl/confluence-mobile add:android` / `add:ios`)
and are not committed. Apply these once after generating — `tools/apply-native-config.mjs` does it:

## Android (`android/app/src/main/AndroidManifest.xml`)
- `<application android:allowBackup="false" android:usesCleartextTraffic="false" …>` — records
  must not leave the device through cloud backup; no cleartext HTTP (all exchange hosts are https).
- `android:screenOrientation` is not locked; the app is portrait-first via CSS.
- `minSdkVersion 29` (Android 10+).

## iOS (`ios/App/App/Info.plist`)
- Swift Package Manager project (`cap add ios --packagemanager SPM`; CocoaPods trunk is read-only from 2 Dec 2026).
- Leave App Transport Security at its defaults (https only).
- `UISupportedInterfaceOrientations~iphone`: portrait; iPad: all.
- Deployment target iOS 17.0.
