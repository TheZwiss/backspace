# WebSocket Protocol Reference

Endpoint: `GET /ws` (upgrade to WebSocket)
Transport: JSON messages over WebSocket
Source: `packages/server/src/ws/handler.ts`, `packages/server/src/ws/events.ts`

---

## Auth Flow

1. Client connects to `/ws`
2. Client sends `{ type: 'auth', token: '<jwt>', client?: 'web' | 'desktop' | 'mobile' }` within 10 seconds. `client` is optional; a missing or unrecognised value is read as `web`. The wire type is the `auth` variant of `ClientEvent` in `packages/shared/src/types.ts`, where the field is typed `ClientKind`
3. Server validates token (rejects deleted users, tokens issued before `passwordChangedAt`). A bot account holds one open socket per credential: a second one is answered `error` with `code: 'bot_token_in_use'` and closed with code 4409 ([bots.md](bots.md), "One process per token")
4. Server responds with `ready` event containing full client state
5. Server sets the user's live status to their chosen status (`users.chosen_status` for an account that owns its choice, native or detached; for a replicated user the home instance's last projection, or `online` if there is none) and carries it in the `ready` payload's `user.status`, broadcasts `presence_update` to friends + DM co-members + space co-members (via `collectProfileBroadcastTargetIds`); for native users, also queues a S2S `presence_update` relay to all active peers
6. Heartbeat: server pings every 30s (RFC 6455 ping frames), dead connections detected after ~65s
7. Activity: the auth message writes `users.last_client` (from `client`) and `users.last_active_day`; the first heartbeat pong of each UTC day per connection writes `users.last_active_day` alone, so a client left open for days keeps the day current. Both are day precision (UTC `YYYY-MM-DD`) and the write is skipped once the stored day already equals today, so a user's row is touched at most once per day

---

## Client → Server

### Messages
| type | fields | notes |
|------|--------|-------|
| `message_create` | channelId, content, replyToId? | SEND_MESSAGES perm; MENTION_EVERYONE for content with `@everyone`, `@here` or a role token (permissions.md, "Mass mentions"); `replyToId` must name a message a member wrote in the same channel |
| `message_edit` | messageId, content | author only; MENTION_EVERYONE when the edit adds a mass mention the message did not have; a system message cannot be edited (`error` with `system_message_immutable`) |
| `message_delete` | messageId | author or MANAGE_MESSAGES |
| `channel_poke` | channelId, targetUserId | VIEW_CHANNEL and SEND_MESSAGES; 5 a minute per actor. See "Channel pokes" |
| `typing_start` | channelId | 5s auto-expire |

### DM Messages
| type | fields | notes |
|------|--------|-------|
| `dm_message_create` | dmChannelId, content?, attachments?, replyToId? | member; `replyToId` must name a message in the same DM channel; 5 per 5 seconds per client address, as `POST /api/dm/:id/messages` (`rate_limited`) |
| `dm_message_edit` | messageId, content | member, author only; a system message cannot be edited |
| `dm_message_delete` | messageId | member, author only |
| `dm_typing_start` | dmChannelId | 5s auto-expire |

`dm_message_create` first counts against its rate limit: the REST route's numbers (`utils/dmMessageRateLimit.ts`), keyed on the address the socket connected from (`request.ip` of the upgrade, recorded in `ws/socketAddress.ts`, so it follows `TRUSTED_PROXY_HOPS` as the HTTP limiter does), in a counter of its own. `DISABLE_RATE_LIMITS` switches it off. The three DM message events run the REST routes' checks (`utils/dmMessageRules.ts`), so they refuse what the routes refuse, in the same order and with the same codes (dm-system.md, "Message Operations"), `recipient_deleted` in a 1-on-1 whose partner was deleted included. A missing `dmChannelId` or `messageId` is `validation_failed`. Each refusal is an `error` with its code, and `details` where the code has placeholders, sent to the socket that sent the event and not to the user's other sessions (they did not act, and the client shows a coded error as a toast); nothing is stored, broadcast or relayed. The web client sends these actions over REST, not over these events.

### Reactions (space + DM, auto-detected)
| type | fields | notes |
|------|--------|-------|
| `reaction_add` | messageId, emoji | ADD_REACTIONS perm (space). `emoji` is a native emoji or a sticker token (`sticker:<asset URL>`, uploads.md "Personal stickers"); the server stores and relays either as the same string. One reaction per user and emoji: a repeat stores nothing, sends no `reaction_added` and queues no relay. The client does not send one either (`chatStore.addReaction` skips a reaction the user holds or has an add in flight for) |
| `reaction_remove` | messageId, emoji | own reactions only |

### Read State
| type | fields | notes |
|------|--------|-------|
| `channel_ack` | channelId, messageId | mark read up to message |
| `mark_unread` | channelId, messageId | `'0'` to clear all |

### Presence & Activity
| type | fields | notes |
|------|--------|-------|
| `presence_update` | status: online/idle/dnd | stored as the user's chosen status and published while connected; same path as `PATCH /api/users/@me { status }` (activity-presence.md "DB Persistence") |
| `activity_update` | activities: Activity[] | rate-limited 3s, respects showActivity |

### Voice (Space Channels)
| type | fields | notes |
|------|--------|-------|
| `voice_join` | channelId | one room per user enforced |
| `voice_leave` | (none) | leaves the voice the user holds on this instance: a voice channel or DM call hosted here, or a call hosted on a peer that they joined through here (relayed to the host as their leave in a group call). A client joining voice on another instance sends it to the instance its DM call goes through (voice.md, "Client-Side Call Routing") |
| `voice_status` | isMuted, isDeafened, isCameraOn, isScreenSharing | server enforces space/permission mute |

### Voice Moderation
| type | fields | permission |
|------|--------|------------|
| `voice_space_mute` | userId, muted, channelId? | MUTE_MEMBERS |
| `voice_space_deafen` | userId, deafened, channelId? | DEAFEN_MEMBERS |
| `voice_move` | userId, targetChannelId | MOVE_MEMBERS |
| `voice_disconnect` | userId, channelId? | DISCONNECT_MEMBERS |

`channelId` names one seat of a bot (`bot_voice_join`): mute, deafen and disconnect then act on that channel's seat only, with the bit checked in that channel (bots.md, 5c). Without it, or for a person, they act on the target's one voice room as before.

All four also need the actor to outrank the target (permissions.md, "Role hierarchy"); a refusal is an `error` with `code: 'role_hierarchy'`.

### DM Calls
| type | fields | notes |
|------|--------|-------|
| `dm_call_start` | dmChannelId | 60s auto-timeout if not accepted. In a DM whose call is hosted here, a member not in it joins it (handled as `dm_call_accept`). A member already in it, or any member while the DM's call hosted on another instance still rings or has a member here in it, gets `error` with `code: 'dm_call_in_progress'` and the `dmChannelId`, on the sending socket only (a record of such a call with nobody here in it is dropped and the start goes on); a non-member gets `code: 'not_dm_member'`, a missing `dmChannelId` `code: 'validation_failed'` |
| `dm_call_accept` | dmChannelId?, federatedCallId? | ringing→active; later accepts join the active call (late join). Refused on the sending socket only with `error` and a code: `dm_call_not_found` (no call any more), `not_dm_member`, `validation_failed`, with the id the client sent as `dmChannelId` |
| `dm_call_reject` | dmChannelId?, federatedCallId? | 1-on-1: ends the call. Group: stops only the sender's ring; ends the call only when it still rings and every member but the caller has declined. Ignored from the caller or a participant |
| `dm_call_end` | dmChannelId?, federatedCallId? | 1-on-1: ends the call. Group: takes only the sender out; the caller of a call nobody joined ends it; the call ends with its last participant. Ignored from a member who is not in the call |

### System
| type | fields |
|------|--------|
| `auth` | token |
| `ping` | — (gets `pong`) |

---

## Server → Client

### System
| type | fields | scope |
|------|--------|-------|
| `ready` | (see Ready Payload below) | user |
| `pong` | — | user |
| `error` | message, code?, details?, dmChannelId? | user; `details` fills the code's placeholders, as in an HTTP error body (`content_too_long` carries `max`); a refused `dm_call_start` or `dm_call_accept` goes to the sending socket only and names its `dmChannelId`; a refused `dm_message_create`, `dm_message_edit`, `dm_message_delete` or `channel_poke` goes to the sending socket only |

### Messages
| type | fields | scope |
|------|--------|-------|
| `message_created` | message: MessageWithUser | channel (VIEW_CHANNEL). The message carries `mentionEveryone` and `mentionRoleIds`, the mass mentions the space allowed (permissions.md, "Mass mentions"); clients alert on mass mentions from these alone |
| `message_updated` | message: MessageWithUser | channel (VIEW_CHANNEL) |
| `message_deleted` | messageId, channelId | channel (VIEW_CHANNEL) |
| `typing` | channelId, userId, username | channel (VIEW_CHANNEL, excludes sender) |
| `reaction_added` | messageId, reaction (includes user) | channel (VIEW_CHANNEL) |
| `reaction_removed` | messageId, userId, emoji | channel (VIEW_CHANNEL) |
| `embeds_resolved` | messageId, channelId, embeds[] | channel (VIEW_CHANNEL) |
| `channel_poke` | message: MessageWithUser (`type: 'system'`) | channel (VIEW_CHANNEL); see "Channel pokes" |

In a space channel every event above is emitted with
`connectionManager.sendToChannel`, from the REST route and from the WebSocket
handler alike, so both paths reach the same audience. (`reaction_added` and
`reaction_removed` are reused on the DM path, where they go out with
`sendToDmMembers`.) See permissions.md, "Broadcast audience".

#### Channel pokes

A member pokes another member in a space channel: the web client offers Poke
when the viewer right-clicks a message author's avatar or name. The instance
hosting the space handles it (`ws/channelPoke.ts`); a poke is never relayed
to a peer, and DMs have none.

**Capability.** `ready.supportsPoke` is `true` from an instance that handles
`channel_poke`. The client keeps it per origin (`stores/channelPokeStore.ts`)
and offers Poke only for messages from an origin that said so. A 1.10.0 or
older instance sends no flag, so its messages get no Poke. On any instance,
the author menu also has no Poke in DMs, without SEND_MESSAGES, on a message
still sending, or on the viewer's own message. It may still offer Mention, which only writes into the composer and
sends nothing; with neither item, right-clicking the author opens the message
menu (permissions.md, the author right-click row).

**Checks**, in order, each refused with an `error` and its code on the
sending socket only, storing and sending nothing:

| Refusal | Code |
|---------|------|
| `channelId` or `targetUserId` is not a string | `validation_failed` |
| no such channel, or the actor lacks VIEW_CHANNEL there | `channel_not_found` |
| the actor lacks SEND_MESSAGES there | `missing_permission` (`details.permission` = `SEND_MESSAGES`) |
| the target has no member row in the space (an instance admin who never joined included) | `member_not_found` |
| the target lacks VIEW_CHANNEL there | `poke_target_no_access` |
| the actor poked 5 times in the last minute | `rate_limited` |

Both ids are the hosting instance's own: the actor is the socket's user there
(a federated member's replicated row), the target is the `userId` of the
message the client right-clicked. Anything else the event carries is
ignored. The limit is a fixed window of 5 per 60 seconds per actor row,
across every channel and target (`CHANNEL_POKE_RATE_LIMIT`), on top of the
per-user limit on every event; a refused poke is not counted.
`DISABLE_RATE_LIMITS` switches it off.

**Stored row.** A poke is stored as a channel message with `type: 'system'`
(database.md, "messages"), authored by the actor, whose content is
`{ event: 'channel_poke', targetUserId, targetDisplayName }`
(`@backspace/shared/src/channelSystemEvents.ts`, which holds the parser).
`targetDisplayName` is the target's nickname in the space, else their account
name without the instance (`dmSystemName`), at the time of the poke.

**Delivery.** After the row is stored, one `channel_poke` event carries it,
hydrated like any channel message, to everyone with VIEW_CHANNEL
(`sendToChannel`). It is not sent as a `message_created`: a client from
before pokes ignores an event type it does not know, where a
`message_created` would mark the channel unread, play the message sound and,
on the `all` notification level, raise a notification showing the JSON. No
`channel_unread_count` follows it.

**A passive row.** A system row is not something a member wrote
(`userWrittenMessages()`): it does not count as unread, does not move the
last message id in `ready` (so it never makes a channel unread), is left out
of channel search, cannot be replied to, and cannot be edited
(`system_message_immutable`). It carries no mass mention stamps, whatever
names it records. It can be deleted like any message, by the actor or with
MANAGE_MESSAGES.

**Client.** The author menu sends `channel_poke` to the space's instance
(`wsSend` with its origin); when that socket is closed it shows
`chat:poke.disconnected` instead, and a refusal shows as the coded error's
toast. A `channel_poke` event adds the row to the timeline through
`chatStore.addRealtimeMessage`, which keeps channel system rows out of
`realtimeMessageEvents`, so no sound, notification or unread dot follows. The
row renders as `ChannelSystemMessage`: "{actor} poked {target}", both named
through `spaceMemberName` from the space's roster like every other surface of
the space, the stored name used only for a target no longer in it. Content
the client does not know renders "System message". Then, for a viewer of the
channel on that origin, the target's newest avatar in the message list
(`data-poke-user`) shakes and a pointing hand slides in
(`components/chat/channelPoke.ts`). The cue does not play with reduced
motion, nor, unless the viewer is the actor, in DND or in a channel that is
muted or set to `nothing`. Loading history never plays it. An older client
shows a stored poke as "System message" when it loads history.

### DM Messages
| type | fields | scope |
|------|--------|-------|
| `dm_message_created` | message: DmMessageWithUser | DM members |
| `dm_message_updated` | message: DmMessageWithUser | DM members |
| `dm_message_deleted` | messageId, dmChannelId | DM members |
| `dm_typing` | dmChannelId, userId, username | DM members (excludes sender) |
| `dm_typing_stop` | dmChannelId, userId | DM members (excludes typer) |
| `dm_embeds_resolved` | messageId, dmChannelId, embeds[] | DM members |

### Read State
| type | fields | scope |
|------|--------|-------|
| `channel_ack` | channelId, messageId | user (multi-tab sync) |
| `mark_unread` | channelId, messageId | user (multi-tab sync) |
| `channel_unread_count` | counts: Record<channelId, number> | user; follows the event that moved the count, on the same socket (see "Unread counts") |

#### Unread counts

The sidebar badges show how many messages are unread, not how many
channels. The instance that hosts a channel or DM counts it, and the client
keeps the counts per origin (`stores/unreadCountStore.ts`).

**What is counted.** Messages after the user's persisted read cursor
(`read_states`), leaving out the user's own. Ids are compared as numbers
(`CAST(id AS INTEGER)`), because snowflakes grew a digit in late 2024 and
grow another in 2031. A space channel is counted only when the user has
VIEW_CHANNEL and READ_MESSAGE_HISTORY there (or ADMINISTRATOR); a DM only
while the user is an open member of a conversation that is not deleted.
Deleted messages are gone from the table and drop out of the next count.
DM system messages count like any other message, as they do for the
unread dot. A space channel's system rows (pokes) do not count, as they do
not move the unread dot (see "Channel pokes").

**The cap.** A count stops at 100, which reads "100 or more". The badges
show anything above 99 as "99+", and a sum of capped counts reaches 100
exactly when the real sum does. The cap also bounds the work: a count
walks at most 100 entries of `idx_messages_channel_unread` or
`idx_dm_messages_channel_unread` (database.md), however long the channel.

**Snapshot.** `ready.unreadCounts` holds an entry for every countable space
channel and open DM in the payload, zero included. The client replaces that
origin's counts with it on every `ready`. It reuses the permissions and read
states the payload already loaded.

**Follow-ups.** `ConnectionManager.sendToUser` sends a `channel_unread_count`
with the user's new count right after these events, on the same sockets, so
the count never runs ahead of or behind the event it belongs to
(`unreadCountFollowUp`, `ws/channelUnreadCounts.ts`):

| Event | Why the count moved |
|-------|---------------------|
| `message_created`, `message_deleted` | a message after the cursor came or went |
| `dm_message_created`, `dm_message_deleted` | the same, in a DM |
| `channel_ack`, `mark_unread` | the cursor moved, here or relayed from a peer as `read_state_update` |
| `channel_updated` | the user's access may have changed |
| `dm_channel_created` | a DM opened or reopened with messages already in it |

A channel fan-out (`sendToChannel`, the visibility broadcast in
`routes/channels.ts`) passes the permissions it computed to choose the
audience, so a follow-up costs one read-state lookup and one bounded count
per recipient. `sendToSpace` events are never followed. A new channel has
nothing to count, and a deleted channel or closed DM leaves the sidebar
with its row, so neither is followed.

**Client.** `SpaceUnreadBadge` sums the counts of the space's channels
from the space's own origin; `DmUnreadBadge` sums the pinned copy of each
conversation from the origin that serves it (`channelOriginMap`), so a
conversation mirrored on several instances counts once. Both sum only
channels in `chatStore.unreadChannels`, so the badge and the unread dot
agree. A muted space keeps its badge in a quieter colour (sounds.md,
"Notification settings").

**Older releases.** An instance on 1.9.1 or earlier sends no
`unreadCounts`; the client then holds no counts for that origin and shows
the unread dot alone. A client on 1.9.1 or earlier ignores
`channel_unread_count` and the extra `ready` field. Federation is unchanged: each instance counts its own
copies.

**Known limits.** A channel that becomes visible through a role change
(`space_access_changed`) or a space joined mid-session has no count until
its next follow-up or the next `ready`; its unread dot shows meanwhile.

### Presence & Activity
| type | fields | scope |
|------|--------|-------|
| `presence_update` | userId, status, activities?, homeUserId?, homeInstance? | friends + DM co-members + space co-members of the user (via `collectProfileBroadcastTargetIds`), plus self for multi-tab sync. For federated stubs, the local instance receives status and activities via S2S `presence_update` relay from the home (see `federation.md` §10 — Presence Sync) and re-broadcasts to the same recipient set, with `activities` whenever the relay changed them (empty clears). `activities` absent = unchanged. `homeUserId`/`homeInstance` are the subject row's federated identity, both null for a row native to this instance; the client keys activities and friend status by that identity (activity-presence.md "Keying"). Every emitter builds the event with `presenceUpdateFor`/`presenceUpdateEvent` (`ws/presenceEvent.ts`). Also sent when a friendship is created: each side gets the other's current status and activities (activity-presence.md "Friendship Snapshot"). Servers that predate the identity fields omit them. |
| `user_updated` | user | user |

### Space / Channel Management
| type | fields | scope |
|------|--------|-------|
| `space_updated` | space | space |
| `member_joined` | spaceId, member: MemberWithUser | space |
| `member_updated` | spaceId, member: MemberWithUser | space |
| `member_left` | spaceId, userId | space |
| `member_banned` | spaceId, reason | user (banned) |
| `channel_created` | channel, spaceId | space |
| `channel_updated` | channel, spaceId | space |
| `channel_deleted` | channelId, spaceId | space |
| `category_created` | category, spaceId | space |
| `category_updated` | category, spaceId | space |
| `category_deleted` | categoryId, spaceId | space |
| `channel_layout_updated` | spaceId, channels[], categories[] | space |
| `space_access_changed` | spaceId | space; one user for an instance admin change |
| `space_layout_updated` | layout[], folders[], updatedAt? | user |
| `notification_settings_updated` | setting: NotificationSetting | user (all of their sockets on this instance) |

`notification_settings_updated` follows every successful
`PATCH /spaces/:spaceId/notification-settings` and
`PATCH /channels/:channelId/notification-settings` (api.md, "Notification
settings"), including to the socket of the session that made the change. It
names the instance's own ids; the client files it under the origin of the
socket that delivered it, which is the instance that hosts the space
(`notificationSettingsStore.apply`), and keeps the newer `updatedAt` when
several sources disagree. A setting with `level` null, `muted` false and no suppress flag was
cleared. Space settings carry `suppressEveryone` and `suppressRoles`;
an old client ignores them. Clients load the full list with `GET /users/@me/notification-settings`
when each instance's `ready` arrives; the `ready` payload itself does not
carry it. Mixed versions: an old client ignores the event; a new client on an
old server gets a 404 from the list route, logs it and uses the defaults.

`member_updated` follows every successful `PATCH /spaces/:id/members/:uid`
(a nickname, a role set or both) and carries the member row the route
answered: `nickname`, and `roles` with display fields only (permissions.md,
"Who receives role and override data"). The client applies it only when the
space with that id and the origin of the socket that delivered it is the
loaded space (`applySpaceMemberUpdate` in `stores/spaceMemberUpdates.ts`), and
takes only `nickname` and `roles` from it; the user row and presence have
their own events. The HTTP answer goes through the same function. Mixed
versions: an older client ignores the event; an older server does not send
it, and its role changes still arrive through `space_access_changed`.

`space_access_changed` follows any change to the space's roles or to a
member's roles: `POST`, `PATCH`, `DELETE /spaces/:id/roles[/:rid]`,
`PATCH /spaces/:id/members/:uid`, `POST`/`DELETE /spaces/:id/members/:uid/roles`.
It also follows `PATCH /spaces/:id/transfer-ownership` (sent to the space,
after `space_updated`; the former and the new owner are the members whose own
permissions changed), and `PATCH /admin/users/:id/role` when the admin flag
changes: an instance admin holds every permission in every space on the
instance, so that user alone is sent one event for each space they belong to
(`ConnectionManager.announceUserAccessChange`), followed by the
`space_voice_state` they can see there now. What the receiver may see or do
there, and how the roles and members look, may be different now. The client
refetches the space's detail from its own instance with `loadSpaceDetail(spaceId, { quiet: true })`: no loading state
(no skeleton) and no message cache touched. One action can send several of
these events (a member role edit, quick role moves), and their refetches can
answer out of order; which load lands, and what lands for a space that is
not open, is in spaces.md ("Client Load State"). Every channel the detail lists
goes through `upsertChannel`, and a channel of that space it no longer lists
goes through the `channel_deleted` path, which also closes it when it is
open (`refreshSpaceAccess` in `hooks/useWebSocket.ts`). The detail carries no
voice presence, so the members whose own permissions the change may reach
(the member whose roles changed; the holders of a changed or deleted role;
everyone for @everyone; nobody for a new role; the former and the new owner)
are each sent a
`space_voice_state` right after the event, built by `pushSpaceVoiceState`
exactly as for a mid-session join (below): a voice channel a member just
gained shows who is in it at once (`ConnectionManager.announceSpaceAccessChange`).
These routes used to
push a whole `ready` instead, which every client handles as a reconnect.
Mixed versions: an old client connected to a new server ignores the event
and misses live role changes in that space until it reconnects; a new client
connected to an old server still gets the old `ready` push.

An `error` that carries a `code` is the refusal of something the user just
did (`role_hierarchy` from the voice moderation events, `dm_call_in_progress`,
`not_dm_member` and `validation_failed` from `dm_call_start`, `dm_call_not_found`,
`not_dm_member` and `validation_failed` from `dm_call_accept`, and the DM
message events (see "DM Messages")); the client shows it as a warning
toast in the user's language (`describeErrorCode`, with the event's `details`). An `error` without a code
is only logged. An `error` with a `dmChannelId` equal to the DM the client is
calling, from the instance that serves that DM, also clears the calling state
(`outgoingCall`), which stops the outgoing ring. A `dm_call_not_found` or
`not_dm_member` naming the call the client is in, from that call's instance,
takes the client out of it (`teardownDmCall`).

### DM Channel Management
| type | fields | scope |
|------|--------|-------|
| `dm_channel_created` | dmChannel | user |
| `dm_channel_closed` | dmChannelId | user |
| `dm_member_added` | dmChannelId, user | DM members |
| `dm_member_removed` | dmChannelId, userId | DM members |
| `dm_owner_updated` | dmChannelId, newOwnerId, newOwnerHomeUserId?, newOwnerHomeInstance? | DM members |

### Voice
| type | fields | scope |
|------|--------|-------|
| `voice_state_update` | channelId, userId, action: join/leave, channelElapsedSeconds? | space |
| `voice_status_update` | userId, channelId, isMuted, isDeafened, isCameraOn, isScreenSharing | room |
| `space_voice_state` | spaceId, voiceStates, voiceChannelElapsedSeconds, voiceUserStates, spaceVoiceStates | the joining user, or a member whose access changed. Scoped per-space voice-presence snapshot pushed when a user joins a space mid-session, after `space_access_changed` (see below), and to each member who can see a voice channel after an override on it or its category changed or it moved to another category (spaces.md, "Channel/Category Permission Overrides"). |
| `voice_space_muted` | userId, channelId, spaceId, muted, botSeat? | space (`botSeat: true`: the mute is that bot seat's only; snapshots key it `spaceId:botId:channelId`) |
| `voice_space_deafened` | userId, channelId, spaceId, deafened, botSeat? | space (`botSeat: true`: as above) |
| `voice_permission_muted` | userId, spaceId, channelId?, muted | space (`channelId` only for a bot seat: the mute is that channel's alone) |
| `voice_moved` | userId, oldChannelId, newChannelId | user (target) |
| `voice_disconnected` | userId, channelId, reason? | user (target) |
reason: `'displaced'` (new tab) | `'session_closed'`

### DM Calls
| type | fields | scope |
|------|--------|-------|
| `dm_call_incoming` | dmChannelId?, federatedCallId, callerId, callerName, callOrigin?, livekitUrl?, livekitToken? | DM members (excludes caller). `dmChannelId` can be null for Path B federated calls (no local DM channel). `callOrigin` identifies the hosting instance for cross-instance calls. |
| `dm_call_accepted` | dmChannelId?, federatedCallId?, answeredBy? | DM members, on every accept including late joins. A client acts on it only when it names the call it holds (`dmCallEventIsOurs`). `answeredBy` (`{ homeUserId, homeInstance }`, absent from servers up to 1.9.0) is the member who answered: the client stops ringing only when that is the signed-in user, compared by federated identity (`acceptStopsRing`), so in a group call another member's answer leaves the ring on. Without it the ring stops as before |
| `dm_call_rejected` | dmChannelId?, federatedCallId? | DM members when the call ends as rejected; only the decliner (all sessions) for a group decline that leaves the call running |
| `dm_call_ended` | dmChannelId?, federatedCallId? | DM members. Preceded by a `voice_state_update` leave for each participant still in the call. A client tears down its call state only when the event names the call it holds (`dmCallEventIsOurs`) |
| `dm_call_undeliverable` | Sent to the originator when a call relay (start / accept / reject / end) to one or more peers fails. Includes `phase: 'start' \| 'accept' \| 'reject' \| 'end' \| 'host_unreachable'` identifying the action; `failures[]` enumerates failed peers with a `reason` (`peer_rejected` / `peer_awaiting_approval` / `peer_transient_failure` / `livekit_unavailable` / `no_recipient` / `identity_not_accepted`, the last when the peer accepts no name this instance could give the acting user, so nothing was sent; see federation.md "Who a call relay names"). `terminal: true` means local call state should be (or has been) torn down; `terminal: false` is informational. See `docs/systems/voice.md` for the full phase × terminal matrix. | originator (caller / acceptor / rejector / ender) |

### Social
| type | fields | scope |
|------|--------|-------|
| `friend_request_received` | request | user (target) |
| `friend_request_accepted` | friend, requestId | user (requester) |
| `friend_request_declined` | requestId, userId | user (requester) |
| `friend_request_cancelled` | requestId, userId | user (target) |
| `friend_removed` | userId | user |

### Discovery
| type | fields | scope |
|------|--------|-------|
| `join_request_received` | request | space (managers) |
| `join_request_accepted` | request, space | user (requester) |
| `join_request_declined` | request | user (requester) |

### Federation
| type | fields | scope |
|------|--------|-------|
| `federation_file_rejected` | messageId, dmChannelId, attachmentId, affectedUsers[] | DM members |
| `federation_approval_request_received` | — (refetch trigger; payload: `{ type }`) | admins. Fires for **both** inbound peering requests (remote → us) AND outbound queue creation when the [Outbound Peering Gate](federation.md#outbound-peering-gate) creates a `peer_approval_requests` row in response to a user_action. Payload shape unchanged from the inbound-only behavior; only the firing surface widened. |
| `federation_peer_reset_detected` | `{ origin: string }` | admins. Fires from `markPeerReset` when a peer's advertised instance epoch differs from the trusted baseline (a wipe-and-reinstall on the same domain — see [Reset Detection](federation.md#reset-detection-markpeerreset--utilsfederationresetts)). Detection-only: the peer was routed to `needs_attention` (reason `peer_reset_detected`) with no rekey/tombstone. Paired with a `federation_peers_changed` broadcast. **Client handler:** `onFederationPeerResetDetected(cb)` (`useWebSocket.ts`) — the FederationPanel's Reset-cleanup surface subscribes and refetches `GET /api/federation/peers` + `GET /api/federation/reset-events`, raising a persistent banner with one-click Re-peer (see `admin.md` "FederationPanel", `client-federation.md` §8). |
| `peering_subscription_changed` | — (refetch trigger; payload: `{ type }`) | the subscribing user (all of their connected sessions). Fires when a `peer_approval_subscribers` row belonging to the user is created, modified, or deleted (gate fan-in, user cancel, parent cascade). Client refetches `GET /api/federation/peering-subscriptions`. |
| `peering_notification_received` | `{ type, kind: 'approved' \| 'denied' \| 'expired' }` | the user the notification belongs to. Fires when a `peer_approval_notifications` row is created (`onPeerActivated` outbound fanout, outbound `/deny` fanout, janitor outbound expiry). Client refetches `GET /api/federation/peering-notifications` and may surface a transient toast for online users. |

**S2S relay-only event (not a direct client WS event):**

`read_state_update` — sent peer-to-peer via the federation relay when a user acknowledges a DM channel on one instance. The receiving instance processes it, upserts the `read_states` row, and then emits a standard `channel_ack` event to the user's local WebSocket connections. The relay event itself is never forwarded to clients directly.

---

## Ready Payload

```typescript
{
  type: 'ready',
  user: User,
  spaces: SpaceWithChannelsAndMembers[], // channels and categories carry isPrivate (permissions.md, "Private channels and categories")
  dmChannels: DmChannel[],
  folders?: SpaceFolder[],
  spaceLayout?: SpaceLayoutItem[] | null,
  layoutUpdatedAt?: number,
  voiceStates?: Record<channelId, userId[]>,
  voiceChannelElapsedSeconds?: Record<channelId, number>,
  voiceUserStates?: Record<string, { isMuted, isDeafened, isCameraOn, isScreenSharing }>,
  spaceVoiceStates?: Record<string, { spaceMuted, spaceDeafened, permissionMuted }>,
  readStates?: ReadState[],
  supportsPoke?: boolean,          // true from an instance that handles channel_poke (see "Channel pokes"); absent before
  unreadCounts?: Record<channelId, number>, // unread messages per countable space channel and open DM, capped at 100 (see "Unread counts")
  activeCalls?: ActiveCallInfo[],  // includes federatedCallHost?, livekitUrl?, livekitToken? for federated calls
  userActivities?: Record<userId, Activity[]>,  // space members, DM members and friends; keys are this instance's row ids
  userActivityIdentities?: Record<userId, { homeUserId: string | null, homeInstance: string | null }>,  // identity of each userActivities key; null pair = native row
  rejectedPeerOrigins: string[],         // origins with status 'rejected'; used for DM unreachable indicators
  awaitingApprovalPeerOrigins: string[], // origins with status 'awaiting_approval'
  pendingApprovalCount: number           // count of peer_approval_requests rows; only non-zero for admins
}
```

**Roles:** each space's `roles` carry their display fields for every member and their `permissions` only when the user holds `MANAGE_ROLES` there; `members[].roles` carry display fields only. The payload has no override rows; the user's own permissions are `myPermissions` on the space and on each channel. The same shaping applies to the `space` in `join_request_accepted` (permissions.md, "Who receives role and override data").

**Federated users:** When the connecting user is federated (`homeInstance` is set), the ready payload carries their DMs on this instance like anyone else's: `dmChannels` (this instance's copies, each with its `federatedId`, which is how the client shows a conversation it also gets from the user's home once) and `activeCalls` for those memberships. `readStates` is filtered to the space channels and DMs in the payload, and a DM with messages but no read state yet gets one at its newest message, so conversations mirrored here before the user first connected do not show as unread.

**Voice-state assembly:** `voiceStates` / `voiceChannelElapsedSeconds` / `voiceUserStates` / `spaceVoiceStates` for each of the user's spaces are produced by `ConnectionManager.buildSpaceVoiceState(spaceId, userId)` — the single source of truth shared with the mid-session join push (see below). `voiceChannelElapsedSeconds` is a whole-second duration computed from the in-memory `VoiceRoom.startedAt`; clients advance that duration from receipt time, so server/client clock skew cannot change the value. It disappears when the room becomes empty. Because rooms are intentionally in-memory, a server restart clears both occupancy and its duration until participants reconnect; this is not persisted to the database. Voice presence is VIEW_CHANNEL-filtered per `computePermissions`: a user is never told who occupies a voice channel they cannot see.

### Mid-session space join — `space_voice_state` push

**Client: one session per socket.** The web client treats the first `ready` of a socket as a new session (it may follow a gap, so the message cache of that origin is refetched) and any later `ready` on the same socket as a state refresh that leaves the message cache alone. See docs/systems/message-list.md, "Reconnects and refresh readies".

The `ready` payload is the **only** carrier of voice presence at connect time. When a user joins a space *mid-session* (invite, public join, or join-request approval) without reloading, they would otherwise see empty voice channels until a refresh, because `member_joined` carries no voice state and `GET /api/spaces/:id` (the channel-sidebar hydrator) has none either.

To close this, `ConnectionManager.addUserSpace(userId, spaceId)` — the single chokepoint every join path funnels through, and which is **not** used on reconnect (that path uses `setUserSpaces`) — calls `pushSpaceVoiceState(userId, spaceId)`, which builds the same per-space snapshot via `buildSpaceVoiceState` and pushes it to the user as a `space_voice_state` event. Delivery rides the same ordered WebSocket as the `voice_state_update` deltas, so there is no snapshot-vs-stream race. The push is skipped when the user has no connection, or the space has no active voice and no restrictions (e.g. space creation). The client applies it scoped to `spaceId` (`utils/voiceStateSync.applySpaceVoiceState`): it merges occupants/statuses and rebuilds only that space's restriction keys, never disturbing voice state in other spaces.

---

## Bots

A bot authenticates like any client (`{ type: 'auth', token }`, the token is the bot's JWT) and receives the same events as any member of the same chats; the server does not filter the ordinary events (no rule by mention or by kind of chat). See [bots.md](bots.md) for what a bot author needs (self-events, mentions, reconnecting).

**Client to server, bots only:** `bot_voice_join { channelId }` and `bot_voice_leave { channelId }` seat a bot in a space voice channel and take it out again without touching its other seats (up to 25); the room is told with the ordinary `voice_state_update`. See [bots.md](bots.md), section 5c.

**Server to a bot:** `interaction_created { interaction: { id, command, subcommand?, options, resolved?, user, channelId?, spaceId?, dmChannelId?, expiresAt } }` when a person invokes one of the bot's slash commands; only the invoked bot's sockets receive it. See [bots.md](bots.md), section 5b.

**Server to the invoker of a slash command:** `interaction_ephemeral { reply: { id, interactionId, command, user, content, createdAt, channelId?, spaceId?, dmChannelId? } }` when the bot answers with `ephemeral: true`; only the invoker's sockets on this instance receive it, nothing is stored, and the client shows it in that chat until a reload or a dismiss. See [bots.md](bots.md), "Answering".
