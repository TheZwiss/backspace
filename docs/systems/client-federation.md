# Client-Side Federation System

> **Companion spec:** This document covers the **client-side** multi-instance architecture. For server-to-server relay (HMAC auth, outbox pipeline, relay events, identity resolution), see [`federation.md`](federation.md). Both systems work together — S2S relay distributes data between servers, while this client system enables users to interact with multiple instances from a single app session.

Source files:
- `packages/web/src/stores/instanceStore.ts` — Core multi-instance connection management, token caching, topology sync
- `packages/web/src/hooks/useWebSocket.ts` — WebSocket multiplexing (one connection per instance), origin-aware event routing
- `packages/web/src/stores/spaceStore.ts` — Origin-aware space/channel store, `channelOriginMap`, `getChannelOrigin()`, `getApiForOrigin()`, DM deduplication
- `packages/web/src/utils/identity.ts` — Cross-instance user identity resolution (`isSelf`, `canonicalUserMatch`, self-ID registry)
- `packages/web/src/hooks/useInstanceConnect.ts` — Connection flow hook for the Connections UI
- `packages/web/src/components/modals/ConnectedInstances.tsx` — Connections settings panel

---

## Architecture Overview

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

When a user connects to a remote instance, the client creates (or logs into) an account on that instance. This is a **real account with a real bcrypt password** — not a replicated stub.

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

### API Client Resolution

```typescript
getApiForOrigin(origin: string): BackspaceApiClient
```

Returns the correct API client for the given origin. Uses a resolver pattern to break circular dependencies between stores:

- `instanceStore` registers the resolver at module init
- `spaceStore` exposes `getApiForOrigin()` which calls the registered resolver
- Consumers call `getApiForOrigin(getChannelOrigin(channelId))` to get the right client

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
4. On startup, client fetches registry from home via `GET`, merges with localStorage tokens

### API

- `GET /api/users/@me/federation-registry` — fetch registry + updatedAt
- `PUT /api/users/@me/federation-registry` — LWW whole-registry push

### Relationship to replicatedInstances

`replicatedInstances` continues to serve S2S topology relay — it tells the federation layer which peers to relay events to. The registry is a superset that also includes disconnected, unreachable, and auth-expired entries. The two are maintained independently.

---

## 8. Relationship to S2S Federation

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
