import type { IsoDate } from './types.ts';

/** Quotes a CSV field only when it contains a comma, quote, or newline. */
function quote(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** Splits one CSV line, honouring quoted fields and doubled escape quotes. */
function splitLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char ?? '';
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char ?? '';
    }
  }
  fields.push(current);
  return fields;
}

export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split('\n').filter((line) => line.length > 0);
  const headerLine = lines.shift();
  if (headerLine === undefined) return [];
  const header = splitLine(headerLine);
  return lines.map((line) => {
    const fields = splitLine(line);
    const row: Record<string, string> = {};
    header.forEach((key, index) => {
      row[key] = fields[index] ?? '';
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
