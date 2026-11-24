#!/bin/sh
# Installs a machine's extension host over ssh, as Switchboard's move-core.sh and
# install-agent.sh / install-unit.sh do, but apart from Switchboard: its own folder (~/.switch),
# unit (ax.switch.host on a Mac, switch-host on Linux) and log. On a Mac it's the server's live
# signed bundle, /Applications/Switch Host.app; elsewhere a binary built here, ~/.switch/bin/switch,
# beside its provider runtime. It dials out to the core, so it listens on no port. Once installed it
# keeps itself on the core's release (packages/core/src/release.ts), so this is for a first install.
#   scripts/install-host.sh <ssh name> <core url> [what it provides, comma-separated]
#   scripts/install-host.sh mini http://laptop:4871 messages
set -eu
[ $# -ge 2 ] || { echo "usage: $0 <ssh name> <core url> [provides,...]" >&2; exit 1; }
host=$1 core=$2 provides=${3:-}
root=$(cd "$(dirname "$0")/.." && pwd)

os=$(ssh "$host" uname -s)
arch=$(ssh "$host" uname -m)
case "$os-$arch" in
  Darwin-arm64) target=bun-darwin-arm64 ;;
  Linux-x86_64) target=bun-linux-x64 ;;
  Linux-aarch64) target=bun-linux-arm64 ;;
  *) echo "No build for $os $arch" >&2; exit 1 ;;
esac
if [ "$os" = Darwin ]; then
  # The bundle signed by the server's ship, staged beside the one it replaces.
  server=${SWITCH_SERVER:-$(plutil -extract server raw -o - ~/.switch/deploy.json 2>/dev/null || true)}
  [ -n "$server" ] || { echo "No server: set SWITCH_SERVER or server in ~/.switch/deploy.json" >&2; exit 1; }
  live=$(ssh "$server" 'basename "$(readlink ~/.switch/current)"')
  ssh "$host" 'rm -rf "/Applications/Switch Host.app.new" && mkdir -p "/Applications/Switch Host.app.new"'
  ssh "$server" "cd ~/.switch/releases/$live && ditto -c -k --keepParent 'Switch Host.app' -" |
    ssh "$host" 'ditto -x -k - "/Applications/Switch Host.app.new"'
else
  release=$root/dist/host-$target
  (cd "$root" && bun scripts/build-core.ts "$release" "$target")
  binary=$release/switch

  # Renamed into place rather than copied over, so a running copy isn't disturbed. Laid out as the
  # host lays out each release it takes.
  ssh "$host" 'mkdir -p ~/.switch/bin'
  scp -q "$binary" "$host:.switch/bin/switch.new"
  version=$(git -C "$root" rev-parse HEAD)
  ssh "$host" "mkdir -p ~/.switch/bin/provider-runtimes/$version"
  # Without a Mac's extended attributes, which Linux's tar warns of, as scripts/ship.sh packs its builds.
  COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -C "$release" -cf - provider-runtime |
    ssh "$host" "tar -C ~/.switch/bin/provider-runtimes/$version -xf -"
  ssh "$host" "python3 - '$version'" <<'RUNTIME'
import os,sys
base=os.path.expanduser('~/.switch/bin')
link=os.path.join(base,'provider-runtime.new')
if os.path.lexists(link): os.unlink(link)
os.symlink('provider-runtimes/'+sys.argv[1]+'/provider-runtime',link)
os.replace(link,os.path.join(base,'provider-runtime'))
RUNTIME
  ssh "$host" 'mv ~/.switch/bin/switch.new ~/.switch/bin/switch'
fi

# Only `core` and `provides` change in its config; anything else in it stays.
ssh "$host" "python3 - '$core' '$provides'" <<'PY'
import json, os, sys
path = os.path.expanduser("~/.switch/config.json")
config = json.load(open(path)) if os.path.exists(path) else {}
config["core"] = sys.argv[1]
config["provides"] = [p for p in sys.argv[2].split(",") if p]
json.dump(config, open(path, "w"), indent=2)
PY

if [ "$os" = Darwin ]; then
  ssh "$host" 'sh -s' <<'MAC'
set -eu
app="/Applications/Switch Host.app"
label=ax.switch.host
plist=$HOME/Library/LaunchAgents/$label.plist
domain=gui/$(id -u)
# A held Mac still exposes its local extensions, but never advertises agent logins.
host_args=''
[ ! -f "$HOME/.switch/host-hold" ] || host_args='<string>--extensions-only</string>'
mkdir -p "$HOME/Library/Logs/switch" "$HOME/Library/LaunchAgents"
cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$label</string>
<key>ProgramArguments</key><array><string>$app/Contents/MacOS/switch</string><string>host</string>$host_args</array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ExitTimeOut</key><integer>30</integer>
<key>StandardOutPath</key><string>$HOME/Library/Logs/switch/host.log</string>
<key>StandardErrorPath</key><string>$HOME/Library/Logs/switch/host.log</string>
</dict></plist>
PLIST
# bootout only asks the old one to stop; bootstrap once launchd has let it go.
launchctl bootout "$domain/$label" 2>/dev/null || true
for _ in $(seq 60); do
  launchctl print "$domain/$label" >/dev/null 2>&1 || break
  sleep 0.5
done
rm -rf "$app" && mv "$app.new/Switch Host.app" "$app" && rm -rf "$app.new"
launchctl enable "$domain/$label"
launchctl bootstrap "$domain" "$plist"
echo "$label loaded; log in ~/Library/Logs/switch/host.log"
MAC
else
  ssh "$host" 'sh -s' <<'LINUX'
set -eu
unit=switch-host.service
units=$HOME/.config/systemd/user
mkdir -p "$units"
cat > "$units/$unit" <<UNIT
[Unit]
Description=Switch: extension host
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=%h/.switch/bin/switch host
Restart=always
RestartSec=2
KillMode=mixed

[Install]
WantedBy=default.target
UNIT
# Without lingering, user services stop when the last ssh session ends.
if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != yes ]; then
  loginctl enable-linger "$(id -un)"
fi
systemctl --user daemon-reload
systemctl --user enable "$unit" 2>/dev/null
systemctl --user restart "$unit"
echo "$unit running; log: journalctl --user -u $unit"
LINUX
fi
