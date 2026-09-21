import type { Env } from './env';

/**
 * Placeholder Worker so that wrangler and the vitest pool have a `main` to
 * load. It answers 404 to everything; the ping route, the feed route and the
 * scheduled job replace it in Task 8b of the space directory plan.
 */
export default {
  async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
