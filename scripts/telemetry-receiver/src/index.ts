import type { Env } from './env';
import { parsePing, normaliseCountry, MAX_BODY_BYTES } from './validate';
import { upsertPing, exportRange, deleteOlderThan } from './store';
import { ROOT_PAGE } from './page';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Largest inclusive export range, in days. The collector asks for 30 at a time. */
const MAX_EXPORT_DAYS = 31;

/** How long a row lives. Section 7 of the spec. */
const RETENTION_DAYS = 90;

const MS_PER_DAY = 86_400_000;

/** The UTC calendar day an instant falls on. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. `NaN` if either is unparseable. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);
}

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
}

/**
 * Compares the presented bearer token with the configured one in constant time.
 *
 * Both sides are hashed first so the comparison always runs over 32 bytes: a
 * token of the wrong length would otherwise fail `timingSafeEqual` on the
 * length alone, and the failure would be measurably faster than a token of the
 * right length with wrong bytes. An unset `EXPORT_TOKEN` rejects everything,
 * so a Worker deployed before the secret is set exports nothing rather than
 * accepting the empty string.
 */
async function bearerMatches(header: string | null, expected: string | undefined): Promise<boolean> {
  if (header === null || !header.startsWith('Bearer ') || !expected) return false;
  const [presented, configured] = await Promise.all([sha256(header.slice(7)), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(presented, configured);
}

async function handlePing(request: Request, env: Env): Promise<Response> {
  // Retired: the instances read 410 as "stop asking" and switch telemetry off.
  if (env.RETIRED === '1') return new Response(null, { status: 410 });

  if (env.RATE_LIMITER) {
    // The source address is read here and nowhere else: it is the limiter key,
    // it is never stored and never leaves this function.
    const key = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const { success } = await env.RATE_LIMITER.limit({ key });
    if (!success) return new Response(null, { status: 429 });
  }

  // The body is read in full and measured afterwards, so a lying or absent
  // Content-Length changes nothing. This is the cheap check, over UTF-16 code
  // units, and it never over-rejects: a string of N code units encodes to at
  // least N bytes. `parsePing` then measures the encoded bytes, and that is
  // the check that decides.
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return new Response(null, { status: 400 });

  const receivedAt = new Date().toISOString();
  const result = parsePing(text, receivedAt.slice(0, 10));
  if (!result.ok) return new Response(null, { status: 400 });

  await upsertPing(env.DB, {
    ...result.ping,
    receivedAt,
    country: normaliseCountry(request.cf?.country),
  });
  return new Response(null, { status: 204 });
}

async function handleExport(request: Request, env: Env): Promise<Response> {
  if (!(await bearerMatches(request.headers.get('authorization'), env.EXPORT_TOKEN))) {
    return new Response(null, { status: 401 });
  }
  const url = new URL(request.url);
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to)) return new Response(null, { status: 400 });
  const span = daysBetween(from, to);
  if (!Number.isFinite(span) || span < 0 || span >= MAX_EXPORT_DAYS) return new Response(null, { status: 400 });

  const rows = await exportRange(env.DB, from, to);
  // NDJSON: one row per line, a trailing newline only when there is a line to
  // end. An empty range answers with an empty body, which the collector reads
  // as a day nobody reported on.
  const body = rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === 'POST' && pathname === '/v1/ping') return handlePing(request, env);
    if (request.method === 'GET' && pathname === '/v1/export') return handleExport(request, env);
    if (request.method === 'GET' && pathname === '/') {
      // The page loads nothing and submits nothing, so the policy says so:
      // inline styles are all it needs. This is the same posture the app
      // serves under, see docs/systems/web-security.md.
      return new Response(ROOT_PAGE, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=300',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
        },
      });
    }
    return new Response(null, { status: 404 });
  },

  /**
   * Daily retention pass. The cutoff is derived from the trigger's own time
   * rather than `Date.now()`, so a run that the platform queued and started
   * late deletes exactly the days it was scheduled to delete.
   */
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await deleteOlderThan(env.DB, utcDay(controller.scheduledTime - RETENTION_DAYS * MS_PER_DAY));
  },
} satisfies ExportedHandler<Env>;
