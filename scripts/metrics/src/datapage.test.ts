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
    ...overrides,
  };
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
});
