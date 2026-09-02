/** A UTC calendar date, `YYYY-MM-DD`. */
export type IsoDate = string;

/** One day of views or clones. */
export interface TrafficPoint {
  date: IsoDate;
  count: number;
  uniques: number;
}

/** One day of a cumulative counter (stars, forks, contributors). */
export interface CountPoint {
  date: IsoDate;
  total: number;
}

/**
 * One day of this repository's own CI activity: the number of workflow runs
 * it started on that UTC date.
 *
 * It exists to sit beside `traffic/clones.csv`, which GitHub inflates with
 * every `actions/checkout` this repository runs. The two are plotted as
 * stacked charts under one synced cursor so a clone spike that is really a
 * build spike is visible as such, rather than described in prose the reader
 * has to take on trust. They do NOT share an x axis: this series is
 * reconstructed back to whatever the Actions API still retains, where traffic
 * begins on the day the collector first ran, so each chart is drawn across
 * its own measured days and the cursor carries the comparison.
 *
 * Unlike traffic, a day with no runs is a MEASURED ZERO, not an absence: the
 * Actions API is asked for a whole window and answers completely, where the
 * traffic endpoints omit a zero-traffic day entirely. So this series writes
 * an explicit `0` for a quiet day and plots it at zero, and a genuine gap
 * here means the collector did not run. See §4.3.
 */
export interface WorkflowPoint {
  date: IsoDate;
  runs: number;
}

/** A published release. `date` is the UTC day of `published_at`. */
export interface ReleaseRow {
  date: IsoDate;
  tag: string;
  name: string;
}

/**
 * One day of repo-object counters. `downloads_total` is sourced from the
 * optional `releases` fetch, unlike `subscribers`/`open_issues`, which are
 * required; it is `null` when that fetch failed this run and no fresh sum
 * could be measured. `null` renders as a blank CSV field (see `formatCsv`),
 * distinguishing "not measured this run" from a genuine `0` — never collapse
 * the two.
 */
export interface RepoPoint {
  date: IsoDate;
  subscribers: number;
  open_issues: number;
  downloads_total: number | null;
  /**
   * `downloads_total` split by what the asset is for: `downloads_app` counts
   * installers and archives, `downloads_updates` counts electron-updater feed
   * files and blockmaps that every installed client fetches on an update
   * check. Both are blank for rows written before the split existed.
   */
  downloads_app: number | null;
  downloads_updates: number | null;
}

/**
 * One row of a trailing-14-day aggregate, tagged with the day it was fetched.
 * `dimension` is the referrer host or the content path.
 */
export interface DimensionRow {
  snapshot_date: IsoDate;
  dimension: string;
  title: string;
  count: number;
  uniques: number;
}
