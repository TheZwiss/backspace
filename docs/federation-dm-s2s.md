# Federated DM Server-to-Server (S2S) Protocol

> Internal reference for agents working on Backspace federation. Covers the complete lifecycle of federated DMs: data model, relay pipeline, event processing, and known pitfalls.

## Overview

Each Backspace instance maintains its own copy of DM channels and messages. Users interact with the copy on their **home instance** (the instance where their account was created). Federation relay synchronizes events between instances so all participants see the same conversation.

**Key principle:** A user should only see ONE copy of any DM channel — the one on their home instance. Cross-instance broadcasts must be filtered to local-only members.

## Data Model

### Tables

```
dm_channels
├── id                  TEXT PK     — Snowflake, instance-local
├── owner_id            TEXT NULL   — NULL = 1-on-1, non-NULL = group DM (creator's local user ID)
├── federated_id        TEXT NULL   — Cross-instance channel identity (set when any member is remote)
├── owner_home_user_id  TEXT NULL   — Owner's ID on their home instance
├── owner_home_instance TEXT NULL   — Owner's home instance origin
├── deleted_at          INTEGER NULL — Soft-delete timestamp (GC after last member leaves)
└── created_at          INTEGER NOT NULL

dm_members
├── dm_channel_id  TEXT NOT NULL → dm_channels.id
├── user_id        TEXT NOT NULL → users.id (local user ID on this instance)
├── closed         INTEGER DEFAULT 0 (soft-close, per-user)
└── PK(dm_channel_id, user_id)

dm_messages
├── id              TEXT PK
├── dm_channel_id   TEXT NOT NULL → dm_channels.id
├── user_id         TEXT NOT NULL → users.id (actor)
├── content         TEXT NULL
├── type            TEXT NOT NULL DEFAULT 'user' — 'user' | 'system'
├── reply_to_id     TEXT NULL
├── edited_at       INTEGER NULL
├── source_instance TEXT NULL — origin instance for relayed messages
├── source_message_id TEXT NULL — original message ID on source instance
└── created_at      INTEGER NOT NULL
```

### Channel Type Identification

| Field | 1-on-1 DM | Group DM |
|-------|-----------|----------|
| `owner_id` | `NULL` | Creator's local user ID |
| `federated_id` format | Deterministic SHA-256 hash | Random UUID |
| Mutable membership | No (immutable pair) | Yes (owner can add, anyone can leave) |
| Max members | 2 | 10 |

**Critical invariant:** `owner_id` must NEVER be set to NULL on a group DM. This would make it indistinguishable from a 1-on-1 and corrupt the channel's type identity.

### Federated ID Generation

```typescript
// 1-on-1: deterministic from the pair's home user IDs (same result on any instance)
const sorted = [homeUserIdA, homeUserIdB].sort();
const federatedId = sha256(sorted.join(':')).slice(0, 32);  // 32-char hex

// Group: random UUID assigned by the creating instance
const federatedId = crypto.randomUUID();  // 36-char UUID with dashes
```

The format difference (32-char hash vs 36-char UUID) can be used to detect channel type independently of `owner_id`.

## User Identity Resolution

Users exist on their **home instance** as native records (`home_instance = NULL`). On other instances, they appear as **replicated user stubs** with `home_instance` and `home_user_id` set.

### Resolution Functions

| Function | Behavior | Use When |
|----------|----------|----------|
| `resolveOrCreateReplicatedUser(homeUserId, homeInstance, db)` | Finds existing user or creates a stub. **Always returns a valid user.** | You MUST have a valid user ID (e.g., setting `ownerId`, inserting system messages) |
| `resolveLocalUser(homeUserId, db)` | Read-only lookup. Returns `null` if not found. | Optional lookups where null is acceptable |

**Rule:** Any code path that sets `ownerId`, creates a `dm_members` row, or inserts a message MUST use `resolveOrCreateReplicatedUser`. Using `resolveLocalUser` with a `?? null` fallback has caused data corruption.

### Origin Normalization

**Critical pitfall:** Two different formats exist in the database:

| Location | Format | Example |
|----------|--------|---------|
| `users.home_instance` | Bare domain | `nova.ddns.net` |
| `federation_peers.origin` | Full URL | `https://nova.ddns.net` |
| `getOurOrigin()` return value | Full URL | `https://orbit.ddns.net` |

When comparing `homeInstance` against peer origins or `getOurOrigin()`, always normalize:

```typescript
const normalized = homeInstance.startsWith('http') ? homeInstance : `https://${homeInstance}`;
```

Failure to normalize causes silent failures where `queueOutboxEvent` finds zero matching peers and drops events without error.

## Relay Pipeline

### Outbound Flow (Origin Instance)

```
1. API endpoint creates/modifies DM data
2. appendMutationLog() — permanent audit record in federation_mutation_log
3. queueOutboxEvent(messageId, contextId, eventType, payload, targetOrigins)
   ├── Fetches active peers from federation_peers
   ├── Filters to targetOrigins (normalized homeInstance → peer.origin match)
   ├── Inserts one federation_outbox row per target peer
   └── If targetOrigins produces zero peers → event is silently dropped
4. Outbox worker (10-second interval) batches pending events per peer
5. POST /api/federation/relay to each peer with signed payload
6. Peer responds with accepted/rejected arrays
7. Accepted events deleted from outbox; rejected events logged
```

### Target Origin Resolution

For group DMs, `getGroupDmTargetOrigins(channelId)` determines which peers receive events:

```typescript
function getGroupDmTargetOrigins(channelId: string): string[] {
  // Query all members' homeInstances
  // Normalize to full URL format
  // Filter out our own origin
  // Return unique peer origins that have members in this group
}
```

For 1-on-1 DMs, `targetOrigins` is `undefined` → broadcasts to ALL active peers.

### Inbound Flow (Receiving Instance)

```
1. POST /api/federation/relay arrives with signed events array
2. Verify request signature against peer's public key
3. For each event, dispatch to type-specific processor:
   ├── create/update/delete → processCreateEvent / processUpdateEvent / processDeleteEvent
   ├── member_add          → processMemberAddEvent
   ├── member_remove       → processMemberRemoveEvent
   ├── ownership_transfer  → processOwnershipTransferEvent
   ├── reaction_add/remove → processReactionEvent
   └── friend_add/remove   → processFriendEvent
4. Return accepted/rejected arrays
```

## Event Processing — Group DM Lifecycle

### member_add (processMemberAddEvent)

**Two paths:**

**Bootstrap path** (channel doesn't exist locally):
1. Channel not found by `federatedId` → create from `event.group` metadata
2. Resolve owner via `resolveOrCreateReplicatedUser`
3. Create `dm_channels` row with `ownerId`, `federatedId`, owner federation fields
4. Add ALL roster members from `event.group.members` (resolve each via `resolveOrCreateReplicatedUser`)
5. Send `dm_channel_created` to **local-only members** (home instance matches this server)
6. Set `bootstrapped = true` to skip redundant broadcasts below
7. Insert system message for member addition (local-only, inside `!bootstrapped` guard)

**Incremental path** (channel already exists):
1. Channel found by `federatedId`
2. Validate authority: only owner's instance can add members
3. Resolve added user via `resolveOrCreateReplicatedUser`
4. Insert `dm_members` row (idempotent — skip if already exists)
5. Insert system message for the addition
6. Send `dm_member_added` to local WebSocket clients

### member_remove (processMemberRemoveEvent)

1. Find channel by `federatedId`
2. Validate authority: owner's instance for kicks, any instance for self-leave
3. Resolve user via `resolveLocalUser` (they should already exist)
4. Insert system message (before deletion, so broadcast includes the leaving user)
5. Delete `dm_members` row
6. Clean up `read_states`
7. Send `dm_member_removed` to remaining local members
8. If zero members remain → soft-delete channel (`deleted_at = now`)

### ownership_transfer (processOwnershipTransferEvent)

1. Find channel by `federatedId`
2. Validate authority: only current owner's instance can transfer
3. Resolve new owner via `resolveOrCreateReplicatedUser` (**never** `resolveLocalUser` — must guarantee valid ID)
4. Update `dm_channels`: `ownerId`, `ownerHomeUserId`, `ownerHomeInstance`
5. Send `dm_owner_updated` WebSocket event to local members
6. Insert system message for the transfer

## Event Processing — DM Messages

### create (DM message relay)

**Group DMs** (`event.federatedId` present):
1. Find channel by `federatedId`
2. If not found → skip (channel should be bootstrapped by `member_add` first)
3. Insert message with `sourceInstance` and `sourceMessageId` for dedup
4. Broadcast `dm_message_created` to local members

**1-on-1 DMs** (no `federatedId`):
1. Compute deterministic `federatedId` from sender + recipient home IDs
2. `findOrCreateDmChannel()` — find by `federatedId` or create with `ownerId = NULL`
3. Insert message, broadcast to local members

## Local-Only Broadcast Principle

Users connected to multiple instances must see each DM channel exactly once (from their home instance). All `dm_channel_created` broadcasts and system message broadcasts filter to **local members only**:

```typescript
const isLocalMember = (u: { homeInstance?: string | null }) =>
  !u.homeInstance || !domainOrigin ||
  u.homeInstance === domainOrigin ||
  `https://${u.homeInstance}` === domainOrigin;
```

- Origin instance: broadcasts only to local members after creating the group DM
- Receiving instance (bootstrap): broadcasts only to members whose home instance matches
- Remote members receive notification through federation relay → bootstrap on their home instance

**Does NOT apply to:** Regular DM messages (`dm_message_created` for user messages). These broadcast to all local `dm_members` regardless of home instance, because the message relay ensures eventual delivery to all instances. Faster delivery to users connected to the origin is acceptable since the message ID deduplicates on the receiving instance.

## System Messages

System messages (`type = 'system'` in `dm_messages`) record group lifecycle events in the chat timeline.

### Events

| Event | Content JSON | Actor (`userId`) |
|-------|-------------|-----------------|
| `member_added` | `{event, targetUserId, targetDisplayName}` | User who added them |
| `member_removed` | `{event, targetUserId, targetDisplayName, reason}` | User who left/was removed |
| `owner_changed` | `{event, newOwnerId, newOwnerDisplayName}` | Previous owner |

### Creation Pattern

System messages are **instance-local** — they are NOT relayed via federation. Each instance creates its own system messages independently when processing federation events:

- **Origin instance**: Creates system messages in the REST endpoint (e.g., `POST /api/dm/group`), broadcasts to local members only
- **Receiving instance**: Creates system messages in the federation event processor (e.g., `processMemberAddEvent`), broadcasts to local members

This avoids duplicate system messages for users connected to multiple instances.

### Rendering

Frontend detects `message.type === 'system'`, parses JSON content, renders as compact centered text with icons (→ added, ← left, ♛ owner change). No avatar, no context menu, no reactions.

## WebSocket Events

### State-change events (structural)
| Event | Purpose | When |
|-------|---------|------|
| `dm_channel_created` | New DM appears in sidebar | Group DM bootstrap, or new 1-on-1 |
| `dm_member_added` | Member added to existing group | Incremental member_add (not bootstrap) |
| `dm_member_removed` | Member left/removed from group | member_remove processing |
| `dm_owner_updated` | Group ownership changed | ownership_transfer processing |
| `dm_channel_closed` | DM removed from sidebar for leaving user | User leaves group |

### Content events
| Event | Purpose |
|-------|---------|
| `dm_message_created` | New message (user or system) |
| `dm_message_updated` | Message edited |
| `dm_message_deleted` | Message deleted |

## Known Pitfalls & Historical Bugs

### 1. ownerId nulling (FIXED)
`processOwnershipTransferEvent` used `resolveLocalUser` with `?? null` fallback. When resolution failed (even transiently), it set `ownerId = NULL`, converting the group DM into a 1-on-1. Fix: use `resolveOrCreateReplicatedUser` which always returns a valid user.

**Self-healing migration** in `migrate.ts` detects group DMs with UUID-format `federated_id` but `NULL owner_id` and restores the owner from the first remaining member.

### 2. Origin normalization (FIXED)
`getGroupDmTargetOrigins()` returned bare domains from `users.home_instance`, but `queueOutboxEvent()` compared them against `federation_peers.origin` (full URLs). No peers matched → events silently dropped. Fix: normalize to full URL before comparison.

### 3. Missing federatedId in outbox reconstruction (FIXED)
The outbox worker (`federationWorker.ts`) reconstructed relay events from stored payloads but never copied `federatedId`. Receiving instances check this field and rejected all `member_add/remove/ownership_transfer` events. Fix: copy `parsed.federatedId` during reconstruction.

### 4. Cross-instance duplicate channels (FIXED)
`dm_channel_created` was broadcast to ALL members including remote replicas. Users connected to multiple instances received the event twice (different channel IDs), creating duplicate sidebar entries. Fix: local-only broadcast principle.

### 5. Bootstrap vs incremental confusion
The `bootstrapped` flag in `processMemberAddEvent` is a local variable — each function invocation starts fresh. When multiple `member_add` events arrive in a batch (common for group creation), only the FIRST triggers bootstrap. Subsequent events see the channel exists and take the incremental path. This is correct — the bootstrap adds ALL roster members, so the incremental events are idempotent.

## File Map

| File | Responsibility |
|------|---------------|
| `packages/server/src/routes/dm.ts` | DM REST endpoints, system message creation, federation event queueing |
| `packages/server/src/routes/federation.ts` | Inbound event processing: `processMemberAddEvent`, `processMemberRemoveEvent`, `processOwnershipTransferEvent`, `resolveOrCreateReplicatedUser`, `resolveLocalUser` |
| `packages/server/src/utils/federationOutbox.ts` | `queueOutboxEvent`, `appendMutationLog`, `getDmParticipants`, `getGroupDmTargetOrigins`, `computeFederatedId` |
| `packages/server/src/utils/federationWorker.ts` | Outbox flush worker (10s interval), event reconstruction, delivery to peers |
| `packages/server/src/utils/federationAuth.ts` | `getOurOrigin()`, request signing, peer verification |
| `packages/server/src/ws/handler.ts` | `connectionManager.sendToUser()`, `sendToDmMembers()` — WebSocket broadcast |
| `packages/server/src/db/schema.ts` | Drizzle table definitions including `dm_channels`, `dm_members`, `dm_messages` |
| `packages/server/src/db/migrate.ts` | Schema migrations + self-healing data integrity checks |
| `packages/web/src/hooks/useWebSocket.ts` | Frontend WebSocket event handlers for all DM events |
| `packages/web/src/stores/spaceStore.ts` | Zustand store: `addDmChannel`, `addDmMember`, `removeDmMember`, `updateDmOwner` |
