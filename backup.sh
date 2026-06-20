#!/usr/bin/env bash
# Trigger a manual DB snapshot inside the running Backspace container.
set -euo pipefail
cd "$(dirname "$0")"

if ! docker ps --format '{{.Names}}' | grep -q '^backspace$'; then
  echo "Error: backspace container is not running." >&2
  exit 1
fi

docker exec -w /app/packages/server backspace \
  node --import tsx/esm src/scripts/snapshot.ts
