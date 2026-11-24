#!/bin/sh
# The Rust desktop app's own lane, run on the server (the mini) from a checkout of the gpui-desktop
# branch; never part of main's deploy (scripts/ship.sh there ships the TypeScript app). It builds the
# app at a commit, signs it with the deploy's Developer ID (hardened, with the microphone's
# entitlement), notarizes and staples it, and publishes it to a feed of its own, which the app's
# updater reads (src/platform/update.rs):
#
#   ~/.switch/updates-gpui/update.json         {"version","hash","url","sha256"}
#   ~/.switch/updates-gpui/Switch-<sha>.zip    the app, as ditto packs it
#
# served on loopback (ax.switch.updates-gpui) and to the tailnet as HTTPS through Tailscale Serve on
# a port of its own, beside the TypeScript app's feed. By default the app is "Switch GPUI" under an
# id of its own (<appId>.gpui), opening no links: it sits beside the live app and replaces nothing.
# SWITCH_GPUI_LIVE=1 builds it as the live app instead (the live name, appId and the switchboard
# scheme): only when the user decides to cut over.
#
#   ship.sh <sha>    build, sign, notarize and publish <sha>
#   ship.sh feed     the feed's server and Tailscale Serve, set up (each ship does it too)
#
# Who this install is lives in ~/.switch/deploy.json, never here.
set -eu
S=$HOME/.switch
LOGS=$HOME/Library/Logs/switch
DOMAIN=gui/$(id -u)
TAILSCALE=/Applications/Tailscale.app/Contents/MacOS/Tailscale
FEED_PORT=8446
LOCAL_PORT=4881
FEED=$S/updates-gpui
LABEL=ax.switch.updates-gpui
conf() { plutil -extract "$1" raw -o - "$S/deploy.json" 2>/dev/null || true; }
expand() { case $1 in "~/"*) echo "$HOME/${1#\~/}" ;; *) echo "$1" ;; esac; }
IDENTITY=$(conf identity)
APP_ID=$(conf appId)
SIGNING_KEYCHAIN=$(expand "$(conf keychain)")
KEYCHAIN_PASS=$(expand "$(conf keychainPassFile)")
NOTARY_KEY=$(expand "$(conf notaryKey)")
NOTARY_KEY_ID=$(conf notaryKeyId)
NOTARY_ISSUER=$(conf notaryIssuer)
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p "$LOGS"

say() { echo "[ship-gpui $(date +%H:%M:%S)] $*"; }
# Below the live core: utility QoS, as the main lane builds.
behind() { /usr/sbin/taskpolicy -c utility "$@"; }

# The feed's address: this machine's tailnet name, on the feed's port.
feed_url() {
  name=$("$TAILSCALE" status --self --json | plutil -extract Self.DNSName raw -o - -)
  echo "https://${name%.}:$FEED_PORT"
}

unlock_signing() {
  [ -z "$SIGNING_KEYCHAIN" ] || security unlock-keychain -p "$(cat "$KEYCHAIN_PASS")" "$SIGNING_KEYCHAIN"
}

# The feed's server on loopback, and Tailscale Serve's HTTPS port for it. Loaded again only when its
# settings changed.
feed() {
  mkdir -p "$FEED"
  "$TAILSCALE" serve --bg --https=$FEED_PORT http://127.0.0.1:$LOCAL_PORT >/dev/null
  plist=$HOME/Library/LaunchAgents/$LABEL.plist
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>/usr/bin/python3</string><string>-m</string><string>http.server</string><string>$LOCAL_PORT</string><string>--bind</string><string>127.0.0.1</string><string>--directory</string><string>$FEED</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$LOGS/updates-gpui.log</string>
<key>StandardErrorPath</key><string>$LOGS/updates-gpui.log</string>
</dict></plist>
PLIST
  if cmp -s "$plist" "$plist.loaded" && launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then return 0; fi
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  for _ in $(seq 40); do
    launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
    sleep 0.25
  done
  launchctl enable "$DOMAIN/$LABEL"
  launchctl bootstrap "$DOMAIN" "$plist"
  cp "$plist" "$plist.loaded"
}

# Notarized and stapled. Apple being slow or down leaves it signed but not stapled: Gatekeeper then
# asks Apple online the first time it opens.
notarize() {
  app=$1
  [ -n "$NOTARY_KEY_ID" ] || return 1
  zip=$(mktemp -d)/notarize.zip
  ditto -c -k --keepParent "$app" "$zip"
  ok=1
  if xcrun notarytool submit "$zip" --key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER" --wait --timeout 15m | grep -q 'status: Accepted'; then ok=0; fi
  rm -rf "$(dirname "$zip")"
  [ "$ok" = 0 ] || return 1
  xcrun stapler staple "$app"
}

ship() {
  sha=$1
  [ -n "$IDENTITY" ] && [ -n "$APP_ID" ] || { say "FAILED: ~/.switch/deploy.json needs identity and appId"; exit 1; }
  src=$S/gpui-src
  [ -d "$src" ] || git -C "$S/repo.git" worktree add -q --detach "$src" "$sha"
  git -C "$src" checkout -q --detach --force "$sha"
  if [ "${SWITCH_GPUI_LIVE:-}" = 1 ]; then
    name=Switchboard id=$APP_ID scheme=switchboard
  else
    name="Switch GPUI" id=$APP_ID.gpui scheme=
  fi
  version="0.1.$(date +%s)"
  url=$(feed_url)
  unlock_signing
  say "building $sha as $name ($id) $version"
  (
    cd "$src/apps/desktop-gpui"
    CARGO_TARGET_DIR=$S/gpui-target SWITCH_APP_NAME=$name SWITCH_APP_ID=$id SWITCH_APP_VERSION=$version \
      SWITCH_BUILD_HASH=$sha SWITCH_GPUI_UPDATES=$url SWITCH_APP_SCHEME=$scheme SWITCH_SIGN_IDENTITY=$IDENTITY \
      behind sh scripts/bundle.sh >"$LOGS/gpui-build.log" 2>&1
  ) || { tail -20 "$LOGS/gpui-build.log"; say "FAILED to build"; exit 1; }
  app="$src/apps/desktop-gpui/build/$name.app"
  if notarize "$app"; then say "notarized"; else say "not notarized (signed)"; fi
  rm -rf "$FEED.new" && mkdir -p "$FEED.new"
  zip="Switch-$sha.zip"
  ditto -c -k --keepParent "$app" "$FEED.new/$zip"
  sum=$(shasum -a 256 "$FEED.new/$zip" | cut -c1-64)
  printf '{"version":"%s","hash":"%s","url":"%s","sha256":"%s"}\n' "$version" "$sha" "$zip" "$sum" > "$FEED.new/update.json"
  rm -rf "$FEED.old" && { [ ! -d "$FEED" ] || mv "$FEED" "$FEED.old"; } && mv "$FEED.new" "$FEED"
  feed
  say "$sha published at $url ($version)"
}

case ${1:-} in
  feed) feed ;;
  "") echo "usage: ship.sh <sha> | feed" >&2; exit 2 ;;
  *) ship "$1" ;;
esac
