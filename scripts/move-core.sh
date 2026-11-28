#!/bin/sh
# Moves the core from this Mac (the server, which keeps building, signing and its host) to a Linux
# machine, and back. Run on the server Mac, as the user.
#   move-core.sh check  <user@host>     what's missing there, nothing changed
#   move-core.sh seed   <user@host>     every store but the brain copied there, while the core runs
#                                       (again and again: each copy sends what changed)
#   move-core.sh move   <user@host>     the move: waits for no turn running (30 min at most, then
#                                       pauses them), stops the core here, sends the rest, starts it
#                                       there, puts a host and the old addresses' forward here
#   move-core.sh back   <user@host>     the way back: the core stopped there, its brain and stores
#                                       brought here, the core started here again
# Nothing here is deleted: ~/.switch stays as it was when the core stopped (brain, blobs, logins),
# the way back, until it's removed by hand. Its log: ~/Library/Logs/switch/move.log.
# There: the release live here (its build for that machine, from this one's release), a systemd
# user unit (switch-core.service), the old host there (switch-host.service) stopped for the core's
# own, connections' secrets from this Keychain as files (~/.switch/keychain), each Claude login's
# credentials as its home's .credentials.json, the gateway key in ~/.switch/core.env, and a config
# for a machine that takes no turns. Here: ax.switch.core stopped and kept, ax.switch.host for this
# Mac's extensions and turns, ax.switch.forward for this Mac's old addresses (4871, and 4872 behind
# Funnel), deploy.json's `core`, and backups: the core's pulled hourly onto the backup disk, this
# Mac's own (its extensions' folders and the vault) nightly, as before.
{
set -eu
S=$HOME/.switch
. "$(cd "$(dirname "$0")" && pwd)/os.sh"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
verb=${1:?usage: move-core.sh check|seed|move|back <user@host>}
to=${2:?usage: move-core.sh check|seed|move|back <user@host>}
DOMAIN=gui/$(id -u)
PORT=4871
PAGES=4872
LOG=$LOGS/move.log
mkdir -p "$LOGS"
say() { echo "[move $(date +%H:%M:%S)] $*" | tee -a "$LOG"; }
die() {
  say "FAILED: $*"
  exit 1
}
there() { ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 "$to" "$1"; }
RSYNC=/opt/homebrew/bin/rsync
[ -x "$RSYNC" ] || RSYNC=rsync
t0=$(date +%s)
secs() { echo $(($(date +%s) - $1)); }

# What a copy leaves out: what a deploy rebuilds, what's only this Mac's (its builds, checkouts,
# feeds, browser, iPhone builds, its extensions' folders and the vault, which stay with the host
# here), what lasts only while running, node_modules and the brain (sent on its own).
excludes() {
  for x in /brain.db /brain.db-wal /brain.db-shm /releases/ /current /previous /src/ /app-src/ /release-src/ \
    /gpui-src/ /gpui-target/ /backups/ /canary/ /updates/ /updates.old/ /updates.new/ /updates-gpui/ \
    /updates-gpui.old/ /iphone-builds/ /preview/ /procs/ /repo.git/ /fetch/ /blobs/tmp/ /shots/ /rollback/ \
    /bin/ /host/ /browser/ /deploy.json /deploy.local /config.json /landings /landings.lock /tripped \
    /backup-last /backup-pulled /ax.switch.host.plist.retired /keychain/ /extensions/ /secrets/ /brain.seed.zst \
    /config.json.core /forward.ts /core.env node_modules/ '*.lock' /extensions/*/pkg/; do
    printf -- '--exclude=%s\n' "$x"
  done
}

copy_stores() {
  # shellcheck disable=SC2046
  "$RSYNC" -a --delete $(excludes) -e 'ssh -o BatchMode=yes' "$S/" "$to:.switch/" >>"$LOG" 2>&1
}

live=$(basename "$(readlink "$S/current" 2>/dev/null || echo none)")
name=$(there 'tailscale status --self --json' | python3 -c 'import json, sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))') ||
  die "Can't reach $to, or it isn't on the tailnet"
short=${name%%.*}

check() {
  bad=0
  for c in sqlite3 zstd rsync restic python3 curl flock systemd-run tailscale; do
    there "command -v $c >/dev/null" || { say "missing there: $c"; bad=1; }
  done
  there '[ -x ~/.bun/bin/bun ] || command -v bun >/dev/null' || { say "missing there: bun"; bad=1; }
  there 'command -v magick >/dev/null || command -v convert >/dev/null' || say "missing there: ImageMagick (attached pictures go unscaled)"
  there 'loginctl show-user "$(id -un)" -p Linger | grep -q yes' || { say "there: linger is off (sudo loginctl enable-linger \$USER)"; bad=1; }
  there 'tailscale serve status >/dev/null 2>&1' || { say "there: Tailscale Serve needs this user as operator (sudo tailscale set --operator=\$USER)"; bad=1; }
  [ -f "$S/releases/$live/host-linux-x64.tar.gz" ] || { say "no Linux build in the live release $live"; bad=1; }
  free=$(there 'df -k ~ | awk "NR==2 { print \$4 }"')
  need=$(($(du -sk "$S/blobs" "$S/logins" "$S/extensions" 2>/dev/null | awk '{ s += $1 } END { print s }') + $(size "$S/brain.db") / 1024 * 3))
  [ "$free" -gt "$need" ] || { say "there: $((free / 1048576)) GB free, about $((need / 1048576)) GB needed"; bad=1; }
  say "$to ($name): $(there 'uname -sr'), $((free / 1048576)) GB free; live release $live"
  link=$(there "cat /sys/class/net/e*/carrier 2>/dev/null | grep -c 1 || true")
  [ "${link:-0}" -gt 0 ] || say "there: no cable (every call between this Mac and the core crosses Wi-Fi)"
  return $bad
}

# The live release there: its Linux build, unpacked beside this release's scripts.
release_there() {
  rel=$S/releases/$live
  there "mkdir -p ~/.switch/releases/$live"
  "$RSYNC" -a -e 'ssh -o BatchMode=yes' "$rel/host-linux-x64.tar.gz" "$rel/host-linux-x64.tar.gz.sha256" "$to:.switch/releases/$live/"
  for f in host-*.zip host-*.tar.gz host-*.tar.gz.sha256 health.ts backup.sh stores-before proven; do
    [ ! -e "$rel/$f" ] || "$RSYNC" -a -e 'ssh -o BatchMode=yes' "$rel"/$f "$to:.switch/releases/$live/" 2>/dev/null || true
  done
  # This checkout's scripts, which have the Linux paths, until a deploy sends its own.
  scp -q "$(dirname "$0")/ship.sh" "$(dirname "$0")/os.sh" "$(dirname "$0")/backup.sh" "$(dirname "$0")/health.ts" "$to:.switch/releases/$live/"
  there "cd ~/.switch/releases/$live && tar -xzf host-linux-x64.tar.gz && [ -x switch ]" || die "the Linux build of $live didn't unpack there"
}

# Connections' secrets, from this Keychain to files there, as connections.ts keeps them on Linux.
secrets_there() {
  python3 - "$to" <<'PY'
import re, subprocess, sys
to = sys.argv[1]
dump = subprocess.run(["security", "dump-keychain"], capture_output=True, text=True).stdout
accounts = set()
for block in dump.split("keychain: "):
    s = re.search(r'"svce"<blob>="([^"]*)"', block)
    a = re.search(r'"acct"<blob>="([^"]*)"', block)
    if s and a and s.group(1) == "switch-connections":
        accounts.add(a.group(1))
service = "switch-connections".encode().hex()
lines = []
for acct in sorted(accounts):
    r = subprocess.run(["security", "find-generic-password", "-s", "switch-connections", "-a", acct, "-w"], capture_output=True, text=True)
    if r.returncode != 0 or r.stdout.strip() == "":
        continue
    lines.append(acct.encode().hex() + " " + r.stdout.strip().encode().hex())
script = (
    "set -e; umask 077; d=~/.switch/keychain/" + service + "; mkdir -p \"$d\"; chmod 700 ~/.switch/keychain;"
    " while read -r a v; do printf %s \"$v\" | xxd -r -p > \"$d/$a.tmp\" && mv \"$d/$a.tmp\" \"$d/$a\"; done"
)
subprocess.run(["ssh", "-o", "BatchMode=yes", to, script], input="\n".join(lines) + "\n", text=True, check=True)
print(len(lines))
PY
}

# Each Claude login's credentials, from its Keychain item to its home's .credentials.json there.
logins_there() {
  python3 - "$to" "$S" <<'PY'
import hashlib, os, subprocess, sys
to, S = sys.argv[1], sys.argv[2]
root = os.path.join(S, "logins", "claude")
n = 0
for name in sorted(os.listdir(root)) if os.path.isdir(root) else []:
    home = os.path.join(root, name)
    service = "Claude Code-credentials-" + hashlib.sha256(home.encode()).hexdigest()[:8]
    r = subprocess.run(["security", "find-generic-password", "-a", os.environ["USER"], "-s", service, "-w"], capture_output=True, text=True)
    if r.returncode != 0 or r.stdout.strip() == "":
        continue
    script = "set -e; umask 077; f=~/.switch/logins/claude/" + name + "/.credentials.json; cat > \"$f.tmp\" && mv \"$f.tmp\" \"$f\""
    subprocess.run(["ssh", "-o", "BatchMode=yes", to, script], input=r.stdout.strip(), text=True, check=True)
    n += 1
print(n)
PY
}

# The core's config there: this one's, as a core that takes no turns, its pages still published
# at this Mac's address (forwarded).
config_there() {
  python3 - "$S/config.json" <<'PY' | there 'umask 077; cat > ~/.switch/config.json.new && mv ~/.switch/config.json.new ~/.switch/config.json'
import json, sys
c = json.load(open(sys.argv[1]))
c.pop("core", None)
c.pop("machine", None)
c["host"] = "0.0.0.0"
c["port"] = 4871
c["provides"] = ["no-turns"]
print(json.dumps(c, indent=2))
PY
  key=$(zsh -lc 'printf %s "${AI_GATEWAY_API_KEY:-}"')
  [ -z "$key" ] || printf 'AI_GATEWAY_API_KEY=%s\n' "$key" | there 'umask 077; cat > ~/.switch/core.env'
  key=''
  there "[ -f ~/.switch/deploy.json ] || printf '{\"backups\": \"%s\", \"backupsSize\": \"60g\"}\n' \"\$HOME/backups\" > ~/.switch/deploy.json"
}

forward_here() {
  plist=$HOME/Library/LaunchAgents/ax.switch.forward.plist
  cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>ax.switch.forward</string>
<key>ProgramArguments</key><array><string>$HOME/.bun/bin/bun</string><string>$S/forward.ts</string><string>$name</string><string>0.0.0.0:$PORT=$PORT</string><string>127.0.0.1:$PAGES=$PAGES</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$LOGS/forward.log</string>
<key>StandardErrorPath</key><string>$LOGS/forward.log</string>
</dict></plist>
PLIST
  cp "$(dirname "$0")/forward.ts" "$S/forward.ts"
  launchctl bootout "$DOMAIN/ax.switch.forward" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$plist"
}

host_here() {
  python3 - "$S/config.json" "http://$name:$PORT" <<'PY'
import json, sys
p, core = sys.argv[1], sys.argv[2]
c = json.load(open(p))
for k in ("host", "port", "pages"):
    c.pop(k, None)
c["core"] = core
json.dump(c, open(p + ".new", "w"), indent=2)
PY
  mv "$S/config.json.new" "$S/config.json"
  plist=$HOME/Library/LaunchAgents/ax.switch.host.plist
  cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>ax.switch.host</string>
<key>ProgramArguments</key><array><string>/Applications/Switch Host.app/Contents/MacOS/switch</string><string>host</string></array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ProcessType</key><string>Interactive</string>
<key>SoftResourceLimits</key><dict><key>NumberOfFiles</key><integer>16384</integer></dict>
<key>ExitTimeOut</key><integer>30</integer>
<key>StandardOutPath</key><string>$LOGS/host.log</string>
<key>StandardErrorPath</key><string>$LOGS/host.log</string>
</dict></plist>
PLIST
  : >"$LOGS/host.log.move"
  launchctl bootout "$DOMAIN/ax.switch.host" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$plist"
}

# The host here pairs with the moved core: its code approved there, as `switch approve` does.
pair_here() {
  for _ in $(seq 90); do
    code=$(grep -o 'approve [A-Z0-9-]*' "$LOGS/host.log" 2>/dev/null | tail -1 | cut -d' ' -f2)
    [ -z "$code" ] || break
    grep -q 'Paired\|linked' "$LOGS/host.log" 2>/dev/null && return 0
    sleep 2
  done
  [ -n "$code" ] || { say "the host here asked no pairing (paired already?)"; return 0; }
  there "SWITCH_DIR=\$HOME/.switch ~/.switch/current/switch approve $code" >>"$LOG" 2>&1 && say "host here paired ($code)"
}

running_turns() {
  sqlite3 -readonly "$S/brain.db" "SELECT count(*) FROM threads WHERE status = 'running';" 2>/dev/null || echo 0
}

move() {
  check || die "fix what's missing there first"
  say "seeding $to"
  t=$(date +%s)
  copy_stores || die "the stores didn't copy"
  release_there
  seed_brain
  say "seeded in $(secs "$t") s"
  # A quiet moment: no turn running, for 30 minutes at most; then they're paused for the move.
  t=$(date +%s)
  while [ "$(running_turns)" -gt 0 ] && [ "$(secs "$t")" -lt 1800 ]; do sleep 15; done
  say "turns running at the stop: $(running_turns) (waited $(secs "$t") s)"
  # The brain caught up while the core still runs (a torn copy, only the base the stopped send
  # diffs against), so that send carries seconds of writes, not the hours since the seed.
  t=$(date +%s)
  "$RSYNC" -a --inplace --no-whole-file -e 'ssh -o BatchMode=yes' "$S/brain.db" "$to:.switch/brain.db" >>"$LOG" 2>&1 || say "the brain's catch-up didn't copy; the stopped send carries it all"
  say "brain caught up there in $(secs "$t") s"
  stop=$(date +%s)
  paused=$(curl -sf -m 60 -X POST "http://127.0.0.1:$PORT/pause" || true)
  say "core stopping here (${paused:-0} turns paused)"
  cp "$S/config.json" "$S/config.json.core"
  launchctl bootout "$DOMAIN/ax.switch.core" 2>/dev/null || true
  for _ in $(seq 160); do launchctl print "$DOMAIN/ax.switch.core" >/dev/null 2>&1 || break; sleep 0.25; done
  launchctl disable "$DOMAIN/ax.switch.core"
  sqlite3 -cmd ".timeout 10000" "$S/brain.db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null || die "the brain didn't checkpoint"
  head=$(sqlite3 -readonly "$S/brain.db" "SELECT coalesce(max(seq), 0) FROM events;")
  # The brain at rest, sent: only what changed since the catch-up.
  t=$(date +%s)
  "$RSYNC" -a --inplace --no-whole-file -e 'ssh -o BatchMode=yes' "$S/brain.db" "$to:.switch/brain.db" >>"$LOG" 2>&1 || die "the brain didn't copy"
  there 'rm -f ~/.switch/brain.db-wal ~/.switch/brain.db-shm'
  say "brain sent in $(secs "$t") s"
  t=$(date +%s)
  copy_stores || die "the stores didn't copy"
  n=$(secrets_there) || die "connections' secrets didn't copy"
  l=$(logins_there) || die "the logins' credentials didn't copy"
  config_there
  say "stores sent in $(secs "$t") s: $n connection secrets, $l logins"
  [ "$(there "sqlite3 -readonly ~/.switch/brain.db 'SELECT coalesce(max(seq), 0) FROM events;'")" = "$head" ] || die "the brain there isn't the one here"
  t=$(date +%s)
  there "systemctl --user disable --now switch-host.service 2>/dev/null; ln -sfn ~/.switch/releases/$live ~/.switch/current && sh ~/.switch/current/ship.sh unit && ~/.switch/current/switch prepare >/dev/null 2>&1; systemctl --user start switch-core.service && sh ~/.switch/current/ship.sh healthy 90" >>"$LOG" 2>&1 ||
    die "the core there isn't healthy (move-core.sh back $to)"
  say "core serving there $(secs "$t") s after the send; down $(secs "$stop") s in all"
  there "tailscale serve --bg --tcp=$PAGES tcp://127.0.0.1:$PAGES >/dev/null; sh ~/.switch/current/ship.sh units" >>"$LOG" 2>&1 || say "the feeds or the pages' port there didn't start"
  forward_here
  host_here
  pair_here
  # deploy.json: the core is there now.
  python3 - "$S/deploy.json" "$to" <<'PY'
import json, sys
p = sys.argv[1]
c = json.load(open(p))
c["core"] = sys.argv[2]
json.dump(c, open(p + ".new", "w"))
PY
  mv "$S/deploy.json.new" "$S/deploy.json"
  # The brain it stopped with, kept here compressed as the last backup before the move (backups/):
  # made once the core serves there, out of the stop (brain.db itself stays as it was, the way back).
  b=$S/backups/$(date +%Y%m%d-%H%M%S)-moved.db
  (set -o pipefail; uncached in "$S/brain.db" | zstd -q -T0 -3 -c | uncached out "$b.zst") || die "the brain's last backup here failed (the core serves there)"
  echo "$head" >"$b.head"
  backups_here "$b"
  say "moved: the core runs on $to ($name) since $(date +%H:%M); this Mac's stores stay as they were, the way back"
}

# Backups once the core is there: its own (there, nightly) pulled hourly onto this Mac's backup
# disk, beside its image; and this Mac's own stores (its extensions' folders, the vault), nightly
# into its image as before, the brain in them the one it stopped with (cheap: a compressed copy).
backups_here() {
  dest=$(conf backups)
  case $dest in "~/"*) dest=$HOME/${dest#\~/} ;; esac
  [ -n "$dest" ] || { say "no backups folder in deploy.json: the core's backups aren't pulled here"; return 0; }
  sh "$(dirname "$0")/backup-pull.sh" install "$to" "$(dirname "$dest")/backups-$short" backups >>"$LOG" 2>&1 ||
    say "the pull of the core's backups didn't install"
  plist=$HOME/Library/LaunchAgents/ax.switch.backup-host.plist
  cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>ax.switch.backup-host</string>
<key>ProgramArguments</key><array><string>/usr/bin/lockf</string><string>-t</string><string>3600</string><string>$S/backup.lock</string><string>/usr/sbin/taskpolicy</string><string>-b</string><string>/bin/sh</string><string>$S/current/backup.sh</string><string>host</string><string>$1</string></array>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>45</integer></dict>
<key>StandardOutPath</key><string>$LOGS/backup-host.log</string>
<key>StandardErrorPath</key><string>$LOGS/backup-host.log</string>
</dict></plist>
PLIST
  launchctl bootout "$DOMAIN/ax.switch.backup-host" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$plist"
}

back() {
  stop=$(date +%s)
  there "curl -sf -m 60 -X POST http://127.0.0.1:$PORT/pause >/dev/null; systemctl --user disable --now switch-core.service; sqlite3 -cmd '.timeout 10000' ~/.switch/brain.db 'PRAGMA wal_checkpoint(TRUNCATE);'" >>"$LOG" 2>&1 || true
  for job in ax.switch.forward ax.switch.host ax.switch.backup-host ax.switch.backup-pull; do
    launchctl bootout "$DOMAIN/$job" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/$job.plist"
  done
  # What the core did there comes back: the brain and the stores it wrote.
  "$RSYNC" -a --inplace --no-whole-file -e 'ssh -o BatchMode=yes' "$to:.switch/brain.db" "$S/brain.db" >>"$LOG" 2>&1 || die "the brain didn't come back"
  rm -f "$S/brain.db-wal" "$S/brain.db-shm"
  # shellcheck disable=SC2046
  "$RSYNC" -a $(excludes) --exclude=/logins/ -e 'ssh -o BatchMode=yes' "$to:.switch/" "$S/" >>"$LOG" 2>&1 || say "some stores didn't come back"
  [ ! -f "$S/config.json.core" ] || cp "$S/config.json.core" "$S/config.json"
  python3 - "$S/deploy.json" <<'PY'
import json, sys
p = sys.argv[1]
c = json.load(open(p))
c.pop("core", None)
json.dump(c, open(p + ".new", "w"))
PY
  mv "$S/deploy.json.new" "$S/deploy.json"
  launchctl enable "$DOMAIN/ax.switch.core"
  launchctl bootstrap "$DOMAIN" "$HOME/Library/LaunchAgents/ax.switch.core.plist"
  there "systemctl --user enable --now switch-host.service" >>"$LOG" 2>&1 || true
  sh "$S/current/ship.sh" healthy 90 >/dev/null 2>&1 || die "the core here isn't healthy"
  say "back: the core runs here again, down $(secs "$stop") s"
}

# The brain's newest copy at rest (the last deploy's backup) there, so the move sends only what
# changed since; never over a core's brain there.
seed_brain() {
  there '! systemctl --user is-active -q switch-core.service' || return 0
  b=$(ls -1 "$S/backups" | grep -E -- '-[0-9a-f]{40}\.db\.zst$' | sort | tail -1)
  [ -n "$b" ] || return 0
  "$RSYNC" -a -e 'ssh -o BatchMode=yes' "$S/backups/$b" "$to:.switch/brain.seed.zst" >>"$LOG" 2>&1 &&
    there 'zstd -q -d -f ~/.switch/brain.seed.zst -o ~/.switch/brain.db && rm -f ~/.switch/brain.db-wal ~/.switch/brain.db-shm' &&
    say "brain seeded from $b"
}

case $verb in
  check) check && say "ready" ;;
  seed) t=$(date +%s); copy_stores && release_there && seed_brain && say "seeded in $(secs "$t") s" ;;
  move) move ;;
  back) back ;;
  *) echo "usage: move-core.sh check|seed|move|back <user@host>" >&2; exit 2 ;;
esac
exit
}
