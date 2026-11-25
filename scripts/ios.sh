#!/bin/sh
# Builds Switchboard for iPhone (apps/iphone) and puts it on the user's own iPhone, copied from
# Switchboard's scripts/ios.sh so the app ships as the next version of Switchboard's iPhone app:
# the same team, bundle id (dev.local.switchboard.phone.<team>), extensions, App Store Connect key.
#
#   sh scripts/ios.sh                  installs it on an iPhone paired with this Mac, signed for development
#   sh scripts/ios.sh --build-only     builds it and stops
#   sh scripts/ios.sh --testflight     uploads it to TestFlight (not before the cutover)
#
# Nothing about the user is in the repository. These come from the environment, else from a
# deploy.local (this repository's root, else ~/.switch/deploy.local):
#   SWITCHBOARD_IOS_TEAM / ios_team            the Apple Developer team id (else the keychain's)
#   SWITCHBOARD_IOS_BUNDLE_ID / ios_bundle_id  the app's bundle id
#   SWITCH_CORE / ios_core                     a core to pair with on first launch, ws://host:port (else the pair screen asks)
#   SWITCHBOARD_IOS_DEVICE                     which paired iPhone, when several
#   SWITCHBOARD_ASC_KEY_ID / ios_asc_key_id, SWITCHBOARD_ASC_ISSUER_ID / ios_asc_issuer_id
#                                              the App Store Connect key, for --testflight
set -eu
# One iOS build at a time on a Mac, each at background priority (it and all it starts), so a
# build never starves a core serving beside it: a second waits for the first.
if [ -z "${SWITCH_IOS_LOCKED:-}" ]; then
  lock=${SWITCH_DIR:-$HOME/.switch}/ios.lock
  mkdir -p "$(dirname "$lock")"
  SWITCH_IOS_LOCKED=1 exec /usr/bin/lockf -k "$lock" /usr/sbin/taskpolicy -b sh "$0" "$@"
fi
root=$(cd "$(dirname "$0")/.." && pwd)
project=$root/apps/iphone
build=$project/build

mode=install if_changed=
for arg in "$@"; do
  case $arg in
    --build-only) mode=build ;;
    --testflight) mode=testflight ;;
    --if-changed) if_changed=1 ;;
    *) echo "Unknown option $arg: say --testflight (with --if-changed or not) or --build-only, or nothing to install on a paired iPhone." >&2; exit 2 ;;
  esac
done

config=
for c in "$root/deploy.local" "$HOME/.switch/deploy.local"; do
  if [ -f "$c" ]; then config=$c; break; fi
done
ios_team='' ios_bundle_id='' ios_asc_key_id='' ios_asc_issuer_id='' ios_core=''
# shellcheck disable=SC1090
if [ -n "$config" ]; then . "$config"; fi
team=${SWITCHBOARD_IOS_TEAM:-$ios_team}
bundle_id=${SWITCHBOARD_IOS_BUNDLE_ID:-$ios_bundle_id}
key_id=${SWITCHBOARD_ASC_KEY_ID:-$ios_asc_key_id}
issuer=${SWITCHBOARD_ASC_ISSUER_ID:-$ios_asc_issuer_id}
core=${SWITCH_CORE:-$ios_core}
key=${SWITCHBOARD_ASC_KEY:-$HOME/.appstoreconnect/private_keys/AuthKey_$key_id.p8}

state="$HOME/Library/Application Support/Switchboard/testflight"
keys=$HOME/.appstoreconnect/private_keys
host=$(scutil --get LocalHostName 2>/dev/null | tr '[:upper:]' '[:lower:]' || hostname -s)
entity= commit= short= tree= build_number= version= delivery= uploaded=

tell() { :; }

# Ends the run with what keeps this Mac from building or uploading the app.
# Asked to upload only if it can (--if-changed, as every update asks), a Mac
# that isn't the one that uploads (it never has, and holds no key to) says
# nothing, and no Mac does when TestFlight already has this ios/. On the one
# that uploads, an upload that's due and can't go is a failure in the brain,
# a surprise too, never a quiet skip: a deploy.local rewritten without the
# key's lines once skipped one that way, found only by reading the log.
cannot() {
  if [ -n "$if_changed" ]; then
    [ -f "$state/uploaded" ] || [ -f "$key" ] || ls "$keys"/AuthKey_*.p8 >/dev/null 2>&1 || exit 0
    tree=$(git -C "$root" rev-parse HEAD:apps/iphone)
    if [ "$(cat "$state/uploaded" 2>/dev/null)" = "$tree" ]; then
      echo "TestFlight already has this iPhone app, so nothing was due, but the next upload can't go until this is fixed: $1"
      exit 0
    fi
    commit=$(git -C "$root" rev-parse HEAD) short=$(git -C "$root" rev-parse --short HEAD)
    entity=${bundle_id:+testflight:$bundle_id}
    tell failed "The iPhone app ($short) can't go to TestFlight from $host, so the phone keeps the build before it: $1"
  fi
  echo "$1" >&2
  exit 1
}

if ! command -v xcodebuild >/dev/null || ! xcodebuild -version >/dev/null 2>&1; then
  cannot "The iPhone app needs Xcode, and xcodebuild doesn't run here: install Xcode from the App Store, or point xcode-select at it (sudo xcode-select -s /Applications/Xcode.app)."
fi
if [ -z "$team" ]; then
  # A certificate's team is its subject's OU: Apple Development's, else
  # another Apple certificate's here (a Mac that only uploads to TestFlight
  # may have no development certificate before its first build).
  teams=
  for kind in "Apple Development" "Apple Distribution" "Developer ID Application"; do
    teams=$(security find-certificate -a -c "$kind" -p 2>/dev/null |
      awk '/BEGIN CERT/{c=""} {c=c $0 "\n"} /END CERT/{print c | "openssl x509 -noout -subject"; close("openssl x509 -noout -subject")}' |
      sed -n 's/.*OU *= *\([A-Z0-9]*\).*/\1/p' | sort -u)
    [ -n "$teams" ] && break
  done
  case $(printf '%s' "$teams" | grep -c .) in
    0) cannot "No Apple Development certificate in this keychain: sign in to your Apple Developer account in Xcode → Settings → Accounts (or put ios_team in deploy.local), then run this again." ;;
    1) team=$teams ;;
    *)
      [ -t 0 ] || cannot "Several Apple Developer teams have a certificate here ($(echo $teams)): say which in deploy.local (ios_team)."
      printf 'Apple Developer teams with a certificate here:\n%s\nWhich one signs the app? ' "$teams"
      read -r team
      ;;
  esac
fi
bundle_id=${bundle_id:-dev.local.switchboard.phone.$(printf %s "$team" | tr '[:upper:]' '[:lower:]')}

# Signing never makes or revokes a certificate. With -allowProvisioningUpdates and no usable
# Apple Development identity here (none, expired, or its private key elsewhere), Xcode mints a
# new one in the account, and revokes an old one at Apple's limit: account changes only the user
# approves. So a build goes only with the team's valid identity already in this Mac's keychains.
# Certificates, keys and profiles are made or revoked by the user alone, never by this script or
# an agent working around it (the App Store Connect API included).
development_identity() {
  valid=$(security find-identity -v -p codesigning 2>/dev/null |
    sed -n 's/^ *[0-9]*) \([0-9A-F]\{40\}\) "Apple Development:.*/\1/p')
  certs=$(security find-certificate -a -Z -p -c "Apple Development" 2>/dev/null || true)
  for hash in $valid; do
    ou=$(printf '%s\n' "$certs" |
      awk -v h="$hash" '/^SHA-1 hash:/ {on = ($3 == h)} on && /BEGIN CERT/ {p = 1} p {print} /END CERT/ {p = 0}' |
      openssl x509 -noout -subject 2>/dev/null | sed -n 's/.*OU *= *\([A-Z0-9]*\).*/\1/p')
    if [ "$ou" = "$team" ]; then return 0; fi
  done
  return 1
}
development_identity ||
  cannot "No valid Apple Development identity for team $team in this Mac's keychains (with its private key), and a build never makes one: ask the user to make or import one (Xcode → Settings → Accounts → Manage Certificates), then run this again."

if [ "$mode" = testflight ]; then
  unsaid=
  [ -n "$key_id" ] || unsaid=ios_asc_key_id
  [ -n "$issuer" ] || unsaid="${unsaid:+$unsaid and }ios_asc_issuer_id"
  held=$(ls "$keys" 2>/dev/null | sed -n 's/^AuthKey_\(.*\)\.p8$/\1/p' | paste -sd ' ' -)
  if [ -n "$unsaid" ] && [ -n "$held" ]; then
    cannot "deploy.local ($config) has no $unsaid, which name the App Store Connect key to upload with: put them back (the key here is $held, in $keys; its issuer ID is on App Store Connect → Users and Access → Integrations)."
  elif [ -n "$unsaid" ]; then
    cannot "No App Store Connect API key here to upload with: make one with Admin access (App Store Connect → Users and Access → Integrations), keep its .p8 at $keys/AuthKey_<key id>.p8 (chmod 600), and put ios_asc_key_id and ios_asc_issuer_id in deploy.local."
  elif [ ! -f "$key" ]; then
    other=
    [ -z "$held" ] || other=", or name the key that is here ($held)"
    cannot "deploy.local ($config) names App Store Connect key $key_id, but its .p8 isn't at $key: put it there (chmod 600)$other."
  fi
fi

# Uploads the commit checked out to TestFlight. A function, so it's read
# whole before it runs: an update can rewrite this file while it builds.
testflight() {
  logs=$HOME/Library/Logs/switch
  mkdir -p "$state" "$logs"
  log=$logs/testflight-xcodebuild.log
  commit=$(git -C "$root" rev-parse HEAD)
  short=$(git -C "$root" rev-parse --short HEAD)
  # The app itself, as its content (ios/'s tree), what's on TestFlight once
  # uploaded: a squash merge has the same tree as the branch uploaded from.
  tree=$(git -C "$root" rev-parse HEAD:apps/iphone)
  changed=$(git -C "$root" log -1 --format=%h HEAD -- apps/iphone)
  entity=testflight:$bundle_id

  # One upload at a time; a lock whose holder has gone is let go.
  lock=$state/lock
  waiting=
  until mkdir "$lock" 2>/dev/null; do
    holder=$(cat "$lock/pid" 2>/dev/null || true)
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then rm -rf "$lock"; continue; fi
    [ -n "$waiting" ] || echo "Another upload to TestFlight is under way; $short waits for it."
    waiting=1
    sleep 30
  done
  echo $$ > "$lock/pid"
  work=$(mktemp -d "${TMPDIR:-/tmp}/switchboard-testflight.XXXXXX")
  build_number= version= delivery= uploaded=
  # Once it's uploaded, nothing after (Apple's processing) is a failed upload.
  trap 'code=$?; [ $code -eq 0 ] || [ -n "$uploaded" ] || failed; rm -rf "$work" "$lock"; exit $code' EXIT
  trap 'exit 130' INT TERM

  if [ -n "$if_changed" ] && [ "$(cat "$state/uploaded" 2>/dev/null)" = "$tree" ]; then
    echo "TestFlight already has the iPhone app as of $changed."
    exit 0
  fi

  # What's committed, not the checkout itself, which an update may move.
  git -C "$root" archive --format=tar HEAD apps/iphone | tar -x -C "$work"
  (cd "$work/apps/iphone" && xcodegen -q)
  build_number=$(( $(date +%s) / 60 ))
  echo "Building $short for TestFlight as build $build_number (team $team, $bundle_id). Xcode's log: $log"
  : > "$log"
  tell building "Building the iPhone app ($short) for TestFlight as build $build_number on $host."
  # Only with room (scripts/room.sh): its build folder takes a few GB.
  # Xcode's IPA export copies with the rsync first on PATH and passes it
  # Apple's openrsync flags: Homebrew's rsync 3.x refuses them ("Copy failed").
  xcb() {
    PATH="/usr/bin:$PATH" xcodebuild "$@" -allowProvisioningUpdates -skipPackagePluginValidation -skipMacroValidation \
      -authenticationKeyPath "$key" -authenticationKeyID "$key_id" -authenticationKeyIssuerID "$issuer" >> "$log" 2>&1 ||
      { grep -E 'error:|ERROR|failed' "$log" | tail -12 >&2; return 1; }
  }
  xcb -project "$work/apps/iphone/Switchboard.xcodeproj" -scheme Switchboard -configuration Release \
    -destination 'generic/platform=iOS' -derivedDataPath "$work/derived" -archivePath "$work/Switchboard.xcarchive" \
    DEVELOPMENT_TEAM="$team" APP_BUNDLE_ID="$bundle_id" SWITCH_CORE="$core" CURRENT_PROJECT_VERSION="$build_number" archive
  # Its symbols, kept here for the newest five builds: the app's crash reports
  # (Crashes.swift) name its own frames by address, read with these.
  mkdir -p "$state/dsyms" && rm -rf "$state/dsyms/$build_number" && cp -R "$work/Switchboard.xcarchive/dSYMs" "$state/dsyms/$build_number"
  ls -1 "$state/dsyms" | sort -rn | tail -n +6 | while read -r old; do rm -rf "$state/dsyms/$old"; done
  # Internal testing only: such a build can't go to the App Store or outside testers.
  cat > "$work/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>app-store-connect</string>
<key>destination</key><string>export</string>
<key>signingStyle</key><string>automatic</string>
<key>teamID</key><string>$team</string>
<key>manageAppVersionAndBuildNumber</key><false/>
<key>testFlightInternalTestingOnly</key><true/>
<key>uploadSymbols</key><true/>
</dict></plist>
PLIST
  echo "Signing it for distribution"
  xcb -exportArchive -archivePath "$work/Switchboard.xcarchive" -exportPath "$work/export" -exportOptionsPlist "$work/export.plist"
  ipa=$(ls "$work"/export/*.ipa)

  # Notifications reach a TestFlight build only through APNs' production
  # service, which its signature has to say.
  mkdir "$work/ipa" && (cd "$work/ipa" && unzip -q "$ipa")
  app=$(ls -d "$work"/ipa/Payload/*.app)
  aps=$(codesign -d --entitlements - --xml "$app" 2>/dev/null | plutil -extract aps-environment raw -o - - 2>/dev/null || true)
  if [ "$aps" != production ]; then
    echo "The signed app's push entitlement is ${aps:-missing}, not production, so its notifications would never arrive: not uploading it." >&2
    exit 1
  fi
  version=$(plutil -extract CFBundleShortVersionString raw -o - "$app/Info.plist")

  echo "Uploading build $build_number ($version) to App Store Connect"
  xcrun altool --upload-app -f "$ipa" -t ios --apiKey "$key_id" --apiIssuer "$issuer" --p8-file-path "$key" >> "$log" 2>&1 ||
    { grep -iE 'error|fail' "$log" | tail -12 >&2; exit 1; }
  uploaded=1
  echo "$tree" > "$state/uploaded"
  delivery=$(sed -n 's/^Delivery UUID: *//p' "$log" | tail -1)
  tell uploaded "Build $build_number of the iPhone app ($short) is uploaded to TestFlight from $host. Once Apple has processed it (a few minutes), TestFlight offers it on the iPhone, and installs it there with Automatic Updates on."
  echo "Done: build $build_number is on its way to TestFlight. Once Apple has processed it, TestFlight installs it on the iPhone."
  # Its build folder goes now; the lock stays until Apple has processed
  # it, so what testflight:<bundle id> says stays this build's.
  rm -rf "$work"
  processing
}

# Waits for Apple to process the build just uploaded (by its delivery id),
# half an hour at most, and records what it found: processed (TestFlight
# offers it now) or invalid (it never will, a surprise). Never fails: the
# upload itself went.
processing() {
  if [ -z "$delivery" ]; then
    echo "altool gave no delivery id for build $build_number, so its processing can't be followed."
    return 0
  fi
  echo "Waiting for Apple to process build $build_number (delivery $delivery)"
  waited=0 status=
  while [ "$waited" -lt 1800 ]; do
    sleep 30
    waited=$((waited + 30))
    status=$(xcrun altool --build-status --delivery-id "$delivery" --apiKey "$key_id" --apiIssuer "$issuer" --p8-file-path "$key" --output-format json 2> /dev/null |
      sed -n '/^{/,$p' | plutil -extract build-status raw -o - - 2> /dev/null || true)
    case $status in
      VALID)
        tell processed "Apple has processed build $build_number of the iPhone app ($short): TestFlight offers it on the iPhone now, and installs it there with Automatic Updates on."
        echo "Apple has processed build $build_number; TestFlight offers it now."
        return 0
        ;;
      INVALID | FAILED)
        tell invalid "Apple found build $build_number of the iPhone app ($short) invalid while processing it ($status), so TestFlight won't offer it and the phone keeps the build before it. App Store Connect's email to the account says why."
        echo "Apple found build $build_number invalid ($status)." >&2
        return 0
        ;;
    esac
  done
  echo "Apple hadn't finished processing build $build_number after half an hour (it last said ${status:-nothing}); App Store Connect shows where it stands."
}

failed() {
  errors=$(grep -E 'error:|ERROR|failed' "$log" 2>/dev/null | tail -8 || true)
  [ -n "$errors" ] || errors="none there: the output of scripts/ios.sh --testflight says what went wrong"
  at=$short
  [ -z "$build_number" ] || at="$short (build $build_number)"
  tell failed "The iPhone app's upload to TestFlight from $host failed at $at, so the phone keeps the build before it. Errors in Xcode's log ($log):
$errors"
}

if [ "$mode" = testflight ]; then testflight; exit; fi

echo "Building the iPhone app for team $team as $bundle_id"
[ -n "$core" ] || echo "No core given (SWITCH_CORE or ios_core): the app asks for one when it opens." >&2
(cd "$project" && xcodegen -q)
xcodebuild -project "$project/Switchboard.xcodeproj" -scheme Switchboard -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath "$build" -allowProvisioningUpdates -skipPackagePluginValidation -skipMacroValidation \
  -clonedSourcePackagesDirPath "$HOME/Library/Caches/Switch/xcode/SourcePackages" \
  DEVELOPMENT_TEAM="$team" APP_BUNDLE_ID="$bundle_id" SWITCH_CORE="$core" build -quiet
app=$build/Build/Products/Release-iphoneos/Switchboard.app

# Its symbols, kept on the Mac that built it for the newest ten builds, named by commit and the
# app image's UUID: a crash report from the phone (Crashes.swift) names that UUID (`binary`) and
# its own frames by offset, read with these.
dsym=$app.dSYM
if [ -d "$dsym" ]; then
  dsyms="$HOME/Library/Application Support/Switchboard/iphone-dsyms"
  uuid=$(dwarfdump --uuid "$dsym" 2>/dev/null | awk '/^UUID:/ {print $2; exit}')
  name=$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo unknown)-$(printf %s "$uuid" | cut -c1-8)
  mkdir -p "$dsyms" && rm -rf "$dsyms/$name.dSYM" && cp -R "$dsym" "$dsyms/$name.dSYM" && touch "$dsyms/$name.dSYM"
  ls -1t "$dsyms" | tail -n +11 | while read -r old; do rm -rf "${dsyms:?}/$old"; done
  echo "Symbols: $dsyms/$name.dSYM (binary $uuid)"
else
  echo "No dSYM at $dsym, so this build's crashes can't be symbolicated." >&2
fi

if [ "$mode" = build ]; then
  echo "Built $app"
  exit 0
fi

# The paired iPhones devicectl can reach, as "identifier<TAB>name".
phones=$(xcrun devicectl list devices --json-output /dev/stdout 2>/dev/null | /usr/bin/python3 -c '
import json, sys
text = sys.stdin.read()
devices = json.loads(text[text.index("{"):])["result"]["devices"]
for d in devices:
    hw, props = d.get("hardwareProperties", {}), d.get("deviceProperties", {})
    if hw.get("platform") == "iOS" and hw.get("deviceType") == "iPhone" and d.get("connectionProperties", {}).get("pairingState") == "paired":
        print(d["identifier"] + "\t" + props.get("name", ""))
')
if [ -n "${SWITCHBOARD_IOS_DEVICE:-}" ]; then
  phones=$(printf '%s\n' "$phones" | grep -F "$SWITCHBOARD_IOS_DEVICE" || true)
fi
case $(printf '%s' "$phones" | grep -c .) in
  0) echo "No paired iPhone: connect it to this Mac once with a cable, trust this Mac on it, turn on Developer Mode (Settings → Privacy & Security), and run this again. Or skip the cable: sh scripts/ios.sh --testflight." >&2; exit 1 ;;
  1) ;;
  *) printf 'Several iPhones are paired:\n%s\nSay which with SWITCHBOARD_IOS_DEVICE.\n' "$phones" >&2; exit 1 ;;
esac
device=$(printf %s "$phones" | cut -f1)
echo "Installing on $(printf %s "$phones" | cut -f2)"
xcrun devicectl device install app --device "$device" "$app" >/dev/null
# Opening it needs the phone unlocked; it's installed either way.
xcrun devicectl device process launch --device "$device" "$bundle_id" >/dev/null 2>&1 || echo "Installed. Unlock the iPhone and open Switchboard."
echo "Done: Switchboard is on the iPhone."
