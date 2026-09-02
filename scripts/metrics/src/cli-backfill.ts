import { createClient } from './github.ts';
import { createStore } from './store.ts';
import { backfill } from './backfill.ts';
import {
  requiredEnv,
  assertHeaderSafeToken,
  formatBackfillSummary,
  describeFailure,
} from './cli-support.ts';

/**
 * Entrypoint invoked by `.github/workflows/backfill.yml` as
 * `node scripts/metrics/src/cli-backfill.ts`, a one-shot (or safely
 * re-runnable) job that seeds history `backfill.ts` can reconstruct from
 * GitHub's permanent per-item timestamps.
 *
 * Reading `process.env` and the system clock is confined to this package's
 * `cli-*.ts` entrypoints, and this one exercises only the first half of
 * that licence: `backfill` needs no clock input at all (every date it
 * writes comes from a GitHub timestamp, never "today"), which is why,
 * alone among the entrypoints, this file never calls `new Date()`.
 */
async function main(): Promise<void> {
  const token = requiredEnv(process.env, 'METRICS_TOKEN');
  assertHeaderSafeToken(token);
  const slug = requiredEnv(process.env, 'GITHUB_REPOSITORY');
  const dataDir = requiredEnv(process.env, 'METRICS_DATA_DIR');

  const result = await backfill({
    client: createClient(token),
    store: createStore(dataDir),
    slug,
  });

  console.log(formatBackfillSummary(result));
}

// See `cli-collect.ts` for why this is `main().catch(...)` with
// `process.exitCode = 1` rather than a bare top-level `await` or a forced
// `process.exit(1)`.
main().catch((error: unknown) => {
  console.error(describeFailure(error));
  process.exitCode = 1;
});
