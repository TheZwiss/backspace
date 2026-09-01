import { describe, it, expect } from 'vitest';
import { parseCsv, formatCsv, upsertByDate, parseNdjson, formatNdjson, upsertDimensional } from './series.ts';
import type { DimensionRow } from './types.ts';

describe('parseCsv', () => {
  it('parses a header and rows into keyed records', () => {
    const text = 'date,count,uniques\n2026-08-01,10,4\n2026-08-02,12,5\n';
    expect(parseCsv(text)).toEqual([
      { date: '2026-08-01', count: '10', uniques: '4' },
      { date: '2026-08-02', count: '12', uniques: '5' },
    ]);
  });

  it('returns an empty array for empty or header-only input', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('date,count\n')).toEqual([]);
  });

  it('round-trips quoted fields containing commas and quotes', () => {
    const rows = [{ snapshot_date: '2026-08-01', title: 'Backspace: chat, voice and "video"' }];
    const text = formatCsv(['snapshot_date', 'title'], rows);
    expect(parseCsv(text)).toEqual([
      { snapshot_date: '2026-08-01', title: 'Backspace: chat, voice and "video"' },
    ]);
  });

  it('parses CRLF input to clean keys and clean values', () => {
    const text = 'date,count,uniques\r\n2026-08-01,10,4\r\n';
    const rows = parseCsv(text);
    expect(rows).toEqual([{ date: '2026-08-01', count: '10', uniques: '4' }]);
    expect(rows[0]?.uniques).toBe('4');
  });

  it('parses a file with a mix of LF and CRLF line endings', () => {
    const text = 'date,count\n2026-08-01,10\r\n2026-08-02,20\n';
    expect(parseCsv(text)).toEqual([
      { date: '2026-08-01', count: '10' },
      { date: '2026-08-02', count: '20' },
    ]);
  });

  it('round-trips a value containing an embedded newline as a single row', () => {
    const rows = [{ date: '2026-08-01', note: 'line one\nline two' }];
    const text = formatCsv(['date', 'note'], rows);
    const parsed = parseCsv(text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.note).toBe('line one\nline two');
  });

  it('round-trips a value containing an embedded CRLF', () => {
    const rows = [{ date: '2026-08-01', note: 'line one\r\nline two' }];
    const text = formatCsv(['date', 'note'], rows);
    const parsed = parseCsv(text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.note).toBe('line one\r\nline two');
  });

  it('round-trips a value containing a quote, a comma, and a newline together', () => {
    const rows = [{ date: '2026-08-01', note: 'has "quote", a comma\nand a newline' }];
    const text = formatCsv(['date', 'note'], rows);
    const parsed = parseCsv(text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.note).toBe('has "quote", a comma\nand a newline');
  });

  it('returns [] for header-only input, empty string, and input with a trailing blank line', () => {
    expect(parseCsv('date,count\n')).toEqual([]);
    expect(parseCsv('')).toEqual([]);
    const text = 'date,count\n2026-08-01,10\n\n';
    expect(parseCsv(text)).toEqual([{ date: '2026-08-01', count: '10' }]);
  });

  it('pads a short row (fewer fields than the header) with empty strings', () => {
    const text = 'date,count,uniques\n2026-08-01,10\n';
    expect(parseCsv(text)).toEqual([{ date: '2026-08-01', count: '10', uniques: '' }]);
  });

  it('throws on a long row (more fields than the header), naming the row number', () => {
    const text = 'date,count\n2026-08-01,10,4\n';
    expect(() => parseCsv(text)).toThrow(/row 1/i);
  });

  it('throws naming the correct 1-based row number for a later offending row', () => {
    const text = 'date,count\n2026-08-01,10\n2026-08-02,20,99\n';
    expect(() => parseCsv(text)).toThrow(/row 2/i);
  });

  it('throws on an unterminated quote rather than swallowing the rest of the file', () => {
    // Without this guard the open quote absorbs every following row into one
    // field: two well-formed rows would vanish with no error raised.
    const text = 'date,note\n2026-08-01,"oops\n2026-08-02,10\n2026-08-03,20\n';
    expect(() => parseCsv(text)).toThrow(/unterminated/i);
  });

  it('still parses a file whose final row has no trailing newline', () => {
    expect(parseCsv('date,count\n2026-08-01,10')).toEqual([{ date: '2026-08-01', count: '10' }]);
  });
});

describe('formatCsv', () => {
  it('emits a header, sorts by the first column, and ends with a newline', () => {
    const text = formatCsv(['date', 'total'], [
      { date: '2026-08-02', total: 2 },
      { date: '2026-08-01', total: 1 },
    ]);
    expect(text).toBe('date,total\n2026-08-01,1\n2026-08-02,2\n');
  });
});

describe('upsertByDate', () => {
  const existing = [
    { date: '2026-08-01', total: 1 },
    { date: '2026-08-02', total: 2 },
  ];

  it('overwrite mode: fetched values win on collision', () => {
    const result = upsertByDate(existing, [{ date: '2026-08-02', total: 99 }], 'overwrite');
    expect(result).toEqual([
      { date: '2026-08-01', total: 1 },
      { date: '2026-08-02', total: 99 },
    ]);
  });

  it('overwrite mode: overlapping windows produce no duplicates', () => {
    const incoming = [
      { date: '2026-08-02', total: 2 },
      { date: '2026-08-03', total: 3 },
    ];
    const result = upsertByDate(existing, incoming, 'overwrite');
    expect(result.map((r) => r.date)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
  });

  it('overwrite mode: re-running with identical input is byte-identical', () => {
    const once = upsertByDate(existing, existing, 'overwrite');
    const twice = upsertByDate(once, existing, 'overwrite');
    expect(formatCsv(['date', 'total'], twice)).toBe(formatCsv(['date', 'total'], once));
  });

  it('if-absent mode: never overwrites a date that already has a row', () => {
    const result = upsertByDate(existing, [{ date: '2026-08-02', total: 99 }], 'if-absent');
    expect(result).toEqual(existing);
  });

  it('if-absent mode: fills only genuinely missing dates', () => {
    const result = upsertByDate(existing, [
      { date: '2026-08-02', total: 99 },
      { date: '2026-08-03', total: 3 },
    ], 'if-absent');
    expect(result).toEqual([
      { date: '2026-08-01', total: 1 },
      { date: '2026-08-02', total: 2 },
      { date: '2026-08-03', total: 3 },
    ]);
  });

  it('leaves gaps absent rather than zero-filling them', () => {
    const result = upsertByDate([], [
      { date: '2026-08-01', total: 1 },
      { date: '2026-08-05', total: 5 },
    ], 'overwrite');
    expect(result.map((r) => r.date)).toEqual(['2026-08-01', '2026-08-05']);
  });

  it('sorts output ascending regardless of input order', () => {
    const result = upsertByDate([], [
      { date: '2026-08-09', total: 9 },
      { date: '2026-08-01', total: 1 },
    ], 'overwrite');
    expect(result.map((r) => r.date)).toEqual(['2026-08-01', '2026-08-09']);
  });
});

function row(snapshot_date: string, dimension: string, count: number): DimensionRow {
  return { snapshot_date, dimension, title: '', count, uniques: 1 };
}

describe('formatNdjson', () => {
  it('sorts by snapshot_date asc, then count desc, then dimension asc', () => {
    const text = formatNdjson([
      row('2026-08-02', 'b.com', 5),
      row('2026-08-01', 'z.com', 1),
      row('2026-08-01', 'a.com', 9),
      row('2026-08-01', 'm.com', 9),
    ]);
    const order = text
      .trim()
      .split('\n')
      .map((line) => {
        const parsed = JSON.parse(line) as DimensionRow;
        return `${parsed.snapshot_date}/${parsed.dimension}`;
      });
    expect(order).toEqual([
      '2026-08-01/a.com',
      '2026-08-01/m.com',
      '2026-08-01/z.com',
      '2026-08-02/b.com',
    ]);
  });

  it('round-trips through parseNdjson', () => {
    const rows = [row('2026-08-01', 'news.ycombinator.com', 118)];
    expect(parseNdjson(formatNdjson(rows))).toEqual(rows);
  });

  it('ignores blank lines when parsing', () => {
    expect(parseNdjson('\n\n')).toEqual([]);
  });
});

describe('parseNdjson malformed input', () => {
  it('throws naming the line number for invalid JSON syntax', () => {
    const text = '{"snapshot_date":"2026-08-01","dimension":"a.com","title":"","count":1,"uniques":1}\n{not json}\n';
    expect(() => parseNdjson(text)).toThrow(/line 2/i);
  });

  it('throws when a line is valid JSON but not an object', () => {
    expect(() => parseNdjson('[1,2,3]\n')).toThrow(/line 1/i);
    expect(() => parseNdjson('"just a string"\n')).toThrow(/line 1/i);
    expect(() => parseNdjson('42\n')).toThrow(/line 1/i);
    expect(() => parseNdjson('null\n')).toThrow(/line 1/i);
  });

  it('throws naming the missing field when a required string field is absent', () => {
    const text = '{"dimension":"a.com","title":"","count":1,"uniques":1}\n';
    expect(() => parseNdjson(text)).toThrow(/snapshot_date/);
  });

  it('throws when a numeric field is the wrong type', () => {
    const text = '{"snapshot_date":"2026-08-01","dimension":"a.com","title":"","count":"1","uniques":1}\n';
    expect(() => parseNdjson(text)).toThrow(/count/);
  });

  it('throws when a numeric field is not finite', () => {
    // JSON has no NaN/Infinity literal, but a magnitude like 1e999 overflows
    // to Infinity during JSON.parse itself; the parser must not wave a
    // non-finite count through as if it were a real measured value.
    const text = '{"snapshot_date":"2026-08-01","dimension":"a.com","title":"","count":1e999,"uniques":1}\n';
    expect(() => parseNdjson(text)).toThrow(/count/);
  });

  it('throws naming the line number for the second offending row, not the first', () => {
    const text = '{"snapshot_date":"2026-08-01","dimension":"a.com","title":"","count":1,"uniques":1}\n{"snapshot_date":"2026-08-02","dimension":"b.com","title":"","count":1}\n';
    expect(() => parseNdjson(text)).toThrow(/line 2/i);
  });

  it('does not reject an object carrying an unrecognised extra key', () => {
    const text = '{"snapshot_date":"2026-08-01","dimension":"a.com","title":"","count":1,"uniques":1,"extra":"future field"}\n';
    expect(parseNdjson(text)).toEqual([row('2026-08-01', 'a.com', 1)]);
  });
});

describe('upsertDimensional', () => {
  it('replaces a row with the same (snapshot_date, dimension)', () => {
    const existing = [row('2026-08-01', 'a.com', 1)];
    const result = upsertDimensional(existing, [row('2026-08-01', 'a.com', 42)]);
    expect(result).toHaveLength(1);
    expect(result[0]?.count).toBe(42);
  });

  it('keeps rows from other snapshots untouched', () => {
    const existing = [row('2026-08-01', 'a.com', 1)];
    const result = upsertDimensional(existing, [row('2026-08-02', 'a.com', 2)]);
    expect(result).toHaveLength(2);
  });

  it('does not resurrect a dimension that dropped out of the new snapshot', () => {
    const existing = [row('2026-08-01', 'a.com', 1)];
    const result = upsertDimensional(existing, [row('2026-08-02', 'b.com', 2)]);
    const day2 = result.filter((r) => r.snapshot_date === '2026-08-02');
    expect(day2.map((r) => r.dimension)).toEqual(['b.com']);
  });

  it('re-running with identical input is byte-identical', () => {
    const rows = [row('2026-08-01', 'a.com', 1), row('2026-08-01', 'b.com', 2)];
    const once = upsertDimensional([], rows);
    const twice = upsertDimensional(once, rows);
    expect(formatNdjson(twice)).toBe(formatNdjson(once));
  });
});
