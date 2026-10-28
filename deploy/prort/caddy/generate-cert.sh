#!/usr/bin/env bash
# Generate a leaf certificate signed by Caddy's local CA.
# Usage: ./generate-cert.sh <dns-name> <lan-ip> <tailscale-ip> [out-dir]
set -euo pipefail

HOST="${1:?usage: generate-cert.sh <dns-name> <lan-ip> <tailscale-ip> [out-dir]}"
LAN_IP="${2:?LAN IP required}"
TS_IP="${3:?Tailscale IP required}"
OUT="${4:-/opt/caddy/certs}"
CA="/root/.local/share/caddy/pki/authorities/local"

mkdir -p "$OUT"
cd "$OUT"

cat > ext.cnf <<EOF
subjectAltName=DNS:localhost,DNS:${HOST},IP:127.0.0.1,IP:${LAN_IP},IP:${TS_IP}
extendedKeyUsage=serverAuth
keyUsage=critical,digitalSignature,keyEncipherment
basicConstraints=critical,CA:FALSE
EOF

openssl req -new -newkey rsa:2048 -nodes -keyout "${HOST}.key" \
  -out "${HOST}.csr" -subj "/CN=${LAN_IP}" >/dev/null 2>&1
openssl x509 -req -in "${HOST}.csr" \
  -CA "$CA/intermediate.crt" -CAkey "$CA/intermediate.key" -CAcreateserial \
  -out "${HOST}-leaf.crt" -days 365 -extfile ext.cnf >/dev/null 2>&1
cat "${HOST}-leaf.crt" "$CA/intermediate.crt" > "${HOST}.crt"
chmod 600 "${HOST}.key"
chmod 644 "${HOST}.crt"
cp "$CA/root.crt" /opt/caddy/ca.crt
chmod 644 /opt/caddy/ca.crt

echo "Wrote $OUT/${HOST}.crt and $OUT/${HOST}.key"
echo "CA download: /opt/caddy/ca.crt"
