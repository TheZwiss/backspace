# Federated Sticker Store

> **Companion spec:** Individual account collections, token wire format (`sticker:<origin>/api/stickers/assets/<sha256>.webp`), image encoding bounds, and base storage janitor rules are specified in [`uploads.md` §14 Personal Stickers](uploads.md#14-personal-stickers). This document specifies versioned sticker packs, local moderation, peer-to-peer pack replication, reconciliation, and reference-safe asset cleanup.

Source files:
- `packages/shared/src/stickers.ts` -- Shared types, limits, `qualifyStickerPackId` / `parseQualifiedStickerPackId`
- `packages/server/src/routes/stickerStore.ts` -- Store browse/detail/install routes and creator pack authoring routes
- `packages/server/src/routes/stickerStoreAdmin.ts` -- Admin review queue, pack moderation, peer policy, remote sync, and reconciliation routes
- `packages/server/src/routes/federation/handlers/stickerSync.ts` -- Inbound S2S HMAC endpoints (`/api/federation/stickers/packs/list`, `/packs/get`)
- `packages/server/src/utils/stickerSync.ts` -- Outbound S2S sync, content-addressed asset verification, peer policy enforcement, pack purge, and peer reconciliation
- `packages/server/src/utils/stickerAssets.ts` -- Live reference scanning (`getReferencedStickerIds`) and immediate/scheduled asset cleanup
- `packages/web/src/components/chat/StickerStoreModal.tsx` -- Store modal (Explore, My Packs, Admin Reviews)
- `packages/web/src/components/chat/StickerPackManageModal.tsx` -- Creator pack editor

---

## 1. Design Invariants & Federation Model

1. **Explicit Peer Allow (Default-Deny):** Receiving instances never accept or fetch sticker packs from a federated peer unless a local administrator explicitly sets `sticker_peer_policies.policy = 'allow'` for that peer's origin. Newly peered instances default to `'block'`.
2. **Explicit Local Approval:** Replicated packs (and new versions of already-replicated packs) enter `pending_review` on the receiving instance. Nothing supplied by a peer becomes visible in the local store or installable until a local administrator approves it.
3. **Origin-Qualified Pack Identity:** Every pack carries a non-null `(source_instance, source_pack_id)` pair enforced by a `UNIQUE` index (`idx_sticker_packs_source`), serialized on the wire as `qualifiedId = <sourceInstance>/api/sticker-packs/<sourcePackId>`. Local packs record `source_instance = getOurOrigin()` and `source_pack_id = id`; replicas record the authoritative peer's origin and pack ID.
4. **Authoritative Non-Transitive Publishing:** S2S endpoints (`/api/federation/stickers/packs/list` and `/packs/get`) expose **only** locally authored packs (`origin_type = 'source' AND status = 'approved'`). Replicas are never re-published to third instances.
5. **Immediate Local Block or Removal:** Deleting a pack locally (`DELETE /api/sticker-packs/:id`), setting a pack status to `'blocked'` or `'disabled'`, or changing a peer policy to `'block'` takes effect immediately across store browse, pack detail, install, and `my-packs`.
6. **Authoritative Removal & Reconciliation:** When an authoritative peer deletes, blocks, or unapproves a source pack, `/packs/list` omits it and `/packs/get` returns `404`. Upon reconciliation (`POST /api/admin/federation/stickers/reconcile` or the periodic federation health-check worker), the receiving instance transitions affected replicas to `'deleted'`, drops user installs, and stops serving the pack.
7. **Reference-Safe Asset Cleanup:** Sticker image files (`UPLOAD_DIR/stickers/<sha256>.webp` and `<sha256>_preview.webp`) are content-addressed by SHA-256. Whenever a pack is deleted, locally blocked, rejected (for unapproved replicas), or removed during peer reconciliation, `purgeStickerPacksAssetsAndData` removes its `sticker_pack_items` and `sticker_pack_versions` rows and invokes `cleanupUnreferencedStickerAssets`. Only assets with **zero remaining live references** across `personal_stickers`, non-deleted/non-blocked `sticker_packs`, channel/DM `messages`, and channel/DM `reactions` are deleted from disk and `sticker_assets`. Assets used in message history, reactions, personal collections, or other live packs remain intact.

---

## 2. Database Schema

Added by migrations `0032_federated_sticker_store.sql` and `0033_max_sticker_size.sql`:

### `sticker_packs`
| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| `id` | `TEXT` | PK | Local pack UUID |
| `name` | `TEXT` | NOT NULL | Pack display title (1-100 chars) |
| `description` | `TEXT` | NULL | Optional description (up to 500 chars) |
| `creator_id` | `TEXT` | FK → `users(id)` SET NULL | Local creator account (`NULL` on replicas) |
| `creator_name` | `TEXT` | NULL | Display/author handle |
| `cover_asset_id` | `TEXT` | FK → `sticker_assets(id)` SET NULL | Cover WebP hash (`NULL` when purged) |
| `origin_type` | `TEXT` | NOT NULL DEFAULT `'source'` | `'source'` (authored here) or `'replica'` (mirrored from peer) |
| `source_instance` | `TEXT` | NULL | Canonical origin of the authoritative instance |
| `source_pack_id` | `TEXT` | NULL | Pack ID on the authoritative instance |
| `current_version` | `INTEGER` | NOT NULL DEFAULT `1` | Currently approved/active version number |
| `status` | `TEXT` | NOT NULL DEFAULT `'draft'` | `'draft'`, `'pending_review'`, `'approved'`, `'rejected'`, `'disabled'`, `'blocked'`, `'deleted'` |
| `review_notes` | `TEXT` | NULL | Admin rejection notes |
| `reviewed_by` | `TEXT` | FK → `users(id)` SET NULL | Admin who last reviewed |
| `reviewed_at` | `INTEGER` | NULL | Epoch ms |
| `synced_at` | `INTEGER` | NULL | Epoch ms of last S2S sync (replicas) |
| `created_at` | `INTEGER` | NOT NULL | Epoch ms |
| `updated_at` | `INTEGER` | NOT NULL | Epoch ms |

Indexes: `idx_sticker_packs_status` (`status`), `idx_sticker_packs_creator` (`creator_id`), `idx_sticker_packs_source` **UNIQUE** (`source_instance`, `source_pack_id`).

### `sticker_pack_versions`
Immutable-once-approved version snapshots so creators and peers can stage updates without mutating the live approved pack.
- PK: `id` (`TEXT`), UNIQUE `(pack_id, version)` (`idx_pack_versions_unique`), FK `pack_id` → `sticker_packs(id)` CASCADE, FK `cover_asset_id` → `sticker_assets(id)` SET NULL.
- `status`: `'draft'`, `'pending_review'`, `'approved'`, `'rejected'`.

### `sticker_pack_items`
Stickers belonging to a specific pack version (`MAX_STICKERS_PER_PACK = 100`).
- PK: `id` (`TEXT`), FK `pack_id` → `sticker_packs(id)` CASCADE, FK `version_id` → `sticker_pack_versions(id)` CASCADE, FK `asset_id` → `sticker_assets(id)` **RESTRICT**.
- Purging a deleted or blocked pack deletes its `sticker_pack_items` rows inside a transaction before running `cleanupUnreferencedStickerAssets`, releasing the `RESTRICT` foreign key for unreferenced assets while preserving tombstone rows in `sticker_packs`.

### `user_installed_packs`
- PK: `(user_id, pack_id)`, FKs CASCADE to `users(id)` and `sticker_packs(id)`. Tracks packs pinned to a user's sticker picker.

### `sticker_peer_policies`
Per-peerinbound replication policy on the receiving instance.
- Columns: `id` (PK), `peer_origin` (`TEXT UNIQUE NOT NULL`), `policy` (`'allow' | 'block'`, **DEFAULT `'block'`**), `auto_sync` (`INTEGER NOT NULL DEFAULT 0`), `created_at`, `updated_at`.

### `instance_settings.max_sticker_size_bytes`
- Nullable integer override configured via `PATCH /api/settings/instance` (`maxStickerSizeMb`, 1-50 MB; falls back to `MAX_STICKER_SIZE` / 5 MiB default). Exposed publicly in `GET /api/instance/info` as `maxStickerSizeMb`.

---

## 3. HTTP & S2S Endpoints

### Store & Picker (`routes/stickerStore.ts`)
- `GET /api/sticker-store/packs?q=` (optional auth) — Lists locally `'approved'` packs (and replicas whose `source_instance` currently has `policy = 'allow'`).
- `GET /api/sticker-store/packs/:id` (optional auth) — Pack detail and items. Returns `404` immediately when `deleted`, `blocked`, or from a non-allowed peer; unapproved drafts/reviews are visible only to their local creator or an admin.
- `POST /api/sticker-store/packs/:id/install` / `DELETE .../install` (auth) — Installs/uninstalls an available pack.
- `GET /api/sticker-store/my-packs` (auth) — Installed packs that remain locally `'approved'` (and peer-allowed for replicas).

### Creator Lifecycle (`routes/stickerStore.ts`)
- `POST /api/sticker-packs` (auth) — Creates a `'source'` pack at v1 `'draft'` with `source_instance = getOurOrigin()` and `source_pack_id = id`.
- `GET /api/sticker-packs/created` / `GET /api/sticker-packs/:id` (auth) — Lists/reads creator's packs.
- `POST /api/sticker-packs/:id/items` / `DELETE .../items/:itemId` / `PUT .../items/order` (auth) — Edits a `'draft'` or `'rejected'` version.
- `POST /api/sticker-packs/:id/submit` (auth) — Submits draft version to `'pending_review'`. If v1 is already `'approved'`, v1 stays live while v2 awaits admin review.
- `POST /api/sticker-packs/:id/new-version` (auth) — Clones current approved items into `currentVersion + 1` `'draft'`.
- `DELETE /api/sticker-packs/:id` (auth, creator or admin) — Purges versions/items/installs, marks pack `'deleted'`, and cleans up unreferenced assets immediately.

### Admin Moderation & Peer Controls (`routes/stickerStoreAdmin.ts`)
- `GET /api/admin/sticker-packs/reviews` (admin) — Lists local and replicated packs with a `'pending_review'` version.
- `POST /api/admin/sticker-packs/:id/approve` (admin) — Promotes the pending version to `current_version` and sets `status = 'approved'` (refused with `403 sticker_peer_blocked` if a replica's peer is not allowed).
- `POST /api/admin/sticker-packs/:id/reject` (admin) — Rejects pending version with optional `reviewNotes`; for unapproved replicas, discards staged items and cleans up unreferenced assets.
- `GET /api/admin/sticker-packs` (admin) — Lists packs across all statuses/origins.
- `POST /api/admin/sticker-packs/:id/status` (admin) — Sets `'approved' | 'blocked' | 'disabled'`. `'blocked'` immediately purges items/versions/installs and cleans up unreferenced assets.
- `GET /api/admin/federation/stickers/peers` (admin) — Lists `federation_peers` with effective policy (default `'block'`), `autoSync`, and replica count.
- `PUT /api/admin/federation/stickers/peers/:peerOrigin/policy` (admin) — Sets `policy` (`'allow' | 'block'`) and `autoSync`. Setting `'block'` immediately blocks all replicas from that peer and cleans up unreferenced replicated assets.
- `GET /api/admin/federation/stickers/remote-packs?peerOrigin=` (admin) — Queries an active, explicitly allowed peer's `/packs/list`.
- `POST /api/admin/federation/stickers/sync` (admin) — Downloads, SHA-256 verifies, and stages a remote pack into `'pending_review'`.
- `POST /api/admin/federation/stickers/reconcile` (admin) — Reconciles one `peerOrigin` or all peers against authoritative `/packs/list` responses and local policies.

### S2S Federation Endpoints (`routes/federation/handlers/stickerSync.ts`)
Authenticated via `authenticateS2SPeer` (HMAC signature + active peer + replay nonce):
- `POST /api/federation/stickers/packs/list` — Returns `{ packs }` containing only `origin_type = 'source' AND status = 'approved'` packs with `id`, `origin`, `qualifiedId`, `currentVersion`, and `itemCount`.
- `POST /api/federation/stickers/packs/get` — Takes `{ packId }`; returns metadata and `{ assetId, name, sortOrder }[]` for an approved local source pack, or `404` if missing/removed/unapproved. Receiving instances fetch each `assetId` from `/api/stickers/assets/<assetId>.webp` via `federationFetch` and verify `sha256(bytes) === assetId` before atomic disk rename.
