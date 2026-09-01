import type { IsoDate } from './types.ts';

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
