import { escapeHtml, jsonLd } from './datapage.ts';
import type { DashboardData } from './bundle.ts';

/**
 * Static, pre-rendered facts injected into `site/insights/index.html` at
 * deploy time.
 *
 * The charted dashboard draws every figure in the browser from `data.json`,
 * which means the URL people actually share carries prose and no numbers in
 * its own text layer. `/insights/data/` exists for readers that want the raw
 * tables, but a fetcher that reads the charted page and stops never follows
 * the link — and that is the common case for a crawler or an assistant asked
 * to "look at this page". This module puts the headline measurements into the
 * served HTML so the shared URL answers on its own.
 *
 * It is deliberately NOT a second implementation of the at-a-glance cards.
 * Those cards are range-dependent and carry 30-day deltas with their own
 * reasons for declining to state one; duplicating that logic in a second
 * language would create two sets of rules that drift apart, and the drift
 * would be invisible until the two disagreed in public. What is generated
 * here is a summary built from rules simple enough to be obviously correct:
 * the latest measured value of each counter with the date it was measured,
 * the peak day of each traffic series, and the leading referrer and path.
 *
 * The absent-versus-zero rule governs here as everywhere else. A figure with
 * no measurement behind it is OMITTED FROM THE SENTENCE rather than printed
 * as zero or as a dash, because this text is read by machines that will quote
 * whatever number they find next to a label.
 */

/** One headline figure: a measured value and the date it was measured on. */
export interface DatedValue {
  value: number;
  date: string;
}

/** A traffic series' busiest measured day. */
export interface PeakDay {
  value: number;
  uniques: number | null;
  date: string;
}

export interface SummaryFacts {
  /** Earliest and latest date any series covers, or null for an empty archive. */
  from: string | null;
  to: string | null;
  /** `daily` unless the bundle was downsampled to fit its size budget. */
  resolution: string;
  stars: DatedValue | null;
  forks: DatedValue | null;
  watchers: DatedValue | null;
  contributors: DatedValue | null;
  viewsPeak: PeakDay | null;
  clonesPeak: PeakDay | null;
  viewsDays: number;
  clonesDays: number;
  /**
   * The heaviest day of this repository's own CI, which is what the clone
   * caveat points at. Stated so a reader that quotes the clone peak has the
   * number that explains it in the same paragraph rather than in a chart.
   */
  workflowsPeak: PeakDay | null;
  topReferrer: { label: string; detail: string | null; count: number; uniques: number } | null;
  topPath: { label: string; detail: string | null; count: number; uniques: number } | null;
  latestRelease: { tag: string; date: string } | null;
}

/**
 * The last index of `values` holding a measurement, paired with its date.
 *
 * Walks backwards rather than filtering, because these arrays are aligned
 * with `dates` by index and the pairing is the whole point: a value reported
 * without the date it was measured on is exactly the kind of figure this
 * project exists not to publish.
 */
function newestMeasured(
  dates: readonly string[],
  values: ReadonlyArray<number | null>,
): DatedValue | null {
  for (let i = Math.min(dates.length, values.length) - 1; i >= 0; i--) {
    const value = values[i];
    const date = dates[i];
    if (value === null || value === undefined || date === undefined) continue;
    return { value, date };
  }
  return null;
}

/** The measured day with the highest count. Ties keep the earliest day. */
/**
 * `uniques` is optional: a workflow run has no unique-visitor reading, and
 * passing an empty array rather than making the parameter nullable keeps the
 * one code path — `uniques[i] ?? null` already yields null for a short array.
 */
function peakDay(
  dates: readonly string[],
  counts: ReadonlyArray<number | null>,
  uniques: ReadonlyArray<number | null> = [],
): PeakDay | null {
  let best: PeakDay | null = null;
  for (let i = 0; i < Math.min(dates.length, counts.length); i++) {
    const value = counts[i];
    const date = dates[i];
    if (value === null || value === undefined || date === undefined) continue;
    if (best !== null && value <= best.value) continue;
    best = { value, uniques: uniques[i] ?? null, date };
  }
  return best;
}

function countMeasured(values: ReadonlyArray<number | null>): number {
  let n = 0;
  for (const value of values) if (value !== null) n++;
  return n;
}

/** The latest date across every dated series, or null when nothing is dated. */
function latestDate(data: DashboardData): string | null {
  const candidates: string[] = [];
  for (const series of Object.values(data.series)) {
    const last = series.dates[series.dates.length - 1];
    if (last !== undefined) candidates.push(last);
  }
  for (const dimension of Object.values(data.dimensions)) {
    const last = dimension.snapshots[dimension.snapshots.length - 1];
    if (last !== undefined) candidates.push(last);
  }
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (a > b ? a : b));
}

/**
 * The name to show for a referrer or a path.
 *
 * Mirrors `displayLabel` in the dashboard exactly — trimmed `title` when it
 * has one, `dimension` otherwise — because the two must never disagree about
 * what a row is called. GitHub fills `title` for paths (a path's page title,
 * e.g. "Overview") and leaves it EMPTY for referrers, where the host in
 * `dimension` is the name; reading `title` alone prints nothing at all for
 * every referrer, which is how this was found.
 *
 * `detail` is the raw `dimension` when it differs from the label, so a path
 * called "Overview" is still identifiable as `/TheZwiss/backspace`.
 */
function labelled(entry: {
  dimension: string;
  title: string;
  count: number;
  uniques: number;
}): { label: string; detail: string | null; count: number; uniques: number } {
  const title = entry.title.trim();
  const label = title !== '' ? title : entry.dimension;
  return {
    label,
    detail: label === entry.dimension ? null : entry.dimension,
    count: entry.count,
    uniques: entry.uniques,
  };
}

export function buildSummary(data: DashboardData): SummaryFacts {
  const { views, clones, stars, forks, contributors, repo, workflows } = data.series;
  const referrer = data.dimensions.referrers.latest[0];
  const path = data.dimensions.paths.latest[0];
  // `releases` is sorted (date asc, tag asc) by the archive's own comparator,
  // so the newest is the last element rather than a re-sort here.
  const release = data.releases[data.releases.length - 1];

  return {
    from: data.collection_started,
    to: latestDate(data),
    resolution: data.downsampled ? 'weekly' : 'daily',
    stars: newestMeasured(stars.dates, stars.total),
    forks: newestMeasured(forks.dates, forks.total),
    watchers: newestMeasured(repo.dates, repo.subscribers),
    contributors: newestMeasured(contributors.dates, contributors.total),
    viewsPeak: peakDay(views.dates, views.count, views.uniques),
    clonesPeak: peakDay(clones.dates, clones.count, clones.uniques),
    viewsDays: countMeasured(views.count),
    clonesDays: countMeasured(clones.count),
    workflowsPeak: peakDay(workflows.dates, workflows.runs),
    topReferrer: referrer === undefined ? null : labelled(referrer),
    topPath: path === undefined ? null : labelled(path),
    latestRelease: release === undefined ? null : { tag: release.tag, date: release.date },
  };
}

/** `1234` -> `1,234`. Grouped so a long figure stays readable in prose. */
function num(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * `1 watcher`, `7 watchers`. Every noun this renders is regular, so the rule
 * is the rule; it exists because "1 watchers" in a sentence a model is going
 * to quote reads as carelessness about the numbers themselves.
 */
function count(value: number, singular: string): string {
  return `${num(value)} ${singular}${value === 1 ? '' : 's'}`;
}

/**
 * The visible summary paragraph.
 *
 * Every clause is skipped rather than filled with a placeholder when its
 * measurement is missing, so an archive that has only just started produces a
 * shorter sentence instead of a sentence full of dashes. An archive with
 * nothing in it produces no figures at all, and the caller gets a paragraph
 * that says so plainly.
 */
export function renderSummaryHtml(facts: SummaryFacts): string {
  const counters: string[] = [];
  if (facts.stars !== null) counters.push(count(facts.stars.value, 'star'));
  if (facts.forks !== null) counters.push(count(facts.forks.value, 'fork'));
  if (facts.watchers !== null) counters.push(count(facts.watchers.value, 'watcher'));
  if (facts.contributors !== null) {
    counters.push(count(facts.contributors.value, 'contributor'));
  }

  const sentences: string[] = [];

  // The date every counter is "as of" is taken from the stars row rather than
  // from the clock: it is the date those values were actually measured on,
  // and the counters are collected in one pass so they share it.
  const asOf = facts.stars?.date ?? facts.forks?.date ?? facts.watchers?.date ?? null;
  if (counters.length > 0) {
    const list =
      counters.length === 1
        ? counters[0]
        : `${counters.slice(0, -1).join(', ')} and ${counters[counters.length - 1]}`;
    sentences.push(asOf === null ? `${list}.` : `${list}, measured ${escapeHtml(asOf)}.`);
  }

  if (facts.viewsPeak !== null) {
    const uniques =
      facts.viewsPeak.uniques === null
        ? ''
        : ` from ${count(facts.viewsPeak.uniques, 'unique visitor')}`;
    sentences.push(
      `Busiest day for page views: ${count(facts.viewsPeak.value, 'view')}${uniques} on ` +
        `${escapeHtml(facts.viewsPeak.date)}, across ${count(facts.viewsDays, 'measured day')}.`,
    );
  }
  if (facts.clonesPeak !== null) {
    sentences.push(
      `Busiest day for clones: ${count(facts.clonesPeak.value, 'clone')} on ` +
        `${escapeHtml(facts.clonesPeak.date)}, across ${count(facts.clonesDays, 'measured day')}. ` +
        'Clone counts include this repository\u2019s own CI checkouts, which on a heavy build ' +
        'day outnumber human clones.',
    );
  }
  if (facts.workflowsPeak !== null) {
    sentences.push(
      'Busiest day for this repository\u2019s own CI: ' +
        `${count(facts.workflowsPeak.value, 'workflow run')} on ` +
        `${escapeHtml(facts.workflowsPeak.date)}.`,
    );
  }
  const named = (d: { label: string; detail: string | null }): string =>
    d.detail === null
      ? escapeHtml(d.label)
      : `${escapeHtml(d.label)} (${escapeHtml(d.detail)})`;

  if (facts.topReferrer !== null) {
    sentences.push(
      `Leading referrer over the trailing 14 days: ${named(facts.topReferrer)}, ` +
        `${count(facts.topReferrer.count, 'view')} from ` +
        `${count(facts.topReferrer.uniques, 'unique visitor')}.`,
    );
  }
  if (facts.topPath !== null) {
    sentences.push(
      `Most-visited path over the same window: ${named(facts.topPath)}, ` +
        `${count(facts.topPath.count, 'view')}.`,
    );
  }
  if (facts.latestRelease !== null) {
    sentences.push(
      `Latest release: ${escapeHtml(facts.latestRelease.tag)}, published ` +
        `${escapeHtml(facts.latestRelease.date)}.`,
    );
  }

  const coverage =
    facts.from === null || facts.to === null
      ? 'The archive holds no measurements yet.'
      : `The archive covers ${escapeHtml(facts.from)} to ${escapeHtml(facts.to)} at ` +
        `${escapeHtml(facts.resolution)} resolution.`;

  // The closing clause says "above", so it is only true when something was
  // stated above it. An archive with nothing in it gets the shorter form.
  const body =
    sentences.length === 0
      ? `${coverage} The series will appear in the ` +
        '<a href="data/">plain tables</a> and in <a href="data.json"><code>data.json</code></a> ' +
        'as soon as there is anything to record.'
      // No link out of this clause: the paragraph directly above it already
      // carries both, and repeating them four lines later reads as a page
      // that has lost track of what it has said.
      : `<strong>Latest measurements.</strong> ${sentences.join(' ')} ${coverage} ` +
        'Every figure above is a recorded measurement, not an estimate.';

  return `<p class="sec-copy static-figures">${body}</p>`;
}

/**
 * The `Dataset` block, regenerated so it carries the archive's real coverage
 * and its current values rather than only the names of the things measured.
 *
 * `variableMeasured` becomes `PropertyValue` entries with a `value` where one
 * has been measured, which is the form consumers read a figure out of. A
 * variable with no measurement behind it keeps its name and drops the value,
 * for the same reason the prose omits it.
 */
export function buildDatasetJsonLd(
  facts: SummaryFacts,
  siteUrl: string,
): Record<string, unknown> {
  const base = siteUrl.replace(/\/+$/, '');
  const variables: Array<Record<string, unknown>> = [];
  const add = (name: string, unit: string, dated: DatedValue | null): void => {
    const entry: Record<string, unknown> = { '@type': 'PropertyValue', name, unitText: unit };
    if (dated !== null) {
      entry['value'] = dated.value;
      entry['measurementTechnique'] = `Measured ${dated.date}`;
    }
    variables.push(entry);
  };
  add('stars', 'stars', facts.stars);
  add('forks', 'forks', facts.forks);
  add('watchers', 'watchers', facts.watchers);
  add('contributors', 'contributors', facts.contributors);
  for (const name of [
    'page views',
    'unique visitors',
    'repository clones',
    'unique cloners',
    'open issues',
    'release asset downloads',
    'referring sites',
    'popular paths',
  ]) {
    variables.push({ '@type': 'PropertyValue', name });
  }

  const dataset: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: 'Backspace repository traffic and growth archive',
    description:
      "Daily archive of the Backspace repository's GitHub traffic, stars, forks, contributors " +
      'and releases. GitHub discards repository traffic data after 14 days; this archive records ' +
      'it once per day and retains it indefinitely. Every figure is measured, never estimated; a ' +
      'value that was not measured is recorded as absent rather than as zero.',
    url: `${base}/insights/`,
    license: 'https://www.gnu.org/licenses/agpl-3.0.html',
    isAccessibleForFree: true,
    creator: { '@type': 'Organization', name: 'Backspace' },
    measurementTechnique:
      'GitHub REST API, collected once daily by a scheduled job and committed to a public git branch',
    variableMeasured: variables,
    distribution: [
      {
        '@type': 'DataDownload',
        encodingFormat: 'application/json',
        contentUrl: `${base}/insights/data.json`,
        name: 'Complete archive bundle (JSON)',
      },
      {
        '@type': 'DataDownload',
        encodingFormat: 'text/html',
        contentUrl: `${base}/insights/data/`,
        name: 'The same archive as static HTML tables',
      },
    ],
  };
  if (facts.from !== null && facts.to !== null) {
    dataset['temporalCoverage'] = `${facts.from}/${facts.to}`;
  }

  return dataset;
}

/**
 * The same object, wrapped in its `<script>` tag.
 *
 * Split from `buildDatasetJsonLd` so callers that want to inspect the
 * structured data — the tests, above all — read the object instead of
 * pulling it back out of a string. A test that regex-strips a `<script>`
 * wrapper to reach its payload is parsing HTML with a regex, which is both
 * fragile and, correctly, something the security scanner objects to.
 */
export function renderDatasetJsonLd(facts: SummaryFacts, siteUrl: string): string {
  return `<script type="application/ld+json">\n${jsonLd(buildDatasetJsonLd(facts, siteUrl))}\n</script>`;
}

/**
 * Replaces the content between `<!-- BUILD:NAME -->` and `<!-- /BUILD:NAME -->`.
 *
 * Throws when a region is missing rather than returning the document
 * unchanged. A silent no-op here publishes the committed fallback — a page
 * with no figures in it — and it would look exactly like a successful deploy,
 * which is the failure mode this whole subsystem is built to avoid.
 */
export function replaceRegion(html: string, name: string, replacement: string): string {
  const open = `<!-- BUILD:${name} -->`;
  const close = `<!-- /BUILD:${name} -->`;
  const start = html.indexOf(open);
  const end = html.indexOf(close);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `summary: no ${open} ... ${close} region in the page; refusing to publish it unchanged`,
    );
  }
  return html.slice(0, start + open.length) + '\n' + replacement + '\n' + html.slice(end);
}
