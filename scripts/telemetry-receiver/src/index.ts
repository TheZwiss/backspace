import type { Env } from './env';

/**
 * Worker entry point named by `main` in `wrangler.toml`. Every path answers
 * 404 until the ping, export and index routes are wired up here.
 */
export default {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
