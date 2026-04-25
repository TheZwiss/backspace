# Embed & Link Preview System

Source files:
- `packages/server/src/utils/embedClassifier.ts` — URL classification and provider detection
- `packages/server/src/utils/embedResolver.ts` — URL extraction, embed resolution pipeline, DB persistence, batch fetching
- `packages/server/src/utils/metadataFetcher.ts` — OpenGraph/HTML metadata scraping with Cheerio
- `packages/server/src/utils/ssrf.ts` — SSRF protection (DNS resolution, private IP blocking)
- `packages/web/src/components/chat/EmbedRenderer.tsx` — Client-side embed routing by type
- `packages/web/src/components/chat/embeds/GenericEmbed.tsx` — Generic link preview card
- `packages/web/src/components/chat/embeds/ImageEmbed.tsx` — Direct image embed with lightbox
- `packages/web/src/components/chat/embeds/RichEmbed.tsx` — Rich iframe embed (Spotify)
- `packages/web/src/components/chat/embeds/VideoEmbed.tsx` — Video embed (YouTube, Vimeo, direct)
- `packages/shared/src/types.ts` — `Embed`, `EmbedType`, `EmbedProvider` type definitions

---

## Type Definitions

```typescript
type EmbedType = 'generic' | 'video' | 'image' | 'audio' | 'rich';
type EmbedProvider = 'youtube' | 'vimeo' | 'spotify';

interface Embed {
  id: string;               // Snowflake
  messageId: string | null;   // FK -> messages.id (space messages)
  dmMessageId: string | null; // FK -> dm_messages.id (DMs)
  url: string;               // Original URL from message content
  embedType: EmbedType;
  provider: EmbedProvider | null;
  title: string | null;
  description: string | null;
  image: string | null;      // Thumbnail / og:image URL
  embedUrl: string | null;   // iframe-safe embed URL
  width: number | null;      // Image/thumbnail pixel width
  height: number | null;     // Image/thumbnail pixel height
  color: string | null;      // Reserved, always null currently
  createdAt: number;         // Epoch ms
}
```

DB schema: see `embeds` table in [database.md](database.md). Constraint: exactly one of `messageId`/`dmMessageId` is set.

---

## Pipeline Overview

```
Message created/edited
  -> extractUrls(content)         // regex, dedupe, limit 5
  -> for each URL:
       classifyUrl(url)           // extension match or provider detection
       fetchUrlMetadata(url)      // if needsMetadataFetch (SSRF-validated)
       probeRemoteImageDimensions // if image with unknown dimensions
       INSERT into embeds table
  -> broadcast embeds_resolved / dm_embeds_resolved via WebSocket
```

---

## 1. URL Extraction

`embedResolver.ts:extractUrls()`

**Regex:** `https?:\/\/[^\s<>"{}|\\^`[\]]+`

- Matches `http://` and `https://` URLs in message content
- Deduplicates while preserving order (first occurrence wins)
- **Limit:** 5 URLs per message (`MAX_EMBEDS_PER_MESSAGE = 5`)
- Returns empty array for null/empty content

---

## 2. URL Classification

`embedClassifier.ts:classifyUrl()`

Classification runs in two phases: extension matching (no URL parsing needed), then provider matching (requires valid `URL` object).

### Phase 1 — Direct Media Extensions

Regex-based, checked before URL parsing. These skip metadata fetch entirely.

| Pattern | EmbedType | Provider | needsMetadataFetch |
|---------|-----------|----------|--------------------|
| `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.avif` | `image` | null | false |
| `.mp3`, `.ogg`, `.wav`, `.flac`, `.opus` | `audio` | null | false |
| `.mp4`, `.webm`, `.mov` | `video` | null | false |

Extension matching is case-insensitive and tolerates query strings (`(\?.*)?$`).

### Phase 2 — Provider Matching

Requires successful `new URL()` parsing. Hostname normalized by stripping `www.` prefix.

#### YouTube

Hosts: `youtube.com`, `m.youtube.com`, `youtu.be`

Supported URL patterns via `extractYouTubeId()`:
| Pattern | Example |
|---------|---------|
| `/watch?v=ID` | `youtube.com/watch?v=dQw4w9WgXcQ` |
| `/shorts/ID` | `youtube.com/shorts/dQw4w9WgXcQ` |
| `/embed/ID` | `youtube.com/embed/dQw4w9WgXcQ` |
| `/v/ID` (legacy) | `youtube.com/v/dQw4w9WgXcQ` |
| Short link | `youtu.be/dQw4w9WgXcQ` |

Video ID regex: `[A-Za-z0-9_-]+`

Result: `embedType: 'video'`, `provider: 'youtube'`, `embedUrl: https://www.youtube-nocookie.com/embed/{videoId}`, `needsMetadataFetch: true`

Privacy: Uses `youtube-nocookie.com` domain for embed iframes.

#### Vimeo

Host: `vimeo.com`

Pattern: `vimeo.com/{numericId}` (regex: `/^\/(\d+)/`)

Result: `embedType: 'video'`, `provider: 'vimeo'`, `embedUrl: https://player.vimeo.com/video/{id}`, `needsMetadataFetch: true`

#### Spotify

Host: `open.spotify.com`

Pattern: `open.spotify.com/{type}/{id}` where type is `track`, `album`, or `playlist`, id is `[A-Za-z0-9]+`

Result: `embedType: 'rich'`, `provider: 'spotify'`, `embedUrl: https://open.spotify.com/embed/{type}/{id}`, `needsMetadataFetch: true`

#### Fallthrough

Any URL that does not match a provider: `embedType: 'generic'`, `provider: null`, `embedUrl: null`, `needsMetadataFetch: true`

Invalid URLs (fail `new URL()` parsing): same as fallthrough.

---

## 3. SSRF Protection

`ssrf.ts:validateExternalUrl()`

Called before every outbound fetch (metadata fetching and image dimension probing). Throws on any violation.

### Validation Steps

1. **URL parsing** — `new URL(url)` must succeed
2. **Scheme check** — only `http:` and `https:` allowed
3. **DNS resolution** — `dns.promises.lookup(hostname)` resolves hostname to IP
4. **Private IP check** — `isPrivateIp(address)` rejects internal addresses

### Blocked IP Ranges

`ssrf.ts:isPrivateIp()`

| Range | Description |
|-------|-------------|
| `127.*` | Loopback |
| `0.*`, `0.0.0.0` | Unspecified |
| `10.*` | Private class A |
| `192.168.*` | Private class C |
| `172.16.0.0/12` | Private class B (172.16–172.31, checked via integer parse of second octet) |
| `169.254.*` | Link-local |
| `::1` | IPv6 loopback |
| `fc*`, `fd*` | IPv6 unique local |
| `fe80*` | IPv6 link-local |

### Redirect Handling

Both `fetchUrlMetadata` and `probeRemoteImageDimensions` use `redirect: 'follow'` in their `fetch()` calls. SSRF validation is performed on the **original** URL before fetch, but the native `fetch` follows redirects without re-validating intermediate URLs. This means a redirect from a public IP to a private IP would not be caught by the current implementation.

---

## 4. Metadata Fetching

`metadataFetcher.ts:fetchUrlMetadata()`

### Flow

1. `validateExternalUrl(url)` — SSRF check, returns `null` on failure
2. `fetch(url)` with `User-Agent: BackspaceBot/1.0`, 5-second timeout via `AbortController`
3. **Content-Type detection** — if response is `image/*`, `video/*`, or `audio/*`, returns early with `contentType` field set (no HTML parsing)
4. **Size guard** — rejects responses with `Content-Length > 512KB`
5. **Stream-read with hard limit** — reads body via `ReadableStream`, stops at 512KB even for chunked (unknown-length) responses
6. **HTML parsing** via Cheerio

### Metadata Extraction

Parsed from HTML using Cheerio with the following priority:

| Field | Primary Source | Fallback |
|-------|---------------|----------|
| `title` | `og:title` | `<title>` element |
| `description` | `og:description` | `<meta name="description">` |
| `image` | `og:image` | none |
| `siteName` | `og:site_name` | none |
| `imageWidth` | `og:image:width` | none |
| `imageHeight` | `og:image:height` | none |

`imageWidth`/`imageHeight` are only included when they parse as finite positive integers.

### Return Type

```typescript
interface UrlMetadata {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  url: string;
  contentType?: string;     // Set only for direct media (image/video/audio)
  imageWidth?: number;      // From og:image:width (HTML pages only)
  imageHeight?: number;     // From og:image:height (HTML pages only)
}
```

---

## 5. Embed Resolution

`embedResolver.ts:resolveEmbeds()`

Main pipeline function. Iterates over extracted URLs, resolves each independently (one URL failure does not block others).

### Per-URL Resolution Logic

```
classify URL
  |
  |-- image (by extension)?
  |     -> set image = url, skip metadata fetch
  |
  |-- needsMetadataFetch?
  |     -> fetchUrlMetadata(url)
  |     -> if metadata.contentType is media -> override embedType, set image = url
  |     -> else -> extract title/description/image/dimensions from OG metadata
  |     -> if generic + no title -> skip URL (no embed created)
  |
  |-- YouTube provider?
  |     -> set fallback thumbnail: https://img.youtube.com/vi/{id}/hqdefault.jpg
  |     -> set fallback dimensions: 480x360
  |
  |-- image with unknown dimensions?
  |     -> probeRemoteImageDimensions(image)
  |
  -> INSERT embed row into DB
```

### Content-Type Override

When `fetchUrlMetadata` returns a `contentType` field (indicating the URL points directly to a media file rather than an HTML page), the classifier's `embedType` is overridden:

| Content-Type prefix | Override to |
|---------------------|-------------|
| `image/` | `image` (+ sets `image = url`) |
| `video/` | `video` |
| `audio/` | `audio` |

When Content-Type is detected as media, OG metadata fields (title, description, image) are ignored.

### YouTube Thumbnail Fallback

For YouTube URLs, before metadata fetch, a predictable thumbnail URL is pre-populated:
- URL: `https://img.youtube.com/vi/{videoId}/hqdefault.jpg`
- Dimensions: 480x360 (hardcoded, matches hqdefault.jpg)

If the metadata fetch returns an `og:image`, it does **not** override this fallback for `image` (the `||` operator means the pre-populated non-null value wins). However, OG dimensions would only populate `width`/`height` if they were still null (using `??`), so the hardcoded 480x360 persists.

### Generic Embed Skip Rule

If `effectiveEmbedType` remains `generic` after metadata fetch and no `title` was extracted, the URL is silently skipped — no embed row is created.

### DB Insertion

Each embed gets a unique Snowflake ID. The `messageId` / `dmMessageId` field is set based on the `isDm` flag. All inserts are synchronous (Drizzle `.run()`).

---

## 6. Image Dimension Probing

`embedResolver.ts:probeRemoteImageDimensions()`

Used for direct image URLs where dimensions are unknown (not provided by OG tags or provider defaults).

### Mechanism

1. **SSRF validation** — `validateExternalUrl(url)`, returns `null` on block
2. **Range request** — fetches first 32KB (`PROBE_BYTES = 32_768`) with header `Range: bytes=0-32767`
3. **Timeout** — 3-second abort (`PROBE_TIMEOUT_MS = 3_000`)
4. **Graceful body read** — reads up to `PROBE_BYTES` via `ReadableStream`, then aggressively cancels the connection via `reader.cancel()`
5. **Dimension extraction** — passes buffer to `sharp(buffer).metadata()`, returns `{width, height}` if both are positive integers

### Headers

```
User-Agent: BackspaceBot/1.0
Accept: image/*
Range: bytes=0-32767
```

### Response Handling

- Accepts HTTP `200` (server ignored Range) or `206` (partial content)
- Any other status returns `null`
- If the server returns more than 32KB (ignored Range header), only the first 32KB is read
- All failures (network, timeout, unrecognized format, SSRF) silently return `null`

---

## 7. WebSocket Events

### Broadcast Delivery

After all embeds for a message are resolved, a single event is broadcast:

| Context | Event Type | Delivery | Fields |
|---------|-----------|----------|--------|
| Space channel | `embeds_resolved` | `connectionManager.sendToChannel(spaceId, channelId, ...)` | `messageId`, `channelId`, `embeds[]` |
| DM | `dm_embeds_resolved` | `connectionManager.sendToDmMembers(channelId, ...)` | `messageId`, `dmChannelId`, `embeds[]` |

If no embeds were resolved (all URLs skipped or failed), no event is broadcast.

### Client-Side Handling

`useWebSocket.ts` handles both events by patching the message in `useChatStore`:
1. Finds the message array for the channel/DM
2. Maps over messages, replacing the `embeds` array for the matching `messageId`
3. For federated contexts (`!isHome`): resolves relative image URLs via `resolveAssetUrl(embed.image, origin)`

---

## 8. Edit Re-resolution

When a message is edited, embeds are re-resolved via a **delete-then-resolve** pattern (not using `reResolveEmbeds` — that function exists but is currently unused).

### Edit Flow (identical for REST and WebSocket handlers)

1. Update message content in DB
2. **Synchronous delete** — `DELETE FROM embeds WHERE messageId = ?` (or `dmMessageId`)
3. Broadcast `message_updated` / `dm_message_updated` with empty `embeds[]`
4. **Asynchronous re-resolve** — `setImmediate(() => resolveEmbeds(...).catch(() => {}))` runs the full pipeline
5. New embeds arrive via `embeds_resolved` / `dm_embeds_resolved` event

This two-phase approach ensures the edit broadcast is immediate (with stale embeds removed), while new embeds arrive shortly after via a separate event.

### Callsites

| Handler | File | Line |
|---------|------|------|
| REST `PATCH /api/messages/:id` | `routes/messages.ts` | Inline delete + `setImmediate(resolveEmbeds)` |
| WS `message_edit` | `ws/events.ts` | Inline delete + `setImmediate(resolveEmbeds)` |
| REST `PATCH /api/dm/messages/:id` | `routes/dm.ts` | Inline delete + `setImmediate(resolveEmbeds)` |
| WS `dm_message_edit` | `ws/events.ts` | Inline delete + `setImmediate(resolveEmbeds)` |

---

## 9. Batch Fetching

Two functions load embeds for message lists (used when fetching message history):

| Function | Filters by | Returns |
|----------|-----------|---------|
| `fetchEmbedsForMessages(messageIds[])` | `embeds.messageId IN (...)` | `Map<messageId, embedRow[]>` |
| `fetchDmEmbedsForMessages(dmMessageIds[])` | `embeds.dmMessageId IN (...)` | `Map<dmMessageId, embedRow[]>` |

`embedRowToEmbed()` converts a DB row to the shared `Embed` type (maps nulls, casts enum strings).

---

## 10. Client Rendering

`EmbedRenderer` dispatches by `embed.embedType`:

```
EmbedRenderer
  |-- 'video'   -> VideoEmbed
  |-- 'image'   -> ImageEmbed
  |-- 'audio'   -> inline <audio> element
  |-- 'rich'    -> RichEmbed
  |-- 'generic' -> GenericEmbed (default)
```

### VideoEmbed

Two modes based on whether a provider is present:

**Direct video** (`!provider && !embedUrl`):
- Renders `<video>` element with `controls`, `preload="none"`, 16:9 aspect ratio

**Provider iframe** (YouTube/Vimeo):
- Initial state: thumbnail image with play button overlay (glass-bubble style)
- On click: replaces with `<iframe>` loading `embedUrl?autoplay=1&origin={window.location.origin}`
- iframe permissions: `accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share`, `allowFullScreen`
- Footer shows capitalized provider name and linked title

### ImageEmbed

- When `embed.width && embed.height` are populated: wraps the `<img>` in a sized container with `style={{ aspectRatio: ${width}/${height}, maxWidth: Math.min(width, 400), maxHeight: 300 }}` (mirrors `AttachmentRenderer.tsx:81-100`). Eliminates layout shift on image load.
- When dimensions are null: no wrapper sizing, no fallback aspect-ratio. Inner `<img>` renders within `max-w-[400px]`, `max-h-[300px]`. The absent fallback is deliberate — see the *Dimension reservation contract* section below.
- Inner `<img>`: `object-contain`, `loading="lazy"`, `referrerPolicy="no-referrer"`.
- Image source: `embed.image ?? embed.url`.
- Click opens image preview lightbox via `useUIStore.openImagePreview()`.

### RichEmbed (Spotify)

Click-to-load pattern (no auto-loading of third-party iframes):

**Unloaded state** (default):
- Shows thumbnail, provider label, title, description, "Click to load" prompt
- Entire card is a `<button>` that triggers load

**Loaded state**:
- Renders `<iframe>` with `sandbox="allow-scripts allow-same-origin allow-popups"`
- iframe permissions: `autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture`

Height determination via `getIframeHeight()`:
1. `embed.height` if set
2. `PROVIDER_HEIGHTS[provider]` — currently only `spotify: 152`
3. Default: `200`

### GenericEmbed

- Returns `null` if no `embed.title` (no-op render)
- Shows provider name (from `embed.provider` or parsed hostname), linked title, description (3-line clamp)
- If `embed.image` exists: 80x80 thumbnail on the right side

### AudioEmbed (inline in EmbedRenderer)

- Shows linked title (if present) + native `<audio>` element with `controls`, `preload="metadata"`
- Max width 400px, left border accent

### Common Styling

All embed cards share:
- `max-w-[400px]` constraint
- `mt-2` top margin (spacing from message content)
- `bg-surface-channel` background (matte surface tier)
- `rounded-[4px]` or `rounded-lg` corners
- `referrerPolicy="no-referrer"` on all images

---

## Dimension reservation contract

Embed renderers and the embed resolver share a bidirectional contract to prevent layout shift in the message list when embeds load.

**Server side.** `resolveEmbeds` in `packages/server/src/utils/embedResolver.ts` MUST attempt to populate `embeds.width` and `embeds.height` for every `image`-type embed it produces. The two paths are:
- `og:image:width` / `og:image:height` extracted from HTML metadata when the URL points at an HTML page with an OG image (`metadataFetcher.ts`, then `embedResolver.ts:182-185`).
- `probeRemoteImageDimensions` for direct image URLs and for HTML pages whose Content-Type is `image/*` (`embedResolver.ts:196-202`). The probe sends a `Range: bytes=0-32767` request and reads dimensions from the partial buffer via `sharp(buffer).metadata()`.

YouTube uses hardcoded 480×360 for `hqdefault.jpg` (`embedResolver.ts:153-154`). Vimeo uses OG dimensions from the metadata fetch.

**Client side.** Every embed renderer whose output contains an image, iframe, or video MUST reserve dimensions when they are known. The reference pattern is `packages/web/src/components/chat/AttachmentRenderer.tsx:81-100` — wrap the media in a sized container with `style={{ aspectRatio: ${width}/${height}, maxWidth: ..., maxHeight: ... }}` (inline style, not Tailwind, because `maxWidth` is a runtime value).

When dimensions are not populated (probe failed, no OG tags, non-image type), the renderer must NOT apply a fallback `aspect-ratio` with a default ratio (e.g. 4/3). A fallback wrapper produces visible letterbox bars on content whose true ratio differs and was the cause of the revert in commit `0c84029`. Renderers without dimensions must use either a structurally fixed layout (iframe with hardcoded height, fixed-size thumbnail) or render unsized; the message list's `lastProgrammaticBottomScrollRef` sentinel and ResizeObserver/load defenses absorb residual shift. See `docs/systems/message-list.md` for the auto-scroll model.

**Why bidirectional.** If only the server populates dims but the client ignores them, the database fills with unused data and embeds shift on load (the symptom from 2026-04-24 onward). If only the client reserves but the server doesn't populate, every embed falls into the unreserved branch and the contract has no effect. Both halves are required.

---

## 11. Utility Endpoint

`GET /api/utils/metadata?url=` (auth required)

Exposes `fetchUrlMetadata()` directly as a REST endpoint. Returns the `UrlMetadata` object, or `{}` if fetch fails. This is independent of the embed pipeline and can be used for ad-hoc URL previews.

---

## Constants Summary

| Constant | Value | Location |
|----------|-------|----------|
| `MAX_EMBEDS_PER_MESSAGE` | 5 | `embedResolver.ts` |
| `PROBE_BYTES` | 32,768 (32KB) | `embedResolver.ts` |
| `PROBE_TIMEOUT_MS` | 3,000ms | `embedResolver.ts` |
| Metadata fetch timeout | 5,000ms | `metadataFetcher.ts` |
| HTML body size limit | 512,000 bytes (512KB) | `metadataFetcher.ts` |
| User-Agent | `BackspaceBot/1.0` | both fetchers |
| Spotify iframe height | 152px | `RichEmbed.tsx` |
| Default rich iframe height | 200px | `RichEmbed.tsx` |
| YouTube thumbnail dimensions | 480x360 | `embedResolver.ts` |
