# ADR 0001: Mobile client architecture

| | |
|---|---|
| Status | Proposed, open for review |
| Date | 2026-09-04 |
| Issue | [#46 Mobile app version](https://github.com/TheZwiss/backspace/issues/46) |
| Prior analysis | st7105's two comments on #46, see [Prior analysis](#prior-analysis) |

## Summary

Backspace gets native Android and iOS apps that host the existing web client
inside a Capacitor shell, with the bundled client talking to a user-chosen
home instance. Voice runs on a native media plane in the shells (the LiveKit
Swift and Android SDKs) because a WebView cannot keep a microphone open with
the screen locked on iOS. Push uses the Web Push wire format end to end: the
PWA subscribes directly, Android can use UnifiedPush, and store builds go
through a small stateless relay the project hosts because only the app
publisher can hold Apple's and Google's push credentials. Three protocol
changes come first because every client benefits from them: an explicit home
origin in the web client, an idempotency key on message creation, and push
subscriptions on the server.

The React Native rewrite proposed on #46 is not adopted, for reasons set out
under [Alternatives](#alternatives-considered). The prerequisites it
identified are adopted almost unchanged.

## Context

### What exists

- A mobile layout of the web client, about five thousand lines under
  `packages/web/src/components/layout/Mobile*.tsx`: three-tab shell, screen
  stack with slide transitions, swipe gestures, bottom sheets, full-screen
  voice view, mini bar. Spec: `docs/systems/mobile-ui.md`.
- An installable PWA (`vite-plugin-pwa`, service worker, offline message
  queue). The README tells phone users to install it.
- A desktop app that is a thin Electron shell loading the instance's own page
  from the network, with an instance picker, a versioned preload bridge on
  `window.backspace`, a `will-navigate` policy, and `backspace://` deep links.
  Specs: `docs/systems/desktop.md`, `docs/systems/desktop-security.md`.
- Client-side federation: one authenticated REST and WebSocket session per
  instance, the empty origin string meaning "home", and origin-aware routing
  through `getApiForOrigin`. Spec: `docs/systems/client-federation.md`.
- Voice on LiveKit through `livekit-client` in the browser, driven from
  `hooks/useLiveKit.ts` and `stores/voiceStore.ts` (about eighteen hundred
  lines together), six files import the SDK. Spec: `docs/systems/voice.md`.
- No push of any kind. `platform/notifications.ts` uses the bare
  `Notification` constructor, which never fires with the page suspended and
  does not work at all on Android Chrome, where notifications must go through
  a service worker.
- CORS reflects the request origin and the API carries no ambient credential,
  so a client served from another origin can already talk to an instance.
  Spec: `docs/systems/web-security.md` §6.

### What the PWA cannot do on a phone

These are platform facts, not missing optimisation. Each was checked against
primary sources listed at the end.

1. **iOS suspends WebRTC when a home-screen web app is locked.** Safari and
   home-screen web apps lose WebRTC and Web Audio as soon as the screen locks
   or the app leaves the foreground. There is no web entitlement for
   background audio. A voice channel in the PWA ends the moment the phone is
   locked. (Apple developer forum thread 774239, WebKit.)
2. **A WebView on iOS mutes the microphone in the background.** Even inside a
   native app with the audio background mode, WKWebView stops sending
   microphone input when the app is backgrounded. Incoming audio continues,
   outgoing stops, and the WebSocket drops after roughly thirty seconds.
   Microsoft documents this as system behaviour for its own calling SDK in
   WKWebView, and WebKit bug 241480 (filed June 2022) is still open. One forum
   report claims it works on iOS 17.5.1 with the audio background mode, and is
   contradicted by later reports on iOS 18. This is the fact that decides the
   voice architecture: **the web layer cannot own the media session on iOS**.
3. **WebViews cannot receive Web Push.** Neither Android WebView nor WKWebView
   implements the Push API. A native app receives notifications through FCM
   (Android) and APNs (iOS), and both require credentials that belong to the
   app publisher, not to the instance operator.
4. **Web Push does work for the PWA** on Android Chrome and on iOS 16.4 and
   later, provided the site was added to the home screen and the permission
   request follows a tap. This is the cheapest notification win and it needs
   no shell at all.
5. **Android WebView WebRTC in the background is not reliable either.** The
   WebView is a UI component of the foreground activity; Android 14 requires
   a foreground service with a `microphone` type to keep capture alive, and
   community guidance for WebView calling apps is to move the call into the
   host app rather than keep it in the page. The ADR does not depend on it
   working.

### Constraints

- **One maintainer, review capacity is the bottleneck** (CONTRIBUTING). Any
  design that adds a second UI to keep in parity with the web one is a
  permanent tax paid on every feature.
- **Self-hosted and federated.** There is no central Backspace server. The
  app must not depend on the project's infrastructure to function, and any
  infrastructure that is unavoidable (push credentials) must be small,
  stateless, and replaceable by a fork.
- **Licensing.** The commercial edition rules out strong copyleft; weak
  copyleft only at arm's length (CONTRIBUTING). Every dependency named below
  was checked: Capacitor MIT, LiveKit SDKs and components Apache-2.0,
  UnifiedPush connector Apache-2.0. UnifiedPush's embedded FCM distributor is
  LGPL-2.1 and is **not** used; the FCM path is written against Capacitor's
  MIT push plugin instead.
- **Federation-compatible.** No global user id. Push subscriptions and mention
  detection must work with federated identities.
- **Store rules.** Apple guideline 4.2 rejects "repackaged websites"; 2.5.2
  forbids downloading code that changes app functionality outside WebKit. A
  bundled web client plus native push, native voice, and a server picker
  satisfies both; the Home Assistant iOS app has shipped on the same model for
  years.

## Decisions

### D1. The shells host the existing web client, bundled, in Capacitor

`packages/mobile` becomes a Capacitor 8 project (Android API 24+, iOS 15+)
whose web assets are the build output of `packages/web`. The UI stays one
codebase. Capacitor's `server.url` remote-loading mode is documented as "not
intended for use in production", so the Electron pattern of loading the
instance's page from the network is not carried over; the client is bundled
and connects to a configured home origin (D2).

Consequence: an app release is needed for UI changes. This is the trade the
desktop avoids and it is accepted because the alternative is unsupported by
the framework. An in-app updater for the web bundle is possible later within
Apple's 2.5.2 (JavaScript run by WebKit is explicitly allowed) and is out of
scope here.

### D2. The web client gets an explicit home origin

Today the empty-origin sentinel resolves to `window.location` in about forty
places (`utils/identity.ts`, `stores/instanceStore.ts`, `hooks/useWebSocket.ts`
`buildWsUrl`, `api/client.ts`, invite parsing, media path handling). This
becomes one module, `platform/homeOrigin.ts`, exposing `homeOrigin()` and
`homeHost()`. On web and desktop it returns `window.location`; in a shell it
returns the origin the user selected. The sentinel convention (`''` = home) is
kept so `getChannelOrigin` and the DM failover logic do not change; only the
resolution of the sentinel moves.

This is the first PR of the track and it changes no behaviour on web or
desktop. It is verified by the existing suites plus a test that boots the
client with a non-location home origin.

### D3. Shell bridge: a versioned global, no build dependency

The shell injects `window.backspaceShell` before the app bundle loads, the
same way Electron's preload injects `window.backspace`. The web client feature
detects it, never imports Capacitor packages, and guards every call with a
`contractVersion` check (the pattern already used for `DesktopUpdateStatus`).
The contract is a TypeScript declaration in `packages/web/src/platform/`,
mirrored in `packages/mobile`, and a test asserts the two stay identical.

Bridge surface for the first release: `platform` (`android` | `ios`), home
origin get/set, push registration, app lifecycle events, deep-link delivery,
hardware back button (Android), keyboard and safe-area insets, share sheet,
open-external-URL, and the media plane (D4).

### D4. Voice: native media plane in both shells, web UI unchanged

Because of fact 2 the media session on iOS must be native. The same design is
used on Android so there is one media path in the shells, one bridge contract,
and one place for foreground services, audio routing, and later call
integration.

- `packages/web` gains a `MediaPlane` interface: connect with LiveKit URL and
  token, publish and mute microphone, camera on/off, participant and track
  events, audio device selection. `useLiveKit.ts` is refactored to drive that
  interface instead of `livekit-client` directly. The browser implementation
  wraps `livekit-client` and is what web, desktop, and the PWA keep using, so
  this refactor is testable on its own and ships first.
- The shell implementation forwards the interface over the bridge to the
  LiveKit Swift and Android SDKs (both Apache-2.0, both active). Screen share
  is not offered in the shells in the first release.
- **Remote video** is rendered by native views positioned into rectangles the
  web UI reports over the bridge. This is the approach Capacitor's own Google
  Maps plugin uses (native view beneath a transparent WebView on Android,
  rendered into the WebView on iOS). Voice channels and audio calls ship first;
  video tiles follow in a second step. Until then the shell exposes no camera
  control.
- Voice state signalling (`voice_state_update`, moderation, `dm_call_*`) stays
  on the Backspace WebSocket exactly as today. Only media moves.

### D5. Nothing that must run in the background lives in the web layer

The WebView is not guaranteed to run while the app is backgrounded. Anything
that must survive lives natively: the media session (D4), push receipt (D6),
the incoming-call UI (D8). The shell closes the Backspace WebSockets when the
app is backgrounded and reopens them on foreground; the existing reconnect
path then delivers a fresh `ready`. Push wakes the app for anything that
matters in between. This is the answer to "several permanent mobile sockets"
from #46: there are none.

### D6. Push: Web Push wire format only, four delivery paths, one sender

The instance implements exactly one sender: RFC 8030 delivery with RFC 8291
encryption and RFC 8292 VAPID, written against Node's `crypto` (no new
dependency; the usual npm library, `web-push`, is MPL-2.0) and tested against the
RFC 8291 test vector. VAPID keys are minted on first boot next to
`instanceId` in `ensureDefaults`. A `push_subscriptions` table holds
`user_id`, `endpoint` (unique), `p256dh`, `auth`, `transport`, `device_label`,
`created_at`, `last_used_at`, `failure_count`, created by
`POST /api/push/subscriptions` and deleted by the matching `DELETE`.

Delivery paths, none of which the instance can tell apart:

| Client | Endpoint | Who runs it | Credentials needed |
|---|---|---|---|
| PWA | the browser's push service | Google, Apple, Mozilla | none |
| Android with a UnifiedPush distributor installed | the distributor's endpoint (UnifiedPush is Web Push) | the user's choice, e.g. ntfy | none |
| Android store build without a distributor | the project relay, which forwards the ciphertext to FCM | the project | FCM, held by the relay |
| iOS | the project relay, which forwards the ciphertext to APNs | the project | APNs, held by the relay |

The relay (`backspace-push-relay`, its own repository, stateless, one
container) accepts RFC 8030 requests at a per-device endpoint, validates the
VAPID keys registered for that device, and forwards the encrypted body as a
data message. It never sees plaintext. On iOS a Notification Service
Extension decrypts and renders the alert (the pattern Element uses). The relay
is bound to the app's signing credentials, not to any instance, so an
operator cannot swap it for store builds; a fork that builds its own app runs
its own relay, and the relay URL is a build-time setting of the app.

Registration is per instance: the app registers its endpoint with every
instance it holds a session on, each under that instance's VAPID key, and
each instance pushes its own activity. This needs no new federation protocol.
The PWA can only subscribe to its own origin, so PWA users get push from the
home instance only; documented limitation.

First-release triggers: DM messages, `<@id>` mentions (server-side detection,
new, matching the client rule in `utils/notificationFilters.ts` that any id in
the user's identity set counts, so federated ids are included), incoming
calls, friend requests. The encrypted payload carries author, a short preview,
and the ids to deep-link into. Per-channel mute and a server-side notification
preference model are a later item; the server has none today.

### D7. Message creation gets an idempotency key

`CreateMessageRequest` and its DM twin gain `nonce` (client UUID). The server
stores it, returns the existing message on a repeat within the retention
window instead of creating a second one, and includes it in the broadcast.
The pending-message outbox (`stores/pendingMessageStore.ts`) matches by nonce
instead of by content and attachment ids. This fixes duplicate sends on
flaky links for every client, and is required before a mobile outbox can
retry safely.

### D8. Calls: CallKit and ConnectionService, second phase

A ringing DM call while the app is closed needs a VoIP push and CallKit on
iOS (Apple requires every VoIP push to report a call), and a
`ConnectionService` with a foreground service on Android. Both are native
additions to the shell on top of D4 and D6 and ship as their own step. Until
then an incoming call arrives as an ordinary push notification that opens the
app.

### D9. Deep links reuse `backspace://`

Universal links cannot be registered for arbitrary instance domains. The
shells register the `backspace://` scheme the desktop already uses, and the
join page keeps working for pasted `https://instance/join/code` URLs inside
the app.

### D10. Order and scope

Android first, iOS second. The first store release is text plus voice
channels and audio DM calls, push, uploads, the offline message queue, and
multi-instance connections. Video tiles, screen share, and system call
integration follow as separate steps. iOS follows once Android is stable
because it adds a paid developer account, a Mac build lane, and the
Notification Service Extension on top of the same code.

### D11. Distribution

- Android: signed APK on GitHub Releases from CI; Google Play (personal
  accounts created after 13 November 2023 must run a closed test with twelve
  testers for fourteen days per app before production access); an F-Droid
  flavour without Google services, UnifiedPush only, whose feasibility on
  F-Droid's build servers is an open question below.
- iOS: TestFlight, then the App Store. Requires the Apple Developer Program
  and the same macOS CI runners the desktop build uses.
- Signing keys are repository secrets, never committed.

### D12. Security posture mirrors the desktop

`docs/systems/desktop-security.md` is the template: the bridge is the only
privileged surface, it is versioned and feature-detected, top-level
navigation is restricted to the bundled app and the configured instances,
external links open in the system browser, and the shell's `index.html`
carries its own Content Security Policy (`connect-src https: wss:`, the
instance's `/uploads` for media). Session tokens stay in WebView storage
inside the app sandbox for the first release, the same posture as the desktop;
Keychain and Keystore custody via the bridge is a later hardening item with
its threat model written down when it is done.

### D13. Client and instance versions can differ

A bundled client will meet instances of other versions. The app reads
`GET /api/instance/info` before login, refuses instances below a minimum
version it declares, and shows what to do. Route removals on the server get
a deprecation window of two minor releases from now on so an older app keeps
working across an instance upgrade. This is new discipline and it is cheap
compared to the alternative of shipping the client with the instance.

## Alternatives considered

**React Native UI over a shared TypeScript client core** (the second
proposal on #46). Technically sound and the right shape for a team of the
size Element or Discord have. Here it means a second UI of at least the size
of the current mobile layout, rebuilt before it delivers anything the PWA
does not, then kept in parity forever by one reviewer. Its prerequisites
(origin abstraction, idempotent sends, device registration, push design,
native LiveKit SDK, secure storage) are all adopted by this ADR, so the door
stays open: if a team forms later, the client-core extraction starts from a
codebase that already has the seams.

**React Native shell with a WebView for chat** (the Jellyfin mobile model).
Would let the native voice UI be written once in TypeScript. Rejected because
D4 needs no native voice UI at all, only native media and video views, and
because React Native brings its own upgrade cadence and a slope toward
rewriting screens.

**Flutter.** Rewrites the client and federation logic in Dart. Not considered
further.

**Trusted Web Activity.** Digital Asset Links bind the app to one origin.
Incompatible with self-hosting, and it does not solve push or voice.

**Capacitor loading the instance's page remotely** (the Electron model).
Preferred for keeping client and instance in lockstep, rejected because the
framework documents that mode as not for production, and a hand-written
Swift and Kotlin shell to do it properly is two more codebases.

**WebView media plane everywhere.** Works in the foreground on both
platforms and would have needed no native voice code. Rejected by fact 2:
iOS mutes the microphone in the background and the connection drops, and the
whole point of a native app for this project is voice with the screen off.

**Native voice screens per platform.** Duplicates the voice UI three times.
Native video views behind the web UI (Capacitor's own maps plugin pattern)
keep one UI.

**Native push without a relay.** Not possible: FCM and APNs credentials
belong to the publisher. UnifiedPush and Web Push cover everything that can
be covered without one; the relay is scoped to the residual.

## Consequences

Positive: one UI codebase; every prerequisite ships value to web and desktop
first; push arrives for the PWA before any app exists; no permanent sockets
on phones; the instance never talks to Google or Apple; forks can run the
whole stack themselves.

Negative and accepted: app releases for UI changes; version skew between app
and instance becomes a real thing (D13); native code in Swift and Kotlin for
the media plane, video views, push, and calls, which is the part of the
project that needs physical devices to test (CONTRIBUTING's evidence rule
applies to every PR touching it); the relay is infrastructure the project
runs indefinitely, small but not zero.

Not decided here: an in-app web bundle updater; a server-side notification
preference model; end-to-end encrypted push previews per user; the exact
`MediaPlane` interface, which the refactor PR defines.

## Sequence of work

Each step is a separate pull request or a small series, is reviewable on its
own, and leaves the project better even if the next step never happens.

| Step | What | Who benefits | Needs a device |
|---|---|---|---|
| 1 | Web Push for the PWA: server sender, VAPID bootstrap, subscriptions table and routes, service worker handler, opt-in UI, mention detection | every PWA user today | phone for evidence |
| 2 | Message nonce (D7) | web, desktop, PWA | no |
| 3 | Home origin module (D2) | none visibly; unblocks the shell | no |
| 4 | `MediaPlane` interface with the browser implementation (D4, first half) | none visibly; unblocks native voice | no |
| 5 | Capacitor Android shell: bridge, server picker, text, uploads, deep links, back button, debug APK in CI | Android users | yes |
| 6 | Relay repository and Android push (UnifiedPush and FCM paths) | Android users | yes |
| 7 | Native media plane on Android, foreground service, audio routing | Android voice | yes |
| 8 | Signed release APK, Play closed testing, F-Droid flavour | distribution | yes |
| 9 | iOS shell, APNs path with the Notification Service Extension, native media plane on iOS, TestFlight | iOS users | yes, plus a Mac |
| 10 | Video tiles (native views) on both | video calls in the apps | yes |
| 11 | CallKit and ConnectionService with VoIP push (D8) | ringing while closed | yes |

Steps 1 to 4 are ordinary web and server PRs. Step 5 is the first one that
needs the evidence rule. A spike for step 5 should run before step 4 is
finished, to confirm on hardware what this document claims from sources: the
bridge works from bundled assets, cold start with no network shows a usable
picker, and the audio background mode keeps a native LiveKit session alive
with the screen locked.

## Open questions

1. Does the audio background mode keep a native LiveKit session and the
   microphone alive on current iOS with the app backgrounded? Expected yes
   (native capture is documented to continue); the iOS spike measures it.
2. Can F-Droid's build servers produce the web bundle for the Capacitor
   flavour? If not, the F-Droid path is a reproducible build recipe published
   with the release and inclusion waits.
3. Which minimum instance version does the first app declare (D13)? Likely
   the release that ships steps 1 to 3.
4. Should the relay accept registrations from any app signature or only the
   project's? Only the project's is simpler and matches the credential
   binding; forks run their own.

## Prior analysis

st7105's first comment on #46 identified the same-origin assumptions, argued
for reusing the web client in a shell, and named Web Push as the first
notification step. The second comment identified the missing idempotency key,
the absence of device registration and push, the credential problem behind
self-hosted push, the need for the native LiveKit SDKs, and the cost of
permanent mobile sockets. This ADR adopts all of those findings. Where it
departs from the second comment is only on where the UI lives.

## Sources

- Apple developer forum, "Safari Should Allow Background WebRTC for Real-Time Audio Apps": https://developer.apple.com/forums/thread/774239
- WebKit bug 241480, "WKWebView WebRTC session loses microphone input when the app goes into the background" (open): https://bugs.webkit.org/show_bug.cgi?id=241480
- Apple developer forum threads 689182 and 727009 on the same behaviour: https://developer.apple.com/forums/thread/689182, https://developer.apple.com/forums/thread/727009
- Microsoft Learn, calling from WKWebView and Android WebView, "Known issues": https://learn.microsoft.com/en-us/azure/communication-services/quickstarts/voice-video-calling/get-started-webview
- WebKit blog, "Web Push for Web Apps on iOS and iPadOS": https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- Capacitor configuration reference (`server.url` "not intended for use in production"): https://capacitorjs.com/docs/config
- Capacitor Android and iOS support: https://capacitorjs.com/docs/android, https://capacitorjs.com/docs/ios
- Capacitor Google Maps plugin rendering approach: https://capacitorjs.com/docs/apis/google-maps
- UnifiedPush developer introduction (Web Push, RFC 8291, VAPID): https://unifiedpush.org/developers/intro/
- Google Play, app testing requirements for new personal developer accounts: https://support.google.com/googleplay/android-developer/answer/14151465
- App Store Review Guidelines 2.5.2, 2.5.6 and 4.2: https://developer.apple.com/app-store/review/guidelines/
- Home Assistant iOS app architecture (WKWebView frontend, native shell): https://developers.home-assistant.io/docs/apple/architecture/
- RFC 8030, RFC 8291, RFC 8292.
- Licenses checked on 2026-09-04: Capacitor MIT; livekit/client-sdk-swift, client-sdk-android, components-swift, components-android Apache-2.0; UnifiedPush/android-connector Apache-2.0; UnifiedPush embedded FCM distributor LGPL-2.1 (not used); npm `web-push` MPL-2.0 (not used).
