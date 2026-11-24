#!/bin/sh
# The second copy of the backups, on another machine: it pulls the encrypted image backup.sh keeps
# on the core's machine, so they outlive the loss of either. Everything in it (keys, logins) stays
# encrypted; this machine never has the passphrase.
#   backup-pull.sh install <ssh target> [folder]   once, here: a key (folder/id), its line for the
#                                                  core's machine's authorized_keys, and an hourly
#                                                  timer (systemd, as this user)
#   backup-pull.sh <ssh target> [folder]           a pull
# The core's machine lets the key do nothing but this (backup.sh serve). Each pull that brought
# anything is a version, folder/<time>/switch.sparsebundle, each band unchanged since the last a
# hard link to it; the newest 7 are kept. Then it says so to the core's machine, whose backups fail
# (a surprise for its agent) once the last pull is two days old.
# To restore: copy a version's switch.sparsebundle to a Mac, then
#   SWITCH_BACKUPS=<the folder holding it> sh scripts/restore.sh <new folder>
set -eu
if [ "${1:-}" = install ]; then
  from=${2:?usage: backup-pull.sh install <ssh target> [folder]}
  to=${3:-$HOME/switch-backups}
  mkdir -p "$to" "$HOME/.config/systemd/user"
  cp "$0" "$to/pull.sh"
  [ -f "$to/id" ] || ssh-keygen -q -t ed25519 -N '' -C switch-backup-pull -f "$to/id"
  cat >"$HOME/.config/systemd/user/switch-backup-pull.service" <<EOF
[Unit]
Description=Pull Switch's backups

[Service]
Type=oneshot
Nice=19
IOSchedulingClass=idle
ExecStart=/bin/sh $to/pull.sh $from $to
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
  echo "On the core's machine, add to ~/.ssh/authorized_keys:"
  echo "command=\"/bin/sh \$HOME/.switch/current/backup.sh serve\",restrict $(cat "$to/id.pub")"
  exit 0
fi

from=${1:?usage: backup-pull.sh <ssh target> [folder]}
to=${2:-$HOME/switch-backups}
cd "$to"
ssh="ssh -i $to/id -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
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
