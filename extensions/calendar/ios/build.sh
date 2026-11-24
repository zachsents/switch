#!/bin/sh
# Builds Calendar for iPhone (this folder, made by XcodeGen) and puts it on the user's iPhone, as
# Switch's scripts/ios.sh does for Switchboard.
#
#   sh ios/build.sh                 installs it on an iPhone paired with this Mac, signed for development
#   sh ios/build.sh --build-only    builds it for a device and stops
#   sh ios/build.sh --simulator     builds it for the simulator, unsigned, and says where the app is
#
# Nothing about the user is in the repository. These come from the environment, else from a
# deploy.local (this repository's root, else ~/.switch/deploy.local):
#   SWITCH_IOS_TEAM / ios_team                     the Apple Developer team id (else the keychain's)
#   SWITCH_IOS_BUNDLE_PREFIX / ios_bundle_prefix   bundle ids' prefix (else dev.local.switch.<team>)
#   SWITCH_CORE / ios_core                         the core, ws://host:port (else ~/.switch/config.json's core)
#   SWITCH_IOS_DEVICE                              which paired iPhone, when several
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
build=$here/build
name=Calendar
suffix=calendar

mode=install
for arg in "$@"; do
  case $arg in
    --build-only) mode=build ;;
    --simulator) mode=simulator ;;
    *) echo "Unknown option $arg: say --build-only, --simulator, or nothing to install on a paired iPhone." >&2; exit 2 ;;
  esac
done

config=
for c in "$root/deploy.local" "$HOME/.switch/deploy.local"; do
  if [ -f "$c" ]; then config=$c; break; fi
done
ios_team='' ios_bundle_prefix='' ios_core=''
# shellcheck disable=SC1090
if [ -n "$config" ]; then . "$config"; fi
team=${SWITCH_IOS_TEAM:-$ios_team}
prefix=${SWITCH_IOS_BUNDLE_PREFIX:-$ios_bundle_prefix}
core=${SWITCH_CORE:-$ios_core}
if [ -z "$core" ] && [ -f "$HOME/.switch/config.json" ]; then
  core=$(/usr/bin/plutil -extract core raw -o - "$HOME/.switch/config.json" 2>/dev/null | sed 's|^http|ws|' || true)
fi
[ -n "$core" ] || echo "No core given (SWITCH_CORE or ios_core): the app will say so until one is set." >&2

command -v xcodegen >/dev/null || { echo "Needs XcodeGen: brew install xcodegen" >&2; exit 1; }
(cd "$here" && xcodegen -q)

if [ "$mode" = simulator ]; then
  xcodebuild -project "$here/$name.xcodeproj" -scheme "$name" -configuration Debug \
    -destination 'generic/platform=iOS Simulator' -derivedDataPath "$build" \
    CODE_SIGNING_ALLOWED=NO SWITCH_CORE="$core" APP_BUNDLE_ID="${prefix:-dev.local.switch}.$suffix" build -quiet
  echo "$build/Build/Products/Debug-iphonesimulator/$name.app"
  exit 0
fi

if [ -z "$team" ]; then
  teams=$(security find-certificate -a -c "Apple Development" -p 2>/dev/null |
    awk '/BEGIN CERT/{c=""} {c=c $0 "\n"} /END CERT/{print c | "openssl x509 -noout -subject"; close("openssl x509 -noout -subject")}' |
    sed -n 's/.*OU *= *\([A-Z0-9]*\).*/\1/p' | sort -u)
  case $(printf '%s' "$teams" | grep -c .) in
    0) echo "No Apple Development certificate in this keychain: sign in to your Apple Developer account in Xcode → Settings → Accounts (or put ios_team in deploy.local)." >&2; exit 1 ;;
    1) team=$teams ;;
    *) echo "Several Apple Developer teams have a certificate here: say which in deploy.local (ios_team)." >&2; exit 1 ;;
  esac
fi
prefix=${prefix:-dev.local.switch.$(printf %s "$team" | tr '[:upper:]' '[:lower:]')}
bundle_id=$prefix.$suffix

echo "Building $name for team $team as $bundle_id"
xcodebuild -project "$here/$name.xcodeproj" -scheme "$name" -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath "$build" -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$team" APP_BUNDLE_ID="$bundle_id" SWITCH_CORE="$core" build -quiet
app=$build/Build/Products/Release-iphoneos/$name.app

if [ "$mode" = build ]; then
  echo "Built $app"
  exit 0
fi

phones=$(xcrun devicectl list devices --json-output /dev/stdout 2>/dev/null | /usr/bin/python3 -I -c '
import json, sys
text = sys.stdin.read()
devices = json.loads(text[text.index("{"):])["result"]["devices"]
for d in devices:
    hw, props = d.get("hardwareProperties", {}), d.get("deviceProperties", {})
    if hw.get("platform") == "iOS" and hw.get("deviceType") == "iPhone" and d.get("connectionProperties", {}).get("pairingState") == "paired":
        print(d["identifier"] + "\t" + props.get("name", ""))
')
if [ -n "${SWITCH_IOS_DEVICE:-}" ]; then
  phones=$(printf '%s\n' "$phones" | grep -F "$SWITCH_IOS_DEVICE" || true)
fi
case $(printf '%s' "$phones" | grep -c .) in
  0) echo "No paired iPhone: connect it to this Mac once with a cable, trust this Mac on it, and turn on Developer Mode." >&2; exit 1 ;;
  1) ;;
  *) printf 'Several iPhones are paired:\n%s\nSay which with SWITCH_IOS_DEVICE.\n' "$phones" >&2; exit 1 ;;
esac
device=$(printf %s "$phones" | cut -f1)
echo "Installing on $(printf %s "$phones" | cut -f2)"
xcrun devicectl device install app --device "$device" "$app" >/dev/null
xcrun devicectl device process launch --device "$device" "$bundle_id" >/dev/null 2>&1 || echo "Installed. Unlock the iPhone and open $name."
echo "Done: $name is on the iPhone."
