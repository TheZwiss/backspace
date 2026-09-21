import type { D1Migration } from '@cloudflare/vitest-pool-workers';

export interface Env {
  DB: D1Database;
  /**
   * The per-address limiter miniflare builds from `wrangler.toml`, so it is
   * live in the tests too. Absent in `wrangler dev` without the binding; the
   * handlers skip limiting then.
   */
  RATE_LIMITER?: RateLimit;
  /** "1" retires the service: every ping answers 410. */
  RETIRED?: string;
  /** Injected by vitest.config.ts only. */
  TEST_MIGRATIONS?: D1Migration[];
  /**
   * The hub's own hostname, so a ping cannot make the hub fetch itself. Unset
   * in tests and in `wrangler dev`; the ping handler then takes the host of the
   * request it is answering.
   */
  HUB_HOST?: string;
}

type HubEnv = Env;

declare global {
  /**
   * `@cloudflare/workers-types` v5 types the runtime `env` as `Cloudflare.Env`
   * and expects each project to merge its own bindings into that interface.
   * The test helpers in `cloudflare:test` read the same type, so this one
   * declaration covers the Worker and the tests.
   */
  namespace Cloudflare {
    interface Env extends HubEnv {}
  }
}
