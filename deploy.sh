#!/bin/bash
# ============================================================
# Backspace — Quick Deploy Script
# ============================================================
# Syncs code and rebuilds on remote server(s).
#
# Usage:
#   ./deploy.sh              Deploy to both (default)
#   ./deploy.sh pi           Deploy to Pi (nova.ddns.net)
#   ./deploy.sh vm           Deploy to VM (orbit.ddns.net)
#   ./deploy.sh all          Deploy to both
#   ./deploy.sh --local      Force Pi via LAN IP
#   ./deploy.sh --remote     Force Pi via public DNS
# ============================================================

set -euo pipefail
cd "$(dirname "$0")"

# ── Targets ─────────────────────────────────────────────────

PI_USER="youruser"
PI_LOCAL="192.168.1.10"
PI_REMOTE="nova.ddns.net"
PI_PATH="~/backspace"

BETA_HOST="orbit.ddns.net"
BETA_PATH="~/backspace"

# ── Rsync excludes ──────────────────────────────────────────

EXCLUDES=(
  --exclude='node_modules'
  --exclude='.git'
  --exclude='.env'
  --exclude='.env.local'
  --exclude='packages/*/node_modules'
  --exclude='packages/web/dist'
  --exclude='packages/desktop'
  --exclude='installers'
  --exclude='data'
  --exclude='livekit.yaml'
  --exclude='.DS_Store'
  --exclude='.superpowers'
  --exclude='Gemini Starter.rtf'
  --exclude='System Prompt.rtf'
  --exclude='Old Designs'
  --exclude='outdated trash'
  --exclude='*.rtf'
)

# ── Deploy function ─────────────────────────────────────────

deploy() {
  local name="$1"
  local host="$2"
  local path="$3"

  echo ""
  echo "═══ Deploying to $name ($host) ═══"
  echo ""

  # Ensure remote directory exists
  echo "  [1/3] Preparing remote directory..."
  ssh "$PI_USER@$host" "mkdir -p $path"

  # Sync files
  echo "  [2/3] Syncing files..."
  rsync -avz --delete \
    "${EXCLUDES[@]}" \
    ./ "$PI_USER@$host:$path"

  # Rebuild
  echo "  [3/3] Building and restarting..."
  # Clean up stale renamed containers left by failed recreates (e.g. "d420a6c00439_backspace")
  ssh "$PI_USER@$host" "cd $path && docker rm -f \$(docker ps -aq --filter 'name=_backspace' 2>/dev/null) 2>/dev/null; docker compose up -d --build"

  echo ""
  echo "  Done: $name"
}

# ── Resolve Pi host (LAN or WAN) ───────────────────────────

resolve_pi_host() {
  if ping -c1 -W2 "$PI_LOCAL" &>/dev/null; then
    echo "$PI_LOCAL"
  else
    echo "$PI_REMOTE"
  fi
}

# ── Parse arguments ─────────────────────────────────────────

TARGET="${1:-all}"

case "$TARGET" in
  pi|--local|--remote|-l|-r)
    if [[ "$TARGET" == "--local" || "$TARGET" == "-l" ]]; then
      PI_HOST="$PI_LOCAL"
    elif [[ "$TARGET" == "--remote" || "$TARGET" == "-r" ]]; then
      PI_HOST="$PI_REMOTE"
    else
      PI_HOST=$(resolve_pi_host)
    fi
    deploy "Pi" "$PI_HOST" "$PI_PATH"
    ;;

  vm|beta|orbit)
    deploy "Beta VM" "$BETA_HOST" "$BETA_PATH"
    ;;

  all|both)
    PI_HOST=$(resolve_pi_host)
    deploy "Pi" "$PI_HOST" "$PI_PATH"
    deploy "Beta VM" "$BETA_HOST" "$BETA_PATH"
    ;;

  *)
    echo "Usage: ./deploy.sh [pi|vm|all|--local|--remote]"
    exit 1
    ;;
esac

echo ""
echo "Deployment complete."
