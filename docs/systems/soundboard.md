# Space soundboard

Shared clips belong to the space's hosting instance, not to the uploader's home.
The client uses that instance's API/token and row ids for every request. No S2S
relay is needed: space voice users already connect directly to their host.

## Storage and media

Migration `0032_soundboard` creates `soundboard_settings` (one row per space;
absent rows read the shared defaults) and `soundboard_sounds` (indexed by space).
Settings: enabled, member uploads, duration cap in seconds (`null` = unlimited),
and collection capacity. Defaults: enabled, members may upload, 10 seconds,
50 sounds. Capacity is configurable from 1 to 100. Space deletion cascades both
tables; hard account deletion cascades its clips.

The browser decodes a picked audio file locally, shows a waveform, and allows
numeric/range start and end selection with a private preview. Confirmation
downmixes the selection to mono, resamples to 48 kHz, and encodes signed 16-bit
PCM WAV with a 5 ms boundary fade. Only the selection is uploaded, as base64
JSON. Browser-decoded source audio is bounded to 50 million channel-samples;
source and encoded files have a 20 MiB ceiling. The instance's upload ceiling
can further restrict the encoded file. No new dependencies or ffmpeg required.

The server accepts only the exact canonical 44-byte PCM header, checks every
field, rejects trailing/truncated data, derives duration from the sample count,
and applies the current space cap. Metadata/MIME/client durations are not trusted.
Unlimited duration removes the time policy, not the byte/storage limits.
Clips must be at least 0.1 seconds. Files use fresh snowflake `.wav` filenames
in `UPLOAD_DIR`; stored references protect them from `cleanupStorage`. Deleted
clips and space/account cascades leave orphan files for the existing janitor.
The ordinary public-link upload endpoint serves clips with its Range, caching
and sandbox policy. Links are public like chat attachments, not access-revocable.
Upload publication/quota checking is synchronous with its database transaction,
so the janitor cannot race a new file. Write/database errors clean up the file.

## API and authorization

All catalog/mutation/play endpoints require JWT and actual space membership,
including instance administrators. Paths under `/api/spaces/:spaceId/soundboard`:

| Method | Suffix | Contract |
|---|---|---|
| GET | empty | `{settings, sounds}` |
| PATCH | `/settings` | Full `SoundboardSettings`; requires MANAGE_SPACE |
| POST | empty | `{name, emoji, audio}`; name 1–48 chars, icon 1–16; returns clip (201) |
| DELETE | `/:soundId` | Own clip or MANAGE_SPACE; `{success:true}` |
| POST | `/:soundId/play` | `{channelId}`; `{success:true}` |

Non-managers upload only with ATTACH_FILES at space scope and member uploads
enabled. Disabled panels refuse uploads and playback, but retain their catalog
and allow management/deletion. Per-account uploads: 10 per minute. Capacity is
checked at insertion. Settings accept 0.1–86400 seconds or null; lowering a cap
retains existing clips but disables playback above it. Settings changes do not
truncate or stop an already-running clip.

Playback checks that the caller owns an active voice socket in the named voice
channel, that the channel and clip belong to this space, and that the caller has
VIEW_CHANNEL, CONNECT and SPEAK there. Space/permission mute and deafen block
playback; self microphone mute does not (the soundboard is separate from mic
capture). User and room each allow one play per two seconds, preventing multiple
members from bypassing the room budget.

Errors: `soundboard_disabled`, `soundboard_invalid_audio`,
`soundboard_duration_limit` (`max`), `soundboard_full` (`max`),
`soundboard_not_found`, plus existing authorization/validation/rate-limit codes.

## Realtime and output

`soundboard_updated {spaceId}` goes to space members after upload/delete/settings
writes. Clients refetch only catalogs already loaded; origin/account/space keys
and monotonic request generations reject late replies after reset/refetch.

`soundboard_play {channelId, spaceId, sound}` goes only to the voice-owning open
socket of each current room participant who remains a member with VIEW_CHANNEL
and is not deafened. No other tabs, rooms or disconnected sockets receive it.
Clients additionally check the event origin, current channel and LiveKit
connection, fetch a bounded file from that origin and decode it locally.
Playback goes to AudioManager's master bus, respecting the selected output
device, compressor and output volume, never to the microphone or a new LiveKit
track. One clip plays locally at a time; a new clip replaces the previous one.
Room changes, disconnect, logout and deafen stop/abort playback. The panel has
an independent local volume and a local Stop; these do not affect other listeners.
Network/decode failures show a localized warning. Playback is best-effort, not
sample-synchronized: each listener starts once their download/decode completes.

## UI and shortcuts

Desktop voice sidebar/control bar and mobile call controls open the shared
responsive modal/sheet. Search, private preview, upload/crop, deletion confirmation
and per-clip shortcut capture share the same catalog. Space Settings > Soundboard
is a lazy-loaded management panel, accessible only with MANAGE_SPACE.
Existing matte/glass/input tokens are reused; the mobile control row wraps.
All new copy/error codes ship in en, pt-BR, de, ru and zh catalogs.

Shortcuts are device-local preferences keyed by account, origin, space and sound,
never shared with other members. They match physical keys and exact modifiers,
ignore repeated/composing events, text inputs and dialog focus, and require an
active authorized space voice session. Duplicate shortcuts within the current
space and conflicts with voice controls are refused. Backspace/Delete clear a
binding. They work **only while the app is focused**, including Electron; no
background OS shortcut registration is added. DM calls have no space soundboard.
