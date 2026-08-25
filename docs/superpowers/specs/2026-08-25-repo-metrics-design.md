# Repository Metrics & Insights Archive — Design

**Date:** 2026-08-25
**Status:** Draft v2 (revised after technical + design review); pending user review
**Author:** Lead Developer (Backspace)

---

## 1. Motivation

GitHub's Insights → Traffic panel discards data after 14 days. For a project
actively courting self-hosters, that window is too short to answer the questions
that matter: did the federation write-up move the needle, did the v1 release
change clone volume, is organic search growing or flat, which docs page do people
read before deciding to deploy.

Once a day falls out of the window it is gone permanently. GitHub does not retain
it server-side and no API can reconstruct it. **Every day without a collector is
a day of history destroyed.**

### What is actually at risk

Most of Insights is not ephemeral. Only two things need capturing:

| Data | Retention | Action |
|---|---|---|
| Traffic: views, clones, referrers, popular paths | **14 days, then destroyed** | **Snapshot daily** |
| Release asset download counts | Live cumulative total, no time series | **Snapshot daily** |
| Stars | Permanent — `/stargazers` returns `starred_at` | Backfill once |
| Forks | Permanent — `created_at` | Backfill once |
| Issues, PRs | Permanent — timestamped | Backfill once |
| Releases | Permanent — `published_at` | Backfill once |
| Contributors | Permanent — `/stats/contributors` | Backfill once |

Commits and code-frequency are also permanent, but nothing in the v1 dashboard
(§7) consumes them, so they are not collected. See §2 non-goals.

### Current state (measured live, 2026-08-25)

- Repo created `2026-02-18T01:49:31Z` — roughly six months of backfillable history.
- 56 stars, 3 forks, **1 watcher** (`subscribers_count`; see §5.6), 13 open
  issues, 1 release with 22 assets.
- Trailing 14 days: 655 views / 189 unique visitors.
- `deploy-pages.yml` already publishes `site/` to GitHub Pages, so a dashboard
  has a delivery mechanism already built.

---

## 2. Goals & Non-Goals

### Goals

1. Capture every ephemeral metric daily, starting as soon as this ships, retained
   indefinitely.
2. Backfill all reconstructable history so the dashboard opens with the repo's
   full life rather than an empty axis.
3. Publish a single public URL rendering the archive with real interactivity —
   zoom, cross-chart cursor, range presets — styled as part of the existing site.
4. Zero infrastructure, zero recurring cost, zero third-party data custody. The
   archive must outlive any vendor.
5. Data stored in a format that is diffable, hand-recoverable, and independently
   useful without the dashboard.
6. Idempotent and self-healing: a missed run, a duplicate run, or a re-run must
   never corrupt or duplicate data.

### Non-Goals

- **Per-day referrer or path resolution.** The API returns a single 14-day
  aggregate, top 10 only, with no per-day breakdown (verified live). Not
  obtainable by any means. See §5.3.
- **Backfilling traffic.** Impossible. Whatever is in today's window is the
  oldest traffic data this project will ever have.
- **Issue/PR health, release-download breakdown, and commit-activity charts.**
  Deferred from v1. These were cut deliberately: they are the sections whose
  underlying data is either unavailable without extra endpoints that return 202
  (§3.7) or unused by any question in §1. Revisit once the archive has a year of
  data and there is something to see.
- **Multi-repo support.** Only `TheZwiss/backspace` has meaningful activity. The
  repo slug is read from `github.repository`, so the workflow is not hardcoded,
  but no multi-repo file layout or comparison UI exists.
- **Real-time or sub-daily collection.** Traffic updates daily upstream.
- **Alerting.** No thresholds, no notifications. An archive and a dashboard.
- **Private analytics tiers.** The dashboard and the raw data branch are both
  fully public, by explicit decision.

---

## 3. Key Decisions & Rationale

### 3.1 Git scraping over a database or SaaS

Storing API snapshots as text committed to git on a schedule is the established
pattern for this problem. It gives versioning, indefinite retention,
auditability, and disaster recovery for free, at zero cost and zero operational
burden. Alternatives considered and rejected:

- **Hosted SaaS (Repohistory and similar):** requires granting a third party a
  token with repo administration scope, places custody of the data outside the
  project, and ties retention to that vendor's survival. Contradicts Goal 4 and
  sits badly with a project whose pitch is self-hosting.
- **Self-hosted Prometheus + Grafana on the Pi/VM:** correct at organisation
  scale, but it is real infrastructure to run, monitor, back up, and patch,
  sitting alongside the production Backspace instances. Disproportionate for one
  repo.

### 3.2 Plain text over SQLite

Committed SQLite would allow arbitrary SQL in the browser via `sql.js`. Rejected
because git stores a **complete new copy of a binary file on every commit**. A
daily-committed database grows without bound and yields no readable diffs.

At the measured volume — ~800 KB/year, ~8 MB/decade (§5.5) — plain text produces
a one-line-per-day diff that can be audited or repaired by hand and stays useful
in any tool that reads CSV.

- **CSV** for dense date-keyed series (one row per date).
- **NDJSON** for dimensional data with multiple rows per date.

### 3.3 Orphan data branch, with the same protection as the CLA branch

Daily commits to `main` would add ~365 noise commits per year and, without path
filtering, trigger CI on every one. An orphan `metrics-data` branch isolates
them, mirroring the pattern `cla.yml` already established for CLA signatures.

That precedent carries a second, load-bearing half the first draft omitted:
`cla-signatures` has a live ruleset (`deletion`, `non_fast_forward`, zero bypass
actors) so the record cannot be rewritten. `metrics-data` **must get the matching
ruleset** — it would otherwise be the one branch in this repo holding genuinely
irreplaceable data with no deletion or force-push protection, while the
reconstructable CLA record is locked down. Tracked in §11 and §12.

Note the ruleset must **not** require PRs or status checks: the collector commits
directly, which is the exact failure mode `cla.yml`'s header comment documents.

Caveat worth stating: the orphan branch isolates history noise from `main`, but
`git clone` fetches all branches, so contributors still download the archive.
At 8 MB/decade this is acceptable.

### 3.4 uPlot for time series, hand-rolled CSS/SVG for the rest

Most v1 charts are time series. uPlot is ~45 KB, renders to canvas, and provides
drag-to-zoom plus a cursor synchronised across stacked charts — the feature that
makes a dense dashboard readable rather than a wall of graphs. It is themeable,
so it takes Aether Drift colours cleanly.

ECharts (~1 MB) was rejected: its advantage is exotic chart types, but for
referrer and path data a ranked bar list is more legible than a treemap, and
those are ~30 lines of CSS matching the design system better than any library
default. Hand-rolling everything was rejected because synchronised cursors,
brush-to-zoom, and range selection are where the real work and the real bugs are.

### 3.5 Vendored, but dependency-tracked

`site/index.html` loads **zero** third-party assets (verified: 10 absolute URLs,
all navigation). Preserving that means no visitor IP leaks to a third party, no
CDN supply-chain surface inside the page origin, and no external point of
failure. It would also be incoherent to SHA-pin every CI action and then pull
unpinned JavaScript from a CDN at runtime.

But a hand-copied vendored file rots silently — no scanner sees it, no Dependabot
PR updates it. Resolution:

- `uplot` is a `devDependency` of `@backspace/metrics`, so Dependabot (whose npm
  entry at `/` already covers new workspaces) and OSV-Scanner track it normally.
- `vendor:sync` copies it from `node_modules` into `site/insights/assets/`.
- `vendor:check` asserts the committed copy matches byte-for-byte.

`vendor:check` runs **inside the package's `test` script**, not as a separate CI
step — see §3.6. A Dependabot bump then fails `pnpm -r test` until `vendor:sync`
is re-run, which is the desired forcing function.

### 3.6 CI wiring: fold everything into `test`

The first draft claimed the workspace addition meant "CI covers it with no
workflow change." **That was false.** `ci.yml` runs `pnpm build` (filtered to
shared/server/web), `pnpm --filter @backspace/desktop build:ts`, and
`pnpm -r test`. It **never runs `pnpm -r typecheck`** — the root script exists but
nothing invokes it.

So the metrics package's `test` script is:

```
tsc --noEmit && vitest run && node --experimental-strip-types vendor-check.ts
```

This makes the existing `pnpm -r test` step genuinely cover types, unit tests,
and vendor drift with no `ci.yml` change. `pnpm-workspace.yaml` gains
`scripts/metrics` specifically, not `scripts/*`, so unrelated future scripts are
not swept into the workspace.

### 3.7 TypeScript via Node type stripping — and its real constraints

The collector is TypeScript with **zero runtime dependencies** (`fetch` and
`node:` builtins only), executed directly by Node with no build step, keeping the
daily job at roughly 20 seconds.

Corrections to the first draft: type stripping has been unflagged since **v22.18
/ v23.6** and stable since **v24.12** — so the "root `engines` permits Node 20,
which cannot do this" framing was a non-issue. The package declares
`engines: >=22.18`; the **workflow** pins `node-version: 24`. Tests import modules
directly through vitest and never shell out to `node src/*.ts`, so the Node 20 leg
of `ci.yml` is unaffected. There is no `.npmrc`, so `engine-strict` is off; if
anyone enables it later, this is the package that will complain first.

The constraints that actually shape the code, all omitted from v1:

- **`import type` is mandatory** for type-only imports. Without it Node treats the
  import as a value import and throws `SyntaxError` **at runtime**. Since §4 has a
  dedicated `types.ts`, the failure mode is a green typecheck and a red 03:00
  cron. This is the single most likely way this system breaks.
- **File extensions are mandatory:** `import './series.ts'`, never `'./series'`.
- **Unsupported:** enums, namespaces with runtime code, parameter properties,
  import aliases, decorators.

Mitigation is compiler-enforced, not discipline-enforced: the package tsconfig
sets `erasableSyntaxOnly`, `verbatimModuleSyntax`, and
`rewriteRelativeImportExtensions`, so `tsc --noEmit` — which now runs in CI via
§3.6 — rejects every one of these at review time rather than at 03:00.

---

## 4. Architecture

```
.github/workflows/metrics.yml        daily cron -> collect -> commit -> deploy
.github/workflows/backfill.yml       workflow_dispatch only
.github/workflows/deploy-pages.yml   extended: workflow_call + data bundling

scripts/metrics/                     @backspace/metrics (new workspace package)
  tsconfig.json      extends repo strict config; erasableSyntaxOnly etc (§3.7)
  src/
    github.ts        API client: auth, pagination, 202 retry, error handling
    series.ts        CSV/NDJSON read, upsert, sorted write
    collect.ts       daily snapshot entrypoint
    backfill.ts      historical reconstruction entrypoint
    bundle.ts        data branch -> site/insights/data.json
    types.ts         shared types (import type only — see §3.7)
  test/              vitest, fixture-driven, no network

site/insights/
  index.html         dashboard (Aether Drift, self-contained)
  assets/uplot.*     vendored, dependency-tracked

branch: metrics-data (orphan, ruleset-protected)
  traffic/views.csv, clones.csv, referrers.ndjson, paths.ndjson
  stars.csv, forks.csv, releases.csv, contributors.csv, repo.csv
  meta.json
```

Both new workflows follow house convention without exception: a header comment
explaining *why* (including the two-token split, the caller-permission cap, and
the 60-day hazard), `step-security/harden-runner` with `egress-policy: audit`,
and every `uses:` pinned to a full SHA with a trailing `# vX.Y.Z`. The
`deploy-pages.yml` edit preserves its existing pins and **adds** harden-runner,
which it is currently the only workflow to lack.

### 4.1 Data flow

1. Cron fires `metrics.yml` at 03:00 UTC.
2. **Bootstrap check before checkout.** `git ls-remote --exit-code --heads origin
   metrics-data` determines whether the branch exists; if absent, it is created
   with `git switch --orphan` plus an empty commit. This ordering is mandatory:
   `actions/checkout` with a nonexistent `ref` hard-fails the job, so a bootstrap
   *step* placed after checkout can never run.
3. Checkout `main` (scripts) and `metrics-data` into `./.metrics-data`
   (gitignored, so `git status` on the main checkout stays clean).
4. `collect.ts` fetches **every** series into memory first (§5.2 atomicity).
5. On full success: upsert, rewrite sorted, commit, push with `GITHUB_TOKEN`.
   Pushes made with `GITHUB_TOKEN` do not create workflow runs (`workflow_dispatch`
   and `repository_dispatch` are the only exceptions, neither of which applies),
   so there is no collection loop.
6. An `if: always()` step commits `meta.json` alone, recording `last_run` and any
   error, so failures are visible on the data branch rather than only in the
   Actions tab.
7. A `gh workflow enable` call keeps the schedule alive (§10, 60-day hazard).
8. The deploy job calls `deploy-pages.yml` via `workflow_call`.

### 4.2 Token model

Two tokens. The split is **forced, not preferred**: there is no `administration`
key in the `permissions:` vocabulary at all, so no `GITHUB_TOKEN` configuration
can reach the traffic endpoints.

| Token | Scope | Used for |
|---|---|---|
| `secrets.METRICS_TOKEN` | Fine-grained PAT, this repo only. **Administration: read** (verified as the exact documented requirement for all four traffic endpoints) + Contents: read | Traffic, stars, forks, issues, releases, stats |
| `GITHUB_TOKEN` | Per-job, see below | Pushing to `metrics-data`; Pages deploy |

**Correction to v1.** A called workflow's permissions can only be *maintained or
reduced*, never elevated, and unlisted permissions are set to `none`. Since
`deploy-pages.yml` needs `pages: write` and `id-token: write`, the **calling job
must declare them too**. Granting the collect job only `contents: write` would
make every metrics-triggered Pages deploy fail with "Resource not accessible by
integration."

So permissions are declared per job, not per workflow:

| Job | Permissions |
|---|---|
| `collect` | `contents: write` |
| `deploy` (calls `deploy-pages.yml`) | `contents: read`, `pages: write`, `id-token: write` |

This is weaker than v1 claimed — the deploy job holds the union of what the
reusable workflow needs — but splitting the jobs keeps the *collect* job at
`contents: write` only, so the job that touches the archive cannot deploy and the
job that deploys cannot write the archive. `METRICS_TOKEN` is passed to neither;
it is read only by `collect`, via `secrets:` on the job, never `secrets: inherit`.

### 4.3 Concurrency

`metrics.yml` and `backfill.yml` write the same files, so both declare:

```yaml
concurrency:
  group: metrics-data
  cancel-in-progress: false
```

`false` is mandatory: cancelling a collect run loses that day irrecoverably.

If a push is still rejected as non-fast-forward, the job runs `git pull --rebase`,
re-applies the upsert against the refreshed files, and retries — twice, then
fails loudly. Traffic's 14-day overlap makes a lost day recoverable; a silent
clobber is not.

### 4.4 Daily collection sources

`collect.ts` reads exactly these endpoints. Required series abort the write on
failure (§5.2); optional ones skip, leaving the prior value.

| Endpoint | Writes | Required |
|---|---|---|
| `/traffic/views` | `traffic/views.csv` | **Yes** |
| `/traffic/clones` | `traffic/clones.csv` | **Yes** |
| `/traffic/popular/referrers` | `traffic/referrers.ndjson` | **Yes** |
| `/traffic/popular/paths` | `traffic/paths.ndjson` | **Yes** |
| `/repos/{slug}` | `repo.csv`, `stars.csv`, `forks.csv` (counter fields) | **Yes** |
| `/releases` | `releases.csv`; `repo.csv.downloads_total` = sum of every asset's `download_count` | No |
| `/stats/contributors` | `contributors.csv` | No — 202-prone (§6.1) |

Traffic is required because it is the only irreplaceable data. Releases and stats
are optional because both are reconstructable at any later date, so losing a day
of them costs nothing and neither should be able to block a traffic write.

`stars.csv` and `forks.csv` are written daily from the **repo object's counters**
(`stargazers_count`, `forks_count`), not by listing stargazers. That is a
point-in-time measurement which correctly reflects unstars. §6's backfill
reconstructs the same series from `starred_at`, which cannot see unstars — which
is precisely why backfill is write-if-absent (§5.2).

---

## 5. Data Model

All files live on `metrics-data`, sorted ascending on write so diffs are stable
and append-only in the common case.

### 5.1 Date-keyed series (CSV, header row, one row per UTC date)

```
traffic/views.csv     date,count,uniques
traffic/clones.csv    date,count,uniques
stars.csv             date,total
forks.csv             date,total
releases.csv          date,tag,name          # published_at; drives §7 annotations
contributors.csv      date,total             # daily, 202-prone (§6.1); backfilled once
repo.csv              date,subscribers,open_issues,downloads_total
```

Three v1 columns are gone. `size_kb` appeared on no chart. `issues.csv` and
`prs.csv` are cut with the Health section (§2). `releases.ndjson` is replaced by
`releases.csv` plus a single `downloads_total` column — v1 snapshotted all 22
assets of every release every day, which alone was 760 KB/year and grew ~20
rows/day per additional release, for a Distribution chart that is now deferred.

`repo.csv.subscribers` is deliberately **not** named `watchers`: GitHub's
`watchers_count` is a duplicate of `stargazers_count` (live: both 56), and the
real watcher count is `subscribers_count` (live: 1). Reading the obviously-named
field would have silently duplicated the star series.

### 5.2 Write semantics

**Fetched values win, with three guards:**

1. **Atomicity.** Every series is fetched into memory before anything is written.
   Any required fetch failing aborts the whole write — no commit, `last_success`
   untouched. A half-failed run must never produce a file the next run treats as
   authoritative.
2. **Backfill is write-if-absent.** Backfill may only fill dates with no existing
   row; it never overwrites a collector-written value. Without this rule, running
   backfill six months in would overwrite six months of correctly measured daily
   star counts with values reconstructed from the *current* stargazer list — which
   is systematically wrong, because anyone who starred and later unstarred is
   invisible to `/stargazers`. Same hazard for forks. Asserted by test (§9).
3. **No zero-filling.** The traffic API returns quiet days explicitly as
   `count: 0` (verified live against a zero-traffic repo), so a missing date means
   "not collected", never "zero". Absent dates stay absent, and `bundle.ts` emits
   `null` for them so uPlot breaks the line rather than drawing a false zero.

Properties this yields:

- **Idempotent.** Re-running produces no duplicates and no drift.
- **Self-healing.** The traffic window is 14 buckets wide, so any gap of **≤13
  full days** is silently repaired by the next successful run. A missed cron costs
  nothing.

**Correction to v1: the current UTC day is often absent, not partial.** Measured
at 14:51 UTC on a repo averaging ~50 views/day, the window ended `2026-08-24`
with no row for today at all — while other repos the same minute *did* include
today. The window's end date is not deterministic and does not track wall-clock
UTC. The collector must therefore never assume `views[last].date === today`, and
never interpret a missing today-row as zero traffic. Bucket timestamps themselves
are reliably UTC-midnight aligned (`2026-08-11T00:00:00Z`), as documented.

### 5.3 Aggregate-window series (NDJSON) — and an honest limitation

`/traffic/popular/referrers` and `/popular/paths` return a **single aggregate
covering the trailing 14 days**, top 10 only (verified live: paths returned
exactly 10). Daily referrer counts are not reconstructable — not here, not
anywhere. GitHub does not expose them.

What is achievable is snapshotting the aggregate daily, tagged with fetch date:

```
traffic/referrers.ndjson  {"snapshot_date":"2026-08-25","referrer":"news.ycombinator.com","count":118,"uniques":94}
traffic/paths.ndjson      {"snapshot_date":"2026-08-25","path":"/TheZwiss/backspace","title":"…","count":402,"uniques":161}
```

Each row means "in the 14 days ending on `snapshot_date`". The dashboard labels
these sections as trailing-14-day figures so the weaker resolution is never
presented as something it is not.

- Upsert key: `(snapshot_date, dimension)`.
- Written by **full rewrite each run**, sorted `(snapshot_date asc, count desc,
  dimension asc)` — specified because the alternative (append, or a different
  secondary sort) churns the whole file on every commit and defeats §3.2's
  one-line-per-day diff rationale entirely.
- A dimension absent from a snapshot means "outside the top 10", i.e. *≤ the #10
  count* — **not zero**. §7 renders it as a break in the line. Plotting zero would
  be a lie.

### 5.4 Collector state (`meta.json`)

```json
{
  "last_run": "2026-08-25T03:00:41Z",
  "last_success": "2026-08-25T03:00:41Z",
  "error": null,
  "series_last_date": { "traffic/views.csv": "2026-08-24", "stars.csv": "2026-08-25" }
}
```

`series_last_date` keys are exact file paths. `last_run` is written on every
attempt via the `if: always()` step (§4.1.6); `last_success` and `error` only on
completion. The dashboard header renders staleness from `last_success` and warns
visibly past 48 hours. This is the detection mechanism referenced in §10 — without
it a dead collector looks identical to a quiet week. `schema_version` is dropped:
one version, no migration path, no reader that branches on it.

### 5.5 Volume

Measured by serialising today's real API responses into these exact shapes:

| Series | bytes/day | KB/year |
|---|---|---|
| `paths.ndjson` (10 rows) | 1,437 | 512 |
| `referrers.ndjson` (8 rows, 10 max) | 640 | 228 |
| all CSVs combined | ~210 | 75 |
| **total** | | **~815 KB/yr** |

**~8 MB/decade.** v1's "300 KB/year, under 5 MB/decade" was ~5× low and rested
on a `releases.ndjson` shape now cut (§5.1). §3.2's conclusion against SQLite
still holds comfortably; the margin is simply narrower than first stated.

### 5.6 Field-name traps to record in `metrics.md`

- `watchers_count` = stars. Use `subscribers_count` for watchers.
- The repo object's `open_issues` **includes open PRs**. `repo.csv.open_issues`
  carries that meaning and the dashboard labels it "open issues and PRs".
- `/stargazers` listing became **admin/collaborator-gated in July 2026**. The
  `METRICS_TOKEN` satisfies it (`Metadata: read` is implicit on every fine-grained
  PAT), but it works because the token belongs to a repo admin, not because stars
  are openly readable.

---

## 6. Backfill

`backfill.yml`, `workflow_dispatch` only, never on cron. **Write-if-absent
throughout** (§5.2), so a re-run can never overwrite measured data.

**Files backfill may touch, exhaustively:** `stars.csv`, `forks.csv`,
`releases.csv`, `contributors.csv`. Nothing else. It never opens `traffic/*` or
`repo.csv` — the latter carries `subscribers`, which no API can reconstruct
historically, so a stray rewrite would be permanent loss with nothing to restore
from.

| Series | Method |
|---|---|
| Stars | Paginate `/stargazers` with `Accept: application/vnd.github.star+json`, bucket `starred_at` by UTC day, accumulate |
| Forks | Paginate `/forks?sort=oldest`, bucket `created_at` |
| Releases | `/releases` → `published_at`, `tag_name`, `name` |
| Contributors | `/stats/contributors` weekly buckets → count of distinct contributors whose first commit week is on or before each date (cumulative distinct, not an interpolation of weekly totals) |

`/issues` is no longer used: the Health section is deferred (§2).

### 6.1 The 202 problem

`/stats/contributors` returns **HTTP 202 with an empty body** while GitHub
computes statistics — verified live, first call `202 {}`, second call minutes
later `200` with 4 contributors across 28 weeks. Critically, **the stats cache is
keyed by the default branch SHA and reset by every push to `main`**, so an active
repo hits this routinely rather than rarely.

Under a naive `await res.json()`, that `{}` becomes `contributors = 0` and,
under fetch-wins, corrupts the series. Required handling:

- Retry with backoff on 202.
- A persistent 202 is a **skip**, leaving the prior value — never a zero.
- Treated as non-required for atomicity (§5.2): a stats timeout must not abort
  the traffic write, since traffic is the irreplaceable part.

`/stats/commit_activity` and `/stats/code_frequency` behave identically. They are
not collected in v1, which is one reason the commit-activity chart is deferred.

### 6.2 Rate limits

Standard 5,000/hr; no special or secondary limit applies to traffic or stats
endpoints, and a handful of daily requests is three orders of magnitude clear.
v1's sleep-until-`x-ratelimit-reset` loop and its fixture test are **cut** — at 56
stargazers (one page) that code would be written, tested, and never executed.
Fail loudly on 429/403 and re-dispatch instead.

Pagination is still implemented properly (`per_page=100`), since it is cheap and
correct. One caveat to re-check if the repo ever crosses ~40k stars: a listing
ceiling is widely cited but could not be confirmed in current docs. Also note
that `GITHUB_TOKEN` carries a **1,000 req/hr per-repository** limit rather than
5,000 — backfill must run under `METRICS_TOKEN`.

---

## 7. Dashboard

`site/insights/index.html`. Aether Drift tokens reused from the landing page,
copy in the same voice. Self-contained: no external asset requests. Responsive.

One shared time-range control (30d / 90d / 1y / all) and one shared hover cursor
drive every time-series chart simultaneously.

**Five sections in v1** (Health, Distribution, and Activity deferred per §2):

| Section | Content |
|---|---|
| Header | Stars, forks, watchers, views and clones **since collection began**, contributors, total downloads — each with a 30-day delta |
| Reach | Views and clones with uniques; drag-to-zoom; the core archive view |
| Growth | Star and fork history, all-time, **with release tags annotated on the time axis** (sourced from `releases.csv`) |
| Where people come from | Ranked referrer bars, trailing 14 days, labelled as such; plus top-5 referrer trajectories |
| What they look at | Ranked popular-path bars, same labelling |

The release annotation is the highest-value element: it turns "stars went up in
July" into "the v1 release drove that", and is only possible because release
dates and star history live in the same archive. v1 of this spec claimed it while
persisting no release date at all — `releases.csv` (§5.1) exists to fix that.

**Honest labelling is a requirement, not a nicety.** The header says "Views since
2026-08-25", never "all-time", because §2 establishes that earlier traffic is
unrecoverable. Before 30 days of data exist, deltas render as "—", not as a
spuriously large percentage.

**Referrer trajectories are differenced, not raw.** Consecutive snapshots share 13
of their 14 days, so a raw trajectory is a rolling sum that reads as smooth growth
when nothing changed. A missing dimension renders as a break, never zero (§5.3).

### 7.1 Data delivery and empty states

Data loads as one `data.json` bundle generated at deploy time, so the page makes a
single request. Pages serves it gzipped. **Budget: 2 MB uncompressed.** Past that,
the `all` range downsamples to weekly buckets. `bundle.ts` fails the build if the
budget is exceeded, so the regression surfaces in CI rather than in first paint.

`site/insights/data.json` is a **build artifact, never committed** — added to
`.gitignore` under a labelled section. The data branch is the single source of
truth; committing a derived copy invites the two to disagree. Consequently the
page must handle a 404 on `data.json` gracefully, which is the same empty-state
path as a missing data branch: render the shell with an explanatory message, not
a broken chart.

### 7.2 Pages deployment change

`deploy-pages.yml` gains `workflow_call` alongside its existing triggers, plus
`setup-node` and `pnpm` (it currently has neither), a conditional checkout of
`metrics-data`, and a `bundle.ts` step.

**The metrics-data checkout must be conditional and non-fatal.** That workflow
today deploys the landing page on every `site/**` push. An unconditional checkout
of a branch that does not yet exist would fail *every landing-page deploy* until
the metrics branch is created, and permanently if it is ever deleted — a live
regression to working production. `bundle.ts` emits a valid empty `data.json`
when the branch or any file is missing.

Two more unstated pieces: the workflow's `paths:` filter must gain
`scripts/metrics/**` (otherwise a bundler change never redeploys), and the
`github-pages` environment has a branch policy allowing only `main` and
`gh-pages` — so a `workflow_dispatch` run from a feature branch is blocked at the
environment gate. Worth one line in the runbook.

**Concurrency correction.** v1 said the existing
`concurrency: { group: pages, cancel-in-progress: true }` "correctly serialises"
a metrics deploy against a site push. It does the opposite — it **cancels** the
in-flight deploy. GitHub's own Pages starter workflow comments this explicitly:
*"do NOT cancel in-progress runs as we want to allow these production deployments
to complete."* Cancelling `actions/deploy-pages` mid-flight also strands an
in-progress deployment in the `github-pages` environment that blocks the next one.

This is a pre-existing bug in `deploy-pages.yml`, not one this project
introduces — but adding a second trigger source turns collisions from theoretical
into routine. **Flip it to `cancel-in-progress: false`** as part of WS2. Also note
that workflow-level `concurrency` in a *called* workflow is not reliably honoured;
the group belongs on the calling job.

---

## 8. Workstreams & Sequencing

Sequencing is load-bearing. **Every day without a running collector destroys
traffic data permanently**, so WS1 ships alone, first. A half-finished dashboard
blocking a working collector would be an unforced, unrecoverable loss.

Each workstream becomes its own plan file, following the precedent of the
security spec (whose workstreams became `plan-a-…`, `plan-b-…`, `plan-d-…`). Two
workstreams, not more: a separate plan file buys a fresh execution session and a
real stop-and-reconsider gate, which fits WS1 (must ship alone, must ship first,
independently valuable) and does not fit any split within the dashboard.
Documentation is folded into each rather than deferred to a workstream of its own,
where it would simply be skipped.

### WS1 → `plan-a-metrics-collection.md`
The package, workspace and tsconfig wiring (§3.6, §3.7), `github.ts`, `series.ts`,
`collect.ts`, `meta.json`, `metrics.yml`, `backfill.yml`, `METRICS_TOKEN`, the
branch ruleset, orphan bootstrap, concurrency, and the §9 tests. Includes
`docs/systems/metrics.md` and the `security-scanning.md` checklist entry, because
the PAT setup and the 60-day hazard need documenting the moment the pipeline
exists. Backfill lands here too — it shares `series.ts` and is ~¼ the size of the
other workstreams.

**Done when data has been committed on two consecutive days and a re-run is
proven byte-identical for all dates before the current UTC day.** Independently
valuable with no dashboard: the archive is accruing.

### WS2 → `plan-b-metrics-dashboard.md`
`bundle.ts` and the data contract, the empty-archive path, the `deploy-pages.yml`
extension, the `cancel-in-progress` fix, `site/insights/index.html`, uPlot
vendoring, and `vendor:sync`/`vendor:check`. For scale: `site/index.html` is
1,082 lines.

An earlier draft split the deploy-pages edit into a third workstream, on the
grounds that it touches a **currently working production deploy** and carries the
regression risk in §7.2. That risk is real, but a separate plan file is not what
isolates it — every task already lands as its own commit behind its own review
gate. The edit is therefore the **first task** of this workstream, reviewed on its
own before any chart code exists, which achieves the same isolation without a
third plan.

The bundler and the page are not separable in any case: a bundler with no page to
read it, and a page with no data to render, are each useless. They ship together.

**Done when `data.json` appears in the Pages artifact, the landing page still
deploys with the metrics branch both present and absent, and the five sections in
§7 render.**

---

## 9. Testing Strategy

Vitest, fixture-driven, **no network in any test**. Tests import modules directly
and never shell out to `node src/*.ts`, so the Node 20 leg of `ci.yml` passes.
Coverage reaches CI through the package `test` script (§3.6).

| Area | Assertions |
|---|---|
| Upsert | Overlapping windows produce no duplicates; fetched values win; output sorted; re-run byte-identical for dates before today |
| **Backfill safety** | Backfill never modifies a date that already has a row; never opens `traffic/*` or `repo.csv` |
| Atomicity | A failed fetch of any required series produces no write and no `last_success` update |
| Boundary | A window ending before today is handled; a missing today-row is never written as zero; UTC bucketing has no off-by-one at midnight |
| Gaps | A 10-day gap is fully repaired by one run; a 14-day gap leaves absent rows, and the bundler emits `null` for them |
| **202 handling** | 202 retries with backoff; a persistent 202 skips rather than writing zero; a stats 202 does not abort the traffic write |
| CSV/NDJSON | Round-trip lossless; commas and quotes in paths and titles escaped; NDJSON secondary sort is `count desc, dimension asc` |
| Backfill math | Cumulative star counts from a fixture `starred_at` list; multi-page pagination |
| Bundle | Malformed rows rejected loudly; missing branch yields a valid empty bundle; the 2 MB budget fails the build |
| **Erasable syntax** | `tsc --noEmit` with `erasableSyntaxOnly` + `verbatimModuleSyntax` rejects a value-import of a type and any non-erasable construct (§3.7) |
| Dependency guard | The collector imports nothing outside `node:` builtins |
| Vendor guard | `vendor:check` fails when the committed uPlot copy diverges |

---

## 10. Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **Scheduled workflows auto-disable after 60 days of no repository activity** | High | v1's mitigation was detection-only and rested on an unexamined assumption. Bot commits do appear to count as activity, but **whether a push to a non-default branch counts is undocumented**, and every keepalive tool commits to the default branch — while this collector commits only to an orphan branch. Mitigation is therefore active, not passive: an idempotent `gh workflow enable` step in the job itself, plus the `last_success` staleness warning in the dashboard header as a backstop |
| **`import type` omitted → runtime `SyntaxError` in the cron** | High | `erasableSyntaxOnly` + `verbatimModuleSyntax` in the package tsconfig, enforced by `tsc --noEmit` inside `pnpm -r test` (§3.6, §3.7) |
| **Backfill overwrites measured history** | High | Write-if-absent rule (§5.2) with an explicit allowed-files list (§6) and a dedicated test |
| **`deploy-pages.yml` edit breaks the live landing page** | High | Conditional, non-fatal metrics-data checkout; empty-bundle path; WS2 reviewed in isolation with "landing page still deploys, branch absent" in its done criteria |
| `metrics-data` deleted or force-pushed | High | Matching ruleset (`deletion`, `non_fast_forward`, no bypass), per §3.3 |
| PAT expires, is revoked, or the repo is transferred | High | Job fails loudly rather than skipping. A gap ≤13 days is fully recoverable, giving a two-week window to notice. A transfer to another owner invalidates a repo-scoped fine-grained PAT and needs it re-issued |
| Stats endpoints return 202 | Medium | Retry, then skip — never zero (§6.1) |
| Pages deploy cancelled mid-flight, stranding the environment | Medium | `cancel-in-progress: false` (§7.2) |
| Collect and backfill race | Medium | Shared `metrics-data` concurrency group, `cancel-in-progress: false`, rebase-and-retry on rejected push (§4.3) |
| Cron delayed or dropped by GitHub | Low | Absorbed by the ≤13-day overlap |
| Data branch missing on first run | Low | `git ls-remote` check **before** checkout (§4.1) |
| Repo renamed | Low | Slug read from `github.repository`, never hardcoded |
| Vendored uPlot rots | Low | Real devDependency; `vendor:check` inside `pnpm -r test` |
| Publishing traffic numbers publicly | Accepted | Explicit decision; transparency judged worth more than concealment |
| Referrer resolution weaker than daily | Accepted | Upstream limitation; labelled explicitly in the UI |

---

## 11. Documentation

Per CLAUDE.md's documentation rule this is structural — new workflows, a new data
store, a new UI surface — so docs are required:

- **New:** `docs/systems/metrics.md` — collection pipeline, data schemas, upsert
  and write-if-absent semantics, backfill procedure, PAT scopes, the 202 problem,
  the field-name traps in §5.6, the 60-day hazard, the `github-pages` branch
  policy, and dashboard architecture.
- **Updated:** CLAUDE.md subsystem table gains a `metrics.md` row.
- **Updated:** CLAUDE.md monorepo structure gains `scripts/`, noting the subsystem
  spans `scripts/metrics` (a workspace package) and `site/insights` (not one).
- **Updated:** `docs/systems/security-scanning.md` — its existing "Maintainer
  checklist (one-time GitHub settings — NOT code)" gains two entries: create the
  `METRICS_TOKEN` secret with fine-grained repo-scoped `Administration: read`, and
  create the `metrics-data` ruleset.

v1 listed `docs/systems/deployment.md`; that file contains **zero** mentions of
Pages or `site/`, so there is nothing there to update. Dropped.

---

## 12. Definition of Done

1. `metrics.yml` runs daily, collects every series in §5, and commits to
   `metrics-data`.
2. Backfill has been run once; stars, forks, releases, and contributors carry
   history from 2026-02-18, and a second run provably changes nothing.
3. The dashboard is live at `thezwiss.github.io/backspace/insights/`, renders all
   five sections in §7, and makes zero third-party requests.
4. Two consecutive daily runs produce correct, duplicate-free data, and a re-run
   is **byte-identical for all dates before the current UTC day** (not a no-op —
   today's row legitimately changes, per §5.2).
5. `pnpm -r test` passes, covering types, unit tests, and `vendor:check` (§3.6).
6. `METRICS_TOKEN` exists with fine-grained, repo-scoped, read-only permissions.
7. The `metrics-data` ruleset blocks deletion and force-push, with no bypass
   actors and no PR or status-check requirement.
8. The landing page still deploys from a `site/**` push, verified with the
   metrics branch both present and absent.
9. Documentation in §11 is written and committed.
