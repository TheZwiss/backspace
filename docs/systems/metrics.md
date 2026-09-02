# Repository Metrics Archive

Source files:
- `scripts/metrics/src/types.ts` -- Shared row shapes (`TrafficPoint`, `CountPoint`, `ReleaseRow`, `RepoPoint`, `DimensionRow`)
- `scripts/metrics/src/github.ts` -- GitHub API client: auth, pagination (`Link: rel="next"`), `/stats/*` 202 retry
- `scripts/metrics/src/series.ts` -- CSV/NDJSON parse + format, date-keyed upsert, explicit-key upsert (releases), dimensional upsert
- `scripts/metrics/src/store.ts` -- Filesystem layer: atomic per-file writes (temp + rename), `meta.json` read/write, path containment
- `scripts/metrics/src/collect.ts` -- Daily snapshot entrypoint (`collect()`)
- `scripts/metrics/src/backfill.ts` -- One-shot historical reconstruction entrypoint (`backfill()`)
- `scripts/metrics/src/cli-collect.ts` -- `process.env`/clock-reading wrapper invoked by `metrics.yml`'s "Collect" step
- `scripts/metrics/src/cli-backfill.ts` -- `process.env`-reading wrapper invoked by `backfill.yml`
- `scripts/metrics/src/cli-record-failure.ts` -- `process.env`/clock-reading wrapper invoked by `metrics.yml`'s "Record failure" step (`if: failure()` only)
- `scripts/metrics/src/cli-support.ts` -- Env validation, token safety check, timestamp derivation, failure recording, log formatting
- `scripts/metrics/src/bundle.ts` -- Archive reader: builds the `DashboardData` the page renders, weekly downsampling, the 2 MB size budget
- `scripts/metrics/src/cli-bundle.ts` -- `process.env`/clock-reading wrapper invoked by `deploy-pages.yml`'s "Bundle the metrics archive" step
- `scripts/metrics/vendor.json` -- SHA-256 manifest for the vendored uPlot files, enforced by `vendor-check.test.ts`
- `site/insights/index.html` -- The dashboard: one self-contained static page, no framework, no build step
- `site/insights/vendor/uplot.min.js`, `site/insights/vendor/uplot.min.css` -- Vendored uPlot 1.6.32
- `.github/workflows/metrics.yml` -- Daily cron: collect, commit, push; on failure, record and push the failure to `meta.json`; `gh workflow enable`; then call the Pages deploy
- `.github/workflows/backfill.yml` -- `workflow_dispatch`-only backfill runner
- `.github/workflows/deploy-pages.yml` -- Pages deploy: bundles the archive into `site/insights/data.json`, uploads `site/`, publishes

This document covers both halves of the subsystem: the **collection pipeline** (the `scripts/metrics` package, `metrics.yml`/`backfill.yml`, and the orphan `metrics-data` branch they write to) and the **public dashboard** built from that archive (`site/insights/`, the bundler, and `deploy-pages.yml`). §10 covers the dashboard.

---

## 1. Why this exists

GitHub's Insights → Traffic panel (views, clones, referrers, popular paths) retains data for **14 days only**, then discards it. No API reconstructs a day once it has aged out of that window. Every day this collector does not run is a day of traffic history destroyed permanently, with no recovery path.

Everything else GitHub tracks about the repo (stars, forks, issues, releases, contributors) is retrievable at any later date from permanent, timestamped API data — so it only needs to be captured once, not daily.

### What is and is not recoverable

| Data | Retention | Action |
|---|---|---|
| Traffic: views, clones, referrers, popular paths | **14 days, then destroyed** | **Snapshot daily** |
| Release asset download counts | Live cumulative total, no time series | **Snapshot daily** |
| Stars | Permanent — `/stargazers` returns `starred_at` | Backfill once |
| Forks | Permanent — `created_at` | Backfill once |
| Releases | Permanent — `published_at` | Backfill once |
| Contributors | Permanent — `/stats/contributors` | Backfill once |

Issues/PRs and commit/code-frequency history are not collected at all, and no chart on the dashboard draws them, so there is nothing here to seed for them. `repo.csv`'s `open_issues` column is the one adjacent figure that *is* collected and carried into the bundle; no chart plots it today.

---

## 2. Architecture

```
scripts/metrics/                     @backspace/metrics (pnpm workspace package)
  package.json      zero runtime dependencies; scripts: typecheck, test, vendor:check
  tsconfig.json      extends the repo's strict base config, plus erasableSyntaxOnly,
                      verbatimModuleSyntax, allowImportingTsExtensions
  vendor.json        sha256 manifest for the vendored uPlot files
  src/
    types.ts          shared row shapes (import type only)
    github.ts         API client
    series.ts         CSV/NDJSON codec + upsert
    store.ts           filesystem layer, meta.json
    collect.ts         daily snapshot
    backfill.ts         historical reconstruction
    bundle.ts           archive -> DashboardData, downsampling, size budget
    cli-collect.ts      env/clock wrapper for metrics.yml's "Collect" step
    cli-backfill.ts     env wrapper for backfill.yml
    cli-record-failure.ts  env/clock wrapper for metrics.yml's "Record failure" step
    cli-bundle.ts       env/clock wrapper for deploy-pages.yml's "Bundle" step
    cli-support.ts      shared CLI helpers
    *.test.ts           vitest, no network, no filesystem outside a per-test tmpdir

site/                                the GitHub Pages site
  index.html         landing page (unrelated to metrics)
  insights/
    index.html       the dashboard: one file, inline CSS and JS, no build step
    vendor/uplot.min.js, vendor/uplot.min.css   uPlot 1.6.32, committed verbatim
    data.json        BUILD ARTEFACT, gitignored, written at deploy time

.github/workflows/metrics.yml        daily cron -> collect -> commit -> push -> deploy
.github/workflows/backfill.yml       workflow_dispatch only
.github/workflows/deploy-pages.yml   bundle -> upload site/ -> deploy to Pages

branch: metrics-data (orphan, ruleset-protected — see §8)
  traffic/views.csv, traffic/clones.csv
  traffic/referrers.ndjson, traffic/paths.ndjson
  stars.csv, forks.csv, releases.csv, contributors.csv, repo.csv, workflows.csv
  meta.json
```

The collector is plain TypeScript executed directly by Node's native type stripping — no build step, no transpiler, no `dist/`. `pnpm-workspace.yaml` lists `scripts/metrics` explicitly (not `scripts/*`), so unrelated future scripts under `scripts/` are not swept into the workspace by accident. The dashboard follows the same rule for the same reason: `site/insights/index.html` is one file with its CSS and JS inline, and its only dependency is committed next to it.

### The collection workflows

Both `metrics.yml` and `backfill.yml`:
- Declare `concurrency: { group: metrics-data, cancel-in-progress: false }`. This shared group name is the **only** thing preventing the daily cron and a dispatched backfill from racing on the same branch — they queue instead of running concurrently, and neither is ever cancelled mid-write, since cancelling a collection run loses that day irrecoverably.
- Skip entirely on a fork (`if: ${{ !github.event.repository.fork }}`), because `METRICS_TOKEN` is a repository secret and does not propagate to forks — without this guard a fork's own scheduled run would fail every day with nothing the fork owner could do about it.
- Bootstrap the `metrics-data` branch via `git ls-remote --exit-code --heads origin metrics-data` **before** any `actions/checkout` step references it. `actions/checkout` hard-fails the job if given a nonexistent `ref`, so the check has to run first. If the branch is absent, both workflows create it with `git worktree add --orphan` into a scratch directory (`.metrics-init`), commit an empty initial commit, push, and remove the worktree — never touching the primary checkout, so an early exit can't leave that tree modified.
- Check out `metrics-data` into `./.metrics-data` (gitignored — see `.gitignore`'s `.metrics-data/` entry — so `git status` on the main checkout stays clean) and pin `actions/setup-node` to `node-version: 24`.
- Run `step-security/harden-runner` with `egress-policy: audit`, and pin every `uses:` to a full commit SHA with a trailing `# vX.Y.Z` comment, per this repo's standing CI convention (see `docs/systems/security-scanning.md`).

`metrics.yml` runs `collect` (`node scripts/metrics/src/cli-collect.ts`); `backfill.yml` runs `backfill` (`node scripts/metrics/src/cli-backfill.ts`). Both of those jobs declare only `contents: write` (plus `actions: write` on `metrics.yml`, for the schedule-keepalive step in §8).

`metrics.yml` has a second job, `deploy-dashboard`, which republishes the dashboard from the archive the run just wrote. It is a separate job with a *narrower* grant than `collect` — the deploy wiring and the reasons for the split are in §10.5.

`metrics.yml` additionally runs a failure path that `backfill.yml` does not have: a "Record failure" step (`node scripts/metrics/src/cli-record-failure.ts`, `if: failure()`) followed by a "Commit and push failure record" step, both gated to run only when something earlier in the job failed. See §3.3 for what this writes and why `backfill.yml` doesn't need the equivalent — a failed backfill dispatch is visible in the Actions tab for whoever ran it, with no unattended schedule depending on it the way the daily cron does.

---

## 3. Data schemas

All files live at the root of the `metrics-data` branch. CSVs are sorted ascending on their first (date) column on every write; NDJSON files are sorted `(snapshot_date asc, count desc, dimension asc)`. Both orderings are fixed by `series.ts` (`formatCsv`, `compareDimensionRows`) so that re-running the collector against unchanged upstream data produces a byte-identical file — the property that keeps daily commits to one line of diff. `releases.csv` additionally fixes a tie-break within a shared date, `tag` ascending (`compareReleaseRows`, applied by the `upsertByKey` merge described in §3.1's caveat below), since it is the one CSV where more than one row can share a date.

### 3.1 CSV series

| File | Columns | One row means |
|---|---|---|
| `traffic/views.csv` | `date,count,uniques` | Total views and unique visitors on that UTC date |
| `traffic/clones.csv` | `date,count,uniques` | Total clones and unique cloners on that UTC date — see the caveat below the table |
| `stars.csv` | `date,total` | The repo's live `stargazers_count` as read on that date (a point-in-time snapshot, not a delta) — see the caveat below the table |
| `forks.csv` | `date,total` | The repo's live `forks_count` as read on that date — see the caveat below the table |
| `releases.csv` | `date,tag,name` | A release published on that UTC date (`date` = `published_at`'s UTC day) — see the caveat below the table |
| `contributors.csv` | `date,total` | Cumulative distinct-contributor count, where a contributor counts from the UTC date of the start of their first commit week onward. Capped: see the note below the table |
| `repo.csv` | `date,subscribers,open_issues,downloads_total,downloads_app,downloads_updates` | The repo object's counters as read on that date, plus release asset `download_count` sums: every asset, then that total split into app installs and update-check traffic |
| `workflows.csv` | `date,runs` | Workflow runs this repository started on that UTC date. A `0` is a measured zero, never a gap — see the caveat below the table |

#### Caveats on the table above

**Clones count this repository's own CI.** GitHub counts every `actions/checkout` in the clone statistics, so `traffic/clones.csv` measures the build pipeline and the audience together, with no field distinguishing them. Measured on this repo: days with no workflow runs sit at 2-30 clones, while 2026-08-25 and 2026-09-01 recorded 155 and 189 clones against 218 and 180 successful checkout steps. Clones far above one per unique cloner is the signature. The ratio is not a constant and this archive does not model it: neither the run count nor the checkout-step count predicts the clone figure closely (218 checkout steps produced 155 clones, 180 produced 189), so only the co-occurrence is established, not a coefficient. That is exactly why nothing here publishes a "clones minus CI" figure: that would be a model, and the premise of this archive is that every number on it is a measurement. Page views are unaffected, because a checkout loads no page. The confound is disclosed on the clones card, in the Reach section copy, in the static data page's clones blurb, and in the `BUILD:SUMMARY` sentence that states the peak clone day. It is also *shown*: `workflows.csv` records this repository's own daily workflow-run count, and the dashboard plots it as a third chart on the Reach section's shared axis, directly under clones. The two series are never combined into one corrected figure — see §4.5.

**`stars.csv` and `forks.csv` are point-in-time snapshots, not deltas.** Each row is the live counter as read that day, so it correctly reflects someone who starred and later unstarred. A row written by `backfill()` instead reconstructs the value from `/stargazers`' `starred_at`, which lists only *current* stargazers, making a reconstructed row a **lower bound**. Nothing on disk distinguishes the two writers. See §4.2.

**`releases.csv` is keyed on `tag`, not `date`.** It is the one CSV where more than one row can legitimately share a date, so its merge uses `upsertByKey` with a `tag` ascending tie-break (`compareReleaseRows`) rather than `upsertByDate`. See §4.2.


### The static data page

`cli-bundle.ts` writes a second artifact beside `data.json`: `<bundle dir>/data/index.html`, served at `…/insights/data/`. It is rendered by `renderDataPage` in `datapage.ts`, a pure function over the same `DashboardData` the charts are built from, so the two encodings cannot disagree about a figure.

It exists because the dashboard draws every value client-side. A text-only crawler, an LLM fetching the URL, or a reader with JavaScript disabled otherwise sees the headings and the methodology and not one measured number. The static page carries the values as real `<table>` rows, plus a schema.org `Dataset` block naming `data.json` as a machine-readable `distribution` — without which nothing on the site tells a crawler that `data.json` exists at all.

Three properties worth keeping:

- **Escaping is load-bearing, not cosmetic.** Referrer hostnames and popular paths are strings GitHub reports from real traffic, so they originate outside this repo and reach the page verbatim. `escapeHtml` covers `& < > " '`, ampersand first so replacements are not re-escaped, and `jsonLd` additionally escapes `<` so a `</script>` sequence in the data cannot terminate the structured-data block early. Both are pinned by tests in `datapage.test.ts`.
- **The page inherits the absent-versus-zero rule.** A `null` renders as the words `not measured`, never as `0`; a measured zero renders as `0`. It also reports the resolution it was handed, so a downsampled bundle is labelled as weekly buckets rather than silently presented as daily.
- **The output path is derived, not configured.** It is `data/index.html` inside `METRICS_OUTPUT_PATH`'s directory. A second path variable would be a second thing that can point elsewhere, at which point the page and the JSON it mirrors can disagree about where each lives. `METRICS_SITE_URL` is separate and genuinely optional: set, the page emits absolute links and `Dataset` URLs; unset, it links relatively, so a fork gets a correct page rather than one advertising this deployment's domain as the home of its data.

Both `site/insights/data.json` and `site/insights/data/` are gitignored: they exist only inside a deploy run.

### Static content baked into the charted page

The static data page solves the crawler problem for a reader that follows the link to it. `/insights/` is the URL that actually gets shared, and a fetcher that reads that URL and stops never does follow it — which is the common case for a search crawler or an assistant asked to look at the page. So `cli-bundle.ts` also writes two regions into `site/insights/index.html` itself, from the same `DashboardData`:

- **`<!-- BUILD:SUMMARY -->`** — a paragraph of headline measurements: the latest measured value of each counter with the date it was measured, the peak day of views and clones, the leading referrer and path, and the archive's coverage and resolution. Rendered by `renderSummaryHtml` in `summary.ts`.
- **`<!-- BUILD:JSONLD -->`** — the schema.org `Dataset` block, regenerated so `variableMeasured` carries `PropertyValue` entries with real values and `temporalCoverage` states the archive's actual span. Rendered by `renderDatasetJsonLd`. Skipped when `METRICS_SITE_URL` is unset, since every URL in it is absolute; the committed block stands in that case.

Four properties this depends on:

- **It is not a second implementation of the at-a-glance cards.** Those are range-dependent and carry 30-day deltas with their own reasons for declining to state one. Duplicating that logic in TypeScript would create two sets of rules that drift apart, and the drift would be invisible until they disagreed in public. `summary.ts` derives only figures whose rules are simple enough to be obviously correct.
- **The absent-versus-zero rule applies to prose.** A figure with no measurement behind it loses its whole clause rather than printing `0` or a dash. This text is read by machines that will quote whatever number sits next to a label, so a dash next to "watchers" is a worse outcome here than on a chart.
- **A missing marker throws.** `replaceRegion` refuses to return the page unchanged, because the committed fallback says "not built by the pipeline" and publishing it silently would look exactly like a successful deploy.
- **`labelled()` mirrors the dashboard's `displayLabel` exactly** — trimmed `title` when non-empty, `dimension` otherwise. GitHub fills `title` for paths and leaves it **empty for every referrer**, where the host lives in `dimension`. Reading `title` alone renders "Leading referrer: , 193 views", which is how this was caught.

### The sitemap

`cli-bundle.ts` writes `site/sitemap.xml` (gitignored, `sitemap.ts`) listing the three published pages, with `lastmod` on the two generated ones taken from the archive's newest date rather than from the clock: they are rebuilt every deploy, but their *content* only changes when a collection adds a row, and `lastmod` describes content. The landing page carries no `lastmod` — nothing in this pipeline knows when it last changed.

**`robots.txt` cannot be published from this repository.** It is only honoured at a domain root, and this site is a project page at `thezwiss.github.io/backspace/`; the root belongs to a separate `thezwiss.github.io` user-pages repository. A 404 there is permissive, so nothing is blocked, but the sitemap cannot be declared from it either — it has to be submitted to a search console directly, or referenced from a `robots.txt` in that other repository.

**The download split.** `downloads_total` sums every release asset. That number is dominated by update machinery rather than by installs: electron-updater fetches `latest.yml` / `latest-mac.yml` / `latest-linux.yml` on every update check from every installed client, and `.blockmap` files during a differential update, and GitHub counts all of them in `download_count` exactly like an installer. When the split was added on 2026-09-02 the feed files had 1,519 downloads against 323 for every real installer and archive combined, so the single figure overstated installs by roughly 5.7x.

`downloads_app` counts installers and archives; `downloads_updates` counts anything matching `*.yml`, `*.yaml` or `*.blockmap` (`isUpdateArtifact` in `collect.ts`). For any row carrying all three, `downloads_app + downloads_updates === downloads_total`.

`downloads_total` keeps its original meaning and is still written, because redefining a column in place would silently change what its historical rows mean. Rows written before the split stay **blank** in the two new columns, never `0`: the archive never measured that split for those days, and `formatCsv` writes a missing field as an empty value, which the bundler maps to `null`. The dashboard shows `downloads_app` and `downloads_updates` as separate cards and no longer shows the combined total, which answered neither question.

`repo.csv.downloads_total` is a `number | null` in memory (`RepoPoint` in `types.ts`) and is written as a **blank CSV field**, never `0`, whenever the optional `/releases` fetch fails that run (see §5). `subscribers` and `open_issues` are never blank — they come from the required `/repos/{slug}` fetch, which has already succeeded by the time `repo.csv` is written.

**`stars.csv`/`forks.csv` are one row per UTC date, from both of the processes that write them.** The daily collector (`collect.ts`) appends today's row from the repo object's live counter, so a run either produces that day's row or (on a required-fetch failure) writes nothing at all. `backfill()`, reconstructing the same files from `starred_at`/`created_at` timestamps, is **dense over the range it reconstructs**: `cumulativeByDay` (`backfill.ts`) emits a row for every UTC date from the first event through the run date, carrying the running total forward across days on which nothing happened.

That density is deliberate and it is a correction, not a convenience. These series are cumulative point-in-time totals, so a day on which nobody starred is not a day whose value is unknown — it is known exactly, and it equals the previous day's total. Emitting only the days that moved left the file sparse and pushed the carry-forward onto every reader, which the dashboard cannot do: it draws an absent date as a **break in the line** (§10), a convention that is load-bearing for traffic, where GitHub omits a day it measured no views and a break is the only honest rendering. Applied to a star count the same convention published a hole in the record where there was no hole in the knowledge, so a 62-day history rendered as scattered dots. The archive now states the value it knows for each day and the reader is asked to carry nothing.

What is still true: nothing recorded on disk distinguishes which of the two writers produced a given row — both write through the same `upsertByDate`/CSV format, and a row looks identical regardless of origin. A reconstructed row is a lower bound on what the live counter read that day (§4.2), and that caveat now applies to every date in the reconstructed range rather than only to the dates an event landed on. The two are not distinguishable from the file alone.

**`releases.csv` is keyed on `tag`, not `date`.** Unlike every other series in this table, more than one row can legitimately share a `date`: two releases published the same UTC day are two distinct rows, merged by `upsertByKey` (`series.ts`) keyed on `tag` and sorted `(date asc, tag asc)` for byte-stable output. Both `collect.ts` (`'overwrite'` mode — the day's live fetch is authoritative) and `backfill.ts` (`'if-absent'` mode — a reconstruction must never replace a value the collector already measured) merge through this same keyed function, so the two writers can no longer disagree about which same-day release survives.

### 3.2 Aggregate-window series (NDJSON, one JSON object per line)

| File | Fields | One row means |
|---|---|---|
| `traffic/referrers.ndjson` | `snapshot_date, dimension, title, count, uniques` | In the trailing 14 days ending on `snapshot_date`, referrer host `dimension` sent `count` views (`uniques` unique visitors) |
| `traffic/paths.ndjson` | `snapshot_date, dimension, title, count, uniques` | In the trailing 14 days ending on `snapshot_date`, path `dimension` (with page `title`) received `count` views |

`/traffic/popular/referrers` and `/traffic/popular/paths` each return a single **trailing-14-day aggregate, top 10 only** — there is no per-day breakdown and none is obtainable by any means. Each row is that aggregate tagged with the day it was fetched. `dimension` is the referrer host on `referrers.ndjson` and the page path on `paths.ndjson`; `title` is always `''` on `referrers.ndjson` (the API doesn't return a referrer title) and the page title on `paths.ndjson`.

`upsertDimensional` in `series.ts` keys on `(snapshot_date, dimension)` and rewrites the whole file every run — there is no append mode for this format. **A dimension absent from a given `snapshot_date`'s rows means "outside the top 10 that day," never zero.** If referrer X drops out of the top 10, its row for that date simply doesn't exist; nothing writes a `count: 0` row for it.

### 3.3 Collector state (`meta.json`)

```json
{
  "last_run": "2026-09-01T22:06:27.352Z",
  "last_success": "2026-09-01T22:06:27.352Z",
  "error": null,
  "series_last_date": { "traffic/views.csv": "2026-08-31", "stars.csv": "2026-09-01" }
}
```

The two timestamps are whatever `new Date().toISOString()` produced, milliseconds included (`deriveRunTimestamps` in `cli-support.ts`); nothing truncates them. `series_last_date` keys are exact file paths (only the `.csv` files collected this run are recorded; NDJSON files are not). **A key is added the first time a series is ever written and, from then on, is never removed** — a run that skips a series (an optional fetch failed, or the series simply wasn't touched) leaves that key exactly as the last successful run left it, so the field goes *stale* (a date that stops advancing) rather than *disappearing*. A vanished key would be far easier to miss than a date that stopped moving, which is the whole reason this field exists (see §9).

There are **two writers** of this file, one per outcome, never both in the same run:

1. **On success**, `collect()` (`collect.ts`) is the only writer. It writes `meta.json` last of all, once every other file for the run has landed — see §5's atomicity guarantee — and it is the only place `series_last_date` is ever advanced to a fresh date. Building that map is itself two steps: `collect()` first reads the *previous* `meta.json` via `store.readMeta()` (synchronously, as the write phase's first action — a corrupt existing `meta.json` therefore throws before any file changes this run, the same all-or-nothing guarantee a required-fetch failure already has) and seeds `series_last_date` from it, then overwrites only the keys for series actually written this run. A first-ever run (`readMeta()` returns `null`) seeds from `{}`. On a required-fetch failure, `collect()` throws before any of this, so this writer only ever records a genuine success.
2. **On failure**, `recordFailure()` (`cli-support.ts`, invoked by `cli-record-failure.ts` from `metrics.yml`'s "Record failure" step, `if: failure()`) is the only writer. It reads whatever `meta.json` currently exists (or `null` — legitimate on a run that fails before `collect()` has ever written one), refreshes `last_run` to its own timestamp, and sets `error` to a description of what failed — `run <job status> — <url of the failed run>`, passed in via the `METRICS_RUN_OUTCOME` environment variable, interpolated in the step's `env:` block and never into its `run:` string. The URL is there because this string is the entirety of what a maintainer reading `meta.json` gets: a bare status tells them the archive stopped but not where to look. It leaves **`last_success` and `series_last_date` completely untouched** — not merged, not partially updated, byte-for-byte whatever `collect()` (or a previous failure record) last wrote — because `last_success` is this archive's "last known good" signal and a failure must never move it, and a failed run measured nothing, so it must never edit `series_last_date` either. A "Commit and push failure record" step, mirroring the success path's commit-and-push, then commits and pushes just `meta.json`, with a failed push swallowed to a `::warning::` annotation rather than failing the (already-failed) job.

The practical upshot: a normal successful day produces **exactly one** commit on `metrics-data` (the data snapshot, `meta.json` included via that step's `git add -A`) — there is no second, redundant metadata commit on success anymore. A failed day produces at most one commit too (the failure record; there is no data commit to accompany it unless `collect()` itself succeeded but a later step, e.g. the push, failed — see §9). Check `error` **and** `last_run` together for "did last night's run actually work": `error` distinguishes a failed run from a successful one, but only a run that reached one of the two writers sets it at all. A cancelled or timed-out job sets neither, so a stale `last_run` is the signal that catches those. See §9.

---

## 4. Write semantics

**Fetched values win. Three guards make that safe.**

### 4.1 Atomicity

`collect()` fetches every **required** series (`views`, `clones`, `referrers`, `paths`, the repo object) via a single `Promise.all` before writing anything. If any of those rejects, the function throws before a single `store.write*` call happens — the data directory and `meta.json` are left completely untouched, and the next run treats the previous data as still authoritative. This is asserted directly by a test (`collect.test.ts`, "aborts the entire write when a required traffic fetch fails"), which checks that `traffic/views.csv`, `stars.csv`, and `meta.json` are all still empty/absent after a failed clones fetch.

Once the write phase starts, its very first action is a synchronous read, not a write: `store.readMeta()`, which seeds `series_last_date` from the previous run (§3.3). Placed there — before the first `store.write*` call — rather than later alongside the read-back-after-write calls that finish assembling `meta.json`, a corrupt existing `meta.json` throws before any file changes this run, extending the same all-or-nothing guarantee above to this failure mode too. `readMeta()` is `readFileSync` + `JSON.parse`, both synchronous, so it introduces no `await`. Every `store.write*` call that follows is likewise synchronous with no `await` between any of them, so there is no point where a second run (or anything else) could interleave. `meta.json` is written last of all, so its presence is a completion marker.

**The honest limit on this guarantee:** it is atomicity within one process's happy path, not a transaction. A synchronous run of `writeFileSync`/`renameSync` calls still issues one OS syscall at a time — a hard kill (`SIGKILL`, OOM) or an OS-level error (`ENOSPC`, a permissions change) between two of those calls can leave some files updated to today and others holding yesterday's content, with `meta.json` never reaching its update in that case (so it still points at the last run that *did* complete). **This torn-cross-file state does not self-heal for `stars.csv`, `forks.csv`, or `repo.csv`.** Those three files only ever write **today's** row each run — there is no retry logic that revisits a skipped or partially-written prior date for them. `traffic/*` is different: because the API returns a rolling 14-day window, a gap in the traffic files left by a torn run is silently repaired the next time collection succeeds (see §4.4). A torn `stars.csv`/`forks.csv`/`repo.csv` is not repaired by anything except a future day's row simply continuing forward from wherever it was left.

### 4.2 Backfill is write-if-absent

`backfill()` (`backfill.ts`) merges every series it touches in `'if-absent'` mode — an existing row is never replaced by a reconstructed one. `stars.csv`/`forks.csv` go through `upsertByDate(existing, incoming, 'if-absent')`, keyed on `date`; `releases.csv` goes through `upsertByKey(existing, incoming, (row) => row.tag, 'if-absent', compareReleaseRows)`, keyed on `tag` instead (see §3.1's caveat on why releases needs a different key). Both share the same `'if-absent'` guarantee regardless of key. This is a structural requirement, not a style choice: the daily collector writes `stars.csv`/`forks.csv` from the repo object's **live counters** (`stargazers_count`, `forks_count`), which correctly reflect someone who starred and later unstarred. Backfill reconstructs the same series from `/stargazers`' `starred_at` field, which lists only **current** stargazers — anyone who starred and later unstarred is permanently invisible to it. The two methods measure the same date differently by construction, and the collector's measured value is the one that was actually true on that date. Running backfill against an archive with months of collector-written history therefore changes nothing for any date (or, for `releases.csv`, any tag) the collector already covered; it only fills gaps neither process has ever recorded. This is the one property `backfill.test.ts` exists to pin down.

`backfill()` is permitted to touch exactly `stars.csv`, `forks.csv`, and `releases.csv` (the `WRITABLE` constant in `backfill.ts`). It never opens `traffic/*` (no historical traffic API exists at all) or `repo.csv` (`subscribers` has no historical API either — a stray rewrite there would be a permanent, unrecoverable loss) or `contributors.csv` (the `/stats/contributors` weekly buckets the daily collector reads already cover all of history whenever that endpoint answers, so there is no gap for a one-shot backfill to fill).

### 4.3 No zero-filling

Nothing in this package ever writes `0` to stand in for "not measured." `repo.csv.downloads_total` is left as a blank CSV field (`null` in memory) when the optional `/releases` fetch fails, specifically so a missing measurement can never be mistaken for a real zero download count. A version that instead carried the previous run's value forward under today's date was considered and rejected during review: a flat line in that case would be indistinguishable from a genuinely quiet day, whereas a hole in the data is visible and honestly represents "we don't know." The same principle governs the dimensional files (§3.2, a dropped-out referrer is an absent row, never a zero) and `getStats()` (§6, a persistent 202 is `null`, never a zero).

The rule has a counterpart that `workflows.csv` is the first series to exercise: **a measured zero must not be hidden either.** The Actions list endpoint is asked for a date range and answers it completely, so a day inside the requested window with no runs is a day this collector measured and found empty. Writing no row for it would render on the chart as collector downtime — the same class of lie, pointed the other way. So `countByDay` (`series.ts`) emits a row for every day in the range it is given, zeros included, and the caller owns the claim that the range was fully observed. Contrast the traffic endpoints, which omit a zero-traffic day entirely: there, absence really is "not measured", which is why the two series must never share a fill rule.

### 4.4 Self-healing (traffic only)

The traffic window is 14 buckets wide, so any gap of **≤13 full days** without a successful run is silently repaired the next time `collect()` runs — the next successful fetch's window simply covers the missed dates again, and `upsertByDate`'s overwrite mode fills them in. A missed cron, a transient API outage, or a rejected push therefore costs nothing as long as the next run succeeds within two weeks. As established in §4.1, this self-healing property belongs to `traffic/*` specifically and does not extend to `stars.csv`, `forks.csv`, or `repo.csv`.


### 4.5 Workflow runs are counted over a window, and never subtracted from clones

`workflows.csv` exists because GitHub counts every `actions/checkout` in the clone statistics (§3.1), so the clone line is partly a picture of this project's build pipeline. Two properties keep it honest.

**It is collected over a trailing 14-day window, not for `today` alone.** The collector runs mid-morning UTC, so the current day's run count is always partial. Counting only `today` and never revisiting it would freeze every day at whatever fraction had happened by ~10:00 — a uniform understatement nothing downstream could detect. The window matches the traffic window it is compared against, the fetch is bounded server-side with `created=>=`, and the merge is `'overwrite'`, so yesterday's partial count is replaced by its complete one on the next run. Re-counting a settled day writes an identical value, so this costs no extra diff.

**Backfill stops at the oldest surviving run.** GitHub deletes workflow runs once they pass the repository's retention period (90 days by default). Reconstructing a day older than the oldest run still returned would write a confident `0` for a day whose evidence has been destroyed — a fabricated measurement, indistinguishable ever after from a genuinely quiet day. Inside the surviving span the zeros are sound, because retention deletes uniformly by age: if the oldest surviving run is still present, no later day has lost runs. Below that date the reconstruction writes nothing, leaving a gap, which is the truthful encoding.

**The two series are never combined.** No "clones minus estimated CI" figure is published anywhere. The relationship is not a stable coefficient — measured on this repository, 218 successful checkout steps accompanied 155 clones on one day and 180 accompanied 189 on another — so a corrected number would be a model, on a page whose entire claim is that every figure was measured. Both series are plotted on a shared axis, as separate stacked charts rather than one dual-axis chart, precisely so the co-occurrence is visible without inviting a ratio to be read off them.
---

## 5. The 202 problem

`GET /repos/{slug}/stats/contributors` computes its answer asynchronously. While GitHub is still building the statistic, the endpoint answers `202` with an effectively empty body rather than `200`. `github.ts`'s `getStats()` is the only client method built to handle this:

- On a `202`, it retries with a backoff (`2000 * (attempt + 1)` ms between attempts, up to `statsAttempts` times — 5 by default) and never parses the placeholder body.
- If every attempt still comes back `202`, `getStats()` returns `null`. **`null` is the only way this method reports "not available yet"** — the success branch only ever produces a value by parsing a genuine `200` body, so there is no path from an in-progress computation to a zero-shaped result.
- In `collect()`, a `null` from `getStats()` causes `contributors.csv` to be skipped for that run, leaving whatever value the file already holds untouched. It is treated as optional for atomicity purposes (§4.1): a stats timeout must never abort the traffic write, since traffic is the irreplaceable series.

GitHub's `/stats/*` cache is keyed by the default branch's current commit and is invalidated by every push to it — so on an actively-developed repo, hitting a `202` is routine, not an edge case, and every collection run should be expected to occasionally skip `contributors.csv` for a day.

**`/stats/contributors` returns at most 100 contributors.** This is undocumented behavior of the GitHub endpoint itself, not of anything in this package: once a repo has more than 100 total contributors, the 101st and beyond simply never appear in the response, and `contributors.csv`'s cumulative count silently stops increasing at 100 forever — indistinguishable on the chart from a genuine plateau in new-contributor growth. There is no workaround; the endpoint has no pagination for this list.

---

## 6. Field-name traps

These are documented because reading the obviously-named GitHub field would silently produce wrong data, and nothing in the type system catches it:

- **`watchers_count` is a duplicate of `stargazers_count`, not the watcher count.** `repo.csv`'s `subscribers` column is populated from `subscribers_count`, the actually-correct field — the collector never reads `watchers_count` at all (`RepoResponse` in `collect.ts` declares only `stargazers_count`, `forks_count`, `subscribers_count`, and `open_issues_count`).
- **The repo object's `open_issues_count` includes open PRs.** `repo.csv.open_issues` carries that combined meaning — GitHub does not separate the two in this field.
- **`/stargazers` requires the custom media type to return `starred_at` at all.** `backfill.ts` requests it with `Accept: application/vnd.github.star+json`; without that header the endpoint returns bare user objects with no timestamp, and `toDate()` would throw on every entry. Listing stargazers at all is gated to repo admins/collaborators as of a GitHub platform change — `METRICS_TOKEN` satisfies this because it belongs to a repo admin, not because star lists are openly public.

---

## 7. Token and branch-protection setup

**Both are in place on `TheZwiss/backspace`** as of 2026-09-01: the `METRICS_TOKEN` repository secret exists, and the `metrics-data` branch carries the `Protect metrics data store` ruleset (`deletion` + `non_fast_forward`, no bypass actors). The archive has been collecting since that date. This section stays because both are one-time, manual GitHub settings that no code in this repository can create — a fork, a transfer, or a re-created repository has to redo them, and until they exist `metrics.yml` and `backfill.yml` fail on every run.

1. **Create a fine-grained personal access token**, scoped to this repository only, with:
   - **Administration: read** — the traffic endpoints (`/traffic/views`, `/traffic/clones`, `/traffic/popular/referrers`, `/traffic/popular/paths`) require this permission specifically, and it is the exact documented requirement for all of them.
   - **Contents: read** — needed to read the repo object and its release/star/fork data.
   - **Actions: read** — needed for `/actions/runs`, which backs `workflows.csv` (§4.5). **Added after the token was first issued**, so an existing `METRICS_TOKEN` will not have it: without this permission the runs fetch 403s, the collector skips the series (it is optional, so the run still succeeds and every other series is written) and `meta.json` lists `workflows.csv` under `skipped`. The CI chart then renders its "no measurement falls inside this window" note rather than a line. Grant the permission on the existing token; nothing needs to be re-created and no data is lost, because backfill can reconstruct the series as far back as GitHub still retains runs.
2. **Store it as the `METRICS_TOKEN` repository secret** (Settings → Secrets and variables → Actions → New repository secret).
3. **Create a branch protection ruleset on `metrics-data`** blocking **deletion** and **force-push (non-fast-forward)**, with **no bypass actors**. `gh ruleset list` on this repo shows the two precedents: `Protect CLA signature store` and, for this branch, `Protect metrics data store`. Do **not** require pull requests or status checks — both workflows commit directly to the branch, and requiring a PR would break every run. This branch is the only place in the repository holding genuinely irreplaceable data (the traffic history), so it is the one branch that most needs this protection.

**Why `GITHUB_TOKEN` cannot substitute for `METRICS_TOKEN`:** there is no `administration` key in the Actions `permissions:` vocabulary at all — not "read" nor any other level — so no configuration of the built-in token can reach the traffic endpoints. The split is forced by GitHub's own permission model, not a security preference that could be relaxed.

`cli-support.ts`'s `assertHeaderSafeToken()` validates the token for control characters (a stray newline, tab, or other C0/DEL byte) **before** it is ever used to build an HTTP header. This exists because a malformed token reaching Node's `fetch`/`Headers` implementation throws a `TypeError` whose message embeds the entire broken header value — including the secret — verbatim, and this CLI's top-level catch prints whatever any thrown error says to the (public) Actions log. If `metrics.yml` fails immediately with a message about a "control character," the token was pasted with a trailing newline or similar and needs to be re-entered as the secret's raw value.

---

## 8. The 60-day schedule hazard

GitHub disables a repository's scheduled workflows after 60 days with no activity on the repository. This collector's own commits do not reliably reset that timer: they land on the orphan `metrics-data` branch (not the default branch) and are made with `GITHUB_TOKEN`, and whether a non-default-branch push counts as "activity" for this purpose is undocumented. Every commonly-suggested keepalive trick assumes commits to the default branch, which this workflow deliberately never makes.

The mitigation is active rather than passive: the final step of `metrics.yml`'s `collect` job runs

```yaml
gh workflow enable metrics.yml --repo "${{ github.repository }}" || true
```

unconditionally (`if: always()`), on every run, using `GITHUB_TOKEN` with `actions: write` permission. This is idempotent — re-enabling an already-enabled workflow is a no-op — and the `|| true` means a permissions problem with this specific call can never fail the whole run over what is meant to be a self-heal step (though it does mean a failure here is silent unless someone is watching the step log).

The dashboard carries a staleness banner as a partial second backstop (§10.6): it compares `meta.last_run` against the bundle's own `generated_at` and warns above 48 hours, and it warns unconditionally whenever `meta.error` is non-null. **Partial, and the limit is exactly the failure mode this section is about.** The banner's reference clock is `generated_at`, not the visitor's clock, so it only fires once something rebuilds the bundle after the collector stalled. If the schedule is disabled, `metrics.yml` never runs, `deploy-dashboard` never runs, and the published bundle freezes with both timestamps close together — a page that looks healthy because nothing is measuring the gap. A push under `site/**` or a `workflow_dispatch` of `deploy-pages.yml` rebuilds the bundle and makes the banner fire.

So the reliable check for this specific hazard is still `meta.json`'s `last_run`/`last_success` on the tip of `metrics-data`, read by hand or by a script. The banner is not a nightly backstop for either case: `deploy-dashboard` carries `needs: collect` (§10.5), so a collector that is merely failing stops the republish just as surely as one that stopped being scheduled, and in both cases the banner stays silent until something else rebuilds the bundle.

---

## 9. Operations

### Running collection locally

```bash
METRICS_TOKEN=<fine-grained PAT> \
GITHUB_REPOSITORY=TheZwiss/backspace \
METRICS_DATA_DIR=/path/to/a/checkout/of/metrics-data \
node scripts/metrics/src/cli-collect.ts
```

All three environment variables are required (`requiredEnv` in `cli-support.ts` throws immediately if any is missing, empty, or whitespace-only). `METRICS_DATA_DIR` must point at a directory containing (or where you want created) the series files described in §3 — normally a local checkout of the `metrics-data` branch. Requires Node ≥22.18 for unflagged type stripping (the package's `engines` field); the workflow itself pins Node 24. This has not been exercised against the live API as part of writing this document — it is a direct read of what `cli-collect.ts` requires, not a verified live run.

### Running a backfill

Either dispatch `backfill.yml` from the Actions tab (or `gh workflow run backfill.yml`), or run it locally the same way as collection:

```bash
METRICS_TOKEN=<fine-grained PAT> \
GITHUB_REPOSITORY=TheZwiss/backspace \
METRICS_DATA_DIR=/path/to/a/checkout/of/metrics-data \
node scripts/metrics/src/cli-backfill.ts
```

Safe to run at any time, including repeatedly — every write is if-absent (§4.2), so no value a rerun disagrees with is ever replaced. "Changes nothing" is the normal outcome but not a guarantee: a rerun still *adds* rows for dates no writer has ever recorded, so an archive seeded before the fill described in §3.1 gains its quiet days on the next dispatch (that is how the existing archive was brought forward), and a collector-era gap gains a row it is better off without — see §9 before dispatching against an archive with collector history in it. The CLI's summary line is deliberately phrased "backfill target files (write-if-absent, listed whether or not they changed this run)" rather than "wrote," because `backfill()`'s `written` result is the fixed, exhaustive list of files it is *permitted* to touch, not the set that actually gained a row this run — see `formatBackfillSummary` in `cli-support.ts`.

One asymmetry to know before dispatching for `workflows.csv` specifically: unlike stars and forks, whose evidence (`starred_at`, `created_at`) is permanent, workflow runs are **deleted at the retention horizon**. A backfill run today reconstructs further back than one run in three months will, and the days it can no longer reach are gone for good. If the CI series matters, the useful dispatch is the earliest one, not the most convenient one. Everything it does write is still if-absent, so it remains safe to repeat.

### Building the dashboard bundle locally

```bash
METRICS_DATA_DIR=/path/to/a/checkout/of/metrics-data \
METRICS_OUTPUT_PATH=/tmp/data.json \
node scripts/metrics/src/cli-bundle.ts
```

Two environment variables, both required, both checked by the same `requiredEnv` that guards the other three entrypoints. No token: the bundler reads the archive off disk and never touches the network.

- `METRICS_DATA_DIR` is the archive root — the same variable `cli-collect.ts` and `cli-backfill.ts` read.
- `METRICS_OUTPUT_PATH` is a **file** path, not a directory. It is resolved against the process working directory, and its parent is created recursively. Point it somewhere outside the repo unless you actually want to preview the page, since `site/insights/data.json` is gitignored precisely so the artefact never lands in a commit.

Two lines on stdout, and a third on stderr only if the bundle is at or above the 80 % warning mark (§10.3). Real output, run against a fresh clone of `metrics-data` on 2026-09-02 — the two counts and the byte total grow with the archive, so treat them as the shape rather than as values to match:

```
archive /path/to/metrics-data: since 2026-02-15 — 14 days of views, 1 releases
wrote /tmp/data.json: 3550 bytes of the 2097152-byte budget (downsampled: no, daily)
```

**"Missing" means two different things here, with opposite outcomes. Do not conflate them.**

- **A missing archive *directory* is the empty case, not an error.** `METRICS_DATA_DIR` is set, but nothing exists at that path: the bundler exits **0** and writes a valid `empty: true` bundle, because `store.read` collapses `ENOENT` — and only `ENOENT` — to "absent". This is the behaviour `deploy-pages.yml` depends on when the `metrics-data` branch does not exist (§10.5).
- **A missing *environment variable* is an error.** Either variable unset, empty, or whitespace-only fails `requiredEnv` before anything is read, and the bundler exits **1** with `Missing required environment variable <NAME>` — the empty and whitespace-only cases adding `(present but empty or whitespace-only)`.

Every other failure also exits non-zero and fails the deploy: an unreadable directory (`EACCES`), a data dir that is really a file (`ENOTDIR`), a corrupt CSV, or a bundle still over budget after downsampling.

To preview the page itself, write the bundle to `site/insights/data.json` and serve `site/` over HTTP — the page fetches `data.json` relative and same-origin, so a browser will block the request from a `file://` page.

### Recovering from a gap

A gap of **13 days or fewer** in traffic data self-heals automatically the next time `collect()` succeeds — no action needed (§4.4). A gap of **14 days or more** in traffic is permanent; there is nothing to backfill it with.

A gap in `releases.csv` (however it happened) can be recovered by dispatching `backfill.yml`: `published_at` is a permanent, immutable timestamp on every release, so reconstructing from `/releases` produces the exact same rows the collector would have written, for any date range.

**A collector-era gap in `stars.csv`/`forks.csv` is *not* recoverable, and dispatching `backfill.yml` will not fill it correctly — despite `backfill.yml` being permitted to write both files.** Two separate problems make this true, and both are inherent to the reconstruction, not implementation bugs to be fixed later:

- `cumulativeByDay` (`backfill.ts`) writes a row for **every** date from the first event through the run date, quiet days included (§3.1). A dispatch will therefore now *fill* a collector-era gap rather than leave it visibly absent, which is the opposite of what an earlier version of this document promised. Read the next bullet before dispatching: filling such a gap is the hazard, not the remedy.
- The value backfill writes comes from `/stargazers`/`/forks`, which list only **currently** starred/forked state. Anyone who starred and later unstarred (or forked and later deleted the fork) is invisible to it. The collector's original row — lost in the gap — measured the live counter as it stood on that date, which can only be greater than or equal to what a reconstruction sees. A backfilled row for a gap date is therefore, at best, an undercount, and at worst a value that makes an otherwise-monotonic series dip on a chart — reading as genuinely measured history rather than as the reconstruction gap it actually is.

This is not a defect in `backfill()` itself: reconstructing pre-collection history (seeding the archive before `collect()` ever ran) is exactly what it is for, and it does that correctly. Note what changed and what did not. The dense fill removed one protection — a quiet-day gap in the collector era used to survive a dispatch untouched, and now it does not — and it removed nothing else: the value written into such a gap was always a possible undercount, on any date backfill reached. The archive carries no marker for where the reconstructed era ends and the collector era begins (`meta.json` records `series_last_date`, never a first date), so `backfill()` cannot enforce that boundary itself and this warning is the only thing holding it. The hazard is specifically in treating it as a generic gap-repair tool for `stars.csv`/`forks.csv` after the fact — it is not one, for either of the two reasons above. A gap in `repo.csv` (`subscribers`) or `contributors.csv` cannot be backfilled at all — the next successful collection run simply resumes from wherever it left off, with no way to fill the missed dates retroactively.

### Triaging a red `metrics.yml` run

A red run on this workflow used to mean one thing. Since `deploy-dashboard` was added it means one of two, and they have different consequences: a failed **collection** may have cost a day of traffic history permanently, a failed **deploy** cost nothing but a stale published page. GitHub emails the repository owner on scheduled-workflow failures either way, so the first job is telling them apart.

**Open the run and look at which job is red.**

- **`collect` red.** A genuine collection failure. `deploy-dashboard` will show as skipped — `needs: collect` carries an implicit `success()`, so a failed collection never deploys off nothing. Read `meta.json` on `metrics-data`: the "Record failure" step should have written `error` with the run URL, and `last_success` tells you how old the newest trustworthy figures are. §4.4 says whether the gap self-heals.
- **`collect` green, `deploy-dashboard` red.** The measurement landed and was pushed *before* `deploy-dashboard` started, so nothing was lost and nothing needs re-running for the archive's sake. Confirm it: `meta.json`'s `last_success` advanced and `error` is `null`. The published dashboard is one day stale until the next successful deploy; re-run the failed job, or dispatch `deploy-pages.yml`, to fix it immediately.
- **Both green but the run is still red.** Not a state this workflow produces. Check the run for a cancelled job — a cancellation or a job timeout does not run the `if: failure()` failure path at all, so `meta.json` is untouched and `error` can read `null` for a run that never completed. `last_run` is the field that catches that.

**Three outcomes that are expected and not worth chasing:**

- **A `workflow_dispatch` from a branch other than `main`.** `collect` runs and pushes normally; `deploy-dashboard` is then refused at the `github-pages` environment gate, whose branch policy allows only `main` and `gh-pages`, and the run goes red. That is the platform reporting a policy accurately. It is deliberately not guarded with an `if:` on the ref: that would duplicate a policy stored in repository settings this file cannot read, and would silently skip the deploy if the policy ever changed. Scheduled runs always execute on the default branch, so the nightly path never reaches this.
- **A fork.** `collect`'s `if: ${{ !github.event.repository.fork }}` skips the job, and GitHub skips the dependents of a skipped job, so `deploy-dashboard` skips too. The run is neutral, not red.
- **A no-op collection.** When there is nothing to commit, `collect` still exits 0 and `deploy-dashboard` still runs, republishing an identical site with a fresh `generated_at`. Harmless and idempotent; it means one `github-pages` deployment per day forever.

### What a rejected push means

`metrics.yml`'s commit-and-push step retries a rejected (non-fast-forward) push up to three times, running `git pull --rebase origin metrics-data` between attempts, and fails the job loudly if all three are rejected. `backfill.yml`'s commit-and-push step does **not** have this retry loop — it pushes once and fails on rejection. This asymmetry is intentional given the shared `concurrency: { group: metrics-data, cancel-in-progress: false }` on both workflows: that group already serializes the two workflows so they never run at the same time, which is the scenario the retry loop exists to survive. A push rejection on `metrics.yml` in practice means something *external* to these two workflows wrote to `metrics-data` (a manual commit, a ruleset bypass, direct API use) between checkout and push; a rejection on `backfill.yml` means the same, and the fix in both cases is to re-run the workflow.

### Reading `meta.json`

See §3.3 for the two-writer (one per outcome) mechanics. In short: fetch `meta.json` from the tip of `metrics-data` and check `error` — `null` means `collect()` itself last wrote this file, with `last_success` set to that run's timestamp; any other value is a `run <job status> — <run url>` string recorded by the failure path (`recordFailure()`/`cli-record-failure.ts`) for the most recent run that did not succeed, and `last_success`/`series_last_date` in that case still reflect whatever the last *successful* `collect()` run left them at — the failure path never touches either. `series_last_date` gives the newest date present in each `.csv` file as of the last run that actually wrote it (a written series advances to today; a skipped one keeps its previous entry — see §3.3), which is a faster way to spot a stalled series than diffing the files themselves.

**`error` alone is not sufficient — always read it together with `last_run`.** The failure path runs
under `if: failure()`, which does not cover a job that was **cancelled or hit its timeout**. Those runs
leave `meta.json` completely untouched: `error` stays whatever it was, so a run that never happened can
read as `null` — "last night succeeded" — when in fact nothing ran at all. The reliable check is
`last_run` against the current date. If `last_run` is not from the most recent scheduled window, that
run did not complete, regardless of what `error` says.

A second case where `meta.json` cannot tell you what went wrong: if `meta.json` itself is corrupt, both
writers refuse it. `collect()` reads it through the same validator before writing anything, and
`recordFailure()` reads it the same way — so neither can record "meta.json is corrupt" *inside*
`meta.json` without performing exactly the unvalidated rewrite this design exists to prevent. The
symptom on the data branch is only that `last_run` stops advancing; the cause is visible in the Actions
tab, where both steps go red every day. This is a deliberate consequence of failing loudly rather than
fabricating a replacement, not an oversight.

One case worth naming explicitly: `error` can be non-null while `last_success` is recent. That happens when `collect()` itself succeeds but a later step in the same job fails (e.g. the data commit/push, after all three retry attempts) — the failure path still runs and records `error`, but `last_success`/`series_last_date` correctly show that the measurement itself landed; only getting it committed and pushed did not.

---

## 10. The dashboard

`site/insights/index.html` is the public read side of the archive, published by GitHub Pages at `https://thezwiss.github.io/backspace/insights/`. It is **one HTML file** with its CSS and JavaScript inline, plus two vendored uPlot files next to it (§10.4). No framework, no bundler, no build step, no network request of any kind except the single relative, same-origin `fetch("data.json")` — which is aborted at 15 seconds.

Five sections, each registered against a slot and re-rendered on every range change: **at a glance** (eight cards — stars, forks, watchers, views, clones, contributors, app downloads, update checks; the clones card carries a standing note that CI checkouts are counted in it), **reach** (views, clones, and this repository's own CI activity), **growth** (stars and forks, annotated with release markers), **referrers**, and **paths**. The range control offers `30d`, `90d`, `1y` and `all`, defaulting to `all` — the only one that cannot imply a window wider than what was actually measured.

The page has **no automated tests**. It is the untested side of a contract whose other side is heavily tested, which is why §10.2 is written as a contract rather than as a description, and why the page validates the payload strictly before rendering a single figure.

### 10.1 What the archive gives up on the way to the page

The bundler reads the nine archive files described in §3 and emits one JSON object. Three things do not survive the trip, all deliberately:

- **`meta.json`'s `series_last_date` is not published.** It is a per-file resume cursor — collector internals. Shipping it would hand a static page a map of the collector's file layout and invite the page to start depending on it. `DashboardMeta` carries `last_run`, `last_success` and `error`, and nothing else.
- **Most of the dimensional history is discarded.** The archive holds every row of every snapshot; the bundle keeps only the *latest* snapshot's ranking plus a differenced trajectory for its top five dimensions, per file. Everything else in `referrers.ndjson`/`paths.ndjson` exists only on the `metrics-data` branch.
- **Daily resolution of the six dated series, but only under pressure.** They are published day-by-day until the bundle would exceed its size budget, at which point every one of them is reduced to weekly buckets (§10.3). `releases` and `dimensions` are never bucketed.

`bundle.ts` also declares its own types rather than reusing `types.ts`. `types.ts` describes what the collector writes; `bundle.ts` describes what the page reads. They coincide today — a `ReleaseEntry` and a `ReleaseRow` are the same three fields — but they are two contracts with two consumers, and the page must not silently acquire a field because a collector type grew one.

### 10.2 The `data.json` contract

`scripts/metrics/src/bundle.ts` is authoritative. Reproduced here so a change to one can be checked against the other:

```ts
interface DashboardData {
  /** ISO timestamp (with milliseconds) the bundle was generated. */
  generated_at: string;
  /** Earliest date present in ANY of the six dated series, or null. */
  collection_started: string | null;
  /** From meta.json, or null when the archive has none. */
  meta: { last_run: string; last_success: string | null; error: string | null } | null;
  /** True when the archive is missing or holds no rows at all. */
  empty: boolean;
  /** True when the WHOLE payload was reduced to weekly buckets to fit the budget. */
  downsampled: boolean;
  series: {
    views: TrafficSeries;  clones: TrafficSeries;
    stars: CountSeries;    forks: CountSeries;   contributors: CountSeries;
    repo: RepoSeries;
    workflows: WorkflowSeries;
  };
  releases: Array<{ date: string; tag: string; name: string }>;
  dimensions: { referrers: DimensionSeries; paths: DimensionSeries };
}

/** Parallel arrays, index-aligned with `dates`. */
interface TrafficSeries { dates: string[]; count: Array<number | null>; uniques: Array<number | null>; }
interface CountSeries   { dates: string[]; total: Array<number | null>; }
interface WorkflowSeries{ dates: string[]; runs: Array<number | null>; }
interface RepoSeries    { dates: string[]; subscribers: Array<number | null>;
                          open_issues: Array<number | null>; downloads_total: Array<number | null>;
                          downloads_app: Array<number | null>; downloads_updates: Array<number | null>; }

interface DimensionSeries {
  /** Snapshot dates, ascending. */
  snapshots: string[];
  /** The most recent snapshot's rows, count descending, dimension ascending as the tie-break. */
  latest: Array<{ dimension: string; title: string; count: number; uniques: number }>;
  /** Top 5 dimensions of `latest` only, differenced between CONSECUTIVE snapshots. */
  trajectories: Array<{ dimension: string; delta: Array<number | null> }>;
}
```

**`null` means "not measured". `0` means "measured as zero".** This is the rule the whole subsystem exists to enforce, and it holds at every layer without exception:

| Layer | How absence is written | The trap it avoids |
|---|---|---|
| Collector | blank CSV field, never `0` (§4.3) | a failed `/releases` fetch reading as zero downloads |
| Bundle read | `toNumberOrNull` returns `null` for a blank *or absent* column | `Number('')` and `Number('   ')` are both `0` |
| Weekly buckets | `sumBucket` starts at `null`, not `0` (§10.3) | "the collector did not run that week" becoming "that week had no traffic" |
| Dimensions | a missing dimension yields `null`, never `0` | a referrer dropping out of the top 10 reading as zero referrals |
| Page | `null` and an absent row both break the line; a measured `0` plots as `0` | a real zero rendering as a gap |

A field that is present, non-blank, and does not parse is **corruption, not absence**, and throws. Substituting `null` there would quietly downgrade a damaged file to "not measured" and publish the gap as though it were real.

**Two invariants the page depends on that `validateBundle` deliberately does not enforce.** `validateBundle` (in `site/insights/index.html`) checks types and length alignment for every array a renderer indexes into, because the page is the untested side. It stops short of these two:

1. **`trajectories[].delta[0]` is always `null`.** There is no snapshot before the first to difference against. A number there would be a difference taken against nothing — a figure the archive cannot hold.
2. **A dimension absent from a snapshot yields `null` at that index *and at the one after it*.** The second null is the less obvious half and matters just as much: differencing a present value against a missing one has no defined answer, and both ways to fake one are fabrications. Reaching back past the gap reports a multi-snapshot change as a single-step one; treating the missing value as `0` invents a jump the size of the whole window.

Neither is checked, and that is a decision rather than an oversight: rejecting a whole bundle over a cosmetic contract violation would trade it for a total outage — a blank page where a slightly wrong chart would have done. The invariants are instead enforced where they are consumed. `buildLines` in the movement section drops a non-null `delta[0]` to `null` rather than plotting it, and raises a caution line naming the dimension, so a fabricated figure is neither published nor hidden.

**`validateBundle` does not range-check `snapshot_date` either**, and that has a visible consequence worth knowing before it is diagnosed as a page bug. A single implausibly far-future snapshot date passes validation, then extends the movement chart's axis to reach it, via the `snapshotWindow` mechanism described immediately below. The axis builder caps itself at 20 000 steps — roughly 55 years of daily steps — and reports an overrun rather than throwing, so the section draws nothing and says why. The result is that **one corrupt date suppresses the movement charts**, and the fault is in the data, not in the page.

**`downsampleWeekly`, `rangeWindow` and `snapshotWindow` are one mechanism in three parts. Do not "fix" any of them in isolation.**

- `downsampleWeekly` buckets the six dated series onto their UTC Monday and leaves `dimensions` **unbucketed**, on their own daily snapshot dates. Bucketing them would silently redefine "the difference between consecutive snapshots" into something else with the same name.
- `rangeWindow` anchors every window on the newest **dated series** row, deliberately excluding dimension snapshots, so a trailing 14-day aggregate cannot stretch a window past the last real daily measurement.
- Those two are compatible on a daily bundle, where the two dates coincide. On a **downsampled** bundle they are not: series dates become Monday bucket keys while snapshots keep their daily dates, so the newest series day can sit up to six days *before* the newest snapshot. In the fixture that found this, every snapshot in the trailing partial week fell outside every window, `all` included — both dimension sections drew nothing, reported "N of the M the archive holds", and offered "a wider range takes in more", which no range did.
- `snapshotWindow` exists to close exactly that gap. It extends only the **end** of the shared window, and only as far as a snapshot that actually exists; the start is left where the range control put it, and `extendedFrom` is set so the section states that the axis runs past the range's anchor rather than quietly drawing a wider span than the control implies.

### 10.3 The 2 MB budget

`BUNDLE_BUDGET_BYTES` is `2 * 1024 * 1024` = **2 097 152 bytes**, measured as the UTF-8 byte length of the serialised JSON, **uncompressed**, and the check is inclusive (`bytes <= BUDGET` passes).

Uncompressed on purpose. Pages serves the file gzipped, so a visitor downloads less — but the number that decides whether the page is usable is the one the browser must parse and hold in memory. Measuring the compressed size would also make the budget depend on how well one particular archive happens to compress, which is not a property of the dashboard. Bytes come from `Buffer.byteLength`, not `String#length`, which counts UTF-16 code units and would under-count an emoji or an accent in an upstream referrer title.

`serialiseWithinBudget` runs one fixed sequence:

1. Build the daily bundle, serialise it, measure it.
2. Under budget: publish it, and report `data.downsampled` rather than a hardcoded `false` — a caller that already downsampled must not have that erased on the way out.
3. Over budget: downsample to weekly buckets, re-serialise, re-measure.
4. Still over budget: **throw**.

Downsampling only on failure is the point of the order. Doing it unconditionally would publish weekly buckets for the many years this archive will spend comfortably under 2 MB, throw away resolution nobody needed to save, and light up the page's "weekly" label over data that is daily.

**Weekly bucketing applies a different rule to each group of fields, and the first two must never be swapped:**

- **Traffic counts sum within a bucket** (`sumBucket`): `views` and `clones`, both `count` and `uniques`. `uniques` summing is an acknowledged over-count — someone who visited Monday and Thursday is counted twice, and a true weekly unique figure is not recoverable from daily rows at any resolution — but it is an upper bound that moves with the quantity it describes, where taking the last day's uniques would report one day as if it were seven.
- **Cumulative counters take the week's last measured value** (`lastBucket`): `stars`, `forks`, `contributors`, and every field of `repo`. Summing these would be meaningless in a way that looks entirely plausible on a chart — seven daily readings of a star count that sat at 66 all week would publish 462 stars. "Last **measured**", not "last element": a week whose final days are null was still measured earlier in the week. The pick is by highest *date*, not highest index.
- **`releases` and `dimensions` are not bucketed at all.** Releases are sparse, so there is no space to save, and merging two tags published in one week into one marker would destroy the annotation the growth chart exists for. Dimensions are already bounded at top-10-per-snapshot.
- **`collection_started` and `empty` are carried through, not recomputed.** A first measurement on a Wednesday buckets under the preceding Monday, and recomputing from the bucket keys would back-date the page's "since <date>" label onto a day on which nothing was measured. A bucket key labels a week; `collection_started` is a claim about a measurement.

**The 80 % warning.** `BUNDLE_WARN_BYTES` is `Math.floor(BUNDLE_BUDGET_BYTES * 0.8)` = **1 677 721 bytes**. At or above it, `cli-bundle.ts` prints `budgetWarning`'s message to **stderr** as the last line of an otherwise-green run, and the build still passes. The threshold is picked from what the archive actually does rather than from habit: it grows by roughly 68 KB a year, so the 419 431 bytes between the mark and the budget are about **six years** of lead time — enough to schedule the decision instead of meeting it as a fait accompli in a deploy log. A lower mark would fire for a decade before it meant anything, and a warning nobody reads by the time it matters is not a warning. The message says which side of the cliff the bundle is on, because the next event differs: a daily bundle nearing the budget gets downsampled, while a bundle that is *already* weekly has no reduction left and the next step is a failed build.

**The throw is the designed terminal state, not a gap in the design.** Nothing is ever truncated to fit: dropping the oldest history would silently destroy the only surviving copy of data GitHub deletes after 14 days, which is what this archive exists to prevent, and publishing an oversized bundle moves the regression from a red CI run to a visitor's first paint. **`dimensions` is the unbounded component.** Every other part of the payload is either bounded or downsamplable. Within `dimensions`, two of the three parts are bounded: `trajectories` at five per file by `TRAJECTORY_LIMIT`, and `latest` by GitHub's own top-10-per-snapshot response shape (§3.2) rather than by any cap in this package. The third is not. `snapshots` gains one element per day forever, every trajectory's `delta` gains one alongside it, and weekly bucketing cannot touch either without redefining what a trajectory means. So the error message names the right lever — cap the release list or the dimension history, or raise the budget deliberately — rather than suggesting a reduction that does not exist. At the live bundle's current size the mark is over two decades away.

### 10.4 Vendoring

uPlot is committed to the repository rather than installed, at **1.6.32**, as `site/insights/vendor/uplot.min.js` and `site/insights/vendor/uplot.min.css`. The page loads them by relative path, so a published dashboard depends on no CDN and no third-party host at runtime.

`scripts/metrics/vendor.json` records, per package, the exact `version`, the immutable npm tarball URL it was fetched from (`https://registry.npmjs.org/uplot/-/uplot-1.6.32.tgz`), the `license`, and a map of committed file path to the SHA-256 of that file's bytes, prefixed `sha256-`. `src/vendor-check.test.ts` reads the manifest and asserts, for every entry, that the file exists and hashes to exactly what is recorded. It runs in the package's ordinary `test` script and therefore in CI, and has its own script for running it alone:

```bash
pnpm --filter @backspace/metrics run vendor:check
```

**To update the vendored version:** fetch the new tarball from `registry.npmjs.org`, replace both files verbatim from it, update `version` and `source` in `vendor.json`, recompute both digests (`shasum -a 256 <file>`), and record them with the `sha256-` prefix. The test's failure message says the same thing, because that is when it is read: an in-place edit of a vendored file is not allowed, and a deliberate version bump has to move the recorded hash with it.

**Manifest coverage is opt-in per file, and nothing else guards `site/`.** A file is protected only because someone listed it in `vendor.json`. A second vendored library dropped into `site/insights/vendor/` without a manifest entry is checked by nothing at all — `vendor-check.test.ts` iterates the manifest, not the directory. Adding a dependency to the site means adding its manifest entry in the same change.

### 10.5 Deploy wiring

The dashboard is published by `.github/workflows/deploy-pages.yml`, reached two ways: a push to `main` touching `site/**`, `scripts/metrics/**` or the workflow file itself (a bundler change must redeploy, or the site silently serves stale data); and a `workflow_call` from `metrics.yml`'s `deploy-dashboard` job after a successful collection. Without the second path the collector would update `metrics-data` every night while the published `data.json` was rebuilt only when someone happened to push a site change.

**The archive checkout is conditional and non-fatal.** `actions/checkout` asked for a ref that does not exist hard-fails the job, and no `if:` *inside* that step can rescue it — so the probe has to be a preceding step. An unconditional checkout would break every landing-page deploy until `metrics-data` was created, and permanently again if it were ever deleted.

The probe is `git ls-remote --exit-code --heads origin metrics-data`, against `origin` rather than a `gh api` call on a repo slug, so it stays correct through a rename or transfer and needs no token handling. It has **three** outcomes, not two:

| Exit | Meaning | Action |
|---|---|---|
| `0` | branch present | `present=true`; check it out into `.metrics-data` |
| `2` | talked to the remote, no such branch | `present=false`; `::notice::`, publish the empty state |
| anything else (e.g. `128`) | could not talk to the remote | print git's own error, `::error::`, **fail the job** |

Collapsing the last two into one `else` is the bug this shape exists to prevent: a network blip or an auth failure would publish a blank dashboard over a live archive and log that the branch does not exist — a lie the run would carry all the way to the page. It is the same rule `cli-bundle.ts` follows with `ENOENT` versus every other errno: absent is a fact and gets the empty state; unknown is not, and fails loudly.

The bundle step itself is **unconditional**, because a missing archive directory is the empty case (§9, "Building the dashboard bundle locally"). Both paths are absolute and match `metrics.yml`: `METRICS_DATA_DIR` is `${{ github.workspace }}/.metrics-data`, `METRICS_OUTPUT_PATH` is `${{ github.workspace }}/site/insights/data.json`. `actions/upload-pages-artifact` then uploads `./site`, which by that point carries the generated `insights/data.json`.

**`deploy-dashboard` in `metrics.yml`** is necessarily a separate job. `uses:` is a job-level key, so a reusable workflow cannot be a step inside `collect` even if that were wanted. It also must not be `collect` with a widened grant: permissions in a called workflow are the **intersection** of the calling job's grant and the called workflow's declaration — reducible, never elevatable — so calling from `collect` (which holds `contents: write` and `actions: write` and no Pages scopes) would hand `deploy-pages.yml` `pages: none` and `id-token: none` and fail on the missing OIDC token. Widening `collect` to fix that would give the job that writes the archive a Pages write scope and an OIDC identity it has no use for. `deploy-dashboard` therefore holds a *narrower* grant: `contents: read`, `pages: write`, `id-token: write`.

It carries **no `if:`**, deliberately. `needs: collect` is both gates it wants: a failed collection skips it via the implicit `success()`, and a *skipped* collection skips it too, because GitHub skips the dependents of a skipped job — which is exactly right for the fork case, where `collect`'s own `if:` already declined.

The local reusable-workflow reference `uses: ./.github/workflows/deploy-pages.yml` **carries no SHA and cannot**. GitHub rejects `@ref` on a `./` path and always resolves the file from the calling run's own commit, which pins it more tightly than a SHA would. It is not a missed pin, and the repo's SHA-pinning convention (`docs/systems/security-scanning.md`) does not apply to it. Every `uses:` in both files that *can* be pinned is pinned to a full commit SHA with a trailing `# vX.Y.Z` comment.

**The `pages` concurrency group lives on `deploy-pages.yml`'s `deploy` job**, not at workflow level and not on `deploy-dashboard`. On the job it applies identically however the workflow is reached; GitHub's documentation does not state whether a workflow-level `concurrency` is honoured for a `workflow_call` invocation, and putting the group on the job removes the need for an answer. `cancel-in-progress` is `false`: cancelling `actions/deploy-pages` mid-flight strands a deployment in the `github-pages` environment and blocks the next one.

**`timeout-minutes: 15` on that job — and what it does not bound.** The ceiling exists because `metrics.yml` holds the `metrics-data` concurrency group for the whole duration of the called deploy, and that group is shared with `backfill.yml` and with the collector's own next scheduled run. GitHub's 6-hour default would let one stalled deploy hold the group deep into the next day and, since only one run per group stays pending, delay and then **drop** a scheduled collection. A normal run is 1–2 minutes.

Two limits, stated so they are not rediscovered as surprises:

- **It bounds job execution, not a wait at the `github-pages` environment gate.** A required-reviewer rule or a wait timer on that environment holds the run *before* the job starts, so `timeout-minutes` never applies. That is the one unbounded path left in this subsystem, and it ends in a dropped collection — permanent history loss. **Check the environment for required reviewers and a wait timer before merging, and after any change to repository settings.** As of 2026-09-01 the `github-pages` environment carries a branch policy only (allowing `main` and `gh-pages`), with no reviewers and no wait timer, which is the configuration this design assumes.
- **A timeout cancels the job**, which is the same stranding `cancel-in-progress: false` exists to avoid. If a deploy ever hits the ceiling, check the environment for a stuck in-progress deployment before re-running. Both are accepted: a bounded chance of a stranded deploy beats an unbounded chance of a dropped collection.

### 10.6 Empty state, missing bundle, and the staleness banner

`data.json` is a **build artefact**. It is written into the workspace at deploy time and is gitignored (`site/insights/data.json`); the `metrics-data` branch is the single source of truth and the bundle is never committed. Nothing in the repository holds a copy.

**A 404 on `data.json` and `empty: true` are different conditions and the page says different things about them.** Conflating them would be the page making a claim about data it has not seen.

There is a third, per-chart case worth stating because it is the normal state of any newly added series: a bundle can be perfectly healthy while one series inside it is empty. A series enters the `data.json` contract the moment the collector gains it, but enters the archive only on the next successful collection run, so on the deploy that introduces it there is nothing to plot. uPlot answers that with an empty frame on an invented 0..1 axis — a chart that looks broken while its own caption reads "measured 0 of 15 days". So a chart card whose primary series has no measured step inside the window renders a sentence in place of the plot, and the section still reports the span and the unmeasured count above it. That is also what the CI chart shows if `METRICS_TOKEN` lacks **Actions: read** (§7).

| Page status | Cause | What it says |
|---|---|---|
| `unavailable` | the fetch failed: 404, non-2xx, timeout, unparseable JSON, or a payload `validateBundle` rejected | "The archive is not available here" — the bundle is generated at deploy time and is not committed, so when the archive or the deploy step is unavailable there are no figures, and inventing them would be worse |
| `empty` | the bundle loaded and validated, and `empty` is `true` | "Collection has not produced any rows yet" — the archive holds no traffic, no growth snapshots, no releases; figures appear after the collector's first successful run |
| `ok` | loaded, validated, non-empty | the five sections render |

`empty` is true when all six dated series, `releases`, and both dimension snapshot lists are empty — the state an archive is in immediately after the branch is bootstrapped, when it holds only `meta.json`. Note that `empty` and `collection_started` answer different questions: an archive holding only releases or only dimension snapshots is **not** empty yet has no dated series, so `collection_started` is `null` and the range control has nothing to anchor on.

The **staleness banner** is separate from all three and is evaluated on any bundle that loaded, empty or not. It fails closed — anything it cannot confirm counts as stale, and the reason says which:

- `meta` is `null` (the archive has no collector status file at all).
- `meta.error` is non-null — *any* non-null value, not merely a non-empty string, so a serialised error object or a bare `500` cannot pass as healthy. This raises the banner to its error severity.
- `meta.last_run` is unreadable, or is more than **48 hours** before the bundle's `generated_at`.
- `generated_at` itself is unreadable, in which case freshness is measured against the visitor's clock and the banner says so.

Whenever the banner fires it also reports `last_success`, because when the collector is failing the age of the newest trustworthy figures is the thing a reader actually needs. The reference clock is `generated_at` rather than the visitor's clock on purpose — but see §8 for the failure this cannot catch.

**One thing the bundle carries no evidence of.** A persistent `202` from `/stats/contributors` (§5) makes the collector skip `contributors.csv` for that run without recording an error anywhere. The contributors card and its coverage line therefore **understate** — never overstate — and nothing in `data.json` distinguishes "the count did not move" from "the count was not measured that day". The card's `step` kind exists partly for this: a contributors row is written when the total *changes*, so the age of its newest row says nothing about freshness and the daily-sample staleness test is deliberately not applied to it.

---

## 11. Testing

`scripts/metrics`'s `test` script is `tsc --noEmit && vitest run` — it runs through the existing root `pnpm -r test` step with no `ci.yml` change required, and covers both types and behavior in one script. All tests are fixture-driven and touch no network; filesystem tests use a per-test `mkdtempSync` directory, cleaned up in `afterEach`. As of this writing there are **338 tests across 12 files**, all passing:

```
src/no-runtime-deps.test.ts   9
src/vendor-check.test.ts      6
src/sitemap.test.ts           5
src/datapage.test.ts         14
src/github.test.ts           21
src/backfill.test.ts         22
src/store.test.ts            23
src/summary.test.ts          26
src/collect.test.ts          33
src/cli-support.test.ts      35
src/series.test.ts           55
src/bundle.test.ts           89
```

`bundle.test.ts` is the largest of them because it carries the whole of §10.2's contract: the null-versus-zero rule at every read, the trajectory invariants, the two weekly aggregators, and the budget sequence. `vendor-check.test.ts` is not a unit test at all — it hashes the committed uPlot files against `vendor.json` (§10.4) and has its own `vendor:check` script for running it alone.

**The dashboard page itself has no tests.** `site/insights/index.html` is not exercised by anything in CI; the contract in §10.2 and the page's own `validateBundle` are what stand in for them.

`cli-record-failure.ts` has no dedicated `.test.ts` of its own, matching `cli-collect.ts`, `cli-backfill.ts` and `cli-bundle.ts` — all four are thin `process.env`/clock-reading wrappers with no branching logic of their own to unit-test. Its testable core, `recordFailure()`, is covered in `cli-support.test.ts` alongside the module's other shared helpers; `collect.ts`'s corresponding `series_last_date`-seeding logic is covered in `collect.test.ts`, and `cli-bundle.ts`'s core is `buildDashboardData`/`serialiseWithinBudget` in `bundle.test.ts`.

`no-runtime-deps.test.ts` is worth calling out specifically: it regex-scans every non-test source file in `src/` and fails if any import specifier is not a `node:` builtin or a relative path, if any relative import omits its `.ts` extension, or if any import of `types.ts` omits the `import type` keyword. This is the enforcement mechanism behind two of Node's type-stripping constraints (§13) — without `import type`, Node treats a type-only import as a value import and throws `SyntaxError` **at runtime**, which for this package means a red 03:00 cron rather than a red `tsc --noEmit`. `erasableSyntaxOnly` and `verbatimModuleSyntax` in `tsconfig.json` catch the same class of mistake at typecheck time for constructs `no-runtime-deps.test.ts` doesn't scan for (enums, namespaces with runtime code, parameter properties, decorators).

---

## 12. Adding a repo

The repository slug is never hardcoded: `collect()` and `backfill()` both take `slug` as a parameter, and both CLI wrappers derive it from the `GITHUB_REPOSITORY` environment variable, which GitHub Actions populates from `github.repository`. Nothing in the package assumes `TheZwiss/backspace` specifically.

That said, adding a second repo is not a matter of pointing a second workflow at it. Every file in §3 lives at a **flat path** at the root of `metrics-data` (`stars.csv`, not `<repo>/stars.csv`) — the schema has no per-repo namespacing at all. A second repo needs a file-layout decision made first (a subdirectory per repo slug is the obvious candidate, but it hasn't been decided or built), plus its own `METRICS_TOKEN`-equivalent PAT scoped to that repo, before any workflow could safely write its data without colliding with the first repo's files.

The dashboard inherits that assumption rather than adding one of its own. `bundle.ts` names the nine archive paths as constants and emits one `DashboardData`; `site/insights/index.html` renders one `data.json`. A per-repo layout would need a bundler that takes the prefix as a parameter and either one bundle per repo or a repo dimension in the contract — a §10.2 change, not a configuration change.

---

## 13. Why TypeScript with no build step

The collector has **zero runtime dependencies** — only `fetch` and `node:` builtins — and is executed directly by Node via native TypeScript type stripping, with no `tsc` build step in the run path (`tsc --noEmit` runs only for typechecking, in `test`/`typecheck`). `scripts/metrics/package.json` declares `"engines": { "node": ">=22.18" }`; the workflow's `setup-node` step pins `node-version: 24`.

Two constraints this creates are enforced rather than left to discipline, but by different mechanisms — worth knowing, because only one of them fails at typecheck time:

- **`import type` is mandatory** for any type-only import. Omitting it makes Node treat the import as a value import, which throws `SyntaxError` at runtime. `verbatimModuleSyntax` in `scripts/metrics/tsconfig.json` catches this at typecheck time, and `no-runtime-deps.test.ts` catches it again.
- **Relative import specifiers must carry the `.ts` extension** (`import './series.ts'`, never `'./series'`). This one has **no compiler enforcement**: `allowImportingTsExtensions` permits the extension but does not require it, so a missing `.ts` typechecks cleanly and only fails when Node runs the file. The regex scan in `no-runtime-deps.test.ts` (§11) is the only thing that catches it before then.

Unsupported by type stripping and therefore avoided throughout the package: enums, namespaces with runtime code, parameter properties, import aliases, decorators.

---

## 14. Volume

Not independently re-measured for this document; carried forward from the design spec's measurement against the real API responses at the time it was written (`docs/superpowers/specs/2026-08-25-repo-metrics-design.md`, §5.5): roughly 815 KB/year across all files combined, dominated by the two NDJSON files. At that rate the archive stays well under a size where the plain-text-over-SQLite tradeoff (§2) needs revisiting.

The published bundle grows far more slowly than the archive — roughly **68 KB/year**, the figure §10.3's warning threshold is derived from. The two numbers are not in tension: the archive keeps every dimensional row for every snapshot, while the bundle keeps only the newest snapshot's ranking plus five trajectories per file, so almost all of the archive's growth is discarded on the way to `data.json`.
