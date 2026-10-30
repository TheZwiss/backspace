# Sticker Library, Server Packs, Favorites, and Sharing

Stickers have three visibility scopes, stored in `sticker_packs.scope_type`:

| Scope | Owner | Visibility | Limit |
|---|---|---|---|
| `user` | one account | Settings only, plus albums explicitly shared and approved | 30 per album |
| `space` | one server | every member of that server in the sticker picker | 50 total per server |
| `instance` | instance catalog | approved packs in Explore; approved instance shares from user albums | 100 per pack |

Personal collections (`personal_stickers`) remain the legacy flat 200-item collection. They are independent from private albums and can stay in place for older clients.

## Private albums

`stickerPacks` with `scopeType = 'user'` and `stickerPacks.creatorId` are private. The owner creates an album under **User Settings → Stickers**, adds images, and can remove items. Images use the same validation and WebP encoding as the rest of the sticker pipeline. Animated PNG/WebP/GIF frames are preserved.

Cropping is square. The browser obtains the crop rectangle from `react-easy-crop`; for animated input it sends the original bytes and normalized crop coordinates instead of painting a single canvas frame. The server applies `sharp.extract` to all frames before resizing. Static uploads follow the same route so there is one behavior.

## Server pack

Every server has at most one `scopeType = 'space'` pack, enforced by `idx_sticker_packs_one_space_pack`. Creation and additions require `CREATE_STICKERS`; deletion and moderation require `MANAGE_STICKERS`. Server owners have these through `ADMINISTRATOR`. The server settings **Server stickers** panel creates the pack on demand.

The chat sticker picker loads every server the user belongs to. The left rail selects a server and draws that server's pack. Servers without a pack remain visible but disabled.

## Favorites

`sticker_favorites` stores a local asset id per account. Right-clicking a sticker message offers **Favorite sticker**; the client reads the canonical sticker URL, uploads a local copy through `POST /api/sticker-favorites`, and the server records the content-addressed asset. This keeps favorites working if the source instance or message disappears.

Favorites appear in User Settings and in the sticker picker's left rail. They can be copied into any private album without fetching the source again; the same asset id is referenced.

## Sharing and approval

`sticker_pack_shares` attaches a private album to a target:

- `targetType = 'instance'`, `targetId = ''`: an instance admin must approve.
- `targetType = 'space'`, `targetId = <space>`: a member of that server may request; a holder of `MANAGE_STICKERS` approves.

An approved share makes the album visible in Explore for that target. It does not change the album to `scopeType = 'instance'`, so approved private albums are never included in federation discovery. Federation continues to expose only source packs with `scopeType = 'instance'`.

Share rows are pending, approved, or rejected. Re-requesting a rejected target resets it to pending. Duplicate target rows are prevented by `idx_sticker_share_target`.

## API

| Method and path | auth | purpose |
|---|---|---|
| `GET /api/sticker-library` | user | private albums, server packs, and favorites |
| `POST /api/private-sticker-packs` | user | create a private album |
| `POST /api/spaces/:spaceId/sticker-pack` | CREATE/MANAGE_STICKERS | create or return the one server pack |
| `POST /api/sticker-library/packs/:id/items` | owner or CREATE_STICKERS | add a cropped image |
| `DELETE /api/sticker-library/packs/:id/items/:itemId` | owner or MANAGE_STICKERS | remove an item |
| `POST /api/sticker-favorites` | user | copy an image into favorites |
| `DELETE /api/sticker-favorites/:assetId` | user | remove a favorite |
| `POST /api/private-sticker-packs/:id/items/from-favorite` | album owner | copy a favorite into an album |
| `POST /api/private-sticker-packs/:id/shares` | album owner | request instance or server approval |
| `GET /api/sticker-pack-shares` | admin or MANAGE_STICKERS | list pending requests |
| `POST /api/sticker-pack-shares/:id/decision` | admin or MANAGE_STICKERS | approve or reject |

## Storage and deletion

Every image remains content-addressed under `UPLOAD_DIR/stickers`. The janitor counts private album items, server items, favorites, public pack covers/items, messages, and reactions as references. Deleting a user explicitly removes private albums, favorites, and outgoing share requests because tombstoned rows do not fire SQLite cascades. Server packs belong to the server and are not removed with their last creator.
