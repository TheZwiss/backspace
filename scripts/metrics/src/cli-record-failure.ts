import { createStore } from './store.ts';
import {
  requiredEnv,
  deriveRunTimestamps,
  recordFailure,
  formatRecordFailureSummary,
  describeFailure,
} from './cli-support.ts';

/**
 * Entrypoint invoked by `.github/workflows/metrics.yml`'s "Record failure"
 * step, `if: failure()` — i.e. only on the path where something upstream in
 * the job already failed (a required GitHub API fetch, or the data
 * commit/push). It records that failure into `meta.json` so a stalled
 * collector is visible on the data branch itself, not only in the Actions
 * tab.
 *
 * `collect()` (via `cli-collect.ts`) remains the only writer of `meta.json`
 * on the success path — it already writes a complete, correct `meta.json`
 * as the last step of its own atomic write phase, so there is nothing left
 * for this entrypoint to do when the run actually succeeded, which is
 * exactly why the workflow step invoking this file is `if: failure()` and
 * not `if: always()`. See docs/systems/metrics.md §3.3.
 *
 * Reading `process.env` and the system clock is confined to this package's
 * `cli-*.ts` entrypoints — every other module takes both as injected
 * values, which is what makes the rest of the package testable without
 * touching the network, the filesystem, or real time. Unlike the
 * entrypoints that fetch, this one makes no GitHub API call at all, so it
 * needs no `METRICS_TOKEN` and never touches `assertHeaderSafeToken` —
 * there is no token here to be unsafe.
 */
async function main(): Promise<void> {
  const dataDir = requiredEnv(process.env, 'METRICS_DATA_DIR');
  // The reason this run failed, e.g. `run failed: failure`. Read from the
  // environment rather than interpolated into the workflow's `run:` string:
  // `job.status` is not a secret, but it is still attacker/environment-
  // influenced text by the time it reaches a shell, and this package's
  // standing convention (see `cli-collect.ts`/`cli-backfill.ts`) is that
  // every value crossing from the workflow into this process's control flow
  // does so via `env:`, never via `${{ }}` spliced into `run:`.
  const reason = requiredEnv(process.env, 'METRICS_RUN_OUTCOME');

  const store = createStore(dataDir);
  const { now } = deriveRunTimestamps(new Date());

  const meta = recordFailure(store, now, reason);

  console.log(formatRecordFailureSummary(meta));
}

// `main().catch(...)` rather than a bare top-level `await main()`: see
// `cli-collect.ts` for the full rationale (flush-safe `process.exitCode`
// over a forced `process.exit`, a token-free error message this package
// controls). One subtlety specific to this entrypoint: it runs BECAUSE the
// job already failed, so a non-zero exit here means recording the failure
// itself failed (e.g. a corrupt `meta.json`, or a filesystem error), not
// that the underlying run failed — that fact is already known and is the
// very reason this script was invoked.
main().catch((error: unknown) => {
  console.error(describeFailure(error));
  process.exitCode = 1;
});
