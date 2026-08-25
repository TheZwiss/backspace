import { describe, it, expect } from 'vitest';
import { parseCsv, formatCsv, upsertByDate } from './series.ts';

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
