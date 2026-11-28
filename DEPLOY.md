# Deploy

Switch as a service: the core on a server Mac, a host on each workstation reporting to it. Names
in `<angle brackets>` come from local config, never this repo.

| Where | What | Unit | Lives in |
| --- | --- | --- | --- |
| server | the core, port 4871, its own host inside | `ax.switch.core` | `/Applications/Switch Host.app`, `~/.switch` |
| server | the desktop app's update feed: HTTPS on the tailnet, port 8443 (Tailscale Serve), to 127.0.0.1:4880 | `ax.switch.updates` | `~/.switch/updates` |
| workstation | the extension host, reporting to the server | `ax.switch.host` | `/Applications/Switch Host.app` |
| workstation | the desktop app, as `<appId>` | — | `/Applications/Switchboard.app` |

The core can run on a Linux machine instead (an always-on box that does nothing else), the server
Mac still building and signing every release. deploy.json's `core` names it by ssh target
(`user@host`); then:

| Where | What | Unit | Lives in |
| --- | --- | --- | --- |
| core machine (Linux) | the core, port 4871, its own host inside | `switch-core.service` (systemd, as the user; linger on) | `~/.switch/current/switch`, `~/.switch` |
| core machine | both update feeds, ports 8443 and 8446 (Tailscale Serve) | `switch-updates.service`, `switch-updates-gpui.service` | `~/.switch/updates`, `~/.switch/updates-gpui` |
| server (Mac) | the repository, the build, signing and notarizing, the desktop app's lane, a host | `ax.switch.host` | `~/.switch/repo.git`, `~/.switch/releases` |
| server | the old address, forwarded to the core machine (scripts/forward.ts) | `ax.switch.forward` | — |

A ship builds on the server as always, sends the release to the core machine, and that release's
own `ship.sh` runs the canary, the swap and the watch there (`ship.sh canary|unit|swap|units|healthy|after`),
the pressure counted on the server, where the landings are. Its logs are
`~/.local/state/switch/logs`. There, connections' secrets are files in `~/.switch/keychain` (0600,
0700) instead of the Keychain, and the core's gateway key is `~/.switch/core.env` (0600). The core
machine provides `no-turns` in its config.json, so turns stay on the Macs, its logins lent to them.
Its backups are plain snapshots in `<backups>/snapshots` beside an encrypted restic repository,
`<backups>/switch.restic` (passphrase `~/.config/switch/backup.pass`; keep a copy off the box), which
the server pulls onto its backup disk (`backup-pull.sh install <user@core>`, a launchd job on a
Mac), and `restore.sh` reads either. It needs sqlite3, zstd, rsync, restic, ImageMagick, bun, and
`sudo tailscale set --operator=$USER`.

`~/.switch/deploy.json` on the server holds the instance: `server` (its ssh and tailnet name),
`identity` (the Developer ID), `team`, `hostId`, `appId`, `keychain`, `keychainPassFile`,
`notaryKey`, `notaryKeyId`, `notaryIssuer`, `backups` (a folder on the backup disk) and
`backupsSize` (the backup image's cap, default `40g`), and `core` when the core runs on another
machine. On the workstation it holds `server`; on a Linux core machine, `backups` and `backupsSize`.

Backups: every store (the brain, blobs, extensions' folders, every other database, `logins/`, the
keys and the config) goes to an encrypted image, `<backups>/switch.sparsebundle`,
after each deploy (with the brain from before its migration) and nightly at 3:30, as a snapshot in
which an unchanged file is a hard link to the last one. The image's passphrase is in
the login keychain (`ax.switch.backup`); keep a copy off the server. A second machine keeps a copy of
the image, still encrypted: `scripts/backup-pull.sh install <server>` there pulls it hourly with a
key the server's `authorized_keys` limits to `backup.sh serve`. A failure is a surprise for the agent. To put
one back: `sh scripts/restore.sh <new folder> [snapshot]`, which checks what it restored and starts
a canary core on it (see its header).

Deploys: `bun run deploy` on the workstation, or the hook when main moves
(`ln -s ../../scripts/hook.sh .git/hooks/reference-transaction`). Logs: `~/Library/Logs/switch`.
Each host takes the core's release itself as it links (CONCEPTS: Loop); `scripts/install-host.sh`
puts a first one on a machine.

Releases (the dmg anyone can download, and the feed its copies update from): on the core machine,
`sh apps/desktop-gpui/scripts/release.sh <version>` (like `0.1.0`) builds main as Switch.app with
the core inside, signs, notarizes, signs `update.json` with `updateKey`, publishes the commit and
puts all three on GitHub Releases of `releasesRepo` as the latest.

## Rollback

A bad Switch deploy is rolled back by the watch on its own. By hand:
`ssh <server> sh ~/.switch/current/ship.sh rollback <live sha> <earlier sha>`. A brain to go back
to: `~/.switch/backups/<time>-<sha>.db.zst`, one per deploy (the last 3 and a day's newest for 7 days kept), restored with the core stopped, decompressed straight into place (never a clone of a copy: the brain's first write while a clone of it lives holds the file for seconds):
`launchctl bootout gui/$(id -u)/ax.switch.core; zstd -d -f <backup> -o ~/.switch/brain.db; rm -f ~/.switch/brain.db-wal ~/.switch/brain.db-shm; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ax.switch.core.plist`.
