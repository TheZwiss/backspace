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
  shareAudio: boolean               // System audio (disabled in Electron)
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
