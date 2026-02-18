# Opencord

Open-source, self-hosted Discord alternative built with TypeScript.

## Features

- Real-time text messaging with WebSocket
- Servers, channels, and member management
- Voice and video chat via LiveKit
- Direct messages
- File uploads and image sharing
- Markdown message formatting
- Typing indicators and presence status
- Role-based permissions (owner, admin, member)
- Invite system with shareable codes
- Desktop app (Electron)
- Mobile-responsive web UI
- Docker deployment

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Fastify + TypeScript |
| Database | SQLite (better-sqlite3) + Drizzle ORM |
| Auth | JWT + bcrypt |
| Real-time | WebSocket (ws) |
| Frontend | React 18 + Tailwind CSS + Zustand |
| Voice/Video | LiveKit |
| Desktop | Electron |
| Build | Vite + pnpm workspaces |

## Quick Start with Docker

```bash
# Clone the repository
git clone https://github.com/your-username/opencord.git
cd opencord

# Create environment file
cp .env.example .env

# Generate a JWT secret
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env

# Start Opencord
docker compose up -d
```

Open `http://localhost:3000` in your browser. A default server "Opencord" is created automatically.

**Default admin account:** `admin` / `admin123` (change this after first login).

## Development Setup

### Prerequisites

- Node.js 20+
- pnpm 8+

### Install

```bash
pnpm install
```

### Configure

```bash
cp .env.example .env
# Edit .env with your settings (generate a JWT_SECRET)
```

### Run

```bash
# Start both server and web dev server
pnpm dev

# Or start individually
pnpm dev:server    # API server on :3000
pnpm dev:web       # Vite dev server on :5173
```

### Build

```bash
pnpm build
```

This builds the shared types, server, and web frontend. The server serves the built frontend in production mode.

## Project Structure

```
Opencord/
├── packages/
│   ├── shared/       # Shared TypeScript types
│   ├── server/       # Fastify API + WebSocket server
│   ├── web/          # React frontend (Vite + Tailwind)
│   └── desktop/      # Electron desktop app
├── data/             # SQLite DB + uploads (created at runtime)
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

## Voice & Video

Voice and video requires a [LiveKit](https://livekit.io/) server. Set these in your `.env`:

```
LIVEKIT_URL=wss://your-livekit-server
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
```

Without LiveKit configured, text chat works fully but voice/video channels will not connect.

## API

The server exposes a REST API and WebSocket endpoint:

- **REST API**: `http://localhost:3000/api/*`
- **WebSocket**: `ws://localhost:3000/ws`
- **Health check**: `GET /api/health`

See [CLAUDE.md](CLAUDE.md) for the full API reference.

## Desktop App

The Electron desktop app wraps the web UI and adds system tray, notifications, and native window controls.

```bash
cd packages/desktop
pnpm build:ts    # Compile TypeScript
pnpm dev         # Run in development
pnpm build       # Package for distribution
```

## License

MIT
