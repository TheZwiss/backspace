/**
 * The sitemap for the published site.
 *
 * Written at deploy time rather than committed, because two of the three
 * pages change whenever the collector runs and a `lastmod` that lies is worse
 * than no `lastmod` at all: a crawler that has been told a page is unchanged
 * has been given a reason not to come back.
 *
 * This exists because nothing else announces these pages. `robots.txt` has to
 * live at the domain root — `thezwiss.github.io/robots.txt`, a different
 * repository from this one — so a sitemap served from this project's own path
 * is the only discovery signal this repository can publish for itself. It is
 * still worth publishing without the robots.txt reference: a sitemap at a
 * known URL can be submitted to a search console directly.
 */

export interface SitemapEntry {
  /** Path relative to the site root, e.g. `insights/`. Empty string is the root. */
  path: string;
  /** `YYYY-MM-DD`, omitted when nothing dates the page. */
  lastmod?: string;
  changefreq: string;
  priority: string;
}

/**
 * Escapes the five characters XML reserves. The URLs here are built from a
 * configured site URL and fixed paths rather than from archive data, so this
 * is defence against a malformed configuration rather than against content —
 * but an unescaped `&` in a site URL produces a sitemap no crawler will
 * parse, and it would fail silently at the consumer rather than here.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function renderSitemap(siteUrl: string, entries: readonly SitemapEntry[]): string {
  const base = siteUrl.replace(/\/+$/, '');
  const urls = entries.map((entry) => {
    const loc = escapeXml(entry.path === '' ? `${base}/` : `${base}/${entry.path}`);
    const lastmod = entry.lastmod === undefined ? '' : `\n    <lastmod>${escapeXml(entry.lastmod)}</lastmod>`;
    return (
      '  <url>\n' +
      `    <loc>${loc}</loc>${lastmod}\n` +
      `    <changefreq>${escapeXml(entry.changefreq)}</changefreq>\n` +
      `    <priority>${escapeXml(entry.priority)}</priority>\n` +
      '  </url>'
    );
  });
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.join('\n') +
    '\n</urlset>\n'
  );
}

/**
 * The three published pages.
 *
 * `lastmod` on the two data pages is the date the archive was last collected,
 * not the date this ran: they are rebuilt on every deploy, but their CONTENT
 * only changes when a collection adds a row, and `lastmod` describes content.
 * The landing page carries none — nothing in this pipeline knows when it last
 * changed, and inventing a date for it would be the same lie in miniature.
 */
export function siteEntries(archiveDate: string | null): SitemapEntry[] {
  const dated = archiveDate === null ? {} : { lastmod: archiveDate };
  return [
    { path: '', changefreq: 'weekly', priority: '1.0' },
    { path: 'insights/', ...dated, changefreq: 'daily', priority: '0.8' },
    { path: 'insights/data/', ...dated, changefreq: 'daily', priority: '0.7' },
  ];
}
