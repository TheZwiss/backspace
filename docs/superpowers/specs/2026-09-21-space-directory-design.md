# Space directory ("Outer Space") design

Date: 2026-09-21
Status: approved in conversation, not yet implemented.

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
        v  marks directory_dirty, debounced 3 s
instance server pinger  --POST { origin }-->  explore.backspacechat.com  (Worker + D1)
        ^                                              |
        |                                              v  GET {origin}/api/directory/spaces (verify by fetch)
        +----------------------------------------------+  replace that origin's rows on 200, keep them on failure

any instance server  --GET /v1/spaces?q=&limit=&offset=-->  hub   (proxied to the client as GET /api/directory, 60 s cache)
        |
        v
Explore page: Inner Space (local stores)  +  Outer Space (directory feed minus anything already in Inner Space)
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

## 4. Opt-in state (server)

New columns on `instance_settings`:

| Column | Meaning |
|---|---|
| `directory_enabled INTEGER NOT NULL DEFAULT 0` | The admin allows spaces on this instance to be listed |
| `directory_dirty INTEGER NOT NULL DEFAULT 0` | A ping is owed. Set by every change to the served document except member counts, cleared by a successful ping. Survives restarts and survives the toggle being off |
| `directory_last_ping_at INTEGER` | ms timestamp of the last successful ping |
| `directory_last_error TEXT` | JSON `{ at, status }` of the last failed ping, null after a success. `status` is an HTTP status, `network`, `timeout` or `origin` (the hub rejected the origin) |

New column on `spaces`:

| Column | Meaning |
|---|---|
| `directory_listed INTEGER NOT NULL DEFAULT 0` | The owner asked for this space to be listed |

A space is served (section 5) when all four hold: `directory_enabled = 1`,
`discovery_enabled = 1`, `spaces.directory_listed = 1`, `visibility` is
`public` or `request`. The admin toggle cannot be switched on while
`discovery_enabled` is off (the client disables it with the reason, the server
rejects it with a `400` error code so a stale client cannot bypass it).

Transitions that set `directory_dirty` (all in existing handlers, one shared
`markDirectoryDirty()` call):

- `PATCH /api/settings/instance` changing `directoryEnabled`,
  `discoveryEnabled`, `instanceName` or `federatedRegistrationOpen`
- `PATCH /api/spaces/:id` changing `directoryListed`, `visibility`, `name`,
  `description`, `icon`, `banner` or `avatarColor` while the space is listed,
  or changing `directoryListed` in either direction
- `DELETE /api/spaces/:id` for a listed space

Member counts change constantly and are refreshed by the daily ping only.

Who may flip `directoryListed`: the space owner or any member with
`MANAGE_SPACE`, the same rule as `visibility`. The server rejects
`directoryListed: true` on a `private` space (`400`, error code) rather than
silently serving nothing, so the client always knows why.

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

- `origin` is `resolveLocalOrigin()`; the hub compares it with the origin it
  fetched and rejects a mismatch, which also covers a misconfigured `DOMAIN`.
- `spaces` is empty, with the envelope intact, when `directory_enabled` or
  `discovery_enabled` is off. The endpoint never 404s, so a hub fetch of a
  switched-off instance is a success that clears its rows.
- The query is the Explore query (`routes/explore.ts`) with the two extra
  predicates, so member counts mean the same thing in both places. `icon` and
  `banner` are absolute URLs on this origin.
- Limits: at most 200 spaces, description truncated to 500 characters, name to
  100. These are the Explore fields any logged-in user of a peer instance can
  already read, so the endpoint makes public what was already public to anyone
  with an account.
- Cached in memory for 30 seconds and covered by the public rate limiter, since
  the hub is not the only party that may call it.

## 6. The pinger (server)

`packages/server/src/directory/pinger.ts`, started and stopped from
`index.ts` next to the telemetry reporter, same shape as `reporter.ts`.

When it pings:

- On any `markDirectoryDirty()`, debounced 3 seconds so a burst of edits sends
  one ping.
- On boot, if `directory_dirty = 1` or `directory_enabled = 1`. The boot ping
  is what puts a freshly upgraded instance back in the feed after a long
  outage without waiting for its slot.
- Daily at a slot minute derived from `instance_id`, while `directory_enabled
  = 1`, as the liveness heartbeat and the member-count refresh.

What it sends: `POST {DIRECTORY_ENDPOINT}/v1/ping` with body
`{ "schema": 1, "origin": "https://chat.example.org" }`, a 10 second timeout,
no redirects. Nothing else is ever in the body.

What it does with the answer:

| Answer | Action |
|---|---|
| `204` | clear `directory_dirty`, set `directory_last_ping_at`, clear `directory_last_error` |
| `429` with `Retry-After` | retry after that many seconds (the hub's per-origin cooldown), dirty stays set |
| `400` | `directory_last_error = { at, status: 'origin' }` and stop retrying until the next change; the origin itself is unacceptable (a port, an IP, http), and retrying will not help |
| `410` | the hub is retired: clear dirty, record the status, stop pinging until the next boot |
| anything else, network error, timeout | keep dirty, retry with backoff 1, 5, 15, 60 minutes and then hourly |

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
requests, dispatch-only deploy). Own D1 database `backspace-directory`, own
custom domain `explore.backspacechat.com`, own `RETIRED` var. It is a separate
Worker because the telemetry receiver documents that it never stores a domain
and never fetches, and both are the point here; sharing a database would also
make telemetry ids and domains correlatable to anyone holding it.

Tables:

```sql
CREATE TABLE origins (
  origin TEXT PRIMARY KEY,
  instance_name TEXT NOT NULL,
  federated_registration_open INTEGER NOT NULL,
  version TEXT,
  first_seen_at INTEGER NOT NULL,
  last_ok_at INTEGER NOT NULL,
  last_fetch_at INTEGER NOT NULL
);
CREATE TABLE spaces (
  origin TEXT NOT NULL REFERENCES origins(origin) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL, description TEXT, icon TEXT, banner TEXT, avatar_color TEXT,
  visibility TEXT NOT NULL, member_count INTEGER NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (origin, id)
);
CREATE TABLE blocks (
  origin TEXT NOT NULL, space_id TEXT,  -- NULL blocks the whole origin
  reason TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (origin, space_id)
);
CREATE INDEX spaces_members ON spaces(member_count DESC);
```

`POST /v1/ping`:

1. `410` while `RETIRED = "1"`, before anything else.
2. The source-address rate limiter from the telemetry receiver, same binding
   shape, address used as the key and never stored.
3. Body at most 1024 bytes, `schema: 1`, `origin` a string. The origin must
   parse as a URL with scheme `https`, no userinfo, no port, no path, query or
   fragment, a hostname with at least one dot that is not an IP literal and
   not the hub's own host. Otherwise `400`.
4. Per-origin cooldown: if `origins.last_fetch_at` is under 10 seconds old,
   `429` with `Retry-After: 10`. This bounds how often a stranger can make the
   hub hit a third party, and 10 seconds is short enough that a second edit
   after the 3 second debounce still lands promptly.
5. Fetch `{origin}/api/directory/spaces` with a 10 second timeout, no
   redirects, `Accept: application/json`, response read with a 256 KB cap.
   Set `last_fetch_at` whatever happens.
6. On `200` with a document that validates (schema 1, `origin` equal to the
   fetched origin, every space field of the right type and length, at most
   200 spaces, member counts non-negative integers no larger than 10^9): in
   one transaction, upsert `origins` (setting `last_ok_at`), delete the
   origin's `spaces` rows and insert the new ones. `204`.
7. On anything else: leave the rows alone. `204` as well, since the caller
   cannot act on the difference and a `5xx` would only make the pinger retry
   against a problem on its own side. The pinger's own health signal is its
   next fetch, not the hub's opinion.

`GET /v1/spaces?q=&limit=&offset=`:

- Public, no auth, `Cache-Control: public, max-age=60`.
- Rows from origins with `last_ok_at` within 3 days, not blocked at origin or
  space level, ordered by `member_count DESC, created_at DESC`. `q` matches
  name or description, case-insensitive `LIKE`, at most 100 characters.
  `limit` 1 to 100 (default 50), `offset` at most 10000.
- Response `{ schema: 1, total, spaces: [{ origin, instanceName,
  federatedRegistrationOpen, id, name, description, icon, banner, avatarColor,
  visibility, memberCount, createdAt }] }`.

Scheduled job, daily: delete `origins` rows (cascading) whose `last_ok_at` is
older than 30 days, so a dead instance does not sit in the database forever.
The 3 day feed cutoff is the one users see; 30 days is housekeeping.

Blocks are managed with `wrangler d1 execute` and documented in
`docs/systems/directory.md`. There is no UI in this release.

Free tier: one inbound request and one outbound fetch per instance per day
plus one per edit, and read traffic that is one request per instance per
minute at most thanks to the proxy cache. A thousand listed instances would
not approach the free plan's daily request allowance.

## 8. Explore page (web)

One page, one search box, two sections in fixed order, strictly disjoint.
`ExplorePage.tsx` already renders sections (joined spaces collapsible above
the unjoined ones); this adds one more below.

- **Inner Space**: today's list, from `exploreStore.fetchSpaces()`, unchanged
  in content and ranking. Header "Inner Space", subtitle "Spaces on your
  instances". Stays on top whatever is below it.
- **Outer Space**: `directoryStore` fetching `GET /api/directory` from the
  home instance. Header "Outer Space", subtitle "Communities across
  Backspace". Every entry whose `spaceId:origin` is present in Inner Space is
  dropped, so the sections never show the same space and the names are
  literally true: inner is joinable now, outer needs a connection first.
  Paginated with a "Show more" control, 50 at a time, never the whole feed.
- The search box drives both: Inner filters as today, Outer re-queries the
  hub through the proxy, debounced 300 ms, showing a small inline spinner in
  its header rather than clearing the list.
- Cards use `ExploreSpacePreviewCard` for both sections. Outer cards always
  show the origin chip the card already renders for remote spaces, and add a
  "Closed to new accounts" badge when `federatedRegistrationOpen` is false.
  Their action reads "Connect and join" (public) or "Connect and request"
  (request), see section 9.
- Designed states for Outer Space, not defaults: the hub unreachable ("Outer
  Space is not reachable right now. Inner Space still works."), no results for
  the query, the directory disabled on this instance (`DIRECTORY_ENDPOINT`
  empty: the section is simply absent, not an error), and the early-days state
  when the feed is short.
- Mobile: the Explore screen in `MobileScreenStack` gains the same section; no
  new screen.
- Navigation: the compass in `SpaceSidebar` stays. The first coming-soon item
  in `ChannelSidebar` (the home view's DM list) becomes "Explore" with the
  compass icon and routes to `/explore`, because the home view has no way to
  reach the page today. The second coming-soon item stays as it is.

The section layout is verified with dev-harness screenshots before review, as
agreed for new surfaces. The spec fixes the structure, not the pixels.

## 9. Proxy and the connect-then-join flow

`GET /api/directory?q=&limit=&offset=` on the instance, authenticated, in
`routes/directory.ts`. It forwards to `{DIRECTORY_ENDPOINT}/v1/spaces` with the
same validated parameters and caches each distinct query for 60 seconds in
memory, so a delist reaches clients within about a minute and the browser
only ever talks to its own instance. Absent (`404` with an error code) when
`DIRECTORY_ENDPOINT` is empty; `502` with an error code when the hub does not
answer, which the section renders as its unreachable state.

Clicking an Outer card's action:

1. If `instanceStore` already has a connected session for that origin
   (possible when the feed is a minute stale), fall through to the normal
   Inner join via `exploreStore.publicJoin` / `requestJoin`.
2. Otherwise open the existing connect panel (`AddInstanceFlow` in
   `ConnectedInstances.tsx`, lifted so it can be opened as a modal with a
   prefilled origin and no domain step). Copy: "This space lives on
   chat.example.org. Enter your password for home.example.org to create your
   identity there." The panel is the existing one: the typed password is
   verified against the home instance (`homeApi.users.verifyPassword`) and the
   home mints the per-remote secret; the remote never sees what was typed, so
   a user cannot end up with a different password on the remote by accident.
   The fallback login phase for a pre-existing account on that instance is
   unchanged.
3. On success, `connectToRemote` has added the instance; the store then runs
   `publicJoin` or `requestJoin` for the card's space against that origin and
   navigates into the space (or shows the request-sent state). The card moves
   to Inner Space on the next render because its origin is now connected.

## 10. Settings UI

**Admin, General panel** (`GeneralPanel.tsx`), under the existing discovery
setting: "List spaces in the Backspace directory" toggle.

- Disabled with "Turn on space discovery first" while `discoveryEnabled` is
  off.
- Amber note while `federatedRegistrationOpen` is off: "New accounts from
  other instances are closed, so listed spaces will show as closed to new
  accounts."
- Below the toggle, the same status line the telemetry panel has: last
  successful ping, or the last error, so an admin can tell a bad `DOMAIN` from
  a healthy listing.
- One sentence naming what becomes public for each listed space: its name,
  description, icon, banner, member count and this instance's address.

**Space settings, Discovery panel** (`SpaceSettings.tsx:DiscoveryPanel`):
"List in the Backspace directory" switch, always rendered:

- Enabled when the instance allows it and visibility is public or request.
- Disabled with "Your admin has to enable the directory for this instance"
  when `directoryEnabled` is off. Never hidden.
- Disabled with "Set visibility to public or request first" when the space is
  private. Switching a listed space to private turns the switch off
  server-side and the panel reflects that.
- Under it, the same one-sentence disclosure as the admin toggle.

`InstanceAdminSettings` and the public `GET /api/instance/info` gain
`directoryEnabled`; `Space` gains `directoryListed`. Both are plain booleans on
the wire.

## 11. Abuse, moderation and what it costs the maintainer

- Listing anything requires controlling the origin, by construction.
- The hub's outbound fetch is bounded per origin (cooldown) and per source
  address (rate limiter), targets a cheap cached endpoint, and cannot reach a
  private network from Cloudflare's edge; origin validation refuses IP
  literals, ports and non-https anyway.
- The instance endpoint is public and cached; the hub is not its only reader
  and it must cope with being polled by anyone.
- A public directory makes the hub operator the moderator of what is on it.
  The blocklist is the tool: by origin or by space, applied on the next feed
  read, no UI. A report path (a contact address on a public page) is part of
  the follow-up in section 16, not this release. This is a real recurring cost
  and the reason the hub is one environment variable away from being someone
  else's.

## 12. Federation compatibility

Entries are addressed by `origin` plus the instance-local space id, the same
`spaceId:origin` key `exploreStore` already uses; no global id is assumed
anywhere. The join step uses `getApiForOrigin(origin)` after the connection
exists, exactly as Inner Space joins do. A user browsing a connected remote
instance sees that instance's Explore page, which proxies through its own
`DIRECTORY_ENDPOINT`; the feed is the same hub unless that admin pointed
elsewhere, and dedupe runs against whatever that session has connected.

## 13. Localization

New keys in `spaces` (explore sections, card actions, empty states, the
discovery switch and its two disabled reasons, the disclosure sentence) and in
`admin` (the toggle, its disabled reason, the amber note, the status line),
for `en`, `de`, `ru`, `zh`. New server error codes for: directory disabled on
this instance, hub unreachable, listing a private space, enabling the
directory while discovery is off. Fonts are unaffected; no new script.

## 14. Documentation

- New `docs/systems/directory.md`: state columns, the instance endpoint, the
  pinger's table of answers, the hub's routes and tables, the blocklist
  procedure, `DIRECTORY_ENDPOINT`, the three-facts model from section 3.
- `database.md` (five columns), `api.md` (`/api/directory/spaces`,
  `/api/directory`, the two new settings fields), `admin.md` (the toggle and
  status), `spaces.md` (the switch and the Explore sections),
  `client-federation.md` (the connect-from-card entry point),
  `localization.md` (error codes), `deployment.md` and `.env.example`
  (`DIRECTORY_ENDPOINT`), `telemetry.md` (one paragraph stating the two
  features are independent and the receivers are separate), `CLAUDE.md`
  subsystem table (the new doc).

## 15. Testing

Server: the endpoint's four-way gate; the query matches Explore's member
counts; `markDirectoryDirty` is called from each listed transition; the
pinger's table of answers including `429` honouring `Retry-After`, the boot
ping, dirty surviving the toggle being off; the proxy's cache and its error
mapping; the settings validations. Hub: the origin validator (a table of bad
origins), never-delete-on-failure, replace-not-merge, the empty-list clears,
the origin mismatch rejection, the cooldown, blocks at both levels, the 3 day
cutoff, the size cap. Web: the dedupe between sections, the Outer card's
three action states, the connect-then-join continuation, the search driving
both sections, the switch's three states. Federation harness: an instance with
`DIRECTORY_ENDPOINT` pointed at a local stub, listing and delisting end to end.

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

1. Server state and endpoint: columns, `markDirectoryDirty`, `routes/directory.ts` (both routes), settings validation, error codes.
2. Pinger: `directory/pinger.ts`, boot and daily wiring, tests.
3. Hub: `scripts/directory-hub/` package, migrations, routes, tests, workflow.
4. Web: `directoryStore`, the Outer Space section, card states, the connect-from-card modal, settings switches, catalogs.
5. Docs and the federation harness case.

Steps 1 to 3 are independent of each other; 4 depends on 1 and 3 for anything
beyond stubs. Developed locally as one branch and not pushed until the whole
thing has been tested end to end, per the working agreement.

## 18. Rollout

Cloudflare: create the D1 database and the custom domain by hand once, the
same steps the telemetry receiver needed, then dispatch the deploy workflow.
The hub ships before the server release that pings it, so the first opted-in
instance has somewhere to land. Nothing is listed until an admin and a space
owner both act, so the feed starts empty and stays honest.
