#!/bin/sh
# dev.sh [dx serve args]: runs the app with hot reloading (UI SDK for gpui's, on Subsecond). Saving a
# change to a render (a view's or component's, and the app code it calls) patches it into the
# running app, its state kept. What dx can't patch (a struct's fields, a type's layout, a new
# dependency, build.rs, the kit itself) it rebuilds and relaunches. A debug build, quiet beside the
# live app: SWITCH_GPUI_QUIET=1, so its own data folder and no writes to the core.
set -eu
cd "$(dirname "$0")/.."
# gpui's Subsecond is pinned to this dx: the two must match.
DX_VERSION=0.7.10
DX=$(command -v dx || true)
if [ -z "$DX" ] || [ "$("$DX" --version | awk '{print $2}')" != "$DX_VERSION" ]; then
  # dx's own release build, checked against its published sum.
  BIN="${CARGO_HOME:-$HOME/.cargo}/bin"
  ARCH=$(uname -m | sed 's/arm64/aarch64/')
  TMP=$(mktemp -d)
  URL="https://github.com/DioxusLabs/dioxus/releases/download/v$DX_VERSION/dx-$ARCH-apple-darwin"
  curl -fsSL "$URL.tar.gz" -o "$TMP/dx.tar.gz"
  SUM=$(curl -fsSL "$URL.sha256" | awk '{print $1}')
  [ "$(shasum -a 256 "$TMP/dx.tar.gz" | awk '{print $1}')" = "$SUM" ] || { echo "dx: checksum mismatch" >&2; exit 1; }
  tar -xzf "$TMP/dx.tar.gz" -C "$TMP"
  mkdir -p "$BIN"
  mv "$TMP/dx" "$BIN/dx"
  rm -rf "$TMP"
  DX="$BIN/dx"
fi
export SWITCH_GPUI_QUIET="${SWITCH_GPUI_QUIET:-1}"
exec "$DX" serve --hot-patch --platform macos --features hot-reload "$@"
