#!/usr/bin/env bash
# ============================================================
# Backspace — Production Installer
# ============================================================
# Sets up Backspace on a Linux server in one of three deployment modes,
# auto-detecting which one fits your environment:
#
#   allinone  The bundled Caddy owns ports 80/443 and does automatic HTTPS
#             for your domain. The simplest setup — pick this if 80/443 are free.
#   proxy     You already run a reverse proxy (nginx, Traefik, Caddy, Nginx Proxy
#             Manager, SWAG…). Backspace is published on 127.0.0.1:APP_PORT and
#             the installer prints ready-to-paste proxy config. No bundled Caddy.
#   tunnel    You expose the box through a tunnel (Cloudflare Tunnel, Tailscale…).
#             Same as proxy, plus tunnel-specific guidance. (Voice does not work
#             over a tunnel — WebRTC/UDP can't traverse it.)
#
# Usage:
#   ./install.sh                    Interactive setup (auto-detects the mode)
#
#   Non-interactive — set any/all of these to skip the matching prompt:
#     DOMAIN=chat.example.com \
#     DEPLOY_MODE=allinone|proxy|tunnel \
#     APP_PORT=8080 \                 # proxy/tunnel only; auto-picked if unset
#     ENABLE_VOICE=true \
#     INSTANCE_NAME="My Chat" \
#     ./install.sh
#
#   BACKSPACE_BUILD=true ./install.sh  Force a local from-source build instead of
#                                      pulling the prebuilt image (fork operators).
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
  # `|| yn=""` so an EOF (non-interactive / piped stdin) doesn't trip `set -e`;
  # an empty answer then falls through to the [Y/n] default of installing.
  read -rp "Install Docker now? [Y/n] " yn || yn=""
  if [[ "${yn,,}" == "n" ]]; then
    error "Docker is required. Install it and re-run this script."
    exit 1
  fi
  info "Installing Docker via official script..."
  curl -fsSL https://get.docker.com | sh
  sudo systemctl enable --now docker 2>/dev/null || true
  # Resolve the current user via `id -un`, not $USER: under `set -u`, $USER is
  # not guaranteed to be set (sudo, `su` without -l, cron, some `docker exec`
  # contexts) and an unset reference would abort the script right after Docker
  # was installed, leaving it half-configured.
  run_user="$(id -un)"
  sudo usermod -aG docker "$run_user"
  warn "Added $run_user to docker group. You may need to log out and back in."
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

# ── Port helpers ────────────────────────────────────────────
# A host port can be held in two ways this installer must detect:
#   1. A normal listening socket (host process)          → visible via `ss -tln`.
#   2. A Docker-published port. With the userland proxy *disabled*
#      (`userland-proxy: false`, common on tuned hosts), Docker DNATs the port
#      with iptables and there is NO listening socket for `ss` to see. So we must
#      also consult `docker ps` — otherwise a box whose Caddy already owns 80/443
#      via iptables would be misreported as "ports free".

# Does any running container publish this host port? (matches "…:<port>->" in the
# Ports column; the ":" before the port and "->" after pin it to the HOST port,
# so :80 doesn't match :8080 and never matches the container-side port.)
docker_publishes_port() {
  $DOCKER ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -qE ":${1}->"
}

# Same, but ignore Backspace's own container (used when re-running on a host that
# already runs this instance — its published port must not count as a conflict).
docker_publishes_port_other() {
  $DOCKER ps --format '{{.Names}} {{.Ports}}' 2>/dev/null \
    | grep -vE '^backspace ' | grep -qE ":${1}->"
}

# Is the port in use by anything (host socket OR any container)?
port_in_use() {
  local port=$1
  if ss -tln 2>/dev/null | grep -qE ":${port}[[:space:]]"; then
    return 0
  fi
  docker_publishes_port "$port"
}

# In use by something OTHER than our own Backspace container?
port_in_use_by_other() {
  local port=$1
  if ss -tln 2>/dev/null | grep -qE ":${port}[[:space:]]"; then
    return 0
  fi
  docker_publishes_port_other "$port"
}

# Best-effort human description of what holds a port (for helpful warnings).
port_holder() {
  local port=$1 holder=""
  holder=$($DOCKER ps --format '{{.Names}} {{.Ports}}' 2>/dev/null \
    | grep -E ":${port}->" | awk '{print $1}' | head -1 || true)
  if [[ -n "$holder" ]]; then
    echo "docker container '$holder'"
    return
  fi
  holder=$(ss -tlnp 2>/dev/null | grep -E ":${port}[[:space:]]" \
    | grep -oP 'users:\(\("\K[^"]+' | head -1 || true)
  echo "${holder:-another process}"
}

# ── openssl (needed for secret generation) ──────────────────
if ! command -v openssl &>/dev/null; then
  error "openssl is required for generating secrets."
  error "Install: sudo apt-get install openssl"
  exit 1
fi

# Disk space check
available_kb=$(df -k . 2>/dev/null | tail -1 | awk '{print $4}' || true)
if [[ -n "$available_kb" ]] && (( available_kb < 3000000 )); then
  warn "Low disk space: $((available_kb / 1024))MB available (recommend 3GB+)"
  warn "The prebuilt image (~1.6GB pulled) needs less than a from-source build."
else
  success "Disk space OK"
fi

# ── Phase 2: Configuration ─────────────────────────────────

step "Configuration"

# Detect existing installation
if [[ -f .env ]]; then
  info "Existing .env detected — secrets and settings will be preserved."
fi

# Helper: read existing .env value (|| true prevents set -e from killing
# the script when grep finds no match and returns exit code 1)
env_val() {
  if [[ -f .env ]]; then
    grep "^${1}=" .env 2>/dev/null | head -1 | cut -d= -f2- || true
  fi
}

# ── Deployment mode ─────────────────────────────────────────
# Precedence: explicit DEPLOY_MODE env → existing .env → auto-detect + prompt.
# Auto-detect never dead-ends: if 80/443 are taken, All-in-One is simply off the
# menu and we steer the operator to proxy/tunnel instead.

existing_mode=$(env_val DEPLOY_MODE)
CADDY_RUNNING=false
if $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -q '^caddy$'; then
  CADDY_RUNNING=true
fi

port80_free=true; port443_free=true
port_in_use 80  && port80_free=false
port_in_use 443 && port443_free=false

choose_mode_interactively() {
  # Writes the chosen mode to the global DEPLOY_MODE.
  local choice=""
  if [[ "$port80_free" == true && "$port443_free" == true ]]; then
    echo "  Ports 80 and 443 are free — All-in-One (bundled Caddy + auto-HTTPS) is available."
    echo ""
    echo "  How do you want to expose Backspace?"
    echo -e "    ${BOLD}1)${NC} All-in-One — bundled Caddy handles HTTPS for you   ${GREEN}(recommended)${NC}"
    echo -e "    ${BOLD}2)${NC} Behind my own reverse proxy (nginx, Traefik, Caddy, Nginx Proxy Manager, SWAG…)"
    echo -e "    ${BOLD}3)${NC} Behind a tunnel (Cloudflare Tunnel, Tailscale…)"
    echo ""
    read -rp "  Choice [1]: " choice || choice=""
    case "${choice:-1}" in
      1) DEPLOY_MODE=allinone ;;
      2) DEPLOY_MODE=proxy ;;
      3) DEPLOY_MODE=tunnel ;;
      *) DEPLOY_MODE=allinone ;;
    esac
  else
    warn "Ports 80/443 are already in use on this host:"
    [[ "$port80_free"  == false ]] && echo "      80  → held by $(port_holder 80)"
    [[ "$port443_free" == false ]] && echo "      443 → held by $(port_holder 443)"
    echo ""
    info "All-in-One needs 80 and 443 free, so it's unavailable here."
    info "That's fine — run Backspace behind what already owns those ports:"
    echo ""
    echo -e "    ${BOLD}1)${NC} Behind my own reverse proxy (nginx, Traefik, Caddy, Nginx Proxy Manager, SWAG…)   ${GREEN}(recommended)${NC}"
    echo -e "    ${BOLD}2)${NC} Behind a tunnel (Cloudflare Tunnel, Tailscale…)"
    echo -e "    ${BOLD}3)${NC} Nothing yet — I'll free 80/443 and use All-in-One (exit so I can do that)"
    echo ""
    read -rp "  Choice [1]: " choice || choice=""
    case "${choice:-1}" in
      1) DEPLOY_MODE=proxy ;;
      2) DEPLOY_MODE=tunnel ;;
      3)
        error "Free ports 80 and 443, then re-run ./install.sh for All-in-One mode."
        exit 1
        ;;
      *) DEPLOY_MODE=proxy ;;
    esac
  fi
}

if [[ -n "${DEPLOY_MODE:-}" ]]; then
  info "Deployment mode: ${DEPLOY_MODE} (from environment)"
elif [[ -n "$existing_mode" ]]; then
  DEPLOY_MODE="$existing_mode"
  info "Deployment mode: ${DEPLOY_MODE} (from existing .env)"
  info "To switch modes, re-run with DEPLOY_MODE=allinone|proxy|tunnel."
elif [[ -t 0 ]]; then
  echo ""
  choose_mode_interactively
else
  # Non-interactive with no DEPLOY_MODE: pick a safe, never-dead-end default.
  if [[ "$port80_free" == true && "$port443_free" == true ]]; then
    DEPLOY_MODE=allinone
  else
    DEPLOY_MODE=proxy
    warn "Ports 80/443 are in use and no DEPLOY_MODE was given — defaulting to 'proxy'."
  fi
  info "Deployment mode: ${DEPLOY_MODE} (auto-detected)"
fi

case "$DEPLOY_MODE" in
  allinone|proxy|tunnel) ;;
  *)
    error "Invalid DEPLOY_MODE='${DEPLOY_MODE}'. Use allinone, proxy, or tunnel."
    exit 1
    ;;
esac

# All-in-One requires 80/443 — but a re-run over an existing All-in-One instance
# legitimately finds *its own* Caddy holding them (an upgrade), which is fine.
if [[ "$DEPLOY_MODE" == "allinone" ]]; then
  if [[ "$CADDY_RUNNING" == true ]]; then
    success "Caddy is already running (All-in-One upgrade)"
  elif [[ "$port80_free" == false || "$port443_free" == false ]]; then
    error "All-in-One mode needs ports 80 and 443 free, but:"
    [[ "$port80_free"  == false ]] && error "  80  is held by $(port_holder 80)"
    [[ "$port443_free" == false ]] && error "  443 is held by $(port_holder 443)"
    error "Free them, or re-run with DEPLOY_MODE=proxy (or =tunnel) to run behind them."
    exit 1
  else
    success "Ports 80 and 443 are available"
  fi
fi

# In proxy/tunnel mode, layer the proxy override so Caddy is dropped and the app
# is published on a loopback port. Compose reads COMPOSE_FILE (from the shell and
# from .env) to pick up both files for every command — the operator never needs
# to remember `-f` flags afterwards.
if [[ "$DEPLOY_MODE" == "proxy" || "$DEPLOY_MODE" == "tunnel" ]]; then
  export COMPOSE_FILE="docker-compose.yml:docker-compose.proxy.yml"
else
  unset COMPOSE_FILE 2>/dev/null || true
fi

# ── Domain ──────────────────────────────────────────────────
# Required in every mode: it's the public hostname clients use and it drives the
# federation identity + LiveKit URL. In proxy/tunnel mode TLS is terminated at
# your edge, but the app still advertises https://DOMAIN.

existing_domain=$(env_val DOMAIN)
if [[ -n "${DOMAIN:-}" ]]; then
  :
elif [[ -n "$existing_domain" ]]; then
  read -rp "Domain [$existing_domain]: " DOMAIN || DOMAIN=""
  DOMAIN="${DOMAIN:-$existing_domain}"
else
  read -rp "Domain (e.g., chat.example.com): " DOMAIN || DOMAIN=""
fi

if [[ -z "${DOMAIN:-}" ]]; then
  error "Domain is required. Set it via the DOMAIN environment variable or enter it interactively."
  exit 1
fi

# DNS verification is meaningful for All-in-One (Caddy must reach this host to
# issue a certificate). In proxy/tunnel mode the DNS record points at your proxy
# or tunnel edge — often NOT this host's IP (that's the whole point) — so we only
# note what it resolves to, without warning about a mismatch.
info "Checking DNS for ${DOMAIN}..."
resolved_ip=""
if command -v dig &>/dev/null; then
  resolved_ip=$(dig +short "$DOMAIN" A 2>/dev/null | tail -1 || true)
elif command -v getent &>/dev/null; then
  resolved_ip=$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || true)
fi

if [[ "$DEPLOY_MODE" == "allinone" ]]; then
  my_ip=$(curl -s4 --connect-timeout 5 ifconfig.me 2>/dev/null || curl -s4 --connect-timeout 5 icanhazip.com 2>/dev/null || echo "")
  if [[ -z "$resolved_ip" ]]; then
    warn "Could not resolve ${DOMAIN}. Ensure DNS is configured before Caddy can issue certificates."
  elif [[ -n "$my_ip" && "$resolved_ip" != "$my_ip" ]]; then
    warn "${DOMAIN} resolves to ${resolved_ip}, but this server appears to be ${my_ip}"
    warn "Let's Encrypt certificate issuance may fail if DNS doesn't point here."
  else
    success "${DOMAIN} resolves to ${resolved_ip:-verified}"
  fi
else
  if [[ -n "$resolved_ip" ]]; then
    info "${DOMAIN} currently resolves to ${resolved_ip} (should point at your proxy/tunnel edge)."
  else
    info "${DOMAIN} does not resolve yet — point it at your proxy/tunnel edge when ready."
  fi
fi

# ── App port (proxy / tunnel only) ──────────────────────────
# The loopback host port your proxy/tunnel forwards to. Auto-picked to avoid
# common clashes (3000/8080 are frequently taken) unless APP_PORT is set.

pick_free_port() {
  if [[ -n "${APP_PORT:-}" ]]; then
    if port_in_use_by_other "$APP_PORT"; then
      error "Requested APP_PORT=$APP_PORT is already in use by $(port_holder "$APP_PORT")."
      exit 1
    fi
    echo "$APP_PORT"; return
  fi
  local existing; existing=$(env_val APP_PORT)
  if [[ -n "$existing" ]]; then
    # Re-run: keep the existing port so the proxy/tunnel config stays valid, even
    # though our own container is currently publishing it.
    echo "$existing"; return
  fi
  local p
  for p in 8080 8081 8082 8090 8095 3001 3002 18080 28080; do
    if ! port_in_use "$p"; then echo "$p"; return; fi
  done
  for p in $(seq 8100 8200); do
    if ! port_in_use "$p"; then echo "$p"; return; fi
  done
  error "Could not find a free host port for the app. Set APP_PORT to a free port and re-run."
  exit 1
}

APP_PORT_FINAL=""
if [[ "$DEPLOY_MODE" == "proxy" || "$DEPLOY_MODE" == "tunnel" ]]; then
  APP_PORT_FINAL="$(pick_free_port)"
  success "App will be published on 127.0.0.1:${APP_PORT_FINAL}"
fi

# ── Voice/Video ─────────────────────────────────────────────
# Voice needs open UDP media ports and (in proxy mode) a /livekit route. Over a
# tunnel, WebRTC/UDP cannot traverse the edge at all — so voice is force-disabled
# in tunnel mode rather than silently configured and then failing at call time.

existing_profiles=$(env_val COMPOSE_PROFILES)
if [[ "$DEPLOY_MODE" == "tunnel" ]]; then
  if [[ "${ENABLE_VOICE:-}" == "true" ]]; then
    warn "Voice cannot work over a tunnel (WebRTC/UDP can't traverse it) — disabling it."
  fi
  ENABLE_VOICE=false
  info "Voice/video is disabled in tunnel mode (a known, unavoidable limitation)."
elif [[ -n "${ENABLE_VOICE:-}" ]]; then
  :
elif [[ "$existing_profiles" == *"voice"* ]]; then
  read -rp "Voice/video is currently enabled. Keep it? [Y/n] " yn || yn=""
  ENABLE_VOICE=$([[ "${yn,,}" == "n" ]] && echo false || echo true)
else
  if [[ "$DEPLOY_MODE" == "proxy" ]]; then
    info "Voice needs open UDP media ports AND a /livekit route in your proxy (snippet printed at the end)."
  fi
  read -rp "Enable voice/video? (requires open UDP ports) [Y/n] " yn || yn=""
  ENABLE_VOICE=$([[ "${yn,,}" == "n" ]] && echo false || echo true)
fi
ENABLE_VOICE="${ENABLE_VOICE:-true}"

# ── Instance Name ───────────────────────────────────────────

existing_name=$(env_val INSTANCE_NAME)
if [[ -z "${INSTANCE_NAME:-}" ]]; then
  read -rp "Instance name [${existing_name:-Backspace}]: " INSTANCE_NAME || INSTANCE_NAME=""
  INSTANCE_NAME="${INSTANCE_NAME:-${existing_name:-Backspace}}"
fi

# ── Max upload size ─────────────────────────────────────────
# Cloudflare (free/pro) hard-caps request bodies at 100MB, so a 100MB app limit
# lets uploads fail at the edge instead of in-app. In tunnel mode we default the
# cap below that (90MB) with headroom for multipart overhead. An explicit
# MAX_UPLOAD_SIZE (env or existing .env) always wins.
existing_max=$(env_val MAX_UPLOAD_SIZE)
if [[ -n "${MAX_UPLOAD_SIZE:-}" ]]; then
  :
elif [[ -n "$existing_max" ]]; then
  MAX_UPLOAD_SIZE="$existing_max"
elif [[ "$DEPLOY_MODE" == "tunnel" ]]; then
  MAX_UPLOAD_SIZE=94371840   # 90 MB — under Cloudflare's 100MB body cap
else
  MAX_UPLOAD_SIZE=104857600  # 100 MB
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

{
  cat << EOF
# Backspace Configuration
# Generated by install.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")

DOMAIN=${DOMAIN}

# Deployment mode: allinone | proxy | tunnel  (see ./install.sh --help / README)
DEPLOY_MODE=${DEPLOY_MODE}
EOF

  if [[ "$DEPLOY_MODE" == "proxy" || "$DEPLOY_MODE" == "tunnel" ]]; then
    cat << EOF

# Reverse-proxy / tunnel mode: layer the proxy override so the bundled Caddy is
# dropped and the app is published on 127.0.0.1:APP_PORT for your edge to reach.
# COMPOSE_FILE makes every 'docker compose' command in this directory use both
# files automatically — no -f flags needed.
COMPOSE_FILE=docker-compose.yml:docker-compose.proxy.yml
APP_PORT=${APP_PORT_FINAL}
EOF
  fi

  cat << EOF

# Server
PORT=3000
HOST=0.0.0.0

# Authentication
JWT_SECRET=${JWT_SECRET}

# Registration
REGISTRATION_OPEN=true

# Max upload size in bytes
MAX_UPLOAD_SIZE=${MAX_UPLOAD_SIZE}
EOF

  if [[ "$ENABLE_VOICE" == true ]]; then
    cat << EOF

# LiveKit Voice/Video
LIVEKIT_URL=wss://${DOMAIN}/livekit
LIVEKIT_API_KEY=${LIVEKIT_API_KEY}
LIVEKIT_API_SECRET=${LIVEKIT_API_SECRET}

# Activate the LiveKit service in Docker Compose
COMPOSE_PROFILES=voice
EOF
  else
    cat << EOF

# LiveKit Voice/Video (disabled)
# To enable: fill in credentials and add COMPOSE_PROFILES=voice
# LIVEKIT_URL=wss://${DOMAIN}/livekit
# LIVEKIT_API_KEY=
# LIVEKIT_API_SECRET=
EOF
  fi
} > .env

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

# AGPL-3.0 § 13 source offer: bake the running build's git commit into the image
# so GET /api/instance/info advertises the exact source version. Passed straight
# to the build as --build-arg (survives the sudo/non-sudo $COMPOSE split, unlike
# an exported env var). Empty when this isn't a git checkout (e.g. tarball
# install) or git is unavailable → the server treats the commit as null. A pulled
# prebuilt image already carries the commit baked at CI build time.
BUILD_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo '')"

build_from_source() {
  if [[ -n "$BUILD_COMMIT" ]]; then
    info "Building Backspace image from commit ${BUILD_COMMIT} (first build takes a few minutes)..."
  else
    info "Building Backspace image (first build takes a few minutes)..."
  fi
  $COMPOSE build --build-arg BACKSPACE_COMMIT="$BUILD_COMMIT"
}

# Default path: pull the prebuilt multi-arch image (fast, and it spares weak/ARM
# hosts the ~1.6GB local build that OOMs small boxes). Fall back to a from-source
# build if the image can't be pulled (not published yet, private, or offline), or
# if the operator forces a build (BACKSPACE_BUILD=true — e.g. running a fork).
if [[ "${BACKSPACE_BUILD:-false}" == "true" ]]; then
  info "BACKSPACE_BUILD=true — building from source (skipping the prebuilt image)."
  build_from_source
else
  image_ref="${BACKSPACE_IMAGE:-ghcr.io/thezwiss/backspace}:${BACKSPACE_IMAGE_TAG:-latest}"
  info "Fetching prebuilt image ${image_ref} ..."
  if $COMPOSE pull backspace; then
    success "Pulled prebuilt image"
  elif $DOCKER image inspect "$image_ref" >/dev/null 2>&1; then
    # Pull failed (offline / registry hiccup / private) but a usable copy is
    # already on this host (a prior run, an air-gapped `docker load`, or a
    # previous from-source build tagged under this ref) — use it instead of
    # forcing a needless multi-hundred-MB rebuild.
    warn "Could not pull ${image_ref} — using the copy already present on this host."
  else
    warn "Prebuilt image unavailable (not published yet, private, or offline)."
    warn "Falling back to a from-source build — slower, and heavy on low-RAM/ARM hosts."
    build_from_source
  fi
fi

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
  # Pass the name through the container environment (never string-interpolated
  # into the JS source) so names with quotes/spaces/'$' are stored verbatim and
  # can't break or inject into the node -e program.
  $DOCKER exec -e BS_INSTANCE_NAME="$INSTANCE_NAME" -w /app/packages/server backspace node -e '
    const Database = require("better-sqlite3");
    const db = new Database("/app/data/backspace.db");
    const changes = db.prepare("UPDATE instance_settings SET instance_name = ? WHERE id = 1").run(process.env.BS_INSTANCE_NAME).changes;
    db.close();
    if (changes === 0) { console.error("No rows updated"); process.exit(1); }
  ' 2>/dev/null && success "Instance name set to: ${INSTANCE_NAME}" || warn "Could not set instance name (set it manually in admin settings)"
fi

# ── Phase 7.5: Post-deploy reachability check ──────────────
# What's verifiable differs by mode:
#   allinone      → prove https://DOMAIN works end-to-end (Caddy has a valid,
#                   publicly-trusted certificate AND the app answers over it).
#   proxy/tunnel  → prove the app answers on its loopback port (your edge then
#                   fronts it); TLS is your proxy/tunnel's job, not ours to test.

https_status="skipped"
app_reachable="unknown"

if [[ "$DEPLOY_MODE" == "allinone" ]]; then
  if [[ "$healthy" == true ]]; then
    step "Verifying HTTPS"
    https_status="pending"
    # `curl --resolve DOMAIN:443:127.0.0.1` connects to the LOCAL Caddy but
    # presents the real SNI/Host and does full certificate verification. A pass
    # proves a valid public cert is installed AND the app answers over it — and
    # it's hairpin-safe (many self-hosted boxes can't reach their own public IP).
    info "Checking for a valid TLS certificate on ${DOMAIN} (Caddy issues it on first start)..."
    for i in $(seq 1 15); do
      if curl -fsS --max-time 6 --resolve "${DOMAIN}:443:127.0.0.1" "https://${DOMAIN}/api/health" >/dev/null 2>&1; then
        https_status="live"
        break
      fi
      sleep 2
    done
    if [[ "$https_status" == "live" ]]; then
      success "HTTPS is live — a valid TLS certificate is installed and Backspace is serving over it."
    else
      warn "HTTPS is not live yet — Caddy hasn't obtained a publicly-trusted certificate."
    fi
  fi
else
  if [[ "$healthy" == true ]]; then
    step "Verifying the app"
    app_reachable="no"
    for i in $(seq 1 10); do
      if curl -fsS --max-time 6 "http://127.0.0.1:${APP_PORT_FINAL}/api/health" >/dev/null 2>&1; then
        app_reachable="yes"
        break
      fi
      sleep 1
    done
    if [[ "$app_reachable" == "yes" ]]; then
      success "Backspace is answering on http://127.0.0.1:${APP_PORT_FINAL} — point your $( [[ "$DEPLOY_MODE" == tunnel ]] && echo tunnel || echo 'reverse proxy') at it."
    else
      warn "Could not reach http://127.0.0.1:${APP_PORT_FINAL}/api/health yet — check: docker compose logs backspace"
    fi
  fi
fi

# ── Reverse-proxy / tunnel snippet generators ──────────────
# Paste-ready configs with WebSocket upgrade, X-Forwarded-*, and a body-size cap
# already correct. Printed for proxy/tunnel modes so the operator's edge routes
# to 127.0.0.1:APP_PORT (and, if voice is on, /livekit → the host LiveKit).

hr()   { echo -e "${CYAN}────────────────────────────────────────────────────────────${NC}"; }
snip() { echo -e "${BOLD}$*${NC}"; }

# Body-size cap in the proxy should match the app's MAX_UPLOAD_SIZE. Express it in
# MB for the human-facing proxy directives (round up so the proxy never rejects a
# body the app would accept).
max_mb=$(( (MAX_UPLOAD_SIZE + 1048575) / 1048576 ))

print_nginx_snippet() {
  snip "nginx  — add the map once inside http { }, then a server block:"
  hr
  cat << EOF
# --- inside http { } (once) --------------------------------
map \$http_upgrade \$connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name ${DOMAIN};

    # Your TLS certs (certbot, your proxy manager, etc.):
    # ssl_certificate     /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;

    client_max_body_size ${max_mb}m;   # match MAX_UPLOAD_SIZE (${MAX_UPLOAD_SIZE} bytes)
EOF
  if [[ "$ENABLE_VOICE" == true ]]; then
    cat << EOF

    # Voice signaling → host-networked LiveKit (strips the /livekit prefix):
    location /livekit/ {
        proxy_pass http://127.0.0.1:7880/;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header Upgrade           \$http_upgrade;
        proxy_set_header Connection        \$connection_upgrade;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
EOF
  fi
  cat << EOF

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT_FINAL};
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host  \$host;
        # WebSocket upgrade (chat, live events, voice signaling):
        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
  hr
}

print_caddy_snippet() {
  snip "Caddy  — if you run your OWN Caddy (it auto-handles WebSocket + HTTPS):"
  hr
  cat << EOF
${DOMAIN} {
EOF
  if [[ "$ENABLE_VOICE" == true ]]; then
    cat << EOF
    handle_path /livekit/* {
        reverse_proxy 127.0.0.1:7880
    }
    handle {
        reverse_proxy 127.0.0.1:${APP_PORT_FINAL}
    }
EOF
  else
    cat << EOF
    reverse_proxy 127.0.0.1:${APP_PORT_FINAL}
EOF
  fi
  cat << EOF
    request_body {
        max_size ${max_mb}MB
    }
}
EOF
  hr
}

print_traefik_snippet() {
  snip "Traefik — dynamic (file-provider) config; Traefik handles WebSocket itself:"
  hr
  cat << EOF
http:
  routers:
    backspace:
      rule: "Host(\`${DOMAIN}\`)"
      entryPoints: [websecure]
      service: backspace
      tls:
        certResolver: letsencrypt
EOF
  if [[ "$ENABLE_VOICE" == true ]]; then
    cat << EOF
    backspace-livekit:
      rule: "Host(\`${DOMAIN}\`) && PathPrefix(\`/livekit\`)"
      entryPoints: [websecure]
      service: backspace-livekit
      priority: 100
      middlewares: [strip-livekit]
      tls:
        certResolver: letsencrypt
  middlewares:
    strip-livekit:
      stripPrefix:
        prefixes: ["/livekit"]
EOF
  fi
  cat << EOF
  services:
    backspace:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:${APP_PORT_FINAL}"
EOF
  if [[ "$ENABLE_VOICE" == true ]]; then
    cat << EOF
    backspace-livekit:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:7880"
EOF
  fi
  hr
}

print_tunnel_snippet() {
  snip "Cloudflare Tunnel — ingress rule (cloudflared config.yml):"
  hr
  cat << EOF
tunnel: <YOUR-TUNNEL-ID>
credentials-file: /root/.cloudflared/<YOUR-TUNNEL-ID>.json

ingress:
  - hostname: ${DOMAIN}
    service: http://127.0.0.1:${APP_PORT_FINAL}
  - service: http_status:404
EOF
  hr
  echo "  Then map the hostname to the tunnel (once):"
  echo -e "    ${BOLD}cloudflared tunnel route dns <YOUR-TUNNEL-ID> ${DOMAIN}${NC}"
}

# ── Phase 8: Summary ───────────────────────────────────────

step "Backspace is running"

echo -e "  ${BOLD}URL:${NC}       https://${DOMAIN}"
echo -e "  ${BOLD}Instance:${NC}  ${INSTANCE_NAME}"
echo -e "  ${BOLD}Mode:${NC}      ${DEPLOY_MODE}"
echo -e "  ${BOLD}Voice:${NC}     $(if [[ "$ENABLE_VOICE" == true ]]; then echo 'Enabled'; else echo 'Disabled'; fi)"

if [[ "$DEPLOY_MODE" == "allinone" ]]; then
  case "$https_status" in
    live)    echo -e "  ${BOLD}HTTPS:${NC}     ${GREEN}Live${NC}" ;;
    pending) echo -e "  ${BOLD}HTTPS:${NC}     ${YELLOW}Not live yet${NC}" ;;
  esac
  echo ""
  if [[ "$https_status" == "pending" ]]; then
    echo -e "  ${YELLOW}The app is up, but HTTPS isn't live yet — Caddy is still trying to get a certificate.${NC}"
    echo -e "  ${YELLOW}This is normal right after install; it comes up automatically once BOTH are true:${NC}"
    echo "    1. ${DOMAIN} resolves to THIS host's public IP"
    echo "    2. Ports 80 and 443 are open and forwarded to this host from the internet"
    echo -e "  Watch progress:  ${BOLD}docker compose logs -f caddy${NC}"
    echo ""
    echo -e "  ${YELLOW}Then open https://${DOMAIN} and create the first account — it becomes the instance admin.${NC}"
  else
    echo -e "  ${YELLOW}Open https://${DOMAIN} and create the first account — it becomes the instance admin.${NC}"
  fi

  echo ""
  # Best-effort primary LAN IP (the address a router would port-forward to).
  LAN_IP=$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[0-9.]+' | head -1 || true)
  echo -e "  ${BOLD}Ports to open${NC} — on this host's firewall (ufw / firewalld / cloud"
  echo -e "  security group)${BOLD} and,${NC} if the host is behind a router, also"
  echo -e "  port-forward them to this host${LAN_IP:+ (${LAN_IP})}:"
  echo ""
  echo "    80/TCP            HTTP  — cert challenge + HTTP→HTTPS redirect      (required)"
  echo "    443/TCP           HTTPS — web app, API, WebSocket, LiveKit signal   (required)"
  if [[ "$ENABLE_VOICE" == true ]]; then
    echo "    3478/UDP          TURN  — WebRTC NAT traversal                       (voice)"
    echo "    7881/TCP          WebRTC TCP fallback                              (voice)"
    echo "    50000-60000/UDP   WebRTC media — voice / video / screen-share      (voice)"
  fi
  echo ""
  echo -e "  ${YELLOW}80 and 443 must be reachable from the internet before HTTPS can come up.${NC}"
  if [[ "$ENABLE_VOICE" == true ]]; then
    echo -e "  ${YELLOW}Voice/video won't connect until the voice ports above are reachable too.${NC}"
  fi
  echo -e "  LiveKit's own signaling port (7880) stays internal — do ${BOLD}not${NC} forward it."

elif [[ "$DEPLOY_MODE" == "proxy" ]]; then
  echo ""
  echo -e "  Backspace listens on ${BOLD}127.0.0.1:${APP_PORT_FINAL}${NC} (loopback only — never expose it directly)."
  echo -e "  Point your reverse proxy at it, then open ${BOLD}https://${DOMAIN}${NC} and register the first account (it becomes admin)."
  echo ""
  echo -e "  ${BOLD}Paste one of these into your reverse proxy${NC} (WebSocket, X-Forwarded-*, and body cap already set):"
  echo ""
  print_nginx_snippet
  echo ""
  print_caddy_snippet
  echo ""
  print_traefik_snippet
  echo ""
  echo -e "  ${BOLD}Nginx Proxy Manager / other GUI proxies:${NC} see the field-by-field guide"
  echo -e "  in the README → 'Deployment modes' (forward to 127.0.0.1:${APP_PORT_FINAL}, enable"
  echo -e "  'Websockets Support', and set client_max_body_size ${max_mb}m in the Advanced tab)."
  if [[ "$ENABLE_VOICE" == true ]]; then
    echo ""
    echo -e "  ${YELLOW}Voice is enabled — in addition to the /livekit route above, open these UDP/TCP${NC}"
    echo -e "  ${YELLOW}media ports on the firewall and forward them to this host:${NC}"
    echo "    3478/UDP          TURN  — WebRTC NAT traversal"
    echo "    7881/TCP          WebRTC TCP fallback"
    echo "    50000-60000/UDP   WebRTC media — voice / video / screen-share"
    echo -e "  ${YELLOW}Media flows host→client directly, NOT through your reverse proxy.${NC}"
  fi

elif [[ "$DEPLOY_MODE" == "tunnel" ]]; then
  echo ""
  echo -e "  Backspace listens on ${BOLD}127.0.0.1:${APP_PORT_FINAL}${NC} (loopback only). Your tunnel fronts it."
  echo -e "  Once the ingress rule is live, open ${BOLD}https://${DOMAIN}${NC} and register the first account (it becomes admin)."
  echo ""
  print_tunnel_snippet
  echo ""
  echo -e "  ${YELLOW}Upload cap:${NC} MAX_UPLOAD_SIZE is set to ${max_mb}MB to stay under Cloudflare's 100MB"
  echo -e "  request-body limit. Raising it above ~100MB will make large uploads fail at the edge."
  echo ""
  echo -e "  ${YELLOW}Voice/video is not available over a tunnel${NC} — WebRTC/UDP media can't traverse it."
  echo -e "  If you need voice, run Backspace behind a reverse proxy (proxy mode) with the"
  echo -e "  media ports opened, or use All-in-One with ports 80/443."
fi

echo ""
echo -e "  ${BOLD}Commands${NC} (run from this directory):"
echo "    docker compose logs -f          # Watch logs"
echo "    docker compose restart          # Restart all services"
echo "    docker compose down             # Stop everything"
echo "    docker compose pull && docker compose up -d   # Update to the latest prebuilt image"
echo ""
