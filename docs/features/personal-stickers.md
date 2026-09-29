# Personal stickers

## Scope

- Personal collections support upload, send, collection from local image attachments or sticker messages, and removal.
- Uploads use a local preview and editable name before explicit confirmation, with file selection, drag-and-drop, and clipboard paste. Removal is isolated in management mode.
- Collection is available in the existing right-click image menu (long-press on mobile), not as a permanent button beneath messages. Hover reaction cards place the large sticker above the reacting users.
- The existing message reaction picker also offers personal stickers. Reactions keep the existing grouping, permission checks, user identity resolution, and add/remove transport. Hover previews add the large image beside the existing reactor summary.
- No public gallery and no cross-instance collection or server-side URL fetching in this version. A remote sticker can still be displayed using its originating asset URL; collection is rejected explicitly.

## Storage and protocol

Migration `0024_personal_stickers` adds immutable content-addressed `sticker_assets` and a user-scoped `personal_stickers` table. The user/asset primary key makes collection idempotent. Collection removal does not delete the asset or change old messages/reactions.

Images live in `UPLOAD_DIR/stickers/<sha256>.webp`, outside the ordinary orphan-attachment cleanup. Back up the complete upload directory alongside SQLite. These assets are retained; the existing top-level attachment storage statistics do not include this subdirectory.

`sticker:<absolute asset URL>` is a reserved complete message/reaction value. Only canonical HTTP(S) URLs matching `/api/stickers/assets/<sha256>.webp` are interpreted as stickers. Ordinary emoji and other message text retain their behavior. Sticker content does not also generate an embed. Existing clients without sticker rendering will show the token as text.

Configure `PUBLIC_ORIGIN` (or the existing domain setting) correctly: the canonical origin is persisted in sent tokens and must remain reachable. As with existing uploads, asset URLs are public to anyone holding the link; only collection lists and mutations require authentication. There is no promise of private image storage.

## Upload boundaries

Accept PNG, JPEG, WebP and GIF, up to 5 MiB per uploaded source image. The client sends base64 JSON using the existing authenticated API client, with a matching server body-size limit. The server validates bytes with Sharp and re-encodes to WebP, retaining animation and stripping non-image payloads/metadata. SVG and malformed images are rejected. A 16,777,216 decoded-pixel safety limit (including animation frames) prevents small compressed files from exhausting memory; large animations can therefore be rejected even below 5 MiB. Encoding can change colors/quality; original bytes are not retained.

Assets are published using an atomic rename, then registered in SQLite. Unexpected filesystem or database errors remain server errors, not success or image-validation responses.

## Endpoints

- `GET /api/stickers`: current user's collection.
- `POST /api/stickers`: `{name, image}` with base64 image bytes; creates/reuses an asset and collects it.
- `POST /api/stickers/:id/collect`: `{token}`; the token must identify this instance's canonical asset endpoint.
- `DELETE /api/stickers/:id`: removes only the authenticated user's collection entry.
- `GET /api/stickers/assets/:id.webp`: immutable public WebP.

Local message attachments are fetched by the browser from the existing public upload endpoint and passed through the same upload validation. The server never downloads a caller-supplied URL.
