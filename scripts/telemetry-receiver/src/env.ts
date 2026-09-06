import type { D1Migration } from '@cloudflare/vitest-pool-workers';

export interface Env {
  DB: D1Database;
  /** Absent in tests and in `wrangler dev` without the binding; the handler skips limiting then. */
  RATE_LIMITER?: RateLimit;
  EXPORT_TOKEN: string;
  /** "1" retires the service: every ping answers 410. */
  RETIRED?: string;
  /** Injected by vitest.config.ts only. */
  TEST_MIGRATIONS?: D1Migration[];
}

type ReceiverEnv = Env;

declare global {
  /**
   * `@cloudflare/workers-types` v5 types the runtime `env` as `Cloudflare.Env`
   * and expects each project to merge its own bindings into that interface.
   * The test helpers in `cloudflare:test` read the same type, so this one
   * declaration covers the Worker and the tests.
   */
  namespace Cloudflare {
    interface Env extends ReceiverEnv {}
  }
}
