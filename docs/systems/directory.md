# Space Directory ("Outer Space")

The opt-in public directory of spaces. A space owner asks for a space to be
listed, the instance admin has allowed listing on that instance, and the space
appears in the Outer Space section of the Explore page on every Backspace
instance that reads the same hub. Joining an entry runs the existing
connect-then-join flow. Nothing is listed until both people act, and the hub
never holds anything an instance does not serve on a public endpoint of its
own.

Source files:
- `packages/server/src/directory/state.ts` - the five `instance_settings` columns, `markDirectoryDirty`, `readDirectoryBrowseEnabled`, the in-memory document version
- `packages/server/src/directory/document.ts` - `buildDirectoryDocument`, the pure builder, and `absoluteAssetUrl`
- `packages/server/src/directory/pinger.ts` - `sendDirectoryPing`, `pingerTick`, `startDirectoryPinger`, `stopDirectoryPinger`
- `packages/server/src/routes/directory.ts` - `GET /api/directory/spaces` (the document) and `GET /api/directory` (the feed proxy)
- `packages/server/src/routes/settings.ts` - `applyDiscoveryAndDirectory`, the discovery-off invariant, the dirty marks on both PATCH routes
- `packages/server/src/routes/spaces.ts` - `directoryListed` on `PATCH /api/spaces/:id`, the dirty marks on update and delete
- `packages/server/src/routes/instance.ts` - `directoryConfigured`, `directoryAvailable` and `directoryEnabled` on the public instance info
- `packages/server/drizzle/0015_real_tomas.sql` - the five columns; `0016_whole_loki.sql` - `directory_browse_enabled`
- `packages/shared/src/types.ts` - `DirectoryPingError`, `DirectoryDocument`, `DirectoryDocumentSpace`, `DirectoryEntry`, `DirectoryFeed`
- `packages/shared/src/errors.ts` - the four `directory_*` error codes
- `scripts/directory-hub/` - the Cloudflare Worker at `explore.backspacechat.com` (`src/index.ts` routes, `src/validate.ts`, `src/store.ts`, `src/hash.ts`, `migrations/0001_directory.sql`)
- `.github/workflows/directory-hub.yml` - the hub's test job and its dispatch-only deploy
- `packages/web/src/stores/directoryStore.ts` - the feed, the page dedupe by `(origin, id)`, `connectAndJoin` and `loginAndJoin` (the origin dedupe runs at render in `OuterSpaceSection`)
- `packages/web/src/utils/directory.ts` - `innerOrigins`, `dedupeAgainstConnected`, `isDirectoryEntry`
- `packages/web/src/stores/instanceStore.ts` - `connectToInstance`, the shared connect path
- `packages/web/src/components/chat/ExplorePage.tsx`, `OuterSpaceSection.tsx`, `SpaceCard.tsx` - the two sections and the card
- `packages/web/src/components/chat/InstanceDiscoveryHint.tsx` - why Explore looks the way it does on this instance, and the admin's two one-click fixes
- `packages/web/src/components/modals/ConnectAndJoinModal.tsx`, `RemotePasswordStep.tsx` - the connect-from-card dialog and the password step it shares with the Connections panel
- `packages/web/src/components/modals/instanceSettingsPanels/GeneralPanel.tsx` - the admin space-discovery ladder and the directory status line
- `packages/web/src/components/modals/SpaceSettings.tsx` - the per-space switch in `DiscoveryPanel`
- Design spec: `docs/superpowers/specs/2026-09-21-space-directory-design.md`

---

## 1. Why this exists

Backspace federates, but nobody can find anything. The Explore page lists
discoverable spaces on the home instance and on the instances the user has
already connected to, and there is no way to learn that any other instance
exists short of being handed a link. For a newcomer without an invite the
whole client-federation story is a locked door.

What the directory is for:

- Communities become findable from any instance, including a fresh one with
  no peers and no connections.
- Opt-in at both levels. The admin allows listing on the instance, the space
  owner asks for the space. Either one alone lists nothing.
- The instance stays the source of truth. The hub is an index of what
  instances serve on `GET /api/directory/spaces`, never a registry that holds
  anything only it knows.
- Delisting takes effect at once, not on the next daily cycle.
- Local spaces are never ranked against, or pushed down by, the outside
  world: Inner Space stays on top, Outer Space sits below it.
- Free to run, and replaceable: the hub is one environment variable and its
  code is in this repository.

What it is not: it does not list instances (an instance is not a community),
it does not change telemetry (section 14), and it moderates nothing beyond a
blocklist the hub operator applies by hand (section 8).

Two names on one axis, so the scope is understood before the first click:
**Inner Space** is spaces on the home instance and connected instances, the
Explore list as it was; **Outer Space** is the directory, spaces on instances
the user is not connected to.

---

## 2. The model

```
space owner flips "List in the Backspace directory"  (or admin ladder rung, delete, visibility)
        |
        v  markDirectoryDirty(): bumps the document version, drops the endpoint cache, change ping 3 s later
instance server pinger  --POST { origin }-->  explore.backspacechat.com  (Worker + D1)
        ^                                              |
        |                                              v  GET {origin}/api/directory/spaces (verify by fetch)
        +----------------------------------------------+  replace that origin's rows on 200, keep them on failure

any instance server  --GET /v1/spaces?q=&limit=&offset=-->  hub   (proxied to the client as GET /api/directory, 60 s cache)
        |
        v
Explore page: Inner Space (local stores)  +  Outer Space (directory feed minus every origin the session is connected to)
```

Three facts make the rest of the design fall out:

1. **The ping proves nothing, the fetch proves everything.** Anyone can post
   `{ origin: "https://chat.example.org" }`. The hub then fetches what that
   origin publicly serves and stores exactly that. A stranger can at most make
   an instance that already wants to be listed get listed a little sooner.
2. **A failed fetch never deletes.** Otherwise a stranger could delist an
   instance by pinging while it is down. An origin's rows are replaced only on
   a successful fetch. An empty list is a success and clears them. Rows whose
   origin has not fetched successfully in three days leave the feed.
3. **The hub never merges.** Every successful fetch replaces the origin's
   whole set, so a delist is not a message type; it is the absence of the
   space in the next fetch, and the pinger sends that ping immediately.

And one rule that keeps fact 3 honest end to end: **the served document is
never older than the last change.** The endpoint cache is keyed on the
document version that `markDirectoryDirty()` bumps, and the pinger clears the
dirty flag only if nothing changed while its ping was in flight (section 5).

---

## 3. Opt-in state

### The two axes

The directory has two directions, and neither gates the other.

| Axis | Question | Admin setting | Above it |
|---|---|---|---|
| Outgoing | How far do spaces on this instance travel? | the discovery ladder, `discovery_enabled` + `directory_enabled` | `DIRECTORY_ENDPOINT` (no endpoint, no pinger) |
| Incoming | Do the people on this instance see spaces from other instances? | `directory_browse_enabled` | `DIRECTORY_ENDPOINT` (no endpoint, nothing to browse) |

An admin can list this instance's spaces globally while its own people browse
nothing, and can browse everything while listing nothing. The reasons to turn
browsing off are concrete: an Outer Space card loads its icon and banner as
absolute URLs on the instance that owns the space, so opening Explore makes
every user's browser contact hosts chosen by strangers; space names,
descriptions and images authored by people the admin has no relationship with
render inside their client with no moderation path; and some deployments
forbid the outbound dependency on a third-party hub outright.

`DIRECTORY_ENDPOINT` sits above both. It is the operator-level switch, and an
empty value stops the pinger and browsing together; `directory_browse_enabled`
cannot switch browsing on without an endpoint to reach.

### The columns

Five columns on `instance_settings` and one on `spaces` (see
[database.md](database.md)), added by migrations `0015_real_tomas` and
`0016_whole_loki`.

| Column | Meaning |
|---|---|
| `instance_settings.directory_enabled` | `0` or `1`: the admin allows spaces on this instance to be listed |
| `instance_settings.directory_browse_enabled` | `0` or `1`, default `1`: the admin allows people here to see spaces from other instances in Explore |
| `instance_settings.directory_dirty` | `0` or `1`: a ping is owed. Set by every change to the served document except member counts, cleared by a successful ping that was sent after the change. Survives restarts and survives the toggle being off |
| `instance_settings.directory_last_ping_at` | ms timestamp of the last ping the hub accepted, null before the first |
| `instance_settings.directory_last_error` | JSON `DirectoryPingError` of the last failed ping, null after a success |
| `spaces.directory_listed` | `0` or `1`: the owner asked for this space to be listed |

```ts
// packages/shared/src/types.ts
export interface DirectoryPingError {
  at: number;
  status: number | 'network' | 'timeout' | 'origin' | 'fetch';
  reason?: 'unreachable' | 'status' | 'invalid' | 'origin-mismatch';
}
```

`reason` is present when `status` is `'fetch'`: the hub's reason it could not
read this instance.

`readDirectoryState` parses the error column defensively: a value that is not
an object with a numeric `at` and a known `status` reads as null rather than
throwing.

In memory, `directory/state.ts` holds a `documentVersion` counter, bumped by
every `markDirectoryDirty()`. It is not persisted on purpose: a restart always
sends a boot ping when the flag is set, so a counter that started over at zero
cannot clear a stale flag. `markDirectoryDirty()` is the one call every change
goes through: it sets the flag, bumps the version (which invalidates the
document cache in `routes/directory.ts`, keyed on it), then notifies the
pinger's change ping scheduler.

A space is served (section 4) when all four hold: `directory_enabled = 1`,
`discovery_enabled = 1`, `spaces.directory_listed = 1`, and `visibility` is
`public` or `request`.

**What `directory_browse_enabled` gates, and what it does not.** Exactly two
reads, both through `readDirectoryBrowseEnabled` in `directory/state.ts`, the
one place the column is read:

- `GET /api/directory`, the feed proxy, answers `404 directory_disabled` while
  it is `0`, before any upstream fetch or cache read, which is the same answer
  an empty `DIRECTORY_ENDPOINT` already gives. The client already renders that
  as "no Outer Space", so the hiding needed no client work.
- `directoryConfigured` on the public `GET /api/instance/info` is
  `config.directory.endpoint !== ''` on its own, untouched by this flag: it is
  the fact every directory promise rests on, and a client that cannot see it
  offers listing and browsing on instances where neither can happen.
- `directoryAvailable` on the same endpoint is
  `config.directory.endpoint !== ''` **and** the flag. The endpoint is checked
  first, so no setting can advertise a directory the instance cannot reach.

It gates nothing else. It is not in the served document, it never reaches the
hub, the pinger does not read it, and `directoryDocumentChanged` in
`routes/settings.ts` deliberately does not list it: a change to what this
instance shows its own people owes the hub nothing, and marking the document
dirty for it would cost every instance in the fleet a pointless ping. It is
also absent from `InstanceStreamingLimits`, because no non-admin surface reads
it; the Explore page learns the answer from `directoryAvailable`.

**Discovery off implies directory off.** `applyDiscoveryAndDirectory` in
`routes/settings.ts` is the one place the invariant lives, and both PATCH
routes run it against the resulting state (the request's `discoveryEnabled`
if present, else the stored one). `PATCH /api/settings/instance` rejects
`directoryEnabled: true` while discovery is off with `400
directory_requires_discovery`; `directoryEnabled` must be a strict boolean on
the wire (`400 field_not_boolean` for anything else); and a write that leaves
discovery off clears `directory_enabled` in the same write, on
`PATCH /api/settings/instance` and on `PATCH /api/settings/streaming`, which
carries `discoveryEnabled` but not `directoryEnabled`. A PATCH that repeats a
stored value marks nothing dirty.

Transitions that call `markDirectoryDirty()`, each inside an existing handler:

- `PATCH /api/settings/instance` changing `directoryEnabled`,
  `discoveryEnabled`, `instanceName` or `federatedRegistrationOpen`;
  `PATCH /api/settings/streaming` changing `discoveryEnabled` (or clearing
  `directoryEnabled` through the invariant)
- `PATCH /api/spaces/:id` changing `directoryListed` in either direction, or
  changing `name`, `description`, `icon`, `banner`, `avatarColor` or
  `visibility` while the space is listed after the write
- `DELETE /api/spaces/:id` for a listed space

Member counts change constantly and are refreshed by the daily ping only.

Who may flip `directoryListed`: whoever may run `PATCH /api/spaces/:id`, the
owner or a member with `MANAGE_SPACE`, the same rule as `visibility`. The
route rejects `directoryListed: true` when the resulting visibility is
`private` with `400 directory_private_space`, and a listed space whose
visibility becomes `private` has `directory_listed` cleared in the same write,
so the flag never silently means nothing. `Space` carries `directoryListed`
everywhere a space is serialised: the spaces routes, the explore routes, and
the WebSocket ready payload.

On the wire: `GET /api/settings/instance` carries `directoryEnabled`,
`directoryBrowseEnabled`, `directoryLastPingAt` and `directoryLastError` (the
last two are read-only; the PATCH ignores them in the body).
`PATCH /api/settings/instance` accepts `directoryBrowseEnabled` as a strict
boolean (`400 field_not_boolean` otherwise) and writes it on its own: it is
not part of the discovery invariant and nothing clears it. `GET /api/settings/streaming`
(`InstanceStreamingLimits`, readable by any signed-in user) carries
`directoryEnabled` too, so the space settings panel of a non-admin can tell
whether the instance allows listing. The public `GET /api/instance/info`
carries `directoryEnabled` as well, next to `directoryAvailable` (whether
`DIRECTORY_ENDPOINT` is non-empty); the Explore page reads the latter there
(section 9).

---

## 4. The document

`GET /api/directory/spaces`, unauthenticated, in `routes/directory.ts`. The
hub is a stranger and reads it like anyone else.

```json
{
  "schema": 1,
  "origin": "https://chat.example.org",
  "instance": { "name": "Example Chat", "federatedRegistrationOpen": true, "version": "1.4.0" },
  "spaces": [
    {
      "id": "…",
      "name": "…",
      "description": "…",
      "icon": "https://chat.example.org/api/uploads/…",
      "banner": null,
      "avatarColor": "mint",
      "visibility": "public",
      "memberCount": 42,
      "createdAt": 1750000000000
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `schema` | fixed at `1` |
| `origin` | `resolveLocalOrigin()`: `PUBLIC_ORIGIN` if set, else `https://DOMAIN`, else `http://localhost:<port>`. The hub compares it with the origin it fetched and rejects a mismatch, which is how a misconfigured `DOMAIN` reaches the admin status line |
| `instance.name` | `instance_settings.instance_name`, `Backspace` when null |
| `instance.federatedRegistrationOpen` | whether this instance accepts new federated accounts; the feed shows a "Closed to new accounts" badge when false |
| `instance.version` | `config.version` |
| `spaces[].id` | the instance-local space id |
| `spaces[].name` | cut to 100 characters |
| `spaces[].description` | cut to 200 characters, or null |
| `spaces[].icon`, `spaces[].banner` | an absolute URL on this origin, or null (the one asset rule, below) |
| `spaces[].avatarColor` | one of `AVATAR_COLORS`, or null |
| `spaces[].visibility` | `public` or `request` |
| `spaces[].memberCount` | rows in `space_members` for the space |
| `spaces[].createdAt` | epoch ms |

The envelope is always present. `spaces` is empty when `directory_enabled` or
`discovery_enabled` is off, and the endpoint never 404s, so a hub fetch of a
switched-off instance is a success that clears its rows.

The query is the Explore query (`routes/explore.ts`) with the two extra
predicates (`directory_listed = 1`, visibility public or request), so a member
count means the same thing in both places. At most 200 spaces, ordered by
member count then creation time, the same order as Explore.

**The one asset rule.** Every `icon` and `banner` in the document is either an
absolute URL on this origin or null, because the hub rejects anything else and
a single foreign value must never delist the whole document. `absoluteAssetUrl`
maps a stored value as follows: null stays null; an absolute `http(s)` URL
whose origin is this origin is kept; any other absolute URL becomes null; a
rooted path becomes `origin + path`; a bare filename is an upload and becomes
`origin + '/api/uploads/' + name`. The origin comparison goes through
`new URL(...).origin` on both sides, so a stored URL whose host differs from
`origin` only in case (a mixed-case `DOMAIN`) is kept, and an absolute value
that does not parse is dropped like a foreign one.

**Cache.** The built document is served for 30 seconds or until
`markDirectoryDirty()` bumps the version, whichever is first. The response
carries `Cache-Control: no-cache`, so no intermediary (a CDN, a corporate
proxy, a browser cache) can hold a pre-delist copy and answer the hub with
it; every request revalidates against the instance, and the in-memory cache
answers those revalidations. The hub's own fetch sends `cache: 'no-store'`
for the same reason. The in-memory cache is the guard against polling: the
hub's fetches arrive from many Cloudflare addresses, and the app's global
limiter is keyed on the client address (never on the account, see
[api.md](api.md) "Rate limiting"), so it is no help against a distributed
reader. The cache never serves a document older than the last change, which is
what makes an immediate delist ping fetch the delist rather than the previous
document.

---

## 5. The pinger

`directory/pinger.ts`, started and stopped from `packages/server/src/index.ts`
next to the telemetry reporter. Unlike the reporter it does not sit under
`DISABLE_FEDERATION_WORKERS`: the two-instance federation harness disables
the workers and still needs the pinger, pointed at a local stub. Its own
guard is an empty `DIRECTORY_ENDPOINT` (section 11), which logs one line and
starts nothing. The harness sets that empty value on every child explicitly
(a developer's own `DIRECTORY_ENDPOINT` would otherwise reach every spawned
instance through the inherited environment); `test/directory-e2e.test.ts`
passes `directoryEndpoint` to point both instances at its stub hub and proves
listing, delisting, the toggle and the fetch-failure status line end to end.

**When it pings**, in the order `pingerTick` checks:

- **Boot.** Once at start, if `directory_enabled = 1` or `directory_dirty = 1`.
  This is what puts a freshly upgraded instance back in the feed after a long
  outage without waiting for its slot.
- **Retry loop.** Once a minute while `directory_dirty = 1`, regardless of the
  toggle, unless the retry loop is halted (a `400`, below) or a backoff or
  `Retry-After` is still running. Running while the toggle is off is what
  makes "switch off while the hub happens to be unreachable" resolve on its
  own instead of leaving the instance in the feed for three days.
- **Daily.** While `directory_enabled = 1`, at a slot minute derived from the
  instance's federation `instanceId` the way the telemetry reporter derives
  its own (`slotMinute`: `sha256(id)` read as a 32-bit integer modulo 1440).
  Due when the UTC minute of day has reached the slot, `directory_last_ping_at`
  is earlier than today's slot instant, no failure has been recorded today,
  and no backoff or `Retry-After` is running. An event ping earlier in the day
  does not satisfy the slot: the daily ping is the member-count refresh and
  always runs.
- **Change ping.** On every `markDirectoryDirty()`, one timer
  (`createChangePingScheduler`) is re-armed for `changePingDelay`: 3 seconds
  after the last mark, or the rest of a running `Retry-After` when that is
  longer, so a burst of edits sends one ping and nothing is sent into a
  cooldown the hub already announced. The failure backoff is not waited for:
  an edit is new information and goes out 3 seconds after the last mark even
  while the tick is backing off. When it fires it sends only if the flag is
  still dirty (a ping in flight may have covered the change), the retry loop
  is not halted on the current version, and the hub has not retired the
  service. It re-checks the cooldown at fire time and re-arms when one
  started after the mark, and it never joins a ping already in flight: it
  re-arms once that ping settles, so a change that landed during the flight
  gets its own send under the version guard. That in-flight guard is what
  keeps the change ping and the tick from being two senders for one retry.
  A `429` re-arms the timer for the cooldown's end, so a second edit inside
  the hub's 10 second per-origin cooldown lands seconds later rather than at
  the next minute tick. Any other failure leaves that retry to the minute
  tick and its backoff; only a new mark sends sooner.

**The per-day guard is derived from the persisted error, not from memory.**
"No failure recorded today" reads `directory_last_error.at` and compares its
UTC day with today, so a restart loop cannot re-attempt a failing hub more
than once a day by the slot. What the pinger keeps only in memory (the
failure count, the backoff's end, the cooldown's end, the halted version, the
retired flag, the ping in flight) is lost on restart on purpose: the boot ping resends
whatever is dirty, and a retired hub is tried once more per boot. The ping in
flight is the single-flight guard: the minute tick skips while one is
running, so the tick and the change ping never send the same retry twice and
the backoff ladder steps once per failure.

**What it sends.** `POST {DIRECTORY_ENDPOINT}/v1/ping`, body
`{ "schema": 1, "origin": "https://chat.example.org" }`, `Content-Type:
application/json`, `User-Agent: backspace-server/<version>`, a 10 second
`AbortSignal.timeout`, `redirect: 'error'`. Nothing else is ever in the body,
and the hub's answer body is never logged.

Every ping records the `documentVersion` it was sent under. When the answer
arrives, the dirty flag is cleared only if the version is still the same; a
change that landed while the ping was in flight keeps the flag and the
change ping sends the next one. This is the reporter's "state changed while a
ping was in flight" check applied to a counter instead of the toggle.

| Answer | What the instance does |
|---|---|
| 2xx | clear `directory_dirty` if the version is unchanged, set `directory_last_ping_at`, clear `directory_last_error`, reset the backoff |
| `429` | wait `Retry-After` (seconds or an HTTP date), or 10 seconds when the header is absent (the per-address limiter sends none); nothing is persisted, dirty stays set. The daily slot waits it out too |
| `400` | `directory_last_error = { at, status: 'origin' }` and the retry loop halts until the next `markDirectoryDirty()`: the origin itself is unacceptable (a port, an IP, `http`, `localhost`) and retrying will not help. The daily slot may still try once per day while the toggle is on, which is harmless and self-heals if the hub's validator changes |
| `410` | the hub is retired: clear `directory_dirty`, record `{ at, status: 410 }`, and stop pinging until the next start |
| `502` with `{ reason }` | the hub could not read this instance's document: `directory_last_error = { at, status: 'fetch', reason }`, keep dirty, retry with backoff |
| `502` without a recognised reason, any other status | `directory_last_error = { at, status }`, keep dirty, retry with backoff |
| a thrown request | `status: 'timeout'` when the abort fired, `'network'` otherwise; keep dirty, retry with backoff |

The backoff is 1, 5, 15 and 60 minutes after the first, second, third and
fourth consecutive failure, then hourly, reset by any accepted ping.

---

## 6. The feed proxy

`GET /api/directory?q=&limit=&offset=` on the instance, authenticated, in
`routes/directory.ts`. The browser never talks to the hub; it reads the feed
through its own instance, which validates the query, forwards it to
`{DIRECTORY_ENDPOINT}/v1/spaces` with `Accept: application/json` and the same
`User-Agent`, 10 second timeout and `redirect: 'error'` as the pinger (which
sends `Content-Type` rather than `Accept`, since it posts a body and ignores
the reply's), and:

- clamps rather than rejects: `q` trimmed and cut to 100 characters, `limit`
  1 to 100 (default 50), `offset` 0 to 1000, the same bounds the hub applies,
  so the two agree on what a request means;
- caches each distinct `(limit, offset, q)` for 60 seconds in a map of at most
  64 entries that drops its oldest entry when full, so a delist reaches clients
  within about a minute and the cache cannot grow without bound. The 60
  seconds count from when the hub's edge copy was made, not from when it
  arrived: the hub serves the feed from its edge cache for 60 s of its own
  and says how old the copy is in `Age` (seconds; absent on a miss), and the
  proxy stores the entry at `Date.now() - age * 1000` (absent or
  non-numeric counts as 0, a value above 60 s is clamped to 60 s, so the
  entry then expires on the next request). Without this the two caches
  stacked: a proxy that fetched at second 59 of the edge copy served it
  until second 119. The upstream `cache-control` is not consulted, because
  the zone's browser-cache setting rewrites it to `max-age=14400` on a hit,
  the CDN's browser-facing header rather than the edge TTL. Freshness is
  therefore bounded at 60 s end to end;
- coalesces identical in-flight requests into one upstream fetch;
- caches nothing on failure, so the next request tries again;
- accepts only a body that is `{ schema: 1, spaces: [...] }` of objects, and
  treats anything else, a non-200, or no answer as unreachable;
- has its own `@fastify/rate-limit` config of 30 requests per minute under
  the global 200, since distinct `q` and `offset` values miss the cache and
  the global limit would let one user drive a few hundred thousand hub reads
  a day through their instance. It inherits the global limiter's key, which
  is the client address and nothing else: the limiter is registered as a
  plugin whose hook runs before authentication, so `request.userId` is unset
  when the key is taken. That is structural, not a default that might change.
  The consequence is an operator's to know: **the 30 per minute is per
  address, so everyone behind one NAT, VPN exit or corporate proxy shares it**,
  and a single busy browser there can spend the minute's Outer Space searches
  for everybody at that address. Same key, same reasoning and the same
  countermeasures as the global limit ([api.md](api.md) "Rate limiting").

`404 directory_disabled` when `DIRECTORY_ENDPOINT` is empty; `502
directory_unreachable` when the hub does not answer or answers badly, which
the Outer Space section renders as its unreachable state.

---

## 7. The hub

`scripts/directory-hub/`, a Cloudflare Worker with a D1 database, served at
`explore.backspacechat.com` as a custom domain. It is a workspace package
copied from the telemetry receiver, with the same harness, the same
no-runtime-dependencies test, and a deploy workflow of the same shape. It is
not copied into the Docker image. It is a separate Worker with a separate
database because the telemetry receiver documents that it never stores a
domain and never fetches, and both are the point here.

`wrangler.toml` pins `compatibility_date` to the newest date the workerd
bundled with the installed `@cloudflare/vitest-pool-workers` supports, as the
receiver does. It declares the D1 binding `DB` (database
`backspace-directory`), a per-address rate-limit binding `RATE_LIMITER` of
2 requests per 10 seconds, the plain var `RETIRED = "0"`, and a daily cron
(`23 3 * * *`). An optional `HUB_HOST` var names the hub's own hostname; unset,
the ping handler takes the host of the request it is answering.

The outbound fetch is a parameter of `createWorker(outbound)`. Production
wraps the global `fetch`; the tests pass a spy and assert on the request the
hub would have sent, which is how "never fetch anything but
`{origin}/api/directory/spaces`" is pinned without a network.

### Tables

`migrations/0001_directory.sql`:

```sql
CREATE TABLE origins (
  origin TEXT PRIMARY KEY,                  -- canonical: new URL(x).origin, lowercase host
  instance_name TEXT NOT NULL,
  federated_registration_open INTEGER NOT NULL,
  version TEXT,
  document_hash TEXT NOT NULL,              -- SHA-256 of the validated, canonicalised document
  first_seen_at INTEGER NOT NULL,
  last_ok_at INTEGER NOT NULL
);
CREATE TABLE fetch_attempts (
  origin TEXT PRIMARY KEY,                  -- every origin ever pinged, valid or not
  last_fetch_at INTEGER NOT NULL
);
CREATE TABLE spaces (
  origin TEXT NOT NULL REFERENCES origins(origin) ON DELETE CASCADE,
  id TEXT NOT NULL,
  row_hash TEXT NOT NULL,                   -- SHA-256 of this space's fields
  name TEXT NOT NULL, description TEXT, icon TEXT, banner TEXT, avatar_color TEXT,
  visibility TEXT NOT NULL, member_count INTEGER NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (origin, id)
);
CREATE TABLE blocks (
  origin TEXT NOT NULL,
  space_id TEXT NOT NULL DEFAULT '*',       -- '*' blocks the whole origin; NULL would not be unique in SQLite
  reason TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (origin, space_id)
);
CREATE INDEX spaces_members ON spaces(member_count DESC, created_at DESC);
```

### Routes

| Route | Behaviour |
|---|---|
| `POST /v1/ping` | the eight steps below. `204` when the document was read and stored, `400` for a bad body or origin, `429` from the per-address limiter (no body) or the per-origin cooldown (`Retry-After: 10`), `502 { reason }` when the origin's document could not be had or did not validate, `410` for every ping while `RETIRED` is `"1"`, checked before anything else |
| `GET /v1/spaces?q=&limit=&offset=` | public, no auth. The per-address limiter, then `caches.default` with a 60 second TTL (a `Cache-Control` header alone does not put a Worker response in Cloudflare's cache), then the query in section "The feed" below. `200 { schema: 1, spaces: [...] }` with `Cache-Control: public, max-age=60` |
| anything else | `404` |

The source address is read in one function, `limitByAddress`, as the
limiter key; it is never stored and never leaves that function.

### `POST /v1/ping`, in order

1. `410` while `RETIRED = "1"`.
2. The per-address limiter, 2 requests per 10 seconds: a pinger sends a
   handful of requests a day and honours `429`, and this is the bound on how
   many outbound fetches one address can cause.
3. The body, at most 1024 bytes (a larger `Content-Length` is refused
   unread; otherwise the body is read and measured), must be `{ schema: 1,
   origin: string }`. `parseOrigin` canonicalises through `new URL(x).origin`,
   which lowercases the host, and accepts the value only when it was already
   nothing but an origin: scheme `https`, no userinfo, no port, a pathname of
   exactly `/` (so a trailing slash is accepted and canonicalised away), no
   query, no fragment, a hostname with at least one dot that is not an IPv4
   literal, not a bracketed IPv6 literal, and not the hub's own host.
   Otherwise `400`.
4. Per-origin cooldown against `fetch_attempts.last_fetch_at`, which exists
   for every origin ever pinged whether or not it ever validated: under 10
   seconds old, `429` with `Retry-After: 10`. Then `last_fetch_at` is upserted
   before the fetch, so a failed fetch still counts. Ten seconds is short
   enough that a second edit after the 3 second debounce still lands
   promptly. The check and the write are two round trips; two pings for one
   origin inside the same instant can both fetch, and the worst case is a
   redundant write.
5. Fetch `{origin}/api/directory/spaces` with a 10 second timeout,
   `redirect: 'manual'` (a 3xx is handed back as the response and fails the
   status check, so the hub never follows a listing instance anywhere else),
   `Accept: application/json`. The body is read chunk by chunk under a 512 KB
   cap and the stream is cancelled the moment the total passes it.
6. Validate (`parseDocument`): `schema` 1; the document's `origin`
   canonicalised through `new URL(origin).origin` equal to the origin fetched
   (`502 { reason: 'origin-mismatch' }` otherwise, so an instance whose
   `DOMAIN` has upper-case letters still validates); `instance.name` a string
   of at most 100 characters; `instance.federatedRegistrationOpen` a boolean;
   `instance.version` absent, null, or at most 32 characters of
   `[0-9A-Za-z.+-]`, the telemetry receiver's pattern; at most 200 spaces,
   each with a non-empty `id`, a `name` of 1 to 100 characters, a
   `description` null or at most 200 characters, `visibility` `public` or
   `request`, `memberCount` a non-negative integer no larger than 10^9,
   `createdAt` a non-negative safe integer; `icon` and `banner` null or a URL
   whose parsed origin equals the fetched origin with a path below `/`, so a
   listing cannot point viewers' browsers at a third party (a look-alike host
   such as `chat.example.org.evil.example` fails because its origin differs).
   An unknown `avatarColor` becomes null rather than failing the document,
   since it is cosmetic. A document that repeats a space id is rejected: one
   origin, one id, one row, and which occurrence would win is not a question
   the hub should answer. Every other failure is `502 { reason: 'invalid' }`.
   The valid document is copied field by field into a fresh object, so unknown
   fields never reach storage.
7. Compute `document_hash` (SHA-256 of a canonical serialisation: instance
   fields in fixed order, then the spaces sorted by id with fixed key order).
   If it equals the stored one, update `last_ok_at` only, one row. Otherwise
   read the stored `(id, row_hash)` pairs and write one `db.batch([...])`:
   the `origins` upsert first (so the foreign key has its parent), a `DELETE`
   for every stored id the document no longer has, and an upsert for every
   space whose id is new or whose `row_hash` differs. Rows with an unchanged
   hash are not written. One prepared statement per row, since D1 has no
   interactive transactions and binds at most 100 parameters per statement.
   `204`.
8. On a failed fetch: `502 { reason: 'unreachable' }` when the connection
   failed, timed out, or the body did not arrive; `502 { reason: 'status' }`
   for any status other than 200, redirects included. The rows are untouched.
   The reason exists so the pinger keeps its dirty flag and the admin panel
   can say why the hub could not read this instance, which is usually a
   `DOMAIN` or reverse-proxy problem on the instance's side.

Writes are therefore proportional to what changed: a daily heartbeat with the
same member counts costs one row, a normal day costs a few rows per instance,
and a stranger re-pinging an instance whose document does not change costs
nothing beyond `fetch_attempts`.

### The feed

Rows from origins with `last_ok_at` within 3 days, not blocked at origin
(`space_id = '*'`) or space level, ordered by `member_count DESC, created_at
DESC`. A non-empty `q` matches name or description with `LIKE`, with `%`, `_`
and `\` escaped and an `ESCAPE '\'` clause; SQLite folds case for ASCII
letters only, so a query in another script matches its exact case. `limit`
1 to 100 (default 50), `offset` at most 1000, both clamped. There is no
`total`: the "Show more" control only needs to know whether a page came back
full.

Each entry is `{ origin, instanceName, federatedRegistrationOpen, id, name,
description, icon, banner, avatarColor, visibility, memberCount, createdAt }`,
the `DirectoryEntry` shape in `packages/shared`.

### Housekeeping

The daily cron deletes `origins` rows whose `last_ok_at`, and
`fetch_attempts` rows whose `last_fetch_at`, are older than 30 days, measured
from the trigger's own scheduled time so a run the platform started late
deletes exactly what it was scheduled to delete. The `spaces` rows of a
dropped origin go with it through the cascade, and the count the run logs
("rows removed") includes them. The 3 day feed cutoff is the one users see;
30 days is housekeeping.

### Free plan, stated plainly

Workers Free is 100,000 requests per day per account, cron invocations
included, and that budget is shared with the telemetry receiver; a second
Worker separates data, not quota. D1 Free is 5 million rows read and 100,000
rows written per day. The design fits with room: pings are a handful per
instance per day, writes are diff-sized, reads are cached for a minute at the
edge and for a minute again on every instance. The one thing the Worker
cannot do for itself is refuse a flood before being invoked, so a Cloudflare
WAF rate-limiting rule (available on the free plan) goes in front of both
hostnames at rollout (section 12); a WAF block is not a Worker request and
does not spend the quota.

---

## 8. Blocklist

A public directory makes the hub operator the moderator of what is on it.
The blocklist is the tool: by origin or by space, applied on the next feed
read (within a minute at the edge plus a minute on each instance), no UI in
this release. It is managed with `wrangler d1 execute` from
`scripts/directory-hub`, with `--remote`, since without it wrangler runs the
statement against a local development copy. `created_at` is epoch
milliseconds; `$(date +%s000)` fills it in from the shell.

To block everything an origin serves:

```
wrangler d1 execute backspace-directory --remote --command "INSERT INTO blocks (origin, space_id, reason, created_at) VALUES ('https://bad.example', '*', 'reason', $(date +%s000))"
```

To block one space on an origin, with that space's id in place of `'*'`:

```
wrangler d1 execute backspace-directory --remote --command "INSERT INTO blocks (origin, space_id, reason, created_at) VALUES ('https://bad.example', '123456789012345678', 'reason', $(date +%s000))"
```

The origin is the canonical form the hub stores: `https`, lowercase host, no
trailing slash. Removing a block is a `DELETE FROM blocks WHERE origin = ...`
through the same command. A block hides rows from the feed; it does not stop
the origin's pings or fetches, so an origin that stops being a problem is
back the moment the block row is gone.

A report path (a contact address on a public page) is part of the deferred
public page (section 14), not this release. Moderation is a real recurring
cost and the reason the hub is one environment variable away from being
someone else's.

---

## 9. Explore page and the connect-then-join flow

One page, one search box, two sections in fixed order, strictly disjoint.

- **Inner Space**: `exploreStore.fetchSpaces()`, unchanged in content and
  ranking (the unjoined grid, then the collapsible joined group below it).
  Header "Inner Space", subtitle "Spaces on your instances". Stays on top
  whatever is below it, and its empty state does not hide Outer Space.
- **Outer Space**: `directoryStore.fetch(query)` reading `GET /api/directory`
  from the home instance, 50 entries per page with a "Show more" control that
  appends the next page, never the whole feed. Header "Outer Space", subtitle
  "Communities across Backspace".

**Show more, and what its absence means.** The button renders while the store's
`status` is `ok` and `hasMore` is true. The first page sets `hasMore` from the
page being full; a continuation ends the feed on **either** a short page **or**
a page that appended nothing new, and the second half is not redundant: the
proxy clamps `offset` at 1000, so every page past the cap is the page at the
cap again, a full page of entries the list already holds. Counting length alone
kept `hasMore` true there and handed back the same fifty spaces for as long as
the button was clicked.

A continuation that fails is not the end of the feed and does not say anything
about the entries already on screen, so it leaves `status` at `ok` and records
itself in `loadMoreError` instead. The button therefore stays, which is the
only way to ask for that page again, and the failure is shown as a notice above
it: the unreachable sentence for `unreachable`, the generic one for `error` and
for a `disabled` that arrives mid-session (an instance whose admin switched
browsing off under the user). The button's absence means the end of the feed
and nothing else.

**The section is gated on the home instance's `directoryAvailable`, not on the
listing toggle.** `ExplorePage` reads the public `GET /api/instance/info` once
on mount and renders `OuterSpaceSection` only when `directoryAvailable` is
true, which the server sets from `config.directory.endpoint !== ''` and the
admin's `directoryBrowseEnabled` (section 3); with it false, or the request
failing, or an older server that does not send the field, the section is
absent and the search box never hits the proxy. The admin's listing opt-in
(`directoryEnabled`, section 3) is a separate switch that the page does not
read: an instance whose admin lists nothing still shows Outer Space, which is
the cold-start case the directory exists for (a fresh instance with no peers
must be able to browse). Browsing and listing are the two independent axes of
section 3. The proxy's own `404 directory_disabled` (an empty
`DIRECTORY_ENDPOINT`, or browsing switched off) is handled a second way: the
store's `disabled` status renders nothing, which is what a client on an older
build, or one whose mount predated the change, falls back to. The flag is read
once per mount, so an endpoint changed under a running instance is reflected
on the next visit, after the restart the change needs anyway.

**Deduped by origin, not by space.** Every entry whose canonical origin
(`new URL(x).origin`) is the session's own (`window.location.origin`) or is
an inner origin is dropped. `innerOrigins` (`utils/directory.ts`) names
them: a federation registry entry (`instanceStore.registry`) whose status is
`connected`, `auth_expired` or `unreachable`, and a live instance
(`instanceStore.instances`) whose status is `connected` or `connecting`.
Inner Space itself is a snapshot, so `ExplorePage` refetches it whenever the
set of `connected` origins changes; without that, an instance disconnected
while the page is open would leave its stale Inner cards beside the Outer
cards the rule now allows, one space twice with contradictory actions. A
registry entry in `disconnected` is not inner: the user chose to disconnect
in the Connections panel, and for Explore that instance is an outer instance
again, its spaces ordinary cards with "Connect and join". A live instance in
`error` or `disconnected` with no registry standing of its own is not inner
either. The two fault states stay inner because a connection chip (below)
explains the absence; a disconnected one would otherwise need a chip per
instance, forever, for a user who deliberately disconnected from many. This
refines the design spec's "any status" wording, which was written before
the chips existed. Inner Space is paginated and filtered, so matching on
space ids would let a connected instance's off-page space reappear in Outer
Space as "needs a connection", and the home instance tags its spaces with
`''` rather than an origin. Origin is what the section's name means anyway:
outer is what needs a connection first. The dedupe is applied at render, in
`OuterSpaceSection`, from the registry and the live list: `directoryStore.entries`
holds the feed as the proxy returned it, and an origin the session connects,
loses, gets back or disconnects moves between the sections without a
refetch. Pages are appended without duplicates by `(origin, id)`, and a
reply for an older query is ignored once a newer one has been sent.

Connecting from a card whose origin the session knows as `disconnected`
reuses what the session still holds. The dialog first asks
`connectToInstance(origin, '')`, which resumes the cached token through
`reconnectInstance`; a resumed session is the same state as one that was
already there, so a public entry joins on the spot and a request entry gets
its message box, with no password step. Resumable means a live instance the session disconnected or whose session
errored that still holds its token, or a registry entry in `disconnected`
whose token comes back from `localStorage`; `resumableOrigin` in
`instanceStore` is the single predicate, which the dialog calls rather than
repeating. A registry entry in `auth_expired` is not resumable, its token
having just been refused, while a live instance in `error` is, since the
registry may not have judged it yet. When there is nothing to resume or
the remote refuses the token (`needs-password`), the dialog runs the
ordinary probe and password step, the store takes its
`reauthenticateInstance` branch, the remote answers the registration with
`username_taken` and the client logs in with the home-issued secret, and the
new session replaces the placeholder by origin. Either way the same
federated identity is reused; no second account is created. An instance that
turns out unreachable is reported as `peer_unreachable` rather than as a
password prompt the user cannot fix.

**Connections that need attention.** A connection whose session expired or
whose instance is unreachable is in neither section: Inner Space fans out
over `connected` instances only, and the dedupe above keeps its origin out
of Outer Space. `ConnectionChips`, rendered directly under the Inner Space
subtitle, is the hint that explains it: one `glass-pill` chip per federation
registry entry (the same record the Connections panel shows, so the two
never disagree) whose status is `auth_expired` (rose dot, "session expired",
Reconnect) or `unreachable` (amber dot, "unreachable", Retry). Retry calls
`reconnectInstance` and shows the connecting word until the registry status
settles; Reconnect replaces the pill with a small matte panel on a line of
its own, holding `ReauthForm`, the reconnect surface shared with the
Connections row (see
[client-federation.md](client-federation.md), "The reconnect surface"). Its
first phase calls `reauthenticateInstance`; an instance that has an account
for this user with a password of its own moves it to the second phase, the
shared `FallbackForm`, and `loginToRemote` finishes there. Escape and Cancel
collapse the panel and hand focus back to the chip's action. After either
succeeds the page refetches Inner
Space (`fetchSpaces`, `fetchMyRequests`); Outer Space needs nothing, the
render-time dedupe sees the instance. With every connection healthy the row
is absent. `disconnected` gets no chip: that is the user's own choice, its
spaces are back in Outer Space, and a chip per disconnected instance would
nag.

A chip whose live instance is `connecting` is hidden for that moment, with two
exemptions. A chip whose own Retry is in flight stays and shows the connecting
word instead, until the registry status settles. **A chip the user has opened
into `ReauthForm` also stays**, whatever the live status does, which is the
exemption that is easy to read as a bug: the obvious reading of "chips show
connections that need attention" is that a connecting instance does not
qualify. It stays because dropping the entry unmounts the chip, and unmounting
`ReauthForm` discards what is in it, so a flip to `connecting` started anywhere
else would empty the field under the user's hands. Every reachable flip is
started elsewhere: `reconnectInstance` from the Connections panel's Retry and
from `connectToInstance`'s empty-password resume (the connect-and-join path),
and `autoConnectAll`, the session fan-out that runs both on sign-in and on a
session restored from a stored token.

The set of opened origins is held by the row rather than by the chip, because
the row is where the decision to render a chip at all is made. An origin leaves
it when its entry stops needing attention, which means the connection is back
or the user disconnected it: a connection that recovers and expires again
therefore opens an empty form rather than reviving the one that was on screen.

**Why Explore looks the way it does here.** `InstanceDiscoveryHint` sits in
the same slot directly under the chips. It names this instance's own
discovery settings and, for an admin, changes them from the page. **Both
flags come from one document**, `settingsStore.streamingLimits`, which any
signed-in user may read and which `updateInstanceSettings` keeps current;
`isAdmin` comes from the same store, and `directoryConfigured` is passed down
from the page, which already reads the public instance info. The row is
derived from those and nothing else:

| condition | what renders |
|---|---|
| `streamingLimits` is null (the document has not arrived) | nothing |
| discovery off, not an admin | amber notice: space discovery is off, spaces here are joinable by invite link only |
| discovery off, admin | the same fact in the admin's voice, with "Turn on space discovery" |
| discovery on, not listed, admin, `directoryConfigured` true | a quiet row: spaces here are not listed in the public directory, with "List them" |
| anything else | nothing |

**The listing row needs the endpoint and the discovery rows do not.** Space
discovery is local and reaches no hub, so its rows stand on an instance with
no `DIRECTORY_ENDPOINT`. Listing does not: "List them" writes
`directoryEnabled`, and with no endpoint the pinger never starts, so the click
wrote the flag, the row vanished as though it had worked, and the spaces were
exactly as unlisted as before. The row is the one that offers the write, so it
is the one withheld, and a `directoryConfigured` that has not arrived yet
withholds it too, on the same rule as the null document below.

Unknown is not a fact: with no document the hint says nothing rather than
guessing, because this is the one Explore surface that offers a write, and a
guessed `directoryEnabled: false` would tell an admin their listed instance
is not listed next to a button that acts on it. That is also why
`settingsStore.fetchStreamingLimits` leaves the field null when the request
fails instead of substituting `DEFAULT_LIMITS`, which asserts both flags;
the screen-share config, the one consumer that needs numbers whatever
happened, reads them through `getStreamingLimits()`, which falls back at read
time.

The two rows an admin sees are the ladder of section 3 one rung per click,
offered in the same place. "Turn on space discovery" writes
`discoveryEnabled: true` through `updateInstanceSettings`, which mirrors both
flags from the server's answer back into `streamingLimits`, and the hint
moves from the third row to the fourth in the same render: there is no "just
enabled" state, and no refetch has to land for the row to be right. Enabling
also calls back into `ExplorePage` so Inner Space refills without a reload
(`fetchSpaces`, `fetchMyRequests`), but that call fills the list, not the
hint. "List them" writes `directoryEnabled: true` and refetches nothing,
because what this instance lists does not change what it sees. Both buttons
disable while their call is in flight, and a rejected PATCH renders
`describeError` under the text and leaves the row where it was, the store
having kept the old settings; the message is held with the row it was raised
on, so it disappears rather than following the hint to the next rung.

The listing row says nothing about Outer Space. **Browsing the directory
never depends on `directoryEnabled`**, only on the operator's
`DIRECTORY_ENDPOINT` (the gate above), so `explore.outer.empty` ("Nothing out
there yet...") means the feed has nothing for this query, never that this
instance lists nothing of its own. The three visible rows are in the Explore
workbench as `?scene=hint-member|hint-admin|hint-not-listed`
(`packages/web/dev-explore.html`), which takes `?width=400` for the wrap.

**Known limit: two copies of `discoveryEnabled`.** The same flag lives in
`exploreStore.discoveryEnabled`, written by `fetchSpaces` from the home
instance's answer and read by the hint's neighbours (`JoinSpace.tsx:41`), and
in `streamingLimits.discoveryEnabled`, written by the WS ready payload and by
`updateInstanceSettings` and read by the hint and `SpaceSettings`. Within one
client the two stay in step where it matters: the Instance -> General ladder
saves through `updateInstanceSettings` too, so the hint is right on the next
render, and it is the Explore *list* that lags until the next `fetchSpaces`.
The gap is across clients. A rung moved in another tab, another session or by
another admin reaches the explore copy on the next fetch and the settings copy
only on the next WS ready, so the hint can name a rung that is no longer the
instance's. The fix is one flag, not a mirror kept in step between two stores;
a mirror would be a third thing that can disagree with both.

The search box drives both sections through one 300 ms debounce: Inner
filters as before, Outer re-queries the hub through the proxy, showing a
small spinner in its header while a list is already on screen rather than
clearing it.

Cards: the Explore page's `SpaceCard` (extracted to its own file) renders both
sections. Outer cards always show the origin chip, add a "Closed to new
accounts" badge when `federatedRegistrationOpen` is false, and their action
reads "Connect and join" (public) or "Connect and request" (request).

Outer Space's designed states: loading (a spinner, or the header spinner
when entries are already shown), the hub unreachable ("Outer Space is not
reachable right now. Inner Space still works.", the `directory_unreachable`
error text, shown under whatever entries are already on screen), a generic
error, no results for the query, and the early-days state with the lonely
mascot when the feed is empty. The mobile shell renders `ExplorePage`
directly, so the section arrives there with no further work. The home view's
channel sidebar gained an "Explore" entry that routes to `/explore`, next to
the compass in the space sidebar that was already there.

### Connect and join

Clicking an Outer card opens `ConnectAndJoinModal` with the entry. The dialog:

1. Probes the entry's host with `probeInstance` (the self and duplicate
   checks, the `federatedRegistrationOpen` banner, the origin normalisation)
   unless the session already holds a `connected` or `connecting` instance
   for that origin, in which case the probe and the password step are
   skipped: a public space is joined on open, a request space shows only the
   message field.
2. Shows `RemotePasswordStep`, the password step shared with the Connections
   panel's add-instance flow, under the intro "This space lives on
   chat.example.org. Connecting creates your identity there, linked to your
   account on home.example.org." The field label and its hint are the only
   two places the modal says "password"; the placeholder ("The one you sign
   in with") says which one without repeating the label. For a request space
   a message field sits between the password and the button.
3. Runs `directoryStore.connectAndJoin(entry, password, message?)`, which
   calls `connectToInstance(origin, password)`, the one shared connect path in
   `instanceStore`: an origin the store knows as `connected` or `connecting`
   returns at once without touching the remote; one in `error` or
   `disconnected` is re-authenticated in place; an unknown origin runs
   `connectToRemote`, so the typed password is verified against the home
   instance and the home mints the per-remote secret; the remote never sees
   what was typed (see [client-federation.md](client-federation.md)). A remote
   account that refuses the home-issued credential reports
   `needs-remote-password`, and the dialog switches to the fallback phase, an
   explicit login on that instance, then `loginAndJoin`.
4. Joins: the origin's entries leave Outer Space (they belong to Inner Space
   now), then `exploreStore.publicJoin` or `requestJoin` for the entry against
   that origin. A `409 already_member` (a federated account there that was in
   the space already) is not an error: the space arrives with the
   connection's ready payload and the dialog navigates into it like a
   successful join. A request shows a toast and closes.
5. `fetchMyRequests` is refreshed so the Inner card can show the right state.

Pending join requests are keyed by origin as well as space id. `myRequests`
elements carry `_instanceOrigin` (`''` for home), `fetchMyRequests` fans out
over the home instance and every connected instance with
`Promise.allSettled` and tags each result with its origin, and
`useSpaceJoin.isPending` compares `(origin, spaceId)`. This closed an existing
gap where a pending request on one origin showed as pending for a same-id
space on any other origin, and a request made on a remote instance never
appeared after a reload.

Entries are addressed by canonical `origin` plus the instance-local space id,
the same `spaceId:origin` key `exploreStore` uses; no global id is assumed
anywhere. A user browsing a connected remote instance sees that instance's
Explore page, which proxies through its own `DIRECTORY_ENDPOINT`; the feed is
the same hub unless that admin pointed elsewhere, and the dedupe runs against
whatever that session holds as inner.

---

## 10. Settings UI

**Admin, General panel** (`GeneralPanel.tsx`), one radio group named "Space
discovery" with the line "How far spaces on this instance can be found." It
replaces the two coupled toggles (space discovery, list in the directory) that
used to sit here. Three mutually exclusive rungs, each a superset of the one
above, each writing both stored flags:

| Rung | Label | `discoveryEnabled` | `directoryEnabled` |
|------|-------|--------------------|--------------------|
| `invite` | Invite only. Spaces here are listed nowhere. Invite links still work. | false | false |
| `local` | Local space discovery. Spaces appear in Explore for people on this instance and on instances connected to it. | true | false |
| `global` | Global space discovery. Spaces that opt in also appear in the public Backspace directory, on every instance. | true | true |

The selected rung is derived from the draft, not stored, so nothing can drift
out of step with the two booleans the save sends. The combination the server
refuses has no rung, which is why the panel no longer needs a "turn on space
discovery first" reason or a clearing special case when discovery goes off.
The server-side invariant did not change: `applyDiscoveryAndDirectory` still
runs on both PATCH routes, still answers `400 directory_requires_discovery`
for `directoryEnabled: true` with discovery off, and still clears
`directoryEnabled` in the same write when discovery is off (section 3).

Under the `global` rung, indented beneath it and nowhere else, and rendered
as a sibling of the radiogroup rather than inside it, since a radiogroup may
own only radios:

- While `federatedRegistrationOpen` is off, the amber note "New accounts from
  other instances are closed, so listed spaces will show as closed to new
  accounts." with an "Open federated accounts" button next to it. The button
  calls `updateInstanceSettings({ federatedRegistrationOpen: true })` straight
  away, outside the draft and outside the save bar, disables itself while the
  call is in flight, and reports a failure through the panel's error line. The
  flag is never flipped as a side effect of picking the rung: letting
  strangers create accounts here is a separate security decision. The note
  appears as soon as the rung is picked in the draft, before any save, since
  that is the moment the admin is deciding.
- A status line of the same shape as the telemetry panel's, fed by
  `directoryLastPingAt` and `directoryLastError` from `GET
  /api/settings/instance`: "Never reported" or "Last reported <date>", and
  under it "Last attempt failed (<reason>)" when there is an error. A `fetch`
  status shows the hub's reason, `origin`, `network` and `timeout` show their
  own sentence (the `origin` one names `DOMAIN` and `PUBLIC_ORIGIN`), and a
  plain HTTP status is shown as the number it is. The line reads the store,
  not the panel's draft, and the panel re-reads the settings every 10 seconds
  while open whatever rung is selected, so the change ping's result appears a
  few seconds after a save without reopening the panel; an unsaved edit
  survives the refresh.
- One sentence naming what becomes public for each listed space: its name,
  description, icon, banner, member count and this instance's address, and
  that people browsing the directory load the icon and banner from this
  instance.

Directly under the ladder, in the same section and separated from it by a
rule, one switch: "Show global spaces in Explore", with "People here see
spaces from other instances in Outer Space. Their browsers load those spaces'
icons and banners from the instances that own them." It is the incoming axis
of section 3, so it sits beside the ladder rather than as a fourth rung of it,
and it is a draft field saved by the panel's normal save bar like the rungs,
not an immediate write. The three-rung ladder is a `radiogroup`, which may own
only radios, so the switch is its sibling.

On an instance with no endpoint the panel renders the switch **off** and
disabled, with "This instance is not configured to reach a directory, so there
is nothing to show." beneath it. **Off is deliberate and is not a reading of
the stored column.** The effective state is off whatever the column says,
because there is nothing to browse; a switch in the on position next to a line
saying there is nothing to show would assert two things at once and only one
of them would be true. The column is not written to match: the stored `1` stays
stored, invisible and harmless, and browsing resumes at the admin's last choice
if an endpoint is ever configured, which is the documented default-on
behaviour. Do not "fix" this into reflecting the raw column.

The panel reads the endpoint from `directoryConfigured` on the same
`GET /api/instance/info` the Explore page reads: one field, reported on its
own, read once on mount. Nothing in the panel can create or remove an endpoint,
so nothing re-asks, and a request that fails leaves the fact unknown, which
renders as neither claim: no note, the switch reads the draft, and the global
rung keeps its description.

The same fact takes the **global rung** out of the ladder, because listing
needs the endpoint exactly as much as browsing does: with none, the pinger
never starts and no hub is ever told. The rung is disabled and its description
is replaced by "This instance is not configured to reach a directory, so
nothing here can be listed globally", instead of promising that spaces "appear
in the public Backspace directory, on every instance". A rung already stored as
selected still reads as selected, unlike the switch, which renders off: a radio
shows what the draft will save, and rendering a different rung as checked would
make the ladder disagree with its own write. Stepping down from it stays
possible; only stepping up into a level that would do nothing is refused.

**This used to be a great deal harder, and the history is worth one paragraph
so nobody rebuilds it.** `directoryAvailable` folded the endpoint and the
browse setting into one boolean, so the panel had to pair a server answer with
a client value that could move underneath it: it derived the endpoint from the
pair, captured the setting when the request went out, compared it when the
answer came back, refused a mismatch, and re-asked after every save. All of it
was correct and all of it was accidental complexity, caused by a fact that was
not reported. Reporting `directoryConfigured` deleted the derivation, the
capture, the comparison, the re-probe and the gate that made the probe wait for
the settings to load.

`settingsStore.updateInstanceSettings` mirrors `discoveryEnabled` and
`directoryEnabled` from the server's answer into `streamingLimits`, so the
space settings panel below sees the cleared directory flag after the ladder
dropped to a lower rung.

**Space settings, Discovery panel** (`SpaceSettings.tsx:DiscoveryPanel`), an
"Outer Space" group with the switch "List in the Backspace directory", always
rendered:

- Enabled when the instance allows it and the draft visibility is public or
  request.
- Disabled with "Your admin has to enable the directory for this instance."
  when `streamingLimits.directoryEnabled` is false. Never hidden: the reason
  under a disabled switch is what tells an owner what to do.
- Disabled with "Set visibility to public or request to join first." when the
  draft visibility is private; choosing private in the panel switches the
  draft off, matching what the server does on save.
- Under it, the same one-sentence disclosure.

Both flags come from the instance the space lives on
(`useInstanceDiscoveryFlags`): a home space reads the store's
`streamingLimits`, the one settings document any signed-in user may read; a
space whose `_instanceOrigin` is a connected remote asks that instance's own
`GET /api/settings/streaming` through its own client on mount, since home's
flags say nothing about it. Until the answer arrives the directory switch is
disabled with no reason and the discovery notice is hidden, rather than
showing home's values. A failed fetch falls back to the store's values and
lets the save's own error (`directory_requires_discovery`,
`directory_private_space`) speak.

Copy lives in the `spaces` namespace (`explore.inner.*`, `explore.outer.*`,
`explore.connect.*`, `settings.discovery.directory.*`,
`sidebar.dmList.explore`) and the `admin` namespace (`general.discovery.*`, `general.directory.*`, `general.browse.*`),
in `en`, `de`, `ru` and `zh`. The four server error codes
`directory_disabled`, `directory_unreachable`, `directory_private_space` and
`directory_requires_discovery` are registered in `packages/shared/src/errors.ts`
and described in every `errors.json`. See [localization.md](localization.md).

---

## 11. Environment variables

| Variable | Read by | Meaning |
|---|---|---|
| `DIRECTORY_ENDPOINT` | the server | hub base URL, default `https://explore.backspacechat.com` when the variable is unset. Trailing slashes are dropped. **An empty value disables the feature**: the pinger does not start and the proxy answers `404 directory_disabled`, for forks and air-gapped installs. Point it at a local `wrangler dev` to test end to end |

This is the operator-level switch and it takes both axes down together. The
admin-level switches are in the database: the discovery ladder for listing,
`directory_browse_enabled` for browsing (section 3). An operator who wants
only browsing off leaves the endpoint alone and lets the admin turn the switch
off in the panel; one who wants the instance to contact no hub at all sets the
variable empty, which needs a restart and cannot be undone from the UI.

`config.directory.endpoint` is read directly from `process.env` rather than
through the `envOptional` helper, which folds an empty value into unset and
would hand an operator who set `''` the project hub. Nothing else about the
directory is configured by environment: the opt-in state lives in the
database.

---

## 12. Deploying the hub

`.github/workflows/directory-hub.yml` has two jobs. `test` runs the typecheck
and the Workers test suite on every push to `main` and every pull request that
touches `scripts/directory-hub/**` or the workflow file, and holds no
secrets. `deploy` runs only when Jannis dispatches the workflow by hand from
`main`, never on a fork. It applies the migration files under
`scripts/directory-hub/migrations` to the live database and only then
publishes the Worker, so the schema is never behind the code that reads it,
and it provisions nothing of its own. A merge never deploys the hub.

**Rollout checklist.** Set up once, by hand, in this order; the deploy job
creates none of it. The hub ships before the server release that pings it,
so the first opted-in instance has somewhere to land, and the feed starts
empty and stays honest.

1. `wrangler d1 create backspace-directory` from `scripts/directory-hub`. It
   prints a `database_id`, which replaces `REPLACE-AT-ROLLOUT` in
   `wrangler.toml`. That value is not a secret and is committed.
2. `explore.backspacechat.com` attached to the Worker as a custom domain. The
   zone is already on the same Cloudflare account. The binding is declared in
   `wrangler.toml` under `routes`, and it is attached by the first deploy,
   which is run by hand from a workstation because a deploy that takes over a
   hostname may prompt for confirmation. Every deploy after that is the
   workflow.
3. The WAF rate-limiting rule, in the Cloudflare dashboard, in front of both
   `hello.backspacechat.com` and `explore.backspacechat.com`. The rule sits
   before the Worker is invoked, so a flood is refused without spending the
   free-plan request budget; the Worker's own limiter (2 per 10 seconds per
   address on the hub) is the second line. The rule's threshold is a
   dashboard setting, not versioned with the code, and should be generous
   enough that a fleet of instances each reading the feed once a minute per
   query and pinging a few times a day never trips it.
4. The GitHub environment `directory-hub`, holding `CLOUDFLARE_API_TOKEN`
   (scoped to editing Workers and D1 on that account and nothing else) and
   `CLOUDFLARE_ACCOUNT_ID`. Both live on the environment rather than at
   repository level, so no other job can read them.
5. Dispatch `directory-hub.yml` from `main`. That is every deploy after the
   hand-run first one in step 2.

**Retiring the service.** `RETIRED` is a plain `[vars]` entry in
`wrangler.toml`, not a secret. Setting it to `"1"` and deploying makes every
ping answer `410`, which instances read as "clear the dirty flag and stop
pinging until the next start" rather than as a failure to retry. Instances
keep their settings; each one tries once more per boot, so a hub that comes
back is found again without anyone touching a toggle.

---

## 13. Known limits

- **The D1 `batch()` statement cap is unverified in production.** A document
  of 200 spaces that changes entirely writes up to 401 statements in one
  batch (one `origins` upsert, then one statement per delete and one per
  changed row: up to 200 deletes and up to 200 upserts). The
  local Workers pool accepts far larger batches; the production limit has not
  been measured, and a batch over it would fail the ping with a `500`, which
  the pinger records as a plain status and retries with backoff. Until it is
  checked, an instance listing near the cap is the case to watch.
- **A dev instance without `DOMAIN` cannot be listed.** `resolveLocalOrigin()`
  falls back to `http://localhost:<port>`, the hub refuses it as `400`, and
  the admin panel shows the `origin` reason ("the directory refused this
  instance's address; it must be an https domain with no port (set DOMAIN or
  PUBLIC_ORIGIN)"). This is the right answer for a dev box and the wrong one
  for nothing else, since a production instance always has `DOMAIN` or
  `PUBLIC_ORIGIN`.
- **Browsing and listing are one endpoint.** Both the proxy and the pinger
  read `DIRECTORY_ENDPOINT`, so an operator cannot browse one hub and list on
  another, and an empty endpoint removes Outer Space along with the pinger.
  Each direction has its own admin switch above that (section 3), and neither
  lists anything by itself: no space is served until an owner asks.
- **Browsing still hands a user's address to the instances on screen.**
  Turning browsing off is all or nothing because an Outer Space card loads its
  icon and banner straight from the instance that owns the space, so a user
  who browses is seen by every instance whose card is rendered. The fix is to
  proxy card images through the home instance, which would also let the home
  instance cache and size them; it is not done. Until then the only way to
  keep users from contacting strangers' hosts is the browse switch, and the
  disclosure sentence in the admin panel says what a listed instance learns.
- **A dropped socket leaves an instance's spaces in neither section.**
  `setInstanceStatus` moves a live instance to `disconnected` when its socket
  goes, without touching the registry, so the entry stays `connected`: the
  origin is inner (no Outer cards) but not in the Inner fan-out (which reads
  live `connected`), and it gets no chip, since the chips read the registry.
  The spaces come back when the socket's backoff reconnects. This predates
  the chips and the inner-origin rule; closing it means having the socket
  teardown write a registry status, which would also make the Connections
  panel show a dropped socket as a state of its own.
- **The instance endpoint is public and cached.** The hub is not its only
  reader and it must cope with being polled by anyone; the 30 second cache is
  the whole answer to that.
- **Icons and banners are loaded by viewers' browsers from the listing
  instance** (`img-src https:` is already the CSP for Inner Space's remote
  instances). Outer Space extends that to instances the viewer never chose,
  which is why the validator pins those URLs to the listing origin and the
  disclosure sentence says so. A listing instance learns that someone with a
  given address opened Explore, nothing more.
- **Federation with a port in `DOMAIN`** was already unsupported; the hub's
  origin validator refuses a port as well.

---

## 14. Telemetry, and what separation buys

The directory and telemetry are separate opt-ins with separate columns,
separate toggles, separate copy, separate Workers and separate databases. The
telemetry receiver keeps every promise it makes today, including that it
never learns a domain and never fetches. What separation does not remove:
both Workers run in the maintainer's Cloudflare account, whose request logs
[telemetry.md](telemetry.md) already discloses, and whoever holds both
datasets could, for a small instance, match a telemetry row's country,
version and rounded space count to a directory origin. Separate databases
remove the join key, not the possibility. An instance that lists spaces has
chosen to publish its address; one that only reports telemetry has not, and
nothing here changes that.

---

## 15. Deferred

- **Language per space.** The ru/de/zh tracks will want to filter by it. It is
  one column, one field in the document, one `schema: 2` on both sides, and a
  chip on the page.
- **Peer-to-peer Outer Space.** Because `/api/directory/spaces` is public, an
  instance's Explore page could also read it from its federation peers with no
  hub at all. The hub then only covers the cold start of an instance with no
  peers.
- **A public page at `explore.backspacechat.com`.** The feed is public JSON
  from day one; a static page over it, with a contact address for reports, is
  a landing-page task.

All three sit on top of the same instance endpoint and the same document,
which is why that endpoint has a schema number and a strict validator from
the first release. Adding a field to the document is not a breaking change
and does not bump `schema`; changing the meaning of an existing field does.
