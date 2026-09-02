import { Buffer } from 'node:buffer';
import { compareStrings, compareReleaseRows } from './series.ts';
import type { Store } from './store.ts';

/**
 * The archive's file layout, named once so the reader and the collector
 * cannot drift apart silently over a typo. These are the exact paths
 * `collect.ts` writes.
 */
const VIEWS_FILE = 'traffic/views.csv';
const CLONES_FILE = 'traffic/clones.csv';
const STARS_FILE = 'stars.csv';
const FORKS_FILE = 'forks.csv';
const CONTRIBUTORS_FILE = 'contributors.csv';
const REPO_FILE = 'repo.csv';
const RELEASES_FILE = 'releases.csv';
const REFERRERS_FILE = 'traffic/referrers.ndjson';
const PATHS_FILE = 'traffic/paths.ndjson';
const WORKFLOWS_FILE = 'workflows.csv';

/** How many of the latest snapshot's dimensions get a trajectory line. */
const TRAJECTORY_LIMIT = 5;

/**
 * Parallel arrays, index-aligned with `dates`. A `null` is "not measured",
 * never zero.
 */
export interface TrafficSeries {
  dates: string[];
  count: Array<number | null>;
  uniques: Array<number | null>;
}

/**
 * This repository's own CI activity per day, index-aligned with `dates`.
 *
 * A `0` here is a measured zero and plots AT zero; only an absent date or a
 * `null` is "not measured". That differs from the traffic series on the same
 * chart, where GitHub omits a zero-traffic day entirely — the difference is a
 * property of the two APIs, not a rendering choice, and it is why the two must
 * not share a gap-filling rule.
 */
export interface WorkflowSeries {
  dates: string[];
  runs: Array<number | null>;
}

/** A cumulative counter (stars, forks, contributors) over time. */
export interface CountSeries {
  dates: string[];
  total: Array<number | null>;
}

/** The repo-object counters, index-aligned with `dates`. */
export interface RepoSeries {
  dates: string[];
  subscribers: Array<number | null>;
  open_issues: Array<number | null>;
  downloads_total: Array<number | null>;
  downloads_app: Array<number | null>;
  downloads_updates: Array<number | null>;
}

/**
 * Collector health as the page needs it.
 *
 * Deliberately NOT `Meta` from `store.ts`: that type also carries
 * `series_last_date`, a per-file resume cursor the collector uses to decide
 * what to refetch. It is collector internals — publishing it would ship a
 * map of file paths to a static page that has no use for them and would
 * invite the page to start depending on the collector's file layout.
 */
export interface DashboardMeta {
  last_run: string;
  last_success: string | null;
  error: string | null;
}

/** One published release, rendered as a marker on the timeline. */
export interface ReleaseEntry {
  date: string;
  tag: string;
  name: string;
}

/** One referrer or path from a single snapshot. */
export interface DimensionEntry {
  dimension: string;
  title: string;
  count: number;
  uniques: number;
}

/**
 * One dimension's movement across snapshots, DIFFERENCED between consecutive
 * snapshots and index-aligned with `DimensionSeries.snapshots`.
 */
export interface DimensionTrajectory {
  dimension: string;
  delta: Array<number | null>;
}

export interface DimensionSeries {
  /** Snapshot dates, ascending. */
  snapshots: string[];
  /** The most recent snapshot's rows, count-descending. Drives the ranked bars. */
  latest: DimensionEntry[];
  /**
   * Per-dimension trajectories. Element 0 is always null (no previous
   * snapshot to difference against), and a dimension absent from a snapshot
   * yields null at that index: a break, never a zero. Only the top 5
   * dimensions of the latest snapshot appear here.
   */
  trajectories: DimensionTrajectory[];
}

/**
 * Everything the static dashboard page renders, in one JSON-serialisable
 * object.
 *
 * These types are declared here rather than reused from `types.ts` on
 * purpose. `types.ts` describes what the collector writes; this describes
 * what the page reads. They coincide today (a `ReleaseEntry` and a
 * `ReleaseRow` are the same three fields), but they are two different
 * contracts with two different consumers, and the page — which has no
 * automated tests — must not silently acquire a field because a collector
 * type grew one.
 */
export interface DashboardData {
  /** ISO timestamp the bundle was generated. */
  generated_at: string;
  /**
   * Earliest date present in ANY series, or null for an empty archive.
   * Drives honest "since <date>" labelling.
   */
  collection_started: string | null;
  /** Collector health, or null when the archive has no `meta.json` yet. */
  meta: DashboardMeta | null;
  /** True when the archive is missing or holds no rows at all. */
  empty: boolean;
  /**
   * Set when the `all` range was downsampled to weekly buckets to fit the
   * budget, which the page must label. Always false as `buildDashboardData`
   * returns it — reading the archive never downsamples. `downsampleWeekly`
   * owns this flag and `serialiseWithinBudget` is the only thing that
   * decides to call it, so it can never claim weekly buckets over data that
   * is still daily.
   */
  downsampled: boolean;
  series: {
    views: TrafficSeries;
    clones: TrafficSeries;
    stars: CountSeries;
    forks: CountSeries;
    contributors: CountSeries;
    repo: RepoSeries;
    /** Present from the day `workflows.csv` first appears; empty before that. */
    workflows: WorkflowSeries;
  };
  releases: ReleaseEntry[];
  dimensions: {
    referrers: DimensionSeries;
    paths: DimensionSeries;
  };
}

/**
 * Parses a CSV field to a number, preserving the not-measured distinction.
 *
 * An empty field means the value was never measured — `repo.csv`'s
 * `downloads_total` is written blank when the optional releases fetch fails —
 * and must stay null. Coercing it to 0 would publish a fabricated measurement
 * that no consumer could tell from a real one. `Number('')` is 0, which is
 * exactly the trap; so is `Number('   ')`, which is why the emptiness test
 * runs on the TRIMMED value rather than on the raw field. Trimming cannot
 * lose information here because `Number` ignores surrounding whitespace
 * anyway — it only closes the gap where a hand-edited blank-looking field
 * would have become a fabricated 0.
 *
 * `undefined` — the column is absent from the file's header entirely — is
 * the same statement as a blank field: this run measured nothing for it.
 * That is what makes a column added mid-history read as null for the days
 * before it existed instead of as a run of zeroes.
 *
 * A field that is present and non-blank but does not parse is corruption,
 * not absence, and throws: substituting null there would quietly downgrade a
 * damaged file to "not measured" and publish the gap as if it were real.
 */
function toNumberOrNull(value: string | undefined, field: string, date: string): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`bundle: ${field} on ${date} is not a finite number: ${JSON.stringify(value)}`);
  }
  return parsed;
}

/** A CSV row that has been checked to carry a usable `date`. */
interface DatedRow {
  date: string;
  fields: Record<string, string>;
}

/**
 * Reads a dated CSV series and returns its rows in ascending date order.
 *
 * Sorts rather than trusting the file's order. `formatCsv` does write these
 * files sorted by their first column, so in the normal pipeline this is a
 * no-op — but the page draws a line through these points in array order, and
 * a file that arrived out of order (a hand-edit, a merge resolved by hand on
 * the data branch) would render as a zig-zag that looks like data rather
 * than like damage. No value is altered, dropped, or invented: each point
 * lands on the axis where its own date says it belongs. The sort is stable,
 * so rows sharing a date keep their file order.
 *
 * A row with a missing or blank `date` throws. It cannot be placed on a
 * timeline at all, and the two alternatives are both worse: dropping it
 * silently loses a measurement from the only surviving copy of data GitHub
 * deletes after 14 days, and keeping it with an empty x-value corrupts every
 * index alignment downstream.
 *
 * Sorting and the ABSENCE of a `YYYY-MM-DD` shape check are coupled, not
 * independent, and the coupling runs the uncomfortable way. Nothing in this
 * package validates that shape — `store.ts` declines to, for the reason
 * `parseMeta` documents — so a malformed but non-blank date (`2026-9-1`,
 * `Sept 1`) is not left sitting where a reader would notice it next to its
 * neighbours: it is RELOCATED to wherever byte comparison puts it, which for
 * those two examples is after every zero-padded date and before every digit
 * respectively. Sorting therefore makes the missing shape check more
 * consequential, not less. It is still the right default — an out-of-order
 * file is the failure that actually occurs, a hand-typed date is not, and
 * refusing to sort would mis-draw the common case to leave the rare one
 * marginally easier to spot — but the honest statement is that this function
 * trusts the collector to write well-formed dates, and reorders on that
 * assumption. If a shape check ever lands, it belongs at the write path,
 * where every writer passes, not here in the single reader.
 */
function readDatedRows(store: Store, file: string): DatedRow[] {
  const rows = store.readCsv(file);
  const dated = rows.map((fields, index): DatedRow => {
    const date = fields['date'];
    if (date === undefined || date.trim() === '') {
      throw new Error(`bundle: ${file} row ${index + 1} has a missing or empty "date"`);
    }
    return { date, fields };
  });
  return dated.sort((a, b) => compareStrings(a.date, b.date));
}

function readTrafficSeries(store: Store, file: string): TrafficSeries {
  const rows = readDatedRows(store, file);
  return {
    dates: rows.map((row) => row.date),
    count: rows.map((row) => toNumberOrNull(row.fields['count'], `${file} count`, row.date)),
    uniques: rows.map((row) => toNumberOrNull(row.fields['uniques'], `${file} uniques`, row.date)),
  };
}

function readWorkflowSeries(store: Store): WorkflowSeries {
  const rows = readDatedRows(store, WORKFLOWS_FILE);
  return {
    dates: rows.map((row) => row.date),
    runs: rows.map((row) => toNumberOrNull(row.fields['runs'], `${WORKFLOWS_FILE} runs`, row.date)),
  };
}

function readCountSeries(store: Store, file: string): CountSeries {
  const rows = readDatedRows(store, file);
  return {
    dates: rows.map((row) => row.date),
    total: rows.map((row) => toNumberOrNull(row.fields['total'], `${file} total`, row.date)),
  };
}

function readRepoSeries(store: Store): RepoSeries {
  const rows = readDatedRows(store, REPO_FILE);
  return {
    dates: rows.map((row) => row.date),
    subscribers: rows.map((row) =>
      toNumberOrNull(row.fields['subscribers'], `${REPO_FILE} subscribers`, row.date),
    ),
    open_issues: rows.map((row) =>
      toNumberOrNull(row.fields['open_issues'], `${REPO_FILE} open_issues`, row.date),
    ),
    downloads_total: rows.map((row) =>
      toNumberOrNull(row.fields['downloads_total'], `${REPO_FILE} downloads_total`, row.date),
    ),
    // Absent from every row written before the split existed. `toNumberOrNull`
    // maps both an absent field and a blank one to null, so those rows read as
    // "not measured" rather than as a zero download count.
    downloads_app: rows.map((row) =>
      toNumberOrNull(row.fields['downloads_app'], `${REPO_FILE} downloads_app`, row.date),
    ),
    downloads_updates: rows.map((row) =>
      toNumberOrNull(row.fields['downloads_updates'], `${REPO_FILE} downloads_updates`, row.date),
    ),
  };
}

/**
 * Reads `releases.csv` in `(date, tag)` order.
 *
 * Uses `compareReleaseRows` — the same comparator both writers of that file
 * use — rather than a local one, so the read order cannot drift from the
 * write order. A blank `tag` throws: a release's row identity IS its tag
 * (that is why the file is keyed on it rather than on date), so a row
 * without one cannot be told apart from any other release published the same
 * day. A blank `name` is not an error: GitHub allows an unnamed release and
 * `collect.ts` writes the empty string for one.
 */
function readReleases(store: Store): ReleaseEntry[] {
  const rows = store.readCsv(RELEASES_FILE);
  const entries = rows.map((fields, index): ReleaseEntry => {
    const date = fields['date'];
    const tag = fields['tag'];
    if (date === undefined || date.trim() === '') {
      throw new Error(`bundle: ${RELEASES_FILE} row ${index + 1} has a missing or empty "date"`);
    }
    if (tag === undefined || tag.trim() === '') {
      throw new Error(`bundle: ${RELEASES_FILE} row ${index + 1} has a missing or empty "tag"`);
    }
    return { date, tag, name: fields['name'] ?? '' };
  });
  return entries.sort(compareReleaseRows);
}

/**
 * Total order for one snapshot's rows: `count` descending, then `dimension`
 * ascending as the tie-break.
 *
 * The tie-break is not cosmetic. Without it, two referrers on the same count
 * would be ordered by however the NDJSON happened to be read, so the top-5
 * cut below — and therefore which trajectories the page draws — could change
 * from one bundle to the next with no change in the data.
 */
function compareByCountDesc(a: DimensionEntry, b: DimensionEntry): number {
  if (a.count !== b.count) return b.count - a.count;
  return compareStrings(a.dimension, b.dimension);
}

/**
 * Keys the per-snapshot count lookup on `` `${snapshot_date}\0${dimension}` ``.
 * A NUL byte cannot occur in either field, so unlike a space- or dash-joined
 * key this one cannot be forged by a dimension that contains the separator.
 */
function countKey(snapshotDate: string, dimension: string): string {
  return `${snapshotDate}\0${dimension}`;
}

/**
 * Reads a dimensional NDJSON file into snapshots, the latest ranking, and
 * differenced trajectories.
 *
 * The differencing is what makes these numbers readable at all: GitHub
 * reports referrers and paths as a TRAILING 14-DAY aggregate, so the raw
 * snapshot values are overlapping windows, and plotting them directly draws
 * a curve whose shape is dominated by what is ageing out of the window
 * rather than by what arrived. The delta between consecutive snapshots is
 * the closest honest answer to "what moved".
 *
 * A dimension missing from a snapshot means it fell outside GitHub's top ten
 * that day — NOT that it received zero traffic — so it yields null on both
 * the snapshot it is missing from and the one after it. The second null is
 * the less obvious half and matters just as much: differencing a present
 * value against a missing one has no defined answer, and the two ways to
 * fake one are both fabrications. Reaching back past the gap to the last
 * seen value reports a multi-snapshot change as if it were a single-step
 * one, and treating the missing value as 0 invents a jump the size of the
 * whole window.
 *
 * The absence test is `=== undefined`, never a falsy check, and the
 * distinction is the mirror of the one `toNumberOrNull` protects: a
 * dimension whose count did not move between two snapshots has a real,
 * measured delta of 0, and `if (!previous)` would silently promote it to the
 * same break a genuinely missing dimension produces. Null-never-zero and
 * zero-never-null are the same rule read from both ends.
 *
 * A blank `snapshot_date` throws, for the same reason `readDatedRows`
 * rejects a blank `date` — and with a sharper consequence here. The empty
 * string sorts before every real date, so a blank one would not merely fail
 * to place a row: it would insert a phantom leading snapshot into
 * `snapshots`, shifting every trajectory index by one and landing element
 * 0's structural null on a snapshot that never happened.
 */
function readDimensionSeries(store: Store, file: string): DimensionSeries {
  const rows = store.readNdjson(file);
  rows.forEach((row, index) => {
    // `parseNdjson` guarantees the field is a string and present; only
    // blankness is left to check, and `store.readNdjson` skips blank lines,
    // so the index counts rows rather than file lines.
    if (row.snapshot_date.trim() === '') {
      throw new Error(`bundle: ${file} row ${index + 1} has an empty "snapshot_date"`);
    }
  });
  const snapshots = [...new Set(rows.map((row) => row.snapshot_date))].sort(compareStrings);
  const latestDate = snapshots[snapshots.length - 1];
  if (latestDate === undefined) {
    return { snapshots: [], latest: [], trajectories: [] };
  }

  // Built in one pass. `latestByDimension` is a Map rather than a filtered
  // array so that a file holding two rows for the same
  // (snapshot_date, dimension) — which `upsertDimensional` prevents on
  // write, but which a hand-edited file could still contain — collapses to
  // one entry instead of producing a duplicate bar and a duplicate
  // trajectory.
  const counts = new Map<string, number>();
  const latestByDimension = new Map<string, DimensionEntry>();
  for (const row of rows) {
    counts.set(countKey(row.snapshot_date, row.dimension), row.count);
    if (row.snapshot_date === latestDate) {
      latestByDimension.set(row.dimension, {
        dimension: row.dimension,
        title: row.title,
        count: row.count,
        uniques: row.uniques,
      });
    }
  }

  const latest = [...latestByDimension.values()].sort(compareByCountDesc);
  const trajectories = latest.slice(0, TRAJECTORY_LIMIT).map((entry): DimensionTrajectory => {
    const delta = snapshots.map((snapshot, index): number | null => {
      const previousSnapshot = snapshots[index - 1];
      if (previousSnapshot === undefined) return null;
      const previous = counts.get(countKey(previousSnapshot, entry.dimension));
      const current = counts.get(countKey(snapshot, entry.dimension));
      if (previous === undefined || current === undefined) return null;
      return current - previous;
    });
    return { dimension: entry.dimension, delta };
  });

  return { snapshots, latest, trajectories };
}

/**
 * Earliest date across the six dated series, or null when none of them holds
 * a row.
 *
 * Computed from the data rather than hardcoded or taken from `meta.json`, so
 * a backfill that pushes history further back is reflected the moment it
 * lands.
 *
 * Release dates are deliberately NOT considered. They are upstream publish
 * dates, not measurement dates: a repo whose first release predates the
 * collector by a year would otherwise label the dashboard "since" a date on
 * which nothing was measured and no chart has a point. Dimension snapshot
 * dates are excluded for a narrower reason — they are not one of the
 * `series`, and every one of them is by construction on or after the first
 * collector run that also wrote a traffic row.
 */
function earliestDate(series: Array<{ dates: string[] }>): string | null {
  let earliest: string | null = null;
  for (const one of series) {
    // Each `dates` array is already ascending, so only the head can win.
    const first = one.dates[0];
    if (first === undefined) continue;
    if (earliest === null || compareStrings(first, earliest) < 0) earliest = first;
  }
  return earliest;
}

/**
 * Reads the whole archive through `store` and returns the object the static
 * dashboard renders.
 *
 * Pure with respect to the outside world beyond `store`: it writes nothing,
 * reads no environment variable, and never reads the clock. `generatedAt` is
 * a parameter for that reason — the same archive must always produce the
 * same bundle, which is what makes this function testable at all, and it
 * mirrors how `collect()` takes `today`/`now` rather than deriving them.
 *
 * A file that does not exist is not an error: `store.readCsv`/`readNdjson`
 * return `[]` for it, and an archive missing `releases.csv` entirely yields
 * `releases: []`. A file that exists but does not parse IS an error and is
 * allowed to propagate — catching it and substituting an empty series would
 * publish a blank chart for data that exists, which is indistinguishable on
 * the page from a repo that genuinely has no traffic.
 */
export function buildDashboardData(store: Store, generatedAt: string): DashboardData {
  const views = readTrafficSeries(store, VIEWS_FILE);
  const clones = readTrafficSeries(store, CLONES_FILE);
  const stars = readCountSeries(store, STARS_FILE);
  const forks = readCountSeries(store, FORKS_FILE);
  const contributors = readCountSeries(store, CONTRIBUTORS_FILE);
  const repo = readRepoSeries(store);
  const workflows = readWorkflowSeries(store);
  const releases = readReleases(store);
  const referrers = readDimensionSeries(store, REFERRERS_FILE);
  const paths = readDimensionSeries(store, PATHS_FILE);
  const meta = store.readMeta();

  const series = { views, clones, stars, forks, contributors, repo, workflows };

  // "Holds no rows at all" — releases and dimensions count here even though
  // they are excluded from `collection_started`. The two questions are
  // different: `empty` asks whether the page has anything whatsoever to
  // render (and it renders releases and referrer rankings), while
  // `collection_started` asks how far back the measured timeline reaches.
  // An archive holding only `meta.json` — the state right after bootstrap —
  // is empty by this test.
  const empty =
    Object.values(series).every((one) => one.dates.length === 0) &&
    releases.length === 0 &&
    referrers.snapshots.length === 0 &&
    paths.snapshots.length === 0;

  return {
    generated_at: generatedAt,
    collection_started: earliestDate(Object.values(series)),
    meta:
      meta === null
        ? null
        : { last_run: meta.last_run, last_success: meta.last_success, error: meta.error },
    empty,
    downsampled: false,
    series,
    releases,
    dimensions: { referrers, paths },
  };
}

/**
 * The published bundle's uncompressed size budget: 2 MB, measured as the
 * UTF-8 byte length of the serialised JSON (spec §7.1).
 *
 * Uncompressed and not gzipped on purpose. Pages serves the file gzipped, so
 * the number a visitor downloads is smaller — but the number that decides
 * whether the page is usable is the one the browser must parse and hold in
 * memory, and that is this one. Measuring the compressed size would also
 * make the budget depend on how well one particular archive happens to
 * compress, which is not a property of the dashboard.
 */
export const BUNDLE_BUDGET_BYTES = 2 * 1024 * 1024;

const MS_PER_DAY = 86_400_000;

/** The exact shape every date in the archive has, and the only one weekly bucketing can place. */
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The UTC Monday that opens `date`'s ISO week, as `YYYY-MM-DD`.
 *
 * Computed entirely in UTC. The archive treats every date as a UTC calendar
 * day (see `deriveRunTimestamps` in `cli-support.ts`), so using
 * `getDay`/`getDate` — which read the host's LOCAL calendar — would move a
 * day into the neighbouring week for any machine west of Greenwich and
 * produce a different bundle on a developer's laptop than in CI.
 *
 * `(getUTCDay() + 6) % 7` is the days-since-Monday offset, and the `+ 6`
 * is the whole reason this is not a one-liner: `getUTCDay()` returns 0 for
 * SUNDAY, not for Monday, so subtracting it directly would leave Sunday
 * alone as a bucket of one and push every other day back to the preceding
 * Sunday. The offset here maps Monday to 0 and Sunday to 6, which is the ISO
 * week — Monday through Sunday inclusive.
 *
 * This is the one place in the package that validates a date's SHAPE, and
 * the asymmetry with `readDatedRows` (which deliberately does not) is
 * justified by what each does with the value. Sorting only compares bytes,
 * so a malformed date is merely misplaced; week arithmetic must actually
 * parse it, and the two failure modes available without this check are both
 * silent — `new Date('2026-9-1')` is host-dependent, and `2026-02-30` rolls
 * over to 2 March in every JS date constructor, relocating a measurement by
 * two days under a bucket key that looks perfectly ordinary. The round-trip
 * comparison catches both, and also catches the legacy two-digit-year
 * mapping in `Date.UTC` (year 50 means 1950, year 1 means 1901).
 */
function utcMonday(date: string): string {
  const match = ISO_DATE_RE.exec(date);
  if (match === null) {
    throw new Error(`bundle: cannot bucket "${date}" into a week — expected a YYYY-MM-DD date`);
  }
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(time)) {
    throw new Error(`bundle: cannot bucket "${date}" into a week — it is not a real date`);
  }
  const parsed = new Date(time);
  if (parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(
      `bundle: cannot bucket "${date}" into a week — it is not a real calendar date`,
    );
  }
  const daysSinceMonday = (parsed.getUTCDay() + 6) % 7;
  return new Date(time - daysSinceMonday * MS_PER_DAY).toISOString().slice(0, 10);
}

/** One ISO week's worth of a series, as the indices of the rows that fall in it. */
interface WeekBucket {
  /** The UTC Monday that opens the week, and the date the bucket is published under. */
  monday: string;
  /** Indices into the source `dates`/value arrays, in the order they appeared. */
  indices: number[];
}

/**
 * Groups a series' dates into ISO weeks, ascending by Monday.
 *
 * Returns indices rather than values so one grouping pass serves every
 * parallel array of a series at once — `RepoSeries` has three, and
 * re-deriving the buckets per field would let the three drift out of index
 * alignment if any of them ever grouped differently.
 *
 * A week with no rows produces no bucket. That is the same rule the daily
 * series follow (`buildDashboardData` does not gap-fill a missing day), and
 * the reason is the same: an invented point is a claim that something was
 * measured.
 */
function weekBuckets(dates: readonly string[]): WeekBucket[] {
  const byMonday = new Map<string, number[]>();
  for (const [index, date] of dates.entries()) {
    const monday = utcMonday(date);
    const existing = byMonday.get(monday);
    if (existing === undefined) {
      byMonday.set(monday, [index]);
    } else {
      existing.push(index);
    }
  }
  return [...byMonday.entries()]
    .map(([monday, indices]): WeekBucket => ({ monday, indices }))
    .sort((a, b) => compareStrings(a.monday, b.monday));
}

/**
 * A bucket's total for a PER-DAY EVENT COUNT (`views.count`, `clones.uniques`).
 *
 * Nulls are skipped rather than counted as 0, and the accumulator starts at
 * `null` rather than at 0 so a bucket in which nothing was measured stays
 * null. Starting at 0 is the single easiest way to fabricate a measurement
 * here: it turns "the collector did not run that week" into "that week had
 * no traffic", two statements the page renders very differently and the
 * archive can never tell apart again once the distinction is gone.
 *
 * A partly-measured week sums the days it has, which understates the week.
 * That is deliberate and is the least-bad option: the alternative — nulling
 * any week with a gap — would blank the first and last buckets of every
 * bundle, since both are partial weeks by construction, and would discard
 * measurements that really were taken. The page labels a downsampled range
 * as weekly, which is what makes a short week readable as a short week.
 *
 * `undefined` is treated as absent for the same reason as null. Under
 * `noUncheckedIndexedAccess` it is reachable only from a value array shorter
 * than its `dates` array — a malformed `DashboardData` no producer in this
 * package emits — and treating it as absent rather than crashing keeps the
 * budget pass from being the thing that fails on it.
 */
function sumBucket(values: ReadonlyArray<number | null>, indices: readonly number[]): number | null {
  let total: number | null = null;
  for (const index of indices) {
    const value = values[index];
    if (value === undefined || value === null) continue;
    total = total === null ? value : total + value;
  }
  return total;
}

/**
 * A bucket's value for a CUMULATIVE COUNTER (`stars.total`, every field of
 * `repo`): the last measured value in the week.
 *
 * Summing these would be meaningless — seven daily readings of a star count
 * that sat at 66 all week would publish 462 stars — and it is meaningless in
 * a way that looks entirely plausible on a chart, which is why the two
 * aggregators are separate named functions rather than a boolean flag on
 * one.
 *
 * "Last MEASURED", not "last element": a week whose final days are null was
 * still measured earlier in the week, and reading the literal last value
 * would publish an absence invented out of a real measurement. Picking the
 * highest date rather than the highest index also means an unsorted input
 * cannot silently yield the wrong reading — the values in a bucket are
 * ordered by what their dates say, not by where they happened to sit in the
 * array.
 *
 * `>=` rather than `>` on the date comparison so that two rows sharing a
 * date resolve to the later one in file order, matching what "last" means
 * everywhere else in this package.
 */
function lastBucket(
  dates: readonly string[],
  values: ReadonlyArray<number | null>,
  indices: readonly number[],
): number | null {
  let latestDate: string | null = null;
  let latest: number | null = null;
  for (const index of indices) {
    const value = values[index];
    if (value === undefined || value === null) continue;
    const date = dates[index];
    if (date === undefined) continue;
    if (latestDate === null || compareStrings(date, latestDate) >= 0) {
      latestDate = date;
      latest = value;
    }
  }
  return latest;
}

function downsampleTraffic(series: TrafficSeries): TrafficSeries {
  const buckets = weekBuckets(series.dates);
  return {
    dates: buckets.map((bucket) => bucket.monday),
    count: buckets.map((bucket) => sumBucket(series.count, bucket.indices)),
    // `uniques` sums too. A week's unique visitors are not the sum of its
    // daily uniques — someone who visited on Monday and Thursday is counted
    // twice — but the archive holds only daily figures, so a true weekly
    // unique count is not recoverable from it at any resolution. The sum is
    // an upper bound and moves with the quantity it describes; taking the
    // last day's uniques instead would report one day as if it were seven,
    // which is wrong by a much larger factor and in the opposite direction.
    uniques: buckets.map((bucket) => sumBucket(series.uniques, bucket.indices)),
  };
}

/**
 * Workflow runs SUM within a week, like the traffic counts and unlike the
 * cumulative counters: a run is an event that happened on its day, so a week's
 * runs are genuinely the sum of its days'. Taking the last day would report
 * one day as if it were seven, and would flatten exactly the CI spikes this
 * series exists to make visible next to the clone line.
 *
 * `sumBucket` preserves the not-measured distinction the same way it does for
 * traffic, so a week in which the collector never ran stays `null` rather than
 * summing to a zero that would read as a genuinely quiet week.
 */
function downsampleWorkflows(series: WorkflowSeries): WorkflowSeries {
  const buckets = weekBuckets(series.dates);
  return {
    dates: buckets.map((bucket) => bucket.monday),
    runs: buckets.map((bucket) => sumBucket(series.runs, bucket.indices)),
  };
}

function downsampleCount(series: CountSeries): CountSeries {
  const buckets = weekBuckets(series.dates);
  return {
    dates: buckets.map((bucket) => bucket.monday),
    total: buckets.map((bucket) => lastBucket(series.dates, series.total, bucket.indices)),
  };
}

function downsampleRepo(series: RepoSeries): RepoSeries {
  const buckets = weekBuckets(series.dates);
  return {
    dates: buckets.map((bucket) => bucket.monday),
    subscribers: buckets.map((bucket) =>
      lastBucket(series.dates, series.subscribers, bucket.indices),
    ),
    open_issues: buckets.map((bucket) =>
      lastBucket(series.dates, series.open_issues, bucket.indices),
    ),
    downloads_total: buckets.map((bucket) =>
      lastBucket(series.dates, series.downloads_total, bucket.indices),
    ),
    downloads_app: buckets.map((bucket) =>
      lastBucket(series.dates, series.downloads_app, bucket.indices),
    ),
    downloads_updates: buckets.map((bucket) =>
      lastBucket(series.dates, series.downloads_updates, bucket.indices),
    ),
  };
}

/**
 * A structural copy of a dimension series, down to the individual entries.
 *
 * The bucketed series are rebuilt from scratch, so they are new arrays
 * whatever this function does; `releases`, `dimensions` and `meta` are the
 * parts `downsampleWeekly` passes straight through, and copying them is what
 * makes its purity a property of the function rather than a promise about
 * everyone downstream. It is genuinely non-mutating today — but the
 * over-budget error message points a future maintainer at capping the
 * dimension history as the lever to pull, so the next person to edit this
 * package will be editing exactly these structures, holding what looks like
 * a private copy. Sharing the references would make that a silent
 * action-at-a-distance bug in the daily bundle the weekly one was derived
 * from.
 *
 * Deliberately explicit rather than `structuredClone`: the shape is fixed by
 * the published contract, so an explicit copy fails to compile if the
 * contract grows a field, where a generic clone would carry it silently and
 * hide the fact that nobody decided how the new field should be bucketed.
 */
function copyDimensionSeries(series: DimensionSeries): DimensionSeries {
  return {
    snapshots: [...series.snapshots],
    latest: series.latest.map((entry) => ({ ...entry })),
    trajectories: series.trajectories.map((trajectory) => ({
      dimension: trajectory.dimension,
      delta: [...trajectory.delta],
    })),
  };
}

/**
 * Reduces the six dated series to weekly buckets, keyed on the UTC Monday.
 *
 * Pure, exactly as `buildDashboardData` is: no clock, no environment, no
 * writes, and no mutation of the argument — the caller keeps a usable daily
 * bundle after the call, which is what lets the budget pass measure both and
 * publish the smaller one. The result shares no mutable object with the
 * argument either: the bucketed series are rebuilt, and the pass-through
 * parts (`releases`, `dimensions`, `meta`) are copied rather than aliased,
 * so neither bundle can be changed through the other.
 *
 * Three groups of fields, three different treatments, and the difference
 * between the first two is the one thing in this function that cannot be got
 * wrong safely:
 *
 * - `views` and `clones` are per-day event counts and SUM within a week.
 * - `stars`, `forks`, `contributors` and every field of `repo` are
 *   point-in-time totals and take the week's LAST measured value.
 * - `workflows.runs` sums, for the same reason the traffic counts do: a run is
 *   an event on its day, not a running total.
 * - `releases` and `dimensions` are not bucketed at all. Releases are sparse
 *   — there is no space to save, and merging two tags published in one week
 *   into one marker would destroy the annotation the Growth chart exists
 *   for. Dimension series are already bounded by top-10-per-snapshot, and
 *   their trajectories are differences between CONSECUTIVE snapshots, a
 *   quantity weekly bucketing would silently redefine into something else
 *   with the same name.
 *
 * `collection_started` and `empty` are carried through untouched rather than
 * recomputed. `empty` cannot change — bucketing an empty series yields an
 * empty series — but `collection_started` would: a first measurement on a
 * Wednesday buckets under the preceding Monday, and recomputing the field
 * from the bucket keys would move the page's honest "since <date>" label
 * onto a day on which nothing was measured and no chart has a point. The
 * bucket key is a label for a week; `collection_started` is a claim about a
 * measurement, and only one of the two may be back-dated.
 */
export function downsampleWeekly(data: DashboardData): DashboardData {
  return {
    ...data,
    meta: data.meta === null ? null : { ...data.meta },
    downsampled: true,
    series: {
      views: downsampleTraffic(data.series.views),
      clones: downsampleTraffic(data.series.clones),
      stars: downsampleCount(data.series.stars),
      forks: downsampleCount(data.series.forks),
      contributors: downsampleCount(data.series.contributors),
      repo: downsampleRepo(data.series.repo),
      workflows: downsampleWorkflows(data.series.workflows),
    },
    releases: data.releases.map((release) => ({ ...release })),
    dimensions: {
      referrers: copyDimensionSeries(data.dimensions.referrers),
      paths: copyDimensionSeries(data.dimensions.paths),
    },
  };
}

/** The bytes to publish as `data.json`, with the measurements a run log should report. */
export interface BundleResult {
  /** The exact text to write. */
  json: string;
  /** UTF-8 byte length of `json`, the quantity the budget is measured in. */
  bytes: number;
  /** Whether the series were reduced to weekly buckets to fit the budget. */
  downsampled: boolean;
}

/**
 * Serialises `data`, downsampling to weekly buckets if — and only if — the
 * daily bundle exceeds the budget.
 *
 * Build, serialise, measure; if over, downsample, re-serialise, re-measure;
 * if still over, throw. The order matters: downsampling unconditionally
 * would publish weekly buckets for the many years this archive will spend
 * comfortably under 2 MB, throwing away resolution nobody needed to save,
 * and would light up the page's "weekly" label over data that is daily.
 *
 * Failing is the correct end state rather than a fallback, per spec §7.1.
 * The alternatives are truncating a series — silently dropping the oldest
 * history from the only surviving copy of data GitHub deletes after 14 days,
 * which is exactly the loss this archive exists to prevent — or publishing
 * an oversized bundle, which moves the regression from a red CI run to a
 * visitor's first paint. A build that fails is a build a maintainer fixes.
 *
 * Bytes are measured with `Buffer.byteLength`, not `String#length`. The
 * latter counts UTF-16 code units, so a single emoji or accented character
 * in a referrer title — upstream text this package does not control —
 * under-counts against a budget expressed in bytes.
 *
 * The under-budget path reports `data.downsampled` rather than a hardcoded
 * `false`: this function's answer is "did the published bundle end up
 * weekly", and a caller that already downsampled for its own reasons must
 * not have that fact erased on the way out.
 */
export function serialiseWithinBudget(data: DashboardData): BundleResult {
  const daily = JSON.stringify(data);
  const dailyBytes = Buffer.byteLength(daily, 'utf8');
  if (dailyBytes <= BUNDLE_BUDGET_BYTES) {
    return { json: daily, bytes: dailyBytes, downsampled: data.downsampled };
  }

  const weekly = downsampleWeekly(data);
  const json = JSON.stringify(weekly);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > BUNDLE_BUDGET_BYTES) {
    throw new Error(
      `bundle: ${bytes} bytes after weekly downsampling (from ${dailyBytes} daily) still exceeds ` +
        `the ${BUNDLE_BUDGET_BYTES}-byte budget. Nothing was dropped to fit: a series is never ` +
        `truncated. Reduce what the bundle carries (e.g. cap the release list or the dimension ` +
        `history) or raise the budget deliberately.`,
    );
  }
  return { json, bytes, downsampled: true };
}

/**
 * The fraction of the budget at which the bundler starts warning.
 *
 * 80 %, i.e. 1 677 721 of the 2 097 152 bytes. Chosen from what the archive
 * actually does rather than from habit: it grows by roughly 68 KB a year, so
 * the 419 431 bytes between this mark and the budget are about **six years**
 * of lead time — long enough that a maintainer who sees the warning can
 * schedule the decision (raise the budget, cap the dimension history, accept
 * weekly buckets) instead of discovering it as a fait accompli in a deploy
 * log.
 *
 * Higher would be worse in the obvious way. Lower would be worse in a less
 * obvious one: a warning that fires for a decade before it means anything is
 * a warning nobody reads by the time it matters. At the live bundle's
 * current 3.5 KB this mark is over two decades away, so the threshold costs
 * nothing until it is genuinely close.
 */
export const BUNDLE_WARN_FRACTION = 0.8;

/** The absolute size at which `budgetWarning` starts returning a message. */
export const BUNDLE_WARN_BYTES = Math.floor(BUNDLE_BUDGET_BYTES * BUNDLE_WARN_FRACTION);

/**
 * A warning for a bundle approaching the budget, or `null` when it is not.
 *
 * Without this, the daily-to-weekly flip arrives with no notice whatsoever:
 * one build is fine, the next silently halves the resolution of every chart
 * on the page, and the only signal is a line in a deploy log nobody reads
 * when the deploy succeeded. A size budget with a hard cliff and no approach
 * warning converts a slow, predictable growth curve into a surprise.
 *
 * The message says which side of the cliff the bundle is on, because the
 * next event differs and so does the remedy. A daily bundle nearing the
 * budget will be downsampled — recoverable, but it changes what every chart
 * means. A bundle that is ALREADY weekly and still nearing the budget has no
 * reduction left: weekly buckets are the last one, nothing is ever
 * truncated to fit, and the next step is a failed build.
 *
 * Returns the text rather than printing it, so this stays pure and testable
 * and the entrypoint keeps sole ownership of the process's output streams.
 */
export function budgetWarning(result: BundleResult): string | null {
  if (result.bytes < BUNDLE_WARN_BYTES) return null;
  const percent = ((result.bytes / BUNDLE_BUDGET_BYTES) * 100).toFixed(1);
  const remaining = BUNDLE_BUDGET_BYTES - result.bytes;
  const next = result.downsampled
    ? 'It is already downsampled to weekly buckets, which is the last reduction available: ' +
      'nothing is ever truncated to fit, so exceeding the budget will FAIL the build. Cap what ' +
      'the bundle carries (the release list or the dimension history) or raise the budget ' +
      'deliberately.'
    : 'Exceeding the budget will downsample every series to weekly buckets, changing the ' +
      'resolution of every chart on the page at once. Decide now whether to accept that, cap ' +
      'what the bundle carries, or raise the budget.';
  return (
    `bundle: WARNING — data.json is ${result.bytes} bytes, ${percent}% of the ` +
    `${BUNDLE_BUDGET_BYTES}-byte budget (${remaining} bytes of headroom left). ${next}`
  );
}
