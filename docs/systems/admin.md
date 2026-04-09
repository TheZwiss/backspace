# Admin & Instance Configuration System

Source files:
- `packages/server/src/routes/admin.ts` -- User management, storage management endpoints
- `packages/server/src/routes/instance.ts` -- Public instance info endpoint
- `packages/server/src/routes/settings.ts` -- Instance settings and streaming limits endpoints
- `packages/server/src/utils/auth.ts` -- `requireAdmin` middleware
- `packages/server/src/utils/userDeletion.ts` -- `tombstoneUser()` deletion logic
- `packages/server/src/utils/storageJanitor.ts` -- Storage stats, orphan detection, cleanup
- `packages/web/src/stores/settingsStore.ts` -- Zustand store for instance/streaming settings
- `packages/web/src/components/modals/instanceSettingsPanels/GeneralPanel.tsx` -- General settings UI
- `packages/web/src/components/modals/instanceSettingsPanels/StoragePanel.tsx` -- Storage management UI
- `packages/web/src/components/modals/instanceSettingsPanels/StreamingPanel.tsx` -- Streaming config UI
- `packages/web/src/components/modals/instanceSettingsPanels/UsersPanel.tsx` -- User management UI
- `packages/shared/src/types.ts` -- Shared type interfaces
- `packages/shared/src/constants.ts` -- Streaming constants (resolutions, framerates, bitrate matrix)

---

## Authentication & Authorization

All admin endpoints use two Fastify preHandlers chained in order:

1. **`authenticate`** -- Verifies JWT from `Authorization: Bearer <token>` header, sets `request.userId`
2. **`requireAdmin`** -- Queries `users` table, verifies `isAdmin === 1`. Returns 403 if not admin.

```
auth.ts:requireAdmin()
  → db.select().from(users).where(id = request.userId)
  → if !caller || caller.isAdmin !== 1 → 403 "Only instance admins can perform this action"
```

The instance info endpoint (`GET /api/instance/info`) is fully public with no auth.
The streaming limits read endpoint (`GET /api/settings/streaming`) requires only `authenticate` (any logged-in user).

---

## Instance Settings Table

Singleton row in `instance_settings` (id=1). See [database.md](database.md) for full schema.

Settings are split into two API surfaces:

| Setting Group | Read Endpoint | Write Endpoint |
|---------------|--------------|----------------|
| General/Admin | `GET /api/settings/instance` (admin) | `PATCH /api/settings/instance` (admin) |
| Streaming | `GET /api/settings/streaming` (auth) | `PATCH /api/settings/streaming` (admin) |
| Public info | `GET /api/instance/info` (public) | N/A (derived from settings) |

### General Settings Schema (InstanceAdminSettings)

| Field | Type | DB Column | Validation | Notes |
|-------|------|-----------|------------|-------|
| instanceName | string | instanceName | 1-32 chars, trimmed | Default: `'Backspace'` |
| registrationOpen | boolean | registrationOpen | boolean | DB null = use env `REGISTRATION_OPEN` (default true) |
| discoveryEnabled | boolean | discoveryEnabled | boolean | Controls space Explore page |
| gifApiKey | string? | gifApiKey | string or empty to clear | Returned masked as `****{last4}` for security |
| gifEnabled | boolean? | (derived) | -- | Read-only; true when gifApiKey is non-null |
| maxUploadSizeMb | number | maxUploadSizeBytes | 1-5120 MB | Stored as bytes; converted on read/write. DB null = use env `MAX_UPLOAD_SIZE` (default 100MB) |
| federationRelayEnabled | boolean | federationRelayEnabled | boolean | Default: 1 (enabled) |
| federationRelayTtlDays | number | federationRelayTtlDays | integer 1-365 | Default: 30 days |
| autoAcceptPeering | boolean | autoAcceptPeering | boolean | Default: true. When false, `peer/accept` rejects unsolicited requests (403 PEERING_REQUIRES_APPROVAL); only requests where a local `pending` record already exists are accepted |

### Streaming Settings Schema (InstanceStreamingLimits)

| Field | Type | DB Column | Validation | Default |
|-------|------|-----------|------------|---------|
| maxBitrateKbps | number | maxBitrateKbps | 500-1000000 | 20000 |
| minBitrateKbps | number | minBitrateKbps | 100-1000000, must be < max | 500 |
| bitrateStepKbps | number | bitrateStepKbps | 50-5000 | 500 |
| allowedResolutions | (number\|'native')[] | allowedResolutions | Non-empty, values from STANDARD_RESOLUTIONS or 'native' | [540,720,1080] |
| allowedFramerates | number[] | allowedFramerates | Non-empty, values from STANDARD_FRAMERATES | [30,45,60] |
| maxResolution | number | maxResolution | Must be in STANDARD_RESOLUTIONS | 1080 |
| maxFramerate | number | maxFramerate | Must be in STANDARD_FRAMERATES | 60 |
| discoveryEnabled | boolean | discoveryEnabled | boolean | true |
| bitrateMatrixOverrides | Record<string,number>\|null | bitrateMatrixOverrides | Keys: `{res}_{fps}`, values: 1-1000000 | null |
| allowCustomBitrate | boolean | allowCustomBitrate | boolean | true |

**Streaming constants** (`packages/shared/src/constants.ts`):
```
STANDARD_RESOLUTIONS = [540, 720, 1080, 1440, 2160]
STANDARD_FRAMERATES  = [30, 45, 60, 75, 90, 120]
HIGH_END_RESOLUTION_THRESHOLD = 1440
HIGH_END_FRAMERATE_THRESHOLD  = 75
```

**Default bitrate matrix** (kbps, VP9 screen share):
```
      30    45    60    75    90    120
540   1500  2000  2500  2800  3200  4000
720   3000  3500  4000  4500  5000  6000
1080  6000  7000  8000  9000  10000 12000
1440  10000 12000 14000 16000 18000 22000
2160  20000 24000 28000 32000 38000 45000
```

See [voice.md](voice.md) for how clients enforce these limits at the WebRTC encoding boundary.

---

## Serialization Details

### Resolution/Framerate Storage

Stored as CSV strings in DB, parsed on read:

```
settings.ts:rowToLimits()
  allowedResolutions: row.allowedResolutions.split(',')
    → .map(s => s === 'native' ? 'native' : Number(s))
    → .filter(v => v === 'native' || STANDARD_RESOLUTIONS.includes(v))

  allowedFramerates: row.allowedFramerates.split(',')
    → .map(Number)
    → .filter(n => STANDARD_FRAMERATES.includes(n))
```

On write, numbers sorted ascending with 'native' always last:

```
settings.ts:PATCH /api/settings/streaming
  nums = allowedResolutions.filter(r => r !== 'native').sort(asc)
  updateData.allowedResolutions = [...nums, ...(hasNative ? ['native'] : [])].join(',')
```

### Bitrate Matrix Overrides

Stored as JSON string in DB. Sparse representation: only cells differing from defaults.

```
settings.ts:rowToLimits()
  raw = row.bitrateMatrixOverrides (string|null)
  → JSON.parse → validate is non-null non-array object → return if non-empty, else null
```

Valid keys: `{resolution}_{framerate}` (e.g., `"1080_60"`). Validated against all combinations of STANDARD_RESOLUTIONS x STANDARD_FRAMERATES.

### GIF API Key Masking

The `gifApiKey` is never returned in full. The GET response masks it:

```
settings.ts:GET /api/settings/instance
  gifApiKey: gifKey ? `****${gifKey.slice(-4)}` : undefined
```

On PATCH, if the client sends back a value starting with `****`, it is ignored (prevents overwriting the real key with the mask). Empty string clears the key.

---

## API Endpoints

### Public Instance Info

```
GET /api/instance/info
```

No authentication. Returns:

```typescript
{
  name: string;        // instanceSettings.instanceName ?? 'Backspace'
  version: string;     // Hardcoded '1.0.0' in instance.ts
  registrationOpen: boolean;  // DB setting overrides env if non-null
}
```

Registration resolution order: `instance_settings.registrationOpen` (if not null) > `config.registrationOpen` (from `REGISTRATION_OPEN` env, default true).

### General Instance Settings

```
GET  /api/settings/instance    — admin only → InstanceAdminSettings
PATCH /api/settings/instance   — admin only → InstanceAdminSettings
```

See field table above for validation rules. Cross-field: `discoveryEnabled` changes here are also synced to `streamingLimits` in the frontend store (`settingsStore.ts:updateInstanceSettings`).

### Streaming Settings

```
GET   /api/settings/streaming   — any authenticated user → InstanceStreamingLimits
PATCH /api/settings/streaming   — admin only → InstanceStreamingLimits
```

**Cross-field validation** on PATCH:
- `minBitrateKbps` must be strictly less than `maxBitrateKbps` (checked against effective values after merge with current DB row).

### Storage Management

All admin-only.

```
GET  /api/admin/storage/stats         → StorageStats
GET  /api/admin/storage/orphans       → { orphans: OrphanedFile[] }
POST /api/admin/storage/cleanup       { dryRun?: boolean } → CleanupResult
POST /api/admin/storage/cleanup-media { maxAgeDays: number, dryRun?: boolean } → CleanupResult
```

**StorageStats shape:**
```typescript
{
  totalFiles: number;
  totalSize: number;           // bytes
  referencedFiles: number;
  referencedSize: number;      // bytes
  orphanedFiles: number;       // Files on disk not referenced by DB
  orphanedSize: number;
  unlinkedAttachments: number; // Attachment records with no message
  unlinkedSize: number;
  danglingAttachments: number; // Attachment records pointing to missing files
  danglingSize: number;
  breakdown: { type: string; count: number; size: number }[];
}
```

**CleanupResult shape:**
```typescript
{
  dryRun: boolean;
  deletedFiles: number;
  freedBytes: number;
  deletedAttachmentRecords: number;
  errors: string[];
}
```

Storage functions (`getStorageStats`, `getOrphanedFiles`, `cleanupStorage`, `cleanupOldMedia`) are implemented in `utils/storageJanitor.ts`. Out of scope here -- if an uploads.md spec is created, document there.

**Cleanup flow (UI):**
1. Admin clicks "Preview Cleanup" -- calls `cleanupStorage(dryRun=true)` or `cleanupOldMedia(days, dryRun=true)`
2. Preview result shown with count/size
3. "Clean Up Now" / "Delete Now" button enabled only after preview completes
4. Live cleanup calls same endpoint with `dryRun=false`
5. Stats refreshed after live cleanup

**Media cleanup validation:** `maxAgeDays` must be a positive integer >= 1. Returns 400 otherwise.

### User Management

All admin-only.

```
GET    /api/admin/users              → AdminUserListResponse
GET    /api/admin/users/instances    → { instances: string[] }
PATCH  /api/admin/users/:id/role     { isAdmin: boolean } → AdminUser
POST   /api/admin/users/:id/reset-password → AdminResetPasswordResponse
DELETE /api/admin/users/:id          → { success: boolean }
```

---

## User List: Filters, Search, Sort, Pagination

### Query Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| q | string | '' | Fuzzy search on username and displayName (SQL LIKE `%q%`) |
| page | number | 1 | Page number, min 1 |
| pageSize | number | 50 | Results per page, clamped to 1-100 |
| showDeleted | 'true' | false | Include tombstoned users |
| homeInstance | string | -- | `'local'` for null homeInstance; otherwise exact domain match |
| role | string | -- | `'admin'` or `'non-admin'` |
| joinedAfter | date string | -- | Parsed as `new Date(value).getTime()` |
| joinedBefore | date string | -- | Parsed as `new Date(value + 'T23:59:59.999Z').getTime()` (inclusive end-of-day) |
| sort | string | 'newest' | One of: `newest`, `oldest`, `az`, `za` |

### Sort Options

| Value | SQL | Description |
|-------|-----|-------------|
| newest | `desc(users.createdAt)` | Most recently created first |
| oldest | `asc(users.createdAt)` | Oldest first |
| az | `asc(users.username)` | Alphabetical A-Z |
| za | `desc(users.username)` | Reverse alphabetical |

### Filter Composition

Filters are combined with AND. When `showDeleted` is false (default), `isDeleted = 0` is always added. Search `q` creates an OR condition across `username LIKE` and `displayName LIKE`.

### Instances Endpoint

`GET /api/admin/users/instances` returns all distinct non-null `homeInstance` values from the users table. Used by the frontend to populate the instance filter dropdown.

### AdminUser Shape

```typescript
{
  id: string;
  username: string;
  displayName: string | null;
  avatar: string | null;
  avatarColor: string | null;
  status: string;         // 'online'|'idle'|'dnd'|'offline', defaults to 'offline' if null
  isAdmin: boolean;
  isDeleted: boolean;
  homeInstance: string | null;
  createdAt: number;      // epoch ms
}
```

Produced by `admin.ts:toAdminUser()` -- maps integer DB columns to booleans, coalesces null status.

---

## Admin Actions: Safety Rules

### Promote/Demote Admin (PATCH /api/admin/users/:id/role)

```
Request: { isAdmin: boolean }
```

**Safety checks:**
1. `isAdmin` must be a boolean (400)
2. Target user must exist (404)
3. Target must not be deleted (400)
4. **Promote**: target must NOT have a `homeInstance` (403 "Federated users cannot be promoted to admin")
5. **Demote**: if target is currently admin, count all non-deleted admins. If count <= 1, reject (400 "Cannot demote the last admin")

**Side effects on success:**
- Updates `users.isAdmin` to 1 or 0
- Sends `user_updated` WebSocket event to target user via `connectionManager.sendToUser()` so their UI reflects the change immediately

### Reset Password (POST /api/admin/users/:id/reset-password)

**Safety checks:**
1. Target must exist (404)
2. Target must not be deleted (400)
3. Target must NOT have a `homeInstance` (400 "Federated users authenticate via their home instance")

**Process:**
1. Generate 12 random bytes, encode as `base64url` -- this is the temporary password
2. Hash with bcrypt via `hashPassword()`
3. Update `users.passwordHash` and `users.passwordChangedAt = Date.now()`
4. Force-disconnect all of target's WebSocket sessions via `connectionManager.forceDisconnectUser()`
5. Return `{ temporaryPassword }` in response

The `passwordChangedAt` update ensures all existing JWTs for the user are invalidated (tokens issued before this timestamp are rejected by the auth middleware).

The temporary password is shown exactly once in the admin UI -- the UsersPanel displays it inline below the user row with a copy button and a "Shown once" warning.

### Delete User (DELETE /api/admin/users/:id)

**Safety checks:**
1. Cannot delete yourself (400 "Use account settings to delete your own account")
2. Target must exist (404)
3. Target must not be already deleted (400)
4. Target must not own any spaces (400 "User owns spaces -- transfer ownership first", response includes `ownedSpaces` array with id/name)

**Process:**
1. Call `tombstoneUser(targetId)` -- returns list of files to delete (avatar, banner)
   - Tombstone sets `isDeleted=1`, clears personal data, removes from spaces/friends/DMs/reactions/read-states/folders in a transaction
   - Transfers group DM ownership to next member
2. Delete returned files from disk via `deleteUploadFile()`
3. Force-disconnect all WebSocket sessions
4. Return `{ success: true }`

---

## Frontend Architecture

### Settings Store (settingsStore.ts)

Zustand store managing two data objects:

| State | Type | Fetched Via | Updated Via |
|-------|------|-------------|-------------|
| streamingLimits | InstanceStreamingLimits \| null | `fetchStreamingLimits()` | `updateStreamingLimits()` |
| instanceSettings | InstanceAdminSettings \| null | `fetchInstanceSettings()` | `updateInstanceSettings()` |
| isAdmin | boolean | Set externally via `setIsAdmin()` | -- |
| gifEnabled | boolean | `fetchGifEnabled()` | -- |

**Default fallback:** If streaming limits fail to fetch, the store falls back to `DEFAULT_LIMITS`:
```typescript
{
  maxBitrateKbps: 20000,
  minBitrateKbps: 500,
  bitrateStepKbps: 500,
  allowedResolutions: [540, 720, 1080],
  allowedFramerates: [30, 45, 60],
  maxResolution: 1080,
  maxFramerate: 60,
  discoveryEnabled: true,
  bitrateMatrixOverrides: null,
  allowCustomBitrate: true,
}
```

**Cross-field sync:** When `updateInstanceSettings()` changes `discoveryEnabled`, it also patches `streamingLimits.discoveryEnabled` to keep the streaming panel's DiscoveryPanel warning banner in sync.

**Exported helper:** `getStreamingLimits()` returns current limits or defaults -- used by voice/streaming code outside React.

### Admin UI Panels

All panels live under `packages/web/src/components/modals/instanceSettingsPanels/`. Each operates as a controlled form with a local `draft` state, detecting changes against the store's server-synced values. Unsaved changes show a sticky glass-bubble save/reset bar at the bottom.

#### GeneralPanel

Manages: instance name, registration toggle, discovery toggle, GIF API key, federation relay toggle/TTL, peered instances list.

- Instance name input: max 32 chars, enforced client-side via `slice(0, 32)`
- GIF key: password input, separate dirty tracking (`gifKeyDirty`). Only sent on save if modified. "Clear key" button sets empty string.
- Federation peers: fetched via `api.federation.peers()`, displayed as a list with status badges (active/pending/unreachable), last-seen/synced times, revoke button
- Peers with status `'revoked'` are filtered out of the visible list
- Revoke calls `api.federation.revokePeer(peerId)` and removes from local list

#### StoragePanel

Manages: storage overview, file type breakdown, upload limit, orphan cleanup, media retention cleanup.

- **Stats grid:** 5 cards (total files, referenced, orphaned, unlinked uploads, dangling records) with byte formatting
- **File type breakdown:** List of categories (image/video/audio/document/other) with file counts and sizes
- **Upload limit:** Number input (1-5120 MB) with save button, persisted via `updateInstanceSettings({ maxUploadSizeMb })`
- **Orphan cleanup:** Two-step (preview dry-run, then live). "Clean Up Now" disabled until preview completes
- **Media retention:** Age-based cleanup with configurable days input. Same two-step preview/execute pattern.
- "Refresh Stats" link at bottom re-fetches all stats

#### StreamingPanel

Manages: bitrate range (min/max/step), custom bitrate toggle, resolution/framerate allowlists, bitrate matrix.

- **Bandwidth section:** Range sliders + number inputs for min/max bitrate. Step size via preset pills (100, 250, 500, 1000, 2500, 5000 kbps) + custom number input.
- **Custom Bitrate toggle:** Controls whether users can set their own bitrate vs using matrix defaults
- **Quality section:** Toggle pills for each resolution (540p, 720p, 1080p, 1440p, 4K, Native) and framerate (30, 45, 60, 75, 90, 120 fps). At least one of each must remain enabled.
- **High-end warning:** Shown when resolutions >= 1440 or framerates >= 75 are enabled. Warns about CPU/GPU/bandwidth requirements.
- **Bitrate matrix:** Interactive grid of resolution x framerate cells. Displays in Mbps (stored as kbps). Click to edit. Overridden cells highlighted in accent-primary. Cells exceeding maxBitrateKbps highlighted in amber.
- **Scale slider:** Multiplies all matrix values by 0.5x-2.0x. Captures snapshot on drag start, applies factor during drag, releases on pointer up.
- **Save payload:** Only cells differing from defaults are sent as `bitrateMatrixOverrides`; identical-to-default cells are omitted (sparse representation). If no overrides, `null` is sent.

#### UsersPanel

Manages: user list with search/filter/sort/pagination, admin promotion/demotion, password reset, account deletion.

- **Search:** Debounced (300ms) text input, resets to page 1 on change
- **Filters:** Instance dropdown (local/specific domain), role (admin/non-admin), joined-after/joined-before date pickers, sort dropdown
- **"Clear filters" link:** Visible when any filter/sort/search is active. Resets all to defaults.
- **Page size:** Fixed at 50 (not user-configurable)
- **Pagination:** Previous/Next buttons, "Page X of Y (N users)" label
- **User rows:** Avatar, username, display name, badges (Admin amber, federated instance sky, Deleted rose), join date
- **Action buttons** (per user, hidden if deleted):
  - Shield icon: promote/demote admin. Disabled for federated users. Demotion requires ConfirmDialog.
  - Key icon: reset password. Disabled for federated users. Requires ConfirmDialog. Shows temporary password inline.
  - Trash icon: delete user. Disabled for self. Requires ConfirmDialog (danger variant).
- **Temp password display:** Appears inline below the user row after successful reset. Includes copy-to-clipboard button and "Shown once" notice.

---

## Data Flow: Settings Update Lifecycle

```
[Admin UI Panel]
  → local draft state (useState)
  → user clicks Save
  → settingsStore.updateStreamingLimits() / updateInstanceSettings()
    → api.settings.updateStreaming() / updateInstance()
      → PATCH /api/settings/streaming or /api/settings/instance
        → Server validates each field
        → Cross-field validation (min < max for bitrates)
        → db.update(instanceSettings).set(updateData).where(id=1)
        → db.select fresh row → serialize → return
    → store.set({ streamingLimits: updated }) / set({ instanceSettings: updated })
  → UI re-renders from store, draft resets to match
```

---

## Cross-References

- **Database schema:** [database.md](database.md) -- `instance_settings`, `users`, `spaces` tables
- **API endpoints:** [api.md](api.md) -- Full endpoint listing for admin, settings, instance routes
- **Federation relay:** [federation.md](federation.md) -- Relay toggle/TTL mechanics, peer management, outbox delivery
- **Voice/streaming:** [voice.md](voice.md) -- Client-side enforcement of streaming limits
- **Permissions:** [permissions.md](permissions.md) -- Admin flag is separate from RBAC; `isAdmin` is a user-level column, not a permission bit
