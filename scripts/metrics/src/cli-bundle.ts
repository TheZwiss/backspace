import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createStore } from './store.ts';
import {
  buildDashboardData,
  serialiseWithinBudget,
  budgetWarning,
  BUNDLE_BUDGET_BYTES,
} from './bundle.ts';
import { requiredEnv, deriveRunTimestamps, describeFailure } from './cli-support.ts';
import { renderDataPage } from './datapage.ts';
import { buildSummary, renderSummaryHtml, renderDatasetJsonLd, replaceRegion } from './summary.ts';
import { renderSitemap, siteEntries } from './sitemap.ts';

/**
 * Entrypoint invoked by `.github/workflows/deploy-pages.yml` as
 * `node scripts/metrics/src/cli-bundle.ts`, once per Pages deploy. It reads
 * the archive checked out from the `metrics-data` branch and writes the
 * single `data.json` the static dashboard fetches.
 *
 * Two environment variables, both required:
 * - `METRICS_DATA_DIR` — the archive root, the same variable `cli-collect.ts`
 *   and `cli-backfill.ts` read, so all three entrypoints name the checkout
 *   once and identically.
 * - `METRICS_OUTPUT_PATH` — where to write the bundle, `site/insights/data.json`
 * - `METRICS_SITE_URL` — optional. The deployed site's base URL, used to emit
 *   absolute links and `Dataset` metadata on the static data page. Omitted, the
 *   page still renders and links relatively; a fork that has not set it gets a
 *   correct page rather than one pointing at somebody else's domain.
 *   in the deploy workflow. Parameterised rather than hardcoded so a
 *   maintainer can generate a bundle anywhere for inspection without
 *   dirtying the site tree, and so this file has no opinion about the site's
 *   layout.
 *
 * This file joins `cli-collect.ts`, `cli-backfill.ts` and
 * `cli-record-failure.ts` as the only files in this package that read
 * `process.env` or the system clock — `buildDashboardData` takes
 * `generated_at` as a parameter and `serialiseWithinBudget` takes none at
 * all, which is what keeps the whole bundling path unit-testable against a
 * temp directory and a fixed timestamp.
 *
 * **A missing archive directory is the empty case, not a failure.**
 * `deploy-pages.yml` runs on every `site/**` push whether or not the
 * `metrics-data` branch exists, so this entrypoint must still write a valid
 * `data.json` and exit 0 when the checkout never happened. That behaviour is
 * structural rather than a `try`/`catch` here: `store.read` collapses
 * `ENOENT` — and only `ENOENT` — to `null`, so every series reads as absent
 * and `buildDashboardData` returns `empty: true`, which is precisely the
 * state the page's empty message is written for. Because the collapse is
 * scoped to `ENOENT`, an archive that exists but cannot be read (`EACCES`),
 * a data dir that is really a file (`ENOTDIR`), and a corrupt CSV still fail
 * loudly and exit non-zero — a blank dashboard published over data that
 * exists is indistinguishable, on the page, from a repo with no traffic.
 */
async function main(): Promise<void> {
  const dataDir = requiredEnv(process.env, 'METRICS_DATA_DIR');
  const outputPath = requiredEnv(process.env, 'METRICS_OUTPUT_PATH');

  // The clock is read here and nowhere below it. `generated_at` is the one
  // field of the bundle that cannot come from the archive, and stamping it
  // at this boundary is what lets every test of the reader pin a fixed
  // timestamp and compare bytes.
  const { now } = deriveRunTimestamps(new Date());

  const data = buildDashboardData(createStore(dataDir), now);
  const result = serialiseWithinBudget(data);

  const full = path.resolve(outputPath);
  try {
    mkdirSync(path.dirname(full), { recursive: true });
    // A plain write, not the store's temp-file-and-rename dance. This is a
    // build artifact in a throwaway CI workspace, not the archive: a run
    // that dies mid-write never reaches the upload step, so a torn file is
    // never published, and there is no previous good version here to
    // protect.
    writeFileSync(full, result.json, 'utf8');
  } catch (cause) {
    // Wrapped for the same reason `store.ts` wraps: a bare EACCES or ENOSPC
    // from node:fs does not say which file this job failed to write.
    throw new Error(`cli-bundle: failed to write "${full}"`, { cause });
  }

  console.log(
    data.empty
      ? `archive ${dataDir}: no rows — wrote the empty bundle, the page renders its empty state`
      : `archive ${dataDir}: since ${data.collection_started ?? 'unknown'} — ` +
        `${data.series.views.dates.length} days of views, ${data.releases.length} releases`,
  );
  console.log(
    `wrote ${full}: ${result.bytes} bytes of the ${BUNDLE_BUDGET_BYTES}-byte budget ` +
      `(downsampled: ${result.downsampled ? 'yes, weekly buckets' : 'no, daily'})`,
  );

  // The static, no-JavaScript rendering of the same bundle, written beside it
  // as `<bundle dir>/data/index.html` so it serves at `…/insights/data/`.
  //
  // Derived from the bundle's own path rather than configured separately, on
  // purpose: the two files are one artifact in two encodings, and a second
  // path variable is a second thing that can be pointed somewhere else, at
  // which point the page and the JSON it claims to mirror can disagree about
  // where each of them lives.
  //
  // It exists because the dashboard draws every value client-side: a text-only
  // crawler, or a reader with JavaScript off, otherwise sees the methodology
  // and not one measured number. `serialiseWithinBudget` may have downsampled
  // `data` to weekly buckets, and this renders whatever it was handed, so the
  // page always states the resolution it is actually showing.
  const pagePath = path.join(path.dirname(full), 'data', 'index.html');
  const html = renderDataPage(data, { siteUrl: process.env['METRICS_SITE_URL'] });
  try {
    mkdirSync(path.dirname(pagePath), { recursive: true });
    writeFileSync(pagePath, html, 'utf8');
  } catch (cause) {
    throw new Error(`cli-bundle: failed to write "${pagePath}"`, { cause });
  }
  console.log(`wrote ${pagePath}: ${Buffer.byteLength(html, 'utf8')} bytes of static tables`);

  // The charted page's own static content: the headline measurements, and a
  // `Dataset` block carrying real values and the archive's coverage.
  //
  // This exists because `/insights/` is the URL that gets shared, and every
  // figure on it is drawn client-side — so its served HTML states the method
  // and not one number. The static data page beside it solves that for a
  // reader who follows the link; a fetcher that reads the shared URL and
  // stops never does. Both regions are written from `data`, the same bundle
  // the charts read, so the static text cannot disagree with the charts.
  //
  // `replaceRegion` throws when a marker is missing rather than leaving the
  // page untouched: the committed fallback says "not built by the pipeline",
  // and publishing that silently would look exactly like a successful deploy.
  const indexPath = path.join(path.dirname(full), 'index.html');
  const siteUrl = process.env['METRICS_SITE_URL'];
  let page: string;
  try {
    page = readFileSync(indexPath, 'utf8');
  } catch (cause) {
    throw new Error(`cli-bundle: failed to read "${indexPath}"`, { cause });
  }
  const facts = buildSummary(data);
  page = replaceRegion(page, 'SUMMARY', renderSummaryHtml(facts));
  // The JSON-LD names absolute URLs, so it is regenerated only when this
  // deployment knows its own address. Left alone, the committed block stands:
  // correct for this site, and not something a fork republishes under its own
  // domain while pointing at ours.
  if (siteUrl !== undefined && siteUrl !== '') {
    page = replaceRegion(page, 'JSONLD', renderDatasetJsonLd(facts, siteUrl));
  }
  try {
    writeFileSync(indexPath, page, 'utf8');
  } catch (cause) {
    throw new Error(`cli-bundle: failed to write "${indexPath}"`, { cause });
  }
  console.log(
    `wrote ${indexPath}: static figures` +
      (siteUrl === undefined || siteUrl === '' ? ' (JSON-LD left as committed: no METRICS_SITE_URL)' : ' and Dataset metadata'),
  );

  // The sitemap, at the site root two levels up from the bundle. Skipped
  // without a site URL for the same reason the JSON-LD is: every entry in it
  // is an absolute URL, and a sitemap is a claim about which domain owns
  // these pages.
  if (siteUrl !== undefined && siteUrl !== '') {
    const sitemapPath = path.join(path.dirname(path.dirname(full)), 'sitemap.xml');
    const xml = renderSitemap(siteUrl, siteEntries(facts.to));
    try {
      writeFileSync(sitemapPath, xml, 'utf8');
    } catch (cause) {
      throw new Error(`cli-bundle: failed to write "${sitemapPath}"`, { cause });
    }
    console.log(`wrote ${sitemapPath}: ${siteEntries(facts.to).length} urls`);
  }

  // Last line of the run, on stderr, so it is the thing a maintainer sees at
  // the bottom of a green deploy log rather than something buried above the
  // summary. stderr rather than stdout because this is diagnostic output
  // about a build that still succeeded: it must not be mistaken for, or
  // parsed alongside, the two result lines above. The build deliberately
  // still passes — the point of warning early is to leave years of room to
  // decide, and failing here would turn a heads-up into the very cliff it
  // exists to prevent.
  const warning = budgetWarning(result);
  if (warning !== null) console.error(warning);
}

// `main().catch(...)` with `process.exitCode = 1` rather than a bare
// top-level `await` or a forced `process.exit(1)`: see `cli-collect.ts` for
// the full rationale. Nothing in this entrypoint is actually asynchronous —
// as is also true of `cli-record-failure.ts` — but the form is kept
// identical across all four so the failure path is one pattern to verify,
// not four.
//
// Exiting non-zero here fails the Pages deploy, which is correct for every
// failure this can hit: a corrupt archive or a bundle still over budget
// after downsampling both mean the site would otherwise publish something
// wrong. The one case that must NOT reach here is a missing archive
// directory, which is handled as the empty case above.
main().catch((error: unknown) => {
  console.error(describeFailure(error));
  process.exitCode = 1;
});
