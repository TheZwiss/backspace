# ADR 0002: DM conversation identity

| | |
|---|---|
| Status | Accepted |
| Date | 2026-09-28 |
| Issue | [#345](https://github.com/TheZwiss/backspace/issues/345) (follow-ups of #344) |

## Summary

A DM conversation has one key, `federatedId`, and each side computes it in
exactly one module: on the server `utils/dmConversation.ts`, on the client
`stores/dmConversations.ts`. Every 1-on-1 row stores its key from the moment
it is inserted, legacy rows are backfilled at startup, and a server states
`null` only for a group no other instance holds. The server puts a `DmChannel`
on the wire only through `utils/dmChannelWire.ts`. The client learns every
copy of a conversation through one merge module that owns the key, the copies
per origin and the pinned copy, and `dmChannels` becomes a view derived from
it. The strongest reason: the duplicate-row bugs of 1.6.x each came from one
more place deciding "which conversation is this" on its own, and one of those
places drifting.

## Context

Federated DMs are mirrored on purpose: every instance that hosts a participant
keeps its own copy, so history survives any one instance going down. A client
connected to several instances therefore receives the same conversation under
several channel ids, and has to show it once. What says two copies are one
conversation is `federatedId`: for a 1-on-1 the first 32 hex characters of
SHA-256 over the two members' home user ids, sorted and joined with `:`
(`computeFederatedId`, `packages/server/src/utils/federationOutbox.ts:345-355`);
for a group a random UUID minted by the instance that first shares it.
`dm_channels.federated_id` is unique per instance (`idx_dm_federated`,
`packages/server/src/db/schema.ts:165-167`).

On main at 005fd225 that question is decided in many places.

Server:

- The 1-on-1 key is computed in five places: `ensureOneOnOneDmChannel`
  (`routes/dm.ts:412-423`), `POST /api/dm` (`routes/dm.ts:1028-1040`), relayed
  create (`routes/federation/events/dmMessages.ts:133-136`), call start
  (`ws/events.ts:1779-1796`) and re-attach reconcile
  (`routes/federation/reconciliation.ts:45-47`). Group keys are minted in three:
  group create (`routes/dm.ts:1217-1236`), add member (`routes/dm.ts:1756-1782`)
  and call start (`ws/events.ts:1791`, without the owner home identity).
- Whether a 1-on-1 gets a key depends on the path. Local create keys it only
  when relay is on and a member is homed elsewhere; call start keys any pair; a
  row created while relay was off stays `NULL`.
- Local create finds an existing 1-on-1 by membership rows (`routes/dm.ts:937-1017`,
  copied on purpose into `routes/dm.ts:356-409`); the relay finds it by key
  (`findOrCreateDmChannel`, `routes/federation/dmChannels.ts:65-139`). When a
  relay-created row holds the key with different member rows, local create
  inserts a second row with the same key and the unique index answers 500.
- #344 added `toDmChannelWire` and `loadOpenDmChannels`
  (`utils/dmChannelWire.ts:23-41`, `:65-156`), used by ready, `GET /api/dm` and
  `buildDmChannelPayload`. Seven emitters still build a `DmChannel` by hand:
  `routes/dm.ts:309-318` (reopen broadcast), `:450-457` (`ensureOneOnOneDmChannel`),
  `:1002-1016` and `:1066-1073` (`POST /api/dm`), `:1243-1250` (group create),
  `:1803-1817` (add member), and `routes/federation/events/membership.ts:285-300`
  (group bootstrap, through `as unknown as DmChannel`). Most omit `name`, `icon`
  and the owner home identity. The shared type makes `federatedId` required
  (`packages/shared/src/types.ts:382`) and every other field optional
  (`:383-391`).

Client (`packages/web/src`):

- `dmChannels`, `channelOriginMap` and `dmAlternatives` are written by
  `populateFromReady` (`stores/spaceStore.ts:1089-1181`) and
  `reloadDmsForOrigin` (`:384-465`, near-identical merge code, both dedup by
  `federatedId`, first origin wins), `completeListedDms` (`:76-127`),
  `addDmChannel` (`:350-359`, dedup by channel id only, no origin),
  `recordDmAlternative` (`:361-368`), `applyIncomingDmChannel`
  (`utils/dmMessageRouting.ts:144-157`), `deliverAsNewConversation` (`:97-110`,
  which writes `federatedId: null` itself), `rekeyDmChannel` and the two pin
  functions (`utils/dmOriginFailover.ts:20-163`).
- Three keys are in use: channel id (`addDmChannel`, `removeDmChannel`),
  `federatedId` (the merges, `resolveDmChannelId` at `stores/spaceStore.ts:1434-1447`)
  and home user id (`findExistingDmForUser`, `:1272-1289`).
- The home-pin rule (`repinDmsToHomeCopies`) is a separate pass that callers must
  remember to run after a merge: `hooks/useWebSocket.ts:213`,
  `utils/dmMessageRouting.ts:48` and `:152`, `stores/instanceStore.ts:367`. The
  manual re-attach reload in `components/modals/settingsPanels/AccountPanel.tsx:125`
  does not.

What broke: servers up to 1.6.1 listed DMs without `federatedId`, and since
1.6.0 an unknown channel id makes the client reload that list, so a client
connected to two instances showed every mirrored conversation twice (#344).
The review of #344 found two more ways a key decided in one place disagrees
with another: a key the client derives can fold two rows the same peer holds
for one pair and hide the live one (fixed in #344 by the same-listing guard in
`completeListedDms`), and a `null` a peer stated cannot be told from a `null`
the client wrote in `deliverAsNewConversation`, so an unkeyed peer copy is
folded into the home row and its messages are hidden (open, #345).

Constraints:

- Mixed versions. The web client is served by the instance at origin `''`, so
  home payloads always match the client's version. Sibling instances can be
  older, including 1.6.1 and earlier.
- The 1-on-1 key bytes cannot change: every deployed peer computes them.
- Group keys are random and cannot be derived from the members.
- Deriving a key in the browser needs Web Crypto, so a secure context.
- No S2S protocol change is wanted for this: the relay already carries what the
  receiver needs (the group key, or the participants of a 1-on-1).

## Decision

### 1. The conversation key

- **1-on-1:** `oneOnOneKey(a, b)`, the hash above over `homeIdentityOf(u) =
  u.homeUserId || u.id`, byte-identical to today. Every 1-on-1 row stores it
  from insertion, whether or not relay is on and whether or not a member is
  homed elsewhere. A key is a label, not a switch: whether anything is relayed
  is decided by the member set (`relayTargetOrigins`,
  `utils/federationOutbox.ts:434-447`), and `queueDmRelay` already runs for every
  DM message regardless of the key (`routes/dm.ts:2369`, `ws/events.ts:862`).
  Keyed native pairs already exist today through call start.
- **Group:** `mintGroupKey()`, a random UUID, minted once, on the instance where
  the group first gets a member homed elsewhere (group create or add member),
  together with the owner home identity. Never recomputed. A group no other
  instance holds keeps `NULL`.
- **Server-side meaning of null:** on a server that implements this ADR,
  `federatedId: null` means exactly "a group no other instance holds a copy of".
  Such a row can never be a mirror.
- **Backfill:** yes. At startup, in `initDatabase` right after
  `backfillOneOnOneDmMembership` (`packages/server/src/db/index.ts:57`), a
  synchronous sweep gives every 1-on-1 row (`owner_id IS NULL`, exactly two
  members, not deleted) whose key is `NULL` or differs from `oneOnOneKey` of its
  members the right key: re-key in place, or merge into the row that already
  holds it. This is `reconcileDmChannelFederatedId`
  (`routes/federation/reconciliation.ts:27-77`) widened to `NULL` keys; it
  replaces the drift sweep that today runs only when federation workers start
  (`utils/federationWorker.ts:1416-1422`), so relay-off instances heal too. It
  merges the two rows a relay-off 1-on-1 and its later relay-created copy leave
  on one instance. Groups are not backfilled (see 6).
- **Client-side key of a copy:** `federatedId` when it is a string, otherwise
  `local:<origin>:<channelId>`, which matches no other copy. Each copy also
  records where its key came from, as client state, never on the wire:
  - `stated`: a server sent a string.
  - `stated-null`: a server sent `null`. Never derived, never folded into
    another copy. On a current server this is an unshared group; on an older one
    it can also be an unkeyed 1-on-1, which is at worst a partial copy, and
    showing it as its own row hides nothing.
  - `derived`: only for peers on 1.6.1 or older, see 5.
  - `unknown`: no server has stated a key for this id yet
    (`deliverAsNewConversation`, or a legacy listing that could not be derived).
    The next listing that contains the id replaces it.

### 2. One server wire serializer

- `packages/server/src/utils/dmChannelWire.ts` is the only code that builds a
  `DmChannel`: `toDmChannelWire(row, members, lastMessage)` (exists),
  `loadOpenDmChannels(db, userId)` (exists) and `loadDmChannelWire(db,
  channelId, lastMessage?)` (today `buildDmChannelPayload` in
  `routes/federation/dmChannels.ts:22-56`, moved). Ready, `GET /api/dm`, both
  `POST /api/dm` responses, `ensureOneOnOneDmChannel`, group create, add member,
  the reopen broadcasts, re-attach and the group bootstrap all use them.
- In the shared `DmChannel` every field is required, nullable where the row can
  be null: `federatedId`, `ownerId`, `ownerHomeUserId`, `ownerHomeInstance`,
  `name`, `icon` and `lastMessage` are `T | null`, `metadataUpdatedAt` is
  `number`. A literal that forgets a field does not compile. Payloads from peers
  of any version are typed `PeerDmChannel` (today `ListedDmChannel` in
  `web/src/utils/dmConversationKey.ts`), with optional fields, and only the
  client merge module reads that type.

### 3. Server find-or-create for 1-on-1s

`findOrCreateOneOnOne(db, a, b)` in `utils/dmConversation.ts` is the only code
that looks up or inserts a 1-on-1 row. Local create, `ensureOneOnOneDmChannel`
and the relay all call it; each keeps its own side effects (reopen and
`dm_reopen` relay, notifying the target, `lateBindFederatedCall`, the response
code). In one transaction:

1. The row whose `federated_id` is `oneOnOneKey(a, b)`. That row is the
   conversation. Its member set is made equal to the pair: a missing pair
   member is added; a member row whose user has the same home identity as a pair
   member under another local id is re-pointed to that member. A 1-on-1 never
   gets a third member.
2. Else a 1-on-1 row whose members are exactly `a` and `b` (the membership test
   today). After the backfill this only finds a row whose key drifted, which is
   reconciled as in 1 before it is returned.
3. Else insert with the key.

Looking up by key first removes the 500 on the unique index.

### 4. One client merge module

`packages/web/src/stores/dmConversations.ts`, pure functions with no store
imports. `spaceStore` holds its state as `dmConversations: Map<key,
DmConversation>`; a conversation is `{ key, copies: Map<origin, DmCopy>,
pinnedOrigin }` and a copy is `{ origin, channel, keySource }`. Operations,
each returning the next state and the list of pin moves:

- `mergeOriginListing(origin, listed, derivedKeys)`: a `ready` payload or a
  `GET /api/dm` reload. Replaces every copy from that origin.
- `upsertCopy(origin, channel, keySource)`: `dm_channel_created`, the create
  responses, and the unplaced entry for a message no listing placed (the module
  builds that placeholder; nothing else does). Returns the channel id of the
  conversation's pinned copy, which is where the UI navigates.
- `removeCopy(channelId)`: `dm_channel_closed`, close, leave.
- `patchCopy(channelId, patch)`: members, owner, metadata, last message, user
  updates.
- `setOriginAvailable(origin, available)` and `dropOrigin(origin)`: failover
  and instance removal.

Rules that live only here:

- **Pin rule:** the copy of the user's home (`getLayoutHomeOrigin()`) when it is
  present and connected; else the current pin, if its copy is present and
  connected; else the first connected copy in insertion order. A returning
  sibling never takes the pin back. This replaces `repinDmsToHomeCopies` and the
  choice in `failoverDmOriginsFromDisconnected`.
- **At most one copy per key and origin.** A second copy from the same origin
  under one key keeps its own local key rather than being dropped (the #344
  same-listing guard, generalised).

`dmChannels` (the pinned copy of each conversation, sorted by
`sortDmChannels`), `dmAlternatives` (or an equivalent channel-id index that
`resolveDmChannelId` reads), and the DM entries of `channelOriginMap` and
`channelLastMessageIds` are derived from `dmConversations` after every
operation and written nowhere else. Pin moves are applied by one effect
function, the chat-store and URL half of today's `rekeyDmChannel`.
`findExistingDmForUser` stays as a lookup that saves a `POST`; it does not
decide identity.

### 5. Mixed versions

- **Peers at #344 or later, before this ADR:** they state a key for every row
  they keyed and `null` for the rest (native pairs, relay-off 1-on-1s, unshared
  groups). The client takes the `null` as `stated-null`. Permanent behaviour.
- **Peers on 1.6.1 or older:** their `GET /api/dm` omits `federatedId` and the
  group metadata; their `ready` states them. The #344 rules move into the
  module's `completePeerListing`:
  1. A field that is absent takes the value of the previous copy with that
     origin and channel id, including its `keySource`, unless that was
     `unknown`. A row the client saw in that origin's `ready` therefore keeps
     what `ready` stated, `null` included, which settles the open finding in
     #345.
  2. Still unknown, a 1-on-1 with a member homed elsewhere, in a secure context:
     the derived key (`deriveMissingOneOnOneKeys`, byte-identical to the server).
  3. A derived key shared by another entry of the same listing is dropped.
  4. Otherwise `unknown`.
- **Removal:** rules 1 to 3, the derivation code and the optional fields of
  `PeerDmChannel` are removed in the first minor release that is at least two
  minor releases after the first release containing #344, and only once opt-in
  telemetry has shown no instance on 1.6.1 or older for 30 days. After removal,
  such a peer's reloaded copies show as their own rows until its next `ready`.
- **Older web clients on an upgraded peer** dedup by `federatedId` as before;
  the new keys on native pairs match nothing.
- **S2S:** unchanged. 1-on-1 relay events still carry the participants and no
  key, and the receiver computes it with the same function.

### 6. Not covered

- A group copy that a client first learns from a 1.6.1 peer through the reload
  shows as its own row until that peer's next `ready`: group keys cannot be
  derived.
- A page not served from a secure context skips the derivation against 1.6.1
  peers.
- Legacy groups that have a member homed elsewhere but no key (created while
  relay was off) get none: a key alone does not create the peers' copies.
- Message identity (`sourceMessageId` dedup, `FederationMessageRef`, the rule
  that only the pinned copy's messages enter the list, #295) is unchanged.
- Space channels in `channelOriginMap` are not part of this.

### Migration plan

One lane, in this order. Each step leaves the suites green. Server and client
tracks are independent; the client's compat rules cover servers that have not
moved yet.

1. **Key module.** Create `server/src/utils/dmConversation.ts` with
   `homeIdentityOf`, `oneOnOneKey`, `mintGroupKey`. Remove `computeFederatedId`
   (`utils/federationOutbox.ts:345-355`) and move its callers:
   `routes/dm.ts:412-423`, `:1028-1040`, `:1217-1236`, `:1756-1782`,
   `routes/federation/events/dmMessages.ts:133-136`,
   `routes/federation/reconciliation.ts:45-47`, `test/helpers/dmScope.ts`. Call
   start (`ws/events.ts:1779-1796`) reads the key and computes or mints nothing;
   a row without one is not announced to peers.
   Add one test vector shared with `web/src/utils/dmConversationKey.test.ts`.
2. **Backfill.** Move `reconcileDmChannelFederatedId`
   (`routes/federation/reconciliation.ts:27-77`) into the key module, widen it
   to `NULL` keys, replace `reconcileDriftedDmFederatedIds` (`:85-110`) with
   `backfillOneOnOneKeys(sqlite)` called from `db/index.ts:57`, remove the worker
   call (`utils/federationWorker.ts:1416-1422`), update the import in
   `routes/federation/handlers/attach.ts:19`.
3. **Find-or-create.** `findOrCreateOneOnOne` replaces the lookup and insert in
   `POST /api/dm` (`routes/dm.ts:937-1059`), in `ensureOneOnOneDmChannel`
   (`:356-443`), and `findOrCreateDmChannel` (`routes/federation/dmChannels.ts:65-139`,
   caller `events/dmMessages.ts:137-141`). Test: a relay-created row with other
   member rows, then `POST /api/dm` answers 200 with that row.
4. **Serializer.** Make the shared type all-required
   (`shared/src/types.ts:380-392`). Move `buildDmChannelPayload` into
   `dmChannelWire.ts` (callers `events/dmMessages.ts:245`,
   `events/dmState.ts:512`, `handlers/attach.ts:302`). Replace the literals at
   `routes/dm.ts:309-318`, `:450-457`, `:1002-1016`, `:1066-1073`,
   `:1243-1250`, `:1803-1817` and `events/membership.ts:285-300` (the cast at
   `:299` goes). In the same file, batch the last-message `or(...)`
   (`utils/dmChannelWire.ts:112-115`) and take the memberships the ready builder
   already read (`ws/handler.ts:1407-1414`). Test: each emitter's payload equals
   `loadDmChannelWire` for its row (extend `routes/dm.listShape.test.ts`).
5. **Client module.** Create `web/src/stores/dmConversations.ts` with the state,
   operations, key sources, `completePeerListing` (ported from
   `stores/spaceStore.ts:76-127` and `utils/dmConversationKey.ts`) and the pin
   rule (from `utils/dmOriginFailover.ts:20-75` and `:146-163`), with unit tests
   ported from `spaceStore.reloadDms.test.ts`, `spaceStore.dmAlternatives.test.ts`
   and `dmOriginFailover.test.ts`.
6. **Listings.** Route the DM part of `populateFromReady`
   (`stores/spaceStore.ts:1089-1181`) and `reloadDmsForOrigin` (`:384-465`)
   through `mergeOriginListing`; derive `dmChannels`, `dmAlternatives` and the
   DM entries of `channelOriginMap` and `channelLastMessageIds`. Delete the
   `repinDmsToHomeCopies` calls (`hooks/useWebSocket.ts:213`,
   `utils/dmMessageRouting.ts:48`, `:152`, `stores/instanceStore.ts:367`).
7. **Incoming events.** `applyIncomingDmChannel` (`utils/dmMessageRouting.ts:144-157`)
   and `deliverAsNewConversation` (`:97-110`) call `upsertCopy`;
   `recordDmAlternative` (`stores/spaceStore.ts:361-368`) goes;
   `resolveDmChannelId` (`:1434-1447`) reads the derived index.
8. **UI create sites** call `upsertCopy('', channel, 'stated')` and navigate to
   the id it returns: `components/ui/UserProfilePopout.tsx:111`,
   `components/chat/FriendsPage.tsx:170`, `components/layout/DmSearchBar.tsx:308`,
   `components/modals/UserProfileModal.tsx:201`,
   `components/modals/NewDmModal.tsx:104`,
   `components/modals/AddDmMemberModal.tsx:181`. `addDmChannel`
   (`stores/spaceStore.ts:350-359`) goes.
9. **Remaining writers** go through `patchCopy`, `removeCopy`, the availability
   operations, or a re-sort of the derived view: `setDmChannels`
   (`stores/spaceStore.ts:348`) and its callers `stores/chatStore.ts:431-437`,
   `:752-754`, `:821-822`, `utils/dmMessageRouting.ts:68-76`; `removeDmChannel`
   (`stores/spaceStore.ts:485-491`, from `hooks/useWebSocket.ts:1130`);
   `addDmMember`, `removeDmMember`, `updateDmOwner`, `updateDmMetadata`
   (`:493-535`); `closeDm`, `leaveDm` (`:538-554`); `updateUserEverywhere`
   (`:920-931`); the DM part of `removeInstanceSpaces` (`:1291`); failover from
   `stores/instanceStore.ts:903`, `:920`, `:1166`. `rekeyDmChannel`
   (`utils/dmOriginFailover.ts:81-127`) shrinks to the pin-move effect.
   `setDmChannels` goes.
10. **Docs.** `client-federation.md` "DM Origin Failover" and "WS event routing
    contract" (`:215-243`); `dm-system.md:80` and `:87` (a 1-on-1 is keyed at
    insert), `:600` (the inbound broadcast reaches every member, as
    `processCreateEvent` does), `:978-980`; `websocket.md:238` (a federated
    user's `ready` carries its DMs); `federation.md:866`.

## Alternatives considered

- **Keep deciding per path and fix each drift as it is found.** This is how the
  area got here. #344 fixed one drifted path; its review found two more; every
  new DM feature adds a path that must re-implement the same dedup, and the
  seven client writers already use three different keys.
- **Identify a conversation by channel id plus origin, with no cross-instance
  key on the client.** Every copy would be its own row. A client connected to
  two instances sees both copies by design, and failover needs to find the
  sibling's copy of the pinned conversation, so a shared key is needed either
  way. A canonical pair key of the form `host:id` (considered in #344) can never
  equal the SHA-256 keys the servers already send.
- **Make the server authoritative for display: show only the home instance's
  DMs and read siblings' lists never.** One list and no client dedup, since
  every conversation reaches the user's home by relay. It loses: a conversation
  started on a sibling is invisible until its relay reaches home, and never
  while that peering is pending (today the sibling's `dm_channel_created` is the
  only notice); no DMs at all while home is unreachable, which is what DM origin
  failover exists for; and a session on a federated account whose home is not
  connected. The pinned-copy rule already gives the main benefit (one copy's
  messages per conversation) without giving up availability.
- **Have the client derive every key and ignore the server's.** Group keys
  cannot be derived, the browser needs a secure context, and two
  implementations of the hash would have to stay byte-equal forever. Derivation
  stays only as compatibility with 1.6.1.
- **Respect a stored `null` without provenance.** The client writes `null`
  itself for unplaced entries, so a stored `null` cannot say who wrote it; either
  choice is wrong for one of the two cases. Provenance on the copy resolves it
  without giving `null` a second meaning on the wire.
- **Key groups at creation as well, so no row is ever `NULL`.** Minting a group
  key also sets the owner home identity, which the client uses to route owner
  actions (`getOwnerInstanceForDm`, `stores/spaceStore.ts:1414-1417`); every
  local-only group would change routing for no dedup gain, since it has no
  copies.
- **No backfill.** Unkeyed legacy 1-on-1s would stay, the server would keep a
  membership dedup next to the key dedup, and a relay-off 1-on-1 would keep
  splitting into two rows on one instance once relay is enabled. The backfill is
  one startup sweep over code already used for re-attach.

## Consequences

Rules for every later change:

- Never build a `DmChannel` by hand: on the server only `utils/dmChannelWire.ts`
  does; on the client only the merge module builds the unplaced placeholder.
- Never compute or mint a conversation key outside `utils/dmConversation.ts`
  (server) or `stores/dmConversations.ts` with `utils/dmConversationKey.ts`
  (client compat).
- Never insert a 1-on-1 row except through `findOrCreateOneOnOne`.
- Never dedup DMs outside the merge function. Never write `dmChannels`,
  `dmAlternatives` or DM entries of `channelOriginMap` outside the merge module;
  a new path that learns of a copy calls `upsertCopy` or `mergeOriginListing`.

Easier: a new DM event or UI entry point cannot disagree about identity or
pinning, and the rules are testable as pure functions. Harder: every DM list
change, down to a last-message preview, goes through a module call, and
`spaceStore` loses `setDmChannels` and `addDmChannel`. Every boot runs the key
sweep over all 1-on-1 rows (the drift sweep already visits every keyed one).
The room name of a call between two users of the same instance becomes the
pair key (`routes/livekit.ts:74`).

Not tested: mixed versions are covered by unit tests with fixtures in the 1.6.1
wire shape and by the two-instance e2e harness, not against a real 1.6.1
binary. The cases in "Not covered" stay as described.
