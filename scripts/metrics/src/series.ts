import type { DimensionRow, IsoDate, ReleaseRow } from './types.ts';

/**
 * Plain UTF-16 code-unit comparison, deliberately NOT `String.prototype
 * .localeCompare`. `localeCompare`'s collation is ICU-version dependent —
 * the exact ordering it produces for a given pair of strings can change
 * across Node versions with no code change on this side at all, which would
 * silently reorder an entire committed file on the next run after a Node
 * upgrade. That would destroy the one-line-per-day diff property the plain
 * text format was chosen for in the first place. Every value ordered by
 * this comparator in the codebase is an ISO date or similarly plain ASCII
 * identifier, so byte ordering and locale ordering coincide today — the
 * point of this function is that byte ordering also stays put tomorrow.
 */
export function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Quotes a CSV field only when it contains a comma, quote, or newline. */
function quote(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Splits CSV text into rows of fields in a single pass, tracking quote state
 * across newlines so that a row boundary (`\n` or `\r\n`) is only recognised
 * when no quote is open. A `\n`, `\r\n`, or `,` inside quotes is literal field
 * data. A doubled `""` inside quotes is one literal `"`. A trailing newline at
 * end of input produces no phantom empty row, and a blank line outside quotes
 * is skipped rather than parsed as an all-empty row.
 */
function splitRows(text: string): string[][] {
  const rows: string[][] = [];
  let fields: string[] = [];
  let current = '';
  let inQuotes = false;
  let rowHasContent = false;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          current += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        current += char ?? '';
        i++;
      }
    } else if (char === '"') {
      inQuotes = true;
      rowHasContent = true;
      i++;
    } else if (char === ',') {
      fields.push(current);
      current = '';
      rowHasContent = true;
      i++;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      i++;
      if (rowHasContent) {
        fields.push(current);
        rows.push(fields);
      }
      fields = [];
      current = '';
      rowHasContent = false;
    } else {
      current += char ?? '';
      rowHasContent = true;
      i++;
    }
  }
  if (inQuotes) {
    throw new Error(
      'parseCsv: unterminated quoted field — the input ends while a quote is still open, ' +
        'so the file is truncated or corrupt',
    );
  }
  if (rowHasContent) {
    fields.push(current);
    rows.push(fields);
  }
  return rows;
}

/** Milliseconds in a UTC day. Every dated series steps by this. */
export const MS_PER_DAY = 86_400_000;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Converts a `YYYY-MM-DD` date to the epoch milliseconds of its UTC midnight,
 * so a dense day-by-day fill can step a day at a time.
 *
 * Built from the matched components through `Date.UTC` rather than
 * `new Date(string)`, and then round-tripped back to a string, for the same
 * reasons `bundle.ts`'s `utcMonday` does it this way: a non-ISO spelling like
 * `2026-9-1` parses host-dependently, and an impossible date like `2026-02-30`
 * rolls silently over to 2 March, which would shift every row after it by two
 * days under a date that still looks perfectly ordinary. The round trip
 * catches both, along with the legacy two-digit-year mapping in `Date.UTC`
 * where year 50 means 1950.
 *
 * Lives here rather than in `backfill.ts` because both the reconstruction and
 * the daily collector now fill dense day ranges, and two copies of this
 * validation would be two places for the round-trip check to be dropped.
 */
export function utcDayStart(date: IsoDate): number {
  const match = ISO_DATE_RE.exec(date);
  if (match === null) {
    throw new Error(`expected a YYYY-MM-DD date, got ${JSON.stringify(date)}`);
  }
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) {
    throw new Error(`${JSON.stringify(date)} is not a real calendar date`);
  }
  return time;
}

/**
 * Counts dated events per UTC day across the whole range `[from, through]`,
 * emitting a row for every day in it — including days with no events.
 *
 * The dense fill is the point. This backs `workflows.csv`, where a day with no
 * workflow runs is a MEASURED ZERO rather than an absence: the Actions API is
 * asked for a date range and answers it completely, unlike the traffic
 * endpoints, which omit a day they recorded nothing for. §4.3 forbids
 * inventing a zero for an unmeasured day; it equally forbids hiding a measured
 * one behind a gap, which would read on the chart as collector downtime.
 *
 * Callers own the range, and with it the claim that the range was fully
 * observed. An event outside `[from, through]` is dropped rather than
 * recorded, so a page that straddles the boundary cannot contribute a partial
 * count for a day this call did not cover completely.
 */
export function countByDay(dates: readonly IsoDate[], from: IsoDate, through: IsoDate): CountedDay[] {
  const perDay = new Map<IsoDate, number>();
  for (const date of dates) {
    if (compareStrings(date, from) < 0 || compareStrings(date, through) > 0) continue;
    perDay.set(date, (perDay.get(date) ?? 0) + 1);
  }
  const rows: CountedDay[] = [];
  const end = utcDayStart(through);
  for (let time = utcDayStart(from); time <= end; time += MS_PER_DAY) {
    const date = new Date(time).toISOString().slice(0, 10);
    rows.push({ date, count: perDay.get(date) ?? 0 });
  }
  return rows;
}

/** One day and how many events landed on it. */
export interface CountedDay {
  date: IsoDate;
  count: number;
}

export function parseCsv(text: string): Record<string, string>[] {
  const rows = splitRows(text);
  const header = rows.shift();
  if (header === undefined) return [];
  return rows.map((fields, index) => {
    // A row with a DIFFERENT field count than the header — too many OR too
    // few — can only mean truncation or corruption: the header was derived
    // from this same file, so a short row relative to its own header is not
    // "a column was added later" (that case is handled entirely by
    // `formatCsv`'s `row[key] ?? ''` and never reaches this parser at all).
    // Padding a short row with `''` would silently convert a measured value
    // into "not measured," permanently, with nothing in the log — the exact
    // failure this archive exists to avoid. A row with the CORRECT field
    // count and an empty value (e.g. a blank `downloads_total`) is a
    // different shape entirely and is unaffected by this check: it has one
    // fewer comma than a short row, not one fewer field.
    if (fields.length !== header.length) {
      throw new Error(
        `parseCsv: row ${index + 1} has ${fields.length} fields but the header has ${header.length}`,
      );
    }
    const row: Record<string, string> = {};
    header.forEach((key, fieldIndex) => {
      row[key] = fields[fieldIndex] ?? '';
    });
    return row;
  });
}

export function formatCsv(
  header: readonly string[],
  rows: ReadonlyArray<Record<string, string | number>>,
): string {
  const sortKey = header[0];
  if (sortKey === undefined) throw new Error('formatCsv requires at least one header column');
  const sorted = [...rows].sort((a, b) =>
    compareStrings(String(a[sortKey] ?? ''), String(b[sortKey] ?? '')),
  );
  const body = sorted.map((row) => header.map((key) => quote(String(row[key] ?? ''))).join(','));
  return [header.join(','), ...body].join('\n') + '\n';
}

/**
 * Merges `incoming` into `existing`, keyed by `date`, returning a
 * date-ascending array.
 *
 * `overwrite` — the fetched value wins. Used by the daily collector, where the
 * API is authoritative and re-fetching a 14-day window must be idempotent.
 *
 * `if-absent` — an existing row is never replaced. Used by backfill, which
 * reconstructs history from `starred_at` and therefore cannot see stars that
 * were later removed. Overwriting a measured value with a reconstructed one
 * would silently corrupt the series.
 */
export function upsertByDate<T extends { date: IsoDate }>(
  existing: readonly T[],
  incoming: readonly T[],
  mode: 'overwrite' | 'if-absent',
): T[] {
  const byDate = new Map<IsoDate, T>();
  for (const row of existing) byDate.set(row.date, row);
  for (const row of incoming) {
    if (mode === 'if-absent' && byDate.has(row.date)) continue;
    byDate.set(row.date, row);
  }
  return [...byDate.values()].sort((a, b) => compareStrings(a.date, b.date));
}

/**
 * Merges `incoming` into `existing` keyed by an explicit `key` selector
 * rather than `date`, with the same `'overwrite' | 'if-absent'` modes as
 * `upsertByDate` and the same meaning for each.
 *
 * Exists because not every series is a daily series: `releases.csv` can
 * legitimately hold more than one row for the same UTC date (two releases
 * published the same day), so keying its merge on `date` — as
 * `upsertByDate` does — silently collapses them into one row and drops the
 * other. A release's true row identity is its tag, which `upsertByDate` has
 * no way to express. `upsertByDate` itself is left untouched for the
 * genuinely daily series (`stars.csv`, `forks.csv`, `repo.csv`, traffic):
 * this is a new function, not a generalisation that reshapes the old one's
 * behaviour underneath its existing callers.
 *
 * `compare` orders the merged result explicitly, rather than deriving an
 * order from `key` (which would sort releases by tag, not by date) or from
 * Map iteration order (which is insertion order, and therefore differs
 * between `collect.ts` and `backfill.ts` depending on which one merged the
 * row first) — either alternative would make the final row order,
 * regardless of source, an implementation detail rather than a fixed
 * contract, and an unstable order rewrites the whole file on every commit.
 */
export function upsertByKey<T>(
  existing: readonly T[],
  incoming: readonly T[],
  key: (row: T) => string,
  mode: 'overwrite' | 'if-absent',
  compare: (a: T, b: T) => number,
): T[] {
  const byKey = new Map<string, T>();
  for (const row of existing) byKey.set(key(row), row);
  for (const row of incoming) {
    const rowKey = key(row);
    if (mode === 'if-absent' && byKey.has(rowKey)) continue;
    byKey.set(rowKey, row);
  }
  return [...byKey.values()].sort(compare);
}

/**
 * Total order for release rows: `date` ascending, then `tag` ascending as
 * the tie-break. `releases.csv` is keyed on `tag` (see `upsertByKey` above),
 * not `date`, specifically so two releases published on the same UTC day
 * both survive as distinct rows — which means their relative order can no
 * longer fall out of a date-keyed `Map`'s iteration order the way every
 * other series' does. Both `collect.ts` and `backfill.ts` pass this exact
 * comparator to `upsertByKey` rather than each deriving their own, so the
 * two writers of `releases.csv` can never disagree on ordering the way they
 * previously disagreed on which same-day release survived at all.
 */
export function compareReleaseRows(a: ReleaseRow, b: ReleaseRow): number {
  if (a.date !== b.date) return compareStrings(a.date, b.date);
  return compareStrings(a.tag, b.tag);
}

/**
 * Validates that a decoded JSON value is a well-formed `DimensionRow` and
 * narrows it to that type.
 *
 * Unlike a CSV row, a JSON object's fields are named rather than positional,
 * so an unrecognised extra key cannot desynchronise the fields that follow
 * it the way an extra CSV column can — there is nothing for it to corrupt.
 * An extra key is therefore accepted rather than rejected, but it is not
 * preserved: this function returns a fixed 5-field object literal, so any
 * unrecognised key is unconditionally dropped from the result. It is not a
 * landing spot for a future field — adding a field means updating this
 * validator, not relying on a key silently passing through. A *missing* or
 * *wrong-typed* known field is a different story: this snapshot is the only
 * surviving copy of data GitHub deletes
 * after 14 days, so a row that doesn't match the schema is corruption, not
 * schema evolution, and must fail loudly rather than be coerced (e.g. a
 * stringified count silently `Number()`-ed) into something plausible.
 */
function parseDimensionRow(value: unknown, lineNumber: number): DimensionRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`parseNdjson: line ${lineNumber} is not a JSON object`);
  }
  const { snapshot_date, dimension, title, count, uniques } = value as Record<string, unknown>;
  if (typeof snapshot_date !== 'string') {
    throw new Error(`parseNdjson: line ${lineNumber} has a missing or non-string "snapshot_date"`);
  }
  if (typeof dimension !== 'string') {
    throw new Error(`parseNdjson: line ${lineNumber} has a missing or non-string "dimension"`);
  }
  if (typeof title !== 'string') {
    throw new Error(`parseNdjson: line ${lineNumber} has a missing or non-string "title"`);
  }
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    throw new Error(`parseNdjson: line ${lineNumber} has a missing or non-finite "count"`);
  }
  if (typeof uniques !== 'number' || !Number.isFinite(uniques)) {
    throw new Error(`parseNdjson: line ${lineNumber} has a missing or non-finite "uniques"`);
  }
  return { snapshot_date, dimension, title, count, uniques };
}

/**
 * Parses newline-delimited JSON dimensional rows, one `DimensionRow` per
 * line. Blank lines (including a trailing newline at end of input) are
 * skipped rather than treated as malformed.
 *
 * Fails loudly rather than coercing bad data: a line that isn't valid JSON,
 * or that decodes to something other than a well-formed `DimensionRow`
 * (missing field, wrong type, non-finite number), throws with the 1-based
 * line number so a corrupt snapshot is caught at read time instead of
 * silently propagating into the dashboard. See `parseDimensionRow` for the
 * exact shape contract and why an unrecognised extra key is *not* treated as
 * corruption.
 */
export function parseNdjson(text: string): DimensionRow[] {
  return text
    .split('\n')
    .map((line, index): [string, number] => [line, index + 1])
    .filter(([line]) => line.trim().length > 0)
    .map(([line, lineNumber]) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (cause) {
        throw new Error(`parseNdjson: line ${lineNumber} is not valid JSON`, { cause });
      }
      return parseDimensionRow(value, lineNumber);
    });
}

/**
 * Total order for dimensional rows: `snapshot_date` ascending, then `count`
 * descending, then `dimension` ascending as the tie-break.
 *
 * The order is part of the storage contract, not a preference. Any unstable
 * ordering rewrites the whole file on every daily commit, which would defeat
 * the one-line-per-day diff that justified plain text over SQLite. Shared by
 * `formatNdjson` and `upsertDimensional` so the two orderings can never drift
 * apart.
 *
 * Rows tying on all three keys retain their relative input order, per
 * `Array.prototype.sort`'s ES2019 stability guarantee. In practice this case
 * cannot arise from `upsertDimensional`'s own output: its
 * `(snapshot_date, dimension)` dedup means no two rows it produces ever share
 * both keys, so a true three-key tie is unreachable there.
 */
function compareDimensionRows(a: DimensionRow, b: DimensionRow): number {
  if (a.snapshot_date !== b.snapshot_date) {
    return compareStrings(a.snapshot_date, b.snapshot_date);
  }
  if (a.count !== b.count) return b.count - a.count;
  // `dimension` holds a referrer host or a repo path, so unlike every other
  // value sorted here it can legitimately be non-ASCII. That makes byte
  // ordering matter more, not less: an ICU update could reorder this file
  // even though nothing about the data changed.
  return compareStrings(a.dimension, b.dimension);
}

/**
 * Serialises dimensional rows with the fixed total order defined by
 * `compareDimensionRows`.
 *
 * Builds the stringify target explicitly in canonical field order rather
 * than passing each row's own object through: `JSON.stringify` emits keys in
 * an object's insertion order, so without this the byte output would depend
 * on how the caller happened to construct the row. That guarantee belongs to
 * this function, not to callers' construction habits — the file is committed
 * to git daily, and a varying key order would rewrite every line on every
 * commit, defeating the plain-text-over-database rationale this format
 * exists for.
 */
export function formatNdjson(rows: readonly DimensionRow[]): string {
  const sorted = [...rows].sort(compareDimensionRows);
  return (
    sorted
      .map((row) =>
        JSON.stringify({
          snapshot_date: row.snapshot_date,
          dimension: row.dimension,
          title: row.title,
          count: row.count,
          uniques: row.uniques,
        }),
      )
      .join('\n') + '\n'
  );
}

/**
 * Rejects a `DimensionRow` whose `count` or `uniques` is non-finite
 * (`NaN`/`Infinity`), which the plain `number` type on `DimensionRow`
 * otherwise admits without complaint. Named for the merge that calls it —
 * an in-memory operation, not a file parse — so the message identifies the
 * offending `(snapshot_date, dimension)` pair and field directly, rather
 * than borrowing `parseNdjson`'s "line N" phrasing, which would misdirect a
 * corruption investigation toward a file read that never happened.
 */
function assertFiniteDimensionRow(row: DimensionRow): void {
  if (!Number.isFinite(row.count)) {
    throw new Error(
      `upsertDimensional: row (${row.snapshot_date}, ${row.dimension}) has a non-finite "count"`,
    );
  }
  if (!Number.isFinite(row.uniques)) {
    throw new Error(
      `upsertDimensional: row (${row.snapshot_date}, ${row.dimension}) has a non-finite "uniques"`,
    );
  }
}

/**
 * Merges dimensional rows keyed by `(snapshot_date, dimension)`, with the
 * incoming row unconditionally winning on collision.
 *
 * Unlike `upsertByDate`, there is no `if-absent` backfill mode: dimensional
 * rows come from GitHub's trailing-14-day top-10 referrer/path snapshot,
 * fetched fresh once a day, and there is no `starred_at`-style historical
 * signal to reconstruct them from after the fact. The daily fetch is the
 * only source of truth for this data, so overwrite is the only correct mode
 * — there is nothing else it could mean to merge two dimensional snapshots.
 *
 * Every row that enters the merge, existing or incoming, is validated with
 * `assertFiniteDimensionRow` first — see there for why the message shape
 * differs from `parseNdjson`'s. Validating `existing` is deliberately
 * STRICTER than the round trip this replaced, not equivalent to it: the
 * round trip only ever saw post-dedup survivors, so a corrupt existing row
 * that incoming happened to overwrite slipped through silently. It is safe
 * to tighten because `existing` is loaded from disk through `parseNdjson`,
 * which already rejects a non-finite count at parse time — so for the real
 * pipeline the check can only fire on rows a caller built in memory. When
 * it does fire, the whole merge fails rather than self-healing, matching
 * `parseNdjson`, which aborts a whole file rather than skipping one bad
 * line. For the only surviving copy of deleted data, refusing to proceed
 * beats quietly papering over a value that should have been impossible.
 *
 * Sorts the merged rows directly with `compareDimensionRows` — the same
 * comparator `formatNdjson` uses — rather than round-tripping through
 * `formatNdjson`/`parseNdjson`. The round trip bought nothing but the cost
 * of re-serialising and re-parsing the whole dataset on every merge, and it
 * was also, incidentally, the only thing rejecting a non-finite count before
 * `assertFiniteDimensionRow` took over that job explicitly.
 *
 * Keys on `` `${snapshot_date}\0${dimension}` `` rather than a
 * space-joined string: a NUL byte cannot occur in either field, so the key
 * cannot collide the way a space-joined key could if `snapshot_date` ever
 * contained one.
 */
export function upsertDimensional(
  existing: readonly DimensionRow[],
  incoming: readonly DimensionRow[],
): DimensionRow[] {
  const byKey = new Map<string, DimensionRow>();
  for (const row of existing) {
    assertFiniteDimensionRow(row);
    byKey.set(`${row.snapshot_date}\0${row.dimension}`, row);
  }
  for (const row of incoming) {
    assertFiniteDimensionRow(row);
    byKey.set(`${row.snapshot_date}\0${row.dimension}`, row);
  }
  return [...byKey.values()].sort(compareDimensionRows);
}
