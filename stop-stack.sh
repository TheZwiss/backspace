#!/usr/bin/env bash
# Stop the Backspace stack started by start-stack.sh.
set -u
pkill -f '^node --import tsx/esm src/index.ts$' 2>/dev/null && echo "backspace: stopped"
pkill -f '^caddy run --config /opt/caddy/Caddyfile --adapter caddyfile$' 2>/dev/null && echo "caddy: stopped"
pkill -f '^livekit-server --config /opt/livekit/livekit.yaml$' 2>/dev/null && echo "livekit: stopped"
sleep 1
exit 0
