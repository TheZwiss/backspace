import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from './store.ts';
import { buildDashboardData } from './bundle.ts';
import type { DimensionRow } from './types.ts';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'metrics-bundle-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const GENERATED_AT = '2026-09-02T06:00:00.000Z';

/**
 * Writes exact file bytes, bypassing `formatCsv`.
 *
 * Several cases here are about bytes the formatter would never emit — a
 * trailing empty field, a truncated row, rows in the wrong order — so they
 * cannot be set up through `store.writeCsv` without the writer normalising
 * away the very thing under test.
 */
function writeRaw(file: string, text: string): void {
  const full = path.join(dir, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, text, 'utf8');
}

function build(): ReturnType<typeof buildDashboardData> {
  return buildDashboardData(createStore(dir), GENERATED_AT);
}

function writeMeta(): void {
  createStore(dir).writeMeta({
    last_run: '2026-09-02T05:00:00.000Z',
    last_success: '2026-09-02T05:00:00.000Z',
    error: null,
    series_last_date: { 'traffic/views.csv': '2026-09-01' },
  });
}

function dimensionRow(
  snapshot_date: string,
  dimension: string,
  count: number,
  uniques = 1,
): DimensionRow {
  return { snapshot_date, dimension, title: dimension, count, uniques };
}

describe('buildDashboardData — the not-measured distinction', () => {
  it('maps an empty downloads_total to null, never to zero', () => {
    writeRaw('repo.csv', 'date,subscribers,open_issues,downloads_total\n2026-09-01,1,18,\n');

    const data = build();

    expect(data.series.repo.downloads_total[0]).toBeNull();
    expect(data.series.repo.downloads_total[0]).not.toBe(0);
    // The measured fields on the same row must survive intact — the null is
    // about that one blank field, not about the row.
    expect(data.series.repo.subscribers[0]).toBe(1);
    expect(data.series.repo.open_issues[0]).toBe(18);
  });

  it('maps a whitespace-only field to null, never to zero', () => {
    // `Number('   ')` is 0, the same trap as `Number('')`.
    writeRaw('repo.csv', 'date,subscribers,open_issues,downloads_total\n2026-09-01,1,18,   \n');

    const data = build();

    expect(data.series.repo.downloads_total[0]).toBeNull();
    expect(data.series.repo.downloads_total[0]).not.toBe(0);
  });

  it('keeps a real zero as zero', () => {
    writeRaw('repo.csv', 'date,subscribers,open_issues,downloads_total\n2026-09-01,1,18,0\n');

    expect(build().series.repo.downloads_total[0]).toBe(0);
  });

  it('parses a populated downloads_total as a number', () => {
    writeRaw('repo.csv', 'date,subscribers,open_issues,downloads_total\n2026-09-01,1,18,4210\n');

    expect(build().series.repo.downloads_total[0]).toBe(4210);
  });

  it('maps an absent column to null for every row rather than to zero', () => {
    // A column added to the archive later did not exist for earlier days.
    writeRaw('repo.csv', 'date,subscribers,open_issues\n2026-09-01,1,18\n');

    const data = build();

    expect(data.series.repo.downloads_total).toEqual([null]);
    expect(data.series.repo.subscribers).toEqual([1]);
  });

  it('throws on a numeric field that is present but unparseable', () => {
    writeRaw('stars.csv', 'date,total\n2026-09-01,fifty\n');

    expect(() => build()).toThrow(/not a finite number/);
  });
});

describe('buildDashboardData — absent vs. corrupt files', () => {
  it('reports empty for an archive holding only meta.json', () => {
    writeMeta();

    const data = build();

    expect(data.empty).toBe(true);
    expect(data.collection_started).toBeNull();
    expect(data.series.views).toEqual({ dates: [], count: [], uniques: [] });
    expect(data.series.stars).toEqual({ dates: [], total: [] });
    expect(data.series.repo).toEqual({
      dates: [],
      subscribers: [],
      open_issues: [],
      downloads_total: [],
    });
    expect(data.releases).toEqual([]);
    expect(data.dimensions.referrers).toEqual({ snapshots: [], latest: [], trajectories: [] });
    expect(data.dimensions.paths).toEqual({ snapshots: [], latest: [], trajectories: [] });
  });

  it('reports empty for a wholly missing archive directory', () => {
    const data = buildDashboardData(createStore(path.join(dir, 'does-not-exist')), GENERATED_AT);

    expect(data.empty).toBe(true);
    expect(data.meta).toBeNull();
  });

  it('does not throw when releases.csv is absent', () => {
    writeRaw('stars.csv', 'date,total\n2026-09-01,56\n');

    expect(build().releases).toEqual([]);
  });

  it('is not empty once any one series holds a row', () => {
    writeRaw('stars.csv', 'date,total\n2026-09-01,56\n');

    expect(build().empty).toBe(false);
  });

  it('is not empty when only releases.csv holds rows', () => {
    // The page renders a release list, so there is something to show even
    // though no dated series has a point.
    writeRaw('releases.csv', 'date,tag,name\n2024-01-05,v0.1.0,First\n');

    const data = build();

    expect(data.empty).toBe(false);
    expect(data.releases).toEqual([{ date: '2024-01-05', tag: 'v0.1.0', name: 'First' }]);
  });

  it('is not empty when only a dimension file holds rows', () => {
    createStore(dir).writeNdjson('traffic/referrers.ndjson', [
      dimensionRow('2026-09-01', 'news.ycombinator.com', 118),
    ]);

    expect(build().empty).toBe(false);
  });

  it('propagates a parse error from a corrupt file rather than returning an empty series', () => {
    // A row with fewer fields than its own header can only be truncation.
    writeRaw('traffic/views.csv', 'date,count,uniques\n2026-09-01,40\n');

    expect(() => build()).toThrow(/row 1 has 2 fields/);
  });

  it('propagates a parse error from a corrupt dimension file', () => {
    writeRaw('traffic/paths.ndjson', '{"snapshot_date":"2026-09-01","dimension":"/x"}\n');

    expect(() => build()).toThrow(/parseNdjson/);
  });

  it('throws on a row whose date is blank rather than placing it on the axis', () => {
    writeRaw('traffic/views.csv', 'date,count,uniques\n,40,12\n');

    expect(() => build()).toThrow(/missing or empty "date"/);
  });
});

describe('buildDashboardData — meta projection', () => {
  it('projects exactly the three contract fields and drops series_last_date', () => {
    writeMeta();

    const data = build();

    expect(data.meta).toEqual({
      last_run: '2026-09-02T05:00:00.000Z',
      last_success: '2026-09-02T05:00:00.000Z',
      error: null,
    });
    // `series_last_date` is a collector resume cursor, not dashboard data.
    expect(data.meta).not.toHaveProperty('series_last_date');
  });

  it('carries a collector error through so the page can surface a stall', () => {
    createStore(dir).writeMeta({
      last_run: '2026-09-02T05:00:00.000Z',
      last_success: '2026-08-30T05:00:00.000Z',
      error: 'HTTP 502 from /repos/x/y/traffic/views',
      series_last_date: {},
    });

    expect(build().meta).toEqual({
      last_run: '2026-09-02T05:00:00.000Z',
      last_success: '2026-08-30T05:00:00.000Z',
      error: 'HTTP 502 from /repos/x/y/traffic/views',
    });
  });

  it('reports meta as null when meta.json is absent', () => {
    writeRaw('stars.csv', 'date,total\n2026-09-01,56\n');

    expect(build().meta).toBeNull();
  });
});

describe('buildDashboardData — dates', () => {
  it('takes collection_started from the earliest date across all series', () => {
    writeRaw('traffic/views.csv', 'date,count,uniques\n2026-08-20,40,12\n');
    writeRaw('stars.csv', 'date,total\n2026-07-04,50\n2026-08-20,56\n');
    writeRaw('forks.csv', 'date,total\n2026-08-25,3\n');

    expect(build().collection_started).toBe('2026-07-04');
  });

  it('ignores release dates when deriving collection_started', () => {
    // A release published long before the collector existed must not label
    // the dashboard "since" a date on which nothing was measured.
    writeRaw('releases.csv', 'date,tag,name\n2023-02-01,v0.1.0,Old\n');
    writeRaw('stars.csv', 'date,total\n2026-08-20,56\n');

    expect(build().collection_started).toBe('2026-08-20');
  });

  it('allows series to end on different dates', () => {
    writeRaw('traffic/views.csv', 'date,count,uniques\n2026-08-30,40,12\n2026-08-31,51,15\n');
    writeRaw('stars.csv', 'date,total\n2026-08-30,55\n2026-08-31,56\n2026-09-01,57\n');

    const data = build();

    expect(data.series.views.dates).toEqual(['2026-08-30', '2026-08-31']);
    expect(data.series.stars.dates).toEqual(['2026-08-30', '2026-08-31', '2026-09-01']);
    // Neither padded to the other's length, and no trailing null invented.
    expect(data.series.views.count).toEqual([40, 51]);
    expect(data.series.stars.total).toEqual([55, 56, 57]);
  });

  it('does not gap-fill a missing day inside a series', () => {
    writeRaw('traffic/views.csv', 'date,count,uniques\n2026-08-30,40,12\n2026-09-01,51,15\n');

    const data = build();

    expect(data.series.views.dates).toEqual(['2026-08-30', '2026-09-01']);
    expect(data.series.views.count).toEqual([40, 51]);
  });

  it('returns dates ascending even when the file is out of order', () => {
    writeRaw('stars.csv', 'date,total\n2026-09-01,57\n2026-08-30,55\n2026-08-31,56\n');

    const data = build();

    expect(data.series.stars.dates).toEqual(['2026-08-30', '2026-08-31', '2026-09-01']);
    expect(data.series.stars.total).toEqual([55, 56, 57]);
  });

  it('keeps count and uniques index-aligned with dates', () => {
    writeRaw('traffic/clones.csv', 'date,count,uniques\n2026-08-31,4,3\n2026-08-30,9,7\n');

    const data = build();

    expect(data.series.clones).toEqual({
      dates: ['2026-08-30', '2026-08-31'],
      count: [9, 4],
      uniques: [7, 3],
    });
  });
});

describe('buildDashboardData — releases', () => {
  it('orders releases by date then tag and keeps two published the same day', () => {
    writeRaw(
      'releases.csv',
      'date,tag,name\n2026-08-30,v1.1.0,Later\n2026-08-01,v1.0.0,First\n2026-08-30,v1.0.1,Patch\n',
    );

    expect(build().releases).toEqual([
      { date: '2026-08-01', tag: 'v1.0.0', name: 'First' },
      { date: '2026-08-30', tag: 'v1.0.1', name: 'Patch' },
      { date: '2026-08-30', tag: 'v1.1.0', name: 'Later' },
    ]);
  });

  it('accepts an unnamed release but rejects one without a tag', () => {
    writeRaw('releases.csv', 'date,tag,name\n2026-08-01,v1.0.0,\n');
    expect(build().releases).toEqual([{ date: '2026-08-01', tag: 'v1.0.0', name: '' }]);

    writeRaw('releases.csv', 'date,tag,name\n2026-08-01,,Nameless\n');
    expect(() => build()).toThrow(/missing or empty "tag"/);
  });
});

describe('buildDashboardData — dimensions', () => {
  it('ranks the latest snapshot count-descending', () => {
    createStore(dir).writeNdjson('traffic/referrers.ndjson', [
      dimensionRow('2026-08-31', 'old.example', 900),
      dimensionRow('2026-09-01', 'b.example', 50),
      dimensionRow('2026-09-01', 'a.example', 120),
    ]);

    const data = build();

    expect(data.dimensions.referrers.snapshots).toEqual(['2026-08-31', '2026-09-01']);
    expect(data.dimensions.referrers.latest.map((row) => row.dimension)).toEqual([
      'a.example',
      'b.example',
    ]);
    // Only the latest snapshot's rows — yesterday's leader is not in it.
    expect(data.dimensions.referrers.latest).toHaveLength(2);
  });

  it('differences trajectories and starts them with null', () => {
    createStore(dir).writeNdjson('traffic/referrers.ndjson', [
      dimensionRow('2026-08-31', 'a.example', 100),
      dimensionRow('2026-09-01', 'a.example', 130),
    ]);

    expect(build().dimensions.referrers.trajectories).toEqual([
      { dimension: 'a.example', delta: [null, 30] },
    ]);
  });

  it('renders a dimension missing from a snapshot as a break, not a zero', () => {
    createStore(dir).writeNdjson('traffic/paths.ndjson', [
      dimensionRow('2026-08-30', '/a', 100),
      dimensionRow('2026-08-31', '/other', 10),
      dimensionRow('2026-09-01', '/a', 160),
    ]);

    const trajectory = build().dimensions.paths.trajectories.find(
      (row) => row.dimension === '/a',
    );

    expect(trajectory).toBeDefined();
    // Index 1: the dimension is absent from that snapshot — outside the top
    // ten, not zero traffic.
    expect(trajectory?.delta[1]).toBeNull();
    expect(trajectory?.delta[1]).not.toBe(0);
    // Index 2: present again, but there is nothing to difference against.
    // Reaching back to index 0 would report a two-snapshot move as one step;
    // treating the gap as 0 would invent a jump of 160.
    expect(trajectory?.delta[2]).toBeNull();
    expect(trajectory?.delta[2]).not.toBe(0);
    expect(trajectory?.delta).toEqual([null, null, null]);
  });

  it('can report a negative delta when a dimension falls', () => {
    createStore(dir).writeNdjson('traffic/referrers.ndjson', [
      dimensionRow('2026-08-31', 'a.example', 130),
      dimensionRow('2026-09-01', 'a.example', 100),
    ]);

    expect(build().dimensions.referrers.trajectories[0]?.delta).toEqual([null, -30]);
  });

  it('limits trajectories to the top five of the latest snapshot', () => {
    const rows: DimensionRow[] = [];
    for (let rank = 0; rank < 8; rank++) {
      rows.push(dimensionRow('2026-08-31', `d${rank}.example`, 100 - rank));
      rows.push(dimensionRow('2026-09-01', `d${rank}.example`, 200 - rank));
    }
    createStore(dir).writeNdjson('traffic/referrers.ndjson', rows);

    const data = build();

    expect(data.dimensions.referrers.latest).toHaveLength(8);
    expect(data.dimensions.referrers.trajectories.map((row) => row.dimension)).toEqual([
      'd0.example',
      'd1.example',
      'd2.example',
      'd3.example',
      'd4.example',
    ]);
  });

  it('picks the top five by the latest snapshot, not by an earlier one', () => {
    const rows: DimensionRow[] = [];
    // `newcomer` does not exist yesterday and leads today; `faded` led
    // yesterday and is last today.
    for (let rank = 0; rank < 5; rank++) {
      rows.push(dimensionRow('2026-08-31', `d${rank}.example`, 50 - rank));
      rows.push(dimensionRow('2026-09-01', `d${rank}.example`, 50 - rank));
    }
    rows.push(dimensionRow('2026-08-31', 'faded.example', 900));
    rows.push(dimensionRow('2026-09-01', 'faded.example', 1));
    rows.push(dimensionRow('2026-09-01', 'newcomer.example', 999));
    createStore(dir).writeNdjson('traffic/referrers.ndjson', rows);

    const trajectories = build().dimensions.referrers.trajectories;

    expect(trajectories.map((row) => row.dimension)).toEqual([
      'newcomer.example',
      'd0.example',
      'd1.example',
      'd2.example',
      'd3.example',
    ]);
    // A dimension absent from the earlier snapshot still gets a null-led,
    // correctly-lengthed delta rather than being dropped.
    expect(trajectories[0]?.delta).toEqual([null, null]);
  });

  it('breaks a tie on count by dimension so the top five is deterministic', () => {
    createStore(dir).writeNdjson('traffic/referrers.ndjson', [
      dimensionRow('2026-09-01', 'b.example', 10),
      dimensionRow('2026-09-01', 'a.example', 10),
    ]);

    expect(build().dimensions.referrers.latest.map((row) => row.dimension)).toEqual([
      'a.example',
      'b.example',
    ]);
  });

  it('carries title and uniques through to the latest ranking', () => {
    createStore(dir).writeNdjson('traffic/paths.ndjson', [
      {
        snapshot_date: '2026-09-01',
        dimension: '/TheZwiss/backspace',
        title: 'Backspace',
        count: 402,
        uniques: 161,
      },
    ]);

    expect(build().dimensions.paths.latest).toEqual([
      { dimension: '/TheZwiss/backspace', title: 'Backspace', count: 402, uniques: 161 },
    ]);
  });

  it('keeps referrers and paths independent', () => {
    const store = createStore(dir);
    store.writeNdjson('traffic/referrers.ndjson', [dimensionRow('2026-09-01', 'a.example', 5)]);

    const data = build();

    expect(data.dimensions.referrers.latest).toHaveLength(1);
    expect(data.dimensions.paths).toEqual({ snapshots: [], latest: [], trajectories: [] });
  });
});

describe('buildDashboardData — purity and envelope', () => {
  it('passes generated_at through untouched and never reads the clock', () => {
    writeRaw('stars.csv', 'date,total\n2026-09-01,56\n');

    expect(build().generated_at).toBe(GENERATED_AT);
  });

  it('reports downsampled false — it never downsamples', () => {
    writeRaw('stars.csv', 'date,total\n2026-09-01,56\n');

    expect(build().downsampled).toBe(false);
  });

  it('returns the same object for the same archive on repeated calls', () => {
    writeRaw('traffic/views.csv', 'date,count,uniques\n2026-08-31,40,12\n');
    createStore(dir).writeNdjson('traffic/referrers.ndjson', [
      dimensionRow('2026-08-31', 'a.example', 5),
    ]);
    writeMeta();

    expect(build()).toEqual(build());
  });

  it('writes nothing to the archive', () => {
    writeRaw('stars.csv', 'date,total\n2026-09-01,56\n');
    build();

    // A read-only pass must not have created meta.json or any other file.
    expect(createStore(dir).readMeta()).toBeNull();
  });

  it('round-trips through JSON unchanged', () => {
    writeRaw('repo.csv', 'date,subscribers,open_issues,downloads_total\n2026-09-01,1,18,\n');
    writeRaw('releases.csv', 'date,tag,name\n2026-08-01,v1.0.0,First\n');
    createStore(dir).writeNdjson('traffic/paths.ndjson', [dimensionRow('2026-09-01', '/a', 5)]);

    const data = build();
    const roundTripped: unknown = JSON.parse(JSON.stringify(data));

    // `null` survives serialisation where `undefined` would silently vanish,
    // taking the not-measured marker with it.
    expect(roundTripped).toEqual(data);
    expect(JSON.stringify(data)).toContain('"downloads_total":[null]');
  });
});
