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

/** One day of repo-object counters. */
export interface RepoPoint {
  date: IsoDate;
  subscribers: number;
  open_issues: number;
  downloads_total: number;
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
