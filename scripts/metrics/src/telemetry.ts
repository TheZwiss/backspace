import type { DimensionRow, IsoDate, NetworkPoint } from './types.ts';
import { MS_PER_DAY, utcDayStart } from './series.ts';

/**
 * One ping body as the receiver stored it.
 *
 * Every field is optional and every group is an open record of `unknown`.
 * The rows come from instances the collector does not control: an older
 * schema, a modified build, or a field this collector has never heard of are
 * all normal, and none of them may throw. Values are read through `num` and
 * `bool` below, which turn anything unexpected into `0` or `false`.
 */
export interface PingBody {
  build?: { version?: unknown };
  users?: Record<string, unknown>;
  clients?: Record<string, unknown>;
  content?: Record<string, unknown>;
  features?: Record<string, unknown>;
}

/** One export row: the envelope the receiver adds around a ping body. */
export interface PingRow {
  instance: string;
  day: IsoDate;
  country: string;
  schema: number;
  body: PingBody;
}

/** Everything one collected day writes: one network row and three dimensions. */
export interface TelemetryAggregate {
  network: NetworkPoint;
  versions: DimensionRow[];
  countries: DimensionRow[];
  clients: DimensionRow[];
}

/** Pulls the export rows for the inclusive day range `[from, to]`. */
export type TelemetryFetcher = (from: IsoDate, to: IsoDate) => Promise<PingRow[]>;

/**
 * A dimension value held by fewer than this many instances on a day folds
 * into `other` before anything is written. Nothing in the public archive may
 * name a version, country or client kind that one or two instances carry,
 * because with a small fleet that value is close to naming the instance.
 */
export const MIN_INSTANCES_PER_DIMENSION = 3;

/** The dimension every folded and every unrecognised value is counted under. */
const OTHER = 'other';

/**
 * Per-row ceiling applied to every count before it is summed.
 *
 * The instances report their own numbers, so a single modified or broken
 * build could otherwise push a whole series off the chart for good. A billion
 * is far above anything a real self-hosted instance reports and far below the
 * point where the sums lose integer precision.
 */
export const MAX_ROW_VALUE = 1_000_000_000;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What a Backspace release version looks like: `1.1.2`, optionally with a
 * pre-release suffix such as `1.2.0-rc.1`.
 */
const RELEASE_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]{1,16})?$/;

/**
 * The dimension a row's reported version is tallied under.
 *
 * `build.version` is text an instance chose, and once three instances report
 * the same value it clears the fold threshold and is written to the public
 * metrics branch under its own name. The receiver bounds the field on arrival,
 * but rows stored before that bound existed, or an export replayed from an
 * older archive, can still carry anything at all. Anything that is not shaped
 * like a release, a missing version included, is counted as `other`, so the
 * only version strings the archive ever names are ones this collector
 * recognises.
 */
function releaseVersion(value: unknown): string {
  return typeof value === 'string' && RELEASE_VERSION.test(value) ? value : OTHER;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses the receiver's NDJSON export, one row per line.
 *
 * `body` arrives as a JSON string inside the envelope, so it is parsed a
 * second time here. A line that is not JSON, that is missing an envelope
 * field, or whose body is not an object is counted in `skipped` rather than
 * thrown: one damaged row must not cost the collector the whole day. Blank
 * lines are neither parsed nor counted, so a trailing newline is free.
 */
export function parseExportNdjson(text: string): { rows: PingRow[]; skipped: number } {
  const rows: PingRow[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const raw: unknown = JSON.parse(line);
      if (
        !isRecord(raw)
        || typeof raw['instance'] !== 'string'
        || typeof raw['day'] !== 'string'
        || !ISO_DAY.test(raw['day'])
        || typeof raw['country'] !== 'string'
        || typeof raw['schema'] !== 'number'
        || typeof raw['body'] !== 'string'
      ) {
        skipped += 1;
        continue;
      }
      const body: unknown = JSON.parse(raw['body']);
      if (!isRecord(body)) {
        skipped += 1;
        continue;
      }
      rows.push({
        instance: raw['instance'],
        day: raw['day'],
        country: raw['country'],
        schema: raw['schema'],
        body: body as PingBody,
      });
    } catch {
      skipped += 1;
    }
  }
  return { rows, skipped };
}

/**
 * Steps a `YYYY-MM-DD` day by whole days through UTC midnight.
 *
 * Goes through `utcDayStart`, which validates the input by round-tripping it,
 * so a malformed or impossible date throws here rather than silently shifting
 * a window by a couple of days.
 */
function addDays(day: IsoDate, delta: number): IsoDate {
  return new Date(utcDayStart(day) + delta * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Reads one reported count, clamped into `[0, MAX_ROW_VALUE]`.
 *
 * A missing group, a missing field, a string, `NaN`, `Infinity` and a negative
 * number all read as `0`: the collector treats a nonsense value as no value,
 * never as a reason to fail the run.
 */
function num(group: Record<string, unknown> | undefined, field: string): number {
  const value = group?.[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), MAX_ROW_VALUE);
}

/** Reads one reported flag. Only a real `true` counts as enabled. */
function bool(group: Record<string, unknown> | undefined, field: string): boolean {
  return group?.[field] === true;
}

/** Latest row per instance with `day` in the inclusive range `[from, to]`. */
function latestPerInstance(rows: readonly PingRow[], from: IsoDate, to: IsoDate): Map<string, PingRow> {
  const latest = new Map<string, PingRow>();
  for (const row of rows) {
    if (row.day < from || row.day > to) continue;
    const current = latest.get(row.instance);
    if (!current || row.day > current.day) latest.set(row.instance, row);
  }
  return latest;
}

/**
 * Turns a dimension tally into archive rows, folding the small values.
 *
 * Ordered by count descending and then by value, so the written file has a
 * stable order that does not depend on the order the rows arrived in. `other`
 * always sits last, and is omitted entirely when nothing folded into it.
 */
function foldSmall(counts: Map<string, number>, date: IsoDate): DimensionRow[] {
  let other = 0;
  const kept: DimensionRow[] = [];
  for (const [dimension, count] of counts) {
    // A tally can already hold the `other` key before anything folds, because
    // `releaseVersion` maps an unrecognised version there. It goes through the
    // same bucket whatever its count, so the file carries one `other` row
    // rather than two rows that would collide on the dimensional upsert.
    if (dimension === OTHER || count < MIN_INSTANCES_PER_DIMENSION) other += count;
    else kept.push({ snapshot_date: date, dimension, title: '', count, uniques: count });
  }
  kept.sort((a, b) => b.count - a.count || (a.dimension < b.dimension ? -1 : 1));
  if (other > 0) kept.push({ snapshot_date: date, dimension: OTHER, title: '', count: other, uniques: other });
  return kept;
}

/**
 * The network snapshot for `date`: the latest row per instance in the seven
 * days ending on `date`, restricted to instances that reported on at least two
 * distinct days in the trailing thirty. `users_active1d` comes only from rows
 * dated `date` itself; every other sum uses the snapshot. Dimension values
 * held by fewer than three instances fold into `other`. See spec section 8.
 *
 * The seven-day window is what keeps the series readable: an instance that
 * misses a day, or whose ping fails, keeps its last values rather than
 * dropping the fleet total by its size for a day. The two-days-in-thirty rule
 * is what keeps it honest: a one-off ping, from a test box or from someone
 * curious about the endpoint, never enters a total.
 */
export function aggregateTelemetry(rows: readonly PingRow[], date: IsoDate): TelemetryAggregate {
  const from30 = addDays(date, -29);
  const from7 = addDays(date, -6);

  const daysByInstance = new Map<string, Set<IsoDate>>();
  for (const row of rows) {
    if (row.day < from30 || row.day > date) continue;
    let days = daysByInstance.get(row.instance);
    if (!days) {
      days = new Set();
      daysByInstance.set(row.instance, days);
    }
    days.add(row.day);
  }
  const eligible = new Set([...daysByInstance].filter(([, days]) => days.size >= 2).map(([id]) => id));
  const eligibleRows = rows.filter((row) => eligible.has(row.instance));

  const snapshot = [...latestPerInstance(eligibleRows, from7, date).values()];
  const onDay = snapshot.filter((row) => row.day === date);
  const within30 = latestPerInstance(eligibleRows, from30, date);

  const sum = (pick: (row: PingRow) => number, over: readonly PingRow[] = snapshot): number =>
    over.reduce((acc, row) => acc + pick(row), 0);

  const network: NetworkPoint = {
    date,
    instances_1d: onDay.length,
    instances_7d: snapshot.length,
    instances_30d: within30.size,
    users_registered: sum((r) => num(r.body.users, 'registered')),
    users_active1d: sum((r) => num(r.body.users, 'active1d'), onDay),
    users_active7d: sum((r) => num(r.body.users, 'active7d')),
    users_active30d: sum((r) => num(r.body.users, 'active30d')),
    messages7d: sum((r) => num(r.body.content, 'messages7d')),
    storage_mib: sum((r) => num(r.body.content, 'storageMiB')),
    voice_instances: snapshot.filter((r) => bool(r.body.features, 'voice')).length,
    federation_instances: snapshot.filter((r) => bool(r.body.features, 'federation')).length,
  };

  const versionCounts = new Map<string, number>();
  const countryCounts = new Map<string, number>();
  const clientInstances = new Map<string, number>();
  const clientUsers = new Map<string, number>();
  for (const row of snapshot) {
    const version = releaseVersion(row.body.build?.version);
    versionCounts.set(version, (versionCounts.get(version) ?? 0) + 1);
    countryCounts.set(row.country, (countryCounts.get(row.country) ?? 0) + 1);
    for (const kind of ['web', 'desktop', 'mobile'] as const) {
      const users = num(row.body.clients, kind);
      if (users === 0) continue;
      clientInstances.set(kind, (clientInstances.get(kind) ?? 0) + 1);
      clientUsers.set(kind, (clientUsers.get(kind) ?? 0) + users);
    }
  }

  // Client kinds fold by how many instances carry them, but report user sums:
  // the threshold protects the instance, so it has to count instances, while
  // the figure worth charting is how many people use each client.
  const clients: DimensionRow[] = [];
  let otherUsers = 0;
  for (const [kind, instances] of clientInstances) {
    const users = clientUsers.get(kind) ?? 0;
    if (instances < MIN_INSTANCES_PER_DIMENSION) otherUsers += users;
    else clients.push({ snapshot_date: date, dimension: kind, title: '', count: users, uniques: users });
  }
  clients.sort((a, b) => b.count - a.count);
  if (otherUsers > 0) clients.push({ snapshot_date: date, dimension: OTHER, title: '', count: otherUsers, uniques: otherUsers });

  return { network, versions: foldSmall(versionCounts, date), countries: foldSmall(countryCounts, date), clients };
}

/**
 * Which of `candidates` may have a telemetry aggregate published for them,
 * given the raw pings a fetch actually returned.
 *
 * `aggregateTelemetry` only counts an instance once it has reported on two
 * distinct days inside the trailing thirty. On the oldest day any ping in
 * `pings` carries, and on every day before it, no instance can possibly have
 * a second reporting day behind it yet, so the aggregate for that day is all
 * zeros by construction: the structural absence of evidence, not a
 * measurement of an empty fleet. Publishing it would chart a measured empty
 * fleet on a day nothing was measured (docs/systems/metrics.md section 4.3).
 * `pings` empty, a fetch that reached the receiver and got nothing back,
 * excludes every candidate for the identical reason: there is no oldest ping
 * to be strictly after.
 *
 * Both the daily collector and the one-shot backfill reconstruction call
 * `aggregateTelemetry` over rows pulled from the same receiver and are bound
 * by the same eligibility rule, so this is the one place that states it;
 * neither caller should restate the reasoning inline.
 */
export function publishableTelemetryDays(
  pings: readonly PingRow[],
  candidates: readonly IsoDate[],
): IsoDate[] {
  const oldestPing = pings.reduce<IsoDate | null>(
    (oldest, ping) => (oldest === null || ping.day < oldest ? ping.day : oldest),
    null,
  );
  if (oldestPing === null) return [];
  return candidates.filter((day) => day > oldestPing);
}

/**
 * Binds a fetch implementation, the receiver endpoint and the export token
 * into a fetcher for the collector to call.
 *
 * `fetchFn` is a parameter rather than the global so the caller can pass a
 * stub in a test, matching how `github.ts` takes its fetch. Anything but a
 * 200 throws, including a 401 for a stale token: the collector must fail the
 * telemetry step loudly rather than write a day of empty rows over real ones.
 *
 * An answer that parsed to nothing at all throws for the same reason. A 200
 * whose every line was rejected is a broken parser, not a quiet day: rename a
 * field in the receiver's envelope, or stop sending `body` as a JSON string,
 * and this would otherwise hand the collector a well-formed all-zero snapshot
 * to upsert over the real row, every day, until somebody read a CI log. A
 * genuinely empty export has no lines to reject and still resolves to no rows,
 * which is what a day before the first instance opted in looks like.
 *
 * A truncated export throws as well, and it is the one failure here that the
 * body cannot reveal. The receiver caps an answer at 10,000 rows and 8 MiB and
 * announces the cut with `x-export-truncated` (see docs/systems/telemetry.md).
 * The NDJSON keeps its exact shape either way, so every line parses, every row
 * is well formed, and the only thing separating a short window from a small
 * fleet is that header. Aggregating what arrived would publish an instance
 * count, a user count and a version split for whichever instances fit inside
 * the cap, indistinguishable from a real measurement and wrong in the one
 * direction the archive cannot afford, since these are the numbers the whole
 * feature exists to publish.
 */
export function createTelemetryFetcher(fetchFn: typeof fetch, endpoint: string, token: string): TelemetryFetcher {
  return async (from, to) => {
    const url = `${endpoint.replace(/\/$/, '')}/v1/export?from=${from}&to=${to}`;
    const response = await fetchFn(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/x-ndjson' },
    });
    if (response.status !== 200) throw new Error(`telemetry export answered ${response.status}`);
    // Checked on the header's presence rather than on the exact value `1`, and
    // checked before the body is read at all. Fail closed: a receiver that
    // one day announced the cut with a row count instead would otherwise read
    // as a clean answer, and the failure that mistake causes is a published
    // number that is quietly too small.
    if (response.headers.get('x-export-truncated') !== null) {
      throw new Error(
        `telemetry export was truncated by the receiver (x-export-truncated) for ${from}..${to}, `
        + 'so the window is incomplete and was not aggregated. Request a narrower range, or raise '
        + 'the receiver\'s MAX_EXPORT_ROWS/MAX_EXPORT_BYTES if the fleet has outgrown them.',
      );
    }
    const { rows, skipped } = parseExportNdjson(await response.text());
    if (rows.length === 0 && skipped > 0) {
      throw new Error(`telemetry export: ${skipped} malformed row(s) and nothing parsed, the export format may have changed`);
    }
    if (skipped > 0) console.warn(`telemetry export: skipped ${skipped} malformed row(s)`);
    return rows;
  };
}
