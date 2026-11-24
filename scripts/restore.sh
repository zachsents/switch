#!/bin/sh
# A snapshot scripts/backup.sh made, put back into a folder, then checked against what the backup
# recorded: the brain whole and every event in it, every blob an event names, every extension's
# folder, the logins, every file; then a core started on it (as a canary: no extensions, pushes or
# autonomy) must serve its snapshot.
#   restore.sh <folder> [snapshot]   the newest snapshot unless one is named; <folder> must be new
#                                    or empty, never a live ~/.switch
# The image is <backups>/switch.sparsebundle (deploy.json's `backups`, or $SWITCH_BACKUPS), opened
# with the passphrase in the login keychain (ax.switch.backup), else hdiutil asks for it. The core started is
# $SWITCH_BIN, else the live release's; $SWITCH_BIN=none skips it.
# On a new machine: restore into ~/.switch (the folder must not exist yet), then deploy, which
# builds the releases.
set -eu
S=$HOME/.switch
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
conf() { plutil -extract "$1" raw -o - "$S/deploy.json" 2>/dev/null || true; }
expand() { case $1 in "~/"*) echo "$HOME/${1#\~/}" ;; *) echo "$1" ;; esac; }
say() { echo "[restore $(date +%H:%M:%S)] $*"; }
die() {
  say "FAILED: $*"
  exit 1
}

to=${1:?usage: restore.sh <folder> [snapshot]}
want=${2:-}
[ ! -e "$to/brain.db" ] && [ ! -e "$to/brain.db.zst" ] || die "$to already holds a brain"
mkdir -p "$to"
to=$(cd "$to" && pwd)
dest=${SWITCH_BACKUPS:-$(expand "$(conf backups)")}
[ -n "$dest" ] || die "No backups folder: set deploy.json's backups or SWITCH_BACKUPS"
IMG=$dest/switch.sparsebundle
[ -d "$IMG" ] || die "No image at $IMG"
rsync --version | grep -q '^rsync  *version 3' || die "rsync 3 is needed (brew install rsync)"

# backup.sh's mount when it's open (hold backup.lock to keep it so); else a read-only one of ours.
MNT=$HOME/Library/Caches/ax.switch.backup/mnt
attached=''
if ! mount | grep -qF " on $MNT ("; then
  MNT=$(mktemp -d "${TMPDIR:-/tmp}/switch-restore.XXXXXX")
  if security find-generic-password -s ax.switch.backup -a backups >/dev/null 2>&1; then
    security find-generic-password -s ax.switch.backup -a backups -w | tr -d '\n' |
      hdiutil attach -quiet -readonly -stdinpass -nobrowse -noautoopen -owners on -mountpoint "$MNT" "$IMG" ||
      die "Can't open $IMG"
  else
    hdiutil attach -quiet -readonly -nobrowse -noautoopen -owners on -mountpoint "$MNT" "$IMG" || die "Can't open $IMG"
  fi
  attached=1
fi
core=''
cleanup() {
  [ -z "$core" ] || kill "$core" 2>/dev/null || true
  [ -z "$attached" ] || hdiutil detach -quiet "$MNT" 2>/dev/null || hdiutil detach -quiet -force "$MNT" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 1' INT TERM HUP

snap=${want:-$(ls -1 "$MNT/snapshots" | grep -v '\.partial$' | sort | tail -1)}
from=$MNT/snapshots/$snap
[ -n "$snap" ] && [ -f "$from/manifest" ] || die "No snapshot ${want:-in $IMG}"
m() { awk -v k="$1" '$1 == k { sub(/^[^ ]+ ?/, ""); print }' "$from/manifest"; }
say "restoring $snap (release $(m release)) to $to"

t0=$(date +%s)
rsync -aH "$from/files/" "$to/" || die "Copying files failed"
zstd -q -d "$to/brain.db.zst" -o "$to/brain.db" && rm -f "$to/brain.db.zst" || die "Can't decompress the brain"
find "$to" -name .node_modules.tar.zst | while read -r a; do
  zstd -q -dc "$a" | tar -xf - -C "$(dirname "$a")" || die "Can't unpack $a"
  rm -f "$a" "$(dirname "$a")/.node_modules.sig"
done
[ -z "$(find "$to" -name .node_modules.tar.zst)" ] || die "Some node_modules wouldn't unpack"
say "copied in $(($(date +%s) - t0)) s: $(du -sh "$to" | cut -f1)"

bad=0
check() {
  if [ "$2" = "$3" ]; then
    say "ok    $1: $2"
  else
    say "WRONG $1: $2, backed up $3"
    bad=1
  fi
}
check "brain" "$(sqlite3 -readonly "$to/brain.db" 'PRAGMA quick_check;')" ok
check "events" "$(sqlite3 -readonly "$to/brain.db" 'SELECT coalesce(max(seq), 0) FROM events;')" "$(m events)"
check "blobs" "$(find "$to/blobs" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')" "$(m blobs)"
# Every blob an event names (an attachment's `blob`), where the backup had it.
sqlite3 -readonly "$to/brain.db" "SELECT payload FROM events WHERE payload LIKE '%\"blob\":\"%';" |
  grep -oE '"blob":"[0-9a-f]{64}"' | cut -d'"' -f4 | sort -u >"$to/.named"
missing=0
while read -r h; do
  [ -f "$to/blobs/$h/data" ] || missing=$((missing + 1))
done <"$to/.named"
say "      blobs named in events: $(wc -l <"$to/.named" | tr -d ' '), not here: $missing"
rm -f "$to/.named"
check "extensions" "$(ls -1 "$to/extensions" 2>/dev/null | tr '\n' ' ')" "$(m extensions)"
check "logins" "$(find "$to/logins" -type f 2>/dev/null | wc -l | tr -d ' ')" "$(m logins)"
check "files" "$(find "$to" \( -type f -o -type l \) | wc -l | tr -d ' ')" "$(m files)"
find "$to" -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) ! -path "$to/brain.db" | while read -r db; do
  r=$(sqlite3 -readonly "$db" 'PRAGMA quick_check;' 2>/dev/null || echo unreadable)
  [ "$r" = ok ] || say "WRONG ${db#"$to"/}: $r"
done | grep . && bad=1
for f in deploy.json config.json; do
  [ -f "$to/$f" ] || { say "WRONG $f: missing"; bad=1; }
done

bin=${SWITCH_BIN:-$S/current/Switch Host.app/Contents/MacOS/switch}
if [ "$bin" != none ] && [ -x "$bin" ]; then
  port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
  envs="SWITCH_DIR=$to SWITCH_CONFIG=$to/config.json SWITCH_BRAIN=$to/brain.db SWITCH_HOST=127.0.0.1 SWITCH_PORT=$port CLOCK_STATE=$to/clock.json SWITCH_CANARY=true"
  # shellcheck disable=SC2086
  env $envs "$bin" prepare >"$to/.restore-core.log" 2>&1 || { tail -3 "$to/.restore-core.log"; die "The brain wouldn't prepare"; }
  # shellcheck disable=SC2086
  env $envs "$bin" >>"$to/.restore-core.log" 2>&1 &
  core=$!
  health=$(dirname "$(dirname "$(dirname "$(dirname "$bin")")")")/health.ts
  [ -f "$health" ] || health=$S/current/health.ts
  served=1
  for _ in $(seq 150); do
    bun "$health" "http://127.0.0.1:$port" >/dev/null 2>&1 && { served=0; break; }
    sleep 0.4
  done
  kill "$core" 2>/dev/null || true
  wait "$core" 2>/dev/null || true
  core=''
  if [ "$served" = 0 ]; then
    say "ok    core: served its snapshot"
  else
    tail -3 "$to/.restore-core.log"
    say "WRONG core: didn't serve"
    bad=1
  fi
fi
[ "$bad" = 0 ] || die "$snap restored to $to with differences (above)"
say "$snap restored to $to whole in $(($(date +%s) - t0)) s"
