# CLAUDE.md — Backspace Brain File

## IDENTITY

You are the sole developer of Backspace, an open-source, self-hosted Discord alternative. You are an expert full-stack TypeScript architect. You write production-quality code. You never cut corners. You never use placeholders. You finish what you start.

## DESIGN SYSTEM

Backspace has its own visual identity — it is NOT a Discord clone. The design prototype is the single source of truth:

- **Prototype file:** `Backspace-design-prototype.html` (open in browser to view)
- **Design language:** "Aether Drift" — warm matte surfaces with subtle frosted glass accents
- **Two-material system:** Solid matte panels for content (75%), frosted glass bubbles for persistent controls (25%)
- **Color palette:** Warm dark surfaces (#13131a chat, #1a1a23 sidebars), pastel accents (mint, peach, lavender, sky, amber, rose, coral)
- **Glass elements:** Server strip (left column), voice+user bubble (bottom-left, crosses over server strip), input bubble (bottom of chat)
- **Glass material:** `backdrop-filter: blur(20px) saturate(120%)`, warm-tinted `rgba(20,20,26,0.52)`, subtle 0.07 opacity borders
- **Key principles:** Calm over flashy. Warm over cool. Quiet glass (felt, not seen). No decorative gradients. Minimal shadows.
- **Accessibility:** `prefers-reduced-transparency` media query falls back to solid surfaces

When making UI changes, consult the prototype for colors, spacing, materials, and hierarchy. The frontend should converge toward this design.

## MISSION

Maintain and extend Backspace as a complete, production-quality application. The core application is fully built and deployed. Every change must uphold the same standard: no stubs, no TODOs, no shortcuts. A user must always be able to `docker compose up` and have a fully working chat platform.

## CRITICAL RULES

- NEVER use placeholder code, TODO comments, or `// ...rest of code` shortcuts. Every function you write must be FULLY implemented with real logic.
- NEVER use `// ...rest of code` or `// similar to above` shortcuts. Write out every single line.
- NEVER skip files or say "you can add this later". Build everything NOW.
- NEVER generate partial components. Every React component must be complete with all state, handlers, styling, and edge cases.
- If you hit the output limit, STOP mid-sentence and continue EXACTLY where you left off in your next message. Do NOT summarize or skip ahead.
- Write production-quality code from the start. Proper error handling, input validation, TypeScript strict mode, no `any` types.
- If something fails, FIX IT before moving on. Never leave broken code behind.
- Test changes with `pnpm dev` before considering them done. Both server and frontend must start without errors.

## TECH STACK (DO NOT DEVIATE)

| Layer | Technology | Package |
|-------|-----------|---------|
| Runtime | Node.js 20+ with TypeScript (strict mode) | typescript, tsx |
| Backend Framework | Fastify | fastify, @fastify/cors, @fastify/multipart, @fastify/static, @fastify/websocket, @fastify/rate-limit |
| Database | SQLite | better-sqlite3 |
| ORM | Drizzle ORM | drizzle-orm, drizzle-kit |
| Auth | JWT + bcrypt | jsonwebtoken, bcryptjs |
| WebSocket | ws (via @fastify/websocket) | @fastify/websocket |
| Frontend | React 18 + TypeScript | react, react-dom, react-router-dom |
| Styling | Tailwind CSS 3 | tailwindcss, postcss, autoprefixer |
| Build Tool | Vite 6 | vite, @vitejs/plugin-react |
| State Management | Zustand 5 | zustand |
| Voice/Video | LiveKit Client SDK | livekit-client, @livekit/components-react |
| LiveKit Token | livekit-server-sdk | livekit-server-sdk |
| Audio Processing | Web Noise Suppressor (RNNoise) | @sapphi-red/web-noise-suppressor |
| Markdown | react-markdown + remark-gfm | react-markdown, remark-gfm |
| Syntax Highlighting | prism-react-renderer | prism-react-renderer |
| HTML Parsing | Cheerio (server-side URL metadata) | cheerio |
| Desktop | Electron 33 | electron, electron-builder |
| Testing | Vitest + Testing Library | vitest, @testing-library/react, jsdom |
| Monorepo | pnpm workspaces | pnpm |

## PROJECT STRUCTURE

```
Backspace/
├── CLAUDE.md
├── Backspace-design-prototype.html
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── Dockerfile
├── docker-compose.yml
├── deploy.sh
├── Makefile
├── .env.example
├── .gitignore
├── README.md
├── packages/
│   ├── shared/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── types.ts
│   │       └── permissions.ts
│   ├── server/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── config.ts
│   │       ├── db/
│   │       │   ├── schema.ts
│   │       │   ├── index.ts
│   │       │   ├── seed.ts
│   │       │   └── migrate.ts
│   │       ├── routes/
│   │       │   ├── auth.ts
│   │       │   ├── users.ts
│   │       │   ├── servers.ts
│   │       │   ├── channels.ts
│   │       │   ├── messages.ts
│   │       │   ├── uploads.ts
│   │       │   ├── dm.ts
│   │       │   ├── livekit.ts
│   │       │   ├── social.ts
│   │       │   ├── settings.ts
│   │       │   └── utils.ts
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
│   │       ├── audio/
│   │       │   ├── AudioManager.ts
│   │       │   └── SpeakingDetector.ts
│   │       ├── stores/
│   │       │   ├── authStore.ts
│   │       │   ├── serverStore.ts
│   │       │   ├── chatStore.ts
│   │       │   ├── voiceStore.ts
│   │       │   ├── socialStore.ts
│   │       │   ├── settingsStore.ts
│   │       │   └── uiStore.ts
│   │       ├── hooks/
│   │       │   ├── useWebSocket.ts
│   │       │   ├── useLiveKit.ts
│   │       │   ├── useAuth.ts
│   │       │   ├── useTrackStats.ts
│   │       │   └── useAudioTrackPlayer.ts
│   │       ├── utils/
│   │       │   ├── permissions.ts
│   │       │   ├── livekitInternals.ts
│   │       │   └── screenShare.ts
│   │       ├── components/
│   │       │   ├── layout/
│   │       │   │   ├── AppLayout.tsx
│   │       │   │   ├── ServerSidebar.tsx
│   │       │   │   ├── ChannelSidebar.tsx
│   │       │   │   ├── MainContent.tsx
│   │       │   │   ├── RightPanel.tsx
│   │       │   │   ├── MemberSidebar.tsx
│   │       │   │   ├── ActivityPanel.tsx
│   │       │   │   ├── MemberListToggleButton.tsx
│   │       │   │   └── MobileNav.tsx
│   │       │   ├── chat/
│   │       │   │   ├── MessageList.tsx
│   │       │   │   ├── Message.tsx
│   │       │   │   ├── MessageInput.tsx
│   │       │   │   ├── TypingIndicator.tsx
│   │       │   │   ├── ImagePreview.tsx
│   │       │   │   ├── MarkdownRenderer.tsx
│   │       │   │   ├── MentionPopover.tsx
│   │       │   │   ├── MentionBadge.tsx
│   │       │   │   ├── Embed.tsx
│   │       │   │   └── FriendsPage.tsx
│   │       │   ├── voice/
│   │       │   │   ├── VoiceChannel.tsx
│   │       │   │   ├── VoiceChatPanel.tsx
│   │       │   │   ├── VoiceControlBar.tsx
│   │       │   │   ├── VoiceControls.tsx
│   │       │   │   ├── VoiceGrid.tsx
│   │       │   │   ├── VoiceUser.tsx
│   │       │   │   ├── StreamTile.tsx
│   │       │   │   ├── PictureInPicture.tsx
│   │       │   │   ├── IncomingCallModal.tsx
│   │       │   │   ├── GlobalAudioRenderer.tsx
│   │       │   │   ├── SoundController.tsx
│   │       │   │   ├── ConnectionInfoPopover.tsx
│   │       │   │   └── ScreenShareSettingsPopover.tsx
│   │       │   ├── auth/
│   │       │   │   ├── LoginPage.tsx
│   │       │   │   └── RegisterPage.tsx
│   │       │   ├── modals/
│   │       │   │   ├── CreateServer.tsx
│   │       │   │   ├── InviteModal.tsx
│   │       │   │   ├── CreateChannel.tsx
│   │       │   │   ├── JoinServer.tsx
│   │       │   │   ├── UserSettings.tsx
│   │       │   │   ├── ServerSettings.tsx
│   │       │   │   ├── ChannelSettingsModal.tsx
│   │       │   │   ├── NewDmModal.tsx
│   │       │   │   └── AddDmMemberModal.tsx
│   │       │   └── ui/
│   │       │       ├── Avatar.tsx
│   │       │       ├── Modal.tsx
│   │       │       ├── Tooltip.tsx
│   │       │       ├── ContextMenu.tsx
│   │       │       ├── LoadingSpinner.tsx
│   │       │       └── UserProfilePopout.tsx
│   │       ├── test/
│   │       │   └── setup.ts
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
    ├── backspace.db
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
    is_admin INTEGER DEFAULT 0,
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
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nickname TEXT,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, user_id)
);

-- Roles
CREATE TABLE roles (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#b9bbbe',
    position INTEGER DEFAULT 0,
    permissions TEXT,              -- decimal string of bigint permission bits
    created_at INTEGER NOT NULL
);

-- Member Roles (many-to-many)
CREATE TABLE member_roles (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (server_id, user_id, role_id)
);

-- Channels
CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,            -- 'text' | 'voice' | 'video'
    topic TEXT,
    position INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
);

-- Channel Permission Overrides
CREATE TABLE channel_overrides (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL,     -- 'role' | 'member'
    target_id TEXT NOT NULL,       -- role ID or user ID
    allow TEXT NOT NULL DEFAULT '0',  -- bigint decimal string
    deny TEXT NOT NULL DEFAULT '0',   -- bigint decimal string
    PRIMARY KEY (channel_id, target_type, target_id)
);

-- Messages
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    reply_to_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    content TEXT,
    edited_at INTEGER,
    created_at INTEGER NOT NULL
);

-- Attachments
CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    dm_message_id TEXT,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mimetype TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

-- Reactions
CREATE TABLE reactions (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- DM Channels
CREATE TABLE dm_channels (
    id TEXT PRIMARY KEY,
    owner_id TEXT,                 -- NULL for 1-on-1, set for group DMs
    created_at INTEGER NOT NULL
);

CREATE TABLE dm_members (
    dm_channel_id TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    closed INTEGER DEFAULT 0,     -- soft-close flag
    PRIMARY KEY (dm_channel_id, user_id)
);

-- DM Messages
CREATE TABLE dm_messages (
    id TEXT PRIMARY KEY,
    dm_channel_id TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    reply_to_id TEXT,
    content TEXT,
    edited_at INTEGER,
    created_at INTEGER NOT NULL
);

-- DM Reactions
CREATE TABLE dm_reactions (
    id TEXT PRIMARY KEY,
    dm_message_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- Friends
CREATE TABLE friends (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friend_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, friend_id)
);

-- Friend Requests
CREATE TABLE friend_requests (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'pending', -- 'pending' | 'accepted' | 'declined'
    created_at INTEGER NOT NULL
);

-- Read States
CREATE TABLE read_states (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    last_read_message_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, channel_id)
);

-- Server Folders
CREATE TABLE server_folders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT,
    color TEXT,
    position INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE server_folder_members (
    folder_id TEXT NOT NULL REFERENCES server_folders(id) ON DELETE CASCADE,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    PRIMARY KEY (folder_id, server_id)
);

-- Instance Settings (singleton row, id=1)
CREATE TABLE instance_settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    max_bitrate_kbps INTEGER NOT NULL DEFAULT 20000,
    min_bitrate_kbps INTEGER NOT NULL DEFAULT 500,
    bitrate_step_kbps INTEGER NOT NULL DEFAULT 500,
    allowed_resolutions TEXT NOT NULL DEFAULT '540,720,1080',
    allowed_framerates TEXT NOT NULL DEFAULT '30,45,60',
    max_resolution INTEGER NOT NULL DEFAULT 1080,
    max_framerate INTEGER NOT NULL DEFAULT 60,
    updated_at INTEGER NOT NULL
);
```

## REST API ENDPOINTS

```
# Auth
POST   /api/auth/register          { username, password, displayName? }     → { token, user }
POST   /api/auth/login             { username, password }                   → { token, user }

# Users
GET    /api/users/@me              (auth)                                   → { user }
PATCH  /api/users/@me              (auth) { displayName?, avatar?, customStatus?, status? } → { user }
GET    /api/users/:id              (auth)                                   → { user }

# Servers
POST   /api/servers                (auth) { name, icon? }                  → { server }
GET    /api/servers                (auth)                                   → { servers[] }
GET    /api/servers/:id            (auth)                                   → { server, channels[], members[], roles[] }
PATCH  /api/servers/:id            (auth, MANAGE_SERVER) { name?, icon? }  → { server }
DELETE /api/servers/:id            (auth, owner)                            → { success }
POST   /api/servers/:id/invite     (auth, CREATE_INVITE)                   → { inviteCode }
POST   /api/servers/:id/join       (auth) { inviteCode }                   → { server }
POST   /api/servers/join           (auth) { inviteCode }                   → { server }

# Members
GET    /api/servers/:id/members    (auth, member)                          → { members[] }
PATCH  /api/servers/:id/members/:uid (auth, MANAGE_ROLES) { roles }       → { member }
DELETE /api/servers/:id/members/:uid (auth, KICK_MEMBERS|self)             → { success }

# Roles
POST   /api/servers/:id/roles      (auth, MANAGE_ROLES) { name, color?, permissions? } → { role }
PATCH  /api/servers/:id/roles/:rid (auth, MANAGE_ROLES) { name?, color?, permissions?, position? } → { role }
DELETE /api/servers/:id/roles/:rid (auth, MANAGE_ROLES)                    → { success }
POST   /api/servers/:id/members/:uid/roles (auth, MANAGE_ROLES) { roleId } → { success }
DELETE /api/servers/:id/members/:uid/roles/:rid (auth, MANAGE_ROLES)       → { success }

# Channels
GET    /api/servers/:id/channels   (auth, member, VIEW_CHANNEL)            → { channels[] }
POST   /api/servers/:id/channels   (auth, MANAGE_CHANNELS) { name, type, topic? } → { channel }
PATCH  /api/channels/:id           (auth, MANAGE_CHANNELS) { name?, topic?, position? } → { channel }
DELETE /api/channels/:id           (auth, MANAGE_CHANNELS)                 → { success }

# Channel Permission Overrides
GET    /api/channels/:id/overrides (auth, MANAGE_CHANNELS)                 → { overrides[] }
PUT    /api/channels/:id/overrides (auth, MANAGE_CHANNELS) { targetType, targetId, allow, deny } → { override }
DELETE /api/channels/:id/overrides/:targetType/:targetId (auth, MANAGE_CHANNELS) → { success }

# Messages
GET    /api/channels/:id/messages  (auth, member) ?before=&limit=50       → { messages[] }
POST   /api/channels/:id/messages  (auth, SEND_MESSAGES) { content, attachments?, replyToId? } → { message }
PATCH  /api/messages/:id           (auth, author) { content }              → { message }
DELETE /api/messages/:id           (auth, author|MANAGE_MESSAGES)           → { success }

# File Uploads
POST   /api/uploads                (auth) multipart file                   → { attachment }
GET    /api/uploads/:filename      (public)                                → file stream

# Direct Messages
GET    /api/dm                     (auth)                                   → { dmChannels[] }
POST   /api/dm                     (auth) { userId }                       → { dmChannel }
DELETE /api/dm/:id                 (auth, member)                           → { success } (soft-close)
GET    /api/dm/:id/messages        (auth, member) ?before=&limit=50       → { messages[] }
POST   /api/dm/:id/messages        (auth, member) { content }             → { message }
PATCH  /api/dm/messages/:id        (auth, author) { content }              → { message }
DELETE /api/dm/messages/:id        (auth, author)                           → { success }
POST   /api/dm/:id/members         (auth, owner) { userId }               → { dmChannel } (group DM, max 10)
DELETE /api/dm/:id/members         (auth, member)                           → { success } (leave group DM)

# Social / Friends
GET    /api/social/friends         (auth)                                   → { friends[] }
GET    /api/social/requests        (auth)                                   → { requests[] }
POST   /api/social/requests        (auth) { username }                     → { request }
PATCH  /api/social/requests/:id    (auth) { action: 'accept'|'decline' }   → { request }
DELETE /api/social/requests/:id    (auth)                                   → { success } (cancel)
DELETE /api/social/friends/:id     (auth)                                   → { success }
GET    /api/social/search          (auth) ?q=                              → { users[] }

# Voice/Video
POST   /api/livekit/token          (auth) { channelId }                    → { token }

# Instance Settings (admin)
GET    /api/settings/streaming     (auth)                                   → { streamingLimits }
PATCH  /api/settings/streaming     (auth, admin) { maxBitrateKbps?, ... }  → { streamingLimits }

# Utilities
GET    /api/utils/metadata         (auth) ?url=                            → { title?, description?, image?, siteName? }
GET    /api/health                 (public)                                → { status: 'ok', timestamp }
```

## WEBSOCKET PROTOCOL

All WebSocket messages are JSON over `/ws`. Client authenticates by sending `{ type: 'auth', token: 'jwt...' }` as the first message. Server responds with `{ type: 'ready', ... }` containing all initial state.

### Client → Server
```
{ type: 'auth', token: string }
{ type: 'ping' }

# Server Messages
{ type: 'message_create', channelId, content, replyToId?, attachmentIds? }
{ type: 'message_edit', messageId, content }
{ type: 'message_delete', messageId }
{ type: 'typing_start', channelId }
{ type: 'reaction_add', messageId, emoji }
{ type: 'reaction_remove', messageId, emoji }
{ type: 'channel_ack', channelId, messageId }

# DM Messages
{ type: 'dm_message_create', dmChannelId, content, replyToId?, attachmentIds? }
{ type: 'dm_message_edit', messageId, content }
{ type: 'dm_message_delete', messageId }
{ type: 'dm_typing_start', dmChannelId }

# Presence
{ type: 'presence_update', status: 'online' | 'idle' | 'dnd' }

# Voice (Server Channels)
{ type: 'voice_join', channelId }
{ type: 'voice_leave' }
{ type: 'voice_status', isMuted?, isDeafened?, isCameraOn?, isScreenSharing? }

# DM Calls
{ type: 'dm_call_start', dmChannelId }
{ type: 'dm_call_accept', dmChannelId }
{ type: 'dm_call_reject', dmChannelId }
{ type: 'dm_call_end', dmChannelId }
```

### Server → Client
```
{ type: 'ready', user, servers, dmChannels, folders, voiceStates, readStates, activeCalls }
{ type: 'pong' }

# Server Messages
{ type: 'message_created', message: MessageWithUser }
{ type: 'message_updated', message: MessageWithUser }
{ type: 'message_deleted', messageId, channelId }
{ type: 'typing', channelId, userId, username }
{ type: 'reaction_added', messageId, channelId, reaction }
{ type: 'reaction_removed', messageId, channelId, userId, emoji }

# DM Messages
{ type: 'dm_message_created', message: DmMessageWithUser }
{ type: 'dm_message_updated', message: DmMessageWithUser }
{ type: 'dm_message_deleted', messageId, dmChannelId }
{ type: 'dm_channel_created', dmChannel }
{ type: 'dm_channel_closed', dmChannelId }
{ type: 'dm_member_added', dmChannelId, user }
{ type: 'dm_member_removed', dmChannelId, userId }

# Channel/Server Updates
{ type: 'channel_created', channel }
{ type: 'channel_updated', channel }
{ type: 'channel_deleted', channelId, serverId }
{ type: 'server_updated', server }
{ type: 'channel_ack', channelId, messageId, userId }

# Members & Presence
{ type: 'member_joined', serverId, member: MemberWithUser }
{ type: 'member_left', serverId, userId }
{ type: 'presence_update', userId, status }

# Voice
{ type: 'voice_state_update', channelId, userId, action: 'join' | 'leave' }
{ type: 'voice_status_update', userId, isMuted, isDeafened, isCameraOn, isScreenSharing }

# DM Calls
{ type: 'dm_call_incoming', dmChannelId, callerId, callerName }
{ type: 'dm_call_accepted', dmChannelId }
{ type: 'dm_call_rejected', dmChannelId }
{ type: 'dm_call_ended', dmChannelId }

# Social
{ type: 'friend_request_received', request }
{ type: 'friend_request_accepted', friend }
{ type: 'friend_removed', userId }
```

## PERMISSION SYSTEM

Bitwise permission engine defined in `packages/shared/src/permissions.ts`. Stored as decimal strings in the database (bigint is not JSON-safe).

| Bit | Permission | Description |
|-----|-----------|-------------|
| 0 | ADMINISTRATOR | Full access, bypasses all checks |
| 1 | VIEW_CHANNEL | See channel in list and read messages |
| 2 | MANAGE_CHANNELS | Create, edit, delete channels |
| 3 | MANAGE_ROLES | Create, edit, delete roles |
| 4 | MANAGE_SERVER | Edit server name, icon |
| 5 | CREATE_INVITE | Generate invite codes |
| 6 | KICK_MEMBERS | Remove members from server |
| 7 | BAN_MEMBERS | Ban members from server |
| 10 | SEND_MESSAGES | Post messages in text channels |
| 11 | MANAGE_MESSAGES | Delete other users' messages |
| 12 | ATTACH_FILES | Upload files to messages |
| 13 | READ_MESSAGE_HISTORY | View message history |
| 14 | ADD_REACTIONS | Add emoji reactions |
| 20 | CONNECT | Join voice channels |
| 21 | SPEAK | Transmit audio in voice |
| 22 | MUTE_MEMBERS | Server-mute other members |
| 23 | DEAFEN_MEMBERS | Server-deafen other members |
| 24 | MOVE_MEMBERS | Move members between voice channels |
| 25 | USE_VOICE_ACTIVITY | Use voice activity detection |
| 26 | STREAM | Share screen in voice channels |

**Resolution order:** Owner → @everyone role → Assigned roles (OR'd) → ADMINISTRATOR shortcut → Channel overrides (@everyone → role overrides → member override).

## ENVIRONMENT VARIABLES

```env
# Server
PORT=3000                          # HTTP/WS listen port
HOST=0.0.0.0                      # Bind address

# Auth
JWT_SECRET=<random-64-char-hex>   # Required — generate with: openssl rand -hex 32

# LiveKit (optional — leave empty to disable voice features)
LIVEKIT_URL=                       # WebSocket URL to LiveKit server
LIVEKIT_API_KEY=                   # LiveKit API key
LIVEKIT_API_SECRET=                # LiveKit API secret

# Storage
UPLOAD_DIR=./data/uploads          # File upload directory
DB_PATH=./data/backspace.db        # SQLite database path
MAX_UPLOAD_SIZE=104857600          # Max upload size in bytes (100MB)

# Registration
REGISTRATION_OPEN=true             # Set to false to disable new user signup
```

## DEPLOYMENT

**Live instance:** `https://nova.ddns.net` — Raspberry Pi behind OpenResty reverse proxy with HSTS.

**Infrastructure:**
- Docker container (`backspace`) on port 3000
- External Docker volume: `backspace-data` (mounted at `/app/data`)
- External Docker network: `backspace-net` (shared with reverse proxy)
- LiveKit server at `wss://nova.ddns.net/livekit`

**Deploy commands:**
- `./deploy.sh` — Syncs code via rsync to Pi, triggers `docker compose up -d --build`
- `./deploy.sh --local` — Use local IP (192.168.1.10)
- `./deploy.sh --remote` — Use remote DNS (nova.ddns.net)
- `make deploy` — Same as deploy.sh
- `make logs` — Watch Docker logs on Pi
- `make shell` — SSH into running container
- `make status` — Check container status

**Development:**
```bash
pnpm install
pnpm dev           # Starts server (:3005) + Vite (:5173) with proxy
```

## FEATURE STATUS

All core features are implemented and live:

- **Auth:** Registration (first user = admin), login, JWT sessions
- **Servers:** Create, join by invite, server settings, delete
- **Channels:** Text, voice, video types with position ordering
- **Messaging:** Send, edit, delete, replies, attachments, reactions, typing indicators, read states
- **Permissions:** Full RBAC with roles, per-channel overrides, computed permissions
- **Voice/Video:** LiveKit integration, mute/deafen, camera, screen share with VP9
- **Screen Share:** Configurable resolution/FPS/bitrate, gaming vs text mode, instance-level limits
- **DMs:** 1-on-1 and group DMs (up to 10), soft-close, message edit/delete
- **DM Calls:** Ringing state machine (ring → active → ended), auto-reject timeout
- **Friends:** Send/accept/decline requests, friend list, user search
- **Audio Processing:** RNNoise noise suppression, echo cancellation, auto gain control, per-user volume
- **File Uploads:** Multipart upload, immutable cache headers, directory traversal protection
- **Admin Panel:** Instance-level streaming limits (bitrate, resolution, framerate bounds)
- **URL Previews:** Server-side metadata extraction with Cheerio
- **Desktop:** Electron wrapper with tray, notifications, badge count
- **Docker:** Multi-stage build, health checks, persistent volume
