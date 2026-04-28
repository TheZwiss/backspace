# System Sounds

Single source of truth for the in-app audio cue layer. Every file in
`packages/web/public/sounds/` is wired to exactly one event with a defined
audience.

Source files:
- Controller: `packages/web/src/components/voice/SoundController.tsx`
- Audio engine: `packages/web/src/audio/AudioManager.ts`
- Pure helpers: `packages/web/src/utils/notificationFilters.ts`,
  `packages/web/src/utils/streamWatchProtocol.ts`
- Settings: `packages/web/src/stores/voiceStore.ts`
  (`soundEffectVolume`, `messageSoundAllChannels`),
  `packages/web/src/components/modals/settingsPanels/VoicePanel.tsx`

---

## Inventory & Trigger Map

| File | Event | Audience | Trigger |
|---|---|---|---|
| `mute.mp3` | "I am now muted" (any cause) | self | `effectiveMuted` flips true while LK-connected. Effective = self toggle ∪ space-mute ∪ permission-mute. |
| `unmute.mp3` | "I am no longer muted" | self | `effectiveMuted` flips false while LK-connected. |
| `deafen.mp3` | "I am now deafened" | self | `effectiveDeafened` flips true while LK-connected. |
| `undeafen.mp3` | "I am no longer deafened" | self | `effectiveDeafened` flips false while LK-connected. |
| `camera_on.mp3` | self camera enabled | self | `voiceStore.isCameraOn` flips true. |
| `camera_off.mp3` | self camera disabled | self | `voiceStore.isCameraOn` flips false. |
| `user_join.mp3` | someone (incl. self) joined the voice channel | everyone in call | self `isLiveKitConnected` flips true OR a remote participant appears in `participants[]`. |
| `user_leave.mp3` | a remote participant left voice | everyone in call (excl. the leaver) | a userId disappears from `participants[]`. Suppressed for self (uses `disconnect.mp3`) and during teardown (`justDisconnected` guard). |
| `disconnect.mp3` | self left voice | self | `isLiveKitConnected` flips false. |
| `call_ringing.mp3` | incoming DM call (loop) | callee | `voiceStore.incomingCall !== null`. Loops while ringing; cleaned up on accept/reject/timeout. |
| `call_calling.mp3` | outgoing DM call (loop) | caller | `voiceStore.outgoingCall !== null`. |
| `stream_started.mp3` | any participant started a screen share | everyone in call (incl. the streamer) | a userId appears in the `participants[].isScreenSharing` set. |
| `stream_ended.mp3` | any participant stopped a screen share | everyone in call | a userId leaves the `participants[].isScreenSharing` set. |
| `stream_user_joined.mp3` | a viewer started watching **my** stream | streamer only | `streamWatchers[selfUserId]` gains a watcher identity. |
| `stream_user_left.mp3` | a viewer stopped watching **my** stream | streamer only | `streamWatchers[selfUserId]` loses a watcher identity. Suppressed for the entire watcher set when self-stream-end fires (see Mechanism Notes). |
| `message.mp3` | new chat message arrived | self | `shouldPlayMessageSound` returns true (DM channel OR content mentions any of the user's self-ids). User can flip `messageSoundAllChannels` to fire on every channel. |

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

### Viewer tracking — data-channel protocol

LiveKit JS 2.17 does **not** expose per-subscriber events on the publisher
side: `LocalTrackSubscribed` only fires for the *first* subscriber and has no
unsubscribe twin; there is no public `numSubscribers` API. Backspace uses a
small data-channel ping instead, mirroring the existing `deafen` pattern in
`useLiveKit.ts`.

**Wire format** (`streamWatchProtocol.ts`):
```ts
interface StreamWatchPayload {
  type: 'stream_watch';
  target: string;   // streamer userId
  watching: boolean;
}
```

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

**Receiver.** `useLiveKit.handleDataReceived` parses the payload and calls
`voiceStore.recordStreamWatch(target, watcherIdentity, watching)`.
`SoundController` watches `streamWatchers[selfUserId]` for diff transitions
and fires the streamer-only sounds.

**Crash / drop cleanup.** `RoomEvent.ParticipantDisconnected` evicts the
disconnecting participant identity from every watcher set
(`voiceStore.evictWatcher`). The `stream_user_left` cue plays on the streamer
side at that point.

**Self-stream-end suppression.** When the streamer themselves stops sharing,
SoundController detects this in the same set-diff that fires `stream_ended`.
For that one tick, both the previous and current watcher sets are treated as
empty (no per-watcher sounds), and the store entry is cleared via a deferred
`clearStreamWatchers` call so the next subscribe tick sees prev=current=∅.

**Why not `LocalTrackSubscribed`?** Insufficient: fires only for the first
subscriber and has no unsubscribe counterpart in LiveKit JS 2.17.

### Federation

LiveKit data channels are room-scoped, so the protocol works unchanged for
federated DM calls: a single LiveKit room hosted by one instance with all
participants attached directly. The federation-aware `myIds` set
(`{currentUser.id, currentUser.homeUserId}`) is used for self-detection in
both viewer-tracking and message-mention matching, so a remote-instance
mention by `homeUserId` correctly triggers the message sound.

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
  `disconnect.mp3` for forced disconnects)
- Friend request received / accepted
- Mention-everyone / @here (Backspace doesn't currently parse these)
