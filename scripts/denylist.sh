#!/bin/sh
# Fails when the repo names anything on this machine's denylist: ~/.switch/denylist (or
# $SWITCH_DENYLIST), one case-insensitive extended regex per line, # for comments. The list is
# data, kept outside the repo; without one, the check passes.
set -eu
list=${SWITCH_DENYLIST:-$HOME/.switch/denylist}
[ -f "$list" ] || exit 0
patterns=$(grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$list" || true)
[ -n "$patterns" ] || exit 0
cd "$(dirname "$0")/.."
if printf '%s\n' "$patterns" | git grep --untracked -n -I -i -E -f - -- ':!*.lock' ; then
  echo "Denylisted in the repo ($list)" >&2
  exit 1
fi
