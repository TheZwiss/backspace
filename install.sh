#!/usr/bin/env bash
# ============================================================
# Backspace — Production Installer
# ============================================================
# Sets up Backspace with Caddy (auto-HTTPS) and optional
# LiveKit (voice/video) on a Linux server.
#
# Usage:
#   ./install.sh                    Interactive setup
#   DOMAIN=chat.example.com ./install.sh   Non-interactive
# ============================================================

set -euo pipefail

# ── Output helpers ──────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}  OK ${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERR]${NC} $*" >&2; }

step() {
  echo ""
  echo -e "${BOLD}${CYAN}─── $* ───${NC}"
  echo ""
}

# Track whether we need sudo for docker commands
DOCKER="docker"
COMPOSE="docker compose"

# ── Phase 1: Prerequisites ─────────────────────────────────

step "Checking prerequisites"

# Must be Linux — host networking (LiveKit) is Linux-only
if [[ "$(uname -s)" != "Linux" ]]; then
  error "Backspace production deployment requires Linux."
  error "Detected: $(uname -s)"
  error "For development, use: pnpm dev"
  exit 1
fi
success "Linux detected"

# Check Docker
if ! command -v docker &>/dev/null; then
  warn "Docker is not installed."
  read -rp "Install Docker now? [Y/n] " yn
  if [[ "${yn,,}" == "n" ]]; then
    error "Docker is required. Install it and re-run this script."
    exit 1
  fi
  info "Installing Docker via official script..."
  curl -fsSL https://get.docker.com | sh
  sudo systemctl enable --now docker 2>/dev/null || true
  sudo usermod -aG docker "$USER"
  warn "Added $USER to docker group. You may need to log out and back in."
  # Use sudo for the rest of this session
  DOCKER="sudo docker"
  COMPOSE="sudo docker compose"
else
  # Check if current user can talk to Docker daemon
  if ! docker info &>/dev/null 2>&1; then
    if sudo docker info &>/dev/null 2>&1; then
      DOCKER="sudo docker"
      COMPOSE="sudo docker compose"
    else
      error "Cannot connect to Docker daemon."
      error "Is Docker running? Try: sudo systemctl start docker"
      exit 1
    fi
  fi
  success "Docker $(docker --version 2>/dev/null | grep -oP '\d+\.\d+\.\d+' || echo 'installed')"
fi

# Check Docker Compose
if ! $COMPOSE version &>/dev/null 2>&1; then
  error "Docker Compose plugin is not installed."
  error "Install: https://docs.docker.com/compose/install/linux/"
  exit 1
fi
success "Docker Compose $($COMPOSE version --short 2>/dev/null || echo 'installed')"

# Check if ports 80/443 are available
check_port() {
  local port=$1
  if ss -tlnp 2>/dev/null | grep -qE ":${port}\b"; then
    local proc
    proc=$(ss -tlnp 2>/dev/null | grep -E ":${port}\b" | grep -oP 'users:\(\("\K[^"]+' | head -1 || echo "unknown")
    error "Port $port is already in use by: $proc"
    error "Free port $port before running this script."
    return 1
  fi
  return 0
}

# Only check ports if we're NOT already running (upgrade scenario)
if ! $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -q '^caddy$'; then
  port_ok=true
  check_port 80  || port_ok=false
  check_port 443 || port_ok=false
  if [[ "$port_ok" == false ]]; then
    exit 1
  fi
  success "Ports 80 and 443 are available"
else
  success "Caddy is already running (upgrade mode)"
fi

# Disk space check
available_kb=$(df -k . 2>/dev/null | tail -1 | awk '{print $4}')
if [[ -n "$available_kb" ]] && (( available_kb < 3000000 )); then
  warn "Low disk space: $((available_kb / 1024))MB available (recommend 3GB+)"
else
  success "Disk space OK"
fi

# Check for openssl (needed for secret generation)
if ! command -v openssl &>/dev/null; then
  error "openssl is required for generating secrets."
  error "Install: sudo apt-get install openssl"
  exit 1
fi

# ── Phase 2: Configuration ─────────────────────────────────

step "Configuration"

# Detect existing installation
EXISTING_ENV=false
if [[ -f .env ]]; then
  EXISTING_ENV=true
  info "Existing .env detected — secrets will be preserved."
fi

# Helper: read existing .env value
env_val() {
  if [[ -f .env ]]; then
    grep "^${1}=" .env 2>/dev/null | head -1 | cut -d= -f2-
  fi
}

# ── Domain ──────────────────────────────────────────────────

existing_domain=$(env_val DOMAIN)
if [[ -n "${DOMAIN:-}" ]]; then
  # Non-interactive: DOMAIN set via environment
  :
elif [[ -n "$existing_domain" ]]; then
  read -rp "Domain [$existing_domain]: " DOMAIN
  DOMAIN="${DOMAIN:-$existing_domain}"
else
  read -rp "Domain (e.g., chat.example.com): " DOMAIN
fi

if [[ -z "${DOMAIN:-}" ]]; then
  error "Domain is required. Set it via the DOMAIN environment variable or enter it interactively."
  exit 1
fi

# DNS verification
info "Verifying DNS for ${DOMAIN}..."
resolved_ip=""
if command -v dig &>/dev/null; then
  resolved_ip=$(dig +short "$DOMAIN" A 2>/dev/null | tail -1)
elif command -v getent &>/dev/null; then
  resolved_ip=$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1)
fi

my_ip=$(curl -s4 --connect-timeout 5 ifconfig.me 2>/dev/null || curl -s4 --connect-timeout 5 icanhazip.com 2>/dev/null || echo "")

if [[ -z "$resolved_ip" ]]; then
  warn "Could not resolve ${DOMAIN}. Ensure DNS is configured before Caddy can issue certificates."
elif [[ -n "$my_ip" && "$resolved_ip" != "$my_ip" ]]; then
  warn "${DOMAIN} resolves to ${resolved_ip}, but this server appears to be ${my_ip}"
  warn "Let's Encrypt certificate issuance may fail if DNS doesn't point here."
else
  success "${DOMAIN} resolves to ${resolved_ip:-verified}"
fi

# ── Voice/Video ─────────────────────────────────────────────

existing_profiles=$(env_val COMPOSE_PROFILES)
if [[ -n "${ENABLE_VOICE:-}" ]]; then
  # Non-interactive
  :
elif [[ "$existing_profiles" == *"voice"* ]]; then
  read -rp "Voice/video is currently enabled. Keep it? [Y/n] " yn
  ENABLE_VOICE=$([[ "${yn,,}" == "n" ]] && echo false || echo true)
else
  read -rp "Enable voice/video? (requires open UDP ports) [Y/n] " yn
  ENABLE_VOICE=$([[ "${yn,,}" == "n" ]] && echo false || echo true)
fi
ENABLE_VOICE="${ENABLE_VOICE:-true}"

# ── Instance Name ───────────────────────────────────────────

existing_name=$(env_val INSTANCE_NAME)
if [[ -z "${INSTANCE_NAME:-}" ]]; then
  read -rp "Instance name [${existing_name:-Backspace}]: " INSTANCE_NAME
  INSTANCE_NAME="${INSTANCE_NAME:-${existing_name:-Backspace}}"
fi

# ── Phase 3: Generate Secrets ───────────────────────────────

step "Generating configuration"

# Preserve existing secrets, generate new ones where missing
JWT_SECRET=$(env_val JWT_SECRET)
if [[ -z "$JWT_SECRET" || "$JWT_SECRET" == "change_me"* ]]; then
  JWT_SECRET=$(openssl rand -hex 32)
  info "Generated new JWT_SECRET"
else
  info "Preserved existing JWT_SECRET"
fi

LIVEKIT_API_KEY=$(env_val LIVEKIT_API_KEY)
LIVEKIT_API_SECRET=$(env_val LIVEKIT_API_SECRET)
if [[ "$ENABLE_VOICE" == true ]]; then
  if [[ -z "$LIVEKIT_API_KEY" ]]; then
    LIVEKIT_API_KEY="API$(openssl rand -hex 8)"
    info "Generated new LIVEKIT_API_KEY"
  else
    info "Preserved existing LIVEKIT_API_KEY"
  fi
  if [[ -z "$LIVEKIT_API_SECRET" ]]; then
    LIVEKIT_API_SECRET=$(openssl rand -hex 24)
    info "Generated new LIVEKIT_API_SECRET"
  else
    info "Preserved existing LIVEKIT_API_SECRET"
  fi
fi

# ── Phase 4: Write Configuration Files ─────────────────────

step "Writing configuration files"

# ── .env ────────────────────────────────────────────────────

cat > .env << EOF
# Backspace Configuration
# Generated by install.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")

DOMAIN=${DOMAIN}

# Server
PORT=3000
HOST=0.0.0.0

# Authentication
JWT_SECRET=${JWT_SECRET}

# Registration
REGISTRATION_OPEN=true

# Max upload size in bytes (100MB)
MAX_UPLOAD_SIZE=104857600
EOF

if [[ "$ENABLE_VOICE" == true ]]; then
  cat >> .env << EOF

# LiveKit Voice/Video
LIVEKIT_URL=wss://${DOMAIN}/livekit
LIVEKIT_API_KEY=${LIVEKIT_API_KEY}
LIVEKIT_API_SECRET=${LIVEKIT_API_SECRET}

# Activate the LiveKit service in Docker Compose
COMPOSE_PROFILES=voice
EOF
else
  cat >> .env << EOF

# LiveKit Voice/Video (disabled)
# To enable: fill in credentials and add COMPOSE_PROFILES=voice
# LIVEKIT_URL=wss://${DOMAIN}/livekit
# LIVEKIT_API_KEY=
# LIVEKIT_API_SECRET=
EOF
fi

success ".env"

# ── livekit.yaml ────────────────────────────────────────────

# Always generate livekit.yaml so docker-compose config doesn't complain
# about a missing bind mount if someone inspects the full compose file.
if [[ "$ENABLE_VOICE" == true ]]; then
  cat > livekit.yaml << EOF
# LiveKit Server Configuration
# Generated by install.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")

port: 7880

rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true

turn:
  enabled: true
  domain: ${DOMAIN}
  udp_port: 3478

keys:
  ${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}

room:
  auto_create: true
  empty_timeout: 300
  departure_timeout: 20

logging:
  level: info
EOF
  success "livekit.yaml"
else
  cat > livekit.yaml << EOF
# LiveKit is disabled. Run install.sh and enable voice to configure.
port: 7880
keys: {}
logging:
  level: info
EOF
  info "livekit.yaml (placeholder — voice disabled)"
fi

# ── Data directory ──────────────────────────────────────────

mkdir -p ./data/uploads
success "data/"

# ── Phase 5: Migrate legacy Docker volume (if present) ─────

if $DOCKER volume inspect backspace-data &>/dev/null 2>&1; then
  if [[ ! -f ./data/backspace.db ]]; then
    step "Migrating data from legacy Docker volume"
    info "Copying backspace-data volume contents to ./data ..."
    $DOCKER run --rm \
      -v backspace-data:/source:ro \
      -v "$(pwd)/data:/target" \
      alpine sh -c "cp -a /source/. /target/"
    success "Data migrated from backspace-data volume to ./data"
    info "The old volume is still intact. Remove it with: docker volume rm backspace-data"
  fi
fi

# Also clean up legacy external network if it exists (no longer needed)
if $DOCKER network inspect backspace-net &>/dev/null 2>&1; then
  info "Legacy backspace-net network detected. It is no longer needed."
  info "Remove after verifying: docker network rm backspace-net"
fi

# ── Phase 6: Build & Deploy ────────────────────────────────

step "Deploying Backspace"

info "Building Backspace image (this may take a few minutes on first run)..."
$COMPOSE build --quiet

info "Starting services..."
$COMPOSE up -d

# Wait for health check
info "Waiting for Backspace to become healthy..."
healthy=false
for i in $(seq 1 60); do
  status=$($DOCKER inspect backspace --format '{{.State.Health.Status}}' 2>/dev/null || echo "waiting")
  if [[ "$status" == "healthy" ]]; then
    healthy=true
    break
  fi
  sleep 2
done

if [[ "$healthy" == true ]]; then
  success "Backspace is healthy"
else
  warn "Health check hasn't passed yet. Check logs: docker compose logs backspace"
fi

# ── Phase 7: Set instance name ──────────────────────────────

if [[ "$healthy" == true && -n "$INSTANCE_NAME" && "$INSTANCE_NAME" != "Backspace" ]]; then
  $DOCKER exec -w /app backspace node -e "
    const Database = require('better-sqlite3');
    const db = new Database('/app/data/backspace.db');
    const changes = db.prepare('UPDATE instance_settings SET instance_name = ? WHERE id = 1').run('${INSTANCE_NAME}').changes;
    db.close();
    if (changes === 0) { console.error('No rows updated'); process.exit(1); }
  " 2>/dev/null && success "Instance name set to: ${INSTANCE_NAME}" || warn "Could not set instance name (set it manually in admin settings)"
fi

# ── Phase 8: Summary ───────────────────────────────────────

step "Backspace is running"

echo -e "  ${BOLD}URL:${NC}       https://${DOMAIN}"
echo -e "  ${BOLD}Admin:${NC}     admin / admin123"
echo -e "  ${BOLD}Instance:${NC}  ${INSTANCE_NAME}"
echo -e "  ${BOLD}Voice:${NC}     $(if [[ "$ENABLE_VOICE" == true ]]; then echo 'Enabled'; else echo 'Disabled'; fi)"
echo ""
echo -e "  ${YELLOW}Change the admin password immediately after first login.${NC}"
echo ""
echo -e "  ${BOLD}Commands:${NC}"
echo "    docker compose logs -f          # Watch logs"
echo "    docker compose restart          # Restart all services"
echo "    docker compose down             # Stop everything"
echo "    docker compose up -d --build    # Rebuild after code changes"

if [[ "$ENABLE_VOICE" == true ]]; then
  echo ""
  echo -e "  ${BOLD}Firewall — open these ports for voice/video:${NC}"
  echo "    3478/UDP          TURN (NAT traversal)"
  echo "    7881/TCP          WebRTC TCP fallback"
  echo "    50000-60000/UDP   WebRTC media"
fi

echo ""
