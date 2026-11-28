# What ship.sh, backup.sh and restore.sh do differently on a Mac and on Linux, sourced by each from
# beside it (a release's folder, or scripts/). Plain sh; sets nothing but these functions and LOGS.
#   conf <key>             a key of ~/.switch/deploy.json ($S), "" when it has none
#   lk <secs|-> <file> …   runs the rest holding <file> locked: waiting up to secs (0: not at all), or
#                          as long as it takes (-); the lock file stays
#   behind …               at a priority below the core's (utility QoS; nice), every core still
#   background …           at background priority (CPU and disk)
#   uncached in|out <file> a whole file streamed past the file cache (stdout, or from stdin)
#   size <file>            bytes, 0 when it isn't there
#   dev <path>             the device a path is on
#   days_ago <n>           the date n days back, as YYYYMMDD
#   weeks_ago <n>          the ISO week n weeks back, as YYYYWW
#   week_of <YYYYMMDD>     its ISO week, as YYYYWW
#   clone <from> <to>      a copy that shares the file's blocks when the disk can (APFS, btrfs, XFS)
#   free_port              a free TCP port on 127.0.0.1
#   tailscale_cli          the Tailscale CLI's path
#   tailnet_self           this machine's DNS name on its tailnet, without the last dot
OS=$(uname -s)
case $OS in
  Darwin) LOGS=$HOME/Library/Logs/switch ;;
  *) LOGS=${XDG_STATE_HOME:-$HOME/.local/state}/switch/logs ;;
esac

json_key() {
  python3 -c 'import json, sys
try:
    v = json.load(open(sys.argv[1])).get(sys.argv[2])
except Exception:
    v = None
print("" if v is None else v)' "$1" "$2" 2>/dev/null || true
}

conf() {
  if [ "$OS" = Darwin ]; then
    plutil -extract "$1" raw -o - "$S/deploy.json" 2>/dev/null || true
  else
    json_key "$S/deploy.json" "$1"
  fi
}

lk() {
  t=$1 f=$2
  shift 2
  if [ "$OS" = Darwin ]; then
    if [ "$t" = - ]; then lockf -k "$f" "$@"; else lockf -t "$t" "$f" "$@"; fi
  else
    case $t in
      -) flock "$f" "$@" ;;
      0) flock -n "$f" "$@" ;;
      *) flock -w "$t" "$f" "$@" ;;
    esac
  fi
}

behind() {
  if [ "$OS" = Darwin ]; then /usr/sbin/taskpolicy -c utility "$@"; else nice -n 10 "$@"; fi
}

background() {
  if [ "$OS" = Darwin ]; then /usr/sbin/taskpolicy -b "$@"; else nice -n 19 ionice -c 3 "$@"; fi
}

# A clone or copy of the brain is a file of its own in the cache, so reading one of brain size
# through it (a backup's compress, its test, a copy) fills memory with a second brain and pushes the
# live one's pages out, right as a new core warms after a swap: the core's next writes then read
# them back from a disk the copy saturates, and stalled it for seconds (84 s once). On a Mac,
# F_NOCACHE; on Linux, dd dropping what it read or wrote from the cache as it goes. A pipeline of it
# runs under pipefail, so a reader cut short fails the step, not a short backup.
uncached() {
  if [ "$OS" = Darwin ]; then
    perl -e 'my ($d, $p) = @ARGV; open(my $f, $d eq "in" ? "<" : ">", $p) or die "$p: $!\n";
      fcntl($f, 48, 1) or die "F_NOCACHE $p: $!\n"; binmode $f; binmode STDIN; binmode STDOUT;
      my ($i, $o) = $d eq "in" ? ($f, \*STDOUT) : (\*STDIN, $f);
      while (1) { my $n = sysread($i, my $b, 1 << 20); defined $n or die "read $p: $!\n"; last if !$n;
        for (my $at = 0; $at < $n;) { my $w = syswrite($o, $b, $n - $at, $at); defined $w or die "write $p: $!\n"; $at += $w } }
      close($f) or die "close $p: $!\n";' "$@"
  elif [ "$1" = in ]; then
    dd if="$2" bs=1M iflag=nocache status=none
  else
    dd of="$2" bs=1M oflag=nocache conv=fsync status=none
  fi
}

size() {
  if [ "$OS" = Darwin ]; then stat -f %z "$1" 2>/dev/null || echo 0; else stat -c %s "$1" 2>/dev/null || echo 0; fi
}

dev() {
  if [ "$OS" = Darwin ]; then stat -f %d "$1"; else stat -c %d "$1"; fi
}

days_ago() {
  if [ "$OS" = Darwin ]; then date -v-"$1"d +%Y%m%d; else date -d "$1 days ago" +%Y%m%d; fi
}

weeks_ago() {
  if [ "$OS" = Darwin ]; then date -v-"$1"w +%G%V; else date -d "$1 weeks ago" +%G%V; fi
}

week_of() {
  if [ "$OS" = Darwin ]; then date -j -f %Y%m%d "$1" +%G%V 2>/dev/null; else date -d "$1" +%G%V 2>/dev/null; fi
}

clone() {
  if [ "$OS" = Darwin ]; then cp -c "$1" "$2"; else cp --reflink=auto "$1" "$2"; fi
}

free_port() {
  python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'
}

tailscale_cli() {
  for t in /Applications/Tailscale.app/Contents/MacOS/Tailscale /usr/local/bin/tailscale /opt/homebrew/bin/tailscale /usr/bin/tailscale; do
    [ -x "$t" ] && { echo "$t"; return 0; }
  done
  echo tailscale
}

tailnet_self() {
  "$(tailscale_cli)" status --self --json | python3 -c 'import json, sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'
}
