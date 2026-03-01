#!/bin/bash
cd "$(dirname "$0")"

# Configuration
LOCAL_IP="192.168.1.10"
REMOTE_HOST="nova.ddns.net"
PI_USER="youruser"
REMOTE_PATH="~/backspace"

# Host selection: --remote / -r  |  --local / -l  |  auto-detect (default)
if [[ "$1" == "--remote" || "$1" == "-r" ]]; then
  PI_HOST="$REMOTE_HOST"
elif [[ "$1" == "--local" || "$1" == "-l" ]]; then
  PI_HOST="$LOCAL_IP"
else
  if ping -c1 -W2 "$LOCAL_IP" &>/dev/null; then
    PI_HOST="$LOCAL_IP"
  else
    PI_HOST="$REMOTE_HOST"
  fi
fi

echo "🎯 Target: $PI_USER@$PI_HOST"

# 0. Ensure remote directory exists
echo "📁 Preparing remote directory on Pi..."
ssh "$PI_USER@$PI_HOST" "mkdir -p $REMOTE_PATH"

# 1. Sync files via rsync
echo "🚀 Syncing files to Pi..."
rsync -avz --delete \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='.env.local' \
  --exclude='packages/*/node_modules' \
  --exclude='packages/web/dist' \
  --exclude='data' \
  --exclude='.DS_Store' \
  ./ "$PI_USER@$PI_HOST:$REMOTE_PATH"

# 2. Trigger Docker Compose directly on the Pi via SSH
echo "🚢 Triggering build and deploy on Pi hardware..."
ssh "$PI_USER@$PI_HOST" "cd $REMOTE_PATH && docker compose up -d --build"

echo "✅ Deployment command sent to Pi!"
