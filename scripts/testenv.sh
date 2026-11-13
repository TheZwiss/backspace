#!/usr/bin/env bash
# Persistent local test environment (server :3005 + Vite :5173).
# Usage: scripts/testenv.sh [up|down|status|reset]
#   up     start the stack (idempotent), seed it on first run
#   down   stop the stack, keep the data
#   status show whether the ports answer
#   reset  stop and delete .testenv/ (next `up` re-seeds)
# State lives in .testenv/ (gitignored). Login: ana / change-me-dev-password,
# space "Teste" with #general and a voice channel.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
S="$ROOT/.testenv"
API="http://localhost:3005"
USER_NAME="ana"
USER_PASS="change-me-dev-password"

up_ports() { curl -s -o /dev/null "$API/api/health" 2>/dev/null || curl -s -o /dev/null "$API" 2>/dev/null; }

seed() {
  local reg token
  reg=$(curl -s -X POST "$API/api/auth/register" -H 'content-type: application/json' \
    -d "{\"username\":\"$USER_NAME\",\"password\":\"$USER_PASS\",\"email\":\"ana@test.local\"}")
  token=$(printf '%s' "$reg" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
  curl -s -X POST "$API/api/spaces" -H "authorization: Bearer $token" \
    -H 'content-type: application/json' -d '{"name":"Teste"}' > /dev/null
  touch "$S/.seeded"
}

cmd_up() {
  mkdir -p "$S"
  if up_ports && ss -ltn | grep -q ':5173\b'; then echo "already running"; return; fi
  cd "$ROOT"
  DB_PATH="$S/test.db" UPLOAD_DIR="$S/uploads" BACKUP_DIR="$S/backups" \
    JWT_SECRET=motionlabsecretmotionlabsecret123456 DOMAIN=localhost REGISTRATION_OPEN=true \
    setsid nohup pnpm dev > "$S/dev.log" 2>&1 < /dev/null &
  echo $! > "$S/dev.pid"
  for _ in $(seq 1 60); do
    if up_ports && ss -ltn | grep -q ':5173\b'; then break; fi
    sleep 1
  done
  up_ports || { echo "server did not start, see $S/dev.log" >&2; exit 1; }
  [ -f "$S/.seeded" ] || seed
  echo "up: web http://localhost:5173  api $API  login $USER_NAME / $USER_PASS"
}

cmd_down() {
  if [ -f "$S/dev.pid" ]; then
    kill -- "-$(cat "$S/dev.pid")" 2>/dev/null || true
    rm -f "$S/dev.pid"
  fi
  for port in 3005 5173; do
    fuser -k "$port/tcp" > /dev/null 2>&1 || true
  done
  echo "stopped"
}

case "${1:-up}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) if up_ports; then echo "running"; else echo "stopped"; fi ;;
  reset) cmd_down; rm -rf "$S"; echo "reset" ;;
  *) echo "usage: $0 [up|down|status|reset]" >&2; exit 2 ;;
esac
