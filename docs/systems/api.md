# REST API Reference

Base: `/api`. Auth via `Authorization: Bearer <jwt>`. All responses JSON.
Source files: `packages/server/src/routes/*.ts`

---

## Auth (`routes/auth.ts`) — public, rate-limited
```
POST /auth/register         { username, password, displayName?, avatarColor?, homeInstance?, homeUserId? } → { token, user }
GET  /auth/check-username    ?username= → { available, reason? }
POST /auth/login             { username, password } → { token, user }
```

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
DELETE /dm/:id                                                      → { success } (soft-close)
POST   /dm/:id/members         { userIds[] }                        → { dmChannel } [owner, max 10]
DELETE /dm/:id/members                                              → { success } (leave)
GET    /dm/:id/messages        ?before=&limit=50                    → { messages[] }
POST   /dm/:id/messages        { content, attachments?, replyToId? } → { message }
PATCH  /dm/messages/:id        { content }                          → { message } [author]
DELETE /dm/messages/:id                                             → { success } [author]
```

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

## Uploads (`routes/uploads.ts`)
```
POST /uploads     (auth, multipart, rate-limited) → { attachment }
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
GET /instance/info → { name, version, registrationOpen }
```

## Settings (`routes/settings.ts`)
```
GET   /settings/streaming    (auth)        → { streamingLimits }
PATCH /settings/streaming    (admin)       → { streamingLimits }
GET   /settings/instance     (admin)       → { instanceName, registrationOpen, discoveryEnabled, ... }
PATCH /settings/instance     (admin)       { instanceName?, registrationOpen?, discoveryEnabled?,
                                             gifApiKey?, maxUploadSizeMb?, federationRelayEnabled?,
                                             federationRelayTtlDays? } → { settings }
```

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

## Federation (`routes/federation.ts`)
```
POST   /federation/peer/initiate   (admin)     { remoteOrigin }                    → peer created
POST   /federation/peer/accept     (public, IP rate-limited 10/min) { sourceOrigin, challenge, hmacSecret, instanceName?, approvalToken? } → accepted (200) | queued (202 + { approvalToken })
GET    /federation/peers           (admin)                                          → { peers[] } (no secrets)
DELETE /federation/peers/:id       (admin)                                          → { success } + outbox cleanup
POST   /federation/relay           (HMAC-signed S2S)  FederationRelayRequest        → { accepted[], rejected[] }
POST   /federation/sync            (HMAC-signed S2S)  { sinceTimestamp, limit?, dmChannelId?, federatedId?, contextType? } → { events[], hasMore, checkpoint }
POST   /federation/users/lookup    (HMAC-signed S2S, rate-limited 60/min/peer)  { username }  → { found, user? }
```

**`POST /api/federation/peer/accept`** — public, IP-rate-limited. Optional `approvalToken` (64-hex) on the request body proves mutual admin approval; required to promote an `awaiting_approval` row to `active` when the receiver has `autoAcceptPeering=0`. The receiver returns it in the 202 body when queueing the request for admin review (`{ queued: true, message, approvalToken }`); the initiator stores it and the receiver's `/approve` later forwards it back. See `federation.md` §1 "Approval Token Verification" for the full lifecycle and threat model.

**`POST /api/federation/users/lookup`** — HMAC-authenticated S2S endpoint. Resolves a username on this instance to its canonical `(homeUserId, profile snapshot)`. Used by the cross-instance friend-add flow on the sender's home server before queuing a `friend_request_create` event. Responds to native, non-deleted users only; ignores `discoverable`. Returns `{ found: false, code: 'user_not_found' }` for stubs, tombstoned users, or unknown handles. See `federation.md` §1 "S2S User Lookup" for the full contract.

## Utilities (`routes/utils.ts`) — auth required
```
GET /utils/metadata  ?url= → { title?, description?, image?, siteName? }
GET /health          (public) → { status: 'ok', timestamp }
```
