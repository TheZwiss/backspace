# CLAUDE.md — Opencord Brain File

## IDENTITY

You are the sole developer of Opencord, an open-source, self-hosted Discord alternative. You are an expert full-stack TypeScript architect. You write production-quality code. You never cut corners. You never use placeholders. You finish what you start.

## MISSION

Build Opencord from scratch as a complete, working application. All 8 phases. Every file fully implemented. No stubs, no TODOs, no "add later" comments. When you are done, a user must be able to docker compose up and have a fully working Discord clone.

## CRITICAL RULES

- NEVER use placeholder code, TODO comments, or // ...rest of code shortcuts. Every function you write must be FULLY implemented with real logic.
- NEVER use // ...rest of code or // similar to above shortcuts. Write out every single line.
- NEVER skip files or say "you can add this later". Build everything NOW.
- NEVER generate partial components. Every React component must be complete with all state, handlers, styling, and edge cases.
- If you hit the output limit, STOP mid-sentence and continue EXACTLY where you left off in your next message. Do NOT summarize or skip ahead.
- Write production-quality code from the start. Proper error handling, input validation, TypeScript strict mode, no any types.
- After completing each phase, UPDATE the ## PROGRESS section in CLAUDE.md marking it ✅ and noting what files were created.
- After completing each phase, RUN the test commands listed to verify it works before moving on.
- If something fails, FIX IT before moving on. Never leave broken code behind.

## TECH STACK (DO NOT DEVIATE)

| Layer | Technology | Package |
|-------|-----------|---------|
| Runtime | Node.js 20+ with TypeScript (strict mode) | typescript, tsx |
| Backend Framework | Fastify | fastify, @fastify/cors, @fastify/multipart, @fastify/static, @fastify/websocket |
| Database | SQLite | better-sqlite3 |
| ORM | Drizzle ORM | drizzle-orm, drizzle-kit |
| Auth | JWT + bcrypt | jsonwebtoken, bcryptjs |
| WebSocket | ws (via @fastify/websocket) | @fastify/websocket |
| Frontend | React 18 + TypeScript | react, react-dom, react-router-dom |
| Styling | Tailwind CSS 3 | tailwindcss, postcss, autoprefixer |
| Build Tool | Vite | vite, @vitejs/plugin-react |
| State Management | Zustand | zustand |
| Voice/Video | LiveKit Client SDK | livekit-client, @livekit/components-react |
| LiveKit Token | livekit-server-sdk | livekit-server-sdk |
| Desktop | Electron | electron, electron-builder |
| Monorepo | pnpm workspaces | pnpm |
| Markdown | react-markdown | react-markdown |

## PROJECT STRUCTURE

```
Opencord/
├── CLAUDE.md
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── .gitignore
├── README.md
├── packages/
│   ├── shared/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       └── types.ts
│   ├── server/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── config.ts
│   │       ├── db/
│   │       │   ├── schema.ts
│   │       │   ├── index.ts
│   │       │   └── seed.ts
│   │       ├── routes/
│   │       │   ├── auth.ts
│   │       │   ├── users.ts
│   │       │   ├── servers.ts
│   │       │   ├── channels.ts
│   │       │   ├── messages.ts
│   │       │   ├── uploads.ts
│   │       │   ├── dm.ts
│   │       │   └── livekit.ts
│   │       ├── ws/
│   │       │   ├── handler.ts
│   │       │   └── events.ts
│   │       └── utils/
│   │           ├── auth.ts
│   │           ├── snowflake.ts
│   │           └── permissions.ts
│   ├── web/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vite.config.ts
│   │   ├── tailwind.config.js
│   │   ├── postcss.config.js
│   │   ├── index.html
│   │   └── src/
│   │       ├── main.tsx
│   │       ├── App.tsx
│   │       ├── api/
│   │       │   └── client.ts
│   │       ├── stores/
│   │       │   ├── authStore.ts
│   │       │   ├── serverStore.ts
│   │       │   ├── chatStore.ts
│   │       │   ├── voiceStore.ts
│   │       │   └── uiStore.ts
│   │       ├── hooks/
│   │       │   ├── useWebSocket.ts
│   │       │   ├── useLiveKit.ts
│   │       │   └── useAuth.ts
│   │       ├── components/
│   │       │   ├── layout/
│   │       │   │   ├── AppLayout.tsx
│   │       │   │   ├── ServerSidebar.tsx
│   │       │   │   ├── ChannelSidebar.tsx
│   │       │   │   ├── MainContent.tsx
│   │       │   │   ├── MemberSidebar.tsx
│   │       │   │   └── MobileNav.tsx
│   │       │   ├── chat/
│   │       │   │   ├── MessageList.tsx
│   │       │   │   ├── Message.tsx
│   │       │   │   ├── MessageInput.tsx
│   │       │   │   ├── TypingIndicator.tsx
│   │       │   │   └── ImagePreview.tsx
│   │       │   ├── voice/
│   │       │   │   ├── VoiceChannel.tsx
│   │       │   │   ├── VoiceControls.tsx
│   │       │   │   ├── VoiceGrid.tsx
│   │       │   │   └── VoiceUser.tsx
│   │       │   ├── auth/
│   │       │   │   ├── LoginPage.tsx
│   │       │   │   └── RegisterPage.tsx
│   │       │   ├── modals/
│   │       │   │   ├── CreateServer.tsx
│   │       │   │   ├── InviteModal.tsx
│   │       │   │   ├── CreateChannel.tsx
│   │       │   │   ├── JoinServer.tsx
│   │       │   │   ├── UserSettings.tsx
│   │       │   │   └── ServerSettings.tsx
│   │       │   └── ui/
│   │       │       ├── Avatar.tsx
│   │       │       ├── Modal.tsx
│   │       │       ├── Tooltip.tsx
│   │       │       ├── ContextMenu.tsx
│   │       │       └── LoadingSpinner.tsx
│   │       └── styles/
│   │           └── globals.css
│   └── desktop/
│       ├── package.json
│       ├── tsconfig.json
│       ├── src/
│       │   ├── main.ts
│       │   └── preload.ts
│       └── electron-builder.yml
└── data/
    ├── opencord.db
    └── uploads/
```

## DATABASE SCHEMA

```sql
-- Users
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT,
    password_hash TEXT NOT NULL,
    avatar TEXT,
    status TEXT DEFAULT 'offline',
    custom_status TEXT,
    created_at INTEGER NOT NULL
);

-- Servers (Guilds)
CREATE TABLE servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT,
    owner_id TEXT NOT NULL REFERENCES users(id),
    invite_code TEXT UNIQUE,
    created_at INTEGER NOT NULL
);

-- Server Members
CREATE TABLE server_members (
    server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    role TEXT DEFAULT 'member',
    nickname TEXT,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, user_id)
);

-- Channels
CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    topic TEXT,
    position INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
);

-- Messages
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    content TEXT,
    edited_at INTEGER,
    created_at INTEGER NOT NULL
);

-- Attachments
CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mimetype TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

-- DM Channels
CREATE TABLE dm_channels (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
);

CREATE TABLE dm_members (
    dm_channel_id TEXT REFERENCES dm_channels(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (dm_channel_id, user_id)
);

-- DM Messages
CREATE TABLE dm_messages (
    id TEXT PRIMARY KEY,
    dm_channel_id TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    content TEXT,
    created_at INTEGER NOT NULL
);
```

## REST API ENDPOINTS

```
POST   /api/auth/register          { username, password, displayName? }  → { token, user }
POST   /api/auth/login             { username, password }                → { token, user }

GET    /api/users/@me              (auth)                                → { user }
PATCH  /api/users/@me              (auth) { displayName?, avatar?, customStatus? } → { user }
GET    /api/users/:id              (auth)                                → { user }

POST   /api/servers                (auth) { name, icon? }               → { server }
GET    /api/servers                (auth)                                → { servers[] }
GET    /api/servers/:id            (auth)                                → { server, channels[], members[] }
PATCH  /api/servers/:id            (auth, owner) { name?, icon? }       → { server }
DELETE /api/servers/:id            (auth, owner)                         → { success }
POST   /api/servers/:id/join       (auth) { inviteCode }                → { server }
POST   /api/servers/:id/invite     (auth, admin+)                       → { inviteCode }

GET    /api/servers/:id/channels   (auth, member)                       → { channels[] }
POST   /api/servers/:id/channels   (auth, admin+) { name, type, topic? } → { channel }
PATCH  /api/channels/:id           (auth, admin+) { name?, topic?, position? } → { channel }
DELETE /api/channels/:id           (auth, admin+)                        → { success }

GET    /api/channels/:id/messages  (auth, member) ?before=&limit=50     → { messages[] }
POST   /api/channels/:id/messages  (auth, member) { content, attachments? } → { message }
PATCH  /api/messages/:id           (auth, author) { content }           → { message }
DELETE /api/messages/:id           (auth, author|admin)                  → { success }

GET    /api/servers/:id/members    (auth, member)                       → { members[] }
PATCH  /api/servers/:id/members/:uid (auth, owner) { role }             → { member }
DELETE /api/servers/:id/members/:uid (auth, owner|self)                  → { success }

POST   /api/livekit/token          (auth) { channelId }                 → { token }

POST   /api/uploads                (auth) multipart file                → { attachment }
GET    /api/uploads/:filename      (public)                             → file stream

GET    /api/dm                     (auth)                                → { dmChannels[] }
POST   /api/dm                     (auth) { userId }                    → { dmChannel }
GET    /api/dm/:id/messages        (auth, member) ?before=&limit=50    → { messages[] }
POST   /api/dm/:id/messages        (auth, member) { content }          → { message }
```

## WEBSOCKET PROTOCOL

All WebSocket messages are JSON. Client authenticates by sending `{ type: 'auth', token: 'jwt...' }` as first message. Server responds with `{ type: 'ready', user, servers, dmChannels }`.

### Client → Server
```
{ type: 'auth', token: string }
{ type: 'message_create', channelId: string, content: string }
{ type: 'message_edit', messageId: string, content: string }
{ type: 'message_delete', messageId: string }
{ type: 'typing_start', channelId: string }
{ type: 'presence_update', status: 'online' | 'idle' | 'dnd' }
{ type: 'voice_join', channelId: string }
{ type: 'voice_leave' }
{ type: 'dm_message_create', dmChannelId: string, content: string }
```

### Server → Client
```
{ type: 'ready', user: User, servers: ServerWithChannelsAndMembers[], dmChannels: DmChannel[] }
{ type: 'message_created', message: MessageWithUser }
{ type: 'message_updated', message: MessageWithUser }
{ type: 'message_deleted', messageId: string, channelId: string }
{ type: 'typing', channelId: string, userId: string, username: string }
{ type: 'presence_update', userId: string, status: string }
{ type: 'voice_state_update', channelId: string, userId: string, action: 'join' | 'leave' }
{ type: 'member_joined', serverId: string, member: MemberWithUser }
{ type: 'member_left', serverId: string, userId: string }
{ type: 'dm_message_created', message: DmMessageWithUser }
```

## LIVEKIT CONFIGURATION

```
LiveKit URL:    wss://nova.ddns.net/livekit
API Key:        REDACTED_LIVEKIT_KEY
API Secret:     REDACTED_LIVEKIT_SECRET
```

## ENVIRONMENT VARIABLES

```
PORT=3000
HOST=0.0.0.0
JWT_SECRET=<random-64-char-hex>
LIVEKIT_URL=wss://nova.ddns.net/livekit
LIVEKIT_API_KEY=REDACTED_LIVEKIT_KEY
LIVEKIT_API_SECRET=REDACTED_LIVEKIT_SECRET
UPLOAD_DIR=./data/uploads
DB_PATH=./data/opencord.db
MAX_UPLOAD_SIZE=104857600
REGISTRATION_OPEN=true
```

## PROGRESS

- Phase 1: Foundation — ✅ Complete (package.json, pnpm-workspace.yaml, tsconfig.base.json, packages/shared/src/types.ts, packages/server/src/index.ts, config.ts, db/schema.ts, db/index.ts, db/seed.ts, routes/auth.ts, routes/users.ts, utils/auth.ts, utils/snowflake.ts, utils/permissions.ts, .env)
- Phase 2: Servers & Channels — ✅ Complete (routes/servers.ts, routes/channels.ts, updated index.ts)
- Phase 3: Real-time Messaging — ✅ Complete (ws/handler.ts, ws/events.ts, routes/messages.ts, updated index.ts with @fastify/websocket)
- Phase 4: Frontend — ✅ Complete (packages/web/ with all components, stores, hooks, API client, Vite config, Tailwind, Discord dark theme)
- Phase 5: Voice/Video — ✅ Complete (routes/livekit.ts, voice components in frontend, LiveKit hooks)
- Phase 6: File Sharing & DMs — ✅ Complete (routes/uploads.ts, routes/dm.ts, @fastify/multipart, join-by-invite endpoint)
- Phase 7: Electron — ✅ Complete (packages/desktop/src/main.ts with IPC handlers, preload.ts, electron-builder.yml, tsconfig.json)
- Phase 8: Docker — ✅ Complete (Dockerfile multi-stage build, docker-compose.yml, .env.example, .gitignore, .dockerignore, README.md)

## CURRENT PHASE

All 8 phases complete.
