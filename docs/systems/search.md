# Search System

Source files:
- `packages/server/src/routes/search.ts` — Server-side search endpoints (channel search, DM search, messages-around)
- `packages/web/src/components/chat/SearchPopover.tsx` — Client-side search UI (filter bar, result rendering, jump-to-message)
- `packages/web/src/api/client.ts` — API client `search` namespace and `messagesAround` methods
- `packages/web/src/stores/chatStore.ts` — `loadMessagesAround()` store action
- `packages/web/src/components/chat/MessageList.tsx` — Jump-to-message scroll + highlight logic
- `packages/web/src/components/layout/MainContent.tsx` — Search button + popover wiring
- `packages/web/src/styles/globals.css` — `.search-highlight` animation

---

## Endpoints

Four endpoints, all requiring JWT authentication (`preHandler: authenticate`).

| Endpoint | Auth Check | Response Shape |
|----------|-----------|----------------|
| `GET /api/channels/:id/search` | `VIEW_CHANNEL + READ_MESSAGE_HISTORY` via `hasPermission()` | `{ results: MessageWithUser[], totalCount: number }` |
| `GET /api/dm/:id/search` | `isDmMember()` | `{ results: DmMessageWithUser[], totalCount: number }` |
| `GET /api/channels/:id/messages/around` | `VIEW_CHANNEL + READ_MESSAGE_HISTORY` via `hasPermission()` | `MessageWithUser[]` (flat array) |
| `GET /api/dm/:id/messages/around` | `isDmMember()` | `DmMessageWithUser[]` (flat array) |

For full endpoint signatures, see [api.md](api.md) under "Search".

---

## Filter Syntax

All filters are query string parameters on the search endpoints.

| Parameter | Type | Description | SQL Behavior |
|-----------|------|-------------|-------------|
| `q` | string | Text query (trimmed) | `LIKE '%{q}%'` on `content` column — case-insensitive in SQLite by default for ASCII |
| `from` | string | Username filter | Exact `LIKE` match on `users.username` (not partial — no wildcards added). If no user found, returns empty results immediately (not 404). |
| `has` | `file` \| `image` \| `link` | Attachment/content filter | See "has: filter" section below |
| `before` | string | ISO 8601 date | `createdAt < new Date(before).getTime()` — parsed via `new Date()`, invalid dates silently ignored |
| `after` | string | ISO 8601 date | `createdAt > new Date(after).getTime()` — parsed via `new Date()`, invalid dates silently ignored |
| `offset` | number | Pagination offset | `Math.max(Number(offset) \|\| 0, 0)` — floored to 0 |
| `limit` | number | Page size | Clamped: `Math.min(Math.max(Number(limit) \|\| 25, 1), 50)` — default 25, max 50 |

### has: Filter Implementation

The `has` filter uses two different mechanisms depending on the value:

| Value | Mechanism | SQL |
|-------|-----------|-----|
| `file` | `EXISTS` subquery on `attachments` table | `EXISTS (SELECT 1 FROM attachments WHERE attachments.message_id = messages.id)` |
| `image` | `EXISTS` subquery with mimetype filter | `EXISTS (SELECT 1 FROM attachments WHERE attachments.message_id = messages.id AND attachments.mimetype LIKE 'image/%')` |
| `link` | LIKE on content column | `content LIKE '%http%'` — appended to the WHERE conditions (not a subquery) |

For DM search, the subquery joins on `attachments.dm_message_id = dm_messages.id` instead.

**Important:** The `has: file`/`has: image` filter uses a raw SQL `EXISTS` subquery (`hasFilter`) that is combined with the main `whereClause` using `and()`. This filter is applied separately from the main conditions array because Drizzle ORM conditions and raw SQL fragments are combined at query time.

---

## Pagination

- **Offset-based:** Uses `offset` + `limit` query params
- **Default page size:** 25
- **Max page size:** 50
- **Total count:** Returned as `totalCount` in every search response (separate COUNT query)
- **Sort order:** Results ordered by `createdAt DESC` (newest first)

---

## Result Hydration

Both search endpoints follow the same hydration pipeline after fetching raw message rows:

```
1. Fetch message rows (filtered, paginated)
2. Batch-fetch users         → userMap (userId → user)
3. Batch-fetch attachments   → attachmentMap (messageId → attachments[])
4. Batch-fetch reactions     → fetchReactionsForMessages() / fetchDmReactionsForMessages()
5. Batch-fetch embeds        → fetchEmbedsForMessages() / fetchDmEmbedsForMessages()
6. Batch-fetch reply parents → fetchReplyToMessages() / inline DM reply fetch
7. Assemble via buildMessageWithUser() / buildDmMessageWithUser()
8. Filter out messages with missing users (null check)
```

### Channel Search Hydration

- **Users:** Batch `SELECT` from `users` with `inArray(users.id, userIds)`
- **Attachments:** Batch `SELECT` from `attachments` with `inArray(attachments.messageId, messageIds)`
- **Reactions:** `fetchReactionsForMessages(messageIds)` — from `routes/messages.ts`
- **Embeds:** `fetchEmbedsForMessages(messageIds)` — from `utils/embedResolver.ts`
- **Replies:** `fetchReplyToMessages(messageRows)` — from `routes/messages.ts`
- **Assembly:** `buildMessageWithUser()` — from `routes/messages.ts`

### DM Search Hydration

- **Users:** Same batch pattern
- **Attachments:** Batch `SELECT` from `attachments` with `inArray(attachments.dmMessageId, messageIds)`
- **Reactions:** `fetchDmReactionsForMessages(messageIds)` — from `routes/dm.ts`
- **Embeds:** `fetchDmEmbedsForMessages(messageIds)` — from `utils/embedResolver.ts`
- **Replies:** Inline implementation — fetches `dmMessages` by `replyToId`, builds minimal `DmMessageWithUser` (with empty `attachments`, `embeds`, `reactions` arrays)
- **Assembly:** `buildDmMessageWithUser()` — from `routes/dm.ts`

### Response Types

Both types are defined in `packages/shared/src/types.ts`. See database.md for underlying table schemas.

**`MessageWithUser`** extends `Message` with: `user: User`, `attachments: Attachment[]`, `embeds: Embed[]`, `reactions: Reaction[]`, `replyTo?: MessageWithUser | null`

**`DmMessageWithUser`** extends `DmMessage` with: `user: User`, `attachments: Attachment[]`, `embeds: Embed[]`, `reactions: Reaction[]`, `replyTo?: DmMessageWithUser | null`

---

## Messages-Around Endpoint

Used for jump-to-message navigation (from search results and deep links). Loads a window of messages centered on a target message.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `messageId` | string | Yes | Target message ID (returns 400 if missing) |
| `limit` | number | No | Window size, default 50, max 100, clamped to `[1, 100]` |

### Algorithm

```
1. Validate target message exists in the channel (404 if not found)
2. half = floor(limit / 2)
3. Fetch "before" rows: messages with id <= messageId, ordered DESC, limit half+1 (includes target)
4. Fetch "after" rows:  messages with id > messageId, ordered ASC, limit half
5. Reverse beforeRows to chronological order
6. Concatenate: [...beforeRows, ...afterRows]
7. Deduplicate by id (target may appear in both sets)
8. Hydrate with same pipeline as search results
9. Return flat MessageWithUser[] / DmMessageWithUser[] array
```

**Note:** The "before" query uses `id <= messageId` (not timestamp-based), and the "after" query uses `id > messageId`. This means the pivot is on Snowflake ID ordering, not `createdAt`. The `ORDER BY` clause still uses `createdAt`, which works because Snowflake IDs are monotonically increasing and correlate with creation time.

### Channel vs DM Differences

- Channel: Checks `getChannelSpaceId()` + `hasPermission()` with `VIEW_CHANNEL | READ_MESSAGE_HISTORY`
- DM: Checks `isDmMember()`
- Channel: Queries `messages` table, uses `fetchReactionsForMessages`, `fetchEmbedsForMessages`, `fetchReplyToMessages`
- DM: Queries `dm_messages` table, uses `fetchDmReactionsForMessages`, `fetchDmEmbedsForMessages`, inline reply fetch

---

## Client-Side: SearchPopover

`packages/web/src/components/chat/SearchPopover.tsx`

### Component Props

```typescript
interface SearchPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  channelId: string;
  isDm: boolean;
  onJumpToMessage: (messageId: string) => void;
}
```

### State

| State Variable | Type | Purpose |
|---------------|------|---------|
| `query` | string | Text search input |
| `fromFilter` | string | Username filter input |
| `hasFilter` | string | `''` \| `'file'` \| `'image'` \| `'link'` — select dropdown |
| `beforeFilter` | string | Date string from `<input type="date">` |
| `afterFilter` | string | Date string from `<input type="date">` |
| `showFilters` | boolean | Filter panel visibility toggle |
| `results` | `AnyMessage[]` | Accumulated search results (`MessageWithUser \| DmMessageWithUser`) |
| `totalCount` | number | Total matching results (from server) |
| `isSearching` | boolean | Loading state |
| `offset` | number | Current pagination offset |

### Behavior

1. **Reset on open/channel change:** All state resets when `open` or `channelId` changes
2. **Debounced search:** 300ms debounce on any query/filter change, calls `doSearch(0)`
3. **Empty guard:** Search requires at least one of: `query`, `fromFilter`, `hasFilter`, `beforeFilter`, `afterFilter` — otherwise clears results
4. **Pagination:** "Load more" button appends next page. Offset tracked as `searchOffset + data.results.length`
5. **Federation-aware:** Uses `getChannelOrigin(channelId)` and `getApiForOrigin(origin)` to route API calls to the correct instance
6. **Dismiss:** Click-outside (`mousedown` listener) or Escape key closes the popover
7. **Auto-focus:** Input focused 50ms after popover opens

### API Call Flow

```
SearchPopover.doSearch(offset)
  → getChannelOrigin(channelId)       // resolve federation origin
  → getApiForOrigin(origin)           // get API client for that origin
  → isDm ? client.search.dm(channelId, params)
         : client.search.channel(channelId, params)
  → params: { q, from, has, before, after, offset, limit: 25 }
```

The client always sends `limit: 25` (hardcoded in SearchPopover).

### UI Layout

- **Container:** 420px wide, max 500px tall, `glass` material, positioned via `useFloatingPosition` (bottom placement, 8px offset)
- **Search input:** `input-embedded` tier with search icon and clear button
- **Filter toggle:** Collapsed by default, shows active-filter indicator dot when any filter is set
- **Filter panel:** 2-column grid — `From` (text), `Has` (select), `Before` (date), `After` (date) — all `input-search` tier
- **Results list:** Scrollable area with result count header
- **Result items:** Avatar + display name + timestamp + content snippet (2-line clamp) + attachment count
- **Query highlighting:** `highlightMatch()` wraps matches in `<mark>` tags with `bg-accent-primary/30` styling
- **Load more:** Shows remaining count, disabled while loading

### Result Rendering

Each result shows:
- User avatar (via `<Avatar>` component)
- Display name (falls back to username, then "Unknown")
- Timestamp via `formatTime()`: "Today at HH:MM", "Yesterday at HH:MM", or "MM/DD/YYYY HH:MM"
- Content with query term highlighting (case-insensitive regex split)
- Attachment count badge (paperclip icon) if `msg.attachments.length > 0`

---

## Client-Side: Jump-to-Message

The jump-to-message flow spans three components.

### Flow

```
1. User clicks search result in SearchPopover
     → onJumpToMessage(messageId) callback fires
     → MainContent: setJumpToMessageId(id), setSearchOpen(false)

2. MessageList receives jumpToMessageId prop
     → Check if message element exists in DOM: document.getElementById(`msg-${jumpToMessageId}`)
     → If found: scroll + highlight immediately
     → If not found: call loadMessagesAround(channelId, messageId)
         → chatStore.loadMessagesAround() replaces the channel's message cache entirely
         → After React render (double requestAnimationFrame), scroll + highlight

3. Scroll + Highlight:
     → el.scrollIntoView({ behavior: 'smooth', block: 'center' })
     → el.classList.add('search-highlight')
     → setTimeout 2000ms → el.classList.remove('search-highlight')
     → onJumpComplete() → resets jumpToMessageId to null
```

### loadMessagesAround (chatStore)

`search.ts:chatStore.loadMessagesAround(channelId, messageId)`:

- Routes to `client.channels.messagesAround()` or `client.dm.messagesAround()` based on `isDmChannel()`
- Normalizes remote asset URLs for federated channels
- **Replaces** the entire message cache for that channel (not append/prepend)
- Sets `hasMore` to `true` (enables upward scroll loading from the new position)
- Updates `channelAccessTimes`

### search-highlight CSS

Defined in `globals.css`:

```css
@keyframes search-flash {
  0% { background-color: rgba(124, 108, 246, 0.2); }
  100% { background-color: transparent; }
}
.search-highlight { animation: search-flash 2s ease-out; }
```

Purple flash (accent color at 20% opacity) that fades to transparent over 2 seconds.

---

## Known Limitations

1. **SQL LIKE for text search:** Uses `LIKE '%query%'` — no full-text indexing (FTS5), no relevance ranking, no word boundary matching. Performance degrades linearly with message count.
2. **from: filter is exact match:** Uses `LIKE` without wildcards on username, but SQLite LIKE is case-insensitive for ASCII by default. Does not search display names.
3. **has:link is content-based:** Searches for `'%http%'` in message content — does not check the `embeds` table. May miss non-HTTP links or match false positives (e.g., a message containing the word "http" in prose).
4. **No cross-channel search:** Each search is scoped to a single channel or DM. There is no global/space-wide search endpoint.
5. **DM reply hydration is minimal:** Reply-to messages in DM search results have empty `attachments`, `embeds`, and `reactions` arrays (unlike channel search which uses `fetchReplyToMessages` with full attachment hydration).
6. **Offset pagination:** Uses offset/limit (not cursor-based). Large offsets may have performance implications on big result sets since SQLite must scan and skip rows.
