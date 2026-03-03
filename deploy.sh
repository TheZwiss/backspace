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

declare -A TARGETS=(
  [pi_local]="192.168.1.10"
  [pi_remote]="nova.ddns.net"
  [pi_path]="~/backspace"
  [beta_host]="orbit.ddns.net"
  [beta_path]="~/backspace"
)

# ── Rsync excludes ──────────────────────────────────────────

EXCLUDES=(
  --exclude='node_modules'
  --exclude='.git'
  --exclude='.env'
  --exclude='.env.local'
  --exclude='packages/*/node_modules'
  --exclude='packages/web/dist'
  --exclude='data'
  --exclude='livekit.yaml'
  --exclude='.DS_Store'
  --exclude='Gemini Starter.rtf'
  --exclude='System Prompt.rtf'
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
  ssh "$PI_USER@$host" "cd $path && docker compose up -d --build"

  echo ""
  echo "  Done: $name"
}

# ── Resolve Pi host (LAN or WAN) ───────────────────────────

resolve_pi_host() {
  if ping -c1 -W2 "${TARGETS[pi_local]}" &>/dev/null; then
    echo "${TARGETS[pi_local]}"
  else
    echo "${TARGETS[pi_remote]}"
  fi
}

# ── Parse arguments ─────────────────────────────────────────

TARGET="${1:-all}"

case "$TARGET" in
  pi|--local|--remote|-l|-r)
    if [[ "$TARGET" == "--local" || "$TARGET" == "-l" ]]; then
      PI_HOST="${TARGETS[pi_local]}"
    elif [[ "$TARGET" == "--remote" || "$TARGET" == "-r" ]]; then
      PI_HOST="${TARGETS[pi_remote]}"
    else
      PI_HOST=$(resolve_pi_host)
    fi
    deploy "Pi" "$PI_HOST" "${TARGETS[pi_path]}"
    ;;

  vm|beta|orbit)
    deploy "Beta VM" "${TARGETS[beta_host]}" "${TARGETS[beta_path]}"
    ;;

  all|both)
    PI_HOST=$(resolve_pi_host)
    deploy "Pi" "$PI_HOST" "${TARGETS[pi_path]}"
    deploy "Beta VM" "${TARGETS[beta_host]}" "${TARGETS[beta_path]}"
    ;;

  *)
    echo "Usage: ./deploy.sh [pi|vm|all|--local|--remote]"
    exit 1
    ;;
esac

echo ""
echo "Deployment complete."
