import type { DimensionRow, IsoDate } from './types.ts';

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

export function parseCsv(text: string): Record<string, string>[] {
  const rows = splitRows(text);
  const header = rows.shift();
  if (header === undefined) return [];
  return rows.map((fields, index) => {
    if (fields.length > header.length) {
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
    String(a[sortKey] ?? '').localeCompare(String(b[sortKey] ?? '')),
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
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
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
    return a.snapshot_date.localeCompare(b.snapshot_date);
  }
  if (a.count !== b.count) return b.count - a.count;
  return a.dimension.localeCompare(b.dimension);
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
 * differs from `parseNdjson`'s.
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
