import {
  upsertByDate,
  upsertByKey,
  upsertDimensional,
  compareReleaseRows,
  compareStrings,
  countByDay,
  utcDayStart,
  MS_PER_DAY,
} from './series.ts';
import { NETWORK_HEADER } from './collect.ts';
import { aggregateTelemetry, publishableTelemetryDays, type PingRow, type TelemetryFetcher } from './telemetry.ts';
import type { GitHubClient } from './github.ts';
import type { Store } from './store.ts';
import type { CountPoint, DimensionRow, IsoDate, NetworkPoint, ReleaseRow } from './types.ts';

interface StargazerResponse {
  starred_at: string;
}
interface ForkResponse {
  created_at: string;
}
interface WorkflowRunResponse {
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
  /**
   * Fetches raw telemetry rows for a day range from the receiver. Optional,
   * exactly as in `CollectOptions`: absent when TELEMETRY_EXPORT_TOKEN is
   * unset, in which case nothing under `telemetry/` is touched.
   *
   * Unlike the collector, a failure here is not caught. This job is dispatched
   * by hand and watched, it has no `skipped` channel to report a degraded run
   * through, and every write happens after every fetch, so a rejection leaves
   * the archive untouched rather than half-reconstructed.
   */
  telemetry?: TelemetryFetcher;
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
 *
 * The four `telemetry/` files are included because the receiver keeps raw
 * pings for 90 days, so a stretch the collector missed genuinely is
 * reconstructable from them. They are listed here whether or not this run had
 * a fetcher to reach the receiver with, matching what this constant means:
 * the files backfill may touch, not the files it touched.
 */
const WRITABLE = [
  'stars.csv',
  'forks.csv',
  'releases.csv',
  'telemetry/network.csv',
  'telemetry/versions.ndjson',
  'telemetry/countries.ndjson',
  'telemetry/clients.ndjson',
] as const;

/**
 * How far back a telemetry reconstruction can reach: the receiver's retention.
 *
 * Nothing older exists to fetch, so this is a hard ceiling rather than a
 * policy. A dispatch made today can recover days a dispatch made next month
 * never will, the same asymmetry `workflows.csv` has against the Actions
 * retention horizon.
 */
const TELEMETRY_RETENTION_DAYS = 90;

/**
 * How many days each export request covers.
 *
 * The whole window in one request would be a single large response held
 * entirely in memory on both ends; splitting it keeps each request the same
 * size as the one the daily collector already makes, which is the shape the
 * receiver is sized for.
 */
const TELEMETRY_CHUNK_DAYS = 31;

/** The UTC date `days` days before `date`. Mirrors `collect.ts`'s helper. */
function daysBefore(date: IsoDate, days: number): IsoDate {
  return new Date(utcDayStart(date) - days * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Upper bound on the number of days one reconstruction may write. GitHub
 * launched in 2008, so a repository history longer than this is not a long
 * history, it is a bad input — and because backfill writes straight into the
 * archive branch, an unbounded day loop turns one malformed timestamp into a
 * multi-million-row commit. Generous on purpose: it exists to catch nonsense,
 * not to express a policy about how much history is worth keeping.
 */
const MAX_RECONSTRUCTED_DAYS = 20_000;


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
 * The telemetry series are the one thing here that is not reconstructed from
 * GitHub at all: they come from the receiver's export, which keeps 90 days of
 * raw pings, so a stretch of failed collections inside that window really is
 * recoverable. See the write at the end of this function for what it can and
 * cannot reach.
 *
 * Every dated write goes through `upsertByDate(existing, incoming,
 * 'if-absent')`, never `'overwrite'`. That is the one property this function
 * exists to guarantee, and the reason is structural, not a style preference:
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
 *
 * The three telemetry NDJSON files hold to the same rule at a coarser grain:
 * `upsertDimensional` has no if-absent mode, so `mergeDimensional` applies one
 * itself and skips every day the file already carries a row for. A day is
 * filled whole or left alone; see that function for why a row-keyed if-absent
 * would double-count instead.
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
  const workflowRuns = await client.paginateEnvelope<WorkflowRunResponse>(
    `${repoPath}/actions/runs`,
    'workflow_runs',
  );

  // The export is pulled in chunks the size of one daily collection rather
  // than as one 90-day response, and sequentially rather than in parallel:
  // this job is dispatched by hand with no deadline, and the receiver is a
  // single worker that the daily collector otherwise only ever asks for 31
  // days at a time.
  //
  // `daysBefore(today, TELEMETRY_RETENTION_DAYS - 1)` is the oldest `from`
  // this loop ever sends, and nothing here re-checks that the rows a chunk
  // answers with actually stay inside `[from, to]`. That is deliberate, not
  // an oversight: the receiver's `exportRange` (scripts/telemetry-receiver/
  // src/store.ts) reads `WHERE day >= ?1 AND day <= ?2` straight from these
  // same two parameters, so a row outside the requested range is a receiver
  // defect, not something a second local clamp here could catch any more
  // reliably. `pings` is trusted as exactly what was asked for.
  const fetchTelemetry = options.telemetry;
  const pings: PingRow[] = [];
  if (fetchTelemetry !== undefined) {
    for (let start = TELEMETRY_RETENTION_DAYS - 1; start >= 1; start -= TELEMETRY_CHUNK_DAYS) {
      const end = Math.max(start - TELEMETRY_CHUNK_DAYS + 1, 1);
      pings.push(...(await fetchTelemetry(daysBefore(today, start), daysBefore(today, end))));
    }
  }

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

  /**
   * Reads `file`, adds only the rows for days the file does not already carry,
   * and writes the result back.
   *
   * If-absent by DAY, not by `(snapshot_date, dimension)`, which is the key
   * `upsertDimensional` merges on. Both halves of that are load-bearing.
   *
   * If-absent at all, because the two writers do not agree. They call the same
   * `aggregateTelemetry`, but not over the same rows: for a day near the start
   * of the reconstructed range the fetched export cannot reach back the full
   * thirty days the eligibility rule looks over, so instances lose their second
   * reporting day, drop out of the eligible set, and their dimension values
   * fall under the folding threshold. The reconstruction is a lower bound there
   * in exactly the way a rebuilt star count is, and section 4.2's rule applies
   * unchanged: a day the collector measured with full history is never replaced.
   *
   * By day rather than by row, because `dimension` is part of the merge key. A
   * version that folds into `other` on a truncated lookback does not collide
   * with the collector's row naming it, so a row-keyed merge would leave
   * `{D, "1.1.2", 5}` in place and add `{D, "other", 3}` beside it, and the day
   * would count eight instances where five reported. A day is one indivisible
   * measurement here; it is filled whole or left alone.
   */
  function mergeDimensional(file: string, incoming: readonly DimensionRow[]): void {
    const existing = store.readNdjson(file);
    const measured = new Set(existing.map((row) => row.snapshot_date));
    store.writeNdjson(
      file,
      upsertDimensional(
        existing,
        incoming.filter((row) => !measured.has(row.snapshot_date)),
      ),
    );
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

  // Reconstructed only across the span where a run actually survives, which is
  // NOT the same as "every day up to today".
  //
  // GitHub deletes workflow runs once they pass the repository's retention
  // period (90 days by default). Counting a day older than the oldest
  // surviving run would therefore reconstruct a confident `0` for a day that
  // may have been the busiest in the archive — a fabricated zero, which is the
  // single thing §4.3 forbids outright, and one that would be indistinguishable
  // from a real quiet day forever after.
  //
  // Inside the surviving span the zeros ARE honest, and the reason is worth
  // stating because it is what makes the bound sound: retention deletes by age,
  // uniformly, so if a run from the oldest surviving date is still here, no run
  // from any LATER date has been deleted. Every zero at or after that date is a
  // day GitHub still remembers and reports nothing for.
  //
  // Below that date this writes nothing at all, leaving a gap — "not measured"
  // — which is the truthful encoding of a period whose evidence GitHub has
  // already destroyed.
  const runDates = workflowRuns.map((run) => run.created_at.slice(0, 10)).sort(compareStrings);
  const oldestRun = runDates[0];
  const newestRun = runDates[runDates.length - 1];
  if (oldestRun !== undefined && newestRun !== undefined) {
    // `today` bounds the fill forward but must never truncate evidence, the
    // same rule `cumulativeByDay` follows: a run that lands while this job is
    // paging through the list is dated after `today` and still gets its row.
    const through = compareStrings(newestRun, today) > 0 ? newestRun : today;
    mergeIfAbsent(
      'workflows.csv',
      ['date', 'runs'],
      countByDay(runDates, oldestRun, through).map((day) => ({ date: day.date, runs: day.count })),
    );
  }

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

  // The reconstructed range is bounded below by the oldest day the export
  // actually carries, not by the retention horizon, for the same reason the
  // workflow fill starts at the oldest surviving run: below that day there is no
  // evidence either way. The receiver keeps 90 days, but it has not existed
  // for 90 days on every dispatch, and an aggregate over a day it holds no
  // row for is an all-zero snapshot that reads on the chart as a measured
  // empty fleet. Section 4.3 forbids exactly that. An empty export therefore
  // writes nothing at all rather than 89 zero rows.
  //
  // Inside the range the earliest days are still computed over a short
  // history: the snapshot rule looks back thirty days to decide which
  // instances count, and a day near the start of the export has fewer than
  // thirty behind it, so its instance counts are a lower bound. That is
  // inherent to a 90-day retention and cannot be fetched around; the merge is
  // if-absent, so any day the collector measured keeps its own row.
  //
  // Where exactly that lower bound falls, and why an empty export excludes
  // every candidate the same way, is `publishableTelemetryDays`'s reasoning
  // (telemetry.ts) — the daily collector is bound by the identical
  // eligibility rule, so it lives there once rather than twice.
  const candidates: IsoDate[] = [];
  for (let offset = TELEMETRY_RETENTION_DAYS - 1; offset >= 1; offset -= 1) {
    candidates.push(daysBefore(today, offset));
  }
  const publishableDays = publishableTelemetryDays(pings, candidates);
  if (publishableDays.length > 0) {
    const network: NetworkPoint[] = [];
    const versions: DimensionRow[] = [];
    const countries: DimensionRow[] = [];
    const clients: DimensionRow[] = [];
    for (const day of publishableDays) {
      const aggregate = aggregateTelemetry(pings, day);
      network.push(aggregate.network);
      versions.push(...aggregate.versions);
      countries.push(...aggregate.countries);
      clients.push(...aggregate.clients);
    }
    mergeIfAbsent('telemetry/network.csv', NETWORK_HEADER, network);
    mergeDimensional('telemetry/versions.ndjson', versions);
    mergeDimensional('telemetry/countries.ndjson', countries);
    mergeDimensional('telemetry/clients.ndjson', clients);
  }

  return { written: [...WRITABLE] };
}
