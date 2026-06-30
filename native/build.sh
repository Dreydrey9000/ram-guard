#!/bin/bash
# Build RAM Guard (native Swift) -> .app bundle -> install to /Applications.
# Usage: ./build.sh            (build + bundle only)
#        ./build.sh install    (also kill running, copy to /Applications, relaunch)
set -euo pipefail
cd "$(dirname "$0")"

APP="RAM Guard.app"
# NOTE: list files explicitly (NOT *.swift) — selftest.swift has top-level code that conflicts with @main.
swiftc -parse-as-library -O Common.swift DiskEngines.swift DiskViews.swift RAMGuard.swift App.swift -o RAMGuard

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp RAMGuard      "$APP/Contents/MacOS/RAMGuard"
cp Info.plist    "$APP/Contents/Info.plist"
cp AppIcon.icns  "$APP/Contents/Resources/AppIcon.icns"
codesign --force --deep --sign - "$APP"
echo "built: $APP ($(du -sh "$APP" | cut -f1))"

if [[ "${1:-}" == "install" ]]; then
  pkill -f "/Applications/RAM Guard.app" 2>/dev/null || true
  sleep 1
  rm -rf "/Applications/$APP"
  cp -R "$APP" "/Applications/$APP"
  open "/Applications/$APP"
  echo "installed + relaunched: /Applications/$APP"
fi
