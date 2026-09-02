import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from './store.ts';
import { backfill } from './backfill.ts';
import { collect } from './collect.ts';
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
// Two runs on 02-21 and one on 02-23. 02-22 falls between them and must
// reconstruct as a measured 0, while everything before 02-21 — the oldest
// surviving run — must not be reconstructed at all, because GitHub deletes
// runs by age and an older day's silence is destroyed evidence, not a zero.
const WORKFLOW_RUNS = [
  { created_at: '2026-02-21T08:00:00Z' },
  { created_at: '2026-02-21T20:00:00Z' },
  { created_at: '2026-02-23T09:00:00Z' },
];

const RELEASES = [
  { tag_name: 'v1.0.0', name: 'Backspace 1.0.0', published_at: '2026-08-01T10:00:00Z' },
];

function fakeClient(pages: Record<string, unknown[]> = {}): GitHubClient {
  const routes: Record<string, unknown[]> = {
    '/repos/o/r/stargazers': STARGAZERS,
    '/repos/o/r/forks?sort=oldest': FORKS,
    '/repos/o/r/releases': RELEASES,
    '/repos/o/r/actions/runs': WORKFLOW_RUNS,
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
    async paginateEnvelope<T>(p: string, key: string): Promise<T[]> {
      if (key !== 'workflow_runs') throw new Error(`unexpected envelope key ${key}`);
      const value = routes[p];
      if (value === undefined) throw new Error(`unexpected paginateEnvelope ${p}`);
      return value as T[];
    },
  };
}

// `today` bounds the reconstruction forward, exactly as it does for the real
// entrypoint: a cumulative counter is known on every day from its first event
// up to the moment the reconstruction is taken, not merely on the days it
// happened to move.
const base = { slug: 'o/r', today: '2026-03-05' };

describe('backfill', () => {
  it('accumulates stars cumulatively by the UTC day of starred_at', async () => {
    const store = createStore(dir);
    await backfill({ client: fakeClient(), store, ...base });
    const rows = store.readCsv('stars.csv');
    expect(rows[0]).toEqual({ date: '2026-02-20', total: '2' });
    expect(rows.find((r) => r.date === '2026-03-01')).toEqual({ date: '2026-03-01', total: '3' });
  });

  // The defect this fill exists to remove: a day on which nobody starred is a
  // day whose total is known exactly — it is the running total carried
  // forward — so writing no row for it publishes a hole in the record where
  // there is no hole in the knowledge. The dashboard draws an absent date as a
  // break in the line, which is correct for traffic (GitHub omits a day it
  // measured no views) and wrong here.
  it('writes a row for every day between two star events, not only the days that moved', async () => {
    const store = createStore(dir);
    await backfill({ client: fakeClient(), store, ...base });
    const rows = store.readCsv('stars.csv');
    const between = rows.filter(
      (r) => (r.date ?? '') > '2026-02-20' && (r.date ?? '') < '2026-03-01',
    );
    expect(between).toHaveLength(8); // 2026-02-21 .. 2026-02-28 inclusive
    expect(between.every((r) => r.total === '2')).toBe(true);
    expect(rows.map((r) => r.date)).toContain('2026-02-25');
  });

  it('carries the total forward from the last event to the run date', async () => {
    const store = createStore(dir);
    await backfill({ client: fakeClient(), store, ...base });
    const rows = store.readCsv('stars.csv');
    expect(rows[rows.length - 1]).toEqual({ date: '2026-03-05', total: '3' });
    expect(rows.filter((r) => (r.date ?? '') > '2026-03-01').every((r) => r.total === '3')).toBe(
      true,
    );
  });

  // The count before the first star is arguably derivable too, but only by
  // assuming the repository already existed and stood at zero — a claim this
  // package has no measurement for. The series starts where the evidence does.
  it('invents no day before the first event', async () => {
    const store = createStore(dir);
    await backfill({ client: fakeClient(), store, ...base });
    const rows = store.readCsv('stars.csv');
    expect(rows[0]?.date).toBe('2026-02-20');
  });

  it('writes nothing at all when there are no events to reconstruct from', async () => {
    const store = createStore(dir);
    await backfill({ client: fakeClient({ '/repos/o/r/stargazers': [] }), store, ...base });
    expect(store.readCsv('stars.csv')).toEqual([]);
  });

  // Clock skew, or simply a star recorded after the reconstruction was
  // requested: the run date bounds the fill, it must never truncate evidence.
  it('never drops an event dated after the run date', async () => {
    const store = createStore(dir);
    await backfill({ client: fakeClient(), store, ...base, today: '2026-02-22' });
    const rows = store.readCsv('stars.csv');
    expect(rows[rows.length - 1]).toEqual({ date: '2026-03-01', total: '3' });
  });

  it('reconstructs workflow runs per day, with a measured zero between them', async () => {
    const store = createStore(dir);
    await backfill({ client: fakeClient(), store, ...base });
    const rows = store.readCsv('workflows.csv');
    expect(rows.find((r) => r.date === '2026-02-21')).toEqual({ date: '2026-02-21', runs: '2' });
    expect(rows.find((r) => r.date === '2026-02-22')).toEqual({ date: '2026-02-22', runs: '0' });
    expect(rows.find((r) => r.date === '2026-02-23')).toEqual({ date: '2026-02-23', runs: '1' });
  });

  // The bound that keeps this honest. GitHub deletes workflow runs by age, so
  // a day older than the oldest surviving run has had its evidence destroyed —
  // reconstructing a confident `0` there would be a fabricated measurement,
  // and it would look exactly like a genuinely quiet day forever after.
  it('reconstructs nothing before the oldest surviving run', async () => {
    const store = createStore(dir);
    await backfill({ client: fakeClient(), store, ...base });
    const dates = store.readCsv('workflows.csv').map((r) => r.date);
    expect(dates[0]).toBe('2026-02-21');
    expect(dates).not.toContain('2026-02-20');
  });

  // Inside the surviving span the fill runs all the way to the run date: those
  // zeros ARE measurements, because retention deletes uniformly by age.
  it('fills quiet days from the last run up to the run date', async () => {
    const store = createStore(dir);
    await backfill({ client: fakeClient(), store, ...base });
    const rows = store.readCsv('workflows.csv');
    expect(rows[rows.length - 1]).toEqual({ date: '2026-03-05', runs: '0' });
  });

  it('writes no workflow rows at all when no run survives', async () => {
    const store = createStore(dir);
    await backfill({ client: fakeClient({ '/repos/o/r/actions/runs': [] }), store, ...base });
    expect(store.readCsv('workflows.csv')).toEqual([]);
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

  it('keeps both releases when two are published on the same UTC day', async () => {
    const store = createStore(dir);
    const client = fakeClient({
      '/repos/o/r/releases': [
        { tag_name: 'v1.0.1', name: 'v1.0.1', published_at: '2026-08-01T18:00:00Z' },
        { tag_name: 'v1.0.0', name: 'v1.0.0', published_at: '2026-08-01T09:00:00Z' },
      ],
    });
    await backfill({ client, store, ...base });
    expect(store.readCsv('releases.csv')).toEqual([
      { date: '2026-08-01', tag: 'v1.0.0', name: 'v1.0.0' },
      { date: '2026-08-01', tag: 'v1.0.1', name: 'v1.0.1' },
    ]);
  });

  it('is idempotent for same-day releases across repeated runs', async () => {
    const store = createStore(dir);
    const client = fakeClient({
      '/repos/o/r/releases': [
        { tag_name: 'v1.0.1', name: 'v1.0.1', published_at: '2026-08-01T18:00:00Z' },
        { tag_name: 'v1.0.0', name: 'v1.0.0', published_at: '2026-08-01T09:00:00Z' },
      ],
    });
    await backfill({ client, store, ...base });
    const first = store.readCsv('releases.csv');
    await backfill({ client, store, ...base });
    expect(store.readCsv('releases.csv')).toEqual(first);
  });

  it('never alters a release the collector already wrote, even under a different name', async () => {
    // collect() and backfill() both write releases.csv, keyed on tag. If
    // collect() ran first and recorded a release, a later backfill() dispatch
    // reconstructing the same tag from /releases (a raw list, not filtered to
    // "new since last run") must not clobber it — matching the if-absent
    // guarantee stars.csv/forks.csv already have, now extended to the
    // tag-keyed merge.
    const store = createStore(dir);
    const collectClient: GitHubClient = {
      async get<T>(p: string): Promise<T> {
        const routes: Record<string, unknown> = {
          '/repos/o/r/traffic/views': { views: [] },
          '/repos/o/r/traffic/clones': { clones: [] },
          '/repos/o/r/traffic/popular/referrers': [],
          '/repos/o/r/traffic/popular/paths': [],
          '/repos/o/r': {
            stargazers_count: 1,
            forks_count: 1,
            subscribers_count: 1,
            open_issues_count: 1,
          },
        };
        const value = routes[p];
        if (value === undefined) throw new Error(`unexpected GET ${p}`);
        return value as T;
      },
      async getStats<T>(): Promise<T | null> {
        return null;
      },
      async paginateEnvelope<T>(): Promise<T[]> {
        return [] as T[];
      },
      async paginate<T>(p: string): Promise<T[]> {
        if (p !== '/repos/o/r/releases') throw new Error(`unexpected paginate ${p}`);
        return [
          {
            tag_name: 'v1.0.0',
            name: 'Collector name',
            published_at: '2026-08-01T10:00:00Z',
            assets: [],
          },
        ] as T[];
      },
    };
    await collect({
      client: collectClient,
      store,
      slug: 'o/r',
      today: '2026-08-25',
      now: '2026-08-25T03:00:00Z',
    });
    expect(store.readCsv('releases.csv')).toEqual([
      { date: '2026-08-01', tag: 'v1.0.0', name: 'Collector name' },
    ]);

    const backfillClient = fakeClient({
      '/repos/o/r/releases': [
        { tag_name: 'v1.0.0', name: 'Reconstructed name', published_at: '2026-08-01T10:00:00Z' },
      ],
    });
    await backfill({ client: backfillClient, store, ...base });
    expect(store.readCsv('releases.csv')).toEqual([
      { date: '2026-08-01', tag: 'v1.0.0', name: 'Collector name' },
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

  // Filling the quiet days widens the range backfill writes into, so the
  // if-absent guarantee now has to hold on dates the reconstruction reaches
  // only because of the fill — not just on the dates an event landed on.
  it('NEVER overwrites a collector row that falls on a filled quiet day', async () => {
    const store = createStore(dir);
    store.writeCsv('stars.csv', ['date', 'total'], [{ date: '2026-02-25', total: 99 }]);
    await backfill({ client: fakeClient(), store, ...base });
    const rows = store.readCsv('stars.csv');
    expect(rows.find((r) => r.date === '2026-02-25')?.total).toBe('99');
    expect(rows.find((r) => r.date === '2026-02-24')?.total).toBe('2');
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
