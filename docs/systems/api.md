# REST API Reference

Base: `/api`. Auth via `Authorization: Bearer <jwt>`. All responses JSON.
Source files: `packages/server/src/routes/*.ts`

---

## Auth (`routes/auth.ts`) — public, rate-limited
```
POST /auth/register         { username, password, displayName?, avatarColor?, homeInstance?, homeUserId?, inviteToken? } → { token, user }
GET  /auth/check-username    ?username= → { available, reason? }
GET  /auth/check-invite      ?token=    → CheckInviteResponse
POST /auth/login             { username, password } → { token, user }
```

**`POST /auth/login`** — request/response shape unchanged, but two internal controls from instance-epoch self-healing gate the flow: (1) an account with `federationHomeOrphaned = 1` (home instance factory-reset) is rejected with the generic 401 *before* password verification; (2) the federated password self-heal now runs an **epoch guard** — it re-hashes the stale local password only if the home instance's authenticated epoch (`fetchPeerEpoch`) matches the trusted baseline, failing closed when the epoch differs or can't be determined. No wire-shape change. See `auth.md` §4.

**`POST /auth/register` gating** — branches on whether `homeInstance` is set:
- **Federated path** (`homeInstance` set): gated solely by `instance_settings.federatedRegistrationOpen`. `inviteToken` is ignored entirely (not validated, not consumed). 403 `Federated registration is closed on this instance` when closed. Existing federated stubs (relay-created, `passwordHash = '!federation-replicated'`) upgrade in place — login is never blocked by this gate.
- **Local path** (no `homeInstance`):
  - When `registrationOpen` is true: `inviteToken` is silently ignored (no row touched, no `usedCount` increment).
  - When `registrationOpen` is false: `inviteToken` is required. The token is pre-validated, then the user INSERT + `usedCount` increment + `invite_redemptions` row INSERT all run in a single transaction (`inviteService.redeemInvite`). 403 `Registration is closed. An invite is required.` (no token) or `Invalid or expired invite` (token rejected at any stage, including a concurrent-redemption race re-check inside the transaction).

**`GET /auth/check-invite`** — public, rate-limited 30/min/IP. Always returns 200; the body discriminates:

```typescript
type CheckInviteResponse =
  | { valid: true; name: string }            // active token; name surfaces for UX
  | { valid: false; reason: 'expired' | 'exhausted' | 'invalid' };
```

`revoked`, malformed (non-22-char-base64url), and not-in-DB tokens all collapse to `'invalid'` (enumeration shield). `name` is returned **only** in the valid case.

## Users (`routes/users.ts`) — auth required
```
GET    /users/@me                                        → { user }
PATCH  /users/@me             { displayName?, avatar?, banner?, accentColor?, avatarColor?,
                                bio?, customStatus?, status?, replicatedInstances?, homeUserId?,
                                profileUpdatedAt?, discoverable?, showActivity? } → { user }
POST   /users/@me/verify-password  { password }          → { valid }
POST   /users/@me/change-password  { currentPassword?, newPassword } → { token }
DELETE /users/@me             { password, username }      → { success }
PUT    /users/@me/space-layout { items, folders, updatedAt? } → { items, folders, updatedAt }
GET    /users/@me/federation-registry                    → { registry: FederationRegistryEntry[], updatedAt: number }
PUT    /users/@me/federation-registry { registry, updatedAt } → { ok: true, updatedAt } (409 if not newer)
GET    /users/:id                                        → { user }
GET    /users/:id/mutuals     ?homeUserId=               → { mutualFriends[], mutualSpaces[] }
```

**Write protection:** If the authenticated user is a replicated user (`homeInstance` is set), the following fields are rejected with 403: `displayName`, `avatar`, `banner`, `accentColor`, `avatarColor`, `bio`. These fields are managed by the home instance via S2S relay.

## Spaces (`routes/spaces.ts`) — auth required
```
GET    /spaces                                                                 → { spaces[] }
POST   /spaces                { name, icon?, description? }                    → { space }
GET    /spaces/:id                                                             → { space, channels[], members[], roles[] }
PATCH  /spaces/:id            { name?, icon?, banner?, description?, visibility?, avatarColor? } → { space }   [MANAGE_SPACE]
DELETE /spaces/:id                                                             → { success }  [owner]
POST   /spaces/:id/invite                                                      → { inviteCode }  [CREATE_INVITE]
POST   /spaces/:id/join       { inviteCode }                                   → { space }
POST   /spaces/join           { inviteCode }                                   → { space }
GET    /spaces/invite/:code/preview                                            → invite preview
PATCH  /spaces/:id/transfer-ownership  { newOwnerId }                          → { space }  [owner]
```

### Members
```
GET    /spaces/:id/members                               → { members[] }
PATCH  /spaces/:id/members/:uid  { nickname?, roles? }   → { member }  [MANAGE_ROLES]
DELETE /spaces/:id/members/:uid                          → { success }  [KICK_MEMBERS|self]
```

### Bans
```
GET    /spaces/:id/bans                                  → { bans[] }  [BAN_MEMBERS]
POST   /spaces/:id/bans       { userId, reason? }        → { success }  [BAN_MEMBERS]
DELETE /spaces/:id/bans/:uid                             → { success }  [BAN_MEMBERS]
```

### Roles
```
POST   /spaces/:id/roles              { name, color?, permissions? }              → { role }  [MANAGE_ROLES]
PATCH  /spaces/:id/roles/:rid         { name?, color?, position?, permissions? }  → { role }  [MANAGE_ROLES]
DELETE /spaces/:id/roles/:rid                                                     → { success }  [MANAGE_ROLES]
POST   /spaces/:id/members/:uid/roles { roleId }                                 → { success }  [MANAGE_ROLES]
DELETE /spaces/:id/members/:uid/roles/:rid                                        → { success }  [MANAGE_ROLES]
```

## Channels (`routes/channels.ts`) — auth required
```
GET    /spaces/:id/channels                              → { channels[] }  [VIEW_CHANNEL]
POST   /spaces/:id/channels   { name, type?, topic?, categoryId? } → { channel }  [MANAGE_CHANNELS]
PATCH  /channels/:id          { name?, type?, topic?, categoryId? } → { channel }  [MANAGE_CHANNELS]
DELETE /channels/:id                                     → { success }  [MANAGE_CHANNELS]
PATCH  /spaces/:id/channels/reorder  { order }           → reordered  [MANAGE_CHANNELS]
```

### Channel Overrides
```
GET    /channels/:id/overrides                                      → { overrides[] }  [MANAGE_CHANNELS]
PUT    /channels/:id/overrides  { targetType, targetId, permissions } → { override }  [MANAGE_CHANNELS]
DELETE /channels/:id/overrides/:targetType/:targetId                 → { success }  [MANAGE_CHANNELS]
```

### Categories
```
POST   /spaces/:id/categories        { name }              → { category }  [MANAGE_CHANNELS]
PATCH  /categories/:id               { name?, position? }  → { category }  [MANAGE_CHANNELS]
DELETE /categories/:id                                      → { success }  [MANAGE_CHANNELS]
GET    /categories/:id/overrides                            → { overrides[] }  [MANAGE_ROLES]
PUT    /categories/:id/overrides     { targetType, targetId, permissions } → { success }  [MANAGE_ROLES]
DELETE /categories/:id/overrides/:tt/:tid                   → { success }  [MANAGE_ROLES]
```

## Messages (`routes/messages.ts`) — auth required
```
GET    /channels/:id/messages  ?before=&limit=50          → { messages[] }  [VIEW_CHANNEL+READ_MESSAGE_HISTORY]
POST   /channels/:id/messages  { content, attachments?, replyToId? } → { message }  [SEND_MESSAGES, +ATTACH_FILES]
PATCH  /messages/:id           { content }                → { message }  [author]
DELETE /messages/:id                                      → { success }  [author|MANAGE_MESSAGES]
```

## DMs (`routes/dm.ts`) — auth required
```
POST   /dm                     { targetUserId, targetUsername? }     → { dmChannel }
POST   /dm/group               { name, memberUserIds[] }            → { dmChannel }
PATCH  /dm/:id                 { name?, icon? }                     → { id, name, icon, metadataUpdatedAt } [owner; group only]
DELETE /dm/:id                                                      → { success } (soft-close)
POST   /dm/:id/members         { userIds[] }                        → { dmChannel } [owner, max 10]
DELETE /dm/:id/members                                              → { success } (leave)
DELETE /dm/:id/members/:targetUserId  ?homeInstance=                → { success } [owner kick; cannot self-kick; group only; segment is homeUserId when ?homeInstance is set]
POST   /dm/:id/transfer        { newOwnerId? | (homeUserId+homeInstance) } → { success } [owner; resolved member must be in channel; not self]
GET    /dm/:id/messages        ?before=&limit=50                    → { messages[] }
POST   /dm/:id/messages        { content, attachments?, replyToId? } → { message }
PATCH  /dm/messages/:id        { content }                          → { message } [author]
DELETE /dm/messages/:id                                             → { success } [author]
```

**`PATCH /dm/:id`** — Owner-only update of a group DM's `name` and `icon`. Either field may be omitted (no-op), null (clear), or set. Empty/whitespace name collapses to null. `icon` accepts a bare attachment filename owned by the caller (image/*, ≤ `GROUP_DM_ICON_MAX_BYTES`) or an absolute http(s) URL. No-op short-circuit when nothing actually changes — emits no system message and no federation relay. See `docs/systems/dm-system.md` "Group Metadata Update" for the full transaction, federation relay, and icon URL round-trip rules.

**`DELETE /dm/:id/members/:targetUserId`** — Owner kicks a member from a group DM. The `:targetUserId` segment carries either a local user id on the owner's instance OR a federated home user id when the `?homeInstance=<origin>` query string is present (server resolves via `resolveOrCreateReplicatedUser` — same pattern as `POST /dm/:id/members`). Federated form is required for federated targets, because the client's cached user view returns the user's home id, not the owner instance's local replicated id. Reuses the leave path with `reason: 'kick'`; evicts the target from the DM voice room first. Sends `dm_channel_closed` to the kicked user. Receivers enforce `sourceInstance === ownerHomeInstance`; non-owner kicks reject as `unauthorized_source`.

**`POST /dm/:id/transfer`** — Owner transfers ownership to another current member without leaving. Body accepts either a local id (`newOwnerId`) or a federated identity (`homeUserId` + `homeInstance`). When both forms are supplied, federated args take precedence. Server resolves via `resolveOrCreateReplicatedUser` before checking membership — mirrors `POST /dm/:id/members`. Updates `ownerId`, `ownerHomeUserId`, `ownerHomeInstance`; inserts an `owner_changed` system message; broadcasts `dm_owner_updated`; queues an `ownership_transfer` outbox event. Reuses the existing receiver path (`processOwnershipTransferEvent`) with no protocol changes.

## Social (`routes/social.ts`) — auth required
```
GET    /social/friends                                    → { friends[] }
GET    /social/requests                                   → { requests[] }
POST   /social/requests        { username }               → { success, requestId }
PATCH  /social/requests/:id    { status: 'accepted'|'declined' } → { request }
DELETE /social/requests/:id                               → { success } (cancel, sender-only)
DELETE /social/friends/:id                                → { success }
GET    /social/discover        ?q=&limit=&offset=         → { users[], total }
GET    /social/search          ?q=                        → { users[] }
```

### POST /api/social/requests — routing & error codes

`body.username` may be `bare` (local), `bare@<own host>` (also routed local — server normalizes), or `bare@<remote host>` (federated branch). The client sends the trimmed handle verbatim; all parsing, routing, peering, and remote lookup are server-side.

| HTTP | error code | When |
|---|---|---|
| 200 | (success, idempotent) | Same-direction pending request already exists; returns existing `requestId` |
| 201 | (success, created) | New friend request created |
| 400 | `username_required` | Missing/empty/non-string username |
| 400 | `cannot_friend_self` | Looked-up identity matches sender |
| 400 | `invalid_target_domain` | Scheme resolution failed (e.g., non-localhost HTTP target when our scheme is HTTPS) |
| 403 | `peer_rejected` | Remote instance has rejected federation; admin must intervene |
| 403 | `not_authoritative_for_sender` | Caller is a federated (replicated) user; should not have reached here |
| 404 | `user_not_found` | Remote lookup returned 404 (no such user, or tombstoned) |
| 409 | `already_friends` | Friendship row already exists |
| 409 | `peer_pending_approval` | Remote admin needs to approve the peering relationship |
| 409 | `peer_pending_local_admin` | Local instance has `autoAcceptPeering=0` and the user attempted to friend-add a never-peered remote target. The user's own admin must approve before any traffic reaches the wire. Distinct from `peer_pending_approval` (remote admin must approve). See [federation.md → Outbound Peering Gate](federation.md#outbound-peering-gate). |
| 409 | `peer_pending` | Peer handshake in flight |
| 409 | `incoming_request_exists` | Opposite-direction pending request exists; response includes `requestId` for deep-link |
| 429 | `lookup_rate_limited` | Remote `/users/lookup` returned 429; `Retry-After` header forwarded |
| 503 | `peer_unreachable` | Remote instance unreachable (network/timeout/lookup-unreachable) |

## Search (`routes/search.ts`) — auth required
```
GET /channels/:id/search         ?q=&from=&has=&before=&after=&offset=&limit= → { results[], totalCount }  [VIEW_CHANNEL]
GET /channels/:id/messages/around ?messageId=&limit=                           → { messages[] }
GET /dm/:id/search               ?q=&from=&has=&before=&after=&offset=&limit= → { results[], totalCount }
GET /dm/:id/messages/around      ?messageId=&limit=                           → { messages[] }
```
has: `file`|`image`|`link`

## Explore (`routes/explore.ts`) — auth required
```
GET    /spaces/explore                   ?q=&limit=&offset=  → { spaces[], total, totalAll, discoveryEnabled }
POST   /spaces/:id/public-join                               → { space }
POST   /spaces/:id/request-join          { message? }        → { request }
GET    /spaces/:id/join-requests         ?status=            → { requests[] }  [MANAGE_SPACE]
PATCH  /spaces/:id/join-requests/:rid    { action }          → { request }  [MANAGE_SPACE]
GET    /users/@me/join-requests          ?status=            → { requests[] }
```

## Uploads (`routes/files.ts`, `routes/uploads.ts`)

### Tus Upload Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/files/` | JWT | Create resumable upload. Returns `Location` (upload URL) and `Upload-Expires`. |
| HEAD | `/api/files/:uploadId` | JWT (ownership) | Probe `Upload-Offset` for resume. |
| PATCH | `/api/files/:uploadId` | JWT (ownership) | Append bytes at offset. |
| DELETE | `/api/files/:uploadId` | JWT (ownership) | Abort. |

The final PATCH that completes an upload returns the `Attachment` JSON in its response body. See `docs/systems/uploads.md` for the full pipeline (PRE_CREATE / PRE_PATCH / POST_FINISH hooks, storage layout, janitor).

### File Serving
```
GET  /uploads/:filename  (public, supports Range) → file stream
```

## GIF (`routes/gif.ts`) — auth required
```
GET /gif/enabled                         → { enabled }
GET /gif/trending   ?limit=&pos=         → { results[], next }
GET /gif/search     ?q=&limit=&pos=      → { results[], next }
```
Backend: Klipy API (requires `gifApiKey` in instance_settings)

## Voice (`routes/livekit.ts`) — auth required
```
POST /livekit/token  { channelId | dmChannelId } → { token, url }
```
Permissions checked: CONNECT, SPEAK, STREAM (space channels). DM calls: always full grants.

## Instance (`routes/instance.ts`) — public
```
GET /instance/info → { name, version, registrationOpen, federatedRegistrationOpen, instanceId, sourceCodeUrl, commit }
```
`federatedRegistrationOpen` is a UX hint consumed by the Connections add-instance pre-flight (see `client-federation.md`). The 403 from `POST /auth/register` remains the security boundary.

`instanceId` (`InstanceInfoResponse.instanceId`, `string`) is this instance's persistent **epoch** — the incarnation UUID minted once by `ensureDefaults` and stable across restarts (see `database.md → Instance Settings`). It is served here (unauthenticated, credential-free) purely as a **detection** signal: `probePeerReachable` reads it to observe that a peer behind a known origin has been factory-reset (a changed epoch). It is **never** written to a peer's trusted baseline from this channel — only the authenticated `/federation/epoch`, relay envelope, and handshake do that. See `federation.md` "Instance Epoch".

`sourceCodeUrl` (`string`) and `commit` (`string | null`) implement the **AGPL-3.0 § 13 network-use source offer**: every network user (and federated peer) can obtain the Corresponding Source of the exact version this instance is running. `sourceCodeUrl` comes from `config.sourceCodeUrl` (env `BACKSPACE_SOURCE_URL`, default `https://github.com/TheZwiss/backspace`) — operators who modify Backspace MUST set it to their fork's source. `commit` comes from `config.commit` (env `BACKSPACE_COMMIT`, injected at Docker build via `deploy.sh --build-arg`; `null` in local dev). The web client surfaces `sourceCodeUrl`/`version` via the `SourceCodeLink` component on settings sidebars and the pre-auth login/register pages; the desktop app exposes it via the tray + app menus ("Source code (AGPL)") and the native About panel.

## Settings (`routes/settings.ts`)
```
GET   /settings/streaming    (auth)        → { streamingLimits }
PATCH /settings/streaming    (admin)       → { streamingLimits }
GET   /settings/instance     (admin)       → { instanceName, registrationOpen, federatedRegistrationOpen, discoveryEnabled, ... }
PATCH /settings/instance     (admin)       { instanceName?, registrationOpen?, federatedRegistrationOpen?,
                                             discoveryEnabled?, gifApiKey?, maxUploadSizeMb?,
                                             federationRelayEnabled?, federationRelayTtlDays? } → { settings }
```
`registrationOpen` and `federatedRegistrationOpen` are **independent** toggles. PATCH validates `federatedRegistrationOpen` is `boolean` if provided; rejects 400 otherwise. `registrationOpen` is stored as a nullable column (null = fall back to `config.registrationOpen` env default); `federatedRegistrationOpen` is NOT NULL with default 1.

## Admin (`routes/admin.ts`) — admin required
```
GET    /admin/storage/stats                                → StorageStats
GET    /admin/storage/orphans                              → { orphans[] }
POST   /admin/storage/cleanup        { dryRun? }           → CleanupResult
POST   /admin/storage/cleanup-media  { maxAgeDays, dryRun? } → CleanupResult
GET    /admin/users  ?q=&page=&pageSize=&showDeleted=&homeInstance=&role=&joinedAfter=&joinedBefore=&sort= → AdminUserListResponse
GET    /admin/users/instances                              → distinct home instance domains
PATCH  /admin/users/:id/role         { isAdmin }           → AdminUser
POST   /admin/users/:id/reset-password                     → { temporaryPassword }
DELETE /admin/users/:id                                    → { success }
```

## Admin: Invite Management (`routes/invites.ts`) — admin required

All endpoints sit behind `[authenticate, requireAdmin]`. Mutating endpoints wrap their read-modify-write in a SQLite transaction with an in-txn re-fetch + status re-derive; any state mismatch returns 409. Service layer: `packages/server/src/utils/inviteService.ts` (`InviteValidationError` → 400, `InviteNotFoundError` → 404, `InviteStateConflictError` → 409).

```
POST   /admin/invites                       { name, maxUses, expiresAt }              → InviteLinkSummary  (201)
GET    /admin/invites              ?status=active|archived (default: active)          → { invites: InviteLinkSummary[] }
PATCH  /admin/invites/:id                   { name?, maxUses?, expiresAt? }           → InviteLinkSummary
POST   /admin/invites/:id/revoke                                                       → { invite: InviteLinkSummary }
POST   /admin/invites/:id/reinstate         { maxUses?, expiresAt? }                  → { invite: InviteLinkSummary, tokenRotated: boolean }
DELETE /admin/invites/:id                                                              → { success: true }
GET    /admin/invites/:id/redemptions                                                  → { redemptions: InviteRedemption[] }
```

**`POST /admin/invites`** — `name` 1-64 chars trimmed; `maxUses` null (unlimited) or positive integer; `expiresAt` null (never) or epoch ms strictly greater than `Date.now()`. 400 on shape violation.

**`GET /admin/invites?status=`** — `active` returns rows whose derived status is `active`; `archived` returns `expired | exhausted | revoked`. Sort `createdAt DESC`. Joins `users` to surface `createdByUsername` (`'Deleted User'` if creator's `isDeleted = 1`).

**`PATCH /admin/invites/:id`** — partial body. 400 if `maxUses` is a positive integer less than the current `usedCount` (would retroactively exhaust — admin should revoke instead). 409 if the invite is currently `revoked` (status conflict — reinstate first).

**`POST /admin/invites/:id/revoke`** — sets `revokedAt = Date.now()`. 409 if already revoked.

**`POST /admin/invites/:id/reinstate`** — branches on the row's pre-reinstate derived status:
- **Path A — was `revoked`**: rotates the token (`crypto.randomBytes(16).toString('base64url')`), clears `revokedAt`, applies any provided `maxUses`/`expiresAt` overrides. Response includes `tokenRotated: true`. 400 if the resulting row would still derive non-`active` (caller must bump enough).
- **Path B — was `expired` or `exhausted`**: token preserved. Applies overrides. Response `tokenRotated: false`. 400 same rule.
- **Path C — already `active`**: 409 "Invite is already active." Pure no-op rejection.

**`DELETE /admin/invites/:id`** — hard-delete. CASCADE removes all `invite_redemptions` rows for this invite. Allowed in any status. 404 if not found.

**`GET /admin/invites/:id/redemptions`** — sort `redeemedAt DESC`. Each row includes the registration-moment snapshot (`registrantUsername`) plus the live joined state (`currentUsername` / `isDeleted`) so the UI can render `alice (now Deleted User)` for renamed/tombstoned users.

```typescript
type InviteLinkSummary = {
  id: string;
  token: string;
  name: string;
  status: 'active' | 'expired' | 'exhausted' | 'revoked';  // derived
  maxUses: number | null;
  usedCount: number;
  expiresAt: number | null;
  revokedAt: number | null;
  createdBy: string;
  createdByUsername: string | null;  // 'Deleted User' if creator tombstoned
  createdAt: number;
  lastRedeemedAt: number | null;  // epoch ms of most recent redemption; null when usedCount = 0
  url: string;  // server-built `https://<host>/register?invite=<token>` — clients MUST NOT assemble
};

type InviteRedemption = {
  id: string;
  userId: string | null;       // null only on hard-delete (defensive — tombstone keeps row)
  registrantUsername: string;  // snapshot at registration moment
  currentUsername: string | null;
  isDeleted: boolean;
  redeemedAt: number;
};
```

## Federation (`routes/federation.ts`)
```
POST   /federation/peer/initiate   (admin)     { remoteOrigin }                    → { peer, verified } (200) | 409 { code:'PEER_EXISTS_RESET_REQUIRED' }
POST   /federation/peer/accept     (public, IP rate-limited 10/min) { sourceOrigin, challenge, hmacSecret, instanceName?, instanceId?, approvalToken? } → { accepted:true, instanceName, instanceId } (200) | queued (202 + { approvalToken }) | 409 { accepted:false, code:'PEER_EXISTS_RESET_REQUIRED', instanceName, instanceId }
GET    /federation/peers           (admin)                                          → { peers[] } (no secrets; each peer carries needsAttentionReason)
GET    /federation/reset-events     (admin)                                          → FederationResetEventsResponse
DELETE /federation/peers/:id       (admin)                                          → { success } + outbox cleanup
POST   /federation/relay           (HMAC-signed S2S)  FederationRelayRequest (+ sourceInstanceId?) → { accepted[], rejected[] }
POST   /federation/sync            (HMAC-signed S2S)  { sinceTimestamp, limit?, dmChannelId?, federatedId?, contextType? } → { events[], hasMore, checkpoint }
POST   /federation/users/lookup    (HMAC-signed S2S, rate-limited 60/min/peer)  { username }  → { found, user? }
POST   /federation/epoch           (HMAC-signed S2S, HMAC-signed response)  {}  → { instanceId }
```

**`POST /api/federation/peer/accept`** — public, IP-rate-limited. Optional `approvalToken` (64-hex) on the request body proves mutual admin approval; required to promote an `awaiting_approval` row to `active` when the receiver has `autoAcceptPeering=0`. The receiver returns it in the 202 body when queueing the request for admin review (`{ queued: true, message, approvalToken }`); the initiator stores it and the receiver's `/approve` later forwards it back. See `federation.md` §1 "Approval Token Verification" for the full lifecycle and threat model.

**Handshake epoch exchange.** The handshake carries the **instance epoch** bidirectionally, mirroring `instanceName`: the request body's `instanceId` is the initiator's epoch (written to `federation_peers.peer_instance_id` on every authenticated activation path), and the 200 response body's `instanceId` is the responder's epoch. Older peers omit the field; the column stays `null` until the epoch-refresh/relay backstop fills it. Both are authenticated baselines — never overwritten by the unauthenticated `/instance/info` probe. **`FederationRelayRequest.sourceInstanceId`** stamps the sender's current epoch on every relay; because the whole body is HMAC-verified, a valid relay authentically carries the sender's incarnation id and populates `peer_instance_id` when null (fast-path baseline). See `federation.md` "Instance Epoch".

**Trust re-establishment (verify-before-activate).** `/peer/initiate` no longer treats any `response.ok` as success. On remote 200 it performs a signed `fetchPeerEpoch` (`POST /federation/epoch`) round-trip to PROVE the responder adopted the negotiated secret, then either activates (`200 { peer, verified: true }`, storing the cryptographically-verified epoch as `peer_instance_id`) or parks the peer in `needs_attention`/`repeer_incomplete` (`200 { peer, verified: false }`). On remote `409 PEER_EXISTS_RESET_REQUIRED` it deletes its pending row and returns `409 { code: 'PEER_EXISTS_RESET_REQUIRED' }`. `/peer/accept` returns that same `409 { accepted: false, code: 'PEER_EXISTS_RESET_REQUIRED', instanceName, instanceId }` for an existing `active`/`needs_attention` row (honest refusal — anti-hijack guard unchanged, never adopts the caller's secret) instead of the old false `200 { accepted: true }`. The handshake `sourceOrigin` is `getOurOrigin()` (honors `PUBLIC_ORIGIN`), so it matches the `X-Federation-Origin` used for all S2S auth. See `federation.md` "Trust re-establishment contract".

**`GET /api/federation/reset-events`** — admin-only, read-only. Backs the "Reset cleanup" admin surface (instance-epoch self-healing §6.4). Returns the durable `federation_reset_events` journal, each row augmented with the origin's current orphaned real accounts (`federationHomeOrphaned = 1`) for disposition:

```typescript
type FederationOrphanedAccount = {
  id: string;
  username: string;            // '!orphaned:{uid}@domain' for freed handles; real for space owners
  displayName: string | null;
  avatarColor: string | null;
  ownedSpaces: { id: string; name: string }[];
  spaceMemberCount: number;    // # spaces the account is a member of
  messageCount: number;        // # space messages authored
};
type FederationResetEvent = {
  origin: string; deadEpoch: string; newEpoch: string | null;
  detectedAt: number; resolvedAt: number | null;
  stubCount: number; orphanedAccountCount: number;
  orphanedAccounts: FederationOrphanedAccount[];
};
type FederationResetEventsResponse = { events: FederationResetEvent[] };
```

Disposition actions reuse existing endpoints (no new mutating routes): one-click Re-peer = `POST /peers/:id/reset` → `POST /peer/initiate`; full-purge Remove = `DELETE /api/admin/users/:id` (owns-spaces → transfer first). **`needsAttentionReason`** (`'auth_failures' | 'peer_reset_detected' | 'repeer_incomplete' | null`) is now included on each `GET /federation/peers` peer object so the client can raise the persistent Reset-cleanup banner only for reset-detected peers and surface an "incomplete Re-peer" warning for `repeer_incomplete`. See `federation.md` "Instance Epoch" and `client-federation.md` §8.

**`POST /api/federation/users/lookup`** — HMAC-authenticated S2S endpoint. Resolves a username on this instance to its canonical `(homeUserId, profile snapshot)`. Used by the cross-instance friend-add flow on the sender's home server before queuing a `friend_request_create` event. Responds to native, non-deleted users only; ignores `discoverable`. Returns `{ found: false, code: 'user_not_found' }` for stubs, tombstoned users, or unknown handles. See `federation.md` §1 "S2S User Lookup" for the full contract.

**`POST /api/federation/epoch`** — HMAC-authenticated S2S endpoint returning this instance's persistent epoch (`{ instanceId }`). The **request** is HMAC-signed (only a peer holding the shared secret may call it; unknown/revoked peers → 403, bad signature → 401, missing headers → 400) **and the response body is HMAC-signed** with the same secret (`X-Federation-Signature/Timestamp/Nonce` response headers), so the caller can verify the epoch before writing it as the peer's trusted baseline (`federation_peers.peer_instance_id`). The value is already public via `/instance/info`; signing is for baseline-integrity, not confidentiality. Caller: `fetchPeerEpoch(peer)` (`utils/federationEpoch.ts`), which fails safe — 404 (not-yet-upgraded peer), bad/absent response signature, or network/timeout all return `null` (retry next tick). Populates the epoch baseline deterministically via the bounded periodic epoch-refresh. See `federation.md` "Instance Epoch" §3.2.

### Federation Peering Approval Queue

Inbound + outbound peering approval queue (`autoAcceptPeering=0`). See [federation.md → Peer Approval Queue](federation.md#peer-approval-queue) and [federation.md → Outbound Peering Gate](federation.md#outbound-peering-gate).

```
GET  /federation/approval-requests              (admin)            → { requests: ApprovalRequestSummary[] }
POST /federation/approval-requests/:id/approve  (admin)            → { success, peerStatus?, peer? }
POST /federation/approval-requests/:id/deny     (admin)            → { success }
```

**`ApprovalRequestSummary` shape:**

```typescript
type ApprovalRequestSummary = {
  id: string;
  direction: 'inbound' | 'outbound';
  origin: string;
  instanceName: string | null;
  requestedAt: number;
  expiresAt: number;
  // Outbound rows ONLY — inbound rows OMIT this field entirely (it is absent, not null and not []).
  subscribers?: ApprovalRequestSubscriberSummary[];
};

type ApprovalRequestSubscriberSummary = {
  id: string;
  userId: string;
  username: string;
  triggerReason: 'friend_add' | 'space_join' | 'direct_message';
  triggerTarget: string;
  createdAt: number;
};
```

**`POST /approval-requests/:id/approve`** — direction-branched.
- **Inbound** — existing behavior preserved verbatim (creates / upserts a local `federation_peers` row with status `pending`, sends `/peer/accept` to origin forwarding the stored `approvalToken`, deletes the queue row regardless of whether the result is `active` (200) or `awaiting_approval` (202)).
- **Outbound** — generates a fresh HMAC, sends `/peer/accept` to the origin (no token; we are the initiator).
  - On 200 → peer becomes `active`. `onPeerActivated` runs: fans out `kind='approved'` notifications to subscribers and cascade-deletes the queue row. The handler does NOT duplicate this cleanup.
  - On 202 → peer transitions to `awaiting_approval`, captures the returned `approvalToken`, and the queue row + subscribers are LEFT INTACT for the eventual remote-admin approval. `onPeerActivated` is NOT called yet.
  - On 4xx/5xx/network → the peer row is cleaned up; the queue row is LEFT INTACT so the admin can retry. Response status mirrors the wire failure (`502`/`503`/`504`).
- **Response body:** `{ success, peerStatus?: 'active' | 'awaiting_approval', peer? }` for outbound; `{ success }` for inbound.

**`POST /approval-requests/:id/deny`** — direction-branched.
- **Inbound** — existing behavior preserved (sends signed `/peer/denied` to origin, upserts a local `rejected` `federation_peers` row, deletes the queue row).
- **Outbound** — fans out `kind='denied'` notifications to all `peer_approval_subscribers` of the queue row, then cascade-deletes the parent (no remote network call). Broadcasts `federation_peers_changed` to admins so the queue UI refreshes.

### Federation Peering Subscriptions (user-facing)

```
GET    /federation/peering-subscriptions     (auth)   → { subscriptions: PeeringSubscriptionSummary[] }
DELETE /federation/peering-subscriptions/:id (auth)   → { success }
```

User-facing surface for the rows in `peer_approval_subscribers` belonging to the calling user. GET joins the parent `peer_approval_requests` row to include peer origin/instance metadata.

```typescript
type PeeringSubscriptionSummary = {
  id: string;
  requestId: string;
  peerOrigin: string;
  peerInstanceName: string | null;
  triggerReason: 'friend_add' | 'space_join' | 'direct_message';
  triggerTarget: string;
  createdAt: number;
};
```

**`DELETE /peering-subscriptions/:id`:**
- 404 if the subscriber row doesn't exist.
- 403 if the row belongs to a different user.
- On success: deletes the subscriber row; if it was the last subscriber for the parent, cascade-deletes the parent (admin's queue row disappears too). No `peer_approval_notifications` row is created (the user took the action; they know).
- Broadcasts `peering_subscription_changed` to the calling user (multi-tab refresh) and `federation_peers_changed` to admins if the parent was deleted.

### Federation Peering Notifications (user-facing)

```
GET  /federation/peering-notifications        (auth)  ?unread=1?  → { notifications: PeeringNotificationSummary[] }
POST /federation/peering-notifications/:id/read   (auth)         → { success }
POST /federation/peering-notifications/read-all   (auth)         → { success, count }
```

User-facing terminal-state notifications for peering events. GET orders DESC by `createdAt`; `?unread=1` filters to `readAt IS NULL`.

```typescript
type PeeringNotificationSummary = {
  id: string;
  kind: 'approved' | 'denied' | 'expired';
  peerOrigin: string;
  triggerReason: 'friend_add' | 'space_join' | 'direct_message';
  triggerTarget: string;
  createdAt: number;
  readAt: number | null;
};
```

**`POST /:id/read`** — sets `readAt = Date.now()` for the calling user's notification (404 / 403 on miss / mismatch).
**`POST /read-all`** — marks all of the calling user's unread notifications as read; returns `{ success, count }` where `count` is the number of rows updated.

## Utilities (`routes/utils.ts`) — auth required
```
GET /utils/metadata  ?url= → { title?, description?, image?, siteName? }
GET /health          (public) → { status: 'ok', timestamp }
```
