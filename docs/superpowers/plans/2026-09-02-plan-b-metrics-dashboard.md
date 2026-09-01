# Metrics Dashboard Implementation Plan (WS2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the traffic archive on the `metrics-data` branch into a public dashboard at `site/insights/`, deployed with the existing landing page.

**Architecture:** A build-time bundler (`scripts/metrics/src/bundle.ts`) reads the archive checked out from `metrics-data` and emits a single `site/insights/data.json`. A self-contained static page reads that one file and renders five sections with vendored uPlot. `deploy-pages.yml` gains the checkout and the bundle step. No server, no runtime dependencies, no external asset requests.

**Tech Stack:** TypeScript run by Node's native type stripping (no build step), vitest, uPlot (vendored), plain CSS matching the landing page's Aether Drift tokens.

**Spec:** `docs/superpowers/specs/2026-08-25-repo-metrics-design.md` — §7 (dashboard), §7.1 (data delivery), §7.2 (Pages deployment), §5.3 (dimension semantics), §8 (WS2 scope). The spec is the binding authority; where this plan and the spec disagree, the spec wins.

**Predecessor:** WS1 (`plan-a-metrics-collection.md`) is complete and collecting. `scripts/metrics/` exists as a workspace package with `series.ts`, `store.ts`, `github.ts`, `collect.ts`, `backfill.ts`, and 157 tests.

---

## How to read the code in this plan

**A warning, learned the hard way.** WS1's plan contained complete reference implementations for every task. Six of its eight code-bearing tasks shipped a real defect that originated in that reference code — a blind `JSON.parse(...) as T` cast, a hard `0` written for an unavailable metric, an unpaginated fetch of a paginated endpoint, a parser that silently padded truncated rows. Implementers who transcribed the reference faithfully shipped the bug; the ones who read it critically caught it. The cause is simple: plan code is written in one pass and never executed.

So this plan is deliberately structured differently:

- **Contracts, invariants, and test cases are authoritative.** They are what you must satisfy. Read them as requirements.
- **Code blocks are illustrative unless a step says otherwise.** They show intent and shape. If a code block is wrong, the contract above it wins and you should fix the code and say so in your report.
- **Where a step says "exact values", those values ARE authoritative** — field names, file paths, magic strings, budgets. Use them verbatim.

You are expected to find mistakes in this document. Report them rather than transcribing them.

---

## Global Constraints

Every task's requirements implicitly include this section.

**Package constraints** (unchanged from WS1, still binding for anything under `scripts/metrics/src/`):
- Zero runtime dependencies. `src/` may import only `node:` builtins, relative `./*.ts` paths, and global `fetch`.
- `import type` is mandatory for type-only imports; a plain `import` of a type is a runtime `SyntaxError` under Node's type stripping.
- The `.ts` extension is mandatory on every relative import.
- Forbidden syntax: enums, namespaces with runtime code, parameter properties, import aliases, decorators.
- TypeScript strict with `noUncheckedIndexedAccess`; no `any`.
- `src/no-runtime-deps.test.ts` enforces the above. Do not modify it.

**Data-integrity constraints** (the reason this project exists):
- **Absent means "not measured"; zero means "measured as zero".** Never fill a gap with a zero, in the bundle or on the page.
- A dimension absent from a snapshot means "outside the top 10", not zero (spec §5.3). Render it as a **break in the line**, never as a zero point.
- Honest labelling is a requirement. The header says "since <first date in the archive>", never "all-time". A delta with insufficient history renders as `—`, never as a spurious percentage.
- Referrer and path trajectories must be **differenced between consecutive snapshots**, not plotted raw. Consecutive snapshots share 13 of 14 days, so a raw trajectory is a rolling sum that reads as smooth growth when nothing changed.

**Page constraints:**
- Self-contained: no external asset requests, no CDN, no webfont fetch. The landing page self-hosts DM Sans at `site/assets/dm-sans.woff2` and `site/insights/` must reuse it by relative path.
- Responsive. Wide content scrolls inside its own container; the page body never scrolls horizontally.
- Must render a usable empty state when `data.json` is missing (404) or empty. This is the same path as "the archive does not exist yet".

**Deploy constraints:**
- Every workflow `uses:` SHA-pinned with a trailing `# vX.Y.Z` comment. Reuse the SHAs already pinned in `.github/workflows/ci.yml` and `metrics.yml` rather than looking up new ones.
- The repo slug comes from `github.repository`, never hardcoded.
- No `${{ }}` interpolated into a `run:` string; use `env:`.
- **`deploy-pages.yml` currently deploys a live production landing page.** Any change to it must keep that working whether or not `metrics-data` exists. A regression there is a live outage of a working site.

**Exact values** (use verbatim):
- Bundle output path: `site/insights/data.json`
- Page path: `site/insights/index.html`
- Bundler: `scripts/metrics/src/bundle.ts`, CLI entry `scripts/metrics/src/cli-bundle.ts`
- Uncompressed budget: **2 MB** (2 × 1024 × 1024 bytes)
- Data-branch checkout path in the deploy workflow: `.metrics-data`
- Vendored uPlot: `site/insights/vendor/uplot.min.js` and `site/insights/vendor/uplot.min.css`

---

## The archive's actual shape

This is what `metrics-data` contains **today**, verified live on 2026-09-01. It is the input contract for `bundle.ts`. Note it differs from the spec's §5.3 illustration, which shows keys `referrer`/`path`; the implementation uses `dimension` for both. **The implementation is authoritative.**

```
traffic/views.csv        date,count,uniques
traffic/clones.csv       date,count,uniques
stars.csv                date,total
forks.csv                date,total
contributors.csv         date,total
releases.csv             date,tag,name          # keyed by tag, sorted by (date, tag)
repo.csv                 date,subscribers,open_issues,downloads_total
traffic/referrers.ndjson {"snapshot_date","dimension","title","count","uniques"}
traffic/paths.ndjson     {"snapshot_date","dimension","title","count","uniques"}
meta.json                {"last_run","last_success","error","series_last_date"}
```

Real values, for grounding:

```
traffic/views.csv     2026-08-31,100,32
stars.csv             2026-09-01,64
repo.csv              2026-09-01,1,18,1801
releases.csv          2026-07-03,v1.0.0,<name>
referrers.ndjson      {"snapshot_date":"2026-09-01","dimension":"chatgpt.com","title":"","count":132,"uniques":59}
paths.ndjson          {"snapshot_date":"2026-09-01","dimension":"/TheZwiss/backspace","title":"Overview","count":630,"uniques":255}
```

Two facts that will bite if forgotten:

1. **`repo.csv`'s `downloads_total` can be an empty string.** It is written blank when the optional releases fetch fails. Blank means "not measured" and must not become `0`. Any bundle field derived from it must preserve that distinction.
2. **The traffic window frequently ends before today.** On the verified run, traffic ended `2026-08-31` while `stars`/`forks`/`repo` were `2026-09-01`. That is correct behaviour, not a bug. Never assume all series share a last date.

---

## File structure

| File | Responsibility |
|---|---|
| `scripts/metrics/src/bundle.ts` | Pure: archive directory → `DashboardData` object. Reads via `store.ts`, parses via `series.ts`. No filesystem writes, no `process.env`, no clock. |
| `scripts/metrics/src/bundle.test.ts` | Tests for the above against a temp archive directory. |
| `scripts/metrics/src/cli-bundle.ts` | Env/clock/filesystem wrapper: reads the archive dir, writes `data.json`, enforces the budget, exits non-zero on failure. |
| `site/insights/index.html` | The page. Self-contained apart from the vendored uPlot files and the shared font. |
| `site/insights/vendor/uplot.min.js`, `uplot.min.css` | Vendored uPlot, pinned and checksum-verified. |
| `scripts/metrics/vendor.json` | Vendored-dependency manifest: name, version, source URL, SHA-256 of each file. |
| `.github/workflows/deploy-pages.yml` | Extended to bundle before uploading. |

`bundle.ts` stays pure so it is testable against a temp directory with no mocking, exactly as `collect.ts` is. `cli-bundle.ts` is the only file in this workstream that touches the environment or the clock, matching the existing `cli-collect.ts` / `cli-backfill.ts` / `cli-record-failure.ts` split.

---

## The `data.json` contract

Authoritative. Both `bundle.ts` and the page code depend on it, and the page is not independently testable, so this contract is what keeps them honest.

```ts
interface DashboardData {
  /** ISO timestamp the bundle was generated. */
  generated_at: string;
  /** Earliest date present in ANY series, or null for an empty archive. Drives honest "since <date>" labelling. */
  collection_started: string | null;
  /** Straight from meta.json, or null if absent. Lets the page surface a stalled collector. */
  meta: { last_run: string; last_success: string | null; error: string | null } | null;
  /** True when the archive is missing or holds no rows at all. The page renders its empty state. */
  empty: boolean;
  /** Set when the `all` range was downsampled to weekly buckets to fit the budget. The page must label it. */
  downsampled: boolean;
  series: {
    views: TrafficSeries;
    clones: TrafficSeries;
    stars: CountSeries;
    forks: CountSeries;
    contributors: CountSeries;
    repo: RepoSeries;
  };
  releases: Array<{ date: string; tag: string; name: string }>;
  dimensions: {
    referrers: DimensionSeries;
    paths: DimensionSeries;
  };
}

/** Parallel arrays, index-aligned with `dates`. A null is "not measured", never zero. */
interface TrafficSeries { dates: string[]; count: Array<number | null>; uniques: Array<number | null>; }
interface CountSeries   { dates: string[]; total: Array<number | null>; }
interface RepoSeries    { dates: string[]; subscribers: Array<number | null>; open_issues: Array<number | null>; downloads_total: Array<number | null>; }

interface DimensionSeries {
  /** Snapshot dates, ascending. */
  snapshots: string[];
  /** The most recent snapshot's rows, count-descending. Drives the ranked bars. */
  latest: Array<{ dimension: string; title: string; count: number; uniques: number }>;
  /**
   * Per-dimension trajectories, DIFFERENCED between consecutive snapshots, index-aligned
   * with `snapshots` — so element 0 is always null (no previous snapshot to difference against).
   * A dimension absent from a snapshot yields null at that index: a break, never a zero.
   * Only the top 5 dimensions of the latest snapshot appear here (spec §7).
   */
  trajectories: Array<{ dimension: string; delta: Array<number | null> }>;
}
```

Why parallel arrays rather than row objects: uPlot consumes column-oriented data natively, so the page needs no reshaping step, and `null` is uPlot's own gap representation. It is also roughly 3× smaller than repeated row objects, which is what keeps the 2 MB budget comfortable for years.

---

## Task 1: Make `deploy-pages.yml` safe to extend

This lands **first and alone**, before any dashboard code exists, because it modifies a workflow that deploys a live production site. Every change here is independently correct and valuable even if the rest of this plan is abandoned.

**Files:**
- Modify: `.github/workflows/deploy-pages.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: a hardened deploy workflow that later tasks extend.

### Context

The current file (read it in full before editing) has three problems, all pre-existing:

1. **`cancel-in-progress: true`.** This cancels an in-flight production deploy. GitHub's own Pages starter workflow comments the opposite explicitly: *"do NOT cancel in-progress runs as we want to allow these production deployments to complete."* Cancelling `actions/deploy-pages` mid-flight also strands a deployment in the `github-pages` environment that blocks the next one. Today collisions are rare; adding a second trigger source in Task 10 makes them routine.
2. **No `harden-runner`.** It is the only workflow in the repo without one. Every other workflow, including both metrics workflows, runs it with `egress-policy: audit`.
3. **The `paths:` filter omits the bundler.** Once `scripts/metrics/**` feeds the deployed output, a bundler change must trigger a redeploy or the site silently serves stale data.

- [ ] **Step 1: Read the current workflow and the two metrics workflows**

Read `.github/workflows/deploy-pages.yml`, then `.github/workflows/metrics.yml` for the `harden-runner` step's exact form and pinned SHA. Reuse that SHA verbatim.

- [ ] **Step 2: Apply the three fixes**

- Flip `cancel-in-progress` to `false`, with a comment explaining why (a cancelled Pages deploy strands the environment).
- Add `harden-runner` with `egress-policy: audit` as the first step, matching the other workflows.
- Add `scripts/metrics/**` to the `paths:` filter, with a comment saying why a bundler change must redeploy.

Do not add `setup-node`, the `metrics-data` checkout, or any bundle step yet — those arrive in Task 10, when there is something to run. A step that does nothing yet is a placeholder.

- [ ] **Step 3: Verify**

Run: `actionlint .github/workflows/deploy-pages.yml`
Expected: clean, no output.

Confirm by re-reading the file that the deploy job's behaviour is otherwise byte-identical: same `uses:` SHAs, same `path: ./site`, same permissions, same environment block.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy-pages.yml
git commit -m "ci(pages): stop cancelling in-flight deploys and harden the runner"
```

---

## Task 2: `bundle.ts` — read the archive into the data contract

**Files:**
- Create: `scripts/metrics/src/bundle.ts`
- Create: `scripts/metrics/src/bundle.test.ts`

**Interfaces:**
- Consumes: `createStore` from `store.ts`; `parseCsv`, `parseNdjson` are reached *through* the store (`readCsv`, `readNdjson`, `readMeta`), not directly.
- Produces: `buildDashboardData(store: Store): DashboardData` and the exported `DashboardData` type (and its member types).

### Contract

`buildDashboardData` is pure with respect to the outside world: it takes a `Store` and returns the object. It does not write, does not read `process.env`, does not read the clock. `generated_at` is therefore a parameter, not something it derives — mirroring how `collect()` takes `today`/`now`.

Signature: `buildDashboardData(store: Store, generatedAt: string): DashboardData`

### Invariants (authoritative — these are what the tests must pin)

1. **A missing file is not an error.** `store.readCsv`/`readNdjson` return `[]` for a file that does not exist. An archive missing `releases.csv` entirely must produce `releases: []`, not throw.
2. **A corrupt file IS an error.** The store throws; let it propagate. Do not catch and substitute an empty series — that would silently publish an empty chart for data that exists.
3. **`empty` is true** when every series has zero rows AND both dimension files are empty. An archive with only `meta.json` (the state right after bootstrap) is empty.
4. **`collection_started`** is the earliest date across all row-bearing series, or `null` when empty. Compute it from the data; never hardcode.
5. **Numeric fields parse from strings**, since CSV values arrive as strings. A field that is the **empty string becomes `null`, not `0`** — this is `repo.csv`'s `downloads_total` and it is the single most important line in this task. A field that is a valid number becomes that number. A field that is present but unparseable is an error, not a silent `null`.
6. **Dates are not resampled or gap-filled here.** The `dates` array holds exactly the dates present in that file, ascending. Two series may legitimately have different last dates.
7. **Trajectories are differenced**, element 0 always `null`, and a dimension absent from snapshot *i* yields `null` at index *i*. Only the latest snapshot's top 5 by count appear.
8. **`latest`** is the most recent snapshot's rows sorted count-descending. If there are no snapshots, it is `[]`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/metrics/src/bundle.test.ts`. Build a real archive in a temp directory using `createStore` (the same pattern `store.test.ts` and `collect.test.ts` use — read them first for the `mkdtempSync`/`rmSync` setup), write known fixtures, then assert.

Cover at minimum:

```ts
// The empty-string case. This is invariant 5 and the highest-value test in the file.
it('maps an empty downloads_total to null, never to zero', () => {
  // write repo.csv containing: 2026-09-01,1,18,   (trailing empty field)
  // assert data.series.repo.downloads_total[0] === null
  // and explicitly: expect(data.series.repo.downloads_total[0]).not.toBe(0)
});

it('reports empty for an archive holding only meta.json', () => { /* empty === true */ });

it('does not throw when releases.csv is absent', () => { /* releases === [] */ });

it('propagates a parse error from a corrupt file rather than returning an empty series', () => {
  // write a truncated row into views.csv; expect(() => buildDashboardData(...)).toThrow()
});

it('takes collection_started from the earliest date across all series', () => { /* ... */ });

it('allows series to end on different dates', () => {
  // views ends 2026-08-31, stars ends 2026-09-01 — both preserved, neither padded
});

it('differences trajectories and starts them with null', () => {
  // two snapshots, same dimension, counts 100 then 130 -> delta [null, 30]
});

it('renders a dimension missing from a snapshot as a break, not a zero', () => {
  // dimension present in snapshots 1 and 3, absent from 2 -> delta[1] === null
  // and explicitly not 0
});

it('limits trajectories to the top five of the latest snapshot', () => { /* ... */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd scripts/metrics && npx vitest run src/bundle.test.ts`
Expected: FAIL — `bundle.ts` does not exist.

- [ ] **Step 3: Implement `bundle.ts`**

Illustrative, not authoritative — the invariants above are. The one fragment worth stating exactly is the numeric coercion, because getting it wrong is the defect this whole project exists to prevent:

```ts
/**
 * Parses a CSV field to a number, preserving the not-measured distinction.
 *
 * An empty field means the value was never measured — `repo.csv`'s
 * `downloads_total` is written blank when the optional releases fetch fails —
 * and must stay null. Coercing it to 0 would publish a fabricated measurement
 * that no consumer could tell from a real one. `Number('')` is 0, which is
 * exactly the trap.
 */
function toNumberOrNull(value: string | undefined, field: string, date: string): number | null {
  if (value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`bundle: ${field} on ${date} is not a finite number: ${JSON.stringify(value)}`);
  }
  return n;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd scripts/metrics && npx tsc --noEmit && npx vitest run`
Expected: all green, including the 157 pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/metrics/src/bundle.ts scripts/metrics/src/bundle.test.ts
git commit -m "feat(metrics): build the dashboard data bundle from the archive"
```

---

## Task 3: Budget enforcement, downsampling, and the CLI

**Files:**
- Modify: `scripts/metrics/src/bundle.ts`
- Modify: `scripts/metrics/src/bundle.test.ts`
- Create: `scripts/metrics/src/cli-bundle.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `buildDashboardData` from Task 2.
- Produces: `downsampleWeekly(data: DashboardData): DashboardData`; a CLI writing `site/insights/data.json`.

### Contract

The budget is **2 MB uncompressed** (2 × 1024 × 1024 bytes), measured on the serialised JSON as UTF-8 bytes. Per spec §7.1 the bundler **fails the build** when the budget is exceeded, so the regression surfaces in CI rather than in first paint.

The sequence is: build → serialise → measure. If over budget, downsample to weekly buckets, set `downsampled: true`, re-serialise, re-measure. If **still** over budget, throw. Never silently truncate a series — dropping data to fit a budget is exactly the silent loss this archive exists to prevent.

Weekly bucketing rules:
- Bucket by ISO week, keyed on the **Monday** of each week, computed in UTC.
- Traffic counts (`views`, `clones`) **sum** within a bucket — they are per-day event counts.
- Cumulative counters (`stars`, `forks`, `contributors`, `repo.*`) take the **last** value in the bucket — they are point-in-time totals, and summing them would be meaningless.
- A bucket containing only nulls stays null.
- `releases` and `dimensions` are **not** downsampled; releases are sparse and the dimension series is bounded by top-10-per-snapshot.

That sum-vs-last distinction is the same one that made `stars.csv` and `traffic/views.csv` different quantities in WS1. Getting it backwards produces a chart that looks plausible and is wrong.

- [ ] **Step 1: Write the failing tests**

```ts
it('sums traffic but takes the last value of a cumulative counter when bucketing', () => {
  // 7 daily views rows summing to N, and stars rising 60..66
  // -> weekly views count === N, weekly stars total === 66 (not the sum)
});

it('keeps a null bucket null rather than treating it as zero', () => { /* ... */ });

it('buckets on the UTC Monday', () => { /* a Sunday and the following Monday land in different buckets */ });

it('sets downsampled true only when it actually downsampled', () => { /* ... */ });

it('throws rather than truncating when still over budget after downsampling', () => { /* ... */ });

it('leaves releases and dimensions untouched when downsampling', () => { /* ... */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd scripts/metrics && npx vitest run src/bundle.test.ts`

- [ ] **Step 3: Implement downsampling and the budget check**

- [ ] **Step 4: Write `cli-bundle.ts`**

Model it on `cli-collect.ts` — read that file first and match its structure, its `requiredEnv` use, its error handling, and its exit-code discipline. It should:

- Take the archive directory and the output path from the environment (`METRICS_DATA_DIR`, and an output path variable you name — state your choice in your report).
- **Handle a missing archive directory as the empty case, not a crash.** Per spec §7.1 the bundler must emit a valid empty `data.json` when the branch or any file is missing, because `deploy-pages.yml` runs on every landing-page push whether or not the data branch exists. This is the single most important behaviour in this task: getting it wrong takes down a working production deploy.
- Write the file, creating `site/insights/` if needed.
- Print the byte size and whether it downsampled.
- Exit non-zero on any real failure (corrupt archive, over budget after downsampling).

- [ ] **Step 5: Add `data.json` to `.gitignore`**

It is a build artifact and must never be committed — the data branch is the single source of truth, and a committed derived copy invites the two to disagree. Add it under the existing labelled metrics section (around line 100), matching that section's comment style.

- [ ] **Step 6: Verify, including a real run**

```bash
cd scripts/metrics && npx tsc --noEmit && npx vitest run
```

Then run the CLI for real against a temp copy of the live archive and against a nonexistent directory, and paste both transcripts into your report. The second case must produce a valid empty `data.json` and exit 0.

- [ ] **Step 7: Commit**

```bash
git add scripts/metrics/src/bundle.ts scripts/metrics/src/bundle.test.ts scripts/metrics/src/cli-bundle.ts .gitignore
git commit -m "feat(metrics): enforce the bundle budget and add the bundle entrypoint"
```

---

## Task 4: Vendor uPlot

**Files:**
- Create: `site/insights/vendor/uplot.min.js`, `site/insights/vendor/uplot.min.css`
- Create: `scripts/metrics/vendor.json`
- Create: `scripts/metrics/src/vendor-check.test.ts`
- Modify: `scripts/metrics/package.json`

### Contract

uPlot is vendored rather than installed because the page is a static file with no build step and no bundler — it loads `vendor/uplot.min.js` by relative path. But vendoring without tracking is how a dependency silently rots, so the vendored copy is **checksum-verified in CI**.

`vendor.json` records, for each vendored file: the package name, the exact version, the source URL, and the **SHA-256 of the file as committed**. A test recomputes those hashes and fails if a file was edited in place.

This gives the property that matters: nobody can quietly patch the vendored library, and the manifest says exactly what upstream version is present so a CVE advisory can be matched against it.

- [ ] **Step 1: Fetch and pin uPlot**

Download the minified JS and CSS for a specific uPlot release. Record the exact version and the URLs you used. Do not use a `latest` URL.

- [ ] **Step 2: Write `vendor.json`**

```json
{
  "uplot": {
    "version": "<exact version>",
    "source": "<exact URL>",
    "license": "MIT",
    "files": {
      "site/insights/vendor/uplot.min.js": "sha256-<hash>",
      "site/insights/vendor/uplot.min.css": "sha256-<hash>"
    }
  }
}
```

- [ ] **Step 3: Write the failing check**

`vendor-check.test.ts` reads `vendor.json`, hashes each listed file with `node:crypto`, and asserts the hash matches. It must also assert every file listed actually exists, and fail with a message naming the file and both hashes.

Write it to fail first (e.g. against a deliberately wrong hash), confirm the failure message is useful, then correct the manifest.

- [ ] **Step 4: Add a `vendor:check` script**

Add to `scripts/metrics/package.json`. Note the guard test in `src/` only scans `src/`, so a vendored file under `site/` is outside its reach — this test is the only thing covering it.

- [ ] **Step 5: Verify and commit**

```bash
cd scripts/metrics && npx vitest run
git add site/insights/vendor scripts/metrics/vendor.json scripts/metrics/src/vendor-check.test.ts scripts/metrics/package.json
git commit -m "chore(metrics): vendor uPlot with a checksum manifest"
```

---

## Task 5: The page shell and its empty state

**Files:**
- Create: `site/insights/index.html`

### Contract

The shell renders correctly **before any chart exists**. That ordering is deliberate: the empty state is the path a visitor hits if `data.json` 404s, and building it first means it is real rather than an afterthought.

Requirements:
- Reuses the landing page's Aether Drift tokens verbatim. Read `site/index.html`'s `:root` block and copy the token values — do not invent new colours. The palette is `--base:#0b0b10`, `--chat:#13131a`, `--channel:#1a1a23`, `--elevated:#252530`, `--txt:#efefef`, `--txt2:#a0a0aa`, `--txt3:#6d6d7c`, `--primary:#7c6cf6`, plus the pastel accents.
- Reuses the self-hosted font by relative path: `../assets/dm-sans.woff2`. Read the landing page's `@font-face` block (around line 76) and match it. **No webfont fetch.**
- A header linking back to the landing page, and the same footer treatment.
- The five section headings from spec §7, present and empty.
- A shared time-range control: `30d / 90d / 1y / all`. Inert in this task; wired in Task 6.
- **The empty state**: when `data.json` is missing or `empty` is true, render an explanatory message in the page shell — not a broken chart, not a spinner that never resolves. Say plainly that collection has not started yet or the archive is unavailable.
- **A stale-collector banner**: if `meta.error` is non-null, or `meta.last_run` is more than 48 hours before `generated_at`, show it. This is the operational signal WS1 built `meta.json` for; surfacing it here is what makes it useful.

- [ ] **Step 1: Build the shell with its empty state**

Fetch `data.json` with `fetch('data.json')`. Handle three outcomes distinctly: network/404 failure, `empty: true`, and real data. The first two share a rendering path but should say different things.

- [ ] **Step 2: Verify locally**

Serve `site/` over a local static server and load `/insights/`. Confirm:
- With no `data.json` present: the empty state renders, no console errors.
- The page does not scroll horizontally at 360px width.
- No network request leaves the origin (check the network panel or reason it through from the source).

Paste what you did into your report. If you cannot run a browser, say so and state exactly what you verified by inspection instead.

- [ ] **Step 3: Commit**

```bash
git add site/insights/index.html
git commit -m "feat(insights): add the dashboard shell and its empty state"
```

---

## Task 6: Header stats and the shared range control

**Files:**
- Modify: `site/insights/index.html`

### Contract

Per spec §7, the header shows: stars, forks, watchers, views and clones **since collection began**, contributors, and total downloads — each with a 30-day delta.

**Honest labelling is a requirement, not a nicety:**
- The views/clones figures are labelled "since `<collection_started>`", never "all-time".
- A delta whose window is not fully covered by the archive renders as `—`, never as a percentage computed from partial history. With 14 days of data, a "30-day delta" is not available and must say so.
- A `null` in a series is not zero. A metric with no measurement renders as `—`.

The range control (`30d / 90d / 1y / all`) sets shared state that every chart added in later tasks reads. Implement the state and the filtering here, even though only the header consumes it yet.

- [ ] **Step 1: Implement the header and range state**

- [ ] **Step 2: Verify the honest-labelling rules by hand**

With the live archive (14 days of traffic), confirm the 30-day deltas render as `—` rather than a number. This is the specific case the spec calls out, and the archive is currently in exactly that state — a genuine test rather than a hypothetical.

- [ ] **Step 3: Commit**

```bash
git add site/insights/index.html
git commit -m "feat(insights): add header stats with honest delta labelling"
```

---

## Task 7: Reach — views and clones

**Files:**
- Modify: `site/insights/index.html`

### Contract

The core archive view. Views and clones with their uniques, on a shared time axis, honouring the range control from Task 6.

- Gaps render as **breaks**, not zeros. uPlot does this natively for `null`, which is why the bundle uses `null` rather than omitting points.
- Drag-to-zoom, per spec §7.
- A shared hover cursor: hovering any chart moves the cursor on every chart. uPlot's `cursor.sync` handles this; use one sync key for the whole page.
- The series must remain legible on a phone. Wide charts scroll inside their own container; the body does not scroll horizontally.

- [ ] **Step 1: Render the reach charts**

- [ ] **Step 2: Verify against real data**

Generate `data.json` from the live archive using the Task 3 CLI, load the page, and confirm the shape matches the CSV. Confirm a deliberately introduced `null` renders as a gap, not a drop to zero.

- [ ] **Step 3: Commit**

```bash
git add site/insights/index.html
git commit -m "feat(insights): add the reach charts for views and clones"
```

---

## Task 8: Growth — stars and forks with release annotations

**Files:**
- Modify: `site/insights/index.html`

### Contract

Star and fork history, all-time, **with release tags annotated on the time axis**.

The spec calls this "the highest-value element: it turns 'stars went up in July' into 'the v1 release drove that', and is only possible because release dates and star history live in the same archive." Treat it as the centrepiece of the page, not a decoration.

- Annotations come from `releases[]` — each has `date`, `tag`, `name`.
- A release outside the current range is not drawn.
- Multiple releases on one date must not overlap illegibly.
- Stars and forks are **cumulative** series. They are point-in-time totals, so a gap means "not measured that day", not "dropped to zero" — the break rendering matters here as much as anywhere.

- [ ] **Step 1: Render growth with annotations**

- [ ] **Step 2: Verify with the real release**

The live archive has one release, `v1.0.0` on `2026-07-03`, and star history beginning much later. Confirm the annotation renders correctly when the release predates the star series — this is the actual current state and a real edge case, not a hypothetical.

- [ ] **Step 3: Commit**

```bash
git add site/insights/index.html
git commit -m "feat(insights): add star and fork growth with release annotations"
```

---

## Task 9: Referrers and paths

**Files:**
- Modify: `site/insights/index.html`

### Contract

Two sections: "Where people come from" and "What they look at". Each has ranked bars from `dimensions.*.latest`, plus top-5 trajectories from `dimensions.*.trajectories`.

**The labelling requirement is load-bearing.** These are trailing-14-day aggregates, not daily figures, and GitHub does not expose daily resolution — not here, not anywhere. Both sections must say so plainly. Presenting them as daily would be presenting weaker data as something it is not.

**Trajectories are already differenced by the bundler.** Do not difference again. A `null` is a break, meaning the dimension fell outside the top 10 that day — which means "≤ the #10 count", not zero. If the page plots those as zero it fabricates a cliff that never happened.

- Path rows have a `title` (e.g. `"Overview"`); referrer rows have an empty `title`. Render the title where present, falling back to the dimension.
- Paths are long. Truncate for display without losing the ability to read the full value (tooltip or title attribute).

- [ ] **Step 1: Render both sections**

- [ ] **Step 2: Verify with real data**

The live archive has exactly one snapshot, so every trajectory is `[null]`. Confirm that renders as an honest "not enough history yet" rather than an empty or broken chart. This is the current real state.

- [ ] **Step 3: Commit**

```bash
git add site/insights/index.html
git commit -m "feat(insights): add referrer and path sections"
```

---

## Task 10: Wire the bundle into the Pages deploy

**Files:**
- Modify: `.github/workflows/deploy-pages.yml`

### Contract

This is the second and last edit to the production deploy workflow. Task 1 made it safe; this makes it useful.

**The metrics-data checkout must be conditional and non-fatal.** `deploy-pages.yml` runs on every `site/**` push. An unconditional checkout of a branch that might not exist would fail *every landing-page deploy* until the metrics branch is created, and permanently if it is ever deleted. `actions/checkout` on a missing ref hard-fails, so the condition must be evaluated before the checkout, not inside it.

Requirements:
- Add `workflow_call` alongside the existing triggers so `metrics.yml` can deploy after a successful collection. Note that permissions in a called workflow can only be reduced, never elevated, and that a workflow-level `concurrency` in a called workflow is not reliably honoured — the group belongs on the calling job.
- Add `setup-node` (the workflow currently has none), SHA-pinned to match `metrics.yml`, with `package-manager-cache: false` — the same trap that broke the first live metrics run, since nothing here installs pnpm.
- Check whether `metrics-data` exists, then checkout into `.metrics-data` only if it does.
- Run the bundler. It emits a valid empty `data.json` when the archive is absent, so this step runs unconditionally.
- Upload `./site` as before, now including `insights/data.json`.

Note for the runbook: the `github-pages` environment has a branch policy allowing only `main` and `gh-pages`, so a `workflow_dispatch` run from a feature branch is blocked at the environment gate. That is expected and is not a bug to chase.

- [ ] **Step 1: Extend the workflow**

- [ ] **Step 2: Verify both paths**

`actionlint` must be clean. Then reason through, and state in your report, what happens on:
- a `site/**` push with `metrics-data` present,
- a `site/**` push with `metrics-data` absent (the regression risk — this must still deploy),
- a `workflow_call` from `metrics.yml`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy-pages.yml
git commit -m "ci(pages): bundle the metrics archive into the deployed site"
```

---

## Task 11: Documentation

**Files:**
- Modify: `docs/systems/metrics.md`
- Modify: `CLAUDE.md`

### Contract

`docs/systems/metrics.md` currently states the dashboard does not exist. That becomes false with this workstream and must be corrected everywhere it appears — search the whole file rather than only the obvious section.

Add: the `data.json` contract, the 2 MB budget and what happens when it is exceeded, the vendoring policy and how to update uPlot, the deploy wiring, the empty-state behaviour, and how to run the bundler locally.

**Document from the code, not from this plan.** The implementation will have diverged. Verify every path, field name, and command against the built artefact.

Update `CLAUDE.md`'s subsystem table row for metrics to mention the dashboard, matching the neighbouring rows' format.

- [ ] **Step 1: Update both files**
- [ ] **Step 2: Verify every factual claim against the code**
- [ ] **Step 3: Commit**

```bash
git add docs/systems/metrics.md CLAUDE.md
git commit -m "docs(metrics): document the dashboard, bundle contract, and vendoring"
```

---

## Task 12: Live verification

**Files:** none — this task verifies.

### Contract

Requires a push and a live Pages deploy, so it is a stop-and-confirm gate with the repo owner rather than something to run unattended.

Verify, in order:
1. The landing page still deploys correctly — the regression that matters most.
2. `data.json` appears in the Pages artifact.
3. `https://thezwiss.github.io/backspace/insights/` renders all five sections against real data.
4. The empty state renders when `data.json` is absent (test by reasoning or a temporary local removal, not by deleting the data branch).
5. `meta.json`'s error banner surfaces when the collector has failed.

- [ ] **Step 1: Confirm with the repo owner before pushing**
- [ ] **Step 2: Verify each item above and record the result**

---

## Self-review notes

Checked against the spec before finalising:

- **§7's five sections** → Tasks 5–9, one section per task after the shell.
- **§7's shared range control and hover cursor** → range in Task 6, cursor sync in Task 7 (first task with two charts to sync).
- **§7's release annotations** → Task 8, with the real `v1.0.0`-predates-star-history edge case called out.
- **§7's honest labelling and differenced trajectories** → Global Constraints, plus Tasks 6 and 9 specifically.
- **§7.1's 2 MB budget, downsampling, build-artifact status, 404 handling** → Task 3 and Task 5.
- **§7.2's deploy changes** → split across Tasks 1 and 10 so the risky production edit is reviewed twice, once alone.
- **§7.2's `cancel-in-progress` correction** → Task 1.
- **§8's uPlot vendoring and `vendor:check`** → Task 4.

Known gaps, stated rather than hidden:

- **`vendor:sync`** (spec §8) is not a task. `vendor:check` catches drift, which is the property that matters; a sync script that re-downloads is convenience, and writing one that fetches from the network into the repo is a supply-chain surface I would rather not add without a specific need. Documented in Task 11 as a manual procedure instead. If the reviewer disagrees, it is a small task to add.
- **Task 12 cannot be completed by an agent alone** — it needs the owner to approve a production deploy.
- The page tasks (5–9) have no automated tests. There is no test runner for a static page in this repo and adding one is a larger decision than this workstream should make unilaterally. Each page task therefore specifies manual verification against the **live archive**, which is real data with genuinely awkward properties (one dimension snapshot, a release predating the star series, traffic ending before today). That is weaker than tests and is the main risk in this plan.
