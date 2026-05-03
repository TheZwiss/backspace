#!/usr/bin/env bash
# scripts/smoke-recovery.sh
# Automated smoke tests for the Electron Recovery Mode subsystem.
# Covers scenarios that don't require GUI interaction or sudo.
#
# Automated scenarios (this script):
#   2   bad URL → load-failed recovery
#   4   boot stall (static page that never pings) → renderer-stalled recovery
#   13  positive control: rendererReady ping disarms boot timer (no recovery)
#
# Manual scenarios (run yourself in front of the UI — see spec §9):
#   1   network failure (needs sudo to toggle Wi-Fi)
#   3   renderer crash via DevTools (process.crash())
#   5,6 native notification visible/not-visible (OS-level rendering)
#   7   tray menu interaction
#   8,9 recovery button clicks (Reload success / re-fail)
#   10  corrupt recovery.html (requires asar manipulation)
#   11  force-kill + recovery + Restart-to-Install (verify electron-updater behavior)
#   12  hidden autostart + boot failure
#   14  SPA navigation (logged-in session, channel switches don't trip timer)
#   15  real Windows-incident reproduction (build N, edit web bundle, run Vite)
#
# Strategy notes:
# - Scenarios 4 and 13 use a local Python http.server serving a tiny static page,
#   pointed at via BACKSPACE_URL. This bypasses the need to build a stalled web
#   bundle: scenario 4 omits the rendererReady call; scenario 13 includes it.
# - Scenario 2 writes a bad URL to instance-url.json and lets the normal load
#   path fail (did-fail-load → load-failed recovery).
# - All scenarios grep stderr for [recovery] entered: ... lines emitted by
#   enterRecoveryMode in recovery.ts.

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BINARY="$REPO_ROOT/packages/desktop/dist-electron/mac-arm64/Backspace.app/Contents/MacOS/Backspace"
USER_DATA_DIR="$HOME/Library/Application Support/@backspace/desktop"
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

# Returns 0 if the regex is NOT present in the log file (negative assertion),
# 1 if it is present.
assert_no_log() {
  local logfile="$1"
  local pattern="$2"
  if grep -Eq "$pattern" "$logfile" 2>/dev/null; then
    return 1
  fi
  return 0
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
  log "Scenario 4: Boot stall → recovery (renderer-stalled)"
  log "Strategy: serve a tiny static HTML page locally that has no window.backspace"
  log "  integration → renderer loads but never pings → 20s → boot timer fires."

  # The desktop loads remote URLs via mainWindow.loadURL. Setting BACKSPACE_URL
  # at launch overrides the saved instance URL. We serve a minimal HTML page
  # that doesn't import the web bundle at all — guaranteed to never call
  # rendererReady(). No web/desktop rebuilds needed.
  local stall_dir="$TMP_DIR/stall-page"
  mkdir -p "$stall_dir"
  cat > "$stall_dir/index.html" <<'HTML'
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Boot Stall Test</title></head>
<body style="background:#13131a;color:#efefef;font-family:sans-serif;padding:2rem;">
  <h1>Boot stall test page</h1>
  <p>Renderer is alive but never calls window.backspace.rendererReady().
     The main-process boot timer should fire after 20s and trigger recovery.</p>
</body>
</html>
HTML

  # Start a local HTTP server on a random high port to avoid collisions.
  local port=8765
  python3 -m http.server "$port" --bind 127.0.0.1 -d "$stall_dir" > "$TMP_DIR/httpd.log" 2>&1 &
  local httpd_pid=$!

  # Poll for readiness (up to 5s).
  local ready=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -sf "http://127.0.0.1:$port/" > /dev/null 2>&1; then
      ready=1; break
    fi
    sleep 0.5
  done
  if [[ "$ready" != "1" ]]; then
    bad "Scenario 4: local HTTP server failed to start on port $port"
    kill "$httpd_pid" 2>/dev/null || true
    return
  fi

  local logfile="$TMP_DIR/scenario4.log"
  BACKSPACE_URL="http://127.0.0.1:$port/" "$APP_BINARY" > "$logfile" 2>&1 &
  local pid=$!

  log "  Waiting up to 25s for renderer-stalled timer to fire..."
  if wait_for_log "$logfile" '\[recovery\] entered: renderer-stalled' 25; then
    ok "Scenario 4: renderer-stalled recovery entered"
  else
    bad "Scenario 4: renderer-stalled recovery did NOT enter within 25s"
    log "Last 30 lines of log:"
    tail -n 30 "$logfile" || true
  fi

  kill_app "$pid"
  kill "$httpd_pid" 2>/dev/null || true
  # Wait for httpd to actually exit so the port is free for re-runs.
  wait "$httpd_pid" 2>/dev/null || true
}

scenario_13_ping_disarms_timer() {
  log "Scenario 13 (positive control): rendererReady ping disarms the boot timer"
  log "Strategy: serve a page that DOES call window.backspace.rendererReady() →"
  log "  verify NO recovery entry within 25s (timer correctly disarmed)."

  local ready_dir="$TMP_DIR/ready-page"
  mkdir -p "$ready_dir"
  cat > "$ready_dir/index.html" <<'HTML'
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Boot Ready Test</title></head>
<body style="background:#13131a;color:#efefef;font-family:sans-serif;padding:2rem;">
  <h1>Boot ready test page</h1>
  <p>Renderer calls window.backspace.rendererReady() — the main-process
     boot timer should be disarmed; recovery must NOT enter.</p>
  <script>
    // Marker fetches let the smoke harness verify each branch via the http.server log.
    fetch('/_marker_script_ran').catch(function(){});
    function tryPing() {
      if (typeof window.backspace !== 'undefined' &&
          typeof window.backspace.rendererReady === 'function') {
        window.backspace.rendererReady();
        fetch('/_marker_ping_sent').catch(function(){});
        return true;
      }
      return false;
    }
    if (!tryPing()) {
      // Preload may attach window.backspace asynchronously in some configs;
      // retry briefly before declaring it absent.
      var attempts = 0;
      var iv = setInterval(function() {
        attempts++;
        if (tryPing() || attempts > 20) {
          clearInterval(iv);
          if (attempts > 20) fetch('/_marker_no_bridge').catch(function(){});
        }
      }, 100);
    }
  </script>
</body>
</html>
HTML

  local port=8766
  python3 -m http.server "$port" --bind 127.0.0.1 -d "$ready_dir" > "$TMP_DIR/httpd13.log" 2>&1 &
  local httpd_pid=$!

  local ready=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -sf "http://127.0.0.1:$port/" > /dev/null 2>&1; then
      ready=1; break
    fi
    sleep 0.5
  done
  if [[ "$ready" != "1" ]]; then
    bad "Scenario 13: local HTTP server failed to start on port $port"
    kill "$httpd_pid" 2>/dev/null || true
    return
  fi

  local logfile="$TMP_DIR/scenario13.log"
  BACKSPACE_URL="http://127.0.0.1:$port/" "$APP_BINARY" > "$logfile" 2>&1 &
  local pid=$!

  log "  Waiting 25s — boot timer must NOT fire (negative assertion)..."
  sleep 25

  if assert_no_log "$logfile" '\[recovery\] entered:'; then
    ok "Scenario 13: boot timer correctly disarmed by rendererReady ping"
  else
    bad "Scenario 13: recovery entered despite rendererReady ping (boot timer not disarmed)"
    log "Diagnostic — what the page script did (from httpd.log):"
    grep -E 'GET /_marker_' "$TMP_DIR/httpd13.log" 2>/dev/null || log "  (no markers — script did not run at all)"
    log "Last 20 lines of app log:"
    tail -n 20 "$logfile" || true
  fi

  kill_app "$pid"
  kill "$httpd_pid" 2>/dev/null || true
  wait "$httpd_pid" 2>/dev/null || true
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
  scenario_13_ping_disarms_timer

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
