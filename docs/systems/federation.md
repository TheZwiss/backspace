# Federation System (Server-to-Server)

> **Companion spec:** This document covers **S2S (server-to-server)** federation — the relay protocol, HMAC auth, identity resolution, and background workers. For the **client-side** multi-instance architecture (how the web/desktop app connects to multiple instances, federated account creation, origin-aware routing), see [`client-federation.md`](client-federation.md). Both systems work together.

Source files:
- `packages/server/src/routes/federation.ts` -- API endpoints (peer handshake, relay, sync) + all inbound event processors + identity resolution functions
- `packages/server/src/utils/federationAuth.ts` -- HMAC signing, verification, header parsing, `getOurOrigin()`
- `packages/server/src/utils/federationOutbox.ts` -- Event queuing, coalescing, relay payload construction, mutation log, participant/target resolution
- `packages/server/src/utils/federationWorker.ts` -- Background workers: outbox delivery, file download, health check, janitor, initial sync
- `packages/server/src/utils/storageJanitor.ts` -- Federation GC: outbox expiry, mutation log retention, file queue cleanup, DM channel purge
- `packages/server/src/routes/social.ts` -- Friend request/accept/cancel/remove endpoints that queue federation events
- `packages/server/src/routes/dm.ts` -- DM REST endpoints that queue federation events (message relay, group lifecycle)
- `packages/server/src/ws/events.ts` -- WebSocket event handlers that queue DM message/reaction relay events
- `packages/web/src/utils/profileSync.ts` -- Client-side profile sync via LWW timestamps (not S2S relay)
- `packages/web/src/utils/identity.ts` -- Client-side federated identity resolution helpers

DB tables: `federation_peers`, `federation_outbox`, `federation_file_queue`, `federation_mutation_log`, plus `users` (identity), `dm_channels`/`dm_members`/`dm_messages` (DM federation), `friends`/`friend_requests` (friend federation), `attachments` (file replication).
See `docs/systems/database.md` for full schemas.

---

## Architecture Overview

Backspace federation is peer-to-peer with no central authority. Each instance maintains its own copy of all data. Peers exchange real-time events for DMs and friendships via a signed relay protocol.

**Canonical identity:** The `(homeUserId, homeInstance)` pair is globally unique. Local users have `homeInstance = NULL` and `homeUserId = NULL`. Federated users are represented as **replicated user stubs** -- minimal user records with `passwordHash = '!federation-replicated'` (bcrypt never produces this value, so login is impossible).

**Trust model:** Symmetric shared-secret HMAC. Both peers share the same 256-bit secret. Events are attributed to users by `homeUserId + homeInstance` in the payload, with authority checks verifying the source instance matches the claimed origin of the acting user.

---

## 1. Peer Handshake & Discovery

### 2-Phase Flow

**Phase 1 -- Initiate** (`POST /api/federation/peer/initiate`)
- Auth: JWT + admin role required
- Validates `remoteOrigin` is a well-formed HTTP(S) URL via `validateOrigin()`
- Prevents self-peering (`localOrigin === remoteOrigin`)
- Handles existing peers: active -> return 200, pending -> return 409, revoked -> delete and re-initiate
- Generates HMAC secret: `generateHmacSecret()` -> `randomBytes(32).toString('hex')` (256-bit)
- Generates challenge: `randomBytes(16).toString('hex')` (128-bit, currently unused by acceptor)
- Creates local peer record with `status='pending'`
- POSTs to `{remoteOrigin}/api/federation/peer/accept` with `{ sourceOrigin, challenge, hmacSecret }`
- Timeout: 10 seconds (`AbortSignal.timeout`)
- On remote 200 (accepted): updates local peer to `status='active'`, sets `lastSeenAt`, broadcasts `federation_peers_changed` to admin WS subscribers, returns 200 with `{ peer }`
- On remote 202 (queued for remote admin approval): transitions local peer to `status='awaiting_approval'` (does **not** activate), broadcasts `federation_peers_changed`, returns 202 with `{ peer }`. Without this branch `response.ok` would be true and the local peer would flip to `active` while the remote had us pending — a transient local-active / remote-pending split that only self-healed when the remote admin approved. Mirrors the auto-peer 202 branch in `federationPeering.ts:performHandshake`.
- On remote 403 / other non-2xx: deletes pending peer, returns 502 with the remote's error message
- On network error / timeout: deletes pending peer, returns 502 (network) or 504 (timeout)

**Phase 2 -- Accept** (`POST /api/federation/peer/accept`)
- Auth: **none** (first contact -- no JWT, no HMAC)
- Rate-limited: 10 requests per minute per IP (in-memory sliding window, buckets cleaned every 60s)
- Validates `sourceOrigin`, `challenge`, and `hmacSecret` from body
- Handles existing peers: active -> return 200 (idempotent), revoked -> return 403, pending -> update with new secret and activate
- New peer: creates record with provided `hmacSecret`, sets `status='active'`
- Returns `{ accepted: true }` on success

### Secret Storage & Rotation

Both instances store the **same** HMAC secret. The initiating instance generates it and sends it in the accept request.

**Rotation protocol:** Either peer (or automatically on a configurable interval, default 90 days) can trigger rotation:

1. Initiator generates a new secret, stores it as `pendingHmacSecret`, and POSTs to `{peer}/api/federation/peer/rotate` signed with the current secret
2. Acceptor verifies the HMAC, stores `pendingHmacSecret`, and returns `{ accepted: true }`
3. Both sides enter a 15-minute grace period where either secret is accepted for verification, while outbound requests are signed with the new secret
4. After the grace period, the health check worker promotes `pendingHmacSecret` → `hmacSecret` and clears the pending fields

**Conflict guard:** If `pendingHmacSecret` is already set, the rotate endpoint returns 409.

**Schema columns:** `pending_hmac_secret` (TEXT NULL), `secret_rotation_at` (INTEGER NULL), `secret_rotated_at` (INTEGER NULL), `auto_rotate_interval_days` (INTEGER NOT NULL DEFAULT 90).

### Peer Status Lifecycle

```
                     ensurePeered
  (none) ──────────► pending ──────────► active ──────► needs_attention
      ▲                │                   │ ▲              │
      │                │  remote 202       │ │              │ admin Reset
      │                ▼                   │ │              ▼
      │          awaiting_approval         │ │           (deleted)
      │                │                   │ │
      │    ┌───────────┼──────────┐        │ │ N consecutive
      │    │           │          │        │ │ auth failures (401/403)
      │  accept     denied     expired     │ │
      │  (fresh)    (admin)   (janitor)    │ │ delivery failures
      │    │           │          │        ▼ │
      │    ▼           ▼          ▼     unreachable
      │  active    rejected   rejected     │
      │                                    │ health check OK
      │  auto-peer rejected                ▼
      │  (403 PEERING_REQUIRES_APPROVAL) active
      └──────────────────────────── rejected
                                      │ admin revoke (active)
                                      ▼
                                   revoked
```

| Status | Outbox delivery | Health check | Relay accepts | Re-initiation | Admin clear |
|--------|----------------|--------------|---------------|---------------|-------------|
| `active` | Yes | No | Yes | No (returns existing) | N/A |
| `pending` | No | No | No | No (returns 409) | N/A |
| `awaiting_approval` | No | No | No | Returns pending; no re-handshake | Yes (admin deletes) |
| `unreachable` | No (entries wait) | Yes (1h interval) | Yes (resets to active) | No | N/A |
| `needs_attention` | No (entries bounded by TTL) | No | Yes (200 no-update, same as active) | No (admin must Reset first) | Yes (admin Reset deletes record) |
| `revoked` | No (entries purged) | No | No (returns 403) | Yes (old record deleted) | N/A |
| `rejected` | No | No | No | Yes (admin deletes record, then re-initiates) | N/A |

### PEER_UNREACHABLE_THRESHOLD

Defined in `federationWorker.ts:47` as `10`. After 10 consecutive delivery failures for a peer, the worker sets `status = 'unreachable'`. The health check worker (15-minute interval, matching `ROTATION_GRACE_PERIOD_MS`) pings `GET /api/instance/info` on unreachable peers and reverts to `active` on success.

### Auto-Peering

When the server needs to relay events to an instance it has not yet peered with, `ensurePeered()` in `federationPeering.ts` automatically initiates the handshake. This removes the requirement for an admin to manually initiate every peering relationship.

**Integration points:**
- **Outbox worker** (`federationWorker.ts`) — after delivering active peers, calls `ensurePeered()` for any pending-placeholder entries whose peer has not yet been activated.
- **Connection flow** (`POST /api/federation/peer/ensure`) — called by the client when establishing a cross-instance connection, ensuring the two instances are peered before any relay traffic is sent.

**`rejected` status** — Added to the peer lifecycle. Set when a remote instance explicitly rejects auto-peering with `403 PEERING_REQUIRES_APPROVAL`. This status is sticky: no automatic retry occurs. An admin can clear it by deleting the peer record (then re-initiating), or by manually initiating via `peer/initiate`. An incoming `peer/accept` from a remote admin can also override `rejected` → `active` (treated the same as a `pending` record).

**`autoAcceptPeering` instance setting** — Controls whether `POST /api/federation/peer/accept` accepts unsolicited peering requests. Default: `true`. When `false`, the endpoint returns `403 PEERING_REQUIRES_APPROVAL` for requests where no local `pending` record exists (i.e., a request the local admin did not initiate). The determination is made by checking the local peer table — not a client-provided flag.

### Peer Approval Queue

When `autoAcceptPeering` is `false` and an instance calls `POST /api/federation/peer/accept` without a matching local `pending` record, the endpoint returns `202 Accepted` and creates a row in `peer_approval_requests` instead of immediately peering. The requesting instance receives `202` (not an error), so it enters `awaiting_approval` status rather than `rejected`.

**`peer_approval_requests` table** — Holds incoming peering requests pending admin review:
- `id` — Snowflake PK
- `origin` — Requesting instance's origin URL (UNIQUE; only one pending request per origin)
- `instance_name` — Instance name sent by requester
- `hmac_secret` — Requester's HMAC secret; used to sign the denial notification
- `requested_at` / `expires_at` — Epoch ms; expiry is `requested_at + 30 days`

**Approval flow** — Admin approves via `POST /api/federation/approval-requests/:id/approve`:
1. A fresh `federationPeer` record is created (or existing `rejected`/`awaiting_approval` record is upserted) with status `pending`
2. A standard `peer/accept` handshake is sent to the requesting origin
3. On success the local peer becomes `active`; the `peer_approval_requests` row is deleted

**Denial flow** — Admin denies via `POST /api/federation/approval-requests/:id/deny`:
1. Server sends `POST {origin}/api/federation/peer/denied` signed with the requester's `hmac_secret` (from the approval request row)
2. Receiving instance transitions its local peer record from `awaiting_approval` → `rejected`
3. A local `federationPeer` record is upserted with status `rejected` to block future unsolicited requests from the same origin
4. The `peer_approval_requests` row is deleted

**Expiry** — The janitor (`federationJanitor.ts`) runs on its scheduled interval and deletes rows where `expires_at < now`. Expired requests do NOT create a `rejected` peer — the requesting instance can re-submit. Admin denial, by contrast, does create a `rejected` peer record, blocking re-requests until an admin clears it.

### Admin Endpoints

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/federation/peer/initiate` | POST | JWT + admin | Start peering handshake |
| `/api/federation/peer/accept` | POST | None (rate-limited) | Accept incoming handshake |
| `/api/federation/peer/ensure` | POST | JWT (any user), rate-limited 3/15min/user | Trigger auto-peering to a remote instance |
| `/api/federation/peers` | GET | JWT + admin | List all peers (secret excluded) |
| `/api/federation/peers/:id` | PATCH | JWT + admin | Update peer settings (auto-rotation interval) |
| `/api/federation/peers/:id` | DELETE | JWT + admin | Revoke peer, purge outbox |
| `/api/federation/peers/:id/permanent` | DELETE | JWT + admin | Hard-delete revoked peer record |
| `/api/federation/peers/:id/reset` | POST | JWT + admin | Delete peer record (cascade-deletes outbox). Only admissible in `needs_attention` state. |
| `/api/federation/peers/:id/rotate` | POST | JWT + admin | Trigger immediate secret rotation |
| `/api/federation/approval-requests` | GET | JWT + admin | List pending peering approval requests |
| `/api/federation/approval-requests/:id/approve` | POST | JWT + admin | Approve request, initiate handshake |
| `/api/federation/approval-requests/:id/deny` | POST | JWT + admin | Deny request, notify requester |

**`POST /api/federation/peer/ensure`** — Wraps `ensurePeered()`. Accepts `{ remoteOrigin: string }` in body. Returns `{ peeringStatus, peerId?, error? }` where `peeringStatus` is one of `active`, `pending`, `awaiting_approval`, `rejected`, `unreachable`, or `revoked`.

### S2S Endpoints

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/federation/peer/rotate` | POST | HMAC | Accept secret rotation from peer |
| `/api/federation/peer/denied` | POST | HMAC | Receive denial notification for awaiting_approval peer |
| `/api/federation/identity` | DELETE | HMAC | Delete federated user identity (soft/full mode) |

### S2S Identity Deletion (`DELETE /api/federation/identity`)

Allows a home instance to remove a user's replicated identity from a remote instance.

**Request body:**
```json
{ "homeUserId": "<string>", "homeInstance": "<string>", "mode": "soft" | "full" }
```

**Behavior:**

- **Attribution guard:** Rejects with `403` if the user's `homeInstance` doesn't match the `X-Federation-Origin` of the signing peer. Prevents one instance from deleting another instance's users.
- **Idempotent:** Returns `{ success: true }` for already-deleted or nonexistent users (no error).
- **Owned spaces check:** Returns `409` with `{ ownedSpaces: string[] }` if the user owns any spaces on the remote. The user must transfer or delete those spaces before identity removal proceeds.
- **Mode `"soft"`:** Calls `tombstoneUser(uid, { purgeContent: false })` — anonymizes the user row and removes memberships, but skips reaction deletion and orphaned DM purge.
- **Mode `"full"`:** Calls `tombstoneUser(uid, { purgeContent: true })` — full tombstone including reactions and orphaned DM cleanup.
- **Post-deletion:** Broadcasts `member_left` WS events for all spaces the user belonged to before removal.

### WebSocket Events (Peering)

These S→C events are pushed to the acting user's connected clients by the federation subsystem.

| Event | Pushed when | Payload |
|-------|-------------|---------|
| `federation_peer_rejected` | Outbox worker receives `403 PEERING_REQUIRES_APPROVAL` from a remote instance during auto-peering | `{ peerId: string, origin: string }` |
| `federation_peer_active` | A previously `rejected` peer transitions to `active` (e.g., via manual `peer/initiate` or incoming `peer/accept`) | `{ peerId: string, origin: string }` |

---

## 2. HMAC Request Authentication

### Signing Format

```
HMAC-SHA256(secret, "${timestamp}.${requestBody}")
```

Where `timestamp` is `Date.now()` (Unix milliseconds) and `requestBody` is the JSON string.

### HTTP Headers

| Header | Format | Example |
|--------|--------|---------|
| `X-Federation-Signature` | `sha256=<hex>` | `sha256=a1b2c3...` |
| `X-Federation-Origin` | Full URL | `https://nova.ddns.net` |
| `X-Federation-Timestamp` | Unix ms string | `1711619400000` |
| `Content-Type` | `application/json` | -- |

### Verification (`federationAuth.ts:verifySignature`)

1. Validate inputs: reject empty/missing body, signature, or secret
2. **Timestamp window:** `Math.abs(Date.now() - timestamp) <= maxAgeMs` (default 15 minutes)
3. Recompute: `HMAC-SHA256(secret, "${timestamp}.${body}")`
4. **Constant-time comparison:** `crypto.timingSafeEqual` on hex-decoded buffers
5. Length check: mismatched buffer lengths are rejected before `timingSafeEqual`

### Replay Attack Prevention

Two layers of replay protection:

1. **Timestamp window:** Requests older than 15 minutes are rejected (`DEFAULT_MAX_AGE_MS`).
2. **Nonce:** Each request includes a `X-Federation-Nonce` header (UUID v4). The nonce is included in the HMAC payload (`${timestamp}.${nonce}.${body}`) so it cannot be stripped. The receiver stores seen nonces in memory (keyed by peer origin, evicted after 15 min) and rejects duplicates with `409 Conflict`.

**Auto-ratchet:** The `nonceSupported` column on `federation_peers` tracks whether a peer has ever sent a nonce. Once set to `1`, nonce-less requests from that peer are permanently rejected (`401`). This allows graceful rollout — new peers get nonce enforcement automatically, legacy peers are warned in logs until they upgrade.

### Inbound Verification Flow (`POST /api/federation/relay`)

1. `parseFederationHeaders()` extracts origin, timestamp, signature, and nonce from headers
2. Look up peer by `origin` in `federation_peers` -- must exist and be `status = 'active'`
3. Re-serialize request body to JSON: `JSON.stringify(request.body)`
4. `verifySignature(bodyString, signature, peer.hmacSecret, timestamp, nonce)` -- reject if false
5. Nonce enforcement: duplicate nonce → 409, missing nonce from ratcheted peer → 401, legacy peer → warn

**Important:** The body is re-serialized server-side. This means Fastify's JSON parsing and re-stringification must produce identical output to the sender's `JSON.stringify`. In practice this works because both sides use standard `JSON.stringify` with no custom replacers.

---

## 3. Identity Resolution

### Functions

**`extractDomain(homeInstance)`** -- `federation.ts`
- Extracts bare domain from a homeInstance value (full URL or bare domain)
- `"https://nova.ddns.net"` → `"nova.ddns.net"`, `"nova.ddns.net"` → `"nova.ddns.net"`
- **Use when:** Normalizing homeInstance for comparison or storage

**`findFederatedUser(homeUserId, homeInstance, db, hints?)`** -- `federation.ts`
- Three-tier lookup: homeUserId match → domain + username hint match → not found
- Tier 1: delegates to `resolveLocalUser` (fast path)
- Tier 2: uses `extractDomain(homeInstance)` + `hints.username` to match stubs created by the auth registration path (which may have a different homeUserId)
- Side-effect-free — does not modify any records
- When multiple candidates match in tier 2, prefers real accounts over stubs, then most profile data
- **Use when:** Read-only lookup that needs to find users created by either auth or relay path

**`resolveLocalUser(homeUserId, db)`** -- `federation.ts`
- Read-only lookup. Returns `undefined` if not found.
- Matches: `(users.homeUserId = homeUserId)` OR `(users.id = homeUserId AND homeInstance IS NULL)`
- Excludes deleted users (`isDeleted = 0`)
- When multiple candidates exist: prefers the one with `homeUserId` set (replicated stub) over a local ID match
- **Use when:** Optional lookups where null is acceptable (member_remove, reaction processing, friend_remove)

**`resolveOrCreateReplicatedUser(homeUserId, homeInstance, db, hints?)`** -- `federation.ts`
- Calls `findFederatedUser` first. If found, backfills `homeUserId` for future fast-path lookups and returns.
- Accepts optional `hints: { username?: string | null }` for tier-2 matching
- If not found, creates a stub with `homeInstance` normalized to bare domain via `extractDomain`
- Collision-safe: appends `_1`, `_2`, ..., `_10` suffix if username exists; after 10 attempts, uses `_<random hex>`
- **Use when:** You MUST have a valid user ID. Always pass `{ username: profile?.username }` when profile data is available.

**`hydrateReplicatedUserProfile(user, profile, db)`** -- `federation.ts:2041`
- Updates replicated stubs only (`homeInstance` must be set)
- Only updates null/empty fields (preserves manually-set local values)
- Exception: avatar/banner are overwritten if the current value is a bare filename (not an absolute URL)
- Resolves bare filenames to `{homeInstance}/api/uploads/{filename}` absolute URLs
- Sets `displayName` from `profile.displayName || profile.username` -- ensures federated users show a human-readable name instead of `user@instance`

### Critical Rule

Any code path that sets `ownerId`, creates a `dm_members` row, or inserts a message MUST use `resolveOrCreateReplicatedUser`. Using `resolveLocalUser` with a `?? null` fallback can cause data corruption (e.g., `ownerId` set to null for group DMs).

### Origin Normalization

**Two formats exist in the database:**

| Location | Format | Example |
|----------|--------|---------|
| `users.home_instance` | Bare domain (normalized) | `nova.ddns.net` |
| `federation_peers.origin` | Full URL | `https://nova.ddns.net` |
| `getOurOrigin()` return | Full URL | `https://orbit.ddns.net` |
| `resolveOrCreateReplicatedUser` stores | Bare domain (normalized via `extractDomain`) | `nova.ddns.net` |
| Auth registration stores | Bare domain | `nova.ddns.net` |

Both user creation paths now store bare domain. A self-healing migration in `migrate.ts` normalizes any existing full-URL `homeInstance` values to bare domain on startup.

**Normalization pattern used in code:**
```typescript
const normalized = homeInstance.startsWith('http') ? homeInstance : `https://${homeInstance}`;
```

Locations where normalization is applied:
- `getGroupDmTargetOrigins()` (`federationOutbox.ts:294`) -- normalizes before comparing to `ourOrigin`
- `dm.ts:655` -- `isLocalMember` broadcast filter checks both formats
- `dm.ts:743` -- normalizes target homeInstance before peer origin comparison

**Attribution verification (`verifyAttribution`):**
- `verifyAttribution(actingUserHomeInstance, sourceInstance)` normalizes both via `extractDomain` and compares
- Two valid cases:
  1. **Direct**: `authorDomain === sourceDomain` — standard S2S, peer sends events for its own users
  2. **Homeward relay**: `authorDomain === extractDomain(getOurOrigin())` — a client-federation user sent a message on a remote server, and the S2S relay forwards it back to the author's home instance
- Applied as the FIRST check in every relay event processor (13+ handlers) — before user resolution or DB writes
- Prevents malicious peers from forging events attributed to users on *unrelated* instances (neither source nor receiver)

All origin comparisons use `extractDomain()` or `getOurOrigin()` with normalization, handling both bare domains and full URLs consistently.
- `federation.ts:2447` -- same pattern in `processFriendRemoveEvent`

---

## 4. DM Message Relay

### 1-on-1 DMs

**Outbound (origin instance):**
1. Message created via REST (`POST /api/dm/:id/messages`) or WS (`dm_message_create`)
2. `queueDmRelay(message, channelId, 'create')` called from `dm.ts` / `events.ts`
3. `buildRelayPayload()` constructs the message portion with `homeUserId`, `homeInstance`, `content`, `replyToId`, `editedAt`, `createdAt`
4. `getDmParticipants(channelId)` resolves all members to `(homeUserId, homeInstance)` pairs with profile snapshots
5. `getGroupDmTargetOrigins(channelId)` returns `undefined` (no owner -> broadcast to all)
6. `queueOutboxEvent(messageId, channelId, 'create', payload, undefined)` -> queued to ALL active peers

**Channel creation (1-on-1 with federated user):**
- When `POST /api/dm` creates a channel where either participant has `homeInstance` set, the deterministic `federatedId = SHA256(sorted([homeUserIdA, homeUserIdB])).slice(0, 32)` is computed and stored immediately
- This ensures `findOrCreateDmChannel` on the receiving instance finds the existing channel when the S2S reply arrives, preventing duplicate channels

**Inbound (receiving instance -- `processCreateEvent`):**
1. Validate: `event.message` and `event.participants` (>= 2) required
2. Dedup: check `(sourceInstance, sourceMessageId)` -- reject if exists
3. Resolve ALL participants via `resolveOrCreateReplicatedUser`, hydrate profiles
4. No `event.federatedId` -> 1-on-1 path
5. Compute deterministic `federatedId = SHA256(sorted([homeUserIdA, homeUserIdB])).slice(0, 32)`
6. `findOrCreateDmChannel(federatedId, [localUserA.id, localUserB.id], db)`:
   - Find by `federatedId` in `dm_channels`
   - If exists: ensure both users are members (idempotent insert)
   - If not: create channel with `federatedId`, add both members
7. Insert `dm_messages` with `sourceInstance` and `sourceMessageId`
8. Process attachments (see File Replication)
9. Broadcast `dm_message_created` to local members, **skipping** members whose `homeInstance === sourceInstance` (they already have the original)

### Group DMs

**Outbound (origin instance):**
Same as 1-on-1 except:
- `getGroupDmTargetOrigins(channelId)` returns a list of peer origins that have at least one participant
- Normalizes `homeInstance` to full URL before comparison
- `queueOutboxEvent` receives `targetPeerOrigins` and only queues to those peers
- Payload includes `federatedId` (random UUID assigned at channel creation)

**Inbound (receiving instance -- `processCreateEvent`):**
1. `event.federatedId` present -> group DM path
2. Find channel by `federatedId` -- must already exist (bootstrapped by prior `member_add`)
3. If not found -> reject with `channel_not_found`
4. Insert message, broadcast to local members

### Federated ID Generation (`federationOutbox.ts:computeFederatedId`)

```typescript
// 1-on-1: deterministic 32-char hex hash
const sorted = [homeUserIdA, homeUserIdB].sort();
return sha256(sorted.join(':')).slice(0, 32);

// Group: random 36-char UUID with dashes
return crypto.randomUUID();
```

The format difference (32-char hash vs 36-char UUID) is used by the self-healing migration to detect channel type independently of `owner_id`.

### Message Deduplication

Every relayed message is stored with:
- `source_instance`: the relay request's `sourceInstance` header value
- `source_message_id`: the `event.messageId` (original message ID on source instance)

The `(source_instance, source_message_id)` pair is checked before insertion. Duplicates are rejected with reason `'duplicate'`. A unique partial index enforces this at the DB level: `idx_dm_messages_source_unique ON dm_messages(source_instance, source_message_id) WHERE source_instance IS NOT NULL`.

### Typing Indicator Relay

**Event types:** `dm_typing_start`, `dm_typing_stop`

**Model:** Fire-and-forget, same as call signaling. No outbox, no retry, no mutation log. Typing is ephemeral — lost packets are acceptable.

**Channel identification:** Uses `federatedId` (not instance-local `dmChannelId`) for cross-instance channel lookup, plus `participants` for resolution context.

**Outbound (`events.ts` / `dm.ts`):**
- `handleDmTypingStart()` → after local broadcast, calls `sendTypingRelay(dmChannelId, 'dm_typing_start', userId)`
- `broadcastDmMessage()` → after local `dm_typing_stop` broadcast, calls `sendTypingRelay(dmChannelId, 'dm_typing_stop', message.userId)`

**`sendTypingRelay()` (`federationOutbox.ts`):**
- Fetches channel's `federatedId` and `getDmParticipants()` for target resolution
- Builds `FederationRelayEvent` with `typing: { homeUserId, homeInstance, username }`
- Calls `sendCallRelay(origin, [event], { peeringTimeoutMs: 0 })` for each remote peer origin — non-active peers are skipped and a background `ensurePeered` warm-up is kicked off instead

**Inbound (`federation.ts`):**
- `processDmTypingStartEvent` → look up channel by `federatedId`, resolve user via `resolveLocalUser()` (no stub creation for ephemeral events), broadcast `dm_typing` to local members
- `processDmTypingStopEvent` → same, broadcast `dm_typing_stop` to local members
- **Implicit clear:** `processCreateEvent()` also emits `dm_typing_stop` for the message author after processing an inbound relay — primary typing clear mechanism for relayed messages

---

## 5. Outbox & Relay Pipeline

### Event Queuing (`federationOutbox.ts:queueOutboxEvent`)

```
Trigger (API/WS handler)
  -> isFederationRelayEnabled()? No -> return silently
  -> Fetch active peers from federation_peers
  -> Filter to targetPeerOrigins (if specified) -- EXACT string match against peer.origin
  -> If zero peers match -> logs warning and returns
  -> For each peer, in a transaction:
      -> Check for existing outbox entry by (peerId, entityId)
      -> COALESCE:
          - delete + existing create -> delete both (net: never relayed)
          - update + existing create -> update payload, keep 'create' eventType
          - update + existing update -> update payload and eventType
          - no existing -> insert new entry
      -> TTL: now + (relayTtlDays * 86400000)
```

### Coalescing Rules (per-peer, per-entity)

| Incoming | Existing | Result |
|----------|----------|--------|
| `delete` | `create` | Entry removed (message was never relayed) |
| `update` | `create` | Payload updated, keeps `create` type (peer gets full message) |
| `update` | `update` | Payload updated, type becomes latest |
| `delete` | `update` | Payload updated, type becomes `delete` |
| any | none | New entry inserted |

### Outbox Delivery Worker (`federationWorker.ts:processOutboxTick`)

**Interval:** 10 seconds (`OUTBOX_INTERVAL_MS`)
**Batch size:** 50 (`OUTBOX_BATCH_LIMIT`)
**Timeout:** 30 seconds per request (`OUTBOX_FETCH_TIMEOUT_MS`)

1. Query entries where `nextRetryAt <= now` joined with active peers, ordered by `createdAt ASC`, limit 50
2. Group by peer
3. For each peer, reconstruct `FederationRelayEvent[]` from stored payloads:
   - Parse JSON payload
   - Copy fields: `federatedId`, `participants`, `message`, `reactions`, `reaction`, `membership`, `ownership`, `group`, `friendship`, file_rejected fields
   - Set `eventType`, `contextType`, `messageId`, `dmChannelId`, `encryptionVersion`, `timestamp`
4. Build `FederationRelayRequest` with `version: 1`, `sourceInstance: ourOrigin`
5. Sign with `buildFederationHeaders(body, peerHmacSecret, ourOrigin)`
6. POST to `{peerOrigin}/api/federation/relay`
7. On success (200):
   - Compute the **terminal entity set** = accepted entries ∪ duplicate-rejected entries
   - Delete all terminal entries from outbox (matched by `entityId` -> `outboxId`)
   - Log remaining (non-duplicate) rejected entries at `console.warn` (they stay in outbox for retry)
   - Store `result.maxUploadSize` on peer record
   - Update peer: `lastSeenAt = now`, `consecutiveFailures = 0`
8. On failure (non-200 or network error):
   - `handleOutboxDeliveryFailure()`:
     - Increment `attempts` per entry, compute `nextRetryAt = now + backoff`
     - Increment peer `consecutiveFailures`, set `lastFailureAt`
     - If `consecutiveFailures >= PEER_UNREACHABLE_THRESHOLD (10)` -> mark peer `unreachable`

#### Terminal rejection: `duplicate`

The outbox delivery worker treats a relay response of `{ rejected: [{ reason: 'duplicate', ... }] }` as effectively-accepted — the outbox entry is deleted rather than retained for retry. The `duplicate` reason is emitted by the receiving instance's inbound processors when a row with the same `(sourceInstance, sourceMessageId)` already exists; retrying will fail identically until TTL (30 days). Since the peer already has the message, terminal removal is the correct outcome.

Logged at `console.log` ("outbox entry removed (terminal)") to distinguish from retained-for-retry `console.warn` messages.

Other rejection reasons (`attribution_mismatch`, `missing_*_payload`, `unknown_event_type`, `unauthorized_source`, `channel_not_found`, `participant_not_found`, `processing_error`, …) remain on the retry path. Some are arguably terminal too; treating them as such is deferred until they are observed accumulating in practice.

### Retry Backoff Schedule

| Attempt | Delay |
|---------|-------|
| 1 | 30 seconds |
| 2 | 1 minute |
| 3 | 5 minutes |
| 4 | 15 minutes |
| 5 | 1 hour |
| 6 | 6 hours |
| 7+ | 24 hours (cap) |

### Authentication-failure handling (401 / 403)

When a relay response is 401 (HMAC rejected) or 403 (remote's peer row is non-active or missing), the worker increments `consecutive_auth_failures` on the peer row, applies backoff to the queued outbox entries via the existing `BACKOFF_SCHEDULE_MS`, and preserves `hmac_secret`. After `AUTH_FAILURE_THRESHOLD = 5` consecutive auth failures (~21.5 min with the existing schedule), the peer transitions to `needs_attention`:

- Outbox delivery halts (the existing `status = 'active'` filter on the delivery query excludes `needs_attention`).
- `hmac_secret` is preserved (admin can inspect; no silent rotation).
- Affected local users receive `federation_peer_rejected` WS events with reason "Federation trust broken — admin must reset peering".
- Admins receive `federation_peers_changed`.

The worker NEVER re-handshakes via unauthenticated `/peer/accept` in response to a 401/403. The safeguard at `/peer/accept` (idempotent-200-no-update on `active` OR `needs_attention` peers) is what prevents silent HMAC rotation; the worker's job is to respect that signal and surface it to admins rather than loop. Recovery is via the admin "Reset peering" action, which deletes the local peer row and requires out-of-band re-peering.

Network failures (timeouts, non-401/403 non-2xx responses) are tracked separately via `consecutive_failures` and lead to `unreachable` at `PEER_UNREACHABLE_THRESHOLD = 10`. A successful delivery resets both counters.

### Relay Request/Response Format

**Request:**
```typescript
interface FederationRelayRequest {
  version: 1;
  sourceInstance: string;          // Full URL, e.g., "https://nova.ddns.net"
  events: FederationRelayEvent[];  // Max 50 per batch
}
```

**Response:**
```typescript
interface FederationRelayResponse {
  accepted: string[];              // messageIds successfully processed
  rejected: Array<{
    messageId: string;
    reason: string;                // e.g., 'duplicate', 'unknown_message', 'missing_participants'
  }>;
  undeliverable?: Array<{          // optional — omitted when empty; call-signaling only
    messageId: string;
    reason: string;                // e.g., 'no_recipient'
  }>;
  maxUploadSize: number;           // This instance's max upload size in bytes
}
```

#### `undeliverable` bucket (call-signaling only)

In addition to `accepted` and `rejected`, the relay response may include an
optional `undeliverable: Array<{messageId, reason}>`. Three-way classification,
non-overlapping: each messageId appears in exactly one of the three arrays.

| Bucket | Meaning | Retry? |
|---|---|---|
| `accepted` | Processed cleanly, ≥1 recipient reached. | No |
| `rejected` | Refused at data/protocol layer (schema, attribution, channel-not-found, etc.). | Terminal. |
| `undeliverable` | Processed cleanly, zero recipients reachable. | No — call-signaling specific. |

Currently used only for `dm_call_start`:
- **Path A** (local DM exists): if no local non-caller member has an active WS
  connection, the event is pushed to `undeliverable` with reason `no_recipient`
  instead of being silently accepted. No `FederatedCallEntry` is created.
- **Path B** (no local DM): the zero-participant-match early return pushes to
  `undeliverable` rather than `accepted`.

Other event types (messages, reactions, friend events, profile updates, etc.)
keep existing semantics — a message to an offline user is still `accepted`, since
messages persist and re-deliver on reconnect.

The field is optional on the wire. Old peers omit it; new peers include it only
when non-empty. Caller-side `sendCallRelay` parses the field (defaulting to an
empty array when missing), so upgrade skew is a no-op until both sides are on
new code.

### Inbound Relay Dispatch (`POST /api/federation/relay`)

Body limit: 10 MB. Max 50 events per batch. Rate-limited to 90 requests/min per peer (sliding window, keyed by `peer.origin`). Returns 429 when exceeded. Raised from 30 after FED-009 reduced the outbox worker interval from 10s to 1s — a busy sender can now hit 60 req/min during sustained traffic.

| eventType | Processor | contextType |
|-----------|-----------|-------------|
| `create` | `processCreateEvent` | dm |
| `update` | `processUpdateEvent` | dm |
| `delete` | `processDeleteEvent` | dm |
| `reaction_add` | `processReactionAddEvent` | dm |
| `reaction_remove` | `processReactionRemoveEvent` | dm |
| `member_add` | `processMemberAddEvent` | dm |
| `member_remove` | `processMemberRemoveEvent` | dm |
| `ownership_transfer` | `processOwnershipTransferEvent` | dm |
| `read_state_update` | `processReadStateUpdateEvent` | dm |
| `friend_request_create` | `processFriendRequestCreateEvent` | friend |
| `friend_request_update` | `processFriendRequestUpdateEvent` | friend |
| `friend_request_cancel` | `processFriendRequestCancelEvent` | friend |
| `friend_add` | `processFriendAddEvent` | friend |
| `friend_remove` | `processFriendRemoveEvent` | friend |
| `file_rejected` | `processFileRejectedEvent` | dm |
| `dm_typing_start` | `processDmTypingStartEvent` | dm (fire-and-forget, no outbox) |
| `dm_typing_stop` | `processDmTypingStopEvent` | dm (fire-and-forget, no outbox) |
| `dm_close` | `processDmCloseEvent` | dm |
| `dm_reopen` | `processDmReopenEvent` | dm |

After processing all events, the relay endpoint updates the peer's `lastSeenAt` and resets `consecutiveFailures`, then returns accepted/rejected arrays plus `maxUploadSize`.

---

## 6. Group DM Lifecycle over Federation

### member_add (`processMemberAddEvent` -- `federation.ts:1618`)

**Required fields:** `event.federatedId`, `event.membership.user`

**Two paths:**

**Bootstrap path** (channel does not exist locally by `federatedId`):
1. Requires `event.group` metadata (owner + full member roster)
2. Creates `dm_channels` row with `federatedId`, `ownerId` (resolved via `resolveOrCreateReplicatedUser`), `ownerHomeUserId`, `ownerHomeInstance`
3. Adds ALL roster members from `event.group.members` (each resolved via `resolveOrCreateReplicatedUser`)
4. Sends `dm_channel_created` to **local-only members** (home instance matches `getOurOrigin()`, with normalization for bare domain)
5. Sets `bootstrapped = true` to skip redundant system messages and member_add broadcasts below

**Incremental path** (channel already exists):
1. Validates authority: any HMAC-verified peer is accepted (relaxed — the `sourceInstance === channel.ownerHomeInstance` check was removed to support cross-instance access). The per-user attribution check (`verifyAttribution`) still applies.
2. Cancels soft-delete if channel was pending GC
3. Resolves added user via `resolveOrCreateReplicatedUser`
4. Enforces max 10 members
5. Inserts `dm_members` row (idempotent -- skip if exists)
6. Inserts system message, broadcasts `dm_member_added` to local WebSocket clients

### member_remove (`processMemberRemoveEvent` -- `federation.ts:1825`)

1. Find channel by `federatedId` -- if not found, accept idempotently
2. Validate authority: owner's instance for kicks (`reason !== 'leave'`), any instance for self-leave
3. Resolve user via `resolveLocalUser` -- if not found, accept idempotently
4. Insert system message (before deletion, so broadcast includes the leaving user)
5. Delete `dm_members` row, clean up `read_states`
6. Broadcast `dm_member_removed` to remaining local members
7. If zero members remain -> soft-delete channel (`deletedAt = now`)

### ownership_transfer (`processOwnershipTransferEvent` -- `federation.ts:1938`)

1. Find channel by `federatedId` -- if not found, accept idempotently
2. Validate authority: `sourceInstance === channel.ownerHomeInstance`
3. Resolve new owner via `resolveOrCreateReplicatedUser` (**never** `resolveLocalUser` -- must guarantee valid ID)
4. Update `dm_channels`: `ownerId`, `ownerHomeUserId`, `ownerHomeInstance`
5. Broadcast `dm_owner_updated` WebSocket event
6. Insert system message with previous owner as actor

### Local-Only Broadcast Principle

Users connected to multiple instances must see each DM channel exactly once (from their home instance). All structural broadcasts (`dm_channel_created`, system messages) filter to **local members only**:

```typescript
const isLocalMember = (u: { homeInstance?: string | null }) =>
  !u.homeInstance || !domainOrigin ||
  u.homeInstance === domainOrigin ||
  `https://${u.homeInstance}` === domainOrigin;
```

**Does NOT apply to:** Regular DM messages (`dm_message_created` for user messages). These broadcast to all local `dm_members` regardless of home instance.

### System Messages

System messages (`type = 'system'` in `dm_messages`) are **instance-local** -- they are NOT relayed via federation. Each instance creates its own when processing events.

| Event | Content JSON | Actor (`userId`) |
|-------|-------------|-----------------|
| `member_added` | `{event, targetUserId, targetDisplayName}` | User who added them |
| `member_removed` | `{event, targetUserId, targetDisplayName, reason}` | User who left/was removed |
| `owner_changed` | `{event, newOwnerId, newOwnerDisplayName}` | Previous owner |

### Outbound Queuing (Origin Instance -- `dm.ts`)

When a group DM is created or modified locally, the origin instance queues federation events:

**Group DM creation** (`POST /api/dm/group`):
- Iterates each remote target user (those with `homeInstance !== domainOrigin`)
- Builds a `member_add` event per remote user, carrying the full roster in `event.group`
- Computes `finalTargets` by starting from `getGroupDmTargetOrigins()` and adding the new member's normalized homeInstance
- Calls `appendMutationLog` + `queueOutboxEvent` per event

**Add member to existing group** (`POST /api/dm/:id/members`):
- Same structure as creation -- builds `member_add` with full group metadata
- Normalizes new member's homeInstance to full URL before including in targets

**Leave group** (`DELETE /api/dm/:id/members`):
- Computes `fedTargetOrigins` **before** deleting the member (so the leaving user's peer is still included)
- Queues `member_remove` event with `reason: 'leave'`

**Ownership transfer** (`PATCH /api/dm/:id`):
- Queues `ownership_transfer` event with `previousOwner` and `newOwner`

---

## 7. File Replication

### Outbound (origin instance)

When `queueDmRelay` constructs the relay payload, each attachment gets a `sourceUrl`:
```
sourceUrl: `${getOurOrigin()}/api/uploads/${attachment.filename}`
```

### Inbound (receiving instance -- `processCreateEvent`)

1. For each attachment in `event.message.attachments`:
   - SSRF check: `isUrlFromPeer(sourceUrl, peerOrigin)` -- hostname of sourceUrl must match peer origin hostname
   - Create `attachments` row with `filename = sourceUrl` (remote URL as interim filename)
   - Queue `federation_file_queue` entry with `status = 'pending'`, `expiresAt = now + 30 days`
2. Initial WebSocket broadcast uses sourceUrl directly (frontend's `AttachmentRenderer` detects `http` prefix)

### File Download Worker (`federationWorker.ts:processFileQueueEntry`)

**Interval:** 30 seconds. **Batch:** 5 files. **Timeout:** 60 seconds per download.

1. SSRF protection: validate sourceUrl hostname matches peerOrigin hostname
2. Pre-download size check against `maxUploadSizeBytes` from instance settings
3. Download via `fetch` with streaming pipeline to disk (`Readable.fromWeb` -> `fs.createWriteStream`)
4. Post-download size verification (defense in depth)
5. Generate thumbnail via `sharp` (same as local upload flow)
6. Update `attachments` row: `filename = localFilename`, `size`, `thumbnailFilename`
7. Fallback: if no existing attachment row was found (legacy queue entry), insert a new one
8. Mark file queue entry as `completed` with `targetFilename`
9. Broadcast `dm_message_updated` to refresh client-side attachment display

### Size Rejection Flow (`handleSizeRejection`)

When a file exceeds the local instance's size limit:

1. Mark file queue entry as `rejected` with `reason = 'size_limit_exceeded'`
2. Update local attachment: `federationStatus = 'remote'`, `federationMeta` = source info JSON
3. Determine affected local users (native to this instance -- `!user.homeInstance || user.homeInstance === ourOrigin`)
4. Queue `file_rejected` reverse relay event to the sender's instance (`sourceInstance`)
5. Broadcast `dm_message_updated` locally so clients see the 'remote' badge

### Inbound file_rejected (`processFileRejectedEvent` -- `federation.ts:2458`)

When the origin instance receives a `file_rejected` event:

1. Find local message by `event.messageId` (the original local message ID)
2. Match attachment by `sourceFilename` or fallback to single attachment
3. Resolve `affectedUserIds` (homeUserIds) to local replicated user stubs
4. Merge rejection info into `federationMeta` (accumulates from multiple peers)
5. Set `federationStatus = 'remote_partial'`
6. Broadcast `dm_message_updated` + targeted `federation_file_rejected` toast to message author

### Federation Status on Attachments

| Status | Meaning |
|--------|---------|
| `null` | Local upload, no federation involvement |
| `'local'` | Successfully downloaded from peer |
| `'remote'` | Rejected (size limit), `federationMeta` has source instance info |
| `'remote_partial'` | Rejected by some peers, `federationMeta` has per-user rejection array |

### File Download Retry

Uses the same backoff schedule as outbox delivery. Max attempts: 10 (`MAX_FILE_ATTEMPTS`). After exceeding max attempts: `status = 'failed'`, `rejectionReason = 'max_attempts_exceeded'`.

---

## 8. Read State Relay

### `read_state_update` Event

When a user marks a DM channel as read (`channel_ack`) or marks it unread (`mark_unread`), the read state is relayed to all peer instances so cross-instance sessions stay in sync.

**Outbound (`events.ts:handleChannelAck` / `handleMarkUnread`):**
- Fires after writing `read_states` locally
- Only triggers for DM channels with a `federatedId` (cross-instance DMs)
- Calls `queueReadStateRelay(channelId, messageId, userId)` in `federationOutbox.ts`
- Queued via the standard outbox pipeline — durable, retried by the background worker
- Entity key `read_state:{federatedId}:{userId}` enables coalescing (rapid acks collapse to latest)
- `mark_unread` with the `'0'` sentinel (delete read state entirely) is NOT relayed — it cannot be mapped to a message

**Event payload:**
```typescript
{
  eventType: 'read_state_update',
  dmChannelId: string,
  messageId: string,            // unique event ID: 'read_state:{userId}:{timestamp}'
  federatedId: string,          // DM channel's federatedId (cross-instance channel lookup)
  encryptionVersion: 0,
  timestamp: number,            // LWW tiebreaker
  readState: {
    user: { homeUserId: string; homeInstance: string },
    messageRef: { sourceInstance: string; sourceMessageId: string }
  }
}
```

`messageRef` identifies the acked message in federation coordinates. If the message originated on this instance, `sourceInstance` is our own origin and `sourceMessageId` is the local message ID. If the message was relayed here, `sourceInstance` and `sourceMessageId` come from the `dm_messages` row's `source_instance`/`source_message_id` columns.

**Inbound (`processReadStateUpdateEvent`):**
1. Resolve channel by `federatedId` — reject if not found
2. Resolve user via `resolveLocalUser` — reject if not found
3. Translate `messageRef` to local message ID:
   - If `sourceInstance` matches our origin: `sourceMessageId` IS our local ID
   - Otherwise: look up `dm_messages` by `source_instance + source_message_id`
4. If no local message found (relay hasn't arrived yet): silently accept (no-op)
5. Upsert `read_states` using timestamp-only LWW (`event.timestamp > existing.updatedAt`)
6. Echo `channel_ack` to the user's local WebSocket connections (multi-tab sync)

---

## 8b. DM Close/Reopen Relay

### Overview

When a user closes or reopens a DM on their home instance, the action is relayed to all peer instances that hold a copy of the channel. This keeps the visibility state of a DM consistent across all instances that participate in it.

Only DMs with a `federatedId` are eligible. Legacy local-only DMs (created before federation was added, with no `federatedId`) are silently skipped.

### Event Types

| Event | Trigger |
|-------|---------|
| `dm_close` | User calls `DELETE /api/dm/:id` (soft-close) |
| `dm_reopen` | User calls `POST /api/dm` and reopens a closed 1-on-1 DM |

### Payload

```typescript
{
  eventType: 'dm_close' | 'dm_reopen',
  dmChannelId: string,          // local channel ID (context only)
  federatedId: string,          // cross-instance channel lookup key
  messageId: string,            // unique event ID: 'dm_close:{federatedId}:{userId}:{ts}'
  encryptionVersion: 0,
  timestamp: number,
  dmCloseReopen: {
    homeUserId: string,         // acting user's home user ID
    homeInstance: string,       // acting user's home instance (full URL)
  }
}
```

### Outbound (`federationOutbox.ts:queueDmCloseRelay`)

Called from `dm.ts` after the local close or reopen is committed.

1. Fetch the channel's `federatedId` — if null (local-only DM), return silently
2. Fetch the acting user's `(homeUserId, homeInstance)` federation identity
3. Build `FederationRelayEvent` with `eventType` and `dmCloseReopen` payload
4. `getGroupDmTargetOrigins(dmChannelId)` resolves the delivery targets:
   - 1-on-1 DMs (`ownerId = NULL`): returns `undefined` → broadcast to ALL active peers
   - Group DMs: returns the set of peer origins that have at least one participant
5. Enqueue via `appendMutationLog` + `queueOutboxEvent`

### Inbound

**`processDmCloseEvent` (`federation.ts`):**
1. Look up channel by `federatedId` — if not found, accept silently (idempotent)
2. Resolve acting user via `resolveLocalUser` (lookup-only; no stub creation for close/reopen) — if not found, accept silently
3. If the user has no `dm_members` row in this channel, accept silently
4. Set `dm_members.closed = 1` for the resolved local user
5. Broadcast `dm_channel_closed` to the user's local WebSocket connections

**`processDmReopenEvent` (`federation.ts`):**
1. Look up channel by `federatedId` — if not found, accept silently
2. Resolve acting user via `resolveLocalUser` — if not found, accept silently
3. If the user has no `dm_members` row, accept silently
4. Set `dm_members.closed = 0`
5. Build full `DmChannel` payload and broadcast `dm_channel_created` to the user's local WebSocket connections (mirrors the automatic reopen path in `broadcastDmMessage`)

### Closed-State Reopen on Message Relay (Bug Fix)

`processCreateEvent` (inbound message relay) now mirrors the local `broadcastDmMessage` logic: before broadcasting `dm_message_created`, it checks each recipient's `dm_members.closed` flag. For any recipient with `closed = 1`:

1. Set `closed = 0`
2. Broadcast `dm_channel_created` (with the new message as `lastMessage`) to resurface the DM in the recipient's sidebar
3. Then broadcast `dm_message_created`

This fixes a gap where relayed messages bypassed the closed-state reopen logic, leaving the DM hidden for recipients whose `closed` flag was set on the receiving instance.

---

## 9. Friend Relay

### Event Flow (social.ts)

| User Action | Federation Event | Authority Check |
|-------------|-----------------|-----------------|
| Send friend request | `friend_request_create` | `from.homeInstance === sourceInstance` |
| Accept/decline request | `friend_request_update` | `to.homeInstance === sourceInstance` |
| Cancel outgoing request | `friend_request_cancel` | `from.homeInstance === sourceInstance` |
| Accept creates friendship | `friend_add` | `to.homeInstance === sourceInstance` |
| Remove friend | `friend_remove` | Either side's instance |

### Target Resolution (`getFriendEventTargets`)

Computes which peer origins need the event. Compares `fromHomeInstance` and `toHomeInstance` against `getOurOrigin()` with normalization applied, correctly handling both bare domain and full URL formats.

### Context ID

Friend events use a deterministic context ID: `friend:${sorted[homeUserIdA, homeUserIdB].join(':')}`.

### Outbound Payload Construction

Each friend endpoint builds a `FederationRelayEvent` with:
- `contextType: 'friend'`
- `friendship` payload containing `from` and `to` as `FederationRelayParticipant` objects
- `fromProfile` and/or `toProfile` snapshots (`FederationRelayProfileSnapshot`)
- `entityId` formatted as `friend_req:${sorted_ids}:${timestamp}` (for requests) or `friend_remove:${sorted_ids}:${timestamp}`

The full event payload is stored in both `appendMutationLog` (for sync) and `queueOutboxEvent` (for delivery).

### Inbound Processing

**`processFriendRequestCreateEvent` (`federation.ts:2082`):**
- Authority check: `from.homeInstance !== sourceInstance` -> reject
- Resolve sender via `resolveOrCreateReplicatedUser` + hydrate profile
- Resolve recipient via `resolveLocalUser` (must be native to this instance)
- Idempotency: if already friends or pending request exists, accept as no-op
- Create `friend_requests` row, broadcast `friend_request_received` to recipient

**`processFriendRequestUpdateEvent` (`federation.ts:2178`):**
- Authority check: `to.homeInstance !== sourceInstance` -> reject
- Resolve sender (original requester) via `resolveLocalUser` (must exist locally)
- Resolve recipient (acceptor/decliner) via `resolveOrCreateReplicatedUser`
- Find pending request, update status
- Broadcast `friend_request_accepted` or `friend_request_declined` to the original sender

**`processFriendRequestCancelEvent` (`federation.ts:2254`):**
- Authority check: `from.homeInstance !== sourceInstance` -> reject
- Both users must exist locally. If not, accept idempotently.
- Delete the pending friend request. Broadcast `friend_request_cancelled` to recipient.

**`processFriendAddEvent` (`federation.ts:2318`):**
- Authority check: `to.homeInstance !== sourceInstance` -> reject
- Resolve both users via `resolveOrCreateReplicatedUser` + hydrate profiles
- Insert `friends` row (idempotent)
- Auto-resolve any pending `friend_requests` to `'accepted'` (handles out-of-order delivery)
- Determine which user is local (`from.homeInstance === ourOrigin`) and broadcast `friend_request_accepted`

**`processFriendRemoveEvent` (`federation.ts:2404`):**
- Authority check: either `from.homeInstance` or `to.homeInstance` must be `sourceInstance`
- Both users resolved via `resolveLocalUser`. If not found, accept idempotently.
- Delete `friends` row in both directions
- Determine local user (whose `homeInstance` is NOT the source) and broadcast `friend_removed`

---

## 10. Profile Sync

Profile sync uses **two mechanisms** that operate independently:

### S2S Profile Hydration (Server-side)

When relay events carry `FederationRelayProfileSnapshot` data:
- `processCreateEvent`: hydrates participant profiles on message relay
- `processFriendRequestCreateEvent` / `processFriendAddEvent`: hydrates friend profiles

`hydrateReplicatedUserProfile` only fills null/empty fields. Avatar/banner are overwritten only if the current value is not an absolute URL (catches stale bare filenames).

#### Profile Sync (S2S)

Profile data is synced server-to-server. The home instance is authoritative — when a user updates their profile, the home server queues a `profile_update` relay event to all active peers via the outbox.

**Event:** `profile_update` (contextType: `profile`)

**Payload:** `FederationProfileUpdatePayload` — full snapshot of 6 durable fields:
- `homeUserId`, `homeInstance`, `profileUpdatedAt` (monotonic version)
- `displayName`, `avatar` (absolute URL or null), `banner` (absolute URL or null)
- `accentColor`, `avatarColor`, `bio`

**Targeting:** Broadcast to all active peers. Peers silently accept if they have no replica.

**Coalescing:** `entityId = homeUserId`. Rapid successive edits coalesce to one delivery per peer.

**Processing:** Remote overwrites all 6 fields unconditionally. Rejects if incoming `profileUpdatedAt ≤ stored`. Broadcasts `user_updated` to local WS clients.

#### Profile Image File Replication

When a `profile_update` relay carries avatar or banner absolute URLs, the receiving instance downloads the image files locally rather than storing remote URLs. This eliminates cross-origin dependencies — avatars render from the local `/api/uploads/` endpoint.

**Flow:** `processProfileUpdateEvent` calls `downloadProfileAsset(url, sourceInstance)` for each of avatar/banner:
1. SSRF check (URL hostname must match authenticated source instance)
2. `fetch` with 10s timeout
3. Content-type validation (`image/*` only)
4. Stream to temp file (`temp_{snowflake}{ext}`), atomic rename to `{snowflake}{ext}`
5. Store local bare filename in user row

**Fallback:** On any download failure (timeout, HTTP error, non-image content, SSRF mismatch), the absolute URL is stored instead. This degrades to the pre-replication behavior — the avatar loads cross-origin from the home instance.

**File cleanup:** When avatar/banner changes, the old local file is deleted via `deleteUploadFile()`. The check `!oldValue.startsWith('http')` ensures only locally-downloaded files are deleted, not absolute URL strings.

**No migration:** Existing absolute URLs self-heal — the next profile change on the home instance triggers a relay and download.

**Write protection:** Remote instances reject PATCH /users/@me profile field updates for replicated users (homeInstance set). Profile data is read-only on remote — only updated via S2S relay.

**Bootstrap:** When a new origin appears in a user's `replicatedInstances`, the home server queues a targeted `profile_update` to that peer.

**File handling:** Profile images are downloaded locally on relay receipt (see "Profile Image File Replication" above).

**Replaces:** Client-driven `profileSync.ts` (deleted). `hydrateReplicatedUserProfile` still bootstraps null fields during DM/friend relay — it is not replaced.

---

## 11. Reaction Relay

### Outbound

Reactions are queued by WS event handlers in `events.ts`:
- `dm_reaction_add` -> `queueOutboxEvent(reactionId, channelId, 'reaction_add', payload, targetOrigins)`
- `dm_reaction_remove` -> `queueOutboxEvent(messageId, channelId, 'reaction_remove', payload, targetOrigins)`

Payload includes `userId`, `homeUserId`, `emoji`, `createdAt`, plus `messageId` and `messageHomeInstance` for cross-instance message resolution.

The mutation log entry for reactions stores a simpler payload (no `messageId`/`messageHomeInstance`), while the outbox entry carries the full reaction payload including those fields.

### Inbound

**`processReactionAddEvent` (`federation.ts:1480`):**
1. Resolve message via `resolveLocalDmMessage(canonicalMessageId, messageHomeInstance, sourceInstance, db)`:
   - If `messageHomeInstance === getOurOrigin()` -> find by local ID (the message originated here)
   - Otherwise -> find by `(messageHomeInstance || sourceInstance, canonicalMessageId)` tracking -- uses `messageHomeInstance` when available (correct origin in 3-instance relay), falls back to `sourceInstance`
2. Resolve reacting user via `resolveLocalUser` (must already exist)
3. Dedup: check existing reaction by `(dmMessageId, userId, emoji)`
4. Insert `dm_reactions`, broadcast `reaction_added` to local clients

**`processReactionRemoveEvent` (`federation.ts:1561`):**
- Same resolution logic
- Delete matching reaction, broadcast `reaction_removed` if changes > 0

---

## 12. Initial Sync

### `startupBootstrapSync()` (`federationWorker.ts`)

Triggered once at server startup (async, non-blocking). Finds peers with `status = 'active'` and `lastSyncedAt = 0` and calls `onPeerActivated(peerId, 'startup_bootstrap')` for each. This preserves the original startup-sync semantics while unifying the code path with all other activation sites (see "Peer Activation Recovery" below).

### Peer Activation Recovery

Every transition of `federation_peers.status` to `active` invokes `onPeerActivated(peerId, reason)` — one handler wired at all transition sites. Two independent invariants, both unconditional:

1. **`resetOutboxBackoff`** — sets `nextRetryAt = now` and `attempts = 0` for every outbox entry belonging to the peer. Entries that accumulated exponential backoff before the peer went unreachable are immediately eligible again. Attempts counter is also reset so a freshly-healthy peer's next failure starts at `BACKOFF_SCHEDULE_MS[0]` (30s), not wherever the counter left off.
2. **`syncPeerMutationLog`** — pulls missed events from the peer's `/api/federation/sync` endpoint since `peer.lastSyncedAt`. Three passes: DM, friend, profile (in that order, each paginated). `lastSyncedAt` advances to `Date.now()` on full success; stays put on transient failure so the next activation retries the same window.

#### Call sites (must remain exhaustive)

| File | Context | Reason |
|---|---|---|
| `routes/federation.ts` | `/peer/initiate` 200 activation | `initiate_accepted` |
| `routes/federation.ts` | `/peer/accept` existing-rejected override | `accept_rejected_override` |
| `routes/federation.ts` | `/peer/accept` existing-awaiting_approval | `accept_awaiting_approval` |
| `routes/federation.ts` | `/peer/accept` existing-pending | `accept_pending` |
| `routes/federation.ts` | `/peer/accept` new-peer | `accept_new` |
| `routes/federation.ts` | `/approval-requests/:id/approve` success | `approval_handshake` |
| `utils/federationWorker.ts` | Health check unreachable → active | `health_check_recovery` |
| `utils/federationPeering.ts` | `ensurePeered/performHandshake` 200 | `ensure_peered` |
| `utils/federationWorker.ts` | Startup scan (status=active, lastSyncedAt=0) | `startup_bootstrap` |

HTTP handler sites dispatch fire-and-forget (`.catch(log)`) so the response is not blocked by sync-pull pagination. Worker-internal sites `await` since the worker tick is already async.

Concurrent activations for the same peer are deduplicated via an in-flight promise map keyed by `peerId`.

### onPeerDeactivated

Mirror of `onPeerActivated` for the transition *out* of `active`. Invoked wherever `federation_peers.status` is written to `unreachable`, `needs_attention`, `rejected`, or `revoked`. Responsibility: sweep `ConnectionManager.federatedCalls` for entries whose `federatedCallHost` matches the deactivated peer and evict them — emitting `dm_call_undeliverable { phase: 'host_unreachable', terminal: true }` to each entry's `ringedUserIds`. See `docs/systems/voice.md` for the client teardown contract.

**Call sites (exhaustive — grep `onPeerDeactivated(` to audit):**
- `utils/federationWorker.ts` handleOutboxDeliveryFailure when status flips to `unreachable`
- `utils/federationWorker.ts` auth-failure path when status flips to `needs_attention`
- `utils/federationWorker.ts` resolvePendingPeers case `'rejected'`
- `routes/federation.ts` admin revoke endpoint
- `utils/federationPeering.ts` performHandshake 403 `PEERING_REQUIRES_APPROVAL` path

Deduplicated by peerId using a **separate** `inFlightDeactivation` map (not shared with activation) so flapping peers retain clean activate-then-deactivate ordering.

A 30s periodic sentinel in `federationWorker.ts` (`runFederatedCallSentinelTick`) is the backstop — it scans active FederatedCallEntries, compares each host's current peer status against reality, and catches transitions missed by the hook sites.

#### Peer-state × outbox-enqueue × recovery matrix

| Status | `queueOutboxEvent` enqueue | Mutation log captures | Recovery on transition to `active` |
|---|---|---|---|
| `active` | Queue | Yes (for covered event types — see below) | N/A |
| `pending` | Queue | Yes | `onPeerActivated` |
| `unreachable` | Queue | Yes | `onPeerActivated` |
| `awaiting_approval` | **Drop, debug-log** | Yes | `onPeerActivated` |
| `needs_attention` | **Drop, debug-log** | Yes | `onPeerActivated` (fires when the row is re-created via admin Reset + re-peer) |
| `rejected` | Drop, debug-log | Yes | `onPeerActivated` |
| `revoked` | Drop, debug-log | Yes | `onPeerActivated` (fires when the row is re-created via hard-delete + re-initiate) |

`queueOutboxEvent` uses an exhaustive TypeScript `switch` on the narrowed peer-status union — adding a new status value without handling it fails compile-time typecheck (`const _exhaustive: never = status;`).

**Mid-call race catch:** when the initial peers SELECT filters out a peer because its status is non-deliverable, but the fallback loop observes the status has since flipped to `active`/`pending`/`unreachable`, the code re-fetches the peer row and appends it to `matchedPeers` so the outer enqueue loop includes it. Silent drops would lose real-time delivery under asymmetric failure (e.g., `/peer/accept` 200 response lost on the wire, health-check transition firing on only one side).

#### Mutation log coverage

Event types covered by `appendMutationLog` (replayed on sync-pull):

| Event type | `contextType` | Source |
|---|---|---|
| DM `create` / `update` / `delete` | `dm` | `federationOutbox.queueDmRelay`, `dm.ts` delete handler |
| `reaction_add` / `reaction_remove` | `dm` | `ws/events.ts` |
| `member_add` / `member_remove` / `ownership_transfer` | `dm` | `dm.ts` |
| `dm_close` / `dm_reopen` | `dm` | `federationOutbox.queueDmCloseRelay` |
| `read_state_update` | `dm` | `federationOutbox.queueReadStateRelay` |
| `file_rejected` | `dm` | `federationWorker.handleSizeRejection` |
| `friend_request_*` / `friend_add` / `friend_remove` | `friend` | `social.ts` |
| `profile_update` | `profile` | `routes/users.ts` (PATCH `/api/users/@me`) |

Ephemeral events (`dm_typing_*`, `dm_call_*`) are fire-and-forget by design and are NOT captured — missed typing/call-signaling packets are acceptable and carry no durable state.

#### `/api/federation/sync` contextType filter values

| Filter | Returns |
|---|---|
| (none) / omitted | DM events (including `dm_close`, `dm_reopen`, `read_state_update`, `file_rejected`) |
| `'friend'` | Friend events |
| `'profile'` | Profile update events |

#### Poison-Pill Event Handling

`syncPeerMutationLog` replays incoming events one at a time. If an event's inbound processor throws (e.g., UNIQUE conflict from a malformed payload, unexpected schema drift, a processor bug), the error is caught per-event, logged via `console.error` with the event's `eventType`, `messageId`, `timestamp`, peer origin, and error message, and the loop continues with the next event. `lastSyncedAt` is advanced past the failed event (using the event's own `timestamp`), so subsequent activations do not retry the poison pill.

The final `Sync-pull from <origin> replayed <N> events` log line is suffixed with `(<K> skipped due to errors)` when `K > 0`, surfacing the count to operators watching logs. Individual event failures are in the same logs under `Skipping poison-pill event` — grep `console.error` / `stderr` to recover them.

Trade-off: this policy prioritizes forward progress of the sync pipeline over strict at-least-once delivery of every mutation. An event that fails to process is silently lost to the receiving instance unless operators manually replay it (e.g., by resetting `lastSyncedAt` on the peer row or by reissuing the originating mutation on the sender). The alternative — refusing to advance on any error — caused the "stuck forever" state described in the pre-fix version of this section.

### Sync Endpoint (`POST /api/federation/sync`)

HMAC-authenticated. Returns events from the `federation_mutation_log`.

**Request:**
```typescript
{ sinceTimestamp: number, dmChannelId?: string, federatedId?: string, contextType?: 'dm'|'friend'|'profile', limit?: 1-500 }
```

**Response:**
```typescript
{ events: FederationRelayEvent[], hasMore: boolean, checkpoint: number }
```

**DM sync:**
- Queries all `dm_channels` with non-null `federated_id` (not soft-deleted)
- Joins `federation_mutation_log` with `dm_messages` to reconstruct events
- Only returns locally-created messages (`source_instance IS NULL` via the LEFT JOIN)
- Handles delete mutations separately (message rows don't exist for deletes)
- For create/update: fetches current message state from DB, builds full relay event with attachments and participants
- Membership/friend mutations store the full event payload in the mutation log, so they are returned directly

**Friend sync:**
- Queries `federation_mutation_log WHERE context_type = 'friend'`
- Returns stored payloads directly (friend events carry their complete data)

### Relay Event Processing

The event processing logic is extracted into `processRelayEvents()` (exported from `federation.ts`), shared by both the HTTP relay endpoint and the initial sync worker. This avoids a DNS hairpin issue where the server would HTTP-request itself through public DNS, which fails on networks without hairpin NAT.

---

## 13. DM Calls over Federation

DM calls work across federated instances. The caller's instance hosts the LiveKit room. Remote clients connect directly to the caller's LiveKit server using a token passed through S2S relay — no media is routed through the federation layer.

```
User A's client <--WS--> Instance 1 (hosts LiveKit) <--S2S HTTP--> Instance 2 <--WS--> User B's client
                              |                                                            |
                              +------------- LiveKit (direct client connection) -----------+
```

### S2S Event Types

Four relay event types are processed in `processRelayEvents()`:

| Event Type | Direction | Key Payload Fields |
|---|---|---|
| `dm_call_start` | Host → Peers | `federatedId`, `livekitUrl`, `tokens: Record<string, string>` (keyed by `homeUserId`), `caller: { homeUserId, homeInstance, displayName }`, `participants` |
| `dm_call_accept` | Participant → Host, then Host → All Peers | `federatedId`, `acceptor: { homeUserId, homeInstance }` |
| `dm_call_reject` | Participant → Host, then Host → All Peers | `federatedId`, `rejector: { homeUserId, homeInstance }` |
| `dm_call_end` | Any → Host (if not host), then Host → All Peers | `federatedId`, `endedBy: { homeUserId, homeInstance }` |

All events carry standard relay fields: `eventType`, `messageId`, `encryptionVersion: 0`, `timestamp`. All events pass through `verifyAttribution()` before any DB or state mutations.

### Direct Delivery (No Outbox)

**`sendCallRelay(targetPeerOrigin, events, opts?)`** (`federationOutbox.ts`):

- Latency-sensitive: returns `CallRelayResult = { ok: true } | { ok: false; reason: CallRelayFailureReason; error: string }`.
- Peering resolution:
  1. If the peer row is `active` or `unreachable`, POST directly (the health check restores `unreachable` peers; re-handshaking is wasteful).
  2. Otherwise race `ensurePeered` against `opts.peeringTimeoutMs` (default `CALL_PEERING_TIMEOUT_MS = 3_000` ms). The background handshake is **not** aborted on race loss — a warn-logged catch is attached so a late-rejecting background promise does not emit `unhandledRejection`.
- Peer-state → reason mapping is exhaustive over the `EnsurePeeredResult` union (`active` / `rejected` / `pending` / `failed`) plus the external `timeout` branch. TypeScript `never` check in the switch default catches future additions. Note: the `livekit_unavailable` reason in `DmCallUndeliverableReason` is emitted separately from `sendFederatedCallStart`'s LiveKit pre-flight in `ws/events.ts`, not from this switch — `sendCallRelay` only produces `CallRelayFailureReason` values (`peer_rejected` / `peer_awaiting_approval` / `peer_transient_failure` / `post_failed`).
- Non-blocking mode: `peeringTimeoutMs: 0` (used by typing) skips the POST for non-active peers, kicks off `ensurePeered` as a background warm-up, returns `peer_transient_failure` silently.

**`sendTypingRelay(dmChannelId, eventType, userId)`**:

- Fire-and-forget to each remote DM participant's home instance via `sendCallRelay(origin, [event], { peeringTimeoutMs: 0 })`. Typing is an ephemeral hint — lost packets are acceptable and there is no user-facing failure surface.

**Call-start failure surfacing.** `sendFederatedCallStart` aggregates targeted-peer results and emits `dm_call_undeliverable { phase: 'start' }` to the caller for failed targeted peers. See `docs/systems/voice.md` and `docs/systems/websocket.md` for the event contract.

**Accept / reject / end relay discipline.** Every `handleDmCall{Accept,Reject,End}` Path-2 branch awaits `sendCallRelay` and emits `dm_call_undeliverable { phase, terminal, failures }` to the originator on failure. Accept is pessimistic-rollback (terminal: true — local `FederatedCallEntry` cleared, optimistic `dm_call_accepted` walked back via `sendToFederatedCallUsers`); reject and end are optimistic (terminal: false — state already cleared, informational toast only). Path-1 fan-outs via `sendFederatedCallAccept` / `sendFederatedCallEnd` / `fanOutCallEvent` return `CallFanoutFailure[]` and the host-side caller receives `dm_call_undeliverable { terminal: false }` listing peers that were not reached.

**Ring-timeout fan-out.** `ConnectionManager.createDmRoom`'s 60 s ringing auto-clean now invokes a registered hook (`setRingTimeoutFanoutHook`, registered from `ws/events.ts:registerCallRelayHooks`) that fans `dm_call_end` out to remote peers, so stranded Path-A/B ringees on other instances exit their ring state instead of lingering until their own 60 s cleanup fires.

### Call Flows

**Start:** Host validates membership, generates LiveKit tokens for all DM members (local + remote), broadcasts `dm_call_incoming` to local WS clients, then sends `dm_call_start` S2S to each remote instance with per-user tokens.

**Accept:** Remote instance sends `dm_call_accept` S2S to host. Host transitions `ringing → active`, broadcasts `dm_call_accepted` locally, fans out `dm_call_accept` to all other remote instances.

**Reject:** Remote sends `dm_call_reject` to host. Host destroys room, sends `dm_call_end` to all peers. (For 1-on-1 DMs, reject = end.)

**End:** Initiating instance (host or not) routes through the host. Host destroys room, fans out `dm_call_end` to all remote instances.

**Timeout:** Both host and remote instances auto-clean stale ringing calls after 60 seconds.

### LiveKit Room Naming

Room name = `federatedId` (the cross-instance stable UUID), never the local `dmChannelId` (which differs per instance).

- 1-on-1 DMs: `federatedId` is a deterministic SHA-256 hash of the sorted `homeUserId` pair
- Group DMs: `federatedId` is a UUID assigned at creation

### LiveKit Token Generation

`generateFederatedCallToken(roomName, homeUserId, displayName)` generates tokens with:
- **TTL:** 5 minutes (short join window; local calls use 1 hour)
- **Room:** scoped to exact `federatedId`
- **Identity:** `${homeUserId}:${displayName}`
- **Permissions:** full DM grants (mic, camera, screen share, subscribe, data channel)

### Public LiveKit URL

The URL sent in S2S payloads is always `https://${DOMAIN}/livekit` (the Caddy-proxied public address). The internal `LIVEKIT_URL` env var (`http://livekit:7880`) is never sent to peers.

Instances without LiveKit configured can still receive federated calls — they pass the host's URL and token to the client, which does all the heavy lifting.

### In-Memory Call Registry

When a remote instance receives `dm_call_start`, it creates a `FederatedCallEntry` in memory:

```typescript
interface FederatedCallEntry {
  dmChannelId: string;          // local dmChannelId for this DM
  federatedId: string;          // cross-instance room identifier
  callerId: string;             // local userId of caller's stub
  callerHomeUserId: string;
  federatedCallHost: string;    // peer origin of the host instance
  livekitUrl: string;
  tokens: Map<string, string>;  // homeUserId → LiveKit token
  state: 'ringing' | 'active';
  startedAt: number;
}
```

This registry ensures tokens and `livekitUrl` survive browser refreshes via the `activeCalls` array in the `ready` WS payload. The server filters to the per-user token at payload assembly time.

---

## 14. Background Workers

All workers are started by `startFederationWorkers()` on server boot and stopped by `stopFederationWorkers()` on shutdown. Each worker uses `setTimeout` chains (not `setInterval`) with abort controllers for graceful shutdown.

| Worker | Interval | Batch | Timeout | Source |
|--------|----------|-------|---------|--------|
| Outbox delivery | 10s | 50 | 30s | `processOutboxTick` |
| File download | 30s | 5 | 60s | `processFileQueueTick` |
| Health check | 15min | all unreachable | 10s | `processHealthCheckTick` |
| Janitor | 1h | -- | -- | `runFederationJanitor` (sync) |
| Startup bootstrap sync | Once at startup | -- | 30s per page | `startupBootstrapSync` → `onPeerActivated` |

### Janitor Cleanup (`storageJanitor.ts:runFederationJanitor`)

| Target | Condition | Retention |
|--------|-----------|-----------|
| `federation_outbox` | `expiresAt < now` | Configurable via `federationRelayTtlDays` (default 30) |
| `federation_mutation_log` | `mutatedAt < (now - 90 days)` | 90 days |
| `federation_file_queue` (completed) | `createdAt < (now - 7 days)` | 7 days |
| `federation_file_queue` (any) | `expiresAt < now` | 30 days (set at queue time) |
| `dm_channels` (soft-deleted) | `deletedAt < (now - 24h)` | 24-hour grace period |

DM channel hard-delete cascades: reactions, embeds, attachments (DB rows + disk files), messages, members, outbox entries, mutation log entries, file queue entries.

---

## 15. Settings Cache

`federationOutbox.ts` caches `federationRelayEnabled` and `federationRelayTtlDays` from `instance_settings` for 30 seconds (`CACHE_TTL_MS`). This prevents repeated DB reads on every message send. The cache is invalidated by TTL only -- there is no explicit cache bust on settings change.

Relevant settings in `instance_settings`:

| Column | Default | Purpose |
|--------|---------|---------|
| `federation_relay_enabled` | 1 | Master toggle for all federation relay |
| `federation_relay_ttl_days` | 30 | Outbox entry TTL |
| `max_upload_size_bytes` | `null` (uses `config.maxUploadSize`) | File download size limit |

---

## 16. Client-Side Identity Helpers (`identity.ts`)

The frontend needs to resolve federated identities for display purposes:

**`parseFederatedUsername(username)`** -- splits `"youruser@nova.ddns.net"` into `{baseName: "youruser", domain: "nova.ddns.net"}`.

**`isSelf(user, homeUser)`** -- determines if a user object is the logged-in user or their replicated stub. Uses cascading checks: same ID, known self-ID set, homeInstance + baseName match.

**`canonicalUserMatch(a, b)`** -- federation-safe check for whether two user objects represent the same person. Cascades through: same local ID, `homeUserId` cross-match, username + homeInstance fallback.

**`resolveDisplayIdentity(user, homeUser)`** -- returns `homeUser` for display if `user` is a replicated stub of `homeUser`, enabling consistent avatars and display names across instances.

**Cross-instance self-ID registry:** `registerSelfId(id)` / `clearSelfIds()` track all Snowflake IDs belonging to the current user across connected instances, populated from WS `ready` events.

---

## 17. Self-Healing Migrations (`migrate.ts`)

The migration system includes several data integrity checks that run on every server startup:

**Group DM ownerId repair:**
Detects group DMs with UUID-format `federated_id` (length 36, matches `________-____-____-____-____________`) but `NULL owner_id`. Restores the owner from the first remaining member or from `owner_home_user_id`/`owner_home_instance`. Root cause: a bug in `processOwnershipTransferEvent` (fixed in cd7aff0) could set `ownerId = NULL` via `resolveLocalUser` fallback.

**Federated ID backfill:**
Finds 1-on-1 DM channels without `federated_id`, computes deterministic SHA-256 hash from home user IDs, and sets it. Also detects relay-created duplicate channels with the same `federated_id` and merges messages into the oldest channel.

**Duplicate channel merge:**
Finds `federated_id` values appearing on multiple channels and merges them into the oldest, moving messages, members, and cleaning up the duplicates.

**Mutation log backfill:**
If the `federation_mutation_log` table exists but is empty, populates it with `create` entries for all existing DM messages where `source_instance IS NULL` (locally-created messages).

---

## Known Issues

See `docs/federation-production-roadmap.md` for open items (FED-001 through FED-013).

- **Accept/reject/end relay failures now surfaced.** All three federated call-state transitions emit `dm_call_undeliverable { phase, terminal, failures }` to the originator on relay failure — accept rolls back optimistic state (terminal: true), reject/end keep the optimistic clear and emit an informational toast (terminal: false). See `docs/systems/voice.md` "Call relay failure surface" for the full contract. The host-side ring timeout also fans `dm_call_end` out to peers so stranded Path-A/B ringees exit the ring. One remaining edge documented in voice.md: non-host end-relay failure leaves the host's local `activeDmCall` marker until manual cleanup.
