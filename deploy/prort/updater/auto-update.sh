#!/usr/bin/env bash
# Backspace auto-updater for the Debian/PRoot (Termux) server.
#
# Keeps /opt/backspace on a release branch (default: main) without a human:
# fetch, fast-forward only, rebuild only what changed, restart only what
# changed, wait for /api/health, and roll back to the previous commit when the
# new one does not come up healthy.
#
# Modes:
#   auto-update.sh            one update cycle
#   auto-update.sh --check    report only, change nothing
#   auto-update.sh --loop     run a cycle every INTERVAL seconds, forever
#   auto-update.sh --ensure   start --loop in the background unless it is running
#
# This file runs from INSTALL_DIR (outside the repo) so that `git merge` never
# rewrites the script while bash is still reading it. After a successful update
# the cycle refreshes INSTALL_DIR from the repo copy for the next run.
#
# Every external effect is a variable so the logic can be tested without a phone:
# REPO, REMOTE, BRANCH, HEALTH_URL, INSTALL_CMD, BUILD_CMD, SNAPSHOT_CMD,
# RESTART_CMD, STATE_DIR, LOG_FILE.

set -uo pipefail

REPO="${REPO:-/opt/backspace}"
REMOTE="${REMOTE:-private}"
BRANCH="${BRANCH:-main}"
INTERVAL="${INTERVAL:-900}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
INSTALL_DIR="${INSTALL_DIR:-/opt/backspace-update}"
STATE_DIR="${STATE_DIR:-/var/lib/backspace-update}"
LOG_FILE="${LOG_FILE:-/var/log/backspace/update.log}"
SERVER_LOG="${SERVER_LOG:-/var/log/backspace/server.log}"

# Vite is the heavy step on a phone: cap the heap and run at idle priority so
# LiveKit and the app keep their CPU while it works.
INSTALL_CMD="${INSTALL_CMD:-pnpm install --frozen-lockfile --filter @backspace/shared... --filter @backspace/server... --filter @backspace/web...}"
BUILD_CMD="${BUILD_CMD:-NODE_OPTIONS=--max-old-space-size=1536 nice -n 19 pnpm --filter @backspace/web exec vite build --outDir dist.new --emptyOutDir}"
SNAPSHOT_CMD="${SNAPSHOT_CMD:-cd $REPO/packages/server && node --import tsx/esm src/scripts/snapshot.ts}"
RESTART_CMD="${RESTART_CMD:-restart_server}"

mkdir -p "$STATE_DIR" "$(dirname "$LOG_FILE")" 2>/dev/null || true

log() {
  printf '[%s] %s\n' "$(date '+%F %T')" "$*" >>"$LOG_FILE"
  [ -t 1 ] && printf '%s\n' "$*"
  return 0
}

health() { curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; }

wait_healthy() {
  local waited=0
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    health && return 0
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

# Same launch line as start_server in start-stack.sh. Only the Backspace server
# is restarted: LiveKit, Caddy and Tailscale keep running, so a call in progress
# survives an update that only touches the app.
restart_server() {
  local pids
  pids="$(pgrep -f '^node --import tsx/esm src/index.ts$' || true)"
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    for _ in $(seq 1 20); do
      pgrep -f '^node --import tsx/esm src/index.ts$' >/dev/null || break
      sleep 1
    done
    pkill -9 -f '^node --import tsx/esm src/index.ts$' 2>/dev/null || true
  fi
  cd "$REPO/packages/server" || return 1
  # 9>&- keeps the update lock out of the server: a long-lived child that
  # inherits the flock fd would hold the lock and stall every later cycle.
  setsid nohup node --import tsx/esm src/index.ts >>"$SERVER_LOG" 2>&1 </dev/null 9>&- &
}

# True when every /assets/... file that index.html references exists under $1.
# The server answers a missing asset with index.html (SPA fallback), so a dist
# whose index.html points at chunks that are not on disk makes the main module
# load as HTML: React never mounts and the desktop app reports render-stalled.
dist_complete() {
  local dir="$1" ref
  [ -f "$dir/index.html" ] || return 1
  while IFS= read -r ref; do
    [ -f "$dir$ref" ] || { log "dist check: $ref referenced by index.html is missing in $dir"; return 1; }
  done < <(grep -oE '(src|href)="/assets/[^"]+"' "$dir/index.html" | sed -E 's/^[a-z]+="//; s/"$//')
  return 0
}

# Rebuild the web bundle in place when the live dist is incomplete, even if
# there is no new commit. Used to heal a dist left half-written.
heal_dist() {
  local web="$REPO/packages/web"
  [ -f "$web/dist/index.html" ] && dist_complete "$web/dist" && return 0
  log "live web dist is incomplete, rebuilding it"
  run_step "$BUILD_CMD" || { log "ERROR: heal build failed"; rm -rf "$web/dist.new"; return 1; }
  dist_complete "$web/dist.new" || { log "ERROR: heal build is incomplete, keeping the old dist"; rm -rf "$web/dist.new"; return 1; }
  rm -rf "$web/dist.prev"
  [ -d "$web/dist" ] && mv "$web/dist" "$web/dist.prev"
  mv "$web/dist.new" "$web/dist"
  rm -rf "$web/dist.prev"
  log "web dist healed"
}

changed() { git -C "$REPO" diff --name-only "$1" "$2" | grep -Eq "$3"; }

run_step() {
  # Runs a command string in $REPO; output goes to the log, status is returned.
  # Same reason as restart_server: build tools leave daemons (esbuild) behind.
  ( exec 9>&-; cd "$REPO" && eval "$1" ) >>"$LOG_FILE" 2>&1
}

cycle() {
  local check_only="$1"

  exec 9>"$STATE_DIR/update.lock"
  flock -n 9 || { log "another update is running, skipping"; return 0; }

  if ! git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
    log "ERROR: $REPO is not a git checkout"; return 1
  fi

  local current
  current="$(git -C "$REPO" symbolic-ref --short -q HEAD || echo DETACHED)"
  if [ "$current" != "$BRANCH" ]; then
    log "skip: checked out '$current', not '$BRANCH'"; return 0
  fi

  if ! timeout 90 git -C "$REPO" fetch --quiet --tags "$REMOTE" "$BRANCH" 2>>"$LOG_FILE"; then
    log "fetch failed (network?), will retry next cycle"; return 0
  fi

  local old new
  old="$(git -C "$REPO" rev-parse HEAD)"
  new="$(git -C "$REPO" rev-parse "$REMOTE/$BRANCH")"

  if [ "$old" = "$new" ]; then
    heal_dist
    return 0
  fi

  if ! git -C "$REPO" merge-base --is-ancestor "$old" "$new"; then
    log "skip: local $BRANCH (${old:0:8}) is not an ancestor of $REMOTE/$BRANCH (${new:0:8}); needs a human"
    return 0
  fi

  if ! git -C "$REPO" diff --quiet HEAD --; then
    log "skip: tracked files have local edits; refusing to merge over them"
    return 0
  fi

  if [ "$(cat "$STATE_DIR/bad-sha" 2>/dev/null || true)" = "$new" ]; then
    return 0   # this exact commit already failed and was rolled back
  fi

  log "update available: ${old:0:8} -> ${new:0:8} ($(git -C "$REPO" rev-list --count "$old..$new") commits)"
  [ "$check_only" = 1 ] && return 0

  local need_install=0 need_build=0 need_restart=0
  changed "$old" "$new" '(^|/)package\.json$|^pnpm-lock\.yaml$|^pnpm-workspace\.yaml$|^patches/' && need_install=1
  changed "$old" "$new" '^packages/(web|shared)/|^scripts/check-i18n' && need_build=1
  changed "$old" "$new" '^packages/(server|shared)/|^pnpm-lock\.yaml$' && need_restart=1
  [ "$need_install" = 1 ] && need_build=1
  # A rebuilt web bundle is served from disk; no restart needed unless the
  # server code changed too.

  if ! run_step "$SNAPSHOT_CMD"; then
    log "ABORT: database snapshot failed, leaving the server untouched"
    return 1
  fi

  rollback() {
    log "ROLLBACK to ${old:0:8}: $1"
    echo "$new" >"$STATE_DIR/bad-sha"
    git -C "$REPO" reset --hard --quiet "$old"
    if [ -d "$REPO/packages/web/dist.prev" ]; then
      rm -rf "$REPO/packages/web/dist"
      mv "$REPO/packages/web/dist.prev" "$REPO/packages/web/dist"
    fi
    rm -rf "$REPO/packages/web/dist.new"
    [ "$need_install" = 1 ] && run_step "$INSTALL_CMD"
    run_step "$RESTART_CMD"
    if wait_healthy; then log "rollback healthy"; else log "ERROR: still unhealthy after rollback; see $SERVER_LOG"; fi
  }

  git -C "$REPO" merge --ff-only --quiet "$new" >>"$LOG_FILE" 2>&1 || { rollback "merge failed"; return 1; }

  if [ "$need_install" = 1 ]; then
    run_step "$INSTALL_CMD" || { rollback "dependency install failed"; return 1; }
  fi

  if [ "$need_build" = 1 ]; then
    run_step "$BUILD_CMD" || { rollback "web build failed"; return 1; }
    local web="$REPO/packages/web"
    if [ -d "$web/dist.new" ] && ! dist_complete "$web/dist.new"; then
      rollback "web build is incomplete (index.html references missing files)"; return 1
    fi
    if [ -d "$web/dist.new" ]; then
      rm -rf "$web/dist.prev"
      [ -d "$web/dist" ] && mv "$web/dist" "$web/dist.prev"
      mv "$web/dist.new" "$web/dist"
    fi
  fi

  if [ "$need_restart" = 1 ]; then
    run_step "$RESTART_CMD"
    wait_healthy || { rollback "server unhealthy after restart"; return 1; }
  else
    # The Vite build can get the server killed by Android's low-memory killer.
    # That says nothing about the new commit, so bring the server back once
    # before blaming the release.
    if ! health; then
      log "server down after the web build; restarting it once"
      run_step "$RESTART_CMD"
      wait_healthy || { rollback "server unhealthy after web update"; return 1; }
    fi
  fi

  rm -rf "$REPO/packages/web/dist.prev"
  rm -f "$STATE_DIR/bad-sha"
  log "updated to ${new:0:8} (install=$need_install build=$need_build restart=$need_restart)"

  # Refresh the installed copy for the next cycle (never the running one).
  if [ -f "$REPO/deploy/prort/updater/auto-update.sh" ] && [ "$INSTALL_DIR" != "$REPO/deploy/prort/updater" ]; then
    mkdir -p "$INSTALL_DIR"
    cp "$REPO/deploy/prort/updater/auto-update.sh" "$INSTALL_DIR/auto-update.sh.new" \
      && chmod 755 "$INSTALL_DIR/auto-update.sh.new" \
      && mv -f "$INSTALL_DIR/auto-update.sh.new" "$INSTALL_DIR/auto-update.sh"
  fi
  return 0
}

main() {
  case "${1:-}" in
    --check) cycle 1 ;;
    --loop)
      while true; do
        # Each cycle in a fresh process so a refreshed script is picked up.
        bash "$0" >/dev/null 2>&1 || true
        sleep "$INTERVAL"
      done
      ;;
    --ensure)
      # Start the loop detached unless one is already running. The bracket
      # keeps pgrep from matching this very command line.
      pgrep -f '[a]uto-update.sh --loop' >/dev/null && return 0
      setsid nohup "$0" --loop >/dev/null 2>&1 </dev/null &
      ;;
    "") cycle 0 ;;
    *) echo "usage: $0 [--check|--loop|--ensure]" >&2; return 2 ;;
  esac
}

# Brace group: bash reads this whole block before running it.
{ main "$@"; exit $?; }
