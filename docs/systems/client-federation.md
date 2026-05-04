# Client-Side Federation System

> **Companion spec:** This document covers the **client-side** multi-instance architecture. For server-to-server relay (HMAC auth, outbox pipeline, relay events, identity resolution), see [`federation.md`](federation.md). Both systems work together — S2S relay distributes data between servers, while this client system enables users to interact with multiple instances from a single app session.

Source files:
- `packages/web/src/stores/instanceStore.ts` — Core multi-instance connection management, token caching, topology sync
- `packages/web/src/hooks/useWebSocket.ts` — WebSocket multiplexing (one connection per instance), origin-aware event routing
- `packages/web/src/stores/spaceStore.ts` — Origin-aware space/channel store, `channelOriginMap`, `getChannelOrigin()`, `resolveUserOrigin()`, `getLayoutHomeOrigin()`, `getMyUserIdForOrigin()`, DM deduplication
- `packages/web/src/utils/crossStoreResolvers.ts` — Neutral module holding the cross-store resolver bindings (`_getApiForOrigin`, `_resolveOriginFromHostname`, `_getUserIdForOrigin`) + the WS-populated user-ID cache. Breaks a TDZ cycle between spaceStore and instanceStore; see "API Client Resolution" below
- `packages/web/src/utils/identity.ts` — Cross-instance user identity resolution (`isSelf`, `canonicalUserMatch`, self-ID registry)
- `packages/web/src/hooks/useInstanceConnect.ts` — Connection flow hook for the Connections UI
- `packages/web/src/components/modals/ConnectedInstances.tsx` — Connections settings panel

---

## Architecture Overview

**Client-side vs S2S federation by feature:**
- **Friend & DM relay are S2S.** Sending a friend request to `alice@orbit.tld` does not require having a federated account on `orbit.tld`; the sender's home server queues the relay (see `social.md` §6 outbound flow). DM messages are similarly relayed server-to-server once the initial channel exists.
- **Spaces are client-federated.** Joining a remote space still requires creating a federated account on that instance via the Connections UI.

Backspace supports **client-side federation**: a single app session (web or desktop — both are feature-identical) can connect to multiple Backspace instances simultaneously. The user has a **home instance** (their primary identity) and zero or more **connected remote instances**.

```
┌─────────────────────────────────────────────────┐
│               Electron / Web App                │
│                                                 │
│  ┌──────────────┐    ┌──────────────────────┐   │
│  │ Home Instance │    │ Remote Instance(s)   │   │
│  │ nova.ddns.net│    │ orbit.ddns.net│   │
│  │              │    │                      │   │
│  │ WS ──────────┤    │ WS ──────────────────┤   │
│  │ API ─────────┤    │ API ─────────────────┤   │
│  │ JWT ─────────┤    │ JWT ─────────────────┤   │
│  └──────────────┘    └──────────────────────┘   │
│                                                 │
│  instanceStore manages all connections          │
│  spaceStore merges data from all origins        │
│  channelOriginMap routes operations to origin   │
└─────────────────────────────────────────────────┘
```

**What this enables:**
- Join Spaces on any connected instance
- See friends across instances (friend discovery)
- DMs between users on different instances (via S2S relay — see [federation.md](federation.md))

**What each instance provides:**
- Its own JWT token and authenticated API client
- Its own WebSocket connection (heartbeat, events)
- Its own user identity (different Snowflake ID per instance)

---

## 1. Federated Account Creation

When a user adds a remote instance via the Connections settings to **join a space there**, the client creates (or logs into) an account on that instance. As of 2026-04-25, this is no longer required for friending or messaging users on a remote instance — those flows are fully S2S (see `social.md` §6 and `federation.md` §4 respectively). Federated accounts remain real loginable accounts and retain all capabilities (login, space membership, password sync, deletion).

This is a **real account with a real bcrypt password** — not a replicated stub.

### Username Format

| Account type | Username | passwordHash | homeInstance | Can log in? |
|---|---|---|---|---|
| Local (native) | `youruser` | bcrypt hash | `NULL` | Yes |
| Federated (client-created) | `youruser@nova.ddns.net` | bcrypt hash | `nova.ddns.net` | Yes |
| Replicated stub (S2S-created) | `youruser@nova.ddns.net` | `!federation-replicated` | `nova.ddns.net` | No |

Key distinction: **Federated accounts** and **replicated stubs** can have the same username format (`user@instance`), but federated accounts have real passwords and can log in. Replicated stubs are server-created placeholders for identity resolution and cannot log in.

The merge migration in `migrate.ts` detects when both exist for the same remote user and merges them (real account always wins).

### Connection Flow (`connectToRemote`)

When a user adds a remote instance via the Connections settings:

1. **Verify home password** — client confirms the user's password against the home instance
2. **Compute federated username** — `{bareUsername}@{homeHost}` (e.g., `youruser@nova.ddns.net`)
3. **Try registration** on remote instance with:
   - Username: `youruser@nova.ddns.net`
   - Password: same as home instance password
   - `homeInstance`: `nova.ddns.net` (bare domain)
   - `homeUserId`: user's Snowflake ID on home instance
4. **If registration fails** (account already exists) — fall back to login
5. **On success** — store JWT token, create API client, open WebSocket, sync profile

The same password is used across all instances. Password changes on the home instance are synced to remote instances automatically.

### API Client Error Contract

The shared API client (`packages/web/src/api/client.ts:298`) throws `new Error(body.error)` for non-2xx responses. The server's structured error code is on `err.message`; there is **no** `err.body` or `err.code` property. Catch handlers that need to map codes to UI messages should read `err.message` and pass it as both the code and the fallback to `mapServerErrorToMessage` (see `packages/web/src/utils/friendErrors.ts`).

This was documented after T19/T20 catch blocks initially read the wrong shape and surfaced raw codes as toast text — fixed in commit `d207af4`. The same pattern applies to any new client-side code that catches API errors from the home or remote instances.

---

## 2. Instance Store (`instanceStore.ts`)

The central store for multi-instance state.

### State

```typescript
interface ConnectedInstance {
  origin: string;           // 'https://orbit.ddns.net'
  label: string;            // Instance display name
  token: string;            // JWT for this instance
  user: User;               // User record on this instance
  username: string;         // e.g., 'youruser@nova.ddns.net'
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  error?: string;
  api: BackspaceApiClient;  // Authenticated API client
}

interface InstanceState {
  instances: ConnectedInstance[];
  _autoConnectDone: boolean;    // Has startup reconnection finished?
  pendingSyncOrigins: string[]; // Instances needing password sync
}
```

### Token Caching

Tokens are persisted to `localStorage` keyed by `backspace_instances_${userId}`. This allows automatic reconnection on app restart without re-entering passwords.

### Auto-Connect on Startup (`autoConnectAll`)

Called once per session after login:

1. Read `currentUser.replicatedInstances` from the home server (list of known remote origins)
2. Load cached tokens from `localStorage`
3. For instances **with cached tokens**: attempt reconnection in parallel — verify token, open WebSocket, sync profile
4. For instances **without cached tokens**: create error placeholders (visible in Connections UI with "re-authenticate" prompt)
5. Set `_autoConnectDone = true` to unblock topology sync

### Topology Sync (`syncInstanceList`)

After connections change, the client notifies all instances of the current topology. Each instance receives a perspective-correct list:
- **Home instance** gets: list of all remote origins
- **Remote instances** get: home origin + all other remote origins (excluding self)

This allows S2S federation to know which peers to relay to.

---

## 3. Origin-Aware Routing

### Origin String Convention

- `''` (empty string) = home instance
- `'https://domain.com'` = remote instance (full URL with protocol)

### channelOriginMap

Every channel (space channels and DM channels) is tagged with its origin instance:

```typescript
// In spaceStore:
channelOriginMap: Map<string, string>  // channelId → origin

// Usage:
getChannelOrigin(channelId): string    // Returns '' for home, origin URL for remote
```

Built during `populateFromReady()` when WS ready events arrive from each instance.

> **DM channels** are mapped to the origin of the instance that delivered them in the `ready` event. For 1-on-1 DMs created locally this is typically `''` (home), but federated DMs may arrive from any connected instance. DM read/write operations are routed to the channel's origin via `getApiForOrigin(getChannelOrigin(channelId))`. S2S relay then propagates changes to all other instances that have the same channel.

### DM Origin Failover

When a remote instance's WebSocket drops mid-session, every DM pinned to that origin is re-keyed to a connected sibling that mirrors the same federated DM (via S2S replication). This keeps DM operations working through a transient disconnect, at the cost of a brief message-cache flush on the rekeyed DMs.

**Mechanism:**

- `dmAlternatives: Map<federatedId, Map<origin, localChannelId>>` on `spaceStore` records every origin's local channel ID observed in any `ready` payload, regardless of whether the dedup pass kept that copy in `dmChannels`.
- `failoverDmOriginsFromDisconnected(origin)` in `utils/dmOriginFailover.ts` walks DMs pinned to the disconnected origin, looks up a connected alternate in `dmAlternatives` (preference: home first, then any connected remote in insertion order), and calls `rekeyDmChannel` to atomically rename the DM across `spaceStore`, `chatStore`, and the URL.
- `chatStore.rekeyChannelState(oldId, newId)` deletes all channel-keyed entries for `oldId` (messages, hasMore, scrollPositions, channelAccessTimes, typingUsers, readStates) without seeding `newId` — subscribers re-fetch from the new origin. `unreadChannels` membership transfers only if `oldId` was already unread. `currentChannelId` updates when it matches `oldId`.
- URL: `history.replaceState` swaps the path segment in place when the user is viewing the rekeyed DM — no router navigation.

**Triggers:** `instanceStore.setInstanceStatus` on `connected → disconnected|error`; `disconnectInstance` and `forceRemoveEntry` call failover before `removeInstanceSpaces` so DMs with connected alternatives survive user-initiated disconnect.

**Intentional UX trade-off:** on failover, the active DM's message cache is flushed (origin-local message IDs don't match the new origin's responses). A brief "loading" state appears while the chat view re-fetches. Documented intentionally — failover is a recovery path, not the hot path.

**Voice is out of scope.** LiveKit rooms are bound to the hosting origin and cannot migrate. `voiceStore.activeDmCall` / `outgoingCall` / `incomingCall` are not rewritten by failover; voice state clears through existing LiveKit disconnect paths.

**No re-home on reconnect:** when the originally pinned origin comes back, its `ready` re-adds its local id to `dmAlternatives` but leaves the new primary in place. Avoids flapping.

**WS event routing contract:** every DM WS event handler either routes via the primary `dmChannels` id (using `resolveDmChannelId(rawId)`) or silently no-ops on unknown ids. Only `dm_channel_created` creates new `dmChannels` entries — and it dedups by `federatedId` first.

Source: `utils/dmOriginFailover.ts` + extensions in `stores/spaceStore.ts`, `stores/chatStore.ts`, `stores/instanceStore.ts`, `hooks/useWebSocket.ts`. Design spec: `docs/superpowers/specs/2026-04-23-dm-origin-failover-design.md`.

### API Client Resolution

```typescript
getApiForOrigin(origin: string): BackspaceApiClient
```

Returns the correct API client for the given origin. Uses a resolver pattern to break circular dependencies between stores:

- The resolver backing, its setter (`setApiForOriginResolver`), and the getter (`getApiForOrigin`) live in `packages/web/src/utils/crossStoreResolvers.ts` — a neutral module with no store imports
- `instanceStore` imports the setter from the utility directly (not from `spaceStore`) and registers the resolver at module init
- `spaceStore` re-exports `getApiForOrigin` (and its sibling setters) from the utility for backward compatibility with existing import sites
- Consumers call `getApiForOrigin(getChannelOrigin(channelId))` to get the right client

The same pattern covers `resolveOriginFromHostname` (for `resolveUserOrigin`), the user-ID resolver (`resolveUserIdFromInstances`), and the WS-populated user-ID cache (`setMyUserIdForOrigin` / `getCachedUserIdForOrigin` / `clearMyUserIdCache`).

**Why the utility exists:** `instanceStore` runs top-level `setXResolver` calls at module load. If spaceStore holds the backing `let _getApiForOrigin` declaration AND the import chain reaches instanceStore while spaceStore is mid-load (e.g. via `JoinSpaceModal` importing `useInstanceStore` directly), the setter crashes with TDZ: `Cannot access '_getApiForOrigin' before initialization`. Hoisting the mutable bindings into a module that has no back-edges into the stores eliminates the cycle. Do NOT add imports from `./stores/*` into `crossStoreResolvers.ts` — doing so re-creates the exact cycle that module was carved out to break.

### User Origin Resolution

```typescript
resolveUserOrigin(user: { homeInstance?: string | null }): string
```

Determines which connected instance a user belongs to, based on their `homeInstance` field. Returns the origin string or `''` for local users.

---

## 4. WebSocket Multiplexing (`useWebSocket.ts`)

The client maintains **one WebSocket connection per instance** (home + each remote). Each connection has:
- Independent heartbeat (15-second ping via Web Worker)
- Exponential backoff reconnection
- Origin-aware event dispatching

### Sending

```typescript
wsSend(event, origin)    // Send to specific instance
wsSendAll(event)         // Broadcast to all instances
```

### Receiving

All incoming WS events pass through `handleEvent(origin, event)`. The `origin` parameter identifies which instance sent the event, enabling origin-aware state updates.

### Ready Event Processing

When a WS connection opens and authenticates, the server sends a `ready` event containing spaces, DM channels, voice states, etc. The client processes this via `populateFromReady()`:

1. Tag all spaces with `_instanceOrigin`
2. Merge into the unified space list (replacing stale data from same origin)
3. Build/update `channelOriginMap`, `channelToSpaceMap`
4. Normalize remote asset URLs to absolute paths
5. Merge DM channels from all origins — DMs are accepted regardless of which instance sends the `ready` event. Channels are deduplicated by `federatedId`: if a DM channel with the same `federatedId` is already loaded (from a previous `ready` event on another connection), the second copy is skipped (first-loaded copy wins). Channels without a `federatedId` are always accepted.
6. Last-write-wins layout merge for sidebar order

---

## 5. Cross-Instance Identity (`identity.ts`)

Users have **different Snowflake IDs on each instance**. The identity system resolves these:

### Self-ID Registry

```typescript
registerSelfId(id)   // Called on each WS ready event
isSelf(user)         // Checks all registered IDs
```

Tracks all IDs belonging to the current user across instances.

### Display Identity Resolution

```typescript
resolveDisplayIdentity(user, homeUser): User
```

If a user is `isSelf()`, returns the home user for consistent avatar/display name rendering. Prevents the same person appearing with different profiles across instances.

### Canonical User Match

```typescript
canonicalUserMatch(a, b): boolean
```

Determines if two user records represent the same person across instances. Cascade: same local ID → same homeUserId → username+homeInstance match.

---

## 6. Connections Settings UI

The **Connections** panel (in user settings) allows managing remote instance connections:

- **Home Instance** — always shown, cannot be removed. Desktop app has a "Change" button.
- **Remote Instances** — each shows status (connected/disconnected/error), hostname, username. Actions: Reconnect, Re-authenticate, Sync Password, Disconnect.
- **Add Instance** — multi-step form: enter hostname → verify password → register/login → connected.

### Add-Instance Pre-Flight: `federatedRegistrationOpen`

The hostname-probe step calls `GET /api/instance/info` on the target. The response carries two registration fields:

```typescript
{ name, version, registrationOpen: boolean, federatedRegistrationOpen: boolean }
```

`federatedRegistrationOpen` is the gate for **creating a federated `username@thisInstance` account** via the Connections flow. When the probe returns `federatedRegistrationOpen === false`, `ConnectedInstances.tsx` (the AddInstanceFlow's password step) renders an amber-tinted banner above the password input:

> "This instance has disabled new federated registrations. Existing accounts can still sign in."

**The submit button stays enabled.** This is the [login-unaffected invariant](auth.md#3-registration-flow) made operational on the client. The flow runs through `instanceStore`'s register-then-login fall-through:
- A user **without** an existing federated account on the target — register attempts 403 with `Federated registration is closed on this instance`; login attempts then fail with the existing "no account" error; the user sees the post-error toast.
- A user **with** an existing federated account on the target — register 403s, then login succeeds against their existing credentials. Working path preserved for legitimate re-login.

Disabling submit would extend the gate into login territory and soft-lock users with existing accounts on a closed instance — exactly the failure mode the invariant prevents. The 403 server-side stays as the security boundary; the banner is a UX hint.

The probe response is not cached client-side beyond the in-flight request, so toggle flips on the target are observed on the next add-instance attempt without explicit invalidation.

### Identity Deletion

Each remote instance row exposes an identity deletion flow with three modes:

| Mode | Label | Behavior |
|------|-------|----------|
| `leave` | Leave quietly | Client-only disconnect; no server call. Registry entry removed locally. |
| `soft` | Delete User | S2S soft delete — anonymizes the remote account and removes memberships; message history is retained. |
| `full` | Nuke everything | S2S full tombstone — soft delete plus purge of DM data and reactions. |

A scope selector controls which remotes are targeted: **This instance** (single remote) or **All remote instances** (fans out to every connected remote). A "Select instances" option is planned for future multi-select.

Deletion is triggered via `POST /api/users/@me/federation-identity/delete` on the home instance (rate-limited 5/15 min). The home instance fans out HMAC-signed `DELETE /api/federation/identity` requests to each target remote in parallel and returns a per-origin results map `{ [origin]: { success, error?, ownedSpaces? } }`. If a remote reports owned spaces (`409`), the UI surfaces the space list so the user can resolve ownership before retrying.

---

## 7. Federation Registry

The federation registry is a persistent server-side record of all instances a user has federated with. Unlike the `replicatedInstances` field (which serves S2S topology relay), the registry tracks the full lifecycle of each connection.

### Storage

- **Server:** `user_federation_registry` table — composite PK `(userId, origin)`
- **Client:** `registry` Map in `instanceStore` (Zustand)
- **LWW timestamp:** `federationRegistryUpdatedAt` on `users` table

### Lifecycle States

| State | Meaning |
|-------|---------|
| `connected` | Active WebSocket, valid token |
| `disconnected` | User intentionally disconnected; account exists on remote |
| `unreachable` | Remote is down/unresponsive |
| `auth_expired` | Token invalid; needs re-authentication |

### Sync Pattern

Client-driven LWW whole-registry push (same pattern as `profileSync.ts`):
1. User mutates registry → `registryUpdatedAt = Date.now()`
2. Client calls `PUT /api/users/@me/federation-registry` on all connected instances
3. Server rejects if `updatedAt <= stored` (409 Conflict)
4. On startup, client fetches registry from home via `GET`, merges with localStorage tokens, and seeds any `replicatedInstances` entries that aren't yet in the registry (with status `auth_expired`) so users with pre-feature data — or whose initial GET failed — still see their connections in the UI

### Sync-Ready Gate

`PUT` is gated behind an in-memory `_registrySyncReady` flag that is set true **only after a successful initial GET** in `autoConnectAll`. Until that flag flips, `syncRegistry()` is a no-op (and `autoConnectAll` does not call it).

**Why:** without this gate, a transient GET failure would leave the local Map empty/incomplete, but `set()` would still compute `registryUpdatedAt = Date.now()` (since `serverRegistryUpdatedAt = 0`). The trailing `syncRegistry()` would PUT the empty payload with a fresh-now timestamp; the server's LWW guard (`updatedAt > stored`) accepts it, and legitimate registry rows are wiped — including remote-instance entries the user never explicitly removed.

**Degraded mode (GET failed):**
- Registry Map is populated locally from `replicatedInstances` synthesis (display-only) so the UI still shows the user's known remotes as `auth_expired`.
- Mutations (`connectToRemote`, `disconnectInstance`, `reconnectInstance`, etc.) still update the local Map but **do not push** to home — `syncRegistry()` short-circuits.
- On the next session where GET succeeds, `localStorage` cached tokens reseed the registry and `syncRegistry()` pushes the merged authoritative state. No data is lost; sync is just deferred until we have a complete picture to merge against.

`reset()` (logout/account switch) clears `_registrySyncReady` along with the registry Map.

### API

- `GET /api/users/@me/federation-registry` — fetch registry + updatedAt
- `PUT /api/users/@me/federation-registry` — LWW whole-registry push

### Relationship to replicatedInstances

`replicatedInstances` continues to serve S2S topology relay — it tells the federation layer which peers to relay events to. The registry is a superset that also includes disconnected, unreachable, and auth-expired entries. The two are maintained independently.

---

## 8. Outbound Peering Gate (client surfaces)

When the local instance has `autoAcceptPeering=0`, every outbound new-peer attempt funnels through the centralized [Outbound Peering Gate](federation.md#outbound-peering-gate) on the server. The client surfaces three things: a new error code on the friend-add path, a new peering-status value on `/peer/ensure`, and two new Connections-settings panels (pending and outcomes).

### Peering-status taxonomy (`/peer/ensure` response)

`peeringStatus` returned from `POST /api/federation/peer/ensure` now includes `'admin_required'` alongside the existing `'active' | 'pending' | 'awaiting_approval' | 'rejected' | 'unreachable' | 'revoked'`. `'admin_required'` means: gate fired locally, your own admin must approve before any traffic reaches the wire. The user's request becomes admin-approvable rather than auto-firing.

### Friend-add error mapping (`peer_pending_local_admin`)

`POST /api/social/requests` returns 409 `peer_pending_local_admin` when the gate fires for a never-peered remote target (the user's request is queued + subscriber-tracked on the server; admin must approve).

`packages/web/src/utils/friendErrors.ts` maps `peer_pending_local_admin` to:

> "Your admin needs to approve federation with this instance. You'll see your request in Connections settings."

The catch handler reads `err.message` (per the API client error contract documented in §1) and passes it to `mapServerErrorToMessage`. Distinct from `peer_pending_approval` ("the *remote* admin must approve") — this one is local-admin gating.

### Connections settings — Pending peering approvals

A new section in the Connections settings UI (alongside the federation registry) lists the calling user's rows from `peer_approval_subscribers`, joined to parent `peer_approval_requests`. Each row renders:

- "Awaiting your admin's approval to federate with `{peerOrigin}` so you can `friend_add → alice@orbit`."
- A Cancel button. Cancel calls `DELETE /api/federation/peering-subscriptions/:id`. If the cancelled row was the last subscriber for the parent, the parent cascades and disappears from the admin's queue too.

Live updates: a `peering_subscription_changed` WebSocket event refetches the list.

### Connections settings — Recent peering outcomes

A second new section above the pending list shows unread `peer_approval_notifications` rows ordered by `createdAt DESC`. Each row's copy branches on `kind`:

- **`approved`** — "Your peering request to `{peerOrigin}` was approved — retry your friend-add to `{triggerTarget}`?" `[Retry]` `[Dismiss]`. Retry deep-links to the friend-add UI prefilled with the original target. Today only the `friend_add` reason produces a retry deep-link; future trigger reasons add their own deep-link flows. Dismiss POSTs to `/peering-notifications/:id/read`.
- **`denied`** — "Your peering request to `{peerOrigin}` was denied by your admin." `[Dismiss]`.
- **`expired`** — "Your peering request to `{peerOrigin}` expired without admin action." `[Dismiss]`.

A "Mark all as read" action POSTs to `/peering-notifications/read-all`. Read rows hide from view (soft-delete preserves audit; the storage janitor cleans up read rows older than 30 days).

Live updates: a `peering_notification_received` WebSocket event refetches the list and may surface a transient toast for the matching `kind` (online users only).

### Federation store slice

A new `federationStore.ts` slice (separate from `instanceStore`) holds:

- `peeringSubscriptions: PeeringSubscriptionSummary[]`
- `peeringNotifications: PeeringNotificationSummary[]`
- `pendingFriendAddPrefill?: { username: string }` — side-channel populated by the Retry button on `kind='approved'` notifications, consumed by the friend-add modal on next open.

This slice is intentionally separate from `instanceStore` because the data is per-user (not per-instance) and lives on the home server only. WebSocket handlers route `peering_subscription_changed` and `peering_notification_received` events into this slice's refetch actions.

---

## 9. Relationship to S2S Federation

Client-side and S2S federation serve different purposes:

| Aspect | Client-Side Federation | S2S Federation |
|---|---|---|
| **Purpose** | User interacts with multiple instances | Instances exchange data automatically |
| **Scope** | Spaces, DM access, friend discovery | DM relay, friend relay, file replication, read state sync |
| **Authentication** | Per-user JWT on each instance | Per-peer HMAC shared secret |
| **Initiated by** | User (Connections settings) | Admin (peer handshake) |
| **Connection** | Client → each server directly | Server → server via outbox |

**How they work together:**
1. User adds a remote instance via Connections (client-side)
2. The client triggers S2S peering between the two servers (automatic)
3. User joins Spaces on the remote instance (client-side — API calls go directly to remote)
4. User sends DMs — DM writes go to whichever instance delivered the channel (determined by `channelOriginMap`). S2S relay distributes messages, reactions, read states, and membership changes to all peer instances. DM calls remain home-only (gated for federated users).
5. Friend requests and discovery work across instances (client loads friends from all connected instances, S2S relays friend events)
