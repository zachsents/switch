#!/bin/sh
# The second copy of the backups, on another machine: it pulls the encrypted image backup.sh keeps
# on the core's machine, so they outlive the loss of either. Everything in it (keys, logins) stays
# encrypted; this machine never has the passphrase.
#   backup-pull.sh install <ssh target> [folder]   once, here: a key (folder/id), its line for the
#                                                  core's machine's authorized_keys, and an hourly
#                                                  timer (systemd, as this user; on a Mac, launchd)
#   backup-pull.sh <ssh target> [folder]           a pull
#   … [folder] <remote folder>                     through an ssh that takes any command (Tailscale
#                                                  SSH, which keys can't restrict): the backups'
#                                                  folder there, read as it is
# The core's machine lets the key do nothing but this (backup.sh serve). What it pulls is the image
# there: a Mac core's switch.sparsebundle, or a Linux core's restic repository, switch.restic.
# A sparsebundle pull that brought anything is a version, folder/<time>/switch.sparsebundle, each
# band unchanged since the last a hard link to it; the newest 7 are kept. A repository is versioned
# inside, its files only ever added or removed, so it's pulled as it is, into folder/switch.restic,
# onto any disk (one without hard links, too). Then it says so to the core's machine, whose backups
# fail (a surprise for its agent) once the last pull is two days old.
# To restore: SWITCH_BACKUPS=<the folder holding the image or the version> sh scripts/restore.sh
# <new folder> (a sparsebundle on a Mac; a repository wherever restic is, with its passphrase).
set -eu
if [ "${1:-}" = install ]; then
  from=${2:?usage: backup-pull.sh install <ssh target> [folder]}
  to=${3:-$HOME/switch-backups}
  remote=${4:-}
  mkdir -p "$to"
  cp "$0" "$to/pull.sh"
  [ -f "$to/id" ] || ssh-keygen -q -t ed25519 -N '' -C switch-backup-pull -f "$to/id"
  if [ "$(uname -s)" = Darwin ]; then
    # launchd may not run a script off another disk (Operation not permitted): it runs this one's
    # copy in ~/.switch, the folder its argument.
    cp "$0" "$HOME/.switch/backup-pull.sh"
    plist=$HOME/Library/LaunchAgents/ax.switch.backup-pull.plist
    mkdir -p "$HOME/Library/Logs/switch"
    cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>ax.switch.backup-pull</string>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>$HOME/.switch/backup-pull.sh</string><string>$from</string><string>$to</string>${remote:+<string>$remote</string>}</array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>StartInterval</key><integer>3600</integer>
<key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Background</string>
<key>LowPriorityIO</key><true/>
<key>StandardOutPath</key><string>$HOME/Library/Logs/switch/backup-pull.log</string>
<key>StandardErrorPath</key><string>$HOME/Library/Logs/switch/backup-pull.log</string>
</dict></plist>
EOF
    launchctl bootout "gui/$(id -u)/ax.switch.backup-pull" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
  else
    mkdir -p "$HOME/.config/systemd/user"
    cat >"$HOME/.config/systemd/user/switch-backup-pull.service" <<EOF
[Unit]
Description=Pull Switch's backups

[Service]
Type=oneshot
Nice=19
IOSchedulingClass=idle
ExecStart=/bin/sh $to/pull.sh $from $to $remote
EOF
    cat >"$HOME/.config/systemd/user/switch-backup-pull.timer" <<'EOF'
[Unit]
Description=Pull Switch's backups hourly

[Timer]
OnCalendar=hourly
RandomizedDelaySec=300
Persistent=true

[Install]
WantedBy=timers.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now switch-backup-pull.timer
  fi
  echo "On the core's machine, add to ~/.ssh/authorized_keys:"
  echo "command=\"/bin/sh \$HOME/.switch/current/backup.sh serve\",restrict $(cat "$to/id.pub")"
  exit 0
fi

from=${1:?usage: backup-pull.sh <ssh target> [folder]}
to=${2:-$HOME/switch-backups}
remote=${3:-}
cd "$to"
# By its name in the folder (cd above): a folder with a space in its path would split the command.
ssh="ssh -i ./id -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
# Unrestricted: the folder by its path, and the pull said by writing its time there.
if [ -n "$remote" ]; then
  mkdir -p "$to/switch.restic"
  rsync -rt --delete -e "ssh -o BatchMode=yes" "$from:$remote/switch.restic/" "$to/switch.restic/"
  ssh -o BatchMode=yes "$from" 'date +%s > ~/.switch/backup-pulled'
  exit 0
fi
# A folder on a disk that isn't mounted would land on the system disk instead.
case $to in
  /Volumes/*) [ -d "/Volumes/$(echo "${to#/Volumes/}" | cut -d/ -f1)" ] || { echo "The backup disk isn't mounted" >&2; exit 1; } ;;
esac
# Which image the core's machine keeps: its repository when it has one (a pull of one it hasn't
# fails, leaving nothing here), else its sparsebundle.
mkdir -p "$to/switch.restic"
if rsync -rt --delete -e "$ssh" "$from:switch.restic/" "$to/switch.restic/" 2>/dev/null; then
  $ssh "$from" pulled
  exit 0
fi
[ -f "$to/switch.restic/config" ] && { echo "The repository's pull failed" >&2; exit 1; }
rmdir "$to/switch.restic" 2>/dev/null || true
versions() { ls -1 "$to" | grep -E '^[0-9]{8}-[0-9]{6}$' | sort; }
prev=$(versions | tail -1)
rm -rf "$to/.partial"
mkdir -p "$to/.partial"
link=''
[ -z "$prev" ] || link=--link-dest=$to/$prev/switch.sparsebundle
# shellcheck disable=SC2086
rsync -a --delete -i -e "$ssh" $link "$from:switch.sparsebundle/" "$to/.partial/switch.sparsebundle/" >"$to/.changes"
if [ -n "$prev" ] && ! grep -qv '^cd' "$to/.changes"; then
  rm -rf "$to/.partial"
else
  mv "$to/.partial" "$to/$(date +%Y%m%d-%H%M%S)"
fi
rm -f "$to/.changes"
versions | sort -r | tail -n +8 | while read -r v; do rm -rf "${to:?}/$v"; done
$ssh "$from" pulled
