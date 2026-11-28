# Bookmarks

A user's personal list of saved messages. A bookmark is a **copy of the message's text and metadata plus the ids needed to open the original**. It is private to its owner, lives on the instance that serves the message, and is never relayed.

Source files:
- `packages/server/src/db/schema.ts` -- `messageBookmarks`, `bookmarkAttachments`
- `packages/server/drizzle/0032_message_bookmarks.sql` -- the migration
- `packages/server/src/utils/bookmarks.ts` -- create, list, delete, status resolution, `snapshotBookmarkAttachments`, `deleteBookmarkFiles`, `purgeUserBookmarks`
- `packages/server/src/routes/bookmarks.ts` -- the REST routes
- `packages/server/src/utils/userDeletion.ts` -- `tombstoneUser` purges a user's bookmarks
- `packages/server/src/utils/storageJanitor.ts` -- `getReferencedFilenames()` counts files a bookmark owns
- `packages/shared/src/bookmarks.ts` -- wire types and page limits
- `packages/web/src/stores/bookmarkStore.ts`, `packages/web/src/hooks/useBookmarks.ts`, `packages/web/src/components/ui/BookmarkIcon.tsx` -- client state and the message button
- `packages/web/src/stores/jumpStore.ts`, `packages/web/src/hooks/useJumpNavigation.ts` -- opening a bookmark's conversation at its message (message-list.md, "Jump to message")

DB tables: `message_bookmarks`, `bookmark_attachments`. See [database.md](database.md). Routes: [api.md](api.md).

---

## Model

- **A copy plus a link.** The row freezes the text, the author's name, the space and channel names, the instance origin and the message's time as they were when it was saved. `message_id`, `channel_id` and `space_id` are the original's ids on `instance_origin`; they are what opens it. Editing or deleting the original never changes the copy.
- **Plain ids, no foreign keys to messages.** `messages` and `dm_messages` are two tables, and a bookmark has to outlive its original so it can say the original is gone.
- **Local to the serving instance.** A bookmark of a channel message lives on the instance the channel belongs to; a bookmark of a DM lives on the instance the client has that DM pinned to (`getChannelOrigin`). No relay event, no wire change, no federation work. `user_id` is the caller's row id on that instance, so a federated account has its own bookmarks per instance.
- **One per message per user.** `UNIQUE (user_id, kind, message_id)`. Saving a message again returns the same bookmark.
- **No limit on the number of bookmarks.** Every read is paged or scoped to one conversation, and every bulk delete uses a subquery instead of an id list (SQLite's bound-variable cap).

## Creating

`createBookmark(userId, kind, messageId)`:

1. Load the original (`messages` joined to `channels`, or `dm_messages`).
2. The caller must be able to read it now: `VIEW_CHANNEL | READ_MESSAGE_HISTORY` in the channel (the same rule as `GET /api/channels/:id/messages`), or membership of the DM. A message the caller cannot read is answered `404 message_not_found`, the same as one that does not exist, so the route cannot be used to probe for ids.
3. A system message (`type = 'system'`) is refused with `400 validation_failed`.
4. In one transaction: return the existing bookmark if there is one (`200`), else insert the row and its `bookmark_attachments` (`201`).

Names saved: the author's `displayName`, else `username` (`Deleted User` for a tombstoned account); the space and channel names; for a DM the group name, else the other members' names joined with a comma.

## Status of the original

Never stored. `resolveBookmarks()` works it out on every read, with one batched lookup per table for the page:

| Status | Meaning |
|--------|---------|
| `ok` | The original exists and its text equals the saved copy |
| `edited` | The original exists and its text differs (`null` and `''` count as equal) |
| `deleted` | No such message: the message, its channel or its space was removed |
| `unavailable` | The original exists but the reader can no longer see it (left the space or DM, lost the permission). The saved copy is the reader's own and stays readable |

## Attachments and files

**Files are not copied yet.** `snapshotBookmarkAttachments()` is the one place that decides what a bookmark keeps of a file. Today it stores the metadata (name, type, size, dimensions, duration, playability) and the name of the original's file (`source_filename`, `source_thumbnail_filename`), with `copy_status = 'reference'` and `filename` / `thumbnail_filename` NULL. A bookmark costs no disk and creating one does no file I/O. `/api/uploads/:filename` is public (the snowflake name is the capability, see [uploads.md](uploads.md)), so keeping the name grants nothing the user did not already have.

Per attachment, computed on read by checking the file in `UPLOAD_DIR`: `state: 'available'` (the file is there; `filename` and `thumbnailFilename` name it) or `state: 'gone'` (the original was deleted with its message; the metadata is still returned and `filename` is null). A bookmark's own copy is used first when it has one (`copy_status = 'copied'`).

**Keeping copies later** changes `snapshotBookmarkAttachments` (copy the file and its thumbnail to new snowflake names, fill `filename` / `thumbnail_filename`, set `'copied'`) and adds a one-off pass over existing `'reference'` rows whose source still exists. No schema change, no change to the API shape. A file deleted with its original message before that switch cannot be recovered: those bookmarks keep only the metadata.

**Lifecycle (already in place for copies):**
- Removing a bookmark deletes its rows and, after the transaction commits, its own copy files (`deleteBookmarkFiles`). It never deletes `source_*`: those belong to the original message.
- `getReferencedFilenames()` includes `bookmark_attachments.filename` and `thumbnail_filename`, so the storage janitor does not treat a copy as an orphan.
- `tombstoneUser` calls `purgeUserBookmarks()` in its transaction (the `users` row stays, so the foreign-key cascade never fires) and adds the copy files to the list it returns for deletion.
- Safety net: a row removed by any other path leaves files no row references, which the janitor's orphan phase deletes.

## Listing

`GET /api/bookmarks` is keyset-paged newest first on `(created_at, id)`, both descending, backed by `idx_message_bookmarks_user_created`. The cursor is `<created_at>:<id>`; a value this server did not issue is `400 validation_failed`. `limit` defaults to 30 (`BOOKMARKS_PAGE_DEFAULT`) and is at most 100 (`BOOKMARKS_PAGE_MAX`).

`GET /api/bookmarks/keys?kind=&channelId=` returns the bookmarked message ids of one channel or DM (`idx_message_bookmarks_user_channel`), for the "is bookmarked" state of an open conversation. It is bounded by the conversation, not by the user's total.

## Client state

`bookmarkStore` is keyed by origin, because ids are issued per instance. It holds two things and never the user's whole list, since there is no limit:

- **`keys`**: the bookmarked messages of the conversations the user has opened, as `origin / kind / messageId`. `MessageList` mounts `useBookmarkedConversation`, which reads `GET /api/bookmarks/keys` from the instance that serves the conversation once per conversation (`origin` is `channelOriginMap`, `kind` is `isDmChannel`). Changes that arrive while that read is in flight are laid over its answer, so a push is never lost to a stale read.
- **`lists`**: the window's list per origin, newest first, one page at a time (`loadList`, `loadMore`). A failed instance is marked `error` and does not hide the others. An instance that answers 404 runs a version without bookmarks: it is shown as empty, not as failed, and its conversations are not asked again.

The sources are the user's own `add` / `remove` answers and `bookmark_added` / `bookmark_removed` from that instance's socket (`useWebSocket` files them under the origin of the socket that delivered them). When an instance's socket reports `ready` again, `resync(origin)` forgets what was read from it, because events sent while it was down were missed; the open conversation reads again by itself. `forgetOrigin` (an instance removed) and `reset` (sign-out) drop the rest, and `reset` also drops answers still in flight.

A message shows the bookmark button in its hover bar and an entry in its menu (`useMessageBookmark`): highlighted when saved, and a click on it removes the bookmark. Not offered for a message not sent yet, a system message (the server refuses it) or a channel whose instance is not known. A failed request is a toast with the server's reason (`describeError`); a second click while one is in flight is ignored.

## The window

Desktop: a bookmark button in the chat top bar, to the left of the downloads indicator (`BookmarksButton`), opens `BookmarksModal` (`activeModal: 'bookmarks'`). Mobile: a "Bookmarks" row on the You screen pushes the `bookmarks` screen (`MobileBookmarksScreen`). Both render `BookmarkList`.

`BookmarkList` reads the page's own instance (`''`) and every connected instance (`loadList`), merges the pages and orders them by when they were saved, newest first. "Show more" reads the next page of each instance that has one; an instance that cannot be read is left out without a message (the store logs it), and opening the window reads again.

A row (`BookmarkRow`) shows the author, the instance host, space and channel, the date and time of the original, the saved text and its attachments by name and size (metadata only: a file whose original was deleted is marked "file deleted"). The author is drawn live: `useBookmarkAuthors` indexes the `userViews` cache by the issuing origin and the row id, so a changed avatar or name shows without a reload; an author the cache has not seen gets the saved name and initials. A status badge appears for `edited`, `deleted` and `unavailable` originals, with the saved copy kept.

Clicking a row calls `jumpStore.requestJump` (a space channel by space and channel, a DM by channel), so the exact conversation opens at that message, edited or not; a deleted original opens its conversation and the list shows its own "message unavailable" notice. The window closes when the jump was accepted. The highlighted bookmark icon on a row removes the bookmark (`bookmarkStore.remove`; a failure is a toast).

## Events

A created bookmark is announced as `bookmark_added` and a removed one as `bookmark_removed`, to the caller's own sockets on this instance only, so a second tab or device stays in step. Nothing is relayed. A repeated create or a removal that found nothing sends no event. See websocket.md.

## Limitations

- After DM origin failover (client-federation.md, "DM Origin Failover") a DM bookmark stays on the old instance.
- A bookmark of a deleted original can show only the saved copy: nothing about the original is read once it is gone.
- Migration `0032_message_bookmarks` is numbered and timestamped for the branch it was written on. Drizzle applies only migrations whose journal `when` is newer than the newest one already applied, so on a database that another branch has migrated further (for example one with `0032_bots` to `0040`) it is skipped without an error and every bookmark route answers 500 `no such table: message_bookmarks`. When merging with such a branch, renumber it after the last migration and give it a later `when`. A database already past it needs the SQL applied once by hand.
