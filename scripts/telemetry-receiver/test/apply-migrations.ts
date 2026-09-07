import { applyD1Migrations, env } from 'cloudflare:test';

// `env` is typed by the `Cloudflare.Env` declaration in `src/env.ts`.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);
