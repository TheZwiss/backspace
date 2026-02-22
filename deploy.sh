#!/bin/bash
cd "$(dirname "$0")"

# Configuration
PI_IP="192.168.1.10"
PI_USER="youruser"
REMOTE_PATH="~/opencord"

# 0. Ensure remote directory exists
echo "📁 Preparing remote directory on Pi..."
ssh "$PI_USER@$PI_IP" "mkdir -p $REMOTE_PATH"

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
  ./ "$PI_USER@$PI_IP:$REMOTE_PATH"

# 2. Trigger Docker Compose directly on the Pi via SSH
echo "🚢 Triggering build and deploy on Pi hardware..."
ssh "$PI_USER@$PI_IP" "cd $REMOTE_PATH && docker compose up -d --build"

echo "✅ Deployment command sent to Pi!"
