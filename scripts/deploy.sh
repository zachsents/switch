#!/bin/sh
# `bun run deploy [ref]`, from a workstation: pushes <ref> (main) to the server, the always-on Mac
# that runs the core and the loop (scripts/ship.sh: checks, compile, sign, canary, swap, watch). One
# deploy at a time on the server; a deploy that a newer push overtook while it waited is skipped, so
# landings coalesce. scripts/hook.sh runs this when main moves, on a workstation or in the server's
# own repo.git. Wherever it ran, every machine's host takes the release the core runs as it links to
# it (packages/core/src/release.ts). The server's ssh (and tailnet) name: $SWITCH_SERVER, else
# `server` in ~/.switch/deploy.json.
set -eu
mini=${SWITCH_SERVER:-$(plutil -extract server raw -o - ~/.switch/deploy.json 2>/dev/null || true)}
[ -n "$mini" ] || { echo "No server: set SWITCH_SERVER or server in ~/.switch/deploy.json" >&2; exit 1; }
ref=${1:-main}
repo=$(git rev-parse --path-format=absolute --git-common-dir)
sha=$(git --git-dir="$repo" rev-parse "$ref^{commit}")
t0=$(date +%s)
# On the server itself (a landing in its own repo.git): no push, no ssh.
here=''
[ "$repo" = "$(cd ~/.switch/repo.git 2>/dev/null && pwd -P)" ] && here=1
# Without the hook's git environment, which would point the ship's git at repo.git.
on_server() {
  if [ -n "$here" ]; then
    env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_COMMON_DIR sh -c "$1"
  else
    ssh "$mini" "$1"
  fi
}

# Never backwards: a hook that lost the race to a newer landing finds main ahead and stops. A main
# the server's doesn't contain (a task landed there meanwhile) has diverged: said loudly, since
# nothing of it deploys until server/main is merged in.
if [ -z "$here" ] && ! git --git-dir="$repo" push -q "$mini:.switch/repo.git" "$sha:refs/heads/main" 2>/dev/null; then
  git --git-dir="$repo" fetch -q "$mini:.switch/repo.git" "+refs/heads/main:refs/remotes/server/main"
  if git --git-dir="$repo" merge-base --is-ancestor "$sha" refs/remotes/server/main; then
    echo "[deploy] $sha superseded: the server's main is ahead"
    exit 0
  fi
  echo "[deploy] FAILED: $sha diverged from the server's main ($(git --git-dir="$repo" rev-parse --short refs/remotes/server/main)): merge server/main into main"
  exit 1
fi

# The landing recorded as it reaches the server, for the pressure that pauses running turns
# (ship.sh): each landing that isn't live yet adds to it every minute it waits.
# shellcheck disable=SC2029
on_server "mkdir -p ~/Library/Logs/switch && /usr/bin/lockf -k ~/.switch/landings.lock sh -c 'echo \"\$(date +%s) $sha\" >> ~/.switch/landings' && /usr/bin/lockf -t 3600 ~/.switch/ship.lock sh -c '
  set -e
  [ -d ~/.switch/src ] || git clone -q ~/.switch/repo.git ~/.switch/src
  cd ~/.switch/src
  git fetch -q origin
  if [ \"\$(git rev-parse origin/main)\" != $sha ] && [ \"\$(cat ~/.switch/tripped 2>/dev/null)\" != $sha ]; then echo \"$sha superseded\"; exit 0; fi
  git checkout -q --detach --force $sha
  git clean -qfd
  exec sh scripts/ship.sh $sha
' 2>&1 | tee -a ~/Library/Logs/switch/ship.log"
# The server prints DEPLOYED or FAILED; tee hides ssh's status, so read what it left.
live=$(on_server 'basename "$(readlink ~/.switch/current)"')
if [ "$live" != "$sha" ]; then
  echo "[deploy] $sha not live on $mini (live: $live)"
  exit 1
fi
echo "[deploy] $sha live on $mini, $(($(date +%s) - t0)) s after push"
