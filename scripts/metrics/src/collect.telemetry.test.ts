import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from './store.ts';
import { collect } from './collect.ts';
import { createTelemetryFetcher } from './telemetry.ts';
import type { GitHubClient } from './github.ts';
import type { PingRow } from './telemetry.ts';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'metrics-collect-telemetry-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// The traffic side of the run is not what these tests are about, so the fake
// answers every required endpoint with the smallest well-formed payload and
// nothing else. Copied down from `collect.test.ts` rather than imported: that
// file exports nothing, and importing a test module for its fixtures would run
// its suite a second time.
function fakeClient(): GitHubClient {
  const routes: Record<string, unknown> = {
    '/repos/o/r/traffic/views': { views: [] },
    '/repos/o/r/traffic/clones': { clones: [] },
    '/repos/o/r/traffic/popular/referrers': [],
    '/repos/o/r/traffic/popular/paths': [],
    '/repos/o/r': {
      stargazers_count: 1,
      forks_count: 0,
      subscribers_count: 1,
      open_issues_count: 0,
    },
    '/repos/o/r/releases': [],
  };
  return {
    async get<T>(p: string): Promise<T> {
      const value = routes[p];
      if (value === undefined) throw new Error(`unexpected GET ${p}`);
      return value as T;
    },
    async getStats<T>(): Promise<T | null> {
      return null;
    },
    async paginate<T>(p: string): Promise<T[]> {
      const value = routes[p];
      if (value === undefined) throw new Error(`unexpected paginate ${p}`);
      return value as T[];
    },
    async paginateEnvelope<T>(): Promise<T[]> {
      return [] as T[];
    },
  };
}

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

const base = { slug: 'o/r', today: '2026-09-06', now: '2026-09-06T15:19:00Z' };

describe('collect with telemetry', () => {
  it('writes the four telemetry files for yesterday and the day before', async () => {
    const store = createStore(dir);
    const seen: Array<[string, string]> = [];
    // Three days per instance, not two: `aggregateTelemetry` counts only an
    // instance that reported on two distinct days at or before the day being
    // aggregated, so a fleet that started reporting yesterday is legitimately
    // empty in the day-before-yesterday snapshot.
    const telemetry = async (from: string, to: string): Promise<PingRow[]> => {
      seen.push([from, to]);
      return ['a', 'b', 'c'].flatMap((id) => [
        ping(id, '2026-09-03'),
        ping(id, '2026-09-04'),
        ping(id, '2026-09-05'),
      ]);
    };

    const result = await collect({ client: fakeClient(), store, ...base, telemetry });

    expect(seen).toEqual([['2026-08-06', '2026-09-05']]);
    expect(result.written).toEqual(
      expect.arrayContaining([
        'telemetry/network.csv',
        'telemetry/versions.ndjson',
        'telemetry/countries.ndjson',
        'telemetry/clients.ndjson',
      ]),
    );
    const network = store.readCsv('telemetry/network.csv');
    expect(network.map((r) => r.date)).toEqual(['2026-09-04', '2026-09-05']);
    expect(network[1]).toMatchObject({ instances_7d: '3', users_registered: '12' });
    expect(store.readNdjson('telemetry/versions.ndjson')).toEqual([
      { snapshot_date: '2026-09-04', dimension: '1.1.2', title: '', count: 3, uniques: 3 },
      { snapshot_date: '2026-09-05', dimension: '1.1.2', title: '', count: 3, uniques: 3 },
    ]);
    expect(store.readNdjson('telemetry/countries.ndjson')).toEqual([
      { snapshot_date: '2026-09-04', dimension: 'DE', title: '', count: 3, uniques: 3 },
      { snapshot_date: '2026-09-05', dimension: 'DE', title: '', count: 3, uniques: 3 },
    ]);
    expect(store.readMeta()?.series_last_date['telemetry/network.csv']).toBe('2026-09-05');
  });

  it('skips telemetry when no fetcher is given and records a skip when the fetch fails', async () => {
    const store = createStore(dir);
    let result = await collect({ client: fakeClient(), store, ...base });
    expect(result.written).not.toContain('telemetry/network.csv');

    result = await collect({
      client: fakeClient(),
      store,
      ...base,
      telemetry: async () => {
        throw new Error('401');
      },
    });
    expect(result.skipped.some((s) => s.includes('telemetry'))).toBe(true);
    expect(result.written).not.toContain('telemetry/network.csv');
    // The point of the skip: a failed fetch must leave the series alone rather
    // than upsert a well-formed all-zero snapshot over a real row.
    expect(store.readCsv('telemetry/network.csv')).toEqual([]);
  });

  it('leaves the traffic series intact when the telemetry fetch fails', async () => {
    const store = createStore(dir);
    const result = await collect({
      client: fakeClient(),
      store,
      ...base,
      telemetry: async () => {
        throw new Error('503');
      },
    });
    expect(result.written).toContain('stars.csv');
    expect(store.readCsv('stars.csv')).toEqual([{ date: '2026-09-06', total: '1' }]);
  });

  // End to end over the real fetcher rather than a throwing stub, because the
  // property under test is that a truncated export cannot reach the archive by
  // any path: the body parses, the rows are well formed, and the only thing
  // saying the window is short is a response header.
  it('publishes nothing when the receiver truncated the export', async () => {
    const store = createStore(dir);
    const lines = ['2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']
      .flatMap((day) => ['a', 'b', 'c'].map((id) => ping(id, day)))
      .map((row) => JSON.stringify({ ...row, receivedAt: 'x', body: JSON.stringify(row.body) }))
      .join('\n');
    const fetchFn = (async () =>
      new Response(lines + '\n', {
        status: 200,
        headers: { 'x-export-truncated': '1' },
      })) as typeof fetch;

    const result = await collect({
      client: fakeClient(),
      store,
      ...base,
      telemetry: createTelemetryFetcher(fetchFn, 'https://hello.test', 'tok'),
    });

    expect(result.written).not.toContain('telemetry/network.csv');
    expect(store.readCsv('telemetry/network.csv')).toEqual([]);
    expect(store.readNdjson('telemetry/versions.ndjson')).toEqual([]);
    expect(store.readNdjson('telemetry/countries.ndjson')).toEqual([]);
    expect(store.readNdjson('telemetry/clients.ndjson')).toEqual([]);
    // The run stays green, so the skip line is the only place an operator can
    // learn this happened. It has to say what it was.
    expect(result.skipped.some((s) => s.includes('truncated'))).toBe(true);
    expect(store.readMeta()?.series_last_date['telemetry/network.csv']).toBeUndefined();
    // The irreplaceable half of the run is unaffected.
    expect(result.written).toContain('stars.csv');
  });
});
