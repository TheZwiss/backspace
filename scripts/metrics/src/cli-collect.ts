import { createClient } from './github.ts';
import { createStore } from './store.ts';
import { collect } from './collect.ts';
import {
  requiredEnv,
  assertHeaderSafeToken,
  deriveRunTimestamps,
  formatCollectSummary,
  describeFailure,
} from './cli-support.ts';

/**
 * Entrypoint invoked by `.github/workflows/metrics.yml` as
 * `node scripts/metrics/src/cli-collect.ts`, once per scheduled run.
 *
 * This file, `cli-backfill.ts`, and `cli-record-failure.ts` are
 * deliberately the only three files in this package that read `process.env`
 * or the system clock — every other module takes those as injected values
 * (see `CollectOptions` in `collect.ts`), which is what makes the rest of
 * the package testable without touching the network, the filesystem, or
 * real time.
 */
async function main(): Promise<void> {
  const token = requiredEnv(process.env, 'METRICS_TOKEN');
  assertHeaderSafeToken(token);
  const slug = requiredEnv(process.env, 'GITHUB_REPOSITORY');
  const dataDir = requiredEnv(process.env, 'METRICS_DATA_DIR');

  const { now, today } = deriveRunTimestamps(new Date());

  const result = await collect({
    client: createClient(token),
    store: createStore(dataDir),
    slug,
    today,
    now,
  });

  for (const line of formatCollectSummary(result)) {
    console.log(line);
  }
}

// `main().catch(...)` rather than a bare top-level `await main()`: this is a
// scheduled workflow with no one watching it interactively, so a failure
// must exit non-zero and say why, in one deliberate place, rather than rely
// on Node's default unhandled-rejection handler (which does also exit
// non-zero on this Node version, but dumps its own generic framing rather
// than a message this package controls and can guarantee is token-free).
// `process.exitCode = 1` — not `process.exit(1)` — so the `console.error`
// write above is allowed to actually flush before the process exits; a
// forced immediate exit can truncate output piped into a CI log collector.
main().catch((error: unknown) => {
  console.error(describeFailure(error));
  process.exitCode = 1;
});
