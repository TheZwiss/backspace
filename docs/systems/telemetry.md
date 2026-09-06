# Instance Telemetry ("Say hi to Jannis")

The optional daily usage report a Backspace admin can switch on. It is off on
every instance until somebody turns it on, it never carries anything about a
person or a domain, and everything that comes back is published as open data.

Source files:
- `packages/server/src/telemetry/day.ts` - UTC calendar-day helpers (`utcDay`, `addDays`, `isIsoDay`)
- `packages/server/src/telemetry/rounding.ts` - `roundTwoSignificant`, the one rounding rule
- `packages/server/src/telemetry/state.ts` - the four `instance_settings` columns and the on/off transition
- `packages/server/src/telemetry/activity.ts` - `touchUserActivity`, `parseClientKind`
- `packages/server/src/telemetry/payload.ts` - `buildTelemetryPayload`, the pure builder
- `packages/server/src/telemetry/reporter.ts` - `slotMinute`, `reporterTick`, `startTelemetryReporter`, `stopTelemetryReporter`
- `packages/server/src/routes/adminTelemetry.ts` - the three admin routes
- `packages/server/src/ws/handler.ts` - the auth and pong paths that write activity
- `scripts/telemetry-receiver/` - the Cloudflare Worker at `hello.backspacechat.com`
- `.github/workflows/telemetry-receiver.yml` - the receiver's test job and its dispatch-only deploy
- `scripts/metrics/src/telemetry.ts` - the collector step that turns pings into the public archive
- Design spec: `docs/superpowers/specs/2026-09-06-instance-telemetry-design.md`

---

## 1. Why this exists

Backspace tracks nobody, and that includes the maintainer. There is a download
counter on GitHub and then nothing: no way to tell whether anyone runs an
instance, which version they run, or whether a release broke them. This feature
lets an admin answer that question on purpose, once a day, with rounded counts
and no identifiers.

What it is for:

- A lower bound on real use: instances, active users, versions, countries,
  client kinds. A lower bound, never a measurement, because only the instances
  that opted in are in it.
- Zero cost to anyone who does not opt in. Nothing is sent and nothing is
  fetched. The ask stops after one answer or two dismissals.

What it is not: there is no client telemetry of any kind. The web, desktop and
mobile clients report nothing, ever. There is no crash reporting, no error
reporting and no performance data, and the receiver holds nothing per user.

---

## 2. What a ping carries

One JSON document per instance per UTC day, `schema: 1`:

```json
{
  "schema": 1,
  "instance": "3f6c9e2a-...",
  "day": "2026-09-06",
  "build":    { "version": "1.1.2", "commit": "0a1c465", "modified": false },
  "users":    { "registered": 42, "active1d": 7, "active7d": 19, "active30d": 31 },
  "clients":  { "web": 12, "desktop": 6, "mobile": 1 },
  "content":  { "spaces": 3, "channels": 21, "messages": 12000, "messages7d": 410, "storageMiB": 700 },
  "features": { "voice": true, "federation": true, "peers": 2, "registrationOpen": false },
  "runtime":  { "install": "prebuilt", "os": "linux", "arch": "arm64", "node": 20 },
  "installedAt": "2026-07"
}
```

Field meanings, fixed for `schema: 1`:

| Field | Meaning |
|---|---|
| `instance` | `instance_settings.telemetry_id`, a random UUID with no link to anything else |
| `day` | the UTC day the report describes, from the instance clock |
| `build.version` | server package version |
| `build.commit` | `config.commit` (the short SHA a build was stamped with) or `null` |
| `build.modified` | `true` when `config.sourceCodeUrl` differs from the upstream repository, so a fork reports itself as one |
| `users.registered` | local accounts: `home_instance IS NULL` and not deleted. Replicated federated identities are never counted, they belong to their home instance |
| `users.active1d/7d/30d` | registered users whose `last_active_day` falls in the last 1, 7 or 30 days including `day` |
| `clients.*` | the `active7d` users grouped by `last_client`; a `null` counts as `web` |
| `content.spaces` | rows in `spaces` |
| `content.channels` | rows in `channels`, every type including voice. DM channels live in their own table and are not counted |
| `content.messages` | rows in `messages`. DM messages live in `dm_messages` and are not counted |
| `content.messages7d` | `messages` created in the last 7 days |
| `content.storageMiB` | the sum of `attachments.size` for locally uploaded files (`source_url IS NULL`), in MiB. A replicated copy of a peer's file is that peer's storage to report |
| `features.voice` | LiveKit URL, key and secret are all set |
| `features.federation` | `federation_relay_enabled = 1` and a domain is configured |
| `features.peers` | `federation_peers` rows with status `active` |
| `features.registrationOpen` | the effective value after the database override |
| `runtime.install` | `prebuilt`, `source`, or `null` when `BACKSPACE_INSTALL_CHANNEL` is unset |
| `runtime.os` | `process.platform` |
| `runtime.arch` | `process.arch` |
| `runtime.node` | the Node major version |
| `installedAt` | `instance_settings.installed_at` as `YYYY-MM`. Month precision: the install date is a cohort, not an event |

**Rounding.** Every count in the payload goes through `roundTwoSignificant`
before it leaves the instance: values under 100 stay exact, 12345 becomes
12000. Small instances keep their real numbers, large ones lose the precision
that would make them recognisable. The receiver applies the same rule on
arrival, so an old or modified build cannot send round numbers past it.

**Never included.** The domain, the instance name, any user name, any e-mail
address, any message, any file name, any IP address, the federation
`instance_id` from `/api/instance/info`, and any timestamp finer than a
calendar day. The federation instance id is deliberately not reused as the
telemetry id: it is public and known to peers, so a ping carrying it would be
tied to a domain.

**Schema rules.** Adding a field is not a breaking change and does not bump
`schema`. Changing the meaning of an existing field does. The receiver keeps
fields it does not know and accepts `schema: 1` forever, so a server that never
updates keeps reporting something usable.

**The Cloudflare note.** The receiver runs on Cloudflare, which sees the source
address of every request the way any web host does and derives the country from
it. The Worker uses that address once, as the key of the rate limiter, and never
stores it; the country is stored. Cloudflare keeps its own request logs under
its own retention. This is stated on the receiver's own page and in the modal
that asks.

---

## 3. Opt-in state

Four columns on `instance_settings` (see [database.md](database.md)), owned by
`telemetry/state.ts` and by nothing else. The general settings PATCH does not
touch them.

| Column | Meaning |
|---|---|
| `telemetry_enabled` | `null` never asked, `0` off, `1` on |
| `telemetry_id` | the random UUID sent as `instance` |
| `telemetry_last_day` | the last UTC day successfully reported |
| `telemetry_last_error` | JSON `{ day, status }` of the last failed attempt, cleared on success |

`installed_at` on the same row is the first-boot timestamp. It is nullable
because SQLite cannot add a `NOT NULL` column without a default to an existing
table; `ensureDefaults` fills it on boot from the oldest local, non-deleted
user's `created_at`, or from the current time when there is none.

Transitions, all through `setTelemetryEnabled(sqlite, enabled, today)`:

| From | To | What happens |
|---|---|---|
| `null` or off | on | a fresh `crypto.randomUUID()` is minted, `telemetry_last_day` is set to today, the last error is cleared |
| on | on | nothing at all |
| any | off | the id, the last day and the last error are cleared |

The on-to-on case matters. Rotating the id on a repeated save would make one
instance look like two to the receiver and reset its two-days-in-thirty
qualification, and restamping the last day would skip that day's ping. A second
click in the admin panel and a re-run of `install.sh` with `TELEMETRY=on` both
take that path and both change nothing.

Setting the last day to today on the way in is what makes the first ping go out
tomorrow rather than within the minute. Turning off and on again mints a new id,
so as far as the receiver can tell that is a new anonymous instance.

**Backup restore is a known limit.** A database restored onto two machines
carries the same `telemetry_id`. The receiver upserts both onto one row per day,
so the pair counts as one instance. That is consistent with "lower bound" and is
not worked around.

---

## 4. Activity tracking

Two columns on `users`, the only per-person data this feature adds. Both are
local, both are day precision, and both are stored in the database only: no
endpoint returns them, no screen shows them, and nothing about a person is
derived from them beyond the rounded counts in section 2. Reading them means
opening the database file on the host.

| Column | Semantics |
|---|---|
| `last_active_day` | UTC day of the last authenticated WebSocket activity |
| `last_client` | `web`, `desktop` or `mobile`, from the `client` field of the WebSocket auth message. Anything missing or unrecognised stores `web` |

`touchUserActivity` writes the row only when the stored day is not already
today, so a user's row is touched at most once per day and the server never
learns at what time anyone was online. The write happens on WebSocket auth and
on every heartbeat pong: a desktop client left open for a week never
re-authenticates, and without the pong path it would look inactive.

`client` is sent to every origin the client connects to. A remote instance
stores it on the replicated row, which has `home_instance` set and is therefore
never counted. `mobile` means a small viewport at connect time, so a narrow
desktop browser window reports as mobile. See
[websocket.md](websocket.md) for the wire format.

---

## 5. The reporter

`reporterTick` runs at boot and then once a minute, started from
`packages/server/src/index.ts` next to `startFederationWorkers()` and under the
same `DISABLE_FEDERATION_WORKERS` guard, so a two-instance integration harness
runs no reporter. `stopTelemetryReporter()` sits beside `stopFederationWorkers()`
on shutdown.

A tick does nothing unless reporting is on, an id exists, today is not already
the last reported day, and the current minute of the UTC day has reached the
instance's slot.

**The slot** is `sha256(telemetry_id)` read as a 32-bit big-endian integer
modulo 1440, so instances spread evenly across the minutes of the day rather
than all arriving at midnight. The read is 32 bits rather than 16 because 65536
is not a multiple of 1440: a 16-bit read would lean the fleet about two percent
towards the hours before 12:16 UTC.

**One attempt per day.** An instance that was down at its slot sends on the next
boot, as long as that boot is still on the same UTC day. A day that already
recorded an error is not retried until tomorrow, so a receiver answering 500 is
not hit sixty times an hour. Building the payload happens inside the same guard:
a build that throws burns the day exactly like a request that fails, rather than
escaping the tick and being retried every minute.

The request is `POST <endpoint>/v1/ping`, JSON, `User-Agent:
backspace-server/<version>`, with a 10 second `AbortSignal.timeout`. Outcomes:

| Result | What the instance does |
|---|---|
| 2xx | `telemetry_last_day = day`, the last error is cleared |
| 410 | reporting is switched off and the id is cleared, with one info-level log line saying the service was retired |
| any other status | `telemetry_last_error = { day, status }`, a debug log line, retry tomorrow and never sooner |
| a thrown request (network failure, timeout) | the same as any other status, recorded as status `0` |

Neither the payload nor the receiver's answer is ever logged. The state is read
again after the request resolves: an admin can switch reporting off, or off and
on again, while a ping is in flight, and the bookkeeping fields belong to
whichever id is current. A row that changed underneath the request keeps what
the transition left it.

`TELEMETRY_ENDPOINT` overrides the receiver base URL, default
`https://hello.backspacechat.com`. It exists for tests, for pointing an instance
at a local `wrangler dev`, and for a future move of the service. It is the only
telemetry environment variable the server itself reads.

---

## 6. Admin routes

`packages/server/src/routes/adminTelemetry.ts`, all three behind
`[authenticate, requireAdmin]`, all three on the home origin only.

```
GET /api/admin/telemetry          → TelemetryStatus
PUT /api/admin/telemetry          { enabled: boolean } → TelemetryStatus
GET /api/admin/telemetry/preview  → TelemetryPayload
```

`TelemetryStatus` is `{ enabled: boolean | null, id: string | null, lastDay:
string | null, lastError: { day, status } | null }`, read straight off the four
columns.

`PUT` requires `enabled` to be a boolean and answers `400 validation_failed`
through `sendError` for anything else, including the string `"yes"` and the
number `1`. It then runs the transition in §3, which is a no-op when the
instance is already on.

`GET /preview` builds the real payload with the same `buildTelemetryPayload` the
reporter uses, so the modal and the settings panel can never show a document
different from the one that would be sent. While reporting is off there is no
id, and minting one to render a preview would opt the instance in by opening a
dialog: the literal string `preview` stands in as `instance` instead. The route
writes nothing in either state.

The panel lives in Instance settings under "Say hi to Jannis", with the toggle,
the last reported day, the last error if there is one, the masked id and the
live preview. See [admin.md](admin.md).

---

## 7. The ask

An admin signed in on their home instance sees a one-time modal while
`GET /api/admin/telemetry` returns `enabled: null`. It is never shown to
non-admins, and never on a remote instance reached through a federated account.

Snoozing means "Decide later", Escape, or a click on the scrim: nothing is saved
on the server, a timestamp goes into that browser's local storage, and the modal
stays away for 7 days. After the second dismissal it stays away for good in that
browser. The settings section remains either way, so nothing is unreachable.

Any answer by any admin ends the ask for everyone, because the setting belongs
to the instance rather than to the person answering. Both buttons are the same
size and weight, "no" saves first and costs nothing, and the preview shown in
the modal is the real payload from the preview route. Copy lives under the
`telemetry` namespace, see [localization.md](localization.md).

---

## 8. The receiver

`scripts/telemetry-receiver/`, a Cloudflare Worker with a D1 database, served at
`hello.backspacechat.com` as a custom domain. It is a workspace package and is
not copied into the Docker image. It has no runtime dependencies, which a test
enforces.

`wrangler.toml` pins `compatibility_date` to the newest date the workerd bundled
with the installed `@cloudflare/vitest-pool-workers` supports. A later date
makes the test runtime refuse to start, so that pin moves only together with the
dev dependency.

Routes:

| Route | Behaviour |
|---|---|
| `POST /v1/ping` | reads the body with `request.text()` and rejects anything over 4096 bytes after reading, whatever `Content-Length` claimed. Validates `schema`, `instance` as a version 4 UUID, `day` as a real calendar day within two days of the receiver's own UTC date, `build.version` (if present) as at most 32 characters of `[0-9A-Za-z.+-]`, and every known count as a non-negative integer no larger than 10^9. Known counts are rounded to two significant digits on arrival, unknown fields are kept. Upserts on `(instance, day)`, so a later ping for the same day replaces the earlier row. `204` on success, `400` on anything invalid, `429` when the rate limiter refuses the source address, all three without a body. `410` for every ping while the `RETIRED` variable is `"1"`, checked before the rate limiter so a retirement is never itself rate limited |
| `GET /v1/export?from=&to=` | requires `Authorization: Bearer <EXPORT_TOKEN>`, compared with `crypto.subtle.timingSafeEqual`. Returns NDJSON, one `{ instance, day, receivedAt, country, schema, body }` per line, at most 31 days per call. `401` without the token, `400` for a bad range |
| `GET /` | a static plain HTML page saying what the endpoint is, what a row holds, how long it is kept and what Cloudflare sees, with links to this document and to the source. No scripts, no fonts, no third-party requests |
| anything else | `404` |

A rate-limit binding keyed on the source address (10 requests per 10 seconds) is
declared in `wrangler.toml`, so the limit is versioned with the code rather than
living in a dashboard rule.

`country` comes from `request.cf?.country`; `undefined`, `null`, `XX` and `T1`
all store as `ZZ`.

**Retention is 90 days.** A daily scheduled trigger deletes every row whose
`day` is older than that. Ninety days covers the 30-day windows the collector
needs with room to re-run a broken collection, and it is short enough that no
lifetime profile accumulates against an id.

### Deploying it

`.github/workflows/telemetry-receiver.yml` has two jobs. `test` runs the
typecheck and the Workers test suite on every push to `main` and every pull
request that touches `scripts/telemetry-receiver/**` or the workflow file, and
holds no secrets. `deploy` runs only when Jannis dispatches the workflow by hand
from `main`. It applies the migration files committed under
`scripts/telemetry-receiver/migrations` to the live database and only then
publishes the Worker, so the schema is never behind the code that reads it, and
it provisions nothing of its own. A merge never deploys the receiver.

The deploy job creates nothing. Four things are set up once, by hand, and then
stay put:

1. `wrangler d1 create backspace-telemetry` from `scripts/telemetry-receiver`.
   It prints a `database_id`, which replaces the
   `REPLACE-AFTER-wrangler-d1-create` placeholder in `wrangler.toml`. That value
   is not a secret and is committed.
2. `wrangler secret put EXPORT_TOKEN`, a random string. It is the bearer token
   `GET /v1/export` checks. Until it is set the Worker exports nothing, which is
   the safe way round for a Worker deployed before its secret.
3. The same token as the `TELEMETRY_EXPORT_TOKEN` repository secret, which is
   what the metrics collector reads. Unset, the collector skips the telemetry
   step and collects traffic normally, so the two can be wired up in either
   order.
4. `hello.backspacechat.com` attached to the Worker as a custom domain. The zone
   is already on the same Cloudflare account. The binding is declared in
   `wrangler.toml` under `routes`, and it is attached by the first deploy, which
   is run by hand from a workstation: it is the deploy that takes over a
   hostname and can ask for confirmation, and a step that may prompt does not
   belong in a job with no terminal. Every deploy after that is the workflow.

Two more secrets drive the deploy job itself: `CLOUDFLARE_API_TOKEN`, scoped to
editing Workers and D1 on that account and nothing else, and
`CLOUDFLARE_ACCOUNT_ID`. Both live on the `telemetry-receiver` GitHub
environment rather than at repository level, so no other job can read them.

**Retiring the service.** `RETIRED` is a plain `[vars]` entry in `wrangler.toml`,
not a secret. Setting it to `"1"` and deploying makes every ping answer `410`,
which instances read as "switch telemetry off and clear the id" rather than as a
failure to retry. That is the shutdown path: flip the variable, deploy, and the
fleet stops on its own within a day.

---

## 9. How the numbers become public

The collector in `scripts/metrics` pulls the export once a day and writes
aggregates to the `metrics-data` branch under `telemetry/`. Per-instance rows
never leave the receiver. See [metrics.md](metrics.md) for the schemas, the
snapshot rule, the two-days-in-thirty eligibility test and the small-N folding
that replaces any dimension value held by fewer than three instances with
`other`.

**Every published figure is self-reported by instances that opted in**, so it is
a lower bound twice over: nothing is counted from an instance that never
switched the ping on, and an instance that switched it on counts only after it
reported on two distinct days in the trailing thirty. It is an upper bound only
in the weak sense that nothing beyond the per-value cap and that eligibility
rule filters what an instance claims about itself. These are the numbers the
fleet volunteered, not a measurement of how many people run Backspace, and no
page should present them as one.

Everything collected is published from the first day it is collected, as static
tables under `/insights/data/`. Those tables are the public surface today. The
charted section of the insights page comes with the facelift of that page, in a
later track, and it will stay hidden until the latest 7-day instance count
reaches 10, because a chart of three instances says more about those three
instances than about the project.

---

## 10. Environment variables

| Variable | Read by | Meaning |
|---|---|---|
| `TELEMETRY_ENDPOINT` | the server, and the metrics collector | receiver base URL, default `https://hello.backspacechat.com`. Point it at a local `wrangler dev` to test end to end |
| `TELEMETRY` | `install.sh` only | `on` or `off` runs the same transition the admin route runs, written into the running container after the health check the same way the instance name is. Any other value leaves the setting untouched, and an interactive install never asks |
| `TELEMETRY_EXPORT_TOKEN` | the metrics collector | the receiver's export bearer token. Unset, the telemetry collection step is skipped and the traffic collection runs normally |

The server reads no telemetry environment variable other than the endpoint. The
opt-in state lives in the database and nowhere else.
