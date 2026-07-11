<div align="center">

<img src="packages/web/public/icons/logo.png" alt="Backspace" width="160" />

# Backspace

**A self-hosted communication platform you own. Text, voice, video, and federation.**

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-3da639.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/node-20_LTS-339933.svg)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-1.0.0-16a34a.svg)](#project-status)

</div>

---

Backspace is a self-hosted, open-source Discord alternative: a Discord-style chat
platform you run on your own hardware. Spaces, channels, roles, voice and video,
screen sharing, direct messages, friends, file sharing, and message search. On top
of that, **server-to-server federation** lets independent Backspace instances talk
to each other while each stays under its own control.

It is **free and open source** under the **GNU AGPL-3.0**, and dual-licensed: a
commercial license is available if the AGPL doesn't fit your use. See
[License](#license) for the details.

> **Project status** <a name="project-status"></a>
> Backspace 1.0. Stable, self-hostable, and actively developed.

## What makes Backspace different

Self-hosted chat usually forces a trade-off: gaming-grade voice and video, *or* a
polished Discord-style experience, *or* federation between independent servers.
Rarely all three, and rarely with the fine-grained media controls people expect.

Backspace does all three at once:

- **Voice and video with a real control surface.** This goes past a screen-share
  button. Choose resolution, frame rate, codec (VP9 or hardware H.264), and
  bitrate; set independent 0-200% volume for every person and every screen-share;
  RNNoise noise suppression; a live connection inspector (bitrate, codec, ping,
  packet loss, jitter); and a per-tile badge showing each stream's measured
  resolution and frame-rate. Screen sharing goes up to 4K/120fps within admin-set
  bounds.
- **Federation, not a walled garden.** Run your own instance and peer it with
  others for cross-instance friends, DMs, calls, and presence. Each server stays
  independently owned, and requests are HMAC-authenticated.
- **A complete platform, not a demo.** Role-based permissions with per-category
  and per-channel overrides, friends and group DMs, inline playable media,
  moderation with audit trails, search, a desktop app, and an installable mobile
  PWA, all in the warm, calm "Aether Drift" interface.

You own the server, the data, and the network it federates into.

## Screenshots

<div align="center">

<img src="docs/screenshots/voice-video-grid.webp" alt="A voice channel with a grid of camera and screen-share tiles" width="900" />

<sub><em>A voice channel in full swing. Camera tiles alongside live screen-shares, each with its own resolution and frame-rate label.</em></sub>

</div>

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/chat.webp" alt="A text channel with messages and a typing indicator" /><br/>
      <sub><b>Text channels.</b> Markdown, replies, reactions, and live typing indicators.</sub>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/screen-share-settings.webp" alt="The screen-share settings popover" /><br/>
      <sub><b>Screen-share controls.</b> Resolution, frame rate, codec, and bitrate, within admin-set bounds.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/space-discovery.webp" alt="The space discovery / Explore view" /><br/>
      <sub><b>Spaces and discovery.</b> Browse public, request-to-join, and joined spaces.</sub>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/group-dm.webp" alt="A federated group direct message" /><br/>
      <sub><b>Direct messages.</b> 1-on-1 and group DMs, including members on peer instances.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/user-discovery.webp" alt="The find-people / user discovery view" /><br/>
      <sub><b>Friends and social.</b> Find people across instances with mutual friends and spaces.</sub>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/admin-federation.webp" alt="The federation admin panel showing peered instances" /><br/>
      <sub><b>Federation admin.</b> Manage peered instances, relay, and secret rotation.</sub>
    </td>
  </tr>
</table>

<div align="center"><a href="docs/screenshots.md"><b>→ See all screenshots</b></a></div>

## Features

### Communication
- Real-time text channels over WebSocket, with `@mention` autocomplete and mention highlighting
- Markdown formatting with syntax highlighting
- Message reactions, replies, editing, deletion, and per-message mark-as-unread
- Rich link embeds (YouTube, Vimeo, Spotify, and generic OpenGraph) with SSRF-protected scraping, plus GIF search (Klipy)
- Typing indicators, unread badges, and presence
- Direct messages: 1-on-1 and group DMs (up to 10 people), with voice/video calls (ring, accept, reject)

**Voice, video, and screen sharing** (via [LiveKit](https://livekit.io/)):
- Screen sharing up to 4K/120fps: VP9 by default, an optional hardware-accelerated H.264 mode, and a VP8 simulcast fallback
- Per-stream quality controls: resolution, frame rate, codec, and bitrate, within admin-set bounds
- Independent 0-200% volume for every participant and every screen-share
- RNNoise noise suppression (on by default), plus echo-cancellation and auto-gain toggles and mic/speaker device selection
- Live connection inspector for per-participant bitrate, codec, ping, packet loss, and jitter, plus a per-tile badge showing each stream's measured resolution and frame-rate
- Screen-share viewer detection ("who's watching") and auto-ducking that lowers stream audio when someone speaks
- Selective subscription: mute or stop watching any camera or stream to save bandwidth
- Push-to-talk and fully customizable keybinds (including mouse buttons), in the browser and the desktop app
- Picture-in-Picture for voice and video

### Organization
- Spaces with channel categories
- Role-based permissions: bitwise RBAC with category- and channel-level overrides
- Customizable user sidebar layout, with personal color-coded folders that group whole spaces
- Space discovery (public, request-to-join, and private)
- Shareable invite codes

### Social
- Friend requests and friendships
- User search and discovery
- Mutual friends and mutual spaces
- User profiles with banner, bio, and accent color
- Presence and rich activities (playing, listening, watching, streaming, custom)
- Manual status (Online, Idle, or Do Not Disturb) with a custom status message
- Privacy controls: toggle discoverability and activity-status sharing

### Moderation
- Bans with reason and moderator attribution (who, why, and when)
- Voice restrictions (space-level mute/deafen, persisted)
- Member move and force-disconnect
- Join-request approval for gated spaces

### Federation
- Multi-instance peering with HMAC-signed server-to-server requests
- Federated identity resolution (`username@instance`)
- Cross-instance DMs: messages, reactions, and membership relay
- Cross-instance friends and presence
- File replication with size validation
- Background workers for outbox delivery, file download, peer health, and cleanup

### Platform
- File uploads with image thumbnails (via `sharp`), drag-and-drop and paste-to-upload, and in-app avatar/banner cropping
- Message search with `from:`, `has:`, `before:`, and `after:` filters, plus jump-to-message
- Admin panel: instance settings, user management, registration controls, storage management, and federation/peering, plus granular streaming controls (a per-resolution by per-frame-rate bitrate matrix, min/max caps, quality-slider step, and an optional user-set-bitrate mode)
- Automatic SQLite backups (pre-migration, scheduled, and manual) with restore tooling
- Electron desktop app (Windows, macOS, Linux) with global keybinds (push-to-talk, mute, deafen) and activity detection
- Native desktop notifications and unread badge counts
- Mobile-responsive web UI with a dedicated touch layout (bottom navigation, swipe gestures, full-screen views)
- Installable PWA: add it to your phone's home screen to run it as a standalone app, with service-worker caching and an offline message queue (messages send once you reconnect)
- Account management: password change and account deletion with safeguards

## Installation

The intended way to deploy Backspace is the **interactive installer**. It
configures everything (`.env`, secrets, HTTPS, optional voice) and brings the
stack up for you. It **auto-detects your environment** and picks one of three
deployment modes. The default "All-in-One" (below) needs nothing but a host and
a domain, but if ports 80/443 are already taken (an existing reverse proxy, a
tunnel, another app) the installer steers you to the right mode instead of
dead-ending. See [Deployment modes](#deployment-modes) for the full picture.

By default the installer **pulls a prebuilt multi-architecture image** from the
GitHub Container Registry (`linux/amd64` + `linux/arm64`), so weak or ARM boxes
(a Raspberry Pi) skip the heavy local build. It falls back to building from
source automatically if the image can't be pulled.

### Requirements

- A **Linux host** (VPS, VM, or home server) with **Docker** and **Docker Compose**.
- A **domain name** for your instance. In the default All-in-One mode it must
  point at the host's public IP (Caddy obtains HTTPS certificates for it
  automatically); behind your own reverse proxy or a tunnel it points at that
  edge instead. See [Deployment modes](#deployment-modes).
- The ability to open the firewall ports in step 2 (All-in-One), or a reverse
  proxy / tunnel already terminating HTTPS for you.

### 1. Run the installer

```bash
git clone https://github.com/TheZwiss/backspace.git
cd backspace
./install.sh
```

The installer walks you through everything interactively:

- asks for your domain,
- generates a secure `JWT_SECRET`,
- optionally enables voice/video (sets up the bundled LiveKit server),
- writes `.env` (and `livekit.yaml` if voice is enabled),
- starts all services with Docker and configures automatic HTTPS via Caddy.

### 2. Open the firewall ports

Open these on the host (and, if it's behind a router, port-forward them to the host):

| Port | Proto | When | Purpose |
|------|-------|------|---------|
| `80` | TCP | **Always** | HTTP. Caddy's automatic-HTTPS (ACME) challenge + redirect to HTTPS |
| `443` | TCP | **Always** | HTTPS. Web app, REST API, WebSocket, and LiveKit signaling (proxied) |
| `3478` | UDP | If voice enabled | TURN. NAT traversal for WebRTC |
| `7881` | TCP | If voice enabled | WebRTC TCP fallback (clients that can't use UDP) |
| `50000–60000` | UDP | If voice enabled | WebRTC media (voice / video / screen-share streams) |

Without voice, you only need `80` and `443`. The voice ports are required only
when you enable LiveKit. LiveKit's own signaling port (`7880`) stays internal.
It's reverse-proxied through Caddy on `443`, so you do **not** forward it.

> **Do this together with DNS, ideally before (or right after) running the
> installer.** Caddy gets your HTTPS certificate from Let's Encrypt the first
> time the stack starts, which requires your domain to resolve to this host
> **and** ports `80`/`443` reachable from the internet. If they aren't ready
> yet, that's fine. Caddy keeps retrying, and HTTPS comes up automatically once
> DNS and the ports are in place.

### 3. Create your admin account

Open `https://your-domain` and register. **The first account created becomes the
instance admin**. There is no default username or password.

If the page doesn't load over HTTPS, it's almost always DNS or ports `80`/`443`
not being reachable from outside. Check `docker compose logs caddy` for
certificate errors. (The installer's health check confirms the app is up
internally, not that the certificate was issued.)

### Backups & restore

The app takes automatic SQLite snapshots (before every migration, on a schedule,
and on demand via `./backup.sh`). Restore from a snapshot with `./restore.sh`.
See [`docs/systems/deployment.md`](docs/systems/deployment.md) for the full
backup/restore and image-pinning guide.

### Manual setup (advanced, optional)

The installer above is the supported path. If you'd rather configure everything
by hand, you can skip it and drive Docker Compose directly, but then DNS,
`.env`, secrets, voice config, and the same firewall ports from step 2 are your
responsibility:

```bash
git clone https://github.com/TheZwiss/backspace.git
cd backspace

cp .env.example .env
# Set DOMAIN, and generate a secret:
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env

docker compose up -d
```

The stack runs three services via Docker Compose:

| Service     | Role                                              |
|-------------|---------------------------------------------------|
| `backspace` | The app (API + WebSocket + built web client) on internal port `3000` |
| `caddy`     | Reverse proxy with automatic HTTPS for your `DOMAIN` (ports `80`/`443`) |
| `livekit`   | Voice/video server; optional, enabled with `COMPOSE_PROFILES=voice` |

## Deployment modes

Homelabs differ. Backspace supports three deployment modes from **one installer**,
which auto-detects which one fits and, in non-obvious cases, asks. The mode is
recorded as `DEPLOY_MODE` in `.env`; you can also set it up front for a
non-interactive install (`DEPLOY_MODE=proxy ./install.sh`).

| Mode | When | HTTPS handled by | Voice |
|------|------|------------------|-------|
| **`allinone`** (default) | Ports 80/443 are free and you have a domain | The bundled **Caddy** (automatic Let's Encrypt) | Yes, with UDP media ports open |
| **`proxy`** | You already run a reverse proxy (nginx, Traefik, Caddy, Nginx Proxy Manager, SWAG…) | **Your** reverse proxy | Yes, if you also proxy `/livekit` and open the media ports |
| **`tunnel`** | You expose the box through a tunnel (Cloudflare Tunnel, Tailscale…) | The **tunnel** provider | No, WebRTC/UDP can't traverse a tunnel |

In `proxy` and `tunnel` mode the bundled Caddy is **not** started; instead the app
is published on **`127.0.0.1:APP_PORT`** (loopback only, never exposed directly)
for your proxy or tunnel to forward to. This is driven by a small overlay,
`docker-compose.proxy.yml`, which the installer wires in for you by setting
`COMPOSE_FILE=docker-compose.yml:docker-compose.proxy.yml` in `.env`, so every
later `docker compose …` command in the directory keeps working with no `-f`
flags. The installer auto-picks a free `APP_PORT` (3000/8080 are often taken);
override it with `APP_PORT=…`.

The installer prints ready-to-paste config for your mode at the end. The
canonical snippets are below.

### Mode 2: behind your own reverse proxy

The app answers plain HTTP on `127.0.0.1:APP_PORT`; your proxy terminates TLS and
forwards to it. Every snippet already includes the three things people get wrong:
**WebSocket upgrade** (chat and live events won't work without it),
**`X-Forwarded-*`** (the server runs with `trustProxy` and needs the real client
scheme/IP), and a **body-size limit** matching `MAX_UPLOAD_SIZE` (default 100 MB).

Replace `chat.example.com` and `8080` with your domain and `APP_PORT`.

**nginx.** The `map` goes in `http { }` once; the `server` block per site:

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl;
    server_name chat.example.com;

    # ssl_certificate     /etc/letsencrypt/live/chat.example.com/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;

    client_max_body_size 100m;        # match MAX_UPLOAD_SIZE

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
        proxy_set_header Upgrade    $http_upgrade;        # WebSocket
        proxy_set_header Connection $connection_upgrade;  # WebSocket
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # Voice only: forward LiveKit signaling (strips the /livekit prefix):
    # location /livekit/ {
    #     proxy_pass http://127.0.0.1:7880/;
    #     proxy_http_version 1.1;
    #     proxy_set_header Host       $host;
    #     proxy_set_header Upgrade    $http_upgrade;
    #     proxy_set_header Connection $connection_upgrade;
    # }
}
```

**Caddy** (if you run your own; it handles WebSocket and `X-Forwarded-*` itself):

```caddy
chat.example.com {
    reverse_proxy 127.0.0.1:8080
    request_body { max_size 100MB }

    # Voice only:
    # handle_path /livekit/* { reverse_proxy 127.0.0.1:7880 }
    # handle           { reverse_proxy 127.0.0.1:8080 }
}
```

**Traefik** (file provider; Traefik handles WebSocket automatically):

```yaml
http:
  routers:
    backspace:
      rule: "Host(`chat.example.com`)"
      entryPoints: [websecure]
      service: backspace
      tls: { certResolver: letsencrypt }
  services:
    backspace:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:8080"
  # Voice only: add a higher-priority router + stripPrefix middleware for
  # PathPrefix(`/livekit`) → http://127.0.0.1:7880.
```

#### GUI proxies (Nginx Proxy Manager, SWAG, etc.)

You can't paste a config file into a point-and-click proxy, so set these fields
by hand. In **Nginx Proxy Manager**, add a **Proxy Host**:

| Field | Value |
|-------|-------|
| **Domain Names** | `chat.example.com` |
| **Scheme** | `http` |
| **Forward Hostname / IP** | `127.0.0.1`, but **if NPM runs in Docker**, `127.0.0.1` is NPM's *own* container. Use the host's LAN IP, or `host.docker.internal` with `extra_hosts: ["host.docker.internal:host-gateway"]` on the NPM container. |
| **Forward Port** | your `APP_PORT` (e.g. `8080`) |
| **Websockets Support** | **ON** (required; chat/live events break without it) |
| **Block Common Exploits** | fine to leave on |
| **SSL tab** | request a Let's Encrypt cert and enable **Force SSL** |
| **Advanced tab** | add `client_max_body_size 100m;` (match `MAX_UPLOAD_SIZE`) |

The same three ideas apply to any GUI proxy: forward to the app's host+port,
enable WebSocket support, and raise the request-body limit.

### Mode 3: behind a tunnel (Cloudflare, Tailscale)

Same loopback publish as Mode 2, but the tunnel daemon on the host reaches
`127.0.0.1:APP_PORT` and no inbound ports are opened at all. For **Cloudflare
Tunnel** (`cloudflared`):

```yaml
# ~/.cloudflared/config.yml
tunnel: <YOUR-TUNNEL-ID>
credentials-file: /root/.cloudflared/<YOUR-TUNNEL-ID>.json

ingress:
  - hostname: chat.example.com
    service: http://127.0.0.1:8080
  - service: http_status:404
```

```bash
cloudflared tunnel route dns <YOUR-TUNNEL-ID> chat.example.com
```

Two tunnel-specific caveats, both handled by the installer:

- **Upload cap.** Cloudflare (free/pro) hard-caps request bodies at **100 MB**, so
  the 100 MB default would let large uploads fail *at the edge*. In `tunnel` mode
  the installer sets `MAX_UPLOAD_SIZE=94371840` (90 MB) with headroom. Don't raise
  it back above ~100 MB behind Cloudflare.
- **No voice.** Voice/video is **WebRTC over UDP**, which a tunnel can't carry, so
  it's disabled in `tunnel` mode. If you need voice, use Mode 2 (reverse proxy)
  with the media ports opened, or All-in-One.

### Voice per mode

Voice/video (LiveKit) needs its **UDP media ports** reachable from clients.
These carry the actual audio/video and never pass through your HTTP proxy or
tunnel:

| Port | Proto | Purpose |
|------|-------|---------|
| `3478` | UDP | TURN. WebRTC NAT traversal |
| `7881` | TCP | WebRTC TCP fallback |
| `50000–60000` | UDP | WebRTC media (voice / video / screen-share) |

- **All-in-One.** Voice works once those ports are open/forwarded. LiveKit
  *signaling* is proxied through Caddy on 443 (`/livekit`); port `7880` stays
  internal, never forwarded.
- **Reverse proxy.** You must **also** route `/livekit` to `127.0.0.1:7880` (see
  the commented lines in the snippets) **and** open the media ports above.
- **Tunnel.** Voice does **not** work (UDP can't traverse the tunnel). This is a
  known, unavoidable limitation, not a misconfiguration.

### Updating a running instance

Back up first. The app auto-snapshots the SQLite DB, and you can take one on
demand with `./backup.sh` (see [`docs/systems/deployment.md`](docs/systems/deployment.md)).
Then, from the install directory:

```bash
git pull                              # refresh compose files / install.sh / docs

# Prebuilt-image installs (the default):
docker compose pull && docker compose up -d

# From-source installs (a fork, or BACKSPACE_BUILD=true):
docker compose up -d --build
```

Because `COMPOSE_FILE` lives in `.env`, these commands automatically use the
right compose files in every mode, with no `-f` flags to remember. A redeploy
briefly restarts the `backspace` container (clients reconnect automatically).

## Development

Requirements: **Node.js 20 or newer** and **pnpm 10**. The `.nvmrc` file keeps
Node 20 as the default development and production baseline, while newer Node
majors are supported and exercised in CI. The Docker image continues to build
on Node 20 regardless of your host.

```bash
pnpm install
cp .env.example .env          # set JWT_SECRET (openssl rand -hex 32)
pnpm dev                       # API server on :3005, Vite dev server on :5173
```

On Windows PowerShell, confirm Node 20 or newer and use the native copy command:

```powershell
node --version
pnpm install
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste the generated value after `JWT_SECRET=` in `.env`, then start both
development servers with `pnpm dev`. Use `node --version` to confirm the active
version if pnpm reports an engine warning.

> **Server/web only?** `pnpm install` also builds the desktop app's native
> keyboard-hook module (`uiohook-napi`), which needs a C++ toolchain
> (`make`, `g++`, `python3`). If those are missing it now **warns and continues**,
> and the server and web client don't need it. Install a build toolchain
> (Debian/Ubuntu: `sudo apt install build-essential python3`) only if you're
> building the **desktop** app. And to *self-host*, use the Docker installer
> above; it never touches the desktop package.

Run the halves separately if you prefer:

```bash
pnpm dev:server   # API + WebSocket on :3005
pnpm dev:web      # Vite dev server on :5173
```

Build everything for production (shared types → server → web):

```bash
pnpm build
```

In production the server serves the built web client directly.

## Configuration

All configuration is via environment variables (see [`.env.example`](.env.example)).
The most important:

| Variable             | Required | Default     | Description |
|----------------------|----------|-------------|-------------|
| `DOMAIN`             | yes      | none        | Public domain name of your instance |
| `JWT_SECRET`         | yes      | none        | Auth signing secret, **min 32 chars** (`openssl rand -hex 32`) |
| `DEPLOY_MODE`        | no       | `allinone`  | `allinone` \| `proxy` \| `tunnel`, see [Deployment modes](#deployment-modes) |
| `APP_PORT`           | no       | auto        | `proxy`/`tunnel` only: host loopback port the app is published on |
| `PORT`               | no       | `3000`      | App listen port (behind Caddy in Docker) |
| `HOST`               | no       | `0.0.0.0`   | Bind address |
| `REGISTRATION_OPEN`  | no       | `true`      | Set `false` to close signups after setup |
| `MAX_UPLOAD_SIZE`    | no       | `104857600` | Max upload size in bytes (100 MB; 90 MB in `tunnel` mode) |
| `BACKSPACE_IMAGE` / `BACKSPACE_IMAGE_TAG` | no | `ghcr.io/thezwiss/backspace` / `latest` | Prebuilt image to pull; pin a tag or point at your fork's registry |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | no | none | Enable voice/video |
| `COMPOSE_PROFILES`   | no       | none        | Set to `voice` to start the bundled LiveKit service |

## Voice & Video

Voice, video, and screen sharing require a [LiveKit](https://livekit.io/) server.
The Docker Compose file bundles one. Enable it by setting these in `.env`:

```bash
COMPOSE_PROFILES=voice
LIVEKIT_URL=wss://your-domain
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
```

Enabling voice also requires opening the WebRTC ports (`3478/UDP`, `7881/TCP`,
`50000–60000/UDP`). See [Open the firewall ports](#2-open-the-firewall-ports).

Without LiveKit configured, everything else works fully (text, federation, DMs,
uploads, search); only voice/video channels won't connect.

## Federation

Backspace instances can peer with each other so users on different servers can
become friends, DM, and call across instances, while each instance stays
independently owned and operated. Peering is mutual and authenticated with
HMAC-signed requests; identities are addressed as `username@instance`. Manage
peers from the **Connections** panel in settings. The protocol is documented in
[`docs/systems/federation.md`](docs/systems/federation.md) and
[`docs/systems/client-federation.md`](docs/systems/client-federation.md).

## Desktop App

The Electron desktop app wraps the web client and adds a system tray, native
notifications, global keybinds, and activity detection.

### Download

Grab the installer for your platform from the
[**latest release**](https://github.com/TheZwiss/backspace/releases/latest):

| Platform | File | Notes |
|----------|------|-------|
| Windows | `Backspace-<version>.exe` | Universal installer (x64 + arm64). SmartScreen may warn on first run; choose "More info" → "Run anyway". Auto-updates. |
| macOS | `Backspace-<version>-arm64.dmg` (Apple Silicon) / `Backspace-<version>-x64.dmg` (Intel) | Builds are currently **unsigned**: on first launch, right-click the app → **Open** → **Open**. Auto-update is not available on macOS yet, so check the releases page for new versions. |
| Linux | `Backspace-<version>-x86_64.AppImage` / `-arm64.AppImage`, or `.deb` (`amd64` / `arm64`) | AppImage auto-updates; `.deb` installs update via new releases. |

On first launch the app asks for your instance URL. Enter the address of the
Backspace server you use (e.g. `https://chat.example.com`).

### Building from source

```bash
cd packages/desktop
pnpm build:ts    # compile TypeScript
pnpm dev         # run in development
pnpm build       # package for distribution
```

Cross-platform builds are produced for Windows, macOS, and Linux. See
[`docs/systems/desktop.md`](docs/systems/desktop.md).

## Mobile

Backspace works on mobile today. Just open your instance in a phone browser.
The UI has a dedicated touch layout (bottom navigation, swipe gestures, and
full-screen views), and because it ships as an installable **PWA** you can use
your browser's **Add to Home Screen** to install it as a standalone app: its own
icon, no browser chrome, and an offline message queue that flushes when you
reconnect.

Native **iOS and Android app-store apps are planned**, once the project gains
traction and the funding for the developer-program licenses is secured. Until
then, the installable PWA is the supported way to run Backspace on a phone.

## Architecture

Backspace is a TypeScript monorepo managed with pnpm workspaces.

```
packages/
  shared/   - Shared types, permission bits, constants
  server/   - Fastify API + WebSocket server, Drizzle/SQLite, federation
  web/      - React 18 SPA (Vite, Tailwind, Zustand)
  desktop/  - Electron wrapper
```

| Layer        | Technology |
|--------------|------------|
| Server       | Node.js 20+, Fastify 4, TypeScript (strict) |
| Database     | SQLite (better-sqlite3) + Drizzle ORM |
| Auth         | JWT + bcrypt |
| Frontend     | React 18, Vite 6, Tailwind CSS 3, Zustand 5 |
| Voice/Video  | LiveKit |
| Media        | sharp (thumbnails), Cheerio (embeds) |
| Desktop      | Electron 40 |
| Deployment   | Docker Compose + Caddy (auto-HTTPS) |

Every subsystem has a dedicated specification under
[`docs/systems/`](docs/systems/): database schema, REST API, WebSocket
protocol, federation, permissions, voice, the design system, and more. **These
are the reference for how Backspace works**; start there if you want to
understand or extend a subsystem.

## FAQ

**Is Backspace a self-hosted Discord alternative?**
Yes. It gives you a Discord-style experience (spaces, channels, roles, voice,
video, screen sharing, DMs, friends) that you run entirely on your own server, so
you own the data and set the rules.

**How is it different from Revolt, Spacebar, Matrix, or Mumble?**
See the full [comparison](docs/comparison.md), including where each of those is the
better choice. In short: Backspace pairs a Discord-style client with a serious
voice and screen-share control surface and optional server-to-server federation.

**Does it have screen sharing and high-quality video?**
Yes. Screen sharing goes up to 4K/120fps within admin-set bounds, with per-stream
codec, bitrate, and resolution controls, RNNoise noise suppression, and a live
connection inspector. Voice and video use [LiveKit](https://livekit.io/) and are
optional; text, federation, DMs, and everything else run fully without them.

**Can I self-host it on a Raspberry Pi?**
Yes. The installer pulls a prebuilt multi-architecture image (amd64 and arm64), so
low-power and ARM boxes skip the heavy local build.

**Is it really open source?**
Yes, under the GNU AGPL-3.0. A separate commercial license is available for cases
the AGPL does not fit. Every released version stays available under the AGPL.

**Does it work on mobile?**
Yes, as an installable PWA with a dedicated touch layout. Native iOS and Android
apps are planned.

**What does "federation" mean here?**
Independent Backspace instances can peer with each other so users on different
servers can be friends, DM, and call across instances, while each server stays
independently owned. Requests between servers are HMAC-authenticated.

## Contributing

Contributions are welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md)
first. Backspace is a single-owner project, so all contributors sign a
[Contributor License Agreement](CLA.md), a one-time comment on your pull
request, handled automatically by a bot. **You keep the copyright to your
contribution** and grant the maintainer (Jannis Braun) an exclusive license to
it, which is what lets Backspace be offered under both the AGPL and a commercial
license. You also receive a perpetual license to reuse the specific code you
wrote in your own other projects.

## Security

If you discover a security vulnerability, please **do not** open a public issue.
Report it privately via a GitHub security advisory on this repository. See
[`SECURITY.md`](SECURITY.md). We'll work with you on a fix and coordinated
disclosure.

## License

Backspace is **free and open source software**, licensed under the
**[GNU Affero General Public License v3.0](LICENSE)** (`AGPL-3.0-only`).

In plain terms:

- Yes: self-host, run, study, and modify it, including commercially and inside a business.
- Yes: redistribute it and your changes under the same AGPL-3.0 license.
- Note: if you run a **modified** version as a network service, you must offer your
  users its complete corresponding source (AGPL § 13). Backspace makes this easy:
  set `BACKSPACE_SOURCE_URL` to your fork so the in-app "Source code" link points
  at what you actually run.
- Note: preserve the copyright and license notices.

**Commercial license.** If the AGPL doesn't fit (embedding Backspace in a
closed-source product, offering it as a managed service without publishing your
modifications, or an organization that can't use AGPL software), a separate
commercial license is available on request. See
[`LICENSE-COMMERCIAL.md`](LICENSE-COMMERCIAL.md).

> **Our open-source commitment.** Every released version of Backspace is, and
> will remain, available under the AGPL-3.0. The Contributor License Agreement
> exists to enable a commercial license and optional enterprise add-ons, **not**
> to take the open-source edition private. If this project is ever abandoned, or
> the open-source edition is relicensed under non-free terms, the community stays
> free to fork the last AGPL release.

Copyright © 2026 Jannis Braun. Contributions are made under the
[Contributor License Agreement](CLA.md): you keep your copyright and grant the
maintainer an exclusive license, which is what lets Backspace be offered under
both the AGPL and a commercial license.

"Backspace", the Backspace logo, and app icons are trademarks of Jannis Braun and
are not licensed under either the AGPL or the commercial license. Bundled
third-party components retain their own licenses; see [`NOTICE`](NOTICE).

## Acknowledgements

Built on the shoulders of [Fastify](https://fastify.dev/),
[Drizzle ORM](https://orm.drizzle.team/), [React](https://react.dev/),
[LiveKit](https://livekit.io/), [Tailwind CSS](https://tailwindcss.com/),
[Electron](https://www.electronjs.org/), and the broader open-source ecosystem.
The interface uses the [DM Sans](https://github.com/googlefonts/dm-fonts) font
(SIL Open Font License 1.1).
