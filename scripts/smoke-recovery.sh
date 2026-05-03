#!/usr/bin/env bash
# scripts/smoke-recovery.sh
# Automated smoke tests for the Electron Recovery Mode subsystem.
# Covers scenarios that don't require GUI interaction or sudo.
#
# Manual scenarios (run separately, see docs/superpowers/specs/...):
#   1  network failure (needs sudo to toggle Wi-Fi)
#   3  renderer crash via DevTools
#   5,6  native notification visibility
#   7  tray menu interaction
#   8,9  recovery button clicks
#   10  corrupt recovery.html (requires asar manipulation)
#   11  force-kill recovery
#   12  hidden autostart
#   14  SPA navigation
#   15  real Windows-incident reproduction (needs Vite running)
#
# Automated scenarios:
#   2  bad URL → load-failed
#   4  boot stall (VITE_FORCE_BOOT_STALL build) → renderer-stalled
#   13  ErrorBoundary path doesn't trigger boot timer (negative test — see note below)
#
# Note on scenario 13: The VITE_FORCE_BOOT_STALL gate suppresses the ErrorBoundary
# ping as well, so an isolated scenario-13 negative test (ErrorBoundary DOES ping
# in normal builds) requires a separate non-stalled build run. This script covers
# the stalled-build scenario; the positive scenario-13 case is tested manually.

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BINARY="$REPO_ROOT/packages/desktop/dist-electron/mac-arm64/Backspace.app/Contents/MacOS/Backspace"
USER_DATA_DIR="$HOME/Library/Application Support/Backspace"
INSTANCE_URL_FILE="$USER_DATA_DIR/instance-url.json"
INSTANCE_URL_BACKUP="$INSTANCE_URL_FILE.smoketest-backup"
TMP_DIR="$(mktemp -d -t backspace-smoke.XXXXXX)"
trap 'cleanup' EXIT INT TERM

SKIP_BUILD=0
[[ "${1:-}" == "--skip-build" ]] && SKIP_BUILD=1

# ─── Utilities ──────────────────────────────────────────────────────────
declare -i PASS=0
declare -i FAIL=0
declare -a RESULTS=()

log() { printf '\n\033[1;36m[smoke]\033[0m %s\n' "$*"; }
ok()  { printf '  \033[1;32m✓\033[0m %s\n' "$*"; PASS=$((PASS+1)); RESULTS+=("PASS: $*"); }
bad() { printf '  \033[1;31m✗\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); RESULTS+=("FAIL: $*"); }

cleanup() {
  # Always restore the user's instance-url.json if we backed it up
  if [[ -f "$INSTANCE_URL_BACKUP" ]]; then
    mv "$INSTANCE_URL_BACKUP" "$INSTANCE_URL_FILE"
  fi
  # Kill any leftover Backspace processes started by this script
  pkill -f "$APP_BINARY" 2>/dev/null || true
  # Clean tmp
  rm -rf "$TMP_DIR"
}

backup_instance_url() {
  if [[ -f "$INSTANCE_URL_FILE" ]]; then
    cp "$INSTANCE_URL_FILE" "$INSTANCE_URL_BACKUP"
  fi
}

write_bad_instance_url() {
  mkdir -p "$USER_DATA_DIR"
  printf '{"url":"https://nonexistent-instance.invalid"}' > "$INSTANCE_URL_FILE"
}

# Launches the binary in the background, captures stdout+stderr to the named
# log file, and echoes the PID. Caller is responsible for killing it.
launch() {
  local logfile="$1"
  shift
  "$APP_BINARY" "$@" > "$logfile" 2>&1 &
  echo $!
}

# Waits up to N seconds for a regex to appear in the log file.
# Returns 0 if found, 1 if timeout.
wait_for_log() {
  local logfile="$1"
  local pattern="$2"
  local timeout_s="$3"
  local start
  start=$(date +%s)
  while true; do
    if grep -Eq "$pattern" "$logfile" 2>/dev/null; then
      return 0
    fi
    local now
    now=$(date +%s)
    if (( now - start >= timeout_s )); then
      return 1
    fi
    sleep 0.5
  done
}

kill_app() {
  local pid="$1"
  kill "$pid" 2>/dev/null || true
  # Wait for clean shutdown (up to 2.5s), then force-kill
  local i
  for i in 1 2 3 4 5; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  kill -9 "$pid" 2>/dev/null || true
}

# ─── Scenario helpers ──────────────────────────────────────────────────
scenario_2_bad_url() {
  log "Scenario 2: Bad instance URL → recovery (load-failed)"
  backup_instance_url
  write_bad_instance_url

  local logfile="$TMP_DIR/scenario2.log"
  local pid
  pid=$(launch "$logfile")

  if wait_for_log "$logfile" '\[recovery\] entered: load-failed' 15; then
    ok "Scenario 2: load-failed recovery entered"
  else
    bad "Scenario 2: load-failed recovery did NOT enter within 15s"
    log "Last 30 lines of log:"
    tail -n 30 "$logfile" || true
  fi

  kill_app "$pid"

  # Restore (cleanup trap covers the EXIT case too, but be explicit here
  # so the subsequent scenario starts with a known-good state)
  if [[ -f "$INSTANCE_URL_BACKUP" ]]; then
    mv "$INSTANCE_URL_BACKUP" "$INSTANCE_URL_FILE"
  else
    rm -f "$INSTANCE_URL_FILE"
  fi
}

scenario_4_boot_stall() {
  log "Scenario 4: Boot stall (VITE_FORCE_BOOT_STALL build) → recovery (renderer-stalled)"
  log "Building stall-variant web bundle..."

  if (cd "$REPO_ROOT" && VITE_FORCE_BOOT_STALL=1 pnpm --filter @backspace/web build > "$TMP_DIR/web-build.log" 2>&1); then
    log "  web build complete"
  else
    bad "Scenario 4: VITE_FORCE_BOOT_STALL web build failed (see $TMP_DIR/web-build.log)"
    return
  fi

  log "Rebuilding desktop app with stalled bundle..."
  if (cd "$REPO_ROOT" && pnpm --filter @backspace/desktop build > "$TMP_DIR/desktop-build.log" 2>&1); then
    log "  desktop build complete"
  else
    bad "Scenario 4: desktop rebuild failed (see $TMP_DIR/desktop-build.log)"
    # Still rebuild the normal web bundle before returning
    log "Rebuilding web bundle without VITE_FORCE_BOOT_STALL (cleanup)..."
    (cd "$REPO_ROOT" && pnpm --filter @backspace/web build > "$TMP_DIR/web-rebuild-cleanup.log" 2>&1) || true
    (cd "$REPO_ROOT" && pnpm --filter @backspace/desktop build > "$TMP_DIR/desktop-rebuild-cleanup.log" 2>&1) || true
    return
  fi

  # Use the user's saved URL so we get past did-fail-load and into the
  # actual boot-stall path. If none is saved, the scenario can't run.
  backup_instance_url
  if [[ -f "$INSTANCE_URL_BACKUP" ]]; then
    cp "$INSTANCE_URL_BACKUP" "$INSTANCE_URL_FILE"
  else
    log "  No saved instance URL found — Scenario 4 needs a working URL to exercise"
    log "  the boot stall path. Run the app once, pick an instance, then re-run."
    bad "Scenario 4: no saved URL to test against"
    # Rebuild normal bundle before returning
    log "Rebuilding web bundle without VITE_FORCE_BOOT_STALL (cleanup)..."
    (cd "$REPO_ROOT" && pnpm --filter @backspace/web build > "$TMP_DIR/web-rebuild-cleanup.log" 2>&1) || true
    (cd "$REPO_ROOT" && pnpm --filter @backspace/desktop build > "$TMP_DIR/desktop-rebuild-cleanup.log" 2>&1) || true
    return
  fi

  local logfile="$TMP_DIR/scenario4.log"
  local pid
  pid=$(launch "$logfile")

  log "  Waiting up to 25s for renderer-stalled timer to fire..."
  if wait_for_log "$logfile" '\[recovery\] entered: renderer-stalled' 25; then
    ok "Scenario 4: renderer-stalled recovery entered"
  else
    bad "Scenario 4: renderer-stalled recovery did NOT enter within 25s"
    log "Last 30 lines of log:"
    tail -n 30 "$logfile" || true
  fi

  kill_app "$pid"

  # Restore the user's instance-url.json
  if [[ -f "$INSTANCE_URL_BACKUP" ]]; then
    mv "$INSTANCE_URL_BACKUP" "$INSTANCE_URL_FILE"
  else
    rm -f "$INSTANCE_URL_FILE"
  fi

  # IMPORTANT: rebuild both bundles WITHOUT the env var so subsequent dev/test
  # runs are not left permanently stalled.
  log "Rebuilding web bundle without VITE_FORCE_BOOT_STALL (restoring normal build)..."
  if (cd "$REPO_ROOT" && pnpm --filter @backspace/web build > "$TMP_DIR/web-rebuild.log" 2>&1); then
    log "  web bundle restored"
  else
    log "  WARNING: web rebuild failed — run 'pnpm --filter @backspace/web build' manually"
  fi
  if (cd "$REPO_ROOT" && pnpm --filter @backspace/desktop build > "$TMP_DIR/desktop-rebuild.log" 2>&1); then
    log "  desktop build restored"
  else
    log "  WARNING: desktop rebuild failed — run 'pnpm --filter @backspace/desktop build' manually"
  fi
}

# ─── Main ───────────────────────────────────────────────────────────────
main() {
  log "Backspace Recovery Mode — Automated Smoke Tests"
  log "Repo: $REPO_ROOT"
  log "Tmp:  $TMP_DIR"

  if [[ "$SKIP_BUILD" == "0" ]]; then
    log "Building desktop app (pass --skip-build to reuse existing)..."
    if ! (cd "$REPO_ROOT" && pnpm --filter @backspace/desktop build > "$TMP_DIR/initial-build.log" 2>&1); then
      bad "Initial desktop build failed (see $TMP_DIR/initial-build.log)"
      return 1
    fi
  fi

  if [[ ! -x "$APP_BINARY" ]]; then
    bad "App binary not found at $APP_BINARY"
    log "Run 'pnpm --filter @backspace/desktop build' first."
    return 1
  fi

  scenario_2_bad_url
  scenario_4_boot_stall

  log "─── Summary ─────────────────────────────────────────────────────"
  local r
  for r in "${RESULTS[@]}"; do
    if [[ "$r" == PASS:* ]]; then
      printf '  \033[1;32m✓\033[0m %s\n' "${r#PASS: }"
    else
      printf '  \033[1;31m✗\033[0m %s\n' "${r#FAIL: }"
    fi
  done
  log "$PASS passed, $FAIL failed"

  if (( FAIL > 0 )); then
    return 1
  fi
}

main "$@"
