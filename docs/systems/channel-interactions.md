# Channel interactions and unread message badges

## Author menu

Right-clicking a message opens the original message menu (reply, copy, mark
unread, edit/delete according to permissions). Right-clicking an author's avatar
or name opens a separate menu containing only mention and poke actions.
A mention appends a stable
`<@userId>` token to the current channel draft and focuses the composer; the
composer displays the resolved name with mention highlighting.

## Poke

Space channel hosts advertise `ready.supportsPoke`. The authenticated
`channel_poke` event requires VIEW_CHANNEL and SEND_MESSAGES for the sender,
and VIEW_CHANNEL for the target. Names are resolved on the host, not accepted
from the client. The existing per-user gateway rate limit also applies.

Server-confirmed pokes also appear as centered, muted text in the message timeline,
stored as `messages.type = system` with a server timestamp and snowflake ID.
They load through normal paginated history after reload, with server-resolved name snapshots.
Migration 0021 adds the type column and defaults existing messages to user messages.
System messages are excluded from unread counts and reconnect unread detection. DND suppresses active cues, not these passive timeline entries.

Pokes do not produce floating toast notifications: the timeline entry is their
confirmation. Failed operations still show errors.
Only a server-confirmed broadcast produces the finger /
avatar animation; history loading never replays it. Pokes do not create unread counts, sounds, or OS
notifications. The current channel's viewers and the actor /
target see the cue. Recipient Do Not Disturb and space/channel suppression apply;
reduced-motion users receive text without animation. Rejections are visible.

This protocol is space-channel scoped. DM/S2S poke relay is not implemented;
the menu action is disabled in DMs and for hosts without the capability.

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


## Text submission

Enter consumes the live draft synchronously and uses the existing optimistic
message display instead of waiting for the HTTP response. Repeated Enter on the
now-empty composer does not send again. Completion does not clear newer typing.
Request failures roll back the optimistic message, show an error, and return the
failed text to its original channel draft without discarding newer text.

## Direct-message badge

The top DM/logo icon displays the total unread message count (1–99, then 99+).
The host includes active, non-deleted DM conversations in the same ready snapshot
and updates counts after DM creation/deletion and read-cursor changes. Membership
is checked and own messages are excluded. The UI counts only each conversation's
canonical serving origin, not its federated mirrors. Read conversations and
unknown counts are excluded; exact DM counts require the host update.
