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
