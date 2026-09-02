import { upsertByDate, upsertByKey, compareReleaseRows, compareStrings } from './series.ts';
import type { GitHubClient } from './github.ts';
import type { Store } from './store.ts';
import type { CountPoint, IsoDate, ReleaseRow } from './types.ts';

interface StargazerResponse {
  starred_at: string;
}
interface ForkResponse {
  created_at: string;
}
interface ReleaseResponse {
  tag_name: string;
  name: string | null;
  published_at: string | null;
}

export interface BackfillOptions {
  client: GitHubClient;
  store: Store;
  /** `owner/repo`, from `github.repository`. */
  slug: string;
  /**
   * The UTC date the reconstruction is being taken on, injected the same way
   * `collect.ts` takes it rather than read from the clock here, so the output
   * stays a pure function of the inputs and the tests can pin it.
   *
   * It bounds the cumulative fill forward: a star counter is known on every
   * day between its first event and the moment it is read, so a quiet stretch
   * running from the last star up to the present is knowledge, not a gap. It
   * is a bound and never a truncation — an event dated after it (clock skew,
   * or a star that lands while the job pages through the list) still gets its
   * row.
   */
  today: IsoDate;
}

/**
 * Files backfill is permitted to write. Exhaustive and deliberately short.
 *
 * `traffic/*` is excluded because GitHub exposes no historical traffic API —
 * a 14-day trailing window is all that has ever existed for it, so there is
 * nothing to reconstruct. `repo.csv` is excluded because `subscribers` has
 * no historical API either: a stray rewrite there would be a permanent loss
 * with nothing to restore from. `contributors.csv` is likewise excluded —
 * the `/stats/contributors` weekly buckets already cover all of history
 * whenever the daily collector can fetch them, so there is no gap for a
 * one-shot backfill to fill, and no cheaper reconstruction exists.
 */
const WRITABLE = ['stars.csv', 'forks.csv', 'releases.csv'] as const;

const MS_PER_DAY = 86_400_000;

/**
 * Upper bound on the number of days one reconstruction may write. GitHub
 * launched in 2008, so a repository history longer than this is not a long
 * history, it is a bad input — and because backfill writes straight into the
 * archive branch, an unbounded day loop turns one malformed timestamp into a
 * multi-million-row commit. Generous on purpose: it exists to catch nonsense,
 * not to express a policy about how much history is worth keeping.
 */
const MAX_RECONSTRUCTED_DAYS = 20_000;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Converts a `YYYY-MM-DD` date to the epoch milliseconds of its UTC midnight,
 * so the fill in `cumulativeByDay` can step a day at a time.
 *
 * Built from the matched components through `Date.UTC` rather than
 * `new Date(string)`, and then round-tripped back to a string, for the same
 * reasons `bundle.ts`'s `utcMonday` does it this way: a non-ISO spelling like
 * `2026-9-1` parses host-dependently, and an impossible date like `2026-02-30`
 * rolls silently over to 2 March, which would shift every row after it by two
 * days under a date that still looks perfectly ordinary. The round trip
 * catches both, along with the legacy two-digit-year mapping in `Date.UTC`
 * where year 50 means 1950.
 */
function utcDayStart(date: IsoDate): number {
  const match = ISO_DATE_RE.exec(date);
  if (match === null) {
    throw new Error(`backfill: expected a YYYY-MM-DD date, got ${JSON.stringify(date)}`);
  }
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) {
    throw new Error(`backfill: ${JSON.stringify(date)} is not a real calendar date`);
  }
  return time;
}

/**
 * Converts an ISO timestamp to its UTC calendar date. Mirrors `collect.ts`'s
 * `toDate` exactly: both modules read the same kind of GitHub timestamp
 * field and must fail the same way on the same malformed input, rather than
 * diverging into two silently-different notions of "the date" for what is
 * conceptually one archive. A timestamp that fails this check — including a
 * `starred_at` that is `undefined` because the stargazer request was made
 * without the `star+json` media type, so GitHub silently omitted the field —
 * throws immediately instead of being sliced into a garbage date that would
 * land silently in the archive.
 */
function toDate(timestamp: string): IsoDate {
  const date = timestamp.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Unparseable timestamp from the API: ${timestamp}`);
  }
  return date;
}

/**
 * Turns a list of already-validated event dates into a cumulative daily
 * running total.
 *
 * This is deliberately the same *quantity* the daily collector writes to
 * `stars.csv`/`forks.csv`: `collect.ts` reads the repo object's live
 * `stargazers_count`/`forks_count` — a running total as of the day it was
 * read, not a per-day delta — and appends one row carrying that total under
 * today's date. A per-day delta series and a running-total series are not
 * interchangeable: mixing them in one file would make consecutive rows mean
 * two different things depending on which process wrote them. Reconstructing
 * from `starred_at`/`created_at` timestamps means counting events per UTC
 * day and then running a cumulative sum forward through calendar order, so
 * a date with no events keeps the running total from the day before it
 * rather than resetting — matching what the live counter would have read
 * had it been sampled that day.
 *
 * That last clause is why this emits a row for EVERY calendar day in the
 * range rather than only for the days an event landed on. The dashboard draws
 * an absent date as a break in the line, and that convention is load-bearing
 * for traffic, where GitHub omits a day on which it measured nothing and a
 * break is the only honest rendering. A cumulative counter is the opposite
 * case: on a day nobody starred, the total is not unmeasured, it is known
 * exactly, and it equals the running total carried forward. Writing only the
 * days that moved publishes a hole in the record where there is no hole in
 * the knowledge, which understates the archive as badly as a fabricated zero
 * would overstate it.
 *
 * Every row is a reconstruction carrying one uniform caveat: `/stargazers`
 * lists only *current* stargazers, so a star since withdrawn is invisible and
 * these totals are a lower bound on what the live counter read. That caveat
 * is identical on an event day and on a quiet day — both are computed from
 * the same permanent timestamps — so there is no honesty distinction between
 * the two kinds of day for the fill to preserve. The merge stays if-absent,
 * so a real collector measurement always wins over any of them.
 *
 * The range runs from the first event to `through`, or to the last event when
 * that falls later.
 */
function cumulativeByDay(dates: readonly IsoDate[], through: IsoDate): CountPoint[] {
  const perDay = new Map<IsoDate, number>();
  for (const date of dates) {
    perDay.set(date, (perDay.get(date) ?? 0) + 1);
  }
  // Shares `series.ts`'s comparator rather than inlining a second copy: the
  // entire point of byte ordering here is that everything in the archive sorts
  // the same way, which two independent implementations cannot promise.
  const days = [...perDay.keys()].sort(compareStrings);
  const first = days[0];
  const last = days[days.length - 1];
  // No events means nothing to reconstruct — not an empty range to fill with
  // zeroes. A repository nobody has starred and a repository whose stargazer
  // list could not be read are different states, and the archive holding no
  // rows is the only thing that distinguishes them.
  if (first === undefined || last === undefined) return [];

  const startTime = utcDayStart(first);
  // `through` bounds the fill but never truncates evidence, so an event dated
  // after it still ends the range. Skew of that kind is ordinary: the job
  // reads its own date once at start-up and then pages a list that keeps
  // growing underneath it.
  const endTime = Math.max(utcDayStart(last), utcDayStart(through));

  // A span no real repository can have means an input is wrong — a corrupted
  // clock, or a garbage timestamp that still parsed as a date — and the cost
  // of proceeding is a multi-million-row CSV committed to the archive branch.
  // GitHub itself dates from 2008, so nothing longer than this describes a
  // real history.
  const spanDays = (endTime - startTime) / MS_PER_DAY + 1;
  if (spanDays > MAX_RECONSTRUCTED_DAYS) {
    const end = new Date(endTime).toISOString().slice(0, 10);
    throw new Error(
      `backfill: refusing to reconstruct ${spanDays} days (${first} to ${end}); ` +
        'an input date is implausible',
    );
  }

  const rows: CountPoint[] = [];
  let running = 0;
  for (let time = startTime; time <= endTime; time += MS_PER_DAY) {
    const date = new Date(time).toISOString().slice(0, 10);
    running += perDay.get(date) ?? 0;
    rows.push({ date, total: running });
  }
  return rows;
}

/**
 * Reconstructs the history GitHub's permanent per-item timestamps make
 * recoverable — stars (via `starred_at` on each stargazer), forks (via
 * `created_at` on each fork), and release dates (via `published_at` on each
 * release) — to seed the archive with the past before daily collection
 * began. Traffic (views/clones/referrers/paths) has no equivalent: GitHub
 * only ever exposes a trailing 14-day window for it, so nothing before this
 * package's own first run can ever be recovered, and this function does not
 * try.
 *
 * Every write goes through `upsertByDate(existing, incoming, 'if-absent')`,
 * never `'overwrite'`. That is the one property this function exists to
 * guarantee, and the reason is structural, not a style preference:
 * `/stargazers` lists only *current* stargazers, so a person who starred and
 * later unstarred is permanently invisible to it, while the daily
 * collector's `stars.csv` row for that same date came from the repo
 * object's live counter, which saw the unstar. The two series measure the
 * same date differently by construction, and the collector's value is the
 * one that was actually true on that date — a reconstruction can only ever
 * approximate it from below-or-equal, never correct it. So a date the
 * collector has already written must never be replaced by a reconstructed
 * guess; only a date neither process has ever recorded may be filled. The
 * same property makes repeated runs of this function idempotent for free: a
 * date it wrote itself on a previous run is "absent" to nothing on the next
 * one, so nothing changes.
 */
/**
 * The returned `written` lists the files backfill is PERMITTED to write —
 * `WRITABLE` verbatim — not the files that gained a row on this run. Because
 * every write is if-absent, a rerun legitimately writes nothing new while
 * still reporting the same list. This differs deliberately from
 * `CollectResult.written` in `collect.ts`, which lists only files that
 * actually received a write, so do not compare the two fields as if they
 * meant the same thing.
 */
export async function backfill(options: BackfillOptions): Promise<{ written: string[] }> {
  const { client, store, slug, today } = options;
  const repoPath = `/repos/${slug}`;

  // The stargazers list is the one genuinely long paginated call this
  // package makes. Reading `starred_at` at all requires this custom Accept
  // media type — without it GitHub's stargazers endpoint returns bare user
  // objects with no timestamp field whatsoever, and `toDate` below would
  // throw on every entry rather than silently reconstructing nothing.
  const stargazers = await client.paginate<StargazerResponse>(
    `${repoPath}/stargazers`,
    'application/vnd.github.star+json',
  );
  const forks = await client.paginate<ForkResponse>(`${repoPath}/forks?sort=oldest`);
  const releases = await client.paginate<ReleaseResponse>(`${repoPath}/releases`);

  /**
   * Reads `file`, merges `incoming` into it with `'if-absent'`, and writes
   * the result back. Generic over `T` — inferred from `incoming` at each
   * call site — so `existing`, cast once through `unknown` from the store's
   * untyped `Record<string, string>[]`, is unified with the SAME type
   * `incoming` carries rather than a narrower structural type that would
   * discard fields `upsertByDate` never touches (e.g. `total`, `tag`,
   * `name`) but `store.writeCsv` still needs to serialise. This mirrors
   * `collect.ts`'s `writeCsvSeries` exactly, down to the reason for the
   * cast: neither `CountPoint` nor `ReleaseRow` declares an index signature,
   * so TypeScript does not accept either as a `Record<string, string |
   * number>` structurally, even though every field on both is in fact a
   * `string | number`.
   */
  function mergeIfAbsent<T extends { date: IsoDate }>(
    file: string,
    header: readonly string[],
    incoming: readonly T[],
  ): void {
    const existing = store.readCsv(file) as unknown as T[];
    const merged = upsertByDate(existing, incoming, 'if-absent');
    store.writeCsv(file, header, merged as unknown as Array<Record<string, string | number>>);
  }

  mergeIfAbsent(
    'stars.csv',
    ['date', 'total'],
    cumulativeByDay(stargazers.map((item) => toDate(item.starred_at)), today),
  );
  mergeIfAbsent(
    'forks.csv',
    ['date', 'total'],
    cumulativeByDay(forks.map((item) => toDate(item.created_at)), today),
  );

  // A draft release carries `published_at: null` and is excluded: it has no
  // publish date to record, and being unpublished, it is not yet a public
  // fact this archive should be recording at all. The type guard (rather
  // than an `as string` cast after the filter) keeps the narrowing honest —
  // if this predicate is ever loosened, the compiler, not a runtime
  // `.slice()` on `null`, is what catches it.
  const releaseRows: ReleaseRow[] = releases
    .filter(
      (release): release is ReleaseResponse & { published_at: string } =>
        release.published_at !== null,
    )
    .map((release) => ({
      date: toDate(release.published_at),
      tag: release.tag_name,
      name: release.name ?? release.tag_name,
    }));

  // Not `mergeIfAbsent`: `releases.csv` is keyed on `tag`, not `date` — see
  // `upsertByKey` in series.ts for why a date-keyed merge silently collapses
  // two releases published on the same UTC day into one row. Still
  // if-absent, matching every other write in this function: a tag the
  // collector already recorded (with `collect.ts`'s own `upsertByKey`
  // 'overwrite' merge, which is authoritative because it comes from the
  // day's live fetch) must never be replaced by this reconstruction.
  const existingReleases = store.readCsv('releases.csv') as unknown as ReleaseRow[];
  const mergedReleases = upsertByKey(
    existingReleases,
    releaseRows,
    (row) => row.tag,
    'if-absent',
    compareReleaseRows,
  );
  store.writeCsv(
    'releases.csv',
    ['date', 'tag', 'name'],
    mergedReleases as unknown as Array<Record<string, string | number>>,
  );

  return { written: [...WRITABLE] };
}
