import { describe, it, expect } from 'vitest';
import { renderDataPage, escapeHtml, jsonLd } from './datapage.ts';
import type { DashboardData } from './bundle.ts';

function data(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    generated_at: '2026-09-02T10:00:00.000Z',
    collection_started: '2026-08-18',
    meta: { last_run: '2026-09-02T10:00:00.000Z', last_success: null, error: null },
    empty: false,
    downsampled: false,
    series: {
      views: { dates: ['2026-08-18'], count: [75], uniques: [23] },
      clones: { dates: ['2026-08-18'], count: [10], uniques: [8] },
      stars: { dates: ['2026-08-18'], total: [52] },
      forks: { dates: [], total: [] },
      contributors: { dates: [], total: [] },
      repo: {
        dates: ['2026-08-18'],
        subscribers: [1],
        open_issues: [18],
        downloads_total: [1802],
        downloads_app: [null],
        downloads_updates: [0],
      },
      // A measured zero and a real count, so the table can be checked for the
      // one thing this series must never do: render its zero as a gap.
      workflows: { dates: ['2026-08-18', '2026-08-19'], runs: [0, 12] },
    },
    releases: [],
    dimensions: {
      referrers: { snapshots: [], latest: [], trajectories: [] },
      paths: { snapshots: [], latest: [], trajectories: [] },
    },
    // The live archive's state: no instance has reported yet, so the section
    // must not render at all rather than render as a wall of empty tables.
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
  };
}

/** A telemetry block with one measured day, for the rendered-section cases. */
function withTelemetry(): DashboardData {
  return data({
    telemetry: {
      network: {
        dates: ['2026-09-05'],
        instances_1d: [7],
        instances_7d: [12],
        instances_30d: [14],
        users_registered: [230],
        users_active1d: [31],
        users_active7d: [88],
        users_active30d: [140],
        messages7d: [4200],
        storage_mib: [3100],
        voice_instances: [5],
        // A measured zero, which must print as a zero and not as a gap.
        federation_instances: [0],
      },
      versions: {
        snapshots: ['2026-09-05'],
        latest: [{ dimension: '1.1.2', title: '', count: 9, uniques: 9 }],
        trajectories: [],
      },
      countries: {
        snapshots: ['2026-09-05'],
        latest: [{ dimension: 'DE', title: '', count: 6, uniques: 6 }],
        trajectories: [],
      },
      clients: {
        snapshots: ['2026-09-05'],
        latest: [{ dimension: 'desktop', title: '', count: 8, uniques: 8 }],
        trajectories: [],
      },
      instances7d: 12,
    },
  });
}

describe('escapeHtml', () => {
  it('escapes every character that can break out of markup', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('escapes the ampersand first so escapes are not double-escaped', () => {
    // Naive ordering turns `<` into `&lt;` and then the `&` of that into
    // `&amp;lt;`, rendering the literal text "&lt;" on the page.
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('jsonLd', () => {
  it('neutralises a closing script tag hidden in the data', () => {
    const out = jsonLd({ name: '</script><img src=x onerror=alert(1)>' });
    expect(out).not.toContain('</script>');
    expect(JSON.parse(out.replace(/\\u003c/g, '<')).name).toBe(
      '</script><img src=x onerror=alert(1)>',
    );
  });
});

describe('renderDataPage', () => {
  // The tables are the encoding a crawler reads. A clone column presented as
  // plain reach, with no note that this repository's own CI is counted in it,
  // is the one number here that reliably reads as more adoption than it is.
  // The distinction this whole series turns on: on the traffic tables a zero
  // day is absent (GitHub omits it), here it is a value that must be printed.
  it('prints a workflow zero as a zero, never as not measured', () => {
    const html = renderDataPage(data());
    expect(html).toContain('CI activity');
    expect(html).toContain('workflow runs');
    const row = html.slice(html.indexOf('<h2>CI activity</h2>'));
    expect(row).toContain('2026-08-18');
    expect(row.slice(0, row.indexOf('</table>'))).not.toContain('not measured');
  });

  it('qualifies the clone table with the CI checkouts counted in it', () => {
    const html = renderDataPage(data());
    expect(html).toContain('actions/checkout');
    expect(html).toContain('per unique cloner');
  });

  it('puts the measured values in the HTML itself, not behind a fetch', () => {
    const html = renderDataPage(data());
    expect(html).toContain('75');
    expect(html).toContain('>23<');
    expect(html).not.toContain('<script src');
  });

  it('renders an unmeasured value as words, never as a zero', () => {
    const html = renderDataPage(data());
    expect(html).toContain('not measured');
    // downloads_app is null here; a "0" cell for it would be a fabricated
    // measurement, which is the one thing this whole archive exists to avoid.
    expect(html).not.toMatch(/<td class="n">0<\/td>\s*<td class="n">0<\/td>/);
  });

  it('renders a measured zero at zero rather than as unmeasured', () => {
    // downloads_updates is 0, a real reading, and must survive as one.
    expect(renderDataPage(data())).toContain('<td class="n">0</td>');
  });

  it('escapes a referrer that tries to inject markup', () => {
    const html = renderDataPage(
      data({
        dimensions: {
          referrers: {
            snapshots: ['2026-09-01'],
            latest: [
              {
                dimension: '<script>alert(1)</script>',
                title: '"><img src=x onerror=alert(2)>',
                count: 1,
                uniques: 1,
              },
            ],
            trajectories: [],
          },
          paths: { snapshots: [], latest: [], trajectories: [] },
        },
      } as Partial<DashboardData>),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('links relatively when no site URL is configured', () => {
    const html = renderDataPage(data());
    expect(html).toContain('href="../data.json"');
    expect(html).not.toContain('https://thezwiss.github.io');
  });

  it('links absolutely when a site URL is configured, tolerating a trailing slash', () => {
    const html = renderDataPage(data(), { siteUrl: 'https://example.com/repo/' });
    expect(html).toContain('https://example.com/repo/insights/data.json');
    expect(html).not.toContain('repo//insights');
  });

  it('emits a parseable schema.org Dataset naming the JSON distribution', () => {
    const html = renderDataPage(data(), { siteUrl: 'https://example.com/repo' });
    const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    expect(block).not.toBeNull();
    const parsed = JSON.parse((block?.[1] ?? '').replace(/\\u003c/g, '<')) as {
      '@type': string;
      distribution: Array<{ contentUrl: string; encodingFormat: string }>;
    };
    expect(parsed['@type']).toBe('Dataset');
    expect(parsed.distribution[0]?.encodingFormat).toBe('application/json');
    expect(parsed.distribution[0]?.contentUrl).toBe('https://example.com/repo/insights/data.json');
  });

  it('states the resolution it is actually showing when the bundle was downsampled', () => {
    expect(renderDataPage(data({ downsampled: true }))).toContain('weekly buckets');
    expect(renderDataPage(data())).toContain('daily');
  });

  it('says so plainly rather than printing an empty table for a series with no rows', () => {
    expect(renderDataPage(data())).toContain('No rows recorded yet.');
  });

  // The tables are public from the first ping, whatever the charts do: the
  // chart threshold exists so a handful of instances are not drawn as a
  // trend, not to keep the figures private.
  it('publishes the telemetry tables, qualified as opt-in and as a lower bound', () => {
    const html = renderDataPage(withTelemetry());

    expect(html).toContain('Usage pings');
    expect(html).toContain('opt-in');
    expect(html).toContain('lower bound');
    expect(html).toContain('two significant digits');
    const section = html.slice(html.indexOf('<h2>Usage pings</h2>'));
    expect(section).toContain('instances reporting today');
    expect(section).toContain('registered users');
    expect(section).toContain('2026-09-05');
    expect(section).toContain('230');
    expect(section).toContain('1.1.2');
    expect(section).toContain('DE');
    expect(section).toContain('desktop');
    // A measured zero of federating instances, never rendered as a gap.
    expect(section.slice(0, section.indexOf('</table>'))).not.toContain('not measured');
  });

  it('does not claim the seven-day basis for the columns that do not have one', () => {
    const html = renderDataPage(withTelemetry());
    // The prose is wrapped in the source, so compare it with breaks flattened.
    const flat = html.replace(/\s+/g, ' ');

    // The snapshot rule governs most of the row, but three columns sit outside
    // it: `instances_1d` and `users_active1d` are restricted to the date
    // itself, and `instances_30d` reaches back thirty days. A blanket claim
    // would have the page describe three of its own columns wrongly.
    expect(flat).toContain('reported that day rather than over the week');
    expect(flat).toContain('<em>instances reporting today</em>');
    expect(flat).toContain('<em>active today</em>');
    expect(flat).toContain('<em>within 30 days</em>');
    // Tied to the headers the table actually renders, so renaming a column
    // cannot leave the prose naming a column that no longer exists.
    expect(flat).toContain('<th class="n">instances reporting today</th>');
    expect(flat).toContain('<th class="n">active today</th>');
    expect(flat).toContain('<th class="n">within 30 days</th>');
  });

  it('renders a measured zero in a telemetry ranking as 0', () => {
    const withZero = withTelemetry();
    withZero.telemetry.clients.latest = [
      { dimension: 'mobile', title: '', count: 0, uniques: 0 },
    ];

    const html = renderDataPage(withZero);
    // Scoped to the one table under test. Page-wide the assertions would be
    // meaningless: another series carries a real `0` cell, and a null
    // elsewhere on the page prints "not measured" whatever this table does.
    const clients = html.slice(html.indexOf('<h3>Client kinds</h3>'));
    const end = clients.indexOf('</table>');
    // No closing tag means the helper rendered its empty state instead of the
    // table under test. Fail on that, rather than let `slice(0, -1)` quietly
    // trim one character and leave the assertions running against the page.
    expect(end).toBeGreaterThan(-1);
    const rows = clients.slice(0, end);

    expect(rows).toContain('<tr><td>mobile</td><td class="n">0</td></tr>');
    expect(rows).not.toContain('not measured');
  });

  it('escapes a dimension value in a telemetry ranking', () => {
    const withMarkup = withTelemetry();
    withMarkup.telemetry.versions.latest = [
      { dimension: '<script>x</script>', title: '', count: 3, uniques: 3 },
    ];

    const html = renderDataPage(withMarkup);

    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>x</script>');
  });

  it('omits the telemetry section entirely when no instance has reported', () => {
    const html = renderDataPage(data());

    expect(html).not.toContain('Usage pings');
    expect(html).not.toContain('instances reporting today');
  });
});
