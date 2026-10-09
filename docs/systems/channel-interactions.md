# Unread message badges

## Unread counts

`ready.unreadCounts` is an origin-scoped channel-to-message-count snapshot.
Only channels with VIEW_CHANNEL and READ_MESSAGE_HISTORY are counted. The query
counts existing messages with numeric snowflake IDs after the user's persisted
read cursor, excluding the user's own messages. Attachment-only messages count.

The host pushes `channel_unread_count` immediately after message creation /
deletion, channel changes, acknowledgement and mark-unread broadcasts on the same
ordered socket. Reconnect replaces that origin's snapshot. No client polling,
cache-length estimates or unread-channel counts are used.

Space badges sum visible unread channels, render 1–99 or 99+, and use gray instead of red when
the space is muted without clearing its underlying unread state. Older hosts keep
the existing unread dot; they cannot provide exact counts until upgraded.


## Direct-message badge

The top DM/logo icon displays the total unread message count (1–99, then 99+).
The host includes active, non-deleted DM conversations in the same ready snapshot
and updates counts after DM creation/deletion and read-cursor changes. Membership
is checked and own messages are excluded. The UI counts only each conversation's
canonical serving origin, not its federated mirrors. Read conversations and
unknown counts are excluded; exact DM counts require the host update.
