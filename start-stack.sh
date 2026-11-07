#!/usr/bin/env bash
# Start the Backspace stack inside Debian/PRoot on Android (no systemd).
# Idempotent: services already running are left alone.
set -u

LOG_DIR=/var/log/backspace
mkdir -p "$LOG_DIR" /var/log/livekit /var/log/caddy


TS_SOCK=/var/run/tailscale/tailscaled.sock

start_tailscale() {
  if ! pgrep -f '^tailscaled --tun=userspace-networking' >/dev/null; then
    mkdir -p /var/lib/tailscale-userspace /var/run/tailscale
    chmod 700 /var/lib/tailscale-userspace
    setsid nohup tailscaled --tun=userspace-networking \
      --statedir=/var/lib/tailscale-userspace \
      --state=/var/lib/tailscale-userspace/tailscaled.state \
      --socket="$TS_SOCK" --port=41641 \
      >/var/log/tailscale-userspace.log 2>&1 </dev/null &
    echo "tailscale-userspace: starting"
    for _ in $(seq 1 20); do [ -S "$TS_SOCK" ] && break; sleep 1; done
  fi
  # State is already logged in after the first `tailscale up`.
  tailscale --socket="$TS_SOCK" up --hostname=backspace --accept-dns=false >/dev/null 2>&1 || true
  if ! tailscale --socket="$TS_SOCK" serve status 2>/dev/null | grep -q '/livekit'; then
    tailscale --socket="$TS_SOCK" serve --bg --yes --https=443 \
      --set-path /livekit http://127.0.0.1:7880 >/dev/null 2>&1 || true
    tailscale --socket="$TS_SOCK" serve --bg --yes --https=443 \
      http://127.0.0.1:3000 >/dev/null 2>&1 || true
  fi
  # TURN/TCP through the same shared node, so media needs only the `backspace`
  # share (not the Android `mi-9t-pro` node).
  # Always refresh the TURN/TCP forward with PROXY protocol v2. The TURN server
  # needs the real client address here, otherwise it returns 127.0.0.1 and
  # browsers abandon the relay allocation.
  tailscale --socket="$TS_SOCK" serve --tcp=3479 off >/dev/null 2>&1 || true
  tailscale --socket="$TS_SOCK" serve --bg --yes --tcp=3479 --proxy-protocol=2 \
    tcp://127.0.0.1:3479 >/dev/null 2>&1 || true
}

start_livekit() {
  pgrep -f '^livekit-server --config /opt/livekit/livekit.yaml$' >/dev/null && return 0
  cd /opt/livekit || return 1
  setsid nohup livekit-server --config /opt/livekit/livekit.yaml \
    >>/var/log/livekit/livekit.log 2>&1 </dev/null &
  echo "livekit: starting"
}

start_caddy() {
  pgrep -f '^caddy run --config /opt/caddy/Caddyfile --adapter caddyfile$' >/dev/null && return 0
  cd /opt/caddy || return 1
  setsid nohup caddy run --config /opt/caddy/Caddyfile --adapter caddyfile \
    >>/var/log/caddy/caddy.log 2>&1 </dev/null &
  echo "caddy: starting"
}

start_server() {
  pgrep -f '^node --import tsx/esm src/index.ts$' >/dev/null && return 0
  cd /opt/backspace/packages/server || return 1
  setsid nohup node --import tsx/esm src/index.ts \
    >>"$LOG_DIR/server.log" 2>&1 </dev/null &
  echo "backspace: starting"
}

start_livekit
start_caddy
start_server
start_tailscale

for _ in $(seq 1 40); do
  curl -fsS --max-time 2 http://127.0.0.1:3000/api/health >/dev/null 2>&1 && break
  sleep 1
done
for _ in $(seq 1 20); do
  curl -fsS --max-time 2 http://127.0.0.1:7880/ >/dev/null 2>&1 && break
  sleep 1
done

echo
echo "Backspace:  https://backspace.<sua-tailnet>.ts.net  (Tailscale, certificado válido)"
echo "            https://10.0.1.5:8443  (LAN)"
echo "            https://100.113.4.54:8443  (Tailscale IP)"
echo "            https://mi-9t-pro.<sua-tailnet>.ts.net:8443  (Tailscale MagicDNS)"
echo "LiveKit:    ws://127.0.0.1:7880  (UDP 7882 / TCP 7881)"
echo "CA cert:    https://10.0.1.5:8443/ca.crt"
echo
echo -n "health: "
curl -fsS --max-time 3 http://127.0.0.1:3000/api/health || echo "FAILED"
echo
