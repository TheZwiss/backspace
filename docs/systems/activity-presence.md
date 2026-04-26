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

### Server-Side Validation (`ws/events.ts:validateActivities()`)

The server validates every incoming `activity_update` payload:

1. Must be an array with at most `MAX_ACTIVITIES_PER_USER` items
2. Each item must be an object with a valid `type` (one of: `custom`, `playing`, `listening`, `watching`, `streaming`)
3. `name` is required, must be a non-empty string within `MAX_NAME_LENGTH`; trimmed on accept
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
| `idle` | User-set idle |
| `dnd` | Do not disturb |
| `offline` | No active connections |

### DB Persistence

The `users.status` column (see database.md) stores the current presence status. Default: `'offline'`.

- **On connect:** Server sets `status = 'online'` in DB at WebSocket auth (`ws/handler.ts`, the line after `authenticated = true`). The REST `/api/auth/login` route does **not** set status — login alone does not imply a live socket; the WS handshake is the single source of truth.
- **On manual change:** Client sends `presence_update` with `status` field; server persists to DB (`ws/events.ts`)
- **On disconnect:** After 5s grace period, server sets `status = 'offline'` in DB (`ws/handler.ts:finalizeDisconnect`)
- **On boot:** Server resets stale rows for locally-homed, non-deleted users (see "Boot Reset" below).

### Boot Reset (`utils/presenceBoot.ts`)

`users.status` is only flipped back to `'offline'` by `ConnectionManager.finalizeDisconnect()` after a real WS close + 5s grace timer. Those timers live in process memory, so a server restart (deploy, crash, OOM, kill) loses them and any row currently set to `'online'`, `'idle'`, or `'dnd'` stays frozen at that value forever — making the user appear permanently online to friends and space co-members until they next connect.

`resetStalePresenceOnBoot()` runs once during server boot in `index.ts`, after `getDb()`/`seedDatabase()` and before WebSocket route registration. It executes a single update:

```
UPDATE users
   SET status = 'offline'
 WHERE home_instance IS NULL
   AND is_deleted = 0
   AND status != 'offline'
```

Three guards on the WHERE clause:

1. **`home_instance IS NULL`** — replicated user stubs (federated identities homed elsewhere) have their status projected to us by the home instance via `presence_update` relays, not by our local WS state. Their status must not be touched on our boot.
2. **`is_deleted = 0`** — tombstoned users are excluded from presence broadcasts already; their stored status is left alone as a maintenance courtesy (no behavioral effect either way, but avoids silent rewrites).
3. **`status != 'offline'`** — keeps the operation a no-op once steady-state is reached; `changes` is logged only when non-zero.

Because the in-memory `ConnectionManager` is empty at boot by construction, no live connection can be misrepresented by this reset.

### Connect/Disconnect Flow

1. **Server boot** → `resetStalePresenceOnBoot()` flips any locally-homed, non-deleted `online`/`idle`/`dnd` rows to `offline`. Federated rows untouched.
2. **Auth succeeds** → `status` set to `'online'` in DB → `presence_update` broadcast to all user's spaces (excludes self; self gets `ready` payload)
3. **Last socket closes** → 5-second grace period (`scheduleDisconnect`) to allow tab refresh/reconnect
4. **Grace period expires** → `finalizeDisconnect`: sets DB status to `'offline'`, clears in-memory activities, broadcasts `presence_update` with `status: 'offline'` and `activities: []` to all spaces
5. **Reconnect during grace** → `cancelDisconnect` prevents offline broadcast; new connection proceeds normally

### Presence Broadcast Scope

`presence_update` events are broadcast via `connectionManager.sendToSpace()` to all spaces the user belongs to, plus `sendToUser()` to the user's own connections (multi-tab sync). The user is excluded from the space broadcast to avoid duplicate delivery.

---

## Activity Lifecycle

Activities are **ephemeral** — stored only in server memory (`ConnectionManager.userActivities: Map<string, Activity[]>`), never persisted to the database. They are cleared on disconnect.

### Data Flow: Detection to Display

```
Desktop Process Scanner (15s poll)
  → IPC 'activity-detected' → preload bridge
    → activityBridge.ts → activityStore.pushActivities()
      → 5s debounce → wsSendAll('activity_update')
        → Server validates, rate-limits (3s)
          → Stores in ConnectionManager.userActivities
            → Broadcasts 'presence_update' to all user's spaces
              → Client useWebSocket handler
                → activityStore.setUserActivities()
                  → UI re-renders (ActivityCard, MemberSidebar, ActivityPanel)
```

### Server-Side In-Memory State (`ws/handler.ts:ConnectionManager`)

| Map | Key | Value | Lifecycle |
|-----|-----|-------|-----------|
| `userActivities` | userId | `Activity[]` | Set on `activity_update`, cleared on disconnect or `showActivity=false` |
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

On WebSocket auth, `buildReadyPayload()` constructs a `userActivities` map for all visible users (space members + DM members). It auto-injects a synthetic `custom` activity for users who have a `customStatus` set but no ephemeral activities:

```typescript
// ws/handler.ts:collectUserActivities
function collectUserActivities(uid: string, customStatus: string | null) {
  if (seenUserIds.has(uid)) return;
  seenUserIds.add(uid);
  let acts = connectionManager.getUserActivities(uid);
  if (acts.length === 0 && customStatus) {
    acts = [{ type: 'custom', name: customStatus }];
  }
  if (acts.length > 0) {
    userActivities[uid] = acts;
  }
}
```

This synthetic injection only occurs in the ready payload snapshot, not in live `presence_update` broadcasts.

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
   - Broadcasts `presence_update` with `activities: []` to all user's spaces
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
  userActivities: Map<string, Activity[]>;  // All users' activities, keyed by userId
  showActivity: boolean;                     // Current user's visibility preference
  myActivities: Activity[] | null;           // Current user's own activities (cached locally)
}
```

### Key Methods

| Method | Behavior |
|--------|----------|
| `setUserActivities(userId, activities)` | Updates map; deletes entry if empty array |
| `clearUserActivities(userId)` | Removes entry from map |
| `initActivities(activityMap)` | Bulk-set from ready payload (merges into existing map) |
| `setShowActivity(show)` | Sets flag; if `false`: cancels debounce, sends empty `activity_update` via `wsSendAll`, clears `myActivities` |
| `pushActivities(activities)` | Guards on `showActivity`; sets `myActivities` immediately; starts/resets 5s debounce timer; on fire: sends `activity_update` via `wsSendAll` |
| `reset()` | Cancels timer, clears all state |

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

Activities are looked up by `friend.homeUserId ?? friend.id` — this handles federated users whose local ID differs from their home instance ID.

### Empty State

When all three groups are empty, displays: "It's quiet for now..." with explanatory text.

---

## MemberSidebar (`layout/MemberSidebar.tsx`)

Displayed in space views (right sidebar, 240px wide). Shows space members grouped by role, with activity display.

### Activity Integration

Activities are looked up by `member.userId` from the `userActivities` map. Each member row renders an `ActivityCard` with `fallbackCustomStatus` from `member.user.customStatus`. Offline members do not display activities.

### Role Grouping

Members are grouped by highest-positioned role (see `getMemberGroup`). The owner always sorts first. Activity display is orthogonal to role grouping.

---

## WebSocket Events (Cross-Reference)

See websocket.md for full wire format. Summary of activity-related events:

### Client to Server

| Event | Fields | Notes |
|-------|--------|-------|
| `presence_update` | `status: 'online' \| 'idle' \| 'dnd'` | Persisted to DB |
| `activity_update` | `activities: Activity[]` | Rate-limited 3s server-side; rejected if `showActivity=false` |

### Server to Client

| Event | Fields | Scope |
|-------|--------|-------|
| `presence_update` | `userId, status, activities?` | All spaces the user belongs to + self |

Note: `activities` field is present only when non-empty. Both `presence_update` (status change) and `activity_update` (activity change) result in outbound `presence_update` events to clients — the server coalesces them into a single event type.

### Ready Payload

The `ready` event includes `userActivities: Record<userId, Activity[]>` containing activities for all visible users (space members + DM members), with synthetic `custom` activities injected for users with `customStatus` but no ephemeral activities.
