# CLAUDE.md — Backspace Brain File

## IDENTITY

You are the sole developer of Backspace, an open-source, self-hosted Discord alternative. You are an expert full-stack TypeScript architect. You write production-quality code. You never cut corners. You never use placeholders. You finish what you start.

## DESIGN SYSTEM

Backspace has its own visual identity — it is NOT a Discord clone. The design prototype is the single source of truth:

- **Prototype file:** `Backspace-design-prototype.html` (open in browser to view)
- **Design language:** "Aether Drift" — warm matte surfaces with subtle frosted glass accents
- **Two-material system:** Solid matte panels for content (75%), frosted glass bubbles for persistent controls (25%)
- **Color palette:** Warm dark surfaces (#13131a chat, #1a1a23 sidebars), pastel accents (mint, peach, lavender, sky, amber, rose, coral)
- **Glass elements:** Space strip (left column), voice+user bubble (bottom-left, crosses over space strip), input bubble (bottom of chat)
- **Glass material:** `backdrop-filter: blur(20px) saturate(120%)`, warm-tinted `rgba(20,20,26,0.52)`, subtle 0.07 opacity borders
- **Key principles:** Calm over flashy. Warm over cool. Quiet glass (felt, not seen). No decorative gradients. Minimal shadows.
- **Accessibility:** `prefers-reduced-transparency` media query falls back to solid surfaces

When making UI changes, consult the prototype for colors, spacing, materials, and hierarchy. The frontend should converge toward this design.

### Surface Material Tiers

Every surface in Backspace falls into one of these tiers:

| Tier | Class | When to Use |
|------|-------|-------------|
| Structural | `bg-surface-*` | Permanent layout (sidebars, chat area, member list) |
| Strip | `.glass-strip` | Persistent edge chrome (space sidebar) |
| Bubble | `.glass-bubble` | Persistent floating controls (voice bar, input pill, sticky actions) |
| Popover | `.glass` | Small floating surfaces (context menus, popovers, autocomplete, tooltips) |
| Modal | `.glass-modal` | Large center-screen dialogs with backdrop scrim |
| Pill | `.glass-pill` | Tiny inline decorations (reactions, tags) |

**Rule:** If it floats above the content plane, it's glass. Never use `bg-surface-elevated` for floating/overlay elements — that's for static structural panels only.

**Modal backdrops** use `bg-black/50` — light enough for the glass card's blur to show through.

### Input Tiers

Every text input, textarea, and select uses one of these CSS classes (defined in `globals.css`):

| Tier | Class | When to Use | Focus |
|------|-------|-------------|-------|
| Standard | `.input-standard` | Form fields in modals, settings, auth pages | `ring-2` primary |
| Search | `.input-search` | Search bars, filter inputs, compact lookups | `ring-1` primary |
| Embedded | `.input-embedded` | Inside glass containers (chat input, search popover, DM search) | none |
| Danger | `.input-danger` | Destructive confirmations (delete account) | `ring-2` rose |

**Rule:** No resting border — the sunken `surface-input` background provides differentiation. Override padding/size with utility classes when needed (e.g. `input-standard w-full py-2.5` for taller auth inputs).

## MISSION

Maintain and extend Backspace as a complete, production-quality application. The core application is fully built and deployed across multiple instances with federation support. Every change must uphold the same standard: no stubs, no TODOs, no shortcuts. A user must always be able to `docker compose up` and have a fully working chat platform.

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
| Image Cropping | react-easy-crop | react-easy-crop |
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
├── Caddyfile
├── deploy.sh
├── install.sh
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
│   │       │   ├── admin.ts
│   │       │   ├── auth.ts
│   │       │   ├── users.ts
│   │       │   ├── spaces.ts
│   │       │   ├── channels.ts
│   │       │   ├── messages.ts
│   │       │   ├── uploads.ts
│   │       │   ├── dm.ts
│   │       │   ├── explore.ts
│   │       │   ├── search.ts
│   │       │   ├── instance.ts
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
│   │           ├── permissions.ts
│   │           ├── sanitize.ts
│   │           ├── fileCleanup.ts
│   │           └── storageJanitor.ts
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
│   │       │   ├── spaceStore.ts
│   │       │   ├── chatStore.ts
│   │       │   ├── voiceStore.ts
│   │       │   ├── socialStore.ts
│   │       │   ├── settingsStore.ts
│   │       │   ├── exploreStore.ts
│   │       │   ├── instanceStore.ts
│   │       │   └── uiStore.ts
│   │       ├── hooks/
│   │       │   ├── useWebSocket.ts
│   │       │   ├── useLiveKit.ts
│   │       │   ├── useAuth.ts
│   │       │   ├── useTrackStats.ts
│   │       │   ├── useAudioTrackPlayer.ts
│   │       │   ├── useFederationToasts.ts
│   │       │   ├── useFloatingPosition.ts
│   │       │   ├── useGridLayout.ts
│   │       │   └── useVoiceParticipantMeta.ts
│   │       ├── utils/
│   │       │   ├── permissions.ts
│   │       │   ├── livekitInternals.ts
│   │       │   ├── screenShare.ts
│   │       │   ├── assetUrls.ts
│   │       │   ├── colorExtractor.ts
│   │       │   ├── cropImage.ts
│   │       │   ├── federationOps.ts
│   │       │   ├── gradients.ts
│   │       │   ├── identity.ts
│   │       │   ├── inviteParser.ts
│   │       │   ├── mutuals.ts
│   │       │   ├── profileSync.ts
│   │       │   └── voice.ts
│   │       ├── components/
│   │       │   ├── layout/
│   │       │   │   ├── AppLayout.tsx
│   │       │   │   ├── SpaceSidebar.tsx
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
│   │       │   │   ├── FriendsPage.tsx
│   │       │   │   ├── ExplorePage.tsx
│   │       │   │   └── SearchPopover.tsx
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
│   │       │   │   ├── ScreenShareSettingsPopover.tsx
│   │       │   │   ├── StreamContextMenu.tsx
│   │       │   │   └── VoiceUserContextMenu.tsx
│   │       │   ├── auth/
│   │       │   │   ├── LoginPage.tsx
│   │       │   │   └── RegisterPage.tsx
│   │       │   ├── modals/
│   │       │   │   ├── CreateSpace.tsx
│   │       │   │   ├── InviteModal.tsx
│   │       │   │   ├── CreateChannel.tsx
│   │       │   │   ├── JoinSpace.tsx
│   │       │   │   ├── UserSettings.tsx
│   │       │   │   ├── SpaceSettings.tsx
│   │       │   │   ├── ChannelSettingsModal.tsx
│   │       │   │   ├── NewDmModal.tsx
│   │       │   │   ├── AddDmMemberModal.tsx
│   │       │   │   ├── ConnectedInstances.tsx
│   │       │   │   ├── DeleteAccountModal.tsx
│   │       │   │   ├── UserProfileModal.tsx
│   │       │   │   ├── settingsPanels/
│   │       │   │   │   ├── AccountPanel.tsx
│   │       │   │   │   ├── ConnectionsPanel.tsx
│   │       │   │   │   ├── VoicePanel.tsx
│   │       │   │   │   └── InstancePanel.tsx
│   │       │   │   ├── spaceSettingsPanels/
│   │       │   │   │   ├── OverviewPanel.tsx
│   │       │   │   │   ├── RolesPanel.tsx
│   │       │   │   │   ├── MembersPanel.tsx
│   │       │   │   │   └── BansPanel.tsx
│   │       │   │   └── instanceSettingsPanels/
│   │       │   │       ├── GeneralPanel.tsx
│   │       │   │       ├── StreamingPanel.tsx
│   │       │   │       └── StoragePanel.tsx
│   │       │   └── ui/
│   │       │       ├── Avatar.tsx
│   │       │       ├── Modal.tsx
│   │       │       ├── Tooltip.tsx
│   │       │       ├── ContextMenu.tsx
│   │       │       ├── LoadingSpinner.tsx
│   │       │       ├── UserProfilePopout.tsx
│   │       │       ├── ConfirmDialog.tsx
│   │       │       ├── ImageCropModal.tsx
│   │       │       ├── ToastContainer.tsx
│   │       │       ├── Toggle.tsx
│   │       │       └── Username.tsx
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
    home_instance TEXT,              -- federation home instance domain
    home_user_id TEXT,               -- user ID on home instance
    replicated_instances TEXT DEFAULT '[]',  -- JSON array of federated instances
    banner TEXT,                     -- profile banner image
    accent_color TEXT,               -- profile accent color
    avatar_color TEXT,               -- avatar background color
    bio TEXT,                        -- user biography
    is_deleted INTEGER DEFAULT 0,    -- soft-delete flag
    password_changed_at INTEGER,     -- token revocation: tokens issued before this are rejected
    created_at INTEGER NOT NULL
);

-- Spaces (Communities)
CREATE TABLE spaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT,
    banner TEXT,                     -- space banner image
    avatar_color TEXT,               -- space icon background color
    owner_id TEXT NOT NULL REFERENCES users(id),
    invite_code TEXT UNIQUE,
    visibility TEXT DEFAULT 'private',  -- 'public' | 'request' | 'private'
    description TEXT,                -- space description
    created_at INTEGER NOT NULL
);

-- Space Members
CREATE TABLE space_members (
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nickname TEXT,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (space_id, user_id)
);

-- Roles
CREATE TABLE roles (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#b9bbbe',
    position INTEGER DEFAULT 0,
    permissions TEXT,              -- decimal string of bigint permission bits
    created_at INTEGER NOT NULL
);

-- Member Roles (many-to-many)
CREATE TABLE member_roles (
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (space_id, user_id, role_id)
);

-- Channels
CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,            -- 'text' | 'voice'
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

-- Category Permission Overrides
CREATE TABLE category_overrides (
    category_id TEXT NOT NULL REFERENCES channel_categories(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL,     -- 'role' | 'member'
    target_id TEXT NOT NULL,       -- role ID or user ID
    allow TEXT NOT NULL DEFAULT '0',  -- bigint decimal string
    deny TEXT NOT NULL DEFAULT '0',   -- bigint decimal string
    PRIMARY KEY (category_id, target_type, target_id)
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
    uploader_id TEXT,                -- user who uploaded (null for legacy uploads)
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mimetype TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

-- Embeds (resolved URL previews)
CREATE TABLE embeds (
    id TEXT PRIMARY KEY,
    message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    dm_message_id TEXT REFERENCES dm_messages(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    embed_type TEXT NOT NULL CHECK (embed_type IN ('generic', 'video', 'image', 'audio', 'rich')),
    provider TEXT,                  -- 'youtube' | 'vimeo' | 'spotify' | null
    title TEXT,
    description TEXT,
    image TEXT,                     -- thumbnail/og:image URL
    embed_url TEXT,                 -- iframe-safe embed URL
    width INTEGER,
    height INTEGER,
    color TEXT,
    created_at INTEGER NOT NULL,
    CHECK (
        (message_id IS NOT NULL AND dm_message_id IS NULL) OR
        (message_id IS NULL AND dm_message_id IS NOT NULL)
    )
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

-- Space Folders
CREATE TABLE space_folders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT,
    color TEXT,
    position INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE space_folder_members (
    folder_id TEXT NOT NULL REFERENCES space_folders(id) ON DELETE CASCADE,
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    position INTEGER DEFAULT 0,          -- ordering within folder
    PRIMARY KEY (folder_id, space_id)
);

-- User Space Layout (per-user sidebar ordering)
CREATE TABLE user_space_layout (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    layout TEXT NOT NULL DEFAULT '[]',   -- JSON array of {t:'s',id} | {t:'f',id} items
    updated_at INTEGER NOT NULL
);

-- Instance Settings (singleton row, id=1)
CREATE TABLE instance_settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    instance_name TEXT DEFAULT 'Backspace',  -- federation instance name
    worker_id INTEGER,                       -- Snowflake worker ID for federation
    discovery_enabled INTEGER NOT NULL DEFAULT 1,  -- space discovery toggle
    max_bitrate_kbps INTEGER NOT NULL DEFAULT 20000,
    min_bitrate_kbps INTEGER NOT NULL DEFAULT 500,
    bitrate_step_kbps INTEGER NOT NULL DEFAULT 500,
    allowed_resolutions TEXT NOT NULL DEFAULT '540,720,1080',
    allowed_framerates TEXT NOT NULL DEFAULT '30,45,60',
    max_resolution INTEGER NOT NULL DEFAULT 1080,
    max_framerate INTEGER NOT NULL DEFAULT 60,
    registration_open INTEGER,               -- explicit registration override (null = use env)
    updated_at INTEGER NOT NULL
);

-- Bans
CREATE TABLE bans (
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT,
    banned_by TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (space_id, user_id)
);

-- Join Requests
CREATE TABLE join_requests (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message TEXT,
    status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'accepted' | 'declined'
    decided_by TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL,
    decided_at INTEGER
);

-- Voice Restrictions
CREATE TABLE voice_restrictions (
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    restriction_type TEXT NOT NULL,   -- 'mute' | 'deafen'
    moderator_id TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (space_id, user_id, restriction_type)
);
```

## REST API ENDPOINTS

```
# Auth
POST   /api/auth/register          { username, password, displayName?, avatarColor? }  → { token, user }
POST   /api/auth/login             { username, password }                   → { token, user }
GET    /api/auth/check-username    ?username=                               → { available, reason? }

# Users
GET    /api/users/@me              (auth)                                   → { user }
PATCH  /api/users/@me              (auth) { displayName?, avatar?, banner?, accentColor?,
                                     avatarColor?, bio?, customStatus?, status?,
                                     replicatedInstances?, homeUserId? }    → { user }
GET    /api/users/:id              (auth)                                   → { user }
POST   /api/users/@me/verify-password (auth) { password }                   → { valid }
POST   /api/users/@me/change-password (auth) { currentPassword?, newPassword } → { token }
DELETE /api/users/@me              (auth) { password, username }             → { success }
GET    /api/users/:id/mutuals      (auth) ?homeUserId=                      → { mutualFriends[], mutualSpaces[] }
PUT    /api/users/@me/space-layout  (auth) { items, folders }               → { items, folders }

# Spaces
POST   /api/spaces                (auth) { name, icon?, banner?, avatarColor?, visibility?, description? } → { space }
GET    /api/spaces                (auth)                                   → { spaces[] }
GET    /api/spaces/:id            (auth)                                   → { space, channels[], members[], roles[] }
PATCH  /api/spaces/:id            (auth, MANAGE_SPACE) { name?, icon?, banner?,
                                     avatarColor?, visibility?, description? } → { space }
DELETE /api/spaces/:id            (auth, owner)                            → { success }
POST   /api/spaces/:id/invite     (auth, CREATE_INVITE)                   → { inviteCode }
POST   /api/spaces/:id/join       (auth) { inviteCode }                   → { space }
POST   /api/spaces/join           (auth) { inviteCode }                   → { space }
PATCH  /api/spaces/:id/transfer-ownership (auth, owner) { newOwnerId }    → { space }

# Members
GET    /api/spaces/:id/members    (auth, member)                          → { members[] }
PATCH  /api/spaces/:id/members/:uid (auth, MANAGE_ROLES) { roleIds }     → { member }
DELETE /api/spaces/:id/members/:uid (auth, KICK_MEMBERS|self)             → { success }

# Bans
GET    /api/spaces/:id/bans       (auth, BAN_MEMBERS)                     → { bans[] }
POST   /api/spaces/:id/bans       (auth, BAN_MEMBERS) { userId, reason? } → { success }
DELETE /api/spaces/:id/bans/:uid  (auth, BAN_MEMBERS)                     → { success }

# Roles
POST   /api/spaces/:id/roles      (auth, MANAGE_ROLES) { name, color?, permissions? } → { role }
PATCH  /api/spaces/:id/roles/:rid (auth, MANAGE_ROLES) { name?, color?, permissions?, position? } → { role }
DELETE /api/spaces/:id/roles/:rid (auth, MANAGE_ROLES)                    → { success }
POST   /api/spaces/:id/members/:uid/roles (auth, MANAGE_ROLES) { roleId } → { success }
DELETE /api/spaces/:id/members/:uid/roles/:rid (auth, MANAGE_ROLES)       → { success }

# Channels
GET    /api/spaces/:id/channels   (auth, member, VIEW_CHANNEL)            → { channels[] }
POST   /api/spaces/:id/channels   (auth, MANAGE_CHANNELS) { name, type, topic? } → { channel }
PATCH  /api/channels/:id           (auth, MANAGE_CHANNELS) { name?, topic?, position? } → { channel }
DELETE /api/channels/:id           (auth, MANAGE_CHANNELS)                 → { success }

# Channel Permission Overrides
GET    /api/channels/:id/overrides (auth, MANAGE_CHANNELS)                 → { overrides[] }
PUT    /api/channels/:id/overrides (auth, MANAGE_CHANNELS) { targetType, targetId, allow, deny } → { override }
DELETE /api/channels/:id/overrides/:targetType/:targetId (auth, MANAGE_CHANNELS) → { success }

# Category Overrides
GET    /api/categories/:id/overrides           (auth, MANAGE_ROLES)                     → { overrides[] }
PUT    /api/categories/:id/overrides           (auth, MANAGE_ROLES) { targetType, targetId, allow, deny } → { success }
DELETE /api/categories/:id/overrides/:tt/:tid  (auth, MANAGE_ROLES)                     → { success }

# Messages
GET    /api/channels/:id/messages  (auth, member) ?before=&limit=50       → { messages[] }
POST   /api/channels/:id/messages  (auth, SEND_MESSAGES) { content, attachments?, replyToId? } → { message }
PATCH  /api/messages/:id           (auth, author) { content }              → { message }
DELETE /api/messages/:id           (auth, author|MANAGE_MESSAGES)           → { success }

# Search
GET    /api/channels/:id/search    (auth, member) ?q=&from=&has=&before=&after= → { results[], totalCount }
GET    /api/channels/:id/messages/around (auth, member) ?messageId=        → { messages[] }
GET    /api/dm/:id/search          (auth, member) ?q=&from=&has=&before=&after= → { results[], totalCount }
GET    /api/dm/:id/messages/around (auth, member) ?messageId=              → { messages[] }

# Explore / Discovery
GET    /api/spaces/explore         (auth) ?q=&limit=&offset=              → { spaces[], total, discoveryEnabled }
POST   /api/spaces/:id/public-join (auth)                                  → { space }
POST   /api/spaces/:id/request-join (auth) { message? }                    → { request }
GET    /api/spaces/:id/join-requests (auth, MANAGE_SPACE)                  → { requests[] }
PATCH  /api/spaces/:id/join-requests/:rid (auth, MANAGE_SPACE) { action }  → { request }
GET    /api/users/@me/join-requests (auth) ?status=                        → { requests[] }

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

# Instance Info (public)
GET    /api/instance/info          (public)                                → { name, version, registrationOpen }

# Instance Settings (admin)
GET    /api/settings/streaming     (auth)                                   → { streamingLimits }
PATCH  /api/settings/streaming     (auth, admin) { maxBitrateKbps?, ... }  → { streamingLimits }
GET    /api/settings/instance      (auth, admin)                            → { instanceName, registrationOpen, discoveryEnabled }
PATCH  /api/settings/instance      (auth, admin) { instanceName?, registrationOpen?, discoveryEnabled? } → { settings }

# Admin
GET    /api/admin/storage/stats    (auth, admin)                           → StorageStats
GET    /api/admin/storage/orphans  (auth, admin)                           → { orphans: OrphanedFile[] }
POST   /api/admin/storage/cleanup  (auth, admin) { dryRun?: boolean }      → CleanupResult
GET    /api/admin/users            (auth, admin) ?q=&page=&pageSize=&showDeleted= → AdminUserListResponse
PATCH  /api/admin/users/:id/role   (auth, admin) { isAdmin: boolean }      → AdminUser
POST   /api/admin/users/:id/reset-password (auth, admin)                   → { temporaryPassword }
DELETE /api/admin/users/:id        (auth, admin)                           → { success }

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

# Voice (Space Channels)
{ type: 'voice_join', channelId }
{ type: 'voice_leave' }
{ type: 'voice_status', isMuted?, isDeafened?, isCameraOn?, isScreenSharing? }
{ type: 'voice_disconnect', userId }

# Voice Moderation
{ type: 'voice_space_mute', userId, muted }
{ type: 'voice_space_deafen', userId, deafened }
{ type: 'voice_move', userId, targetChannelId }

# DM Calls
{ type: 'dm_call_start', dmChannelId }
{ type: 'dm_call_accept', dmChannelId }
{ type: 'dm_call_reject', dmChannelId }
{ type: 'dm_call_end', dmChannelId }
```

### Server → Client
```
{ type: 'ready', user, spaces, dmChannels, folders, spaceLayout, voiceStates, readStates, activeCalls }
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

# Channel/Space Updates
{ type: 'channel_created', channel }
{ type: 'channel_updated', channel }
{ type: 'channel_deleted', channelId, spaceId }
{ type: 'space_updated', space }
{ type: 'channel_ack', channelId, messageId, userId }

# Members & Presence
{ type: 'member_joined', spaceId, member: MemberWithUser }
{ type: 'member_left', spaceId, userId }
{ type: 'member_banned', spaceId, reason }
{ type: 'presence_update', userId, status }
{ type: 'user_updated', user }

# Voice
{ type: 'voice_state_update', channelId, userId, action: 'join' | 'leave' }
{ type: 'voice_status_update', userId, isMuted, isDeafened, isCameraOn, isScreenSharing }
{ type: 'voice_disconnected', userId, channelId }
{ type: 'voice_space_muted', userId, spaceId, muted }
{ type: 'voice_space_deafened', userId, spaceId, deafened }
{ type: 'voice_permission_muted', userId, spaceId, muted }
{ type: 'voice_moved', userId, oldChannelId, newChannelId }

# DM Calls
{ type: 'dm_call_incoming', dmChannelId, callerId, callerName }
{ type: 'dm_call_accepted', dmChannelId }
{ type: 'dm_call_rejected', dmChannelId }
{ type: 'dm_call_ended', dmChannelId }

# Social
{ type: 'friend_request_received', request }
{ type: 'friend_request_accepted', friend }
{ type: 'friend_removed', userId }

# Discovery
{ type: 'join_request_received', request }
{ type: 'join_request_accepted', request, space? }
{ type: 'join_request_declined', request }

# Embeds
{ type: 'embeds_resolved', messageId, channelId, embeds: Embed[] }
{ type: 'dm_embeds_resolved', messageId, dmChannelId, embeds: Embed[] }

# Space Layout
{ type: 'space_layout_updated', layout: SpaceLayoutItem[], folders: SpaceFolder[] }
```

## PERMISSION SYSTEM

Bitwise permission engine defined in `packages/shared/src/permissions.ts`. Stored as decimal strings in the database (bigint is not JSON-safe).

| Bit | Permission | Description |
|-----|-----------|-------------|
| 0 | ADMINISTRATOR | Full access, bypasses all checks |
| 1 | VIEW_CHANNEL | See channel in list and read messages |
| 2 | MANAGE_CHANNELS | Create, edit, delete channels |
| 3 | MANAGE_ROLES | Create, edit, delete roles |
| 4 | MANAGE_SPACE | Edit space name, icon |
| 5 | CREATE_INVITE | Generate invite codes |
| 6 | KICK_MEMBERS | Remove members from space |
| 7 | BAN_MEMBERS | Ban members from space |
| 10 | SEND_MESSAGES | Post messages in text channels |
| 11 | MANAGE_MESSAGES | Delete other users' messages |
| 12 | ATTACH_FILES | Upload files to messages |
| 13 | READ_MESSAGE_HISTORY | View message history |
| 14 | ADD_REACTIONS | Add emoji reactions |
| 20 | CONNECT | Join voice channels |
| 21 | SPEAK | Transmit audio in voice |
| 22 | MUTE_MEMBERS | Space-mute other members |
| 23 | DEAFEN_MEMBERS | Space-deafen other members |
| 24 | MOVE_MEMBERS | Move members between voice channels |
| 25 | STREAM | Share screen in voice channels |
| 26 | DISCONNECT_MEMBERS | Disconnect members from voice channels |

**Resolution order:** Owner → @everyone role → Assigned roles (OR'd) → ADMINISTRATOR shortcut → Interleaved category+channel overrides: for each tier (@everyone → role → member), category override is applied first, then channel override. Channel bits win for any bit they explicitly set; bits not touched by the channel cascade from the category.

## ENVIRONMENT VARIABLES

```env
# Domain (required for Caddy reverse proxy)
DOMAIN=example.com                 # Your server's public domain name

# Server
PORT=3000                          # HTTP/WS listen port
HOST=0.0.0.0                      # Bind address

# Auth
JWT_SECRET=<random-64-char-hex>   # Required — generate with: openssl rand -hex 32

# LiveKit (optional — leave empty to disable voice features)
LIVEKIT_URL=                       # WebSocket URL to LiveKit server
LIVEKIT_API_KEY=                   # LiveKit API key
LIVEKIT_API_SECRET=                # LiveKit API secret

# Max file upload size in bytes (default: 100MB)
MAX_UPLOAD_SIZE=104857600

# Registration
REGISTRATION_OPEN=true             # Set to false to disable new user signup

# Docker Compose profile — uncomment to enable LiveKit voice service
# COMPOSE_PROFILES=voice
```

## DEPLOYMENT

**Live instances:**
- `https://nova.ddns.net` — Raspberry Pi (primary)
- `https://orbit.ddns.net` — VM (secondary)

**Infrastructure:**
- Caddy reverse proxy with automatic HTTPS (replaces OpenResty)
- `Caddyfile` — Reverse proxy config, routes `/livekit/*` to LiveKit, everything else to Backspace
- Docker Compose with three services: `backspace`, `caddy`, `livekit` (optional via `COMPOSE_PROFILES=voice`)
- Data stored in `./data/` bind mount (DB + uploads)

**Setup:**
- `./install.sh` — Interactive first-time production installer (generates `.env`, `livekit.yaml`, starts services)
- Manual: copy `.env.example` to `.env`, configure, run `docker compose up -d --build`

**Deploy commands:**
- `./deploy.sh` — Syncs code via rsync to both instances, triggers rebuild
- `./deploy.sh pi` — Deploy to Pi only (nova.ddns.net)
- `./deploy.sh vm` — Deploy to VM only (orbit.ddns.net)
- `./deploy.sh all` — Deploy to both
- `./deploy.sh --local` — Force Pi via LAN IP (192.168.1.10)
- `./deploy.sh --remote` — Force Pi via public DNS

**Development:**
```bash
pnpm install
pnpm dev           # Starts server (:3005) + Vite (:5173) with proxy
```

## FEATURE STATUS

All core features are implemented and live:

- **Auth:** Registration (first user = admin), login, JWT sessions, username availability check
- **Spaces:** Create, join by invite, space settings, delete, ownership transfer
- **Channels:** Text and voice types with position ordering (voice channels support video/screen share)
- **Messaging:** Send, edit, delete, replies, attachments, reactions, typing indicators, read states
- **Permissions:** Full RBAC with roles, per-channel overrides, computed permissions
- **Voice/Video:** LiveKit integration, mute/deafen, camera, screen share with VP9
- **Screen Share:** Configurable resolution/FPS/bitrate, gaming vs text mode, instance-level limits
- **DMs:** 1-on-1 and group DMs (up to 10), soft-close, message edit/delete
- **DM Calls:** Ringing state machine (ring → active → ended), auto-reject timeout
- **Friends:** Send/accept/decline requests, friend list, user search
- **Audio Processing:** RNNoise noise suppression, echo cancellation, auto gain control, per-user volume
- **File Uploads:** Multipart upload, immutable cache headers, directory traversal protection
- **Inline Media:** Video/audio attachment playback, YouTube/Vimeo click-to-load embeds, Spotify rich embeds, external image URL display, database-backed embed resolution
- **URL Previews:** Server-side metadata extraction with Cheerio (now shared utility for embed resolver)
- **Desktop:** Electron wrapper with tray, notifications, badge count
- **Docker:** Multi-stage build, health checks, Caddy auto-HTTPS
- **Federation:** Multi-instance user replication, home instance tracking, connected instances UI, profile sync
- **Discovery:** Public/request/private space visibility, explore page, join requests with approval workflow
- **Moderation:** Space bans with reason/moderator audit trail, voice restrictions (server mute/deafen), member move/disconnect
- **Search:** Full-text message search with filters (from, has, before, after), jump-to-message context
- **User Profiles:** Banner, bio, accent color, avatar color, mutual friends/spaces, soft-delete accounts
- **Space Profiles:** Banner, avatar color, description, visibility settings
- **Account Management:** Password change, account deletion with owned-space safeguards, username availability check
- **Instance Settings:** Instance name, registration toggle, discovery toggle, persistent admin config
- **Category Settings:** Settings modal (rename, private toggle, delete), permission overrides with cascade to child channels
