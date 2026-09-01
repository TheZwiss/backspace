# Repository Metrics Archive

Source files:
- `scripts/metrics/src/types.ts` -- Shared row shapes (`TrafficPoint`, `CountPoint`, `ReleaseRow`, `RepoPoint`, `DimensionRow`)
- `scripts/metrics/src/github.ts` -- GitHub API client: auth, pagination (`Link: rel="next"`), `/stats/*` 202 retry
- `scripts/metrics/src/series.ts` -- CSV/NDJSON parse + format, date-keyed upsert, dimensional upsert
- `scripts/metrics/src/store.ts` -- Filesystem layer: atomic per-file writes (temp + rename), `meta.json` read/write, path containment
- `scripts/metrics/src/collect.ts` -- Daily snapshot entrypoint (`collect()`)
- `scripts/metrics/src/backfill.ts` -- One-shot historical reconstruction entrypoint (`backfill()`)
- `scripts/metrics/src/cli-collect.ts` -- `process.env`/clock-reading wrapper invoked by `metrics.yml`
- `scripts/metrics/src/cli-backfill.ts` -- `process.env`-reading wrapper invoked by `backfill.yml`
- `scripts/metrics/src/cli-support.ts` -- Env validation, token safety check, timestamp derivation, log formatting
- `.github/workflows/metrics.yml` -- Daily cron: collect, commit, push, `gh workflow enable`
- `.github/workflows/backfill.yml` -- `workflow_dispatch`-only backfill runner

**Out of scope:** the public dashboard. Section 11 below explains why — it is a separate, not-yet-built workstream. This document covers only the collection pipeline: the `scripts/metrics` package, the two workflows, and the orphan `metrics-data` branch they write to.

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

Issues/PRs and commit/code-frequency history are not collected at all — no chart in this codebase consumes them, so there is nothing here to seed for them.

---

## 2. Architecture

```
scripts/metrics/                     @backspace/metrics (pnpm workspace package)
  package.json      zero runtime dependencies; scripts: typecheck, test
  tsconfig.json      extends the repo's strict base config, plus erasableSyntaxOnly,
                      verbatimModuleSyntax, allowImportingTsExtensions
  src/
    types.ts          shared row shapes (import type only)
    github.ts         API client
    series.ts         CSV/NDJSON codec + upsert
    store.ts           filesystem layer, meta.json
    collect.ts         daily snapshot
    backfill.ts         historical reconstruction
    cli-collect.ts      env/clock wrapper for metrics.yml
    cli-backfill.ts     env wrapper for backfill.yml
    cli-support.ts      shared CLI helpers
    *.test.ts           vitest, no network, no filesystem outside a per-test tmpdir

.github/workflows/metrics.yml        daily cron -> collect -> commit -> push
.github/workflows/backfill.yml       workflow_dispatch only

branch: metrics-data (orphan, intended to be ruleset-protected — see §8)
  traffic/views.csv, traffic/clones.csv
  traffic/referrers.ndjson, traffic/paths.ndjson
  stars.csv, forks.csv, releases.csv, contributors.csv, repo.csv
  meta.json
```

The collector is plain TypeScript executed directly by Node's native type stripping — no build step, no transpiler, no `dist/`. `pnpm-workspace.yaml` lists `scripts/metrics` explicitly (not `scripts/*`), so unrelated future scripts under `scripts/` are not swept into the workspace by accident.

### The two workflows

Both `metrics.yml` and `backfill.yml`:
- Declare `concurrency: { group: metrics-data, cancel-in-progress: false }`. This shared group name is the **only** thing preventing the daily cron and a dispatched backfill from racing on the same branch — they queue instead of running concurrently, and neither is ever cancelled mid-write, since cancelling a collection run loses that day irrecoverably.
- Skip entirely on a fork (`if: ${{ !github.event.repository.fork }}`), because `METRICS_TOKEN` is a repository secret and does not propagate to forks — without this guard a fork's own scheduled run would fail every day with nothing the fork owner could do about it.
- Bootstrap the `metrics-data` branch via `git ls-remote --exit-code --heads origin metrics-data` **before** any `actions/checkout` step references it. `actions/checkout` hard-fails the job if given a nonexistent `ref`, so the check has to run first. If the branch is absent, both workflows create it with `git worktree add --orphan` into a scratch directory (`.metrics-init`), commit an empty initial commit, push, and remove the worktree — never touching the primary checkout, so an early exit can't leave that tree modified.
- Check out `metrics-data` into `./.metrics-data` (gitignored — see `.gitignore`'s `.metrics-data/` entry — so `git status` on the main checkout stays clean) and pin `actions/setup-node` to `node-version: 24`.
- Run `step-security/harden-runner` with `egress-policy: audit`, and pin every `uses:` to a full commit SHA with a trailing `# vX.Y.Z` comment, per this repo's standing CI convention (see `docs/systems/security-scanning.md`).

`metrics.yml` runs `collect` (`node scripts/metrics/src/cli-collect.ts`); `backfill.yml` runs `backfill` (`node scripts/metrics/src/cli-backfill.ts`). Both jobs declare only `contents: write` (plus `actions: write` on `metrics.yml`, for the schedule-keepalive step in §9) — there is no separate deploy job in this codebase today, because there is no dashboard to deploy (§11).

---

## 3. Data schemas

All files live at the root of the `metrics-data` branch. CSVs are sorted ascending on their first (date) column on every write; NDJSON files are sorted `(snapshot_date asc, count desc, dimension asc)`. Both orderings are fixed by `series.ts` (`formatCsv`, `compareDimensionRows`) so that re-running the collector against unchanged upstream data produces a byte-identical file — the property that keeps daily commits to one line of diff.

### 3.1 Date-keyed series (CSV, header row, one row per UTC date)

| File | Columns | One row means |
|---|---|---|
| `traffic/views.csv` | `date,count,uniques` | Total views and unique visitors on that UTC date |
| `traffic/clones.csv` | `date,count,uniques` | Total clones and unique cloners on that UTC date |
| `stars.csv` | `date,total` | The repo's live `stargazers_count` as read on that date (a point-in-time snapshot, not a delta) |
| `forks.csv` | `date,total` | The repo's live `forks_count` as read on that date |
| `releases.csv` | `date,tag,name` | A release published on that UTC date (`date` = `published_at`'s UTC day) |
| `contributors.csv` | `date,total` | Cumulative distinct-contributor count, where a contributor counts from the UTC date of the start of their first commit week onward |
| `repo.csv` | `date,subscribers,open_issues,downloads_total` | The repo object's counters as read on that date, plus the sum of every release asset's `download_count` |

`repo.csv.downloads_total` is a `number | null` in memory (`RepoPoint` in `types.ts`) and is written as a **blank CSV field**, never `0`, whenever the optional `/releases` fetch fails that run (see §5). `subscribers` and `open_issues` are never blank — they come from the required `/repos/{slug}` fetch, which has already succeeded by the time `repo.csv` is written.

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
  "last_run": "2026-08-25T03:00:41Z",
  "last_success": "2026-08-25T03:00:41Z",
  "error": null,
  "series_last_date": { "traffic/views.csv": "2026-08-24", "stars.csv": "2026-08-25" }
}
```

`series_last_date` keys are exact file paths (only the `.csv` files collected this run are recorded; NDJSON files are not). There are **two independent writers** of this file, and reading it correctly means knowing both:

1. `collect()` (`collect.ts`) writes it last, once every other file for the run has landed — see §5's atomicity guarantee. On a required-fetch failure, `collect()` throws before this write ever happens, so this internal write only ever records success.
2. The workflow's own **"Record run outcome"** step (`metrics.yml`, `if: always()`) runs after the commit-and-push step regardless of whether `collect` succeeded. It reads whatever `meta.json` is currently on the branch, refreshes `last_run` to its own timestamp, and — if the job's overall status was not `success` — sets `error` to `` `run failed: ${job.status}` `` (leaving `last_success` and `series_last_date` untouched, since those describe the last run that actually completed). If the job did succeed, it sets `last_success` again (to a slightly later timestamp than `collect()`'s own write) and clears `error`. This step commits and pushes `meta.json` **on its own**, as a second commit, separate from the data commit — with a failure to push swallowed to a `::warning::` annotation rather than failing the job, so a metadata-push hiccup can never mask a successful collection.

The practical upshot: a normal successful day produces **two** commits on `metrics-data` (the data snapshot, then the run-outcome record), and `error` is the field to check for "did last night's run actually work" — `last_run` alone updates even on failure.

---

## 4. Write semantics

**Fetched values win. Three guards make that safe.**

### 4.1 Atomicity

`collect()` fetches every **required** series (`views`, `clones`, `referrers`, `paths`, the repo object) via a single `Promise.all` before writing anything. If any of those rejects, the function throws before a single `store.write*` call happens — the data directory and `meta.json` are left completely untouched, and the next run treats the previous data as still authoritative. This is asserted directly by a test (`collect.test.ts`, "aborts the entire write when a required traffic fetch fails"), which checks that `traffic/views.csv`, `stars.csv`, and `meta.json` are all still empty/absent after a failed clones fetch.

Once the write phase starts, every `store.write*` call in it is synchronous with no `await` between them, so there is no point where a second run (or anything else) could interleave. `meta.json` is written last of all, so its presence is a completion marker.

**The honest limit on this guarantee:** it is atomicity within one process's happy path, not a transaction. A synchronous run of `writeFileSync`/`renameSync` calls still issues one OS syscall at a time — a hard kill (`SIGKILL`, OOM) or an OS-level error (`ENOSPC`, a permissions change) between two of those calls can leave some files updated to today and others holding yesterday's content, with `meta.json` never reaching its update in that case (so it still points at the last run that *did* complete). **This torn-cross-file state does not self-heal for `stars.csv`, `forks.csv`, or `repo.csv`.** Those three files only ever write **today's** row each run — there is no retry logic that revisits a skipped or partially-written prior date for them. `traffic/*` is different: because the API returns a rolling 14-day window, a gap in the traffic files left by a torn run is silently repaired the next time collection succeeds (see §4.4). A torn `stars.csv`/`forks.csv`/`repo.csv` is not repaired by anything except a future day's row simply continuing forward from wherever it was left.

### 4.2 Backfill is write-if-absent

`backfill()` (`backfill.ts`) merges every series it touches with `upsertByDate(existing, incoming, 'if-absent')` — an existing row for a date is never replaced by a reconstructed one. This is a structural requirement, not a style choice: the daily collector writes `stars.csv`/`forks.csv` from the repo object's **live counters** (`stargazers_count`, `forks_count`), which correctly reflect someone who starred and later unstarred. Backfill reconstructs the same series from `/stargazers`' `starred_at` field, which lists only **current** stargazers — anyone who starred and later unstarred is permanently invisible to it. The two methods measure the same date differently by construction, and the collector's measured value is the one that was actually true on that date. Running backfill against an archive with months of collector-written history therefore changes nothing for any date the collector already covered; it only fills dates neither process has ever recorded. This is the one property `backfill.test.ts` exists to pin down.

`backfill()` is permitted to touch exactly `stars.csv`, `forks.csv`, and `releases.csv` (the `WRITABLE` constant in `backfill.ts`). It never opens `traffic/*` (no historical traffic API exists at all) or `repo.csv` (`subscribers` has no historical API either — a stray rewrite there would be a permanent, unrecoverable loss) or `contributors.csv` (the `/stats/contributors` weekly buckets the daily collector reads already cover all of history whenever that endpoint answers, so there is no gap for a one-shot backfill to fill).

### 4.3 No zero-filling

Nothing in this package ever writes `0` to stand in for "not measured." `repo.csv.downloads_total` is left as a blank CSV field (`null` in memory) when the optional `/releases` fetch fails, specifically so a missing measurement can never be mistaken for a real zero download count. A version that instead carried the previous run's value forward under today's date was considered and rejected during review: a flat line in that case would be indistinguishable from a genuinely quiet day, whereas a hole in the data is visible and honestly represents "we don't know." The same principle governs the dimensional files (§3.2, a dropped-out referrer is an absent row, never a zero) and `getStats()` (§6, a persistent 202 is `null`, never a zero).

### 4.4 Self-healing (traffic only)

The traffic window is 14 buckets wide, so any gap of **≤13 full days** without a successful run is silently repaired the next time `collect()` runs — the next successful fetch's window simply covers the missed dates again, and `upsertByDate`'s overwrite mode fills them in. A missed cron, a transient API outage, or a rejected push therefore costs nothing as long as the next run succeeds within two weeks. As established in §4.1, this self-healing property belongs to `traffic/*` specifically and does not extend to `stars.csv`, `forks.csv`, or `repo.csv`.

---

## 5. The 202 problem

`GET /repos/{slug}/stats/contributors` computes its answer asynchronously. While GitHub is still building the statistic, the endpoint answers `202` with an effectively empty body rather than `200`. `github.ts`'s `getStats()` is the only client method built to handle this:

- On a `202`, it retries with a backoff (`2000 * (attempt + 1)` ms between attempts, up to `statsAttempts` times — 5 by default) and never parses the placeholder body.
- If every attempt still comes back `202`, `getStats()` returns `null`. **`null` is the only way this method reports "not available yet"** — the success branch only ever produces a value by parsing a genuine `200` body, so there is no path from an in-progress computation to a zero-shaped result.
- In `collect()`, a `null` from `getStats()` causes `contributors.csv` to be skipped for that run, leaving whatever value the file already holds untouched. It is treated as optional for atomicity purposes (§4.1): a stats timeout must never abort the traffic write, since traffic is the irreplaceable series.

GitHub's `/stats/*` cache is keyed by the default branch's current commit and is invalidated by every push to it — so on an actively-developed repo, hitting a `202` is routine, not an edge case, and every collection run should be expected to occasionally skip `contributors.csv` for a day.

---

## 6. Field-name traps

These are documented because reading the obviously-named GitHub field would silently produce wrong data, and nothing in the type system catches it:

- **`watchers_count` is a duplicate of `stargazers_count`, not the watcher count.** `repo.csv`'s `subscribers` column is populated from `subscribers_count`, the actually-correct field — the collector never reads `watchers_count` at all (`RepoResponse` in `collect.ts` declares only `stargazers_count`, `forks_count`, `subscribers_count`, and `open_issues_count`).
- **The repo object's `open_issues_count` includes open PRs.** `repo.csv.open_issues` carries that combined meaning — GitHub does not separate the two in this field.
- **`/stargazers` requires the custom media type to return `starred_at` at all.** `backfill.ts` requests it with `Accept: application/vnd.github.star+json`; without that header the endpoint returns bare user objects with no timestamp, and `toDate()` would throw on every entry. Listing stargazers at all is gated to repo admins/collaborators as of a GitHub platform change — `METRICS_TOKEN` satisfies this because it belongs to a repo admin, not because star lists are openly public.

---

## 7. Token setup (not yet done — read this before the workflow first fails)

**Neither the `METRICS_TOKEN` secret nor the `metrics-data` branch ruleset exists yet.** Both are one-time, manual GitHub settings that no code in this repository can create. Until a maintainer does this, `metrics.yml` and `backfill.yml` will fail on every run.

1. **Create a fine-grained personal access token**, scoped to this repository only, with:
   - **Administration: read** — the traffic endpoints (`/traffic/views`, `/traffic/clones`, `/traffic/popular/referrers`, `/traffic/popular/paths`) require this permission specifically, and it is the exact documented requirement for all of them.
   - **Contents: read** — needed to read the repo object and its release/star/fork data.
2. **Store it as the `METRICS_TOKEN` repository secret** (Settings → Secrets and variables → Actions → New repository secret).
3. **Create a branch protection ruleset on `metrics-data`** blocking **deletion** and **force-push (non-fast-forward)**, with **no bypass actors**, mirroring the existing `cla-signatures` ruleset (`gh ruleset list` on this repo shows `Protect CLA signature store` as the precedent to copy). Do **not** require pull requests or status checks — both workflows commit directly to the branch, and requiring a PR would break every run. This branch is the only place in the repository holding genuinely irreplaceable data (the traffic history), so it is the one branch that most needs this protection and currently has none.

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

There is currently **no dashboard** to carry a staleness warning as a backstop (see §11) — the only backstop today is checking `meta.json`'s `last_success` field by hand, or scripting a check against it.

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

Safe to run at any time, including repeatedly — every write is if-absent (§4.2), so a rerun against an already-seeded archive changes nothing. The CLI's summary line is deliberately phrased "backfill target files (write-if-absent, listed whether or not they changed this run)" rather than "wrote," because `backfill()`'s `written` result is the fixed, exhaustive list of files it is *permitted* to touch, not the set that actually gained a row this run — see `formatBackfillSummary` in `cli-support.ts`.

### Recovering from a gap

A gap of **13 days or fewer** in traffic data self-heals automatically the next time `collect()` succeeds — no action needed (§4.4). A gap of **14 days or more** in traffic is permanent; there is nothing to backfill it with. A gap in `stars.csv`/`forks.csv`/`releases.csv` (however it happened) can be recovered by dispatching `backfill.yml`, since those are the exact three files it reconstructs. A gap in `repo.csv` (`subscribers`) or `contributors.csv` cannot be backfilled at all — the next successful collection run simply resumes from wherever it left off, with no way to fill the missed dates retroactively.

### What a rejected push means

`metrics.yml`'s commit-and-push step retries a rejected (non-fast-forward) push up to three times, running `git pull --rebase origin metrics-data` between attempts, and fails the job loudly if all three are rejected. `backfill.yml`'s commit-and-push step does **not** have this retry loop — it pushes once and fails on rejection. This asymmetry is intentional given the shared `concurrency: { group: metrics-data, cancel-in-progress: false }` on both workflows: that group already serializes the two workflows so they never run at the same time, which is the scenario the retry loop exists to survive. A push rejection on `metrics.yml` in practice means something *external* to these two workflows wrote to `metrics-data` (a manual commit, a ruleset bypass, direct API use) between checkout and push; a rejection on `backfill.yml` means the same, and the fix in both cases is to re-run the workflow.

### Reading `meta.json`

See §3.3 for the two-writer mechanics. In short: fetch `meta.json` from the tip of `metrics-data` and check `error` — `null` means the last run recorded there completed with `last_success` set to that run's timestamp; any other value is the string `run failed: <job status>` from the most recent run that did not succeed, and `last_success`/`series_last_date` still reflect the last run that *did*. `series_last_date` gives the newest date present in each `.csv` file at the end of that successful run, which is a faster way to spot a stalled series than diffing the files themselves.

---

## 10. Testing

`scripts/metrics`'s `test` script is `tsc --noEmit && vitest run` — it runs through the existing root `pnpm -r test` step with no `ci.yml` change required, and covers both types and behavior in one script. All tests are fixture-driven and touch no network; filesystem tests use a per-test `mkdtempSync` directory, cleaned up in `afterEach`. As of this writing there are **141 tests across 7 files**, all passing:

```
src/no-runtime-deps.test.ts   6
src/series.test.ts           41
src/cli-support.test.ts      28
src/github.test.ts           16
src/store.test.ts            23
src/backfill.test.ts          9
src/collect.test.ts          18
```

`no-runtime-deps.test.ts` is worth calling out specifically: it regex-scans every non-test source file in `src/` and fails if any import specifier is not a `node:` builtin or a relative path, if any relative import omits its `.ts` extension, or if any import of `types.ts` omits the `import type` keyword. This is the enforcement mechanism behind two of Node's type-stripping constraints (§12) — without `import type`, Node treats a type-only import as a value import and throws `SyntaxError` **at runtime**, which for this package means a red 03:00 cron rather than a red `tsc --noEmit`. `erasableSyntaxOnly` and `verbatimModuleSyntax` in `tsconfig.json` catch the same class of mistake at typecheck time for constructs `no-runtime-deps.test.ts` doesn't scan for (enums, namespaces with runtime code, parameter properties, decorators).

---

## 11. Adding a repo

The repository slug is never hardcoded: `collect()` and `backfill()` both take `slug` as a parameter, and both CLI wrappers derive it from the `GITHUB_REPOSITORY` environment variable, which GitHub Actions populates from `github.repository`. Nothing in the package assumes `TheZwiss/backspace` specifically.

That said, adding a second repo is not a matter of pointing a second workflow at it. Every file in §3 lives at a **flat path** at the root of `metrics-data` (`stars.csv`, not `<repo>/stars.csv`) — the schema has no per-repo namespacing at all. A second repo needs a file-layout decision made first (a subdirectory per repo slug is the obvious candidate, but it hasn't been decided or built), plus its own `METRICS_TOKEN`-equivalent PAT scoped to that repo, before any workflow could safely write its data without colliding with the first repo's files.

---

## 12. Why TypeScript with no build step

The collector has **zero runtime dependencies** — only `fetch` and `node:` builtins — and is executed directly by Node via native TypeScript type stripping, with no `tsc` build step in the run path (`tsc --noEmit` runs only for typechecking, in `test`/`typecheck`). `scripts/metrics/package.json` declares `"engines": { "node": ">=22.18" }`; the workflow's `setup-node` step pins `node-version: 24`.

Two constraints this creates are enforced rather than left to discipline, but by different mechanisms — worth knowing, because only one of them fails at typecheck time:

- **`import type` is mandatory** for any type-only import. Omitting it makes Node treat the import as a value import, which throws `SyntaxError` at runtime. `verbatimModuleSyntax` in `scripts/metrics/tsconfig.json` catches this at typecheck time, and `no-runtime-deps.test.ts` catches it again.
- **Relative import specifiers must carry the `.ts` extension** (`import './series.ts'`, never `'./series'`). This one has **no compiler enforcement**: `allowImportingTsExtensions` permits the extension but does not require it, so a missing `.ts` typechecks cleanly and only fails when Node runs the file. The regex scan in `no-runtime-deps.test.ts` (§10) is the only thing that catches it before then.

Unsupported by type stripping and therefore avoided throughout the package: enums, namespaces with runtime code, parameter properties, import aliases, decorators.

---

## 13. Volume

Not independently re-measured for this document; carried forward from the design spec's measurement against the real API responses at the time it was written (`docs/superpowers/specs/2026-08-25-repo-metrics-design.md`, §5.5): roughly 815 KB/year across all files combined, dominated by the two NDJSON files. At that rate the archive stays well under a size where the plain-text-over-SQLite tradeoff (§2) needs revisiting.
