# Database Schema Reference

Source of truth: `packages/server/src/db/schema.ts` (Drizzle ORM)
Migrations: drizzle-kit generates SQL from `schema.ts` (`pnpm db:generate` from `packages/server/`). On startup, `initDatabase()` runs `drizzle.migrate()` against `packages/server/drizzle/`, then `ensureDefaults()` (settings row, Snowflake worker ID, first-admin promotion). Migration history was squashed to a single baseline on 2026-04-24 (backlog #31 Phase 2).
Engine: SQLite via `better-sqlite3`
IDs: Snowflake text, permissions: bigint decimal strings

---

## Core Tables

### users
| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | text PK | | Snowflake |
| username | text UNIQUE NOT NULL | | Login name |
| displayName | text | | |
| passwordHash | text NOT NULL | | bcrypt; `'!federation-replicated'` for stubs |
| avatar | text | | Upload filename |
| status | text | `'offline'` | online/idle/dnd/offline |
| customStatus | text | | |
| isAdmin | integer | 0 | First registered user = 1 |
| homeInstance | text | | Federation origin URL (null = local) |
| homeUserId | text | | Canonical ID on home instance |
| replicatedInstances | text | `'[]'` | JSON array of instance URLs |
| banner | text | | Upload filename |
| accentColor | text | | Hex color |
| avatarColor | text | | Hex color |
| bio | text | | |
| isDeleted | integer | 0 | Soft-delete flag |
| discoverable | integer | 1 | Visible in user directory |
| profileUpdatedAt | integer | | Epoch ms |
| passwordChangedAt | integer | | Token revocation: tokens before this rejected |
| showActivity | integer NOT NULL | 1 | Rich presence visibility |
| federationRegistryUpdatedAt | integer | 0 | LWW timestamp for federation registry sync |
| createdAt | integer NOT NULL | | Epoch ms |

### spaces
| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | text PK | | |
| name | text NOT NULL | | |
| icon | text | | Upload filename |
| banner | text | | Upload filename |
| avatarColor | text | | Hex color |
| ownerId | text NOT NULL | | FK → users.id |
| inviteCode | text UNIQUE | | |
| visibility | text | `'private'` | public/request/private |
| description | text | | |
| createdAt | integer NOT NULL | | |

### space_members
PK: (spaceId, userId)
| Column | Type | Notes |
|--------|------|-------|
| spaceId | text NOT NULL | FK → spaces.id CASCADE |
| userId | text NOT NULL | FK → users.id CASCADE |
| nickname | text | Per-space display name |
| joinedAt | integer NOT NULL | |

### channel_categories
| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | text PK | | |
| spaceId | text NOT NULL | | FK → spaces.id CASCADE |
| name | text NOT NULL | | |
| position | integer | 0 | |
| createdAt | integer NOT NULL | | |

### channels
| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | text PK | | |
| spaceId | text NOT NULL | | FK → spaces.id CASCADE |
| name | text NOT NULL | | |
| type | text NOT NULL | | text/voice |
| topic | text | | |
| position | integer | 0 | |
| categoryId | text | | Soft FK → channel_categories |
| createdAt | integer NOT NULL | | |

### messages
| Column | Type | Notes |
|--------|------|-------|
| id | text PK | |
| channelId | text NOT NULL | FK → channels.id CASCADE |
| userId | text NOT NULL | FK → users.id |
| replyToId | text | FK → messages.id SET NULL |
| content | text | |
| editedAt | integer | |
| createdAt | integer NOT NULL | |

### attachments
| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | text PK | | |
| messageId | text | | FK → messages.id CASCADE |
| dmMessageId | text | | FK → dm_messages.id CASCADE |
| uploaderId | text | | User who uploaded |
| filename | text NOT NULL | | Stored filename |
| originalName | text NOT NULL | | User-facing name |
| mimetype | text NOT NULL | | |
| size | integer NOT NULL | | Bytes |
| thumbnailFilename | text | | Generated thumbnail |
| width | integer | | Image/video pixel width |
| height | integer | | Image/video pixel height |
| duration | real | | Audio/video seconds |
| sourceUrl | text | | Remote URL (federation) |
| federationStatus | text | | local/remote/remote_partial |
| federationMeta | text | | JSON rejection info |
| createdAt | integer NOT NULL | | |
CHECK: exactly one of messageId/dmMessageId is set

### embeds
| Column | Type | Notes |
|--------|------|-------|
| id | text PK | |
| messageId | text | FK → messages.id CASCADE |
| dmMessageId | text | FK → dm_messages.id CASCADE |
| url | text NOT NULL | |
| embedType | text NOT NULL | generic/video/image/audio/rich |
| provider | text | youtube/vimeo/spotify/null |
| title | text | |
| description | text | |
| image | text | Thumbnail/og:image URL |
| embedUrl | text | iframe-safe URL |
| width | integer | |
| height | integer | |
| color | text | |
| createdAt | integer NOT NULL | |
CHECK: exactly one of messageId/dmMessageId is set

### reactions
PK: id
| Column | Type | Notes |
|--------|------|-------|
| id | text PK | |
| messageId | text NOT NULL | FK → messages.id CASCADE |
| userId | text NOT NULL | FK → users.id CASCADE |
| emoji | text NOT NULL | |
| createdAt | integer NOT NULL | |

---

## DM Tables

### dm_channels
| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | text PK | | |
| ownerId | text | | NULL for 1-on-1, set for group |
| federatedId | text | | Cross-instance identifier |
| ownerHomeUserId | text | | Owner's canonical home ID |
| ownerHomeInstance | text | | Owner's home instance URL |
| deletedAt | integer | | Soft-delete (GC after 24h if no local members) |
| createdAt | integer NOT NULL | | |
| name | text | | Group DM custom name. NULL = use comma-joined member fallback. Owner-only writes. |
| icon | text | | Group DM custom icon. NULL = use AvatarStack fallback. Owner instance stores bare filename; receivers store bare filename on download success or absolute URL on fallback. |
| metadataUpdatedAt | integer NOT NULL | 0 | Server-side version vector for `group_metadata_update` federation dedup. Captured at the moment of the owner-instance DB write; default 0 means "any rename wins". |

### dm_members
PK: (dmChannelId, userId)
| Column | Type | Default | Notes |
|--------|------|---------|-------|
| dmChannelId | text NOT NULL | | FK → dm_channels.id CASCADE |
| userId | text NOT NULL | | FK → users.id CASCADE |
| closed | integer | 0 | Soft-close flag |

### dm_messages
| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | text PK | | |
| dmChannelId | text NOT NULL | | FK → dm_channels.id CASCADE |
| userId | text NOT NULL | | FK → users.id |
| replyToId | text | | FK → dm_messages.id SET NULL |
| content | text | | |
| type | text NOT NULL | `'user'` | user/system |
| editedAt | integer | | |
| sourceInstance | text | | Federation source origin |
| sourceMessageId | text | | Original ID on source instance |
| encryptionVersion | integer | 0 | |
| createdAt | integer NOT NULL | | |

### dm_reactions
PK: id
| Column | Type | Notes |
|--------|------|-------|
| id | text PK | |
| dmMessageId | text NOT NULL | FK → dm_messages.id CASCADE |
| userId | text NOT NULL | FK → users.id CASCADE |
| emoji | text NOT NULL | |
| createdAt | integer NOT NULL | |

---

## Social Tables

### friends
PK: (userId, friendId)
| Column | Type | Notes |
|--------|------|-------|
| userId | text NOT NULL | FK → users.id CASCADE |
| friendId | text NOT NULL | FK → users.id CASCADE |
| createdAt | integer NOT NULL | |

### friend_requests
| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | text PK | | |
| fromId | text NOT NULL | | FK → users.id CASCADE |
| toId | text NOT NULL | | FK → users.id CASCADE |
| status | text | `'pending'` | pending/accepted/declined |
| createdAt | integer NOT NULL | | |

---

## RBAC Tables

### roles
| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | text PK | | |
| spaceId | text NOT NULL | | FK → spaces.id CASCADE |
| name | text NOT NULL | | |
| color | text | `'#b9bbbe'` | Hex |
| position | integer | 0 | Hierarchy position |
| permissions | text | | Bigint decimal string |
| createdAt | integer NOT NULL | | |

### member_roles
PK: (spaceId, userId, roleId)
All columns FK CASCADE to their respective tables.

### channel_overrides
PK: (channelId, targetType, targetId)
| Column | Type | Default | Notes |
|--------|------|---------|-------|
| channelId | text NOT NULL | | FK → channels.id CASCADE |
| targetType | text NOT NULL | | role/member |
| targetId | text NOT NULL | | Role ID or user ID |
| allow | text NOT NULL | `'0'` | Bigint decimal string |
| deny | text NOT NULL | `'0'` | Bigint decimal string |

### category_overrides
PK: (categoryId, targetType, targetId)
Same structure as channel_overrides, with categoryId FK → channel_categories.id CASCADE.

---

## State Tables

### read_states
PK: (userId, channelId)
| Column | Type | Notes |
|--------|------|-------|
| userId | text NOT NULL | FK → users.id CASCADE |
| channelId | text NOT NULL | Channel or DM channel ID |
| lastReadMessageId | text NOT NULL | |
| updatedAt | integer NOT NULL | |

### space_folders
| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | text PK | | |
| userId | text NOT NULL | | FK → users.id CASCADE |
| name | text | | |
| color | text | | |
| position | integer | 0 | |
| createdAt | integer NOT NULL | | |

### space_folder_members
PK: (folderId, spaceId)
| Column | Type | Default | Notes |
|--------|------|---------|-------|
| folderId | text NOT NULL | | FK → space_folders.id CASCADE |
| spaceId | text NOT NULL | | May be federated (no local FK) |
| position | integer | 0 | |

### user_space_layout
PK: userId
| Column | Type | Default | Notes |
|--------|------|---------|-------|
| userId | text PK | | FK → users.id CASCADE |
| layout | text NOT NULL | `'[]'` | JSON array of {t:'s',id} | {t:'f',id} |
| updatedAt | integer NOT NULL | | |

---

## Moderation Tables

### bans
PK: (spaceId, userId)
| Column | Type | Notes |
|--------|------|-------|
| spaceId | text NOT NULL | FK → spaces.id CASCADE |
| userId | text NOT NULL | FK → users.id CASCADE |
| reason | text | |
| bannedBy | text | FK → users.id |
| createdAt | integer NOT NULL | |

### join_requests
| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | text PK | | |
| spaceId | text NOT NULL | | FK → spaces.id CASCADE |
| userId | text NOT NULL | | FK → users.id CASCADE |
| message | text | | |
| status | text NOT NULL | `'pending'` | pending/accepted/declined |
| decidedBy | text | | FK → users.id |
| createdAt | integer NOT NULL | | |
| decidedAt | integer | | |

### voice_restrictions
PK: (spaceId, userId, restrictionType)
| Column | Type | Notes |
|--------|------|-------|
| spaceId | text NOT NULL | FK → spaces.id CASCADE |
| userId | text NOT NULL | FK → users.id CASCADE |
| restrictionType | text NOT NULL | mute/deafen |
| moderatorId | text | FK → users.id |
| createdAt | integer NOT NULL | |

---

## Registration Invites

### invite_links
Admin-managed registration invite tokens. Status (`active` / `expired` / `exhausted` / `revoked`) is **derived** at read time from `revokedAt` + `expiresAt` + `usedCount`/`maxUses`; there is no stored status column. See `packages/server/src/utils/inviteService.ts` (`inviteStatus()`).

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | text PK | | Snowflake |
| token | text UNIQUE NOT NULL | | 22-char base64url (`crypto.randomBytes(16).toString('base64url')`). Rotated on revoked → reinstate. UNIQUE constraint provides the lookup index. |
| name | text NOT NULL | | Admin-facing label, 1-64 chars trimmed. |
| createdBy | text NOT NULL | | FK → users.id (no CASCADE — admin tombstone keeps the row resolvable). |
| createdAt | integer NOT NULL | | Epoch ms |
| maxUses | integer | | NULL = unlimited; positive integer otherwise. |
| usedCount | integer NOT NULL | 0 | Incremented atomically inside the redemption transaction. |
| expiresAt | integer | | Epoch ms; NULL = never expires. |
| revokedAt | integer | | Epoch ms; NULL = not revoked. Set by revoke endpoint, cleared by reinstate. |

**Index:** `idx_invite_links_created_at` on `(createdAt)`.

### invite_redemptions
One row per successful invite-token consumption. Surrogate ID supports future per-redemption metadata without schema churn.

| Column | Type | Notes |
|--------|------|-------|
| id | text PK | Snowflake |
| inviteId | text NOT NULL | FK → invite_links.id ON DELETE CASCADE — hard-deleting an invite drops its redemption history with it. |
| userId | text | FK → users.id ON DELETE SET NULL — defensive against future hard-delete paths; tombstone (soft-delete) keeps the row populated. |
| registrantUsername | text NOT NULL | Snapshot of username at the registration moment. Preserves forensic value when the user is later renamed or tombstoned (`!deleted:{uid}`). |
| redeemedAt | integer NOT NULL | Epoch ms |

**Indexes:** `idx_invite_redemptions_invite_id` on `(inviteId)`, `idx_invite_redemptions_user_id` on `(userId)`.

The user INSERT, `usedCount` increment, and redemption row INSERT all run in a single SQLite transaction (`inviteService.redeemInvite()`), which re-derives status under the transaction to close the TOCTOU window between `/check-invite` and `/register`.

---

## Instance Settings (singleton, id=1)

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | integer PK | 1 | |
| instanceName | text | `'Backspace'` | |
| workerId | integer | | Snowflake worker ID |
| discoveryEnabled | integer NOT NULL | 1 | |
| maxBitrateKbps | integer NOT NULL | 20000 | |
| minBitrateKbps | integer NOT NULL | 500 | |
| bitrateStepKbps | integer NOT NULL | 500 | |
| allowedResolutions | text NOT NULL | `'540,720,1080'` | CSV |
| allowedFramerates | text NOT NULL | `'30,45,60'` | CSV |
| maxResolution | integer NOT NULL | 1080 | |
| maxFramerate | integer NOT NULL | 60 | |
| registrationOpen | integer | | Local-anonymous-signup gate. null = use env (`config.registrationOpen`); 0/1 = explicit admin override. |
| federatedRegistrationOpen | integer NOT NULL | 1 | Independent gate for federated identity replication via Connections (`POST /api/auth/register` with `homeInstance` set). Existing federated accounts always log in regardless of this value. |
| gifApiKey | text | | Klipy API key |
| bitrateMatrixOverrides | text | | JSON sparse overrides |
| allowCustomBitrate | integer NOT NULL | 1 | |
| maxUploadSizeBytes | integer | | null = use env |
| federationRelayEnabled | integer NOT NULL | 1 | |
| federationRelayTtlDays | integer NOT NULL | 30 | |
| autoAcceptPeering | integer NOT NULL | 1 | When 0, `peer/accept` rejects unsolicited requests with 403 |
| updatedAt | integer NOT NULL | | |

---

## Federation Tables

### federation_peers
| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | text PK | | |
| origin | text NOT NULL UNIQUE | | `https://domain.tld` |
| instanceName | text | | |
| hmacSecret | text NOT NULL | | 256-bit hex |
| status | text NOT NULL | `'active'` | active/pending/awaiting_approval/unreachable/revoked/rejected/needs_attention |
| lastSeenAt | integer | | |
| lastFailureAt | integer | | |
| consecutiveFailures | integer NOT NULL | 0 | >=10 → unreachable (network/5xx failures). Counter — never null. |
| consecutiveAuthFailures | integer NOT NULL | 0 | >=5 → needs_attention. Tracked separately from `consecutiveFailures` (network) because auth (401/403) and network failures have different resolution paths. |
| lastSyncedAt | integer | 0 | |
| remoteMaxUploadSize | integer | | Bytes, from peer |
| createdAt | integer NOT NULL | | |
| approvalToken | text | | Single-use 64-hex-char token stored when this row is in `awaiting_approval` (received from remote's 202 response). Verified against the inbound `/peer/accept` `approvalToken` field before promoting to `active`. Cleared (`NULL`) on promotion. See [federation.md → Approval Token Verification](federation.md#approval-token-verification). |

### peer_approval_requests
Queue of peering requests pending admin review when `autoAcceptPeering` is `false`. Holds **both directions**: inbound rows (remote asked to peer with us) and outbound rows (a local user-initiated `ensurePeered` call gated on this side; see [federation.md → Outbound Peering Gate](federation.md#outbound-peering-gate)). UNIQUE on `(origin, direction)` so the same origin may have at most one row per direction simultaneously. Rows expire after 30 days via janitor cleanup.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | text PK | | Snowflake |
| origin | text NOT NULL | | Requesting / target instance's origin URL. UNIQUE per `direction` (composite UNIQUE `(origin, direction)`). |
| direction | text NOT NULL | `'inbound'` | `'inbound'` (remote → us) or `'outbound'` (us → remote, gate-created on user_action). Migration backfills existing rows to `'inbound'`. |
| instanceName | text | | Instance name (sent by requester for inbound; null for outbound until populated by future enrichment). |
| hmacSecret | text | | Requester's HMAC secret for inbound (used to sign the `/peer/denied` notification). **Nullable** — outbound rows have `hmac_secret = NULL` and the `/approve` handler generates fresh HMAC at the moment it sends `/peer/accept`. CHECK enforced (see below). |
| requestedAt | integer NOT NULL | | Epoch ms |
| expiresAt | integer NOT NULL | | Epoch ms; requestedAt + 30 days |
| approvalToken | text | | Single-use 64-hex-char token issued by the receiver in the 202 response when an inbound row is created. Forwarded by `/approve` in its outbound `/peer/accept` so the remote initiator can verify mutual admin approval. Deleted along with this row when `/approve` runs. Inbound-only meaning preserved (outbound rows always have `approval_token = NULL`). See [federation.md → Approval Token Verification](federation.md#approval-token-verification). |

**CHECK constraint** (direction-specific shape):

```sql
CHECK (
  (direction = 'inbound' AND hmac_secret IS NOT NULL)
  OR (direction = 'outbound')
)
```

> **drizzle-kit limitation:** drizzle-kit does NOT represent SQLite CHECK constraints in its snapshot/diff. The constraint is created by the original baseline migration (or, for the post-baseline ALTER, hand-written SQL) and is preserved in `schema.ts` as a comment so a future table recreate (drizzle generates a recreate when UNIQUE/PK changes again) re-adds the CHECK by hand. If you regenerate a migration that recreates this table, audit the generated SQL and re-add the CHECK clause manually before applying.

### peer_approval_subscribers
Per-user "I want this peering relationship" subscriber rows attached to outbound `peer_approval_requests`. Logically outbound-only (inbound rows have no subscribers). Existence = waiting; deletion = resolved (resolution recorded in `peer_approval_notifications` at deletion time, except for the canceller path). One subscriber may have multiple rows on the same parent if they triggered the gate from different actions/targets.

| Column | Type | Notes |
|--------|------|-------|
| id | text PK | Snowflake |
| requestId | text NOT NULL | FK → peer_approval_requests.id CASCADE — parent deletion (admin approve→active fanout, admin deny, last-subscriber cancel, expiry) automatically clears subscriber rows. |
| userId | text NOT NULL | FK → users.id CASCADE |
| triggerReason | text NOT NULL | `'friend_add'` \| `'space_join'` \| `'direct_message'` (`PeeringTriggerReason` enum in `packages/shared/src/types.ts`). |
| triggerTarget | text NOT NULL | Action target — for `friend_add` this is `username@instance`; for `space_join` an invite code or space ID; for `direct_message` a recipient handle. Never stores message bodies, attachments, or user content. |
| createdAt | integer NOT NULL | Epoch ms |

**UNIQUE:** `(request_id, user_id, trigger_reason, trigger_target)` — same user retriggering the gate with the same reason+target updates rather than duplicates.
**Index:** `idx_peer_approval_subscribers_user_id` on `(user_id)` — supports the user-facing pending list query.

### peer_approval_notifications
Terminal-state notifications for peering events (approved / denied / expired). Scoped to peering — NOT a generalized in-app notification system. When a generalized system is built later, this table either migrates into it or stays as a peering-specific artifact (decision deferred to that spec).

| Column | Type | Notes |
|--------|------|-------|
| id | text PK | Snowflake |
| userId | text NOT NULL | FK → users.id CASCADE |
| kind | text NOT NULL | `'approved'` \| `'denied'` \| `'expired'`. |
| peerOrigin | text NOT NULL | Origin URL the notification refers to. |
| triggerReason | text NOT NULL | Mirrors the originating subscriber row's `trigger_reason`. |
| triggerTarget | text NOT NULL | Mirrors the originating subscriber row's `trigger_target`. |
| createdAt | integer NOT NULL | Epoch ms |
| readAt | integer | Nullable. NULL = unread; epoch ms once dismissed/marked read. |

**Index:** `idx_peer_approval_notifications_user_id` on `(user_id)` — supports the user-facing list and unread-filter queries.

Inserted by `onPeerActivated` (`'approved'`), the outbound `/deny` handler (`'denied'`), and the storage janitor outbound expiry pass (`'expired'`). Read rows older than 30 days are auto-cleaned by the janitor; unread rows are never auto-cleaned.

### federation_outbox
UNIQUE: (peerId, entityId)
| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | text PK | | |
| peerId | text NOT NULL | | FK → federation_peers.id CASCADE |
| contextId | text NOT NULL | | DM channel / friend context |
| entityId | text NOT NULL | | Message / reaction / request ID |
| contextType | text NOT NULL | `'dm'` | dm/friend |
| eventType | text NOT NULL | | create/update/delete/reaction_add/etc |
| payload | text NOT NULL | | JSON event data |
| encryptionVersion | integer | 0 | |
| attempts | integer | 0 | |
| nextRetryAt | integer NOT NULL | | |
| expiresAt | integer NOT NULL | | TTL-based |
| createdAt | integer NOT NULL | | |

### federation_file_queue
| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | text PK | | |
| peerOrigin | text NOT NULL | | |
| dmMessageId | text NOT NULL | | |
| sourceUrl | text NOT NULL | | Remote download URL |
| targetFilename | text | | Local stored filename |
| originalName | text NOT NULL | | |
| mimetype | text NOT NULL | | |
| size | integer NOT NULL | | |
| status | text NOT NULL | `'pending'` | pending/completed/rejected/failed |
| rejectionReason | text | | |
| attempts | integer | 0 | Max 10 |
| nextRetryAt | integer NOT NULL | | |
| expiresAt | integer NOT NULL | | |
| createdAt | integer NOT NULL | | |

### federation_mutation_log
| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | text PK | | |
| entityId | text NOT NULL | | |
| contextId | text NOT NULL | | |
| contextType | text NOT NULL | `'dm'` | dm/friend |
| mutationType | text NOT NULL | | create/update/delete |
| mutatedAt | integer NOT NULL | | Checkpoint for sync |
| payload | text | | JSON |
Retention: 90 days (cleaned by federation janitor)

### user_federation_registry
Persistent registry of all instances a user has federated with. Tracks full lifecycle.

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| user_id | TEXT | NOT NULL, FK→users(id) CASCADE | Owner |
| origin | TEXT | NOT NULL | Instance origin URL (e.g., `https://domain.com`) |
| label | TEXT | NOT NULL DEFAULT '' | Instance display name |
| username | TEXT | NOT NULL DEFAULT '' | Federated username on remote |
| remote_user_id | TEXT | NOT NULL DEFAULT '' | Snowflake ID on remote |
| status | TEXT | NOT NULL DEFAULT 'connected' | connected/disconnected/unreachable/auth_expired |
| added_at | INTEGER | NOT NULL | Epoch ms — when first federated |
| last_connected_at | INTEGER | | Epoch ms — last successful connection |
| disconnected_at | INTEGER | | Epoch ms — when user disconnected |
| error_message | TEXT | | Last error message |

**PK:** `(user_id, origin)`
