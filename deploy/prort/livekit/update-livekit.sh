#!/usr/bin/env bash
# Rebuilds LiveKit with the PRoot/Android patches and (optionally) swaps it in.
#
# The server is not a dependency of Backspace: it is the upstream LiveKit SFU
# plus the patches in this directory (see PATCHES.md for what each one fixes).
# Upstream moves on, the patches have to be re-applied to every new release,
# and this script does that in a way that cannot take voice down by accident.
#
#   update-livekit.sh --check              Is a newer upstream release out?
#   update-livekit.sh --build [VERSION]    Build + smoke-test a candidate. Installs nothing.
#   update-livekit.sh --apply [VERSION]    --build, then install it and restart LiveKit.
#                                          Rolls back by itself if it does not come up.
#   update-livekit.sh --rollback           Put the previous binary back.
#
# VERSION defaults to the latest upstream release (without the leading "v").
# Anything that does not apply cleanly stops the run before the live binary is
# touched, and says which patch failed: that is the cue to rebase that patch.
#
# Calls in progress drop for a few seconds during --apply/--rollback.

set -uo pipefail

PATCH_DIR="${PATCH_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
LK_DIR="${LK_DIR:-/opt/livekit}"
WORK_DIR="${WORK_DIR:-$LK_DIR/build}"
TOOLCHAIN_DIR="${TOOLCHAIN_DIR:-$LK_DIR/toolchain}"
BIN="${BIN:-/usr/local/bin/livekit-server.bin}"
CONFIG="${CONFIG:-$LK_DIR/livekit.yaml}"
LOG_DIR="${LOG_DIR:-/var/log/livekit}"
LIVEKIT_URL="${LIVEKIT_URL:-http://127.0.0.1:7880/}"
PRORT_ADDRS="${LIVEKIT_PRORT_ADDRS:-wlan0=10.0.1.8/24,tun1=100.113.4.54/32,lo=127.0.0.1/8}"
UPSTREAM_API="https://api.github.com/repos/livekit/livekit/releases/latest"

# Patches for the main module, applied with -p1 from the source root.
SOURCE_PATCHES=(
  pkg-config-config.go.patch
  pkg-service-turn.go.patch
  pkg-service-roommanager.go.patch
  pkg-telemetry-prometheus-node_linux.go.patch
)
# module path -> patch file. Each module is copied out of the module cache,
# patched, and wired in with a `replace`, at whatever version go.mod pins.
MODULE_PATCHES=(
  "github.com/wlynxg/anet:anet-interface.go.patch"
  "github.com/livekit/protocol:hwstats-cpu_linux.go.patch"
)

say()  { printf '%s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

installed_version() {
  "$BIN" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1
}

latest_version() {
  local body
  body="$(curl -fsS --max-time 20 "$UPSTREAM_API")" || return 1
  printf '%s\n' "$body" | grep '"tag_name"' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1
}

# True when $1 is a strictly newer x.y.z than $2.
newer() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]; }

ensure_go() {
  local want="$1" dir="$TOOLCHAIN_DIR/go-$1"
  # A marker written only after a complete extraction: a run killed halfway
  # (SSH dropped, phone slept) must not leave a toolchain that looks installed
  # but has half of the standard library.
  if [ ! -f "$dir/.complete" ]; then
    say "downloading Go $want (needed by this LiveKit release)"
    rm -rf "$dir"
    mkdir -p "$dir"
    curl -fsSL "https://go.dev/dl/go${want}.linux-arm64.tar.gz" | tar -xz -C "$dir" \
      && [ -d "$dir/go/src/os/exec" ] && "$dir/go/bin/go" version >/dev/null 2>&1 \
      || { rm -rf "$dir"; die "could not download a complete Go $want"; }
    touch "$dir/.complete"
  fi
  printf '%s\n' "$dir/go/bin/go"
}

build_candidate() {
  local ver="$1" src="$WORK_DIR/src-$ver" out="$WORK_DIR/out-$ver"
  mkdir -p "$WORK_DIR"
  rm -rf "$src" "$out"
  mkdir -p "$src" "$out"

  say "== fetching LiveKit v$ver source"
  curl -fsSL "https://github.com/livekit/livekit/archive/refs/tags/v$ver.tar.gz" \
    | tar -xz -C "$src" --strip-components=1 || die "could not download v$ver source"

  say "== checking that every patch applies (nothing is changed yet)"
  local p
  for p in "${SOURCE_PATCHES[@]}"; do
    patch -p1 --dry-run -s -d "$src" <"$PATCH_DIR/$p" >/dev/null \
      || die "$p does not apply to v$ver. The upstream file moved; rebase this patch, then rerun."
  done
  for p in "${SOURCE_PATCHES[@]}"; do
    patch -p1 -s -d "$src" <"$PATCH_DIR/$p" || die "$p failed while applying"
  done

  local want_go
  want_go="$(awk '/^go [0-9]/{print $2; exit}' "$src/go.mod")"
  [ -n "$want_go" ] || die "could not read the Go version from go.mod"
  local go_bin goroot
  go_bin="$(ensure_go "$want_go")" || exit 1
  goroot="$(dirname "$(dirname "$go_bin")")"
  # A private module cache, never the machine's shared one: patching a module in
  # place (as the first manual build did) leaves a copy that no longer matches
  # go.sum, and every later copy of it would start from a modified file.
  export GOROOT="$goroot" PATH="$goroot/bin:$PATH" GOTOOLCHAIN=local GOFLAGS=-mod=mod
  export GOMODCACHE="$WORK_DIR/gomodcache"

  say "== patching dependent modules"
  local entry mod patchfile modver dest
  for entry in "${MODULE_PATCHES[@]}"; do
    mod="${entry%%:*}"; patchfile="${entry##*:}"
    # The pinned version comes straight from go.mod (it lists indirect
    # dependencies too); `go list -m` needs a warm cache and hides its errors.
    modver="$(awk -v m="$mod" '$1==m {print $2; exit} $1=="require" && $2==m {print $3; exit}' "$src/go.mod")"
    [ -n "$modver" ] || die "$mod is no longer a dependency of v$ver; drop $patchfile"
    (cd "$src" && go mod download "$mod") || die "could not download $mod@$modver"
    dest="$WORK_DIR/mod-$ver-$(basename "$mod")"
    rm -rf "$dest"
    cp -a "$(cd "$src" && go env GOMODCACHE)/$mod@$modver" "$dest"
    chmod -R u+w "$dest"
    patch -p1 --dry-run -s -d "$dest" <"$PATCH_DIR/$patchfile" >/dev/null \
      || die "$patchfile does not apply to $mod@$modver. Rebase it, then rerun."
    patch -p1 -s -d "$dest" <"$PATCH_DIR/$patchfile" || die "$patchfile failed while applying"
    (cd "$src" && go mod edit -replace "$mod=$dest")
    say "   $mod@$modver patched"
  done

  say "== building (this takes several minutes on a phone)"
  ( cd "$src" \
    && GOMAXPROCS=3 GOMEMLIMIT=1800MiB CGO_ENABLED=1 \
       nice -n 19 go build -p 2 -trimpath -buildvcs=false -o "$out/livekit-server.bin" ./cmd/server ) \
    || die "build failed (log above)"

  say "== smoke test on side ports (the live server is not touched)"
  smoke_test "$out/livekit-server.bin" "$ver" || die "the candidate did not start; not installing"
  say "candidate ready: $out/livekit-server.bin"
}

smoke_test() {
  local bin="$1" ver="$2" cfg pid ok=1
  cfg="$(mktemp)"
  cat >"$cfg" <<EOF
port: 17880
bind_addresses: [127.0.0.1]
rtc:
  tcp_port: 17881
  udp_port: 17882
  use_external_ip: false
keys:
  smoketest: smoketest-secret-smoketest-secret-0000
EOF
  LIVEKIT_PRORT_ADDRS="$PRORT_ADDRS" "$bin" --config "$cfg" >"$WORK_DIR/smoke-$ver.log" 2>&1 &
  pid=$!
  for _ in $(seq 1 20); do
    curl -fsS --max-time 2 http://127.0.0.1:17880/ >/dev/null 2>&1 && { ok=0; break; }
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  # Graceful stop first; the SFU can hang in shutdown, and a hung test process
  # must not hang the update, so it is force-killed after 5 seconds.
  kill "$pid" 2>/dev/null
  for _ in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill -9 "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  rm -f "$cfg"
  [ "$ok" = 0 ] || tail -15 "$WORK_DIR/smoke-$ver.log" >&2
  return "$ok"
}

lk_up() { curl -fsS --max-time 3 "$LIVEKIT_URL" >/dev/null 2>&1; }

restart_livekit() {
  pkill -f '^livekit-server --config' 2>/dev/null
  for _ in $(seq 1 15); do pgrep -f '^livekit-server --config' >/dev/null || break; sleep 1; done
  pkill -9 -f '^livekit-server --config' 2>/dev/null
  mkdir -p "$LOG_DIR"
  ( cd "$LK_DIR" && setsid nohup livekit-server --config "$CONFIG" >>"$LOG_DIR/livekit.log" 2>&1 </dev/null & )
  for _ in $(seq 1 30); do lk_up && return 0; sleep 1; done
  return 1
}

install_binary() {
  local new="$1" prev
  prev="$LK_DIR/livekit-server.bin.prev"
  cp -f "$BIN" "$prev" || die "could not back up the current binary"
  cp -f "$new" "$BIN.new" && chmod 755 "$BIN.new" && mv -f "$BIN.new" "$BIN" || die "could not install the new binary"
}

do_rollback() {
  local prev="$LK_DIR/livekit-server.bin.prev"
  [ -f "$prev" ] || die "no previous binary at $prev"
  cp -f "$prev" "$BIN.new" && chmod 755 "$BIN.new" && mv -f "$BIN.new" "$BIN" || die "could not restore"
  restart_livekit && say "rolled back to $(installed_version); LiveKit is up" || die "LiveKit did not come up after rollback; see $LOG_DIR/livekit.log"
}

cmd_check() {
  local cur lat
  cur="$(installed_version)"; lat="$(latest_version)"
  [ -n "$cur" ] || die "could not read the installed version from $BIN"
  [ -n "$lat" ] || die "could not reach GitHub to read the latest release"
  say "installed: $cur   latest upstream: $lat"
  if newer "$lat" "$cur"; then
    say "UPDATE AVAILABLE. Try it without risk:  $0 --build $lat"
    say "Release notes: https://github.com/livekit/livekit/releases/tag/v$lat"
  else
    say "up to date"
  fi
}

cmd_build_or_apply() {
  local mode="$1" ver="${2:-}"
  [ -n "$ver" ] || ver="$(latest_version)"
  [ -n "$ver" ] || die "could not determine the version to build"
  build_candidate "$ver"
  [ "$mode" = apply ] || { say "(--build: nothing was installed)"; return 0; }

  local cur; cur="$(installed_version)"
  say "== installing $ver (was $cur); calls drop for a few seconds"
  install_binary "$WORK_DIR/out-$ver/livekit-server.bin"
  if restart_livekit; then
    say "LiveKit $(installed_version) is up. Previous binary kept at $LK_DIR/livekit-server.bin.prev"
  else
    say "new LiveKit did not come up; rolling back"
    do_rollback
    exit 1
  fi
}

case "${1:-}" in
  --check)    cmd_check ;;
  --build)    cmd_build_or_apply build "${2:-}" ;;
  --apply)    cmd_build_or_apply apply "${2:-}" ;;
  --rollback) do_rollback ;;
  *) sed -n '2,22p' "$0"; exit 2 ;;
esac
