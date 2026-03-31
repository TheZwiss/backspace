# Authentication & Session System

Source files:
- `packages/server/src/routes/auth.ts` -- Registration, login, username availability endpoints
- `packages/server/src/routes/users.ts` -- Password change, account deletion endpoints (lines 58-156)
- `packages/server/src/routes/admin.ts` -- Admin password reset endpoint (lines 232-265)
- `packages/server/src/utils/auth.ts` -- Password hashing, JWT sign/verify, `authenticate` preHandler, `requireAdmin`
- `packages/server/src/utils/userDeletion.ts` -- `tombstoneUser()` transactional account erasure
- `packages/server/src/utils/sanitize.ts` -- `sanitizeUser()` strips internal fields, anonymizes deleted users
- `packages/server/src/ws/handler.ts` -- WebSocket auth handshake (lines 1282-1374)
- `packages/web/src/stores/authStore.ts` -- Client session state, login/register/logout/password/delete actions
- `packages/web/src/hooks/useAuth.ts` -- Route guard hook (redirect to `/login` when no token)
- `packages/web/src/App.tsx` -- `ProtectedRoute` and `AuthRedirect` route wrappers
- `packages/web/src/utils/identity.ts` -- Federation-aware identity helpers (`parseFederatedUsername`, `isSelf`, `canonicalUserMatch`)
- `packages/web/src/utils/federationOps.ts` -- Cross-instance password sync and account deletion propagation
- `packages/server/src/config.ts` -- `jwtSecret`, `jwtExpiresIn`, `registrationOpen` config

DB tables: `users`, `instanceSettings`. See `database.md` for full schemas.

---

## 1. Password Hashing

**Library:** `bcryptjs`
**Salt rounds:** 12 (constant `SALT_ROUNDS` in `auth.ts`)

```
hashPassword(password: string): Promise<string>   -- bcrypt.hash(password, 12)
verifyPassword(password: string, hash: string): Promise<boolean>  -- bcrypt.compare
```

**Federation stub marker:** Replicated user stubs have `passwordHash = '!federation-replicated'`. Since bcrypt never produces this value, login is impossible for stubs. See `federation.md` for identity resolution.

---

## 2. JWT Management

### Signing

```typescript
interface JwtPayload {
  userId: string;
  username: string;
  iat?: number;       // Auto-set by jsonwebtoken library (seconds since epoch)
}
```

- **Algorithm:** HS256 (enforced on verify via `{ algorithms: ['HS256'] }`)
- **Secret:** `config.jwtSecret` (env `JWT_SECRET`, minimum 32 characters -- startup crash if shorter)
- **Expiry:** `config.jwtExpiresIn` (env `JWT_EXPIRES_IN`, default `'30d'`)
- **Library:** `jsonwebtoken`

`signJwt(payload)` creates a token with `{ expiresIn }` option. The `iat` field is auto-injected by the library.

### Validation (`authenticate` preHandler)

Applied as `preHandler` on all authenticated routes. Flow:

1. Extract `Bearer <token>` from `Authorization` header
2. `verifyJwt(token)` -- checks signature (HS256) and expiry
3. DB lookup: fetch `id`, `isDeleted`, `passwordChangedAt` from `users` table
4. Reject if user not found or `isDeleted === 1`
5. **Token revocation check:** if `passwordChangedAt` is set and `payload.iat` exists, reject if `iat < Math.floor(passwordChangedAt / 1000)` (JWT `iat` is seconds, `passwordChangedAt` is milliseconds)
6. Attach `userId` and `username` to `request` object

### Token Revocation

There is **no token blocklist**. The only revocation mechanism is the `passwordChangedAt` timestamp:

- When a user changes their password (or an admin resets it), `passwordChangedAt` is set to `Date.now()`
- All tokens issued before that timestamp (`iat < passwordChangedAt/1000`) are rejected
- A fresh token is issued after password change

**Exception:** Federation password self-healing (see section 4) does NOT set `passwordChangedAt` -- it is a state correction, not a password change, so existing valid JWTs remain valid.

### WebSocket Auth

`ws/handler.ts:registerWebSocket()` -- WS connection at `/ws`:

1. Client connects, 10-second auth timeout starts
2. First message must be `{ type: 'auth', token: '<jwt>' }`
3. `verifyJwt(token)` validates signature and expiry
4. DB check: reject if user deleted or token revoked (same `passwordChangedAt` logic as REST)
5. On success: clears timeout, sets status to `'online'`, registers connection, sends `ready` payload, broadcasts presence
6. On failure: sends error message and closes socket

---

## 3. Registration Flow

**Endpoint:** `POST /api/auth/register`
**Rate limit:** 10 requests / 2 minutes per IP
**Auth:** None

### Input Validation

| Field | Rules |
|-------|-------|
| `username` | Required string. Trimmed, lowercased. |
| `password` | Required string. Minimum 8 characters. |
| `displayName` | Optional. Trimmed or null. |
| `avatarColor` | Optional. Must be in `AVATAR_COLORS` array, else random. |
| `homeInstance` | Optional (federation only). Max 253 chars, alphanumeric + `.` `-` `_`. |
| `homeUserId` | Optional (federation only). Stored if `homeInstance` is present. |

### Username Validation (Two Paths)

**Local registration** (`homeInstance` absent):
- Length: 3-32 characters
- Pattern: `/^[a-z0-9_]+$/` (lowercase alphanumeric + underscore)
- No `@` allowed

**Federated/replicated registration** (`homeInstance` present):
- MUST use `username@domain` format (plain usernames reserved for native users)
- Local part: 3-32 chars, `/^[a-z0-9_]+$/`
- Domain part: 1-253 chars, `/^[a-zA-Z0-9._-]+$/`
- Total: max 100 characters

### Registration Gate

Registration open/closed is determined by:
1. `instanceSettings.registrationOpen` (DB, id=1) -- if not null, this takes priority
2. `config.registrationOpen` (env `REGISTRATION_OPEN`, default `true`) -- fallback

Both are checked. DB value overrides env when explicitly set by admin.

### First-User Admin Promotion

```
const userCount = db.select().from(schema.users).all().length;
const isFirstUser = userCount === 0 && !homeInstance;
```

The very first user registered on the instance (and only if local, not replicated) gets `isAdmin = 1`.

### Avatar Color Assignment

```typescript
const AVATAR_COLORS = ['mint', 'sky', 'lavender', 'coral', 'rose', 'teal', 'amber'] as const;
```

If `requestedAvatarColor` is provided and is in `AVATAR_COLORS`, use it. Otherwise, pick randomly from the array.

### Registration Steps

1. Validate inputs (username format, password length)
2. Check registration is open
3. **Federated stub upgrade check** (if `homeInstance` is set): call `findFederatedUser` to look for an existing relay-created stub. If found and upgradeable, upgrade it instead of creating a new record (see below).
4. Check username uniqueness (exact match on lowercased username)
5. Hash password (bcrypt, 12 rounds)
6. Generate Snowflake ID
7. Insert user row with `status: 'online'`, admin flag if first user
8. Sign JWT with `{ userId, username }`
9. Return `{ token, user }` (user sanitized via `sanitizeUser(user, true)`)

### Federated Stub Upgrade

When a user registers with `homeInstance` set (federated registration via friend-connect), the registration path checks for an existing relay-created stub using `findFederatedUser`. If found and the stub has `passwordHash = '!federation-replicated'` (not a real account), the stub is upgraded:

- `passwordHash` is set to the new bcrypt hash (enables login)
- `username` is updated to the registration's chosen username (replaces placeholder like `291255103060533248@nova.ddns.net` with `nova@nova.ddns.net`)
- `homeUserId` is backfilled if null
- Missing profile fields (`displayName`, `avatarColor`) are filled

The user's ID remains the same, preserving all existing FK references (DM memberships, messages, reactions, friendships). The user logs in and sees their full history. Returns HTTP 200 (not 201).

If the found user has a real password hash (already registered), the registration returns 409 and the client falls back to login.

### Username Availability Check

**Endpoint:** `GET /api/auth/check-username?username=<name>`
**Rate limit:** 30 requests / 1 minute per IP
**Auth:** None

Validates format (same rules as local registration: 3-32 chars, `/^[a-z0-9_]+$/`), checks registration gate, then queries `users` table for existence. Returns `{ available: boolean, reason?: string }`.

---

## 4. Login Flow

**Endpoint:** `POST /api/auth/login`
**Rate limit:** 15 requests / 2 minutes per IP
**Auth:** None

### Steps

1. Validate `username` and `password` are present strings
2. Look up user by `username` (trimmed, lowercased)
3. Reject if not found (generic "Invalid username or password")
4. Reject if `isDeleted === 1` ("This account has been deleted")
5. Verify password via bcrypt
6. **If password invalid AND user is federated:** attempt self-healing (see below)
7. **If password invalid AND user is local:** reject
8. Set user status to `'online'`
9. Sign JWT, return `{ token, user }`

### Federation Password Self-Healing

When local bcrypt verification fails for a user with `homeInstance` set:

1. Extract base username (strip `@domain` if present)
2. POST to `https://{homeInstance}/api/auth/login` with base username and provided password
3. Timeout: 10 seconds (`AbortController`)
4. **If home instance accepts (200):**
   - Re-hash password locally: `hashPassword(password)`
   - Update local `passwordHash` -- but **do NOT set `passwordChangedAt`** (this is a state correction, not a password change; setting it would invalidate existing valid JWTs on this instance)
   - Log the self-healing event
   - Continue with login success
5. **If home instance rejects:** return "Invalid username or password"
6. **If home instance unreachable (network error/timeout):** return "Invalid username or password" (fall back to local-only rejection)

This flow ensures that when a federated user changes their password on their home instance, they can still log in on remote instances even if the remote's hash is stale.

---

## 5. Password Change

### User Password Change

**Endpoint:** `POST /api/users/@me/change-password`
**Rate limit:** 5 requests / 15 minutes
**Auth:** JWT (`authenticate` preHandler)

**Request body:** `{ currentPassword?: string, newPassword: string }`

| User type | `currentPassword` | Behavior |
|-----------|-------------------|----------|
| Local (`homeInstance` is null) | Required | Verified via bcrypt against stored hash |
| Federated (`homeInstance` set) | Not required | JWT auth is sufficient (home instance already verified the change) |

**Steps:**
1. Validate `newPassword` is string, min 8 chars
2. Load user from DB
3. If local: require and verify `currentPassword`
4. Hash new password
5. Update `passwordHash` AND `passwordChangedAt = Date.now()` -- this invalidates all prior tokens
6. Sign fresh JWT, return `{ token }`

### Admin Password Reset

**Endpoint:** `POST /api/admin/users/:id/reset-password`
**Auth:** JWT + `requireAdmin` (instance admin only)

**Guards:**
- Target user must exist
- Target must not be deleted
- Target must not be federated (`homeInstance` must be null -- "Federated users authenticate via their home instance")

**Steps:**
1. Generate temporary password: `crypto.randomBytes(12).toString('base64url')` (16 chars)
2. Hash it and update `passwordHash` + `passwordChangedAt = Date.now()`
3. `connectionManager.forceDisconnectUser(targetId)` -- closes all WS connections, forcing re-auth
4. Return `{ temporaryPassword }` -- admin must relay this to the user out-of-band

### Cross-Instance Password Propagation (Client-Side)

When a user changes their password on their home instance, `authStore.changePassword()`:

1. Changes password on home instance via API
2. Updates local token in localStorage and Zustand state
3. Calls `changePasswordOnRemotes(newPassword)` from `federationOps.ts`

`changePasswordOnRemotes()` flow:

1. Gets all connected remote instances from `instanceStore`
2. Cancels any existing retry timers for those origins
3. For each connected instance, calls `inst.api.users.changePassword({ newPassword })` with retry:
   - **Initial retry:** `retryWithBackoff()` -- 3 attempts, exponential backoff starting at 2000ms (2s, 4s, 8s)
   - On success: updates cached token for that instance, clears pending sync flag
4. If initial retries fail, starts `scheduleBackgroundRetry()`:
   - Schedule: 10 attempts at 30s intervals (5 min), then 12 attempts at 5min intervals (60 min)
   - Each attempt looks up current instance from store (avoids stale references)
   - Stops if instance disconnected or removed
   - On exhaustion: sets `pendingPasswordSync` flag on the instance (UI indicator)

**Timer management:**
- `activeRetryTimers` map tracks per-origin retry timers
- `clearPasswordSyncTimers()` cancels all active retries (called on logout)
- New password change cancels existing retry loops for affected origins

---

## 6. Account Deletion

### Self-Deletion

**Endpoint:** `DELETE /api/users/@me`
**Rate limit:** 3 requests / 15 minutes
**Auth:** JWT (`authenticate` preHandler)

**Request body:** `{ password: string, username: string }`

**Pre-checks:**
1. `username` must match stored username (confirmation safeguard)
2. Local users must provide and verify `password`; federated users rely on JWT auth
3. Must not own any spaces (returns 400 with `ownedSpaces` list)

**Client-side flow** (`authStore.deleteAccount()`):
1. Call `deleteAccountOnRemotes()` first (best-effort, see below)
2. Call `api.users.deleteAccount()` on home instance
3. Clear localStorage token, reset all user-scoped stores

### Federation Account Deletion

`deleteAccountOnRemotes()` runs before home deletion:
- For each connected remote instance, calls `inst.api.users.deleteAccount({ password: '', username: inst.username })`
- Password is empty string (not needed for federated users on remotes)
- Best-effort: failures are caught and returned as `FederationOpResult[]` but do not block home deletion

### Tombstoning (`tombstoneUser()`)

All cleanup runs in a single SQLite transaction:

**Relationship cleanup (deletes):**
- `spaceMembers` -- removes from all spaces
- `memberRoles` -- removes all role assignments
- `friends` -- removes all friendships (both directions)
- `friendRequests` -- removes all friend requests (both directions)
- `dmMembers` -- removes from all DM channels
- `readStates` -- removes all read state records
- `reactions` -- removes all message reactions
- `dmReactions` -- removes all DM reactions
- `spaceFolders` -- removes all space folders
- `bans` -- removes bans where user is target (try/catch for table existence)
- `joinRequests` -- removes join requests (try/catch)
- `voiceRestrictions` -- removes voice restrictions (try/catch)

**Moderator reference cleanup (nullifies):**
- `bans.bannedBy` -- nullified where points to deleted user
- `voiceRestrictions.moderatorId` -- nullified
- `joinRequests.decidedBy` -- nullified

**Channel override cleanup:**
- Deletes `channelOverrides` where `targetType = 'member'` and `targetId = uid`

**Group DM ownership transfer:**
- For each group DM owned by the user, transfers to next remaining member
- If no remaining members, DM becomes orphaned

**Orphaned DM cleanup:**
- Finds DM channels with zero members after removal
- For each: collects attachment filenames, deletes attachments, reactions, messages, and the channel

**User row anonymization:**
```
username:    '!deleted:{uid}'     -- frees original username for reuse
passwordHash: crypto.randomBytes(32).toString('hex')  -- random, unverifiable
displayName:  null
avatar:       null
banner:       null
bio:          null
customStatus: null
accentColor:  null
avatarColor:  null
replicatedInstances: '[]'
isDeleted:    1
status:       'offline'
isAdmin:      0
```

**Return value:** Array of filenames to delete from disk (avatar, banner, orphaned DM attachments). Caller handles disk cleanup.

**Post-transaction (in route handler):**
- Delete files from disk via `deleteUploadFile()`
- `connectionManager.forceDisconnectUser()` -- closes all WS connections, leaves voice rooms, broadcasts presence

### `sanitizeUser()` for Deleted Users

When `isDeleted === 1`, returns an anonymized profile:
- `username: 'Deleted User'`
- All profile fields null/empty/false
- `status: 'offline'`
- Only `id` and `createdAt` preserved

---

## 7. Client-Side Session Lifecycle

### State (`authStore`)

```typescript
interface AuthState {
  token: string | null;        // Persisted in localStorage as 'backspace_token'
  user: User | null;           // Current user object
  isLoading: boolean;
  error: string | null;
}
```

**Initialization:** `token` is read from `localStorage.getItem('backspace_token')` on store creation.

### `initSession(token, user)`

Called after successful login or registration:
1. `resetUserStores()` -- clears all user-scoped stores (chat, space, social, voice, instance, activity) and `clearSelfIds()` from identity registry
2. Saves token to localStorage
3. Sets token + user in Zustand state
4. Fires `useInstanceStore.autoConnectAll()` (fire-and-forget) for federation

### `loadUser()`

Called by `useAuth()` hook when token exists but user object is null:
1. Calls `api.users.me()` to fetch current user
2. On success: sets user, triggers `autoConnectAll()`
3. On failure: removes token from localStorage, clears state (forces redirect to login)

### `logout()`

1. Removes token from localStorage
2. Calls `resetUserStores()` (clears all stores + self IDs)
3. Sets token and user to null

### Route Guards

**`ProtectedRoute`** (in `App.tsx`):
- Reads `token` from authStore
- If no token: `<Navigate to="/login" replace />`
- Used for `/channels/:spaceId/:channelId?` and `/explore`

**`AuthRedirect`** (in `App.tsx`):
- Reads `token` from authStore
- If token present: redirects to `?redirect` param or `/channels/@me`
- Used for `/login` and `/register` routes
- Prevents authenticated users from seeing auth pages

**`useAuth()` hook:**
- Watches `token`, `user`, `isLoading`
- If no token: navigates to `/login`
- If token but no user and not loading: calls `loadUser()`
- Returns `{ user, isLoading, isAuthenticated }`

### Login Page

- Fields: username, password
- Redirect support: reads `?redirect` param, navigates there on success (validated: must start with `/`, not `//`)
- Rate limit handling: catches `RateLimitError`, shows countdown timer
- Links to register page (preserves redirect param)

### Registration Page (Two-Step)

**Step 1 -- Credentials:**
- Fields: username, password, confirm password
- Client-side validation: 3-32 chars, `/^[a-z0-9_]+$/`, passwords match, min 6 chars
- Debounced username availability check (500ms delay, abort on new input)
- Continue button disabled if username taken or invalid

**Step 2 -- Personalization:**
- Fields: display name (optional), avatar color picker, avatar upload (with crop modal)
- "Get Started" button: registers with personalization
- "Skip for now" button: registers without personalization
- Registration flow:
  1. Call `api.auth.register()` -- saves token to localStorage but NOT to Zustand (prevents premature `AuthRedirect`)
  2. If avatar file selected: upload file, then `api.users.update({ avatar })` (failure is non-fatal)
  3. `initSession(token, finalUser)` -- activates Zustand state, triggers redirect
  4. Navigate to redirect param or `/channels/@me`

---

## 8. Federation-Aware Identity Utilities

### `parseFederatedUsername(username)`

Splits a potentially federated username:
```
"youruser@nova.ddns.net" -> { baseName: "youruser", domain: "nova.ddns.net" }
"youruser"                -> { baseName: "youruser", domain: null }
```

### Self-ID Registry

Module-level `Set<string>` tracking all Snowflake IDs belonging to the current user across connected instances:

```
registerSelfId(id: string)   -- adds ID (called from WS ready events)
clearSelfIds()               -- clears all (called on logout/session reset)
```

### `isSelf(user, homeUser)`

Determines if a user object represents the current user. Cascading checks:
1. Same `id` (same instance, trivial)
2. `_knownSelfIds.has(user.id)` (cross-instance via registry)
3. `user.homeInstance === window.location.host` AND base usernames match

### `canonicalUserMatch(a, b)`

Federation-safe comparison of two user-like objects. Cascading strategies:
1. Same `id` -- trivial match
2. `homeUserId` cross-matching (both have it, or one matches the other's `id`)
3. Username + home instance fallback: parse base names, derive home from `homeInstance` or domain part of username, compare

### `resolveDisplayIdentity(user, homeUser)`

If `user` is a replicated alias of `homeUser` (via `isSelf`), returns `homeUser` for display purposes. Otherwise returns `user` unchanged.

---

## 9. Rate Limits Summary

| Endpoint | Max | Window |
|----------|-----|--------|
| `POST /api/auth/register` | 10 | 2 min |
| `GET /api/auth/check-username` | 30 | 1 min |
| `POST /api/auth/login` | 15 | 2 min |
| `POST /api/users/@me/change-password` | 5 | 15 min |
| `DELETE /api/users/@me` | 3 | 15 min |

All keyed by `request.ip`.

---

## 10. Configuration Reference

| Config key | Env var | Default | Notes |
|------------|---------|---------|-------|
| `jwtSecret` | `JWT_SECRET` | (required) | Min 32 chars, startup crash if shorter |
| `jwtExpiresIn` | `JWT_EXPIRES_IN` | `'30d'` | Passed to `jsonwebtoken` `expiresIn` option |
| `registrationOpen` | `REGISTRATION_OPEN` | `true` | Overridden by `instanceSettings.registrationOpen` in DB |

---

## 11. `requireAdmin` Guard

`auth.ts:requireAdmin()` -- used as preHandler alongside `authenticate`:
1. Loads full user from DB by `request.userId`
2. Rejects with 403 if user not found or `isAdmin !== 1`
3. Used by admin routes (user management, password reset, federation peer management)
