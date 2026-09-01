import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createStore } from './store.ts';
import { buildDashboardData, serialiseWithinBudget, BUNDLE_BUDGET_BYTES } from './bundle.ts';
import { requiredEnv, deriveRunTimestamps, describeFailure } from './cli-support.ts';

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
