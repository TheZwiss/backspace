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
