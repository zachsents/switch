#!/bin/sh
# mx.sh <shell command>: runs it on $MINI through its macOS spur's exec, which holds Screen
# Recording and Accessibility and may post events. Prints the command's stdout; exits with its code.
# $SPUR names the spur (macos-$MINI unless set); $CORE is the core on that Mac.
set -eu
: "${MINI:?MINI: the Mac to run on (ssh host)}"
SPUR=${SPUR:-macos-$MINI}
CORE=${CORE:-http://127.0.0.1:4871}
body=$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps({"command": sys.stdin.read()}))')
printf '%s' "$body" | ssh "$MINI" "f=\$(mktemp); cat > \$f; curl -s -m ${MX_TIMEOUT:-120} -X POST $CORE/widgets/$SPUR/exec -H 'content-type: text/plain' --data-binary @\$f; rm -f \$f" |
  python3 -c '
import json, sys
d = json.load(sys.stdin)
d = d.get("structuredContent", d)
sys.stdout.write(d.get("stdout", ""))
sys.stderr.write(d.get("stderr", ""))
sys.exit(d.get("code", 1))
'
