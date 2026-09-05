import { describe, it, expect } from 'vitest';
import { parseExportNdjson, aggregateTelemetry, createTelemetryFetcher, type PingRow } from './telemetry.ts';

function row(instance: string, day: string, over: Partial<PingRow['body']> = {}, country = 'DE'): PingRow {
  return {
    instance, day, country, schema: 1,
    body: {
      build: { version: '1.1.2' },
      users: { registered: 10, active1d: 2, active7d: 5, active30d: 8 },
      clients: { web: 3, desktop: 2, mobile: 0 },
      content: { messages7d: 100, storageMiB: 50 },
      features: { voice: true, federation: false },
      ...over,
    },
  };
}

// Five instances reporting on two days each, so every dimension clears the fold threshold.
function fleet(day2: string, day1: string): PingRow[] {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  return ids.flatMap((id) => [row(id, day1), row(id, day2)]);
}

describe('parseExportNdjson', () => {
  it('parses lines and skips malformed ones', () => {
    const line = JSON.stringify({ instance: 'a', day: '2026-09-06', receivedAt: 'x', country: 'DE', schema: 1, body: JSON.stringify({ users: { registered: 3 } }) });
    const out = parseExportNdjson(`${line}\nnot json\n\n`);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ instance: 'a', day: '2026-09-06', country: 'DE', body: { users: { registered: 3 } } });
    expect(out.skipped).toBe(1);
  });
});

describe('aggregateTelemetry', () => {
  it('sums the snapshot over instances seen on two days and counts instances by window', () => {
    const rows = [...fleet('2026-09-05', '2026-09-06'), row('once', '2026-09-06')];
    const agg = aggregateTelemetry(rows, '2026-09-06');
    expect(agg.network).toEqual({
      date: '2026-09-06', instances_1d: 5, instances_7d: 5, instances_30d: 5,
      users_registered: 50, users_active1d: 10, users_active7d: 25, users_active30d: 40,
      messages7d: 500, storage_mib: 250, voice_instances: 5, federation_instances: 0,
    });
  });
  it('uses the latest row per instance inside the 7-day window and active1d only from the day itself', () => {
    const rows = [row('a', '2026-09-01'), row('a', '2026-09-03', { users: { registered: 20, active1d: 9, active7d: 9, active30d: 9 } })];
    const agg = aggregateTelemetry(rows, '2026-09-06');
    expect(agg.network.instances_1d).toBe(0);
    expect(agg.network.instances_7d).toBe(1);
    expect(agg.network.users_registered).toBe(20);
    expect(agg.network.users_active1d).toBe(0);
  });
  it('drops instances outside the 7-day window from sums but keeps them in instances_30d', () => {
    const rows = [row('a', '2026-08-20'), row('a', '2026-08-21')];
    const agg = aggregateTelemetry(rows, '2026-09-06');
    expect(agg.network.instances_7d).toBe(0);
    expect(agg.network.instances_30d).toBe(1);
    expect(agg.network.users_registered).toBe(0);
  });
  it('folds dimension values held by fewer than three instances into other', () => {
    const rows = [...fleet('2026-09-05', '2026-09-06'), row('x', '2026-09-05', { build: { version: '9.9.9' } }, 'LI'), row('x', '2026-09-06', { build: { version: '9.9.9' } }, 'LI')];
    const agg = aggregateTelemetry(rows, '2026-09-06');
    expect(agg.versions).toEqual([
      { snapshot_date: '2026-09-06', dimension: '1.1.2', title: '', count: 5, uniques: 5 },
      { snapshot_date: '2026-09-06', dimension: 'other', title: '', count: 1, uniques: 1 },
    ]);
    expect(agg.countries.find((r) => r.dimension === 'LI')).toBeUndefined();
    expect(agg.countries.find((r) => r.dimension === 'other')?.count).toBe(1);
  });
  it('reports client kinds as user sums and caps absurd values', () => {
    const rows = [...fleet('2026-09-05', '2026-09-06'), row('z', '2026-09-05', { users: { registered: 1e15 } }), row('z', '2026-09-06', { users: { registered: 1e15 } })];
    const agg = aggregateTelemetry(rows, '2026-09-06');
    // `over` replaces only the `users` group, so instance z keeps the default
    // two desktop users: six snapshot instances at two each is 12.
    expect(agg.clients.find((r) => r.dimension === 'desktop')?.count).toBe(12);
    expect(agg.network.users_registered).toBe(50 + 1_000_000_000);
  });
});

describe('createTelemetryFetcher', () => {
  it('calls the export route with the bearer token and parses the answer', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init]);
      return new Response(JSON.stringify({ instance: 'a', day: '2026-09-06', receivedAt: 'x', country: 'DE', schema: 1, body: '{}' }) + '\n', { status: 200 });
    }) as typeof fetch;
    const rows = await createTelemetryFetcher(fetchFn, 'https://hello.test', 'tok')('2026-09-01', '2026-09-06');
    expect(rows).toHaveLength(1);
    expect(calls[0]![0]).toBe('https://hello.test/v1/export?from=2026-09-01&to=2026-09-06');
    expect((calls[0]![1]?.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });
  it('throws on a non-200 answer', async () => {
    const fetchFn = (async () => new Response(null, { status: 401 })) as typeof fetch;
    await expect(createTelemetryFetcher(fetchFn, 'https://hello.test', 'tok')('2026-09-01', '2026-09-06')).rejects.toThrow(/401/);
  });
});
