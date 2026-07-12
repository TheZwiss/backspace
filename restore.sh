#!/usr/bin/env bash
# Restore the Backspace SQLite DB from a snapshot in data/backups/.
# Usage:
#   ./restore.sh                 List available snapshots.
#   ./restore.sh <snapshot.db>   Restore the named snapshot (path or basename).
set -euo pipefail
cd "$(dirname "$0")"

BACKUP_DIR="data/backups"
DB="data/backspace.db"

if [[ ! -d "$BACKUP_DIR" ]]; then
  echo "No backups directory at $BACKUP_DIR." >&2
  exit 1
fi

# No arg: list snapshots newest-first and exit.
if [[ $# -eq 0 ]]; then
  shopt -s nullglob
  snaps=("$BACKUP_DIR"/*.db)
  shopt -u nullglob
  if [[ ${#snaps[@]} -eq 0 ]]; then
    echo "No snapshots found in $BACKUP_DIR."
    exit 0
  fi
  echo "Available snapshots (newest first):"
  for f in $(ls -1t "$BACKUP_DIR"/*.db); do
    printf "  %s  (%s)\n" "$(basename "$f")" "$(du -h "$f" | cut -f1)"
  done
  echo ""
  echo "Restore with: ./restore.sh <snapshot-filename>"
  exit 0
fi

# Resolve the snapshot to a basename inside BACKUP_DIR (restore is always from data/backups/).
SNAP_NAME="$(basename "$1")"
if [[ ! -f "$BACKUP_DIR/$SNAP_NAME" ]]; then
  echo "Snapshot not found in $BACKUP_DIR: $SNAP_NAME" >&2
  exit 1
fi

echo "About to restore: $BACKUP_DIR/$SNAP_NAME"
echo "This will REPLACE $DB. The current DB is saved first as a pre-restore snapshot."
read -rp "Continue? [y/N] " yn
[[ "${yn,,}" == "y" ]] || { echo "Aborted."; exit 0; }

echo "[1/3] Stopping backspace container..."
docker compose stop backspace

# data/backspace.db and data/backups/ are container-owned (uid 1000, the non-root runtime
# user). The host user cannot cp/rm them directly, so do the swap inside a throwaway root
# container that mounts data/ (root can rewrite the uid-1000-owned files).
# (youruser is in the docker group on both boxes — no sudo prompt.)
TS="$(date -u +%Y%m%dT%H%M%S)"
echo "[2/3] Swapping DB inside a root container (pre-restore copy + WAL clear + install)..."
docker run --rm -v "$(pwd)/data:/data" alpine sh -c '
  set -e
  if [ -f /data/backspace.db ]; then
    cp /data/backspace.db "/data/backups/backspace-$1-pre-restore.db"
  fi
  rm -f /data/backspace.db-wal /data/backspace.db-shm
  cp "/data/backups/$2" /data/backspace.db
' sh "$TS" "$SNAP_NAME"

echo "[3/3] Starting backspace container..."
docker compose start backspace
echo "Done. Watch health: docker compose logs -f backspace"
