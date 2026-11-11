#!/usr/bin/env bash
set -euo pipefail
# With no Apple material, retain the established unsigned sideloading path.
# A partially configured signing identity remains an error.
if [[ -z "${IOS_CERTIFICATE_B64:-}" && -z "${IOS_PROFILE_B64:-}" && -z "${IOS_CERTIFICATE_PASSWORD:-}" ]]; then
  temp="${RUNNER_TEMP:?}/confluence-ios-unsigned"
  xcodebuild -project apps/confluence/mobile/ios/App/App.xcodeproj -scheme App \
    -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' \
    -derivedDataPath "$temp/build" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build
  mkdir -p "$temp/package/Payload" dist/ios
  cp -R "$temp/build/Build/Products/Release-iphoneos/App.app" "$temp/package/Payload/"
  output="$PWD/dist/ios/rsL-Confluence-$(node -p "require('./package.json').version")-iphone-unsigned.ipa"
  (cd "$temp/package" && zip -qry "$output" Payload)
  echo "::warning::Unsigned iPhone IPA: sign for your device before installation."
  exit 0
fi
for name in IOS_CERTIFICATE_B64 IOS_CERTIFICATE_PASSWORD IOS_PROFILE_B64; do
  if [[ -z "${!name:-}" ]]; then
    echo "::error::Missing signing secret $name"
    exit 1
  fi
done
temp="${RUNNER_TEMP:?}/confluence-ios"
mkdir -p "$temp"
keychain="$temp/signing.keychain-db"
password="$(openssl rand -hex 24)"
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -f "$temp/distribution.p12" "$temp/profile.mobileprovision" "$temp/profile.plist"
}
trap cleanup EXIT
printf '%s' "$IOS_CERTIFICATE_B64" | base64 --decode > "$temp/distribution.p12"
printf '%s' "$IOS_PROFILE_B64" | base64 --decode > "$temp/profile.mobileprovision"
security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
security import "$temp/distribution.p12" -P "$IOS_CERTIFICATE_PASSWORD" -A -t cert -f pkcs12 -k "$keychain"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain"
security list-keychains -d user -s "$keychain" "$HOME/Library/Keychains/login.keychain-db"
security cms -D -i "$temp/profile.mobileprovision" > "$temp/profile.plist"
export IOS_PROFILE_PLIST="$temp/profile.plist"
export IOS_EXPORT_OPTIONS="$temp/ExportOptions.plist"
python3 tools/ios-export-options.py
# Python writes GITHUB_ENV for later steps. This process needs the same values.
team="$(/usr/libexec/PlistBuddy -c 'Print TeamIdentifier:0' "$temp/profile.plist")"
uuid="$(/usr/libexec/PlistBuddy -c 'Print UUID' "$temp/profile.plist")"
mkdir -p "$HOME/Library/MobileDevice/Provisioning Profiles"
cp "$temp/profile.mobileprovision" "$HOME/Library/MobileDevice/Provisioning Profiles/$uuid.mobileprovision"
trap 'rm -f "$HOME/Library/MobileDevice/Provisioning Profiles/'"$uuid"'.mobileprovision"; cleanup' EXIT
version="$(node -p "require('./package.json').version")"
xcodebuild -project apps/confluence/mobile/ios/App/App.xcodeproj -scheme App   -configuration Release -destination 'generic/platform=iOS'   -archivePath "$temp/Confluence.xcarchive"   DEVELOPMENT_TEAM="$team" CODE_SIGN_STYLE=Manual   CODE_SIGN_IDENTITY="Apple Distribution" PROVISIONING_PROFILE_SPECIFIER="$uuid"   MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="${GITHUB_RUN_NUMBER:?}"   OTHER_CODE_SIGN_FLAGS="--keychain $keychain" archive
mkdir -p dist/ios
xcodebuild -exportArchive -archivePath "$temp/Confluence.xcarchive"   -exportOptionsPlist "$temp/ExportOptions.plist" -exportPath dist/ios
