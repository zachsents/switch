#!/bin/sh
# The loop on the server (CONCEPTS: Loop), run by scripts/deploy.sh in ~/.switch/src at <sha>:
# checks, compile, sign, canary, running turns let finish or paused once the pressure builds, swap,
# then a watch that rolls back.
# Apart from Switchboard: its own folder (~/.switch), port (4871), units (ax.switch.*) and logs
# (~/Library/Logs/switch).
#   ship.sh <sha>                    the loop; the release's own copy keeps watching after it
#   ship.sh watch <sha> <prev>       N minutes of health after a swap, then it's proven
#   ship.sh rollback <sha> <prev>    puts <prev> back if <sha> is still live
#   ship.sh swap <sha> <label> [pause]  under brain.lock: turns paused, core stopped, brain backed
#                                    up, <sha> live
#   ship.sh settle                   under landings.lock: the landings the live release has dropped
#   ship.sh tidy                     after a deploy: backups compacted, old ones and old releases gone
#   ship.sh app <sha>                the desktop app (apps/desktop-gpui), in its own lane
#   ship.sh app-electrobun <sha>     the old Electrobun app (apps/desktop), for a rollback only
#   ship.sh bundle|notarize <release>  signs, or notarizes, a release's host bundle
# The brain has one writer: the core. Migrate (ax.switch.migrate) and the swap take brain.lock.
set -eu
S=$HOME/.switch
LOGS=$HOME/Library/Logs/switch
HOST_APP="/Applications/Switch Host.app"
CORE=ax.switch.core
DOMAIN=gui/$(id -u)
PORT=4871
WATCH_MIN=${SWITCH_WATCH_MIN:-5}
# Running turns hold a swap off while the pressure builds: each landing that isn't live yet adds a
# point a minute (one waits at most 10 min, two about 5, five about 2). At PRESSURE the turns are
# paused for the update, and the new core carries them on. Landings are ~/.switch/landings, one
# "<time> <sha>" a line, which scripts/deploy.sh adds as each reaches the server.
PRESSURE=${SWITCH_PRESSURE:-10}
# Who this install is lives in ~/.switch/deploy.json, never here (DEPLOY.md lists its keys).
conf() { plutil -extract "$1" raw -o - "$S/deploy.json" 2>/dev/null || true; }
expand() { case $1 in "~/"*) echo "$HOME/${1#\~/}" ;; *) echo "$1" ;; esac; }
SERVER=$(conf server)
IDENTITY=$(conf identity)
TEAM=$(conf team)
# The host bundle's id: the old client's host id keeps its macOS permissions (PERMISSIONS.md).
BUNDLE_ID=$(conf hostId)
APP_ID=$(conf appId)
SIGNING_KEYCHAIN=$(expand "$(conf keychain)")
TAILSCALE=/Applications/Tailscale.app/Contents/MacOS/Tailscale
FEED_PORT=8443
KEYCHAIN_PASS=$(expand "$(conf keychainPassFile)")
NOTARY_KEY=$(expand "$(conf notaryKey)")
NOTARY_KEY_ID=$(conf notaryKeyId)
NOTARY_ISSUER=$(conf notaryIssuer)
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SELF=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
mkdir -p "$S/releases" "$S/backups" "$LOGS"

say() { echo "[ship $(date +%H:%M:%S)] $*"; }
# The live core has the machine first: its job is Interactive, and the rest of a deploy gives way.
# The build and signing at utility QoS: below the core, yet on every core, since at background
# (efficiency cores, throttled I/O) a build took 2-10 min instead of 30-60 s and each landing was
# overtaken before its canary, so none went live. Notarization (mostly a wait on Apple) and the
# lanes after a deploy at background. Not the canary: it's timed, and throttled behind a copy it
# missed its 30 s and failed a good release. Children inherit either.
behind() { /usr/sbin/taskpolicy -c utility "$@"; }
now() { perl -MTime::HiRes=time -e 'printf "%.1f", time'; }
since() { perl -e "printf '%.1f', $(now) - $1"; }

# The core's unit. The gateway key comes from the login profile into the plist (0600), never a log.
core_unit() {
  key=$(zsh -lc 'printf %s "${AI_GATEWAY_API_KEY:-}"')
  plist=$HOME/Library/LaunchAgents/$CORE.plist
  umask 077
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$CORE</string>
<key>ProgramArguments</key><array><string>$HOST_APP/Contents/MacOS/switch</string></array>
<key>EnvironmentVariables</key><dict>
<key>PATH</key><string>$PATH</string>
<key>AI_GATEWAY_API_KEY</key><string>$key</string>
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ProcessType</key><string>Interactive</string>
<key>SoftResourceLimits</key><dict><key>NumberOfFiles</key><integer>16384</integer></dict>
<key>ExitTimeOut</key><integer>30</integer>
<key>StandardOutPath</key><string>$LOGS/core.log</string>
<key>StandardErrorPath</key><string>$LOGS/core.log</string>
</dict></plist>
PLIST
  umask 022
}

# Until launchd has let it go: past ExitTimeOut (30 s) it's killed. A start while it's still going
# finds the job loaded, starts nothing, and leaves no core once it's gone.
stop_core() {
  launchctl bootout "$DOMAIN/$CORE" 2>/dev/null || true
  for _ in $(seq 160); do
    launchctl print "$DOMAIN/$CORE" >/dev/null 2>&1 || return 0
    sleep 0.25
  done
}

# launchd sometimes refuses a bootstrap right after a bootout ("5: Input/output error"); a core
# that isn't running after a start is tried again rather than left down.
start_core() {
  launchctl enable "$DOMAIN/$CORE"
  for _ in 1 2 3 4 5; do
    launchctl bootstrap "$DOMAIN" "$HOME/Library/LaunchAgents/$CORE.plist" 2>/dev/null || true
    sleep 1
    [ -n "$(core_pid)" ] && return 0
    launchctl bootout "$DOMAIN/$CORE" 2>/dev/null || true
    sleep 2
  done
  say "core didn't start"
  return 1
}

core_pid() { launchctl print "$DOMAIN/$CORE" 2>/dev/null | sed -n 's/^[[:space:]]*pid = //p'; }

# Healthy within `tries` seconds.
healthy() {
  url=$1 tries=$2
  shift 2
  for _ in $(seq $((tries * 5))); do
    if bun "$S/current/health.ts" "$url" "$@" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  bun "$S/current/health.ts" "$url" "$@"
}

# Puts a release's host bundle live. Only with the core stopped: a process whose signed code
# changes under it is killed.
install_bundle() {
  rm -rf "$HOST_APP.new"
  ditto "$S/releases/$1/Switch Host.app" "$HOST_APP.new"
  rm -rf "$HOST_APP"
  mv "$HOST_APP.new" "$HOST_APP"
  ln -sfn "$S/releases/$1" "$S/current"
}

# This deploy's backups (the swap's and a rollback's), newest first by the time in their name (not
# mtime, which compacting changes). Others in the folder, a
# migration's say, are theirs to keep.
deploy_backups() {
  ls -1 "$S/backups" 2>/dev/null | sort -r | grep -E -- '-([0-9a-f]{40}|rollback-from-[0-9a-f]{40})\.db(\.zst)?$' || true
}

# After a deploy: every backup but the newest compressed; then the last 3 backups and each of the
# last 7 days' newest kept, the last 3 releases (and the live one and the previous, which a rollback
# needs), the update feed and the one before it. The newest backup stays an APFS clone: the canary
# copies it in an instant, and it costs only the pages the brain has changed since.
# A backup is the brain at rest, checkpointed (the swap's), so it's compressed as it is, straight
# from the file: no compacted copy beside it, and only its .zst is written. The .zst is tested
# before the clone goes.
tidy() {
  # What a run cut short left (a compacted copy, a .zst half written).
  rm -f "$S/backups"/.*.vacuum "$S/backups"/.*.vacuum-journal "$S/backups"/.*.zst.part
  newest=$(deploy_backups | head -1)
  deploy_backups | grep '\.db$' | grep -vx "$newest" | while read -r b; do
    src=$S/backups/$b part=$S/backups/.$b.zst.part
    # A WAL someone left beside it folded in first, so the file alone is the whole backup.
    if [ -s "$src-wal" ]; then
      sqlite3 -cmd ".timeout 10000" "$src" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null || continue
    fi
    if zstd -q -T0 -10 "$src" -o "$part" && zstd -q -t "$part" && mv "$part" "$src.zst"; then
      rm -f "$src" "$src-shm" "$src-wal"
    fi
    rm -f "$part"
  done
  days='' kept=0
  deploy_backups | while read -r b; do
    day=${b%%-*}
    keep=''
    [ "$kept" -lt 3 ] && keep=1
    if [ "$day" -ge "$(date -v-6d +%Y%m%d)" ] && ! echo "$days" | grep -q "$day"; then keep=1; days="$days $day"; fi
    kept=$((kept + 1))
    [ -n "$keep" ] || rm -f "$S/backups/$b" "$S/backups/$b-shm" "$S/backups/$b-wal"
  done
  live=$(basename "$(readlink "$S/current")")
  prev=$(cat "$S/previous" 2>/dev/null || true)
  ls -1t "$S/releases" | tail -n +4 | while read -r r; do
    [ "$r" = "$live" ] || [ "$r" = "$prev" ] || rm -rf "$S/releases/$r"
  done
  # The hosts' packed builds (about 100 MB a target) of a release that has been live, kept only for
  # the live one and the previous, which a rollback puts back; one never live may still be shipping.
  ls -1 "$S/releases" | while read -r r; do
    [ "$r" = "$live" ] || [ "$r" = "$prev" ] || [ ! -f "$S/releases/$r/stores-before" ] ||
      rm -f "$S/releases/$r"/host-*.zip "$S/releases/$r"/host-*.tar.gz "$S/releases/$r"/host-*.tar.gz.sha256
  done
  rm -rf "$S/canary" "$S/updates.new"
}

# The schema of every store the core keeps (the brain, the vault, the rest), one line each. A
# store that can't be read says so, which no build's record matches.
stores() {
  for db in "$S"/*.db "$S"/secrets/*.db; do
    [ -f "$db" ] || continue
    echo "${db#"$S"/} $(sqlite3 -readonly "$db" 'PRAGMA schema_version;' 2>/dev/null || echo unreadable)"
  done
}

# Live is <to>: core stopped, brain checkpointed and backed up (an APFS clone), bundle swapped.
# What the stores were before <to> first ran is kept with it: a rollback from <to> is safe only
# while they still are, since an older build may not read what <to> made of them. A deploy's swap
# (`pause`) first pauses the turns still running, which the new core carries on. The hosts on other
# machines that fetched <to> ahead swap it in in the same pause; any other takes it as it links to
# the new core, before it says anything to it (packages/core/src/release.ts).
swap() {
  to=$1 label=$2
  if [ "${3:-}" = pause ]; then
    paused=$(curl -sf -m 60 -X POST "http://127.0.0.1:$PORT/pause" || true)
    case $paused in
      '' | *[!0-9]*) say "$to swapping in; the live core can't pause turns" ;;
      *) say "$to swapping in; $paused turns paused" ;;
    esac
    # The hosts holding <to> already swap it in now, in the same pause.
    curl -sf -m 10 -X POST "http://127.0.0.1:$PORT/hosts/next?release=$to&now=1" >/dev/null || true
  fi
  stop_core
  # Whatever fails from here, a core is serving when the swap ends: <to>'s if it got that far,
  # else the one it replaced. The ship's health check then rolls back one that doesn't serve.
  trap '[ -n "$(core_pid)" ] || start_core' EXIT
  stores > "$S/releases/$to/stores-before"
  if [ -f "$S/brain.db" ]; then
    # Waits out another process's moment on the brain; without it, a busy checkpoint is silent
    # and the clone below misses what was still in the WAL.
    sqlite3 -cmd ".timeout 10000" "$S/brain.db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
    cp -c "$S/brain.db" "$S/backups/$(date +%Y%m%d-%H%M%S)-$label.db"
  fi
  install_bundle "$to"
  # The brain brought up to this build (schema, indexes, projections) before the core starts, so it
  # serves at once.
  "$HOST_APP/Contents/MacOS/switch" prepare >>"$LOGS/core.log" 2>&1 || say "$to: prepare failed; the core prepares as it starts"
  start_core
}

# Turns running, and those starting: a message of the user's the core hasn't read yet (its turn
# starts before the read lands), in the last few minutes so one it never read can't hold a deploy.
running_turns() {
  sqlite3 -readonly "$S/brain.db" "SELECT (SELECT count(*) FROM threads WHERE status = 'running')
    + (SELECT count(*) FROM messages WHERE source != 'agent' AND title IS NULL
       AND time > (strftime('%s', 'now') - 300) * 1000);" 2>/dev/null || echo 0
}

# Minutes each landing the live release doesn't have yet has waited, summed: the pressure. A
# landing's first record counts (the workstation's and the server's deploys both add it).
pressure() {
  live=$(basename "$(readlink "$S/current" 2>/dev/null || echo none)")
  at=$(date +%s)
  sort -k2,2 -k1,1n "$S/landings" 2>/dev/null | awk '!seen[$2]++' | while read -r landed landing; do
    if ! git -C "$S/repo.git" merge-base --is-ancestor "$landing" "$live" 2>/dev/null; then
      echo $(((at - landed) / 60))
    fi
  done | awk '{ p += $1 } END { print p + 0 }'
}

# The landings the live release has, and any repo.git doesn't know, dropped.
settle() {
  live=$(basename "$(readlink "$S/current" 2>/dev/null || echo none)")
  [ -f "$S/landings" ] || return 0
  while read -r landed landing; do
    git -C "$S/repo.git" cat-file -e "$landing^{commit}" 2>/dev/null || continue
    git -C "$S/repo.git" merge-base --is-ancestor "$landing" "$live" 2>/dev/null || echo "$landed $landing"
  done < "$S/landings" > "$S/landings.new"
  mv "$S/landings.new" "$S/landings"
}

# The swap restarts the core, which cuts off every turn: it waits for them to end while the pressure
# builds, then the swap pauses them. Whatever landed by then ships in that one pause: this release
# makes way for the newest, once a round (~/.switch/tripped names it). That one ships even if more
# land while it builds; they wait for the next round.
wait_for_turns() {
  sha=$1
  # A landing deploy.sh didn't record (shipped by hand): it counts from now.
  grep -qs " $sha\$" "$S/landings" || lockf -k "$S/landings.lock" sh -c "echo \"\$(date +%s) $sha\" >> '$S/landings'"
  said=''
  while [ "$(running_turns)" -gt 0 ]; do
    p=$(pressure)
    if [ "$p" -ge "$PRESSURE" ]; then
      newest=$(git -C "$S/repo.git" rev-parse main 2>/dev/null || echo "$sha")
      if [ "$newest" != "$sha" ] && [ ! -s "$S/tripped" ]; then
        say "pressure $p/$PRESSURE: $sha makes way for $newest, which ships in this pause"
        echo "$newest" > "$S/tripped"
        rm -rf "$S/releases/$sha"
        exit 0
      fi
      say "pressure $p/$PRESSURE: pausing $(running_turns) turns"
      return 0
    fi
    [ "$said" = "$p" ] || { say "waiting for $(running_turns) turns, pressure $p/$PRESSURE"; said=$p; }
    sleep 5
  done
}

rollback() {
  sha=$1 prev=$2
  [ "$(basename "$(readlink "$S/current")")" = "$sha" ] || { say "$sha isn't live; nothing to roll back"; return 0; }
  if [ -z "$prev" ] || [ ! -d "$S/releases/$prev" ]; then
    say "ROLLBACK impossible: no release before $sha"
    return 1
  fi
  # Fails closed: a live release stays when going back could leave saved data unreadable.
  if [ -f "$S/releases/$sha/proven" ]; then
    say "ROLLBACK refused: $sha is proven, and the stores may hold what only it reads"
    return 1
  fi
  if [ ! -f "$S/releases/$sha/stores-before" ] || [ "$(stores)" != "$(cat "$S/releases/$sha/stores-before")" ]; then
    say "ROLLBACK refused: $sha changed a store's schema (or its record is missing), which $prev may not read"
    return 1
  fi
  say "ROLLBACK $sha → $prev"
  touch "$S/releases/$sha/bad"
  lockf -t 600 "$S/brain.lock" sh "$SELF" swap "$prev" "rollback-from-$sha"
  if healthy "http://127.0.0.1:$PORT" 60; then
    say "rolled back to $prev; healthy"
  else
    say "rolled back to $prev; STILL UNHEALTHY"
    return 1
  fi
}

watch() {
  sha=$1 prev=$2
  pid=$(core_pid)
  end=$(($(date +%s) + WATCH_MIN * 60))
  misses=0
  say "watching $sha for $WATCH_MIN min (pid $pid)"
  while [ "$(date +%s)" -lt "$end" ]; do
    sleep 10
    # A swap (or migrate) holds the brain: the core may be down on purpose.
    lockf -t 0 "$S/brain.lock" true 2>/dev/null || { pid=''; continue; }
    [ "$(basename "$(readlink "$S/current")")" = "$sha" ] || { say "$sha superseded; watch ends"; return 0; }
    [ -n "$pid" ] || pid=$(core_pid)
    if [ "$(core_pid)" != "$pid" ]; then
      say "core restarted (pid $pid → $(core_pid))"
      rollback "$sha" "$prev"
      return 1
    fi
    if bun "$S/current/health.ts" "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
      misses=0
    else
      misses=$((misses + 1))
      say "health miss $misses"
      if [ "$misses" -ge 3 ]; then
        rollback "$sha" "$prev"
        return 1
      fi
    fi
  done
  touch "$S/releases/$sha/proven"
  say "$sha proven"
}

# The feed's address: this machine's tailnet name, with its tailnet's domain.
feed() {
  name=$("$TAILSCALE" status --self --json | plutil -extract Self.DNSName raw -o - -)
  echo "https://${name%.}:$FEED_PORT"
}

unlock_signing() {
  [ -z "$SIGNING_KEYCHAIN" ] || security unlock-keychain -p "$(cat "$KEYCHAIN_PASS")" "$SIGNING_KEYCHAIN"
}

# "Switch Host.app": the binary and the Swift helpers, signed as the old Switchboard host is (same
# identifier and Developer ID, so the same designated requirement), hardened, with what TCC asks.
bundle() {
  rel=$1
  app="$rel/Switch Host.app"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  mv "$rel/switch" "$app/Contents/MacOS/switch"
  mv "$rel/provider-runtime" "$app/Contents/Resources/provider-runtime"
  ln -s "Switch Host.app/Contents/Resources/provider-runtime" "$rel/provider-runtime"
  iconutil -c icns apps/desktop/assets/brand/icon.iconset -o "$app/Contents/Resources/AppIcon.icns"
  # Each packages/**/macos/<name>.swift is one helper, beside the binary, run as its child.
  find packages -path '*/node_modules' -prune -o -path '*/macos/*.swift' -print | while read -r swift; do
    swiftc -O -o "$app/Contents/MacOS/$(basename "$swift" .swift)" "$swift"
  done
  cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
<key>CFBundleName</key><string>Switch Host</string>
<key>CFBundleDisplayName</key><string>Switch Host</string>
<key>CFBundleExecutable</key><string>switch</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>$(date +%s)</string>
<key>CFBundleShortVersionString</key><string>$(basename "$rel" | cut -c1-8)</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSAppleEventsUsageDescription</key><string>Switch drives apps on this Mac.</string>
<key>NSContactsUsageDescription</key><string>Switch keeps your contacts.</string>
<key>NSCalendarsFullAccessUsageDescription</key><string>Switch keeps your calendars.</string>
<key>NSRemindersFullAccessUsageDescription</key><string>Switch keeps your reminders.</string>
<key>NSLocationWhenInUseUsageDescription</key><string>Switch knows where you are.</string>
<key>NSLocationUsageDescription</key><string>Switch knows where you are.</string>
<key>NSLocalNetworkUsageDescription</key><string>Switch reaches your devices.</string>
</dict></plist>
PLIST
  ent="$rel/host.entitlements"
  cat > "$ent" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
<key>com.apple.security.cs.disable-library-validation</key><true/>
<key>com.apple.security.automation.apple-events</key><true/>
<key>com.apple.security.personal-information.addressbook</key><true/>
<key>com.apple.security.personal-information.calendars</key><true/>
<key>com.apple.security.personal-information.location</key><true/>
</dict></plist>
PLIST
  unlock_signing
  for helper in "$app"/Contents/MacOS/*; do
    [ "$(basename "$helper")" = switch ] && continue
    codesign --force --options runtime --timestamp --entitlements "$ent" \
      --identifier "$BUNDLE_ID.$(basename "$helper")" --sign "$IDENTITY" "$helper"
  done
  find "$app/Contents/Resources/provider-runtime" -type f | while IFS= read -r native; do
    if file -b "$native" | grep -q 'Mach-O'; then
      codesign --force --options runtime --timestamp --entitlements "$ent" --sign "$IDENTITY" "$native"
    fi
  done
  codesign --force --options runtime --timestamp --entitlements "$ent" --sign "$IDENTITY" "$app"
  codesign --verify --deep --strict "$app"
}

# Notarized and stapled, beside the canary. Apple being slow or down never blocks a deploy.
notarize() {
  [ -n "$NOTARY_KEY_ID" ] || return 1
  zip=$1/host.zip
  ditto -c -k --keepParent "$1/Switch Host.app" "$zip"
  ok=1
  if xcrun notarytool submit "$zip" --key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER" --wait --timeout 5m | grep -q 'status: Accepted'; then ok=0; fi
  rm -f "$zip"
  [ "$ok" = 0 ] || return 1
  xcrun stapler staple "$1/Switch Host.app"
}

# Its own lane: the desktop app (apps/desktop-gpui, in Rust), built, signed, notarized and published
# to its update feed by its own lane (apps/desktop-gpui/scripts/ship.sh, as the live app: the
# switchboard scheme, appId) at ~/.switch/updates-gpui, served on the tailnet's port 8446. Builds the
# newest release when it's done, so pushes coalesce. Each Mac's app updates itself from the feed.
app() {
  sha=$1
  # ~/.switch/app-hold holds the desktop app back: the core still ships, the feed doesn't move.
  if [ -f "$S/app-hold" ]; then
    say "app $sha held"
    return 0
  fi
  while :; do
    t=$(now)
    if git -C "$S/repo.git" show "$sha:apps/desktop-gpui/scripts/ship.sh" | SWITCH_GPUI_LIVE=1 sh -s "$sha" >"$LOGS/app-build.log" 2>&1; then
      say "app $sha published in $(since "$t") s"
    else
      tail -5 "$LOGS/app-build.log"
      say "app $sha FAILED"
    fi
    newest=$(git -C "$S/repo.git" rev-parse main)
    [ "$newest" != "$sha" ] && [ -d "$S/releases/$newest/Switch Host.app" ] || break
    sha=$newest
  done
}

# The Electrobun desktop app (apps/desktop), kept for a rollback only: `ship.sh app-electrobun <sha>`
# builds and publishes it to its old feed (~/.switch/updates, port 8443), which the Electrobun app
# reads. Nothing runs it on its own.
app_electrobun() {
  sha=$1
  src=$S/app-src
  [ -d "$src" ] || git -C "$S/src" worktree add -q --detach "$src" "$sha"
  t=$(now)
  git -C "$src" checkout -q --detach --force "$sha"
  (cd "$src" && bun install --frozen-lockfile --filter '!./extensions/*' >/dev/null)
  unlock_signing
  rel=$S/releases/$sha
  (
    cd "$src/apps/desktop"
    ELECTROBUN_DEVELOPER_ID=$IDENTITY ELECTROBUN_TEAMID=$TEAM SWITCH_APP_ID=$APP_ID \
      ELECTROBUN_APPLEAPIKEY=$NOTARY_KEY_ID ELECTROBUN_APPLEAPIKEYPATH=$NOTARY_KEY ELECTROBUN_APPLEAPIISSUER=$NOTARY_ISSUER \
      SWITCH_UPDATES=$(feed) VITE_BRAIN=ws://$SERVER:$PORT \
      SWITCH_APP_VERSION="0.1.$(date +%s)" bun run build >"$LOGS/app-build.log" 2>&1
  )
  mkdir -p "$S/updates.new"
  cp "$src/apps/desktop/artifacts/"* "$S/updates.new/"
  mkdir -p "$rel" && rm -rf "$rel/Switchboard.app" && ditto "$src/apps/desktop/build/stable-macos-arm64/Switchboard.app" "$rel/Switchboard.app"
  rm -rf "$S/updates.old" && { [ ! -d "$S/updates" ] || mv "$S/updates" "$S/updates.old"; } && mv "$S/updates.new" "$S/updates"
  say "app-electrobun $sha published in $(since "$t") s"
}

units() {
  # The update feed: on loopback, and to the tailnet as HTTPS (Electrobun's updater takes nothing
  # else) through Tailscale Serve on its own port, beside whatever else the machine serves.
  "$TAILSCALE" serve --bg --https=$FEED_PORT http://127.0.0.1:4880 >/dev/null
  mkdir -p "$S/updates"
  cat > "$HOME/Library/LaunchAgents/ax.switch.updates.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>ax.switch.updates</string>
<key>ProgramArguments</key><array><string>/usr/bin/python3</string><string>-m</string><string>http.server</string><string>4880</string><string>--bind</string><string>127.0.0.1</string><string>--directory</string><string>$S/updates</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$LOGS/updates.log</string>
<key>StandardErrorPath</key><string>$LOGS/updates.log</string>
</dict></plist>
PLIST
  # Legacy sync is off: imports only run at an operator's explicit request.
  launchctl disable "$DOMAIN/ax.switch.migrate"
  launchctl bootout "$DOMAIN/ax.switch.migrate" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/ax.switch.migrate.plist" "$HOME/Library/LaunchAgents/ax.switch.migrate.plist.loaded"
  # Loaded again only when its settings changed (kept as .loaded, as Switchboard's install-agent).
  for label in ax.switch.updates; do
    plist=$HOME/Library/LaunchAgents/$label.plist
    if cmp -s "$plist" "$plist.loaded" && launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then continue; fi
    launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
    for _ in $(seq 40); do
      launchctl print "$DOMAIN/$label" >/dev/null 2>&1 || break
      sleep 0.25
    done
    launchctl enable "$DOMAIN/$label"
    launchctl bootstrap "$DOMAIN" "$plist"
    cp "$plist" "$plist.loaded"
  done
}

# The server's repo.git deploys whenever main moves, with main's own scripts/hook.sh: tasks land
# there, on the server, with no workstation to deploy for them. Every ship puts it back, and a
# ship without it fails, so a hook gone missing is caught at the next ship, not found later.
HOOK='#!/bin/sh
script=$(git show main:scripts/hook.sh 2>/dev/null) || exit 0
exec sh -c "$script" hook "$@"'
deploy_hook() {
  hook=$S/repo.git/hooks/reference-transaction
  mkdir -p "$(dirname "$hook")"
  printf '%s\n' "$HOOK" > "$hook.new"
  chmod +x "$hook.new"
  mv "$hook.new" "$hook"
  [ -x "$hook" ] && [ "$(cat "$hook")" = "$HOOK" ] || { say "FAILED: no deploy hook in $S/repo.git"; exit 1; }
}

# A round the pressure tripped is over once its release is live or its own ship ends (deployed,
# failed or live already).
end_round() {
  round=$(cat "$S/tripped" 2>/dev/null) || return 0
  live=$(basename "$(readlink "$S/current" 2>/dev/null || echo none)")
  if [ "$round" = "$sha" ] || git -C "$S/repo.git" merge-base --is-ancestor "$round" "$live" 2>/dev/null; then
    rm -f "$S/tripped"
  fi
}

ship() {
  sha=$1
  trap end_round EXIT
  t0=$(now)
  rel=$S/releases/$sha
  say "ship $sha"
  deploy_hook
  # Live already: building it again would replace the live release (and its proven mark) and swap
  # the core for nothing, and a failed swap would then roll back past a release that's proven.
  if [ "$(basename "$(readlink "$S/current" 2>/dev/null || echo none)")" = "$sha" ] && [ ! -f "$rel/bad" ]; then
    say "$sha is live already"
    lockf -k "$S/landings.lock" sh "$SELF" settle
    exit 0
  fi
  [ -n "$IDENTITY" ] && [ -n "$BUNDLE_ID" ] && [ -n "$SERVER" ] || { say "FAILED: ~/.switch/deploy.json needs server, identity and hostId"; exit 1; }
  # Every host runs this release (packages/core/src/release.ts), so it carries a build for each
  # target a host has said it runs (the core keeps them in host-targets), beside the bundle for this
  # Mac's own: each one's platform packages are installed too.
  targets=$(grep -v "^darwin-" "$S/host-targets" 2>/dev/null || true)
  platforms="--os=darwin --cpu=$(uname -m | sed s/x86_64/x64/)"
  for t in $targets; do platforms="$platforms --os=${t%-*} --cpu=${t#*-}"; done
  # shellcheck disable=SC2086
  behind bun install --frozen-lockfile --filter '!./extensions/*' $platforms >/dev/null   # extensions install alone
  [ -d apps/desktop/.hutch/devkit ] || (cd apps/desktop && behind bunx electrobun prepare >/dev/null)
  behind bun run check >"$LOGS/check.log" 2>&1 || { tail -20 "$LOGS/check.log"; say "FAILED checks"; exit 1; }
  say "checks passed ($(since "$t0") s)"

  rm -rf "$rel" && mkdir -p "$rel"
  behind bun scripts/build-core.ts "$rel" >/dev/null
  behind bun build --compile packages/migrate/src/main.ts --outfile "$rel/switch-migrate" >/dev/null
  cp scripts/ship.sh scripts/health.ts scripts/backup.sh "$rel/"
  behind sh "$SELF" bundle "$rel" >"$LOGS/bundle.log" 2>&1 || { tail -5 "$LOGS/bundle.log"; say "FAILED to sign the bundle"; exit 1; }
  # The bundle as the Macs' hosts take it (packages/core/src/release.ts), packed once as it's built,
  # signed, so they can fetch it ahead (as the workstation's deploy once did); notarization staples
  # this server's own copy later.
  behind ditto -c -k --keepParent "$rel/Switch Host.app" "$rel/host-darwin-$(uname -m | sed s/x86_64/x64/).zip"
  # Each other target's binary and provider runtime, as scripts/install-host.sh lays them out. One
  # that won't build is said, and its hosts stay where they are; the core still ships.
  for t in $targets; do
    out=$rel/host-$t
    if behind bun scripts/build-core.ts "$out" "bun-$t" >"$LOGS/build-$t.log" 2>&1 &&
      COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -czf "$out.tar.gz" -C "$out" switch provider-runtime; then
      shasum -a 256 "$out.tar.gz" | cut -c1-64 > "$out.tar.gz.sha256"
    else
      tail -5 "$LOGS/build-$t.log"
      say "NO $t build: its hosts stay on their release"
      rm -f "$out.tar.gz"
    fi
    rm -rf "$out"
  done
  say "$sha built and signed ($(since "$t0") s)"

  # Landings coalesce: one a newer push overtook skips its canary; the newest ships next.
  newest=$(git -C "$S/repo.git" rev-parse main 2>/dev/null || echo "$sha")
  if [ "$newest" != "$sha" ] && [ ! -s "$S/tripped" ]; then
    say "$sha superseded by $newest before its canary"
    rm -rf "$rel"
    exit 0
  fi

  # The canary: the new core beside the live one, on a copy of the brain, with nothing heavy beside
  # it: it starts and serves its snapshot and widgets (a real turn is tested in dev). As a canary
  # (SWITCH_CANARY) it runs no extensions, pushes or autonomy and catches up on nothing. The last
  # deploy's tidy (compressing backups) and app publish (a build and upload) finish first,
  # and this one's notarization waits until after it.
  tq=$(now)
  lockf -t 900 "$S/tidy.lock" true 2>/dev/null || true
  lockf -t 900 "$S/app.lock" true 2>/dev/null || true
  waited=$(since "$tq")
  [ "${waited%.*}" -lt 1 ] || say "waited $waited s for the last deploy's lanes"
  canary=$S/canary
  # A free port, never a fixed one: other cores run on this machine too.
  CANARY_PORT=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
  rm -rf "$canary" 2>/dev/null || true
  mkdir -p "$canary"
  # The last deploy's backup, an instant clone; a consistent copy of the live brain without one.
  last=$(deploy_backups | grep '\.db$' | head -1)
  if [ -n "$last" ]; then
    cp -c "$S/backups/$last" "$canary/brain.db"
  elif [ -f "$S/brain.db" ]; then
    sqlite3 "$S/brain.db" "VACUUM INTO '$canary/brain.db';"
  fi
  # A launchd job like the core, not a child of this ssh session: only the login session reaches
  # the keychain that the agent's subscriptions sign in with.
  key=$(zsh -lc 'printf %s "${AI_GATEWAY_API_KEY:-}"')
  cplist=$canary/ax.switch.canary.plist
  umask 077
  cat > "$cplist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>ax.switch.canary</string>
<key>ProgramArguments</key><array><string>$rel/Switch Host.app/Contents/MacOS/switch</string></array>
<key>EnvironmentVariables</key><dict>
<key>PATH</key><string>$PATH</string>
<key>AI_GATEWAY_API_KEY</key><string>$key</string>
<key>SWITCH_DIR</key><string>$canary</string>
<key>SWITCH_CONFIG</key><string>$S/config.json</string>
<key>SWITCH_HOST</key><string>127.0.0.1</string>
<key>SWITCH_PORT</key><string>$CANARY_PORT</string>
<key>SWITCH_BRAIN</key><string>$canary/brain.db</string>
<key>CLOCK_STATE</key><string>$canary/clock.json</string>
<key>SWITCH_CANARY</key><string>true</string>
</dict>
<key>RunAtLoad</key><true/>
<key>ExitTimeOut</key><integer>10</integer>
<key>StandardOutPath</key><string>$LOGS/canary.log</string>
<key>StandardErrorPath</key><string>$LOGS/canary.log</string>
</dict></plist>
PLIST
  umask 022
  : >"$LOGS/canary.log"
  launchctl bootout "$DOMAIN/ax.switch.canary" 2>/dev/null || true
  tp=$(now)
  # A brain this build can't open (events no upcast reads, a newer build's tables) fails here, with
  # the live core untouched, rather than in the swap.
  if ! SWITCH_DIR=$canary SWITCH_CONFIG=$S/config.json SWITCH_BRAIN=$canary/brain.db \
    "$rel/Switch Host.app/Contents/MacOS/switch" prepare >>"$LOGS/canary.log" 2>&1; then
    tail -5 "$LOGS/canary.log"
    rm -rf "$canary" 2>/dev/null || true
    touch "$rel/bad"
    say "FAILED canary: its brain wouldn't prepare; live core untouched"
    exit 1
  fi
  say "canary brain prepared in $(since "$tp") s"
  # Its brain read once through, so the turn test times the core, not a cold disk.
  tc=$(now)
  cat "$canary/brain.db" >/dev/null
  say "canary brain warmed in $(since "$tc") s"
  ts=$(now)
  launchctl bootstrap "$DOMAIN" "$cplist"
  ok=1
  for _ in $(seq 150); do
    bun "$rel/health.ts" "http://127.0.0.1:$CANARY_PORT" >/dev/null 2>&1 && { ok=0; break; }
    sleep 0.2
  done
  [ "$ok" = 0 ] && say "canary served its snapshot $(since "$ts") s after start"
  [ "$ok" = 0 ] && { bun "$rel/health.ts" "http://127.0.0.1:$CANARY_PORT" || ok=1; }
  launchctl bootout "$DOMAIN/ax.switch.canary" 2>/dev/null || true
  rm -rf "$canary" 2>/dev/null || true
  if [ "$ok" != 0 ]; then
    tail -5 "$LOGS/canary.log"
    touch "$rel/bad"
    say "FAILED canary; live core untouched"
    exit 1
  fi
  say "canary healthy ($(since "$t0") s)"
  # The hosts on other machines fetch this release ahead, while it's notarized and waits for turns.
  told=$(curl -sf -m 10 -X POST "http://127.0.0.1:$PORT/hosts/next?release=$sha" || true)
  say "${told:-no} hosts told $sha comes next"
  if /usr/sbin/taskpolicy -b sh "$SELF" notarize "$rel" >"$LOGS/notarize.log" 2>&1; then say "notarized ($(since "$t0") s)"; else say "NOT notarized; shipping signed"; fi

  prev=$(basename "$(readlink "$S/current" 2>/dev/null || echo none)")
  [ "$prev" = none ] && prev=''
  [ "$prev" = "$sha" ] && prev=$(cat "$S/previous" 2>/dev/null || echo '')
  [ -n "$prev" ] && echo "$prev" > "$S/previous"
  [ -f "$HOME/Library/LaunchAgents/$CORE.plist" ] || core_unit
  wait_for_turns "$sha"
  # The swap holds brain.lock, so migrate never writes while the core changes hands.
  tw=$(now)
  if ! lockf -t 600 "$S/brain.lock" sh "$rel/ship.sh" swap "$sha" "$sha" pause; then
    # The swap has put a core back either way: <sha>'s, checked below, or the one before it.
    if [ "$(basename "$(readlink "$S/current")")" != "$sha" ]; then
      say "FAILED: $sha's swap failed before it went live; ${prev:-the last release} still serves"
      exit 1
    fi
    say "$sha's swap failed after it went live"
  fi
  td=$(now)
  units
  if ! healthy "http://127.0.0.1:$PORT" 60 >/dev/null 2>&1; then
    say "live core unhealthy after the swap"
    rollback "$sha" "$prev"
    exit 1
  fi
  say "swapped in $(perl -e "printf '%.1f', $td - $tw") s; live core served $(since "$td") s after start"
  say "DEPLOYED $sha in $(since "$t0") s"
  # Every store to the backup disk, with the brain as it was before this build's migration: the
  # core runs it (backup.sh), and tells the agent if it fails.
  curl -sf -m 15 --retry 4 --retry-all-errors --retry-delay 5 -X POST "http://127.0.0.1:$PORT/backup?label=$sha&brain=$S/backups/$(deploy_backups | grep '\.db$' | head -1)" >/dev/null ||
    say "backup: the core didn't take it"
  lockf -k "$S/landings.lock" sh "$rel/ship.sh" settle
  nohup lockf -t 0 "$S/tidy.lock" /usr/sbin/taskpolicy -b sh "$rel/ship.sh" tidy >>"$LOGS/ship.log" 2>&1 </dev/null &
  nohup sh "$rel/ship.sh" watch "$sha" "$prev" >>"$LOGS/ship.log" 2>&1 </dev/null &
  nohup lockf -t 0 "$S/app.lock" /usr/sbin/taskpolicy -b sh "$rel/ship.sh" app "$sha" >>"$LOGS/ship.log" 2>&1 </dev/null &
}

case ${1:-} in
  swap) swap "$2" "$3" "${4:-}" ;;
  settle) settle ;;
  tidy) tidy; say "tidied: backups $(du -sh "$S/backups" | cut -f1), releases $(du -sh "$S/releases" | cut -f1)" ;;
  watch) watch "$2" "${3:-}" ;;
  rollback) rollback "$2" "${3:-}" ;;
  app) app "$2" ;;
  app-electrobun) app_electrobun "$2" ;;
  bundle) bundle "$2" || exit 1 ;;
  notarize) notarize "$2" || exit 1 ;;
  "") echo "usage: ship.sh <sha> | watch <sha> <prev> | rollback <sha> <prev> | app <sha>" >&2; exit 2 ;;
  *) ship "$1" ;;
esac
