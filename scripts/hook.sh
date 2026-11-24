#!/bin/sh
# Git's reference-transaction hook for a checkout of Switch, and for the server's ~/.switch/repo.git:
# when main moves (a landing, from any worktree, or a push), deploys it in the background with main's
# own scripts/deploy.sh. It never slows the git command.
#   ln -sf "$PWD/scripts/hook.sh" "$(git rev-parse --git-common-dir)/hooks/reference-transaction"
# On the server, every scripts/ship.sh installs it in ~/.switch/repo.git (a ship without it fails).
[ "$1" = committed ] || exit 0
grep -q ' refs/heads/main$' || exit 0
repo=$(git rev-parse --path-format=absolute --git-common-dir)
log=$HOME/Library/Logs/switch/deploy.log
mkdir -p "$(dirname "$log")"
script=$(mktemp -t switch-deploy)
git --git-dir="$repo" show main:scripts/deploy.sh > "$script" 2>/dev/null || exit 0
echo "[hook $(date '+%F %T')] main is $(git --git-dir="$repo" rev-parse --short main)" >> "$log"
# A session of its own: a landing from an agent's turn on the server outlives the core the ship stops.
# Without the turn's marks: the deploy is Switch's, not the turn's, so the sweep that stops what an
# ended work left (the macOS extension's strays) and the runaway stopper leave it be.
(cd "$repo" && GIT_DIR=$repo nohup env -u SWITCH_WORK -u SWITCH_EXTENSION perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' sh "$script" main >> "$log" 2>&1 </dev/null; rm -f "$script") &
exit 0
