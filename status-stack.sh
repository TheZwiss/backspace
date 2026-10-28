#!/usr/bin/env bash
set -u
for name in backspace caddy livekit; do
  case "$name" in
    backspace) pat='^node --import tsx/esm src/index.ts$' ;;
    caddy)     pat='^caddy run --config /opt/caddy/Caddyfile --adapter caddyfile$' ;;
    livekit)   pat='^livekit-server --config /opt/livekit/livekit.yaml$' ;;
  esac
  if pgrep -f "$pat" >/dev/null; then
    echo "$name: running (pid $(pgrep -f "$pat" | tr '\n' ' '))"
  else
    echo "$name: STOPPED"
  fi
done
echo -n "app health:   "
curl -fsS --max-time 3 http://127.0.0.1:3000/api/health || echo FAILED
echo
echo -n "caddy health: "
curl -kfsS --max-time 3 https://10.0.1.5:8443/api/health || echo FAILED
echo
echo -n "livekit:      "
curl -fsS --max-time 3 http://127.0.0.1:7880/ || echo FAILED
echo
echo -n "tailscale:    "
tailscale --socket=/var/run/tailscale/tailscaled.sock status 2>/dev/null | head -1 || echo FAILED
echo -n "tailscale url: "
tailscale --socket=/var/run/tailscale/tailscaled.sock serve status 2>/dev/null | head -1 || echo FAILED
echo
