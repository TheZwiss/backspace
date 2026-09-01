import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from './store.ts';
import { collect } from './collect.ts';
import type { GitHubClient } from './github.ts';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'metrics-collect-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const VIEWS = {
  views: [
    { timestamp: '2026-08-23T00:00:00Z', count: 40, uniques: 12 },
    { timestamp: '2026-08-24T00:00:00Z', count: 51, uniques: 15 },
  ],
};
const CLONES = {
  clones: [{ timestamp: '2026-08-24T00:00:00Z', count: 4, uniques: 3 }],
};
const REFERRERS = [{ referrer: 'news.ycombinator.com', count: 118, uniques: 94 }];
const PATHS = [{ path: '/TheZwiss/backspace', title: 'Backspace', count: 402, uniques: 161 }];
const REPO = {
  stargazers_count: 56,
  forks_count: 3,
  subscribers_count: 1,
  open_issues_count: 13,
};
const RELEASES = [
  {
    tag_name: 'v1.0.0',
    name: 'Backspace 1.0.0',
    published_at: '2026-08-01T10:00:00Z',
    assets: [{ download_count: 20 }, { download_count: 17 }],
  },
];
const CONTRIBUTORS = [{ weeks: [{ w: 1771200000, c: 3 }] }, { weeks: [{ w: 1771804800, c: 1 }] }];

function fakeClient(overrides: Partial<Record<string, unknown>> = {}): GitHubClient {
  const routes: Record<string, unknown> = {
    '/repos/o/r/traffic/views': VIEWS,
    '/repos/o/r/traffic/clones': CLONES,
    '/repos/o/r/traffic/popular/referrers': REFERRERS,
    '/repos/o/r/traffic/popular/paths': PATHS,
    '/repos/o/r': REPO,
    '/repos/o/r/releases': RELEASES,
    ...overrides,
  };
  return {
    async get<T>(p: string): Promise<T> {
      const value = routes[p];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`unexpected GET ${p}`);
      return value as T;
    },
    async getStats<T>(p: string): Promise<T | null> {
      if (Object.prototype.hasOwnProperty.call(overrides, p)) {
        return overrides[p] as T | null;
      }
      if (p === '/repos/o/r/stats/contributors') return CONTRIBUTORS as T;
      return null;
    },
    async paginate<T>(): Promise<T[]> {
      throw new Error('collect must not paginate');
    },
  };
}

const base = { slug: 'o/r', today: '2026-08-25', now: '2026-08-25T03:00:41Z' };

describe('collect', () => {
  it('writes traffic keyed by the bucket date, not by today', async () => {
    const store = createStore(dir);
    await collect({ client: fakeClient(), store, ...base });
    expect(store.readCsv('traffic/views.csv')).toEqual([
      { date: '2026-08-23', count: '40', uniques: '12' },
      { date: '2026-08-24', count: '51', uniques: '15' },
    ]);
  });

  it('does not invent a row for today when the window ends yesterday', async () => {
    const store = createStore(dir);
    await collect({ client: fakeClient(), store, ...base });
    const dates = store.readCsv('traffic/views.csv').map((r) => r.date);
    expect(dates).not.toContain('2026-08-25');
  });

  it('tags dimensional snapshots with today', async () => {
    const store = createStore(dir);
    await collect({ client: fakeClient(), store, ...base });
    const rows = store.readNdjson('traffic/referrers.ndjson');
    expect(rows).toEqual([
      {
        snapshot_date: '2026-08-25',
        dimension: 'news.ycombinator.com',
        title: '',
        count: 118,
        uniques: 94,
      },
    ]);
  });

  it('writes stars and forks from the repo object counters, dated today', async () => {
    const store = createStore(dir);
    await collect({ client: fakeClient(), store, ...base });
    expect(store.readCsv('stars.csv')).toEqual([{ date: '2026-08-25', total: '56' }]);
    expect(store.readCsv('forks.csv')).toEqual([{ date: '2026-08-25', total: '3' }]);
  });

  it('sums every asset download count into repo.csv', async () => {
    const store = createStore(dir);
    await collect({ client: fakeClient(), store, ...base });
    expect(store.readCsv('repo.csv')).toEqual([
      {
        date: '2026-08-25',
        subscribers: '1',
        open_issues: '13',
        downloads_total: '37',
      },
    ]);
  });

  it('records release publish dates for the growth-chart annotations', async () => {
    const store = createStore(dir);
    await collect({ client: fakeClient(), store, ...base });
    expect(store.readCsv('releases.csv')).toEqual([
      { date: '2026-08-01', tag: 'v1.0.0', name: 'Backspace 1.0.0' },
    ]);
  });

  it('aborts the entire write when a required traffic fetch fails', async () => {
    const store = createStore(dir);
    const client = fakeClient({ '/repos/o/r/traffic/clones': new Error('boom') });
    await expect(collect({ client, store, ...base })).rejects.toThrow('boom');
    expect(store.readCsv('traffic/views.csv')).toEqual([]);
    expect(store.readCsv('stars.csv')).toEqual([]);
    expect(store.readMeta()).toBeNull();
  });

  it('skips contributors on a persistent 202 without writing a zero', async () => {
    const store = createStore(dir);
    const client = fakeClient({ '/repos/o/r/stats/contributors': null });
    const result = await collect({ client, store, ...base });
    expect(store.readCsv('contributors.csv')).toEqual([]);
    expect(result.skipped).toContain('contributors.csv');
    expect(store.readCsv('traffic/views.csv')).not.toEqual([]);
  });

  it('preserves a previous contributor value when the stats endpoint is computing', async () => {
    const store = createStore(dir);
    store.writeCsv('contributors.csv', ['date', 'total'], [{ date: '2026-08-24', total: 4 }]);
    const client = fakeClient({ '/repos/o/r/stats/contributors': null });
    await collect({ client, store, ...base });
    expect(store.readCsv('contributors.csv')).toEqual([{ date: '2026-08-24', total: '4' }]);
  });

  it('skips releases without aborting when that optional fetch fails', async () => {
    const store = createStore(dir);
    const client = fakeClient({ '/repos/o/r/releases': new Error('502') });
    const result = await collect({ client, store, ...base });
    expect(result.skipped).toContain('releases.csv');
    expect(store.readCsv('traffic/views.csv')).not.toEqual([]);
  });

  it('is idempotent: a second run over the same data changes nothing', async () => {
    const store = createStore(dir);
    await collect({ client: fakeClient(), store, ...base });
    const first = store.readCsv('traffic/views.csv');
    await collect({ client: fakeClient(), store, ...base });
    expect(store.readCsv('traffic/views.csv')).toEqual(first);
  });

  it('merges a new window over existing history without duplicating dates', async () => {
    const store = createStore(dir);
    store.writeCsv(
      'traffic/views.csv',
      ['date', 'count', 'uniques'],
      [
        { date: '2026-08-01', count: 5, uniques: 2 },
        { date: '2026-08-23', count: 1, uniques: 1 },
      ],
    );
    await collect({ client: fakeClient(), store, ...base });
    const rows = store.readCsv('traffic/views.csv');
    expect(rows.map((r) => r.date)).toEqual(['2026-08-01', '2026-08-23', '2026-08-24']);
    expect(rows[1]?.count).toBe('40');
  });

  it('writes meta.json with last_success and per-file high-water marks', async () => {
    const store = createStore(dir);
    await collect({ client: fakeClient(), store, ...base });
    const meta = store.readMeta();
    expect(meta?.last_run).toBe('2026-08-25T03:00:41Z');
    expect(meta?.last_success).toBe('2026-08-25T03:00:41Z');
    expect(meta?.error).toBeNull();
    expect(meta?.series_last_date['traffic/views.csv']).toBe('2026-08-24');
    expect(meta?.series_last_date['stars.csv']).toBe('2026-08-25');
  });

  // --- Beyond the brief's given cases: repo.csv bundles a required-fetch
  // field (subscribers/open_issues, from the repo object) with an
  // optional-fetch field (downloads_total, from releases) into one row. The
  // naive `releases === null ? 0 : sum(...)` collapse writes a permanent lie
  // — a zero for a download count GitHub simply never returned this run —
  // into a file that otherwise only ever holds measured values. Carrying the
  // last known value forward is not a fix either: it writes yesterday's
  // measurement under today's date, an undetectable plateau indistinguishable
  // from a genuinely quiet week. These cases pin the corrected behavior: the
  // required fields are always written, and an unmeasured `downloads_total`
  // is left blank — never fabricated, never used as an excuse to discard
  // `subscribers`/`open_issues`, which were fetched successfully regardless
  // of what `releases` did.

  it('leaves downloads_total blank rather than carrying the previous value forward when releases fails', async () => {
    const store = createStore(dir);
    store.writeCsv(
      'repo.csv',
      ['date', 'subscribers', 'open_issues', 'downloads_total'],
      [{ date: '2026-08-24', subscribers: 1, open_issues: 10, downloads_total: 25 }],
    );
    const client = fakeClient({ '/repos/o/r/releases': new Error('502') });
    const result = await collect({ client, store, ...base });
    const rows = store.readCsv('repo.csv');
    expect(rows).toEqual([
      { date: '2026-08-24', subscribers: '1', open_issues: '10', downloads_total: '25' },
      { date: '2026-08-25', subscribers: '1', open_issues: '13', downloads_total: '' },
    ]);
    expect(rows[1]?.downloads_total).toBe('');
    expect(rows[1]?.subscribers).toBe('1');
    expect(rows[1]?.open_issues).toBe('13');
    expect(result.skipped).toContain('repo.csv:downloads_total');
    expect(result.written).toContain('repo.csv');
  });

  it('still writes repo.csv with real subscribers/open_issues when releases fails on the very first run', async () => {
    const store = createStore(dir);
    const client = fakeClient({ '/repos/o/r/releases': new Error('502') });
    const result = await collect({ client, store, ...base });
    expect(store.readCsv('repo.csv')).toEqual([
      { date: '2026-08-25', subscribers: '1', open_issues: '13', downloads_total: '' },
    ]);
    expect(result.skipped).toContain('repo.csv:downloads_total');
    expect(result.skipped).not.toContain('repo.csv');
    expect(result.written).toContain('repo.csv');
    expect(store.readCsv('stars.csv')).toEqual([{ date: '2026-08-25', total: '56' }]);
  });

  it('leaves a previously blank downloads_total untouched while the new day carries its real value', async () => {
    const store = createStore(dir);
    store.writeCsv(
      'repo.csv',
      ['date', 'subscribers', 'open_issues', 'downloads_total'],
      [{ date: '2026-08-24', subscribers: 1, open_issues: 10, downloads_total: '' }],
    );
    const result = await collect({ client: fakeClient(), store, ...base });
    expect(store.readCsv('repo.csv')).toEqual([
      { date: '2026-08-24', subscribers: '1', open_issues: '10', downloads_total: '' },
      { date: '2026-08-25', subscribers: '1', open_issues: '13', downloads_total: '37' },
    ]);
    expect(result.skipped).not.toContain('repo.csv:downloads_total');
  });

  it('computes a cumulative contributor count from each contributor first commit week', async () => {
    const store = createStore(dir);
    await collect({ client: fakeClient(), store, ...base });
    expect(store.readCsv('contributors.csv')).toEqual([
      { date: '2026-02-16', total: '1' },
      { date: '2026-02-23', total: '2' },
    ]);
  });

  it('skips contributors.csv without writing when no contributor has a positive-commit week', async () => {
    const store = createStore(dir);
    const client = fakeClient({
      '/repos/o/r/stats/contributors': [{ weeks: [{ w: 1771200000, c: 0 }] }],
    });
    const result = await collect({ client, store, ...base });
    expect(store.readCsv('contributors.csv')).toEqual([]);
    expect(result.skipped).toContain('contributors.csv');
  });
});
