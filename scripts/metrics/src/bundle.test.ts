import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from './store.ts';
import {
  buildDashboardData,
  downsampleWeekly,
  serialiseWithinBudget,
  budgetWarning,
  BUNDLE_BUDGET_BYTES,
  BUNDLE_WARN_BYTES,
  BUNDLE_WARN_FRACTION,
} from './bundle.ts';
import type { DashboardData } from './bundle.ts';
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

/**
 * Every file in the archive as `[relative path, exact bytes]`, sorted.
 *
 * Used to assert that a read-only pass leaves the tree untouched. Comparing
 * the whole tree rather than probing one file also catches a stray temp
 * artifact from the store's atomic write, which a targeted check would miss.
 */
function snapshotTree(): Array<[string, string]> {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry): [string, string] => {
      const full = path.join(entry.parentPath, entry.name);
      return [path.relative(dir, full), readFileSync(full, 'utf8')];
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/**
 * Every location in the tree holding `undefined`, as a path string.
 *
 * `JSON.stringify` deletes such a key outright, and `toEqual` treats an
 * `undefined`-valued key as equal to an absent one — so without this an
 * accidental `undefined` where a `null` belongs would survive both the
 * round-trip assertion and the deep-equality one, and reach the page as a
 * missing field.
 */
function undefinedPaths(value: unknown, at = '$'): string[] {
  if (value === undefined) return [at];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => undefinedPaths(item, `${at}[${index}]`));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => undefinedPaths(item, `${at}.${key}`));
  }
  return [];
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

  it('maps a pre-split repo row to null for the download split, never to zero', () => {
    // Exactly the shape on disk for every row written before the split
    // columns existed: the field is ABSENT from the header, not merely blank.
    writeRaw('repo.csv', 'date,subscribers,open_issues,downloads_total\n2026-09-01,1,18,1802\n');
    const data = build();
    expect(data.series.repo.downloads_total).toEqual([1802]);
    expect(data.series.repo.downloads_app).toEqual([null]);
    expect(data.series.repo.downloads_updates).toEqual([null]);
    expect(data.series.repo.downloads_app[0]).not.toBe(0);
    expect(data.series.repo.downloads_updates[0]).not.toBe(0);
  });

  it('parses a populated download split and keeps a measured zero at zero', () => {
    writeRaw(
      'repo.csv',
      'date,subscribers,open_issues,downloads_total,downloads_app,downloads_updates\n' +
        '2026-09-03,1,18,323,323,0\n',
    );
    const data = build();
    expect(data.series.repo.downloads_app).toEqual([323]);
    // A release with no update feed yet genuinely has zero update traffic.
    // That is a measurement, and must not be flattened into a break.
    expect(data.series.repo.downloads_updates).toEqual([0]);
    expect(data.series.repo.downloads_updates[0]).not.toBeNull();
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

describe('buildDashboardData — every file reaches its own series', () => {
  it('routes every archive file to its own series slot', () => {
    // Each file carries a value found in no other file, so a path constant
    // pointing at the wrong file — or at a file that does not exist —
    // surfaces as a wrong or empty series instead of passing unnoticed. A
    // series read from a mistyped path renders as an honest "not measured"
    // forever, which is the one failure this package cannot afford to ship
    // silently.
    writeRaw('traffic/views.csv', 'date,count,uniques\n2026-09-01,11,1\n');
    writeRaw('traffic/clones.csv', 'date,count,uniques\n2026-09-01,22,2\n');
    writeRaw('stars.csv', 'date,total\n2026-09-01,33\n');
    writeRaw('forks.csv', 'date,total\n2026-09-01,44\n');
    writeRaw('contributors.csv', 'date,total\n2026-09-01,55\n');
    writeRaw('repo.csv', 'date,subscribers,open_issues,downloads_total\n2026-09-01,66,77,88\n');

    const data = build();

    expect(data.series.views.count).toEqual([11]);
    expect(data.series.views.uniques).toEqual([1]);
    expect(data.series.clones.count).toEqual([22]);
    expect(data.series.clones.uniques).toEqual([2]);
    expect(data.series.stars.total).toEqual([33]);
    expect(data.series.forks.total).toEqual([44]);
    expect(data.series.contributors.total).toEqual([55]);
    expect(data.series.repo.subscribers).toEqual([66]);
    expect(data.series.repo.open_issues).toEqual([77]);
    expect(data.series.repo.downloads_total).toEqual([88]);
  });

  it('reads contributors.csv into the contributors series', () => {
    writeRaw('contributors.csv', 'date,total\n2026-08-25,7\n2026-09-01,9\n');

    const data = build();

    expect(data.series.contributors).toEqual({
      dates: ['2026-08-25', '2026-09-01'],
      total: [7, 9],
    });
    expect(data.collection_started).toBe('2026-08-25');
    expect(data.empty).toBe(false);
  });

  it('reads forks.csv into the forks series', () => {
    writeRaw('forks.csv', 'date,total\n2026-08-25,2\n2026-09-01,3\n');

    const data = build();

    expect(data.series.forks).toEqual({ dates: ['2026-08-25', '2026-09-01'], total: [2, 3] });
    expect(data.empty).toBe(false);
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
      downloads_app: [],
      downloads_updates: [],
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

  it('throws on a blank snapshot_date rather than inventing a phantom snapshot', () => {
    // The same corruption as a blank CSV date and the same treatment, with a
    // sharper consequence: the empty string sorts before every real date, so
    // accepting it would prepend a snapshot that never happened and shift
    // every trajectory index by one.
    writeRaw(
      'traffic/referrers.ndjson',
      '{"snapshot_date":"","dimension":"a.example","title":"a","count":5,"uniques":1}\n',
    );

    expect(() => build()).toThrow(/empty "snapshot_date"/);
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
    // And nothing leaks into the file that was never written.
    expect(data.dimensions.paths).toEqual({ snapshots: [], latest: [], trajectories: [] });
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

  it('reports an unchanged dimension as a measured zero, never as a break', () => {
    createStore(dir).writeNdjson('traffic/referrers.ndjson', [
      dimensionRow('2026-08-31', 'a.example', 100),
      dimensionRow('2026-09-01', 'a.example', 100),
    ]);

    const delta = build().dimensions.referrers.trajectories[0]?.delta;

    // The mirror image of null-never-zero. A count that did not move is a
    // measurement of no change, not an absence, and a falsy check in place
    // of `=== undefined` would fabricate a break out of it.
    expect(delta).toEqual([null, 0]);
    expect(delta?.[1]).toBe(0);
    expect(delta?.[1]).not.toBeNull();
  });

  it('differences against a measured zero rather than treating it as absent', () => {
    // `previous` is 0 here — falsy, present, and real. This is the case that
    // separates `=== undefined` from `!previous` outright.
    createStore(dir).writeNdjson('traffic/referrers.ndjson', [
      dimensionRow('2026-08-31', 'a.example', 0),
      dimensionRow('2026-09-01', 'a.example', 7),
    ]);

    const delta = build().dimensions.referrers.trajectories[0]?.delta;

    expect(delta).toEqual([null, 7]);
    expect(delta?.[1]).not.toBeNull();
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
    store.writeNdjson('traffic/paths.ndjson', [dimensionRow('2026-09-01', '/a', 9)]);

    const data = build();

    // Distinct counts crosswise: a swapped or mistyped pair of path
    // constants shows up as the wrong numbers rather than as two
    // plausible-looking series.
    expect(data.dimensions.referrers.latest).toEqual([
      { dimension: 'a.example', title: 'a.example', count: 5, uniques: 1 },
    ]);
    expect(data.dimensions.paths.latest).toEqual([
      { dimension: '/a', title: '/a', count: 9, uniques: 1 },
    ]);
  });
});

describe('buildDashboardData — purity and envelope', () => {
  it('passes generated_at through untouched and never reads the clock', () => {
    writeRaw('stars.csv', 'date,total\n2026-09-01,56\n');
    writeRaw('repo.csv', 'date,subscribers,open_issues,downloads_total\n2026-09-01,1,18,\n');
    const store = createStore(dir);

    // A value no clock could ever produce. If the function derived the
    // timestamp itself — or validated it, or normalised it — this could not
    // come back out unchanged.
    const marker = 'not-a-timestamp-at-all';
    const marked = buildDashboardData(store, marker);
    expect(marked.generated_at).toBe(marker);

    // And `generated_at` is the ONLY field the argument can reach: swap it
    // for a wildly different timestamp and every other field is identical,
    // so nothing downstream is silently derived from "now" — no "days since"
    // count, no stale flag, no date filter.
    const other = buildDashboardData(store, '1999-01-01T00:00:00.000Z');
    expect(other.generated_at).toBe('1999-01-01T00:00:00.000Z');
    expect({ ...other, generated_at: marker }).toEqual(marked);
  });

  it('reports downsampled false, and a bundle under budget keeps it false', () => {
    writeRaw('stars.csv', 'date,total\n2026-09-01,56\n');

    // `buildDashboardData` itself never downsamples: the budget pass owns
    // that flag entirely.
    const data = build();
    expect(data.downsampled).toBe(false);

    // And a bundle that fits the budget is published exactly as built — the
    // flag only turns true when weekly bucketing actually happened, so the
    // page's "weekly buckets" label can never appear over daily data.
    expect(serialiseWithinBudget(data).downsampled).toBe(false);
  });

  it('returns byte-identical output for the same archive on repeated calls', () => {
    writeRaw('traffic/views.csv', 'date,count,uniques\n2026-08-31,40,12\n');
    writeRaw('releases.csv', 'date,tag,name\n2026-08-30,v1.0.1,Patch\n2026-08-30,v1.0.0,First\n');
    createStore(dir).writeNdjson('traffic/referrers.ndjson', [
      dimensionRow('2026-08-30', 'a.example', 5),
      dimensionRow('2026-08-30', 'b.example', 5),
      dimensionRow('2026-08-31', 'b.example', 9),
      dimensionRow('2026-08-31', 'a.example', 9),
    ]);
    writeMeta();

    const first = build();
    const second = build();

    expect(second).toEqual(first);
    // Byte equality, not just deep equality. This is what the published
    // artefact actually is, and it pins key order and array order too — so a
    // ranking that fell back on Map-iteration or file order, which deep
    // equality forgives when the values happen to match, fails here. The
    // fixture is built to make that reachable: two releases on one date and
    // two referrers tied on count, both written in a different order than
    // they must come out in.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('writes nothing to the archive', () => {
    writeRaw('stars.csv', 'date,total\n2026-09-01,56\n');
    writeRaw('traffic/views.csv', 'date,count,uniques\n2026-09-01,40,12\n');
    createStore(dir).writeNdjson('traffic/referrers.ndjson', [
      dimensionRow('2026-09-01', 'a.example', 5),
    ]);
    writeMeta();
    const before = snapshotTree();
    expect(before.length).toBe(4);

    build();

    // Every file in the tree, path and bytes. Not "meta.json is still
    // absent": that would pass while the pass rewrote, truncated, or
    // reordered a series file, or left a `.tmp-` artifact from the store's
    // atomic write sitting in the archive that gets committed to the data
    // branch.
    expect(snapshotTree()).toEqual(before);
  });

  it('round-trips through JSON unchanged', () => {
    writeRaw('repo.csv', 'date,subscribers,open_issues,downloads_total\n2026-09-01,1,18,\n');
    writeRaw('releases.csv', 'date,tag,name\n2026-08-01,v1.0.0,First\n');
    createStore(dir).writeNdjson('traffic/paths.ndjson', [dimensionRow('2026-09-01', '/a', 5)]);
    // meta.json included so the check covers the whole envelope: without it
    // `meta` is null and an `undefined` leaking out of the projection would
    // never be reached by this test.
    writeMeta();

    const data = build();
    const roundTripped: unknown = JSON.parse(JSON.stringify(data));

    // `toStrictEqual`, not `toEqual`: `toEqual` treats a key whose value is
    // `undefined` as equal to that key being absent, which is exactly the
    // difference `JSON.stringify` erases — so the weaker matcher would pass
    // on the one defect this test exists to catch.
    expect(roundTripped).toStrictEqual(data);
    // And nothing in the tree is `undefined` in the first place. A
    // not-measured marker must be an explicit `null` that reaches the page,
    // not a field that quietly disappears in transit.
    expect(undefinedPaths(data)).toEqual([]);
    expect(JSON.stringify(data)).toContain('"downloads_total":[null]');
  });
});

// ---------------------------------------------------------------------------
// Weekly downsampling and the 2 MB budget
// ---------------------------------------------------------------------------

/**
 * A complete, valid `DashboardData` with every series empty, plus overrides.
 *
 * The budget cases need bundles far larger than any archive a test should
 * write to disk (over 2 MB of CSV), and the envelope cases are about fields
 * no archive controls, so both are better built as objects than read back
 * out of a store. Every field of the contract is spelled out here on
 * purpose: if `DashboardData` grows one, this helper fails to compile rather
 * than quietly omitting it from every budget test.
 */
function makeData(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    generated_at: GENERATED_AT,
    collection_started: null,
    meta: null,
    empty: false,
    downsampled: false,
    series: {
      views: { dates: [], count: [], uniques: [] },
      clones: { dates: [], count: [], uniques: [] },
      stars: { dates: [], total: [] },
      forks: { dates: [], total: [] },
      contributors: { dates: [], total: [] },
      repo: {
        dates: [],
        subscribers: [],
        open_issues: [],
        downloads_total: [],
        downloads_app: [],
        downloads_updates: [],
      },
    },
    releases: [],
    dimensions: {
      referrers: { snapshots: [], latest: [], trajectories: [] },
      paths: { snapshots: [], latest: [], trajectories: [] },
    },
    ...overrides,
  };
}

/** `count` consecutive UTC calendar days starting at `start`, as `YYYY-MM-DD`. */
function dailyDates(start: string, count: number): string[] {
  const base = Date.parse(`${start}T00:00:00.000Z`);
  return Array.from({ length: count }, (_unused, index) =>
    new Date(base + index * 86_400_000).toISOString().slice(0, 10),
  );
}

describe('downsampleWeekly — sum vs. last', () => {
  it('sums traffic but takes the last value of a cumulative counter when bucketing', () => {
    // One whole ISO week: Monday 2026-08-31 through Sunday 2026-09-06.
    writeRaw(
      'traffic/views.csv',
      [
        'date,count,uniques',
        '2026-08-31,1,1',
        '2026-09-01,2,1',
        '2026-09-02,3,1',
        '2026-09-03,4,1',
        '2026-09-04,5,1',
        '2026-09-05,6,1',
        '2026-09-06,7,1',
        '',
      ].join('\n'),
    );
    writeRaw(
      'stars.csv',
      [
        'date,total',
        '2026-08-31,60',
        '2026-09-01,61',
        '2026-09-02,62',
        '2026-09-03,63',
        '2026-09-04,64',
        '2026-09-05,65',
        '2026-09-06,66',
        '',
      ].join('\n'),
    );

    const weekly = downsampleWeekly(build());

    // Views are per-day event counts: a week is their sum.
    expect(weekly.series.views).toEqual({
      dates: ['2026-08-31'],
      count: [28],
      uniques: [7],
    });
    // Stars are a point-in-time total: a week is its last value. Summing
    // them would report 441 stars for a repo that has 66, and the chart
    // would look entirely plausible.
    expect(weekly.series.stars).toEqual({ dates: ['2026-08-31'], total: [66] });
    expect(weekly.series.stars.total[0]).not.toBe(441);
  });

  it('takes the last value of every repo counter rather than summing any of them', () => {
    writeRaw(
      'repo.csv',
      [
        'date,subscribers,open_issues,downloads_total',
        '2026-08-31,10,20,300',
        '2026-09-01,11,21,310',
        '2026-09-02,12,22,320',
        '',
      ].join('\n'),
    );

    expect(downsampleWeekly(build()).series.repo).toEqual({
      dates: ['2026-08-31'],
      subscribers: [12],
      open_issues: [22],
      downloads_total: [320],
      // Absent from this pre-split fixture, so the weekly bucket carries the
      // same "not measured" it was given, never a zero.
      downloads_app: [null],
      downloads_updates: [null],
    });
  });

  it('sums clones and takes the last value of forks and contributors', () => {
    // Each of the six series is bucketed by its own rule; this pins the
    // three not covered above so a mis-wired call site cannot hide behind a
    // series that happens to be tested elsewhere.
    writeRaw(
      'traffic/clones.csv',
      ['date,count,uniques', '2026-08-31,4,2', '2026-09-01,5,3', ''].join('\n'),
    );
    writeRaw('forks.csv', ['date,total', '2026-08-31,7', '2026-09-01,8', ''].join('\n'));
    writeRaw('contributors.csv', ['date,total', '2026-08-31,2', '2026-09-01,3', ''].join('\n'));

    const weekly = downsampleWeekly(build());

    expect(weekly.series.clones).toEqual({ dates: ['2026-08-31'], count: [9], uniques: [5] });
    expect(weekly.series.forks).toEqual({ dates: ['2026-08-31'], total: [8] });
    expect(weekly.series.contributors).toEqual({ dates: ['2026-08-31'], total: [3] });
  });

  it('preserves the total of a traffic series across downsampling', () => {
    // The property that makes weekly views comparable with daily views at
    // all: bucketing changes the resolution, never the quantity.
    const dates = dailyDates('2026-01-01', 90);
    const counts = dates.map((_unused, index) => index + 1);
    const data = makeData({
      series: {
        ...makeData().series,
        views: { dates, count: counts, uniques: counts.map(() => 1) },
      },
    });

    const weekly = downsampleWeekly(data);
    const sum = (values: Array<number | null>): number =>
      values.reduce<number>((total, value) => total + (value ?? 0), 0);

    expect(sum(weekly.series.views.count)).toBe(sum(counts));
    expect(sum(weekly.series.views.uniques)).toBe(90);
  });
});

describe('downsampleWeekly — absent vs. zero', () => {
  it('keeps a null bucket null rather than treating it as zero', () => {
    // A whole week with the column blank: not measured, and a weekly bucket
    // must not manufacture a measured 0 out of it.
    writeRaw(
      'repo.csv',
      [
        'date,subscribers,open_issues,downloads_total',
        '2026-08-31,10,20,',
        '2026-09-01,11,21,',
        '',
      ].join('\n'),
    );
    writeRaw('stars.csv', ['date,total', '2026-08-31,', '2026-09-01,', ''].join('\n'));
    writeRaw(
      'traffic/views.csv',
      ['date,count,uniques', '2026-08-31,,', '2026-09-01,,', ''].join('\n'),
    );

    const weekly = downsampleWeekly(build());

    expect(weekly.series.repo.downloads_total).toEqual([null]);
    expect(weekly.series.repo.downloads_total[0]).not.toBe(0);
    expect(weekly.series.stars.total).toEqual([null]);
    expect(weekly.series.stars.total[0]).not.toBe(0);
    // A summed series is the easier place to get this wrong: an accumulator
    // that starts at 0 reports a week nobody measured as a week of no
    // traffic.
    expect(weekly.series.views.count).toEqual([null]);
    expect(weekly.series.views.count[0]).not.toBe(0);
    // The measured column on the same rows still comes through.
    expect(weekly.series.repo.subscribers).toEqual([11]);
  });

  it('keeps a measured zero as zero rather than collapsing it to null', () => {
    // The mirror of the rule above, and the reason the bucket aggregators
    // test `=== null` rather than falsiness.
    writeRaw(
      'traffic/views.csv',
      ['date,count,uniques', '2026-08-31,0,0', '2026-09-01,0,0', ''].join('\n'),
    );
    writeRaw('stars.csv', ['date,total', '2026-08-31,5', '2026-09-01,0', ''].join('\n'));

    const weekly = downsampleWeekly(build());

    expect(weekly.series.views.count).toEqual([0]);
    expect(weekly.series.views.count[0]).not.toBeNull();
    expect(weekly.series.stars.total).toEqual([0]);
    expect(weekly.series.stars.total[0]).not.toBeNull();
  });

  it('sums the measured days of a partly-measured week rather than nulling the week', () => {
    writeRaw(
      'traffic/views.csv',
      ['date,count,uniques', '2026-08-31,10,3', '2026-09-01,,', '2026-09-02,5,2', ''].join('\n'),
    );

    expect(downsampleWeekly(build()).series.views).toEqual({
      dates: ['2026-08-31'],
      count: [15],
      uniques: [5],
    });
  });

  it('takes the last MEASURED value when a cumulative week ends in a gap', () => {
    // Reading the literal last element would publish null for a week whose
    // counter was measured at 61 three days earlier — an absence invented
    // out of a real measurement.
    writeRaw(
      'stars.csv',
      ['date,total', '2026-08-31,60', '2026-09-01,61', '2026-09-02,', ''].join('\n'),
    );

    expect(downsampleWeekly(build()).series.stars).toEqual({
      dates: ['2026-08-31'],
      total: [61],
    });
  });
});

describe('downsampleWeekly — UTC ISO-week boundaries', () => {
  it('buckets on the UTC Monday', () => {
    // Sunday 2026-09-06 closes the week that opened on Monday 2026-08-31;
    // Monday 2026-09-07 opens the next one. `getDay()` returns 0 for Sunday,
    // so an implementation that subtracts it outright leaves Sunday in a
    // bucket of its own — or, with the wrong sign, pushes it a week forward.
    writeRaw(
      'traffic/views.csv',
      ['date,count,uniques', '2026-09-06,7,1', '2026-09-07,8,1', ''].join('\n'),
    );

    expect(downsampleWeekly(build()).series.views).toEqual({
      dates: ['2026-08-31', '2026-09-07'],
      count: [7, 8],
      uniques: [1, 1],
    });
  });

  it('places every day of one ISO week in the same Monday bucket', () => {
    const dates = dailyDates('2026-08-31', 7);
    const data = makeData({
      series: {
        ...makeData().series,
        views: { dates, count: dates.map(() => 1), uniques: dates.map(() => 1) },
      },
    });

    // Monday through Sunday inclusive: one bucket, seven days in it.
    expect(downsampleWeekly(data).series.views).toEqual({
      dates: ['2026-08-31'],
      count: [7],
      uniques: [7],
    });
  });

  it('buckets across a month and year boundary in UTC', () => {
    // Thursday 2026-01-01 belongs to the week that opened on Monday
    // 2025-12-29 — the case that fails for any implementation doing day
    // arithmetic on the day-of-month rather than on the timestamp.
    writeRaw(
      'traffic/views.csv',
      ['date,count,uniques', '2025-12-31,4,1', '2026-01-01,5,1', ''].join('\n'),
    );

    expect(downsampleWeekly(build()).series.views).toEqual({
      dates: ['2025-12-29'],
      count: [9],
      uniques: [2],
    });
  });

  it('emits buckets in ascending date order', () => {
    const dates = dailyDates('2026-08-31', 21);
    const data = makeData({
      series: {
        ...makeData().series,
        views: { dates, count: dates.map(() => 1), uniques: dates.map(() => 1) },
      },
    });

    expect(downsampleWeekly(data).series.views.dates).toEqual([
      '2026-08-31',
      '2026-09-07',
      '2026-09-14',
    ]);
  });

  it('does not gap-fill a week with no measurements at all', () => {
    // The same rule the daily series follows: a missing week is absent from
    // the axis, not a null point on it. Inventing one would draw a gap the
    // archive never recorded.
    writeRaw(
      'traffic/views.csv',
      ['date,count,uniques', '2026-08-31,4,1', '2026-09-14,5,1', ''].join('\n'),
    );

    expect(downsampleWeekly(build()).series.views.dates).toEqual(['2026-08-31', '2026-09-14']);
  });

  it('throws rather than bucketing a date it cannot place in a week', () => {
    // `2026-9-1` is not a date this collector ever writes, but nothing in
    // the read path validates the shape, and week arithmetic — unlike the
    // byte sort the daily path uses — cannot proceed on a value it cannot
    // parse. Failing loudly beats bucketing it under `Invalid Date`.
    writeRaw('stars.csv', 'date,total\n2026-9-1,5\n');

    expect(() => downsampleWeekly(build())).toThrow(/cannot bucket "2026-9-1"/);
  });

  it('throws on a date that parses but is not a real calendar day', () => {
    // `2026-02-30` rolls over to 2 March in every JS date constructor, so
    // accepting it would silently relocate a measurement by two days.
    writeRaw('stars.csv', 'date,total\n2026-02-30,5\n');

    expect(() => downsampleWeekly(build())).toThrow(/cannot bucket "2026-02-30"/);
  });
});

describe('downsampleWeekly — what it must not touch', () => {
  it('leaves releases and dimensions untouched when downsampling', () => {
    writeRaw(
      'releases.csv',
      'date,tag,name\n2026-08-31,v1.0.0,First\n2026-09-01,v1.0.1,Patch\n',
    );
    createStore(dir).writeNdjson('traffic/referrers.ndjson', [
      dimensionRow('2026-08-31', 'a.example', 100),
      dimensionRow('2026-09-01', 'a.example', 130),
    ]);
    createStore(dir).writeNdjson('traffic/paths.ndjson', [
      dimensionRow('2026-08-31', '/a', 9),
      dimensionRow('2026-09-01', '/a', 11),
    ]);
    writeRaw('traffic/views.csv', 'date,count,uniques\n2026-08-31,4,1\n2026-09-01,5,1\n');

    const data = build();
    const weekly = downsampleWeekly(data);

    // Releases are sparse: bucketing them would merge two tags published in
    // one week into a single marker, and there is no space to save.
    expect(weekly.releases).toEqual(data.releases);
    expect(weekly.releases).toHaveLength(2);
    // Dimension snapshots stay per-snapshot: they are already bounded by
    // top-10-per-snapshot, and their trajectories are differences between
    // consecutive snapshots that weekly bucketing would silently redefine.
    expect(weekly.dimensions).toEqual(data.dimensions);
    expect(weekly.dimensions.referrers.snapshots).toEqual(['2026-08-31', '2026-09-01']);
    expect(weekly.dimensions.paths.snapshots).toEqual(['2026-08-31', '2026-09-01']);
    // And the series it DOES own really was bucketed, so this test cannot
    // pass by downsampling nothing at all.
    expect(weekly.series.views.dates).toEqual(['2026-08-31']);
  });

  it('carries the envelope through unchanged', () => {
    writeRaw('traffic/views.csv', 'date,count,uniques\n2026-09-02,4,1\n2026-09-03,5,1\n');
    writeMeta();

    const data = build();
    const weekly = downsampleWeekly(data);

    expect(weekly.generated_at).toBe(data.generated_at);
    expect(weekly.meta).toEqual(data.meta);
    expect(weekly.empty).toBe(data.empty);
    // `collection_started` is a claim about when measurement began, and the
    // Monday of the first bucket (2026-08-31) predates the first measured
    // day (2026-09-02). Recomputing it from the bucket keys would move the
    // page's "since" label onto a day nothing was measured.
    expect(weekly.collection_started).toBe('2026-09-02');
    expect(weekly.series.views.dates).toEqual(['2026-08-31']);
  });

  it('sets downsampled true', () => {
    writeRaw('stars.csv', 'date,total\n2026-09-01,56\n');

    expect(downsampleWeekly(build()).downsampled).toBe(true);
  });

  it('does not mutate its input', () => {
    writeRaw('traffic/views.csv', 'date,count,uniques\n2026-08-31,4,1\n2026-09-01,5,1\n');
    writeRaw('stars.csv', 'date,total\n2026-08-31,60\n2026-09-01,61\n');

    const data = build();
    const before = JSON.stringify(data);

    downsampleWeekly(data);

    expect(JSON.stringify(data)).toBe(before);
  });

  it('handles an empty bundle without inventing a bucket', () => {
    const weekly = downsampleWeekly(makeData({ empty: true }));

    expect(weekly.series.views).toEqual({ dates: [], count: [], uniques: [] });
    expect(weekly.series.stars).toEqual({ dates: [], total: [] });
    expect(weekly.series.repo).toEqual({
      dates: [],
      subscribers: [],
      open_issues: [],
      downloads_total: [],
      downloads_app: [],
      downloads_updates: [],
    });
    expect(weekly.empty).toBe(true);
  });

  it('round-trips through JSON with no undefined anywhere', () => {
    writeRaw('repo.csv', 'date,subscribers,open_issues,downloads_total\n2026-08-31,1,18,\n');
    writeRaw('releases.csv', 'date,tag,name\n2026-08-01,v1.0.0,First\n');
    writeMeta();

    const weekly = downsampleWeekly(build());

    expect(JSON.parse(JSON.stringify(weekly))).toStrictEqual(weekly);
    expect(undefinedPaths(weekly)).toEqual([]);
  });
});

describe('serialiseWithinBudget', () => {
  it('uses a 2 MB budget', () => {
    expect(BUNDLE_BUDGET_BYTES).toBe(2 * 1024 * 1024);
    expect(BUNDLE_BUDGET_BYTES).toBe(2_097_152);
  });

  it('publishes a bundle under budget exactly as built', () => {
    writeRaw('stars.csv', 'date,total\n2026-09-01,56\n');

    const data = build();
    const result = serialiseWithinBudget(data);

    expect(result.json).toBe(JSON.stringify(data));
    expect(result.downsampled).toBe(false);
    expect(result.bytes).toBeLessThan(BUNDLE_BUDGET_BYTES);
    expect(JSON.parse(result.json)).toStrictEqual(data);
  });

  it('serialises a wholly missing archive as a valid empty bundle', () => {
    // The production path this whole entrypoint exists to survive: the
    // Pages deploy runs on every landing-page push, whether or not the
    // metrics-data branch has ever been created.
    const data = buildDashboardData(createStore(path.join(dir, 'no-such-branch')), GENERATED_AT);
    const result = serialiseWithinBudget(data);

    expect(result.downsampled).toBe(false);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.bytes).toBeLessThan(BUNDLE_BUDGET_BYTES);
    const parsed: unknown = JSON.parse(result.json);
    expect(parsed).toStrictEqual(data);
    expect(data.empty).toBe(true);
    expect(data.meta).toBeNull();
  });

  it('measures UTF-8 bytes, not UTF-16 code units', () => {
    // A referrer title is upstream text and can hold anything. `.length`
    // would under-count a multi-byte character and let a bundle over the
    // real budget through — the exact regression the budget exists to catch.
    const data = makeData({
      dimensions: {
        referrers: {
          snapshots: ['2026-09-01'],
          latest: [{ dimension: 'a.example', title: '😀', count: 1, uniques: 1 }],
          trajectories: [],
        },
        paths: { snapshots: [], latest: [], trajectories: [] },
      },
    });

    const result = serialiseWithinBudget(data);

    expect(result.bytes).toBeGreaterThan(result.json.length);
  });

  it('sets downsampled true only when it actually downsampled', () => {
    const small = serialiseWithinBudget(makeData({ empty: true }));
    expect(small.downsampled).toBe(false);

    // Roughly 330 years of daily views: over 2 MB as dailies, comfortably
    // under it once bucketed by week.
    const dates = dailyDates('1700-01-01', 120_000);
    const large = makeData({
      series: {
        ...makeData().series,
        views: {
          dates,
          count: dates.map((_unused, index) => index % 97),
          uniques: dates.map((_unused, index) => index % 13),
        },
      },
    });
    expect(Buffer.byteLength(JSON.stringify(large), 'utf8')).toBeGreaterThan(BUNDLE_BUDGET_BYTES);

    const result = serialiseWithinBudget(large);

    expect(result.downsampled).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(BUNDLE_BUDGET_BYTES);
    const parsed = JSON.parse(result.json) as DashboardData;
    expect(parsed.downsampled).toBe(true);
    // Nothing was dropped to fit: the weekly counts still add up to the
    // daily ones.
    const total = (values: Array<number | null>): number =>
      values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    expect(total(parsed.series.views.count)).toBe(total(large.series.views.count));
  });

  it('throws rather than truncating when still over budget after downsampling', () => {
    // Releases are never downsampled, so a bundle whose bulk is releases
    // cannot be shrunk by bucketing. The only honest answers are "publish it
    // oversized" and "fail the build"; §7.1 chooses the second, so the
    // regression surfaces in CI rather than in first paint.
    const releases = Array.from({ length: 40_000 }, (_unused, index) => ({
      date: '2026-09-01',
      tag: `v0.0.${index}`,
      name: `Release number ${index}`,
    }));
    const data = makeData({ releases });
    expect(Buffer.byteLength(JSON.stringify(data), 'utf8')).toBeGreaterThan(BUNDLE_BUDGET_BYTES);

    expect(() => serialiseWithinBudget(data)).toThrow(/budget/);
    // And it says both sizes, so a maintainer reading a red CI log knows
    // whether downsampling helped at all.
    expect(() => serialiseWithinBudget(data)).toThrow(/after weekly downsampling/);
  });

  it('keeps an already-downsampled bundle flagged as downsampled', () => {
    const data = makeData({ downsampled: true });

    expect(serialiseWithinBudget(data).downsampled).toBe(true);
  });
});

describe('downsampleWeekly — structural sharing', () => {
  it('shares no mutable object with its input', () => {
    writeRaw('traffic/views.csv', 'date,count,uniques\n2026-08-31,4,1\n2026-09-01,5,1\n');
    writeRaw('releases.csv', 'date,tag,name\n2026-08-31,v1.0.0,First\n');
    createStore(dir).writeNdjson('traffic/referrers.ndjson', [
      dimensionRow('2026-08-31', 'a.example', 100),
      dimensionRow('2026-09-01', 'a.example', 130),
    ]);
    writeMeta();

    const data = build();
    const weekly = downsampleWeekly(data);

    // Purity as a property of the function, not as a promise about every
    // future caller. The pass-through parts are the ones a maintainer will
    // be editing when the budget finally binds — the over-budget error
    // names capping the dimension history as the lever — and an alias here
    // would make that an action-at-a-distance change to the daily bundle
    // the weekly one was derived from.
    expect(weekly.releases).not.toBe(data.releases);
    expect(weekly.releases[0]).not.toBe(data.releases[0]);
    expect(weekly.dimensions).not.toBe(data.dimensions);
    expect(weekly.dimensions.referrers).not.toBe(data.dimensions.referrers);
    expect(weekly.dimensions.referrers.snapshots).not.toBe(data.dimensions.referrers.snapshots);
    expect(weekly.dimensions.referrers.latest[0]).not.toBe(data.dimensions.referrers.latest[0]);
    expect(weekly.dimensions.referrers.trajectories[0]).not.toBe(
      data.dimensions.referrers.trajectories[0],
    );
    expect(weekly.dimensions.referrers.trajectories[0]?.delta).not.toBe(
      data.dimensions.referrers.trajectories[0]?.delta,
    );
    expect(weekly.dimensions.paths).not.toBe(data.dimensions.paths);
    expect(weekly.meta).not.toBe(data.meta);
    expect(weekly.series).not.toBe(data.series);
    expect(weekly.series.views).not.toBe(data.series.views);
    // Copied, not altered.
    expect(weekly.releases).toEqual(data.releases);
    expect(weekly.dimensions).toEqual(data.dimensions);
    expect(weekly.meta).toEqual(data.meta);
  });

  it('is unaffected by a later edit to the bundle it was derived from', () => {
    writeRaw('traffic/views.csv', 'date,count,uniques\n2026-08-31,4,1\n');
    writeRaw('releases.csv', 'date,tag,name\n2026-08-31,v1.0.0,First\n');
    createStore(dir).writeNdjson('traffic/referrers.ndjson', [
      dimensionRow('2026-08-31', 'a.example', 100),
    ]);
    writeMeta();

    const data = build();
    const weekly = downsampleWeekly(data);

    // The maintainer's most likely edit: trimming what the bundle carries
    // to get back under budget.
    data.releases.length = 0;
    data.dimensions.referrers.latest.length = 0;
    const firstRelease = weekly.releases[0];
    expect(firstRelease).toBeDefined();
    expect(firstRelease?.tag).toBe('v1.0.0');
    expect(weekly.dimensions.referrers.latest).toHaveLength(1);
  });
});

describe('budgetWarning', () => {
  it('warns at 80% of the budget, six years of headroom before the flip', () => {
    expect(BUNDLE_WARN_FRACTION).toBe(0.8);
    expect(BUNDLE_WARN_BYTES).toBe(Math.floor(BUNDLE_BUDGET_BYTES * 0.8));
    expect(BUNDLE_WARN_BYTES).toBe(1_677_721);
    // The archive grows by roughly 68 KB a year, so the headroom between the
    // warning and the cliff must be worth years, not weeks.
    const headroomYears = (BUNDLE_BUDGET_BYTES - BUNDLE_WARN_BYTES) / (68 * 1024);
    expect(headroomYears).toBeGreaterThan(5);
  });

  it('stays silent for a bundle nowhere near the budget', () => {
    writeRaw('stars.csv', 'date,total\n2026-09-01,56\n');

    const result = serialiseWithinBudget(build());

    expect(result.bytes).toBeLessThan(BUNDLE_WARN_BYTES);
    expect(budgetWarning(result)).toBeNull();
  });

  it('stays silent one byte below the mark and warns exactly at it', () => {
    // The boundary is the whole point of a high-water mark: off by one here
    // is the difference between warning on the last build before the flip
    // and warning on the first build after it.
    expect(budgetWarning({ json: '', bytes: BUNDLE_WARN_BYTES - 1, downsampled: false })).toBeNull();
    expect(budgetWarning({ json: '', bytes: BUNDLE_WARN_BYTES, downsampled: false })).not.toBeNull();
  });

  it('names the size, the budget, the headroom, and what happens next', () => {
    const bytes = BUNDLE_WARN_BYTES + 1000;
    const warning = budgetWarning({ json: '', bytes, downsampled: false });

    expect(warning).toContain('WARNING');
    expect(warning).toContain(String(bytes));
    expect(warning).toContain(String(BUNDLE_BUDGET_BYTES));
    expect(warning).toContain(String(BUNDLE_BUDGET_BYTES - bytes));
    // The percentage, so the number means something without arithmetic.
    expect(warning).toMatch(/80\.\d%/);
    // And what the next build past the budget actually does.
    expect(warning).toContain('weekly buckets');
  });

  it('says the next step is a failed build once the bundle is already weekly', () => {
    // Weekly buckets are the last reduction available, so a bundle that is
    // already downsampled and still approaching the budget is approaching a
    // hard failure, not another quiet resolution change. The two messages
    // must not be interchangeable.
    const daily = budgetWarning({ json: '', bytes: BUNDLE_WARN_BYTES, downsampled: false });
    const weekly = budgetWarning({ json: '', bytes: BUNDLE_WARN_BYTES, downsampled: true });

    expect(weekly).toContain('FAIL the build');
    expect(daily).not.toContain('FAIL the build');
    expect(weekly).not.toBe(daily);
  });

  it('still warns for a bundle sitting exactly on the budget', () => {
    // Under budget by the `<=` rule, so it publishes — and is as close to
    // the cliff as a passing build can be.
    const warning = budgetWarning({ json: '', bytes: BUNDLE_BUDGET_BYTES, downsampled: false });

    expect(warning).toContain('100.0%');
    expect(warning).toContain('0 bytes of headroom');
  });

  it('warns on a bundle that was downsampled to fit', () => {
    // End to end: build something over budget, let the budget pass reduce
    // it, and confirm the warning reflects the PUBLISHED bundle rather than
    // the one that was measured first.
    const dates = dailyDates('1700-01-01', 120_000);
    const large = makeData({
      series: {
        ...makeData().series,
        views: {
          dates,
          count: dates.map((_unused, index) => index % 97),
          uniques: dates.map((_unused, index) => index % 13),
        },
      },
    });

    const result = serialiseWithinBudget(large);

    expect(result.downsampled).toBe(true);
    // This particular reduction lands far under the mark, so no warning —
    // which is the correct answer, and pins that the warning reads the
    // published size and not the pre-downsampling one.
    expect(result.bytes).toBeLessThan(BUNDLE_WARN_BYTES);
    expect(budgetWarning(result)).toBeNull();
  });
});
