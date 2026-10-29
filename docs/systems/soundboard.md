# Soundboard

Members can play short effects in server voice channels and active private calls.
Open **Sound effects** in the call controls or beside AI noise suppression in the
“Voice connected” controls. The panel opens above and slightly to the right of
the clicked button, with a translucent background, no dimming overlay or focus
trap, and viewport-aware positioning. Server settings and the
server context menu also expose a library with upload, local preview and deletion.

The top row contains search and a speaker button that opens the listener's volume
slider. The main area shows up to three personally most-used effects, then the
current server's effects in three columns, followed by other joined servers.
A left rail lists servers with effects and scrolls within the panel. Small static
server avatars precede section names; rail GIFs animate only while hovered.
Successful plays update local frequency counts separately for each account and
instance. Inaccessible or deleted sounds cannot appear in the frequent list.

The server supplies the authenticated actor's LiveKit identity in playback events.
While the actual effect plays, that participant's call avatar and voice-list row
use a blue outline, with priority over the green microphone-speaking outline.
The marker clears on completion, replacement, stop or leaving the call. Personal
previews do not create a marker; older events without an actor still play.

## Limits and permissions

- 40 effects per server, up to 5.2 seconds each.
- Upload a browser-decodable audio file up to 5 MB. The client converts it to mono,
  48 kHz, 16-bit PCM WAV; the server validates the complete canonical header and
  maximum 499,244-byte payload rather than trusting MIME types or client metadata.
- **Create sound effects** allows uploading and deleting one's own effects.
- **Manage sound effects** allows deleting any effect in the server.
- **Use sound effects** and **Use external sound effects** support role and channel
  overrides. Both are enabled for the default everyone role. Existing numeric
  everyone roles receive these two bits during migration.
- Playback also requires channel visibility, connect and speak permissions. Muted,
  deafened and server-restricted senders cannot trigger effects.
- External packs require source-server membership, without a paid subscription.
- Each sender can trigger one effect every two seconds; each call allows five
  triggers per ten seconds. Uploads allow ten attempts per minute per user.

The listener has a persistent soundboard volume slider. Effects use the existing
audio output device and output volume. Deafening or leaving the receiving call
stops playback. A new effect replaces the previous one locally. Local previews
are not broadcast.

## Storage and delivery

SQLite stores compressed assets separately from server-specific entries. SHA-256
deduplicates identical canonical audio across packs. Brotli quality 4 reduces
storage without introducing FFmpeg or another native executable, preserving the
existing Node/SQLite deployment on Debian and Termux. An asset is removed after
its final entry is deleted, including cascaded server deletion.

The HTTP playback endpoint checks current call membership and permissions, then
sends a reliable server-originated LiveKit data packet on
`backspace.soundboard.v1`. Peer-originated packets cannot trigger this handler.
The packet contains a random, 90-second download capability, not an authentication
token. This lets actual call recipients hear an external pack without joining its
source server. Clients cache up to 16 decoded clips and download only on a miss.
The server keeps at most 2,000 temporary capabilities in memory; restarting it
invalidates outstanding downloads.

The capability endpoint intentionally does not require a login: possession of its
unguessable short-lived URL grants access to that clip. Authenticated library
downloads still require source-server membership.

Pack browsing and external-pack reuse currently cover servers on the call's
hosting instance. This is not a complete cross-instance soundboard federation
protocol; remote private-call hosting and importing packs from another instance
need separate integration work.

## Reference and validation

Behavior is based on Discord's [Soundboard FAQ](https://support.discord.com/hc/en-us/articles/12612888127767)
and [Soundboard API](https://docs.discord.com/developers/resources/soundboard).
The 40-effect quota and membership-only external reuse follow this project's
requirements rather than Discord's subscription tiers.

Automated coverage exercises PCM validation, membership, permissions, quota,
deduplication and cleanup, private calls, external packs, playback grants,
rate limits, server-only packet handling, cache reuse and leaving during download.
The local integration probe connects two real LiveKit participants, triggers the
HTTP playback route and measures the decoded signal through the client's actual
audio output graph. This verifies transport and decoding; it does not substitute
for listening on the user's Windows or phone hardware.
