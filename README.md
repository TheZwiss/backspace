<div align="center">

<img src="packages/web/public/icons/logo.png" alt="Backspace" width="160" />

# Backspace

**An open, self-hosted communication platform — text, voice, video, and federation — that you own.**

[![License: Elastic License 2.0](https://img.shields.io/badge/license-Elastic%20License%202.0-2563eb.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-339933.svg)](https://nodejs.org/)
[![Status](https://img.shields.io/badge/status-active%20development-f59e0b.svg)](#project-status)

</div>

---

Backspace is a Discord-style chat platform you run on your own hardware. Spaces,
channels, roles, voice and video, screen sharing, direct messages, friends, file
sharing, and full-text search — plus **server-to-server federation**, so
independent Backspace instances can talk to each other while each stays under
its own control.

It is **source-available**: free to self-host, modify, and use — including
inside a business — but not to resell as a hosted service. See
[License](#license) for the exact terms.

> **Project status** <a name="project-status"></a>
> Backspace is in active development and runs on live test instances, but has not
> had a tagged public release yet. Expect rough edges, and pin to a specific
> commit if you deploy it.

## Screenshots

<!--
  Drop screenshots into docs/screenshots/ and uncomment the block below.
  Suggested shots: a space with channels, a voice channel with video tiles,
  a DM conversation, and the Connections / federation settings panel.

<div align="center">
  <img src="docs/screenshots/space.png" alt="Space view" width="800" />
  <img src="docs/screenshots/voice.png" alt="Voice & video" width="800" />
</div>
-->

_Screenshots coming soon._

## Features

### Communication
- Real-time text channels over WebSocket
- Voice and video channels via [LiveKit](https://livekit.io/)
- Screen sharing with configurable quality (VP9, up to 4K/120fps depending on instance limits)
- Direct messages — 1-on-1 and group DMs (up to 10 people)
- DM voice/video calls with ring / accept / reject
- Message reactions, replies, editing, and deletion
- Markdown formatting with syntax highlighting
- Typing indicators, read states, and presence
- Rich link embeds (YouTube, Vimeo, Spotify, and generic OpenGraph) with SSRF-protected scraping
- GIF search (Klipy)

### Organization
- Spaces with channel categories and folders
- Role-based permissions — bitwise RBAC with category- and channel-level overrides
- Customizable user sidebar layout
- Space discovery (public, request-to-join, and private)
- Shareable invite codes

### Social
- Friend requests and friendships
- User search and discovery
- Mutual friends and mutual spaces
- User profiles with banner, bio, and accent color

### Moderation
- Bans with reason and audit trail
- Voice restrictions (space-level mute/deafen, persisted)
- Member move and force-disconnect
- Join-request approval for gated spaces

### Federation
- Multi-instance peering with HMAC-signed server-to-server requests
- Federated identity resolution (`username@instance`)
- Cross-instance DMs — messages, reactions, and membership relay
- Cross-instance friends and presence
- File replication with size validation
- Background workers for outbox delivery, file download, peer health, and cleanup

### Platform
- File uploads with image thumbnails (via `sharp`)
- Full-text search with `from:`, `has:`, `before:`, and `after:` filters, plus jump-to-message
- Admin panel — user management, storage management, streaming/quality config, instance settings
- Automatic SQLite backups (pre-migration, scheduled, and manual) with restore tooling
- Electron desktop app (Windows, macOS, Linux) with global keybinds and activity detection
- Mobile-responsive web UI
- Account management — password change and account deletion with safeguards

## Quick Start

The fastest path for a real deployment is the interactive installer, which
generates your `.env`, configures HTTPS, and optionally enables voice.

```bash
git clone https://github.com/TheZwiss/backspace.git
cd backspace
./install.sh
```

The installer asks for your domain, generates a secure `JWT_SECRET`, and brings
the stack up with Docker. When it finishes, open `https://your-domain` and
**create the first account — it automatically becomes the instance admin.**
There is no default username or password.

### Manual Docker deployment

If you'd rather configure it yourself:

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
| `livekit`   | Voice/video server — optional, enabled with `COMPOSE_PROFILES=voice` |

Point your domain's DNS at the host and open ports `80`/`443`. Caddy obtains a
TLS certificate automatically. The first account you register becomes admin.

### Backups & restore

The app takes automatic SQLite snapshots (before every migration, on a schedule,
and on demand via `./backup.sh`). Restore from a snapshot with `./restore.sh`.
See [`docs/systems/deployment.md`](docs/systems/deployment.md) for the full
backup/restore and image-pinning guide.

## Development

Requirements: **Node.js 20+** and **pnpm 8+**.

```bash
pnpm install
cp .env.example .env          # set JWT_SECRET (openssl rand -hex 32)
pnpm dev                       # API server on :3005, Vite dev server on :5173
```

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
| `DOMAIN`             | yes      | —           | Public domain name of your instance |
| `JWT_SECRET`         | yes      | —           | Auth signing secret, **min 32 chars** (`openssl rand -hex 32`) |
| `PORT`               | no       | `3000`      | App listen port (behind Caddy in Docker) |
| `HOST`               | no       | `0.0.0.0`   | Bind address |
| `REGISTRATION_OPEN`  | no       | `true`      | Set `false` to close signups after setup |
| `MAX_UPLOAD_SIZE`    | no       | `104857600` | Max upload size in bytes (100 MB) |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | no | — | Enable voice/video |
| `COMPOSE_PROFILES`   | no       | —           | Set to `voice` to start the bundled LiveKit service |

## Voice & Video

Voice, video, and screen sharing require a [LiveKit](https://livekit.io/) server.
The Docker Compose file bundles one — enable it by setting these in `.env`:

```bash
COMPOSE_PROFILES=voice
LIVEKIT_URL=wss://your-domain
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
```

Without LiveKit configured, everything else — text, federation, DMs, uploads,
search — works fully; only voice/video channels won't connect.

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

```bash
cd packages/desktop
pnpm build:ts    # compile TypeScript
pnpm dev         # run in development
pnpm build       # package for distribution
```

Cross-platform builds are produced for Windows, macOS, and Linux. See
[`docs/systems/desktop.md`](docs/systems/desktop.md).

## Architecture

Backspace is a TypeScript monorepo managed with pnpm workspaces.

```
packages/
  shared/   — Shared types, permission bits, constants
  server/   — Fastify API + WebSocket server, Drizzle/SQLite, federation
  web/      — React 18 SPA (Vite, Tailwind, Zustand)
  desktop/  — Electron wrapper
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
[`docs/systems/`](docs/systems/) — database schema, REST API, WebSocket
protocol, federation, permissions, voice, the design system, and more. **These
are the reference for how Backspace works**; start there if you want to
understand or extend a subsystem.

## Contributing

Contributions are welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md)
first. All contributors sign a [Contributor License Agreement](CLA.md) — a
one-time comment on your pull request, handled automatically by a bot. You keep
copyright to your work; the CLA grants the maintainer the rights needed to use
and relicense the project.

## Security

If you discover a security vulnerability, please **do not** open a public issue.
Instead, report it privately to the maintainer via a GitHub security advisory on
this repository, or by direct contact. We'll work with you on a fix and
coordinated disclosure.

## License

Backspace is licensed under the **[Elastic License 2.0](LICENSE)**.

In plain terms:

- ✅ You may self-host, run, and use it — including commercially and inside a business.
- ✅ You may read, modify, and redistribute the source.
- ❌ You may **not** provide Backspace to third parties as a hosted or managed
  service (i.e. you can't sell Backspace-as-a-service) without a separate
  commercial license from the maintainer.
- ❌ You may not remove or obscure the license and copyright notices.

This makes Backspace **source-available**, not OSI "open source" — the only
practical difference is the hosted-service restriction above. If you want to
offer Backspace as a commercial service, contact the maintainer
([@TheZwiss](https://github.com/TheZwiss)) about a commercial license.

Bundled third-party components (the DM Sans font, etc.) retain their own
licenses; see [`NOTICE`](NOTICE).

"Backspace" and the Backspace logo are trademarks of Jannis Braun and are not
covered by the code license.

## Acknowledgements

Built on the shoulders of [Fastify](https://fastify.dev/),
[Drizzle ORM](https://orm.drizzle.team/), [React](https://react.dev/),
[LiveKit](https://livekit.io/), [Tailwind CSS](https://tailwindcss.com/),
[Electron](https://www.electronjs.org/), and the broader open-source ecosystem.
The interface uses the [DM Sans](https://github.com/googlefonts/dm-fonts) font
(SIL Open Font License 1.1).
