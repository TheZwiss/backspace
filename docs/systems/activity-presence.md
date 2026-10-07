# Activity & Presence System

Source files:
- `packages/shared/src/types.ts` — Activity, ActivityType, ActivityTimestamps, ActivityAssets type definitions
- `packages/shared/src/activities.ts` — ACTIVITY_LIMITS, ACTIVITY_PRIORITY, getPrimaryActivity()
- `packages/web/src/stores/activityStore.ts` — Client-side activity state (Zustand), debounced push, visibility toggle
- `packages/web/src/platform/activityBridge.ts` — Electron IPC bridge: subscribes to desktop activity events
- `packages/web/src/hooks/useWebSocket.ts` — Ready payload handling, presence_update reception, reconnect re-push
- `packages/web/src/components/layout/ActivityPanel.tsx` — Friends activity sidebar (DM home view)
- `packages/web/src/components/layout/MemberSidebar.tsx` — Space member list with activity display
- `packages/web/src/components/ui/ActivityCard.tsx` — Activity display component, accent color helpers
- `packages/web/src/components/modals/settingsPanels/PrivacyPanel.tsx` — showActivity toggle UI
- `packages/server/src/ws/handler.ts` — ConnectionManager (in-memory activity state, rate limiting, disconnect cleanup)
- `packages/server/src/ws/events.ts` — handlePresenceUpdate, handleActivityUpdate, validateActivities
- `packages/server/src/utils/presenceBoot.ts` — boot-time reset of orphaned `users.status` rows (federation-safe)
- `packages/server/src/routes/users.ts` — REST showActivity toggle with server-side activity clear
- `packages/desktop/src/activityDetector.ts` — Process polling, game dictionary matching (boundary: see Desktop section)
- `packages/desktop/src/preload.ts` — IPC channel exposure (activity-detected, get-current-activity)
- `packages/desktop/src/main.ts` — startActivityDetection call, IPC handler registration

---

## Type Definitions

```typescript
// packages/shared/src/types.ts

type ActivityType = 'custom' | 'playing' | 'listening' | 'watching' | 'streaming';

interface ActivityTimestamps {
  start?: number;  // epoch ms
  end?: number;    // epoch ms
}

interface ActivityAssets {
  largeImage?: string;
  largeText?: string;
  smallImage?: string;
  smallText?: string;
}

interface Activity {
  type: ActivityType;
  name: string;
  details?: string;
  state?: string;
  timestamps?: ActivityTimestamps;
  assets?: ActivityAssets;
  url?: string;
}
```

---

## Field Limits & Validation

### ACTIVITY_LIMITS (`shared/src/activities.ts`)

| Constant | Value |
|----------|-------|
| `MAX_ACTIVITIES_PER_USER` | 5 |
| `MAX_NAME_LENGTH` | 128 |
| `MAX_DETAILS_LENGTH` | 128 |
| `MAX_STATE_LENGTH` | 128 |
| `MAX_ASSET_TEXT_LENGTH` | 128 |
| `MAX_URL_LENGTH` | 512 |

### Server-Side Validation (`ws/presenceEvent.ts:validateActivities()`)

The server validates every incoming `activity_update` payload, and the activities of every relayed S2S `presence_update` (when they fail, `processPresenceUpdateEvent` applies the status and leaves the kept activities unchanged). One function for both, so an activity a sender accepts is one every receiver accepts:

1. Must be an array with at most `MAX_ACTIVITIES_PER_USER` items
2. Each item must be an object with a valid `type` (one of: `custom`, `playing`, `listening`, `watching`, `streaming`)
3. `name` is required, must be a string that is not empty after trimming and within `MAX_NAME_LENGTH`; trimmed on accept
4. Optional fields (`details`, `state`) accepted if string and within length limits; trimmed
5. `url` accepted only if it starts with `https://` or `http://` and is within `MAX_URL_LENGTH`
6. `timestamps.start` and `timestamps.end` accepted if numbers in range `[0, 4102444800000]` (epoch ms cap ~2100)
7. `assets` fields (`largeImage`, `smallImage`) validated against `MAX_URL_LENGTH`; text fields against `MAX_ASSET_TEXT_LENGTH`
8. If any item fails validation, the entire payload is rejected (returns `null`)

---

## Activity Priority & Primary Selection

### Priority Ranking (`shared/src/activities.ts`)

| Activity Type | Priority |
|---------------|----------|
| `streaming` | 5 (highest) |
| `playing` | 4 |
| `listening` | 3 |
| `watching` | 2 |
| `custom` | 1 (lowest) |

### `getPrimaryActivity(activities)` Algorithm

Returns the single activity with the highest priority from the array. Uses `Array.reduce` — on ties, the first-encountered activity wins (leftmost in array). Returns `null` for empty arrays.

```typescript
// shared/src/activities.ts
function getPrimaryActivity(activities: Activity[]): Activity | null {
  if (!activities.length) return null;
  return activities.reduce((best, current) =>
    ACTIVITY_PRIORITY[current.type] > ACTIVITY_PRIORITY[best.type] ? current : best
  );
}
```

---

## Presence States

### Status Values

| Status | Meaning |
|--------|---------|
| `online` | Active connection |
| `idle` | User-set idle (no automatic idle detection exists) |
| `dnd` | Do not disturb. Withholds the user's own message and incoming-call alerts (sounds and OS notifications); see sounds.md ("Do Not Disturb") |
| `offline` | No active connections |

### DB Persistence

Two columns (see database.md):

- `users.chosen_status` — what the user picked (`online`/`idle`/`dnd`, default `online`). Never `offline`. Survives disconnects, restarts and the boot reset.
- `users.status` — live presence (default `'offline'`). The chosen status while the user has a connection, `'offline'` without one.

The rules live in `utils/presenceStatus.ts` (pure) and `ws/presence.ts`:

- **On connect:** WebSocket auth (`ws/handler.ts`, after `authenticated = true`) writes `status = statusOnConnect(row)` and publishes the same value in the `ready` payload's `user`, the local `presence_update` broadcast and the S2S relay. For a row that owns its choice (native or detached, see below) that is `chosen_status`. For a replicated row it is what "Replica presence" below shows on connect; the replicated row's own `chosen_status` is never used. The REST `/api/auth/login` route does **not** set status — login alone does not imply a live socket; the WS handshake is the single source of truth.
- **On manual change:** REST `PATCH /api/users/@me { status }` and the WS `presence_update` client event both call `applyChosenStatus`. It writes `chosen_status` (only on rows that own their choice) and, while the user is connected, `status`, the in-memory `userStatuses` cache, a `presence_update` to friends, DM and space co-members and the user's own sessions, and an S2S relay. Without a connection only `chosen_status` changes. `'offline'` is rejected (`status_invalid` over REST, an error event over WS).
- **On disconnect:** After 5s grace period (`ws/handler.ts:finalizeDisconnect`), a row that owns its status is set to `'offline'`. A replicated row follows "Replica presence" below. `chosen_status` is untouched either way.
- **On boot:** Server resets stale `status` rows for non-deleted accounts that own their status (native or detached; see "Boot Reset" below). `chosen_status` is untouched.

### Replica presence (`ws/replicaPresence.ts`)

This is the one statement of the rule. A replicated row (one that does not own its status) shows its home instance's presence, and `ws/replicaPresence.ts` is the only code that writes its `status`; the call sites below go through it.

- **The projection** is what the home last reported to this process: a relayed `presence_update` (`processPresenceUpdateEvent`), the status in the profile snapshot a stub is created with (`resolveOrCreateReplicatedUser`), and `'offline'` when the peering with the home ends (`markPeerStubsOffline`). Each goes through `projectReplicaStatus`. The projection is kept in memory only, and a projection of `'offline'` and none at all are the same state. The status a row shows is never taken as a projection: after a restart it may be the `'online'` a session here left behind.
- **Shown status** (`replicaLiveStatus` in `utils/presenceStatus.ts`): the projection, except that while a session of the user is here (open, or in its 5s grace) a projection of `'offline'` shows `'online'`. A peer deactivation therefore leaves a user with a session here shown online until that session ends.
- **Connect** (`showReplicaStatusOnConnect`, from `ConnectionManager.publishConnectStatus`): the known projection, else the status the row shows now, with `'offline'` read as `'online'`. Nothing is recorded.
- **The user's own choice while connected here** (`showReplicaChoice`, from `applyChosenStatus`): shown until the home's next projection or the end of the last session here. It is not recorded and not relayed; the home owns the choice.
- **Last disconnect** (`showReplicaStatusOnDisconnect`): the row returns to the known projection, else to `'offline'` as a native row does. Local users are told only when that differs from what they saw, relayed activities are kept unless the result is `'offline'`, and nothing is relayed.
- **Rows that own their status** (native, detached) are refused by every function and keep their own rules, so a peer deactivation does not touch a detached row.
- **Why memory only:** without a projection the row falls back to `'offline'`. After a restart that can show a user offline here whose home still has them online, until the home's next relay; that was the behaviour before #325. Taking the shown status as the projection instead could leave a user online for good once nothing from the home would correct it (the home deactivated, or its real presence offline).

### The client's copy of the user's own status

This is the one statement of the rule; `utils/selfStatus.ts`, `utils/alerts.ts` and sounds.md point here.

**Who owns the choice.** An account owns its chosen status when it is native or detached (`ownsChosenStatus` in `@backspace/shared`: `!homeInstance || federationHomeOrphaned`), the same authority rule as profile edits and credential issuance. The server stores and reads `chosen_status` only on such rows (`statusOnConnect`, `applyChosenStatus`, the `0018` backfill).

**Where the client reads it.** `statusAuthority(authStore.user)` names the owner:
- `session`: the page's own account owns the choice. Its status is `authStore.user.status`, written only from the page's own socket (`ready`, `user_updated`, and a `presence_update` about that account, which is how a change on another device arrives).
- `trueHome`: the page's account is a replicated row, e.g. `erin@nova` signed in directly on orbit. The page instance's view of her is a projection that falls back to `'online'`, so it is ignored. The choice is `authStore.trueHomeStatus`, written only from the true home's secondary connection (its `ready`, `user_updated` and `presence_update` about the user's row there, id `homeUserId`).

**Before the true home reports, and while it cannot.** Every report from the true home is also kept in `localStorage` under `backspace_true_home_status:<home host>:<home user id>` as `{ status, reportedAt }`, keyed by the home account rather than the page's row. `initSession` and `loadUser` start `trueHomeStatus` from that kept value when it is at most 24 hours old (`TRUE_HOME_STATUS_MAX_AGE_MS`, `seedTrueHomeStatus`); an older value, or one kept by an earlier version without its report time, is ignored and the choice is unknown until the true home reports. The age limit also holds while the page stays open: starting from a kept report schedules a clear of `trueHomeStatus` for the moment the report passes the maximum age, so a value loaded at 23 hours stands in for one more hour, not for the page's lifetime. The true home's first report in the page replaces the kept value and cancels that clear, as do signing out and a new sign-in (`loadUser` never overwrites a value already in the page). The evidence, in order: the true home's live report always wins; else a kept report younger than the maximum age; else unknown. The page instance's replicated row is never evidence. The age limit is why a Do Not Disturb kept from days ago does not keep alerts and rings silent after the user changed it on another device while their home is unreachable (#325). Without it, `trueHomeStatus` was null from page load until the home connection's `ready`, and forever when the home was unreachable at page load, so Do Not Disturb did not hold in that window. Nothing is kept for a `session` owner. The value can be stale: a change made on another device while this one was closed shows only once the home connection is up. While the home connection is down, `trueHomeStatus` keeps the last value the true home reported in this page and is not cleared; only a value started from a kept report expires. That is deliberate: the last known choice is a better guess for the alert gate than none, and the true home is the only place that can say otherwise. When this device never received a report for the account (and storage is empty or unreadable), the choice stays unknown until the home connection is up; closing that gap would need the page instance to carry the home's choice, which the protocol does not do.

`ownStatusReport` applies exactly this for every `ready`, `user_updated` and `presence_update`, whatever the origin; anything else (other users, another instance's view of the user, `'offline'`) is ignored. `selectMyChosenStatus` in `authStore.ts` is the only read: the alert gate (sounds.md, "Do Not Disturb"), the ringing loop, the settings panel and the status dots that show the user's own status all use it.

**Showing it.** A status dot that depicts the signed-in user draws `useShownStatus(subject, origin, status)` (`hooks/useShownStatus.ts`): the chosen status once known when `subject`, as `origin` issued it, is the user (`isMine`, client-federation.md section 5), otherwise `status` as given. It is used by the user area at the bottom of the channel sidebar, the profile card and the profile modal, so on a replicated session they show Do Not Disturb when the true home says so even while the page instance's view says online. Member rosters (member list, group DM roster, space member settings) still draw the instance's view, which is what other members of that instance see.

**Where a change goes.** `authStore.updateProfile({ status })` sends the status to the owner: the page's instance for `session`, the true home's API for `trueHome` (refused with `settings:account.details.status.homeUnavailable` while that connection is down, never written to the page's instance).

**Re-sending to remotes.** On a remote instance's `ready`, a `session` owner re-sends its status as a `presence_update` when the remote's view differs, because a remote that saw the client disconnect falls back to `'online'`. Only when the remote account is this user's federated identity (`isMyFederatedIdentity`: its home host and home user id name the user's home account, the check `ensureRemoteCredential` uses); never from a `trueHome` session, and never to a separate account that happens to be signed in on that remote.

### Boot Reset (`utils/presenceBoot.ts`)

`users.status` is only flipped back to `'offline'` by `ConnectionManager.finalizeDisconnect()` after a real WS close + 5s grace timer. Those timers live in process memory, so a server restart (deploy, crash, OOM, kill) loses them and any row currently set to `'online'`, `'idle'`, or `'dnd'` stays frozen at that value forever — making the user appear permanently online to friends and space co-members until they next connect.

`resetStalePresenceOnBoot()` runs once during server boot in `index.ts`, after `getDb()`/`seedDatabase()` and before WebSocket route registration. It sets `status = 'offline'` on every row that passes three guards:

1. **The account owns its status** (`ownsChosenStatus`: native, or detached from a reset home). Such a row's live `status` is this instance's WebSocket state, so it is stale after a restart. A replicated row (home instance elsewhere, not detached) has its status projected to us by the home instance via S2S `presence_update` relay events (see `federation.md` §10 — Presence Sync) and is not touched on our boot. On peer deactivation, `markPeerStubsOffline` projects `offline` for those rows ("Replica presence"); on peer (re)activation, the home instance re-emits a fresh snapshot for relationship-related online natives.
2. **`is_deleted = 0`** — tombstoned users are excluded from presence broadcasts already; their stored status is left alone as a maintenance courtesy (no behavioral effect either way, but avoids silent rewrites).
3. **`status != 'offline'`** — keeps the operation a no-op once steady-state is reached; `changes` is logged only when non-zero.

The candidate rows (guards 2 and 3) are selected in SQL and filtered with `ownsChosenStatus` in code, so the boot reset uses the same rule as `statusOnConnect` and `applyChosenStatus` rather than a copy of it.

Because the in-memory `ConnectionManager` is empty at boot by construction, no live connection can be misrepresented by this reset.

### Connect/Disconnect Flow

1. **Server boot** → `resetStalePresenceOnBoot()` flips any non-deleted `online`/`idle`/`dnd` row that owns its status (native or detached) to `offline`. Replicated rows untouched.
2. **Auth succeeds** → `status` set to the connect status (`chosen_status` for an account that owns its choice) in DB → local `presence_update` broadcast to friends + DM members + space co-members via `collectProfileBroadcastTargetIds` → S2S `presence_update` queued to all active peers via `queuePresenceRelay` (mirrors profile_update fanout).
3. **Last socket closes** → 5-second grace period (`scheduleDisconnect`) to allow tab refresh/reconnect.
4. **Grace period expires** → `finalizeDisconnect`: for a row that owns its status, sets DB status to `'offline'`, clears in-memory activities, broadcasts local `presence_update` to friends/DM/space co-members, queues S2S `presence_update` to peers. A replicated row follows "Replica presence" above.
5. **Reconnect during grace** → `cancelDisconnect` prevents offline broadcast; new connection proceeds normally.

### Presence Broadcast Scope

A `presence_update` about a user goes to that user's **profile audience**: `collectProfileBroadcastTargetIds(userId)` (`utils/userDeletion.ts`), the same set `user_updated` uses. That is every co-member of every space the user is in, every co-member of every DM they are in, and every friend, never the user themselves. Each recipient gets it through `connectionManager.sendToUser()`, one send per user id, reaching all of that user's connections. There is no per-space broadcast (`sendToSpace` is not used for presence), so a recipient who shares several spaces with the user gets the event once.

Every emitter builds the event with `presenceUpdateFor` / `presenceUpdateEvent` (`ws/presenceEvent.ts`) and sends it to that audience:

| Trigger | Where | Also to the user's own connections |
|---------|-------|------------------------------------|
| Status change (REST or WS) | `applyChosenStatus` (`ws/presence.ts`) | yes |
| `activity_update` | `handleActivityUpdate` (`ws/events.ts`) | yes |
| `showActivity` turned off | `PATCH /api/users/@me` (`routes/users.ts`), `activities: []` | yes |
| Connect | WS auth (`ws/handler.ts`) | no |
| Disconnect after the grace period | `finalizeDisconnect` (`ws/handler.ts`), `offline` with `activities: []`; for a replicated row what "Replica presence" returns it to, only when it differs from what was shown | no (none left) |
| Relayed S2S presence about a replicated user | `processPresenceUpdateEvent` (`routes/federation/events/dmState.ts`) | no |
| Peer deactivated | `markPeerStubsOffline` (`utils/federationPresence.ts`), for each of the peer's replicated rows the status "Replica presence" shows for an `offline` projection | no |

The one targeted send is the friendship snapshot (`sendPresenceSnapshot`, below): the new friend only.

---

## Activity Lifecycle

Activities are **ephemeral** — stored only in server memory (`ConnectionManager.userActivities: Map<string, Activity[]>`), never persisted to the database. A connected user's entry is cleared on disconnect. A replicated user's entry holds the activities their home instance last relayed (S2S `presence_update`); a relay with an `activities` list replaces it (`[]` clears), an `offline` relay clears it, and a relay without the field (a peer that predates always sending it) leaves it unchanged; it is also cleared when the home peer is deactivated (`markPeerStubsOffline`).

### Data Flow: Detection to Display

```
Desktop Process Scanner (15s poll)
  → IPC 'activity-detected' → preload bridge
    → activityBridge.ts → activityStore.pushActivities()
      → 5s debounce → wsSendAll('activity_update')
        → Server validates, rate-limits (3s)
          → Stores in ConnectionManager.userActivities
            → Sends 'presence_update' to the user's profile audience (see Presence Broadcast Scope)
              → Client useWebSocket handler
                → activityStore.setUserActivities()
                  → UI re-renders (ActivityCard, MemberSidebar, ActivityPanel)
```

### Server-Side In-Memory State (`ws/handler.ts:ConnectionManager`)

| Map | Key | Value | Lifecycle |
|-----|-----|-------|-----------|
| `userActivities` | userId | `Activity[]` | Native/connected row: set on `activity_update`, cleared on disconnect or `showActivity=false`. Replicated row: set from each relayed `presence_update`, cleared by a `[]` or `offline` relay or peer deactivation; a relay without the field leaves it |
| `userShowActivity` | userId | boolean | Cached from DB at auth, updated via REST `PATCH /users/me` |
| `userStatuses` | userId | string | Cached from DB at auth, updated on `presence_update` |
| `lastActivityUpdate` | userId | timestamp (ms) | Used for 3s rate limiting |

### Rate Limiting

Two independent throttling mechanisms prevent activity spam:

| Layer | Mechanism | Interval | Location |
|-------|-----------|----------|----------|
| Client | Debounce timer in `activityStore.pushActivities()` | 5 seconds | `activityStore.ts:72` |
| Server | `checkActivityRateLimit()` — rejects if `< 3000ms` since last update | 3 seconds | `ws/handler.ts:349-355` |

The client debounce is a trailing-edge timer: each new `pushActivities()` call resets the 5s timer, and only the final state is sent. The server rate limit is a hard gate: updates arriving within 3s of the last accepted update are rejected with an error message.

### Ready Payload — Initial Activity Snapshot

On WebSocket auth, `buildReadyPayload()` constructs a `userActivities` map for all visible users: space members, DM members and **friends** (a friend may share neither a space nor a DM with the user). Keys are this instance's row ids. Next to it, `userActivityIdentities` maps each of those keys to the row's `{ homeUserId, homeInstance }` (both null for a native row), so the client can key the entry by the person's home identity (see "Keying" below). For a replicated friend the entry is the activity their home last relayed.

`snapshotActivities(live, customStatus)` (`ws/presenceEvent.ts`) picks each entry: the user's live or relayed activities, else a synthetic `custom` activity from `customStatus`. The friendship snapshot (below) uses the same function.

This synthetic injection only occurs in snapshots (ready, friendship), not in live `presence_update` broadcasts.

### Friendship Snapshot

Presence events fire only on change, so a friend who was already in a game when the friendship formed would show no activity until it changed. When a friendship row is created, `exchangeFriendPresence(a, b)` (`ws/presence.ts`) runs once, at the step that inserted the row: the local `PATCH /api/social/requests/:id` accept, or on the requester's home whichever of the relayed `friend_request_update` (accepted) and `friend_add` formed it (the other then finds the friendship and does nothing). A refused `friend_add` sends nothing. It is best effort and never fails the friendship or its relay:

1. sends each side's sessions a `presence_update` about the other with its current status and snapshot activities (`sendPresenceSnapshot`; an offline subject reports none);
2. for each **native** side whose new friend is replicated, queues a targeted S2S `presence_update` (status + activities) to the friend's home (`snapshotPresenceForFriend`, `utils/federationPresence.ts`). The friend's home had no row for the native when the activity started, so it dropped that relay; this gives it the current state, which it keeps and forwards to the friend.

### Reconnect Re-Push

After receiving a `ready` event, the client performs two re-push operations (`useWebSocket.ts:217-236`):

1. **Electron re-query:** If running in desktop and this is the home connection, calls `window.backspace.getCurrentActivity()` and pushes the result. This handles sleep/wake scenarios where the process scanner didn't fire a change event.

2. **Multi-instance fan-out:** Reads `myActivities` from the activity store and sends `activity_update` to the newly connected instance via `wsSend(event, origin)`. This ensures remote instances have the user's current activities in their in-memory store immediately.

---

## Visibility Control (`showActivity`)

### DB Column

`users.showActivity` — integer, NOT NULL, default `1`. See database.md.

### Toggle Flow

1. User toggles in Privacy panel → `api.users.update({ showActivity: enabled })` (REST PATCH)
2. Server persists `showActivity` to DB (`routes/users.ts:324`)
3. Server updates `ConnectionManager.userShowActivity` cache (`routes/users.ts:357`)
4. If toggled **off**, server immediately:
   - Clears `ConnectionManager.userActivities` for the user
   - Sends `presence_update` with `activities: []` to the user's profile audience (see Presence Broadcast Scope)
   - Sends same to user's own connections
5. Client calls `activityStore.setShowActivity(enabled)` (`PrivacyPanel.tsx:73`)
6. If toggled **off**, client immediately:
   - Cancels any pending debounce timer
   - Sends `activity_update` with `activities: []` to all connected instances via `wsSendAll`
   - Sets `myActivities` to `null`

### Server-Side Guard

When `showActivity` is false, the server silently drops incoming `activity_update` events (`ws/events.ts:505`):

```typescript
function handleActivityUpdate(event, userId) {
  if (!connectionManager.getUserShowActivity(userId)) return;
  // ...
}
```

### Client-Side Guard

`activityStore.pushActivities()` checks `showActivity` and returns early if false (`activityStore.ts:69`).

---

## Desktop Activity Detection (Boundary)

This spec covers how detected activities enter the broadcast pipeline. The detection internals (process scanning, game dictionary matching, dictionary sync) belong to a future `desktop.md` spec.

### Summary of Detection Interface

| Component | Role |
|-----------|------|
| `activityDetector.ts:startActivityDetection(callback)` | Starts 15s polling loop; calls `callback` with `Activity \| null` on change |
| `activityDetector.ts:getCurrentActivity()` | Returns current detected `Activity` or `null` (synchronous) |
| `main.ts:810-812` | Starts detection on app ready; forwards changes via IPC `activity-detected` |
| `main.ts:814` | Registers `get-current-activity` IPC handler |
| `preload.ts:73-78` | Exposes `onActivityDetected` (subscription) and `getCurrentActivity` (invoke) to renderer |

### Bridge to Activity Store

`activityBridge.ts` is initialized once in `AppLayout` via `useEffect`:

1. Calls `initActivityBridge()` → subscribes to `window.backspace.onActivityDetected`
2. On activity change: calls `pushActivities([activity])` or `pushActivities([])` (null means no activity)
3. On init: also queries `getCurrentActivity()` for immediate state
4. Cleanup: `teardownActivityBridge()` removes the IPC listener

---

## Client-Side State: `activityStore` (Zustand)

### State Shape

```typescript
interface ActivityState {
  userActivities: Map<string, Activity[]>;  // All users' activities, keyed by userKey (never a raw row id)
  activityWriters: Map<string, string>;     // userKey → origin whose delivery set that entry last
  originRows: Map<string, Map<string, PresenceSubject>>; // origin → (row id → subject), older servers' ready rows only
  showActivity: boolean;                     // Current user's visibility preference
  myActivities: Activity[] | null;           // Current user's own activities (cached locally)
}
```

### Key Methods

| Method | Behavior |
|--------|----------|
| `setUserActivities(subject, origin, activities)` | Updates the entry at `userKey(subject, origin)` and records `origin` as its writer; deletes both if empty array |
| `clearUserActivities(subject, origin)` | Removes that entry and its writer |
| `initActivities(entries, origin, coveredRows?)` | A `ready` is the origin's snapshot: removes the entries whose writer is `origin`, then sets the snapshot's entries (`readyActivityEntries`) with `origin` as writer. Entries another origin set last are left to that origin. A current server's snapshot covers everyone it reports on (space and DM members and friends), so all its entries are replaced (`coveredRows` null). An older server's covered only the space and DM members its `ready` lists (`readyRowIndex`, passed as `coveredRows`), so only those rows' entries are replaced; a friend it reports on only live keeps what it last reported |
| `setOriginRows(origin, rows)` | Keeps the rows an older server's `ready` listed (`readyRowIndex`), or drops them (`null`, a current server) |
| `setShowActivity(show)` | Sets flag; if `false`: cancels debounce, sends empty `activity_update` via `wsSendAll`, clears `myActivities` |
| `pushActivities(activities)` | Guards on `showActivity`; sets `myActivities` immediately; starts/resets 5s debounce timer; on fire: sends `activity_update` via `wsSendAll` |
| `reset()` | Cancels timer, clears all state |

### Keying

Every instance delivers presence under its own row id: the viewer's home names a remote friend by its replicated row, the friend's home by the native row, a third instance by its own replicated row. One person must land on one key, whichever delivered it, or the friends views and member lists disagree (#340).

- **Key:** `userKey(subject, origin)`, the person's home identity, the one keying rule for people on the client (client-federation.md section 5). `userViews` uses the same key, so `updateMemberPresence` finds a person's cached view directly.
- **Writers:** the `presence_update` handler builds the subject with `presenceSubjectOf(event, origin)` and the ready handler with `readyActivityEntries(event)` (`utils/presenceSubject.ts`). `socialStore.updateFriendPresence(subject, origin, status)` matches friends by the same key, and `spaceStore.updateMemberPresence(subject, origin, status)` matches roster rows (each keyed with its space's `_instanceOrigin`) and the `userViews` entry under the same key.
- **Readers:** `activitiesFor(map, user, origin)` (`stores/activityStore.ts`). FriendsPage and ActivityPanel pass the friend and its `_instanceOrigin`; MemberSidebar and MobileMembersScreen pass `member.user` and the space's `_instanceOrigin`. Nothing looks an entry up by a raw id.
- **Older servers.** A server without the identity fields sends only its row id. `presenceSubjectOf` then takes the identity from a row the client already holds for that (id, origin): a friend, a member of the loaded space from that origin, a DM member from that origin, or a member that origin's last `ready` listed in any of its spaces (`originRows`); an unknown id is taken as native to the delivering instance. `readyActivityEntries` without `userActivityIdentities` takes it from the space and DM members of the same payload. Without `originRows`, a member of a space that is not open was keyed as native on live updates, so the end of a game landed on another key than the ready snapshot's and the game stayed.
- **Limit:** a native user of the page's instance is keyed by `window.location.host`, and a replicated row of that user elsewhere by its `homeInstance` (the instance's `DOMAIN`). The two agree only when the page is opened at exactly `DOMAIN`'s hostname on the default port. They do not when the page is opened by a LAN IP or another host alias, when the instance runs on a non-default port (`window.location.host` keeps the port, a stored `homeInstance` is the hostname only), or under the Vite dev server. Then that user's deliveries through their own home and through a peer land on two keys; deliveries through the home still reach the friends views.

### Module-Level State

The 5s debounce timer is stored as a module-level `let pushTimer` variable (not in Zustand state), ensuring it survives React re-renders but is properly cleared on `reset()` or `setShowActivity(false)`.

---

## Activity Display Components

### ActivityCard (`ui/ActivityCard.tsx`)

Renders the primary activity for a user. Used inside both `ActivityPanel` and `MemberSidebar`.

**Props:** `{ activities: Activity[], fallbackCustomStatus?: string | null }`

**Rendering logic:**
1. Get primary activity via `getPrimaryActivity(activities)`
2. If no primary and `fallbackCustomStatus` exists → render custom status as plain text
3. If primary is `custom` → render `primary.name` as plain text
4. If primary is rich (non-custom) → render `primary.name` + elapsed time (if `timestamps.start` set)

**Elapsed time format** (`formatElapsed`): `"Xh Ym"` if hours > 0, otherwise `"Xm"`.

### Helper Functions (exported from `ActivityCard.tsx`)

| Function | Returns | Purpose |
|----------|---------|---------|
| `getActivityAccentClass(type)` | Tailwind border class | Left-border accent color for glass pill rows |
| `hasRichActivity(activities)` | boolean | True if primary activity is non-custom |

### Accent Colors by Activity Type

| Type | Border Class | Color |
|------|-------------|-------|
| `playing` | `border-l-accent-mint` | Mint |
| `listening` | `border-l-accent-sky` | Sky |
| `watching` | `border-l-accent-lavender` | Lavender |
| `streaming` | `border-l-accent-rose` | Rose |
| `custom` | (none) | No accent |

### Row Rendering Pattern

Both `ActivityPanel` and `MemberSidebar` use the same row rendering logic:
- **Rich activity** (non-custom primary): `glass-pill` container with `border-l-2` accent + rounded corners (10px)
- **No rich activity**: Standard flat row with hover state

---

## ActivityPanel (`layout/ActivityPanel.tsx`)

Displayed in the DM home view (right sidebar, 240px wide). Shows friends grouped by activity status.

### Friend Categorization

Friends are sorted into three groups using `useMemo`:

| Group | Criteria | Display |
|-------|----------|---------|
| `activeFriends` | Not offline AND primary activity is non-custom | Shown first, no header |
| `onlineFriends` | Not offline AND (no primary OR primary is custom) | Header: "ONLINE -- {count}" |
| `offlineFriends` | Status is `offline` | Header: "OFFLINE -- {count}" |

### User ID Resolution

Activities are read with `activitiesFor(userActivities, friend, friend._instanceOrigin)`; see "Keying" under `activityStore`.

### Empty State

When all three groups are empty, displays: "It's quiet for now..." with explanatory text.

---

## MemberSidebar (`layout/MemberSidebar.tsx`)

Displayed in space views (right sidebar, 240px wide). Shows space members grouped by role, with activity display.

### Activity Integration

Activities are read with `activitiesFor(userActivities, member.user, spaceOrigin)` (the space's `_instanceOrigin`); see "Keying". Each member row renders an `ActivityCard` with `fallbackCustomStatus` from `member.user.customStatus`. Offline members do not display activities.

### Role Grouping

Members are grouped by highest-positioned role (see `getMemberGroup`). The owner always sorts first. Activity display is orthogonal to role grouping.

---

## WebSocket Events (Cross-Reference)

See websocket.md for full wire format. Summary of activity-related events:

### Client to Server

| Event | Fields | Notes |
|-------|--------|-------|
| `presence_update` | `status: 'online' \| 'idle' \| 'dnd'` | Persisted as the chosen status (`applyChosenStatus`) |
| `activity_update` | `activities: Activity[]` | Rate-limited 3s server-side; rejected if `showActivity=false` |

### Server to Client

| Event | Fields | Scope |
|-------|--------|-------|
| `presence_update` | `userId, status, activities?, homeUserId?, homeInstance?` | Friends + DM co-members + space co-members + self |

Note: `activities` absent means unchanged; an empty array clears. A relayed presence about a replicated user always carries it. `homeUserId`/`homeInstance` name the subject row's federated identity (null for a native row); every emitter builds the event with `presenceUpdateFor`/`presenceUpdateEvent` (`ws/presenceEvent.ts`). Both `presence_update` (status change) and `activity_update` (activity change) result in outbound `presence_update` events to clients — the server coalesces them into a single event type.

### Ready Payload

The `ready` event includes `userActivities: Record<userId, Activity[]>` containing activities for all visible users (space members + DM members + friends), with synthetic `custom` activities injected for users with `customStatus` but no ephemeral activities, and `userActivityIdentities: Record<userId, { homeUserId, homeInstance }>` for the same keys.
