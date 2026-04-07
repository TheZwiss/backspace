# DM System

Source files:
- `packages/server/src/routes/dm.ts` -- REST endpoints for DM CRUD, group lifecycle, message send/edit/delete, federation event queueing, `broadcastDmMessage()` with soft-close reopen logic
- `packages/server/src/routes/federation.ts` -- Inbound relay event processors: `processMemberAddEvent`, `processMemberRemoveEvent`, `processOwnershipTransferEvent`, `processCreateEvent`, `processUpdateEvent`, `processDeleteEvent`, reaction processors, identity resolution (`resolveLocalUser`, `resolveOrCreateReplicatedUser`, `findOrCreateDmChannel`)
- `packages/server/src/utils/federationOutbox.ts` -- `queueOutboxEvent`, `appendMutationLog`, `queueDmRelay`, `getDmParticipants`, `getGroupDmTargetOrigins`, `computeFederatedId`, `buildRelayPayload`
- `packages/server/src/utils/storageJanitor.ts` -- `cleanupSoftDeletedDmChannels()` (24h grace period hard-delete)
- `packages/server/src/db/migrate.ts` -- Self-healing migration for corrupted group DM ownership
- `packages/server/src/ws/handler.ts` -- `sendToDmMembers()` broadcasts (ConnectionManager method)
- `packages/web/src/stores/spaceStore.ts` -- Zustand DM state: `addDmChannel`, `removeDmChannel`, `addDmMember`, `removeDmMember`, `updateDmOwner`, `closeDm`, `leaveDm`, `findExistingDmForUser`
- `packages/web/src/hooks/useWebSocket.ts` -- Frontend WS event handlers for `dm_channel_created`, `dm_channel_closed`, `dm_member_added`, `dm_member_removed`, `dm_owner_updated`
- `packages/web/src/components/modals/NewDmModal.tsx` -- 1-on-1 DM creation UI with user search and deduplication
- `packages/web/src/components/modals/AddDmMemberModal.tsx` -- Group DM member add / 1-on-1 upgrade UI

DB tables: `dm_channels`, `dm_members`, `dm_messages`, `dm_reactions`, `read_states`, `attachments`, `embeds`. See `docs/systems/database.md` for full schemas.

Related specs: `docs/systems/federation.md` (wire protocol, outbox worker, peer lifecycle), `docs/systems/websocket.md` (event wire formats), `docs/systems/voice.md` (DM call state machine).

---

## Channel Type Identification

| Property | 1-on-1 DM | Group DM |
|----------|-----------|----------|
| `ownerId` | `NULL` | Creator's local user ID (never NULL) |
| `federatedId` format | 32-char hex (SHA-256 hash) | 36-char UUID (random) |
| Mutable membership | No (immutable pair) | Yes (owner adds, anyone leaves) |
| Max members | 2 | 10 |
| Friendship required | No | Yes (for new adds; exempt for existing DM members during 1-on-1 upgrade) |
| Soft-close | Yes (`closed=1` on dm_members) | Yes (same) |
| Leave | Not supported (use close) | Yes (DELETE `/api/dm/:id/members`) |
| Deletion | Never (1-on-1 DMs persist) | Soft-delete when last member leaves, hard-delete after 24h |

**Critical invariant:** `ownerId` must NEVER be set to NULL on a group DM. A NULL `ownerId` identifies the channel as 1-on-1 -- nulling it corrupts the channel's type identity and breaks membership logic.

---

## Federated ID Algorithm

```typescript
// federationOutbox.ts:computeFederatedId()

// 1-on-1: deterministic SHA-256 hash of sorted home user IDs
// Same result on any instance for the same user pair
const sorted = [homeUserIdA, homeUserIdB].sort();
const federatedId = crypto.createHash('sha256')
  .update(sorted.join(':'))
  .digest('hex')
  .slice(0, 32);  // 32-char hex string

// Group: random UUID assigned by the creating instance
const federatedId = crypto.randomUUID();  // 36-char UUID with dashes
```

The format difference (32-char hex vs 36-char UUID with dashes) allows detecting channel type independently of `ownerId`. The self-healing migration uses this: `length(federated_id) = 36 AND federated_id LIKE '________-____-____-____-____________'` identifies group DMs.

---

## 1-on-1 DM Creation

**Endpoint:** `POST /api/dm` -- `dm.ts:dmRoutes`

**Request:** `{ userId: string }`

**Deduplication algorithm:**
1. Query all `dm_members` rows where `userId = caller`
2. For each membership, check if `targetUserId` is also a member of that channel
3. If found, verify exactly 2 members in that channel (skip group DMs that happen to include the target)
4. If the channel exists and is not soft-deleted: reopen if caller had `closed=1`, return existing channel
5. If no match: create new channel atomically in a transaction

**Creation transaction:**
1. Insert `dm_channels` with `ownerId = NULL`, no `federatedId` (assigned lazily when federation relay first fires)
2. Insert two `dm_members` rows (caller + target)

**Post-creation:**
- Send `dm_channel_created` to the target user via WebSocket
- Return 201 with the `DmChannel` response to the caller

**No federation event queued at creation time.** The `federatedId` for 1-on-1 DMs is computed on demand when the first message is relayed via `queueDmRelay()`. The receiving instance uses `findOrCreateDmChannel()` which computes the deterministic hash and creates the channel if needed.

**Client routing:** DM creation always goes to the home instance. For federated users, the client passes `{ homeUserId, homeInstance }` and the server resolves the target via `resolveOrCreateReplicatedUser()`. The `federatedId` is computed at creation time when either participant has `homeInstance` set.

---

## Group DM Creation

**Endpoint:** `POST /api/dm/group` -- `dm.ts:dmRoutes`

**Request:** `CreateGroupDmRequest`

```typescript
interface CreateGroupDmRequest {
  users: GroupDmUserIdentity[];  // At least 2
  fromDmChannelId?: string;     // Source 1-on-1 DM for upgrade
}

interface GroupDmUserIdentity {
  id: string;
  homeUserId?: string | null;
  homeInstance?: string | null;
}
```

**Validation:**
1. `users` array must have at least 2 entries (minimum 3 total members including caller)
2. Total members (1 + users.length) capped at 10
3. Each identity resolved to a local user row:
   - If `homeUserId` + `homeInstance` provided: `resolveOrCreateReplicatedUser()`
   - Else: direct ID lookup, falling back to `resolveLocalUser()` for remote snowflake IDs
4. No duplicate resolved IDs
5. Caller cannot include themselves
6. All target users must be friends with the caller (exception: existing DM members when `fromDmChannelId` references a 1-on-1 DM the caller belongs to)

**Creation transaction:**
1. Insert `dm_channels` with `ownerId = caller`
2. Insert `dm_members` for caller + all target users

**Post-creation federation setup:**
- If federation relay is enabled and any member has a remote `homeInstance`:
  - Generate random UUID `federatedId` via `computeFederatedId()`
  - Update channel with `federatedId`, `ownerHomeUserId`, `ownerHomeInstance`

**Broadcasting (local-only principle):**
- `dm_channel_created` sent only to members whose `homeInstance` matches this instance
- Remote members receive the channel via federation relay bootstrap on their home instance

**System messages:**
- One `member_added` system message per target user, inserted into `dm_messages`
- Broadcast only to local members (remote instances create their own system messages)

**Federation relay (for remote members):**
- For each target user with a remote `homeInstance`:
  - Queue `member_add` event with full `group` roster (all participants)
  - `targetOrigins` includes all participant home origins plus the new member's origin
  - Event `messageId` format: `member_add:{userId}:{timestamp}`

---

## Soft-Close and Reopen

### Close (Hide)

**Endpoint:** `DELETE /api/dm/:id` -- `dm.ts:dmRoutes`

1. Verify caller is a member
2. Set `dm_members.closed = 1` for the caller (preserves membership)
3. Send `dm_channel_closed` to the caller (multi-tab sync)
4. Channel disappears from the caller's sidebar but they remain a member

### Automatic Reopen

**Trigger:** `dm.ts:broadcastDmMessage()`

When a new message arrives in a DM channel, for each member with `closed = 1`:
1. Flip `closed` back to `0`
2. Send `dm_channel_created` with full channel payload (including the new message as `lastMessage`) so their sidebar picks it up
3. Then send the `dm_message_created` event

This ensures closed DMs resurface automatically when new activity occurs.

### Frontend

- `spaceStore.closeDm(id)` calls `api.dm.close(id)` then removes the channel from `dmChannels` state
- `dm_channel_closed` WS event calls `removeDmChannel(id)` which also cleans up unread/read state via `chatStore.removeChannelStates()`

---

## Adding Members to an Existing Group DM

**Endpoint:** `POST /api/dm/:id/members` -- `dm.ts:dmRoutes`

**Request:** `{ userId: string }`

**Validation:**
1. Caller must be a member of the channel
2. Channel must be a group DM (`ownerId` is not NULL)
3. Caller must be the group owner (`dmChannel.ownerId === request.userId`)
4. Target user must exist
5. Caller and target must be friends
6. Target must not already be a member
7. Current member count must be < 10

**Lazy federation setup:**
- If the channel lacks a `federatedId` and the new member (or any existing member) is remote:
  - Generate UUID `federatedId`, set `ownerHomeUserId` and `ownerHomeInstance`

**Broadcast sequence:**
1. `dm_member_added` to all existing members (before the new one sees it)
2. `dm_channel_created` to the new member (full channel payload)
3. System message (`member_added`) broadcast to all members via `sendToDmMembers`

**Federation relay:**
- Queue `member_add` with full `group` roster
- Target origins include the new member's home instance even if not previously in the group

---

## Leaving a Group DM

**Endpoint:** `DELETE /api/dm/:id/members` -- `dm.ts:dmRoutes`

**Preconditions:**
- Caller must be a member
- Channel must be a group DM (`ownerId` is not NULL; 1-on-1 DMs return 400)

**Sequence:**

1. If caller is in an active voice call in this DM, leave it first (auto-end call if room becomes empty)
2. Capture federation target origins BEFORE member deletion (so the leaving user's peer is included)
3. Insert `member_removed` system message (while user is still a member, so broadcast includes them)
4. Delete `dm_members` row
5. Delete `read_states` for the departing user
6. Queue `member_remove` federation event (reason: `'leave'`)

**Ownership transfer (if caller was owner and members remain):**
1. New owner = first remaining member (`remainingMembers[0]`)
2. Update `dm_channels.ownerId`
3. Broadcast `dm_owner_updated` to remaining members
4. Insert `owner_changed` system message
5. Update `ownerHomeUserId` / `ownerHomeInstance` on the channel
6. Queue `ownership_transfer` federation event

**Last member leaves:**
- Soft-delete: set `dm_channels.deletedAt = Date.now()`
- No ownership transfer (no remaining members)
- Storage janitor hard-deletes after 24-hour grace period

**Broadcast to leaving user:**
- `dm_channel_closed` event (removes from sidebar)

---

## DM Deletion and Garbage Collection

### Soft-Delete Trigger

A channel is soft-deleted (`deletedAt` set) when:
- The last member leaves a group DM (`dm.ts` leave endpoint)
- The last local member is removed via federation relay (`federation.ts:processMemberRemoveEvent`)

### Hard-Delete (GC)

**Function:** `storageJanitor.ts:cleanupSoftDeletedDmChannels()`

**Grace period:** 24 hours from `deletedAt`

**Cascade (single transaction):**
1. Delete `dm_reactions` for all message IDs
2. Delete `embeds` for all message IDs
3. Delete `attachments` (DB rows) for all message IDs
4. Delete `federation_file_queue` entries for all message IDs
5. Delete `dm_messages`
6. Delete `dm_members` (should be 0, defensive)
7. Delete `read_states`
8. Delete `federation_outbox` entries (by `contextId`)
9. Delete `federation_mutation_log` entries (by `contextId`)
10. Delete the `dm_channels` row

**Post-transaction:** Delete attachment files from disk (filesystem ops are idempotent)

### Re-activation

If a `member_add` federation event arrives for a soft-deleted channel (non-null `deletedAt`), `processMemberAddEvent` cancels the soft-delete by setting `deletedAt = NULL`.

---

## Message Operations

### Send Message

**Endpoint:** `POST /api/dm/:id/messages` -- `dm.ts:dmRoutes`

**Rate limit:** 5 per 5 seconds per user

**Request:** `{ content?: string, attachments?: string[], replyToId?: string }`

**Cross-instance access:** Federated users (those with `homeInstance` set) can send messages on any DM channel where they are a member, regardless of which instance serves the request. The `requireLocalUser` gate that previously blocked federated users from DM write endpoints has been removed. DM calls (`dm_call_*` WS events) remain gated — only local (non-replicated) users can initiate or receive calls.

**Validation:**
- Caller must be a member (`isDmMember`)
- Must have content or attachments (not both empty)
- Content max length: 4000 chars (`MAX_MESSAGE_LENGTH`)
- Attachment ownership verified (must be unlinked and owned by caller)

**Flow:**
1. Insert message + link attachments in a single transaction
2. Hydrate full `DmMessageWithUser` via `getDmMessageWithUser()`
3. Broadcast via `broadcastDmMessage()` (handles soft-close reopen)
4. Queue federation relay via `queueDmRelay(message, channelId, 'create')`
5. Resolve embeds asynchronously via `setImmediate()`

### Edit Message

**Endpoint:** `PATCH /api/dm/messages/:id` -- `dm.ts:dmRoutes`

1. Author-only (`msg.userId !== request.userId` returns 403)
2. Update content and set `editedAt`
3. Delete old embeds, re-resolve new embeds asynchronously
4. Broadcast `dm_message_updated` to all members
5. Queue federation relay via `queueDmRelay(updated, channelId, 'update')`

### Delete Message

**Endpoint:** `DELETE /api/dm/messages/:id` -- `dm.ts:dmRoutes`

1. Author-only
2. Collect attachment filenames before deletion
3. Delete attachments, reactions, and message atomically in a transaction
4. Clean up files from disk
5. Broadcast `dm_message_deleted` to all members
6. Federation: `appendMutationLog()` + `queueOutboxEvent()` with `eventType='delete'`

**Note:** Delete federation events are queued without `targetOrigins` -- they broadcast to ALL active peers regardless of group membership. This differs from create/update which use `getGroupDmTargetOrigins()` for group DMs.

---

## Federation Relay Pipeline

This section covers the DM-specific application-level relay logic. For the wire protocol, outbox delivery, HMAC signing, and retry mechanics, see `docs/systems/federation.md`.

### Outbound: Target Origin Resolution

**Function:** `federationOutbox.ts:getGroupDmTargetOrigins()`

```
Channel has ownerId?
├── No (1-on-1)  → return undefined → broadcasts to ALL active peers
└── Yes (group)  → query all members' homeInstances
                  → normalize bare domains to full URLs
                  → filter out our own origin
                  → return unique peer origins
```

**Function:** `federationOutbox.ts:queueDmRelay()`

Single source of truth for message relay payload construction:
1. Build attachment array with `sourceUrl` pointing to local uploads
2. Fetch `getDmParticipants()` for identity resolution on the receiving side
3. Fetch channel to check for `federatedId` (included only for group DMs with an owner)
4. Call `appendMutationLog()` + `queueOutboxEvent()` with the constructed payload

### Outbound: Relay Payload Structure

```typescript
// federationOutbox.ts:buildRelayPayload()
{
  userId: localUser.id,
  homeUserId: user.homeUserId || user.id,
  homeInstance: user.homeInstance || getOurOrigin(),
  content: message.content,
  replyToId: message.replyToId ?? null,
  editedAt: message.editedAt ?? null,
  createdAt: message.createdAt,
}
```

The full event includes `participants` (all channel members with their federated identities and profile snapshots) and optionally `federatedId` (for group DMs).

### Inbound: Message Create

**Function:** `federation.ts:processCreateEvent()`

**Deduplication:** Check `sourceInstance` + `sourceMessageId` -- reject if already exists.

**Participant resolution:**
- ALL participants resolved via `resolveOrCreateReplicatedUser()` (auto-creates stubs for unknown remote users)
- Profile data from relay event hydrated onto replicated user stubs via `hydrateReplicatedUserProfile()`

**Channel resolution (group vs 1-on-1):**

| Has `federatedId`? | Path |
|---------------------|------|
| Yes (group DM) | Lookup by `federatedId`. If not found, reject (`channel_not_found`) -- channel must exist from prior `member_add` bootstrap |
| No (1-on-1 DM) | Compute deterministic `federatedId` from the two participants' home user IDs, then `findOrCreateDmChannel()` |

**`findOrCreateDmChannel()`:**
- Lookup by `federatedId`: if found, ensure both users are members (re-add if removed)
- If not found: create new channel with `ownerId = NULL` and the computed `federatedId`, add both users as members

**Attachment handling:**
- Attachment rows created immediately with `filename = sourceUrl` (remote URL)
- Frontend renders remote URLs directly when filename starts with `http`
- Background file worker downloads the file and updates the filename to the local path
- SSRF protection: `isUrlFromPeer()` validates attachment URL hostname matches peer origin

**Broadcast filtering:**
- Skip members whose `homeInstance === sourceInstance` (they already have the message from their home instance)

### Inbound: Message Update

**Function:** `federation.ts:processUpdateEvent()`

1. Find local message by `sourceInstance` + `sourceMessageId`
2. Update content and `editedAt`
3. Broadcast `dm_message_updated` to all local members

### Inbound: Message Delete

**Function:** `federation.ts:processDeleteEvent()`

1. Find local message by `sourceInstance` + `sourceMessageId`
2. Delete attachments, reactions, and message atomically
3. Clean up attachment files from disk
4. Broadcast `dm_message_deleted` to all local members

### Inbound: Read State Update

**Function:** `federation.ts:processReadStateUpdateEvent()`

Triggered by a `read_state_update` relay event sent when a user on another instance acknowledges a DM channel.

1. Resolve channel by `federatedId` — reject if not found
2. Resolve user via `resolveLocalUser` — skip silently if not found
3. Resolve message by `messageRef` (local ID or `source_instance + source_message_id`)
4. Upsert `read_states` row for the resolved user and message
5. Broadcast `channel_ack` to the user's local WebSocket connections for multi-tab sync

Not stored in the outbox or mutation log — fire-and-forget, missed deliveries are not retried.

### Inbound: Reaction Add/Remove

**Functions:** `federation.ts:processReactionAddEvent()`, `processReactionRemoveEvent()`

- Uses `resolveLocalDmMessage()` for cross-instance message resolution (handles messages originating on this instance vs relayed messages)
- Reaction add is idempotent (existing reaction accepted silently)
- Broadcasts `reaction_added` / `reaction_removed` to local members

---

## Group DM Federation Lifecycle

### Bootstrap Path (Channel Does Not Exist Locally)

**Trigger:** `processMemberAddEvent()` receives a `member_add` event with `event.group` metadata for a `federatedId` not found locally.

**Sequence:**
1. Resolve owner via `resolveOrCreateReplicatedUser()` -- guaranteed non-null
2. Create `dm_channels` row with `ownerId`, `federatedId`, `ownerHomeUserId`, `ownerHomeInstance`
3. For each member in `event.group.members`: resolve via `resolveOrCreateReplicatedUser()`, insert `dm_members` (idempotent skip if already exists)
4. Set local `bootstrapped = true` flag
5. Build full `DmChannel` payload
6. Send `dm_channel_created` only to members whose home instance is THIS instance (local-only broadcast)

### Incremental Path (Channel Already Exists)

**Trigger:** `processMemberAddEvent()` finds the channel by `federatedId`.

**Sequence:**
1. Validate authority: `sourceInstance` must match `channel.ownerHomeInstance`
2. Cancel soft-delete if channel was pending GC (`deletedAt` set)
3. Resolve added user via `resolveOrCreateReplicatedUser()`
4. Enforce 10-member cap
5. Insert `dm_members` row (idempotent)
6. Insert system message for member addition
7. Broadcast `dm_message_created` (system) and `dm_member_added` to local members

### Bootstrap vs Incremental Batching

When a group DM is created with multiple remote members, the origin instance queues one `member_add` event per remote member. These events arrive in a batch on the receiving instance. Only the FIRST event triggers bootstrap (channel not found). Subsequent events find the channel and take the incremental path. This is correct because the bootstrap adds ALL roster members from `event.group.members`, making the incremental events idempotent.

### Member Remove (Inbound)

**Function:** `federation.ts:processMemberRemoveEvent()`

1. Find channel by `federatedId`. If not found, accept silently (idempotent).
2. Authority check: for kicks, `sourceInstance` must match `ownerHomeInstance`. For self-leave (`reason === 'leave'`), any instance is accepted.
3. Resolve user via `resolveLocalUser()` (they should already exist). If not found, accept silently.
4. Insert `member_removed` system message (before deletion so broadcast includes leaving user)
5. Delete `dm_members` row
6. Delete `read_states`
7. Broadcast `dm_member_removed` to remaining local members
8. If zero members remain: soft-delete channel

### Ownership Transfer (Inbound)

**Function:** `federation.ts:processOwnershipTransferEvent()`

1. Find channel by `federatedId`. If not found, accept silently.
2. Authority check: `sourceInstance` must match `channel.ownerHomeInstance`
3. Resolve new owner via `resolveOrCreateReplicatedUser()` -- **MUST guarantee non-null** (see invariant above)
4. Update `dm_channels`: `ownerId`, `ownerHomeUserId`, `ownerHomeInstance`
5. Broadcast `dm_owner_updated` to local members
6. Insert `owner_changed` system message

---

## System Messages

System messages (`type = 'system'` in `dm_messages`) record group lifecycle events in the chat timeline.

### Event Types

| Event | Content JSON | Actor (`userId`) |
|-------|-------------|-----------------|
| `member_added` | `{ event, targetUserId, targetDisplayName }` | User who added them |
| `member_removed` | `{ event, targetUserId, targetDisplayName, reason }` | User who left/was removed |
| `owner_changed` | `{ event, newOwnerId, newOwnerDisplayName }` | Previous owner |

### Instance-Local Creation

System messages are NOT relayed via federation. Each instance creates its own independently:

- **Origin instance:** Creates in the REST endpoint, broadcasts to local members only (group DM creation) or all local members (incremental add/leave)
- **Receiving instance:** Creates in the federation event processor, broadcasts to local members

This avoids duplicate system messages for users connected to multiple instances.

---

## Local-Only Broadcast Principle

Users connected to multiple instances must see each DM channel exactly once (from their home instance). `dm_channel_created` and system message broadcasts during group DM creation filter to local members:

```typescript
const isLocalMember = (u: { homeInstance?: string | null }) =>
  !u.homeInstance || !domainOrigin ||
  u.homeInstance === domainOrigin ||
  `https://${u.homeInstance}` === domainOrigin;
```

**Applies to:**
- `dm_channel_created` broadcasts (both origin and receiving instance bootstrap)
- System message broadcasts during group DM creation (origin instance only)

**Does NOT apply to:**
- Regular DM messages (`dm_message_created` for user messages) -- these broadcast to all local `dm_members`
- `dm_member_added` / `dm_member_removed` / `dm_owner_updated` structural events

---

## Frontend State Management

### Zustand Store (`spaceStore.ts`)

| Action | Behavior |
|--------|----------|
| `addDmChannel(channel, origin?)` | Prepends to `dmChannels`, deduplicates by ID, records origin in `channelOriginMap` |
| `removeDmChannel(id)` | Filters from `dmChannels`, cleans up unread/read state via `chatStore.removeChannelStates()` |
| `addDmMember(dmChannelId, user)` | Appends user to channel's `members` array (dedup by ID) |
| `removeDmMember(dmChannelId, userId)` | Filters user from channel's `members` array |
| `updateDmOwner(dmChannelId, newOwnerId)` | Updates `ownerId` on the channel |
| `closeDm(id)` | Calls `api.dm.close(id)` via origin-aware API client, removes from state |
| `leaveDm(id)` | Calls `api.dm.leave(id)` via origin-aware API client, removes from state |
| `findExistingDmForUser(targetUser)` | Scans `dmChannels` for a 2-member DM where the other member's `homeUserId` matches the target's `homeUserId` |

### WebSocket Event Handlers (`useWebSocket.ts`)

| WS Event | Handler |
|----------|---------|
| `dm_channel_created` | Normalize remote user assets, call `addDmChannel(channel, origin)` |
| `dm_channel_closed` | Call `removeDmChannel(dmChannelId)` |
| `dm_member_added` | Normalize remote user assets, call `addDmMember(dmChannelId, user)` |
| `dm_member_removed` | Call `removeDmMember(dmChannelId, userId)` |
| `dm_owner_updated` | Call `updateDmOwner(dmChannelId, newOwnerId)` |

### New DM Modal (`NewDmModal.tsx`)

1. User types a search query (min 2 chars, 300ms debounce)
2. Calls `api.social.search()` for user results
3. On user selection:
   - Check `findExistingDmForUser()` for deduplication -- navigate to existing DM if found
   - Otherwise call `api.dm.create({ userId })` via the origin-aware API client
   - Add channel to state and navigate

### Add DM Member Modal (`AddDmMemberModal.tsx`)

- Shows the caller's friends list, filtered by search query
- Excludes current DM members (shown as "Already in this DM")
- Enforces 10-member cap in the UI (`remainingSlots` calculation)
- Two creation paths:
  - **1-on-1 DM upgrade:** If `dmChannel.ownerId` is null, calls `api.dm.createGroup()` with the existing other member + selected friends + `fromDmChannelId`
  - **Existing group DM:** Calls `api.dm.addMember()` sequentially for each selected friend

---

## Self-Healing Migration

**Location:** `migrate.ts:runMigrations()`

**Detection:** Find `dm_channels` where:
- `owner_id IS NULL`
- `federated_id IS NOT NULL`
- `deleted_at IS NULL`
- `length(federated_id) = 36 AND federated_id LIKE '________-____-____-____-____________'` (UUID format = group DM)

**Repair:** Set `owner_id` to the first remaining `dm_members.user_id`.

**Root cause:** A bug in `processOwnershipTransferEvent` (fixed in commit cd7aff0) used `resolveLocalUser` with a `?? null` fallback. When resolution failed (even transiently), it set `ownerId = NULL`, converting the group DM into a 1-on-1-looking channel.

**Fix:** `processOwnershipTransferEvent` now uses `resolveOrCreateReplicatedUser()` which always returns a valid user, making null impossible.

---

## Origin Normalization

**Critical pitfall** (origin format mismatch):

| Location | Format | Example |
|----------|--------|---------|
| `users.home_instance` | Bare domain | `nova.ddns.net` |
| `federation_peers.origin` | Full URL | `https://nova.ddns.net` |
| `getOurOrigin()` | Full URL | `https://orbit.ddns.net` |

When comparing home instances against peer origins, always normalize:

```typescript
const normalized = homeInstance.startsWith('http')
  ? homeInstance
  : `https://${homeInstance}`;
```

`getGroupDmTargetOrigins()` performs this normalization. Failure to normalize causes `queueOutboxEvent` to find zero matching peers and silently drop events.

---

## API Reference

### REST Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/dm` | JWT | List caller's DM channels (excludes `closed=1` and `deleted_at` IS NOT NULL) |
| `POST` | `/api/dm` | JWT | Create or get existing 1-on-1 DM. Accepts `{ userId }` (local) or `{ homeUserId, homeInstance }` (federated) |
| `POST` | `/api/dm/group` | JWT | Create group DM with multiple members |
| `DELETE` | `/api/dm/:id` | JWT | Soft-close DM for caller |
| `POST` | `/api/dm/:id/members` | JWT | Add member to group DM (owner only). Accepts `{ userId }` or `{ homeUserId, homeInstance }` |
| `DELETE` | `/api/dm/:id/members` | JWT | Leave group DM |
| `GET` | `/api/dm/:id/messages` | JWT | Get messages with cursor pagination |
| `POST` | `/api/dm/:id/messages` | JWT | Send message (rate-limited: 5/5s) |
| `PATCH` | `/api/dm/messages/:id` | JWT | Edit message (author only) |
| `DELETE` | `/api/dm/messages/:id` | JWT | Delete message (author only) |

### Pagination

`GET /api/dm/:id/messages` supports cursor-based pagination:
- `before`: Message ID cursor (fetch messages before this ID)
- `limit`: 1-100, default 50
- Results returned in chronological order (oldest first)

### DM Channel List Sorting

`GET /api/dm` returns channels sorted by `lastMessage.createdAt` descending (newest activity first), falling back to `channel.createdAt` for channels with no messages.

---

## WebSocket Events

For full wire formats, see `docs/systems/websocket.md`.

### State-Change Events

| Event | Direction | Triggered By |
|-------|-----------|-------------|
| `dm_channel_created` | S->C | Group DM bootstrap, new 1-on-1, soft-close reopen |
| `dm_channel_closed` | S->C | User closes DM, user leaves group |
| `dm_member_added` | S->C | Incremental member add (not bootstrap) |
| `dm_member_removed` | S->C | Member leave/kick |
| `dm_owner_updated` | S->C | Ownership transfer |

### Content Events

| Event | Direction | Triggered By |
|-------|-----------|-------------|
| `dm_message_created` | S->C | New message (user or system) |
| `dm_message_updated` | S->C | Message edit |
| `dm_message_deleted` | S->C | Message delete |
| `dm_typing_stop` | S->C | Message send (clears indicator immediately) |

---

## Historical Bugs

| Bug | Symptom | Root Cause | Fix |
|-----|---------|-----------|-----|
| ownerId nulling | Group DM becomes 1-on-1 | `processOwnershipTransferEvent` used `resolveLocalUser ?? null` | Use `resolveOrCreateReplicatedUser` (always non-null) + self-healing migration |
| Origin normalization | Federation events silently dropped | `getGroupDmTargetOrigins` returned bare domains vs full URL peer origins | Normalize to full URL before comparison |
| Missing federatedId in outbox | All membership events rejected by peer | Outbox worker reconstruction omitted `federatedId` | Copy `parsed.federatedId` during reconstruction |
| Cross-instance duplicate channels | Duplicate sidebar entries | `dm_channel_created` broadcast to ALL members including remote | Local-only broadcast principle |
| Bootstrap vs incremental confusion | N/A (design note) | `bootstrapped` flag is function-local; batch events work correctly because bootstrap adds ALL roster members | No fix needed -- documented as correct behavior |
