# Authentication & Session System

Source files:
- `packages/server/src/routes/auth.ts` -- Registration, login, username availability, invite-token check endpoints
- `packages/server/src/routes/invites.ts` -- Admin invite-link CRUD (create / list / patch / revoke / reinstate / delete / redemptions)
- `packages/server/src/utils/inviteService.ts` -- Invite token generation, status derivation, atomic `redeemInvite()` transaction
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

The `/api/auth/register` route splits its gate by request shape (spec §1.2). There are **two independent toggles** plus an **invite-token bypass** for the local path.

**Local anonymous signup** (no `homeInstance` in body):

1. `instanceSettings.registrationOpen` (DB, id=1) -- if not null, this takes priority
2. `config.registrationOpen` (env `REGISTRATION_OPEN`, default `true`) -- fallback

DB value overrides env when explicitly set by admin. When closed, a valid `inviteToken` bypasses the gate and is **atomically consumed** alongside the user insert (see "Invite Tokens" below). When open, an `inviteToken` field is **silently ignored** (no validation, no consumption).

**Federated identity replication** (request body has `homeInstance`):

- Gated solely by `instanceSettings.federatedRegistrationOpen` (NOT NULL DEFAULT 1).
- `inviteToken` is **ignored entirely** on this path -- tokens never unlock federated creation, even when supplied.
- Closed → 403 `"Federated registration is closed on this instance"`.

**Invariants** (spec §1.3):

- **Login-unaffected invariant.** Neither toggle gates `POST /api/auth/login` for any user. Existing federated accounts always log in regardless of `federatedRegistrationOpen`; existing local accounts always log in regardless of `registrationOpen`. Both gates affect **creation only**. This is why the Connections add-instance form keeps its submit button enabled even when the target instance has `federatedRegistrationOpen = false` (see `client-federation.md`): the request runs through `instanceStore`'s register-then-login fall-through, and the login leg succeeds for users who already have a federated account on that instance.
- The federated stub upgrade flow (below) is gated by `federatedRegistrationOpen`, never by an invite token. Tokens only unlock the local anonymous-signup path.

**Toggle matrix** (spec §5.6):

| `registrationOpen` | `federatedRegistrationOpen` | Local register | Federated register | Connections UI behavior |
|---|---|---|---|---|
| true | true | open | allowed | normal |
| true | false | open | 403 | warning banner; submit enabled (login fall-through) |
| false | true | invite-required | allowed | normal |
| false | false | invite-required | 403 | warning banner; submit enabled (login fall-through) |
| false (any) | (any) | invite bypasses | NOT bypassable by token | — |

S2S DM stub creation (relay path, never `/register`) is gated only by federation peering settings — neither toggle affects it.

### Invite Tokens

When `registrationOpen` is false, the local-signup path accepts an `inviteToken` field on the register body. Token format: 22-char base64url (`crypto.randomBytes(16).toString('base64url')` — 128 bits of entropy; collision probability against the existing space is `~2^-122`, with the DB UNIQUE on `invite_links.token` as the safety net + retry-up-to-3 in the create handler). Admin CRUD lives in `inviteService.ts` and `routes/invites.ts` -- see `docs/systems/admin.md` for the panel UX and the full status state machine.

**Lifecycle:**

```
create  →  active  ──(usedCount = maxUses)─→  exhausted  ┐
              │                                          │
              │  ┌──(expiresAt < now)──→  expired  ──────┤
              │  │                                       │
              ↓  ↓                                       │
            revoke ──(revokedAt set)──→  revoked         │ reinstate
                                            │           ←┘ (Path A: token rotates;
                                            │              Path B: same token)
                                            └──→ active again
                                                   │
                                            DELETE /admin/invites/:id
                                                   │
                                                   ↓
                                                hard-delete (CASCADE redemptions)
```

Status is **derived** at read time from `(revokedAt, expiresAt, usedCount, maxUses)` — no stored column. Reinstate branches on the pre-reinstate status: revoked → token rotates (`tokenRotated: true`); expired/exhausted → token preserved (`tokenRotated: false`); already-active → 409.

**Audit trail (`invite_redemptions`):** every successful redemption inserts one row with `inviteId` (FK CASCADE — admin hard-delete drops the audit), `userId` (FK SET NULL — defensive against future hard-delete; tombstone keeps it populated), `registrantUsername` (snapshot at registration moment, preserves forensic value when the user is later renamed or tombstoned `!deleted:{uid}`), and `redeemedAt`.

Atomic redemption (spec §2.4):

```
db.transaction(() => {
  // 1. Re-fetch invite by token under txn (closes TOCTOU vs /check-invite)
  // 2. Reject if status !== 'active' → throw InviteUnavailableError → 403
  // 3. INSERT user row
  // 4. UPDATE invite_links SET usedCount = usedCount + 1
  // 5. INSERT invite_redemptions row (forensic audit, snapshots username)
})
```

If any step throws (concurrent revoke, last-slot race, username collision against the unique index), the entire transaction rolls back -- `usedCount` is never incremented on a failed registration. The route catches `InviteUnavailableError` from `redeemInvite()` and surfaces it as 403 `"Invalid or expired invite"`.

- **Federated stub upgrade and federated new-account paths do NOT enter `redeemInvite`.** They are gated only by `federatedRegistrationOpen` and never consume tokens, even if a token is provided in the request body. This is the structural enforcement of the spec §1.3 invariant "tokens never unlock federated creation".

The `/api/auth/check-invite` debounced UX endpoint pre-validates a token from the register page; the in-txn re-derive inside `redeemInvite()` is the authoritative enforcement point.

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
2. Read both registration gates from `instance_settings`
3. **Branch by request shape** (spec §1.2):
   - If `homeInstance` set → reject with 403 unless `federatedRegistrationOpen === true`. `inviteToken` ignored on this path.
   - Else (local) → if `registrationOpen` is false, require a valid `inviteToken`; otherwise reject with 403. Pre-flight token check rejects obvious-invalid tokens before bcrypt.
4. **Federated stub upgrade check** (if `homeInstance` is set): call `findFederatedUser` to look for an existing relay-created stub. If found and upgradeable, upgrade it instead of creating a new record (see below).
5. Check username uniqueness (exact match on lowercased username)
6. Hash password (bcrypt, 12 rounds)
7. Generate Snowflake ID
8. Insert user row (status defaults to `'offline'` at the schema level; it is set to `'online'` only when the client establishes a WebSocket via the WS auth path in `ws/handler.ts`). Admin flag set if first user. **When the local-closed-with-token path is in play**, the insert runs inside `redeemInvite()`'s transaction so the user row, the `usedCount` bump, and the `invite_redemptions` row commit atomically (or all roll back).
9. Sign JWT with `{ userId, username }`
10. Return `{ token, user }` (user sanitized via `sanitizeUser(user, true)`)

### Federated Stub Upgrade

When a user registers with `homeInstance` set (federated registration via friend-connect), the registration path checks for an existing relay-created stub using `findFederatedUser`. The stub-upgrade flow is **always gated by `federatedRegistrationOpen`**, never by an invite token (spec §1.3). If found and the stub has `passwordHash = '!federation-replicated'` (not a real account), the stub is upgraded:

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
5. Verify password via bcrypt. **`federationHomeOrphaned === 1` no longer short-circuits here.** A federated account whose home instance was reset (a new incarnation stood up on the same domain) is now treated as **detached** — a sovereign LOCAL account whose local password hash is the sole authority (detach design §4.1). Local-hash verification proceeds normally: the correct local password logs in. The flag's only login effect is to permanently disable the self-heal path (step 7). *(Historical note: this check was previously a pre-verification freeze that blocked the local-password path too; the detach re-interpretation removed it so the real owner keeps their account instead of being locked out.)*
6. *(merged into step 5)*
7. **If password invalid AND user is federated:** if `federationHomeOrphaned === 1` (detached), reject immediately with the generic "Invalid username or password" — **no outbound request to the home domain**: there is no trusted home to consult, and re-hashing on the new incarnation's say-so would hand the account to a stranger. Otherwise attempt self-healing (see below).
8. **If password invalid AND user is local:** reject
9. Sign JWT, return `{ token, user }`. **Note:** Login does NOT mutate `users.status`. A successful login does not by itself imply a live connection (the client may never establish a WebSocket due to network failure, mobile background, error path); writing `'online'` here would produce a permanently stuck-online row that no disconnect timer cleans up. The WebSocket auth path (`ws/handler.ts`) is the single source of truth for `status = 'online'`. See `docs/systems/activity-presence.md` "Boot Reset" for the mitigation that runs on server start.

### Federation Password Self-Healing

When local bcrypt verification fails for a user with `homeInstance` set:

1. Extract base username (strip `@domain` if present)
2. POST to `https://{homeInstance}/api/auth/login` with base username and provided password
3. Timeout: 10 seconds (`AbortController`)
4. **If home instance accepts (200):** run the **epoch guard** (see below) before re-hashing. If the guard passes:
   - Re-hash password locally: `hashPassword(password)`
   - Update local `passwordHash` -- but **do NOT set `passwordChangedAt`** (this is a state correction, not a password change; setting it would invalidate existing valid JWTs on this instance)
   - Log the self-healing event
   - Continue with login success
5. **If home instance rejects:** return "Invalid username or password"
6. **If home instance unreachable (network error/timeout):** return "Invalid username or password" (fall back to local-only rejection)

This flow ensures that when a federated user changes their password on their home instance, they can still log in on remote instances even if the remote's hash is stale.

#### Epoch guard (instance-epoch self-healing §6.3a)

Before re-hashing, the self-heal confirms the home instance is the **same incarnation** the trusted baseline was established with. Without this, a factory-reset home accepting a *new* same-name user's password would silently hand that stranger the established account. The guard does **not** trust the login-response body (TLS-MITM-bypassable, and a reset home would just echo its new epoch); it **reuses the authenticated `fetchPeerEpoch(peer)`** (`utils/federationEpoch.ts`, HMAC-signed request *and* response) to read the home's current epoch, then compares it to `federation_peers.peerInstanceId` for that origin (three-way):

- **No peer row / `peerInstanceId` is null** (legacy/never-tracked): allow — fall through to self-heal (no regression).
- **Baseline on record AND `fetchPeerEpoch` returns a *different* epoch:** refuse self-heal → "Invalid username or password" (the hijack case).
- **Baseline on record AND `fetchPeerEpoch` returns `null`** — epoch cannot be determined (peer too old → 404, unreachable, bad/absent response signature, **or the reset peer's desynced secret rejecting our signed request**): **fail closed — refuse self-heal.**
- **Baseline on record AND the epoch matches:** allow.

Trade-off: the separate authenticated call can fail independently of the login POST, so a transient home outage during a legitimate stale-hash login fails closed. This is security-over-availability on a rare, recoverable path (fallback: a normal password change once the home is reachable); trusting an unauthenticated body would re-open the hijack. A reset peer's `null` result also doubles as a reset signal — the guard is correct even before reset-detection has flagged the peer. This epoch guard covers the **undetected-reset window** — non-detached federated accounts whose home was reset but not yet quarantined. Once the quarantine flags an account as **detached** (`federationHomeOrphaned = 1`), the self-heal path is disabled for it entirely (step 7 of the Login Flow): the detached account is no longer a remote identity that can be self-healed at all, so the epoch comparison never runs for it — the local hash is its only authority. Re-peering the new incarnation therefore cannot re-open self-heal into a detached account.

#### Re-attach: leaving the detached state (re-attach spec §3.2)

Detach is sovereign but not permanent: the legitimate owner who re-created their account on the reset home can re-bind the detached account to the new home identity via `POST /api/users/@me/reattach` (registered in `routes/federation.ts`; see `federation.md` "Peer-Side Re-Attach"). It re-binds **only** on possession of BOTH identities — the session IS the detached account (local password authority, via `authenticate`) AND a one-time proof token minted on the home via `POST /api/auth/attach-proof` verifies with the home peer over signed S2S. Identity is never username-matched (that is the tier-2 hijack). On success the endpoint merges any pre-existing replicated stub for the new identity into the detached row, sets `home_user_id = <new homeUserId>`, **clears `federation_home_orphaned` (0)**, nulls `profile_updated_at`, and applies the current home profile. Clearing the flag automatically **re-enables** normal federated-account semantics: login self-heal resumes (the epoch guard above runs again) and the S2S binding guards stop excluding the account — live profile/presence sync from the home is restored. The local password hash is kept; a detached tombstone (`is_deleted = 1`) is never re-attachable.

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
| Federated (`homeInstance` set, `federationHomeOrphaned !== 1`) | Not required | JWT auth is sufficient (home instance already verified the change) |
| Detached (`homeInstance` set, `federationHomeOrphaned === 1`) | Required | Follows the **local** rule — the home is gone, so nothing external verified the change; the local hash is the sole authority (detach design §4.4) |

**Steps:**
1. Validate `newPassword` is string, min 8 chars
2. Load user from DB
3. If local **or detached** (`!homeInstance || federationHomeOrphaned === 1`): require and verify `currentPassword`
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
2. Native local users **and detached accounts** (`federation_home_orphaned = 1`) must provide and verify `password` against the local hash; non-detached federated users rely on JWT auth (their home instance already vouches for them). A detached account is a sovereign local account with no home verifying anything, so it follows the LOCAL rule — the same self-destruct protection as a native account, and mirroring the change-password rule (§5, detach spec §4.4). Condition: `!user.homeInstance || user.federationHomeOrphaned === 1`. Missing password → 400; wrong password → 403.
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
- `dmMembers` -- **partitioned**: the row is KEPT for 1-on-1 DMs (`dm_channels.ownerId IS NULL`) so the thread survives as a readable anonymized "Deleted User" thread; it is deleted only for group DMs (`ownerId IS NOT NULL`). The in-function `userDmChannelIds` local captures the user's DM channel ids before partitioning.
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
- Among the user's DM channels, finds those with **zero live members** — `users.isDeleted = 0`, excluding the uid being tombstoned right now (it still reads `isDeleted = 0` at scan time). A Deleted ↔ Survivor 1-on-1 is kept; a Deleted ↔ Deleted 1-on-1 is purged.
- For each: collects attachment filenames, deletes attachments, reactions, messages, and the channel

> **DM tombstone semantics** (1-on-1 survives as a read-only "Deleted User" thread, group DMs drop the member, `isDeadOneOnOne` read-only guard, dead-DM purge rule, one-time backfill, heal-path `user_updated` broadcast): see `docs/systems/dm-system.md` § "DM Tombstone Semantics".

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

### `tombstoneUser()` Options

`tombstoneUser` accepts an optional second argument:

```typescript
interface TombstoneOptions { purgeContent?: boolean }
function tombstoneUser(uid: string, options?: TombstoneOptions): string[]
```

- **`purgeContent: true`** (default / omitted): full tombstone — removes the user from spaces, friends, group DM membership, and read-states; then also deletes `reactions`, `dmReactions`, and the user's space `messages` with their attachments and embeds. 1-on-1 DM membership is kept (see below).
- **`purgeContent: false`**: soft tombstone — removes the user from spaces, friends, group DM membership, and read-states. The `purgeContent: false` flag skips only `reactions`, `dm_reactions`, and the user's space `messages` (with attachments + embeds). The DM membership partition and orphaned-DM purge always run in both modes: group-DM `dm_members` rows are deleted, 1-on-1 `dm_members` rows are KEPT (so the thread survives as an anonymized "Deleted User" thread), and any resulting zero-member DM channel is purged as unreachable garbage. Used by the federation identity soft-delete endpoint so remote message history is retained.

### `resolveOrCreateReplicatedUser` and Deleted Users

`resolveOrCreateReplicatedUser` checks whether a user matching `homeUserId + homeInstance` already exists and has `isDeleted = 1`. If so, it returns `null` rather than returning or re-creating the deleted stub. This prevents zombie identities from reappearing after a federation identity deletion.

### Federation Identity Deletion (Home-Side Trigger)

**Endpoint:** `POST /api/users/@me/federation-identity/delete`
**Rate limit:** 5 requests / 15 minutes
**Auth:** JWT (`authenticate` preHandler)

**Request body:** `{ origins: string[], mode: 'soft' | 'full' }`

Fans out HMAC-signed `DELETE /api/federation/identity` requests to each listed remote in parallel. Returns a per-origin results map:

```json
{ "results": { "<origin>": { "success": true } } }
```

On failure for a given origin the entry contains `{ "success": false, "error": "<message>", "ownedSpaces"?: [...] }`. A `409` from a remote means the user owns spaces there that must be resolved before deletion can proceed.

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

  **Auth-token source of truth.** During the step-2 avatar upload, the JWT lives in `localStorage` only -- `authStore.token` (Zustand) is still null because step 3 hasn't fired. Both the home `api` client (`api/client.ts`) and the home-origin branch of `setTokenForOriginResolver` in `instanceStore.ts` therefore read the home JWT from `localStorage.getItem('backspace_token')`, never from `authStore.token`. This keeps `transferStore.startUpload` (and any other path that resolves a home-origin bearer) authenticated during the registration window. The two stores are written together everywhere else (`initSession`/`logout`), so the divergence only matters between steps 1 and 3 here.

**Responsive contract.** Auth pages render outside `MobileShell` (they are pre-layout). The `RegisterPage` outer wrapper is a self-contained scroll container -- `h-full overflow-y-auto` on the outermost `<div>` because `#root` is `h-full overflow-hidden` (see `globals.css`). An inner `min-h-full flex items-center justify-center` wrapper centers the card vertically when content fits, and falls back to top-aligned scroll when content exceeds the viewport (as on iOS Safari with the keyboard up, where the visible viewport shrinks by ~300 px). Card width is `max-w-[480px]` with `px-4` outer gutters, `p-6 md:p-8` inner padding (smaller on mobile to reclaim 16 px content area at 360 px viewports). All `<input>` elements override the shared `input-standard` class's `text-sm` with `text-base md:text-sm` -- iOS Safari auto-zooms when an input has font-size <16 px. Primary submit buttons use `py-3 md:py-2.5` to satisfy Apple HIG's ≥44 px tap-target rule on mobile. The closed-registration URL-token chip switches from `inline-flex` (desktop pill) to `flex` (mobile full-width banner) so longer error copy ("Invalid invite link -- please request a new one") wraps cleanly inside a 360 px viewport instead of forcing a single-line pill that overflows. The avatar color swatch row uses `gap-2 md:gap-2.5` so the 7 swatches fit within the 360 px content area. **Note:** `LoginPage` does NOT yet apply the same scroll/iOS-zoom/tap-target treatment; this is a known follow-up since LoginPage's shorter form is less likely to clip. Update both together if revisiting.

---

## 8. Federation-Aware Identity Utilities

### `parseFederatedUsername(username)`

Splits a potentially federated username:
```
"erin@nova.ddns.net" -> { baseName: "erin", domain: "nova.ddns.net" }
"erin"                -> { baseName: "erin", domain: null }
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
| `GET /api/auth/check-invite` | 30 | 1 min |
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
| `registrationOpen` | `REGISTRATION_OPEN` | `true` | Overridden by `instanceSettings.registrationOpen` in DB (null DB row = env fallback). Local anonymous signup gate. |
| (no env) | -- | `true` | `instanceSettings.federatedRegistrationOpen` is DB-only (NOT NULL DEFAULT 1) — no env override. Federated identity replication gate. |

---

## 11. `requireAdmin` Guard

`auth.ts:requireAdmin()` -- used as preHandler alongside `authenticate`:
1. Loads full user from DB by `request.userId`
2. Rejects with 403 if user not found or `isAdmin !== 1`
3. Used by admin routes (user management, password reset, federation peer management)
