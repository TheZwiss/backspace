# Instance telemetry ("Say hi to Jannis") design

Date: 2026-09-06
Status: approved in conversation, revised after review, awaiting written sign-off

## 1. Purpose

Backspace tracks nobody, so the maintainer has no idea whether anyone runs it. This design adds an opt-in, per-instance daily report ("ping") that an admin can switch on to tell the maintainer that the instance exists and roughly how big it is. The numbers are aggregated and published on the project's insights page so that admins see exactly what the maintainer sees.

Goals:

- A verifiable lower bound on real-world use: instances, active users, versions, countries, client kinds.
- Zero cost to anyone who does not opt in. Nothing is sent, nothing is fetched, and the ask stops after two dismissals a week apart or one answer.
- Nothing about a person or a domain ever leaves an instance. Rounded counts and flags only.
- Every piece replaceable: the receiver, the storage, the dashboard. The only fixed point is the hostname.

Non-goals:

- Client-side telemetry of any kind. Web, desktop and mobile clients never report anything.
- Crash reporting, error reporting, performance data.
- Any per-user data at the receiver.

## 2. Components and data flow

```
instance (server reporter, daily) --POST--> hello.backspacechat.com (Cloudflare Worker + D1, raw rows, 90 days)
                                                     |
                                                     v  GET /v1/export?from=&to= (bearer)
                                         GitHub Actions metrics workflow (daily, stateless)
                                                     |
                                                     v  upsert aggregates
                                            metrics-data branch (git, forever)
                                                     |
                                                     v  bundler
                                         site/insights (dashboard + data tables)
```

Per-instance rows exist only in the receiver's private database and are deleted after 90 days. The git archive and the dashboard hold aggregates only, with small dimension values folded into "other".

Sequencing: the reporter, receiver and collector ship first so numbers accumulate. The machine-readable tables under `/insights/data/` and the files on `metrics-data` are public from the first collected day. The dashboard charts land after the separate insights facelift (own spec) and stay hidden until the 7-day instance count reaches 10.

## 3. Opt-in state (server)

New columns on `instance_settings`:

| Column | Type | Meaning |
|---|---|---|
| `telemetry_enabled` | integer, nullable | `null` never asked, `0` off, `1` on |
| `telemetry_id` | text, nullable | random UUID v4 (`crypto.randomUUID()`), minted on every off-to-on transition, cleared on every transition to off (admin, `TELEMETRY=off`, or a 410 from the receiver) |
| `telemetry_last_day` | text, nullable | last `day` (UTC, `YYYY-MM-DD`) successfully reported; set to today on every off-to-on transition so the first ping goes out the next day |
| `telemetry_last_error` | text, nullable | JSON `{ day, status }` of the last failed attempt, cleared on success |
| `installed_at` | integer, nullable | first-boot timestamp; backfilled in `ensureDefaults` from the oldest local, non-deleted user's `created_at`, or now if there is none |

`installed_at` is nullable because SQLite cannot add a NOT NULL column without a default to an existing table; `ensureDefaults` guarantees it is set after boot, the same way it guarantees the federation epoch.

The federation instance id (`instance_settings.instance_id`) is never used for telemetry. It is public on `/api/instance/info` and known to peers, so it would link pings to a domain.

Resolution: the setting lives in the database only. `TELEMETRY=on|off` in the environment is read once by install.sh (§10) and written into the database the same way the instance name is; the server itself reads no telemetry environment variable except the endpoint override.

Backup restore: a database restored onto two machines carries the same `telemetry_id`; the receiver upserts both onto one row per day and the pair counts as one instance. Documented as a known limit, in keeping with "lower bound".

## 4. Activity tracking (server)

Two new columns on `users`, the only per-person data this feature adds, both local, both admin-visible:

| Column | Type | Semantics |
|---|---|---|
| `last_active_day` | text, nullable | UTC day (`YYYY-MM-DD`) of the last authenticated WebSocket activity. Written on auth and on every heartbeat pong, guarded so the write is skipped when the stored value already equals today. |
| `last_client` | text, nullable | `web`, `desktop` or `mobile`, from a `client` field the web app sends in the WebSocket auth message. Missing or unknown values store `web`. |

Day precision is deliberate: the server can say "was here on this date", never at what time. The pong path matters because a desktop client left open for days never re-authenticates.

The client sends `client` in the existing `{ type: 'auth', token }` message. Desktop is the Electron bridge check, mobile is the responsive breakpoint at connect time (so a narrow desktop browser reports `mobile`; documented as "small viewport"), web otherwise. The field goes to every connected origin; remote instances store it on federated-account rows, which have `home_instance` set and are never counted. The WebSocket protocol doc gains the field.

## 5. Payload

One JSON document per instance per UTC day, `schema: 1`:

```json
{
  "schema": 1,
  "instance": "3f6c9e2a-…",
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

Field semantics, fixed for `schema: 1`:

| Field | Definition |
|---|---|
| `instance` | `telemetry_id` |
| `day` | the UTC day the report describes, from the instance clock |
| `build.version` | server package version |
| `build.commit` | `config.commit` short SHA or `null` |
| `build.modified` | `true` when `config.sourceCodeUrl` differs from `UPSTREAM_SOURCE_URL` |
| `users.registered` | users with `home_instance IS NULL` and `is_deleted = 0` |
| `users.active1d/7d/30d` | registered users whose `last_active_day` is within the last 1, 7, 30 days including `day` |
| `clients.*` | `active7d` users grouped by `last_client`; `null` counts as `web` |
| `content.spaces` | rows in `spaces` |
| `content.channels` | rows in `channels`, all types including voice; DM channels live in their own table and are not counted |
| `content.messages` | rows in `messages` (space messages; DM messages are in `dm_messages` and are not counted) |
| `content.messages7d` | `messages` with `created_at` in the last 7 days |
| `content.storageMiB` | sum of `attachments.size` for locally uploaded files (`source_url IS NULL`), in MiB |
| `features.voice` | `config.livekit.url`, `apiKey` and `apiSecret` all set |
| `features.federation` | `instance_settings.federation_relay_enabled = 1` and `config.domain` set |
| `features.peers` | `federation_peers` rows with status `active` |
| `features.registrationOpen` | effective value after the database override |
| `runtime.install` | `config.updates.installChannel`: `prebuilt`, `source`, or `null` |
| `runtime.os` | `process.platform` |
| `runtime.arch` | `process.arch` |
| `runtime.node` | Node major version |
| `installedAt` | `installed_at` as `YYYY-MM` |

Rounding: every count in the payload is rounded to two significant digits before sending (7 stays 7, 42 stays 42, 12345 becomes 12000). Small instances stay exact, large ones lose the precision that would make them recognisable. The receiver enforces the same rounding on arrival so an old or modified build cannot bypass it.

Rules:

- Adding a field is a non-breaking change and does not bump `schema`. Changing the meaning of a field bumps `schema`.
- The receiver keeps unknown fields. Old server versions keep reporting `schema: 1` for years and the receiver accepts them forever.
- Never included: domain, instance name, user names, e-mail addresses, message content, file names, IP addresses, the federation instance id, timestamps finer than the day.

Cloudflare, as the receiver's host, sees the source address of every ping like any web host, uses it to derive the country, and keeps its own request logs under its own retention. The Worker uses it only as a rate-limit key and never stores it. This is stated in the docs and in the modal.

## 6. Reporter (server)

Module `packages/server/src/telemetry/`:

- `payload.ts`: `buildTelemetryPayload(db, config, now)` returns the document above, rounding included. Pure, tested against a seeded database.
- `reporter.ts`: the daily job.
  - Runs only when `telemetry_enabled = 1`.
  - Slot: minute of day derived from `telemetry_id` (hash mod 1440), so instances spread across the day.
  - On boot and once per minute the job checks: if today's `day` differs from `telemetry_last_day` and the current time is past the slot, send. An instance that was down at its slot sends on the next boot.
  - Sends `POST <endpoint>/v1/ping`, JSON, 10 s timeout via `AbortSignal.timeout`, `User-Agent: backspace-server/<version>`.
  - 2xx: `telemetry_last_day = day`, `telemetry_last_error = null`. 410: transition to off (clears the id) and log once at info level that the service has been retired. Any other failure: `telemetry_last_error = { day, status }`, debug log, retry next day, never sooner.
  - `TELEMETRY_ENDPOINT` in config, default `https://hello.backspacechat.com`, for tests and for a future move.
- Started next to `startFederationWorkers()` in the server entrypoint; disabled in tests the same way the federation workers are.

Admin endpoints (admin only, home origin only):

| Route | Purpose |
|---|---|
| `GET /api/admin/telemetry` | `{ enabled: boolean \| null, lastDay: string \| null, lastError: { day, status } \| null, id: string \| null }` |
| `PUT /api/admin/telemetry` | body `{ enabled: boolean }`; runs the on/off transition, returns the same shape |
| `GET /api/admin/telemetry/preview` | the exact payload that would be sent now |

The general settings PATCH does not touch telemetry; the dedicated route keeps the id lifecycle in one place.

## 7. Receiver

Package `scripts/telemetry-receiver/` (pnpm workspace, added to `pnpm-workspace.yaml` like `scripts/metrics`; not copied into the Docker image). TypeScript, Cloudflare Worker. Dev dependencies: `wrangler`, `@cloudflare/workers-types`, `@cloudflare/vitest-pool-workers` at 0.13 or later (the first line that supports Vitest 4, configured through the `cloudflareTest()` Vite plugin). No runtime dependencies, enforced by a test like the one in `scripts/metrics`.

Routes:

- `POST /v1/ping`: reads the body with `request.text()` and rejects anything over 4096 bytes after reading, regardless of `Content-Length`. Validation: `schema` integer ≥ 1, `instance` matches UUID v4, `day` matches `YYYY-MM-DD` and lies within ±2 days of the receiver's UTC date, every known numeric field is a non-negative integer below 10^9. Known counts are rounded to two significant digits on arrival. Unknown fields are kept. Upsert on `(instance, day)` with `INSERT ... ON CONFLICT(instance, day) DO UPDATE SET ... = excluded....`; a later ping for the same day replaces the earlier row. Response 204, no body. Invalid: 400, no body. When the `RETIRED` variable is `"1"`: 410 for every ping. A Workers rate-limit binding (keyed on the source address, 10 requests per 10 seconds) is declared in `wrangler.toml` so the limit is versioned with the code; the Free plan's single WAF rule is not relied on.
- `GET /v1/export?from=YYYY-MM-DD&to=YYYY-MM-DD`: requires `Authorization: Bearer <EXPORT_TOKEN>`, compared with `crypto.subtle.timingSafeEqual`. Returns the rows with `day` in the inclusive range as NDJSON, one `{ instance, day, receivedAt, country, schema, body }` per line, at most 31 days per call. 401 without the token, 400 for a bad range.
- `GET /`: static plain HTML: what this endpoint is, what a row contains, the 90-day retention, the Cloudflare note, links to the docs and the source.
- Anything else: 404.

D1 table:

```sql
CREATE TABLE pings (
  instance    TEXT NOT NULL,
  day         TEXT NOT NULL,
  received_at TEXT NOT NULL,
  country     TEXT NOT NULL,
  schema      INTEGER NOT NULL,
  body        TEXT NOT NULL,
  PRIMARY KEY (instance, day)
);
CREATE INDEX pings_day ON pings (day);
```

`country` comes from `request.cf?.country`; `undefined`, `null`, `XX` and `T1` are stored as `ZZ` (unknown). Tests inject `cf: { country }` through `RequestInit`. The Worker reads the source address for one purpose, as the key of the rate-limit binding, and never stores it; it reads no header other than content type and the bearer token.

Retention: a scheduled trigger deletes rows with `day` older than 90 days, daily. Ninety days covers the 30-day windows with room to re-run a broken collector; it does not build a lifetime profile per id.

Deployment: `.github/workflows/telemetry-receiver.yml`, SHA-pinned actions per repo policy, guarded with `if: !github.event.repository.fork`, runs the tests on every change under the package and on pushes to `main` runs `wrangler d1 migrations apply --remote` followed by `wrangler deploy`, using the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets. `database_id` lives in `wrangler.toml`. `EXPORT_TOKEN` is a Worker secret set once by hand and mirrored as a repository secret for the collector. `hello.backspacechat.com` is a custom domain on the zone, not a `workers.dev` name.

## 8. Collector and archive

`scripts/metrics` gains a telemetry step in the daily collection; the collector stays stateless:

- Fetches `export` for the 30 days ending yesterday, with the mirrored token. A missing token skips the step with a logged notice, so the traffic collection never fails because of telemetry. `backfill.yml` can re-pull any day still inside the receiver's retention, write-if-absent.
- Snapshot definition for day D: the latest row per instance with `day` in `[D-6, D]`, restricted to instances that have reported on at least two distinct days in `[D-29, D]`. Instances that missed a day keep their last values for up to a week; a one-off fake instance never counts.
- `active1d` is summed only over rows with `day = D`; every other user figure is summed over the snapshot. Per-row values are capped at 10^9 before summing.
- Writes, upsert by `date`, in `telemetry/` on the `metrics-data` branch, using the existing shapes:
  - `network.csv` (date-keyed, `upsertByDate`): `date, instances_1d, instances_7d, instances_30d, users_registered, users_active1d, users_active7d, users_active30d, messages7d, storage_mib, voice_instances, federation_instances`
  - `versions.ndjson`, `countries.ndjson`, `clients.ndjson` (dimensional rows, `upsertDimensional`): `{ snapshot_date, dimension, title, count, uniques }` with `dimension` the version, country code or client kind, `title` empty, `count` the instance (or user) figure and `uniques` equal to it.
- Small-N folding: any dimension value with fewer than 3 instances on a day is folded into `other` before writing. Nothing in the public archive names a value held by one or two instances.
- The bundler adds a `telemetry` block to `data.json`: `network` downsampled weekly by taking the last value in each bucket (they are gauges, not sums), the three dimension series as their latest day only, inside the 2 MB budget. The block carries `instances7d` of the latest day so the page can apply the threshold without extra logic. The bucketing rule is recorded in `docs/systems/metrics.md`.

Machine-readable tables under `/insights/data/` gain the four series from the first collected day.

## 9. Dashboard

Deferred to the insights facelift. Contract: render the telemetry charts only when the latest `instances_7d ≥ 10`; label the section "opt-in numbers, lower bound"; charts for instances over time, active users, version spread, countries, client kinds.

## 10. install.sh

- Reads `TELEMETRY` from the environment. `on` or `off` runs the same transition the admin route runs (id minted and `telemetry_last_day` set to today for `on`; id cleared for `off`), written into the running container after the health check, the same way the instance name is written. Any other value leaves the setting untouched.
- Interactive runs do not ask. After the summary, two lines in character that say what is coming: "One more thing waits after your first login: a small, optional usage ping, and a note from me about why. It is off until you say otherwise."

## 11. The ask (web)

Trigger: an admin's session on the home instance while `GET /api/admin/telemetry` returns `enabled: null`. Never shown for remote instances reached through federated accounts; the settings section also talks to the home origin only. Never shown to non-admins.

Snooze: "Decide later", Escape and a click on the scrim all do the same thing: nothing is saved on the server, a timestamp goes into that browser's local storage, and the modal stays away for 7 days. After the second dismissal it stays away for good in that browser; the settings section remains. Any answer by any admin ends the ask for everyone, because the setting is per instance.

Permanent home: Instance settings, section "Say hi to Jannis", with the toggle, the last reported day, the last error if any, the id (masked), and the live preview JSON.

Layout: `.glass-modal` on a `bg-black/50` scrim, mobile-shell aware. Left or top, the scene; right or below, the text. Two buttons of identical size and weight.

States:

1. **Ask.** Scene idle: stars drifting, the ship floating, the figure in the window waving on a loop.
2. **Yes.** Setting saved first. Ship window lights up, a signal beam leaves the ship, a few stars pulse. Copy below. One button: Close.
3. **No.** Setting saved first. The ship keeps floating, the pilot gives a small wave goodbye, the lights stay on. Copy below. One button: Close, same behaviour as after yes. Nothing fades on its own.

Copy, English source, keys under a new `telemetry` namespace registered in `packages/web/src/i18n/resources.ts` and the i18n consistency check, translated to German and Russian:

- Title: "Hi. It's Jannis. I built this."
- Body:
  "Backspace tracks nobody, and that includes me. No numbers, no dashboards, nothing. I can see the download counter, and then it goes quiet. Building this feels like shouting into space and never hearing anything back.
  So this is me asking. Once a day, would your instance send me a tiny hello? Not who you are, not what anyone said. Just rounded counts: how many people are here, which version runs, whether voice and federation are on, and which country the hello came from. No names, no messages, no address of any kind.
  Here is exactly what it would say today:"
- Preview: collapsible, the real JSON from the preview endpoint.
- Closing line: "Everything that comes back is published as open data on the project's insights page, and charts appear once at least ten instances say hi. It stays off until you say yes, and you can turn it off again whenever you like."
- Footnote under the buttons: "The receiver runs on Cloudflare, which sees the request like any web host and derives the country from it. Nothing else about you is stored. You can change this any time under Instance settings."
- Buttons: "Say hi", "No thanks". Text link: "Decide later".
- Yes: "Signal acquired. The first hello goes out tomorrow at a random minute, and every day after. Thank you. It is a lot less quiet out here now."
- No: "Understood. Nothing will be sent. I'll drift on, and if you ever change your mind, I'm one toggle away in Instance settings."

Rules: both buttons equal, "no" costs nothing and looks like nothing, the preview is the real payload, `prefers-reduced-motion` turns every animation into a cross-fade, keyboard and screen-reader accessible (the scene is `aria-hidden`, the copy is the accessible content).

## 12. Illustration approach

- Inline SVG as React components under `packages/web/src/components/telemetry/scene/`: `Void` (starfield, faint nebula in Aether Drift pastels), `Ship` (mint and lavender hull, one window), `Pilot` (the waving figure), `Beam`. Composed by `HelloScene` with a `mood` prop: `idle`, `happy`, `farewell`.
- One 480 by 320 viewBox. Every layer is a `<g data-layer="...">` so animations target layers by name.
- Colours from design tokens, never hard-coded outside a palette object.
- Choreography with the Web Animations API, ambient loops with CSS keyframes, only transform and opacity animate, one reduced-motion check in the scene root.
- No new dependencies. No raster, no Lottie.
- Render loop for iteration: `packages/web/scripts/render-frames.mjs` bundles an entry that exports `mount(root, mood)`, loads it in the installed Electron, freezes every animation at the requested timestamps, captures one PNG per frame and composes a labelled contact sheet. Every iteration on the scene ends with a rendered contact sheet inspected against `Backspace-design-prototype.html`.

## 13. Documentation

- New `docs/systems/telemetry.md`: purpose, the opt-in state model, the schema with field semantics and rounding, what is never sent, the Cloudflare note, the receiver contract, the 90-day retention, the snapshot and folding rules, the publication threshold, the backup-restore limit.
- `docs/systems/database.md`: new columns.
- `docs/systems/api.md`: admin telemetry routes.
- `docs/systems/websocket.md`: the `client` field.
- `docs/systems/admin.md`: the settings section.
- `docs/systems/metrics.md`: the telemetry series, the bundle block and its bucketing rule.
- `docs/systems/localization.md`: the `telemetry` namespace.
- `docs/systems/security-scanning.md`: the receiver workflow in the pinned-actions inventory.
- README: one paragraph under privacy, linking the doc.

## 14. Testing

- Server: payload builder against seeded databases (locality, deletion, windows, client grouping, rounding, DM exclusion, local-only storage); reporter slot, day change, first-ping-tomorrow after enable, 410 transition, error recording, endpoint override; admin routes and id lifecycle; `ensureDefaults` backfill of `installed_at`; `last_active_day` write-once-per-day on auth and pong; `client` parsing on auth.
- Receiver: validation matrix including oversized bodies without a length header, rounding on arrival, numeric caps, upsert semantics, country mapping, export auth and range limits, retired mode, retention trigger, root page. Run in the Workers vitest pool with injected `cf`.
- Collector: snapshot definition with gaps and the two-days rule, `active1d` restriction, folding, upserts onto the existing shapes, missing-token skip, backfill write-if-absent, bundle block, bucketing and budget.
- Web: modal shows once for home-instance admins with `enabled: null` only, snooze and second-dismissal logic, saves before animating, both outcomes, reduced motion, settings section, preview rendering. Scene components render without throwing.
- Manual: `pnpm dev`, opt in, call the preview, confirm a ping reaches a local receiver started with `wrangler dev`.

## 15. Work split

Isolated pieces, each a subagent with a precise brief:

1. Receiver package, workflow, tests.
2. Server side: columns and `ensureDefaults` backfill, activity tracking, payload builder, reporter, admin routes, tests, docs.
3. Collector extension and bundle block, tests, docs.
4. Scene and modal: the illustration, the animations, the modal states, from final copy; render loop mandatory.
5. Insights facelift (separate spec, before piece 6).
6. Dashboard section, after 5.

In the main session: this spec, the plan, copy sign-off, the locale catalogs, install.sh, README, review and integration of every piece.

## 16. Rollout

- The receiver is deployed before the server release is tagged, with `RETIRED` unset, the rate-limit binding in place, and the custom domain attached.
- The server pieces ship in a minor release with the ask. Instances that update see the modal on the next admin login.
- The collector step is enabled once the receiver has real rows.
- The dashboard charts follow the facelift and appear on their own once the threshold is met.
