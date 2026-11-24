#!/bin/sh
# Starts the server with matplotlib (comps' chart), which lives in a venv of its own in the extension's home: made the
# first time, and made again when it stops importing. pip says what it does on stderr, the log; stdout stays MCP's.
cd "$(dirname "$0")"
V="${SB_HOME:-$PWD/home}/venv"
if ! "$V/bin/python" -c 'import matplotlib' >/dev/null 2>&1; then
  python3 -m venv --clear "$V" 1>&2 && "$V/bin/pip" install --quiet --disable-pip-version-check 'matplotlib>=3.8,<4' 1>&2
fi
[ -x "$V/bin/python" ] && exec "$V/bin/python" -u main.py
exec python3 -u main.py
