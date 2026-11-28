#!/bin/sh
# A snapshot of every store in ~/.switch, to the backup disk ~/.switch/deploy.json names:
#   backups      the folder on it (an encrypted APFS disk image, switch.sparsebundle, is kept there)
#   backupsSize  the image's cap (default 40g), which old snapshots are dropped to stay under
# On Linux there's no such image: the snapshots are plain folders in <backups>/snapshots (0700, on
# the server's own disk beside the live stores), and each new one also goes into an encrypted
# restic repository, <backups>/switch.restic, whose passphrase is ~/.config/switch/backup.pass
# (0600; a first run makes both; keep a copy off this machine). The second copy pulls that
# repository: its files are only ever added and removed, never changed, so any disk keeps them.
# The image is compacted after each run, giving the disk back what it deleted. A disk too full for
# the image's room is a failure (snapshots are never dropped for it).
# The image's passphrase is in the login keychain (ax.switch.backup), never a file or a log; a first
# run makes both. Keep a copy off this machine: a restore elsewhere needs it.
# Inside, snapshots/<time>-<label>/files is ~/.switch as it was: what the release, the checkouts and
# the deploy's own brain copies rebuild is left out, every SQLite file is a consistent copy, the brain
# is brain.db.zst, and a file unchanged since the last snapshot is a hard link to it.
#   backup.sh <label> [brain]   brain: a copy to back up instead of the live one (the deploy's,
#                               taken before its migration)
# A deploy's (its label a commit) is skipped while the last snapshot is under an hour old: deploys
# come minutes apart, and each keeps its own copy in ~/.switch/backups meanwhile (compressed by the
# deploy's tidy, <brain>.zst, which is taken as it is once the copy is). Nothing of the brain's size
# lands on this disk: its consistent copy is made in the image, beside the snapshot.
# The core runs it (POST /backup, and nightly) at background priority under ~/.switch/backup.lock:
# it has the disk access.
# The last line of a failure says what's wrong; the core raises it to the agent.
#   backup.sh serve             a pull by the second copy (scripts/backup-pull.sh), over ssh
# scripts/restore.sh puts a snapshot back.
set -eu
S=${SWITCH_DIR:-$HOME/.switch}
. "$(cd "$(dirname "$0")" && pwd)/os.sh"
SERVICE=ax.switch.backup
PASSFILE=$HOME/.config/switch/backup.pass
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p "$LOGS"
expand() { case $1 in "~/"*) echo "$HOME/${1#\~/}" ;; *) echo "$1" ;; esac; }
say() { echo "[backup $(date +%H:%M:%S)] $*" >>"$LOGS/backup.log"; }
fail() {
  say "FAILED: $*"
  echo "$*" >&2
  exit 1
}

label=${1:?usage: backup.sh <label> [brain]}
brain=${2:-$S/brain.db}
DEST=$(expand "$(conf backups)")
SIZE=$(conf backupsSize)
[ -n "$SIZE" ] || SIZE=40g
[ -n "$DEST" ] || fail "No backups folder in deploy.json"
# A folder on a volume that isn't mounted would land on the system disk instead.
case $DEST in
  /Volumes/*)
    vol=/Volumes/$(echo "${DEST#/Volumes/}" | cut -d/ -f1)
    if [ ! -d "$vol" ] || [ "$(dev "$vol")" = "$(dev /Volumes)" ]; then
      fail "The backup disk isn't mounted ($vol)"
    fi
    ;;
esac
mkdir -p "$DEST" 2>/dev/null || fail "Can't write to $DEST"
# macOS's own rsync (openrsync) breaks on --link-dest.
rsync --version | grep -q '^rsync  *version 3' || fail "rsync 3 is needed (brew install rsync)"
# A pull by the second copy (scripts/backup-pull.sh), the only thing its key may do: the image read
# while no backup writes it, or its word that it pulled.
if [ "$label" = serve ]; then
  cmd=${SSH_ORIGINAL_COMMAND:-}
  if [ "$cmd" = pulled ]; then
    date +%s >"$S/backup-pulled"
    exit 0
  fi
  if printf %s "$cmd" | grep -q '[^A-Za-z0-9 ._=/,-]'; then
    fail "A pull asked for something else"
  fi
  case $cmd in
    "rsync --server --sender "*" . switch.sparsebundle/" | "rsync --server --sender "*" . switch.restic/") ;;
    *) fail "A pull asked for something else" ;;
  esac
  cd "$DEST"
  # shellcheck disable=SC2086
  exec sh -c '. "$1"; shift; background lk 3600 "$@"' sh "$(cd "$(dirname "$0")" && pwd)/os.sh" "$S/backup.lock" "$(command -v rsync)" ${cmd#rsync }
fi
[ -f "$brain" ] || [ -f "$brain.zst" ] || fail "No brain at $brain"
# Deploys come minutes apart: one an hour reaches the image.
if printf %s "$label" | grep -qE '^[0-9a-f]{40}$' && [ -f "$S/backup-last" ]; then
  ago=$(($(date +%s) - $(cat "$S/backup-last" 2>/dev/null || echo 0)))
  if [ "$ago" -lt "${SWITCH_BACKUP_EVERY:-3600}" ]; then
    say "$label: skipped, the last snapshot is $((ago / 60)) min old"
    exit 0
  fi
fi
# A run killed outright leaves its work folder (lists, and a deploy's brain held by a link) and the
# brain's copy in the image; backup.lock means none other is running.
rm -rf "${TMPDIR:-/tmp}"/switch-backup.*

t0=$(date +%s)
say "$label: start"
gb() { awk -v k="$1" 'BEGIN { printf "%.1f GB", k / 1048576 }'; }
# Free space on the disk the backups are on, in KB.
host_free() { df -k "$DEST" | awk 'NR == 2 { print $4 }'; }
if [ "$OS" != Darwin ]; then
  # The snapshots are a plain folder; the cap is backupsSize, against what they hold (each file
  # once, however many snapshots link it).
  MNT=$DEST
  mkdir -p "$MNT/snapshots"
  chmod 700 "$DEST"
  attached=''
  CAP=$(echo "$SIZE" | awk '{ n = $1 + 0; u = tolower(substr($1, length($1))); m = u == "t" ? 1073741824 : u == "g" ? 1048576 : u == "m" ? 1024 : 1; print int(n * m) }')
  REPO=$DEST/switch.restic
  command -v restic >/dev/null || fail "restic is needed (apt install restic)"
  if [ ! -s "$PASSFILE" ]; then
    [ ! -e "$REPO" ] || fail "No passphrase for $REPO ($PASSFILE)"
    mkdir -p "$(dirname "$PASSFILE")"
    (umask 077 && openssl rand -hex 32 >"$PASSFILE") || fail "Can't keep the backup passphrase in $PASSFILE"
  fi
  if [ ! -e "$REPO/config" ]; then
    RESTIC_PASSWORD_FILE=$PASSFILE restic -r "$REPO" init -q >/dev/null || fail "Can't make $REPO"
    say "made $REPO (encrypted)"
  fi
  compact() { :; }
  used() { du -sk "$MNT/snapshots" | cut -f1; }
fi
IMG=$DEST/switch.sparsebundle
[ "$OS" = Darwin ] || IMG=$REPO
if [ "$OS" = Darwin ]; then
pass=$(security find-generic-password -s "$SERVICE" -a backups -w 2>/dev/null || true)
if [ -z "$pass" ]; then
  [ ! -e "$IMG" ] || fail "No passphrase for $IMG in the keychain ($SERVICE)"
  pass=$(openssl rand -hex 32)
  # Through stdin, so it's in no process's arguments. Only the security tool reads it back.
  printf 'add-generic-password -s %s -a backups -l "Switch backups" -T /usr/bin/security -w %s\n' "$SERVICE" "$pass" |
    security -i >/dev/null 2>&1 || fail "Can't keep the backup passphrase in the keychain"
  [ "$(security find-generic-password -s "$SERVICE" -a backups -w 2>/dev/null)" = "$pass" ] ||
    fail "Can't keep the backup passphrase in the keychain"
fi
if [ ! -e "$IMG" ]; then
  printf %s "$pass" | hdiutil create -quiet -size "$SIZE" -type SPARSEBUNDLE -fs APFS \
    -encryption AES-256 -stdinpass -volname "Switch backups" "$IMG" || fail "Can't make $IMG"
  say "made $IMG ($SIZE, encrypted)"
fi
# Mounted where nothing else looks; one a killed run left attached is used as it is.
MNT=$HOME/Library/Caches/$SERVICE/mnt
mkdir -p "$MNT"
attached=''
# The image's cap, as it was made (its Info.plist, readable without the passphrase), in KB.
CAP=$(($(plutil -extract size raw -o - "$IMG/Info.plist" 2>/dev/null || echo 0) / 1024))
# The image keeps what it deleted (a snapshot, the brain's copy) on the disk until it's compacted,
# which it can be only while detached: after each run, and before one when the disk is low. The
# passphrase goes through stdin, as for attaching. A failed compact is logged, and fails nothing.
compact() {
  mount | grep -qF " on $MNT (" && return 0
  before=$(du -sk "$IMG" 2>/dev/null | cut -f1)
  t=$(date +%s)
  out=$(mktemp "${TMPDIR:-/tmp}/switch-backup-compact.XXXXXX")
  p=$(security find-generic-password -s "$SERVICE" -a backups -w 2>/dev/null || true)
  if printf %s "$p" | hdiutil compact -stdinpass "$IMG" >"$out" 2>&1; then
    p=''
    after=$(du -sk "$IMG" 2>/dev/null | cut -f1)
    say "compacted the image in $(($(date +%s) - t)) s: $(gb $((${before:-0} - ${after:-0}))) freed, $(gb "${after:-0}") on the disk, $(gb "$(host_free)") free there"
  else
    p=''
    say "compacting the image failed: $(grep -v '^$' "$out" | tail -1)"
  fi
  rm -f "$out"
}
# This run's brain copy goes in the image first: with less than that and a margin on the disk, what
# the image deleted is given back before it opens.
need=$(($(size "$S/brain.db") / 1024 + 2097152))
if [ "$(host_free)" -lt "$need" ] && ! mount | grep -qF " on $MNT ("; then
  compact
  [ "$(host_free)" -ge "$need" ] ||
    fail "The backup disk ($DEST) has $(gb "$(host_free)") free, and a snapshot needs about $(gb "$need"): free some space on it"
fi
if ! mount | grep -qF " on $MNT ("; then
  printf %s "$pass" | hdiutil attach -quiet -stdinpass -nobrowse -noautoopen -owners on -mountpoint "$MNT" "$IMG" ||
    fail "Can't open $IMG"
  attached=1
fi
# Spotlight never indexes it: each snapshot is hundreds of thousands of new paths, and indexing them
# competes with the core for the disk. Turning off a disk image's index needs no admin.
mdutil -i off "$MNT" >/dev/null 2>&1 || true
pass=''
fi
work=$(mktemp -d "${TMPDIR:-/tmp}/switch-backup.XXXXXX")
# Detached, if this run attached it, and compacted then; once, at the end or on the way out.
done_() {
  rm -rf "$work"
  [ -n "$attached" ] || return 0
  attached=''
  if hdiutil detach -quiet "$MNT" 2>/dev/null || hdiutil detach -quiet -force "$MNT" 2>/dev/null; then
    # Stopped (a deploy restarts the core): the next run compacts it.
    [ -n "$stopping" ] || compact
  else
    say "the image didn't detach, so it isn't compacted"
  fi
}
stopping=''
trap done_ EXIT
trap 'stopping=1; exit 1' INT TERM HUP

SNAP=$MNT/snapshots
mkdir -p "$SNAP"
rm -f "$SNAP"/.brain.db*
# What a run cut short (a deploy restarts the core that runs it) copied is carried on from.
partial=$(ls -1d "$SNAP"/*.partial 2>/dev/null | sort | tail -1)
if [ -n "$partial" ]; then
  rm -rf "$SNAP/.resume"
  mv "$partial" "$SNAP/.resume"
  rm -rf "$SNAP"/*.partial
fi

# Room left in the image, as a percentage of its cap: what's used in it against the cap, never
# df's free space, which is no more than the disk under it has left (a full disk is no reason to
# drop a snapshot: dropping one doesn't give the disk anything back until the image is compacted).
[ "$OS" != Darwin ] || used() { df -k "$MNT" | awk 'NR == 2 { print $3 }'; }
[ "$CAP" -gt 0 ] || CAP=$(df -k "$MNT" | awk 'NR == 2 { print $2 }')
free_pct() { echo $(((CAP - $(used)) * 100 / CAP)); }
# Why a step failed, from what its tool said (a file): its "No space left on device" when it said
# one (rsync's last line is then only the broken pipe it left), with what the image has left, or
# else its last line.
why() {
  e=$(grep -m1 'No space left on device' "$1" 2>/dev/null || grep -v '^$' "$1" 2>/dev/null | tail -1)
  case $e in
    *"No space left on device"*)
      e="$e: the backup image is full, $(gb "$((CAP - $(used)))") left of its $(gb "$CAP")"
      ;;
  esac
  printf %s "${e:-no reason given}"
}
snapshots() { ls -1 "$SNAP" | grep -v '\.partial$' | sort; }
# The newest 5, each of the last 14 days' newest and each of the last 8 weeks' newest are kept;
# then the oldest go while the image is less than a fifth free (never the newest).
prune() {
  keep=$work/keep
  snapshots | tail -5 >"$keep"
  snapshots | sort -r | awk -v d="$(days_ago 13)" '{ day = substr($0, 1, 8) } day >= d && !seen[day]++' >>"$keep"
  snapshots | sort -r | while read -r s; do
    echo "$(week_of "${s%%-*}") $s"
  done | awk -v w="$(weeks_ago 7)" '$1 >= w && !seen[$1]++ { print $2 }' >>"$keep"
  snapshots | while read -r s; do
    grep -qxF "$s" "$keep" || { rm -rf "${SNAP:?}/$s"; say "dropped $s"; }
  done
  while [ "$(free_pct)" -lt 20 ] && [ "$(snapshots | wc -l)" -gt 1 ]; do
    s=$(snapshots | head -1)
    rm -rf "${SNAP:?}/$s"
    say "dropped $s for room"
  done
}
prune

name=$(date +%Y%m%d-%H%M%S)-$label
new=$SNAP/$name.partial
prev=$(snapshots | tail -1)
if [ -d "$SNAP/.resume" ]; then
  mv "$SNAP/.resume" "$new"
  rm -f "$new/manifest" "$new/files/brain.db.zst"
fi
mkdir -p "$new/files"

# Folders the walks below never go into: what's left out, and node_modules, packed on its own.
prune_dirs() {
  find "$S" \( -path "$S/releases" -o -path "$S/src" -o -path "$S/app-src" -o -path "$S/release-src" -o -path "$S/gpui-src" -o -path "$S/gpui-target" -o -path "$S/backups" \
    -o -path "$S/canary" -o -path "$S/updates" -o -path "$S/updates.old" -o -path "$S/updates.new" -o -path "$S/updates-gpui" -o -path "$S/updates-gpui.old" \
    -o -path "$S/iphone-builds" -o -path "$S/preview" -o -path "$S/procs" -o -path "$S/current" \
    -o -path "$S/extensions/*/pkg" "$@"
}

# Left out: what a deploy rebuilds (releases, checkouts, the update feed, builds), each extension's
# pkg (installed again from its source whenever it starts), its own brain
# copies (backups/, the canary), what lasts only while running (procs, locks), the browser a page is
# previewed in, every SQLite file and every node_modules folder, both copied on their own below.
# And any folder that says it's a cache (a CACHEDIR.TAG in it, as cargo writes in each build tree),
# wherever it is: a build tree pointed into ~/.switch is tens of GB, and would fill the image.
cat >"$work/exclude" <<'EOF'
/releases/
/current
/src/
/app-src/
/release-src/
/gpui-src/
/gpui-target/
/backups/
/canary/
/updates/
/updates.new/
/updates.old/
/updates-gpui/
/updates-gpui.old/
/iphone-builds/
/preview/
/procs/
/fetch/
/blobs/tmp/
/extensions/*/pkg/
node_modules/
.node_modules.*
*.lock
*.db
*.db-wal
*.db-shm
*.db-journal
*.sqlite
*.sqlite-wal
*.sqlite-shm
*.sqlite3
EOF
# Each cache's folder, from ~/.switch, as a pattern that matches only it (its wildcards escaped).
prune_dirs -o -name node_modules \) -prune -o -type f -name CACHEDIR.TAG -print |
  while read -r tag; do
    rel=$(dirname "${tag#"$S"/}")
    printf '/%s/\n' "$(printf %s "$rel" | sed 's/[][*?\\]/\\&/g')"
  done >>"$work/exclude"
link=''
[ -z "$prev" ] || link=--link-dest=$SNAP/$prev/files
rc=0
# shellcheck disable=SC2086
# Sockets and devices only mean something while their process runs: -a without -D.
# --delete-excluded: a run carried on from (.resume) drops what it copied that's left out now.
rsync -rlptgoH --delete --delete-excluded --exclude-from="$work/exclude" $link "$S/" "$new/files/" 2>"$work/rsync.err" || rc=$?
# Files that went while they were copied (a log rotated, a build replaced) are fine: 24, or 23
# when every error is a file not found (openrsync says no more).
gone=''
if [ "$rc" = 24 ] || { [ "$rc" = 23 ] && ! grep 'error:' "$work/rsync.err" | grep -qv ' (2)'; }; then
  gone=1
fi
if [ "$rc" != 0 ] && [ -z "$gone" ]; then
  tail -3 "$work/rsync.err" >>"$LOGS/backup.log"
  fail "Copying files failed: $(why "$work/rsync.err")"
fi

# A node_modules folder (an extension's packages: most of the files) as one archive beside it,
# .node_modules.tar.zst, made again only when its files changed (.node_modules.sig): a snapshot
# links a few hundred thousand fewer files. restore.sh unpacks them. One in a folder left out (a
# cache) isn't in the snapshot's copy of it, and isn't packed.
prune_dirs \) -prune -o -type d -name node_modules -prune -print >"$work/modules"
packed=0
: >"$work/module-files"
while read -r d; do
  rel=$(dirname "${d#"$S"/}")
  at=$new/files/$rel
  [ -d "$at" ] || continue
  if [ "$OS" = Darwin ]; then
    find "$d" \( -type f -o -type l \) -print0 | xargs -0 stat -f '%N %z %m' >"$work/list" 2>/dev/null || true
  else
    find "$d" \( -type f -o -type l \) -printf '%p %s %T@\n' >"$work/list" 2>/dev/null || true
  fi
  grep -c '' "$work/list" >>"$work/module-files" || true
  sig=$(shasum <"$work/list" | cut -c1-40)
  if [ "$(cat "$at/.node_modules.sig" 2>/dev/null)" = "$sig" ] && [ -f "$at/.node_modules.tar.zst" ]; then
    continue
  fi
  rm -f "$at/.node_modules.tar.zst" "$at/.node_modules.sig"
  if [ -n "$prev" ] && [ "$(cat "$SNAP/$prev/files/$rel/.node_modules.sig" 2>/dev/null)" = "$sig" ]; then
    ln "$SNAP/$prev/files/$rel/.node_modules.tar.zst" "$at/.node_modules.tar.zst"
  else
    tar -cf - -C "$(dirname "$d")" node_modules 2>/dev/null | zstd -q -T0 -3 -o "$at/.node_modules.tar.zst" ||
      fail "Can't pack $rel/node_modules"
    packed=$((packed + 1))
  fi
  echo "$sig" >"$at/.node_modules.sig"
done <"$work/modules"

# SQLite files: each a consistent copy (VACUUM INTO reads one transaction), the brain compressed.
# A copy of brain size passes the file cache by (uncached, os.sh).
sq() { printf %s "$1" | sed "s/'/''/g"; }
prune_dirs -o -name node_modules \) -prune -o -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) -print >"$work/dbs"
while read -r db; do
  rel=${db#"$S"/}
  [ "$rel" != brain.db ] || continue
  # In a folder left out (a cache): the copy of the files left it out too.
  [ -d "$(dirname "$new/files/$rel")" ] || continue
  sqlite3 "$db" "VACUUM INTO '$(sq "$new/files/$rel")';" 2>"$work/db.err" || {
    # Not SQLite after all, or not readable as one: copied as it is.
    cp -p "$db" "$new/files/$rel" || fail "Can't copy $rel: $(tail -1 "$work/db.err")"
  }
done <"$work/dbs"
# The brain, compressed into the snapshot, the image the only place a copy of it is made. A deploy's
# copy (taken at rest, checkpointed) is held by a hard link first, an instant that costs nothing,
# since the deploy's tidy compresses it meanwhile: it's compressed as it is, or once tidy has,
# its .zst taken as it is, tested where it landed as a stream (nothing of the brain's size is
# written), its head the one tidy wrote beside it (<brain>.head; one compressed before tidy wrote
# heads is read through a copy in the image). The live brain, or a copy with a WAL beside it, is
# compacted into the image first (VACUUM INTO reads one transaction).
copy=$SNAP/.brain.db
head=''
if [ "$brain" != "$S/brain.db" ] && [ ! -s "$brain-wal" ] && ln "$brain" "$work/brain.db" 2>/dev/null; then
  read=$work/brain.db
  (set -o pipefail; uncached in "$read" | zstd -q -T0 -10 -c | uncached out "$new/files/brain.db.zst") 2>"$work/zstd.err" ||
    fail "Can't compress the brain: $(why "$work/zstd.err")"
elif [ "$brain" != "$S/brain.db" ] && [ ! -s "$brain-wal" ] && ln "$brain.zst" "$work/brain.db.zst" 2>/dev/null; then
  head=$(cat "$brain.head" 2>/dev/null || true)
  case $head in '' | *[!0-9]*) head='' ;; esac
  (set -o pipefail; uncached in "$work/brain.db.zst" | uncached out "$new/files/brain.db.zst") 2>"$work/cp.err" ||
    fail "Can't copy $brain.zst into the backup image: $(why "$work/cp.err")"
  (set -o pipefail; uncached in "$new/files/brain.db.zst" | zstd -q -t) 2>"$work/zstd.err" ||
    fail "The brain's copy in the backup image is damaged: $(why "$work/zstd.err")"
  if [ -z "$head" ]; then
    (set -o pipefail; uncached in "$work/brain.db.zst" | zstd -q -d -c | uncached out "$copy") 2>"$work/zstd.err" ||
      fail "Can't decompress $brain.zst into the backup image: $(why "$work/zstd.err")"
    read=$copy
  fi
else
  sqlite3 "$brain" "VACUUM INTO '$(sq "$copy")';" 2>"$work/db.err" ||
    fail "Can't copy the brain: $(why "$work/db.err")"
  read=$copy
  (set -o pipefail; uncached in "$copy" | zstd -q -T0 -10 -c | uncached out "$new/files/brain.db.zst") 2>"$work/zstd.err" ||
    fail "Can't compress the brain: $(why "$work/zstd.err")"
fi
# Read as immutable: nothing (no -shm, no WAL) is written beside it.
[ -n "$head" ] || head=$(sqlite3 -readonly "file:$read?immutable=1" "SELECT coalesce(max(seq), 0) FROM events;") ||
  fail "Can't read the brain's copy"
rm -f "$copy" "$work"/brain.db*

# What a restore checks itself against.
{
  echo "label $label"
  echo "release $(basename "$(readlink "$S/current" 2>/dev/null || echo none)")"
  echo "events $head"
  echo "blobs $(find "$new/files/blobs" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  echo "extensions $(ls -1 "$new/files/extensions" 2>/dev/null | tr '\n' ' ')"
  echo "logins $(find "$new/files/logins" -type f 2>/dev/null | wc -l | tr -d ' ')"
  # Files and links as restored: node_modules' unpacked, the brain one file.
  plain=$(find "$new/files" \( -type f -o -type l \) ! -name '.node_modules.*' | wc -l)
  echo "files $((plain + $(awk '{ n += $1 } END { print n + 0 }' "$work/module-files")))"
} >"$new/manifest"
mv "$new" "$SNAP/$name"
# On Linux, the snapshot into the encrypted repository too, as it is, tagged with its name; the
# repository keeps what prune keeps.
if [ "$OS" != Darwin ]; then
  RESTIC_PASSWORD_FILE=$PASSFILE restic -r "$REPO" backup -q --host switch --tag "$name" -- "$SNAP/$name" >/dev/null 2>"$work/restic.err" ||
    fail "Can't put the snapshot in $REPO: $(why "$work/restic.err")"
fi
date +%s >"$S/backup-last"
prune
if [ "$OS" != Darwin ]; then
  # The repository forgets what the folder dropped, and gives back its room weekly.
  RESTIC_PASSWORD_FILE=$PASSFILE restic -r "$REPO" snapshots --json 2>/dev/null |
    python3 -c 'import json, sys
for s in json.load(sys.stdin): print(s["short_id"], (s.get("tags") or [""])[0])' | while read -r id tag; do
    [ -d "$SNAP/$tag" ] || RESTIC_PASSWORD_FILE=$PASSFILE restic -r "$REPO" forget -q "$id" >/dev/null 2>&1 || true
  done
  if [ "$(date +%u)" = 7 ]; then
    RESTIC_PASSWORD_FILE=$PASSFILE restic -r "$REPO" prune -q >/dev/null 2>&1 || say "the repository's prune failed"
  fi
fi
say "$label: $name in $(($(date +%s) - t0)) s, $packed node_modules packed; image $(gb "$(used)") used of its $(gb "$CAP")"
room=$((CAP - $(used)))
done_
# The disk under the image: too little left for the room the image keeps (a fifth of its cap) is a
# failure, for the agent to make room (snapshots aren't dropped for it); less than it would take to
# fill the image, a line in the log.
free=$(host_free)
if [ "$free" -lt $((CAP / 5)) ]; then
  fail "The backup disk is nearly full: $(gb "$free") free on it, the backup image needs up to $(gb "$room") more (cap $(gb "$CAP")): free space on it or lower backupsSize"
elif [ "$free" -lt "$room" ]; then
  say "the backup disk has $(gb "$free") free, less than the $(gb "$room") the image may still grow"
fi
# The second copy, once there is one, pulls within two days.
if [ -f "$S/backup-pulled" ]; then
  age=$((($(date +%s) - $(cat "$S/backup-pulled")) / 3600))
  [ "$age" -lt 48 ] || fail "The second copy of the backups hasn't pulled in $age hours"
fi
