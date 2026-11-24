#!/bin/sh
# cutover.sh: puts the Rust desktop app in the Electrobun app's place on this Mac, and back.
# PORTING.md ("The cutover") says when; this does it, one Mac at a time, run there by the user.
#
#   cutover.sh install <Switchboard.app | .zip>   the live build (ship.sh with SWITCH_GPUI_LIVE=1)
#   cutover.sh rollback                           Electrobun back, as it was
#
# install:
#   1. checks the build is the live one: the same bundle id as the installed app, the switchboard
#      scheme, a valid signature;
#   2. quits the Electrobun app and waits until no app with its id runs (the Rust app carries over
#      Electrobun's outbox only once it has quit, so nothing held for Undo there can still go);
#   3. says whether this Mac's credential is there (~/.switch/desktop-credential.json or the
#      Keychain's item), never what it is;
#   4. keeps the Electrobun app aside for a rollback (~/.switch/rollback/), moves its update record
#      (update-tried.json, the same path for both apps) aside, and carries its pending reports
#      (~/.switch/desktop-reports.json) into the Rust app's;
#   5. installs the build as /Applications/Switchboard.app, registers it for the switchboard scheme
#      (and the kept Electrobun copy off it), removes the side-by-side "Switch GPUI" app;
#   6. opens it: its first launch there carries over Electrobun's outbox, drafts and files.
#
# rollback quits the Rust app, puts the kept Electrobun app back, its update record too, registers
# it again and opens it. The Rust app's own data stays (Application Support/<id>/gpui).
set -eu

LIVE=/Applications/Switchboard.app
KEEP=$HOME/.switch/rollback
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

say() { echo "[cutover $(date +%H:%M:%S)] $*"; }
die() { say "$*"; exit 1; }
id_of() { plutil -extract CFBundleIdentifier raw -o - "$1/Contents/Info.plist" 2>/dev/null || true; }

# Asks the app with bundle id $1 to quit, and waits (up to a minute) until none runs.
quit_app() {
  osascript -e "tell application id \"$1\" to quit" >/dev/null 2>&1 || true
  n=0
  while osascript -e "application id \"$1\" is running" 2>/dev/null | grep -q true; do
    n=$((n + 1))
    [ $n -le 60 ] || return 1
    sleep 1
  done
}

install() {
  [ $# -eq 1 ] || die "cutover.sh install <Switchboard.app | .zip>"
  [ -d "$LIVE" ] || die "No $LIVE here"
  ID=$(id_of "$LIVE")
  [ -n "$ID" ] || die "Can't read $LIVE's bundle id"
  work=$(mktemp -d)
  case $1 in
    *.zip) ditto -x -k "$1" "$work" && NEW=$(find "$work" -maxdepth 1 -name "*.app" | head -1) ;;
    *) NEW=$1 ;;
  esac
  [ -d "$NEW" ] || die "No app in $1"

  # 1. The live build: the installed app's id, the switchboard scheme, signed.
  [ "$(id_of "$NEW")" = "$ID" ] || die "$NEW is $(id_of "$NEW"), not $ID: build it with SWITCH_GPUI_LIVE=1"
  plutil -extract CFBundleURLTypes.0.CFBundleURLSchemes.0 raw -o - "$NEW/Contents/Info.plist" 2>/dev/null | grep -qx switchboard \
    || die "$NEW doesn't open switchboard links"
  codesign --verify --deep --strict "$NEW" || die "$NEW's signature doesn't verify"
  [ -x "$NEW/Contents/MacOS/switch-gpui" ] || die "$NEW isn't the Rust app"
  [ ! -x "$LIVE/Contents/MacOS/switch-gpui" ] || die "$LIVE is the Rust app already"

  # 2. Electrobun quit, and nothing of its id left running.
  say "Quitting $ID"
  quit_app "$ID" || die "$ID didn't quit: quit it, then run this again"

  # 3. This Mac's credential, as the Rust app finds it (never shown).
  core=$(plutil -extract core raw -o - "$HOME/.switch/config.json" 2>/dev/null || echo "http://127.0.0.1:4871")
  if plutil -extract "$core" raw -o - "$HOME/.switch/desktop-credential.json" >/dev/null 2>&1; then
    say "Credential: in ~/.switch/desktop-credential.json"
  elif security find-generic-password -s Switchboard -a "$core" >/dev/null 2>&1; then
    say "Credential: in the Keychain"
  else
    say "Credential: none for $core (the app will pair, or mint one on the core's own Mac)"
  fi

  # 4. Electrobun kept aside, its update record moved off the shared path, its reports carried.
  mkdir -p "$KEEP"
  stamp=$(date +%Y%m%d-%H%M%S)
  ditto "$LIVE" "$KEEP/Switchboard-electrobun-$stamp.app"
  ln -sfn "$KEEP/Switchboard-electrobun-$stamp.app" "$KEEP/Switchboard-electrobun.app"
  support="$HOME/Library/Application Support/$ID"
  [ ! -f "$support/update-tried.json" ] || mv "$support/update-tried.json" "$support/update-tried.electrobun.json"
  if [ -s "$HOME/.switch/desktop-reports.json" ]; then
    mkdir -p "$support"
    python3 - "$HOME/.switch/desktop-reports.json" "$support/reports.json" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
try:
    theirs = json.load(open(src))
except Exception:
    theirs = []
try:
    mine = json.load(open(dst))
except Exception:
    mine = []
seen = {r.get("id") for r in mine}
mine += [r for r in theirs if isinstance(r, dict) and r.get("id") not in seen]
json.dump(mine, open(dst, "w"))
print(f"[cutover] {len(theirs)} pending report(s) carried")
PY
    mv "$HOME/.switch/desktop-reports.json" "$HOME/.switch/desktop-reports.carried.json"
  fi

  # 5. In its place, linked to the switchboard scheme; the side-by-side app gone.
  say "Installing $NEW as $LIVE"
  rm -rf "$LIVE"
  ditto "$NEW" "$LIVE"
  xattr -dr com.apple.quarantine "$LIVE" 2>/dev/null || true
  "$LSREGISTER" -u "$KEEP/Switchboard-electrobun-$stamp.app" >/dev/null 2>&1 || true
  "$LSREGISTER" -f "$LIVE"
  for side in "$HOME/Applications/Switch GPUI.app" "/Applications/Switch GPUI.app"; do
    if [ -d "$side" ]; then
      quit_app "$(id_of "$side")" || true
      "$LSREGISTER" -u "$side" >/dev/null 2>&1 || true
      rm -rf "$side"
      say "Removed $side (its data stays in Application Support)"
    fi
  done
  rm -rf "$work"

  # 6. Open: its first launch carries over what Electrobun kept.
  open "$LIVE"
  say "Done. Rollback: cutover.sh rollback"
}

rollback() {
  [ -d "$KEEP/Switchboard-electrobun.app" ] || die "No Electrobun app kept in $KEEP"
  ID=$(id_of "$LIVE")
  say "Quitting $ID"
  quit_app "$ID" || die "$ID didn't quit"
  rm -rf "$LIVE"
  ditto "$KEEP/Switchboard-electrobun.app/" "$LIVE"
  support="$HOME/Library/Application Support/$ID"
  [ ! -f "$support/update-tried.electrobun.json" ] || mv "$support/update-tried.electrobun.json" "$support/update-tried.json"
  "$LSREGISTER" -f "$LIVE"
  open "$LIVE"
  say "Electrobun is back"
}

case ${1:-} in
  install) shift && install "$@" ;;
  rollback) rollback ;;
  *) die "cutover.sh install <Switchboard.app | .zip> | rollback" ;;
esac
