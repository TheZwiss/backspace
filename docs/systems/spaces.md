# Space & Membership System

Source files:
- `packages/server/src/routes/spaces.ts` — Space CRUD, invite, join, members, roles, bans, ownership transfer, invite preview
- `packages/server/src/routes/channels.ts` — Channel CRUD, category CRUD, channel layout reordering, channel/category permission overrides
- `packages/server/src/routes/explore.ts` — Discovery listing, public join, join request workflow
- `packages/server/src/routes/users.ts` — Space layout (sidebar folders/ordering) persistence via `PUT /api/users/@me/space-layout`
- `packages/web/src/stores/spaceStore.ts` — Client-side space state, multi-instance merge, LWW layout sync
- `packages/web/src/stores/exploreStore.ts` — Explore page state, multi-instance discovery aggregation
- `packages/web/src/components/modals/CreateSpace.tsx` — Space creation modal (icon crop, color, visibility)
- `packages/web/src/components/modals/JoinSpace.tsx` — Join-by-code modal with federation connect phases
- `packages/web/src/components/modals/ExploreSpacePreviewCard.tsx` — Compact discoverable-space card rendered inside the Join Space modal
- `packages/web/src/components/modals/InviteModal.tsx` — Invite link generation and copy
- `packages/web/src/components/modals/TransferOwnershipModal.tsx` — Ownership transfer member picker
- `packages/web/src/components/modals/SpaceSettings.tsx` — Space settings: overview, discovery, members, roles, bans
- `packages/web/src/components/JoinPage.tsx` — Public invite landing page with federation redirect
- `packages/web/src/hooks/useDragManager.ts` — Channel/category/voice-user drag-and-drop
- `packages/web/src/hooks/useSpaceJoin.ts` — Shared join/request state machine over exploreStore (used by ExplorePage SpaceCard and the JoinSpace modal preview card)
- `packages/web/src/utils/inviteParser.ts` — Invite code/URL/qualified-code parser

Cross-references: [database.md](database.md) (table schemas), [permissions.md](permissions.md) (resolution algorithm, override tiers), [websocket.md](websocket.md) (event types), [federation.md](federation.md) (peer relay), [voice.md](voice.md) (voice channel join)

---

## Space Lifecycle

### Creation

**Endpoint:** `POST /api/spaces` (`spaces.ts:spaceRoutes`)
**Auth:** Required
**Permission:** Any authenticated user

**Request body (`CreateSpaceRequest`):**

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| name | string | yes | trimmed, 1-100 chars |
| icon | string | no | Upload filename |
| banner | string | no | Upload filename |
| avatarColor | AvatarColor | no | Must be in `AVATAR_COLORS`; random if omitted |
| visibility | SpaceVisibility | no | `'public'` / `'request'` / `'private'`; defaults to `'private'` |
| description | string | no | trimmed, max 200 chars |

**AVATAR_COLORS:** `['mint', 'sky', 'lavender', 'coral', 'rose', 'teal', 'amber']`

**Atomic transaction creates:**

| Entity | ID | Details |
|--------|----|---------|
| Space | `spaceId` (snowflake) | With `inviteCode` = `crypto.randomBytes(4).toString('hex')` (8 hex chars) |
| Owner membership | `(spaceId, userId)` | Creator auto-joined |
| Category: "text-channels" | `textCategoryId` (snowflake) | position 0 |
| Category: "voice-channels" | `voiceCategoryId` (snowflake) | position 1 |
| Channel: "general" (text) | `channelId` (snowflake) | position 0, in text-channels category |
| Channel: "voice" (voice) | `voiceChannelId` (snowflake) | position 0, in voice-channels category |
| @everyone role | id = `spaceId` | `DEFAULT_EVERYONE_PERMISSIONS`, position 0, color `#b9bbbe` |

**DEFAULT_EVERYONE_PERMISSIONS bits:** VIEW_CHANNEL, SEND_MESSAGES, CREATE_INVITE, CONNECT, SPEAK, ATTACH_FILES, READ_MESSAGE_HISTORY, ADD_REACTIONS, STREAM

**Post-transaction:**
1. `connectionManager.addUserSpace(userId, spaceId)` — registers creator for WS broadcasts
2. Icon/banner attachment records cleaned up (reference now in `spaces` table)
3. Icon/banner resized via `resizeProfileImage(filePath, 'icon'|'banner')`

**Response:** 201, `Space` object

### Read

**List user's spaces:** `GET /api/spaces` — returns all spaces where user is a member. Response: `Space[]`.

**Get space detail:** `GET /api/spaces/:id` — membership required. Returns `SpaceWithChannelsAndMembers`:
- Channels filtered by `VIEW_CHANNEL` permission per-channel (computed per-user)
- Each channel includes `isPrivate` (true if @everyone has VIEW_CHANNEL deny override) and `myPermissions`
- Categories include `isPrivate` flag
- Roles include `permissions` field only if requesting user has `MANAGE_ROLES`
- `myPermissions` at space level included

### Update

**Endpoint:** `PATCH /api/spaces/:id`
**Permission:** `MANAGE_SPACE`

**Updatable fields:** name (1-100 chars), icon, banner, avatarColor (validated against AVATAR_COLORS), visibility (public/request/private), description (max 200 chars).

**Side effects:**
- Old icon/banner files deleted from disk when replaced
- New icon/banner resized via `resizeProfileImage`
- Attachment records cleaned up for newly-set images
- `space_updated` WS event broadcast to all space members

### Delete

**Endpoint:** `DELETE /api/spaces/:id`
**Permission:** Owner only (`isSpaceOwner` check)

**Transaction deletes (in order):**
1. `read_states` for all channels in the space (no FK cascade)
2. All channels (messages cascade via FK)
3. All `space_members`
4. All `space_folder_members` referencing this space
5. The space itself

**Post-transaction:** All attachment files and space icon/banner files deleted from disk.

---

## Invite System

### Invite Code Generation

**Endpoint:** `POST /api/spaces/:id/invite`
**Permission:** `CREATE_INVITE`

**Behavior:** Returns existing `inviteCode` if one exists. Only generates a new one (`crypto.randomBytes(4).toString('hex')`) if the space has no invite code. Invite codes are permanent (no expiration).

**Visibility gate:** returns `403` for `request`-visibility spaces — they are approval-gated and have no usable invite link (the join endpoints reject invite-code joins for them), so the endpoint refuses to hand one out. The client (`InviteModal`) shows an "invite by join request" notice instead of the invite UI for such spaces, and `POST /api/dm/space-invite` likewise rejects a `request`-visibility **local** space with `403 space_requires_approval` (remote request spaces are enforced by their home instance at join time).

**Response:** `{ inviteCode: string }`

### Invite URL Format

Generated by `InviteModal.tsx`:
- **Web:** `{instanceOrigin}/join/{inviteCode}` (e.g., `https://nova.ddns.net/join/a3f1b2c4`)
- **Deep link (Electron):** `backspace://join/{inviteCode}` or `backspace://join/{inviteCode}@{host}` for remote instances

### Invite Code Parser (`inviteParser.ts`)

Parses three input formats into `{ code: string; origin?: string }`:

| Format | Example | Parsed |
|--------|---------|--------|
| Bare code | `a3f1b2c4` | `{ code: 'a3f1b2c4' }` |
| Full URL | `https://remote.com/join/a3f1b2c4` | `{ code: 'a3f1b2c4', origin: 'https://remote.com' }` |
| Qualified code | `a3f1b2c4@remote.com` | `{ code: 'a3f1b2c4', origin: 'https://remote.com' }` |

If the parsed origin matches `window.location.origin`, it is treated as a bare code (origin stripped).

### Direct Friend Invitation (in-app)

`POST /api/dm/space-invite` (see [dm-system.md](dm-system.md)) sends a structured invite card to a friend via DM. The card carries a snapshot of the space (name, icon, member count, description) plus the canonical identifiers (`spaceId`, `spaceInstanceOrigin`, `inviteCode`).

The endpoint lives on the **caller's home instance**, not the space's home. The caller's instance fetches the snapshot server-to-server from the space's `GET /api/spaces/invite/:code/preview` endpoint, then inserts a `type='system'` DM message with `event: 'space_invite'` content. Three-way federation (sender on X, recipient on Y, space on Z) is supported without new federation event kinds.

The friend-picker surface in `InviteModal` uses the same per-space invite code as the link-share footer — there is exactly one invite code per space at any time, and revocation (when implemented) invalidates all outstanding cards atomically.

### Invite Preview

**Endpoint:** `GET /api/spaces/invite/:code/preview` (no auth required)

**Response (`InvitePreview`):**

```typescript
{
  spaceId: string;
  spaceName: string;
  description: string | null;
  icon: string | null;
  avatarColor: AvatarColor | null;
  memberCount: number;     // live count from space_members
  instanceName: string;    // from instance_settings
}
```

### Join by Invite Code

Two endpoints serve the same purpose:

| Endpoint | Use case |
|----------|----------|
| `POST /api/spaces/:id/join` | Join when spaceId is known (body: `{ inviteCode }`) |
| `POST /api/spaces/join` | Join by code only, spaceId looked up from `inviteCode` |

**Validations:** invite code match, not banned, not already a member, and **space visibility is not `request`**.

**Visibility gate:** invite-code joins are rejected (`403`) for `request`-visibility spaces — entry to a request-only space must go through `POST /api/spaces/:id/request-join` + manager approval, never a bearer invite code. `private` spaces remain invite-joinable (an invite is their only entry path); `public` spaces are joinable by code or via `POST /api/spaces/:id/public-join`. Combined with the permission membership gate (a non-member cannot obtain `CREATE_INVITE`, see [permissions.md](permissions.md)), this closes the invite-bypass path where a non-member could mint a code for a request-only space and self-join without approval.

**Side effects:**
1. Insert `space_members` row
2. `connectionManager.addUserSpace` for WS broadcasts — also pushes a scoped `space_voice_state` snapshot to the joining user so voice-channel occupants appear without a reload (see `docs/systems/websocket.md` → "Mid-session space join")
3. `member_joined` WS event broadcast to space
4. Response: `Space` object

### Join Page (`JoinPage.tsx`)

Public route at `/join/:inviteCode`. Handles five phases:

| Phase | Trigger | UI |
|-------|---------|-----|
| `preview` | Initial load | Space preview card + join button (auth) or login/register links (unauth) |
| `connect` | `NotConnectedError` on join attempt | Password prompt for federation connect |
| `fallback` | `DifferentPasswordError` on connect | Username + password for existing remote account |
| `other-instance` | User clicks "I use another instance" | Domain input for federation redirect |
| `already-member` | Join returns "already a member" | Green checkmark + auto-redirect (2s timer) |

**Federation redirect flow (other-instance):**
1. User enters their home domain (e.g., `my-instance.com`)
2. Constructs qualified invite: `{code}@{currentHost}`
3. Redirects to `https://{domain}/join/{qualifiedCode}`
4. Their home instance's JoinPage receives the qualified code, parses origin, and handles federation connect

**Preview fetching:** For remote invites, creates a temporary API client via `createApiClient(origin, () => null)` to fetch the preview without authentication.

### Join Space Modal (`JoinSpaceModal`)

Opened from the space sidebar "Join a Space" action. The `input` phase is
**discovery-first**: on open it triggers `exploreStore.fetchSpaces()` +
`fetchMyRequests()` (same multi-instance discovery data as the Explore page)
and renders up to 6 unjoined public/request spaces as compact
`ExploreSpacePreviewCard`s. A "Browse all in Explore" action routes to the full
Explore page — `navigate('/explore')` on desktop, `pushMobileScreen('explore')`
on mobile (`uiStore.isMobile`). Joining a public preview card closes the modal
and navigates into the space.

States: loading (skeletons), empty / all-joined (notice), discovery disabled by
admin (`discoveryEnabled=false` → notice, invite path becomes primary), fetch
error (quiet degrade — invite path unaffected).

Below a divider, the secondary **"Have an invite code?"** section keeps the
invite-code/link flow: `parseInviteInput` → `joinByCode(code, origin?)`, with the
unchanged federation phases:
- `connect` — password prompt for federation
- `fallback` — different-password login for remote instance

The join/request behavior of both the compact preview card and the Explore
page's `SpaceCard` is provided by the shared `useSpaceJoin` hook, so the two
surfaces cannot drift.

The direct sidebar "Explore Spaces" button remains the 1-click path to the full
Explore page; the modal's discovery preview is an additional, in-context entry
point, not a replacement.

---

## Discovery System

### Space Visibility

| Value | Explore listing | Join mechanism |
|-------|----------------|----------------|
| `private` | Not listed | Invite code only |
| `request` | Listed | Submit join request, requires approval |
| `public` | Listed | Instant join, no invite needed |

### Explore Endpoint

**Endpoint:** `GET /api/spaces/explore` (`explore.ts:exploreRoutes`)
**Auth:** Required
**Query params:** `q` (search), `limit` (1-100, default 50), `offset` (default 0)

**Instance-level gate:** Checks `instance_settings.discoveryEnabled`. If false, returns `{ spaces: [], total: 0, discoveryEnabled: false }`.

**Query:** Raw SQL with LEFT JOIN on `space_members` for member count. Filters to `visibility IN ('public', 'request')`. Search matches `name` or `description` (LIKE, case-insensitive). Ordered by `member_count DESC, created_at DESC`.

**Response (`ExploreSpace[]`):**

```typescript
{
  id: string;
  name: string;
  icon: string | null;
  banner: string | null;
  avatarColor: AvatarColor | null;
  description: string | null;
  visibility: 'public' | 'request';
  memberCount: number;
  createdAt: number;
  joined: boolean;         // true if requesting user is already a member
}
```

Also returns `total` (filtered count), `totalAll` (all discoverable), `discoveryEnabled`.

### Multi-Instance Discovery (`exploreStore.ts`)

`fetchSpaces()` queries home + all connected remote instances in parallel:
1. Waits for `instanceStore._autoConnectDone` to avoid querying with incomplete instance list
2. `Promise.allSettled` across home API + all connected instance APIs
3. Deduplicates by `spaceId:origin` key
4. Normalizes remote asset URLs via `resolveAssetUrl`
5. Merges into `TaggedExploreSpace[]` with `_instanceOrigin`

### Public Join

**Endpoint:** `POST /api/spaces/:id/public-join`
**Validation:** Space must have `visibility === 'public'`, not banned, not already member.

**Side effects:** Same as invite join (insert member, WS broadcast, add to connectionManager).
**Response:** Full `SpaceWithChannelsAndMembers` (not just `Space`), so the client can immediately populate the store without a follow-up `GET /api/spaces/:id`.

### Join Request Workflow

**Submit request:** `POST /api/spaces/:id/request-join`
- Space must have `visibility === 'request'`
- Rate limited: 5 per minute
- Message: optional, max 500 chars
- Checks for existing pending request (409 if exists)
- Creates `join_requests` row with status `'pending'`
- Sends `join_request_received` WS event to all space managers (owner + `MANAGE_SPACE` holders)

**List requests:** `GET /api/spaces/:id/join-requests?status=pending`
- Permission: owner or `MANAGE_SPACE`
- Status filter: `pending` (default), `accepted`, `declined`
- Returns `{ requests: JoinRequest[] }` with populated user data

**Decide request:** `PATCH /api/spaces/:id/join-requests/:requestId`
- Permission: owner or `MANAGE_SPACE`
- Body: `{ action: 'accept' | 'decline' }`
- Must be pending (400 if already decided)

Accept flow (atomic transaction):
1. Insert `space_members` row
2. Update request status to `'accepted'`, set `decidedBy` and `decidedAt`
3. `connectionManager.addUserSpace`
4. Broadcast `member_joined` to space
5. Build full `SpaceWithChannelsAndMembers` for accepted user
6. Send `join_request_accepted` WS event to requesting user (includes full space data)

Decline flow:
1. Update request status to `'declined'`
2. Send `join_request_declined` WS event to requesting user

**User's own requests:** `GET /api/users/@me/join-requests?status=<optional>`
- Returns all requests for the current user, optionally filtered by status

### Space Managers Resolution (`explore.ts:getSpaceManagers`)

Used to target `join_request_received` events. Iterates all space members and returns IDs where:
- `userId === space.ownerId`, OR
- `hasPermission(userId, spaceId, PermissionBits.MANAGE_SPACE)` returns true

---

## Membership

### Join

Three join paths:
1. **Invite code** — `POST /api/spaces/:id/join` or `POST /api/spaces/join`
2. **Public join** — `POST /api/spaces/:id/public-join` (visibility=public)
3. **Request accept** — `PATCH /api/spaces/:id/join-requests/:requestId` with `action: 'accept'`

All paths: insert `space_members`, register in `connectionManager`, broadcast `member_joined`.

### Leave / Kick

**Endpoint:** `DELETE /api/spaces/:id/members/:uid`

| Scenario | Condition | Permission |
|----------|-----------|------------|
| Self-leave | `uid === request.userId` | Any member (unless owner) |
| Kick | `uid !== request.userId` | `KICK_MEMBERS` |

**Owner restriction:** Owner cannot leave. Must transfer ownership or delete the space.
**Owner protection:** Cannot kick the owner.

**Cleanup on removal:**
1. Delete `space_members` row
2. Delete `voice_restrictions` for the member in this space
3. Delete `read_states` for the member in all space channels
4. Broadcast `member_left` WS event

### Ban

**Endpoint:** `POST /api/spaces/:id/bans`
**Permission:** `BAN_MEMBERS`
**Body:** `{ userId: string, reason?: string }`

**Protections:** Cannot ban owner, cannot ban self, 409 if already banned.

**Atomic transaction:**
1. Insert `bans` row (with `reason`, `bannedBy`, `createdAt`)
2. Delete `space_members`
3. Delete `member_roles`
4. Delete `read_states` for all space channels
5. Delete `voice_restrictions`

**WS events:**
- `member_left` to space (so other members update their list)
- `member_banned` to the banned user (with `reason`)

**List bans:** `GET /api/spaces/:id/bans` — requires `BAN_MEMBERS`. Returns ban records with both banned user and moderator user objects.

**Unban:** `DELETE /api/spaces/:id/bans/:uid` — requires `BAN_MEMBERS`. 404 if no ban found.

### Ownership Transfer

**Endpoint:** `PATCH /api/spaces/:id/transfer-ownership`
**Permission:** Owner only
**Body:** `{ newOwnerId: string }`
**Validation:** New owner must be a member, cannot transfer to self.

Updates `spaces.ownerId`, broadcasts `space_updated` WS event.

**Client (`TransferOwnershipModal`):** Member picker with search, two-step confirm. Shows warning "You will become a regular member." Uses toast notification on success.

### Member Role Management

**Set roles (replace):** `PATCH /api/spaces/:id/members/:uid`
- Permission: `MANAGE_ROLES`
- Body: `{ roleIds: string[] }`
- Cannot change own roles
- Cannot modify owner's roles (unless you are the owner)
- @everyone role (id=spaceId) cannot be assigned
- Atomically deletes all existing `member_roles` then inserts new ones
- Triggers `connectionManager.pushReadyPayload(uid)` to force re-sync
- Triggers `checkVoicePermissions(spaceId)` to enforce voice changes

**Add single role:** `POST /api/spaces/:id/members/:uid/roles` — body `{ roleId }`, requires `MANAGE_ROLES`

**Remove single role:** `DELETE /api/spaces/:id/members/:uid/roles/:roleId` — requires `MANAGE_ROLES`

---

## Role Management

### Create Role

**Endpoint:** `POST /api/spaces/:id/roles`
**Permission:** `MANAGE_ROLES`
**Body:** `{ name: string, color?: string, permissions?: string }`

- Name defaults to `'new role'` if empty
- Duplicate name check (case-insensitive, raw SQL COLLATE NOCASE)
- Permissions default to `DEFAULT_EVERYONE_PERMISSIONS` if not provided
- Position defaults to 0
- Color defaults to `'#b9bbbe'`
- After creation: pushes ready payload to all space members, checks voice permissions

### Update Role

**Endpoint:** `PATCH /api/spaces/:id/roles/:roleId`
**Permission:** `MANAGE_ROLES`
**Body:** `{ name?, color?, position?, permissions? }`

- Name: trimmed, non-empty, duplicate check (case-insensitive, excludes self)
- Permissions: validated as valid bigint string
- After update: pushes ready payload to all members, checks voice permissions

### Delete Role

**Endpoint:** `DELETE /api/spaces/:id/roles/:roleId`
**Permission:** `MANAGE_ROLES`

- Cannot delete @everyone role (roleId === spaceId)
- Deletes channel overrides referencing this role
- After delete: pushes ready payload to all members, checks voice permissions

---

## Channel Management

### Channel Types

| Type | Semantics |
|------|-----------|
| `text` | Message-based channel with read states, embeds, reactions |
| `voice` | Voice/video channel (LiveKit integration, see voice.md) |

### Create Channel

**Endpoint:** `POST /api/spaces/:id/channels`
**Permission:** `MANAGE_CHANNELS`

| Field | Validation |
|-------|------------|
| name | Required, trimmed, lowercased, spaces→hyphens, 1-100 chars |
| type | Required, `'text'` or `'voice'` |
| topic | Optional, trimmed |
| categoryId | Optional, validated against space's categories |

Position: `max(existing positions) + 1`.

**Response (201):** the created channel including the creator's computed `myPermissions` and `isPrivate: false` — same shape as the `channel_created` event payload — so the creating client can render it immediately without waiting for the broadcast to round-trip.

**Broadcast:** `channel_created` sent per-user (only to users with VIEW_CHANNEL on the new channel). Each user's event includes their computed `myPermissions`.

**Client reconciliation:** both the create response and the `channel_created` event are applied through the `upsertChannel` store action, which replaces `channels` and `channelPermissions` with fresh references. This is required because the sidebar's `visibleChannels` filter is keyed on `channelPermissions`; mutating that Map in place would set the value without triggering a re-render, leaving a freshly created channel hidden until the space was reopened.

### Update Channel

**Endpoint:** `PATCH /api/channels/:id`
**Permission:** `MANAGE_CHANNELS` (checked with channel-level override context)
**Body:** `{ name?, topic?, position?, categoryId? }`

- Name: same normalization as create
- Position: non-negative number
- categoryId: `null` to unassign, or valid category ID in same space

**Broadcast behavior:**
- If `categoryId` changed: calls `broadcastOverrideChange` (per-user VIEW_CHANNEL recheck, may send `channel_deleted` to users who lost access)
- Otherwise: simple `channel_updated` broadcast to channel viewers

### Delete Channel

**Endpoint:** `DELETE /api/channels/:id`
**Permission:** `MANAGE_CHANNELS`

**Cleanup sequence:**
1. Disconnect all voice participants (if voice channel)
2. Collect viewer IDs before deletion (for targeted broadcast)
3. Collect attachment filenames before cascade
4. Delete `read_states` (no FK)
5. Delete `messages` (attachments cascade)
6. Delete `channels` row
7. Delete attachment files from disk
8. Broadcast `channel_deleted` only to users who could see the channel

### Category Management

**Create:** `POST /api/spaces/:id/categories` — permission: `MANAGE_CHANNELS`, name 1-100 chars, auto-position. Broadcasts `category_created`.

**Update:** `PATCH /api/categories/:id` — permission: `MANAGE_CHANNELS`, updatable: name, position. Broadcasts `category_updated` (includes `isPrivate` flag).

**Delete:** `DELETE /api/categories/:id` — permission: `MANAGE_CHANNELS`. Transaction nulls `categoryId` on child channels, then deletes category. Broadcasts `category_deleted` then `channel_layout_updated` (per-user filtered).

### Channel Layout Reorder

**Endpoint:** `PATCH /api/spaces/:id/channel-layout`
**Permission:** `MANAGE_CHANNELS`

**Body:**
```typescript
{
  channels: Array<{ id: string; position: number; categoryId: string | null }>;
  categories: Array<{ id: string; position: number }>;
}
```

**Validation:**
- All channel IDs must belong to the space
- All category IDs must belong to the space
- All positions must be non-negative numbers
- Channel categoryId references must point to valid space categories

Applied atomically in a transaction. Broadcasts via `broadcastChannelLayout()` which sends `channel_layout_updated` per-user (each user sees only channels they have VIEW_CHANNEL on).

### Channel/Category Permission Overrides

OUT OF SCOPE for this document. See [permissions.md](permissions.md) for the three-tier override system (category overrides, channel overrides, member overrides) and the `computePermissions` algorithm.

Override endpoints documented here for API completeness:

| Endpoint | Permission | Notes |
|----------|------------|-------|
| `GET /api/channels/:id/overrides` | `MANAGE_ROLES` | List channel overrides |
| `PUT /api/channels/:id/overrides` | `MANAGE_ROLES` | Upsert (delete+insert in tx). Privilege escalation guard. |
| `DELETE /api/channels/:id/overrides/:targetType/:targetId` | `MANAGE_ROLES` | Remove override |
| `GET /api/categories/:id/overrides` | `MANAGE_ROLES` | List category overrides |
| `PUT /api/categories/:id/overrides` | `MANAGE_ROLES` | Upsert with escalation guard |
| `DELETE /api/categories/:id/overrides/:targetType/:targetId` | `MANAGE_ROLES` | Remove override |

All override mutations call `broadcastOverrideChange` (channel) or `broadcastCategoryOverrideChange` (category) which re-evaluates VIEW_CHANNEL per-user and sends `channel_updated` (gained access) or `channel_deleted` (lost access). Voice permission enforcement via `checkVoicePermissions` runs after every override change.

### Drag-and-Drop (`useDragManager.ts`)

Client-side hook managing three drag types:

| Type | Draggable | Drop target | Permission |
|------|-----------|-------------|------------|
| `channel` | Channel items | Before/after channels or categories | `MANAGE_CHANNELS` (`canManage`) |
| `category` | Category headers | Before/after channels or categories | `MANAGE_CHANNELS` (`canManage`) |
| `voiceUser` | Voice participant | Different voice channel | `MOVE_MEMBERS` (`canMoveMembers`) |

**Drop position normalization:** "before B" is normalized to "after A" (the preceding item in `orderedItems`) to prevent double drop-indicator rendering.

**Auto-scroll:** When dragging near top/bottom edges (40px), scrolls the sidebar container proportionally to edge distance.

**Self-drop guard:** Dropping on the same item is a no-op.

---

## Space Layout (Sidebar Ordering & Folders)

### Data Model

**Layout items (`SpaceLayoutItem`):**
```typescript
type SpaceLayoutItem =
  | { t: 's'; id: string }   // space reference
  | { t: 'f'; id: string };  // folder reference
```

**Folders (`SpaceFolder`):**
```typescript
interface SpaceFolder {
  id: string;
  userId: string;
  name: string | null;
  color: string | null;
  position: number;
  spaceIds: string[];   // ordered list of spaces in the folder
}
```

### Server Persistence

**Tables (see database.md):** `user_space_layout`, `space_folders`, `space_folder_members`

**Endpoint:** `PUT /api/users/@me/space-layout` (`users.ts`)

**Request body:**
```typescript
{
  items: SpaceLayoutItem[];
  folders: Record<string, {
    name: string | null;
    color: string | null;
    spaceIds: string[];
  }>;
  updatedAt?: number;   // LWW timestamp
}
```

**Server-generated folder IDs:** Clients use `new:*` prefixed keys for new folders. The server maps each `new:*` key to a `generateSnowflake()` ID. The response returns resolved IDs so the client can update references.

**Remote folder adoption:** If a folder ID does not match an existing folder and does not start with `new:`, the server creates it with the provided ID (handles folders created on another instance being pushed to this one).

**Transaction:**
1. For each folder in request: create new / update existing / adopt remote
2. Clear and re-insert `space_folder_members` with ordered positions
3. Delete folders not in request (with their members)
4. Replace `new:*` keys in items array with resolved IDs
5. Upsert `user_space_layout` row (JSON string of items)

**WS broadcast:** `space_layout_updated` sent to the user's other connections (multi-tab sync).

**Response:** `{ items, folders, updatedAt }`

### LWW Conflict Resolution

**Server-side guard** (`users.ts`): If the request includes `updatedAt` and it is older than the stored `updatedAt`, the write is rejected and the current layout is returned without modification.

**Client-side algorithm** (`spaceStore.ts:populateFromReady`):

```
On receiving ready payload from any instance:
  incomingTs = payload.layoutUpdatedAt ?? 0
  currentTs = store._layoutUpdatedAt

  if incomingTs >= currentTs:
    Accept incoming layout (overwrite local)
    _layoutUpdatedAt = incomingTs
  else:
    Keep local layout
    Push local layout to the stale instance via pushLayoutToOrigin()
```

**`pushLayoutToOrigin(origin, layout, folders, updatedAt)`:** Calls `targetApi.spaceLayout.update()` on the specific instance that had the stale layout. This ensures all instances converge to the newest layout.

### Multi-Instance Layout Push

**`updateSpaceLayout(items, folders)`** in spaceStore:
1. Optimistically applies the layout with `Date.now()` timestamp
2. Collects all targets: home API + all connected remote instance APIs
3. `Promise.allSettled` pushes to all targets in parallel
4. Uses the first successful response to resolve `new:*` folder IDs
5. Updates store with resolved layout

---

## WS Ready Payload

The space layout and folder data are delivered in the WS `ready` event (`handler.ts:buildReadyPayload`):

```typescript
{
  spaces: SpaceWithChannelsAndMembers[];
  folders: SpaceFolder[];
  spaceLayout: SpaceLayoutItem[] | null;
  layoutUpdatedAt: number | null;
  dmChannels: DmChannel[];
  // ... other fields
}
```

`populateFromReady` merges incoming data by origin:
- Replaces all spaces from the incoming origin, keeps spaces from other origins
- Populates `channelToSpaceMap`, `channelOriginMap`, `channelPermissions`, `voiceChannelIds`, `categoryOriginMap`
- DM channels: removes existing DMs from this origin, appends incoming, deduplicates 1-on-1 DMs by canonical member pair (prefers home-origin copy)
- Applies LWW layout merge as described above

---

## WS Events Summary

| Event | Direction | Trigger |
|-------|-----------|---------|
| `space_updated` | S→C (space) | Space metadata changed |
| `member_joined` | S→C (space) | New member via any join path |
| `member_left` | S→C (space) | Member left, kicked, or banned |
| `member_banned` | S→C (user) | Sent to the banned user with reason |
| `join_request_received` | S→C (user) | Sent to space managers when request submitted |
| `join_request_accepted` | S→C (user) | Sent to requester with full space data |
| `join_request_declined` | S→C (user) | Sent to requester |
| `channel_created` | S→C (per-user) | New channel, per-user VIEW_CHANNEL filter |
| `channel_updated` | S→C (per-user/channel) | Channel or override changed |
| `channel_deleted` | S→C (per-user) | Channel deleted or user lost VIEW_CHANNEL |
| `category_created` | S→C (space) | New category |
| `category_updated` | S→C (space) | Category name/position/privacy changed |
| `category_deleted` | S→C (space) | Category removed |
| `channel_layout_updated` | S→C (per-user) | Batch reorder, per-user channel filtering |
| `space_layout_updated` | S→C (user) | Sidebar layout changed (multi-tab sync) |

---

## Federation Considerations

### Instance Origin Tagging

Every space in the client store has `_instanceOrigin: string`:
- `''` (empty) = home instance
- `'https://remote.com'` = remote federated instance

All store actions resolve the correct API client via `getApiForOrigin(origin)` before making HTTP requests. The resolver is registered by `instanceStore` on import (breaks circular dependency).

### User ID Resolution

`getMyUserIdForOrigin(origin)` returns the user's ID on a specific instance:
- Home (`''`): returns `authStore.user.id`
- Remote: checks `_myUserIdByOrigin` cache (populated from WS ready events), falls back to `instanceStore` resolver

Used for self-leave (`leaveSpace` calls `removeMember` with the correct user ID for the instance).

### Remote Invite Join Flow

```
1. User enters invite URL pointing to remote instance
2. parseInviteInput extracts code + origin
3. joinByCode(code, origin) called
4. If not connected → NotConnectedError thrown
5. JoinSpaceModal/JoinPage enters 'connect' phase
6. User provides password → connectToRemote(origin, password)
7. If password mismatch → DifferentPasswordError → 'fallback' phase
8. On success: joinByCode retried, space added to store with _instanceOrigin
```

### Asset URL Normalization

Remote space icons, banners, and member avatars are resolved via `resolveAssetUrl(path, origin)` when:
- `populateFromReady` processes spaces from a remote origin
- `loadSpaceDetail` loads a remote space
- `joinByCode` returns a remote space
- `exploreStore.fetchSpaces` processes remote explore results

### Client Load State (`useSpaceStore`)

Two distinct flags track per-space load progress:

- `loadingSpaceId: string | null` — non-null while a `loadSpaceDetail` call is in flight. Drives the channel-list and member-list skeletons (gated through `useDelayedLoading`).
- `loadedSpaceIds: Set<string>` — populated only on successful `loadSpaceDetail` completion. Used to differentiate "load not yet attempted" from "loaded with empty result." Required by mobile UI to gate the empty-state mascot — without it, the mascot flashes during the pre-skeleton load window because `state.channels` is overwritten on each `loadSpaceDetail` and a fresh space switch leaves `spaceChannels` momentarily filtered to `[]`.

`loadedSpaceIds` lifecycle:
- Added on `loadSpaceDetail` success (the same `set()` that replaces `channels`/`categories`/`members`).
- Pruned per-space on `deleteSpace`, `leaveSpace`, `removeSpace`, `removeInstanceSpaces`.
- Wiped entirely on `reset` (logout).
- Ephemeral — not persisted.
