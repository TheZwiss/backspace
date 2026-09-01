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
   * budget. Always false here — `buildDashboardData` never downsamples; the
   * budget pass owns that flag and flips it when it acts.
   */
  downsampled: boolean;
  series: {
    views: TrafficSeries;
    clones: TrafficSeries;
    stars: CountSeries;
    forks: CountSeries;
    contributors: CountSeries;
    repo: RepoSeries;
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
 * than like damage. Sorting is not a repair that hides corruption: no value
 * is altered, dropped, or invented, only placed on the axis where its own
 * date says it belongs. The sort is stable, so rows sharing a date keep
 * their file order.
 *
 * A row with a missing or blank `date` throws. It cannot be placed on a
 * timeline at all, and the two alternatives are both worse: dropping it
 * silently loses a measurement from the only surviving copy of data GitHub
 * deletes after 14 days, and keeping it with an empty x-value corrupts every
 * index alignment downstream.
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
 */
function readDimensionSeries(store: Store, file: string): DimensionSeries {
  const rows = store.readNdjson(file);
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
  const releases = readReleases(store);
  const referrers = readDimensionSeries(store, REFERRERS_FILE);
  const paths = readDimensionSeries(store, PATHS_FILE);
  const meta = store.readMeta();

  const series = { views, clones, stars, forks, contributors, repo };

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
