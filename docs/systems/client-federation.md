# Client-Side Federation System

> **Companion spec:** This document covers the **client-side** multi-instance architecture. For server-to-server relay (HMAC auth, outbox pipeline, relay events, identity resolution), see [`federation.md`](federation.md). Both systems work together — S2S relay distributes data between servers, while this client system enables users to interact with multiple instances from a single app session.

Source files:
- `packages/web/src/stores/instanceStore.ts` — Core multi-instance connection management, token caching, topology sync
- `packages/web/src/hooks/useWebSocket.ts` — WebSocket multiplexing (one connection per instance), origin-aware event routing
- `packages/web/src/stores/spaceStore.ts` — Origin-aware space/channel store, `channelOriginMap`, `getChannelOrigin()`, `resolveUserOrigin()`, `getLayoutHomeOrigin()`, `getMyUserIdForOrigin()`, DM deduplication
- `packages/web/src/utils/crossStoreResolvers.ts` — Neutral module holding the cross-store resolver bindings (`_getApiForOrigin`, `_resolveOriginFromHostname`, `_getUserIdForOrigin`) + the WS-populated user-ID cache. Breaks a TDZ cycle between spaceStore and instanceStore; see "API Client Resolution" below
- `packages/web/src/utils/identity.ts` — Cross-instance user identity resolution (`isSelf`, `canonicalUserMatch`, self-ID registry)
- `packages/web/src/components/modals/ConnectedInstances.tsx` — Connections settings panel
- `packages/web/src/components/modals/RemotePasswordStep.tsx` - the password/fallback-login step shared by the Connections add-instance flow and the directory's connect-and-join dialog
- `packages/web/src/components/modals/ConnectAndJoinModal.tsx` - connect-then-join from an Outer Space card (see [directory.md](directory.md) §9)

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

When a user adds a remote instance via the Connections settings to **join a space there**, the client creates (or logs into) an account on that instance. As of 2026-04-25, this is no longer required for friending or messaging users on a remote instance — those flows are fully S2S (see `social.md` §6 and `federation.md` §4 respectively). Federated accounts remain real loginable accounts and retain all capabilities (login, space membership, deletion). Since 2026-09-02 they no longer share the home password: each one authenticates with a per-remote secret the home instance issues (see "Per-Remote Credentials" below and `auth.md` §5b).

This is a **real account with a real bcrypt password** — not a replicated stub.

### Username Format

| Account type | Username | passwordHash | homeInstance | Can log in? |
|---|---|---|---|---|
| Local (native) | `erin` | bcrypt hash | `NULL` | Yes |
| Federated (client-created) | `erin@nova.ddns.net` | bcrypt hash | `nova.ddns.net` | Yes |
| Replicated stub (S2S-created) | `erin@nova.ddns.net` | `!federation-replicated` | `nova.ddns.net` | No |

Key distinction: **Federated accounts** and **replicated stubs** can have the same username format (`user@instance`), but federated accounts have real passwords and can log in. Replicated stubs are server-created placeholders for identity resolution and cannot log in.

The merge migration in `migrate.ts` detects when both exist for the same remote user and merges them (real account always wins).

### Per-Remote Credentials

The password the user types is a credential for **one** instance — their home. It is never forwarded to any other instance. Instead the home instance issues a distinct high-entropy secret per remote origin (`POST /api/users/@me/federation-credential`, backed by `user_federation_credentials`), and that secret is what the remote account is registered and logged in with. Full contract in `auth.md` §5b; table in `database.md`.

Two consequences shape the client:

- **Credentials are minted by the account's TRUE home, not by the instance being browsed.** `resolveCredentialHomeApi()` returns the home connection's API client (the primary connection when browsing home natively, else a connected secondary instance for the home domain). If two instances each issued their own secret for the same remote, the remote account would end up with one of them and the user would be locked out of it everywhere else. When no home session is available, `connectToRemote` fails with a message naming the home rather than minting a divergent secret. A detached account (`federationHomeOrphaned`) is sovereign and issues its own.
- **`ensureRemoteCredential(instance, { force? })` is the single reconciliation point.** Every path that establishes a remote session calls it — `connectToRemote`, `loginToRemote` (with `force`), and the token reconnect in `autoConnectAll`. It rotates the remote account onto the issued secret when the home's `provisioned` flag says the account may still carry something else, and refuses unless the remote account is this user's own federated identity (`homeInstance` **and** `homeUserId` both match).

### Connection Flow (`connectToRemote`)

When a user adds a remote instance via the Connections settings:

1. **Target is the account's own home** — log in with the entered password under the bare username. Nothing below applies.
2. **Resolve the home API client** — `resolveCredentialHomeApi()`; if there is no home session, throw naming the home instance.
3. **Verify the entered password against the home instance** — `homeApi.users.verifyPassword`. The target never sees it.
4. **Fetch the per-remote secret** — `homeApi.users.federationCredential({ origin })`.
5. **Compute federated username** — `{bareUsername}@{homeHost}` (e.g., `erin@nova.ddns.net`)
6. **Try registration** on the remote instance with:
   - Username: `erin@nova.ddns.net`
   - Password: **the issued secret**
   - `homeInstance`: `nova.ddns.net` (bare domain)
   - `homeUserId`: user's Snowflake ID on home instance
7. **If registration is refused** because the username is taken or because the instance is closed to new accounts, log in with the issued secret. A migrated account on a closed instance still gets in this way. There is deliberately **no** retry with the entered password. If that login fails, `connectToRemote` throws `RemoteLoginRequiredError` and the caller offers the explicit per-instance login form, where the user chooses what to send. The error's `reason` records which refusal came first, and it is the only thing that decides what the form's notice may claim:

   | Registration answered | `reason` | Code (`describeError`) | What the notice says |
   |---|---|---|---|
   | 409 (`username_taken`, or no code from an older remote) | `credential-refused` | `federation_different_password` | An account exists there and refused the issued credential; sign in with the password set on that instance |
   | 403 (`federated_registration_closed`; `registration_closed`, `invite_required` or no code from an older remote) | `registration-closed` | `federated_registration_closed` | The instance takes no new accounts from other instances; *if* the user has an account there, sign in with it |

   Only the first may say an account exists. On a closed instance the client cannot know: the server's closed gate answers before any username check (`routes/auth.ts`), and a refused login says `invalid_credentials` whether the account is missing or has another password. Any other registration failure is rethrown. `FallbackNotice` in `RemotePasswordStep.tsx` is the one place the notice is worded; all five surfaces that offer the login render it.
8. **On success** — mark the credential provisioned, store JWT token, create API client, open WebSocket, ask the home instance to peer (below), sync profile

### Home-instance peering on every session (`peerHomeWithRemote`)

DMs a user writes on a remote reach their home instance over the S2S peering between the two, and the home instance only starts one when asked (`POST /api/federation/peer/ensure`). `peerHomeWithRemote(origin, announceAs)` in `instanceStore.ts` is the one place that asks, and every path that opens a session on a remote calls it once the session is live:

| Path | `announceAs` |
|---|---|
| `connectToRemote` (and `reauthenticateInstance`, which runs it) | instance label |
| `loginToRemote`, the explicit per-instance login; `directoryStore.loginAndJoin` reaches it through this | instance label |
| `reconnectInstance`, a token resume | `null` |
| `autoConnectAll`, each cached session that verifies | `null` |

Every call states `reason: 'instance_connect'`, which is what the home admin's approval queue (Instance settings, Federation: "connected an account on {host}") and the user's pending list ("Connect to {host}") show when the home instance has auto-accept off. The admin who sees it is the home instance's own, since the outbound gate runs there; the remote learns no reason. With a label, a `rejected` answer shows a warning toast (`federation:connections.peering.unavailable`) and a transient `pending` an info toast (`…peering.inProgress`); with `null` the call is silent. It never throws: a session is usable without peering. The server answers an already-settled peering from its peer row without charging the per-user limit on that endpoint (see [federation.md](federation.md#admin-endpoints)), which is what makes asking on every session affordable. Before this, `loginToRemote` and `reconnectInstance` did not ask, so a session reached through the different-password fallback (including the directory's join) had no peering until the next app start, and the rate limit meant a user with more than three connections was not peered for all of them even then.

Password changes on the home instance are **not** propagated to remote instances — there is nothing to propagate, since no remote holds the home password.

### Automatic Re-Attach on Connect (`maybeAutoReattach`, re-attach spec §3.4)

When a home instance is reset, its established accounts on peers become **detached** (`federationHomeOrphaned = 1`) — sovereign local accounts nothing from the old domain can re-bind. The owner who re-registers on the reset home under the same username + password would otherwise end up with two permanently forked identities. `maybeAutoReattach(instance)` (exported from `instanceStore.ts`) closes that gap as the **primary** re-link UX, and runs fire-and-forget right after `connectInstance(...)` in **both** `connectToRemote` and `loginToRemote`.

It performs the proof exchange **only** when all hold (else it returns silently — the manual fallback stays available):

1. The just-connected account is detached (`user.federationHomeOrphaned && user.homeInstance`).
2. This client also holds an authenticated session on the account's **home domain** — the primary connection when browsing it (native primary user, host matches), else a `status === 'connected'` secondary instance in `instances`.
3. That home session's username base equals the detached account's username base (case-insensitive, via `parseFederatedUsername`) — the unambiguous "same name" case. A cross-name bind is manual-only (spec §2).

Exchange: `homeSession.api.auth.attachProof(peerHost)` → `POST /api/auth/attach-proof` mints a one-time token on the home; `instance.api.users.reattach({ token })` → `POST /api/users/@me/reattach` on the peer verifies it over S2S and re-binds. On success the connection's `user`/`username` and the registry entry are updated, a "re-linked" toast fires, and `syncRegistry()` runs. On failure it only `console.warn`s — the connection itself is never torn down.

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
  username: string;         // e.g., 'erin@nova.ddns.net'
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  error?: string;
  api: BackspaceApiClient;  // Authenticated API client
}

interface InstanceState {
  instances: ConnectedInstance[];
  _autoConnectDone: boolean;    // Has startup reconnection finished?
}
```

### Token Caching

Tokens are persisted to `localStorage` keyed by `backspace_instances_${userId}`. This allows automatic reconnection on app restart without re-entering passwords.

### Auto-Connect on Startup (`autoConnectAll`)

Called once per session after login:

1. Read `currentUser.replicatedInstances` from the home server (list of known remote origins)
2. Load cached tokens from `localStorage`
3. For instances **with cached tokens**: attempt reconnection in parallel — verify token, open WebSocket, ask the home instance to peer (`peerHomeWithRemote`, silent), sync profile
4. For instances **without cached tokens**: create error placeholders (visible in Connections UI with "re-authenticate" prompt)
5. Set `_autoConnectDone = true` to unblock topology sync

`waitForAutoConnect()`, exported next to the store, resolves once that flag is set (immediately when it already is, with a re-check after subscribing so a flip between the check and the subscription is not missed). Every fan-out over connected instances (`exploreStore`, `socialStore`, `discoverStore`, `utils/mutuals.ts`) awaits it first.

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

### Channel index and lookup maps

Every channel (space channels and DM channels) is tagged with its origin instance. One record holds the space channels; the maps readers use are derived from it and from the DM view, and are never written in place.

```typescript
// In spaceStore:
spaceChannelIndex: ReadonlyMap<string, { spaceId, origin, type }>  // every visible space channel, open space or not

// Derived after every change (stores/spaceChannels.ts, deriveChannelLookups):
channelToSpaceMap: ReadonlyMap<string, string>   // space channelId → spaceId
channelOriginMap:  ReadonlyMap<string, string>   // channelId → origin: space channels + pinned DM copies
voiceChannelIds:   ReadonlySet<string>

// Usage:
getChannelOrigin(channelId): string    // Returns '' for home, origin URL for remote
```

- **Writers.** Only `spaceStore` actions change the index, each through the pure operations of `stores/spaceChannels.ts`: `populateFromReady` (an origin's listing replaces that origin's entries), `addSpaceFromReady`, `loadSpaceDetail` and `applyChannelLayout` (the space's complete visible set: entries it no longer lists are dropped, with their chat state), `upsertChannel` (`channel_created`, `channel_updated`, create/update responses), `removeChannel` (`channel_deleted`, `deleteChannel`), `removeSpace`, `removeInstanceSpaces`. `channelPermissions` and the space entries of `channelLastMessageIds` change in the same step. The WS `channel_*` and `category_*` handlers only call these actions.
- **Every change replaces the maps**, so a component that selects a map, or uses it as a memo input, re-renders on every change. Every map and set field of the store is typed `ReadonlyMap`/`ReadonlySet`; an in-place write does not compile.
- **A channel leaving and re-entering view.** An override change sends a user who loses `VIEW_CHANNEL` `channel_deleted` and one who regains it `channel_updated` (`routes/channels.ts` `broadcastOverrideChange`). `upsertChannel` writes the index entry whatever space is open, so a remote channel that comes back routes to its instance again.
- **DM entries** of `channelOriginMap` and `channelLastMessageIds` come only from the DM merge module (see "DM Origin Failover").
- **`categoryOriginMap`** (categoryId → origin) is replaced by the same actions and by `upsertCategory` / `removeCategory`.

**Channel kind.** `getChannelKind(channelId)` answers `'space'` (in the index), `'dm'` (a listed DM or another instance's copy of one, `locateDmChannel`) or `'unknown'` (no listing or event has named it: before the `ready` of the instance that holds it, or after it was deleted or hidden). The answer never comes from the URL. `isDmChannel` is `kind === 'dm'`; render code reads the reactive `useIsDmChannel`, which is `undefined` while unknown. What unknown means per caller: `loadMessages`/`loadMessagesAround` return without fetching (the `ready` handler reloads the open channel); `MessageList` does not show the missing-permission text and waits; `MessageInput` stays locked, since nothing can be routed yet; a pending bubble restored at boot is dispatched only once its channel is known (`pendingMessageRehydrate`); an alert treats it as not a DM.

> **DM channels** are mapped to the origin of the instance that delivered them in the `ready` event. For 1-on-1 DMs created locally this is typically `''` (home), but federated DMs may arrive from any connected instance. DM read/write operations are routed to the channel's origin via `getApiForOrigin(getChannelOrigin(channelId))`. S2S relay then propagates changes to all other instances that have the same channel.

### DM Origin Failover

A client connected to several instances receives one federated DM under several channel ids, one per instance that holds a copy (copies are mirrored on purpose, see `federation.md`). One module decides which copies are one conversation and which copy the user sees: `stores/dmConversations.ts` (ADR 0002, `docs/decisions/0002-dm-conversation-identity.md`). It is pure functions over its own state; `spaceStore` holds that state as `dmConversations` and calls the operations.

**State.** A conversation is `{ key, copies: Map<origin, DmCopy>, pinnedOrigin }`, a copy is `{ origin, channel, keySource }`, at most one copy per key and origin. The key is the `federatedId` a server stated (or the client derived for a 1.6.1 peer, see below), otherwise `local:<origin>:<channelId>`, which matches no other copy. `keySource` records where the key came from, as client state only:

| `keySource` | Meaning |
|---|---|
| `stated` | A server sent a string. |
| `stated-null` | A server sent `null`. Never derived, never folded into another copy. On a current server this is a group no other instance holds; on an older one it can also be an unkeyed 1-on-1. |
| `derived` | Derived from the members for a peer on 1.6.1 or older. |
| `unknown` | No server has stated a key for this id yet (the entry for an unplaced message). The next listing that contains the id replaces it. |

The module also keeps `unavailableOrigins`, the origins whose socket dropped.

**Operations.** Each returns the next state and the pin moves it caused.

| Operation | Called for |
|---|---|
| `mergeOriginListing(origin, listed, derivedKeys)` | `ready` (`populateFromReady`) and `GET /api/dm` reloads (`reloadDmsForOrigin`). Replaces every copy from that origin and marks it reachable. |
| `upsertCopy(origin, channel, keySource)` | `dm_channel_created` and the create responses (store action `upsertDmCopy`). Returns the channel id of the conversation's pinned copy, which is where the UI navigates. |
| `upsertUnplacedCopy(origin, message)` | A message no listing placed (`placeUnplacedDmMessage`). The module builds this placeholder; nothing else builds a `DmChannel`. |
| `removeCopy(channelId)` | `dm_channel_closed`, close, leave. Removing the pinned copy removes the conversation, as closing a row always did; its other copies come back with their origins' next listing or event. |
| `patchCopy(channelId, patch)`, `patchEveryCopy(patch)` | Members, owner, metadata, last message (`patchDmCopy`, `addDmMember`, `updateDmOwner`, ...), user updates. The copy with that id is patched, whichever origin it is from. |
| `setOriginAvailable(origin, available)` | `instanceStore.setInstanceStatus` on `connected -> disconnected/error` (store action `setDmOriginAvailable`). |
| `dropOrigin(origin)` | The DM part of `removeInstanceSpaces` (`disconnectInstance`, `forceRemoveEntry` and the other instance removals). |

**Pin rule.** The copy of the user's home (`getLayoutHomeOrigin()`) when it is present and reachable; else the current pin, if its copy is present and reachable; else the first reachable copy in the order the client learned them. With no copy reachable the pin stays. A returning sibling never takes the pin back; the returning home does. Home is preferred because relays only reach instances that host a participant, and the user's home always hosts one: a DM first announced by a sibling that hosts nobody would otherwise stay pinned there, and the other person's replies, relayed only to home, would never appear.

**Derived view.** After every operation `spaceStore` derives, and writes nowhere else: `dmChannels` (the pinned copy of each conversation, its `federatedId` set to the conversation key or `null`, sorted by `sortDmChannels`), `dmAlternatives` (key to origin to channel id for every copy of every keyed conversation, the index `resolveDmChannelId` reads), and the DM entries of `channelOriginMap` and `channelLastMessageIds` (the pinned ids only). `resortDmChannels` re-sorts the view when unread state or the selection changes. `findExistingDmForUser` remains a lookup that saves a `POST`; it does not decide identity.

**Pin moves.** When a row's channel id changes (failover, the home copy arriving, an instance removed, an unplaced entry turning out to be a copy of a listed conversation), `applyDmPinMoves` (`utils/dmOriginFailover.ts`) makes the row's state follow it:

- `chatStore.rekeyChannelState(oldId, newId)` deletes all channel-keyed entries for `oldId` (messages, hasMore, scrollPositions, channelAccessTimes, typingUsers, readStates) without seeding `newId`: subscribers re-fetch from the new origin. `unreadChannels` membership transfers only if `oldId` was already unread. `currentChannelId` updates when it matches `oldId`.
- URL: `history.replaceState` swaps the path segment in place when the user is viewing the moved DM. No router navigation.

**Failover.** When a remote socket drops, `setDmOriginAvailable(origin, false)` moves every row pinned there to a reachable copy by the pin rule. The dropped origin's copies stay, so when its next `ready` arrives (`mergeOriginListing` marks it reachable again) the pin rule can move a row back if that origin is the user's home. A user-initiated disconnect or removal drops the origin's copies (`dropOrigin`): a row with a copy elsewhere moves to it, a row without one disappears.

**Intentional UX trade-off:** on a pin move, the moved DM's message cache is flushed (origin-local message IDs don't match the new origin's responses). A brief "loading" state appears while the chat view re-fetches.

**Voice is out of scope.** LiveKit rooms are bound to the hosting origin and cannot migrate. `voiceStore.activeDmCall` / `outgoingCall` / `incomingCall` are not rewritten by a pin move; voice state clears through existing LiveKit disconnect paths.

**WS event routing contract:** every path that learns of a DM copy hands it to the merge module; nothing else writes the DM list. DM WS events that name a channel either route via the primary `dmChannels` id (`resolveDmChannelId(rawId)`), patch the copy with that id, or no-op on unknown ids. `dm_channel_created` and `dm_message_created` are the two events that can add a conversation; both go through `utils/dmMessageRouting.ts`:

- `applyIncomingDmChannel` calls `upsertDmCopy(origin, channel, 'stated')`. A copy of a conversation already listed from another origin joins it, so the origin's later events for that conversation resolve, and a home copy takes the pin.
- `applyIncomingDmMessage` places a message by channel id only. An id `resolveDmChannelId` does not know is looked up by re-reading that origin's DM list (`reloadDmsForOrigin`, one in-flight load per origin). If the list still does not place it, the message gets an entry of its own under that origin (`placeUnplacedDmMessage`, key source `unknown`).
- **The UI create sites** (`UserProfilePopout`, `UserProfileModal`, `FriendsPage`, `DmSearchBar`, `NewDmModal`, `AddDmMemberModal`) call `upsertDmCopy('', channel, 'stated')` with the server's answer and navigate to the id it returns, so a DM the client already shows from another instance lands in its one row. A request to an instance names a conversation by that instance's own copy (`dmCopyOnOrigin(id, origin)`). `AddDmMemberModal` sends both of its requests to home: a group from a 1-on-1 names home's copy as `fromDmChannelId` and the partner as home's row for them, or, when home holds no copy, no source id and the partner by their home identity; an add to a group goes to home's copy id, and when home holds no copy the modal shows its failure message instead of sending another instance's id.
- **Peers that list DMs without the key.** Current servers list DMs in the `ready` shape (`dm-system.md` "DM Channel List"). Servers up to 1.6.1 left out `federatedId` and the group metadata, and the client may be connected to such a peer; their payloads are typed `PeerDmChannel` (`utils/dmConversationKey.ts`), which only the merge module reads. Its `completePeerListing` completes each entry: (1) a field that is absent takes the value of the previous copy with that origin and channel id, the key's source included, unless that was `unknown`, so a row the client saw in that origin's `ready` keeps what `ready` stated, `null` included; (2) a 1-on-1 still without a key takes the key the server would have computed, which `deriveMissingOneOnOneKeys` hashes from the two members' home user ids exactly as the server does, only when a member has a home instance elsewhere and only in a secure context (Web Crypto); (3) a derived key shared by another entry of the same listing is dropped, since the peer then holds two rows for one pair and folding them would hide one; (4) otherwise the key is `unknown`. Two cases still show a 1.6.1 peer's copy as its own row until the next `ready`: a page not served from a secure context skips the derivation, and a group key is a random UUID that cannot be derived. These rules go once no instance on 1.6.1 or older is left (ADR 0002, Decision 5).
- **A conversation's message list holds only its pinned origin's copies.** A `dm_message_created` for an alternate id (a mirrored copy pushed by another connected instance) is not added to the list, the row's preview or the unread state; it only becomes that copy's own last message, so a failover that pins the copy shows the newest preview. Message ids are local to the instance that issued them, and every action on a message (reply, reaction, edit, delete) goes to `getChannelOrigin(channelId)`, which knows only its own ids. Before #295 the mirrored copy was rerouted into the pinned entry and, when it arrived first, it won the `sourceMessageId` dedup against the pinned copy, so a reply to it was refused as `reply_target_invalid` and a reaction to it was silently dropped. The pinned origin receives the message over the S2S relay and delivers its own copy. The cost is one relay hop of latency for messages first seen by another instance.
- **A message is never assigned to a conversation by its author.** The signed-in user is a member of all of their DMs, so an author match put a message the user sent to one person into whichever of their other DMs sorted first (unread DMs sort first). That was issue #296; it was a display fault in the sender's own client, and the server never stored or sent the message to the other conversation's members.

Source: `stores/dmConversations.ts` (state, operations, pin rule), `stores/spaceStore.ts` (the derived view, the store actions), `utils/dmOriginFailover.ts` (the pin-move effect), `utils/dmMessageRouting.ts` (incoming events), `utils/dmConversationKey.ts` (1.6.1 compatibility), `stores/instanceStore.ts` (availability and removal). Decision: `docs/decisions/0002-dm-conversation-identity.md`.

### User View Cache

The DM dedup pass at `populateFromReady` is first-wins by `federatedId` and skips the duplicate channel **as a whole**, including its `members` array. When a user is connected to multiple instances and a sibling instance's `ready` arrives first, the home instance's view of the same federated DM is dropped. Without further machinery, render sites would only ever see the sibling-stub view of every member — wrong username (`name@homeHost`), stale or 404-ing avatar URL, wrong `avatarColor`, and a globe icon for users whose home IS our currently-logged-in instance.

`userViews` is a parallel cache that mirrors the philosophy of `dmAlternatives`: information from skipped ready payloads is still load-bearing — for rendering, not for routing. Render sites read through it to surface the home view of every user the client has ever heard about, regardless of which carrying channel survived dedup.

**State:**

- `userViews: Map<canonicalUserKey, UserViewEntry>` on `spaceStore`. Each entry is `{ user: User, deliveredBy: string, isHome: boolean, updatedAt: number }`.
- `canonicalUserKey(user)` (in `utils/identity.ts`) returns `<homeInstanceHost>:<homeUserId>` for federated users and `:<id>` for purely-local users — same key across instances for the same person.
- `isDeliveryFromHome(user, deliveringOrigin)` (in `utils/identity.ts`) decides whether a delivery is "home view" or "stub view": the user is delivered from their home iff their `homeInstance` matches the delivering origin's host (with `''` resolving to `window.location.host`).

**Preference rule on upsert (`upsertUserView(user, deliveringOrigin)`):**

- If no entry exists: insert.
- If existing is home view and incoming is stub: ignore.
- If existing is stub and incoming is home view: overwrite (upgrade).
- Same tier (both home or both stub): freshness wins; incoming overwrites.

`deliveringOrigin` is a REQUIRED parameter — never default it. The user's declared `homeInstance` is NOT a substitute, because a stub view delivered by orbit has `homeInstance=nova`; pruning by declared home would evict the wrong entries.

**Wire surfaces that upsert** (every place a `User` lands on the client from a connection):

- `populateFromReady` walks `incomingDms[].members` BEFORE the `federatedId` dedup pass — load-bearing — and walks every space's `members[].user`. `loadSpaceDetail` upserts each member after asset normalization.
- WS handlers in `useWebSocket.ts`: `ready` (space members), `dm_message_created` / `dm_message_updated` / `message_created` / `message_updated` (`message.user` and `message.replyTo?.user`), `user_updated`, `member_joined`, `friend_request_received` / `friend_request_sent` / `friend_request_accepted`, `dm_channel_created`, `dm_member_added`.
- REST hydrators: `socialStore.loadFriends` / `loadRequests` / `searchUsers`, `discoverStore.fetchUsers`, `utils/mutuals.loadFederatedMutuals`. Each upserts with the load's origin.
- Modals that fetch a profile via REST (`UserProfileModal`, `TransferOwnershipModal`) call `useSpaceStore.getState().upsertUserView(fetchedUser, fetchOrigin)` after the fetch returns.

**Render-side lookup:**

- `useCanonicalUserView(user)` in `utils/userViewLookup.ts` is a Zustand selector hook that subscribes to the cache entry for `canonicalUserKey(user)`. Render sites call this before reading `username` / `displayName` / `avatar` / `avatarColor` / `homeInstance` / `homeUserId`. The hook returns the input on cache miss; the component falls back to current best information until the cache fills.
- `getCanonicalUserView(user)` is the synchronous getter for non-React paths (event handlers, helpers like `useVoiceParticipantMeta`).
- `isFederationGlobeApplicable(user)` in `utils/identity.ts` is the predicate used at three globe-icon sites (`DmListItem`, `MainContent`, `MobileDmsScreen`). It gates the globe on `parseFederatedUsername(username).domain && domain !== window.location.host` — no globe for users whose home is us, even when only a stub is loaded.

**Render reactivity is structural, not coincidental.** Subscribers receive cache updates via the Zustand selector, regardless of whether legacy update paths (`updateUserEverywhere`, `updateFriendProfile`) also fired. That coupling was deliberately avoided so that future contributors who add a new wire surface and only call `upsertUserView` do not silently break render propagation.

**Composition with `isSelf` / `resolveDisplayIdentity`.** Self-rendering continues to flow through the existing identity helpers — `isSelf` for filtering, `resolveDisplayIdentity` for substituting the home identity into a replicated alias of self. The cache lookup composes alongside, not inside: render sites filter via `isSelf`, then pass non-self users through `useCanonicalUserView`. Self-as-member (e.g. in a group DM) goes through the cache like any other member; the cache holds the home view of self anyway.

**Lifecycle:**

- Pruned in `removeInstanceSpaces(origin)` — drops every entry whose `deliveredBy === origin`. Mirrors the `dmAlternatives` prune in the same function.
- `reset()` clears the cache.
- **NOT pruned on transient WS disconnect.** Last-known view persists across blips, matching `dmAlternatives`' no-flapping invariant. If the surviving cache no longer holds a home view for some user (because the home origin was fully removed), render falls back to whatever the carrying payload supplies — degrades to the stub view, no crash.

**Out of scope by design:**

- The cache is render-only. It does NOT feed identity-resolution or write paths. API write payloads (e.g. `api.dm.create`, `api.friend.add`) continue to source identity from the original prop or click-site state, where the user explicitly nominated `homeUserId`/`homeInstance`.
- The cache stores `User`-shaped fields. Extended profile data (`bio`, `banner`, `pronouns`) fetched via REST in profile modals lives in those modals' local state; `upsertUserView` is called from modals only to seed the home view of the cache, not to mirror extended profile data.

Source: `stores/spaceStore.ts` (state, `upsertUserView`, prune in `removeInstanceSpaces`), `utils/identity.ts` (`normalizeOriginToHost`, `canonicalUserKey`, `isDeliveryFromHome`, `isFederationGlobeApplicable`), `utils/userViewLookup.ts` (`getCanonicalUserView`, `useCanonicalUserView`).

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
3. Replace this origin's entries in the space-channel index (the lookup maps follow, see "Channel index and lookup maps")
4. Normalize remote asset URLs to absolute paths
5. Merge DM channels from all origins: the `ready` payload's DMs replace that origin's copies in the DM merge module (`mergeOriginListing`), which groups copies by conversation key and pins one per conversation (see "DM Origin Failover").
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

### The shared connect path: `connectToInstance`

`connectToInstance(origin, password, displayName?)` in `instanceStore.ts` is the one way to establish a session on another instance from a user-typed password. The Connections add-instance flow (after its `probeInstance` step) and the directory's connect-then-join flow both go through it. It branches on the status the store holds for the canonical origin:

| Store status for the origin | What happens | Outcome |
|---|---|---|
| `connected` or `connecting` | nothing; the session is usable already, and `connectToRemote` has no duplicate check of its own and would append a second entry | `{ kind: 'connected', how: 'already' }` |
| `error` or `disconnected` | `reauthenticateInstance(origin, password)` in place | `{ kind: 'connected', how: 'reconnect' }` |
| unknown | `connectToRemote(origin, password, displayName)`, the flow above | `{ kind: 'connected', how: 'new' }` |
| any, called with an empty password | a resumable origin (a live instance in `error`/`disconnected` that kept its token, or a registry entry in `disconnected`) is resumed with `reconnectInstance` | `{ kind: 'connected', how: 'resumed' }`, or `{ kind: 'needs-password' }` when there was nothing to resume or the token was refused, or a thrown `peer_unreachable` |
| any, and only the account's own credentials can get in (step 7 of the flow above) | `RemoteLoginRequiredError` is caught | `{ kind: 'needs-remote-password', remoteUsername, reason }`, so the caller can offer the explicit per-instance login form under the notice `reason` selects |

Every other failure is thrown as is. It does not validate a typed URL: a caller that wants the self and duplicate checks for user input still runs `probeInstance` first, as the Connections flow does.

**A placeholder is replaced, never removed first.** `connectToRemote` and `loginToRemote` write their new instance by origin (`[...instances.filter(i => i.origin !== origin), instance]`), and `reauthenticateInstance` leaves the stale `error` or `disconnected` entry in `instances` while the request runs (it still drops the origin's spaces and socket; the new session's ready payload brings the spaces back). The origin is therefore never absent from the list: a wrong password leaves the placeholder as it was. This matters because Outer Space dedupes at render from the registry and the live list ([directory.md](directory.md) section 9); with the entry removed up front, an expired instance's spaces surfaced as "Connect and join" cards under the chip that said its session had expired. A `disconnected` origin is deliberately not deduped there: it is an outer instance again for Explore, and connecting from its card comes back through this same path, reusing the identity.

### Connect from an Outer Space card

The Explore page's Outer Space section (the space directory, [directory.md](directory.md)) is a second entry point into this flow. Clicking an entry opens `ConnectAndJoinModal`, which probes the entry's host (unless the session already holds a `connected`/`connecting` instance for that origin, in which case the probe and the password step are skipped), shows the same `RemotePasswordStep` the Connections panel uses with the origin prefilled ("This space lives on chat.example.org. Connecting creates your identity there, linked to your account on home.example.org.", an intro that says what connecting does; the field label and its hint are the only two places the modal says "password"), calls `connectToInstance`, and then runs `exploreStore.publicJoin` or `requestJoin` against the new origin through `getApiForOrigin`. The typed password is verified against the home instance and the home mints the per-remote secret exactly as above; the remote never sees what was typed. A `409 already_member` is treated as a join, since the space arrives with the connection's ready payload.

**Pending join requests are keyed by origin.** `exploreStore.fetchMyRequests()` fans out over the home instance and every connected instance with `Promise.allSettled`, tagging each request with `_instanceOrigin` (`''` for home), and `useSpaceJoin.isPending` compares `(origin, spaceId)`. Space ids are local to their instance; until this change a pending request on one origin showed as pending for a same-id space on any other, and a request made on a remote instance never appeared after a reload.

### Add-Instance Pre-Flight: `federatedRegistrationOpen`

The hostname-probe step calls `GET /api/instance/info` on the target. The response carries two registration fields:

```typescript
{ name, version, registrationOpen: boolean, federatedRegistrationOpen: boolean, sourceCodeUrl: string, commit: string | null }
```

`sourceCodeUrl` / `commit` are the AGPL § 13 source offer (see `api.md`). `probeInstance` returns the whole payload, and the connect/login/reconnect/autoConnect paths persist `version`, `sourceCodeUrl`, and `commit` onto each `ConnectedInstance` so the client can surface the source link per instance.

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

### Client readers

Two surfaces read the client Map and must agree: the Connections panel
(`ConnectedInstances.tsx`, every entry with its status, actions and the
`ReauthForm`) and the Explore page's `ConnectionChips` (entries in
`auth_expired` or `unreachable` only, with Retry and the same `ReauthForm`;
see [directory.md](directory.md) section 9). Both render from the Map, so a
status change from any path (`reconnectInstance`, `reauthenticateInstance`,
`autoConnectAll`) reaches both at once.

### The one writer: `writeConnectionState`

A connection is held in two projections that both carry a status — the live
`ConnectedInstance` in `instances` and the entry in this Map — and neither is
derived from the other, so one internal function in `instanceStore.ts` moves
them together. `writeConnectionState(origin, phase, write?)` takes a phase from
a table that names the live status, the registry status and the reason code as
one thing (`connected`, `disconnected`, `unreachable`, `token-expired`,
`no-session`, plus `live-*` phases that move the live entry alone), and writes
`instances`, `registry` and `registryUpdatedAt` in a single `set`. Call sites
name a phase; none of them writes a status, which is what keeps the halves from
drifting apart at one path and putting an instance's spaces in the wrong half of
the Explore page (`innerOrigins` reads across the pair). The one exception is
`autoConnectAll` seeding a registry row from the server registry or from
localStorage, which creates the persisted record for an origin that has no live
half yet rather than moving one. The `live-*` phases are for the events the
registry deliberately does not record: socket liveness
(`setInstanceStatus`) and an attempt in flight, since a websocket blip must not
leave a row saying the user disconnected — that row is what suppresses
auto-connect on the next launch. `instanceStore.test.ts` asserts the pair after
every action that moves a connection.

### The reconnect surface: `ReauthForm`

`ReauthForm` (`components/modals/ReauthForm.tsx`) is the whole way back from
`auth_expired`, in both hosts. It has two phases and no chrome of its own, so
each host places it on the panel or row it already has:

1. **Home password.** A labelled field, Connect and Cancel, with the error
   under the field it is about. Submitting calls `reauthenticateInstance`,
   which drops the stale session and re-runs the standard connect flow.
2. **The account's own password on that instance.** Reached only when phase 1
   throws `RemoteLoginRequiredError` (step 7 of the connect flow gives the two
   reasons), and no home password can fix that. The phase renders
   `FallbackForm`, exported from `RemotePasswordStep.tsx` and shared with the
   Connections add flow and the connect-and-join dialog, prefilled with the
   username the error carries and worded by its `reason`; its submit calls
   `loginToRemote`, which restores the connection exactly as the add flow
   restores it. There is no Back: the password phase 1 asks for is not what
   the instance refused.

`RemoteLoginRequiredError` is an `HttpError` carrying a registered code
(`federation_different_password`, 409, or `federated_registration_closed`,
403, by reason), minted by the client rather than by a route, so
`describeError` says it in the user's language anywhere it does surface as a
message. Its English text is the log line and the last-resort fallback only.

The chips host keeps an open chip mounted. `ConnectionChips` hides a chip
whose live instance is `connecting` on its own, but it holds the set of
opened origins itself and exempts them, because dropping an entry unmounts
the chip and unmounting `ReauthForm` discards the password being typed into
it: a `reconnectInstance` started anywhere else (the Connections panel, the
connect-and-join dialog's silent resume, startup) would otherwise empty the
field under the user's hands. An origin leaves the set as soon as its entry
is anything but `auth_expired`, which is the only status the form exists
for, so a connection that comes back, is disconnected, or stops answering
takes its open state with it and a later expiry opens a fresh form.

Escape cancels the surface in either phase, and never travels past it in any
state. That containment is load-bearing: `Modal.tsx` closes the settings
modal from a document-level Escape listener, so an Escape let through during
a submit would close the modal around a running reconnect and leave a
`RemoteLoginRequiredError` with no surface to arrive in. The handler therefore
stops the event first and judges it after; while a submit is in flight the
key is swallowed and does nothing, as Cancel does. In the chips host the collapsed pill
becomes a small matte panel on a line of its own, bounded by the form rather
than by the section, and collapsing hands focus back to the chip's action.

### Lifecycle States

| State | Meaning |
|-------|---------|
| `connected` | Active WebSocket, valid token |
| `disconnected` | User intentionally disconnected; account exists on remote |
| `unreachable` | Remote is down/unresponsive |
| `auth_expired` | Token invalid; needs re-authentication |

### The reason field (`errorMessage`)

`errorMessage` on a registry entry is a machine-readable reason code, not a
sentence. The Connections row renders it through `describeRegistryError`
(`i18n/registryErrors.ts`), which is the only place the words exist; the
store writes the code through `registryReason`, which types the value against
the union so a typo at a write site does not compile.

| Code | Reached from | Status it accompanies |
|------|-----------|-----------------------|
| `unreachable` | `reconnectInstance`, `autoConnectAll` on a network error | `unreachable` |
| `session_expired` | `reconnectInstance`, `autoConnectAll` on an auth error; the tokenless placeholder path | `auth_expired` |
| `reauthenticate` | `autoConnectAll` seeding a `replicatedInstances` entry with no registry row | `auth_expired` |
| `authenticate_home` | `autoConnectAll` seeding the home instance of a federated account | `auth_expired` |

These are deliberately not `ErrorCode`s: nothing throws them, no route sends
them, and `ERROR_MESSAGES` on the server is exhaustive over `ErrorCode`, so a
code there would mean English text in the server package for a string only
this client writes and reads. The rule they follow is the same one
([localization.md](localization.md)): the value on the wire is a code and the
client owns the words.

The registry syncs through the home instance, so a row can arrive holding the
English sentence a client on an older version wrote. `describeRegistryError`
passes a value it does not recognise through unchanged rather than dropping
the only explanation the row has.

The live `ConnectedInstance.error` field is a separate, unrendered string for
the console and stays English.

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

### Load-bearing for inbound attribution

Both records are now read by the **home** instance's S2S attribution check (`localUserStandingOnPeer`, see [federation.md §3](federation.md#3-identity-resolution)). A homeward relay — a peer asserting an event authored by one of *our* users — is only accepted when that user has a registry row or a `replicatedInstances` entry for the signing peer. Either record satisfies the check, so a failed `PUT` on one path does not lock the user out. A relay that arrives before either record is refused as `attribution_unproven`, which the sending instance retries on backoff, so a DM written in the moments before `syncRegistry` lands is delivered once it does.

Consequences to keep in mind when touching this code:

- **Never widen the write path.** Both endpoints are authenticated and scoped to `request.userId`. A route that let anyone else write these rows would hand a peer the ability to grant itself attribution authority over a user.
- **Do not prune on disconnect.** `disconnectInstance` keeps the registry row (status `disconnected`) rather than deleting it. Deleting it would break attribution for events still in flight from that remote, and for retried outbox deliveries. `forceRemoveEntry` *does* drop the row — that is the intended way to revoke a remote's standing to act as you, and it takes effect on the next `syncRegistry()` push.
- **The sync-ready gate matters.** The degraded-mode behaviour described above (local Map populated, `PUT` suppressed) is safe *because* it never wipes server rows — the server keeps the authoritative record the check reads.

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

- **`approved`** — "Your peering request to `{peerOrigin}` was approved — retry your friend-add to `{triggerTarget}`?" `[Retry]` `[Dismiss]`. Retry deep-links to the friend-add UI prefilled with the original target. Today only the `friend_add` reason produces a retry deep-link; future trigger reasons add their own deep-link flows. An approved `instance_connect` needs no retry: once the peering is active, relay starts on its own. Dismiss POSTs to `/peering-notifications/:id/read`.
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

### Reset cleanup (instance-epoch self-healing §6.4)

Modeled on the peering-approval surface above, the FederationPanel's `ResetCleanup` component (`admin.md` "FederationPanel") is the admin surface for a factory-reset peer. It fetches `api.federation.peers()` + `api.federation.resetEvents()` (`GET /api/federation/reset-events`) and subscribes to `onFederationPeerResetDetected(cb)` — the client handler for the `federation_peer_reset_detected` admin WS event (`useWebSocket.ts`) — to refetch live. Two surfaces:

- **Reset-detected banner** — one persistent accent-rose banner per peer with `status === 'needs_attention' && needsAttentionReason === 'peer_reset_detected'` (the `needsAttentionReason` field distinguishes a reset from a generic auth-failure, and now also `'repeer_incomplete'`). **Re-peer** runs `resetPeer(id)` **then** `initiatePeering({ remoteOrigin })` — reset-before-handshake so activation heals the stale graph against the new incarnation. **The result is surfaced honestly:** `initiatePeering` now returns `{ peer, verified }`; when `verified === false` (or the peer comes back `needs_attention`), or when it rejects with `409 PEER_EXISTS_RESET_REQUIRED`, the toast is a **warning** telling the admin the remote still holds stale peering and its admin must reset the **other** side, then Re-peer again — rather than a false success. A cryptographically-verified activation shows the success toast. The common one-side reset recovers in one click; a bidirectional-stale case names the side that must act. See `federation.md` "Trust re-establishment contract".
- **Detached-accounts card** — informational, neutral-tier surface (no rose/urgency styling) for the reset incarnation's real accounts that now operate as sovereign local accounts (`FederationOrphanedAccount`: owned-spaces / membership / message counts). Copy: detached accounts keep working locally and owners sign in with their existing password. Cards render only for unacknowledged events (`orphanedAccounts.length > 0 && acknowledgedAt === null`; the endpoint still returns acknowledged events for audit). Per-account **Remove** reuses `api.admin.deleteUser(id)` (`DELETE /api/admin/users/:id`, full purge) for genuinely-abandoned accounts — a Remove on a space owner surfaces the existing `409 { ownedSpaces }` as a "transfer ownership first" toast instead of deleting. A per-event **Dismiss** footer calls `api.federation.acknowledgeResetEvent(origin)` (`POST /api/federation/reset-events/acknowledge`) then re-fetches — a real server-side acknowledgement (replacing the old client-only "Keep") that hides the card and removes the event from the badge count without touching any account.

### AccountPanel re-attach action (fallback, re-attach spec §3.4)

The owner-facing side of re-attach. `AccountPanel` (`components/modals/settingsPanels/AccountPanel.tsx`) renders the detached-account notice whenever the self user is detached (`federationHomeOrphaned && homeInstance`). Below the informational copy it appends a **"Re-attach to `<homeInstance>`"** action **only** when `instanceStore.instances` also holds a `status === 'connected'` connection whose origin host matches the account's `homeInstance` (`homeConnection`, memoized). This is the explicit fallback for what `maybeAutoReattach` deliberately skips: a different username on the new home (cross-name bind), or a home connection established after the detached connection.

The button is a two-step armed confirm that names both identities — first click arms (`Confirm re-attach as <homeUsername>`), second click mints and exchanges the proof: `homeConnection.api.auth.attachProof(window.location.host)` → `api.users.reattach({ token })`, then `useAuthStore.getState().setUser(res.user)` clears the flag so the notice disappears. Errors surface inline; without a home-domain connection the notice keeps only its informational copy.

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
