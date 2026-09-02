import { describe, it, expect } from 'vitest';
import { renderSitemap, siteEntries } from './sitemap.ts';

describe('renderSitemap', () => {
  it('emits a well-formed urlset with absolute locs', () => {
    const xml = renderSitemap('https://example.com/backspace', siteEntries('2026-09-02'));
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
    expect(xml).toContain('<loc>https://example.com/backspace/</loc>');
    expect(xml).toContain('<loc>https://example.com/backspace/insights/</loc>');
    expect(xml).toContain('<loc>https://example.com/backspace/insights/data/</loc>');
    expect(xml.trim().endsWith('</urlset>')).toBe(true);
  });

  it('does not double the slash when the site URL already ends in one', () => {
    const xml = renderSitemap('https://example.com/backspace/', siteEntries(null));
    expect(xml).not.toContain('//insights');
    expect(xml).toContain('<loc>https://example.com/backspace/insights/</loc>');
  });

  it('dates the two generated pages and leaves the landing page undated', () => {
    const xml = renderSitemap('https://e.test', siteEntries('2026-09-02'));
    expect(xml.match(/<lastmod>2026-09-02<\/lastmod>/g)).toHaveLength(2);
  });

  // An invented lastmod tells a crawler a page is unchanged when nothing here
  // knows whether it is.
  it('omits lastmod entirely when the archive has no date', () => {
    expect(renderSitemap('https://e.test', siteEntries(null))).not.toContain('<lastmod>');
  });

  it('escapes XML metacharacters in a site URL', () => {
    const xml = renderSitemap('https://e.test/a&b', siteEntries(null));
    expect(xml).toContain('https://e.test/a&amp;b/');
    expect(xml).not.toMatch(/<loc>[^<]*&(?!amp;|lt;|gt;|quot;|apos;)/);
  });
});
