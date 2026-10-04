# Bots

A bot is an ordinary account that a program controls with a token. The server gives a bot exactly what it gives any member (events, REST, permissions) and applies **no behavioural policy of its own**: what a bot answers, when it reacts and whether it needs a mention is decided by the bot's code.

Source files:
- `packages/server/src/routes/bots.ts` -- owner endpoints (create, edit, token, delete, add to a space)
- `packages/server/src/routes/reactions.ts` -- REST reactions, the twin of the WS events
- `packages/server/src/utils/botFederation.ts` -- cutting a bot off from other instances
- `packages/server/src/utils/spaceMembership.ts` -- `addUserToSpace`, `removeUserFromSpace`
- `packages/server/src/utils/auth.ts` -- `tokenFromAuthHeader` (`Bearer` / `Bot`)
- `packages/server/src/routes/auth.ts` -- `POST /api/auth/register` with `botProof`
- `packages/server/src/routes/federation/handlers/attach.ts` -- `verify-attach-proof` answers `isBot`
- `packages/web/src/components/modals/settingsPanels/BotsPanel.tsx` -- Settings > Bots
- `packages/server/src/routes/botCommands.ts`, `routes/interactions.ts`, `utils/botAuth.ts` -- slash commands
- `packages/server/src/ws/handler.ts`, `ws/events.ts` -- bot voice seats (`botJoinRoom`, `bot_voice_join`)
- `packages/web/src/components/chat/CommandPopover.tsx` -- the command lists in the message box
- `examples/bots/` -- zero-dependency Node clients

---

## 1. Model

- A bot is a `users` row with `is_bot = 1`, `bot_owner_id = <owner id>` and `password_hash = '!bot'` (not a bcrypt hash, so password login is impossible). A bot is native to its instance (`home_instance = NULL`) and `discoverable`.
- **Name.** The username is 5 to 32 characters of `[a-z0-9_]` and always ends with `_bot`. On creation the suffix is appended when missing (`echo` becomes `echo_bot`). The username never changes (it is the federation identity). The owner edits the display name (must also end with `_bot`) and the avatar.
- **Limit.** 10 bots per owner (`bot_limit_reached`).
- **Token.** A JWT (`{userId, username, iat, exp}`, 3650 days), not stored, shown once. Regenerating a token sets `users.password_changed_at`, which revokes every earlier token (`iat` is in whole seconds) and closes the bot's sockets.
- **Owner.** Only a human with an account native to the instance manages bots. A bot, or a federated account, gets `403 bots_native_only`.
- **Deletion.** `DELETE /api/bots/:id` tombstones the bot (DM threads stay readable). Deleting the owner's account tombstones every bot they own.
- The owner's profile rules do not apply to the bot: a bot cannot edit its own durable profile fields through `PATCH /api/users/@me` (`403 bot_profile_owner_only`); the owner does it through `PATCH /api/bots/:id`.

## 2. Authentication

```
Authorization: Bot <token>
```

`Bearer <token>` is accepted as an alias everywhere (REST and tus uploads). WebSocket: first message `{"type":"auth","token":"<token>"}`, no scheme.

## 3. Managing bots (owner, JWT of the human)

| Method | Path | Body | Answer |
|--------|------|------|--------|
| GET | `/api/bots` | -- | `{ bots: BotSummary[] }` |
| POST | `/api/bots` | `{ name }` | 201 `{ bot, token }` (5 per 15 min) |
| PATCH | `/api/bots/:id` | `{ displayName?, avatar? }` | `{ bot }` |
| POST | `/api/bots/:id/token` | -- | `{ token, federation }` (5 per 15 min) |
| DELETE | `/api/bots/:id` | -- | `{ success, federation }` |
| GET | `/api/bots/search?q=` | -- | `{ bots: BotSearchResult[] }` (native discoverable bots, username substring of 2-32 characters, up to 25; any signed-in account; each result adds `ownerUsername`, `null` when the owner is deleted or not discoverable) |
| GET | `/api/bots/:id/spaces` | -- | `{ spaces: [{ id, name, icon, botIsMember }] }` (owner; the caller's MANAGE_SPACE spaces plus every space the bot already sits in) |
| POST | `/api/bots/:id/spaces` | `{ spaceId }` | `{ success }` (any native bot of this instance; MANAGE_SPACE in the space) |
| DELETE | `/api/bots/:id/spaces/:spaceId` | -- | `{ success }` (the bot's owner, or MANAGE_SPACE in the space; the bot gets `member_left` and no further events of that space) |

`BotSummary` is `{ id, username, displayName, avatarColor, avatar, createdAt }`. `avatar` is a bare upload filename (upload through tus first) or `null`. Errors use the project format `{ error, code, statusCode, details? }`; the codes specific to bots are `bot_not_found`, `bot_limit_reached`, `bot_name_invalid`, `bot_name_suffix_required`, `bots_native_only`, `bot_profile_owner_only`, `bot_home_not_peered`, `bot_proof_invalid`, `bot_account_required`, `bots_no_friends`.

A name change or an avatar change is broadcast (`user_updated`) and relayed to peers as a `profile_update`, so the bot's accounts on other instances follow.

`federation` (token regeneration and deletion) lists, per instance the bot registered on, whether the account there was cut off (see 7).

## 4. Getting a bot into conversations

- **Space, by a manager:** `POST /api/bots/:id/spaces`. Any native human with MANAGE_SPACE in the space may add any native bot of this instance — their own or someone else's. The bot's owner takes no part and is not asked; they see every space of their bot in `GET /api/bots/:id/spaces` (their manageable spaces plus every space the bot already sits in) and can end the membership themselves. A federated bot account or a human as the target answers `404 bot_not_found`. The result is the same as joining (member row, `member_joined`). A banned bot is refused (`user_banned`), a member answers `409 already_member`. A federated human account with MANAGE_SPACE may also invite and remove bots, because both are actions on the space. Creating, editing, re-issuing the token of and deleting a bot stay with the native owner account on the bot's home instance, where the bot's row and signing key live. Managing a bot from another instance would need a separate server-to-server design, and while the home instance is down its tokens cannot be re-issued anywhere.
- **Finding a bot to invite:** `GET /api/bots/search?q=<substring>` — native, discoverable bots of this instance by username substring (2-32 characters; `%` and `_` are literal; any other length answers an empty list), up to 25, ordered by username. The caller's own bots are listed too: a directory, not a policy. Each result names its owner (`ownerUsername`), so a manager sees whose code they are inviting. The web client offers the flow in Space settings → Members → "Add Bot".
- **Taking the bot out:** `DELETE /api/bots/:id/spaces/:spaceId` — by the bot's owner (any space of their bot) or by a space manager (MANAGE_SPACE); the ordinary member kick (KICK_MEMBERS) keeps working as before. Kick, ban and both removal routes end live delivery of that space to the bot's sockets at once and take the bot out of that space's voice channels.
- **Space, by the bot:** `POST /api/spaces/join { inviteCode }`, like any user. Request-only spaces answer `403 join_request_required`.
- **Group DM:** any member adds the bot with `POST /api/dm/:id/members { userId }`. The friendship requirement is waived for the **owner adding their own bot**, because bots take no friends.
- **1-on-1 DM:** a user finds the bot with `GET /api/social/search?q=<username>` and opens `POST /api/dm { userId }`. No friendship needed.

A bot holds the permissions of its roles in a space (`@everyone` by default); the space's managers adjust them like for any member.

## 5. What a bot receives and can do

### Events (WebSocket `/ws`)

After `auth` the server answers `{ "type": "ready", "user": { "id", ... }, ... }`; `user.id` is the bot's own id. From then on the bot receives **every event a member of that chat receives**: the list is in [websocket.md](websocket.md) (`message_created`, `message_updated`, `message_deleted`, `reaction_added`, `typing`, `dm_message_created`, `dm_channel_created`, `member_joined`, ...). The server does not filter by mention or by conversation kind.

The bot's own messages come back as events. A bot that answers messages must ignore `message.userId === <own id>` (and DM messages whose `type` is not `user`), or it answers itself.

A mention is the token `<@userId>` in `content`. Code spans and fenced blocks do not count as mentions in the clients; bot code that cares should skip them the same way (`examples/bots/mention-reply.mjs` does).

The socket has no resume. After a reconnect the `ready` payload carries the current state and anything missed is read back with the history endpoints. The server pings every 30 s and drops a dead connection after about 65 s; standard WebSocket clients answer pings themselves.

### Actions (REST)

| Action | Call |
|--------|------|
| Post in a channel | `POST /api/channels/:id/messages { content, attachments?, replyToId? }` |
| Post in a DM | `POST /api/dm/:id/messages { content?, attachments?, replyToId? }` |
| Edit / delete own message | `PATCH` / `DELETE /api/messages/:id` (channel), `PATCH` / `DELETE /api/dm/messages/:id` (DM) |
| React | `PUT /api/messages/:id/reactions/:emoji` (emoji URL-encoded, 1 to 64 characters) |
| Remove own reaction | `DELETE /api/messages/:id/reactions/:emoji` |
| Read history | `GET /api/channels/:id/messages?before=&limit=`, `GET /api/dm/:id/messages?before=&limit=` |
| Upload a file | tus on `/api/files/` (see [uploads.md](uploads.md)), then pass the attachment id in `attachments` |
| Typing indicator | WS `typing_start { channelId }`, `dm_typing_start { dmChannelId }` |

The reaction calls serve channel and DM messages alike (the kind is found by the message id), are idempotent (`{ success: true, changed }`), and use the same code as the WS events `reaction_add` / `reaction_remove`, including the DM relay. The WS events of [websocket.md](websocket.md) remain available for a bot that keeps a socket anyway.

### Limits

Messages in channels and in DMs: 5 per 5 s each. Reactions: 10 per 5 s. Both are counted per client address, like every limit in this app ([api.md](api.md), "Rate limiting"). Bot creation and token regeneration: 5 per 15 min per owner.

## 5b. Slash commands

A bot registers commands for itself. A person picks one in the message box (typing `/` opens the list), the server checks the call and hands it to the bot as an event, and the bot answers with ordinary messages. What a command does is the bot's code; the server only carries the call.

### Registering

```
PUT /api/bots/@me/commands   { commands: [ { name, description, options?: [ { name, description, type, required?, choices? } ] } ] }
GET /api/bots/@me/commands   → { commands: BotCommand[] }
```

Bot token only (`403 bot_account_required` for anyone else). `PUT` replaces the whole list in one call, so repeating it is harmless; a command that keeps its name keeps its id. 10 calls per 5 minutes.

Rules: command and option names are 1 to 32 characters of `a-z 0-9 _ -` and unique; descriptions are 1 to 100 characters; at most 100 commands and 10 options per command; option types are `string`, `integer` (a safe integer), `number` and `boolean`; required options come before optional ones; a `string`, `integer` or `number` option may list up to 25 `choices` (`{ name, value }`, the value of the option's type, unique). A violation answers `400 validation_failed` and `details.field` names the field, for example `commands[0].options[1].name`.

Commands are stored on the instance the bot registers them on: register them on every instance where the bot has an account.

### Invoking

```
GET  /api/commands?channelId=<id>  |  ?dmChannelId=<id>   → { commands: [ { id, botId, name, description, options, updatedAt, bot: { id, username, displayName, avatar, avatarColor } } ] }
POST /api/interactions   { botId, command, options?, channelId | dmChannelId }   → 201 { id, expiresAt }
```

`GET` lists the commands of the bots that are in that chat; the caller must be able to see it. `POST` checks, in this order: exactly one of `channelId` and `dmChannelId`; the caller is a member and may write there (SEND_MESSAGES in a channel); the bot is in the chat (`404 bot_not_found`); the command exists (`404 command_not_found`); each option value fits its definition, including `choices` (`400 validation_failed`, `details.field` is `options.<name>`); the bot has an open WebSocket (`409 bot_unavailable`). 5 calls per 5 seconds per client address.

Command names are unique per bot, not per chat: two bots may both offer `/play`. Every listing entry names its bot, and an invocation names it too (`botId`), so a clash reaches exactly the bot it addresses; the message box shows the bot's `@username` under each command. A command typed out by hand, without picking a row from the list, runs the first of the clashing commands in the listing's order (name, then the bot's username).

### The event

```json
{ "type": "interaction_created",
  "interaction": { "id": "...", "command": "play", "options": { "query": "song", "volume": 80 },
                   "user": { "id": "...", "username": "..." },
                   "channelId": "...", "spaceId": "...", "expiresAt": 1790000000000 } }
```

`options` holds the parsed values with the types of the definition; an optional option that was not given is absent. A call from a space channel carries `channelId` and `spaceId`, a call from a direct or group DM carries `dmChannelId`. `user` is the person who invoked the command.

### Answering

```
POST /api/interactions/:id/respond   { content?, attachments? }   → 201 (the created message)
```

Bot token only, and only the invoked bot. The message is posted through the same route as `POST /channels/:id/messages` or `POST /dm/:id/messages`, so permissions, the length limit, attachments, embeds and the rate limit are the ordinary ones. The interaction lasts 15 minutes and takes up to 5 responses. Errors: `404 interaction_not_found` (also for another bot's interaction), `410 interaction_expired`, `429 interaction_responses_exceeded`, and whatever the message route answers. The message is the bot's own; mention the invoker with `<@user.id>` if the answer is for them. A bot that never answers causes nothing more than silence until the interaction expires.

### In the message box

Typing `/` at the start of a message lists the commands of the bots in the chat. Choosing one writes it with its required options as `name:` ready to be filled in; after a space the optional options not used yet are offered (Tab picks one); pasting a full command works too. The form is: options first as `name:value` (several words in double quotes), then the rest of the line, which is the value of the last string option and may be any length: `/play volume:80 any long title`. The server only ever sees the parsed `options`.

### Scope

Chats on the instance where the bot is connected. Not built: subcommands, autocomplete, private (visible to one person) answers (a bot may message the invoker directly), buttons and forms, `user` and `channel` option types, commands of bots from other instances in direct messages.

## 5c. Voice channels

A person has one voice seat at a time. A bot may sit in several voice channels at once, one seat per channel, so a radio bot never has to be shared between channels. Each voice channel is its own LiveKit room, so the audio of the seats is independent.

### Client events (WebSocket, bots only)

| type | fields | notes |
|------|--------|-------|
| `bot_voice_join` | channelId | seats the bot in that voice channel without leaving the others |
| `bot_voice_leave` | channelId | takes the bot out of that one channel |

`bot_voice_join` makes the same checks as `voice_join` (the channel exists, the bot is a member of the space, CONNECT) and is idempotent. A bot may hold at most 25 seats. A refusal arrives as an `error` event; a person sending these events gets `code: 'bot_account_required'`. Space voice channels only: DM calls keep their rules. Voice moderation (space mute and deafen) does not reach a seat taken with `bot_voice_join`; a bot that joined with the ordinary `voice_join` is moderated like a person, and such a restriction is not applied to its later bot seats.

The rest of the space sees the bot like anyone else: `voice_state_update { action: 'join' | 'leave' }` per channel, and the `ready` payload lists the bot under `voiceStates` of every channel it sits in.

### Audio

For each channel the bot asks for a token of its own and connects to that room itself:

```
POST /api/livekit/token   { channelId }   → { token, url }
```

The call works for a bot exactly as for a person (a role without SPEAK or STREAM limits what the token may publish). One LiveKit connection per room, publishing one audio track each, is how a bot plays different audio in different channels; the track is produced by the bot's own code with a LiveKit client library, which the server neither provides nor needs. Which channel a command belongs to is the bot's decision as well: the interaction names the invoker, and `voice_state_update` and the `ready` payload say in which voice channel that person sits (`examples/bots/voice.mjs`).

### When a seat ends

The bot leaves a seat with `bot_voice_leave`. All its seats end 5 seconds after its last socket closes, and at once when its token is regenerated or the account deleted, and the seats of one space end when the bot is removed from that space, kicked or banned.

### Limits

`voice_status` (mute, camera, screen share) is not wired for bot seats, and the voice moderation actions (move, disconnect, space mute) do not act on them; a moderator takes a bot out of its channels by removing it from the space.

## 6. Connecting from outside

`https://<instance>` for REST (`/api/...`), `wss://<instance>/ws` for the socket, both behind Caddy. The examples take `BACKSPACE_URL` and `BOT_TOKEN`.

## 7. Bots on other instances

A space lives on one instance and is not relayed, so a bot reaches a space on instance B the way a person does: through a federated account `name@home` on B. The bot's home instance A issues the secret for that account; B asks A whether the account is a bot.

1. On A, with the bot's token: `POST /api/users/@me/federation-credential { origin: "<B origin>" }` returns `secret` (per-remote, never the bot's token).
2. On A: `POST /api/auth/attach-proof { targetDomain: "<bare host of B>" }` returns a one-time `token` (60 s, bound to B).
3. On B: `POST /api/auth/register { username: "x_bot@<A host>", password: <secret>, homeInstance: "<A host>", homeUserId: <bot id on A>, botProof: <token> }`. When the account exists, `POST /api/auth/login` with the same secret.
4. Open `wss://B/ws` with the JWT B returned, join by invite, answer.

B verifies the proof with A over the signed server-to-server channel (`POST /api/federation/verify-attach-proof`, whose signed answer now carries `isBot`) and takes the identity and the bot flag **from that answer**. The body's `username`, `homeUserId` and any `isBot` are ignored, so a client cannot claim to be a bot. A must already be an active peer of B, otherwise `409 bot_home_not_peered` (no handshake is started from an unauthenticated route). A spent, foreign or non-bot proof answers `401 bot_proof_invalid`; a malformed one answers `400`.

**Cutting a bot off.** Regenerating the token (mode `soft`), deleting the bot (`full`) and deleting the owner send a signed `DELETE /api/federation/identity` to every instance where the bot holds a credential; the account there is tombstoned and its JWT stops working. After a regeneration the bot registers again with the new token and joins its spaces again. The origins are read before the tombstone, which deletes the credentials.

## 8. Limitations

- An instance without bot support ignores `botProof`: the account there is an ordinary user (no bot flag). A person can also automate a human account without declaring it; the server cannot tell.
- The token is a full user session: a bot can call any REST endpoint a user can. Hashed tokens in their own table, scopes and revocation of a single token are not built.
- `isBot` is not carried by the DM relay: on other instances a DM with a bot shows no bot marker.
- Revocation on another instance depends on the peer: an unreachable or inactive peer leaves the account there until the call is repeated (the answer says which); a bot that owns a space there answers `owns_spaces` and stays.
- A regenerated token removes the bot from its spaces on other instances (the account is recreated).
- The peer of the home instance is found by host without port; two instances on one host and different ports are not supported. `homeInstance` in `register` cannot carry a port.
- When a person replies to a message and mentions a bot, the event carries the replied text in `replyTo`.
- Slash commands run only in chats on the instance where the bot is connected; the other things not built are listed in section 5b. Voice has no per-seat status or moderation (section 5c).
- Not built: per-bot permissions beyond roles, resume after reconnect, private (visible to one person) answers to slash commands.

## 9. Database

Migration `0021_familiar_mentor.sql` adds to `users`: `is_bot` (INTEGER NOT NULL DEFAULT 0) and `bot_owner_id` (TEXT, the owner's user id) and an index `idx_users_bot_owner_id` on it. Nothing else is stored per bot; the avatar and display name are the ordinary `users` columns. The cascade and revocation rules are in 1 and 7.

Slash commands add two tables. `bot_commands` (migration `0022_keen_proudstar.sql`): `id` (PK), `bot_id` (FK to `users`, cascade), `name`, `description`, `options` (JSON array, default `'[]'`), `updated_at`; unique index on `(bot_id, name)`. `interactions` (migration `0023_shallow_sandman.sql`): `id` (random 32-hex string, PK), `bot_id` and `user_id` (FKs to `users`, cascade), `channel_id` / `dm_channel_id` (exactly one is set), `command`, `options` (JSON object of the parsed values), `created_at`, `expires_at`, `responses` (default 0); index on `expires_at`. A spent interaction is dropped by the first invocation that comes a day after it expired. A bot's `bot_commands` rows are deleted when the bot is tombstoned.
