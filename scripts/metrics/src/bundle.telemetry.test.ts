import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore, type Store } from './store.ts';
import { buildDashboardData, downsampleWeekly } from './bundle.ts';

/**
 * The telemetry half of the bundle contract, kept in its own file because it
 * reads four archive paths none of the other series touch and because the
 * publication threshold the page applies (`instances7d`) has no counterpart
 * anywhere else in `DashboardData`.
 *
 * Uses the real `createStore` against a temp directory rather than a fake, for
 * the reason `bundle.test.ts` does: the thing under test is how the reader
 * behaves against files the collector actually wrote, and a hand-built double
 * would let the reader and the archive layout drift apart without a test
 * noticing.
 */
let dir = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'metrics-telemetry-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The exact header `collect.ts` writes for `telemetry/network.csv`. */
const NETWORK_HEADER = [
  'date',
  'instances_1d',
  'instances_7d',
  'instances_30d',
  'users_registered',
  'users_active1d',
  'users_active7d',
  'users_active30d',
  'messages7d',
  'storage_mib',
  'voice_instances',
  'federation_instances',
] as const;

function store(): Store {
  return createStore(dir);
}

/** One network row with every gauge set to `value`, so a bucket pick is unambiguous. */
function flatRow(date: string, value: number): Record<string, string | number> {
  return {
    date,
    instances_1d: value,
    instances_7d: value,
    instances_30d: value,
    users_registered: value,
    users_active1d: value,
    users_active7d: value,
    users_active30d: value,
    messages7d: value,
    storage_mib: value,
    voice_instances: value,
    federation_instances: value,
  };
}

describe('telemetry block', () => {
  it('is empty when the archive has no telemetry files', () => {
    // The state of the live archive on the day this shipped. A thrown bundle
    // here would take the whole dashboard down for every repo that has not
    // collected a single ping yet.
    const data = buildDashboardData(store(), '2026-09-06T00:00:00Z');

    expect(data.telemetry.network.dates).toEqual([]);
    expect(data.telemetry.network.instances_7d).toEqual([]);
    expect(data.telemetry.instances7d).toBeNull();
    expect(data.telemetry.versions.latest).toEqual([]);
    expect(data.telemetry.countries.latest).toEqual([]);
    expect(data.telemetry.clients.latest).toEqual([]);
  });

  it('reads the network series and the latest instances_7d', () => {
    const s = store();
    s.writeCsv('telemetry/network.csv', NETWORK_HEADER, [
      {
        date: '2026-09-04',
        instances_1d: 2,
        instances_7d: 3,
        instances_30d: 3,
        users_registered: 12,
        users_active1d: 1,
        users_active7d: 4,
        users_active30d: 6,
        messages7d: 40,
        storage_mib: 9,
        voice_instances: 1,
        federation_instances: 0,
      },
      {
        date: '2026-09-05',
        instances_1d: 3,
        instances_7d: 11,
        instances_30d: 12,
        users_registered: 50,
        users_active1d: 3,
        users_active7d: 9,
        users_active30d: 20,
        messages7d: 90,
        storage_mib: 30,
        voice_instances: 4,
        federation_instances: 2,
      },
    ]);
    s.writeNdjson('telemetry/versions.ndjson', [
      { snapshot_date: '2026-09-05', dimension: '1.1.2', title: '', count: 11, uniques: 11 },
    ]);

    const data = buildDashboardData(s, '2026-09-06T00:00:00Z');

    expect(data.telemetry.network.dates).toEqual(['2026-09-04', '2026-09-05']);
    expect(data.telemetry.network.instances_7d).toEqual([3, 11]);
    expect(data.telemetry.network.users_registered).toEqual([12, 50]);
    // A measured zero on the last day of a gauge, which must not become null.
    expect(data.telemetry.network.federation_instances).toEqual([0, 2]);
    expect(data.telemetry.instances7d).toBe(11);
    expect(data.telemetry.versions.latest[0]).toMatchObject({ dimension: '1.1.2', count: 11 });
  });

  it('reports a blank gauge as not measured rather than as zero', () => {
    const s = store();
    s.writeCsv('telemetry/network.csv', NETWORK_HEADER, [
      { ...flatRow('2026-09-05', 4), storage_mib: '' },
    ]);

    const data = buildDashboardData(s, '2026-09-06T00:00:00Z');

    expect(data.telemetry.network.storage_mib).toEqual([null]);
    expect(data.telemetry.network.instances_7d).toEqual([4]);
  });

  it('carries a null last day through to instances7d rather than reaching back', () => {
    // `instances7d` is the LAST day's figure, not the last measured one: the
    // page uses it to decide whether ten instances reported in the last seven
    // days, and answering that with an older day's count would publish charts
    // on a threshold that is no longer met.
    const s = store();
    s.writeCsv('telemetry/network.csv', NETWORK_HEADER, [
      flatRow('2026-09-04', 11),
      { ...flatRow('2026-09-05', 11), instances_7d: '' },
    ]);

    expect(buildDashboardData(s, '2026-09-06T00:00:00Z').telemetry.instances7d).toBeNull();
  });

  it('downsamples the network series by keeping the last value of each week', () => {
    const s = store();
    const rows = Array.from({ length: 21 }, (_, i) =>
      flatRow(new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10), i),
    );
    s.writeCsv('telemetry/network.csv', NETWORK_HEADER, rows);

    const weekly = downsampleWeekly(buildDashboardData(s, '2026-09-22T00:00:00Z'));

    expect(weekly.downsampled).toBe(true);
    expect(weekly.telemetry.network.dates.length).toBeLessThan(21);
    // Never summed. Summing 0..20 would publish 210 instances where at most 20
    // were ever reporting, and it would look entirely plausible on a chart.
    expect(weekly.telemetry.network.instances_7d.at(-1)).toBe(20);
    expect(weekly.telemetry.network.users_registered.at(-1)).toBe(20);
    expect(weekly.telemetry.instances7d).toBe(20);
  });

  it('leaves the telemetry dimension series unbucketed and unshared', () => {
    const s = store();
    s.writeNdjson('telemetry/countries.ndjson', [
      { snapshot_date: '2026-09-04', dimension: 'DE', title: '', count: 4, uniques: 4 },
      { snapshot_date: '2026-09-05', dimension: 'DE', title: '', count: 6, uniques: 6 },
    ]);

    const daily = buildDashboardData(s, '2026-09-06T00:00:00Z');
    const weekly = downsampleWeekly(daily);

    expect(weekly.telemetry.countries.snapshots).toEqual(['2026-09-04', '2026-09-05']);
    expect(weekly.telemetry.countries.latest).not.toBe(daily.telemetry.countries.latest);
    expect(weekly.telemetry.countries.latest).toEqual(daily.telemetry.countries.latest);
  });

  it('yields a well-formed block with a null threshold when the files exist but hold no rows', () => {
    // The state between the collector's first telemetry-enabled run and the
    // first archived ping. The page reads `instances7d` and nothing else to
    // decide whether to draw, so this must be a clean null rather than an
    // absent field: `undefined < 10` is false, and a gate written against it
    // would publish charts over an empty fleet.
    const s = store();
    s.writeCsv('telemetry/network.csv', NETWORK_HEADER, []);
    s.writeNdjson('telemetry/versions.ndjson', []);

    const block = buildDashboardData(s, '2026-09-06T00:00:00Z').telemetry;

    expect(block.instances7d).toBeNull();
    expect(block.network.dates).toEqual([]);
    expect(block.versions.latest).toEqual([]);
    expect(block.versions.snapshots).toEqual([]);
  });

  it('keeps every network column aligned with its dates on both paths', () => {
    // `expand` in the page walks `dates` and reads each column at the same
    // index. A column one element short would shift a whole chart sideways
    // with nothing on the page to show it, which is the failure the page's
    // own validator exists to catch and this test exists to prevent.
    const s = store();
    const rows = Array.from({ length: 10 }, (_, i) =>
      flatRow(new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10), i),
    );
    s.writeCsv('telemetry/network.csv', NETWORK_HEADER, rows);

    const daily = buildDashboardData(s, '2026-09-11T00:00:00Z').telemetry.network;
    const weekly = downsampleWeekly(buildDashboardData(s, '2026-09-11T00:00:00Z')).telemetry.network;

    for (const series of [daily, weekly]) {
      for (const name of NETWORK_HEADER.slice(1)) {
        expect((series as unknown as Record<string, unknown[]>)[name]).toHaveLength(
          series.dates.length,
        );
      }
    }
  });

  it('keeps instances7d null on the weekly path when the last day did not measure it', () => {
    // The threshold is a claim about the trailing seven days. Recomputing it
    // from the bucketed series reached back up to six days for a value when
    // the final day was blank, which published charts off a bar that was last
    // cleared the previous week.
    //
    // 15 days, so the archive ends on 2026-09-15 and the final week bucket
    // holds a measured Monday as well as the blank final day. A run ending on
    // the Monday itself puts that day alone in its bucket, where a recompute
    // has nothing older to reach back to and cannot tell the two paths apart.
    const s = store();
    const rows = Array.from({ length: 15 }, (_, i) =>
      flatRow(new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10), 12),
    );
    rows[rows.length - 1] = { ...rows[rows.length - 1], instances_7d: '' };
    s.writeCsv('telemetry/network.csv', NETWORK_HEADER, rows);

    const daily = buildDashboardData(s, '2026-09-15T00:00:00Z');
    const weekly = downsampleWeekly(daily);

    expect(daily.telemetry.instances7d).toBeNull();
    expect(weekly.telemetry.instances7d).toBeNull();
  });

  it('keeps instances7d equal to the last published bucket when the last day measured it', () => {
    // 15 days again, and for the same reason: the final bucket has to hold
    // more than one day for this to say anything. A run ending on a Monday
    // leaves that day alone in its bucket, where every way of picking a
    // bucket's value agrees, so the assertion would hold against a
    // first-of-bucket pick just as readily as against the last-measured one.
    const s = store();
    const rows = Array.from({ length: 15 }, (_, i) =>
      flatRow(new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10), i),
    );
    s.writeCsv('telemetry/network.csv', NETWORK_HEADER, rows);

    const weekly = downsampleWeekly(buildDashboardData(s, '2026-09-15T00:00:00Z'));

    expect(weekly.telemetry.instances7d).toBe(14);
    expect(weekly.telemetry.network.instances_7d.at(-1)).toBe(14);
  });

  it('keeps instances7d null when a blank last day is alone in its week bucket', () => {
    // The other shape of the same answer. Here the archive ends on Monday
    // 2026-09-14, so the blank final day is the only day in the final bucket
    // and there is nothing older inside it to reach back to. Both paths
    // answer null, but for a structural reason the mid-week case cannot
    // reach, and the carried field has to hold in this shape too.
    const s = store();
    const rows = Array.from({ length: 14 }, (_, i) =>
      flatRow(new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10), 12),
    );
    rows[rows.length - 1] = { ...rows[rows.length - 1], instances_7d: '' };
    s.writeCsv('telemetry/network.csv', NETWORK_HEADER, rows);

    const daily = buildDashboardData(s, '2026-09-15T00:00:00Z');
    const weekly = downsampleWeekly(daily);

    expect(daily.telemetry.instances7d).toBeNull();
    expect(weekly.telemetry.instances7d).toBeNull();
    expect(weekly.telemetry.network.instances_7d.at(-1)).toBeNull();
  });

  it('orders each telemetry ranking by count descending with the dimension as tie-break', () => {
    // The page renders `latest` in array order and scales every bar against
    // the first row's count. An unordered `latest` would put a short bar at
    // the top and read as a ranking that is not one.
    const s = store();
    s.writeNdjson('telemetry/versions.ndjson', [
      { snapshot_date: '2026-09-05', dimension: '1.1.0', title: '', count: 4, uniques: 4 },
      { snapshot_date: '2026-09-05', dimension: 'other', title: '', count: 9, uniques: 9 },
      { snapshot_date: '2026-09-05', dimension: '1.1.2', title: '', count: 4, uniques: 4 },
    ]);

    const latest = buildDashboardData(s, '2026-09-06T00:00:00Z').telemetry.versions.latest;

    expect(latest.map((r) => r.dimension)).toEqual(['other', '1.1.0', '1.1.2']);
  });

  it('orders a hand-edited telemetry file the same way, from the bundler and not from the file', () => {
    // The test above writes through `writeNdjson`, which sorts on the way to
    // disk, so it holds even if the bundler never sorted at all. This one
    // writes the lines itself, in an order no writer here would produce, and
    // so measures the bundler's own ordering. A file can reach this state:
    // the archive is a git branch a person can edit, and the reader is
    // already written to tolerate rows a writer would not emit.
    const s = store();
    mkdirSync(path.join(dir, 'telemetry'), { recursive: true });
    writeFileSync(
      path.join(dir, 'telemetry', 'countries.ndjson'),
      [
        '{"snapshot_date":"2026-09-05","dimension":"US","title":"","count":4,"uniques":4}',
        '{"snapshot_date":"2026-09-05","dimension":"ZZ","title":"","count":9,"uniques":9}',
        '{"snapshot_date":"2026-09-05","dimension":"DE","title":"","count":4,"uniques":4}',
      ].join('\n') + '\n',
    );

    const latest = buildDashboardData(s, '2026-09-06T00:00:00Z').telemetry.countries.latest;

    expect(latest.map((r) => r.dimension)).toEqual(['ZZ', 'DE', 'US']);
  });
});
