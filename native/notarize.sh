#!/bin/bash
# Notarize RAM Guard so it runs on OTHER Macs without the Gatekeeper "unidentified developer" block.
# This machine currently has NO Developer ID cert, so this can't run yet. It's ready for the day it can.
#
# ONE-TIME SETUP (the part only Drey can do — it costs money + needs an Apple account):
#   1. Join the Apple Developer Program ($99/yr):  https://developer.apple.com/programs/
#   2. Create + install a "Developer ID Application" certificate
#        (Xcode ▸ Settings ▸ Accounts ▸ your team ▸ Manage Certificates ▸ + ▸ Developer ID Application)
#   3. Store notarytool credentials once (app-specific password from appleid.apple.com):
#        xcrun notarytool store-credentials ramguard-notary \
#          --apple-id "<your-apple-id>" --team-id "<TEAMID>" --password "<app-specific-password>"
#
# THEN, every release:
#   ./build.sh                         # produce the .app
#   ./notarize.sh "Developer ID Application: Your Name (TEAMID)"
set -euo pipefail
cd "$(dirname "$0")"
IDENTITY="${1:?Pass your Developer ID Application identity, e.g. 'Developer ID Application: Name (TEAMID)'}"
PROFILE="${2:-ramguard-notary}"
APP="RAM Guard.app"

# 1. Re-sign with the REAL identity + hardened runtime + secure timestamp (all required to notarize).
codesign --force --deep --options runtime --timestamp --sign "$IDENTITY" "$APP"
codesign --verify --strict --verbose=2 "$APP"

# 2. Zip + submit to Apple, block until the verdict comes back.
ZIP="/tmp/RAMGuard-notarize.zip"
rm -f "$ZIP"; ditto -c -k --keepParent "$APP" "$ZIP"
xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait

# 3. Staple the ticket so it verifies even offline, then confirm.
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose=2 "$APP"   # should print "accepted ... Notarized Developer ID"
echo "notarized + stapled: $APP"
