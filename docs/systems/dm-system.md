# DM System

Source files:
- `packages/server/src/routes/dm.ts` -- REST endpoints for DM CRUD, group lifecycle, message send/edit/delete, federation event queueing, `broadcastDmMessage()` with soft-close reopen logic
- `packages/server/src/routes/federation.ts` -- Inbound relay event processors: `processMemberAddEvent`, `processMemberRemoveEvent`, `processOwnershipTransferEvent`, `processCreateEvent`, `processUpdateEvent`, `processDeleteEvent`, reaction processors, identity resolution (`resolveLocalUser`, `resolveOrCreateReplicatedUser`)
- `packages/server/src/utils/federationOutbox.ts` -- `queueOutboxEvent`, `appendMutationLog`, `queueDmRelay`, `getDmParticipants`, `getGroupDmTargetOrigins`, `buildRelayPayload`
- `packages/server/src/utils/dmConversation.ts` -- conversation identity (ADR 0002): `homeIdentityOf`, `oneOnOneKey`, `mintGroupKey` (the only code that computes or mints a key), `findOrCreateOneOnOne` (the only code that looks up or inserts a 1-on-1 row), `reconcileDmChannelFederatedId`, `backfillOneOnOneKeys` (startup, from `initDatabase`)
- `packages/server/src/utils/dmChannelWire.ts` -- `toDmChannelWire()` (the one `DmChannel` serializer), `toDmLastMessagePreview()`, `loadOpenDmChannels()` (the DM list shared by the ready payload and `GET /api/dm`), `loadDmChannelWire()` (one conversation, for every other emitter)
- `packages/server/src/utils/storageJanitor.ts` -- `cleanupSoftDeletedDmChannels()` (24h grace period hard-delete)
- `packages/server/src/utils/userDeletion.ts` -- `tombstoneUser()`: DM membership partition (1-on-1 kept / group dropped) + dead-DM purge on "zero live members" (see "DM Tombstone Semantics")
- `packages/server/src/utils/permissions.ts` -- `isDeadOneOnOne()` read-only guard for Deleted-User 1-on-1 threads
- `packages/server/src/utils/dmMessageRules.ts` -- `checkDmMessageCreate` / `checkDmMessageEdit` / `checkDmMessageDelete`: the message write checks shared by the REST routes and the WebSocket events
- `packages/server/src/db/migrate.ts` -- Self-healing migration for corrupted group DM ownership; `backfillOneOnOneDmMembership()` restores pre-fix Deleted-User 1-on-1 threads
- `packages/web/src/components/chat/DmDeletedNotice.tsx` -- read-only composer notice; `packages/web/src/utils/dmFormatters.ts:isDeletedPartnerDm()` gates it
- `packages/server/src/ws/handler.ts` -- `sendToDmMembers()` broadcasts (ConnectionManager method)
- `packages/web/src/stores/dmConversations.ts` -- the client DM merge module (ADR 0002 section 4): the only place a copy of a conversation enters the client (`upsertCopy`, `mergeOriginListing`); `dmChannels` is derived from it
- `packages/web/src/stores/spaceStore.ts` -- Zustand DM state: `removeDmChannel`, `addDmMember`, `removeDmMember`, `updateDmOwner`, `closeDm`, `leaveDm`, `findExistingDmForUser`
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
| Mutable membership | No (immutable pair) | Yes (any member adds, anyone leaves) |
| Max members | 2 | 10 |
| Friendship required | No | Yes (for new adds; exempt for existing DM members during 1-on-1 upgrade) |
| Soft-close | Yes (`closed=1` on dm_members) | Yes (same) |
| Leave | Not supported (use close) | Yes (DELETE `/api/dm/:id/members`) |
| Deletion | Never (1-on-1 DMs persist) | Soft-delete when last member leaves, hard-delete after 24h |
| `name` / `icon` | Always NULL (no metadata) | Nullable. NULL = use comma-joined / AvatarStack fallback. Owner-only writes via `PATCH /api/dm/:id` |

**Critical invariant:** `ownerId` must NEVER be set to NULL on a group DM. A NULL `ownerId` identifies the channel as 1-on-1 -- nulling it corrupts the channel's type identity and breaks membership logic.

---

## Federated ID Algorithm

The conversation key (`dm_channels.federated_id`) is computed or minted only in `utils/dmConversation.ts` (ADR 0002, `docs/decisions/0002-dm-conversation-identity.md`):

```typescript
// 1-on-1: oneOnOneKey(a, b), over homeIdentityOf(u) = u.homeUserId || u.id.
// Same result on any instance for the same pair; these bytes never change.
const sorted = [homeIdentityOf(a), homeIdentityOf(b)].sort();
const key = crypto.createHash('sha256').update(sorted.join(':')).digest('hex').slice(0, 32);

// Group: mintGroupKey(), a random UUID minted once
const key = crypto.randomUUID();  // 36-char UUID with dashes
```

- **1-on-1:** every row stores its key from insertion, relay on or off, whether or not a member is homed elsewhere. The key is a label: what is relayed is decided by the member set (`relayTargetOrigins`), so a pair of this instance's users has a key and no relay targets.
- **Group:** the key is minted, together with the owner home identity, on the instance where the group first gets a member homed elsewhere (group create or add member), and never recomputed. A group no other instance holds keeps `NULL`; on a current server `federatedId: null` means exactly that. Call start reads the key and never computes or mints one; a row without one is not announced to peers.
- **What counts as a 1-on-1 row:** `owner_id IS NULL` and a key that is `NULL` or 1-on-1 shaped (32 hex, `mayBeOneOnOneRow`). An ownerless row with a UUID key is a group copy (up to 1.6.0 the `member_add` bootstrap could create one without an owner) and is never re-keyed, merged or returned as a 1-on-1.
- **Startup backfill:** `initDatabase` runs `backfillOneOnOneKeys` right after `backfillOneOnOneDmMembership`, on every boot. Every 1-on-1 row (as above, exactly two members, not soft-deleted) whose key is `NULL` or differs from the key of its members goes through `reconcileDmChannelFederatedId`: re-keyed in place, or merged into the row that already holds the key. This keys rows made while relay was off or before every 1-on-1 was keyed at insert, and merges such a row with the copy the relay later created for the same pair. A merge keeps one member row per home identity (a merged 1-on-1 never gains a third member), a member who had the merged-away row open has the survivor open, and the merged-away row's `federation_mutation_log` and `federation_outbox` rows are re-pointed to the survivor, so a peer's catch-up sync still gets its messages. Before its first change the database is snapshotted (deployment.md, "Pre-migration snapshot"). Groups are not backfilled. Idempotent; logs `[db] 1-on-1 DM key backfill: keyed N, merged M` only when it changed something.

The format difference (32-char hex vs 36-char UUID with dashes) allows detecting channel type independently of `ownerId`. The self-healing migration uses this: `length(federated_id) = 36 AND federated_id LIKE '________-____-____-____-____________'` identifies group DMs.

**Re-attach re-keys the 1-on-1 `federatedId` (reattach-dm-reconcile spec).** Because the 1-on-1 id derives from the two participants' `home_user_id`s, a participant's `home_user_id` change — the detached-account re-attach flow (`POST /api/users/@me/reattach`, see `federation.md`) — changes the `federatedId` of every 1-on-1 DM that participant is in. Left alone, pre-reattach history would stay under the old-identity channel while new messages compute the new id and split into a parallel channel (one conversation shown twice). Instead, existing channels are **reconciled** by `reconcileDmChannelFederatedId`: **re-keyed in place** when no channel yet holds the new id, or **merged + deleted** into the existing new-identity channel when one does (`idx_dm_federated` is UNIQUE, so a re-key onto an occupied id is impossible). This runs inline in the re-attach transaction for the re-attaching account and in the startup backfill (`backfillOneOnOneKeys`, above), which heals accounts re-attached before the fix shipped. Group DMs (random-UUID `federatedId`, member-independent) are never affected.

**Read pointers follow the person.** Wherever a person's membership moves between rows or local ids (a merge, one row per person in `findOrCreateOneOnOne`, re-pointing a membership to the pair's local id, the re-attach stub merge), their `read_states` row moves with it through `keepNewerReadPointer`: to the local id they keep, and where two pointers meet the newer one stays (message ids compared as numbers).

**Announcing a reconcile.** A re-key or merge outside the boot sweep is announced by `announceDmReconcile` (`utils/dmConversationEvents.ts`), after the transaction commits: `dm_channel_closed` for a merged-away row to its affected members, and `dm_channel_created` with the surviving row to the members who have it open, so a conversation someone closed stays closed. The re-attach route announces its results; `findOrCreateOneOnOne` returns the rows it reconciled on the way (`reconciled`), and both of its callers (`openOneOnOne`, the relayed 1-on-1 create) announce them.

---

## 1-on-1 DM Creation

**Endpoint:** `POST /api/dm` -- `dm.ts:dmRoutes`

**Request:** `{ userId: string }` or `{ homeUserId, homeInstance }`

**Find or create:** `findOrCreateOneOnOne(db, caller, target, { open: 'first' })` (`utils/dmConversation.ts`), the only code that looks up or inserts a 1-on-1 row. In one transaction:
1. The row holding `oneOnOneKey(caller, target)` is the conversation. Its members are made the pair: a member row holding a pair member's home identity under another local id is re-pointed to that member, a missing pair member is added; a 1-on-1 never gets a third member. A row holding the key under someone else's membership has drifted and is first moved to its own key (`reconcileDmChannelFederatedId`).
2. Else a 1-on-1 row (`owner_id IS NULL`, not soft-deleted) whose members are exactly the pair, which is keyed on the way out.
3. Else a new row: `ownerId = NULL`, the key, the caller's membership open and the target's closed.

Looking up by key first returns a relay-created row whose member rows differ instead of inserting the key a second time (which the unique index answered with a 500 before).

**Caller side:** an existing conversation the caller had closed is reopened for them and a `dm_reopen` is relayed. `POST /api/dm` and `ensureOneOnOneDmChannel` (space invites) share this as `openOneOnOne`.

**Target side (#360):** nothing is sent to the target. A new conversation holds their membership closed, and an existing one they closed stays closed. It reaches their list with the next message sent in it, or the first call started in it: `reopenForClosedMembers` reopens closed members and sends them `dm_channel_created`, with the message as `lastMessage` (see "Automatic Reopen"), before the message or the ring. A local target and a target on another instance (who learns of the conversation from its first relayed message) therefore see it at the same moment. The opener keeps an empty conversation in their own list.

**Response:** the `DmChannel` from `loadDmChannelWire`: 201 when the row was created, 200 when it existed.

**No federation event queued at creation time.** The first message's `create` relay carries the participants, and the receiving instance computes the same key (`oneOnOneKey`) and finds or creates its copy with `findOrCreateOneOnOne(..., { open: 'both' })`: its copy is created with the message, open for both members.

**Client routing:** DM creation always goes to the home instance. For federated users, the client passes `{ homeUserId, homeInstance }` and the server resolves the target via `resolveRemoteIdentityForClient()`. The key is stored at creation, as for every 1-on-1. Post-creation, every DM operation (message send/edit/delete, close/leave, typing, reactions, read-state acks) routes through `getChannelOrigin(channelId)` → `getApiForOrigin(origin)`. If the pinned origin drops mid-session, client-side failover re-keys the DM to a connected sibling that mirrors the same `federatedId` — see `docs/systems/client-federation.md` "DM Origin Failover".

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
6. All target users must be friends with the caller (exception: existing DM members when `fromDmChannelId` references a 1-on-1 DM the caller belongs to). The check reads this instance's `friends` table, so the client sends the request to the user's home when it holds a session there ("Add DM Member Modal" below)

**Creation transaction:**
1. Insert `dm_channels` with `ownerId = caller`
2. Insert `dm_members` for caller + all target users

**Post-creation federation setup:**
- If federation relay is enabled and any member has a remote `homeInstance`:
  - Mint the group key via `mintGroupKey()`
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

**Trigger:** `dm.ts:reopenForClosedMembers()`, run by `broadcastDmMessage()` for every new message and by call start (`handleDmCallStart`) before it rings.

For each member with `closed = 1`:
1. Flip `closed` back to `0`
2. Send `dm_channel_created` with the full channel payload (`loadDmChannelWire`; for a message, the new message as `lastMessage`) so their sidebar picks it up
3. Then send the `dm_message_created` event (message) or `dm_call_incoming` (call). A reopened member is also in the `ready` payload's `activeCalls` on reconnect, which is built from open memberships

This ensures closed DMs resurface automatically when new activity occurs.

### Closed state is last-writer-wins

This is the one place the rule is written; other specs point here.

`dm_members.closed_changed_at` is when the row's `closed` value was set, and `utils/dmMemberClosed.ts` is the only writer of both columns (`insertDmMember`, `setDmMemberClosed`, `reopenClosedDmMembers`, `applyRelayedDmMemberClosed`):

- A new member row takes its insertion time: a close or reopen from before the membership began never applies to it.
- A local change (the member closes it, reopens it, a new message or call reopens it) takes the local time of the change.
- A relayed `dm_close` / `dm_reopen` applies only when its timestamp is newer than the row's, and then takes that timestamp. When it applies but the row already had that state, nothing is sent to the member.
- A relayed message delivered live reopens every member who closed the conversation, as a local message does: its `createdAt` is the sender's clock and the close time this instance's, so comparing them would let a sender clock that runs behind keep a fresh reply from reopening it. A message delivered by a pull reopens a member only when the member's state is older than the message (`closedBefore: message.createdAt`): a pull can deliver an old message long after it was sent, and a close made after it was written stands.

A peer's pull replays its mutation log, so a relayed close or reopen can arrive again long after the member's state here moved on; this rule keeps it from undoing a newer state. Local times and a peer's timestamps come from different clocks, which the rule tolerates: it only orders a replayed event against a change made after it was first applied, minutes to days apart. The migration that added the column stamped every existing row with the migration time, so no close or reopen from before the upgrade applies.

### Federation

Close and reopen are relayed to all peer instances that hold a copy of the DM:

- **Close relay:** After setting `closed = 1` locally, `queueDmCloseRelay(channelId, userId, 'dm_close')` queues a `dm_close` outbox event. The receiving instance finds the channel by `federatedId`, resolves the acting user by `homeUserId` + `homeInstance` via `resolveRelayActor`, applies `closed = 1` to the local `dm_members` row last-writer-wins (above), and broadcasts `dm_channel_closed` when the state changed.
- **Reopen relay:** Explicit reopens (`POST /api/dm` when reopening a closed 1-on-1 DM) queue a `dm_reopen` event. The receiving instance applies `closed = 0` the same way and broadcasts `dm_channel_created` with a full channel payload when the state changed.
- **Relayed-message reopen:** `processCreateEvent` (inbound message relay) reopens members who closed the conversation before the message was written and sends them `dm_channel_created`, mirroring `broadcastDmMessage`. A live create then broadcasts `dm_message_created`; a pulled one (federation.md "Pull sync") does not.
- Only fires for DMs with a `federatedId`, to the origins of members homed elsewhere (`getGroupDmTargetOrigins`). A 1-on-1 between two users of this instance is keyed but has no targets; an unshared group has no key.

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
3. Target user must exist
4. Caller and target must be friends
5. Target must not already be a member
6. Current member count must be < 10

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

## Group Metadata Update

**Endpoint:** `PATCH /api/dm/:id` -- `dm.ts:dmRoutes`

Owner-only update of the group DM's `name` and/or `icon`. 1-on-1 DMs reject with 400; non-owners reject with 403.

**Request:** `{ name?: string | null, icon?: string | null }`

Either field may be omitted (no-op for that field), null (clear), or a value. Empty/whitespace `name` collapses to null. `icon` accepts a bare attachment filename (must be owned by caller, image/*, ≤ `GROUP_DM_ICON_MAX_BYTES`) or an absolute http(s) URL (used by the federated rebroadcast path). When a value is provided that equals the stored value, no-op short-circuit returns 200 with no system message and no relay.

**Validation (origin instance):**
- 1-on-1 DM (`ownerId` is NULL) -> 400
- Caller must be a member; caller must equal `ownerId` -> else 403
- `name` (when changing): trimmed length must satisfy `[GROUP_DM_NAME_MIN_LENGTH, GROUP_DM_NAME_MAX_LENGTH]`
- `icon` (when changing to a local filename): `attachments` row exists with `uploaderId === request.userId`, `mimetype` starts with `image/`, `size <= GROUP_DM_ICON_MAX_BYTES`. Absolute URL accepted as-is. Bare filename / `/api/uploads/<filename>` is normalized to bare filename.

**Transaction:**
1. Diff against current row. If neither field changed -> return 200 with current channel; emit nothing.
2. Capture `metadataUpdatedAt = Date.now()` inside the transaction.
3. Update `dm_channels.name`, `icon`, `metadataUpdatedAt` in one statement.
4. Insert one or two `dm_messages` system rows: `name_changed` (`{ event, oldName, newName }`) and/or `icon_changed` (`{ event }`). Both share a single `eventMessageId` correlation root with suffix scheme: `${eventMessageId}:name`, `${eventMessageId}:icon`.

**Post-transaction:**
- Broadcast `dm_channel_updated { dmChannelId, name, icon }` via `sendToDmMembers` (members-only by construction; `metadataUpdatedAt` is intentionally omitted from the WS payload — purely a server-side version vector).
- Broadcast each new system message via `dm_message_created`.
- Queue `group_metadata_update` outbox event with `targetOrigins = getGroupDmTargetOrigins(channelId)`.
- If old icon was a local file and changed/cleared: `deleteUploadFile(old) + deleteAttachmentByFilename(old)` (matches avatar precedent at `users.ts:463-466`).

**Icon URL round-trip:**
- **Owner instance:** `dm_channels.icon` stores the bare filename. Outbound relay normalizes to `${getOurOrigin()}/api/uploads/${icon}` via `normalizeIconForWire` (mirrors profile relay).
- **Receiver instance:** stores either local filename (download success) or absolute URL (download failure fallback). Avatar/`<img>` rendering already handles both transparently.
- **Receivers never re-relay `group_metadata_update`.** Authority invariant ensures only the owner instance emits these events. A receiver's locally-cached filename can never accidentally federate to a third peer.
- **Bootstrap to a new peer** carries the absolute URL inside the extended `FederationGroupPayload` (`member_add` event); see `docs/systems/federation.md` for the bootstrap payload shape.

**Clock semantics:**
`metadataUpdatedAt = Date.now()` is captured at the moment of the DB write inside the owner-instance transaction, not at request entry. This keeps the version vector monotonic across rapid edits on the same instance. Receivers compare strictly greater (`>`) — equal or stale timestamps are silently accepted.

### Owner Kick

**Endpoint:** `DELETE /api/dm/:id/members/:targetUserId` -- `dm.ts:dmRoutes`

Owner-only removal of a single member from a group DM.

**Target identification (local vs federated):**

The `:targetUserId` path segment carries either a local user id on the
owner's instance OR a federated home user id. Optional query string
`?homeInstance=<origin>` signals federated resolution: when present, the
server treats the segment as a homeUserId and resolves it via
`resolveOrCreateReplicatedUser(targetUserId, homeInstance)`. Without the
query parameter, the segment is treated as a local id (legacy form). This
mirrors the federated path on `POST /api/dm/:id/transfer` and is required
for any federated target, because:

- The channel-serving instance and the owner-serving instance can disagree
  on the local replicated user id for the same federated user.
- The client's `useCanonicalUserView` cache may surface the user's HOME
  view, whose `id` is the home id (not this instance's local replicated id).

The client passes the federated query when the target has `homeUserId` +
`homeInstance` populated. See `api.dm.kickMember`'s `federated` parameter.

**Validation:**
- 1-on-1 DM (`ownerId` is NULL) -> 400
- Caller must be the owner -> else 403
- Cannot kick self (use leave instead) -> 400
- Target must be a current member -> else 404
- Unresolvable target (federated id with no replicated row, or unknown
  local id) -> 404

**Sequence:** evict target from any active DM voice room (`evictUserFromDmVoiceRoom`), then reuse the leave path with `reason: 'kick'` -- emits `member_removed` system message (with `reason: 'kick'`), deletes `dm_members` row + `read_states`, broadcasts `dm_member_removed`, sends `dm_channel_closed` to the kicked user, queues `member_remove` outbox event with `reason: 'kick'`. Receiver authority for kicks is `sourceInstance === ownerHomeInstance`; non-owner kicks reject as `unauthorized_source`.

### Manual Ownership Transfer

**Endpoint:** `POST /api/dm/:id/transfer` -- `dm.ts:dmRoutes`

Owner-only transfer of ownership without leaving the channel.

**Request:** `TransferOwnershipRequest`

```typescript
interface TransferOwnershipRequest {
  newOwnerId?: string;     // local user id on the owner's instance
  homeUserId?: string;     // federated identifier (paired with homeInstance)
  homeInstance?: string;   // federated identifier (paired with homeUserId)
}
```

**Target identification (local vs federated):**

The endpoint accepts either a local id (`newOwnerId`) OR a federated
identity (`homeUserId` + `homeInstance`). Federated identification mirrors
`AddDmMemberRequest` and is required when the client only knows the
target's home identity — the common case for federated members surfaced
through `useCanonicalUserView`, whose `id` field is the home id, NOT this
instance's local replicated id. The server resolves via
`resolveOrCreateReplicatedUser(homeUserId, homeInstance)` before
validating membership.

When both forms are supplied, the **federated args win** — they're
strictly more specific (homeUserId + homeInstance disambiguates across
instances), and explicit federation arguments should override a stale
local id that may have come from a cached user view.

Historical context: without the federated path, the membership check
`isDmMember(id, newOwnerId)` always failed for federated targets because
`dm_members.userId` on the owner instance is the LOCAL replicated id, not
the federated home id passed by the client. Symptom was a 400 toast on
the client: "Target user is not a member of this DM channel".

**Validation:**
- Body must include `newOwnerId` OR (`homeUserId` + `homeInstance`) -> else 400
- Unresolvable target (federated id with no replicated row, or unknown
  local id) -> 404
- 1-on-1 DM (`ownerId` is NULL) -> 400
- Caller must be the current owner -> else 403
- Resolved `newOwnerId !== ownerId` (reject self-transfer) -> 400
- Target must be a current member -> else 400

**Transaction (`transferGroupDmOwnership`):** updates `ownerId`, `ownerHomeUserId`, `ownerHomeInstance`; inserts `owner_changed` system message; broadcasts `dm_owner_updated`; queues `ownership_transfer` outbox event. The receiver path is the existing `processOwnershipTransferEvent` -- this endpoint reuses it without modification. The outbox event's `ownership.newOwner` carries the resolved user's home identity, so peers see the correct homeUserId/homeInstance regardless of which form the client used.

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

## DM Tombstone Semantics

When a user is tombstoned (`tombstoneUser()` in `userDeletion.ts` — admin delete, self-delete, federation identity delete, or reset-heal), their DM channels are handled by channel type so that a 1-on-1 survives as a readable, read-only **"Deleted User"** thread while a group DM simply loses the member.

### Membership partition (`userDeletion.ts`)

- **1-on-1 DMs (`dm_channels.ownerId IS NULL`):** the tombstoned user's `dm_members` row is **KEPT**. The channel stores no denormalized partner identity, so the row is what keeps the thread reachable. The row is anonymized for free by the user-row tombstone (`username = '!deleted:{uid}'`, `isDeleted = 1`, nulled profile fields); `GET /api/dm` runs every member through `sanitizeUser` (no `isDeleted` filter), which surfaces the partner as `username: 'Deleted User'` with a nulled avatar/banner/bio.
- **Group DMs (`ownerId IS NOT NULL`):** the tombstoned user's `dm_members` row is **DELETED**. If the deleted user owned the group, ownership transfers to the next remaining member (the `ownedGroupDms` loop). The channel survives with the remaining roster.

Implementation: the function resolves the user's DM channel ids (`userDmChannelIds`), partitions them by `ownerId`, and deletes membership rows only for the group subset. This partition runs in **both** `purgeContent` modes — full "Remove" purges the deleted user's own authored space content but never the DM message text in a surviving channel (that text is the survivor's content and stays readable).

### Dead-DM purge — "zero live members (exclude-uid)"

After the partition, the orphan-purge scan deletes only channels among `userDmChannelIds` that now have **zero live members** — members whose `users.isDeleted = 0`, excluding the uid being tombstoned right now (its row is still `isDeleted = 0` at scan time because the tombstone `UPDATE` runs afterward, so it is excluded explicitly via `userId != uid`). Effect:

- **Deleted ↔ Survivor 1-on-1:** the survivor is a live other → **kept**.
- **Deleted ↔ Deleted 1-on-1:** no live others → **purged** (messages, attachment DB rows + disk files, and `dm_reactions` cleaned up, then the `dm_channels` row).

The scan is **scoped** to `userDmChannelIds` (not a global `dm_channels` sweep) — only this user's membership changed, so only these channels can newly become dead. Pre-existing zero-member orphans from other causes are handled by the leave-path soft-delete + storage janitor.

### Read-only enforcement (`isDeadOneOnOne`)

A Deleted-User 1-on-1 is a **read-only archive** — you can never message a tombstoned (and possibly dead-incarnation) partner, and an edit/delete relay would still be addressed to the tombstoned partner's home instance, risking mis-direction to a new incarnation. The server is the enforcement boundary:

- **Helper:** `permissions.ts:isDeadOneOnOne(dmChannelId, requesterId)` → `true` when the channel is 1-on-1 (`ownerId IS NULL`) **and** every member other than the requester has `isDeleted = 1` (returns `false` for groups and when there are no other members).
- **Applied to all three message mutations on both paths** through `utils/dmMessageRules.ts`: `POST /api/dm/:id/messages` and WS `dm_message_create` (after the `isDmMember` gate), `PATCH /api/dm/messages/:id` and WS `dm_message_edit`, `DELETE /api/dm/messages/:id` and WS `dm_message_delete`. REST rejects with **`403 { error: "This user's account was deleted", code: 'recipient_deleted', statusCode: 403 }`**; the WS events answer an `error` event with `code: 'recipient_deleted'`. Nothing is stored, broadcast or relayed.
- **Identity:** the check compares row ids on this instance (the session's user row and the conversation's `dm_members` rows), so it holds on a copy of a federated conversation too: a federated account acting here is judged by its own row, and a replicated partner whose home deleted them is tombstoned here by the identity delete and counts as deleted.
- **Applied to DM reactions on the WebSocket path** in `ws/events.ts`: `handleReactionAdd` and `handleReactionRemove` call `isDeadOneOnOne(dmMsg.dmChannelId, userId)` after the `isDmMember` gate and **silently drop** the frame (WS has no response channel). Without this, a survivor could add/remove reactions on historical messages and the reaction would relay to the tombstoned partner's home instance — the exact mis-directed relay the read-only invariant exists to prevent.
- **Client mirror (consistency, not the boundary):** `components/chat/Message.tsx` withdraws the add-reaction affordances (hover button, emoji picker, context-menu "Add Reaction") and no-ops existing-pill toggles when the message's DM is a dead 1-on-1 (`isDeletedPartnerDm(dm, currentUser)`). Existing reactions still **display** read-only; only add/remove is disabled.

### Live update on the heal path

`healResetIncarnation` (`utils/federationReset.ts`) — the reset-heal deletion caller — now aligns with the other three deletion callers: for each stub it collects co-member targets via `collectDeletionBroadcastTargets(stub.id)` **before** `tombstoneUser` (which deletes the rows that set is derived from), then re-reads the tombstoned row and broadcasts a sanitized `user_updated` (`{ type: 'user_updated', user: sanitizeUser(deletedRow) }`) to each target via `connectionManager.sendToUser`. Survivors' clients flip the partner to "Deleted User" live — no reload.

Client-side, no new store action was added: the `user_updated` handler already calls `spaceStore.updateUserEverywhere` (patches the matching `dmChannels[].members` entry) and `upsertUserView`, and the 1-on-1 header/composer resolve through the canonical user-view cache, so the partner flips to "Deleted User" across the sidebar, header, and open-thread messages. The composer is replaced by a read-only notice (`components/chat/DmDeletedNotice.tsx`), gated by `dmFormatters.ts:isDeletedPartnerDm(dm, currentUser)` (1-on-1 whose every other member `isDeleted`), in `MainContent` and `MobileChatScreen`.

### One-time backfill for pre-fix threads

Users tombstoned **before** this fix already had their 1-on-1 `dm_members` row deleted, leaving those threads permanently unreachable. `migrate.ts:backfillOneOnOneDmMembership(db)` runs idempotently at every boot (called from `db/index.ts`): for each `ownerId IS NULL` channel with exactly **one** `dm_members` row, it re-inserts a membership row (`closed = 0`) for any distinct `dm_messages.userId` that is missing from `dm_members` **and** still exists in `users` (the `JOIN users` guard drops authors whose row is truly gone). Bounded, only inserts missing rows, safe on every re-run.

---

## Message Operations

### Send Message

**Endpoint:** `POST /api/dm/:id/messages` -- `dm.ts:dmRoutes`

**Rate limit:** 5 per 5 seconds per client address (`DM_MESSAGE_CREATE_RATE_LIMIT` in `utils/dmMessageRateLimit.ts`), `429 rate_limited` over it. The WS `dm_message_create` event applies the same numbers to the socket's address (recorded when it connects, `ws/socketAddress.ts`) before any other check and refuses with an `error` carrying `rate_limited`. The two paths count separately: the REST counter lives inside `@fastify/rate-limit`, which nothing outside the plugin can reach.

**Request:** `{ content?: string, attachments?: string[], replyToId?: string }`

**Cross-instance access:** Federated users (those with `homeInstance` set) can send messages on any DM channel where they are a member, regardless of which instance serves the request. The `requireLocalUser` gate that previously blocked federated users from DM write endpoints has been removed. DM calls work across federated instances. The caller's instance hosts the LiveKit room; remote clients connect directly. Call signaling is relayed to all active federation peers via synchronous HTTP POST (not the outbox worker). Relay failures at any call state transition emit `dm_call_undeliverable { phase, terminal, failures }` to the originator — see `docs/systems/voice.md` for the full call state machine and failure surface. Federated call-start to a remote instance with no reachable recipient surfaces as `dm_call_undeliverable` with reason `no_recipient` — see `voice.md` for the full failure-surface table.

**Validation** (`checkDmMessageCreate` in `utils/dmMessageRules.ts`, in this order; the WS `dm_message_create` event runs the same check and answers each refusal with an `error` event carrying the code):
- Caller must be a member (`isDmMember`)
- Rejected with `403 recipient_deleted` if `isDeadOneOnOne(id, caller)` — read-only Deleted-User thread (see "DM Tombstone Semantics")
- `content` a string, `attachments` a list of ids, `replyToId` a string, where present (`400 validation_failed`)
- Must have content or attachments (not both empty; `400 content_required`)
- Content max length: 4000 chars (`MAX_MESSAGE_LENGTH`; `400 content_too_long` with `details: { max }`)
- `replyToId`, when present, must name a message in this same DM channel (`isDmReplyTargetInChannel`) -- otherwise `400 reply_target_invalid` and nothing is inserted
- Attachment ownership verified (must be unlinked, `attachment_invalid`, and uploaded by the caller, `attachment_not_owned`)

**Reply hydration:** every DM read path resolves `replyTo` through `fetchDmReplyToMessages(dmChannelId, rows)` (`dm.ts`), which scopes the reply lookup to the channel being read -- `getDmMessageWithUser`, `GET /api/dm/:id/messages`, `GET /api/dm/:id/search` and `GET /api/dm/:id/messages/around`. A `replyToId` pointing outside the channel hydrates as `replyTo: null` rather than surfacing the other conversation's message, so rows predating the create-time check stay contained. Relay never introduces a cross-channel target either: an inbound federated DM message never adopts the wire's `replyToId` (the sender's local id). Its reply target comes from `message.replyTo`, a `FederationMessageRef` resolved by `resolveRelayedReplyTarget` (`federation/dmChannels.ts`) and kept only when it names a message in the channel the reply is stored in; otherwise the reply is stored with `replyToId: null`. See "Outbound: Relay Payload Structure" below.

**Flow:**
1. Insert message + link attachments in a single transaction
2. Hydrate full `DmMessageWithUser` via `getDmMessageWithUser()`
3. Broadcast via `broadcastDmMessage()` (handles soft-close reopen)
4. Queue federation relay via `queueDmRelay(message, channelId, 'create')`
5. Resolve embeds asynchronously via `setImmediate()`

### Edit Message

**Endpoint:** `PATCH /api/dm/messages/:id` -- `dm.ts:dmRoutes`

Checks (`checkDmMessageEdit`, shared with WS `dm_message_edit`), in order: content present (`content_required`) and within `MAX_MESSAGE_LENGTH` (`content_too_long`), the message exists (`404 message_not_found`), the caller is a member of the message's conversation (`isDmMember`, `403 not_dm_member`), `dmMessageEditRefusal` (`system_message_immutable`, then author-only `not_message_author`), then `403 recipient_deleted` if `isDeadOneOnOne(msg.dmChannelId, caller)` (see "DM Tombstone Semantics"). Then:

1. Update content and set `editedAt`
2. Delete old embeds, re-resolve new embeds asynchronously
3. Broadcast `dm_message_updated` to all members
4. Queue federation relay via `queueDmRelay(updated, channelId, 'update')`

A member who left or was removed from a group no longer has a `dm_members` row in it, so they cannot edit or delete the messages they wrote there before; the check reads this instance's copy of the conversation, so it holds on every instance that hosts one. A member who closed a conversation keeps the row.

### Delete Message

**Endpoint:** `DELETE /api/dm/messages/:id` -- `dm.ts:dmRoutes`

Checks (`checkDmMessageDelete`, shared with WS `dm_message_delete`), in order: the message exists (`404 message_not_found`), the caller is a member of the message's conversation (`isDmMember`, `403 not_dm_member`), author-only (`403 not_message_author`), then `403 recipient_deleted` if `isDeadOneOnOne(msg.dmChannelId, caller)` (see "DM Tombstone Semantics"). Then:

1. Collect attachment filenames before deletion
2. Delete attachments, reactions, and message atomically in a transaction
3. Clean up files from disk
4. Broadcast `dm_message_deleted` to all members
5. Federation: `queueDmMessageDeleteRelay(id, dmChannelId)`

**Note:** `queueDmMessageDeleteRelay(messageId, dmChannelId, target)` (`federationOutbox.ts`) is the single source of truth for the delete relay and is shared with the WebSocket delete path (`ws/events.ts`). Both callers build `target` with `dmMessageMutationTarget` before deleting the row (see "Relayed edits and deletes"). It appends the mutation log entry and enqueues the outbox event with `getGroupDmTargetOrigins(dmChannelId)`, so a delete reaches exactly the peers that host a participant -- the same targeting create/update use.

---

## Federation Relay Pipeline

This section covers the DM-specific application-level relay logic. For the wire protocol, outbox delivery, HMAC signing, and retry mechanics, see `docs/systems/federation.md`.

### Outbound: Target Origin Resolution

**Function:** `federationOutbox.ts:getGroupDmTargetOrigins()`

Participant-derived for every DM, 1-on-1 and group alike:

```
query all members' homeInstances
  → normalize bare domains to full URLs
  → filter out our own origin
  → return unique peer origins   (empty array when every member is local)
```

The return type is `string[]`, never `undefined`. The distinction matters at the
call site: `queueOutboxEvent` reads an **omitted** `targetPeerOrigins` as
"broadcast to every peer", while `[]` is a target list that matches no peer. A
DM whose participants are all local therefore relays nowhere. `queueOutboxEvent`
enforces this structurally — it refuses to enqueue a `contextType: 'dm'` event
that arrives with no target list at all, and logs the caller instead.

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
  type?: 'system',                               // only on system messages
  content: message.content,
  replyToId: message.replyToId ?? null,          // sender-local; receivers ignore it
  replyTo?: { messageId, messageHomeInstance },  // only on replies; see below
  mentions?: [{ id, homeUserId, homeInstance }], // only when the content mentions someone; see "Mentions in relayed messages"
  editedAt: message.editedAt ?? null,
  createdAt: message.createdAt,
}
```

**Naming a message across instances.** Each instance holds its own copy of a federated message under its own local id, so a relay event that points at another message names it with `FederationMessageRef { messageId, messageHomeInstance }`: the message's id on the instance that created it, and that instance's origin. `dmMessageFederationRef(row)` (`federationOutbox.ts`) builds it from a row: a row this instance created is `(row.id, getOurOrigin())`, a relayed copy is `(row.sourceMessageId, row.sourceInstance)`. The receiver turns it back into its own row with `resolveLocalDmMessage`. Replies (`message.replyTo`, filled by `dmReplyRefForRelay` in `queueDmRelay` and in the sync endpoint) and reactions (`reaction.messageId` + `reaction.messageHomeInstance`, filled by the WS reaction handlers and in the sync endpoint) both use it. `replyTo` is an optional field: an older sender omits it and its replies arrive without a quote, an older receiver ignores it.

The full event includes `participants` (all channel members with their federated identities and profile snapshots) and optionally `federatedId` (for group DMs).

### Mentions in relayed messages

This is the one place the rule is written; other specs point here. Code: `utils/federationMentions.ts`.

A mention is a `<@id>` token in the content, and the id is one the instance the content was written on issued: a DM's tokens are its pinned origin's ids, which name nobody on another instance. So a relayed `create` or `update` carries `message.mentions: FederationMentionRef[]`, and the receiver stores the content with its own ids in the tokens.

- **Tokens.** `<@[A-Za-z0-9_-]+>` outside fenced and inline code, the same scan as the web `MarkdownRenderer`. A token inside code is text and is never listed or rewritten. DMs have no channel or role mentions.
- **Sender** (`relayMentionsOf`, called by `buildRelayPayload`, which builds the message part of both the live relay and the sync endpoint's replay on the current content). Each distinct token id that names a live local user becomes `{ id, homeUserId, homeInstance }` with that row's `relayActorOfUser` identity: a native user is its own id and `getOurOrigin()`, a replicated or federated row its home pair. An id with no live row, or a row without a comparable identity, is left out. At most `MAX_RELAYED_MENTIONS` (100) entries. System messages and content without mentions carry no list: `relayMentionsOf` returns none for them, and the builder then omits the field.
- **Receiver** (`rewriteRelayedMentions`, in `processCreateEvent` before the insert and in `processUpdateEvent` before the write, for events with and without `target`). The list is read defensively: a non-array is ignored, at most 100 entries are read, an entry needs a token-shaped `id` and non-empty string fields of at most 255 characters, and only the first entry for an id counts. Each listed id that appears as a token is resolved with `resolveRelayActor(homeUserId, homeInstance)`, matched on the pair and never on the bare id. A `found` row replaces the token's id. An identity with no live row here (`unknown`, `mismatch`, or a deleted user) leaves the token as written, and no row is created for a mention: every participant was already resolved or created for the event, the web resolves a DM token only among the DM's members, and creating stubs from a list would let any peer create rows by naming identities. System messages are stored as sent.
- **Edits.** An edit carries its full new content and a list in its own sender's id space, which can be a different instance from the one that sent the create (a user writing through their account on another instance). The receiver rewrites from scratch and keeps no mention state.
- **What follows.** Stored content names local rows, so the REST and WebSocket payloads, reply previews (built from the local row), search (`LIKE` over stored content) and the web notification filter (`content.includes('<@myId>')`) all see this instance's ids.
- **Mixed versions.** An older sender sends no list and its content is stored as sent (foreign ids, rendered as an unknown user, as before). An older receiver ignores the list.

### Inbound: Message Create

**Function:** `federation.ts:processCreateEvent()`

**Deduplication:** Check `sourceInstance` + `sourceMessageId` -- reject if already exists.

**Participant resolution:**
- ALL participants resolved via `resolveOrCreateReplicatedUser()` (auto-creates stubs for unknown remote users)
- Profile data from relay event hydrated onto replicated user stubs via `hydrateReplicatedUserProfile()`
- The author is the resolved participant that IS `event.message`'s `homeUserId` + `homeInstance` (`resolveRelayActor`), not the first participant sharing its `homeUserId`: a participant bound by username can resolve to a row of another identity. No such participant: reject `author_not_found`

**Channel resolution (group vs 1-on-1):**

| Has `federatedId`? | Path |
|---------------------|------|
| Yes (group DM) | Lookup by `federatedId`. If not found, reject (`channel_not_found`) -- channel must exist from prior `member_add` bootstrap. Then the "Relayed message creates" check against the channel's members |
| No (1-on-1 DM) | The "Relayed message creates" check against the first two participants, then `findOrCreateOneOnOne()` for the pair (key `oneOnOneKey`) |

### Relayed message creates

This is the one place the rule is written; other specs point here.

A relayed `create` is written into a conversation only when the sending peer and the author both belong to it (`mayRelayInto`, `federation/dmChannels.ts`):

1. The author (resolved from `event.message` among the participants, after `attributionRefusal`) must be one of the conversation's members: for a group, its `dm_members` rows on this instance; for a 1-on-1, one of the two participants whose home user ids its `federatedId` is computed from. The pair is the whole membership of a 1-on-1, so it is checked before `findOrCreateOneOnOne` creates or re-adds anything.
2. The signing peer must be one of `relayTargetOrigins(<those members>)` (`federationOutbox.ts`), the origins this instance relays the conversation to, compared by domain as `attributionRefusal` compares instances (stored `homeInstance` values are bare domains). `getGroupDmTargetOrigins(channelId)` is the same function applied to a stored channel. Only those instances hold a copy of the conversation a message could have been written in. A 1-on-1 between two users of this instance has no relay targets here, so a create for it from another instance (where the two talk through their accounts there, and which does queue it) is refused.

Nothing is written when either fails. The reason depends on the conversation (`nonMemberRefusal`, `federation/dmChannels.ts`):

- **Group:** `unauthorized_source`, which the sender retries. This instance knows a group's membership only as its copy currently holds it, and that copy changes through relayed `member_add` events. A member added through a third instance can post before their add reaches this instance; the create is refused until the add lands, and the retry then writes it.
- **1-on-1:** `invalid_target` (terminal). The pair never changes, so a retry cannot succeed. This includes a `federatedId` that names a 1-on-1 here, which senders never send for one.

The check reads no new wire field, so events from older senders are judged the same way; every sender version retries `unauthorized_source`.

**`findOrCreateOneOnOne(db, a, b, { open: 'both' })`** (see "1-on-1 DM Creation" for the lookup order):
- The row holding the key, with its members made the pair (missing ones added open, a same-identity row under another local id re-pointed)
- Else an unkeyed row whose members are exactly the pair, keyed
- Else a new row with `ownerId = NULL`, the key, and both members open (the message is delivered with it)
- The caller then late-binds a federated call that rang before this copy existed (`lateBindFederatedCall`)

**Attachment handling:**
- Attachment rows created immediately with `filename = sourceUrl` (remote URL)
- Frontend renders remote URLs directly when filename starts with `http`
- Background file worker downloads the file and updates the filename to the local path
- SSRF protection: `isUrlFromPeer()` validates attachment URL hostname matches peer origin

**Broadcast:** every local member of the conversation gets `dm_message_created`, members homed on the source instance included; a member who closed it is reopened first and gets `dm_channel_created` with the message (the same resurface sequence as `broadcastDmMessage`; which closes a relayed message reopens is in "Closed state is last-writer-wins"). A message that arrived through a pull is stored without `dm_message_created` (federation.md "Pull sync"); when it created this instance's copy of a 1-on-1, each member gets that copy in a `dm_channel_created`, which makes no sound, so the conversation is listed without a reconnect.

**A delete that came first.** A create whose message a `delete` from the same peer already named is answered `duplicate` and stored nowhere (federation.md "Receiver guarantees").

### Relayed edits and deletes

This is the one place the rule is written; other specs point here.

DM edits and deletes are author-only on every path (REST `PATCH`/`DELETE /api/dm/messages/:id`, WS `dm_message_edit`/`dm_message_delete`). There is no moderation delete in DMs, group owners included, so a relayed edit or delete is authorized by authorship alone.

**Outbound.** `update` and `delete` events carry `target: FederationMessageTarget` (`@backspace/shared`), built by `dmMessageMutationTarget(row, actorUserId)` (`federationOutbox.ts`):

- `message`: the message as a `FederationMessageRef` (`dmMessageFederationRef`, see "Naming a message across instances"). A row that is itself a relayed copy is named by the id and origin it arrived with, never by this instance's id.
- `federatedId`: the conversation's `federatedId` (1-on-1 and group alike).
- `actor`: the editing or deleting user's federated identity (`relayActorOfUser`).

The event's `messageId` stays the sender's local id: it is the outbox coalescing key and what older receivers match on. Deletes build the target before removing the row and store it in the mutation log payload, so the sync endpoint can replay it. A conversation without a `federatedId`, or an actor without a comparable identity, gets no target and the event goes out in the old shape.

**Inbound** (`resolveRelayedMutationTarget`, `federation/events/dmMessages.ts`), for an event with a `target`:

1. Malformed target: rejected `invalid_target` (terminal).
2. `attributionRefusal(target.actor, sourceInstance)`, the same check every relay event runs (direct, or homeward via `localUserActsOnPeer`): a refusal is returned as its reason, `attribution_mismatch` (terminal) or `attribution_unproven` (retried: the homeward proof has not reached this instance yet). See `federation.md` §3.
3. Resolve `target.message` with `resolveLocalDmMessage`, and require it to be in this instance's copy of `target.federatedId`: else `unknown_message`. For an edit it is not terminal: the create may not have arrived yet, and the sender retries on the outbox backoff schedule. A delete of a message not held here at all is accepted instead (see "Inbound: Message Delete").
4. The signing peer must be one of `getGroupDmTargetOrigins(<the message's conversation>)`, the origins this instance relays that conversation to, or the instance the message itself arrived from (`dm_messages.sourceInstance`, compared with `normalizeOriginForCompare`; the relay targets are compared by domain, as in "Relayed message creates"): else `invalid_target` (terminal). A peer the conversation never reached cannot address its messages, whatever actor it names.
5. The actor must be the message's author, compared as federated identities (`sameRelayActor(relayActorOfUser(author), target.actor)`: equal home user id, same home domain), never as local ids: else `not_message_author` (terminal). Nothing is modified.

An event **without** a `target` (an older sender) is matched as `(sourceInstance, messageId)`. That only finds a message the sending instance created and relayed here, so the lookup is its own authorization, as before. An older receiver ignores `target` and keeps doing exactly that, so for it an edit or delete of a message the sender did not create still fails as `unknown_message`.

### Inbound: Message Update

**Function:** `federation/events/dmMessages.ts:processUpdateEvent()`

1. Find and authorize the local message ("Relayed edits and deletes")
2. Last-writer-wins on the author's `editedAt`: an edit whose `editedAt` is not newer than the copy's changes nothing and sends nothing (accepted). An older sender without `editedAt` is applied only when the content differs
3. Update content (mention tokens rewritten, "Mentions in relayed messages") and `editedAt`
4. Broadcast `dm_message_updated` to all local members

### Inbound: Message Delete

**Function:** `federation/events/dmMessages.ts:processDeleteEvent()`

1. Find and authorize the local message ("Relayed edits and deletes"). A message this instance does not hold at all is accepted as a no-op; when it is homed on the signing peer, a tombstone is recorded (federation.md "Receiver guarantees") so a create of it arriving later is a duplicate
2. Record the same tombstone for a held relayed copy homed on the signing peer, so a create delivered again later does not bring it back
3. Delete attachments, reactions, and message atomically
4. Clean up attachment files from disk
5. Broadcast `dm_message_deleted` to all local members

### Inbound: Read State Update

**Function:** `federation.ts:processReadStateUpdateEvent()`

Triggered by a `read_state_update` relay event sent when a user on another instance acknowledges a DM channel.

1. Resolve channel by `federatedId` — reject if not found
2. Resolve user by `homeUserId` + `homeInstance` via `resolveRelayActor`: `user_not_found` if unknown
3. Resolve message by `messageRef` (local ID or `source_instance + source_message_id`)
4. Upsert `read_states` row for the resolved user and message
5. Broadcast `channel_ack` to the user's local WebSocket connections for multi-tab sync

Not stored in the outbox or mutation log — fire-and-forget, missed deliveries are not retried.

### Inbound: Reaction Add/Remove

**Functions:** `federation.ts:processReactionAddEvent()`, `processReactionRemoveEvent()`

- Uses `resolveLocalDmMessage()` for cross-instance message resolution (handles messages originating on this instance vs relayed messages)
- **Scope** (`reactionScopeRefusal`), checked on the resolved message before anything changes:
  1. The signing peer must pass the peer check of "Relayed edits and deletes" (step 4, `isPeerOfMessage`): one of the origins this instance relays the message's conversation to, or the instance the message came from. Else `invalid_target` (terminal). This holds for every message the event can name, including one that originated on this instance.
  2. The reactor must be a member of the message's conversation here, matched by federated identity (`memberWithIdentity` over `dmChannelMembers`), as the local reaction handlers require (`isDmMember`). Else `nonMemberRefusal`, as for "Relayed message creates": `unauthorized_source` (retried) in a group, whose roster here may not yet hold a member added through a third instance; `invalid_target` in a 1-on-1.
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
1. Validate authority ("Relayed member adds" below)
2. Cancel soft-delete if channel was pending GC (`deletedAt` set)
3. Resolve added user via `resolveOrCreateReplicatedUser()`
4. Enforce 10-member cap
5. Insert `dm_members` row (idempotent)
6. Insert system message for member addition
7. Broadcast `dm_message_created` (system) and `dm_member_added` to local members

### Relayed member adds

This is the one place the rule is written; other specs point here.

What decides the path is whether this instance holds a channel with the event's `federatedId` (soft-deleted or not):

- **Bootstrap** (no such channel): the event must carry `group`, which must name an owner, and `attributionRefusal(group.owner, sourceInstance)` must pass: the sender speaks for the group's owner. The owner and roster are then resolved (`resolveOrCreateReplicatedUser`; tombstoned identities are dropped) and `mayRelayInto(<roster>, <owner>, sourceInstance)` must pass: the owner is in the roster and the signing peer is one of the instances the roster lives on. A missing owner or a failed roster check is `invalid_target` (terminal; the event carries everything it is judged on, so a retry cannot change the answer) and no channel is created. The roster it sends becomes this instance's copy. This is how a brand-new group, or a group this instance has never held, arrives.
- **Incremental** (the channel exists): the add is judged against this instance's copy, mirroring `POST /api/dm/:id/members`:
  1. `attributionRefusal(membership.addedBy, sourceInstance)`, as for every relay event.
  2. The channel must be a group (`ownerId` set). A 1-on-1 has a fixed pair: else `invalid_target` (terminal).
  3. The adder (`membership.addedBy`, required) must be a current member of this copy, matched by federated identity (`memberWithIdentity`: same home user id on the same home domain), and the signing peer one of `relayTargetOrigins(<the members before the add>)`, compared by domain (`mayRelayInto`, `federation/dmChannels.ts`, the same check "Relayed message creates" uses): else `unauthorized_source`. Nothing is added.

**Order.** Adds and removes of one member are last-writer-wins on the member's clock, whichever instance sent them and whether they came live or by a pull: an add older than the member's last change here (a kick, a leave, or a change made through this instance's routes) is accepted and changes nothing, before either path, so it also creates no copy of a group not held here. The rule is in [federation.md "Subject clocks"](federation.md#subject-clocks-member-and-friend-events-are-last-writer-wins).

`unauthorized_source` is retried by the sender. An add can legitimately arrive before the event that made its adder a member, when that member was added through a third instance; the retry applies it once that event has landed. The local route's friendship check is the adder's own instance's to make; the receiver cannot see that friendship.

Known limit: a copy kept after all of this instance's members left keeps its roster from that time. An add by someone who joined later is refused until their own add reaches this instance, which it does not, since the group is no longer relayed here. Re-adding through the owner or any member still in that roster works.

### Bootstrap vs Incremental Batching

When a group DM is created with multiple remote members, the origin instance queues one `member_add` event per remote member. These events arrive in a batch on the receiving instance. Only the FIRST event triggers bootstrap (channel not found). Subsequent events find the channel and take the incremental path. This is correct because the bootstrap adds ALL roster members from `event.group.members`, making the incremental events idempotent.

### Member Remove (Inbound)

**Function:** `federation.ts:processMemberRemoveEvent()`

1. Find channel by `federatedId`. If not found, accept silently (idempotent). A kick (`reason` other than `leave`) on a channel without an owner, a 1-on-1, is refused `invalid_target` (terminal): a 1-on-1 has a fixed pair and no one who may kick.
2. Authority check: for kicks, `sourceInstance` must match `ownerHomeInstance`. For self-leave (`reason === 'leave'`), any instance is accepted.
3. Member's clock: a remove older than the member's last change here is accepted and changes nothing; otherwise the clock moves to it, also when there is no one to remove ("Relayed member adds", **Order**).
4. Resolve user by `homeUserId` + `homeInstance` via `resolveRelayActor()` (they should already exist). If not found, accept silently.
5. Insert `member_removed` system message (before deletion so broadcast includes leaving user)
6. Delete `dm_members` row
7. Delete `read_states`
8. Broadcast `dm_member_removed` to remaining local members
9. If zero members remain: soft-delete channel

### Ownership Transfer (Inbound)

**Function:** `federation.ts:processOwnershipTransferEvent()`

1. Find channel by `federatedId`. If not found, accept silently.
2. The channel must be a group (`ownerId` set): a 1-on-1 has no owner to transfer, so the event is refused `invalid_target` (terminal). Then the authority check: `sourceInstance` must match `channel.ownerHomeInstance`
3. Resolve new owner via `resolveOrCreateReplicatedUser()` -- **MUST guarantee non-null** (see invariant above)
4. Update `dm_channels`: `ownerId`, `ownerHomeUserId`, `ownerHomeInstance`
5. Broadcast `dm_owner_updated` to local members
6. Insert `owner_changed` system message

---

## System Messages

System messages (`type = 'system'` in `dm_messages`) record group lifecycle events in the chat timeline. This section is the one statement of their rules; code comments point here.

### The content contract

- **One definition.** `DmSystemEvent` and `parseDmSystemEvent` (`packages/shared/src/dmSystemEvents.ts`) define every event below and its fields. `parseDmSystemEvent` returns the event with only the fields it defines, or null for anything else (not JSON, an unknown event, a missing or mistyped field). The server writes content only through `dmSystemContent` and names users in it through `dmSystemName` (`packages/server/src/utils/dmSystemMessages.ts`); the web reads it only through that parser (below).
- **User ids in content are the storing instance's own.** Membership and metadata system messages are never relayed as messages: every instance writes its own from the relay event it applies, whose users are named by home identity (see "Instance-Local Creation"). So `targetUserId` and `newOwnerId` always name rows of the instance that stored them. No renderer reads them; the names shown are the `*DisplayName` fields recorded at the time of the event.
- **Only `space_invite` is relayed as a message** (`RELAYABLE_DM_SYSTEM_EVENTS`). The space invite route builds its content through `parseDmSystemEvent` and refuses an invite that would not parse (`invite_invalid`), so it never sends one a receiver refuses.
- **Relayed system content is validated.** `processCreateEvent` parses a relayed `type: 'system'` message before it writes anything and stores it only when it is a well-formed relayable event, in its canonical form; anything else is refused with `invalid_system_message`.
- **System messages cannot be edited**, by anyone, their author included. `PATCH /api/dm/messages/:id` and the WS `dm_message_edit` share `dmMessageEditRefusal` (through `checkDmMessageEdit`) and answer `system_message_immutable`; a relayed `update` of a system message is refused with the same reason. How a sender's outbox treats both relay reasons, by sender version: `federation.md`, "Rejection reasons". Deleting a system message follows the ordinary delete rules.

### Event Types

| Event | Content JSON | Actor (`userId`) |
|-------|-------------|-----------------|
| `member_added` | `{ event, targetUserId, targetDisplayName }` | User who added them |
| `member_removed` | `{ event, targetUserId, targetDisplayName, reason }` | User who left/was removed |
| `owner_changed` | `{ event, newOwnerId, newOwnerDisplayName }` | Previous owner |
| `name_changed` | `{ event, oldName, newName }` | Owner who renamed |
| `icon_changed` | `{ event }` | Owner who set/cleared the icon |

### `space_invite` (user-initiated, federated via processCreateEvent)

Sent by `POST /api/dm/space-invite` (see `docs/systems/spaces.md`). Unlike membership-event system messages, this one is user-initiated content — the inviter authored it deliberately. It travels through the standard DM message create relay (`processCreateEvent`), not a dedicated event kind. The route hands every invite to `queueDmRelay`, as the message routes do, so it reaches each instance that hosts a participant, the sender's own home included when the sender is a federated account acting on this instance (a homeward relay, `attributionRefusal` case 2).

JSON content shape:

```json
{
  "event": "space_invite",
  "spaceId": "<snowflake>",
  "spaceInstanceOrigin": "https://z.example",
  "inviteCode": "<8-hex>",
  "snapshot": {
    "spaceName": "...",
    "icon": null,
    "avatarColor": null,
    "memberCount": 12,
    "description": "...",
    "instanceName": "..."
  }
}
```

The `spaceInstanceOrigin` is the space's home instance, **not** the sender's. The recipient's client uses it to fetch the live preview (`getApiForOrigin(spaceInstanceOrigin).spaces.invitePreview`) and to call `joinByCode(code, spaceInstanceOrigin)` on click. For a space joined by request (the live preview's `visibility`, or a join answered with `join_request_required`) the card's action is "Ask to join", which sends a join request to the same origin; the route sends invites to such spaces since it stopped refusing them with `space_requires_approval` after 1.9.0 (spaces.md, "Invite links to a space joined by request").

### Rendering

System messages never surface their `content` as text. The timeline row (`components/chat/SystemMessage.tsx`) and the sidebar preview (`formatDmSidebarPreview`) both read it with `parseDmSystemEvent` and phrase it with `dmSystemText(event, actorName, form)` in `utils/dmFormatters.ts`, translated (`dm:system.*`). The timeline uses the fuller form (`'timeline'`: "added X to the group", "renamed the group to \"N\"", with a glyph from `dmSystemIcon`) and renders a `space_invite` as its card; the sidebar uses the short form (`'preview'`). Content the parser does not accept renders as the generic label in both. The actor is `dmSystemActor`: the roster entry for the message's author, else the author the message carries. `dev-system-messages.html` renders every case.

The sidebar uses the `type` field on the `lastMessage` payload (`'user' | 'system'`) to dispatch:

| Event | Sidebar preview |
|-------|-----------------|
| `space_invite` | `📨 Sent invite to {snapshot.spaceName}` |
| `member_added` | `{actorName} added {targetDisplayName}` |
| `member_removed` (`reason='leave'`) | `{targetDisplayName} left the group` |
| `member_removed` (kick) | `{actorName} removed {targetDisplayName}` |
| `owner_changed` | `{newOwnerDisplayName} is now the group owner` |
| `name_changed` (newName non-null) | `{actorName} renamed the group` |
| `name_changed` (newName null) | `{actorName} cleared the group name` |
| `icon_changed` | `{actorName} updated the group icon` |
| Unknown / malformed JSON | `System message` |

`actorName` is `dmSystemActor` (above). System messages are NEVER prefixed with `${sender}: ` in group DMs — the rendered text already incorporates the actor.

User messages keep the existing behavior: text/attachment formatting via `formatDmPreview`, with a `${senderDisplayName}: ` prefix in group DMs when the author is not the current user.

The single source of truth on the client is `packages/web/src/utils/dmFormatters.ts:formatDmSidebarPreview(dm, currentUser)`. All call sites (`DmListItem`, `MobileDmsScreen`) MUST use it — never read `lastMessage.content` directly.

**Server contract:** Every code path that emits a `DmLastMessagePreview` (REST `GET/POST /api/dm`, `POST /api/dm/:id/members`, WS `ready` payload, `dm_channel_created` reopen) MUST include the `type` field copied from the `dm_messages.type` column. Without this, the client cannot distinguish system from user messages and falls back to rendering raw JSON.

### Instance-Local Creation

Membership and metadata system messages are NOT relayed via federation (a `space_invite` is, as a message; see "The content contract"). Each instance creates its own independently:

- **Origin instance:** Creates in the REST endpoint, broadcasts to local members only (group DM creation) or all local members (incremental add/leave)
- **Receiving instance:** Creates in the federation event processor, broadcasts to local members

This avoids duplicate system messages for users connected to multiple instances.

### Receiving-Side Idempotency

Membership event processors (`processMemberAddEvent`, `processMemberRemoveEvent`, `processOwnershipTransferEvent`) persist the federation event's `(sourceInstance, event.messageId)` on the system-message row they insert (`dm_messages.source_instance`, `dm_messages.source_message_id`). The unique index `idx_dm_messages_source_unique` enforces that this pair occurs at most once per receiving instance.

Each processor's first step is to `SELECT` for a matching row and `accepted.push(event.messageId); return` if found. This makes the entire event handler a no-op on repeat delivery. The guarantee covers:

- **Outbox retries** after transient network failures.
- **Initial sync replays** when a peer's `lastSyncedAt` resets (e.g. after an admin re-approves a peering request, which recreates the peer row with the default `lastSyncedAt = 0`).
- **Bootstrap vs incremental races** — `processMemberAddEvent` emits the system message in both paths so bootstrap deliveries that later re-arrive as incremental events short-circuit at the dedup check instead of inserting a second message.

The bootstrap path includes the persisted system message as `lastMessage` in its `dm_channel_created` broadcast, so sidebar preview and unread anchors use the same message ID across all instances.

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
| `upsertCopy(origin, channel, keySource)` (`dmConversations.ts`) | Adds or replaces the copy of a conversation from one origin under its key; `dmChannels`, `channelOriginMap` and the alternatives index are derived from the conversations, not written directly. Returns the pinned copy's channel id |
| `removeDmChannel(id)` | Filters from `dmChannels`, cleans up unread/read state via `chatStore.removeChannelStates()` |
| `addDmMember(dmChannelId, user)` | Appends user to channel's `members` array (dedup by ID) |
| `removeDmMember(dmChannelId, userId)` | Filters user from channel's `members` array (reused for kick) |
| `updateDmOwner(dmChannelId, newOwnerId)` | Updates `ownerId` on the channel (reused for manual transfer) |
| `updateDmMetadata(dmChannelId, { name, icon })` | Patches `name`/`icon` on the channel; called by the `dm_channel_updated` WS handler |
| `closeDm(id)` | Calls `api.dm.close(id)` via origin-aware API client, removes from state |
| `leaveDm(id)` | Calls `api.dm.leave(id)` via origin-aware API client, removes from state |
| `findExistingDmForUser(targetUser)` | Scans `dmChannels` for a 2-member DM where the other member's `homeUserId` matches the target's `homeUserId` |
| `upsertUserView(user, deliveringOrigin)` | Inserts/updates the user-view cache under the home-wins preference rule. Called for every DM member surface (kept AND skipped channels) so render sites surface the home view even when first-wins channel dedup discarded the home payload. See `client-federation.md` §3 "User View Cache" |

#### Owner-Only Requests (`utils/groupDmOwnerActions.ts`)

`updateGroupDmMetadata(channelId, body)`, `kickFromGroupDm(channelId, member)` and `transferGroupDmOwnership(channelId, member)` are the only way the client makes owner-only group DM requests. Each goes to the owner's home instance (`getOwnerInstanceForDm(channelId)`, the channel's `ownerHomeInstance`), so the relay event it causes comes from the instance receivers accept it from, and names things as that instance's own copy does:

- the conversation by that instance's copy (`dmCopyIdOnOrigin`), since the row the client shows may be another instance's copy;
- the member by their local id when the owner's instance is the shown copy's, and otherwise by home identity: `homeUserId`/`homeInstance` for a member homed elsewhere, and the shown instance's id at its host for a member native to it. The API client's owner methods take this as a `DmMemberTarget`.

When the owner's instance is not connected, or does not list the conversation, the request is refused with `OwnerInstanceUnavailableError` (a translated `dm:ownerActions.*` message) and nothing is sent anywhere. `getOwnerInstanceForDm` is distinct from `getChannelOrigin`, the pinned serving origin; they diverge after a manual ownership transfer. Non-owner operations (message send, leave, close, typing, reactions, read-state acks) keep routing via `getChannelOrigin`.

### WebSocket Event Handlers (`useWebSocket.ts`)

| WS Event | Handler |
|----------|---------|
| `dm_channel_created` | Normalize remote user assets, upsert each member into `userViews`, add the copy through the DM merge module (`upsertCopy(origin, channel, 'stated')`, `dmConversations.ts`) |
| `dm_channel_closed` | Call `removeDmChannel(dmChannelId)` |
| `dm_channel_updated` | Call `updateDmMetadata(dmChannelId, { name, icon })` |
| `dm_member_added` | Normalize remote user assets, upsert into `userViews`, call `addDmMember(dmChannelId, user)` |
| `dm_member_removed` | Call `removeDmMember(dmChannelId, userId)` |
| `dm_owner_updated` | Call `updateDmOwner(dmChannelId, newOwnerId, newOwnerHomeUserId?, newOwnerHomeInstance?)` — the optional home-identity fields keep the channel's federation routing cache fresh after a manual transfer |
| `dm_message_created` / `dm_message_updated` | Normalize message assets, upsert `message.user` and `message.replyTo?.user` into `userViews` |

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
- Both requests go to `getFriendsHomeOrigin()` (`instanceStore.ts`): the instance whose friend list the server checks them against. That is the page's instance for a native account, and the connected true home for a federated account signed in to another instance (`erin@nova` on orbit), whose friendships with the home's own users exist only at home (#391; before, the request went to the page's instance, which answered `not_a_friend`). With no live session on the true home it is the page's instance, which applies the friendships it holds. The conversation is named by that instance's copy (`dmCopyOnOrigin`) and each person as that instance knows them (`personRequest(row, origin, home)`); a friend it cannot name (a legacy stub another instance issued) fails the request with "Failed to add members" before anything is sent. A created group is added as that instance's copy (`upsertDmCopy(home, …)`).
- Two creation paths:
  - **1-on-1 DM upgrade:** If `dmChannel.ownerId` is null, calls `createGroup()` with the existing other member + selected friends + `fromDmChannelId` (the home's copy, when it holds one)
  - **Existing group DM:** Calls `addMember()` sequentially for each selected friend on the home's copy; without one it fails with "Failed to add members"

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
| `POST` | `/api/dm/space-invite` | JWT | Send a space invite card to a friend via DM (see `docs/systems/spaces.md`) |
| `PATCH` | `/api/dm/:id` | JWT | Update group DM `name` and/or `icon` (owner-only). 1-on-1 DMs reject. See "Group Metadata Update" |
| `DELETE` | `/api/dm/:id` | JWT | Soft-close DM for caller |
| `DELETE` | `/api/dm/:id/members/:targetUserId` | JWT | Owner kicks a member from a group DM. Cannot kick self. 1-on-1 DMs reject |
| `POST` | `/api/dm/:id/transfer` | JWT | Owner transfers ownership to another current member without leaving. Body: `{ newOwnerId }` |
| `POST` | `/api/dm/:id/members` | JWT | Add member to group DM (any member). Accepts `{ userId }` or `{ homeUserId, homeInstance }` |
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

### DM Channel List

`GET /api/dm` returns the same entries as the `ready` payload's `dmChannels`: both call `loadOpenDmChannels()` (`utils/dmChannelWire.ts`). Every other emitter of a `DmChannel` (`dm_channel_created` on every path, the `POST /api/dm`, `POST /api/dm/group` and add-member payloads, re-attach) builds it with `loadDmChannelWire()`, which goes through the same `toDmChannelWire()`; without a message to deliver it uses the newest message's preview, so its payload equals the row's list entry. No `DmChannel` is built by hand. Every entry carries `id`, `federatedId`, `ownerId`, `ownerHomeUserId`, `ownerHomeInstance`, `createdAt`, `name`, `icon`, `metadataUpdatedAt`, `members` and `lastMessage`, with `null` (or `0` for `metadataUpdatedAt`) where the channel has no value. In the shared `DmChannel` type every field is required, nullable where the row can be null, so a payload that leaves one out does not compile. The last-message lookup is chunked by channel ids and runs as one grouped `MAX(created_at)` per chunk joined back to the rows, so any number of DMs stays under SQLite's limits and a long conversation costs one indexed pass, not one per message.

Servers up to 1.6.1 built the list by hand and left out `federatedId`, the owner identity, `name`, `icon` and `metadataUpdatedAt`. A client connected to both instances of a conversation re-reads an instance's list to place a channel id it has not seen (`reloadDmsForOrigin`), and without the key it showed that instance's mirrored copy as a second row, once per conversation the instance mirrors. `reloadDmsForOrigin` still handles peers on those versions; see `client-federation.md` "WS event routing contract".

The list is sorted by `lastMessage.createdAt` descending (newest activity first), falling back to `channel.createdAt` for channels with no messages.

---

## WebSocket Events

For full wire formats, see `docs/systems/websocket.md`.

### State-Change Events

| Event | Direction | Triggered By |
|-------|-----------|-------------|
| `dm_channel_created` | S->C | Group DM create and bootstrap, added member, reopen of a closed membership (including the first message of a new 1-on-1 for its recipient) |
| `dm_channel_closed` | S->C | User closes DM, user leaves group |
| `dm_channel_updated` | S->C | Group metadata (`name`/`icon`) updated; payload `{ dmChannelId, name, icon }` (no `metadataUpdatedAt` — server-side version vector only) |
| `dm_member_added` | S->C | Incremental member add (not bootstrap) |
| `dm_member_removed` | S->C | Member leave/kick |
| `dm_owner_updated` | S->C | Ownership transfer (auto on owner-leave OR manual via `POST /api/dm/:id/transfer`). Payload: `{ dmChannelId, newOwnerId, newOwnerHomeUserId?, newOwnerHomeInstance? }` — the home-identity fields are populated on every new emission so the client can keep `dmChannel.ownerHomeInstance` (and thus `getOwnerInstanceForDm` routing) in sync without waiting for a `ready` refresh. Receivers tolerate omission for legacy senders. |

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
| Duplicated membership system messages across restarts | 4× "Heidi added erin" in group DM, channel keeps flipping to unread after each deploy | Membership event processors inserted system messages unconditionally. Each approval-flow re-peering reset peer `last_synced_at = 0`, so initial sync replayed every historical `member_add` / `member_remove` / `ownership_transfer` on next boot. Each replay's new snowflake ID exceeded the user's `read_states.last_read_message_id`, flipping unread. | Dedup by `(sourceInstance, event.messageId)` on the inserted system message. Both bootstrap and incremental paths in `processMemberAddEvent` now persist these fields so replay is a no-op. |
| Raw JSON in DM sidebar previews | DM sidebar showed `{"event":"space_invite",...}` / `{"event":"member_added",...}` as the last-message preview | `DmLastMessagePreview` shape omitted `type`, so the client could not distinguish system from user messages and rendered `lastMessage.content` verbatim. | Added `type` to `DmLastMessagePreview`, populated it from `dm_messages.type` in every server emission site, and routed the sidebar through a single `formatDmSidebarPreview` helper that renders human-readable text for each system event. |
| Owner-only requests routed to wrong instance after manual transfer (latent) | After `POST /api/dm/:id/transfer` moved ownership to a member whose `homeInstance` differed from the channel's pinned serving origin, owner-only client calls (`updateMetadata`, `kickMember`, `transferOwnership`) routed via `getChannelOrigin` would emit outbox events with `sourceInstance !== ownerHomeInstance`, and all peers would reject them as `attribution_mismatch`. Latent only because pre-polish there was no kick endpoint and no metadata edit; auto-transfer-on-leave masked the issue (the leaver IS the actor, and `member_remove reason='leave'` accepts any source). | Added `getOwnerInstanceForDm(channelId)` exported next to `getChannelOrigin`. All four owner-only API client methods (`updateMetadata`, `kickMember`, `transferOwnership` — and any future owner-only routes) call `getApiForOrigin(getOwnerInstanceForDm(channelId))` instead of channel origin. Non-owner operations are unchanged. |
| Kick / transfer to federated member always failed with "user not a member" | `DELETE /api/dm/:id/members/:targetUserId` and `POST /api/dm/:id/transfer` accepted only a local user id. The client passed `canonical.id` from `useCanonicalUserView`, which returns the user's HOME id when the home view is cached. After owner-routing the request to the owner instance, the owner instance's `dm_members.userId` (its own local replicated id) never matched the home id, so `isDmMember` returned false. | Both endpoints now accept federated identification (`homeUserId` + `homeInstance`) — the transfer endpoint takes them in the body, the kick endpoint reads `homeInstance` from a query string and treats the URL segment as a homeUserId. Server resolves via `resolveOrCreateReplicatedUser` before membership check. Mirrors the `addDmMember` pattern. Client `kickMember` / `transferOwnership` accept an optional `federated` arg and pass it when the target has `homeUserId` + `homeInstance` populated. |
| Ownership transfer back-and-forth diverged between instances | After A→B transfer succeeded, B→A was applied locally but rejected by A's peer with `unauthorized_source`; ownership permanently disagreed between instances. Compounded by the client never updating its in-memory `dmChannel.ownerHomeInstance` from the `dm_owner_updated` WS event, so `getOwnerInstanceForDm` returned the previous owner's origin after the WS broadcast (relevant only if the same session re-attempts an owner-only op). | Two compounding bugs: (1) `transferGroupDmOwnership` wrote `users.homeInstance` verbatim into `dm_channels.ownerHomeInstance` — a BARE host (`orbit.ddns.net`) for federated owners. (2) `processOwnershipTransferEvent` (and `processMemberRemoveEvent` for kicks) compared `sourceInstance` (always full URL) to `channel.ownerHomeInstance` with strict string equality, mis-firing on the bare-vs-full mismatch. (3) `dm_owner_updated` WS event omitted `newOwnerHomeUserId` / `newOwnerHomeInstance`, so the client couldn't refresh its routing cache after a successful transfer. | (a) Both authority checks now compare via `normalizeOriginForCompare`. (b) Every write site that persists `dm_channels.ownerHomeInstance` (`transferGroupDmOwnership`, `POST /api/dm/group` post-create federation, lazy federation in `POST /api/dm/:id/members`, `processMemberAddEvent` bootstrap, `processOwnershipTransferEvent` receiver storage) canonicalizes through a new `canonicalizeHomeInstance` helper in `federationAuth.ts` — full URL is the canonical storage form, matching how `sourceInstance` always arrives. (c) `dm_owner_updated` WS event was extended with optional `newOwnerHomeUserId` and `newOwnerHomeInstance` fields, and the client `updateDmOwner` action writes them when present (guarding against legacy senders by leaving the existing values untouched if omitted). |
