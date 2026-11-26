#!/bin/sh
# A release for a Mac of its own, run on the core machine: Switch.app with the core inside it
# (src/platform/standalone.rs), signed with the deploy's Developer ID, notarized and stapled, as a
# disk image to hand someone, and as an update for the copies already out there:
#
#   <out>/Switch.dmg                    the installer
#   <out>/Switch-<version>.zip          the app, as ditto packs it, which the updater takes
#   <out>/update.json                   {"version","hash","url","sha256","sig"}, signed with the
#                                       feed's Ed25519 key (src/platform/update.rs checks it)
#
# The app reads updates from the feed `releasesFeed` names, a folder whose update.json is the
# newest (GitHub Releases' https://github.com/<owner>/<repo>/releases/latest/download). With
# `releasesRepo` set, the commit goes out first (scripts/publish.sh, unless it's out already) and
# the three are published there as the latest release, v<version>, tagged on it; without it they
# stay in <out>. The deploy's own Macs never read this feed: their app is the ship's (ship.sh app).
#
#   release.sh <version> [sha] [out]    e.g. release.sh 0.1.0 (sha: main)
#
# Who this install is, in ~/.switch/deploy.json, never here: identity, keychain, notary* (as the
# ship's), and for releases: releasesFeed, releasesRepo, releaseAppId (default ax.switch.desktop),
# releaseHostId (default ax.switch.host), updateKey (the Ed25519 private key, PEM),
# extensionsRepo (owner/repo) and extensionsHide (what Setup offers from its extensions/).
set -eu
{
S=$HOME/.switch
LOGS=$HOME/Library/Logs/switch
conf() { plutil -extract "$1" raw -o - "$S/deploy.json" 2>/dev/null || true; }
expand() { case $1 in "~/"*) echo "$HOME/${1#\~/}" ;; *) echo "$1" ;; esac; }
IDENTITY=$(conf identity)
SIGNING_KEYCHAIN=$(expand "$(conf keychain)")
KEYCHAIN_PASS=$(expand "$(conf keychainPassFile)")
NOTARY_KEY=$(expand "$(conf notaryKey)")
NOTARY_KEY_ID=$(conf notaryKeyId)
NOTARY_ISSUER=$(conf notaryIssuer)
FEED=${SWITCH_RELEASES_FEED:-$(conf releasesFeed)}
REPO=${SWITCH_RELEASES_REPO-$(conf releasesRepo)}
APP_ID=$(conf releaseAppId)
APP_ID=${APP_ID:-ax.switch.desktop}
HOST_ID=$(conf releaseHostId)
HOST_ID=${HOST_ID:-ax.switch.host}
UPDATE_KEY=$(expand "$(conf updateKey)")
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p "$LOGS"
say() { echo "[release $(date +%H:%M:%S)] $*"; }
behind() { /usr/sbin/taskpolicy -c utility "$@"; }

version=${1:?usage: release.sh <version> [sha] [out]}
echo "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { say "FAILED: a version is like 0.1.0"; exit 1; }
sha=$(git -C "$S/repo.git" rev-parse "${2:-main}^{commit}")
out=${3:-$S/release-out}
NAME=Switch
if [ -n "$REPO" ] && gh release view "v$version" --repo "$REPO" >/dev/null 2>&1; then say "FAILED: v$version is out already"; exit 1; fi
[ -n "$IDENTITY" ] || { say "FAILED: ~/.switch/deploy.json needs identity"; exit 1; }
[ -n "$FEED" ] || { say "FAILED: ~/.switch/deploy.json needs releasesFeed"; exit 1; }
[ -f "$UPDATE_KEY" ] || { say "FAILED: ~/.switch/deploy.json needs updateKey, a PEM file"; exit 1; }
[ -z "$SIGNING_KEYCHAIN" ] || security unlock-keychain -p "$(cat "$KEYCHAIN_PASS")" "$SIGNING_KEYCHAIN"

src=$S/release-src
[ -d "$src" ] || git -C "$S/repo.git" worktree add -q --detach "$src" "$sha"
git -C "$src" checkout -q --detach --force "$sha"
git -C "$src" clean -qfd
cd "$src"
behind bun install --frozen-lockfile --os=darwin --cpu=arm64 >/dev/null

# The core: built and bundled as the ship builds it, under the release's own id.
core=$(mktemp -d)/core
mkdir -p "$core"
say "building the core at $sha"
behind bun scripts/build-core.ts "$core" >"$LOGS/release-core.log" 2>&1
SWITCH_HOST_ID=$HOST_ID behind sh scripts/ship.sh bundle "$core" >>"$LOGS/release-core.log" 2>&1 || { tail -5 "$LOGS/release-core.log"; say "FAILED to sign the core"; exit 1; }

# The Ed25519 public key, raw, base64, baked into the app.
pub=$(bun -e '
const k = require("node:crypto").createPublicKey(require("node:fs").readFileSync(process.argv[1]))
process.stdout.write(Buffer.from(k.export({ format: "jwk" }).x, "base64url").toString("base64"))
' "$UPDATE_KEY")

say "building the app $version"
(
  cd apps/desktop-gpui
  CARGO_TARGET_DIR=$S/gpui-target SWITCH_APP_NAME=$NAME SWITCH_APP_ID=$APP_ID SWITCH_APP_VERSION=$version \
    SWITCH_BUILD_HASH=$sha SWITCH_GPUI_UPDATES=$FEED SWITCH_APP_SCHEME=switchboard SWITCH_SIGN_IDENTITY=$IDENTITY \
    SWITCH_CORE_APP="$core/Switch Host.app" SWITCH_UPDATE_KEY=$pub \
    SWITCH_EXTENSIONS_REPO=$(conf extensionsRepo) SWITCH_EXTENSIONS_HIDE=$(conf extensionsHide) \
    behind sh scripts/bundle.sh >"$LOGS/release-app.log" 2>&1
) || { tail -20 "$LOGS/release-app.log"; say "FAILED to build the app"; exit 1; }
app=$src/apps/desktop-gpui/build/$NAME.app
rm -rf "$(dirname "$core")"

notarize() {
  [ -n "$NOTARY_KEY_ID" ] || return 1
  xcrun notarytool submit "$1" --key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER" --wait --timeout 30m | tee -a "$LOGS/release-notary.log" | grep -q 'status: Accepted'
}

rm -rf "$out" && mkdir -p "$out"
ditto -c -k --keepParent "$app" "$out/notarize.zip"
notarize "$out/notarize.zip" || { say "FAILED: the app wasn't notarized ($LOGS/release-notary.log)"; exit 1; }
rm -f "$out/notarize.zip"
xcrun stapler staple "$app" >/dev/null
say "app notarized"

# The disk image: the app beside a link to Applications, signed, notarized, stapled.
stage=$(mktemp -d)
ditto "$app" "$stage/$NAME.app"
ln -s /Applications "$stage/Applications"
hdiutil create -quiet -volname "$NAME" -srcfolder "$stage" -ov -format UDZO "$out/$NAME.dmg"
rm -rf "$stage"
codesign --force --timestamp --sign "$IDENTITY" "$out/$NAME.dmg"
notarize "$out/$NAME.dmg" || { say "FAILED: the disk image wasn't notarized"; exit 1; }
xcrun stapler staple "$out/$NAME.dmg" >/dev/null
say "disk image notarized"

# The update: the stapled app zipped, named and signed.
zip=$NAME-$version.zip
ditto -c -k --keepParent "$app" "$out/$zip"
sum=$(shasum -a 256 "$out/$zip" | cut -c1-64)
url=$FEED/$zip
[ -z "$REPO" ] || url=https://github.com/$REPO/releases/download/v$version/$zip
bun -e '
const [key, version, hash, url, sha256, to] = process.argv.slice(1)
const crypto = require("node:crypto")
const signed = `switch-update\n${version}\n${hash}\n${url}\n${sha256}`
const sig = crypto.sign(null, Buffer.from(signed), crypto.createPrivateKey(require("node:fs").readFileSync(key))).toString("base64")
require("node:fs").writeFileSync(to, JSON.stringify({ version, hash, url, sha256, sig }) + "\n")
' "$UPDATE_KEY" "$version" "$sha" "$url" "$sum" "$out/update.json"
say "$version built at $out"

if [ -n "$REPO" ]; then
  public=https://github.com/$REPO.git
  git -C "$src" fetch -q "$public" main
  target=$(git -C "$src" log FETCH_HEAD --grep "^Source: $sha\$" --format=%H -1)
  [ -n "$target" ] || target=$(SWITCH_PUBLIC=$public sh "$src/scripts/publish.sh" "$sha")
  gh release create "v$version" --repo "$REPO" --target "$target" --latest --title "Switch $version" \
    --notes "Open $NAME.dmg and drag Switch to Applications. macOS 14 or later, Apple silicon." \
    "$out/$NAME.dmg" "$out/$zip" "$out/update.json" >/dev/null
  say "published: https://github.com/$REPO/releases/tag/v$version"
fi
exit 0
}
