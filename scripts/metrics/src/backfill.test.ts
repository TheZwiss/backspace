import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from './store.ts';
import { backfill } from './backfill.ts';
import { collect, NETWORK_HEADER } from './collect.ts';
import type { GitHubClient } from './github.ts';
import type { PingRow } from './telemetry.ts';

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

function ping(instance: string, day: string): PingRow {
  return {
    instance,
    day,
    country: 'DE',
    schema: 1,
    body: {
      build: { version: '1.1.2' },
      users: { registered: 4, active1d: 1, active7d: 2, active30d: 3 },
    },
  };
}

// Three instances reporting on three consecutive days, so the two-days-in-30
// eligibility rule is met from the second day onward.
const PINGS: PingRow[] = ['a', 'b', 'c'].flatMap((instance) =>
  ['2026-03-02', '2026-03-03', '2026-03-04'].map((day) => ping(instance, day)),
);

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
    expect(result.written.sort()).toEqual([
      'forks.csv',
      'releases.csv',
      'stars.csv',
      'telemetry/clients.ndjson',
      'telemetry/countries.ndjson',
      'telemetry/network.csv',
      'telemetry/versions.ndjson',
    ]);
  });

  it('is idempotent across repeated runs', async () => {
    const store = createStore(dir);
    await backfill({ client: fakeClient(), store, ...base });
    const first = store.readCsv('stars.csv');
    await backfill({ client: fakeClient(), store, ...base });
    expect(store.readCsv('stars.csv')).toEqual(first);
  });

  it('pulls the telemetry retention window in chunks of at most 31 days', async () => {
    const store = createStore(dir);
    const seen: Array<[string, string]> = [];
    await backfill({
      client: fakeClient(),
      store,
      ...base,
      telemetry: async (from, to) => {
        seen.push([from, to]);
        return [];
      },
    });
    expect(seen).toEqual([
      ['2025-12-06', '2026-01-05'],
      ['2026-01-06', '2026-02-05'],
      ['2026-02-06', '2026-03-04'],
    ]);
  });

  it('fills a telemetry day with no row and leaves a day that has one alone', async () => {
    const store = createStore(dir);
    // A row the collector already wrote for 2026-03-04, with a value no
    // reconstruction from the pings below could produce.
    store.writeCsv('telemetry/network.csv', NETWORK_HEADER, [
      {
        date: '2026-03-04',
        instances_1d: 99,
        instances_7d: 99,
        instances_30d: 99,
        users_registered: 99,
        users_active1d: 99,
        users_active7d: 99,
        users_active30d: 99,
        messages7d: 99,
        storage_mib: 99,
        voice_instances: 99,
        federation_instances: 99,
      },
    ]);

    await backfill({
      client: fakeClient(),
      store,
      ...base,
      telemetry: async () => PINGS,
    });

    const rows = store.readCsv('telemetry/network.csv');
    expect(rows.find((r) => r.date === '2026-03-04')).toMatchObject({ instances_7d: '99' });
    expect(rows.find((r) => r.date === '2026-03-03')).toMatchObject({
      instances_7d: '3',
      users_registered: '12',
    });
    // Nothing before the oldest day the export carries: the receiver keeps 90
    // days, but a day it holds no row for at all may simply predate it, and a
    // zero there would be a fabricated measurement (§4.3). The oldest day the
    // export does carry gets no row either, because no instance can be
    // eligible on it and its aggregate is all zeros by construction.
    expect(rows.find((r) => r.date === '2026-01-01')).toBeUndefined();
    expect(rows.find((r) => r.date === '2026-03-02')).toBeUndefined();
    expect(rows[0]?.date).toBe('2026-03-03');
    expect(store.readNdjson('telemetry/versions.ndjson')).toEqual([
      { snapshot_date: '2026-03-03', dimension: '1.1.2', title: '', count: 3, uniques: 3 },
      { snapshot_date: '2026-03-04', dimension: '1.1.2', title: '', count: 3, uniques: 3 },
    ]);
  });

  // A reconstruction cannot see the full 30-day lookback for the earliest days
  // it covers, so its dimension rows for those days are a lower bound and can
  // fold a value into `other` that the collector, running daily with full
  // history, named outright. Merging those in by (snapshot_date, dimension)
  // both replaces a measured row with a worse one and leaves the collector's
  // row beside the folded one, double-counting the day. A day the file already
  // carries is therefore left exactly as it is.
  it('never touches a telemetry day the dimensional file already has rows for', async () => {
    const store = createStore(dir);
    const existing = [
      { snapshot_date: '2026-03-03', dimension: '1.1.2', title: '', count: 5, uniques: 5 },
      { snapshot_date: '2026-03-03', dimension: '9.9.9', title: '', count: 4, uniques: 4 },
    ];
    store.writeNdjson('telemetry/versions.ndjson', existing);

    await backfill({
      client: fakeClient(),
      store,
      ...base,
      telemetry: async () => PINGS,
    });

    // 2026-03-03 is byte-identical and gained nothing; 2026-03-04 was absent
    // and was filled.
    expect(store.readNdjson('telemetry/versions.ndjson')).toEqual([
      ...existing,
      { snapshot_date: '2026-03-04', dimension: '1.1.2', title: '', count: 3, uniques: 3 },
    ]);
  });

  it('writes no network row for the oldest day the export carries', async () => {
    // Eligibility needs two distinct reporting days inside the trailing
    // thirty. On the oldest day the export holds, there is exactly one, so the
    // aggregate is all zeros by construction. Writing it would state a
    // measured empty fleet for the first day evidence exists, which is the
    // fabricated zero section 4.3 forbids.
    const oldest = '2026-01-24';
    const next = '2026-01-25';
    const store = createStore(dir);
    await backfill({
      client: fakeClient(),
      store,
      ...base,
      telemetry: async () => [
        ping('i1', oldest),
        ping('i1', next),
        ping('i2', oldest),
        ping('i2', next),
      ],
    });

    const dates = store.readCsv('telemetry/network.csv').map((row) => row['date']);
    expect(dates).not.toContain(oldest);
    expect(dates[0]).toBe(next);
  });

  // The skip above removes only what the reconstruction would have invented.
  // A row the collector measured on that same day is a real observation and
  // the if-absent merge has to keep it, zeros included.
  it('keeps a measured row on the oldest day the export carries', async () => {
    const oldest = '2026-01-24';
    const store = createStore(dir);
    store.writeCsv('telemetry/network.csv', NETWORK_HEADER, [
      {
        date: oldest,
        instances_1d: 0,
        instances_7d: 7,
        instances_30d: 0,
        users_registered: 0,
        users_active1d: 0,
        users_active7d: 0,
        users_active30d: 0,
        messages7d: 0,
        storage_mib: 0,
        voice_instances: 0,
        federation_instances: 0,
      },
    ]);

    await backfill({
      client: fakeClient(),
      store,
      ...base,
      telemetry: async () => [
        ping('i1', oldest),
        ping('i1', '2026-01-25'),
        ping('i2', oldest),
        ping('i2', '2026-01-25'),
      ],
    });

    const rows = store.readCsv('telemetry/network.csv');
    expect(rows.find((r) => r.date === oldest)).toMatchObject({ instances_7d: '7' });
  });

  it('writes no telemetry files at all when no fetcher is given', async () => {
    const store = createStore(dir);
    await backfill({ client: fakeClient(), store, ...base });
    expect(existsSync(path.join(dir, 'telemetry'))).toBe(false);
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
