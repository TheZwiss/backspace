#!/usr/bin/env bash
# Run from the Fastify 5 checkout on a disposable Linux Docker runner.
# Requires Compose 2.24.4+ and already-local Caddy and Backspace images.
# Optional legacy image: set LEGACY_IMAGE to a locally cached Fastify 4 build.
set -euo pipefail
: "${CANDIDATE_IMAGE:?Provide a locally tagged candidate such as backspace:fastify5-smoke}"
legacy_image=${LEGACY_IMAGE:-$CANDIDATE_IMAGE}
legacy_ref=c832007dea7fff2cc157d71ec19092f250e10653
edge_image=caddy:2.11.1-alpine
project="backspace-fastify5-smoke-$$"
fixture=$(mktemp -d)
export SMOKE_PROJECT="$project"

for image in "$CANDIDATE_IMAGE" "$legacy_image" "$edge_image"; do
  docker image inspect "$image" >/dev/null
done

git show "$legacy_ref:docker-compose.yml" > "$fixture/legacy.yml"
cp docker-compose.yml "$fixture/current.yml"
cd "$fixture"
cat > .env <<'ENV'
DOMAIN=smoke.invalid
JWT_SECRET=disposable-compose-smoke-jwt-0123456789
TRUSTED_PROXY_HOPS=0
DIRECTORY_ENDPOINT=
ENV
cat > Caddyfile <<'CADDY'
{
  auto_https off
  admin off
}
:8080 {
  log {
    output stdout
    format json
  }
  reverse_proxy backspace:3000
}
:8081 {
  reverse_proxy cohost:8080
}
CADDY
cat > smoke.yml <<'COMPOSE'
services:
  backspace:
    image: ${SMOKE_IMAGE}
    container_name: ${SMOKE_PROJECT}-app
    healthcheck:
      interval: 1s
      timeout: 2s
      start_period: 5s
  caddy:
    container_name: ${SMOKE_PROJECT}-edge
    ports: !override
      - "127.0.0.1::8080"
      - "127.0.0.1::8081"
COMPOSE

stack() {
  docker compose -p "$project" -f "${manifest:-current.yml}" -f smoke.yml "$@"
}
cleanup() {
  local status=$?
  if (( status != 0 )); then
    stack ps || true
    stack logs --no-log-prefix --no-color backspace caddy || true
  fi
  docker rm -f "$project-cohost" >/dev/null 2>&1 || true
  SMOKE_IMAGE=$CANDIDATE_IMAGE stack down -v >/dev/null 2>&1 || true
  # The application owns the bind-mounted database and upload directories.
  cd /
  sudo -n rm -rf -- "$fixture"
}
trap cleanup EXIT

export SMOKE_IMAGE="$legacy_image"
manifest=legacy.yml
stack up -d --no-build --pull never backspace caddy
docker run -d --pull never --name "$project-cohost" --network "${project}_internal" \
  --network-alias cohost --entrypoint node "$CANDIDATE_IMAGE" -e \
  'require("http").createServer((req,res)=>res.end("cohost")).listen(8080,"0.0.0.0")' >/dev/null
curl_smoke() {
  curl -fsS --retry 15 --retry-delay 1 --retry-all-errors "http://$(stack port caddy "$1")$2" "${@:3}"
}
[[ $(curl_smoke 8081 /) == cohost ]]
curl_smoke 8080 /api/health | jq -e '.status == "ok"' >/dev/null
token=$(curl -fsS "http://$(stack port caddy 8080)/api/auth/register" \
  -H 'Content-Type: application/json' \
  --data '{"username":"migrationcheck","password":"migration-check-123!","displayName":"Migration check"}' |
  jq -er .token)
docker inspect "$project-app" | jq -e --arg network "${project}_internal" \
  '.[0].NetworkSettings.Networks | has($network)' >/dev/null

manifest=current.yml
export SMOKE_IMAGE="$CANDIDATE_IMAGE"
# Replace the test's temporary direct setting. Base Compose supplies the Caddy IP.
sed -i '/^TRUSTED_PROXY_HOPS=/d' .env
stack up -d --no-build --pull never backspace caddy
[[ $(curl_smoke 8081 /) == cohost ]]
curl_smoke 8080 /api/health?compose-smoke=after | jq -e '.status == "ok"' >/dev/null
curl_smoke 8080 /api/users/@me -H "Authorization: Bearer $token" |
  jq -e '.username == "migrationcheck"' >/dev/null

docker inspect "$project-edge" | jq -e --arg old "${project}_internal" --arg new "${project}_app" \
  '.[0].NetworkSettings.Networks | has($old) and .[$new].IPAddress == "10.253.243.2"' >/dev/null
docker inspect "$project-app" | jq -e --arg network "${project}_app" \
  '.[0].NetworkSettings.Networks | keys == [$network]' >/dev/null
path='/api/health?compose-smoke=after'
edge_ip=$(stack logs --no-log-prefix --no-color caddy |
  jq -Rer --arg path "$path" 'fromjson? | select(.request.uri == $path) | .request.remote_ip')
app_ip=$(stack logs --no-log-prefix --no-color backspace |
  jq -Rer --arg path "$path" 'fromjson? | select(.req.url == $path) | .req.remoteAddress')
[[ "$edge_ip" == "$app_ip" && "$app_ip" != 10.253.243.2 ]]
printf '%s\n' 'Legacy → current Compose network transition, co-host routing, trusted peer, and persisted authentication passed.'
