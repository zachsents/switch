#!/bin/sh
# Publishes a commit of this repo (default main) to the public repo as one commit on top of the last
# published one: its tree, and its subjects since then. The full history and its messages stay
# here. Refuses a tree gitleaks or the denylist (scripts/denylist.sh) flags, and drops a subject
# the denylist matches. Credits who a pull request came from (scripts/take.sh) and closes it.
#   sh scripts/publish.sh [ref]
set -eu
cd "$(dirname "$0")/.."
public=${SWITCH_PUBLIC:-https://github.com/zachsents/switch.git}
repo=$(printf '%s' "$public" | sed -E 's#^https://github.com/##; s#\.git$##')
sha=$(git rev-parse "${1:-main}^{commit}")
list=${SWITCH_DENYLIST:-$HOME/.switch/denylist}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$list" >"$tmp/deny" 2>/dev/null || true
[ -s "$tmp/deny" ] || { echo "No denylist at $list" >&2; exit 1; }
mkdir "$tmp/tree"
git archive "$sha" | tar -x -C "$tmp/tree"
(cd "$tmp/tree" && gitleaks dir --no-banner --log-level error .) || { echo "gitleaks flagged $sha" >&2; exit 1; }
if grep -r -n -I -i -E -f "$tmp/deny" --exclude='*.lock' "$tmp/tree"; then
  echo "Denylisted in $sha ($list)" >&2
  exit 1
fi

email=11147616+zachsents@users.noreply.github.com
export GIT_AUTHOR_NAME=zachsents GIT_COMMITTER_NAME=zachsents GIT_AUTHOR_EMAIL=$email GIT_COMMITTER_EMAIL=$email
parent=$(git ls-remote "$public" refs/heads/main | cut -f1)
if [ -z "$parent" ]; then
  commit=$(printf 'Switch\n\nSource: %s\n' "$sha" | git commit-tree "$sha^{tree}")
else
  git fetch -q "$public" main
  last=$(git log -1 --format=%B FETCH_HEAD | sed -n 's/^Source: //p')
  git log --no-merges --format=%s "$last..$sha" | grep -v -i -E -f "$tmp/deny" >"$tmp/msg" || echo Switch >"$tmp/msg"
  printf '\nSource: %s\n' "$sha" >>"$tmp/msg"
  git log --no-merges --format='%(trailers:key=Co-authored-by,valueonly)' "$last..$sha" |
    grep -v -i -e '^[[:space:]]*$' -e '@anthropic\.com' | grep -v -i -E -f "$tmp/deny" | sort -u |
    sed 's/^/Co-authored-by: /' >>"$tmp/msg" || true
  prs=$(git log --no-merges --format='%(trailers:key=Public-PR,valueonly)' "$last..$sha" | grep -E '^[0-9]+$' | sort -un || true)
  commit=$(git commit-tree "$sha^{tree}" -p "$parent" -F "$tmp/msg")
fi
git push -q "$public" "$commit:refs/heads/main"
for n in ${prs:-}; do gh pr close "$n" -R "$repo" -c "Landed in $commit." >/dev/null || true; done
echo "$commit"
