#!/usr/bin/env bash
set -euo pipefail

fixture_source=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
worktree=${1:?Pass the disposable checkout}
chromium=${2:?Pass the full path to isolated Chromium}
fixture_dir=$(mktemp -d)
app_pid=
display_pid=
cleanup() {
  if [[ -n "$app_pid" ]]; then kill -- "-$app_pid" 2>/dev/null || true; fi
  if [[ -n "$display_pid" ]]; then kill "$display_pid" 2>/dev/null || true; fi
  printf 'Evidence directory: %s\n' "$fixture_dir"
}
trap cleanup EXIT

Xvfb -displayfd 3 -screen 0 1600x1000x24 -nolisten tcp 3>"$fixture_dir/display" >"$fixture_dir/xvfb.log" 2>&1 &
display_pid=$!
for _ in {1..100}; do
  [[ -s "$fixture_dir/display" ]] && break
  sleep 0.1
done
DISPLAY=:$(cat "$fixture_dir/display")
export DISPLAY
mkdir -p "$fixture_dir/uploads" "$fixture_dir/backups" "$fixture_dir/home"

cd "$worktree"
test "$(git rev-parse HEAD)" = de9902d147ec08d94bab3c72a665d0f00fc9966a
pnpm build:shared >"$fixture_dir/shared.log" 2>&1
setsid env HOST=127.0.0.1 DOMAIN=localhost PUBLIC_ORIGIN=http://127.0.0.1:5173 \
  NODE_OPTIONS=--dns-result-order=ipv4first JWT_SECRET="$(openssl rand -hex 32)" \
  DB_PATH="$fixture_dir/backspace.db" UPLOAD_DIR="$fixture_dir/uploads" BACKUP_DIR="$fixture_dir/backups" \
  DIRECTORY_ENDPOINT= TELEMETRY=false BACKSPACE_UPDATE_CHECK=false \
  pnpm dev >"$fixture_dir/backspace.log" 2>&1 &
app_pid=$!
for _ in {1..100}; do
  if curl -fsS http://127.0.0.1:5173/api/health >"$fixture_dir/health.json"; then break; fi
  sleep 0.2
done
test -s "$fixture_dir/health.json"

QA_FIXTURE="$fixture_dir" QA_CHROME="$chromium" QA_SOURCE="$fixture_source/native-source.py" \
QA_WORKTREE="$PWD" node "$fixture_source/native-drop.mjs" | tee "$fixture_dir/results.log"
