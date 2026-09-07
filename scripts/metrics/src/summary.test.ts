import { describe, it, expect } from 'vitest';
import {
  buildSummary,
  renderSummaryHtml,
  buildDatasetJsonLd,
  renderDatasetJsonLd,
  replaceRegion,
} from './summary.ts';
import type { DashboardData } from './bundle.ts';

function data(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    generated_at: '2026-09-02T10:00:00.000Z',
    collection_started: '2026-08-18',
    meta: { last_run: null, last_success: null, error: null },
    empty: false,
    downsampled: false,
    series: {
      views: { dates: ['2026-08-18', '2026-08-19'], count: [75, 174], uniques: [23, 51] },
      clones: { dates: ['2026-08-18', '2026-08-19'], count: [10, 8], uniques: [8, 6] },
      stars: { dates: ['2026-08-18', '2026-08-19'], total: [52, 64] },
      forks: { dates: ['2026-08-19'], total: [5] },
      contributors: { dates: ['2026-08-18'], total: [3] },
      repo: {
        dates: ['2026-08-19'],
        subscribers: [7],
        open_issues: [18],
        downloads_total: [1802],
        downloads_app: [null],
        downloads_updates: [0],
      },
      workflows: { dates: ['2026-08-18', '2026-08-19'], runs: [0, 17] },
    },
    releases: [{ date: '2026-07-03', tag: 'v1.0.0', name: 'Backspace 1.0.0' }],
    dimensions: {
      referrers: {
        snapshots: ['2026-08-19'],
        latest: [{ dimension: 'Google', title: 'Google', count: 193, uniques: 53 }],
        trajectories: [],
      },
      paths: {
        snapshots: ['2026-08-19'],
        latest: [{ dimension: '/x', title: 'Overview', count: 646, uniques: 263 }],
        trajectories: [],
      },
    },
    // The live archive's state before the first ping: present, and empty. The
    // block is not optional on `DashboardData`, and leaving it off the fixture
    // would only work because of the cast below.
    telemetry: {
      network: {
        dates: [],
        instances_1d: [],
        instances_7d: [],
        instances_30d: [],
        users_registered: [],
        users_active1d: [],
        users_active7d: [],
        users_active30d: [],
        messages7d: [],
        storage_mib: [],
        voice_instances: [],
        federation_instances: [],
      },
      versions: { snapshots: [], latest: [], trajectories: [] },
      countries: { snapshots: [], latest: [], trajectories: [] },
      clients: { snapshots: [], latest: [], trajectories: [] },
      instances7d: null,
    },
    ...overrides,
  } as DashboardData;
}

/** The same bundle once one ping has been archived. */
function dataWithTelemetry(): DashboardData {
  const d = data();
  d.telemetry.network.dates = ['2026-09-05'];
  d.telemetry.network.instances_7d = [12];
  return d;
}

const empty = (): DashboardData =>
  data({
    collection_started: null,
    empty: true,
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
      workflows: { dates: [], runs: [] },
    },
    releases: [],
    dimensions: {
      referrers: { snapshots: [], latest: [], trajectories: [] },
      paths: { snapshots: [], latest: [], trajectories: [] },
    },
  });

describe('buildSummary', () => {
  it('takes each counter from its own newest measured row', () => {
    const f = buildSummary(data());
    expect(f.stars).toEqual({ value: 64, date: '2026-08-19' });
    expect(f.forks).toEqual({ value: 5, date: '2026-08-19' });
    expect(f.watchers).toEqual({ value: 7, date: '2026-08-19' });
    // Series legitimately end on different dates; the older one is not padded.
    expect(f.contributors).toEqual({ value: 3, date: '2026-08-18' });
  });

  // The defect this guards: a trailing null is "not measured", and reading the
  // last ELEMENT rather than the last MEASURED element would report it as the
  // current value or crash on it.
  it('skips trailing unmeasured rows rather than reporting them', () => {
    const d = data();
    d.series.stars = { dates: ['2026-08-18', '2026-08-19'], total: [52, null] };
    expect(buildSummary(d).stars).toEqual({ value: 52, date: '2026-08-18' });
  });

  it('reports the peak traffic day, not the latest', () => {
    const f = buildSummary(data());
    expect(f.viewsPeak).toEqual({ value: 174, uniques: 51, date: '2026-08-19' });
    expect(f.clonesPeak).toEqual({ value: 10, uniques: 8, date: '2026-08-18' });
  });

  it('counts only measured days', () => {
    const d = data();
    d.series.views = { dates: ['a', 'b', 'c'], count: [1, null, 3], uniques: [1, null, 3] };
    expect(buildSummary(d).viewsDays).toBe(2);
  });

  it('takes the coverage end from the latest date across every series', () => {
    expect(buildSummary(data()).to).toBe('2026-08-19');
    expect(buildSummary(data()).from).toBe('2026-08-18');
  });

  // The archive total is what the SERVED page states, so it is read by
  // whatever fetches the page without running its JavaScript. A total that
  // silently included the unmeasured days as zeroes would be the one figure on
  // the page that is an estimate.
  it('sums only the measured days', () => {
    const d = data();
    d.series.views = { dates: ['a', 'b', 'c'], count: [7, null, 5], uniques: [1, null, 1] };
    const f = buildSummary(d);
    expect(f.viewsTotal).toBe(12);
    expect(f.viewsDays).toBe(2);
  });

  // Zero views across two measured days and no measurement at all are
  // different facts, and only the second one loses its clause.
  it('reports a measured zero total as 0 and an unmeasured one as null', () => {
    const measuredZero = data();
    measuredZero.series.clones = { dates: ['a', 'b'], count: [0, 0], uniques: [0, 0] };
    expect(buildSummary(measuredZero).clonesTotal).toBe(0);

    const unmeasured = data();
    unmeasured.series.clones = { dates: ['a', 'b'], count: [null, null], uniques: [null, null] };
    expect(buildSummary(unmeasured).clonesTotal).toBeNull();
  });

  it('takes app downloads from the newest measured row and counts the releases', () => {
    const d = data();
    d.series.repo.dates = ['2026-08-18', '2026-08-19'];
    d.series.repo.subscribers = [7, 7];
    d.series.repo.open_issues = [18, 18];
    d.series.repo.downloads_total = [1802, 1900];
    d.series.repo.downloads_app = [340, 412];
    d.series.repo.downloads_updates = [0, 0];
    d.releases = [
      { date: '2026-07-03', tag: 'v1.0.0', name: 'Backspace 1.0.0' },
      { date: '2026-08-01', tag: 'v1.1.0', name: 'Backspace 1.1.0' },
    ];
    const f = buildSummary(d);
    expect(f.downloadsApp).toEqual({ value: 412, date: '2026-08-19' });
    expect(f.releasesShipped).toBe(2);
  });

  it('reports nulls throughout for an empty archive rather than zeroes', () => {
    const f = buildSummary(empty());
    expect(f.stars).toBeNull();
    expect(f.viewsPeak).toBeNull();
    expect(f.topReferrer).toBeNull();
    expect(f.topPath).toBeNull();
    expect(f.to).toBeNull();
    expect(f.viewsDays).toBe(0);
    expect(f.viewsTotal).toBeNull();
    expect(f.clonesTotal).toBeNull();
    expect(f.downloadsApp).toBeNull();
    expect(f.releasesShipped).toBe(0);
  });
});

describe('renderSummaryHtml', () => {
  it('states every measured figure with the date it was measured on', () => {
    const html = renderSummaryHtml(buildSummary(data()));
    expect(html).toContain('64 stars');
    expect(html).toContain('5 forks');
    expect(html).toContain('7 watchers');
    expect(html).toContain('measured 2026-08-19');
    expect(html).toContain('Page views: 249 across 2 measured days, busiest 174');
    expect(html).toContain('Google');
    expect(html).toContain('v1.0.0');
    expect(html).toContain('2026-08-18 to 2026-08-19');
    // The links live in the paragraph above this one; repeating them here
    // duplicated them four lines apart on the rendered page.
    expect(html).not.toContain('href="data/"');
  });

  // The rule the whole project turns on: never print a number for something
  // that was not measured. A missing figure loses its clause entirely.
  it('omits an unmeasured figure instead of printing zero or a dash', () => {
    const d = data();
    d.series.repo.subscribers = [null];
    const html = renderSummaryHtml(buildSummary(d));
    expect(html).not.toContain('watchers');
    expect(html).not.toContain('0 watchers');
    expect(html).toContain('64 stars');
  });

  // The busiest clone day is, on this repository, a day its own CI ran hardest —
  // GitHub counts every `actions/checkout` as a clone. This sentence is baked into
  // the shared `/insights/` HTML, so it is the figure a fetcher quotes; the caveat
  // has to travel in the same sentence or the number arrives stripped of it.
  it('never states the clone peak without saying CI checkouts are counted in it', () => {
    const html = renderSummaryHtml(buildSummary(data()));
    expect(html).toContain('Clones: 18 across 2 measured days, busiest 10 on 2026-08-18');
    expect(html).toContain('own CI checkouts');
  });

  // Every figure the page's lead row shows has to be in this paragraph, because
  // the row is drawn by JavaScript and this paragraph is not: a fetcher that
  // runs none sees only what is written here. `downloads_app` is blank in the
  // base fixture, which is the pre-split archive state, so the clause is
  // absent exactly as an unmeasured figure should be.
  it('states app downloads and names what is excluded from them', () => {
    const d = data();
    d.series.repo.downloads_app = [412];
    const html = renderSummaryHtml(buildSummary(d));
    expect(html).toContain('412 downloads of installers and archives');
    expect(html).toContain('Update-checking traffic is counted separately');
  });

  it('omits app downloads entirely when the split was never measured', () => {
    const html = renderSummaryHtml(buildSummary(data()));
    expect(html).not.toContain('App downloads');
  });

  it('states how many releases shipped alongside the newest one', () => {
    const d = data();
    d.releases = [
      { date: '2026-07-03', tag: 'v1.0.0', name: 'Backspace 1.0.0' },
      { date: '2026-08-01', tag: 'v1.1.0', name: 'Backspace 1.1.0' },
    ];
    expect(renderSummaryHtml(buildSummary(d))).toContain(
      'Releases shipped: 2, latest v1.1.0 on 2026-08-01',
    );
  });

  it('states the CI peak so the clone caveat has its number in the same text', () => {
    const html = renderSummaryHtml(buildSummary(data()));
    expect(html).toContain('17 workflow runs on 2026-08-19');
  });

  it('omits the CI sentence when the archive carries no workflow rows', () => {
    const d = data();
    d.series.workflows = { dates: [], runs: [] };
    const html = renderSummaryHtml(buildSummary(d));
    expect(html).not.toContain('workflow run');
  });

  it('omits the CI caveat entirely when there is no clone figure to qualify', () => {
    const d = data();
    d.series.clones = { dates: [], count: [], uniques: [] };
    const html = renderSummaryHtml(buildSummary(d));
    expect(html).not.toContain('Busiest day for clones');
    expect(html).not.toContain('own CI checkouts');
  });

  it('says plainly that nothing is recorded rather than rendering a figure-less sentence', () => {
    const html = renderSummaryHtml(buildSummary(empty()));
    expect(html).toContain('no measurements yet');
    expect(html).not.toContain('Latest measurements');
  });

  it('escapes a hostile dimension name, in the title and in the raw dimension', () => {
    const d = data();
    d.dimensions.referrers.latest = [
      { dimension: '<img src=x onerror=alert(1)>', title: '', count: 1, uniques: 1 },
    ];
    d.dimensions.paths.latest = [
      { dimension: '/<svg onload=alert(1)>', title: '<b>t</b>', count: 1, uniques: 1 },
    ];
    const html = renderSummaryHtml(buildSummary(d));
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('<b>t</b>');
    expect(html).toContain('&lt;img');
    expect(html).toContain('&lt;svg');
  });

  // Found live: GitHub leaves `title` EMPTY for every referrer and puts the
  // host in `dimension`, so reading `title` alone printed "Leading referrer:
  // , 193 views" on the real archive.
  it('names a referrer from its dimension when the title is empty', () => {
    const d = data();
    d.dimensions.referrers.latest = [
      { dimension: 'Google', title: '', count: 193, uniques: 53 },
    ];
    const html = renderSummaryHtml(buildSummary(d));
    expect(html).toContain('Leading referrer over the trailing 14 days: Google,');
  });

  it('keeps the raw path beside a path that has a page title', () => {
    const html = renderSummaryHtml(buildSummary(data()));
    expect(html).toContain('Overview (/x)');
  });

  it('does not repeat the name when the label and the dimension are the same', () => {
    const d = data();
    d.dimensions.paths.latest = [{ dimension: '/only', title: '', count: 2, uniques: 1 }];
    expect(renderSummaryHtml(buildSummary(d))).toContain('/only, 2 views');
  });

  it('agrees in number with the figure it is attached to', () => {
    const d = data();
    d.series.repo.subscribers = [1];
    d.series.forks = { dates: ['2026-08-19'], total: [1] };
    const html = renderSummaryHtml(buildSummary(d));
    expect(html).toContain('1 watcher and');
    expect(html).toContain('1 fork');
    expect(html).not.toContain('1 watchers');
    expect(html).not.toContain('1 forks');
  });

  it('labels the resolution the bundle actually carries', () => {
    expect(renderSummaryHtml(buildSummary(data({ downsampled: true })))).toContain(
      'weekly resolution',
    );
    expect(renderSummaryHtml(buildSummary(data()))).toContain('daily resolution');
  });
});

describe('renderDatasetJsonLd', () => {
  it('carries measured values and the archive coverage', () => {
    const parsed = buildDatasetJsonLd(
      buildSummary(data()),
      'https://example.com/backspace/',
    ) as unknown as {
      temporalCoverage: string;
      url: string;
      variableMeasured: Array<{ name: string; value?: number }>;
      distribution: Array<{ contentUrl: string }>;
    };
    expect(parsed.temporalCoverage).toBe('2026-08-18/2026-08-19');
    // The trailing slash on the configured URL must not produce a double slash.
    expect(parsed.url).toBe('https://example.com/backspace/insights/');
    expect(parsed.distribution[0]?.contentUrl).toBe(
      'https://example.com/backspace/insights/data.json',
    );
    expect(parsed.variableMeasured.find((v) => v.name === 'stars')?.value).toBe(64);
  });

  it('names an unmeasured variable but attaches no value to it', () => {
    const d = data();
    d.series.forks = { dates: [], total: [] };
    const parsed = buildDatasetJsonLd(buildSummary(d), 'https://example.com') as unknown as {
      variableMeasured: Array<{ name: string; value?: number }>;
    };
    const forks = parsed.variableMeasured.find((v) => v.name === 'forks');
    expect(forks).toBeDefined();
    expect(forks?.value).toBeUndefined();
  });

  it('omits temporalCoverage entirely for an empty archive', () => {
    const parsed = buildDatasetJsonLd(buildSummary(empty()), 'https://example.com');
    expect(parsed['temporalCoverage']).toBeUndefined();
  });

  it('declares the telemetry variables once the archive holds a ping', () => {
    const json = buildDatasetJsonLd(buildSummary(dataWithTelemetry()), 'https://x.test');
    const names = (json['variableMeasured'] as Array<{ name: string }>).map((v) => v.name);

    expect(names).toContain('reporting instances');
    expect(names).toContain('active users on reporting instances');
    expect(names).toContain('server versions in use');
    expect(String(json['description'])).toContain('opt-in');
    expect(String(json['measurementTechnique'])).toContain('opted in');
  });

  it('declares no telemetry variables while the archive holds no ping', () => {
    const json = buildDatasetJsonLd(buildSummary(data()), 'https://x.test');
    const names = (json['variableMeasured'] as Array<{ name: string }>).map((v) => v.name);

    // A variable the archive has never measured is a claimed measurement.
    expect(names).not.toContain('reporting instances');
    expect(String(json['description'])).not.toContain('opt-in');
    expect(String(json['measurementTechnique'])).not.toContain('opted in');
  });

  it('escapes a closing script tag so the block cannot be broken out of', () => {
    // jsonLd escapes `<`; without it a value containing `</script>` would end
    // the block and everything after it would parse as markup.
    const json = renderDatasetJsonLd(buildSummary(data()), 'https://x.test/</script><b>');
    expect(json).not.toContain('</script><b>');
  });
});

describe('replaceRegion', () => {
  it('replaces only what lies between the markers', () => {
    const out = replaceRegion('a<!-- BUILD:X -->old<!-- /BUILD:X -->b', 'X', 'new');
    expect(out).toBe('a<!-- BUILD:X -->\nnew\n<!-- /BUILD:X -->b');
  });

  // Silently returning the input would publish the committed fallback — a page
  // with no figures — and the deploy would still be green.
  it('throws rather than returning the page unchanged when a marker is missing', () => {
    expect(() => replaceRegion('no markers here', 'X', 'new')).toThrow(/refusing to publish/);
    expect(() => replaceRegion('<!-- BUILD:X -->only an opener', 'X', 'n')).toThrow();
  });

  it('throws when the markers are in the wrong order', () => {
    expect(() => replaceRegion('<!-- /BUILD:X --><!-- BUILD:X -->', 'X', 'n')).toThrow();
  });
});
