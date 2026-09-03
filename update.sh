#!/usr/bin/env bash
# ============================================================
# Backspace — update a running instance
# ============================================================
# Takes a database snapshot, refreshes the checkout where that is possible,
# fetches the new image, restarts only the backspace service, waits for it to
# report healthy, and then verifies the running version actually changed. If any
# of that fails, it puts the previous image back.
#
# Usage:
#   ./update.sh              Update, with one confirmation prompt.
#   ./update.sh --check      Report whether an update exists. Changes nothing.
#   ./update.sh --yes        Update without prompting (for ssh and cron).
#   ./update.sh --no-backup  Skip the pre-update snapshot. Not recommended.
#
# Only the `backspace` service is ever named, and --remove-orphans is never
# passed. Production hosts run other containers in the same compose project and
# behind the same Caddy; an update to Backspace has no business recreating or
# reaping any of them.
# ============================================================

set -euo pipefail
cd "$(dirname "$0")"

# ── Output helpers (matching install.sh) ────────────────────

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
step()    { echo ""; echo -e "${BOLD}${CYAN}─── $* ───${NC}"; echo ""; }

SERVICE="backspace"
CONTAINER="backspace"
HEALTH_TIMEOUT=180
RELEASES_API="https://api.github.com/repos/TheZwiss/backspace/releases/latest"

MODE="update"
ASSUME_YES=false
DO_BACKUP=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)     MODE="check" ;;
    --yes|-y)    ASSUME_YES=true ;;
    --no-backup) DO_BACKUP=false ;;
    --help|-h)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      error "Unknown option: $1"
      error "Run ./update.sh --help for usage."
      exit 1
      ;;
  esac
  shift
done

# ── Reading .env ────────────────────────────────────────────
# Same shape as install.sh's env_val: read a single value without sourcing the
# file, so a stray shell metacharacter in a value cannot execute anything.

env_val() {
  if [[ -f .env ]]; then
    grep "^${1}=" .env 2>/dev/null | head -1 | cut -d= -f2- || true
  fi
}

# ── Phase 1: Preflight ──────────────────────────────────────

step "Checking this install"

if ! command -v docker >/dev/null 2>&1; then
  error "docker is not installed, or is not on PATH."
  exit 1
fi

DOCKER="docker"
COMPOSE="docker compose"
if ! docker info >/dev/null 2>&1; then
  if sudo docker info >/dev/null 2>&1; then
    DOCKER="sudo docker"
    COMPOSE="sudo docker compose"
    info "Using sudo for Docker commands."
  else
    error "Cannot connect to the Docker daemon."
    error "Is Docker running? Try: sudo systemctl start docker"
    exit 1
  fi
fi

if ! $COMPOSE version >/dev/null 2>&1; then
  error "'docker compose' is unavailable. This script needs Compose v2."
  error "On older hosts, upgrade Docker or install the compose plugin."
  exit 1
fi

if [[ ! -f .env ]]; then
  error "No .env in $(pwd)."
  error "Run this from your Backspace install directory, or ./install.sh first."
  exit 1
fi

if [[ ! -f docker-compose.yml ]]; then
  error "No docker-compose.yml in $(pwd)."
  exit 1
fi

# Membership is tested in bash rather than by piping into `grep -q`.
# `grep -q` exits on its first match, which SIGPIPEs the upstream command, and
# under `set -o pipefail` that turns a passing check into a failing one. It
# reported "no backspace service" against a compose file whose first listed
# service is backspace.
contains_line() {
  local haystack="$1" needle="$2"
  [[ $'\n'"$haystack"$'\n' == *$'\n'"$needle"$'\n'* ]]
}

# COMPOSE_FILE lives in .env, and docker compose reads it from there, so proxy
# and tunnel installs resolve both files with no -f flags here.
compose_services="$($COMPOSE config --services 2>/dev/null || true)"
if ! contains_line "$compose_services" "$SERVICE"; then
  error "The compose project here defines no '$SERVICE' service."
  error "Check COMPOSE_FILE in .env, and that you are in the right directory."
  exit 1
fi

running_containers="$($DOCKER ps --format '{{.Names}}' 2>/dev/null || true)"
if ! contains_line "$running_containers" "$CONTAINER"; then
  error "The $CONTAINER container is not running."
  error "Start it first with: $COMPOSE up -d $SERVICE"
  exit 1
fi

success "Compose project and running container found"

# ── Reading the running instance ────────────────────────────

# Asks the app itself rather than inferring from a tag. This is the value the
# update has to move, and step 9 is the only check that catches a container that
# comes up healthy while still running the old code.
running_version() {
  $DOCKER exec "$CONTAINER" node -e '
    const port = process.env.PORT || 3000;
    fetch("http://localhost:" + port + "/api/instance/info")
      .then((r) => r.json())
      .then((j) => { process.stdout.write(String(j.version || "")); })
      .catch(() => { process.exit(1); });
  ' 2>/dev/null || true
}

CURRENT_VERSION="$(running_version)"
if [[ -z "$CURRENT_VERSION" ]]; then
  warn "Could not read the running version from the container."
  warn "The update will proceed, but the post-update version check is skipped."
fi

# The image this container was created from. This exact ID is the rollback
# target, and comparing it after the pull is how a no-op update is detected.
ROLLBACK_IMAGE_ID="$($DOCKER inspect --format '{{.Image}}' "$CONTAINER" 2>/dev/null || true)"
IMAGE_REF="$($DOCKER inspect --format '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)"

if [[ -z "$ROLLBACK_IMAGE_ID" || -z "$IMAGE_REF" ]]; then
  error "Could not determine the image the $CONTAINER container is running."
  error "Refusing to update without a rollback target."
  exit 1
fi

# The reference compose will actually deploy, which is not necessarily the one
# the running container was created from. An operator who repins
# BACKSPACE_IMAGE_TAG in .env changes the former without touching the latter, so
# rolling back against the running container's reference would restore the old
# image under a name compose no longer looks at, and the failed version would
# come straight back up.
target_ref_raw="$($COMPOSE config --images "$SERVICE" 2>/dev/null || true)"
TARGET_REF="${target_ref_raw%%$'\n'*}"
if [[ -z "$TARGET_REF" ]]; then
  TARGET_REF="$IMAGE_REF"
  info "Could not resolve the target image from compose; using $TARGET_REF."
fi

# prebuilt | source | unknown. install.sh records this after its pull/build
# decision resolves. Absent on installs that predate that, which map to unknown
# and are handled by looking at the image reference instead.
INSTALL_CHANNEL="$(env_val BACKSPACE_INSTALL_CHANNEL)"
if [[ -z "$INSTALL_CHANNEL" ]]; then
  if [[ "$IMAGE_REF" == *"/"*"/"* || "$IMAGE_REF" == ghcr.io/* || "$IMAGE_REF" == *.*/* ]]; then
    INSTALL_CHANNEL="prebuilt"
  else
    INSTALL_CHANNEL="unknown"
  fi
  info "No BACKSPACE_INSTALL_CHANNEL in .env; inferred '$INSTALL_CHANNEL' from $IMAGE_REF."
fi

echo ""
echo -e "  Running version   ${BOLD}${CURRENT_VERSION:-unknown}${NC}"
echo -e "  Image             ${IMAGE_REF}"
if [[ "$TARGET_REF" != "$IMAGE_REF" ]]; then
  echo -e "  Target image      ${TARGET_REF}  ${YELLOW}(repinned in .env)${NC}"
fi
echo -e "  Install channel   ${INSTALL_CHANNEL}"

# ── --check: report and exit, touching nothing ──────────────

if [[ "$MODE" == "check" ]]; then
  step "Checking for a newer release"

  fetch_url() {
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL --max-time 10 -H 'Accept: application/vnd.github+json' \
        -H 'User-Agent: Backspace' "$1" 2>/dev/null || true
    elif command -v wget >/dev/null 2>&1; then
      wget -qO- --timeout=10 --header='Accept: application/vnd.github+json' \
        --header='User-Agent: Backspace' "$1" 2>/dev/null || true
    fi
  }

  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    warn "Neither curl nor wget is available, so the latest release cannot be looked up."
    warn "Run ./update.sh to pull whatever the registry currently serves."
    exit 0
  fi

  body="$(fetch_url "$RELEASES_API")"
  # Extracted in stages rather than one pipeline, for the same pipefail reason
  # as contains_line above: `head -1` exits early and SIGPIPEs `grep`.
  tag_matches="$(printf '%s' "$body" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' || true)"
  latest="${tag_matches%%$'\n'*}"   # first match only
  latest="${latest%\"}"             # drop the closing quote
  latest="${latest##*\"}"           # then everything before the opening one
  latest="${latest#v}"

  if [[ -z "$latest" ]]; then
    warn "Could not reach GitHub to look up the latest release."
    warn "This says nothing about whether an update exists."
    exit 0
  fi

  if [[ -z "$CURRENT_VERSION" ]]; then
    info "Latest release is $latest. The running version could not be read, so no comparison was made."
  elif [[ "$latest" == "$CURRENT_VERSION" ]]; then
    success "You are on the latest release ($CURRENT_VERSION)."
  else
    echo ""
    echo -e "  ${BOLD}Backspace $latest is available.${NC} You are on $CURRENT_VERSION."
    echo -e "  Release notes: https://github.com/TheZwiss/backspace/releases/tag/v${latest}"
    echo ""
    echo -e "  Update with: ${BOLD}./update.sh${NC}"
  fi
  echo ""
  info "Nothing was changed."
  exit 0
fi

# ── Confirmation ────────────────────────────────────────────

if [[ "$ASSUME_YES" != true ]]; then
  if [[ ! -t 0 ]]; then
    error "Not running interactively and --yes was not given."
    error "Re-run as: ./update.sh --yes"
    exit 1
  fi
  echo ""
  echo "This will snapshot the database, fetch the newest image, and restart"
  echo "the $SERVICE service. Other containers are left alone. Clients reconnect"
  echo "on their own."
  read -rp "Continue? [y/N] " yn
  [[ "${yn,,}" == "y" ]] || { echo "Aborted. Nothing was changed."; exit 0; }
fi

# ── Phase 2: Refresh the checkout, tolerantly ───────────────

step "Refreshing the checkout"

if [[ ! -d .git ]]; then
  info "Not a git checkout, so there is nothing to pull."
  info "That is normal for an rsync-deployed host. The image update below still applies."
elif ! git rev-parse --git-dir >/dev/null 2>&1; then
  warn "A .git directory exists but git cannot read it. Skipping the pull."
elif ! git diff --quiet HEAD 2>/dev/null; then
  warn "This checkout has uncommitted changes, so it will not be pulled."
  warn "Your local edits are untouched. The image update below still applies."
elif ! git remote get-url origin >/dev/null 2>&1; then
  warn "No 'origin' remote configured. Skipping the pull."
elif git pull --ff-only 2>&1 | sed 's/^/       /'; then
  success "Checkout is up to date"
else
  warn "Could not fast-forward this checkout, most likely because it has diverged."
  warn "Nothing was rewritten. Resolve it by hand later if you want the newest"
  warn "compose files and scripts. The image update below still applies."
fi

# ── Phase 3: Back up ────────────────────────────────────────
# The one step whose failure is fatal. Everything after it is only safe to
# attempt because it happened.

step "Backing up the database"

if [[ "$DO_BACKUP" != true ]]; then
  warn "--no-backup given, so no snapshot was taken."
elif [[ ! -x ./backup.sh ]]; then
  error "./backup.sh is missing or not executable, so no snapshot can be taken."
  error "Re-run with --no-backup if you have a backup by other means."
  exit 1
elif ./backup.sh; then
  success "Snapshot written to data/backups/"
else
  error "The backup failed, so the update was not attempted."
  error "Nothing was changed."
  exit 1
fi

# ── Phase 4: Fetch the new image ────────────────────────────

step "Fetching the new image"

case "$INSTALL_CHANNEL" in
  source)
    info "From-source install: rebuilding $SERVICE."
    build_commit=""
    if git rev-parse --short HEAD >/dev/null 2>&1; then
      build_commit="$(git rev-parse --short HEAD)"
    fi
    # AGPL-3.0 § 13: bake the commit so /api/instance/info advertises the exact
    # build, the same way deploy.sh and install.sh do.
    if ! $COMPOSE build --build-arg BACKSPACE_COMMIT="$build_commit" "$SERVICE"; then
      error "The build failed. Nothing was restarted, so your instance is untouched."
      exit 1
    fi
    ;;
  *)
    info "Prebuilt-image install: pulling $TARGET_REF."
    if ! $COMPOSE pull "$SERVICE"; then
      error "The pull failed. Nothing was restarted, so your instance is untouched."
      exit 1
    fi
    ;;
esac

NEW_IMAGE_ID="$($DOCKER image inspect --format '{{.Id}}' "$TARGET_REF" 2>/dev/null || true)"

# ── Phase 5: Skip a no-op ───────────────────────────────────
# Restarting a chat server for nothing drops everyone in a voice call.

if [[ -n "$NEW_IMAGE_ID" && "$NEW_IMAGE_ID" == "$ROLLBACK_IMAGE_ID" ]]; then
  echo ""
  success "Already running the newest image. Nothing to restart."
  info "Version ${CURRENT_VERSION:-unknown} is current for $TARGET_REF."
  exit 0
fi

# ── Phase 6 and 7: Restart, then wait for healthy ───────────

wait_for_healthy() {
  local deadline=$(( SECONDS + HEALTH_TIMEOUT ))
  local status=""
  while (( SECONDS < deadline )); do
    status="$($DOCKER inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null || echo "gone")"
    case "$status" in
      healthy) return 0 ;;
      none)
        # No healthcheck defined on this service. Fall back to "running".
        if [[ "$($DOCKER inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)" == "true" ]]; then
          return 0
        fi
        ;;
    esac
    sleep 3
  done
  return 1
}

roll_back() {
  echo ""
  warn "Rolling back to the image you were running before."
  # Re-point the reference compose deploys at the previous image ID, then let
  # compose recreate from it.
  if ! $DOCKER tag "${ROLLBACK_IMAGE_ID#sha256:}" "$TARGET_REF"; then
    error "Could not re-tag the previous image. Roll back by hand:"
    error "  $DOCKER tag ${ROLLBACK_IMAGE_ID#sha256:} $TARGET_REF"
    error "  $COMPOSE up -d $SERVICE"
    return 1
  fi
  if ! $COMPOSE up -d "$SERVICE"; then
    error "Could not restart the previous image. Check: $COMPOSE logs $SERVICE"
    return 1
  fi
  if wait_for_healthy; then
    success "Rolled back to version ${CURRENT_VERSION:-the previous build}"
    echo ""
    warn "The local tag $TARGET_REF now points at the image you were running,"
    warn "not at what the registry serves under that name. Once the problem is"
    warn "fixed, restore it with: $COMPOSE pull $SERVICE"
    return 0
  fi
  error "The previous image did not come back healthy either."
  error "Check: $COMPOSE logs $SERVICE"
  error "Restore the database with: ./restore.sh"
  return 1
}

step "Restarting $SERVICE"

# The service is named explicitly and --remove-orphans is never passed, so
# co-hosted containers in this project are not recreated or reaped.
if ! $COMPOSE up -d "$SERVICE"; then
  error "The restart failed."
  roll_back || true
  exit 1
fi

info "Waiting up to ${HEALTH_TIMEOUT}s for $CONTAINER to report healthy..."
if ! wait_for_healthy; then
  error "$CONTAINER did not become healthy within ${HEALTH_TIMEOUT}s."
  # Container state first. A container that exited produces no logs worth
  # tailing, and "exited with code 1" is the answer in that case.
  error "Container state: $($DOCKER inspect --format '{{.State.Status}} (exit code {{.State.ExitCode}})' "$CONTAINER" 2>/dev/null || echo unknown)"
  # The health probe output says why the check failed, which the service logs
  # often do not. During the rollback rehearsal the logs were empty and this was
  # the only line that explained anything.
  probe="$($DOCKER inspect --format '{{range .State.Health.Log}}{{.Output}}{{end}}' "$CONTAINER" 2>/dev/null || true)"
  if [[ -n "${probe// /}" ]]; then
    error "Last health probe output:"
    printf '%s\n' "$probe" | sed 's/^/       /'
  fi
  error "Recent logs:"
  $COMPOSE logs --tail 40 "$SERVICE" 2>&1 | sed 's/^/       /' || true
  roll_back || true
  exit 1
fi

success "Container is healthy"

# ── Phase 8: Verify the version actually moved ──────────────
# A container that is healthy but still serving the old code is a failed update,
# and this is the only check that catches it.

step "Verifying the running version"

NEW_VERSION="$(running_version)"

if [[ -z "$CURRENT_VERSION" ]]; then
  warn "The pre-update version was unreadable, so there is nothing to compare against."
  success "Backspace is running version ${NEW_VERSION:-unknown}"
elif [[ -z "$NEW_VERSION" ]]; then
  error "The container is healthy but did not report a version."
  roll_back || true
  exit 1
elif [[ "$NEW_VERSION" == "$CURRENT_VERSION" ]]; then
  error "The container came up healthy but still reports version $CURRENT_VERSION."
  error "The new image did not take effect."
  roll_back || true
  exit 1
else
  success "Updated from $CURRENT_VERSION to $NEW_VERSION"
fi

echo ""
echo -e "${BOLD}Done.${NC}"
echo "  Snapshot:  data/backups/  (restore with ./restore.sh)"
echo "  Logs:      $COMPOSE logs -f $SERVICE"
echo ""
