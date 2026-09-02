/**
 * Renders the archive as a single static HTML page with no JavaScript.
 *
 * The dashboard draws its charts client-side from `data.json`, which means a
 * text-only crawler — and any reader without JavaScript — sees headings and
 * methodology but not one measured value. This page exists so the numbers
 * themselves are in the HTML: real `<table>` rows, plus a schema.org
 * `Dataset` block naming `data.json` as a machine-readable distribution.
 *
 * It is generated from the same `DashboardData` the charts are built from, so
 * the two can never disagree about a figure. It states what it does not know:
 * a `null` reads as "not measured", never as a zero, matching the rule the
 * rest of this package is built on.
 */
import type { DashboardData, DimensionEntry, ReleaseEntry } from './bundle.ts';

/**
 * Escapes text for HTML element and attribute content.
 *
 * Load-bearing, not decorative: referrer hostnames and popular paths are
 * strings GitHub reports from real traffic, so they are outside this repo's
 * control and reach this page verbatim. Interpolating them raw would let a
 * crafted path close a tag. Ampersand is replaced first so the replacement
 * escapes of the later rules are not themselves re-escaped.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Serialises a value for a `<script type="application/ld+json">` block.
 *
 * `JSON.stringify` alone is not safe inside a script element: a `</script>`
 * sequence anywhere in the data would terminate the block early and spill the
 * rest of the JSON into the document as markup. Escaping the `<` of every
 * tag-open prevents that while leaving the JSON semantically identical.
 */
export function jsonLd(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/</g, '\\u003c');
}

/** A measured number, or an explicit statement that nothing was measured. */
function cell(value: number | null): string {
  return value === null
    ? '<td class="na" title="No value was recorded for this date">not measured</td>'
    : `<td class="n">${value.toLocaleString('en-US')}</td>`;
}

/**
 * `numeric` right-aligns a column's header to sit over its right-aligned
 * figures. Carried per column rather than inferred from position, because the
 * dimension tables lead with two text columns and the series tables with one.
 */
interface Column {
  label: string;
  numeric: boolean;
}

function table(head: readonly Column[], body: readonly string[]): string {
  if (body.length === 0) return '<p class="empty">No rows recorded yet.</p>';
  return (
    '<div class="scroll"><table>\n<thead><tr>' +
    head
      .map((h) => `<th${h.numeric ? ' class="n"' : ''}>${escapeHtml(h.label)}</th>`)
      .join('') +
    '</tr></thead>\n<tbody>\n' +
    body.join('\n') +
    '\n</tbody>\n</table></div>'
  );
}

/** Rows of a dated series, newest first so the current figures are read first. */
function seriesTable(
  dates: readonly string[],
  columns: ReadonlyArray<{ label: string; values: ReadonlyArray<number | null> }>,
): string {
  const rows: string[] = [];
  for (let i = dates.length - 1; i >= 0; i--) {
    rows.push(
      `<tr><td class="d">${escapeHtml(dates[i] ?? '')}</td>` +
        columns.map((c) => cell(c.values[i] ?? null)).join('') +
        '</tr>',
    );
  }
  return table(
    [{ label: 'date', numeric: false }, ...columns.map((c) => ({ label: c.label, numeric: true }))],
    rows,
  );
}

function dimensionTable(rows: readonly DimensionEntry[], first: string): string {
  return table(
    [
      { label: first, numeric: false },
      { label: 'title', numeric: false },
      { label: 'views', numeric: true },
      { label: 'unique visitors', numeric: true },
    ],
    rows.map(
      (r) =>
        `<tr><td>${escapeHtml(r.dimension)}</td><td>${escapeHtml(r.title)}</td>` +
        `<td class="n">${r.count.toLocaleString('en-US')}</td>` +
        `<td class="n">${r.uniques.toLocaleString('en-US')}</td></tr>`,
    ),
  );
}

function releaseTable(rows: readonly ReleaseEntry[]): string {
  return table(
    [
      { label: 'date', numeric: false },
      { label: 'tag', numeric: false },
      { label: 'name', numeric: false },
    ],
    rows.map(
      (r) =>
        `<tr><td class="d">${escapeHtml(r.date)}</td><td>${escapeHtml(r.tag)}</td>` +
        `<td>${escapeHtml(r.name)}</td></tr>`,
    ),
  );
}

const STYLE = `
:root { color-scheme: dark; --bg:#0b0b10; --panel:#13131a; --line:rgba(255,255,255,.09);
        --txt:#efefef; --txt2:#a0a0aa; --txt3:#6d6d7c; --accent:#7c6cf6;
        --mono: ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace; }
* { box-sizing:border-box; }
body { margin:0; padding:40px 24px 72px; background:var(--bg); color:var(--txt);
       font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width:1080px; margin:0 auto; }
h1 { font-size:30px; letter-spacing:-.02em; margin:0 0 12px; }
h2 { font-size:20px; letter-spacing:-.01em; margin:44px 0 6px; }
p { color:var(--txt2); max-width:70ch; }
a { color:var(--accent); }
code, .d, .n, .na { font-family:var(--mono); font-size:13px; }
.lede { font-size:17px; }
.scroll { overflow-x:auto; border:1px solid var(--line); border-radius:12px; background:var(--panel); }
table { border-collapse:collapse; width:100%; font-size:14px; }
th, td { padding:8px 14px; text-align:left; border-bottom:1px solid var(--line); white-space:nowrap; }
th { color:var(--txt3); font-weight:600; font-size:12px; text-transform:uppercase;
     letter-spacing:.04em; position:sticky; top:0; background:var(--panel); }
tr:last-child td { border-bottom:0; }
.n { text-align:right; font-variant-numeric:tabular-nums; }
.na { color:var(--txt3); font-style:italic; }
.empty { color:var(--txt3); }
.meta { font-family:var(--mono); font-size:12.5px; color:var(--txt3); }
.note { border-left:2px solid var(--accent); padding:2px 0 2px 14px; margin:22px 0; }
footer { margin-top:56px; padding-top:20px; border-top:1px solid var(--line); color:var(--txt3); font-size:13.5px; }
`;

export interface DataPageOptions {
  /** Absolute site base with no trailing slash, e.g. `https://example.com/repo`. Omitted for relative links. */
  siteUrl?: string | undefined;
}

export function renderDataPage(data: DashboardData, options: DataPageOptions = {}): string {
  const base = options.siteUrl === undefined ? '' : options.siteUrl.replace(/\/+$/, '');
  const insights = base === '' ? '../' : `${base}/insights/`;
  const jsonUrl = base === '' ? '../data.json' : `${base}/insights/data.json`;

  const s = data.series;
  const covered =
    data.collection_started === null
      ? 'nothing recorded yet'
      : `${data.collection_started} to ${data.generated_at.slice(0, 10)}`;

  // schema.org Dataset. This is what makes the archive discoverable as data
  // rather than as prose: it names the machine-readable distribution
  // explicitly, so a crawler does not have to guess that data.json exists.
  const dataset = {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: 'Backspace repository traffic and growth archive',
    description:
      'Daily archive of the Backspace repository’s GitHub traffic, stars, forks, ' +
      'contributors and releases. GitHub discards repository traffic data after 14 days; ' +
      'this archive records it once per day and retains it indefinitely. Every figure is ' +
      'measured, never estimated; a value that was not measured is recorded as absent ' +
      'rather than as zero.',
    url: `${insights}data/`,
    license: 'https://www.gnu.org/licenses/agpl-3.0.html',
    isAccessibleForFree: true,
    creator: { '@type': 'Organization', name: 'Backspace' },
    temporalCoverage: data.collection_started === null ? undefined : `${data.collection_started}/..`,
    dateModified: data.generated_at,
    measurementTechnique:
      'GitHub REST API, collected once daily by a scheduled job and committed to a public git branch',
    variableMeasured: [
      'page views',
      'unique visitors',
      'repository clones',
      'unique cloners',
      'workflow runs',
      'stars',
      'forks',
      'contributors',
      'watchers',
      'open issues',
      'release asset downloads',
      'referring sites',
      'popular paths',
    ],
    distribution: [
      {
        '@type': 'DataDownload',
        encodingFormat: 'application/json',
        contentUrl: jsonUrl,
        name: 'Complete archive bundle (JSON)',
      },
    ],
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Backspace repository data: every recorded figure</title>
<meta name="description" content="The complete Backspace repository traffic and growth archive as plain tables: daily page views, clones, stars, forks, contributors, referrers and paths. Measured daily, never estimated, retained past GitHub's 14-day window." />
<link rel="canonical" href="${escapeHtml(`${insights}data/`)}" />
<style>${STYLE}</style>
<script type="application/ld+json">
${jsonLd(dataset)}
</script>
</head>
<body>
<main>
<h1>Backspace repository data</h1>
<p class="lede">Every figure the archive holds, as plain tables. This is the same data the
<a href="${escapeHtml(insights)}">charted dashboard</a> is drawn from, rendered without JavaScript so it can be
read, cited and crawled directly.</p>

<p class="meta">coverage ${escapeHtml(covered)} &middot; generated ${escapeHtml(data.generated_at)} &middot;
resolution ${escapeHtml(data.downsampled ? 'weekly buckets' : 'daily')}</p>

<div class="note">
<p><strong>How to read this.</strong> GitHub deletes repository traffic data after 14 days. A scheduled job
records it once a day into a public git branch, and this page is built from that branch at deploy time.
Nothing here is estimated or modelled. Where a value was never measured the cell reads
<em>not measured</em> rather than <code>0</code>, because a zero would claim a measurement that was never taken.</p>
<p>Machine-readable form: <a href="${escapeHtml(jsonUrl)}"><code>data.json</code></a>, the complete archive in one file.</p>
</div>

<h2>Page views</h2>
<p>Daily views of the repository on GitHub, with the number of distinct visitors.</p>
${seriesTable(s.views.dates, [
  { label: 'views', values: s.views.count },
  { label: 'unique visitors', values: s.views.uniques },
])}

<h2>Clones</h2>
<p>Daily <code>git clone</code> operations, with the number of distinct cloners. GitHub counts this repository&rsquo;s own <code>actions/checkout</code> steps here too, so a day of heavy continuous integration inflates the figure well above human traffic; clones far above one per unique cloner is the signature.</p>
${seriesTable(s.clones.dates, [
  { label: 'clones', values: s.clones.count },
  { label: 'unique cloners', values: s.clones.uniques },
])}

<h2>CI activity</h2>
<p>Workflow runs this repository started each day, published beside the clone table above because they are the reason it moves. A <code>0</code> here is a measured zero, not a gap: the Actions API is asked for a date range and answers it completely, where the traffic endpoints omit a day they recorded nothing for. History before daily collection began is reconstructed only as far back as GitHub still retains runs, because a day whose runs have been deleted cannot be told apart from a day that had none.</p>
${seriesTable(s.workflows.dates, [{ label: 'workflow runs', values: s.workflows.runs }])}

<h2>Stars</h2>
<p>Cumulative star count, one row per day. A day on which nobody starred carries the previous day's total, because that total is known rather than missing. History before daily collection began is reconstructed from each star's permanent timestamp, which counts only stars that still exist, so those early totals are a lower bound on what the counter read at the time.</p>
${seriesTable(s.stars.dates, [{ label: 'stars', values: s.stars.total }])}

<h2>Forks</h2>
<p>Cumulative fork count, one row per day, on the same basis as stars above: quiet days carry the previous total, and pre-collection history is reconstructed from forks that still exist.</p>
${seriesTable(s.forks.dates, [{ label: 'forks', values: s.forks.total }])}

<h2>Contributors</h2>
<p>Cumulative count of people with at least one commit, dated by each contributor's first commit week.</p>
${seriesTable(s.contributors.dates, [{ label: 'contributors', values: s.contributors.total }])}

<h2>Repository counters</h2>
<p>Watchers, open issues, and release asset downloads. Downloads are split because GitHub counts an
updater feed file the same as an installer: <em>app</em> is installers and archives, <em>update checks</em>
is the metadata every installed client fetches when it checks for a new version.</p>
${seriesTable(s.repo.dates, [
  { label: 'watchers', values: s.repo.subscribers },
  { label: 'open issues', values: s.repo.open_issues },
  { label: 'downloads, all assets', values: s.repo.downloads_total },
  { label: 'downloads, app', values: s.repo.downloads_app },
  { label: 'downloads, update checks', values: s.repo.downloads_updates },
])}

<h2>Referring sites</h2>
<p>Where visitors arrived from. GitHub reports this only as a trailing 14-day total per snapshot and
lists at most 10 rows, so these are fortnight aggregates rather than daily figures.</p>
${dimensionTable(data.dimensions.referrers.latest, 'referring site')}

<h2>Popular paths</h2>
<p>The most-visited paths in the repository, on the same trailing 14-day basis.</p>
${dimensionTable(data.dimensions.paths.latest, 'path')}

<h2>Releases</h2>
${releaseTable(data.releases)}

<footer>
<p>Part of <a href="${escapeHtml(base === '' ? '../../' : `${base}/`)}">Backspace</a>, a self-hosted,
open-source Discord alternative. Source and archive:
<a href="https://github.com/TheZwiss/backspace">github.com/TheZwiss/backspace</a>.
Data licensed under <a href="https://www.gnu.org/licenses/agpl-3.0.html">AGPL-3.0</a> with the project.</p>
</footer>
</main>
</body>
</html>
`;
}
