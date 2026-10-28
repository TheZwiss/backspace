#!/data/data/com.termux/files/usr/bin/sh
# Starts the Debian/PRoot Backspace stack from Termux.
# Safe to run repeatedly: it exits immediately when the app is healthy.
set -u

export PREFIX=/data/data/com.termux/files/usr
export HOME=/data/data/com.termux/files/home
export PATH="$PREFIX/bin:$PATH"
LOG="$HOME/backspace-boot.log"
LOCK="$HOME/.backspace-autostart.lock"

health() {
  curl -fsS --max-time 3 http://127.0.0.1:3000/api/health >/dev/null 2>&1
}

health && exit 0

exec 9>"$LOCK"
flock -n 9 || exit 0

health && exit 0

# A previous boot/login may still be inside start-stack.sh or its keepalive.
if pgrep -f '/opt/backspace/start-stack.sh' >/dev/null 2>&1; then
  exit 0
fi

termux-wake-lock >/dev/null 2>&1 || true

# Wait up to 40 s for the Android Tailscale VPN interface. LiveKit can start
# without it (LAN only), but with it the ICE candidates include both IPs.
have_tun1() { grep -q 'tun1:' /proc/net/dev 2>/dev/null; }
n=0
while ! have_tun1 && [ "$n" -lt 20 ]; do
  sleep 2
  n=$((n + 1))
done

echo "[$(date)] starting Backspace stack (tun1=$(have_tun1 && echo yes || echo no))" >>"$LOG"

# Keep one proot login alive forever: PRoot uses --kill-on-exit, so if the
# login process exits, every service inside the container is killed.
nohup proot-distro login debian -- bash -lc \
  '/opt/backspace/start-stack.sh; exec sleep infinity' \
  >>"$LOG" 2>&1 </dev/null &

exit 0
