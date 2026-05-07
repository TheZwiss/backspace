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
4. Server broadcasts `voice_state_update { action: 'join' }` to space
5. Client calls `POST /api/livekit/token { channelId }` → gets JWT + LiveKit URL
6. Client connects to LiveKit room with token

**Token grants (space channels):**
- SPEAK → can publish MICROPHONE + CAMERA
- STREAM → can publish SCREEN_SHARE + SCREEN_SHARE_AUDIO
- Missing permission → grant excludes those sources

**Token grants (DM calls):** Always full (canSpeak=true, canStream=true)

**Identity format:** `{userId}:{username}`, TTL: 1 hour, Room: `{channelId}` or `dm-{dmChannelId}`

**Multi-tab:** Each user has one `voiceWs` binding. New tab → old socket gets `voice_disconnected { reason: 'displaced' }`

---

## DM Call State Machine

States: `ringing` → `active` → destroyed

| Event | Action | State |
|-------|--------|-------|
| `dm_call_start` | Room created, caller bound, 60s timeout starts | ringing |
| `dm_call_incoming` | Broadcast to DM members (excludes caller) | ringing |
| `dm_call_accept` | First accept: ringing→active. Late joins welcome (group DM) | active |
| `dm_call_reject` | Room destroyed, caller unbound | — |
| `dm_call_end` | All participants unbound, room destroyed | — |
| Timeout (60s) | Auto-cleanup if still ringing, broadcast `dm_call_ended` | — |

**Edge cases:**
- Starting new call cancels any other ringing calls by same caller
- Socket close during ringing → auto-cleanup
- Participants drop to 0 in active state → room destroyed

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

**Accept-rollback semantics.** `handleDmCallAccept` Path 2 transitions the `FederatedCallEntry` to active and broadcasts `dm_call_accepted` optimistically so the acceptor's UI flips immediately. If the B→host relay fails, the server clears the entry, fans `dm_call_undeliverable { phase: 'accept', terminal: true }` out to all ringed users on B (via `sendToFederatedCallUsers`), and the client tears its call state back down.

**Reject / end are optimistic.** Local state is cleared before the relay is awaited because the user's intent is to terminate. If the relay fails, the originator receives an informational `dm_call_undeliverable { terminal: false }` so they know remote peers may briefly display stale state; no local rollback.

**Ring-timeout fan-out.** When the host's 60 s ringing timeout fires without an accept, `dm_call_end` is fanned out to all remote peers so stranded Path-A/B ringees on other instances exit their ring state instead of lingering. Registered via `connectionManager.setRingTimeoutFanoutHook` from the WS events module.

**Remaining edge.** When a non-host participant ends an active call and the relay to the host fails, the host's `activeDmCall` marker lingers until manual end — LK `ParticipantDisconnected` tears down the voice UI but does not clear the DM-call marker on the host side. This is the caller-side mirror of the remote-participant problem and is not covered by the Remote-Participant Host Unreachable Eviction mechanism above (which only reasons about FederatedCallEntry state). Tracked separately.

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
- `ringedUserIds` tracks all users who were notified of the incoming call, used for end-call cleanup
- `callerId`, `callerHomeUserId`, `callerHomeInstance` identify the caller across instances

### Late-Bind dmChannelId

When `findOrCreateDmChannel` creates a local DM channel during an active federated call (e.g., the first message arrives while a call is ringing), it binds the `dmChannelId` on the existing `FederatedCallEntry`. This transitions the call from Path B to Path A delivery without interrupting the call.

### Token Generation & Room Identity

**Token generation:** `generateFederatedCallToken(federatedId, homeUserId, displayName)` in `routes/livekit.ts` issues 5-minute tokens scoped to the `federatedId` room (not the local `dmChannelId`). Grants full DM permissions (mic, camera, screen share, subscribe, data channel).

**LiveKit URL:** The relay sends `config.livekit.url` (e.g., `wss://nova.ddns.net/livekit`). Must be `wss://`, not `https://` — the LiveKit SDK requires a WebSocket URL.

**Token endpoint:** `POST /api/livekit/token` uses `federatedId` as the room name when the DM channel has a `federatedId` set, ensuring both instances join the same LiveKit room.

**Identity format:**
- Federated calls: `${homeUserId}:${displayName}` — stable across all instances
- Local calls: `${userId}:${username}` — unchanged

**Client identity resolution:** For federated calls, the client splits the LiveKit participant identity on `:` and matches `homeUserId` against the DM member list (which stores `homeUserId` for all members). This resolves the correct display name and avatar regardless of which instance the participant is on.

### Client-Side Call Routing

**`callOrigin`:** Set to the WS origin that delivered the `dm_call_incoming` event (the home instance), NOT the call host URL. Accept/reject/end route through this WS. The home instance's server finds the `FederatedCallEntry` and relays to the host via S2S HTTP. This is reliable regardless of whether the client has a multi-instance WS to the host.

**`handleAccept`:** Sets `activeDmCall` and clears `incomingCall` directly in the click handler — does not wait for the server's `dm_call_accepted` response (races with `connectFn`'s async AudioContext resume).

**Passive ready handler:** On page refresh/restart, the ready payload includes active calls but the client does NOT auto-connect to LiveKit. Users must re-accept. This prevents identity slot wars when the same user has multiple sessions.

### SoundController Federation Awareness

The `SoundController` uses `isSelf(id)` which checks against BOTH `currentUser.id` (local snowflake) and `currentUser.homeUserId` (federated home ID). In federated calls, `updateParticipants` resolves identity to the local snowflake when `activeDmCall` is set, but reverts to raw `homeUserId` when it's cleared during disconnect. Both formats must be recognized as "self" to prevent phantom join/leave sounds.

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
- Broadcasts via `voice_status` WS event
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
  mode: 'gaming' | 'text',         // Affects bitrate & content hint
  customBitrateKbps: number | null, // Admin override (if allowed)
  shareAudio: boolean               // System audio loopback (see Platform Support below)
}
```

### Build Pipeline (`buildScreenShareOptions()`)
1. Resolve bitrate from matrix (custom > override > default > native estimate)
2. Clamp to instance limits (minBitrateKbps, maxBitrateKbps)
3. Compute min bitrate = 25% of max
4. Codec: VP9 (default) or H.264 (hardware overdrive)
5. VP8 simulcast backup at reduced framerate/bitrate
6. Content hint: `'detail'` (text) or `'motion'` (gaming)

### Native Mode
- Captures at display's full resolution
- Snaps to nearest known tier for bitrate lookup
- Scales proportionally: `baseKbps * (capturedPixels / knownPixels) * (fps / knownFps)`

### Hardware Overdrive
- Forces H.264 hardware encoder via SDP profile override
- Applied 2s after stream starts (after WebRTC negotiation), re-applied at 5s
- 4s: detects if using software fallback, warns user

### Instance-Level Limits (admin-configured)
- `allowedResolutions`, `allowedFramerates` (CSV in instance_settings)
- `maxResolution`, `maxFramerate`, `maxBitrateKbps`, `minBitrateKbps`
- `allowCustomBitrate` toggle
- `bitrateMatrixOverrides` (JSON sparse overrides)

### System Audio Loopback (`shareAudio`)

The "Share system audio" toggle in `ScreenSharePicker` adds an audio track to the screen-share publication. In the browser it maps to `getDisplayMedia({ audio: true })`. In Electron, the `setDisplayMediaRequestHandler` callback (`packages/desktop/src/main.ts`) returns `audio: 'loopback'` to opt into Chromium's system-audio loopback path.

| Platform | Mechanism | Notes |
|----------|-----------|-------|
| Browser (Chrome/Edge) | `getDisplayMedia({ audio: true })` | Tab/window/system audio per the user's pick |
| Electron / Windows | Chromium native loopback | Works out of the box |
| Electron / macOS 13+ | CoreAudio Tap (Catap) | Requires `NSAudioCaptureUsageDescription` (set by `electron-builder.yml#mac.extendInfo`) |
| Electron / Linux | PulseAudio loopback | **Requires** the `PulseaudioLoopbackForScreenShare` Chromium feature flag — enabled at startup in `main.ts` for Linux. Works on PulseAudio and on PipeWire systems with the `pipewire-pulse` compat layer. PipeWire-only systems without pulse compat will fail. |

**Failure handling.** When loopback is not supported, Chromium rejects the entire `getDisplayMedia` request — the source-picker selection has already been consumed, so silently retrying without audio would re-prompt the picker. `startScreenShare` (`utils/screenShare.ts`) instead surfaces a warning toast directing the user to disable "Share system audio" if their system does not support loopback. We do **not** auto-mutate the user's `shareAudio` preference.

---

## Voice Fullscreen

The fullscreen toggle in `VoiceControlBar` flips the `voiceFullscreen` flag in `uiStore`; an effect in `MainContent.tsx` calls `voiceContainerRef.current.requestFullscreen()` (and exits via `document.exitFullscreen()` when the flag clears). A second effect listens to `fullscreenchange` and reflects the actual `document.fullscreenElement` back into the store, so pressing Esc or system-level fullscreen-exit keeps state in sync. `voiceChatOpen && !voiceFullscreen` hides the side chat panel while fullscreen is active.

**Overlay portals:** While fullscreen is active the browser's Fullscreen API renders only descendants of `voiceContainerRef`. Every overlay reachable during a call (context menus on `StreamTile`/`VoiceUser`/`VoiceChannel`, tooltips on the control bar, `ConnectionInfoPopover`, `ScreenShareSettingsPopover`, `ConfirmDialog` invoked from voice context-menu actions, and `ScreenSharePicker`) portals through `usePortalContainer()` so it lands inside the fullscreen element. Adding new overlays that can be opened from inside the call must follow the same contract — see `docs/systems/design-system.md` Surface Material Tiers.

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
  restrictOwnAudio: true,    // Chrome 141+: exclude own tab audio
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 2             // Stereo
}
```

**Persistence:** `voiceStore` with Zustand localStorage. Keys: `echoCancellation`, `autoGainControl`, `rnnoiseEnabled`, `screenShareConfig`.

**Camera preset:** 1280x720, 2Mbps, 30fps, H.264

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
