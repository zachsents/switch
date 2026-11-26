#!/bin/sh
# Takes a pull request on the public repo into this one: its change as one commit crediting its
# author, on a branch of its own (pr-<n>) in a worktree beside this checkout. Land it as any other
# change; publish.sh then credits them on the public commit and closes the pull request.
#   sh scripts/take.sh <number>
set -eu
cd "$(dirname "$0")/.."
public=${SWITCH_PUBLIC:-https://github.com/zachsents/switch.git}
repo=$(printf '%s' "$public" | sed -E 's#^https://github.com/##; s#\.git$##')
n=${1:?usage: take.sh <pull request number>}
git fetch -q "$public" "+refs/pull/$n/head:refs/public/pr-$n" "+refs/heads/main:refs/public/main"
base=$(git merge-base refs/public/main "refs/public/pr-$n")
title=$(gh pr view "$n" -R "$repo" --json title --jq .title)
login=$(gh pr view "$n" -R "$repo" --json author --jq .author.login)
id=$(gh api "users/$login" --jq .id)
name=$(gh api "users/$login" --jq '.name // .login')
email="$id+$login@users.noreply.github.com"
tree=${SWITCH_WORKTREES:-$(dirname "$PWD")}/pr-$n
git worktree add -q "$tree" -b "pr-$n" main
msg=$(printf '%s\n\nPublic-PR: %s\nCo-authored-by: %s <%s>' "$title" "$n" "$name" "$email")
if ! git diff --binary "$base" "refs/public/pr-$n" | git -C "$tree" apply -3 --index; then
  printf 'Conflicts in %s: settle them, then commit as %s with\n\n%s\n' "$tree" "$name <$email>" "$msg" >&2
  exit 1
fi
printf '%s\n' "$msg" | git -C "$tree" commit -q --author "$name <$email>" -F -
echo "$tree"
