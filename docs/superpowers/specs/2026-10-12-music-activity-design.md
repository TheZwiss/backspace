# Music activity: design

**Date:** 2026-10-12
**Status:** Proposal, open for discussion
**Touches:** desktop shell (new detector, new preload method), web client (activity merge, cards, profile, settings), Flatpak manifest. No server, database, WebSocket or federation changes.

## 1. What this is

When someone plays music on their computer, Backspace shows it on their profile and in member lists: track, artist, album, a progress bar and the cover when one is available. Anyone who sees it can open the same song on the service they use, whether or not it is the service the listener used.

Nobody connects an account. The desktop app reads what the operating system already knows about the media that is playing, the same data the system's media controls and lock screen show. That works for Spotify, Apple Music, TIDAL, YouTube Music, SoundCloud, VLC and any other player that reports to the OS.

## 2. What this is not, and why

**No Spotify API.** Under the February 2026 Development Mode rules, a new Spotify app is limited to 5 authorized users and the app owner must hold Premium ([migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)). Lifting the cap needs an organization with a launched service and at least 250k monthly active users ([quota update, July 2026](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates)). A self-hosted project cannot meet either condition, and asking every instance admin to register their own 5-user app is not a feature.

**No Listen Along.** Synced playback needs Spotify's playback-control scope, so it falls under the same limits.

**No history or scrobbling.** Activities stay ephemeral, as they are today: held in memory, gone on disconnect.

**No programmatic cross-service lookup.** Songlink's API (the one behind song.link) stopped answering keyless requests: `GET api.song.link/v1-alpha.1/links` returns `401 PUBLIC_API_ACCESS_DEPRECATED`, checked on 2026-10-12, and their notice says they no longer issue keys. The song.link web pages still work and are used below as a plain link, not as an API.

## 3. Where the data comes from

Each platform gets a detector in `packages/desktop/src/mediaDetector/` that produces the same `NowPlaying` value:

```typescript
interface NowPlaying {
  title: string;
  artist: string;
  album?: string;
  artUrl?: string;        // https only; anything else is dropped
  durationMs?: number;
  positionMs?: number;
  isPlaying: boolean;
  player: PlayerIdentity; // which app is playing, see section 4
  sourceUrl?: string;     // raw track URL from the OS, filtered in section 4
}
```

### Linux: MPRIS over D-Bus

Players publish `org.mpris.MediaPlayer2.*` names on the session bus. The detector lists them, subscribes to `PropertiesChanged` on each player and watches `NameOwnerChanged` for players starting and quitting. Fields: `xesam:title`, `xesam:artist` (an array, joined), `xesam:album`, `mpris:artUrl`, `mpris:length`, `xesam:url`, `PlaybackStatus`. Event driven.

Library: `dbus-next` is pure JavaScript and MIT, but its last release is from 2022. `@jellybrick/dbus-next` is a maintained MIT fork (last release September 2026). The fork is the proposal; see open question 6.

Flatpak: the sandbox currently allows only the notification and tray services on the session bus. The manifest needs `--talk-name=org.mpris.MediaPlayer2.*` in `finish-args`, with a comment, and the permissions paragraph in `flatpak/README.md` updated to match.

Spotify on Linux gives a `https://open.spotify.com/track/...` URL and an `https://i.scdn.co/...` cover. Browsers publish a session per playing tab; whether `xesam:url` carries the page address differs by browser and needs checking per browser during implementation.

### Windows: System Media Transport Controls

`@coooookies/windows-smtc-monitor` (MIT, prebuilt napi-rs binaries for x64, ia32 and arm64) wraps the WinRT session manager. Its calls block, so it runs in a worker thread that posts changes to the main process.

SMTC gives title, artist, album, duration, position, playback state and the source app id. It gives no track URL. The cover comes as image bytes, never a URL, so it is not used (see open question 3).

The package had its last release in March 2025. If it goes unmaintained, the replacement is a small Rust or C++ helper with the same output, which is a contained piece of work because the worker boundary already isolates it.

### macOS: distributed notifications, plus an adapter for other players

Spotify posts `com.spotify.client.PlaybackStateChanged` and Apple Music posts `com.apple.Music.playerInfo` as distributed notifications. Electron subscribes to these directly through `systemPreferences.subscribeNotification`, so no native addon is needed. Spotify's payload includes the track id, which gives an exact link.

Other players are only visible through the private MediaRemote framework. Since macOS 15.4, MediaRemote answers only processes Apple has entitled, which is why `nowplaying-cli` and similar tools stopped working. [mediaremote-adapter](https://github.com/ungive/mediaremote-adapter) (BSD-3-Clause, maintained) gets around this by running its helper through `/usr/bin/perl`, which Apple's allowlist accepts. It would ship inside the app bundle, so users install nothing.

That workaround depends on an Apple allowlist and can stop working with any macOS update. The design treats it as optional: if the adapter fails to start or returns nothing, the detector keeps Spotify and Apple Music and logs once. It never asks the user to install anything.

### Web and mobile

Browsers cannot read other tabs' or other apps' media, so phase 1 is desktop only. Open question 1 proposes a second source for web and mobile users.

## 4. What gets broadcast

### Which sessions count

The OS reports every media session, not only music: a YouTube video, a Twitch stream, a podcast, a video call in a browser tab. Treating all of them as "listening" would be wrong and would publish things the user did not mean to publish.

A session is reported when one of these holds:

- the player is a known music player (Spotify, Apple Music, TIDAL, Deezer, Amazon Music, YouTube Music desktop apps, foobar2000, MusicBee, Strawberry, Rhythmbox, Elisa, cmus, and so on), matched by D-Bus name, SMTC app id or macOS bundle id from a list kept next to the game dictionary;
- the session's URL is on a known music host (section 4, "Track URLs").

General media players (VLC, mpv) and browser sessions without a music URL are left out by default. Open question 2 asks whether to offer a switch for them.

When several sessions qualify, the one playing wins; among several playing, the one that changed most recently.

### Track URLs

`sourceUrl` is broadcast only after it passes a host allowlist and is reduced to its canonical form:

| Service | Accepted form | Kept |
|---|---|---|
| Spotify | `open.spotify.com/track/{id}`, `spotify:track:{id}` | `https://open.spotify.com/track/{id}` |
| YouTube Music | `music.youtube.com/watch?v={id}` | `https://music.youtube.com/watch?v={id}` |
| SoundCloud | `soundcloud.com/{user}/{track}` | the path, no query |
| Apple Music | `music.apple.com/{country}/album/{slug}/{id}?i={track}` | the path, with `i` as the only query parameter |
| TIDAL | `tidal.com/track/{id}`, `tidal.com/browse/track/{id}` | `https://tidal.com/track/{id}` |
| Deezer | `deezer.com/track/{id}` | `https://www.deezer.com/track/{id}` |
| Bandcamp | `{artist}.bandcamp.com/track/{slug}` | the path, no query |

Every query parameter not listed is removed. That matters: Spotify's `si` and YouTube's `si` identify the person who shared a link. Any URL that does not match a row is dropped, so a browser tab's address never leaves the machine unless it is a track page on one of these services.

### Mapping to `Activity`

The shared `Activity` type and the server's `validateActivities` already accept everything needed:

| `Activity` field | Value |
|---|---|
| `type` | `'listening'` |
| `name` | track title |
| `details` | artist |
| `state` | album |
| `timestamps` | `start` and `end` computed from position and duration, so the progress bar needs no further updates |
| `assets.largeImage` | `artUrl` when it is https, otherwise absent |
| `assets.largeText` | album |
| `assets.smallText` | player name for display, e.g. "Spotify" |
| `url` | canonical track URL from the table above, otherwise absent |

All strings are trimmed to `ACTIVITY_LIMITS` before sending.

### When it updates

The client debounce in `activityStore.pushActivities` is a trailing 5 second timer that restarts on every call. A detector that pushed on every position tick would therefore never send anything. The detector emits only on a track change, a play/pause change, a seek (detected as position drifting more than 3 seconds from the predicted position) or the player quitting.

A paused or stopped session is dropped after 10 seconds, so a track change or a short pause does not make the activity flicker.

## 5. Desktop to web client

The preload bridge ships with the installed desktop app, the web client ships with the server, and instances usually update before their users' desktop apps do. Changing the shape of the existing `onActivityDetected` would break game detection for everyone on an older desktop app, and an older web client would wrap a list in a list and get the whole update rejected by the server.

So the existing channel stays exactly as it is and music gets its own:

```typescript
// electron.d.ts: optional, feature-detected before use
onMediaDetected?: (callback: (activity: unknown) => void) => () => void;
getCurrentMedia?: () => Promise<unknown>;
```

`activityBridge.ts` keeps the latest process activity and the latest media activity separately and sends their merge to `pushActivities`. The reconnect re-push in `useWebSocket.ts` reads both getters.

**Merging with the process detector.** The game dictionary lists Spotify as `listening`, and VLC and mpv as `watching`, by process name. When the media detector has a track from the same app, the process entry for that app is dropped and the track takes its place. When Spotify is open with nothing playing, the process entry stays as it is today ("Listening to Spotify"). A game and a track show together: the game is primary by `ACTIVITY_PRIORITY`, the track is shown as secondary (section 7).

Tests for the bridge include a mock preload with the previous release's shape, which has no `onMediaDetected`, and check that game detection is unchanged.

## 6. Links for people viewing the activity

Links are built on the viewer's client from the activity payload. The listener's client and the servers never contact a music service on anyone's behalf.

The card offers, in this order:

1. **Exact link.** When `url` is set: "Open in Spotify" (or the matching service), to the canonical URL. Web links are used even for Spotify, since `spotify:` URIs fail silently in a browser, and `open.spotify.com` hands over to the desktop app when it is installed.
2. **Other services.** When `url` is set: a link to `https://song.link/{url}`. song.link resolves the track on its own page and lists it on every service it knows, so the viewer picks their own. Checked on 2026-10-12 for Spotify, Apple Music and YouTube URLs.
3. **Find on Apple Music, then everywhere.** When `url` is absent: on click, the viewer's client queries the iTunes Search API (`itunes.apple.com/search?entity=song`, keyless, sends `Access-Control-Allow-Origin: *`) with title and artist, and opens `https://song.link/i/{trackId}` for the best match. Nothing is sent until the viewer clicks, and what is sent is the title and artist they are looking at. A miss falls through to search links.
4. **Search links.** One per service in the viewer's list, each a search URL with `encodeURIComponent` applied to the query. These always work and are honest about being a search.

The services a viewer sees are their own choice, stored per device in phase 1. The defaults should depend on what is available where the viewer lives, which is open question 4.

Adding a service is one entry: name, icon, accent colour, an optional exact-URL matcher and a search URL template.

## 7. Interface

All surfaces follow the Aether Drift spec and the existing card patterns. Every string goes through i18next: new keys in `common` (activity labels) and `settings` (privacy section). Service names are brand names and are not translated.

- **`ActivityCard`** (member list, friends activity panel, mobile members screen): for `listening`, the title and artist instead of "x minutes elapsed".
- **Member rows:** a small equalizer mark at the right edge when someone is listening, also when a game is the primary activity. It stops under `prefers-reduced-motion`.
- **Profile popout and profile modal:** these show no activity at all today. They get an activity section: games as they appear in the member list, music as a card with cover (56px, or a placeholder), title, artist, album, progress bar and the links from section 6. The popout is a `.glass` surface and the card sits inside it as solid content, not as another layer of glass.
- **Hover on a member row** with a secondary track: a `.glass` popover with the track and its links.

## 8. Privacy

Music is more personal than a game title, and with no connect step the feature would otherwise start publishing the moment the desktop app updates. So:

- A new toggle, "Share what I'm listening to", in Settings, Privacy, under the existing activity toggle. **Off by default.** The first time a track is detected while it is off, the user area shows a one-time hint pointing to it, and never again after it is dismissed or the toggle is set either way.
- The existing activity toggle still turns off everything, music included.
- The toggle lives in the desktop app's local settings, since the detector runs there and only there. That way it also holds across instances the desktop app is connected to.
- When either toggle is off, the detector keeps running but nothing is pushed, so turning it on shows the current track at once.

## 9. Federation

Nothing in the protocol changes. Music activities take the paths game activities take today:

- **Through the home instance.** `handleActivityUpdate` relays the full `Activity[]` to peers with `queuePresenceRelay`. The receiver runs the same `validateActivities` in `processPresenceUpdateEvent`, so a payload the home accepts is one every peer accepts, and keeps it on the replicated row for its own clients.
- **Directly from the client.** `wsSendAll` sends `activity_update` to every instance the client is connected to, so an instance where the listener is signed in gets the update first-hand as well.
- **On the viewer's side.** `activityStore` keys activities by home identity (`userKey`), so the same person seen through two instances shows one activity. Links are built from the payload on the viewer's client. No instance ever looks up a track.

Things that matter more for music than for games, none of which needs a change:

- **Volume.** Tracks change every few minutes where games change every few hours. Presence is a `state` queue in the outbox (`federationOutboxQueue.ts`): a newer update replaces the queued one, so a slow or unreachable peer receives the latest state, never a backlog of tracks.
- **Older peers.** A peer on an older version accepts the payload (the `listening` type and every field used here have been in `validateActivities` since rich presence shipped). Its clients show the track title as a plain activity, without the music card.
- **Progress bar.** `timestamps` are absolute times from the listener's clock, so relay delay does not shift the bar, but a viewer whose clock is off by some seconds sees the bar off by the same amount.
- **Who receives it.** `queuePresenceRelay` sends to every active peer, not only peers where the listener has friends or shared spaces. A peer with no row for the listener drops the update, but the update does leave the home instance. That is how status and game activities work today. Narrowing it is a separate change to presence relay, not part of this proposal, and the toggle being off by default (section 8) is what keeps music from leaving at all unless the user turns it on.

Covers load from the music service's image host directly in the viewer's browser, the same way link embeds load their images today.

## 10. Dependencies

| Package | Platform | License | Native |
|---|---|---|---|
| `@jellybrick/dbus-next` | Linux | MIT | no |
| `@coooookies/windows-smtc-monitor` | Windows | MIT | prebuilt |
| `mediaremote-adapter` (vendored into the app bundle) | macOS | BSD-3-Clause | helper framework, built per arch |

Spotify and Apple Music on macOS use Electron's own API and add nothing. All three pass the licensing rule in CONTRIBUTING. The macOS adapter adds a framework to the bundle and a child process, so `docs/systems/desktop-security.md` gets a paragraph on what it runs and why.

## 11. Phases

1. **Detection and links on desktop.** Detectors for the three platforms, URL filter, bridge and merge, cards, profile activity section, privacy toggle, Flatpak permission.
2. **A source for web and mobile users,** if open question 1 settles on one.
3. **Covers for players that only give image bytes,** if open question 3 settles on a way.

## 12. Testing

- Unit tests per detector against recorded fixtures: MPRIS property sets from Spotify, a browser tab and a local player; SMTC sessions; Spotify and Apple Music notification payloads; adapter output.
- URL filter: every row of the table, tracking parameters removed, non-music URLs dropped, malformed input.
- Link builder: encoding, exact versus search tiers, the iTunes lookup's miss and error paths.
- Bridge: merge rules, previous preload shape, reconnect re-push.
- The debounce interaction: a detector emitting on track change only, and a track change inside the 5 second window.
- By hand on each platform with Spotify, a browser player and a local player, with screenshots of each new surface opened from where it is mounted.

## 13. Open questions

These are the points the design does not settle on its own. Each one names the decision it would change.

1. **A source for web and mobile.** Phase 1 leaves out everyone without the desktop app, which will include the mobile apps. One candidate: the user enters a Last.fm or ListenBrainz username and their client reads "now playing" from it. Last.fm receives Spotify plays through Spotify's own scrobbling setting, and ListenBrainz has a public `playing-now` endpoint. Last.fm needs an API key, which raises who holds it (instance admin, or the project). It also needs checking how quickly each service reports a new track, since a feed that lags a track behind is worse than none.
2. **Browser and general media players.** Should there be a second switch, "Also share media from browsers and video players", so YouTube Music or SoundCloud in a browser tab on Windows and macOS (where no URL is available) can be shared? Off by default either way.
3. **Covers on Windows and for most macOS players.** The OS hands over image bytes, not a URL. Options: the listener's client looks up the cover on the iTunes Search API by title and artist, which sends their listening to Apple without them clicking anything; the listener's client uploads the image to their home instance and the activity points there, which needs a small server endpoint and cleanup; or a placeholder, as in phase 1.
4. **Which services, where.** Spotify is not available everywhere, and song.link does not cover every regional service. The default link list could follow the viewer's interface language or be the same for everyone. Which services belong in it, and do the players used in a given region publish to the OS media controls at all?
5. **Per-device service list.** Phase 1 stores the viewer's service choice per device. Syncing it across devices needs a per-user preference store, which does not exist yet.
6. **D-Bus library.** The maintained fork with a small following, or the original with no release since 2022.

## 14. Docs to update when this is implemented

- `docs/systems/activity-presence.md`: the media source, the merge with the process detector, the new preload methods, the privacy toggle.
- `docs/systems/desktop.md`: the detector module and its per-platform backends.
- `docs/systems/desktop-security.md`: the adapter's child process and bundled framework.
- `flatpak/README.md`: the MPRIS permission.
- `docs/systems/localization.md` only if a new namespace is added; the plan above adds keys to existing ones.
