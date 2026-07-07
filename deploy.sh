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

# ── Build metadata ──────────────────────────────────────────
# AGPL-3.0 § 13 source offer: capture the git commit locally and pass it to the
# remote build. rsync excludes .git, so the remote cannot resolve it itself.
# Empty when git is unavailable → server treats the commit as null.
BUILD_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo '')"

# ── Targets ─────────────────────────────────────────────────

PI_USER="youruser"
PI_LOCAL="192.168.1.10"
PI_REMOTE="nova.ddns.net"
PI_PATH="~/backspace"

BETA_HOST="orbit.ddns.net"
BETA_PATH="~/backspace"

# ── Local target override (gitignored) ──────────────────────
# The values above are public placeholders. A maintainer can point this script
# at real infrastructure by creating ./.deploy.local (git-ignored) that reassigns
# PI_USER / PI_LOCAL / PI_REMOTE / PI_PATH / BETA_HOST / BETA_PATH. This keeps
# real hostnames, IPs, and usernames out of the public repo. Never commit it.
if [[ -f ./.deploy.local ]]; then
  # shellcheck source=/dev/null
  source ./.deploy.local
fi

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
  # Host-owned reverse-proxy config: the Pi's Caddyfile carries extra vhost
  # blocks (e.g. other-site.example.com) that aren't in this repo. Never overwrite it.
  --exclude='Caddyfile'
  --exclude='.DS_Store'
  --exclude='.superpowers'
  --exclude='.claude'
  --exclude='.worktrees'
  --exclude='.playwright-mcp'
  --exclude='Artworks-Backspace'
  --exclude='Old Designs'
  --exclude='outdated trash'
  --exclude='docs/superpowers'
  --exclude='*.rtf'
  --exclude='*.rtfd'
  --exclude='ARCHITECTURE_AUDIT.md'
  --exclude='Backspace-design-prototype.html'
  --exclude='assets/brand'
  --exclude='electronbuild.sh'
  --exclude='multi-platform-roadmap.md'
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
  echo "  [3/4] Building and restarting..."
  # Clean up stale renamed containers left by failed recreates (e.g. "d420a6c00439_backspace")
  ssh "$PI_USER@$host" "cd $path && docker rm -f \$(docker ps -aq --filter 'name=_backspace' 2>/dev/null) 2>/dev/null; BACKSPACE_COMMIT='$BUILD_COMMIT' docker compose up -d --build"

  # Prune old images; keep build cache capped at 2GB for fast rebuilds
  echo "  [4/4] Pruning stale Docker data..."
  ssh "$PI_USER@$host" "docker image prune -af --filter 'until=24h' 2>/dev/null; docker builder prune -f --keep-storage=2GB 2>/dev/null" || true

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
    deploy "Pi" "$PI_HOST" "$PI_PATH" &
    deploy "Beta VM" "$BETA_HOST" "$BETA_PATH" &
    wait
    ;;

  *)
    echo "Usage: ./deploy.sh [pi|vm|all|--local|--remote]"
    exit 1
    ;;
esac

echo ""
echo "Deployment complete."
