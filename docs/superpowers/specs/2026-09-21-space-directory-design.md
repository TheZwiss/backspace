# Space directory ("Outer Space") design

Date: 2026-09-21
Status: approved in conversation, revised after an independent review the same day, not yet implemented.

## 1. Purpose

Backspace federates, but nobody can find anything. The Explore page lists
discoverable spaces on the user's home instance and on the instances the user
has already connected to, and there is no way to learn that any other instance
exists short of being handed a link. For a newcomer without an invite the
whole client-federation story is a locked door.

This design adds an opt-in public directory of spaces. A space owner chooses
to list a space, the instance admin has allowed listing on that instance, and
the entry appears on every Backspace instance's Explore page in a clearly
separate section below the local one. Joining an entry runs the existing
connect-then-join flow.

Goals:

- Communities become findable from any instance, including a fresh one with no
  peers and no connections.
- Opt-in at both levels. Nothing is listed unless the admin allowed it and the
  space owner asked for it.
- The instance stays the source of truth. The directory is an index of what
  instances serve on a public endpoint of their own, never a registry that
  holds anything only it knows.
- Delisting takes effect at once, not on the next daily cycle.
- Local spaces are never ranked against, or pushed down by, the outside world.
- Free to run, and replaceable: the hub is one environment variable and its
  code is in the repository.

Non-goals:

- Listing instances. An instance is not a community; a card for
  `chat.example.org` tells nobody anything and grouping spaces behind it is
  worse.
- Any change to telemetry. The telemetry receiver keeps every promise it
  makes today, including that it never learns a domain and never fetches.
- Moderating content beyond a blocklist. See section 11.
- A language or tag field, a peer-to-peer directory over federation, and a
  public web page of the feed. All three are follow-ups built on the same
  endpoint, see section 16.

## 2. Naming

Two nouns on one axis, so the scope is understood before the first click:

| Name | What it is | Where it appears |
|---|---|---|
| **Inner Space** | Spaces on the home instance and connected instances. Today's Explore list, unchanged. | Section header on the Explore page |
| **Outer Space** | The directory: spaces on instances the user is not connected to. | Section header on the Explore page, the empty-state copy |

The page keeps the name Explore, and the hub is `explore.backspacechat.com`,
the address a visitor would guess. "Space" is a loanword in the German
catalog, "пространство" in Russian and 空间 in Chinese; inner/outer translate
literally in each, and the cosmic ring survives where the language has it.

## 3. Components and data flow

```
space owner flips "List in the Backspace directory"  (or admin toggle, delete, visibility)
        |
        v  markDirectoryDirty(): bumps the document version, drops the endpoint cache, debounced 3 s
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
   `{ origin: "chat.example.org" }`. The hub then fetches what that origin
   publicly serves and stores exactly that. A stranger can at most make an
   instance that already wants to be listed get listed a little sooner.
2. **A failed fetch never deletes.** Otherwise a stranger could delist an
   instance by pinging while it is down. An origin's rows are replaced only on
   a successful fetch. An empty list is a success and clears them. Rows whose
   origin has not fetched successfully in three days leave the feed.
3. **The hub never merges.** Every successful fetch replaces the origin's whole
   set, so a delist is not a message type; it is the absence of the space in
   the next fetch, and the pinger sends that ping immediately.

And one rule that keeps fact 3 honest end to end: **the served document is
never older than the last change.** The endpoint cache is dropped by the same
call that marks the instance dirty, and the pinger clears the dirty flag only
if nothing changed while its ping was in flight (section 6).

## 4. Opt-in state (server)

New columns on `instance_settings`, added with `pnpm db:generate` as the next
drizzle migration (`0015_*.sql`):

| Column | Meaning |
|---|---|
| `directory_enabled INTEGER NOT NULL DEFAULT 0` | The admin allows spaces on this instance to be listed |
| `directory_dirty INTEGER NOT NULL DEFAULT 0` | A ping is owed. Set by every change to the served document except member counts, cleared by a successful ping that was sent after the change. Survives restarts and survives the toggle being off |
| `directory_last_ping_at INTEGER` | ms timestamp of the last successful ping |
| `directory_last_error TEXT` | JSON `DirectoryPingError` of the last failed ping, null after a success |

```ts
// packages/shared/src/types.ts
export interface DirectoryPingError {
  at: number;
  status: number | 'network' | 'timeout' | 'origin' | 'fetch';
  /** Present when status is 'fetch': the hub's reason it could not read this instance. */
  reason?: 'unreachable' | 'status' | 'invalid' | 'origin-mismatch';
}
```

New column on `spaces`:

| Column | Meaning |
|---|---|
| `directory_listed INTEGER NOT NULL DEFAULT 0` | The owner asked for this space to be listed |

In memory, `packages/server/src/directory/state.ts` holds a
`documentVersion` counter, incremented by every `markDirectoryDirty()`. It is
not persisted: a restart always sends a boot ping when dirty, so a version
that started over at zero cannot clear a stale flag.

A space is served (section 5) when all four hold: `directory_enabled = 1`,
`discovery_enabled = 1`, `spaces.directory_listed = 1`, `visibility` is
`public` or `request`.

Invariant, enforced in one helper used by both settings routes: **discovery
off implies directory off.** `PATCH /api/settings/instance` rejects
`directoryEnabled: true` while discovery is off with `400
directory_requires_discovery`; switching `discoveryEnabled` off, on either
`PATCH /api/settings/instance` or `PATCH /api/settings/streaming` (which also
carries the field, `routes/settings.ts`), clears `directory_enabled` in the
same write.

Transitions that call `markDirectoryDirty()` (each is an existing handler):

- `PATCH /api/settings/instance` changing `directoryEnabled`,
  `discoveryEnabled`, `instanceName` or `federatedRegistrationOpen`;
  `PATCH /api/settings/streaming` changing `discoveryEnabled`
- `PATCH /api/spaces/:id` changing `directoryListed` in either direction, or
  changing `visibility`, `name`, `description`, `icon`, `banner` or
  `avatarColor` while the space is listed
- `DELETE /api/spaces/:id` for a listed space

Member counts change constantly and are refreshed by the daily ping only.

Who may flip `directoryListed`: the space owner or any member with
`MANAGE_SPACE`, the same rule as `visibility`. The server rejects
`directoryListed: true` on a `private` space with `400
directory_private_space`, and switching a listed space to `private` clears
`directory_listed` in the same write, so the flag never silently means
nothing.

`GET /api/settings/instance` gains `directoryEnabled`, `directoryLastPingAt`
and `directoryLastError`; the public `GET /api/instance/info` gains
`directoryEnabled`; `Space` gains `directoryListed`.

Telemetry is untouched: separate columns, separate toggle, separate copy, and
the receiver in section 7 is a separate Worker with a separate database.

## 5. The instance endpoint

`GET /api/directory/spaces`, unauthenticated, in `routes/directory.ts`.

Response, `schema: 1`:

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
      "icon": "https://chat.example.org/uploads/…",
      "banner": null,
      "avatarColor": "mint",
      "visibility": "public",
      "memberCount": 42,
      "createdAt": 1750000000000
    }
  ]
}
```

- `origin` is `resolveLocalOrigin()` (`PUBLIC_ORIGIN`, else `https://DOMAIN`);
  the hub compares it with the origin it fetched and rejects a mismatch, which
  also surfaces a misconfigured `DOMAIN` in the admin status line.
- `spaces` is empty, with the envelope intact, when `directory_enabled` or
  `discovery_enabled` is off. The endpoint never 404s, so a hub fetch of a
  switched-off instance is a success that clears its rows.
- The query is the Explore query (`routes/explore.ts`) with the two extra
  predicates, so member counts mean the same thing in both places. `icon` and
  `banner` are absolute URLs on this origin, and the hub only accepts them if
  they are (section 7).
- Limits: at most 200 spaces, name at most 100 characters, description at
  most 200 (the server already caps it there, `routes/spaces.ts`). These are
  the Explore fields any logged-in user of a peer instance can already read.
- Cached in memory until `markDirectoryDirty()` drops it or 30 seconds pass,
  whichever is first. The cache is the guard against polling, since the
  hub's fetches arrive from many Cloudflare addresses and the app's global
  per-user-or-IP limiter (200 per minute) is no help against a distributed
  reader. The cache never serves a document older than the last change, which
  is what makes an immediate delist ping fetch the delist rather than the
  previous document.

  > **Corrected after implementation. The bullet above is design-time intent,
  > not shipped behaviour.** The limiter is not per-user-or-IP. It is
  > registered as a plugin whose hook runs before authentication, so
  > `request.userId` is unset when the key is taken and the key is the client
  > address, structurally rather than by a default that could change. The
  > conclusion the bullet draws is unaffected, and the cache is still the
  > guard; only the limiter's description was wrong. That description was
  > copied from here into the route's own comment and then into the subsystem
  > doc, and was wrong in all three places until `547316ac` and `a5965db4`.
  > The mechanism is now described in one place, `docs/systems/api.md` under
  > "Rate limiting", and everything else points at it. Do not copy the
  > sentence above outward again.

## 6. The pinger (server)

`packages/server/src/directory/pinger.ts`, started and stopped from
`index.ts` next to the telemetry reporter, same shape as `reporter.ts`. It has
its own guard, an empty `DIRECTORY_ENDPOINT`, and does not sit under
`DISABLE_FEDERATION_WORKERS`; the federation harness disables workers and
still needs the pinger, pointed at a local stub.

When it pings:

- On any `markDirectoryDirty()`, debounced 3 seconds so a burst of edits sends
  one ping.
- On boot, if `directory_dirty = 1` or `directory_enabled = 1`. The boot ping
  is what puts a freshly upgraded instance back in the feed after a long
  outage without waiting for its slot.
- Daily, while `directory_enabled = 1`, at a slot minute derived from
  `instance_id` the way the telemetry reporter derives its own. Due when the
  UTC minute of day has reached the slot and `directory_last_ping_at` is
  earlier than today's slot instant, with a per-day attempted guard like the
  reporter's so a failing hub is tried once per day by the slot and otherwise
  only by the retry loop. An event ping earlier in the day does not satisfy
  the slot; the daily ping is the member-count refresh and always runs.

What it sends: `POST {DIRECTORY_ENDPOINT}/v1/ping` with body
`{ "schema": 1, "origin": "https://chat.example.org" }`, a 10 second timeout,
no redirects. Nothing else is ever in the body.

Every ping records the `documentVersion` it was sent under. When the answer
arrives, the dirty flag is cleared only if the version is still the same; a
change that landed while the ping was in flight keeps the flag and the
debounce sends the next ping. This is the reporter's "state changed while a
ping was in flight" check (`reporter.ts`) applied to a counter instead of the
toggle.

What it does with the answer:

| Answer | Action |
|---|---|
| `204` | clear `directory_dirty` if the version is unchanged, set `directory_last_ping_at`, clear `directory_last_error` |
| `429` | retry after `Retry-After` seconds, or 10 when the header is absent (the per-address limiter sends none); dirty stays set |
| `400` | `directory_last_error = { at, status: 'origin' }` and stop retrying until the next change; the origin itself is unacceptable (a port, an IP, http), and retrying will not help |
| `410` | the hub is retired: clear dirty, record the status, stop pinging until the next boot |
| `502` with `{ reason }` | the hub could not read this instance's endpoint: `directory_last_error = { at, status: 'fetch', reason }`, keep dirty, retry with backoff |
| anything else, network error, timeout | keep dirty, `directory_last_error = { at, status }`, retry with backoff 1, 5, 15, 60 minutes and then hourly |

The retry loop runs while dirty regardless of the toggle, which is what makes
"switch off and the hub happens to be unreachable" resolve on its own instead
of sitting in the feed for three days.

`DIRECTORY_ENDPOINT` in `config.ts`, default `https://explore.backspacechat.com`.
An empty value disables the pinger and the proxy in section 9 entirely, for
forks and air-gapped installs.

## 7. The hub (Cloudflare Worker)

`scripts/directory-hub/`, a workspace package copied from
`scripts/telemetry-receiver/` including its harness, the no-runtime-deps test
and the deploy workflow (`.github/workflows/directory-hub.yml`, test on pull
requests, dispatch-only deploy). Own D1 database `backspace-directory` with
its own `migrations/` applied by `wrangler d1 migrations apply`, own custom
domain `explore.backspacechat.com`, own `RETIRED` var. It is a separate Worker
because the telemetry receiver documents that it never stores a domain and
never fetches, and both are the point here. What separation does and does not
buy is stated in section 14.

Tables:

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

`POST /v1/ping`:

1. `410` while `RETIRED = "1"`, before anything else.
2. The source-address rate limiter from the telemetry receiver, same binding
   shape, address used as the key and never stored, tightened to 2 requests
   per 10 seconds: a pinger sends a handful of requests a day and honours
   `429`, and this is the bound on how many outbound fetches one address can
   cause.
3. Body at most 1024 bytes, `schema: 1`, `origin` a string. Canonicalise with
   `new URL(origin).origin`. It must have scheme `https`, no userinfo, no
   port, no path, query or fragment, a hostname with at least one dot that is
   not an IP literal and not the hub's own host. Otherwise `400`.
4. Per-origin cooldown against `fetch_attempts.last_fetch_at`, which exists
   for every origin ever pinged whether or not it ever validated: under 10
   seconds old, `429` with `Retry-After: 10`. Then upsert `last_fetch_at`
   before fetching, so a failed fetch still counts. Ten seconds is short
   enough that a second edit after the 3 second debounce still lands promptly.
5. Fetch `{origin}/api/directory/spaces` with a 10 second timeout,
   `redirect: 'manual'` (any redirect is a failure), `Accept:
   application/json`, response read with a 512 KB cap.
6. Validate: schema 1; `origin` equal to the fetched origin; `instance.name`
   a string of at most 100 characters; `instance.version`, if present, the
   telemetry receiver's version pattern; at most 200 spaces; every field of
   the right type and length (name 100, description 200); `icon` and `banner`
   null or strings that start with `origin + '/'`, so a listing cannot point
   viewers' browsers at a third party; `memberCount` a non-negative integer no
   larger than 10^9; `createdAt` a non-negative integer. Any failure is a
   `502 { reason: 'invalid' }` (`'origin-mismatch'` for the origin check).
7. On a valid document, compute `document_hash`. If it equals the stored one,
   update `last_ok_at` only (one row). Otherwise diff by `row_hash`: delete
   rows whose id is gone, upsert rows whose hash changed, update `origins`.
   All statements go in one `db.batch([...])`, one prepared statement per
   row, since D1 has no interactive transactions and caps bound parameters
   per statement at 100. `204`.
8. On a failed fetch (unreachable, non-200, redirect): `502 { reason:
   'unreachable' | 'status' }`. The rows are untouched; the status exists so
   the pinger keeps the dirty flag and the admin panel can show why the hub
   could not read this instance, which is usually a `DOMAIN` or reverse-proxy
   problem on the instance's side.

Writes are therefore proportional to what changed: a daily heartbeat with the
same member counts costs one row, a normal day costs a few rows per instance,
and a stranger re-pinging an instance whose document does not change costs
nothing beyond `fetch_attempts`.

`GET /v1/spaces?q=&limit=&offset=`:

- Public, no auth. Served through `caches.default` with a 60 second TTL,
  since a `Cache-Control` header alone does not put a Worker response in
  Cloudflare's cache; plus the per-address limiter, because the instance
  proxy in section 9 is not the only reader.
- Rows from origins with `last_ok_at` within 3 days, not blocked at origin
  (`space_id = '*'`) or space level, ordered by `member_count DESC, created_at
  DESC`. `q` (at most 100 characters, `%` and `_` escaped) matches name or
  description with a case-insensitive `LIKE`. `limit` 1 to 100 (default 50),
  `offset` at most 1000. No `total`: the "Show more" control only needs to
  know whether a page came back full.
- Response `{ schema: 1, spaces: [{ origin, instanceName,
  federatedRegistrationOpen, id, name, description, icon, banner, avatarColor,
  visibility, memberCount, createdAt }] }`.

Scheduled job, daily: delete `origins` rows (cascading) and `fetch_attempts`
rows older than 30 days, so a dead instance does not sit in the database
forever. The 3 day feed cutoff is the one users see; 30 days is housekeeping.

Blocks are managed with `wrangler d1 execute` and documented in
`docs/systems/directory.md`. There is no UI in this release.

**Free plan, stated plainly.** Workers Free is 100,000 requests per day per
account, cron invocations included, and that budget is shared with the
telemetry receiver; a second Worker separates data, not quota. D1 Free is
5 million rows read and 100,000 rows written per day. The design fits with
room: pings are a handful per instance per day, writes are diff-sized, reads
are cached for a minute at the edge and for a minute again on every instance.
The one thing the Worker cannot do for itself is refuse a flood before being
invoked, so a Cloudflare WAF rate-limiting rule (available on the free plan)
goes in front of both hostnames at deploy time; a WAF block is not a Worker
request and does not spend the quota. The rate-limit binding, `batch()`
atomicity, `AbortSignal.timeout` and `redirect: 'manual'` all work in workerd
and the telemetry receiver already deploys the binding. Not verified and to be
checked in the harness before it is relied on: the maximum number of
statements per `batch()`.

## 8. Explore page (web)

One page, one search box, two sections in fixed order, strictly disjoint.
`ExplorePage.tsx` already renders sections (the unjoined grid, then a
collapsible joined section below it); Outer Space goes below both.

- **Inner Space**: today's list, from `exploreStore.fetchSpaces()`, unchanged
  in content and ranking. Header "Inner Space", subtitle "Spaces on your
  instances". Stays on top whatever is below it.
- **Outer Space**: `directoryStore` fetching `GET /api/directory` from the
  home instance. Header "Outer Space", subtitle "Communities across
  Backspace". **Deduped by origin, not by space:** every entry whose
  canonical origin is the session's own (`isSelfOrigin`) or matches any
  instance in `instanceStore.instances` in any status, via `normalizeOrigin`
  on both sides, is dropped. Inner Space is paginated and filtered, so
  matching on space ids would let a connected instance's off-page space
  reappear in Outer Space as "needs a connection", and the home instance tags
  its spaces with `''` rather than an origin. Origin is what the section's
  name means anyway: outer is what needs a connection first.
  Paginated with a "Show more" control, 50 at a time, never the whole feed.
- The search box drives both: Inner filters as today, Outer re-queries the
  hub through the proxy, debounced 300 ms, showing a small inline spinner in
  its header rather than clearing the list.
- Cards: the Explore page's own `SpaceCard` (currently inline in
  `ExplorePage.tsx`, renders icon, banner, member count and the origin chip)
  is extracted to its own file and used for both sections.
  `ExploreSpacePreviewCard` stays what it is, the compact row in the Join
  Space modal. Outer cards always show the origin chip and add a "Closed to
  new accounts" badge when `federatedRegistrationOpen` is false. Their action
  reads "Connect and join" (public) or "Connect and request" (request), see
  section 9.
- Designed states for Outer Space, not defaults: the hub unreachable ("Outer
  Space is not reachable right now. Inner Space still works."), no results for
  the query, the directory disabled on this instance (`DIRECTORY_ENDPOINT`
  empty: the section is simply absent, not an error), and the early-days state
  when the feed is short.
- Mobile: `MobileShell` renders `ExplorePage` directly for the explore
  screen, so the section arrives there with no further work.
- Navigation: the compass in `SpaceSidebar` is rendered in every view and
  stays. The first coming-soon item in `ChannelSidebar` (the home view's DM
  list) becomes "Explore" with the compass icon and routes to `/explore`, as a
  second, closer entry point from the home view. The second coming-soon item
  stays as it is.
- `getApiForOrigin` in `exploreStore.ts` is module-private today and is
  exported for the directory store.

The section layout is verified with dev-harness screenshots before review, as
agreed for new surfaces. The spec fixes the structure, not the pixels.

## 9. Proxy and the connect-then-join flow

`GET /api/directory?q=&limit=&offset=` on the instance, authenticated, in
`routes/directory.ts`. It forwards to `{DIRECTORY_ENDPOINT}/v1/spaces` with the
same validated parameters (so `offset` is capped at 1000 here too) and:

- caches each distinct query for 60 seconds in an LRU of 64 entries, so a
  delist reaches clients within about a minute and the cache cannot grow
  without bound;
- coalesces identical in-flight requests into one upstream fetch;
- has its own limiter of 30 requests per minute per user, since distinct
  `q` and `offset` values miss the cache and the global 200 per minute would
  let one user drive a few hundred thousand hub reads a day through their
  instance.

Absent (`404 directory_disabled`) when `DIRECTORY_ENDPOINT` is empty; `502
directory_unreachable` when the hub does not answer, which the section renders
as its unreachable state. The browser never talks to the hub.

Clicking an Outer card's action runs one continuation, owned by
`directoryStore.connectAndJoin(entry)`:

1. Connect through `useInstanceConnect.connect(host, password)`, which already
   picks `reauthenticateInstance` for an instance the store knows in an
   `error` or `disconnected` state and `probeInstance` plus `connectToRemote`
   otherwise. The connect panel is `AddInstanceFlow` (`ConnectedInstances.tsx`)
   lifted so it can open as a modal with the origin prefilled: the domain
   input is skipped, the probe is not, because the probe is what performs the
   self and duplicate checks, the `federatedRegistrationOpen` banner and the
   origin normalisation. Copy: "This space lives on chat.example.org. Enter
   your password for home.example.org to create your identity there." The
   typed password is verified against the home instance
   (`homeApi.users.verifyPassword`) and the home mints the per-remote secret;
   the remote never sees what was typed, so a user cannot end up with a
   different password on the remote by accident. The fallback login phase for
   a pre-existing account on that instance is unchanged.
2. Then `exploreStore.publicJoin` or `requestJoin` for the entry against that
   origin. A `409 already_member` (the user had a federated account there and
   was in the space already) is not an error: the space arrives with the
   connection's ready payload, and the continuation navigates into it like a
   successful join.
3. Pending join requests are keyed by origin as well as space id. Today
   `useSpaceJoin` matches `r.spaceId === space.id` and `fetchMyRequests` asks
   only the home instance, which assumes a single global id space; the
   continuation fetches the just-connected origin's `myJoinRequests` and the
   hook compares `(origin, spaceId)`. This fixes an existing gap that Outer
   Space would otherwise lean on.
4. On success the card moves to Inner Space on the next render because its
   origin is now connected.

## 10. Settings UI

**Admin, General panel** (`GeneralPanel.tsx`), under the existing discovery
setting: "List spaces in the Backspace directory" toggle.

- Disabled with "Turn on space discovery first" while `discoveryEnabled` is
  off.
- Amber note while `federatedRegistrationOpen` is off: "New accounts from
  other instances are closed, so listed spaces will show as closed to new
  accounts."
- Below the toggle, the same status line the telemetry panel has, fed by
  `directoryLastPingAt` and `directoryLastError` from `GET
  /api/settings/instance`: last successful ping, or the last error with its
  reason, so an admin can tell a bad `DOMAIN` from a healthy listing.
- One sentence naming what becomes public for each listed space: its name,
  description, icon, banner, member count and this instance's address, and
  that people browsing the directory load the icon and banner from this
  instance.

**Space settings, Discovery panel** (`SpaceSettings.tsx:DiscoveryPanel`):
"List in the Backspace directory" switch, always rendered:

- Enabled when the instance allows it and visibility is public or request.
- Disabled with "Your admin has to enable the directory for this instance"
  when `directoryEnabled` is off. Never hidden.
- Disabled with "Set visibility to public or request first" when the space is
  private. Switching a listed space to private turns the switch off
  server-side and the panel reflects that.
- Under it, the same one-sentence disclosure as the admin toggle.

## 11. Abuse, moderation and what it costs the maintainer

- Listing anything requires controlling the origin, by construction.
- The hub's outbound fetch is bounded per origin (cooldown on every origin
  ever pinged) and per source address (rate limiter, WAF rule), targets a
  cheap cached endpoint, and cannot reach a private network from Cloudflare's
  edge; origin validation refuses IP literals, ports, redirects and non-https
  anyway.
- The instance endpoint is public and cached; the hub is not its only reader
  and it must cope with being polled by anyone.
- Icons and banners are loaded by viewers' browsers from the listing
  instance (`img-src https:` is already the CSP for Inner Space's remote
  instances). Outer Space extends that to instances the viewer never chose,
  which is why the validator pins those URLs to the listing origin and the
  disclosure sentence says so. A listing instance learns that someone with a
  given address opened Explore, nothing more.
- A public directory makes the hub operator the moderator of what is on it.
  The blocklist is the tool: by origin or by space, applied on the next feed
  read, no UI. A report path (a contact address on a public page) is part of
  the follow-up in section 16, not this release. This is a real recurring cost
  and the reason the hub is one environment variable away from being someone
  else's.

## 12. Federation compatibility

Entries are addressed by canonical `origin` plus the instance-local space id,
the same `spaceId:origin` key `exploreStore` already uses; no global id is
assumed anywhere, and section 9 step 3 removes the one place the join flow
assumed it. The join step uses `getApiForOrigin(origin)` after the connection
exists, exactly as Inner Space joins do. A user browsing a connected remote
instance sees that instance's Explore page, which proxies through its own
`DIRECTORY_ENDPOINT`; the feed is the same hub unless that admin pointed
elsewhere, and dedupe runs against whatever that session has connected.

## 13. Localization

New keys in `spaces` (explore sections, card actions, empty states, the
discovery switch and its two disabled reasons, the disclosure sentence) and in
`admin` (the toggle, its disabled reason, the amber note, the status line),
for `en`, `de`, `ru`, `zh`. New server error codes, registered in
`packages/shared/src/errors.ts` and described in the four `errors.json`
catalogs: `directory_disabled`, `directory_unreachable`,
`directory_private_space`, `directory_requires_discovery`. Fonts are
unaffected; no new script.

## 14. Documentation

- New `docs/systems/directory.md`: state columns, the instance endpoint, the
  pinger's table of answers, the hub's routes and tables, the blocklist
  procedure, the WAF rule, `DIRECTORY_ENDPOINT`, the three-facts model from
  section 3.
- `database.md` (five columns), `api.md` (`/api/directory/spaces`,
  `/api/directory`, the new settings fields), `admin.md` (the toggle and
  status), `spaces.md` (the switch and the Explore sections),
  `client-federation.md` (the connect-from-card entry point and the
  origin-keyed pending requests), `localization.md` (error codes),
  `deployment.md` and `.env.example` (`DIRECTORY_ENDPOINT`), `CLAUDE.md`
  subsystem table (the new doc).
- `telemetry.md` gets one honest paragraph, not a claim of independence: the
  two features are separate opt-ins with separate receivers and databases,
  the telemetry receiver's promises are unchanged, and the residual linkage
  is that both Workers run in the maintainer's Cloudflare account (whose
  request logs telemetry.md already discloses) and that whoever holds both
  datasets could, for a small instance, match a telemetry row's country,
  version and rounded space count to a directory origin. Separate databases
  remove the join key, not the possibility.

## 15. Testing

Server: the endpoint's four-way gate; the query matches Explore's member
counts; the cache is dropped by `markDirectoryDirty`; every listed transition
on both settings routes and both space routes marks dirty; the discovery-off
invariant on both routes; the pinger's table of answers including `429` with
and without `Retry-After`, the version-guarded clear (a change during an
in-flight ping keeps the flag), the boot ping, the daily slot rule against an
earlier event ping, dirty surviving the toggle being off; the proxy's cache,
LRU bound, coalescing, limiter and error mapping; the settings validations.
Hub: the origin validator (a table of bad origins, canonicalisation), never
delete on failure, replace not merge, the empty list clears, the origin
mismatch rejection, the URL pinning of icon and banner, the cooldown on a
never-validated origin, unchanged-hash costs one row, the diff writes only
changed rows, blocks at both levels including `'*'`, the 3 day cutoff, the
size cap, `LIKE` escaping. Web: the origin dedupe including the home `''`
case and a disconnected instance, the Outer card's action states, the
connect-then-join continuation including reconnect and `409 already_member`,
origin-keyed pending requests, the search driving both sections, the switch's
three states. Federation harness: an instance with `DIRECTORY_ENDPOINT`
pointed at a local stub, listing and delisting end to end.

## 16. Deferred, and why the endpoint is the piece to get right

- **Language per space.** The ru/de/zh tracks will want to filter by it. It is
  one column, one field in the document, one `schema: 2` on both sides, and a
  chip on the page.
- **Peer-to-peer Outer Space.** Because `/api/directory/spaces` is public, an
  instance's Explore page could also read it from its federation peers with no
  hub at all, the way Matrix room directories cross homeservers. The hub then
  only covers the cold start of an instance with no peers.
- **A public page at `explore.backspacechat.com`.** The feed is public JSON
  from day one; a static page over it, with a contact address for reports, is
  a landing-page task.

All three sit on top of the same instance endpoint and the same document, which
is why that endpoint has a schema number and a strict validator from the
first release.

## 17. Work split

1. Server state and endpoint: migration, `directory/state.ts`
   (`markDirectoryDirty`, version, cache drop), `routes/directory.ts` (both
   routes, proxy cache and limiter), settings validation and the discovery-off
   invariant on both routes, error codes, shared types.
2. Pinger: `directory/pinger.ts`, boot and daily wiring, tests.
3. Hub: `scripts/directory-hub/` package, migrations, routes, tests, workflow.
4. Web: `directoryStore`, `SpaceCard` extraction, the Outer Space section,
   card states, the connect-from-card modal, origin-keyed pending requests,
   settings switches, catalogs.
5. Docs and the federation harness case.

Steps 1 to 3 are independent of each other; 4 depends on 1 and 3 for anything
beyond stubs. Developed locally as one branch and not pushed until the whole
thing has been tested end to end, per the working agreement.

## 18. Rollout

Cloudflare: create the D1 database, the custom domain and the WAF
rate-limiting rule by hand once, the same kind of steps the telemetry receiver
needed, then dispatch the deploy workflow. The hub ships before the server
release that pings it, so the first opted-in instance has somewhere to land.
Nothing is listed until an admin and a space owner both act, so the feed
starts empty and stays honest.
