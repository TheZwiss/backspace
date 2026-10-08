# Voice, Video & Calls System

Source files:
- Server: `routes/livekit.ts`, `ws/handler.ts`, `ws/events.ts`
- Client: `hooks/useLiveKit.ts`, `stores/voiceStore.ts`, `utils/voice.ts`, `utils/voiceActions.ts`, `utils/screenShare.ts`
- Shared: `packages/shared/src/constants.ts` (bitrate matrix, resolutions)
- Audio: `audio/AudioManager.ts`, `audio/SpeakingDetector.ts`

---

## Voice Channel Join Flow

1. Client sends `voice_join { channelId }` via WS
2. Server checks CONNECT permission, enforces one-room-per-user
3. Server loads voice restrictions from DB (space mute/deafen)
4. Server broadcasts `voice_state_update { action: 'join', channelElapsedSeconds }` to space. `channelElapsedSeconds` is the whole occupied duration computed by the server, so client/server clock skew cannot change the channel timer; the client advances it from receipt time on one shared, visibility-aware one-second beat. The duration survives participant joins and reconnect grace, and resets when the last participant leaves.
5. Client calls `POST /api/livekit/token { channelId }` → gets JWT + LiveKit URL
6. Client connects to LiveKit room with token

### Voice presence bootstrap on mid-session space join

A client learns who is sitting in a space's voice channels from the WS `ready`
payload at connect time. Joining a space *without reloading* therefore needs the
same bootstrap for the new space, or its voice channels render empty until a
refresh. The server pushes a scoped `space_voice_state` snapshot from
`ConnectionManager.addUserSpace` (the single join chokepoint), and after a role
change to each member it may reach (`space_access_changed`), built by
`buildSpaceVoiceState(spaceId, userId)` — the same VIEW_CHANNEL-filtered helper
that feeds `ready`. The client applies it via `utils/voiceStateSync.applySpaceVoiceState`.
See `docs/systems/websocket.md` → "Mid-session space join" for the full rationale
(single ordered channel, no snapshot-vs-stream race).

### Microphone pre-arm (iOS user-gesture discipline)

`utils/voice.preArmMicrophone` (called by `joinVoiceChannel`, `startDmCall`, `joinDmCall` and `acceptIncomingDmCall`) fires `AudioContext.resume()` and `AudioManager.setInputDevice(inputDeviceId)` (which ends in `getUserMedia({audio:…})`) **synchronously inside** the click handler, before the `connectFn(channelId)` call. iOS Safari only surfaces the microphone permission prompt when `getUserMedia` is invoked from inside an active user-gesture; the original flow only acquired the mic in `useLiveKit`'s `syncMic` effect, which fires AFTER `room.connect()` resolves (token fetch + WS handshake), many awaits past the gesture window. iOS PWA standalone is especially strict and would silently never surface the prompt; the user would see "Waiting for others to join…" indefinitely until they locked/unlocked the device (which iOS treats as a fresh activation).

Pre-arm is fire-and-forget: the mic acquisition runs in parallel with the LiveKit handshake, and `AudioManager.inputSwitchChain`'s serialization guarantees `useLiveKit.syncMic`'s subsequent call short-circuits on the already-acquired `currentStream` (no double prompt, no second `getUserMedia`).

### Listener mode (`micPermissionDenied`)

When the user denies the prompt (or has previously denied at the OS level), the pre-arm's `setInputDevice` rejects with `NotAllowedError`. The `voiceStore.micPermissionDenied` flag is set to `true` and the LiveKit connect proceeds anyway — the user appears in the voice channel as a connected participant who can hear others but has no microphone publication. `useLiveKit.syncMic` checks the flag at the top of its body and skips the publish branch entirely.

The flag clears via:
- `requestMicPermission()` (in `utils/voice.ts`) — must be called from a user-gesture handler (button click). Clears `AudioManager.inputDenialError` cache, calls `setInputDevice` from a fresh activation. On success, sets `micPermissionDenied=false` and `useLiveKit.syncMic` re-fires (dep on `micPermissionDenied`) to publish the freshly acquired track.
- `voiceStore.leaveVoice()` / `handleForceDisconnect()` / `resetSession()` / `reset()` — flag resets so the next join attempts a fresh prompt.

UI affordances:
- **Mobile (`MobileVoiceFullScreen`):** banner below the header reads "Microphone access denied — You're listening only". A right-aligned "Allow microphone" button calls `requestMicPermission()`.
- **Desktop (`VoiceControlBar`):** *(Future)* — same listener-mode state needs a parity affordance. Desktop is unaffected by the iOS gesture-window bug in practice (browsers there prompt on `getUserMedia` regardless of activation state), but if a desktop user denies the prompt, the same flow applies.

`AudioManager.inputDenialError` caches the most recent `NotAllowedError`. Subsequent `setInputDevice` calls re-throw the cached error rather than firing a second `getUserMedia` — iOS otherwise would queue a second prompt that has lost its activation, leading to a silent hang. Cleared by `AudioManager.clearInputDenial()` (called from `joinVoiceChannel`'s pre-arm and from `requestMicPermission`).

**Token grants (space channels):**
- SPEAK → can publish MICROPHONE + CAMERA
- STREAM → can publish SCREEN_SHARE + SCREEN_SHARE_AUDIO
- Missing permission → grant excludes those sources

**Token grants (DM calls):** Always full (canSpeak=true, canStream=true)

**Identity format:** `{userId}:{username}`, TTL: 1 hour, Room: `{channelId}` or `dm-{dmChannelId}`

**Multi-tab:** Each user has one `voiceWs` binding. New tab → old socket gets `voice_disconnected { reason: 'displaced' }`

**Transient reconnects:** Closing the voice-owning WebSocket starts a 60-second
server grace period instead of immediately removing the participant. A
`voice_join` for a space session, or `voice_status` for a DM call (which has no
`voice_join` event), received from the replacement socket rebinds the existing
session without a leave/join broadcast. A status message alone cannot claim a
space voice session from an ordinary second tab. Explicit leave, moderator
disconnect, displacement, and rejected joins remain terminal and clean up
immediately — a join refused for the room the user is still holding ends that
session on the spot rather than letting it idle out the grace period.

A short LiveKit reconnect is not a leave for the sounds: `SoundController` counts the user in the room while `voiceConnectionStatus` is `reconnecting` (`isInVoiceRoom`), so neither the disconnect nor the join cue plays, and it keeps its participant and stream-watcher baselines until the room is connected again (a full reconnect drops every remote participant in between). `useLiveKit` sets `isLiveKitConnected` and the status in one update, for a signal resume (`SignalReconnecting`) as for a full reconnect. A reconnect that gives up plays the disconnect cue.

On the client, a LiveKit disconnect is terminal only for `DUPLICATE_IDENTITY`,
`PARTICIPANT_REMOVED` and `ROOM_DELETED`. Every other reason keeps
`currentVoiceChannelId` so the session can be resumed, and surfaces a Retry
action (`VoiceControls` on desktop, `MobileVoiceMiniBar` on mobile). Because the
channel ID outlives the connection, `joinVoiceChannel` treats re-selecting the
current channel as a reconnect whenever `voiceConnectionStatus` is
`disconnected`, and as a no-op otherwise.

---

## DM Call State Machine

States: `ringing` → `active` → destroyed

A call's rules depend on its conversation. A 1-on-1 call ends when either side
ends or declines it. A group call is shared: members come and go, and it ends
only when nobody is left in it. The room records which kind it is when it is
created (`DmRoomMeta.group`, from `isGroupConversation` in
`utils/dmConversation.ts`: every DM row that may not be a 1-on-1, so an owned
row or a row with a UUID key).

| Event | 1-on-1 | Group | State |
|-------|--------|-------|-------|
| `dm_call_start` | Room created, caller bound, 60s timeout starts | same | ringing |
| `dm_call_incoming` | Broadcast to DM members (excludes caller) | same | ringing |
| `dm_call_accept` | First accept: ringing→active, caller and acceptor seated | same; later accepts join the running call (late join) | active |
| `dm_call_reject` | Room destroyed, `dm_call_rejected` to all members | Decliner added to `declinedUserIds`, `dm_call_rejected` to the decliner only. If the call still rings and every member but the caller has declined, it ends as in a 1-on-1. Ignored from the caller or a participant | destroyed, or unchanged |
| `dm_call_end` | Room destroyed, `dm_call_ended` to all members | From the caller of a call nobody joined: ends it. From a participant: that participant leaves (`voice_state_update` leave), and the call ends when it was the last one. From anyone else: ignored | destroyed, or unchanged |
| Timeout (60s) | Still ringing: room destroyed, `dm_call_ended` | same (nobody but the caller joined) | destroyed |

Ends go through `ConnectionManager.endDmRoom`, which unbinds the voice
sessions, sends a `voice_state_update` leave for each participant still
seated, then the end event. A ringing call its caller leaves behind by
starting another call or joining a voice channel ends the same way, through
`endRingingCallsPlacedBy`, and its end is relayed to the peers. A leave the
ConnectionManager makes itself (voice-session grace, account deletion, a
relayed seat moving a member out of another room) goes through
`leaveCurrentRoomAnnounced`, which tells the room's viewers and ends a DM call
it leaves empty. The group
rules live in `leaveGroupDmCall` and `declineGroupDmCall` on the
ConnectionManager, used by both the local handlers (`ws/events.ts`) and the
relayed ones (`routes/federation/events/calls.ts`).

**Starting a call in a DM that has one.** `dm_call_start` in a DM whose call
is hosted here joins that call for a member who is not in it (the same path as
`dm_call_accept`), so two members pressing call at once end up in one call. A
member already in it (a participant, or the caller of a call still ringing,
from another tab) gets `error { code: 'dm_call_in_progress', dmChannelId }` on
the sending socket only. So does any member while the DM's call hosted on
another instance is live: a second call here would split the conversation, and
the host minted the room tokens when its call started, so a late join through
this instance is not possible. The client clears its calling state on that
refusal. That call counts as live while its record here still rings (the
host's end or the 60 s ring timeout ends that), or while a member here is in
it (`FederatedCallEntry.joinedUserIds`). The starter's own place in it counts
only while another of their sessions holds it: the socket that starts a call
holds none, and a place no voice session holds any more is gone, so the
starter leaves it first (`leaveJoinedFederatedCall`). Any other record is one
the host's end never replaced (a 1.8.0 host ends a call on a voice-session
grace or a voice channel join without telling its peers, and a relay can be
lost). It is dropped, and the start goes on. This holds for 1-on-1 and group
calls alike.

**Client.** The DM header call button (desktop `MainContent`, mobile
`MobileChatScreen`) becomes a join button when the DM's instance reports
people in its call (`voiceUsers` for the DM id, `isDmCallRunning`).
`joinDmCall` does what accepting a ring does: sets `activeDmCall`, sends
`dm_call_accept` and connects within the click. A call that is still ringing
has nobody seated, so the button still reads start there; the server turns that
start into a join. `dm_call_accepted`, `dm_call_ended` and `dm_call_rejected`
change the client's call state only when they name the call it holds
(`dmCallEventIsOurs`: the DM id, or the conversation key through the DM list).
Every member of a DM hears each accept (late joins included) and the call's
end, and a member calling another DM, in another call, or in a voice channel
must stay where it is.

A refused `dm_call_accept` carries a code too, on the sending socket only:
`dm_call_not_found` when the call is gone by the time the accept arrives,
`not_dm_member`, or `validation_failed`, with the call id the client sent in
`dmChannelId`. A client that joined that call on its side (`joinDmCall`, the
incoming modal) leaves it again on `dm_call_not_found` or `not_dm_member`.

**Edge cases:**
- Starting a new call, or joining a voice channel, ends any other call the same caller still rings, and the end is relayed to the peers (`endRingingCallsPlacedBy`; the voice join seats the user first, so the end does not unbind the new session)
- Socket close during ringing → auto-cleanup
- Socket close during ringing also relays the end to the peers
- Participants drop to 0 in active state → room destroyed, also when the last one leaves through a voice-session grace expiry, by joining another room, or through account deletion (`forceDisconnectUser`), and the end is relayed to the peers (the ring-timeout fan-out hook covers the ConnectionManager's own ends)
- `ready` does not report a ringing group call to a member who declined it, so a reload within the ring does not ring them again

---

## Federated DM Calls

DM calls work across federated instances. The caller's instance hosts the LiveKit room; remote clients connect to it directly. Call signaling is relayed to ALL active federation peers via synchronous HTTP POST (not the outbox worker). This ensures calls ring on every instance where a participant is connected, even if the DM is local-only on the caller's instance.

### Universal Relay

All `dm_call_*` signaling events (`start`, `accept`, `reject`, `end`) are relayed to every active federation peer in parallel. Each `sendCallRelay` call has a 10-second HTTP timeout. This bypasses the outbox worker — call signaling is latency-sensitive.

**Auto-peering at send time.** If the target origin has no active peer record, `sendCallRelay` races an `ensurePeered` handshake against a 3 s deadline (`CALL_PEERING_TIMEOUT_MS`). On success the relay POSTs normally; on timeout it returns `peer_transient_failure` without aborting the background handshake, so a subsequent attempt typically succeeds. Typing (`sendTypingRelay`) passes `peeringTimeoutMs: 0` — the POST is skipped for non-active peers and a warm-up `ensurePeered` runs in the background.

**Call relay failure surface.** Every `dm_call_{start,accept,reject,end}` relay is failure-aware. On failure the originating server emits a `dm_call_undeliverable` event with a `phase` discriminator identifying which action failed. Client copy is phase-specific; state rollback depends on the phase.

| `phase` | `terminal` | Emitted when | Client action |
|---------|------------|--------------|---------------|
| `start` | true | No plausible recipient after targeted-peer fan-out; ring room destroyed. | Clear `outgoingCall`, disconnect LK, warning toast. |
| `start` | false | Some targeted peers failed but reachable recipients remain; ring continues. | Keep state; info toast. |
| `accept` | true | Acceptor's B→host relay failed; optimistic state is rolled back on B. | Clear `activeDmCall` + `incomingCall`, disconnect LK, warning toast. |
| `accept` | false | Host → peer fan-out of accept failed; local host call continues. | No state change; info toast. |
| `reject` | false | Rejector's relay to host failed OR host's fan-out after a local reject failed; state already cleared. | No state change; info toast. |
| `end` | false | Ender's relay to host failed OR host's fan-out after a local end failed; state already cleared. | No state change; info toast. |
| `host_unreachable` | true | A FederatedCallEntry's `federatedCallHost` peer transitions out of `active`, OR the 30s sentinel detects a non-active host for an existing entry. | Clear `activeDmCall` + `incomingCall`, disconnect LK, warning toast (*"Call ended — {label} became unreachable."*). |
| `no_recipient` | true | Remote returned 200 but had no reachable recipient (Path A: all members offline; Path B: zero participant matches). Caller fast-fails within the relay round-trip; ring room destroyed. | Clear `outgoingCall`, disconnect LK, warning toast (*"{peerLabel} couldn't ring anyone."*). Folds into multi-failure info copy when not the sole failure. |

A `start` failure with the reason `identity_not_accepted` was never sent: the caller is a federated account here whose home is a third instance, which that peer does not accept from this instance (federation.md, "Who a call relay names"). It is terminal or not like any other start failure, and its toast is the generic *"Call to {peerLabel} could not be placed."*. An `accept` relay to the host fails the same way, terminal, when the host would accept no name for the member.

**Accept-rollback semantics.** `handleDmCallAccept` Path 2 transitions the `FederatedCallEntry` to active and broadcasts `dm_call_accepted` optimistically so the acceptor's UI flips immediately. If the B→host relay fails, the server clears the entry, fans `dm_call_undeliverable { phase: 'accept', terminal: true }` out to all ringed users on B (via `sendToFederatedCallUsers`), and the client tears its call state back down.

**Reject / end are optimistic.** Local state is cleared before the relay is awaited because the user's intent is to terminate. If the relay fails, the originator receives an informational `dm_call_undeliverable { terminal: false }` so they know remote peers may briefly display stale state; no local rollback.

**Group calls across instances.** The group rules above hold on both sides
when both run this version. `FederationCallPayload.perMember` says so on the
wire: the host sets it on a group call's `dm_call_start` ("I apply the group
rules and relay the end to every peer"), and an entry holder sets it on a
group member's relayed `dm_call_accept` ("I will tell you when this member
leaves, also when they just go away"), `dm_call_end` and `dm_call_reject`
("only this member left or declined; I keep the call for my other members").
Peers up to 1.8.0 never send it.

- *Host.* A relayed `dm_call_accept` of a group call that carries `perMember` seats the remote member in the room under their local row (`DmRoomMeta.remoteParticipants` records the peer that relayed them), so the room is not empty while they are in it and voice states list them. A seat they hold in another room here is left first, and told (`leaveCurrentRoomAnnounced`), so that room cannot stay active and empty. An accept without `perMember` (a 1.8.0 peer, or any 1-on-1) seats nobody: such a sender does not relay a member's leave when they close the tab, so the call ends with its last seated participant, as in 1.8.0. A relayed `dm_call_end` with `perMember` takes that member out and ends the call only when they were the last one in; a relayed `dm_call_reject` with `perMember` only records the decline. Either one from a member who is not in the call changes nothing. When a group call ends, `dm_call_end` goes to every peer that homes a member, the sender too, since its other members may still be ringing. Every relay the host signs names, per peer, a user that peer accepts (`callRelayActor` in `utils/callFanout.ts`): the member whose action it was when they are homed on the host or on that peer, the caller otherwise, and nothing is sent to a peer that accepts neither. A peer refuses an actor homed on a third instance, so a relayed accept or 1-on-1 end passed on to the other peers names the caller, not the remote member who acted; the accept says who answered in `answeredBy`. The start follows the same rule, so a federated account here whose home is a third instance cannot ring members on other peers (federation.md, "Who a call relay names"). When a peer leaves `active`, `onPeerDeactivated` calls `dropRemoteCallParticipants`, which takes that peer's members out of the calls hosted here and ends a call it leaves empty.
- *Entry holder.* `FederatedCallEntry.group` is set only for a group call whose `dm_call_start` carried `perMember`. `handleDmCallAccept` Path 2 records the acceptor in `FederatedCallEntry.joinedUserIds` (any call) and binds their voice session to the accepting socket (`setVoiceWs`); a `voice_status` from a new socket rebinds it after a reconnect. Before that the acceptor leaves the voice room they hold here and any other call hosted on a peer. Path 2 `dm_call_end` from a joined member drops them and relays the end with `perMember`; from anyone else it is ignored and nothing is relayed. Path 2 `dm_call_reject` from a member not in the call removes them from `ringedUserIds`, sends `dm_call_rejected` to that member only and relays the decline with `perMember`. In both cases the entry stays for its other members until the host's own `dm_call_end` says the call is over.
- *A member who goes away.* A joined member also leaves without hanging up: their voice session is gone past the reconnect grace (a closed tab, a reload, a lost network), they join a voice channel or another call here, they send `voice_leave` here (the client does when it joins voice on another instance), or their account is deleted. `leaveJoinedFederatedCall` (registered as `setFederatedCallLeaveHook` for the ConnectionManager's own cases) takes them out of `joinedUserIds`. In a group call it relays `dm_call_end` with `perMember`, so the host drops their seat and ends the call with its last participant. In any other call (a 1-on-1, or a group call from a 1.8.0 host) nothing is relayed, as in 1.8.0, where only a hang-up ends such a call: the member only stops counting as in the call here, which is what lets a later start through (see "Starting a call in a DM that has one").

How a 1.8.0 peer and this version meet:

| Case | What happens |
|------|--------------|
| Host here, a member on a 1.8.0 peer joins | The 1.8.0 accept has no `perMember`, so the member is not seated, as with a 1.8.0 host. The call ends with its last seated participant; voice states do not list them. |
| Host here, a member on a 1.8.0 peer hangs up | The 1.8.0 peer ends the call for all its own members and relays the end without `perMember`. Its members were never seated, so members here and on other peers stay in. (A seat that peer relayed in with `perMember` before, if any, is taken out, and a call that leaves empty ends.) |
| Host here, a member on a 1.8.0 peer declines | The 1.8.0 peer stops the ring for all its members and relays the decline without `perMember`. The host records the decline; the call goes on. A ringing call ends on its 60 s timeout unless someone answers. |
| Host here, call ends | The end reaches a 1.8.0 peer as before; it ends the call for its members. |
| Host on a 1.8.0 peer, members here | The `dm_call_start` has no `perMember`, so the entry here keeps the 1.8.0 rules: a member's end or decline ends the call for every member here and is relayed, without `perMember` on the accept, end or decline. The 1.8.0 host ends the whole call on it, as it always did. A member who goes away without hanging up only leaves the entry here; nothing is relayed. |
| Accepts in either direction | A 1.8.0 host does not seat remote acceptors. A host here seats only an acceptor of a group call whose accept carries `perMember`, which only this version sends. |

**Ring-timeout fan-out.** When the host's 60 s ringing timeout fires without an accept, `dm_call_end` is fanned out to all remote peers so stranded Path-A/B ringees on other instances exit their ring state instead of lingering. Registered via `connectionManager.setRingTimeoutFanoutHook` from the WS events module. The same hook (`fanOutCallEnd`) relays the other ends the host makes on its own: a ringing caller's socket closing, the last participant's voice grace running out, account deletion, a peer's participants dropped by `dropRemoteCallParticipants`, a relayed seat that empties another call, and a group call ended by a relayed end or decline.

**Remaining edge.** A remote participant's leave reaches the host only through a relayed `dm_call_end`, sent on a hang-up or when their entry holder sees them go (above). If that relay fails while the peer stays `active`, the host keeps them seated and the group call does not end when everyone else leaves; it ends when the peer stops being active or the server restarts. The other direction: if the host's final `dm_call_end` does not reach an entry holder, its entry no longer refuses a start once nobody there is in the call, and it is dropped once its 60 s ring window has closed (`dropFederatedCallIfIdle`). When a non-host participant ends an active 1-on-1 call and the relay to the host fails, the host's `activeDmCall` marker lingers until manual end: LK `ParticipantDisconnected` tears down the voice UI but does not clear the DM-call marker on the host side. This is the caller-side mirror of the remote-participant problem and is not covered by the Remote-Participant Host Unreachable Eviction mechanism above (which only reasons about FederatedCallEntry state). Tracked separately.

### Remote-Participant Host Unreachable Eviction

When a FederatedCallEntry's `federatedCallHost` becomes unreachable (peer status transitions to `unreachable`, `needs_attention`, `rejected`, or `revoked`), the entry owner evicts the stranded state and notifies its local ringed users with `dm_call_undeliverable { phase: 'host_unreachable', terminal: true }`. Two signals drive the eviction:

1. **Fast path (`onPeerDeactivated` hook):** every peer-status transition out of `active` invokes `ConnectionManager.evictFederatedCallsForHost(peerOrigin, ...)`. Call sites are listed in the `onPeerDeactivated` docstring (audit via `grep onPeerDeactivated(`).
2. **Backstop (30s sentinel):** `runFederatedCallSentinelTick` in `federationWorker.ts` iterates active entries, looks up each distinct `federatedCallHost`'s current peer status, and evicts non-active matches.

Typical eviction latency is ~90s (time for outbox traffic to fail the unreachable threshold + one sentinel tick). Worst case on an idle instance with no outbox traffic is ~15.5min (health-check cadence + sentinel).

Covers the ringing and active states on the remote-participant side. The caller-side mirror — host's own `activeDmCall` lingering when its LK room empties silently — is a separate, documented out-of-scope edge.

### Dual-Path Processing

When a peer instance receives a call relay, it uses one of two delivery paths:

| Path | Condition | Delivery |
|------|-----------|----------|
| **A** | DM exists on the receiving instance | Look up `dm_members` for the local `dmChannelId` and deliver to connected members |
| **B** | DM does not exist on the receiving instance | Match participants by `homeUserId + homeInstance` identity against connected WebSocket users |

Path B enables calls to ring for federated users even when no local DM channel has been created yet (e.g., first contact via a federated call).

### FederatedCallEntry

The in-memory call state (`FederatedCallEntry`) is keyed by `federatedId` (not `dmChannelId`):

- `dmChannelId` is **nullable** — null for Path B scenarios where no local DM channel exists
- `ringedUserIds` tracks all users who were notified of the incoming call, used for end-call cleanup. A group decliner is removed from it
- `joinedUserIds` tracks the local users in the call through this instance, each with their voice session bound here; in a group call only they can end their part of it, and while it is non-empty (or the call still rings) a start in the DM is refused
- `group` is set at creation when the conversation is a group (from the local row, or from the key's shape when there is none, Path B) and the host's `dm_call_start` carried `perMember`
- The 60 s ring window set at creation keeps running after the first accept: members here who were rung may still answer until it closes. A call still ringing then ends; an answered one with nobody here in it is dropped silently, at once if that happens after the window (`leaveFederatedCallEntry` / `dropFederatedCallIfIdle`). Silent, because a member in the call through another instance must not be told it ended
- `callerId`, `callerHomeUserId`, `callerHomeInstance` identify the caller across instances

### Late-Bind dmChannelId

When the relayed first message creates a local 1-on-1 copy (`findOrCreateOneOnOne`, then `lateBindFederatedCall` in `processCreateEvent`) during an active federated call (e.g., the first message arrives while a call is ringing), it binds the `dmChannelId` on the existing `FederatedCallEntry`. This transitions the call from Path B to Path A delivery without interrupting the call.

### Token Generation & Room Identity

**Token generation:** `generateFederatedCallToken(federatedId, homeUserId, displayName)` in `routes/livekit.ts` issues 5-minute tokens scoped to the `federatedId` room (not the local `dmChannelId`). Grants full DM permissions (mic, camera, screen share, subscribe, data channel).

**Token audience (`sendFederatedCallStart`, `ws/events.ts`).** These tokens are bearer credentials for the call room, so each `dm_call_start` relay is built per recipient and carries tokens **only for the DM members that recipient homes**. Consequences:

- A DM whose members are all local produces **no relay at all** — the function returns before any token is minted. Peers never learn that a purely local call happened.
- Only instances that home a DM member are contacted. An active peer with no party to the DM receives nothing.
- The caller's own token is never relayed (the caller joins via `POST /api/livekit/token`; both inbound paths in `routes/federation/events/calls.ts` skip the caller anyway), and no peer receives a token minted for a member homed on a different instance.
- On the receiving side, both Path A and Path B skip a local member for whom the host sent no token instead of dispatching a `dm_call_incoming` with an unusable token. A local member homed on a third instance — a client-federation connection — is rung by their own home instance, which is the one the host minted their token for.
- `participants` stays the complete roster: it is non-secret and Path B needs it for identity matching.

**LiveKit URL:** The relay sends `config.livekit.url` (e.g., `wss://nova.ddns.net/livekit`). Must be `wss://`, not `https://` — the LiveKit SDK requires a WebSocket URL.

**Token endpoint:** `POST /api/livekit/token` uses `federatedId` as the room name when the DM channel has a `federatedId` set, ensuring both instances join the same LiveKit room.

**Identity format:**
- Federated calls: `${homeUserId}:${displayName}` — stable across all instances
- Local calls: `${userId}:${username}` — unchanged

**Client identity resolution:** For federated calls, the client splits the LiveKit participant identity on `:` and matches `homeUserId` against the DM member list (which stores `homeUserId` for all members). This resolves the correct display name and avatar regardless of which instance the participant is on.

### Client-Side Call Routing

**Each call slot carries its own reference (`DmCallRef`, `stores/voiceStore.ts`).** `incomingCall` and `activeDmCall` hold `dmChannelId` (the conversation's id on the instance the call goes through, null only when that instance has no copy, Path B), `federatedCallId` (the call's key) and `callOrigin`; a ring also holds its LiveKit credentials (`livekit`) until the connect uses them once. `outgoingCall` is always hosted on the conversation's own instance. A ring that arrives during a call therefore never changes where the call's hang-up goes or which token a Retry uses. `dmChannelId` never holds the key: `utils/dmCall.ts` derives the origin (`dmCallOrigin`), the id LiveKit connects under (`dmCallRoomKey`, the key for Path B) and the conversation the client can open (`dmCallChannelId`, the copy another connection has under the key, used by "return to call", the DM headers and the mobile call screens through `useActiveDmCall`).

**`callOrigin`:** Set to the WS origin that delivered the `dm_call_incoming` event (the home instance), NOT the call host URL. Null means the conversation's own origin. Accept/reject/end route through this WS. The home instance's server finds the `FederatedCallEntry` and relays to the host via S2S HTTP. This is reliable regardless of whether the client has a multi-instance WS to the host. `sendDmCallEnd` is the one place a client ends a call; every hang-up goes through `handleDisconnectAction`.

**Accepting (`acceptIncomingDmCall`):** Sets `activeDmCall` from the ring and clears `incomingCall` directly in the click handler. It does not wait for the server's `dm_call_accepted` response (races with `connectFn`'s async AudioContext resume). Starting, joining and accepting a call arm the microphone inside the tap (`preArmMicrophone`, see "Microphone pre-arm"). The desktop video button starts or joins the same call and turns the camera on once LiveKit has connected (`turnCameraOnInDmCall`).

**`dm_call_accepted` enters the call only for the caller** (the session with `outgoingCall`, when the event names that call). An acceptor entered it in the click. Being LiveKit-connected says nothing: a session sitting in a voice channel while the call was answered on another device stays out.

**Who answered.** The server names the member who answered in `dm_call_accepted.answeredBy`, by federated identity (`userRelayIdentity` for a member here; the relayed `answeredBy`, or `acceptor` from a 1.9.0 peer, for a member elsewhere). The client clears `incomingCall`, and with it the ringtone, only when the event names the ringing call and the member who answered is the signed-in user (`acceptStopsRing`, `isMyIdentity`: home user id and home host). In a group call another member's answer therefore leaves the ring on, so this member can still join until the ring window closes; the user's own answer on another session stops it. An event without `answeredBy` (a server up to 1.9.0) stops it as before.

**One call at a time across instances.** Joining a voice channel on another instance than the DM call goes through sends `voice_leave` to the call's instance (which leaves the call there as a voice join would) and cancels a call still ringing there; entering a DM call sends `voice_leave` to a voice channel on another instance than the call's (`clearSpaceVoiceForDmCall`). On the same instance the server's own `voice_join` / `dm_call_accept` does it. A `ready` from an origin that reports no call tears down only a call that goes through that origin.

**Passive ready handler:** On page refresh/restart, the ready payload includes active calls but the client does NOT auto-connect to LiveKit. Users must re-accept. This prevents identity slot wars when the same user has multiple sessions.

**A DM call has no `currentVoiceChannelId` (space↔DM are mutually exclusive).** Entering a space channel clears `activeDmCall` (`setCurrentVoiceChannel`); entering a DM call must clear `currentVoiceChannelId`. The latter is done by `clearSpaceVoiceForDmCall()` (`utils/voice.ts`), invoked synchronously at the top of `connect()` when `isDm`. Without it, `VoiceChannel` renders the occupant list for `currentVoiceChannelId` from the **live LiveKit participants**, so a lingering space `currentVoiceChannelId` maps the DM call's participants onto the old space channel — the caller/acceptor appears to still be sitting in it. The server already drops the user from the space room (`dm_call_start` / `dm_call_accept` → `leaveCurrentRoom` → `broadcastRoomLeave`), so this is a client-state fix; it also optimistically removes self from the old channel's `voiceUsers` for an immediate sidebar update. Regression test: `utils/clearSpaceVoiceForDmCall.test.ts`.

**Caller connect guard.** In `dm_call_accepted`, the caller connects to the DM room gated on `wasOutgoingCall` (only the initiating session ever sets `outgoingCall`) — **not** on `!isLiveKitConnected`. A caller already sitting in a space voice channel is LiveKit-connected; gating on that would skip the DM connect and strand them in the space channel. `connect()` de-dupes an already-connected same room, so `wasOutgoingCall` alone is sufficient.

**DM-call teardown never disconnects a space connection (`teardownDmCall`).** The `dm_call_ended` / `dm_call_rejected` / terminal `dm_call_undeliverable` handlers all route through `teardownDmCall()` (`useWebSocket.ts`), which clears the call UI/federation state and tears down LiveKit **only when `currentVoiceChannelId` is null**. `disconnectFn()` tears down whatever room is active, and a space channel and a DM call are mutually exclusive (`setCurrentVoiceChannel` clears `activeDmCall`). The load-bearing case: when the **last** participant in a DM call joins a space voice channel, their post-connect `voice_join` empties the server-side DM room, so `broadcastRoomLeave` (`events.ts`) broadcasts `dm_call_ended` back to every DM member — including them. Without the guard, that echo would `disconnectFn()` the space room they just connected to, stranding the UI on "Connecting…" until a manual rejoin. The first participant to leave is unaffected (room still occupied → no `dm_call_ended`). Regression test: `hooks/teardownDmCall.test.ts`.

### SoundController Federation Awareness

A participant id is the call's instance's row id, or, in a federated call while the DM is not resolved (when `activeDmCall` is cleared during disconnect), the LiveKit identity's home user id. `SoundController`'s `isSelf(id)` accepts both: the id the call's instance gave the user (`getMyUserIdForOrigin` of `voiceSessionOrigin`: the voice channel's origin, or the DM call's `dmCallOrigin`; `''` when there is no call, so the session row's `id` counts only when there is no call or the call is on the page's instance) and the user's home identity id (`homeIdentityOf(user, '').userId`). Without either, the user's own join and leave would play the sounds for someone else's. The identity rule is client-federation.md §5.

**Disconnect teardown:** `roomRef` is set to `null` before calling `destroyRoom()`. This prevents `ParticipantDisconnected` events (fired during teardown) from triggering `updateParticipants`, which would cause `user_leave` sounds for departing participants alongside the disconnect sound.

**Sound effects.** The full system-sound inventory and trigger map lives in
`docs/systems/sounds.md`. This includes the `stream_watch` data-channel
protocol used for viewer detection (mirroring the existing `deafen`
data-channel ping receiver in `handleDataReceived`).

---

## Voice Moderation

Three independent muting mechanisms:

### 1. User Self-Mute/Deafen
- Client toggles in `voiceStore`
- Broadcasts via `voice_status` WS event. Every control goes through `handleMuteAction` / `handleDeafenAction` (`utils/voiceActions.ts`): the desktop control bar, the channel sidebar, and through `toggleMuteFromControl` / `toggleDeafenFromControl` (which read the space restrictions with `getSpaceEnforcementState`) the mobile call screen, the mobile mini bar and the keybinds. The store's `toggleMic` / `toggleDeafen` alone change only local state
- If also space-muted, remains effectively muted

### 2. Space Mute/Deafen (moderator, persisted)
- Requires MUTE_MEMBERS / DEAFEN_MEMBERS permission
- Stored in `voice_restrictions` table (survives reconnect)
- In-memory: `spaceMutedUsers` / `spaceDeafenedUsers` sets (`"spaceId:userId"` keys)
- On voice_join: restrictions loaded from DB into memory
- Broadcasts `voice_space_muted` / `voice_space_deafened` to all space members

### 3. Permission Mute (automatic, ephemeral)
- Triggered when user loses SPEAK permission (role update)
- `checkVoicePermissions(spaceId)` re-evaluates all users in space voice
- NOT persisted — derived from role permissions on demand
- Broadcasts `voice_permission_muted`

**Effective state:** `effectiveMuted = isMuted || spaceMuted || permissionMuted`

### Move & Disconnect
- `voice_move`: Requires MOVE_MEMBERS. Same space only. Preserves voice status.
- `voice_disconnect`: Requires DISCONNECT_MEMBERS. Full teardown.
- Space mute/deafen, move and disconnect of another member also require outranking them in the role hierarchy (permissions.md, "Role hierarchy"); a refusal is a WS `error` with `code: 'role_hierarchy'`.

---

## Screen Sharing

### Resolution & Framerate Options
```
Standard resolutions: 540, 720, 1080, 1440, 2160 (+ 'native')
Standard framerates: 30, 45, 60, 75, 90, 120
Width map: 540→960, 720→1280, 1080→1920, 1440→2560, 2160→3840
```

### VP9 Bitrate Matrix (kbps)
```
       30    45    60    75    90    120
540:  1500  2000  2500  2800  3200  4000
720:  3000  3500  4000  4500  5000  6000
1080: 6000  7000  8000  9000  10000 12000
1440: 10000 12000 14000 16000 18000 22000
2160: 20000 24000 28000 32000 38000 45000
```

### Config Object
```typescript
ScreenShareConfig {
  height: number | 'native',       // Resolution or capture at display res
  fps: number,                     // 30-120
  mode: 'gaming' | 'text',         // Content hint and degradation priority
  customBitrateKbps: number | null, // Admin override (if allowed)
  shareAudio: boolean,              // System audio loopback (see Platform Support below)
  codec: 'vp9' | 'h264'             // Persisted codec preference
}
```

### Build Pipeline (`buildScreenShareOptions()`)
1. Resolve bitrate from matrix (custom > override > default > native estimate)
2. Clamp to instance limits (minBitrateKbps, maxBitrateKbps)
3. Select the persisted codec: VP9 (default) or H.264
4. Configure a VP8 simulcast backup at reduced framerate/bitrate; room dynacast pauses it when no subscriber needs it
5. Content hint: `'detail'` (text) or `'motion'` (gaming)
6. Degradation preference: preserve resolution for text, balanced for gaming

### Native Mode
- Captures at display's full resolution
- Snaps to nearest known tier for bitrate lookup
- Scales proportionally: `baseKbps * (capturedPixels / knownPixels) * (fps / knownFps)`

### Codec and sender parameters
- H.264 uses an SDP profile override only during its publish negotiation; the
  hook is removed in `finally` so later camera or microphone negotiations are
  unaffected.
- Selecting H.264 does not guarantee hardware encoding. The negotiated codec
  and `encoderImplementation` reported by WebRTC stats are shown in the
  connection inspector. If Chromium reports the OpenH264 software fallback,
  the publisher also receives a localized warning. Requested publication state
  is tracked separately from the codec confirmed by outbound stats, so codec
  changes can be serialized without presenting the requested value as a
  negotiated result. Stats inspection retries briefly while the sender or
  encoder implementation is still unavailable.
- Sender parameters set the chosen bitrate ceiling and framerate with high
  priority. Application starts immediately, retries at bounded intervals until
  a real `RTCRtpSender` encoding is available, and always re-asserts the values
  at 5 seconds after Chromium's bandwidth estimate converges. The same bounded
  scheduler runs after LiveKit reconnects and screen-track restarts, where the
  sender may again be temporarily absent or expose a placeholder encoding.
  Capture constraints are applied once per scheduler run rather than on every
  sender retry. The non-standard
  `minBitrate` member was removed because Chromium discarded it during WebIDL
  dictionary conversion; it never enforced a bitrate floor.

### Instance-Level Limits (admin-configured)
- `allowedResolutions`, `allowedFramerates` (CSV in instance_settings)
- `maxResolution`, `maxFramerate`, `maxBitrateKbps`, `minBitrateKbps`
- `allowCustomBitrate` toggle
- `bitrateMatrixOverrides` (JSON sparse overrides)

**Whose limits apply.** The instance that issued the LiveKit token, not the user's home: its SFU carries the stream and its admin set the caps. `useLiveKit.connect` records that origin in `voiceStore.livekitHostOrigin` when it fetches the token (`getApiForOrigin(getChannelOrigin(channelId))`, for space channels and DM calls alike; `''` = home) and asks that instance for its document with `settingsStore.fetchStreamingLimitsFor(origin)` on every join. A token relayed through S2S for a federated DM call hosted elsewhere records `null`: the client holds no session there, so the defaults apply. `utils/streamHostLimits.ts` resolves the recorded origin: `getStreamHostLimits()` feeds `buildScreenShareOptions` and `resolveNativeOverdrive`, and `useStreamHostLimits()` feeds `StreamQualityControls`, `StreamTile`'s quality label and the live-settings effect in `useLiveKit`, whose dependencies include the limits so a document that arrives after the share started is applied to the running encoder. Home's document stays in `settingsStore.streamingLimits` (it also carries home's discovery flags); others live in `settingsStore.streamingLimitsByOrigin`. A failed refresh keeps the last document that host sent; an origin that never answered falls back to the defaults, never to home's document. `StreamHostSubtitle` shows "Limits set by <host>" under the Stream Settings title (popover and setup drawer) when the host is not home, and the custom-bitrate line names the host.

**Effective config, never written back.** `effectiveScreenShareConfig(config, limits)` (`utils/screenShare.ts`, pure) fits the saved config to the host's limits at use time: nearest allowed height (a disallowed `'native'` becomes the highest allowed height, and only-native allowed gives `'native'`), nearest allowed frame rate, and the custom bitrate dropped where not allowed or clamped to the range. An empty allowlist leaves its value alone. `buildScreenShareOptions`, `resolveNativeOverdrive`, the highlighted pills and the stream tile label all use it. Nothing writes the fitted values into `screenShareConfig`: the saved choice is the user's, so a strict host (or a stricter home policy) caps this stream without lowering the next one. Only a click in the controls saves.

**Enforcement is client-side only.** LiveKit's `VideoGrant` has no bitrate, resolution or frame-rate field, and the publish goes from the client straight to the SFU without passing the Backspace server, so no instance can enforce these caps on a modified client. The host's server takes part only when it issues the token. Server-side enforcement would need a LiveKit feature, not a Backspace protocol change.

### Start flow — `ScreenShareSetup` (stage, then publish)

Every screen share starts from one screen, `ScreenShareSetup` (mounted once in `App.tsx`, opened through `screenShareSetupStore`). The control-bar button, the keybind, the mobile call screen and "Change stream" on the local tile all open it; nothing calls capture directly.

The pipeline in `utils/screenShare.ts` is **stage → publish**:

| Step | Function | What happens |
|------|----------|--------------|
| Stage | `stageScreenCapture()` | `getDisplayMedia()` with constraints built from `screenShareConfig`. Returns a live but **unpublished** `MediaStream`, previewed in the setup screen. Browsers open their native prompt here, so it must run inside a click. |
| Tune | `applyStagedCaptureConfig(stream)` | Re-applies resolution/frame rate/content hint to the staged track when the config changes. Local only, no SFU renegotiation — the reason quality can be adjusted after picking. |
| Publish | `publishScreenShare(room, stream, { sourceId, pickerMode })` | `publishTrack()` for the video track (source `ScreenShare`; codec, `screenShareEncoding`, dynacast-managed VP8 simulcast backup) and, when System Audio is on at Start, the audio track if present (source `ScreenShareAudio`; high-quality stereo music preset). Audio captured while the toggle is now off is not published: it is stopped where the desktop app can capture it again, and set aside elsewhere. Sets `isScreenSharing`, retries sender parameters until the sender is ready, and re-asserts them after bandwidth estimation converges. |
| Cancel | `stopStagedCapture(stream)` | Stops the staged tracks. Closing the setup screen never sends a frame. |

The card is a fixed, near-viewport `glass-modal` surface (viewport width minus 6 rem, capped at `max-w-6xl`, 88 % of the app-scaled height) so the layout never jumps with its content. Where the app lists sources, a segmented control under the header switches **Screens / Windows** (with a window search field on the Windows tab). Browsers and system-picker mode have no such control: their picker decides, and the stage reports what came back instead. The source area is a **stage**: the app's thumbnail grid, or in browsers and system-picker mode an empty stage (monitor illustration, "Choose screen" button) that becomes the full-size live preview once staged.

**What was captured.** The ready bar's kind and name come *only* from a tile the app enumerated and the user clicked (`isScreen` → "Screen" / "Window", plus the source name). Nothing is read off the captured track: `MediaTrackSettings.displaySurface` looks like the right source for this and is not — Firefox omits it, and Electron on a Wayland portal session reports `window` for a whole monitor — and Firefox's `track.label` names a monitor after picking a window there. A confidently wrong label is worse than none, so browser and portal captures show the plain "Ready to go live" and let the live preview, which is the ground truth everywhere, speak for itself.

The quality panel is a **drawer** that slides in over the stage from the right with a scrim. It opens from the **Stream settings** button in the footer's action pill (icon + label, icon-only on phones, next to Cancel / Start) or from the footer summary line; its own close button, the scrim, and Escape (before the screen) close it. It starts collapsed on every open.

Source picking differs by platform, the rest of the screen is identical (drawer, summary + Cancel/Start in the footer):

- **Electron, current desktop:** the renderer lists sources up front via `getScreenSources()` (IPC `get-screen-sources`). Clicking a tile sends `preselectScreenSource(id, shareAudio)` (IPC `screen-share-preselect`) and then calls `getDisplayMedia()`; the main process's display-media handler answers from the preselection without prompting. Double-click on the staged tile starts.

  One source is staged on open without being asked, chosen by `pickAutoStageSource()` (`utils/screenShareSources.ts`): the source shared last time if it is still in the list, otherwise the machine's only screen, otherwise nothing. `voiceStore.lastScreenShareSourceId` is persisted and written on a successful **Start**, not on a pick, so a capture the user backed out of is not what comes up next time; a browser or portal capture has no id of ours and stores `null`. Screen ids (`screen:0:0`) survive a restart, window ids (`window:12345:0`) are session handles and stop matching, which is the fallback rather than a failure. A remembered window switches the grid to the Windows tab so the highlight sits where the preview does. Staging publishes nothing, so this costs the user only the preview being ready.
- **Electron, older desktop (no `getScreenSources`):** the "Choose" card calls `getDisplayMedia()`; the main process pushes its source list (`onScreenShareSources`) and the grid appears inline; a tile click answers the in-flight request with `selectScreenSource(id)`. Kept because the desktop app loads whatever web client its instance serves, so version skew in both directions is real.
- **Electron, system picker (`getScreenSharePickerMode()` → `'system'`, i.e. a Wayland session):** the compositor's screencast portal picks. Listing sources would open the portal on every open, so nothing is enumerated; the "Choose" card (hint: "Your system will ask…") calls `getDisplayMedia()`, the main process enumerates inside the request, the portal returns the single chosen screen or window, and main answers with it directly (no one-tile grid). The renderer sends `setScreenShareAudioPreference(shareAudio)` ahead of the request since no tile carries it. One source per share is inherent to the portal; there is no app-wide grant.
- **Browser:** the "Choose" card calls `getDisplayMedia()` and the browser's prompt does the picking. Chrome and Firefox show their "sharing" banner from this moment even though nothing is published until Start.

A `shareAudio` change after staging is honoured at Start where it can be: turned off, the staged audio is not published; turned on, the desktop app adds loopback audio right after Start when the capture came from a tile it listed in picker mode `'app'` (`canAddScreenShareAudioLater(selectedId, pickerMode)`). Only where that does not apply (browsers, system-picker and prompted desktop captures) does the screen show the re-pick note. `handleStart` passes the tile's id and the picker mode to `publishScreenShare` for that reason. Codec changes while live go through `republishScreenShare(room)`: the same `MediaStreamTrack` is unpublished and published again under the new options, so no re-capture and no second prompt. `handleScreenShareUnpublished` ignores the unpublish that this swap emits.

**Who broadcasts the stop.** `voice_status` is what carries `isScreenSharing` to clients that are not in the LiveKit room (`MobileSpacesScreen`, `MobileVoiceJoinSheet` read `wsStatus?.isScreenSharing`), so every stop has to emit it or a stale "sharing" indicator stays up. `stopScreenShare()` and `handleScreenShareUnpublished()` each call `broadcastVoiceStatus()` themselves rather than leaving it to their callers, which covers all four routes: the control-bar button, the stream-tile "Stop Streaming" item, `changeScreenShare()`, and the OS/browser stop bar arriving via `RoomEvent.LocalTrackUnpublished`. Callers must not repeat it.

Exactly one broadcast per stop. `unpublishTrack` emits `LocalTrackUnpublished` *synchronously*, so an explicit stop reaches `handleScreenShareUnpublished()` in the middle of `stopScreenShare()`; a `_stopping` flag makes the handler defer to the caller, the same way `_republishing` makes it ignore a codec swap. Unpublishing is per publication rather than per loop, so a throw on the video track cannot leave the screen-share audio published after `isScreenSharing` has already gone false. A republish whose fresh publish fails broadcasts too — the swap suppressed the handler and a publish that never landed emits no rollback event, so nothing else would. All three are pinned by `utils/screenShare.stopPaths.test.ts`.

`handleScreenShareUnpublished(room)` returns whether the share is over, and `useLiveKit` drops the local stream from the watched set on `LocalTrackUnpublished` only when it is. A republish (a codec swap, a full reconnect) keeps it, or your own tile would flicker until `LocalTrackPublished` puts it back.

**A share, not a publication.** `participants[].isScreenSharing` says whether a participant's share is live, and a republish of the same share does not end it. Every consumer (the stream tiles, the `stream_started` / `stream_ended` cues, the sharer's watcher set in `SoundController`) reads that one field, and `updateParticipants` fills it from the authority each side has:

- **Our own share** (`isLocal`): `voiceStore.isScreenSharing`, the lifecycle `utils/screenShare.ts` keeps. It turns true once `publishScreenShare` has published, stays true through a republish of the same share, and turns false on `stopScreenShare`, `handleScreenShareUnpublished` (OS stop bar, source ended), a republish whose fresh publish fails, or a full reconnect that did not bring the share back. `updateParticipants` re-runs when it changes. `connect()` clears it (and `isCameraOn`) before the first participant update of a new room, since nothing is published there yet. Two things republish a share:
  - Our codec swap, `republishScreenShare`: its unpublish runs under `_republishing`.
  - A full LiveKit reconnect. livekit-client (2.22.3, `Room.handleSignalRestarted` → `LocalParticipant.republishAllTracks`) unpublishes every local track while the room is `Reconnecting`, publishes the same tracks again, and only then goes `Connected`; a republish that throws is logged and the room goes `Connected` anyway, a restart that fails ends in `Disconnected`. A screen-share unpublish seen while `Reconnecting` therefore only records the room (`_reconnectingRoom`). `settleScreenShareAfterReconnect(room)`, called by `useLiveKit` on `Connected` and on `Disconnected`, ends the share with its usual broadcast when no `ScreenShare` publication came back, and turns the System Audio switch off when the audio did not come back. A source that ends during a reconnect is caught the same way: nothing publishes it again.
- **A remote share**: a `ScreenShare` publication exists (subscribed or not), or the sharer announced a republish and the tracker below is bridging its gap.

So the sharer hears no `stream_ended` / `stream_started` for its own codec change, and its watcher set is not cleared: `SoundController` clears it only when the sharer's own share really starts or ends. Viewers who resume after the republish stay in it, and their later "Stop Watching" plays `stream_user_left` as usual. Mixed versions: a viewer older than `stream_republish` loses the stream at the republish without sending `watching: false` (automatic teardowns never ping, see `docs/systems/sounds.md`), so it stays in the sharer's set until it watches and stops again or leaves; the only effect is a missing `stream_user_joined` when it clicks Watch again.

**Viewers across a republish.** A viewer sees a republish as one publication removed and another added, the same shape as a share ending and a new one starting. Before it unpublishes, `republishScreenShare` sends `{ type: 'stream_republish' }` on the reliable data channel (wire format in `utils/streamWatchProtocol.ts`, listed with `stream_watch` in `docs/systems/sounds.md`). A send failure is logged and the swap goes ahead. The viewer side is `StreamRepublishTracker` (`utils/streamRepublish.ts`), keyed by the sharer's LiveKit identity. There is one per room, created in `connect()` and kept in a module-level `WeakMap<Room, StreamRepublishTracker>`: the room's event handlers use their own room's tracker, and `updateParticipants` looks up the current room's. The remote-track handlers (`TrackPublished`, `TrackUnpublished`, `ParticipantDisconnected`, `DataReceived`) act only while their room is `roomRef.current`, so a replaced room's teardown events cannot end, bridge or cancel a share in the room the user is now in.

| Viewer event | Tracker | Effect |
|---|---|---|
| `stream_republish` received | `announced` (window starts) | none yet |
| `TrackUnpublished` (ScreenShare) while announced | `bridging` (window restarts) | the watch, stream volume and stream mute are kept; `updateParticipants` keeps `isScreenSharing` true for the sharer, so the tile stays and no `stream_ended` / `stream_started` cue fires |
| `TrackUnpublished` (ScreenShare) with no announcement | none | the share ends: unwatch, clear volume and mute, as before the message existed |
| another `stream_republish` while bridging (codec toggled again before the new track arrived) | stays `bridging`, window restarts, the further republish is remembered | none yet |
| `TrackPublished` (ScreenShare) while bridging | cleared, or back to `announced` when a further republish was remembered | subscribed when the viewer is watching; the `ScreenShareAudio` that follows is subscribed by the existing watch-state branch |
| `STREAM_REPUBLISH_WINDOW_MS` (15 s) passes while bridging | cleared | the share ends, with its `stream_ended` cue |
| the window passes while only announced, or a new publication arrives first | cleared | nothing |
| `ParticipantDisconnected` while bridging | cleared | the share ends |

The window is 15 s because livekit-client fails a publication the server has not accepted within 10 s. A republish that fails therefore leaves viewers with a stalled tile for up to 15 s before the share ends.

Only a removal that follows the announcement bridges, which keeps mixed versions safe. An older viewer does not recognise the message (it matches neither `stream_watch` nor `deafen`) and loses the stream as before. A newer viewer watching an older sharer never gets an announcement, so every removal ends the share. If the announcement arrives after the removal (the data channel and the signal channel are separate paths), the share has already ended and the late announcement lapses with its window. The viewer is not re-subscribed and no state is left stuck. The resume sends no `stream_watch` ping, so the viewer plays no cue of its own.

**Viewers across a full reconnect.** A full LiveKit reconnect cannot be bridged that way. livekit-client (2.22.3) replaces the reconnecting participant on the server, so every other client sees the sharer leave (each publication removed, then `ParticipantDisconnected`) and join again, and on its own side `Room.handleRestarting` drops every remote participant before the room goes `Reconnecting`. The connection is already gone when this starts, so nothing can be announced first. Viewers remember instead: `StreamResumeMemory` (`utils/streamResume.ts`, one per room like the republish tracker, in the module-level `_resumeMemories`), keyed by the sharer's LiveKit identity, which survives the reconnect.

| Event on the viewer | Memory | Effect |
|---|---|---|
| `TrackUnpublished` (ScreenShare) not bridged, or the sharer leaving while bridged, and the viewer was watching | remembered for `STREAM_RESUME_WINDOW_MS` (15 s) with its stream volume and mute | the share ends as before (`stream_ended`, watch dropped) |
| `stream_stop` from the sharer, before or after the removal | forgotten, or the removal that follows is not remembered | none |
| `stream_resume` from the sharer while remembered | waits for the publication | once the sharer has a ScreenShare publication (now or on `TrackPublished`): watch, volume and mute restored, subscribed, `stream_watch { watching: true }` sent so the sharer's watcher set has the viewer again. No viewer cue |
| the viewer's own room goes `Reconnecting` | windows wait (`hold`) | none |
| the viewer's own room is `Connected` after that | every remembered share waits for its publication, whatever the sharer runs | as for `stream_resume`; publications already in the room are resumed at once, later ones on `TrackPublished` |
| the window passes, or the room goes away | forgotten | none |

The sharer sends `stream_resume` from `settleScreenShareAfterReconnect` when its full reconnect published the share again and the room is `Connected`, and `stream_stop` whenever its share ends for good (`stopScreenShare`, before unpublishing and without waiting for the data channel; `endLocalShare`; a failed republish). On its own side a `ParticipantDisconnected` while its room is not `Connected` is the reconnect's own unwind (the server reports a leave only over a live signal connection), so the viewer is not evicted from the watcher set; at `Connected` after a full reconnect `retainWatchers` keeps only the viewers present again, and a viewer that is gone plays `stream_user_left` then. A full reconnect that starts straight from `Connected` (no signal resume tried first) is not told apart: its viewers are evicted with the cue and come back with `stream_user_joined` when they resume.

Mixed versions: an older sharer sends neither signal, so its viewers forget the share after the window and only their own full reconnect inside it resumes the watch. An older viewer ignores both and loses the share as before. A viewer that stopped watching is not remembered, and a new share started without a reconnect is never watched unasked.

Stream state for a remote sharer is keyed by `resolveParticipantUserId(identity)`, the same function `updateParticipants` lists participants under and so the id `StreamTile` watches by. In a federated DM call it resolves the home id in the LiveKit identity to the DM member's local id. It reads the DM membership, not the participant list, because a sharer who leaves is dropped from that list by the first `TrackUnpublished` of the teardown, before the screen share's own removal and `ParticipantDisconnected` arrive.

`StreamQualityControls` is the shared quality panel (resolution, frame rate, content mode, codec, bitrate, system audio; it shows the effective config and saves only on click); `ScreenShareSetup` and `ScreenShareSettingsPopover` both render it.

### Control-bar entry point (`VoiceControlBar`, `VoiceControls`)

The screen-share button is the **only** control-bar entry to screen sharing and its settings; there is no separate "video quality" button. Its behaviour depends on `voiceStore.isScreenSharing`:

| State | Click |
|-------|-------|
| Not sharing | `handleScreenShareAction()` → `openScreenShareSetup()` → the setup screen above |
| Sharing | Toggles `ScreenShareSettingsPopover` anchored to the button, rendered with `onStopSharing` |

`ScreenShareSettingsPopover` takes an optional `onStopSharing` callback. When present it appends a full-width `bg-accent-rose` "Stop Sharing" button below the stats footer; the control bars pass it (they have no other stop control), while the local `StreamTile` context menu omits it because it already carries its own "Stop Streaming" item. Quality changes made from the popover apply mid-stream through the `screenShareConfig` effect in `useLiveKit` (constraints + overdrive re-applied; a codec change republishes).

Both control bars close the menu whenever `isScreenSharing` drops to `false`, so a share ended elsewhere (the OS "Stop sharing" bar, `handleScreenShareUnpublished`, the keybind) never leaves a stale popover anchored to the button. The popover's click-outside listener ignores `mousedown` on its own anchor; the anchor's click handler is the sole owner of the open/close toggle (`ConnectionInfoPopover` follows the same contract).

### System Audio Loopback (`shareAudio`)

The "System audio" toggle in the quality panel adds an audio track to the screen-share publication. `stageScreenCapture` calls `navigator.mediaDevices.getDisplayMedia` directly (not through LiveKit) with constraints from `buildCaptureConstraints`, which include `restrictOwnAudio: true` when the toggle is on and `audio: false` when it is off. In Electron, the `setDisplayMediaRequestHandler` callback (`packages/desktop/src/main.ts`) returns `audio: 'loopback'` to opt into Chromium's system-audio loopback path.

Electron 43.4+ honors `restrictOwnAudio` in this custom-handler path: when the renderer sent it, the handler's `'loopback'` becomes Chromium's `loopbackWithoutChrome`, which leaves Backspace's own playback out ([electron/electron#52427](https://github.com/electron/electron/issues/52427), fixed by [#52455](https://github.com/electron/electron/pull/52455), backported to 43.4.0 in [#52533](https://github.com/electron/electron/pull/52533)). Blink only sends the constraint where `media::IsRestrictOwnAudioSupported()` holds (`media/base/media_switches.cc` and `third_party/blink/renderer/modules/mediastream/user_media_request.cc`, Chromium 150). Elsewhere it is dropped without an error and the capture is the whole output mix, the voice chat included, so viewers hear themselves:

| OS build | Backspace's own playback in System Audio | Why |
|---|---|---|
| Windows 11 (build 22000+) | left out (`excluded`) | WASAPI process loopback excluding the audio-service process tree. Chromium gates it on `base::win::Version::WIN11` |
| Windows 10, any build (22H2 is 19045), and Server 2022 (20348) | included (`included`) | below the WIN11 gate. The OS API is documented from build 20348, but Chromium does not use it there, and no feature flag lifts the gate |
| macOS 14.2+ | left out (`excluded`) | CoreAudio Tap excluding the audio-service process |
| macOS 13.0 to 14.1 | included (`included`) | ScreenCaptureKit loopback; the constraint needs CoreAudio Tap and is dropped |
| macOS 12 and earlier | no system audio (`unavailable`) | no loopback source |
| Linux | included (`included`) | monitor of the default PulseAudio sink, no exclusion |

`loopbackWithMute` is no alternative: it mutes the sharer's own output for the duration and still captures the whole mix. Forcing `'loopbackWithoutChrome'` from the handler on Windows 10 is not done: the id is undocumented, Windows 10 is below Microsoft's documented minimum for exclude-mode process loopback, and a failed activation could break System Audio for every Windows 10 user.

The desktop app's main process classifies the machine with `ownAudioInSystemAudio(platform, systemVersion)` (`packages/desktop/src/systemAudioCapability.ts`, the table above as code) and the renderer reads it through `getSystemAudioCapability()` (desktop.md, "System audio and Backspace's own playback"). `StreamQualityControls` shows the result under the System Audio switch through `systemAudioNote(platform, capability, checked)` (`utils/systemAudioNote.ts`): `included` and `unavailable` are an amber warning shown whether the switch is on or off, so it is read before System Audio is turned on; `excluded` is a quiet line shown once it is on. A desktop build without the method, an unreadable version (`unknown`) and a browser keep the earlier per-platform notes, shown once the switch is on.

Own-audio exclusion applies to all audio played by Backspace, including remote voices, notification sounds, and in-app YouTube, Vimeo, or Spotify embeds. Where it applies (Windows 11, macOS 14.2+), viewers no longer hear those embeds through a system-audio share, unlike in Backspace 1.1.2; play the media in a separate application when its audio needs to be shared.

**External audio routing.** A third-party audio router can replay call audio through a different process, outside Backspace's own-audio exclusion. If viewers still hear themselves, check this route as well as the capture settings. On macOS with SoundSource, add Backspace to **Settings → Audio → Excluded Applications** to bypass SoundSource processing of Backspace; see the [SoundSource manual](https://rogueamoeba.com/support/manuals/soundsource/?page=settings). Own-audio exclusion does not guarantee removal of copies replayed by external audio routers.

| Platform | Mechanism | Notes |
|----------|-----------|-------|
| Browser (Chrome/Edge) | `getDisplayMedia({ audio: true })` | Tab/window/system audio per the user's pick |
| Electron / Windows | Chromium WASAPI loopback | Works out of the box; Backspace left out only on Windows 11 (table above) |
| Electron / macOS 13+ | ScreenCaptureKit, CoreAudio Tap (Catap) from 14.2 | Requires `NSAudioCaptureUsageDescription` (set by `packages/desktop/electron-builder.yml#mac.extendInfo`) |
| Electron / Linux | PulseAudio loopback | **Requires** the `PulseaudioLoopbackForScreenShare` Chromium feature flag — enabled at startup in `main.ts` for Linux. Works on PulseAudio and on PipeWire systems with the `pipewire-pulse` compat layer. PipeWire-only systems without pulse compat will fail. |

**Changing the toggle mid-stream.** `syncScreenShareAudio(room)` (`utils/screenShare.ts`) makes the `ScreenShareAudio` publication follow `screenShareConfig.shareAudio`. The `screenShareConfig` effect in `useLiveKit` calls it first on every config change while sharing, on the same serialized chain as the other live updates. The video publication is never touched, so the stream does not restart. Its state is `voiceStore.screenShareAudio` (not persisted, null while not sharing):

| State | Meaning | Toggle on | Toggle off |
|-------|---------|-----------|------------|
| `published` | audio track on the publication | nothing to do | unpublish; on the desktop app the track is stopped → `acquirable`, elsewhere it is set aside → `held` |
| `held` | browser or portal capture withdrawn by the toggle: still captured, sent nowhere | publish the set-aside track → `published` | nothing to do |
| `acquirable` | nothing captured; desktop app, source listed by the app (picker mode `'app'`) | `acquiring`: `preselectScreenSource(sourceId, true)`, a second `getDisplayMedia` answered by the main process without a picker, its video track stopped at once, its loopback audio published → `published` | nothing to do |
| `acquiring` | that second capture is in flight, bounded by `SCREEN_SHARE_AUDIO_CAPTURE_TIMEOUT_MS` (10 s) | switch shows on, disabled, with "Adding system audio…" | a capture that lands after the toggle went off is stopped on the desktop app; one that lands after the share ended, or after the timeout, is stopped |
| `unavailable` | nothing captured and no silent way to add it | switch disabled, with "can only be added when a stream starts" | nothing to do |

The desktop app stops the track on "off" because it can capture loopback audio again without a prompt, so the OS capture indicator goes away; browsers grant audio only together with a capture's own prompt (`getDisplayMedia` has no audio-only form), so there the track is kept aside to make "on" possible again. System-picker (Wayland portal, or a session guessed to be one) and prompted (older desktop) captures would open the picker again, so those shares are `unavailable` when they have no audio. Turning audio off always works on every platform. While a share is live the switch shows what the share sends (`systemAudioSwitch()` in `StreamQualityControls.tsx`), not the preference, so a browser capture whose picker had audio unticked reads off. If adding audio fails or times out, the preference goes back to off and a toast says so.

**The audio ends with the share.** Every end of a share (`stopScreenShare`, `handleScreenShareUnpublished(room)`, a failed republish) goes through `endScreenShareAudio(room)`, which unpublishes and stops the `ScreenShareAudio` publication whatever captured it and stops a set-aside track. `handleScreenShareUnpublished` takes the room for this reason: when the video ends by itself (the shared window closes, a display is unplugged) livekit-client unpublishes only the ended video, and audio added mid-stream comes from a second capture that does not end with it. `LocalTrackUnpublished` for `ScreenShareAudio` that does not come from these paths (livekit-client unpublishing an audio track whose source ended) goes to `handleScreenShareAudioUnpublished(room)`, so the switch never reads on while nothing is sent; during a full reconnect it defers to `settleScreenShareAfterReconnect`.

Viewers: `TrackPublished` subscribes a `ScreenShareAudio` publication when the viewer is already watching that participant's stream (`watchingStreams`), since the watch click only subscribed what existed then. `TrackUnpublished` of the audio needs nothing special: `updateParticipants` drops `screenAudioTrack` and `GlobalAudioRenderer` stops playing it.

**Failure handling.** When loopback is not supported, Chromium rejects the entire `getDisplayMedia` request — the source-picker selection has already been consumed, so silently retrying without audio would re-prompt the picker. `stageScreenCapture` (`utils/screenShare.ts`) instead surfaces a warning toast directing the user to turn off system audio if their system does not support loopback. We do **not** auto-mutate the user's `shareAudio` preference.

---

## Mobile Voice Rendering

Mobile (`MobileVoiceFullScreen`) renders the **same** `VoiceGrid` component as desktop. There is no mobile-specific tile component — the rendering, attach/detach, adaptive-stream subscription, focused-publisher layout, and context menus all come from the shared `VoiceGrid` / `VoiceUser` / `StreamTile` pipeline. The only mobile-specific addition is auto-focus on the first live screen-share publication (so phone users don't have to discover tap-to-focus).

See `docs/systems/mobile-ui.md` → "MobileVoiceFullScreen" for the auto-focus state machine, control-bar wiring, and layout sizing.

**Why the shared component path matters.**

- Local camera preview: `VoiceUser` attaches the local participant's `videoTrack` to a `<video muted>`. Mobile gets the self-preview "for free".
- Remote cameras: `Track.attach(videoEl)` registers the element with LiveKit's `RemoteVideoTrack` adaptive-stream observer, so the SFU automatically picks the appropriate simulcast layer based on the painted tile size on the phone. No mobile-specific bitrate clamp is needed.
- Screen-share: `StreamTile` lazily subscribes via `setStreamSubscription` only after the user taps "Watch Stream" (or auto-focus does so on mobile, which currently still requires the user to tap the in-tile "Watch Stream" CTA — auto-focus only sets the focused publisher; it does not auto-subscribe to bandwidth-heavy screen-share tracks).
- Mute / deafen / speaking-ring overlays, watch/unwatch controls, local mute, volume sliders — identical between mobile and desktop.

**Screen-share button wiring on mobile.** `MobileVoiceFullScreen`'s screen-share button calls `handleScreenShareAction()` from `utils/voiceActions`, **not** `voiceStore.toggleScreenShare`. The store action only flips the `isScreenSharing` boolean and never captures anything. The canonical `handleScreenShareAction` is shared with desktop's `VoiceControlBar` and the keybind manager; idle it opens `ScreenShareSetup`, live it calls `stopScreenShare(room)`, which broadcasts the new voice status itself. iOS Safari does not support `getDisplayMedia` (the call rejects); this is a platform limitation. Android Chrome supports it and works.

---

## Voice Fullscreen

The fullscreen toggle in `VoiceControlBar` flips the `voiceFullscreen` flag in `uiStore`; an effect in `MainContent.tsx` enters/exits the browser's Fullscreen API on `voiceContainerRef`. A second effect listens to `fullscreenchange` and reflects the actual document fullscreen element back into the store, so pressing Esc or system-level fullscreen-exit keeps state in sync. `voiceChatOpen && !voiceFullscreen` hides the side chat panel while fullscreen is active.

**Fullscreen chrome:** the channel header and call controls are positioned over the video instead of reserving rows. Their overlay bands use `pointer-events: none`, and only the actual buttons opt back into hit testing, so transparent chrome never steals tile or Grid-button clicks. The header actions leave the top-right Grid corner clear.

Both overlays are revealed by **pointer movement** and hidden again after `POINTER_REVEAL_IDLE_MS` (2.5 s) of stillness, via `hooks/usePointerReveal`. `MainContent` owns that state — it holds `voiceContainerRef`, which is the element the pointer moves over — and passes it to `VoiceControlBar` as `revealed`.

This deliberately is **not** `group-hover/voice`, which is what it was until the idle behaviour was added. Hover is geometric: it asks whether the pointer is inside the box. Fullscreen makes `group/voice` the whole viewport, so hover is true wherever the pointer is, both overlays sat at `opacity-100` permanently, and the header band covered the top of the stream with no way to dismiss it short of moving the pointer out of the window. Idle is a question about time and needs a timer.

An overlay carrying `data-voice-chrome` (the `VOICE_CHROME_ATTR` export) holds the reveal open while the pointer rests on it, so stopping on a button to aim does not pull it away. Because the bands are `pointer-events: none`, this only ever matches through the buttons that opt back in — resting over the transparent part of a band still times out, which is correct. An open screen-share menu pins the control bar for the same reason, since its popover hangs off it.

The docked (non-fullscreen) layout keeps plain `group-hover/voice` and ignores `revealed`. There hover is the right model: the voice surface is a panel with sidebars beside it, so leaving it is something the pointer can actually do. Devices without hover or with any coarse pointer (including hybrid touch laptops) keep both overlays visible in either layout, and `focus-within` keeps them reachable by keyboard.

**Cross-browser API fallback.** iOS Safari (and iPadOS pre-16.4) does not implement the standard `Element.requestFullscreen()` on generic elements, so the enter-fullscreen effect probes for the API in this order:

1. `el.requestFullscreen()` — standard
2. `el.webkitRequestFullscreen()` — older WebKit (some iPads, older Safari)
3. Silent fall-through — pure iPhone Safari has neither API on a `<div>` (only `HTMLVideoElement.webkitEnterFullscreen()` works, which we cannot use for the multi-tile voice container)

When neither native API is available the effect returns without throwing; the `voiceFullscreen` flag still applies `h-screen` to `voiceContainerRef`, which acts as the in-page maximize fallback (chat panel hides, header fades, control bar stays). The exit path mirrors this with `document.exitFullscreen()` → `document.webkitExitFullscreen()` → no-op. Both paths are wrapped in try/catch so a Promise rejection (e.g. user cancels via Esc mid-transition) does not surface as an unhandled error. The `fullscreenchange` listener is registered for both `fullscreenchange` and `webkitfullscreenchange`. Before this fallback, calling the missing API directly threw `TypeError: requestFullscreen is not a function` on iPhone Safari, which surfaced as a full-screen error overlay when an iPhone user crossed the 768 px desktop breakpoint in landscape mode.

**Overlay portals:** While fullscreen is active the browser's Fullscreen API renders only descendants of `voiceContainerRef`. Every overlay reachable during a call (context menus on `StreamTile`/`VoiceUser`/`VoiceChannel`, tooltips on the control bar, `ConnectionInfoPopover`, `ScreenShareSettingsPopover`, `ConfirmDialog` invoked from voice context-menu actions, and `ScreenShareSetup`) portals through `usePortalContainer()` so it lands inside the fullscreen element. Adding new overlays that can be opened from inside the call must follow the same contract — see `docs/systems/design-system.md` Surface Material Tiers.

---

## Audio Processing

| Feature | Default | User Control | Notes |
|---------|---------|-------------|-------|
| Echo Cancellation | on | yes | Stays on during screen share (Chrome AEC handles it) |
| Noise Suppression | overridden | — | Managed by RNNoise state |
| Auto Gain Control | on | yes | |
| RNNoise (ML) | on | yes | When enabled: browser NS forced off |

**Audio constraints applied to mic track:**
```typescript
{
  echoCancellation: userSetting,     // stays on during screen share
  noiseSuppression: rnnoiseEnabled ? false : userSetting,
  autoGainControl: userSetting,
}
```

**Screen share audio (when enabled):**
```typescript
{
  restrictOwnAudio: true,    // Own-playback exclusion where supported; Electron 43.4+
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 2             // Stereo
}
```

Capture was already unprocessed stereo. LiveKit infers stereo from
`channelCount: 2` and disables DTX and RED for stereo tracks; the explicit
`forceStereo: true`, `dtx: false`, and `red: false` publication options preserve
that behavior visibly. The functional change is the preset upgrade from
`AudioPresets.music` (48 kbps) to `AudioPresets.musicHighQualityStereo`
(128 kbps), approximately 80 kbps more for a screen share carrying audio.

**Persistence:** `voiceStore` with Zustand localStorage. Keys: `echoCancellation`, `autoGainControl`, `rnnoiseEnabled`, `screenShareConfig`.

**Diagnostics polling:** `VoiceGrid` owns one `useTrackStats` poller for all
visible/observed stream tiles. The poll interval is 2 s (raised from 1 s when
the poller became shared), so the connection inspector refreshes at that rate
and the health debounce below spans roughly six seconds of degradation. Tiles consume the shared snapshot and apply the
three-bad-sample / five-stable-second debounce independently, avoiding a full
PeerConnection scan per tile. The connection inspector may start one additional
poller only while it is open. Publisher CPU attribution is available on the
publisher from outbound stats; viewers receive the publisher's LiveKit
connection-quality signal but cannot infer a remote encoder's CPU limitation.

**Camera preset:** 1280x720, 2Mbps, 30fps, H.264

### Capture lifecycle on leave — `AudioManager.releaseInputStream()`

The published mic track is a *clone* of `AudioManager`'s `MediaStreamAudioDestinationNode` output, so `Room.disconnect()` stops that clone but never the upstream `getUserMedia` capture (`AudioManager.currentStream`) that feeds the Web Audio graph. Without an explicit release, the browser tab and OS keep the microphone flagged in-use after the user leaves the call.

`AudioManager.releaseInputStream()` closes that gap: it disconnects `inputSource`, detaches each capture track's `onended` handler and `.stop()`s it, nulls `currentStream`, resets `currentInputDeviceId` to `'default'`, and bumps `streamGeneration` so the next join re-acquires instead of short-circuiting. The `AudioContext` and master bus are left intact so sound effects keep working.

`useLiveKit` calls it on explicit leave, a terminal `RoomEvent.Disconnected` from the current room (including an unspecified reason), a failed connection, and hook unmount. Leave and unmount release even before a room exists, covering the pre-arm/token-fetch interval. Explicit leave releases **before** awaiting SDK teardown, and late teardown cannot clear a newer connection's state.

Channel switches detach the old room reference before calling `room.disconnect()` and deliberately **keep capture warm** for the immediate rejoin. Old room events are ignored; releasing there would defeat the `joinVoiceChannel` mic pre-arm and risk the iOS gesture-window hang. Temporary reconnecting events do not release capture.

A separate input-release generation invalidates acquisitions queued or in flight before leave. Queued jobs are skipped; a late `getUserMedia` result is stopped immediately rather than attached to the graph. A stale denial is not cached for the next call. The browser permission prompt itself cannot be cancelled. New requests after release remain valid and reuse the existing serialized acquisition chain. The mic synchronization effect checks room identity and cleanup after awaits so an abandoned effect cannot reacquire or republish after leaving.

---

## Audio Device Selection (Microphone & Speakers)

Users pick mic and speaker devices in two surfaces:
1. **User Settings → Voice & Video** (`AudioInputSection.tsx`, `AudioOutputSection.tsx`) — full picker with input volume, live level meter, output volume, and a "Play test sound" button.
2. **Bottom-left UserArea quick popups** (`ChannelSidebar.tsx UserAreaPanel`) — opened by the caret buttons next to mute (input picker) and deafen (output picker). Same picker UX, more compact.

Both surfaces are backed by the shared `useAudioDevices()` hook. The store fields `inputDeviceId` and `outputDeviceId` (both `string`, default `'default'`) are persisted in `voiceStore`.

### `useAudioDevices()` hook (canonical enumeration)
- Mirrors `VideoSection.tsx`'s permission/enumeration/devicechange pattern.
- Mount-time probe: `navigator.permissions.query({ name: 'microphone' })`. **Never auto-fires `getUserMedia`** — that requires an explicit user gesture via the returned `requestPermission()`.
- States: `unknown` → `granted` | `prompt` | `denied`. Lists are populated only in `granted`.
- Refreshes both `inputs` and `outputs` on every `devicechange` event.
- Output devices are gated behind microphone permission (no separate output permission exists in browsers).
- Returns `inputLabels` / `outputLabels` maps with disambiguation suffixes for duplicate names (e.g. `"USB Audio (1)"`, `"USB Audio (2)"`).

### Output routing — `AudioContext.setSinkId`
All audio (remote voice, screen-share audio, sound effects) flows through `AudioManager`'s master bus → `AudioContext.destination`. Output device switching is therefore done via `AudioContext.setSinkId(deviceId)`, NOT via LiveKit's `switchActiveDevice('audiooutput')` (which targets `<audio>` elements that are killed by `AppLayout`'s MutationObserver). Safari < 17 lacks `setSinkId` on AudioContext — `AudioOutputSection` detects this (once a real context exists) and falls back to OS default with an explanatory note.

**Mobile platforms with no per-element output routing (iOS Safari):** `AudioOutputSection` feature-detects `'setSinkId' in HTMLMediaElement.prototype` at module load (cached). When false, the entire section is hidden — no header, no fallback copy. iOS users adjust audio routing via OS controls (Bluetooth menu, Control Center) and do not expect per-app output selection. Android Chrome ≥ 110 supports `setSinkId` and renders the picker normally. The detection runs before any hooks via an outer wrapper (`AudioOutputSection` → early-return-`null` → `AudioOutputSectionInner`) so the inner component's hook order remains stable.

### Touch-close on device pickers
The Audio Input, Audio Output, and Video device dropdowns (`AudioInputSection.tsx`, `AudioOutputSection.tsx`, `VideoSection.tsx`) all listen for both `mousedown` AND `touchstart` (`{ passive: true }`) when implementing click-outside-to-close. iOS Safari does not synthesize `mousedown` reliably from a single tap; without the `touchstart` listener, mobile users would have to tap twice to dismiss an open popover.

### Input pipeline — republish, never `switchActiveDevice`
Input device changes flow through `AudioManager.setInputDevice(deviceId)` (serialized chain). The `useLiveKit syncMic` effect detects the bumped stream generation and unpublishes/republishes via `getFreshTrack()`. This asymmetry vs. the camera (which uses `room.switchActiveDevice('videoinput', …)`) is intentional and documented under "Architectural asymmetry" below — the published mic track is the output of a Web Audio graph (RNNoise, gain, AEC), not a raw `getUserMedia` track.

### Hot-plug seamlessness
The global `devicechange` handler in `AppLayout.tsx` does four things on every event:
1. **Prune** persisted IDs that no longer exist (`pruneStaleDevices`).
2. **Re-acquire** the live mic stream when `inputDeviceId === 'default'` AND `AudioManager.hasActiveStream()`. Chromium does NOT migrate an existing `getUserMedia` track to the new OS-default — calling `setInputDevice('default')` triggers a fresh `getUserMedia` which picks up the new default; `syncMic` then republishes.
3. **Re-apply** `setSinkId('')` when `outputDeviceId === 'default'`, for the analogous reason.
4. **Toast** on a *new* `audioinput` group appearing (debounced 1s, deduped by `groupId` for 30s). Removals do not toast — the user already knows they unplugged it. Toast is informational ("AirPods Pro detected — choose it in Voice settings to switch") — never auto-switches; auto-switch would be a privacy/UX regression for users who deliberately keep a non-default device selected.

### Mic-track-loss recovery
The published mic track is a *clone* of `AudioManager`'s `MediaStreamAudioDestinationNode` output (see `getFreshTrack()`), and a destination-node track does not end on upstream loss — it just outputs silence. So the published track's `onended` is the wrong signal. Instead, `AudioManager` installs `onended` on every track of the upstream `getUserMedia` stream and exposes a subscription API:

- `AudioManager.onInputTrackEnded(cb)` — subscribers receive a `'unplug' | 'revoke' | 'unknown'` reason hint and probe `getUserMedia` themselves to classify.
- Deliberate replacements (`setInputDevice`, `setRnnoiseEnabled`, `setVoiceProcessing` re-init) detach the per-track listener BEFORE calling `.stop()` and null `currentStream` immediately, so subscribers are never notified for non-loss events. A surviving listener (e.g. attached by a future external caller) bails via the `currentStream !== capturedStream` identity check.

`useLiveKit` subscribes to this signal whenever a room is connected, captures `subscriberRoom = roomRef.current`, and on emission:
1. Bail if the room has been replaced.
2. Probe `getUserMedia({audio:{deviceId}})` to classify:
   - Probe succeeds → `setInputDevice(deviceId)` to re-acquire AND call `republishMicrophone(subscriberRoom, lastMicGenRef)` directly (the syncMic dep array does not include `streamGeneration`, so we cannot rely on it to re-fire).
   - `NotAllowedError` → `"Microphone permission was revoked"` (warning toast).
   - `NotFoundError` with non-default device → set store to `'default'` and toast `"Microphone disconnected — switched to system default"`. The store change triggers `syncMic`, which re-acquires + republishes via the shared helper.
   - `NotFoundError` on default → `"Microphone disconnected"`.
   - Other → `"Microphone could not be restored"`.

`republishMicrophone` is a module-level helper extracted from `syncMic` so both the normal device-change path and the recovery path share the staleness-check / unpublish / `getFreshTrack` / publish flow.

### Privacy gate — never auto-fire `getUserMedia`
The `useAudioDevices` hook only calls `getUserMedia` from the explicit `requestPermission()` action. The previous `ChannelSidebar.UserAreaPanel.loadDevices` implementation fired `getUserMedia({audio:true})` on every panel open as long as no `AudioContext` existed — which flashed the mic indicator even when permission had been previously granted in another session. That probe has been removed.

### Resolved-default hint
When `inputDeviceId === 'default'` and a stream is active, `AudioInputSection` shows a `Currently using: <label>` subline by reading `AudioManager.getCurrentInputDeviceId()` and looking up the label in `inputLabels`. This makes the "default → which device?" indirection visible to the user.

---

## Camera Device Selection

Users pick a camera in **User Settings → Voice & Video → Video**. Selection is persisted in `voiceStore.cameraDeviceId` (`string | null`; `null` = "let LiveKit/browser auto-pick on next fresh enable").

### Store field
- `cameraDeviceId: string | null` — persisted via `partialize`. No persist-version bump was needed when it was added: the existing merge `{ ...currentState, ...persistedState }` hydrates absent keys from `initialState` automatically.
- Sister action: `pruneStaleDevices()` — sweeps mic, speaker, and camera persisted IDs, resetting any that aren't present in `enumerateDevices()`. Skips a kind whose enumerated set has no non-empty deviceIds (Firefox/Safari pre-permission obscures IDs and we cannot distinguish stale from obscured). Called from `AppLayout` mount and on every `devicechange` event.

### Camera enable path (canonical)
`utils/voiceActions.handleCameraAction()` is the **sole** camera-toggle path — voice-bar button, mobile button, and keybind all call it. It applies `CAMERA_PRESET` (720p30 H.264) and injects `cameraDeviceId` into `VideoCaptureOptions.deviceId` when non-null.

### Hot-swap mid-call
`useLiveKit`'s `syncCamera` effect watches `cameraDeviceId`, `isCameraOn`, `isConnected`. When the published track's actual `getSettings().deviceId` differs from the store target (and target is non-null), it calls `room.switchActiveDevice('videoinput', targetId)` — an in-place source swap, no re-publish. Failure path: try to restore the previous deviceId in store (if its track is still live), else disable the camera entirely; toast `"Could not switch camera"`. The `null` ("Auto") target is intentionally a no-op: no force-switch of an already-live publication.

`isConnected` here is strictly `state === ConnectionState.Connected` (`useLiveKit.ts`). Do **not** broaden it to include `Reconnecting` without revisiting the effect — `switchActiveDevice` against a reconnecting room would fail.

### Track-end detection
On `RoomEvent.LocalTrackPublished` for the camera, the underlying `MediaStreamTrack` gets an `onended` listener. When it fires:
1. If `consumeIntentionalCameraOff()` returns true (user clicked the camera off; flag was set in `handleCameraAction`'s disable branch), bail — no probe, no toast.
2. Else re-probe `getUserMedia({video:{deviceId}})` to distinguish causes: `NotAllowedError` → `"Camera permission was revoked"` (macOS Privacy revoke); `NotFoundError` → `"Camera disconnected"` (unplug); other → `"Camera unavailable"`.
3. Tear down camera state via the unified path: `markIntentionalCameraOff()` → `setCameraEnabled(false)` → `isCameraOn = false` → `broadcastVoiceStatus()` → toast.

The `_intentionalCameraOff` module-level flag in `voiceActions.ts` is the gate. Producers: `handleCameraAction` disable branch, `syncCamera` rollback, the track-end handler's own teardown. Consumer: the track-end handler.

### Two-mode preview (in `VideoSection.tsx`)
| Mode | Triggered when | Source |
|---|---|---|
| In-call | An LK camera publication exists | Attach the LK `MediaStreamTrack` to the preview `<video>` |
| Pre-call | No room or no publication | Open a `getUserMedia({ video: { deviceId } })` stream for the selected device |

Mode is reactive on `isCameraOn` changes. Pre-call streams stop on tab hide (`visibilitychange`), modal close, panel switch, and component unmount; in-call attaches detach the same way but the LK track keeps running.

**Privacy: dormant-by-default.** The pre-call mode never auto-starts. On section mount, `navigator.permissions.query({ name: 'camera' as PermissionName })` reports the permission state without firing the camera. The preview tile is dormant (placeholder + "Click to test camera" overlay) until the user explicitly clicks it, or until the prompt-state CTA button triggers `getUserMedia` (which both grants permission and opens preview in one step). Rationale: macOS holds the camera LED on for ~2s after release, so any incidental `getUserMedia` call (probe, transient mount) flashes the LED — a privacy/UX defect. The only entry points to `getUserMedia` are explicit user gestures: dormant-tile click, prompt CTA, "Try again" in the denied banner, and dropdown change while preview is already running.

### Mobile pre-join preview (in `MobileVoiceJoinSheet.tsx`)
The mobile bottom-sheet voice-join flow exposes the same dormant-by-default camera preview pattern as `VideoSection`'s pre-call mode. When the user taps a voice channel on `MobileSpacesScreen`, the join sheet opens with a 16:9 preview tile. The tile starts dormant ("Tap to preview camera") — never auto-fires `getUserMedia`. Tapping the tile, the prompt-state CTA, or "Try again" after a denial calls `getUserMedia({ video: { deviceId: ... } })` with the user's persisted `cameraDeviceId` from `voiceStore`.

Lifecycle is hard-bound to the sheet:
- **Arm:** explicit user tap inside the sheet (any of the entry-point buttons).
- **Disarm:** sheet close (any path: backdrop tap, close button, channel switch, Join Voice tap which transitions to the in-call flow). The single source of truth for "camera off when sheet closes" is the cleanup effect on the component's unmount — the parent (`MobileSpacesScreen`) removes the sheet, the cleanup runs `stopPreview()`, and tracks are stopped + `srcObject` cleared.
- **Tab-hide:** matches `VideoSection` — release on `visibilitychange === 'hidden'`, no auto-resume; user must re-tap.
- **Camera switch:** when multiple cameras are present, a picker overlay in the bottom-left of the tile lets the user swap. The picker is gated on `permState === 'granted' && cameraDevices.length > 1` so it doesn't appear for single-camera devices. Switching cameras while preview is running re-opens `getUserMedia` for the new `deviceId`; `cameraDeviceId` is shared with `voiceStore` so the selection persists into the call.
  - **Picker popup is portaled to `document.body`.** The trigger button sits inside the `aspect-video overflow-hidden` preview tile, but the dropdown list is rendered as a `position: fixed` element via `createPortal` so it can extend above the tile. Position is captured from the trigger's `getBoundingClientRect()` (re-captured on `resize` / capturing `scroll`) and pinned via `bottom = window.innerHeight - rect.top + 4` so the popup expands upward. The list has `max-height: min(50vh, 320px)`, `overflow-y: auto`, and `-webkit-overflow-scrolling: touch` so every entry stays reachable on a long device list. Click-outside dismissal listens for both `mousedown` and `touchstart`, and excludes both the anchor and the portaled popup (the popup is not a DOM descendant of the anchor since it lives in `document.body`).

The `<video>` element is set up identically to `VideoSection` for iOS Safari compatibility: `autoPlay playsInline muted` attributes on the element, `srcObject` set after the `await getUserMedia`, and a defensive `videoEl.play().catch(() => {})`. iOS Safari requires `autoPlay` because the user-gesture context expires across the await — `play()` alone fails silently.

### Architectural asymmetry: mic republishes, camera switches
Mic publishes the output of a Web Audio graph (RNNoise, gain, AEC) — `LocalParticipant.switchActiveDevice` cannot operate on it because the published track is a `MediaStreamAudioDestinationNode.stream`'s track, not a raw mic track. Mic device changes therefore unpublish/republish via `AudioManager.getFreshTrack()`. Camera publishes the raw `getUserMedia` track and uses `switchActiveDevice` for in-place swaps. **Do not unify.**

### Federation
No federation work. The LK room is at the host instance; remote peers connect to it directly. `switchActiveDevice` is room-internal and works regardless of where the room lives.
