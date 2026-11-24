#!/bin/sh
# test-app.sh [build | size WxH[+X+Y] | launch | quit | rec]: a test copy of this worktree's app on
# $MINI, beside the live one ("Switchboard Test", its own id), in ~/Applications, run quiet
# (SWITCH_QUIET=1: no desktop spur, no reports, its own token minted on loopback; SWITCH_VIEW_PORT
# keeps its own origin, so what it keeps across launches stays, as the live app's does).
#   build (default)   rsync, bun install, build, install, relaunch; re-run after each change
#   size 1000x640     sizes the test window in points, at +0+0 unless given (1240x800, 1600x1000)
#   launch / quit     (re)launches or quits it; FRAME=1000x640+0+0 launches it at that frame
#   rec               rebuilds the recorder (record/rec.swift) only
# The live app and who opens switchboard:// are left alone: links go to the test copy by its id.
set -eu
: "${MINI:?MINI: the Mac to build and run on (ssh host)}"
NAME=${SWITCH_APP_NAME:-Switchboard Test}
ID=${SWITCH_APP_ID:-switch.ui2.test}
SCRATCH=${TEST_SCRATCH:-switch-test}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)

remote() {
  ssh "$MINI" "export PATH=\$HOME/.bun/bin:/opt/homebrew/bin:\$PATH NAME='$NAME' ID='$ID' S=\$HOME/$SCRATCH; $1"
}

# The recorder, built where it runs; the spur's exec runs it, holding Screen Recording and Accessibility.
build_rec() {
  remote 'mkdir -p "$S/rec"'
  scp -q "$HERE/record/rec.swift" "$MINI:$SCRATCH/rec/rec.swift"
  remote 'cd "$S/rec" && { [ rec -nt rec.swift ] || xcrun swiftc -O -swift-version 5 -parse-as-library -target arm64-apple-macos15.0 -o rec rec.swift; }'
}

rec() {
  sh "$HERE/record/mx.sh" "\$HOME/$SCRATCH/rec/rec $*"
}

quit_app() {
  remote 'pkill -f "$HOME/Applications/$NAME.app/Contents/MacOS/" || true; sleep 0.5'
}

launch() {
  quit_app
  # $FRAME (WxH+X+Y) is the window's first frame (SWITCH_FRAME), for a journey's size.
  remote "open --env SWITCH_QUIET=1 --env SWITCH_VIEW_PORT=4889 ${FRAME:+--env SWITCH_FRAME=$FRAME} -a \"\$HOME/Applications/\$NAME.app\""
  # Until its window is up (rec waits up to 10 s for it).
  rec window "$ID" >/dev/null || echo "no window yet" >&2
}

case "${1:-build}" in
size)
  wh=${2:?WxH[+X+Y]}
  xy=${wh#*+}
  [ "$xy" = "$wh" ] && xy=0+0
  wh=${wh%%+*}
  rec size "$ID" "${wh%x*}" "${wh#*x}" "${xy%+*}" "${xy#*+}"
  exit 0
  ;;
launch)
  launch
  exit 0
  ;;
quit)
  quit_app
  exit 0
  ;;
rec)
  build_rec
  exit 0
  ;;
build) ;;
*)
  echo "usage: test-app.sh [build | size WxH[+X+Y] | launch | quit | rec]" >&2
  exit 2
  ;;
esac

t=$(date +%s)
remote 'mkdir -p "$S/src"'
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude dist --exclude build --exclude artifacts \
  --exclude .hutch --exclude .experiments --exclude '*.tsbuildinfo' --exclude .DS_Store \
  "$ROOT/" "$MINI:$SCRATCH/src/"
build_rec
remote '
  set -e
  cd "$S/src"
  bun install >"$S/install.log" 2>&1 || { tail -20 "$S/install.log"; exit 1; }
  cd apps/desktop
  SWITCH_APP_NAME="$NAME" SWITCH_APP_ID="$ID" bun run build >"$S/build.log" 2>&1 || { tail -40 "$S/build.log"; exit 1; }
  # Who opens switchboard:// now, so the test copy registering it changes nothing.
  printf "%s\n" "import AppKit" \
    "let u = URL(string: \"switchboard://space/home\")!" \
    "if CommandLine.arguments.count > 1 { LSSetDefaultHandlerForURLScheme(\"switchboard\" as CFString, CommandLine.arguments[1] as CFString) }" \
    "if let a = NSWorkspace.shared.urlForApplication(toOpen: u), let b = Bundle(url: a) { print(b.bundleIdentifier ?? \"\") }" \
    >"$S/handler.swift"
  [ -x "$S/handler" ] || xcrun swiftc -O -o "$S/handler" "$S/handler.swift"
  before=$("$S/handler")
  pkill -f "$HOME/Applications/$NAME.app/Contents/MacOS/" || true
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/$NAME.app"
  # The build is a self-extracting stub that shows a setup window on first run; its payload is the app.
  tar --zstd -xf "build/stable-macos-arm64/$NAME.app/Contents/Resources/"*.tar.zst -C "$HOME/Applications"
  rm -rf artifacts
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$HOME/Applications/$NAME.app"
  after=$("$S/handler")
  if [ -n "$before" ] && [ "$after" != "$before" ]; then
    "$S/handler" "$before" >/dev/null
    echo "switchboard:// kept on $before"
  fi
'
launch
echo "built and launched in $(($(date +%s) - t)) s"
