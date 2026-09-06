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
  // The receiver bounds build.version on arrival, but rows already stored by an
  // earlier receiver, or an export replayed from an older archive, can still
  // carry anything. Three instances agreeing on a string is enough to clear the
  // fold threshold, so the shape has to be checked here too: whatever is not a
  // release version is tallied as `other` and never named on the public branch.
  function fleetOn(ids: readonly string[], version: unknown): PingRow[] {
    return ids.flatMap((id) => [
      row(id, '2026-09-05', { build: { version } }),
      row(id, '2026-09-06', { build: { version } }),
    ]);
  }
  it('maps a version that is not release-shaped to other before tallying', () => {
    const rows = [...fleet('2026-09-05', '2026-09-06'), ...fleetOn(['x', 'y', 'z'], '<script>alert(1)</script>')];
    const agg = aggregateTelemetry(rows, '2026-09-06');
    expect(agg.versions).toEqual([
      { snapshot_date: '2026-09-06', dimension: '1.1.2', title: '', count: 5, uniques: 5 },
      { snapshot_date: '2026-09-06', dimension: 'other', title: '', count: 3, uniques: 3 },
    ]);
  });
  it('tallies a non-string, an absent and a wildly long version as other', () => {
    for (const version of [42, undefined, '1.'.repeat(40)]) {
      const agg = aggregateTelemetry(fleetOn(['x', 'y', 'z'], version), '2026-09-06');
      expect(agg.versions).toEqual([
        { snapshot_date: '2026-09-06', dimension: 'other', title: '', count: 3, uniques: 3 },
      ]);
    }
  });
  // Mapping an unrecognised version to `other` means the tally can hold an
  // `other` key before anything folds. One bucket, one row: two rows with the
  // same dimension would collide on the dimensional upsert.
  it('writes a single other row when a mapped value and a folded value meet', () => {
    const rows = [
      ...fleet('2026-09-05', '2026-09-06'),
      ...fleetOn(['x', 'y', 'z'], 'not a version'),
      ...fleetOn(['w'], '9.9.9'),
    ];
    const agg = aggregateTelemetry(rows, '2026-09-06');
    expect(agg.versions.filter((r) => r.dimension === 'other')).toEqual([
      { snapshot_date: '2026-09-06', dimension: 'other', title: '', count: 4, uniques: 4 },
    ]);
    expect(agg.versions.at(-1)?.dimension).toBe('other');
  });
  it('keeps a release and a pre-release version under their own names', () => {
    const rows = [...fleet('2026-09-05', '2026-09-06'), ...fleetOn(['p', 'q', 'r'], '1.2.0-rc.1')];
    const agg = aggregateTelemetry(rows, '2026-09-06');
    expect(agg.versions.find((r) => r.dimension === '1.1.2')?.count).toBe(5);
    expect(agg.versions.find((r) => r.dimension === '1.2.0-rc.1')?.count).toBe(3);
    expect(agg.versions.find((r) => r.dimension === 'other')).toBeUndefined();
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
  it('throws when every line was rejected, rather than reporting an empty day', async () => {
    const fetchFn = (async () => new Response('not json\n{"instance":"a"}\n', { status: 200 })) as typeof fetch;
    await expect(createTelemetryFetcher(fetchFn, 'https://hello.test', 'tok')('2026-09-01', '2026-09-06')).rejects.toThrow(/2 malformed/);
  });
  it('resolves to no rows when the export is genuinely empty', async () => {
    const fetchFn = (async () => new Response('', { status: 200 })) as typeof fetch;
    await expect(createTelemetryFetcher(fetchFn, 'https://hello.test', 'tok')('2026-09-01', '2026-09-06')).resolves.toEqual([]);
  });
});
