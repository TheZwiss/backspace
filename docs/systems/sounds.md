# System Sounds

Single source of truth for the in-app audio cue layer. Files live in
`packages/web/public/sounds/` as **Ogg Vorbis** (`.ogg`). Most cues are wired
to exactly one event; the two `stream_user_*` cues are dual-audience (see
their rows). All cues are self-authored (no third-party/Discord audio).

Source files:
- Controller: `packages/web/src/components/voice/SoundController.tsx`
- Viewer-action cues: `packages/web/src/components/voice/StreamTile.tsx`
  (`handleViewerWatchToggle`)
- Audio engine: `packages/web/src/audio/AudioManager.ts`
- Alert gate (Do Not Disturb): `packages/web/src/utils/alerts.ts`
  (`playAlertSound`, `showAlertNotification`), pure rule `isAlertAllowed` in
  `utils/notificationFilters.ts`; OS notifications raised by
  `packages/web/src/components/NotificationController.tsx`
- Pure helpers: `packages/web/src/utils/notificationFilters.ts`,
  `packages/web/src/utils/streamWatchProtocol.ts`,
  `packages/web/src/utils/voiceSoundTransitions.ts` (mute/deafen cue selection)
- SFX volume: `packages/web/src/utils/sfx.ts` (`getSfxVolume`, `SFX_BASE_VOLUME`)
- Settings: `packages/web/src/stores/voiceStore.ts`
  (`soundEffectVolume`, `messageSoundAllChannels`),
  `packages/web/src/components/modals/settingsPanels/VoicePanel.tsx`

---

## Inventory & Trigger Map

| File | Event | Audience | Trigger |
|---|---|---|---|
| `mute.ogg` | "I am now muted" (any cause) | self | `effectiveMuted` flips true while LK-connected. Effective = self toggle ∪ space-mute ∪ permission-mute. Suppressed when the deafen state also flipped this tick (see Mute/deafen cue selection). |
| `unmute.ogg` | "I am no longer muted" | self | `effectiveMuted` flips false while LK-connected. Suppressed when the deafen state also flipped this tick. |
| `deafen.ogg` | "I am now deafened" | self | `effectiveDeafened` flips true while LK-connected. Takes priority over the coincident mute cue. |
| `undeafen.ogg` | "I am no longer deafened" | self | `effectiveDeafened` flips false while LK-connected. Takes priority over the coincident unmute cue. |
| `camera_on.ogg` | self camera enabled | self | `voiceStore.isCameraOn` flips true. |
| `camera_off.ogg` | self camera disabled | self | `voiceStore.isCameraOn` flips false. |
| `user_join.ogg` | someone (incl. self) joined the voice channel | everyone in call | self `isLiveKitConnected` flips true OR a remote participant appears in `participants[]`. |
| `user_leave.ogg` | a remote participant left voice | everyone in call (excl. the leaver) | a userId disappears from `participants[]`. Suppressed for self (uses `disconnect.ogg`) and during teardown (`justDisconnected` guard). |
| `disconnect.ogg` | self left voice | self | `isLiveKitConnected` flips false. |
| `call_ringing.ogg` | incoming DM call (loop) | callee | `voiceStore.incomingCall !== null`. Loops while ringing; cleaned up on accept/reject/timeout. Alert: withheld on Do Not Disturb (see below). |
| `call_calling.ogg` | outgoing DM call (loop) | caller | `voiceStore.outgoingCall !== null`. |
| `stream_started.ogg` | any participant started a screen share | everyone in call (incl. the streamer) | a userId appears in the `participants[].isScreenSharing` set. |
| `stream_ended.ogg` | any participant stopped a screen share | everyone in call | a userId leaves the `participants[].isScreenSharing` set. |
| `stream_user_joined.ogg` | (a) a viewer started watching **my** stream; (b) **I** started watching someone's stream | streamer **and** the acting viewer | (a) streamer-side: `streamWatchers[own LiveKit identity]` gains a watcher identity. (b) viewer-side: local feedback played by `handleViewerWatchToggle(_, true)` on the explicit "Watch Stream" action. |
| `stream_user_left.ogg` | (a) a viewer stopped watching **my** stream; (b) **I** stopped watching someone's stream | streamer **and** the acting viewer | (a) streamer-side: `streamWatchers[own LiveKit identity]` loses a watcher identity (suppressed for the whole set when self-stream-end fires — see Mechanism Notes). (b) viewer-side: local feedback played by `handleViewerWatchToggle(_, false)` on the explicit "Stop Watching" action. |
| `message.ogg` | new chat message arrived | self | The message is a `message` alert (see "Which messages alert" below). User can flip `messageSoundAllChannels` to fire on every channel. Alert: withheld on Do Not Disturb (see below). |

---

## Which messages alert

One predicate decides whether a newly arrived message alerts the user:
`messageAlertsUser(event, { everyMessage })` in `utils/alerts.ts`, over the pure
rule `isMessageAlert` in `utils/notificationFilters.ts`. `SoundController`
calls it before `message.ogg` and `NotificationController` calls it before the
new-message OS notification, so the two outputs cannot drift apart.

**Rule.** Never for the user's own message. Otherwise yes for a DM, and yes for
a message whose content mentions the user (`<@id>`). Every other message does
not alert.

**The user's ids.** The home account's `id`, its `homeUserId`, and the id the
user holds on the channel's instance (`getMyUserIdForOrigin` of the channel's
origin). On a remote instance's channel, the user's own messages carry that
instance's id and mentions of the user are written with it, so without it the
user's own messages there would alert and mentions there would not.

**The every-message preference.** `messageSoundAllChannels` ("Play sound for
every message") widens the sound only. `SoundController` passes it as
`everyMessage`; `NotificationController` does not, so OS notifications stay on
DMs and mentions whatever the preference says.

**Per-channel and per-space settings.** There are none today: no channel or
space mute and no notification level. When one is added it belongs in
`messageAlertsUser`, so both outputs follow it.

**Order.** The predicate decides first, then Do Not Disturb (below) withholds
what it allowed. A batch of events raises at most one sound and at most one
notification, for the first message that alerts.

---

## Do Not Disturb

Two cues are **alerts**: they draw attention to something another person did.
Every other cue is feedback on the user's own action or on the call they are
in. Only alerts are subject to the user's status.

| Alert kind (`AlertKind`) | Cue | OS notification |
|---|---|---|
| `message` | `message.ogg` | new-message notification (window unfocused) |
| `incoming_call` | `call_ringing.ogg` loop | "is calling you" notification (window unfocused) |

**Rule.** While the user's status is `dnd`, both outputs of every alert kind
are withheld. `online` and `idle` do not suppress anything, and neither does an
unknown status (no user loaded yet).

**What still happens on `dnd`:**
- Unread state, unread counts and the desktop badge (`set-badge-count`) keep
  updating. They are silent and are not routed through the gate.
- The in-app incoming-call card still appears, so the call can be answered;
  only the ringing loop and the OS notification are withheld.
- Own-action and in-call cues are untouched: mute/unmute, deafen/undeafen,
  camera, join/leave/disconnect, stream started/ended, watcher cues, and the
  outgoing `call_calling` loop.

Messages follow Discord, where Do Not Disturb silences notifications and their
sounds while badges keep counting. Calls are withheld too because the ringing
loop is the most intrusive cue the app has, and the call is not lost: the card
stays visible and the caller keeps hearing `call_calling` until it is answered
or times out. Letting calls through Do Not Disturb would be a change to the
`incoming_call` case of `isAlertAllowed`, not to any call site.

**Ringing is a state, not an event.** The `call_ringing` loop plays exactly
while a call is waiting and `incoming_call` alerts are allowed. `SoundController`
re-evaluates that on every voice-store tick and on every change of the user's
own status, so switching to `dnd` mid-ring stops the loop at once, and leaving
`dnd` while the call is still ringing starts it. The loop stands for "a call is
waiting for you right now"; a user who just left Do Not Disturb has asked to be
reachable, and the call they would otherwise miss is still there. The OS
notification is different: it is one-shot at the start of the call and is not
raised again when the user leaves `dnd`, because the in-app card already shows
the waiting call.

**One decision point.** The rule lives in `isAlertAllowed(kind, selfStatus)`
(`utils/notificationFilters.ts`, pure). Callers never test the status
themselves: they raise an alert through `playAlertSound(kind)` or
`showAlertNotification(kind, ...)` (`utils/alerts.ts`), which read the status
at the moment of the alert, so a status change applies to the next alert
without re-subscribing. A new alert source gets a new `AlertKind`, and the
compiler then requires `isAlertAllowed` and the kind-to-cue table to cover it.

**Whose status.** The gate reads the user's chosen status through
`selectMyChosenStatus`, from the account that owns it. Which account that is,
and why no other instance's view of the user counts, is stated once in
activity-presence.md ("The client's copy of the user's own status"). One status
covers every connected instance, as it does in Discord.

**Desktop.** The gate runs in the renderer, before `window.backspace.showNotification`
is called; the preload and main process are unchanged. Any desktop build works
with it, and the rule reaches desktop users when their instance serves the new
renderer, not when the app updates. The main process's own update-available
notifications are not chat alerts and do not consult the status.

---

## Mechanism Notes

### Effective-mute / deafen gating

`SoundController` computes `effectiveMuted` and `effectiveDeafened` on each
voice-store transition. The formulas mirror `useLiveKit.ts` (line ~322):

```
effectiveMuted    = isMuted    || spaceMutedUserIds.has(key) || permissionMutedUserIds.has(key)
effectiveDeafened = isDeafened || spaceDeafenedUserIds.has(key)
```

Where `key = "${spaceId}:${userId}"` for the current voice channel.

**LK-connect-boundary rule:** the cue only fires when **both** the previous and
current samples were captured while `isLiveKitConnected === true`. This prevents
a phantom mute cue on join (where you might be pre-muted by a moderator before
ever entering the channel — the `effectiveMuted` flag flips true *after*
connect because the keyed lookup resolves only once `currentVoiceChannelId` is
set). Mid-call mod-mute remains audible.

### Mute/deafen cue selection

Deafening is not independent of muting: `voiceStore.toggleDeafen` flips
`isMuted` together with `isDeafened` in a single atomic `set()` (deafen ⇒
muted, undeafen ⇒ unmuted), mirroring Discord. SoundController samples both
effective states on the same store tick, so firing a cue per changed flag would
play `mute` **and** `deafen` at once when the user hits deafen.

`selectVoiceStateSound(prev, next)` (`utils/voiceSoundTransitions.ts`) resolves
this to a single cue: if the deafen state changed it returns `deafen`/`undeafen`
and the coincident mute change is treated as a side effect and suppressed;
otherwise a mute change returns `mute`/`unmute`. Pure helper, unit-tested.

### Viewer-side watch feedback

`stream_user_joined` / `stream_user_left` also play on the **viewer's own**
machine as feedback for an explicit watch/stop action, via
`handleViewerWatchToggle` in `StreamTile.tsx` — the same chokepoint that
broadcasts the `stream_watch` ping. The cue is played directly (not derived
from a `watchingStreams` diff) for two reasons: (1) automatic teardown paths
(streamer stops sharing, participant disconnect) mutate `watchingStreams`
without being the viewer's action and must stay silent on the viewer side —
they already get `stream_ended`; (2) a direct local play is independent of the
data-channel round-trip to the streamer, so the viewer gets identical feedback
on every platform (Safari and the Electron desktop app alike). This is
orthogonal to the streamer-side diff below, which fires on a *different*
machine for that streamer's watcher set — the two never double on one client.

### Playback envelope (anti-pop)

`AudioManager.playSound` wraps every cue in a short gain envelope — a 10ms
fade-in on start and (for non-looping cues) a 10ms fade-out before the buffer
ends. Starting a buffer at a non-zero sample amplitude produces an audible
click/pop; the envelope removes it. Most noticeable on the looping call cues
(`call_calling` / `call_ringing`), which previously popped on every start.
Mirrors the envelope already used by `playTestTone`.

### Viewer tracking — data-channel protocol

LiveKit JS 2.17 does **not** expose per-subscriber events on the publisher
side: `LocalTrackSubscribed` only fires for the *first* subscriber and has no
unsubscribe twin; there is no public `numSubscribers` API. Backspace uses a
small data-channel ping instead, mirroring the existing `deafen` pattern in
`useLiveKit.ts`.

**Wire format** (`streamWatchProtocol.ts`), two message types:
```ts
interface StreamWatchPayload {
  type: 'stream_watch';
  target: string;           // sharer's user id as the viewer's client lists it
  targetIdentity?: string;  // sharer's LiveKit identity (optional, see below)
  watching: boolean;
}

interface StreamRepublishPayload {
  type: 'stream_republish';   // sender is the sharer; no other fields
}
```

`stream_republish` is sent by a sharer right before a codec change unpublishes
its screen share to publish the same capture again (`republishScreenShare`).
It does not touch the watcher sets. It tells viewers that the removal that
follows is not the share ending. They keep watching, the sharer stays in the
`participants[].isScreenSharing` set across the gap on every client including
its own, and so **neither `stream_ended` nor `stream_started` plays for
anyone**, and the sharer's watcher set survives. If no new publication arrives
within 15 s, the share ends and `stream_ended` plays then. What
`isScreenSharing` means on each side, the receiving state machine and the
mixed-version rules are in `docs/systems/voice.md` (Screen Sharing → "A share,
not a publication" and "Viewers across a republish").

**Senders.** `StreamTile.tsx` is the **only** broadcast site, and only on
explicit user actions:
- "Watch Stream" / "Stop Watching" context-menu items.
- Click-to-watch handler.

The viewer-side automatic-teardown paths in `useLiveKit.ts`
(`LocalTrackUnpublished` for self, `TrackUnpublished` for the streamer's
removed track) call `voiceStore.unwatchStream` directly and **do not**
broadcast. This is deliberate: if they did, a streamer who just stopped
sharing would receive a flurry of `watching: false` pings from every former
viewer and play `stream_user_left` on top of their own `stream_ended` cue.

**Keys.** `voiceStore.streamWatchers` maps the sharer's LiveKit identity to
the set of watcher LiveKit identities. Identities on both sides, because a
user id is per instance while the identity is the one string every client in
the room knows a participant by. Viewers send `streamWatchFor(sharer, watching)`
(`streamWatchProtocol.ts`), which carries both `target` (for sharers that
predate `targetIdentity` and read only that) and `targetIdentity`.

**Receiver.** `useLiveKit.handleDataReceived` parses the payload, resolves the
key with `streamWatchKey(payload, participants)` and calls
`voiceStore.recordStreamWatch(sharerIdentity, watcherIdentity, watching)`.
`streamWatchKey` takes `targetIdentity` when present; for an older viewer's
ping it takes the identity of the participant this client lists under
`target`, and drops the ping (null) when nobody is listed under it.
`SoundController` finds its own entry through the local participant
(`isLocal`), not an account id, watches `streamWatchers[that identity]` for
diff transitions and fires the streamer-only sounds.

**Crash / drop cleanup.** `RoomEvent.ParticipantDisconnected` evicts the
disconnecting participant identity from every watcher set
(`voiceStore.evictWatcher`). The `stream_user_left` cue plays on the streamer
side at that point.

**Self-stream-end suppression.** When the streamer themselves stops sharing
(a real stop; a codec republish is not one, see above),
SoundController detects this in the same set-diff that fires `stream_ended`
and synchronously calls `clearStreamWatchers(ownIdentity)` (the identity it
was last listed under, since the list is empty after a disconnect). The watcher diff is
gated on `selfIsSharing` (which is now false), so neither the outer
subscriber tick nor the re-entered subscriber tick triggered by the clear
fires any per-watcher sound. The same gate also makes a stop-then-restart
cycle fire `clearStreamWatchers` on `selfStreamJustStarted`, dropping any
stale watcher entries from the previous run.

**Why not `LocalTrackSubscribed`?** Insufficient: fires only for the first
subscriber and has no unsubscribe counterpart in LiveKit JS 2.17.

### Federation

LiveKit data channels are room-scoped: a federated DM call or a remote
space's voice channel is one LiveKit room hosted by one instance, with every
participant attached directly. User ids are not shared across it. In a remote
space's channel the token's identity carries the id the space's instance has
for the user; in a federated DM call it carries the home id, and each client
lists the member under its own local id. That is why the watcher set is keyed
by LiveKit identity and the sharer finds itself through the local participant
(see Keys and Receiver above).

Mixed versions: a new viewer's ping still carries `target`, so an older sharer
behaves as before. An older viewer's ping carries only `target` and reaches a
new sharer's set when both clients list the sharer under the same id (a space
channel, a same-instance DM call); a cross-instance DM viewer on an older
client names the sharer by an id the sharer's client does not know, so its
ping is dropped and the sharer hears no cue for it, as before.

---

## Settings

| Key | Type | Default | Storage |
|---|---|---|---|
| `voiceStore.soundEffectVolume` | number 0–200 | 100 | persisted |
| `voiceStore.messageSoundAllChannels` | boolean | false | persisted |

UI lives in `VoicePanel.tsx` for both today.

> **Long-term placement note:** `messageSoundAllChannels` is conceptually a
> notifications preference, not a voice preference. It currently lives in the
> Voice settings panel because that's where `soundEffectVolume` already lives.
> When a Notifications settings panel is added, both this toggle and the
> SFX volume slider should move there.

---

## Out of Scope (no existing audio file)

The following events do not have an audio file in
`packages/web/public/sounds/` and are intentionally **not** wired. Adding any
of them is a future change that requires sourcing new audio:

- DM call accepted / connected (the moment ringing transitions to active)
- DM call missed / declined / ended-remotely
- Moderator move-to-channel / kick-from-voice (the LK disconnect already plays
  `disconnect.ogg` for forced disconnects)
- Friend request received / accepted
- Mention-everyone / @here (Backspace doesn't currently parse these)
