import os
import plistlib
from pathlib import Path

profile = plistlib.loads(Path(os.environ["IOS_PROFILE_PLIST"]).read_bytes())
team = profile["TeamIdentifier"][0]
bundle = "com.rslozano.confluence"
if profile["Entitlements"].get("application-identifier") != team + "." + bundle:
    raise SystemExit("Provisioning profile does not match the Confluence bundle ID")
method = os.environ.get("IOS_EXPORT_METHOD", "release-testing")
if method == "release-testing" and not profile.get("ProvisionedDevices"):
    raise SystemExit("release-testing requires a profile containing registered devices")
options = {
    "method": method,
    "teamID": team,
    "signingStyle": "manual",
    "signingCertificate": "Apple Distribution",
    "provisioningProfiles": {bundle: profile["UUID"]},
}
Path(os.environ["IOS_EXPORT_OPTIONS"]).write_bytes(plistlib.dumps(options))
with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as stream:
    stream.write("IOS_TEAM_ID=" + team + "\n")
    stream.write("IOS_PROFILE_UUID=" + profile["UUID"] + "\n")
