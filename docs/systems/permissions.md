# Permission System

Source files:
- `packages/shared/src/permissions.ts` — Bit definitions, constants
- `packages/server/src/utils/permissions.ts` — Server-side resolution
- `packages/web/src/utils/permissions.ts` — Client-side helpers

Storage: Bigint decimal strings in SQLite TEXT columns (bigint not JSON-safe).
See "Stored form" for the exact form.

## Stored form

A permissions value (`roles.permissions`, override `allow` and `deny`) is a
canonical non-negative decimal string: `permissionsToString` of the bits, no
sign, no leading zeros, no spaces, no hex. It is also the only wire form a
write accepts: `parsePermissionString` in `packages/shared/src/permissions.ts`
takes a string matching `^(0|[1-9][0-9]*)$` and nothing else, and the role
routes (`POST`/`PATCH /spaces/:id/roles`, refusal `400 permissions_invalid`)
and the override routes (`PUT /channels/:id/overrides`,
`PUT /categories/:id/overrides`, refusal `400 override_bits_invalid`) parse
through it. An override write that leaves out `allow` or `deny` sets no bits
there. Every released client sends exactly these strings.

Before this rule the override routes stored whatever `BigInt()` accepted, and
older role routes the request's string as given, so an old database can hold
`"0x10"`, `" 8"`, `"-1"`, a legacy JSON name list or NULL. A boot pass,
`normalizeStoredPermissions` (`server/src/db/permissionStrings.ts`), rewrites
each to `canonicalPermissionString`: the value as `stringToPermissions` reads
it, so every check gives the same answer; a negative value, which reads as
every bit, becomes the defined bits (`& ALL_PERMISSIONS`). Before its first
rewrite the database is snapshotted (deployment.md, "Pre-migration
snapshot"). A value
`stringToPermissions` cannot read in full (text that is neither an integer
nor a JSON list of permission names, or a list naming something that is not
a permission) is logged as it is replaced, with its table, row key, column
and old text, so it can be put back by hand. It logs how many values it
rewrote and is a no-op once applied, so each such value is logged once.


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
| Role position < actor's rank | assigning or removing that role (each role a `PATCH /members/:uid` adds or removes), editing or deleting it, moving it or moving another role to that position, creating a role (new roles start at 1), writing or deleting a channel or category override on that role (`PUT`/`DELETE /channels/:id/overrides`, `/categories/:id/overrides`; @everyone is position 0) |
| Actor's rank > target's rank | writing or deleting a channel or category override on another member (an override on oneself is not moderation) |

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
- Desktop: the row of each role the viewer may move is what a drag picks up
  (grab it anywhere: the name, the colour dot, the handle). The handle is a
  focusable button, and the up and down arrow keys move the role one place.
  Up and down buttons appear on hover or focus, so a move never needs a drag.
  Drag, keys and buttons all go through the same move. Chrome starts no drag
  of an ancestor from inside a button, so the row's name button and handle
  are draggable themselves and their dragstart reaches the row.
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
by their id on the space's instance (`myStandingIn`). The server tells every
member with `space_access_changed` after the move (websocket.md), and their
client refreshes the space quietly, so other open role lists show the new
order. When the
roles do not have distinct positions from 1 up (`canReorderRoles`), the list
offers no controls. That is an instance from before the hierarchy, which
stores every role at 0 and would apply a position as given.

Covered by `routes/roleHierarchy.test.ts`, `routes/heldPermissions.test.ts`,
`utils/roleRules.test.ts` (the shared rules), `ws/voiceModerationHierarchy.test.ts`,
`voiceMenuItems.test.ts`, `spaceSettingsPanels/roleHierarchyGating.test.tsx`,
`ui/PermissionsEditor.hierarchy.test.tsx`, `utils/roleOrder.test.ts`,
`spaceSettingsPanels/RolesPanel.reorder.test.tsx` (drag included),
`routes/permissionBits.validation.test.ts`, `db/permissionStrings.test.ts`,
`modals/entityPrivacy.test.tsx`, `utils/overrideBits.test.ts`,
`utils/memberGroups.test.ts` and `hooks/useWebSocket.spaceAccess.test.ts`.

## Held-bits rule

The hierarchy decides which roles and members a `MANAGE_ROLES` holder may
touch. The held-bits rule decides which permission bits they may switch
there: only bits they hold in the space themselves. "Held" is the actor's
space-level `computePermissions`; the owner, instance admins and
`ADMINISTRATOR` holders hold every bit. A channel override that grants the
actor a bit does not count.

| Route | Rule | Refusal (`403`) |
|---|---|---|
| `POST /spaces/:id/roles` | every bit in `permissions` must be held; without `permissions` the new role gets `DEFAULT_EVERYONE_PERMISSIONS` limited to the held bits | `cannot_grant_unowned_permissions` |
| `PATCH /spaces/:id/roles/:rid { permissions }` | compared with the stored value: an unheld bit may not be switched on or off; unheld bits already on the role stay while the actor edits the rest | on: `cannot_grant_unowned_permissions`, off: `cannot_change_unowned_permissions` |
| `DELETE /spaces/:id/roles/:rid` | deleting switches every bit of the role off for everyone who holds it, members ranked above the actor included, so each must be held | `cannot_change_unowned_permissions` |
| `PATCH /spaces/:id/members/:uid`, `POST /spaces/:id/members/:uid/roles` | giving a member a role gives them its bits, so every bit of each role the request adds must be held; a role the member already has may stay | `cannot_grant_unowned_permissions` |
| `PUT /channels/:id/overrides`, `PUT /categories/:id/overrides` | compared with the stored override: a newly allowed or newly denied unheld bit is refused, and so is clearing one from allow or deny; unheld bits already set stay while the actor edits the rest | allow: `cannot_grant_unowned_permissions`, deny: `cannot_deny_unowned_permissions`, clear: `cannot_change_unowned_permissions` |
| `DELETE /channels/:id/overrides/...`, `DELETE /categories/:id/overrides/...` | a delete clears every bit the override sets, so each must be held | `cannot_change_unowned_permissions` |

The hierarchy check runs first, so a role at or above the actor's top role
answers `role_hierarchy`. Taking a role away from a member
(`PATCH /members/:uid`, `DELETE /members/:uid/roles/:rid`) is governed by the
hierarchy alone: the member ranks below the actor, and taking their role only
lowers what that one member can do. Deleting the role is different, because
it also changes members ranked above the actor who hold it. A bit no `PermissionBits` entry defines counts as
unheld for everyone but a holder of every permission, so a stray bit in an old
row never blocks the owner.

Why a delete is refused: `DELETE` is the same change as a `PUT` with no bits.
If it were allowed, deleting and re-creating an override would clear any
unheld bit the `PUT` rule protects. The cost is that a moderator cannot remove
an override the owner set with a bit the moderator lacks; the owner, an
instance admin or an `ADMINISTRATOR` holder can.

The rule is `roleBitsChangeRefusal` / `overrideChangeRefusal` in
`packages/shared/src/permissions.ts`, used by the routes and by the client.
The client reads "held" from `spacePermissions` (the `myPermissions` the
space's own instance computed for the viewer's id there) through
`useViewerHeldPermissions` in `web/src/utils/roleHierarchy.ts`. When that is
not loaded, nothing is locked and the server decides.

### What changes for an existing space

**Owners need to check one thing after the update.** Open Space Settings >
Roles in each space and check the order. The first boot ranks the roles in
the order they were created, oldest highest, not by importance. A role
created after a moderator role now ranks below it, so holders of that
moderator role can kick, ban and voice-moderate its members (non-owner
`ADMINISTRATOR` holders included), take the role from them and move it.
Drag the roles, or use the up and down buttons, until the most senior role is
at the top.

When an instance updates to this version:

1. **Roles are renumbered once, at the first boot.** Before, every role sat at
   position 0. The boot pass gives @everyone 0 and the other roles n..1 in the
   order the role list showed them, oldest role highest. The owner can change
   the order in Space Settings > Roles. Where a member's top role decides
   something (the member list group and the name colour), a member with
   several roles may now be shown under a different one. The owner's name
   takes the colour of their top role when they have one, rose otherwise
   (`memberNameColor` in `web/src/utils/memberGroups.ts`).
2. **Moderation needs a higher rank.** Kick, ban, space mute, space deafen,
   move and disconnect are refused against a member whose top role is at or
   above the actor's, including a member with the same top role. Members with
   no role can still be targeted by anyone with a role. A member whose
   moderation permission comes only from @everyone (no role) can no longer
   use it on anyone.
3. **Managing roles needs a higher rank.** A `MANAGE_ROLES` holder can no
   longer assign or remove roles at or above their own top role, change the
   roles of a member at or above them, edit, delete or move roles at or above
   their own top role, or create a role when their top role is the lowest one
   (position 1) or they have none. Editing @everyone needs a role. The same
   rank applies to channel and category overrides: an override on a role at
   or above their own, or on a member ranked at or above them, can no longer
   be written or deleted, and an override on @everyone (which includes the
   Private switch) needs a role.
4. **`ADMINISTRATOR` does not exempt from the hierarchy.** A non-owner
   `ADMINISTRATOR` holder is ranked by their roles like anyone else, and a
   moderator ranked above an `ADMINISTRATOR` role can act on it and its
   members. `ADMINISTRATOR` holders still hold every bit for the held-bits
   rule.
5. **Only held bits can be switched on roles.** Before, a `MANAGE_ROLES`
   holder could put any bit on any role, including `ADMINISTRATOR` on their
   own role or on @everyone. Now they can only switch bits they hold, and new
   roles they create start with the @everyone defaults they hold. Copying or
   deleting a role that carries a bit they lack is refused, and so is giving
   such a role to a member, even when it ranks below them (for example an
   `ADMINISTRATOR` role the owner created after the moderator role). They
   can still take it away from a member ranked below them.
6. **Overrides: editing got looser, deleting got stricter.** Before, a `PUT`
   was refused when the override contained any unheld bit at all, so a
   moderator could not re-save an override the owner had set with such a bit;
   a `DELETE` was not checked. Now a `PUT` keeps the unheld bits and lets the
   moderator edit the rest, and a `DELETE` of an override that sets an unheld
   bit is refused. The Private switch in channel and category settings
   changes only the View Channels bit of the @everyone override
   (`useEntityOverrides().setBits`, `withOverrideBits`): the row keeps every
   other bit and is removed only when nothing is left on it. So the switch
   needs View Channels held and a role (the hierarchy on @everyone), not
   every bit the stored @everyone override sets.
7. **Unchanged:** the owner and instance admins, unban, leaving a space, and
   anything a member does to themselves.

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

Member and role actions also follow the role hierarchy and the held-bits
rule (above). Every gated surface:

| Surface | File | Gating |
|---|---|---|
| Members list: kick and ban | `spaceSettingsPanels/MembersPanel.tsx` | hidden for members ranked at or above the viewer |
| Members list: role checkboxes | `spaceSettingsPanels/MembersPanel.tsx` | roles at or above the viewer's top role disabled (`settings.members.rolesAboveYou`); a role the member does not have yet and that carries a bit the viewer does not hold disabled (`settings.members.rolesUnheld`); each reason shown under the list with a lock, and as the row's title; the editor does not open for members ranked at or above the viewer |
| Profile card: Edit Roles | `ui/UserProfilePopout.tsx` | desktop only; offered for a member of the loaded space when `viewerCanEditMemberRoles` holds: the viewer holds MANAGE_ROLES, the member is neither the viewer (by their id on the space's instance) nor the owner and ranks below the viewer, and some role other than @everyone ranks below the viewer; opens the member role editor |
| Member role editor: role checkboxes | `modals/MemberRolesModal.tsx` | the Members list rule: roles at or above the viewer's top role disabled (`settings.members.rolesAboveYou`); a role the member does not have yet and that carries a bit the viewer does not hold disabled (`settings.members.rolesUnheld`); each reason shown under the list with a lock, and as the checkbox's title |
| Member role editor: permissions | `modals/MemberRolesModal.tsx` | the Role editor rule: a role at or above the viewer's top role is read-only with the `roles.aboveYou` note; a toggle for a bit the viewer does not hold is locked in both directions, shows its state and a lock, and the `roles.unheldLocked` note says why |
| Role list: reorder | `spaceSettingsPanels/RoleOrderList.tsx` | lock instead of controls on roles at or above the viewer's top role |
| Role list: Create Role | `spaceSettingsPanels/RolesPanel.tsx` | disabled unless the viewer ranks above position 1 |
| Role editor: whole role | `spaceSettingsPanels/RolesPanel.tsx` | read-only with the `roles.aboveYou` note for a role at or above the viewer's top role; no Delete |
| Role editor: permission toggles | `spaceSettingsPanels/RolesPanel.tsx` | a toggle for a bit the viewer does not hold is locked in both directions, shows its state and a lock, and the `roles.unheldLocked` note says why |
| Role editor: Copy Role | `spaceSettingsPanels/RolesPanel.tsx` | disabled when the viewer cannot create a role at 1, or the role carries a bit the viewer does not hold (`roles.copyUnheld`) |
| Role editor: Delete Role | `spaceSettingsPanels/RolesPanel.tsx` | not offered for a role at or above the viewer's top role; disabled when the role carries a bit the viewer does not hold (`roles.copyDeleteUnheld`) |
| Channel and category overrides: higher targets | `ui/OverrideEntry.tsx` via `ui/PermissionsEditor.tsx` | an override on a role at or above the viewer's top role, or on a member ranked at or above the viewer, is read-only with no remove (`permissions.aboveYouRole` / `aboveYouMember`); such roles and members are left out of Add Role and Add Member |
| Channel and category overrides: toggles | `ui/OverrideEntry.tsx` via `ui/PermissionsEditor.tsx` | a tri-state toggle for a bit the viewer does not hold is locked, shows its state and a lock, and the `permissions.unheldLocked` note says why |
| Channel and category overrides: remove | `ui/OverrideEntry.tsx` via `ui/PermissionsEditor.tsx` | disabled for a saved override that sets a bit the viewer does not hold (`permissions.removeUnheld`); a row added in the same edit can always be dropped |
| Voice user menu: mute, deafen, move, disconnect | `voice/voiceMenuItems.tsx` | no moderation items for members ranked at or above the viewer |
| Voice drag-to-move | `hooks/useDragManager.ts` via `layout/ChannelSidebar.tsx` | not draggable for members ranked at or above the viewer |

The helpers in `web/src/utils/roleHierarchy.ts` are the surface every role
and permission editor gates with: `myUserIdInSpace`, `myStandingIn`,
`viewerCanActOn`, `viewerCanManageRoleAt`, `viewerCanActOnUserInSpace`,
`useViewerHeldPermissions` / `viewerHeldPermissions`, `viewerCanSwitchBit`,
`unswitchableBits`, `viewerCanCreateRoleWith`, `viewerCanRemoveOverride` and
`viewerCanEditMemberRoles`.
Each compares with the viewer's id and permissions on the space's own
instance, never the home id.

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
