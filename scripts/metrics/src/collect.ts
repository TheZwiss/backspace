import { upsertByDate, upsertByKey, upsertDimensional, compareReleaseRows } from './series.ts';
import type { GitHubClient } from './github.ts';
import type { Meta, Store } from './store.ts';
import type {
  CountPoint,
  DimensionRow,
  IsoDate,
  ReleaseRow,
  RepoPoint,
  TrafficPoint,
} from './types.ts';

interface TrafficBucket {
  timestamp: string;
  count: number;
  uniques: number;
}
interface ViewsResponse {
  views: TrafficBucket[];
}
interface ClonesResponse {
  clones: TrafficBucket[];
}
interface ReferrerResponse {
  referrer: string;
  count: number;
  uniques: number;
}
interface PathResponse {
  path: string;
  title: string;
  count: number;
  uniques: number;
}
interface RepoResponse {
  stargazers_count: number;
  forks_count: number;
  subscribers_count: number;
  open_issues_count: number;
}
interface ReleaseResponse {
  tag_name: string;
  name: string | null;
  published_at: string | null;
  assets: Array<{ download_count: number }>;
}
interface ContributorResponse {
  weeks: Array<{ w: number; c: number }>;
}

export interface CollectResult {
  written: string[];
  skipped: string[];
}

export interface CollectOptions {
  client: GitHubClient;
  store: Store;
  /** `owner/repo`, from `github.repository`. */
  slug: string;
  /** Today in UTC, `YYYY-MM-DD`. Injected for deterministic tests. */
  today: IsoDate;
  /** Run timestamp, ISO 8601. Injected for deterministic tests. */
  now: string;
}

/** Converts an ISO timestamp to its UTC calendar date. */
function toDate(timestamp: string): IsoDate {
  const date = timestamp.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Unparseable timestamp from the API: ${timestamp}`);
  }
  return date;
}

function toTraffic(buckets: TrafficBucket[]): TrafficPoint[] {
  return buckets.map((bucket) => ({
    date: toDate(bucket.timestamp),
    count: bucket.count,
    uniques: bucket.uniques,
  }));
}

/**
 * Runs the daily collection.
 *
 * Atomicity is the whole design of this function, constructed rather than
 * inherited from `Store` — the store's write path is atomic per file (a
 * temp-write-then-rename), not across the several files one run touches.
 * Every required series is fetched into memory (via `Promise.all`, which
 * rejects on the first failure) before a single `store.write*` call is
 * made, and every value derived from an optional fetch is fully computed
 * before that point too. The result is that once the write phase begins,
 * every `store.write*` call in it is synchronous (the store's read/write
 * path uses Node's `*Sync` fs functions throughout) with no `await` between
 * them — so there is no `await` point, and therefore no place the event
 * loop could interleave a second run or hand control anywhere else, between
 * the first file this run writes and the last. `meta.json` is written last
 * of all, once every data file has landed, so its presence (and its
 * `last_success` timestamp) is a completion marker a reader can trust: if a
 * run dies before reaching it, `readMeta()` still reflects the previous
 * run.
 *
 * The remaining failure window is real, not theoretical, and worth stating
 * plainly rather than claiming perfect atomicity: a synchronous run of
 * `writeFileSync`/`renameSync` calls still touches the OS one syscall at a
 * time, so a hard process kill (OOM, `SIGKILL`) or an OS-level write error
 * (`ENOSPC`, a permissions change mid-run) occurring between two of those
 * syscalls can still leave some files updated to today and others holding
 * yesterday's content, with `meta.json` in that case simply never reaching
 * its update and so still pointing at the last run that DID complete. That
 * window cannot be closed at this layer — `store.ts`'s own per-file write
 * admits the same limit for a single file — only made as narrow as
 * synchronous, no-`await`, meta-json-last sequencing can make it.
 *
 * A required failure propagates before any of that begins, leaving the data
 * directory and `meta.json` completely untouched, so a half-failed run can
 * never produce a file the next run treats as authoritative. Optional
 * series degrade to a skip instead, because releases and contributor stats
 * are reconstructable at any later date while traffic is not.
 */
export async function collect(options: CollectOptions): Promise<CollectResult> {
  const { client, store, slug, today, now } = options;
  const repoPath = `/repos/${slug}`;
  const skipped: string[] = [];

  // --- Required. Any rejection here aborts before any write. ---
  const [views, clones, referrers, paths, repo] = await Promise.all([
    client.get<ViewsResponse>(`${repoPath}/traffic/views`),
    client.get<ClonesResponse>(`${repoPath}/traffic/clones`),
    client.get<ReferrerResponse[]>(`${repoPath}/traffic/popular/referrers`),
    client.get<PathResponse[]>(`${repoPath}/traffic/popular/paths`),
    client.get<RepoResponse>(repoPath),
  ]);

  // --- Optional. A failure skips the series, never zeroes it. ---
  // Paginated, matching backfill.ts: GitHub's default page size is 30, so a
  // plain `client.get` here would sum asset downloads from only the 30 most
  // recent releases. Past the 31st release that produces a cumulative
  // counter that DECREASES on the day a new release ships, and from then on
  // every run records a plausible-looking total that was never the true
  // sum — with no error, ever, because a short list is not distinguishable
  // from a complete one without paginating to find out.
  let releases: ReleaseResponse[] | null = null;
  try {
    releases = await client.paginate<ReleaseResponse>(`${repoPath}/releases`);
  } catch {
    skipped.push('releases.csv');
  }

  let contributors: ContributorResponse[] | null = null;
  try {
    contributors = await client.getStats<ContributorResponse[]>(`${repoPath}/stats/contributors`);
  } catch {
    contributors = null;
  }
  if (contributors === null) skipped.push('contributors.csv');

  // `downloads_total` is folded into `repo.csv` alongside the required
  // `subscribers`/`open_issues` counters, but it is itself sourced from the
  // optional `releases` fetch. `releases === null ? 0 : sum(...)` — summing
  // to zero when the fetch failed — would write a permanent lie: a zero
  // recorded for a download count GitHub simply never returned this run,
  // indistinguishable later from a genuine zero. Carrying the previous run's
  // value forward under today's date is not a safer alternative: it writes a
  // plausible, undetectable plateau, worse than the zero it would replace,
  // since a zero at least self-flags as anomalous for a cumulative counter.
  // When `releases` fetched cleanly the sum is authoritative and always
  // wins. When it didn't, `downloads_total` is left `null` — rendered as a
  // blank CSV field by `formatCsv` — rather than fabricated from history.
  // `subscribers`/`open_issues` are unaffected either way: they come from
  // the required repo-object fetch, which has already resolved successfully
  // by the time this runs, so a `releases` failure never costs the row those
  // two required fields.
  let downloadsTotal: number | null;
  if (releases !== null) {
    downloadsTotal = releases.reduce(
      (sum, release) =>
        sum + release.assets.reduce((assetSum, asset) => assetSum + asset.download_count, 0),
      0,
    );
  } else {
    downloadsTotal = null;
    skipped.push('repo.csv:downloads_total');
  }

  const written: string[] = [];

  // Generic over `T` rather than typed directly to `Record<string, string |
  // number>` at the call boundary: `TrafficPoint`, `CountPoint`, `RepoPoint`
  // and `ReleaseRow` are all `interface` declarations, none of which carry
  // an index signature, and TypeScript does not treat "every property
  // happens to be `string | number`" as satisfying `Record<string, string |
  // number>` for a nominally-declared interface — only the internal cast to
  // `Record` (a controlled, single-purpose assertion, not `any`) bridges
  // that gap, once per call, at the one place it's actually needed: handing
  // rows to `store.writeCsv`, whose signature is necessarily untyped
  // `Record` because the store has no knowledge of any specific series'
  // shape.
  function writeCsvSeries<T extends { date: IsoDate }>(
    file: string,
    header: readonly string[],
    incoming: readonly T[],
  ): void {
    const existing = store.readCsv(file) as unknown as T[];
    const merged = upsertByDate(existing, incoming, 'overwrite');
    store.writeCsv(file, header, merged as unknown as Array<Record<string, string | number>>);
    written.push(file);
  }

  // `releases.csv` cannot use `writeCsvSeries`/`upsertByDate`: a release
  // series is not a daily series, and keying its merge on `date` would
  // collapse two releases published on the same UTC day into one row,
  // silently dropping the other. A release's true row identity is its tag,
  // so this merges with `upsertByKey` keyed on `tag` instead, and sorts with
  // `compareReleaseRows` (date, then tag) so the output stays byte-stable
  // regardless of which same-day release the API happened to list first.
  function writeReleases(file: string, incoming: readonly ReleaseRow[]): void {
    const existing = store.readCsv(file) as unknown as ReleaseRow[];
    const merged = upsertByKey(existing, incoming, (row) => row.tag, 'overwrite', compareReleaseRows);
    store.writeCsv(
      file,
      ['date', 'tag', 'name'],
      merged as unknown as Array<Record<string, string | number>>,
    );
    written.push(file);
  }

  function writeDimensional(file: string, incoming: readonly DimensionRow[]): void {
    const merged = upsertDimensional(store.readNdjson(file), incoming);
    store.writeNdjson(file, merged);
    written.push(file);
  }

  writeCsvSeries('traffic/views.csv', ['date', 'count', 'uniques'], toTraffic(views.views));
  writeCsvSeries('traffic/clones.csv', ['date', 'count', 'uniques'], toTraffic(clones.clones));

  writeDimensional(
    'traffic/referrers.ndjson',
    referrers.map((item) => ({
      snapshot_date: today,
      dimension: item.referrer,
      title: '',
      count: item.count,
      uniques: item.uniques,
    })),
  );
  writeDimensional(
    'traffic/paths.ndjson',
    paths.map((item) => ({
      snapshot_date: today,
      dimension: item.path,
      title: item.title,
      count: item.count,
      uniques: item.uniques,
    })),
  );

  // Stars and forks come from the repo object's counters rather than by listing
  // stargazers. That is a point-in-time measurement, so it correctly reflects
  // people who starred and later unstarred — which the backfill, working from
  // `starred_at`, structurally cannot see.
  const stars: CountPoint = { date: today, total: repo.stargazers_count };
  const forks: CountPoint = { date: today, total: repo.forks_count };
  writeCsvSeries('stars.csv', ['date', 'total'], [stars]);
  writeCsvSeries('forks.csv', ['date', 'total'], [forks]);

  // Always written: `subscribers`/`open_issues` are required-fetch fields
  // that have already resolved successfully by this point, so they are
  // never held hostage to whether the unrelated optional `releases` fetch
  // succeeded. `downloads_total` is `null` (blank on disk) exactly when it
  // wasn't measured this run — see the comment above.
  const repoPoint: RepoPoint = {
    date: today,
    subscribers: repo.subscribers_count,
    open_issues: repo.open_issues_count,
    downloads_total: downloadsTotal,
  };
  writeCsvSeries('repo.csv', ['date', 'subscribers', 'open_issues', 'downloads_total'], [repoPoint]);

  if (releases !== null) {
    const releaseRows: ReleaseRow[] = releases
      .filter((release) => release.published_at !== null)
      .map((release) => ({
        date: toDate(release.published_at as string),
        tag: release.tag_name,
        name: release.name ?? release.tag_name,
      }));
    writeReleases('releases.csv', releaseRows);
  }

  if (contributors !== null) {
    // A contributor counts from the week of their first commit onward, so the
    // series is a cumulative distinct count rather than a weekly total.
    const firstWeeks = contributors
      .map((contributor) => contributor.weeks.find((week) => week.c > 0)?.w)
      .filter((week): week is number => week !== undefined)
      .sort((a, b) => a - b);
    let running = 0;
    const points: CountPoint[] = firstWeeks.map((week) => {
      running += 1;
      return { date: new Date(week * 1000).toISOString().slice(0, 10), total: running };
    });
    if (points.length > 0) {
      writeCsvSeries('contributors.csv', ['date', 'total'], points);
    } else {
      // A genuine 200 with no contributor ever showing a positive-commit
      // week is not distinguishable here from "nothing to report" — either
      // way there is no fresh value to write, so this degrades to a skip
      // exactly like a persistent 202 does, rather than silently leaving it
      // out of `skipped` just because the failure mode differs.
      skipped.push('contributors.csv');
    }
  }

  const lastDate = (file: string): IsoDate | undefined => {
    const rows = store.readCsv(file);
    return rows[rows.length - 1]?.date;
  };

  const seriesLastDate: Record<string, IsoDate> = {};
  for (const file of written) {
    if (!file.endsWith('.csv')) continue;
    const last = lastDate(file);
    if (last !== undefined) seriesLastDate[file] = last;
  }

  const meta: Meta = {
    last_run: now,
    last_success: now,
    error: null,
    series_last_date: seriesLastDate,
  };
  store.writeMeta(meta);

  return { written, skipped };
}
