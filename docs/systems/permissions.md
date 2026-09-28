# Permission System

Source files:
- `packages/shared/src/permissions.ts` — Bit definitions, constants
- `packages/server/src/utils/permissions.ts` — Server-side resolution
- `packages/web/src/utils/permissions.ts` — Client-side helpers

Storage: Bigint decimal strings in SQLite TEXT columns (bigint not JSON-safe).

---

## Permission Bits

| Bit | Name | Description |
|-----|------|-------------|
| 0 | ADMINISTRATOR | Full access, bypasses all checks |
| 1 | VIEW_CHANNEL | See channel, read messages |
| 2 | MANAGE_CHANNELS | Create/edit/delete channels + categories |
| 3 | MANAGE_ROLES | Create/edit/delete roles, assign roles |
| 4 | MANAGE_SPACE | Edit space settings, manage join requests |
| 5 | CREATE_INVITE | Generate invite codes |
| 6 | KICK_MEMBERS | Remove members |
| 7 | BAN_MEMBERS | Ban members |
| 10 | SEND_MESSAGES | Post in text channels |
| 11 | MANAGE_MESSAGES | Delete others' messages |
| 12 | ATTACH_FILES | Upload files |
| 13 | READ_MESSAGE_HISTORY | View message history |
| 14 | ADD_REACTIONS | Add emoji reactions |
| 20 | CONNECT | Join voice channels |
| 21 | SPEAK | Transmit audio |
| 22 | MUTE_MEMBERS | Space-mute others |
| 23 | DEAFEN_MEMBERS | Space-deafen others |
| 24 | MOVE_MEMBERS | Move between voice channels |
| 25 | STREAM | Screen share |
| 26 | DISCONNECT_MEMBERS | Disconnect from voice |

**Default @everyone:** VIEW_CHANNEL, SEND_MESSAGES, CREATE_INVITE, CONNECT, SPEAK, ATTACH_FILES, READ_MESSAGE_HISTORY, ADD_REACTIONS, STREAM

---

## Resolution Algorithm

`computePermissions(userId, spaceId, channelId?)` → bigint

### Step 1: Owner/Admin Check
- Space owner OR instance admin (`isAdmin === 1`) → return ALL_PERMISSIONS

### Step 1b: Membership Gate
- If the user is **not** a member of the space (`getMember` returns nothing) → return `0n`
- A non-member has no permissions in a space they have not joined. Without this,
  the @everyone role in Step 2 would leak default member rights (VIEW_CHANNEL,
  READ_MESSAGE_HISTORY, CREATE_INVITE, …) to any authenticated non-member —
  allowing them to read channels and mint invite codes for spaces they never
  joined. Owner and instance admin are already resolved in Step 1, so they are
  unaffected.

### Step 2: Compute Base (space-level)
- Start with @everyone role permissions (role where `id === spaceId`)
- OR together all permissions from user's assigned roles
- If ADMINISTRATOR bit set → return ALL_PERMISSIONS

### Step 3: Apply Overrides (if channelId provided)

Three tiers, each applied category-first then channel-second:

**Tier 1 — @everyone override** (targetType='role', targetId=spaceId):
```
if categoryOverride: base = (base & ~deny) | allow
if channelOverride:  base = (base & ~deny) | allow
```

**Tier 2 — Role overrides** (combined across all assigned roles):
```
catAllow = 0, catDeny = 0
for each role: catAllow |= roleOverride.allow; catDeny |= roleOverride.deny
base = (base & ~catDeny) | catAllow

chanAllow = 0, chanDeny = 0
for each role: chanAllow |= roleOverride.allow; chanDeny |= roleOverride.deny
base = (base & ~chanDeny) | chanAllow
```

**Tier 3 — Member override** (targetType='member', targetId=userId):
```
if categoryOverride: base = (base & ~deny) | allow
if channelOverride:  base = (base & ~deny) | allow
```

**Key rule:** Channel bits always win — applied after category, overwriting conflicting bits. Deny applied first (clears bits), then allow (sets bits).

---

## Role hierarchy

A role's `position` ranks it: higher is more senior. `@everyone` (id = space
id) is always 0; every other role has its own position from 1 up, so no two
roles tie. A member's **rank** is the highest position among their roles, 0
with none.

Moderating another member needs a strictly higher rank than theirs:

| Rule | Where |
|---|---|
| Nobody acts on the space owner | kick, ban, role changes, voice moderation |
| The owner and instance admins (`isAdmin`) are exempt | everything below |
| Actor's rank > target's rank | kick (`DELETE /members/:uid`, not leaving), ban, `PATCH /members/:uid`, `POST`/`DELETE /members/:uid/roles`, WS `voice_space_mute`, `voice_space_deafen`, `voice_move`, `voice_disconnect` |
| Role position < actor's rank | assigning or removing that role (each role a `PATCH /members/:uid` adds or removes), editing or deleting it, moving it or moving another role to that position, creating a role (new roles start at 1) |

`ADMINISTRATOR` does not exempt: a role with it still sits at its position.
Acting on oneself is not moderation (leaving, moving oneself between
channels). Unban has no target rank and needs only `BAN_MEMBERS`.

A refusal is `403` with `ErrorCode` `role_hierarchy`; the WebSocket handlers
send `{ type: 'error', code: 'role_hierarchy' }`.

The rule is `canActOnMember` / `canManageRoleAt` / `topRolePosition` in
`packages/shared/src/permissions.ts`, used by both sides. The server reads the
facts in `utils/roleHierarchy.ts` (`getHierarchyStanding`); ids are ids on the
space's own instance, so a moderator whose home is another instance is ranked
as their local replicated user there. The client reads them in
`web/src/utils/roleHierarchy.ts` from the loaded member list, finding the
viewer through `getMyUserIdForOrigin` of the space's origin. When the space is
not the loaded one or a member row is missing, the client leaves the control
offered and the server decides. The same holds when the space's roles do not
have distinct positions from 1 up (`spaceRanksRoles`, the `canReorderRoles`
test): that is an instance from before the hierarchy, which keeps every role
at 0 and enforces no ranks, so every surface behaves there as it did before.

**Positions.** `db/rolePositions.ts` keeps them distinct.
`normalizeRolePositions` orders a space's roles by position descending, then
`created_at`, then rowid, and writes n..1 (and 0 for @everyone). It runs on
every boot (`normalizeAllRolePositions`, a no-op once applied), after a role is
created (inserted at 0, so it lands at 1 and the others move up) and after a
role is deleted. `PATCH /roles/:rid { position }` moves the role to that
position and renumbers the rest (`moveRoleToPosition`). Databases from before
this rule had every role at 0; the boot pass turns the order the role list
already showed (oldest role first) into positions.

**Setting the order.** The role list in Space Settings > Roles
(`spaceSettingsPanels/RoleOrderList.tsx`) shows the roles in rank order, most
senior first, @everyone last, and says that a role ranks above the ones below
it. The order is the hierarchy, so this list is where the owner sets it:
- Desktop: each role the viewer may move has a drag handle. The handle is a
  focusable button, and the up and down arrow keys move the role one place.
  Up and down buttons appear on hover or focus, so a move never needs a drag.
- Phone (the same panel in the fullscreen settings modal): the up and down
  buttons are always shown at 40 px, and there is no handle.
- A role at or above the viewer's top role shows a lock instead of controls.
  The owner and instance admins move any role; @everyone never moves.

The move rule is `canMoveRole` in `web/src/utils/roleOrder.ts`: the role and
the position it moves to must both pass `canManageRoleAt`, the check the
server makes on `PATCH /roles/:rid { position }`. A move sends the position
the role in the target slot holds. It shows at once (`moveRoleInRankOrder`
renumbers n..1 as `moveRoleToPosition` does), goes to the space's own
instance through `getApiForOrigin(space._instanceOrigin)`, and is put back
if refused, with the server's reason (`describeError`) right under the role
that moved back, scrolled into view. The viewer is ranked
by their id on the space's instance (`myStandingIn`). The server pushes every
member a ready payload after the move. Their client reloads the open space
(`loadSpaceDetail`), so other open role lists show the new order. When the
roles do not have distinct positions from 1 up (`canReorderRoles`), the list
offers no controls. That is an instance from before the hierarchy, which
stores every role at 0 and would apply a position as given.

Covered by `routes/roleHierarchy.test.ts`, `ws/voiceModerationHierarchy.test.ts`,
`voiceMenuItems.test.ts`, `spaceSettingsPanels/roleHierarchyGating.test.tsx`,
`utils/roleOrder.test.ts` and `spaceSettingsPanels/RolesPanel.reorder.test.tsx`.

---

## Helper Functions

| Function | Purpose |
|----------|---------|
| `hasPermissionBit(perms, bit)` | Check if bit is set; true if ADMINISTRATOR |
| `permissionsToString(perms)` | Bigint → decimal string for JSON |
| `stringToPermissions(str)` | Decimal string → bigint (supports legacy JSON array format) |
| `computePermissions(userId, spaceId, channelId?)` | Full resolution algorithm |
| `hasPermission(userId, spaceId, permission, channelId?)` | Boolean wrapper |
| `getMember/isMember/isSpaceOwner` | Membership checks |
| `isDmMember/isBanned` | DM/ban checks |
| `getChannelSpaceId(channelId)` | Resolve channel's space |
| `isReplyTargetInChannel(channelId, replyToId)` | Create-time reply-target check (`routes/messages.ts`) |
| `fetchReplyToMessages(channelId, rows)` | Channel-scoped reply hydration (`routes/messages.ts`) |

---

## Client gating

The client hides or disables a control when the user lacks the permission for
it. It must read that permission at the **same scope the server route checks**,
or the two disagree: a channel override that grants a bit leaves the control
hidden although the server would allow the action, and one that denies it shows
a control that fails with `missing_permission`.

The rule follows from the `hasPermission` call in the route:

| Server check | Client reads |
|---|---|
| `hasPermission(userId, spaceId, bit, channelId)` | `channelPermissions.get(channelId)` (the channel's `myPermissions`, overrides applied) |
| `hasPermission(userId, spaceId, bit)` | `spacePermissions.get(spaceId)` |

The scope belongs to the action, not the bit. `MANAGE_CHANNELS` is space-wide
for creating a channel, reordering the layout and managing categories, and
channel-scoped for editing or deleting one channel. The current split:

| Scope | Actions |
|---|---|
| Channel | view, send, attach, react, read history, manage messages; connect, speak, stream; edit or delete the channel (`MANAGE_CHANNELS`); mute, deafen, move, disconnect a voice user (checked on the channel the target is in) |
| Space | create a channel; reorder channels and categories; create, rename or delete a category; read or write any channel or category override (`MANAGE_ROLES`); invites, kick, ban, space settings |

Member and role actions also follow the role hierarchy (above). The client
hides kick and ban for members ranked at or above the viewer, greys out roles
at or above the viewer's own in the member role editor, shows such a role
read-only in the role editor, locks such roles in the role list's reorder
controls, and leaves the voice moderation menu and voice drag-to-move off for
those members.

A control that needs two permissions at different scopes checks each at its own.
Channel settings is the example: the delete button reads the channel's
`MANAGE_CHANNELS`, and the privacy row, which reads and writes the @everyone
override, is shown only with space-wide `MANAGE_ROLES`.

Covered by `ChannelSettingsModal.test.tsx` and `voiceMenuItems.test.ts`, which
grant a bit only through the channel map and deny it only there, and assert the
control follows the channel.

---

## Broadcast audience

Space membership and channel access are not the same thing, so the two
`ConnectionManager` fan-out helpers are not interchangeable:

| Helper | Recipients | Carries |
|--------|-----------|---------|
| `sendToSpace(spaceId, event)` | every member of the space | space-level facts: `space_updated`, `member_joined`, `member_left`, `category_created` / `category_updated` / `category_deleted`, voice presence |
| `sendToChannel(spaceId, channelId, event)` | members whose `computePermissions` grants `VIEW_CHANNEL` on that channel | anything scoped to one channel: `message_created`, `message_updated`, `message_deleted`, `typing`, `reaction_added`, `reaction_removed`, `embeds_resolved` |

Anything naming a channel or carrying its content goes through `sendToChannel`.
A message edit ships the full `MessageWithUser` (content, author, attachments), a
delete names the channel it happened in, and both must land only where the
original `message_created` did. REST and WebSocket are two entry points to the
same event, so they use the same helper: `PATCH /api/messages/:id` and
`DELETE /api/messages/:id` mirror the `message_edit` and `message_delete`
WebSocket handlers.

The choice does not go the other way. A space-level event pushed through
`sendToChannel` would be withheld from members who lack `VIEW_CHANNEL` on
whichever channel was named, so member lists and the category tree would drift
out of sync for exactly those members. Space furniture stays on `sendToSpace`.

Covered by `packages/server/src/routes/messages.broadcastAudience.test.ts`,
which drives the real `ConnectionManager` and asserts both directions: a member
denied `VIEW_CHANNEL` receives neither event, while readers of the channel and
the space-wide `category_created` are unaffected.

---

## Reply-target confinement

A message's `replyToId` must name a message in the **same channel**. Both create
paths enforce it (`POST /api/channels/:id/messages` and the WebSocket
`message_create` handler) via `isReplyTargetInChannel`, answering
`400 Invalid reply target` / a WS `error` event without inserting anything. Every
channel read path hydrates `replyTo` through `fetchReplyToMessages(channelId, rows)`,
which scopes the lookup to the channel being read, so a `replyToId` pointing
elsewhere hydrates as `replyTo: null` even for rows written before the
create-time check existed.

Same-channel is the rule rather than "the requester may read the target's
channel", and the permission model above is the reason:

- A hydrated message is fanned out by `connectionManager.sendToChannel` to an
  audience whose members hold different permissions, so at hydration time there
  is no single reader to resolve against.
- Checking the **author's** permissions at create time would not bound who reads
  the result. An author who may read a restricted channel could otherwise embed
  one of its messages as a reply preview inside a channel with a wider audience,
  and later override changes would not retract it.

Confining the target to the message's own channel needs no second permission
computation: the reply preview inherits exactly the `VIEW_CHANNEL` +
`READ_MESSAGE_HISTORY` gate that already guards the message carrying it.

The DM side has the same rule with its own pair of helpers
(`isDmReplyTargetInChannel` / `fetchDmReplyToMessages` in `routes/dm.ts`), where
membership is binary so the two candidate predicates coincide.

Covered by `packages/server/src/routes/messages.replyAuthorization.test.ts` and
`packages/server/src/routes/dm.replyAuthorization.test.ts`.
