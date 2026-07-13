#!/bin/sh
# Runs as root: make the (bind-mounted, host-owned) data dir writable by the
# non-root `node` user, then drop privileges via gosu and exec the CMD. This
# lets the container run as uid 1000 while still owning ./data on hosts where
# the bind mount was created by a different uid.
#
# - Idempotent AND cheap: only chown entries not already node-owned, so after
#   the first boot this is near-instant. A plain `chown -R` over a large
#   uploads/ tree on slow Pi/SD storage would delay startup on EVERY restart.
# - Non-fatal: on a bind mount that rejects chown (some CIFS/NFS backings),
#   warn and continue rather than crash-looping under `restart: unless-stopped`
#   (the old root container booted fine on such mounts).
set -e
mkdir -p /app/data/uploads
chown node:node /app/data /app/data/uploads 2>/dev/null || true
find /app/data ! -user node -exec chown node:node {} + 2>/dev/null || \
  echo "docker-entrypoint: warning: could not chown /app/data; continuing (ensure it is writable by uid 1000)"
exec gosu node "$@"
