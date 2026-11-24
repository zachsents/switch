#!/bin/sh
# bundle.sh [cargo build args, e.g. --features shot]: builds the app for release and wraps it in
# build/ with the desktop's icon, its helpers (dictation, Quick Look) beside its binary, and the
# microphone's entitlement and prompt (the desktop's electrobun.config.ts and native/post-build.ts).
# Open it to run it against the core this Mac's Switch config names.
#
# A test build sits beside the live app, under its own name and id. A release (scripts/ship.sh)
# names them, and signs:
#   SWITCH_APP_NAME      the app's name (default "Switch GPUI")
#   SWITCH_APP_ID        its bundle id (default switch.gpui.demo)
#   SWITCH_APP_VERSION   its version, which updates compare (baked in too)
#   SWITCH_BUILD_HASH    its commit (baked in too)
#   SWITCH_GPUI_UPDATES  its update feed (baked in; none is the dev channel, which never updates)
#   SWITCH_APP_SCHEME    a URL scheme it opens ("switchboard" once it's the live app; none beside it,
#                        so links still open the live one)
#   SWITCH_SIGN_IDENTITY a Developer ID to sign with, hardened (ad hoc without one)
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
cd "$HERE"
NAME=${SWITCH_APP_NAME:-Switch GPUI}
ID=${SWITCH_APP_ID:-switch.gpui.demo}
VERSION=${SWITCH_APP_VERSION:-0.1.0}
SCHEME=${SWITCH_APP_SCHEME:-}
export SWITCH_APP_VERSION="$VERSION" SWITCH_BUILD_HASH="${SWITCH_BUILD_HASH:-$(git rev-parse HEAD 2>/dev/null || echo dev)}"
nice -n 10 cargo build --release "$@"
# Every worktree builds into one shared target (CARGO_TARGET_DIR); its app goes in this worktree.
TARGET=${CARGO_TARGET_DIR:-target}
mkdir -p build
APP="build/$NAME.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$TARGET/release/switch-gpui" "$APP/Contents/MacOS/switch-gpui"
cp "$TARGET/release/switch-dictation" "$TARGET/release/switch-quicklook" "$APP/Contents/MacOS/"
iconutil -c icns -o "$APP/Contents/Resources/icon.icns" ../desktop/assets/brand/icon.iconset
URLS=""
if [ -n "$SCHEME" ]; then
  URLS="<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>$ID</string><key>CFBundleURLSchemes</key><array><string>$SCHEME</string></array></dict></array>"
fi
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>$NAME</string>
<key>CFBundleDisplayName</key><string>$NAME</string>
<key>CFBundleIdentifier</key><string>$ID</string>
<key>CFBundleExecutable</key><string>switch-gpui</string>
<key>CFBundleIconFile</key><string>icon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$VERSION</string>
<key>CFBundleVersion</key><string>$VERSION</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSMicrophoneUsageDescription</key><string>For dictation.</string>
$URLS
</dict></plist>
PLIST
ENT="build/app.entitlements"
cat > "$ENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.device.audio-input</key><true/>
</dict></plist>
PLIST
if [ -n "${SWITCH_SIGN_IDENTITY:-}" ]; then
  for helper in switch-dictation switch-quicklook; do
    codesign --force --options runtime --timestamp --entitlements "$ENT" --identifier "$ID.$helper" --sign "$SWITCH_SIGN_IDENTITY" "$APP/Contents/MacOS/$helper"
  done
  codesign --force --options runtime --timestamp --entitlements "$ENT" --sign "$SWITCH_SIGN_IDENTITY" "$APP"
  codesign --verify --deep --strict "$APP"
else
  codesign -s - --force --deep --entitlements "$ENT" "$APP" >/dev/null 2>&1 || true
fi
echo "$HERE/$APP"
