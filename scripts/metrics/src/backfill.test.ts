import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from './store.ts';
import { backfill } from './backfill.ts';
import type { GitHubClient } from './github.ts';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'metrics-backfill-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const STARGAZERS = [
  { starred_at: '2026-02-20T10:00:00Z' },
  { starred_at: '2026-02-20T18:00:00Z' },
  { starred_at: '2026-03-01T09:00:00Z' },
];
const FORKS = [{ created_at: '2026-03-05T09:00:00Z' }];
const RELEASES = [
  { tag_name: 'v1.0.0', name: 'Backspace 1.0.0', published_at: '2026-08-01T10:00:00Z' },
];

function fakeClient(pages: Record<string, unknown[]> = {}): GitHubClient {
  const routes: Record<string, unknown[]> = {
    '/repos/o/r/stargazers': STARGAZERS,
    '/repos/o/r/forks?sort=oldest': FORKS,
    '/repos/o/r/releases': RELEASES,
    ...pages,
  };
  return {
    async get<T>(p: string): Promise<T> {
      throw new Error(`backfill must paginate, not get: ${p}`);
    },
    async getStats<T>(): Promise<T | null> {
      return null;
    },
    async paginate<T>(p: string): Promise<T[]> {
      const value = routes[p];
      if (value === undefined) throw new Error(`unexpected paginate ${p}`);
      return value as T[];
    },
  };
}

const base = { slug: 'o/r' };

describe('backfill', () => {
  it('accumulates stars cumulatively by the UTC day of starred_at', async () => {
    const store = createStore(dir);
    await backfill({ client: fakeClient(), store, ...base });
    expect(store.readCsv('stars.csv')).toEqual([
      { date: '2026-02-20', total: '2' },
      { date: '2026-03-01', total: '3' },
    ]);
  });

  it('accumulates forks cumulatively by created_at', async () => {
    const store = createStore(dir);
    await backfill({ client: fakeClient(), store, ...base });
    expect(store.readCsv('forks.csv')).toEqual([{ date: '2026-03-05', total: '1' }]);
  });

  it('records release dates', async () => {
    const store = createStore(dir);
    await backfill({ client: fakeClient(), store, ...base });
    expect(store.readCsv('releases.csv')).toEqual([
      { date: '2026-08-01', tag: 'v1.0.0', name: 'Backspace 1.0.0' },
    ]);
  });

  it('NEVER overwrites a date the collector already measured', async () => {
    const store = createStore(dir);
    // The collector measured 1 star on 2026-03-01, because someone unstarred.
    // The reconstruction from /stargazers cannot see that and would say 3.
    store.writeCsv('stars.csv', ['date', 'total'], [{ date: '2026-03-01', total: 1 }]);
    await backfill({ client: fakeClient(), store, ...base });
    const rows = store.readCsv('stars.csv');
    expect(rows.find((r) => r.date === '2026-03-01')?.total).toBe('1');
  });

  it('still fills dates the collector never saw', async () => {
    const store = createStore(dir);
    store.writeCsv('stars.csv', ['date', 'total'], [{ date: '2026-03-01', total: 1 }]);
    await backfill({ client: fakeClient(), store, ...base });
    const rows = store.readCsv('stars.csv');
    expect(rows.find((r) => r.date === '2026-02-20')?.total).toBe('2');
  });

  it('never touches traffic files or repo.csv', async () => {
    const store = createStore(dir);
    await backfill({ client: fakeClient(), store, ...base });
    expect(existsSync(path.join(dir, 'traffic'))).toBe(false);
    expect(existsSync(path.join(dir, 'repo.csv'))).toBe(false);
  });

  it('reports exactly the files it may write', async () => {
    const store = createStore(dir);
    const result = await backfill({ client: fakeClient(), store, ...base });
    expect(result.written.sort()).toEqual(['forks.csv', 'releases.csv', 'stars.csv']);
  });

  it('is idempotent across repeated runs', async () => {
    const store = createStore(dir);
    await backfill({ client: fakeClient(), store, ...base });
    const first = store.readCsv('stars.csv');
    await backfill({ client: fakeClient(), store, ...base });
    expect(store.readCsv('stars.csv')).toEqual(first);
  });

  it('handles multi-page stargazer results', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      starred_at: `2026-04-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
    }));
    const store = createStore(dir);
    await backfill({ client: fakeClient({ '/repos/o/r/stargazers': many }), store, ...base });
    const rows = store.readCsv('stars.csv');
    expect(rows[rows.length - 1]?.total).toBe('150');
  });
});
