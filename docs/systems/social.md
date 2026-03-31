# Social & Friends System

Source files:
- `packages/server/src/routes/social.ts` -- Friend requests, friend list, unfriend, user discovery, user search
- `packages/server/src/routes/users.ts` -- User profile CRUD, mutuals endpoint (`GET /users/:id/mutuals`)
- `packages/web/src/stores/socialStore.ts` -- Client-side friend/request state with cross-instance loading and origin tagging
- `packages/web/src/stores/discoverStore.ts` -- Client-side user discovery with multi-instance fan-out
- `packages/web/src/components/chat/FriendsPage.tsx` -- Friends page UI: tabs (Online/All/Pending/Add Friend/Activity), discover grid, search
- `packages/web/src/components/modals/UserProfileModal.tsx` -- Profile modal with friendship actions and mutual display
- `packages/web/src/utils/mutuals.ts` -- Cross-instance mutual friend/space loading with dedup
- `packages/web/src/utils/identity.ts` -- Federated identity helpers (parseFederatedUsername, isSelf, canonicalUserMatch)
- `packages/web/src/hooks/useWebSocket.ts` -- WS event handlers for social events (friend_request_received, etc.)
- `packages/server/src/routes/federation.ts` -- Inbound friend relay event processors (5 functions)
- `packages/server/src/utils/federationOutbox.ts` -- `buildFriendContextId()`, `getFriendEventTargets()`
- `packages/server/src/utils/federationWorker.ts` -- Initial sync friend backfill for new peers

DB tables: `friends`, `friend_requests`, `users` (discoverable, homeInstance, homeUserId fields).
See `docs/systems/database.md` for full schemas.

---

## 1. Friend Request Lifecycle

### State Machine

```
                    sender creates
  (none) ────────────────────────► pending
                                     │
                   ┌─────────────────┼──────────────────┐
                   │                 │                   │
              recipient          recipient           sender
              accepts            declines            cancels
                   │                 │                   │
                   ▼                 ▼                   ▼
               accepted          declined          (row deleted)
                   │
                   ▼
             friends row
              inserted
```

### REST Endpoints

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| `GET` | `/api/social/friends` | List all friends | JWT |
| `GET` | `/api/social/requests` | List pending friend requests | JWT |
| `POST` | `/api/social/requests` | Send a friend request | JWT |
| `PATCH` | `/api/social/requests/:id` | Accept or decline | JWT |
| `DELETE` | `/api/social/requests/:id` | Cancel outgoing request | JWT |
| `DELETE` | `/api/social/friends/:id` | Remove a friend | JWT |
| `GET` | `/api/social/discover` | Discover users | JWT, rate-limited 30/min |
| `GET` | `/api/social/search` | Search users by name | JWT, rate-limited 30/min |

See `docs/systems/api.md` for full endpoint signatures.

---

### Send Friend Request (`POST /api/social/requests`)

**Input:** `{ username: string }`

**Validation chain:**
1. Username must be non-empty
2. Lookup target user by exact username match: `users.username = body.username`
3. **Self-friendship prevention:** `targetUser.id === request.userId` returns 400
4. **Already friends check:** Checks `friends` table in both directions (userId/friendId and friendId/userId)
5. **Duplicate request check:** Checks `friend_requests` for any pending request between the two users in either direction

**On success:**
1. Generates snowflake ID, inserts into `friend_requests` with `status='pending'`
2. **WS broadcast:** `friend_request_received` sent to target user with full request payload including sender profile
3. **Federation relay:** If either user is federated, queues `friend_request_create` event (see Section 6)
4. Returns `{ success: true, requestId: string }`

### Accept/Decline (`PATCH /api/social/requests/:id`)

**Input:** `{ status: 'accepted' | 'declined' }`

**Authorization:** Only the recipient (`request.toId === userId`) can accept or decline.

**Accept path:**
1. **Transaction:** Inserts `friends` row (fromId -> userId, toId -> friendId) AND updates request status to `'accepted'`
2. **WS broadcast (after commit):** `friend_request_accepted` sent to the original sender with the accepting user's profile as a `Friend` object
3. **Federation relay:** Queues both `friend_request_update` (status=accepted) AND `friend_add` events

**Decline path:**
1. Updates request status to `'declined'` (no transaction needed, single write)
2. **WS broadcast:** `friend_request_declined` sent to the original sender with `{ requestId, userId }`
3. **Federation relay:** Queues `friend_request_update` (status=declined)

### Cancel (`DELETE /api/social/requests/:id`)

**Authorization:** Only the sender (`request.fromId === userId`) can cancel.

**Validation:** Request must be in `'pending'` status.

**Actions:**
1. **Deletes** the request row (not a status update -- full deletion)
2. **WS broadcast:** `friend_request_cancelled` sent to the recipient
3. **Federation relay:** Queues `friend_request_cancel` event

### Remove Friend (`DELETE /api/social/friends/:id`)

**Path parameter:** `:id` is the friend's user ID (not the friendship row ID).

**Actions:**
1. Verifies friendship exists by checking both directions in `friends` table
2. **Deletes** the friendship row in both directions (single WHERE with OR)
3. **WS broadcast:** `friend_removed` sent to the other user with `{ userId: callerUserId }`
4. **Federation relay:** Queues `friend_remove` event

---

## 2. Friend List & Request List

### GET /api/social/friends

Queries `friends` table where the authenticated user is either `userId` or `friendId`. Extracts the other user's ID from each row, fetches full user records, and returns as `Friend[]` with `addedAt` timestamp from the friendship row's `createdAt`.

### GET /api/social/requests

Queries `friend_requests` with `status='pending'` where the authenticated user is either `fromId` or `toId`. Enriches each request with the **other** user's profile (the user who is NOT the requester). Returns as `FriendRequest[]`.

---

## 3. User Discovery

### GET /api/social/discover

**Query params:** `q` (search term), `limit` (1-100, default 24), `offset` (default 0)

**Filters (WHERE clause):**
1. `discoverable = 1` -- user must opt into discovery
2. `isDeleted = 0` -- exclude tombstoned accounts
3. `id != myId` -- exclude self
4. `homeInstance IS NULL OR homeInstance = ''` -- **exclude replicated federated stubs** (each instance only surfaces its own native users; federated users are discovered via the parallel fan-out from the client)
5. If `q` provided: LIKE match on `username` or `displayName` with `%q%` pattern

**Pre-loaded social graph (single query each):**
- My friend IDs (from `friends` table, both directions)
- My space IDs (from `space_members`)
- Outbound pending requests (Map: toId -> requestId)
- Inbound pending requests (Map: fromId -> requestId)

**Batch optimization:** For the page of results, fetches ALL friends and space memberships for all page users in two bulk queries (using `inArray`), then builds per-user Sets for intersection computation.

**Per-user computation:**
- `mutualFriendCount`: intersection of my friends and their friends
- `mutualSpaceCount`: intersection of my spaces and their spaces
- `relationship`: one of `'none'` | `'friends'` | `'outbound_pending'` | `'inbound_pending'`
- `requestId`: set when relationship is `outbound_pending` or `inbound_pending`

**Sort:** `mutualFriendCount DESC`, then `createdAt DESC`

**Response:** `{ users: DiscoverUser[], total: number }`

### GET /api/social/search

**Query params:** `q` (min 1 character)

Simpler than discover: LIKE match on `username` or `displayName`, excludes self, limit 10. Returns `User[]` (no mutual counts, no relationship enrichment). Does **not** filter by `discoverable` or exclude replicated users.

---

## 4. Mutuals

### GET /api/users/:id/mutuals

**Query params:** `homeUserId` (optional, for federation fallback)

**Target resolution:** Tries path param `:id` first. If no user found and `homeUserId` query param is provided, falls back to matching `users.homeUserId = homeUserId` OR `users.id = homeUserId`. This handles cases where the caller has a remote user's home ID but not their local replicated stub ID.

**Mutual friends:** Fetches all friend rows for both the caller and the target (both directions), extracts friend IDs into Sets, computes intersection. Fetches full `User` records for the mutual friend IDs.

**Mutual spaces:** Fetches all `space_members` rows for both the caller and the target, computes intersection of space IDs. Fetches `{ id, name, icon, avatarColor }` for mutual spaces.

**Response:** `{ mutualFriends: User[], mutualSpaces: { id, name, icon, avatarColor }[] }`

---

## 5. WebSocket Events

All social WS events are documented in `docs/systems/websocket.md`. Summary:

### Server -> Client

| Event | Payload | Recipient | When |
|-------|---------|-----------|------|
| `friend_request_received` | `{ request: FriendRequest }` | Target user | Request created |
| `friend_request_accepted` | `{ friend: Friend, requestId }` | Original sender | Request accepted |
| `friend_request_declined` | `{ requestId, userId }` | Original sender | Request declined |
| `friend_request_cancelled` | `{ requestId, userId }` | Target user | Sender cancelled |
| `friend_removed` | `{ userId }` | Other user | Unfriended |

### user_updated Broadcast (profile changes)

When profile fields change on `PATCH /api/users/@me`, a `user_updated` event is broadcast to a **deduplicated** set of targets:
1. All online users who share a space with the updated user
2. All co-members of any DM channel the user is in
3. All friends of the user (from `friends` table, both directions)
4. The user themselves (for multi-tab sync)

This ensures friends always see real-time profile updates (avatar, display name, bio, status, etc.).

---

## 6. Federation: Friend Relay

### Overview

Cross-instance friend operations use 5 relay event types with `contextType: 'friend'`. The federation relay mechanism (outbox, delivery, HMAC signing) is documented in `docs/systems/federation.md`. This section covers the **application logic** specific to friend events.

### Event Types

| eventType | Trigger | Authority | Relay Direction |
|-----------|---------|-----------|-----------------|
| `friend_request_create` | POST /api/social/requests | Sender's home instance | Sender -> Recipient's instance |
| `friend_request_update` | PATCH /api/social/requests/:id | Recipient's home instance | Recipient -> Sender's instance |
| `friend_request_cancel` | DELETE /api/social/requests/:id | Sender's home instance | Sender -> Recipient's instance |
| `friend_add` | PATCH /api/social/requests/:id (accepted) | Recipient's home instance | Recipient -> Sender's instance |
| `friend_remove` | DELETE /api/social/friends/:id | Either side's instance | Remover -> Other's instance |

### Relay Payload Structure

All friend events use the `friendship` field of `FederationRelayEvent`:

```typescript
interface FederationFriendshipPayload {
  from: { homeUserId: string; homeInstance: string };  // Request sender
  to: { homeUserId: string; homeInstance: string };    // Request recipient
  fromProfile?: FederationRelayProfileSnapshot;        // Sender's profile data
  toProfile?: FederationRelayProfileSnapshot;          // Recipient's profile data
  status?: 'pending' | 'accepted' | 'declined';       // Request status (omitted for add/remove/cancel)
  createdAt: number;                                    // Epoch ms
}
```

Profile snapshots (`FederationRelayProfileSnapshot`) carry `{ username, displayName, avatar, avatarColor, banner, bio }` for hydrating replicated user stubs on the receiving instance.

### Identity Resolution for Relay

When building a relay event, each user's identity is resolved as:

```typescript
const identity = {
  homeUserId: user.homeUserId || user.id,      // Canonical ID (local users have homeUserId=null)
  homeInstance: user.homeInstance || getOurOrigin(), // Full URL for local users
};
```

### Target Peer Selection (`federationOutbox.ts:getFriendEventTargets`)

```typescript
function getFriendEventTargets(fromHomeInstance, toHomeInstance): string[] {
  const ourOrigin = getOurOrigin();
  const targets = new Set<string>();
  if (fromHomeInstance && fromHomeInstance !== ourOrigin) targets.add(fromHomeInstance);
  if (toHomeInstance && toHomeInstance !== ourOrigin) targets.add(toHomeInstance);
  return Array.from(targets);
}
```

Returns empty array if both users are local (no relay needed). Returns one or two peer origins if one or both users are federated.

### Context ID for Friend Events (`federationOutbox.ts:buildFriendContextId`)

```typescript
function buildFriendContextId(homeUserIdA: string, homeUserIdB: string): string {
  const sorted = [homeUserIdA, homeUserIdB].sort();
  return `friend:${sorted[0]}:${sorted[1]}`;
}
```

Deterministic and direction-independent. Used for outbox coalescing and mutation log grouping.

### Entity ID Format

Friend events use two entity ID patterns:
- **Requests:** `friend_req:{sorted_homeUserIds}:{timestamp}` -- e.g., `friend_req:abc:xyz:1711619400000`
- **Friendships:** `friend:{sorted_homeUserIds}:{timestamp}` -- e.g., `friend:abc:xyz:1711619400000`

The sorted join ensures the same pair always produces the same prefix regardless of direction.

---

### End-to-End Relay Flow: Friend Request Create

**Outbound (origin instance -- `social.ts:POST /api/social/requests`):**
1. Friend request created locally (DB insert + WS broadcast to local recipient)
2. Build identity objects for sender and recipient using `homeUserId || id` / `homeInstance || getOurOrigin()`
3. Call `getFriendEventTargets(from.homeInstance, to.homeInstance)` -- if both local, returns `[]` (no relay)
4. Build `FederationRelayEvent` with `eventType: 'friend_request_create'`, `contextType: 'friend'`, friendship payload including both identities and profile snapshots
5. Call `appendMutationLog()` -- records in `federation_mutation_log` for sync protocol
6. Call `queueOutboxEvent()` -- inserts into `federation_outbox` for each target peer

**Delivery (federation worker -- `federationWorker.ts:processOutboxTick`):**
1. Worker polls outbox every 10 seconds
2. Groups pending entries by peer, builds batch `FederationRelayRequest`
3. Signs with HMAC, POSTs to `{peerOrigin}/api/federation/relay`
4. On success: deletes outbox entries. On failure: exponential backoff retry.

**Inbound (receiving instance -- `federation.ts:processFriendRequestCreateEvent`):**
1. **Validate:** `event.friendship` must exist, `from.homeInstance === sourceInstance` (authority check)
2. **Resolve sender:** `resolveOrCreateReplicatedUser(from.homeUserId, from.homeInstance)` -- creates stub if needed
3. **Hydrate sender profile:** `hydrateReplicatedUserProfile(fromUser, event.friendship.fromProfile)` -- updates stub fields
4. **Resolve recipient:** `resolveLocalUser(to.homeUserId)` -- must be a native user on this instance (returns `undefined` if not found -> reject)
5. **Idempotency checks:** If already friends -> accept as no-op. If pending request already exists from same sender -> accept as no-op.
6. **Create request:** Insert `friend_requests` row with local IDs
7. **WS broadcast:** `friend_request_received` sent to local recipient with sender's sanitized profile
8. Push `event.messageId` to accepted array

### End-to-End Relay Flow: Friend Request Update (Accept/Decline)

**Outbound (`social.ts:PATCH /api/social/requests/:id`):**
1. Local request status updated (+ friendship row if accepted)
2. Queues `friend_request_update` with `status: 'accepted' | 'declined'`
3. If accepted, also queues `friend_add` event (two separate outbox entries)

**Inbound (`federation.ts:processFriendRequestUpdateEvent`):**
1. **Authority:** `to.homeInstance === sourceInstance` -- the recipient's instance sends the update
2. **Resolve sender:** `resolveLocalUser(from.homeUserId)` -- must be local (they sent the original request from this instance)
3. **Resolve recipient:** `resolveOrCreateReplicatedUser(to.homeUserId, to.homeInstance)` -- create stub if needed
4. **Find pending request:** Matches `fromId = fromUser.id`, `toId = toUser.id`, `status = 'pending'`
5. If no pending request found -> accept idempotently (friend_add may have arrived first)
6. Update request status
7. **WS broadcast:** `friend_request_accepted` (with Friend payload) or `friend_request_declined` sent to local sender

### End-to-End Relay Flow: Friend Request Cancel

**Outbound (`social.ts:DELETE /api/social/requests/:id`):**
1. Local request deleted
2. Queues `friend_request_cancel`

**Inbound (`federation.ts:processFriendRequestCancelEvent`):**
1. **Authority:** `from.homeInstance === sourceInstance` -- the sender cancels their own request
2. **Resolve both users:** `resolveLocalUser()` for both -- if either doesn't exist, accept idempotently
3. Find and **delete** the pending request row
4. **WS broadcast:** `friend_request_cancelled` to local recipient

### End-to-End Relay Flow: Friend Add

**Outbound:** Queued alongside `friend_request_update` (accepted) from `social.ts:PATCH`.

**Inbound (`federation.ts:processFriendAddEvent`):**
1. **Authority:** `to.homeInstance === sourceInstance` -- the accepting side creates the friendship
2. **Resolve both users:** `resolveOrCreateReplicatedUser()` for both, hydrate profiles from snapshots
3. **Idempotency:** If friendship row already exists, accept as no-op
4. Insert `friends` row
5. **Auto-resolve pending requests:** Updates any pending request between these users to `'accepted'` (handles friend_add arriving before friend_request_update due to delivery ordering)
6. **Determine local user:** Compare `from.homeInstance` against `getOurOrigin()` to find who is local
7. **WS broadcast:** `friend_request_accepted` sent to local user with remote user's profile (uses empty string for `requestId` since the original request may not exist locally yet)

### End-to-End Relay Flow: Friend Remove

**Outbound (`social.ts:DELETE /api/social/friends/:id`):**
1. Local friendship deleted
2. Queues `friend_remove`

**Inbound (`federation.ts:processFriendRemoveEvent`):**
1. **Authority:** Either `from.homeInstance === sourceInstance` OR `to.homeInstance === sourceInstance` (either side can unfriend)
2. **Resolve both users:** `resolveLocalUser()` for both -- if either doesn't exist, accept idempotently
3. Delete friendship row in both directions
4. **Determine who was removed:** The removing user is on `sourceInstance`; broadcast `friend_removed` to the **other** (local) user

---

## 7. Initial Sync: Friend Backfill

When a new peer is established (`federation_peers.lastSyncedAt = 0`), the federation worker runs `runInitialSyncForNewPeers()` on startup. This includes a dedicated friend sync pass.

**Flow (`federationWorker.ts:runInitialSyncForNewPeers`):**

1. Query all active peers with `lastSyncedAt = 0`
2. **First pass (DM events):** Paginates through `POST /federation/sync` with no `contextType` filter (defaults to DM events), relaying each batch through the local `/api/federation/relay` endpoint
3. **Second pass (friend events):** Paginates through `POST /federation/sync` with `contextType: 'friend'`, same relay-to-self pattern
4. After both passes complete, updates `lastSyncedAt = Date.now()` so the sync doesn't repeat

The sync endpoint (`POST /api/federation/sync`) returns events from the `federation_mutation_log` table, which retains entries for 90 days. This means friend relationships established within the last 90 days are backfilled when a new peer connection is created.

---

## 8. Client-Side: socialStore

Source: `packages/web/src/stores/socialStore.ts`

### Origin Tagging

All friends and requests are tagged with `_instanceOrigin: string` (empty string = home instance, full URL = remote instance). This enables the store to track which API client to use for mutations and to disambiguate users with the same local ID on different instances.

```typescript
type TaggedFriend = Friend & { _instanceOrigin: string };
type TaggedFriendRequest = FriendRequest & { _instanceOrigin: string };
type TaggedUser = User & { _instanceOrigin: string };
```

### Cross-Instance Friend Loading (`loadFriends`)

1. Gets connected instances from `instanceStore`
2. Fires `Promise.allSettled()` with:
   - Home instance: `api.social.friends()`
   - Each connected remote instance: `inst.api.social.friends()`
3. **Deduplication:** Uses a `Set<string>` keyed by `${friend.id}:${origin}` -- prevents duplicates within the same instance
4. **Asset normalization:** For remote-origin friends, calls `normalizeUserAssets(friend, origin)` to resolve relative avatar/banner URLs to absolute remote URLs
5. Stores the merged, tagged array as `friends`

### Cross-Instance Request Loading (`loadRequests`)

Same `Promise.allSettled()` fan-out pattern as `loadFriends`, with same dedup key: `${request.id}:${origin}`. Normalizes assets for remote request user profiles.

### Sending Friend Requests (Federation Routing)

`sendFriendRequest(username: string)` handles the `user@domain` routing:

1. **No `@` in username:** Send to home instance API directly
2. **`@` present:** Extract `baseName` and `domain` via `lastIndexOf('@')`
   - If domain matches `window.location.host`: strip domain, send to home API
   - Otherwise: find matching connected instance by comparing `new URL(inst.origin).host === domain`
     - **Not found:** Throw `InstanceNotConnectedError(domain)` (UI prompts to connect)
     - **Found but disconnected:** Throw `InstanceDisconnectedError(domain)` (UI prompts to reconnect)
     - **Found and connected:** Send to remote instance API with just the `baseName` (no domain suffix)
3. After success, reloads requests via `loadRequests()`

### Cross-Instance Search (`searchUsers`)

1. Fires parallel searches to home + all connected instances
2. **Deduplication by canonical identity:** Uses `Map<string, number>` keyed by `user.homeUserId ?? user.id`
   - First occurrence wins, but **native profiles replace replicated stubs**: if a native profile (`homeUserId` is null) is found for a canonical ID that was previously seen as a replicated stub, it replaces the entry
   - This ensures the user sees the "real" profile rather than a replicated copy

### Instance API Resolution (`getApiForOrigin`)

```typescript
function getApiForOrigin(origin: string) {
  if (!origin) return api;  // Home instance
  const instance = useInstanceStore.getState().instances.find(i => i.origin === origin);
  return instance?.api ?? api;  // Fallback to home if not found
}
```

Used by `updateFriendRequest`, `cancelFriendRequest`, and `removeFriend` to route mutations to the correct instance.

### WS Event Handlers

From `useWebSocket.ts`, social events are dispatched to store methods:

| WS Event | Store Method | Effect |
|----------|-------------|--------|
| `friend_request_received` | `addIncomingRequest(request, origin)` | Appends to requests (dedup check by `id:origin`) |
| `friend_request_accepted` | `addFriendFromAccepted(friend, requestId, origin)` | Appends to friends, removes matching request |
| `friend_removed` | `removeFriendLocally(userId, origin)` | Filters friend out by `id` + `origin` |
| `friend_request_cancelled` | `removeRequestById(requestId, origin)` | Filters request out by `id` + `origin` |
| `friend_request_declined` | `removeRequestById(requestId, origin)` | Filters request out by `id` + `origin` |

All handlers also update `discoverStore` relationship state via lazy import.

### Live Updates

| WS Event | Store Method | Effect |
|----------|-------------|--------|
| `presence_update` | `updateFriendPresence(userId, status)` | Updates `status` field on matching friend by ID (all origins) |
| `user_updated` | `updateFriendProfile(user)` | Updates displayName, avatar, banner, accentColor, avatarColor, bio, customStatus, status on matching friend by ID |

---

## 9. Client-Side: discoverStore

Source: `packages/web/src/stores/discoverStore.ts`

### Federation-Aware Initialization Guard

`fetchUsers()` includes a critical guard that waits for `instanceStore._autoConnectDone` before proceeding:

```typescript
if (!useInstanceStore.getState()._autoConnectDone) {
  await new Promise<void>((resolve) => {
    const unsub = useInstanceStore.subscribe((state) => {
      if (state._autoConnectDone) { unsub(); resolve(); }
    });
    // Double-check (race condition guard)
    if (useInstanceStore.getState()._autoConnectDone) { unsub(); resolve(); }
  });
}
```

This ensures the discover page doesn't fire requests before all remote instance connections are established, which would miss remote users.

### Multi-Instance Fan-Out

1. Fires `Promise.allSettled()` to home + all connected instances' `api.social.discover(query)`
2. Tags each user with `_instanceOrigin`
3. **Deduplication:** By `${user.id}:${origin}` -- since the server already excludes replicated stubs from discover results, cross-instance dedup is minimal (only needed for edge cases)
4. Sums `total` from all instances
5. **Error handling:** If no instances respond, sets error `'Failed to reach any instance for discovery'`

### State Shape

```typescript
interface DiscoverState {
  users: TaggedDiscoverUser[];   // Origin-tagged discover users
  searchQuery: string;           // Current search term
  isLoading: boolean;
  total: number;                 // Sum across all instances
  error: string | null;
}
```

### Relationship Updates

`updateRelationship(userId, origin, relationship, requestId?)` -- Updates a specific user's relationship status in-place. Called from:
- `UserDiscoverCard` after sending/cancelling/accepting friend requests
- WS event handlers (friend_request_accepted, friend_removed, friend_request_cancelled, friend_request_declined)

---

## 10. Client-Side: Mutuals

Source: `packages/web/src/utils/mutuals.ts`

### `loadFederatedMutuals(targetUserId, targetHomeUserId?)`

Follows the same `Promise.allSettled()` fan-out pattern:

1. Computes `canonicalHomeId = targetHomeUserId ?? targetUserId`
2. Fires `api.users.getMutuals(targetUserId, canonicalHomeId)` to home + all connected instances
3. **Friend dedup:** By canonical identity `friend.homeUserId ?? friend.id` (prevents the same friend appearing from multiple instances)
4. **Space dedup:** By `${space.id}:${origin}` (spaces on different instances are distinct entities)
5. **Asset normalization:** Remote-origin friend avatars and space icons are resolved to absolute URLs

### Types

```typescript
type TaggedMutualFriend = User & { _instanceOrigin: string };
interface MutualSpace {
  id: string;
  name: string;
  icon: string | null;
  avatarColor: string | null;
  _instanceOrigin: string;
}
```

---

## 11. Client-Side: Identity Utilities

Source: `packages/web/src/utils/identity.ts`

### `parseFederatedUsername(username)`

Splits `"youruser@nova.ddns.net"` into `{ baseName: "youruser", domain: "nova.ddns.net" }`. Uses `indexOf('@')` (first occurrence). Returns `{ baseName: username, domain: null }` for non-federated usernames.

### `isSelf(user, homeUser)`

Determines if a user object represents the current user (including cross-instance replicas):
1. Same `id` -> true
2. `user.id` in `_knownSelfIds` set (populated from WS `ready` events) -> true
3. `user.homeInstance === window.location.host` AND base username matches -> true

### `canonicalUserMatch(a, b)`

Federation-safe identity comparison with cascading strategies:
1. Same `id` -> true
2. `homeUserId` cross-matching: `a.homeUserId === b.homeUserId`, or `a.homeUserId === b.id`, or `b.homeUserId === a.id` -> true
3. **Username + homeInstance fallback:** Parse base names, compare home instances (accounting for null = local)

Used by `UserProfileModal:getFriendshipStatus()` to find the correct friend/request for a viewed user across instances.

---

## 12. FriendsPage UI

Source: `packages/web/src/components/chat/FriendsPage.tsx`

### Tabs

| Tab | Content | Key Behavior |
|-----|---------|--------------|
| Online | Online friends only | Filters by `status !== 'offline'` |
| All | Complete friend list | No filter |
| Pending | Incoming + outgoing requests | Split into sections; incoming shows badge count in tab |
| Add Friend | Search + discover grid | Unified search/discover with direct-add |
| Activity | Friends grouped by activity | Active (rich presence) / Online (no activity) / Offline sections |

### Add Friend Tab: Dual-Mode Search

The Add Friend tab merges search and discovery into a single UI:

1. **Empty query:** Shows discover grid (from `discoverStore.fetchUsers()`, loaded on mount)
2. **Query entered:** Switches to search mode (debounced 300ms, uses `socialStore.searchUsers()`)
3. **Direct Add detection:** If query contains `@` (at non-edge position), shows a "Send friend request to user@domain" action row

### Search Result Enrichment

Raw search results (`User[]`) are enriched at render time into `TaggedDiscoverUser[]` by checking against the current `friends` and `requests` arrays in `socialStore`:
- If friend -> `relationship: 'friends'`
- If outbound pending request -> `relationship: 'outbound_pending'` with `requestId`
- If inbound pending request -> `relationship: 'inbound_pending'` with `requestId`
- Otherwise -> `relationship: 'none'`

Self-exclusion uses a precomputed `Set<string>` of `${id}:${origin}` for the current user across all connected instances.

### UserDiscoverCard

Renders a card with banner, avatar, display name, username, bio, mutual counts, instance badge (for remote users), and a context-sensitive action button:
- `none`: "Send Friend Request"
- `outbound_pending`: "Request Pending" (click to cancel)
- `inbound_pending`: "Accept" / "Decline" buttons
- `friends`: "Message" button

When sending a request to a remote user, constructs `baseName@originHost` format for the username. Handles `InstanceNotConnectedError` / `InstanceDisconnectedError` by showing `ConnectInstanceModal`.

---

## 13. UserProfileModal

Source: `packages/web/src/components/modals/UserProfileModal.tsx`

### Friendship Status Resolution

Uses `getFriendshipStatus()` with `canonicalUserMatch()` for federation-safe matching:

```typescript
function getFriendshipStatus(viewedUser, currentUser, friends, requests): FriendshipStatus
  → { state: 'self' }              // isSelf() check
  | { state: 'friends', friend }   // canonicalUserMatch against friends list
  | { state: 'outbound_pending', request }  // request.user matches viewed user, user.id === toId
  | { state: 'inbound_pending', request }   // request.user matches viewed user, user.id === fromId
  | { state: 'none' }
```

### Tabs

| Tab | Content |
|-----|---------|
| About | Bio (rendered as Markdown: p, strong, em, a, br), Member Since date |
| Mutual Friends | Grid of mutual friends (from `loadFederatedMutuals`), clickable to navigate to their profile |
| Mutual Spaces | List of mutual spaces with icons, clickable to navigate to space |

### Action Buttons

Displayed in footer based on friendship state:
- Always: "Send Message" (opens/creates DM)
- `none`: "Add Friend"
- `outbound_pending`: "Cancel Request"
- `inbound_pending`: "Accept" + "Ignore" (decline)
- `friends`: "Remove Friend"

All actions route through `socialStore` methods, which handle instance routing via origin tags.

### Federation Support

- User profile is loaded via `getApiForOrigin(origin)` to fetch from the correct instance
- Banner/avatar URLs resolved through the correct API client for remote users
- Mutuals loaded via `loadFederatedMutuals()` with cross-instance fan-out
- Friend actions use `sendFriendRequest(user.username)` which handles `user@domain` routing
- `ConnectInstanceModal` shown when trying to add a friend on an unconnected instance

---

## 14. Data Types

### Friend (shared)

```typescript
interface Friend {
  id: string;
  username: string;
  displayName: string | null;
  avatar: string | null;
  banner: string | null;
  accentColor: string | null;
  avatarColor: AvatarColor | null;
  bio: string | null;
  status: UserStatus;
  customStatus: string | null;
  createdAt: number;
  addedAt: number;          // From friends.createdAt
  homeUserId: string | null;
  homeInstance: string | null;
}
```

### FriendRequest (shared)

```typescript
interface FriendRequest {
  id: string;
  fromId: string;
  toId: string;
  status: 'pending' | 'accepted' | 'declined';
  createdAt: number;
  user?: User;  // The OTHER party (sender for incoming, recipient for outgoing)
}
```

### DiscoverUser (shared)

```typescript
interface DiscoverUser {
  id: string;
  username: string;
  displayName: string | null;
  avatar: string | null;
  banner: string | null;
  avatarColor: AvatarColor | null;
  bio: string | null;
  status: UserStatus;
  customStatus: string | null;
  createdAt: number;
  homeInstance: string | null;
  homeUserId: string | null;
  mutualFriendCount: number;
  mutualSpaceCount: number;
  relationship: 'none' | 'friends' | 'outbound_pending' | 'inbound_pending';
  requestId?: string;
}
```
