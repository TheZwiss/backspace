# Persistent channel pokes

Right-clicking a message author's avatar or name offers Poke. It is space-channel
scoped and requires the serving host's ready.supportsPoke capability. DMs and
unsupported hosts are disabled. Disconnection and host rejection are visible.

The host requires VIEW_CHANNEL and SEND_MESSAGES for the actor and VIEW_CHANNEL
for the target, resolves both names itself, and persists a system message before
broadcasting. The existing per-user WebSocket limiter applies across tabs.
Migration 0027 adds messages.type with user as the default. Both HTTP and WebSocket
edit paths reject system messages. Normal paginated history preserves their type.

The system row is passive: it does not create message alerts or reconnect unread
dots. A separate live event animates the target avatar only in the current channel
and origin. Recipient DND, notification suppression and reduced motion are
respected. Loading history does not animate or create a toast.

This PR adds no unread-count protocol, mention highlighting, member menus,
owner titles or notification-setting storage. It uses upstream notification policy.
