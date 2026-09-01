import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from './store.ts';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'metrics-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createStore', () => {
  it('returns an empty array for a file that does not exist', () => {
    const store = createStore(dir);
    expect(store.readCsv('stars.csv')).toEqual([]);
    expect(store.readNdjson('traffic/referrers.ndjson')).toEqual([]);
  });

  it('creates nested directories on write', () => {
    const store = createStore(dir);
    store.writeCsv('traffic/views.csv', ['date', 'count'], [{ date: '2026-08-01', count: 3 }]);
    expect(existsSync(path.join(dir, 'traffic/views.csv'))).toBe(true);
  });

  it('round-trips CSV through the filesystem', () => {
    const store = createStore(dir);
    store.writeCsv('stars.csv', ['date', 'total'], [{ date: '2026-08-01', total: 56 }]);
    expect(store.readCsv('stars.csv')).toEqual([{ date: '2026-08-01', total: '56' }]);
  });

  it('round-trips NDJSON through the filesystem', () => {
    const store = createStore(dir);
    const rows = [
      { snapshot_date: '2026-08-01', dimension: 'a.com', title: '', count: 5, uniques: 2 },
    ];
    store.writeNdjson('traffic/referrers.ndjson', rows);
    expect(store.readNdjson('traffic/referrers.ndjson')).toEqual(rows);
  });

  it('returns null when meta.json is absent', () => {
    expect(createStore(dir).readMeta()).toBeNull();
  });

  it('writes meta.json as pretty-printed JSON with a trailing newline', () => {
    const store = createStore(dir);
    store.writeMeta({
      last_run: '2026-08-25T03:00:41Z',
      last_success: '2026-08-25T03:00:41Z',
      error: null,
      series_last_date: { 'stars.csv': '2026-08-25' },
    });
    const text = readFileSync(path.join(dir, 'meta.json'), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "last_run"');
    expect(store.readMeta()?.series_last_date['stars.csv']).toBe('2026-08-25');
  });

  it('does not double the trailing newline that formatCsv/formatNdjson already append', () => {
    const store = createStore(dir);
    store.writeCsv('stars.csv', ['date', 'total'], [{ date: '2026-08-01', total: 1 }]);
    const csvText = readFileSync(path.join(dir, 'stars.csv'), 'utf8');
    expect(csvText.endsWith('\n\n')).toBe(false);

    store.writeNdjson('traffic/referrers.ndjson', [
      { snapshot_date: '2026-08-01', dimension: 'a.com', title: '', count: 1, uniques: 1 },
    ]);
    const ndjsonText = readFileSync(path.join(dir, 'traffic/referrers.ndjson'), 'utf8');
    expect(ndjsonText.endsWith('\n\n')).toBe(false);
  });

  describe('absent vs. corrupt', () => {
    it('throws (does not return []) when a CSV file exists but has a malformed row', () => {
      const store = createStore(dir);
      // header has 2 columns; data row has 3 — parseCsv must throw, not be
      // swallowed into an empty read.
      writeFileSync(path.join(dir, 'stars.csv'), 'date,total\n2026-08-01,1,extra\n', 'utf8');
      expect(() => store.readCsv('stars.csv')).toThrow();
    });

    it('throws (does not return []) when an NDJSON file exists but has an invalid line', () => {
      const store = createStore(dir);
      writeFileSync(path.join(dir, 'referrers.ndjson'), 'not json\n', 'utf8');
      expect(() => store.readNdjson('referrers.ndjson')).toThrow();
    });

    it('throws when a file path is actually a directory rather than treating it as absent', () => {
      const store = createStore(dir);
      mkdirSync(path.join(dir, 'stars.csv'));
      expect(() => store.readCsv('stars.csv')).toThrow();
    });

    it('throws when meta.json exists but is not valid JSON', () => {
      const store = createStore(dir);
      writeFileSync(path.join(dir, 'meta.json'), '{ not valid json', 'utf8');
      expect(() => store.readMeta()).toThrow();
    });

    it('throws when meta.json is valid JSON but missing a required field', () => {
      const store = createStore(dir);
      writeFileSync(
        path.join(dir, 'meta.json'),
        JSON.stringify({ last_run: '2026-08-25T03:00:41Z', error: null, series_last_date: {} }),
        'utf8',
      );
      expect(() => store.readMeta()).toThrow(/last_success/);
    });

    it('throws when meta.json has a wrong-typed field', () => {
      const store = createStore(dir);
      writeFileSync(
        path.join(dir, 'meta.json'),
        JSON.stringify({
          last_run: '2026-08-25T03:00:41Z',
          last_success: null,
          error: null,
          series_last_date: 'not-an-object',
        }),
        'utf8',
      );
      expect(() => store.readMeta()).toThrow(/series_last_date/);
    });

    it('throws when meta.json series_last_date has a non-string value', () => {
      const store = createStore(dir);
      writeFileSync(
        path.join(dir, 'meta.json'),
        JSON.stringify({
          last_run: '2026-08-25T03:00:41Z',
          last_success: null,
          error: null,
          series_last_date: { 'stars.csv': 20260825 },
        }),
        'utf8',
      );
      expect(() => store.readMeta()).toThrow(/series_last_date/);
    });

    it('propagates a permission error rather than treating it as absent', () => {
      // Root can read past permission bits, so this case is only meaningful
      // for a non-root test runner; skip rather than false-fail under root.
      if (process.getuid?.() === 0) return;
      const store = createStore(dir);
      const file = path.join(dir, 'stars.csv');
      writeFileSync(file, 'date,total\n2026-08-01,1\n', 'utf8');
      chmodSync(file, 0o000);
      try {
        expect(() => store.readCsv('stars.csv')).toThrow();
      } finally {
        chmodSync(file, 0o644);
      }
    });
  });

  describe('atomic writes', () => {
    it('leaves no temp file behind after a successful write', () => {
      const store = createStore(dir);
      store.writeCsv('stars.csv', ['date', 'total'], [{ date: '2026-08-01', total: 1 }]);
      const entries = readdirSync(dir);
      expect(entries).toEqual(['stars.csv']);
    });

    it('replaces an existing file wholesale rather than truncating it in place', () => {
      const store = createStore(dir);
      store.writeCsv('stars.csv', ['date', 'total'], [{ date: '2026-08-01', total: 1 }]);
      store.writeCsv(
        'stars.csv',
        ['date', 'total'],
        [
          { date: '2026-08-01', total: 1 },
          { date: '2026-08-02', total: 2 },
        ],
      );
      const entries = readdirSync(dir);
      expect(entries).toEqual(['stars.csv']);
      expect(store.readCsv('stars.csv')).toEqual([
        { date: '2026-08-01', total: '1' },
        { date: '2026-08-02', total: '2' },
      ]);
    });

    it('leaves no temp file behind after writing meta.json', () => {
      const store = createStore(dir);
      store.writeMeta({
        last_run: '2026-08-25T03:00:41Z',
        last_success: null,
        error: null,
        series_last_date: {},
      });
      expect(readdirSync(dir)).toEqual(['meta.json']);
    });
  });

  describe('path containment', () => {
    it('throws rather than reading outside the data directory via ../ traversal', () => {
      const store = createStore(dir);
      expect(() => store.readCsv('../outside.csv')).toThrow();
      expect(() => store.readNdjson('../../etc/outside.ndjson')).toThrow();
    });

    it('throws rather than writing outside the data directory via ../ traversal', () => {
      const store = createStore(dir);
      expect(() =>
        store.writeCsv('../outside.csv', ['date', 'total'], [{ date: '2026-08-01', total: 1 }]),
      ).toThrow();
      expect(existsSync(path.join(dir, '..', 'outside.csv'))).toBe(false);
    });

    it('throws rather than reading/writing an absolute path outside the data directory', () => {
      const store = createStore(dir);
      const outside = path.join(tmpdir(), 'metrics-store-outside.csv');
      expect(() => store.readCsv(outside)).toThrow();
      expect(() =>
        store.writeCsv(outside, ['date', 'total'], [{ date: '2026-08-01', total: 1 }]),
      ).toThrow();
      expect(existsSync(outside)).toBe(false);
    });

    it('allows a file argument that resolves exactly to a subpath of the data directory', () => {
      const store = createStore(dir);
      store.writeCsv('a/b/c.csv', ['date', 'total'], [{ date: '2026-08-01', total: 1 }]);
      expect(store.readCsv('a/b/c.csv')).toEqual([{ date: '2026-08-01', total: '1' }]);
    });
  });
});
